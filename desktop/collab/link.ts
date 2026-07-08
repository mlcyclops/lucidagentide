// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/link.ts — P-COLLAB.1 (ADR-0192): the collab invite link.
//
// The link is the ONLY thing that grants access (E2E: the room key never touches the relay). Shape mirrors
// omp's: `<roomId>.<base64url(key [|| writeToken])>`. A FULL link (key + 16B write token) can prompt; a VIEW
// link (key only) is watch-only, so `writeToken` parses to null. We accept the three forms omp emits: the
// bare `roomId.secret`, the relay-path `host/r/roomId.secret`, and the browser `https://relay/#roomId.secret`
// (the secret rides the URL FRAGMENT so it never appears in an HTTP request). The dot-join (not `#`) matches
// omp's fix: RFC 3986 forbids a raw `#` inside a fragment and macOS percent-encodes a second `#`.
//
// PURE + DOM-free: base64url via the cross-env btoa/atob (present in Bun and the renderer). Testable headless.

import { ROOM_KEY_BYTES, WRITE_TOKEN_BYTES } from "@oh-my-pi/pi-wire";

export interface ParsedShareLink {
  roomId: string;
  key: Uint8Array; // 32 bytes
  writeToken: Uint8Array | null; // 16 bytes on a full link; null on a view link (read-only)
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh, URL-safe room id (16 random bytes, base64url). */
export function generateRoomId(): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  return b64urlEncode(raw);
}

/** Build the bare invite: `<roomId>.<base64url(key [|| writeToken])>`. Omit `writeToken` for a VIEW link. */
export function formatShareLink(roomId: string, key: Uint8Array, writeToken?: Uint8Array | null): string {
  if (key.byteLength !== ROOM_KEY_BYTES) throw new Error(`key must be ${ROOM_KEY_BYTES} bytes`);
  if (writeToken && writeToken.byteLength !== WRITE_TOKEN_BYTES) throw new Error(`write token must be ${WRITE_TOKEN_BYTES} bytes`);
  const secret = writeToken ? concat(key, writeToken) : key;
  return `${roomId}.${b64urlEncode(secret)}`;
}

/** Wrap a bare link into the browser deep link — the secret rides the fragment, never an HTTP request. */
export function formatBrowserLink(relayHttpBase: string, bareLink: string): string {
  return `${relayHttpBase.replace(/\/+$/, "")}/#${bareLink}`;
}

/** Parse any of the three forms into `{ roomId, key, writeToken }`. Throws on a malformed / wrong-size link
 *  (fail-closed: a bad link never yields a usable-looking half-parsed result). */
export function parseShareLink(input: string): ParsedShareLink {
  let s = (input ?? "").trim();
  if (!s) throw new Error("empty link");
  // browser form: take everything after the fragment
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(hash + 1);
  // relay-path form: `host/r/<roomId>.<secret>` -> keep the last path segment
  else if (s.includes("/r/")) s = s.slice(s.lastIndexOf("/r/") + 3);
  s = s.trim();

  const dot = s.indexOf(".");
  if (dot <= 0 || dot === s.length - 1) throw new Error("link must be roomId.secret");
  const roomId = s.slice(0, dot);
  const secret = b64urlDecode(s.slice(dot + 1));

  if (secret.byteLength === ROOM_KEY_BYTES) return { roomId, key: secret, writeToken: null };
  if (secret.byteLength === ROOM_KEY_BYTES + WRITE_TOKEN_BYTES) {
    return { roomId, key: secret.subarray(0, ROOM_KEY_BYTES), writeToken: secret.subarray(ROOM_KEY_BYTES) };
  }
  throw new Error(`secret must be ${ROOM_KEY_BYTES} (view) or ${ROOM_KEY_BYTES + WRITE_TOKEN_BYTES} (full) bytes, got ${secret.byteLength}`);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
