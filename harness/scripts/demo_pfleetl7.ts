// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pfleetl7.ts
//
// P-FLEET.L7: lane tool-call FIDELITY and a transcript that survives its own stream. Proves, headlessly,
// against the REAL modules (real FleetLaneManager driving a real fake-ACP child, the real
// lane_transcript/answer_chips/linediff pure core):
//   1. THE COMMAND CROSSES THE WIRE: a bash/read/search call authors no code, so before L7 the lane event
//      carried only omp's one-line title and the card's chevron had nothing to reveal. The engine now
//      carries the bounded, code-stripped rawInput, so "the command used" is drillable.
//   2. THE CHEVRON IS NEVER DEAD: hasBody and laneChipBody agree by construction, so the DOM omits the
//      chevron exactly when there is nothing under it, and every revealed panel has content.
//   3. ONE CLASSIFIER: a lane chip delegates kind/detail/diffstat to answer_chips.toolChip, the same
//      function the master composer uses, so the two surfaces can never disagree about a tool call.
//   4. STABLE IDS ARE THE COPY/PASTE FIX: ids are monotone and never reused, which is what lets the card
//      PATCH its DOM instead of rebuilding it. The old innerHTML-per-token repaint is what destroyed a
//      mid-stream text selection and slammed every open tool call shut.
//   5. HONEST BOUNDS: an oversized command or diff is CLIPPED AND SAID SO, never silently truncated -
//      a card that quietly shortens a command is lying about what ran.
//   6. USAGE IS MEASURED: the lane forwards omp's context fill / window / cost untouched and invents
//      nothing (there is no output-token figure on this path, so it reports none).
//
// Run: bun run harness/scripts/demo_pfleetl7.ts

import { join } from "node:path";
import { FleetLaneManager, type LaneEvent } from "../../desktop/fleet_lanes.ts";
import {
  LANE_DIFF_ROWS_CAP, LANE_INPUT_CAP, laneChip, laneChipBody, mintId, transcriptCopyText, turnCopyText,
  type LaneToolRow, type LaneTurnRow,
} from "../../desktop/renderer/lane_transcript.ts";
import { toolChip } from "../../desktop/renderer/answer_chips.ts";
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

// -- 1. the command crosses the wire -------------------------------------------------------------------
console.log("1) a code-less tool call carries the COMMAND, and the lane reports its own usage");
{
  process.env.FAKE_ACP_MODE = "lanefidelity";
  const fleet = new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }),
    masterModel: () => "orchestrator-model",
    sample: async () => healthy,
  });
  const r = await fleet.spawn({ cwd: process.cwd(), name: "fidelity" });
  if (!r.ok) fail(r.reason ?? "spawn failed");
  const seen: LaneEvent[] = [];
  await fleet.prompt(r.lane!.id, "run the suite", (e) => seen.push(e));
  fleet.stopAll();
  delete process.env.FAKE_ACP_MODE;

  const tools = seen.filter((e): e is Extract<LaneEvent, { type: "tool" }> => e.type === "tool");
  const bash = tools.find((t) => t.name === "run");
  if (!bash) fail("the bash-shaped tool_call never reached the lane sink");
  if (!bash.input) fail("a code-less call must carry `input` - that IS the chevron's body");
  if (!bash.input.includes("bun test desktop/health_watch.test.ts")) fail(`the command must survive verbatim, got: ${bash.input}`);
  ok(`a bash call carries its command: ${bash.input.split("\n")[0]}`);

  // The EDIT call authored code, so it carries `code` and NOT a duplicate `input`: showing both would
  // render the same bytes twice, once as a diff and once as a patch under a "command" label.
  const edit = tools.find((t) => t.name === "edit");
  if (!edit?.code) fail("the edit call must still carry its authored code");
  if (edit.input) fail("a call that authored code must NOT also carry input (the diff is the richer view)");
  ok("an edit call carries `code` only, never a duplicate `input`");

  const usage = seen.find((e): e is Extract<LaneEvent, { type: "usage" }> => e.type === "usage");
  if (!usage) fail("the lane must forward omp's usage_update - a promoted lane reports its OWN spend");
  if (usage.used !== 4200 || usage.size !== 200_000) fail(`context figures must pass through untouched, got ${usage.used}/${usage.size}`);
  if (Math.abs(usage.cost - 0.0731) > 1e-9) fail(`cost must pass through untouched, got ${usage.cost}`);
  ok(`usage is MEASURED and untouched: ${usage.used}/${usage.size} tokens, $${usage.cost}`);
}

// -- 2. the chevron is never dead ----------------------------------------------------------------------
console.log("2) hasBody and laneChipBody agree, so a chevron is rendered only when it opens something");
{
  const cases: { why: string; row: LaneToolRow }[] = [
    { why: "authored code", row: { id: "a", name: "write", detail: "write config", code: { path: "a.ts", content: "one\ntwo" }, open: false } },
    { why: "a command only", row: { id: "b", name: "run", detail: "bun test", input: "bun test x", open: false } },
    { why: "a detail only", row: { id: "c", name: "read", detail: "read package.json", open: false } },
    { why: "nothing at all", row: { id: "d", name: "", detail: "", open: false } },
    { why: "whitespace input", row: { id: "e", name: "", detail: "   ", input: "   ", open: false } },
  ];
  for (const c of cases) {
    const chip = laneChip(c.row);
    const body = laneChipBody(c.row);
    if (chip.hasBody !== (body !== null)) fail(`hasBody and laneChipBody disagree for ${c.why}`);
    // Narrow on `kind` rather than probing `.text`: a diff body has rows and no text, so the union has to
    // be split before either field is read. Whichever shape it is, the panel must not be empty.
    if (body?.kind === "diff" && !body.rows.length) fail(`a diff panel must have rows (${c.why})`);
    if ((body?.kind === "input" || body?.kind === "detail") && !body.text.trim()) fail(`a revealed panel must never be empty (${c.why})`);
  }
  ok(`the biconditional holds across ${cases.length} shapes, including whitespace-only input`);

  // Precedence: code beats input beats detail. A row with BOTH must render the diff.
  const both = laneChipBody({ id: "f", name: "edit", detail: "patch it", code: { path: "a.ts", content: "x" }, input: "some command", open: false });
  if (both?.kind !== "diff") fail(`code must beat input, got ${both?.kind}`);
  ok("body precedence is code, then command, then detail");
}

