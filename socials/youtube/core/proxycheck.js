"use strict";

/** Startup proxy probe: liveness, country, latency and YouTube reachability. */
const axios = require("axios");
const { redact } = require("./proxy");
const { DEFAULT_USER_AGENT, buildCookieHeader } = require("./session");

const PROBES = ["https://ipwho.is/", "https://www.cloudflare.com/cdn-cgi/trace", "https://ipinfo.io/json"];
const YT_PROBE = "https://www.youtube.com/robots.txt";

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
    timeout: Math.max(1000, Number(process.env.YT_PROXY_CHECK_TIMEOUT_MS ?? 8000)),
    concurrency: Math.max(1, Number(process.env.YT_PROXY_CHECK_CONCURRENCY ?? 5)),
    urls: process.env.YT_PROXY_CHECK_URL?.trim() ? [process.env.YT_PROXY_CHECK_URL.trim()] : PROBES,
    ytUrl: process.env.YT_PROXY_CHECK_YT_URL?.trim() || YT_PROBE,
    compareDirect: process.env.YT_PROXY_CHECK_COMPARE !== "0",
    ua: process.env.YT_PROXY_CHECK_UA?.trim() || "api-everything/youtube-proxy-check/1.0",
    ytUa: process.env.YT_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
  };
}

async function probe(entry, url, options, signal, isYouTube) {
  const res = await axios.get(url, {
    proxy: entry ? entry.config : false,
    timeout: options.timeout,
    signal,
    validateStatus: () => true,
    responseType: "text",
    transformResponse: [(d) => d],
    headers: {
      "User-Agent": isYouTube ? options.ytUa : options.ua,
      Accept: isYouTube ? "text/plain,text/html,*/*" : "*/*",
      ...(isYouTube ? { "Accept-Language": "en-US,en;q=0.9", Cookie: buildCookieHeader(null) } : {}),
    },
  });
  const text = String(res.data ?? "");
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, country: extractCountry(json, text), snippet: redact(text.replace(/\s+/g, " ").slice(0, 160)) };
}

async function checkOne(entry, index, options, signal) {
  const started = Date.now();
  let alive = false, country = null, lastError = null;
  for (const url of options.urls) {
    if (signal?.aborted) break;
    try {
      const r = await probe(entry, url, options, signal, false);
      if (r.status < 500 && r.status !== 407) {
        alive = true;
        if (r.country) { country = r.country; break; }
      }
    } catch (err) { if (!signal?.aborted) lastError = err; }
  }
  let youtubeStatus = null;
  try {
    youtubeStatus = (await probe(entry, options.ytUrl, options, signal, true)).status;
  } catch (err) { lastError = err; }
  return {
    index, label: redact(entry.raw), alive, country,
    ms: Date.now() - started, youtubeStatus,
    error: alive ? null : redact(lastError?.message ?? "unreachable"),
  };
}

function summarize(results, direct = null) {
  const alive = results.filter((r) => r.alive);
  const latencies = alive.map((r) => r.ms);
  const countries = {};
  const ytStatuses = {};
  let ytAlive = 0;
  for (const r of results) {
    if (r.country) countries[r.country] = (countries[r.country] ?? 0) + 1;
    if (r.youtubeStatus === null || r.youtubeStatus === undefined) continue;
    ytStatuses[r.youtubeStatus] = (ytStatuses[r.youtubeStatus] ?? 0) + 1;
    if (r.youtubeStatus >= 200 && r.youtubeStatus < 300) ytAlive += 1;
  }
  return {
    checkedAt: new Date().toISOString(),
    total: results.length, alive: alive.length, dead: results.length - alive.length,
    ytAlive, ytStatuses, direct,
    avgMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    minMs: latencies.length ? Math.min(...latencies) : null,
    maxMs: latencies.length ? Math.max(...latencies) : null,
    countries, results,
  };
}

async function checkProxies(pool, { signal } = {}) {
  const options = checkOptions();
  if (!pool.enabled || process.env.YT_PROXY_CHECK === "0") return summarize([]);
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
      const r = await probe(null, options.ytUrl, options, signal, true);
      direct = { youtubeStatus: r.status, snippet: r.snippet, ms: Date.now() - started };
    } catch (err) {
      direct = { youtubeStatus: null, snippet: redact(err.message), ms: Date.now() - started };
    }
  }
  return summarize(results.filter(Boolean), direct);
}
function applyResults(pool, summary) {
  for (const r of summary.results) if (!r.alive) pool.markFailed(pool.entries[r.index]);
}
function compact(summary) {
  if (!summary) return null;
  return {
    checkedAt: summary.checkedAt, total: summary.total,
    alive: summary.alive, dead: summary.dead,
    ytAlive: summary.ytAlive, ytStatuses: summary.ytStatuses,
    direct: summary.direct, avgMs: summary.avgMs, countries: summary.countries,
  };
}
module.exports = { checkProxies, applyResults, summarize, compact, extractCountry, normalizeCountry, checkOptions };
