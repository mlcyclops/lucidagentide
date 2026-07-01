// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_4b.ts — P-PREVIEW.4b (ADR-0096): serve the preview with its OWN per-frame
// CSP so a previewed app's inline scripts actually RUN.
//
// The P-PREVIEW.4 srcdoc render had a structural flaw: a `srcdoc` iframe INHERITS the renderer's strict
// `script-src 'self'` CSP, which blocks a self-contained app's inline <script> — so the app's JS never ran
// and only its static HTML painted ("only the HUD shows"). Fix: serve the file via `iframe.src` from
// `/api/preview/serve`, which returns the document with PREVIEW_FRAME_CSP — its own policy, NOT inherited.
//
// Proves (no live browser needed; the live render is screenshot-verified separately):
//   (1) PREVIEW_FRAME_CSP lets the app run (inline script + style, data/blob media) — what srcdoc blocked;
//   (2) it blocks ALL network egress (connect-src 'none' / default-src 'none') so a previewed, agent-authored
//       app can never bypass the egress gate, and pins down base-uri / form-action;
//   (3) it admits no remote script/style origin (self-contained only);
//   (4) the served document still relies on the opaque-origin sandbox (no allow-same-origin) for isolation.

import { PREVIEW_FRAME_CSP, PREVIEW_SANDBOX } from "../preview_resolve.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

const dirs = new Map(
  PREVIEW_FRAME_CSP.split(";").map((d) => { const [n, ...v] = d.trim().split(/\s+/); return [n, v] as const; }),
);
const has = (dir: string, val: string) => (dirs.get(dir) ?? []).includes(val);

console.log("== P-PREVIEW.4b — served preview with a per-frame CSP (inline scripts run; egress blocked) ==");

console.log("\n1) the app can RUN (what the inherited srcdoc CSP blocked)");
if (!has("script-src", "'unsafe-inline'")) fail("script-src must allow 'unsafe-inline' (the app's inline JS)");
if (!has("style-src", "'unsafe-inline'")) fail("style-src must allow 'unsafe-inline'");
if (!has("img-src", "data:") || !has("img-src", "blob:")) fail("img-src must allow data:/blob:");
if (!has("media-src", "data:")) fail("media-src must allow data: (synth audio buffers / data-URI sound)");
ok("inline script + style, data/blob img + media → allowed");

console.log("\n2) but NO network egress (the previewed app can't bypass the egress gate)");
for (const [dir, want] of [["default-src", "'none'"], ["connect-src", "'none'"], ["form-action", "'none'"], ["base-uri", "'none'"]] as const) {
  if (JSON.stringify(dirs.get(dir)) !== JSON.stringify([want])) fail(`${dir} must be exactly ${want}`);
  ok(`${dir} ${want}`);
}

console.log("\n3) no remote script/style origins (self-contained apps only)");
for (const dir of ["script-src", "style-src"]) {
  for (const v of dirs.get(dir) ?? []) if (/^https?:/.test(v)) fail(`${dir} must not list a remote origin: ${v}`);
}
ok("script-src / style-src carry no http(s) origin");

console.log("\n4) isolation still comes from the opaque-origin sandbox");
if (PREVIEW_SANDBOX.includes("allow-same-origin")) fail("the served frame must stay opaque-origin (no allow-same-origin)");
ok(`sandbox = "${PREVIEW_SANDBOX}" (opaque origin)`);

console.log("\nPASS — served preview runs the app's inline scripts while blocking egress; srcdoc's CSP-inherit gap is closed.");
