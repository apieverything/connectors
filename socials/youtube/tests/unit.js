"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  parseHandleInput,
  parseVideoId,
  parseLimit,
  parseSearchQuery,
  parseLang,
  extractBalancedJson,
  extractYtInitialData,
  extractYtInitialPlayerResponse,
  isConsentPage,
  parseCountText,
  parseDurationSeconds,
  formatDuration,
  extractHashtags,
  extractMentions,
  unwrapRedirectUrl,
  parseChaptersFromDescription,
  parseTranscriptJson3,
  parseTranscriptXml,
} = require("../core/parsing");
const {
  normalizeChannel,
  normalizeVideoCard,
  extractVideosAndContinuation,
  normalizeVideoDetail,
} = require("../core/normalize");
const {
  strategyOrder,
  setTransport,
  getChannel,
  getChannelPosts,
  searchVideos,
  getVideo,
  getTranscript,
  runDiagnostics,
} = require("../core/innertube");
const {
  EU_CONSENT_COOKIES,
  ConnectorError,
  buildCookieHeader,
  buildBrowserHeaders,
} = require("../core/session");
const { ProxyPool, parseProxyUrl, normalizeProxyUrl, redact } = require("../core/proxy");
const { summarize, compact, extractCountry } = require("../core/proxycheck");
const { Config, parseEnvFile } = require("../core/config");
const { redactUrl } = require("../core/logger");
const { server, listenOn, closeServer } = require("../server");

/* ---------- 1. Balanced-brace HTML extraction ---------- */

test("extractBalancedJson handles nested braces and braces inside escaped strings", () => {
  const html = `
    <script nonce="abc">
      var ytInitialData = {"header":{"title":"Hello {world} \\"quoted\\" } brace"},"items":[{"id":1},{"id":2}]};
      var otherVar = {"ignored": true};
    </script>`;
  const data = extractYtInitialData(html);
  assert.ok(data);
  assert.equal(data.header.title, 'Hello {world} "quoted" } brace');
  assert.equal(data.items.length, 2);
});

test("extractYtInitialPlayerResponse extracts player payload from watch HTML", () => {
  const html = `<!doctype html><script>window["ytInitialPlayerResponse"] = {"videoDetails":{"videoId":"dQw4w9WgXcQ","title":"Never Gonna Give You Up","lengthSeconds":"212"}};var x=1;</script>`;
  const pr = extractYtInitialPlayerResponse(html);
  assert.equal(pr.videoDetails.videoId, "dQw4w9WgXcQ");
  assert.equal(pr.videoDetails.lengthSeconds, "212");
});

test("isConsentPage detects consent.youtube.com interstitials", () => {
  assert.equal(isConsentPage("<html></html>", "https://consent.youtube.com/m?continue=x"), true);
  assert.equal(
    isConsentPage('<form action="https://consent.youtube.com/save"></form>', "https://www.youtube.com/@mkbhd"),
    true
  );
  assert.equal(
    isConsentPage('<script>var ytInitialData = {"ok":true};</script>', "https://www.youtube.com/@mkbhd"),
    false
  );
});

/* ---------- 2. Channel normalization (pageHeaderViewModel & c4TabbedHeaderRenderer) ---------- */

