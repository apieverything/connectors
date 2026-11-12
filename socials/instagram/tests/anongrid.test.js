"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePost } = require("../core/normalize");
const { parseDateFromAltText, extractHashtags } = require("../core/parsing");
const { extractTimeline, extractGridUserId } = require("../core/fetch");
const { DEFAULT_ORDER, strategyOrder } = require("../core/strategies");

const GRID_NODE = {
  __typename: "XIGPolarisVideoMedia",
  pk: "4028845017509808087",
  code: "DfpVTKbxkfX",
  accessibility_caption: "Video by EZ-Store on November 12, 2026. May be an image of text.",
  caption: { text: "Un build #custompc pour @kametolol" },
  display_uri: "https://cdn.example/photo.jpg",
  media_type: 2,
  product_type: "clips",
  user: { pk: "73264358649", username: "ez.store_officiel" },
  id: "POLARIS_4028845017509808087",
};

test("logged-out grid node normalizes into the public post shape", () => {
  const p = normalizePost(GRID_NODE, "kametolol");
  assert.equal(p.url, "https://www.instagram.com/p/DfpVTKbxkfX/");
  assert.equal(p.shortcode, "DfpVTKbxkfX");
  assert.equal(p.userPosted, "ez.store_officiel");
  assert.equal(p.description, "Un build #custompc pour @kametolol");
  assert.deepEqual(p.hashtags, ["#custompc"]);
  assert.deepEqual(p.photos, ["https://cdn.example/photo.jpg"]);
  assert.equal(p.type, "reel");
  assert.equal(p.datePosted, "2026-11-12T00:00:00.000Z");
  assert.equal(p.numComments, null, "grid omits comments; enrichment fills it");
});

test("media_type 8 and carousel_container are carousels, not reels", () => {
  assert.equal(normalizePost({ code: "A", media_type: 8 }).type, "carousel");
  assert.equal(
    normalizePost({ code: "B", product_type: "carousel_container", carousel_media_count: 11 }).type,
    "carousel"
  );
  assert.equal(normalizePost({ code: "C", media_type: 1 }).type, "image");
  assert.equal(normalizePost({ code: "D", media_type: 2 }).type, "video");
});

test("parseDateFromAltText extracts a day-level date", () => {
  assert.equal(
    parseDateFromAltText("Photo by Kameto on September 24, 2026."),
    "2026-09-24T00:00:00.000Z"
  );
  assert.equal(parseDateFromAltText("no date here"), null);
  assert.equal(parseDateFromAltText(null), null);
});

test("extractTimeline() finds the logged-out grid connection", () => {
  const payload = {
    data: {
      xig_user_by_username: {
        pk: "249851437",
        id: "17841401783113903",
        polaris_ordered_timeline_connection: {
          edges: [{ node: GRID_NODE }],
          page_info: { has_next_page: true, end_cursor: "CURSOR" },
        },
      },
    },
  };
  const timeline = extractTimeline(payload);
  assert.equal(timeline.edges.length, 1);
  assert.equal(timeline.page_info.end_cursor, "CURSOR");
  assert.equal(extractGridUserId(payload), "17841401783113903");
});

test("anon_grid is the first strategy, for both anonymous and authenticated", () => {
  assert.equal(DEFAULT_ORDER[0], "anon_grid");
  assert.equal(strategyOrder()[0], "anon_grid");
  assert.equal(strategyOrder({ anonymous: true })[0], "anon_grid");
  assert.equal(strategyOrder({ anonymous: true }).includes("web_profile_info"), false);
});

test("hashtags are extracted from a real grid caption", () => {
  assert.deepEqual(
    extractHashtags("#ezstore #kameto #pokemon #dracaufeu #custompc #pcgaming"),
    ["#ezstore", "#kameto", "#pokemon", "#dracaufeu", "#custompc", "#pcgaming"]
  );
});
