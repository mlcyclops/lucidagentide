// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for build/macho.ts (#614, ADR-0569): the Mach-O header reader behind the mac arch gate.
//
// The headers are built byte by byte from the <mach-o/loader.h> and <mach-o/fat.h> layouts, the same bytes a
// real arm64 lucid-engine starts with (cf fa ed fe 0c 00 00 01, the evidence in #614), so a reader that got the
// byte order or the record stride wrong fails here rather than passing a wrong-arch release.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archsNamedIn,
  CPU_TYPE_ARM64,
  CPU_TYPE_X86_64,
  cpuName,
  describeMachO,
  machRunsOn,
  machVerdict,
  parseMachO,
  readMachO,
} from "./macho.ts";

/** A thin 64-bit header in little-endian order (what both Apple arches write). */
function thin(cputype: number, magic = 0xfeedfacf): Uint8Array {
  const b = new Uint8Array(32);
  const v = new DataView(b.buffer);
  v.setUint32(0, magic, true);
  v.setUint32(4, cputype, true);
  return b;
}

/** A fat header (always big-endian) with one record per cputype. */
function fat(cputypes: number[], magic = 0xcafebabe): Uint8Array {
  const stride = magic === 0xcafebabf ? 32 : 20;
  const b = new Uint8Array(8 + cputypes.length * stride);
  const v = new DataView(b.buffer);
  v.setUint32(0, magic, false);
  v.setUint32(4, cputypes.length, false);
  cputypes.forEach((c, i) => v.setUint32(8 + i * stride, c, false));
  return b;
}

describe("parseMachO", () => {
  test("a thin arm64 binary: the exact bytes #614 found in the x64 zip's lucid-engine", () => {
    const head = thin(CPU_TYPE_ARM64);
    expect([...head.subarray(0, 8)]).toEqual([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
    expect(parseMachO(head)).toEqual({ fat: false, archs: ["arm64"] });
  });

  test("a thin x86_64 binary", () => {
    expect(parseMachO(thin(CPU_TYPE_X86_64))).toEqual({ fat: false, archs: ["x64"] });
  });

  test("32-bit and big-endian thin headers are read in their own byte order", () => {
    expect(parseMachO(thin(7, 0xfeedface))).toEqual({ fat: false, archs: ["i386"] });
    const be = new Uint8Array(8);
    new DataView(be.buffer).setUint32(0, 0xfeedfacf, false);
    new DataView(be.buffer).setUint32(4, CPU_TYPE_X86_64, false);
    expect(parseMachO(be)).toEqual({ fat: false, archs: ["x64"] });
  });

  test("a universal binary lists every slice, 32-bit and 64-bit fat tables alike", () => {
    expect(parseMachO(fat([CPU_TYPE_X86_64, CPU_TYPE_ARM64]))).toEqual({ fat: true, archs: ["x64", "arm64"] });
    expect(parseMachO(fat([CPU_TYPE_ARM64, CPU_TYPE_X86_64], 0xcafebabf))).toEqual({ fat: true, archs: ["arm64", "x64"] });
  });

  test("a Java class file shares 0xcafebabe and is not Mach-O", () => {
    const cls = new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41]); // class version 65
    expect(parseMachO(cls)).toBeNull();
  });

  test("ELF, PE, scripts and short files are not Mach-O", () => {
    expect(parseMachO(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))).toBeNull();
    expect(parseMachO(new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]))).toBeNull();
    expect(parseMachO(new TextEncoder().encode("#!/bin/sh\nexec bun\n"))).toBeNull();
    expect(parseMachO(new Uint8Array([0xcf, 0xfa, 0xed]))).toBeNull();
  });

  test("a fat table cut off by the read throws instead of judging half a header", () => {
    expect(() => parseMachO(fat([CPU_TYPE_X86_64, CPU_TYPE_ARM64]).subarray(0, 20))).toThrow(/declares 2 slices/);
  });

  test("an unknown cputype keeps its number", () => {
    expect(cpuName(0x01000012)).toBe("cpu-0x01000012");
  });
});

describe("machVerdict", () => {
  const arm = { fat: false, archs: ["arm64"] } as const;
  const x64 = { fat: false, archs: ["x64"] } as const;
  const uni = { fat: true, archs: ["x64", "arm64"] } as const;

  test("a thin binary runs only on its own arch; a universal one on both", () => {
    expect(machRunsOn(x64, "x64")).toBe(true);
    expect(machRunsOn(arm, "x64")).toBe(false);
    expect(machRunsOn(uni, "x64")).toBe(true);
    expect(machRunsOn(uni, "arm64")).toBe(true);
    expect(describeMachO(uni)).toBe("universal(x64,arm64)");
  });

  test("repo/bin is strict: an arm64 lucid-engine in the x64 app fails whatever it is named", () => {
    expect(machVerdict("repo/bin/lucid-engine", arm, "x64", true)).toBe("mismatch");
    expect(machVerdict("repo/bin/pi_natives.darwin-arm64-modern.node", arm, "x64", true)).toBe("mismatch");
    expect(machVerdict("repo/bin/lucid-sep", uni, "x64", true)).toBe("match");
  });

  test("elsewhere an arch-keyed copy of the other arch is allowed, an unkeyed or self-keyed one is not", () => {
    expect(machVerdict("runtimes/bun-darwin-arm64", arm, "x64", false)).toBe("keyed-other-arch");
    expect(machVerdict("runtimes/python-darwin-arm64/bin/python3.12", arm, "x64", false)).toBe("keyed-other-arch");
    expect(machVerdict("runtimes/uv-darwin-x64", arm, "x64", false)).toBe("mismatch");
    expect(machVerdict("repo/node_modules/@img/sharp-darwin-arm64/lib/sharp.node", arm, "x64", false)).toBe("keyed-other-arch");
    expect(machVerdict("repo/node_modules/some-addon/build/Release/addon.node", arm, "x64", false)).toBe("mismatch");
    expect(machVerdict("whisper/whisper-server", x64, "arm64", false)).toBe("mismatch");
  });

  test("archsNamedIn reads arch tokens between separators only", () => {
    expect([...archsNamedIn("runtimes/python-darwin-x64/lib/x.dylib")]).toEqual(["x64"]);
    expect([...archsNamedIn("target/x86_64-apple-darwin/release/lucid-holder")]).toEqual(["x64"]);
    expect([...archsNamedIn("target/aarch64-apple-darwin/release/lucid-holder")]).toEqual(["arm64"]);
    expect([...archsNamedIn("node_modules/sax64/lib/index.js")]).toEqual([]);
    expect([...archsNamedIn("fat/arm64-x64/lib")].toSorted()).toEqual(["arm64", "x64"]);
  });
});

describe("readMachO", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("reads a file's head from disk; a file shorter than the read window still parses", () => {
    const d = mkdtempSync(join(tmpdir(), "lucid-macho-"));
    dirs.push(d);
    const body = new Uint8Array(10_000);
    body.set(thin(CPU_TYPE_X86_64));
    writeFileSync(join(d, "lucid-engine"), body);
    writeFileSync(join(d, "lucid-sep"), fat([CPU_TYPE_ARM64, CPU_TYPE_X86_64]));
    writeFileSync(join(d, "README"), "not a binary");
    expect(readMachO(join(d, "lucid-engine"))).toEqual({ fat: false, archs: ["x64"] });
    expect(readMachO(join(d, "lucid-sep"))).toEqual({ fat: true, archs: ["arm64", "x64"] });
    expect(readMachO(join(d, "README"))).toBeNull();
  });
});
