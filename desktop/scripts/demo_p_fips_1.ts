// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_fips_1.ts
//
// Increment P-FIPS.1 (ADR-0473): at-rest crypto runs in the OS's FIPS 140 module. REAL module, no mocks:
//   1) cryptoInfo(): which module performs the operations, whether the FIPS claim holds, the OS policy.
//   2) the power-on known-answer tests (NIST GCM vector, PBKDF2-HMAC-SHA256, SHA-256("abc"), HMAC, tag
//      mismatch, DRBG) on that module.
//   3) no migration: a personal-kg.v1 blob sealed by the old node:crypto code opens through the module,
//      and the module's KEK and ciphertext equal node:crypto's byte for byte.
//   4) fail closed: LUCID_FIPS_REQUIRED=1 with the native module forced unavailable refuses every op.
//   5) Electron main safety: fips_crypto.ts bundled with --target=node loads under Node (when it is on
//      PATH) without bun:ffi and reports the node:crypto fallback honestly.
//
// Run: bun run desktop/scripts/demo_p_fips_1.ts

import { createCipheriv, pbkdf2Sync, randomBytes as nodeRandom } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decrypt, deriveKey, encrypt, KEY_LEN } from "../../harness/personal/crypto.ts";
import {
  _forceModuleForTest, aesGcmEncrypt, cryptoInfo, cryptoSelfTest, FipsRequiredError, sha256, type CryptoProviderInfo,
} from "../../harness/crypto/fips_crypto.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} - ok`);
const HARNESS = join(import.meta.dir, "..", "..", "harness");

console.log("== ADR-0473 P-FIPS.1: at-rest crypto through the OS FIPS 140 module ==");
delete process.env.LUCID_FIPS_REQUIRED;
const dir = mkdtempSync(join(tmpdir(), "lucid-fips1-"));
try {
  console.log("\n[1] cryptoInfo()");
  const info = cryptoInfo();
  console.log(JSON.stringify(info, null, 2).replace(/^/gm, "   "));
  if (process.platform === "win32" && info.module !== "windows-cng") fail(`on Windows under Bun the module must be windows-cng, got ${info.module}`);
  if (info.module === "bun-boringssl" && info.fips) fail("the node:crypto fallback must never claim fips");
  ok(`${info.module}, fips=${info.fips}, OS policy=${info.osFipsPolicy}`);

  console.log("\n[2] power-on known-answer tests");
  for (const k of cryptoSelfTest()) {
    if (!k.ok) fail(`KAT failed: ${k.name}`);
    ok(k.name);
  }

  console.log("\n[3] personal-kg.v1 needs no migration");
  const salt = nodeRandom(16);
  const kek = pbkdf2Sync(Buffer.from("demo passphrase", "utf8"), salt, 600_000, KEY_LEN, "sha256");
  if (!deriveKey("demo passphrase", salt).equals(kek)) fail("the module's PBKDF2 KEK differs from node:crypto's");
  ok("PBKDF2-HMAC-SHA256 (600000 iterations) KEK identical to the old pbkdf2Sync path");
  const iv = nodeRandom(12);
  const c = createCipheriv("aes-256-gcm", kek, iv);
  const graph = JSON.stringify({ nodes: [{ id: "n1", label: "demo" }], edges: [] });
  const ct = Buffer.concat([c.update(Buffer.from(graph, "utf8")), c.final()]);
  const legacy = { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
  if (decrypt(legacy, kek).toString("utf8") !== graph) fail("a node:crypto-sealed personal-kg.v1 blob did not open through the module");
  ok("a blob sealed by the old node:crypto code opens through the module");
  const mine = aesGcmEncrypt(kek, iv, Buffer.from(graph, "utf8"));
  if (mine.ct.toString("base64") !== legacy.ct || mine.tag.toString("base64") !== legacy.tag) fail("the module's AES-256-GCM output differs from node:crypto's");
  ok("same key and nonce: ciphertext and tag identical to node:crypto");
  if (decrypt(encrypt(graph, kek), kek).toString("utf8") !== graph) fail("a fresh seal did not round-trip");
  ok("a fresh seal round-trips");

  console.log("\n[4] fail closed when FIPS is required");
  _forceModuleForTest("bun-boringssl");
  process.env.LUCID_FIPS_REQUIRED = "1";
  const forced = cryptoInfo();
  if (forced.module !== "bun-boringssl" || forced.fips || !forced.required) fail(`forced-unavailable info must be honest, got ${JSON.stringify(forced)}`);
  try { sha256(Buffer.from("abc")); fail("an operation succeeded with FIPS required and no validated module"); } catch (e) {
    if (!(e instanceof FipsRequiredError)) fail(`expected FipsRequiredError, got ${String(e)}`);
  }
  try { encrypt("secret", kek); fail("the personal store sealed without a validated module"); } catch (e) {
    if (!(e instanceof FipsRequiredError)) fail(`expected FipsRequiredError, got ${String(e)}`);
  }
  ok("every operation throws FipsRequiredError; cryptoInfo still answers");
  delete process.env.LUCID_FIPS_REQUIRED;
  _forceModuleForTest(null);

  console.log("\n[5] Electron main (Node) never loads bun:ffi");
  const bundle = join(dir, "fips_crypto.node.cjs");
  const b = Bun.spawnSync([process.execPath, "build", join(HARNESS, "crypto", "fips_crypto.ts"), "--target=node", "--format=cjs", "--outfile", bundle], { stderr: "pipe" });
  if (b.exitCode !== 0) fail(`fips_crypto.ts must bundle for Node: ${b.stderr.toString().slice(0, 400)}`);
  ok("fips_crypto.ts bundles with --target=node");
  const node = Bun.which("node");
  if (node) {
    const probe = `const m = require(${JSON.stringify(bundle)});
      const k = Buffer.alloc(32, 7), iv = Buffer.alloc(12, 9);
      const r = m.aesGcmEncrypt(k, iv, Buffer.from("electron main"));
      console.log(JSON.stringify({ info: m.cryptoInfo(), ct: r.ct.toString("hex"), tag: r.tag.toString("hex") }));`;
    // Node has no bun:ffi: had the bundle required it, loading or the first operation would throw here.
    const r = Bun.spawnSync([node, "-e", probe], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) fail(`the Node bundle must load under Node: ${r.stderr.toString().slice(0, 400)}`);
    const seen = JSON.parse(r.stdout.toString().trim()) as { info: CryptoProviderInfo; ct: string; tag: string };
    if (seen.info.module !== "bun-boringssl" || seen.info.fips) fail(`under Node the provider must be the honest node:crypto fallback, got ${JSON.stringify(seen)}`);
    const here = aesGcmEncrypt(Buffer.alloc(32, 7), Buffer.alloc(12, 9), Buffer.from("electron main"));
    if (here.ct.toString("hex") !== seen.ct || here.tag.toString("hex") !== seen.tag) fail("Node fallback output differs from the native module's");
    ok(`under Node: module=${seen.info.module}, fips=false, no bun:ffi, output identical to ${info.module}`);
  } else {
    console.log("   (node is not on PATH: the Node-runtime check is skipped; the bundle check still ran)");
  }

  console.log("\nP-FIPS.1 demo: all checks passed - existing encrypted data opens unchanged through the OS module.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
