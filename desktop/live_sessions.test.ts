// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SESS-ARCHIVE.1 (ADR-0471): archiving must see sessions held by OTHER running engines, and must not be
// blocked forever by a record a dead or hung engine left behind.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_STALE_MS, otherEnginesSessions, publishLiveSessions, withdrawLiveSessions } from "./live_sessions.ts";

const dir = mkdtempSync(join(tmpdir(), "lucid-live-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const NOW = 1_800_000_000_000;

test("another living engine's sessions are held; our own, dead, stale and malformed records are not", () => {
  publishLiveSessions(["mine"], dir, 100, NOW);
  publishLiveSessions(["theirs-a", "theirs-b"], dir, 200, NOW - 10_000);
  publishLiveSessions(["dead"], dir, 300, NOW);
  publishLiveSessions(["hung"], dir, 400, NOW - LIVE_STALE_MS - 1);
  writeFileSync(join(dir, "engine-500.json"), "{not json");
  const alive = (pid: number): boolean => pid !== 300;
  expect([...otherEnginesSessions(dir, 100, NOW, alive)].sort()).toEqual(["theirs-a", "theirs-b"]);
  expect(existsSync(join(dir, "engine-300.json"))).toBe(false); // a dead engine's record is cleaned up
  expect(existsSync(join(dir, "engine-400.json"))).toBe(true); // a stale one is ignored, not deleted (its pid lives)
});

test("withdrawing on exit releases the sessions at once", () => {
  withdrawLiveSessions(dir, 200);
  expect(otherEnginesSessions(dir, 100, NOW, () => true).has("theirs-a")).toBe(false);
});
