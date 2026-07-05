// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-PREVIEW.6b — the agent READS the live preview DOM (ADR-0153). The preview iframe is opaque-origin
// sandboxed, so the agent's `preview_inspect` tool (in omp's subprocess) can't touch it; instead the dev server
// HOLDS the tool's request while the renderer runs the query on the frame via an injected postMessage bridge
// and posts the result back. This demo proves the pure relay + the read-only bridge injection headlessly.

import { InspectRelay } from "../preview_inspect_relay.ts";
import { injectPreviewBridge, PREVIEW_BRIDGE_JS } from "../preview_bridge.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

console.log("== #ADR-0153 P-PREVIEW.6b: agent reads the sandboxed preview DOM via a held relay + a read-only bridge ==\n");

console.log("[1] the relay: tool enqueues + awaits → renderer takes next → posts result → tool resolves");
const relay = new InspectRelay();
const { id, promise } = relay.enqueue({ selector: "#app", what: "summary" });
const taken = relay.next();
assert(taken?.id === id && taken?.command.selector === "#app", "the renderer receives the queued command");
assert(relay.resolve(id, { count: 1, matches: [] }) === true, "posting the result resolves the held tool call");
assert((await promise as { count: number }).count === 1, "the tool's awaited promise gets the DOM result");

console.log("\n[2] fail-closed: a command times out with a helpful message (no preview / no response)");
const t = relay.enqueue({ what: "summary" });
relay.abandon(t.id, { error: "no preview is open" });
assert((await t.promise as { error: string }).error === "no preview is open", "abandon() returns a helpful timeout result + drops the command");
assert(relay.next() === null, "the abandoned command is not left in the queue");

console.log("\n[3] the injected bridge uses NO arbitrary-code primitives and talks only to its own parent");
const html = injectPreviewBridge("<html><body><h1>Hi</h1></body></html>");
assert(html.includes("__lucidInspect") && html.indexOf("<script>") < html.indexOf("</body>"), "the bridge is injected before </body>");
// The inspect path is read-only; the only mutation is P-PREVIEW.6c's fixed act() allowlist (click/type/focus/
// scroll), covered by the 6c demo/tests. What must NEVER appear is arbitrary code execution or markup injection.
assert(!/\beval\s*\(|new\s+Function|innerHTML\s*=|document\.write/.test(PREVIEW_BRIDGE_JS), "no eval / Function / innerHTML / document.write in the bridge");
assert(PREVIEW_BRIDGE_JS.includes("ev.source!==window.parent"), "the bridge only answers its own parent (the LUCID renderer)");

console.log("\n✓ P-PREVIEW.6b demo passed — the read-only DOM-inspect relay + bridge are correct and fail-closed.");
