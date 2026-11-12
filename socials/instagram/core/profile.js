"use strict";

/**
 * Unified profile resolver.
 *
 * The logged-out posts grid only returns pk + id, so /posts used to ship a
 * profile object full of nulls. Instagram's logged-out profile query
 * (doc_id 27981003384861049) returns exact counts and metadata anonymously;
 * og:description from the bootstrap page fills the remaining posts count.
 * Falling back to getProfileStats() keeps the old behaviour if that query is
 * retired.
 */

const { fetchProfileInfo, getProfileStats } = require("./fetch");
const { normalizeProfile } = require("./normalize");
const { parseOgDescription } = require("./parsing");
const { log } = require("./logger");

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

function fillMissing(target, source, keys) {
  for (const key of keys) {
    if ((target[key] === null || target[key] === undefined) && source[key] !== null && source[key] !== undefined) {
      target[key] = source[key];
    }
  }
}

async function getProfile(username, session = null, options = {}) {
  // Private profiles resolve differently with a session: keep both variants.
  const key = `${session ? "auth" : "anon"}:${username}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ...cached.value };
  }

  let profile = normalizeProfile(null, username);
  profile.source = "unresolved";

  // 1. Logged-out GraphQL profile query: exact counts + rich metadata.
  try {
    const { user, ogDescription } = await fetchProfileInfo(username, session, {
      fixedProxy: options.fixedProxy,
    });
    profile = normalizeProfile(user, username);
    profile.source = "anon_user_info";
    const stats = parseOgDescription(ogDescription);
    if (stats) {
      fillMissing(profile, stats, ["followers", "following", "posts"]);
    }
  } catch (err) {
    log.warn(`profile query failed (${err.code ?? "UNKNOWN"}); falling back to profile stats`);
  }

  // 2. Legacy fallback (web_profile_info with a session, else og:description).
  if (
    profile.followers === null ||
    profile.following === null ||
    profile.posts === null
  ) {
    try {
      const fallback = await getProfileStats(username, session);
      fillMissing(profile, fallback, ["followers", "following", "posts"]);
      if (profile.source === "unresolved") profile.source = fallback.source;
    } catch (err) {
      log.warn(`profile stats fallback failed (${err.code ?? "UNKNOWN"})`);
    }
  }

  cache.set(key, { at: Date.now(), value: profile });
  return { ...profile };
}

module.exports = { getProfile };
