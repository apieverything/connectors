"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeProfile, normalizePost, extractHashtags, extractMentions } = require("../core/normalize");
const { extractScope, extractUserDetail, extractVideoDetail, extractBootstrapCookies } = require("../core/rehydration");
const { ProxyPool, parseProxyUrl, normalizeProxyUrl, redact } = require("../core/proxy");
const { Config, parseEnvFile } = require("../core/config");
const { strategyOrder, DEFAULT_ORDER } = require("../core/strategies");
const { parseLimit, parseIds } = require("../core/posts");
const { summarize, compact, extractCountry, normalizeCountry } = require("../core/proxycheck");
const { ConnectorError, HINTS } = require("../core/errors");
const { redactUrl } = require("../core/logger");

const USER_INFO = {
  user: {
    id: "6715633812345678901",
    uniqueId: "khaby.lame",
    nickname: "Khabane lame",
    signature: "I'm just a guy",
    avatarLarger: "https://cdn.example/avatar.jpg",
    verified: true,
    privateAccount: false,
    secUid: "MS4wLjABAAAAxyz",
    createTime: 1580000000,
    bioLink: { link: "https://example.com" },
  },
  statsV2: {
    followerCount: "162914134",
    followingCount: "82",
    heartCount: "2693500000",
    videoCount: "1358",
  },
  shareMeta: { title: "Khabane lame on TikTok", desc: "@khaby.lame 162.9m Followers" },
  itemList: [],
};

const ITEM = {
  id: "7532360200000000000",
  desc: "New video #funny #comedy @someone",
  createTime: 1794496043,
  author: { uniqueId: "khaby.lame", nickname: "Khabane lame" },
  stats: { diggCount: 12345, commentCount: 678, shareCount: 90, playCount: 999000 },
  video: {
    duration: 15,
    cover: "https://cdn.example/cover.jpg",
    playAddr: "https://cdn.example/video.mp4",
  },
  music: { title: "Original sound" },
  challenges: [{ title: "funny" }],
};

test("normalizeProfile fills exact counts from the SSR payload", () => {
  const p = normalizeProfile(USER_INFO, "fallback");
  assert.equal(p.username, "khaby.lame");
  assert.equal(p.profileId, "6715633812345678901");
  assert.equal(p.secUid, "MS4wLjABAAAAxyz");
  assert.equal(p.followers, 162914134);
  assert.equal(p.following, 82);
  assert.equal(p.posts, 1358);
  assert.equal(p.likes, 2693500000);
  assert.equal(p.fullName, "Khabane lame");
  assert.equal(p.isVerified, true);
  assert.equal(p.profilePicUrl, "https://cdn.example/avatar.jpg");
  assert.equal(p.bioLink, "https://example.com");
  assert.equal(p.createdAt, new Date(1580000000 * 1000).toISOString());
  assert.equal(p.source, "user_detail");
});

test("normalizeProfile tolerates legacy stats and null payloads", () => {
  const p = normalizeProfile({ user: { uniqueId: "x" }, stats: { followerCount: "10", heart: "20" } });
  assert.equal(p.followers, 10);
  assert.equal(p.likes, 20);
  const empty = normalizeProfile(null, "someone");
  assert.equal(empty.username, "someone");
  assert.equal(empty.followers, null);
});

test("normalizePost returns the Instagram-compatible shape", () => {
  const p = normalizePost(ITEM, "fallback");
  assert.equal(p.url, "https://www.tiktok.com/@khaby.lame/video/7532360200000000000");
  assert.equal(p.shortcode, "7532360200000000000");
  assert.equal(p.userPosted, "khaby.lame");
  assert.equal(p.description, ITEM.desc);
  assert.deepEqual(p.hashtags, ["#funny", "#comedy"]);
  assert.deepEqual(p.mentions, ["@someone"]);
  assert.equal(p.numComments, 678);
  assert.equal(p.likes, 12345);
  assert.equal(p.shares, 90);
  assert.equal(p.plays, 999000);
  assert.equal(p.duration, 15);
  assert.deepEqual(p.photos, ["https://cdn.example/cover.jpg"]);
  assert.deepEqual(p.videos, ["https://cdn.example/video.mp4"]);
  assert.equal(p.type, "video");
  assert.equal(p.isVideo, true);
  assert.equal(p.datePosted, new Date(1794496043 * 1000).toISOString());
});

