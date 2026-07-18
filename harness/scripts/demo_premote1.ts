// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_premote1.ts — P-REMOTE.1 (ADR-0226/0227): the relay identity gate, END TO END, offline.
//
// Everything here is real EXCEPT Google: a locally-minted RSA keypair stands in for Google's securetoken
// signing key, served from a REAL local JWKS endpoint (Bun.serve), consumed by the REAL createFirebaseVerifier
// (WebCrypto RS256), gating a REAL relay (startRelayServer) that REAL WebSocket clients dial.
//
//   [1] a premium Google sign-in authenticates via the FIRST-frame auth (never a URL param) → auth-ok → room
//   [2] an allowlisted email with NO paid claim is admitted (self-host mode) and E2E bytes round-trip opaquely
//   [3] an expired token is refused 4401
//   [4] a verified sign-in WITHOUT entitlement is refused 4403 (payment ≠ trust — and no payment, no relay)
//   [5] a tampered signature is refused 4401
//   [6] a silent socket is reaped at the deadline 4401 — and the room count proves nothing was admitted
//   [7] anonymous mode (no auth) still admits instantly — the self-host default is byte-identical

import { generateKeyPairSync, sign as signRsa } from "node:crypto";
import { startRelayServer } from "../../desktop/collab/relay_server.ts";
import { createFirebaseVerifier } from "../../desktop/collab/relay_auth.ts";

const PROJECT = "lucid-agent";
const KID = "demo-kid";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: rogueKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function mint(claims: Record<string, unknown>, key = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: PROJECT,
    iss: `https://securetoken.google.com/${PROJECT}`,
    sub: "demo-uid",
    email: "user@gmail.com",
    email_verified: true,
    iat: now - 30,
    exp: now + 3600,
    firebase: { sign_in_provider: "google.com" },
    ...claims,
  };
  const si = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${si}.${signRsa("sha256", Buffer.from(si), key).toString("base64url")}`;
}

interface Dialed {
  ws: WebSocket;
  strings: string[];
  binaries: Uint8Array[];
  close: { code: number; reason: string } | null;
}
function dial(url: string): Promise<Dialed> {
  const { promise, resolve } = Promise.withResolvers<Dialed>();
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const d: Dialed = { ws, strings: [], binaries: [], close: null };
  ws.onopen = () => resolve(d);
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") d.strings.push(ev.data);
    else d.binaries.push(new Uint8Array(ev.data as ArrayBuffer));
  };
  ws.onclose = (ev) => {
    d.close = { code: ev.code, reason: ev.reason };
    resolve(d);
  };
  return promise;
}
async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (cond()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
  throw new Error(`timed out: ${label}`);
}

let step = 0;
function pass(msg: string): void {
  step++;
  console.log(`  [${step}] PASS ${msg}`);
}
function fail(msg: string): never {
  console.error(`  FAIL ${msg}`);
  process.exit(1);
}

console.log("== P-REMOTE.1: the relay identity gate (offline — local JWKS stands in for Google) ==");

// A REAL local JWKS endpoint (what Google serves for securetoken, minus Google).
const jwks = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () =>
    new Response(
      JSON.stringify({ keys: [{ ...(publicKey.export({ format: "jwk" }) as Record<string, string>), kid: KID, alg: "RS256", use: "sig" }] }),
      { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } },
    ),
});

const verify = createFirebaseVerifier({
  projectId: PROJECT,
  allowedEmails: ["nicholas.chadwick.ctr@gmail.com"],
  jwksUrl: `http://127.0.0.1:${jwks.port}/`,
});

const relay = startRelayServer({ port: 0, auth: { verify, deadlineMs: 300 } });
const base = `ws://127.0.0.1:${relay.port}`;

// [1] premium sign-in → first-frame auth → auth-ok → hosts a room
const host = await dial(`${base}/r/demo?role=host`);
host.ws.send(JSON.stringify({ t: "auth", token: mint({ premium: true }) }));
await until(() => host.strings.some((s) => s.includes("auth-ok")), "host auth-ok");
if (relay.roomCount() !== 1) fail("premium host was not admitted to a room");
pass("premium Google sign-in → first-frame auth → auth-ok → room open (token NEVER in the URL)");

// [2] allowlisted email, NO paid claim → admitted; E2E envelope round-trips opaquely
const guest = await dial(`${base}/r/demo?role=guest`);
guest.ws.send(JSON.stringify({ t: "auth", token: mint({ email: "nicholas.chadwick.ctr@gmail.com", sub: "uid-nick" }) }));
await until(() => guest.strings.some((s) => s.includes("auth-ok")), "guest auth-ok");
guest.ws.send(new Uint8Array([0, 0, 0, 0, 222, 173, 190, 239])); // [4B target][opaque ciphertext]
await until(() => host.binaries.length === 1, "envelope at host");
const got = host.binaries[0]!;
if (![...got.subarray(4)].every((b, i) => b === [222, 173, 190, 239][i])) fail("payload was not forwarded opaquely");
pass("allowlisted email (no claim) admitted — self-host mode; sealed bytes forwarded untouched");

// [3] expired token → 4401
const expired = await dial(`${base}/r/demo2?role=host`);
expired.ws.send(JSON.stringify({ t: "auth", token: mint({ premium: true, exp: Math.floor(Date.now() / 1000) - 600 }) }));
await until(() => expired.close !== null, "expired refusal");
if (expired.close!.code !== 4401) fail(`expired token got ${expired.close!.code}, wanted 4401`);
pass("expired token refused (4401)");

// [4] verified sign-in, no entitlement, not allowlisted → 4403
const broke = await dial(`${base}/r/demo3?role=host`);
broke.ws.send(JSON.stringify({ t: "auth", token: mint({ email: "stranger@gmail.com", sub: "uid-stranger" }) }));
await until(() => broke.close !== null, "unentitled refusal");
if (broke.close!.code !== 4403) fail(`unentitled sign-in got ${broke.close!.code}, wanted 4403`);
pass("verified Google sign-in WITHOUT premium/admin/allowlist refused (4403) — no payment, no rendezvous");

// [5] tampered signature → 4401
const forged = await dial(`${base}/r/demo4?role=host`);
forged.ws.send(JSON.stringify({ t: "auth", token: mint({ premium: true }, rogueKey) }));
await until(() => forged.close !== null, "forged refusal");
if (forged.close!.code !== 4401) fail(`forged token got ${forged.close!.code}, wanted 4401`);
pass("tampered/forged signature refused (4401)");

// [6] silence → reaped at the deadline, nothing admitted
const silent = await dial(`${base}/r/demo5?role=host`);
await until(() => silent.close !== null, "deadline reap");
if (silent.close!.code !== 4401) fail(`silent socket got ${silent.close!.code}, wanted 4401`);
if (relay.roomCount() !== 1) fail("a refused socket changed the room count");
pass("silent socket reaped at the auth deadline (4401); room count untouched");

relay.stop();

// [7] anonymous mode: byte-identical self-host behavior (no auth frames, instant admission)
const anon = startRelayServer({ port: 0 });
const anonHost = await dial(`ws://127.0.0.1:${anon.port}/r/plain?role=host`);
await until(() => anon.roomCount() === 1, "anonymous room");
if (anonHost.strings.some((s) => s.includes("auth-ok"))) fail("anonymous mode emitted an auth frame");
pass("anonymous mode (no RELAY_AUTH): admitted at open, no auth protocol — self-host default unchanged");
anon.stop();
jwks.stop(true);

console.log(`\nP-REMOTE.1 demo: all ${step} checks passed — the rendezvous is identity-gated, fail-closed, and E2E-opaque.`);
process.exit(0);
