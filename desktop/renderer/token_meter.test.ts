// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/token_meter.test.ts - P-TOKENS.1: the pure token/spend meter behind the composer popover.
// The load-bearing tests here are the HONESTY ones: a metric the provider never sent must read "not reported"
// (never "$0.00", never "0 tokens"), a locally computed output figure must always declare itself an estimate,
// a per-call context delta must stay null unless two usage samples actually bracket the call, and a REPORTED
// zero cost must stay measured. Plus purity: every reducer returns a new state and mutates nothing.

import { describe, expect, it } from "bun:test";
import {
  newMeter, resetMeter, onUsage, onToolStart, onToolEnd, onOutput, onHealth, onTurnEnd,
  meterRows, toolRows, modelRows, meterBadge, fmtTokens, fmtUsd, fmtMs,
  TOOLS_MAX, type MeterState, type MeterRow, type ModelSpend,
} from "./token_meter.ts";

const T0 = 1_700_000_000_000;

/** Run a reducer with the input deep-cloned first, then assert the input is byte-for-byte untouched. Purity is
 *  a contract here: the DOM layer diffs state identity to decide what to repaint. */
function pure<T>(m: MeterState, fn: (s: MeterState) => T): T {
  const before = structuredClone(m);
  const out = fn(m);
  expect(m).toEqual(before);
  return out;
}

function row(rows: readonly MeterRow[], label: string): MeterRow {
  const found = rows.find((r) => r.label === label);
  expect(found, `missing row: ${label}`).toBeDefined();
  return found!;
}

/** The three figures that come from the provider over ACP. Everything else on the panel is locally counted. */
const PROVIDER_LABELS = ["Context used", "Context window", "Cost"];

/** A meter with every counter exercised: usage samples, tools (one failed, one running), output, health, turns. */
function populated(): MeterState {
  let m = newMeter(T0);
  m = onUsage(m, { used: 1000, size: 200_000, cost: 0.42 }, T0 + 10);
  m = onToolStart(m, "c1", "read", "src/app.ts", T0 + 20);
  m = onUsage(m, { used: 1400, size: 200_000, cost: 0.44 }, T0 + 30);
  m = onToolEnd(m, "c1", T0 + 1_240);
  m = onToolStart(m, "c2", "bash", "bun test", T0 + 1_300);
  m = onToolEnd(m, "c2", T0 + 3_800, true);
  m = onToolStart(m, "c3", "write", "notes.md", T0 + 4_000);
  m = onOutput(m, 3_210, T0 + 4_100);
  m = onHealth(m, T0 + 4_200);
  m = onTurnEnd(m, T0 + 4_300);
  return m;
}

describe("newMeter / resetMeter (P-TOKENS.1)", () => {
  it("starts with the provider figures ABSENT, not zeroed", () => {
    const m = newMeter(T0);
    expect(m.ctxTokens).toBeNull();
    expect(m.ctxSize).toBeNull();
    expect(m.costUsd).toBeNull();
    expect(m.outTokens).toBe(0);
    expect(m.turns).toBe(0);
    expect(m.toolCalls).toBe(0);
    expect(m.toolFailures).toBe(0);
    expect(m.healthChecks).toBe(0);
    expect(m.usageSamples).toBe(0);
    expect(m.tools).toEqual([]);
    expect(m.startedAt).toBe(T0);
    expect(m.lastAt).toBe(T0);
  });

  it("resetMeter drops every carried figure, so one session's spend never lands on another", () => {
    expect(resetMeter(T0 + 5)).toEqual(newMeter(T0 + 5));
    const m = populated();
    const fresh = resetMeter(T0 + 9_999);
    expect(fresh.ctxTokens).toBeNull();
    expect(fresh.costUsd).toBeNull();
    expect(fresh.tools).toEqual([]);
    expect(m.tools.length).toBeGreaterThan(0); // the old state is untouched
  });

  it("survives an unusable clock without storing NaN", () => {
    const m = newMeter(Number.NaN);
    expect(Number.isFinite(m.startedAt)).toBe(true);
    expect(Number.isFinite(m.lastAt)).toBe(true);
  });
});

