# Instagram Connector

A self-hosted connector that turns an Instagram profile URL into structured
data, served over a local HTTP API.

Fields returned for each post:

| Field | Content |
|---|---|
| `url` | Post URL |
| `userPosted` | Author |
| `description` | Full caption |
| `hashtags` | Extracted hashtags |
| `mentions` | Extracted `@` mentions |
| `numComments` | Comment count |
| `datePosted` | Publication date (ISO 8601) |
| `likes` | Like count |
| `photos` / `videos` | Media URLs |
| `type` | `image`, `video`, `carousel`, `reel` |
| `location` / `altText` | When available |

Plus exact profile stats (`followers`, `following`, `posts`, `fullName`,
`biography`, `isPrivate`).

## Why it is free forever

There is **no central server**. You run the API on your own machine, with your
own connection, your own IP and your own session cookie. No shared quota, no
paid key, no subscription, no third party: the only cost is your hardware.
MIT licensed — fork it, change it, redistribute it.

> Automated scraping is against Instagram's Terms of Use and can get the
> account you use blocked. Use a dedicated account, keep `IG_MIN_INTERVAL_MS`
> reasonable, and never commit your cookie to a repository.

## Posts work out of the box

**No Instagram account, no cookie, no proxy required.** The connector uses
Instagram's own logged-out profile grid query (the same request the web app
makes when you are not signed in):

```
POST /api/graphql   doc_id 27553725110923321
variables { "first": 12, "username": "kametolol" }
-> data.xig_user_by_username.polaris_ordered_timeline_connection.edges[]
```

Verified end-to-end: real posts returned in ~1.3 s with `IG_SESSIONID` unset
and every `IG_PROXY_*` unset. This path is unaffected by the retired
`web_profile_info` endpoint and by the 403 on the authenticated
`PolarisProfilePostsQuery`.

```bash
curl "http://localhost:3000/v1/instagram/kametolol/posts?limit=12"
```

The grid returns `url`, `userPosted`, `description`, `hashtags`, `photos`,
`type`, `altText` and a day-level `datePosted` (parsed from the accessibility
caption). `likes`, `numComments` and the exact timestamp need one extra
anonymous request per post — set `IG_ENRICH_POSTS=1` to enable it:

```json
{ "shortcode": "DfpVTKbxkfX", "likes": 1897, "numComments": 14, "datePosted": "2026-11-12T00:00:00.000Z" }
```

### The `profile` object in `/posts`

The grid itself only returns `pk` + `id`, so the connector resolves the profile
with a **second anonymous query** (`doc_id 27981003384861049`,
`PolarisLoggedOutDesktopWWWProfileRootContentQuery`) and reuses the
`og:description` of the page it already fetched. Result: **exact** counts, no
session needed.

```json
{
  "username": "kametolol",
  "profileId": "249851437",
  "followers": 399230,
  "following": 368,
  "posts": 35,
  "fullName": "Kameto",
  "biography": "J'emmène la misère en balade - @karminecorp @karasu_kl",
  "isPrivate": false,
  "isVerified": true,
  "profilePicUrl": "https://scontent-...cdninstagram.com/...jpg",
  "externalUrl": null,
  "category": null,
  "isBusiness": false,
  "bioLinks": [
    { "title": "En live tous les soirs ici", "url": "http://twitch.tv/kamet0" },
    { "title": "Mon tiktok", "url": "https://www.tiktok.com/@kametotv?lang=fr" }
  ],
  "source": "anon_user_info"
}
```

Compare with `og:description`, which rounds (`399K` → 399000) and can be stale
for `following`. `GET /v1/instagram/:username` also returns these exact fields
now (plus `raw`, `source` and `exactSource` for backwards compatibility).
Results are cached for 10 minutes per username.

Private profiles still need `IG_SESSIONID`.

## Quick start

### With Docker (recommended)

```bash
cp .env.example .env
# no IG_SESSIONID needed for public posts
docker compose up -d
curl http://localhost:3000/health
```

### Without Docker (Node 22+)

```bash
npm install
cp .env.example .env
node --env-file=.env server.js
```

## Startup output

On boot the server prints a coloured banner, verifies the session and then logs
every request with its status, duration and the data source that answered:

