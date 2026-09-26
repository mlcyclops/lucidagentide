// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/frame_capture.ts - CREATOR-3 (ADR-0287): deterministic frame capture.
//
// ADR-0287 item 3 asks that an animation "be reviewed frame by frame and regression-compared". three.js is
// NOT a dependency of this repo and MUST NOT become one: a Creator scene is a USER-authored document that
// runs in the sandboxed Preview panel, so the renderer belongs to the user, not to us. What belongs to us is
// the part that makes a capture TRUSTWORTHY, and this module is exactly that part, renderer-agnostic:
//
//   * the CLOCK       - `framePlan` hands out the exact time value for every frame, up front,
//   * the FINGERPRINT - `frameFingerprint` reduces one RGBA readback to one comparable string,
//   * the COMPARATOR  - `compareFrames`, `captureReport`, `sameCapture` say whether two runs agree.
//
// It therefore works for anything that can be advanced by an explicit time value and read back as RGBA: a
// three.js scene, a 2D canvas, a WebGL shader, an SVG animation.
//
// THE ONE IDEA. A capture is reviewable only if frame N lands on the same instant on every run, so every
// timestep is derived from the INDEX (`startMs + round(index * 1000 / fps)`) and NEVER from an accumulator.
// An accumulator adds one rounding error per frame and the errors compound; that drift is precisely the bug
// this module exists to prevent, and it is why `framePlan` returns the whole plan as data instead of handing
// back a `next()` that a caller could advance twice.
//
// THE SECOND IDEA. A capture can lie in two structural ways, and both are detectable without looking at a
// single pixel: the fingerprint list can be short or misaligned (frames went missing), or it can contain a
// run of identical consecutive frames (the scene animated off the wall clock and ignored the time it was
// handed, so the capture is not deterministic). `captureReport` names both. It cannot distinguish a stuck
// capture from a genuinely static scene, so it reports BOTH readings and refuses to pick one silently.
//
// Pure: no node builtin, no DOM, no `fetch`, no clock, no randomness, no filesystem. Every time-shaped value
// is a parameter. This module runs identically in the renderer bundle and in a unit test.
//
// Refusals are values. `framePlan` returns `{ ok: false, error }`; the comparators return their normal shape
// with `equal`/`ok` false and a `reason`/`verdict` that names what was wrong. Nothing here ever throws, so a
// caller never has to catch, and a malformed input NEVER reads as "equal and fine".

// ── the clock ───────────────────────────────────────────────────────────────

/** One planned capture: render the scene at exactly `tMs`, then read it back. `index` is 0-based. */
export interface CaptureFrame {
  readonly index: number;
  readonly tMs: number;
}

/** The hard ceiling on one plan. 3600 frames is two minutes at 30fps or 30 seconds at 120fps, which is far
 *  past the point where frame-by-frame review is what a person is actually doing. It also keeps the whole
 *  plan, and the fingerprint list beside it, comfortably small in memory. */
export const MAX_CAPTURE_FRAMES = 3600;

const MIN_FPS = 1;
const MAX_FPS = 120;

export type FramePlanResult =
  | { readonly ok: true; readonly frames: readonly CaptureFrame[] }
  | { readonly ok: false; readonly error: string };

/**
 * Build the complete, exact timeline for a capture.
 *
 * The timestep rule, stated once and relied on everywhere: `tMs = startMs + Math.round(index * 1000 / fps)`.
 * At 30fps that yields 0, 33, 67, 100, 133, 167, 200, ... and frame 29 sits at 967ms. The gaps are uneven by
 * a millisecond BY DESIGN: an even gap would need a fractional millisecond, and a fractional tMs is what
 * starts the drift. Every tMs is an integer, which is why `startMs` must be one too.
 *
 * Frame count is `floor(durationMs * fps / 1000)`, so the duration is an EXCLUSIVE end: a 1000ms capture at
 * 30fps is 30 frames, 0 through 967, and the 1000ms mark belongs to the next second.
 */
