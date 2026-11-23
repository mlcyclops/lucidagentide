// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-PERF.2 (ADR-0129): the tier decision + backoff math must be provable headlessly - a wrong
// decision here either burns a battery (too much work) or degrades a desktop for no reason.

import { describe, expect, test } from "bun:test";
import type { PersonalGraphData } from "./bridge.ts";
import type { GpuProbe } from "./gpu_probe.ts";
import {
  baseTier, capGraph, capTier, createFrameGovernor, GOVERNOR_MISS_SHARE, GOVERNOR_SETTLE_MS, GOVERNOR_SLACK, GOVERNOR_WINDOW_MS,
  graphOpts, normalizePerfMode, pollDelay, resolveTier, stepDownTier, watchPerfTier, type PerfTier, type PerfTierWatcher,
} from "./perf_tier.ts";
import type { KVStore } from "./swr_cache.ts";

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
  test("cycles auto → full → reduced → minimal → ultra → cinematic → auto and persists each step", () => {
    const { store, kv } = mem();
    const w = watchPerfTier(kv);
    expect(w.mode()).toBe("auto");
    expect(w.cycleMode()).toBe("full");
    expect(w.cycleMode()).toBe("reduced");
    expect(store.get("lucid.perfMode")).toBe("reduced");
    expect(w.cycleMode()).toBe("minimal");
    expect(w.cycleMode()).toBe("ultra");
    expect(w.tier()).toBe("ultra");
    expect(w.cycleMode()).toBe("cinematic");
    expect(store.get("lucid.perfMode")).toBe("cinematic");
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

// P-VIZ.GPU1 (ADR-0651): the GPU class joins the auto decision; ultra and cinematic sit above full.
describe("resolveTier - the GPU matrix", () => {
  const gpu = (g: "software" | "integrated" | "discrete" | null) => ({ ...AC, gpu: g });
  test("software GPU → minimal, whatever the rest of the machine", () => {
    expect(resolveTier("auto", gpu("software"))).toBe("minimal");
  });
  test("integrated GPU → full on a strong plugged-in machine, reduced on battery or few cores", () => {
    expect(resolveTier("auto", gpu("integrated"))).toBe("full");
    expect(resolveTier("auto", { ...gpu("integrated"), onBattery: true, batteryLevel: 0.8 })).toBe("reduced");
    expect(resolveTier("auto", { ...gpu("integrated"), cores: 4 })).toBe("reduced");
  });
  test("discrete GPU on AC → ultra; on battery it follows the battery rules", () => {
    expect(resolveTier("auto", gpu("discrete"))).toBe("ultra");
    expect(resolveTier("auto", { ...gpu("discrete"), onBattery: true, batteryLevel: 0.8 })).toBe("reduced");
    expect(resolveTier("auto", { ...gpu("discrete"), onBattery: true, batteryLevel: 0.1 })).toBe("minimal");
    expect(resolveTier("auto", { ...gpu("discrete"), reducedMotion: true })).toBe("reduced");
  });
  test("an unknown GPU never degrades and auto never picks cinematic", () => {
    expect(resolveTier("auto", gpu(null))).toBe("full");
    expect(resolveTier("auto", AC)).toBe("full");
    for (const g of ["software", "integrated", "discrete", null] as const) expect(resolveTier("auto", gpu(g))).not.toBe("cinematic");
  });
  test("an explicit tier always wins over the GPU", () => {
    expect(resolveTier("cinematic", gpu("software"))).toBe("cinematic");
    expect(resolveTier("ultra", { ...gpu("integrated"), onBattery: true, batteryLevel: 0.05 })).toBe("ultra");
    expect(resolveTier("minimal", gpu("discrete"))).toBe("minimal");
  });
});

describe("tier helpers - step down, cap, base tier, new modes", () => {
  test("stepDownTier walks cinematic → ultra → full → reduced → minimal and stops", () => {
    const seen: string[] = [];
    let t: PerfTier = "cinematic";
    for (let i = 0; i < 5; i++) { seen.push(t); t = stepDownTier(t); }
    expect(seen).toEqual(["cinematic", "ultra", "full", "reduced", "minimal"]);
    expect(stepDownTier("minimal")).toBe("minimal");
  });
  test("capTier never raises a tier", () => {
    expect(capTier("ultra", "full")).toBe("full");
    expect(capTier("reduced", "full")).toBe("reduced");
    expect(capTier("cinematic", null)).toBe("cinematic");
  });
  test("ultra and cinematic are full to everything outside Visualize", () => {
    expect(baseTier("ultra")).toBe("full");
    expect(baseTier("cinematic")).toBe("full");
    expect(baseTier("reduced")).toBe("reduced");
    expect(pollDelay(4000, "ultra", false)).toBe(4000);
    expect(pollDelay(4000, "cinematic", true)).toBe(16000);
    expect(graphOpts("ultra")).toEqual(graphOpts("full"));
    expect(graphOpts("cinematic")).toEqual(graphOpts("full"));
  });
  test("the new modes round-trip through normalizePerfMode", () => {
    expect(normalizePerfMode("ultra")).toBe("ultra");
    expect(normalizePerfMode("cinematic")).toBe("cinematic");
  });
});

describe("createFrameGovernor - the 3 s frame-time check", () => {
  const BUDGET = 1000 / 60;
  /** Feed `ms`-long frames from `start` until a verdict (or 20 s). */
  const run = (start: number, ms: number): { verdict: string; at: number } => {
    const g = createFrameGovernor(start);
    let now = start;
    while (now < start + 20000) {
      now += ms;
      const v = g.sample(now, ms, BUDGET);
      if (v !== "pending") return { verdict: v, at: now - start };
    }
    return { verdict: g.verdict(), at: now - start };
  };
  test("a scene that holds its budget passes after settle + 3 s", () => {
    const r = run(0, BUDGET);
    expect(r.verdict).toBe("ok");
    expect(r.at).toBeGreaterThanOrEqual(GOVERNOR_SETTLE_MS + GOVERNOR_WINDOW_MS - BUDGET); // the window's first frame counts whole
  });
  test("vsync quantization (75 Hz or 144 Hz panels) is not a miss", () => {
    expect(run(0, 1000 / 37.5).verdict).toBe("ok");
    expect(run(0, 1000 / 48).verdict).toBe("ok");
  });
  test("frames at well under half the budget's rate miss", () => {
    expect(run(0, 40).verdict).toBe("miss");
    expect(run(0, BUDGET * GOVERNOR_SLACK + 1).verdict).toBe("miss");
  });
  test("frames during the settle period and stalls are not counted", () => {
    const g = createFrameGovernor(0);
    expect(g.sample(GOVERNOR_SETTLE_MS - 1, 100, BUDGET)).toBe("pending");
    expect(g.stats().frames).toBe(0);
    expect(g.sample(GOVERNOR_SETTLE_MS + 10, 400, BUDGET)).toBe("pending"); // a stall (tab switch, dialog)
    expect(g.stats().frames).toBe(0);
  });
  test("one verdict per mount: later frames do not change it", () => {
    const g = createFrameGovernor(0);
    let now = GOVERNOR_SETTLE_MS;
    while (g.verdict() === "pending") { now += 40; g.sample(now, 40, BUDGET); }
    expect(g.verdict()).toBe("miss");
    for (let i = 0; i < 500; i++) { now += BUDGET; g.sample(now, BUDGET, BUDGET); }
    expect(g.verdict()).toBe("miss");
    expect(g.stats().slowShare).toBeGreaterThan(GOVERNOR_MISS_SHARE);
  });
});

describe("watchPerfTier - GPU probe and governor step-down", () => {
  const mem = (): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } => {
    const store = new Map<string, string>();
    return { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) };
  };
  /** A watcher on a probe that has already answered; awaiting `ready` runs after the watcher's own handler (it
   *  subscribed first), so no timer is needed. */
  const watch = (kv: KVStore, cls: "software" | "integrated" | "discrete" | null): { w: PerfTierWatcher; ready: Promise<GpuProbe> } => {
    const ready = Promise.resolve<GpuProbe>({ cls, name: cls ? "Test GPU" : null, renderer: null, source: "webgl" });
    return { w: watchPerfTier(kv, () => ready), ready };
  };
  const machine = (gpu: "software" | "integrated" | "discrete" | null) => ({
    onBattery: false, batteryLevel: null, cores: typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? null) : null, reducedMotion: false, gpu,
  });
  test("the probed GPU class feeds auto and notifies when the tier moves", async () => {
    const { w, ready } = watch(mem(), "software");
    const seen: string[] = [];
    w.onChange((t) => seen.push(t));
    await ready;
    expect(w.gpu()?.cls).toBe("software");
    expect(w.tier()).toBe("minimal");
    expect(seen).toEqual(resolveTier("auto", machine(null)) === "minimal" ? [] : ["minimal"]);
  });
  test("a discrete GPU resolves like the pure resolver says (ultra on a strong plugged-in machine)", async () => {
    const { w, ready } = watch(mem(), "discrete");
    await ready;
    expect(w.tier()).toBe(resolveTier("auto", machine("discrete")));
  });
  test("stepDown caps auto one tier at a time, and a mode change clears it", async () => {
    const { w, ready } = watch(mem(), "discrete");
    await ready;
    const before = w.tier();
    const after = w.stepDown();
    if (before === "minimal") expect(after).toBeNull();
    else {
      expect(after).toBe(stepDownTier(before));
      expect(w.tier()).toBe(stepDownTier(before));
      expect(w.steppedFrom()).toBe(before);
    }
    w.cycleMode(); // full
    expect(w.steppedFrom()).toBeNull();
    w.cycleMode(); w.cycleMode(); w.cycleMode(); w.cycleMode(); w.cycleMode(); // back to auto
    expect(w.mode()).toBe("auto");
    expect(w.tier()).toBe(before); // the cap went with the user's choice
  });
  test("an explicit tier is never stepped down", async () => {
    const kv = mem();
    kv.setItem("lucid.perfMode", "cinematic");
    const { w, ready } = watch(kv, "software");
    await ready;
    expect(w.tier()).toBe("cinematic");
    expect(w.stepDown()).toBeNull();
    expect(w.tier()).toBe("cinematic");
  });
  test("a failed or unknown probe leaves the GPU unknown (no degrade)", async () => {
    const failed = Promise.reject<GpuProbe>(new Error("no gpu"));
    const w = watchPerfTier(mem(), () => failed);
    await failed.catch(() => undefined);
    expect(w.gpu()).toBeNull();
    expect(w.tier()).toBe(resolveTier("auto", machine(null)));
    const { w: u, ready } = watch(mem(), null);
    await ready;
    expect(u.tier()).toBe(resolveTier("auto", machine(null)));
  });
});
