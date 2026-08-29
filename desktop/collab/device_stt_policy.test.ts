// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/device_stt_policy.test.ts - P-REMOTE.14: the device speech-to-text decision.
//
// This is a SECURITY decision expressed as a pure function, so it is tested exhaustively: every rule, both
// halves of the strict matrix, and the fail-closed edges (an "available" claim with nothing that could have
// proven it, a status the availability API never answered). The one thing that must never happen is a strict
// CUI session reaching "device-cloud", because that mode means the browser vendor receives the audio.
//
// The strings are phone UI copy, so they are asserted too: every message names a next step, and none of them
// carries an em dash (project rule: hyphens, commas, colons only).

import { describe, expect, it } from "bun:test";
import { decideSttMode, isStrict, type HostPosture, type SttCapability, type SttDecision } from "./device_stt_policy.ts";

const STRICT: HostPosture = { cui: true, lockdown: true };
const OPEN: HostPosture = { cui: false, lockdown: false };
const CUI_ONLY: HostPosture = { cui: true, lockdown: false };
const LOCKDOWN_ONLY: HostPosture = { cui: false, lockdown: true };

/** The one user-facing string a decision carries, whichever field it lives in. */
function message(d: SttDecision): string {
  if (d.mode === "host") return d.reason;
  if (d.mode === "device-cloud") return d.warn;
  return d.note;
}

function cap(over: Partial<SttCapability> = {}): SttCapability {
  return { supported: true, localProvable: true, localStatus: "available", ...over };
}

describe("decideSttMode: rule 1, no recognizer at all", () => {
  it("explains an installed iOS home-screen app and points at hold-to-talk", () => {
    const d = decideSttMode(cap({ supported: false, localProvable: false, localStatus: "unknown", reason: "installed-pwa-ios" }), OPEN);
    expect(d.mode).toBe("host");
    expect(message(d)).toContain("home screen");
    expect(message(d)).toContain("hold the mic button");
  });

  it("explains a non-Safari iOS browser", () => {
    const d = decideSttMode(cap({ supported: false, localProvable: false, localStatus: "unknown", reason: "ios-webkit" }), OPEN);
    expect(d.mode).toBe("host");
    expect(message(d)).toContain("iPhone and iPad");
    expect(message(d)).toContain("hold the mic button");
  });

  it("explains a browser with no speech API", () => {
    const d = decideSttMode(cap({ supported: false, localProvable: false, localStatus: "unknown", reason: "no-api" }), OPEN);
    expect(d.mode).toBe("host");
    expect(message(d)).toContain("no speech recognition");
  });

  it("explains a failed availability probe without proving anything", () => {
    const d = decideSttMode(cap({ supported: false, localProvable: false, localStatus: "unknown", reason: "probe-failed" }), OPEN);
    expect(d.mode).toBe("host");
    expect(message(d)).toContain("could not confirm");
  });

  it("inlines a free-text reason that reads as prose", () => {
    const d = decideSttMode(cap({ supported: false, localProvable: false, localStatus: "unknown", reason: "the microphone permission was denied" }), OPEN);
    expect(d.mode).toBe("host");
    expect(message(d)).toContain("the microphone permission was denied");
  });

  it("swallows an unknown one-word token rather than leaking jargon into the phone UI", () => {
    const d = decideSttMode(cap({ supported: false, localProvable: false, localStatus: "unknown", reason: "some-future-token" }), OPEN);
    expect(d.mode).toBe("host");
    expect(message(d)).not.toContain("some-future-token");
    expect(message(d)).toContain("hold the mic button");
  });

  it("still explains itself with no reason at all", () => {
    const d = decideSttMode(cap({ supported: false, localProvable: false, localStatus: "unknown" }), OPEN);
    expect(d.mode).toBe("host");
    expect(message(d)).toContain("hold the mic button");
  });

  it("refuses under a strict posture too, and never claims the phone could do it", () => {
    const d = decideSttMode(cap({ supported: false, localProvable: false, localStatus: "unknown", reason: "no-api" }), STRICT);
    expect(d.mode).toBe("host");
  });
});

describe("decideSttMode: rule 2, proven on-device recognition", () => {
  it("is allowed under a STRICT CUI posture, because the audio never leaves the phone", () => {
    const d = decideSttMode(cap({ localStatus: "available" }), STRICT);
    expect(d.mode).toBe("device-local");
    expect(message(d)).toContain("never leaves your phone");
  });

  it("is allowed with an open posture", () => {
    expect(decideSttMode(cap({ localStatus: "available" }), OPEN).mode).toBe("device-local");
  });

  it("is allowed with only half of the strict guarantee set", () => {
    expect(decideSttMode(cap({ localStatus: "available" }), CUI_ONLY).mode).toBe("device-local");
    expect(decideSttMode(cap({ localStatus: "available" }), LOCKDOWN_ONLY).mode).toBe("device-local");
  });

  it("is NOT believed when nothing could have proven it (fail-closed)", () => {
    // An "available" status with localProvable false is incoherent: only the static availability API can
    // produce that status. Strict must not buy device transcription from an unprovable claim.
    expect(decideSttMode(cap({ localProvable: false, localStatus: "available" }), STRICT).mode).toBe("host");
    expect(decideSttMode(cap({ localProvable: false, localStatus: "available" }), OPEN).mode).toBe("device-cloud");
  });
});

