"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { config } = require("./core/config");

config.load();

const { getProfile } = require("./core/profile");
const { getPosts, parseLimit, parseIds } = require("./core/posts");
const { strategyOrder, runDiagnostics } = require("./core/strategies");
const { getPool, reloadPool, redact } = require("./core/proxy");
const { checkProxies, applyResults, compact } = require("./core/proxycheck");
const { verifySession } = require("./core/identity");
const { ConnectorError } = require("./core/errors");
const logger = require("./core/logger");
const { log } = logger;

const pkg = require("./package.json");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const API_KEY = () => process.env.API_KEY?.trim() || null;
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

const CONFIG_KEYS = [
  "TT_SESSIONID", "TT_USER_AGENT", "TT_MIN_INTERVAL_MS", "TT_MAX_PAGES",
  "TT_TIMEOUT_MS", "TT_POSTS_STRATEGIES", "TT_BROWSER", "TT_BROWSER_WAIT_MS",
  "TT_PROXY_URL", "TT_PROXIES", "TT_PROXIES_FILE", "TT_PROXY_ROTATION",
  "TT_PROXY_MAX_RETRIES", "TT_PROXY_COOLDOWN_MS", "TT_PROXY_SESSION",
  "TT_PROXY_STICKY", "TT_PROXY_CHECK", "TT_PROXY_CHECK_URL",
  "TT_PROXY_CHECK_TIMEOUT_MS", "TT_PROXY_CHECK_CONCURRENCY",
  "TT_PROXY_CHECK_TT_URL", "TT_PROXY_CHECK_COMPARE", "API_KEY", "LOG_LEVEL",
  "PORT", "HOST", "NO_COLOR", "FORCE_COLOR",
];

let proxyPool;
try {
  proxyPool = getPool();
} catch (err) {
  console.error(`[api] Invalid proxy configuration: ${redact(err.message)}`);
  process.exit(1);
}

let bound = { port: PORT, host: HOST };
let accountState = { status: "anonymous", verified: false, username: null, error: null };
let proxyCheckState = null;
let checkGeneration = 0;
let activeAbort = null;
let reloading = false;
let stopping = false;

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
  if (err instanceof ConnectorError) {
    const retryAfter =
      err.code === "TT_RATE_LIMITED" && err.details && typeof err.details === "object"
        ? err.details.retryAfter
        : null;
    return send(res, err.status, {
      error: { code: err.code, message: err.message, hint: err.hint, details: err.details },
    }, retryAfter ? { "Retry-After": String(retryAfter) } : {});
  }
  log.error(`unexpected error: ${err.message}`);
  return send(res, 500, { error: { code: "INTERNAL_ERROR", message: "Internal connector error." } });
}

function accountView() {
  return {
    status: accountState.status,
    verified: accountState.verified,
    username: accountState.username,
    error: accountState.error,
  };
}

