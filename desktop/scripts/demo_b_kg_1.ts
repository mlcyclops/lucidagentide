// desktop/scripts/demo_b_kg_1.ts
//
// Increment B-KG.1 — Knowledge-graph interaction polish (issues #112/#113/#114). Three proofs against
// the pure decision cores that the renderer wires to (kg_ops.ts):
//   #112  a LARGE imported graph now fits the panel (the old 0.4 min-scale floor would have overflowed)
//   #114  an idle, settled graph stops doing the expensive per-frame repaint (and halts under reduced-motion)
//   #113  "forget" removes the fact (and its now-empty node + edges) INSTANTLY, without mutating the source

import type { PersonalGraphData } from "../renderer/bridge.ts";
import { applyForget, fitTransform, frameWork } from "../renderer/kg_ops.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

// ── #112: zoom-to-fit on open ────────────────────────────────────────────────
console.log("== [1/3] #112 large graph fits the panel ==");
const W = 800, H = 600;
const bigBox = { minX: -2000, minY: -1500, maxX: 2000, maxY: 1500 }; // 4000×3000, like a big import
const fit = fitTransform(bigBox, W, H);
if (!fit) fail("expected a fit transform for a sized viewport");
const OLD_FLOOR = 0.4; // the pre-fix Math.max(0.4, …) clamp
if (fit!.sc >= OLD_FLOOR) fail(`scale ${fit!.sc} would NOT have escaped the old ${OLD_FLOOR} floor → overflow`);
const fitsW = (bigBox.maxX - bigBox.minX) * fit!.sc <= W;
const fitsH = (bigBox.maxY - bigBox.minY) * fit!.sc <= H;
if (!fitsW || !fitsH) fail("graph still overflows the viewport at the computed scale");
if (Math.abs(fit!.tx - W / 2) > 1e-6 || Math.abs(fit!.ty - H / 2) > 1e-6) fail("graph not centered");
ok(`scale ${fit!.sc.toFixed(3)} (< old ${OLD_FLOOR} floor), centered, fits ${W}×${H}`);
if (fitTransform(bigBox, 0, 0) !== null) fail("a 0×0 viewport must yield null (never center onto nothing)");
ok("0×0 viewport → null (no off-screen center before layout)");

// ── #114: idle CPU ───────────────────────────────────────────────────────────
console.log("== [2/3] #114 idle graph stops burning CPU ==");
const moving = frameWork({ simActive: true, easing: false, calm: false, parity: 0 });
if (!moving.layout) fail("a moving sim must still do the full layout repaint");
const idleEven = frameWork({ simActive: false, easing: false, calm: false, parity: 0 });
const idleOdd = frameWork({ simActive: false, easing: false, calm: false, parity: 1 });
if (idleEven.layout || idleOdd.layout) fail("idle frames must skip the expensive layout repaint");
if (!(idleEven.particles && !idleOdd.particles)) fail("idle particles must throttle to ~30fps (every other frame)");
ok("idle: layout repaint skipped, particles throttled to ~30fps (look preserved)");
const calmIdle = frameWork({ simActive: false, easing: false, calm: true, parity: 0 });
if (!calmIdle.stop) fail("reduced-motion + idle must HALT the loop");
ok("reduced-motion + idle → loop halts (≈0% CPU until interaction)");

// ── #113: instant, snapshot-safe forget ──────────────────────────────────────
console.log("== [3/3] #113 forget is instant + snapshot-safe ==");
const graph: PersonalGraphData = {
  nodes: [
    { id: "n1", name: "Rust", kind: "preference", trust: "trusted", count: 2 },
    { id: "n2", name: "Vim", kind: "behavior", trust: "trusted", count: 1 },
  ],
  edges: [{ from: "n1", to: "n2", relation: "related" }],
  facts: [
    { id: "f1", entity_id: "n1", statement: "likes Rust", scope: "personal", trust: "trusted", confidence: 0.9, at: "t" },
    { id: "f2", entity_id: "n1", statement: "prefers Rust over Go", scope: "personal", trust: "trusted", confidence: 0.8, at: "t" },
    { id: "f3", entity_id: "n2", statement: "uses Vim", scope: "personal", trust: "trusted", confidence: 0.95, at: "t" },
  ],
};

const one = applyForget(graph, "f1");
if (one.nodeRemoved !== null) fail("removing one of n1's two facts must KEEP the node");
if (one.data.nodes.find((n) => n.id === "n1")!.count !== 1) fail("node count must decrement to 1");
ok("forgetting 1 of 2 facts keeps the node, count 2 → 1");

const last = applyForget(graph, "f3");
if (last.nodeRemoved !== "n2") fail("removing n2's only fact must drop the node");
if (last.data.nodes.some((n) => n.id === "n2")) fail("node n2 should be gone");
if (last.data.edges.length !== 0) fail("the n1→n2 edge should be removed with n2");
ok("forgetting a node's LAST fact drops the node + its dangling edge");

if (graph.nodes.length !== 2 || graph.edges.length !== 1 || graph.facts.length !== 3) fail("input graph was mutated");
if (graph.nodes.find((n) => n.id === "n1")!.count !== 2) fail("input node count was mutated");
ok("input graph untouched → caller can roll back if the server refuses");

console.log("demo-B-KG.1 OK");
process.exit(0);
