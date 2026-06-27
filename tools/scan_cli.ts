// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/scan_cli.ts
//
// Scan text for prompt-injection (hidden Unicode / homoglyphs) and print the
// findings as JSON. Used by the /lucid:scan omp command.
//
//   bun run tools/scan_cli.ts "some text to scan"
//
// Fail-closed: if the scanner is unavailable, the output marks the text as
// scanner-unavailable (treat as quarantined).

import { ScannerClient } from "../harness/security/scanner_client.ts";

const text = process.argv.slice(2).join(" ");
const client = new ScannerClient();
client.start();
try {
  const r = await client.scan(text);
  console.log(
    JSON.stringify(
      { ok: true, scanner: r.scanner_version, finding_count: r.findings.length, findings: r.findings },
      null,
      2,
    ),
  );
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e), note: "fail-closed: treat as quarantined" }, null, 2));
} finally {
  client.stop();
}
process.exit(0);
