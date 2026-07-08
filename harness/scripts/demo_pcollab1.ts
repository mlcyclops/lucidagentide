// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pcollab1.ts
//
// P-COLLAB.1 (ADR-0192): the live-collaboration transport KEYSTONE. Proves, offline, the security-critical
// path two LUCID sessions share over the (untrusted) relay - without any relay or UI yet:
//   [1] a host mints a room (id + 32B key + 16B write token) and a FULL invite link + a VIEW link,
//   [2] both links parse back exactly; the VIEW link is read-only (no write token),
//   [3] the host SEALS a LUCID ChatEvent frame (AES-256-GCM) + envelopes it with its peer id,
//   [4] a guest holding the link unpacks the envelope + OPENS the frame - the relay only ever saw opaque
//       bytes (a wrong key cannot open it), and a tampered byte fails the auth tag (fail-closed).
//
// Run with: bun run harness/scripts/demo_pcollab1.ts

import { generateRoomKey, generateWriteToken, importRoomKey, seal, open, packEnvelope, unpackEnvelope } from "../../desktop/collab/crypto.ts";
import { generateRoomId, formatShareLink, formatBrowserLink, parseShareLink } from "../../desktop/collab/link.ts";
import type { LucidCollabFrame } from "../../desktop/collab/frames.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-COLLAB.1 demo - live-collaboration transport keystone\n");

// [1] host mints a room + links
const roomId = generateRoomId();
const key = generateRoomKey();
const token = generateWriteToken();
const fullLink = formatShareLink(roomId, key, token);
const viewLink = formatShareLink(roomId, key);
const browser = formatBrowserLink("https://relay.example.com", fullLink);
ok(`host minted room ${roomId.slice(0, 8)}… + a full link, a view link, and a browser link`);

// [2] links parse back; view is read-only
const pFull = parseShareLink(fullLink);
const pView = parseShareLink(viewLink);
const pBrowser = parseShareLink(browser);
if (pFull.roomId !== roomId || [...pFull.key].join() !== [...key].join() || !pFull.writeToken) fail("full link did not round-trip");
if (pView.writeToken !== null) fail("view link should be read-only (no write token)");
if (pBrowser.roomId !== roomId || !pBrowser.writeToken) fail("browser link did not round-trip");
ok("full/view/browser links parse back; the VIEW link is read-only (writeToken null)");

// [3] host seals a real LUCID ChatEvent frame + envelopes it
const frame: LucidCollabFrame = { t: "event", event: { type: "token", text: "def add(a, b):\n    return a + b" } };
const hostKey = await importRoomKey(key);
const wire = packEnvelope(1 /* host peer id */, await seal(hostKey, frame));
if ([...wire.subarray(0, 4)].join() === "0,0,0,0" && false) fail("unreachable");
ok(`host sealed a ChatEvent + envelopes it (${wire.byteLength} opaque bytes on the wire)`);

// [4] a guest holding the link opens it; a wrong key + a tampered byte both fail
const guestKey = await importRoomKey(pView.key); // the guest only has the link's key
const { peerId, sealed } = unpackEnvelope(wire);
const got = await open(guestKey, sealed);
if (peerId !== 1 || JSON.stringify(got) !== JSON.stringify(frame)) fail("guest could not reconstruct the frame");
ok("guest unpacked the envelope + opened the frame end-to-end (relay saw only ciphertext)");

const stranger = await importRoomKey(generateRoomKey());
let rejectedWrongKey = false, rejectedTamper = false;
try { await open(stranger, sealed); } catch { rejectedWrongKey = true; }
const bad = sealed.slice(); bad[bad.byteLength - 1] ^= 0xff;
try { await open(guestKey, bad); } catch { rejectedTamper = true; }
if (!rejectedWrongKey || !rejectedTamper) fail("E2E broken: a wrong key or a tampered frame must be rejected");
ok("fail-closed: a wrong room key AND a tampered byte are both rejected (the relay cannot read or forge)");

console.log("\nP-COLLAB.1 demo complete - the E2E seal + envelope + invite link are proven; the relay client, host/guest, and Share UI are P-COLLAB.2-.4.");
