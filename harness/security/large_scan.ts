// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/security/large_scan.ts
//
// P-CTX.2a (ADR-0578): scan text that is too large for one scanner request.
//
// WHY. The sidecar answers one request in about 1.3 s per MB and the client times out at 5 s, so a single
// request over roughly 3 MB can never succeed. The MCP result gate now scans the WHOLE of a result omp
// spilled to an artifact (not just the inline view), and a spilled result is large by definition.
//
// HOW. The text is cut into chunks at line boundaries and each chunk is scanned in order. Every finding
// type the scanner emits is decided per code point or per word, and neither crosses a line break, so a
// line-boundary cut cannot hide a finding. A single line longer than a chunk is cut at whitespace, and
// only as a last resort between code points (never inside a surrogate pair). Finding indexes are shifted
// back to offsets in the whole text.
//
// FAIL-CLOSED (invariant 3). Any chunk whose scan fails blocks the whole text, exactly as scanAndDecide
// does for one request. Text over the size cap is blocked without scanning: an unscannable result is
// never a pass.

import type { Finding } from "../contracts.ts";
import { DEFAULT_POLICY, decideFromFindings, type GateDecision, type GatePolicy } from "./gate.ts";
import { ScanUnavailableError, type ScannerClient } from "./scanner_client.ts";

/** Characters per scanner request. About 0.3 s of scanner time, far inside the 5 s client timeout. */
export const SCAN_CHUNK_CHARS = 200_000;

/** Largest text scanned in full. At about 1.3 s per MB this stays well inside omp's 30 s handler budget;
 *  anything larger is blocked, fail-closed, rather than passed unscanned. */
export const MAX_FULL_SCAN_CHARS = 8_000_000;

/** One chunk of a larger text: where it starts and its characters. */
export interface ScanChunk {
  start: number;
  text: string;
}

/** True when the UTF-16 unit at `i` is the low half of a surrogate pair (a cut there splits a character). */
function isLowSurrogate(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
}

/** Cut `text` into chunks of at most `max` characters: at the last line break in range, else the last
 *  whitespace, else between code points. Concatenating the chunks gives back `text` exactly. */
export function chunkForScan(text: string, max: number = SCAN_CHUNK_CHARS): ScanChunk[] {
  if (max < 2) throw new RangeError("chunk size must be at least 2");
  const chunks: ScanChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const nl = window.lastIndexOf("\n");
      if (nl >= 0) {
        end = start + nl + 1; // keep the line break with the line it ends
      } else {
        const ws = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
        if (ws > 0) end = start + ws + 1;
        else if (isLowSurrogate(text, end)) end -= 1; // never split a surrogate pair
      }
    }
    chunks.push({ start, text: text.slice(start, end) });
    start = end;
  }
  return chunks;
}

function failClosed(reason: string): GateDecision {
  return { block: true, reason: `fail-closed: ${reason}`, trustLabel: "quarantined", findings: [], failClosed: true };
}

/** Scan `text` of any size and decide. Fail-closed on a failed chunk or on text over `maxChars`. Stops at
 *  the first chunk whose findings already force a block, since the verdict cannot improve after that. */
export async function scanAndDecideLarge(
  client: ScannerClient,
  text: string,
  policy: GatePolicy = DEFAULT_POLICY,
  limits: { chunkChars?: number; maxChars?: number } = {},
): Promise<GateDecision> {
  const maxChars = limits.maxChars ?? MAX_FULL_SCAN_CHARS;
  if (text.length > maxChars) {
    return failClosed(`text of ${text.length} characters is over the ${maxChars} character scan limit`);
  }
  const findings: Finding[] = [];
  for (const chunk of chunkForScan(text, limits.chunkChars ?? SCAN_CHUNK_CHARS)) {
    try {
      const resp = await client.scan(chunk.text);
      for (const f of resp.findings) findings.push({ ...f, index: f.index + chunk.start });
    } catch (err) {
      const why = err instanceof ScanUnavailableError ? err.message : String(err);
      return failClosed(`scan unavailable (${why})`);
    }
    const soFar = decideFromFindings(findings, policy);
    if (soFar.block) return soFar;
  }
  return decideFromFindings(findings, policy);
}
