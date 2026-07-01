// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_3a_shot.ts — P-PREVIEW.3a-shot (ADR-0096): the agent SEES its own rendered UI.
//
// capturePage lives in the Electron main process, unreachable from omp's subprocess — so the renderer
// proactively caches a PNG of the current preview to the desktop after each render, and the agent's
// `preview_screenshot` tool FETCHES that cached shot and returns it as ImageContent (the shape the model
// actually sees). Proves the verifiable parts (the model seeing the image needs the live packaged app):
//   (1) preview_screenshot is registered as a read-tier tool (never trips the exec gate) with an empty schema;
//   (2) a cached PNG data URL becomes a proper ImageContent block ({ type:'image', data, mimeType });
//   (3) execute wraps that image + a caption, and degrades to helpful TEXT (never throws) when there's no
//       shot / no desktop / the fetch fails — so a screenshot attempt can never break a turn.

import previewExtension, { previewShotImage } from "../../harness/omp/preview_extension.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const typebox = { Type: { Object: (p: Record<string, any>) => ({ type: "object", properties: p, required: Object.keys(p) }), String: (o: any = {}) => ({ type: "string", ...o }) } };
const tool = () => { const tools: any[] = []; previewExtension({ registerTool: (t: any) => tools.push(t), typebox }); return tools.find((t) => t.name === "preview_screenshot"); };

console.log("== P-PREVIEW.3a-shot — the agent sees its own rendered UI ==");

console.log("\n1) preview_screenshot is a read-tier tool");
const t = tool();
if (!t) fail("preview_screenshot must be registered");
if (t.approval !== "read") fail("must be read-tier (never trips the exec gate)");
ok(`registered: preview_screenshot (approval=${t.approval})`);

console.log("\n2) a cached PNG data URL → ImageContent (what the model sees)");
const img = previewShotImage("data:image/png;base64,iVBORw0KGgo=");
if (!img || img.type !== "image" || img.mimeType !== "image/png" || img.data !== "iVBORw0KGgo=") fail("should parse to ImageContent");
ok(`data:image/png;… → { type:image, mimeType:${img.mimeType}, data:${img.data.length}b }`);
for (const bad of ["", "data:text/html;base64,AAAB", "nope"]) if (previewShotImage(bad)) fail(`should reject: "${bad}"`);
ok("non-image / malformed → null (no bogus image block)");

console.log("\n3) execute: image when cached; graceful text otherwise (never throws)");
const realFetch = globalThis.fetch;
try {
  process.env.LUCID_PREVIEW_SHOT_URL = "http://127.0.0.1:9/api/preview/shot?t=x";
  globalThis.fetch = (async () => new Response(JSON.stringify({ png: "data:image/png;base64,Zm9v" }), { headers: { "content-type": "application/json" } })) as any;
  const withShot = await t.execute();
  if (withShot.content[0]?.type !== "image" || withShot.content[0].data !== "Zm9v") fail("should return the cached image");
  ok("shot cached → image block returned");

  globalThis.fetch = (async () => new Response(JSON.stringify({ png: null }), { headers: { "content-type": "application/json" } })) as any;
  const none = await t.execute();
  if (none.content[0]?.type !== "text" || none.content.some((c: any) => c.type === "image")) fail("no shot → text, no image");
  ok("no shot yet → helpful text (no image)");

  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as any;
  const errored = await t.execute();
  if (errored.content[0]?.type !== "text") fail("fetch error → graceful text");
  ok("fetch throws → graceful text (execute never throws)");

  delete process.env.LUCID_PREVIEW_SHOT_URL;
  const noEnv = await t.execute();
  if (noEnv.content[0]?.type !== "text") fail("no env URL → graceful text");
  ok("no desktop (no env URL) → graceful text");
} finally {
  globalThis.fetch = realFetch;
  delete process.env.LUCID_PREVIEW_SHOT_URL;
}

console.log("\nPASS — the agent can fetch + see the rendered preview; every failure path degrades to text.");
