// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_mailbox.ts - the same-machine handoff mailbox for Creator endpoints.
//
// The DGX Loader writes <personal dir>/creator_endpoints/<id>.json (lucid-creator-endpoint v1); LUCID scans
// it at engine start and on POST /api/creator/endpoint/import-mailbox. Same posture as the voice mailbox in
// dev.ts: per-file fail-soft (one malformed file is reported by name and skipped, never fatal) and NOTHING is
// imported without passing the fail-closed contract gate AND the registry's own declaration validation.
//
// An imported declaration is zone "internal" with `enclave: true`: the Loader is attesting a DGX enclave
// host, which is what lets it through the CUI lockdown. A re-scan never re-enables an endpoint the user
// switched off, and never lets a file claim an id that belongs to another provider's declaration.

import { parseCreatorEndpointConfig, type CreatorEndpointConfig } from "../harness/creator/creator_endpoint.ts";
import type { CreatorEndpointDef } from "./creator_registry.ts";

export interface CreatorMailboxIo {
  /** File names in the mailbox; throws when the directory does not exist yet. */
  listJson(dir: string): string[];
  readText(path: string): string;
  /** The current declarations. */
  endpoints(): CreatorEndpointDef[];
  /** Validates and stores one declaration (settings_store.upsertCreatorEndpoint). */
  upsert(def: CreatorEndpointDef): { ok: boolean; errors: string[] };
}

export interface CreatorMailboxReport {
  imported: string[];
  rejected: { file: string; reason: string }[];
}

/** The declaration an imported document becomes (contract section 3). */
export function creatorEndpointFromConfig(cfg: CreatorEndpointConfig, enabled = true): CreatorEndpointDef {
  return { id: cfg.id, providerId: cfg.provider, label: cfg.label, baseUrl: cfg.url, zone: "internal", enclave: true, enabled };
}

export function scanCreatorMailbox(io: CreatorMailboxIo, dir: string): CreatorMailboxReport {
  const report: CreatorMailboxReport = { imported: [], rejected: [] };
  let files: string[];
  try { files = io.listJson(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return report; } // no mailbox yet
  for (const file of files) {
    let parsed: unknown;
    try { parsed = JSON.parse(io.readText(`${dir}/${file}`)); }
    catch { report.rejected.push({ file, reason: "unreadable or not JSON" }); continue; }
    const r = parseCreatorEndpointConfig(parsed);
    if (!r.ok) { report.rejected.push({ file, reason: r.reason }); continue; }
    const existing = io.endpoints().find((e) => e.id === r.config.id);
    if (existing && existing.providerId !== r.config.provider) {
      report.rejected.push({ file, reason: `id "${r.config.id}" already names a ${existing.providerId} endpoint; rename one of them` });
      continue;
    }
    if (existing && existing.baseUrl === r.config.url && existing.enclave === true && existing.zone === "internal" && existing.label === r.config.label) continue; // already current
    const def = creatorEndpointFromConfig(r.config, existing ? existing.enabled : true);
    const saved = io.upsert(def);
    if (!saved.ok) { report.rejected.push({ file, reason: saved.errors.join("; ") }); continue; }
    report.imported.push(def.id);
  }
  return report;
}
