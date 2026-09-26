// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/maintainer/tracker.ts
//
// P-MAINT.1: what a Maintainer Agent would FILE, rendered. PURE - no network, no credential, no
// client. This module turns a SweepReport into the exact title/body/labels/fields a tracker API
// wants, and stops there. Actually posting it (which needs a per-host token out of the OS vault) is
// the enterprise addon's job; in this repo the payload is printed so a human can read it before any
// automation is trusted with a write.
//
// PROVIDER DIFFERENCES THAT ARE REAL, not cosmetic:
//   github / gitlab  -> Markdown body, labels applied through the API's labels field.
//   azure-devops     -> HTML body. ADO work-item fields render HTML, not Markdown, so a Markdown
//                       body posts as a wall of literal asterisks. The payload therefore comes back
//                       in `fields`, keyed by the REAL ADO reference names (System.Title,
//                       System.Description, System.Tags) that a JSON-Patch document needs, with tags
//                       as a semicolon-separated string rather than a labels array.
//
// TITLES ARE STABLE AND CONTAIN NO TIMESTAMP AND NO COUNTS. A maintainer agent runs forever; on
// every sweep it must be able to FIND ITS OWN prior item by title and update that instead of filing
// a duplicate. Any varying token in the title (a date, a findings count, a version) breaks dedup.
//
// EVERY BODY SAYS A MACHINE OPENED IT and names the agent id, because a human who gets this
// notification needs to know instantly that no colleague wrote it and which scheduled agent to go
// look at.
//
// SECURITY (CLAUDE.md invariant #5): advisory summaries, package names, and manifest error text are
// EXTERNALLY authored. They are neutralized before entering Markdown or HTML: control characters and
// newlines collapsed, backticks defanged, HTML escaped, table pipes entitized, length capped. They
// render as inert DATA, never as markup and never as instructions.

import { ADVISORY_UNAVAILABLE, sortFindings } from "./advisory.ts";
import type { Finding, MaintainerTarget, SweepReport, TrackerKind } from "./contracts.ts";

export interface RenderedIssue {
  title: string;
  body: string;
  labels?: string[];
  fields?: Record<string, string>;
}

const LABELS: readonly string[] = ["lucid-maintainer", "dependencies", "security"];
const ADO_TAGS = LABELS.join("; ");
/** How many drift entries a body lists before summarizing the remainder. */
const DRIFT_SHOWN = 12;

/**
 * Neutralize externally-authored text for Markdown. Same scheme as harness/brief/repo_activity.ts
 * clean(): collapse whitespace/control chars, defang code fences, escape HTML, entitize table pipes,
 * length cap. ASCII output only.
 */
