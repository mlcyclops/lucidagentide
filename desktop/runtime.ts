// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/runtime.ts - runtime resolution + first-run bootstrap (main process).
//
// Goal: a zero-prerequisite install. The installer bundles the small static
// `bun` and `uv` binaries (CI downloads them per-OS into resources/runtimes);
// on first launch we use them to install the `omp` agent and provision the
// scanner's Python interpreter into the app's userData. Nothing is required on
// the user's machine beforehand.
//
// Resolution order for each tool: bundled (packaged) → app-managed (userData) →
// the user's own install (~/.bun, ~/.local) → bare name on PATH. So a developer
// box with bun/omp/uv already installed behaves exactly as before (no bootstrap,
// no splash) - the bundle only kicks in for packaged end-user installs.
//
// Everything here is best-effort: a failed bootstrap never blocks launch. If the
// scanner interpreter is missing, the fail-closed gate (CLAUDE.md #3) simply
// blocks tool calls - it never silently treats "no scanner" as "safe".

import { app } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter as PATH_SEP, dirname, join } from "node:path";
import { homedir } from "node:os";

const EXE = process.platform === "win32" ? ".exe" : "";

/** The LucidAgentIDE repo root (bundled into Resources/repo when packaged). */
function repoRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, "repo") : join(app.getAppPath(), "..");
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p;
  return null;
}

// --- bundled static binaries (named <tool>-<platform>-<arch>[.exe]) ----------
function bundled(tool: "bun" | "uv"): string | null {
  if (!app.isPackaged) return null;
  const p = join(process.resourcesPath, "runtimes", `${tool}-${process.platform}-${process.arch}${EXE}`);
  return existsSync(p) ? p : null;
}

// --- bundled relocatable CPython for the scanner (air-gap, ADR-0225) ----------
// When present (fetch-runtimes.ts bundled a `python-<plat>-<arch>/` tree) the scanner
// interpreter is resolved OFFLINE — no `uv venv --python` network call on first run.
function bundledPython(): string | null {
  if (!app.isPackaged) return null;
  const dir = join(process.resourcesPath, "runtimes", `python-${process.platform}-${process.arch}`);
  const p = process.platform === "win32" ? join(dir, "python.exe") : join(dir, "bin", "python3");
  return existsSync(p) ? p : null;
}

/** The omp CLI shim bundled inside the packaged repo's node_modules (`.bin/omp[.exe]`, a bun
 *  shim with a RELATIVE path to the vendored `@oh-my-pi/pi-coding-agent`). Resolving this lets a
 *  packaged install run omp with ZERO network — no `bun add -g` on first launch (air-gap, ADR-0225). */
function bundledOmp(): string { return join(repoRoot(), "node_modules", ".bin", `omp${EXE}`); }

// --- app-managed install locations (userData; writable on every OS) ----------
function ompGlobalDir(): string { return join(app.getPath("userData"), "runtimes", "bun-global"); }
function managedOmp(): string { return join(ompGlobalDir(), "bin", `omp${EXE}`); }
function venvDir(): string { return join(app.getPath("userData"), "runtimes", "scanner-venv"); }
function venvPython(): string {
  return process.platform === "win32"
    ? join(venvDir(), "Scripts", "python.exe")
    : join(venvDir(), "bin", "python");
}
function projectVenvPython(): string {
  const dir = join(repoRoot(), "scanner-sidecar", ".venv");
  return process.platform === "win32" ? join(dir, "Scripts", "python.exe") : join(dir, "bin", "python");
}

// --- resolvers ---------------------------------------------------------------
/** Common absolute install dirs for a CLI tool, so a Finder-launched GUI app
 *  (minimal PATH: /usr/bin:/bin) still finds Homebrew / system installs without
 *  depending on PATH at all — the cause of `spawn bun ENOENT` on packaged apps. */
