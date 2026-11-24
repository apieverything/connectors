"use strict";

const axios = require("axios");
const {
  ConnectorError,
  readSession,
  buildBrowserHeaders,
} = require("./session");
const { getPool, redact } = require("./proxy");
const { log } = require("./logger");
const {
  parseHandleInput,
  parseVideoId,
  parseLimit,
  parseSearchQuery,
  parseLang,
  extractYtInitialData,
  extractYtInitialPlayerResponse,
  isConsentPage,
  textOf,
  parseTranscriptJson3,
  parseTranscriptXml,
} = require("./parsing");
const {
  normalizeChannel,
  extractVideosAndContinuation,
  extractCaptionTracks,
  normalizeCaptionLanguages,
  normalizeVideoDetail,
} = require("./normalize");

const YT_BASE = "https://www.youtube.com";
// Protobuf param selecting the "Videos" tab on a channel browse call
const VIDEOS_TAB_PARAMS = "EgZ2aWRlb3PyBgQKAjoA";
// Protobuf param filtering YouTube search to videos only
const SEARCH_VIDEO_FILTER_PARAMS = "EgIQAQ%3D%3D";

const DEFAULT_STRATEGIES = ["innertube", "html"];
const STRATEGY_ALIASES = {
  innertube: "innertube",
  innertube_browse: "innertube",
  innertube_search: "innertube",
  innertube_player: "innertube",
  html: "html",
  html_initial_data: "html",
  html_player_response: "html",
};

// Bounded cache of public @handle -> UC... channelId mappings (non-personal)
const HANDLE_CACHE_MAX = 500;
const HANDLE_CACHE_TTL_MS = 3_600_000;
const handleCache = new Map();

let lastRequestAt = 0;
let customTransport = null;

function setTransport(fn) {
  customTransport = fn;
}

const timeoutMs = () => Math.max(1000, Number(process.env.YT_TIMEOUT_MS ?? 15000));
const minIntervalMs = () => Math.max(0, Number(process.env.YT_MIN_INTERVAL_MS ?? 500));
const maxPages = () => Math.max(1, Number(process.env.YT_MAX_PAGES ?? 5));

async function throttle() {
  const interval = minIntervalMs();
  if (!interval) return;
  const wait = lastRequestAt + interval - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

function strategyOrder() {
  const raw = process.env.YT_STRATEGIES?.trim();
  if (!raw) return [...DEFAULT_STRATEGIES];
  const parsed = [];
  for (const token of raw.split(/[\s,]+/).filter(Boolean)) {
    const mapped = STRATEGY_ALIASES[token.toLowerCase()];
    if (mapped && !parsed.includes(mapped)) parsed.push(mapped);
  }
  return parsed.length ? parsed : [...DEFAULT_STRATEGIES];
}

function buildContext(clientType = "WEB") {
  const hl = process.env.YT_HL?.trim() || "en";
  const gl = process.env.YT_GL?.trim() || "US";
  const webVersion = process.env.YT_CLIENT_VERSION?.trim() || "2.20241114.01.00";

  if (clientType === "ANDROID") {
    return {
      client: {
        clientName: "ANDROID",
        clientVersion: "20.10.38",
        androidSdkVersion: 30,
        osName: "Android",
        osVersion: "11",
        hl,
        gl,
      },
    };
  }
  if (clientType === "IOS") {
    return {
      client: {
        clientName: "IOS",
        clientVersion: "20.10.4",
        deviceMake: "Apple",
        deviceModel: "iPhone16,2",
        osName: "iPhone",
        osVersion: "18.3.2.22D82",
        hl,
        gl,
      },
    };
  }
  return {
    client: {
      clientName: "WEB",
      clientVersion: webVersion,
      hl,
      gl,
    },
  };
}

async function performRequest({ method = "GET", url, data = undefined, headers = {}, proxy = null }) {
  await throttle();
  let res;
  try {
    if (customTransport) {
      res = await customTransport({ method, url, data, headers, proxy, timeout: timeoutMs() });
    } else {
      res = await axios({
        method,
        url,
        data,
        headers,
        proxy: proxy ?? undefined,
        timeout: timeoutMs(),
        maxRedirects: 5,
        validateStatus: () => true,
        responseType: "text",
        transformResponse: [(d) => d],
      });
    }
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError(
      "YT_NETWORK_ERROR",
      `Could not reach YouTube: ${redact(err.message)}`,
      502,
      redact(err.message)
    );
  }

  const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? "");
  const status = res.status;
  const finalUrl = res.request?.res?.responseUrl ?? res.finalUrl ?? url;

  if (isConsentPage(body, finalUrl)) {
    throw new ConnectorError("YT_CONSENT_GATE", "Redirected to consent.youtube.com.", 502);
  }
  if (status === 404) {
    throw new ConnectorError("YT_CHANNEL_NOT_FOUND", "YouTube resource not found (404).", 404);
  }
  if (status === 429) {
    throw new ConnectorError("YT_RATE_LIMITED", "YouTube returned HTTP 429.", 429, {
      retryAfter: res.headers?.["retry-after"] ?? null,
    });
  }
  if (status >= 500) {
    throw new ConnectorError("YT_UPSTREAM_ERROR", `YouTube returned HTTP ${status}.`, 502);
  }
  if (status >= 400) {
    throw new ConnectorError("YT_HTTP_ERROR", `YouTube returned HTTP ${status}.`, 502, {
      status,
      snippet: redact(body.slice(0, 180)),
    });
  }

  return { body, status, headers: res.headers ?? {}, finalUrl };
}

