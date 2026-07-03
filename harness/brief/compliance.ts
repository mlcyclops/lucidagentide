// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/brief/compliance.ts
//
// P-REPORT.6: a compliance CROSSWALK for the Security engineering brief. Given the same structured
// EngineeringUpdate the brief is built from, it maps each security-relevant change to the NIST SP
// 800-171 / 800-53 control families and representative DISA STIG CCIs its area touches, tags a
// disposition (improved / fixed / regressed / open / planned), and can emit a POA&M CSV whose headers
// line up with the eMASS POA&M import template (and STIG-Viewer CCI concepts).
//
// HONESTY / SCOPE: this is a KEYWORD-DRIVEN DRAFT crosswalk, not an authoritative control assessment.
// The mappings are the well-known families each security area lands in; the exact control/CCI selection
// for a given system MUST be validated by a security analyst against the current baseline (RMF control
// set + the applicable STIG/CCI list). Every rendered artifact says so. PURE: no I/O, no Date.

import type { EngineeringUpdate, UpdateItem } from "./engineering_update.ts";

export type Disposition = "Fixed" | "Improved" | "Regressed" | "Open finding" | "Planned";

export interface ComplianceRow {
  item: UpdateItem;
  section: string;          // human label of the source section
  disposition: Disposition;
  area: string;             // the security area the keyword match named
  nist800171: string[];     // e.g. ["3.13.11"]
  nist80053: string[];      // e.g. ["SC-28"]
  ccis: string[];           // representative DISA STIG CCIs
}

// Keyword → control-family crosswalk. An item can match several families; matches accumulate + dedupe.
// Families and their control/CCI selections are the standard, defensible mappings for each area - to be
// VALIDATED against the applicable baseline, not treated as final.
const CONTROL_MAP: { re: RegExp; area: string; n171: string[]; n53: string[]; cci: string[] }[] = [
  { re: /encrypt|crypto|\bvault\b|fips|at.rest|cipher|\baes\b|key.?store|safestorage/i,
    area: "Cryptographic protection / data at rest", n171: ["3.13.11", "3.13.16"], n53: ["SC-13", "SC-28"], cci: ["CCI-002450", "CCI-002475", "CCI-001199"] },
  { re: /credential|secret|password|api.?key|\btoken\b|authenticator|rotation/i,
    area: "Authenticator & credential management", n171: ["3.5.2", "3.5.10"], n53: ["IA-5"], cci: ["CCI-000196", "CCI-000197", "CCI-002367"] },
  { re: /permission|approval|rbac|least.privilege|access.control|authoriz|\bgate\b|elicitation/i,
    area: "Access enforcement / least privilege", n171: ["3.1.1", "3.1.5"], n53: ["AC-3", "AC-6"], cci: ["CCI-000213", "CCI-002165"] },
  { re: /audit|logging|\blog\b|ocsf|provenance|\bevent\b|traceab|showback/i,
    area: "Audit & accountability", n171: ["3.3.1", "3.3.2"], n53: ["AU-2", "AU-3", "AU-12"], cci: ["CCI-000130", "CCI-000169", "CCI-000172"] },
  { re: /network|egress|whitelist|firewall|boundary|\bdns\b|proxy|allow.?list/i,
    area: "Boundary protection / information flow", n171: ["3.13.1", "3.1.3"], n53: ["SC-7", "AC-4"], cci: ["CCI-001097", "CCI-001414", "CCI-000366"] },
  { re: /inject|scanner|quarantin|malicious|saniti|unicode|homoglyph|validat|untrusted|prompt.?inject/i,
    area: "Malicious-code & input validation", n171: ["3.14.2", "3.14.6", "3.13.13"], n53: ["SI-3", "SI-4", "SI-10"], cci: ["CCI-001240", "CCI-002656", "CCI-001310"] },
  { re: /isolat|sandbox|blast.?radius|fail.?closed|in.?process|contain(?:ment)?/i,
    area: "Process isolation / boundary", n171: ["3.13.3", "3.13.4"], n53: ["SC-7", "SC-39"], cci: ["CCI-001084", "CCI-002530"] },
  { re: /\bcui\b|sovereign|data.?boundary|classif|air.?gap|offline/i,
    area: "CUI handling & transmission", n171: ["3.8.3", "3.1.3", "3.13.8"], n53: ["MP-6", "SC-8"], cci: ["CCI-002420", "CCI-001199"] },
  { re: /session|trust.?label|attribut|identity|authenticat|\blogin\b|oauth/i,
    area: "Identification & authentication", n171: ["3.5.1", "3.5.2"], n53: ["IA-2"], cci: ["CCI-000764", "CCI-000766"] },
  { re: /vulnerab|codeql|\bcve\b|patch|hardening|toctou|\brace\b|flaw/i,
    area: "Flaw remediation", n171: ["3.14.1"], n53: ["SI-2", "RA-5"], cci: ["CCI-001227", "CCI-002617"] },
];

