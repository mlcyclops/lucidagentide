// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_premote16.ts - P-REMOTE.16 (ADR-0431): the phone comes back and gets exactly what it missed.
//
// Drives the REAL modules the phone PWA wires (CollabSocket + CollabGuest + pwa_view + pwa_history) against a
// REAL gated relay and a REAL CollabHost, end to end:
//   - the host journals rich turns (thinking + tool calls WITH code + the settled answer) with a monotonic seq;
//   - a joining phone renders the replay at fleet-lane detail (chip + diff drilldown rows);
//   - a phone that reconnects after a screen lock sends `hello.since` from its on-device history and receives
//     ONLY the turns after it (plus the in-flight one) - no duplicates, no blank screen, no gap;
//   - a planned socket rotation (the pre-Cloud-Run-cap reconnect) is invisible: the guest stays live, the
//     items do not change, and the relay answers the keepalive with a pong (consumed, never surfaced);
//   - hostile host-echoed code is escaped in the drilldown too.
// Only Firebase + the DOM are absent (live-QA); everything the phone actually computes runs here.

import { startRelayServer } from "../../desktop/collab/relay_server.ts";
import { CollabSocket } from "../../desktop/collab/relay_client.ts";
import { CollabHost } from "../../desktop/collab/host.ts";
import { CollabGuest } from "../../desktop/collab/guest.ts";
import { generateRoomKey, importRoomKey } from "../../desktop/collab/crypto.ts";
import { generateRoomId } from "../../desktop/collab/link.ts";
import { foldEvent, mergeWelcome, renderTranscript, type ViewItem } from "../../desktop/collab/pwa_view.ts";
import { parseHistory, serializeHistory } from "../../desktop/collab/pwa_history.ts";
import type { AuthVerdict } from "../../desktop/collab/relay_auth.ts";
import type { WelcomeFrame } from "../../desktop/collab/frames.ts";
import type { RelayControlMessage } from "@oh-my-pi/pi-wire";

let step = 0;
const pass = (m: string): void => { console.log(`  [${++step}] PASS ${m}`); };
const fail = (m: string): never => { console.error(`  FAIL ${m}`); process.exit(1); };
const sleep = (ms: number): Promise<void> => { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, ms); return promise; };
const until = async (cond: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 800; i++) { if (cond()) return; await sleep(5); }
  throw new Error(`timed out: ${label}`);
};
const countKind = (items: ViewItem[], kind: ViewItem["kind"]) => items.filter((i) => i.kind === kind).length;

console.log("== P-REMOTE.16: reconnect replay by turn seq + rich tool detail + invisible rotation (real relay) ==");

const verify = async (t: string): Promise<AuthVerdict> =>
  t.startsWith("tok-") ? { ok: true, uid: t, email: `${t}@gmail.com`, premium: true, admin: false } : { ok: false, code: 4401, reason: "bad" };
const relay = startRelayServer({ port: 0, auth: { verify } });
const roomId = generateRoomId();
const wsUrl = `ws://127.0.0.1:${relay.port}/r/${roomId}`;
const key = await importRoomKey(generateRoomKey());

const hostSock = new CollabSocket({ wsUrl, role: "host", key, authToken: () => "tok-host" });
const host = new CollabHost(hostSock, {
  header: { sessionId: "s1", title: "Harden the relay", model: "claude-opus-4-8", hostName: "nick@desktop", startedAt: 1000 },
  posture: () => ({ cui: false, lockdown: false }), // a non-CUI session: the phone MAY keep history on-device
});
host.start();

// A full turn BEFORE any phone joins: user (seq 1) + assistant (seq 2) with thinking, an edit WITH code, and a
// hostile tool detail that must come out escaped.
host.pushUserTurn("clean up the tokenizer");
host.pushEvent({ type: "thinking", text: "the lexer is the hot path" });
host.pushEvent({ type: "tool", id: "c1", name: "edit", detail: "src/lexer.ts", code: { path: "src/lexer.ts", oldText: "let a = 1;\nlet b = 2;\n", newText: "let a = 1;\nconst b = 2;\n<script>alert(1)</script>\n" } });
host.pushEvent({ type: "tool-meta", id: "c1", name: "edit", ok: true, elapsedMs: 1234 });
host.pushEvent({ type: "token", text: "I'll hoist " });
host.pushEvent({ type: "token", text: "the switch." });
host.pushEvent({ type: "done", text: "I'll hoist the switch." });