async function requestWithPool(reqSpec, options = {}) {
  const hasFixed = Object.prototype.hasOwnProperty.call(options, "fixedProxy");
  if (hasFixed) {
    return await performRequest({ ...reqSpec, proxy: options.fixedProxy ?? null });
  }
  const pool = getPool();
  let lastError;
  for (let attempt = 1; attempt <= pool.attempts; attempt += 1) {
    const selected = pool.select();
    try {
      return await performRequest({ ...reqSpec, proxy: selected?.config ?? null });
    } catch (err) {
      lastError = err;
      if (attempt === pool.attempts || !pool.isRetryable(err)) throw err;
      if (selected) pool.markFailed(selected.entry);
      log.warn(`proxy attempt ${attempt}/${pool.attempts} failed (${err.code}); rotating`);
    }
  }
  throw lastError;
}

async function innertubePost(endpoint, payload, { clientType = "WEB", session = null, referer = `${YT_BASE}/`, fixedProxy } = {}) {
  const pathPart = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const url = `${YT_BASE}/youtubei/v1${pathPart}?prettyPrint=false`;
  const headers = buildBrowserHeaders(session ?? readSession(), {
    json: true,
    referer,
    clientType,
  });
  const bodyObj = {
    context: buildContext(clientType),
    ...payload,
  };
  const opts = fixedProxy !== undefined ? { fixedProxy } : {};
  const { body } = await requestWithPool(
    { method: "POST", url, data: JSON.stringify(bodyObj), headers },
    opts
  );
  try {
    return JSON.parse(body);
  } catch {
    throw new ConnectorError("YT_UNEXPECTED_RESPONSE", "InnerTube returned non-JSON payload.", 502);
  }
}

// Continuation POST: YouTube answers 400 for malformed/expired tokens; surface that as a client error.
async function continuationPost(endpoint, cursor, opts) {
  try {
    return await innertubePost(endpoint, { continuation: cursor }, opts);
  } catch (err) {
    if (err.code === "YT_HTTP_ERROR" && err.details?.status === 400) {
      throw new ConnectorError("YT_INVALID_CURSOR", "The cursor is invalid or expired.", 400);
    }
    throw err;
  }
}

