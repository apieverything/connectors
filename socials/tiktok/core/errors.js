"use strict";

const HINTS = {
  TT_SESSION_MISSING: "Set TT_SESSIONID in .env if you need private profiles.",
  TT_USER_NOT_FOUND: "Check the username (without the leading @).",
  TT_PRIVATE_PROFILE: "This account is private; a session cookie is required.",
  TT_RATE_LIMITED: "TikTok is throttling this IP. Raise TT_MIN_INTERVAL_MS or enable proxies.",
  TT_ENDPOINT_BLOCKED:
    "TikTok's item_list API requires request signatures. Enable TT_BROWSER=1 (Playwright) or provide video URLs via /v1/tiktok/:username/posts?ids=...",
  TT_ALL_STRATEGIES_FAILED:
    "Every post source failed. Run /v1/diagnostics to see which one answers.",
  TT_BROWSER_UNAVAILABLE:
    "Install Playwright: npm i playwright && npx playwright install chromium",
  TT_PROXY_CONFIG_ERROR: "Fix the TT_PROXY_* values in .env (user:pass@host:port).",
  TT_UNEXPECTED_RESPONSE:
    "TikTok changed its response format. Check /v1/diagnostics and update the doc_id or selector.",
};

class ConnectorError extends Error {
  constructor(code, message, status = 502, details = null) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.hint = HINTS[code] ?? null;
  }
}

module.exports = { ConnectorError, HINTS };
