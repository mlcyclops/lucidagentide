// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/whisper_install.ts - P-STT.2: the model catalog + install/serve PLAN for on-device Whisper.
//
// Pure + DOM/IO-free so the plan is unit-tested; the main-process manager (whisper_manager.ts) does the
// actual download + spawn using these values. The models are the official ggml whisper.cpp weights on
// Hugging Face (a real, stable host); the transcription server it feeds is the existing
// OpenAiCompatibleSttBackend, which POSTs to `{baseUrl}/v1/audio/transcriptions`.
//
// Sizes are APPROXIMATE (for the download estimate + a fail-closed size floor against a truncated / HTML
// error download); they are not exact-byte checksums. Integrity is a shape check (not an HTML/JSON error
// page, above a size floor), not a hardcoded sha256 (we don't ship a hash we can't keep accurate).

import { WHISPER_TIERS, whisperCapability, type MachineSpecs, type WhisperCapability, type WhisperTier } from "./whisper_capability.ts";
export type { WhisperTier } from "./whisper_capability.ts"; // re-export so dev.ts imports the whole whisper facade from here

export interface WhisperModel {
  tier: WhisperTier;
  label: string; // UI label
  fileName: string; // ggml weights file
  url: string; // download source (official whisper.cpp ggml weights)
  approxMB: number; // for the download estimate + the size-floor integrity check
  multilingual: boolean;
}

const HF = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/** The tier used when the caller picks none: `tiny`. Smallest download (~78MB) + fastest load, so the
 *  no-code paths (Install & start with no pick, the mic quick-start, the packaged-app autostart) are cheap
 *  and near-instant. The hardware recommendation stays informational (the UI summary still names it). */
export const DEFAULT_WHISPER_TIER: WhisperTier = "tiny";

// English-optimized weights for the small tiers (smaller + faster; the default STT is English); the top tier
// is large-v3-turbo (multilingual, fast). Edit `LUCID_WHISPER_URL_BASE` to mirror these behind an air-gap.
export const WHISPER_MODELS: Record<WhisperTier, WhisperModel> = {
  tiny: { tier: "tiny", label: "Tiny - the default (fastest)", fileName: "ggml-tiny.en.bin", url: `${HF}/ggml-tiny.en.bin`, approxMB: 78, multilingual: false },
  base: { tier: "base", label: "Base (fast, good)", fileName: "ggml-base.en.bin", url: `${HF}/ggml-base.en.bin`, approxMB: 148, multilingual: false },
  small: { tier: "small", label: "Small (accurate, still light)", fileName: "ggml-small.en.bin", url: `${HF}/ggml-small.en.bin`, approxMB: 488, multilingual: false },
  medium: { tier: "medium", label: "Medium (very accurate)", fileName: "ggml-medium.en.bin", url: `${HF}/ggml-medium.en.bin`, approxMB: 1533, multilingual: false },
  "large-turbo": { tier: "large-turbo", label: "Large v3 Turbo (best, multilingual)", fileName: "ggml-large-v3-turbo.bin", url: `${HF}/ggml-large-v3-turbo.bin`, approxMB: 1620, multilingual: true },
};

export interface InstallPlan {
  ok: true;
  tier: WhisperTier;
  model: WhisperModel;
  alreadyInstalled: boolean;
}
export interface InstallBlocked {
  ok: false;
  reason: string;
}

/**
 * Decide what to install. Fail-closed: if the machine can't run the requested (or any) tier, returns
 * `{ ok:false }`. If `tier` is omitted, uses DEFAULT_WHISPER_TIER (tiny - capable implies the smallest tier
 * runs, since the RAM floors are monotonic). `presentModels` is the set of model filenames already on disk
 * (so a re-open shows "installed").
 */
export function planWhisperInstall(
  caps: WhisperCapability,
  opts: { tier?: WhisperTier; presentModels?: ReadonlySet<string> } = {},
): InstallPlan | InstallBlocked {
  if (!caps.capable) return { ok: false, reason: "This machine can't run on-device Whisper (needs ~2GB+ free RAM)." };
  const tier = opts.tier ?? DEFAULT_WHISPER_TIER;
  const cap = caps.tiers.find((t) => t.tier === tier);
  if (!cap || !cap.runnable) return { ok: false, reason: `The ${tier} model won't run here: ${cap?.reason ?? "insufficient resources"}.` };
  const model = WHISPER_MODELS[tier];
  return { ok: true, tier, model, alreadyInstalled: !!opts.presentModels?.has(model.fileName) };
}

/** Convenience: capability + plan in one call (the manager reads os specs, passes them here). */
export function planFromSpecs(specs: MachineSpecs, opts: { tier?: WhisperTier; presentModels?: ReadonlySet<string> } = {}): InstallPlan | InstallBlocked {
  return planWhisperInstall(whisperCapability(specs), opts);
}

/** The OpenAI-compatible base URL the managed server listens on (NO trailing `/v1` - the STT backend appends
 *  `/v1/audio/transcriptions`). This is what `sttUrl` is set to once the server is up. */
export function whisperServeUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** The spawn argv for the whisper.cpp server (the binary path is resolved + prepended by the manager).
 *  whisper.cpp's `whisper-server` serves the transcription route bound to loopback on `port`. */
export function whisperServerArgs(modelPath: string, port: number): string[] {
  return ["-m", modelPath, "--host", "127.0.0.1", "--port", String(port)];
}

/** Fail-closed integrity check for a just-downloaded weights file: reject an HTML/JSON error page saved as
 *  `.bin`, or a truncated download well under the model's expected size. Not a checksum - a shape+size gate. */
export function looksLikeWhisperModel(head: Uint8Array, sizeBytes: number, expectedMB: number): { ok: boolean; reason?: string } {
  const floor = Math.max(1_000_000, Math.floor(expectedMB * 1024 * 1024 * 0.5)); // at least half the expected size
  if (sizeBytes < floor) return { ok: false, reason: "download is far smaller than expected (incomplete or an error page)" };
  const first = head[0];
  if (first === 0x3c /* < */ || first === 0x7b /* { */) return { ok: false, reason: "the download looks like an HTML/JSON error page, not model weights" };
  return { ok: true };
}

/** Every model filename in the catalog (used to detect which are already downloaded). */
export function whisperModelFileNames(): string[] {
  return WHISPER_TIERS.map((t) => WHISPER_MODELS[t].fileName);
}