```
┌────────────────────────────────────────────────────────────────┐
│  API Everything · Instagram connector  v1.0.0                   │
│  Self-hostable · free · no central service                       │
└────────────────────────────────────────────────────────────────┘
  Listening   http://0.0.0.0:3000
  Docs        GET /openapi.yaml
  Proxies     disabled (direct connection)
  Stats       web_profile_info → og:description fallback
  Session     ✓ @your_account (Your Name) · verified
  Hotkeys     Ctrl+R reload · Ctrl+C stop

15:28:22 › Checking    3 proxies in parallel...
  Check       ✓ 3/3 alive · avg 141ms · 98–184ms · FR:3 · IG 2/3 ok (429×1) · direct 200
              #1   FR    98ms  ✓  IG:200  ***:***@resi.example.su:80
              #2   DE   184ms  ✓  IG:200  ***:***@proxy2.example:80
              #3   FR   142ms  ✓  IG:429  ***:***@blocked.example:80

15:28:22 200 GET  /v1/instagram/kametolol          939ms  og:description
```

### Hot reload — `Ctrl+R`

Press **Ctrl+R** in the terminal running the server and the whole config is
reloaded exactly as if you had restarted it:

1. `.env` is re-read from disk (`IG_ENV_FILE` points elsewhere if needed).
2. `IG_SESSIONID`, API key, log level, timeouts, proxy settings, ... are
   re-applied. Explicit CLI/container overrides (e.g. `PORT=4000 node ...`) are
   detected and never clobbered.
3. The proxy pool is rebuilt and validated. A bad edit logs an error and keeps
   the **previous working pool** instead of breaking the server.
4. If `PORT`/`HOST` changed, the listener is closed and rebound.
5. The session is verified again, the banner is reprinted and the changed key
   names are listed (values of secrets are never logged).

`Ctrl+C` stops the server cleanly. Hotkeys are only active when the server runs
in an interactive TTY; in Docker/CI they are disabled automatically, so piping
logs still works normally.

The account line comes from `GET /api/v1/accounts/current_user/` (with a
fallback to the mobile `users/{ds_user_id}/info` endpoint) — the connector
resolves **which Instagram account** your `IG_SESSIONID` belongs to and shows it
as `@username`. If the cookie is dead or throttled, it says
`configured but not verified` with the error code instead of crashing. The same
information is available at `GET /v1/session`, `GET /health` and `GET /`.

Controls:

- `IG_VERIFY_SESSION=0` skips the check (faster / fully offline startup).
- `LOG_LEVEL=debug|info|warn|error|silent` filters output.
- Colours auto-disable when piping to a file or under `NO_COLOR=1`;
  `FORCE_COLOR=1` forces them on.
- `api_key` and other secret query parameters are redacted in request logs.

## Getting the session cookie

