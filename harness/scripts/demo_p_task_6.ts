// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_task_6.ts
//
// P-TASK.6 (ADR-0398): the delegation card is back. omp 18 moved `agent` into each task item and renamed
// `assignment`/`id` to `task`/`name`, so LUCID's detector (top-level `agent` required) never fired and no
// card appeared. It also runs subagents as BACKGROUND jobs, so the card must stay live past the turn
// until its own runs finish. The card's icon is now a green-neon clipboard whose lines write in and out.
//
// Run: bun run harness/scripts/demo_p_task_6.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskCall, pendingLabel } from "../../desktop/turn_pending.ts";
import { delegationSettled, filterRunsForBatch, NO_RUNS_GRACE_MS, RUN_IDLE_MS } from "../../desktop/renderer/subagent_filter.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };
const DESKTOP = join(import.meta.dir, "..", "..", "desktop");

console.log("== #ADR-0398 P-TASK.6: the subagent fan-out card, for omp 18's task tool ==\n");

console.log("[1] omp 18's task input is recognized; other tools are not");
const batch = { context: "shared", tasks: [{ name: "SandboxScout", agent: "scout", task: "# Target\nmap the sandbox" }, { name: "FanoutScout", agent: "scout", task: "map the card" }] };
const items = parseTaskCall(batch);
ok(items?.length === 2 && items[0]!.agent === "scout" && items[0]!.name === "SandboxScout", "a batch with per-item agents and names");
ok(parseTaskCall({ task: "one job" })?.[0]?.agent === "task", "the single form, agent defaulting to task");
ok(parseTaskCall({ op: "done", task: "Ship it" }) === null, "a todo op carrying a `task` string is not a delegation");
ok(pendingLabel({ rawInput: batch }) === "subagent scout ×2", "the slow-turn notice names the subagents again");

console.log("\n[2] each card keeps only its own runs, by name");
const runs = [{ name: "SandboxScout", assignment: "x", done: true, lastAt: 0 }, { name: "FanoutScout", assignment: "y", done: false, lastAt: 0 }, { name: "Other", assignment: "z", done: false, lastAt: 0 }];
ok(filterRunsForBatch(runs, { names: items!.map((t) => t.name), assignments: ["a", "b"], soleCard: false }).map((r) => r.name).join() === "SandboxScout,FanoutScout", "the batch's two runs, not the third");

console.log("\n[3] the card stays live until its background runs finish");
const t = 1_000_000;
ok(!delegationSettled([{ done: true, lastAt: t }], null, t), "never settles while the turn runs");
ok(!delegationSettled([{ done: true, lastAt: t }, { done: false, lastAt: t }], t, t + 60_000), "turn ended, one run still working: still live");
ok(delegationSettled([{ done: true, lastAt: t }, { done: true, lastAt: t }], t, t + 1), "every run finished: settles");
ok(delegationSettled([{ done: false, lastAt: t }], t, t + RUN_IDLE_MS), "a run quiet for the idle limit no longer holds the card");
ok(delegationSettled([], t, t + NO_RUNS_GRACE_MS), "runs that never appear release the card after the grace");

console.log("\n[4] the clipboard icon ships in the source and the prebuilt bundle, the looker is gone");
const app = readFileSync(join(DESKTOP, "renderer", "app.ts"), "utf8");
const css = readFileSync(join(DESKTOP, "renderer", "styles.css"), "utf8");
const bundle = readFileSync(join(DESKTOP, "renderer", "app.bundle.js"), "utf8");
ok(app.includes("CLIPBOARD_SVG") && !app.includes("LOOKER_SVG"), "app.ts renders the clipboard");
ok(css.includes("@keyframes cbWrite") && !css.includes("@keyframes peer"), "styles.css animates the clipboard lines");
ok(bundle.includes("cb-line") && bundle.includes("delegationSettled") && !bundle.includes('class="looker"'), "app.bundle.js was rebuilt (dev.ts serves it, never the source)");

console.log("\nP-TASK.6 demo passed.");
