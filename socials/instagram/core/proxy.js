"use strict";

/**
 * Optional rotating proxy support.
 *
 * Nothing changes when no proxy is configured: requests go out directly,
 * exactly as before. When configured, each outgoing request picks an entry
 * from the pool (round-robin or random) and failed/429 entries are cooled
 * down before the request is retried through another one.
 *
 * Never log credentials: use redact() on anything derived from a proxy URL.
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

const VALID_MODES = ["round-robin", "random"];
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_COOLDOWN_MS = 60_000;

function read(source, key, fallback = null) {
  const value = source[key];
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return String(value).trim();
}

function intOr(source, key, fallback, min, max) {
  const n = Number(read(source, key, String(fallback)));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

/** Replace "user:pass@" with a placeholder so nothing leaks into logs/errors. */
function redact(text) {
  return String(text)
    // URL form: http://user:pass@host:port
    .replace(/\/\/([^/@\s]+)@/g, "//***:***@")
    // Bare form: user:pass@host:port (no scheme), followed by a hostname
    .replace(
      /(^|[\s'"=,])([A-Za-z0-9_.%~+-]+):([A-Za-z0-9_.%~+/-]+)@(?=[A-Za-z0-9.-]+)/g,
      "$1***:***@"
    );
}

/**
 * Accept both full URLs and the bare "user:pass@host:port" form copied
 * straight out of a provider dashboard. A bare value is treated as HTTP,
 * which is what port 80 / residential dashboards use.
 */
function normalizeProxyUrl(raw) {
  const value = String(raw).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `http://${value}`;
}

/**
 * Convert "http://user:pass@host:port" (or its bare form) into axios' proxy
 * config. The {session} placeholder is substituted for providers exposing
 * sticky residential sessions (e.g. user-session-{session}:pass@host:port).
 */
function parseProxyUrl(raw, session) {
  const resolved = normalizeProxyUrl(raw).replace(/\{session\}/g, session);
  let url;
  try {
    url = new URL(resolved);
  } catch {
    throw new Error(
      `Invalid proxy URL: ${redact(resolved)}. Use http://user:pass@host:port or user:pass@host:port.`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported proxy protocol "${url.protocol}"; use http:// or https://.`);
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid proxy host or port: ${redact(resolved)}`);
  }

  const config = { protocol: url.protocol.slice(0, -1), host: url.hostname, port };
  if (url.username) {
    config.auth = {
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  }
  return config;
}

class ProxyPool {
  constructor(source = process.env) {
    this.rotation = read(source, "IG_PROXY_ROTATION", "round-robin");
    if (!VALID_MODES.includes(this.rotation)) {
      throw new Error(`IG_PROXY_ROTATION must be one of: ${VALID_MODES.join(", ")}`);
    }

    this.maxRetries = intOr(source, "IG_PROXY_MAX_RETRIES", DEFAULT_MAX_RETRIES, 0, 10);
    this.cooldownMs = intOr(source, "IG_PROXY_COOLDOWN_MS", DEFAULT_COOLDOWN_MS, 0, 86_400_000);
    this.sessionTtlMs = intOr(source, "IG_PROXY_SESSION_TTL_MS", 0, 0, 86_400_000);

    // A stable id keeps the exit IP sticky for the lifetime of the process,
    // which avoids triggering an Instagram checkpoint on a logged-in session.
    this.session = read(source, "IG_PROXY_SESSION", null) ?? crypto.randomBytes(6).toString("hex");
    this.sessionExpiresAt = this.sessionTtlMs ? Date.now() + this.sessionTtlMs : null;

    const lines = [];
    const single = read(source, "IG_PROXY_URL", null);
    if (single) lines.push(single);
    const list = read(source, "IG_PROXIES", null);
    if (list) lines.push(...list.split(/[\s,]+/).filter(Boolean));
    const file = read(source, "IG_PROXIES_FILE", null);
    if (file) {
      if (!fs.existsSync(file)) throw new Error(`IG_PROXIES_FILE not found: ${file}`);
      lines.push(
        ...fs.readFileSync(file, "utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"))
      );
    }

    this.rawList = [...new Set(lines)];
    // A "rotating" generator emits N identical lines: the rotation happens
    // server-side. Collapsing them is correct, but reporting it avoids the
    // "I configured 10 proxies, why does it say 1?" confusion.
    this.duplicatesCollapsed = lines.length - this.rawList.length;
    this.entries = this.rawList.map((raw, id) => ({
      id,
      raw,
      config: parseProxyUrl(raw, this.session),
      cooldownUntil: 0,
    }));
    this.cursor = -1;
  }

  get enabled() {
    return this.entries.length > 0;
  }

  /** Total attempts: retries only make sense when a pool exists. */
  get attempts() {
    return this.enabled ? this.maxRetries + 1 : 1;
  }

  _refreshSession() {
    if (!this.sessionTtlMs || Date.now() < this.sessionExpiresAt) return;
    this.session = crypto.randomBytes(6).toString("hex");
    this.sessionExpiresAt = Date.now() + this.sessionTtlMs;
    this.entries = this.rawList.map((raw, id) => ({
      id,
      raw,
      config: parseProxyUrl(raw, this.session),
      cooldownUntil: 0,
    }));
  }

  /** Pick the next proxy, skipping entries still in cooldown. */
  select() {
    if (!this.enabled) return null;
    this._refreshSession();

    const now = Date.now();
    let available = this.entries.filter((entry) => entry.cooldownUntil <= now);
    if (!available.length) {
      // Avoid a deadlock when every entry is cooling down.
      for (const entry of this.entries) entry.cooldownUntil = 0;
      available = this.entries;
    }

    let entry;
    if (this.rotation === "random") {
      entry = available[Math.floor(Math.random() * available.length)];
    } else {
      this.cursor = (this.cursor + 1) % available.length;
      entry = available[this.cursor];
    }
    return { entry, config: entry.config };
  }

  markFailed(entry) {
    if (entry) entry.cooldownUntil = Date.now() + this.cooldownMs;
  }

  isRetryable(err) {
    return [
      "IG_RATE_LIMITED",
      "IG_NETWORK_ERROR",
      "IG_HTTP_ERROR",
      "IG_UPSTREAM_ERROR",
      "IG_BLOCKED",
    ].includes(err?.code);
  }

  /** Safe to expose over /health: never contains credentials. */
  describe() {
    return {
      enabled: this.enabled,
      count: this.entries.length,
      duplicatesCollapsed: this.duplicatesCollapsed,
      rotation: this.rotation,
      maxRetries: this.maxRetries,
      cooldownMs: this.cooldownMs,
      stickySession: this.rawList.some((raw) => raw.includes("{session}")),
      sessionExpiresAt: this.sessionExpiresAt
        ? new Date(this.sessionExpiresAt).toISOString()
        : null,
    };
  }
}

let cached = null;

/** Lazily built so a bad config fails at startup with a readable message. */
function getPool() {
  if (!cached) cached = new ProxyPool(process.env);
  return cached;
}

/**
 * Rebuild the pool from the current process.env (used on Ctrl+R).
 * The new pool is only installed if it is valid, so a bad edit in .env keeps
 * the previous working pool instead of breaking the running server.
 */
function reloadPool() {
  const next = new ProxyPool(process.env);
  cached = next;
  return next;
}

module.exports = {
  ProxyPool,
  getPool,
  reloadPool,
  parseProxyUrl,
  normalizeProxyUrl,
  redact,
};
