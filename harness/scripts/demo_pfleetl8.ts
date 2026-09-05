// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pfleetl8.ts
//
// P-FLEET.L8: promote a fleet lane into the MAIN composer, and pull it back. Proves, headlessly, against
// the REAL modules (real FleetLaneManager driving real fake-ACP children, the real composer_target core,
// the real lane-session ledger):
//   1. PROMOTION IS AN ATTACH, NOT A HANDOFF: the lane's omp child, ACP session id, cwd, and model are
//      BYTE-IDENTICAL before and after. Only which surface drives it moves. That is the whole reason it
//      can happen mid-turn: nothing is killed, nothing re-handshakes, no session log is rewritten.
//   2. IN FLIGHT IS THE POINT: a `working` lane promotes with no refusal. The user asked to switch on the
//      fly, so a busy lane is the primary case, not an error case.
//   3. FAIL-CLOSED ON THE REST: stopped and error refuse with a reason naming the fix, and an UNKNOWN
//      status refuses too - a status string we do not recognize never authorizes an attach.
//   4. EXACTLY ONE: promoting a second lane demotes the first, because the composer has one prompt box
//      and two attached lanes would send to whichever answered last.
//   5. PROVENANCE: promote and demote each write a durable ledger line naming the lane, its folder, its
//      MODEL AT THAT MOMENT, and the turns carried. Without it, a stretch of a session's history driven
//      from the main chat is indistinguishable from lane work.
//   6. HISTORY COMES WITH IT: the composer is seeded from the lane's bounded transcript, with the
//      engine's `[ran: x]` bookkeeping folded into one note and the prose preserved verbatim.
//   7. DEMOTE IS IDEMPOTENT: a second click is a quiet no-op, never an error - a stale click is not a bug.
//
// Run: bun run harness/scripts/demo_pfleetl8.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetLaneManager } from "../../desktop/fleet_lanes.ts";
import { appendLaneLedger, readLaneLedger } from "../../desktop/timeline.ts";
import {
  MASTER_TARGET, demoteNotice, isLaneTarget, promoteNotice, promoteRefusal, sameTarget, seedTurns,
  targetBadge, targetCaps,
} from "../../desktop/renderer/composer_target.ts";
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
const root = mkdtempSync(join(tmpdir(), "lucid-l8-demo-"));
const ledgerPath = join(root, "lucid-fleet-lanes.jsonl");
process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } });

// -- 1 + 4 + 5. attach, exclusivity, provenance --------------------------------------------------------
console.log("1) promotion ATTACHES: the session, folder, and model are untouched");
{
  delete process.env.FAKE_ACP_MODE;
  const fleet = new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }),
    masterModel: () => "orchestrator-model",
    sample: async () => healthy,
    recordLaneSession: (rec) => appendLaneLedger(rec, ledgerPath),
  });
  const a = await fleet.spawn({ cwd: process.cwd(), name: "etl-worker" });
  const b = await fleet.spawn({ cwd: process.cwd(), name: "docs-worker" });
  if (!a.ok || !b.ok) fail("both lanes must spawn");
  const before = { session: a.lane!.sessionId, cwd: a.lane!.cwd, model: a.lane!.model };

  await fleet.prompt(a.lane!.id, "do a thing", () => {});

  const p = fleet.promote(a.lane!.id);
  if (!p.ok) fail(p.reason ?? "promote failed");
  if (p.lane!.sessionId !== before.session) fail("the ACP session id MUST NOT change - a handoff is exactly what this design avoids");
  if (p.lane!.cwd !== before.cwd) fail("the lane keeps its own working folder");
  if (p.lane!.model !== before.model) fail("the lane keeps its own model");
  if (!p.lane!.promoted) fail("the view must report the attachment");
  ok(`session ${String(before.session)} unchanged, folder unchanged, model "${before.model}" unchanged`);

  console.log("2) exactly one lane holds the composer");
  const p2 = fleet.promote(b.lane!.id);
  if (!p2.ok) fail("the second promote must succeed");
  const held = (await fleet.status()).lanes.filter((l) => l.promoted);
  if (held.length !== 1) fail(`exactly one lane may be promoted, found ${held.length}`);
  if (held[0]!.id !== b.lane!.id) fail("the newest promote wins and the older one is released");
  ok("promoting the second lane released the first (one prompt box, one target)");

  console.log("3) demote is idempotent");
  const d1 = fleet.demote(b.lane!.id);
  const d2 = fleet.demote(b.lane!.id);
  if (!d1.ok || !d2.ok) fail("neither demote may error");
  if ((await fleet.status()).lanes.some((l) => l.promoted)) fail("nothing may remain promoted");
  ok("a second demote click is a quiet no-op, never an error");

  console.log("4) every attach and release is in the durable provenance ledger");
  fleet.stopAll();
  const rows = readLaneLedger(ledgerPath);
  const promotes = rows.filter((r) => r.event === "promote");
  const demotes = rows.filter((r) => r.event === "demote");
  if (promotes.length !== 2) fail(`expected 2 promote lines, got ${promotes.length}`);
  if (demotes.length < 2) fail(`expected a demote line for the displaced lane AND the explicit one, got ${demotes.length}`);
  const first = promotes.find((r) => r.laneId === a.lane!.id);
  if (!first) fail("the promote line must name the lane");
  if (first.model !== before.model) fail("the ledger must record the model IN FORCE at the event, not the master's");
  if (!first.note || !/turn/.test(first.note)) fail("the promote line must record how many turns were carried");
  if (!first.cwd) fail("the promote line must record the folder");
  ok(`${promotes.length} promote + ${demotes.length} demote lines, each naming lane, folder, model, and turns`);
}

