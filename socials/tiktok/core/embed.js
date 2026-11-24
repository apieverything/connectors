"use strict";

/**
 * Keyless post source: the public embed profile page
 * https://www.tiktok.com/embed/@<user> server-renders (Frontity state) the
 * ~10 most recent public videos. No signature, cookie or browser required.
 * Fields: id, desc, cover/play URLs, playCount. Date is derived from the
 * video id (TikTok ids are snowflakes: id >> 32 = unix seconds).
 */
const STATE_RE = /<script id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/;

function dateFromId(id) {
  try {
    const secs = Number(BigInt(id) >> 32n);
    return secs > 1.4e9 && secs < 4e9 ? secs : null;
  } catch {
    return null;
  }
}

function findVideoList(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return null;
  if (Array.isArray(node.videoList)) return node.videoList;
  for (const key of Object.keys(node)) {
    const found = findVideoList(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/** Parse embed HTML into normalizePost-compatible nodes. */
function parseEmbedProfile(html, username = null) {
  const m = STATE_RE.exec(String(html ?? ""));
  if (!m) return [];
  let state;
  try { state = JSON.parse(m[1]); } catch { return []; }
  const list = findVideoList(state) ?? [];
  return list
    .filter((v) => v && v.id && !v.privateItem)
    .map((v) => ({
      id: String(v.id),
      desc: v.desc ?? "",
      createTime: dateFromId(v.id),
      authorUniqueId: v.authorUniqueId ?? username,
      playCount: v.playCount ?? null,
      video: {
        cover: v.originCoverUrl || v.coverUrl || null,
        playAddr: v.playAddr || null,
      },
      _embed: true,
    }));
}

module.exports = { parseEmbedProfile, dateFromId };
