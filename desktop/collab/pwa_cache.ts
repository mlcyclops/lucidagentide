// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/pwa_cache.ts - P-REMOTE.16: the phone's ENCRYPTED on-device transcript cache, pure.
//
// The phone PWA loses its rich transcript (thinking, tool chips, subagents) on every hard reconnect: the
// host's welcome replay carries only plain-text turns ({ role, text }, clipped), and a page reload starts
// from nothing. This module is the fix's pure core: prune the folded ViewItems to a bounded, storable
// subset; seal them under the ROOM KEY (AES-256-GCM, the same [12B IV][ciphertext+tag] layout as
// crypto.ts), so the at-rest cache is exactly as protected as the wire - only a holder of the invite
// fragment can read it; and MERGE the host's welcome replay into a restored/retained item list without
// duplicating turns the phone already has.
//
// Fail-closed like everything else in this plane: a cache that will not decrypt, will not parse, or does
// not validate is NO cache (null), never a partially trusted one. DOM-free + async-only WebCrypto, so the
// whole thing tests headless in Bun.

import type { CollabTranscriptTurn } from "./frames.ts";
import type { ViewItem } from "./pwa_view.ts";

/** Mirrors host.ts TRANSCRIPT_CLIP: welcome turn text arrives clipped to this, so dedupe must compare
 *  clipped-to-clipped. Kept as its own constant here because host.ts does not export it and importing the
 *  host into the phone bundle for one number would drag the whole host class along. */
export const WELCOME_CLIP = 4_000;

/** Cache format version: bump on any shape change so an old phone's cache is discarded, never misread. */
export const PWA_CACHE_VERSION = 1;

/** A cache older than this is stale context, not a resume: discard it. */
export const PWA_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PwaCachePayload {
  v: number;
  roomId: string;
  savedAt: number;
  /** The master `seen` watermark (streamLen units) so a restore does not scream "everything is new". */
  seen: number;
  items: ViewItem[];
}

/** What host.ts clip() would have produced for this text - the comparable form of a welcome turn. */
function clipKey(text: string): string {
  return text.length > WELCOME_CLIP ? `${text.slice(0, WELCOME_CLIP)}\u2026` : text;
}

/**
 * Prune folded items to what is worth persisting, bounded. Dropped outright:
 * - `fleet-lanes` / `processes`: live snapshots; a stale one restored later would present dead lanes as
 *   current state.
 * - `preview`: the image is a full-size data URL; persisting screenshots of the host's screen is a
 *   data-at-rest surface the sealed transcript does not need (and would blow the size cap first anyway).
 * A trailing streaming answer is finalized (`streaming: false`): a restored "streaming" bubble would wait
 * forever for tokens from a turn that is long gone. Text fields are clipped to `maxText` and only the
 * last `maxItems` survive, so the sealed blob stays small enough for IndexedDB on a phone.
 */
export function pruneForCache(items: ViewItem[], maxItems = 200, maxText = 8_000): ViewItem[] {
  const clipText = (t: string): string => (t.length > maxText ? `${t.slice(0, maxText)}\u2026` : t);
  const out: ViewItem[] = [];
  for (const it of items) {
    switch (it.kind) {
      case "fleet-lanes":
      case "processes":
      case "preview":
        break;
      case "user":
        out.push({ ...it, text: clipText(it.text) });
        break;
      case "answer":
        out.push({ kind: "answer", text: clipText(it.text), streaming: false });
        break;
      case "thinking":
        out.push({ kind: "thinking", text: clipText(it.text) });
        break;
      case "note":
        out.push({ ...it, text: clipText(it.text) });
        break;
      default:
        out.push(it);
    }
  }
  return out.slice(-maxItems);
}

/**
 * Merge the host's welcome replay into the items the phone already holds (restored from cache, or retained
 * across a reconnect), WITHOUT duplicating turns. The replay is `{ role, text }` only - no ids, no
 * timestamps - so matching is by text, count-aware (three identical "continue" turns match three items,
 * not one):
 * - a replay turn whose clipped text matches an existing user/answer item is already represented: skipped.
 * - an assistant turn with no exact match, but where some answer item's text is a PROPER PREFIX of it, is
 *   the completed form of a turn the phone saw only partially (the stream died mid-answer): that item is
 *   UPGRADED to the authoritative full text instead of appended, so the partial and the whole never show
 *   as two answers.
 * - everything else is a turn the phone genuinely missed (completed while the screen was locked): appended
 *   in replay order, after the existing items - which is where those turns belong in time for the
 *   lock/reconnect case this exists for.
 * Pure: returns a new list; `items` is never mutated (upgrades copy the element).
 */
