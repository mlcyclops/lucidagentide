// harness/scripts/demo00_failclosed.ts
//
// Increment 0, part 3/3 — THE keystone safety property, proven on day one:
// kill the scanner sidecar mid-run and assert the gate BLOCKS, never passes.
// (Permanently guarded by harness/security/gate.failclosed.test.ts too.)

import { ScannerClient } from "../security/scanner_client.ts";
import { scanAndDecide } from "../security/gate.ts";

const client = new ScannerClient();
client.start();

// Baseline: a clean string is allowed while the scanner is alive.
const before = await scanAndDecide(client, "benign text");
console.log(`scanner alive  -> block=${before.block} trust=${before.trustLabel} (${before.reason})`);

// Now kill the sidecar and scan the SAME kind of clean text.
console.log("killing the scanner sidecar...");
client.stop();

const after = await scanAndDecide(client, "benign text");
console.log(`scanner dead   -> block=${after.block} trust=${after.trustLabel} failClosed=${after.failClosed}`);
console.log(`   reason: ${after.reason}`);

if (before.block !== false || after.block !== true || after.failClosed !== true) {
  console.error("FAIL: gate did not fail closed when the scanner died");
  process.exit(1);
}
console.log("demo00_failclosed OK — scan unavailable mapped to BLOCK");
process.exit(0);
