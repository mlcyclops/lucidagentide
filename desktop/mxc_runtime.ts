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
//      P-SANDBOX.WIN1 (ADR-0658): the same prompt registers a boot task so the per-boot NUL step survives
//      reboots, and every "not offered" carries its concrete reason (mxcHost / mxcOffer).
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
import type { SandboxFallback } from "../harness/runs/sandbox_exec.ts";

export interface MxcDir { dir: string; source: "env" | "bundled" | "staged" }

/** PURE given its inputs: the first candidate dir holding every pinned file for this platform. */
export function resolveMxcDir(io: { env: Record<string, string | undefined>; resourcesPath?: string; home: string; platform: NodeJS.Platform; arch: string; exists: (p: string) => boolean }): MxcDir | null {
  const key = mxcPlatformKey(io.platform, io.arch);
  if (!key) return null;
  const specs = mxcAssetsFor(key);
  for (const c of mxcDirCandidates(io)) if (specs.every((s) => io.exists(join(c.dir, s.name)))) return c;
  return null;
}

/** PURE: the dirs `resolveMxcDir` searches, in order (P-SANDBOX.WIN1 names them when none holds the files). */
export function mxcDirCandidates(io: { env: Record<string, string | undefined>; resourcesPath?: string; home: string; platform: NodeJS.Platform; arch: string }): MxcDir[] {
  const key = mxcPlatformKey(io.platform, io.arch);
  if (!key) return [];
  const candidates: MxcDir[] = [];
  if (io.env.LUCID_MXC_DIR) candidates.push({ dir: io.env.LUCID_MXC_DIR, source: "env" });
  if (io.resourcesPath) candidates.push({ dir: join(io.resourcesPath, "mxc", key), source: "bundled" });
  candidates.push({ dir: join(io.home, ".omp", "mxc", key), source: "staged" });
  return candidates;
}

