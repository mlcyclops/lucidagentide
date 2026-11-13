// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/engine_channel.ts - LH-03 (ADR-0544): a held lane's channel back to the engine.
//
// A lane under lucid-holder (ADR-0528) outlives the engine that started it, so its calls back (the interject
// drain, check-in, the commit gate, the stream beat, and every tool that calls an agent route) keep going to the
// port that engine had, with the URLs that engine handed over. Two things go wrong there without this module: the
// next engine mints a new agent token and refuses the old one (the commit gate then failed open), and whatever
// process binds that port while no engine holds it answers the calls (it could inject "operator" notes and approve
// every commit).
//
// So a held lane gets a per-lane channel key (LUCID_LANE_CHANNEL, 32 random bytes in hex) that the engine keeps in
// the lane's 0600 holder record, and every later engine that reattaches the lane accepts it. The key itself never
// travels, and neither does any standing credential: every request carries a fresh nonce, the time it was made and
// a MAC over the nonce, the method, the path and query, the time and the SHA-256 of the body (the old engine's
// `?t=` token is dropped). The engine refuses a stale time or a nonce it has seen, so a listener that records a
// request can neither replay it nor change its body, path or method. The engine answers with a proof over that
// request MAC, the status and the exact body bytes; a squatter cannot produce it, and cannot splice another
// engine's proof onto a body of its own or onto the answer to another request. A lane without the key (the
// master, a lane that is the engine's own child) is unchanged. ADR-0544 as amended by the 2026-11-12 review.

import { tokenValid } from "../../desktop/origin_guard.ts";
import { hmacSha256, randomBytes, sha256 } from "../crypto/fips_crypto.ts";

export const CHANNEL_ENV = "LUCID_LANE_CHANNEL";
export const CHANNEL_NONCE_HEADER = "x-lucid-channel-nonce";
export const CHANNEL_TIME_HEADER = "x-lucid-channel-time";
export const CHANNEL_MAC_HEADER = "x-lucid-channel-mac";
export const CHANNEL_PROOF_HEADER = "x-lucid-channel-proof";
/** How far a request's time may be from the engine's clock. Both ends run on this machine, so this only has to
 *  cover a slow request; it bounds how long the engine must remember a nonce. */
export const CHANNEL_WINDOW_MS = 60_000;
const KEY_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const TIME_RE = /^[0-9]{1,15}$/;
// Domain separation: a request MAC and a reply proof start with different labels, so neither stands in for the other.
const REQUEST_LABEL = Buffer.from("lucid-lane-channel/v2/request\0", "utf8");
const REPLY_LABEL = Buffer.from("lucid-lane-channel/v2/reply\0", "utf8");

/** A new per-lane channel key. */
export function mintChannelKey(): string { return randomBytes(32).toString("hex"); }

/** Whether `key` has the shape mintChannelKey gives (anything else is no key at all). */
export function isChannelKey(key: unknown): key is string { return typeof key === "string" && KEY_RE.test(key); }

/** Whether `nonce` has the shape a lane sends (16 random bytes in hex). */
export function isChannelNonce(nonce: unknown): nonce is string { return typeof nonce === "string" && NONCE_RE.test(nonce); }

/** Whether `time` has the shape a lane sends (milliseconds since the epoch, in decimal). */
export function isChannelTime(time: unknown): time is string { return typeof time === "string" && TIME_RE.test(time); }

/** What the lane sends to authenticate one request: HMAC(key, label | method | path?query | time | nonce | SHA-256(body)).
 *  `target` is the URL's path plus its query exactly as sent; the body is the exact bytes sent. */
export function channelRequestMac(key: string, nonce: string, method: string, target: string, time: string, body: Buffer): string {
  return hmacSha256(Buffer.from(key, "hex"), Buffer.concat([REQUEST_LABEL, Buffer.from(`${method}\0${target}\0${time}\0`, "utf8"), Buffer.from(nonce, "hex"), sha256(body)])).toString("hex");
}

/** What the engine answers with: bound to the request (its MAC), the status and the exact body bytes. */
export function channelProof(key: string, requestMac: string, status: number, body: Buffer): string {
  return hmacSha256(Buffer.from(key, "hex"), Buffer.concat([REPLY_LABEL, Buffer.from(requestMac, "hex"), Buffer.from(`${status}\0`, "utf8"), sha256(body)])).toString("hex");
}

/** The answer did not come from an engine that holds this lane's channel (a squatter on the port, or an engine
 *  that does not know the lane). Callers that guard something fail closed on it. */
export class ChannelProofError extends Error {
  constructor(where: string) {
    super(`the answer from ${where} did not prove it came from the LUCID engine that holds this lane`);
    this.name = "ChannelProofError";
  }
}

/** The exact bytes a request body puts on the wire. Only the shapes the extensions send (a string or bytes) can be
 *  bound by the MAC; anything else is refused rather than sent unbound. */
function bodyBytes(body: RequestInit["body"]): Buffer {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError("a lane channel request body must be a string or bytes");
}

/** fetch() for a call back to the engine. Without a channel key in `env` it is a plain fetch. With one, the
 *  request drops the URL's `t` and carries a nonce, its time and its MAC, and the reply is returned only when its
 *  proof verifies; otherwise this throws ChannelProofError (the body is never handed back). */
export async function engineFetch(url: string, init: RequestInit = {}, env: Record<string, string | undefined> = process.env): Promise<Response> {
  const key = env[CHANNEL_ENV];
  if (!isChannelKey(key)) return fetch(url, init);
  const target = new URL(url);
  target.searchParams.delete("t"); // the engine that minted that token may be gone; the MAC is the credential
  const method = (init.method ?? "GET").toUpperCase();
  const body = bodyBytes(init.body);
  const nonce = randomBytes(16).toString("hex");
  const time = String(Date.now());
  const mac = channelRequestMac(key, nonce, method, target.pathname + target.search, time, body);
  const headers = new Headers(init.headers);
  headers.set(CHANNEL_NONCE_HEADER, nonce);
  headers.set(CHANNEL_TIME_HEADER, time);
  headers.set(CHANNEL_MAC_HEADER, mac);
  const res = await fetch(target.toString(), { ...init, method, headers }); // a string or bytes body sends exactly `body`
  const reply = Buffer.from(await res.arrayBuffer());
  if (!tokenValid(res.headers.get(CHANNEL_PROOF_HEADER), channelProof(key, mac, res.status, reply))) throw new ChannelProofError(target.host);
  return new Response(res.status === 204 || res.status === 304 ? null : reply, { status: res.status, statusText: res.statusText, headers: res.headers });
}
