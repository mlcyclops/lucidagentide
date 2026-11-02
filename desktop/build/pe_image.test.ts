// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for build/pe_image.ts (ADR-0467): the air-gap gate's "same bun" comparison.
//
// The regression: v2.5.0-beta.4's Windows release leg failed because electron-builder Azure-signed
// bun-win32-x64.exe and its plain bun.exe alias separately, the two signatures came out 8 bytes apart,
// and the gate compared file sizes. What must still fail is the bug the check exists for (ADR-0364):
// an alias that is another arch's bun. Files are written to a real temp dir and read back through the
// same fd path the gate uses.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageDigest, signedSpans } from "./pe_image.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function file(name: string, bytes: Buffer): string {
  const d = mkdtempSync(join(tmpdir(), "lucid-peimg-"));
  dirs.push(d);
  const p = join(d, name);
  writeFileSync(p, bytes);
  return p;
}

const E_LFANEW = 0x80;
const OPT = E_LFANEW + 24;
const OPT_SIZE = 240; // PE32+ with 16 data directories
const SEC_ENTRY = OPT + 112 + 4 * 8;
const HEADERS = OPT + OPT_SIZE;

/** A minimal PE32+ image: DOS header, PE signature, COFF header, optional header, then `body`. */
function pe(body: Buffer, machine = 0x8664): Buffer {
  const b = Buffer.alloc(HEADERS + body.length);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(E_LFANEW, 0x3c);
  b.writeUInt32LE(0x00004550, E_LFANEW);
  b.writeUInt16LE(machine, E_LFANEW + 4);
  b.writeUInt16LE(OPT_SIZE, E_LFANEW + 20);
  b.writeUInt16LE(0x20b, OPT);
  b.writeUInt32LE(16, OPT + 108);
  body.copy(b, HEADERS);
  return b;
}

/** What signtool does: pad to 8, append a WIN_CERTIFICATE of `certLen` bytes, point the Security entry at
 *  it, and rewrite the CheckSum. Two signings of one file differ in exactly these places. */
function sign(unsigned: Buffer, certLen: number, fill: number, checksum: number): Buffer {
  const padded = Buffer.concat([unsigned, Buffer.alloc((8 - (unsigned.length % 8)) % 8)]);
  const out = Buffer.concat([padded, Buffer.alloc(certLen, fill)]);
  out.writeUInt32LE(padded.length, SEC_ENTRY);
  out.writeUInt32LE(certLen, SEC_ENTRY + 4);
  out.writeUInt32LE(checksum, OPT + 64);
  return out;
}

const program = Buffer.from("bun program bytes ".repeat(5000), "latin1");

describe("imageDigest", () => {
  test("two separate signatures of one bun are the same image (the v2.5.0-beta.4 failure)", () => {
    const base = pe(program);
    const a = file("bun-win32-x64.exe", sign(base, 10_232, 0xaa, 0x1234));
    const b = file("bun.exe", sign(base, 10_240, 0xbb, 0x5678)); // 8 bytes longer, like beta.4
    expect(imageDigest(a)).toBe(imageDigest(b));
  });

  test("signed and unsigned copies of one bun are the same image", () => {
    const base = pe(program);
    expect(imageDigest(file("bun.exe", base))).toBe(imageDigest(file("bun-win32-x64.exe", sign(base, 4096, 1, 9))));
  });

  test("another arch's bun differs even when signed the same way", () => {
    const x64 = file("bun-win32-x64.exe", sign(pe(program, 0x8664), 4096, 1, 9));
    const arm = file("bun.exe", sign(pe(program, 0xaa64), 4096, 1, 9));
    expect(imageDigest(x64)).not.toBe(imageDigest(arm));
  });

  test("one changed byte of the program outside the signature differs", () => {
    const other = Buffer.from(program);
    other.writeUInt8(other.readUInt8(other.length - 1) ^ 1, other.length - 1);
    expect(imageDigest(file("a.exe", sign(pe(program), 4096, 1, 9)))).not.toBe(imageDigest(file("b.exe", sign(pe(other), 4096, 1, 9))));
  });

  test("non-PE files (ELF, Mach-O) compare whole", () => {
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), program]);
    expect(imageDigest(file("bun", elf))).toBe(imageDigest(file("bun-linux-x64", Buffer.from(elf))));
    const arm = Buffer.from(elf);
    arm.writeUInt8(0xb7, 18); // e_machine: aarch64
    expect(imageDigest(file("bun", elf))).not.toBe(imageDigest(file("bun-linux-arm64", arm)));
  });
});

describe("signedSpans fails closed", () => {
  test("a certificate table past the end of the file throws", () => {
    const b = pe(program);
    b.writeUInt32LE(b.length - 16, SEC_ENTRY);
    b.writeUInt32LE(64, SEC_ENTRY + 4);
    expect(() => signedSpans(b, b.length)).toThrow(/certificate table/);
  });

  test("an MZ file with no PE signature throws", () => {
    const b = pe(program);
    b.writeUInt32LE(0, E_LFANEW);
    expect(() => signedSpans(b, b.length)).toThrow(/PE\\0\\0/);
  });

  test("an unknown optional header magic throws", () => {
    const b = pe(program);
    b.writeUInt16LE(0x107, OPT);
    expect(() => signedSpans(b, b.length)).toThrow(/magic/);
  });
});
