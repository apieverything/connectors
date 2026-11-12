"use strict";

/**
 * Post-fetching strategies.
 *
 * Meta retires the endpoint used for posts every few months (web_profile_info
 * -> PolarisProfilePostsQuery -> ...). Instead of hard-coding one, each source
 * is a small independent strategy; getPosts() walks the list until one works.
 * Order and doc_ids are configurable through env vars so a rotation can be
 * handled without a code release.
 */

const {
  fetchWebProfileInfo,
  fetchGraphqlPosts,
  fetchAnonGrid,
  extractTimeline,
  extractGridUserId,
  findUser,
} = require("./fetch");
const { InstagramError } = require("./session");

const MOBILE_BASE = "https://i.instagram.com";
const WEB_BASE = "https://www.instagram.com";

function cursorFrom(timeline) {
  const info = timeline?.page_info ?? {};
  if (info.has_next_page) return info.end_cursor ?? null;
  if (info.more_available) return info.next_max_id ?? info.end_cursor ?? null;
  return null;
}

function nodesFrom(timeline) {
  return (timeline?.edges ?? []).map((edge) => edge?.node ?? edge).filter(Boolean);
}

async function anonGrid(ctx) {
  const { data, body } = await fetchAnonGrid(ctx.username, ctx.cursor, ctx.session, {
    fixedProxy: ctx.fixedProxy,
    limit: ctx.limit,
    userId: ctx.gridUserId,
  });
  const timeline = extractTimeline(data);
  if (!timeline) {
    throw new InstagramError(
      "IG_UNEXPECTED_RESPONSE",
      "Logged-out grid returned no timeline (doc_id may be retired).",
      502,
      body.slice(0, 300)
    );
  }
  return {
    nodes: nodesFrom(timeline),
    nextCursor: cursorFrom(timeline),
    profile: findUser(data),
    gridUserId: extractGridUserId(data) ?? ctx.gridUserId,
    source: "anon_grid",
  };
}

async function graphqlPosts(ctx) {
  const { data, body } = await fetchGraphqlPosts(
    ctx.username,
    ctx.cursor,
    ctx.session,
    { fixedProxy: ctx.fixedProxy, limit: ctx.limit }
  );
  const timeline = extractTimeline(data);
  if (!timeline) {
    throw new InstagramError(
      "IG_UNEXPECTED_RESPONSE",
      "GraphQL response contained no posts timeline (doc_id may be retired).",
      502,
      body.slice(0, 300)
    );
  }
  return {
    nodes: nodesFrom(timeline),
    nextCursor: cursorFrom(timeline),
    profile: findUser(data),
    source: "graphql_posts",
  };
}

async function webProfileInfo(ctx, { auth, base }) {
  const { user } = await fetchWebProfileInfo(ctx.username, ctx.cursor, ctx.session, {
    auth,
    base,
    fixedProxy: ctx.fixedProxy,
  });
  const timeline = user.edge_owner_to_timeline_media ?? {};
  return {
    nodes: nodesFrom(timeline),
    nextCursor: cursorFrom(timeline),
    profile: user,
    source: `web_profile_info:${auth}:${base === MOBILE_BASE ? "mobile" : "www"}`,
  };
}

const STRATEGIES = {
  anon_grid: (ctx) => anonGrid(ctx),
  graphql_posts: (ctx) => graphqlPosts(ctx),
  // Anonymous is FIRST among the REST fallbacks: the signed-in variant of
  // web_profile_info is the one Meta retired (429 / feedback_required).
  web_profile_info_anon: (ctx) =>
    webProfileInfo(ctx, { auth: "anonymous", base: WEB_BASE }),
  web_profile_info_mobile: (ctx) =>
    webProfileInfo(ctx, { auth: "session", base: MOBILE_BASE }),
  web_profile_info: (ctx) => webProfileInfo(ctx, { auth: "session", base: WEB_BASE }),
};

const DEFAULT_ORDER = [
  "anon_grid", // verified working anonymously without a session or proxy
  "graphql_posts",
  "web_profile_info_anon",
  "web_profile_info_mobile",
  "web_profile_info",
];

function strategyOrder({ anonymous = false } = {}) {
  const raw = process.env.IG_POSTS_STRATEGIES?.trim();
  let names = DEFAULT_ORDER;
  if (raw) {
    const custom = raw
      .split(/[\s,]+/)
      .filter(Boolean)
      .filter((name) => Object.prototype.hasOwnProperty.call(STRATEGIES, name));
    if (custom.length) names = custom;
  }
  // With no session, "web_profile_info" (auth: session) is byte-identical to
  // "web_profile_info_anon": skip the duplicate request.
  return anonymous ? names.filter((name) => name !== "web_profile_info") : names;
}

/** Run every strategy once and report what happened, for /v1/diagnostics. */
async function runDiagnostics(ctx) {
  const results = [];
  for (const name of strategyOrder({ anonymous: !ctx.session })) {
    const started = Date.now();
    try {
      const result = await STRATEGIES[name]({ ...ctx, cursor: null, limit: 1 });
      results.push({
        strategy: name,
        ok: result.nodes.length > 0,
        posts: result.nodes.length,
        ms: Date.now() - started,
        source: result.source,
      });
    } catch (err) {
      results.push({
        strategy: name,
        ok: false,
        posts: 0,
        ms: Date.now() - started,
        code: err.code ?? "UNKNOWN",
        message: err.message,
      });
    }
  }
  return results;
}

module.exports = { STRATEGIES, DEFAULT_ORDER, strategyOrder, runDiagnostics, cursorFrom, nodesFrom };
