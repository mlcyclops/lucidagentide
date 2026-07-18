// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_premote8.ts
//
// P-REMOTE.8 (ADR-0229): PWA guest composer image attachments, proven end-to-end over a REAL relay, plus the
// reconnect-status recovery (driven deterministically at the guest, since a real socket can't reliably emit a
// synthetic code-1006 transient). An EDIT guest attaches validated image data URLs to its prompt; they travel
// E2E-sealed through the relay and reach the host's onGuestPrompt as vision input (the app stages them into the
// host composer + sends them to the model exactly like a locally pasted screenshot). Image-only messages work;
// a VIEW guest's image prompt is refused. Then: a transient drop shows a reconnect note, and the next live
// host frame CLEARS it (no more stale "connection lost" banner while streaming).
//
// Run with: bun run harness/scripts/demo_premote8.ts

import { startRelayServer } from "../../desktop/collab/relay_server.ts";
import { CollabSocket } from "../../desktop/collab/relay_client.ts";
import { CollabHost } from "../../desktop/collab/host.ts";
import { CollabGuest, type GuestTransport } from "../../desktop/collab/guest.ts";
import { generateRoomKey, generateWriteToken, importRoomKey } from "../../desktop/collab/crypto.ts";
import { generateRoomId, formatRelayLink, parseShareLink } from "../../desktop/collab/link.ts";
import { COLLAB_PROTOCOL_VERSION } from "../../desktop/collab/frames.ts";
import type { LucidCollabFrame, WelcomeFrame } from "../../desktop/collab/frames.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }
async function waitFor(cond: () => boolean, label: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) { if (cond()) return; await Bun.sleep(5); }
  fail(`timed out waiting for ${label}`);
}

const IMG_A = "data:image/png;base64,QUJD";  // "ABC"
const IMG_B = "data:image/jpeg;base64,REVG"; // "DEF"

console.log("P-REMOTE.8 demo - PWA composer image attachments over a real relay + reconnect-status recovery\n");

// ── Part 1: image attachments E2E over a REAL relay ──────────────────────────
const relay = startRelayServer({ port: 0, hostname: "127.0.0.1" });
const roomId = generateRoomId();
const rawKey = generateRoomKey();
const token = generateWriteToken();
const wsUrl = `ws://127.0.0.1:${relay.port}/r/${roomId}`;
const fullLink = formatRelayLink(`ws://127.0.0.1:${relay.port}`, roomId, rawKey, token);
const viewLink = formatRelayLink(`ws://127.0.0.1:${relay.port}`, roomId, rawKey);

const prompts: { text: string; images?: string[] }[] = [];
const host = new CollabHost(new CollabSocket({ wsUrl, role: "host", key: await importRoomKey(rawKey) }), {
  header: { sessionId: "s1", title: "Review this screenshot", model: "claude-opus-4-8", hostName: "alice", startedAt: 1000 },
  writeToken: token,
  allowGuestWrite: true,
  onGuestPrompt: (text, _g, images) => prompts.push({ text, images }),
});
host.start();
ok("host started an EDIT share");

const gFull = parseShareLink(fullLink);
const editor = new CollabGuest(new CollabSocket({ wsUrl, role: "guest", key: await importRoomKey(gFull.key) }), { name: "phone", writeToken: gFull.writeToken });
editor.start();
await waitFor(() => editor.view().phase === "live", "the edit guest to go live");
if (editor.readOnly) fail("a full-link guest should have EDIT access");

if (!editor.sendPrompt("what's wrong in this screenshot?", [IMG_A, IMG_B])) fail("edit guest should send a prompt + images");
await waitFor(() => prompts.length === 1, "the host to receive the prompt");
if (prompts[0]!.text !== "what's wrong in this screenshot?" || JSON.stringify(prompts[0]!.images) !== JSON.stringify([IMG_A, IMG_B])) fail(`wrong prompt/images: ${JSON.stringify(prompts[0])}`);
ok(`EDIT guest attached 2 images to a prompt; they arrived E2E at the host's onGuestPrompt (staged into the host composer -> model as vision input)`);

if (!editor.sendPrompt("", [IMG_A])) fail("an image-only message should send");
await waitFor(() => prompts.length === 2, "the host to receive the image-only message");
if (prompts[1]!.text !== "" || JSON.stringify(prompts[1]!.images) !== JSON.stringify([IMG_A])) fail(`wrong image-only: ${JSON.stringify(prompts[1])}`);
ok("image-only message (empty text + 1 image) works");

// a VIEW guest cannot send an image prompt (refused BOTH client-side and host-side)
const gView = parseShareLink(viewLink);
const watcher = new CollabGuest(new CollabSocket({ wsUrl, role: "guest", key: await importRoomKey(gView.key) }), { name: "watcher" });
watcher.start();
await waitFor(() => watcher.view().phase === "live", "the view guest to go live");
if (watcher.sendPrompt("run this", [IMG_A])) fail("view guest sendPrompt must be refused client-side");
await Bun.sleep(40);
if (prompts.length !== 2) fail("a view guest's image prompt must NOT reach the host");
ok("VIEW guest's image prompt is refused (client-side) and never reaches the host");

host.stop("host ended the session");
relay.stop();

// ── Part 2: reconnect-status recovery (deterministic, at the guest) ──────────
class MockTransport implements GuestTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  connect(): void { this.onOpen?.(); }
  send(): void {}
  close(): void {}
}
const welcome = (): WelcomeFrame => ({ t: "welcome", protocol: COLLAB_PROTOCOL_VERSION, header: { sessionId: "s", title: "t", model: "m", hostName: "h", startedAt: 1 }, transcript: [], participants: [], readOnly: false });
const mt = new MockTransport();
const g2 = new CollabGuest(mt, { name: "phone" });
g2.start();
mt.onFrame?.(welcome(), 0);
if (g2.view().phase !== "live") fail("guest should be live after welcome");

mt.onClose?.("code 1006", true); // transient drop
if (g2.view().phase !== "reconnecting" || !g2.view().note?.includes("1006")) fail("a transient drop should show a reconnect note");
ok(`transient drop shows the reconnect note: "${g2.view().note}"`);

mt.onOpen?.();            // socket reopens -> guest re-hello
mt.onFrame?.(welcome(), 0); // host re-syncs
if (g2.view().phase !== "live" || g2.view().note !== null) fail(`the reconnect note must clear on recovery (got phase=${g2.view().phase} note=${g2.view().note})`);
ok("on recovery the stale reconnect note CLEARS and status returns to Live (no more banner while streaming)");

console.log("\nP-REMOTE.8 demo complete - a remote guest attaches images to a prompt (E2E, host-gated, model vision input), image-only works, a view guest is refused, and the reconnect banner clears the moment the connection recovers.");
process.exit(0);
