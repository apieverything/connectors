"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { normalizeProfile } = require("../core/normalize");
const { redactUrl } = require("../core/logger");
const { verifySession } = require("../core/identity");

const ROOT = path.join(__dirname, "..");

test("normalizeProfile returns exact counts from web_profile_info", () => {
  const p = normalizeProfile(
    {
      username: "kametolol",
      full_name: "Kameto",
      biography: "streamer",
      is_private: false,
      is_verified: true,
      edge_followed_by: { count: 399123 },
      edge_follow: { count: 374 },
      edge_owner_to_timeline_media: { count: 34 },
      profile_pic_url: "https://cdn/pic.jpg",
    },
    "fallback"
  );
  assert.equal(p.username, "kametolol");
  assert.equal(p.followers, 399123);
  assert.equal(p.following, 374);
  assert.equal(p.posts, 34);
  assert.equal(p.fullName, "Kameto");
  assert.equal(p.isVerified, true);
  assert.equal(p.source, "web_profile_info");
});

test("normalizeProfile accepts alternate field names", () => {
  const p = normalizeProfile(
    { follower_count: 10, following_count: 20, media_count: 30, full_name: "X" },
    "someone"
  );
  assert.deepEqual(
    { followers: p.followers, following: p.following, posts: p.posts, username: p.username },
    { followers: 10, following: 20, posts: 30, username: "someone" }
  );
});

test("redactUrl hides secrets but keeps the route readable", () => {
  const out = redactUrl(
    "/v1/instagram/kametolol/posts?api_key=SUPERSECRET&limit=12&cursor=ABC"
  );
  assert.ok(!out.includes("SUPERSECRET"));
  assert.match(out, /api_key=\*\*\*/);
  assert.match(out, /limit=12/);
});

test("NO_COLOR disables ANSI, FORCE_COLOR enables it", () => {
  const script = "process.stdout.write(String(require('./core/logger').colorEnabled()))";
  const disabled = execFileSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "" },
  });
  const enabled = execFileSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: "", FORCE_COLOR: "1" },
  });
  assert.equal(disabled.toString(), "false");
  assert.equal(enabled.toString(), "true");
});

test("verifySession(null) is anonymous and performs no network call", async () => {
  const result = await verifySession(null);
  assert.equal(result.status, "anonymous");
  assert.equal(result.verified, false);
  assert.equal(result.username, null);
});
