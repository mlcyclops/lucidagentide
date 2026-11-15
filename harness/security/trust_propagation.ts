// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/security/trust_propagation.ts - P-CAP.1b (ADR-0590): a derived fact is never trusted more than its sources.
//
// THE RULE. Whatever is computed from several inputs carries the MOST SEVERE trust label among them. An
// input whose label is not known counts as quarantined: provenance that cannot be verified is not trusted
// (invariant 3). Nothing a model says about its own inputs enters into it.
//
// WHY A SESSION REMEMBERS. The promotion gate (keystone 2) stops a suspicious source from becoming durable
// memory. A model can sidestep a per-artifact check without meaning to: it reads a suspicious tool result,
// then stores a "fact" in its own words. The fact names no source, so it used to be stored as plain
// untrusted, and the next session recalled it. So the SESSION is the unit that remembers: once content
// labeled suspicious has been shown to the model in a session, everything that session writes to durable
// memory derives from it as far as anyone can prove otherwise, and is held for human review.
//
// The note is written by the result gate at the moment it lets suspicious content through, in memory first
// and then beside the session's artifacts so it survives a restart and a resume. A note file that cannot be
// read counts as a note (fail-closed).
//
// Quarantined content is not a source here: it never reaches the model, so nothing derives from it.

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrustLabel } from "../contracts.ts";
import type { SpillLedger } from "./spill_provenance.ts";

const SEVERITY: Record<TrustLabel, number> = { trusted: 0, untrusted: 1, suspicious: 2, quarantined: 3 };
const LABELS = Object.keys(SEVERITY) as TrustLabel[];

function isLabel(v: unknown): v is TrustLabel {
  return typeof v === "string" && (LABELS as string[]).includes(v);
}

/** PURE: the label of something derived from `inputs`: the most severe among them and `floor`. An input
 *  that is not one of the four labels (missing, null, misspelled) counts as quarantined. */
export function mostSevere(inputs: readonly unknown[], floor: TrustLabel = "untrusted"): TrustLabel {
  let worst: TrustLabel = floor;
  for (const raw of inputs) {
    const label: TrustLabel = isLabel(raw) ? raw : "quarantined";
    if (SEVERITY[label] > SEVERITY[worst]) worst = label;
  }
  return worst;
}

/** PURE: must a write with this label wait for human review before it becomes durable memory? The same two
 *  labels as the promotion gate's BLOCKED_TRUST (a test holds them equal). Stated here as well because the
 *  omp-side tools cannot import the promotion gate, which pulls in the database. */
export function needsReview(trust: unknown): boolean {
  return !isLabel(trust) || trust === "suspicious" || trust === "quarantined";
}

export const TAINT_FILE = "lucid-taint.jsonl";

/** One time suspicious content was shown to the model in a session. */
export interface TaintRecord {
  session_id: string;
  trust_label: "suspicious";
  /** Where it came from, for example `mcp:github`. */
  source: string;
  tool_name: string;
  created_at: string;
}

function parseTaint(v: unknown): TaintRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.session_id !== "string" || r.trust_label !== "suspicious" || typeof r.source !== "string" || typeof r.tool_name !== "string" || typeof r.created_at !== "string") return null;
  return { session_id: r.session_id, trust_label: "suspicious", source: r.source, tool_name: r.tool_name, created_at: r.created_at };
}

/** What one session has taken in that its own writes may derive from. */
export class SessionTaint {
  readonly #file: string | null;
  readonly #records: TaintRecord[] = [];
  #loaded = false;
  #unreadable = false;

  /** `artifactsDir` null keeps the notes in memory only (a non-persistent session). */
  constructor(artifactsDir: string | null) {
    this.#file = artifactsDir === null ? null : join(artifactsDir, TAINT_FILE);
  }

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    if (this.#file === null) return;
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch (err) {
      // Absent is the normal case: nothing suspicious was ever shown. Anything else cannot be trusted to answer.
      if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT") return;
      this.#unreadable = true;
      return;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let rec: TaintRecord | null = null;
      try { rec = parseTaint(JSON.parse(line)); } catch { rec = null; }
      if (rec === null) { this.#unreadable = true; continue; } // a damaged line may have been a note
      this.#records.push(rec);
    }
  }

  /** Note that suspicious content was shown. In memory first, then on disk. Returns false when the durable
   *  write failed: this process still knows, a restart would not. Never throws: the caller is the result
   *  gate, and a note that cannot be saved must not change what the gate returns. */
  note(rec: TaintRecord): boolean {
    this.#load();
    this.#records.push(rec);
    if (this.#file === null) return true;
    try { appendFileSync(this.#file, `${JSON.stringify(rec)}\n`, "utf8"); return true; } catch { return false; }
  }

  /** True when the note file could not be read or held a damaged line. */
  get unreadable(): boolean {
    this.#load();
    return this.#unreadable;
  }

  records(): TaintRecord[] {
    this.#load();
    return [...this.#records];
  }

  /** The distinct sources of what was shown, in the order they first appeared. */
  sources(): string[] {
    this.#load();
    return [...new Set(this.#records.map((r) => r.source))];
  }
}

// One per artifacts directory for the whole process, so the gate that writes a note and the tool that reads
// it share the in-memory state even when the durable write failed.
const taints = new Map<string, SessionTaint>();

/** The shared notes for a session. `memoryKey` identifies a session that has no artifacts directory. */
export function taintFor(artifactsDir: string | null, memoryKey: string): SessionTaint {
  const key = artifactsDir ?? `memory:${memoryKey}`;
  let t = taints.get(key);
  if (!t) { t = new SessionTaint(artifactsDir); taints.set(key, t); }
  return t;
}

/** For tests: forget every cached session. */
export function __resetTaints(): void {
  taints.clear();
}

export interface SourceTrust {
  /** The label anything this session writes to durable memory carries. Never `trusted`. */
  trust: TrustLabel;
  /** Where the severity came from, for the refusal the model is shown. */
  sources: string[];
}

/** What a session's own writes derive from, as a label: the most severe of plain `untrusted`, every note of
 *  suspicious content shown, every suspicious artifact in the spill ledger that was not purged, and
 *  `suspicious` again when the notes or the ledger cannot be read. */
export function sessionSourceTrust(taint: SessionTaint, ledger: SpillLedger | null): SourceTrust {
  const inputs: TrustLabel[] = [];
  const sources: string[] = [];
  const add = (source: string): void => { inputs.push("suspicious"); if (!sources.includes(source)) sources.push(source); };
  for (const s of taint.sources()) add(s);
  if (taint.unreadable) add("a session record that could not be read");
  if (ledger) {
    for (const r of ledger.records()) if (r.trust_label === "suspicious" && !r.purged) add(r.source);
    if (ledger.unreadable) add("a provenance ledger that could not be read");
  }
  return { trust: mostSevere(inputs, "untrusted"), sources };
}
