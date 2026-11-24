# Connectors

Self-hostable connectors for [API Everything](../.profile/profile/README.md).

Each connector is an independent HTTP service. There is no hosted instance and
no mandatory gateway: you run it on your own machine and call it directly.

## Repository layout

```text
connectors/
├── README.md
├── services/              Reserved for SaaS and utility connectors (empty)
└── socials/
    ├── instagram/         Instagram profile and posts API
    ├── linkedin/          LinkedIn jobs, company and aggregate signals API
    ├── tiktok/            TikTok profile and posts API
    └── youtube/           YouTube channel, videos, search and transcripts API
```

## Available connectors

| Connector | Path | Status | Runtime | Provides |
| --- | --- | --- | --- | --- |
| Instagram | [`socials/instagram`](socials/instagram/README.md) | Active | Node.js 22+ | Exact profile metadata; posts with URL, author, caption, hashtags, mentions, comment count, date, likes and media URLs |
| YouTube | [`socials/youtube`](socials/youtube/README.md) | Active | Node.js 22+ | Keyless channel metadata, paginated videos & Shorts, video search, single-video details with chapters, and XML/JSON3 transcripts |
| LinkedIn | [`socials/linkedin`](socials/linkedin/README.md) | Active | Node.js 22+ | Job search and full job details, company metadata, aggregate hiring signals. People profiles disabled by default (personal data) |
| TikTok | [`socials/tiktok`](socials/tiktok/README.md) | Active (profile) / In progress (posts) | Node.js 22+ | Exact profile metadata; posts through a strategy chain (browser, SSR, signed API, explicit video ids) |

All connectors share the same infrastructure: `/health`, `/v1/session`,
`/v1/diagnostics`, `/v1/proxies` and `/openapi.yaml`, coloured logs,
`Ctrl+R` hot reload, optional rotating proxies, offline tests and the same
`LICENSE.md`. Instagram, YouTube and TikTok expose `/v1/<service>/:handle` and
`/v1/<service>/:handle/posts` (with YouTube also exposing `/v1/youtube/search`,
`/v1/youtube/videos/:id`, and `/v1/youtube/videos/:id/transcript`); LinkedIn
exposes a multi-resource namespace (`/v1/linkedin/jobs`, `/company`, `/signals`,
`/people`) because job, company and aggregate data are distinct resource types.

Instagram's internal endpoints and GraphQL `doc_id`s change without notice.
YouTube's connector talks directly to InnerTube JSON endpoints with EU consent
bypass cookies and falls back to balanced-brace HTML `ytInitialData` /
`ytInitialPlayerResponse` extraction. TikTok signs its post-list API, so its
`/posts` endpoint relies on a strategy chain rather than a single anonymous
query. LinkedIn's public job endpoints are intermittently throttled, so its
source chain falls back from the ~30 KB guest API to the full search page. All
four keep their sources configurable through environment variables; see each
connector's troubleshooting section.

**Data policy:** the LinkedIn connector serves no personal data by default.
Its hosted/public surface is limited to jobs, companies and aggregate counts;
people profiles are opt-in and intended for self-hosted use only.

`services/` is currently empty and reserved for future connectors.

## Quick start

```bash
cd socials/instagram
cp .env.example .env
docker compose up -d

curl "http://localhost:3000/health"
curl "http://localhost:3000/v1/instagram/kametolol"
curl "http://localhost:3000/v1/instagram/kametolol/posts?limit=12"
```

Public posts and exact profile counts work without an Instagram account and
without a proxy. A session cookie (`IG_SESSIONID`) is only required for private
profiles. Rotating residential proxies are optional and configured per instance.

YouTube is 100% keyless (no Google API key or session cookie needed):

```bash
cd ../youtube
cp .env.example .env
docker compose up -d

curl "http://localhost:3000/v1/youtube/@mkbhd"
curl "http://localhost:3000/v1/youtube/@mkbhd/posts?limit=12"
curl "http://localhost:3000/v1/youtube/videos/dQw4w9WgXcQ/transcript?lang=en"
```

TikTok uses the same layout:

```bash
cd ../tiktok
cp .env.example .env
docker compose up -d
curl "http://localhost:3000/v1/tiktok/khaby.lame"
```

Documentation:
[Instagram README](socials/instagram/README.md) ·
[Instagram OpenAPI](socials/instagram/openapi.yaml) ·
[DevTools session helper](socials/instagram/scripts/devtools-session.js) ·
[YouTube README](socials/youtube/README.md) ·
[YouTube OpenAPI](socials/youtube/openapi.yaml) ·
[LinkedIn README](socials/linkedin/README.md) ·
[LinkedIn OpenAPI](socials/linkedin/openapi.yaml) ·
[TikTok README](socials/tiktok/README.md) ·
[TikTok OpenAPI](socials/tiktok/openapi.yaml)

## Connector contract

Every connector is expected to ship:

| File | Purpose |
| --- | --- |
| `README.md` | Setup, configuration, troubleshooting |
| `openapi.yaml` | API schema, also served at `GET /openapi.yaml` |
| `.env.example` | Documented configuration, never secrets |
| `LICENSE.md` link | MIT with attribution notice |
| `Dockerfile`, `docker-compose.yml` | One-command self-hosting |
| `package.json` | `start`, `dev` and `test` scripts |
| `tests/` | Offline tests with no external calls |
| `GET /health` | Liveness probe |

Conventions: no credentials committed to the repository, secrets never logged,
no paid dependency, and no intermediary service required to operate.

## Smoke test and demonstration

[`scripts/demo.sh`](scripts/demo.sh) audits every connector's `.env`, starts
all four on free ports, exercises every route (including error cases and data
policy gates) and prints a live demonstration. Secrets are never printed.

```bash
./scripts/demo.sh                 # audit + all routes + demo
./scripts/demo.sh --direct        # ignore proxies for the runtime
./scripts/demo.sh --fast          # shorter delay between upstream calls
./scripts/demo.sh --audit-only    # only validate the .env files
./scripts/demo.sh --yt-only       # YouTube only (also --ig-only / --li-only / --tt-only)
```

## Adding a connector

1. Create `socials/<name>/` or `services/<name>/`.
2. Follow the contract above and expose `GET /health`.
3. Add a row to the table in this file.
4. Add offline tests before opening a pull request.

## Status

Project under development. Connectors may have different stability levels
depending on the integrated service.

## License

MIT License with an attribution notice. See [LICENSE.md](LICENSE.md).

Use, modification and redistribution are permitted. Any project using this
work elsewhere must visibly credit **API Everything**.
