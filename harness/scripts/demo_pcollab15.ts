// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pcollab15.ts
//
// P-COLLAB.15 (ADR-0231): LIVE user-turn mirroring, proven end-to-end over a REAL relay. The host broadcasts
// every user turn (its own + each guest's, attributed by `from`) so ALL participants - not just the sender -
// see who typed what, in order. Two guests join; the host's turn and a guest-attributed turn both reach BOTH
// guests live; and a guest that joins AFTER a turn still sees it in the welcome replay.
//
// Run with: bun run harness/scripts/demo_pcollab15.ts

import { startRelayServer } from "../../desktop/collab/relay_server.ts";
import { CollabSocket } from "../../desktop/collab/relay_client.ts";
import { CollabHost } from "../../desktop/collab/host.ts";
import { CollabGuest } from "../../desktop/collab/guest.ts";
import { generateRoomKey, generateWriteToken, importRoomKey } from "../../desktop/collab/crypto.ts";
import { generateRoomId, formatRelayLink, parseShareLink } from "../../desktop/collab/link.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }
async function waitFor(cond: () => boolean, label: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) { if (cond()) return; await Bun.sleep(5); }
  fail(`timed out waiting for ${label}`);
}

console.log("P-COLLAB.15 demo - live user-turn mirroring over a real relay\n");

const relay = startRelayServer({ port: 0, hostname: "127.0.0.1" });
const roomId = generateRoomId();
const rawKey = generateRoomKey();
const token = generateWriteToken();
const wsUrl = `ws://127.0.0.1:${relay.port}/r/${roomId}`;
const fullLink = formatRelayLink(`ws://127.0.0.1:${relay.port}`, roomId, rawKey, token);
const viewLink = formatRelayLink(`ws://127.0.0.1:${relay.port}`, roomId, rawKey);

const host = new CollabHost(new CollabSocket({ wsUrl, role: "host", key: await importRoomKey(rawKey) }), {
  header: { sessionId: "s1", title: "Pair on the guard", model: "claude-opus-4-8", hostName: "alice", startedAt: 1000 },
  writeToken: token,
  allowGuestWrite: true,
});
host.start();
ok("host 'alice' started a share");

// Two guests: bob (edit) + carol (view). Each records the user turns it sees mirrored.
const bobSeen: { text: string; from: string }[] = [];
const carolSeen: { text: string; from: string }[] = [];
const gFull = parseShareLink(fullLink);
const bob = new CollabGuest(new CollabSocket({ wsUrl, role: "guest", key: await importRoomKey(gFull.key) }), { name: "bob", writeToken: gFull.writeToken }, { onUserTurn: (text, from) => bobSeen.push({ text, from }) });
const gView = parseShareLink(viewLink);
const carol = new CollabGuest(new CollabSocket({ wsUrl, role: "guest", key: await importRoomKey(gView.key) }), { name: "carol" }, { onUserTurn: (text, from) => carolSeen.push({ text, from }) });
bob.start(); carol.start();
await waitFor(() => bob.view().phase === "live" && carol.view().phase === "live", "both guests to go live");
ok("two guests live: bob (edit) + carol (view)");

// [1] the HOST types a turn -> both guests see it live, attributed to the host.
host.pushUserTurn("let's tighten the token check");
await waitFor(() => bobSeen.length === 1 && carolSeen.length === 1, "both guests to receive the host's turn");
if (bobSeen[0]!.from !== "alice" || carolSeen[0]!.from !== "alice") fail("the host's turn should be attributed to 'alice'");
ok(`host's turn mirrored to BOTH guests, attributed to alice: "${bobSeen[0]!.text}"`);

// [2] a GUEST-driven turn (attributed to bob, as the app threads it) -> both guests see it, incl. view-only carol.
host.pushUserTurn("also add a regression test", "bob");
await waitFor(() => bobSeen.length === 2 && carolSeen.length === 2, "both guests to receive bob's turn");
if (carolSeen[1]!.from !== "bob" || carolSeen[1]!.text !== "also add a regression test") fail("carol should see bob's turn attributed to bob");
ok("guest-attributed turn mirrored to BOTH guests (view-only carol sees who typed it)");

// [3] a guest that joins AFTER the turns still sees them in the welcome replay.
const daveTranscript: { role: string; text: string }[] = [];
const dave = new CollabGuest(new CollabSocket({ wsUrl, role: "guest", key: await importRoomKey(gView.key) }), { name: "dave" }, { onWelcome: (w) => daveTranscript.push(...w.transcript) });
dave.start();
await waitFor(() => daveTranscript.length > 0, "dave to receive the welcome replay");
if (!daveTranscript.some((t) => t.role === "user" && t.text === "let's tighten the token check")) fail("a late joiner should see prior user turns in the replay");
ok("a late joiner (dave) sees the prior user turns in the welcome replay");

host.stop("host ended the session");
relay.stop();
console.log("\nP-COLLAB.15 demo complete - every user turn (host's + each guest's) is mirrored LIVE to all participants, attributed by author, and replayed to late joiners.");
process.exit(0);
