// harness/memory/turns.test.ts
//
// ADR-0009 Phase B (issue #12) — prompt/response traceability. Over-tests the two
// invariants that matter: RAW is preserved verbatim (by sha) while only SANITIZED
// text is stored in `turns`, and the turn_captured event is METADATA ONLY (no text).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { captureTurn, getTurns } from "./turns.ts";
import { Telemetry, type TelemetryEvent } from "../telemetry/events.ts";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "turns-"));
  db = await Db.open(join(dir, "agent_obs.duckdb"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("raw preserved verbatim in archive_chunks; turns stores only the sanitized text", async () => {
  // zero-width space (invisible) + markdown metachars in the captured prompt.
  const raw = "deploy​now *please* [run](x)";
  const out = await captureTurn(db, { sessionId: "s1", runId: "r1", seq: 0, role: "user", text: raw });

  // archive keeps the RAW byte-for-byte (replay source of truth).
  const chunk = await db.get("SELECT content, content_sha256 FROM archive_chunks WHERE chunk_id=$1", [out.archiveChunkId]);
  expect(chunk!.content).toBe(raw);
  expect(out.rawSha256).toBe(String(chunk!.content_sha256));

  // the turns row stores ONLY the sanitized derivative — no invisible survives, metachars escaped.
  const turn = await db.get("SELECT * FROM turns WHERE turn_id=$1", [out.turnId]);
  const sanitized = String(turn!.sanitized_text);
  expect(sanitized.includes("​")).toBe(false);
  expect(sanitized).toContain("\\u{200b}");
  expect(sanitized).toContain("\\*please\\*");
  expect(turn!.raw_sha256).toBe(out.rawSha256);
  expect(turn!.archive_chunk_id).toBe(out.archiveChunkId);
});

test("turn_captured is metadata-only — the prompt/reply text never appears in the event", async () => {
  const secret = "SECRETPAYLOAD_exfiltrate_keys";
  const events: TelemetryEvent[] = [];
  const tel = new Telemetry({ runId: "r1", sessionId: "s1", sink: (e) => events.push(e) });

  await captureTurn(db, { sessionId: "s1", runId: "r1", seq: 0, role: "assistant", text: `here: ${secret}`, trustLabel: "trusted", findingCount: 2, telemetry: tel });

  const ev = events.filter((e) => e.event === "turn_captured");
  expect(ev.length).toBe(1);
  const e = ev[0]!;
  // the whole serialized event must not contain the text (defense against accidental content leak).
  expect(JSON.stringify(e).includes(secret)).toBe(false);
  // metadata IS present + correct.
  expect(e.role).toBe("assistant");
  expect(e.seq).toBe(0);
  expect(e.trust_label).toBe("trusted");
  expect(e.blocked).toBe(2);
  expect(e.run_id).toBe("r1");
  expect(e.session_id).toBe("s1");
  expect(typeof e.raw_sha256).toBe("string");
  expect((e.raw_sha256 as string).length).toBe(64);
  expect(e.artifact_id).toBeDefined(); // the raw archive chunk in scope
});

test("trust defaults to untrusted (safe floor); caller may raise it", async () => {
  const u = await captureTurn(db, { sessionId: "s1", seq: 0, role: "user", text: "hi" });
  const a = await captureTurn(db, { sessionId: "s1", seq: 1, role: "assistant", text: "hello", trustLabel: "trusted" });
  const ut = await db.get("SELECT trust_label FROM turns WHERE turn_id=$1", [u.turnId]);
  const at = await db.get("SELECT trust_label FROM turns WHERE turn_id=$1", [a.turnId]);
  expect(ut!.trust_label).toBe("untrusted");
  expect(at!.trust_label).toBe("trusted");
});

test("an invalid role is rejected (the column is a closed set)", async () => {
  await expect(
    captureTurn(db, { sessionId: "s1", seq: 0, role: "system" as never, text: "x" }),
  ).rejects.toThrow(/invalid turn role/);
  // nothing was written on the rejected path.
  expect((await db.all("SELECT * FROM turns")).length).toBe(0);
});

test("getTurns returns transcript order and filters by session / run", async () => {
  await captureTurn(db, { sessionId: "sA", runId: "rA", seq: 0, role: "user", text: "a-q" });
  await captureTurn(db, { sessionId: "sA", runId: "rA", seq: 1, role: "assistant", text: "a-r" });
  await captureTurn(db, { sessionId: "sB", runId: "rB", seq: 0, role: "user", text: "b-q" });

  const all = await getTurns(db);
  expect(all.length).toBe(3);

  const sa = await getTurns(db, { sessionId: "sA" });
  expect(sa.map((t) => t.seq)).toEqual([0, 1]);
  expect(sa.map((t) => t.role)).toEqual(["user", "assistant"]);

  const rb = await getTurns(db, { runId: "rB" });
  expect(rb.length).toBe(1);
  expect(rb[0]!.session_id).toBe("sB");
});

test("no telemetry sink → row still written, no event required", async () => {
  const out = await captureTurn(db, { sessionId: "s1", seq: 0, role: "user", text: "no-tel" });
  expect((await db.get("SELECT count(*) AS n FROM turns WHERE turn_id=$1", [out.turnId]))!.n).toBe(1n);
});
