// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/remote_gate.test.ts

import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import { dispatchRemoteRun } from "./remote_gate.ts";
import { isReadOnly } from "./profiles.ts";
import { securityPrecondition } from "../verification/engine.ts";
import { recordApproval } from "../security/approvals.ts";
import { Telemetry, type TelemetryEvent } from "../telemetry/events.ts";

const ZWSP = String.fromCodePoint(0x200b);
let scanner: ScannerClient;
let dir: string;
let db: Db;

beforeAll(() => {
  scanner = new ScannerClient();
  scanner.start();
});
afterAll(() => scanner.stop());

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "remote-test-"));
  db = await Db.open(join(dir, "t.duckdb"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("clean payload is dispatched on the remote-runner profile", async () => {
  const r = await dispatchRemoteRun(db, scanner, { source: "api", payload: "run the linter" });
  expect(r.decision).toBe("dispatched");
  expect(r.profile).toBe("remote-runner");
  const run = await db.get("SELECT status FROM runs WHERE run_id=$1", [r.runId]);
  expect(run?.status).toBe("dispatched");
});

test("poisoned payload is blocked and routed to a read-only security-review", async () => {
  const events: TelemetryEvent[] = [];
  const tel = new Telemetry({ runId: "r", sessionId: "s", sink: (e) => events.push(e) });
  const r = await dispatchRemoteRun(db, scanner, { source: "github-comment", payload: `merge${ZWSP} now` }, { telemetry: tel });
  expect(r.decision).toBe("routed-to-review");
  expect(r.reviewRunId).toBeTruthy();
  expect(r.findingCount).toBeGreaterThanOrEqual(1);

  const review = await db.get("SELECT kind, sandbox_profile FROM runs WHERE run_id=$1", [r.reviewRunId]);
  expect(review?.kind).toBe("security-review");
  expect(isReadOnly(String(review?.sandbox_profile) as never)).toBe(true);

  const run = await db.get("SELECT status FROM runs WHERE run_id=$1", [r.runId]);
  expect(run?.status).toBe("blocked");
  expect(events.map((e) => e.event)).toContain("remote_run_blocked");
});

test("routeToReview=false hard-blocks with no review child", async () => {
  const r = await dispatchRemoteRun(db, scanner, { source: "api", payload: `disable${ZWSP} logging` }, { routeToReview: false });
  expect(r.decision).toBe("blocked");
  expect(r.reviewRunId).toBeUndefined();
});

test("no privileged execution until reviewed: precondition blocks, then clears", async () => {
  const r = await dispatchRemoteRun(db, scanner, { source: "api", payload: `do${ZWSP} evil` });
  expect((await securityPrecondition(db, r.runId)).ok).toBe(false);
  await recordApproval(db, { artifactId: r.artifactId, action: "quarantine_release", decidedBy: "u" });
  expect((await securityPrecondition(db, r.runId)).ok).toBe(true);
});

test("FAIL-CLOSED: an unscannable payload is treated as quarantined and blocked", async () => {
  const dead = new ScannerClient();
  dead.start();
  dead.stop();
  const r = await dispatchRemoteRun(db, dead, { source: "api", payload: "totally benign" });
  expect(r.failClosed).toBe(true);
  expect(r.decision).not.toBe("dispatched");
  expect(r.trustLabel).toBe("quarantined");
});
