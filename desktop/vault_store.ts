// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/vault_store.ts
//
// P-VAULT-V2.1 (ADR-0474): Contract B, the ONE engine-side vault API. Every secret the engine holds lives
// in the engine vault of the current settings file (engine_vault.ts, `keyVaultDir()`): the settings keys
// (P-VAULT-KEYS.1), the credentials that used to sit in Electron's safeStorage vault (migrated by main
// through vault_routes.ts), and every new credential. This module is the facade later slices call
// (vault UI, secret intake, .env import, destinations, compliance evidence); engine_vault.ts stays the
// directory-level sealing layer underneath it.
//
// Engine-only (Bun). Values leave this module only through vaultGet / vaultExportEntries, which are
// ENGINE-INTERNAL: nothing here is ever serialized onto an HTTP response (vault_routes.ts returns
// VaultEntryMeta and CredView only). Every write throws on failure, so a caller never mistakes a refusal
// for a stored secret, and nothing here writes a plaintext secret anywhere.

import { cryptoInfo, sha256, type CryptoProviderInfo } from "../harness/crypto/fips_crypto.ts"; // P-FIPS.1 (ADR-0473)
import type { CredView } from "./cred_engine_client.ts";
import { isValidRef } from "./cred_vault.ts";
import {
  isEnvName, metaOf, mutateVault, readVault, VAULT_KINDS, VAULT_SOURCES, vaultStatus as dirVaultStatus,
  type VaultEntryMeta, type VaultKind, type VaultMetaPatch, type VaultRead, type VaultSource, type VaultStatus,
} from "./engine_vault.ts";
import { keyVaultDir } from "./settings_store.ts";

export type { VaultEntryMeta, VaultKind, VaultSource, VaultStatus } from "./engine_vault.ts";

export interface VaultPutInput {
  ref: string; value: string; kind: VaultKind; label?: string; source: VaultSource;
  scope?: { workspace?: string }; envName?: string; expiresAt?: number; rotationIntervalDays?: number;
}
export type VaultExportEntry = VaultEntryMeta & { value: string };

/** Vault refs: `key:<ENV>`, `account:<id>`, `mcp:<id>`, `turn:credential`, `ws:<hash>:<ENV>`,
 *  `oauth:<provider>:<identityKey>`, `kg:dek:<storeId>`, and the legacy safeStorage names (`figma_pat`,
 *  `git_pat_<host>`, `cred_<kind>_...`). A bounded charset: no whitespace, no path separators. */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/;
export const isVaultRef = (ref: unknown): ref is string => typeof ref === "string" && REF_RE.test(ref);
const isKind = (k: unknown): k is VaultKind => VAULT_KINDS.some((x) => x === k);
const isSource = (s: unknown): s is VaultSource => VAULT_SOURCES.some((x) => x === s);
const finite = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) ? n : undefined);

/** The readable vault, or a thrown refusal naming why it is not readable (a write that depends on what
 *  the vault holds must never act on an unreadable one). */
function readable(): VaultRead {
  const v = readVault(keyVaultDir());
  if (v.problem) throw new Error(`the vault is unreadable: ${v.problem}`);
  return v;
}

/** Every entry's metadata (never a value), by ref. Empty when the vault is absent or unreadable
 *  (vaultStatus() says which). */
