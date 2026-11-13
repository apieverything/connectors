"use strict";

const { decodeEntities, stripHtml } = require("./parsing");

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function skillsOf(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
  }
  return null;
}
function countryCode(value) {
  if (typeof value !== "string") return null;
  return /^[A-Za-z]{2}$/.test(value.trim()) ? value.trim().toUpperCase() : null;
}

function splitLocation(text) {
  const parts = String(text ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return {
    city: parts[0] ?? null,
    region: parts.length >= 3 ? parts[1] : null,
    country: parts.length >= 2 ? parts[parts.length - 1] : null,
  };
}

function normalizeJob(card, posting = null) {
  const location = posting?.jobLocation ?? null;
  const address = location?.address ?? null;
  const org = posting?.hiringOrganization ?? null;
  const locationText = decodeEntities(card.location ?? address?.addressLocality ?? "");
  const parsed = splitLocation(locationText);
  return {
    id: card.id ?? null,
    url: card.url ?? null,
    title: decodeEntities(card.title ?? posting?.title ?? ""),
    company: decodeEntities(card.company ?? org?.name ?? ""),
    companyUrl: org?.sameAs ?? org?.url ?? null,
    location: locationText,
    city: address?.addressLocality ?? parsed.city,
    region: address?.addressRegion ?? parsed.region,
    country: parsed.country,
    countryCode: countryCode(address?.addressCountry),
    datePosted: card.date ?? posting?.datePosted ?? null,
    validThrough: posting?.validThrough ?? null,
    employmentType: posting?.employmentType ?? null,
    seniority: card.criteria?.["Niveau hiérarchique"] ?? card.criteria?.["Seniority level"] ?? null,
    industries: posting?.industry ?? card.criteria?.["Secteurs"] ?? card.criteria?.["Industries"] ?? null,
    skills: skillsOf(posting?.skills),
    description: posting?.description ? stripHtml(posting.description) : card.description ?? null,
    applicants: card.applicants ?? null,
    source: card.source ?? (posting ? "job_posting_ld" : "jobs_guest"),
  };
}

function normalizeCompany(slug, seo, org, postings = []) {
  const address = org?.address ?? {};
  return {
    slug,
    url: org?.url ?? `https://www.linkedin.com/company/${slug}/`,
    name: org?.name ?? null,
    description: org?.description ?? seo?.raw ?? null,
    followers: seo?.followers ?? null,
    foundedYear: seo?.foundedYear ?? null,
    // LinkedIn's schema.org markup exposes a value that is NOT a reliable
    // headcount (e.g. 56 for LinkedIn itself). Keep it, but name it honestly.
    employeesReported: num(org?.numberOfEmployees?.value ?? org?.numberOfEmployees) ?? null,
    logo: typeof org?.logo === "object" ? org.logo?.contentUrl ?? null : org?.logo ?? null,
    website: org?.sameAs ?? null,
    city: address.addressLocality ?? null,
    region: address.addressRegion ?? null,
    countryCode: countryCode(address.addressCountry),
    streetAddress: address.streetAddress ?? null,
    postalCode: address.postalCode ?? null,
    posts: postings.map(normalizePost).filter(Boolean),
    source: "company_seo",
  };
}

function mediaUrl(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.contentUrl ?? value.url ?? null;
}

function normalizePost(node) {
  if (!node) return null;
  const type = node["@type"];
  if (type !== "Article" && type !== "SocialMediaPosting" && type !== "DiscussionForumPosting") return null;
  const stats = node.interactionStatistic;
  const likes = Array.isArray(stats)
    ? stats.find((s) => /Like/i.test(s.interactionType ?? ""))?.userInteractionCount
    : stats?.userInteractionCount;
  return {
    url: node.url ?? null,
    headline: decodeEntities(node.headline ?? ""),
    datePublished: node.datePublished ?? null,
    likes: num(likes) ?? null,
    image: mediaUrl(node.image),
    author: node.author?.name ?? null,
  };
}

/**
 * People are third-party personal data. Only built when LI_ALLOW_PEOPLE=1.
 * Two UA variants are merged: one exposes the headline, the other the
 * About / Experience / Education / Location string.
 */
function normalizePerson(slug, graph, seoVariants = []) {
  const person = graph.find((n) => n["@type"] === "Person" && (n.jobTitle || n.name)) ?? null;
  const address = person?.address ?? {};
  const worksFor = person?.worksFor;
  const company = Array.isArray(worksFor) ? worksFor[0]?.name : worksFor?.name ?? null;
  const positions = Array.isArray(person?.jobTitle) ? person.jobTitle : (person?.jobTitle ? [person.jobTitle] : []);
  const articles = graph.filter((n) => ["Article", "DiscussionForumPosting", "SocialMediaPosting"].includes(n["@type"]));

  const aboutParts = seoVariants
    .map((v) => v.description)
    .filter(Boolean)
    .map(decodeEntities);
  const about = aboutParts.find((d) => /Experience:|Education:|Location:/i.test(d)) ?? aboutParts[0] ?? person?.description ?? null;

  return {
    slug,
    url: person?.url ?? `https://www.linkedin.com/in/${slug}/`,
    id: slug,
    firstName: person?.name?.split(" ")[0] ?? null,
    lastName: person?.name?.split(" ").slice(1).join(" ") ?? null,
    name: person?.name ?? null,
    position: positions[0] ?? null,
    positions,
    headline: null,
    about,
    city: address.addressLocality ?? null,
    locationLabel: address.addressLocality ?? null,
    countryCode: countryCode(address.addressCountry),
    currentCompany: company,
    profilePicture: mediaUrl(person?.image),
    education: (Array.isArray(person?.alumniOf) ? person.alumniOf : []).map((a) => ({
      school: a.name ?? null,
      url: a.url ?? null,
      startDate: a.member?.startDate ?? null,
      endDate: a.member?.endDate ?? null,
    })),
    languages: person?.knowsLanguage ?? null,
    followers: num(person?.interactionStatistic?.userInteractionCount) ?? null,
    posts: articles.map(normalizePost).filter(Boolean),
    source: "person_seo",
    notice: "Third-party personal data. Self-hosted use only; do not redistribute.",
  };
}

module.exports = {
  normalizeJob, normalizeCompany, normalizePerson, normalizePost,
  num, countryCode,
};
