"use strict";

const { STRATEGIES, strategyOrder } = require("./strategies");
const { fetchPostDetail } = require("./fetch");
const { getProfile } = require("./profile");
const { normalizePost, normalizeProfile } = require("./normalize");
const { readSession, InstagramError } = require("./session");
const { getPool, redact } = require("./proxy");
const { log } = require("./logger");

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;

function parseLimit(raw) {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new InstagramError(
      "IG_BAD_REQUEST",
      "?limit must be an integer greater than or equal to 1.",
      400
    );
  }
  return Math.min(n, MAX_LIMIT);
}

/**
 * Pick ONE proxy for the whole logical request. Replaying a session cookie
 * from several different IPs within seconds is a strong anti-bot signal and
 * is a common cause of persistent 429s. Set IG_PROXY_STICKY=0 to opt out.
 */
function pinProxy(anonymous) {
  // With no session cookie there is no identity to protect, so rotating IPs
  // is harmless (and actually useful). Sticky only matters when authenticated.
  if (anonymous || process.env.IG_PROXY_STICKY === "0") return { hasFixed: false };
  let pool;
  try {
    pool = getPool();
  } catch (err) {
    throw new InstagramError(
      "IG_PROXY_CONFIG_ERROR",
      `Invalid proxy configuration: ${redact(err.message)}`,
      500
    );
  }
  if (!pool.enabled) return { hasFixed: false };
  return { hasFixed: true, fixedProxy: pool.select()?.config ?? null };
}

/**
 * Fetch a profile's posts, paginated. The first successful strategy is reused
 * for the remaining pages so a single request never mixes sources or IPs.
 */
async function getPosts(username, { limit = DEFAULT_LIMIT, cursor = null } = {}) {
  const session = readSession();
  const anonymous = !session;
  // Anonymous mode is allowed: there is no cookie to leak or to tie to a
  // country, and PolarisProfilePostsQuery has an anonymous doc_id.
  if (anonymous && process.env.IG_ALLOW_ANONYMOUS_POSTS === "0") {
    throw new InstagramError(
      "IG_SESSION_MISSING",
      "Anonymous posts are disabled. Set IG_SESSIONID or IG_ALLOW_ANONYMOUS_POSTS=1.",
      401
    );
  }
  const pin = pinProxy(anonymous);
  const maxPages = Math.max(1, Number(process.env.IG_MAX_PAGES ?? 10));
  const order = strategyOrder({ anonymous });
  const ctx = {
    username,
    session,
    limit,
    cursor,
    ...(pin.hasFixed ? { fixedProxy: pin.fixedProxy } : {}),
  };

  const failures = [];
  let winner = null;
  let firstPage = null;
  let gridUserId = null;

  for (const name of order) {
    try {
      firstPage = await STRATEGIES[name]({ ...ctx, gridUserId });
      gridUserId = firstPage.gridUserId ?? gridUserId;
      winner = name;
      break;
    } catch (err) {
      failures.push({ strategy: name, code: err.code ?? "UNKNOWN", message: err.message });
      log.warn(`posts strategy ${name} failed (${err.code ?? "UNKNOWN"}); trying next`);
    }
  }

  if (!winner) {
    throw new InstagramError(
      "IG_ALL_STRATEGIES_FAILED",
      "Every post-fetching strategy failed. See details for each strategy, then try /v1/diagnostics.",
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
  // Resolve the full profile separately: the posts grid carries no metadata.
  let profile = await getProfile(username, session, {
    fixedProxy: pin.hasFixed ? pin.fixedProxy : undefined,
  });
  const fromStrategy = normalizeProfile(firstPage.profile, username);
  for (const key of [
    "followers", "following", "posts", "fullName", "biography",
    "profilePicUrl", "profileId", "externalUrl", "category", "bioLinks",
  ]) {
    const current = profile[key];
    const extra = fromStrategy[key];
    const empty =
      current === null ||
      current === undefined ||
      (Array.isArray(current) && current.length === 0);
    if (empty && extra !== null && extra !== undefined) profile[key] = extra;
  }
  if (profile.source === "unresolved") profile.source = firstPage.source ?? winner;

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
    if (nextCursor === previousCursor) break; // Instagram ignored the cursor
    previousCursor = nextCursor;

    try {
      page = await STRATEGIES[winner]({ ...ctx, cursor: nextCursor, gridUserId });
      gridUserId = page.gridUserId ?? gridUserId;
    } catch (err) {
      failures.push({ strategy: winner, phase: "pagination", code: err.code, message: err.message });
      break;
    }
    nextCursor = page.nextCursor;
    pages += 1;
    if (!(page.nodes ?? []).length) break;
  }

  const posts = collected.slice(0, limit);

  // The logged-out grid omits likes / comments / taken_at. One extra
  // anonymous GraphQL call per shortcode fills them in (opt-in, rate-limit
  // friendly because throttle() still applies).
  if (process.env.IG_ENRICH_POSTS === "1") {
    const cap = Math.max(0, Number(process.env.IG_ENRICH_MAX ?? 12));
    for (const post of posts.slice(0, cap)) {
      if (!post.shortcode) continue;
      try {
        const item = await fetchPostDetail(post.shortcode, session, {
          username,
          fixedProxy: pin.hasFixed ? pin.fixedProxy : undefined,
        });
        if (!item) continue;
        const detail = normalizePost(item, username);
        // taken_at from the detail query is exact; the grid only has a
        // day-level date parsed from the accessibility caption.
        if (detail.timestamp !== null && detail.timestamp !== undefined) {
          post.timestamp = detail.timestamp;
          post.datePosted = detail.datePosted;
        }
        for (const key of [
          "numComments", "likes", "altText",
          "location", "photos", "videos", "type", "isVideo",
        ]) {
          const current = post[key];
          const replacement = detail[key];
          const empty =
            current === null ||
            current === undefined ||
            (Array.isArray(current) && current.length === 0);
          if (empty && replacement !== null && replacement !== undefined) {
            post[key] = replacement;
          }
        }
      } catch (err) {
        log.warn(`enrich ${post.shortcode} failed (${err.code ?? "UNKNOWN"}); keeping grid data`);
      }
    }
  }

  return {
    username,
    profile,
    count: Math.min(collected.length, limit),
    posts,
    nextCursor: collected.length >= limit ? nextCursor : null,
    hasMore: collected.length >= limit ? Boolean(nextCursor) : false,
    source: firstPage.source ?? winner,
    strategy: winner,
    anonymous,
    stickyProxy: pin.hasFixed,
    ...(anonymous
      ? { note: "Anonymous mode: no session cookie, IP location is irrelevant." }
      : {}),
    failures,
  };
}

module.exports = { getPosts, parseLimit, DEFAULT_LIMIT, MAX_LIMIT };
