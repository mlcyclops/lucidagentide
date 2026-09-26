// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/capture_driver.ts - CREATOR-3b (ADR-0287 item 3): the parent half of deterministic frame
// capture.
//
// CREATOR-3 shipped the pure clock, fingerprint and audit (harness/creator/frame_capture.ts) and nothing that
// drove a real scene through them. This module is that driver: it hands a frame PLAN to the sandboxed preview
// bridge, takes the pixels back, fingerprints them, and folds the audit plus an optional regression compare
// into one verdict a human can read.
//
// Where the honesty lives:
//
//   * DRIVEN VERSUS SAMPLED. A scene that exposes `window.lucidRenderAt(tMs)` is rendered AT LUCID's times, so
//     the capture is reproducible and a regression compare means something. A page without that hook can only
//     be sampled on its own clock, and every verdict says which happened. A sampled capture is never described
//     as deterministic, because two sampled runs agreeing is luck and two disagreeing is not evidence of a
//     change. This is the same labeling discipline as CREATOR-2's vendor-versus-derived alignment.
//   * THE BOUNDARY IS UNTRUSTED. The reply crosses a postMessage boundary from a document LUCID does not
//     control, so it arrives as `unknown` and passes a shape gate before anything reads a field. One malformed
//     or oversized frame refuses the WHOLE pass rather than yielding a report with holes in it, which is the
//     same rule `decodeWireFrames` applies to renderer-encoded frames.
//   * THE CAPS MATCH THE BRIDGE'S. `MAX_CAPTURE_PASS` here and `CAP_MAX_FRAMES` in desktop/preview_bridge.ts
//     are the same number on purpose, and a test pins them equal: a driver that asks for more than the bridge
//     will ever return would report a phantom missing-frame every time.
//
// All I/O is injected (`send`, `decode`), so the whole exchange is unit-tested with no iframe and no DOM.

import {
  SIGNATURE_COLS, SIGNATURE_ROWS, captureReport, compareFrames, compareSignatures, frameFingerprint,
  frameSignature, sameCapture, sameCaptureSignatures, type CaptureFrame, type CaptureReport,
} from "../../harness/creator/frame_capture.ts";
import { base64Bytes, parseImageDataUrl } from "./image_data_url.ts";

/** The most frames one capture pass may carry. MUST equal `CAP_MAX_FRAMES` in desktop/preview_bridge.ts. */
export const MAX_CAPTURE_PASS = 64;
/** Per-frame and whole-pass payload ceilings, mirroring the renderer-to-server wire caps in creator_image.ts.
 *  A capture is a debugging aid, not a video export: an eight-megabyte frame is a mistake, not a workload. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_PASS_BYTES = 64 * 1024 * 1024;

/** One frame as the bridge hands it over: the planned time it was asked to render, and the PNG it read back. */
export interface CaptureFrameWire {
  readonly index: number;
  readonly tMs: number;
  readonly dataUrl: string;
}

/** The bridge's answer to a capture command, after validation. */
export interface CaptureReply {
  readonly driven: boolean;
  readonly width: number;
  readonly height: number;
  readonly frames: readonly CaptureFrameWire[];
}

/** Send one capture command to the previewed document and resolve with whatever came back, unvalidated. The
 *  caller owns the transport (in the app, the `postMessage` bridge; in a test, a plain function). */
export type CaptureSend = (cmd: { readonly capture: true; readonly plan: readonly CaptureFrame[]; readonly selector?: string }) => Promise<unknown>;

/** Decode one PNG data URL to raw RGBA. In the app this is an OffscreenCanvas; in a test it is a fake, which
 *  is why fingerprinting stays testable without a browser. Returning null means undecodable. */
export type FrameDecoder = (dataUrl: string) => Promise<{ readonly width: number; readonly height: number; readonly rgba: Uint8Array } | null>;

/** What two renders of the SAME time proved about this platform's readback, measured rather than assumed.
 *
 *  Why this exists: a canvas that is ATTACHED and VISIBLE does not necessarily rasterize the same drawing to
 *  the same pixels twice. Measured in headless Chromium against a scene whose logic is provably pure, two
 *  readbacks of one identical render alternate between two bitmaps in a clean 2-cycle, differing on about
 *  0.17% of pixels with channel deltas up to 71. Copying through a detached canvas first does NOT fix it:
 *  `drawImage` inherits the source bitmap. A detached canvas, by contrast, is byte-stable.
 *
 *  So byte equality is a property of the PLATFORM, not of the scene, and a regression compare that assumes it
 *  reports a false failure on the user's first click. The driver therefore measures the floor and refuses to
 *  draw a conclusion the measurement cannot support. */
