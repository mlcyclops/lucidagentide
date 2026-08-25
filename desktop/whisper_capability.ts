// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/whisper_capability.ts - P-STT.2: the hardware-capability gate for on-device Whisper (offline STT).
//
// "Install and run it locally when their hardware is capable." A whisper.cpp model needs its weights plus
// working-set memory; a machine that can't hold the tier comfortably would swap and stall. This PURE module
// decides, from machine specs, which model tiers are runnable and which to RECOMMEND (the largest tier with
// real headroom). No I/O: the main process reads os.totalmem()/os.cpus()/os.arch() and passes them in, so the
// gate is unit-tested. Invariant #2: whisper.cpp is a C++ binary; nothing here adds Python.

export type WhisperTier = "tiny" | "base" | "small" | "medium" | "large-turbo";

/** Tiers smallest -> largest. `tiny` is the default when no tier is picked (DEFAULT_WHISPER_TIER). */
export const WHISPER_TIERS: readonly WhisperTier[] = ["tiny", "base", "small", "medium", "large-turbo"];

export interface MachineSpecs {
  arch: string; // "arm64" | "x64" | ...
  platform: string; // "darwin" | "win32" | "linux"
  totalRamGB: number; // os.totalmem() / 1e9
  cpuCores: number; // os.cpus().length
  accel?: "metal" | "cuda" | "cpu"; // optional hint; absent -> treated as cpu
}

export interface TierCapability {
  tier: WhisperTier;
  runnable: boolean; // enough RAM to run this tier at all
  comfortable: boolean; // enough headroom to run it smoothly (drives the recommendation)
  reason: string;
}

export interface WhisperCapability {
  capable: boolean; // can run at least the smallest tier
  recommended: WhisperTier | null; // largest COMFORTABLE tier, or the smallest runnable if none is comfortable
  tiers: TierCapability[];
  summary: string; // one-line human readout for the UI
}

// Total-RAM floors (GB). `run` = the minimum to run at all; `comfort` = enough headroom that it won't thrash.
// Conservative, working-set-aware (weights + KV + OS). whisper.cpp is far lighter than an LLM, so these are
// modest. Editorial but sane; tuned so a 16GB laptop lands on "small" and a big workstation on "large-turbo".
const RAM_FLOOR: Record<WhisperTier, { run: number; comfort: number }> = {
  tiny: { run: 2, comfort: 3 },
  base: { run: 3, comfort: 4 },
  small: { run: 4, comfort: 6 },
  medium: { run: 6, comfort: 12 },
  "large-turbo": { run: 8, comfort: 16 },
};

/** Decide the on-device Whisper capability from machine specs. Pure. */
export function whisperCapability(specs: MachineSpecs): WhisperCapability {
  const ram = Number.isFinite(specs.totalRamGB) ? specs.totalRamGB : 0;
  const tiers: TierCapability[] = WHISPER_TIERS.map((tier) => {
    const floor = RAM_FLOOR[tier];
    const runnable = ram >= floor.run;
    const comfortable = ram >= floor.comfort;
    const reason = runnable
      ? (comfortable ? `runs comfortably (~${floor.comfort}GB+ RAM)` : `runs, but tight (< ~${floor.comfort}GB RAM)`)
      : `needs ~${floor.run}GB+ RAM (have ${ram ? `${Math.round(ram)}GB` : "unknown"})`;
    return { tier, runnable, comfortable, reason };
  });
  const runnableTiers = tiers.filter((t) => t.runnable);
  const capable = runnableTiers.length > 0;
  // Recommend the LARGEST comfortable tier (best accuracy with headroom); if none is comfortable but some
  // run, recommend the smallest runnable (usable, if tight); else null.
  const comfy = tiers.filter((t) => t.comfortable).map((t) => t.tier);
  const recommended: WhisperTier | null = comfy.length
    ? comfy[comfy.length - 1]!
    : (runnableTiers[0]?.tier ?? null);
  const summary = capable
    ? `${ram ? `${Math.round(ram)}GB RAM · ` : ""}${specs.arch}${specs.accel && specs.accel !== "cpu" ? ` · ${specs.accel}` : ""} - recommended model: ${recommended}`
    : `This machine may be too constrained for on-device Whisper (needs ~2GB+ free RAM).`;
  return { capable, recommended, tiers, summary };
}
