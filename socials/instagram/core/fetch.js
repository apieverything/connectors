"use strict";

const cheerio = require("cheerio");
const axios = require("axios");
const { parseOgDescription } = require("./parsing");
const { buildHeaders, buildCrawlerHeaders, buildApiHeaders, InstagramError } = require("./session");
const { getPool, redact } = require("./proxy");
const { normalizeProfile } = require("./normalize");
const { log } = require("./logger");

const BASE = "https://www.instagram.com";

// Read on every call so a Ctrl+R reload picks up edited values immediately.
const timeoutMs = () => Math.max(1000, Number(process.env.IG_TIMEOUT_MS ?? 15000));
const minIntervalMs = () => Math.max(0, Number(process.env.IG_MIN_INTERVAL_MS ?? 1000));

let lastRequestAt = 0;

/** Space requests out to avoid throttling (and to protect the account). */
async function throttle() {
  const interval = minIntervalMs();
  if (!interval) return;
  const wait = lastRequestAt + interval - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

function loginWall(finalUrl, body, html) {
  if (/\/accounts\/login|\/challenge\/|\/accounts\/suspended/i.test(finalUrl)) return true;
  // A public HTML page can mention "Please log in" without anything being
  // wrong with the session, so only inspect the body on API responses.
  if (html) return false;
  return /checkpoint_required|"loginForm"|Please wait a few minutes/i.test(body);
}

function safeJson(text) {
  // Meta prefixes some GraphQL responses with an anti-hijacking token.
  const cleaned = String(text).replace(/^\s*(?:for\s*\(;;\);|while\s*\(1\);)\s*/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/** One HTTP attempt, with statuses translated into actionable errors. */
async function performRequest(method, path, { session, html, params, headers, proxy, base = BASE, requestBody = null }) {
  await throttle();
  const requestUrl = `${base}${path}`;

  let res;
  try {
    res = await axios.request({
      method,
      url: requestUrl,
      headers: headers ?? buildHeaders(session, { html }),
      params: params ?? undefined,
      data: requestBody ?? undefined,
      proxy: proxy ?? undefined,
      timeout: timeoutMs(),
      maxRedirects: 5,
      validateStatus: () => true,
      // Keep the raw payload so a login wall is not silently turned into "".
      responseType: html ? "text" : "json",
      transformResponse: [(payload) => payload],
    });
  } catch (err) {
    // An invalid cookie makes Instagram bounce between the profile page and
    // /accounts/login until axios gives up. Report it as a session problem.
    if (/maximum number of redirects/i.test(err.message)) {
      throw new InstagramError(
        session ? "IG_SESSION_EXPIRED" : "IG_BLOCKED",
        "Instagram kept redirecting to the login page; the session is invalid.",
        session ? 401 : 502
      );
    }
    throw new InstagramError(
      "IG_NETWORK_ERROR",
      `Could not reach Instagram: ${redact(err.message)}`,
      502,
      redact(err.message)
    );
  }

  const finalUrl = res.request?.res?.responseUrl ?? requestUrl;
  const raw = res.data;
  const body = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
  const data = typeof raw === "string" ? safeJson(raw) : raw;

  if (res.status === 404) {
    throw new InstagramError("IG_USER_NOT_FOUND", "User not found.", 404);
  }
  if (res.status === 429) {
    throw new InstagramError(
      "IG_RATE_LIMITED",
      `Instagram returned 429 (Retry-After: ${res.headers["retry-after"] ?? "unknown"}).`,
      429,
      { retryAfter: res.headers["retry-after"] ?? null, body: redact(body.slice(0, 200)) }
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new InstagramError(
      session ? "IG_SESSION_EXPIRED" : "IG_BLOCKED",
      `Instagram returned ${res.status}.`,
      session ? 401 : 502,
      { body: redact(body.slice(0, 200)) }
    );
  }
  if (res.status >= 500) {
    throw new InstagramError("IG_UPSTREAM_ERROR", `Instagram returned ${res.status}.`, 502);
  }
  if (res.status >= 400) {
    throw new InstagramError(
      "IG_HTTP_ERROR",
      `Instagram returned ${res.status}.`,
      502,
      body.slice(0, 300)
    );
  }
  if (loginWall(finalUrl, body, html)) {
    // An anonymous request has no session to expire: a login redirect here
    // means the exit IP was challenged, not that a cookie went stale.
    throw new InstagramError(
      session ? "IG_SESSION_EXPIRED" : "IG_BLOCKED",
      session
        ? "Redirected to the login page: the session is no longer valid."
        : "Instagram redirected this exit IP to the login page.",
      session ? 401 : 502
    );
  }

  return { data, body, status: res.status, headers: res.headers };
}

/**
 * HTTP call with optional proxy rotation.
 *
 * `fixedProxy` pins one proxy for a whole logical request. Replaying a
 * session cookie from several IPs within seconds is a strong anti-bot signal,
 * so authenticated post fetching always pins a single exit IP.
 */
async function igRequest(method, path, options = {}) {
  const hasFixed = Object.prototype.hasOwnProperty.call(options, "fixedProxy");
  const { fixedProxy, ...rest } = options;
  if (hasFixed) {
    return await performRequest(method, path, { ...rest, proxy: fixedProxy ?? null });
  }

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

  const attempts = pool.attempts;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const selected = pool.select();
    try {
      return await performRequest(method, path, { ...rest, proxy: selected?.config ?? null });
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !pool.isRetryable(err)) throw err;
      if (selected) pool.markFailed(selected.entry);
      log.warn(
        `proxy attempt ${attempt}/${attempts} failed (${err.code}); rotating to the next proxy`
      );
    }
  }
  throw lastError;
}

function igGet(path, options = {}) {
  return igRequest("get", path, options);
}

function igPost(path, options = {}) {
  return igRequest("post", path, options);
}

/* ------------------------------------------------------------------ *
 * Profile stats.
 *
 * Two independent sources, tried in order:
 *   1. web_profile_info, when a session exists -> EXACT counts + profile info.
 *   2. og:description, ALWAYS anonymous -> rounded counts, but no cookie.
 *
 * The fallback must never send the session cookie: with a logged-in session
 * Instagram serves the SPA shell, which has NO og:description tag. Only the
 * minimal crawler UA triggers the variant that contains it (see session.js).
 * ------------------------------------------------------------------ */

function extractOgDescription(html) {
  const $ = cheerio.load(html);
  return $('meta[property="og:description"]').attr("content") ?? null;
}

async function fetchProfileHtml(username) {
  const { body } = await igGet(`/${encodeURIComponent(username)}/`, {
    html: true,
    headers: buildCrawlerHeaders(),
  });
  return body;
}

const FALLBACKABLE_CODES = [
  "IG_RATE_LIMITED",
  "IG_NETWORK_ERROR",
  "IG_HTTP_ERROR",
  "IG_UPSTREAM_ERROR",
  "IG_UNEXPECTED_RESPONSE",
  "IG_SESSION_EXPIRED",
  "IG_BLOCKED",
  "IG_PRIVATE_PROFILE",
];

async function getProfileStats(username, session = null) {
  let apiError = null;

  if (session) {
    try {
      const { user } = await fetchWebProfileInfo(username, null, session);
      return normalizeProfile(user, username);
    } catch (err) {
      // A 404 is a real answer, not a reason to retry anonymously.
      if (err.code === "IG_USER_NOT_FOUND") throw err;
      if (!FALLBACKABLE_CODES.includes(err.code)) throw err;
      apiError = { code: err.code, message: err.message };
      log.warn(`web_profile_info unavailable for @${username} (${err.code}); falling back to og:description`);
    }
  }

  const html = await fetchProfileHtml(username);
  const description = extractOgDescription(html);
  const stats = parseOgDescription(description);

  if (!stats) {
    throw new InstagramError(
      "IG_UNEXPECTED_RESPONSE",
      `Neither the authenticated web API nor the anonymous profile page returned stats for @${username}.`,
      502,
      {
        apiError,
        ogDescription: description,
        hasOgDescription: Boolean(description),
        htmlBytes: html.length,
      }
    );
  }
  return { username, ...stats, raw: description, source: "og:description" };
}

/* ------------------------------------------------------------------ *
 * Internal web API: the source for POSTS. Requires IG_SESSIONID.
 * Both REST and GraphQL response shapes are accepted because Instagram
 * alternates between them.
 * ------------------------------------------------------------------ */

function pickUser(data) {
  const root = data?.data ?? data;
  return (
    root?.user ??
    root?.xdt_api__v1__users__web__profile__info?.user ??
    root?.xdt_api__v1__users__web__profile__info?.data?.user ??
    null
  );
}

const DEFAULT_WPI_PATH = "/api/v1/users/web_profile_info/";

/**
 * web_profile_info, with a configurable auth mode and host.
 *
 * Meta retired this endpoint for SIGNED-IN sessions in 2026 (429 /
 * feedback_required for everyone), while the anonymous variant still works
 * for public profiles. Both are kept as fallback strategies.
 */
async function fetchWebProfileInfo(username, maxId = null, session = null, options = {}) {
  const {
    base = BASE,
    auth = "session",
    path = DEFAULT_WPI_PATH,
  } = options;
  const useSession = auth === "session" ? session : null;
  const params = { username };
  if (maxId) params.max_id = maxId;

  const callOptions = {
    params,
    base,
    headers: buildApiHeaders(useSession, username),
  };
  if (Object.prototype.hasOwnProperty.call(options, "fixedProxy")) {
    callOptions.fixedProxy = options.fixedProxy;
  }

  const { data, body } = await igGet(path, callOptions);
  const user = pickUser(data);

  if (!user) {
    throw new InstagramError(
      "IG_UNEXPECTED_RESPONSE",
      "web_profile_info returned no profile (retired endpoint or changed response format).",
      502,
      body.slice(0, 300)
    );
  }
  if (user.is_private && !user.edge_owner_to_timeline_media) {
    throw new InstagramError("IG_PRIVATE_PROFILE", `@${username} is a private profile.`, 403);
  }
  return { user, data };
}

/* ------------------------------------------------------------------ *
 * GraphQL: what the Instagram web client actually uses for posts now.
 * doc_ids rotate regularly, so they are configurable via env.
 * ------------------------------------------------------------------ */

const DEFAULT_POSTS_DOC_ID = "34579740524958711"; // PolarisProfilePostsQuery (authenticated)
const DEFAULT_POSTS_DOC_ID_ANON = "37691262543822084"; // PolarisProfilePostsQuery (anonymous)
const DEFAULT_GQL_ENDPOINT = "/graphql/query";

function graphqlVariables(username, cursor, limit) {
  return {
    after: cursor || null,
    before: null,
    data: {
      count: limit,
      include_reel_media_seen_timestamp: true,
      include_relationship_info: true,
      latest_besties_reel_media: true,
      latest_reel_media: true,
    },
    first: Math.min(limit, 12),
    include_multi_captions: false,
    last: null,
    username,
    "__relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider": false,
    "__relay_internal__pv__PolarisShortDramaEnabledrelayprovider": false,
    "__relay_internal__pv__PolarisAIGMAccountLabelEnabledrelayprovider": false,
    "__relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider": false,
  };
}

async function fetchGraphqlPosts(username, cursor, session, options = {}) {
  const docId =
    (session
      ? process.env.IG_GQL_POSTS_DOC_ID?.trim() || DEFAULT_POSTS_DOC_ID
      : process.env.IG_GQL_POSTS_DOC_ID_ANON?.trim() || DEFAULT_POSTS_DOC_ID_ANON);
  const endpoint = process.env.IG_GQL_ENDPOINT?.trim() || DEFAULT_GQL_ENDPOINT;
  const friendly =
    process.env.IG_GQL_FRIENDLY_NAME?.trim() || "PolarisProfilePostsQuery";

  const form = new URLSearchParams();
  form.set("doc_id", docId);
  form.set("fb_api_req_friendly_name", friendly);
  form.set("variables", JSON.stringify(graphqlVariables(username, cursor, options.limit ?? 12)));

  const callOptions = {
    headers: buildApiHeaders(session, username, { form: true }),
    requestBody: form.toString(),
  };
  if (Object.prototype.hasOwnProperty.call(options, "fixedProxy")) {
    callOptions.fixedProxy = options.fixedProxy;
  }

  return await igPost(endpoint, callOptions);
}

/* ------------------------------------------------------------------ *
 * LOGGED-OUT profile grid.
 *
 * Verified working anonymously, with NO session and NO proxy:
 *   POST /api/graphql, doc_id 27553725110923321
 *   variables { first: 12, username }
 *   -> data.xig_user_by_username.polaris_ordered_timeline_connection
 *
 * This is the same query the logged-out Instagram web app uses to render the
 * profile grid, so it is not affected by the retired web_profile_info or by
 * the authenticated PolarisProfilePostsQuery 403.
 * ------------------------------------------------------------------ */

const DEFAULT_GRID_DOC_ID = "27553725110923321";
const DEFAULT_GRID_PAGE_DOC_ID = "27389614800735091";
const DEFAULT_POST_DETAIL_DOC_ID = "26713194205046842";
const DEFAULT_GQL_API_ENDPOINT = "/api/graphql";

function gqlForm(docId, friendly, variables) {
  const form = new URLSearchParams();
  form.set("av", "0");
  form.set("__d", "www");
  form.set("__user", "0");
  form.set("__a", "1");
  form.set("dpr", "1");
  form.set("doc_id", docId);
  form.set("fb_api_req_friendly_name", friendly);
  form.set("variables", JSON.stringify(variables));
  return form.toString();
}

async function graphqlApiCall({ docId, friendly, variables, username, session, referer, fixedProxy, cookies = null }) {
  const endpoint = process.env.IG_GQL_API_ENDPOINT?.trim() || DEFAULT_GQL_API_ENDPOINT;
  const headers = buildApiHeaders(session, username, { form: true });
  if (referer) headers.Referer = referer;
  if (cookies?.jar) headers.Cookie = cookies.jar;
  if (cookies?.csrf) headers["X-CSRFToken"] = cookies.csrf;

  const callOptions = {
    headers,
    requestBody: gqlForm(docId, friendly, variables),
  };
  if (fixedProxy !== undefined) callOptions.fixedProxy = fixedProxy;
  return await igPost(endpoint, callOptions);
}

/** Cheap bootstrap: a public HTML page gives us csrftoken / mid / ig_did. */
async function bootstrapCookies(username, fixedProxy) {
  try {
    const options = { html: true, headers: buildCrawlerHeaders() };
    if (fixedProxy !== undefined) options.fixedProxy = fixedProxy;
    const { headers, body } = await igGet(`/${encodeURIComponent(username)}/`, options);
    const jar = {};
    for (const line of headers["set-cookie"] ?? []) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    return {
      jar: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") || null,
      csrf: jar.csrftoken ?? null,
      // Reuse the same page: its og:description holds the posts count.
      ogDescription: extractOgDescription(body),
    };
  } catch {
    return { jar: null, csrf: null, ogDescription: null };
  }
}

const bootstrapCache = new Map();
const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;

async function getBootstrapCookies(username, fixedProxy) {
  const cached = bootstrapCache.get(username);
  if (cached && Date.now() - cached.at < BOOTSTRAP_TTL_MS) return cached.value;
  const value = await bootstrapCookies(username, fixedProxy);
  bootstrapCache.set(username, { at: Date.now(), value });
  return value;
}

async function fetchAnonGrid(username, cursor, session, options = {}) {
  const first = !cursor;
  const docId = first
    ? process.env.IG_GQL_GRID_DOC_ID?.trim() || DEFAULT_GRID_DOC_ID
    : process.env.IG_GQL_GRID_PAGE_DOC_ID?.trim() || DEFAULT_GRID_PAGE_DOC_ID;
  const friendly = first
    ? "PolarisLoggedOutDesktopWWWProfilePostsTabContentQuery"
    : "PolarisLoggedOutDesktopWWWProfilePostsTabContentQuery_connection";

  const variables = first
    ? { first: Math.min(options.limit ?? 12, 12), username }
    : { after: cursor, first: Math.min(options.limit ?? 12, 12), id: options.userId };

  let cookies = options.cookies ?? null;
  if (!cookies && process.env.IG_GQL_BOOTSTRAP !== "0") {
    cookies = await getBootstrapCookies(username, options.fixedProxy);
  }

  return await graphqlApiCall({
    docId, friendly, variables, username, session,
    fixedProxy: options.fixedProxy, cookies,
  });
}

/** Per-post detail (likes / comments / taken_at / media URLs), anonymous too. */
async function fetchPostDetail(shortcode, session, options = {}) {
  const docId = process.env.IG_GQL_POST_DETAIL_DOC_ID?.trim() || DEFAULT_POST_DETAIL_DOC_ID;
  const cookies =
    options.cookies ??
    (await getBootstrapCookies(options.username ?? "", options.fixedProxy));
  const { data } = await graphqlApiCall({
    docId,
    friendly: "PolarisPostRootQuery",
    variables: {
      shortcode,
      "__relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider": false,
    },
    username: options.username ?? "",
    session,
    referer: `https://www.instagram.com/p/${shortcode}/`,
    fixedProxy: options.fixedProxy,
    cookies,
  });
  return data?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * Logged-out profile metadata.
 *
 * Verified anonymously: doc_id 27981003384861049 with { username } returns
 * exact follower_count / following_count, full_name, biography, is_private,
 * is_verified, profile_pic_url, bio_links, pk and id.
 * ------------------------------------------------------------------ */

const DEFAULT_PROFILE_DOC_ID = "27981003384861049";

async function fetchProfileInfo(username, session, options = {}) {
  const docId = process.env.IG_GQL_PROFILE_DOC_ID?.trim() || DEFAULT_PROFILE_DOC_ID;
  const cookies =
    options.cookies ??
    (await getBootstrapCookies(username, options.fixedProxy));
  const { data, body } = await graphqlApiCall({
    docId,
    friendly: "PolarisLoggedOutDesktopWWWProfileRootContentQuery",
    variables: { username },
    username,
    session,
    fixedProxy: options.fixedProxy,
    cookies,
  });
  const user =
    data?.data?.xig_user_by_username ??
    data?.data?.user ??
    null;
  if (!user) {
    throw new InstagramError(
      "IG_UNEXPECTED_RESPONSE",
      "Logged-out profile query returned no user.",
      502,
      body.slice(0, 300)
    );
  }
  return { user, ogDescription: cookies?.ogDescription ?? null, cookies };
}

/** Find the posts connection in either the legacy or the GraphQL shape. */
function findTimeline(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 9) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findTimeline(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(node.edges)) return node;
  for (const key of Object.keys(node)) {
    const found = findTimeline(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function extractTimeline(data) {
  const root = data?.data ?? data;
  const explicit = [
    root?.xig_user_by_username?.polaris_ordered_timeline_connection,
    root?.xdt_api__v1__feed__user_timeline_graphql_connection,
    root?.user?.xdt_api__v1__feed__user_timeline_graphql_connection,
    root?.user?.edge_owner_to_timeline_media,
    root?.xdt_api__v1__users__web__profile__info?.user?.edge_owner_to_timeline_media,
  ].find((candidate) => candidate && Array.isArray(candidate.edges));
  return explicit ?? findTimeline(data);
}

/** The logged-out grid needs the user id to request page 2+. */
function extractGridUserId(data) {
  const root = data?.data ?? data;
  return root?.xig_user_by_username?.id ?? root?.xig_user_by_username?.pk ?? null;
}

function findUser(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findUser(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (
    typeof node.username === "string" &&
    (node.follower_count !== undefined || node.edge_followed_by || node.media_count !== undefined)
  ) {
    return node;
  }
  for (const key of Object.keys(node)) {
    const found = findUser(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Identity: resolve which Instagram account a session belongs to.
 * Used at startup so the banner can show "@your_account".
 * ------------------------------------------------------------------ */

function currentUserTargets(session) {
  const targets = [
    { base: "https://www.instagram.com", path: "/api/v1/accounts/current_user/?edit=false" },
    { base: "https://i.instagram.com", path: "/api/v1/accounts/current_user/?edit=false" },
  ];
  // Last resort: ds_user_id is already in the cookies, and the mobile users
  // endpoint resolves an id to a username without needing current_user.
  if (session?.userId) {
    targets.push({
      base: "https://i.instagram.com",
      path: `/api/v1/users/${encodeURIComponent(session.userId)}/info/`,
    });
  }
  return targets;
}

async function fetchCurrentUser(session) {
  let lastError = null;
  for (const target of currentUserTargets(session)) {
    try {
      const { data } = await igGet(target.path, { session, base: target.base });
      const user = data?.user ?? data?.data?.user ?? null;
      if (user?.username) {
        return {
          username: user.username,
          fullName: user.full_name ?? null,
          pk: user.pk ?? null,
        };
      }
      lastError = new InstagramError(
        "IG_UNEXPECTED_RESPONSE",
        "current_user returned no account.",
        502
      );
    } catch (err) {
      lastError = err;
    }
  }
  throw (
    lastError ??
    new InstagramError("IG_UNEXPECTED_RESPONSE", "Could not resolve the session account.", 502)
  );
}

module.exports = {
  getProfileStats,
  fetchProfileHtml,
  fetchWebProfileInfo,
  fetchGraphqlPosts,
  fetchAnonGrid,
  fetchPostDetail,
  fetchProfileInfo,
  bootstrapCookies,
  getBootstrapCookies,
  extractTimeline,
  extractGridUserId,
  findUser,
  fetchCurrentUser,
  igGet,
  igPost,
};
