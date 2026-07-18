// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pcollab14.ts
//
// P-COLLAB.14 (ADR-0228): edit-guest MODEL + already-used-FOLDER selection, proven end-to-end over a REAL
// relay. An EDIT guest (full link + write token) is OFFERED the host's model + folder allowlists and switches
// either; the pick reaches the host's onGuestSetModel / onGuestSetWorkspace (which in the app applies it
// through the host's OWN picker path). Fail-closed: a value/id NOT in the offered allowlist is refused
// host-side (never reaches the callback), and a VIEW-only guest is never offered the allowlists and cannot
// switch. A later host-side switch (setOptions) rebroadcasts fresh options to the edit guest.
//
// Run with: bun run harness/scripts/demo_pcollab14.ts

import { startRelayServer } from "../../desktop/collab/relay_server.ts";
import { CollabSocket } from "../../desktop/collab/relay_client.ts";
import { CollabHost } from "../../desktop/collab/host.ts";
import { CollabGuest } from "../../desktop/collab/guest.ts";
import { generateRoomKey, generateWriteToken, importRoomKey } from "../../desktop/collab/crypto.ts";
import { generateRoomId, formatRelayLink, parseShareLink } from "../../desktop/collab/link.ts";
import type { CollabOptions, LucidCollabFrame } from "../../desktop/collab/frames.ts";

function b64url(bytes: Uint8Array): string { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }
async function waitFor(cond: () => boolean, label: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) { if (cond()) return; await Bun.sleep(5); }
  fail(`timed out waiting for ${label}`);
}

console.log("P-COLLAB.14 demo - edit-guest model + already-used-folder selection over a real relay\n");

const OPTIONS: CollabOptions = {
  models: [{ value: "claude-haiku-4-5", name: "Haiku 4.5" }, { value: "claude-opus-4-8", name: "Opus 4.8" }],
  activeModel: "claude-haiku-4-5",
  workspaces: [{ id: "w-cur", name: "project-alpha", isGit: true }, { id: "w-old", name: "sandbox", isGit: false }],
  activeWorkspaceId: "w-cur",
};

const relay = startRelayServer({ port: 0, hostname: "127.0.0.1" });
const roomId = generateRoomId();
const rawKey = generateRoomKey();
const token = generateWriteToken();
const wsUrl = `ws://127.0.0.1:${relay.port}/r/${roomId}`;
const fullLink = formatRelayLink(`ws://127.0.0.1:${relay.port}`, roomId, rawKey, token); // EDIT invite
const viewLink = formatRelayLink(`ws://127.0.0.1:${relay.port}`, roomId, rawKey);          // VIEW invite

const setModels: string[] = [];
const setWorkspaces: string[] = [];
const host = new CollabHost(new CollabSocket({ wsUrl, role: "host", key: await importRoomKey(rawKey) }), {
  header: { sessionId: "s1", title: "Pair on the guard", model: "claude-haiku-4-5", hostName: "alice", startedAt: 1000 },
  writeToken: token,
  allowGuestWrite: true,
  options: OPTIONS,
  onGuestSetModel: (value) => setModels.push(value),
  onGuestSetWorkspace: (id) => setWorkspaces.push(id),
});
host.start();
ok("host started an EDIT share offering 2 models + 2 already-used folders");

// [1] an EDIT guest (full link) is OFFERED the allowlists on join
const gFull = parseShareLink(fullLink);
const editor = new CollabGuest(new CollabSocket({ wsUrl, role: "guest", key: await importRoomKey(gFull.key) }), { name: "bob", writeToken: gFull.writeToken });
editor.start();
await waitFor(() => editor.view().phase === "live", "the edit guest to go live");
if (editor.readOnly) fail("a full-link guest should have EDIT access");
await waitFor(() => editor.view().options !== null, "the host to offer the allowlists to the edit guest");
const offered = editor.view().options!;
if (offered.models.length !== 2 || offered.workspaces.length !== 2) fail(`wrong allowlists offered: ${JSON.stringify(offered)}`);
ok(`EDIT guest was offered the pickers: models=[${offered.models.map((m) => m.value).join(", ")}] folders=[${offered.workspaces.map((w) => w.name).join(", ")}]`);