describe("decideSttMode: rule 3, the one-time language-pack install", () => {
  it("offers the install for a downloadable pack under a strict posture", () => {
    const d = decideSttMode(cap({ localStatus: "downloadable" }), STRICT);
    expect(d.mode).toBe("install-first");
    expect(message(d)).toContain("Install the on-device language pack");
  });

  it("offers the install for a downloadable pack with an open posture", () => {
    expect(decideSttMode(cap({ localStatus: "downloadable" }), OPEN).mode).toBe("install-first");
  });

  it("waits out an in-flight download under a strict posture", () => {
    const d = decideSttMode(cap({ localStatus: "downloading" }), STRICT);
    expect(d.mode).toBe("install-first");
    expect(message(d)).toContain("still downloading");
  });

  it("waits out an in-flight download with an open posture", () => {
    expect(decideSttMode(cap({ localStatus: "downloading" }), OPEN).mode).toBe("install-first");
  });

  it("needs a provable source for the install offer too", () => {
    expect(decideSttMode(cap({ localProvable: false, localStatus: "downloadable" }), STRICT).mode).toBe("host");
    expect(decideSttMode(cap({ localProvable: false, localStatus: "downloading" }), STRICT).mode).toBe("host");
  });
});

describe("decideSttMode: rule 4, strict posture with no proven local path", () => {
  it("names CUI and lockdown when the browser cannot prove on-device recognition", () => {
    const d = decideSttMode(cap({ localProvable: false, localStatus: "unknown" }), STRICT);
    expect(d.mode).toBe("host");
    expect(message(d)).toContain("CUI");
    expect(message(d)).toContain("lockdown");
    expect(message(d)).toContain("hold the mic button");
  });

  it("refuses a provably unavailable on-device pack", () => {
    expect(decideSttMode(cap({ localStatus: "unavailable" }), STRICT).mode).toBe("host");
  });

  it("refuses an unanswered availability probe", () => {
    expect(decideSttMode(cap({ localStatus: "unknown" }), STRICT).mode).toBe("host");
  });
});

describe("decideSttMode: rule 5, the vendor cloud is the only route left", () => {
  it("warns that the audio leaves the phone when local is not provable", () => {
    const d = decideSttMode(cap({ localProvable: false, localStatus: "unknown" }), OPEN);
    expect(d.mode).toBe("device-cloud");
    expect(message(d)).toContain("browser vendor");
    expect(message(d)).toContain("leaves the phone");
    expect(message(d)).toContain("hold the mic button");
  });

  it("warns for a provably unavailable pack outside a strict session", () => {
    expect(decideSttMode(cap({ localStatus: "unavailable" }), OPEN).mode).toBe("device-cloud");
  });

  it("is reachable with only ONE half of the strict guarantee set", () => {
    // This is the whole point of requiring BOTH halves: a CUI session without lockdown, or lockdown without
    // a CUI designation, is not the sealed posture, so the cloud is offered with its warning attached.
    expect(decideSttMode(cap({ localStatus: "unknown" }), CUI_ONLY).mode).toBe("device-cloud");
    expect(decideSttMode(cap({ localStatus: "unknown" }), LOCKDOWN_ONLY).mode).toBe("device-cloud");
  });

  it("is NEVER reachable under a strict posture, for any capability shape", () => {
    const shapes: SttCapability[] = [
      cap({ localStatus: "available" }),
      cap({ localStatus: "downloadable" }),
      cap({ localStatus: "downloading" }),
      cap({ localStatus: "unavailable" }),
      cap({ localStatus: "unknown" }),
      cap({ localProvable: false, localStatus: "available" }),
      cap({ localProvable: false, localStatus: "unknown" }),
      cap({ supported: false, localProvable: false, localStatus: "unknown", reason: "no-api" }),
    ];
    for (const c of shapes) expect(decideSttMode(c, STRICT).mode).not.toBe("device-cloud");
  });
});

describe("isStrict", () => {
  it("is true only when a CUI session AND lockdown are both set", () => {
    expect(isStrict({ cui: true, lockdown: true })).toBe(true);
    expect(isStrict({ cui: true, lockdown: false })).toBe(false);
    expect(isStrict({ cui: false, lockdown: true })).toBe(false);
    expect(isStrict({ cui: false, lockdown: false })).toBe(false);
  });
});

describe("phone copy", () => {
  const POSTURES: HostPosture[] = [STRICT, OPEN, CUI_ONLY, LOCKDOWN_ONLY];
  const CAPS: SttCapability[] = [
    cap({ localStatus: "available" }),
    cap({ localStatus: "downloadable" }),
    cap({ localStatus: "downloading" }),
    cap({ localStatus: "unavailable" }),
    cap({ localStatus: "unknown" }),
    cap({ localProvable: false, localStatus: "available" }),
    cap({ localProvable: false, localStatus: "unknown" }),
    cap({ supported: false, localProvable: false, localStatus: "unknown", reason: "installed-pwa-ios" }),
    cap({ supported: false, localProvable: false, localStatus: "unknown", reason: "ios-webkit" }),
    cap({ supported: false, localProvable: false, localStatus: "unknown", reason: "no-api" }),
    cap({ supported: false, localProvable: false, localStatus: "unknown", reason: "probe-failed" }),
    cap({ supported: false, localProvable: false, localStatus: "unknown", reason: "some-future-token" }),
    cap({ supported: false, localProvable: false, localStatus: "unknown" }),
  ];

  it("never contains an em dash", () => {
    for (const c of CAPS) {
      for (const p of POSTURES) expect(message(decideSttMode(c, p))).not.toContain("\u2014");
    }
  });

  it("is always a non-empty sentence", () => {
    for (const c of CAPS) {
      for (const p of POSTURES) {
        const m = message(decideSttMode(c, p));
        expect(m.length).toBeGreaterThan(20);
        expect(m.endsWith(".")).toBe(true);
      }
    }
  });
});