export function framePlan(opts: { durationMs: number; fps: number; startMs?: number }): FramePlanResult {
  const { durationMs, fps } = opts;
  const startMs = opts.startMs ?? 0;

  if (typeof fps !== "number" || !Number.isFinite(fps)) {
    return { ok: false, error: `fps must be a finite number, got ${describe(fps)}` };
  }
  if (fps < MIN_FPS || fps > MAX_FPS) {
    return { ok: false, error: `fps must be between ${MIN_FPS} and ${MAX_FPS}, got ${fps}` };
  }
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return { ok: false, error: `durationMs must be a finite number, got ${describe(durationMs)}` };
  }
  if (durationMs < 0) {
    return { ok: false, error: `durationMs must not be negative, got ${durationMs}` };
  }
  // An integer start keeps every tMs an integer, which is the whole promise of the timestep rule.
  if (typeof startMs !== "number" || !Number.isInteger(startMs) || startMs < 0) {
    return { ok: false, error: `startMs must be a non-negative integer number of milliseconds, got ${describe(startMs)}` };
  }

  const count = Math.floor((durationMs * fps) / 1000);
  if (count > MAX_CAPTURE_FRAMES) {
    return {
      ok: false,
      error: `a ${fps}fps capture of ${durationMs}ms needs ${count} frames, over the ${MAX_CAPTURE_FRAMES} frame cap`,
    };
  }
  // A zero-frame plan is a success shaped like a lie: the caller would loop over nothing and report a green
  // capture. Name it instead.
  if (count < 1) {
    return { ok: false, error: `${durationMs}ms at ${fps}fps yields 0 frames: nothing to capture` };
  }

  const frames: CaptureFrame[] = new Array(count);
  for (let index = 0; index < count; index++) {
    // Derived from `index`, never from `frames[index - 1]`. This line is the module.
    frames[index] = { index, tMs: startMs + Math.round((index * 1000) / fps) };
  }
  return { ok: true, frames };
}

// ── the fingerprint ─────────────────────────────────────────────────────────

/** The prefix every malformed fingerprint carries, so a mismatch is legible in a diff and detectable in a
 *  list without re-deriving the byte arithmetic. */
const INVALID = "invalid:";

/**
 * A deterministic, dependency-free digest of one RGBA readback, used only to tell two frames apart.
 *
 * NOT CRYPTOGRAPHIC: it is a 64-bit FNV-1a, trivially collidable on purpose-built input, and it protects
 * nothing. It is a regression fingerprint, and any security decision about a frame must be made elsewhere.
 *
 * The algorithm, documented so a test can reproduce it independently: FNV-1a over the byte sequence
 * `[width as little-endian uint32, height as little-endian uint32, ...rgba]`, with the standard 64-bit
 * offset basis `0xcbf29ce484222325` and prime `0x100000001b3`, held as two unsigned 32-bit halves. Mixing
 * the dimensions in means a 2x2 frame and a 4x1 frame with the same 16 bytes do not collide.
 *
 * The return is `"<w>x<h>:<len>:<16 lowercase hex digits>"`. On a byte count that does not match
 * `width * height * 4` it returns `"invalid:<len>!=<expected>"` and throws nothing, so the mismatch survives
 * into a diff as text and two invalid frames can never be read as equal-and-fine by anything in this module.
 * A `len` of -1 in that string means the frame was not a `Uint8Array` at all, so there was no length to read.
 *
 * A canvas readback is a `Uint8ClampedArray`, which this deliberately does NOT accept: pass a zero-copy view,
 * `new Uint8Array(data.buffer, data.byteOffset, data.byteLength)`, rather than copying a frame per capture.
 */
