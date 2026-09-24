// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-RECOVER.1 (ADR-0385): live proof of the startup leftover reaper on a REAL process table.
//
// Builds real process trees with bun, records one in a run ledger inside a temp userData exactly the way
// main.ts does, then runs the shipping classifier (planLeftovers) and the shipping kill (stopProcesses):
//   [A] main crashed, engine alive: oldmain -> engine -> omp -> ompbun. Kill oldmain only (a crash).
//       Expect: exactly engine, omp, ompbun selected and stopped. An unrelated bun.exe (SAME image path,
//       orphaned the same way) survives.
//   [B] pid reuse, live: a ledger naming the unrelated bun's pid with the same image but a start time
//       60s off, and one with the right start but a different image. Expect: nothing selected.
//   [C] main AND engine crashed (win32): oldmain2 -> engine2 -> omp2 -> ompbun2. Kill oldmain2 and
//       engine2 (no tree). Expect: omp2 + ompbun2 selected as orphans of the dead engine and stopped.
//       POSIX reparents orphans to init, so there the expectation is "nothing selected".
// Every spawned process is cleaned up at the end, by (pid, start time), whatever happened.
//
// Run with: bun run desktop/scripts/demo_p_recover_1_leftover_reaper.ts

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineRecordFromProbe, listProcesses, planLeftovers, stopProcesses, type ProcRow } from "../leftover_reaper.ts";
import { assessPreviousRun, freshLedger, readLedgerText, runLedgerPath, withEngine, writeLedger } from "../run_ledger.ts";

const PLATFORM = process.platform;
let failed = false;
function check(cond: boolean, msg: string): void {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failed = true;
}

const tmp = mkdtempSync(join(tmpdir(), "p-recover-1-"));
const userData = join(tmp, "userData");
mkdirSync(userData, { recursive: true });
// One generic node: write my pid, spawn the rest of the chain DETACHED (so killing a parent never takes
// the child with it, just like a crashed main or engine), then idle forever.
const nodeScript = join(tmp, "node.ts");
writeFileSync(nodeScript, [
  `import { spawn } from "node:child_process";`,
  `import { writeFileSync } from "node:fs";`,
  `import { join } from "node:path";`,
  `const [role, dir, ...rest] = process.argv.slice(2);`,
  `if (rest.length) spawn(process.execPath, [process.argv[1], rest[0], dir, ...rest.slice(1)], { detached: true, stdio: "ignore", windowsHide: true }).unref();`,
  `writeFileSync(join(dir, role + ".pid"), String(process.pid));`,
  `setInterval(() => {}, 1 << 30);`,
].join("\n"));

