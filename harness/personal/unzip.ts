// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/personal/unzip.ts — a minimal, dependency-free ZIP entry reader. Just enough to pull a
// single named file (conversations.json / MyActivity.json) out of a ChatGPT / Claude / Gemini
// export .zip without shelling out or adding a dependency. Supports STORE (0) + DEFLATE (8); no
// zip64, no encryption (these exports use neither). Airgap-friendly: pure node:zlib.

import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50; // end of central directory
const CEN_SIG = 0x02014b50; // central directory file header

export interface ZipEntry { name: string; size: number }

function findEOCD(buf: Buffer): number {
  // EOCD sits at the end, before an optional comment (≤ 65535 bytes). Scan backwards for its sig.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  return -1;
}

/** Entry names + uncompressed sizes (central-directory walk). Throws if not a zip. */
export function listZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  let off = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) break;
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
    out.push({ name: buf.toString("utf8", off + 46, off + 46 + nameLen), size: buf.readUInt32LE(off + 24) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Decompress EVERY entry whose basename satisfies `match` (used to pull all
 *  `conversations-NNN.json` shards out of a modern ChatGPT export in one pass).
 *  Entries are returned in central-directory order; sort by name if you need a
 *  deterministic shard order. Throws on a corrupt zip or unsupported method. */
export function readZipEntriesMatching(buf: Buffer, match: (basename: string) => boolean): { name: string; data: Buffer }[] {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error("not a zip file");
  let off = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  const out: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const cSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    const base = name.split("/").pop()!;
    if (match(base)) {
      const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(dataStart, dataStart + cSize);
      if (method === 0) out.push({ name: base, data: Buffer.from(comp) });
      else if (method === 8) out.push({ name: base, data: inflateRawSync(comp) });
      else throw new Error(`unsupported zip compression method ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Decompress the first entry whose basename equals `filename` (case-insensitive), or null if
 *  absent. Throws on a corrupt zip or an unsupported compression method. */
export function readZipEntry(buf: Buffer, filename: string): Buffer | null {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error("not a zip file");
  let off = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  const want = filename.toLowerCase();
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const cSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (name.split("/").pop()!.toLowerCase() === want) {
      // local file header: 30 fixed bytes + name + extra, then the (possibly compressed) data
      const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(dataStart, dataStart + cSize);
      if (method === 0) return Buffer.from(comp); // stored
      if (method === 8) return inflateRawSync(comp); // deflate
      throw new Error(`unsupported zip compression method ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
