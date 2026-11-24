"use strict";

const { ConnectorError } = require("./session");

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE_RE = /^@?([A-Za-z0-9._-]{1,60})$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function parseHandleInput(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new ConnectorError("YT_BAD_REQUEST", "Channel handle or UC channel ID is required.", 400);
  }
  if (CHANNEL_ID_RE.test(trimmed)) {
    return {
      kind: "channelId",
      channelId: trimmed,
      handle: null,
      username: trimmed,
      urlPath: `/channel/${trimmed}`,
    };
  }
  const match = HANDLE_RE.exec(trimmed);
  if (!match) {
    throw new ConnectorError(
      "YT_BAD_REQUEST",
      "Invalid YouTube handle or channel ID (expected @handle, handle, or UC... ID).",
      400
    );
  }
  const username = match[1];
  const handle = `@${username}`;
  return {
    kind: "handle",
    channelId: null,
    handle,
    username,
    urlPath: `/${handle}`,
  };
}

function parseVideoId(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!VIDEO_ID_RE.test(trimmed)) {
    throw new ConnectorError("YT_BAD_REQUEST", "Invalid 11-character YouTube video ID.", 400);
  }
  return trimmed;
}

function parseLimit(raw, defaultLimit = 12, maxLimit = 100) {
  if (raw === null || raw === undefined || raw === "") return defaultLimit;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new ConnectorError("YT_BAD_REQUEST", "?limit must be a positive integer.", 400);
  }
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) {
    throw new ConnectorError("YT_BAD_REQUEST", "?limit must be an integer >= 1.", 400);
  }
  return Math.min(n, maxLimit);
}

function parseSearchQuery(raw) {
  const q = String(raw ?? "").trim();
  if (!q) {
    throw new ConnectorError("YT_BAD_REQUEST", "Search query parameter ?q= is required.", 400);
  }
  if (q.length > 200) {
    throw new ConnectorError("YT_BAD_REQUEST", "Search query ?q= is too long (max 200 chars).", 400);
  }
  return q;
}

function parseLang(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return { lang: "en", explicit: false };
  }
  const trimmed = String(raw).trim();
  if (!LANG_RE.test(trimmed)) {
    throw new ConnectorError("YT_BAD_REQUEST", "Invalid ?lang= BCP-47 language tag.", 400);
  }
  return { lang: trimmed, explicit: true };
}

/**
 * Scan from startIndex to extract the first balanced `{ ... }` JSON object,
 * safely ignoring `{`, `}`, `\"` and `\\` inside JSON string literals.
 */
function extractBalancedJson(source, startIndex = 0) {
  const text = String(source ?? "");
  const openIdx = text.indexOf("{", startIndex);
  if (openIdx === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(openIdx, i + 1);
        try {
          return { parsed: JSON.parse(slice), startIndex: openIdx, endIndex: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function extractNamedObject(html, names) {
  const text = String(html ?? "");
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`(?:var|let|const)\\s+${escapedName}\\s*=\\s*`, "g"),
      new RegExp(`window\\[["']${escapedName}["']\\]\\s*=\\s*`, "g"),
      new RegExp(`\\b${escapedName}\\s*=\\s*`, "g"),
    ];
    for (const re of patterns) {
      let match;
      while ((match = re.exec(text)) !== null) {
        const afterEq = match.index + match[0].length;
        // Skip if non-whitespace before `{` isn't a JSON object start
        const rest = text.slice(afterEq, afterEq + 32).trimStart();
        if (!rest.startsWith("{")) continue;
        const found = extractBalancedJson(text, afterEq);
        if (found) return found.parsed;
      }
    }
  }
  return null;
}

function extractYtInitialData(html) {
  return extractNamedObject(html, ["ytInitialData"]);
}

function extractYtInitialPlayerResponse(html) {
  return extractNamedObject(html, ["ytInitialPlayerResponse"]);
}

function extractYtCfg(html) {
  const text = String(html ?? "");
  const re = /ytcfg\.set\(\s*/g;
  let match;
  const merged = {};
  let foundAny = false;
  while ((match = re.exec(text)) !== null) {
    const res = extractBalancedJson(text, match.index + match[0].length);
    if (res && res.parsed && typeof res.parsed === "object") {
      Object.assign(merged, res.parsed);
      foundAny = true;
    }
  }
  return foundAny ? merged : null;
}

function isConsentPage(html, finalUrl = "") {
  if (/consent\.youtube\.com/i.test(String(finalUrl))) return true;
  const text = String(html ?? "");
  if (/action="https:\/\/consent\.youtube\.com/i.test(text) && !text.includes("ytInitialData")) {
    return true;
  }
  return false;
}

/** Extract readable text from YouTube simpleText, runs, or attributedString content. */
function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (typeof node.simpleText === "string") return node.simpleText;
  if (typeof node.content === "string") return node.content;
  if (Array.isArray(node.runs)) {
    return node.runs.map((r) => r?.text ?? "").join("");
  }
  return "";
}

/**
 * Parse YouTube count strings ("19.8M subscribers", "1,234,567 views", "412K", "No views")
 * into integers, or null when unparseable.
 */
function parseCountText(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw) : null;
  const text = textOf(raw).replace(/\u00a0/g, " ").trim();
  if (!text) return null;
  if (/^no\s+(views|subscribers|videos|comments)/i.test(text)) return 0;

  // Match e.g. "19.8M", "1,234,567", "412K" inside strings like "like along with 142,891 other people"
  const match = /([\d,]+(?:\.\d+)?)\s*([KMB])\b/i.exec(text) || /([\d,]+(?:\.\d+)?)/.exec(text);
  if (!match) return null;

  const num = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(num)) return null;
  const mult = match[2]
    ? { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[match[2].toUpperCase()] ?? 1
    : 1;
  return Math.round(num * mult);
}