function launch(dir: string, chain: string[]): void {
  mkdirSync(dir, { recursive: true });
  spawn(process.execPath, [nodeScript, chain[0]!, dir, ...chain.slice(1)], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
async function pidsOf(dir: string, roles: string[]): Promise<Record<string, number>> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (roles.every((r) => existsSync(join(dir, `${r}.pid`)))) {
      return Object.fromEntries(roles.map((r) => [r, Number(readFileSync(join(dir, `${r}.pid`), "utf8"))]));
    }
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${roles.join(", ")} in ${dir}`);
}
/** Simulate a crash: kill exactly one process, never its tree. */
async function hardKill(pid: number): Promise<void> {
  if (PLATFORM === "win32") await Bun.spawn(["taskkill.exe", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" }).exited;
  else { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await Bun.sleep(300);
}
const spawned: ProcRow[] = []; // for cleanup by (pid, start time)
async function snapshot(pids: number[]): Promise<ProcRow[]> {
  const rows = await listProcesses(PLATFORM);
  const mine = rows.filter((r) => pids.includes(r.pid));
  spawned.push(...mine);
  return rows;
}
const alive = (rows: ProcRow[], p: ProcRow): boolean => rows.some((r) => r.pid === p.pid && r.startedAt === p.startedAt);
const show = (t: { pid: number; name: string; role?: string; why?: string }): string => `pid ${t.pid} ${t.name}${t.role ? ` (${t.role})` : ""}${t.why ? `: ${t.why}` : ""}`;

try {
  console.log(`== P-RECOVER.1 leftover reaper, live on ${PLATFORM} (self pid ${process.pid}) ==\n`);

  // ── [A] ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("[A] main crashed, previous engine still running");
  const dirA = join(tmp, "a");
  launch(dirA, ["oldmain", "engine", "omp", "ompbun"]);
  launch(dirA, ["unrelatedparent", "unrelated"]);
  const a = await pidsOf(dirA, ["oldmain", "engine", "omp", "ompbun", "unrelatedparent", "unrelated"]);
  console.log(`  spawned: ${Object.entries(a).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  const rowsA0 = await snapshot(Object.values(a));
  const engineRow = rowsA0.find((r) => r.pid === a.engine) ?? null;
  const unrelatedRow = rowsA0.find((r) => r.pid === a.unrelated) ?? null;
  check(engineRow !== null && unrelatedRow !== null, "engine and unrelated are visible in the process table");
  console.log(`  engine image: ${engineRow?.exe ?? engineRow?.command}   unrelated image: ${unrelatedRow?.exe ?? unrelatedRow?.command}`);
  check(engineRow?.exe === unrelatedRow?.exe && engineRow?.name === unrelatedRow?.name, "the unrelated process has the SAME name and image as the engine");

  // What main.ts writes: fresh ledger for the (soon to crash) main, then the engine record from the probe.
  const ledgerPath = runLedgerPath(userData);
  writeLedger(ledgerPath, withEngine(
    freshLedger({ mainPid: a.oldmain!, mainStartedAt: Date.now() - 5000, port: 5319, appVersion: "demo" }),
    engineRecordFromProbe(PLATFORM, a.engine!, engineRow, process.execPath, Date.now()),
  ));
  await hardKill(a.oldmain!);
  await hardKill(a.unrelatedparent!);
  console.log("  crashed: oldmain and unrelatedparent killed (single pid, no tree)");

  const prev = assessPreviousRun(readLedgerText(ledgerPath), process.pid);
  check(prev.verdict === "unclean", `the next launch reads the ledger as unclean (got ${prev.verdict})`);
  if (prev.verdict !== "unclean") throw new Error("ledger verdict");
  const planA = planLeftovers(await listProcesses(PLATFORM), prev.ledger.engine, { selfPid: process.pid, platform: PLATFORM });
  console.log(`  engine verdict: ${planA.engineVerdict}`);
  for (const t of planA.targets) console.log(`  selected ${show(t)}`);
  const selA = planA.targets.map((t) => t.pid).sort((x, y) => x - y);
  check(JSON.stringify(selA) === JSON.stringify([a.engine!, a.omp!, a.ompbun!].sort((x, y) => x - y)), "exactly engine, omp and ompbun are selected");
  check(!selA.includes(a.unrelated!), "the unrelated same-image process is NOT selected");

  const fateA = await stopProcesses(planA.targets);
  for (const t of planA.targets) console.log(`  ${fateA.get(t.pid)}: ${show(t)}`);
  const rowsA1 = await listProcesses(PLATFORM);
  for (const role of ["engine", "omp", "ompbun"]) {
    const r = spawned.find((s) => s.pid === a[role]);
    check(!!r && !alive(rowsA1, r), `${role} (pid ${a[role]}) is gone`);
  }
  check(!!unrelatedRow && alive(rowsA1, unrelatedRow), `unrelated (pid ${a.unrelated}) is still running`);

  // ── [B] ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n[B] pid reuse: a ledger pointing at the unrelated process");
  if (unrelatedRow?.startedAt) {
    const rowsB = await listProcesses(PLATFORM);
    const exe = PLATFORM === "win32" ? unrelatedRow.exe! : process.execPath;
    const wrongStart = planLeftovers(rowsB, { pid: unrelatedRow.pid, startedAt: unrelatedRow.startedAt - 60_000, exe }, { selfPid: process.pid, platform: PLATFORM });
    console.log(`  same image, start 60s off -> verdict ${wrongStart.engineVerdict}, ${wrongStart.targets.length} selected`);
    check(wrongStart.engineVerdict === "pid-reused" && wrongStart.targets.length === 0, "a same-image process with a different start time is not ours");
    const wrongExe = planLeftovers(rowsB, { pid: unrelatedRow.pid, startedAt: unrelatedRow.startedAt, exe: PLATFORM === "win32" ? "C:\\elsewhere\\lucid-engine.exe" : "/elsewhere/lucid-engine" }, { selfPid: process.pid, platform: PLATFORM });
    console.log(`  right start, different image -> verdict ${wrongExe.engineVerdict}, ${wrongExe.targets.length} selected`);
    check(wrongExe.engineVerdict === "pid-reused" && wrongExe.targets.length === 0, "a process with the right start but a different image is not ours");
    const self = planLeftovers(rowsB, { pid: process.pid, startedAt: rowsB.find((r) => r.pid === process.pid)?.startedAt ?? 1, exe: process.execPath }, { selfPid: process.pid, platform: PLATFORM });
    check(self.targets.length === 0, "a ledger naming the current process selects nothing");
  }

  // ── [C] ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n[C] main AND engine crashed: the engine's children are orphans");
  const dirC = join(tmp, "c");
  launch(dirC, ["oldmain2", "engine2", "omp2", "ompbun2"]);
  const c = await pidsOf(dirC, ["oldmain2", "engine2", "omp2", "ompbun2"]);
  console.log(`  spawned: ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  const rowsC0 = await snapshot(Object.values(c));
  const engine2 = rowsC0.find((r) => r.pid === c.engine2) ?? null;
  writeLedger(ledgerPath, withEngine(
    freshLedger({ mainPid: c.oldmain2!, mainStartedAt: Date.now() - 5000, port: 5319, appVersion: "demo" }),
    engineRecordFromProbe(PLATFORM, c.engine2!, engine2, process.execPath, Date.now()),
  ));
  await hardKill(c.oldmain2!);
  await hardKill(c.engine2!);
  console.log("  crashed: oldmain2 and engine2 killed (single pid, no tree)");
  const prevC = assessPreviousRun(readLedgerText(ledgerPath), process.pid);
  if (prevC.verdict !== "unclean") throw new Error("ledger verdict C");
  const planC = planLeftovers(await listProcesses(PLATFORM), prevC.ledger.engine, { selfPid: process.pid, platform: PLATFORM });
  console.log(`  engine verdict: ${planC.engineVerdict}`);
  for (const t of planC.targets) console.log(`  selected ${show(t)}`);
  const selC = planC.targets.map((t) => t.pid).sort((x, y) => x - y);
  if (PLATFORM === "win32") {
    check(planC.engineVerdict === "gone", "the recorded engine is gone");
    check(JSON.stringify(selC) === JSON.stringify([c.omp2!, c.ompbun2!].sort((x, y) => x - y)), "exactly omp2 and ompbun2 are selected as orphans of the dead engine");
    const fateC = await stopProcesses(planC.targets);
    for (const t of planC.targets) console.log(`  ${fateC.get(t.pid)}: ${show(t)}`);
    const rowsC1 = await listProcesses(PLATFORM);
    for (const role of ["omp2", "ompbun2"]) {
      const r = spawned.find((s) => s.pid === c[role]);
      check(!!r && !alive(rowsC1, r), `${role} (pid ${c[role]}) is gone`);
    }
  } else {
    check(!selC.includes(c.engine2!), "POSIX: the dead engine is not selected (orphans were reparented to init)");
  }
  const rowsEnd = await listProcesses(PLATFORM);
  check(!!unrelatedRow && alive(rowsEnd, unrelatedRow), `unrelated (pid ${a.unrelated}) survived every scenario`);
} catch (e) {
  failed = true;
  console.error(`  FAIL ${e instanceof Error ? e.message : String(e)}`);
} finally {
  // Clean up everything this demo spawned, identified by (pid, start time) so a recycled pid is never hit.
  try {
    const rows = await listProcesses(PLATFORM);
    const left = spawned.filter((s) => alive(rows, s));
    if (left.length) {
      const fate = await stopProcesses(left);
      console.log(`\ncleanup: stopped ${[...fate.values()].filter((f) => f === "stopped").length} of ${left.length} demo process(es)`);
    }
  } catch { /* best-effort */ }
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(failed ? 1 : 0);
