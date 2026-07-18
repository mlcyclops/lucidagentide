// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_premote9.ts
//
// P-REMOTE.9 (ADR-0230): the phone transcript's per-edit +/- diffstat and the end-of-run engineering report,
// proven end-to-end over a REAL relay. The host broadcasts a `tool` ChatEvent carrying the edit's authored
// code; it travels E2E-sealed to the guest, which folds it into a tool item with a +/- diffstat sized by the
// SAME convention as the desktop chips - then on `done` builds a per-turn report (files + line counts + tool
// counts + model + context) the phone renders as cards + copyable Markdown. Also shows the guest's OWN sent
// message being echoed locally (the host never broadcasts user turns live).
//
// Run with: bun run harness/scripts/demo_premote9.ts

import { startRelayServer } from "../../desktop/collab/relay_server.ts";
import { CollabSocket } from "../../desktop/collab/relay_client.ts";
import { CollabHost } from "../../desktop/collab/host.ts";
import { CollabGuest } from "../../desktop/collab/guest.ts";
import { generateRoomKey, generateWriteToken, importRoomKey } from "../../desktop/collab/crypto.ts";
import { generateRoomId, formatRelayLink, parseShareLink } from "../../desktop/collab/link.ts";
import { foldEvent, buildTurnReport, reportMarkdown, renderItem, type ViewItem } from "../../desktop/collab/pwa_view.ts";
import type { ChatEvent } from "../../desktop/renderer/chat_events.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }
async function waitFor(cond: () => boolean, label: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) { if (cond()) return; await Bun.sleep(5); }
  fail(`timed out waiting for ${label}`);
}

console.log("P-REMOTE.9 demo - phone diffstats + end-of-run report over a real relay\n");

const relay = startRelayServer({ port: 0, hostname: "127.0.0.1" });
const roomId = generateRoomId();
const rawKey = generateRoomKey();
const token = generateWriteToken();
const wsUrl = `ws://127.0.0.1:${relay.port}/r/${roomId}`;
const fullLink = formatRelayLink(`ws://127.0.0.1:${relay.port}`, roomId, rawKey, token);

const host = new CollabHost(new CollabSocket({ wsUrl, role: "host", key: await importRoomKey(rawKey) }), {
  header: { sessionId: "s1", title: "Tighten the auth guard", model: "claude-opus-4-8", hostName: "alice", startedAt: 1000 },
  writeToken: token,
  allowGuestWrite: true,
});
host.start();

// The guest folds the host's ChatEvents exactly like the PWA does.
let items: ViewItem[] = [];
const gFull = parseShareLink(fullLink);
const guest = new CollabGuest(new CollabSocket({ wsUrl, role: "guest", key: await importRoomKey(gFull.key) }), { name: "phone", writeToken: gFull.writeToken }, {
  onEvent: (e) => { items = foldEvent(items, e); },
});
guest.start();
await waitFor(() => guest.view().phase === "live", "the guest to go live");
ok("edit guest live over a real relay");

// The guest echoes its OWN sent message locally (the host doesn't broadcast user turns live).
items = [...items, { kind: "user", text: "tighten the token check + add a test" }];
const userHtml = renderItem(items[items.length - 1]!);
if (!userHtml.includes("msg user") || !userHtml.includes("tighten the token check")) fail("the guest's own message should render");
ok("guest's OWN sent message is echoed in the transcript");

// The host runs the turn and broadcasts tool events carrying the edit CODE + a write.
const edit: ChatEvent = { type: "tool", name: "edit", detail: "src/auth.ts", code: { path: "src/auth.ts", oldText: "a\nb\nc\nd", newText: "a\nB\nc\nd\ne" } };
const write: ChatEvent = { type: "tool", name: "write", detail: "src/auth.test.ts", code: { path: "src/auth.test.ts", content: "t1\nt2\nt3\n" } };
host.pushEvent(edit);
host.pushEvent(write);
await waitFor(() => items.filter((i) => i.kind === "tool").length === 2, "the guest to receive both tool events");

const editItem = items.find((i) => i.kind === "tool" && i.path === "src/auth.ts") as Extract<ViewItem, { kind: "tool" }> | undefined;
if (!editItem || editItem.add !== 2 || editItem.del !== 1) fail(`edit diffstat wrong: ${JSON.stringify(editItem)}`); // B (+1) + e (+1) / b (-1)
ok(`edit diffstat computed from E2E-delivered code: src/auth.ts +${editItem.add} -${editItem.del}`);

// End of run: the host settles the turn.
host.pushEvent({ type: "usage", used: 42_000, size: 100_000, cost: 0.12 } as ChatEvent);
host.pushEvent({ type: "done", text: "Tightened the guard and added a test." } as ChatEvent);
await waitFor(() => items.some((i) => i.kind === "answer"), "the guest to settle the turn");

const report = buildTurnReport(items, guest.view());
if (report.files.length !== 2) fail(`report should list 2 files, got ${report.files.length}`);
if (report.totalAdd !== 5 || report.totalDel !== 1) fail(`report totals wrong: +${report.totalAdd}/-${report.totalDel}`); // 2+3 add, 1 del
if (report.model !== "claude-opus-4-8") fail("report should carry the model");
if (report.contextPct !== 42) fail(`report should carry context fill, got ${report.contextPct}`);
ok(`end-of-run report: 2 files (+${report.totalAdd}/-${report.totalDel}), model ${report.model}, context ${report.contextPct}%`);

const md = reportMarkdown(report);
if (!md.includes("# LUCID run report") || !md.includes("`src/auth.ts` +2") || !md.includes("**Context fill:** 42%")) fail("report Markdown is missing expected content");
ok("report exports as copyable Markdown (files + diffstats + tools + model + context)");

host.stop("host ended the session");
relay.stop();
console.log("\nP-REMOTE.9 demo complete - the guest sees its own messages, per-edit +/- diffstats (code delivered E2E), and an end-of-run engineering report (cards + copyable Markdown).");
process.exit(0);
