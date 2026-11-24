"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { config } = require("./core/config");

config.load();

const {
  strategyOrder,
  getChannel,
  getChannelPosts,
  searchVideos,
  getVideo,
  getTranscript,
  runDiagnostics,
} = require("./core/innertube");
const { parseHandleInput } = require("./core/parsing");
const { ConnectorError, readSession, verifySession } = require("./core/session");
const { getPool, reloadPool, redact } = require("./core/proxy");
const { checkProxies, applyResults, compact } = require("./core/proxycheck");
const logger = require("./core/logger");
const { log } = logger;

const pkg = require("./package.json");
const HOST = () => process.env.HOST ?? "0.0.0.0";
const PORT = () => Number(process.env.PORT ?? 3000);
const API_KEY = () => process.env.API_KEY?.trim() || null;

const CONFIG_KEYS = [
  "YT_SESSIONID", "YT_USER_AGENT", "YT_CONSENT_COOKIES",
  "YT_MIN_INTERVAL_MS", "YT_MAX_PAGES", "YT_TIMEOUT_MS",
  "YT_HL", "YT_GL", "YT_CLIENT_VERSION", "YT_STRATEGIES", "YT_VERIFY_SESSION",
  "YT_PROXY_URL", "YT_PROXIES", "YT_PROXIES_FILE", "YT_PROXY_ROTATION",
  "YT_PROXY_MAX_RETRIES", "YT_PROXY_COOLDOWN_MS", "YT_PROXY_SESSION",
  "YT_PROXY_STICKY", "YT_PROXY_CHECK", "YT_PROXY_CHECK_URL",
  "YT_PROXY_CHECK_TIMEOUT_MS", "YT_PROXY_CHECK_CONCURRENCY",
  "YT_PROXY_CHECK_YT_URL", "YT_PROXY_CHECK_COMPARE",
  "API_KEY", "LOG_LEVEL", "PORT", "HOST", "NO_COLOR", "FORCE_COLOR",
];

let proxyPool;
try {
  proxyPool = getPool();
} catch (err) {
  console.error(`[api] Invalid proxy configuration: ${redact(err.message)}`);
  process.exit(1);
}

let bound = { port: PORT(), host: HOST() };
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
      err.code === "YT_RATE_LIMITED" && err.details && typeof err.details === "object"
        ? err.details.retryAfter
        : null;
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
      retryAfter ? { "Retry-After": String(retryAfter) } : {}
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
    error: accountState.error,
  };
}

function pinProxy() {
  const session = readSession();
  if (!session || process.env.YT_PROXY_STICKY === "0" || !proxyPool.enabled) return undefined;
  return proxyPool.select()?.config ?? null;
}

