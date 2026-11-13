// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/engine_vault.ts
//
// P-VAULT-KEYS.1 (ADR-0472): the ENGINE-side OS vault for the secrets settings_store.ts used to keep in
// plaintext in lucid-gui.json (provider API keys, named-account keys, MCP bearer tokens, the TURN
// credential). The Electron-main vault (cred_vault.ts, safeStorage) cannot serve them: the engine is a
// separate Bun process, and it also runs headless (lucid hub, `bun run dev.ts`, bin/lucid-engine, fleet
// lanes) where no Electron main exists. So the engine opens its own vault:
//
//   - one random 32-byte MASTER KEY per vault directory, held by the OS for the current user:
//       win32  DPAPI CryptProtectData (CurrentUser), ciphertext in <dir>/master.dpapi, via bun:ffi
//       darwin Keychain generic password (service "LUCID Engine Vault"), via /usr/bin/security
//       linux  Secret Service (libsecret), via secret-tool
//   - the secrets themselves sealed with AES-256-GCM under that key in <dir>/secrets.v1.json.
//
// P-VAULT-V2.1 (ADR-0474): format v2. The sealed plaintext is `{ entries: { [ref]: VaultEntryMeta & { value } } }`,
// so every secret carries non-secret metadata (kind, label, source, dates, env name, last-4). A v1 record
// (a bare `{ ref: value }` map) is still read; its entries get synthesized metadata (source
// "migrated-settings") and the file is rewritten as v2 on the first write that changes something. The file
// name stays `secrets.v1.json` (the envelope's `v` field is the format version), so a vault directory never
// holds two competing files. All AES-GCM, SHA-256 and random bytes go through harness/crypto/fips_crypto.ts
// (P-FIPS.1, ADR-0473): the bytes are identical to node:crypto, so no record needs re-encryption.
//
// Several engines can share one vault (installed app, dev port, hub engine, fleet lanes), so every write
// is a DELTA (refs to set, refs to delete) applied under an owner-token `secrets.lock` to a map read
// fresh from disk and decrypted inside the lock: an engine never writes back a map it did not just
// decrypt, so it can neither drop another engine's key nor resurrect one another engine deleted.
//
// Fail-closed rules: a secrets file that cannot be decrypted is never overwritten (updateVault sets it
// aside first), a master key that exists but cannot be read is never replaced, no master key is minted
// while sealed data is on disk, a file in a newer format is never set aside, a FIPS-required refusal is
// never mistaken for an unreadable file, and this module never writes a plaintext secret anywhere. Outside
// Bun (Electron main bundles settings_store.ts with --target=node) every entry point reports `unavailable`
// without touching a vault file.

import { closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { aesGcmDecrypt, aesGcmEncrypt, FipsRequiredError, randomBytes, sha256 } from "../harness/crypto/fips_crypto.ts"; // P-FIPS.1 (ADR-0473)
import { errCode, RETRYABLE, withRetry, writeAtomic } from "./atomic_file.ts";
import { deriveLast4 } from "./cred_vault.ts";

/** AAD for v1 sealed records and the DPAPI entropy (never changes: it binds every existing master key). */
export const VAULT_AAD = "lucid-engine-vault-v1";
/** AAD for v2 sealed records: binds the format version, so a v2 record relabeled `v: 1` fails to open. */
export const VAULT_AAD_V2 = "lucid-engine-vault-v2";
export const SECRETS_FILE = "secrets.v1.json";
const MASTER_DPAPI = "master.dpapi";
const MASTER_LOCK = "master.lock";
const SECRETS_LOCK = "secrets.lock";
/** A lock is stale only when older than this AND its owner pid is gone. Well above the longest backend
 *  call a holder makes (SPAWN_TIMEOUT_MS), so a slow Keychain prompt never loses its lock. */
const LOCK_STALE_MS = 60_000;
/** How long a caller waits for a held lock before giving up with an error (never proceeding without it). */
const LOCK_WAIT_MS = 45_000;
const KEYCHAIN_SERVICE = "LUCID Engine Vault";
const LIBSECRET_SERVICE = "lucid-engine-vault";
const SECURITY_BIN = "/usr/bin/security";
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
const SPAWN_TIMEOUT_MS = 15_000;

export type VaultBackendKind = "dpapi" | "keychain" | "libsecret";
export type VaultCustody = VaultBackendKind | "plaintext-file";
export type VaultState = "ok" | "unavailable" | "unreadable";
export interface VaultStatus { custody: VaultCustody; state: VaultState; detail?: string }

/** Why a master key is not in hand. `absent` = no record exists (safe to create one); `unavailable` = the
 *  backend cannot be reached; `unreadable` = a record may exist but could not be read (never replace it). */
export interface MasterMiss { missing: "absent" | "unavailable" | "unreadable"; detail?: string }
export type MasterRead = Buffer | MasterMiss;
/** One OS key store bound to one vault directory. Injectable (`_setVaultBackendForTest`). */
export interface OsKeyStore { readonly kind: VaultBackendKind; read(): MasterRead; create(key: Buffer): boolean }
export type OsKeyStoreFactory = (vaultDir: string) => OsKeyStore | null;

/** The vault directory for a settings file: `LUCID_ENGINE_VAULT_DIR`, else beside the settings file, so the
 *  LUCID_GUI_SETTINGS_FILE isolation seam (tests, Creator, Fleet profiles) isolates the vault too. */
export function engineVaultDir(settingsFile: string): string {
  return resolve(process.env.LUCID_ENGINE_VAULT_DIR || join(dirname(settingsFile), "lucid-engine-vault"));
}
const secretsPath = (dir: string): string => join(dir, SECRETS_FILE);
/** Key id: the first 16 hex of sha256(master key). Lets a reader detect the wrong key before decrypting. */
const kidOf = (key: Buffer): string => sha256(key).toString("hex").slice(0, 16);
/** Keychain / Secret Service account for a vault dir: one master key per directory. */
const accountFor = (dir: string): string => `master-v1-${sha256(Buffer.from(resolve(dir), "utf8")).toString("hex").slice(0, 16)}`;
const NO_BUN: VaultStatus = { custody: "plaintext-file", state: "unavailable", detail: "not running under Bun (Electron main never opens the engine vault)" };
const EMPTY: Readonly<Record<string, string>> = Object.freeze({});
const NO_ENTRIES: VaultEntries = Object.freeze({});
/** A FIPS-required refusal (P-FIPS.1): reported as such, never treated as an unreadable record. */
const fipsRefusal = (e: unknown): string | null => (e instanceof FipsRequiredError ? `FIPS mode refused the operation: ${e.message}` : null);

// ── entries and metadata (P-VAULT-V2.1, ADR-0474, Contract B) ──────────────────────────────────────

export type VaultKind = "apikey" | "token" | "bearer" | "pat" | "oauth" | "password" | "basic" | "pem" | "jwt" | "saml" | "json" | "other";
export const VAULT_KINDS: readonly VaultKind[] = ["apikey", "token", "bearer", "pat", "oauth", "password", "basic", "pem", "jwt", "saml", "json", "other"];
export type VaultSource = "typed" | "migrated-settings" | "migrated-safestorage" | "env-import" | "agent-request" | "restore" | "destination-pull";
export const VAULT_SOURCES: readonly VaultSource[] = ["typed", "migrated-settings", "migrated-safestorage", "env-import", "agent-request", "restore", "destination-pull"];
/** Non-secret metadata of one vault entry. Safe for the UI (last-4 included); never the value. */
export interface VaultEntryMeta {
  ref: string; label: string; kind: VaultKind; source: VaultSource;
  scope?: { workspace?: string };
  envName?: string;
  addedAt: number; updatedAt: number; rotatedAt?: number; expiresAt?: number; rotationIntervalDays?: number;
  last4?: string;
}
/** One sealed entry: metadata plus the secret. Engine-internal only. */
export interface VaultEntry extends VaultEntryMeta { value: string }
export type VaultEntries = Readonly<Record<string, Readonly<VaultEntry>>>;
/** Metadata a write may set for a ref (`ref` is the map key, `last4` is always derived from the value). */
export type VaultMetaPatch = Partial<Omit<VaultEntryMeta, "ref" | "last4">>;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const isEnvName = (s: unknown): s is string => typeof s === "string" && s.length <= 128 && ENV_NAME_RE.test(s);
/** Last-4 for the UI, never for a secret shorter than 12 characters. PEM-aware (identifies the key body). */
export function vaultLast4(value: string, kind: VaultKind): string | undefined {
  return value.length >= 12 ? deriveLast4(value, kind === "pem" ? "pem" : undefined) : undefined;
}
/** Kind, label and env name a ref implies when nothing else says (v1 upgrade, settings_store writes). */
export function inferMeta(ref: string): { kind: VaultKind; label: string; envName?: string } {
  if (ref.startsWith("key:")) { const env = ref.slice(4); return { kind: "apikey", label: env, ...(isEnvName(env) ? { envName: env } : {}) }; }
  if (ref.startsWith("account:")) return { kind: "apikey", label: ref };
  if (ref.startsWith("mcp:")) return { kind: "bearer", label: ref };
  if (ref === "turn:credential") return { kind: "password", label: "TURN credential" };
  if (ref.startsWith("oauth:")) return { kind: "oauth", label: ref };
  const ws = /^ws:[0-9a-f]{16}:(.+)$/.exec(ref);
  if (ws && isEnvName(ws[1])) return { kind: "apikey", label: ws[1], envName: ws[1] };
  return { kind: "other", label: ref };
}
const finite = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) ? n : undefined);

/** Build one entry in canonical field order (so a sealed record and its read-back compare byte-for-byte). */
function canonEntry(ref: string, value: string, m: Partial<VaultEntryMeta>, fallbackAt: number, fallbackSource: VaultSource): VaultEntry {
  const inferred = inferMeta(ref);
  const kind = VAULT_KINDS.find((k) => k === m.kind) ?? inferred.kind;
  const addedAt = finite(m.addedAt) ?? fallbackAt;
  const e: VaultEntry = {
    ref,
    label: typeof m.label === "string" && m.label.trim() ? m.label.slice(0, 200) : inferred.label,
    kind,
    source: VAULT_SOURCES.find((s) => s === m.source) ?? fallbackSource,
    addedAt,
    updatedAt: finite(m.updatedAt) ?? addedAt,
    value,
  };
  const ws = m.scope && typeof m.scope === "object" && typeof m.scope.workspace === "string" && m.scope.workspace ? m.scope.workspace : undefined;
  if (ws) e.scope = { workspace: ws };
  const envName = m.envName === undefined ? inferred.envName : m.envName;
  if (isEnvName(envName)) e.envName = envName;
  const rotatedAt = finite(m.rotatedAt); if (rotatedAt !== undefined) e.rotatedAt = rotatedAt;
  const expiresAt = finite(m.expiresAt); if (expiresAt !== undefined) e.expiresAt = expiresAt;
  const interval = finite(m.rotationIntervalDays); if (interval !== undefined && interval > 0) e.rotationIntervalDays = interval;
  const last4 = vaultLast4(value, kind); if (last4) e.last4 = last4;
  return e;
}
/** The metadata of an entry (the value dropped). */
export function metaOf(e: VaultEntry): VaultEntryMeta {
  const { value: _value, ...meta } = e;
  return meta;
}

