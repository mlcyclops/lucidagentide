// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// demo-P-BROWSER.4 (ADR-0415): the agent's visible browser window is no longer born hidden.
//
// The bug: Electron spawns the engine with windowsHide, the engine spawned omp with windowsHide, so omp
// had NO console window; omp's daemon broker then spawned the shared headed Chromium with windowsHide
// (its rule: hide when the host has no console), and Windows applied that SW_HIDE to Chrome's first
// ShowWindow: a white, frameless, unclosable rectangle where the login page should have been.
//
// This demo runs the real chain with real processes, from the engine's seat down to omp's seat:
//   [1] pure policy: attach when a console window exists, hide when none, no-op elsewhere
//   [2] a child started exactly like the engine (windowsHide + pipes) has no console window, allocates a
//       HIDDEN one with ensureHiddenConsole, and its stdout still reaches the parent afterwards
//   [3] a grandchild spawned with the policy's windowsHide (omp's position) inherits that console window,
//       hidden, so omp's own `hostHasInheritableConsole()` rule answers true and it spawns Chrome shown
// On a non-Windows host [2] and [3] are reported as not applicable and the demo passes on [1].
//
// Run with: bun run desktop/scripts/demo_p_browser_4.ts   (make demo-P-BROWSER.4)

import { join } from "node:path";
import { agentSpawnWindowsHide, shouldAllocateConsole } from "../console_host.ts";

let failures = 0;
const ok = (msg: string) => console.log(`  ok   ${msg}`);
const fail = (msg: string) => { failures++; console.log(`  FAIL ${msg}`); };
const check = (cond: boolean, msg: string) => (cond ? ok(msg) : fail(msg));

console.log("\n[1] the spawn policy (pure)");
check(agentSpawnWindowsHide({ platform: "win32", consoleWindow: true }) === false, "windows + console window: omp attaches to it (windowsHide false)");
check(agentSpawnWindowsHide({ platform: "win32", consoleWindow: false }) === true, "windows + no console: hide, so nothing pops up");
check(agentSpawnWindowsHide({ platform: "linux", consoleWindow: false }) === true, "elsewhere: unchanged (the flag is a no-op)");
check(shouldAllocateConsole({ platform: "win32", consoleWindow: false, stdioIsTTY: true }) === false, "a terminal run is never detached from its terminal");

if (process.platform !== "win32") {
  console.log("\n[2]/[3] not applicable off Windows (the engine allocates nothing and omp is spawned as before)");
} else {
  const HOST = join(import.meta.dir, "..", "console_host.ts");
  // The child and grandchild scripts: the child sits in the engine's seat, the grandchild in omp's.
  const CHILD = `
    import { ensureHiddenConsole, hasConsoleWindow, ompWindowsHide } from ${JSON.stringify(HOST)};
    const before = hasConsoleWindow();
    const st = ensureHiddenConsole();
    const hide = ompWindowsHide();
    const g = Bun.spawn([process.execPath, "-e", ${JSON.stringify(`
      import { dlopen, FFIType } from "bun:ffi";
      const k = dlopen("kernel32.dll", { GetConsoleWindow: { args: [], returns: FFIType.ptr } }).symbols;
      const u = dlopen("user32.dll", { IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.bool } }).symbols;
      const h = k.GetConsoleWindow();
      console.log(JSON.stringify({ window: h !== null, visible: h === null ? null : u.IsWindowVisible(h) }));
    `)}], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: hide });
    const gout = await new Response(g.stdout).text();
    await g.exited;
    console.log(JSON.stringify({ before, state: st, windowsHide: hide, grandchild: gout.trim() }));
  `;
  console.log("\n[2] a child started like the engine (windowsHide + pipes) gives itself a hidden console");
  const child = Bun.spawn([process.execPath, "-e", CHILD], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code = await child.exited;
  if (code !== 0 || !out.trim()) {
    fail(`the child did not report (exit ${code}): ${err.trim().slice(0, 400)}`);
  } else {
    const r = JSON.parse(out.trim()) as { before: boolean; state: { window: boolean; allocated: boolean; hidden: boolean; reason?: string }; windowsHide: boolean; grandchild: string };
    check(r.before === false, "before: no console window (CREATE_NO_WINDOW, the engine's own start)");
    check(r.state.window && r.state.allocated, `after ensureHiddenConsole: a console window exists and was allocated here${r.state.reason ? ` (${r.state.reason})` : ""}`);
    check(r.state.hidden, "the console window is hidden (nothing on screen)");
    ok("the child's stdout still reached this parent after AllocConsole (this report is it)");
    console.log("\n[3] the grandchild in omp's seat sees a hidden console it can share");
    check(r.windowsHide === false, "the omp spawn policy chose windowsHide false (attach to the hidden console)");
    let g: { window: boolean; visible: boolean | null } | null = null;
    try { g = JSON.parse(r.grandchild); } catch { /* reported below */ }
    check(!!g && g.window, `the grandchild has a console window (omp's hostHasInheritableConsole() answers true)${g ? "" : `: got ${JSON.stringify(r.grandchild)}`}`);
    check(!!g && g.visible === false, "and it is hidden, so omp's console children open no window while its GUI children (Chrome) are shown");
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\ndemo-P-BROWSER.4: all checks passed");
process.exit(failures ? 1 : 0);
