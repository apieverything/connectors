"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { config } = require("./core/config");

// Re-read .env before anything else reads process.env.
config.load();

const { getProfileStats } = require("./core/fetch");
const { getProfile } = require("./core/profile");
const { getPosts, parseLimit } = require("./core/posts");
const { strategyOrder, runDiagnostics } = require("./core/strategies");
const { readSession, InstagramError } = require("./core/session");
const { getPool, reloadPool, redact } = require("./core/proxy");
const { checkProxies, applyResults, compact } = require("./core/proxycheck");
const { verifySession } = require("./core/identity");
const logger = require("./core/logger");
const { log } = logger;

const pkg = require("./package.json");
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

// Dynamic getters: these must pick up edits to .env on Ctrl+R.
const port = () => Number(process.env.PORT ?? 3000);
const host = () => process.env.HOST ?? "0.0.0.0";
const apiKey = () => process.env.API_KEY?.trim() || null;
const verifyEnabled = () => process.env.IG_VERIFY_SESSION !== "0";
const verifyTimeout = () => Math.max(1000, Number(process.env.IG_VERIFY_TIMEOUT_MS ?? 8000));

const CONFIG_KEYS = [
  "IG_SESSIONID", "IG_CSRFTOKEN", "IG_DS_USER_ID", "IG_USER_AGENT",
  "IG_CRAWLER_USER_AGENT", "IG_PROXY_URL", "IG_PROXIES", "IG_PROXIES_FILE",
  "IG_PROXY_ROTATION", "IG_PROXY_MAX_RETRIES", "IG_PROXY_COOLDOWN_MS",
  "IG_PROXY_SESSION", "IG_PROXY_SESSION_TTL_MS",
  "IG_PROXY_CHECK", "IG_PROXY_CHECK_URL", "IG_PROXY_CHECK_TIMEOUT_MS",
  "IG_PROXY_CHECK_CONCURRENCY", "IG_PROXY_CHECK_UA", "IG_PROXY_CHECK_IG",
  "IG_PROXY_CHECK_IG_URL", "IG_POSTS_STRATEGIES", "IG_GQL_POSTS_DOC_ID",
  "IG_GQL_ENDPOINT", "IG_GQL_FRIENDLY_NAME", "IG_GQL_POSTS_DOC_ID_ANON",
  "IG_GQL_API_ENDPOINT", "IG_GQL_GRID_DOC_ID", "IG_GQL_GRID_PAGE_DOC_ID",
  "IG_GQL_POST_DETAIL_DOC_ID", "IG_GQL_PROFILE_DOC_ID", "IG_GQL_BOOTSTRAP",
  "IG_ENRICH_POSTS", "IG_ENRICH_MAX",
  "IG_PROXY_STICKY", "IG_ASBD_ID", "IG_ALLOW_ANONYMOUS_POSTS",
  "IG_PROXY_CHECK_IG_COMPARE", "API_KEY", "LOG_LEVEL",
  "PORT", "HOST", "IG_VERIFY_SESSION", "IG_MIN_INTERVAL_MS", "IG_MAX_PAGES",
  "IG_TIMEOUT_MS", "NO_COLOR", "FORCE_COLOR",
];

// Fail fast with a readable message instead of a stack trace on a bad proxy.
let proxyPool;
try {
  proxyPool = getPool();
} catch (err) {
  console.error(`[api] Invalid proxy configuration: ${redact(err.message)}`);
  process.exit(1);
}

let bound = { port: port(), host: host() };
let accountState = {
  status: readSession() ? "configured" : "anonymous",
  verified: false,
  username: null,
  fullName: null,
  pk: null,
  error: null,
};
let reloading = false;
let stopping = false;
let proxyCheckState = null;
let checkGeneration = 0;
let activeAbort = null;

function send(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2) + "\n";
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    ...extraHeaders,
  });
  res.end(body);
}

function fail(res, err) {
  if (err instanceof InstagramError) {
    const retryAfter =
      err.code === "IG_RATE_LIMITED" && err.details && typeof err.details === "object"
        ? err.details.retryAfter
        : null;
    const headers = retryAfter ? { "Retry-After": String(retryAfter) } : {};
    return send(
      res,
      err.status,
      {
        error: {
          code: err.code,
          message: err.message,
          hint: err.hint,
          details: err.details,
        },
      },
      headers
    );
  }
  log.error(`unexpected error: ${err.message}`);
  return send(res, 500, {
    error: { code: "INTERNAL_ERROR", message: "Internal connector error." },
  });
}

function accountView() {
  return {
    status: accountState.status,
    verified: accountState.verified,
    username: accountState.username,
    fullName: accountState.fullName,
    error: accountState.error,
  };
}

