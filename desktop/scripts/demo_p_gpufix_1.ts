// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_gpufix_1.ts
//
// Increment P-GPUFIX.1 (ADR-0246) - the zombie-SID GPU-sandbox self-heal.
// The brick (v1.11.9, 2026-07-18, electron/electron#51761): an unresolvable AppContainer SID in
// the install dir's DACL kills every sandboxed Chromium GPU child with 0xC0000022; after 9
// retries Electron logs FATAL "GPU process isn't usable. Goodbye." and the app dies before the
// window shows. An icacls grant fixes it only until the next NSIS upgrade recreates the folder.
// Proves the pure watchdog core main.ts consults, plus the main.ts wiring (source-level).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GPU_RELAUNCH_AFTER_DEATHS,
  GPU_SANDBOX_FLAG_FILE,
  GPU_SANDBOX_SWITCH,
  decideGpuAction,
  gpuDeathLogLine,
  relaunchArgs,
} from "../gpu_watchdog.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m: string): void => console.log(`   ${m} ✓`);

console.log("== P-GPUFIX.1 - zombie-SID GPU-sandbox watchdog ==");

// 1. The brick scenario: repeated pre-render GPU launch failures trigger the relaunch.
const DENIED = -1073741790; // STATUS_ACCESS_DENIED as Electron reports it (signed 32-bit)
const death = { type: "GPU", reason: "launch-failed", exitCode: DENIED };
let deaths = 0, rendered = false, sandboxOff = false;
const step = () => {
  const r = decideGpuAction(death, { deathsBefore: deaths, windowRendered: rendered, sandboxOff });
  deaths = r.deaths;
  return r.action;
};
if (step() !== "log") fail("death #1 must log, not relaunch (one-off crashes are tolerated)");
if (step() !== "relaunch") fail(`death #${GPU_RELAUNCH_AFTER_DEATHS} before first render must relaunch`);
ok(`GPU death #${GPU_RELAUNCH_AFTER_DEATHS} before first render -> relaunch with --${GPU_SANDBOX_SWITCH}`);

// 2. The relaunched instance runs with the sandbox off: more GPU deaths NEVER relaunch again.
sandboxOff = true;
for (let i = 0; i < 10; i++) if (step() === "relaunch") fail("sandbox-off instance must never relaunch (loop guard)");
ok("loop guard: with the sandbox already off, deaths log only - no relaunch loop");

// 3. After the first window rendered, a GPU crash is a recoverable driver hiccup, not the brick.
sandboxOff = false; rendered = true;
if (step() === "relaunch") fail("a post-render GPU crash must not trigger the mitigation");
ok("a GPU crash AFTER first render never drops the sandbox");

// 4. Normal lifecycle + non-GPU children are ignored and do not advance the count.
const before = deaths;
for (const d of [{ type: "GPU", reason: "clean-exit" }, { type: "GPU", reason: "killed" }, { type: "Utility", reason: "launch-failed" }]) {
  const r = decideGpuAction(d, { deathsBefore: deaths, windowRendered: false, sandboxOff: false });
  if (r.action !== "ignore" || r.deaths !== before) fail(`must ignore ${d.type}/${d.reason}`);
}
ok("clean-exit / killed / non-GPU children are ignored");

// 5. The engine.log line self-diagnoses: 0xC0000022 + the upstream issue + the switch.
const line = gpuDeathLogLine(death, 2, "relaunch", new Date().toISOString());
if (!line.includes("0xC0000022")) fail("log line must render the NTSTATUS as 0xC0000022");
if (!line.includes("electron/electron#51761")) fail("log line must name the upstream issue");
if (!line.includes(`--${GPU_SANDBOX_SWITCH}`)) fail("log line must name the switch");
ok("engine.log line carries 0xC0000022 + electron/electron#51761 + the switch");

// 6. The relaunch argv carries the switch exactly once (even if the flag-file write failed).
const argv = relaunchArgs(["--some-arg"]);
if (argv.filter((a) => a === `--${GPU_SANDBOX_SWITCH}`).length !== 1) fail("relaunch argv must carry the switch once");
if (relaunchArgs(argv).filter((a) => a === `--${GPU_SANDBOX_SWITCH}`).length !== 1) fail("switch must not duplicate");
ok("relaunch argv carries the switch exactly once");

// 7. Wiring (source-level): main.ts listens for child-process-gone, applies the persisted switch
//    EARLY (module load, before app ready), keeps the renderer sandbox untouched, and the dev
//    spawn now has an "error" listener teeing into engine.log.
const main = readFileSync(join(import.meta.dir, "..", "main.ts"), "utf8");
if (!main.includes('app.on("child-process-gone"')) fail("main.ts must listen for child-process-gone");
if (!main.includes(`appendSwitch(GPU_SANDBOX_SWITCH)`)) fail("main.ts must apply the persisted switch via appendSwitch");
if (!main.includes(GPU_SANDBOX_FLAG_FILE.split(".")[0]!) && !main.includes("GPU_SANDBOX_FLAG_FILE")) fail("main.ts must consult the flag file");
if (main.includes('"no-sandbox"') || main.includes("appendSwitch(\"no-sandbox\")")) fail("main.ts must NOT disable the renderer sandbox");
if (!/dev\.on\("error"/.test(main)) fail('startDevServer must handle dev.on("error") (spawn failures were silently swallowed)');
if (!main.includes("app.relaunch({ args: relaunchArgs(")) fail("main.ts must relaunch with the switch-carrying argv");
ok('main.ts wiring: child-process-gone watchdog + early appendSwitch + dev.on("error") tee, renderer sandbox intact');

console.log("PASS: P-GPUFIX.1 - the zombie-SID GPU brick self-heals (relaunch once, persist, never loop)");
