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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter as PATH_SEP, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { nodeProbeVerdict, OMP_PROBE_TIMEOUT_MS, resolveOmpBin, type OmpResolution } from "./omp_bin.ts"; // P-OMP-BOOT.1/.2: ONE probed omp resolver

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
  // POSIX: prefer bin/python3, but fall back to the versioned bin/python3.12 — the real binary the others
  // symlink to (belt-and-suspenders in case packaging ever drops the alias; see fetch-runtimes dereference).
  const cands = process.platform === "win32"
    ? [join(dir, "python.exe")]
    : [join(dir, "bin", "python3"), join(dir, "bin", "python3.12"), join(dir, "bin", "python")];
  return firstExisting(cands);
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
/** The bundled or user bun, or null when there is none. NULL, not the bare name: a bare `"bun"` was
 *  returned here before P-OMP-BOOT.1 (ADR-0357), and `dirname("bun")` is `"."`, which `existsSync`
 *  happily confirms - so the PATH augmentation below prepended the CURRENT DIRECTORY and provided no bun
 *  at all. That is both a silent provisioning failure and a PATH-hijack surface. */
export function resolveBun(): string | null {
  return bundled("bun") ?? firstExisting([join(homedir(), ".bun", "bin", `bun${EXE}`), ...systemBins("bun")]);
}
export function findBun(): string {
  return resolveBun() ?? "bun"; // callers that only need something to spawn keep the bare-name behavior
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

/** Can this omp candidate actually RUN? `--version` touches no auth, network or session state.
 *  `bunDir` is prepended to PATH for the probe because the packaged omp is a BUN SHIM
 *  (`node_modules/.bin/omp.bunx` names `bun` plus a relative cli.js), so probing it without bun
 *  reachable would reject the very binary the children will successfully use.
 *
 *  P-OMP-BOOT.2 (ADR-0358): returns `"timeout"` distinctly, and the budget is OMP_PROBE_TIMEOUT_MS. A
 *  cold-start probe that runs out of time says nothing about whether the binary works. */
function ompRuns(candidate: string, bunDir: string | null): boolean | "timeout" {
  try {
    const env = bunDir ? { ...process.env, PATH: [bunDir, process.env.PATH ?? ""].join(PATH_SEP) } : process.env;
    return nodeProbeVerdict(spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: OMP_PROBE_TIMEOUT_MS, windowsHide: true, env }));
  } catch { return false; } // EPERM / ENOENT / EACCES all mean "cannot run this one"
}

/** The omp to hand the children, or null when there is genuinely nothing to hand them.
 *
 *  P-OMP-BOOT.1 (ADR-0357): this used to be `firstExisting([...])`, which accepted the packaged shim on
 *  existence alone and so could hand out a path nobody had ever run.
 *
 *  P-OMP-BOOT.2 (ADR-0358) corrects the attribution recorded in ADR-0357: existence-based resolution was
 *  a real defect but it was NOT the cause of the reported outage. That was the 6 s probe budget. The
 *  reporting user's engine log shows 10 of 21 v2.2.0 boots declaring omp unrunnable from an install
 *  where it demonstrably ran on the other 11, which no missing file can explain. So an INDETERMINATE
 *  resolution counts as usable here: returning null would send `ensureRuntimes` off to reinstall omp
 *  over a perfectly good one every time the machine happened to be busy. */
export function findOmp(): string | null {
  const r = ompResolution();
  return r.proven || r.indeterminate ? r.bin : null;
}

/** The full resolution, for the boot diagnostic: `findOmp()` alone cannot say what it TRIED.
 *
 *  Memoized for the process lifetime. `needsBootstrap()` and `ensureRuntimes()` both ask, and with a
 *  30 s budget per candidate an unmemoized answer would pay the cold-start cost twice before the window
 *  even opens. Electron main is long-lived and the answer cannot meaningfully change during startup;
 *  `forget` exists so provisioning can re-ask exactly once after installing something. */
let ompResolutionCache: OmpResolution | null = null;
export function ompResolution(forget = false): OmpResolution {
  if (forget) ompResolutionCache = null;
  if (ompResolutionCache) return ompResolutionCache;
  const bunPath = resolveBun();
  ompResolutionCache = resolveOmpBin(
    {
      // bundled first: a packaged install ships omp under resources/repo/node_modules, so it resolves
      // with no network (managedOmp is the `bun add -g` location ensureRuntimes provisions into).
      installed: [bundledOmp(), managedOmp(), ...systemBins("omp")],
      home: homedir(),
      exeSuffix: EXE,
      join,
    },
    (c) => ompRuns(c, bunPath ? dirname(bunPath) : null),
  );
  return ompResolutionCache;
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
      // P-OMP-BOOT.1 (ADR-0357): PROVE the freshly installed one too. `existsSync(managedOmp())` was
      // the same mistake one line further down the chain: `bun add -g` can lay down a shim and still
      // leave nothing runnable, and reporting that as success is what put an unrunnable path in
      // LUCID_OMP_BIN in the first place.
      ompResolution(true); // drop the pre-install memo, otherwise findOmp reports the stale answer
      omp = findOmp();
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

  // 3) PATH so omp's own child calls (and the bundled bun SHIM) resolve.
  //    P-OMP-BOOT.1 (ADR-0357): only ABSOLUTE resolved dirs. This read `dirname(bun)` where `bun` could
  //    be the bare name `"bun"`, making `dirname` return `"."`, which `existsSync` confirms - so on every
  //    machine without bun this prepended the CURRENT WORKING DIRECTORY to the PATH of the agent and all
  //    its children. It provided no bun (the shim still failed) and it meant a `bun.exe` dropped in the
  //    open workspace would be preferred over a real one.
  const bunPath = resolveBun();
  const extra = [bunPath ? dirname(bunPath) : null, join(ompGlobalDir(), "bin")]
    .filter((d): d is string => !!d && isAbsolute(d) && existsSync(d));
  env.PATH = [...extra, process.env.PATH ?? ""].join(PATH_SEP);

  return env;
}