/** Parse "14:28", "1:02:05", "PT12M34S", or integer seconds into total seconds. */
function parseDurationSeconds(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : null;
  const text = textOf(raw).trim();
  if (!text || /^shorts$|^live$|^upcoming$/i.test(text)) return null;
  if (/^\d+$/.test(text)) return Number(text);

  const colon = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(text);
  if (colon) {
    if (colon[3] !== undefined) {
      return Number(colon[1]) * 3600 + Number(colon[2]) * 60 + Number(colon[3]);
    }
    return Number(colon[1]) * 60 + Number(colon[2]);
  }

  const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(text);
  if (iso && (iso[1] || iso[2] || iso[3])) {
    return Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0);
  }
  return null;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const s = Math.trunc(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  }
  return `${m}:${String(rem).padStart(2, "0")}`;
}

function parseDateValue(raw, nowMs = Date.now()) {
  const text = textOf(raw).trim();
  if (!text) return null;

  // Relative YouTube strings: "2 days ago", "Streamed 3 weeks ago", "Premiered 5 hours ago"
  const rel = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const multMs = {
      second: 1000,
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 7 * 86_400_000,
      month: 30 * 86_400_000,
      year: 365 * 86_400_000,
    }[unit];
    if (multMs) return new Date(nowMs - n * multMs).toISOString();
  }

  const cleaned = text.replace(/^(?:Premiered|Streamed live on|Published on)\s+/i, "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    const d = new Date(`${cleaned}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const parsed = new Date(cleaned);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Unicode-safe hashtags (#tech, #東京...), deduplicated, in text order. */
function extractHashtags(text) {
  if (!text) return [];
  const found = String(text).match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(found)];
}

