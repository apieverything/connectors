"use strict";

/**
 * Post-source strategy chain, mirroring the Instagram connector.
 *
 * Unlike Instagram, TikTok does NOT server-render the post list: /api/post/
 * item_list requires request signatures (X-Bogus / X-Gnarly). Four independent
 * sources are therefore tried in order:
 *
 *   browser       Playwright renders the page and intercepts TikTok's own
 *                 signed XHRs (opt-in, TT_BROWSER=1)
 *   ssr_itemlist  userInfo.itemList, populated for some accounts/regions
 *   item_list     direct unsigned attempt, reports TT_ENDPOINT_BLOCKED
 *   video_ids     explicit ids via ?ids=..., resolved through video pages
 *                 (full stats) or oEmbed (fallback)
 */

const { get } = require("./http");
const { fetchOembed, fetchVideoDetail } = require("./video");
const { ConnectorError } = require("./errors");
const { log } = require("./logger");

const DEFAULT_ORDER = ["browser", "ssr_itemlist", "item_list", "video_ids"];

function strategyOrder({ hasIds = false } = {}) {
  const raw = process.env.TT_POSTS_STRATEGIES?.trim();
  let names = DEFAULT_ORDER;
  if (raw) {
    const custom = raw.split(/[\s,]+/).filter(Boolean)
      .filter((n) => DEFAULT_ORDER.includes(n));
    if (custom.length) names = custom;
  }
  return names.filter((name) => {
    if (name === "browser" && process.env.TT_BROWSER !== "1") return false;
    if (name === "video_ids" && !hasIds) return false;
    return true;
  });
}

async function ssrItemList(ctx) {
  const nodes = ctx.profileResult?.itemList ?? [];
  if (!nodes.length) {
    throw new ConnectorError(
      "TT_ENDPOINT_BLOCKED",
      "The SSR profile payload contains no posts (TikTok loads them client-side).",
      502
    );
  }
  return { nodes, nextCursor: null, source: "ssr_itemlist" };
}

async function itemList(ctx) {
  const secUid = ctx.profileResult?.secUid;
  if (!secUid) throw new ConnectorError("TT_ENDPOINT_BLOCKED", "No secUid available.", 502);
  const params = new URLSearchParams({
    aid: "1988", app_language: "en", browser_language: "en-US",
    count: String(Math.min(ctx.limit ?? 12, 30)), cursor: ctx.cursor ?? "0",
    device_platform: "web_pc", os: "windows", region: "US", secUid,
  });
  const { body } = await get(
    `https://www.tiktok.com/api/post/item_list/?${params}`,
    {
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: `https://www.tiktok.com/@${ctx.username}`,
        "X-Requested-With": "XMLHttpRequest",
        ...(ctx.profileResult?.bootstrap?.jar ? { Cookie: ctx.profileResult.bootstrap.jar } : {}),
      },
      ...(ctx.fixedProxy !== undefined ? { fixedProxy: ctx.fixedProxy } : {}),
    }
  );
  const parsed = (() => { try { return JSON.parse(body); } catch { return null; } })();
  const nodes = parsed?.itemList ?? [];
  if (!nodes.length) {
    throw new ConnectorError(
      "TT_ENDPOINT_BLOCKED",
      "TikTok returned an empty item_list response (request signature required).",
      502,
      { bodyBytes: body.length }
    );
  }
  const info = parsed?.pageInfo ?? {};
  return {
    nodes,
    nextCursor: info.hasMore ? String(info.cursor ?? "") : null,
    source: "item_list",
  };
}

async function videoIds(ctx) {
  const ids = ctx.ids ?? [];
  const nodes = [];
  for (const id of ids) {
    try {
      nodes.push(await fetchVideoDetail(id, ctx.username, {
        fixedProxy: ctx.fixedProxy, session: ctx.session,
      }));
    } catch {
      try {
        const url = `https://www.tiktok.com/@${ctx.username}/video/${id}`;
        nodes.push(await fetchOembed(url, { fixedProxy: ctx.fixedProxy }));
      } catch (err) {
        log.warn(`video ${id} could not be resolved (${err.code})`);
      }
    }
  }
  if (!nodes.length) {
    throw new ConnectorError("TT_UNEXPECTED_RESPONSE", "No video id could be resolved.", 502);
  }
  return { nodes, nextCursor: null, source: "video_ids" };
}