async function handle(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const key = apiKey();

  if (key) {
    const provided = req.headers["x-api-key"] ?? url.searchParams.get("api_key");
    if (provided !== key) {
      return send(res, 401, {
        error: { code: "UNAUTHORIZED", message: "Missing or invalid X-API-Key." },
      });
    }
  }

  if (pathname === "/") {
    return send(res, 200, {
      name: "API Everything - Instagram connector",
      version: pkg.version,
      authenticated: Boolean(readSession()),
      account: accountView(),
      proxy: proxyPool.describe(),
      proxyCheck: compact(proxyCheckState),
      postsStrategies: strategyOrder({ anonymous: !readSession() }),
      postsDocId: readSession()
        ? process.env.IG_GQL_POSTS_DOC_ID?.trim() || "34579740524958711"
        : process.env.IG_GQL_POSTS_DOC_ID_ANON?.trim() || "37691262543822084",
      endpoints: {
        proxies: "GET /v1/proxies",
        diagnostics: "GET /v1/diagnostics?username=...",
        health: "GET /health",
        session: "GET /v1/session",
        profile: "GET /v1/instagram/:username",
        posts: "GET /v1/instagram/:username/posts?limit=12&cursor=...",
        schema: "GET /openapi.yaml",
      },
      docs: "README.md",
    });
  }

  if (pathname === "/health") {
    return send(res, 200, {
      status: "ok",
      session: readSession() ? "configured" : "anonymous",
      account: accountView(),
      proxy: proxyPool.describe(),
      proxyCheck: compact(proxyCheckState),
    });
  }

  if (pathname === "/v1/session") {
    return send(res, 200, {
      session: readSession() ? "configured" : "anonymous",
      account: accountView(),
      proxy: proxyPool.describe(),
      proxyCheck: compact(proxyCheckState),
    });
  }

  if (pathname === "/v1/diagnostics") {
    const username = (url.searchParams.get("username") ?? "").trim();
    if (!USERNAME_RE.test(username)) {
      return send(res, 400, {
        error: {
          code: "IG_BAD_REQUEST",
          message: "Provide a valid ?username= (letters, digits, . and _).",
        },
      });
    }
    const session = readSession();
    let fixedProxy;
    // No cookie to protect in anonymous mode: do not pin an exit IP.
    if (session && proxyPool.enabled && process.env.IG_PROXY_STICKY !== "0") {
      fixedProxy = proxyPool.select()?.config ?? null;
    }
    const ctx = {
      username,
      session,
      limit: 1,
      cursor: null,
      ...(fixedProxy !== undefined ? { fixedProxy } : {}),
    };
    const results = await runDiagnostics(ctx);
    return send(res, 200, {
      username,
      session: session ? "configured" : "anonymous",
      stickyProxy: fixedProxy !== undefined,
      order: strategyOrder({ anonymous: !session }),
      strategies: results,
      hint: "Set IG_POSTS_STRATEGIES or IG_GQL_POSTS_DOC_ID to the strategy that reports ok:true.",
    });
  }

  if (pathname === "/v1/proxies") {
    return send(res, 200, {
      proxy: proxyPool.describe(),
      check: proxyCheckState ?? {
        checkedAt: null,
        total: proxyPool.describe().count,
        alive: null,
        dead: null,
        avgMs: null,
        countries: {},
        results: [],
        note: "check disabled, still running, or no proxies configured",
      },
    });
  }

  if (pathname === "/openapi.yaml") {
    const file = path.join(__dirname, "openapi.yaml");
    if (!fs.existsSync(file)) return send(res, 404, { error: { code: "NOT_FOUND" } });
    const body = fs.readFileSync(file, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/yaml; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    return res.end(body);
  }

  const match = pathname.match(/^\/v1\/instagram\/([^/]+)(\/posts)?$/);
  if (!match || req.method !== "GET") {
    return send(res, 404, { error: { code: "NOT_FOUND", message: "Unknown route." } });
  }

  const username = decodeURIComponent(match[1]);
  if (!USERNAME_RE.test(username)) {
    return send(res, 400, {
      error: { code: "IG_BAD_REQUEST", message: "Invalid username." },
    });
  }

  try {
    if (match[2]) {
      const limit = parseLimit(url.searchParams.get("limit"));
      const cursor = url.searchParams.get("cursor");
      const result = await getPosts(username, { limit, cursor });
      res.locals.note = `${result.count} posts`;
      return send(res, 200, result);
    }
    const result = await getProfileStats(username, readSession());
    const exact = await getProfile(username, readSession());
    res.locals.note = `${result.source}+${exact.source}`;
    return send(res, 200, {
      ...result,
      ...exact,
      raw: result.raw,
      source: result.source,
      exactSource: exact.source,
    });
  } catch (err) {
    return fail(res, err);
  }
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  res.locals = { note: null };
  res.on("finish", () => {
    logger.request({
      method: req.method,
      url: req.url,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      note: res.locals?.note,
    });
  });
  handle(req, res).catch((err) => fail(res, err));
});

