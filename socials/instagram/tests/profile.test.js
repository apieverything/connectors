"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeProfile } = require("../core/normalize");

const LOGGED_OUT_USER = {
  pk: "249851437",
  id: "17841401783113903",
  username: "kametolol",
  full_name: "Kameto",
  biography: "J'emmène la misère en balade",
  follower_count: 399230,
  following_count: 368,
  all_media_count: null,
  is_private: false,
  is_verified: true,
  profile_pic_url: "https://cdn.example/pic.jpg",
  external_url: null,
  category: null,
  is_business: false,
  bio_links: [
    { title: "En live tous les soirs ici", url: "http://twitch.tv/kamet0" },
    { title: null, url: null },
    { title: "Mon tiktok", url: "https://www.tiktok.com/@kametotv" },
  ],
};

test("normalizeProfile fills every field from the logged-out profile query", () => {
  const p = normalizeProfile(LOGGED_OUT_USER, "fallback");
  assert.equal(p.username, "kametolol");
  assert.equal(p.profileId, "249851437");
  assert.equal(p.followers, 399230);
  assert.equal(p.following, 368);
  assert.equal(p.posts, null, "all_media_count can be null; og:description fills it");
  assert.equal(p.fullName, "Kameto");
  assert.equal(p.isVerified, true);
  assert.equal(p.profilePicUrl, "https://cdn.example/pic.jpg");
  assert.deepEqual(p.bioLinks, [
    { title: "En live tous les soirs ici", url: "http://twitch.tv/kamet0" },
    { title: "Mon tiktok", url: "https://www.tiktok.com/@kametotv" },
  ]);
});

test("normalizeProfile handles media_count / all_media_count / legacy edges", () => {
  assert.equal(normalizeProfile({ all_media_count: 35 }).posts, 35);
  assert.equal(normalizeProfile({ media_count: 42 }).posts, 42);
  assert.equal(
    normalizeProfile({ edge_owner_to_timeline_media: { count: 12 } }).posts,
    12
  );
});

test("normalizeProfile on null leaves nulls instead of crashing", () => {
  const p = normalizeProfile(null, "someone");
  assert.equal(p.username, "someone");
  assert.equal(p.followers, null);
  assert.deepEqual(p.bioLinks, []);
});

test("profileId falls back to the GraphQL id", () => {
  assert.equal(normalizeProfile({ id: "17841401783113903" }).profileId, "17841401783113903");
});
