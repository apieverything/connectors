"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const parsing = require("../core/parsing");
const { normalizeJob, normalizeCompany, normalizePerson, normalizePost, countryCode } = require("../core/normalize");
const { ProxyPool, parseProxyUrl, redact } = require("../core/proxy");
const { Config, parseEnvFile } = require("../core/config");
const { strategyOrder, DEFAULT_ORDER } = require("../core/strategies");
const { parseLimit, cleanQuery } = require("../core/jobs");
const { hiringSignals, tally } = require("../core/signals");
const { peopleEnabled, assertPeopleEnabled } = require("../core/people");
const { summarize, compact, extractCountry } = require("../core/proxycheck");
const { ConnectorError, HINTS } = require("../core/errors");
const { redactUrl } = require("../core/logger");

const GUEST_FRAGMENT = `<!DOCTYPE html>
<li><div class="base-card relative w-full base-card--link" data-entity-urn="urn:li:jobPosting:4486054169">
<a class="base-card__full-link" href="https://fr.linkedin.com/jobs/view/developpeur-python-at-visian-4486054169?position=1&amp;refId=x"></a>
<div class="base-search-card__info">
<h3 class="base-search-card__title">Développeur Python</h3>
<h4 class="base-search-card__subtitle">Visian</h4>
<span class="job-search-card__location">Courbevoie, Île-de-France, France</span>
<time datetime="2026-11-03"></time>
</div></div></li>`;

const JOB_POSTING = {
  "@type": "JobPosting",
  title: "Développeur Python",
  datePosted: "2026-11-03T14:03:26.000Z",
  employmentType: "FULL_TIME",
  description: "<p>Visian recrute un·e Développeur Python</p>",
  hiringOrganization: { "@type": "Organization", name: "Visian", sameAs: "https://visian.fr" },
  jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Courbevoie", addressRegion: "Île-de-France", addressCountry: "FR" } },
  industry: "Développement de logiciels",
  skills: ["Python", "Django"],
};

const ORG = {
  "@type": "Organization", name: "LinkedIn",
  url: "https://www.linkedin.com/company/linkedin",
  description: "Founded in 2003, LinkedIn connects the world's professionals.",
  numberOfEmployees: { "@type": "QuantitativeValue", value: 20000 },
  logo: "https://media.licdn.com/logo.png",
  address: { "@type": "PostalAddress", streetAddress: "1000 W Maude", addressLocality: "Sunnyvale", addressRegion: "CA", postalCode: "94085", addressCountry: "US" },
};

const PERSON = {
  "@type": "Person", name: "Reid Hoffman",
  jobTitle: ["Co-Founder, Executive Board Chair", "Partner"],
  url: "https://www.linkedin.com/in/reidhoffman",
  address: { "@type": "PostalAddress", addressCountry: "US", addressLocality: "United States" },
  worksFor: [{ "@type": "Organization", name: "Manas AI" }],
  description: "Investing in AI.",
  image: { "@type": "ImageObject", contentUrl: "https://media.licdn.com/reid.jpg" },
  alumniOf: [{ "@type": "EducationalOrganization", name: "University of Oulu", member: { startDate: 2020, endDate: 2020 } }],
  knowsLanguage: ["English"],
  interactionStatistic: { userInteractionCount: 1000000 },
};

const ARTICLE = {
  "@type": "Article",
  author: { "@type": "Person", name: "Reid Hoffman" },
  datePublished: "2026-11-11T19:11:36.000+00:00",
  headline: "What can we do if the economy grows?",
  interactionStatistic: { interactionType: "http://schema.org/LikeAction", userInteractionCount: 412 },
};

test("jobCards parses the guest API fragment", () => {
  const cards = parsing.jobCards(GUEST_FRAGMENT);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, "Développeur Python");
  assert.equal(cards[0].company, "Visian");
  assert.equal(cards[0].location, "Courbevoie, Île-de-France, France");
  assert.equal(cards[0].date, "2026-11-03");
  assert.equal(parsing.jobIdFromUrl(cards[0].url), "4486054169");
  assert.equal(cards[0].urn, "urn:li:jobPosting:4486054169");
});

test("jobCards deduplicates nested li/.base-card on the full search page", () => {
  const nested = `<li><div class="base-card"><h3 class="base-search-card__title">Dev</h3>
    <h4 class="base-search-card__subtitle">ACME</h4><span class="job-search-card__location">Paris</span>
    <a class="base-card__full-link" href="https://linkedin.com/jobs/view/dev-at-acme-1234567"></a></div></li>`;
  assert.equal(parsing.jobCards(nested).length, 1);
});