// ── sealing ────────────────────────────────────────────────────────────────────────────────────────

/** The on-disk envelope, unchanged since v1; `v` is the plaintext format version. */
export interface SealedSecrets { v: 1 | 2; alg: "A256GCM"; kid: string; iv: string; tag: string; ct: string }

function seal(key: Buffer, v: 1 | 2, plaintext: string): SealedSecrets {
  const iv = randomBytes(12);
  const { ct, tag } = aesGcmEncrypt(key, iv, Buffer.from(plaintext, "utf8"), Buffer.from(v === 2 ? VAULT_AAD_V2 : VAULT_AAD, "utf8"));
  return { v, alg: "A256GCM", kid: kidOf(key), iv: iv.toString("base64"), tag: tag.toString("base64"), ct: ct.toString("base64") };
}

/** Seal a v1 record (a bare `{ ref: value }` map). The engine itself only writes v2; this writer exists
 *  so tests and tools can produce the format every pre-ADR-0474 vault holds. */
export function sealSecrets(key: Buffer, secrets: Record<string, string>): SealedSecrets {
  return seal(key, 1, JSON.stringify(secrets));
}

/** Seal a v2 record: every entry with its metadata. */
export function sealEntries(key: Buffer, entries: VaultEntries): SealedSecrets {
  return seal(key, 2, JSON.stringify({ entries }));
}

export interface OpenedVault { version: 1 | 2; entries: Record<string, VaultEntry> }

/** The newest envelope `v` this build reads. */
export const VAULT_FORMAT_MAX = 2;
/** A sealed file whose envelope `v` is newer than VAULT_FORMAT_MAX (security review VAULT-V2-MIXED-ENGINE):
 *  another engine on a newer build owns that format. It is unreadable here, and this build never sets it
 *  aside or writes over it. */
export class VaultFormatTooNewError extends Error {
  constructor(readonly version: number) {
    super(`${SECRETS_FILE} was written by a newer LUCID build (vault format v${version}; this build reads up to v${VAULT_FORMAT_MAX}): it is left untouched and this build refuses to write to it; update LUCID`);
    this.name = "VaultFormatTooNewError";
  }
}

const MASTER_MISSING = "master key missing for an existing vault";
/** Sealed vault data in `dir`: the secrets file and every set-aside `.unreadable-<ts>` copy. Only a missing
 *  directory counts as none; any other listing error throws (a key is never minted on a guess). */
function sealedFilesIn(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch (e) {
    if (errCode(e) === "ENOENT") return [];
    throw new Error(`cannot list the vault directory ${dir} (${errCode(e) ?? String(e).slice(0, 80)})`, { cause: e });
  }
  return names.filter((n) => n === SECRETS_FILE || n.startsWith(`${SECRETS_FILE}.unreadable-`)).sort();
}

/** Open a sealed v1 or v2 record. v1 entries get synthesized metadata stamped `upgradeAt` with source
 *  "migrated-settings". Throws (with a reason) on a wrong key, a short or altered record, or bad shape; a
 *  record in a newer format throws VaultFormatTooNewError before any key check; a FIPS-required refusal
 *  is rethrown as the FipsRequiredError it is. */
export function openVault(key: Buffer, sealed: unknown, upgradeAt: number): OpenedVault {
  if (sealed && typeof sealed === "object" && "v" in sealed && typeof sealed.v === "number" && Number.isInteger(sealed.v) && sealed.v > VAULT_FORMAT_MAX) {
    throw new VaultFormatTooNewError(sealed.v);
  }
  const s = sealed as Partial<SealedSecrets> | null;
  if (!s || typeof s !== "object" || (s.v !== 1 && s.v !== 2) || s.alg !== "A256GCM" || typeof s.kid !== "string" || typeof s.iv !== "string" || typeof s.tag !== "string" || typeof s.ct !== "string") {
    throw new Error("not a v1 or v2 sealed secrets record");
  }
  const kid = kidOf(key);
  if (s.kid !== kid) throw new Error(`sealed under a different master key (kid ${s.kid}, this account's key is ${kid})`);
  const iv = Buffer.from(s.iv, "base64");
  const tag = Buffer.from(s.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("malformed iv or tag");
  let text: string;
  try {
    text = aesGcmDecrypt(key, iv, Buffer.from(s.ct, "base64"), tag, Buffer.from(s.v === 2 ? VAULT_AAD_V2 : VAULT_AAD, "utf8")).toString("utf8");
  } catch (e) {
    if (e instanceof FipsRequiredError) throw e;
    throw new Error("authentication failed (the record was altered or truncated)");
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("sealed content is not a map");
  const entries: Record<string, VaultEntry> = {};
  if (s.v === 1) {
    for (const [ref, v] of Object.entries(parsed)) {
      if (typeof v !== "string") throw new Error(`sealed value for ${ref} is not a string`);
      entries[ref] = canonEntry(ref, v, {}, upgradeAt, "migrated-settings");
    }
    return { version: 1, entries };
  }
  const raw = "entries" in parsed ? parsed.entries : null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("sealed v2 content has no entries map");
  for (const [ref, e] of Object.entries(raw)) {
    if (!e || typeof e !== "object" || !("value" in e) || typeof e.value !== "string") throw new Error(`sealed entry ${ref} has no string value`);
    const stored: Partial<VaultEntryMeta> = e; // canonEntry validates every field it keeps
    entries[ref] = canonEntry(ref, e.value, stored, upgradeAt, "migrated-settings");
  }
  return { version: 2, entries };
}

/** The `{ ref: value }` map of a sealed v1 or v2 record. Same failure rules as openVault. */
export function openSealed(key: Buffer, sealed: unknown): Record<string, string> {
  return valuesOf(openVault(key, sealed, 0).entries);
}

function valuesOf(entries: VaultEntries): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ref, e] of Object.entries(entries)) out[ref] = e.value;
  return out;
}

