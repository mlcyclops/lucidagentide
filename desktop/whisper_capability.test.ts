// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The on-device Whisper capability gate (whisper_capability.ts): install/run only when the hardware can hold
// the tier. Pins the RAM gating + the "largest comfortable tier" recommendation so a constrained box gets a
// small model and a workstation gets the big one.

import { describe, expect, it } from "bun:test";
import { whisperCapability, type MachineSpecs } from "./whisper_capability.ts";

const mac = (totalRamGB: number): MachineSpecs => ({ arch: "arm64", platform: "darwin", totalRamGB, cpuCores: 10, accel: "metal" });

describe("whisperCapability", () => {
  it("a tiny machine can still run the smallest tier", () => {
    const c = whisperCapability(mac(2));
    expect(c.capable).toBe(true);
    expect(c.recommended).toBe("tiny");
    expect(c.tiers.find((t) => t.tier === "tiny")!.runnable).toBe(true);
    expect(c.tiers.find((t) => t.tier === "small")!.runnable).toBe(false);
  });

  it("a very constrained machine (1GB) is NOT capable", () => {
    const c = whisperCapability(mac(1));
    expect(c.capable).toBe(false);
    expect(c.recommended).toBeNull();
  });

  it("an 8GB machine recommends 'small' (comfortable), can RUN medium but not comfortably", () => {
    const c = whisperCapability(mac(8));
    expect(c.recommended).toBe("small");
    const medium = c.tiers.find((t) => t.tier === "medium")!;
    expect(medium.runnable).toBe(true);
    expect(medium.comfortable).toBe(false);
  });

  it("a workstation (M3 Ultra, 512GB) recommends the largest tier", () => {
    const c = whisperCapability(mac(512));
    expect(c.recommended).toBe("large-turbo");
    expect(c.tiers.every((t) => t.runnable && t.comfortable)).toBe(true);
    expect(c.summary).toContain("large-turbo");
  });

  it("unknown RAM (0) degrades to not-capable rather than guessing yes", () => {
    expect(whisperCapability(mac(0)).capable).toBe(false);
  });
});