test("jobCriteria and description extraction", () => {
  const html = `<div class="description__job-criteria">
    <h3 class="description__job-criteria-subheader">Niveau hiérarchique</h3>
    <span class="description__job-criteria-text">Cadre</span>
    <h3 class="description__job-criteria-subheader">Type d’emploi</h3>
    <span class="description__job-criteria-text">Temps plein</span></div>
    <div class="show-more-less-html__markup"><p>Visian recrute</p></div>`;
  assert.deepEqual(parsing.jobCriteria(html), { "Niveau hiérarchique": "Cadre", "Type d’emploi": "Temps plein" });
  assert.equal(parsing.jobDescription(html).trim(), "Visian recrute");
});

test("ldGraph flattens @graph and finds typed nodes", () => {
  const html = `<script type="application/ld+json">{"@context":"http://schema.org","@graph":[
    {"@type":"JobPosting","title":"Dev"},{"@type":"Organization","name":"ACME"}]}</script>`;
  const graph = parsing.ldGraph(html);
  assert.equal(graph.length, 2);
  assert.equal(parsing.nodesOfType(graph, "JobPosting")[0].title, "Dev");
});

test("parseJsonLdText recovers concatenated objects in one script tag", () => {
  const text = '{"@type":"Person","name":"A"}{"@type":"JobPosting","title":"Dev"}';
  const parsed = parsing.parseJsonLdText(text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].title, "Dev");
  const html = `<script type="application/ld+json">${text}</script>`;
  assert.equal(parsing.nodesOfType(parsing.ldGraph(html), "JobPosting").length, 1);
});

test("normalizeJob merges card + JobPosting JSON-LD", () => {
  const job = normalizeJob({
    title: "Développeur Python", company: "Visian", location: "Courbevoie",
    date: "2026-11-03", url: "https://linkedin.com/jobs/view/x-4486054169",
    id: "4486054169", source: "jobs_guest",
  }, JOB_POSTING);
  assert.equal(job.title, "Développeur Python");
  assert.equal(job.company, "Visian");
  assert.equal(job.countryCode, "FR");
  assert.equal(job.city, "Courbevoie");
  assert.equal(job.datePosted, "2026-11-03");
  assert.deepEqual(job.skills, ["Python", "Django"]);
  assert.match(job.description, /Visian recrute/);
  assert.equal(job.source, "jobs_guest");

  const cardOnly = normalizeJob({ title: "Dev", company: "ACME", location: "Labège, Occitanie, France", date: "2026-10-19" });
  assert.equal(cardOnly.city, "Labège");
  assert.equal(cardOnly.region, "Occitanie");
  assert.equal(cardOnly.country, "France");
});

test("normalizeCompany extracts followers, founded year and address", () => {
  const seo = parsing.parseCompanySeo("LinkedIn | 34,725,143 followers on LinkedIn. Founded in 2003, LinkedIn connects the world&#39;s professionals.");
  assert.equal(seo.followers, 34725143);
  assert.equal(seo.foundedYear, 2003);
  const company = normalizeCompany("linkedin", seo, ORG, [ARTICLE]);
  assert.equal(company.name, "LinkedIn");
  assert.equal(company.employeesReported, 20000);
  assert.equal(company.countryCode, "US");
  assert.equal(company.logo, "https://media.licdn.com/logo.png");
  assert.equal(company.city, "Sunnyvale");
  assert.equal(company.posts.length, 1);
  assert.equal(company.posts[0].likes, 412);
});

test("normalizePerson merges dual-UA SEO variants", () => {
  const variants = [
    { description: "Co-Founder, LinkedIn · My current priority is investing in AI." },
    { description: "Investing in AI · Experience: Manas AI · Education: University of Oulu · Location: United States" },
  ];
  const p = normalizePerson("reidhoffman", [PERSON, ARTICLE], variants);
  assert.equal(p.name, "Reid Hoffman");
  assert.equal(p.position, "Co-Founder, Executive Board Chair");
  assert.equal(p.positions.length, 2);
  assert.equal(p.profilePicture, "https://media.licdn.com/reid.jpg");
  assert.equal(p.currentCompany, "Manas AI");
  assert.equal(p.countryCode, "US");
  assert.match(p.about, /Education: University of Oulu/);
  assert.equal(p.education[0].school, "University of Oulu");
  assert.equal(p.posts.length, 1);
  assert.equal(p.posts[0].likes, 412);
  assert.match(p.notice, /personal data/i);
});

test("normalizePost ignores unrelated nodes", () => {
  assert.equal(normalizePost({ "@type": "Person" }), null);
  assert.equal(normalizePost(ARTICLE).headline, "What can we do if the economy grows?");
  assert.equal(countryCode("de"), "DE");
  assert.equal(countryCode("France"), null);
});

test("people endpoint is gated by default", () => {
  const saved = process.env.LI_ALLOW_PEOPLE;
  try {
    delete process.env.LI_ALLOW_PEOPLE;
    assert.equal(peopleEnabled(), false);
    assert.throws(
      () => assertPeopleEnabled(),
      (err) => err.code === "LI_PEOPLE_DISABLED" && err.status === 403
    );
    process.env.LI_ALLOW_PEOPLE = "1";
    assert.equal(peopleEnabled(), true);
    assert.doesNotThrow(() => assertPeopleEnabled());
  } finally {
    if (saved === undefined) delete process.env.LI_ALLOW_PEOPLE;
    else process.env.LI_ALLOW_PEOPLE = saved;
  }
});

