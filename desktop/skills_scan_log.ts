// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skills_scan_log.ts — P-SKILL.4 (ADR-0097): the recorded scan verdicts for the skill directory.
//
// A file-backed skill (project/user/plugin) shows `untrusted` until it is scanned; a re-scan runs the
// EXISTING fail-closed gate (scanAndDecide, the P-SKILL.1 path) over its content and records the verdict
// HERE so the directory reflects it across reloads. Mirrors security_ack.ts: an append-only, per-user
// JSONL (~/.omp/lucid-skill-scans.jsonl), corrupt-tolerant fold, in-memory cache invalidated when the
// path changes (tests point LUCID_SKILL_SCAN_PATH at a temp file). LATEST verdict wins — a re-scan can
// downgrade OR restore trust as the content changes.
//
// This ledger RECORDS a scan result; it never RELEASES trust on its own. The label it stores only ever
// feeds the directory + the effectiveEnabled decision (skills_gov.ts); a flagged verdict there locks the
// skill off (invariant #3, keystone #2). A dead scanner on re-scan records `quarantined`, never "safe".

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { isTrustLabel, type TrustLabel } from "../harness/contracts.ts";

export interface ScanVerdict {
  trust: TrustLabel;
  findings: number;
  at: string;
}

type ScanLine = { key: string; trust: TrustLabel; findings: number; at: string };

/** Fold raw JSONL lines into the latest verdict PER skill key. PURE + corrupt-tolerant: a bad or
 *  unknown-trust line is skipped, never thrown (the file is user-reachable). LAST valid line for a key
 *  wins, so the most recent re-scan is authoritative. */
export function foldScanVerdicts(lines: string[]): Record<string, ScanVerdict> {
  const out: Record<string, ScanVerdict> = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Partial<ScanLine>;
      if (typeof o.key === "string" && o.key && isTrustLabel(o.trust)) {
        out[o.key] = { trust: o.trust, findings: Math.max(0, Number(o.findings) || 0), at: String(o.at ?? "") };
      }
    } catch { /* skip the corrupt line — keep every parseable verdict */ }
  }
  return out;
}

// Test/demo override first (LUCID_SKILL_SCAN_PATH), else the per-user ledger beside the other JSONLs.
const DEFAULT_SCAN_PATH = join(homedir(), ".omp", "lucid-skill-scans.jsonl");

let mem: Record<string, ScanVerdict> | null = null;
let memPath = ""; // invalidate the cache when the path changes (tests point at temp dirs)

function load(): Record<string, ScanVerdict> {
  const p = process.env.LUCID_SKILL_SCAN_PATH || DEFAULT_SCAN_PATH;
  if (mem && memPath === p) return mem;
  let raw = "";
  try { raw = readFileSync(p, "utf8"); } catch { /* no ledger yet — no recorded verdicts */ }
  mem = foldScanVerdicts(raw.split("\n"));
  memPath = p;
  return mem;
}

/** Record a re-scan verdict for `key` (latest wins). Best-effort append; the in-memory view updates
 *  regardless so the current session reflects it even if the disk write fails. */
export function recordScanVerdict(key: string, trust: TrustLabel, findings: number): ScanVerdict {
  const rec: ScanVerdict = { trust, findings: Math.max(0, Math.floor(Number(findings) || 0)), at: new Date().toISOString() };
  load()[key] = rec;
  try {
    const p = process.env.LUCID_SKILL_SCAN_PATH || DEFAULT_SCAN_PATH;
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ key, trust: rec.trust, findings: rec.findings, at: rec.at } satisfies ScanLine) + "\n");
  } catch { /* ledger is best-effort; the session's in-memory verdict still holds */ }
  return rec;
}

/** The recorded verdict map (defensive copy) — skills_data.ts reads it to attach trust to directory rows. */
export function scanVerdicts(): Record<string, ScanVerdict> {
  return { ...load() };
}

/** Drop the in-memory cache so tests can point LUCID_SKILL_SCAN_PATH at a fresh temp file. */
export function _resetScanVerdictsForTest(): void { mem = null; memPath = ""; }