export function mergeWelcome(items: ViewItem[], transcript: CollabTranscriptTurn[]): ViewItem[] {
  const out = items.slice();
  // Count-aware index of comparable keys -> item positions not yet consumed by a replay match.
  const free = new Map<string, number[]>();
  for (let i = 0; i < out.length; i++) {
    const it = out[i]!;
    if (it.kind !== "user" && it.kind !== "answer") continue;
    const key = `${it.kind === "user" ? "u" : "a"}:${clipKey(it.text)}`;
    const slot = free.get(key);
    if (slot) slot.push(i); else free.set(key, [i]);
  }
  for (const turn of transcript) {
    const text = turn.text ?? "";
    if (!text.trim()) continue;
    const key = `${turn.role === "user" ? "u" : "a"}:${clipKey(text)}`;
    const slot = free.get(key);
    if (slot && slot.length) { slot.shift(); continue; } // already represented - consume one
    if (turn.role === "assistant") {
      // Partial-answer upgrade: prefer the LAST unconsumed prefix match (the most recent partial).
      let upgraded = false;
      for (let i = out.length - 1; i >= 0; i--) {
        const it = out[i]!;
        if (it.kind !== "answer" || !it.text || it.text.length >= text.length || !text.startsWith(it.text)) continue;
        const oldKey = `a:${clipKey(it.text)}`;
        const oldSlot = free.get(oldKey);
        const at = oldSlot?.indexOf(i) ?? -1;
        if (at === -1) continue; // that item already matched another replay turn
        oldSlot!.splice(at, 1);
        out[i] = { kind: "answer", text, streaming: false };
        upgraded = true;
        break;
      }
      if (upgraded) continue;
      out.push({ kind: "answer", text, streaming: false });
      continue;
    }
    out.push({ kind: "user", text });
  }
  return out;
}

// ---- The seal: AES-256-GCM, [12B random IV][ciphertext + tag] - the crypto.ts layout, applied to the
// cache payload instead of a wire frame. Duplicated (15 lines) rather than widening crypto.ts's
// frame-typed seal/open: the protocol module's signature stays exactly what the wire needs.

const AES = "AES-GCM";
const IV_LENGTH = 12;
const enc = new TextEncoder();
const dec = new TextDecoder();

function strict(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/** Seal a cache payload under the room key. The device stores only opaque bytes. */
export async function sealCache(key: CryptoKey, payload: PwaCachePayload): Promise<Uint8Array> {
  const iv = new Uint8Array(IV_LENGTH);
  crypto.getRandomValues(iv);
  const plaintext = enc.encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: AES, iv }, key, plaintext));
  const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(ciphertext, IV_LENGTH);
  return out;
}

const ITEM_KINDS: Record<string, true> = { user: true, answer: true, thinking: true, tool: true, subagent: true, block: true, note: true, "lane-error": true };

/** A restored item must be one of the persistable kinds with a string payload; anything else is dropped.
 *  (`preview`/`fleet-lanes`/`processes` are never persisted, so their presence means tampering or an old
 *  writer - either way they do not come back.) */
function validItem(x: unknown): x is ViewItem {
  if (!x || typeof x !== "object") return false;
  const it = x as Record<string, unknown>;
  if (typeof it.kind !== "string" || !ITEM_KINDS[it.kind]) return false;
  switch (it.kind) {
    case "user": case "thinking": case "note": return typeof it.text === "string";
    case "answer": return typeof it.text === "string" && typeof it.streaming === "boolean";
    case "tool": return typeof it.name === "string" && typeof it.detail === "string";
    case "subagent": return typeof it.agent === "string" && typeof it.title === "string" && typeof it.count === "number";
    case "block": return typeof it.reason === "string" && typeof it.severity === "string";
    case "lane-error": return typeof it.message === "string";
    default: return false;
  }
}

/**
 * Inverse of {@link sealCache}, fail-closed: wrong key, tamper, unparseable JSON, a version/room mismatch,
 * or an over-age payload all yield null (no cache), never a partial one. Individual items are validated;
 * an invalid item drops the WHOLE payload - a cache that fails shape validation was not written by this
 * code and gets no benefit of the doubt.
 */
export async function openCache(key: CryptoKey, data: Uint8Array, roomId: string, now: number): Promise<PwaCachePayload | null> {
  try {
    if (data.byteLength <= IV_LENGTH) return null;
    const iv = strict(data.subarray(0, IV_LENGTH));
    const ciphertext = strict(data.subarray(IV_LENGTH));
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: AES, iv }, key, ciphertext));
    const parsed = JSON.parse(dec.decode(plaintext)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    if (p.v !== PWA_CACHE_VERSION) return null;
    if (typeof p.roomId !== "string" || p.roomId !== roomId) return null;
    if (typeof p.savedAt !== "number" || !Number.isFinite(p.savedAt)) return null;
    if (p.savedAt > now || now - p.savedAt > PWA_CACHE_MAX_AGE_MS) return null;
    if (!Array.isArray(p.items) || !p.items.every(validItem)) return null;
    const seen = typeof p.seen === "number" && Number.isInteger(p.seen) && p.seen >= 0 ? p.seen : 0;
    return { v: PWA_CACHE_VERSION, roomId: p.roomId, savedAt: p.savedAt, seen, items: p.items as ViewItem[] };
  } catch {
    return null;
  }
}