async function handle(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const key = API_KEY();

  if (key) {
    const provided = req.headers["x-api-key"] ?? url.searchParams.get("api_key");
    if (provided !== key) {
      return send(res, 401, { error: { code: "UNAUTHORIZED", message: "Missing or invalid X-API-Key." } });
    }
  }

  if (pathname === "/") {
    return send(res, 200, {
      name: "API Everything - TikTok connector",
      version: pkg.version,
      authenticated: Boolean(process.env.TT_SESSIONID),
      account: accountView(),
      proxy: proxyPool.describe(),
      proxyCheck: compact(proxyCheckState),
      postsStrategies: strategyOrder(),
      endpoints: {
        health: "GET /health",
        session: "GET /v1/session",
        diagnostics: "GET /v1/diagnostics?username=...",
        proxies: "GET /v1/proxies",
        profile: "GET /v1/tiktok/:username",
        posts: "GET /v1/tiktok/:username/posts?limit=12&cursor=...",
        schema: "GET /openapi.yaml",
      },
      docs: "README.md",
    });
  }

  if (pathname === "/health") {
    return send(res, 200, {
      status: "ok",
      session: process.env.TT_SESSIONID ? "configured" : "anonymous",
      account: accountView(),
      proxy: proxyPool.describe(),
      proxyCheck: compact(proxyCheckState),
    });
  }

  if (pathname === "/v1/session") {
    return send(res, 200, {
      session: process.env.TT_SESSIONID ? "configured" : "anonymous",
      account: accountView(),
      proxy: proxyPool.describe(),
    });
  }

  if (pathname === "/v1/diagnostics") {
    const username = (url.searchParams.get("username") ?? "").trim();
    if (!USERNAME_RE.test(username)) {
      return send(res, 400, { error: { code: "TT_BAD_REQUEST", message: "Provide a valid ?username=." } });
    }
    const ids = parseIds(url.searchParams.get("ids"));
    let fixedProxy;
    if (proxyPool.enabled && process.env.TT_PROXY_STICKY !== "0") {
      fixedProxy = proxyPool.select()?.config ?? null;
    }
    let profileResult = null;
    let profileError = null;
    try {
      profileResult = await getProfile(username, { fixedProxy });
    } catch (err) {
      profileError = { code: err.code, message: err.message };
    }
    const session = process.env.TT_SESSIONID?.trim()
      ? { sessionId: process.env.TT_SESSIONID.trim() }
      : null;
    const strategies = await runDiagnostics({
      username, session, limit: 1, ids, fixedProxy, profileResult,
    });
    return send(res, 200, {
      username,
      profile: profileResult?.profile ?? null,
      profileError,
      order: strategyOrder({ hasIds: ids.length > 0 }),
      strategies,
      hint: "Set TT_POSTS_STRATEGIES or enable TT_BROWSER=1 to pick the source that reports ok:true.",
    });
  }

  if (pathname === "/v1/proxies") {
    return send(res, 200, {
      proxy: proxyPool.describe(),
      check: proxyCheckState ?? { note: "check disabled, running, or no proxies configured" },
    });
  }

  if (pathname === "/openapi.yaml") {
    const file = path.join(__dirname, "openapi.yaml");
    if (!fs.existsSync(file)) return send(res, 404, { error: { code: "NOT_FOUND" } });
    res.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    return res.end(fs.readFileSync(file, "utf8"));
  }

  const match = pathname.match(/^\/v1\/tiktok\/([^/]+)(\/posts)?$/);
  if (!match || req.method !== "GET") {
    return send(res, 404, { error: { code: "NOT_FOUND", message: "Unknown route." } });
  }

  const username = decodeURIComponent(match[1]);
  if (!USERNAME_RE.test(username)) {
    return send(res, 400, { error: { code: "TT_BAD_REQUEST", message: "Invalid username." } });
  }

  try {
    if (match[2]) {
      const limit = parseLimit(url.searchParams.get("limit"));
      const cursor = url.searchParams.get("cursor");
      const ids = parseIds(url.searchParams.get("ids"));
      const result = await getPosts(username, { limit, cursor, ids });
      res.locals.note = `${result.count} posts via ${result.strategy}`;
      return send(res, 200, result);
    }
    const result = await getProfile(username, {});
    res.locals.note = result.profile.source;
    return send(res, 200, result.profile);
  } catch (err) {
    return fail(res, err);
  }
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  res.locals = { note: null };
  res.on("finish", () => {
    logger.request({
      method: req.method, url: req.url, status: res.statusCode,
      durationMs: Date.now() - startedAt, note: res.locals?.note,
    });
  });
  handle(req, res).catch((err) => fail(res, err));
});

function listenOn(p, h) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener("error", onError); reject(err); };
    server.once("error", onError);
    server.listen(p, h, () => { server.removeListener("error", onError); resolve(); });
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
  const session = process.env.TT_SESSIONID?.trim()
    ? { sessionId: process.env.TT_SESSIONID.trim() }
    : null;
  accountState = await verifySession(session);
  logger.sessionResult(accountState);
}

function runProxyCheck() {
  const generation = ++checkGeneration;
  if (activeAbort) activeAbort.abort();
  if (!proxyPool.enabled || process.env.TT_PROXY_CHECK === "0") {
    activeAbort = null;
    proxyCheckState = null;
    return;
  }
  const controller = new AbortController();
  activeAbort = controller;
  log.info(`Checking    ${proxyPool.describe().count} prox${proxyPool.describe().count === 1 ? "y" : "ies"} in parallel...`);
  checkProxies(proxyPool, { signal: controller.signal })
    .then((summary) => {
      if (generation !== checkGeneration) return;
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
    port: bound.port, host: bound.host, version: pkg.version,
    proxy: proxyPool.describe(), strategies: strategyOrder(),
  });
  await bootSession();
  logger.ready();
  runProxyCheck();
}

function snapshot() {
  return Object.fromEntries(CONFIG_KEYS.map((k) => [k, process.env[k]]));
}

async function reload() {
  if (reloading || stopping) return;
  reloading = true;
  try {
    const before = snapshot();
    const info = config.load();
    const after = snapshot();
    const changed = CONFIG_KEYS.filter((k) => before[k] !== after[k]);
    log.info(`reload       ${path.basename(info.file)}${info.found ? "" : " (no .env)"}`);
    try {
      proxyPool = reloadPool();
      log.success(`proxies      reloaded (${proxyPool.describe().count})`);
    } catch (err) {
      log.error(`invalid proxy config, keeping previous pool: ${redact(err.message)}`);
    }
    const nextPort = Number(process.env.PORT ?? 3000);
    const nextHost = process.env.HOST ?? "0.0.0.0";
    if (nextPort !== bound.port || nextHost !== bound.host) {
      await closeServer();
      await listenOn(nextPort, nextHost);
      bound = { port: nextPort, host: nextHost };
      log.success(`rebound      ${nextHost}:${nextPort}`);
    }
    log.info(`config       ${changed.length} key(s) changed${changed.length ? `: ${changed.join(", ")}` : ""}`);
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