export function frameFingerprint(rgba: Uint8Array, width: number, height: number): string {
  const len = rgba instanceof Uint8Array ? rgba.length : -1;
  const expected = width * height * 4;
  const dimsOk = Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0;
  if (!dimsOk || len !== expected) return `${INVALID}${len}!=${expected}`;

  // 64-bit state as two unsigned 32-bit halves. BigInt would express this in one line and be just as correct,
  // but it allocates per operation, and a 1080p readback is 8.3M operations per frame.
  let h1 = 0xcbf29ce4; // high 32 bits
  let h0 = 0x84222325; // low 32 bits

  // The prime is 0x100000001b3 == 2^40 + 435, and both of its halves fit in 16 bits, so the 64-bit multiply
  // collapses to `hash * 435 + (hash << 40)` with one carry. Every intermediate below stays under 2^41, well
  // inside exact double integer range.
  const step = (byte: number): void => {
    h0 = (h0 ^ byte) >>> 0;
    const lowProduct = h0 * 435;                       // < 2^41, exact
    const carry = Math.floor(lowProduct / 4294967296); // < 2^9
    const nextLo = lowProduct >>> 0;                   // mod 2^32
    const nextHi = ((h1 * 435 + carry) >>> 0) + ((h0 << 8) >>> 0); // the 2^40 term lands entirely in the high half
    h1 = nextHi >>> 0;
    h0 = nextLo;
  };

  step(width & 0xff); step((width >>> 8) & 0xff); step((width >>> 16) & 0xff); step((width >>> 24) & 0xff);
  step(height & 0xff); step((height >>> 8) & 0xff); step((height >>> 16) & 0xff); step((height >>> 24) & 0xff);
  for (let i = 0; i < len; i++) step(rgba[i]!);

  const hex = h1.toString(16).padStart(8, "0") + h0.toString(16).padStart(8, "0");
  return `${width}x${height}:${len}:${hex}`;
}

/** A fingerprint this module refuses to treat as a real frame: malformed, empty, or not a string at all.
 *  Kept internal on purpose; `captureReport` already publishes the offending indices. */
function isInvalidFingerprint(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "" || value.startsWith(INVALID);
}

// ── the pixel comparator ────────────────────────────────────────────────────

export interface FrameDiff {
  readonly equal: boolean;
  /** Pixels with at least one channel whose absolute delta EXCEEDS `tolerance`. */
  readonly changedPixels: number;
  /** The largest absolute per-channel delta seen over the comparable bytes, ignoring `tolerance` entirely,
   *  so a caller can see how close a pass was to failing. */
  readonly maxChannelDelta: number;
  /** BYTE index (not pixel index) of the first channel over tolerance, or -1 when there is none. */
  readonly firstDiffIndex: number;
  readonly reason: string;
}

const MAX_TOLERANCE = 255;

/**
 * Compare two RGBA readbacks.
 *
 * `tolerance` is a per-channel absolute delta: a channel counts as CHANGED only when its delta is strictly
 * greater than the tolerance, so `tolerance: 1` absorbs a GPU that dithers by one level and `tolerance: 0`
 * demands byte equality. It must be an integer in 0..255.
 *
 * Nothing here throws. Two buffers of different lengths are `equal: false` with both lengths named, and the
 * common prefix is still compared so the caller learns whether the overlap also drifted. A tolerance outside
 * the legal range is `equal: false` as well: a malformed comparison must never report a green regression.
 */
export function compareFrames(a: Uint8Array, b: Uint8Array, opts?: { tolerance?: number }): FrameDiff {
  const tolerance = opts?.tolerance ?? 0;
  if (typeof tolerance !== "number" || !Number.isInteger(tolerance) || tolerance < 0 || tolerance > MAX_TOLERANCE) {
    return {
      equal: false, changedPixels: 0, maxChannelDelta: 0, firstDiffIndex: -1,
      reason: `tolerance must be an integer in 0..${MAX_TOLERANCE}, got ${describe(tolerance)}: refusing to compare`,
    };
  }
  const aLen = a instanceof Uint8Array ? a.length : -1;
  const bLen = b instanceof Uint8Array ? b.length : -1;
  if (aLen < 0 || bLen < 0) {
    return {
      equal: false, changedPixels: 0, maxChannelDelta: 0, firstDiffIndex: -1,
      reason: `both frames must be Uint8Array, got ${describe(a)} and ${describe(b)}: refusing to compare`,
    };
  }

  const common = Math.min(aLen, bLen);
  let changedPixels = 0;
  let maxChannelDelta = 0;
  let firstDiffIndex = -1;
  let lastChangedPixel = -1;
  for (let i = 0; i < common; i++) {
    const delta = Math.abs(a[i]! - b[i]!);
    if (delta > maxChannelDelta) maxChannelDelta = delta;
    if (delta <= tolerance) continue;
    if (firstDiffIndex < 0) firstDiffIndex = i;
    const pixel = i >> 2;
    if (pixel !== lastChangedPixel) { changedPixels++; lastChangedPixel = pixel; }
  }

  const comparablePixels = Math.ceil(common / 4);
  if (aLen !== bLen) {
    // The length mismatch is the headline; the prefix result rides along because "the first 4000 bytes also
    // differ" and "only the tail is missing" are different bugs.
    const overlap = changedPixels === 0
      ? `the ${common} shared bytes match within tolerance ${tolerance}`
      : `${changedPixels} of ${comparablePixels} shared pixels also differ (max channel delta ${maxChannelDelta}, first at byte ${firstDiffIndex})`;
    return {
      equal: false, changedPixels, maxChannelDelta,
      firstDiffIndex: firstDiffIndex >= 0 ? firstDiffIndex : common,
      reason: `byte lengths differ: ${aLen} vs ${bLen}, so these are not the same frame size; ${overlap}`,
    };
  }
  if (changedPixels === 0) {
    return {
      equal: true, changedPixels: 0, maxChannelDelta, firstDiffIndex: -1,
      reason: `${comparablePixels} pixels match within tolerance ${tolerance} (max channel delta ${maxChannelDelta})`,
    };
  }
  return {
    equal: false, changedPixels, maxChannelDelta, firstDiffIndex,
    reason: `${changedPixels} of ${comparablePixels} pixels differ beyond tolerance ${tolerance} (max channel delta ${maxChannelDelta}, first at byte ${firstDiffIndex})`,
  };
}