test("normalizeChannel parses modern pageHeaderViewModel + channelMetadataRenderer", () => {
  const payload = {
    metadata: {
      channelMetadataRenderer: {
        title: "Marques Brownlee",
        description: "MKBHD: Quality Tech Videos | YouTuber",
        externalId: "UCBJycsmduvYEL83R_U4JriQ",
        vanityChannelUrl: "http://www.youtube.com/@mkbhd",
        keywords: '"MKBHD" "tech reviews" smartphones',
        country: "United States",
      },
    },
    header: {
      pageHeaderRenderer: {
        content: {
          pageHeaderViewModel: {
            title: {
              dynamicTextViewModel: {
                text: { content: "Marques Brownlee", attachmentRuns: [{ icon: "CHECK_CIRCLE_FILLED" }] },
              },
            },
            image: {
              decoratedAvatarViewModel: {
                avatar: {
                  avatarViewModel: {
                    image: {
                      sources: [
                        { url: "https://yt3.ggpht.com/small.jpg", width: 88, height: 88 },
                        { url: "https://yt3.ggpht.com/large.jpg", width: 176, height: 176 },
                      ],
                    },
                  },
                },
              },
            },
            banner: {
              imageBannerViewModel: {
                image: { sources: [{ url: "https://yt3.ggpht.com/banner.jpg", width: 2048, height: 339 }] },
              },
            },
            metadata: {
              contentMetadataViewModel: {
                metadataRows: [
                  { metadataParts: [{ text: { content: "@mkbhd" } }] },
                  {
                    metadataParts: [
                      { text: { content: "19.8M subscribers" } },
                      { text: { content: "1.6K videos" } },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    },
    onResponseReceivedEndpoints: [
      {
        aboutChannelViewModel: {
          viewCountText: "4,512,345,678 views",
          links: [
            {
              channelExternalLinkViewModel: {
                title: { content: "mkbhd.com" },
                link: { content: "https://www.youtube.com/redirect?event=channel_header&q=https%3A%2F%2Fmkbhd.com" },
              },
            },
          ],
        },
      },
    ],
  };

  const ch = normalizeChannel(payload, null, "innertube_browse");
  assert.equal(ch.handle, "@mkbhd");
  assert.equal(ch.username, "mkbhd");
  assert.equal(ch.channelId, "UCBJycsmduvYEL83R_U4JriQ");
  assert.equal(ch.fullName, "Marques Brownlee");
  assert.equal(ch.subscribers, 19_800_000);
  assert.equal(ch.subscribersText, "19.8M subscribers");
  assert.equal(ch.videosCount, 1600);
  assert.equal(ch.views, 4_512_345_678);
  assert.equal(ch.avatar, "https://yt3.ggpht.com/large.jpg");
  assert.equal(ch.banner, "https://yt3.ggpht.com/banner.jpg");
  assert.equal(ch.isVerified, true);
  assert.equal(ch.country, "United States");
  assert.deepEqual(ch.keywords, ["MKBHD", "tech reviews", "smartphones"]);
  assert.deepEqual(ch.links, [{ title: "mkbhd.com", url: "https://mkbhd.com" }]);
  assert.equal(ch.source, "innertube_browse");
});

test("normalizeChannel parses classic c4TabbedHeaderRenderer", () => {
  const payload = {
    header: {
      c4TabbedHeaderRenderer: {
        channelId: "UCsBjURrPoezykLs9EqgamOA",
        title: "Fireship",
        channelHandleText: { runs: [{ text: "@Fireship" }] },
        subscriberCountText: { simpleText: "3.45M subscribers" },
        videosCountText: { runs: [{ text: "685" }, { text: " videos" }] },
        avatar: { thumbnails: [{ url: "//yt3.ggpht.com/fireship.jpg", width: 176, height: 176 }] },
        badges: [{ metadataBadgeRenderer: { style: "BADGE_STYLE_TYPE_VERIFIED" } }],
        headerLinks: {
          channelHeaderLinksRenderer: {
            primaryLinks: [
              {
                title: { simpleText: "fireship.io" },
                navigationEndpoint: { urlEndpoint: { url: "https://www.youtube.com/redirect?q=https%3A%2F%2Ffireship.io" } },
              },
            ],
          },
        },
      },
    },
  };

  const ch = normalizeChannel(payload, null, "html_initial_data");
  assert.equal(ch.handle, "@Fireship");
  assert.equal(ch.username, "Fireship");
  assert.equal(ch.channelId, "UCsBjURrPoezykLs9EqgamOA");
  assert.equal(ch.subscribers, 3_450_000);
  assert.equal(ch.videosCount, 685);
  assert.equal(ch.avatar, "https://yt3.ggpht.com/fireship.jpg");
  assert.equal(ch.isVerified, true);
  assert.deepEqual(ch.links, [{ title: "fireship.io", url: "https://fireship.io" }]);
  assert.equal(ch.source, "html_initial_data");
});

/* ---------- 3. Video cards, Shorts & Continuation cursors ---------- */

test("normalizeVideoCard normalizes richItemRenderer videoRenderer to API Everything post shape", () => {
  const fixedNow = Date.parse("2026-11-24T12:00:00.000Z");
  const node = {
    richItemRenderer: {
      content: {
        videoRenderer: {
          videoId: "abcDEF12345",
          title: { runs: [{ text: "Linux in 100 Seconds #linux #opensource" }] },
          descriptionSnippet: { runs: [{ text: "Featuring @torvalds and @gnu" }] },
          lengthText: { simpleText: "2:18" },
          viewCountText: { simpleText: "1,420,500 views" },
          publishedTimeText: { simpleText: "3 days ago" },
          thumbnail: {
            thumbnails: [
              { url: "https://i.ytimg.com/vi/abcDEF12345/mqdefault.jpg", width: 320, height: 180 },
              { url: "https://i.ytimg.com/vi/abcDEF12345/maxresdefault.jpg", width: 1280, height: 720 },
            ],
          },
        },
      },
    },
  };

  const post = normalizeVideoCard(node, { username: "Fireship", channelId: "UCsBjURrPoezykLs9EqgamOA" }, fixedNow);
  assert.equal(post.url, "https://www.youtube.com/watch?v=abcDEF12345");
  assert.equal(post.shortcode, "abcDEF12345");
  assert.equal(post.videoId, "abcDEF12345");
  assert.equal(post.userPosted, "Fireship");
  assert.deepEqual(post.hashtags, ["#linux", "#opensource"]);
  assert.deepEqual(post.mentions, ["@torvalds", "@gnu"]);
  assert.equal(post.views, 1_420_500);
  assert.equal(post.duration, "2:18");
  assert.equal(post.durationSeconds, 138);
  assert.equal(post.publishedText, "3 days ago");
  assert.equal(post.datePosted, "2026-11-21T12:00:00.000Z");
  assert.equal(post.photos[0], "https://i.ytimg.com/vi/abcDEF12345/maxresdefault.jpg");
  assert.equal(post.type, "video");
});

test("normalizeVideoCard detects YouTube Shorts from shortsLockupViewModel and SHORTS overlay", () => {
  const lockup = {
    richItemRenderer: {
      content: {
        shortsLockupViewModel: {
          entityId: "shorts-shelf-item-shrt1234567",
          overlayMetadata: {
            primaryText: { content: "Quick CSS Trick #css" },
            secondaryText: { content: "850K views" },
          },
          thumbnail: { sources: [{ url: "https://i.ytimg.com/vi/shrt1234567/oar2.jpg", width: 720, height: 1280 }] },
        },
      },
    },
  };
  const s1 = normalizeVideoCard(lockup, { username: "kevinpowell" });
  assert.equal(s1.type, "short");
  assert.equal(s1.url, "https://www.youtube.com/shorts/shrt1234567");
  assert.equal(s1.views, 850_000);
  assert.deepEqual(s1.hashtags, ["#css"]);

  const classicShort = {
    videoRenderer: {
      videoId: "shrt7654321",
      title: { simpleText: "Short clip" },
      thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: "SHORTS", text: { simpleText: "SHORTS" } } }],
    },
  };
  const s2 = normalizeVideoCard(classicShort);
  assert.equal(s2.type, "short");
  assert.equal(s2.durationSeconds, null);
});

test("extractVideosAndContinuation extracts feed items and commandExecutorCommand continuation token", () => {
  const browsePayload = {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              title: "Videos",
              selected: true,
              content: {
                richGridRenderer: {
                  contents: [
                    { richItemRenderer: { content: { videoRenderer: { videoId: "vid00000001", title: { simpleText: "One" } } } } },
                    { richItemRenderer: { content: { videoRenderer: { videoId: "vid00000002", title: { simpleText: "Two" } } } } },
                    {
                      continuationItemRenderer: {
                        continuationEndpoint: {
                          commandExecutorCommand: {
                            commands: [{ continuationCommand: { token: "CONT_TOKEN_NEXT_PAGE" } }],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };

  const { videos, nextCursor } = extractVideosAndContinuation(browsePayload, { username: "mkbhd" });
  assert.equal(videos.length, 2);
  assert.deepEqual(videos.map((v) => v.videoId), ["vid00000001", "vid00000002"]);
  assert.equal(nextCursor, "CONT_TOKEN_NEXT_PAGE");
});

test("extractVideosAndContinuation handles page 2 appendContinuationItemsAction", () => {
  const contPayload = {
    onResponseReceivedActions: [
      {
        appendContinuationItemsAction: {
          continuationItems: [
            { richItemRenderer: { content: { videoRenderer: { videoId: "vid00000003", title: { simpleText: "Three" } } } } },
            { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "CONT_PAGE_3" } } } },
          ],
        },
      },
    ],
  };
  const { videos, nextCursor } = extractVideosAndContinuation(contPayload);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].videoId, "vid00000003");
  assert.equal(nextCursor, "CONT_PAGE_3");
});

/* ---------- 4. Single video detail & chapters ---------- */

test("parseChaptersFromDescription extracts timestamps and computes endSeconds", () => {
  const desc = [
    "Reviewing the new laptop!",
    "0:00 Intro",
    "01:30 - Design & Ports",
    "[05:45] Benchmarks",
    "12:10 Final Verdict",
  ].join("\n");

  const chapters = parseChaptersFromDescription(desc, 900);
  assert.equal(chapters.length, 4);
  assert.deepEqual(chapters[0], {
    title: "Intro",
    timestamp: "0:00",
    startSeconds: 0,
    startMs: 0,
    endSeconds: 90,
  });
  assert.equal(chapters[1].title, "Design & Ports");
  assert.equal(chapters[1].startSeconds, 90);
  assert.equal(chapters[3].endSeconds, 900);
});

test("normalizeVideoDetail combines playerResponse, watch likes, chapters and captionLanguages", () => {
  const playerResponse = {
    videoDetails: {
      videoId: "dQw4w9WgXcQ",
      title: "Deep Dive #engineering",
      shortDescription: "With @alice\n0:00 Start\n2:00 Architecture",
      channelId: "UCBJycsmduvYEL83R_U4JriQ",
      author: "Marques Brownlee",
      viewCount: "987654",
      lengthSeconds: "300",
      isLive: false,
      keywords: ["engineering", "systems"],
      thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg", width: 1920, height: 1080 }] },
    },
    microformat: {
      playerMicroformatRenderer: {
        publishDate: "2026-10-15",
      },
    },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { languageCode: "en", name: { simpleText: "English" }, baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en" },
          { languageCode: "fr", kind: "asr", name: { simpleText: "French (auto-generated)" }, baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=fr" },
        ],
      },
    },
  };

  const watchData = {
    contents: {
      segmentedLikeDislikeButtonViewModel: {
        likeButtonViewModel: {
          accessibilityText: "like this video along with 42,105 other people",
        },
      },
    },
  };

  const detail = normalizeVideoDetail(playerResponse, watchData, "innertube_player");
  assert.equal(detail.videoId, "dQw4w9WgXcQ");
  assert.equal(detail.views, 987654);
  assert.equal(detail.likes, 42105);
  assert.equal(detail.durationSeconds, 300);
  assert.equal(detail.datePosted, "2026-10-15T00:00:00.000Z");
  assert.deepEqual(detail.hashtags, ["#engineering"]);
  assert.deepEqual(detail.mentions, ["@alice"]);
  assert.equal(detail.chapters.length, 2);
  assert.equal(detail.captionLanguages.length, 2);
  assert.equal(detail.captionLanguages[1].isAutoGenerated, true);
});

/* ---------- 5. Transcript XML & JSON3 parsing ---------- */

test("parseTranscriptJson3 parses JSON3 events and skips empty cues", () => {
  const json3 = {
    events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "\n" }] },
      { tStartMs: 1200, dDurationMs: 2500, segs: [{ utf8: "Hello " }, { utf8: "world!" }] },
      { tStartMs: 3700, dDurationMs: 1800, segs: [{ utf8: "Keyless &amp; fast" }] },
    ],
  };
  const segs = parseTranscriptJson3(json3);
  assert.deepEqual(segs, [
    { text: "Hello world!", startMs: 1200, durationMs: 2500 },
    { text: "Keyless & fast", startMs: 3700, durationMs: 1800 },
  ]);
});

test("parseTranscriptXml parses classic <text> and srv3 <p> captions with double-encoded entities", () => {
  const xml = `<?xml version="1.0" encoding="utf-8" ?><transcript>
    <text start="0.5" dur="2.25">It&amp;#39;s open &amp;amp; sovereign</text>
    <text start="2.75" dur="1.5">Line &quot;two&quot;</text>
  </transcript>`;
  const segs = parseTranscriptXml(xml);
  assert.deepEqual(segs, [
    { text: "It's open & sovereign", startMs: 500, durationMs: 2250 },
    { text: 'Line "two"', startMs: 2750, durationMs: 1500 },
  ]);

  const srv3 = `<timedtext><body><p t="1500" d="3000"><s>Android</s><s> player</s></p></body></timedtext>`;
  assert.deepEqual(parseTranscriptXml(srv3), [
    { text: "Android player", startMs: 1500, durationMs: 3000 },
  ]);
});

/* ---------- 6. EU Consent cookies, input validation, counts & durations ---------- */

test("EU consent bypass cookies are always included in outbound headers", () => {
  const cookie = buildCookieHeader(null);
  assert.ok(cookie.includes("SOCS="));
  assert.ok(cookie.includes("CONSENT=YES+"));
  assert.ok(EU_CONSENT_COOKIES.includes("SOCS="));
  const webHeaders = buildBrowserHeaders(null, { json: true });
  assert.ok(webHeaders.Cookie.includes("SOCS="));
  assert.equal(webHeaders["X-YouTube-Client-Name"], "1");
  const androidHeaders = buildBrowserHeaders(null, { clientType: "ANDROID" });
  assert.equal(androidHeaders["X-YouTube-Client-Name"], "3");
});

test("input validation rejects malformed handles, video IDs, limits, queries and langs", () => {
  assert.equal(parseHandleInput("@mkbhd").handle, "@mkbhd");
  assert.equal(parseHandleInput("mkbhd").handle, "@mkbhd");
  assert.equal(parseHandleInput("UCBJycsmduvYEL83R_U4JriQ").kind, "channelId");
  assert.throws(() => parseHandleInput("bad!!"), (e) => e.code === "YT_BAD_REQUEST" && e.status === 400);
  assert.throws(() => parseHandleInput(""), (e) => e.code === "YT_BAD_REQUEST" && e.status === 400);

  assert.equal(parseVideoId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.throws(() => parseVideoId("short"), (e) => e.code === "YT_BAD_REQUEST" && e.status === 400);

  assert.equal(parseLimit(null), 12);
  assert.equal(parseLimit("25"), 25);
  assert.equal(parseLimit("999"), 100);
  assert.throws(() => parseLimit("abc"), (e) => e.code === "YT_BAD_REQUEST");
  assert.throws(() => parseLimit("0"), (e) => e.code === "YT_BAD_REQUEST");

  assert.equal(parseSearchQuery(" open source "), "open source");
  assert.throws(() => parseSearchQuery("   "), (e) => e.code === "YT_BAD_REQUEST");

  assert.deepEqual(parseLang(null), { lang: "en", explicit: false });
  assert.deepEqual(parseLang("pt-BR"), { lang: "pt-BR", explicit: true });
  assert.throws(() => parseLang("bad!!"), (e) => e.code === "YT_BAD_REQUEST");
});

test("parseCountText, parseDurationSeconds, formatDuration, and unwrapRedirectUrl edge cases", () => {
  assert.equal(parseCountText("No views"), 0);
  assert.equal(parseCountText("1.25B views"), 1_250_000_000);
  assert.equal(parseDurationSeconds("1:02:03"), 3723);
  assert.equal(formatDuration(3723), "1:02:03");
  assert.equal(parseDurationSeconds("PT4M12S"), 252);
  assert.equal(
    unwrapRedirectUrl("https://www.youtube.com/redirect?event=x&q=https%3A%2F%2Fexample.org%2Fdoc"),
    "https://example.org/doc"
  );
  assert.deepEqual(extractHashtags("# Café #東京 #東京 #Web3"), ["#東京", "#Web3"]);
  assert.deepEqual(extractMentions("Talk with @mkbhd (@fireship) and user@mail.com"), ["@mkbhd", "@fireship"]);
});

/* ---------- 7. Proxies, Config hot-reload, Logger redaction ---------- */

test("bare proxy credentials, {session} sticky placeholder, and redaction", () => {
  const bare = "ytuser-session-{session}:secretpass@resi.example.su:8080";
  const cfg = parseProxyUrl(bare, "s99");
  assert.deepEqual(cfg, {
    protocol: "http",
    host: "resi.example.su",
    port: 8080,
    auth: { username: "ytuser-session-s99", password: "secretpass" },
  });
  assert.equal(normalizeProxyUrl("u:p@h:80"), "http://u:p@h:80");
  assert.ok(!redact(`Failed: ${bare}`).includes("secretpass"));

  const pool = new ProxyPool({ YT_PROXIES: Array(5).fill("u:p@h:80").join(",") });
  assert.equal(pool.describe().count, 1);
  assert.equal(pool.describe().duplicatesCollapsed, 4);
  assert.equal(pool.isRetryable({ code: "YT_RATE_LIMITED" }), true);
  assert.equal(pool.isRetryable({ code: "YT_NO_TRANSCRIPT" }), false);
});

test("proxycheck summarizes YouTube probe statuses", () => {
  const summary = summarize(
    [
      { index: 0, label: "a", alive: true, country: "NL", ms: 25, youtubeStatus: 200 },
      { index: 1, label: "b", alive: true, country: "DE", ms: 35, youtubeStatus: 429 },
    ],
    { youtubeStatus: 200, ms: 10 }
  );
  assert.equal(summary.ytAlive, 1);
  assert.equal(summary.ytStatuses[429], 1);
  assert.equal(compact(summary).avgMs, 30);
  assert.equal(extractCountry({}, "loc=fr\n"), "FR");
});

test("Config.load() hot-reloads .env edits while preserving external overrides", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-cfg-"));
  const file = path.join(dir, ".env");
  const savedMin = process.env.YT_MIN_INTERVAL_MS;
  const savedHl = process.env.YT_HL;
  try {
    delete process.env.YT_MIN_INTERVAL_MS;
    process.env.YT_HL = "fr"; // external override
    fs.writeFileSync(file, 'YT_MIN_INTERVAL_MS=400\nYT_HL="en"\n');
    const cfg = new Config(file);
    cfg.load();
    assert.equal(process.env.YT_MIN_INTERVAL_MS, "400");
    assert.equal(process.env.YT_HL, "fr");

    fs.writeFileSync(file, "YT_MIN_INTERVAL_MS=900\n");
    cfg.load();
    assert.equal(process.env.YT_MIN_INTERVAL_MS, "900");
    assert.equal(parseEnvFile("export YT_GL=DE # comment").get("YT_GL"), "DE");
  } finally {
    if (savedMin === undefined) delete process.env.YT_MIN_INTERVAL_MS;
    else process.env.YT_MIN_INTERVAL_MS = savedMin;
    if (savedHl === undefined) delete process.env.YT_HL;
    else process.env.YT_HL = savedHl;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("strategyOrder and redactUrl respect configuration and privacy", () => {
  const saved = process.env.YT_STRATEGIES;
  try {
    delete process.env.YT_STRATEGIES;
    assert.deepEqual(strategyOrder(), ["innertube", "html"]);
    process.env.YT_STRATEGIES = "html_initial_data";
    assert.deepEqual(strategyOrder(), ["html"]);
  } finally {
    if (saved === undefined) delete process.env.YT_STRATEGIES;
    else process.env.YT_STRATEGIES = saved;
  }
  const redacted = redactUrl("/v1/youtube/search?q=private+topic&api_key=SECRET123&limit=5");
  assert.ok(!redacted.includes("private+topic"));
  assert.ok(!redacted.includes("SECRET123"));
  assert.ok(redacted.includes("limit=5"));
});

/* ---------- 8. Strategy fallback & HTTP contract end-to-end (mocked transport, port 0) ---------- */

test("InnerTube -> HTML fallback, continuation cursor, search, and 404 YT_NO_TRANSCRIPT", async () => {
  const savedInterval = process.env.YT_MIN_INTERVAL_MS;
  process.env.YT_MIN_INTERVAL_MS = "0";

  try {
    // 1) Simulate InnerTube failing (500) and HTML ytInitialData succeeding!
    setTransport(async ({ method, url }) => {
      if (method === "POST" && url.includes("/youtubei/v1/")) {
        return { status: 503, data: "Service Unavailable", headers: {} };
      }
      if (method === "GET" && url.includes("/@fallbackchan/videos")) {
        const initial = {
          metadata: {
            channelMetadataRenderer: {
              title: "Fallback Creator",
              externalId: "UC0000000000000000000001",
              vanityChannelUrl: "http://www.youtube.com/@fallbackchan",
            },
          },
          header: {
            c4TabbedHeaderRenderer: {
              channelId: "UC0000000000000000000001",
              title: "Fallback Creator",
              subscriberCountText: { simpleText: "50K subscribers" },
            },
          },
          contents: {
            twoColumnBrowseResultsRenderer: {
              tabs: [
                {
                  tabRenderer: {
                    selected: true,
                    content: {
                      richGridRenderer: {
                        contents: [
                          { videoRenderer: { videoId: "vidFallback", title: { simpleText: "HTML Fallback Works" }, lengthText: { simpleText: "5:00" }, viewCountText: { simpleText: "10K views" } } },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
        };
        return {
          status: 200,
          data: `<script>var ytInitialData = ${JSON.stringify(initial)};</script>`,
          headers: {},
        };
      }
      return { status: 404, data: "Not found", headers: {} };
    });

    const postsRes = await getChannelPosts("@fallbackchan", { limit: 5 });
    assert.equal(postsRes.strategy, "html_initial_data");
    assert.equal(postsRes.profile.subscribers, 50_000);
    assert.equal(postsRes.count, 1);
    assert.equal(postsRes.posts[0].videoId, "vidFallback");

    // 2) Simulate video WITHOUT captions -> must throw 404 YT_NO_TRANSCRIPT
    setTransport(async ({ url }) => {
      if (url.includes("/youtubei/v1/player")) {
        return {
          status: 200,
          data: JSON.stringify({
            videoDetails: { videoId: "noCaptions1", title: "Silent Film", lengthSeconds: "60", viewCount: "100" },
            captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
          }),
          headers: {},
        };
      }
      return {
        status: 200,
        data: `<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"noCaptions1","title":"Silent Film"}};</script>`,
        headers: {},
      };
    });

    await assert.rejects(
      () => getTranscript("noCaptions1", { lang: "en" }),
      (err) => err instanceof ConnectorError && err.code === "YT_NO_TRANSCRIPT" && err.status === 404
    );

    // 3) Simulate video WITH XML captions + search via InnerTube
    setTransport(async ({ url, headers }) => {
      assert.ok(String(headers.Cookie).includes("SOCS="), "must send EU consent cookie");
      if (url.includes("/youtubei/v1/search")) {
        return {
          status: 200,
          data: JSON.stringify({
            contents: {
              twoColumnSearchResultsRenderer: {
                primaryContents: {
                  sectionListRenderer: {
                    contents: [
                      {
                        itemSectionRenderer: {
                          contents: [
                            { videoRenderer: { videoId: "srchVid0001", title: { simpleText: "Open Source API" }, lengthText: { simpleText: "10:00" }, viewCountText: { simpleText: "25K views" } } },
                          ],
                        },
                      },
                      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "SEARCH_CURSOR_2" } } } },
                    ],
                  },
                },
              },
            },
          }),
          headers: {},
        };
      }
      if (url.includes("/youtubei/v1/player")) {
        return {
          status: 200,
          data: JSON.stringify({
            videoDetails: { videoId: "hasCaption1", title: "Talk", lengthSeconds: "120", viewCount: "500" },
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  { languageCode: "en", name: { simpleText: "English" }, baseUrl: "https://www.youtube.com/api/timedtext?v=hasCaption1&lang=en" },
                ],
              },
            },
          }),
          headers: {},
        };
      }
      if (url.includes("/api/timedtext")) {
        return {
          status: 200,
          data: `<transcript><text start="0.0" dur="1.5">First segment.</text><text start="1.5" dur="2.0">Second segment.</text></transcript>`,
          headers: {},
        };
      }
      return { status: 200, data: "{}", headers: {} };
    });

    const srch = await searchVideos("open source", { limit: 1 });
    assert.equal(srch.strategy, "innertube_search");
    assert.equal(srch.count, 1);
    assert.equal(srch.videos[0].videoId, "srchVid0001");
    assert.equal(srch.nextCursor, "SEARCH_CURSOR_2");

    const tr = await getTranscript("hasCaption1", { lang: "en" });
    assert.equal(tr.videoId, "hasCaption1");
    assert.equal(tr.language, "en");
    assert.equal(tr.count, 2);
    assert.equal(tr.fullText, "First segment. Second segment.");
    assert.equal(tr.segments[1].startMs, 1500);
  } finally {
    setTransport(null);
    if (savedInterval === undefined) delete process.env.YT_MIN_INTERVAL_MS;
    else process.env.YT_MIN_INTERVAL_MS = savedInterval;
  }
});

test("getChannel by UC... channel ID, getVideo metadata, and runDiagnostics report", async () => {
  const savedInterval = process.env.YT_MIN_INTERVAL_MS;
  process.env.YT_MIN_INTERVAL_MS = "0";
  try {
    setTransport(async ({ method, url }) => {
      if (method === "POST" && url.includes("/youtubei/v1/navigation/resolve_url")) {
        return {
          status: 200,
          data: JSON.stringify({ endpoint: { browseEndpoint: { browseId: "UCBJycsmduvYEL83R_U4JriQ" } } }),
          headers: {},
        };
      }
      if (method === "POST" && url.includes("/youtubei/v1/browse")) {
        return {
          status: 200,
          data: JSON.stringify({
            header: {
              c4TabbedHeaderRenderer: {
                channelId: "UCBJycsmduvYEL83R_U4JriQ",
                title: "Marques Brownlee",
                channelHandleText: { simpleText: "@mkbhd" },
                subscriberCountText: { simpleText: "19.8M subscribers" },
              },
            },
            contents: {
              twoColumnBrowseResultsRenderer: {
                tabs: [
                  {
                    tabRenderer: {
                      selected: true,
                      content: {
                        richGridRenderer: {
                          contents: [{ videoRenderer: { videoId: "vidDiag0001", title: { simpleText: "Diag Video" } } }],
                        },
                      },
                    },
                  },
                ],
              },
            },
          }),
          headers: {},
        };
      }
      if (method === "GET" && url.includes("/@mkbhd/videos")) {
        const htmlData = {
          header: {
            c4TabbedHeaderRenderer: {
              channelId: "UCBJycsmduvYEL83R_U4JriQ",
              title: "Marques Brownlee",
            },
          },
        };
        return { status: 200, data: `<script>var ytInitialData = ${JSON.stringify(htmlData)};</script>`, headers: {} };
      }
      if (method === "POST" && url.includes("/youtubei/v1/player")) {
        return {
          status: 200,
          data: JSON.stringify({
            videoDetails: {
              videoId: "vidMeta0001",
              title: "Full Video Metadata",
              shortDescription: "0:00 Intro\n1:00 Outro",
              channelId: "UCBJycsmduvYEL83R_U4JriQ",
              author: "Marques Brownlee",
              viewCount: "250000",
              lengthSeconds: "120",
              keywords: ["tech"],
            },
          }),
          headers: {},
        };
      }
      return { status: 200, data: "{}", headers: {} };
    });

    const ch = await getChannel("UCBJycsmduvYEL83R_U4JriQ");
    assert.equal(ch.channelId, "UCBJycsmduvYEL83R_U4JriQ");
    assert.equal(ch.subscribers, 19_800_000);

    const vid = await getVideo("vidMeta0001");
    assert.equal(vid.videoId, "vidMeta0001");
    assert.equal(vid.chapters.length, 2);

    const diag = await runDiagnostics("@mkbhd");
    assert.equal(diag.length, 2);
    assert.equal(diag[0].ok, true);
    assert.equal(diag[1].ok, true);
  } finally {
    setTransport(null);
    if (savedInterval === undefined) delete process.env.YT_MIN_INTERVAL_MS;
    else process.env.YT_MIN_INTERVAL_MS = savedInterval;
  }
});

test("HTTP server contract: /, /health, /openapi.yaml, error envelopes and X-API-Key gate on port 0", async () => {
  const savedKey = process.env.API_KEY;
  const savedLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "silent";
  delete process.env.API_KEY;

  await listenOn(0, "127.0.0.1");
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const rootRes = await fetch(`${base}/`);
    assert.equal(rootRes.status, 200);
    const rootJson = await rootRes.json();
    assert.match(rootJson.name, /YouTube connector/);

    const healthRes = await fetch(`${base}/health`);
    assert.equal(healthRes.status, 200);
    assert.equal((await healthRes.json()).status, "ok");

    const specRes = await fetch(`${base}/openapi.yaml`);
    assert.equal(specRes.status, 200);
    assert.match(await specRes.text(), /\/v1\/youtube\/\{handle\}\/posts:/);

    const badHandle = await fetch(`${base}/v1/youtube/bad!!/posts`);
    assert.equal(badHandle.status, 400);
    assert.equal((await badHandle.json()).error.code, "YT_BAD_REQUEST");

    const badSearch = await fetch(`${base}/v1/youtube/search`);
    assert.equal(badSearch.status, 400);

    const notFound = await fetch(`${base}/unknown-route`);
    assert.equal(notFound.status, 404);

    // Optional API_KEY protection
    process.env.API_KEY = "local-test-secret";
    const unauth = await fetch(`${base}/health`);
    assert.equal(unauth.status, 401);
    const authed = await fetch(`${base}/health`, { headers: { "X-API-Key": "local-test-secret" } });
    assert.equal(authed.status, 200);
  } finally {
    await closeServer();
    if (savedKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = savedKey;
    if (savedLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLevel;
  }
});
