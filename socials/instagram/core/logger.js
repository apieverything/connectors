"use strict";

/**
 * Small dependency-free coloured logger.
 *
 * Colours auto-disable when stdout is not a TTY, NO_COLOR is set, or
 * LOG_LEVEL=silent. FORCE_COLOR=1 overrides TTY detection.
 * Never logs cookies, API keys or proxy credentials.
 */

/** Evaluated on every call so LOG_LEVEL / NO_COLOR changes apply on reload. */
function colorEnabled() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

const paint = (code) => (text) =>
  colorEnabled() ? `\x1b[${code}m${text}\x1b[0m` : String(text);

const c = {
  bold: paint(1),
  dim: paint(2),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  blue: paint(34),
  magenta: paint(35),
  cyan: paint(36),
  gray: paint(90),
  white: paint(37),
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function currentLevel() {
  return LEVELS[(process.env.LOG_LEVEL ?? "info").toLowerCase()] ?? LEVELS.info;
}

function timestamp() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function emit(threshold, prefix, message) {
  const level = currentLevel();
  if (level > threshold || level === LEVELS.silent) return;
  console.log(`${c.dim(timestamp())} ${prefix} ${message}`);
}

const log = {
  debug: (msg) => emit(LEVELS.debug, c.gray("·"), c.gray(msg)),
  info: (msg) => emit(LEVELS.info, c.cyan("›"), msg),
  success: (msg) => emit(LEVELS.info, c.green("✓"), msg),
  warn: (msg) => emit(LEVELS.warn, c.yellow("!"), c.yellow(msg)),
  error: (msg) => emit(LEVELS.error, c.red("✗"), c.red(msg)),
  plain: (msg) => {
    if (currentLevel() !== LEVELS.silent) console.log(msg);
  },
};

/** Strip secrets that could arrive as query parameters before logging a URL. */
function redactUrl(raw) {
  return String(raw).replace(
    /([?&](?:api_key|token|key|sessionid|password|pass|secret)=)[^&]*/gi,
    "$1***"
  );
}

const BOX_WIDTH = 64;
const visibleLength = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, "").length;

function boxLine(inner) {
  const content = `  ${inner}`;
  const padding = Math.max(0, BOX_WIDTH - visibleLength(content));
  return `${c.cyan("│")}${content}${" ".repeat(padding)}${c.cyan("│")}`;
}

function row(label, value) {
  log.plain(`  ${c.gray(label.padEnd(9))}   ${value}`);
}

function banner({ port, host, version, proxy }) {
  const title = `${c.bold(c.white("API Everything"))} ${c.gray("·")} ${c.bold(
    c.cyan("Instagram connector")
  )}`;

  log.plain("");
  log.plain(c.cyan(`┌${"─".repeat(BOX_WIDTH)}┐`));
  log.plain(boxLine(`${title}  ${c.gray(`v${version}`)}`));
  log.plain(boxLine(c.dim("Self-hostable · free · no central service")));
  log.plain(c.cyan(`└${"─".repeat(BOX_WIDTH)}┘`));
  row("Listening", c.green(`http://${host}:${port}`));
  row("Docs", c.cyan("GET /openapi.yaml"));
  row("Proxies", proxyLabel(proxy));
  row("Stats", c.dim("web_profile_info → og:description fallback"));
}

function proxyLabel(proxy) {
  if (!proxy.enabled) return c.dim("disabled (direct connection)");
  const duplicates = proxy.duplicatesCollapsed
    ? ` ${c.yellow(`· ${proxy.duplicatesCollapsed} identical lines collapsed (rotating generator)`)}`
    : "";
  return `${c.green(`${proxy.count} configured`)} ${c.gray(
    `· ${proxy.rotation} · retries ${proxy.maxRetries}${proxy.stickySession ? " · sticky" : ""}`
  )}${duplicates}`;
}

function statusColor(status) {
  if (status >= 500) return c.red(String(status));
  if (status >= 400) return c.yellow(String(status));
  if (status >= 300) return c.cyan(String(status));
  return c.green(String(status));
}

function request({ method, url, status, durationMs, note }) {
  const printedPath = redactUrl(url);
  const duration = c.dim(`${String(durationMs).padStart(5)}ms`);
  const extra = note ? `  ${c.gray(note)}` : "";
  emit(
    LEVELS.info,
    statusColor(status),
    `${c.gray(method.padEnd(4))} ${printedPath.padEnd(46)} ${duration}${extra}`
  );
}