// ── the capture audit ───────────────────────────────────────────────────────

/** Inclusive bounds of a run of identical consecutive fingerprints. */
export interface StuckRun {
  readonly from: number;
  readonly to: number;
}

export interface CaptureReport {
  readonly ok: boolean;
  /** Frames the plan asked for. */
  readonly frames: number;
  /** Planned frames with no fingerprint at all. A SURPLUS of fingerprints leaves this 0 and is named in the
   *  verdict instead, because "missing" cannot honestly go negative. */
  readonly missing: number;
  readonly stuckRuns: readonly StuckRun[];
  /** Indices whose fingerprint is malformed, blank, or `invalid:...`. */
  readonly invalid: readonly number[];
  readonly verdict: string;
}

const STUCK_RUN_MIN = 3; // "longer than 2 identical frames", per ADR-0287 item 3.

/**
 * Audit a finished capture structurally, without looking at a pixel.
 *
 * Two lies are detectable from the fingerprint list alone:
 *   1. MISSING or MISALIGNED frames: the list is shorter than the plan, longer than the plan, or the plan
 *      itself is not the contiguous ascending thing `framePlan` produces.
 *   2. STUCK frames: three or more identical consecutive fingerprints. Either the scene is static, or it is
 *      animating off the wall clock and ignoring the tMs it was handed, in which case the capture is not
 *      deterministic and a regression compare against it means nothing.
 *
 * This function cannot tell those two readings apart, and it does not pretend to: a stuck run is always
 * reported, and the verdict states both readings. A caller who KNOWS the scene is static can ignore it; the
 * module will not make that call on the caller's behalf.
 */
