// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/macho.ts - #614 (ADR-0569): which CPU a Mach-O file is built for, read from its header.
//
// v2.5.4-beta.1's LucidAgent-mac-x64.zip shipped an arm64 `repo/bin/lucid-engine` and `bin/lucid`, so an Intel
// Mac could not start the engine. The macOS job builds on an arm64 runner and packs both arches, and nothing
// read the bytes it packed: the files had the right names, so every check passed. The gate that now stops such
// a build (build/mac-arch-gate.ts) and the per-arch staging (build/stage-mac-arch.ts) both ask the question
// answered here: which architectures does this file carry?
//
// Header layouts (<mach-o/loader.h>, <mach-o/fat.h>):
//   thin: magic 0xfeedfacf (64-bit) or 0xfeedface (32-bit) in the file's own byte order, cputype at offset 4.
//   fat:  magic 0xcafebabe (0xcafebabf for 64-bit offsets), always big-endian, nfat_arch at 4, then nfat_arch
//         records of 20 (or 32) bytes, each starting with its cputype.
// Java class files share 0xcafebabe; their next word is the class version (45 and up), so a fat header must
// declare between 1 and MAX_FAT_ARCHS slices (the bound `file(1)` uses) or the file is not Mach-O.
//
// Pure functions over bytes, plus one small read helper. A file that is not Mach-O returns null; a fat header
// whose slice table runs past the bytes read THROWS, so a gate fails closed instead of judging half a header.

import { closeSync, openSync, readSync } from "node:fs";

/** The two macOS arches LUCID ships, in electron-builder's naming (its `Arch` enum, `${arch}` macro). */
export type MacArch = "arm64" | "x64";
export const MAC_ARCHS: readonly MacArch[] = ["arm64", "x64"];

export const CPU_TYPE_X86 = 0x00000007;
export const CPU_TYPE_X86_64 = 0x01000007;
export const CPU_TYPE_ARM = 0x0000000c;
export const CPU_TYPE_ARM64 = 0x0100000c;
export const CPU_TYPE_ARM64_32 = 0x0200000c;

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MAX_FAT_ARCHS = 20;

/** Bytes readMachHead() takes: a fat table of MAX_FAT_ARCHS 64-bit records is 8 + 20 * 32 = 648 bytes. */
export const MACH_HEAD_BYTES = 4096;

export interface MachO {
  /** A universal (fat) binary, as opposed to a single-arch (thin) one. */
  readonly fat: boolean;
  /** Every slice's CPU, by cpuName(): `arm64`, `x64`, or a descriptive name for anything else. */
  readonly archs: readonly string[];
}

/** A cputype as a name. arm64 and x86_64 use electron-builder's names so they compare with MacArch directly. */
export function cpuName(cputype: number): string {
  switch (cputype >>> 0) {
    case CPU_TYPE_ARM64:
      return "arm64";
    case CPU_TYPE_X86_64:
      return "x64";
    case CPU_TYPE_X86:
      return "i386";
    case CPU_TYPE_ARM:
      return "arm";
    case CPU_TYPE_ARM64_32:
      return "arm64_32";
    default:
      return `cpu-0x${(cputype >>> 0).toString(16).padStart(8, "0")}`;
  }
}

/** Parse the head of a file. null = not Mach-O. Throws on a fat header whose slice table is cut off. */
export function parseMachO(head: Uint8Array): MachO | null {
  if (head.length < 8) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const be = view.getUint32(0, false);
  if (be === FAT_MAGIC || be === FAT_MAGIC_64) {
    const count = view.getUint32(4, false);
    if (count < 1 || count > MAX_FAT_ARCHS) return null; // a Java class file, not a universal binary
    const stride = be === FAT_MAGIC_64 ? 32 : 20;
    const end = 8 + count * stride;
    if (end > head.length) throw new Error(`fat Mach-O declares ${count} slices (${end} header bytes) but only ${head.length} bytes were read`);
    const archs: string[] = [];
    for (let i = 0; i < count; i++) archs.push(cpuName(view.getUint32(8 + i * stride, false)));
    return { fat: true, archs };
  }
  for (const little of [true, false]) {
    const magic = view.getUint32(0, little);
    if (magic === MH_MAGIC_64 || magic === MH_MAGIC) return { fat: false, archs: [cpuName(view.getUint32(4, little))] };
  }
  return null;
}

/** Does this binary run as `target`? Thin: its one arch is the target. Fat: one of its slices is. */
export function machRunsOn(m: MachO, target: MacArch): boolean {
  return m.archs.includes(target);
}

/** `arm64`, `x64`, or `universal(arm64,x64)`, for reports. */
export function describeMachO(m: MachO): string {
  return m.fat ? `universal(${m.archs.join(",")})` : m.archs.join(",");
}

const ARCH_TOKEN = /(?:^|[/\\._-])(arm64|aarch64|x86_64|x64|amd64)(?=$|[/\\._-])/g;

/** The arches a path NAMES, e.g. `runtimes/python-darwin-x64/lib/libpython3.12.dylib` names x64. Arch-keyed
 *  files exist on purpose: runtime.ts picks `bun-<plat>-<arch>` and `python-<plat>-<arch>` by process.arch, so a
 *  package can carry the other arch's copy without ever running it. */
export function archsNamedIn(path: string): ReadonlySet<MacArch> {
  const out = new Set<MacArch>();
  for (const m of path.toLowerCase().matchAll(ARCH_TOKEN)) out.add(m[1] === "arm64" || m[1] === "aarch64" ? "arm64" : "x64");
  return out;
}

export type MachVerdict = "match" | "keyed-other-arch" | "mismatch";

/** Judge one Mach-O inside the `target` app. `strict` (repo/bin, the plain runtimes/bun alias): it must run on
 *  the target, whatever its name. Elsewhere a file that does not run on the target is allowed only when its
 *  path names the other arch and not the target, i.e. it is an arch-keyed copy the app never selects here. */
export function machVerdict(path: string, m: MachO, target: MacArch, strict: boolean): MachVerdict {
  if (machRunsOn(m, target)) return "match";
  if (strict) return "mismatch";
  const named = archsNamedIn(path);
  return named.size > 0 && !named.has(target) ? "keyed-other-arch" : "mismatch";
}

/** Read the first MACH_HEAD_BYTES of `path` (follows symlinks) and parse them. */
export function readMachO(path: string): MachO | null {
  const fd = openSync(path, "r");
  try {
    const buf = new Uint8Array(MACH_HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return parseMachO(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}