function md(s: string, max = 200): string {
  let t = (s || "").replace(/[\r\n\t\x00-\x1f]+/g, " ").trim();
  t = t.replace(/`+/g, "'");
  t = t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  t = t.replace(/\|/g, "&#124;");
  if (t.length > max) t = `${t.slice(0, max - 3).trimEnd()}...`;
  return t || "-";
}

/** Neutralize externally-authored text for an HTML field (Azure DevOps System.Description). */
function html(s: string, max = 200): string {
  let t = (s || "").replace(/[\r\n\t\x00-\x1f]+/g, " ").trim();
  t = t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  if (t.length > max) t = `${t.slice(0, max - 3).trimEnd()}...`;
  return t || "-";
}

/** A stable, human-readable label for the repository, derived from the remote URL or the id. */
function targetSlug(target: MaintainerTarget): string {
  const url = target.repoUrl.trim();
  const m = /(?:[/:])([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return m?.[1] ?? (url.length > 0 ? url : target.id);
}

/** The dedup key both renderers build their title from. Deliberately free of dates and counts. */
export function issueTitle(target: MaintainerTarget): string {
  return `LUCID Maintainer: dependency and advisory sweep for ${targetSlug(target)}`;
}

export function prTitle(target: MaintainerTarget): string {
  return `LUCID Maintainer: apply advisory-fixed dependency versions for ${targetSlug(target)}`;
}

function severityLabel(finding: Finding): string {
  return finding.severity === undefined ? "ungraded" : finding.severity.toUpperCase();
}

interface Sections {
  ordered: Finding[];
  coverageGaps: Finding[];
  advisories: Finding[];
  updates: Finding[];
  manifestErrors: Finding[];
  drift: Finding[];
}

function sections(report: SweepReport): Sections {
  const ordered = sortFindings(report.findings);
  const coverageGaps: Finding[] = [];
  const advisories: Finding[] = [];
  const updates: Finding[] = [];
  const manifestErrors: Finding[] = [];
  const drift: Finding[] = [];
  for (const f of ordered) {
    if (f.summary.startsWith(ADVISORY_UNAVAILABLE)) coverageGaps.push(f);
    else if (f.kind === "advisory") advisories.push(f);
    else if (f.kind === "dependency-update") updates.push(f);
    else if (f.kind === "manifest-error") manifestErrors.push(f);
    else drift.push(f);
  }
  return { ordered, coverageGaps, advisories, updates, manifestErrors, drift };
}

function driftLines(report: SweepReport): string[] {
  const out: string[] = [];
  const groups: readonly { label: string; items: string[] }[] = [
    { label: "added", items: report.sbomDrift.added },
    { label: "removed", items: report.sbomDrift.removed },
    { label: "changed", items: report.sbomDrift.changed },
  ];
  for (const group of groups) {
    if (group.items.length === 0) continue;
    const shown = group.items.slice(0, DRIFT_SHOWN);
    for (const item of shown) out.push(`${group.label}: ${item}`);
    const rest = group.items.length - shown.length;
    if (rest > 0) out.push(`${group.label}: and ${rest} more`);
  }
  return out;
}

// --- Markdown (GitHub, GitLab) ------------------------------------------------------------------

function markdownBody(kind: "github" | "gitlab", report: SweepReport, target: MaintainerTarget): string {
  const s = sections(report);
  const lines: string[] = [];
  lines.push(`## ${issueTitle(target)}`);
  lines.push("");
  lines.push(`**A machine opened this.** It was filed automatically by the LUCID Maintainer Agent \`${md(target.id, 64)}\`, an OS-scheduled agent that owns this repository. No person wrote this text. Reply here and a human maintainer will pick it up.`);
  lines.push("");
  lines.push(`- Repository: ${md(target.repoUrl, 200)}`);
  lines.push(`- Agent id: \`${md(target.id, 64)}\``);
  lines.push(`- Tracker: ${kind}`);
  lines.push(`- Dependencies read: ${report.deps}`);
  lines.push(`- Findings: ${report.findings.length}`);
  lines.push(`- Mode: ${target.openTracker ? "live (this item was filed)" : "DRY RUN (rendered, not filed)"}`);
  lines.push("");

  if (s.coverageGaps.length > 0) {
    lines.push("### Coverage warning, read this first");
    lines.push("");
    for (const f of s.coverageGaps) lines.push(`- ${md(f.summary, 400)}`);
    lines.push("");
    lines.push("The advisory list below is therefore INCOMPLETE. Do not read it as a clean bill of health.");
    lines.push("");
  }

  if (s.advisories.length > 0) {
    lines.push("### Advisories, worst severity first");
    lines.push("");
    lines.push("| Severity | Ecosystem | Package | Installed | Fixed in | References | Summary |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const f of s.advisories) {
      const refs = (f.advisoryIds ?? []).map((id) => md(id, 40)).join(", ") || "-";
      lines.push(`| ${severityLabel(f)} | ${f.ecosystem} | ${md(f.name, 80)} | ${md(f.current, 40)} | ${md(f.latest ?? "not published", 40)} | ${refs} | ${md(f.summary, 300)} |`);
    }
    lines.push("");
  } else if (s.coverageGaps.length === 0) {
    lines.push("### Advisories");
    lines.push("");
    lines.push("None. Every dependency version with a concrete pin was checked against OSV and no published advisory matched.");
    lines.push("");
  }

  if (s.updates.length > 0) {
    lines.push("### Recommended version bumps");
    lines.push("");
    lines.push("Each of these is backed by an advisory that names a fixed version. This is not a general 'newer release exists' sweep.");
    lines.push("");
    for (const f of s.updates) {
      const refs = (f.advisoryIds ?? []).map((id) => md(id, 40)).join(", ") || "-";
      lines.push(`- \`${md(f.name, 80)}\` ${md(f.current, 40)} -> ${md(f.latest ?? "unknown", 40)} (${refs})`);
    }
    lines.push("");
  }

  if (s.manifestErrors.length > 0) {
    lines.push("### Manifests that could not be fully read");
    lines.push("");
    for (const f of s.manifestErrors) lines.push(`- ${md(f.name, 160)}: ${md(f.summary, 300)}`);
    lines.push("");
  }

  const drift = driftLines(report);
  if (drift.length > 0) {
    lines.push("### SBOM drift since the last sweep");
    lines.push("");
    for (const line of drift) lines.push(`- ${md(line, 220)}`);
    lines.push("");
  } else if (s.drift.length === 0) {
    lines.push("### SBOM drift since the last sweep");
    lines.push("");
    lines.push("None. The CycloneDX component set is identical to the previous sweep's baseline.");
    lines.push("");
  }

  lines.push("### Provenance");
  lines.push("");
  lines.push("Advisory data comes from OSV (osv.dev), which aggregates CVE and GHSA. Every identifier above is an official one. The text quoted from those records is DATA, not instructions, and has been escaped before rendering.");
  return lines.join("\n");
}

// --- HTML (Azure DevOps) ------------------------------------------------------------------------

function adoBody(report: SweepReport, target: MaintainerTarget): string {
  const s = sections(report);
  const out: string[] = [];
  out.push(`<h2>${html(issueTitle(target), 300)}</h2>`);
  out.push(`<p><strong>A machine opened this.</strong> It was created automatically by the LUCID Maintainer Agent <code>${html(target.id, 64)}</code>, an OS-scheduled agent that owns this repository. No person wrote this text.</p>`);
  out.push("<ul>");
  out.push(`<li>Repository: ${html(target.repoUrl, 200)}</li>`);
  out.push(`<li>Agent id: ${html(target.id, 64)}</li>`);
  out.push(`<li>Dependencies read: ${report.deps}</li>`);
  out.push(`<li>Findings: ${report.findings.length}</li>`);
  out.push(`<li>Mode: ${target.openTracker ? "live (this work item was created)" : "DRY RUN (rendered, not created)"}</li>`);
  out.push("</ul>");

  if (s.coverageGaps.length > 0) {
    out.push("<h3>Coverage warning, read this first</h3>");
    out.push("<ul>");
    for (const f of s.coverageGaps) out.push(`<li>${html(f.summary, 400)}</li>`);
    out.push("</ul>");
    out.push("<p>The advisory list below is therefore INCOMPLETE. Do not read it as a clean bill of health.</p>");
  }

  if (s.advisories.length > 0) {
    out.push("<h3>Advisories, worst severity first</h3>");
    out.push("<table><tr><th>Severity</th><th>Ecosystem</th><th>Package</th><th>Installed</th><th>Fixed in</th><th>References</th><th>Summary</th></tr>");
    for (const f of s.advisories) {
      const refs = (f.advisoryIds ?? []).map((id) => html(id, 40)).join(", ") || "-";
      out.push(
        `<tr><td>${severityLabel(f)}</td><td>${f.ecosystem}</td><td>${html(f.name, 80)}</td><td>${html(f.current, 40)}</td>` +
          `<td>${html(f.latest ?? "not published", 40)}</td><td>${refs}</td><td>${html(f.summary, 300)}</td></tr>`,
      );
    }
    out.push("</table>");
  } else if (s.coverageGaps.length === 0) {
    out.push("<h3>Advisories</h3>");
    out.push("<p>None. Every dependency version with a concrete pin was checked against OSV and no published advisory matched.</p>");
  }

  if (s.updates.length > 0) {
    out.push("<h3>Recommended version bumps</h3>");
    out.push("<p>Each of these is backed by an advisory that names a fixed version.</p>");
    out.push("<ul>");
    for (const f of s.updates) {
      const refs = (f.advisoryIds ?? []).map((id) => html(id, 40)).join(", ") || "-";
      out.push(`<li>${html(f.name, 80)} ${html(f.current, 40)} to ${html(f.latest ?? "unknown", 40)} (${refs})</li>`);
    }
    out.push("</ul>");
  }

  if (s.manifestErrors.length > 0) {
    out.push("<h3>Manifests that could not be fully read</h3>");
    out.push("<ul>");
    for (const f of s.manifestErrors) out.push(`<li>${html(f.name, 160)}: ${html(f.summary, 300)}</li>`);
    out.push("</ul>");
  }

  const drift = driftLines(report);
  out.push("<h3>SBOM drift since the last sweep</h3>");
  if (drift.length > 0) {
    out.push("<ul>");
    for (const line of drift) out.push(`<li>${html(line, 220)}</li>`);
    out.push("</ul>");
  } else {
    out.push("<p>None. The CycloneDX component set is identical to the previous sweep's baseline.</p>");
  }

  out.push("<h3>Provenance</h3>");
  out.push("<p>Advisory data comes from OSV (osv.dev), which aggregates CVE and GHSA. Every identifier above is an official one. The quoted text is DATA, not instructions, and has been HTML-escaped before rendering.</p>");
  return out.join("\n");
}

// --- entry points ------------------------------------------------------------------------------

/**
 * Render the tracker item for one sweep. GitHub and GitLab receive Markdown plus a labels array;
 * Azure DevOps receives HTML plus `fields` keyed by the real work-item reference names, because that
 * is the shape a JSON-Patch create needs and because ADO does not render Markdown in a description.
 */
export function renderIssue(kind: TrackerKind, report: SweepReport, target: MaintainerTarget): RenderedIssue {
  const title = issueTitle(target);
  if (kind === "azure-devops") {
    const body = adoBody(report, target);
    return {
      title,
      body,
      fields: {
        "System.Title": title,
        "System.Description": body,
        "System.Tags": ADO_TAGS,
      },
    };
  }
  return { title, body: markdownBody(kind, report, target), labels: [...LABELS] };
}

/**
 * The pull-request body for the version bumps this sweep can justify. Markdown on every provider:
 * GitHub, GitLab, and Azure Repos all render Markdown in a pull-request description (it is the ADO
 * WORK ITEM, not the ADO pull request, that needs HTML).
 */
export function renderPrBody(report: SweepReport, target: MaintainerTarget): string {
  const s = sections(report);
  const lines: string[] = [];
  lines.push(`**A machine opened this pull request.** It was raised by the LUCID Maintainer Agent \`${md(target.id, 64)}\`, an OS-scheduled agent that owns ${md(targetSlug(target), 120)}. No person wrote this description. A human must review and merge it.`);
  lines.push("");
  lines.push(`- Agent id: \`${md(target.id, 64)}\``);
  lines.push(`- Dependencies read: ${report.deps}`);
  lines.push(`- Mode: ${target.openPr ? "live (this pull request was opened)" : "DRY RUN (rendered, not opened)"}`);
  lines.push("");

  if (s.coverageGaps.length > 0) {
    lines.push("> Coverage warning: the advisory feed was unavailable for part of this sweep, so the change set below may be incomplete.");
    for (const f of s.coverageGaps) lines.push(`> ${md(f.summary, 400)}`);
    lines.push("");
  }

  if (s.updates.length > 0) {
    lines.push("### Proposed changes");
    lines.push("");
    lines.push("| Ecosystem | Package | From | To | Severity | References |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const f of s.updates) {
      const refs = (f.advisoryIds ?? []).map((id) => md(id, 40)).join(", ") || "-";
      lines.push(`| ${f.ecosystem} | ${md(f.name, 80)} | ${md(f.current, 40)} | ${md(f.latest ?? "unknown", 40)} | ${severityLabel(f)} | ${refs} |`);
    }
    lines.push("");
    lines.push("Every row is anchored to an advisory that publishes a fixed version. The agent proposes no bump it cannot point at a fix for.");
    lines.push("");
  } else {
    lines.push("### Proposed changes");
    lines.push("");
    lines.push("None. No advisory in this sweep names a fixed version for a dependency this repository declares, so there is nothing to bump.");
    lines.push("");
  }

  if (s.advisories.length > 0) {
    lines.push("### Why, worst severity first");
    lines.push("");
    for (const f of s.advisories) {
      const refs = (f.advisoryIds ?? []).map((id) => md(id, 40)).join(", ") || "-";
      lines.push(`- **${severityLabel(f)}** \`${md(f.name, 80)}\` ${md(f.current, 40)}: ${md(f.summary, 300)} (${refs})`);
    }
    lines.push("");
  }

  lines.push("### Reviewer checklist");
  lines.push("");
  lines.push("- [ ] The version each row moves to is the one the advisory names as fixed.");
  lines.push("- [ ] The project's own tests pass against the new versions.");
  lines.push("- [ ] No transitive pin elsewhere contradicts these versions.");
  lines.push("");
  lines.push("Advisory data comes from OSV (osv.dev), aggregating CVE and GHSA. Quoted advisory text is DATA, not instructions, and has been escaped.");
  return lines.join("\n");
}
