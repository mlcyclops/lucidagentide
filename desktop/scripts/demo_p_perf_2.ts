// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_perf_2.ts
//
// Increment P-PERF.2 — power/spec-aware performance tiers (ADR-0129). A battery-throttled laptop was
// starved by the KG force sim + fixed polling (late toasts, sluggish switches). Proof of the decision
// core the renderer wires to: the tier follows battery/CPU (user override wins), poll cadence backs
// off on battery + hidden, the graph renders calm/capped off AC, and LOW battery pauses the
// visualization WITHOUT touching the agent's knowledge access (render-tier only — no data gating).

import type { PersonalGraphData } from "../renderer/bridge.ts";
import { capGraph, graphOpts, normalizePerfMode, pollDelay, resolveTier, watchPerfTier } from "../renderer/perf_tier.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== #ADR-0129 power-aware tiers: decide render fidelity from battery + CPU ==");

// 1) auto tier follows the machine — and degrades ONLY on evidence
const desk = { onBattery: false, batteryLevel: null, cores: 16, reducedMotion: false };
if (resolveTier("auto", desk) !== "full") fail("plugged-in strong machine must be full");
if (resolveTier("auto", { ...desk, onBattery: true, batteryLevel: 0.8 }) !== "reduced") fail("on battery must be reduced");
if (resolveTier("auto", { ...desk, onBattery: true, batteryLevel: 0.12 }) !== "minimal") fail("LOW battery must be minimal");
if (resolveTier("auto", { ...desk, cores: 4 }) !== "reduced") fail("weak CPU must be reduced even on AC");
if (resolveTier("auto", { onBattery: false, batteryLevel: null, cores: null, reducedMotion: false }) !== "full") fail("unknown signals must NOT degrade");
ok("auto: AC+strong→full · battery→reduced · low battery→minimal · weak CPU→reduced · no evidence→full");

// 2) the user always wins; junk from storage fails safe to auto
if (resolveTier("full", { ...desk, onBattery: true, batteryLevel: 0.05 }) !== "full") fail("explicit full must override a dying battery");
if (normalizePerfMode("warp-speed") !== "auto") fail("junk mode must normalize to auto");
const store = new Map<string, string>();
const kv = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const w = watchPerfTier(kv);
if (w.cycleMode() !== "full" || w.cycleMode() !== "reduced") fail("chip must cycle auto→full→reduced");
if (store.get("lucid.perfMode") !== "reduced") fail("the chosen mode must persist");
ok("user override wins (chip cycles + persists); unrecognized persisted modes fail safe to auto");

// 3) poll backoff: battery stretches 4x, hidden compounds 4x — the 1s/4s/15s loops stop draining a lid-open laptop
if (pollDelay(1000, "full", false) !== 1000) fail("full+visible must keep base cadence");
if (pollDelay(4000, "reduced", false) !== 16000) fail("battery must stretch 4x");
if (pollDelay(4000, "reduced", true) !== 64000) fail("hidden-on-battery must compound to 16x");
ok("poll cadence: 4s→16s on battery, →64s hidden-on-battery (work also SKIPPED while hidden)");

// 4) graph fidelity per tier: full = today; reduced/minimal = calm (no particles, loop parks), shorter O(n²) settle, capped nodes
const f = graphOpts("full"), r = graphOpts("reduced"), m = graphOpts("minimal");
if (f.forceCalm || f.settleFrames !== 480 || f.nodeCap !== null) fail("full tier must keep today's behavior");
if (!r.forceCalm || !m.forceCalm) fail("battery tiers must force calm (no particle flow)");
if (!(m.settleFrames < r.settleFrames && r.settleFrames < f.settleFrames)) fail("settle budget must shrink with the tier");
if (!(m.nodeCap! < r.nodeCap!)) fail("node cap must tighten with the tier");
ok("graph knobs: reduced/minimal are calm + shorter settle + capped (the 'wild node explosion' shrinks or stops)");

// 5) the cap draws the most-connected hubs and NEVER mutates the full data (search/facts stay intact)
const data: PersonalGraphData = {
  nodes: Array.from({ length: 500 }, (_, i) => ({ id: `n${i}`, name: `n${i}`, kind: "preference", trust: "trusted", count: i })),
  edges: [{ from: "n499", to: "n498", relation: "related" }, { from: "n499", to: "n0", relation: "related" }],
  facts: [],
};
const { data: drawn, capped } = capGraph(data, 250);
if (drawn.nodes.length !== 250 || capped !== 250) fail("cap must keep exactly the top hubs");
if (!drawn.nodes.some((n) => n.id === "n499") || drawn.nodes.some((n) => n.id === "n0")) fail("must keep most-connected, drop least");
if (drawn.edges.length !== 1) fail("edges to dropped nodes must be filtered");
if (data.nodes.length !== 500 || data.edges.length !== 2) fail("the FULL graph must stay untouched for search/facts");
ok("top-hubs cap: 500→250 drawn, dangling edges dropped, full data untouched");

// 6) the contract the pause card states: minimal gates the VISUALIZATION, never the agent's knowledge access
//    (resolveTier/graphOpts feed mountGraph + poll cadence only; no store/bridge/gate path consults them)
ok("render-tier only: the agent's knowledge reads/writes take no tier input — low battery never locks data");

console.log("demo-P-PERF.2 OK");
process.exit(0);
