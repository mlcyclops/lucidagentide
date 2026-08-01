// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-WINBOOT.2 - the permanent fix for the Program Files brick (ADR-0251).
//
// P-WINBOOT.1 stopped new installs from reaching a protected dir and made the failure legible; the
// ROOT cause remained (main.ts ran `bun run desktop/dev.ts`, and Bun EPERMs loading .ts from a
// Program Files tree). This ships the engine as a `bun build --compile` standalone binary: dev.ts +
// every imported module is EMBEDDED (Bun never module-loads a .ts off the install disk), native addons
// are the only --external (loaded via the OS loader, which works from Program Files), and the renderer
// is prebuilt so there is no runtime Bun.build of .ts either.
//
// This demo proves it for real: the pure launch decisions, the main.ts/dev.ts/package.json wiring, and
// then it BUILDS and BOOTS the actual compiled engine and confirms it serves /api/health + the prebuilt
// /app.js with NO runtime .ts load. Temp artifacts are cleaned up.
//
// Run with: bun run desktop/scripts/demo_p_winboot_2.ts

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { engineDesktopDir, engineExeName, resolveEngineSpawn } from "../engine_launch.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

const DESKTOP = join(import.meta.dir, "..");
const REPO = join(DESKTOP, "..");

console.log("== #ADR-0251 P-WINBOOT.2: the compiled engine artifact ==\n");

console.log("[1] the pure launch decisions");
const winRepo = "C:\\Program Files\\LucidAgentIDE\\resources\\repo";
const winExe = join(winRepo, "bin", engineExeName("win32"));
assert(resolveEngineSpawn({ packaged: true, repoRoot: winRepo, bun: "bun", exists: (p) => p === winExe, platform: "win32" }).compiled === true, "packaged + the compiled binary present -> spawn the binary (embedded dev.ts, no .ts load from the install dir)");
assert(resolveEngineSpawn({ packaged: true, repoRoot: winRepo, bun: "bun", exists: () => false, platform: "win32" }).cmd === "bun", "packaged but binary MISSING -> falls back to `bun run` so the app still starts");
assert(resolveEngineSpawn({ packaged: false, repoRoot: winRepo, bun: "bun", exists: () => true, platform: "win32" }).compiled === false, "a dev run always uses `bun run desktop/dev.ts`");
assert(engineDesktopDir("B:\\~BUN\\root", winExe, () => false) === join(winRepo, "desktop"), "a compiled binary derives <repo>/desktop from execPath (import.meta.dir is a virtual bunfs path)");
assert(engineDesktopDir(DESKTOP, "irrelevant", existsSync) === DESKTOP, "a dev run uses import.meta.dir as-is (renderer/ exists there)");

console.log("\n[2] the wiring is in place");
const main = readFileSync(join(DESKTOP, "main.ts"), "utf8");
assert(main.includes("resolveEngineSpawn({"), "main.ts resolves the engine command via resolveEngineSpawn");
assert(main.includes("spawn(engineSpec.cmd, engineSpec.args"), "main.ts spawns the RESOLVED engine (not a hardcoded `bun run dev.ts`)");
const dev = readFileSync(join(DESKTOP, "dev.ts"), "utf8");
assert(dev.includes("engineDesktopDir(import.meta.dir"), "dev.ts derives its base dir via engineDesktopDir (execPath-safe when compiled)");
assert(!/const ROOT = join\(import\.meta\.dir/.test(dev), "dev.ts no longer resolves ROOT via raw import.meta.dir");
assert(dev.includes('join(ROOT, "app.bundle.js")'), "dev.ts serves the prebuilt renderer bundle when present (no runtime Bun.build in packaged mode)");
const pkg = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8"));
assert(pkg.scripts["compile-engine"].includes("--compile dev.ts") && pkg.scripts["compile-engine"].includes("*.node"), "compile-engine builds the standalone engine with native addons external");
assert(pkg.scripts["build-renderer"].includes("app.bundle.js"), "build-renderer prebuilds the renderer bundle");
for (const k of ["dist", "dist:win", "dist:mac", "dist:linux"]) assert(pkg.scripts[k].includes("compile-engine") && pkg.scripts[k].includes("build-renderer"), `${k} runs both engine build steps before electron-builder`);

console.log("\n[3] the compiled engine BUILDS, BOOTS, and serves (the keystone)");
const tmpExe = join(REPO, "bin", `lucid-engine-demo${process.platform === "win32" ? ".exe" : ""}`);
const bundle = join(DESKTOP, "renderer", "app.bundle.js");
let health: string | null = null, appjs: { status: number; bytes: number; isError: boolean } | null = null;
try {
  const br = Bun.spawnSync(["bun", "build", "renderer/app.ts", "--target=browser", "--outfile", "renderer/app.bundle.js", "--sourcemap=inline"], { cwd: DESKTOP, stdout: "ignore", stderr: "pipe" });
  assert(br.exitCode === 0 && existsSync(bundle), "build-renderer produced renderer/app.bundle.js");
  const ce = Bun.spawnSync(["bun", "build", "--compile", "dev.ts", "--outfile", tmpExe, "--external", "*.node"], { cwd: DESKTOP, stdout: "ignore", stderr: "pipe" });
  assert(ce.exitCode === 0 && existsSync(tmpExe), "compile-engine produced the standalone binary (DuckDB natives external, all JS embedded)");
  const port = 5300 + Math.floor(Math.random() * 400);
  const proc = Bun.spawn([tmpExe], { cwd: REPO, env: { ...process.env, PORT: String(port) }, stdout: "ignore", stderr: "ignore" });
  try {
    for (let i = 0; i < 48; i++) {
      await Bun.sleep(250);
      if (proc.exitCode !== null) break;
      try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) { health = await r.text(); break; } } catch { /* still starting */ }
    }
    if (health) {
      const r = await fetch(`http://127.0.0.1:${port}/app.js`, { signal: AbortSignal.timeout(4000) });
      const b = await r.text();
      appjs = { status: r.status, bytes: b.length, isError: b.startsWith("document.body.innerHTML=") };
    }
  } finally {
    try { if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"]); else proc.kill(); } catch { /* best effort */ }
  }
  assert(health !== null && JSON.parse(health).ok === true, "the compiled engine booted and answered /api/health (DuckDB natives resolved at runtime)");
  assert(appjs !== null && appjs.status === 200 && appjs.bytes > 1_000_000 && !appjs.isError, "it served the prebuilt /app.js from the execPath-derived root (no runtime Bun.build, nothing .ts loaded off disk)");
} finally {
  // Windows briefly locks a just-killed .exe, so retry the temp-binary removal after a short wait.
  for (let i = 0; i < 6; i++) { try { rmSync(tmpExe, { force: true }); break; } catch { await Bun.sleep(400); } }
  try { rmSync(bundle, { force: true }); } catch { /* best effort */ }
}

console.log("\n\u2713 P-WINBOOT.2 demo passed - the engine ships as a compiled binary that boots + serves without Bun ever loading a .ts from the install dir.");