export function captureReport(plan: readonly CaptureFrame[], fingerprints: readonly string[]): CaptureReport {
  const planned = Array.isArray(plan) ? plan.length : 0;
  const marks: readonly string[] = Array.isArray(fingerprints) ? fingerprints : [];
  const got = marks.length;

  const invalid: number[] = [];
  for (let i = 0; i < got; i++) if (isInvalidFingerprint(marks[i])) invalid.push(i);

  // An invalid entry BREAKS a run rather than joining it: "stuck" is a claim that the scene did not advance,
  // and a frame we could not fingerprint tells us nothing about whether it advanced.
  const stuckRuns: StuckRun[] = [];
  for (let i = 0; i < got; ) {
    const value = marks[i];
    if (isInvalidFingerprint(value)) { i++; continue; }
    let j = i + 1;
    while (j < got && marks[j] === value) j++;
    if (j - i >= STUCK_RUN_MIN) stuckRuns.push({ from: i, to: j - 1 });
    i = j;
  }

  const missing = Math.max(0, planned - got);
  const surplus = Math.max(0, got - planned);
  const fault = planFault(plan);
  const ok = planned > 0 && missing === 0 && surplus === 0 && invalid.length === 0 && stuckRuns.length === 0 && fault === "";

  const parts: string[] = [];
  if (planned === 0) parts.push("the plan has no frames, so nothing was captured");
  if (fault) parts.push(`the plan is not a contiguous ascending capture plan: ${fault}`);
  if (missing > 0) parts.push(`${missing} of ${planned} planned frames have no fingerprint`);
  if (surplus > 0) parts.push(`${got} fingerprints arrived for ${planned} planned frames, so the list is misaligned by ${surplus}`);
  if (invalid.length > 0) {
    // Cap the index list: a 3600 frame capture that failed wholesale must not produce a 3600 number verdict.
    const shown = invalid.slice(0, 8).join(", ");
    const tail = invalid.length > 8 ? `${shown}, and ${invalid.length - 8} more` : shown;
    parts.push(`${invalid.length} frames could not be fingerprinted (${tail})`);
  }
  if (stuckRuns.length > 0) {
    const stuckFrames = stuckRuns.reduce((n, r) => n + (r.to - r.from + 1), 0);
    parts.push(
      `${stuckFrames} of ${got} captured frames repeat in ${stuckRuns.length} run${stuckRuns.length === 1 ? "" : "s"}` +
      ` (${stuckRuns.map((r) => `frames ${r.from}-${r.to}`).join(", ")}), which reads either as a genuinely static` +
      ` scene or as a scene animating off the wall clock instead of the supplied tMs, and this capture cannot` +
      ` tell those two apart`,
    );
  }
  const verdict = ok
    ? `all ${planned} planned frames were fingerprinted, every fingerprint is well formed, and no ${STUCK_RUN_MIN} consecutive frames repeat`
    : parts.join("; ");
  return { ok, frames: planned, missing, stuckRuns, invalid, verdict };
}

/** Runtime shape check on the plan. It is typed, but a plan can arrive from a stored document or a route
 *  body, and a plan whose frames do not advance would make every audit above meaningless. */
function planFault(plan: readonly CaptureFrame[]): string {
  if (!Array.isArray(plan)) return `expected an array of frames, got ${describe(plan)}`;
  for (let i = 0; i < plan.length; i++) {
    const frame = plan[i];
    if (!frame || typeof frame !== "object") return `entry ${i} is ${describe(frame)}, not a frame`;
    if (!Number.isInteger(frame.index) || !Number.isInteger(frame.tMs)) {
      return `entry ${i} has a non-integer index/tMs pair (${describe(frame.index)}, ${describe(frame.tMs)})`;
    }
    if (frame.index !== i) return `entry ${i} carries index ${frame.index}`;
    if (frame.tMs < 0) return `entry ${i} is at ${frame.tMs}ms, before zero`;
    const prev = i > 0 ? plan[i - 1]! : undefined;
    if (prev && frame.tMs <= prev.tMs) return `entry ${i} at ${frame.tMs}ms does not advance past entry ${i - 1} at ${prev.tMs}ms`;
  }
  return "";
}

// ── the regression compare ──────────────────────────────────────────────────

export interface CaptureComparison {
  readonly equal: boolean;
  /** First index that disagrees or is unusable, or -1 when the two runs are equal. */
  readonly firstDiff: number;
  readonly reason: string;
}

/**
 * Compare two runs of the SAME plan: the regression-compare entry point.
 *
 * Fail-closed in three ways that matter, because every one of them would otherwise show up as a green
 * regression:
 *   * two empty runs are NOT equal, they are two runs that captured nothing,
 *   * an invalid fingerprint on either side is NOT equal even when both sides carry the identical invalid
 *     string, because two frames we could not read are not two frames we know agree,
 *   * differing lengths are NOT equal, and the common prefix is still scanned so the caller learns whether
 *     the runs diverged before the truncation or only at it.
 */
