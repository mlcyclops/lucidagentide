// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/recovery_supervisor.test.ts - P-RECOVER.1 (ADR-0385). The supervisor exists because a
// prompt sat on "reconnecting" forever. These defend the two things that matter: each remedy is chosen
// for the right observation, and every path ENDS (a remedy used once is never asked for again).

import { describe, expect, test } from "bun:test";
import {
  MAX_RUNS_PER_WINDOW, MAX_STEPS, RUN_WINDOW_MS, afterProbe, afterRemedy, isIncidentIssueUrl, mayStartRun, probeFrom,
  recoveryStateFrom, startRecovery, type EngineProbe, type RecoveryAction, type RecoveryStep,
} from "./recovery_supervisor.ts";

const DOWN: EngineProbe = { engineReachable: false, turnRunning: null, masterDead: false, exhausted: false };
const IDLE: EngineProbe = { engineReachable: true, turnRunning: false, masterDead: false, exhausted: false };
const RUNNING: EngineProbe = { ...IDLE, turnRunning: true };
const DEAD: EngineProbe = { ...IDLE, masterDead: true };

const reconnecting = (waiting = true) => startRecovery({ kind: "connection", state: "reconnecting" }, { waiting });
const probe = (s: RecoveryStep, p: EngineProbe) => afterProbe(s.run, p);

describe("engine unreachable", () => {
  test("three unreachable probes in a row ask for the engine restart, and only then", () => {
    let s = reconnecting();
    s = probe(s, DOWN);
    expect(s.action.type).toBe("probe");
    s = probe(s, DOWN);
    expect(s.action.type).toBe("probe");
    s = probe(s, DOWN);
    expect(s.action).toEqual({ type: "restart-engine" });
  });

  test("a reachable probe resets the streak", () => {
    let s = reconnecting();
    s = probe(s, DOWN); s = probe(s, DOWN);
    s = probe(s, RUNNING); // reattach
    s = afterRemedy(s.run, { action: "reattach", ok: false });
    s = probe(s, DOWN); s = probe(s, DOWN);
    expect(s.action.type).toBe("probe");
  });

  test("the restart is asked for once: still unreachable after a refused restart gives up", () => {
    let s = reconnecting();
    for (let i = 0; i < 3; i++) s = probe(s, DOWN);
    s = afterRemedy(s.run, { action: "restart-engine", ok: false, reason: "engine-healthy" });
    expect(s.action.type).toBe("probe");
    for (let i = 0; i < 3; i++) s = probe(s, DOWN);
    expect(s.action).toEqual({ type: "give-up", reason: "engine-unreachable" });
  });

  test("a restart already used this page is never repeated by a later run", () => {
    let s = startRecovery({ kind: "connection", state: "failed" }, { waiting: true, engineRestartUsed: true });
    for (let i = 0; i < 3; i++) s = probe(s, DOWN);
    expect(s.action).toEqual({ type: "give-up", reason: "engine-unreachable" });
  });

  test("a failed restart gives up and carries main's reason", () => {
    let s = reconnecting();
    for (let i = 0; i < 3; i++) s = probe(s, DOWN);
    s = afterRemedy(s.run, { action: "restart-engine", ok: false, reason: "rate-limited" });
    expect(s.action).toEqual({ type: "give-up", reason: "engine-not-restarted", detail: "rate-limited" });
  });

  test("a successful restart is done", () => {
    let s = reconnecting();
    for (let i = 0; i < 3; i++) s = probe(s, DOWN);
    expect(afterRemedy(s.run, { action: "restart-engine", ok: true }).action).toEqual({ type: "done", how: "engine-restarted" });
  });
});

