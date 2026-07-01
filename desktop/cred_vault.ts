// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/cred_vault.ts
//
// P-NETWL.1 (ADR-0106): the OS-encrypted credential vault behind the network whitelist. When a whitelisted
// endpoint needs auth (a JWT/OAuth/SAML token, a PEM key, an API key, or a username/password), the SECRET
// is stored here - encrypted at rest by the operating system's own key store (Electron `safeStorage`, which
// is DPAPI-backed on Windows, Keychain on macOS, and libsecret on Linux). The whitelist entry itself only
// ever carries an opaque `vaultRef` (see network_whitelist.ts AuthRef); the secret never touches the config
// JSON, and the renderer never receives the plaintext back (decrypt stays main-process-only, for future
// request injection).
//
// FAIL-CLOSED, NON-NEGOTIABLE: if OS encryption is not available, storing a secret THROWS. There is no
// plaintext fallback - a security product must never silently write a token in the clear. (Contrast the
// legacy API-key store in settings_store.ts, which is plaintext-at-0600; this vault is the correct home for
// anything new and secret.)
//
// This module is dependency-injected (SafeStorageLike + VaultIo) so it unit-tests without Electron or a real
// filesystem. main.ts wires the real `safeStorage` and node:fs; the tests pass fakes.

import type { AuthKind } from "./network_whitelist.ts";

/** The slice of Electron's `safeStorage` we depend on. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** The filesystem operations the vault needs, injected for testability. */
export interface VaultIo {
  ensureDir(dir: string): void;
  writeFile(path: string, data: Buffer): void;
  readFile(path: string): Buffer;
  exists(path: string): boolean;
  remove(path: string): void;
  /** Base names (not full paths) of files directly under `dir`; [] if the dir is absent. */
  list(dir: string): string[];
}

/** Non-secret metadata about a stored credential - safe to return to the renderer for listing. `last4` is at
 *  MOST the last four characters, kept so the UI can identify WHICH key it is without revealing it. The
 *  rotation fields (P-KEYS.2, ADR-0107) drive the UI's rotation VISIBILITY - all non-secret timestamps/counts. */
export interface CredMeta {
  ref: string;
  kind: AuthKind;
  label?: string;
  last4?: string;
  createdAt?: number;
  rotatedAt?: number;           // when the secret was last set/rotated (defaults to createdAt)
  expiresAt?: number;           // optional hard expiry (epoch ms)
  rotationIntervalDays?: number; // optional policy: rotate every N days (drives "rotation due")
}

/** P-KEYS.1 (ADR-0107): derive the non-secret last-4 identifier from a secret. Never returns more than four
 *  characters. For a PEM/cert the armor lines are stripped so it identifies the KEY (base64 body), not the
 *  boilerplate header. Trailing whitespace/newlines are ignored so a copy-pasted token isn't mis-tailed.
 *  Pure. A secret shorter than 4 chars (never a real credential) returns as-is. */
export function deriveLast4(secret: string, kind?: AuthKind): string {
  let s = (secret ?? "").replace(/\s+$/, "");
  if (kind === "pem") {
    const body = s.replace(/-----[^-]*-----/g, "").replace(/\s+/g, "");
    if (body) s = body;
  }
  s = s.trim();
  return s.length <= 4 ? s : s.slice(-4);
}

export interface StoreCredentialInput {
  ref?: string;        // optional caller-supplied id; else one is minted
  kind: AuthKind;
  secret: string;      // the plaintext to encrypt - NEVER persisted in the clear
  label?: string;      // non-secret display label (e.g. "prod JWT")
  createdAt?: number;
  expiresAt?: number;            // optional hard expiry (epoch ms)
  rotationIntervalDays?: number; // optional "rotate every N days" policy
}

/** A vault ref is used as a filename; keep it to a safe, traversal-proof charset. */
const REF_RE = /^[A-Za-z0-9_-]{1,120}$/;
export function isValidRef(ref: string): boolean {
  return typeof ref === "string" && REF_RE.test(ref);
}