**A session is optional.** Public posts are fetched through the logged-out
GraphQL grid (see [Posts work out of the box](#posts-work-out-of-the-box)), so
you only need a cookie for **private profiles**. (The static HTML itself does
not contain posts — verified: zero occurrences of
`edge_owner_to_timeline_media` — the grid is a separate JSON query.)

### One-paste method (recommended)

Sign in to instagram.com, open DevTools (F12), and paste the whole snippet below
into the **Console**. It builds a ready-to-paste `.env` block and copies it to
your clipboard. It runs entirely locally: no `fetch`, no network request,
nothing is sent anywhere.

> Chrome may ask you to type `allow pasting` before it lets you paste code into
> the console.

```js
/* API Everything - Instagram connector
 * Paste this WHOLE file into the DevTools console (F12) while on
 * https://www.instagram.com/ and logged in.
 * Runs ENTIRELY locally: no fetch, no network request, nothing is sent anywhere.
 */
(async () => {
  const KEYS = ["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did", "rur", "datr"];
  const jar = {};
  const put = (name, value) => {
    if (name && value && !jar[name]) jar[name] = value;
  };

  // 1. Cookie Store API (Chrome/Edge/Safari/Firefox, secure contexts).
  try {
    if (typeof cookieStore !== "undefined") {
      for (const cookie of await cookieStore.getAll()) put(cookie.name, cookie.value);
    }
  } catch (err) {
    console.warn("[ig] cookieStore unavailable, using document.cookie:", err.message);
  }

  // 2. document.cookie: everything that is not HttpOnly.
  document.cookie.split(";").forEach((part) => {
    const sep = part.indexOf("=");
    if (sep === -1) return;
    put(part.slice(0, sep).trim(), part.slice(sep + 1).trim());
  });

  // 3. Pull values out of a "Copy as cURL" / raw Cookie header string.
  const parseCookieText = (text) => {
    const found = {};
    for (const key of KEYS) {
      const match = String(text).match(new RegExp(`(?:^|[;\\s'"])${key}=([^;'"\\s]+)`));
      if (match) found[key] = match[1];
    }
    return found;
  };

  if (!jar.sessionid) {
    console.warn(
      "[ig] sessionid is HttpOnly, so JavaScript cannot read it.\n" +
        "DevTools > Network > right-click a request to www.instagram.com > Copy > Copy as cURL,\n" +
        "then paste it into the prompt (a raw Cookie header works too)."
    );
    const pasted =
      typeof prompt === "function"
        ? prompt("Paste 'Copy as cURL' (or the Cookie header) to fill IG_SESSIONID:")
        : null;
    if (pasted) {
      for (const [key, value] of Object.entries(parseCookieText(pasted))) put(key, value);
    }
  }

  const env = [
    "# API Everything - Instagram connector (generated from DevTools)",
    `IG_SESSIONID=${jar.sessionid ?? ""}`,
    `IG_CSRFTOKEN=${jar.csrftoken ?? ""}`,
    `IG_DS_USER_ID=${jar.ds_user_id ?? ""}`,
    `IG_USER_AGENT=${navigator.userAgent}`,
  ].join("\n");

  // DevTools exposes copy(); browsers without it get the Clipboard API.
  try {
    if (typeof copy === "function") copy(env);
    else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(env);
  } catch (err) {
    console.warn("[ig] could not write to the clipboard, select the block below:", err.message);
  }

  console.log("[ig] --- .env (copied to clipboard) ---");
  console.log(env);
  console.log("[ig] -----------------------------------");

  if (!jar.sessionid) {
    console.error(
      "[ig] IG_SESSIONID is still empty. Fallback: DevTools > Application (Storage in " +
        "Firefox) > Cookies > https://www.instagram.com > copy the sessionid value by hand."
    );
  } else {
    console.log("[ig] Done. Paste the block above into your .env, then restart the connector.");
  }
})();
```

The same snippet lives in [`scripts/devtools-session.js`](scripts/devtools-session.js)
so you can also open the file and copy it from there.

**Why a prompt appears.** `sessionid` is set with the `HttpOnly` flag on
instagram.com, so browser JavaScript is not allowed to read it — both
`document.cookie` and `cookieStore.getAll()` omit it. That is an XSS protection,
not a limitation of this connector. `csrftoken`, `ds_user_id`, `mid`, `ig_did`,
`rur` and the User-Agent **are** readable and are filled in automatically.

For `sessionid`, the script asks you to paste a `Copy as cURL`: the `Cookie`
request header of any real request does contain the HttpOnly cookie.

1. DevTools -> **Network** -> refresh the page.
2. Right-click any request to `www.instagram.com` -> **Copy** -> **Copy as cURL**.
3. Paste it into the prompt (a raw `Cookie:` header works too).

Result in your clipboard:

```dotenv
IG_SESSIONID=12345678901%3Axxxxxxxxxxxx%3A17%3A...
IG_CSRFTOKEN=abc123...
IG_DS_USER_ID=12345678901
IG_USER_AGENT=Mozilla/5.0 ... Chrome/131.0.0.0 Safari/537.36
```

Paste it into `.env` and restart the connector. If Instagram ever drops the
`HttpOnly` flag, the prompt simply never appears.

### Manual fallback

If you would rather not run a script: DevTools -> **Application** (*Storage* in
Firefox) -> **Cookies** -> `https://www.instagram.com`, then copy `sessionid`,
`csrftoken` and `ds_user_id` by hand. Keep `IG_USER_AGENT` consistent with that
browser, or Instagram raises a checkpoint.

The cookie lasts several months. When it expires the API returns
`IG_SESSION_EXPIRED` with the fix, instead of silently failing to parse.

`GET /v1/instagram/:username` (stats) works **with or without** a cookie thanks
to a two-source strategy:

| Session | Source | Counts |
|---|---|---|
| configured | `web_profile_info` (falls back to `og:description` on 429 / errors) | exact |
| absent | `og:description` only | rounded (`399K` -> `399000`) |