// ── backends ───────────────────────────────────────────────────────────────────────────────────────

/** The slice of bun:ffi this module uses, typed locally so the Node-typed Electron program never needs
 *  bun:ffi's declarations. */
interface BunFfi {
  dlopen(lib: string, symbols: Record<string, { args: unknown[]; returns: unknown }>): { symbols: Record<string, unknown> };
  FFIType: { ptr: unknown; u32: unknown; i32: unknown };
  ptr(view: ArrayBufferView): number;
  toArrayBuffer(p: number, byteOffset: number, byteLength: number): ArrayBuffer;
}
type DpapiFn = (pIn: number, desc: null, pEntropy: number, reserved: null, prompt: null, flags: number, pOut: number) => number;
export interface Dpapi { protect(data: Uint8Array): Buffer | null; unprotect(blob: Uint8Array): Buffer | null }

let dpapiApi: Dpapi | null | undefined;
/** DPAPI (CurrentUser scope) through bun:ffi, or null off Windows / outside Bun / when the DLLs cannot be
 *  bound. bun:ffi is required lazily under an opaque specifier: main.ts is bundled with --target=node and
 *  must neither resolve nor load it. */
export function dpapi(): Dpapi | null {
  if (dpapiApi !== undefined) return dpapiApi;
  dpapiApi = null;
  if (typeof Bun === "undefined" || process.platform !== "win32") return null;
  try {
    const spec = "bun:ffi";
    const ffi = require(spec) as BunFfi;
    const sig = { args: [ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.u32, ffi.FFIType.ptr], returns: ffi.FFIType.i32 };
    const crypt = ffi.dlopen("crypt32.dll", { CryptProtectData: sig, CryptUnprotectData: sig }).symbols as { CryptProtectData: DpapiFn; CryptUnprotectData: DpapiFn };
    const k32 = ffi.dlopen("kernel32.dll", { LocalFree: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.ptr } }).symbols as { LocalFree: (p: number) => unknown };
    const entropy = new Uint8Array(Buffer.from(VAULT_AAD, "utf8"));
    // DATA_BLOB on 64-bit Windows: { DWORD cbData; 4 bytes padding; BYTE* pbData } = 16 bytes.
    const blobOf = (data: Uint8Array): Uint8Array => {
      const b = new Uint8Array(16);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, data.byteLength, true);
      dv.setBigUint64(8, BigInt(ffi.ptr(data)), true);
      return b;
    };
    const run = (fn: DpapiFn, input: Uint8Array): Buffer | null => {
      const data = new Uint8Array(input); // an own, offset-0 copy that stays referenced through the call
      const inBlob = blobOf(data);
      const entBlob = blobOf(entropy);
      const out = new Uint8Array(16);
      try {
        if (!fn(ffi.ptr(inBlob), null, ffi.ptr(entBlob), null, null, CRYPTPROTECT_UI_FORBIDDEN, ffi.ptr(out))) return null;
        const dv = new DataView(out.buffer);
        const cb = dv.getUint32(0, true);
        const p = Number(dv.getBigUint64(8, true));
        if (!p) return null;
        const view = new Uint8Array(ffi.toArrayBuffer(p, 0, cb));
        try { return Buffer.from(view); } finally { view.fill(0); k32.LocalFree(p); }
      } finally { data.fill(0); }
    };
    dpapiApi = { protect: (d) => run(crypt.CryptProtectData, d), unprotect: (b) => run(crypt.CryptUnprotectData, b) };
  } catch (e) {
    console.error(`[vault] DPAPI could not be bound (${String((e as Error)?.message ?? e).slice(0, 120)})`);
  }
  return dpapiApi;
}

function decodeKey(text: string): MasterRead {
  const key = Buffer.from(text.trim(), "base64");
  return key.length === 32 ? key : { missing: "unreadable", detail: "the stored master key is malformed" };
}

function dpapiStore(dir: string): OsKeyStore | null {
  const api = dpapi();
  if (!api) return null;
  const file = join(dir, MASTER_DPAPI);
  return {
    kind: "dpapi",
    read() {
      let blob: Buffer;
      try { blob = withRetry(() => readFileSync(file)); } catch (e) {
        return errCode(e) === "ENOENT" ? { missing: "absent" } : { missing: "unreadable", detail: `${MASTER_DPAPI}: ${errCode(e) ?? String(e).slice(0, 80)}` };
      }
      const key = api.unprotect(blob);
      if (!key) return { missing: "unreadable", detail: "DPAPI could not decrypt the master key (a different Windows user or machine?)" };
      if (key.length !== 32) { key.fill(0); return { missing: "unreadable", detail: "the master key has the wrong length" }; }
      return key;
    },
    create(key) {
      const blob = api.protect(key);
      if (!blob) return false;
      try { writeAtomic(file, blob); return true; } catch { return false; }
    },
  };
}