const path = (dir: string, ref: string, ext: string): string => `${dir}/${ref}.${ext}`;

/** Encrypt + persist a secret. Returns its non-secret metadata.
 *  THROWS if OS encryption is unavailable (fail-closed - no plaintext fallback) or the ref is invalid. */
export function storeCredential(ss: SafeStorageLike, io: VaultIo, dir: string, input: StoreCredentialInput): CredMeta {
  if (!ss.isEncryptionAvailable()) throw new Error("os-encryption-unavailable");
  const ref = input.ref && input.ref.length ? input.ref : mintRef(input.kind, input.createdAt);
  if (!isValidRef(ref)) throw new Error("invalid-ref");
  if (typeof input.secret !== "string" || input.secret.length === 0) throw new Error("empty-secret");
  const meta: CredMeta = { ref, kind: input.kind, createdAt: input.createdAt, rotatedAt: input.createdAt, last4: deriveLast4(input.secret, input.kind) };
  if (input.label) meta.label = input.label;
  if (input.expiresAt != null) meta.expiresAt = input.expiresAt;
  if (input.rotationIntervalDays != null) meta.rotationIntervalDays = input.rotationIntervalDays;
  io.ensureDir(dir);
  const enc = ss.encryptString(input.secret); // Buffer of OS-encrypted bytes
  io.writeFile(path(dir, ref, "bin"), enc);
  io.writeFile(path(dir, ref, "meta.json"), Buffer.from(JSON.stringify(meta), "utf8"));
  return meta;
}

/** Decrypt a stored secret. MAIN-PROCESS ONLY - never expose this to the renderer. Returns null if the
 *  ref is unknown/invalid or decryption fails (fail-closed: a corrupt blob yields nothing, not garbage). */
export function readCredential(ss: SafeStorageLike, io: VaultIo, dir: string, ref: string): string | null {
  if (!isValidRef(ref)) return null;
  const p = path(dir, ref, "bin");
  if (!io.exists(p)) return null;
  try {
    if (!ss.isEncryptionAvailable()) return null;
    return ss.decryptString(io.readFile(p));
  } catch { return null; }
}

/** Non-secret listing for the UI. Skips any entry whose metadata can't be read. */
export function listCredentials(io: VaultIo, dir: string): CredMeta[] {
  const out: CredMeta[] = [];
  for (const name of io.list(dir)) {
    if (!name.endsWith(".meta.json")) continue;
    const ref = name.slice(0, -".meta.json".length);
    if (!isValidRef(ref)) continue;
    try {
      const m = JSON.parse(io.readFile(path(dir, ref, "meta.json")).toString("utf8")) as CredMeta;
      if (m && typeof m.ref === "string") out.push({ ref: m.ref, kind: m.kind, label: m.label, last4: m.last4, createdAt: m.createdAt, rotatedAt: m.rotatedAt, expiresAt: m.expiresAt, rotationIntervalDays: m.rotationIntervalDays });
    } catch { /* skip unreadable metadata */ }
  }
  return out;
}

export interface RotateCredentialInput {
  ref: string;
  secret: string;      // the NEW secret to encrypt
  rotatedAt?: number;  // rotation timestamp (defaults handled by caller/main)
  expiresAt?: number;  // optional new expiry
}

/** P-KEYS.2 (ADR-0107): rotate an existing credential IN PLACE - re-encrypt the new secret under the SAME
 *  `ref` (so whitelist entries that reference it never break), bump `rotatedAt`, refresh `last4`, and preserve
 *  the kind/label/createdAt/rotationIntervalDays. Returns the updated metadata, or null if the ref is unknown.
 *  THROWS if OS encryption is unavailable (fail-closed - the old secret is left untouched, never replaced by
 *  plaintext). */
