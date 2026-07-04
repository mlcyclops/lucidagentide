// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-PERF.2 (ADR-0129): the tier decision + backoff math must be provable headlessly - a wrong
// decision here either burns a battery (too much work) or degrades a desktop for no reason.

import { describe, expect, test } from "bun:test";
import type { PersonalGraphData } from "./bridge.ts";
import { capGraph, graphOpts, normalizePerfMode, pollDelay, resolveTier, watchPerfTier } from "./perf_tier.ts";

const AC = { onBattery: false, batteryLevel: null, cores: 16, reducedMotion: false };

describe("resolveTier - auto follows the machine", () => {
  test("plugged-in strong machine → full", () => {
    expect(resolveTier("auto", AC)).toBe("full");
  });
  test("on battery → reduced", () => {
    expect(resolveTier("auto", { ...AC, onBattery: true, batteryLevel: 0.8 })).toBe("reduced");
  });
  test("LOW battery while discharging → minimal", () => {
    expect(resolveTier("auto", { ...AC, onBattery: true, batteryLevel: 0.15 })).toBe("minimal");
  });
  test("low level while CHARGING is not minimal (plugged in = safe)", () => {
    expect(resolveTier("auto", { ...AC, batteryLevel: 0.1 })).toBe("full");
  });
  test("weak CPU degrades even on AC", () => {
    expect(resolveTier("auto", { ...AC, cores: 4 })).toBe("reduced");
  });
  test("OS reduced-motion → reduced", () => {
    expect(resolveTier("auto", { ...AC, reducedMotion: true })).toBe("reduced");
  });
  test("unknown signals never degrade (no battery API, no cores)", () => {
    expect(resolveTier("auto", { onBattery: false, batteryLevel: null, cores: null, reducedMotion: false })).toBe("full");
  });
  test("explicit user mode always wins over signals", () => {
    expect(resolveTier("full", { ...AC, onBattery: true, batteryLevel: 0.05 })).toBe("full");
    expect(resolveTier("minimal", AC)).toBe("minimal");
  });
});

describe("normalizePerfMode - fail-safe", () => {
  test("valid modes round-trip; junk/null/undefined → auto", () => {
    expect(normalizePerfMode("reduced")).toBe("reduced");
    expect(normalizePerfMode("banana")).toBe("auto");
    expect(normalizePerfMode(null)).toBe("auto");
    expect(normalizePerfMode(undefined)).toBe("auto");
  });
});

describe("pollDelay - battery + hidden backoff", () => {
  test("full tier, visible = base cadence", () => {
    expect(pollDelay(4000, "full", false)).toBe(4000);
  });
  test("battery tiers stretch 4x; hidden compounds 4x more", () => {
    expect(pollDelay(4000, "reduced", false)).toBe(16000);
    expect(pollDelay(1000, "minimal", false)).toBe(4000);
    expect(pollDelay(4000, "full", true)).toBe(16000);
    expect(pollDelay(4000, "reduced", true)).toBe(64000);
  });
});

describe("graphOpts - per-tier render knobs", () => {
  test("full keeps today's behavior (no calm, 480 settle, uncapped)", () => {
    expect(graphOpts("full")).toEqual({ forceCalm: false, settleFrames: 480, nodeCap: null });
  });
  test("reduced + minimal are calm with shorter settle and a cap", () => {
    const r = graphOpts("reduced"), m = graphOpts("minimal");
    expect(r.forceCalm && m.forceCalm).toBe(true);
    expect(r.settleFrames).toBeLessThan(480);
    expect(m.settleFrames).toBeLessThan(r.settleFrames);
    expect(r.nodeCap).not.toBeNull();
    expect(m.nodeCap!).toBeLessThan(r.nodeCap!);
  });
});

describe("capGraph - top-hubs cap, snapshot-safe", () => {
  const data: PersonalGraphData = {
    nodes: [
      { id: "a", name: "a", kind: "preference", trust: "trusted", count: 9 },
      { id: "b", name: "b", kind: "preference", trust: "trusted", count: 5 },
      { id: "c", name: "c", kind: "preference", trust: "trusted", count: 1 },
    ],
    edges: [
      { from: "a", to: "b", relation: "related" },
      { from: "b", to: "c", relation: "related" },
    ],
    facts: [],
  };
  test("keeps the most-connected nodes and drops dangling edges", () => {
    const { data: out, capped } = capGraph(data, 2);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(out.edges).toEqual([{ from: "a", to: "b", relation: "related" }]);
    expect(capped).toBe(1);
  });
  test("does not mutate the input (rollback/search safety)", () => {
    capGraph(data, 1);
    expect(data.nodes).toHaveLength(3);
    expect(data.edges).toHaveLength(2);
  });
  test("null cap or small graph = identity, capped 0", () => {
    expect(capGraph(data, null).capped).toBe(0);
    expect(capGraph(data, 10).data.nodes).toHaveLength(3);
  });
});

describe("watchPerfTier - persisted user mode", () => {
  const mem = (): { store: Map<string, string>; kv: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } } => {
    const store = new Map<string, string>();
    return { store, kv: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) } };
  };
  test("cycles auto → full → reduced → minimal → auto and persists each step", () => {
    const { store, kv } = mem();
    const w = watchPerfTier(kv);
    expect(w.mode()).toBe("auto");
    expect(w.cycleMode()).toBe("full");
    expect(w.cycleMode()).toBe("reduced");
    expect(store.get("lucid.perfMode")).toBe("reduced");
    expect(w.cycleMode()).toBe("minimal");
    expect(w.cycleMode()).toBe("auto");
  });
  test("a persisted override is honored on construction; junk falls back to auto", () => {
    const { kv } = mem();
    kv.setItem("lucid.perfMode", "minimal");
    expect(watchPerfTier(kv).tier()).toBe("minimal");
    kv.setItem("lucid.perfMode", "warp-speed");
    expect(watchPerfTier(kv).mode()).toBe("auto");
  });
  test("mode changes notify subscribers", () => {
    const { kv } = mem();
    const w = watchPerfTier(kv);
    const seen: string[] = [];
    w.onChange((t, m) => seen.push(`${m}:${t}`));
    w.cycleMode();
    expect(seen).toEqual(["full:full"]);
  });
});
