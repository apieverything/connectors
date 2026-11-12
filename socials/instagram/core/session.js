"use strict";

/**
 * Instagram session handling.
 *
 * Profile stats are available anonymously through the og:description meta tag,
 * but posts are only served by Instagram's internal web API to an
 * authenticated client. Every self-hosted instance supplies its own cookie
 * through environment variables: no central server, no shared quota, no cost.
 */

const IG_APP_ID = "936619743392459";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HINTS = {
  IG_SESSION_MISSING:
    "Set IG_SESSIONID in your .env (see README > Getting the session cookie).",
  IG_SESSION_EXPIRED:
    "The cookie expired or Instagram requested a verification. Sign in again in your browser and replace IG_SESSIONID.",
  IG_CHECKPOINT:
    "Instagram raised a checkpoint on this account. Clear it in the browser, then retry.",
  IG_RATE_LIMITED:
    "Instagram is throttling this IP. Increase IG_MIN_INTERVAL_MS, lower IG_MAX_PAGES, or route through a residential proxy.",
  IG_PRIVATE_PROFILE:
    "This profile is private. Only an account that follows it can read its posts.",
  IG_UNEXPECTED_RESPONSE:
    "Unexpected Instagram response: the web API probably changed. Check IG_SESSIONID and open an issue with the error details.",
  IG_ALL_STRATEGIES_FAILED:
    "All post sources failed. Meta may have retired the current doc_id: try /v1/diagnostics, then set IG_GQL_POSTS_DOC_ID (and/or IG_POSTS_STRATEGIES) to a current one.",
  IG_PROXY_CONFIG_ERROR:
    "Fix the IG_PROXY_* values in your .env. Proxy URLs must look like http://user:pass@host:port.",
};

class InstagramError extends Error {
  constructor(code, message, status = 502, details = null) {
    super(message);
    this.name = "InstagramError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.hint = HINTS[code] ?? null;
  }
}

/** Returns null when no session is configured (anonymous mode). */
function readSession() {
  const sessionId = process.env.IG_SESSIONID?.trim();
  if (!sessionId) return null;
  return {
    sessionId,
    csrf: process.env.IG_CSRFTOKEN?.trim() || null,
    userId: process.env.IG_DS_USER_ID?.trim() || null,
  };
}

/** Like readSession(), but fails with an explicit error when it is missing. */
function requireSession() {
  const session = readSession();
  if (!session) {
    throw new InstagramError(
      "IG_SESSION_MISSING",
      "Fetching posts requires an Instagram session (IG_SESSIONID).",
      401
    );
  }
  return session;
}

/**
 * Build request headers.
 *
 * The User-Agent must stay consistent with the browser that created the
 * cookie: replaying a session with a different UA often triggers a checkpoint.
 */
function buildHeaders(session, { html = false } = {}) {
  const headers = {
    "User-Agent": process.env.IG_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    "X-IG-App-ID": IG_APP_ID,
  };

  if (html) {
    headers.Accept = "text/html,application/xhtml+xml";
  } else {
    headers.Accept = "*/*";
    headers["X-Requested-With"] = "XMLHttpRequest";
    headers["Sec-Fetch-Site"] = "same-origin";
  }

  if (session) {
    const jar = [`sessionid=${session.sessionId}`];
    if (session.userId) jar.push(`ds_user_id=${session.userId}`);
    if (session.csrf) jar.push(`csrftoken=${session.csrf}`);
    headers.Cookie = jar.join("; ");
    if (session.csrf) headers["X-CSRFToken"] = session.csrf;
  }

  return headers;
}

/**
 * Headers for ANONYMOUS public HTML.
 *
 * Verified: with a full browser UA plus Accept-Language and X-IG-App-ID,
 * Instagram serves a variant of the page WITHOUT the og:description tag.
 * The minimal UA triggers the correct variant, so this header set is
 * intentionally kept separate from the API headers.
 */
function buildCrawlerHeaders() {
  return {
    "User-Agent": process.env.IG_CRAWLER_USER_AGENT?.trim() || "Mozilla/5.0",
  };
}

/**
 * Headers used by the web client for its internal API / GraphQL calls.
 * Missing X-ASBD-ID and Referer are a documented cause of "useragent
 * mismatch" and 429 responses even with a valid session.
 */
function buildApiHeaders(session, username, { form = false } = {}) {
  const headers = buildHeaders(session);
  headers["X-ASBD-ID"] = process.env.IG_ASBD_ID?.trim() || "198387";
  headers["X-Instagram-AJAX"] = "1";
  headers["Referer"] = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  headers["Sec-Fetch-Mode"] = "cors";
  headers["Sec-Fetch-Dest"] = "empty";
  headers.Accept = "*/*";
  if (form) {
    headers.Origin = "https://www.instagram.com";
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  return headers;
}

module.exports = {
  IG_APP_ID,
  InstagramError,
  readSession,
  requireSession,
  buildHeaders,
  buildCrawlerHeaders,
  buildApiHeaders,
};