export function sameCapture(a: readonly string[], b: readonly string[]): CaptureComparison {
  const left: readonly string[] = Array.isArray(a) ? a : [];
  const right: readonly string[] = Array.isArray(b) ? b : [];
  if (left.length === 0 && right.length === 0) {
    return { equal: false, firstDiff: -1, reason: "both runs are empty, so there is nothing to compare" };
  }

  const common = Math.min(left.length, right.length);
  for (let i = 0; i < common; i++) {
    const l = left[i];
    const r = right[i];
    if (isInvalidFingerprint(l) || isInvalidFingerprint(r)) {
      const which = isInvalidFingerprint(l) && isInvalidFingerprint(r) ? "both runs" : isInvalidFingerprint(l) ? "run A" : "run B";
      return {
        equal: false, firstDiff: i,
        reason: `frame ${i} carries an unusable fingerprint in ${which} (A ${quote(l)}, B ${quote(r)}), so these runs cannot be called equal`,
      };
    }
    if (l !== r) {
      return { equal: false, firstDiff: i, reason: `frame ${i} differs: A ${quote(l)} vs B ${quote(r)}` };
    }
  }
  if (left.length !== right.length) {
    return {
      equal: false, firstDiff: common,
      reason: `the runs match for ${common} frames but their lengths differ: ${left.length} vs ${right.length}`,
    };
  }
  return { equal: true, firstDiff: -1, reason: `${common} frames match fingerprint for fingerprint` };
}

// ── small shared helpers ────────────────────────────────────────────────────

/** Name a bad value in an error without ever interpolating a hostile string unescaped or unbounded. */
function describe(value: unknown): string {
  if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
  if (typeof value === "string") return quote(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/** Quote a possibly hostile fingerprint for a message: control characters stripped, length capped, so a
 *  crafted "fingerprint" cannot smuggle newlines or bidi overrides into a log line or a UI label. */
function quote(value: unknown): string {
  if (typeof value !== "string") return describe(value);
  let out = "";
  for (const ch of value.slice(0, 48)) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code === 0x7f || (code >= 0x200b && code <= 0x206f) ? "?" : ch;
  }
  return `"${out}${value.length > 48 ? "..." : ""}"`;
}

// ── signatures: comparing frames on a platform that will not repeat itself ──
//
// Exact fingerprints answer "are these the same bytes". On a canvas that is ATTACHED and VISIBLE, that is the
// wrong question: measured in a real browser, two readbacks of ONE identical render alternate between two
// bitmaps, differing on a few hundred pixels with channel deltas up to 71. Byte equality is a property of the
// platform, not of the scene, so a compare built on it reports a regression nobody caused.
//
// A SIGNATURE asks a question the platform can answer: coarse cell means. Each cell averages a block of
// pixels, so a handful of jittering antialiased edges move a cell mean by a level or two while a real visual
// change moves many pixels in the same cell and shifts it far more. The grid is small on purpose: 32x18 is
// 576 bytes per frame, about 34KB for a 60-frame pass, which is the difference between a feature that fits on
// an edge box and one that holds 31MB of RGBA per capture.
//
// The tolerance is NOT a guess. The caller measures this platform's own jitter (two renders of one time) and
// passes the observed cell delta, so the threshold is empirical.

export const SIGNATURE_COLS = 32;
export const SIGNATURE_ROWS = 18;

/**
 * Coarse luminance signature of one frame: `SIGNATURE_COLS * SIGNATURE_ROWS` cell means, 0..255.
 *
 * Luminance rather than per-channel so a signature stays one byte per cell; the Rec. 601 weights are used
 * because they match how a viewer perceives a change. Alpha is folded in (a transparent pixel contributes
 * nothing) so a scene that clears to transparent does not read as black.
 *
 * Returns an empty array when the buffer does not match its dimensions, which callers treat as unusable
 * rather than as a frame of zeroes.
 */
export function frameSignature(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return new Uint8Array(0);
  if (rgba.length !== width * height * 4) return new Uint8Array(0);
  const out = new Uint8Array(SIGNATURE_COLS * SIGNATURE_ROWS);
  for (let cy = 0; cy < SIGNATURE_ROWS; cy++) {
    const y0 = Math.floor((cy * height) / SIGNATURE_ROWS);
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / SIGNATURE_ROWS));
    for (let cx = 0; cx < SIGNATURE_COLS; cx++) {
      const x0 = Math.floor((cx * width) / SIGNATURE_COLS);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / SIGNATURE_COLS));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          const o = (y * width + x) * 4;
          const a = (rgba[o + 3] ?? 0) / 255;
          sum += (0.299 * (rgba[o] ?? 0) + 0.587 * (rgba[o + 1] ?? 0) + 0.114 * (rgba[o + 2] ?? 0)) * a;
          n++;
        }
      }
      out[cy * SIGNATURE_COLS + cx] = n === 0 ? 0 : Math.round(sum / n);
    }
  }
  return out;
}

