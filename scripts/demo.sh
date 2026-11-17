#!/usr/bin/env bash
# API Everything - connector smoke test, .env audit and demonstration.
#
#   ./demo.sh                    audit + start all connectors + test every route
#   ./demo.sh --direct           same, but ignore proxies for the runtime
#   ./demo.sh --audit-only       only audit the .env files
#   ./demo.sh --ig-only / --tt-only / --li-only
#   ./demo.sh --fast             lower the per-request delay for a quicker run
#
# Secrets are never printed. Proxy credentials are shown as ***:***@host.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IG_DIR="$ROOT/socials/instagram"
TT_DIR="$ROOT/socials/tiktok"
LI_DIR="$ROOT/socials/linkedin"
IG_PORT="${IG_PORT:-}"
TT_PORT="${TT_PORT:-}"
LI_PORT="${LI_PORT:-}"
EXPLICIT_IG_PORT=0
EXPLICIT_TT_PORT=0
EXPLICIT_LI_PORT=0
IG_USER="${IG_USER:-kametolol}"
TT_USER="${TT_USER:-khaby.lame}"
LI_COMPANY="${LI_COMPANY:-linkedin}"

DIRECT=0
AUDIT_ONLY=0
FAST=0
RUN_IG=1
RUN_TT=1
RUN_LI=1

# Ask the OS for a free port so consecutive runs never collide, even if a
# previous server is still shutting down.
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'
}

[[ $EXPLICIT_IG_PORT -eq 0 ]] && IG_PORT="$(free_port)"
[[ $EXPLICIT_TT_PORT -eq 0 ]] && TT_PORT="$(free_port)"
[[ $EXPLICIT_LI_PORT -eq 0 ]] && LI_PORT="$(free_port)"
while [[ "$TT_PORT" == "$IG_PORT" ]]; do TT_PORT="$(free_port)"; done
while [[ "$LI_PORT" == "$IG_PORT" || "$LI_PORT" == "$TT_PORT" ]]; do LI_PORT="$(free_port)"; done

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --direct) DIRECT=1 ;;
    --audit-only) AUDIT_ONLY=1 ;;
    --fast) FAST=1 ;;
    --ig-only) RUN_TT=0; RUN_LI=0 ;;
    --tt-only) RUN_IG=0; RUN_LI=0 ;;
    --li-only) RUN_IG=0; RUN_TT=0 ;;
    --ig-port) IG_PORT="$2"; EXPLICIT_IG_PORT=1; shift ;;
    --tt-port) TT_PORT="$2"; EXPLICIT_TT_PORT=1; shift ;;
    --li-port) LI_PORT="$2"; EXPLICIT_LI_PORT=1; shift ;;
    -h|--help) usage ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

# ---- output helpers -----------------------------------------------------
if [[ -n "${NO_COLOR:-}" ]] || [[ ! -t 1 ]]; then
  C_OK='' C_WARN='' C_ERR='' C_DIM='' C_BOLD='' C_RST=''
else
  C_OK=$'\033[32m' C_WARN=$'\033[33m' C_ERR=$'\033[31m'
  C_DIM=$'\033[2m' C_BOLD=$'\033[1m' C_RST=$'\033[0m'
fi

PASS=0; WARNS=0; FAILS=0; NOTES=0
TOTAL=$(( (RUN_IG + RUN_TT + RUN_LI) ))
PIDS_FILE="$(mktemp)"
LOGDIR="$(mktemp -d)"
JS="$(mktemp)"
trap cleanup EXIT

