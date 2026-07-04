// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/local_providers_runtime.ts — P-LOCAL.2 (ADR-0135): main-process delivery of Local Providers to omp.
//
// At `omp acp` launch LUCID (1) writes the enabled providers into omp's custom-provider registry
// (~/.omp/agent/models.yml) so the models appear + route, (2) returns the child-env the omp process needs
// (the secret is looked up from the OS-encrypted vault here and set ONLY on the omp child; models.yml holds
// an env-var NAME, never the value), and (3) registers each endpoint in the network whitelist.
//
// The vault read is INJECTED (`readSecret`) so this module never imports Electron: main.ts passes a
// cred_vault-backed reader; the dev server passes none (authed providers are then skipped, open ones work).
// The models.yml write is SAFE: it preserves every provider LUCID didn't author, drops providers LUCID
// previously wrote but no longer has (via a sidecar id list), and REFUSES to overwrite a file it can't parse
// (a hand-authored YAML) rather than destroy user content.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { egressProposal, toOmpRuntimeOverlay, type LocalProviderDef, type OmpConfigOverlay } from "./local_providers.ts";
import { loadWhitelist, saveWhitelist, upsertEntry, type WhitelistEntry } from "./network_whitelist.ts";

/** omp's custom-provider registry. Primary is `models.yml` (JSON is valid YAML, so LUCID writes JSON there).
 *  `LUCID_OMP_MODELS_YAML` relocates it for tests — never set in production. */
export function modelsYamlPath(): string {
  return process.env.LUCID_OMP_MODELS_YAML || join(homedir(), ".omp", "agent", "models.yml");
}
/** Sidecar tracking which provider ids LUCID authored, so removed providers drop out of models.yml without
 *  writing any LUCID marker into omp's own file. Lives beside models.yml. */
function managedIdsPath(): string {
  return join(dirname(modelsYamlPath()), ".lucid-local-managed.json");
}

export interface MergeResult { ok: boolean; content?: string; managedIds?: string[]; reason?: string; preserved: number }

/** PURE merge of LUCID's provider overlay into any existing models.yml JSON. Drops the previously-managed
 *  ids first (so a provider removed from LUCID disappears, and stale entries are cleaned), then writes the
 *  current ones — preserving every non-LUCID provider. Refuses (ok:false) to overwrite a non-empty file it
 *  can't parse as JSON (a hand-authored YAML): user content is never destroyed. */
export function mergeModelsYaml(existingText: string, overlay: OmpConfigOverlay, prevManagedIds: string[]): MergeResult {
  const ourIds = Object.keys(overlay.providers);
  const trimmed = (existingText ?? "").trim();
  let base: Record<string, unknown> = {};
  if (trimmed) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); }
    catch { return { ok: false, reason: "existing ~/.omp/agent/models.yml is not LUCID-managed (unparseable as JSON); refusing to overwrite", preserved: 0 }; }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return { ok: false, reason: "existing models.yml is not a JSON object; refusing to overwrite", preserved: 0 };
    base = parsed as Record<string, unknown>;
  }
  const providers: Record<string, unknown> = { ...((base.providers as Record<string, unknown>) ?? {}) };
  for (const id of prevManagedIds) delete providers[id]; // drop previously-managed (incl. now-removed)
  const preserved = Object.keys(providers).length; // whatever remains is non-LUCID and is kept
  for (const [id, entry] of Object.entries(overlay.providers)) providers[id] = entry;
  return { ok: true, content: JSON.stringify({ ...base, providers }, null, 2), managedIds: ourIds, preserved };
}

function readTextSafe(p: string): string { try { return existsSync(p) ? readFileSync(p, "utf8") : ""; } catch { return ""; } }
function readManagedIds(): string[] {
  try { const a = JSON.parse(readTextSafe(managedIdsPath()) || "[]"); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; }
  catch { return []; }
}

export interface MaterializeResult {
  childEnv: Record<string, string>; // env vars to set on the omp CHILD (name -> secret); never on LUCID's own env
  included: string[];
  skipped: { id: string; reason: string }[];
  wrote: boolean;
  writeReason?: string;
}

/** Resolve secrets from the vault, safely write the merged models.yml, and return the env the omp child
 *  needs. `readSecret` is injected (Electron vault in main; a no-op in dev → authed providers are skipped,
 *  fail-closed). Best-effort throughout: a vault miss or an unwritable/foreign models.yml degrades that
 *  provider, never the whole launch. */
export function materializeLocalProviders(opts: { defs: LocalProviderDef[]; readSecret: (ref: string) => string | null }): MaterializeResult {
  const defs = opts.defs ?? [];
  const managed = readManagedIds();
  if (defs.length === 0 && managed.length === 0) return { childEnv: {}, included: [], skipped: [], wrote: false };
  // Resolve which vault refs actually yield a secret (only those providers can be emitted authed).
  const refSecret = new Map<string, string>();
  for (const d of defs) {
    if (d.enabled && d.authKind !== "none" && d.vaultRef && !refSecret.has(d.vaultRef)) {
      let s: string | null = null;
      try { s = opts.readSecret(d.vaultRef); } catch { s = null; }
      if (s) refSecret.set(d.vaultRef, s);
    }
  }
  const { overlay, env, included, skipped } = toOmpRuntimeOverlay(defs, new Set(refSecret.keys()));
  const merge = mergeModelsYaml(readTextSafe(modelsYamlPath()), overlay, managed);
  let wrote = false; let writeReason: string | undefined = merge.ok ? undefined : merge.reason;
  if (merge.ok && merge.content !== undefined) {
    try {
      mkdirSync(dirname(modelsYamlPath()), { recursive: true });
      writeFileSync(modelsYamlPath(), merge.content, { mode: 0o600 });
      writeFileSync(managedIdsPath(), JSON.stringify(merge.managedIds ?? []), { mode: 0o600 });
      wrote = true;
    } catch (e) { writeReason = String((e as Error)?.message ?? e); }
  }
  const childEnv: Record<string, string> = {};
  for (const [name, ref] of Object.entries(env)) { const s = refSecret.get(ref); if (s) childEnv[name] = s; }
  return { childEnv, included, skipped, wrote, writeReason };
}

/** Map a Local Provider's auth kind to the whitelist AuthRef kind (closed set). */
function authRefKind(k: LocalProviderDef["authKind"]): "apikey" | "basic" {
  return k === "basic" ? "basic" : "apikey"; // bearer/apikey are both API-token style
}

/** PURE: the whitelist entry an enabled provider needs (stable id `lp_<id>`, AuthRef→vault). Null when
 *  disabled or the base URL can't be parsed. */
export function localProviderEgressEntry(d: LocalProviderDef, now: number): WhitelistEntry | null {
  if (!d.enabled) return null;
  const prop = egressProposal(d);
  if (!prop) return null;
  return {
    id: `lp_${d.id}`,
    kind: prop.kind,
    pattern: prop.pattern,
    zone: prop.zone,
    scope: "always",
    addedAt: now,
    auth: prop.vaultRef ? { kind: authRefKind(d.authKind), vaultRef: prop.vaultRef, note: `Local Provider · ${d.name}` } : null,
  };
}

/** Register each enabled provider's endpoint in the network whitelist (idempotent). Returns the number upserted. */
export function registerLocalProviderEgress(defs: LocalProviderDef[], now: number): number {
  let store = loadWhitelist();
  let n = 0;
  for (const d of defs) {
    const entry = localProviderEgressEntry(d, now);
    if (!entry) continue;
    store = upsertEntry(store, entry);
    n++;
  }
  if (n) saveWhitelist(store);
  return n;
}
