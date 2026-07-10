// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pcollab12.ts
//
// P-COLLAB.12 (ADR-0198): guest-WRITE, proven end-to-end over a REAL relay. A guest with EDIT access (a full
// link + a valid write token) drives the host: its prompt reaches the host's `onGuestPrompt` - which in the
// real app runs it in the host's omp session, where the fail-closed scan gate + exec/egress approvals still
// apply to every tool call (the guest bypasses nothing). A VIEW-only guest cannot: its client refuses to send,
// and a raw prompt frame is refused host-side with an `error`.
//
// Run with: bun run harness/scripts/demo_pcollab12.ts

import { startRelayServer } from "../../desktop/collab/relay_server.ts";
import { CollabSocket } from "../../desktop/collab/relay_client.ts";
import { CollabHost } from "../../desktop/collab/host.ts";
import { CollabGuest } from "../../desktop/collab/guest.ts";
import { generateRoomKey, generateWriteToken, importRoomKey } from "../../desktop/collab/crypto.ts";
import { generateRoomId, formatRelayLink, parseShareLink } from "../../desktop/collab/link.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }
async function waitFor(cond: () => boolean, label: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 5)); }
  fail(`timed out waiting for ${label}`);
}

console.log("P-COLLAB.12 demo - guest-WRITE over a real relay (host keeps the gate)\n");

const relay = startRelayServer({ port: 0, hostname: "127.0.0.1" });
const roomId = generateRoomId();
const rawKey = generateRoomKey();
const token = generateWriteToken();
const wsUrl = `ws://127.0.0.1:${relay.port}/r/${roomId}`;
const fullLink = formatRelayLink(`ws://127.0.0.1:${relay.port}`, roomId, rawKey, token); // EDIT invite
const viewLink = formatRelayLink(`ws://127.0.0.1:${relay.port}`, roomId, rawKey);          // VIEW invite

// the host GRANTS edit (allowGuestWrite + the write token) and records guest prompts/aborts
const guestPrompts: { text: string; from: string }[] = [];
const guestAborts: string[] = [];
const host = new CollabHost(new CollabSocket({ wsUrl, role: "host", key: await importRoomKey(rawKey) }), {
  header: { sessionId: "s1", title: "Pair on the auth guard", model: "claude-opus-4-8", hostName: "alice", startedAt: 1000 },
  writeToken: token,
  allowGuestWrite: true, // the host shared an EDIT link
  onGuestPrompt: (text, g) => guestPrompts.push({ text, from: g.name }),
  onGuestAbort: (g) => guestAborts.push(g.name),
});
host.start();
ok("host started a share with EDIT allowed (a full-link guest may drive it)");

// [1] an EDIT guest (full link) drives the host
const gFull = parseShareLink(fullLink);
const editor = new CollabGuest(new CollabSocket({ wsUrl, role: "guest", key: await importRoomKey(gFull.key) }), { name: "bob", writeToken: gFull.writeToken });
editor.start();
await waitFor(() => editor.view().phase === "live", "the edit guest to go live");
if (editor.readOnly) fail("a full-link guest should have EDIT access");
if (!editor.sendPrompt("tighten the token check and add a test")) fail("edit guest sendPrompt should send");
editor.abort();
await waitFor(() => guestPrompts.length === 1 && guestAborts.length === 1, "the host to receive the guest prompt + abort");
if (guestPrompts[0]!.text !== "tighten the token check and add a test" || guestPrompts[0]!.from !== "bob") fail(`wrong prompt: ${JSON.stringify(guestPrompts[0])}`);
ok(`EDIT guest drove the host: onGuestPrompt("${guestPrompts[0]!.text}") + onGuestAbort fired (the host runs it through its OWN scan gate + approvals)`);

// [2] a VIEW-only guest cannot write
const gView = parseShareLink(viewLink);
const errors: string[] = [];
const watcher = new CollabGuest(new CollabSocket({ wsUrl, role: "guest", key: await importRoomKey(gView.key) }), { name: "mallory" }, { onError: (m) => errors.push(m) });
watcher.start();
await waitFor(() => watcher.view().phase === "live", "the view guest to go live");
if (!watcher.readOnly) fail("a view-link guest must be read-only");
if (watcher.sendPrompt("rm -rf /")) fail("view guest sendPrompt must be refused client-side");
void errors; // (the watcher's own error sink is unused - the raw-frame refusal below checks the host directly)
ok("VIEW-only guest: sendPrompt is refused client-side (readOnly) - it never hits the wire");

// even a HAND-CRAFTED raw prompt frame (bypassing the client guard) is refused host-side (fail-closed)
const rawErrors: string[] = [];
const evil = new CollabSocket({ wsUrl, role: "guest", key: await importRoomKey(gView.key) });
evil.onFrame = (f) => { if (f.t === "error") rawErrors.push(f.message); };
evil.onOpen = () => { evil.send({ t: "hello", protocol: 1, name: "mallory2" }, 0); setTimeout(() => evil.send({ t: "prompt", text: "rm -rf /" }, 0), 60); };
evil.connect();
await waitFor(() => rawErrors.length >= 1, "the host to refuse the raw prompt");
if (guestPrompts.length !== 1) fail("a view guest's raw prompt must NOT reach the host session");
if (!rawErrors.some((e) => e.includes("read-only"))) fail("the host should have refused the raw prompt with a read-only error");
ok("fail-closed: a hand-crafted raw prompt from a VIEW guest is refused host-side with an error; it never runs");

host.stop("host ended the session");
relay.stop();
console.log("\nP-COLLAB.12 demo complete - guest-write is token-gated + fail-closed; a guest prompt runs on the host through the SAME scan gate + approvals as a local prompt. The allow-edit toggle + guest prompt box + host auto-submit are the UI slice.");
process.exit(0);