cleanup() {
  while read -r pid; do
    [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true
  done < "$PIDS_FILE"
  sleep 0.3
  while read -r pid; do
    [[ -n "$pid" ]] && kill -KILL "$pid" 2>/dev/null || true
  done < "$PIDS_FILE"
  rm -rf "$LOGDIR" "$JS" "$PIDS_FILE"
}

section() { printf '\n%s%s%s\n' "$C_BOLD" "$1" "$C_RST"; }
ok()   { PASS=$((PASS+1)); printf '  %s✓%s %s\n' "$C_OK" "$C_RST" "$1"; }
warn() { WARNS=$((WARNS+1)); printf '  %s!%s %s\n' "$C_WARN" "$C_RST" "$1"; }
err()  { FAILS=$((FAILS+1)); printf '  %s✗%s %s\n' "$C_ERR" "$C_RST" "$1"; }
note() { NOTES=$((NOTES+1)); printf '  %s·%s %s\n' "$C_DIM" "$C_RST" "$1"; }

jget() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let j=JSON.parse(s);for(const k of process.argv[1].split("."))j=j?.[k];process.stdout.write(j==null?"":String(j))}catch{}})' "$1"
}

# ---- embedded Node helper: .env audit and safe value lookup -------------
cat > "$JS" <<'NODE'
const fs = require("fs");
const mode = process.argv[2];

function parse(file) {
  const m = new Map();
  if (!fs.existsSync(file)) return { exists: false, m };
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const b = t.replace(/^export\s+/, "");
    const i = b.indexOf("=");
    if (i < 1) continue;
    let v = b.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "").trim();
    m.set(b.slice(0, i).trim(), v);
  }
  return { exists: true, m };
}

// A commented "# KEY=value" line in .env.example still documents that key.
function knownKeys(file) {
  const keys = new Set();
  if (!fs.existsSync(file)) return keys;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^#?\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line.trim());
    if (m) keys.add(m[1]);
  }
  return keys;
}

function shape(v) {
  if (v === "") return "empty";
  if (/@/.test(v) && !/^https?:\/\//.test(v.split("@")[0])) {
    return `***:***@${v.split("@").pop().split(":")[0]} (${v.length} chars)`;
  }
  if (/^https?:\/\/.*@/.test(v)) return `http://***:***@${v.split("@").pop()} (${v.length} chars)`;
  return `set (${v.length} chars)`;
}

