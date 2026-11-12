"use strict";

/**
 * Startup proxy health check.
 *
 * For every entry in the pool, a small geo/IP endpoint is requested THROUGH
 * the proxy. That tells us three things at once: the tunnel works (alive),
 * how long the round trip took (ms), and which country the exit IP is in.
 *
 * Runs in parallel, never blocks server startup, and never logs credentials.
 */

const axios = require("axios");
const { redact } = require("./proxy");
const { log } = require("./logger");

const DEFAULT_UA = "api-everything/proxy-check/1.0";

// Tried in order; the first one that returns a country code wins.
const DEFAULT_PROBES = [
  "https://ipwho.is/",
  "https://www.cloudflare.com/cdn-cgi/trace",
  "https://ipinfo.io/json",
];

function normalizeCountry(value) {
  if (typeof value !== "string") return null;
  const code = value.trim();
  return /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : null;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Pull a 2-letter country code out of JSON or Cloudflare's trace format. */
function extractCountry(json, text) {
  const candidates = [
    json?.country_code,
    json?.countryCode,
    json?.country,
    json?.location?.country_code,
    json?.data?.country_code,
  ];
  for (const candidate of candidates) {
    const code = normalizeCountry(candidate);
    if (code) return code;
  }

  const trace = /^loc=([A-Za-z]{2})\s*$/m.exec(String(text ?? ""));
  if (trace) return trace[1].toUpperCase();

  const plain = String(text ?? "").trim();
  return /^[A-Za-z]{2}$/.test(plain) ? plain.toUpperCase() : null;
}

function probeUrls() {
  const custom = process.env.IG_PROXY_CHECK_URL?.trim();
  return custom ? [custom] : DEFAULT_PROBES;
}

// The profile HTML page is a STABLE liveness probe. web_profile_info is a
// retired endpoint for signed-in sessions (429 for everyone), so probing it
// used to report "IG blocked" even on a perfectly good residential IP.
const DEFAULT_IG_PROBE = "https://www.instagram.com/instagram/";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function checkOptions() {
  return {
    timeout: Math.max(1000, Number(process.env.IG_PROXY_CHECK_TIMEOUT_MS ?? 8000)),
    concurrency: Math.max(1, Number(process.env.IG_PROXY_CHECK_CONCURRENCY ?? 5)),
    userAgent: process.env.IG_PROXY_CHECK_UA?.trim() || DEFAULT_UA,
    urls: probeUrls(),
    checkIg: process.env.IG_PROXY_CHECK_IG !== "0",
    igUrl: process.env.IG_PROXY_CHECK_IG_URL?.trim() || DEFAULT_IG_PROBE,
    igUserAgent:
      process.env.IG_PROXY_CHECK_IG_UA?.trim() ||
      process.env.IG_USER_AGENT?.trim() ||
      BROWSER_UA,
    // One extra request WITHOUT the proxy tells us instantly whether the 429
    // comes from Meta rejecting this exit IP or from the connection itself.
    compareDirect: process.env.IG_PROXY_CHECK_IG_COMPARE !== "0",
  };
}

/**
 * "Alive" against ipwho.is does NOT mean Instagram accepts the exit IP.
 * This second probe hits the exact endpoint the connector uses, so a proxy
 * returning 429 is reported as unusable instead of looking healthy.
 */
async function probeInstagram(entry, options, signal) {
  const res = await axios.get(options.igUrl, {
    // `proxy: false` = direct connection, used by probeDirect().
    proxy: entry ? entry.config : false,
    timeout: options.timeout,
    signal,
    maxRedirects: 2,
    validateStatus: () => true,
    responseType: "text",
    transformResponse: [(data) => data],
    headers: {
      // A bot-looking UA alone can trigger 429. Use the same UA as the
      // browser that created the session cookie.
      "User-Agent": options.igUserAgent,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  const body = typeof res.data === "string" ? res.data : String(res.data ?? "");
  return {
    status: res.status,
    // A residential gateway often returns its OWN error page. Keeping a short
    // snippet lets us tell "Instagram said 429" from "the proxy said 429".
    snippet: redact(body.replace(/\s+/g, " ").slice(0, 160)),
    server: res.headers?.server ?? null,
  };
}

async function probeDirect(options, signal) {
  const started = Date.now();
  try {
    const result = await probeInstagram(null, options, signal);
    return { igStatus: result.status, snippet: result.snippet, ms: Date.now() - started };
  } catch (err) {
    return { igStatus: null, snippet: redact(err.message), ms: Date.now() - started };
  }
}

async function requestThrough(entry, url, options, signal) {
  const res = await axios.get(url, {
    proxy: entry.config,
    timeout: options.timeout,
    signal,
    maxRedirects: 2,
    validateStatus: () => true,
    responseType: "text",
    transformResponse: [(data) => data],
    headers: {
      "User-Agent": options.userAgent,
      Accept: "*/*",
      "Cache-Control": "no-store",
    },
  });
  const text = typeof res.data === "string" ? res.data : String(res.data ?? "");
  return {
    // Any HTTP answer means the tunnel works. 407 = bad proxy credentials.
    alive: res.status < 500 && res.status !== 407,
    status: res.status,
    country: extractCountry(parseJson(text), text),
  };
}

async function checkOne(entry, index, options, signal) {
  const started = Date.now();
  const label = redact(entry.raw);
  let alive = false;
  let firstStatus = null;
  let country = null;
  let lastError = null;

  for (const url of options.urls) {
    if (signal?.aborted) break;
    try {
      const result = await requestThrough(entry, url, options, signal);
      if (result.alive) {
        alive = true;
        firstStatus ??= result.status;
        if (result.country) {
          country = result.country;
          break;
        }
      }
    } catch (err) {
      if (err.name === "AbortError" || signal?.aborted) break;
      lastError = err;
    }
  }

  let igStatus = null;
  let igError = null;
  let igSnippet = null;
  // Probe Instagram even when the geo service was unreachable: a proxy can
  // block ipwho.is while Instagram works fine.
  if (options.checkIg && !signal?.aborted) {
    try {
      const probe = await probeInstagram(entry, options, signal);
      igStatus = probe.status;
      igSnippet = probe.snippet;
      if (process.env.LOG_LEVEL === "debug") {
        log.debug(`IG probe #${index + 1}: ${probe.status} ${probe.server ?? ""} ${probe.snippet}`);
      }
    } catch (err) {
      if (!signal?.aborted) igError = redact(err.message);
    }
  }

  return {
    index,
    label,
    alive,
    country,
    ms: Date.now() - started,
    status: firstStatus,
    error: alive ? null : redact(lastError?.message ?? "unreachable"),
    igStatus,
    igError,
    igSnippet,
  };
}

function summarize(results, direct = null) {
  const alive = results.filter((entry) => entry.alive);
  const latencies = alive.map((entry) => entry.ms);
  const countries = {};
  for (const entry of alive) {
    if (entry.country) countries[entry.country] = (countries[entry.country] ?? 0) + 1;
  }
  const igStatuses = {};
  let igAlive = 0;
  let igBlocked = 0;
  for (const entry of results) {
    if (entry.igStatus === null || entry.igStatus === undefined) continue;
    igStatuses[entry.igStatus] = (igStatuses[entry.igStatus] ?? 0) + 1;
    if (entry.igStatus >= 200 && entry.igStatus < 300) igAlive += 1;
    else igBlocked += 1;
  }

  return {
    checkedAt: new Date().toISOString(),
    total: results.length,
    alive: alive.length,
    dead: results.length - alive.length,
    igAlive,
    igBlocked,
    igStatuses,
    direct,
    avgMs: latencies.length
      ? Math.round(latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length)
      : null,
    minMs: latencies.length ? Math.min(...latencies) : null,
    maxMs: latencies.length ? Math.max(...latencies) : null,
    countries,
    results,
  };
}

/** Check every proxy in the pool, with bounded parallelism. */
async function checkProxies(pool, { signal } = {}) {
  const options = checkOptions();
  if (options.igUrl.includes("web_profile_info")) {
    log.warn(
      "IG_PROXY_CHECK_IG_URL targets web_profile_info (retired, 429 for everyone). Remove it from .env to use the default profile page probe."
    );
  }
  if (!pool.enabled) return summarize([]);

  const results = new Array(pool.entries.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < pool.entries.length && !signal?.aborted) {
      const index = cursor++;
      results[index] = await checkOne(pool.entries[index], index, options, signal);
    }
  };
  const workers = Math.min(options.concurrency, pool.entries.length);
  await Promise.all(Array.from({ length: workers }, worker));

  let direct = null;
  if (options.checkIg && options.compareDirect && !signal?.aborted) {
    direct = await probeDirect(options, signal);
  }
  return summarize(results.filter(Boolean), direct);
}

/** Dead entries are cooled down so they are skipped until the next reload. */
function applyResults(pool, summary) {
  if (!pool.enabled) return;
  for (const result of summary.results) {
    if (!result.alive) {
      const entry = pool.entries[result.index];
      if (entry) pool.markFailed(entry);
    }
  }
}

/** Compact form for /health, / and /v1/session. */
function compact(summary) {
  if (!summary) return null;
  return {
    checkedAt: summary.checkedAt,
    total: summary.total,
    alive: summary.alive,
    dead: summary.dead,
    igAlive: summary.igAlive,
    igBlocked: summary.igBlocked,
    igStatuses: summary.igStatuses,
    direct: summary.direct,
    avgMs: summary.avgMs,
    countries: summary.countries,
  };
}

module.exports = {
  checkProxies,
  checkOptions,
  applyResults,
  summarize,
  compact,
  extractCountry,
  normalizeCountry,
};
