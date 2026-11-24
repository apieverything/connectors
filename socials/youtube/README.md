# YouTube Connector

A self-hosted, **keyless** connector for YouTube **channel metadata, paginated
videos & Shorts, video search, single-video details (with chapters), and caption
transcripts** — served over a local HTTP API.

Everything works **anonymously with zero Google API key**, zero quota project,
zero session cookie, and only `axios` on Node.js 22+.

## Why keyless YouTube matters

YouTube Data API v3 requires a Google Cloud project, enforces a strict daily
unit quota (`search.list` alone costs 100 units per call — 100 searches exhaust
an entire daily project quota), and blocks anonymous access to public video
transcripts (`captions.download` requires OAuth ownership of the video).

This connector talks directly to YouTube's public **InnerTube JSON API** with an
automatic **HTML `ytInitialData` / `ytInitialPlayerResponse` fallback**, sending
EU consent bypass cookies (`SOCS` + `CONSENT`) on every call so European IPs
never stall on `consent.youtube.com`.

## Quick start

```bash
cp .env.example .env
docker compose up -d

curl "http://localhost:3000/health"
curl "http://localhost:3000/v1/youtube/@mkbhd"
curl "http://localhost:3000/v1/youtube/@mkbhd/posts?limit=12"
curl "http://localhost:3000/v1/youtube/search?q=open+source&limit=5"
curl "http://localhost:3000/v1/youtube/videos/dQw4w9WgXcQ"
curl "http://localhost:3000/v1/youtube/videos/dQw4w9WgXcQ/transcript?lang=en"
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
| GET | `/` | Service info, active strategies, proxy state |
| GET | `/health` | Liveness + session/proxy summary |
| GET | `/v1/session` | Session configuration and proxy state |
| GET | `/v1/diagnostics?handle=@mkbhd` | Probe InnerTube and HTML strategies |
| GET | `/v1/proxies` | Full startup proxy health check results |
| GET | `/v1/youtube/:handle` | Channel metadata (`@handle`, `handle`, or `UC...` ID) |
| GET | `/v1/youtube/:handle/posts?limit=12&cursor=...` | Paginated channel videos & Shorts |
| GET | `/v1/youtube/search?q=...&limit=10&cursor=...` | Keyless video search |
| GET | `/v1/youtube/videos/:id` | Single-video details, likes, chapters, caption list |
| GET | `/v1/youtube/videos/:id/transcript?lang=en` | Full text + timestamped caption segments |
| GET | `/openapi.yaml` | OpenAPI 3.0.3 schema |

## Strategy chain & sobriety

| Strategy | Payload | Mechanism |
| --- | --- | --- |
| `innertube` (default #1) | ~25–65 KB JSON | `POST /youtubei/v1/browse`, `/search`, `/player`, `/navigation/resolve_url` (`WEB` + `ANDROID`/`IOS` player fallback for captions) |
| `html` (fallback #2) | ~350–650 KB HTML | `GET /@handle/videos`, `/results`, `/watch?v=...` parsed with a balanced-brace `ytInitialData` / `ytInitialPlayerResponse` scanner |

Media binaries (thumbnails and video streams) are never proxied: only clean metadata and thumbnail URLs are returned.

## Normalization highlights

- **Channel headers:** handles both classic `c4TabbedHeaderRenderer` and modern `pageHeaderRenderer.content.pageHeaderViewModel` (`metadataRows`).
- **Video cards:** normalizes `videoRenderer`, `gridVideoRenderer`, `richItemRenderer`, `reelItemRenderer`, `shortsLockupViewModel`, and `lockupViewModel` into API Everything's unified post envelope (`url`, `shortcode`, `videoId`, `title`, `userPosted`, `description`, `hashtags`, `mentions`, `views`, `duration`, `durationSeconds`, `datePosted`, `publishedText`, `photos`, `type: "video" | "short"`).
- **Chapters:** extracts structured engagement-panel `macroMarkersListItemRenderer` chapters first and falls back to parsing timestamps (`0:00 Intro`, `01:25 - Hardware`) from the video description.
- **Transcripts:** fetches `fmt=json3` events first and falls back to TimedText XML (`<text start="..." dur="...">` and srv3 `<p t="..." d="...">`), returning `404 YT_NO_TRANSCRIPT` when a video has no captions.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP bind |
| `API_KEY` | — | Optional local `X-API-Key` protection |
| `YT_STRATEGIES` | `innertube,html` | Comma-separated source chain |
| `YT_MIN_INTERVAL_MS` | `500` | Minimum delay between upstream requests |
| `YT_MAX_PAGES` | `5` | Max continuation pages per call |
| `YT_TIMEOUT_MS` | `15000` | Upstream HTTP timeout |
| `YT_HL` / `YT_GL` | `en` / `US` | InnerTube locale & region |
| `YT_PROXY_URL` / `YT_PROXIES` / `YT_PROXIES_FILE` | — | Optional rotating proxies (`user:pass@host:port` + `{session}` sticky support) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |

## Tests

```bash
npm test
```

Offline unit tests cover balanced-brace `ytInitialData` / `ytInitialPlayerResponse` extraction, `pageHeaderViewModel` and `c4TabbedHeaderRenderer` channel normalization, `videoRenderer` / `richItemRenderer` / Shorts normalization, continuation cursors, chapter timestamp parsing, XML and JSON3 transcripts, strategy fallback, HTTP route validation, bare proxy credentials, and `.env` hot-reload. Zero network calls are made during `npm test`.

## Structure

```text
server.js                 HTTP API, banner, Ctrl+R hot reload, hotkeys
core/config.js            .env loader with hot-reload
core/session.js           EU consent cookies, browser/mobile headers, typed errors
core/innertube.js         InnerTube JSON + HTML fallback strategy chain
core/parsing.js           balanced-brace JSON scanner, counts, chapters, XML/JSON3 transcripts
core/normalize.js         channel, video post, single-video & caption normalization
core/proxy.js             optional rotating proxy pool
core/proxycheck.js        startup liveness / country / latency probe
core/logger.js            coloured logs with query redaction
openapi.yaml              OpenAPI 3.0.3 schema
tests/unit.js             offline test suite
```

## License

MIT License with an attribution notice — see [`LICENSE.md`](../../LICENSE.md).
Use, modification and redistribution are permitted; any project using this
connector elsewhere must visibly credit **API Everything**.