async function fetchHtml(pathOrUrl, { session = null, referer = `${YT_BASE}/`, fixedProxy } = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${YT_BASE}${pathOrUrl}`;
  const headers = buildBrowserHeaders(session ?? readSession(), { json: false, referer });
  const opts = fixedProxy !== undefined ? { fixedProxy } : {};
  return await requestWithPool({ method: "GET", url, headers }, opts);
}

function cacheHandle(handleKey, browseId) {
  if (!handleKey || !browseId) return;
  if (handleCache.size >= HANDLE_CACHE_MAX) {
    const oldest = handleCache.keys().next().value;
    if (oldest) handleCache.delete(oldest);
  }
  handleCache.set(handleKey.toLowerCase(), { browseId, expiresAt: Date.now() + HANDLE_CACHE_TTL_MS });
}

function getCachedHandle(handleKey) {
  if (!handleKey) return null;
  const hit = handleCache.get(handleKey.toLowerCase());
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    handleCache.delete(handleKey.toLowerCase());
    return null;
  }
  return hit.browseId;
}

async function resolveBrowseId(parsedHandle, opts = {}) {
  if (parsedHandle.channelId) return parsedHandle.channelId;
  const cached = getCachedHandle(parsedHandle.handle);
  if (cached) return cached;

  const targetUrl = `${YT_BASE}${parsedHandle.urlPath}/videos`;
  const rpcPaths = ["/navigation/resolve_url", "/resolve_url"];
  let lastErr = null;

  for (const rpc of rpcPaths) {
    try {
      const res = await innertubePost(rpc, { url: targetUrl }, opts);
      if (res?.error?.code === 404 || res?.error?.status === "NOT_FOUND") {
        throw new ConnectorError("YT_CHANNEL_NOT_FOUND", `Channel ${parsedHandle.handle} not found.`, 404);
      }
      const browseId =
        res?.endpoint?.browseEndpoint?.browseId ??
        res?.endpoint?.urlEndpoint?.browseId ??
        null;
      if (browseId) {
        cacheHandle(parsedHandle.handle, browseId);
        return browseId;
      }
    } catch (err) {
      if (err.code === "YT_CHANNEL_NOT_FOUND" && rpc === "/navigation/resolve_url") {
        // Double-check fallback endpoint only if RPC route itself 404'd vs channel 404
        lastErr = err;
        continue;
      }
      lastErr = err;
    }
  }
  throw lastErr ?? new ConnectorError("YT_CHANNEL_NOT_FOUND", `Could not resolve ${parsedHandle.handle}.`, 404);
}

function assertChannelPresent(data, parsedHandle) {
  const alerts = data?.alerts ?? [];
  for (const a of alerts) {
    const type = a?.alertRenderer?.type ?? a?.alertWithButtonRenderer?.type ?? "";
    const msg = textOf(a?.alertRenderer?.text ?? a?.alertWithButtonRenderer?.text).trim();
    if (/ERROR/i.test(type) && /does not exist|not available|terminated|closed/i.test(msg)) {
      throw new ConnectorError("YT_CHANNEL_NOT_FOUND", msg || "Channel not found.", 404);
    }
  }
  const hasHeader = Boolean(
    data?.header?.c4TabbedHeaderRenderer ||
      data?.header?.pageHeaderRenderer ||
      data?.metadata?.channelMetadataRenderer?.externalId
  );
  if (!hasHeader) {
    throw new ConnectorError(
      "YT_UNEXPECTED_RESPONSE",
      `No channel header returned for ${parsedHandle.handle ?? parsedHandle.channelId}.`,
      502
    );
  }
}

async function fetchChannelViaInnertube(parsedHandle, opts = {}) {
  const browseId = await resolveBrowseId(parsedHandle, opts);
  const data = await innertubePost(
    "/browse",
    { browseId, params: VIDEOS_TAB_PARAMS },
    { ...opts, referer: `${YT_BASE}${parsedHandle.urlPath}/videos` }
  );
  assertChannelPresent(data, parsedHandle);
  const profile = normalizeChannel(data, { ...parsedHandle, channelId: browseId }, "innertube_browse");
  if (profile.handle && profile.channelId) cacheHandle(profile.handle, profile.channelId);
  return { data, profile, source: "innertube_browse", strategy: "innertube_browse" };
}

async function fetchChannelViaHtml(parsedHandle, opts = {}) {
  const { body } = await fetchHtml(`${parsedHandle.urlPath}/videos`, opts);
  const data = extractYtInitialData(body);
  if (!data) {
    throw new ConnectorError("YT_UNEXPECTED_RESPONSE", "Could not extract ytInitialData from channel HTML.", 502);
  }
  assertChannelPresent(data, parsedHandle);
  const profile = normalizeChannel(data, parsedHandle, "html_initial_data");
  if (profile.handle && profile.channelId) cacheHandle(profile.handle, profile.channelId);
  return { data, profile, source: "html_initial_data", strategy: "html_initial_data" };
}

async function getChannel(handleInput, opts = {}) {
  const parsed = parseHandleInput(handleInput);
  const order = strategyOrder();
  const failures = [];

  for (const strat of order) {
    try {
      const res =
        strat === "innertube"
          ? await fetchChannelViaInnertube(parsed, opts)
          : await fetchChannelViaHtml(parsed, opts);
      return res.profile;
    } catch (err) {
      if (err.code === "YT_CHANNEL_NOT_FOUND" && strat === order[order.length - 1]) throw err;
      failures.push({ strategy: strat, code: err.code ?? "UNKNOWN", message: err.message });
      log.warn(`channel strategy ${strat} failed (${err.code ?? "UNKNOWN"}); trying next`);
    }
  }
  if (failures.length && failures.every((f) => f.code === "YT_CHANNEL_NOT_FOUND")) {
    throw new ConnectorError("YT_CHANNEL_NOT_FOUND", "Channel not found.", 404);
  }
  throw new ConnectorError("YT_ALL_STRATEGIES_FAILED", "All channel strategies failed.", 502, failures);
}

async function getChannelPosts(handleInput, { limit: rawLimit = 12, cursor = null } = {}, opts = {}) {
  const parsed = parseHandleInput(handleInput);
  const limit = parseLimit(rawLimit, 12, 100);
  const cleanCursor = cursor?.trim() || null;
  const order = strategyOrder();
  const failures = [];

  let winner = null;
  let profile = null;
  let firstBatch = null;

  if (cleanCursor) {
    // Continuation cursor always uses InnerTube /browse continuation
    const data = await continuationPost(
      "/browse",
      cleanCursor,
      { ...opts, referer: `${YT_BASE}${parsed.urlPath}/videos` }
    );
    const extracted = extractVideosAndContinuation(data, {
      username: parsed.username,
      channelId: parsed.channelId,
    });
    firstBatch = extracted;
    winner = "innertube_browse";
    try {
      profile = await getChannel(handleInput, opts);
    } catch {
      profile = {
        handle: parsed.handle,
        username: parsed.username,
        channelId: parsed.channelId,
        source: "innertube_browse",
      };
    }
  } else {
    for (const strat of order) {
      try {
        const res =
          strat === "innertube"
            ? await fetchChannelViaInnertube(parsed, opts)
            : await fetchChannelViaHtml(parsed, opts);
        profile = res.profile;
        firstBatch = extractVideosAndContinuation(res.data, profile);
        winner = res.strategy;
        break;
      } catch (err) {
        failures.push({ strategy: strat, code: err.code ?? "UNKNOWN", message: err.message });
        log.warn(`posts strategy ${strat} failed (${err.code ?? "UNKNOWN"}); trying next`);
      }
    }
  }

  if (!winner || !firstBatch) {
    if (failures.length && failures.every((f) => f.code === "YT_CHANNEL_NOT_FOUND")) {
      throw new ConnectorError("YT_CHANNEL_NOT_FOUND", "Channel not found.", 404);
    }
    throw new ConnectorError("YT_ALL_STRATEGIES_FAILED", "All channel video strategies failed.", 502, failures);
  }

  const collected = [];
  const seen = new Set();
  const addItems = (items) => {
    for (const item of items) {
      if (seen.has(item.videoId)) continue;
      seen.add(item.videoId);
      collected.push(item);
      if (collected.length >= limit) break;
    }
  };

  addItems(firstBatch.videos);
  let nextCursor = firstBatch.nextCursor;
  let prevCursor = cleanCursor;
  let pages = 1;
  const pageCap = maxPages();

  while (collected.length < limit && nextCursor && nextCursor !== prevCursor && pages < pageCap) {
    prevCursor = nextCursor;
    try {
      const contData = await innertubePost(
        "/browse",
        { continuation: nextCursor },
        { ...opts, referer: `${YT_BASE}${parsed.urlPath}/videos` }
      );
      const batch = extractVideosAndContinuation(contData, profile);
      nextCursor = batch.nextCursor;
      pages += 1;
      if (!batch.videos.length) break;
      addItems(batch.videos);
    } catch (err) {
      failures.push({ strategy: "innertube_browse", phase: "pagination", code: err.code ?? "UNKNOWN", message: err.message });
      break;
    }
  }

  const posts = collected.slice(0, limit);
  const hasMore = Boolean(nextCursor) || firstBatch.videos.length > posts.length;

  return {
    handle: profile?.handle ?? parsed.handle,
    username: profile?.username ?? parsed.username,
    channelId: profile?.channelId ?? parsed.channelId,
    profile,
    count: posts.length,
    posts,
    nextCursor: nextCursor ?? null,
    hasMore,
    strategy: winner,
    source: winner,
    failures,
  };
}

async function searchVideos(queryInput, { limit: rawLimit = 10, cursor = null } = {}, opts = {}) {
  const query = parseSearchQuery(queryInput);
  const limit = parseLimit(rawLimit, 10, 100);
  const cleanCursor = cursor?.trim() || null;
  const order = strategyOrder();
  const failures = [];

  let winner = null;
  let firstBatch = null;

  if (cleanCursor) {
    const data = await continuationPost("/search", cleanCursor, opts);
    firstBatch = extractVideosAndContinuation(data, null);
    winner = "innertube_search";
  } else {
    for (const strat of order) {
      try {
        if (strat === "innertube") {
          const data = await innertubePost(
            "/search",
            { query, params: SEARCH_VIDEO_FILTER_PARAMS },
            { ...opts, referer: `${YT_BASE}/results?search_query=${encodeURIComponent(query)}` }
          );
          firstBatch = extractVideosAndContinuation(data, null);
          winner = "innertube_search";
        } else {
          const { body } = await fetchHtml(
            `/results?search_query=${encodeURIComponent(query)}&sp=${SEARCH_VIDEO_FILTER_PARAMS}`,
            opts
          );
          const data = extractYtInitialData(body);
          if (!data) {
            throw new ConnectorError("YT_UNEXPECTED_RESPONSE", "Could not extract ytInitialData from search HTML.", 502);
          }
          firstBatch = extractVideosAndContinuation(data, null);
          winner = "html_initial_data";
        }
        break;
      } catch (err) {
        failures.push({ strategy: strat, code: err.code ?? "UNKNOWN", message: err.message });
        log.warn(`search strategy ${strat} failed (${err.code ?? "UNKNOWN"}); trying next`);
      }
    }
  }

  if (!winner || !firstBatch) {
    throw new ConnectorError("YT_ALL_STRATEGIES_FAILED", "All search strategies failed.", 502, failures);
  }

  const collected = [];
  const seen = new Set();
  const addItems = (items) => {
    for (const item of items) {
      if (seen.has(item.videoId)) continue;
      seen.add(item.videoId);
      collected.push(item);
      if (collected.length >= limit) break;
    }
  };

  addItems(firstBatch.videos);
  let nextCursor = firstBatch.nextCursor;
  let prevCursor = cleanCursor;
  let pages = 1;
  const pageCap = maxPages();

  while (collected.length < limit && nextCursor && nextCursor !== prevCursor && pages < pageCap) {
    prevCursor = nextCursor;
    try {
      const contData = await innertubePost("/search", { continuation: nextCursor }, opts);
      const batch = extractVideosAndContinuation(contData, null);
      nextCursor = batch.nextCursor;
      pages += 1;
      if (!batch.videos.length) break;
      addItems(batch.videos);
    } catch (err) {
      failures.push({ strategy: "innertube_search", phase: "pagination", code: err.code ?? "UNKNOWN", message: err.message });
      break;
    }
  }

  const videos = collected.slice(0, limit);
  return {
    query,
    count: videos.length,
    videos,
    nextCursor: nextCursor ?? null,
    hasMore: Boolean(nextCursor) || firstBatch.videos.length > videos.length,
    strategy: winner,
    source: winner,
    failures,
  };
}

function isPlayerUsable(pr) {
  return Boolean(pr?.videoDetails?.videoId && pr?.videoDetails?.title);
}

function isDefinitelyUnavailable(pr) {
  const status = pr?.playabilityStatus?.status ?? "";
  const reason = textOf(pr?.playabilityStatus?.reason).trim();
  return (
    (status === "ERROR" || status === "LOGIN_REQUIRED") &&
    !pr?.videoDetails?.videoId &&
    /unavailable|private|removed|deleted|does not exist/i.test(reason || status)
  );
}

async function fetchPlayerBundle(videoId, { needCaptions = false, fixedProxy } = {}) {
  const opts = fixedProxy !== undefined ? { fixedProxy } : {};
  const order = strategyOrder();
  const failures = [];

  let bestPlayer = null;
  let watchData = null;
  let bestSource = null;
  let bestClient = null;

  for (const strat of order) {
    if (strat === "innertube") {
      const clients = needCaptions ? ["ANDROID", "IOS", "WEB"] : ["WEB", "ANDROID", "IOS"];
      for (const clientType of clients) {
        try {
          const pr = await innertubePost(
            "/player",
            { videoId, contentCheckOk: true, racyCheckOk: true },
            { ...opts, clientType, referer: `${YT_BASE}/watch?v=${videoId}` }
          );
          if (isDefinitelyUnavailable(pr) && clientType === clients[clients.length - 1] && !bestPlayer) {
            throw new ConnectorError(
              "YT_VIDEO_NOT_FOUND",
              textOf(pr.playabilityStatus?.reason).trim() || "Video unavailable.",
              404
            );
          }
          if (isPlayerUsable(pr)) {
            if (!bestPlayer) {
              bestPlayer = pr;
              bestSource = `innertube_player`;
              bestClient = clientType;
            }
            const tracks = extractCaptionTracks(pr);
            if (!needCaptions || tracks.length > 0) {
              bestPlayer = pr;
              bestSource = `innertube_player`;
              bestClient = clientType;
              break;
            }
          }
        } catch (err) {
          if (err.code === "YT_VIDEO_NOT_FOUND") throw err;
          failures.push({ strategy: `innertube_${clientType.toLowerCase()}`, code: err.code ?? "UNKNOWN", message: err.message });
        }
      }

      if (bestPlayer && !needCaptions) {
        // Best-effort /next call to enrich likes & engagement panel chapters
        try {
          watchData = await innertubePost(
            "/next",
            { videoId },
            { ...opts, clientType: "WEB", referer: `${YT_BASE}/watch?v=${videoId}` }
          );
        } catch {
          watchData = null;
        }
      }

      if (bestPlayer && (!needCaptions || extractCaptionTracks(bestPlayer).length > 0)) {
        return { playerResponse: bestPlayer, initialData: watchData, source: bestSource, clientType: bestClient };
      }
    } else if (strat === "html") {
      try {
        const { body } = await fetchHtml(`/watch?v=${videoId}&hl=en`, opts);
        const pr = extractYtInitialPlayerResponse(body);
        const idata = extractYtInitialData(body);
        if (pr && isDefinitelyUnavailable(pr) && !bestPlayer) {
          throw new ConnectorError(
            "YT_VIDEO_NOT_FOUND",
            textOf(pr.playabilityStatus?.reason).trim() || "Video unavailable.",
            404
          );
        }
        if (pr && isPlayerUsable(pr)) {
          return { playerResponse: pr, initialData: idata, source: "html_player_response" };
        }
        failures.push({ strategy: "html", code: "YT_UNEXPECTED_RESPONSE", message: "No usable ytInitialPlayerResponse in watch HTML." });
      } catch (err) {
        if (err.code === "YT_VIDEO_NOT_FOUND") throw err;
        failures.push({ strategy: "html", code: err.code ?? "UNKNOWN", message: err.message });
      }
    }
  }

  if (bestPlayer) {
    return { playerResponse: bestPlayer, initialData: watchData, source: bestSource ?? "innertube_player", clientType: bestClient };
  }
  throw new ConnectorError("YT_ALL_STRATEGIES_FAILED", `Could not fetch video ${videoId}.`, 502, failures);
}

async function getVideo(videoIdInput, opts = {}) {
  const videoId = parseVideoId(videoIdInput);
  const { playerResponse, initialData, source } = await fetchPlayerBundle(videoId, {
    needCaptions: false,
    fixedProxy: opts.fixedProxy,
  });
  // The WEB client no longer returns caption tracks (needs PO token). Borrow them
  // from a mobile client so captionLanguages is populated (best effort).
  if (!extractCaptionTracks(playerResponse).length && strategyOrder().includes("innertube")) {
    try {
      const cap = await fetchPlayerBundle(videoId, { needCaptions: true, fixedProxy: opts.fixedProxy });
      if (cap.playerResponse?.captions && extractCaptionTracks(cap.playerResponse).length) {
        playerResponse.captions = cap.playerResponse.captions;
      }
    } catch {
      /* captions are optional for video detail */
    }
  }
  return normalizeVideoDetail(playerResponse, initialData, source);
}

function selectCaptionTrack(tracks, lang, explicit) {
  const target = lang.toLowerCase();
  const baseLang = target.split("-")[0];

  // 1. Exact manual match
  const exactManual = tracks.find(
    (t) => String(t.languageCode ?? "").toLowerCase() === target && t.kind !== "asr"
  );
  if (exactManual) return exactManual;

  // 2. Exact auto-generated match
  const exactAsr = tracks.find((t) => String(t.languageCode ?? "").toLowerCase() === target);
  if (exactAsr) return exactAsr;

  // 3. Prefix match (e.g. "en" matching "en-US" or "en-GB"), manual first
  const prefixManual = tracks.find(
    (t) => String(t.languageCode ?? "").toLowerCase().startsWith(`${baseLang}-`) && t.kind !== "asr"
  );
  if (prefixManual) return prefixManual;

  const prefixAsr = tracks.find((t) =>
    String(t.languageCode ?? "").toLowerCase().startsWith(`${baseLang}-`)
  );
  if (prefixAsr) return prefixAsr;

  // 4. If user didn't explicitly ask for a non-existent language, return first track
  if (!explicit && tracks.length > 0) return tracks[0];
  return null;
}

function captionHeaders(clientType, videoId) {
  const base = buildBrowserHeaders(readSession(), {
    json: false,
    referer: `${YT_BASE}/watch?v=${videoId}`,
    clientType: clientType === "ANDROID" || clientType === "IOS" ? clientType : "WEB",
  });
  if (clientType === "ANDROID" || clientType === "IOS") {
    // timedtext is a plain GET; drop JSON API headers
    delete base["Content-Type"];
    base.Accept = "*/*";
  }
  return base;
}

function withFmtJson3(baseUrl) {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set("fmt", "json3");
    return u.toString();
  } catch {
    return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}fmt=json3`;
  }
}

