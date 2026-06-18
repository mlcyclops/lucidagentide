// harness/security/approvals.test.ts

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { recordApproval } from "./approvals.ts";
import { Telemetry, type TelemetryEvent } from "../telemetry/events.ts";

let dir: string;
let db: Db;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "approvals-test-"));
  db = await Db.open(join(dir, "t.duckdb"));
  // a parent artifact for FK-friendly references
  await db.run(
    `INSERT INTO content_artifacts (artifact_id, source_type, trust_label, raw_sha256, created_at)
     VALUES ('art-1','import','quarantined','deadbeef', now())`,
  );
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("recordApproval persists an audited row", async () => {
  const id = await recordApproval(db, {
    artifactId: "art-1",
    action: "deny",
    decidedBy: "nick",
    rationale: "homoglyph spoof",
    scope: "tool_call",
  });
  const row = await db.get("SELECT * FROM approval_events WHERE approval_id=$1", [id]);
  expect(row?.action).toBe("deny");
  expect(row?.decided_by).toBe("nick");
  expect(row?.rationale).toBe("homoglyph spoof");
  expect(row?.scope).toBe("tool_call");
});

test("deny emits approval_denied; other actions emit approval_granted", async () => {
  const events: TelemetryEvent[] = [];
  const tel = new Telemetry({ runId: "r", sessionId: "s", sink: (e) => events.push(e) });

  await recordApproval(db, { artifactId: "art-1", action: "deny", decidedBy: "u" }, tel);
  await recordApproval(db, { artifactId: "art-1", action: "quarantine_release", decidedBy: "u" }, tel);
  await recordApproval(db, { artifactId: "art-1", action: "approve", decidedBy: "u" }, tel);

  const names = events.map((e) => e.event);
  expect(names).toEqual(["approval_denied", "approval_granted", "approval_granted"]);
});

test("approval can stand alone without an artifact", async () => {
  const id = await recordApproval(db, { action: "approve", decidedBy: "u", scope: "session" });
  const row = await db.get("SELECT artifact_id, action FROM approval_events WHERE approval_id=$1", [id]);
  expect(row?.artifact_id).toBeNull();
  expect(row?.action).toBe("approve");
});