describe("anti-fabrication: a fresh meter claims nothing (P-TOKENS.1)", () => {
  it("reads 'not reported' on every provider row, with no $0.00 and no '0 tokens' anywhere", () => {
    const rows = pure(newMeter(T0), meterRows);

    for (const label of PROVIDER_LABELS) {
      const r = row(rows, label);
      expect(r.value).toBe("not reported");
      expect(r.measured).toBe(false);
      expect(r.hint && r.hint.length > 0).toBe(true); // an unmeasured row is never shown unlabelled
    }
    for (const r of rows) {
      expect(r.value).not.toContain("$0.00");
      expect(r.value).not.toContain("0 tokens");
    }
    // The only rows allowed to claim `measured` on a cold meter are the LOCAL counters, which really are 0.
    const measured = rows.filter((r) => r.measured).map((r) => r.label);
    expect(measured).toEqual(["Turns", "Tool calls", "Health checks"]);
    expect(row(rows, "Output (estimated)").measured).toBe(false);
    expect(toolRows(newMeter(T0))).toEqual([]);
  });
});

describe("onUsage: the measured figures (P-TOKENS.1)", () => {
  it("carries used, size and cost, and marks them measured", () => {
    const m = pure(newMeter(T0), (s) => onUsage(s, { used: 1000, size: 200_000, cost: 0.42 }, T0 + 10));
    expect(m.ctxTokens).toBe(1000);
    expect(m.ctxSize).toBe(200_000);
    expect(m.costUsd).toBe(0.42);
    expect(m.usageSamples).toBe(1);

    const rows = meterRows(m);
    const ctx = row(rows, "Context used");
    expect(ctx.measured).toBe(true);
    expect(ctx.value).toContain("1000");
    expect(ctx.value).toContain("200000");
    expect(ctx.tone).toBe("ok");
    expect(row(rows, "Cost").value).toBe("$0.42");
    expect(row(rows, "Cost").measured).toBe(true);
  });

  it("a REPORTED zero cost stays measured and renders $0.00 (an unreported zero would not)", () => {
    let m = onUsage(newMeter(T0), { used: 1000, size: 200_000, cost: 0.42 }, T0 + 10);
    m = onUsage(m, { used: 1200, size: 200_000, cost: 0 }, T0 + 20);
    const cost = row(meterRows(m), "Cost");
    expect(cost.measured).toBe(true);
    expect(cost.value).toBe("$0.00");
    expect(m.usageSamples).toBe(2);

    // The distinction: never reported at all is NOT a zero.
    const cold = row(meterRows(newMeter(T0)), "Cost");
    expect(cold.value).toBe("not reported");
    expect(cold.measured).toBe(false);
  });

  it("a sub-cent charge is not laundered into $0.00", () => {
    const m = onUsage(newMeter(T0), { used: 10, size: 1000, cost: 0.004 }, T0 + 5);
    expect(row(meterRows(m), "Cost").value).toBe("< $0.01");
  });

  it("an unparseable sample is not counted as a sample", () => {
    const m0 = newMeter(T0);
    const m1 = onUsage(m0, { used: Number.NaN, size: Number.NaN, cost: Number.NaN }, T0 + 10);
    expect(m1).toBe(m0);
    expect(m1.usageSamples).toBe(0);
    expect(row(meterRows(m1), "Context used").value).toBe("not reported");
  });
});

describe("onOutput: always an estimate (P-TOKENS.1)", () => {
  it("is measured:false with a hint that says 'estimate', reported or not", () => {
    const cold = row(meterRows(newMeter(T0)), "Output (estimated)");
    expect(cold.measured).toBe(false);
    expect(cold.value).toBe("none yet");
    expect(cold.hint ?? "").toContain("estimate");

    const m = pure(newMeter(T0), (s) => onOutput(s, 1234, T0 + 40));
    expect(m.outTokens).toBe(1234);
    const hot = row(meterRows(m), "Output (estimated)");
    expect(hot.measured).toBe(false);
    expect(hot.value).toBe("1.2k");
    expect((hot.hint ?? "").length).toBeGreaterThan(0);
    expect(hot.hint ?? "").toContain("estimate");
  });

  it("replaces the cumulative estimate and ignores an unusable one", () => {
    let m = onOutput(newMeter(T0), 500, T0 + 10);
    m = onOutput(m, 900, T0 + 20);
    expect(m.outTokens).toBe(900);
    const same = onOutput(m, Number.NaN, T0 + 30);
    expect(same).toBe(m);
    expect(same.outTokens).toBe(900);
  });
});

