// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/personal/unzip.test.ts — the minimal ZIP reader used to import an export .zip without
// a dependency. Builds real zip buffers (deflate + stored) in-memory and round-trips them.

import { expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { listZipEntries, readZipEntriesMatching, readZipEntry } from "./unzip.ts";
import { isConversationShard } from "./import_adapters.ts";

// Build a single-entry zip the long way (the reader ignores CRC, so we leave it 0).
function makeZip(name: string, content: string, method: 0 | 8 = 8): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const data = Buffer.from(content, "utf8");
  const body = method === 8 ? deflateRawSync(data) : data;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
  local.writeUInt32LE(0, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
  const localChunk = Buffer.concat([local, nameBuf, body]);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(method, 10); cen.writeUInt32LE(0, 16); cen.writeUInt32LE(body.length, 20);
  cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(0, 42);
  const cenChunk = Buffer.concat([cen, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cenChunk.length, 12); eocd.writeUInt32LE(localChunk.length, 16);
  return Buffer.concat([localChunk, cenChunk, eocd]);
}

// Build a multi-entry zip (concatenate local chunks, then all central-dir records, then EOCD).
function makeMultiZip(entries: { name: string; content: string; method?: 0 | 8 }[]): Buffer {
  const locals: Buffer[] = [];
  const cens: Buffer[] = [];
  let localOff = 0;
  for (const { name, content, method = 8 } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const body = method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const localChunk = Buffer.concat([local, nameBuf, body]);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10); cen.writeUInt32LE(0, 16); cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(localOff, 42);
    cens.push(Buffer.concat([cen, nameBuf]));
    locals.push(localChunk);
    localOff += localChunk.length;
  }
  const localAll = Buffer.concat(locals);
  const cenAll = Buffer.concat(cens);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cenAll.length, 12); eocd.writeUInt32LE(localAll.length, 16);
  return Buffer.concat([localAll, cenAll, eocd]);
}

test("readZipEntriesMatching pulls every conversations-NNN.json shard (folder-prefixed, ordered by name)", () => {
  const zip = makeMultiZip([
    { name: "export/conversations-000.json", content: "[0]", method: 8 },
    { name: "export/conversation_asset_file_names.json", content: "{}", method: 0 }, // must NOT match
    { name: "export/conversations-001.json", content: "[1]", method: 0 },
    { name: "export/user.json", content: "{}" }, // must NOT match
  ]);
  const got = readZipEntriesMatching(zip, isConversationShard).sort((a, b) => a.name.localeCompare(b.name));
  expect(got.map((e) => e.name)).toEqual(["conversations-000.json", "conversations-001.json"]);
  expect(got.map((e) => e.data.toString("utf8"))).toEqual(["[0]", "[1]"]);
});

test("readZipEntry round-trips a DEFLATE entry by basename (case-insensitive)", () => {
  const json = JSON.stringify([{ mapping: { a: { message: { author: { role: "user" }, content: { parts: ["hi"] } } } } }]);
  const zip = makeZip("ChatGPT export/conversations.json", json, 8);
  const got = readZipEntry(zip, "conversations.json");
  expect(got).not.toBeNull();
  expect(got!.toString("utf8")).toBe(json);
  expect(readZipEntry(zip, "ConVeRsAtIoNs.JsOn")!.toString("utf8")).toBe(json); // case-insensitive
});

test("readZipEntry handles STORED (uncompressed) entries and lists names", () => {
  const zip = makeZip("MyActivity.json", "[]", 0);
  expect(listZipEntries(zip).map((e) => e.name)).toEqual(["MyActivity.json"]);
  expect(readZipEntry(zip, "MyActivity.json")!.toString("utf8")).toBe("[]");
});

test("readZipEntry returns null for a missing entry and throws on a non-zip", () => {
  const zip = makeZip("conversations.json", "[]");
  expect(readZipEntry(zip, "nope.json")).toBeNull();
  expect(() => readZipEntry(Buffer.from("not a zip at all"), "x")).toThrow(/not a zip/);
});
