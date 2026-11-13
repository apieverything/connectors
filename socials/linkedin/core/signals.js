"use strict";

/**
 * Aggregated hiring signals. Returns only counts and groupings — no personal
 * data, nothing that can be traced back to an individual. This is the
 * endpoint intended for a hosted/public tier.
 */
const { search } = require("./jobs");
const { ConnectorError } = require("./errors");
const { log } = require("./logger");

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

function tally(items, keyFn, limit = 10) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

async function hiringSignals({ skill, country, window = 30, pages = 3 } = {}, options = {}) {
  if (!skill || !country) {
    throw new ConnectorError(
      "LI_BAD_REQUEST",
      "Provide ?skill= and ?country= (signals are aggregate-only by design).",
      400
    );
  }
  const windowDays = Math.min(365, Math.max(1, Number(window) || 30));
  const limit = Math.min(100, Math.max(10, Number(pages) * 10));
  const key = JSON.stringify({ skill, country, windowDays, limit });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };

  const result = await search(
    { keywords: String(skill).slice(0, 120), location: String(country).slice(0, 120), start: 0 },
    { limit },
    options
  );

  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = result.jobs.filter((job) => {
    if (!job.datePosted) return true;
    const t = Date.parse(job.datePosted);
    return Number.isFinite(t) ? t >= cutoff : true;
  });

  const value = {
    skill,
    country,
    windowDays,
    computedAt: new Date().toISOString(),
    sampleSize: result.jobs.length,
    inWindow: inWindow.length,
    byCity: tally(inWindow, (j) => j.city ?? j.location),
    byCompany: tally(inWindow, (j) => j.company),
    byDate: tally(inWindow, (j) => (j.datePosted ? String(j.datePosted).slice(0, 10) : null)),
    byCountry: tally(inWindow, (j) => j.countryCode),
    strategy: result.strategy,
    source: "jobs_guest_aggregate",
    note: "Counts only. No personal data is returned or retained.",
  };
  cache.set(key, { at: Date.now(), value });
  return { ...value, cached: false };
}

module.exports = { hiringSignals, tally };
