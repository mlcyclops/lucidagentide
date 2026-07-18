// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_premote10.ts
//
// P-REMOTE.10 (ADR-0233): out-of-band reconnect via a Google Drive relay-codes file, proven end-to-end with
// REAL WebCrypto against an in-memory MOCK Drive (the drive.file OAuth token is the only live-only piece).
// A host writes the current (edit) reconnect link, PIN-encrypted, to the single `lucid_relay_codes` file; the
// file at rest holds CIPHERTEXT (never the link); a disconnected reader reads + decrypts with the PIN to get
// the freshest link and rejoin; a wrong PIN fails closed; and the file is shared with a teammate per-file.
//
// Run with: bun run harness/scripts/demo_premote10.ts

import { chooseReconnectLink, buildCode, appendCode, latestValidCode, buildFileContent, readFileContent, fileIsEncrypted, RELAY_FILE_NAME, type RelayCode } from "../../desktop/collab/drive_relay_codes.ts";
import { ensureRelayFile, findRelayFile, readRelayFile, updateRelayFile, shareRelayFile, type FetchLike } from "../../desktop/collab/drive_file.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-REMOTE.10 demo - Drive relay-codes reconnect (real crypto, mock Drive)\n");

// ── an in-memory mock of the Drive REST endpoints the client uses ──
interface DriveFile { id: string; name: string; content: string; permissions: { role: string; emailAddress: string }[] }
const store = new Map<string, DriveFile>();
let seq = 0;
const drive: FetchLike = async (url, init) => {
  const method = init?.method ?? "GET";
  if (url.includes("/drive/v3/files?q=")) {
    const name = decodeURIComponent(url).match(/name='([^']+)'/)?.[1] ?? "";
    const hit = [...store.values()].find((f) => f.name === name);
    return new Response(JSON.stringify({ files: hit ? [{ id: hit.id, name: hit.name }] : [] }), { status: 200 });
  }
  if (url.includes("/upload/drive/v3/files?uploadType=multipart")) {
    const body = String(init?.body ?? "");
    const name = body.match(/"name":"([^"]+)"/)?.[1] ?? "untitled";
    const content = body.match(/Content-Type: application\/json\r\n\r\n([\s\S]*?)\r\n--/)?.[1] ?? "";
    const id = `f${++seq}`;
    store.set(id, { id, name, content, permissions: [] });
    return new Response(JSON.stringify({ id }), { status: 200 });
  }
  const mediaGet = url.match(/\/drive\/v3\/files\/([^?]+)\?alt=media/);
  if (mediaGet && method === "GET") { const f = store.get(mediaGet[1]!); return f ? new Response(f.content, { status: 200 }) : new Response("", { status: 404 }); }
  const mediaPatch = url.match(/\/upload\/drive\/v3\/files\/([^?]+)\?uploadType=media/);
  if (mediaPatch && method === "PATCH") { const f = store.get(mediaPatch[1]!); if (f) { f.content = String(init?.body ?? ""); return new Response("{}", { status: 200 }); } return new Response("", { status: 404 }); }
  const perm = url.match(/\/drive\/v3\/files\/([^/]+)\/permissions/);
  if (perm && method === "POST") { const f = store.get(perm[1]!); const b = JSON.parse(String(init?.body ?? "{}")); if (f) { f.permissions.push({ role: b.role, emailAddress: b.emailAddress }); return new Response(JSON.stringify({ id: "perm" }), { status: 200 }); } return new Response("", { status: 404 }); }
  return new Response("unhandled", { status: 500 });
};

const TOKEN = "ya29.mock-drive-file-token";
const PIN = "8317";
const now = Date.now();

// [1] host writes an EDIT reconnect code, PIN-encrypted
const chosen = chooseReconnectLink({ allowEdit: true, fullLink: "wss://relay.aiworkshopapps.com/r/room1.KEY.TOKEN", viewLink: "wss://relay.aiworkshopapps.com/r/room1.KEY" });
if (!chosen || !chosen.edit) fail("an edit share should choose the edit link");
let codes: RelayCode[] = appendCode([], buildCode(chosen.link, chosen.edit, "room1", now));
const fileId = await ensureRelayFile(TOKEN, RELAY_FILE_NAME, await buildFileContent(codes, PIN), drive);
ok(`host created ${RELAY_FILE_NAME} and wrote 1 PIN-encrypted edit code`);

// [2] the file at rest is CIPHERTEXT - the link is not present
const atRest = store.get(fileId)!.content;
if (!fileIsEncrypted(atRest) || atRest.includes("room1.KEY")) fail("the link must NOT be readable at rest when a PIN is set");
ok("at rest the file is ciphertext - the reconnect link is not present in the Drive file");

// [3] a disconnected reader finds + reads + decrypts with the PIN -> the freshest link
const foundId = await findRelayFile(TOKEN, RELAY_FILE_NAME, drive);
if (foundId !== fileId) fail("reader should find the same file");
const readBack = await readFileContent(await readRelayFile(TOKEN, foundId!, drive), PIN);
const latest = latestValidCode(readBack ?? [], now + 1000);
if (!latest || latest.link !== chosen.link) fail("reader should recover the edit link with the right PIN");
ok(`reader recovered the reconnect link with the PIN: ${latest.link.slice(0, 44)}\u2026`);

// [4] wrong PIN fails closed
if ((await readFileContent(atRest, "0000")) !== null) fail("a wrong PIN must fail closed (null)");
ok("wrong PIN fails closed (null) - the code is unusable without it");

// [5] a reconnect appends a fresh code; the reader now gets the newest
codes = appendCode(readBack ?? [], buildCode("wss://relay.aiworkshopapps.com/r/room2.KEY2.TOKEN2", true, "room2", now + 5000));
await updateRelayFile(TOKEN, fileId, await buildFileContent(codes, PIN), drive);
const after = latestValidCode(await readFileContent(await readRelayFile(TOKEN, fileId, drive), PIN) ?? [], now + 6000);
if (!after || after.roomId !== "room2") fail("after a reconnect, the newest code should win");
ok("a later reconnect appends a fresh code; the reader picks the newest");

// [6] share the single file with a teammate (per-file, Drive-native)
await shareRelayFile(TOKEN, fileId, "dana@team.io", drive);
if (!store.get(fileId)!.permissions.some((p) => p.emailAddress === "dana@team.io" && p.role === "writer")) fail("share should add a per-file writer permission");
ok("shared JUST this file with a teammate (per-file writer permission) - not the rest of the Drive");

console.log("\nP-REMOTE.10 demo complete - reconnect links live in the user's own Drive (drive.file), optionally PIN-encrypted at rest, fail-closed, per-file shareable. The drive.file OAuth consent is the only live-only step.");
process.exit(0);
