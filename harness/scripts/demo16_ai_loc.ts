// harness/scripts/demo16_ai_loc.ts
//
// P-LOC.1 (ADR-0031): AI-LOC attribution. The security gate counts each AI-authored file
// mutation that PASSES it (a successful omp `write`/`edit` tool_result) from omp's OWN post-apply
// diff, tagged with the authoring model + the attribution identity + the edited repo. The result
// rolls up per (model, repo, identity) for the dashboard / BI push. This is the honest
// "the AI wrote these lines" signal git can't give (ADR-0030).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { aiLocRollup, recordAiEdit, type AttributionContext } from "../runs/loc_ledger.ts";
import type { EditResultLike } from "../runs/loc_count.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const dir = mkdtempSync(join(tmpdir(), "demo16-"));
const db = await Db.open(join(dir, "agent_obs.duckdb"));

try {
  const opus: AttributionContext = { model: "claude-opus-4-8", identity: "dev@acme.com", identitySource: "email", repo: "/work/acme-app", runId: "omp-live" };
  const sonnet: AttributionContext = { ...opus, model: "claude-sonnet-4-6" };

  // 1) a brand-new file written by Opus → all content lines are "added"
  const write: EditResultLike = { toolName: "write", input: { path: "src/server.ts", content: "import x\n\nexport const port = 8080\nstart(port)\n" } };
  console.log(`write src/server.ts -> +${(await recordAiEdit(db, write, opus)).added}`);

  // 2) a hashline edit by Opus — omp returns its post-apply NUMBERED diff (default edit mode)
  const edit: EditResultLike = {
    toolName: "edit",
    details: { path: "src/server.ts", diff: [" 3|export const port = 8080", "-4|start(port)", "+4|listen(port)", "+5|log('up')"].join("\n") },
  };
  const e = await recordAiEdit(db, edit, opus);
  console.log(`edit  src/server.ts -> +${e.added}/-${e.removed} (from omp's applied diff)`);

  // 3) a multi-file edit by Sonnet → one ledger row per file
  const multi: EditResultLike = {
    toolName: "edit",
    details: { perFileResults: [{ path: "a.ts", diff: "+1|a\n+2|b" }, { path: "b.ts", diff: "-9|gone" }] },
  };
  console.log(`multi a.ts,b.ts (sonnet) -> rows=${(await recordAiEdit(db, multi, sonnet)).rows}`);

  // 4) things that must NOT count: a read, and a FAILED edit (hashline mismatch etc.)
  const skippedRead = await recordAiEdit(db, { toolName: "read", input: { path: "x" } }, opus);
  const skippedFail = await recordAiEdit(db, { toolName: "edit", isError: true, details: { diff: "+1|nope" } }, opus);
  if (skippedRead.recorded || skippedFail.recorded) fail("reads and failed edits must not be counted");
  console.log(`skipped: read + failed-edit (not AI-authored changes)`);

  // ── roll-up (what the dashboard / BI add-on reads) ─────────────────────────
  console.log("\n-- AI-LOC roll-up (model · repo · identity) --");
  const roll = await aiLocRollup(db);
  for (const r of roll) console.log(`  ${r.model.padEnd(20)} ${r.repo.padEnd(16)} ${r.identity.padEnd(14)} +${r.added}/-${r.removed} (${r.edits} edit${r.edits === 1 ? "" : "s"})`);

  // assertions
  const opusRow = roll.find((r) => r.model === "claude-opus-4-8");
  const sonnetRow = roll.find((r) => r.model === "claude-sonnet-4-6");
  if (!opusRow || !sonnetRow) fail("expected one roll-up row per model");
  if (opusRow!.added !== 6) fail(`opus added should be 6 (4 write + 2 edit), got ${opusRow!.added}`);
  if (opusRow!.removed !== 1) fail(`opus removed should be 1, got ${opusRow!.removed}`);
  if (sonnetRow!.added !== 2 || sonnetRow!.removed !== 1) fail("sonnet should be +2/-1 across 2 files");
  if (opusRow!.identitySource !== "email") fail("attribution source should be email");
  const totalRows = await db.get("SELECT count(*)::INT n FROM ai_loc_ledger");
  if (Number(totalRows!.n) !== 4) fail(`expected 4 ledger rows (1 write + 1 edit + 2 multi-file), got ${totalRows!.n}`);

  console.log("\ndemo16_ai_loc OK");
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
