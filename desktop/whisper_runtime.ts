// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/whisper_runtime.ts - P-STT.2b: the no-code lifecycle for on-device Whisper (install -> start ->
// wire STT -> stop). It stitches the tested pieces together: whisper_capability (the gate), whisper_install
// (catalog + serve URL/args), whisper_manager (bin resolve + model download). ALL side effects are INJECTED
// (spawn / download / fs / set-stt-url / health) so the orchestration is unit-tested; dev.ts supplies the
// real ones and holds the single running-process handle. Invariant #2: whisper.cpp is a native binary.

import { whisperCapability, type MachineSpecs, type WhisperTier } from "./whisper_capability.ts";
import { DEFAULT_WHISPER_TIER, planWhisperInstall, WHISPER_MODELS, whisperModelFileNames, whisperServeUrl, whisperServerArgs, type WhisperModel } from "./whisper_install.ts";
import type { DownloadResult, ResolvedBin } from "./whisper_manager.ts";

export interface WhisperProc { pid: number; kill: () => void }

export interface WhisperRuntimeDeps {
  specs: () => MachineSpecs;
  modelDir: string;
  /** Filenames present in `modelDir` (which tier models are already downloaded). */
  listModels: () => string[];
  resolveBin: () => ResolvedBin | null;
  download: (model: WhisperModel, destPath: string, onProgress: (fraction: number) => void) => Promise<DownloadResult>;
  spawn: (bin: string, args: string[]) => WhisperProc;
  health: (port: number) => Promise<boolean>;
  /** Point the STT engine at the managed server (set sttUrl + sttProvider=whisper). */
  setSttUrl: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** P-STT.5: best-effort kill of whatever LISTENs on a port (an orphan from a previous run). Optional:
   *  when absent or unsuccessful, startWhisper adopts the survivor instead of double-spawning. */
  reapPort?: (port: number) => Promise<void>;
}

export interface WhisperTierView { tier: WhisperTier; label: string; runnable: boolean; installed: boolean }
// P-STT.2d: live install/start progress for the no-code Voice card (the renderer polls status while a
// download runs and renders a real progress bar instead of a blind spinner).
export type WhisperInstallPhase = "idle" | "downloading" | "starting" | "done" | "error";
export interface WhisperInstallState { active: boolean; tier: WhisperTier | null; fraction: number; phase: WhisperInstallPhase; reason?: string }
export interface WhisperStatusView {
  capable: boolean;
  recommended: WhisperTier | null;
  /** The tier used when nothing is picked (tiny) - the Voice-card picker preselects it. */
  defaultTier: WhisperTier;
  summary: string;
  binAvailable: boolean;
  binHint: string;
  running: boolean;
  port: number;
  activeTier: WhisperTier | null;
  serveUrl: string | null;
  tiers: WhisperTierView[];
  install: WhisperInstallState;
}

const DEFAULT_PORT = 9111;
// The single running server (module-scoped: one managed Whisper at a time).
let proc: WhisperProc | null = null;
let running: { port: number; tier: WhisperTier | null } = { port: DEFAULT_PORT, tier: null };
// P-STT.5: true when we ADOPTED a server we did not spawn (an unkillable squatter on the port). Its pid is
// unknown, so stop falls back to reapPort; its model tier is unknowable, so status never claims one.
let adopted = false;

const BIN_HINT = "No whisper.cpp binary found. Set LUCID_WHISPER_BIN to a whisper-server, or the packaged app bundles one.";

// The current download/start progress (module-scoped, like the running proc). whisperStatus() reports it so
// the renderer can poll it during an in-flight install and paint a progress bar.
let installState: WhisperInstallState = { active: false, tier: null, fraction: 0, phase: "idle" };
export function whisperInstallState(): WhisperInstallState { return installState; }
function setInstall(patch: Partial<WhisperInstallState>): void { installState = { ...installState, ...patch }; }

/** A read-only snapshot for the UI: capability, which models are downloaded, and whether the server runs. */
export function whisperStatus(deps: WhisperRuntimeDeps): WhisperStatusView {
  const caps = whisperCapability(deps.specs());
  const present = new Set(deps.listModels());
  const bin = deps.resolveBin();
  const tiers: WhisperTierView[] = caps.tiers.map((t) => ({
    tier: t.tier,
    label: WHISPER_MODELS[t.tier].label,
    runnable: t.runnable,
    installed: present.has(WHISPER_MODELS[t.tier].fileName),
  }));
  return {
    capable: caps.capable,
    recommended: caps.recommended,
    defaultTier: DEFAULT_WHISPER_TIER,
    summary: caps.summary,
    binAvailable: !!bin,
    binHint: bin ? `whisper-server (${bin.source})` : BIN_HINT,
    running: !!proc || adopted,
    port: running.port,
    activeTier: running.tier,
    serveUrl: proc || adopted ? whisperServeUrl(running.port) : null,
    tiers,
    install: installState,
  };
}

export interface WhisperActionResult { ok: boolean; reason?: string; tier?: WhisperTier }

/** Download a model tier (DEFAULT_WHISPER_TIER if unspecified). Fail-closed on an incapable machine. */
export async function installWhisper(deps: WhisperRuntimeDeps, tier: WhisperTier | undefined, onProgress: (fraction: number) => void): Promise<WhisperActionResult> {
  const present = new Set(deps.listModels());
  const plan = planWhisperInstall(whisperCapability(deps.specs()), { tier, presentModels: present });
  if (!plan.ok) return { ok: false, reason: plan.reason };
  if (plan.alreadyInstalled) return { ok: true, tier: plan.tier };
  const dest = `${deps.modelDir.replace(/\/$/, "")}/${plan.model.fileName}`;
  setInstall({ active: true, tier: plan.tier, fraction: 0, phase: "downloading", reason: undefined });
  const r = await deps.download(plan.model, dest, (f) => { setInstall({ fraction: f }); onProgress(f); });
  if (r.ok) { setInstall({ active: false, fraction: 1, phase: "done", reason: undefined }); return { ok: true, tier: plan.tier }; }
  setInstall({ active: false, phase: "error", reason: r.reason });
  return { ok: false, reason: r.reason };
}

