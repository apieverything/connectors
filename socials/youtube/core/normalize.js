"use strict";

const {
  textOf,
  parseCountText,
  parseDurationSeconds,
  formatDuration,
  parseDateValue,
  extractHashtags,
  extractMentions,
  unwrapRedirectUrl,
  parseChaptersFromDescription,
} = require("./parsing");

function pick(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== "");
}

function normalizeUrl(url) {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("/")) return `https://www.youtube.com${trimmed}`;
  return trimmed;
}

/** Extract thumbnail objects sorted from largest to smallest resolution, deduplicated. */
function extractThumbnails(thumbNode) {
  const list =
    thumbNode?.thumbnails ??
    thumbNode?.sources ??
    (Array.isArray(thumbNode) ? thumbNode : []);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const url = normalizeUrl(item?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      width: Number.isFinite(Number(item?.width)) ? Number(item.width) : null,
      height: Number.isFinite(Number(item?.height)) ? Number(item.height) : null,
    });
  }
  out.sort((a, b) => ((b.width ?? 0) * (b.height ?? 0)) - ((a.width ?? 0) * (a.height ?? 0)));
  return out;
}

function bestThumbnailUrl(thumbNode) {
  return extractThumbnails(thumbNode)[0]?.url ?? null;
}

function parseKeywordsString(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
  const matches = String(raw).match(/"([^"]+)"|(\S+)/g) ?? [];
  return [...new Set(matches.map((m) => m.replace(/^"|"$/g, "").trim()).filter(Boolean))];
}

function extractHandleFromUrl(url) {
  const m = /youtube\.com\/(@[A-Za-z0-9._-]+)/i.exec(String(url ?? ""));
  return m ? m[1] : null;
}

function hasVerifiedBadge(badges) {
  if (!Array.isArray(badges)) return false;
  return badges.some((b) => {
    const style = b?.metadataBadgeRenderer?.style ?? b?.style ?? "";
    const icon = b?.metadataBadgeRenderer?.icon?.iconType ?? "";
    return /VERIFIED|OFFICIAL_ARTIST/i.test(style) || /CHECK_CIRCLE|MUSIC_NOTE/i.test(icon);
  });
}

function findDeepFirst(root, predicate, maxDepth = 12) {
  const stack = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (predicate(node)) return node;
    if (depth >= maxDepth) continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) {
        stack.push({ node: node[i], depth: depth + 1 });
      }
    } else {
      for (const val of Object.values(node)) {
        if (val && typeof val === "object") stack.push({ node: val, depth: depth + 1 });
      }
    }
  }
  return null;
}

/**
 * Normalize channel metadata across classic `c4TabbedHeaderRenderer`,
 * modern `pageHeaderRenderer.content.pageHeaderViewModel`, `channelMetadataRenderer`,
 * `microformatDataRenderer`, and `aboutChannelViewModel`.
 */
