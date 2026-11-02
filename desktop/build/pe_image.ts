// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/pe_image.ts - P-RELEASE.9 (ADR-0468): "is this file the same program as that one",
// answered so an Authenticode signature does not count as a difference.
//
// The air-gap gate proves the plain `bun[.exe]` alias is a copy of THIS arch's bun (ADR-0364: the arm64
// AppImage once shipped an x86-64 bun there). It used to compare file size plus the first 64 bytes. On a
// signed Windows build that is wrong: electron-builder signs bun-win32-x64.exe and bun.exe as two separate
// Invoke-TrustedSigning calls, each appends its own PKCS#7 blob with its own RFC 3161 timestamp token, and
// two such blobs need not be the same length. v2.5.0-beta.4 got 86102312 vs 86102320 bytes for one
// identical bun and failed the release.
//
// imageDigest() hashes what signing does not touch, exactly the regions the Authenticode hash itself
// excludes (PE/COFF spec, "Calculating the PE Image Hash"): the optional header's CheckSum, the Security
// data-directory entry, and the attribute certificate table. Every other byte is hashed, so a different
// arch, a different bun version or a corrupt copy still differs. A file that is not PE (ELF, Mach-O)
// hashes whole. A PE whose headers or certificate table do not parse THROWS: the gate fails closed
// rather than hashing an arbitrary prefix.

import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** A byte range [start, end) of the file that imageDigest leaves out of the hash. */
export interface Span { start: number; end: number }

/** The regions Authenticode signing rewrites, or [] for a file that is not PE. Throws on a PE whose
 *  headers or certificate table point outside the file. */
export function signedSpans(head: Buffer, size: number): Span[] {
  if (head.length < 2 || head[0] !== 0x4d || head[1] !== 0x5a) return []; // no "MZ": not PE, hash whole
  const bad = (why: string): never => { throw new Error(`malformed PE: ${why}`); };
  if (head.length < 0x40) bad("DOS header truncated");
  const pe = head.readUInt32LE(0x3c);
  if (pe + 24 > head.length) bad(`e_lfanew ${pe} is past the header read`);
  if (head.readUInt32LE(pe) !== 0x00004550) bad("no PE\\0\\0 signature at e_lfanew");
  const optSize = head.readUInt16LE(pe + 20);
  const opt = pe + 24;
  if (opt + optSize > head.length) bad("optional header truncated");
  const magic = optSize >= 2 ? head.readUInt16LE(opt) : 0;
  if (magic !== 0x10b && magic !== 0x20b) bad(`optional header magic 0x${magic.toString(16)}`);
  const plus = magic === 0x20b;
  if (optSize < (plus ? 112 : 96)) bad("optional header too short for its data directories");
  const spans: Span[] = [{ start: opt + 64, end: opt + 68 }]; // CheckSum, same offset in PE32 and PE32+
  const dirCount = head.readUInt32LE(opt + (plus ? 108 : 92));
  const secEntry = opt + (plus ? 112 : 96) + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY
  if (dirCount <= 4 || secEntry + 8 > opt + optSize) return spans; // no Security entry: unsigned
  spans.push({ start: secEntry, end: secEntry + 8 });
  const certOff = head.readUInt32LE(secEntry); // a FILE offset, not an RVA, for this one directory
  const certLen = head.readUInt32LE(secEntry + 4);
  if (certLen === 0) return spans;
  if (certOff < opt + optSize || certOff + certLen > size) {
    bad(`certificate table [${certOff}, ${certOff + certLen}) is outside the ${size}-byte file`);
  }
  spans.push({ start: certOff, end: certOff + certLen });
  return spans;
}

const HEAD = 4096; // DOS + PE + optional headers; bun's e_lfanew is well inside this
const CHUNK = 1 << 20;

/** sha256 of every byte of `p` outside signedSpans(), streamed in 1 MiB chunks (bun is ~90 MB). */
export function imageDigest(p: string): string {
  const fd = openSync(p, "r");
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(HEAD, size));
    readSync(fd, head, 0, head.length, 0);
    const skip = signedSpans(head, size).sort((a, b) => a.start - b.start);
    const hash = createHash("sha256");
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;
    for (const s of [...skip, { start: size, end: size }]) {
      while (pos < s.start) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, s.start - pos), pos);
        if (n <= 0) throw new Error(`short read at ${pos} of ${p}`);
        hash.update(buf.subarray(0, n));
        pos += n;
      }
      pos = Math.max(pos, s.end);
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
