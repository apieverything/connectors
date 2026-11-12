"use strict";

/** Startup proxy probe: liveness, country, latency and TikTok reachability. */
const axios = require("axios");
const { redact } = require("./proxy");
const { log } = require("./logger");

const PROBES = ["https://ipwho.is/", "https://www.cloudflare.com/cdn-cgi/trace", "https://ipinfo.io/json"];
const TT_PROBE = "https://www.tiktok.com/@tiktok";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function normalizeCountry(value) {
  if (typeof value !== "string") return null;
  return /^[A-Za-z]{2}$/.test(value.trim()) ? value.trim().toUpperCase() : null;
}

function extractCountry(json, text) {
  for (const c of [json?.country_code, json?.countryCode, json?.country, json?.location?.country_code]) {
    const code = normalizeCountry(c);
    if (code) return code;
  }
  const trace = /^loc=([A-Za-z]{2})\s*$/m.exec(String(text ?? ""));
  return trace ? trace[1].toUpperCase() : null;
}

function checkOptions() {
  return {
    timeout: Math.max(1000, Number(process.env.TT_PROXY_CHECK_TIMEOUT_MS ?? 8000)),
    concurrency: Math.max(1, Number(process.env.TT_PROXY_CHECK_CONCURRENCY ?? 5)),
    urls: process.env.TT_PROXY_CHECK_URL?.trim()
      ? [process.env.TT_PROXY_CHECK_URL.trim()]
      : PROBES,
    ttUrl: process.env.TT_PROXY_CHECK_TT_URL?.trim() || TT_PROBE,
    compareDirect: process.env.TT_PROXY_CHECK_COMPARE !== "0",
    ua: process.env.TT_PROXY_CHECK_UA?.trim() || "api-everything/tiktok-proxy-check/1.0",
    ttUa: process.env.TT_USER_AGENT?.trim() || BROWSER_UA,
  };
}

async function probe(entry, url, options, signal, isTikTok) {
  const res = await axios.get(url, {
    proxy: entry ? entry.config : false,
    timeout: options.timeout,
    signal,
    validateStatus: () => true,
    responseType: "text",
    transformResponse: [(d) => d],
    headers: {
      "User-Agent": isTikTok ? options.ttUa : options.ua,
      Accept: isTikTok ? "text/html,application/xhtml+xml" : "*/*",
      ...(isTikTok ? { "Accept-Language": "en-US,en;q=0.9" } : {}),
    },
  });
  const text = String(res.data ?? "");
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return {
    status: res.status,
    country: extractCountry(json, text),
    snippet: redact(text.replace(/\s+/g, " ").slice(0, 160)),
  };
}

async function checkOne(entry, index, options, signal) {
  const started = Date.now();
  let alive = false;
  let country = null;
  let lastError = null;

  for (const url of options.urls) {
    if (signal?.aborted) break;
    try {
      const result = await probe(entry, url, options, signal, false);
      if (result.status < 500 && result.status !== 407) {
        alive = true;
        if (result.country) { country = result.country; break; }
      }
    } catch (err) {
      if (signal?.aborted) break;
      lastError = err;
    }
  }

  let tiktokStatus = null;
  try {
    const result = await probe(entry, options.ttUrl, options, signal, true);
    tiktokStatus = result.status;
  } catch (err) {
    lastError = err;
  }

  return {
    index,
    label: redact(entry.raw),
    alive,
    country,
    ms: Date.now() - started,
    tiktokStatus,
    error: alive ? null : redact(lastError?.message ?? "unreachable"),
  };
}

function summarize(results, direct = null) {
  const alive = results.filter((r) => r.alive);
  const latencies = alive.map((r) => r.ms);
  const countries = {};
  const tiktokStatuses = {};
  let ttAlive = 0;
  for (const r of results) {
    if (r.country) countries[r.country] = (countries[r.country] ?? 0) + 1;
    if (r.tiktokStatus === null) continue;
    tiktokStatuses[r.tiktokStatus] = (tiktokStatuses[r.tiktokStatus] ?? 0) + 1;
    if (r.tiktokStatus >= 200 && r.tiktokStatus < 300) ttAlive += 1;
  }
  return {
    checkedAt: new Date().toISOString(),
    total: results.length,
    alive: alive.length,
    dead: results.length - alive.length,
    ttAlive,
    tiktokStatuses,
    direct,
    avgMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    minMs: latencies.length ? Math.min(...latencies) : null,
    maxMs: latencies.length ? Math.max(...latencies) : null,
    countries,
    results,
  };
}

async function checkProxies(pool, { signal } = {}) {
  const options = checkOptions();
  if (!pool.enabled) return summarize([]);
  const results = new Array(pool.entries.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < pool.entries.length && !signal?.aborted) {
      const index = cursor++;
      results[index] = await checkOne(pool.entries[index], index, options, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, pool.entries.length) }, worker));

  let direct = null;
  if (options.compareDirect && !signal?.aborted) {
    const started = Date.now();
    try {
      const result = await probe(null, options.ttUrl, options, signal, true);
      direct = { tiktokStatus: result.status, snippet: result.snippet, ms: Date.now() - started };
    } catch (err) {
      direct = { tiktokStatus: null, snippet: redact(err.message), ms: Date.now() - started };
    }
  }
  return summarize(results.filter(Boolean), direct);
}

function applyResults(pool, summary) {
  for (const result of summary.results) {
    if (!result.alive) pool.markFailed(pool.entries[result.index]);
  }
}

function compact(summary) {
  if (!summary) return null;
  return {
    checkedAt: summary.checkedAt,
    total: summary.total,
    alive: summary.alive,
    dead: summary.dead,
    ttAlive: summary.ttAlive,
    tiktokStatuses: summary.tiktokStatuses,
    direct: summary.direct,
    avgMs: summary.avgMs,
    countries: summary.countries,
  };
}

module.exports = { checkProxies, applyResults, summarize, compact, extractCountry, normalizeCountry, checkOptions };
