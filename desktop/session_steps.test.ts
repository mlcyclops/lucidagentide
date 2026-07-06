// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/session_steps.test.ts — P-RESUME.1 (ADR-0171): the per-session activity sidecar.
// Over-tests foldSteps (parses a user-reachable JSONL) and the anchoring invariants the resumed
// thread depends on: turn ordinals survive restarts, sync only raises, caps hold, and recording
// never fabricates an anchor.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STEP_CAP, THINK_CAP, _resetStepsForTest, beginStepTurn, deleteSteps, endStepTurn,
  foldSteps, noteStepEvent, readTurnSteps, syncStepTurns,
} from "./session_steps.ts";

describe("foldSteps — defensive against a corrupted sidecar", () => {
  test("empty / blank / corrupt lines → no groups, never a throw", () => {
    expect(foldSteps([])).toEqual([]);
    expect(foldSteps(["", "  ", "{oops", "42", "null", '"str"'])).toEqual([]);
  });

  test("groups by turn, sorted ascending, empty turns dropped", () => {
    const out = foldSteps([
      '{"k":"prompt","turn":2}',
      '{"k":"tool","turn":2,"name":"read","detail":"a.ts"}',
      '{"k":"prompt","turn":1}',
      '{"k":"think","turn":1,"text":"hmm"}',
      '{"k":"prompt","turn":3}', // prompt only — no activity, dropped
    ]);
    expect(out.map((g) => g.turn)).toEqual([1, 2]);
    expect(out[0]!.thinking).toBe("hmm");
    expect(out[1]!.tools).toEqual([{ name: "read", detail: "a.ts" }]);
  });

  test("invalid turns (0 / negative / NaN / missing) are skipped, never misattached", () => {
    expect(foldSteps(['{"k":"tool","turn":0,"name":"x"}', '{"k":"tool","name":"y"}', '{"k":"think","turn":-1,"text":"z"}'])).toEqual([]);
  });

  test("thinking caps per turn and flags truncation", () => {
    const big = "x".repeat(THINK_CAP);
    const out = foldSteps([
      `{"k":"think","turn":1,"text":"${big}"}`,
      '{"k":"think","turn":1,"text":"overflow"}',
    ]);
    expect(out[0]!.thinking.length).toBe(THINK_CAP);
    expect(out[0]!.thinkingTruncated).toBe(true);
  });

  test("tool+fail records cap per turn at STEP_CAP", () => {
    const lines = Array.from({ length: STEP_CAP + 50 }, (_, i) => `{"k":"tool","turn":1,"name":"t${i}","detail":""}`);
    const out = foldSteps(lines);
    expect(out[0]!.tools.length).toBe(STEP_CAP);
  });

  test("fail rows keep command/detail; blank ones become undefined", () => {
    const out = foldSteps(['{"k":"fail","turn":1,"tool":"bash","reason":"tool failed: exit 127","command":"make","detail":"command not found: make"}', '{"k":"fail","turn":1,"tool":"eval","reason":"r","command":"","detail":""}']);
    expect(out[0]!.fails[0]).toEqual({ tool: "bash", reason: "tool failed: exit 127", command: "make", detail: "command not found: make" });
    expect(out[0]!.fails[1]!.command).toBeUndefined();
  });
});

describe("recorder round-trip (temp LUCID_STEPS_DIR — never the real ~/.omp)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lucid-steps-"));
    process.env.LUCID_STEPS_DIR = dir;
    _resetStepsForTest();
  });
  afterEach(() => {
    delete process.env.LUCID_STEPS_DIR;
    _resetStepsForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  test("record → endTurn → read: thinking + tools + failure land under the right turn", () => {
    beginStepTurn("s1");
    noteStepEvent("s1", { type: "thinking", text: "planning " });
    noteStepEvent("s1", { type: "thinking", text: "the fix" });
    noteStepEvent("s1", { type: "tool", name: "read", detail: "app.ts" });
    noteStepEvent("s1", { type: "block", tool: "bash", reason: "tool failed: exit 127", command: "make", quarantined: false });
    endStepTurn("s1");
    const out = readTurnSteps("s1");
    expect(out.length).toBe(1);
    expect(out[0]!.turn).toBe(1);
    expect(out[0]!.thinking).toBe("planning the fix"); // chunks buffered → ONE record
    expect(out[0]!.tools).toEqual([{ name: "read", detail: "app.ts" }]);
    expect(out[0]!.fails[0]!.command).toBe("make");
  });

  test("a REAL quarantine (quarantined !== false) is NOT recorded here — it lives in the security ledger", () => {
    beginStepTurn("s1");
    noteStepEvent("s1", { type: "block", tool: "write", reason: "hidden unicode", quarantined: true });
    noteStepEvent("s1", { type: "block", tool: "write", reason: "hidden unicode" });
    endStepTurn("s1");
    expect(readTurnSteps("s1")).toEqual([]);
  });

  test("token and other events are ignored (hot-path early return)", () => {
    beginStepTurn("s1");
    noteStepEvent("s1", { type: "token", text: "hello" });
    noteStepEvent("s1", { type: "usage" });
    endStepTurn("s1");
    expect(readTurnSteps("s1")).toEqual([]);
  });

  test("turn ordinals survive a GUI restart (reseeded from the sidecar itself)", () => {
    beginStepTurn("s1");
    noteStepEvent("s1", { type: "tool", name: "a", detail: "" });
    _resetStepsForTest(); // app restart
    beginStepTurn("s1");
    noteStepEvent("s1", { type: "tool", name: "b", detail: "" });
    const out = readTurnSteps("s1");
    expect(out.map((g) => g.turn)).toEqual([1, 2]);
  });

  test("syncStepTurns only ever raises — turns run outside the GUI shift the NEXT anchor forward", () => {
    beginStepTurn("s1"); // turn 1 in the GUI
    syncStepTurns("s1", 5); // transcript says 5 user messages exist (4 happened in the TUI)
    beginStepTurn("s1");
    noteStepEvent("s1", { type: "tool", name: "x", detail: "" });
    endStepTurn("s1");
    expect(readTurnSteps("s1").at(-1)!.turn).toBe(6);
    syncStepTurns("s1", 2); // a lower count can never pull anchors backwards
    beginStepTurn("s1");
    noteStepEvent("s1", { type: "tool", name: "y", detail: "" });
    expect(readTurnSteps("s1").at(-1)!.turn).toBe(7);
  });

  test("events before any known turn are dropped, never misattached", () => {
    noteStepEvent("s-fresh", { type: "tool", name: "x", detail: "" });
    expect(readTurnSteps("s-fresh")).toEqual([]);
  });

  test("blank / hostile session ids can't write outside the steps dir", () => {
    beginStepTurn("");
    beginStepTurn(null);
    beginStepTurn("../../evil");
    noteStepEvent("../../evil", { type: "tool", name: "x", detail: "" });
    const names = readdirSync(dir);
    for (const n of names) expect(n.endsWith(".jsonl")).toBe(true); // everything stays inside, sanitized
    expect(readTurnSteps("..")).toEqual([]); // ids that sanitize to nothing are refused
  });

  test("deleteSteps removes the sidecar with its session", () => {
    beginStepTurn("s1");
    noteStepEvent("s1", { type: "tool", name: "a", detail: "" });
    endStepTurn("s1");
    expect(readTurnSteps("s1").length).toBe(1);
    deleteSteps("s1");
    expect(readTurnSteps("s1")).toEqual([]);
  });
});
