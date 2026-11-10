// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-HOLDER.1 (ADR-0534) - a lane's turn survives its engine.
//
// Drives the REAL engine (desktop/dev.ts) twice over one data root, with the house fake ACP agent behind the lane
// (demo_fake_omp.ts, so it runs on Windows too) and the REAL lucid-holder binary:
//   [1] engine A spawns a lane under a holder and sends it a 6-second turn
//   [2] engine A is KILLED mid-turn (no shutdown path: a crash, an update's kill, a closed window's kill)
//   [3] the lane's agent and its holder are still running, the turn recorded in flight
//   [4] engine B boots on the same data root, reattaches the lane, and the SAME turn settles: the reply is the
//       agent's answer to the prompt engine A sent, from the same agent process, nothing re-sent
//   [5] stopping the lane ends the holder and the agent and forgets the record
//
// Run with: bun run desktop/scripts/demo_p_holder_1.ts   (needs `bun run build-holder` in desktop/ first)

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEngine } from "../../harness/launcher/hub_tui.ts";
import { holderBinary, type HeldLaneRecord } from "../lane_holder.ts";
import { buildFakeOmp, isolatedHome } from "./demo_fake_omp.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  \u2713 ${msg}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

console.log("== ADR-0534 P-HOLDER.1: a lane's turn survives its engine ==\n");

const bin = holderBinary();
if (!bin) throw new Error("lucid-holder is not built: run `bun run build-holder` in desktop/ first");
const repo = join(import.meta.dir, "..", "..");
const dataRoot = mkdtempSync(join(tmpdir(), "lucid-holder1-"));
const home = mkdtempSync(join(tmpdir(), "lucid-holder1-home-"));
const ws = mkdtempSync(join(tmpdir(), "lucid-holder1-ws-"));
const fakeOmp = buildFakeOmp(dataRoot, repo);
const env = { ...process.env, LUCID_DATA_ROOT: dataRoot, ...isolatedHome(home), LUCID_OMP_BIN: fakeOmp, LUCID_HOLDER_BIN: bin };
const holders = join(dataRoot, "lane-holders");
const record = (): HeldLaneRecord | null => {
  try {
    const f = readdirSync(holders).find((n) => n.endsWith(".lane.json"));
    return f ? JSON.parse(readFileSync(join(holders, f), "utf8")) as HeldLaneRecord : null;
  } catch { return null; }
};

async function boot(tag: string): Promise<{ proc: Bun.Subprocess; api: (path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>> }> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  const proc = Bun.spawn(["bun", join(repo, "desktop", "dev.ts")], { cwd: repo, env: { ...env, PORT: String(port) }, stdout: "ignore", stderr: "ignore" });
  let engine = null;
  for (let i = 0; i < 200 && !engine; i++) { engine = await findEngine({ LUCID_DATA_ROOT: dataRoot }); if (!engine) await sleep(200); }
  if (!engine) throw new Error(`engine ${tag} did not come up`);
  const e = engine;
  const api = async (path: string, body?: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${e.port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "x-lucid-token": e.token, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = await res.json() as { data?: unknown };
    return (parsed.data ?? parsed) as Record<string, unknown>;
  };
  return { proc, api };
}

let b: Awaited<ReturnType<typeof boot>> | null = null;
const a = await boot("A");
try {
  console.log("[1] engine A: a lane under a holder, and a 6-second turn");
  const spawned = await a.api("/api/fleet/spawn", { cwd: ws, name: "held" });
  const laneId = String((spawned.lane as { id: string }).id);
  assert(spawned.ok === true && /^lane-[0-9a-f]{8}$/.test(laneId), `lane ${laneId} spawned`);
  const rec0 = record();
  assert(!!rec0 && alive(rec0.pid) && alive(rec0.childPid), `its agent runs under holder pid ${rec0?.pid} (agent pid ${rec0?.childPid})`);
  // The prompt streams NDJSON until the turn ends; engine A dies long before that.
  void a.api("/api/fleet/prompt", { laneId, text: "[slow 6s] finish this after the engine is gone" }).catch(() => {});
  for (let i = 0; i < 200 && !record()?.inFlight; i++) await sleep(50);
  assert(record()?.inFlight?.text === "[slow 6s] finish this after the engine is gone", "the turn is recorded in flight");

  console.log("\n[2] engine A is killed mid-turn");
  a.proc.kill("SIGKILL");
  await a.proc.exited;
  assert(true, `engine A exited (${a.proc.exitCode ?? a.proc.signalCode})`);

  console.log("\n[3] the agent and its holder run on");
  const rec1 = record()!;
  assert(alive(rec1.pid) && alive(rec1.childPid), "holder and agent are still running");

  console.log("\n[4] engine B boots on the same data root and takes the lane back");
  b = await boot("B");
  let view: Record<string, unknown> | undefined;
  for (let i = 0; i < 200; i++) {
    view = ((await b.api("/api/fleet/status")).lanes as Record<string, unknown>[]).find((l) => l.id === laneId);
    if (view && view.status === "done") break;
    await sleep(100);
  }
  assert(view?.status === "done", `lane ${laneId} is back on engine B and its turn settled (${String(view?.status)})`);
  const turns = (await b.api(`/api/fleet/transcript?laneId=${laneId}`)).turns as { role: string; text: string }[];
  const reply = turns.filter((t) => t.role === "assistant").at(-1)?.text ?? "";
  assert(reply.includes("You said:") && reply.includes("finish this after the engine is gone"), "the reply answers the prompt engine A sent");
  assert(turns.filter((t) => t.role === "user").length === 1, "nothing was re-sent");
  const rec2 = record()!;
  assert(rec2.childPid === rec0!.childPid && rec2.inFlight === null && rec2.turns === 1, "same agent process, turn recorded settled");

  console.log("\n[5] stopping the lane ends the holder and the agent");
  await b.api("/api/fleet/stop", { laneId });
  for (let i = 0; i < 200 && (alive(rec2.pid) || alive(rec2.childPid)); i++) await sleep(50);
  assert(!alive(rec2.pid) && !alive(rec2.childPid), "holder and agent ended");
  assert(record() === null, "the record is gone");
  console.log("\nP-HOLDER.1 demo passed - a lane's turn survives its engine.");
} finally {
  try { a.proc.kill("SIGKILL"); } catch { /* gone */ }
  if (b) { try { b.proc.kill("SIGKILL"); await b.proc.exited; } catch { /* gone */ } }
  const left = record();
  if (left) { try { process.kill(left.pid); } catch { /* gone */ } }
  for (const d of [dataRoot, home, ws]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* still held */ } }
}