The fallback deliberately stays **anonymous**: a logged-in session makes
Instagram serve the SPA shell, which has no `og:description` tag at all. That is
why the HTML path always uses the minimal crawler UA and never sends the cookie.
`.../posts` now also works **anonymously** (public profiles only, via
`graphql_posts` with its anonymous doc_id and `web_profile_info_anon`). A
session is still needed for private profiles. Set
`IG_ALLOW_ANONYMOUS_POSTS=0` to restore the old strict behaviour.

## Usage

```bash
# Which account is behind IG_SESSIONID?
curl "http://localhost:3000/v1/session"

# Full proxy health check (alive / country / ms / IG status per proxy)
curl "http://localhost:3000/v1/proxies"

# Which post-fetching strategy answers with your account?
curl "http://localhost:3000/v1/diagnostics?username=kametolol"

# Profile stats (works with or without a session)
curl "http://localhost:3000/v1/instagram/kametolol"

# 12 most recent posts
curl "http://localhost:3000/v1/instagram/kametolol/posts?limit=12"

# Next page
curl "http://localhost:3000/v1/instagram/kametolol/posts?limit=12&cursor=<nextCursor>"
```

If you set `API_KEY`, add `-H "X-API-Key: <your-key>"`.
CORS is open (`*`), so the API is callable directly from a frontend.
Full schema: `GET /openapi.yaml`.

### Example response

```json
{
  "username": "kametolol",
  "profile": {
    "fullName": "Kameto",
    "biography": "...",
    "isPrivate": false,
    "followers": 399123,
    "following": 374,
    "posts": 34
  },
  "count": 1,
  "posts": [
    {
      "url": "https://www.instagram.com/p/Cxxxxxxx/",
      "shortcode": "Cxxxxxxx",
      "userPosted": "kametolol",
      "description": "Great night #Kameto #Live @someone",
      "hashtags": ["#Kameto", "#Live"],
      "mentions": ["@someone"],
      "numComments": 142,
      "datePosted": "2025-09-14T18:32:07.000Z",
      "timestamp": 1757874727,
      "likes": 28411,
      "photos": ["https://scontent-xxx.cdninstagram.com/...jpg"],
      "videos": [],
      "type": "image",
      "isVideo": false,
      "location": null,
      "altText": null
    }
  ],
  "nextCursor": "QVFE...",
  "hasMore": true
}
```

Note: unlike `og:description` (which rounds "399K" to 399000), counters here
are **exact**.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `IG_SESSIONID` | — | Session cookie; needed for private profiles (optional for public posts) |
| `IG_ALLOW_ANONYMOUS_POSTS` | `1` | Allow `/posts` without a session; `0` disables |
| `IG_GQL_POSTS_DOC_ID_ANON` | `37691262543822084` | Anonymous `PolarisProfilePostsQuery` doc_id |
| `IG_PROXY_CHECK_IG_COMPARE` | `1` | Also probe Instagram **without** the proxy (`direct 200`) |
| `IG_CSRFTOKEN` | — | CSRF token (recommended) |
| `IG_DS_USER_ID` | — | Account id (recommended) |
| `IG_USER_AGENT` | Chrome 131 | Must match the browser that created the cookie |
| `IG_CRAWLER_USER_AGENT` | `Mozilla/5.0` | UA for anonymous HTML |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP bind |
| `API_KEY` | — | Optional, protects your exposed instance |
| `IG_VERIFY_SESSION` | `1` | Resolve `@account` from the session at boot; `0` skips it |
| `IG_VERIFY_TIMEOUT_MS` | `8000` | Max time spent resolving the account |
| `IG_ENV_FILE` | `.env` | Path to the env file reloaded on `Ctrl+R` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `NO_COLOR` / `FORCE_COLOR` | auto | Disable or force ANSI colours |
| `IG_PROXY_CHECK` | `1` | Probe proxies at boot; `0` disables |
| `IG_PROXY_CHECK_URL` | auto | Custom geo/IP endpoint for the probe |
| `IG_PROXY_CHECK_CONCURRENCY` | `5` | Parallel probes |
| `IG_PROXY_CHECK_TIMEOUT_MS` | `8000` | Per-probe timeout |
| `IG_PROXY_CHECK_IG` | `1` | Also probe Instagram; `0` disables |
| `IG_PROXY_CHECK_IG_URL` | profile HTML | Custom endpoint for the IG probe |
| `IG_PROXY_CHECK_IG_UA` | browser UA | UA used for the IG probe |
| `IG_POSTS_STRATEGIES` | all 4 | Comma-separated strategy order |
| `IG_GQL_POSTS_DOC_ID` | `34579740524958711` | `PolarisProfilePostsQuery` doc_id |
| `IG_GQL_ENDPOINT` | `/graphql/query` | GraphQL endpoint |
| `IG_GQL_API_ENDPOINT` | `/api/graphql` | Endpoint used by `anon_grid` |
| `IG_GQL_GRID_DOC_ID` | `27553725110923321` | Logged-out grid, first page |
| `IG_GQL_GRID_PAGE_DOC_ID` | `27389614800735091` | Logged-out grid, pagination |
| `IG_GQL_POST_DETAIL_DOC_ID` | `26713194205046842` | Per-post detail for enrichment |
| `IG_GQL_PROFILE_DOC_ID` | `27981003384861049` | Logged-out profile query (exact counts) |
| `IG_GQL_BOOTSTRAP` | `1` | Fetch `csrftoken` from the profile page first |
| `IG_ENRICH_POSTS` | `0` | `1` fills likes / comments / exact date |
| `IG_ENRICH_MAX` | `12` | Max posts enriched per request |
| `IG_PROXY_STICKY` | `1` | Pin one exit IP per request; `0` rotates |
| `IG_ASBD_ID` | `198387` | Web client header |
| `IG_MIN_INTERVAL_MS` | `1000` | Minimum delay between two Instagram calls |
| `IG_MAX_PAGES` | `10` | Page limit per request (12 posts per page) |
| `IG_TIMEOUT_MS` | `15000` | Network timeout |

