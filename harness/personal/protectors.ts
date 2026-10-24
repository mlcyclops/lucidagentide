// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/personal/protectors.ts — the Lucid Vault Protector Spec v1 for the personal knowledge graph
// (P-KGBIO.1, ADR-0454; spec: LUCIDMeetingHub docs/VAULT_QUICK_UNLOCK_PROPOSAL.md §3-§4, as shipped by the
// Hub in src/vault_protectors.py).
//
// BitLocker's model. The store's data-encryption key IS the spec's Vault Master Key (VMK): 32 random bytes
// that never reach disk in the clear. Every protector keeps its OWN AES-256-GCM wrapping of it, so adding
// Windows Hello, Touch ID or (later) a CAC is one more wrapped copy of the same key, with no data rewrite.
//
// Wire format (byte-compatible with the Hub; a Hub-written fixture is pinned in protectors.test.ts):
//   { "version": 1,
//     "vmk_check": Fernet token of "LUCID_VMK_V1" under the VMK (proves a candidate VMK before any data opens),
//     "protectors": [ { "id", "type", "created", "label", "wrapped_vmk" (b64 ct||tag), "nonce" (b64 12 B),
//                       ...type fields } ] }
//   AAD of every wrap = "lucid-vmk-v1|<id>|<type>", so a blob cannot be moved between entries.
//   Exactly ONE "password" protector (the mandatory recovery root: pbkdf2-sha256, 600k, 32-byte salt).
//
// FAIL CLOSED: an unknown version or type, a missing field, a duplicate id, an absurd iteration count or a
// malformed file throws. None of them degrades into "fewer ways in". Nothing here logs a key or a blob.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { deriveKey, KDF_ITERS, KEY_LEN } from "./crypto.ts";

export const PROTECTORS_VERSION = 1 as const;
/** The types this build can unwrap: the mandatory `password`, `hello` (Windows Hello, spec §4.1) and `sep`
 *  (macOS Secure Enclave behind Touch ID, spec §4.4). */
export const PROTECTOR_TYPES = ["password", "hello", "sep"] as const;
export type ProtectorType = (typeof PROTECTOR_TYPES)[number];

const VMK_CHECK_PLAINTEXT = "LUCID_VMK_V1";
const PASSWORD_KDF_ALG = "pbkdf2-sha256";
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const MAX_ITERATIONS = 10_000_000; // a tampered file must not turn one unlock into an unbounded CPU burn
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface ProtectorEntry {
  id: string;
  type: ProtectorType;
  created: string;
  label: string;
  wrapped_vmk: string;
  nonce: string;
  /** password only */
  kdf?: { alg: typeof PASSWORD_KDF_ALG; iterations: number; salt: string };
  /** Type-specific public fields (hello: challenge, key_name; sep: se_key, eph_pub) and the IDE's
   *  `auto_unlock` preference. The Hub validator ignores fields it does not use. */
  [field: string]: unknown;
}
export interface ProtectorDoc { version: typeof PROTECTORS_VERSION; vmk_check: string; protectors: ProtectorEntry[] }

export type ProtectorErrorCode = "format" | "version" | "unsupported" | "auth";
export class ProtectorError extends Error {
  constructor(readonly code: ProtectorErrorCode, message: string) { super(message); this.name = "ProtectorError"; }
}

// ── Fernet (the spec's vmk_check is a Fernet token; https://github.com/fernet/spec) ──────────────────────
/** urlsafe base64 WITH padding, as Python's Fernet writes and requires. */
const b64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

export function makeVmkCheck(vmk: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", vmk.subarray(16, 32), iv);
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const body = Buffer.concat([Buffer.from([0x80]), ts, iv, cipher.update(VMK_CHECK_PLAINTEXT, "utf8"), cipher.final()]);
  return b64url(Buffer.concat([body, createHmac("sha256", vmk.subarray(0, 16)).update(body).digest()]));
}

