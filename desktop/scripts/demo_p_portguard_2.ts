// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_portguard_2.ts - P-PORTGUARD.2: the engine never orphans itself, and a
// lost port bind is diagnosed instead of crashing.
//
// The field incident (2026-09-23, engine.log): a launch wrote its banner and then
//   [Uncaught Exception] Error: Failed to start server. Is port 5319 in use?
// Nothing foreign was on the port - it was LUCID's OWN engine from the previous session. main.ts
// kills that child from app.on("quit"), which never runs when Electron's main dies any other way,
// and Windows does not reap a spawned child with its parent. So the orphan held 5319 (plus its
// whisper/headroom children) and every later launch lost the bind race to a ghost.
//
// Two halves, both proven here for real (no mocks in [4] and [5]):
//   - ownership: the engine watches the pid that spawned it and exits when that pid disappears.
//   - diagnosis: a lost bind exits with ENGINE_EXIT_PORT_BUSY and one actionable line, and the
//     classifier turns that into a dialog naming the port, never a "reinstall somewhere else".
//
//   bun run desktop/scripts/demo_p_portguard_2.ts

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyEngineFailure, ENGINE_EXIT_PORT_BUSY, type EngineFailureInput } from "../engine_boot.ts";
import { parentAlive, parentWatchConfig } from "../parent_watch.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}
function sleep(ms: number): Promise<void> {
  const t = Promise.withResolvers<void>();
  setTimeout(t.resolve, ms);
  return t.promise;
}
const DESKTOP = join(import.meta.dir, "..");
const PORT_A = 53181; // squatted, so the engine must lose the bind
const PORT_B = 53182; // free, so the engine boots and can be orphaned

const failInput: EngineFailureInput = {
  packaged: true,
  repoRoot: "C:\\Users\\me\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\repo",
  repoWritable: true, protectedRoot: false, exited: false, exitCode: null, lastLogLine: "",
  port: 5319, logPath: "C:\\Users\\me\\AppData\\Roaming\\lucidagentide-desktop\\engine.log", platform: "win32",
};

console.log("[1] a busy port is its own diagnosis, not a generic crash");
const byCode = classifyEngineFailure({ ...failInput, exited: true, exitCode: ENGINE_EXIT_PORT_BUSY });
assert(byCode.kind === "port-busy" && byCode.title.includes("5319"), "the engine's own exit code classifies as port-busy and the title names the port");
assert(byCode.detail.includes("Task Manager") && byCode.detail.includes("LUCID_PORT"), "the dialog gives both real remedies: end the leftover engine, or run a separate instance on another port");
const raw = "[Uncaught Exception] Error: Failed to start server. Is port 5319 in use?";
assert(classifyEngineFailure({ ...failInput, exited: true, exitCode: 1, lastLogLine: raw }).kind === "port-busy", "the raw bun message alone is enough, so a package cut before the exit code still diagnoses correctly");
assert(classifyEngineFailure({ ...failInput, protectedRoot: true, repoWritable: false, exited: true, exitCode: ENGINE_EXIT_PORT_BUSY }).kind === "port-busy", "a busy port is NEVER blamed on the install location (direct evidence outranks the path heuristic)");
assert(classifyEngineFailure({ ...failInput, exited: false, lastLogLine: raw }).kind === "timeout", "a still-running engine is not called port-busy just because an old bind error sits in the tail");

console.log("\n[2] the watchdog only ever fires on PROOF the parent is gone");
assert(parentWatchConfig({}, 99) === null, "a standalone engine run (no LUCID_MAIN_PID) is never watched");
assert(parentWatchConfig({ LUCID_MAIN_PID: "4242" }, 99)?.pid === 4242, "the pid main hands down is the pid watched");
assert(parentAlive(4242, () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); }) === false, "ESRCH means gone");
assert(parentAlive(4242, () => { throw Object.assign(new Error("x"), { code: "EPERM" }); }) === true, "EPERM means alive-but-not-ours - an engine must not exit on someone else's pid");

console.log("\n[3] both halves are actually wired into the engine and main");
const dev = readFileSync(join(DESKTOP, "dev.ts"), "utf8");
const main = readFileSync(join(DESKTOP, "main.ts"), "utf8");
assert(main.includes("LUCID_MAIN_PID: String(process.pid)"), "main hands the engine its own pid at spawn");
assert(dev.includes("parentWatchConfig(process.env, process.pid)") && dev.includes("process.kill(pid, 0)"), "the engine polls that pid with a signal-0 probe");
assert(dev.includes("process.exit(ENGINE_EXIT_PORT_BUSY)"), "a lost bind exits with the classified code instead of escaping as an uncaught exception");
assert(main.includes('report.kind === "port-busy"') && main.includes("formatSquatter(await probePortOwner())"), "the port-busy dialog names the process actually holding the port (same probe + renderer as ADR-0305)");

