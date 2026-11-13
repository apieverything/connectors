"use strict";

/** Optional rotating proxy pool, identical contract to the other connectors. */
const fs = require("node:fs");
const crypto = require("node:crypto");
const VALID_MODES = ["round-robin", "random"];

function read(source, key, fallback = null) {
  const value = source[key];
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return String(value).trim();
}
function intOr(source, key, fallback, min, max) {
  const n = Number(read(source, key, String(fallback)));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}
function redact(text) {
  return String(text)
    .replace(/\/\/([^/@\s]+)@/g, "//***:***@")
    .replace(/(^|[\s'"=,])([A-Za-z0-9_.%~+-]+):([A-Za-z0-9_.%~+/-]+)@(?=[A-Za-z0-9.-]+)/g, "$1***:***@");
}
function normalizeProxyUrl(raw) {
  const value = String(raw).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `http://${value}`;
}
function parseProxyUrl(raw, session) {
  const resolved = normalizeProxyUrl(raw).replace(/\{session\}/g, session);
  let url;
  try { url = new URL(resolved); } catch {
    throw new Error(`Invalid proxy URL: ${redact(resolved)}. Use user:pass@host:port.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported proxy protocol "${url.protocol}".`);
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid proxy host or port: ${redact(resolved)}`);
  }
  const config = { protocol: url.protocol.slice(0, -1), host: url.hostname, port };
  if (url.username) {
    config.auth = { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  }
  return config;
}

class ProxyPool {
  constructor(source = process.env) {
    this.rotation = read(source, "LI_PROXY_ROTATION", "round-robin");
    if (!VALID_MODES.includes(this.rotation)) throw new Error(`LI_PROXY_ROTATION must be one of: ${VALID_MODES.join(", ")}`);
    this.maxRetries = intOr(source, "LI_PROXY_MAX_RETRIES", 2, 0, 10);
    this.cooldownMs = intOr(source, "LI_PROXY_COOLDOWN_MS", 60000, 0, 86400000);
    this.session = read(source, "LI_PROXY_SESSION", null) ?? crypto.randomBytes(6).toString("hex");
    const lines = [];
    const single = read(source, "LI_PROXY_URL", null);
    if (single) lines.push(single);
    const list = read(source, "LI_PROXIES", null);
    if (list) lines.push(...list.split(/[\s,]+/).filter(Boolean));
    const file = read(source, "LI_PROXIES_FILE", null);
    if (file) {
      if (!fs.existsSync(file)) throw new Error(`LI_PROXIES_FILE not found: ${file}`);
      lines.push(...fs.readFileSync(file, "utf8").split(/\r?\n/)
        .map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
    }
    this.rawList = [...new Set(lines)];
    this.duplicatesCollapsed = lines.length - this.rawList.length;
    this.entries = this.rawList.map((raw, id) => ({ id, raw, config: parseProxyUrl(raw, this.session), cooldownUntil: 0 }));
    this.cursor = -1;
  }
  get enabled() { return this.entries.length > 0; }
  get attempts() { return this.enabled ? this.maxRetries + 1 : 1; }
  select() {
    if (!this.enabled) return null;
    const now = Date.now();
    let available = this.entries.filter((e) => e.cooldownUntil <= now);
    if (!available.length) {
      for (const e of this.entries) e.cooldownUntil = 0;
      available = this.entries;
    }
    let entry;
    if (this.rotation === "random") entry = available[Math.floor(Math.random() * available.length)];
    else { this.cursor = (this.cursor + 1) % available.length; entry = available[this.cursor]; }
    return { entry, config: entry.config };
  }
  markFailed(entry) { if (entry) entry.cooldownUntil = Date.now() + this.cooldownMs; }
  isRetryable(err) {
    return ["LI_RATE_LIMITED", "LI_NETWORK_ERROR", "LI_HTTP_ERROR", "LI_UPSTREAM_ERROR"].includes(err?.code);
  }
  describe() {
    return {
      enabled: this.enabled, count: this.entries.length,
      duplicatesCollapsed: this.duplicatesCollapsed,
      rotation: this.rotation, maxRetries: this.maxRetries,
      cooldownMs: this.cooldownMs,
      stickySession: this.rawList.some((r) => r.includes("{session}")),
    };
  }
}

let cached = null;
function getPool() { if (!cached) cached = new ProxyPool(process.env); return cached; }
function reloadPool() { const next = new ProxyPool(process.env); cached = next; return next; }
module.exports = { ProxyPool, getPool, reloadPool, parseProxyUrl, normalizeProxyUrl, redact };
