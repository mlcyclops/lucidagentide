// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pshare2.ts
//
// P-SHARE.2 (ADR-0234): Session Share dock UI polish, proven headlessly against the PURE helpers the renderer
// wires in. Two things it guarantees:
//   1. the "Reachable at" bind list defaults to a GUEST-ROUTABLE address (LAN IPv4, then IPv6) and sinks
//      loopback to the bottom - a guest can never reach 127.0.0.1/::1, so it must not be the default;
//   2. the cold-boot first-paint cache is SECRET-FREE - it carries the non-secret relay descriptor + serve
//      status + a redacted P2P config, but NEVER an invite link, room id, or TURN credential (all secrets),
//      and never a stale "Live" state.
//
// The interactive bits (checkbox-persist across draw(), padding, the "updating" chip) are exercised by the
// pure helpers here + the renderer unit tests; a live Electron pointer test has no headless harness.
//
// Run with: bun run harness/scripts/demo_pshare2.ts

import { orderBindAddresses, redactShareSnapshot } from "../../desktop/renderer/share_dock.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-SHARE.2 demo - Session Share dock UI polish (pure helpers)\n");

// ── [1] the exact address list the backend returns today (loopback first), as in the reported screenshot ──
const backendOrder = [
  { address: "127.0.0.1", family: "IPv4" as const, kind: "loopback" as const, label: "127.0.0.1 - this machine only" },
  { address: "::1", family: "IPv6" as const, kind: "loopback" as const, label: "::1 - this machine only" },
  { address: "192.168.254.123", family: "IPv4" as const, kind: "lan" as const, label: "192.168.254.123 - your LAN" },
  { address: "fe80::4cee:e2c8:bf69:cb0f", family: "IPv6" as const, kind: "lan" as const, label: "fe80::4cee - your LAN" },
];
const ordered = orderBindAddresses(backendOrder);
if (ordered.map((a) => a.address).join(",") !== "192.168.254.123,fe80::4cee:e2c8:bf69:cb0f,127.0.0.1,::1") {
  fail(`unexpected order: ${ordered.map((a) => a.address).join(",")}`);
}
if (ordered[0]!.kind === "loopback") fail("the DEFAULT (first) address must be guest-routable, never loopback");
ok(`default bind is ${ordered[0]!.address} (LAN IPv4); loopback sank to the bottom (${ordered.at(-1)!.address})`);

// ── [2] IPv4 precedes IPv6 within each group ──
const grouped = orderBindAddresses([
  { address: "::1", family: "IPv6" as const, kind: "loopback" as const, label: "" },
  { address: "127.0.0.1", family: "IPv4" as const, kind: "loopback" as const, label: "" },
  { address: "fe80::1", family: "IPv6" as const, kind: "vpn" as const, label: "" },
  { address: "10.0.0.2", family: "IPv4" as const, kind: "vpn" as const, label: "" },
]);
if (grouped.map((a) => a.address).join(",") !== "10.0.0.2,fe80::1,127.0.0.1,::1") fail("IPv4 must precede IPv6 within a group");
ok("routable IPv4 -> routable IPv6 -> loopback IPv4 -> loopback IPv6");

// ── [3] the input array is not mutated (the renderer re-reads serve.addresses) ──
const input = [{ address: "::1", family: "IPv6" as const, kind: "loopback" as const, label: "" }, { address: "10.0.0.1", family: "IPv4" as const, kind: "lan" as const, label: "" }];
const before = input.map((a) => a.address).join(",");
orderBindAddresses(input);
if (input.map((a) => a.address).join(",") !== before) fail("orderBindAddresses must not mutate its input");
ok("input array is left untouched (pure)");

// ── [4] the cached first-paint snapshot is SECRET-FREE ──
const relay = { wsBase: "wss://relay.aiworkshopapps.com/r", httpBase: "https://relay.aiworkshopapps.com/r", label: "relay.aiworkshopapps.com", source: "self-hosted", gated: true };
const serve = { running: false, addresses: ordered, managed: { locked: false, allowServe: true, org: null } };
const snap = redactShareSnapshot(relay, serve, { preferDirect: true, iceUrls: ["stun:stun.l.google.com:19302"], turnUsername: "alice", turnCredential: "SUPER-SECRET-TURN-CRED" });
const serialized = JSON.stringify(snap);
if (serialized.includes("SUPER-SECRET-TURN-CRED")) fail("a TURN credential is a secret - it must never be cached");
if (snap.p2pCfg?.turnCredential !== undefined) fail("turnCredential must be stripped");
if (snap.p2pCfg?.preferDirect !== true || snap.p2pCfg?.turnUsername !== "alice") fail("non-secret P2P fields must be preserved");
ok("the snapshot drops the TURN credential (secret) but keeps preferDirect / iceUrls / turnUsername");

// ── [5] the snapshot has NO invite link / room id / active state (idle shell only, by construction) ──
const keys = Object.keys(snap).sort().join(",");
if (keys !== "p2pCfg,relay,serve") fail(`the snapshot must hold ONLY {relay, serve, p2pCfg}; got {${keys}}`);
if (/room1|\.KEY|TOKEN|"active"\s*:\s*true/.test(serialized)) fail("no invite link / room id / live state may be cached");
ok("the snapshot carries only the non-secret relay + serve + redacted P2P - never a link, room id, or 'Live' state");

console.log("\nP-SHARE.2 demo complete - the bind list defaults to a guest-routable address (loopback demoted), and the cold-boot cache paints a secret-free idle shell instantly (no link / room id / TURN credential ever on disk).");
process.exit(0);