// -- 2 + 3. in-flight promotion allowed, unknown status refused ---------------------------------------
console.log("5) a WORKING lane promotes (that is the ask); an unknown status is refused fail-closed");
{
  if (promoteRefusal("working") !== null) fail("a busy lane MUST be promotable - switching on the fly is the feature");
  if (promoteRefusal("awaiting-input") !== null) fail("an idle lane is promotable");
  if (promoteRefusal("done") !== null) fail("a settled lane is promotable");
  ok("working, awaiting-input, and done all promote with no refusal");

  for (const bad of ["stopped", "error"]) {
    const r = promoteRefusal(bad);
    if (!r) fail(`${bad} must refuse`);
    if (!/respawn/i.test(r)) fail(`the ${bad} refusal must name the fix (respawn), got: ${r}`);
  }
  ok("stopped and error refuse with a reason naming respawn");

  for (const unknown of ["", "banana", "WORKING?", "  "]) {
    if (promoteRefusal(unknown) === null) fail(`an unrecognized status (${JSON.stringify(unknown)}) must NEVER authorize an attach`);
  }
  ok("an unrecognized status refuses - fail-closed, never optimistic");
}

// -- 6. history rides along ----------------------------------------------------------------------------
console.log("6) the composer is seeded with the lane's history, prose preserved verbatim");
{
  const seeded = seedTurns([
    { role: "user", text: "run the suite" },
    { role: "assistant", text: "[ran: bash]\n[ran: read]\nAll 194 tests pass.\n\nNothing to fix." },
    { role: "user", text: "   " },
    { role: "assistant", text: "Shipping." },
  ]);
  if (seeded.length !== 3) fail(`blank turns drop, so 4 in yields 3 out, got ${seeded.length}`);
  if (seeded[0]!.text !== "run the suite") fail("a user turn is never rewritten");
  const folded = seeded[1]!.text;
  if (!folded.includes("All 194 tests pass.") || !folded.includes("Nothing to fix.")) fail("the PROSE must survive byte-for-byte");
  if ((folded.match(/\[ran/g) ?? []).length !== 1) fail(`the engine's per-tool bookkeeping folds into ONE note, got: ${folded}`);
  ok("tool bookkeeping folds to one note, prose survives verbatim, blank turns drop, order preserved");
}

// -- badge, caps, and the audit wording ----------------------------------------------------------------
console.log("7) the badge names the target unambiguously and the notices are the audit trail");
{
  const target = { kind: "lane" as const, laneId: "lane-7", name: "etl-worker", cwd: "C:\\work\\etl-pipeline", model: "claude-fable-5" };
  const badge = targetBadge(target);
  if (!badge) fail("a lane target must render a badge");
  if (badge.label.includes("\n")) fail("the label is ONE text run (invariant 11) - no newline");
  if (badge.label.includes("C:\\work")) fail("the label carries the folder BASENAME; a full Windows path would blow out the chip");
  if (!badge.label.includes("etl-pipeline")) fail("the label must name the folder the next Enter will reach");
  if (!badge.title.includes("C:\\work\\etl-pipeline") || !badge.title.includes("claude-fable-5")) fail("the hover carries the FULL path and the model");
  ok(`badge label "${badge.label}" is one ellipsis-safe run; the hover carries the full path + model`);

  if (targetBadge(MASTER_TARGET) !== null) fail("the master composer shows NO badge at all");
  if (!sameTarget(MASTER_TARGET, MASTER_TARGET)) fail("master equals master");
  if (!sameTarget(target, { ...target, name: "renamed", model: "other" })) fail("a lane target is identified by laneId alone; a rename is not a retarget");
  if (!isLaneTarget(target) || isLaneTarget(MASTER_TARGET)) fail("isLaneTarget must discriminate");
  ok("master shows no badge; a lane is identified by its id, so a rename never silently retargets");

  const caps = targetCaps(target);
  if (caps.images || caps.modes || caps.goalLoop || caps.slashCommands) fail("a lane target must report what it cannot drive so the UI HIDES those controls");
  if (!caps.why.trim()) fail("every removal must be explained, or the user just sees missing buttons");
  const mcaps = targetCaps(MASTER_TARGET);
  if (!mcaps.images || !mcaps.modes || !mcaps.goalLoop || !mcaps.slashCommands) fail("the master target drives everything");
  ok("lane caps are all false with an explanation; master caps are all true");

  const pn = promoteNotice(target, 12);
  const dn = demoteNotice(target);
  for (const [what, s] of [["promote", pn], ["demote", dn]] as const) {
    if (!s.includes("etl-worker")) fail(`the ${what} notice must name the lane`);
    if (!s.includes("C:\\work\\etl-pipeline")) fail(`the ${what} notice must name the folder`);
    if (!s.includes("claude-fable-5")) fail(`the ${what} notice must name the model`);
    if (s.includes("\u2014")) fail(`no em dashes (repo invariant), found in the ${what} notice`);
  }
  if (!pn.includes("12")) fail("the promote notice must state how many turns were carried");
  ok("both notices name lane, folder, and model; promote states the turn count; no em dashes");
}

// -- 8. P-FLEET.L10: dismissing a lane ----------------------------------------------------------------
console.log("8) P-FLEET.L10: a stopped lane can be DISMISSED, and a busy one is refused");
{
  delete process.env.FAKE_ACP_MODE;
  const fleet = new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }),
    masterModel: () => "orchestrator-model",
    sample: async () => healthy,
    recordLaneSession: (rec) => appendLaneLedger(rec, ledgerPath),
  });
  const a = await fleet.spawn({ cwd: process.cwd(), name: "throwaway" });
  if (!a.ok) fail(a.reason ?? "spawn failed");
  const id = a.lane!.id;

  // A busy lane is REFUSED, not force-killed: one click must never destroy work in flight, which is why
  // the UI makes dismissal a two-step gesture (stop, then dismiss).
  let refusal: string | undefined;
  const turn = fleet.prompt(id, "do a thing", () => {});
  const r = fleet.remove(id);
  if (!r.ok) refusal = r.reason;
  await turn;
  if (!refusal) fail("a mid-turn dismissal must be REFUSED - a single click cannot be allowed to destroy a running turn");
  if (!/stop it first/i.test(refusal)) fail(`the refusal must name the fix, got: ${refusal}`);
  if (!(await fleet.status()).lanes.some((l) => l.id === id)) fail("a refused dismissal must leave the lane exactly where it was");
  ok(`a busy lane refuses with the fix named: "${refusal}"`);

  // Promotion must be released, or the composer is left pointed at a lane id that no longer resolves.
  fleet.promote(id);
  if (!fleet.promotedLane()) fail("the lane must be promoted for this case to prove anything");
  fleet.stop(id);
  const gone = fleet.remove(id);
  if (!gone.ok) fail(gone.reason ?? "a stopped lane must dismiss");
  if (fleet.promotedLane() !== null) fail("removing a PROMOTED lane must release the composer, or it strands on a dead lane id");
  ok("dismissing a promoted lane releases the composer (no stranded target)");

  if ((await fleet.status()).lanes.some((l) => l.id === id)) fail("a dismissed lane must leave the fleet entirely");
  if (fleet.laneTranscript(id).length) fail("a dismissed lane keeps no in-memory transcript");
  ok("the lane is gone from status and holds no memory");

  // Idempotent: the button can be clicked twice, and a second dismissal is not an error.
  if (!fleet.remove(id).ok) fail("dismissing an already-gone lane must be a quiet no-op");
  ok("a second dismissal is a quiet no-op, never an error");

  // The durable record SURVIVES the dismissal: this is what makes forgetting a lane safe to offer at all.
  const rows = readLaneLedger(ledgerPath);
  if (!rows.some((x) => x.laneId === id && x.event === "spawn")) fail("the spawn line must outlive the lane - review is an index over files omp already persists");
  ok("the lane's ledger line survives, so a dismissed lane is still reviewable on the timeline");
  fleet.stopAll();
}

console.log("\nP-FLEET.L8 / L10 demo: PASS");
