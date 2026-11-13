"use strict";

/**
 * Independent job sources, mirroring the other connectors.
 * jobs_guest (~30 KB) is preferred; jobs_search_html (~305 KB) is the
 * fallback when LinkedIn throttles the guest endpoint with a 429.
 */
const { jobsGuest, jobsSearchHtml } = require("./sources");
const { ConnectorError } = require("./errors");
const { log } = require("./logger");

const DEFAULT_ORDER = ["jobs_guest", "jobs_search_html"];

function strategyOrder() {
  const raw = process.env.LI_JOBS_STRATEGIES?.trim();
  if (!raw) return DEFAULT_ORDER;
  const custom = raw.split(/[\s,]+/).filter(Boolean).filter((n) => DEFAULT_ORDER.includes(n));
  return custom.length ? custom : DEFAULT_ORDER;
}

const STRATEGIES = {
  jobs_guest: jobsGuest,
  jobs_search_html: jobsSearchHtml,
};

async function searchJobs(query, options = {}) {
  const failures = [];
  for (const name of strategyOrder()) {
    try {
      const result = await STRATEGIES[name](query, options);
      return { ...result, strategy: name, failures };
    } catch (err) {
      failures.push({ strategy: name, code: err.code ?? "UNKNOWN", message: err.message });
      log.warn(`jobs strategy ${name} failed (${err.code ?? "UNKNOWN"})`);
    }
  }
  throw new ConnectorError(
    "LI_ALL_STRATEGIES_FAILED",
    "Every job source failed. See details and /v1/diagnostics.",
    502,
    failures
  );
}

async function runDiagnostics(query, options = {}) {
  const results = [];
  for (const name of strategyOrder()) {
    const started = Date.now();
    try {
      const result = await STRATEGIES[name]({ ...query, start: 0 }, options);
      results.push({
        strategy: name,
        ok: result.cards.length > 0,
        jobs: result.cards.length,
        ms: Date.now() - started,
      });
    } catch (err) {
      results.push({
        strategy: name, ok: false, jobs: 0,
        ms: Date.now() - started,
        code: err.code ?? "UNKNOWN", message: err.message,
      });
    }
  }
  return results;
}

module.exports = { STRATEGIES, DEFAULT_ORDER, strategyOrder, searchJobs, runDiagnostics };
