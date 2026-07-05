// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/file_store.ts — P-AGENT.2b (ADR-0133): workspace-local Agent Spec persistence as JSON files
// under `<root>/.omp/agents/<spec_id>.json`.
//
// The DESKTOP engine uses this (not the DuckDB store in store.ts): it opens the shared agent_obs.duckdb
// READ-ONLY because omp's gate child is the single writer, so it can't write specs there. Authored specs
// therefore live with the workspace like `codegraph.json` — editable, versionable, portable. The DuckDB
// `agent_specs` table remains the runtime/audit record (written later, P-AGENT.4).
//
// Fail-closed both ways: `saveSpecFile` REFUSES an invalid spec (never writes it); the readers re-validate and
// skip/return-null on a corrupted file. `spec_id` is sanitized to a safe filename to defeat path traversal.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { validateSpec, type AgentSpec } from "./spec.ts";
import { assertSecretFree } from "./secret_guard.ts";
import type { TrustLabel } from "../contracts.ts";

const agentsDir = (root: string): string => join(root, ".omp", "agents");
const specFile = (root: string, id: string): string => join(agentsDir(root), `${id}.json`);
const trustFile = (root: string, id: string): string => join(agentsDir(root), `${id}.trust.json`);
const historyDir = (root: string, id: string): string => join(agentsDir(root), "history", id);

/** P-AGENT.17 (ADR-0145): revisions kept per spec. Old snapshots are pruned newest-first. */
export const SPEC_HISTORY_KEEP = 20;

export interface SpecFileSummary {
  spec_id: string;
  name: string;
  mode: string;
  self_edit: string;
  updated_at: number;
  trust_label?: TrustLabel;
  trust_reason?: string;
}

export interface SpecTrustRecord {
  trustLabel: TrustLabel;
  reason: string;
  reviewed_at?: number;
}

