# LinkedIn Connector

A self-hosted connector for LinkedIn **job postings, company metadata and
aggregate hiring signals** — served over a local HTTP API.

Everything public here works **anonymously**: no account, no `li_at` cookie, no
proxy, no 429 wall. LinkedIn server-renders SEO metadata and schema.org JSON-LD
into its public pages, which is enough to build a useful, lightweight API.

## Data policy (read this first)

This connector deliberately does **not** expose people profiles by default.

| Endpoint | Data | Hosted tier |
| --- | --- | --- |
| `/v1/linkedin/jobs/search`, `/jobs/:id` | Job postings — commercial information | ✅ Yes |
| `/v1/linkedin/company/:slug` | Legal-entity metadata + public company posts | ✅ Yes |
| `/v1/linkedin/signals/hiring` | **Counts only** — no personal data | ✅ Yes |
| `/v1/linkedin/people/:slug` | Third-party **personal data** | ❌ Self-host only |

`LI_ALLOW_PEOPLE=0` is the default. With it, `/people/:slug` returns a
structured `403 LI_PEOPLE_DISABLED`. People lookups are **never cached**, their
query strings are **never logged**, and no profile is retained beyond the
lifetime of the request.

> Zero retention of *customer* data is not the same as zero *processing* of
> third-party personal data. Even without storing anything, returning a profile
> is a processing operation under the GDPR. That is why profiles stay out of
> the hosted service: the paid tier funds the project without selling a dossier
> on a person.

The code stays MIT with full feature parity — the right to leave is preserved.
The hosted service sells infrastructure (proxies, uptime, maintenance), never a
capability that the repository lacks.

## Why jobs first

Three reasons, all measured:

- **Sovereignty:** a job posting is not personal data. The zero-retention
  charter holds without contortions.
- **Sobriety:** the guest jobs endpoint is ~**30 KB** per call versus ~**900 KB**
  for a profile page and ~**426 KB** for a company page. The fallback order is
  also an energy policy: lightest source first, no headless browser, no media
  proxying (media URLs are returned, not tunneled).
- **Mission:** LinkedIn's official Jobs API is restricted to partners. This is
  exactly the "API that does not exist / is paid" case API Everything targets.

## Quick start

```bash
cp .env.example .env
docker compose up -d

curl "http://localhost:3000/health"
curl "http://localhost:3000/v1/linkedin/jobs/search?keywords=python&location=France&limit=10"
```

Without Docker (Node 22+):

```bash
npm install
cp .env.example .env
node --env-file=.env server.js
```

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Service info, strategies, data-policy state |
| GET | `/health` | Liveness + session/proxy/people state |
| GET | `/v1/session` | Session verification result |
| GET | `/v1/diagnostics?keywords=...&location=...` | Test each job source |
| GET | `/v1/proxies` | Startup proxy probe results |
| GET | `/v1/linkedin/jobs/search?keywords=...&location=...&start=...&limit=...` | Job search |
| GET | `/v1/linkedin/jobs/:id` | Full job detail |
| GET | `/v1/linkedin/company/:slug` | Company metadata + posts |
| GET | `/v1/linkedin/signals/hiring?skill=...&country=...&window=30&pages=3` | Aggregate signals |
| GET | `/v1/linkedin/people/:slug` | Profile (**disabled by default**) |
| GET | `/openapi.yaml` | API schema |

`/v1/linkedin/...` is this connector's namespace; it is the first connector to
expose several resource types, which is why the `core` gateway matters more
with every new service.

### Job search

```bash
curl "http://localhost:3000/v1/linkedin/jobs/search?keywords=python&location=France&limit=3"
```

```json
{
  "query": { "keywords": "python", "location": "France", "start": 0 },
  "count": 3,
  "jobs": [
    {
      "id": "4418974011",
      "url": "https://fr.linkedin.com/jobs/view/developpeur-python-confirme-f-h-at-itrust-4418974011",
      "title": "Développeur Python Confirmé F/H",
      "company": "ITrust",
      "location": "Labège, Occitanie, France",
      "city": "Labège",
      "region": "Occitanie",
      "country": "France",
      "datePosted": "2026-10-19",
      "source": "jobs_guest"
    }
  ],
  "nextStart": 10,
  "hasMore": true,
  "strategy": "jobs_guest",
  "failures": []
}
```

`limit` is capped at 100. `keywords` and/or `location` are required: a fully
open crawl is intentionally not supported.

### Job detail

`/v1/linkedin/jobs/4486054169` resolves the localized URL hidden in the public
page, then merges the `JobPosting` JSON-LD with the visible criteria:

```json
{
  "title": "Développeur Python",
  "company": "Visian",
  "city": "Courbevoie",
  "countryCode": "FR",
  "datePosted": "2026-11-03T14:03:26.000Z",
  "employmentType": "FULL_TIME",
  "seniority": "Cadre",
  "industries": "Développement de logiciels",
  "description": "Visian recrute un·e Développeur (se) Python ...",
  "source": "job_posting_ld"
}
```

