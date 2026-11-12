# TikTok Connector

A self-hosted connector that turns a TikTok profile URL into structured data,
served over a local HTTP API.

**Interface parity:** the endpoints, response shapes, logging, hot reload, proxy
support and diagnostics are deliberately identical to the
[Instagram connector](../instagram/README.md). Code written against one works
against the other, with `instagram` swapped for `tiktok` in the paths.

## What works out of the box

`GET /v1/tiktok/:username` resolves **exact** profile metadata anonymously —
no account, no cookie, no proxy — from the JSON blob TikTok server-renders into
every profile page (`__UNIVERSAL_DATA_FOR_REHYDRATION__`,
`webapp.user-detail.userInfo`).

```bash
curl "http://localhost:3000/v1/tiktok/khaby.lame"
```

```json
{
  "username": "khaby.lame",
  "profileId": "127905465618821121",
  "secUid": "MS4wLjABAAAAwAg0rSzO65WQfz4RzQgGv2Xdv108BgPXhRrrmNVIHQZ9PO8-flwwRtEppYTS0OjA",
  "followers": 162914070,
  "following": 82,
  "posts": 1358,
  "likes": 2693517927,
  "fullName": "Khabane lame",
  "biography": "Se vuoi ridere sei nel posto giusto...",
  "isPrivate": false,
  "isVerified": true,
  "isOrganization": false,
  "profilePicUrl": "https://p16-common-sign.tiktokcdn-eu.com/...jpg",
  "bioLink": null,
  "createdAt": "2016-08-10T22:02:34.000Z",
  "raw": null,
  "source": "user_detail"
}
```

## Honest limitation: the post list

TikTok is **not** Instagram. Instagram's logged-out web app answers an
anonymous GraphQL query with the whole post grid; TikTok signs its
`/api/post/item_list/` requests (`X-Bogus` / `X-Gnarly`) and returns an
**empty 200** to unsigned calls — including from a real headless browser on a
datacenter IP. The SSR profile payload contains no `itemList`.

So `/posts` exists with the exact same response shape, but relies on a chain of
independent sources. Run `/v1/diagnostics` to see which one answers for your
IP:

| Strategy | Requires | Notes |
| --- | --- | --- |
| `browser` | `TT_BROWSER=1` + Playwright | Renders the page and captures TikTok's own signed XHRs. Most likely to work from a clean residential IP |
| `ssr_itemlist` | — | Populated only for some accounts/regions |
| `item_list` | — | Direct unsigned attempt; reports `TT_ENDPOINT_BLOCKED` when signatures are required |
| `video_ids` | `?ids=<id>,<id>` | Resolves explicit video ids through video pages (full stats) or the unsigned oEmbed endpoint |

```bash
# Explicit video ids always work:
curl "http://localhost:3000/v1/tiktok/tiktok/posts?ids=7106635534684302597"

# Or enable the browser strategy:
npm i playwright && npx playwright install chromium
# .env: TT_BROWSER=1
curl "http://localhost:3000/v1/tiktok/khaby.lame/posts?limit=12"
```

When every source fails, the error is structured rather than a bare 429:

```json
{
  "error": {
    "code": "TT_ALL_STRATEGIES_FAILED",
    "message": "Every post source failed. See details and /v1/diagnostics.",
    "details": [
      { "strategy": "item_list", "code": "TT_ENDPOINT_BLOCKED" }
    ]
  }
}
```

## Quick start

```bash
cp .env.example .env
docker compose up -d

curl "http://localhost:3000/health"
curl "http://localhost:3000/v1/tiktok/khaby.lame"
```

Without Docker (Node 22+):

```bash
npm install
cp .env.example .env
node --env-file=.env server.js
```

## Endpoints

Identical layout to the Instagram connector:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Service info, active strategies, proxy state |
| GET | `/health` | Liveness + session/account + proxy check summary |
| GET | `/v1/session` | Session verification result |
| GET | `/v1/diagnostics?username=...` | Test each post strategy |
| GET | `/v1/proxies` | Full startup proxy probe results |
| GET | `/v1/tiktok/:username` | Exact profile metadata |
| GET | `/v1/tiktok/:username/posts?limit=12&cursor=...&ids=...` | Normalized posts |
| GET | `/openapi.yaml` | API schema |

`/posts` returns the same object as Instagram:
`{ username, profile, count, posts, nextCursor, hasMore, source, strategy,
anonymous, stickyProxy, failures }`.

Each post uses the same fields — `url`, `shortcode`, `userPosted`,
`description`, `hashtags`, `mentions`, `numComments`, `datePosted`,
`timestamp`, `likes`, `photos`, `videos`, `type`, `isVideo`, `location`,
`altText` — plus TikTok-specific extras: `shares`, `plays`, `collects`,
`duration`, `music`, `authorName`.

### Startup output and hot reload

The coloured banner, per-request logs, `Ctrl+R` hot reload and `Ctrl+C`
shutdown behave exactly like the Instagram connector. `Ctrl+R` re-reads `.env`,
rebuilds the proxy pool, re-verifies the session and reprints the banner.
Hotkeys are disabled automatically when stdin is not a TTY (Docker/CI).

Controls: `LOG_LEVEL`, `NO_COLOR`, `FORCE_COLOR`.

## Optional rotating proxies

Same behaviour as the Instagram connector. Both full URLs and bare
`user:pass@host:port` credentials are accepted, in `TT_PROXY_URL`,
`TT_PROXIES` and `TT_PROXIES_FILE`. Identical rotating lines are collapsed and
reported. At startup each proxy is probed for liveness, country, latency and
TikTok reachability, with one extra **direct** request so you can tell
`TT 0/1 ok · direct 200` (the exit IP is flagged) from a general outage.
Credentials are redacted in every log and API response.

`TT_PROXY_STICKY=1` pins one exit IP per request when a session is configured.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `TT_SESSIONID` | — | Session cookie; only needed for private accounts |
| `TT_USER_AGENT` | Chrome 131 | Browser UA |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP bind |
| `API_KEY` | — | Optional instance protection (header `X-API-Key`) |
| `TT_MIN_INTERVAL_MS` | `1000` | Minimum delay between two TikTok calls |
| `TT_MAX_PAGES` | `10` | Page limit per request |
| `TT_TIMEOUT_MS` | `15000` | Network timeout |
| `TT_POSTS_STRATEGIES` | all | Comma-separated strategy order |
| `TT_BROWSER` | `0` | `1` enables the Playwright strategy |
| `TT_BROWSER_WAIT_MS` | `12000` | Max scroll time in the browser strategy |
| `TT_PROXY_*` | — | Proxy pool and probe settings (see `.env.example`) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |

`limit` is capped at 100. Automatic pagination is supported when a strategy
returns `nextCursor`.

## Tests

```bash
npm test
```

14 offline tests cover normalization, SSR parsing, bare proxy credentials,
config reload, strategy ordering, diagnostics aggregation and error hints. No
network calls are made.

## Structure

```
server.js                 HTTP API, coloured banner, Ctrl+R, hotkeys
core/config.js            .env loader with hot-reload
core/http.js              axios wrapper, throttling, proxy rotation
core/rehydration.js       SSR JSON blob extraction
core/normalize.js         stable profile / post shapes
core/profile.js           profile resolver with cache
core/video.js             oEmbed + video detail page
core/strategies.js        post-source chain + diagnostics
core/posts.js             strategy chain + pagination
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

> Automated access to TikTok is subject to TikTok's Terms of Service. This
> connector is provided for self-hosted use; operators are responsible for how
> they use it.