export interface NoiseFloor {
  /** True when two renders of one time came back byte-identical, so an exact compare is meaningful. */
  readonly byteStable: boolean;
  readonly changedPixels: number;
  readonly maxChannelDelta: number;
  /** The largest SIGNATURE cell delta the same two renders produced. This is the empirical tolerance a
   *  coarse compare needs: the platform's own jitter, measured, not a constant anyone invented. */
  readonly maxCellDelta: number;
  readonly reason: string;
}

/** Headroom added to the measured cell delta before it becomes a tolerance, so a compare is not sitting
 *  exactly on the noise it just measured. One level, because the measurement is of the same platform in the
 *  same session, seconds earlier. */
export const TOLERANCE_MARGIN = 1;

export interface CaptureVerdict {
  readonly ok: boolean;
  readonly error: string;
  /** True when the scene rendered at LUCID's times. False means the page was sampled on its own clock. */
  readonly driven: boolean;
  readonly width: number;
  readonly height: number;
  readonly fingerprints: readonly string[];
  /** Coarse per-frame signatures, the baseline a jittery platform can actually be judged against. About
   *  576 bytes a frame, so a 60-frame pass costs roughly 34KB rather than 31MB of RGBA. */
  readonly signatures: readonly Uint8Array[];
  /** The structural audit: missing frames, stuck runs, invalid frames, and its own verdict sentence. */
  readonly report: CaptureReport | null;
  /** Set when a baseline was supplied and SOME comparison was possible. `method` says which one ran:
   *  `exact` on a byte-stable platform, `signature` at the measured tolerance otherwise. */
  readonly regression: {
    readonly equal: boolean;
    readonly firstDiff: number;
    readonly reason: string;
    readonly method: "exact" | "signature";
  } | null;
  /** Null when the floor was not measured (no probe requested, or the probe itself failed). */
  readonly noiseFloor: NoiseFloor | null;
  /** True only when a baseline existed and NEITHER comparison could run, which now means the floor probe
   *  itself failed. An inconclusive result is reported as inconclusive, never as a pass or a regression. */
  readonly inconclusive: boolean;
  readonly note: string;
}

/** Shape gate for the bridge's reply. Fail-closed: anything that is not exactly this shape is a refusal, not
 *  a partially-read capture. Every field is checked before it is read, because this crosses a boundary from a
 *  document LUCID does not own. */
export function isCaptureReply(v: unknown): v is CaptureReply {
  if (!v || typeof v !== "object") return false;
  const o: Record<string, unknown> = v as Record<string, unknown>;
  if (typeof o.driven !== "boolean" || typeof o.width !== "number" || typeof o.height !== "number") return false;
  if (!Array.isArray(o.frames)) return false;
  return o.frames.every((f: unknown) => {
    if (!f || typeof f !== "object") return false;
    const fr: Record<string, unknown> = f as Record<string, unknown>;
    return typeof fr.index === "number" && typeof fr.tMs === "number" && typeof fr.dataUrl === "string";
  });
}

/** The error string a bridge refusal carries, or "" when the reply is not an error object. The bridge answers
 *  `{ error }` for every refusal it makes, and that sentence is the user's best explanation, so it is passed
 *  through verbatim rather than replaced with a generic failure. */
function bridgeError(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  const o: Record<string, unknown> = v as Record<string, unknown>;
  return typeof o.error === "string" ? o.error : "";
}

const refuse = (error: string, driven = false): CaptureVerdict => ({
  ok: false, error, driven, width: 0, height: 0, fingerprints: [], signatures: [], report: null,
  regression: null, noiseFloor: null, inconclusive: false, note: error,
});

/** How many points across the plan the floor is sampled at. One point is not enough, and that is measured,
 *  not assumed: probing only the first frame reported a cell delta of 0 while the real 60-frame pass reached
 *  3, so the tolerance it produced was too tight and the honest scene failed its own compare. The floor has
 *  to be measured over the SAME domain the comparison covers. */
export const FLOOR_SAMPLE_POINTS = 3;

/**
 * Measure what THIS platform's readback actually does, by asking for several times ACROSS the plan twice each
 * in one pass and diffing each pair. Returns null when the probe could not be run at all, which is treated as
 * unmeasured rather than as stable.
 *
 * This is a measurement, not a formality. On a live composited canvas it comes back unstable, and that answer
 * is what stops the regression compare below from inventing a failure.
 */