test("hashtags and mentions are Unicode-safe and deduplicated", () => {
  assert.deepEqual(extractHashtags("#cafe #東京 #cafe"), ["#cafe", "#東京"]);
  assert.deepEqual(extractMentions("@a.b @a.b @c_d"), ["@a.b", "@c_d"]);
});

test("extractScope parses the rehydration blob and SIGI fallback", () => {
  const blob = JSON.stringify({
    __DEFAULT_SCOPE__: {
      "webapp.user-detail": { statusCode: 0, userInfo: USER_INFO },
      "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct: ITEM } },
    },
  });
  const html = `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${blob}</script></html>`;
  const scope = extractScope(html);
  assert.ok(scope);
  assert.equal(extractUserDetail(html).statusCode, 0);
  assert.equal(extractVideoDetail(html).itemInfo.itemStruct.id, ITEM.id);
  assert.equal(extractScope("<html>no blob</html>"), null);
});

test("extractBootstrapCookies collects msToken and ttwid", () => {
  const out = extractBootstrapCookies("msToken=abc123; ttwid=xyz; tt_csrf_token=q");
  assert.equal(out.msToken, "abc123");
  assert.equal(out.ttwid, "xyz");
  assert.match(out.jar, /msToken=abc123/);
});

test("bare proxy credentials and duplicate lines", () => {
  const bare = "user:pass@resi.example.su:80";
  const config = parseProxyUrl(bare, "abc");
  assert.equal(config.protocol, "http");
  assert.equal(config.host, "resi.example.su");
  assert.equal(config.port, 80);
  assert.deepEqual(config.auth, { username: "user", password: "pass" });
  assert.equal(normalizeProxyUrl("http://u:p@h:80"), "http://u:p@h:80");
  assert.ok(!redact(`Invalid: ${bare}`).includes("pass"));

  const pool = new ProxyPool({ TT_PROXIES: Array(10).fill(bare).join(",") });
  assert.equal(pool.describe().count, 1);
  assert.equal(pool.describe().duplicatesCollapsed, 9);
});

