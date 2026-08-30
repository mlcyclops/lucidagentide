// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/capture_driver.test.ts - CREATOR-3b (ADR-0287 item 3).
//
// The claims defended here:
//
//   * A SAMPLED CAPTURE IS NEVER SOLD AS DETERMINISTIC. The verdict says which kind it was, first, and a page
//     with no render hook gets the sentence that tells the user what to add.
//   * THE BOUNDARY IS UNTRUSTED. A malformed reply, one bad frame, or an oversized payload refuses the WHOLE
//     pass, because a report built from a subset understates its own missing count.
//   * THE CAPS MATCH THE BRIDGE. If the driver asks for more frames than the bridge will ever return, every
//     capture reports phantom missing frames, so the two constants are pinned equal here.
//
// The transport and the decoder are injected, so there is no iframe, no canvas, and no clock in this file.

import { describe, expect, test } from "bun:test";
import { framePlan, type CaptureFrame } from "../../harness/creator/frame_capture.ts";
import {
  MAX_CAPTURE_PASS, isCaptureReply, runCapture,
  type CaptureFrameWire, type FrameDecoder,
} from "./capture_driver.ts";
import { PREVIEW_BRIDGE_JS } from "../preview_bridge.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

const PLAN: readonly CaptureFrame[] = (() => {
  const p = framePlan({ durationMs: 200, fps: 30 });
  if (!p.ok) throw new Error(p.error);
  return p.frames;
})();

/** A 2x2 RGBA buffer whose pixels are a pure function of `tMs`, so a driven pass is reproducible. */
const pixels = (tMs: number): Uint8Array => {
  const px = new Uint8Array(2 * 2 * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = tMs % 256; px[i + 1] = 90; px[i + 2] = 140; px[i + 3] = 255;
  }
  return px;
};

/** A data URL that CARRIES its time, so the fake decoder can turn it back into the right pixels without a
 *  real PNG encoder in the loop. The base64 body stays in the legal alphabet the parser demands. */
const urlFor = (tMs: number): string => `data:image/png;base64,${btoa(`frame-${tMs}`).replace(/[^A-Za-z0-9+/=]/g, "")}`;

const wire = (frames: readonly CaptureFrame[], at: (t: number) => string = urlFor): CaptureFrameWire[] =>
  frames.map((f) => ({ index: f.index, tMs: f.tMs, dataUrl: at(f.tMs) }));

const decoder: FrameDecoder = async (dataUrl) => {
  const decoded = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const tMs = Number(decoded.replace("frame-", ""));
  if (!Number.isFinite(tMs)) return null;
  return { width: 2, height: 2, rgba: pixels(tMs) };
};

/** Build a reply for the plan the caller ACTUALLY asked for, which is what a real bridge does. It matters:
 *  the noise-floor probe asks for two frames at ONE time, and a fake that ignored the plan would silently
 *  skip the measurement this driver now depends on. */
const replyFor = (cmd: { readonly plan: readonly CaptureFrame[] }, over: Record<string, unknown> = {}) =>
  ({ driven: true, width: 2, height: 2, frames: wire(cmd.plan), ...over });

/** The plain full-pass reply, for the cases that do not care which plan was asked for. */
const replyOf = (over: Record<string, unknown> = {}) =>
  ({ driven: true, width: 2, height: 2, frames: wire(PLAN), ...over });

/** The floor probe asks for several times ACROSS the plan, each duplicated in place. Detected by that shape
 *  rather than by a frame count, so widening `FLOOR_SAMPLE_POINTS` does not silently break these fakes. */
const isFloorProbe = (cmd: { readonly plan: readonly CaptureFrame[] }): boolean =>
  cmd.plan.length >= 2 && cmd.plan.length % 2 === 0 && cmd.plan[0]?.tMs === cmd.plan[1]?.tMs;

// ── the caps agree with the bridge ──────────────────────────────────────────

test("the driver's pass cap is the SAME number the bridge enforces, or every capture reports phantom gaps", () => {
  expect(PREVIEW_BRIDGE_JS).toContain(`CAP_MAX_FRAMES=${MAX_CAPTURE_PASS}`);
});

// ── driven versus sampled ───────────────────────────────────────────────────