function keychainStore(dir: string): OsKeyStore | null {
  if (!existsSync(SECURITY_BIN)) return null;
  const account = accountFor(dir);
  return {
    kind: "keychain",
    read() {
      const r = spawnSync(SECURITY_BIN, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
      if (r.error) return { missing: "unavailable", detail: `security: ${errCode(r.error) ?? r.error.message}` };
      if (r.status === 44) return { missing: "absent" }; // errSecItemNotFound
      if (r.status !== 0) return { missing: "unreadable", detail: `security exited ${r.status}: ${(r.stderr ?? "").trim().slice(0, 120)}` };
      return decodeKey(r.stdout ?? "");
    },
    create(key) {
      // The secret travels on stdin to `security -i`, never on argv (argv is visible to other processes).
      // One command, then EOF ends the session: `security -i` has no `quit` command, and the old trailing
      // `quit` line made it exit 1 after a successful add, so no Mac ever got a master key (found by
      // vault-backends.yml on a real Keychain, v2.5.1 beta review).
      const line = `add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${account}" -l "${KEYCHAIN_SERVICE}" -w "${key.toString("base64")}"\n`;
      const r = spawnSync(SECURITY_BIN, ["-i"], { input: line, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
      return !r.error && r.status === 0;
    },
  };
}

function libsecretStore(dir: string): OsKeyStore {
  const account = accountFor(dir);
  return {
    kind: "libsecret",
    read() {
      const lookupArgs = ["lookup", "service", LIBSECRET_SERVICE, "account", account];
      const r = spawnSync("secret-tool", lookupArgs, { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
      if (r.error) return { missing: "unavailable", detail: `secret-tool: ${errCode(r.error) ?? r.error.message}` };
      const stderr = (r.stderr ?? "").trim();
      if (r.status === 0 && (r.stdout ?? "").trim()) return decodeKey(r.stdout ?? "");
      if (r.status === 1 && !stderr) {
        // lookup also exits 1, silently, for an item in a LOCKED collection (a dismissed unlock prompt), so
        // exit 1 alone never proves absence (security review VAULT-MASTER-RECREATE). `search --unlock`
        // asks to unlock and lists matching items, locked or not: none listed is the only "absent".
        const s = spawnSync("secret-tool", ["search", "--unlock", "service", LIBSECRET_SERVICE, "account", account], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
        if (s.error || s.status !== 0) return { missing: "unavailable", detail: `secret-tool search: ${s.error ? errCode(s.error) ?? s.error.message : `exited ${s.status}: ${(s.stderr ?? "").trim().slice(0, 120)}`}` };
        if (!(s.stdout ?? "").trim()) return { missing: "absent" };
        const again = spawnSync("secret-tool", lookupArgs, { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
        if (!again.error && again.status === 0 && (again.stdout ?? "").trim()) return decodeKey(again.stdout ?? "");
        return { missing: "unreadable", detail: "the Secret Service holds the master key item but it is locked (the keyring unlock was dismissed?)" };
      }
      return { missing: "unavailable", detail: `secret-tool exited ${r.status}${stderr ? `: ${stderr.slice(0, 120)}` : ""}` };
    },
    create(key) {
      const r = spawnSync("secret-tool", ["store", "--label=LUCID engine vault", "service", LIBSECRET_SERVICE, "account", account], { input: key.toString("base64"), encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
      return !r.error && r.status === 0;
    },
  };
}

const defaultFactory: OsKeyStoreFactory = (dir) => {
  if (process.platform === "win32") return dpapiStore(dir);
  if (process.platform === "darwin") return keychainStore(dir);
  if (process.platform === "linux") return libsecretStore(dir);
  return null;
};
let factory: OsKeyStoreFactory = defaultFactory;
const stores = new Map<string, OsKeyStore | null>();
/** `fileSig` = the secrets file (`<mtimeMs>:<size>`, or "none") a MISS was observed against. */
const masters = new Map<string, { at: number; read: MasterRead; fileSig: string }>();
const reads = new Map<string, { mtimeMs: number; size: number; kid: string; version: 1 | 2; secrets: Readonly<Record<string, string>>; entries: VaultEntries }>();
/** A secrets file (by `<mtimeMs>:<size>`) that this master key could not open: not retried until either changes. */
const failures = new Map<string, { sig: string; kid: string; problem: string }>();
/** How long a miss is trusted before the backend is asked again (spawning `security` per load is not free). */
const MISS_TTL_MS: Record<MasterMiss["missing"], number> = { absent: 5_000, unavailable: 30_000, unreadable: 30_000 };
const NO_FILE = "none";

/** Test-only: replace the OS backend (a factory returning null = no backend); null restores the real one.
 *  Clears every cache so the next call sees the new backend. */
export function _setVaultBackendForTest(f: OsKeyStoreFactory | null): void {
  factory = f ?? defaultFactory;
  stores.clear(); masters.clear(); reads.clear(); failures.clear();
}

function storeFor(dir: string): OsKeyStore | null {
  if (!stores.has(dir)) stores.set(dir, factory(dir));
  return stores.get(dir) ?? null;
}

/** The master key for reading. A cached key is reused; a cached MISS is trusted only within its TTL and only
 *  against the same secrets file it was observed with (`fileSig`): once another engine creates or rewrites
 *  the vault, the backend is asked again, so a stale "absent" can never hide that engine's keys. */
function masterForRead(dir: string, store: OsKeyStore, fileSig: string): MasterRead {
  const hit = masters.get(dir);
  if (hit && Buffer.isBuffer(hit.read)) return hit.read;
  if (hit && !Buffer.isBuffer(hit.read) && hit.fileSig === fileSig && Date.now() - hit.at < MISS_TTL_MS[hit.read.missing]) return hit.read;
  const read = store.read();
  masters.set(dir, { at: Date.now(), read, fileSig });
  return read;
}

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return errCode(e) === "EPERM"; } // EPERM: alive, not ours to signal
};

/** A lock file's body and mtime from ONE descriptor, so both describe the same file (CodeQL #125/#126,
 *  js/file-system-race: the lock path is never re-read by name after the `wx` create, nor stat'd apart
 *  from the read). Throws ENOENT when the lock is gone. The 0o600 mode is inert ("r" never creates); it
 *  keeps js/insecure-temporary-file from reading this open as a permissive create. */
function readLockFile(path: string): { raw: string; mtimeMs: number } {
  const fd = openSync(path, "r", 0o600);
  try { return { raw: readFileSync(fd, "utf8"), mtimeMs: fstatSync(fd).mtimeMs }; } finally { closeSync(fd); }
}

/** Run `fn` holding an exclusive owner-token lock file (`wx` create; body `{ pid, token, ts }`). A held lock
 *  is taken over only when it is older than `staleMs` AND its owner pid is gone; a lock still owned by a
 *  live process is waited for, up to `timeoutMs`, then this throws (it never proceeds without the lock).
 *  Release unlinks the file only while it still carries OUR token. */
export function withFileLock<T>(path: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const timeoutMs = opts.timeoutMs ?? LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const token = randomBytes(12).toString("hex");
  const deadline = Date.now() + timeoutMs;
  let pause = 10;
  for (;;) {
    let fd: number | null = null;
    try { fd = openSync(path, "wx", 0o600); } catch (e) {
      const code = errCode(e) ?? "";
      // EPERM/EACCES/EBUSY: Windows refuses the create while a released lock is still pending delete.
      if (code !== "EEXIST" && !RETRYABLE.includes(code)) throw new Error(`lock ${path}: ${code || String(e).slice(0, 80)}`, { cause: e });
    }
    if (fd !== null) {
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, ts: Date.now() })); } finally { closeSync(fd); }
      try { return fn(); } finally {
        try { if (readLockFile(path).raw.includes(token)) unlinkSync(path); } catch { /* already gone */ }
      }
    }
    let holder = "a lock being released";
    try {
      const { raw, mtimeMs } = readLockFile(path);
      let info: { pid?: unknown; ts?: unknown } = {};
      try { info = JSON.parse(raw); } catch { /* the owner is between its create and its write */ }
      const ts = typeof info.ts === "number" ? info.ts : mtimeMs;
      const pid = typeof info.pid === "number" ? info.pid : 0;
      holder = pid ? `pid ${pid}` : "an unknown process";
      if (Date.now() - ts > staleMs && !(pid && pidAlive(pid))) {
        // Its owner died holding it. Take it over atomically (security review VAULT-LOCK-STALE-TAKEOVER): a
        // check-then-unlink could delete a lock another waiter created in between. Rename moves whatever
        // file is at `path` right now to a name only we know; only if that file is still the stale lock
        // we judged is it deleted. Anything else is someone's fresh lock: it is put back (a hard link never
        // replaces a newer lock that already took the name; without hard links, only if the name is free)
        // and we back off.
        const moved = `${path}.stale-${token}`;
        renameSync(path, moved);
        if (readFileSync(moved, "utf8") === raw) {
          unlinkSync(moved);
          continue;
        }
        try { linkSync(moved, path); unlinkSync(moved); } catch {
          if (existsSync(path)) unlinkSync(moved); else renameSync(moved, path);
        }
      }
    } catch { /* released (or pending delete on Windows) between our create and our read: back off, retry */ }
    if (Date.now() > deadline) throw new Error(`lock ${path} is held by ${holder}; gave up after ${timeoutMs} ms`);
    Bun.sleepSync(pause);
    pause = Math.min(pause * 2, 200);
  }
}

/** Read the master key, creating it when (and only when) no record exists. Creation runs under the
 *  `master.lock` owner-token lock and re-reads afterwards, so two engines racing at first start agree on
 *  one key. A record that exists but cannot be read is reported, never replaced. `mayCreate: false` reads
 *  only: an absent record stays `absent` (mutateVault passes it whenever sealed data is on disk). */
export function ensureMasterKey(store: OsKeyStore, dir: string, opts: { mayCreate?: boolean } = {}): MasterRead {
  const first = store.read();
  if (Buffer.isBuffer(first) || first.missing !== "absent" || opts.mayCreate === false) return first;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withFileLock(join(dir, MASTER_LOCK), (): MasterRead => {
    const r = store.read();
    if (Buffer.isBuffer(r) || r.missing !== "absent") return r;
    const key = randomBytes(32);
    const created = store.create(key);
    key.fill(0);
    if (!created) return { missing: "unavailable", detail: `${store.kind} refused to store a new master key` };
    const stored = store.read(); // the stored record, not the local copy, is the truth both racers agree on
    return Buffer.isBuffer(stored) || stored.missing !== "absent" ? stored : { missing: "unavailable", detail: `${store.kind} stored the master key but cannot read it back` };
  });
}

// ── the vault ──────────────────────────────────────────────────────────────────────────────────────

export interface VaultRead {
  /** A sealed secrets file is on disk. */
  exists: boolean;
  /** The decrypted `{ ref: value }` map (empty when absent or unreadable). Frozen: callers copy values out. */
  secrets: Readonly<Record<string, string>>;
  /** The same entries with their metadata (v1 records carry synthesized metadata). Frozen. */
  entries: VaultEntries;
  /** The format of the file on disk (absent when there is no readable file). */
  version?: 1 | 2;
  /** Set when the file exists but cannot be opened: the vault is `unreadable` and must be left alone. */
  problem?: string;
}

/** Read and decrypt the vault. Never creates anything. Memoized on the file's mtime + size (and the master
 *  key id), so engines sharing the directory see each other's writes on their next load. A v1 file is
 *  served with metadata stamped at its mtime; it becomes v2 on the next write that changes something. */
export function readVault(vaultDir: string): VaultRead {
  if (typeof Bun === "undefined") return { exists: false, secrets: EMPTY, entries: NO_ENTRIES };
  const dir = resolve(vaultDir);
  let fd: number;
  for (let attempt = 0; ; attempt++) { // withRetry inlined: fstat and read stay on a direct openSync handle
    try { fd = openSync(secretsPath(dir), "r"); break; } catch (e) {
      if (attempt < 9 && RETRYABLE.includes(errCode(e) ?? "")) { Bun.sleepSync(15); continue; }
      if (errCode(e) === "ENOENT") return { exists: false, secrets: EMPTY, entries: NO_ENTRIES };
      return { exists: true, secrets: EMPTY, entries: NO_ENTRIES, problem: `${SECRETS_FILE} cannot be read (${errCode(e) ?? String(e).slice(0, 80)})` };
    }
  }
  try {
    const st = fstatSync(fd);
    const store = storeFor(dir);
    if (!store) return { exists: true, secrets: EMPTY, entries: NO_ENTRIES, problem: `no OS vault backend on ${process.platform}` };
    const sig = `${st.mtimeMs}:${st.size}`;
    let master = masterForRead(dir, store, sig);
    const memo = reads.get(dir);
    if (Buffer.isBuffer(master) && memo && memo.mtimeMs === st.mtimeMs && memo.size === st.size && memo.kid === kidOf(master)) {
      return { exists: true, secrets: memo.secrets, entries: memo.entries, version: memo.version };
    }
    const bad = failures.get(dir);
    if (Buffer.isBuffer(master) && bad && bad.sig === sig && bad.kid === kidOf(master)) return { exists: true, secrets: EMPTY, entries: NO_ENTRIES, problem: bad.problem };
    let sealed: unknown = null;
    try { sealed = JSON.parse(readFileSync(fd, "utf8")); } catch { /* openVault names the bad shape */ }
    // A cached key that no longer opens the file (another engine replaced the vault) is re-read once.
    for (let attempt = 0; ; attempt++) {
      if (!Buffer.isBuffer(master)) {
        return { exists: true, secrets: EMPTY, entries: NO_ENTRIES, problem: master.missing === "absent" ? "the master key for this vault is missing" : `the master key could not be read (${master.detail ?? master.missing})` };
      }
      const key: Buffer = master;
      try {
        const opened = openVault(key, sealed, st.mtimeMs);
        const entries = freezeEntries(opened.entries);
        const secrets = Object.freeze(valuesOf(entries));
        reads.set(dir, { mtimeMs: st.mtimeMs, size: st.size, kid: kidOf(key), version: opened.version, secrets, entries });
        return { exists: true, secrets, entries, version: opened.version };
      } catch (e) {
        const fips = fipsRefusal(e);
        if (fips) return { exists: true, secrets: EMPTY, entries: NO_ENTRIES, problem: fips }; // not cached: policy may change
        if (e instanceof VaultFormatTooNewError) return { exists: true, secrets: EMPTY, entries: NO_ENTRIES, problem: e.message };
        if (attempt === 0) { masters.delete(dir); master = masterForRead(dir, store, sig); continue; }
        const problem = `${SECRETS_FILE} could not be decrypted: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
        failures.set(dir, { sig, kid: kidOf(key), problem });
        return { exists: true, secrets: EMPTY, entries: NO_ENTRIES, problem };
      }
    }
  } catch (e) {
    const fips = fipsRefusal(e); // sha256 (key id, Keychain account) refused before any decrypt
    if (fips) return { exists: true, secrets: EMPTY, entries: NO_ENTRIES, problem: fips };
    throw e;
  } finally { closeSync(fd); }
}

function freezeEntries(entries: Record<string, VaultEntry>): VaultEntries {
  for (const e of Object.values(entries)) Object.freeze(e);
  return Object.freeze(entries);
}

/** A change to the vault: refs to set (to these values) and refs to delete. Refs it does not name keep
 *  whatever the vault holds, whoever wrote them. `meta[ref]` sets metadata for a ref in `set` (fields it
 *  leaves out keep the stored value, or the inferred default for a new ref); `source` is the source a NEW
 *  ref gets when its patch names none (default "typed"). A ref whose value and metadata come out equal is
 *  left as it is (its `updatedAt` does not move). */
export interface VaultDelta { set: Record<string, string>; del: string[]; meta?: Record<string, VaultMetaPatch>; source?: VaultSource }

/** Apply `delta` to the vault under `secrets.lock`: the current map is read FRESH from disk and decrypted
 *  inside the lock, the delta is applied to it, the result is sealed, written atomically, read back and
 *  verified, and only then is the lock released. Creates the master key on first use, and ONLY then: with
 *  `secrets.v1.json` or any `.unreadable-<ts>` copy on disk and no key record, this throws ("master key
 *  missing for an existing vault") instead of minting one (the explicit reset is moving those files out).
 *  An existing file this account's (successfully read) master key cannot open is renamed aside to
 *  `secrets.v1.json.unreadable-<ts>` and the delta applies to an empty map; it is never overwritten. A file
 *  in a newer format (VaultFormatTooNewError) is never set aside: the write throws and the file is left
 *  alone. A master key that cannot be read throws, and so does a FIPS-required refusal (the file is left alone).
 *  Throws on any failure, so a caller may strip its plaintext copy only after this returns. Returns the
 *  map now in the vault (unchanged maps are not rewritten). */
export function updateVault(vaultDir: string, delta: VaultDelta): Readonly<Record<string, string>> {
  return Object.freeze(valuesOf(mutateVault(vaultDir, () => delta)));
}

/** updateVault with the delta computed INSIDE the lock from the freshly decrypted entries, for writes that
 *  depend on what the vault holds right now (newer-wins imports, rotate-if-present). Same guarantees. */
export function mutateVault(vaultDir: string, plan: (current: VaultEntries) => VaultDelta): VaultEntries {
  if (typeof Bun === "undefined") throw new Error(NO_BUN.detail);
  const dir = resolve(vaultDir);
  const store = storeFor(dir);
  if (!store) throw new Error(`no OS vault backend on ${process.platform}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withFileLock(join(dir, SECRETS_LOCK), () => {
    // Security review VAULT-MASTER-RECREATE: a key is minted only for a directory holding no sealed data.
    // Inside secrets.lock no other engine can create or set aside a secrets file, so this check holds.
    const sealed = sealedFilesIn(dir);
    const master = ensureMasterKey(store, dir, { mayCreate: sealed.length === 0 }); // fresh from the OS: never a cached miss or an old key
    if (!Buffer.isBuffer(master)) {
      masters.delete(dir);
      if (master.missing === "absent" && sealed.length) {
        throw new Error(`${MASTER_MISSING} (${sealed.join(", ")} in ${dir}): a new master key is never minted over sealed data; restore the OS key record, or move those files out of the directory to start an empty vault (ADR-0474)`);
      }
      throw new Error(`the vault master key is ${master.missing}${master.detail ? ` (${master.detail})` : ""}`);
    }
    masters.set(dir, { at: Date.now(), read: master, fileSig: NO_FILE });
    const file = secretsPath(dir);
    const now = Date.now();
    let prior: Buffer | null = null;
    try { prior = withRetry(() => readFileSync(file)); } catch (e) { if (errCode(e) !== "ENOENT") throw e; }
    let current: Record<string, VaultEntry> = {};
    if (prior) {
      try { current = openVault(master, JSON.parse(prior.toString("utf8")), now).entries; } catch (e) {
        if (e instanceof FipsRequiredError) throw e; // a policy refusal says nothing about the file: never set it aside
        if (e instanceof VaultFormatTooNewError) throw e; // another engine's newer format: unreadable here, never touched
        const aside = `${file}.unreadable-${Date.now()}`;
        withRetry(() => renameSync(file, aside));
        console.error(`[vault] ${file} could not be opened with this account's master key (${String((e as Error)?.message ?? e).slice(0, 160)}); kept it as ${aside} and started a fresh vault.`);
        prior = null;
        current = {};
      }
    }
    const delta = plan(freezeEntries(structuredClone(current)));
    const next: Record<string, VaultEntry> = { ...current };
    for (const ref of delta.del) delete next[ref];
    for (const [ref, value] of Object.entries(delta.set)) {
      if (typeof value !== "string" || !value) throw new Error(`refusing to store an empty value for ${ref}`);
      const prev = current[ref];
      // An explicit `undefined` in a patch means "not given", never "clear the stored field".
      const patch: VaultMetaPatch = Object.fromEntries(Object.entries(delta.meta?.[ref] ?? {}).filter(([, v]) => v !== undefined));
      const base: Partial<VaultEntryMeta> = prev ? metaOf(prev) : { source: delta.source ?? "typed", addedAt: now };
      const merged = canonEntry(ref, value, { ...base, ...patch, updatedAt: prev?.updatedAt ?? now }, now, delta.source ?? "typed");
      const same = prev !== undefined && JSON.stringify(merged) === JSON.stringify(prev);
      next[ref] = same ? prev : canonEntry(ref, value, { ...base, ...patch, updatedAt: patch.updatedAt ?? now }, now, delta.source ?? "typed");
    }
    const refs = Object.keys(next);
    const unchanged = refs.length === Object.keys(current).length && refs.every((r) => current[r] === next[r]);
    // Nothing to write: a v1 file stays v1 until a real change, and an empty no-op never creates a file.
    if (unchanged && (prior || refs.length === 0)) return freezeEntries(next);
    const st = writeAtomic(file, JSON.stringify(sealEntries(master, next), null, 2));
    const back = openVault(master, JSON.parse(readFileSync(file, "utf8")), now).entries;
    if (Object.keys(back).length !== refs.length || refs.some((r) => JSON.stringify(back[r]) !== JSON.stringify(next[r]))) {
      throw new Error("the vault did not read back what was written");
    }
    const entries = freezeEntries(back);
    reads.set(dir, { mtimeMs: st.mtimeMs, size: st.size, kid: kidOf(master), version: 2, secrets: Object.freeze(valuesOf(entries)), entries });
    return entries;
  });
}

/** Custody of the vault for a directory, for the Settings note and the logs. `ok` means secrets are (or
 *  on the next save will be) sealed by the OS backend. Without a secrets file, a backend that cannot be
 *  reached reports `unavailable` (nothing is lost; saves stay in the user-only file). */
export function vaultStatus(vaultDir: string): VaultStatus {
  if (typeof Bun === "undefined") return NO_BUN;
  const dir = resolve(vaultDir);
  let store: OsKeyStore | null;
  try { store = storeFor(dir); } catch (e) {
    const fips = fipsRefusal(e);
    if (fips) return { custody: "plaintext-file", state: "unreadable", detail: fips };
    throw e;
  }
  const v = readVault(dir);
  if (v.problem) return { custody: store?.kind ?? "plaintext-file", state: "unreadable", detail: v.problem };
  if (!store) return { custody: "plaintext-file", state: "unavailable", detail: `no OS vault backend on ${process.platform}` };
  if (v.exists) return { custody: store.kind, state: "ok" };
  const m = masterForRead(dir, store, NO_FILE);
  if (Buffer.isBuffer(m)) return { custody: store.kind, state: "ok" };
  if (m.missing === "absent") {
    // Set-aside sealed files with no key record: a write would be refused (mutateVault), so say so.
    let sealed: string[];
    try { sealed = sealedFilesIn(dir); } catch (e) { return { custody: store.kind, state: "unreadable", detail: String((e as Error)?.message ?? e).slice(0, 160) }; }
    return sealed.length ? { custody: store.kind, state: "unreadable", detail: `${MASTER_MISSING} (${sealed.join(", ")})` } : { custody: store.kind, state: "ok" };
  }
  return { custody: "plaintext-file", state: "unavailable", detail: m.detail ?? `master key ${m.missing}` };
}
