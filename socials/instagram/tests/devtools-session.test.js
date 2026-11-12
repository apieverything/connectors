"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SNIPPET = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "devtools-session.js"),
  "utf8"
);

const CURL = `curl 'https://www.instagram.com/api/v1/users/web_profile_info/?username=kametolol' \\
  -H 'cookie: sessionid=1234567%3AabcXYZ%3A17%3Adef; ds_user_id=12345678901; csrftoken=T0kEn==; mid=ZmId==; rur=FTN' \\
  -H 'user-agent: Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0 Safari/537.36' \\
  --compressed`;

const UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0 Safari/537.36";

/** Run the exact README snippet in a fake browser context. No fetch is provided. */
async function run({ cookies = "", cookieStore = null, promptValue = null, withPrompt = true } = {}) {
  let copied = null;
  const logs = [];
  const warns = [];
  const errors = [];
  let promptCalls = 0;

  const sandbox = {
    document: { cookie: cookies },
    navigator: { userAgent: UA, clipboard: { writeText: async () => {} } },
    console: {
      log: (...args) => logs.push(args.join(" ")),
      warn: (...args) => warns.push(args.join(" ")),
      error: (...args) => errors.push(args.join(" ")),
    },
    copy: (text) => {
      copied = text;
    },
  };
  if (cookieStore) sandbox.cookieStore = cookieStore;
  if (withPrompt) {
    sandbox.prompt = () => {
      promptCalls += 1;
      return promptValue;
    };
  }

  vm.createContext(sandbox);
  await vm.runInContext(SNIPPET, sandbox);
  return { copied, logs, warns, errors, promptCalls };
}

test("HttpOnly case: fills sessionid from a pasted 'Copy as cURL'", async () => {
  const { copied, logs, errors, promptCalls } = await run({
    cookies: "mid=ZmId==; ig_nrcb=1; csrftoken=T0kEn==; ds_user_id=12345678901",
    cookieStore: {
      getAll: async () => [
        { name: "csrftoken", value: "T0kEn==" },
        { name: "ds_user_id", value: "12345678901" },
      ],
    },
    promptValue: CURL,
  });

  assert.equal(promptCalls, 1);
  assert.match(copied, /IG_SESSIONID=1234567%3AabcXYZ%3A17%3Adef/);
  assert.match(copied, /IG_CSRFTOKEN=T0kEn==/);
  assert.match(copied, /IG_DS_USER_ID=12345678901/);
  assert.match(copied, new RegExp(`IG_USER_AGENT=${UA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(errors.length, 0, "should not report a missing session");
  assert.ok(logs.some((line) => line.includes("Done.")));
});

test("a raw Cookie header also works", async () => {
  const { copied } = await run({
    promptValue: "sessionid=RAW_SESSION; csrftoken=RAW_CSRF; ds_user_id=42",
  });
  assert.match(copied, /IG_SESSIONID=RAW_SESSION/);
  assert.match(copied, /IG_CSRFTOKEN=RAW_CSRF/);
  assert.match(copied, /IG_DS_USER_ID=42/);
});

test("when sessionid is readable, no prompt is needed", async () => {
  const { copied, promptCalls, warns } = await run({
    cookies: "sessionid=VISIBLE; csrftoken=C; ds_user_id=7",
    promptValue: CURL,
  });
  assert.equal(promptCalls, 0);
  assert.match(copied, /IG_SESSIONID=VISIBLE/);
  assert.ok(!warns.some((w) => w.includes("HttpOnly")));
});

test("cancelled prompt yields an empty value plus a manual fallback message", async () => {
  const { copied, errors } = await run({ promptValue: null });
  assert.match(copied, /IG_SESSIONID=\n/);
  assert.ok(errors.some((e) => e.includes("Application")));
});

test("cookieStore failure falls back to document.cookie", async () => {
  const { copied, warns } = await run({
    cookies: "sessionid=S; csrftoken=CS==; ds_user_id=99",
    cookieStore: { getAll: async () => { throw new Error("blocked"); } },
    promptValue: null,
  });
  assert.match(copied, /IG_SESSIONID=S/);
  assert.match(copied, /IG_CSRFTOKEN=CS==/);
  assert.ok(warns.some((w) => w.includes("cookieStore unavailable")));
});

test("the snippet performs no network calls", () => {
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|WebSocket/.test(SNIPPET));
});

test("the copy embedded in README.md works too (no drift)", async () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const blocks = [...readme.matchAll(/```js\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const inline = blocks.find((block) => block.includes("IG_SESSIONID="));
  assert.ok(inline, "README.md must contain the copy-paste snippet");

  let copied = null;
  const sandbox = {
    document: { cookie: "csrftoken=INLINE; ds_user_id=7" },
    cookieStore: { getAll: async () => [] },
    navigator: { userAgent: UA, clipboard: { writeText: async () => {} } },
    console: { log() {}, warn() {}, error() {} },
    copy: (text) => {
      copied = text;
    },
    prompt: () => "cookie: sessionid=FROM_README; csrftoken=INLINE; ds_user_id=7",
  };
  vm.createContext(sandbox);
  await vm.runInContext(inline, sandbox);

  assert.match(copied, /IG_SESSIONID=FROM_README/);
  assert.match(copied, /IG_CSRFTOKEN=INLINE/);
});
