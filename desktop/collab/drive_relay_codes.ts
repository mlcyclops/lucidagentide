// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/drive_relay_codes.ts — P-REMOTE.10 (ADR-0233): the SECURE core of out-of-band reconnect.
//
// When a Session Share drops (app closed, or the relay room torn down past the 30s re-claim grace) the live
// invite link is gone. This lets LUCID append the CURRENT reconnect link to a single file in the user's own
// Google Drive (`lucid_relay_codes`, scoped `drive.file` so LUCID can touch ONLY that file). A disconnected
// user — or a teammate the file is shared with — reads the latest code to rejoin.
//
// This module is PURE + DOM-free (WebCrypto only) so the file format, the optional PIN encryption, and the
// view-vs-edit link selection are unit-tested headless. The Drive REST calls live in drive_file.ts; the OAuth
// token acquisition is a separate seam (the app supplies a `drive.file` access token).
//
// SECURITY: a reconnect code carries the room's E2E secret (in the link), so the file IS a credential store.
// Hardening: (1) `drive.file` scope — LUCID cannot read the user's other Drive files; (2) OPTIONAL PIN
// encryption at rest (AES-256-GCM, key derived by PBKDF2-SHA256) so even someone who over-shares the file
// can't use a code without the PIN; (3) codes expire; (4) sharing is Drive-native, per-file, revocable.

/** One reconnect entry. The `link` carries the real E2E secret; `roomId` is metadata only. */
export interface RelayCode {
  ts: number;        // when written (epoch ms)
  roomId: string;    // the relay room id (metadata; the link holds the actual key)
  expiryMs: number;  // absolute epoch ms after which this code is stale (a code also dies with its room)
  link: string;      // the invite link to reconnect with (view-only or edit)
  edit: boolean;     // true when `link` is an edit (drive-capable) link
}

export const RELAY_FILE_NAME = "lucid_relay_codes";
export const DEFAULT_CODE_TTL_MS = 12 * 60 * 60 * 1000; // 12h safety cap
const MAX_CODES = 20;
const PBKDF2_ITERS = 210_000;
const ENVELOPE_VERSION = 1;

// ── link selection (decision 3: view by default; edit if the share is/was an edit share) ──
export function chooseReconnectLink(opts: { allowEdit?: boolean; fullLink?: string | null; viewLink?: string | null; lastWasEdit?: boolean }): { link: string; edit: boolean } | null {
  const wantEdit = opts.allowEdit === true || opts.lastWasEdit === true;
  if (wantEdit && opts.fullLink) return { link: opts.fullLink, edit: true };
  if (opts.viewLink) return { link: opts.viewLink, edit: false };
  if (opts.fullLink) return { link: opts.fullLink, edit: true }; // only an edit link exists
  return null;
}

export function buildCode(link: string, edit: boolean, roomId: string, now: number, ttlMs: number = DEFAULT_CODE_TTL_MS): RelayCode {
  return { ts: now, roomId, expiryMs: now + ttlMs, link, edit };
}

