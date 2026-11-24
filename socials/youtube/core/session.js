"use strict";

/**
 * YouTube session, consent cookies, browser headers, and typed connector errors.
 *
 * Public channels, videos, search, and transcripts work 100% keylessly with
 * zero Google API key and zero session cookie. Every request carries EU
 * consent bypass cookies (SOCS + CONSENT) so European exit IPs never get stuck
 * on consent.youtube.com.
 */

const EU_CONSENT_COOKIES =
  "SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgJnPpwY; " +
  "CONSENT=YES+cb.20210328-17-p0.en+FX+410";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ANDROID_USER_AGENT =
  "com.google.android.youtube/19.44.38 (Linux; U; Android 14; en_US) gzip";

const IOS_USER_AGENT =
  "com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1 like Mac OS X;)";

const HINTS = {
  YT_BAD_REQUEST: "Check the handle (@handle or UC... channel ID), 11-char video ID, or query parameters.",
  YT_CHANNEL_NOT_FOUND: "Check the channel handle (@handle) or UC... channel ID.",
  YT_VIDEO_NOT_FOUND: "Check the 11-character video ID; the video may be private, deleted, or unavailable.",
  YT_NO_TRANSCRIPT: "This video has no public captions or transcripts in the requested language.",
  YT_RATE_LIMITED:
    "YouTube is throttling or challenging this IP. Increase YT_MIN_INTERVAL_MS or route through YT_PROXIES.",
  YT_CONSENT_GATE:
    "YouTube served a consent interstitial despite bypass cookies. Check YT_CONSENT_COOKIES or proxy exit country.",
  YT_ALL_STRATEGIES_FAILED:
    "Every configured YouTube strategy failed. Run /v1/diagnostics?handle=@mkbhd to inspect each source.",
  YT_UNEXPECTED_RESPONSE:
    "YouTube returned an unexpected renderer layout. Run /v1/diagnostics and check YT_STRATEGIES.",
  YT_NETWORK_ERROR: "Network call to YouTube failed. Check connectivity or YT_PROXY_* configuration.",
  YT_HTTP_ERROR: "YouTube returned an unexpected HTTP status.",
  YT_UPSTREAM_ERROR: "YouTube returned a 5xx upstream error; retry shortly.",
  YT_PROXY_CONFIG_ERROR: "Fix the YT_PROXY_* values in .env (user:pass@host:port).",
};

class ConnectorError extends Error {
  constructor(code, message, status = 502, details = null) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.hint = HINTS[code] ?? null;
  }
}

function readSession() {
  const raw = process.env.YT_SESSIONID?.trim();
  if (!raw) return null;
  return { cookie: raw };
}

function consentCookies() {
  return process.env.YT_CONSENT_COOKIES?.trim() || EU_CONSENT_COOKIES;
}

function buildCookieHeader(session = null) {
  const parts = [consentCookies(), "PREF=hl=en&gl=US"];
  if (session?.cookie) {
    parts.push(session.cookie.includes("=") ? session.cookie : `SAPISID=${session.cookie}`);
  }
  return parts.join("; ");
}

function buildBrowserHeaders(session = null, { json = false, referer = "https://www.youtube.com/", clientType = "WEB", clientVersion = null } = {}) {
  const hl = process.env.YT_HL?.trim() || "en";
  const version = clientVersion || process.env.YT_CLIENT_VERSION?.trim() || "2.20241114.01.00";

  if (clientType === "ANDROID") {
    return {
      "User-Agent": ANDROID_USER_AGENT,
      "Accept-Language": `${hl}-US,${hl};q=0.9`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-YouTube-Client-Name": "3",
      "X-YouTube-Client-Version": "19.44.38",
      "X-Goog-Api-Format-Version": "2",
      Cookie: buildCookieHeader(session),
    };
  }

  if (clientType === "IOS") {
    return {
      "User-Agent": IOS_USER_AGENT,
      "Accept-Language": `${hl}-US,${hl};q=0.9`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-YouTube-Client-Name": "5",
      "X-YouTube-Client-Version": "19.45.4",
      "X-Goog-Api-Format-Version": "2",
      Cookie: buildCookieHeader(session),
    };
  }

  const headers = {
    "User-Agent": process.env.YT_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    "Accept-Language": `${hl}-US,${hl};q=0.9`,
    Cookie: buildCookieHeader(session),
    Referer: referer,
  };

  if (json) {
    headers.Accept = "application/json, text/plain, */*";
    headers["Content-Type"] = "application/json";
    headers.Origin = "https://www.youtube.com";
    headers["X-YouTube-Client-Name"] = "1";
    headers["X-YouTube-Client-Version"] = version;
    headers["Sec-Fetch-Site"] = "same-origin";
    headers["Sec-Fetch-Mode"] = "same-origin";
    headers["Sec-Fetch-Dest"] = "empty";
  } else {
    headers.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    headers["Sec-Fetch-Site"] = "none";
    headers["Sec-Fetch-Mode"] = "navigate";
    headers["Sec-Fetch-Dest"] = "document";
    headers["Upgrade-Insecure-Requests"] = "1";
  }

  return headers;
}

async function verifySession(session) {
  if (!session) {
    return { status: "anonymous", verified: false, username: null, error: null };
  }
  return {
    status: "configured",
    verified: false,
    username: null,
    error: null,
  };
}

module.exports = {
  EU_CONSENT_COOKIES,
  DEFAULT_USER_AGENT,
  ANDROID_USER_AGENT,
  IOS_USER_AGENT,
  HINTS,
  ConnectorError,
  YouTubeError: ConnectorError,
  readSession,
  consentCookies,
  buildCookieHeader,
  buildBrowserHeaders,
  verifySession,
};
