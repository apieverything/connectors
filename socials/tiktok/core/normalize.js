"use strict";

/** Stable output shapes, deliberately identical to the Instagram connector. */

function pick(...values) {
  return values.find((v) => v !== undefined && v !== null);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function iso(timestamp) {
  const n = Number(timestamp);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

function extractHashtags(text) {
  const found = String(text ?? "").match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(found)];
}

function extractMentions(text) {
  const found = String(text ?? "").match(/@[A-Za-z0-9._]{1,30}/g) ?? [];
  return [...new Set(found)];
}

function normalizeProfile(userInfo, username = null) {
  const info = userInfo ?? {};
  const user = info.user ?? {};
  const stats = pick(info.statsV2, info.stats) ?? {};
  return {
    username: pick(user.uniqueId, username) ?? null,
    profileId: pick(user.id, user.shortId) ?? null,
    secUid: user.secUid ?? null,
    followers: num(pick(stats.followerCount, user.followerCount)),
    following: num(pick(stats.followingCount, stats.friendCount)),
    posts: num(pick(stats.videoCount, user.videoCount)),
    likes: num(pick(stats.heartCount, stats.heart, stats.diggCount)),
    fullName: pick(user.nickname, info.shareMeta?.title) ?? null,
    biography: pick(user.signature, info.shareMeta?.desc) ?? null,
    isPrivate: Boolean(user.privateAccount ?? user.secret),
    isVerified: Boolean(user.verified),
    isOrganization: Boolean(user.isOrganization),
    profilePicUrl: pick(user.avatarLarger, user.avatarMedium, user.avatarThumb) ?? null,
    bioLink: user.bioLink?.link ?? null,
    createdAt: iso(user.createTime),
    raw: info.shareMeta?.desc ?? null,
    source: "user_detail",
  };
}

function normalizePost(node, fallbackUsername = null) {
  const n = node ?? {};
  const id = pick(n.id, n.aweme_id, n.embed_product_id, n.videoId) ?? null;
  const author = n.author ?? {};
  const username = pick(author.uniqueId, author.unique_id, n.author_unique_id, n.authorUniqueId, fallbackUsername) ?? null;
  const description = pick(n.desc, n.description, n.title) ?? "";
  const stats = n.stats ?? n.statsV2 ?? {};

  const hashtags = [
    ...extractHashtags(description),
    ...(n.challenges ?? []).map((c) => (c.title ? `#${c.title.replace(/^#/, "")}` : null)).filter(Boolean),
    ...(n.textExtra ?? []).map((t) => (t.hashtagName ? `#${t.hashtagName.replace(/^#/, "")}` : null)).filter(Boolean),
  ];

  const video = n.video ?? {};
  const cover = pick(video.cover, video.originCover, video.thumbnail, n.thumbnail_url, n.cover) ?? null;
  const playAddr = pick(video.playAddr, video.downloadAddr, video.bitrateInfo?.[0]?.PlayAddr?.Data?.Url, n.playAddr) ?? null;
  const timestamp = pick(n.createTime, n.create_time, n.createTimeUnix) ?? null;

  return {
    url: id && username ? `https://www.tiktok.com/@${username}/video/${id}` : n.url ?? null,
    shortcode: id,
    userPosted: username,
    description,
    hashtags: [...new Set(hashtags)],
    mentions: extractMentions(description),
    numComments: num(pick(stats.commentCount, n.commentCount)) ?? null,
    datePosted: iso(timestamp),
    timestamp: num(timestamp),
    likes: num(pick(stats.diggCount, n.diggCount)) ?? null,
    photos: cover ? [cover] : [],
    videos: playAddr ? [playAddr] : [],
    type: "video",
    isVideo: true,
    location: n.locationCreated ?? null,
    altText: pick(n.seoDescription, n.altText) ?? null,
    // TikTok-specific extras, additive to the shared contract.
    shares: num(pick(stats.shareCount, n.shareCount)) ?? null,
    plays: num(pick(stats.playCount, n.playCount)) ?? null,
    collects: num(pick(stats.collectCount, n.collectCount)) ?? null,
    duration: num(video.duration) ?? null,
    music: pick(n.music?.title, n.musicTitle) ?? null,
    authorName: pick(author.nickname, n.author_name) ?? null,
  };
}

module.exports = { normalizeProfile, normalizePost, extractHashtags, extractMentions, num, iso };
