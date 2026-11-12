// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/python_floor.ts - P-RUNTIME-PY.1 (ADR-0548): the decision fetch-runtimes.ts makes about the
// bundled CPython after it runs it, kept pure so it is testable (fetch-runtimes.ts runs on import).
//
// The python-build-standalone pin stayed at 20260623 (CPython 3.12.13) while the OpenSSL inside it (3.5.7)
// fell below the fixes for CVE-2026-84782 (High) and three Moderates. The SHA-256 pin proved the bytes were
// the ones chosen, not that they were still safe, and nothing read a version. Now the build runs the bundled
// interpreter and refuses a tree that is not the pinned CPython or whose OpenSSL is below the floor.

/** Lowest OpenSSL the bundled CPython may carry. Raise it with the PY_TAG that brings the fix. */
export const PY_OPENSSL_MIN = "3.5.9";

const DOTTED = /^\d+\.\d+\.\d+$/;

/** Negative, zero or positive as a is below, equal to or above b; numeric per part (3.5.10 > 3.5.9). */
export function compareDotted(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** The probe prints `{"python": "3.12.16", "openssl": "OpenSSL 3.5.9 29 Sep 2026"}`. Returns null when the
 *  interpreter is `pyVersion` with OpenSSL at or above `opensslMin`, otherwise the reason to stop the build.
 *  Output it cannot read (LibreSSL, a 1.1.1 letter release, a pre-release CPython, no JSON) is a refusal. */
export function checkBundledPython(probeOutput: string, pyVersion: string, opensslMin: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(probeOutput.trim());
  } catch {
    return `the bundled python printed no version report (${JSON.stringify(probeOutput.slice(0, 120))})`;
  }
  const python = raw && typeof raw === "object" && "python" in raw ? raw.python : null;
  const ssl = raw && typeof raw === "object" && "openssl" in raw ? raw.openssl : null;
  if (typeof python !== "string" || !DOTTED.test(python)) return `unreadable CPython version ${JSON.stringify(python)}`;
  if (python !== pyVersion) {
    return `the bundled tree is CPython ${python}, but PY_VERSION is ${pyVersion}; delete desktop/runtimes/python-* and fetch again`;
  }
  const m = typeof ssl === "string" ? /^OpenSSL (\d+\.\d+\.\d+) /.exec(ssl) : null;
  if (!m?.[1]) return `unreadable OpenSSL version ${JSON.stringify(ssl)}`;
  if (compareDotted(m[1], opensslMin) < 0) {
    return `CPython ${python} carries OpenSSL ${m[1]}, below PY_OPENSSL_MIN ${opensslMin}; move PY_TAG to a python-build-standalone release that ships it`;
  }
  return null;
}
