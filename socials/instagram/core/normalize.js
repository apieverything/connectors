"use strict";

const { extractHashtags, extractMentions, parseDateFromAltText } = require("./parsing");

/** First non-null value among several aliases (Instagram renames fields often). */
function pick(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function imageUrl(node) {
  return (
    pick(
      node?.display_uri, // logged-out grid
      node?.display_url,
      node?.thumbnail_url,
      node?.image_versions2?.candidates?.[0]?.url
    ) ?? null
  );
}

function videoUrls(node) {
  const urls = (node?.video_versions ?? []).map((version) => version.url).filter(Boolean);
  if (!urls.length && node?.video_url) urls.push(node.video_url);
  return urls;
}

function captionOf(node) {
  return (
    pick(
      node?.caption?.text,
      node?.edge_media_to_caption?.edges?.[0]?.node?.text,
      node?.accessibility_caption
    ) ?? ""
  );
}

function mediaType(node, children) {
  if (node?.product_type === "clips" || node?.is_reel) return "reel";
  // media_type 8 / carousel_container is CAROUSEL in the v1 API and in the
  // XIGPolaris* grid nodes (not a reel).
  if (
    node?.media_type === 8 ||
    node?.product_type === "carousel_container" ||
    node?.carousel_media_count > 1 ||
    children.length
  ) {
    return "carousel";
  }
  if (node?.media_type === 2 || node?.is_video || node?.video_versions?.length || node?.video_url) {
    return "video";
  }
  return "image";
}

/**
 * Turn an Instagram API "node" into the stable shape exposed by the public
 * connector API.
 */
function normalizePost(node, fallbackUsername = null) {
  const n = node ?? {};
  const code = pick(n.code, n.shortcode) ?? null;
  const caption = captionOf(n);
  const children = (
    n.edge_sidecar_to_children?.edges?.map((edge) => edge.node ?? edge) ??
    n.carousel_media ??
    []
  ).filter(Boolean);

  const photos = children.length
    ? children.map(imageUrl).filter(Boolean)
    : [imageUrl(n)].filter(Boolean);
  const videos = children.length ? children.flatMap(videoUrls) : videoUrls(n);

  const timestamp = pick(n.taken_at, n.taken_at_timestamp, n.device_timestamp) ?? null;
  const type = mediaType(n, children);

  return {
    url: code ? `https://www.instagram.com/p/${code}/` : null,
    shortcode: code,
    userPosted: pick(n.owner?.username, n.user?.username, fallbackUsername) ?? null,
    description: caption,
    hashtags: extractHashtags(caption),
    mentions: extractMentions(caption),
    numComments:
      pick(n.comment_count, n.comments_count, n.edge_media_to_comment?.count) ?? null,
    datePosted: timestamp
      ? new Date(timestamp * 1000).toISOString()
      : parseDateFromAltText(n.accessibility_caption),
    timestamp,
    likes: pick(n.like_count, n.edge_liked_by?.count, n.likes) ?? null,
    photos,
    videos,
    type,
    isVideo: type === "video" || type === "reel",
    location: n.location?.name ?? null,
    altText: n.accessibility_caption ?? null,
  };
}

/** Profile metadata from either the legacy API or the logged-out GraphQL query. */
function normalizeProfile(user, username = null) {
  const n = user ?? {};
  const bioLinks = (n.bio_links ?? [])
    .filter((link) => link && link.url)
    .map((link) => ({ title: link.title ?? null, url: link.url }));
  return {
    username: pick(n.username, username) ?? null,
    profileId: pick(n.pk, n.id) ?? null,
    followers: pick(n.edge_followed_by?.count, n.follower_count) ?? null,
    following: pick(n.edge_follow?.count, n.following_count) ?? null,
    posts:
      pick(
        n.edge_owner_to_timeline_media?.count,
        n.media_count,
        n.all_media_count,
        n.post_count
      ) ?? null,
    fullName: pick(n.full_name, n.fullName) ?? null,
    biography: pick(n.biography, n.bio) ?? null,
    isPrivate: Boolean(n.is_private),
    isVerified: Boolean(n.is_verified),
    profilePicUrl: pick(n.profile_pic_url, n.hd_profile_pic_url_info?.url) ?? null,
    externalUrl: n.external_url ?? null,
    category: n.category ?? null,
    isBusiness: Boolean(n.is_business),
    bioLinks,
    source: "web_profile_info",
  };
}

module.exports = { normalizePost, normalizeProfile, pick };
