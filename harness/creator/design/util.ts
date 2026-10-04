// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/util.ts - small shared guards for the Design engine.
//
// Ids, untrusted text, and file-keyed objects are the three places a design file (or a model reply) can
// reach code paths it should not. Every module funnels them through these helpers so the rules live once.

import { DESIGN_LIMITS } from "./limits.ts";

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Keys that can re-prototype a plain object when copied blindly. Refused everywhere, including as ids
 *  ("__proto__" matches ID_RE, so the regex alone is not enough). A Set, not a Record: a Record lookup of
 *  "__proto__" would itself walk the prototype chain. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** True for a string id matching /^[A-Za-z0-9_-]{1,64}$/ that is not a prototype key. */
export function isValidId(v: unknown): v is string {
  return typeof v === "string" && v.length <= 64 && ID_RE.test(v) && !FORBIDDEN_KEYS.has(v);
}

/** Strip control, bidi-override, and zero-width characters, collapse nothing else, cap to `max` UTF-16
 *  units without splitting a surrogate pair. Used for every untrusted string (labels, names, file text). */
export function cleanText(v: unknown, max: number = DESIGN_LIMITS.maxLabel): string {
  if (typeof v !== "string") return "";
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7F || (c >= 0x80 && c <= 0x9F)) continue;
    if (c >= 0x200B && c <= 0x200F) continue;          // zero-width + LRM/RLM
    if (c >= 0x202A && c <= 0x202E) continue;          // bidi embeddings/overrides
    if (c >= 0x2066 && c <= 0x2069) continue;          // bidi isolates
    if (c === 0x2028 || c === 0x2029 || c === 0xFEFF) continue;
    if (c >= 0xD800 && c <= 0xDBFF) {                  // high surrogate: keep only a complete pair
      const lo = v.charCodeAt(i + 1);
      if (!(lo >= 0xDC00 && lo <= 0xDFFF)) continue;
      if (out.length + 2 > max) break;
      out += v[i]! + v[i + 1]!;
      i++;
      continue;
    }
    if (c >= 0xDC00 && c <= 0xDFFF) continue;          // lone low surrogate
    if (out.length + 1 > max) break;
    out += v[i]!;
  }
  return out;
}

/** A plain JSON object (not an array, not null) whose own keys contain no prototype-poisoning names. */
export function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const k of Object.keys(v)) if (FORBIDDEN_KEYS.has(k)) return false;
  // JSON.parse creates an OWN "__proto__" property that Object.keys does report; a literal `{ __proto__: x }`
  // instead re-prototypes, which the getPrototypeOf check above catches.
  return true;
}

export const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** A null-prototype record, the only shape used for file-keyed maps in a DesignDoc. */
export function nullRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Concatenate byte arrays into one. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Growable byte sink for encoders: avoids number[] boxing and repeated concatenation. */
export class ByteWriter {
  private buf: Uint8Array;
  length = 0;
  constructor(initial = 1024) { this.buf = new Uint8Array(Math.max(16, initial)); }
  private ensure(extra: number): void {
    const need = this.length + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  u8(v: number): void { this.ensure(1); this.buf[this.length++] = v & 0xFF; }
  u16be(v: number): void { this.ensure(2); this.buf[this.length++] = (v >>> 8) & 0xFF; this.buf[this.length++] = v & 0xFF; }
  u16le(v: number): void { this.ensure(2); this.buf[this.length++] = v & 0xFF; this.buf[this.length++] = (v >>> 8) & 0xFF; }
  i16be(v: number): void { this.u16be(v < 0 ? v + 0x10000 : v); }
  u32be(v: number): void {
    this.ensure(4);
    this.buf[this.length++] = (v >>> 24) & 0xFF; this.buf[this.length++] = (v >>> 16) & 0xFF;
    this.buf[this.length++] = (v >>> 8) & 0xFF; this.buf[this.length++] = v & 0xFF;
  }
  i32be(v: number): void { this.u32be(v >>> 0); }
  /** 64-bit big-endian unsigned (exact up to 2^53). */
  u64be(v: number): void { this.u32be(Math.floor(v / 0x1_0000_0000)); this.u32be(v >>> 0); }
  bytes(b: Uint8Array | readonly number[]): void {
    this.ensure(b.length);
    if (b instanceof Uint8Array) this.buf.set(b, this.length);
    else for (let i = 0; i < b.length; i++) this.buf[this.length + i] = b[i]! & 0xFF;
    this.length += b.length;
  }
  ascii(s: string): void { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
  /** Overwrite a big-endian u32 at an earlier offset (length back-patching). */
  patchU32be(at: number, v: number): void {
    this.buf[at] = (v >>> 24) & 0xFF; this.buf[at + 1] = (v >>> 16) & 0xFF;
    this.buf[at + 2] = (v >>> 8) & 0xFF; this.buf[at + 3] = v & 0xFF;
  }
  patchU64be(at: number, v: number): void { this.patchU32be(at, Math.floor(v / 0x1_0000_0000)); this.patchU32be(at + 4, v >>> 0); }
  finish(): Uint8Array { return this.buf.slice(0, this.length); }
}