describe("engine reachable", () => {
  test("a dead master child gets the agent recovery once; dead again gives up", () => {
    let s = reconnecting();
    s = probe(s, DEAD);
    expect(s.action).toEqual({ type: "recover-agent" });
    s = afterRemedy(s.run, { action: "recover-agent", ok: false });
    expect(s.action.type).toBe("probe");
    s = probe(s, DEAD);
    expect(s.action).toEqual({ type: "give-up", reason: "agent-not-recovered" });
  });

  test("an exhausted ladder is treated like a dead child", () => {
    const s = probe(reconnecting(), { ...RUNNING, exhausted: true });
    expect(s.action).toEqual({ type: "recover-agent" });
  });

  test("after the agent recovery a waiting view resyncs, and the result says the agent was restarted", () => {
    let s = probe(reconnecting(), DEAD);
    s = afterRemedy(s.run, { action: "recover-agent", ok: true });
    expect(s.action).toEqual({ type: "resync" });
    expect(afterRemedy(s.run, { action: "resync", ok: true }).action).toEqual({ type: "done", how: "agent-recovered" });
  });

  test("a running turn is reattached; success is done", () => {
    let s = probe(reconnecting(), RUNNING);
    expect(s.action).toEqual({ type: "reattach" });
    s = afterRemedy(s.run, { action: "reattach", ok: true });
    expect(s.action).toEqual({ type: "done", how: "reattached" });
  });

  test("reattach is bounded: a turn that keeps refusing it gives up", () => {
    let s = reconnecting();
    for (let i = 0; i < 2; i++) {
      s = probe(s, RUNNING);
      expect(s.action.type).toBe("reattach");
      s = afterRemedy(s.run, { action: "reattach", ok: false });
    }
    expect(probe(s, RUNNING).action).toEqual({ type: "give-up", reason: "turn-unreachable" });
  });

  test("reachable and idle while the view waits: stop waiting and resync", () => {
    const s = probe(reconnecting(), IDLE);
    expect(s.action).toEqual({ type: "resync" });
    expect(afterRemedy(s.run, { action: "resync", ok: true }).action).toEqual({ type: "done", how: "resynced" });
    expect(afterRemedy(s.run, { action: "resync", ok: false }).action).toEqual({ type: "give-up", reason: "resync-failed" });
  });

  test("an unreadable turn status does not count as a running turn", () => {
    expect(probe(reconnecting(), { ...IDLE, turnRunning: null }).action).toEqual({ type: "resync" });
  });
});

describe("a refused send ('A chat turn is already running')", () => {
  const refused = () => startRecovery({ kind: "send-failed", reason: "already-running" }, { waiting: false });

  test("engine says idle: that is the wedge, so the agent is recovered once and then it is done", () => {
    let s = probe(refused(), IDLE);
    expect(s.action).toEqual({ type: "recover-agent" });
    s = afterRemedy(s.run, { action: "recover-agent", ok: true });
    expect(s.action).toEqual({ type: "done", how: "agent-recovered" });
  });

  test("both remedies failed: the agent recovery failed and the engine then stopped answering past its restart", () => {
    let s = probe(refused(), IDLE);
    s = afterRemedy(s.run, { action: "recover-agent", ok: false });
    for (let i = 0; i < 3; i++) s = probe(s, DOWN);
    expect(s.action).toEqual({ type: "restart-engine" });
    s = afterRemedy(s.run, { action: "restart-engine", ok: false, reason: "spawn-failed" });
    expect(s.action.type).toBe("give-up");
    expect(s.run.finished).toBe(true);
  });

  test("agent recovery failed and the engine still says idle: give up rather than recover again", () => {
    let s = probe(refused(), IDLE);
    s = afterRemedy(s.run, { action: "recover-agent", ok: false });
    expect(probe(s, IDLE).action).toEqual({ type: "give-up", reason: "agent-not-recovered" });
  });

  test("a send that only lost the engine is done once the engine answers idle", () => {
    const s = startRecovery({ kind: "send-failed", reason: "unreachable" }, { waiting: false });
    expect(probe(s, IDLE).action).toEqual({ type: "done", how: "engine-ready" });
  });
});