const uniq = (xs: string[]): string[] => [...new Set(xs)];

// The Security BRIEF hides ADR/increment codes (role rule), so the crosswalk table scrubs them from the
// change title too. Local (no import) to avoid a cycle with engineering_update. The POA&M CSV keeps the
// full title + a source column - it's the analyst's traceability artifact, not the audience-facing brief.
function plainTitle(title: string): string {
  const lead = (title || "").replace(/^\s*(?:ADR-\d+|[A-Z][A-Z0-9]*-[A-Z0-9.]+|P-[A-Z]+(?:\.[A-Za-z0-9]+)*)\s*[-–·:]\s*/i, "");
  const t = lead
    .replace(/\bADR-\d+\b/gi, "").replace(/\bP-[A-Z]+(?:\.[A-Za-z0-9]+)*\b/g, "").replace(/\b[A-Z]{2,}-\d+\b/g, "")
    .replace(/#\d+\b/g, "").replace(/\bv?\d+\.\d+\.\d+\b/g, "")
    .replace(/\(\s*[,·;/-]*\s*\)/g, "").replace(/^[\s,·;:/-]+/, "").replace(/\s+([,.;:·])/g, "$1").replace(/\s{2,}/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : (title || "").trim();
}

/** Map one item to its candidate control families (accumulated across all keyword matches). */
function mapControls(it: UpdateItem): { area: string; n171: string[]; n53: string[]; cci: string[] } | null {
  const hay = `${it.title} ${it.detail ?? ""} ${it.source}`;
  const hits = CONTROL_MAP.filter((c) => c.re.test(hay));
  if (!hits.length) return null;
  return {
    area: uniq(hits.map((h) => h.area)).join("; "),
    n171: uniq(hits.flatMap((h) => h.n171)),
    n53: uniq(hits.flatMap((h) => h.n53)),
    cci: uniq(hits.flatMap((h) => h.cci)),
  };
}

/** Disposition from the section an item came from + its wording. */
function disposition(section: string, it: UpdateItem): Disposition {
  const t = `${it.title} ${it.detail ?? ""}`.toLowerCase();
  if (section === "recentlyShipped") return /fix|resolv|patch|remediat|close|codeql|vuln|harden/.test(t) ? "Fixed" : "Improved";
  if (section === "risks") return /regress|broke|reintroduc/.test(t) ? "Regressed" : "Open finding";
  if (section === "techDebt") return "Open finding";
  return "Planned"; // upcomingDecisions
}

const SECTION_LABEL: Record<string, string> = {
  recentlyShipped: "Recently shipped", risks: "Risks", techDebt: "Tech debt", upcomingDecisions: "Upcoming decisions", loadBearingDependencies: "Dependencies",
};

/** Build the security compliance crosswalk rows from the update (only items that map to a control). */
export function buildComplianceRows(u: EngineeringUpdate): ComplianceRow[] {
  const rows: ComplianceRow[] = [];
  const order: (keyof EngineeringUpdate)[] = ["risks", "techDebt", "recentlyShipped", "upcomingDecisions", "loadBearingDependencies"];
  for (const key of order) {
    const items = u[key];
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const m = mapControls(it);
      if (!m) continue;
      rows.push({ item: it, section: SECTION_LABEL[key] ?? String(key), disposition: disposition(String(key), it), area: m.area, nist800171: m.n171, nist80053: m.n53, ccis: m.cci });
    }
  }
  return rows;
}

const DISCLAIMER =
  "DRAFT crosswalk - generated from the change log by keyword. The control/CCI selections are the standard " +
  "families each area touches and MUST be validated by a security analyst against the applicable RMF baseline " +
  "and current STIG/CCI list before use in an assessment or eMASS.";

/** Markdown section appended to the Security brief: an affected-controls table + disposition legend. */
export function renderComplianceSection(u: EngineeringUpdate): string {
  const rows = buildComplianceRows(u);
  const out: string[] = ["## Compliance impact (NIST SP 800-171 / 800-53 · DISA STIG CCIs)", ""];
  out.push(`_${DISCLAIMER}_`, "");
  if (!rows.length) { out.push("_No security-relevant changes mapped to a control this cycle._", ""); return out.join("\n"); }
  out.push("| Change | Disposition | 800-171 | 800-53 | STIG CCIs |", "|---|---|---|---|---|");
  for (const r of rows) {
    const title = plainTitle(r.item.title).replace(/\|/g, "\\|");
    out.push(`| ${title} | ${r.disposition} | ${r.nist800171.join(", ")} | ${r.nist80053.join(", ")} | ${r.ccis.join(", ")} |`);
  }
  out.push("");
  // Rollup by disposition so the reader sees what improved/fixed vs regressed/open at a glance.
  const by = (d: Disposition) => rows.filter((r) => r.disposition === d).length;
  out.push(`**Rollup:** ${by("Fixed")} fixed · ${by("Improved")} improved · ${by("Regressed")} regressed · ${by("Open finding")} open · ${by("Planned")} planned.`, "");
  out.push("_Export a POA&M (eMASS-aligned CSV) from the Reports panel to track the open items to closure._", "");
  return out.join("\n");
}

// ── POA&M CSV (eMASS import template columns) ────────────────────────────────────
// Column order follows the eMASS POA&M import template; CCIs populate "Security Checks" (STIG-Viewer
// concept), controls populate "Security Control Number". Unknown fields are left blank/TBD for the analyst.
const POAM_HEADERS = [
  "Control Vulnerability Description", "Security Control Number (NC/NA controls only)", "Office/Org", "Security Checks",
  "Resources Required", "Scheduled Completion Date", "Milestone with Completion Dates", "Milestone Changes",
  "Source Identifying Vulnerability", "Status", "Comments", "Raw Severity Value", "Devices Affected",
  "Mitigations", "Severity", "Relevance of Threat", "Likelihood", "Impact", "Impact Description",
  "Residual Risk Level", "Recommendations", "Resulting Residual Risk after Proposed Mitigations",
];

const csvCell = (s: string): string => `"${(s ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;

// eMASS Status vocabulary: Completed | Ongoing | Risk Accepted | Not Applicable.
function poamStatus(d: Disposition): string { return d === "Fixed" || d === "Improved" ? "Completed" : "Ongoing"; }
// CAT severity heuristic: open/regressed security weaknesses default to CAT II, others CAT III (analyst adjusts).
function poamSeverity(d: Disposition): string { return d === "Regressed" || d === "Open finding" ? "CAT II" : "CAT III"; }

/** Produce the eMASS-aligned POA&M CSV for the security-relevant, control-mapped items. `label` names the
 *  system (repo). Includes a leading comment line marking it a DRAFT (eMASS ignores leading `#`? No - so we
 *  keep the CSV pure and put the disclaimer only in the UI/filename). */