describe("tool call lifecycle (P-TOKENS.1)", () => {
  it("shows a running call as 'running' and a settled call with a duration", () => {
    const started = pure(newMeter(T0), (s) => onToolStart(s, "c1", "read", "src/app.ts", T0 + 100));
    expect(started.toolCalls).toBe(1);
    const running = toolRows(started);
    expect(running).toHaveLength(1);
    expect(running[0]!.label).toBe("read: src/app.ts");
    expect(running[0]!.value).toContain(fmtMs(undefined));
    expect(running[0]!.value).toContain("running");

    const ended = pure(started, (s) => onToolEnd(s, "c1", T0 + 1_350));
    expect(ended.tools[0]!.endedAt).toBe(T0 + 1_350);
    expect(ended.toolFailures).toBe(0);
    const settled = toolRows(ended);
    expect(settled[0]!.value).toContain("1.3s");
    expect(settled[0]!.value).not.toContain("running");
  });

  it("a failure is toned danger and counted", () => {
    let m = onToolStart(newMeter(T0), "c1", "bash", "bun test", T0 + 10);
    m = pure(m, (s) => onToolEnd(s, "c1", T0 + 2_010, true));
    expect(m.toolFailures).toBe(1);
    expect(m.tools[0]!.failed).toBe(true);
    expect(toolRows(m)[0]!.tone).toBe("danger");
    const calls = row(meterRows(m), "Tool calls");
    expect(calls.value).toBe("1 (1 failed)");
    expect(calls.tone).toBe("danger");
  });

  it("an end for a call we never saw start is dropped, not invented", () => {
    const m = onToolStart(newMeter(T0), "c1", "read", "a.ts", T0 + 10);
    const same = pure(m, (s) => onToolEnd(s, "nope", T0 + 20));
    expect(same).toBe(m);
    expect(toolRows(same)).toHaveLength(1);
    expect(toolRows(same)[0]!.value).toContain("running");
  });

  it("never reports a negative duration when the clock goes backwards", () => {
    let m = onToolStart(newMeter(T0), "c1", "read", "a.ts", T0 + 5_000);
    m = onToolEnd(m, "c1", T0 + 1_000);
    expect(m.tools[0]!.endedAt).toBe(T0 + 5_000);
    expect(toolRows(m)[0]!.value).toContain("0ms");
  });

  it("flattens a multi-line tool title into one text child (Invariant #11)", () => {
    const m = onToolStart(newMeter(T0), "c1", "edit", "a.ts\nb.ts", T0 + 10);
    expect(toolRows(m)[0]!.label).toBe("edit: a.ts b.ts");
    expect(toolRows(m)[0]!.label).not.toContain("\n");
  });
});

