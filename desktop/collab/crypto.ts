// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/crypto.ts — P-COLLAB.1 (ADR-0192): the end-to-end seal for live-collaboration frames.
//
// LUCID collaborates by extending omp's transport, never forking it (invariant #1): the room key lives ONLY
// in the invite-link fragment, so the relay only ever sees opaque bytes. The sealed layout mirrors omp's
// collab/crypto.ts exactly - `[12B IV][AES-256-GCM ciphertext + tag]` via WebCrypto - and the key/token byte
// sizes come from `@oh-my-pi/pi-wire`, so LUCID stays wire-compatible with omp's relay + a future omp guest.
//
// PURE + DOM-free: WebCrypto is available in Bun and the renderer, so this is fully testable headless.

import { ROOM_KEY_BYTES, WRITE_TOKEN_BYTES, ENVELOPE_HEADER_LENGTH } from "@oh-my-pi/pi-wire";
import type { LucidCollabFrame } from "./frames.ts";

const AES = "AES-GCM";
const IV_LENGTH = 12;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A fresh 32-byte room key (the E2E secret carried in the link fragment). */
export function generateRoomKey(): Uint8Array {
  const key = new Uint8Array(ROOM_KEY_BYTES);
  crypto.getRandomValues(key);
  return key;
}

/** A fresh 16-byte write token (present only in a FULL link; a view link omits it). */
export function generateWriteToken(): Uint8Array {
  const token = new Uint8Array(WRITE_TOKEN_BYTES);
  crypto.getRandomValues(token);
  return token;
}

/** Import raw room-key bytes into a non-extractable AES-GCM CryptoKey. Async so a bad size REJECTS (not a
 *  sync throw), matching seal/open. */
export async function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== ROOM_KEY_BYTES) throw new Error(`room key must be ${ROOM_KEY_BYTES} bytes, got ${raw.byteLength}`);
  return crypto.subtle.importKey("raw", strict(raw), AES, false, ["encrypt", "decrypt"]);
}

/** Seal a frame: `[12B random IV][AES-256-GCM ciphertext + tag]`. The relay cannot read it. */
export async function seal(key: CryptoKey, frame: LucidCollabFrame): Promise<Uint8Array> {
  const iv = new Uint8Array(IV_LENGTH);
  crypto.getRandomValues(iv);
  const plaintext = enc.encode(JSON.stringify(frame));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: AES, iv }, key, plaintext));
  const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(ciphertext, IV_LENGTH);
  return out;
}

/** Inverse of {@link seal}. Throws on auth failure, tamper, or a too-short buffer (fail-closed). */
export async function open(key: CryptoKey, data: Uint8Array): Promise<LucidCollabFrame> {
  if (data.byteLength <= IV_LENGTH) throw new Error("sealed frame too short");
  const iv = strict(data.subarray(0, IV_LENGTH));
  const ciphertext = strict(data.subarray(IV_LENGTH));
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: AES, iv }, key, ciphertext));
  return JSON.parse(dec.decode(plaintext)) as LucidCollabFrame;
}

/** Prepend the sender's peer id (4-byte big-endian) to a sealed payload — the relay's only plaintext view. */
export function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array {
  const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
  new DataView(out.buffer).setUint32(0, peerId >>> 0, false); // big-endian
  out.set(sealed, ENVELOPE_HEADER_LENGTH);
  return out;
}

/** Split a wire envelope back into `{ peerId, sealed }`. Throws if it is shorter than the header. */
export function unpackEnvelope(buf: Uint8Array): { peerId: number; sealed: Uint8Array } {
  if (buf.byteLength < ENVELOPE_HEADER_LENGTH) throw new Error("envelope too short");
  const peerId = new DataView(strict(buf).buffer, strict(buf).byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
  return { peerId, sealed: buf.subarray(ENVELOPE_HEADER_LENGTH) };
}

// WebCrypto wants a `BufferSource` = an ArrayBuffer-backed, zero-offset, full-length view; copy when a
// subarray view isn't. The `Uint8Array<ArrayBuffer>` return also satisfies TS 6's stricter BufferSource
// (a bare `Uint8Array` is `Uint8Array<ArrayBufferLike>`, which no longer matches).
function strict(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
