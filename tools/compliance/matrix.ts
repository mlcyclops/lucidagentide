// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/compliance/matrix.ts
//
// P-COMPLY.1 (ADR-0479): docs/compliance/control-matrix-r3.csv is the ONE source of the NIST SP 800-171
// Rev 3 control matrix; control-matrix-r3.md is rendered from it so the two can never disagree
// (desktop/compliance_report.test.ts fails when the committed .md differs from this rendering).
//
//   bun run tools/compliance/matrix.ts            rewrite docs/compliance/control-matrix-r3.md

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MATRIX_CSV = join(import.meta.dir, "..", "..", "docs", "compliance", "control-matrix-r3.csv");
export const MATRIX_MD = join(import.meta.dir, "..", "..", "docs", "compliance", "control-matrix-r3.md");

export const MATRIX_COLUMNS = [
  "r3_id", "r3_title", "family", "r2_ids", "withdrawn_note", "responsibility",
  "lucid_implementation", "how_to_verify", "evidence_artifact", "status",
] as const;
export type MatrixRow = Record<(typeof MATRIX_COLUMNS)[number], string>;

/** RFC 4180: quoted fields, doubled quotes, commas and line breaks inside quotes. Throws on an open quote. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** The matrix rows keyed by column. Throws when the header or a row's width is wrong. */
export function readMatrix(text: string): MatrixRow[] {
  const [header, ...body] = parseCsv(text);
  if (header?.join(",") !== MATRIX_COLUMNS.join(",")) throw new Error(`unexpected matrix header: ${header?.join(",")}`);
  return body.map((cells, n) => {
    if (cells.length !== MATRIX_COLUMNS.length) throw new Error(`row ${n + 2}: ${cells.length} cells, expected ${MATRIX_COLUMNS.length}`);
    return Object.fromEntries(MATRIX_COLUMNS.map((c, i) => [c, cells[i] ?? ""])) as MatrixRow;
  });
}

const cell = (s: string): string => (s ? s.replace(/\|/g, "\\|") : " ");

/** Pure: the Markdown rendering of the matrix rows. */
export function renderMatrixMarkdown(rows: readonly MatrixRow[]): string {
  const active = rows.filter((r) => r.status !== "withdrawn");
  const count = (key: "status" | "responsibility", v: string): number => active.filter((r) => r[key] === v).length;
  const families = [...new Set(rows.map((r) => r.family))];
  const out = [
    "<!-- GENERATED from control-matrix-r3.csv by `bun run tools/compliance/matrix.ts`. Edit the CSV, not this file. -->",
    "",
    "# LUCID Agent IDE: NIST SP 800-171 Rev 3 control matrix",
    "",
    "Primary baseline NIST SP 800-171 Rev 3 (May 2024), with a Rev 2 cross-reference column because DoD / CMMC assessments still cite Rev 2.",
    "",
    "Sources (requirement ids, titles and withdrawals are copied from these, never invented):",
    "",
    "- NIST SP 800-171r3, https://doi.org/10.6028/NIST.SP.800-171r3 (PDF https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-171r3.pdf): requirement ids, titles, and the Withdrawn dispositions.",
    "- NIST OSCAL catalog, https://github.com/usnistgov/oscal-content/blob/main/nist.gov/SP800-171/rev3/json/NIST_SP800-171_rev3_catalog.json: titles cross-checked for the families it was read for.",
    "- NIST change analysis Rev 2 to Rev 3, https://csrc.nist.gov/files/pubs/sp/800/171/r3/final/docs/sp800-171r2-to-r3-analysis.xlsx: the Rev 2 to Rev 3 row mapping.",
    "",
    `Coverage: ${rows.length} Rev 3 identifiers in ${families.length} families; ${active.length} requirements and ${rows.length - active.length} withdrawn.`,
    "",
    "Rev 2 column rule: the Rev 2 requirement on the same row of the NIST change analysis, plus every Rev 2 requirement whose Rev 3 slot is withdrawn with a note naming this requirement (Incorporated into / Addressed by). `[verify]` marks a reference where the two NIST sources disagree.",
    "",
    "Responsibility: LUCID (the product implements it), shared (LUCID provides a capability the customer must configure or operate), customer (the organization's process or infrastructure), n-a (withdrawn).",
    "Status of the LUCID part: implemented, partial, planned (an in-flight increment), gap (see poam.md), customer (nothing for LUCID to implement).",
    "",
    `Totals over the ${active.length} requirements: implemented ${count("status", "implemented")}, partial ${count("status", "partial")}, planned ${count("status", "planned")}, gap ${count("status", "gap")}, customer ${count("status", "customer")}. Responsibility: LUCID ${count("responsibility", "LUCID")}, shared ${count("responsibility", "shared")}, customer ${count("responsibility", "customer")}.`,
    "",
    "Paths are relative to the repository root. `evidence.json` is the output of `bun run tools/compliance/evidence.ts --out <dir>` (see evidence-guide.md).",
  ];
  for (const family of families) {
    out.push("", `## ${family}`, "", "| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of rows.filter((x) => x.family === family)) {
      const title = r.status === "withdrawn" ? `Withdrawn: ${r.withdrawn_note}` : r.r3_title;
      out.push(`| ${r.r3_id} | ${cell(title)} | ${cell(r.r2_ids)} | ${r.responsibility} | ${cell(r.lucid_implementation)} | ${cell(r.how_to_verify)} | ${cell(r.evidence_artifact)} | ${r.status} |`);
    }
  }
  return out.join("\n") + "\n";
}

if (import.meta.main) {
  writeFileSync(MATRIX_MD, renderMatrixMarkdown(readMatrix(readFileSync(MATRIX_CSV, "utf8"))));
  console.error(`wrote ${MATRIX_MD}`);
}
