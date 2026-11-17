"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { ProxyPool } = require("../core/proxy");
const {
  checkProxies,
  checkOptions,
  applyResults,
  summarize,
  compact,
  extractCountry,
  normalizeCountry,
} = require("../core/proxycheck");

test("default IG probe is a stable page with a browser UA, not the retired endpoint", () => {
  const saved = { ...process.env };
  try {
    for (const key of [
      "IG_PROXY_CHECK_IG_URL", "IG_PROXY_CHECK_IG_UA", "IG_USER_AGENT",
      "IG_PROXY_CHECK_URL", "IG_PROXY_CHECK_UA",
    ]) delete process.env[key];
    const options = checkOptions();
    assert.equal(options.igUrl, "https://www.instagram.com/instagram/");
    assert.match(options.igUserAgent, /Mozilla\/5\.0/);
    assert.ok(!options.igUrl.includes("web_profile_info"));
    assert.equal(options.checkIg, true);
  } finally {
    for (const key of [
      "IG_PROXY_CHECK_IG_URL", "IG_PROXY_CHECK_IG_UA", "IG_USER_AGENT",
      "IG_PROXY_CHECK_URL", "IG_PROXY_CHECK_UA",
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("normalizeCountry only accepts 2-letter codes", () => {
  assert.equal(normalizeCountry("fr"), "FR");
  assert.equal(normalizeCountry(" DE "), "DE");
  assert.equal(normalizeCountry("France"), null);
  assert.equal(normalizeCountry(null), null);
});

test("extractCountry handles JSON variants and Cloudflare trace", () => {
  assert.equal(extractCountry({ country_code: "fr" }, ""), "FR");
  assert.equal(extractCountry({ country: "DE" }, ""), "DE");
  assert.equal(extractCountry({ countryCode: "US" }, ""), "US");
  assert.equal(extractCountry(null, "fl=123\nh=x\nloc=JP\ntls=TLSv1.3\n"), "JP");
  assert.equal(extractCountry(null, "BR"), "BR");
  assert.equal(extractCountry({ country: "France" }, ""), null);
});

test("summarize aggregates alive, latency and countries", () => {
  const summary = summarize([
    { index: 0, label: "#1", alive: true, country: "FR", ms: 100, status: 200, error: null },
    { index: 1, label: "#2", alive: true, country: "FR", ms: 200, status: 200, error: null },
    { index: 2, label: "#3", alive: false, country: null, ms: 3000, status: null, error: "timeout" },
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.alive, 2);
  assert.equal(summary.dead, 1);
  assert.equal(summary.avgMs, 150);
  assert.equal(summary.minMs, 100);
  assert.equal(summary.maxMs, 200);
  assert.deepEqual(summary.countries, { FR: 2 });
});

test("compact() keeps only the API-safe fields", () => {
  const out = compact(summarize([]));
  assert.equal(out.total, 0);
  assert.equal(out.alive, 0);
  assert.equal(out.results, undefined);
});

test("summarize() carries the direct-vs-proxy comparison", () => {
  const direct = { igStatus: 200, snippet: "ok", ms: 12 };
  const summary = summarize([], direct);
  assert.deepEqual(summary.direct, direct);
  assert.equal(compact(summary).direct.igStatus, 200);
});

test("summarize() reports Instagram-specific 429s separately", () => {
  const summary = summarize([
    { index: 0, label: "a", alive: true, country: "FR", ms: 10, status: 200, igStatus: 429 },
    { index: 1, label: "b", alive: true, country: "FR", ms: 20, status: 200, igStatus: 200 },
    { index: 2, label: "c", alive: true, country: "FR", ms: 30, status: 200, igStatus: 429 },
  ]);
  assert.equal(summary.alive, 3);
  assert.equal(summary.igAlive, 1);
  assert.equal(summary.igBlocked, 2);
  assert.deepEqual(summary.igStatuses, { 429: 2, 200: 1 });
  assert.equal(compact(summary).igAlive, 1);
});

test("applyResults() cools down only dead proxies", () => {
  const pool = new ProxyPool({
    IG_PROXIES: "http://u:p@one:80,http://u:p@two:80",
    IG_PROXY_COOLDOWN_MS: "60000",
  });
  const summary = summarize([
    { index: 0, label: "one", alive: false, country: null, ms: 10, status: null, error: "x" },
    { index: 1, label: "two", alive: true, country: "FR", ms: 20, status: 200, error: null },
  ]);
  applyResults(pool, summary);
  assert.ok(pool.entries[0].cooldownUntil > Date.now());
  assert.equal(pool.entries[1].cooldownUntil, 0);
});

test("end-to-end: liveness + country code + ms through a real local proxy", async () => {
  const saved = { ...process.env };
  const geo = http.createServer((req, res) => {
    if (req.url === "/ig") {
      res.writeHead(429); // simulate Instagram throttling this exit IP
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ip: "1.2.3.4", country_code: "FR" }));
  });
  // Handles absolute-form HTTP requests forwarded by axios' proxy option.
  const proxy = http.createServer();
  proxy.on("request", (req, res) => {
    const target = new URL(req.url);
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: Number(target.port || 80),
        path: target.pathname + target.search,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      }
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  const listen = (server) =>
    new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const geoPort = await listen(geo);
  const proxyPort = await listen(proxy);

  try {
    process.env.IG_PROXY_CHECK_URL = `http://127.0.0.1:${geoPort}/`;
    process.env.IG_PROXY_CHECK_TIMEOUT_MS = "3000";
    process.env.IG_PROXY_CHECK_CONCURRENCY = "2";
    process.env.IG_PROXY_CHECK_IG = "1";
    process.env.IG_PROXY_CHECK_IG_URL = `http://127.0.0.1:${geoPort}/ig`;

    const pool = new ProxyPool({
      IG_PROXIES:
        `exampleuser:examplepass@127.0.0.1:${proxyPort},` + // alive, bare form with auth
        `http://127.0.0.1:59998`, // dead
    });

    const summary = await checkProxies(pool);
    assert.equal(summary.total, 2);
    assert.equal(summary.alive, 1);
    assert.equal(summary.dead, 1);
    assert.deepEqual(summary.countries, { FR: 1 });

    assert.equal(summary.igAlive, 0);
    assert.equal(summary.igBlocked, 1);
    assert.equal(summary.igStatuses["429"], 1);

    const alive = summary.results.find((r) => r.alive);
    assert.equal(alive.country, "FR");
    assert.equal(alive.igStatus, 429, "healthy proxy must still be reported as IG-blocked");
    assert.equal(typeof alive.ms, "number");
    assert.ok(alive.ms >= 0);
    assert.ok(!alive.label.includes("secret"), "label must be redacted");

    const dead = summary.results.find((r) => !r.alive);
    assert.equal(dead.country, null);
    assert.ok(dead.error);
  } finally {
    for (const key of [
      "IG_PROXY_CHECK_URL",
      "IG_PROXY_CHECK_TIMEOUT_MS",
      "IG_PROXY_CHECK_CONCURRENCY",
      "IG_PROXY_CHECK_IG",
      "IG_PROXY_CHECK_IG_URL",
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await new Promise((resolve) => geo.close(resolve));
    await new Promise((resolve) => proxy.close(resolve));
  }
});
