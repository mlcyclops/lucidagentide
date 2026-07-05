// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-PREVIEW.6c — structured actions on the live preview (ADR-0148). The agent's preview_click /
// preview_type tools act on the preview by CSS selector, through the SAME held relay + bridge as 6b's inspect
// (the bridge routes on `action`). Bounded to click/type/focus/scroll — never arbitrary JS. This demo proves
// the relay carries action commands and the injected bridge exposes ONLY the named action allowlist.

import { InspectRelay } from "../preview_inspect_relay.ts";
import { PREVIEW_BRIDGE_JS } from "../preview_bridge.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

console.log("== #ADR-0148 P-PREVIEW.6c: agent clicks/types in the sandboxed preview via the same relay + bridge ==\n");

console.log("[1] the relay carries a structured action command (action + selector + value), length-capped");
const relay = new InspectRelay();
const { id, promise } = relay.enqueue({ action: "type", selector: "#name", value: "x".repeat(5000) });
const cmd = relay.next()!.command;
assert(cmd.action === "type" && cmd.selector === "#name", "action + selector round-trip to the renderer");
assert(cmd.value!.length === 2000, "an over-long typed value is capped");
assert(relay.resolve(id, { ok: true, action: "type" }) === true, "the renderer's action result resolves the held tool call");
assert((await promise as { ok: boolean }).ok === true, "the tool sees the action succeeded");

console.log("\n[2] the bridge routes on `action` and exposes ONLY a fixed allowlist (click/type/focus/scroll)");
assert(PREVIEW_BRIDGE_JS.includes("cmd.action ? act(cmd) : inspect(cmd)"), "a command with `action` runs the action path, else it inspects");
for (const a of ["click", "type", "focus", "scroll"]) assert(PREVIEW_BRIDGE_JS.includes(`action==='${a}'`), `allowed action: ${a}`);

console.log("\n[3] still NO arbitrary-code / raw-HTML surface — actions are bounded, not eval");
assert(!/\beval\s*\(|new\s+Function|innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|document\.write/.test(PREVIEW_BRIDGE_JS), "no eval / Function / innerHTML / document.write in the bridge");
assert(PREVIEW_BRIDGE_JS.includes("ev.source!==window.parent"), "the bridge still only answers its own parent (the LUCID renderer)");

console.log("\n✓ P-PREVIEW.6c demo passed — structured click/type flow through the relay + a bounded bridge (no JS).");