describe("driven versus sampled", () => {
  test("a driven pass reports reproducibility as a real result, and fingerprints every planned frame", async () => {
    const v = await runCapture({ plan: PLAN, send: async () => replyOf(), decode: decoder });
    expect(v.ok).toBe(true);
    expect(v.driven).toBe(true);
    expect(v.fingerprints).toHaveLength(PLAN.length);
    expect(v.note).toContain("driven at LUCID's own times");
    expect(v.report?.missing).toBe(0);
  });

  test("a SAMPLED pass is never described as deterministic, and names the hook that would fix it", async () => {
    const v = await runCapture({ plan: PLAN, send: async () => replyOf({ driven: false }), decode: decoder });
    expect(v.driven).toBe(false);
    expect(v.note).toContain("SAMPLED on its own clock");
    expect(v.note).toContain("window.lucidRenderAt");
    expect(v.note).not.toContain("reproducibility result");
  });

  test("two driven passes of a time-driven scene fingerprint identically", async () => {
    const a = await runCapture({ plan: PLAN, send: async () => replyOf(), decode: decoder });
    const b = await runCapture({ plan: PLAN, send: async (cmd) => replyFor(cmd), decode: decoder, baseline: a.fingerprints });
    expect(b.regression?.equal).toBe(true);
    expect(b.note).toContain("matches the stored baseline");
    expect(b.ok).toBe(true);
  });

  test("a scene that changed fails against its baseline and names the first differing frame", async () => {
    const a = await runCapture({ plan: PLAN, send: async () => replyOf(), decode: decoder });
    // Same plan, different pixels from frame 3 on: the page changed under a stored baseline.
    const drifted = wire(PLAN, (t) => urlFor(t >= 100 ? t + 7 : t));
    const b = await runCapture({ plan: PLAN, send: async (cmd) => replyFor(cmd, isFloorProbe(cmd) ? {} : { frames: drifted }), decode: decoder, baseline: a.fingerprints });
    expect(b.ok).toBe(false);
    expect(b.regression?.equal).toBe(false);
    expect(b.regression?.firstDiff).toBe(3);
    expect(b.error).toContain("differs from its baseline");
  });

  test("a stuck scene is caught by the audit even when it agrees with its own baseline", async () => {
    const frozen = wire(PLAN, () => urlFor(0));
    const a = await runCapture({ plan: PLAN, send: async () => replyOf({ frames: frozen }), decode: decoder });
    const b = await runCapture({ plan: PLAN, send: async (cmd) => replyFor(cmd, isFloorProbe(cmd) ? {} : { frames: frozen }), decode: decoder, baseline: a.fingerprints });
    // Reproducible AND not a capture: the regression passes, the audit does not, and ok follows the audit.
    expect(b.regression?.equal).toBe(true);
    expect(b.report?.stuckRuns.length).toBeGreaterThan(0);
    expect(b.ok).toBe(false);
  });
});

// ── the boundary is untrusted ───────────────────────────────────────────────

