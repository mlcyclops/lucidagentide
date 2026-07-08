// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pcollab6.ts
//
// P-COLLAB.6 (ADR-0193): enterprise/MDM governance for the OPTIONAL embedded relay - rock-solid, fail-closed,
// absolute allowlisting. Proves, with sample managed policies (as an admin would push via GPO/Intune/JAMF or
// the machine-wide policy file):
//   [1] unmanaged: hosting is the user's call (localhost + LAN both allowed),
//   [2] a managed `allowServe:false` FORBIDS hosting entirely - and startRelayServer THROWS (no listener),
//   [3] under management, a non-localhost (LAN) bind is REFUSED unless it is on the ABSOLUTE allowlist,
//   [4] an allowlisted host:port binds for real; a wrong port / wrong host does not,
//   [5] `allowedRelays` whitelists which relay endpoints a user may CONNECT to,
//   [6] localhost is always permitted (the safe default; reach a remote guest over a tunnel/VPN).
//
// Run with: bun run harness/scripts/demo_pcollab6.ts

import { authorizeRelayBind, authorizeRelayConnect, collabServeAllowed, type ManagedConfig } from "../../desktop/managed_config.ts";
import { startRelayServer } from "../../desktop/collab/relay_server.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-COLLAB.6 demo - enterprise/MDM governance for the embedded relay\n");

// [1] unmanaged: the user's own machine
if (!collabServeAllowed(null)) fail("unmanaged should allow serving");
if (!authorizeRelayBind("127.0.0.1", 8790, null).ok) fail("unmanaged localhost must bind");
if (!authorizeRelayBind("10.0.0.5", 8790, null).ok) fail("unmanaged LAN is the user's call");
ok("unmanaged: hosting allowed on localhost AND LAN (the user's own machine)");

// [2] managed allowServe:false forbids hosting - and the server refuses to start
const denied: ManagedConfig = { orgName: "Acme", collab: { allowServe: false } };
if (collabServeAllowed(denied)) fail("allowServe:false must forbid serving");
let threw = false;
try {
  startRelayServer({ port: 0, hostname: "127.0.0.1", authorizeBind: (h, p) => authorizeRelayBind(h, p, denied) });
} catch (e) { threw = true; if (!String((e as Error).message).includes("disabled by Acme")) fail(`wrong refusal: ${(e as Error).message}`); }
if (!threw) fail("startRelayServer must THROW when policy forbids hosting (fail-closed, no listener)");
ok("managed allowServe:false: startRelayServer THROWS - no inbound listener is ever opened (fail-closed)");

// [3] under management, a LAN bind with NO allowlist is refused
const managedNoList: ManagedConfig = { orgName: "Acme", collab: {} };
if (authorizeRelayBind("10.0.0.5", 8790, managedNoList).ok) fail("managed LAN bind must need an allowlist");
if (authorizeRelayBind("0.0.0.0", 8790, managedNoList).ok) fail("all-interfaces is NOT loopback - must be refused");
if (!authorizeRelayBind("127.0.0.1", 8790, managedNoList).ok) fail("localhost must still bind under management");
ok("managed, no allowlist: a LAN / 0.0.0.0 bind is REFUSED; localhost still binds");

// [4] the ABSOLUTE bind allowlist - only listed host:port pass, and it binds for real
const allowlisted: ManagedConfig = { orgName: "Acme", collab: { allowedBinds: ["127.0.0.1", "10.0.0.5:8790"] } };
if (authorizeRelayBind("10.0.0.5", 9999, allowlisted).ok) fail("wrong port must be refused");
if (authorizeRelayBind("10.0.0.6", 8790, allowlisted).ok) fail("wrong host must be refused");
if (!authorizeRelayBind("10.0.0.5", 8790, allowlisted).ok) fail("the allowlisted host:port must pass");
const handle = startRelayServer({ port: 0, hostname: "127.0.0.1", authorizeBind: (h, p) => authorizeRelayBind(h, p, allowlisted) });
if (!handle.port) fail("an allowed bind should have opened a listener");
handle.stop();
ok(`absolute allowlist: only the exact host:port passes; an allowed bind opened a real listener (then stopped)`);

// [5] connect allowlist - which relays a user may reach
const connectPolicy: ManagedConfig = { orgName: "Acme", collab: { allowedRelays: ["relay.corp.internal:443", "my.omp.sh"] } };
if (!authorizeRelayConnect("wss://relay.corp.internal/r/abc", connectPolicy).ok) fail("approved relay (wss→443) must connect");
if (!authorizeRelayConnect("wss://my.omp.sh/r/x", connectPolicy).ok) fail("host-only entry must allow any port");
if (authorizeRelayConnect("wss://evil.example/r/x", connectPolicy).ok) fail("an unapproved relay must be refused");
if (authorizeRelayConnect("not a url", connectPolicy).ok) fail("a malformed endpoint must fail closed");
ok("allowedRelays: only approved relay endpoints may be connected to (host or guest); malformed fails closed");

console.log("\nP-COLLAB.6 demo complete - the 'be the relay' toggle + the bind IP/DNS/port are governed absolutely by enterprise/MDM policy, fail-closed. The toggle UI (which reads this + managedLocks.collab) is the next slice.");
process.exit(0);