describe("ctxDelta attribution (P-TOKENS.1)", () => {
  it("attributes growth when two usage samples bracket the call", () => {
    let m = onUsage(newMeter(T0), { used: 1000, size: 200_000, cost: 0.1 }, T0 + 10);
    m = onToolStart(m, "c1", "read", "big.ts", T0 + 20);
    m = onUsage(m, { used: 1400, size: 200_000, cost: 0.2 }, T0 + 30);
    m = onToolEnd(m, "c1", T0 + 40);
    expect(m.tools[0]!.ctxDelta).toBe(400);
    const r = toolRows(m)[0]!;
    expect(r.value).toContain("+400");
    expect(r.measured).toBe(false);   // attribution is never presented as a provider figure
    expect(r.hint ?? "").toContain("ATTRIBUTED");
  });

  it("closes the delta from a sample that lands AFTER the call settled", () => {
    let m = onUsage(newMeter(T0), { used: 1000, size: 200_000, cost: 0.1 }, T0 + 10);
    m = onToolStart(m, "c1", "read", "big.ts", T0 + 20);
    m = onToolEnd(m, "c1", T0 + 30);
    expect(m.tools[0]!.ctxDelta).toBeNull();
    m = onUsage(m, { used: 1750, size: 200_000, cost: 0.2 }, T0 + 40);
    expect(m.tools[0]!.ctxDelta).toBe(750);
  });

  it("stays null with no bracketing usage, and the row SAYS so instead of showing 0", () => {
    // No usage at all before the call: nothing to subtract from.
    let bare = onToolStart(newMeter(T0), "c1", "read", "a.ts", T0 + 10);
    bare = onToolEnd(bare, "c1", T0 + 20);
    expect(bare.tools[0]!.ctxDelta).toBeNull();

    // One sample before the call but none after it: still not bracketed.
    let one = onUsage(newMeter(T0), { used: 1000, size: 200_000, cost: 0.1 }, T0 + 10);
    one = onToolStart(one, "c1", "read", "a.ts", T0 + 20);
    one = onToolEnd(one, "c1", T0 + 30);
    expect(one.tools[0]!.ctxDelta).toBeNull();

    for (const m of [bare, one]) {
      const r = toolRows(m)[0]!;
      expect(r.value).toContain("context growth not attributed");
      expect(r.value).not.toContain("+0");
      expect(r.value).not.toContain("context 0");
      expect(r.hint ?? "").toContain("Unknown is not zero");
    }
  });

  it("renders a context compaction as a shrink, not a clamped 0", () => {
    let m = onUsage(newMeter(T0), { used: 9_000, size: 200_000, cost: 0.1 }, T0 + 10);
    m = onToolStart(m, "c1", "task", "compact", T0 + 20);
    m = onUsage(m, { used: 2_000, size: 200_000, cost: 0.2 }, T0 + 30);
    m = onToolEnd(m, "c1", T0 + 40);
    expect(m.tools[0]!.ctxDelta).toBe(-7_000);
    expect(toolRows(m)[0]!.value).toContain("-7.0k");
  });
});

describe("TOOLS_MAX bound (P-TOKENS.1)", () => {
  it("keeps exactly the newest 60 of 70 calls, newest first", () => {
    let m = newMeter(T0);
    for (let i = 0; i < 70; i++) {
      m = onToolStart(m, `c${i}`, "read", `f${i}.ts`, T0 + i * 10);
      m = onToolEnd(m, `c${i}`, T0 + i * 10 + 5);
    }
    expect(TOOLS_MAX).toBe(60);
    expect(m.tools).toHaveLength(60);
    expect(m.toolCalls).toBe(70);                 // the counter still knows the real total
    expect(m.tools[0]!.id).toBe("c10");           // oldest 10 dropped
    expect(m.tools[59]!.id).toBe("c69");
    const rows = toolRows(m);
    expect(rows).toHaveLength(60);
    expect(rows[0]!.label).toBe("read: f69.ts");  // newest FIRST
    expect(rows[59]!.label).toBe("read: f10.ts");
  });
});

describe("counters the user can see (P-TOKENS.1)", () => {
  it("onHealth increments and gets its own row", () => {
    let m = pure(newMeter(T0), (s) => onHealth(s, T0 + 10));
    expect(m.healthChecks).toBe(1);
    m = onHealth(m, T0 + 20);
    expect(m.healthChecks).toBe(2);
    const r = row(meterRows(m), "Health checks");
    expect(r.value).toBe("2");
    expect(r.measured).toBe(true);
    expect((r.hint ?? "").length).toBeGreaterThan(0);
  });

  it("onTurnEnd increments the turn count", () => {
    const m = pure(newMeter(T0), (s) => onTurnEnd(s, T0 + 10));
    expect(m.turns).toBe(1);
    expect(row(meterRows(m), "Turns").value).toBe("1");
    expect(onTurnEnd(m, T0 + 20).turns).toBe(2);
  });
});