describe("termination", () => {
  test("a finished run ignores further observations", () => {
    const s = afterRemedy(probe(reconnecting(), RUNNING).run, { action: "reattach", ok: true });
    expect(afterProbe(s.run, DEAD).action).toEqual(s.action);
    expect(afterRemedy(s.run, { action: "recover-agent", ok: true }).action).toEqual(s.action);
  });

  test("no observation sequence runs forever", () => {
    // An adversarial engine: every probe flips between answers chosen to keep the run alive.
    const answers: EngineProbe[] = [DOWN, DOWN, RUNNING, DEAD, IDLE, DOWN, RUNNING];
    let s = reconnecting();
    let n = 0;
    const remedyFor = (a: RecoveryAction) => a.type === "restart-engine"
      ? { action: a.type, ok: false, reason: "engine-healthy" } as const
      : { action: a.type as "reattach" | "recover-agent" | "resync", ok: false };
    while (!s.run.finished) {
      n++;
      expect(n).toBeLessThanOrEqual(MAX_STEPS + 1);
      s = s.action.type === "probe" ? probe(s, answers[n % answers.length]!) : afterRemedy(s.run, remedyFor(s.action));
    }
    expect(["give-up", "done"]).toContain(s.action.type);
  });

  test("automatic runs are capped per window", () => {
    const now = 1_000_000;
    const starts = Array.from({ length: MAX_RUNS_PER_WINDOW }, (_, i) => now - i * 1000);
    expect(mayStartRun(starts, now)).toBe(false);
    expect(mayStartRun(starts.slice(1), now)).toBe(true);
    expect(mayStartRun(starts.map((t) => t - RUN_WINDOW_MS), now)).toBe(true);
  });
});

describe("probe mapping", () => {
  test("an engine that answers anything is reachable; neither answering is not", () => {
    expect(probeFrom({ reached: false, data: null }, { reached: false, ok: false, data: null }).engineReachable).toBe(false);
    expect(probeFrom({ reached: true, data: null }, { reached: false, ok: false, data: null }).engineReachable).toBe(true);
  });

  test("no turn ever (status data null) is idle; a failed status read is unknown", () => {
    expect(probeFrom({ reached: true, data: null }, { reached: true, ok: true, data: null }).turnRunning).toBe(false);
    expect(probeFrom({ reached: true, data: null }, { reached: true, ok: false, data: null }).turnRunning).toBe(null);
    expect(probeFrom({ reached: true, data: null }, { reached: true, ok: true, data: { running: true } }).turnRunning).toBe(true);
  });

  test("dead and exhausted are read from session-health master, true only when literally true", () => {
    const p = probeFrom({ reached: true, data: { master: { dead: true, exhausted: "yes" } } }, { reached: true, ok: true, data: null });
    expect(p.masterDead).toBe(true);
    expect(p.exhausted).toBe(false);
  });
});

describe("wire shapes", () => {
  const incident = { id: "20260923T101500Z-ab12", kind: "unclean-shutdown", outcome: "pending", createdAt: 1, issueTitle: "t", issueBody: "b", issueUrl: "https://github.com/x", reportPath: "/r", seen: false };

  test("malformed incidents are dropped, never passed on", () => {
    const st = recoveryStateFrom({ previous: { sessionId: "s1", cwd: "c", at: 2 }, currentSessionId: null, incidents: [incident, { ...incident, id: "../../etc" }, { ...incident, kind: "made-up" }] });
    expect(st?.incidents.map((i) => i.id)).toEqual([incident.id]);
    expect(st?.previous?.sessionId).toBe("s1");
  });

  test("a previous session without an id is no previous session", () => {
    expect(recoveryStateFrom({ previous: { sessionId: "" }, incidents: [] })?.previous).toBe(null);
  });

  test("only a new-issue URL on the upstream repository may be opened", () => {
    expect(isIncidentIssueUrl("https://github.com/mlcyclops/lucidagentide/issues/new?title=a&body=b")).toBe(true);
    expect(isIncidentIssueUrl("http://github.com/mlcyclops/lucidagentide/issues/new?title=a")).toBe(false);
    expect(isIncidentIssueUrl("https://github.com.evil.example/mlcyclops/lucidagentide/issues/new")).toBe(false);
    expect(isIncidentIssueUrl("https://github.com/someone-else/repo/issues/new")).toBe(false);
    expect(isIncidentIssueUrl("https://user@github.com/mlcyclops/lucidagentide/issues/new")).toBe(false);
    expect(isIncidentIssueUrl("javascript:alert(1)")).toBe(false);
  });
});
