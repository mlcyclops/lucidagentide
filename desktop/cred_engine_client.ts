// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/cred_engine_client.ts
//
// P-VAULT-V2.1 (ADR-0474): Electron main's side of the one credential store. Electron `safeStorage` is not
// a FIPS 140-validated module, so credentials move into the engine vault (engine_vault.ts, sealed with
// AES-256-GCM through harness/crypto/fips_crypto.ts under an OS-held master key). Main never opens that
// vault (it runs as a --target=node bundle); it talks to the engine's main-only routes in vault_routes.ts
// at 127.0.0.1 (the bind address) with the UI token, and authenticates both directions with the
// per-launch vault token it minted (LUCID_VAULT_MAIN_TOKEN), which itself never goes over the wire: a
// per-request nonce + request MAC, and a reply MAC checked before any reply is trusted (see below).
//
// Migration ordering (crash-safe, idempotent, nothing lost if the engine is down):
//   1. At spawn main still injects env from safeStorage exactly as before (cred_env.ts), so the first boot
//      after the upgrade works with every credential where it was.
//   2. Once the engine answers its health check, for each `<ref>.bin` in the cred vault: main decrypts it,
//      POSTs { ref, value, meta } to /api/vault/main/import; the engine stores it (same ref, CredMeta
//      fields, source "migrated-safestorage") and reads it back before answering `verified: true`.
//   3. Only after that answer, with a verified reply MAC, does main delete the `.bin` (and its `.meta.json`).
//      On a different engine value the newer one wins (legacy rotatedAt ?? createdAt vs the entry's
//      updatedAt) and the engine reads the winner back first. A crash anywhere before
//      the delete leaves the source in place; the next run imports it again, the engine answers "present"
//      (same value, nothing rewritten), and the delete happens then.
//   4. A `migrated-<ts>.json` marker (refs only, never values) records each run that moved something.
// An entry that cannot be decrypted, or that the engine refuses, stays in safeStorage and keeps being
// injected by main. New credentials (bridge.credStore & co.) go to the engine only: there is no
// safeStorage fallback, a refusal is surfaced as { error }.
//
// Node-safe (fetch, node:crypto, cred_vault.ts and origin_guard.ts only): no Electron import, so it
// unit-tests with fakes.

import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  deleteCredential, isValidRef, listCredentials, readCredential, type CredMeta, type SafeStorageLike, type VaultIo,
} from "./cred_vault.ts";
import { tokenValid } from "./origin_guard.ts";

/** The bridge cred* metadata shape (renderer CredMetaView). */
export interface CredView { ref: string; kind: string; label?: string; last4?: string; createdAt?: number; rotatedAt?: number; expiresAt?: number; rotationIntervalDays?: number }
export interface EngineVaultStatus { available: boolean; custody: string; state: string; fips: boolean; entries: number }
export interface StoreInput { ref?: string; kind: string; secret: string; label?: string; expiresAt?: number; rotationIntervalDays?: number }
export interface RotateInput { ref: string; secret: string; expiresAt?: number }
export interface ImportItem { ref: string; value: string; meta: Partial<CredMeta> }
export interface ImportResult { ref: string; outcome: "stored" | "present" | "replaced" | "superseded"; verified: boolean }

export interface EngineVaultLink {
  /** `http://127.0.0.1:<PORT>`: the engine's bind address, never `localhost` (which may resolve to an
   *  [::1] socket the engine does not own; security review VAULT-TRANSPORT-LOCALHOST). */
  baseUrl: string;
  /** The engine's UI token (main mints it: LUCID_MAIN_TOKEN). */
  uiToken: string;
  /** The main-only vault token (LUCID_VAULT_MAIN_TOKEN). It never travels on the wire: it keys the MACs. */
  vaultToken: string;
  fetch?: typeof fetch;
}

// ── channel authentication (security review VAULT-TRANSPORT-LOCALHOST) ──────────────────────────────
// Every main-only request carries a fresh 32-byte nonce and a request MAC under the vault token, and every
// reply must carry `x-lucid-vault-mac = HMAC-SHA256(vaultToken, nonce || SHA-256(responseBody))`. The token
// itself is never sent, so a peer that is not the engine (a socket squatting on [::1]:PORT, say) can
// neither forge a reply nor learn the key from the request. The client checks the reply MAC in constant
// time BEFORE it trusts anything in the reply (status, `ok`, `verified`); a missing or wrong MAC is a
// refusal, so the migration deletes nothing on an unauthenticated answer. The layout below is the one
// definition both sides use: the engine computes it with harness/crypto/fips_crypto.ts (Contract A), main
// with node:crypto (Electron main never has a validated module, ADR-0473: routing this loopback channel
// check through fips_crypto would make every bridge.cred* call fail on a FIPS-required host, where the
// engine's validated module is the one sealing the data; the MAC protects no data at rest).

