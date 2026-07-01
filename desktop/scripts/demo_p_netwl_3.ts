// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_netwl_3.ts — P-NETWL.3 (ADR-0106): ENFORCE the trust scopes (project / loop) and
// the per-loop call budget that P-NETWL.1 only stored. Hermetic: drives the REAL policy code
// (egressWhitelistEntry + withinCallBudget) with an injected store + managed ceiling + context; touches no
// user files. The stateful per-loop counter is reproduced here exactly as acp_backend does it (a Map keyed by
// host, reset per loop).
//
// Proves:
//   (1) a `project`-scoped entry auto-allows ONLY in its own workspace (path normalized), nowhere else;
//   (2) a `loop`-scoped entry auto-allows ONLY inside a goal loop;
//   (3) `always` still auto-allows in any context;
//   (4) a per-entry callBudget caps auto-allowed calls PER LOOP: the first N pass, then it blocks;
//   (5) the enterprise-managed ceiling still WINS over any scoped entry (fail-closed).

import { egressWhitelistEntry } from "../egress_policy.ts";
import { emptyStore, upsertEntry, withinCallBudget, type WhitelistEntry, type WhitelistStore } from "../network_whitelist.ts";
import type { ManagedEgressPolicy } from "../managed_config.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const entry = (o: Partial<WhitelistEntry> & Pick<WhitelistEntry, "id" | "pattern">): WhitelistEntry =>
  ({ kind: "domain", zone: "external", scope: "always", ...o });
const allows = (store: WhitelistStore, url: string, ctx?: { project?: string | null; loop?: boolean }, managed?: ManagedEgressPolicy) =>
  !!egressWhitelistEntry(store, url, managed, ctx);

console.log("== P-NETWL.3 — enforce project / loop scope + per-loop call budget ==");

let store: WhitelistStore = emptyStore();
store = upsertEntry(store, entry({ id: "proj", pattern: "*.staging.local", zone: "internal", scope: "project", project: "C:/work/app" }));
store = upsertEntry(store, entry({ id: "loop", pattern: "*.bing.com", scope: "loop" }));
store = upsertEntry(store, entry({ id: "always", pattern: "*.githubusercontent.com", scope: "always" }));
store = upsertEntry(store, entry({ id: "budget", pattern: "api.example.com", scope: "loop", callBudget: 3 }));

console.log("\n1) project scope grants ONLY in its own workspace (path normalized)");
if (!allows(store, "https://web.staging.local/x", { project: "C:/work/app" })) fail("project entry should grant in its workspace");
if (!allows(store, "https://web.staging.local/x", { project: "C:/WORK/app/" })) fail("project match should be case- + trailing-slash-insensitive");
if (allows(store, "https://web.staging.local/x", { project: "C:/work/other" })) fail("project entry must NOT grant in a different workspace");
if (allows(store, "https://web.staging.local/x")) fail("project entry must NOT grant with no project context");
ok("`project` grants in C:/work/app (any case/slash), denies elsewhere and with no context");

console.log("\n2) loop scope grants ONLY inside a goal loop");
if (!allows(store, "https://www.bing.com/s", { loop: true })) fail("loop entry should grant inside a loop");
if (allows(store, "https://www.bing.com/s", { loop: false })) fail("loop entry must NOT grant outside a loop");
if (allows(store, "https://www.bing.com/s")) fail("loop entry must NOT grant with no loop context");
ok("`loop` grants only when ctx.loop is true");

console.log("\n3) always grants in any context");
if (!allows(store, "https://raw.githubusercontent.com/x")) fail("always should grant with no context");
if (!allows(store, "https://raw.githubusercontent.com/x", { loop: true, project: "C:/anything" })) fail("always should grant in any context");
ok("`always` grants regardless of project/loop");

console.log("\n4) a per-entry callBudget caps auto-allowed calls PER LOOP (first N pass, then blocked)");
// Reproduce acp_backend's per-loop accounting exactly: a Map<host,count>, reset per loop.
const loopHostCalls = new Map<string, number>();
const HOST = "api.example.com";
const budget = 3;
const outcomes: string[] = [];
for (let call = 1; call <= 5; call++) {
  const matched = allows(store, "https://api.example.com/x", { loop: true }); // scope satisfied inside a loop
  const used = loopHostCalls.get(HOST) ?? 0;
  const auto = matched && withinCallBudget(used, budget);
  if (auto) { loopHostCalls.set(HOST, used + 1); outcomes.push("allow"); }
  else outcomes.push("block");
}
if (outcomes.join(",") !== "allow,allow,allow,block,block") fail(`budget of 3 should allow 3 then block: got ${outcomes.join(",")}`);
ok(`budget 3 → ${outcomes.join(" ")} (auto-allow exhausts, then falls through to the gate)`);
// A fresh loop resets the counter.
loopHostCalls.clear();
if (!(allows(store, "https://api.example.com/x", { loop: true }) && withinCallBudget(loopHostCalls.get(HOST) ?? 0, budget))) fail("a new loop must reset the budget");
ok("a new loop resets the per-host counter");

console.log("\n5) the managed ceiling still WINS over a scoped entry (fail-closed)");
const denied: ManagedEgressPolicy = { deniedHosts: ["web.staging.local"] };
if (allows(store, "https://web.staging.local/x", { project: "C:/work/app" }, denied)) fail("a managed-denied host must never be granted, even by a matching project entry");
ok("managed deny beats a project-scoped user allow");

console.log("\nPASS — project/loop scopes and the per-loop call budget are enforced, under the managed ceiling.");