function sessionResult(result) {
  if (!result || result.status === "anonymous") {
    row("Session", `${c.yellow("!")} ${c.yellow("anonymous — public posts only")}`);
    row("", c.dim("→ set IG_SESSIONID for private profiles (see README > Getting the session cookie)"));
  } else if (result.verified) {
    const name = result.fullName ? ` ${c.dim(`(${result.fullName})`)}` : "";
    row(
      "Session",
      `${c.green("✓")} ${c.bold(c.green(`@${result.username}`))}${name} ${c.dim("· verified")}`
    );
  } else {
    row(
      "Session",
      `${c.yellow("!")} ${c.yellow("configured but not verified")} ${c.dim(
        `· ${result.error?.code ?? "unknown"}`
      )}`
    );
    row("", c.dim("→ /posts may fail with IG_SESSION_EXPIRED; refresh your cookie"));
  }
}

function proxyCheck(summary) {
  if (!summary || !summary.total) return;

  const head = summary.alive ? c.green("✓") : c.red("✗");
  const range = summary.minMs !== null ? ` · ${summary.minMs}–${summary.maxMs}ms` : "";
  const latency = summary.avgMs !== null ? `avg ${summary.avgMs}ms${range}` : "no latency data";
  const countries = Object.entries(summary.countries)
    .map(([code, count]) => `${code}:${count}`)
    .join(" ");
  const igProbed = Object.keys(summary.igStatuses ?? {}).length > 0;
  const direct = summary.direct?.igStatus;
  const directText =
    direct !== null && direct !== undefined
      ? ` · ${c.dim("direct")} ${direct >= 200 && direct < 300 ? c.green(String(direct)) : c.red(String(direct))}`
      : "";
  const igText = igProbed
    ? ` · ${c.dim("IG")} ${
        summary.igAlive > 0 ? c.green(`${summary.igAlive}/${summary.total} ok`)
          : c.red(`${summary.igAlive}/${summary.total} ok`)
      }${summary.igBlocked ? c.dim(` (${Object.entries(summary.igStatuses).filter(([s]) => Number(s) >= 300).map(([s, n]) => `${s}×${n}`).join(" ")})`) : ""}${directText}`
    : "";
  row(
    "Check",
    `${head} ${summary.alive}/${summary.total} alive · ${latency}${
      countries ? ` · ${c.cyan(countries)}` : ""
    }${igText}`
  );

  const verbose = currentLevel() <= LEVELS.debug;
  const visible =
    verbose || summary.results.length <= 8
      ? summary.results
      : summary.results.filter((entry) => !entry.alive).slice(0, 5);

  for (const entry of visible) {
    const flag = entry.alive ? c.green("✓") : c.red("✗");
    const country = entry.country ? c.cyan(entry.country.padEnd(2)) : c.gray("??");
    const ms = entry.alive
      ? c.dim(`${String(entry.ms).padStart(5)}ms`)
      : c.gray("     —");
    const igTag =
      entry.igStatus !== null && entry.igStatus !== undefined
        ? entry.igStatus >= 200 && entry.igStatus < 300
          ? c.green(`IG:${entry.igStatus}`)
          : c.red(`IG:${entry.igStatus}`)
        : c.gray("IG:—");
    const note = entry.alive
      ? ""
      : `  ${c.gray(String(entry.error ?? entry.igError ?? "").slice(0, 40))}`;
    log.plain(
      `              ${c.gray(`#${entry.index + 1}`.padEnd(4))} ${country} ${ms}  ${flag}  ${igTag}  ${c.gray(
        entry.label
      )}${note}`
    );
  }
  if (summary.results.length > visible.length) {
    log.plain(
      `              ${c.gray(
        `… ${summary.results.length - visible.length} more (GET /v1/proxies for the full list)`
      )}`
    );
  }
}

function ready() {
  row("Hotkeys", `${c.cyan("Ctrl+R")} ${c.dim("reload · ")}${c.cyan("Ctrl+C")} ${c.dim("stop")}`);
  log.plain("");
}

module.exports = {
  log,
  banner,
  request,
  sessionResult,
  proxyCheck,
  ready,
  redactUrl,
  colors: c,
  colorEnabled,
};