function listenOn(nextPort, nextHost) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(nextPort, nextHost, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

function closeServer() {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function bootSession() {
  const session = readSession();
  if (!session) {
    logger.sessionResult({ status: "anonymous" });
    return;
  }
  if (!verifyEnabled()) {
    log.info(`Session      ${logger.colors.cyan("configured")} (verification skipped)`);
    return;
  }

  log.info("Verifying Instagram session...");
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: "unverified",
          verified: false,
          username: null,
          fullName: null,
          pk: null,
          error: { code: "IG_VERIFY_TIMEOUT", message: "verification timed out" },
        }),
      verifyTimeout()
    );
    timer.unref();
  });
  const result = await Promise.race([verifySession(session), timeout]);
  clearTimeout(timer);
  accountState = result;
  logger.sessionResult(result);
}

function proxyChecksEnabled() {
  return proxyPool.enabled && process.env.IG_PROXY_CHECK !== "0";
}

/** Fire-and-forget: never delays startup, and stale results are ignored on reload. */
function runProxyCheck() {
  const generation = ++checkGeneration;
  if (activeAbort) activeAbort.abort();
  if (!proxyChecksEnabled()) {
    activeAbort = null;
    proxyCheckState = null;
    return;
  }

  const controller = new AbortController();
  activeAbort = controller;
  const count = proxyPool.describe().count;
  log.info(`Checking    ${count} prox${count === 1 ? "y" : "ies"} in parallel...`);

  checkProxies(proxyPool, { signal: controller.signal })
    .then((summary) => {
      if (generation !== checkGeneration) return; // superseded by a Ctrl+R reload
      applyResults(proxyPool, summary);
      proxyCheckState = summary;
      logger.proxyCheck(summary);
    })
    .catch((err) => {
      if (generation === checkGeneration && err.name !== "AbortError") {
        log.error(`proxy check failed: ${redact(err.message)}`);
      }
    });
}

async function announce() {
  logger.banner({
    port: bound.port,
    host: bound.host,
    version: pkg.version,
    proxy: proxyPool.describe(),
  });
  await bootSession();
  logger.ready();
  runProxyCheck();
}

function snapshot() {
  return Object.fromEntries(CONFIG_KEYS.map((key) => [key, process.env[key]]));
}

/** Ctrl+R: re-read .env, rebuild the proxy pool, re-verify the session. */
async function reload() {
  if (reloading || stopping) return;
  reloading = true;
  try {
    const before = snapshot();
    const info = config.load();
    const after = snapshot();
    const changed = CONFIG_KEYS.filter((key) => before[key] !== after[key]);

    log.info(
      `reload       ${path.basename(info.file)}${info.found ? "" : " (no .env, using env vars)"}`
    );

    // Only install the new pool if it is valid; a bad edit must not break a
    // running server.
    try {
      proxyPool = reloadPool();
      log.success(`proxies      reloaded (${proxyPool.describe().count})`);
    } catch (err) {
      log.error(`invalid proxy config, keeping previous pool: ${redact(err.message)}`);
    }

    const nextPort = port();
    const nextHost = host();
    if (nextPort !== bound.port || nextHost !== bound.host) {
      await closeServer();
      await listenOn(nextPort, nextHost);
      bound = { port: nextPort, host: nextHost };
      log.success(`rebound      ${nextHost}:${nextPort}`);
    }

    log.info(
      `config       ${changed.length} key(s) changed${changed.length ? `: ${changed.join(", ")}` : ""}`
    );
    await announce();
  } catch (err) {
    log.error(`reload failed: ${redact(err.message)}`);
  } finally {
    reloading = false;
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log.info("Shutting down...");
  if (activeAbort) activeAbort.abort();
  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
  await closeServer();
  process.exit(0);
}

function setupHotkeys() {
  if (!process.stdin.isTTY) {
    log.debug("Ctrl+R reload unavailable (stdin is not a TTY)");
    return;
  }
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", (str, key) => {
    if (!key) return;
    if ((key.ctrl && key.name === "r") || key.sequence === "\x12") {
      reload().catch((err) => log.error(`reload failed: ${err.message}`));
    } else if (key.ctrl && key.name === "c") {
      shutdown();
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function start() {
  await listenOn(bound.port, bound.host);
  await announce();
  setupHotkeys();
}

start().catch((err) => {
  console.error(`[api] Could not start: ${err.message}`);
  process.exit(1);
});

module.exports = { server, reload, config };
