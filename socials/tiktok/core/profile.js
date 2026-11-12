"use strict";

const { get } = require("./http");
const { extractUserDetail, extractBootstrapCookies } = require("./rehydration");
const { normalizeProfile } = require("./normalize");
const { ConnectorError } = require("./errors");

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

async function getProfile(username, options = {}) {
  const key = `${options.session ? "auth" : "anon"}:${username}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value };

  const { body, setCookies } = await get(
    `https://www.tiktok.com/@${encodeURIComponent(username)}`,
    { ...(options.fixedProxy !== undefined ? { fixedProxy: options.fixedProxy } : {}),
      session: options.session ?? null }
  );

  const detail = extractUserDetail(body);
  if (!detail || detail.statusCode !== 0 || !detail.userInfo?.user) {
    if (detail?.statusCode === 10222 || detail?.statusCode === 10204) {
      throw new ConnectorError("TT_USER_NOT_FOUND", `@${username} does not exist.`, 404);
    }
    throw new ConnectorError(
      "TT_UNEXPECTED_RESPONSE",
      "Profile page contained no user detail (TikTok may have changed its SSR payload).",
      502,
      { statusCode: detail?.statusCode ?? null, statusMsg: detail?.statusMsg ?? null }
    );
  }

  const info = detail.userInfo;
  if (info.user.privateAccount && !options.session) {
    throw new ConnectorError("TT_PRIVATE_PROFILE", `@${username} is a private account.`, 403);
  }

  const value = {
    profile: normalizeProfile(info, username),
    secUid: info.user.secUid ?? null,
    bootstrap: extractBootstrapCookies(setCookies),
    itemList: info.itemList ?? [],
  };
  cache.set(key, { at: Date.now(), value });
  return { ...value };
}

module.exports = { getProfile };
