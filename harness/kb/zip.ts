// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/zip.ts — P-KGMARKET.4 (ADR-0206): a minimal, first-party zip WRITER (the counterpart to the
// existing reader harness/personal/unzip.ts). Airgap-friendly: pure node:zlib, no dependency. Used to bundle
// a KG pack's manifest.json + kb_graph.duckdb into one downloadable `.lkgpack.zip` (the Cloud Storage object
// the entitlement backend signs). Each entry is DEFLATE (method 8) unless that grows it, then STORED (0) -
// both of which unzip.ts reads. No zip64, no encryption, no folders (flat entries), which is all a pack needs.

import { deflateRawSync } from "node:zlib";

export interface ZipFile { name: string; data: Uint8Array }

/** CRC-32 (IEEE) of a byte buffer — the checksum every zip entry header carries. */
function crc32(buf: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

const DOS_DATE = 0x0021; // 1980-01-01, midnight — fixed so the archive is byte-deterministic

/** Build a valid zip archive from flat entries. Readable by harness/personal/unzip.ts and standard tools. */
export function zipEntries(entries: ZipFile[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data);
    const crc = crc32(data);
    const deflated = deflateRawSync(data);
    const store = deflated.length >= data.length; // don't grow tiny/incompressible entries
    const method = store ? 0 : 8;
    const body = store ? data : deflated;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);            // version needed
    lfh.writeUInt16LE(0, 6);             // flags
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);            // mod time
    lfh.writeUInt16LE(DOS_DATE, 12);     // mod date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);  // compressed size
    lfh.writeUInt32LE(data.length, 22);  // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);            // extra len
    parts.push(lfh, nameBuf, body);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);            // version made by
    cdh.writeUInt16LE(20, 6);            // version needed
    cdh.writeUInt16LE(0, 8);             // flags
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(0, 30);            // extra + comment len (both 0)
    cdh.writeUInt16LE(0, 34);            // disk number start
    cdh.writeUInt16LE(0, 36);            // internal attrs
    cdh.writeUInt32LE(0, 38);            // external attrs
    cdh.writeUInt32LE(offset, 42);       // local-header offset
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, eocd]);
}