// [2] the EDIT guest switches the model + folder; the pick reaches the host callbacks
if (!editor.setModel("claude-opus-4-8")) fail("edit guest setModel should send for an offered model");
if (!editor.setWorkspace("w-old")) fail("edit guest setWorkspace should send for an offered folder");
await waitFor(() => setModels.length === 1 && setWorkspaces.length === 1, "the host to receive the guest's picks");
if (setModels[0] !== "claude-opus-4-8" || setWorkspaces[0] !== "w-old") fail(`wrong picks: model=${setModels[0]} folder=${setWorkspaces[0]}`);
ok(`EDIT guest drove the switch: onGuestSetModel("${setModels[0]}") + onGuestSetWorkspace("${setWorkspaces[0]}") fired (the host applies it through its OWN picker path)`);

// [3] a value NOT in the allowlist is guarded client-side AND refused host-side (a hand-crafted raw frame)
if (editor.setModel("evil/model")) fail("edit guest setModel must refuse a value it wasn't offered (client guard)");
const rawErrors: string[] = [];
const raw = new CollabSocket({ wsUrl, role: "guest", key: await importRoomKey(gFull.key) });
raw.onFrame = (f: LucidCollabFrame) => { if (f.t === "error") rawErrors.push(f.message); };
raw.onOpen = () => { raw.send({ t: "hello", protocol: 1, name: "bob2", writeToken: b64url(token) }, 0); setTimeout(() => raw.send({ t: "set-model", value: "evil/model" }, 0), 60); };
raw.connect();
await waitFor(() => rawErrors.length >= 1, "the host to refuse a raw off-allowlist set-model");
if (setModels.length !== 1) fail("an off-allowlist model must NOT reach the host callback");
if (!rawErrors.some((e) => e.includes("isn't available"))) fail("the host should refuse an off-allowlist model with an error");
ok("fail-closed: an off-allowlist model is guarded client-side AND a hand-crafted raw frame is refused host-side (never applied)");

// [4] a host-side switch rebroadcasts fresh options to the edit guest
host.setOptions({ ...OPTIONS, activeModel: "claude-opus-4-8", activeWorkspaceId: "w-old" });
await waitFor(() => editor.view().options?.activeModel === "claude-opus-4-8", "the edit guest to receive the rebroadcast options");
if (editor.view().options?.activeWorkspaceId !== "w-old") fail("the rebroadcast options should carry the new active folder");
ok("host.setOptions rebroadcast the fresh selection to the edit guest (its pickers reflect the live model + folder)");

// [5] a VIEW-only guest is never offered the allowlists and cannot switch
const gView = parseShareLink(viewLink);
const watcher = new CollabGuest(new CollabSocket({ wsUrl, role: "guest", key: await importRoomKey(gView.key) }), { name: "mallory" });
watcher.start();
await waitFor(() => watcher.view().phase === "live", "the view guest to go live");
if (!watcher.readOnly) fail("a view-link guest must be read-only");
await Bun.sleep(40); // give any (wrongly) sent options time to arrive
if (watcher.view().options !== null) fail("a VIEW guest must NEVER be offered the model/folder allowlists");
if (watcher.setModel("claude-opus-4-8")) fail("view guest setModel must be refused client-side");
const viewRawErrors: string[] = [];
const evil = new CollabSocket({ wsUrl, role: "guest", key: await importRoomKey(gView.key) });
evil.onFrame = (f: LucidCollabFrame) => { if (f.t === "error") viewRawErrors.push(f.message); };
evil.onOpen = () => { evil.send({ t: "hello", protocol: 1, name: "mallory2" }, 0); setTimeout(() => evil.send({ t: "set-workspace", id: "w-old" }, 0), 60); };
evil.connect();
await waitFor(() => viewRawErrors.length >= 1, "the host to refuse the view guest's raw set-workspace");
if (setWorkspaces.length !== 1) fail("a view guest's raw set-workspace must NOT reach the host callback");
if (!viewRawErrors.some((e) => e.includes("read-only"))) fail("the host should refuse a view guest's switch with a read-only error");
ok("VIEW guest: no allowlists offered, client refuses the switch, and a hand-crafted raw frame is refused host-side (read-only)");

host.stop("host ended the session");
relay.stop();
console.log("\nP-COLLAB.14 demo complete - an EDIT guest picks the model + an already-used folder from host-offered allowlists (no arbitrary id/path ever crosses the wire); a VIEW guest is offered nothing and refused. The host applies every pick through its own switch path.");
process.exit(0);