function systemBins(tool: string): string[] {
  const dirs = process.platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  return dirs.map((d) => join(d, `${tool}${EXE}`));
}
export function findBun(): string {
  return bundled("bun") ?? firstExisting([join(homedir(), ".bun", "bin", `bun${EXE}`), ...systemBins("bun")]) ?? "bun";
}
export function findUv(): string | null {
  return (
    bundled("uv") ??
    firstExisting([
      join(homedir(), ".local", "bin", `uv${EXE}`),
      join(homedir(), ".cargo", "bin", `uv${EXE}`),
      ...systemBins("uv"),
    ])
  );
}
export function findOmp(): string | null {
  // bundledOmp() first: a packaged install ships omp under resources/repo/node_modules, so it
  // resolves with no network (managedOmp is the legacy `bun add -g` location, kept as a fallback).
  return firstExisting([bundledOmp(), managedOmp(), join(homedir(), ".bun", "bin", `omp${EXE}`), ...systemBins("omp")]);
}
function findScannerPython(): string | null {
  return bundledPython() ?? firstExisting([venvPython(), projectVenvPython()]);
}

/** True when first-run setup has real work to do (so the caller can show a
 *  splash only when needed - a fully-provisioned box skips it entirely). */
export function needsBootstrap(): boolean {
  return !findOmp() || !findScannerPython();
}

function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    // windowsHide + piped (not inherited) stdio so provisioning never flashes a console window
    // in the packaged GUI app; output is forwarded for terminal/dev runs.
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...extraEnv } });
    p.stdout?.on("data", (d) => process.stdout.write(d));
    p.stderr?.on("data", (d) => process.stderr.write(d));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

/** Provision missing runtimes, then return the env additions the dev server (and
 *  its omp/scanner children) need: LUCID_OMP_BIN, SCANNER_PYTHON, an augmented
 *  PATH, and LUCID_BUN_BIN. Safe to call every launch - it only acts on what's
 *  missing. `onStatus` receives human-readable progress for the splash. */
export async function ensureRuntimes(onStatus: (s: string) => void = () => {}): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const bun = findBun();
  env.LUCID_BUN_BIN = bun;

  // 1) omp agent - install with bun into a managed global dir if absent.
  let omp = findOmp();
  if (!omp) {
    try {
      mkdirSync(ompGlobalDir(), { recursive: true });
      onStatus("Installing the omp agent…");
      await run(bun, ["add", "-g", "@oh-my-pi/pi-coding-agent"], { BUN_INSTALL: ompGlobalDir() });
      omp = existsSync(managedOmp()) ? managedOmp() : null;
    } catch (e) {
      console.warn("[runtime] omp install failed:", (e as Error).message);
    }
  }
  if (omp) env.LUCID_OMP_BIN = omp;

  // 2) scanner Python - the sidecar has zero pip deps, so any 3.11+ interpreter works.
  //    A packaged (esp. air-gap) build bundles a relocatable CPython (bundledPython, ADR-0225),
  //    so findScannerPython resolves OFFLINE and the uv path below never runs. Only a dev/non-air-gap
  //    box with no bundled Python falls through to uv, which downloads a managed Python if needed.
  let py = findScannerPython();
  if (!py) {
    const uv = findUv();
    if (uv) {
      try {
        onStatus("Provisioning the scanner runtime…");
        await run(uv, ["venv", venvDir(), "--python", "3.12"]);
        py = existsSync(venvPython()) ? venvPython() : null;
      } catch (e) {
        console.warn("[runtime] scanner venv failed:", (e as Error).message);
      }
    } else {
      console.warn("[runtime] no uv available to provision the scanner interpreter");
    }
  }
  if (py) env.SCANNER_PYTHON = py;

  // 3) PATH so omp's own child calls (and a bun shim) resolve.
  const extra = [dirname(bun), join(ompGlobalDir(), "bin")].filter((d) => existsSync(d));
  env.PATH = [...extra, process.env.PATH ?? ""].join(PATH_SEP);

  return env;
}
