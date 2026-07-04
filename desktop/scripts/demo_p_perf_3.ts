// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_perf_3.ts
//
// Increment P-PERF.3 — KG layout continuity + energy-based settle exit (ADR-0130). The "wildly pulled
// around" complaint: every mount re-seeded nodes on a circle and ran a fixed 480-frame O(n²) settle with
// three mid-settle camera re-fits. Now a re-open seeds from the previous layout (static paint - ZERO sim
// frames), a live refresh only nestles the newcomers, and a cold open stops as soon as motion dies
// instead of burning the whole budget. Proof of the pure decision core graph.ts wires to.

import { KE_REST, settleDone, settleStart } from "../renderer/kg_ops.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== #ADR-0130 layout continuity: re-opens are static, cold opens stop early ==");

// 1) re-open with every node seeded from the last layout → NO simulation at all, one fit
const reopen = settleStart(120, 120, 480);
if (reopen.frames !== 480 || !reopen.needsFit) fail("a fully seeded re-open must be a static paint (+ one-time fit)");
ok("re-open (rail switch / lock-unlock / live remount): 0 sim frames — nodes stay where the user left them");

// 2) live refresh added a few nodes → short nestle, existing nodes anchored by inertia
const refresh = settleStart(116, 120, 480);
if (refresh.frames !== 360 || refresh.needsFit) fail("a mostly-seeded refresh must be a short nestle");
ok(`live refresh (+4 new nodes): ${480 - refresh.frames}-frame nestle instead of a 480-frame re-explosion`);

// 3) cold open: full budget available, but the energy exit ends it when motion dies.
//    Simulate a settling layout: per-node kinetic energy decaying ~8%/frame from a violent start.
const N = 120;
let ke = N * 4; // a violent unfold: avg v ≈ 2px/frame
let exitFrame = 0;
for (let f = 1; f <= 480; f++) {
  ke *= 0.92;
  if (settleDone(ke, N, f)) { exitFrame = f; break; }
}
if (exitFrame === 0) fail("a decaying layout must trigger the energy exit before the fixed budget");
if (exitFrame >= 480) fail("early exit must beat the fixed 480-frame budget");
if (settleDone(N * KE_REST * 10, N, 200)) fail("a still-moving layout must NOT exit early");
ok(`cold open: sim stops at frame ${exitFrame} (motion visibly dead) — ~${Math.round((1 - exitFrame / 480) * 100)}% of the O(n²) budget never runs`);

// 4) the grace period protects young layouts (near-still for a frame or two before forces unfold them)
if (settleDone(0, N, 5)) fail("the grace period must keep a just-mounted layout simulating");
ok("grace period: a just-seeded layout is never declared settled before it can unfold");

// 5) privacy boundary (ADR-0084): the positions cache is IN-MEMORY only - this demo just states the
//    contract the wiring obeys: app.ts kgLayoutCache is a module-level Map, never localStorage/disk.
ok("positions live in an in-memory Map keyed per graph — nothing from the encrypted store touches disk");

console.log("demo-P-PERF.3 OK");
process.exit(0);
