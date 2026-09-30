// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_18.ts
//
// P-SANDBOX.18 (ADR-0423): the AppContainer helper stops re-walking every file it already granted.
//   [1] the effect check reads the two-ACE form Windows stores for one inheritable grant;
//   [2] (Windows) a real grant on a throwaway tree of 4000 files: the first spawn writes the ACL, the
//       second finds it in place, writes nothing and starts in a fraction of the time; then the grant is
//       revoked and the tree removed, leaving the host as it was.
//
// Run: bun run harness/scripts/demo_p_sandbox_18.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { aclAlreadyGrants } from "../../tools/appcontainer/lucid_appcontainer.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0423 P-SANDBOX.18: a granted folder is not re-granted on every spawn ==\n");

console.log("[1] the effect check");
const SID = Uint8Array.from([1, 2, 0, 0, 0, 0, 0, 15, 2, 0, 0, 0, 3, 0, 0, 0]);
const ace = (flags: number, mask: number) => {
  const b = new Uint8Array(8 + SID.length); const dv = new DataView(b.buffer);
  b[1] = flags; dv.setUint16(2, b.length, true); dv.setUint32(4, mask >>> 0, true); b.set(SID, 8); return b;
};
const acl = (...aces: Uint8Array[]) => {
  const size = 8 + aces.reduce((n, a) => n + a.length, 0); const b = new Uint8Array(size); const dv = new DataView(b.buffer);
  b[0] = 2; dv.setUint16(2, size, true); dv.setUint16(4, aces.length, true);
  let off = 8; for (const a of aces) { b.set(a, off); off += a.length; } return b;
};
ok(aclAlreadyGrants(acl(ace(0, 0x1f01ff), ace(0x0b, 0x10000000)), SID, "rw"), "the stored pair (mapped rights + inherit-only GENERIC_ALL) is a full rw grant");
ok(!aclAlreadyGrants(acl(ace(0, 0x1f01ff)), SID, "rw"), "rights on the folder alone, not inherited by its files, is not");

if (process.platform !== "win32") {
  console.log("\n[2] skipped: the ACL write path is Windows-only");
  console.log("\nPASS: P-SANDBOX.18 (pure check only on this platform).");
  process.exit(0);
}

console.log("\n[2] a real grant, twice, on a throwaway tree");
const HELPER = join(import.meta.dir, "..", "..", "tools", "appcontainer", "lucid_appcontainer.ts");
// Not under %TEMP%: the helper's own probe grants the container rw on the temp dir, so a tree there already
// inherits the grant (which the check rightly counts). The home directory itself carries no container ACE.
const root = mkdtempSync(join(homedir(), ".lucid-p-sandbox-18-"));
for (let d = 0; d < 40; d++) {
  const dir = join(root, `d${d}`); mkdirSync(dir);
  for (let f = 0; f < 100; f++) writeFileSync(join(dir, `f${f}.txt`), "x");
}
const cmd = join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
const spawnOnce = () => {
  const t0 = performance.now();
  const r = Bun.spawnSync([process.execPath, HELPER, "--workspace", root, "--deny-network", "--", cmd, "/c", "echo", "contained"], { stdout: "pipe", stderr: "pipe" });
  return { ms: Math.round(performance.now() - t0), code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
};
try {
  const first = spawnOnce();
  ok(first.code === 0 && first.out === "contained", `first contained spawn ran (${first.ms} ms)`);
  ok(/acl grant .*lucid-p-sandbox-18-\S+ rw/.test(first.err), `the first spawn wrote the grant${/acl grant .*lucid-p-sandbox-18/.test(first.err) ? "" : `\n${first.err}`}`);
  const second = spawnOnce();
  ok(second.code === 0 && second.out === "contained", `second contained spawn ran (${second.ms} ms)`);
  ok(/acl already granted .*lucid-p-sandbox-18-\S+ rw/.test(second.err), "the second spawn found it in place and wrote nothing");
  ok(second.ms < first.ms, `the second spawn skipped the tree walk: ${first.ms} ms -> ${second.ms} ms`);
} finally {
  Bun.spawnSync([process.execPath, HELPER, "--revoke-acl", root], { stdout: "ignore", stderr: "ignore" });
  rmSync(root, { recursive: true, force: true });
}

console.log("\nPASS: P-SANDBOX.18 - an existing grant costs nothing on the next spawn; the contained agent starts in time.");