test("Config.load() reloads edited values and keeps CLI overrides", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-config-"));
  const file = path.join(dir, ".env");
  const saved = { ...process.env };
  try {
    delete process.env.TT_MIN_INTERVAL_MS;
    fs.writeFileSync(file, "TT_MIN_INTERVAL_MS=1000\nLOG_LEVEL=warn\n");
    const cfg = new Config(file);
    cfg.load();
    assert.equal(process.env.TT_MIN_INTERVAL_MS, "1000");
    fs.writeFileSync(file, "TT_MIN_INTERVAL_MS=3000\n");
    cfg.load();
    assert.equal(process.env.TT_MIN_INTERVAL_MS, "3000");
    assert.equal(process.env.LOG_LEVEL, undefined);
  } finally {
    for (const k of ["TT_MIN_INTERVAL_MS", "LOG_LEVEL"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseEnvFile handles comments, quotes and export", () => {
  const entries = parseEnvFile('# c\nexport TT_A=abc  # inline\nTT_B="x y"\nNOPE');
  assert.equal(entries.get("TT_A"), "abc");
  assert.equal(entries.get("TT_B"), "x y");
  assert.equal(entries.has("NOPE"), false);
});

test("strategyOrder filters browser and video_ids unless enabled", () => {
  const saved = { TT_BROWSER: process.env.TT_BROWSER, TT_POSTS_STRATEGIES: process.env.TT_POSTS_STRATEGIES };
  try {
    delete process.env.TT_POSTS_STRATEGIES;
    delete process.env.TT_BROWSER;
    assert.equal(strategyOrder().includes("browser"), false);
    assert.equal(strategyOrder({ hasIds: true }).includes("video_ids"), true);
    process.env.TT_BROWSER = "1";
    assert.equal(strategyOrder()[0], "browser");
    process.env.TT_POSTS_STRATEGIES = "not_a_strategy";
    assert.deepEqual(strategyOrder(), DEFAULT_ORDER.filter((n) => n !== "video_ids"));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("parseLimit and parseIds validate input", () => {
  assert.equal(parseLimit(null), 12);
  assert.equal(parseLimit("50"), 50);
  assert.equal(parseLimit("1000"), 100);
  assert.throws(() => parseLimit("abc"), /limit/);
  assert.deepEqual(parseIds("7532360200000000000, 7532360200000000001, bad"), [
    "7532360200000000000", "7532360200000000001",
  ]);
});

test("proxycheck summarises TikTok status and direct comparison", () => {
  const summary = summarize([
    { index: 0, label: "a", alive: true, country: "FR", ms: 10, tiktokStatus: 200 },
    { index: 1, label: "b", alive: true, country: "FR", ms: 20, tiktokStatus: 403 },
  ], { tiktokStatus: 200, ms: 5 });
  assert.equal(summary.ttAlive, 1);
  assert.equal(summary.tiktokStatuses[403], 1);
  assert.equal(compact(summary).direct.tiktokStatus, 200);
  assert.equal(extractCountry({ country_code: "de" }, ""), "DE");
  assert.equal(normalizeCountry("France"), null);
  assert.equal(extractCountry(null, "loc=JP\n"), "JP");
});

test("ConnectorError carries hints", () => {
  const err = new ConnectorError("TT_ENDPOINT_BLOCKED", "blocked", 502);
  assert.equal(err.status, 502);
  assert.match(err.hint, /TT_BROWSER/);
  assert.ok(HINTS.TT_ALL_STRATEGIES_FAILED);
});

test("redactUrl hides secrets in query strings", () => {
  const out = redactUrl("/v1/tiktok/x/posts?ids=123&api_key=SUPERSECRET");
  assert.ok(!out.includes("SUPERSECRET"));
  assert.match(out, /api_key=\*\*\*/);
});

const { parseEmbedProfile, dateFromId } = require("../core/embed");

const EMBED_FIXTURE = `<html><script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify({
  source: { data: { "/embed/@tiktok": { videoList: [
    { id: "7710348513128828191", desc: "hello #fyp", coverUrl: "https://c/x.image", originCoverUrl: "https://c/o.image", playAddr: "https://v/p.mp4", playCount: 457100, privateItem: false, authorUniqueId: "tiktok" },
    { id: "7700009319382650142", desc: "secret", privateItem: true },
  ] } } },
})}</script></html>`;

test("parseEmbedProfile extracts videos from the embed state and skips private ones", () => {
  const nodes = parseEmbedProfile(EMBED_FIXTURE, "tiktok");
  assert.equal(nodes.length, 1);
  const post = normalizePost(nodes[0], "tiktok");
  assert.equal(post.url, "https://www.tiktok.com/@tiktok/video/7710348513128828191");
  assert.equal(post.plays, 457100);
  assert.deepEqual(post.hashtags, ["#fyp"]);
  assert.deepEqual(post.photos, ["https://c/o.image"]);
  assert.deepEqual(post.videos, ["https://v/p.mp4"]);
  assert.match(post.datePosted, /^2026-11-20T/);
});

test("parseEmbedProfile tolerates garbage; dateFromId rejects non-snowflakes", () => {
  assert.deepEqual(parseEmbedProfile("<html></html>"), []);
  assert.deepEqual(parseEmbedProfile('<script id="__FRONTITY_CONNECT_STATE__">{bad</script>'), []);
  assert.equal(dateFromId("abc"), null);
  assert.equal(dateFromId("12345"), null);
});

test("embed strategy is part of the default chain before item_list", () => {
  assert.ok(DEFAULT_ORDER.indexOf("embed") > DEFAULT_ORDER.indexOf("ssr_itemlist"));
  assert.ok(DEFAULT_ORDER.indexOf("embed") < DEFAULT_ORDER.indexOf("item_list"));
});