// ── phone A: a fresh join ───────────────────────────────────────────────────
type Phone = { items: ViewItem[]; welcomes: WelcomeFrame[]; controls: RelayControlMessage[]; guest: CollabGuest; sock: CollabSocket };
const makePhone = (name: string, seed?: { items: ViewItem[]; since: number }): Phone => {
  const p: Partial<Phone> = { items: seed?.items.slice() ?? [], welcomes: [], controls: [] };
  const sock = new CollabSocket({ wsUrl, role: "guest", key, authToken: () => `tok-${name}` });
  sock.onControl = (m) => p.controls!.push(m);
  const guest = new CollabGuest(sock, { name, writeToken: null }, {
    onWelcome: (w) => { p.welcomes!.push(w); p.items = mergeWelcome(p.items!, w); },
    onEvent: (e, seq) => { p.items = foldEvent(p.items!, e, seq); },
    onUserTurn: (text, from, seq) => { p.items = [...p.items!, { kind: "user", text, from, ...(seq !== undefined ? { seq } : {}) }]; },
  });
  if (seed) guest.seedSince(seed.since);
  p.guest = guest; p.sock = sock;
  guest.start();
  return p as Phone;
};

const A = makePhone("phoneA");
await until(() => A.guest.view().phase === "live", "phone A live");
await until(() => A.welcomes.length === 1, "phone A welcome");
{
  const w = A.welcomes[0]!;
  if (w.since !== undefined) fail("a fresh join must not echo since");
  if (w.transcript.length !== 2) fail(`fresh welcome should carry 2 turns, got ${w.transcript.length}`);
  const [u, a] = w.transcript;
  if (u!.seq !== 1 || u!.role !== "user") fail("user turn seq/role wrong");
  if (a!.seq !== 2 || a!.thinking !== "the lexer is the hot path") fail("assistant turn missing thinking/seq");
  const t = a!.tools?.[0];
  if (!t || t.name !== "edit" || t.ok !== true || t.elapsedMs !== 1234 || t.add !== 2 || t.del !== 1 || !t.code?.newText) fail(`tool record lacks fleet-lane detail: ${JSON.stringify(t)}`);
  pass("fresh join: welcome carries rich turns with seq (thinking + edit with code + ok/elapsed + diffstat)");
}
{
  const html = renderTranscript(A.items);
  if (!html.includes("tool-drill")) fail("no drilldown rendered for a tool with code");
  if (!html.includes('class="dr dr-add"') || !html.includes('class="dr dr-del"')) fail("diff rows not classified");
  if (html.includes("<script>alert(1)</script>")) fail("hostile code rendered as live markup");
  if (!html.includes("&lt;script&gt;alert(1)&lt;/script&gt;")) fail("hostile code not escaped in drilldown");
  if (!html.includes("I&#39;ll hoist the switch.")) fail("answer not rendered");
  if (!html.includes("the lexer is the hot path")) fail("thinking not rendered");
  if (A.guest.since() !== 2) fail(`phone A cursor should be 2, got ${A.guest.since()}`);
  pass("phone renders the replay at fleet-lane detail: chip + diff drilldown rows, hostile code escaped");
}

// On-device history: what the PWA would write to localStorage at this point (non-CUI posture -> allowed).
const stored = serializeHistory(roomId, A.items, A.guest.since(), A.guest.posture());
if (!stored) fail("history should be storable for a non-CUI session");
const restored = parseHistory(stored, roomId);
if (!restored || restored.since !== 2 || restored.items.length !== A.items.length) fail("history round trip lost items");
if (parseHistory(stored, generateRoomId()) !== null) fail("history for another room must be rejected");
if (serializeHistory(roomId, A.items, 2, { cui: true, lockdown: true }) !== null) fail("CUI session must never store history");
pass("on-device history: settled items + cursor round-trip; another room is rejected; CUI stores nothing");

// ── the phone's screen locks; meanwhile the session moves on ───────────────
A.guest.leave("screen locked");
await until(() => host.participantCount === 0, "host saw phone A leave");
host.pushUserTurn("now the parser"); // seq 3
host.pushEvent({ type: "tool", id: "c2", name: "read", detail: "src/parser.ts", input: '{"path":"src/parser.ts"}' }); // live seq 4 starts
host.pushEvent({ type: "token", text: "Reading the parser" });

