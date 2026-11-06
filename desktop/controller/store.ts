// Copyright (c) 2026 REDACTED_ORGANIZATION
// SPDX-License-Identifier: BUSL-1.1

// desktop/controller/store.ts - P-CTRL.2 (ADR-0438; design ADR-0425, issue #449): the hashed pairing store.
//
// A pairing names one external controller (Hermes), the ONE workspace its lanes run in (fixed here, never
// taken from a later request), and the lanes it spawned. Its token is the third token scope: minted here,
// shown once to the human who paired, and stored only as an argon2id hash (Bun.password, no new dependency).
// The token never leaves this module except in the pair() return value, and nothing here logs it.
//
// The file lives under the engine data root and is written owner-only (0600) through temp + rename, so a
// torn write never replaces the store. A store that exists but does not parse is NOT treated as empty: it
// refuses every token and every pair/unpair until a human fixes it (fail-closed, and no silent overwrite of
// pairings the engine could not read).

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Pairing {
  id: string;
  name: string;
  /** Absolute, resolved at pairing time. Every lane this pairing spawns runs here. */
  workspace: string;
  /** argon2id PHC string of the whole token. */
  hash: string;
  createdAt: string;
  /** Lane ids this pairing spawned: the ONLY lanes it can see or act on. */
  lanes: string[];
  /** P-CTRL-REMOTE.1 (ADR-0493): set by the human at pairing time, never by the controller. Its lanes run the
   *  tiered remote policy and accept decisions verified against `root`. */
  remote?: RemotePolicy;
  /** ADR-0504: how many live lanes this pairing may hold (1 to PAIRING_LANES_MAX), set by the human at pairing
   *  time from the spoke's lane policy. Absent: the ADR-0425 default of two (also every pairing stored before). */
  maxLanes?: number;
  /** ADR-0505: the paired spoke's node id (`n_` and 32 hex), set by the human at pairing time. A delegate-certified
   *  approver decides only when its delegation covers this spoke. Absent: only root-signed approvers can decide. */
  spokeNode?: string;
}

/** ADR-0505: a node id, `n_` and the first 32 hex of sha256(SPKI DER). */
export const SPOKE_NODE_RE = /^n_[0-9a-f]{32}$/;

/** ADR-0504: the most live lanes one pairing may be granted. */
export const PAIRING_LANES_MAX = 8;

export interface RemotePolicy {
  /** The owner root's P-256 public key, base64url SPKI DER. */
  root: string;
  /** How long a parked ask waits for a remote decision before it is denied (1 to 24). */
  approvalHours: number;
  /** Run the off-task check before a T0/T1 action runs on its own. */
  offTask: boolean;
  /** The newest root-signed CRL this engine has seen. Only ever moves forward. ADR-0505: `nextUpdate` (seconds)
   *  when the list carried one; once held, a list without it is never taken. */
  crl: { version: number; serials: string[]; nextUpdate?: number };
  /** ADR-0502: every remote allow must carry user-presence evidence from a presence key the approver's
   *  certificate names. Absent: not required (also every pairing stored before ADR-0502). */
  presence?: "required";
}

/** `lucidctl_<16 hex id>_<43 base64url secret>`; the id lets verify() hash against one record, not all. */
const TOKEN_RE = /^lucidctl_([0-9a-f]{16})_[A-Za-z0-9_-]{43}$/;
export const PAIRING_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,47}$/;

export class PairingStore {
  readonly #file: string;
  #pairings: Pairing[] = [];
  #broken: string | null = null;

