// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/turns_log.test.ts — ADR-0009 Phase B (issue #12)
//
// The GUI-side turn capture must: emit a valid, METADATA-ONLY turn_captured event (never the
// prompt/reply text), and persist only the SANITIZED transcript + the raw's sha (never the raw).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTurns } from "./turns_log.ts";
import { isEventName } from "../harness/contracts.ts";
import type { TelemetryEvent as Ev } from "../harness/telemetry/events.ts";

let dir: string;
let logPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "turnslog-")); logPath = join(dir, "lucid-turns.jsonl"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("turn_captured is a valid EventName and is emitted per role, metadata-only", () => {
  const got: Ev[] = [];
  const secret = "SECRET_exfil_token";
  recordTurns(
    { sessionId: "sess-9", userText: `do it: ${secret}`, assistantText: `ok ${secret}` },
    { sink: (e) => got.push(e), logPath },
  );

  expect(isEventName("turn_captured")).toBe(true);
  expect(got.map((e) => e.event)).toEqual(["turn_captured", "turn_captured"]);
  expect(got.map((e) => e.role)).toEqual(["user", "assistant"]);
  expect(got.map((e) => e.trust_label)).toEqual(["untrusted", "trusted"]);
  // strictly metadata: the prompt/reply text must not appear anywhere in the events.
  expect(JSON.stringify(got).includes(secret)).toBe(false);
  for (const e of got) {
    expect(typeof e.event_id).toBe("string");
    expect(e.session_id).toBe("sess-9");
    expect((e.raw_sha256 as string).length).toBe(64);
    expect("sanitized" in e).toBe(false);
  }
});

test("the JSONL sidecar stores only sanitized text + sha — never the raw, never an invisible", () => {
  const raw = "zip​it *now* [x](y)"; // contains a zero-width space
  recordTurns({ sessionId: "s", userText: raw, assistantText: "" }, { sink: () => {}, logPath });

  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  expect(lines.length).toBe(1); // empty assistantText → no second row
  const rec = JSON.parse(lines[0]!);
  expect(rec.role).toBe("user");
  expect(rec.sanitized.includes("​")).toBe(false); // no invisible survives
  expect(rec.sanitized).toContain("\\u{200b}");
  expect(rec.sanitized).toContain("\\*now\\*");
  expect(rec.rawSha256.length).toBe(64);
  // the raw text itself is NOT persisted GUI-side (only its hash).
  expect(JSON.stringify(rec).includes(raw)).toBe(false);
});

test("a turn with no sessionId or no user text is a no-op", () => {
  const got: Ev[] = [];
  recordTurns({ sessionId: "", userText: "x", assistantText: "y" }, { sink: (e) => got.push(e), logPath });
  recordTurns({ sessionId: "s", userText: "", assistantText: "y" }, { sink: (e) => got.push(e), logPath });
  expect(got.length).toBe(0);
});
