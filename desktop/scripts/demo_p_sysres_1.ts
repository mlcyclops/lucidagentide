// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-SYSRES.1 — the system resource guard (ADR-0182). On a weak processor that is already
// pegged (or nearly out of RAM), the app's two big CPU spikes - the KG force simulation and the Code
// Graph AST ingest - are paused behind a notice that says WHY, shows the machine, and lists the top
// resource-consuming processes so the user knows what to close. Fail-open: no evidence never blocks.
//
// Run with: bun run desktop/scripts/demo_p_sysres_1.ts

import { assessSystem, sampleSystem, topProcesses, type SystemSnapshot } from "../system_profile.ts";
import { guardBlockedHtml, isSystemStatus, machineLine, resourcePanelBodyHtml } from "../renderer/system_guard.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}
const snap = (over: Partial<SystemSnapshot>): SystemSnapshot => ({
  cpuModel: "Demo CPU", cores: 8, speedMHz: 3200, cpuBusyPct: 20, memTotalMB: 16384, memFreeMB: 8000, ...over,
});

console.log("== #ADR-0182 P-SYSRES.1: the system resource guard ==\n");

console.log("[1] the verdict: weak CPU under load → blocked; a strong machine shrugs the same load off");
const weakHot = assessSystem(snap({ cores: 4, speedMHz: 2500, cpuBusyPct: 92, memFreeMB: 1100 }));
assert(weakHot.level === "blocked" && weakHot.reasons.length >= 2, "4-core laptop at 92% CPU + 1.1 GB free → blocked, with reasons");
assert(assessSystem(snap({ cpuBusyPct: 88 })).level === "strained", "the same CPU pressure on an 8-core desktop is only 'strained' (never blocked)");
assert(assessSystem(snap({ cpuBusyPct: 97 })).level === "blocked", "critical CPU (97%) blocks even a strong machine");

console.log("\n[2] fail-open is the contract: a UX guard must never block on missing evidence");
const dead = await sampleSystem({ cpus: () => { throw new Error("no os"); }, totalmem: () => 0, freemem: () => 0, sleep: async () => {} }, 0);
assert(assessSystem(dead).level === "ok", "a failed sample reads as 'ok' - the guard blocks on evidence, never on error");
assert(isSystemStatus({ snap: {}, verdict: { level: "??" }, procs: [] }) === false, "a malformed payload is rejected → renderer treats it as null → no block");

console.log("\n[3] the notice: names the paused feature, says why, offers the panel + re-check - and NO escape hatch");
const status = { snap: snap({ cores: 4, cpuBusyPct: 92, memFreeMB: 1100 }), verdict: weakHot, procs: [{ name: "chrome", count: 24, memMB: 3800, cpuSec: 1200 }] };
const card = guardBlockedHtml(status, "code graph");
assert(card.includes("The code graph is paused") && card.includes("data-sys-panel") && card.includes("data-sys-recheck"),
  "blocked card: feature named, 'Show what's using resources' + 'Re-check' offered");
assert(!card.includes("Render anyway"), "unlike the battery pause (P-PERF.2), there is no 'render anyway' at the blocked line");
const body = resourcePanelBodyHtml(status);
assert(body.includes("chrome") && body.includes("×24") && body.includes("3.7 GB"), "the panel lists high-resource processes aggregated by name (chrome ×24 · 3.7 GB)");
assert(guardBlockedHtml({ ...status, procs: [{ name: "<img src=x>", count: 1, memMB: 9, cpuSec: null }], verdict: { ...weakHot, reasons: ["<script>x</script>"] } }, "kg").includes("&lt;script&gt;"),
  "every external string (reasons, process names, CPU model) renders escaped");

console.log("\n[4] LIVE (informational): THIS machine, right now");
const live = await sampleSystem();
const verdict = assessSystem(live);
console.log(`  info  ${machineLine(live) || "(no profile available)"} → ${verdict.level}`);
for (const p of topProcesses(process.platform, undefined, 5)) {
  console.log(`        - ${p.name}${p.count > 1 ? ` ×${p.count}` : ""} · ${p.memMB} MB${p.cpuSec !== null ? ` · ${p.cpuSec}s CPU` : ""}`);
}

console.log("\n✓ P-SYSRES.1 demo passed — heavy builds wait politely when the machine can't afford them, and the user sees what to close.");