async function browser(ctx) {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    throw new ConnectorError("TT_BROWSER_UNAVAILABLE", "Playwright is not installed.", 502);
  }

  const proxyConfig = ctx.fixedProxy;
  const launchOptions = {
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  };
  if (proxyConfig) {
    launchOptions.proxy = {
      server: `${proxyConfig.protocol}://${proxyConfig.host}:${proxyConfig.port}`,
      ...(proxyConfig.auth ? { username: proxyConfig.auth.username, password: proxyConfig.auth.password } : {}),
    };
  }
  const browserInstance = await chromium.launch(launchOptions);
  const items = [];
  let nextCursor = null;
  let domVideoIds = [];
  try {
    const context = await browserInstance.newContext({
      userAgent: process.env.TT_USER_AGENT || undefined,
      locale: "en-US",
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();
    page.on("response", async (response) => {
      if (!response.url().includes("/api/post/item_list/")) return;
      try {
        const text = await response.text();
        if (!text || text.length < 2) return; // TikTok returns an empty 200 when it blocks the IP
        const json = JSON.parse(text);
        for (const item of json?.itemList ?? []) items.push(item);
        if (json?.pageInfo?.hasMore) nextCursor = String(json.pageInfo.cursor ?? "");
      } catch {
        // A non-JSON response is not a post payload.
      }
    });
    await page.goto(`https://www.tiktok.com/@${encodeURIComponent(ctx.username)}`, {
      waitUntil: "domcontentloaded", timeout: 30000,
    });
    const deadline = Date.now() + Number(process.env.TT_BROWSER_WAIT_MS ?? 12000);
    while (items.length < (ctx.limit ?? 12) && Date.now() < deadline) {
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(1000);
    }
    // Fallback: if the XHR is blocked but the grid rendered, resolve the
    // video links present in the DOM through the video detail pages.
    if (!items.length) {
      const html = await page.content();
      domVideoIds = [...new Set((html.match(/\/video\/(\d{15,25})/g) || [])
        .map((s) => s.match(/video\/(\d+)/)[1]))].slice(0, ctx.limit ?? 12);
      for (const id of domVideoIds) {
        try {
          items.push(await fetchVideoDetail(id, ctx.username, {
            fixedProxy: ctx.fixedProxy, session: ctx.session,
          }));
        } catch {
          // Skip ids that no longer resolve.
        }
      }
    }
  } finally {
    await browserInstance.close();
  }

  if (!items.length) {
    throw new ConnectorError(
      "TT_ENDPOINT_BLOCKED",
      "The browser captured no post payload. TikTok usually returns an empty item_list when the exit IP is flagged; try a residential IP or a session cookie.",
      502,
      { domVideoIds: domVideoIds.length }
    );
  }
  return { nodes: items, nextCursor, source: "browser" };
}

const STRATEGIES = {
  browser,
  ssr_itemlist: ssrItemList,
  item_list: itemList,
  video_ids: videoIds,
};

async function runDiagnostics(ctx) {
  const results = [];
  for (const name of strategyOrder({ hasIds: Boolean(ctx.ids?.length) })) {
    const started = Date.now();
    try {
      const result = await STRATEGIES[name]({ ...ctx, limit: 1 });
      results.push({ strategy: name, ok: result.nodes.length > 0, posts: result.nodes.length, ms: Date.now() - started, source: result.source });
    } catch (err) {
      results.push({ strategy: name, ok: false, posts: 0, ms: Date.now() - started, code: err.code ?? "UNKNOWN", message: err.message });
    }
  }
  return results;
}

module.exports = { STRATEGIES, DEFAULT_ORDER, strategyOrder, runDiagnostics };