function normalizeChannel(data, fallbackInput = null, source = "innertube_browse") {
  const d = data ?? {};
  const meta = d.metadata?.channelMetadataRenderer ?? {};
  const micro = d.microformat?.microformatDataRenderer ?? {};
  const c4 = d.header?.c4TabbedHeaderRenderer ?? {};
  const phvm = d.header?.pageHeaderRenderer?.content?.pageHeaderViewModel ?? {};
  const aboutNode = findDeepFirst(
    d,
    (n) => Boolean(n.aboutChannelViewModel || n.channelAboutFullMetadataRenderer),
    10
  );
  const about = aboutNode?.aboutChannelViewModel ?? aboutNode?.channelAboutFullMetadataRenderer ?? {};

  // Scan pageHeaderViewModel metadataRows for @handle, subscribers, videos, views
  let phHandle = null;
  let phSubsText = null;
  let phVideosText = null;
  let phViewsText = null;
  const rows = phvm.metadata?.contentMetadataViewModel?.metadataRows ?? [];
  for (const row of rows) {
    for (const part of row?.metadataParts ?? []) {
      const txt = textOf(part?.text ?? part).trim();
      if (!txt) continue;
      if (!phHandle && txt.startsWith("@")) phHandle = txt.split(/\s+/)[0];
      else if (!phSubsText && /subscribers?/i.test(txt)) phSubsText = txt;
      else if (!phVideosText && /videos?/i.test(txt)) phVideosText = txt;
      else if (!phViewsText && /views?/i.test(txt)) phViewsText = txt;
    }
  }

  const c4Handle = textOf(c4.channelHandleText).trim() || null;
  const urlHandle =
    extractHandleFromUrl(meta.vanityChannelUrl) ??
    extractHandleFromUrl(micro.vanityChannelUrl) ??
    extractHandleFromUrl((meta.ownerUrls ?? [])[0]);

  let handle = pick(phHandle, c4Handle, urlHandle, fallbackInput?.handle) ?? null;
  if (handle && !handle.startsWith("@") && !handle.startsWith("UC")) handle = `@${handle}`;

  const channelId =
    pick(
      meta.externalId,
      c4.channelId,
      about.channelId,
      /\/channel\/(UC[A-Za-z0-9_-]{22})/.exec(micro.urlCanonical ?? "")?.[1],
      fallbackInput?.channelId
    ) ?? null;

  const username = handle ? handle.replace(/^@/, "") : channelId;

  const subscribersText =
    pick(
      phSubsText,
      textOf(c4.subscriberCountText).trim(),
      textOf(about.subscriberCountText).trim()
    ) || null;
  const subscribers = parseCountText(subscribersText);

  const videosText =
    pick(
      phVideosText,
      textOf(c4.videosCountText).trim(),
      textOf(about.videoCountText).trim()
    ) || null;
  const videosCount = parseCountText(videosText);

  const viewsText =
    pick(phViewsText, textOf(about.viewCountText).trim()) || null;
  const views = parseCountText(viewsText);

  const fullName =
    pick(
      textOf(phvm.title?.dynamicTextViewModel?.text).trim(),
      textOf(c4.title).trim(),
      meta.title,
      micro.title
    ) || null;

  const description =
    pick(
      meta.description,
      textOf(about.description).trim(),
      textOf(phvm.description?.descriptionPreviewViewModel?.description).trim(),
      micro.description
    ) ?? "";

  const avatar =
    pick(
      bestThumbnailUrl(phvm.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image),
      bestThumbnailUrl(c4.avatar),
      bestThumbnailUrl(meta.avatar),
      bestThumbnailUrl(micro.thumbnail)
    ) ?? null;

  const banner =
    pick(
      bestThumbnailUrl(phvm.banner?.imageBannerViewModel?.image),
      bestThumbnailUrl(c4.banner),
      bestThumbnailUrl(c4.tvBanner)
    ) ?? null;

  const phVerified = Boolean(
    JSON.stringify(phvm.title ?? {}).match(/CHECK_CIRCLE_FILLED|VERIFIED|OFFICIAL_ARTIST/i)
  );
  const isVerified = hasVerifiedBadge(c4.badges) || phVerified;

  const country = pick(textOf(about.country).trim(), meta.country) || null;
  const keywords = parseKeywordsString(meta.keywords ?? micro.tags);

  const links = [];
  const seenLinks = new Set();
  const pushLink = (title, rawHref) => {
    const clean = unwrapRedirectUrl(rawHref);
    if (!clean || seenLinks.has(clean)) return;
    seenLinks.add(clean);
    links.push({ title: title || null, url: clean });
  };

  const c4Links = [
    ...(c4.headerLinks?.channelHeaderLinksRenderer?.primaryLinks ?? []),
    ...(c4.headerLinks?.channelHeaderLinksRenderer?.secondaryLinks ?? []),
  ];
  for (const l of c4Links) {
    pushLink(
      textOf(l.title).trim(),
      l.navigationEndpoint?.urlEndpoint?.url ??
        l.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url
    );
  }
  for (const l of about.links ?? []) {
    const vm = l.channelExternalLinkViewModel ?? l;
    const rawHref =
      textOf(vm.link).trim() ||
      vm.link?.commandRuns?.[0]?.onTap?.innertubeCommand?.urlEndpoint?.url ||
      vm.url;
    const normalizedHref =
      rawHref && !/^https?:\/\//i.test(rawHref) ? `https://${rawHref}` : rawHref;
    pushLink(textOf(vm.title).trim(), normalizedHref);
  }

  const url = handle
    ? `https://www.youtube.com/${handle}`
    : channelId
      ? `https://www.youtube.com/channel/${channelId}`
      : null;

  return {
    handle,
    username,
    channelId,
    url,
    fullName,
    description,
    subscribers,
    subscribersText,
    videosCount,
    views,
    avatar,
    banner,
    isVerified,
    country,
    keywords,
    links,
    source,
  };
}

