"use strict";

const axios = require("axios");
const { ConnectorError } = require("./errors");
const { getPool, redact } = require("./proxy");
const { log } = require("./logger");

const CHROME_UA =
  process.env.LI_USER_AGENT?.trim() ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// LinkedIn serves a richer SEO payload to crawlers (About / Experience /
// Education / Location) than to a plain browser.
const CRAWLER_UA =
  process.env.LI_CRAWLER_USER_AGENT?.trim() ||
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const timeoutMs = () => Math.max(1000, Number(process.env.LI_TIMEOUT_MS ?? 15000));
const minIntervalMs = () => Math.max(0, Number(process.env.LI_MIN_INTERVAL_MS ?? 1000));
let lastRequestAt = 0;

async function throttle() {
  const interval = minIntervalMs();
  if (!interval) return;
  const wait = lastRequestAt + interval - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

function sessionCookie(session) {
  if (!session?.liAt) return null;
  return `li_at=${session.liAt}; JSESSIONID="${session.jsessionId ?? ""}"`;
}

async function performRequest(url, { session = null, headers = null, proxy = null, crawler = false } = {}) {
  await throttle();
  const built = {
    "User-Agent": crawler ? CRAWLER_UA : CHROME_UA,
    "Accept-Language": "en-US,en;q=0.9",
    Accept: crawler ? "text/html,application/xhtml+xml" : "*/*",
    ...(headers ?? {}),
  };
  const cookie = sessionCookie(session);
  if (cookie) built.Cookie = cookie;

  let res;
  try {
    res = await axios.get(url, {
      headers: built,
      proxy: proxy ?? undefined,
      timeout: timeoutMs(),
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: "text",
      transformResponse: [(d) => d],
    });
  } catch (err) {
    throw new ConnectorError("LI_NETWORK_ERROR", `Could not reach LinkedIn: ${redact(err.message)}`, 502, redact(err.message));
  }

  const body = typeof res.data === "string" ? res.data : String(res.data ?? "");
  const status = res.status;
  if (status === 404) throw new ConnectorError("LI_USER_NOT_FOUND", "Resource not found.", 404);
  if (status === 429 || status === 999) {
    throw new ConnectorError("LI_RATE_LIMITED", `LinkedIn returned ${status}.`, 429, {
      retryAfter: res.headers["retry-after"] ?? null,
      body: redact(body.slice(0, 160)),
    });
  }
  if (status === 401 || status === 403) {
    throw new ConnectorError("LI_BLOCKED", `LinkedIn returned ${status}.`, 502, { body: redact(body.slice(0, 160)) });
  }
  if (status >= 500) throw new ConnectorError("LI_UPSTREAM_ERROR", `LinkedIn returned ${status}.`, 502);
  if (status >= 400) throw new ConnectorError("LI_HTTP_ERROR", `LinkedIn returned ${status}.`, 502);
  return { body, status, headers: res.headers, finalUrl: res.request?.res?.responseUrl ?? url };
}

async function get(url, options = {}) {
  const hasFixed = Object.prototype.hasOwnProperty.call(options, "fixedProxy");
  const { fixedProxy, ...rest } = options;
  if (hasFixed) return await performRequest(url, { ...rest, proxy: fixedProxy ?? null });

  const pool = getPool();
  let lastError;
  for (let attempt = 1; attempt <= pool.attempts; attempt += 1) {
    const selected = pool.select();
    try {
      return await performRequest(url, { ...rest, proxy: selected?.config ?? null });
    } catch (err) {
      lastError = err;
      if (attempt === pool.attempts || !pool.isRetryable(err)) throw err;
      if (selected) pool.markFailed(selected.entry);
      log.warn(`proxy attempt ${attempt}/${pool.attempts} failed (${err.code}); rotating`);
    }
  }
  throw lastError;
}

module.exports = { get, performRequest, CHROME_UA, CRAWLER_UA };
