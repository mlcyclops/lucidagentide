// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/cred_engine_client.ts
//
// P-VAULT-V2.1 (ADR-0474): Electron main's side of the one credential store. Electron `safeStorage` is not
// a FIPS 140-validated module, so credentials move into the engine vault (engine_vault.ts, sealed with
// AES-256-GCM through harness/crypto/fips_crypto.ts under an OS-held master key). Main never opens that
// vault (it runs as a --target=node bundle); it talks to the engine's main-only routes in vault_routes.ts
// with the UI token plus the per-launch vault token it minted (LUCID_VAULT_MAIN_TOKEN).
//
// Migration ordering (crash-safe, idempotent, nothing lost if the engine is down):
//   1. At spawn main still injects env from safeStorage exactly as before (cred_env.ts), so the first boot
//      after the upgrade works with every credential where it was.
//   2. Once the engine answers its health check, for each `<ref>.bin` in the cred vault: main decrypts it,
//      POSTs { ref, value, meta } to /api/vault/main/import; the engine stores it (same ref, CredMeta
//      fields, source "migrated-safestorage") and reads it back before answering `verified: true`.
//   3. Only after that answer does main delete the `.bin` (and its `.meta.json`). A crash anywhere before
//      the delete leaves the source in place; the next run imports it again, the engine answers "present"
//      (same value, nothing rewritten), and the delete happens then.
//   4. A `migrated-<ts>.json` marker (refs only, never values) records each run that moved something.
// An entry that cannot be decrypted, or that the engine refuses, stays in safeStorage and keeps being
// injected by main. New credentials (bridge.credStore & co.) go to the engine only: there is no
// safeStorage fallback, a refusal is surfaced as { error }.
//
// Node-safe (fetch + cred_vault.ts only): no Electron import, so it unit-tests with fakes.

import {
  deleteCredential, isValidRef, listCredentials, readCredential, type CredMeta, type SafeStorageLike, type VaultIo,
} from "./cred_vault.ts";

/** The bridge cred* metadata shape (renderer CredMetaView). */
export interface CredView { ref: string; kind: string; label?: string; last4?: string; createdAt?: number; rotatedAt?: number; expiresAt?: number; rotationIntervalDays?: number }
export interface EngineVaultStatus { available: boolean; custody: string; state: string; fips: boolean; entries: number }
export interface StoreInput { ref?: string; kind: string; secret: string; label?: string; expiresAt?: number; rotationIntervalDays?: number }
export interface RotateInput { ref: string; secret: string; expiresAt?: number }
export interface ImportItem { ref: string; value: string; meta: Partial<CredMeta> }
export interface ImportResult { ref: string; outcome: "stored" | "present" | "superseded"; verified: boolean }

export interface EngineVaultLink {
  /** e.g. `http://localhost:<PORT>` */
  baseUrl: string;
  /** The engine's UI token (main mints it: LUCID_MAIN_TOKEN). */
  uiToken: string;
  /** The main-only vault token (LUCID_VAULT_MAIN_TOKEN). */
  vaultToken: string;
  fetch?: typeof fetch;
}

/** A request the engine answered with `{ ok: false }` (or not at all). `status` 0 = no answer. */
export class EngineVaultError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "EngineVaultError"; }
}

export interface EngineCredClient {
  status(): Promise<EngineVaultStatus>;
  list(): Promise<CredView[]>;
  store(input: StoreInput): Promise<CredView>;
  /** Null when the engine vault has no such ref. */
  rotate(input: RotateInput): Promise<CredView | null>;
  remove(ref: string): Promise<boolean>;
  importLegacy(item: ImportItem): Promise<ImportResult>;
}

