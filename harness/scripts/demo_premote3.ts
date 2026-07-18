// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_premote3.ts — P-REMOTE.3 (ADR-0226/0227): the phone guest PWA data path, offline.
//
// The PWA is a GUEST built from the SAME desktop/collab modules. This drives that EXACT path end to end over
// a REAL gated relay: a real CollabHost broadcasts a live turn, and a "phone" (a real CollabSocket with a
// Firebase-style token + a real CollabGuest + the pure pwa_view reducer/renderer) authenticates, goes live,
// and faithfully renders the host's thinking + tool chips + streamed answer — with hostile content ESCAPED.
// Only Firebase + the DOM are absent (live-QA); everything the phone actually computes runs here.

import { startRelayServer } from "../../desktop/collab/relay_server.ts";
import { CollabSocket } from "../../desktop/collab/relay_client.ts";
import { CollabHost } from "../../desktop/collab/host.ts";
import { CollabGuest } from "../../desktop/collab/guest.ts";
import { generateRoomKey, importRoomKey } from "../../desktop/collab/crypto.ts";
import { generateRoomId } from "../../desktop/collab/link.ts";
import { foldEvent, renderTranscript, renderHeader, statusLabel, type ViewItem } from "../../desktop/collab/pwa_view.ts";
import type { AuthVerdict } from "../../desktop/collab/relay_auth.ts";
import type { ChatEvent } from "../../desktop/renderer/chat_events.ts";

let step = 0;
const pass = (m: string): void => { console.log(`  [${++step}] PASS ${m}`); };
const fail = (m: string): never => { console.error(`  FAIL ${m}`); process.exit(1); };
const until = async (cond: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 800; i++) { if (cond()) return; const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, 5); await promise; }
  throw new Error(`timed out: ${label}`);
};

console.log("== P-REMOTE.3: the phone guest PWA data path (real gated relay + host + guest + pwa_view) ==");

// A gated relay (Google sign-in required) — the phone presents a Firebase-style token as its first frame.
const verify = async (t: string): Promise<AuthVerdict> =>
  t.startsWith("tok-") ? { ok: true, uid: t, email: `${t}@gmail.com`, premium: true, admin: false } : { ok: false, code: 4401, reason: "bad" };
const relay = startRelayServer({ port: 0, auth: { verify } });
const wsUrl = `ws://127.0.0.1:${relay.port}/r/${generateRoomId()}`;
const key = await importRoomKey(generateRoomKey());

// the desktop HOST (also authenticates to the gated relay)
const hostSock = new CollabSocket({ wsUrl, role: "host", key, authToken: () => "tok-host" });
const host = new CollabHost(hostSock, { header: { sessionId: "s1", title: "Refactor the parser", model: "claude-opus-4-8", hostName: "nick@desktop", startedAt: 1000 } });
host.start();
host.pushUserTurn("clean up the tokenizer");

// the PHONE: the exact modules the PWA wires (CollabSocket authToken + CollabGuest + pwa_view)
let items: ViewItem[] = [];
const guestSock = new CollabSocket({ wsUrl, role: "guest", key, authToken: () => "tok-phone" });
const guest = new CollabGuest(guestSock, { name: "nick@phone", writeToken: null }, {
  onEvent: (e: ChatEvent) => { items = foldEvent(items, e); },
});
guest.start();

// [1] the phone authenticates to the gated relay, goes live, and renders the host header
await until(() => guest.view().phase === "live", "phone live");
const hdr = renderHeader(guest.view().header);
if (!hdr.includes("Refactor the parser") || !hdr.includes("nick@desktop")) fail("header did not render");
if (statusLabel(guest.view()).tone !== "live") fail("status not live");
pass("phone signs in to the GATED relay, goes live, renders the session header (view-only)");

// [2] a live turn (thinking + tool + streamed answer) folds + renders the way the phone shows it
host.pushEvent({ type: "thinking", text: "the lexer is the hot path" });
host.pushEvent({ type: "tool", name: "read", detail: "src/lexer.ts" });
host.pushEvent({ type: "token", text: "I'll hoist " });
host.pushEvent({ type: "token", text: "the switch." });
host.pushEvent({ type: "done", text: "I'll hoist the switch." });
await until(() => items.some((i) => i.kind === "answer" && !i.streaming), "answer finalized");
const html = renderTranscript(guest.view().transcript, items);
if (!html.includes("clean up the tokenizer")) fail("prior user turn missing");
if (!html.includes("Thinking") || !html.includes("the lexer is the hot path")) fail("thinking not rendered");
if (!html.includes("read") || !html.includes("src/lexer.ts")) fail("tool chip not rendered");
if (!html.includes("I&#39;ll hoist the switch.")) fail("reconciled answer not rendered");
pass("live turn renders on the phone: thinking block + tool chip + reconciled streamed answer");

// [3] hostile host-echoed content is ESCAPED (never live markup on the phone)
host.pushEvent({ type: "token", text: `<img src=x onerror=alert(1)>` });
host.pushEvent({ type: "done", text: `<img src=x onerror=alert(1)>` });
await until(() => renderTranscript(guest.view().transcript, items).includes("&lt;img"), "hostile answer escaped");
const h2 = renderTranscript(guest.view().transcript, items);
if (h2.includes("<img src=x")) fail("hostile content rendered as live markup");
pass("hostile host-echoed content is escaped to text (no live markup on the phone)");

// [4] the host stops → the phone reflects the ended session
host.stop("host ended the session");
await until(() => guest.view().phase === "ended", "phone sees end");
if (statusLabel(guest.view()).tone !== "ended") fail("status not ended");
pass("host stop -> phone shows the session ended");

relay.stop();
console.log(`\nP-REMOTE.3 demo: all ${step} checks passed — the phone renders a live gated session end to end.`);
process.exit(0);