/** Only allow the minted id charset (`agent_<uuid>`) as a filename — never a path separator / traversal. */
function safeId(id: unknown): string | null {
  return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

/** Validate then write a spec to `<root>/.omp/agents/<spec_id>.json`. Throws (fail-closed) if invalid. */
export function saveSpecFile(root: string, spec: AgentSpec): void {
  const v = validateSpec(spec);
  if (!v.ok) throw new Error(`refusing to save invalid agent spec: ${v.errors.join("; ")}`);
  assertSecretFree(v.spec!); // P-AGENT.8: never persist a spec that embeds a secret
  const id = safeId(spec.spec_id);
  if (!id) throw new Error(`invalid spec_id: ${String(spec.spec_id)}`);
  mkdirSync(agentsDir(root), { recursive: true });
  writeFileSync(specFile(root, id), JSON.stringify(spec, null, 2));
  // P-AGENT.17: revision snapshot, keyed by updated_at (the canvas bumps it on every edit — identical
  // timestamps are re-saves of the same revision and simply overwrite). History is best-effort provenance:
  // a snapshot/prune failure NEVER fails the save that matters.
  try {
    const dir = historyDir(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${spec.updated_at}.json`), JSON.stringify(spec, null, 2));
    const snaps = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort((a, b) => Number.parseInt(b) - Number.parseInt(a));
    for (const stale of snaps.slice(SPEC_HISTORY_KEEP)) rmSync(join(dir, stale));
  } catch {
    /* provenance only */
  }
}

export interface SpecRevisionSummary {
  updated_at: number;
  name: string;
  nodes: number;
  edges: number;
}

/** P-AGENT.17: list a spec's revisions, newest first. Corrupted snapshots are skipped, never fatal. */
export function listSpecHistory(root: string, id: string): SpecRevisionSummary[] {
  const sid = safeId(id);
  if (!sid) return [];
  let files: string[];
  try {
    files = readdirSync(historyDir(root, sid)).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out: SpecRevisionSummary[] = [];
  for (const f of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(historyDir(root, sid), f), "utf8"));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const s = parsed as Record<string, unknown>;
    if (typeof s.name !== "string" || typeof s.updated_at !== "number" || !Array.isArray(s.nodes) || !Array.isArray(s.edges)) continue;
    out.push({ updated_at: s.updated_at, name: s.name, nodes: s.nodes.length, edges: s.edges.length });
  }
  return out.sort((a, b) => b.updated_at - a.updated_at);
}

/** P-AGENT.17: load ONE full revision (fully re-validated — a corrupted snapshot is never restored). */
export function loadSpecRevision(root: string, id: string, updatedAt: number): AgentSpec | null {
  const sid = safeId(id);
  if (!sid || !Number.isInteger(updatedAt) || updatedAt <= 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(historyDir(root, sid), `${updatedAt}.json`), "utf8"));
  } catch {
    return null;
  }
  const v = validateSpec(parsed);
  return v.ok ? v.spec! : null;
}

/** Load + re-validate a spec by id. Returns null if absent, unreadable, or invalid (a corrupted file is
 *  never returned as a valid spec). Reads directly in try/catch — no existsSync-then-read (CodeQL TOCTOU). */
export function loadSpecFile(root: string, id: string): AgentSpec | null {
  const sid = safeId(id);
  if (!sid) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(specFile(root, sid), "utf8"));
  } catch {
    return null;
  }
  const v = validateSpec(parsed);
  return v.ok ? v.spec! : null;
}

/** List valid stored specs (metadata only), newest first. Corrupted files are skipped, not fatal. */
export function listSpecFiles(root: string): SpecFileSummary[] {
  let files: string[];
  try {
    files = readdirSync(agentsDir(root)).filter((f) => f.endsWith(".json") && !f.endsWith(".trust.json"));
  } catch {
    return []; // no agents dir yet
  }
  const out: SpecFileSummary[] = [];
  for (const f of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(agentsDir(root), f), "utf8"));
    } catch {
      continue;
    }
    const v = validateSpec(parsed);
    if (v.ok && v.spec) {
      const trust = loadSpecTrust(root, v.spec.spec_id);
      out.push({
        spec_id: v.spec.spec_id,
        name: v.spec.name,
        mode: v.spec.mode,
        self_edit: v.spec.selfEdit,
        updated_at: v.spec.updated_at,
        trust_label: trust.trustLabel,
        trust_reason: trust.reason,
      });
    }
  }
  return out.sort((a, b) => b.updated_at - a.updated_at);
}

const TRUST_LABELS: Record<TrustLabel, true> = { trusted: true, untrusted: true, suspicious: true, quarantined: true };

/** Store provenance/trust metadata OUTSIDE the AgentSpec so portable specs remain pure. */
export function saveSpecTrust(root: string, id: string, trust: SpecTrustRecord): void {
  const sid = safeId(id);
  if (!sid) throw new Error(`invalid spec_id: ${String(id)}`);
  if (!TRUST_LABELS[trust.trustLabel]) throw new Error(`invalid trust label: ${String(trust.trustLabel)}`);
  mkdirSync(agentsDir(root), { recursive: true });
  writeFileSync(trustFile(root, sid), JSON.stringify(trust, null, 2));
}

/** Load trust metadata. Missing sidecar = trusted local legacy spec. */
export function loadSpecTrust(root: string, id: string): SpecTrustRecord {
  const sid = safeId(id);
  if (!sid) return { trustLabel: "quarantined", reason: "invalid spec id" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(trustFile(root, sid), "utf8"));
  } catch {
    return { trustLabel: "trusted", reason: "locally authored or legacy spec" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { trustLabel: "quarantined", reason: "invalid trust sidecar" };
  const r = parsed as Record<string, unknown>;
  const label = r.trustLabel;
  const reason = r.reason;
  const reviewedAt = r.reviewed_at;
  if (typeof label !== "string" || !(label in TRUST_LABELS)) return { trustLabel: "quarantined", reason: "invalid trust sidecar" };
  return {
    trustLabel: label as TrustLabel,
    reason: typeof reason === "string" ? reason : "stored trust metadata",
    ...(typeof reviewedAt === "number" ? { reviewed_at: reviewedAt } : {}),
  };
}

/** Delete a spec file by id. Returns true if a file was removed. */
export function deleteSpecFile(root: string, id: string): boolean {
  const sid = safeId(id);
  if (!sid) return false;
  try {
    rmSync(specFile(root, sid));
    try { rmSync(trustFile(root, sid)); } catch { /* no trust sidecar */ }
    return true;
  } catch {
    return false;
  }
}
