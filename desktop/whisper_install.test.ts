// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The Whisper install/serve plan (whisper_install.ts): pick a runnable model, detect already-installed, emit
// the serve URL + spawn argv, and fail-closed on an incomplete / error-page download.

import { describe, expect, it } from "bun:test";
import { whisperCapability, type MachineSpecs } from "./whisper_capability.ts";
import { looksLikeWhisperModel, planWhisperInstall, whisperServeUrl, whisperServerArgs, WHISPER_MODELS } from "./whisper_install.ts";

const mac = (totalRamGB: number): MachineSpecs => ({ arch: "arm64", platform: "darwin", totalRamGB, cpuCores: 10, accel: "metal" });

describe("planWhisperInstall", () => {
  it("plans the recommended tier for an 8GB machine (small)", () => {
    const p = planWhisperInstall(whisperCapability(mac(8)));
    expect(p.ok).toBe(true);
    if (p.ok) { expect(p.tier).toBe("small"); expect(p.model.fileName).toBe("ggml-small.en.bin"); expect(p.alreadyInstalled).toBe(false); }
  });

  it("marks a model already on disk as installed", () => {
    const p = planWhisperInstall(whisperCapability(mac(8)), { presentModels: new Set(["ggml-small.en.bin"]) });
    expect(p.ok && p.alreadyInstalled).toBe(true);
  });

  it("honors an explicit runnable tier even if not comfortable (medium on 8GB)", () => {
    const p = planWhisperInstall(whisperCapability(mac(8)), { tier: "medium" });
    expect(p.ok && p.tier).toBe("medium");
  });

  it("refuses a tier the machine can't run (large-turbo on 4GB)", () => {
    const p = planWhisperInstall(whisperCapability(mac(4)), { tier: "large-turbo" });
    expect(p.ok).toBe(false);
  });

  it("refuses entirely on an incapable machine", () => {
    expect(planWhisperInstall(whisperCapability(mac(1))).ok).toBe(false);
  });
});

describe("serve wiring", () => {
  it("serve URL is loopback with NO /v1 (the STT backend appends it)", () => {
    expect(whisperServeUrl(9111)).toBe("http://127.0.0.1:9111");
  });
  it("spawn argv binds the model to loopback on the port", () => {
    expect(whisperServerArgs("/models/ggml-base.en.bin", 9111)).toEqual(["-m", "/models/ggml-base.en.bin", "--host", "127.0.0.1", "--port", "9111"]);
  });
  it("every catalog model has a real HF url + filename", () => {
    for (const m of Object.values(WHISPER_MODELS)) {
      expect(m.url).toMatch(/^https:\/\/huggingface\.co\/.+\.bin$/);
      expect(m.url.endsWith(m.fileName)).toBe(true);
    }
  });
});

describe("looksLikeWhisperModel (fail-closed integrity)", () => {
  const big = 200 * 1024 * 1024; // 200 MB
  it("accepts a plausible binary of the expected size", () => {
    expect(looksLikeWhisperModel(new Uint8Array([0x00, 0x01]), big, 148).ok).toBe(true);
  });
  it("rejects an HTML error page saved as .bin", () => {
    expect(looksLikeWhisperModel(new Uint8Array([0x3c]), big, 148).ok).toBe(false); // '<'
  });
  it("rejects a truncated download well under the expected size", () => {
    expect(looksLikeWhisperModel(new Uint8Array([0x00]), 1024, 148).ok).toBe(false);
  });
});