/** Start the managed server: resolve the binary, ensure the model is present (download if needed), spawn,
 *  health-check, and point STT at it. Idempotent-ish: a running server is stopped first. Fail-closed. */
export async function startWhisper(deps: WhisperRuntimeDeps, opts: { tier?: WhisperTier; port?: number; onProgress?: (fraction: number) => void } = {}): Promise<WhisperActionResult> {
  const bin = deps.resolveBin();
  if (!bin) return { ok: false, reason: BIN_HINT };
  const caps = whisperCapability(deps.specs());
  const plan = planWhisperInstall(caps, { tier: opts.tier, presentModels: new Set(deps.listModels()) });
  if (!plan.ok) return { ok: false, reason: plan.reason };
  const modelPath = `${deps.modelDir.replace(/\/$/, "")}/${plan.model.fileName}`;
  setInstall({ active: true, tier: plan.tier, fraction: plan.alreadyInstalled ? 1 : 0, phase: plan.alreadyInstalled ? "starting" : "downloading", reason: undefined });
  if (!plan.alreadyInstalled) {
    const dl = await deps.download(plan.model, modelPath, (f) => { setInstall({ fraction: f }); opts.onProgress?.(f); });
    if (!dl.ok) { setInstall({ active: false, phase: "error", reason: dl.reason }); return { ok: false, reason: dl.reason }; }
    setInstall({ fraction: 1, phase: "starting" });
  }
  if (proc) await stopWhisper();
  const port = opts.port ?? DEFAULT_PORT;
  // P-STT.5: a server may ALREADY hold the port - an orphan from a previous app run (nothing killed the
  // child on quit) or a user's own instance. whisper.cpp binds with SO_REUSEPORT, so a duplicate spawn
  // "works" and the kernel silently splits requests across TWO model loads (seen live: two whisper-server
  // pids both LISTENing on 9111). Reclaim the port first so the requested tier actually serves; if the
  // squatter survives (no reaper / no permission), adopt it rather than double-spawn.
  if (await deps.health(port)) {
    await deps.reapPort?.(port);
    await deps.sleep(300);
    if (await deps.health(port)) {
      adopted = true;
      running = { port, tier: null }; // the squatter's loaded model is unknowable - never claim a tier
      deps.setSttUrl(whisperServeUrl(port));
      setInstall({ active: false, fraction: 1, phase: "done", reason: undefined });
      return { ok: true, reason: `adopted an already-running whisper server on port ${port}` };
    }
  }
  adopted = false;
  proc = deps.spawn(bin.path, whisperServerArgs(modelPath, port));
  running = { port, tier: plan.tier };
  // Wait for the server to answer, then wire STT to it. whisper.cpp loads the model + inits Metal/CUDA on
  // first start, which can take several seconds (esp. larger tiers) - so poll patiently (~30s) before failing.
  await deps.sleep(300); // let the process bind before the first probe
  for (let i = 0; i < 60; i++) {
    if (await deps.health(port)) { deps.setSttUrl(whisperServeUrl(port)); setInstall({ active: false, fraction: 1, phase: "done", reason: undefined }); return { ok: true, tier: plan.tier }; }
    await deps.sleep(500);
  }
  await stopWhisper();
  setInstall({ active: false, phase: "error", reason: "the whisper server did not become healthy in time" });
  return { ok: false, reason: "the whisper server did not become healthy in time" };
}

/** P-STT.6: should the INSTALLED app autostart the managed server on launch? Pure, so the gate is
 *  unit-tested; dev.ts feeds it the live status + voice settings. Autostart only when:
 *  - the app is packaged (the bundled binary is guaranteed; dev runs stay opt-in),
 *  - Whisper is the chosen STT engine (never race an ElevenLabs user),
 *  - the sttUrl is empty or loopback - a REMOTE url means the user runs their own server elsewhere,
 *    and startWhisper would clobber that wiring via setSttUrl,
 *  - the machine is capable, a binary resolved, and nothing is running or mid-install. */
export function shouldAutostartWhisper(status: WhisperStatusView, voice: { sttProvider: string; sttUrl: string }, packaged: boolean): boolean {
  if (!packaged || voice.sttProvider !== "whisper") return false;
  if (!status.capable || !status.binAvailable || status.running || status.install.active) return false;
  if (voice.sttUrl) {
    try {
      const host = new URL(voice.sttUrl).hostname;
      if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") return false;
    } catch { /* unparseable url: treat as unset and manage locally */ }
  }
  return true;
}

/** Stop the managed server (no-op if not running). An ADOPTED server has no pid handle, so stopping it
 *  needs the injected port reaper (pass deps from the API route); without one it is left running. */
export async function stopWhisper(deps?: WhisperRuntimeDeps): Promise<WhisperActionResult> {
  if (proc) { try { proc.kill(); } catch { /* already gone */ } proc = null; }
  if (adopted) { try { await deps?.reapPort?.(running.port); } catch { /* best-effort */ } adopted = false; }
  running = { port: running.port, tier: null };
  return { ok: true };
}

/** Full model-file set (used by dev.ts to list which tiers are on disk). */
export function whisperModelFiles(): string[] {
  return whisperModelFileNames();
}