function audit(envPath, examplePath, label, prefix, gitignorePath) {
  const out = [];
  const push = (lvl, msg) => out.push(`${lvl}\t${msg}`);
  const env = parse(envPath);
  const ex = parse(examplePath);

  if (!env.exists) {
    push("FAIL", `${label}: .env is missing - copy .env.example`);
    return out;
  }
  push("OK", `${label}: .env present, ${env.m.size} keys, .env.example ${ex.exists ? "found" : "MISSING"}`);

  const documented = knownKeys(examplePath);
  const missing = [...documented].filter((k) => !env.m.has(k));
  if (missing.length) push("INFO", `${label}: ${missing.length} documented keys left at default (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""})`);
  const unknown = [...env.m.keys()].filter((k) => ex.exists && !documented.has(k));
  if (unknown.length) push("WARN", `${label}: keys not documented in .env.example: ${unknown.join(", ")}`);

  for (const [k, v] of env.m) {
    if (/(^PORT$|_TIMEOUT_MS$|_MIN_INTERVAL_MS$|_MAX_PAGES$|_CONCURRENCY$|_MAX$|_WAIT_MS$|TTL_MS$|_COOLDOWN_MS$)/.test(k) && !/^\d+$/.test(v)) {
      push("WARN", `${label}: ${k} should be a positive integer (${shape(v)})`);
    }
  }
  const level = env.m.get("LOG_LEVEL");
  if (level && !/^(debug|info|warn|error|silent)$/.test(level)) push("WARN", `${label}: LOG_LEVEL="${level}" is not a valid level`);
  for (const flag of ["IG_BROWSER", "TT_BROWSER", "IG_PROXY_CHECK", "TT_PROXY_CHECK", "LI_PROXY_CHECK", "IG_PROXY_STICKY", "TT_PROXY_STICKY", "LI_PROXY_STICKY", "IG_ENRICH_POSTS", "LI_ALLOW_PEOPLE"]) {
    if (env.m.has(flag) && !/^[01]$/.test(env.m.get(flag))) push("WARN", `${label}: ${flag} should be 0 or 1`);
  }

  for (const [k, v] of env.m) {
    if (!/PROXY_URL$|^.{0,4}PROXIES$/.test(k) || !v) continue;
    const lines = v.split(/[\s,]+/).filter(Boolean);
    const unique = [...new Set(lines)];
    if (unique.length < lines.length) push("WARN", `${label}: ${k} has ${lines.length - unique.length} identical lines (rotating generator collapses to ${unique.length} endpoint)`);
    for (const line of unique) {
      const looks = /^([a-z]+:\/\/)?([^@\s]+@)?([\w.-]+):(\d{1,5})$/i.test(line);
      if (!looks) push("WARN", `${label}: ${k} entry does not look like user:pass@host:port (${shape(line)})`);
      else push("OK", `${label}: ${k} -> ${shape(line)}`);
    }
  }
  const fileKey = `${prefix}_PROXIES_FILE`;
  const fileVal = env.m.get(fileKey);
  if (fileVal && !fs.existsSync(fileVal)) push("WARN", `${label}: ${fileKey} points to a missing file`);

  const session = env.m.get(`${prefix}_SESSIONID`);
  if (session) push("OK", `${label}: session cookie configured (${shape(session)})`);
  else push("INFO", `${label}: no session cookie - public endpoints only`);

  const port = env.m.get("PORT");
  if (port && (Number(port) < 1 || Number(port) > 65535)) push("WARN", `${label}: PORT=${port} is out of range`);

  let gi = "";
  try { gi = fs.readFileSync(gitignorePath, "utf8"); } catch {}
  if (!/\.env/.test(gi)) push("FAIL", `${label}: .env is NOT listed in .gitignore`);
  else push("OK", `${label}: .env is gitignored`);
  try {
    const mode = fs.statSync(envPath).mode & 0o077;
    if (mode) push("WARN", `${label}: .env is group/world readable (chmod 600 recommended)`);
  } catch {}
  return out;
}

const result = mode === "audit"
  ? audit(process.argv[3], process.argv[4], process.argv[5], process.argv[6], process.argv[7])
  : (() => { const p = parse(process.argv[3]); return [p.m.get(process.argv[4]) ?? ""]; })();
process.stdout.write(result.join("\n"));
NODE

env_value() { node "$JS" value "$1" "$2" 2>/dev/null || true; }

# ---- phase 1: .env audit ------------------------------------------------
section "1/4  .env audit"
audit_one() {
  local dir="$1" label="$2" prefix="$3"
  while IFS=$'\t' read -r lvl msg; do
    [[ -z "$lvl" ]] && continue
    case "$lvl" in
      OK) ok "$msg" ;;
      WARN) warn "$msg" ;;
      FAIL) err "$msg" ;;
      *) note "$msg" ;;
    esac
  done < <(node "$JS" audit "$dir/.env" "$dir/.env.example" "$label" "$prefix" "$dir/.gitignore" 2>/dev/null)
}

[[ $RUN_IG -eq 1 ]] && audit_one "$IG_DIR" "Instagram" "IG"
[[ $RUN_TT -eq 1 ]] && audit_one "$TT_DIR" "TikTok" "TT"
[[ $RUN_LI -eq 1 ]] && audit_one "$LI_DIR" "LinkedIn" "LI"

