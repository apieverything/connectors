"use strict";

const { searchJobs } = require("./strategies");
const { jobDetail } = require("./sources");
const { normalizeJob } = require("./normalize");
const { decodeEntities } = require("./parsing");
const { ConnectorError } = require("./errors");
const { log } = require("./logger");

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function parseLimit(raw) {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ConnectorError("LI_BAD_REQUEST", "?limit must be an integer >= 1.", 400);
  }
  return Math.min(n, MAX_LIMIT);
}

function cleanQuery(raw) {
  const keywords = String(raw?.keywords ?? "").trim().slice(0, 120) || null;
  const location = String(raw?.location ?? "").trim().slice(0, 120) || null;
  const start = Math.max(0, Number(raw?.start ?? 0) || 0);
  if (!keywords && !location) {
    throw new ConnectorError(
      "LI_BAD_REQUEST",
      "Provide ?keywords= and/or ?location= (a fully open crawl is intentionally not supported).",
      400
    );
  }
  return { keywords, location, start };
}

async function search(query, { limit = DEFAULT_LIMIT } = {}, options = {}) {
  const key = JSON.stringify({ query, limit });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };

  const collected = [];
  const seen = new Set();
  let strategy = null;
  let failures = [];
  let start = query.start;
  let pages = 0;
  const maxPages = Math.max(1, Number(process.env.LI_MAX_PAGES ?? 5));

  while (collected.length < limit && pages < maxPages) {
    let result;
    try {
      result = await searchJobs({ ...query, start }, options);
    } catch (err) {
      if (!collected.length) throw err;
      break;
    }
    strategy = result.strategy;
    failures = result.failures;
    let added = 0;
    for (const card of result.cards) {
      const id = card.id ?? card.url ?? card.title;
      if (seen.has(id)) continue;
      seen.add(id);
      collected.push(normalizeJob(card));
      added += 1;
      if (collected.length >= limit) break;
    }
    pages += 1;
    if (!added) break;
    start += result.cards.length;
  }

  const value = {
    query,
    count: collected.length,
    jobs: collected.slice(0, limit),
    nextStart: collected.length >= limit ? start : null,
    hasMore: collected.length >= limit,
    strategy,
    failures,
  };
  cache.set(key, { at: Date.now(), value });
  return { ...value, cached: false };
}

async function detail(idOrUrl, options = {}) {
  const raw = await jobDetail(idOrUrl, options);
  const posting = raw.posting;
  const criteria = raw.criteria ?? {};
  const card = {
    id: raw.id,
    url: raw.url,
    title: decodeEntities(raw.title ?? ""),
    company: posting?.hiringOrganization?.name ?? "",
    location: posting?.jobLocation?.address?.addressLocality ?? "",
    date: posting?.datePosted ?? null,
    description: raw.description ?? null,
    criteria,
    source: "job_posting_ld",
  };
  return normalizeJob(card, posting);
}

module.exports = { search, detail, parseLimit, cleanQuery, DEFAULT_LIMIT, MAX_LIMIT };