describe("the reply crosses an untrusted boundary", () => {
  test("the bridge's own refusal sentence is passed through verbatim rather than replaced", async () => {
    const v = await runCapture({ plan: PLAN, send: async () => ({ error: "this page has no canvas to capture" }), decode: decoder });
    expect(v.ok).toBe(false);
    expect(v.error).toBe("this page has no canvas to capture");
  });

  test("a malformed reply refuses instead of painting a partial report", async () => {
    for (const bad of [null, 42, "ok", {}, { driven: true, width: 2, height: 2 }, { driven: "yes", width: 2, height: 2, frames: [] }]) {
      const v = await runCapture({ plan: PLAN, send: async () => bad, decode: decoder });
      expect(v.ok).toBe(false);
      expect(v.report).toBeNull();
    }
  });

  test("a frames array holding a non-frame is refused by the shape gate", () => {
    expect(isCaptureReply({ driven: true, width: 1, height: 1, frames: [{ index: 0, tMs: 0, dataUrl: "d" }] })).toBe(true);
    expect(isCaptureReply({ driven: true, width: 1, height: 1, frames: [{ index: 0, tMs: 0 }] })).toBe(false);
    expect(isCaptureReply({ driven: true, width: 1, height: 1, frames: [null] })).toBe(false);
  });

  test("ONE frame that is not an image data URL refuses the WHOLE pass, naming the frame", async () => {
    const frames = wire(PLAN);
    frames[2] = { index: 2, tMs: 67, dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" };
    const v = await runCapture({ plan: PLAN, send: async () => replyOf({ frames }), decode: decoder });
    expect(v.ok).toBe(false);
    expect(v.error).toContain("Frame 2");
    expect(v.error).toContain("whole pass was refused");
    expect(v.fingerprints).toHaveLength(0);
  });

  test("a frame that will not decode refuses the whole pass rather than dropping it", async () => {
    const v = await runCapture({ plan: PLAN, send: async () => replyOf(), decode: async () => null });
    expect(v.ok).toBe(false);
    expect(v.error).toContain("would not decode");
  });

  test("a decoder whose buffer does not match its dimensions is refused, not fingerprinted", async () => {
    const v = await runCapture({
      plan: PLAN, send: async () => replyOf(),
      decode: async () => ({ width: 4, height: 4, rgba: new Uint8Array(8) }),
    });
    expect(v.ok).toBe(false);
    expect(v.error).toContain("would not decode");
  });

  test("an oversized frame is refused with the byte count", async () => {
    const huge = `data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}`;
    const frames = [{ index: 0, tMs: 0, dataUrl: huge }];
    const v = await runCapture({ plan: PLAN.slice(0, 1), send: async () => replyOf({ frames }), decode: decoder });
    expect(v.ok).toBe(false);
    expect(v.error).toContain("per-frame limit");
  });

  test("a transport that rejects is a named refusal, never an escaping exception", async () => {
    const v = await runCapture({ plan: PLAN, send: async () => { throw new Error("frame is gone"); }, decode: decoder });
    expect(v.ok).toBe(false);
    expect(v.error).toContain("did not answer");
    expect(v.error).toContain("frame is gone");
  });
});

// ── plan guards ─────────────────────────────────────────────────────────────

describe("plan guards", () => {
  test("an empty plan is refused before the transport is touched", async () => {
    let called = false;
    const v = await runCapture({ plan: [], send: async () => { called = true; return replyOf(); }, decode: decoder });
    expect(v.ok).toBe(false);
    expect(called).toBe(false);
  });

  test("a plan over the pass cap is refused with both numbers, and nothing is sent", async () => {
    const long = framePlan({ durationMs: 4000, fps: 30 });
    if (!long.ok) throw new Error(long.error);
    let called = false;
    const v = await runCapture({ plan: long.frames, send: async () => { called = true; return replyOf(); }, decode: decoder });
    expect(v.ok).toBe(false);
    expect(v.error).toContain(String(long.frames.length));
    expect(v.error).toContain(String(MAX_CAPTURE_PASS));
    expect(called).toBe(false);
  });

  test("a short reply is judged as MISSING frames rather than as a clean shorter capture", async () => {
    const v = await runCapture({ plan: PLAN, send: async () => replyOf({ frames: wire(PLAN.slice(0, 2)) }), decode: decoder });
    expect(v.ok).toBe(false);
    expect(v.report?.missing).toBe(PLAN.length - 2);
  });

  test("the selector is forwarded only when the caller gave one", async () => {
    const sent: Record<string, unknown>[] = [];
    await runCapture({ plan: PLAN, send: async (cmd) => { sent.push(cmd); return replyOf(); }, decode: decoder });
    await runCapture({ plan: PLAN, send: async (cmd) => { sent.push(cmd); return replyOf(); }, decode: decoder, selector: "#scene" });
    expect("selector" in (sent[0] ?? {})).toBe(false);
    expect(sent[1]?.selector).toBe("#scene");
  });
});

// ── the platform is measured, not assumed ───────────────────────────────────

describe("the readback noise floor", () => {
  /** A transport whose PROBE returns a DIFFERENT frame for each half of every duplicated pair, exactly as a
   *  live composited canvas does, while the real pass stays self-consistent. It answers every frame the probe
   *  asked for, because a reply that is short of the plan is treated as an unusable measurement. */
  const jittery = (): CaptureSend => async (cmd) => {
    if (isFloorProbe(cmd)) {
      return {
        driven: true, width: 2, height: 2,
        frames: cmd.plan.map((f, i) => ({ index: f.index, tMs: f.tMs, dataUrl: urlFor(f.tMs + (i % 2)) })),
      };
    }
    return replyOf();
  };

  test("a platform that cannot read a canvas back twice the same way is MEASURED as unstable", async () => {
    const v = await runCapture({ plan: PLAN, send: jittery(), decode: decoder, baseline: ["x"] });
    expect(v.noiseFloor?.byteStable).toBe(false);
    expect(v.noiseFloor?.changedPixels).toBeGreaterThan(0);
    expect(v.noiseFloor?.reason).toContain("needs a coarse compare rather than a byte compare");
  });

  test("and NO baseline verdict is drawn: an unjudgeable compare is inconclusive, not a regression", async () => {
    const v = await runCapture({ plan: PLAN, send: jittery(), decode: decoder, baseline: ["x"] });
    expect(v.inconclusive).toBe(true);
    expect(v.regression).toBeNull();
    // The scene is not blamed for the platform's jitter: the audit still passed, so ok holds.
    expect(v.ok).toBe(true);
    expect(v.error).toBe("");
    expect(v.note).toContain("No baseline verdict was drawn");
    expect(v.note).toContain("no signature baseline was stored to fall back on");
  });

  test("a byte-stable platform is measured as stable and the compare RUNS", async () => {
    const a = await runCapture({ plan: PLAN, send: async () => replyOf(), decode: decoder });
    const b = await runCapture({ plan: PLAN, send: async (cmd) => replyFor(cmd), decode: decoder, baseline: a.fingerprints });
    expect(b.noiseFloor?.byteStable).toBe(true);
    expect(b.inconclusive).toBe(false);
    expect(b.regression?.equal).toBe(true);
  });

  test("the floor is not probed when there is no baseline to judge, so a first pass costs one round trip", async () => {
    const plans: number[] = [];
    await runCapture({ plan: PLAN, send: async (cmd) => { plans.push(cmd.plan.length); return replyOf(); }, decode: decoder });
    expect(plans).toEqual([PLAN.length]);
  });

  test("a probe that cannot run at all leaves the floor unmeasured, and unmeasured is not stable", async () => {
    const send: CaptureSend = async (cmd) =>
      (isFloorProbe(cmd) ? { error: "no canvas yet" } : replyOf());
    const v = await runCapture({ plan: PLAN, send, decode: decoder, baseline: ["x"] });
    expect(v.noiseFloor).toBeNull();
    expect(v.inconclusive).toBe(true);
    expect(v.regression).toBeNull();
  });
});

// ── the coarse compare a jittery platform CAN support ───────────────────────

describe("signature compare at a measured tolerance", () => {
  /** Jitters the pixels a little on every readback, exactly like a live composited canvas, while the SCENE
   *  itself stays a pure function of time. The wobble is small enough to vanish into a cell mean. */
  const jitteryPixels = (): CaptureSend => {
    let n = 0;
    return async (cmd) => ({
      driven: true, width: 2, height: 2,
      frames: cmd.plan.map((f) => ({ index: f.index, tMs: f.tMs, dataUrl: urlFor(f.tMs + (++n % 2) * 0.0001) })),
    });
  };

  test("a jittery platform with a SIGNATURE baseline gets a real verdict, not a shrug", async () => {
    const a = await runCapture({ plan: PLAN, send: async (cmd) => replyFor(cmd), decode: decoder });
    const b = await runCapture({
      plan: PLAN, send: async (cmd) => replyFor(cmd), decode: decoder,
      baselineSignatures: a.signatures,
    });
    expect(b.inconclusive).toBe(false);
    expect(b.regression).not.toBeNull();
    expect(b.regression?.equal).toBe(true);
  });

  test("the verdict SAYS which compare ran, so nobody reads a coarse match as byte equality", async () => {
    const a = await runCapture({ plan: PLAN, send: jitteryPixels(), decode: decoder });
    const b = await runCapture({ plan: PLAN, send: jitteryPixels(), decode: decoder, baselineSignatures: a.signatures });
    expect(b.regression?.method).toBe("signature");
    expect(b.note).toContain("luminance signature at a tolerance of");
    expect(b.note).toContain("measured from this platform's own readback jitter");
  });

  test("a REAL change still fails the coarse compare and names the frame", async () => {
    const a = await runCapture({ plan: PLAN, send: async (cmd) => replyFor(cmd), decode: decoder });
    // Frame 3 onward renders a visibly different moment: a change no tolerance should absorb.
    const changed: CaptureSend = async (cmd) => ({
      driven: true, width: 2, height: 2,
      frames: cmd.plan.map((f, i) => ({ index: f.index, tMs: f.tMs, dataUrl: urlFor(isFloorProbe(cmd) ? f.tMs : (i >= 3 ? f.tMs + 120 : f.tMs)) })),
    });
    const b = await runCapture({ plan: PLAN, send: changed, decode: decoder, baselineSignatures: a.signatures });
    expect(b.regression?.equal).toBe(false);
    expect(b.regression?.firstDiff).toBe(3);
    expect(b.ok).toBe(false);
  });

  test("signatures are cheap enough to keep: one frame is a few hundred bytes, not a megabyte", async () => {
    const v = await runCapture({ plan: PLAN, send: async (cmd) => replyFor(cmd), decode: decoder });
    expect(v.signatures).toHaveLength(PLAN.length);
    expect(v.signatures[0]?.length).toBe(32 * 18);
  });
});