test("hiringSignals validates its aggregate-only contract", async () => {
  await assert.rejects(
    () => hiringSignals({ skill: "python" }),
    (err) => err.code === "LI_BAD_REQUEST" && err.status === 400
  );
  assert.deepEqual(tally([{ city: "Paris" }, { city: "Paris" }, { city: "Lyon" }], (x) => x.city), [
    { name: "Paris", count: 2 }, { name: "Lyon", count: 1 },
  ]);
});

test("bare proxy credentials and duplicate rotating lines", () => {
  const bare = "user:pass@resi.example.su:80";
  const config = parseProxyUrl(bare, "abc");
  assert.equal(config.protocol, "http");
  assert.equal(config.host, "resi.example.su");
  assert.equal(config.port, 80);
  assert.deepEqual(config.auth, { username: "user", password: "pass" });
  assert.ok(!redact(`Invalid: ${bare}`).includes("pass"));
  const pool = new ProxyPool({ LI_PROXIES: Array(10).fill(bare).join(",") });
  assert.equal(pool.describe().count, 1);
  assert.equal(pool.describe().duplicatesCollapsed, 9);
});

test("Config.load() reloads edited values and keeps CLI overrides", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "li-config-"));
  const file = path.join(dir, ".env");
  const saved = { ...process.env };
  try {
    delete process.env.LI_MIN_INTERVAL_MS;
    fs.writeFileSync(file, "LI_MIN_INTERVAL_MS=1000\nLOG_LEVEL=warn\n");
    const cfg = new Config(file);
    cfg.load();
    assert.equal(process.env.LI_MIN_INTERVAL_MS, "1000");
    fs.writeFileSync(file, "LI_MIN_INTERVAL_MS=3000\n");
    cfg.load();
    assert.equal(process.env.LI_MIN_INTERVAL_MS, "3000");
    assert.equal(process.env.LOG_LEVEL, undefined);
  } finally {
    for (const k of ["LI_MIN_INTERVAL_MS", "LOG_LEVEL"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseEnvFile handles comments and quotes", () => {
  const entries = parseEnvFile('# c\nexport LI_A=abc  # inline\nLI_B="x y"\nNOPE');
  assert.equal(entries.get("LI_A"), "abc");
  assert.equal(entries.get("LI_B"), "x y");
  assert.equal(entries.has("NOPE"), false);
});

test("strategyOrder defaults and filters", () => {
  const saved = process.env.LI_JOBS_STRATEGIES;
  try {
    delete process.env.LI_JOBS_STRATEGIES;
    assert.deepEqual(strategyOrder(), DEFAULT_ORDER);
    process.env.LI_JOBS_STRATEGIES = "jobs_search_html, nope";
    assert.deepEqual(strategyOrder(), ["jobs_search_html"]);
  } finally {
    if (saved === undefined) delete process.env.LI_JOBS_STRATEGIES;
    else process.env.LI_JOBS_STRATEGIES = saved;
  }
});

test("parseLimit / cleanQuery validate input", () => {
  assert.equal(parseLimit(null), 10);
  assert.equal(parseLimit("50"), 50);
  assert.equal(parseLimit("1000"), 100);
  assert.throws(() => parseLimit("abc"), /limit/);
  assert.deepEqual(cleanQuery({ keywords: "python", location: "France" }), { keywords: "python", location: "France", start: 0 });
  assert.throws(() => cleanQuery({}), /keywords/);
});

test("proxycheck summarises LinkedIn status", () => {
  const s = summarize([
    { index: 0, label: "a", alive: true, country: "FR", ms: 10, linkedinStatus: 200 },
    { index: 1, label: "b", alive: true, country: "FR", ms: 20, linkedinStatus: 999 },
  ], { linkedinStatus: 200, ms: 5 });
  assert.equal(s.liAlive, 1);
  assert.equal(s.liStatuses[999], 1);
  assert.equal(compact(s).direct.linkedinStatus, 200);
  assert.equal(extractCountry({ country_code: "de" }, ""), "DE");
});

test("ConnectorError hints and privacy redaction", () => {
  const err = new ConnectorError("LI_PEOPLE_DISABLED", "blocked", 403);
  assert.equal(err.status, 403);
  assert.match(err.hint, /self-hosted/);
  assert.ok(HINTS.LI_ALL_STRATEGIES_FAILED);
  assert.equal(redactUrl("/v1/linkedin/people/reidhoffman?x=1"), "/v1/linkedin/people/***");
  assert.ok(!redactUrl("/v1/linkedin/jobs/search?keywords=secret&location=France").includes("secret"));
});