// ── live proof ────────────────────────────────────────────────────────────────────────────────────
const bun = process.execPath; // this demo runs under the same bun the engine uses
const work = mkdtempSync(join(tmpdir(), "lucid-portguard2-"));
writeFileSync(join(work, "gui.json"), "{}"); // isolated settings: never touch the user's real instance
const engineEnv = { ...process.env, LUCID_GUI_SETTINGS_FILE: join(work, "gui.json"), LUCID_DATA_ROOT: work };
const squatSrc = join(work, "squat.ts");
writeFileSync(squatSrc, `Bun.serve({ port: ${PORT_A}, hostname: "127.0.0.1", fetch: () => new Response("squat") });\nconsole.log("up");\nsetInterval(() => {}, 1000);\n`);
const parentSrc = join(work, "parent.ts");
writeFileSync(parentSrc, `console.log("up");\nsetInterval(() => {}, 1000);\n`);

async function runUntilUp(src: string): Promise<ChildProcess> {
  const p = spawn(bun, ["run", src], { stdio: ["ignore", "pipe", "inherit"] });
  const up = Promise.withResolvers<void>();
  p.stdout!.on("data", () => up.resolve());
  await up.promise;
  return p;
}

/** The child's exit code, awaited once. */
function exitOf(p: ChildProcess): Promise<number | null> {
  const done = Promise.withResolvers<number | null>();
  p.on("exit", (code) => done.resolve(code));
  return done.promise;
}

console.log("\n[4] LIVE: the engine loses a bind race and reports it in one line");
const squatter = await runUntilUp(squatSrc);
const busy = spawn(bun, ["run", join(DESKTOP, "dev.ts")], { cwd: join(DESKTOP, ".."), env: { ...engineEnv, PORT: String(PORT_A) }, stdio: ["ignore", "pipe", "pipe"] });
let busyOut = "";
busy.stdout!.on("data", (d) => { busyOut += d.toString(); });
busy.stderr!.on("data", (d) => { busyOut += d.toString(); });
const busyCode = await exitOf(busy);
squatter.kill();
assert(busyCode === ENGINE_EXIT_PORT_BUSY, `the engine exits ${ENGINE_EXIT_PORT_BUSY} (observed ${busyCode}), so main classifies it without parsing prose`);
assert(busyOut.includes(`port ${PORT_A} is already in use`) && busyOut.includes("EADDRINUSE"), "engine.log gets a plain-language FATAL line naming the port");
assert(!/Uncaught Exception/.test(busyOut), "no uncaught-exception stack: the bind failure is handled, not crashed");

console.log("\n[5] LIVE: an engine whose parent dies takes itself down and frees the port");
const parent = await runUntilUp(parentSrc);
const engine = spawn(bun, ["run", join(DESKTOP, "dev.ts")], {
  cwd: join(DESKTOP, ".."),
  env: { ...engineEnv, PORT: String(PORT_B), LUCID_MAIN_PID: String(parent.pid), LUCID_PARENT_WATCH_MS: "250" },
  stdio: ["ignore", "pipe", "pipe"],
});
let engineOut = "";
engine.stdout!.on("data", (d) => { engineOut += d.toString(); });
engine.stderr!.on("data", (d) => { engineOut += d.toString(); });
for (let i = 0; i < 120 && !engineOut.includes("desktop renderer"); i++) await sleep(250);
assert(engineOut.includes("desktop renderer"), "the engine came up on the free port");
const health = await fetch(`http://127.0.0.1:${PORT_B}/api/health`).then((r) => r.ok).catch(() => false);
assert(health, "it is really serving (health answered)");

parent.kill(); // the orphaning event: main dies WITHOUT running any cleanup handler
const exitCode = await Promise.race([exitOf(engine), sleep(20_000).then(() => "timeout" as const)]);
assert(exitCode !== "timeout", "the engine noticed its parent died and exited on its own (before the fix it lived forever)");
assert(engineOut.includes(`parent process ${parent.pid} is gone`), "it says WHY it exited, so engine.log explains the shutdown");
const stillBound = await fetch(`http://127.0.0.1:${PORT_B}/api/health`).then(() => true).catch(() => false);
assert(!stillBound, `port ${PORT_B} is released, so the next launch can bind it - the crash class is gone at the root`);

console.log("\n\u2713 P-PORTGUARD.2 demo passed - the engine cannot outlive its window, and a taken port is a diagnosis, not a crash.");
process.exit(0);