async function getTranscript(videoIdInput, { lang: rawLang = null } = {}, opts = {}) {
  const videoId = parseVideoId(videoIdInput);
  const { lang, explicit } = parseLang(rawLang);
  const { playerResponse, source, clientType } = await fetchPlayerBundle(videoId, {
    needCaptions: true,
    fixedProxy: opts.fixedProxy,
  });

  const tracks = extractCaptionTracks(playerResponse);
  const availableLanguages = normalizeCaptionLanguages(tracks);

  if (!tracks.length) {
    throw new ConnectorError(
      "YT_NO_TRANSCRIPT",
      `Video ${videoId} has no public captions available.`,
      404,
      { videoId, availableLanguages: [] }
    );
  }

  const chosen = selectCaptionTrack(tracks, lang, explicit);
  if (!chosen || !chosen.baseUrl) {
    throw new ConnectorError(
      "YT_NO_TRANSCRIPT",
      `No transcript available for language "${lang}".`,
      404,
      { videoId, requestedLanguage: lang, availableLanguages }
    );
  }

  // Caption URLs are bound to the client that issued them: fetch with that client's UA.
  const headers = captionHeaders(clientType, videoId);
  const poolOpts = opts.fixedProxy !== undefined ? { fixedProxy: opts.fixedProxy } : {};

  let segments = [];
  // Try JSON3 first, then XML fallback
  try {
    const jsonUrl = withFmtJson3(chosen.baseUrl);
    const { body } = await requestWithPool({ method: "GET", url: jsonUrl, headers }, poolOpts);
    const trimmed = body.trim();
    if (trimmed.startsWith("{")) {
      segments = parseTranscriptJson3(trimmed);
    } else if (trimmed.startsWith("<")) {
      segments = parseTranscriptXml(trimmed);
    }
  } catch {
    segments = [];
  }

  if (!segments.length) {
    const { body } = await requestWithPool({ method: "GET", url: chosen.baseUrl, headers }, poolOpts);
    const trimmed = body.trim();
    segments = trimmed.startsWith("{")
      ? parseTranscriptJson3(trimmed)
      : parseTranscriptXml(trimmed);
  }

  if (!segments.length) {
    throw new ConnectorError(
      "YT_NO_TRANSCRIPT",
      `Caption track for "${chosen.languageCode}" returned no readable segments.`,
      404,
      { videoId, language: chosen.languageCode, availableLanguages }
    );
  }

  return {
    videoId,
    language: chosen.languageCode,
    isAutoGenerated: chosen.kind === "asr",
    availableLanguages,
    count: segments.length,
    fullText: segments.map((s) => s.text).join(" "),
    segments,
    source,
  };
}