`limit` is capped at 100. Pagination is automatic: asking for 50 posts walks
several pages while `nextCursor` is present.

## Optional rotating proxies

Fully optional. **Leave all `IG_PROXY_*` values empty and everything connects
directly**, exactly as before. This is what a residential provider dashboard
typically gives you:

```
HOST      resi.example.su
PORT      80
USERNAME  exampleuser
PASSWORD  examplepass
```

**Just paste the credential string** — `http://` is added automatically:

```dotenv
IG_PROXY_URL=exampleuser:examplepass@resi.example.su:80
```

The explicit URL form works too:

```dotenv
IG_PROXY_URL=http://exampleuser:examplepass@resi.example.su:80
```

Both forms are accepted in `IG_PROXY_URL`, `IG_PROXIES` and
`IG_PROXIES_FILE`. Credentials are redacted in every log and error message,
including for the bare form.

Or provide a pool (comma-separated, or one URL per line in a file):

```dotenv
IG_PROXIES=http://u:p@host1:80,http://u:p@host2:80,http://u:p@host3:80
# or: IG_PROXIES_FILE=/app/proxies.txt
IG_PROXY_ROTATION=round-robin        # or random
IG_PROXY_MAX_RETRIES=2              # extra attempts on 429/network/upstream errors
IG_PROXY_COOLDOWN_MS=60000          # failed proxy is skipped for 60s
```

Behaviour:

- Every outgoing request picks the next entry (`round-robin`) or a random one.
- On `429`, network or upstream errors, that entry is cooled down and the
  request is retried through another one. Auth/session errors are **not**
  retried, since switching IP cannot fix them.
- With a single proxy, retries still help when the provider rotates the exit IP
  server-side on each connection.
- Credentials are never logged or exposed: `/health` and `/` only report
  `{ enabled, count, rotation, ... }`.

### Startup health check

When proxies are configured, the connector probes **each one at boot** (and
again on `Ctrl+R`) in parallel and reports:

- **alive / total** — any HTTP answer means the tunnel works; `407` (bad proxy
  credentials), timeouts and connection errors count as dead;
