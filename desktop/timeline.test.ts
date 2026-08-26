// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-FLEET.L5: the reviewable timeline. What matters: sessions from EVERY workspace merge newest-first,
// a ledger-matched session is a LANE row carrying its lane name (latest record wins), ingest throwaways
// classify from the parser's own kind, a torn ledger line never breaks the read, and the on-disk .jsonl
// corpus is the truth this module only READS.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLaneLedger, buildTimeline, listTimeline, readLaneLedger } from "./timeline.ts";
import { __resetSessionIndex } from "./sessions.ts";
import type { LaneSessionRecord } from "./fleet_lanes.ts";

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); __resetSessionIndex(); });

/** Write one omp-shaped session .jsonl and pin its mtime so ordering is deterministic. */
function writeSession(root: string, dir: string, file: string, o: { id: string; cwd: string; user: string; model?: string; atSec: number }): void {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  const p = join(d, file);
  const lines = [
    JSON.stringify({ type: "session", id: o.id, cwd: o.cwd }),
    JSON.stringify({ type: "message", message: { role: "user", content: o.user } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: "done", usage: { output_tokens: 5 }, model: o.model ?? "claude-fable-5" } }),
  ];
  writeFileSync(p, `${lines.join("\n")}\n`);
  utimesSync(p, o.atSec, o.atSec);
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lucid-tl-"));
  tmp.push(root);
  return root;
}

const rec = (o: Partial<LaneSessionRecord> = {}): LaneSessionRecord =>
  ({ at: 1_000, laneId: "lane-abc123", name: "worker", cwd: "C:/repos/beta", sessionId: "s-lane", event: "spawn", ...o });

test("sessions from different workspaces merge newest-first, lanes labeled through the ledger", () => {
  const root = fixtureRoot();
  writeSession(root, "enc-alpha", "a.jsonl", { id: "s-chat", cwd: "C:/repos/alpha", user: "fix the login bug", atSec: 3_000 });
  writeSession(root, "enc-beta", "b.jsonl", { id: "s-lane", cwd: "C:/repos/beta", user: "run the migration", atSec: 2_000 });
  const page = buildTimeline(
    // reuse the real corpus reader so the fixture shape is honest
    listTimeline({}, root, join(root, "no-ledger.jsonl")).entries.map((e) => ({ id: e.sessionId, title: e.title, model: e.model, turns: e.turns, kind: "chat" as const, updatedAt: e.updatedAt, cwd: e.cwd })),
    [rec()],
  );
  expect(page.total).toBe(2);
  expect(page.entries[0]!.sessionId).toBe("s-chat");     // newest first
  expect(page.entries[0]!.kind).toBe("chat");
  expect(page.entries[0]!.wsName).toBe("alpha");
  expect(page.entries[1]!.kind).toBe("lane");            // ledger-matched
  expect(page.entries[1]!.laneName).toBe("worker");
  expect(page.entries[1]!.laneId).toBe("lane-abc123");
}, 15_000);

test("listTimeline end-to-end: corpus + ledger from disk, ingest classified by the parser", () => {
  const root = fixtureRoot();
  const ledger = join(root, "lanes.jsonl");
  writeSession(root, "enc-a", "chat.jsonl", { id: "s-1", cwd: "C:/w/alpha", user: "hello there", atSec: 5_000 });
  writeSession(root, "enc-b", "lane.jsonl", { id: "s-2", cwd: "C:/w/beta", user: "lane work", atSec: 4_000 });
  appendLaneLedger(rec({ sessionId: "s-2", name: "etl", laneId: "lane-e1" }), ledger);
  const page = listTimeline({}, root, ledger);
  expect(page.entries.map((e) => e.sessionId)).toEqual(["s-1", "s-2"]);
  expect(page.entries[1]!.kind).toBe("lane");
  expect(page.entries[1]!.laneName).toBe("etl");
  expect(page.entries[0]!.kind).toBe("chat");
});

test("the LATEST ledger record names the lane; spawn+respawn count as laneEvents", () => {
  const ledger: LaneSessionRecord[] = [
    rec({ at: 1_000, name: "old-name", event: "spawn" }),
    rec({ at: 2_000, name: "renamed", event: "respawn" }),
  ];
  const sessions = [{ id: "s-lane", title: "t", model: "m", turns: 1, kind: "chat" as const, updatedAt: 9, cwd: "C:/repos/beta" }];
  const page = buildTimeline(sessions, ledger);
  expect(page.entries[0]!.laneName).toBe("renamed");
  expect(page.entries[0]!.laneEvents).toBe(2);
});

test("a torn or junk ledger line is skipped, never fatal; a missing ledger is empty", () => {
  const root = fixtureRoot();
  const ledger = join(root, "lanes.jsonl");
  appendLaneLedger(rec(), ledger);
  writeFileSync(ledger, `${JSON.stringify(rec())}\n{"torn": tr\nnot json at all\n${JSON.stringify(rec({ sessionId: "s-2" }))}\n`);
  const rows = readLaneLedger(ledger);
  expect(rows.length).toBe(2);
  expect(readLaneLedger(join(root, "absent.jsonl"))).toEqual([]);
});

test("paging clamps and slices without losing the true total", () => {
  const sessions = Array.from({ length: 7 }, (_, i) => ({ id: `s-${i}`, title: `t${i}`, model: "m", turns: 1, kind: "chat" as const, updatedAt: 100 - i, cwd: "C:/w" }));
  const page = buildTimeline(sessions, [], { limit: 3, offset: 2 });
  expect(page.total).toBe(7);
  expect(page.entries.map((e) => e.sessionId)).toEqual(["s-2", "s-3", "s-4"]);
});
