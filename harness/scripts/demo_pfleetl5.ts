// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pfleetl5.ts
//
// P-FLEET.L5 (ADR-0274): histories + the reviewable timeline. Proves, headlessly, against the REAL
// modules (real FleetLaneManager + fake-ACP children, the real session-corpus reader over an omp-shaped
// fixture root, the real ledger):
//   1. NAMED AT SPAWN: every lane spawn AND recovery writes a durable ledger line tying the lane to its
//      omp session id - the link that makes an on-disk lane .jsonl attributable forever.
//   2. ONE TIMELINE: master chats, lane sessions, and ingest throwaways from DIFFERENT workspaces merge
//      newest-first, lanes labeled with their lane names, ingest classified and never crowding chats.
//   3. REVIEWABLE AFTER STOP: a stopped lane's session still lists and its transcript still reads -
//      review is an INDEX over files omp already persists, never a second recording.
//   4. HONEST UNDER DAMAGE: a torn ledger line is skipped; a missing ledger just means unlabeled rows.
//
// Run: bun run harness/scripts/demo_pfleetl5.ts

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetLaneManager } from "../../desktop/fleet_lanes.ts";
import { appendLaneLedger, listTimeline, readLaneLedger } from "../../desktop/timeline.ts";
import { sessionMessages, __resetSessionIndex } from "../../desktop/sessions.ts";
import type { SystemSnapshot } from "../../desktop/system_profile.ts";

const FAKE = join(import.meta.dir, "..", "mcp", "testing", "fake_acp_agent.ts");

function fail(msg: string): never {
  console.error(`   FAIL - ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`   ok - ${msg}`);
}

const healthy: SystemSnapshot = { cpuModel: "demo", cores: 8, speedMHz: 4000, cpuBusyPct: 10, memTotalMB: 16_000, memFreeMB: 12_000 };
const root = mkdtempSync(join(tmpdir(), "lucid-l5-demo-"));
const ledgerPath = join(root, "lucid-fleet-lanes.jsonl");
process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } });

function writeSession(dir: string, file: string, o: { id: string; cwd: string; user: string; assistant?: string; atSec: number }): void {
  const d = join(root, "sessions", dir);
  mkdirSync(d, { recursive: true });
  const p = join(d, file);
  writeFileSync(p, [
    JSON.stringify({ type: "session", id: o.id, cwd: o.cwd }),
    JSON.stringify({ type: "message", message: { role: "user", content: o.user } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: o.assistant ?? "done", usage: { output_tokens: 4 }, model: "claude-fable-5" } }),
  ].join("\n") + "\n");
  utimesSync(p, o.atSec, o.atSec);
}
const sessionsRoot = join(root, "sessions");

// ── 1. Named at spawn (and at recovery) ──────────────────────────────────────────────────────────────
console.log("1) every spawn and recovery writes the durable lane-session ledger");
{
  delete process.env.FAKE_ACP_MODE;
  const fleet = new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }),
    masterModel: () => "orchestrator-model",
    sample: async () => healthy,
    recordLaneSession: (rec) => appendLaneLedger(rec, ledgerPath),
  });
  const r = await fleet.spawn({ cwd: process.cwd(), name: "etl-worker" });
  if (!r.ok) fail(r.reason ?? "spawn failed");
  if (!r.lane!.sessionId) fail("the view must expose the omp session id");
  await fleet.respawn(r.lane!.id);
  fleet.stopAll();
  const rows = readLaneLedger(ledgerPath);
  if (rows.length !== 2) fail(`expected 2 ledger lines (spawn + respawn), got ${rows.length}`);
  if (rows[0]!.event !== "spawn" || rows[1]!.event !== "respawn") fail("events must be spawn then respawn");
  if (rows.some((x) => x.laneId !== r.lane!.id || x.name !== "etl-worker")) fail("every line carries the lane id + name");
  ok(`ledger holds the lineage: ${rows.map((x) => x.event).join(" -> ")} for "${rows[0]!.name}" (${rows[0]!.sessionId})`);
}

// ── 2 + 3. One timeline across workspaces; a stopped lane stays reviewable ───────────────────────────
console.log("2) chats, lanes, and ingest from different workspaces merge into ONE ordered timeline");
{
  writeSession("enc-alpha", "chat.jsonl", { id: "s-master", cwd: "C:/work/alpha", user: "refactor the auth flow", atSec: 5_000 });
  writeSession("enc-beta", "lane.jsonl", { id: readLaneLedger(ledgerPath)[0]!.sessionId, cwd: "C:/work/beta", user: "run the nightly migration", assistant: "migration complete, 42 rows", atSec: 4_000 });
  writeSession("enc-alpha", "probe.jsonl", { id: "s-old", cwd: "C:/work/alpha", user: "quick question", atSec: 1_000 });
  __resetSessionIndex();
  const page = listTimeline({}, sessionsRoot, ledgerPath);
  if (page.total !== 3) fail(`expected 3 rows, got ${page.total}`);
  if (page.entries.map((e) => e.sessionId).join("|") !== "s-master|" + readLaneLedger(ledgerPath)[0]!.sessionId + "|s-old") fail(`order broke: ${page.entries.map((e) => e.sessionId).join("|")}`);
  const lane = page.entries[1]!;
  if (lane.kind !== "lane" || lane.laneName !== "etl-worker") fail(`the lane row must be labeled: ${JSON.stringify(lane)}`);
  if (lane.laneEvents !== 2) fail("the row must count its spawn+respawn lineage");
  if (page.entries[0]!.kind !== "chat" || page.entries[0]!.wsName !== "alpha") fail("the master chat must classify as chat with its workspace");
  ok(`3 sessions, 2 workspaces, newest first; the lane row reads "${lane.laneName}" (${lane.laneEvents} spawns) from ${lane.wsName}`);

  console.log("3) a stopped lane's transcript still opens - review is an index, not a second recording");
  const t = sessionMessages(lane.sessionId, 0, sessionsRoot);
  if (t.total < 2) fail("the lane transcript must read back");
  const texts = t.messages.map((m) => m.text).join(" | ");
  if (!texts.includes("nightly migration") || !texts.includes("42 rows")) fail(`transcript lost content: ${texts}`);
  ok(`transcript reads back: "${t.messages[t.messages.length - 1]!.text.slice(0, 40)}..." - the lane is gone, its history is not`);
}

// ── 4. Honest under damage ───────────────────────────────────────────────────────────────────────────
console.log("4) a torn ledger line skips; a missing ledger just means unlabeled rows");
{
  writeFileSync(ledgerPath, readLaneLedger(ledgerPath).map((r) => JSON.stringify(r)).join("\n") + '\n{"torn": tr\n');
  const rows = readLaneLedger(ledgerPath);
  if (rows.length !== 2) fail("the torn tail must not eat the good lines");
  const unlabeled = listTimeline({}, sessionsRoot, join(root, "absent.jsonl"));
  if (unlabeled.entries.some((e) => e.kind === "lane")) fail("without a ledger, rows are chats - never invented lanes");
  ok("torn tail skipped; ledgerless rows degrade to plain chats, nothing throws");
}

console.log("\ndemo_pfleetl5 OK - lanes are named in a durable ledger at spawn and recovery, every workspace's sessions merge into one ordered reviewable timeline, stopped lanes keep readable histories, and damage degrades labels instead of breaking the surface.");
process.exit(0);
