// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/engine_channel.ts - LH-03 (ADR-0544): a held lane's channel back to the engine.
//
// A lane under lucid-holder (ADR-0528) outlives the engine that started it, so its calls back (the interject
// drain, check-in, the commit gate, the stream beat) keep going to the port that engine had, with the URLs that
// engine handed over. Two things go wrong there without this module: the next engine mints a new agent token and
// refuses the old one (the commit gate then failed open), and whatever process binds that port while no engine
// holds it answers the calls (it could inject "operator" notes and approve every commit).
//
// So a held lane gets a per-lane channel key (LUCID_LANE_CHANNEL, 32 random bytes in hex) that the engine keeps in
// the lane's 0600 holder record, and every later engine that reattaches the lane accepts it. The key itself never
// travels: the request carries a credential derived from it (`?t=`, replacing whatever token the URL had), and a
// fresh nonce; the engine answers with a proof over the nonce, the status and the exact body bytes. A squatter
// sees the credential and the nonce but cannot produce the proof, and cannot splice another engine's proof onto a
// body of its own. A lane without the key (the master, a lane that is the engine's own child) is unchanged.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CHANNEL_ENV = "LUCID_LANE_CHANNEL";
export const CHANNEL_NONCE_HEADER = "x-lucid-channel-nonce";
export const CHANNEL_PROOF_HEADER = "x-lucid-channel-proof";
const KEY_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;

/** A new per-lane channel key. */
export function mintChannelKey(): string { return randomBytes(32).toString("hex"); }

/** Whether `key` has the shape mintChannelKey gives (anything else is no key at all). */
export function isChannelKey(key: unknown): key is string { return typeof key === "string" && KEY_RE.test(key); }

/** Whether `nonce` has the shape a client sends (16 random bytes in hex). */
export function isChannelNonce(nonce: unknown): nonce is string { return typeof nonce === "string" && NONCE_RE.test(nonce); }

/** What the lane sends to authenticate (as `?t=`). Derived, so a listener that reads it learns nothing to prove with. */
export function channelCredential(key: string): string {
  return createHmac("sha256", Buffer.from(key, "hex")).update("lucid-lane-channel/v1/client").digest("hex");
}

/** What the engine answers with: bound to the request's nonce, the status and the exact body bytes. */
export function channelProof(key: string, nonce: string, status: number, body: Uint8Array): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", Buffer.from(key, "hex")).update(`lucid-lane-channel/v1/server\n${nonce}\n${status}\n${digest}`).digest("hex");
}

/** Constant-time comparison of two hex strings of the same expected length. */
export function sameHex(a: string | null | undefined, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** The answer did not come from an engine that holds this lane's channel (a squatter on the port, or an engine
 *  that does not know the lane). Callers that guard something fail closed on it. */
export class ChannelProofError extends Error {
  constructor(where: string) {
    super(`the answer from ${where} did not prove it came from the LUCID engine that holds this lane`);
    this.name = "ChannelProofError";
  }
}

/** `url` with its `t` replaced by this lane's channel credential. */
export function channelUrl(url: string, key: string): string {
  const u = new URL(url);
  u.searchParams.set("t", channelCredential(key));
  return u.toString();
}

/** fetch() for a call back to the engine. Without a channel key in `env` it is a plain fetch. With one, the
 *  request carries the channel credential and a nonce, and the reply is returned only when its proof verifies;
 *  otherwise this throws ChannelProofError (the body is never handed back). */
export async function engineFetch(url: string, init: RequestInit = {}, env: Record<string, string | undefined> = process.env): Promise<Response> {
  const key = env[CHANNEL_ENV];
  if (!isChannelKey(key)) return fetch(url, init);
  const nonce = randomBytes(16).toString("hex");
  const headers = new Headers(init.headers);
  headers.set(CHANNEL_NONCE_HEADER, nonce);
  const target = channelUrl(url, key);
  const res = await fetch(target, { ...init, headers });
  const body = new Uint8Array(await res.arrayBuffer());
  if (!sameHex(res.headers.get(CHANNEL_PROOF_HEADER), channelProof(key, nonce, res.status, body))) throw new ChannelProofError(new URL(target).host);
  return new Response(res.status === 204 || res.status === 304 ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