/**
 * Normalize a single YouTube video item from `videoRenderer`, `gridVideoRenderer`,
 * `richItemRenderer`, `reelItemRenderer`, `shortsLockupViewModel`, or `lockupViewModel`
 * into API Everything's unified post shape.
 */
function normalizeVideoCard(rawNode, fallbackChannel = null, nowMs = Date.now()) {
  if (!rawNode || typeof rawNode !== "object") return null;
  const unwrapped = rawNode.richItemRenderer?.content ?? rawNode;

  // 1. Shorts Lockup View Model (modern Shorts shelf/tab)
  const slvm = unwrapped.shortsLockupViewModel ?? unwrapped.shortsLockupViewModel?.lockupViewModel;
  if (unwrapped.shortsLockupViewModel) {
    const s = unwrapped.shortsLockupViewModel;
    const videoId =
      s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ??
      /^shorts-shelf-item-([A-Za-z0-9_-]{11})$/.exec(s.entityId ?? "")?.[1] ??
      null;
    if (!videoId) return null;
    const title = textOf(s.overlayMetadata?.primaryText).trim();
    const viewsText = textOf(s.overlayMetadata?.secondaryText).trim();
    const photos = extractThumbnails(s.thumbnail).map((t) => t.url);
    return {
      url: `https://www.youtube.com/shorts/${videoId}`,
      shortcode: videoId,
      videoId,
      title,
      userPosted: fallbackChannel?.username ?? fallbackChannel?.fullName ?? null,
      channelId: fallbackChannel?.channelId ?? null,
      description: "",
      hashtags: extractHashtags(title),
      mentions: extractMentions(title),
      views: parseCountText(viewsText),
      duration: null,
      durationSeconds: null,
      datePosted: null,
      publishedText: null,
      likes: null,
      numComments: null,
      photos,
      type: "short",
    };
  }

  // 2. Modern unified LockupViewModel
  if (unwrapped.lockupViewModel) {
    const lvm = unwrapped.lockupViewModel;
    if (lvm.contentType && lvm.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO" && lvm.contentType !== "LOCKUP_CONTENT_TYPE_SHORT") {
      return null;
    }
    const videoId = lvm.contentId ?? null;
    if (!videoId || videoId.length !== 11) return null;
    const title = textOf(lvm.metadata?.lockupMetadataViewModel?.title).trim();
    let author = fallbackChannel?.username ?? null;
    let viewsText = null;
    let publishedText = null;
    const metaRows = lvm.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows ?? [];
    for (const row of metaRows) {
      for (const part of row?.metadataParts ?? []) {
        const txt = textOf(part?.text ?? part).trim();
        if (!txt) continue;
        if (/views?/i.test(txt)) viewsText = txt;
        else if (/ago|streamed|premiered/i.test(txt)) publishedText = txt;
        else if (!author) author = txt;
      }
    }
    let durationRaw = null;
    for (const ov of lvm.contentImage?.thumbnailViewModel?.overlays ?? []) {
      const badges = ov?.thumbnailOverlayBadgeViewModel?.thumbnailBadges ?? [];
      for (const b of badges) {
        const bt = textOf(b?.thumbnailBadgeViewModel?.text).trim();
        if (bt) durationRaw = bt;
      }
    }
    const isShort = lvm.contentType === "LOCKUP_CONTENT_TYPE_SHORT" || /^shorts$/i.test(durationRaw ?? "");
    const durationSeconds = parseDurationSeconds(durationRaw);
    const photos = extractThumbnails(lvm.contentImage?.thumbnailViewModel?.image).map((t) => t.url);
    return {
      url: isShort ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`,
      shortcode: videoId,
      videoId,
      title,
      userPosted: author,
      channelId: fallbackChannel?.channelId ?? null,
      description: "",
      hashtags: extractHashtags(title),
      mentions: extractMentions(title),
      views: parseCountText(viewsText),
      duration: durationSeconds !== null ? formatDuration(durationSeconds) : null,
      durationSeconds,
      datePosted: parseDateValue(publishedText, nowMs),
      publishedText,
      likes: null,
      numComments: null,
      photos,
      type: isShort ? "short" : "video",
    };
  }

  // 3. Classic videoRenderer / gridVideoRenderer / reelItemRenderer / compactVideoRenderer
  const v =
    unwrapped.videoRenderer ??
    unwrapped.gridVideoRenderer ??
    unwrapped.playlistVideoRenderer ??
    unwrapped.compactVideoRenderer ??
    unwrapped.reelItemRenderer ??
    (unwrapped.videoId ? unwrapped : null);
  if (!v || !v.videoId) return null;

  const videoId = v.videoId;
  const title = textOf(v.title ?? v.headline).trim();
  const description =
    pick(
      textOf(v.descriptionSnippet).trim(),
      textOf(v.detailedMetadataSnippets?.[0]?.snippetText).trim()
    ) ?? "";

  let overlayDuration = null;
  let overlayStyle = null;
  for (const ov of v.thumbnailOverlays ?? []) {
    const ts = ov?.thumbnailOverlayTimeStatusRenderer;
    if (ts) {
      overlayStyle = ts.style ?? overlayStyle;
      overlayDuration = textOf(ts.text).trim() || overlayDuration;
    }
  }

  const navUrl = v.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url ?? "";
  const isShort =
    Boolean(unwrapped.reelItemRenderer) ||
    Boolean(v.navigationEndpoint?.reelWatchEndpoint) ||
    overlayStyle === "SHORTS" ||
    /^\/shorts\//.test(navUrl);

  const rawLength = pick(textOf(v.lengthText).trim(), overlayDuration, v.lengthSeconds);
  const durationSeconds = parseDurationSeconds(rawLength);
  const duration = durationSeconds !== null ? formatDuration(durationSeconds) : null;

  const viewsText =
    pick(textOf(v.viewCountText).trim(), textOf(v.shortViewCountText).trim()) || null;
  const views = parseCountText(viewsText);

  const publishedText = textOf(v.publishedTimeText).trim() || null;
  const datePosted = parseDateValue(publishedText, nowMs);

  const ownerRuns = v.ownerText?.runs ?? v.longBylineText?.runs ?? v.shortBylineText?.runs ?? [];
  const ownerBrowse = ownerRuns[0]?.navigationEndpoint?.browseEndpoint;
  const ownerUrl = ownerBrowse?.canonicalBaseUrl ?? "";
  const ownerHandle = ownerUrl.startsWith("/@") ? ownerUrl.slice(2) : null;
  const userPosted =
    pick(
      ownerHandle,
      fallbackChannel?.username,
      textOf(v.ownerText).trim(),
      textOf(v.shortBylineText).trim(),
      fallbackChannel?.fullName
    ) || null;
  const channelId = pick(ownerBrowse?.browseId, fallbackChannel?.channelId) ?? null;

  const photos = extractThumbnails(v.thumbnail).map((t) => t.url);
  if (!photos.length) {
    photos.push(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
  }

  const combinedText = `${title}\n${description}`;
  return {
    url: isShort
      ? `https://www.youtube.com/shorts/${videoId}`
      : `https://www.youtube.com/watch?v=${videoId}`,
    shortcode: videoId,
    videoId,
    title,
    userPosted,
    channelId,
    description,
    hashtags: extractHashtags(combinedText),
    mentions: extractMentions(combinedText),
    views,
    duration,
    durationSeconds,
    datePosted,
    publishedText,
    likes: null,
    numComments: null,
    photos,
    type: isShort ? "short" : "video",
  };
}

function tokenFromContinuationItem(item) {
  const renderer = item?.continuationItemRenderer;
  if (!renderer) return null;
  const ep = renderer.continuationEndpoint;
  if (ep?.continuationCommand?.token) return ep.continuationCommand.token;
  const cmds = ep?.commandExecutorCommand?.commands ?? [];
  for (const cmd of cmds) {
    if (cmd?.continuationCommand?.token) return cmd.continuationCommand.token;
  }
  return renderer.button?.buttonRenderer?.command?.continuationCommand?.token ?? null;
}

/**
 * Extract video items and the feed's next continuation cursor from either an
 * initial `browse`/`search`/`ytInitialData` payload or a continuation payload.
 */
function extractVideosAndContinuation(data, fallbackChannel = null, nowMs = Date.now()) {
  const d = data ?? {};
  const videos = [];
  const seen = new Set();
  let nextCursor = null;

  const pushCard = (node) => {
    const card = normalizeVideoCard(node, fallbackChannel, nowMs);
    if (card && !seen.has(card.videoId)) {
      seen.add(card.videoId);
      videos.push(card);
    }
  };

  const scanItemsArray = (items) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const tok = tokenFromContinuationItem(item);
      if (tok) {
        nextCursor = tok;
        continue;
      }
      if (item.itemSectionRenderer?.contents) {
        scanItemsArray(item.itemSectionRenderer.contents);
        continue;
      }
      if (item.richSectionRenderer?.content?.richShelfRenderer?.contents) {
        scanItemsArray(item.richSectionRenderer.content.richShelfRenderer.contents);
        continue;
      }
      if (item.shelfRenderer?.content?.horizontalListRenderer?.items) {
        scanItemsArray(item.shelfRenderer.content.horizontalListRenderer.items);
        continue;
      }
      if (item.shelfRenderer?.content?.expandedShelfContentsRenderer?.items) {
        scanItemsArray(item.shelfRenderer.content.expandedShelfContentsRenderer.items);
        continue;
      }
      if (item.gridRenderer?.items) {
        scanItemsArray(item.gridRenderer.items);
        continue;
      }
      pushCard(item);
    }
  };

  // 1. Continuation actions (browse/search page 2+)
  const actions = [
    ...(d.onResponseReceivedActions ?? []),
    ...(d.onResponseReceivedEndpoints ?? []),
    ...(d.onResponseReceivedCommands ?? []),
  ];
  for (const action of actions) {
    const contItems =
      action?.appendContinuationItemsAction?.continuationItems ??
      action?.reloadContinuationItemsCommand?.continuationItems;
    if (contItems) scanItemsArray(contItems);
  }

  // 2. Channel tabs (prefer selected tab, or Videos tab)
  const tabs = d.contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];
  if (tabs.length) {
    const selectedTab =
      tabs.find((t) => t?.tabRenderer?.selected && t?.tabRenderer?.content) ??
      tabs.find((t) => /videos/i.test(t?.tabRenderer?.title ?? "") && t?.tabRenderer?.content) ??
      tabs.find((t) => t?.tabRenderer?.content);
    const tabContent = selectedTab?.tabRenderer?.content;
    if (tabContent?.richGridRenderer?.contents) {
      scanItemsArray(tabContent.richGridRenderer.contents);
    } else if (tabContent?.sectionListRenderer?.contents) {
      scanItemsArray(tabContent.sectionListRenderer.contents);
    }
  }

  // 3. Search results (twoColumnSearchResultsRenderer / sectionListRenderer)
  const searchPrimary = d.contents?.twoColumnSearchResultsRenderer?.primaryContents;
  if (searchPrimary?.sectionListRenderer?.contents) {
    scanItemsArray(searchPrimary.sectionListRenderer.contents);
  } else if (searchPrimary?.richGridRenderer?.contents) {
    scanItemsArray(searchPrimary.richGridRenderer.contents);
  }
  if (d.contents?.sectionListRenderer?.contents) {
    scanItemsArray(d.contents.sectionListRenderer.contents);
  }

  return { videos, nextCursor };
}

