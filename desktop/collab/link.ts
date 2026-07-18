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
  // P-COLLAB.10: the ws(s):// relay endpoint the guest should connect to, parsed from an endpoint-carrying
  // link (`<wss://relay>/r/roomId.secret` or the browser `https://relay/#…` form). null for a bare link
  // (the guest then falls back to its configured relay).
  relay: string | null;
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

/** P-COLLAB.10: the shareable invite that CARRIES the relay endpoint a guest connects to:
 *  `<wss://relay:port>/r/<roomId>.<secret>`. This is what LUCID hands to a guest (the bare form doesn't say
 *  WHERE to connect). Omit `writeToken` for a VIEW (read-only) link. */
export function formatRelayLink(relayWsBase: string, roomId: string, key: Uint8Array, writeToken?: Uint8Array | null): string {
  return `${relayWsBase.replace(/\/+$/, "")}/r/${formatShareLink(roomId, key, writeToken)}`;
}

function httpToWs(u: string): string { return u.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:"); }

/** P-REMOTE.3/.2b: the phone-openable invite — the PWA page URL with the secret in the FRAGMENT
 *  (`https://lucid-agent.web.app/remote/#<roomId>.<secret>`). The phone loads the PWA (Firebase Hosting) and
 *  connects to ITS OWN configured relay; the secret rides the fragment, so it never appears in an HTTP
 *  request. Include `writeToken` for an EDIT link (the phone can drive) or omit it for a VIEW link. */
export function formatPwaLink(pwaBase: string, roomId: string, key: Uint8Array, writeToken?: Uint8Array | null): string {
  return `${pwaBase.replace(/\/+$/, "")}/#${formatShareLink(roomId, key, writeToken)}`;
}

/** P-COLLAB.19 (ADR-0241): every link form a live room hands out. ONE room mints TWO capabilities - the full
 *  link (key + write token) can drive, the view link (key only) can only watch - so a host hands DIFFERENT
 *  links to different guests. The browser forms carry the same split for phones/QRs: `browserLink` is the
 *  edit-capable phone link when the share allows editing, `browserViewLink` is always watch-only. The legacy
 *  (no-pwaBase) browser form never carries the write token (unchanged behavior). */
export interface RoomLinks { fullLink: string; viewLink: string; browserLink: string; browserViewLink: string }
export function mintRoomLinks(relay: { wsBase: string; httpBase: string; pwaBase?: string }, roomId: string, key: Uint8Array, writeToken: Uint8Array, allowEdit: boolean): RoomLinks {
  const browserViewLink = relay.pwaBase
    ? formatPwaLink(relay.pwaBase, roomId, key, null)
    : formatBrowserLink(relay.httpBase, formatShareLink(roomId, key));
  return {
    fullLink: formatRelayLink(relay.wsBase, roomId, key, writeToken),
    viewLink: formatRelayLink(relay.wsBase, roomId, key),
    browserLink: relay.pwaBase && allowEdit ? formatPwaLink(relay.pwaBase, roomId, key, writeToken) : browserViewLink,
    browserViewLink,
  };
}

/** Parse any of the three forms into `{ roomId, key, writeToken }`. Throws on a malformed / wrong-size link
 *  (fail-closed: a bad link never yields a usable-looking half-parsed result). */
export function parseShareLink(input: string): ParsedShareLink {
  let s = (input ?? "").trim();
  if (!s) throw new Error("empty link");
  let relay: string | null = null;
  // browser form: the relay http(s) base is before the fragment; the secret rides the fragment.
  const hash = s.indexOf("#");
  if (hash >= 0) {
    const before = s.slice(0, hash).trim().replace(/\/+$/, "");
    if (before) relay = httpToWs(before); // https://relay/#… -> wss://relay
    s = s.slice(hash + 1);
  } else if (s.includes("/r/")) {
    // relay-path form: `<wss://relay:port>/r/<roomId>.<secret>` -> the relay endpoint is before `/r/`.
    const idx = s.lastIndexOf("/r/");
    const before = s.slice(0, idx).trim().replace(/\/+$/, "");
    if (before) relay = before;
    s = s.slice(idx + 3);
  }
  s = s.trim();

  const dot = s.indexOf(".");
  if (dot <= 0 || dot === s.length - 1) throw new Error("link must be roomId.secret");
  const roomId = s.slice(0, dot);
  const secret = b64urlDecode(s.slice(dot + 1));

  if (secret.byteLength === ROOM_KEY_BYTES) return { roomId, key: secret, writeToken: null, relay };
  if (secret.byteLength === ROOM_KEY_BYTES + WRITE_TOKEN_BYTES) {
    return { roomId, key: secret.subarray(0, ROOM_KEY_BYTES), writeToken: secret.subarray(ROOM_KEY_BYTES), relay };
  }
  throw new Error(`secret must be ${ROOM_KEY_BYTES} (view) or ${ROOM_KEY_BYTES + WRITE_TOKEN_BYTES} (full) bytes, got ${secret.byteLength}`);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
