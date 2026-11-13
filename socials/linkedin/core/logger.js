"use strict";

/** Dependency-free coloured logger. People lookups are never logged. */
function colorEnabled() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}
const paint = (code) => (text) => colorEnabled() ? `\x1b[${code}m${text}\x1b[0m` : String(text);
const c = {
  bold: paint(1), dim: paint(2), red: paint(31), green: paint(32),
  yellow: paint(33), cyan: paint(36), gray: paint(90), white: paint(37),
};
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const currentLevel = () => LEVELS[(process.env.LOG_LEVEL ?? "info").toLowerCase()] ?? LEVELS.info;

function emit(threshold, prefix, message) {
  const level = currentLevel();
  if (level > threshold || level === LEVELS.silent) return;
  const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
  console.log(`${c.dim(ts)} ${prefix} ${message}`);
}
const log = {
  debug: (m) => emit(LEVELS.debug, c.gray("·"), c.gray(m)),
  info: (m) => emit(LEVELS.info, c.cyan("›"), m),
  success: (m) => emit(LEVELS.info, c.green("✓"), m),
  warn: (m) => emit(LEVELS.warn, c.yellow("!"), c.yellow(m)),
  error: (m) => emit(LEVELS.error, c.red("✗"), c.red(m)),
  plain: (m) => { if (currentLevel() !== LEVELS.silent) console.log(m); },
};

/**
 * Never log query strings: they contain the profile/company/skill looked up.
 * A people lookup is reduced to its route only.
 */
function redactUrl(raw) {
  const path = String(raw).split("?")[0];
  if (/\/v1\/linkedin\/people\//.test(path)) return "/v1/linkedin/people/***";
  return String(raw).replace(
    /([?&](?:api_key|token|key|keywords|location|skill|q)=)[^&]*/gi,
    "$1***"
  );
}

const BOX_WIDTH = 64;
const visibleLength = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
function boxLine(inner) {
  const content = `  ${inner}`;
  const padding = Math.max(0, BOX_WIDTH - visibleLength(content));
  return `${c.cyan("│")}${content}${" ".repeat(padding)}${c.cyan("│")}`;
}
function row(label, value) {
  log.plain(`  ${c.gray(label.padEnd(9))}   ${value}`);
}

function banner({ port, host, version, proxy, people }) {
  const title = `${c.bold(c.white("API Everything"))} ${c.gray("·")} ${c.bold(c.cyan("LinkedIn connector"))}`;
  log.plain("");
  log.plain(c.cyan(`┌${"─".repeat(BOX_WIDTH)}┐`));
  log.plain(boxLine(`${title}  ${c.gray(`v${version}`)}`));
  log.plain(boxLine(c.dim("Self-hostable · free · no personal data by default")));
  log.plain(c.cyan(`└${"─".repeat(BOX_WIDTH)}┘`));
  row("Listening", c.green(`http://${host}:${port}`));
  row("Docs", c.cyan("GET /openapi.yaml"));
  row("Sources", c.dim("jobs_guest → jobs_search → company_seo → signals"));
  row("Proxies", proxy.enabled
    ? `${c.green(`${proxy.count} configured`)} ${c.gray(`· ${proxy.rotation}`)}`
    : c.dim("disabled (direct connection)"));
  row("People", people
    ? `${c.yellow("!")} ${c.yellow("ENABLED — self-host only, personal data")}`
    : `${c.green("✓")} ${c.green("disabled (data-policy default)")}`);
}

function statusColor(status) {
  if (status >= 500) return c.red(String(status));
  if (status >= 400) return c.yellow(String(status));
  return c.green(String(status));
}
function request({ method, url, status, durationMs, note }) {
  const printed = redactUrl(url);
  const duration = c.dim(`${String(durationMs).padStart(5)}ms`);
  const extra = note ? `  ${c.gray(note)}` : "";
  emit(LEVELS.info, statusColor(status), `${c.gray(method.padEnd(4))} ${printed.padEnd(46)} ${duration}${extra}`);
}
function sessionResult(result) {
  row("Session", result?.verified
    ? `${c.green("✓")} ${c.bold(c.green(`@${result.username}`))} ${c.dim("· verified")}`
    : `${c.yellow("!")} ${c.yellow("anonymous — public sources only")}`);
  row("", c.dim("→ LI_SESSIONID is not required for jobs, companies or signals"));
}
function proxyCheck(summary) {
  if (!summary || !summary.total) return;
  const head = summary.alive ? c.green("✓") : c.red("✗");
  const latency = summary.avgMs !== null ? `avg ${summary.avgMs}ms` : "no latency data";
  row("Check", `${head} ${summary.alive}/${summary.total} alive · ${latency}`);
}
function ready() {
  row("Hotkeys", `${c.cyan("Ctrl+R")} ${c.dim("reload · ")}${c.cyan("Ctrl+C")} ${c.dim("stop")}`);
  log.plain("");
}

module.exports = { log, c, banner, request, sessionResult, proxyCheck, ready, redactUrl, colorEnabled };
