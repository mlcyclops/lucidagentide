// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/tools/output_minify_proto.ts
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │  PROTOTYPE — pre-increment, pre-ADR. NOT wired into result_adapter.ts      │
// │  (frozen contract) or any omp hook. Sole purpose: MEASURE the token        │
// │  savings of two deterministic output-compression passes before we commit   │
// │  to a contract change. Delete or promote to a real increment after review. │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Two passes, applied in this order:
//   1. stripAnsi        — remove ANSI/VT escape sequences (CSI/OSC/Fe/charset).
//   2. dedupConsecutive — collapse runs of identical ADJACENT lines into one
//                         line + a " (xN)" count marker.
//
// Design properties (these are the safety rails the real layer must keep):
//   • PURE + total: never throws, no I/O, no globals.
//   • ORDER-PRESERVING: dedup only merges adjacent equals; nothing is reordered
//     and no UNIQUE line is ever dropped. Non-adjacent duplicates are kept.
//   • ADDITIVE: the passes annotate/shorten; they never invent content. The
//     count marker is the only text added.
//   • LINEAR-TIME regex only (ReDoS-safe): every pattern is a character class
//     with a single quantifier over DISJOINT byte ranges — no nested/overlapping
//     quantifiers, so untrusted input cannot trigger catastrophic backtracking.
//     (The Rust original gets this for free from the RE2-style `regex` crate;
//     JS `RegExp` backtracks, so this is load-bearing, not incidental.)
//   • ANSI-strip runs FIRST so lines differing only by color codes collapse.
//
// Recovery of the full original is intentionally OUT OF SCOPE here: in the real
// layer the raw output already persists as an `artifact://` with its trust label
// + findings, so compression is a presentation-only view over safe-as-data text.

/** rtk-compatible rough token estimate: ceil(chars / 4). Same metric rtk's
 *  tracking uses, so our measured deltas are comparable to its reported ones. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// --- ANSI / VT escape sequences (all linear, disjoint-range classes) ----------
// OSC: ESC ] ... terminated by BEL (0x07) or ST (ESC \). Body bounded to
//      non-ESC/non-BEL so the `*` can never backtrack.
const RE_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// CSI: ESC [ , params [0x30-0x3f], intermediates [0x20-0x2f], final [0x40-0x7e].
//      The three ranges are disjoint => `[0-?]*[ -/]*` is unambiguous (no blowup).
const RE_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// Charset selects: ESC ( B , ESC ) 0 , etc.
const RE_CHARSET = /\x1b[()][@-~]/g;
// Other single Fe escapes: ESC = , ESC > , ESC M , ESC 7 ...
const RE_FE = /\x1b[@-Z\\-_0-9=>]/g;

/** Remove ANSI/VT escape sequences. Pure, total, linear-time. */
export function stripAnsi(text: string): string {
  if (text.indexOf("\x1b") === -1) return text; // fast path: nothing to strip
  return text
    .replace(RE_OSC, "")
    .replace(RE_CSI, "")
    .replace(RE_CHARSET, "")
    .replace(RE_FE, "");
}

export interface DedupOptions {
  /** Minimum run length before a run is collapsed+annotated. Default 2. */
  min?: number;
  /** Marker appended to a collapsed line, given the run count. Default " (xN)". */
  marker?: (count: number) => string;
}

export interface DedupResult {
  text: string;
  /** Count of lines removed by collapsing (sum of runLen-1 over collapsed runs). */
  linesRemoved: number;
}

/** Collapse runs of identical ADJACENT lines into one line + count marker.
 *  CRLF is normalized to LF (lossless for text) so Windows output dedups too.
 *  Order-preserving: non-adjacent duplicates stay separate; nothing is reordered. */
export function dedupConsecutive(text: string, opts?: DedupOptions): DedupResult {
  const min = opts?.min ?? 2;
  const marker = opts?.marker ?? ((n: number) => ` (x${n})`);
  // Normalize CRLF -> LF up front so comparisons and output are consistent.
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let removed = 0;
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i];
    let j = i + 1;
    while (j < lines.length && lines[j] === cur) j++;
    const runLen = j - i;
    if (runLen >= min) {
      out.push(cur + marker(runLen));
      removed += runLen - 1;
    } else {
      out.push(cur); // runLen === 1 (min is >= 2 in practice)
    }
    i = j;
  }
  return { text: out.join("\n"), linesRemoved: removed };
}

export interface MinifyStats {
  charsBefore: number;
  charsAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  pctSaved: number; // 0..100, one decimal
  linesRemoved: number;
}

export interface MinifyResult {
  text: string;
  stats: MinifyStats;
}

/** Compose stripAnsi -> dedupConsecutive and report token deltas. */
export function minify(text: string, opts?: DedupOptions): MinifyResult {
  const stripped = stripAnsi(text);
  const { text: deduped, linesRemoved } = dedupConsecutive(stripped, opts);
  const tokensBefore = estimateTokens(text);
  const tokensAfter = estimateTokens(deduped);
  const tokensSaved = tokensBefore - tokensAfter;
  const pctSaved =
    tokensBefore === 0 ? 0 : Math.round((tokensSaved / tokensBefore) * 1000) / 10;
  return {
    text: deduped,
    stats: {
      charsBefore: text.length,
      charsAfter: deduped.length,
      tokensBefore,
      tokensAfter,
      tokensSaved,
      pctSaved,
      linesRemoved,
    },
  };
}
