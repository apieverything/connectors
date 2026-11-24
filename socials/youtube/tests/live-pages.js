"use strict";
// Live pagination check: node tests/live-pages.js "@fireship/posts?limit=5" | "search?q=fireship&limit=5"
const B = process.env.YT_BASE_URL || "http://127.0.0.1:3977/v1/youtube";
(async () => {
  const p = process.argv[2];
  const j1 = await (await fetch(`${B}/${p}`)).json();
  const items = (j) => j.posts ?? j.videos ?? j.items ?? j.results ?? [];
  const ids = (j) => items(j).map((v) => v.videoId ?? v.id);
  console.log("page1", ids(j1), "cursor?", Boolean(j1.nextCursor));
  const j2 = await (await fetch(`${B}/${p}&cursor=${encodeURIComponent(j1.nextCursor)}`)).json();
  console.log("page2", ids(j2), "cursor?", Boolean(j2.nextCursor), j2.error?.code ?? "");
  const a = new Set(ids(j1));
  console.log("distinct:", ids(j2).length > 0 && ids(j2).every((x) => !a.has(x)));
})();
