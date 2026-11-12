// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/compile-sep.ts - build the macOS Secure Enclave helper (tools/macsep/lucid_sep.swift) into
// bin/lucid-sep for the knowledge graph's `sep` protector (P-KGBIO.1, ADR-0454; spec §4.4).
//
// A universal binary (arm64 + x86_64, macOS 13+), because dist:mac cuts both architectures from one bin/.
// bin/** ships as resources/repo/bin, where main.ts looks for it. swiftc ad-hoc signs its output on Apple
// Silicon; the helper needs no entitlement (CryptoKit Secure Enclave keys are not stored in the keychain).
// On any other platform this is a no-op, so every dist:* chain can call it unconditionally.
//
//   bun run build/compile-sep.ts

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

if (process.platform !== "darwin") {
  console.log("compile-sep: not macOS, nothing to build");
  process.exit(0);
}
const root = join(import.meta.dir, "..", "..");
const src = join(root, "tools", "macsep", "lucid_sep.swift");
const out = join(root, "bin", "lucid-sep");
mkdirSync(join(root, "bin"), { recursive: true });
const slices: string[] = [];
for (const arch of ["arm64", "x86_64"]) {
  const slice = `${out}-${arch}`;
  const r = Bun.spawnSync(["xcrun", "swiftc", "-O", "-target", `${arch}-apple-macos13.0`, "-o", slice, src], { stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) { console.error(`compile-sep: swiftc failed for ${arch}`); process.exit(1); }
  slices.push(slice);
}
const lipo = Bun.spawnSync(["lipo", "-create", "-output", out, ...slices], { stdout: "inherit", stderr: "inherit" });
for (const s of slices) rmSync(s, { force: true });
if (lipo.exitCode !== 0) { console.error("compile-sep: lipo failed"); process.exit(1); }
// lipo's output loses the per-slice signatures; re-sign ad hoc so arm64 will run it.
const sign = Bun.spawnSync(["codesign", "--force", "--sign", "-", out], { stdout: "inherit", stderr: "inherit" });
if (sign.exitCode !== 0) { console.error("compile-sep: codesign failed"); process.exit(1); }
console.log(`compile-sep: ${out}`);
