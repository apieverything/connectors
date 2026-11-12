"use strict";

const { get } = require("./http");
const { extractVideoDetail } = require("./rehydration");
const { ConnectorError } = require("./errors");

/** Official, unsigned oEmbed endpoint. Works anonymously for a known video URL. */
async function fetchOembed(videoUrl, options = {}) {
  const url = `https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`;
  const { data } = await get(url, {
    headers: { Accept: "application/json" },
    ...(options.fixedProxy !== undefined ? { fixedProxy: options.fixedProxy } : {}),
  });
  if (!data?.embed_product_id) {
    throw new ConnectorError("TT_UNEXPECTED_RESPONSE", "oEmbed returned no video.", 502);
  }
  return data;
}

/** A video page server-renders the full item (stats, date, media URLs). */
async function fetchVideoDetail(videoId, username, options = {}) {
  const url = `https://www.tiktok.com/@${encodeURIComponent(username)}/video/${encodeURIComponent(videoId)}`;
  const { body } = await get(url, {
    ...(options.fixedProxy !== undefined ? { fixedProxy: options.fixedProxy } : {}),
    session: options.session ?? null,
  });
  const detail = extractVideoDetail(body);
  const item = detail?.itemInfo?.itemStruct ?? detail?.itemInfo ?? null;
  if (!item || detail?.statusCode !== 0) {
    throw new ConnectorError(
      "TT_UNEXPECTED_RESPONSE",
      `Video ${videoId} returned no item (${detail?.statusMsg ?? "missing"}).`,
      502,
      { statusCode: detail?.statusCode ?? null }
    );
  }
  return item;
}

module.exports = { fetchOembed, fetchVideoDetail };