// -- 3. one classifier for both surfaces ---------------------------------------------------------------
console.log("3) a lane chip and a master-composer chip cannot disagree about a tool call");
{
  const row: LaneToolRow = { id: "g", name: "write", detail: "write src/a.ts", code: { path: "src/a.ts", content: "1\n2\n3" }, open: false };
  const lane = laneChip(row);
  const master = toolChip(row.name, row.detail, row.code);
  if (lane.kind !== master.kind) fail(`kind must be delegated, lane=${lane.kind} master=${master.kind}`);
  if (JSON.stringify(lane.diffstat) !== JSON.stringify(master.diffstat)) fail("diffstat must be delegated, not recomputed");
  ok(`both surfaces classify it as "${lane.kind}" with the same diffstat (delegated, not duplicated)`);

  const run = laneChip({ id: "h", name: "bash", detail: "ls", input: "ls -la", open: false });
  if (run.kind !== "run") fail(`a bash call must classify as "run", got ${run.kind}`);
  if (run.diffstat !== null) fail("a command authors no lines, so it has no diffstat");
  ok("a command call is `run` with no diffstat (it authored nothing)");
}

// -- 4. stable ids are what make the incremental paint possible ---------------------------------------
console.log("4) ids are monotone and never reused - the precondition for patching DOM instead of rebuilding");
{
  const ids = new Set<string>();
  for (let i = 0; i < 1000; i++) ids.add(mintId("t", i));
  if (ids.size !== 1000) fail(`1000 mints must yield 1000 distinct ids, got ${ids.size}`);
  if (mintId("t", 4) !== "t4") fail("the id form is prefix + sequence");
  ok("1000 mints, 1000 distinct ids - a DOM node keyed on one is stable for the card's life");
}

// -- 5. honest bounds ----------------------------------------------------------------------------------
console.log("5) an oversized command or diff is clipped AND SAYS SO, never silently shortened");
{
  const huge = "x".repeat(10 * 1024);
  const body = laneChipBody({ id: "i", name: "run", detail: "big", input: huge, open: false });
  if (body?.kind !== "input") fail("expected an input body");
  if (body.text.length <= LANE_INPUT_CAP) fail("the clip must keep the cap's worth of bytes");
  if (!/truncat/i.test(body.text)) fail("a clipped command MUST say it was clipped - a quiet clip misreports what ran");
  ok(`a ${huge.length}-byte command clips at ${LANE_INPUT_CAP} and declares the truncation`);

  const bigDiff = laneChipBody({ id: "j", name: "write", detail: "big", code: { path: "a.ts", content: Array.from({ length: 5000 }, (_v, i) => `line ${i}`).join("\n") }, open: false });
  if (bigDiff?.kind !== "diff") fail("expected a diff body");
  if (bigDiff.rows.length !== LANE_DIFF_ROWS_CAP) fail(`a 5000-line diff must cap at exactly ${LANE_DIFF_ROWS_CAP}, got ${bigDiff.rows.length}`);
  if (!/truncat/i.test(bigDiff.rows[bigDiff.rows.length - 1]!.text)) fail("the last row must declare the truncation");
  ok(`a 5000-row diff caps at exactly ${LANE_DIFF_ROWS_CAP} rows and the last row says so`);
}

// -- 6. copy is plain text, in order, with no markup --------------------------------------------------
console.log("6) copy/paste out of a lane window yields readable plain text");
{
  const turns: LaneTurnRow[] = [
    { id: "t0", role: "user", text: "run the suite", tools: [] },
    { id: "t1", role: "assistant", text: "All green.", tools: [{ id: "c0", name: "run", detail: "bun test", input: "bun test x", open: false }] },
    { id: "t2", role: "user", text: "ship it", tools: [] },
  ];
  const live = { text: "Working on it", tools: [] as LaneToolRow[] };
  const out = transcriptCopyText(turns, live);
  if (!out.includes("run the suite") || !out.includes("All green.") || !out.includes("Working on it")) fail("every turn plus the live block must appear");
  if (out.indexOf("run the suite") > out.indexOf("ship it")) fail("copy must preserve turn order");
  if (out.includes("<")) fail("copy is plain UTF-8, never markup");
  if (out.includes("\u2014")) fail("no em dashes anywhere (repo invariant)");
  if (!out.includes("bun test x")) fail("a tool row must carry its command into the clipboard");
  ok("3 turns plus the live block copy in order, plain text, command included");

  if (transcriptCopyText([], undefined) !== "") fail("an empty transcript copies to \"\", not a lonely header");
  if (turnCopyText({ id: "z", role: "assistant", text: "", tools: [] }) !== "") fail("an empty turn copies to \"\"");
  ok("an empty transcript copies to nothing at all");
}

console.log("\nP-FLEET.L7 demo: PASS");
