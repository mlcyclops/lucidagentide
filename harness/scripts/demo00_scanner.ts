// harness/scripts/demo00_scanner.ts
//
// Increment 0, part 2/3: the scanner sidecar flags a poisoned string and passes
// a clean one. Exercises the real TS<->Python NDJSON IPC (ADR-0002).

import { ScannerClient } from "../security/scanner_client.ts";

const ZWSP = String.fromCodePoint(0x200b);
const client = new ScannerClient();
client.start();

try {
  const clean = await client.scan("the quick brown fox");
  console.log(`clean   -> ${clean.findings.length} finding(s) [scanner ${clean.scanner_version}]`);

  const poisoned = await client.scan(`edit${ZWSP}file`);
  console.log(`poisoned -> ${poisoned.findings.length} finding(s):`);
  for (const f of poisoned.findings) {
    console.log(`   ${f.type} ${f.codepoint} @${f.index} severity=${f.severity}`);
  }

  if (clean.findings.length !== 0 || poisoned.findings.length === 0) {
    console.error("FAIL: expected clean=0 findings, poisoned>=1 finding");
    process.exit(1);
  }
  console.log("demo00_scanner OK");
} finally {
  client.stop();
}
process.exit(0);