describe("meterBadge (P-TOKENS.1)", () => {
  it("has no percent until the provider reports, and says so", () => {
    const b = meterBadge(newMeter(T0));
    expect(b.pct).toBeNull();
    expect(b.label).toContain("not reported");
    expect(b.tone).toBe("ok");

    // A `used` without a `size` still cannot yield a fill percentage.
    const noSize = onUsage(newMeter(T0), { used: 1000, size: Number.NaN, cost: 0.1 }, T0 + 10);
    expect(meterBadge(noSize).pct).toBeNull();
    expect(row(meterRows(noSize), "Context used").value).toBe("1000");
    expect(row(meterRows(noSize), "Context window").value).toBe("not reported");
  });

  it("turns warn at 75% and danger at 90%", () => {
    const badge = (used: number, size: number) => meterBadge(onUsage(newMeter(T0), { used, size, cost: 0.1 }, T0 + 1));
    expect(badge(740, 1000)).toEqual({ pct: 74, label: "Context 74%", tone: "ok" });
    expect(badge(750, 1000).tone).toBe("warn");
    expect(badge(750, 1000).pct).toBe(75);
    expect(badge(890, 1000).tone).toBe("warn");
    // The percent is ROUNDED, so 89.9% presents as 90% and escalates with it: the tone never disagrees with
    // the number printed next to it.
    expect(badge(899, 1000).pct).toBe(90);
    expect(badge(899, 1000).tone).toBe("danger");
    expect(badge(894, 1000)).toEqual({ pct: 89, label: "Context 89%", tone: "warn" });
    expect(badge(900, 1000).tone).toBe("danger");
    expect(badge(1000, 1000)).toEqual({ pct: 100, label: "Context 100%", tone: "danger" });
  });

  it("a used above the window caps at 100 and stays danger", () => {
    const over = meterBadge(onUsage(newMeter(T0), { used: 250_000, size: 200_000, cost: 1 }, T0 + 1));
    expect(over.pct).toBe(100);
    expect(over.tone).toBe("danger");
    expect(over.label).toBe("Context 100%");
  });

  it("the context row carries the same tone as the badge", () => {
    const m = onUsage(newMeter(T0), { used: 190_000, size: 200_000, cost: 1 }, T0 + 1);
    expect(row(meterRows(m), "Context used").tone).toBe("danger");
    expect(meterBadge(m).tone).toBe("danger");
  });
});

describe("modelRows (P-TOKENS.1)", () => {
  it("an empty ledger says nothing is recorded yet, measured:false", () => {
    const rows = modelRows([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.measured).toBe(false);
    expect(rows[0]!.value).toContain("not recorded yet");
    expect((rows[0]!.hint ?? "").length).toBeGreaterThan(0);
    expect(rows[0]!.value).not.toContain("$0.00");
  });

  it("renders one measured row per named model", () => {
    const spend: ModelSpend[] = [
      { model: "claude-opus-5", inTokens: 12_500, outTokens: 900, costUsd: 1.5, turns: 3 },
      { model: "grok-4", inTokens: 400, outTokens: 0, costUsd: 0, turns: 1 },
    ];
    const rows = modelRows(spend);
    expect(rows.map((r) => r.label)).toEqual(["claude-opus-5", "grok-4"]);
    expect(rows[0]!.measured).toBe(true);
    expect(rows[0]!.value).toContain("12.5k");
    expect(rows[0]!.value).toContain("$1.50");
    expect(rows[0]!.value).toContain("3 turns");
    expect(rows[1]!.value).toContain("$0.00");    // a ledger-reported zero is a fact
    expect(rows[1]!.value).toContain("1 turn");
  });

  it("refuses to attribute unnamed or unusable ledger figures", () => {
    const rows = modelRows([
      { model: "   ", inTokens: 10, outTokens: 20, costUsd: 0.1, turns: 1 },
      { model: "grok-4", inTokens: Number.NaN, outTokens: 5, costUsd: Number.NaN, turns: Number.NaN },
    ]);
    expect(rows[0]!.label).toBe("unknown model");
    expect(rows[0]!.measured).toBe(false);
    expect((rows[0]!.hint ?? "").length).toBeGreaterThan(0);
    expect(rows[1]!.value).toContain("in not reported");
    expect(rows[1]!.value).toContain("turns not reported");
    expect(rows[1]!.value).not.toContain("$0.00");
  });
});

describe("formatters (P-TOKENS.1)", () => {
  it("fmtTokens", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(null)).toBe("not reported");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1000)).toBe("1.0k");
    expect(fmtTokens(1234)).toBe("1.2k");
    expect(fmtTokens(1_250_000)).toBe("1.3M");
    expect(fmtTokens(-5)).toBe("0");              // never a negative token count
    expect(fmtTokens(999_999)).toBe("1.0M");      // never the nonsensical "1000.0k"
    expect(fmtTokens(Number.NaN)).toBe("not reported");
    expect(fmtTokens(Number.POSITIVE_INFINITY)).toBe("not reported");
  });

  it("fmtUsd", () => {
    expect(fmtUsd(null)).toBe("not reported");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(0.42)).toBe("$0.42");
    expect(fmtUsd(0.004)).toBe("< $0.01");
    expect(fmtUsd(12.5)).toBe("$12.50");
    expect(fmtUsd(Number.NaN)).toBe("not reported");
    expect(fmtUsd(-1)).toBe("not reported");      // nonsense is not a measurement
  });

  it("fmtMs", () => {
    expect(fmtMs(undefined)).toBe("running");
    expect(fmtMs(0)).toBe("0ms");
    expect(fmtMs(340)).toBe("340ms");
    expect(fmtMs(1_240)).toBe("1.2s");
    expect(fmtMs(125_000)).toBe("2m 5s");
    expect(fmtMs(Number.NaN)).toBe("not reported");   // an unusable duration is not "running"
    expect(fmtMs(-10)).toBe("not reported");
  });
});

