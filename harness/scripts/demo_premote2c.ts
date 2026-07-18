// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_premote2c.ts — P-REMOTE.2c (ADR-0226/0227): backend token delivery to the host socket.
//
// The renderer pushes a fresh Firebase ID token to the backend; the host CollabSocket reads it through
// `authToken`. This drives that exact seam over a REAL gated relay: a host socket whose authToken is the
// RelayTokenCache connects + authenticates when a live token is cached, FAILS CLOSED (never a silent
// unauthenticated connect) when the cache is empty or the token is refused, and a plain socket (no authToken,
// the un-gated default) still connects anonymously — proving 2c changes nothing for existing relays.

import { startRelayServer } from "../../desktop/collab/relay_server.ts";
import { CollabSocket } from "../../desktop/collab/relay_client.ts";
import { RelayTokenCache } from "../../desktop/collab/relay_token_cache.ts";
import { generateRoomKey, importRoomKey } from "../../desktop/collab/crypto.ts";
import { generateRoomId } from "../../desktop/collab/link.ts";
import type { AuthVerdict } from "../../desktop/collab/relay_auth.ts";

let step = 0;
const pass = (m: string): void => { console.log(`  [${++step}] PASS ${m}`); };
const fail = (m: string): never => { console.error(`  FAIL ${m}`); process.exit(1); };
const until = async (cond: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 600; i++) { if (cond()) return; const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, 5); await promise; }
  throw new Error(`timed out: ${label}`);
};

console.log("== P-REMOTE.2c: renderer-pushed token -> backend cache -> host socket authenticates ==");

const NOW = Date.now();
const verify = async (t: string): Promise<AuthVerdict> =>
  t === "good-token" ? { ok: true, uid: "u1", email: "nick@x.io", premium: true, admin: false } : { ok: false, code: 4401, reason: "bad token" };
const relay = startRelayServer({ port: 0, auth: { verify } });
const key = await importRoomKey(generateRoomKey());
const dial = (room: string, authToken?: () => string | null) =>
  new CollabSocket({ wsUrl: `ws://127.0.0.1:${relay.port}/r/${room}`, role: "host", key, ...(authToken ? { authToken } : {}) });

// [1] a live token in the cache -> the host authenticates + opens the room (what a provisioned share does)
const cache = new RelayTokenCache();
cache.set("good-token", NOW + 3600_000); // the renderer's POST /api/collab/token lands here
let opened = false;
const h1 = dial(generateRoomId(), () => cache.get());
h1.onOpen = () => { opened = true; };
h1.connect();
await until(() => opened, "host authenticated + open");
if (relay.roomCount() !== 1) fail("host did not open a room after auth");
pass("cached token -> host presents it as the first frame -> auth-ok -> room open");
h1.close();

// [2] empty cache -> authToken returns null -> FAIL CLOSED (terminal, never a silent anonymous connect)
cache.clear();
let closed2 = "";
let reconnect2 = true;
const h2 = dial(generateRoomId(), () => cache.get());
h2.onClose = (reason, willReconnect) => { closed2 = reason; reconnect2 = willReconnect; };
h2.connect();
await until(() => closed2 !== "", "empty-cache terminal close");
if (reconnect2) fail("an empty cache scheduled a reconnect (should be terminal)");
if (relay.roomCount() !== 0) fail("a room opened without a token");
pass("empty cache -> null token -> terminal fail-closed (no unauthenticated room)");

// [3] a refused token -> the relay closes 4401 (fatal, no retry storm)
cache.set("stale-or-forged", NOW + 3600_000);
let code3 = 0;
const h3 = dial(generateRoomId(), () => cache.get());
h3.onClose = (reason) => { code3 = /sign in/i.test(reason) || /authentication/i.test(reason) ? 4401 : 1; };
h3.connect();
await until(() => code3 !== 0, "refused-token close");
if (relay.roomCount() !== 0) fail("a room opened with a refused token");
pass("refused token -> relay 4401 -> fatal (no room, no retry storm)");

// [4] the un-gated default is UNCHANGED: a plain host (no authToken) connects anonymously
const anon = startRelayServer({ port: 0 }); // no auth
let anonOpen = false;
const h4 = new CollabSocket({ wsUrl: `ws://127.0.0.1:${anon.port}/r/${generateRoomId()}`, role: "host", key });
h4.onOpen = () => { anonOpen = true; };
h4.connect();
await until(() => anonOpen, "anonymous host open");
if (anon.roomCount() !== 1) fail("anonymous host did not open a room");
pass("no authToken (un-gated default) -> anonymous connect, unchanged");
h4.close();

relay.stop();
anon.stop();
console.log(`\nP-REMOTE.2c demo: all ${step} checks passed — the backend delivers the token to the host socket, fail-closed.`);
process.exit(0);
