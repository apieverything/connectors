/* API Everything - Instagram connector
 * ------------------------------------------------------------------
 * Paste this WHOLE file into the DevTools console (F12) while on
 * https://www.instagram.com/ and logged in.
 *
 * It builds a ready-to-paste .env block and copies it to your clipboard.
 * It runs ENTIRELY locally: no fetch, no network request, nothing is sent
 * anywhere. It only reads cookies, the User-Agent and (optionally) text you
 * paste into a prompt.
 *
 * NOTE: sessionid is HttpOnly on instagram.com, so browser JavaScript cannot
 * read it directly. When that happens, DevTools > Network > right-click any
 * request to www.instagram.com > Copy > Copy as cURL, and paste that into the
 * prompt. The Cookie header in that cURL DOES contain sessionid.
 * ------------------------------------------------------------------ */
(async () => {
  const KEYS = ["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did", "rur", "datr"];
  const jar = {};
  const put = (name, value) => {
    if (name && value && !jar[name]) jar[name] = value;
  };

  // 1. Cookie Store API (Chrome/Edge/Safari/Firefox, secure contexts).
  try {
    if (typeof cookieStore !== "undefined") {
      for (const cookie of await cookieStore.getAll()) put(cookie.name, cookie.value);
    }
  } catch (err) {
    console.warn("[ig] cookieStore unavailable, using document.cookie:", err.message);
  }

  // 2. document.cookie: everything that is not HttpOnly.
  document.cookie.split(";").forEach((part) => {
    const sep = part.indexOf("=");
    if (sep === -1) return;
    put(part.slice(0, sep).trim(), part.slice(sep + 1).trim());
  });

  // 3. Pull values out of a "Copy as cURL" / raw Cookie header string.
  const parseCookieText = (text) => {
    const found = {};
    for (const key of KEYS) {
      const match = String(text).match(new RegExp(`(?:^|[;\\s'"])${key}=([^;'"\\s]+)`));
      if (match) found[key] = match[1];
    }
    return found;
  };

  if (!jar.sessionid) {
    console.warn(
      "[ig] sessionid is HttpOnly, so JavaScript cannot read it.\n" +
        "DevTools > Network > right-click a request to www.instagram.com > Copy > Copy as cURL,\n" +
        "then paste it into the prompt (a raw Cookie header works too)."
    );
    const pasted =
      typeof prompt === "function"
        ? prompt("Paste 'Copy as cURL' (or the Cookie header) to fill IG_SESSIONID:")
        : null;
    if (pasted) {
      for (const [key, value] of Object.entries(parseCookieText(pasted))) put(key, value);
    }
  }

  const env = [
    "# API Everything - Instagram connector (generated from DevTools)",
    `IG_SESSIONID=${jar.sessionid ?? ""}`,
    `IG_CSRFTOKEN=${jar.csrftoken ?? ""}`,
    `IG_DS_USER_ID=${jar.ds_user_id ?? ""}`,
    `IG_USER_AGENT=${navigator.userAgent}`,
  ].join("\n");

  // DevTools exposes copy(); browsers without it get the Clipboard API.
  try {
    if (typeof copy === "function") copy(env);
    else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(env);
  } catch (err) {
    console.warn("[ig] could not write to the clipboard, select the block below:", err.message);
  }

  console.log("[ig] --- .env (copied to clipboard) ---");
  console.log(env);
  console.log("[ig] -----------------------------------");

  if (!jar.sessionid) {
    console.error(
      "[ig] IG_SESSIONID is still empty. Fallback: DevTools > Application (Storage in " +
        "Firefox) > Cookies > https://www.instagram.com > copy the sessionid value by hand."
    );
  } else {
    console.log("[ig] Done. Paste the block above into your .env, then restart the connector.");
  }
})();
