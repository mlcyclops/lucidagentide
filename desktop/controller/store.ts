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
  async pair(name: string, workspace: string): Promise<{ ok: true; pairing: Pairing; token: string } | { ok: false; error: string }> {
    if (this.#broken) return { ok: false, error: this.#broken };
    if (!PAIRING_NAME_RE.test(name)) return { ok: false, error: "invalid pairing name" };
    if (this.#pairings.some((p) => p.name === name)) return { ok: false, error: "a pairing with that name exists" };
    const id = randomBytes(8).toString("hex");
    const token = `lucidctl_${id}_${randomBytes(32).toString("base64url")}`;
    const pairing: Pairing = { id, name, workspace, hash: await Bun.password.hash(token, { algorithm: "argon2id" }), createdAt: new Date().toISOString(), lanes: [] };
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
    && typeof p.createdAt === "string" && Array.isArray(p.lanes) && p.lanes.every((l) => typeof l === "string");
}
