"use strict";

const cheerio = require("cheerio");

function load(html) {
  return cheerio.load(String(html ?? ""));
}

function meta($, key) {
  const value =
    $(`meta[property="${key}"]`).attr("content") ??
    $(`meta[name="${key}"]`).attr("content") ??
    null;
  return value ? decodeEntities(value) : null;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .trim();
}

/**
 * Parse one JSON-LD script body. LinkedIn sometimes concatenates several
 * objects in a single <script>, which makes JSON.parse fail on the whole tag.
 * Fall back to a balanced-brace scan and parse each top-level object.
 */
function parseJsonLdText(text) {
  const out = [];
  const raw = String(text ?? "").trim();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // scan top-level {...} segments
  }
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth += 1; continue; }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(raw.slice(start, i + 1))); } catch { /* skip malformed */ }
        start = -1;
      }
    }
  }
  return out;
}

/** All JSON-LD nodes flattened into one array (LinkedIn wraps them in @graph). */
function ldGraph(html) {
  const $ = load(html);
  const out = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    for (const parsed of parseJsonLdText($(el).text())) {
      if (Array.isArray(parsed?.["@graph"])) out.push(...parsed["@graph"]);
      else if (Array.isArray(parsed)) out.push(...parsed);
      else if (parsed) out.push(parsed);
    }
  });
  return out;
}

function nodesOfType(graph, type) {
  return graph.filter((node) => node?.["@type"] === type);
}

/** Job cards from either the guest API fragment or the full search page. */
function jobCards(html) {
  const $ = load(html);
  const cards = [];
  $("li, .base-card").each((_i, el) => {
    const card = $(el);
    const title = card.find(".base-search-card__title").first().text().trim();
    if (!title) return;
    const href = card.find("a.base-card__full-link").attr("href") ??
      card.find("a[href*='/jobs/view/']").first().attr("href") ?? null;
    cards.push({
      title: decodeEntities(title),
      company: decodeEntities(card.find(".base-search-card__subtitle").first().text().trim()),
      location: decodeEntities(card.find(".job-search-card__location").first().text().trim()),
      date: card.find("time").attr("datetime") ?? null,
      url: href ? href.split("?")[0] : null,
      urn: card.find("[data-entity-urn]").attr("data-entity-urn") ?? null,
      logo: card.find("img.company-logo, img.artdeco-entity-image").attr("src") ?? null,
    });
  });
  // De-duplicate: the full search page nests a div.base-card inside li.
  const seen = new Set();
  return cards.filter((card) => {
    const key = `${card.title}|${card.company}|${card.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** LinkedIn job ids are the trailing digits of a /jobs/view/...-ID URL. */
function jobIdFromUrl(url) {
  const match = /\/jobs\/view\/[^\/]*?(\d{6,})(?:\?|$|\/)/.exec(String(url ?? ""));
  return match ? match[1] : null;
}

/**
 * The canonical /jobs/view/<id> page hides the localized URL (which carries
 * the JobPosting JSON-LD) in a hidden <code> comment used for signup redirects.
 */
function localizedJobUrl(html) {
  const $ = load(html);
  const raw = $("#joinUrlWithRedirect").html() ?? "";
  const encoded = /session_redirect=([^"&<\s]+)/.exec(raw);
  if (!encoded) return null;
  try {
    const decoded = decodeURIComponent(encoded[1]);
    return /^https?:\/\/[^\s]+\/jobs\/view\//.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function jobCriteria(html) {
  const $ = load(html);
  const labels = $(".description__job-criteria-subheader").map((_i, el) => $(el).text().trim()).get();
  const values = $(".description__job-criteria-text").map((_i, el) => $(el).text().trim()).get();
  const out = {};
  labels.forEach((label, i) => {
    if (values[i]) out[decodeEntities(label)] = decodeEntities(values[i]);
  });
  return out;
}

function jobDescription(html) {
  const $ = load(html);
  const text = $(".show-more-less-html__markup").text().trim();
  return text || decodeEntities($('meta[property="og:description"]').attr("content") ?? "");
}

function stripHtml(htmlText) {
  const $ = load(htmlText);
  return decodeEntities($.root().text().replace(/\s+/g, " "));
}

/** "LinkedIn | 34,725,143 followers on LinkedIn. Founded in 2003, ..." */
function parseCompanySeo(description) {
  const text = decodeEntities(description ?? "");
  const followers = /\|?\s*([\d,\.]+)\s+followers/i.exec(text);
  const founded = /Founded in (\d{4})/i.exec(text);
  return {
    followers: followers ? Number(followers[1].replace(/[,\.]/g, "")) : null,
    foundedYear: founded ? Number(founded[1]) : null,
    raw: text || null,
  };
}

module.exports = {
  load, meta, decodeEntities, parseJsonLdText, ldGraph, nodesOfType,
  jobCards, jobIdFromUrl, localizedJobUrl, jobCriteria, jobDescription, stripHtml, parseCompanySeo,
};