async function runDiagnostics(handleInput = "@mkbhd", opts = {}) {
  const parsed = parseHandleInput(handleInput);
  const results = [];
  for (const strat of strategyOrder()) {
    const started = Date.now();
    try {
      const res =
        strat === "innertube"
          ? await fetchChannelViaInnertube(parsed, opts)
          : await fetchChannelViaHtml(parsed, opts);
      const { videos } = extractVideosAndContinuation(res.data, res.profile);
      results.push({
        strategy: res.strategy,
        ok: Boolean(res.profile?.channelId),
        channelId: res.profile?.channelId ?? null,
        posts: videos.length,
        ms: Date.now() - started,
        source: res.source,
      });
    } catch (err) {
      results.push({
        strategy: strat === "innertube" ? "innertube_browse" : "html_initial_data",
        ok: false,
        channelId: null,
        posts: 0,
        ms: Date.now() - started,
        code: err.code ?? "UNKNOWN",
        message: err.message,
      });
    }
  }
  return results;
}

module.exports = {
  VIDEOS_TAB_PARAMS,
  SEARCH_VIDEO_FILTER_PARAMS,
  DEFAULT_STRATEGIES,
  strategyOrder,
  buildContext,
  setTransport,
  resolveBrowseId,
  getChannel,
  getChannelPosts,
  searchVideos,
  getVideo,
  getTranscript,
  runDiagnostics,
};