/** @mentions, deduplicated. */
function extractMentions(text) {
  if (!text) return [];
  const found = String(text).match(/(?:^|[\s(])(@[A-Za-z0-9._-]{1,30})/g) ?? [];
  return [...new Set(found.map((m) => m.trim().replace(/^\(/, "")))];
}

/** Unwrap YouTube's /redirect?q=https%3A%2F%2F... wrapper URLs. */
function unwrapRedirectUrl(rawUrl) {
  if (!rawUrl) return null;
  let str = String(rawUrl).trim();
  if (str.startsWith("//")) str = `https:${str}`;
  else if (str.startsWith("/")) str = `https://www.youtube.com${str}`;
  try {
    const u = new URL(str);
    if (/youtube\.com$/i.test(u.hostname) && u.pathname === "/redirect") {
      const target = u.searchParams.get("q");
      if (target) return target;
    }
    return u.toString();
  } catch {
    return str;
  }
}

/**
 * Parse video chapters from description timestamps (e.g. `0:00 Intro`, `01:25 - Design`,
 * `[12:40] Camera Test`). Requires at least 2 timestamps so stray numbers aren't misread.
 */
function parseChaptersFromDescription(description, durationSeconds = null) {
  if (!description) return [];
  const lines = String(description).split(/\r?\n/);
  const rawChapters = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // Timestamp at beginning: "0:00 Intro", "[01:25] - Hardware", "- 12:40 Camera"
    // or at end: "Intro 0:00", "Hardware - 01:25"
    let ts = null;
    let title = null;

    const lead = /^(?:[-•*]\s*)?\[?(\d{1,2}:[0-5]\d(?::[0-5]\d)?)\]?(?:\s*[-–—:|)]+\s*|\s+)(.+)$/.exec(line);
    if (lead) {
      ts = lead[1];
      title = lead[2].trim();
    } else {
      const trail = /^(.+?)(?:\s*[-–—:|(\[]+\s*|\s+)(\d{1,2}:[0-5]\d(?::[0-5]\d)?)\]?$/.exec(line);
      if (trail) {
        title = trail[1].trim();
        ts = trail[2];
      }
    }

    if (ts && title) {
      const startSeconds = parseDurationSeconds(ts);
      if (startSeconds !== null) {
        rawChapters.push({
          title: title.replace(/^[-–—:|]+\s*|\s*[-–—:|]+$/g, "").trim(),
          timestamp: ts,
          startSeconds,
          startMs: startSeconds * 1000,
        });
      }
    }
  }

  if (rawChapters.length < 2) return [];
  // Ensure strictly non-decreasing timestamps
  const sorted = [];
  for (const ch of rawChapters) {
    if (!ch.title) continue;
    if (sorted.length && ch.startSeconds < sorted[sorted.length - 1].startSeconds) continue;
    if (sorted.length && ch.startSeconds === sorted[sorted.length - 1].startSeconds) continue;
    sorted.push(ch);
  }
  if (sorted.length < 2) return [];

  return sorted.map((ch, idx) => {
    const nextStart = sorted[idx + 1]?.startSeconds ?? (
      durationSeconds && durationSeconds > ch.startSeconds ? durationSeconds : null
    );
    return {
      title: ch.title,
      timestamp: ch.timestamp,
      startSeconds: ch.startSeconds,
      startMs: ch.startMs,
      endSeconds: nextStart,
    };
  });
}

function decodeOnce(text) {
  return String(text)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/** YouTube XML captions frequently double-encode entities (e.g. `&amp;#39;`). */
function decodeXmlEntities(text) {
  return decodeOnce(decodeOnce(text));
}

function cleanCaptionText(raw) {
  return decodeXmlEntities(String(raw ?? "").replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse YouTube `fmt=json3` transcript events into `{ text, startMs, durationMs }`. */
function parseTranscriptJson3(input) {
  let data = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch {
      return [];
    }
  }
  const events = Array.isArray(data?.events) ? data.events : [];
  const segments = [];

  for (const ev of events) {
    if (!Array.isArray(ev?.segs)) continue;
    const rawText = ev.segs.map((s) => s?.utf8 ?? "").join("");
    const text = cleanCaptionText(rawText);
    if (!text) continue;
    const startMs = Math.max(0, Math.round(Number(ev.tStartMs ?? 0)));
    const durationMs = Math.max(0, Math.round(Number(ev.dDurationMs ?? 0)));
    segments.push({ text, startMs, durationMs });
  }
  return segments;
}

/**
 * Parse YouTube TimedText XML (`<text start="1.24" dur="3.5">...</text>` or
 * srv3 `<p t="1240" d="3500"><s>...</s></p>`) into `{ text, startMs, durationMs }`.
 */
function parseTranscriptXml(xml) {
  const source = String(xml ?? "");
  if (!source.trim()) return [];
  const segments = [];

  const textTagRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match;
  while ((match = textTagRe.exec(source)) !== null) {
    const attrs = match[1];
    const text = cleanCaptionText(match[2]);
    if (!text) continue;
    const startMatch = /\bstart=["']([\d.]+)["']/i.exec(attrs);
    const durMatch = /\bdur=["']([\d.]+)["']/i.exec(attrs);
    const startMs = startMatch ? Math.max(0, Math.round(Number(startMatch[1]) * 1000)) : 0;
    const durationMs = durMatch ? Math.max(0, Math.round(Number(durMatch[1]) * 1000)) : 0;
    segments.push({ text, startMs, durationMs });
  }
  if (segments.length > 0) return segments;

  // Fallback for srv3 format (<p t="1240" d="3500">...)
  const pTagRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  while ((match = pTagRe.exec(source)) !== null) {
    const attrs = match[1];
    const text = cleanCaptionText(match[2]);
    if (!text) continue;
    const tMatch = /\bt=["'](\d+)["']/i.exec(attrs);
    const dMatch = /\bd=["'](\d+)["']/i.exec(attrs);
    const startMs = tMatch ? Number(tMatch[1]) : 0;
    const durationMs = dMatch ? Number(dMatch[1]) : 0;
    segments.push({ text, startMs, durationMs });
  }
  return segments;
}

module.exports = {
  CHANNEL_ID_RE,
  HANDLE_RE,
  VIDEO_ID_RE,
  parseHandleInput,
  parseVideoId,
  parseLimit,
  parseSearchQuery,
  parseLang,
  extractBalancedJson,
  extractNamedObject,
  extractYtInitialData,
  extractYtInitialPlayerResponse,
  extractYtCfg,
  isConsentPage,
  textOf,
  parseCountText,
  parseDurationSeconds,
  formatDuration,
  parseDateValue,
  extractHashtags,
  extractMentions,
  unwrapRedirectUrl,
  parseChaptersFromDescription,
  decodeXmlEntities,
  parseTranscriptJson3,
  parseTranscriptXml,
};