export function vmkCheckOk(vmk: Buffer, token: string): boolean {
  try {
    const raw = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (vmk.length !== KEY_LEN || raw.length < 1 + 8 + 16 + 16 + 32 || raw[0] !== 0x80) return false;
    const body = raw.subarray(0, raw.length - 32);
    if (!timingSafeEqual(raw.subarray(raw.length - 32), createHmac("sha256", vmk.subarray(0, 16)).update(body).digest())) return false;
    const decipher = createDecipheriv("aes-128-cbc", vmk.subarray(16, 32), body.subarray(9, 25));
    return Buffer.concat([decipher.update(body.subarray(25)), decipher.final()]).toString("utf8") === VMK_CHECK_PLAINTEXT;
  } catch { return false; }
}

// ── wrapping ─────────────────────────────────────────────────────────────────────────────────────────────
const aad = (id: string, type: string): Buffer => Buffer.from(`lucid-vmk-v${PROTECTORS_VERSION}|${id}|${type}`, "utf8");

function wrap(kek: Buffer, vmk: Buffer, id: string, type: ProtectorType): { wrapped_vmk: string; nonce: string } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce);
  cipher.setAAD(aad(id, type));
  const ct = Buffer.concat([cipher.update(vmk), cipher.final(), cipher.getAuthTag()]); // ct||tag, as Python's AESGCM
  return { wrapped_vmk: ct.toString("base64"), nonce: nonce.toString("base64") };
}

/** The VMK from one entry, proven against the document's vmk_check. THROWS auth on a wrong KEK or a blob
 *  swapped in from another entry (GCM authenticates the AAD), format on a vmk_check mismatch. */
export function unwrapEntry(doc: ProtectorDoc, entry: ProtectorEntry, kek: Buffer): Buffer {
  const blob = Buffer.from(entry.wrapped_vmk, "base64");
  let vmk: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(entry.nonce, "base64"));
    decipher.setAAD(aad(entry.id, entry.type));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    vmk = Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]);
  } catch { throw new ProtectorError("auth", "that protector did not unwrap the vault key"); }
  if (vmk.length !== KEY_LEN) { vmk.fill(0); throw new ProtectorError("format", "the wrapped key is not a 32-byte VMK"); }
  if (!vmkCheckOk(vmk, doc.vmk_check)) { vmk.fill(0); throw new ProtectorError("format", "the protector file's vmk_check does not match the key it unwrapped"); }
  return vmk;
}

const stamp = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); // the Hub's utc_stamp shape

/** A new entry wrapping `vmk` under `kek`. `fields` carries the type's public parameters. */
export function newEntry(kek: Buffer, vmk: Buffer, type: ProtectorType, label: string, fields: Record<string, unknown> = {}, id = randomBytes(8).toString("hex")): ProtectorEntry {
  return { ...fields, id, type, created: stamp(), label, ...wrap(kek, vmk, id, type) };
}

function passwordEntry(vmk: Buffer, password: string, id?: string): ProtectorEntry {
  const salt = randomBytes(SALT_BYTES);
  const kek = deriveKey(password, salt, KDF_ITERS);
  try { return newEntry(kek, vmk, "password", "Password", { kdf: { alg: PASSWORD_KDF_ALG, iterations: KDF_ITERS, salt: salt.toString("base64") } }, id); }
  finally { kek.fill(0); }
}

// ── the document ─────────────────────────────────────────────────────────────────────────────────────────
/** A fresh document holding the mandatory password protector for `vmk`. */
export function createProtectors(vmk: Buffer, password: string): ProtectorDoc {
  return { version: PROTECTORS_VERSION, vmk_check: makeVmkCheck(vmk), protectors: [passwordEntry(vmk, password)] };
}

const passwordOf = (doc: ProtectorDoc): ProtectorEntry => doc.protectors.find((e) => e.type === "password")!; // parse guarantees exactly one

/** The VMK via the password protector. THROWS auth on a wrong password. */
export function unlockWithPassword(doc: ProtectorDoc, password: string): Buffer {
  const entry = passwordOf(doc);
  const kdf = entry.kdf!;
  const kek = deriveKey(password, Buffer.from(kdf.salt, "base64"), kdf.iterations);
  try { return unwrapEntry(doc, entry, kek); } finally { kek.fill(0); }
}

/** Re-wrap the SAME VMK under a new password (fresh salt, KEK and nonce; the entry keeps its id). Every
 *  other protector keeps working: a password change is not a key rotation. */
export function rewrapPassword(doc: ProtectorDoc, vmk: Buffer, newPassword: string): ProtectorDoc {
  const old = passwordOf(doc);
  return { ...doc, protectors: doc.protectors.map((e) => (e === old ? passwordEntry(vmk, newPassword, old.id) : e)) };
}

