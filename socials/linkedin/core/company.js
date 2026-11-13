"use strict";

const { company: fetchCompany } = require("./sources");
const { normalizeCompany, normalizePost } = require("./normalize");
const { log } = require("./logger");

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

async function getCompany(slug, options = {}) {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };
  const raw = await fetchCompany(slug, options);
  const value = normalizeCompany(raw.slug, raw.seo, raw.org, raw.postings);
  cache.set(slug, { at: Date.now(), value });
  return { ...value, cached: false };
}

module.exports = { getCompany };
