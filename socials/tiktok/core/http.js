"use strict";

const axios = require("axios");
const { ConnectorError } = require("./errors");
const { getPool, redact } = require("./proxy");
const { log } = require("./logger");

const UA =
  process.env.TT_USER_AGENT?.trim() ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const timeoutMs = () => Math.max(1000, Number(process.env.TT_TIMEOUT_MS ?? 15000));
const minIntervalMs = () => Math.max(0, Number(process.env.TT_MIN_INTERVAL_MS ?? 1000));

let lastRequestAt = 0;
async function throttle() {
  const interval = minIntervalMs();
  if (!interval) return;
  const wait = lastRequestAt + interval - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

function safeJson(text) {
  const cleaned = String(text).replace(/^\s*(?:for\s*\(;;\);|while\s*\(1\);)\s*/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function baseHeaders() {
  return {
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
    Accept: "text/html,application/xhtml+xml",
  };
}

function cookieJar(session) {
  if (!session?.sessionId) return null;
  const jar = [`sessionid=${session.sessionId}`];
  if (session.msToken) jar.push(`msToken=${session.msToken}`);
  if (session.ttwid) jar.push(`ttwid=${session.ttwid}`);
  return jar.join("; ");
}

async function performRequest(url, { session = null, headers = null, proxy = null, method = "get", data = null } = {}) {
  await throttle();
  const built = { ...baseHeaders(), ...(headers ?? {}) };
  const jar = cookieJar(session);
  if (jar) built.Cookie = jar;

  let res;
  try {
    res = await axios.request({
      method,
      url,
      headers: built,
      data: data ?? undefined,
      proxy: proxy ?? undefined,
      timeout: timeoutMs(),
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: "text",
      transformResponse: [(d) => d],
    });
  } catch (err) {
    if (/maximum number of redirects/i.test(err.message)) {
      throw new ConnectorError("TT_SESSION_EXPIRED", "TikTok kept redirecting to the login page.", 401);
    }
    throw new ConnectorError("TT_NETWORK_ERROR", `Could not reach TikTok: ${redact(err.message)}`, 502, redact(err.message));
  }

  const raw = res.data;
  const body = typeof raw === "string" ? raw : String(raw ?? "");
  const status = res.status;

  if (status === 404) throw new ConnectorError("TT_USER_NOT_FOUND", "User not found.", 404);
  if (status === 429) {
    throw new ConnectorError("TT_RATE_LIMITED", `TikTok returned 429.`, 429, {
      retryAfter: res.headers["retry-after"] ?? null,
      body: redact(body.slice(0, 200)),
    });
  }
  if (status === 401 || status === 403) {
    throw new ConnectorError("TT_BLOCKED", `TikTok returned ${status}.`, 502, { body: redact(body.slice(0, 200)) });
  }
  if (status >= 500) throw new ConnectorError("TT_UPSTREAM_ERROR", `TikTok returned ${status}.`, 502);
  if (status >= 400) throw new ConnectorError("TT_HTTP_ERROR", `TikTok returned ${status}.`, 502);

  return {
    data: safeJson(body),
    body,
    status,
    headers: res.headers,
    setCookies: (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; "),
  };
}

/** GET with optional proxy rotation, or a pinned proxy for one logical request. */
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

module.exports = { get, performRequest, baseHeaders, cookieJar, safeJson, UA };
