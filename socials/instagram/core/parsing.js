"use strict";

function parseCount(raw) {
  const match = String(raw).trim().match(/^([\d.,]+)\s*([KMB])?$/i);
  if (!match) return null;

  const n = Number(match[1].replace(/,/g, ""));
  if (Number.isNaN(n)) return null;

  const mult = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[match[2]?.toUpperCase()] ?? 1;
  return Math.round(n * mult);
}

/** Parse "399K Followers, 374 Following, 34 Posts - See Instagram photos...". */
function parseOgDescription(desc) {
  if (!desc) return null;

  const match = desc.match(
    /([\d.,]+\s*[KMB]?)\s+Followers?,\s+([\d.,]+\s*[KMB]?)\s+Following,\s+([\d.,]+\s*[KMB]?)\s+Posts?/i
  );
  if (!match) return null;
  return {
    followers: parseCount(match[1]),
    following: parseCount(match[2]),
    posts: parseCount(match[3]),
  };
}

/** Unicode-safe hashtags (#cafe, #東京...), deduplicated, in text order. */
function extractHashtags(text) {
  if (!text) return [];
  const found = String(text).match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(found)];
}

/** @mentions, deduplicated. */
function extractMentions(text) {
  if (!text) return [];
  const found = String(text).match(/@[A-Za-z0-9._]{1,30}/g) ?? [];
  return [...new Set(found)];
}

/**
 * The logged-out grid omits taken_at but puts a readable date in the
 * accessibility caption: "Photo by Kameto on September 24, 2026."
 */
function parseDateFromAltText(text) {
  const match = /on ([A-Z][a-z]+ \d{1,2}, \d{4})/i.exec(String(text ?? ""));
  if (!match) return null;
  const parsed = new Date(`${match[1]} 00:00:00 GMT`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

module.exports = {
  parseOgDescription,
  extractHashtags,
  extractMentions,
  parseDateFromAltText,
};
