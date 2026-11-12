"use strict";

const { fetchCurrentUser } = require("./fetch");

/**
 * Resolve the account behind a session without ever failing startup.
 * Returns a plain status object that the banner and /health can display.
 */
async function verifySession(session) {
  if (!session) {
    return {
      status: "anonymous",
      verified: false,
      username: null,
      fullName: null,
      pk: null,
      error: null,
    };
  }

  try {
    const account = await fetchCurrentUser(session);
    return { status: "verified", verified: true, ...account, error: null };
  } catch (err) {
    return {
      status: "unverified",
      verified: false,
      username: null,
      fullName: null,
      pk: null,
      error: { code: err.code ?? "UNKNOWN", message: err.message },
    };
  }
}

module.exports = { verifySession };
