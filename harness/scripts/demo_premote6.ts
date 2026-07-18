// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_premote6.ts — P-REMOTE.6 (ADR-0227): the phone's paid-tier unentitled→Subscribe path.
//
// Remote Access is a $9.99/mo Stripe subscription delivered as a Firebase `premium` (or `admin`, rides free)
// custom claim. The RELAY is the authoritative gate — a verified-but-unentitled token is refused 4403. This
// drives that exact path over a REAL gated relay: an entitled phone goes live (never shown Subscribe), an
// unentitled phone is refused and the pure detector routes it to Subscribe, `createRemoteCheckout` opens a
// Stripe session fail-closed, and after the webhook sets the claim the refreshed token is recognised so the
// phone can retry. Only Firebase + Stripe + the DOM are absent (live-QA); everything the phone computes runs.

import { startRelayServer } from "../../desktop/collab/relay_server.ts";
import { CollabSocket } from "../../desktop/collab/relay_client.ts";
import { CollabHost } from "../../desktop/collab/host.ts";
import { CollabGuest } from "../../desktop/collab/guest.ts";
import { generateRoomKey, importRoomKey } from "../../desktop/collab/crypto.ts";
import { generateRoomId } from "../../desktop/collab/link.ts";
import {
  createRemoteCheckout, entitlementActive, isEntitlementDenied, remoteGate,
} from "../../desktop/collab/remote_entitlement.ts";
import type { AuthVerdict } from "../../desktop/collab/relay_auth.ts";

let step = 0;
const pass = (m: string): void => { console.log(`  [${++step}] PASS ${m}`); };
const fail = (m: string): never => { console.error(`  FAIL ${m}`); process.exit(1); };
const until = async (cond: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 800; i++) { if (cond()) return; const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, 5); await promise; }
  throw new Error(`timed out: ${label}`);
};
const b64url = (s: string): string => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: unknown): string => `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.sig`;

console.log("== P-REMOTE.6: the paid Remote Access tier — unentitled -> Subscribe -> checkout -> admit ==");

// The gated relay mirrors admissionDecision: a `premium`/`admin` token is admitted; a verified-but-unentitled
// token is refused 4403 (the exact signal the phone turns into a Subscribe screen).
const verify = async (t: string): Promise<AuthVerdict> => {
  if (t === "tok-premium") return { ok: true, uid: "u-prem", email: "paid@gmail.com", premium: true, admin: false };
  if (t === "tok-noclaim") return { ok: false, code: 4403, reason: "signed in but not entitled (no premium/admin claim, not allowlisted)" };
  return { ok: false, code: 4401, reason: "bad token" };
};
const relay = startRelayServer({ port: 0, auth: { verify } });
const key = await importRoomKey(generateRoomKey());
const room = generateRoomId();
const wsUrl = `ws://127.0.0.1:${relay.port}/r/${room}`;

// [1] the pure entry decision
if (remoteGate(false, false) !== "signin") fail("not signed in must be signin");
if (remoteGate(true, false) !== "connect") fail("signed in + not denied must connect");
if (remoteGate(true, true) !== "subscribe") fail("signed in + relay-denied must subscribe");
pass("remoteGate: signed-out -> signin, entitled/allowlisted -> connect, relay-refused -> subscribe");

// [2] UNENTITLED: a real phone token the relay refuses 4403 -> the guest ends -> the detector says Subscribe
const noClaimSock = new CollabSocket({ wsUrl, role: "guest", key, authToken: () => "tok-noclaim" });
const noClaimGuest = new CollabGuest(noClaimSock, { name: "free@phone", writeToken: null }, {});
noClaimGuest.start();
await until(() => noClaimGuest.view().phase === "ended", "unentitled guest ended");
if (!isEntitlementDenied(noClaimGuest.view())) fail("4403 close was not recognised as an entitlement denial");
if (remoteGate(true, isEntitlementDenied(noClaimGuest.view())) !== "subscribe") fail("denied phone not routed to Subscribe");
if (relay.roomCount() !== 0) fail("an unentitled socket opened a room");
pass("real relay refuses the no-claim token 4403 -> guest ended -> isEntitlementDenied -> Subscribe (no room)");

// [3] ENTITLED: a premium phone goes LIVE against a real host — a paying user is NEVER shown Subscribe
const hostSock = new CollabSocket({ wsUrl, role: "host", key, authToken: () => "tok-premium" });
const host = new CollabHost(hostSock, { header: { sessionId: "s6", title: "Remote session", model: "claude-opus-4-8", hostName: "nick@desktop", startedAt: 1000 } });
host.start();
const paidSock = new CollabSocket({ wsUrl, role: "guest", key, authToken: () => "tok-premium" });
const paidGuest = new CollabGuest(paidSock, { name: "paid@phone", writeToken: null }, {});
paidGuest.start();
await until(() => paidGuest.view().phase === "live", "premium guest live");
if (isEntitlementDenied(paidGuest.view())) fail("an entitled guest was wrongly flagged denied");
if (remoteGate(true, isEntitlementDenied(paidGuest.view())) !== "connect") fail("entitled phone not routed to connect");
pass("premium phone authenticates + goes live against the host (never shown Subscribe)");
paidGuest.leave();
host.stop("done");

// [4] createRemoteCheckout: opens a Stripe session, fail-closed on any error
const stripeUrl = "https://checkout.stripe.com/c/pay/cs_test_demo";
const okFetch = ((_u: string, _i?: RequestInit) => Promise.resolve({ ok: true, status: 200, json: async () => ({ result: { url: stripeUrl } }) } as Response)) as typeof fetch;
const errFetch = ((_u: string, _i?: RequestInit) => Promise.resolve({ ok: true, status: 200, json: async () => ({ error: { message: "card declined" } }) } as Response)) as typeof fetch;
const url = await createRemoteCheckout({ functionsBaseUrl: "https://fns.example.com", token: "id-token", fetchImpl: okFetch });
if (url !== stripeUrl) fail("checkout did not return the Stripe URL");
if (await createRemoteCheckout({ functionsBaseUrl: "https://fns.example.com", token: "id-token", fetchImpl: errFetch }) !== null) fail("an { error } reply was not fail-closed");
if (await createRemoteCheckout({ functionsBaseUrl: "https://fns.example.com", token: null, fetchImpl: okFetch }) !== null) fail("a missing token was not fail-closed");
pass("createRemoteCheckout: returns the Stripe URL on success, null fail-closed on error / no token");

// [5] POST-CHECKOUT: the refreshed token gains the claim -> the phone recognises it and retries
if (entitlementActive(jwt({ email: "paid@gmail.com" }))) fail("a pre-webhook token must NOT be active");
pass("before the webhook the refreshed token has no claim -> entitlementActive false (stay on Subscribe)");
if (!entitlementActive(jwt({ premium: true, email: "paid@gmail.com" }))) fail("a post-webhook premium token must be active");
if (remoteGate(true, false) !== "connect") fail("post-claim phone should connect");
pass("after the webhook the refreshed token carries `premium` -> entitlementActive -> the phone reconnects");

relay.stop();
console.log(`\nP-REMOTE.6 demo: all ${step} checks passed — the paid tier gates on the relay, fail-closed, and the phone drives checkout + retry.`);
process.exit(0);