  constructor(file: string) {
    this.#file = file;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // no pairings yet
      this.#broken = `pairing store unreadable: ${(e as Error).message}`;
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { pairings?: unknown };
      if (!Array.isArray(parsed.pairings) || !parsed.pairings.every(isPairing)) throw new Error("bad shape");
      this.#pairings = parsed.pairings;
    } catch {
      this.#broken = "pairing store is malformed";
    }
  }

  /** Mint a pairing and its token. The token is returned ONCE and never stored in the clear. */
  async pair(name: string, workspace: string, remote?: RemotePolicy, maxLanes?: number, spokeNode?: string): Promise<{ ok: true; pairing: Pairing; token: string } | { ok: false; error: string }> {
    if (this.#broken) return { ok: false, error: this.#broken };
    if (!PAIRING_NAME_RE.test(name)) return { ok: false, error: "invalid pairing name" };
    if (this.#pairings.some((p) => p.name === name)) return { ok: false, error: "a pairing with that name exists" };
    if (remote && !isRemotePolicy(remote)) return { ok: false, error: "invalid remote policy" };
    if (maxLanes !== undefined && !isLaneCount(maxLanes)) return { ok: false, error: `maxLanes must be an integer from 1 to ${PAIRING_LANES_MAX}` };
    if (spokeNode !== undefined && !SPOKE_NODE_RE.test(spokeNode)) return { ok: false, error: "spokeNode must be n_ and 32 hex" };
    const id = randomBytes(8).toString("hex");
    const token = `lucidctl_${id}_${randomBytes(32).toString("base64url")}`;
    const pairing: Pairing = {
      id, name, workspace, hash: await Bun.password.hash(token, { algorithm: "argon2id" }), createdAt: new Date().toISOString(), lanes: [],
      ...(remote ? { remote } : {}), ...(maxLanes !== undefined ? { maxLanes } : {}), ...(spokeNode !== undefined ? { spokeNode } : {}),
    };
    this.#pairings.push(pairing);
    this.#save();
    return { ok: true, pairing, token };
  }

  /** Revoke by name. The token stops working at once; the lanes it spawned stay, visible to the human only. */
  unpair(name: string): Pairing | null {
    if (this.#broken) return null;
    const i = this.#pairings.findIndex((p) => p.name === name);
    if (i < 0) return null;
    const [gone] = this.#pairings.splice(i, 1);
    this.#save();
    return gone!;
  }

  /** The live pairing a header token belongs to, or null. Malformed, unknown, revoked, or a broken store: null. */
  async verify(token: string | null): Promise<Pairing | null> {
    if (this.#broken || !token) return null;
    const m = TOKEN_RE.exec(token);
    if (!m) return null;
    const p = this.#pairings.find((x) => x.id === m[1]);
    if (!p) return null;
    try {
      return (await Bun.password.verify(token, p.hash)) && this.#pairings.includes(p) ? p : null; // a revoke during verify wins
    } catch {
      return null;
    }
  }

  addLane(pairingId: string, laneId: string): void {
    const p = this.#pairings.find((x) => x.id === pairingId);
    if (!p) return;
    p.lanes.push(laneId);
    this.#save();
  }

  /** Why the store refuses everything (an unreadable or malformed file), or null. The boot-time lane restore
   *  (ADR-0496) touches nothing while it is set, so a torn file never reads as "every pairing was revoked". */
  get broken(): string | null {
    return this.#broken;
  }

  /** ADR-0495: a closed lane is no longer this pairing's; its slot and its id are gone. */
  removeLane(pairingId: string, laneId: string): void {
    const p = this.#pairings.find((x) => x.id === pairingId);
    if (!p || !p.lanes.includes(laneId)) return;
    p.lanes = p.lanes.filter((l) => l !== laneId);
    this.#save();
  }

  /** ADR-0496: at boot, keep only the lane ids that came back. The rest ended with the previous engine. */
  retainLanes(keep: ReadonlySet<string>): void {
    if (this.#broken) return;
    let changed = false;
    for (const p of this.#pairings) {
      const kept = p.lanes.filter((l) => keep.has(l));
      if (kept.length !== p.lanes.length) { p.lanes = kept; changed = true; }
    }
    if (changed) this.#save();
  }

  /** The live pairing with this id (a revoked pairing is gone), for the boot-time lane restore (ADR-0496). */
  byId(pairingId: string): Pairing | null {
    return this.#pairings.find((p) => p.id === pairingId) ?? null;
  }

  /** The pairing that spawned `laneId`, for audit lines raised inside the fleet (P-CTRL-REMOTE.1). */
  pairingForLane(laneId: string): Pairing | null {
    return this.#pairings.find((p) => p.lanes.includes(laneId)) ?? null;
  }

  /** Record a newer CRL for a remote pairing. An older or equal version changes nothing (tighten only), and neither
   *  does one without `nextUpdate` once a list with it is held (ADR-0505). */
  advanceCrl(pairingId: string, crl: RemotePolicy["crl"]): void {
    const p = this.#pairings.find((x) => x.id === pairingId);
    if (!p?.remote || crl.version <= p.remote.crl.version || (p.remote.crl.nextUpdate !== undefined && crl.nextUpdate === undefined)) return;
    p.remote.crl = { version: crl.version, serials: [...crl.serials], ...(crl.nextUpdate !== undefined ? { nextUpdate: crl.nextUpdate } : {}) };
    this.#save();
  }

  #save(): void {
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ pairings: this.#pairings }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.#file);
  }
}

function isPairing(v: unknown): v is Pairing {
  const p = v as Pairing;
  return !!p && typeof p.id === "string" && typeof p.name === "string" && typeof p.workspace === "string" && typeof p.hash === "string"
    && typeof p.createdAt === "string" && Array.isArray(p.lanes) && p.lanes.every((l) => typeof l === "string")
    && (p.remote === undefined || isRemotePolicy(p.remote)) && (p.maxLanes === undefined || isLaneCount(p.maxLanes))
    && (p.spokeNode === undefined || (typeof p.spokeNode === "string" && SPOKE_NODE_RE.test(p.spokeNode)));
}

/** ADR-0504: a pairing's lane grant, an integer from 1 to PAIRING_LANES_MAX (the pair route, the store, the file). */
export function isLaneCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= PAIRING_LANES_MAX;
}

function isRemotePolicy(v: unknown): v is RemotePolicy {
  const r = v as RemotePolicy;
  return !!r && typeof r.root === "string" && /^[A-Za-z0-9_-]{40,400}$/.test(r.root)
    && Number.isInteger(r.approvalHours) && r.approvalHours >= 1 && r.approvalHours <= 24 && typeof r.offTask === "boolean"
    && !!r.crl && Number.isSafeInteger(r.crl.version) && r.crl.version >= 0 && Array.isArray(r.crl.serials) && r.crl.serials.every((s) => typeof s === "string")
    && (r.crl.nextUpdate === undefined || (Number.isSafeInteger(r.crl.nextUpdate) && r.crl.nextUpdate >= 0))
    && (r.presence === undefined || r.presence === "required");
}
