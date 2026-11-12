// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/mxc_runtime.ts - P-MXC.1 (ADR-0441): the engine's edge to the Microsoft eXecution Container
// executors. Three jobs, kept apart:
//   1. RESOLVE + VERIFY: where the staged `wxc-exec.exe` / `wxc-host-prep.exe` are (the bundle's
//      <resources>/mxc/<os>-<arch>, else the dev stage ~/.omp/mxc/<os>-<arch>, else LUCID_MXC_DIR) and
//      whether their bytes match the pin (harness/runs/mxc_assets.ts). A file that does not verify is
//      not an executor; it is never run, not even for `--probe`.
//   2. PROBE: `wxc-exec --probe` for the isolation tier and the host-prep warnings, plus the stdio
//      round trip the backend's `available()` consults. Both cached per engine run.
//   3. HOST PREP (the one elevated step, ADR-0441 decision 5): on the DACL tier Windows needs the two
//      `wxc-host-prep` subcommands and, for mediated egress, the loopback exemption on our moniker. All
//      three run in ONE UAC prompt through PowerShell `Start-Process -Verb RunAs`; the engine never
//      elevates itself and re-reads the real state afterwards instead of trusting an exit code.
//   STAGING (download + extract from the pinned npm tarball) lives here too, used by build/fetch-mxc.ts
//   and `bun run mxc`; a dev engine never downloads 105 MB on its own boot.
//
// Pure decisions are in harness/runs/sandbox_mxc.ts; this file is the IO.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MXC_ASSETS, MXC_TARBALL_INTEGRITY, MXC_TARBALL_URL, mxcAssetsFor, mxcPlatformKey, verifyMxcAsset, type MxcPlatformKey } from "../harness/runs/mxc_assets.ts";
import { MXC_CONTAINER_ID, mxcProbeArgv, mxcProbePassed, parseMxcTier, type MxcHost, type MxcTier } from "../harness/runs/sandbox_mxc.ts";

export interface MxcDir { dir: string; source: "env" | "bundled" | "staged" }

/** PURE given its inputs: the first candidate dir holding every pinned file for this platform. */
export function resolveMxcDir(io: { env: Record<string, string | undefined>; resourcesPath?: string; home: string; platform: NodeJS.Platform; arch: string; exists: (p: string) => boolean }): MxcDir | null {
  const key = mxcPlatformKey(io.platform, io.arch);
  if (!key) return null;
  const specs = mxcAssetsFor(key);
  const candidates: MxcDir[] = [];
  if (io.env.LUCID_MXC_DIR) candidates.push({ dir: io.env.LUCID_MXC_DIR, source: "env" });
  if (io.resourcesPath) candidates.push({ dir: join(io.resourcesPath, "mxc", key), source: "bundled" });
  candidates.push({ dir: join(io.home, ".omp", "mxc", key), source: "staged" });
  for (const c of candidates) if (specs.every((s) => io.exists(join(c.dir, s.name)))) return c;
  return null;
}

