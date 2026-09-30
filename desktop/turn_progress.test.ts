// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/turn_progress.test.ts - P-PROGRESS.1: the estimate is history or nothing, the percent never
// finishes a running turn, and liveness follows the evidence in strength order. P-PROGRESS.4: the time left
// is conditioned on the time already run, narrowest history first, and past the typical length it names a
// figure only with evidence.

import { describe, expect, test } from "bun:test";
import { agedProgress, DurationHistory, ETA_ESTIMATING, estimateFromSamples, estimateTurn, etaPhrase, livenessVerdict, progressLine, progressView, PROGRESS_TICK_MS, QUIET_MS, STREAMING_MS, wholeEtaPhrase } from "./turn_progress.ts";

function seeded(model: string, ms: number[]): DurationHistory {
  const h = new DurationHistory();
  for (const m of ms) h.addTurn(model, m);
  return h;
}

describe("estimateTurn", () => {
  test("no history means no number, not a made-up one", () => {
    const e = estimateTurn({ elapsedMs: 10_000, model: "m", history: new DurationHistory() });
    expect(e).toEqual({ etaMs: null, percent: null, basis: "none", samples: 0, typicalMs: null, overrun: false });
  });

  test("this model's history wins once it has three samples; the typical figure is the p75", () => {
    const h = seeded("a", [10_000, 20_000, 30_000, 40_000]);
    for (const ms of [1_000, 2_000, 3_000, 4_000, 5_000]) h.addTurn("b", ms);
    const e = estimateTurn({ elapsedMs: 15_000, model: "a", history: h });
    expect(e.basis).toBe("model");
    expect(e.typicalMs).toBe(30_000);
    expect(e.percent).toBe(50);
    expect(e.etaMs).toBe(15_000);
    expect(e.overrun).toBe(false);
  });

  test("a model with too few samples falls back to every model, and under five pooled samples says nothing", () => {
    const h = seeded("a", [10_000, 20_000]);
    expect(estimateTurn({ elapsedMs: 1, model: "a", history: h }).basis).toBe("none");
    for (const ms of [30_000, 40_000, 50_000]) h.addTurn("b", ms);
    const e = estimateTurn({ elapsedMs: 1_000, model: "a", history: h });
    expect(e.basis).toBe("any");
    expect(e.samples).toBe(5);
  });

  test("past the typical length the percent pins at 95 and the view says overrun with zero left", () => {
    const h = seeded("a", [10_000, 10_000, 10_000, 10_000, 10_000]);
    const e = estimateTurn({ elapsedMs: 60_000, model: "a", history: h });
    expect(e.percent).toBe(95);
    expect(e.etaMs).toBe(0);
    expect(e.overrun).toBe(true);
  });

  test("garbage elapsed is no estimate", () => {
    const h = seeded("a", [10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(estimateTurn({ elapsedMs: Number.NaN, model: "a", history: h }).basis).toBe("none");
  });
});

describe("P-PROGRESS.4 time left given the time already run", () => {
  test("steady progress through a typical history counts down tick by tick, never below zero, never 100%", () => {
    const h = seeded("a", Array.from({ length: 20 }, (_, k) => 50_000 + k * 1_000)); // 50 s .. 69 s, p75 = 64 s
    // Between ticks the figure may step up by one sample gap as a shorter past turn drops out; at the engine's
    // cadence, whatever the phase, it only goes down.
    for (const phase of [0, 2_500]) {
      let prev = Number.POSITIVE_INFINITY;
      for (let e = phase; e <= 80_000; e += PROGRESS_TICK_MS) {
        const est = estimateTurn({ elapsedMs: e, model: "a", history: h });
        expect(est.etaMs!).toBeGreaterThanOrEqual(0);
        expect(est.etaMs!).toBeLessThanOrEqual(prev);
        expect(est.percent!).toBeLessThanOrEqual(95);
        prev = est.etaMs!;
      }
    }
    // Past the typical length with fewer than five longer turns on record: no invented finish time.
    const late = estimateTurn({ elapsedMs: 66_000, model: "a", history: h });
    expect(late.overrun).toBe(true);
    expect(late.etaMs).toBe(0);
    expect(etaPhrase(late)).toBe("longer than usual (typically 1 m 4 s)");
  });

  test("past the typical length a figure is named only once five longer turns back it", () => {
    const h = seeded("a", Array(20).fill(60_000));
    for (let k = 0; k < 4; k++) h.addTurn("a", 150_000);
    const before = estimateTurn({ elapsedMs: 90_000, model: "a", history: h });
    expect(before.etaMs).toBe(0);
    expect(etaPhrase(before)).toBe("longer than usual (typically 1 m)");
    h.addTurn("a", 150_000);
    const after = estimateTurn({ elapsedMs: 90_000, model: "a", history: h });
    expect(after.overrun).toBe(true);
    expect(after.percent).toBe(95);
    expect(after.etaMs).toBe(60_000);
    expect(etaPhrase(after)).toBe("longer than usual, about 1 m left (est.)");
    expect(wholeEtaPhrase(after, [20_000])).toBe("about 1 m left (est.)"); // backed, so it counts as known
  });

  test("the session's own history first, then the model's, then every model's", () => {
    const h = new DurationHistory();
    for (let k = 0; k < 10; k++) h.addTurn("a", 300_000, "s1");
    for (let k = 0; k < 5; k++) h.addTurn("a", 20_000, "s2");
    for (let k = 0; k < 5; k++) h.addTurn("a", 100_000, "s3");
    const left = (model: string, scope?: string) => estimateTurn({ elapsedMs: 10_000, model, scope, history: h }).etaMs;
    expect(left("a", "s1")).toBe(290_000);
    expect(left("a", "s2")).toBe(10_000);
    expect(left("a", "new-session")).toBe(90_000); // the model's 20 turns
    expect(left("a")).toBe(90_000);
    for (let k = 0; k < 3; k++) h.addTurn("c", 2_000_000, "s9");
    expect(left("c", "s9")).toBe(90_000); // three of its own are not evidence: every model's turns decide
    for (let k = 0; k < 2; k++) h.addTurn("c", 2_000_000, "s9");
    expect(left("c", "s9")).toBe(1_990_000);
  });

  test("an aged sample says longer than usual only once the elapsed time passes the typical length", () => {
    const h = seeded("a", Array.from({ length: 20 }, (_, k) => 50_000 + k * 1_000));
    const now = 1_000_000;
    const p = progressView({ busy: true, dead: false, startedAt: now - 58_000, lastActivityAt: now, stepsDone: 0, stepsOpen: [], model: "a", history: h, now });
    expect(p.estimate.overrun).toBe(false);
    const soon = agedProgress(p, p.estimate.etaMs! + 1_000); // the figure ran out, the typical 64 s not yet
    expect(soon.estimate.etaMs).toBe(0);
    expect(soon.estimate.overrun).toBe(false);
    expect(agedProgress(p, 7_000).estimate.overrun).toBe(true);
  });
});

describe("DurationHistory", () => {
  test("seeds from latency ledger lines, skipping failed turns and bad lines", () => {
    const h = new DurationHistory();
    const n = h.seedFromLatencyLines([
      JSON.stringify({ model: "a", totalMs: 5_000, ok: true, sessionId: "s1" }),
      JSON.stringify({ model: "a", totalMs: 300, ok: false }),
      "not json",
      "null",
      JSON.stringify({ model: "a", totalMs: "7" }),
      JSON.stringify({ model: "a", totalMs: 0 }),
      "",
    ]);
    expect(n).toBe(1);
    expect(h.turnSamples("a")).toEqual([5_000]);
    expect(h.turnSamples("a", "s1")).toEqual([5_000]); // P-PROGRESS.4: the ledger's session keys the sample
    expect(h.turnSamples("a", "s2")).toEqual([]);
  });

  test("seeding a long ledger keeps only the newest turns within the cap", () => {
    const h = new DurationHistory(3);
    h.seedFromLatencyLines([1_000, 2_000, 3_000, 4_000, 5_000].map((totalMs) => JSON.stringify({ model: "a", totalMs, ok: true })));
    expect(h.turnSamples()).toEqual([3_000, 4_000, 5_000]);
  });

  test("is bounded: the oldest sample falls off first", () => {
    const h = new DurationHistory(3);
    for (const ms of [1, 2, 3, 4]) h.addTurn("a", ms);
    expect(h.turnSamples()).toEqual([2, 3, 4]);
  });

  test("a tool's typical length needs two samples and is the p75", () => {
    const h = new DurationHistory();
    h.addTool("bash", 1_000);
    expect(h.toolTypical("Bash")).toBeUndefined();
    h.addTool("BASH", 3_000);
    h.addTool("bash", 2_000);
    h.addTool("bash", 4_000);
    expect(h.toolTypical("bash")).toBe(3_000);
  });
});

describe("livenessVerdict", () => {
  const base = { busy: true, dead: false, lastSignalMs: 0, stepsOpen: [], lastHealth: null, now: 1_000_000 };

  test("a dead child outranks everything, and the label says the process exited", () => {
    const v = livenessVerdict({ ...base, dead: true, lastSignalMs: 1 });
    expect(v.state).toBe("dead");
    expect(v.detail).toContain("no app restart");
  });

  test("not busy is idle whatever the silence", () => {
    expect(livenessVerdict({ ...base, busy: false, lastSignalMs: 10 * QUIET_MS }).state).toBe("idle");
  });

  test("a fresh signal is streaming", () => {
    expect(livenessVerdict({ ...base, lastSignalMs: STREAMING_MS - 1 }).state).toBe("streaming");
  });

  test("an open tool call explains any silence and names the longest one", () => {
    const v = livenessVerdict({ ...base, lastSignalMs: 10 * QUIET_MS, stepsOpen: [{ label: "bash: bun test", elapsedMs: 400_000, typicalMs: 30_000 }] });
    expect(v.state).toBe("working");
    expect(v.label).toContain("bash: bun test");
    expect(v.detail).toContain("usually about 30 s");
  });

  test("silence with nothing open is thinking under the quiet line and quiet past it", () => {
    expect(livenessVerdict({ ...base, lastSignalMs: QUIET_MS - 1 }).state).toBe("thinking");
    expect(livenessVerdict({ ...base, lastSignalMs: QUIET_MS }).state).toBe("quiet");
  });

  test("a recent watchdog action is what the user sees, even mid-stream", () => {
    expect(livenessVerdict({ ...base, lastHealth: { action: "probe", at: base.now - 10_000 } }).state).toBe("probing");
    expect(livenessVerdict({ ...base, lastHealth: { action: "recover", at: base.now - 10_000 } }).state).toBe("recovering");
    expect(livenessVerdict({ ...base, lastHealth: { action: "recover", at: base.now - 120_000 } }).state).toBe("streaming");
  });
});

describe("progressView", () => {
  test("assembles elapsed, last signal, steps and the estimate from one clock", () => {
    const h = seeded("a", [10_000, 10_000, 10_000, 10_000, 10_000]);
    h.addTool("bash", 2_000); h.addTool("bash", 4_000);
    const now = 500_000;
    const p = progressView({ busy: true, dead: false, startedAt: now - 5_000, lastActivityAt: now - 1_000, stepsDone: 3, stepsOpen: [{ label: "execute: bun test", elapsedMs: 900 }], toolNameOf: () => "bash", model: "a", history: h, now });
    expect(p.elapsedMs).toBe(5_000);
    expect(p.lastSignalMs).toBe(1_000);
    expect(p.stepsDone).toBe(3);
    expect(p.stepsOpen[0]!.typicalMs).toBe(4_000);
    expect(p.estimate.percent).toBe(50);
    expect(p.liveness.state).toBe("streaming");
    expect(progressLine(p, true)).toBe("5 s \u00b7 step 4 \u00b7 about 5 s left (est.)");
    expect(progressLine(p, false)).toBe("5 s \u00b7 step 4"); // P-PROGRESS.3: the estimate is opt-in
  });

  test("an idle worker has no estimate and no steps", () => {
    const p = progressView({ busy: false, dead: false, startedAt: null, lastActivityAt: 0, stepsDone: 0, stepsOpen: [], model: "a", history: new DurationHistory(), now: 10 });
    expect(p.estimate.basis).toBe("none");
    expect(p.liveness.state).toBe("idle");
    expect(progressLine(p, true)).toBe("0 s");
  });

  test("P-PROGRESS.3: without history the line carries no ETA part, never the ETA estimating placeholder", () => {
    const now = 500_000;
    const p = progressView({ busy: true, dead: false, startedAt: now - 12_000, lastActivityAt: now - 1_000, stepsDone: 1, stepsOpen: [], model: "a", history: new DurationHistory(), now });
    expect(progressLine(p, true)).toBe("12 s \u00b7 step 1");
    expect(progressLine(p, true)).not.toContain(ETA_ESTIMATING);
    const dead = progressView({ busy: true, dead: true, startedAt: now - 12_000, lastActivityAt: now - 1_000, stepsDone: 1, stepsOpen: [], model: "a", history: seeded("a", [10_000, 10_000, 10_000, 10_000, 10_000]), now });
    expect(progressLine(dead, true)).toBe("12 s \u00b7 step 1"); // a dead worker has no ETA to estimate
  });
});

describe("P-PROGRESS.2 estimateFromSamples and wholeEtaPhrase", () => {
  test("below the sample floor there is no number; at it, the p75 of usable lengths", () => {
    expect(estimateFromSamples(1_000, [60_000], 2).typicalMs).toBeNull();
    expect(estimateFromSamples(1_000, [60_000, -5, Number.NaN], 2).typicalMs).toBeNull(); // junk is not history
    const e = estimateFromSamples(20_000, [60_000, 120_000], 2);
    expect(e.typicalMs).toBe(120_000);
    expect(e.etaMs).toBe(100_000);
  });

  test("the whole prompt ends with its slowest known part; unknown parts make it a floor", () => {
    const turn = estimateFromSamples(10_000, [40_000, 40_000], 2); // 30 s left
    expect(wholeEtaPhrase(turn, [])).toBe(etaPhrase(turn));
    expect(wholeEtaPhrase(turn, [90_000])).toBe("about 1 m 30 s left (est.)");
    expect(wholeEtaPhrase(turn, [90_000, null])).toBe("at least 1 m 30 s left (est.)");
    expect(wholeEtaPhrase(estimateFromSamples(10_000, [], 2), [null])).toBe(ETA_ESTIMATING);
    expect(wholeEtaPhrase(null, [20_000])).toBe("about 20 s left (est.)"); // the turn ended; a helper still runs
    expect(wholeEtaPhrase(null, [])).toBe("");
  });

  test("a turn past its typical length counts as unknown time left, not as zero", () => {
    const over = estimateFromSamples(50_000, [40_000, 40_000], 2);
    expect(over.overrun).toBe(true);
    expect(wholeEtaPhrase(over, [20_000])).toBe("at least 20 s left (est.)");
  });
});