export const VAULT_NONCE_HEADER = "x-lucid-vault-nonce";
export const VAULT_AUTH_HEADER = "x-lucid-vault-auth";
export const VAULT_MAC_HEADER = "x-lucid-vault-mac";
/** HMAC-SHA256 and SHA-256, from whichever module the caller's process uses. */
export interface MacPrimitives { hmac(key: Buffer, data: Buffer): Buffer; sha256(data: Buffer): Buffer }
/** Domain separation: a request MAC input is always longer than the 64-byte reply input and starts with
 *  this label, so neither can stand in for the other. */
const REQUEST_LABEL = Buffer.from("lucid-vault-request-v1\0", "utf8");

/** HMAC-SHA256(token, "lucid-vault-request-v1\0" || method "\0" path "\0" || nonce || SHA-256(body)). */
export function vaultRequestMac(c: MacPrimitives, token: string, method: string, path: string, nonce: Buffer, body: Buffer): Buffer {
  return c.hmac(Buffer.from(token, "utf8"), Buffer.concat([REQUEST_LABEL, Buffer.from(`${method}\0${path}\0`, "utf8"), nonce, c.sha256(body)]));
}

/** HMAC-SHA256(token, nonce || SHA-256(responseBody)): the `x-lucid-vault-mac` reply header. */
export function vaultResponseMac(c: MacPrimitives, token: string, nonce: Buffer, body: Buffer): Buffer {
  return c.hmac(Buffer.from(token, "utf8"), Buffer.concat([nonce, c.sha256(body)]));
}

const NODE_MAC: MacPrimitives = {
  hmac: (key, data) => createHmac("sha256", key).update(data).digest(),
  sha256: (data) => createHash("sha256").update(data).digest(),
};

/** A request the engine answered with `{ ok: false }` (or not at all). `status` 0 = no answer, or one
 *  whose reply MAC did not verify (so not the engine's). */
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
  /** Graceful vault cleanup before main kills the engine (vault_lifecycle.ts): counts only. */
  shutdown(): Promise<VaultCleanupReport>;
}

/** What a vault cleanup did (vault_lifecycle.ts): re-blanked `.env` files and wiped temp folders, by count. */
export interface VaultCleanupReport { reblanked: number; reblankFailed: number; swept: number; kept: number }

export function engineCredClient(link: EngineVaultLink): EngineCredClient {
  const doFetch = link.fetch ?? fetch;
  async function call<T>(path: string, payload?: unknown): Promise<T> {
    const route = `/api/vault/main/${path}`;
    const method = payload === undefined ? "GET" : "POST";
    const sent = payload === undefined ? "" : JSON.stringify(payload);
    const nonce = randomBytes(32); // fresh per request: a recorded reply never verifies again
    let res: Response;
    let raw: Buffer;
    try {
      res = await doFetch(`${link.baseUrl}${route}`, {
        method,
        headers: {
          "x-lucid-token": link.uiToken, "content-type": "application/json",
          [VAULT_NONCE_HEADER]: nonce.toString("hex"),
          [VAULT_AUTH_HEADER]: vaultRequestMac(NODE_MAC, link.vaultToken, method, route, nonce, Buffer.from(sent, "utf8")).toString("hex"),
        },
        ...(payload === undefined ? {} : { body: sent }),
        signal: AbortSignal.timeout(20_000),
      });
      raw = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      throw new EngineVaultError(`the engine vault is not reachable (${String((e as Error)?.message ?? e).slice(0, 120)})`, 0);
    }
    // Nothing in the reply (its status included) is trusted before its MAC verifies. Status 0: no answer
    // that counts, so no caller mistakes a forged 404 for "not found".
    const want = vaultResponseMac(NODE_MAC, link.vaultToken, nonce, raw).toString("hex");
    if (!tokenValid(res.headers.get(VAULT_MAC_HEADER), want)) {
      throw new EngineVaultError(`the engine vault reply (HTTP ${res.status}) is not authenticated (missing or wrong ${VAULT_MAC_HEADER}): refused`, 0);
    }
    let parsed: unknown = null;
    try { parsed = JSON.parse(raw.toString("utf8")); } catch { /* not JSON: the shape check below refuses it */ }
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
    shutdown: () => call<VaultCleanupReport>("shutdown", {}),
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
