// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/runtime_pin.ts - P-RUNTIME-PIN.1 (ADR-0547, issue #598): the decisions fetch-runtimes.ts makes
// about a runtime already on disk, kept pure so they are testable (fetch-runtimes.ts runs on import).
//
// A cached runtime used to count as good because the file existed. When the Bun pin moved from 1.4.2 to 1.4.4
// (ADR-0526), a checkout that had fetched 1.4.2 kept it, the build said "cached, verified", and the installer
// shipped a Bun that omp 18.18 refuses to start on. Now every runtime fetch-runtimes.ts writes is recorded in
// runtimes/.pins.json with the archive SHA-256 it was verified against, and a cached runtime is reused only
// when that record matches the current pin.

/** The file in runtimes/ that records which pinned archive each runtime came from (never packaged). */
export const PINS_FILE = ".pins.json";

/** runtime name -> the archive SHA-256 it was extracted from. */
export type RuntimePins = Record<string, string>;

/** Parse .pins.json. Anything off-shape reads as no records, so every runtime is fetched again. */
export function parsePins(text: string | null): RuntimePins {
  if (text === null) return {};
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const pins: RuntimePins = {};
  for (const [name, sha] of Object.entries(raw)) if (typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha)) pins[name] = sha;
  return pins;
}

/** Reuse a runtime on disk only when it exists AND was extracted from the archive the current spec pins.
 *  A runtime with no record (fetched before this check existed) or a different one is fetched again. */
export function cachedRuntimeCurrent(exists: boolean, pins: RuntimePins, name: string, pinnedSha: string): boolean {
  return exists && pinnedSha !== "" && pins[name] === pinnedSha;
}

/** Does `version` (x.y.z, an optional prerelease after `-`) satisfy a `>=x.y.z` minimum? Any other range shape
 *  is not understood and fails closed: the build stops and says so rather than guessing. */
export function satisfiesMinimum(version: string, range: string): boolean {
  const want = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  const have = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!want || !have) return false;
  for (let i = 1; i <= 3; i++) {
    const a = Number(have[i]), b = Number(want[i]);
    if (a !== b) return a > b;
  }
  return true;
}
