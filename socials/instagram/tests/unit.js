"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePost } = require("../core/normalize");
const { parseOgDescription, extractHashtags, extractMentions } = require("../core/parsing");
const { parseLimit } = require("../core/posts");
const { ProxyPool, parseProxyUrl, redact } = require("../core/proxy");

const IMAGE_NODE = {
  shortcode: "Cabc123",
  taken_at: 1757874727,
  owner: { username: "kametolol" },
  edge_liked_by: { count: 28411 },
  edge_media_to_comment: { count: 142 },
  edge_media_to_caption: {
    edges: [{ node: { text: "Soiree #Kameto #Live #Kameto @someone @other" } }],
  },
  display_url: "https://cdn.example/photo.jpg",
  is_video: false,
  accessibility_caption: "Stage photo",
  location: { name: "Paris" },
};

test("normalizes an image post with every public API field", () => {
  const p = normalizePost(IMAGE_NODE, "fallback");
  assert.equal(p.url, "https://www.instagram.com/p/Cabc123/");
  assert.equal(p.shortcode, "Cabc123");
  assert.equal(p.userPosted, "kametolol");
  assert.equal(p.description, "Soiree #Kameto #Live #Kameto @someone @other");
  assert.deepEqual(p.hashtags, ["#Kameto", "#Live"]);
  assert.deepEqual(p.mentions, ["@someone", "@other"]);
  assert.equal(p.numComments, 142);
  assert.equal(p.likes, 28411);
  assert.equal(p.datePosted, new Date(1757874727 * 1000).toISOString());
  assert.deepEqual(p.photos, ["https://cdn.example/photo.jpg"]);
  assert.deepEqual(p.videos, []);
  assert.equal(p.type, "image");
  assert.equal(p.isVideo, false);
  assert.equal(p.location, "Paris");
  assert.equal(p.altText, "Stage photo");
});

test("accepts alternate field names (GraphQL / newer API)", () => {
  const p = normalizePost({
    code: "Dxyz",
    taken_at_timestamp: 1700000000,
    like_count: 10,
    comment_count: 3,
    caption: { text: "#cafe @bob" },
    image_versions2: { candidates: [{ url: "https://cdn.example/a.jpg" }] },
    user: { username: "other" },
  });
  assert.equal(p.url, "https://www.instagram.com/p/Dxyz/");
  assert.equal(p.likes, 10);
  assert.equal(p.numComments, 3);
  assert.equal(p.userPosted, "other");
  assert.deepEqual(p.photos, ["https://cdn.example/a.jpg"]);
  assert.deepEqual(p.hashtags, ["#cafe"]);
});

test("carousel collects every photo and video", () => {
  const p = normalizePost({
    code: "CAR",
    edge_sidecar_to_children: {
      edges: [
        { node: { display_url: "https://cdn/1.jpg", is_video: false } },
        { node: { is_video: true, video_versions: [{ url: "https://cdn/2.mp4" }] } },
      ],
    },
  });
  assert.equal(p.type, "carousel");
  assert.deepEqual(p.photos, ["https://cdn/1.jpg"]);
  assert.deepEqual(p.videos, ["https://cdn/2.mp4"]);
});

test("reel and video", () => {
  assert.equal(normalizePost({ code: "R", product_type: "clips" }).type, "reel");
  assert.equal(
    normalizePost({ code: "V", is_video: true, video_url: "https://cdn/v.mp4" }).type,
    "video"
  );
});

test("parses og:description", () => {
  assert.deepEqual(
    parseOgDescription("399K Followers, 374 Following, 34 Posts - See Instagram photos"),
    { followers: 399000, following: 374, posts: 34 }
  );
  assert.deepEqual(
    parseOgDescription("1.2M Followers, 928 Following, 0 Posts - ..."),
    { followers: 1200000, following: 928, posts: 0 }
  );
  assert.equal(parseOgDescription(null), null);
  assert.equal(parseOgDescription("Login page"), null);
});

test("Unicode hashtags and deduplication", () => {
  assert.deepEqual(extractHashtags("#cafe #東京 #cafe #a_b"), ["#cafe", "#東京", "#a_b"]);
  assert.deepEqual(extractHashtags(""), []);
});

test("limit is validated and capped", () => {
  assert.equal(parseLimit(null), 12);
  assert.equal(parseLimit("50"), 50);
  assert.equal(parseLimit("1000"), 100);
  assert.throws(() => parseLimit("abc"), /limit/);
  assert.throws(() => parseLimit("0"), /limit/);
});

/* ------------------------------- proxies ------------------------------- */

test("parses an authenticated proxy URL like a provider dashboard", () => {
  const config = parseProxyUrl("http://exampleuser:examplepass@resi.example.su:80", "abc");
  assert.deepEqual(config, {
    protocol: "http",
    host: "resi.example.su",
    port: 80,
    auth: { username: "exampleuser", password: "examplepass" },
  });
});

test("substitutes the {session} sticky placeholder", () => {
  const config = parseProxyUrl(
    "http://user-session-{session}:pass@resi.example.su:8080",
    "xyz123"
  );
  assert.equal(config.auth.username, "user-session-xyz123");
});

test("redact() never leaks credentials", () => {
  const out = redact("Invalid proxy URL: http://user:supersecret@host:80");
  assert.ok(!out.includes("supersecret"));
  assert.ok(out.includes("***:***"));
});

test("no proxy configured => disabled, one attempt, direct connection", () => {
  const pool = new ProxyPool({});
  assert.equal(pool.enabled, false);
  assert.equal(pool.attempts, 1);
  assert.equal(pool.select(), null);
  assert.equal(pool.describe().count, 0);
});

test("round-robin rotates and failed entries are cooled down", () => {
  const pool = new ProxyPool({
    IG_PROXIES: "http://a:p@one:80,http://b:p@two:80,http://c:p@three:80",
    IG_PROXY_ROTATION: "round-robin",
    IG_PROXY_COOLDOWN_MS: "60000",
  });
  assert.equal(pool.attempts, 3);
  assert.deepEqual(
    [pool.select().config.host, pool.select().config.host, pool.select().config.host],
    ["one", "two", "three"]
  );

  const next = pool.select();
  pool.markFailed(next.entry);
  const hosts = new Set();
  for (let i = 0; i < 10; i += 1) hosts.add(pool.select().config.host);
  assert.ok(!hosts.has(next.config.host), "cooled-down proxy must be skipped");
});

test("describe() exposes no credentials", () => {
  const pool = new ProxyPool({ IG_PROXY_URL: "http://user:supersecret@host:80" });
  assert.ok(!JSON.stringify(pool.describe()).includes("supersecret"));
});

test("only 429/network/upstream failures are retryable", () => {
  const pool = new ProxyPool({ IG_PROXY_URL: "http://u:p@host:80" });
  assert.equal(pool.isRetryable({ code: "IG_RATE_LIMITED" }), true);
  assert.equal(pool.isRetryable({ code: "IG_NETWORK_ERROR" }), true);
  assert.equal(pool.isRetryable({ code: "IG_USER_NOT_FOUND" }), false);
  assert.equal(pool.isRetryable({ code: "IG_SESSION_EXPIRED" }), false);
});

test("invalid proxy config fails with a readable error", () => {
  assert.throws(() => new ProxyPool({ IG_PROXY_URL: "http://" }), /Invalid proxy URL/);
  assert.throws(() => new ProxyPool({ IG_PROXY_ROTATION: "shuffle" }), /IG_PROXY_ROTATION/);
});
