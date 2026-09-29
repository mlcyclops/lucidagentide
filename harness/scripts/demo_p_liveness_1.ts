// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_liveness_1.ts
//
// P-LIVENESS.1 (ADR-0418): an open tool call is judged on evidence, marked "likely stuck" when nothing it
// started moves, and stopped only by the user. Proven against REAL processes on this machine:
//   [1] a fake agent tree: a root that, past its boot chain, starts a helper, then (the "call") a blocked
//       process and a busy one. The shipping enumeration + tree walk sees exactly the work processes, and
//       the call owns only what started after it;
//   [2] real counters over real looks: the blocked process does not move, the busy one does;
//   [3] those real looks, folded on a compressed clock (each look stands for PULSE_STUCK_MS / 3), mark the
//       blocked call likely stuck with a Stop offer, and the busy one alive; nothing acts on its own;
//   [4] the Stop command ends exactly the call's processes: the helper and the agent root survive.
// Windows only (POSIX counters are not measurable, so the verdict never fires there by design).
//
// Run: bun run harness/scripts/demo_p_liveness_1.ts  (about 30 s of real process time)

import { spawn } from "node:child_process";
import { listProcesses, stopProcesses, type ProcRow } from "../../desktop/leftover_reaper.ts";
import { PULSE_STUCK_MS, PulseTracker, type WorkerProcs } from "../../desktop/call_pulse.ts";
import { stopCallProcesses, workerProcesses } from "../../desktop/call_pulse_proc.ts";
import { livenessVerdict } from "../../desktop/turn_progress.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0418 P-LIVENESS.1: evidence for an open call, marked not killed ==\n");
if (process.platform !== "win32") { console.log("  skip: the counters this verdict reads are Windows-only; elsewhere it never fires (by design)."); process.exit(0); }

// The fake agent: the root is the "omp child". Past the boot chain (processes started within 5 s of a core
// parent are core) it starts a long-lived helper (like an LSP server), announces the call, then starts the
// call's two processes.
const BUN = process.execPath;
const ROOT = `
const { spawn } = require("node:child_process");
const kid = (code) => spawn(process.execPath, ["-e", code], { stdio: "ignore", windowsHide: true });
setTimeout(() => {
  kid("setTimeout(() => {}, 600000)");                                             // helper, pre-call
  setTimeout(() => {
    console.log("CALL " + Date.now());
    kid("setTimeout(() => {}, 600000)");                                           // blocked: never moves
    kid("setInterval(() => { let x = 0; for (let i = 0; i < 3e7; i++) x += i; }, 1000)"); // busy
  }, 3000);
}, 8000);
setTimeout(() => {}, 600000);
`;
const root = spawn(BUN, ["-e", ROOT], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
const cleanup = async (): Promise<void> => {
  try {
    const rows = await listProcesses();
    const w = root.pid ? workerProcesses(rows, root.pid, "win32") : null;
    const self = rows.filter((r) => r.pid === root.pid);
    await stopProcesses([...(w?.procs ?? []), ...self]);
  } catch { /* best-effort */ }
};

try {
  console.log("[1] the agent tree, walked by the shipping enumeration");
  const callAt = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the fake agent never started its call")), 60_000);
    root.stdout!.on("data", (d) => { const m = /CALL (\d+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
  });
  await Bun.sleep(5000); // let both call processes finish starting up (a fresh runtime burns CPU for a moment)
  const look = async (): Promise<WorkerProcs> => {
    const w = workerProcesses(await listProcesses(), root.pid!, "win32");
    return w ?? fail("the agent root vanished from the process table");
  };
  const first = await look();
  ok(first.measurable, "every work process reports CPU and I/O counters");
  // Windows gives each console child a conhost.exe; it is part of the tree (flat, harmless), not a worker.
  const workers = first.procs.filter((p) => !/^conhost\.exe$/i.test(p.name));
  ok(workers.length === 3, `three work processes under the root (helper + blocked + busy), core excluded: ${first.procs.map((p) => p.name).join(", ")}`);
  const own = workers.filter((p) => (p.startedAt ?? 0) >= callAt - 500);
  ok(own.length === 2, "the call owns exactly the two processes that started after it");

  console.log("\n[2] real counters over real looks");
  const looks: WorkerProcs[] = [first];
  for (let i = 0; i < 3; i++) { await Bun.sleep(4000); looks.push(await look()); }
  const series = (pid: number): ProcRow[] => looks.map((l) => l.procs.find((p) => p.pid === pid) ?? fail(`pid ${pid} missing from a look`));
  // Which of the two is which is read off the counters themselves (both spawn in the same millisecond).
  const moved = (pid: number): number => { const s = series(pid); return s.at(-1)!.cpuMs! - s[0]!.cpuMs!; };
  const [blocked, busy] = [...own].sort((a, b) => moved(a.pid) - moved(b.pid));
  const b = series(blocked!.pid), u = series(busy!.pid);
  ok(b.every((r) => r.cpuMs === b[0]!.cpuMs && r.ioBytes === b[0]!.ioBytes), `the blocked process never moved (cpu ${b[0]!.cpuMs} ms throughout)`);
  ok(u.at(-1)!.cpuMs! > u[0]!.cpuMs!, `the busy process moved (+${u.at(-1)!.cpuMs! - u[0]!.cpuMs!} ms cpu over 12 s)`);

  console.log("\n[3] the verdict on those looks (compressed clock: each look stands for PULSE_STUCK_MS / 3)");
  const verdictFor = (keep: (p: ProcRow) => boolean) => {
    const t = new PulseTracker();
    const step = PULSE_STUCK_MS / 3;
    let at = callAt;
    for (const l of looks) { at += step; t.observe({ at, work: { procs: l.procs.filter(keep), measurable: l.measurable }, callStartedAt: callAt, subagent: { lastWriteAt: 0, live: 0 } }); }
    return livenessVerdict({ busy: true, dead: false, lastSignalMs: at - callAt, stepsOpen: [{ label: "bash: node scrape.ts", elapsedMs: at - callAt }], pulse: t.evidence, now: at });
  };
  const stuck = verdictFor((p) => p.pid !== busy!.pid);
  ok(stuck.state === "stuck" && stuck.canStopCall === true, `blocked call: "${stuck.label}", Stop command offered`);
  const alive = verdictFor(() => true);
  ok(alive.state === "working" && !alive.canStopCall, `busy call: "${alive.label}"`);

  console.log("\n[4] the user's Stop command ends only the call's processes");
  const r = await stopCallProcesses(root.pid!, callAt);
  ok(r.stopped.length >= 2 && r.failed.length === 0, `stopped ${r.stopped.join(", ")}`);
  const after = await listProcesses();
  const alivePid = (pid: number) => after.some((x) => x.pid === pid);
  ok(!alivePid(blocked!.pid) && !alivePid(busy!.pid), "both call processes are gone");
  const helper = workers.find((p) => p !== blocked && p !== busy)!;
  ok(alivePid(helper.pid) && alivePid(root.pid!), "the pre-call helper and the agent root are untouched");

  console.log("\n\u2713 P-LIVENESS.1 demo passed - an open call is judged on evidence, marked likely stuck, and stopped only by the user.");
} finally {
  await cleanup();
}
process.exit(0);
