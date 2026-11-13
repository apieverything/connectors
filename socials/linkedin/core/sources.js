"use strict";

const { get } = require("./http");
const { ConnectorError } = require("./errors");
const {
  load, ldGraph, nodesOfType, jobCards, jobIdFromUrl, localizedJobUrl,
  jobCriteria, jobDescription, meta, parseCompanySeo,
} = require("./parsing");

const BASE = "https://www.linkedin.com";

function jobSearchUrl({ keywords, location, start }) {
  const params = new URLSearchParams();
  if (keywords) params.set("keywords", keywords);
  if (location) params.set("location", location);
  params.set("start", String(start ?? 0));
  return `${BASE}/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`;
}

function fullSearchUrl({ keywords, location, start }) {
  const params = new URLSearchParams();
  if (keywords) params.set("keywords", keywords);
  if (location) params.set("location", location);
  params.set("start", String(start ?? 0));
  return `${BASE}/jobs/search?${params}`;
}

/** Primary: ~30 KB, 10 cards, no auth. Occasionally 429 -> caller falls back. */
async function jobsGuest(query, options = {}) {
  const { body } = await get(jobSearchUrl(query), {
    headers: { Accept: "*/*", Referer: `${BASE}/jobs/` },
    ...(options.fixedProxy !== undefined ? { fixedProxy: options.fixedProxy } : {}),
  });
  const cards = jobCards(body);
  if (!cards.length) {
    throw new ConnectorError("LI_RATE_LIMITED", "Guest jobs API returned no cards.", 429);
  }
  return { cards: cards.map((c) => ({ ...c, source: "jobs_guest", id: jobIdFromUrl(c.url) })) };
}

/** Fallback: ~305 KB, up to 60 cards, still anonymous. */
async function jobsSearchHtml(query, options = {}) {
  const { body } = await get(fullSearchUrl(query), {
    headers: { Accept: "text/html" },
    ...(options.fixedProxy !== undefined ? { fixedProxy: options.fixedProxy } : {}),
  });
  const cards = jobCards(body);
  if (!cards.length) {
    throw new ConnectorError("LI_UNEXPECTED_RESPONSE", "Jobs search page contained no cards.", 502);
  }
  return { cards: cards.map((c) => ({ ...c, source: "jobs_search_html", id: jobIdFromUrl(c.url) })) };
}

async function jobDetail(idOrUrl, options = {}) {
  const url = /^https?:/.test(String(idOrUrl))
    ? String(idOrUrl).split("?")[0]
    : `${BASE}/jobs/view/${encodeURIComponent(String(idOrUrl))}`;
  const requestOptions = {
    headers: { Accept: "text/html" },
    ...(options.fixedProxy !== undefined ? { fixedProxy: options.fixedProxy } : {}),
  };
  const first = await get(url, requestOptions);
  let posting = nodesOfType(ldGraph(first.body), "JobPosting")[0] ?? null;
  let body = first.body;
  let resolvedUrl = url;

  // The canonical page often omits the JobPosting JSON-LD; the localized URL
  // (hidden in a signup redirect code block) carries it.
  if (!posting) {
    const localized = localizedJobUrl(first.body);
    if (localized) {
      try {
        const second = await get(localized, requestOptions);
        posting = nodesOfType(ldGraph(second.body), "JobPosting")[0] ?? null;
        if (posting) {
          body = second.body;
          resolvedUrl = localized;
        }
      } catch {
        // Keep the first page; criteria and description are still usable.
      }
    }
  }

  const criteria = jobCriteria(body);
  const description = jobDescription(body);
  const topTitle = load(body)(".top-card-layout__title").text().trim();
  const title = posting?.title ?? topTitle ?? meta(load(body), "og:title") ?? null;
  if (!posting && !description) {
    throw new ConnectorError("LI_JOB_NOT_FOUND", `Job ${idOrUrl} returned no data.`, 404);
  }
  return {
    id: jobIdFromUrl(resolvedUrl) ?? jobIdFromUrl(url),
    url: resolvedUrl,
    title: title ? title.replace(/\s*\|\s*LinkedIn Jobs.*$/i, "").trim() : null,
    posting,
    criteria,
    description,
    applicants: null,
  };
}

async function company(slug, options = {}) {
  const url = `${BASE}/company/${encodeURIComponent(slug)}/`;
  // Googlebot UA exposes the SEO description + the Organization JSON-LD.
  const { body } = await get(url, {
    crawler: true,
    headers: { Accept: "text/html,application/xhtml+xml" },
    ...(options.fixedProxy !== undefined ? { fixedProxy: options.fixedProxy } : {}),
  });
  const graph = ldGraph(body);
  const org = nodesOfType(graph, "Organization")[0] ?? null;
  const postings = nodesOfType(graph, "SocialMediaPosting");
  const seo = parseCompanySeo(meta(load(body), "og:description"));
  if (!org && !seo.raw) {
    throw new ConnectorError("LI_USER_NOT_FOUND", `Company @${slug} not found.`, 404);
  }
  return { slug, seo, org, postings };
}

async function person(slug, options = {}) {
  const url = `${BASE}/in/${encodeURIComponent(slug)}/`;
  const browser = await get(url, {
    headers: { Accept: "text/html" },
    ...(options.fixedProxy !== undefined ? { fixedProxy: options.fixedProxy } : {}),
    session: options.session ?? null,
  });
  const crawler = await get(url, {
    crawler: true,
    headers: { Accept: "text/html" },
    ...(options.fixedProxy !== undefined ? { fixedProxy: options.fixedProxy } : {}),
  });
  const $ = load(browser.body);
  const variants = [
    { description: meta($, "og:description"), title: meta($, "og:title") },
    { description: meta(load(crawler.body), "og:description"), title: null },
  ];
  const graph = [...ldGraph(browser.body), ...ldGraph(crawler.body)];
  if (!graph.some((n) => n["@type"] === "Person")) {
    throw new ConnectorError("LI_USER_NOT_FOUND", `Profile @${slug} not found.`, 404);
  }
  return { slug, graph, variants, firstName: meta($, "profile:first_name"), lastName: meta($, "profile:last_name") };
}

module.exports = {
  BASE, jobSearchUrl, fullSearchUrl,
  jobsGuest, jobsSearchHtml, jobDetail, company, person,
};
