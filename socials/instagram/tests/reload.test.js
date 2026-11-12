"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Config, parseEnvFile } = require("../core/config");
const { parseProxyUrl, normalizeProxyUrl, redact, ProxyPool, getPool, reloadPool } =
  require("../core/proxy");

const BARE = "exampleuser:examplepass@resi.example.su:80";

test("bare user:pass@host:port is accepted (dashboard copy-paste)", () => {
  const config = parseProxyUrl(BARE, "abc");
  assert.deepEqual(config, {
    protocol: "http",
    host: "resi.example.su",
    port: 80,
    auth: {
      username: "exampleuser",
      password: "examplepass",
    },
  });
});

test("normalizeProxyUrl leaves full URLs untouched", () => {
  assert.equal(normalizeProxyUrl("http://u:p@h:80"), "http://u:p@h:80");
  assert.equal(normalizeProxyUrl("https://h:443"), "https://h:443");
  assert.equal(normalizeProxyUrl(`  ${BARE}  `), `http://${BARE}`);
});

test("bare host:port without credentials also works", () => {
  const config = parseProxyUrl("resi.example.su:8080", "abc");
  assert.equal(config.host, "resi.example.su");
  assert.equal(config.port, 8080);
  assert.equal(config.auth, undefined);
});

test("bare form with {session} placeholder resolves sticky sessions", () => {
  const config = parseProxyUrl("user-session-{session}:pass@resi.example.su:80", "xyz");
  assert.equal(config.auth.username, "user-session-xyz");
});

test("redact() also hides credentials in a bare proxy string", () => {
  const out = redact(`Invalid proxy URL: ${BARE}`);
  assert.ok(!out.includes("examplepass"));
  assert.ok(!out.includes("exampleuser"));
  assert.ok(out.includes("***:***@"));
});

test("ProxyPool accepts a bare IG_PROXY_URL and never exposes it", () => {
  const pool = new ProxyPool({ IG_PROXY_URL: BARE });
  assert.equal(pool.enabled, true);
  assert.equal(pool.describe().count, 1);
  assert.ok(!JSON.stringify(pool.describe()).includes("examplepass"));
});

test("10 identical rotating lines collapse into 1 and are reported", () => {
  const pool = new ProxyPool({ IG_PROXIES: Array(10).fill(BARE).join(",") });
  assert.equal(pool.describe().count, 1);
  assert.equal(pool.describe().duplicatesCollapsed, 9);
});

test("parseEnvFile handles comments, quotes and export", () => {
  const entries = parseEnvFile(
    [
      "# comment",
      "export IG_SESSIONID=abc%3A123  # inline",
      'IG_USER_AGENT="Mozilla/5.0 (X11; Linux)"',
      "EMPTY=",
      "NOPE",
    ].join("\n")
  );
  assert.equal(entries.get("IG_SESSIONID"), "abc%3A123");
  assert.equal(entries.get("IG_USER_AGENT"), "Mozilla/5.0 (X11; Linux)");
  assert.equal(entries.get("EMPTY"), "");
  assert.equal(entries.has("NOPE"), false);
});

test("Config.load() re-applies edited values and removes deleted keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-config-"));
  const file = path.join(dir, ".env");
  const saved = { ...process.env };
  try {
    delete process.env.IG_PROXY_URL;
    delete process.env.LOG_LEVEL;
    delete process.env.API_KEY;

    fs.writeFileSync(file, "IG_PROXY_URL=one\nLOG_LEVEL=warn\n");
    const cfg = new Config(file);
    cfg.load();
    assert.equal(process.env.IG_PROXY_URL, "one");
    assert.equal(process.env.LOG_LEVEL, "warn");

    fs.writeFileSync(file, "IG_PROXY_URL=two\nLOG_LEVEL=debug\nAPI_KEY=secret\n");
    cfg.load();
    assert.equal(process.env.IG_PROXY_URL, "two");
    assert.equal(process.env.LOG_LEVEL, "debug");
    assert.equal(process.env.API_KEY, "secret");

    fs.writeFileSync(file, "LOG_LEVEL=debug\n");
    cfg.load();
    assert.equal(process.env.IG_PROXY_URL, undefined);
    assert.equal(process.env.API_KEY, undefined);
    assert.equal(process.env.LOG_LEVEL, "debug");
  } finally {
    for (const key of ["IG_PROXY_URL", "LOG_LEVEL", "API_KEY"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Config.load() never clobbers an explicit CLI/container override", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-config-"));
  const file = path.join(dir, ".env");
  const saved = process.env.LOG_LEVEL;
  try {
    fs.writeFileSync(file, "LOG_LEVEL=warn\n");
    process.env.LOG_LEVEL = "error"; // differs from the file => override
    const cfg = new Config(file);
    cfg.load();
    assert.equal(process.env.LOG_LEVEL, "error");

    fs.writeFileSync(file, "LOG_LEVEL=debug\n");
    cfg.load();
    assert.equal(process.env.LOG_LEVEL, "error");
  } finally {
    if (saved === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reloadPool() rebuilds from env, and keeps the old pool on bad config", () => {
  const saved = process.env.IG_PROXY_URL;
  try {
    process.env.IG_PROXY_URL = BARE;
    const first = reloadPool();
    assert.equal(getPool(), first);
    assert.equal(first.enabled, true);

    process.env.IG_PROXY_URL = "socks5://u:p@host:1080";
    assert.throws(() => reloadPool(), /Unsupported proxy protocol/);
    assert.equal(getPool(), first, "invalid config must not break the running server");
  } finally {
    if (saved === undefined) delete process.env.IG_PROXY_URL;
    else process.env.IG_PROXY_URL = saved;
  }
});
