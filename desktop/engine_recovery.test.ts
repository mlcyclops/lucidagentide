// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/engine_recovery.test.ts - P-RECOVER.1 (ADR-0384): the last-session record, request validation for
// the recovery/incident routes, and the incident view the window receives.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INCIDENT_NOTE_MAX, incidentView, logTail, parseIncidentIdBody, parseIncidentUpdate, parseResumeBody, readLastSession, writeLastSession } from "./engine_recovery.ts";
import { recordIncident } from "./incident_store.ts";

const DIR = mkdtempSync(join(tmpdir(), "lucid-engine-recovery-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("last-session record", () => {
  test("round-trips, and the newest write wins", () => {
    const path = join(DIR, "nested", "lucid-last-session-5319.json");
    expect(writeLastSession(path, { sessionId: "019a-first", cwd: "C:/work", at: 1 })).toBe(true);
    expect(writeLastSession(path, { sessionId: "019a-second", cwd: "C:/work", at: 2 })).toBe(true);
    expect(readLastSession(path)).toEqual({ sessionId: "019a-second", cwd: "C:/work", at: 2 });
  });

  test("a record that is corrupt or names a path-like id is ignored, never offered for resume", () => {
    const path = join(DIR, "bad.json");
    for (const body of ["{not json", JSON.stringify({ sessionId: "../../etc/passwd", cwd: "x", at: 1 }), JSON.stringify({ sessionId: "ok-id", cwd: 7, at: 1 })]) {
      writeFileSync(path, body);
      expect(readLastSession(path)).toBeNull();
    }
    expect(readLastSession(join(DIR, "absent.json"))).toBeNull();
    expect(writeLastSession(path, { sessionId: "a/b", cwd: "x", at: 1 })).toBe(false);
  });
});

describe("route body validation", () => {
  test("resume accepts a session id and refuses anything that could address a path or is not a string", () => {
    expect(parseResumeBody({ sessionId: "019a3f2c-7d1e" })).toEqual({ ok: true, value: { sessionId: "019a3f2c-7d1e" } });
    for (const bad of [null, [], { sessionId: 42 }, { sessionId: "" }, { sessionId: "..\\x" }, { sessionId: "a b" }, { sessionId: "x".repeat(129) }]) {
      expect(parseResumeBody(bad).ok).toBe(false);
    }
  });

  test("incident ids must have the store's shape", () => {
    expect(parseIncidentIdBody({ id: "20260923T101500Z-a1b2" }).ok).toBe(true);
    for (const id of ["../20260923T101500Z-a1b2", "20260923T101500Z-A1B2", 5, undefined]) expect(parseIncidentIdBody({ id }).ok).toBe(false);
  });

  test("update requires a known outcome and caps the note at the limit", () => {
    const id = "20260923T101500Z-a1b2";
    expect(parseIncidentUpdate({ id, outcome: "recovered" })).toEqual({ ok: true, value: { id, outcome: "recovered" } });
    expect(parseIncidentUpdate({ id, outcome: "fixed" }).ok).toBe(false);
    expect(parseIncidentUpdate({ id, outcome: "pending", note: 3 }).ok).toBe(false);
    expect(parseIncidentUpdate({ id, outcome: "not-recovered", note: "x".repeat(INCIDENT_NOTE_MAX) }).ok).toBe(true);
    expect(parseIncidentUpdate({ id, outcome: "not-recovered", note: "x".repeat(INCIDENT_NOTE_MAX + 1) }).ok).toBe(false);
  });
});

describe("incident view", () => {
  test("reportPath is derived from the directory and id, not trusted from the metadata file", () => {
    const dir = join(DIR, "incidents");
    const meta = recordIncident({ kind: "agent-child-failed", outcome: "recovered", product: "LucidAgentIDE", version: "0.0.0", platform: "win32", arch: "x64", summary: "s", events: [] }, dir);
    expect(meta).not.toBeNull();
    const view = incidentView({ ...meta!, reportPath: "C:/Windows/System32/config/SAM" }, dir);
    expect(view.reportPath).toBe(join(dir, `${meta!.id}.md`));
    expect(view.issueUrl.startsWith("https://github.com/")).toBe(true);
    expect(view.seen).toBe(false);
  });
});

test("logTail keeps the newest text of a long log", () => {
  const path = join(DIR, "acp.log");
  writeFileSync(path, `${"old line\n".repeat(5000)}the last line`);
  const tail = logTail(path, 100);
  expect(tail.length).toBe(100);
  expect(tail.endsWith("the last line")).toBe(true);
  expect(logTail(join(DIR, "missing.log"))).toBe("");
});
