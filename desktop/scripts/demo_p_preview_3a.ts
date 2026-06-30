// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_3a.ts — P-PREVIEW.3a (ADR-0096) — DRAFT.
//
// "The agent drives the preview": a registered `preview_open` tool the agent calls to open a local file it
// built in the Preview panel. Proves the verifiable parts (no live omp/Electron):
//   (1) the omp extension registers exactly one `preview_open` tool and NEVER throws (can't break omp launch);
//   (2) its execute accepts a local .html/.svg path and rejects everything else;
//   (3) acp_backend's pure detector (previewOpenPath) extracts the path from the tool_call so the panel can
//       open it (via the same `preview-available` path the renderer already handles, P-PREVIEW.2).
// NOT covered here (needs live omp+Electron): the real omp registerTool schema, the model invoking the tool,
// and the `preview_screenshot` round-trip (P-PREVIEW.3a-shot).

import previewExtension from "../../harness/omp/preview_extension.ts";
import { previewOpenPath, resolvePreview } from "../preview_resolve.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-PREVIEW.3a (draft) — agent-invoked preview_open ==");

console.log("\n1) the extension registers preview_open and never breaks omp");
const tools: any[] = [];
previewExtension({ registerTool: (t: any) => tools.push(t) });
if (tools.length !== 1 || tools[0].name !== "preview_open") fail("should register exactly preview_open");
ok("registered: preview_open");
let threw = false;
try { previewExtension(null); previewExtension({}); previewExtension({ registerTool: () => { throw new Error("x"); } }); } catch { threw = true; }
if (threw) fail("registration must NEVER throw (would break omp launch)");
ok("no-registerTool / throwing-registerTool → no throw (omp launch safe)");

console.log("\n2) execute gates the path (local .html/.svg only)");
const t = tools[0];
if ((await t.execute("id", { path: "C:/Users/n/game.html" })).isError) fail("valid path should pass");
ok("C:/Users/n/game.html → opens");
for (const bad of ["src/index.ts", "game.html", ""]) {
  if (!(await t.execute("id", { path: bad })).isError) fail(`should reject: "${bad}"`);
  ok(`rejected: "${bad}"`);
}

console.log("\n3) acp_backend extracts the path from the tool_call → drives the panel");
const p = previewOpenPath("preview_open", { path: "C:/Users/n/game.html" });
if (p !== "C:/Users/n/game.html") fail("previewOpenPath should extract the path");
if (previewOpenPath("write", { path: "game.html" }) !== null) fail("only preview_open should match");
ok(`preview_open → ${p}`);
const r = resolvePreview(p!); // still re-gated before rendering
if (r.kind !== "local") fail("the surfaced path must re-resolve to a local file");
ok(`re-gated by resolvePreview → ${r.kind} (${r.src})`);

console.log("\nDRAFT PASS — agent preview_open is wired + gated; live omp+Electron verifies registration + invocation.");