function sha256File(path: string): { bytes: number; sha256: string } {
  const buf = readFileSync(path);
  return { bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
}

export interface MxcExecutors { exe: string; prep: string; platform: MxcPlatformKey; source: MxcDir["source"] }

/** The verified executors, or a reason. Every pinned file in the dir must match by size and sha256. */
export function verifiedMxcExecutors(dir: MxcDir, platform: NodeJS.Platform = process.platform, arch: string = process.arch): { ok: true; executors: MxcExecutors } | { ok: false; reason: string } {
  const key = mxcPlatformKey(platform, arch);
  if (!key) return { ok: false, reason: `MXC executors are not pinned for ${platform}-${arch}` };
  for (const spec of mxcAssetsFor(key)) {
    const path = join(dir.dir, spec.name);
    let measured: { bytes: number; sha256: string };
    try { measured = sha256File(path); } catch (e) { return { ok: false, reason: `${spec.name}: ${e instanceof Error ? e.message : String(e)}` }; }
    const v = verifyMxcAsset(spec, measured.bytes, measured.sha256);
    if (!v.ok) return { ok: false, reason: v.reason };
  }
  return { ok: true, executors: { exe: join(dir.dir, "wxc-exec.exe"), prep: join(dir.dir, "wxc-host-prep.exe"), platform: key, source: dir.source } };
}

export interface MxcProbe {
  tier: MxcTier;
  /** The host-prep steps `--probe` still recommends (DACL tier only; empty once prepared). */
  prepNeeded: ("prepare-system-drive" | "prepare-null-device")[];
  warnings: string[];
}

/** PURE: the probe JSON into what the engine needs. */
export function parseMxcProbe(stdout: string): MxcProbe | null {
  const tier = parseMxcTier(stdout);
  if (!tier) return null;
  let warnings: string[] = [];
  try { const j = JSON.parse(stdout) as { warnings?: unknown }; warnings = Array.isArray(j.warnings) ? j.warnings.map(String) : []; } catch { /* tier parsed, warnings optional */ }
  const prepNeeded: MxcProbe["prepNeeded"] = [];
  if (warnings.some((w) => w.includes("prepare-system-drive"))) prepNeeded.push("prepare-system-drive");
  if (warnings.some((w) => w.includes("prepare-null-device"))) prepNeeded.push("prepare-null-device");
  return { tier, prepNeeded, warnings };
}

const probeCache: Record<string, MxcProbe | null> = {};
/** `wxc-exec --probe`, cached per engine run per executor path. Null when the executor cannot answer. */
export function readMxcProbe(exe: string): MxcProbe | null {
  if (exe in probeCache) return probeCache[exe] ?? null;
  let out: MxcProbe | null = null;
  try {
    const r = Bun.spawnSync({ cmd: [exe, "--probe"], stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 15_000 });
    out = r.exitCode === 0 ? parseMxcProbe(r.stdout.toString()) : null;
  } catch { out = null; }
  probeCache[exe] = out;
  return out;
}
export function resetMxcProbeCache(): void { for (const k of Object.keys(probeCache)) delete probeCache[k]; }

const roundTripCache: Record<string, boolean> = {};
/** The stdio round trip (ADR-0386's rule through MXC), cached per engine run. */
export function mxcRoundTripProbe(exe: string): boolean {
  if (exe in roundTripCache) return roundTripCache[exe]!;
  let ok = false;
  try {
    const ws = join(tmpdir(), "lucid-mxc-probe");
    mkdirSync(ws, { recursive: true });
    const r = Bun.spawnSync({ cmd: mxcProbeArgv(exe, ws), stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 30_000 });
    ok = mxcProbePassed({ exitCode: r.exitCode, stdout: r.stdout.toString() });
  } catch { ok = false; }
  roundTripCache[exe] = ok;
  return ok;
}

/** The verified executors on this host plus their probe, or null with the reason logged once. The
 *  returned `MxcHost` is what `resolveBackend({ mxc })` consumes. */
export function mxcHost(opts: { resourcesPath?: string } = {}): { host: MxcHost; executors: MxcExecutors; probe: MxcProbe } | { host: null; reason: string } {
  const dir = resolveMxcDir({ env: process.env, resourcesPath: opts.resourcesPath, home: homedir(), platform: process.platform, arch: process.arch, exists: existsSync });
  if (!dir) return { host: null, reason: "MXC executors are not staged on this host (bundle <resources>/mxc, or `bun run mxc` for a dev stage)" };
  const v = verifiedMxcExecutors(dir);
  if (!v.ok) return { host: null, reason: `MXC executor refused: ${v.reason}` };
  const probe = readMxcProbe(v.executors.exe);
  if (!probe) return { host: null, reason: "MXC executor did not answer --probe" };
  return { host: { exe: v.executors.exe, tier: probe.tier, probe: mxcRoundTripProbe }, executors: v.executors, probe };
}

// ── host prep (elevated, one prompt) ──────────────────────────────────────────────────────────────

function psQuote(a: string): string { return `'${a.replace(/'/g, "''")}'`; }

/** PURE: the PowerShell the elevated prompt runs: both prep steps and the loopback exemption on our
 *  moniker (the same one `lucid-appcontainer --register-loopback` registers, so either path satisfies
 *  `loopbackExempted()`). Each step's exit code is kept; the script exits non-zero if any failed. */
export function mxcHostPrepScript(prep: string, steps: { systemDrive: boolean; nullDevice: boolean; loopback: boolean }): string {
  const lines: string[] = ["$ec = 0"];
  if (steps.systemDrive) lines.push(`& ${psQuote(prep)} prepare-system-drive; if ($LASTEXITCODE -ne 0) { $ec = $LASTEXITCODE }`);
  if (steps.nullDevice) lines.push(`& ${psQuote(prep)} prepare-null-device --quiet; if ($LASTEXITCODE -ne 0) { $ec = $LASTEXITCODE }`);
  if (steps.loopback) lines.push(`& CheckNetIsolation.exe LoopbackExempt -a -n=${MXC_CONTAINER_ID}; if ($LASTEXITCODE -ne 0) { $ec = $LASTEXITCODE }`);
  lines.push("exit $ec");
  return lines.join("; ");
}

/** Run the prep behind ONE UAC prompt. Returns whether the prompt was accepted and the script exited 0;
 *  callers re-read `readMxcProbe` (after `resetMxcProbeCache`) and `loopbackExempted()` for the truth. */
export function runMxcHostPrepElevated(prep: string, steps: { systemDrive: boolean; nullDevice: boolean; loopback: boolean }): boolean {
  const inner = mxcHostPrepScript(prep, steps);
  const cmd = `$p = Start-Process -FilePath powershell -ArgumentList '-NoProfile','-Command',${psQuote(inner)} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command", cmd], { stdout: "pipe", stderr: "pipe" });
  return (r.exitCode ?? 1) === 0;
}

// ── staging from the pinned npm tarball ───────────────────────────────────────────────────────────

/** Download the pinned tarball (sha512 integrity checked), extract the pinned files for `key` into
 *  `dir`, verify each by size + sha256 (into `.part`, renamed only after verifying). Already-verified
 *  files are kept. `tar` is the platform's (bsdtar ships with Windows 10+). */
export async function stageMxcExecutors(dir: string, key: MxcPlatformKey, io: { fetchImpl?: typeof fetch; tarball?: string } = {}): Promise<{ ok: true; staged: string[] } | { ok: false; reason: string }> {
  const specs = mxcAssetsFor(key);
  mkdirSync(dir, { recursive: true });
  const missing = specs.filter((s) => {
    const p = join(dir, s.name);
    if (!existsSync(p)) return true;
    const m = sha256File(p);
    return !verifyMxcAsset(s, m.bytes, m.sha256).ok;
  });
  if (!missing.length) return { ok: true, staged: [] };

  let tgz = io.tarball;
  if (!tgz) {
    const fetchImpl = io.fetchImpl ?? globalThis.fetch;
    let bytes: Uint8Array;
    try {
      const res = await fetchImpl(MXC_TARBALL_URL);
      if (!res.ok) return { ok: false, reason: `mxc tarball: HTTP ${res.status}` };
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) { return { ok: false, reason: `mxc tarball: ${e instanceof Error ? e.message : String(e)}` }; }
    const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
    if (integrity !== MXC_TARBALL_INTEGRITY) return { ok: false, reason: `mxc tarball integrity ${integrity} does not match the pinned ${MXC_TARBALL_INTEGRITY}` };
    tgz = join(dir, "mxc-sdk.tgz.part");
    await Bun.write(tgz, bytes);
  }

  const work = join(dir, "extract.part");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const r = Bun.spawnSync({ cmd: ["tar", "-xzf", tgz, "-C", work, ...missing.map((s) => s.tarPath)], stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return { ok: false, reason: `tar failed (${r.exitCode}): ${r.stderr.toString().slice(0, 300)}` };

  const staged: string[] = [];
  for (const spec of missing) {
    const from = join(work, ...spec.tarPath.split("/"));
    let m: { bytes: number; sha256: string };
    try { m = sha256File(from); } catch { return { ok: false, reason: `${spec.name}: not found in the tarball at ${spec.tarPath}` }; }
    const v = verifyMxcAsset(spec, m.bytes, m.sha256);
    if (!v.ok) return { ok: false, reason: v.reason };
    renameSync(from, join(dir, spec.name));
    staged.push(spec.name);
  }
  rmSync(work, { recursive: true, force: true });
  if (!io.tarball) rmSync(tgz, { force: true });
  return { ok: true, staged };
}

/** Every pinned platform, for the build script. */
export function mxcPlatformKeys(): MxcPlatformKey[] {
  return [...new Set(MXC_ASSETS.map((a) => a.platform))];
}

