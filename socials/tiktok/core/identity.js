"use strict";

const { get } = require("./http");
const { extractScope } = require("./rehydration");

/** Best-effort session resolution for /v1/session (parity with Instagram). */
async function verifySession(session) {
  if (!session) {
    return { status: "anonymous", verified: false, username: null, error: null };
  }
  try {
    const { body } = await get("https://www.tiktok.com/@tiktok", { session });
    const context = extractScope(body)?.["webapp.app-context"] ?? {};
    const username = context.userUniqueId ?? context.uniqueId ?? null;
    const verified = Boolean(context.isLogin) || Boolean(username);
    return {
      status: verified ? "verified" : "unverified",
      verified,
      username,
      error: verified ? null : { code: "TT_SESSION_UNVERIFIED", message: "Could not resolve the account." },
    };
  } catch (err) {
    return {
      status: "unverified",
      verified: false,
      username: null,
      error: { code: err.code ?? "UNKNOWN", message: err.message },
    };
  }
}

module.exports = { verifySession };