async function handle(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const key = API_KEY();

  if (key) {
    const provided = req.headers["x-api-key"] ?? url.searchParams.get("api_key");
    if (provided !== key) {
      return send(res, 401, {
        error: { code: "UNAUTHORIZED", message: "Missing or invalid X-API-Key." },
      });
    }
  }

  if (req.method !== "GET") {
    return send(res, 404, { error: { code: "NOT_FOUND", message: "Unknown route." } });
  }

  if (pathname === "/") {
    return send(res, 200, {
      name: "API Everything - YouTube connector",
      version: pkg.version,
      authenticated: Boolean(readSession()),
      account: accountView(),
      proxy: proxyPool.describe(),
      proxyCheck: compact(proxyCheckState),
      strategies: strategyOrder(),
      endpoints: {
        health: "GET /health",
        session: "GET /v1/session",
        diagnostics: "GET /v1/diagnostics?handle=@mkbhd",
        proxies: "GET /v1/proxies",
        channel: "GET /v1/youtube/:handle",
        posts: "GET /v1/youtube/:handle/posts?limit=12&cursor=...",
        search: "GET /v1/youtube/search?q=...&limit=10&cursor=...",
        video: "GET /v1/youtube/videos/:id",
        transcript: "GET /v1/youtube/videos/:id/transcript?lang=en",
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

  if (pathname === "/v1/proxies") {
    return send(res, 200, {
      proxy: proxyPool.describe(),
      check: proxyCheckState ?? { note: "check disabled, running, or no proxies configured" },
    });
  }

  if (pathname === "/openapi.yaml") {
    const file = path.join(__dirname, "openapi.yaml");
    if (!fs.existsSync(file)) return send(res, 404, { error: { code: "NOT_FOUND" } });
    res.writeHead(200, {
      "Content-Type": "text/yaml; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    return res.end(fs.readFileSync(file, "utf8"));
  }

  try {
    const fixedProxy = pinProxy();
    const opts = fixedProxy !== undefined ? { fixedProxy } : {};

    if (pathname === "/v1/diagnostics") {
      const rawHandle =
        url.searchParams.get("handle") ??
        url.searchParams.get("username") ??
        "@mkbhd";
      const parsed = parseHandleInput(rawHandle);
      const strategies = await runDiagnostics(rawHandle, opts);
      return send(res, 200, {
        handle: parsed.handle ?? parsed.channelId,
        session: readSession() ? "configured" : "anonymous",
        order: strategyOrder(),
        strategies,
        hint: "Set YT_STRATEGIES to pin the source that reports ok:true.",
      });
    }

    if (pathname === "/v1/youtube/search") {
      const result = await searchVideos(
        url.searchParams.get("q"),
        {
          limit: url.searchParams.get("limit"),
          cursor: url.searchParams.get("cursor"),
        },
        opts
      );
      if (res.locals) res.locals.note = `${result.count} videos via ${result.strategy}`;
      return send(res, 200, result);
    }

    const transcriptMatch = pathname.match(/^\/v1\/youtube\/videos\/([^/]+)\/transcript$/);
    if (transcriptMatch) {
      const videoId = decodeURIComponent(transcriptMatch[1]);
      const result = await getTranscript(
        videoId,
        { lang: url.searchParams.get("lang") },
        opts
      );
      if (res.locals) res.locals.note = `${result.count} segments (${result.language})`;
      return send(res, 200, result);
    }

    const videoMatch = pathname.match(/^\/v1\/youtube\/videos\/([^/]+)$/);
    if (videoMatch) {
      const videoId = decodeURIComponent(videoMatch[1]);
      const result = await getVideo(videoId, opts);
      if (res.locals) res.locals.note = result.source;
      return send(res, 200, result);
    }

    const channelMatch = pathname.match(/^\/v1\/youtube\/([^/]+)(\/posts)?$/);
    if (channelMatch && channelMatch[1] !== "videos" && channelMatch[1] !== "search") {
      const handleParam = decodeURIComponent(channelMatch[1]);
      if (channelMatch[2]) {
        const result = await getChannelPosts(
          handleParam,
          {
            limit: url.searchParams.get("limit"),
            cursor: url.searchParams.get("cursor"),
          },
          opts
        );
        if (res.locals) res.locals.note = `${result.count} videos via ${result.strategy}`;
        return send(res, 200, result);
      }
      const result = await getChannel(handleParam, opts);
      if (res.locals) res.locals.note = result.source;
      return send(res, 200, result);
    }

    return send(res, 404, { error: { code: "NOT_FOUND", message: "Unknown route." } });
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
  accountState = await verifySession(readSession());
  logger.sessionResult(accountState);
}

function runProxyCheck() {
  const generation = ++checkGeneration;
  if (activeAbort) activeAbort.abort();
  if (!proxyPool.enabled || process.env.YT_PROXY_CHECK === "0") {
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
    port: bound.port,
    host: bound.host,
    version: pkg.version,
    proxy: proxyPool.describe(),
    strategies: strategyOrder(),
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
    const nextPort = PORT();
    const nextHost = HOST();
    if (server.listening && (nextPort !== bound.port || nextHost !== bound.host)) {
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

async function start() {
  bound = { port: PORT(), host: HOST() };
  await listenOn(bound.port, bound.host);
  await announce();
  setupHotkeys();
}

if (require.main === module) {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  start().catch((err) => {
    console.error(`[api] Could not start: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { server, handle, reload, listenOn, closeServer, config };