/** Add `entry`, replacing any existing entry of the same (non-password) type. */
export function withProtector(doc: ProtectorDoc, entry: ProtectorEntry): ProtectorDoc {
  if (entry.type === "password") throw new ProtectorError("format", "the password protector is replaced only by rewrapPassword");
  return { ...doc, protectors: [...doc.protectors.filter((e) => e.type !== entry.type), entry] };
}
/** Remove every entry of `type`. The password protector is irremovable. */
export function withoutProtector(doc: ProtectorDoc, type: Exclude<ProtectorType, "password">): ProtectorDoc {
  return { ...doc, protectors: doc.protectors.filter((e) => e.type !== type) };
}

/** Validate a parsed document, or throw. Never returns a partially understood store. */
export function parseProtectors(text: string): ProtectorDoc {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { throw new ProtectorError("format", "the protector file is not valid JSON"); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new ProtectorError("format", "the protector file is not an object");
  const { version, vmk_check: check, protectors: list } = doc as Record<string, unknown>;
  if (typeof version !== "number" || !Number.isInteger(version)) throw new ProtectorError("format", "the protector file has no usable version");
  if (version !== PROTECTORS_VERSION) throw new ProtectorError("version", `protector schema version ${version} is newer than this build understands (expected ${PROTECTORS_VERSION})`);
  if (typeof check !== "string" || !check) throw new ProtectorError("format", "the protector file has no vmk_check");
  if (!Array.isArray(list) || list.length === 0) throw new ProtectorError("format", "the protector file lists no protectors");
  const field = (e: Record<string, unknown>, f: string): string => {
    const v = e[f];
    if (typeof v !== "string" || !v.trim()) throw new ProtectorError("format", `protector field '${f}' is missing or not text`);
    return v;
  };
  const b64 = (e: Record<string, unknown>, f: string): void => { if (!B64.test(field(e, f))) throw new ProtectorError("format", `protector field '${f}' is not valid base64`); };
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProtectorError("format", "a protector entry is not an object");
    const e = raw as Record<string, unknown>;
    const id = field(e, "id");
    const type = field(e, "type");
    if (!(PROTECTOR_TYPES as readonly string[]).includes(type)) throw new ProtectorError("unsupported", `protector type '${type}' is not supported by this build`);
    if (seen.has(id)) throw new ProtectorError("format", "two protectors share one id");
    seen.add(id);
    field(e, "label"); field(e, "created"); b64(e, "wrapped_vmk"); b64(e, "nonce");
    if (type === "password") {
      const kdf = e.kdf;
      if (!kdf || typeof kdf !== "object") throw new ProtectorError("format", "the password protector has no kdf block");
      const k = kdf as Record<string, unknown>;
      if (k.alg !== PASSWORD_KDF_ALG) throw new ProtectorError("format", `unsupported password kdf '${String(k.alg)}'`);
      if (typeof k.iterations !== "number" || !Number.isInteger(k.iterations) || k.iterations < 1 || k.iterations > MAX_ITERATIONS) throw new ProtectorError("format", "the password protector has no usable iteration count");
      b64(k, "salt");
    }
    if (type === "hello") { b64(e, "challenge"); field(e, "key_name"); }
    if (type === "sep") { b64(e, "se_key"); b64(e, "eph_pub"); }
  }
  if (list.filter((e) => (e as ProtectorEntry).type === "password").length !== 1) throw new ProtectorError("format", "a vault must carry exactly one password protector - it is the mandatory recovery path");
  return doc as ProtectorDoc;
}

/** Read + validate the file. null when it does not exist; THROWS ProtectorError when it exists but is unusable. */
export function readProtectors(path: string): ProtectorDoc | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (e) { if ((e as { code?: string })?.code === "ENOENT") return null; throw new ProtectorError("format", "the protector file cannot be read"); }
  return parseProtectors(text);
}

/** Write atomically and durably (temp + fsync + rename): this file holds every wrapping of the VMK, so a
 *  truncated write would cost the store. Owner-only mode. */
export function writeProtectors(path: string, doc: ProtectorDoc): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, `${JSON.stringify(doc, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}