- **country code** — the 2-letter code of the exit IP (`FR`, `DE`, `US`, ...);
- **latency** — per proxy and `avg` / `min` / `max` in milliseconds;
- **IG status** — a second probe against the Instagram endpoint itself
  (`IG:200` / `IG:429`). `IG 0/10 ok` means the proxies are healthy but Meta
  rejects them — see [Troubleshooting](#posts-returns-429-even-though-every-proxy-is-alive).
  `IG_PROXY_CHECK_IG=0` disables this second probe.

Dead entries are cooled down immediately so they are skipped by the rotation
until the next reload. Labels in logs are redacted (`***:***@host:port`).

```
15:28:22 › Checking    3 proxies in parallel...
  Check       ✓ 3/3 alive · avg 141ms · 98–184ms · FR:3 · IG 2/3 ok (429×1) · direct 200
              #1   FR    98ms  ✓  IG:200  ***:***@resi.example.su:80
              #2   DE   184ms  ✓  IG:200  ***:***@proxy2.example:80
              #3   FR   142ms  ✓  IG:429  ***:***@blocked.example:80
```

The check is **non-blocking**: the HTTP server is already listening while it
runs. With more than 8 proxies only the summary plus failures are printed;
`LOG_LEVEL=debug` prints every entry, and `GET /v1/proxies` always returns the
full result. Results are also summarised as `proxyCheck` in `/`, `/health` and
`/v1/session`.

Geo/IP endpoints are tried in order until one returns a country code:
`ipwho.is` → Cloudflare `cdn-cgi/trace` (`loc=FR`) → `ipinfo.io`. Set
`IG_PROXY_CHECK_URL` to use your own. `IG_PROXY_CHECK=0` disables the check
entirely (useful offline), `IG_PROXY_CHECK_CONCURRENCY` (default `5`) and
`IG_PROXY_CHECK_TIMEOUT_MS` (default `8000`) control the probe load.

### Residential dashboard settings (Maskify / similar)

If your generator emits **10 identical lines** (rotating mode), the pool
collapses them into **1 endpoint** and the banner says
`1 configured · 9 identical lines collapsed (rotating generator)`. That is
expected: server-side rotation happens per request on that one credential.

Recommended generator settings for an authenticated Instagram session:

| Setting | Don't | Do | Why |
|---|---|---|---|
| Proxy type | `ROTATING` | **`STICKY / STATIC`** | A session cookie must keep one IP; rotating it triggers checkpoints and 429 |
| TTL | `60 s` | **longest available** (30 min – 24 h) | No IP change in the middle of a paginated request |
| Country | `Random` | **one fixed country** (the account's own, e.g. `FR`) | FR → US → DE hops in minutes is a textbook anti-bot signal |
| Continent | `Any` | **same as the country** | Consistency |
| Quantity | `10` | **1** (or a few *distinct* sticky endpoints) | Rotating generators produce one repeated string |
| Output format | — | **`user:pass@host:port`** ✅ | Accepted as-is by this connector |

Connector-side settings to match:

```dotenv
IG_PROXY_STICKY=1              # one exit IP per request (default)
IG_PROXY_MAX_RETRIES=1         # rotating the same endpoint again is pointless
IG_MIN_INTERVAL_MS=3000        # stay polite on a single IP
IG_PROXY_ROTATION=round-robin
```

> The IG probe now defaults to a **profile HTML page** with a browser
> User-Agent, not the retired `web_profile_info` endpoint. A `429` there was a
> false negative: that endpoint answers 429 to everyone. `IG 0/1 ok` now means
> Instagram really rejects the IP. Set `IG_PROXY_CHECK_IG_URL` to point at any
> other endpoint if you want to probe something else.

### Sticky residential sessions

Rotating the IP on every request while replaying a logged-in cookie is a good
way to trigger an Instagram checkpoint. If your provider supports sticky
sessions, put `{session}` wherever it expects a session id:

```dotenv
IG_PROXY_URL=user-session-{session}:pass@resi.example.su:80
IG_PROXY_SESSION=            # empty = stable id generated per process
IG_PROXY_SESSION_TTL_MS=86400000   # optional: rotate the id every 24h
```

`IG_PROXY_SESSION_TTL_MS=0` keeps the same id for the process lifetime.
`GET /health` shows `sessionExpiresAt` when a TTL is set — the equivalent of the
"Expires in 23h 59m" on a provider dashboard.

When using `IG_PROXIES_FILE` with Docker, mount the file as a volume (see the
comment in `docker-compose.yml`); it is excluded from the build context so
credentials never end up in an image layer.

> Proxy support uses axios' built-in `proxy` option (tested with an
> authenticated HTTP CONNECT proxy). No extra dependency is required.
> `http://` and `https://` proxy URLs are supported; SOCKS needs an external
> agent and is not handled here.

## Troubleshooting

| Code | Cause |
|---|---|
| `IG_SESSION_MISSING` (401) | `.env` has no `IG_SESSIONID` |
| `IG_SESSION_EXPIRED` (401) | Cookie dead or checkpoint -> sign in again |
| `IG_RATE_LIMITED` (429) | IP throttled -> raise `IG_MIN_INTERVAL_MS`, lower `IG_MAX_PAGES`, or enable proxies |
| `IG_PRIVATE_PROFILE` (403) | Private account, not followed by the session |
| `IG_UNEXPECTED_RESPONSE` (502) | Instagram changed its response format -> see `details` |
| `IG_ALL_STRATEGIES_FAILED` (502) | Every post source failed -> see `details` and `/v1/diagnostics` |
| `IG_USER_NOT_FOUND` (404) | Profile does not exist |
| `IG_PROXY_CONFIG_ERROR` (500) | Bad `IG_PROXY_*` value; startup fails with a readable message |

### `/posts` returns 429 even though every proxy is "alive"

This is the most common failure, and **adding more proxies does not fix it**.
Two separate things are going on:

1. **"Alive" only meant "reaches ipwho.is".** The startup check now also probes
   a **real Instagram page** (with a browser UA) and reports `IG 0/10 ok
   (429×10)`. A whole residential provider can be alive but blanket-throttled
   by Meta. If all 10 generated lines are identical, see
   [Residential dashboard settings](#residential-dashboard-settings-maskify--similar).
2. **`api/v1/users/web_profile_info/` is retired for signed-in sessions.**
   Meta stopped answering it for logged-in accounts (429 / `feedback_required`
   for everyone, regardless of cookie validity). Rotating 10 IPs at one dead
   endpoint just produces 10 identical 429s — and replaying one cookie from 10
   IPs in a few seconds is itself an anti-bot red flag.

The connector therefore uses a **chain of independent post strategies**, tried
in order until one answers:

| Strategy | What it does |
|---|---|
| `anon_grid` | **Primary.** `POST /api/graphql` with `PolarisLoggedOutDesktopWWWProfilePostsTabContentQuery` — the logged-out web app's own grid. Works with no session and no proxy |
| `graphql_posts` | `POST /graphql/query` with `PolarisProfilePostsQuery` (session variant) |
| `web_profile_info_anon` | Legacy REST endpoint **without** the cookie |
| `web_profile_info_mobile` | Same endpoint on `i.instagram.com` |
| `web_profile_info` | Legacy REST endpoint with the session |

Headers now match the web client (`X-ASBD-ID`, `X-Instagram-AJAX`, `Referer`,
`X-CSRFToken`, `Origin`), and **one proxy is pinned for the whole request**
(`IG_PROXY_STICKY=1`) instead of rotating the cookie across IPs.

To find out which strategy works with **your** account:

```bash
curl "http://localhost:3000/v1/diagnostics?username=kametolol"
```

```json
{
  "order": ["graphql_posts", "web_profile_info_anon", "..."],
  "strategies": [
    { "strategy": "graphql_posts", "ok": true, "posts": 1, "ms": 240 },
    { "strategy": "web_profile_info_anon", "ok": false, "code": "IG_RATE_LIMITED" }
  ]
}
```

Then pin the winner, e.g. `IG_POSTS_STRATEGIES=graphql_posts`. Meta rotates
`doc_id`s every few months: when GraphQL starts failing, set a current one with
`IG_GQL_POSTS_DOC_ID=...` — **no code change needed**. The current default is
`34579740524958711`; `GET /` reports the active strategy order and doc_id.

Two other known factors if everything still 429s:

- Instagram enforces **HTTP/2** on some hosts and throttles HTTP/1.1 (axios is
  HTTP/1.1). A proxy that negotiates HTTP/2 can help.
- A `400 feedback_required` or `403` from GraphQL usually means the session is
  flagged; refresh `IG_SESSIONID` and use one sticky IP.

### `IG 0/1 ok (429×1)` : is it the proxy or my connection?

The check now makes **one extra request without the proxy** and prints the
result next to it:

```
Check   ✓ 1/1 alive · FR:1 · IG 0/1 ok (429×1) · direct 200
```

- `direct 200` + `IG 429` → **Meta rejects this exit IP**. It is burned or the
  provider's ASN is blocked. Regenerate the credentials, change country, or
  change provider. No dashboard setting will fix a burned IP.
- `direct 429` too → your own IP / the whole network is throttled.
- `LOG_LEVEL=debug` prints the first 160 characters of the probe response and
  the `Server` header, so you can tell an Instagram 429 from the proxy
  gateway's own error page.

> If `.env` still contains
> `IG_PROXY_CHECK_IG_URL=.../web_profile_info/...`, **remove it**: that endpoint
> answers 429 to everyone and produces a false negative. The startup log warns
> about it.

### "Should I put my credentials directly?" / "What about staying anonymous?"

- If you mean the **proxy dashboard credentials** (`user:pass@host:port`):
  that is already exactly what the connector uses, and the single line tied to
  the active session (`ACTIVE SESSIONS 01`) is the right one. Nothing to change.
- If you mean an **Instagram username/password login**: **no, it will not
  help.** The 429 comes from the IP and the endpoint, not from how you
  authenticate. An automated login would produce the *same* `sessionid`, from
  the *same* IP, on top of a heavily protected login flow (RSA-encrypted
  password, CSRF, 2FA/checkpoint, device fingerprint) with a real risk of
  getting the account blocked. This was the first option ruled out at the very
  beginning of the project.

- **Staying anonymous: yes, location then barely matters.** With no cookie
  there is no account-bound identity jumping between countries — this is the
  one case where `ROTATING` proxies actually make sense. `/posts` now works
  **without a session** for public profiles (`IG_ALLOW_ANONYMOUS_POSTS=1`,
  `IG_GQL_POSTS_DOC_ID_ANON` + `web_profile_info_anon`), and the proxy is no
  longer pinned in that mode. Private profiles still require a session.

In practice `anon_grid` answers 200 even from a plain datacenter IP, so the
simplest working setup is: **no `IG_SESSIONID`, no `IG_PROXY_*`**. The
`direct 200` diagnostic still matters if you do use proxies: when the direct
connection works but the proxy does not, the provider is what needs to change,
not the authentication mode.

On `/v1/instagram/:username`, a `429` from the internal API is **not** an error:
the connector logs a warning and silently falls back to the anonymous
`og:description` page. If both sources fail, `details` contains `apiError`,
`hasOgDescription` and `htmlBytes` so you can tell which path broke. A
`configured but not verified` line at startup means the cookie should be
refreshed, but the stats endpoint keeps working.

Instagram changes its response shapes often, so `core/normalize.js` deliberately
accepts several field aliases (`code`/`shortcode`,
`like_count`/`edge_liked_by.count`, `caption.text`/`edge_media_to_caption`, ...)
to limit breakage.

## Tests

```bash
npm test                 # 64 offline tests: normalization, proxies, reload, strategies, grid, profile
node main.js             # demo: profile stats, no session needed
```

The DevTools snippet is executed in a sandboxed fake-browser context, and the
copy embedded in this README is tested as well, so the two can never drift.

## Structure

```
server.js                          HTTP API, Ctrl+R reload, hotkeys, session check
core/config.js                     .env loader with hot-reload
core/session.js                    cookie, headers, typed errors
core/proxy.js                      optional rotating proxy pool (bare URLs OK)
core/proxycheck.js                 startup liveness / country / latency probe
core/identity.js                   resolve the account behind a session
core/logger.js                     colours, banner, redacted request logs
core/fetch.js                      Instagram calls (GET/POST) + og:description fallback
core/strategies.js                 pluggable post sources + /v1/diagnostics
core/profile.js                    unified profile resolver (exact counts)
core/posts.js                      strategy chain + pagination
core/normalize.js                  stable output shape (posts + profile)
core/parsing.js                    counters + hashtag/mention extraction
scripts/devtools-session.js        one-paste DevTools .env generator
tests/devtools-session.test.js     tests the snippet without a browser
openapi.yaml                       API schema
```

## License

MIT License with an attribution notice — see
[`LICENSE.md`](../../LICENSE.md). Use, modification and redistribution are
permitted; any project using this connector elsewhere must visibly credit
**API Everything**.

> Automated access to Instagram is subject to Instagram's Terms of Use. This
> connector is provided for self-hosted use; operators are responsible for how
> they use it.
