// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/compliance/evidence.ts
//
// P-COMPLY.1 (ADR-0479): collect the NIST SP 800-171 Rev 3 evidence report for THIS host (Contract D).
//
//   bun run tools/compliance/evidence.ts                       print evidence.json to stdout
//   bun run tools/compliance/evidence.ts --out <dir>           write <dir>/evidence.json + <dir>/evidence.md
//   ... --installer <path>                                     check this binary's signature
//   ... --skip-os-probes                                       no signature / disk-encryption subprocesses (CI)
//
// Read-only: it never writes a vault, a setting or a policy, and the report holds no secret value.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { complianceReport, renderMarkdown } from "../../desktop/compliance_report.ts";

const USAGE = "usage: bun run tools/compliance/evidence.ts [--out <dir>] [--installer <path>] [--skip-os-probes]";

export interface EvidenceArgs { out?: string; installer?: string; skipOsProbes: boolean }

/** Parse argv (without the runtime and script). Throws with the usage line on anything unknown. */
export function parseEvidenceArgs(argv: readonly string[]): EvidenceArgs {
  const args: EvidenceArgs = { skipOsProbes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip-os-probes") { args.skipOsProbes = true; continue; }
    if (a === "--out" || a === "--installer") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} needs a value\n${USAGE}`);
      if (a === "--out") args.out = v;
      else args.installer = v;
      continue;
    }
    throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  return args;
}

if (import.meta.main) {
  let args: EvidenceArgs;
  try { args = parseEvidenceArgs(process.argv.slice(2)); } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const report = await complianceReport({ installer: args.installer, skipOsProbes: args.skipOsProbes });
  const json = JSON.stringify(report, null, 2) + "\n";
  if (!args.out) {
    process.stdout.write(json);
  } else {
    const dir = resolve(args.out);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "evidence.json"), json);
    writeFileSync(join(dir, "evidence.md"), renderMarkdown(report));
    const failing = report.checks.filter((c) => c.status === "fail").map((c) => c.id);
    console.error(`evidence written to ${dir} (${report.checks.length} checks; fail: ${failing.join(", ") || "none"})`);
  }
}
