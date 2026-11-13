"use strict";

const HINTS = {
  LI_PEOPLE_DISABLED:
    "People profiles contain third-party personal data. Set LI_ALLOW_PEOPLE=1 only on a self-hosted instance; the hosted API Everything service does not expose them.",
  LI_USER_NOT_FOUND: "Check the slug (the part after /in/ or /company/).",
  LI_JOB_NOT_FOUND: "Check the job id.",
  LI_RATE_LIMITED:
    "LinkedIn is throttling this IP. Raise LI_MIN_INTERVAL_MS or let the fallback source answer.",
  LI_ALL_STRATEGIES_FAILED:
    "Every source failed. Run /v1/diagnostics to see which one answers.",
  LI_PROXY_CONFIG_ERROR: "Fix the LI_PROXY_* values in .env (user:pass@host:port).",
  LI_UNEXPECTED_RESPONSE:
    "LinkedIn changed its markup. Check /v1/diagnostics and update the selector.",
  LI_BAD_REQUEST: "Check the query parameters.",
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