IG_API_KEY="$(env_value "$IG_DIR/.env" API_KEY)"
TT_API_KEY="$(env_value "$TT_DIR/.env" API_KEY)"
LI_API_KEY="$(env_value "$LI_DIR/.env" API_KEY)"
IG_PORT_FILE="$(env_value "$IG_DIR/.env" PORT)"
TT_PORT_FILE="$(env_value "$TT_DIR/.env" PORT)"
LI_PORT_FILE="$(env_value "$LI_DIR/.env" PORT)"
if [[ $RUN_IG -eq 1 && $RUN_TT -eq 1 && -n "$IG_PORT_FILE" && "$IG_PORT_FILE" == "$TT_PORT_FILE" ]]; then
  warn "Instagram and TikTok .env both declare PORT=$IG_PORT_FILE - the demo uses $IG_PORT / $TT_PORT instead"
fi
if [[ $RUN_LI -eq 1 && -n "$LI_PORT_FILE" ]]; then
  note "LinkedIn .env declares PORT=$LI_PORT_FILE - the demo uses $LI_PORT instead"
fi
if [[ $RUN_LI -eq 1 && "$(env_value "$LI_DIR/.env" LI_ALLOW_PEOPLE)" == "1" ]]; then
  warn "LinkedIn LI_ALLOW_PEOPLE=1 in .env - people profiles are enabled (personal data)"
fi
[[ $DIRECT -eq 1 ]] && note "--direct: proxies disabled for the runtime (audit still checks them)"

if [[ $AUDIT_ONLY -eq 1 ]]; then
  section "Audit only - skipping runtime"
  printf '\n  %s%d ok · %d warnings · %d failures%s\n' "$C_BOLD" "$PASS" "$WARNS" "$FAILS" "$C_RST"
  [[ $FAILS -eq 0 ]] && exit 0 || exit 1
fi

# ---- phase 2: start all services ---------------------------------------
section "2/4  Starting connectors"
start_one() {
  local dir="$1" port="$2" name="$3" prefix="$4"
  local log="$LOGDIR/$name.log"
  local -a overrides=( "PORT=$port" "LOG_LEVEL=info" "NO_COLOR=1" )
  [[ $FAST -eq 1 ]] && overrides+=( "${prefix}_MIN_INTERVAL_MS=300" )
  if [[ $DIRECT -eq 1 ]]; then
    overrides+=( "${prefix}_PROXY_URL=" "${prefix}_PROXIES=" "${prefix}_PROXIES_FILE="
                 "${prefix}_PROXY_CHECK=0" "${prefix}_PROXY_CHECK_IG_COMPARE=0"
                 "${prefix}_PROXY_CHECK_COMPARE=0" )
  fi
  (
    cd "$dir" || exit 1
    exec env "${overrides[@]}" node server.js
  ) > "$log" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >> "$PIDS_FILE"
  local ready=0
  for _ in $(seq 1 40); do
    if curl -sS --max-time 2 -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null; then ready=1; break; fi
    if grep -qE 'Could not start|EADDRINUSE' "$log" 2>/dev/null; then break; fi
    sleep 0.4
  done
  # Make sure we are talking to the process we just started, not a stale one.
  local ident
  ident="$(curl -sS --max-time 3 "http://127.0.0.1:$port/" 2>/dev/null | jget name)"
  if [[ $ready -eq 1 && "${ident,,}" == *"$name"* ]]; then
    ok "$name up on :$port (pid $pid)"
  else
    err "$name did not start cleanly (ready=$ready, identity='$ident') - see $log"
  fi
}
[[ $RUN_IG -eq 1 ]] && start_one "$IG_DIR" "$IG_PORT" "instagram" "IG"
[[ $RUN_TT -eq 1 ]] && start_one "$TT_DIR" "$TT_PORT" "tiktok" "TT"
[[ $RUN_LI -eq 1 ]] && start_one "$LI_DIR" "$LI_PORT" "linkedin" "LI"

# ---- phase 3: route tests ----------------------------------------------
section "3/4  Route tests"

LAST_BODY=""

