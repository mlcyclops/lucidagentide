// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pcollab19.ts
//
// P-COLLAB.19 (ADR-0241): ONE room, TWO capabilities - hand an EDIT invite and a VIEW-ONLY invite to
// DIFFERENT guests of the same live session. Proven with real crypto on the pure minting path:
// the full link + its phone twin carry the write token (that guest can drive); the view link + its phone
// twin carry only the room key (watch, never write); all four open the SAME room with the SAME key. The
// host-side write gate (a view guest's prompt refused) is already proven by demo-P-COLLAB.12.
//
// Run with: bun run harness/scripts/demo_pcollab19.ts

import { generateRoomId, mintRoomLinks, parseShareLink } from "../../desktop/collab/link.ts";
import { generateRoomKey, generateWriteToken } from "../../desktop/collab/crypto.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-COLLAB.19 demo - dual invite links: EDIT for one guest, VIEW-ONLY for another\n");

const relay = { wsBase: "wss://relay.aiworkshopapps.com", httpBase: "https://relay.aiworkshopapps.com", pwaBase: "https://lucid-agent.web.app/remote" };
const roomId = generateRoomId();
const key = generateRoomKey();
const token = generateWriteToken();

// [1] an edit share mints all four forms over ONE room
const links = mintRoomLinks(relay, roomId, key, token, true);
const parsed = {
  full: parseShareLink(links.fullLink),
  view: parseShareLink(links.viewLink),
  browser: parseShareLink(links.browserLink),
  browserView: parseShareLink(links.browserViewLink),
};
for (const [name, p] of Object.entries(parsed)) if (p.roomId !== roomId) fail(`${name} link lost the room id`);
ok("an edit share mints 4 link forms (desktop + phone, edit + view) over the SAME room");

// [2] capability split: the edit pair drives, the view pair can never write
if (!parsed.full.writeToken || !parsed.browser.writeToken) fail("the edit pair must carry the write token");
if (parsed.view.writeToken !== null || parsed.browserView.writeToken !== null) fail("the view pair must NEVER carry a write token");
ok("capability split: edit pair carries the write token; view pair carries only the room key");

// [3] both capabilities open the same E2E room: identical key bytes, different tokens
if (!Buffer.from(parsed.full.key).equals(Buffer.from(parsed.view.key))) fail("both capabilities must share the room key");
if (!Buffer.from(parsed.browser.key).equals(Buffer.from(parsed.browserView.key))) fail("phone twins must share the room key");
ok("both capabilities decrypt the same E2E stream (same key); only the WRITE capability differs");

// [4] a view-only share never mints an edit-capable phone link
const viewOnly = mintRoomLinks(relay, generateRoomId(), generateRoomKey(), generateWriteToken(), false);
if (viewOnly.browserLink !== viewOnly.browserViewLink) fail("a view share's phone links must be identical (both view)");
if (parseShareLink(viewOnly.browserLink).writeToken !== null) fail("a view share must never mint an edit phone link");
ok("a view-only share mints only watch-capable phone links");

// [5] legacy relay (no hosted PWA): browser forms stay token-free (unchanged behavior)
const legacy = mintRoomLinks({ wsBase: "wss://relay.local", httpBase: "https://relay.local" }, generateRoomId(), generateRoomKey(), generateWriteToken(), true);
if (legacy.browserLink !== legacy.browserViewLink || parseShareLink(legacy.browserLink).writeToken !== null) fail("the legacy browser form must stay token-free");
ok("legacy (no-PWA) browser links stay token-free - no behavior change for self-hosted relays");

console.log("\nP-COLLAB.19 demo complete - hand the EDIT link to the guest who drives and the VIEW-ONLY link to everyone else; same room, same E2E stream, write capability only where you granted it. Host-side write refusal for view guests: demo-P-COLLAB.12.");
process.exit(0);
