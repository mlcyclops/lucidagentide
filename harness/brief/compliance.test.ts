// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/brief/compliance.test.ts - P-REPORT.6: the Security-brief control crosswalk + POA&M CSV.
// A DRAFT keyword crosswalk, but its STRUCTURE is a contract: security items map to control families,
// disposition follows the source section, and the CSV carries the eMASS POA&M headers, one row per
// mapped item, quoted/escaped so it imports cleanly.

import { test, expect, describe } from "bun:test";
import { buildComplianceRows, renderComplianceSection, renderPoamCsv, renderCkl } from "./compliance.ts";
import type { EngineeringUpdate } from "./engineering_update.ts";

const U: EngineeringUpdate = {
  label: "TestRepo",
  recentlyShipped: [
    { title: "Network whitelist + credential vault", detail: "encrypted credential store with rotation", source: "PROGRESS.md" },
    { title: "Marketing site copy", detail: "new landing page", source: "PROGRESS.md" }, // NOT security → no row
  ],
  loadBearingDependencies: [],
  techDebt: [
    { title: "OCSF audit export deferred", detail: "audit logging pipeline not wired", source: "ADR-0069" },
  ],
  upcomingDecisions: [
    { title: "Fix prompt-injection scanner gap", detail: "unicode homoglyph edge case", source: "ADR-0080" },
  ],
  risks: [
    { title: "Egress boundary regressed", detail: "a network egress path bypassed the whitelist", source: "AAR" },
  ],
};

describe("compliance crosswalk (P-REPORT.6)", () => {
  const rows = buildComplianceRows(U);

  test("maps only security-relevant items to control families", () => {
    // 4 security items (vault, audit debt, scanner decision, egress risk); the marketing line is excluded.
    expect(rows.length).toBe(4);
    expect(rows.some((r) => /marketing/i.test(r.item.title))).toBe(false);
  });

  test("credential vault → IA-5 + SC-28 families with 800-171 + CCIs", () => {
    const vault = rows.find((r) => /vault/i.test(r.item.title))!;
    expect(vault.nist80053).toEqual(expect.arrayContaining(["IA-5", "SC-28"]));
    expect(vault.nist800171.length).toBeGreaterThan(0);
    expect(vault.ccis.every((c) => /^CCI-\d{6}$/.test(c))).toBe(true);
  });

  test("disposition follows the source section + wording", () => {
    expect(rows.find((r) => /regressed/i.test(r.item.title))!.disposition).toBe("Regressed");
    expect(rows.find((r) => /vault/i.test(r.item.title))!.disposition).toBe("Improved");
    expect(rows.find((r) => /audit export/i.test(r.item.title))!.disposition).toBe("Open finding");
    expect(rows.find((r) => /scanner/i.test(r.item.title))!.disposition).toBe("Planned");
  });

  test("markdown section carries the DRAFT disclaimer, a table, and a rollup", () => {
    const md = renderComplianceSection(U);
    expect(md).toContain("Compliance impact");
    expect(md.toLowerCase()).toContain("draft");
    expect(md).toContain("| Change | Disposition |");
    expect(md).toContain("**Rollup:**");
  });

  test("table cell escapes backslashes AND pipes so a title can't break the columns (js/incomplete-sanitization)", () => {
    const u: EngineeringUpdate = {
      label: "TestRepo", loadBearingDependencies: [], techDebt: [], upcomingDecisions: [], risks: [],
      recentlyShipped: [{ title: "Harden credential vault path C:\\keys | tokens", detail: "x", source: "PROGRESS.md" }],
    };
    const md = renderComplianceSection(u);
    expect(md).toContain("C:\\\\keys");  // `\` escaped to `\\` (FIRST) so a trailing backslash can't eat the delimiter
    expect(md).toContain("\\| tokens");  // `|` escaped to `\|` so it renders in-cell instead of splitting columns
  });

  test("POA&M CSV has the eMASS headers, one row per mapped item, escaped", () => {
    const csv = renderPoamCsv(U, "TestRepo");
    const lines = csv.split("\r\n");
    expect(lines[0]).toContain("Control Vulnerability Description");
    expect(lines[0]).toContain("Security Control Number (NC/NA controls only)");
    expect(lines[0]).toContain("Milestone with Completion Dates");
    expect(lines.length).toBe(rows.length + 1); // header + one row per mapped item
    // Every field is quoted (eMASS-safe); commas inside a control list don't break columns.
    expect(lines[1]!.startsWith('"')).toBe(true);
    // completed vs ongoing status maps from disposition
    expect(csv).toContain('"Completed"');
    expect(csv).toContain('"Ongoing"');
  });

  test("STIG .ckl is well-formed XML with one VULN per item, CCI_REFs, mapped status", () => {
    const ckl = renderCkl(U, "TestRepo");
    expect(ckl.startsWith('<?xml version="1.0"')).toBe(true);
    expect(ckl).toContain("<CHECKLIST>");
    expect(ckl).toContain("</CHECKLIST>");
    expect((ckl.match(/<VULN>/g) || []).length).toBe(rows.length); // one VULN per mapped item
    expect(ckl).toMatch(/<VULN_ATTRIBUTE>CCI_REF<\/VULN_ATTRIBUTE><ATTRIBUTE_DATA>CCI-\d{6}</);
    expect(ckl).toContain("<STATUS>Open</STATUS>");       // the regressed/open items
    expect(ckl).toContain("<STATUS>NotAFinding</STATUS>"); // the improved item (vault)
    expect(ckl).toContain("HOST_NAME>TestRepo");
    // balanced tags (no obviously broken XML)
    expect((ckl.match(/<VULN>/g) || []).length).toBe((ckl.match(/<\/VULN>/g) || []).length);
  });

  test("empty update → honest empty section, header-only CSV", () => {
    const empty: EngineeringUpdate = { label: "x", recentlyShipped: [], loadBearingDependencies: [], techDebt: [], upcomingDecisions: [], risks: [] };
    expect(renderComplianceSection(empty)).toContain("No security-relevant changes");
    expect(renderPoamCsv(empty, "x").split("\r\n").length).toBe(1); // headers only
  });
});
