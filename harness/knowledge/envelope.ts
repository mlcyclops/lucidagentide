// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/knowledge/envelope.ts - Knowledge Item envelope v1 producer (docs/specs/knowledge-envelope-v1.md).
//
// The vectors file (docs/specs/knowledge-envelope-v1.vectors.json) is the contract: buildEnvelope()
// reproduces every vector envelope byte-for-byte (envelope.test.ts). A mismatch would not crash; the
// other device would silently skip our items, so the bytes are pinned, not described.
//
// P-KSYNC.L1 (#360): the gate process journals each promoted semantic fact as a `memory.fact` item.
// OFF unless LUCID_KSYNC_JOURNAL names a sync root. The signing identity comes from LUCID_KSYNC_IDENTITY
// (a LOCAL file; refused if it sits inside the sync root, which replicates to every device). Every
// failure is a silent no-emit: this path never throws into the writer, never touches the gate decision,
// and never writes the DB (it only reads the fact back through the writer's own handle).
//
// memory.fact is body_v null (spec 4.2: provisional until L2 freezes the body from the real reader).
// Every conformant consumer ignores a null-body_v class (spec 4.2 + 7), so opt-in emission before L2
// is inert on the wire; the default (unset) emits nothing, which is what 4.2 asks of a producer.

import { createHash, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import type { Db } from "../memory/db.ts";

export const ENVELOPE_V = 1;

/** Spec 4: the class registry. null = provisional body (memory.fact until L2). */
export const BODY_V: Record<string, number | null> = {
  "memory.fact": null,
  "knowledge.chunk": 1,
  "meeting.index": 1,
  "meeting.record": 1,
  "contact.mark": 1,
  "person.profile": 1,
};

/** Spec 4.1: ids with NO representation in v1, refused by name with a sentence a user can read. */
export const FORBIDDEN_TYPES: Record<string, string> = {
  voiceprint: "a biometric identifier of the user and of third parties who never consented to it leaving the capture machine",
  provider_key: "provider API keys never leave the vault",
  oauth_token: "OAuth tokens never leave the vault",
  vault_passphrase: "the vault passphrase is not stored at all, let alone synced",
  brief: "pre-meeting briefs are device-local; regenerate instead of syncing",
};

export class EnvelopeError extends Error {
  override name = "EnvelopeError";
}

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const SEGMENT_CAP = 8 * 1024 * 1024; // ponytail: fixed cap, the spec leaves the size open
const ZERO_NONCE = new Uint8Array(12); // spec 5: safe only because the content key is unique per item
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Spec 2: RFC 8785 JCS minus its two hard parts. Rejects (never coerces) floats, out-of-range ints,
 *  non-conforming keys, and anything that is not JSON. */
export function canonicalize(value: unknown): Uint8Array {
  return new TextEncoder().encode(jcs(value));
}

function jcs(v: unknown): string {
  if (v === null || typeof v === "boolean") return String(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new EnvelopeError(`not a safe integer (floats are banned in headers): ${v}`);
    return String(v);
  }
  if (typeof v === "string") {
    if (/\p{Cs}/u.test(v)) throw new EnvelopeError("lone surrogate in string");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v).sort(); // ASCII-only keys: code-unit and code-point order agree
    for (const k of keys) if (!KEY_RE.test(k)) throw new EnvelopeError(`key "${k}" does not match ^[a-z][a-z0-9_]*$`);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new EnvelopeError(`not JSON: ${typeof v}`);
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

/** Spec 3.4: first 16 bytes of sha256(type|casefold(trim(natural_key))), hex. */
export function logicalKey(type: string, naturalKey: string): string {
  const k = naturalKey.trim();
  if (!k) throw new EnvelopeError("empty or whitespace-only natural key (it would merge unrelated items)");
  // ponytail: upper-then-lower approximates Unicode casefold (ss for sharp s, final sigma); exact for every
  // memory.fact key (an ASCII fact id). Use a CaseFolding.txt table if a non-ASCII class key ever needs it.
  return sha256(`${type}|${k.toUpperCase().toLowerCase()}`).subarray(0, 16).toString("hex");
}

/** Spec 3.3: prefix + first 8 bytes of sha256(raw public key), hex. */
export const fingerprint = (prefix: "u" | "d", publicKey: Uint8Array) => `${prefix}_${sha256(publicKey).subarray(0, 8).toString("hex")}`;

/** Spec 3.1: ki_ + UUIDv7 (48-bit big-endian ms, then 74 bits of the given 10 random bytes). */
export function uuid7(ms: number, random10: Uint8Array): string {
  const u = Buffer.alloc(16);
  u.writeUIntBE(ms, 0, 6);
  u.set(random10.subarray(0, 10), 6);
  u[6] = 0x70 | (u[6]! & 0x0f);
  u[8] = 0x80 | (u[8]! & 0x3f);
  const h = u.toString("hex");
  return `ki_${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Spec 3.2: hybrid logical clock. A wall clock that does not move forward reuses the last ms and bumps
 *  the counter; more than 9999 stamps in one ms is an error, never a wrap.
 *  ponytail: in-memory state, so a backwards clock across a process restart is not caught; seed from the
 *  journal's last line if that ever matters. */
export class Hlc {
  private ms = 0;
  private counter = 0;
  constructor(readonly device: string) {}
  stamp(wallMs: number): { ms: number; hlc: string } {
    if (wallMs > this.ms) {
      this.ms = wallMs;
      this.counter = 0;
    } else if (++this.counter > 9999) {
      throw new EnvelopeError("HLC counter above 9999 in one millisecond");
    }
    return { ms: this.ms, hlc: `${new Date(this.ms).toISOString()}-${String(this.counter).padStart(4, "0")}-${this.device}` };
  }
}

export interface Identity {
  user: string; // u_<fp>
  device: string; // d_<fp>
  seed: Uint8Array; // device Ed25519 seed (32 bytes)
  epochId: string;
  epochKey: Uint8Array; // 32 bytes
}

/** Parse an identity file (same field names as the vectors' `keys` block, plus `epoch_id`). Throws on
 *  any missing or mis-sized field. */
export function identityFrom(raw: unknown): Identity {
  const r = (raw ?? {}) as Record<string, unknown>;
  const b64 = (field: string, len?: number): Buffer => {
    const s = r[field];
    if (typeof s !== "string" || !s) throw new EnvelopeError(`identity: missing ${field}`);
    const b = Buffer.from(s, "base64");
    if (len !== undefined && b.length !== len) throw new EnvelopeError(`identity: ${field} must be ${len} bytes`);
    return b;
  };
  const epochId = r.epoch_id;
  if (typeof epochId !== "string" || !epochId) throw new EnvelopeError("identity: missing epoch_id");
  return {
    user: fingerprint("u", b64("user_public_material_b64")),
    device: fingerprint("d", b64("device_public_material_b64")),
    seed: b64("device_ed25519_seed_b64", 32),
    epochId,
    epochKey: b64("epoch_key_b64", 32),
  };
}

export interface ItemInput {
  id: string;
  type: string;
  naturalKey: string;
  hlc: string;
  created: string;
  body: unknown;
  sourceApp: "meeting-hub" | "lucid-ide";
  origin: { kind: string; ref: string | null; shared_by: string | null };
  supersedes?: string | null;
  tombstone?: boolean;
  consent?: { scope: string };
}

/** Spec 3 + 5: build a signed, sealed envelope. Header = envelope minus body/sig; it is both the AEAD
 *  associated data and (hashed) half of the signed message. */
export function buildEnvelope(item: ItemInput, ident: Identity): Record<string, unknown> {
  const refused = FORBIDDEN_TYPES[item.type];
  if (refused) throw new EnvelopeError(`"${item.type}" has no representation in Knowledge Envelope v1: ${refused}`);
  if (!(item.type in BODY_V)) throw new EnvelopeError(`unknown item type "${item.type}"`);
  const header = {
    v: ENVELOPE_V,
    id: item.id,
    type: item.type,
    key: logicalKey(item.type, item.naturalKey),
    body_v: BODY_V[item.type],
    user: ident.user,
    device: ident.device,
    source_app: item.sourceApp,
    origin: item.origin,
    created: item.created,
    clock: { hlc: item.hlc },
    supersedes: item.supersedes ?? null,
    tombstone: item.tombstone ?? false,
    consent: item.consent ?? { scope: "self" },
    enc: { alg: "c20p-hkdf-v1", key: ident.epochId },
  };
  const aad = canonicalize(header);
  const contentKey = new Uint8Array(hkdfSync("sha256", ident.epochKey, Buffer.from(item.id, "utf8"), Buffer.from("lucid/ki/body/v1", "utf8"), 32));
  // The plaintext is the canonical body (the vectors fix this); a float in a body therefore refuses here.
  const ct = chacha20poly1305(contentKey, ZERO_NONCE, aad).encrypt(canonicalize(item.body));
  const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, ident.seed]), format: "der", type: "pkcs8" });
  const sig = sign(null, Buffer.concat([sha256(aad), sha256(ct)]), key);
  return { ...header, body: Buffer.from(ct).toString("base64"), sig: sig.toString("base64") };
}

/** Spec 6: one envelope per line. The line is the envelope's own canonical form. */
export function journalLine(envelope: Record<string, unknown>): Uint8Array {
  const c = canonicalize(envelope);
  const line = new Uint8Array(c.length + 1);
  line.set(c);
  line[c.length] = 0x0a;
  return line;
}

/** Append to this device's own journal dir (spec 6: no two devices ever write the same file), rotating
 *  to the next NNNNNN.jl segment at the cap. Throws on any I/O failure; returns the segment written. */
export function appendEnvelope(syncRoot: string, ident: Identity, envelope: Record<string, unknown>): string {
  const dir = join(syncRoot, ident.user, "journal", ident.device);
  mkdirSync(dir, { recursive: true });
  const last = readdirSync(dir).filter((n) => /^\d{6}\.jl$/.test(n)).sort().at(-1) ?? "000001.jl";
  let path = join(dir, last);
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    /* first write: the segment does not exist yet */
  }
  if (size >= SEGMENT_CAP) path = join(dir, `${String(Number(last.slice(0, 6)) + 1).padStart(6, "0")}.jl`);
  appendFileSync(path, journalLine(envelope)); // one write per whole line; readers skip a torn tail (spec 6)
  return path;
}

export interface FactBody {
  fact_id: string;
  entity: string;
  statement: string;
  trust_label: string;
}

let clock: Hlc | null = null;

/** Journal one memory.fact. Returns the segment path, or null for every reason not to (flag off, no
 *  identity, identity inside the sync root, any build or I/O failure). Never throws. */
export function emitMemoryFact(fact: FactBody, opts: { now?: number; random?: Uint8Array } = {}): string | null {
  try {
    const root = process.env.LUCID_KSYNC_JOURNAL?.trim();
    const idPath = process.env.LUCID_KSYNC_IDENTITY?.trim();
    if (!root || !idPath) return null;
    const absRoot = resolve(root);
    const absId = resolve(idPath);
    if (absId === absRoot || absId.startsWith(absRoot + sep)) return null; // a device seed must never replicate
    const ident = identityFrom(JSON.parse(readFileSync(absId, "utf8")));
    if (clock?.device !== ident.device) clock = new Hlc(ident.device);
    const { ms, hlc } = clock.stamp(opts.now ?? Date.now());
    const envelope = buildEnvelope(
      {
        id: uuid7(ms, opts.random ?? randomBytes(10)),
        type: "memory.fact",
        naturalKey: fact.fact_id, // spec 3.4: the fact's own id in the producing store
        hlc,
        created: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"),
        body: { fact_id: fact.fact_id, entity: fact.entity, statement: fact.statement, trust_label: fact.trust_label },
        sourceApp: "lucid-ide",
        origin: { kind: "agent", ref: null, shared_by: null },
      },
      ident,
    );
    return appendEnvelope(absRoot, ident, envelope);
  } catch {
    return null;
  }
}

/** The security_extension hook: read the fact a gated subagent result just promoted (keystone #2 already
 *  ran; only trusted/untrusted facts exist) through the writer's own handle, then journal it. Read-only
 *  on the DB; resolves null on any failure, never rejects. */
export async function journalPromotedFact(db: Db, sourceArtifactId: string): Promise<string | null> {
  try {
    const row = await db.get(
      `SELECT f.fact_id, e.name AS entity, f.statement, f.trust_label
         FROM semantic_facts f JOIN semantic_entities e ON e.entity_id = f.entity_id
        WHERE f.source_artifact_id = $1 ORDER BY f.promoted_at DESC LIMIT 1`,
      [sourceArtifactId],
    );
    if (!row) return null;
    return emitMemoryFact({ fact_id: String(row.fact_id), entity: String(row.entity), statement: String(row.statement), trust_label: String(row.trust_label) });
  } catch {
    return null;
  }
}