async function measureNoiseFloor(
  plan: readonly CaptureFrame[], send: CaptureSend, decode: FrameDecoder, selector?: string,
): Promise<NoiseFloor | null> {
  // First, middle and last: the cheapest sample that still spans what the pass will render. Duplicated in
  // place so each pair is two readbacks of ONE identical render.
  const picks: number[] = [];
  for (let i = 0; i < FLOOR_SAMPLE_POINTS; i++) {
    const at = plan[Math.min(plan.length - 1, Math.floor((i * (plan.length - 1)) / Math.max(1, FLOOR_SAMPLE_POINTS - 1)))];
    if (at && !picks.includes(at.tMs)) picks.push(at.tMs);
  }
  const probePlan: readonly CaptureFrame[] = picks.flatMap((tMs, i) => [{ index: i * 2, tMs }, { index: i * 2 + 1, tMs }]);
  let raw: unknown;
  try { raw = await send({ capture: true, plan: probePlan, ...(selector ? { selector } : {}) }); }
  catch { return null; }
  if (!isCaptureReply(raw) || raw.frames.length !== probePlan.length) return null;

  let byteStable = true;
  let worstPixels = 0;
  let worstChannel = 0;
  let worstCell = 0;
  let worstAt = picks[0] ?? 0;
  for (let i = 0; i < raw.frames.length; i += 2) {
    const first = raw.frames[i], second = raw.frames[i + 1];
    if (!first || !second) return null;
    const a = await decode(first.dataUrl).catch(() => null);
    const b = await decode(second.dataUrl).catch(() => null);
    if (!a || !b) return null;
    const diff = compareFrames(a.rgba, b.rgba, { tolerance: 0 });
    // The same pair gives the coarse tolerance too, so one probe answers both questions: can we compare
    // exactly, and if not, how much movement is this platform's own noise.
    const cells = compareSignatures(
      frameSignature(a.rgba, a.width, a.height),
      frameSignature(b.rgba, b.width, b.height),
      { tolerance: 0 },
    );
    if (!diff.equal) byteStable = false;
    if (diff.changedPixels > worstPixels) worstPixels = diff.changedPixels;
    if (diff.maxChannelDelta > worstChannel) worstChannel = diff.maxChannelDelta;
    if (cells.maxCellDelta > worstCell) { worstCell = cells.maxCellDelta; worstAt = first.tMs; }
  }
  return byteStable
    ? { byteStable: true, changedPixels: 0, maxChannelDelta: 0, maxCellDelta: worstCell, reason: `${picks.length} time(s) across the plan each rendered twice and came back byte-identical, so an exact compare is meaningful here` }
    : {
        byteStable: false,
        changedPixels: worstPixels,
        maxChannelDelta: worstChannel,
        maxCellDelta: worstCell,
        reason: `rendering the SAME time twice differs here: worst case ${worstPixels} pixel(s) and ${worstChannel} per channel across ${picks.length} sampled time(s), but only ${worstCell} per signature cell (worst at ${worstAt}ms), so this platform needs a coarse compare rather than a byte compare`,
      };
}

/**
 * Run one capture pass and judge it.
 *
 * Returns a verdict; it never throws. A transport that rejects, a malformed reply, an oversized payload, or a
 * frame that will not decode are each a named refusal.
 */