export function rotateCredential(ss: SafeStorageLike, io: VaultIo, dir: string, input: RotateCredentialInput): CredMeta | null {
  if (!isValidRef(input.ref)) return null;
  const metaPath = path(dir, input.ref, "meta.json");
  if (!io.exists(metaPath)) return null; // nothing to rotate
  if (!ss.isEncryptionAvailable()) throw new Error("os-encryption-unavailable");
  if (typeof input.secret !== "string" || input.secret.length === 0) throw new Error("empty-secret");
  let prev: CredMeta;
  try { prev = JSON.parse(io.readFile(metaPath).toString("utf8")) as CredMeta; }
  catch { return null; }
  const meta: CredMeta = {
    ...prev,
    ref: input.ref,
    last4: deriveLast4(input.secret, prev.kind),
    rotatedAt: input.rotatedAt,
    ...(input.expiresAt != null ? { expiresAt: input.expiresAt } : {}),
  };
  const enc = ss.encryptString(input.secret);
  io.writeFile(path(dir, input.ref, "bin"), enc);       // overwrite the old ciphertext
  io.writeFile(metaPath, Buffer.from(JSON.stringify(meta), "utf8"));
  return meta;
}

/** Pure (P-KEYS.2, ADR-0107): the rotation/expiry posture of a credential at time `now`. All non-secret. */
export interface RotationStatus {
  ageDays?: number;       // days since the secret was last set/rotated
  overdue: boolean;       // past its rotationIntervalDays
  dueInDays?: number;     // days until the next rotation is due (negative when overdue)
  expired: boolean;       // past expiresAt
  expiresInDays?: number; // days until expiry (negative when expired)
}
const DAY_MS = 86_400_000;
export function rotationStatus(meta: Pick<CredMeta, "rotatedAt" | "createdAt" | "expiresAt" | "rotationIntervalDays">, now: number): RotationStatus {
  const rotatedAt = meta.rotatedAt ?? meta.createdAt;
  const ageDays = rotatedAt != null ? Math.floor((now - rotatedAt) / DAY_MS) : undefined;
  let overdue = false, dueInDays: number | undefined;
  if (meta.rotationIntervalDays != null && meta.rotationIntervalDays > 0 && rotatedAt != null) {
    const dueAt = rotatedAt + meta.rotationIntervalDays * DAY_MS;
    dueInDays = Math.ceil((dueAt - now) / DAY_MS);
    overdue = now >= dueAt;
  }
  const expired = meta.expiresAt != null ? now >= meta.expiresAt : false;
  const expiresInDays = meta.expiresAt != null ? Math.ceil((meta.expiresAt - now) / DAY_MS) : undefined;
  return { ageDays, overdue, dueInDays, expired, expiresInDays };
}

/** Pure: a short human label + severity tone for the rotation badge. Worst state wins. */
export function rotationLabel(s: RotationStatus): { text: string; tone: "ok" | "warn" | "danger" } {
  if (s.expired) return { text: "expired", tone: "danger" };
  if (s.overdue) return { text: "rotation due", tone: "danger" };
  if (s.expiresInDays != null && s.expiresInDays <= 7) return { text: `expires in ${Math.max(0, s.expiresInDays)}d`, tone: "warn" };
  if (s.dueInDays != null && s.dueInDays <= 7) return { text: `rotate in ${Math.max(0, s.dueInDays)}d`, tone: "warn" };
  if (s.ageDays != null) return { text: `rotated ${s.ageDays}d ago`, tone: "ok" };
  return { text: "", tone: "ok" };
}

/** Delete a secret + its metadata. Returns true if the blob existed. */
export function deleteCredential(io: VaultIo, dir: string, ref: string): boolean {
  if (!isValidRef(ref)) return false;
  const bin = path(dir, ref, "bin");
  const existed = io.exists(bin);
  try { if (existed) io.remove(bin); } catch { /* best-effort */ }
  try { const m = path(dir, ref, "meta.json"); if (io.exists(m)) io.remove(m); } catch { /* best-effort */ }
  return existed;
}

/** Mint a filename-safe ref. Not security-sensitive (it's a public handle), just needs to be unique-ish. */
function mintRef(kind: AuthKind, createdAt?: number): string {
  const stamp = typeof createdAt === "number" ? createdAt : Date.now();
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `cred_${kind}_${stamp.toString(36)}_${rand}`;
}
