// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pnvim7.ts
//
// P-NVIM.7 (view blocked tool calls from Neovim): the `lucid blocks` viewer behind :LucidBlocks. Proves,
// without a live model, the whole chain:
// (1) the in-process gate mirrors a block to the lock-free JSONL when LUCID_BLOCK_LOG is set (so a block is
//     visible DURING a live session, when the gate holds agent_obs.duckdb locked) — and is a NO-OP when the
//     env is unset (so the desktop GUI, which records its own way, never double-writes);
// (2) readBlockLog parses the JSONL and applies approve/dismiss markers;
// (3) blockList / runBlocks list the blocks, filter reviewed ones out by default (--all includes them), and
//     honour --json (machine) vs text (terminal).
//
// Run: bun run harness/scripts/demo_pnvim7.ts

import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorBlock } from "../omp/block_log.ts";
import { blockList, readBlockLog, runBlocks } from "../../tools/blocks_cli.ts";

const dir = mkdtempSync(join(tmpdir(), "lucid-pnvim7-"));
const logPath = join(dir, "lucid-blocks.jsonl");
process.env.LUCID_BLOCK_LOG = logPath;

const fail = (m: string): never => {
  rmSync(dir, { recursive: true, force: true });
  console.error(`FAIL: ${m}`);
  process.exit(1);
};
const ok = (m: string): void => console.log(`   ok — ${m}`);
const logRows = <T extends { source: string }>(rows: T[]): T[] => rows.filter((r) => r.source === "log"); // deterministic subset

try {
  console.log("P-NVIM.7 — the `lucid blocks` security viewer");

  console.log("1) the gate mirrors a block to the JSONL when LUCID_BLOCK_LOG is set");
  {
    mirrorBlock("bash", { reason: "quarantined: 1 finding(s)", findings: [{ type: "zero-width", severity: "high" }], failClosed: false });
    mirrorBlock("write", { reason: "fail-closed: scan unavailable", findings: [], failClosed: true });
    if (!existsSync(logPath)) fail("mirrorBlock must create the block log when LUCID_BLOCK_LOG is set");
    const rows = readBlockLog(logPath);
    const bash = rows.find((r) => r.tool === "bash");
    const write = rows.find((r) => r.tool === "write");
    if (!bash) throw new Error("expected the mirrored bash block");
    if (!write) throw new Error("expected the mirrored write block");
    if (bash.severity !== "high" || bash.findings !== "zero-width") fail("the bash block must carry severity=high, findings=zero-width");
    if (write.findings !== "scanner-unavailable") fail("a fail-closed block must record findings=scanner-unavailable");
    ok(`mirrored 2 blocks; bash(${bash.severity}/${bash.findings}), write(${write.findings})`);
  }

  console.log("2) the mirror is a NO-OP when LUCID_BLOCK_LOG is unset (the GUI never double-writes)");
  {
    const before = readBlockLog(logPath).length;
    delete process.env.LUCID_BLOCK_LOG;
    mirrorBlock("edit", { reason: "quarantined", findings: [{ type: "bidi-control", severity: "high" }], failClosed: false });
    process.env.LUCID_BLOCK_LOG = logPath;
    if (readBlockLog(logPath).length !== before) fail("mirrorBlock must write nothing when LUCID_BLOCK_LOG is unset");
    ok("no write without the opt-in env");
  }

  console.log("3) readBlockLog applies approve/dismiss markers");
  {
    const bash = readBlockLog(logPath).find((r) => r.tool === "bash");
    if (!bash) throw new Error("expected the bash block");
    appendFileSync(logPath, `${JSON.stringify({ _approval: true, id: bash.id })}\n`);
    const after = readBlockLog(logPath).find((r) => r.id === bash.id);
    if (!after || after.status !== "approved") fail("an _approval marker must flip the block to approved");
    ok("approve marker applied");
  }

  console.log("4) blockList filters reviewed blocks by default; --all includes them; runBlocks --json parses");
  {
    const active = logRows(await blockList({}));
    if (active.some((b) => b.status === "approved")) fail("default blockList must exclude approved blocks");
    if (!active.some((b) => b.tool === "write")) fail("default blockList must include still-quarantined blocks (write)");
    const all = logRows(await blockList({ all: true }));
    if (!all.some((b) => b.status === "approved" && b.tool === "bash")) fail("--all must include the approved bash block");
    const jsonOut = (await runBlocks(["--json"])).out;
    try {
      JSON.parse(jsonOut);
    } catch {
      fail("runBlocks --json must emit valid JSON");
    }
    if (!(await runBlocks([])).out.includes("write")) fail("runBlocks text must list the quarantined write block");
    ok(`default hides reviewed (${active.length} active), --all shows them (${all.length}); --json valid`);
  }

  console.log("\nsample `lucid blocks` (text):\n");
  console.log((await runBlocks(["--all"])).out);

  rmSync(dir, { recursive: true, force: true });
  console.log("\ndemo_pnvim7 OK — the gate mirrors blocks lock-free; `lucid blocks` lists them; :LucidBlocks has its source.");
  process.exit(0);
} catch (e) {
  fail(e instanceof Error ? (e.stack ?? e.message) : String(e));
}