describe("purity and text hygiene (P-TOKENS.1)", () => {
  it("no reducer mutates its input state", () => {
    const m = populated();
    const before = structuredClone(m);
    onUsage(m, { used: 2000, size: 200_000, cost: 0.9 }, T0 + 9_000);
    onToolStart(m, "cX", "search", "TODO", T0 + 9_100);
    onToolEnd(m, "c3", T0 + 9_200, true);
    onOutput(m, 9_999, T0 + 9_300);
    onHealth(m, T0 + 9_400);
    onTurnEnd(m, T0 + 9_500);
    meterRows(m);
    toolRows(m);
    meterBadge(m);
    expect(m).toEqual(before);
    expect(m.tools[0]).toEqual(before.tools[0]!);
  });

  it("every reducer returns a NEW state object and a NEW tools array when tools change", () => {
    const m = populated();
    const next = onToolStart(m, "cX", "search", "TODO", T0 + 9_100);
    expect(next).not.toBe(m);
    expect(next.tools).not.toBe(m.tools);
    const ended = onToolEnd(next, "cX", T0 + 9_200);
    expect(ended.tools).not.toBe(next.tools);
    expect(ended.tools[ended.tools.length - 1]).not.toBe(next.tools[next.tools.length - 1]!);
    expect(onUsage(m, { used: 5, size: 10, cost: 0.1 }, T0 + 1).tools).not.toBe(m.tools);
    expect(onHealth(m, T0 + 1)).not.toBe(m);
    expect(onTurnEnd(m, T0 + 1)).not.toBe(m);
    expect(onOutput(m, 7, T0 + 1)).not.toBe(m);
  });

  it("no rendered string contains an em dash", () => {
    const m = populated();
    const all: string[] = [];
    for (const r of [...meterRows(m), ...toolRows(m), ...modelRows([]), ...modelRows([
      { model: "claude-opus-5", inTokens: 1, outTokens: 2, costUsd: 3, turns: 4 },
      { model: "", inTokens: 1, outTokens: 2, costUsd: 3, turns: 4 },
    ])]) {
      all.push(r.label, r.value, r.hint ?? "");
    }
    all.push(meterBadge(m).label, meterBadge(newMeter(T0)).label);
    all.push(fmtTokens(null), fmtUsd(null), fmtMs(undefined), fmtMs(Number.NaN));
    for (const s of all) expect(s).not.toContain("\u2014");
    for (const s of all) expect(s).not.toContain("\u2013");
  });

  it("a populated meter never leaves an unmeasured row unhinted", () => {
    for (const r of [...meterRows(populated()), ...toolRows(populated()), ...modelRows([])]) {
      if (!r.measured) expect((r.hint ?? "").length).toBeGreaterThan(0);
    }
  });
});
