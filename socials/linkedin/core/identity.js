"use strict";

const { get } = require("./http");

/** Best-effort session resolution for /v1/session (parity with other connectors). */
async function verifySession(session) {
  if (!session) return { status: "anonymous", verified: false, username: null, error: null };
  try {
    const { body, finalUrl } = await get("https://www.linkedin.com/in/me/", {
      session,
      headers: { Accept: "text/html" },
    });
    const challenged = /authwall|\/checkpoint|\/login/i.test(finalUrl) || /authwall/i.test(body);
    if (challenged) {
      return {
        status: "unverified", verified: false, username: null,
        error: { code: "LI_SESSION_INVALID", message: "LinkedIn challenged this session." },
      };
    }
    const name = /<meta[^>]+property="og:title"[^>]+content="([^"|]+)/i.exec(body);
    return {
      status: "verified", verified: true,
      username: name ? name[1].trim() : null,
      error: null,
    };
  } catch (err) {
    return {
      status: "unverified", verified: false, username: null,
      error: { code: err.code ?? "UNKNOWN", message: err.message },
    };
  }
}

module.exports = { verifySession };