export async function runCapture(opts: {
  readonly plan: readonly CaptureFrame[];
  readonly send: CaptureSend;
  readonly decode: FrameDecoder;
  readonly selector?: string;
  readonly baseline?: readonly string[];
  /** The coarse baseline a jittery platform is judged against. Stored beside the fingerprints by the caller,
   *  because on such a platform the fingerprints are unusable for a compare and these are not. */
  readonly baselineSignatures?: readonly Uint8Array[];
  /** Measure this platform's readback stability before judging a baseline. Default true whenever any baseline
   *  was supplied: without it, a compare is a guess about the platform. */
  readonly measureFloor?: boolean;
}): Promise<CaptureVerdict> {
  const { plan, send, decode, selector, baseline, baselineSignatures } = opts;
  if (!plan.length) return refuse("A capture needs a frame plan, and this one is empty.");
  if (plan.length > MAX_CAPTURE_PASS) {
    return refuse(`That plan is ${plan.length} frames, over the ${MAX_CAPTURE_PASS}-frame limit for one capture pass. Shorten the duration or lower the frame rate.`);
  }
  const wantFloor = opts.measureFloor ?? (!!baseline?.length || !!baselineSignatures?.length);
  const noiseFloor = wantFloor ? await measureNoiseFloor(plan, send, decode, selector) : null;

  let raw: unknown;
  try {
    raw = await send({ capture: true, plan, ...(selector ? { selector } : {}) });
  } catch (err) {
    return refuse(`The preview did not answer the capture request (${String(err)}).`);
  }

  const said = bridgeError(raw);
  if (said) return refuse(said);
  if (!isCaptureReply(raw)) return refuse("The preview answered with a capture this build cannot read, so nothing was judged.");

  // One bad frame refuses the pass. A report built from a subset would understate `missing` and could read as
  // a clean capture of a shorter animation.
  let total = 0;
  const fingerprints: string[] = [];
  const signatures: Uint8Array[] = [];
  for (const frame of raw.frames) {
    const parsed = parseImageDataUrl(frame.dataUrl);
    if (!parsed) {
      return refuse(`Frame ${frame.index} came back as something other than an image data URL, so the whole pass was refused.`, raw.driven);
    }
    const bytes = base64Bytes(parsed.base64);
    total += bytes;
    if (bytes > MAX_FRAME_BYTES) {
      return refuse(`Frame ${frame.index} is ${bytes} bytes, over the ${MAX_FRAME_BYTES}-byte per-frame limit.`, raw.driven);
    }
    if (total > MAX_PASS_BYTES) {
      return refuse(`This pass exceeded the ${MAX_PASS_BYTES}-byte total limit at frame ${frame.index}.`, raw.driven);
    }
    const decoded = await decode(frame.dataUrl).catch(() => null);
    if (!decoded || decoded.rgba.length !== decoded.width * decoded.height * 4) {
      return refuse(`Frame ${frame.index} would not decode to pixels, so the whole pass was refused.`, raw.driven);
    }
    fingerprints.push(frameFingerprint(decoded.rgba, decoded.width, decoded.height));
    signatures.push(frameSignature(decoded.rgba, decoded.width, decoded.height));
  }

  const report = captureReport(plan, fingerprints);

  // WHICH compare runs is decided by the MEASUREMENT, not by hope, and the verdict always says which one it
  // was. Exact when the platform PROVED it repeats a byte-identical render and a fingerprint baseline exists.
  // Otherwise coarse, at a tolerance taken from the platform's own measured jitter, which is a real verdict
  // rather than a shrug. A floor that could not be measured leaves the baseline unjudged, because a tolerance
  // nobody measured is a number somebody invented.
  const wantJudge = !!baseline?.length || !!baselineSignatures?.length;
  let regression: CaptureVerdict["regression"] = null;
  if (wantJudge && noiseFloor?.byteStable && baseline?.length) {
    const exact = sameCapture(baseline, fingerprints);
    regression = { equal: exact.equal, firstDiff: exact.firstDiff, reason: exact.reason, method: "exact" };
  } else if (wantJudge && noiseFloor && baselineSignatures?.length) {
    const tolerance = noiseFloor.maxCellDelta + TOLERANCE_MARGIN;
    const coarse = sameCaptureSignatures(baselineSignatures, signatures, { tolerance });
    regression = { equal: coarse.equal, firstDiff: coarse.firstDiff, reason: coarse.reason, method: "signature" };
  }
  const inconclusive = wantJudge && regression === null;

  // The note states which kind of capture this was FIRST, because every other sentence means something
  // different depending on that answer.
  const how = raw.driven
    ? "This scene was driven at LUCID's own times, so an identical second pass is a real reproducibility result."
    : "This page exposed no window.lucidRenderAt, so it was SAMPLED on its own clock: repeats and differences here are the page's timing, not evidence about determinism. Add the hook to make this capture reproducible.";
  const byWhat = regression?.method === "signature"
    ? ` Compared by ${SIGNATURE_COLS}x${SIGNATURE_ROWS} luminance signature at a tolerance of ${(noiseFloor?.maxCellDelta ?? 0) + TOLERANCE_MARGIN} measured from this platform's own readback jitter, because it does not repeat a byte-identical render.`
    : "";
  const regressionNote = regression
    ? regression.equal
      ? ` It matches the stored baseline.${byWhat}`
      : ` It DIFFERS from the stored baseline: ${regression.reason}${byWhat}`
    : inconclusive
      ? ` No baseline verdict was drawn: ${noiseFloor?.reason ?? "this platform's readback stability could not be measured"}, and no signature baseline was stored to fall back on.`
      : "";
  return {
    ok: report.ok && (!regression || regression.equal),
    error: report.ok ? (regression && !regression.equal ? "This capture differs from its baseline." : "") : report.verdict,
    driven: raw.driven,
    width: raw.width,
    height: raw.height,
    fingerprints,
    signatures,
    report,
    regression,
    noiseFloor,
    inconclusive,
    note: `${how} ${report.verdict}${regressionNote}`,
  };
}