function extractLikesFromWatchData(initialData) {
  if (!initialData) return null;
  // Modern segmentedLikeDislikeButtonViewModel
  const likeVm = findDeepFirst(
    initialData,
    (n) => Boolean(n.segmentedLikeDislikeButtonViewModel || n.likeButtonViewModel),
    14
  );
  if (likeVm) {
    const raw = JSON.stringify(likeVm);
    const accMatch = /like this video along with ([\d,]+) other/i.exec(raw);
    if (accMatch) return parseCountText(accMatch[1]);
    const titleMatch = /"title":\{"content":"([\d.,]+\s*[KMB]?)"\}/i.exec(raw);
    if (titleMatch) return parseCountText(titleMatch[1]);
  }
  // Legacy topLevelButtons toggleButtonRenderer
  const toggle = findDeepFirst(
    initialData,
    (n) =>
      n.toggleButtonRenderer?.defaultIcon?.iconType === "LIKE" ||
      /like this video/i.test(n.toggleButtonRenderer?.accessibilityData?.accessibilityData?.label ?? ""),
    14
  );
  if (toggle?.toggleButtonRenderer) {
    const label = toggle.toggleButtonRenderer.accessibilityData?.accessibilityData?.label ?? "";
    const parsed = parseCountText(label) ?? parseCountText(toggle.toggleButtonRenderer.defaultText);
    if (parsed !== null) return parsed;
  }
  return null;
}