### Company

`og:description` (followers, founded year) plus schema.org `Organization` and
`SocialMediaPosting`: name, description, HQ address, country code, logo,
website, recent posts with like counts.

> `employeesReported` comes straight from LinkedIn's JSON-LD and is **not** a
> reliable headcount (LinkedIn itself reports 56). It is named honestly rather
> than dropped; do not use it as company size.

### Aggregate signals

```bash
curl "http://localhost:3000/v1/linkedin/signals/hiring?skill=python&country=France&window=30&pages=3"
```

Returns `byCity`, `byCompany`, `byDate`, `byCountry` counts plus `sampleSize`
and `inWindow`. No personal data, nothing traceable to an individual, cached
10 minutes. This is the endpoint intended for a public/paid hosted tier.

### Job source chain

| Strategy | Bytes | Notes |
| --- | --- | --- |
| `jobs_guest` | ~30 KB | `jobs-guest/jobs/api/seeMoreJobPostings/search`, 10 cards. Occasionally 429 |
| `jobs_search_html` | ~305 KB | Full `/jobs/search` page, up to 60 cards |

The first answers normally; the second takes over on a 429. Use
`/v1/diagnostics` to see which one is healthy, and `LI_JOBS_STRATEGIES` to pin
it. A fully anonymous lookup never enumerates a dataset — it resolves one known
URL or one keyword search at a time.

### People profiles (opt-in, self-host only)

With `LI_ALLOW_PEOPLE=1`, two User-Agent variants are merged: one exposes the
headline, the other `About · Experience · Education · Location`. The
schema.org `Person` node supplies name, positions, current company, country
code, education, languages, follower count and recent `Article` posts.

It is a **lookup by known slug**, not a 676M-record dataset. Bulk enumeration
would require the authenticated Voyager API, a session pool and a proxy fleet —
which is precisely the infrastructure the hosted service should not sell for
personal data.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `LI_ALLOW_PEOPLE` | `0` | Enable people profiles (self-host only) |
| `LI_SESSIONID` | — | `li_at` cookie; not needed for public sources |
| `LI_USER_AGENT` / `LI_CRAWLER_USER_AGENT` | Chrome / Googlebot | Dual-UA SEO variants |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP bind |
| `API_KEY` | — | Optional instance protection |
| `LI_MIN_INTERVAL_MS` | `1000` | Minimum delay between upstream calls |
| `LI_MAX_PAGES` | `5` | Page limit per search |
| `LI_TIMEOUT_MS` | `15000` | Network timeout |
| `LI_JOBS_STRATEGIES` | both | Comma-separated source order |
| `LI_PROXY_*` | — | Optional rotating proxies (see `.env.example`) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |

Both full proxy URLs and bare `user:pass@host:port` are accepted. Startup
proxies are probed for liveness, country, latency and LinkedIn reachability,
with a direct comparison so `LI 0/1 ok · direct 200` is unambiguous. Credentials
are redacted everywhere.

## Startup output and hot reload

Same infrastructure as the Instagram and TikTok connectors: coloured banner,
per-request logs (with query strings redacted), `Ctrl+R` hot reload of `.env`
and `Ctrl+C` shutdown. Hotkeys are disabled when stdin is not a TTY.

## Tests

```bash
npm test
```

18 offline tests cover card parsing, concatenated JSON-LD recovery, dual-UA
person merging, company/person normalization, the people gate, aggregate
signals, bare proxy credentials, config reload and error hints. No network
calls are made.

## Structure

```
server.js                 HTTP API, banner, Ctrl+R, hotkeys
core/config.js            .env loader with hot-reload
core/http.js              axios wrapper, dual UA, throttling, proxy rotation
core/parsing.js           meta / JSON-LD / job cards / criteria extraction
core/sources.js           guest jobs, search page, job detail, company, people
core/normalize.js         stable job / company / person / post shapes
core/strategies.js        job source chain + diagnostics
core/jobs.js              search orchestration + detail
core/company.js           company resolver (cached)
core/people.js            gated person resolver (never cached)
core/signals.js           aggregate hiring signals
core/proxy.js             optional rotating proxy pool
core/proxycheck.js        startup liveness / country / latency probe
core/identity.js          session verification
core/errors.js            typed errors and hints
openapi.yaml              API schema
```

## License

MIT License with an attribution notice — see
[`LICENSE.md`](../../LICENSE.md). Use, modification and redistribution are
permitted; any project using this connector elsewhere must visibly credit
**API Everything**.

> Automated access to LinkedIn is subject to LinkedIn's Terms of Service, and
> personal-data processing is subject to applicable law (GDPR and equivalents).
> This connector is provided for self-hosted use; operators are responsible for
> how they use it. The hosted API Everything service intentionally excludes
> people profiles.