http_req() {
  local label="$1" method="$2" url="$3" expected="$4" auth="$5" field="$6"
  local tmp code body val
  tmp="$(mktemp)"
  local -a args=(-sS --max-time 120 -o "$tmp" -w '%{http_code}')
  [[ "$method" != "GET" ]] && args+=(-X "$method")
  [[ -n "$auth" ]] && args+=(-H "X-API-Key: $auth")
  code="$(curl "${args[@]}" "$url" 2>/dev/null)" || code="000"
  body="$(head -c 12000 "$tmp")"
  LAST_BODY="$body"
  rm -f "$tmp"
  local extra=""
  if [[ -n "$field" ]]; then
    val="$(printf '%s' "$body" | jget "$field")"
    [[ -n "$val" ]] && extra=" ${C_DIM}[$field=$val]${C_RST}"
  fi
  if [[ ",$expected," == *",$code,"* ]]; then
    ok "$label ${C_DIM}HTTP $code${C_RST}$extra"
  elif [[ "$code" == "502" && "$body" == *"TT_ALL_STRATEGIES_FAILED"* ]]; then
    note "$label ${C_DIM}HTTP 502 - TT_ALL_STRATEGIES_FAILED (documented TikTok limitation)${C_RST}"
  elif [[ "$code" == "502" && "$body" == *"LI_ALL_STRATEGIES_FAILED"* ]]; then
    note "$label ${C_DIM}HTTP 502 - LinkedIn throttled both job sources (transient)${C_RST}"
  elif [[ "$code" == "429" && "$body" == *"RATE_LIMITED"* ]]; then
    note "$label ${C_DIM}HTTP 429 - upstream throttled (transient, not a code failure)${C_RST}"
  else
    err "$label ${C_DIM}HTTP $code (expected $expected)${C_RST}"
    [[ -n "$body" ]] && printf '      %s%s%s\n' "$C_DIM" "$(printf '%s' "$body" | head -c 220 | tr '\n' ' ')" "$C_RST"
  fi
}

test_connector() {
  local name="$1" base="$2" svc="$3" user="$4" auth="$5"
  printf '\n  %s%s%s\n' "$C_BOLD" "$name" "$C_RST"
  http_req "GET /"                         GET "$base/"                                  200      "$auth" name
  http_req "GET /health"                   GET "$base/health"                            200      "$auth" status
  http_req "GET /openapi.yaml"             GET "$base/openapi.yaml"                     200      "$auth" ""
  http_req "GET /v1/session"               GET "$base/v1/session"                       200      "$auth" session
  http_req "GET /v1/proxies"               GET "$base/v1/proxies"                       200      "$auth" ""
  http_req "GET /v1/diagnostics"           GET "$base/v1/diagnostics?username=$user"   200      "$auth" ""
  http_req "GET /v1/$svc/:username"        GET "$base/v1/$svc/$user"                   200      "$auth" followers
  http_req "GET /v1/$svc/:username/posts"  GET "$base/v1/$svc/$user/posts?limit=2"     "200,502" "$auth" count
  http_req "OPTIONS (CORS preflight)"      OPTIONS "$base/health"                      "204,200" "$auth" ""
  http_req "unknown route -> 404"          GET "$base/nope"                             404      "$auth" ""
  http_req "bad username -> 400"           GET "$base/v1/$svc/bad!!/posts"              400      "$auth" ""
  http_req "bad limit -> 400"              GET "$base/v1/$svc/$user/posts?limit=abc"   400      "$auth" ""
  if [[ -n "$auth" ]]; then
    http_req "missing API key -> 401"      GET "$base/health"                           401      "" ""
  fi
}