export function vaultList(): VaultEntryMeta[] {
  return Object.values(readVault(keyVaultDir()).entries).map(metaOf).sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Store (insert or replace) one secret. A ref that exists keeps its source and addedAt; a changed value
 *  stamps rotatedAt. Throws on any failure (no backend, unreadable master key, FIPS refusal, a failed or
 *  unverified write): fail-closed, never a plaintext fallback. */
export function vaultPut(input: VaultPutInput): VaultEntryMeta {
  const { ref, value } = input;
  if (!isVaultRef(ref)) throw new Error("invalid vault ref");
  if (typeof value !== "string" || !value) throw new Error("refusing to store an empty value");
  if (!isKind(input.kind)) throw new Error("unknown secret kind");
  if (!isSource(input.source)) throw new Error("unknown secret source");
  if (input.envName !== undefined && !isEnvName(input.envName)) throw new Error("invalid environment variable name");
  const patch: VaultMetaPatch = {
    kind: input.kind,
    label: typeof input.label === "string" && input.label.trim() ? input.label.trim() : undefined,
    scope: input.scope?.workspace ? { workspace: input.scope.workspace } : undefined,
    envName: input.envName,
    expiresAt: finite(input.expiresAt),
    rotationIntervalDays: finite(input.rotationIntervalDays),
  };
  const entries = mutateVault(keyVaultDir(), (current) => {
    const prev = current[ref];
    const rotated = prev && prev.value !== value ? { rotatedAt: Date.now() } : {};
    return { set: { [ref]: value }, del: [], meta: { [ref]: { ...patch, ...rotated } }, source: input.source };
  });
  const stored = entries[ref];
  if (!stored || stored.value !== value) throw new Error("the vault did not keep the value");
  return metaOf(stored);
}

/** Replace the value of an EXISTING ref in place (same ref, kind, label, addedAt; rotatedAt = now).
 *  Null when the ref is not in the vault. Throws on any failure, the old value left untouched. */
export function vaultRotate(ref: string, value: string, opts: { expiresAt?: number } = {}): VaultEntryMeta | null {
  if (!isVaultRef(ref)) return null;
  if (typeof value !== "string" || !value) throw new Error("refusing to store an empty value");
  if (!readable().entries[ref]) return null;
  let found = false;
  const entries = mutateVault(keyVaultDir(), (current) => {
    found = !!current[ref];
    if (!found) return { set: {}, del: [] };
    const expiresAt = finite(opts.expiresAt);
    return { set: { [ref]: value }, del: [], meta: { [ref]: { rotatedAt: Date.now(), ...(expiresAt !== undefined ? { expiresAt } : {}) } } };
  });
  if (!found) return null;
  const stored = entries[ref];
  if (!stored || stored.value !== value) throw new Error("the vault did not keep the value");
  return metaOf(stored);
}

/** Delete one ref. False when it was not there. Throws (changing nothing) when the vault is unreadable. */
export function vaultDelete(ref: string): boolean {
  if (!isVaultRef(ref)) return false;
  if (!readable().entries[ref]) return false;
  let found = false;
  mutateVault(keyVaultDir(), (current) => {
    found = !!current[ref];
    return { set: {}, del: found ? [ref] : [] };
  });
  return found;
}

/** ENGINE-INTERNAL ONLY: the plaintext of one ref (undefined when absent or the vault is unreadable).
 *  Never put this on an HTTP response, a log line, an event or a transcript. */
export function vaultGet(ref: string): string | undefined {
  return readVault(keyVaultDir()).entries[ref]?.value;
}

/** Backup path only (P-VAULT-UI.1): every entry with its value. Throws when the vault is unreadable, so
 *  a backup can never silently come out empty. */
export function vaultExportEntries(): VaultExportEntry[] {
  return Object.values(readable().entries).map((e) => ({ ...e })).sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Restore path: merge entries into the vault in one locked write. `newer-wins`: a ref the vault lacks is
 *  added, one whose incoming updatedAt is later replaces it, anything else is skipped. Incoming metadata
 *  (source, dates, label, scope) is kept as given. Throws on a malformed entry before writing anything. */
export function vaultImportEntries(entries: VaultExportEntry[], policy: "newer-wins"): { added: number; updated: number; skipped: number } {
  if (policy !== "newer-wins") throw new Error(`unknown import policy ${String(policy)}`);
  for (const e of entries) {
    if (!e || !isVaultRef(e.ref) || typeof e.value !== "string" || !e.value || !isKind(e.kind)) throw new Error("malformed vault entry in the import");
  }
  const counts = { added: 0, updated: 0, skipped: 0 };
  mutateVault(keyVaultDir(), (current) => {
    counts.added = 0; counts.updated = 0; counts.skipped = 0;
    const set: Record<string, string> = {};
    const meta: Record<string, VaultMetaPatch> = {};
    for (const e of entries) {
      const prev = current[e.ref];
      const incomingAt = finite(e.updatedAt) ?? 0;
      if (prev && !(incomingAt > prev.updatedAt)) { counts.skipped++; continue; }
      if (prev) counts.updated++; else counts.added++;
      const { ref, value: _value, last4: _last4, ...rest } = e;
      set[ref] = e.value;
      meta[ref] = rest;
    }
    return { set, del: [], meta, source: "restore" };
  });
  return counts;
}

/** `ws:<first 16 hex of sha256(realpath, lowercased on win32)>:<ENV>`: the ref of a workspace-scoped secret. */
export function workspaceRef(workspaceRealPath: string, envName: string): string {
  if (!isEnvName(envName)) throw new Error("invalid environment variable name");
  const key = process.platform === "win32" ? workspaceRealPath.toLowerCase() : workspaceRealPath;
  return `ws:${sha256(Buffer.from(key, "utf8")).toString("hex").slice(0, 16)}:${envName}`;
}

/** Custody + crypto module + entry count, for Settings, the compliance report and the logs. */
export function vaultStatus(): VaultStatus & { crypto: CryptoProviderInfo; entries: number } {
  const d = keyVaultDir();
  return { ...dirVaultStatus(d), crypto: cryptoInfo(), entries: Object.keys(readVault(d).entries).length };
}

// ── the bridge cred* shape (P-NETWL.1 / P-KEYS.2 CredMeta), served to Electron main only ─────────────

/** What `bridge.credList()` and friends have always returned (CredMeta), with createdAt = addedAt. */
export function credViewOf(m: VaultEntryMeta): CredView {
  const v: CredView = { ref: m.ref, kind: m.kind, label: m.label, createdAt: m.addedAt, rotatedAt: m.rotatedAt ?? m.addedAt };
  if (m.last4) v.last4 = m.last4;
  if (m.expiresAt !== undefined) v.expiresAt = m.expiresAt;
  if (m.rotationIntervalDays !== undefined) v.rotationIntervalDays = m.rotationIntervalDays;
  return v;
}

/** The credentials the bridge lists: refs in the legacy credential charset (the settings-owned
 *  `key:`/`account:`/`mcp:` refs and the scoped `ws:`/`oauth:`/`kg:` refs are not credentials of that UI). */
export function credList(): CredView[] {
  return vaultList().filter((m) => isValidRef(m.ref)).map(credViewOf);
}

/** Mint a credential ref exactly as cred_vault.ts did (a public handle, filename-safe). */
export function mintCredRef(kind: string, at = Date.now()): string {
  const k = String(kind).replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "other";
  return `cred_${k}_${at.toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** The non-secret fields of a legacy safeStorage CredMeta, as main reads them from `<ref>.meta.json`. */
export interface LegacyCredMeta { kind?: unknown; label?: unknown; createdAt?: unknown; rotatedAt?: unknown; expiresAt?: unknown; rotationIntervalDays?: unknown }
/** stored = written now; present = the vault already held this exact value (a re-run after a crash);
 *  On a DIFFERENT value for the ref, newer wins (security review MIGRATION-SUPERSEDED-DELETE), comparing
 *  the legacy CredMeta date (rotatedAt ?? createdAt) with the entry's updatedAt: replaced = the legacy value
 *  was newer and now holds the ref; superseded = the engine value is as new or newer (or the legacy copy
 *  carries no date) and stays. Either way the vault holds the winner before main deletes the source. */
export type LegacyImportOutcome = "stored" | "present" | "replaced" | "superseded";

/** Migration step for ONE safeStorage credential (main hands it over; vault_routes.ts main-only route).
 *  Same ref, CredMeta fields kept (createdAt -> addedAt), source "migrated-safestorage". Refuses unless
 *  the vault is `ok` (a background migration never sets an unreadable vault aside), and verifies by
 *  reading the vault back (it must hold the winning value) before reporting success: main deletes the
 *  source only after that. */
export function importLegacyCredential(ref: string, value: string, legacy: LegacyCredMeta): { outcome: LegacyImportOutcome; meta: VaultEntryMeta } {
  if (!isValidRef(ref)) throw new Error("invalid credential ref");
  if (typeof value !== "string" || !value) throw new Error("refusing to store an empty value");
  const status = dirVaultStatus(keyVaultDir());
  if (status.state !== "ok") throw new Error(`the engine vault is ${status.state}${status.detail ? ` (${status.detail})` : ""}`);
  const now = Date.now();
  const addedAt = finite(legacy.createdAt) ?? now;
  const rotatedAt = finite(legacy.rotatedAt);
  const patch: VaultMetaPatch = {
    kind: isKind(legacy.kind) ? legacy.kind : "other",
    label: typeof legacy.label === "string" && legacy.label.trim() ? legacy.label : ref,
    source: "migrated-safestorage",
    addedAt,
    updatedAt: rotatedAt ?? addedAt,
    rotatedAt,
    expiresAt: finite(legacy.expiresAt),
    rotationIntervalDays: finite(legacy.rotationIntervalDays),
  };
  const legacyAt = rotatedAt ?? finite(legacy.createdAt);
  let outcome = "stored" as LegacyImportOutcome; // assigned inside the locked plan below
  let winner = value; // the value the vault must hold afterwards
  mutateVault(keyVaultDir(), (current) => {
    const prev = current[ref];
    if (prev && prev.value === value) { outcome = "present"; return { set: {}, del: [] }; }
    if (prev && !(legacyAt !== undefined && legacyAt > prev.updatedAt)) { outcome = "superseded"; winner = prev.value; return { set: {}, del: [] }; }
    outcome = prev ? "replaced" : "stored";
    // A replaced entry keeps its own addedAt and source; the legacy dates say when this value was set.
    const meta: VaultMetaPatch = prev ? { ...patch, addedAt: prev.addedAt, source: prev.source, updatedAt: legacyAt } : patch;
    return { set: { [ref]: value }, del: [], meta: { [ref]: meta }, source: "migrated-safestorage" };
  });
  const back = readVault(keyVaultDir());
  const entry = back.entries[ref];
  if (back.problem || !entry || entry.value !== winner) throw new Error("the vault did not read back the migrated credential");
  return { outcome, meta: metaOf(entry) };
}