function extractChaptersFromPanels(initialData, durationSeconds = null) {
  if (!initialData) return [];
  const chapters = [];
  const panels = initialData.engagementPanels ?? [];
  for (const p of panels) {
    const contents =
      p?.engagementPanelSectionListRenderer?.content?.macroMarkersListRenderer?.contents ?? [];
    for (const item of contents) {
      const m = item?.macroMarkersListItemRenderer;
      if (!m) continue;
      const title = textOf(m.title).trim();
      const ts = textOf(m.timeDescription).trim();
      const startSeconds =
        m.onTap?.watchEndpoint?.startTimeSeconds !== undefined
          ? Number(m.onTap.watchEndpoint.startTimeSeconds)
          : parseDurationSeconds(ts);
      if (title && startSeconds !== null && Number.isFinite(startSeconds)) {
        chapters.push({
          title,
          timestamp: ts || formatDuration(startSeconds),
          startSeconds,
          startMs: startSeconds * 1000,
        });
      }
    }
    if (chapters.length >= 2) break;
  }
  if (chapters.length < 2) return [];
  return chapters.map((ch, idx) => ({
    ...ch,
    endSeconds:
      chapters[idx + 1]?.startSeconds ??
      (durationSeconds && durationSeconds > ch.startSeconds ? durationSeconds : null),
  }));
}

