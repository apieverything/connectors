"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractTimeline, findUser } = require("../core/fetch");
const {
  STRATEGIES,
  DEFAULT_ORDER,
  strategyOrder,
  runDiagnostics,
  cursorFrom,
  nodesFrom,
} = require("../core/strategies");

test("extractTimeline() handles the modern GraphQL connection", () => {
  const payload = {
    data: {
      xdt_api__v1__feed__user_timeline_graphql_connection: {
        edges: [{ node: { code: "C1" } }, { node: { code: "C2" } }],
        page_info: { has_next_page: true, end_cursor: "CUR" },
      },
    },
  };
  const timeline = extractTimeline(payload);
  assert.deepEqual(nodesFrom(timeline).map((n) => n.code), ["C1", "C2"]);
  assert.equal(cursorFrom(timeline), "CUR");
});

test("extractTimeline() handles the legacy edge_owner_to_timeline_media", () => {
  const payload = {
    data: {
      user: {
        edge_owner_to_timeline_media: {
          edges: [{ node: { shortcode: "OLD" } }],
          page_info: { has_next_page: false, end_cursor: null },
        },
      },
    },
  };
  assert.equal(nodesFrom(extractTimeline(payload))[0].shortcode, "OLD");
  assert.equal(cursorFrom(extractTimeline(payload)), null);
});

test("extractTimeline() falls back to a recursive search", () => {
  const payload = { nested: { somewhere: { edges: [{ node: { code: "DEEP" } }] } } };
  assert.equal(nodesFrom(extractTimeline(payload))[0].code, "DEEP");
});

test("cursorFrom() understands more_available / next_max_id", () => {
  assert.equal(cursorFrom({ page_info: { more_available: true, next_max_id: "MAX1" } }), "MAX1");
});

test("findUser() resolves both legacy and v1 profile shapes", () => {
  assert.equal(
    findUser({ data: { user: { username: "a", edge_followed_by: { count: 1 } } } }).username,
    "a"
  );
  assert.equal(
    findUser({ somewhere: { username: "b", follower_count: 5, media_count: 2 } }).username,
    "b"
  );
  assert.equal(findUser({ nothing: 1 }), null);
});

test("strategyOrder() uses the default list and filters unknown names", () => {
  const saved = process.env.IG_POSTS_STRATEGIES;
  try {
    delete process.env.IG_POSTS_STRATEGIES;
    assert.deepEqual(strategyOrder(), DEFAULT_ORDER);
    assert.equal(strategyOrder()[0], "anon_grid");

    process.env.IG_POSTS_STRATEGIES = "web_profile_info_anon, not_a_strategy, graphql_posts";
    assert.deepEqual(strategyOrder(), ["web_profile_info_anon", "graphql_posts"]);

    process.env.IG_POSTS_STRATEGIES = "totally_unknown";
    assert.deepEqual(strategyOrder(), DEFAULT_ORDER);

    delete process.env.IG_POSTS_STRATEGIES;
    assert.equal(strategyOrder({ anonymous: true }).includes("web_profile_info"), false);
    assert.equal(strategyOrder({ anonymous: true }).includes("web_profile_info_anon"), true);
  } finally {
    if (saved === undefined) delete process.env.IG_POSTS_STRATEGIES;
    else process.env.IG_POSTS_STRATEGIES = saved;
  }
});

test("runDiagnostics() reports each strategy independently", async () => {
  const original = { ...STRATEGIES };
  try {
    const failWith = (code) => async () => {
      const err = new Error("retired");
      err.code = code;
      throw err;
    };
    const empty = async () => ({ nodes: [], nextCursor: null, profile: null, source: "x" });
    STRATEGIES.anon_grid = failWith("IG_UNEXPECTED_RESPONSE");
    STRATEGIES.graphql_posts = failWith("IG_RATE_LIMITED");
    STRATEGIES.web_profile_info_anon = async () => ({
      nodes: [{ code: "OK" }],
      nextCursor: null,
      profile: null,
      source: "web_profile_info_anon",
    });
    STRATEGIES.web_profile_info_mobile = empty;
    STRATEGIES.web_profile_info = empty;

    const results = await runDiagnostics({ username: "x", session: null, limit: 1, cursor: null });
    // Anonymous mode drops the redundant "web_profile_info" (session) strategy.
    assert.equal(results.length, DEFAULT_ORDER.length - 1);
    const byName = Object.fromEntries(results.map((r) => [r.strategy, r]));
    assert.equal(byName.anon_grid.ok, false);
    assert.equal(byName.graphql_posts.code, "IG_RATE_LIMITED");
    assert.equal(byName.web_profile_info_anon.ok, true);
    assert.equal(byName.web_profile_info_anon.posts, 1);
  } finally {
    for (const key of Object.keys(original)) STRATEGIES[key] = original[key];
  }
});
