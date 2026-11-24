# Connector Roadmap

This document tracks shipped, planned, and explicitly excluded connectors across [`apieverything/connectors`](README.md).

Prioritization is governed by three engineering and policy criteria defined in the [Sovereignty & Data Charter](https://github.com/apieverything/.github/blob/master/CHARTER.md):

1. **Upstream stability & payload sobriety** — Compact JSON APIs, public RSS/Atom feeds, and ~15–30 KB SSR fragments take precedence over full-DOM scraping or headless browsers.
2. **Authentication requirement** — Keyless, anonymous public access comes first. Optional browser session cookies are supported only where self-hosters need authenticated visibility; automated `username:password` login flows are never built.
3. **Data-policy fit** — Public creator broadcasts, open code/package registries, scientific metadata, commercial listings, and aggregate product signals fit the default surface. Individual personal dossiers do not.

---

## Service Matrix

| Service | Category | Target Data | Upstream Mechanism | Auth Needed | Maintenance Risk | Status |
| --- | --- | --- | --- | --- | --- | --- |
| **Instagram** | `socials` | Profile counts, public posts, reels, captions, hashtags, comments, likes, media URLs | Logged-out GraphQL (`anon_grid`, `anon_user_info`) + `og:description` fallback | None (public); optional `IG_SESSIONID` for private | Moderate–High (`doc_id` rotation, IP 429s) | **Active** |
| **YouTube** | `socials` | Channel stats, video & Shorts feeds, keyless search, video details, chapters, transcripts | InnerTube JSON API (`WEB` / `ANDROID` / `IOS`) + `ytInitialData` HTML fallback + EU consent cookies | None (keyless) | Low–Moderate (renderer shape drift) | **Active** |
| **LinkedIn** | `socials` | Job search & job details, company metadata & posts, aggregate hiring signals (`people` gated `403`) | `jobs_guest` HTML fragment (~30 KB), search HTML fallback (~305 KB), schema.org JSON-LD | None (anonymous) | Moderate (intermittent guest 429s) | **Active** |
| **TikTok** | `socials` | Exact profile stats; posts via explicit video IDs, SSR, signed API, or opt-in Playwright | SSR `__UNIVERSAL_DATA_FOR_REHYDRATION__`, oEmbed, strategy chain (`TT_BROWSER` opt-in) | None (profile / oEmbed); signatures or browser for feed | High (`X-Bogus` / `X-Gnarly` request signing) | **Active** (profile) / **In progress** (signed posts) |
| **Bluesky** | `socials` | Public profiles, author feeds, post threads, keyword search | Public AT Protocol AppView XRPC JSON (`public.api.bsky.app`) | None | Low | Planned (Tier A) |
| **Reddit** | `socials` | Subreddit feeds, thread trees, comments, public search | Public `.json` routes + RSS/Atom fallback with descriptive `User-Agent` | None | Low–Moderate (datacenter ASN rate limits) | Planned (Tier A) |
| **GitHub** | `services` | Repository stats, releases, tags, README, trending repositories without 60 req/hr token walls | Public Atom feeds (`/releases.atom`), SSR embedded JSON, optional REST fallback | None (optional token override) | Low | Planned (Tier A) |
| **Hacker News** | `services` | Top/new/best stories, comment trees, item metadata, search | Official Firebase JSON API + Algolia HN Search JSON API | None | Very Low | Planned (Tier A) |
| **Open-Meteo / Nominatim** | `services` | Weather forecasts, historical series, forward & reverse geocoding | Open-Meteo REST JSON + OSM Nominatim JSON (strict pacing & local cache) | None | Very Low | Planned (Tier A) |
| **Package Registries (`npm`, `PyPI`, `crates.io`)** | `services` | Package versions, maintainers, download stats, dependency metadata, release history | `registry.npmjs.org`, `pypi.org/pypi/<pkg>/json`, `crates.io/api/v1` | None | Very Low | Planned (Tier A) |
| **Twitch** | `socials` | Live stream status, channel metadata, top clips, VOD metadata | Public web GraphQL (`gql.twitch.tv` persisted queries with public web `Client-ID`) | None | Moderate (persisted query hash updates) | Planned (Tier B) |
| **Trustpilot / Google Play / App Store** | `services` | Public aggregate ratings, star distributions, product reviews | Next.js `__NEXT_DATA__` / JSON-LD (Trustpilot), Play `batchexecute` SSR, iTunes Lookup / RSS JSON | None | Moderate (SSR state & RPC batch changes) | Planned (Tier B) |
| **Spotify / Vimeo** | `socials` | Public track, album, podcast, playlist, and video metadata (URLs & embeds only) | Public oEmbed + web embed SSR state (`__NEXT_DATA__` / anonymous embed tokens) | None | Moderate (embed token rotation) | Planned (Tier B) |
| **arXiv / CrossRef** | `services` | Preprint metadata, abstracts, authors, DOIs, citation counts | arXiv Atom / OAI-PMH API + CrossRef polite REST JSON API | None | Low | Planned (Tier B) |
| **X / Twitter** | `socials` | Public profile counters, single-post lookup, recent public timeline snapshots | Public syndication JSON (`cdn.syndication.twimg.com`) + guest GraphQL token chain | Guest token / optional self-host cookie | High (guest token limits, query ID churn) | Planned (Tier C) |
| **Google Maps Places** | `services` | Public commercial business hours, aggregate ratings, category, address, website | Public Place SSR / lightweight `pb=` RPC fragments + schema.org fallback | None (proxies recommended at volume) | High (consent walls, protobuf index shifts, IP blocks) | Planned (Tier C) |
| **TikTok (`/posts` hardening)** | `socials` | Keyless, browser-free pagination of public creator video lists | Lightweight signature generation / mobile web SSR fallback hardening | None (residential proxies recommended) | High (`X-Bogus` / `X-Gnarly` evolution) | In progress (Tier C) |

---

## Shipped Today

- **Instagram (`socials/instagram` — Active):** Resolves exact profile counters (`anon_user_info`) and paginated post grids (`anon_grid`) anonymously without an account or proxy, with configurable GraphQL `doc_id`s and `og:description` fallback.
- **YouTube (`socials/youtube` — Active):** Keyless channel profiles, video/Shorts feeds with continuation cursors, search, full video details (including parsed chapters), and caption transcripts (`XML` / `JSON3`) via InnerTube (`WEB`/`ANDROID`/`IOS`) plus `ytInitialData` HTML fallback and automatic EU consent-cookie bypass.
- **LinkedIn (`socials/linkedin` — Active):** Anonymous job search, full `JobPosting` JSON-LD details, company metadata, and aggregate hiring signals (`/v1/linkedin/signals/hiring`). Personal profile lookups (`/v1/linkedin/people/*`) are disabled by default (`403`) in both the connector and `core`.
- **TikTok (`socials/tiktok` — Active profile / In progress signed posts):** Exact profile stats work anonymously from SSR rehydration JSON. Post lists expose a unified strategy chain (`ssr_itemlist`, `item_list`, explicit `video_ids` via oEmbed/video pages, and opt-in Playwright capture via `TT_BROWSER=1`).

---

## Tier A — Zero-Friction Public Sources

*Characteristics: no session required, minimal anti-bot friction, compact structured JSON/Atom payloads, low ongoing maintenance.*

- **Bluesky (`socials/bluesky`):** Built on the open AT Protocol AppView (`public.api.bsky.app`), allowing normalized profile, feed, thread, and search routes matching the `/v1/<service>/:handle` and `/posts` contract with zero scraping fragility.
- **Reddit (`socials/reddit`):** Public subreddit listings, post trees, and search normalized from `.json` endpoints and RSS/Atom feeds with strict `User-Agent` identification and rate-limit backoff.
- **GitHub (`services/github`):** Unauthenticated callers hit GitHub's 60-requests/hour REST ceiling quickly; combining Atom feeds (`/releases.atom`, `/commits.atom`) and public SSR JSON covers repository stats, releases, and trending lists without requiring a personal access token (while accepting an optional token when configured).
- **Hacker News (`services/hackernews`):** Unified interface combining Firebase item/story trees with Algolia's search index into normalized post and thread shapes.
- **Open-Meteo / Nominatim (`services/geo-weather`):** Self-hostable geocoding and weather endpoints that wrap upstream usage policies (mandatory `User-Agent`, request pacing, and local TTL caching) out of the box.
- **Package Registries (`services/packages`):** Normalized metadata, version timelines, download metrics, and license/dependency inspection across `npm`, `PyPI`, and `crates.io` — inaugurating the `connectors/services/` directory alongside `socials/`.

---

## Tier B — High-Value Keyless / Lightweight Sources

*Characteristics: no user credentials required, moderate selector or persisted-query maintenance, high utility for product and research workflows.*

- **Twitch (`socials/twitch`):** Live status, viewer counts, stream categories, top clips, and VOD metadata via Twitch's public web GraphQL persisted queries, avoiding full OAuth app registration for read-only public channel checks.
- **Trustpilot / Google Play / App Store (`services/reviews`):** Public product intelligence — aggregate star distributions, review velocity, and public review text — extracted from Next.js SSR data, JSON-LD, Play `batchexecute` payloads, and iTunes JSON feeds, with reviewer personal profiles excluded.
- **Spotify / Vimeo (`socials/spotify`, `socials/vimeo`):** Public artist, podcast, playlist, track, and video metadata via oEmbed and web-embed state payloads. Strictly metadata and canonical URLs — never audio or video stream extraction.
- **arXiv / CrossRef (`services/research`):** Clean JSON normalization over legacy XML/Atom (`arXiv`) and DOI metadata (`CrossRef`) for citation graphs, abstracts, and preprint discovery.

---

## Tier C — High-Demand Anti-Bot Targets

*Characteristics: aggressive IP throttling, guest-token rotation, or client-side request signatures. Best operated behind `core`'s shared RAM cache, in-flight request coalescing, and rotating proxy pools.*

- **X / Twitter (`socials/x`):** Public syndication endpoints for single-post and widget lookups paired with guest-token GraphQL fallbacks, designed around aggressive caching so concurrent callers share a single upstream fetch.
- **Google Maps Public Places (`services/maps-places`):** Strictly limited to commercial/institutional venues (opening hours, aggregate ratings, category, public phone/website, coordinates) — never residential lookup or personal tracking.
- **TikTok `/posts` Signature Hardening (`socials/tiktok`):** Reducing reliance on opt-in headless Chromium (`TT_BROWSER=1`) by hardening lightweight mobile-web and signed-parameter fallbacks for `/v1/tiktok/:username/posts`.

---

## Explicitly Not Planned / Gated on Hosted

The following capabilities are **out of scope by design** and pull requests introducing them for default or hosted operation will be declined:

1. **Bulk personal-profile scraping & residential doxxing** *(e.g., LinkedIn people enumeration, private Instagram/TikTok accounts, residential/phone/voter directories)*:
   Violates Commitment 3 of the [Charter](https://github.com/apieverything/.github/blob/master/CHARTER.md). Processing natural persons' profiles at scale builds third-party personal dossiers regardless of whether the gateway logs caller IPs. `/v1/linkedin/people/*` remains `403` by default (`LI_ALLOW_PEOPLE=0` and `CORE_ALLOW_PEOPLE=0`), and bulk directory crawlers will not be added.
2. **Credential-stuffing & automated `username:password` login flows**:
   Automated login requires bypassing CAPTCHAs, device fingerprinting, and 2FA challenges, routinely gets user accounts banned, and solves nothing when rate limits are tied to exit IPs. Where self-hosted connectors support optional authenticated views, they accept user-exported session cookies only — never raw passwords.
3. **DRM, paywall, or paid-content circumvention** *(e.g., audio/video stream ripping, subscriber-only paywall bypasses, leaked key aggregators)*:
   API Everything normalizes publicly accessible web data and returns canonical upstream media URLs (`photos`, `videos`, `thumbnails`). It never proxies media binaries, decrypts DRM streams, or circumvents paid access controls.

---

## Proposing or Shipping a Connector

Contributors can ship a connector from the matrix above (or propose a new service that fits the three Charter criteria) by following the **Connector Contract** documented in [`README.md`](README.md#connector-contract):

1. **Location & runtime:** Create `socials/<service>/` (creator/community platforms) or `services/<service>/` (developer, scientific, or commercial utilities) targeting **Node.js 22+** with minimal dependencies (`axios` + Node built-ins; zero paid SDKs).
2. **Required files:**
   - `server.js` — HTTP server exposing `GET /`, `GET /health`, `GET /openapi.yaml`, `GET /v1/session`, `GET /v1/proxies`, `GET /v1/diagnostics`, and `/v1/<service>/...` routes, plus `Ctrl+R` hot reload and redacted request logs.
   - `openapi.yaml` — OpenAPI 3.0.3 schema (also merged dynamically by `core` at `GET /v1/openapi.json`).
   - `.env.example` — Every configuration variable documented with safe defaults and zero real secrets.
   - `Dockerfile` & `docker-compose.yml` — Standalone one-command self-hosting.
   - `package.json` — `start`, `dev`, and offline `test` scripts.
   - `README.md` — Quick start, strategy chain with approximate payload sizes, data-policy notes, troubleshooting error codes, and link to `../../LICENSE.md`.
   - `tests/` — Deterministic offline unit tests covering normalization, parser edge cases, error envelopes, config reload, and proxy URL parsing (`npm test` must make **zero** external network calls).
3. **Wire into repository checks:** Add the connector to [`README.md`](README.md), [`scripts/demo.sh`](scripts/demo.sh), and [`.github/workflows/ci.yml`](.github/workflows/ci.yml) before opening a pull request.
