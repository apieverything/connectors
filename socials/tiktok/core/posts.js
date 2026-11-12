"use strict";

const { STRATEGIES, strategyOrder } = require("./strategies");
const { getProfile } = require("./profile");
const { normalizePost } = require("./normalize");
const { ConnectorError } = require("./errors");
const { getPool, redact } = require("./proxy");
const { log } = require("./logger");

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;

function parseLimit(raw) {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ConnectorError("TT_BAD_REQUEST", "?limit must be an integer >= 1.", 400);
  }
  return Math.min(n, MAX_LIMIT);
}

function pinProxy(anonymous) {
  if (anonymous || process.env.TT_PROXY_STICKY === "0") return { hasFixed: false };
  let pool;
  try {
    pool = getPool();
  } catch (err) {
    throw new ConnectorError("TT_PROXY_CONFIG_ERROR", `Invalid proxy configuration: ${redact(err.message)}`, 500);
  }
  if (!pool.enabled) return { hasFixed: false };
  return { hasFixed: true, fixedProxy: pool.select()?.config ?? null };
}

function parseIds(raw) {
  return String(raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{10,25}$/.test(s))
    .slice(0, MAX_LIMIT);
}

async function getPosts(username, { limit = DEFAULT_LIMIT, cursor = null, ids = [] } = {}) {
  const session = process.env.TT_SESSIONID?.trim()
    ? { sessionId: process.env.TT_SESSIONID.trim() }
    : null;
  const anonymous = !session;
  const pin = pinProxy(anonymous);
  const fixedProxy = pin.hasFixed ? pin.fixedProxy : undefined;

  const profileResult = await getProfile(username, { session, fixedProxy });
  const order = strategyOrder({ hasIds: ids.length > 0 });
  const ctx = {
    username,
    session,
    limit,
    cursor,
    ids,
    fixedProxy,
    profileResult,
  };

  const failures = [];
  let winner = null;
  let firstPage = null;

  for (const name of order) {
    try {
      firstPage = await STRATEGIES[name](ctx);
      winner = name;
      break;
    } catch (err) {
      failures.push({ strategy: name, code: err.code ?? "UNKNOWN", message: err.message });
      log.warn(`posts strategy ${name} failed (${err.code ?? "UNKNOWN"})`);
    }
  }

  if (!winner) {
    throw new ConnectorError(
      "TT_ALL_STRATEGIES_FAILED",
      "Every post source failed. See details and /v1/diagnostics.",
      502,
      failures
    );
  }

  log.success(`posts via ${winner}`);

  const collected = [];
  const seen = new Set();
  let page = firstPage;
  let nextCursor = firstPage.nextCursor;
  let previousCursor = cursor;
  let pages = 1;
  const maxPages = Math.max(1, Number(process.env.TT_MAX_PAGES ?? 10));

  while (true) {
    for (const node of page.nodes ?? []) {
      const post = normalizePost(node, username);
      const key = post.shortcode ?? `${post.timestamp}-${collected.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(post);
      if (collected.length >= limit) break;
    }
    if (collected.length >= limit || !nextCursor || pages >= maxPages) break;
    if (nextCursor === previousCursor) break;
    previousCursor = nextCursor;
    try {
      page = await STRATEGIES[winner]({ ...ctx, cursor: nextCursor });
      nextCursor = page.nextCursor;
    } catch (err) {
      failures.push({ strategy: winner, phase: "pagination", code: err.code, message: err.message });
      break;
    }
    pages += 1;
    if (!(page.nodes ?? []).length) break;
  }

  const posts = collected.slice(0, limit);
  return {
    username,
    profile: profileResult.profile,
    count: posts.length,
    posts,
    nextCursor: posts.length >= limit ? nextCursor : null,
    hasMore: posts.length >= limit ? Boolean(nextCursor) : false,
    source: firstPage.source ?? winner,
    strategy: winner,
    anonymous,
    stickyProxy: pin.hasFixed,
    failures,
  };
}

module.exports = { getPosts, parseLimit, parseIds, DEFAULT_LIMIT, MAX_LIMIT };
