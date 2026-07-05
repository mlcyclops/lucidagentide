// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_3a.ts — P-PREVIEW.3a (ADR-0096): "the agent drives the preview".
//
// A registered `preview_open` tool the agent calls to open a local file it built in the Preview panel,
// instead of the old workaround of trying browser/bash/eval (all security-gated → DENIED). Proves:
//   (1) the omp extension registers exactly one `preview_open` tool, as a READ-tier tool (so opening a
//       preview never trips the exec gate), with a real TSchema authored via the injected `pi.typebox`
//       shim — and registration NEVER throws (can't break omp launch), including when the shim is absent;
//   (2) its execute accepts a local .html/.svg path and rejects everything else;
//   (3) acp_backend's pure detector (previewOpenPath) extracts the path from the ACP call — keyed on the
//       rendered TITLE ("preview_open: <path>"), because a custom tool's name maps to kind "other" — so the
//       panel opens via the same `preview-available` path the renderer already handles (P-PREVIEW.2);
//   (4) the surfaced path is RE-GATED by resolvePreview before anything renders.
// The model actually invoking the tool is confirmed live (omp+Electron); everything else is proven here.

import previewExtension from "../../harness/omp/preview_extension.ts";
import { previewOpenPath, resolvePreview } from "../preview_resolve.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

// The TypeBox shim omp injects as `pi.typebox` (Type.Object/Type.String → JSON-schema-ish TSchema).
const typebox = {
  Type: {
    Object: (properties: Record<string, any>) => ({ type: "object", properties, required: Object.keys(properties) }),
    String: (opts: any = {}) => ({ type: "string", ...opts }),
  },
};

console.log("== P-PREVIEW.3a — agent-invoked preview_open ==");

console.log("\n1) the extension registers preview_open (read-tier, real TSchema) and never breaks omp");
const tools: any[] = [];
previewExtension({ registerTool: (t: any) => tools.push(t), typebox });
const open = tools.find((t) => t.name === "preview_open");
if (!open) fail("should register preview_open");                          // (preview_screenshot is P-PREVIEW.3a-shot)
if (open.approval !== "read") fail("preview_open must be a read-tier tool (never hits the exec gate)");
if (!open.parameters?.required?.includes("path")) fail("parameters must be a TSchema requiring `path`");
ok(`registered: preview_open (approval=${open.approval}, params=${open.parameters.required})`);
let threw = false;
try {
  previewExtension(null);
  previewExtension({});                                                   // no registerTool
  previewExtension({ registerTool: (t: any) => t });                      // no typebox shim → silent no-op
  previewExtension({ registerTool: () => { throw new Error("x"); }, typebox }); // throwing registerTool
} catch { threw = true; }
if (threw) fail("registration must NEVER throw (would break omp launch)");
ok("no-registerTool / no-typebox / throwing-registerTool → no throw (omp launch safe)");

console.log("\n2) execute gates the path (local .html/.svg only)");
const t = open;
if ((await t.execute("id", { path: "C:/Users/n/game.html" })).isError) fail("valid path should pass");
ok("C:/Users/n/game.html → opens");
for (const bad of ["src/index.ts", "game.html", ""]) {
  if (!(await t.execute("id", { path: bad })).isError) fail(`should reject: "${bad}"`);
  ok(`rejected: "${bad}"`);
}

console.log("\n3) acp_backend extracts the path from the ACP call title → drives the panel");
// Real-world input: omp renders a custom tool call's title as "preview_open: <path>" (kind is "other").
const title = "preview_open: C:/Users/n/game.html";
const p = previewOpenPath(title, { path: "C:/Users/n/game.html" });
if (p !== "C:/Users/n/game.html") fail("previewOpenPath should extract the path from the call title");
if (previewOpenPath("other", { path: "game.html" }) !== null) fail("the bare kind ('other') must never match");
if (previewOpenPath("write", { path: "game.html" }) !== null) fail("only preview_open should match");
ok(`title "${title}" → ${p}`);
const r = resolvePreview(p!); // still re-gated before rendering
if (r.kind !== "local") fail("the surfaced path must re-resolve to a local file");
ok(`re-gated by resolvePreview → ${r.kind} (${r.src})`);

console.log("\nPASS — the agent's preview_open is registered, gated, and drives the panel via the call title.");