/** Append a code, keeping at most `cap` (oldest dropped) — the file stays bounded. */
export function appendCode(codes: RelayCode[], code: RelayCode, cap: number = MAX_CODES): RelayCode[] {
  const next = [...codes, code];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** The freshest non-expired code (what a reconnecting client uses). */
export function latestValidCode(codes: RelayCode[], now: number): RelayCode | null {
  let best: RelayCode | null = null;
  for (const c of codes) if (c.expiryMs > now && (!best || c.ts > best.ts)) best = c;
  return best;
}

// ── untrusted-JSON validation (no `any`: unknown + narrowing) ──
function isRelayCode(v: unknown): v is RelayCode {
  return !!v && typeof v === "object"
    && "ts" in v && typeof v.ts === "number"
    && "roomId" in v && typeof v.roomId === "string"
    && "expiryMs" in v && typeof v.expiryMs === "number"
    && "link" in v && typeof v.link === "string"
    && "edit" in v && typeof v.edit === "boolean";
}
export function parseCodes(value: unknown): RelayCode[] {
  return Array.isArray(value) ? value.filter(isRelayCode) : [];
}

// ── base64 <-> bytes (small payloads; btoa/atob exist in Bun + the browser) ──
function bytesToB64(bytes: Uint8Array): string { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function b64ToBytes(s: string): Uint8Array { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

async function deriveKey(pin: string, salt: BufferSource): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM encrypt with a PIN-derived key; the blob packs [version][16B salt][12B iv][ciphertext]. */
async function encryptString(plain: string, pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  const env = new Uint8Array(1 + 16 + 12 + ct.length);
  env[0] = ENVELOPE_VERSION; env.set(salt, 1); env.set(iv, 17); env.set(ct, 29);
  return bytesToB64(env);
}

/** Decrypt; returns null on a wrong PIN, tamper, or malformed blob (fail-closed — never throws). */
async function decryptString(blob: string, pin: string): Promise<string | null> {
  try {
    const env = b64ToBytes(blob);
    if (env.length < 30 || env[0] !== ENVELOPE_VERSION) return null;
    const salt = env.slice(1, 17), iv = env.slice(17, 29), ct = env.slice(29);
    const key = await deriveKey(pin, salt);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch { return null; }
}

/** The whole Drive-file body: a versioned envelope, plaintext JSON or a PIN-encrypted blob. */
export async function buildFileContent(codes: RelayCode[], pin?: string | null): Promise<string> {
  const payload = JSON.stringify(codes);
  return pin
    ? JSON.stringify({ v: ENVELOPE_VERSION, enc: "pin", data: await encryptString(payload, pin) })
    : JSON.stringify({ v: ENVELOPE_VERSION, enc: "none", data: payload });
}

/** Parse the Drive-file body back to codes; returns null when it's encrypted and the PIN is absent/wrong. */
export async function readFileContent(text: string, pin?: string | null): Promise<RelayCode[] | null> {
  let file: unknown;
  try { file = JSON.parse(text); } catch { return null; }
  if (!file || typeof file !== "object" || !("enc" in file) || !("data" in file)) return null;
  const enc = file.enc, data = file.data;
  if (typeof data !== "string") return null;
  if (enc === "pin") {
    if (!pin) return null;
    const plain = await decryptString(data, pin);
    if (plain === null) return null;
    try { return parseCodes(JSON.parse(plain)); } catch { return null; }
  }
  if (enc === "none") { try { return parseCodes(JSON.parse(data)); } catch { return null; } }
  return null;
}

/** Whether a file body is PIN-encrypted, so the UI knows to prompt for a PIN before reading. */
export function fileIsEncrypted(text: string): boolean {
  try { const f: unknown = JSON.parse(text); return !!f && typeof f === "object" && "enc" in f && f.enc === "pin"; } catch { return false; }
}

// -- P-REMOTE.10c (ADR-0235): the READER state machine --

/** The outcome of resolving a Drive relay-codes file to a reconnect link \u2014 the exact set of states a reader
 *  UI (desktop or PWA) branches on. Fail-closed: an encrypted file with no/wrong PIN NEVER yields a link. */
export type ReconnectResolution =
  | { status: "ok"; link: string; edit: boolean } // the freshest non-expired code
  | { status: "locked" }   // encrypted + no PIN supplied yet \u2192 prompt for one
  | { status: "bad-pin" }  // encrypted + the supplied PIN was wrong (or the blob is tampered)
  | { status: "expired" }  // decrypted, but every code is stale (room long gone)
  | { status: "empty" };   // no codes / unreadable body (nothing to reconnect to)

/** Resolve a Drive relay-codes file body to the freshest usable reconnect link, as a UX state machine. Purely
 *  composes fileIsEncrypted + readFileContent + latestValidCode so the reader UI stays a thin switch and the
 *  security-critical branches (locked / bad-pin never leak a link) are unit-tested headless. */
export async function resolveReconnect(text: string, pin: string | null, now: number): Promise<ReconnectResolution> {
  const encrypted = fileIsEncrypted(text);
  if (encrypted && !pin) return { status: "locked" };
  const codes = await readFileContent(text, pin);
  if (codes === null) return encrypted ? { status: "bad-pin" } : { status: "empty" };
  const latest = latestValidCode(codes, now);
  if (!latest) return codes.length ? { status: "expired" } : { status: "empty" };
  return { status: "ok", link: latest.link, edit: latest.edit };
}
