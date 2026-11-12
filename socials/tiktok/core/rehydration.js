"use strict";

/**
 * TikTok server-renders a JSON blob into profile and video pages. This is the
 * anonymous equivalent of Instagram's logged-out grid: no session, no proxy,
 * no signature required.
 */
const UNIVERSAL_RE =
  /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">([\s\S]*?)<\/script>/;
const SIGI_RE = /<script id="SIGI_STATE" type="application\/json">([\s\S]*?)<\/script>/;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractScope(html) {
  const universal = UNIVERSAL_RE.exec(String(html ?? ""));
  if (universal) {
    const parsed = parseJson(universal[1]);
    if (parsed?.["__DEFAULT_SCOPE__"]) return parsed["__DEFAULT_SCOPE__"];
  }
  const sigi = SIGI_RE.exec(String(html ?? ""));
  if (sigi) {
    const parsed = parseJson(sigi[1]);
    if (parsed) return parsed;
  }
  return null;
}

function extractUserDetail(html) {
  const scope = extractScope(html);
  return scope?.["webapp.user-detail"] ?? scope?.UserModule ?? null;
}

function extractVideoDetail(html) {
  const scope = extractScope(html);
  return scope?.["webapp.video-detail"] ?? scope?.ItemModule ?? null;
}

/** Pull the anonymous msToken / ttwid cookies TikTok sets on the profile page. */
function extractBootstrapCookies(setCookies) {
  const jar = {};
  for (const pair of String(setCookies ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return {
    msToken: jar.msToken ?? null,
    ttwid: jar.ttwid ?? null,
    jar: Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ") || null,
  };
}

module.exports = {
  extractScope,
  extractUserDetail,
  extractVideoDetail,
  extractBootstrapCookies,
  parseJson,
};