test_linkedin() {
  local base="$1" auth="$2" company="$3"
  printf '\n  %sLinkedIn%s\n' "$C_BOLD" "$C_RST"
  http_req "GET /"                          GET "$base/"                                                   200      "$auth" name
  http_req "GET /health"                    GET "$base/health"                                             200      "$auth" status
  http_req "GET /openapi.yaml"              GET "$base/openapi.yaml"                                      200      "$auth" ""
  http_req "GET /v1/session"                GET "$base/v1/session"                                        200      "$auth" session
  http_req "GET /v1/proxies"                GET "$base/v1/proxies"                                        200      "$auth" ""
  http_req "GET /v1/diagnostics"            GET "$base/v1/diagnostics?keywords=python&location=France"   200      "$auth" ""
  http_req "GET /v1/linkedin/jobs/search"   GET "$base/v1/linkedin/jobs/search?keywords=python&location=France&limit=3" "200,502" "$auth" count
  http_req "GET /v1/linkedin/jobs/:id"      GET "$base/v1/linkedin/jobs/4486054169"                      "200,404" "$auth" company
  http_req "GET /v1/linkedin/company/:slug" GET "$base/v1/linkedin/company/$company"                      200      "$auth" name
  http_req "GET /v1/linkedin/signals"       GET "$base/v1/linkedin/signals/hiring?skill=python&country=France&pages=1" 200 "$auth" sampleSize
  http_req "people endpoint (data policy)"  GET "$base/v1/linkedin/people/reidhoffman"                  "403,200" "$auth" ""
  http_req "OPTIONS (CORS preflight)"       OPTIONS "$base/health"                                        "204,200" "$auth" ""
  http_req "unknown route -> 404"           GET "$base/nope"                                              404      "$auth" ""
  http_req "jobs without query -> 400"      GET "$base/v1/linkedin/jobs/search"                          400      "$auth" ""
  http_req "signals without params -> 400"  GET "$base/v1/linkedin/signals/hiring"                      400      "$auth" ""
  http_req "bad limit -> 400"               GET "$base/v1/linkedin/jobs/search?keywords=python&limit=abc" 400   "$auth" ""
  if [[ -n "$auth" ]]; then
    http_req "missing API key -> 401"      GET "$base/health"                                            401      "" ""
  fi
}

[[ $RUN_IG -eq 1 ]] && test_connector "Instagram" "http://127.0.0.1:$IG_PORT" "instagram" "$IG_USER" "$IG_API_KEY"
[[ $RUN_TT -eq 1 ]] && test_connector "TikTok"    "http://127.0.0.1:$TT_PORT" "tiktok"    "$TT_USER" "$TT_API_KEY"
[[ $RUN_LI -eq 1 ]] && test_linkedin "http://127.0.0.1:$LI_PORT" "$LI_API_KEY" "$LI_COMPANY"

# ---- phase 4: demonstration --------------------------------------------
section "4/4  Demonstration"

demo_one() {
  local name="$1" base="$2" svc="$3" user="$4" auth="$5"
  local -a args=(-sS --max-time 120)
  [[ -n "$auth" ]] && args+=(-H "X-API-Key: $auth")
  local profile posts
  profile="$(curl "${args[@]}" "$base/v1/$svc/$user" 2>/dev/null)"
  posts="$(curl "${args[@]}" "$base/v1/$svc/$user/posts?limit=2" 2>/dev/null)"
  printf '\n  %s%s  @%s%s\n' "$C_BOLD" "$name" "$user" "$C_RST"
  printf '    %-14s %s\n' "followers" "$(printf '%s' "$profile" | jget followers)"
  printf '    %-14s %s\n' "following" "$(printf '%s' "$profile" | jget following)"
  printf '    %-14s %s\n' "posts" "$(printf '%s' "$profile" | jget posts)"
  printf '    %-14s %s\n' "source" "$(printf '%s' "$profile" | jget source)"
  local strategy count first_url likes date
  strategy="$(printf '%s' "$posts" | jget strategy)"
  count="$(printf '%s' "$posts" | jget count)"
  if [[ -z "$strategy" || -z "$count" ]]; then
    note "posts unavailable here ($(printf '%s' "$posts" | jget error.code)) - see /v1/diagnostics"
    return
  fi
  first_url="$(printf '%s' "$posts" | jget posts.0.url)"
  likes="$(printf '%s' "$posts" | jget posts.0.likes)"
  date="$(printf '%s' "$posts" | jget posts.0.datePosted)"
  printf '    %-14s %s\n' "strategy" "$strategy"
  printf '    %-14s %s\n' "returned" "$count posts"
  printf '    %-14s %s\n' "first url" "$first_url"
  printf '    %-14s %s\n' "first likes" "${likes:-null (set IG_ENRICH_POSTS=1)}"
  printf '    %-14s %s\n' "first date" "$date"
}

