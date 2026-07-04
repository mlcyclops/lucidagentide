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

const agentsDir = (root: string): string => join(root, ".omp", "agents");
const specFile = (root: string, id: string): string => join(agentsDir(root), `${id}.json`);

export interface SpecFileSummary {
  spec_id: string;
  name: string;
  mode: string;
  self_edit: string;
  updated_at: number;
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
    files = readdirSync(agentsDir(root)).filter((f) => f.endsWith(".json"));
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
    if (v.ok && v.spec)
      out.push({
        spec_id: v.spec.spec_id,
        name: v.spec.name,
        mode: v.spec.mode,
        self_edit: v.spec.selfEdit,
        updated_at: v.spec.updated_at,
      });
  }
  return out.sort((a, b) => b.updated_at - a.updated_at);
}

/** Delete a spec file by id. Returns true if a file was removed. */
export function deleteSpecFile(root: string, id: string): boolean {
  const sid = safeId(id);
  if (!sid) return false;
  try {
    rmSync(specFile(root, sid));
    return true;
  } catch {
    return false;
  }
}