function sha256File(path: string): { bytes: number; sha256: string } {
  const buf = readFileSync(path);
  return { bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
}

/** `prepSha256` is the pin of `wxc-host-prep.exe`: the elevated script re-checks its stable copy against it
 *  (P-SANDBOX.WIN1), so nothing swapped in between this verification and the prompt runs as SYSTEM. */
export interface MxcExecutors { exe: string; prep: string; prepSha256: string; platform: MxcPlatformKey; source: MxcDir["source"] }

export type MxcVerification = { ok: true; executors: MxcExecutors } | { ok: false; reason: string };

/** The verified executors, or a reason. Every pinned file in the dir must match by size and sha256. */
export function verifiedMxcExecutors(dir: MxcDir, platform: NodeJS.Platform = process.platform, arch: string = process.arch): MxcVerification {
  const key = mxcPlatformKey(platform, arch);
  if (!key) return { ok: false, reason: `MXC executors are not pinned for ${platform}-${arch}` };
  for (const spec of mxcAssetsFor(key)) {
    const path = join(dir.dir, spec.name);
    let measured: { bytes: number; sha256: string };
    try { measured = sha256File(path); } catch (e) { return { ok: false, reason: `${spec.name}: ${e instanceof Error ? e.message : String(e)}` }; }
    const v = verifyMxcAsset(spec, measured.bytes, measured.sha256);
    if (!v.ok) return { ok: false, reason: v.reason };
  }
  const prepSha256 = mxcAssetsFor(key).find((s) => s.name === "wxc-host-prep.exe")!.sha256;
  return { ok: true, executors: { exe: join(dir.dir, "wxc-exec.exe"), prep: join(dir.dir, "wxc-host-prep.exe"), prepSha256, platform: key, source: dir.source } };
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
export function resetMxcProbeCache(): void { for (const k of Object.keys(probeCache)) delete probeCache[k]; delete bootTaskCache.installed; }

const roundTripCache: Record<string, { ok: boolean; detail?: string }> = {};
/** PURE: what a failed round trip measured, in one line (P-SANDBOX.WIN1). */
export function mxcRoundTripDetail(r: { exitCode: number | null; stdout: string; stderr: string }): string {
  const err = r.stderr.trim().replace(/\s+/g, " ").slice(0, 200);
  const head = r.exitCode === null ? "no exit code (timed out after 30 s)" : r.exitCode === 0 ? "exit 0 but the marker never came back through stdout" : `exit ${r.exitCode}`;
  return err ? `${head}: ${err}` : head;
}
/** The stdio round trip (ADR-0386's rule through MXC), cached per engine run. */
export function mxcRoundTripProbe(exe: string): boolean {
  const hit = roundTripCache[exe];
  if (hit) return hit.ok;
  let out: { ok: boolean; detail?: string };
  try {
    const ws = join(tmpdir(), "lucid-mxc-probe");
    mkdirSync(ws, { recursive: true });
    const r = Bun.spawnSync({ cmd: mxcProbeArgv(exe, ws), stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 30_000 });
    const m = { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    out = mxcProbePassed(m) ? { ok: true } : { ok: false, detail: mxcRoundTripDetail(m) };
  } catch (e) { out = { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
  roundTripCache[exe] = out;
  return out.ok;
}
/** Why the cached round trip for `exe` failed, if it ran and failed. */
export function mxcRoundTripFailure(exe: string): string | undefined {
  return roundTripCache[exe]?.detail;
}

/** The IO `mxcHost` reads through; injectable so the reason derivation is tested without an executor. */
export interface MxcHostIo {
  candidates: MxcDir[];
  resolveDir: () => MxcDir | null;
  verify: (dir: MxcDir) => MxcVerification;
  readProbe: (exe: string) => MxcProbe | null;
}

function defaultMxcHostIo(resourcesPath?: string): MxcHostIo {
  const io = { env: process.env, resourcesPath, home: homedir(), platform: process.platform, arch: process.arch, exists: existsSync };
  return { candidates: mxcDirCandidates(io), resolveDir: () => resolveMxcDir(io), verify: (d) => verifiedMxcExecutors(d), readProbe: readMxcProbe };
}

export type MxcHostResult = { host: MxcHost; executors: MxcExecutors; probe: MxcProbe } | { host: null; reason: string; fallback: SandboxFallback };

/** The verified executors on this host plus their probe, or the concrete reason there are none
 *  (P-SANDBOX.WIN1: not staged at <dirs>, refused by the pin, or no --probe answer). The returned
 *  `MxcHost` is what `resolveBackend({ mxc })` consumes. PURE given `io`. Never runs the round trip. */
export function mxcHost(opts: { resourcesPath?: string } = {}, io: MxcHostIo = defaultMxcHostIo(opts.resourcesPath)): MxcHostResult {
  const no = (kind: SandboxFallback["kind"], reason: string): MxcHostResult => ({ host: null, reason, fallback: { kind, detail: reason } });
  const dir = io.resolveDir();
  if (!dir) return no("mxc-not-staged", `MXC not staged at ${io.candidates.map((c) => c.dir).join(", ") || "any pinned location (no MXC build for this platform)"} (bundle <resources>/mxc, or \`bun run mxc\` for a dev stage)`);
  const v = io.verify(dir);
  if (!v.ok) return no("mxc-refused", `MXC executor refused: ${v.reason}`);
  const probe = io.readProbe(v.executors.exe);
  if (!probe) return no("mxc-no-probe", `MXC --probe did not answer (${v.executors.exe})`);
  return { host: { exe: v.executors.exe, tier: probe.tier, probe: mxcRoundTripProbe, probeDetail: mxcRoundTripFailure }, executors: v.executors, probe };
}

/** PURE (P-SANDBOX.WIN1 gate): may this staged executor be OFFERED to `resolveBackend`? Host prep pending
 *  answers at once, WITHOUT the round trip (an unprepared DACL host kills cmd.exe inside the container,
 *  so the probe could only fail, slowly); a network-on session on the DACL tier needs the loopback
 *  exemption. Not offered is never isolation: the caller falls back to the helper or the disclosed
 *  passthrough, and managed require-isolation still refuses. `loopbackExempted` is read only when needed. */
export function mxcOffer(m: MxcHostResult, o: { needsNetwork: boolean; loopbackExempted: () => boolean }): { mxc: MxcHost } | { fallback: SandboxFallback } {
  if (!m.host) return { fallback: m.fallback };
  if (m.probe.prepNeeded.length) return { fallback: { kind: "mxc-prep-pending", detail: `MXC staged but host prep pending: ${m.probe.prepNeeded.join(", ")}` } };
  if (o.needsNetwork && m.host.tier !== "base-container" && !o.loopbackExempted()) {
    return { fallback: { kind: "mxc-loopback", detail: `MXC staged (${m.host.tier}) but the loopback exemption for ${MXC_CONTAINER_ID} is not registered, so a network-on session cannot reach the egress proxy` } };
  }
  return { mxc: m.host };
}

// ── host prep (elevated, one prompt) ──────────────────────────────────────────────────────────────

/** PowerShell single-quoted literal. PowerShell also closes a single-quoted string on the typographic
 *  quotes U+2018..U+201B, so every one of them is doubled too (a path is never code). */
function psQuote(a: string): string { return `'${a.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`; }

/** P-SANDBOX.WIN1: the scheduled task that re-runs `prepare-null-device` at every boot (Windows resets the
 *  NUL device's DACL on each start). It runs as SYSTEM, so it must NEVER point into a user-writable dir
 *  (~/.omp, LUCID_MXC_DIR, a per-user install): the elevated prompt copies the verified `wxc-host-prep.exe`
 *  to an admin-only dir under Program Files that no app update moves, re-checks the copy's sha256 against
 *  the pin, and only then registers the task at that fixed path. */
export const MXC_BOOT_TASK = "LUCID MXC null device";
export const MXC_BOOT_DIR_NAME = "LucidAgentIDE-HostPrep";
/** PURE: the stable copy the boot task runs, under `programFiles` (`%ProgramFiles%`). */
export function mxcBootPrepPath(programFiles: string): string { return join(programFiles, MXC_BOOT_DIR_NAME, "wxc-host-prep.exe"); }

export interface MxcPrepSteps { systemDrive: boolean; nullDevice: boolean; loopback: boolean; bootTask: boolean }

/** PURE: the PowerShell the elevated prompt runs: both prep steps, the loopback exemption on our moniker
 *  (the same one `lucid-appcontainer --register-loopback` registers, so either path satisfies
 *  `loopbackExempted()`) and, P-SANDBOX.WIN1, the boot task that keeps the NUL device prepared across
 *  reboots (registered with -Force, so re-running replaces it). Each step's exit code is kept; the script
 *  exits non-zero if any failed. Only single quotes: the script travels as one Start-Process argument. */
export function mxcHostPrepScript(prep: string, steps: MxcPrepSteps, prepSha256: string): string {
  const lines: string[] = ["$ec = 0"];
  if (steps.systemDrive) lines.push(`& ${psQuote(prep)} prepare-system-drive; if ($LASTEXITCODE -ne 0) { $ec = $LASTEXITCODE }`);
  if (steps.nullDevice) lines.push(`& ${psQuote(prep)} prepare-null-device --quiet; if ($LASTEXITCODE -ne 0) { $ec = $LASTEXITCODE }`);
  if (steps.loopback) lines.push(`& CheckNetIsolation.exe LoopbackExempt -a -n=${MXC_CONTAINER_ID}; if ($LASTEXITCODE -ne 0) { $ec = $LASTEXITCODE }`);
  if (steps.bootTask) {
    if (!/^[0-9a-f]{64}$/i.test(prepSha256)) throw new Error("mxcHostPrepScript: prepSha256 must be a 64-hex sha256");
    lines.push(
      `$bd = Join-Path $env:ProgramFiles ${psQuote(MXC_BOOT_DIR_NAME)}`,
      `$bp = Join-Path $bd 'wxc-host-prep.exe'`,
      `try { New-Item -ItemType Directory -Force -Path $bd -ErrorAction Stop | Out-Null; Copy-Item -LiteralPath ${psQuote(prep)} -Destination $bp -Force -ErrorAction Stop; if ((Get-FileHash -LiteralPath $bp -Algorithm SHA256).Hash -ne ${psQuote(prepSha256)}) { Remove-Item -LiteralPath $bp -Force; throw 'pin mismatch' }; $ta = New-ScheduledTaskAction -Execute $bp -Argument 'prepare-null-device --quiet'; $tt = New-ScheduledTaskTrigger -AtStartup; $tp = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest; Register-ScheduledTask -TaskName ${psQuote(MXC_BOOT_TASK)} -Action $ta -Trigger $tt -Principal $tp -Force -ErrorAction Stop | Out-Null } catch { $ec = 5 }`,
    );
  }
  lines.push("exit $ec");
  return lines.join("; ");
}

const bootTaskCache: { installed?: boolean } = {};
/** P-SANDBOX.WIN1: is the boot task registered AND its stable copy still the pinned bytes? Cached per
 *  engine run; `resetMxcProbeCache` clears it after a prep. A query the user may not run reads as absent. */
export function mxcBootTaskInstalled(prepSha256: string): boolean {
  if (bootTaskCache.installed !== undefined) return bootTaskCache.installed;
  let ok = false;
  try {
    const copy = mxcBootPrepPath(process.env.ProgramFiles || "C:\\Program Files");
    const q = Bun.spawnSync({ cmd: ["schtasks.exe", "/Query", "/TN", MXC_BOOT_TASK], stdout: "ignore", stderr: "ignore", stdin: "ignore", timeout: 10_000 });
    ok = q.exitCode === 0 && existsSync(copy) && sha256File(copy).sha256 === prepSha256;
  } catch { ok = false; }
  bootTaskCache.installed = ok;
  return ok;
}

/** Run the prep behind ONE UAC prompt. Returns whether the prompt was accepted and the script exited 0;
 *  callers re-read `readMxcProbe` (after `resetMxcProbeCache`) and `loopbackExempted()` for the truth. */
export function runMxcHostPrepElevated(prep: string, steps: MxcPrepSteps, prepSha256: string): boolean {
  const inner = mxcHostPrepScript(prep, steps, prepSha256);
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