export function renderPoamCsv(u: EngineeringUpdate, label: string): string {
  const rows = buildComplianceRows(u);
  const lines: string[] = [POAM_HEADERS.map(csvCell).join(",")];
  for (const r of rows) {
    const desc = `${r.item.title}${r.item.detail ? ` - ${r.item.detail}` : ""}`;
    const rec = "Validate control/CCI mapping against the current baseline; verify implementation and evidence.";
    const cells = [
      desc,                                   // Control Vulnerability Description
      r.nist80053.join(" "),                   // Security Control Number
      "Engineering",                            // Office/Org
      r.ccis.join(" "),                         // Security Checks (CCIs)
      "TBD",                                    // Resources Required
      "",                                       // Scheduled Completion Date
      "",                                       // Milestone with Completion Dates
      "",                                       // Milestone Changes
      `${label} change log (${r.item.source})`, // Source Identifying Vulnerability
      poamStatus(r.disposition),                // Status
      `${r.disposition} · ${r.area}`,           // Comments
      "",                                       // Raw Severity Value
      "",                                       // Devices Affected
      r.item.detail ?? "",                      // Mitigations
      poamSeverity(r.disposition),              // Severity
      "",                                       // Relevance of Threat
      "",                                       // Likelihood
      "",                                       // Impact
      "",                                       // Impact Description
      "",                                       // Residual Risk Level
      rec,                                      // Recommendations
      "",                                       // Resulting Residual Risk
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\r\n");
}

// ── STIG Viewer checklist (.ckl) - native XML ────────────────────────────────────
// A .ckl STIG Viewer opens directly: one VULN per control-mapped change, keyed by its CCIs, with the
// disposition mapped to a STIG status. HONESTY: the Vuln/Rule IDs are SYNTHETIC (LUCID-Vnnn), not from a
// published STIG benchmark - this is a DRAFT crosswalk checklist for analyst review, not a benchmark scan.
const xmlEsc = (s: string): string =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sd = (attr: string, data: string): string =>
  `<STIG_DATA><VULN_ATTRIBUTE>${attr}</VULN_ATTRIBUTE><ATTRIBUTE_DATA>${xmlEsc(data)}</ATTRIBUTE_DATA></STIG_DATA>`;
const siData = (name: string, data: string): string => `<SI_DATA><SID_NAME>${name}</SID_NAME><SID_DATA>${xmlEsc(data)}</SID_DATA></SI_DATA>`;
const cklStatus = (d: Disposition): string => (d === "Fixed" || d === "Improved" ? "NotAFinding" : d === "Planned" ? "Not_Reviewed" : "Open");
const cklSeverity = (d: Disposition): string => (d === "Regressed" || d === "Open finding" ? "medium" : "low");

/** Produce a STIG-Viewer-openable .ckl for the security control crosswalk. `asset` = hostname/system. */
export function renderCkl(u: EngineeringUpdate, asset = "LucidAgentIDE"): string {
  const rows = buildComplianceRows(u);
  const vulns = rows.map((r, i) => {
    const num = `V-${String(i + 1).padStart(6, "0")}`;
    const rule = `SV-${String(i + 1).padStart(6, "0")}r1_rule`;
    const controls = r.nist80053.join(", ");
    const discuss = `${r.disposition}. Affected controls: ${controls} (NIST SP 800-171: ${r.nist800171.join(", ")}). DRAFT crosswalk generated from the change log - validate against the applicable baseline + current CCI list.`;
    const data = [
      sd("Vuln_Num", num),
      sd("Severity", cklSeverity(r.disposition)),
      sd("Group_Title", r.area),
      sd("Rule_ID", rule),
      sd("Rule_Ver", `LUCID-${num}`),
      sd("Rule_Title", plainTitle(r.item.title)),
      sd("Vuln_Discuss", discuss),
      sd("Check_Content", `Verify the implementation and evidence for: ${plainTitle(r.item.title)}. ${r.item.detail ?? ""}`.trim()),
      sd("Fix_Text", "Validate the control/CCI mapping against the baseline, then implement or remediate as required and attach evidence."),
      sd("STIGRef", `${asset} change crosswalk (DRAFT)`),
      sd("Security_Override_Guidance", ""),
      ...r.ccis.map((c) => sd("CCI_REF", c)),
    ].join("");
    const finding = `${r.disposition} (${r.section}). Source: ${r.item.source}. ${r.item.detail ?? ""}`.trim();
    return `<VULN>${data}<STATUS>${cklStatus(r.disposition)}</STATUS>` +
      `<FINDING_DETAILS>${xmlEsc(finding)}</FINDING_DETAILS>` +
      `<COMMENTS>DRAFT crosswalk - analyst must validate control/CCI selection before use.</COMMENTS>` +
      `<SEVERITY_OVERRIDE></SEVERITY_OVERRIDE><SEVERITY_JUSTIFICATION></SEVERITY_JUSTIFICATION></VULN>`;
  }).join("");
  const stigInfo =
    siData("version", "1") + siData("classification", "UNCLASSIFIED") +
    siData("stigid", `${asset}_Crosswalk`) + siData("description", "DRAFT NIST 800-171/800-53 + STIG CCI crosswalk generated from the LucidAgentIDE change log. Not a published benchmark - for analyst validation.") +
    siData("filename", `${asset}-crosswalk.ckl`) + siData("releaseinfo", "Draft - generated") +
    siData("title", `${asset} Change Crosswalk (DRAFT)`) + siData("uuid", "00000000-0000-0000-0000-000000000000") +
    siData("notice", "terms-of-use") + siData("source", "LucidAgentIDE");
  const asset_ =
    `<ROLE>None</ROLE><ASSET_TYPE>Computing</ASSET_TYPE><HOST_NAME>${xmlEsc(asset)}</HOST_NAME>` +
    `<HOST_IP></HOST_IP><HOST_MAC></HOST_MAC><HOST_FQDN></HOST_FQDN><TARGET_COMMENT>DRAFT crosswalk - validate before use</TARGET_COMMENT>` +
    `<TECH_AREA></TECH_AREA><TARGET_KEY></TARGET_KEY><WEB_OR_DATABASE>false</WEB_OR_DATABASE><WEB_DB_SITE></WEB_DB_SITE><WEB_DB_INSTANCE></WEB_DB_INSTANCE>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!--DISA STIG Viewer :: draft crosswalk-->\n` +
    `<CHECKLIST><ASSET>${asset_}</ASSET><STIGS><iSTIG><STIG_INFO>${stigInfo}</STIG_INFO>${vulns}</iSTIG></STIGS></CHECKLIST>`;
}