// ── phone B: the SAME phone unlocking - restores history, says hello with since=2 ──
const B = makePhone("phoneA", restored!);
await until(() => B.welcomes.length === 1, "phone B welcome");
{
  const w = B.welcomes[0]!;
  if (w.since !== 2) fail(`welcome should echo since=2, got ${w.since}`);
  if (w.complete === false) fail("no gap expected");
  if (w.transcript.length !== 2) fail(`expected only the 2 turns after seq 2, got ${w.transcript.length}`);
  if (w.transcript[0]!.seq !== 3 || w.transcript[0]!.text !== "now the parser") fail("missed user turn not replayed");
  const live = w.transcript[1]!;
  if (live.seq !== 4 || live.live !== true || live.text !== "Reading the parser" || live.tools?.[0]?.name !== "read" || live.tools?.[0]?.input !== '{"path":"src/parser.ts"}') fail(`in-flight turn not replayed as live: ${JSON.stringify(live)}`);
  pass("unlock: hello.since=2 -> welcome replays ONLY seq 3 + the in-flight seq 4 (with its tool input), complete");
}
{
  if (countKind(B.items, "user") !== 2) fail(`expected 2 user items (no duplicates), got ${countKind(B.items, "user")}`);
  const answers = B.items.filter((i) => i.kind === "answer");
  const liveAnswer = answers[1];
  if (answers.length !== 2 || liveAnswer?.kind !== "answer" || !liveAnswer.streaming) fail("history + live answer not merged");
  // the turn finishes on the host -> the live bubble on the restored phone settles in place
  host.pushEvent({ type: "token", text: " now." });
  host.pushEvent({ type: "done", text: "Reading the parser now." });
  await until(() => B.items.some((i) => i.kind === "answer" && !i.streaming && i.text === "Reading the parser now."), "live turn settled on phone B");
  if (countKind(B.items, "answer") !== 2) fail("done appended a second bubble instead of settling the live one");
  if (B.guest.since() !== 4) fail(`cursor should advance to 4, got ${B.guest.since()}`);
  const html = renderTranscript(B.items);
  if (!html.includes("clean up the tokenizer") || !html.includes("now the parser") || !html.includes("Reading the parser now.")) fail("merged transcript incomplete");
  pass("restored history + replay + live stream fold into ONE list: no duplicate turns, live bubble settles in place");
}

// ── a planned rotation (the pre-60-min reconnect) is invisible to the user ──
{
  const before = JSON.stringify(B.items);
  const peersBefore = relay.peerCount();
  B.sock.resume(60_000); // >= 30 s away -> make-before-break rotation
  await until(() => B.welcomes.length === 2, "re-hello after rotation");
  if (B.guest.view().phase !== "live") fail(`guest should stay live across rotation, got ${B.guest.view().phase}`);
  if (B.welcomes[1]!.since !== 4 || B.welcomes[1]!.transcript.length !== 0) fail("rotation welcome should replay nothing new");
  if (JSON.stringify(B.items) !== before) fail("rotation changed the rendered items");
  await until(() => relay.peerCount() === peersBefore, "old socket reaped");
  if (B.controls.some((c) => (c.t as string) === "pong")) fail("pong leaked to onControl"); // the union has no pong on purpose: it is consumed by the socket
  pass("planned rotation: new socket, re-hello with since=4, zero replay, items untouched, guest stays live");
}
{
  // The relay answers the keepalive: a short-absence resume PROBES (ping) and keeps the socket when answered.
  const peers = relay.peerCount();
  B.sock.resume(1_000);
  await sleep(300);
  if (relay.peerCount() !== peers) fail("a short absence with a healthy socket must not reconnect");
  if (B.guest.view().phase !== "live") fail("probe disturbed the session");
  pass("short absence: ping probe answered by the relay's pong -> no reconnect");
}

host.stop("host ended the session");
await until(() => B.guest.view().phase === "ended", "phone sees end");
B.sock.close(); // the guest's socket would otherwise keep retrying against a stopped relay
relay.stop();
console.log("\nP-REMOTE.16 demo: all checks passed - the phone resumes with exactly what it missed, at fleet-lane detail.");