export interface SignatureDiff {
  readonly equal: boolean;
  readonly changedCells: number;
  readonly maxCellDelta: number;
  /** Index of the first cell over tolerance, or -1 when none is. */
  readonly firstCell: number;
  readonly reason: string;
}

/**
 * Compare two signatures with an explicit per-cell tolerance.
 *
 * `tolerance` is a cell-mean delta the caller MEASURED, not a constant this module invented. A mismatched
 * length is not equal and says both lengths, never a crash.
 */
export function compareSignatures(a: Uint8Array, b: Uint8Array, opts: { tolerance: number }): SignatureDiff {
  const tolerance = Math.max(0, Math.min(MAX_TOLERANCE, Math.trunc(opts.tolerance)));
  if (!a.length || !b.length) {
    return { equal: false, changedCells: 0, maxCellDelta: 0, firstCell: -1, reason: "one of these frames produced no signature, so they cannot be compared" };
  }
  if (a.length !== b.length) {
    return { equal: false, changedCells: 0, maxCellDelta: 0, firstCell: -1, reason: `signature lengths differ (${a.length} vs ${b.length})` };
  }
  let changed = 0;
  let maxDelta = 0;
  let firstCell = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (d > maxDelta) maxDelta = d;
    if (d > tolerance) {
      changed++;
      if (firstCell < 0) firstCell = i;
    }
  }
  return changed === 0
    ? { equal: true, changedCells: 0, maxCellDelta: maxDelta, firstCell: -1, reason: `every cell is within the measured tolerance of ${tolerance} (largest delta seen: ${maxDelta})` }
    : { equal: false, changedCells: changed, maxCellDelta: maxDelta, firstCell, reason: `${changed} of ${a.length} cells moved more than the measured tolerance of ${tolerance}, up to ${maxDelta}, first at cell ${firstCell}` };
}

export interface SignatureComparison {
  readonly equal: boolean;
  readonly firstDiff: number;
  readonly changedCells: number;
  readonly maxCellDelta: number;
  readonly reason: string;
}

/**
 * Compare two whole captures cell by cell, frame by frame, at a measured tolerance. The frame-level answer a
 * regression check actually wants: WHICH frame first moved, and by how much.
 *
 * Two empty runs are NOT equal: nothing compared is not agreement. Different lengths are not equal either.
 */
export function sameCaptureSignatures(
  a: readonly Uint8Array[], b: readonly Uint8Array[], opts: { tolerance: number },
): SignatureComparison {
  if (!a.length || !b.length) {
    return { equal: false, firstDiff: -1, changedCells: 0, maxCellDelta: 0, reason: "nothing to compare: one of these captures has no frames" };
  }
  if (a.length !== b.length) {
    return { equal: false, firstDiff: Math.min(a.length, b.length), changedCells: 0, maxCellDelta: 0, reason: `these captures are different lengths (${a.length} vs ${b.length} frames)` };
  }
  let worstDelta = 0;
  for (let i = 0; i < a.length; i++) {
    const d = compareSignatures(a[i] ?? new Uint8Array(0), b[i] ?? new Uint8Array(0), opts);
    if (d.maxCellDelta > worstDelta) worstDelta = d.maxCellDelta;
    if (!d.equal) {
      return { equal: false, firstDiff: i, changedCells: d.changedCells, maxCellDelta: d.maxCellDelta, reason: `frame ${i} differs: ${d.reason}` };
    }
  }
  return { equal: true, firstDiff: -1, changedCells: 0, maxCellDelta: worstDelta, reason: `all ${a.length} frames are within the measured tolerance of ${Math.trunc(opts.tolerance)} (largest cell delta seen: ${worstDelta})` };
}
