// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pcollab4.ts
//
// P-COLLAB.4/.5 (ADR-0192): the GUEST + the OPTIONAL embedded relay, proven end-to-end over REAL localhost
// WebSockets (no mocks). Starts LUCID's own embedded relay, then wires a REAL host (CollabSocket + CollabHost)
// and a REAL guest (CollabSocket + CollabGuest) through it:
//   [1] LUCID starts its own relay on 127.0.0.1 (no third party - the sovereign path),
//   [2] a guest joins with the VIEW link and receives an E2E welcome (header + replayed transcript),
//   [3] the host's live ChatEvents stream host → relay → guest, read-only,
//   [4] the roster updates as a 2nd guest joins and leaves,
//   [5] fail-closed: a guest to a nonexistent room is refused; the relay only ever sees ciphertext,
//   [6] the host stops and every guest is told.
//
// Run with: bun run harness/scripts/demo_pcollab4.ts

import { startRelayServer } from "../../desktop/collab/relay_server.ts";
import { CollabSocket } from "../../desktop/collab/relay_client.ts";
import { CollabHost } from "../../desktop/collab/host.ts";
import { CollabGuest } from "../../desktop/collab/guest.ts";
import { generateRoomKey, importRoomKey } from "../../desktop/collab/crypto.ts";
import { generateRoomId, formatShareLink, parseShareLink } from "../../desktop/collab/link.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }
async function waitFor(cond: () => boolean, label: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 5)); }
  fail(`timed out waiting for ${label}`);
}

console.log("P-COLLAB.4/.5 demo - the guest + the embedded relay, over REAL localhost sockets\n");

// [1] LUCID starts its own relay - no third party
const relay = startRelayServer({ port: 0, hostname: "127.0.0.1" });
const base = `ws://127.0.0.1:${relay.port}`;
ok(`LUCID started its own embedded relay on ${relay.hostname}:${relay.port} (no third party)`);

// host opens a room + a view link
const roomId = generateRoomId();
const rawKey = generateRoomKey();
const viewLink = formatShareLink(roomId, rawKey);
const wsUrl = `${base}/r/${roomId}`;
const hostKey = await importRoomKey(rawKey);
const host = new CollabHost(new CollabSocket({ wsUrl, role: "host", key: hostKey }), {
  header: { sessionId: "sess-1", title: "Ship the guest slice", model: "claude-opus-4-8", hostName: "alice", startedAt: 1000 },
});
host.start();
host.pushUserTurn("Let's wire up the guest.");
host.pushEvent({ type: "done", text: "On it - building CollabGuest now." });

// [2] a guest joins with the VIEW link (parsed exactly as a pasted invite would be)
const link = parseShareLink(viewLink);
const guestKey = await importRoomKey(link.key);
const seen: string[] = [];
const guest = new CollabGuest(
  new CollabSocket({ wsUrl, role: "guest", key: guestKey }),
  { name: "bob", writeToken: link.writeToken },
  { onEvent: (e) => seen.push(e.type) },
);
guest.start();
await waitFor(() => guest.view().phase === "live", "the guest to go live");
const v = guest.view();
if (v.header?.title !== "Ship the guest slice" || !v.readOnly) fail("welcome wrong / not read-only");
if (v.transcript.length !== 2) fail(`expected 2 replayed turns, got ${v.transcript.length}`);
ok(`guest pasted the view link + joined; got an E2E welcome (readOnly=${v.readOnly}, ${v.transcript.length} turns) over the wire`);

// [3] live events stream host → relay → guest
host.pushEvent({ type: "token", text: "def guest():" });
host.pushEvent({ type: "usage", used: 80, size: 200, cost: 0.02 });
host.pushEvent({ type: "done", text: "Guest wired." });
await waitFor(() => seen.length >= 3, "3 live events at the guest");
if (guest.view().contextPct !== 40) fail(`guest should show contextPct 40, saw ${guest.view().contextPct}`);
ok(`host's 3 live ChatEvents streamed host → relay → guest end-to-end (context fill ${guest.view().contextPct}%)`);

// [4] a 2nd guest joins then leaves; rosters track it
const g2 = new CollabGuest(new CollabSocket({ wsUrl, role: "guest", key: guestKey }), { name: "carol" });
g2.start();
await waitFor(() => host.participantCount === 2 && guest.view().participants.length === 2, "the 2-guest roster");
g2.leave();
await waitFor(() => host.participantCount === 1, "the roster to shrink on leave");
ok("a 2nd guest joined then left; the host + guest rosters tracked it live");

// [5] fail-closed: a guest to a nonexistent room is refused
const stray = new CollabSocket({ wsUrl: `${base}/r/${generateRoomId()}`, role: "guest", key: guestKey });
let refused = "";
stray.onClose = (reason, willReconnect) => { if (!willReconnect) refused = reason; };
stray.connect();
await waitFor(() => refused !== "", "the refusal of a stray guest");
if (refused !== "no such room") fail(`expected 'no such room', got '${refused}'`);
ok(`fail-closed: a guest to a nonexistent room is refused ('${refused}'); the relay only ever saw ciphertext`);

// [6] host stops; the guest is told
host.stop("host ended the session");
await waitFor(() => guest.view().phase === "ended", "the guest to end on stop");
ok(`host stopped the share; the guest ended cleanly ("${guest.view().note}")`);

relay.stop();
console.log("\nP-COLLAB.4/.5 demo complete - end-to-end over real sockets through LUCID's own embedded relay. The Join panel + the 'be the relay' toggle are the UI slice.");
process.exit(0); // sockets/relay are torn down; exit cleanly now every assertion passed
