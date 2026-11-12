// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/stall_notice.test.ts - P-STALL.1 (ADR-0186) / P-STALL.2 (ADR-0263).
// Pins: the minute math (floors, never says "0 min"), the pending-task summary, the toast copy
// (no cap named - the cutoff is GONE; Stop is the way out), and the inverse lockstep with the
// backend: acp_backend must never regrow a time-based turn cutoff.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pendingSummaryLine, slowPhaseLabel, slowToastCopy, snapshotPhaseLabel, STARTING_AGENT_PHASE } from "./stall_notice.ts";

const PENDING = [
  { label: "subagent explore: map callers", elapsedMs: 12 * 60_000 },
  { label: "bash: cargo build", elapsedMs: 3 * 60_000 },
];

describe("slowPhaseLabel", () => {
  test("floors to whole minutes and never says 0", () => {
    expect(slowPhaseLabel(120_000)).toBe("Still waiting on the provider · silent for 2 min");
    expect(slowPhaseLabel(45_000)).toContain("1 min"); // early fire safety - never "0 min"
  });
  test("with pending tasks the quiet reads as WORK, with the count", () => {
    expect(slowPhaseLabel(240_000, PENDING)).toBe("Working · waiting on 2 tasks · quiet for 4 min");
    expect(slowPhaseLabel(120_000, [PENDING[0]!])).toContain("1 task ·");
  });
});

describe("snapshotPhaseLabel", () => {
  const T0 = 1_000_000;
  const running = { running: true, sessionId: "s1", startedAt: T0, pending: [] };
  test("a fresh send's opening snapshot never says Reconnected: it keeps the turn's own phase", () => {
    expect(snapshotPhaseLabel(running, false, "Sizing up the problem\u2026", T0)).toBe("Sizing up the problem\u2026");
  });
  test("a fresh send whose agent session does not exist yet says the agent is starting", () => {
    expect(snapshotPhaseLabel({ ...running, sessionId: null }, false, "Sizing up the problem\u2026", T0)).toBe(STARTING_AGENT_PHASE);
  });
  test("only a re-joined stream (adopted or re-attached) says Reconnected", () => {
    expect(snapshotPhaseLabel(running, true, "[connection to the engine dropped]", T0)).toBe("Reconnected");
    expect(snapshotPhaseLabel({ ...running, sessionId: null }, true, "x", T0)).toBe("Reconnected");
  });
  test("pending work and a finished turn read the same either way", () => {
    for (const rejoined of [false, true]) {
      expect(snapshotPhaseLabel({ ...running, pending: PENDING }, rejoined, "x", T0 + 240_000)).toBe("Working \u00b7 waiting on 2 tasks \u00b7 quiet for 4 min");
      expect(snapshotPhaseLabel({ ...running, running: false }, rejoined, "x", T0)).toBe("Finishing reply");
    }
  });
});

describe("pendingSummaryLine", () => {
  test("names the longest-running tasks with their elapsed minutes", () => {
    const line = pendingSummaryLine(PENDING)!;
    expect(line).toContain("subagent explore: map callers (12m)");
    expect(line).toContain("bash: cargo build (3m)");
  });
  test("caps the list and counts the rest; sub-minute shows <1m", () => {
    const many = [...PENDING, { label: "read: a", elapsedMs: 30_000 }, { label: "read: b", elapsedMs: 10_000 }];
    const line = pendingSummaryLine(many, 3)!;
    expect(line).toContain("(<1m)");
    expect(line).toContain("+1 more");
  });
  test("null when nothing is tracked (pre-first-token silence)", () => {
    expect(pendingSummaryLine(undefined)).toBeNull();
    expect(pendingSummaryLine([])).toBeNull();
  });
});

describe("slowToastCopy", () => {
  test("never names a cap - the turn waits as long as the work takes, Stop is the exit", () => {
    const c = slowToastCopy(120_000);
    expect(c.desc).not.toMatch(/\b(10|ten) minutes?\b/);
    expect(c.desc).toContain("waits as long as it takes");
    expect(c.desc).toContain("Stop cancels");
  });
  test("with pending tasks the toast says it is WORK, and lists them", () => {
    const c = slowToastCopy(240_000, PENDING);
    expect(c.title).toBe("Long-running work in progress");
    expect(c.desc).toContain("not stuck");
    expect(c.desc).toContain("Waiting on: subagent explore: map callers (12m)");
  });
});

describe("the cutoff stays dead (inverse lockstep with the backend)", () => {
  test("acp_backend has no IDLE_MS and no stall race - a turn is never killed by a clock", () => {
    const src = readFileSync(join(import.meta.dir, "..", "acp_backend.ts"), "utf8");
    expect(src).not.toContain("IDLE_MS");
    // The CHAT turn (its prompt is built as `promptContent`) is awaited directly - no race. The util
    // completions (checker/extractor, `${system}\n\n${user}` prompts) keep their own deliberate
    // background clocks; they are reworked separately (parked P-KG-INGEST.5).
    expect(src).not.toMatch(/Promise\.race[\s\S]{0,200}promptContent/);
    expect(src).toMatch(/await this\.acp!\.request<\{ stopReason\?: unknown \}>\("session\/prompt"/);
    expect(src).not.toContain("the model sent nothing for");
  });
  test("the ACP client rejects in-flight requests when the child dies (the event-driven replacement)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "acp.ts"), "utf8");
    expect(src).toContain("private die(");
    expect(src).toMatch(/on\("exit",[\s\S]{0,200}die\(/);
    expect(src).toMatch(/on\("error",[\s\S]{0,200}die\(/); // spawn failure emits no exit - both must drain
  });
});
