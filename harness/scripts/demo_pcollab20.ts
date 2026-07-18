// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pcollab20.ts
//
// P-COLLAB.20 (ADR-0242): the Join panel is a floating DOCK - watch (or drive, with an edit link) another
// LUCID while fully using your own. Headless proof of the pure chassis it runs on: the join dock persists
// its geometry under its OWN key (independent of the Share dock), first-open lands bottom-LEFT beside the
// rails (never stacked on the share dock's bottom-right default), a stored shape beats the fallback and is
// re-clamped to the live viewport, and minimize state round-trips. The pointer wiring (drag/resize/snap) is
// the SAME code the Share dock has run since P-SHARE.1.
//
// Run with: bun run harness/scripts/demo_pcollab20.ts

import { defaultShape, loadDockState, saveDockState, snapDecision, JOIN_DOCK_KEY, type DockStorage, type DockState } from "../../desktop/renderer/share_dock.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }
const mem = (): DockStorage => { const m = new Map<string, string>(); return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); } }; };

console.log("P-COLLAB.20 demo - the Join dock: watch another LUCID while using yours\n");

const VW = 1440, VH = 900, RAIL = 56;
const storage = mem();

// [1] first open: the join dock lands bottom-LEFT (beside the rails), the share dock bottom-RIGHT
const joinFallback = { ...defaultShape(VW, VH), x: RAIL + 12 };
const join = loadDockState(storage, VW, VH, JOIN_DOCK_KEY, joinFallback);
const share = loadDockState(storage, VW, VH);
if (join.shape.x !== RAIL + 12) fail("the join dock must land beside the rails");
if (share.shape.x <= VW / 2) fail("the share dock default must stay bottom-right");
if (join.shape.x + join.shape.w >= share.shape.x) fail("the two docks' defaults must not stack");
ok(`independent defaults: join at x=${join.shape.x} (beside the rails), share at x=${share.shape.x} (bottom-right)`);

// [2] independent persistence: moving one never moves the other
saveDockState(storage, { ...join, shape: { ...join.shape, x: 500 }, side: "float" }, JOIN_DOCK_KEY);
saveDockState(storage, { ...share, side: "right" });
if (loadDockState(storage, VW, VH, JOIN_DOCK_KEY).shape.x !== 500) fail("the join dock lost its move");
if (loadDockState(storage, VW, VH).side !== "right" || loadDockState(storage, VW, VH, JOIN_DOCK_KEY).side !== "float") fail("dock sides bled between keys");
ok("independent persistence: each dock keeps its own geometry + snap side");

// [3] a restored shape re-clamps to a SMALLER live viewport (external monitor unplugged)
const clamped = loadDockState(storage, 900, 620, JOIN_DOCK_KEY);
if (clamped.shape.x + clamped.shape.w > 900 - 12 + 1) fail("a restored shape must re-clamp on-screen");
ok("a restored join dock re-clamps to the live viewport (monitor changes survive)");

// [4] minimize state round-trips (the pill keeps watching; restore brings the dock back where it was)
const min: DockState = { ...loadDockState(storage, VW, VH, JOIN_DOCK_KEY), minimized: true };
saveDockState(storage, min, JOIN_DOCK_KEY);
if (!loadDockState(storage, VW, VH, JOIN_DOCK_KEY).minimized) fail("minimized must round-trip");
ok("minimize-to-pill state round-trips under the join key");

// [5] the join dock snaps with the SAME geometry rules as the share dock (one chassis)
const snap = snapDecision({ x: VW - 380, y: 300, w: 372, h: 460 }, VW, VH, RAIL);
if (snap.side !== "right") fail("a right-edge drop must snap right");
const left = snapDecision({ x: RAIL + 10, y: 300, w: 372, h: 460 }, VW, VH, RAIL);
if (left.side !== "left" || left.shape.x < RAIL) fail("a left-edge drop must snap BESIDE the rails, never under them");
ok("one chassis: the join dock snaps flush-right / beside-the-rails exactly like the share dock");

console.log("\nP-COLLAB.20 demo complete - a movable, resizable, minimizable, NON-BLOCKING join dock with its own persisted geometry; drive a remote LUCID (edit link) while managing your own. Multi-join orchestration (N docks over N guest slots) is P-COLLAB.21.");
process.exit(0);