function extractCaptionTracks(playerResponse) {
  return (
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
  );
}

function normalizeCaptionLanguages(captionTracks) {
  return (captionTracks ?? [])
    .filter((t) => t && t.languageCode)
    .map((t) => ({
      code: t.languageCode,
      name: textOf(t.name).trim() || t.languageCode,
      isAutoGenerated: t.kind === "asr",
    }));
}

/**
 * Normalize full single-video metadata from `playerResponse` + optional watch `initialData`.
 */
function normalizeVideoDetail(playerResponse, initialData = null, source = "innertube_player") {
  const pr = playerResponse ?? {};
  const vd = pr.videoDetails ?? {};
  const micro = pr.microformat?.playerMicroformatRenderer ?? {};

  const videoId = vd.videoId ?? null;
  const title = pick(vd.title, textOf(micro.title).trim()) ?? "";
  const description = pick(vd.shortDescription, textOf(micro.description)) ?? "";
  const durationSeconds = parseDurationSeconds(pick(vd.lengthSeconds, micro.lengthSeconds));
  const views = parseCountText(pick(vd.viewCount, micro.viewCount));
  const likes = extractLikesFromWatchData(initialData);
  const datePosted = parseDateValue(pick(micro.publishDate, micro.uploadDate));
  const isLive = Boolean(
    vd.isLive || micro.liveBroadcastDetails?.isLiveNow || (vd.isLiveContent && durationSeconds === 0)
  );

  const panelChapters = extractChaptersFromPanels(initialData, durationSeconds);
  const chapters = panelChapters.length
    ? panelChapters
    : parseChaptersFromDescription(description, durationSeconds);

  const thumbs = [
    ...extractThumbnails(vd.thumbnail),
    ...extractThumbnails(micro.thumbnail),
  ];
  const seenUrls = new Set();
  const thumbnails = thumbs.filter((t) => {
    if (seenUrls.has(t.url)) return false;
    seenUrls.add(t.url);
    return true;
  });

  const captionTracks = extractCaptionTracks(pr);
  const captionLanguages = normalizeCaptionLanguages(captionTracks);

  const combinedText = `${title}\n${description}`;
  return {
    videoId,
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
    title,
    description,
    hashtags: extractHashtags(combinedText),
    mentions: extractMentions(combinedText),
    channelId: pick(vd.channelId, micro.externalChannelId) ?? null,
    author: pick(vd.author, micro.ownerChannelName) ?? null,
    views,
    likes,
    duration: durationSeconds !== null ? formatDuration(durationSeconds) : null,
    durationSeconds,
    datePosted,
    isLive,
    keywords: Array.isArray(vd.keywords) ? vd.keywords : [],
    chapters,
    thumbnails,
    photos: thumbnails.map((t) => t.url),
    captionLanguages,
    source,
  };
}

module.exports = {
  pick,
  extractThumbnails,
  normalizeChannel,
  normalizeVideoCard,
  extractVideosAndContinuation,
  extractLikesFromWatchData,
  extractChaptersFromPanels,
  extractCaptionTracks,
  normalizeCaptionLanguages,
  normalizeVideoDetail,
};
