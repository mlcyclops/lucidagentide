// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_premote10c.ts
//
// P-REMOTE.10c (ADR-0235): the phone PWA "get a reconnect code" READER, proven end-to-end with REAL WebCrypto
// against an in-memory MOCK Drive. A host wrote a PIN-encrypted EDIT reconnect code (P-REMOTE.10/.10b); a
// disconnected phone (drive.file access token) reads the shared `lucid_relay_codes` file and resolves it to a
// rejoin link via the `resolveReconnect` state machine, then NORMALIZES that link to a room fragment exactly
// as the PWA does before reloading. Fail-closed: locked (no PIN) and wrong-PIN never yield a link; expired
// codes are refused.
//
// The only live-only piece is the drive.file OAuth token (an incremental Firebase consent on the phone).
//
// Run with: bun run harness/scripts/demo_premote10c.ts

import { buildCode, appendCode, buildFileContent, resolveReconnect, RELAY_FILE_NAME, type RelayCode } from "../../desktop/collab/drive_relay_codes.ts";
import { ensureRelayFile, findRelayFile, readRelayFile, type FetchLike } from "../../desktop/collab/drive_file.ts";
import { formatRelayLink, formatShareLink, parseShareLink, generateRoomId } from "../../desktop/collab/link.ts";
import { ROOM_KEY_BYTES, WRITE_TOKEN_BYTES } from "@oh-my-pi/pi-wire";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-REMOTE.10c demo - phone reconnect-code READER (real crypto, mock Drive)\n");

// ── an in-memory mock of the Drive REST endpoints the reader uses (list + media GET + multipart create) ──
interface DriveFile { id: string; name: string; content: string }
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
    store.set(id, { id, name, content });
    return new Response(JSON.stringify({ id }), { status: 200 });
  }
  const mediaGet = url.match(/\/drive\/v3\/files\/([^?]+)\?alt=media/);
  if (mediaGet && method === "GET") { const f = store.get(mediaGet[1]!); return f ? new Response(f.content, { status: 200 }) : new Response("", { status: 404 }); }
  return new Response("unhandled", { status: 500 });
};

const TOKEN = "ya29.mock-drive-file-token";
const PIN = "8317";
const now = Date.now();

// ── the host writes a PIN-encrypted EDIT reconnect code (as P-REMOTE.10b's writer does) ──
const roomId = generateRoomId();
const key = crypto.getRandomValues(new Uint8Array(ROOM_KEY_BYTES));
const writeToken = crypto.getRandomValues(new Uint8Array(WRITE_TOKEN_BYTES));
const editLink = formatRelayLink("wss://relay.aiworkshopapps.com", roomId, key, writeToken); // the stored relay-path link
const codes: RelayCode[] = appendCode([], buildCode(editLink, true, roomId, now));
const fileId = await ensureRelayFile(TOKEN, RELAY_FILE_NAME, await buildFileContent(codes, PIN), drive);
ok(`host wrote a PIN-encrypted edit reconnect code to ${RELAY_FILE_NAME}`);

// ── the phone READER: find + read the shared file (drive.file token), then resolve it ──
const foundId = await findRelayFile(TOKEN, RELAY_FILE_NAME, drive);
if (foundId !== fileId) fail("reader should find the same file");
const body = await readRelayFile(TOKEN, foundId!, drive);

// [1] locked: encrypted file, no PIN -> never leaks a link
if ((await resolveReconnect(body, null, now)).status !== "locked") fail("encrypted file + no PIN must resolve to 'locked'");
ok("locked: an encrypted file with no PIN never yields a link");

// [2] bad-pin: wrong PIN fails closed
if ((await resolveReconnect(body, "0000", now)).status !== "bad-pin") fail("wrong PIN must resolve to 'bad-pin'");
ok("bad-pin: the wrong PIN fails closed (no link)");

// [3] ok: the right PIN recovers the freshest link
const res = await resolveReconnect(body, PIN, now);
if (res.status !== "ok" || res.link !== editLink || !res.edit) fail("the right PIN should recover the edit link");
ok(`ok: recovered the edit reconnect link with the PIN (${res.link.slice(0, 40)}\u2026)`);

// [4] the PWA rejoin: normalize the stored (relay-path) link to a room FRAGMENT and re-parse it losslessly
const p = parseShareLink(res.link);
const frag = formatShareLink(p.roomId, p.key, p.writeToken); // what app.ts sets as location.hash before reload
const rp = parseShareLink(frag);
if (rp.roomId !== roomId) fail("the normalized fragment lost the room id");
if (!Buffer.from(rp.key).equals(Buffer.from(key))) fail("the normalized fragment lost the room key");
if (!rp.writeToken || !Buffer.from(rp.writeToken).equals(Buffer.from(writeToken))) fail("the normalized fragment lost the write token (edit access)");
ok("the recovered link normalizes to a room fragment the PWA re-parses losslessly (room + key + write token)");

// [5] expired: a file whose only code is stale is refused (no reconnect to a dead room)
const stale: RelayCode = { ts: now - 20_000, roomId: "old", expiryMs: now - 1, link: "wss://relay/r/old.K", edit: false };
if ((await resolveReconnect(await buildFileContent([stale], null), null, now)).status !== "expired") fail("a stale-only file must resolve to 'expired'");
ok("expired: a file with only stale codes is refused (nothing live to rejoin)");

// [6] empty: no codes at all
if ((await resolveReconnect(await buildFileContent([], null), null, now)).status !== "empty") fail("an empty file must resolve to 'empty'");
ok("empty: a codes file with nothing in it resolves to 'empty'");

console.log("\nP-REMOTE.10c demo complete - a disconnected phone reads the host's shared lucid_relay_codes file (drive.file), decrypts with the optional PIN, and recovers a rejoin link that normalizes losslessly to a room fragment. Locked / wrong-PIN / expired all fail closed. The drive.file OAuth consent is the only live-only step.");
process.exit(0);
