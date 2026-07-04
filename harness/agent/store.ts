// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/store.ts — P-AGENT.1 (ADR-0129): persist Agent Specs to DuckDB (migration 0010), fail-closed.
//
// Two fail-closed gates around the frozen `agent_specs` table:
//   • saveSpec REFUSES to persist a spec that doesn't pass validateSpec (a malformed/adversarial spec never
//     reaches the table).
//   • loadSpec RE-VALIDATES on the way out, so a row that was corrupted on disk is not returned as a valid
//     spec (returns null instead). The stored `json` column is the single source of truth; the flat columns
//     are denormalized for listing only.
//
// `trust_label` records provenance: a spec authored locally is "trusted"; a spec imported from an external
// source is stored "untrusted"/"suspicious" and later increments block auto-running it.

import type { Db } from "../memory/db.ts";
import type { TrustLabel } from "../contracts.ts";
import { validateSpec, type AgentSpec } from "./spec.ts";
import { assertSecretFree } from "./secret_guard.ts";

export interface SpecSummary {
  spec_id: string;
  name: string;
  mode: string;
  self_edit: string;
  trust_label: string;
  updated_at: string;
}

/** Validate then upsert a spec. Throws (fail-closed) if the spec is invalid — an invalid spec is never
 *  persisted. `trust` defaults to "trusted" (locally authored); imported specs pass their scanned label. */
export async function saveSpec(db: Db, spec: AgentSpec, trust: TrustLabel = "trusted"): Promise<void> {
  const v = validateSpec(spec);
  if (!v.ok) throw new Error(`refusing to persist invalid agent spec: ${v.errors.join("; ")}`);
  assertSecretFree(v.spec!); // P-AGENT.8: never persist a spec that embeds a secret
  await db.run(
    `INSERT INTO agent_specs
       (spec_id, name, spec_version, mode, self_edit, trust_label, json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (spec_id) DO UPDATE SET
       name = EXCLUDED.name,
       spec_version = EXCLUDED.spec_version,
       mode = EXCLUDED.mode,
       self_edit = EXCLUDED.self_edit,
       trust_label = EXCLUDED.trust_label,
       json = EXCLUDED.json,
       updated_at = EXCLUDED.updated_at`,
    [
      spec.spec_id,
      spec.name,
      spec.spec_version,
      spec.mode,
      spec.selfEdit,
      trust,
      JSON.stringify(spec),
      new Date(spec.created_at).toISOString(),
      new Date(spec.updated_at).toISOString(),
    ],
  );
}

/** Load a spec by id, re-validated fail-closed. Returns null if absent OR if the stored row won't parse /
 *  validate (a corrupted spec is never returned as valid). */
export async function loadSpec(db: Db, specId: string): Promise<AgentSpec | null> {
  const row = await db.get("SELECT json FROM agent_specs WHERE spec_id = $1", [specId]);
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.json));
  } catch {
    return null;
  }
  const v = validateSpec(parsed);
  return v.ok ? v.spec! : null;
}

/** List stored specs (metadata only), newest first. */
export async function listSpecs(db: Db): Promise<SpecSummary[]> {
  const rows = await db.all(
    "SELECT spec_id, name, mode, self_edit, trust_label, updated_at FROM agent_specs ORDER BY updated_at DESC",
  );
  return rows.map((r) => ({
    spec_id: String(r.spec_id),
    name: String(r.name),
    mode: String(r.mode),
    self_edit: String(r.self_edit),
    trust_label: String(r.trust_label),
    updated_at: String(r.updated_at),
  }));
}

/** Delete a spec by id. Returns true if a row was removed. */
export async function deleteSpec(db: Db, specId: string): Promise<boolean> {
  const before = await db.get("SELECT 1 AS n FROM agent_specs WHERE spec_id = $1", [specId]);
  if (!before) return false;
  await db.run("DELETE FROM agent_specs WHERE spec_id = $1", [specId]);
  return true;
}
