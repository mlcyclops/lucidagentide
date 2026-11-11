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

/** Decompress EVERY entry, keeping its FULL in-archive name (not the basename), for a package whose
 *  folder layout matters (`.lplugin`, ADR-0462). Directory entries (a name ending in "/") are skipped.
 *  Bounded against zip bombs: the declared uncompressed total must fit `maxTotalBytes`, and inflation is
 *  capped at each entry's declared size, so a lying header throws instead of exhausting memory. Names
 *  are returned raw; validating them (traversal, absolute paths) is the caller's gate. Throws on a
 *  corrupt zip, zip64, encryption, or an unsupported method. */
export function readAllZipEntries(buf: Buffer, opts: { maxTotalBytes: number; maxEntries?: number }): { name: string; data: Buffer }[] {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error("not a zip file");
  let off = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  if (count === 0xffff || off === 0xffffffff) throw new Error("zip64 archives are not supported");
  if (count > (opts.maxEntries ?? 20_000)) throw new Error(`too many entries (${count})`);
  const out: { name: string; data: Buffer }[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) throw new Error("corrupt central directory");
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const cSize = buf.readUInt32LE(off + 20);
    const uSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new Error(`encrypted entry: ${name}`);
    if (cSize === 0xffffffff || uSize === 0xffffffff || localOff === 0xffffffff) throw new Error("zip64 entries are not supported");
    if (name.endsWith("/")) continue;
    total += uSize;
    if (total > opts.maxTotalBytes) throw new Error(`archive expands past the ${opts.maxTotalBytes}-byte limit`);
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`corrupt local header: ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + cSize > buf.length) throw new Error(`truncated entry: ${name}`);
    const comp = buf.subarray(dataStart, dataStart + cSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = uSize === 0 ? Buffer.alloc(0) : inflateRawSync(comp, { maxOutputLength: uSize });
    else throw new Error(`unsupported zip compression method ${method}`);
    if (data.length !== uSize) throw new Error(`size mismatch: ${name}`);
    out.push({ name, data });
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
