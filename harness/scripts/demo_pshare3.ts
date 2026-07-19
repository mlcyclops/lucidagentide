// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pshare3.ts
//
// P-SHARE.3: mobile-safe invite links, proven headlessly against the PURE helper the Share dock wires in.
// A live room mints TWO forms of each invite: an https PHONE/BROWSER link (secret in the fragment) and a wss
// LUCID-to-LUCID link (bare `roomId.secret` in the PATH). Texting the wss form to a phone is the classic
// footgun: the messenger drops the scheme and opens `https://<host>/r/<roomId>.<secret>`, which fails to join
// AND leaks the E2E room secret into whatever HTTP server answers that host (observed live in the apex logs).
// classifyInviteLink is the single source of truth the UI renders from. It guarantees:
//   1. the https link is FEATURED as the phone link; the wss link is kept as a separate "desktop only" link;
//   2. a wss link is NEVER offered as the phone link and NEVER encoded as a "scan me" QR (the core fix);
//   3. an https link on a private/LAN host is flagged reachable-only-on-the-same-network.
//
// The visual chrome (accent phone button, dashed muted desktop field, caution banner) is exercised by the
// pure classification here + the renderer unit tests; a live Electron pointer test has no headless harness.
//
// Run with: bun run harness/scripts/demo_pshare3.ts

import { classifyInviteLink } from "../../desktop/renderer/share_dock.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-SHARE.3 demo - mobile-safe invite links (pure classifier)\n");

const pwa = "https://lucid-agent.web.app/remote/#room1.SECRET";
const wss = "wss://relay.run.app/r/room1.SECRET";

// ── [1] hosted-PWA share: feature the https link (public), keep the wss link as desktop-only, QR the phone link ──
const hosted = classifyInviteLink(pwa, wss);
if (hosted.phoneLink !== pwa) fail("the https PWA link must be the featured phone link");
if (hosted.desktopLink !== wss) fail("the wss link must stay available as the desktop-only link");
if (hosted.phoneReach !== "public") fail("a hosted-rendezvous FQDN must read as opens-anywhere");
if (!hosted.showQr) fail("a real browser link must be QR-able");
ok("hosted share: phone link = https PWA (public, QR'd); wss stays a clearly-separate desktop link");

// ── [2] THE CORE FIX: with no browser link minted, the wss link is NEVER shown as the phone link or QR'd ──
const noPwa = classifyInviteLink("", wss);
if (noPwa.phoneLink !== "") fail("a wss link must never be offered to a phone");
if (noPwa.showQr) fail("a wss link must never be encoded as a 'scan with your phone camera' QR");
if (noPwa.phoneReach !== "none") fail("with no browser link, phoneReach must be 'none' (surface a caution, not a bad link)");
if (noPwa.desktopLink !== wss) fail("the wss link must still be offered as the desktop link");
ok("no-PWA share: the wss link is demoted to desktop-only - never texted to a phone, never QR'd (the footgun is closed)");

// ── [3] a self-hosted https link on a LAN/loopback host is flagged same-network-only ──
const lanCases: [string, string][] = [
  ["https://192.168.1.5:8790/#r.S", "RFC1918"],
  ["https://10.0.0.4/#r.S", "RFC1918 /8"],
  ["https://172.16.9.9/#r.S", "RFC1918 /12"],
  ["https://relay.local/#r.S", "mDNS .local"],
  ["https://mylaptop/#r.S", "bare hostname"],
  ["https://localhost:8790/#r.S", "loopback"],
  ["https://[::1]/#r.S", "IPv6 loopback"],
  ["https://100.100.0.1/#r.S", "CGNAT (Tailscale)"],
];
for (const [link, why] of lanCases) {
  if (classifyInviteLink(link, null).phoneReach !== "lan") fail(`${why} host must read as LAN-only: ${link}`);
}
ok(`LAN/loopback https hosts flagged same-network-only (${lanCases.length} shapes: RFC1918, mDNS, bare, loopback, CGNAT)`);

// ── [4] a real public relay host opens anywhere ──
if (classifyInviteLink("https://relay.your-org.internal/#r.S", null).phoneReach !== "public") fail("a public FQDN must read as public");
if (classifyInviteLink("https://8.8.8.8/#r.S", null).phoneReach !== "public") fail("a public IPv4 literal must read as public");
ok("a real relay FQDN / public IP reads as opens-anywhere (no false LAN caution)");

// ── [5] hygiene: identical/non-ws desktop values are dropped; empties are safe ──
if (classifyInviteLink(pwa, pwa).desktopLink !== "") fail("a desktop link identical to the phone link must be dropped (no duplicate row)");
if (classifyInviteLink(pwa, "https://not-a-ws/#x").desktopLink !== "") fail("a non-ws(s) 'desktop' value must be discarded");
const empty = classifyInviteLink("", "");
if (empty.phoneLink !== "" || empty.desktopLink !== "" || empty.phoneReach !== "none" || empty.showQr) fail("empty input must classify to nothing-to-send");
if (classifyInviteLink(null, null).phoneReach !== "none") fail("null input must be safe");
ok("identical/non-ws desktop values dropped; empty + null inputs classify safely");

console.log("\nP-SHARE.3 demo complete - the Share dock features the https link for phones, keeps the wss link in a labeled 'desktop only' row, and never texts or QR-codes a wss (LAN) link to a phone.");
process.exit(0);