export function engineCredClient(link: EngineVaultLink): EngineCredClient {
  const doFetch = link.fetch ?? fetch;
  async function call<T>(path: string, payload?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${link.baseUrl}/api/vault/main/${path}`, {
        method: payload === undefined ? "GET" : "POST",
        headers: { "x-lucid-token": link.uiToken, "x-lucid-vault-token": link.vaultToken, "content-type": "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new EngineVaultError(`the engine vault is not reachable (${String((e as Error)?.message ?? e).slice(0, 120)})`, 0);
    }
    const parsed: unknown = await res.json().catch(() => null);
    const body = parsed && typeof parsed === "object" ? (parsed as { ok?: unknown; data?: unknown; error?: unknown }) : {};
    if (!res.ok || body.ok !== true) throw new EngineVaultError(typeof body.error === "string" ? body.error : `engine vault answered ${res.status}`, res.status);
    return body.data as T;
  }
  return {
    status: () => call<EngineVaultStatus>("status"),
    list: () => call<CredView[]>("list"),
    store: (input) => call<CredView>("store", input),
    rotate: async (input) => {
      try { return await call<CredView>("rotate", input); } catch (e) {
        if (e instanceof EngineVaultError && e.status === 404) return null;
        throw e;
      }
    },
    remove: async (ref) => (await call<{ deleted: boolean }>("delete", { ref })).deleted === true,
    importLegacy: (item) => call<ImportResult>("import", item),
  };
}

/** The safeStorage credential vault main still reads: Electron's SafeStorageLike, node:fs and the root
 *  (`~/.omp/lucid-cred-vault`, or the Creator flavor's own root inside its userData). */
export interface LegacyCredVault { ss: SafeStorageLike; io: VaultIo; dir: string }

export interface MigrationReport {
  /** Refs whose safeStorage source was deleted after the engine verified it. */
  migrated: string[];
  /** Refs left in safeStorage, with why (never a value). */
  kept: Array<{ ref: string; reason: string }>;
  /** The marker written for this run, when something moved. */
  marker?: string;
}

function legacyMeta(v: LegacyCredVault, ref: string): Partial<CredMeta> {
  try {
    const m: unknown = JSON.parse(v.io.readFile(`${v.dir}/${ref}.meta.json`).toString("utf8"));
    return m && typeof m === "object" ? (m as Partial<CredMeta>) : {};
  } catch { return {}; }
}

/** Refs that still have a `.bin` in the safeStorage vault. */
export function legacyRefs(v: LegacyCredVault): string[] {
  let names: string[] = [];
  try { names = v.io.list(v.dir); } catch { return []; }
  return names.filter((n) => n.endsWith(".bin")).map((n) => n.slice(0, -".bin".length)).filter(isValidRef).sort();
}

/** Move every safeStorage credential into the engine vault, in the order the header describes. Never
 *  throws; safe to run on every launch (an emptied vault is a no-op). */
export async function migrateCredVault(v: LegacyCredVault, client: EngineCredClient, now: () => number = Date.now): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: [], kept: [] };
  const refs = legacyRefs(v);
  if (refs.length === 0) return report;
  try {
    const st = await client.status();
    if (!st.available) {
      for (const ref of refs) report.kept.push({ ref, reason: `engine vault ${st.state}` });
      return report;
    }
  } catch (e) {
    for (const ref of refs) report.kept.push({ ref, reason: String((e as Error)?.message ?? e).slice(0, 160) });
    return report;
  }
  for (const ref of refs) {
    const value = readCredential(v.ss, v.io, v.dir, ref);
    if (!value) { report.kept.push({ ref, reason: "safeStorage could not decrypt it" }); continue; }
    let r: ImportResult;
    try { r = await client.importLegacy({ ref, value, meta: legacyMeta(v, ref) }); } catch (e) {
      report.kept.push({ ref, reason: String((e as Error)?.message ?? e).slice(0, 160) });
      continue;
    }
    if (r.verified !== true || r.ref !== ref) { report.kept.push({ ref, reason: "the engine did not confirm it" }); continue; }
    deleteCredential(v.io, v.dir, ref); // only now: the engine holds it and read it back
    if (v.io.exists(`${v.dir}/${ref}.bin`)) { report.kept.push({ ref, reason: "the safeStorage copy could not be removed" }); continue; }
    report.migrated.push(ref);
  }
  if (report.migrated.length) {
    const at = now();
    const marker = `${v.dir}/migrated-${at}.json`;
    try {
      v.io.writeFile(marker, Buffer.from(JSON.stringify({ at: new Date(at).toISOString(), to: "engine vault (P-VAULT-V2.1, ADR-0474)", refs: report.migrated }, null, 2), "utf8"));
      report.marker = marker;
    } catch { /* the marker is a record, not a precondition: every moved ref is already in the engine */ }
  }
  return report;
}

// ── bridge.cred* while both stores may hold entries (main's IPC handlers call these) ────────────────

/** The engine's credentials plus any not yet migrated (engine wins on a shared ref). With the engine
 *  down, the safeStorage listing alone, as before. */
export async function credListMerged(client: EngineCredClient, v: LegacyCredVault): Promise<CredView[]> {
  let engine: CredView[] = [];
  try { engine = await client.list(); } catch { /* engine down: legacy entries only */ }
  const have = new Set(engine.map((c) => c.ref));
  let legacy: CredView[] = [];
  try { legacy = listCredentials(v.io, v.dir).filter((m) => !have.has(m.ref)); } catch { /* none */ }
  return [...engine, ...legacy];
}

/** Store a new credential in the engine vault (fail-closed: an engine refusal is an { error }). A legacy
 *  safeStorage copy of the same ref is removed afterwards so it can never be injected over the new value. */
export async function credStoreEngine(client: EngineCredClient, v: LegacyCredVault, input: StoreInput): Promise<CredView | { error: string }> {
  try {
    const meta = await client.store(input);
    try { deleteCredential(v.io, v.dir, meta.ref); } catch { /* the next migration run supersedes it */ }
    return meta;
  } catch (e) { return { error: String((e as Error)?.message ?? e) }; }
}

/** Rotate in place. A ref still only in safeStorage is moved into the engine with the NEW value (its
 *  CredMeta kept, rotatedAt = now) and the old copy removed. */
export async function credRotateEngine(client: EngineCredClient, v: LegacyCredVault, input: RotateInput, now: () => number = Date.now): Promise<CredView | { error: string }> {
  try {
    const rotated = await client.rotate(input);
    if (rotated) return rotated;
    const legacy = listCredentials(v.io, v.dir).find((m) => m.ref === input.ref);
    if (!legacy) return { error: "not-found" };
    const meta: Partial<CredMeta> = { ...legacyMeta(v, input.ref), rotatedAt: now(), ...(input.expiresAt != null ? { expiresAt: input.expiresAt } : {}) };
    const r = await client.importLegacy({ ref: input.ref, value: input.secret, meta });
    if (r.verified !== true) return { error: "the engine did not confirm the rotation" };
    if (r.outcome === "superseded") return { error: "not-found" }; // raced a store: the engine holds another value
    deleteCredential(v.io, v.dir, input.ref);
    const after = (await client.list()).find((c) => c.ref === input.ref);
    return after ?? { error: "not-found" };
  } catch (e) { return { error: String((e as Error)?.message ?? e) }; }
}

/** Delete from both stores; true when either held it. */
export async function credDeleteEverywhere(client: EngineCredClient, v: LegacyCredVault, ref: string): Promise<boolean> {
  let engine = false;
  try { engine = await client.remove(ref); } catch { /* engine down: the legacy delete still runs */ }
  let legacy = false;
  try { legacy = deleteCredential(v.io, v.dir, ref); } catch { /* best-effort, as before */ }
  return engine || legacy;
}
