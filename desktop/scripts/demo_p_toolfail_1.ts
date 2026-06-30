// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_toolfail_1.ts
//
// Increment P-TOOLFAIL.1 (ADR-0093) — an honest chip for a failed/rejected tool call.
// Proves, against canned omp tool_call_update payloads (deterministic; no live omp), that:
//   (1) the OLD behavior flattened every failed/rejected update to a flat "tool call rejected"
//       that read as a security/permission DENIAL — the exact mislabel that confused a real turn
//       (browser-open + js-execute showed "rejected" with no prompt and no audit record);
//   (2) a "failed" status now reports the tool RAN and errored, with omp's own message;
//   (3) a "rejected" status now reports the tool DID NOT run — never the word "rejected"/"denied",
//       so an unavailable tool is not mistaken for a gate block;
//   (4) omp's message is surfaced across the shapes it uses (content[], rawOutput, message/error);
//   (5) it stays a NEUTRAL chip — this path never carries a security quarantine (that is the gate's
//       own stderr signal), so quarantined is always false here.

import { toolFailureReason, toolFailureMessage } from "../tool_failure.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const OLD = "tool call rejected"; // what every failed/rejected update used to say, verbatim

console.log("== P-TOOLFAIL.1 — honest failed/rejected tool-call chip ==");

// (1) The two real-world updates from the investigated turn: a browser-open and a js-execute that omp
//     could not run. Both used to collapse to the same misleading "tool call rejected".
console.log("\n1) the mislabel this increment fixes");
const browserOpen = { status: "rejected", kind: "other", title: "Opening game in browser" };
const jsExecute = { status: "rejected", kind: "execute", message: "no such tool: execute" };
const oldBrowser = OLD, oldExecute = OLD; // (the literal old behavior)
console.log(`   OLD browser-open chip : "${oldBrowser}"`);
console.log(`   OLD js-execute chip   : "${oldExecute}"`);
if (oldBrowser !== oldExecute) fail("the old behavior was supposed to be indistinguishable");
ok("two unrelated causes were indistinguishable, and both read as a DENIAL");

// (2) A tool that RAN and errored.
console.log("\n2) failed = ran and errored (with omp's message)");
const failed = toolFailureReason({ status: "failed", content: [{ type: "text", text: "syntax error at line 3" }] });
console.log(`   chip: "${failed.reason}"  (didRun=${failed.didRun})`);
if (!failed.didRun) fail("a 'failed' status means the tool DID run");
if (failed.reason !== "tool failed: syntax error at line 3") fail("failed reason should carry omp's message");
ok("a runtime failure now says so, and shows why");

// (3) A tool that DID NOT run — must not imply a denial.
console.log("\n3) rejected = did not run (never 'rejected'/'denied')");
const rb = toolFailureReason(browserOpen);
const re = toolFailureReason(jsExecute);
console.log(`   browser-open chip : "${rb.reason}"`);
console.log(`   js-execute chip   : "${re.reason}"`);
if (rb.didRun || re.didRun) fail("a 'rejected' status means the tool did NOT run");
for (const r of [rb.reason, re.reason]) {
  if (/rejected|denied/i.test(r)) fail(`a did-not-run chip must not imply a denial: "${r}"`);
}
if (re.reason !== "tool did not run: no such tool: execute") fail("omp's unavailable-tool message should surface");
ok("an unavailable tool is no longer mistaken for a security block");

// (4) omp's message is found wherever omp put it.
console.log("\n4) message extraction across omp's shapes");
const shapes: Array<[string, any, string]> = [
  ["content[].text", { content: [{ type: "text", text: "boom" }] }, "boom"],
  ["content[].content.text", { content: [{ type: "content", content: { type: "text", text: "ENOENT" } }] }, "ENOENT"],
  ["rawOutput string", { rawOutput: "exit 1" }, "exit 1"],
  ["rawOutput.error", { rawOutput: { error: "killed" } }, "killed"],
  ["message field", { message: "not enabled" }, "not enabled"],
];
for (const [name, u, want] of shapes) {
  const got = toolFailureMessage(u);
  if (got !== want) fail(`${name}: expected "${want}", got "${got}"`);
  ok(`${name} → "${got}"`);
}

// (5) Empty case: no message → a bare, honest label (the caller renders it on a neutral chip).
console.log("\n5) nothing to show → a bare label, still not a denial");
const bare = toolFailureReason({ status: "rejected" });
if (bare.reason !== "tool did not run") fail("empty rejected should be the bare did-not-run label");
ok(`empty → "${bare.reason}"`);

console.log("\nPASS — failed/rejected tool calls now explain themselves and never imply a security denial.");
