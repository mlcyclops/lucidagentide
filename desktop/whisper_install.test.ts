// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The Whisper install/serve plan (whisper_install.ts): pick a runnable model, detect already-installed, emit
// the serve URL + spawn argv, and fail-closed on an incomplete / error-page download.

import { describe, expect, it } from "bun:test";
import { whisperCapability, type MachineSpecs } from "./whisper_capability.ts";
import { looksLikeWhisperModel, offeredRecommendation, OFFERED_TIERS, planWhisperInstall, whisperServeUrl, whisperServerArgs, WHISPER_MODELS } from "./whisper_install.ts";

const mac = (totalRamGB: number): MachineSpecs => ({ arch: "arm64", platform: "darwin", totalRamGB, cpuCores: 10, accel: "metal" });

describe("planWhisperInstall", () => {
  it("defaults to the tiny tier when no tier is picked (cheap no-code start)", () => {
    const p = planWhisperInstall(whisperCapability(mac(8)));
    expect(p.ok).toBe(true);
    if (p.ok) { expect(p.tier).toBe("tiny"); expect(p.model.fileName).toBe("ggml-tiny.en.bin"); expect(p.alreadyInstalled).toBe(false); }
  });

  it("honors the hardware-recommended tier when passed explicitly (small on 8GB)", () => {
    const caps = whisperCapability(mac(8));
    const p = planWhisperInstall(caps, { tier: caps.recommended ?? undefined });
    expect(p.ok && p.tier).toBe("small");
  });

  it("marks a model already on disk as installed", () => {
    const p = planWhisperInstall(whisperCapability(mac(8)), { tier: "small", presentModels: new Set(["ggml-small.en.bin"]) });
    expect(p.ok && p.alreadyInstalled).toBe(true);
  });

  it("honors an explicit runnable tier even if not comfortable (small on 4GB)", () => {
    const p = planWhisperInstall(whisperCapability(mac(4)), { tier: "small" });
    expect(p.ok && p.tier).toBe("small");
  });

  // P-STT.6 (ADR-0267): medium/large are no longer offered - slow + unstable through the local server.
  it("refuses a no-longer-offered tier even when the hardware could run it (medium on 8GB)", () => {
    const p = planWhisperInstall(whisperCapability(mac(8)), { tier: "medium" });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain("no longer offered");
  });

  it("the DEFAULT tier is tiny on ANY hardware (P-STT.6 autostart decision), never the raw capability pick", () => {
    // Union semantics from the fleet-voice merge: master's shipped tiny-default wins over the earlier
    // clamp-to-recommendation default; the clamped recommendation still surfaces via whisperStatus.
    const p = planWhisperInstall(whisperCapability(mac(512)));
    expect(p.ok && p.tier).toBe("tiny");
  });

  it("offeredRecommendation: nothing larger than small is ever recommended", () => {
    expect(OFFERED_TIERS).toEqual(["tiny", "base", "small"]);
    expect(offeredRecommendation(whisperCapability(mac(2)))).toBe("tiny");
    expect(offeredRecommendation(whisperCapability(mac(8)))).toBe("small");
    expect(offeredRecommendation(whisperCapability(mac(512)))).toBe("small");
    expect(offeredRecommendation(whisperCapability(mac(1)))).toBeNull();
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