demo_linkedin() {
  local base="$1" auth="$2" company="$3"
  local -a args=(-sS --max-time 120)
  [[ -n "$auth" ]] && args+=(-H "X-API-Key: $auth")
  local jobs comp signals
  jobs="$(curl "${args[@]}" "$base/v1/linkedin/jobs/search?keywords=python&location=France&limit=3" 2>/dev/null)"
  comp="$(curl "${args[@]}" "$base/v1/linkedin/company/$company" 2>/dev/null)"
  signals="$(curl "${args[@]}" "$base/v1/linkedin/signals/hiring?skill=python&country=France&pages=1" 2>/dev/null)"
  printf '\n  %sLinkedIn%s  jobs + company + signals\n' "$C_BOLD" "$C_RST"
  printf '    %-16s %s\n' "jobs returned" "$(printf '%s' "$jobs" | jget count)"
  printf '    %-16s %s\n' "strategy" "$(printf '%s' "$jobs" | jget strategy)"
  printf '    %-16s %s\n' "first job" "$(printf '%s' "$jobs" | jget jobs.0.title)"
  printf '    %-16s %s\n' "first company" "$(printf '%s' "$jobs" | jget jobs.0.company)"
  printf '    %-16s %s\n' "first city" "$(printf '%s' "$jobs" | jget jobs.0.city)"
  printf '    %-16s %s\n' "company name" "$(printf '%s' "$comp" | jget name)"
  printf '    %-16s %s\n' "followers" "$(printf '%s' "$comp" | jget followers)"
  printf '    %-16s %s\n' "founded" "$(printf '%s' "$comp" | jget foundedYear)"
  printf '    %-16s %s\n' "company posts" "$(printf '%s' "$comp" | jget posts.length)"
  printf '    %-16s %s\n' "signal sample" "$(printf '%s' "$signals" | jget sampleSize)"
  printf '    %-16s %s\n' "in window" "$(printf '%s' "$signals" | jget inWindow)"
  printf '    %-16s %s\n' "top city" "$(printf '%s' "$signals" | jget byCity.0.name)"
}

[[ $RUN_IG -eq 1 ]] && demo_one "Instagram" "http://127.0.0.1:$IG_PORT" "instagram" "$IG_USER" "$IG_API_KEY"
[[ $RUN_TT -eq 1 ]] && demo_one "TikTok"    "http://127.0.0.1:$TT_PORT" "tiktok"    "$TT_USER" "$TT_API_KEY"
[[ $RUN_LI -eq 1 ]] && demo_linkedin "http://127.0.0.1:$LI_PORT" "$LI_API_KEY" "$LI_COMPANY"

printf '\n%s' "$C_DIM"
printf '  Startup logs (tail):\n'
for f in "$LOGDIR"/*.log; do
  [[ -f "$f" ]] || continue
  printf '  -- %s --\n' "$(basename "$f")"
  tail -n 6 "$f" | sed 's/^/    /'
done
printf '%s' "$C_RST"

section "Summary"
printf '  %s%d passed · %d warnings · %d failures · %d notes%s\n' "$C_BOLD" "$PASS" "$WARNS" "$FAILS" "$NOTES" "$C_RST"
[[ $WARNS -gt 0 ]] && note "warnings are advisory; failures are the ones to fix"
[[ $FAILS -eq 0 ]] && exit 0 || exit 1
