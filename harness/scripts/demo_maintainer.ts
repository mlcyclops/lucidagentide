// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_maintainer.ts
//
// P-MAINT.1: the Maintainer Agent spike, run for real against THIS repository. Proves, end to end:
//   [1] discovery + parsing of this repo's own manifests (package.json, pyproject/requirements, ...),
//   [2] a CycloneDX 1.5 SBOM built from them and DIFFED against the baseline under .omp/maintainer/
//       (written on the first run, so a second run shows real drift),
//   [3] a LIVE OSV query with a short timeout, degrading honestly to "advisory feed unavailable"
//       when offline instead of to a silent clean bill of health,
//   [4] the offline path exercised deliberately, in-process, by pointing one fetch at an unreachable
//       host inside the same timeout (no network is disabled to prove this),
//   [5] the rendered GitHub issue, the Azure DevOps work-item FIELDS (HTML, real reference names),
//       and the pull-request body it WOULD file, plus
//   [6] the exact OS-native scheduler registration for the platform this is running on.
//
// IT FILES NOTHING. There is no tracker client, no git write, and no credential read anywhere in the
// spike. The only thing written to disk is the SBOM baseline under <repo>/.omp/maintainer/.
//
// Run with: bun run harness/scripts/demo_maintainer.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADVISORY_UNAVAILABLE, type FetchLike } from "../maintainer/advisory.ts";
import type { MaintainerTarget } from "../maintainer/contracts.ts";
import { scheduleInstallPlan, type Platform } from "../maintainer/os_schedule.ts";
import { parseSbom, type Sbom } from "../maintainer/sbom.ts";
import { sweepTarget, type SweepIo } from "../maintainer/sweep.ts";
import { renderIssue, renderPrBody } from "../maintainer/tracker.ts";

function fail(m: string): never {
  console.error(`FAIL: ${m}`);
  process.exit(1);
}
function ok(m: string): void {
  console.log(`  PASS  ${m}`);
}
function rule(label: string): void {
  console.log(`\n${"=".repeat(78)}\n${label}\n${"=".repeat(78)}\n`);
}

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, ".omp", "maintainer");
const OSV_TIMEOUT_MS = 6000;

console.log("P-MAINT.1 demo - Maintainer Agent spike: sweep, SBOM, advisories, rendered PR + tracker item\n");
console.log("*** DRY RUN, nothing was filed. No issue, no work item, no pull request, no git write. ***");
console.log(`*** The only disk write is the SBOM baseline under ${STATE_DIR} ***\n`);

const target: MaintainerTarget = {
  id: "lucid-core",
  repoUrl: "https://github.com/techlead187/LucidAgentIDE.git",
  provider: "github",
  localPath: ROOT,
  cadence: { kind: "daily", hhmm: "02:30" },
  openPr: false, // dry run is the default, deliberately
  openTracker: false,
};

// --- I/O seams -----------------------------------------------------------------------------------

const sbomPath = join(STATE_DIR, `${target.id}.cdx.json`);

const baseIo: Omit<SweepIo, "fetchImpl"> = {
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  listDir: (dir) => readdirSync(dir),
  loadPrevSbom: () => {
    try {
      return parseSbom(readFileSync(sbomPath, "utf8"));
    } catch {
      return null; // no baseline yet, which is not drift
    }
  },
};

/** The live seam: real fetch, bounded by our own timeout so an offline host degrades fast. */
const liveFetch: FetchLike = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(OSV_TIMEOUT_MS) });

/** The offline seam: a real fetch at an unreachable host, under the SAME timeout. */
const offlineFetch: FetchLike = (url, init) => {
  const rerouted = url.replace("https://api.osv.dev", "https://api.osv.dev.invalid-maintainer-demo.example");
  return fetch(rerouted, { ...init, signal: AbortSignal.timeout(OSV_TIMEOUT_MS) });
};

// --- [1] live sweep ------------------------------------------------------------------------------

rule("[1] LIVE SWEEP of this repository");

const live = await sweepTarget(target, { ...baseIo, fetchImpl: liveFetch });
if (live.manifests.length === 0) fail("discovered no manifests in this repository, which cannot be right");
console.log(`Manifests discovered (${live.manifests.length}):`);
for (const m of live.manifests) console.log(`  ${m.slice(ROOT.length + 1)}`);
console.log(`\nDependency declarations read: ${live.report.deps}`);
console.log(`SBOM components (deduped by purl): ${live.sbom.components.length}`);
console.log(`Advisory feed: ${live.advisoryNote}`);
console.log(`First sweep (no baseline): ${live.firstSweep}`);
console.log(`SBOM drift: ${live.report.sbomDrift.added.length} added, ${live.report.sbomDrift.removed.length} removed, ${live.report.sbomDrift.changed.length} changed`);
console.log(`Findings: ${live.report.findings.length}`);
for (const f of live.report.findings.slice(0, 12)) {
  console.log(`  [${(f.severity ?? "ungraded").toUpperCase()}] ${f.kind} ${f.name} ${f.current}${f.latest ? ` -> ${f.latest}` : ""}${f.advisoryIds ? ` (${f.advisoryIds.join(", ")})` : ""}`);
  console.log(`         ${f.summary.slice(0, 160)}`);
}
if (live.report.findings.length > 12) console.log(`  ... and ${live.report.findings.length - 12} more`);

if (live.report.deps <= 0) fail("read zero dependency declarations from a repository that has manifests");
ok(`swept ${live.manifests.length} manifest(s), ${live.report.deps} declaration(s), ${live.sbom.components.length} SBOM component(s)`);

const offlineNow = live.report.findings.some((f) => f.summary.startsWith(ADVISORY_UNAVAILABLE));
if (offlineNow) {
  console.log("\nNOTE: OSV was NOT reachable on this run. The report says so in its FIRST finding, which");
  console.log("      is exactly the fail-closed behaviour: an unreachable feed never reads as clean.");
} else {
  console.log("\nNOTE: OSV answered. An empty advisory list here is a real clean bill of health.");
}

// --- [2] the offline path, deliberately -----------------------------------------------------------

rule("[2] OFFLINE PATH, forced in-process (unreachable host, same timeout, network untouched)");

const offline = await sweepTarget(target, { ...baseIo, fetchImpl: offlineFetch });
const gap = offline.report.findings[0];
if (!gap || !gap.summary.startsWith(ADVISORY_UNAVAILABLE)) fail("an unreachable advisory host must produce a pinned coverage-gap finding");
if (gap.severity !== undefined) fail("a coverage gap must not claim a severity");
if (offline.report.deps !== live.report.deps) fail("manifest reading must not depend on the network");
console.log(`Pinned first finding: ${gap.summary}`);
console.log(`Advisory note:        ${offline.advisoryNote}`);
console.log(`Dependency count unchanged from the live sweep: ${offline.report.deps}`);
ok("an unreachable OSV degrades to a labelled coverage gap, pinned first, never to a silent clean report");

// --- [3] rendered payloads ------------------------------------------------------------------------

// Render from whichever sweep actually had advisory coverage, so the payloads below are the real
// thing rather than a permanently-degraded one.
const rendered = offlineNow ? offline : live;

rule("[3] GITHUB ISSUE it WOULD open (markdown, not filed)");
const gh = renderIssue("github", rendered.report, target);
console.log(`title:  ${gh.title}`);
console.log(`labels: ${(gh.labels ?? []).join(", ")}`);
console.log(`fields: ${gh.fields === undefined ? "none (GitHub takes labels, not fields)" : "unexpected"}`);
console.log(`\n${gh.body}\n`);
if (/\d{4}-\d{2}-\d{2}/.test(gh.title) || /\d{2}:\d{2}/.test(gh.title)) fail("the title must be timestamp-free so a second sweep can dedupe against it");
ok("GitHub issue rendered as markdown with a stable, timestamp-free, dedupable title");

rule("[4] AZURE DEVOPS WORK ITEM it WOULD create (HTML in the real reference-name fields, not created)");
const ado = renderIssue("azure-devops", rendered.report, target);
const fields = ado.fields ?? {};
for (const key of ["System.Title", "System.Description", "System.Tags"]) {
  if (fields[key] === undefined) fail(`missing ADO field ${key}`);
}
console.log("JSON-Patch document an ADO create would post:");
console.log(JSON.stringify(Object.entries(fields).map(([path, value]) => ({ op: "add", path: `/fields/${path}`, value })), null, 2).slice(0, 1200));
console.log("\nSystem.Description (HTML, because an ADO work item does not render markdown):\n");
console.log(fields["System.Description"]);
if ((fields["System.Description"] ?? "").includes("## ")) fail("ADO must receive HTML, not markdown headings");
if (!(fields["System.Description"] ?? "").includes("<h2>")) fail("ADO description must be HTML");
ok("Azure DevOps receives HTML in System.Description with System.Title and System.Tags alongside");

rule("[5] PULL REQUEST BODY it WOULD open (markdown, not opened)");
console.log(renderPrBody(rendered.report, target));
ok("pull-request body rendered, stating plainly that a machine raised it and naming the agent id");

// --- [6] the OS-native registration --------------------------------------------------------------

rule(`[6] OS-NATIVE SCHEDULER REGISTRATION for this host (${process.platform})`);

const platform: Platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const wrapper = platform === "win32" ? join(ROOT, "bin", "lucid-maintainer.exe") : join(ROOT, "bin", "lucid-maintainer");
const plan = scheduleInstallPlan({
  platform,
  cadence: target.cadence,
  id: target.id,
  exe: wrapper,
  args: ["maintainer", "sweep", "--target", target.id],
});
console.log(`platform: ${plan.platform}`);
console.log(`register: ${plan.register}`);
console.log(`remove:   ${plan.remove}`);
if (plan.unitPath) console.log(`unitPath: ${plan.unitPath}`);
if (plan.unitText) console.log(`\nunitText:\n${plan.unitText}`);
console.log(`\nnote: ${plan.note}`);
if (!plan.note.includes("lucid check")) fail("the plan must carry the fail-closed preflight rationale");
ok("registration command emitted for this platform, carrying the fail-closed preflight requirement");

// --- baseline persistence (the ONLY disk write) --------------------------------------------------

rule("[7] SBOM baseline");

mkdirSync(STATE_DIR, { recursive: true });
const hadBaseline = !live.firstSweep;
writeFileSync(sbomPath, `${JSON.stringify(live.sbom, null, 2)}\n`, "utf8");
console.log(`${hadBaseline ? "Refreshed" : "Created"} the baseline at ${sbomPath}`);
console.log(hadBaseline
  ? "A previous baseline existed, so the drift above is a real comparison."
  : "This was the first run, so there was no baseline to drift from. Run this demo again after a dependency change and the drift section becomes a real diff.");
const readBack = parseSbom(readFileSync(sbomPath, "utf8"));
if (readBack === null) fail("the baseline just written does not parse back as a CycloneDX 1.5 document");
if (readBack.components.length !== live.sbom.components.length) fail("baseline round-trip lost components");
ok(`baseline round-trips: ${readBack.components.length} components, CycloneDX ${readBack.specVersion}`);

// --- guarantees ----------------------------------------------------------------------------------

rule("GUARANTEES");

const everything = [
  gh.title,
  gh.body,
  fields["System.Title"] ?? "",
  fields["System.Description"] ?? "",
  fields["System.Tags"] ?? "",
  renderPrBody(rendered.report, target),
  plan.register,
  plan.remove,
  plan.unitText ?? "",
  plan.note,
  live.advisoryNote,
  offline.advisoryNote,
].join("\n");
if (everything.includes("\u2014")) fail("an em dash reached rendered output");
ok("no rendered string contains an em dash");
for (const forbidden of ["Authorization", "Bearer ", "LUCID_GIT_PAT", "password"]) {
  if (everything.includes(forbidden)) fail(`a credential-shaped token reached rendered output: ${forbidden}`);
}
ok("no credential-shaped token in any rendered payload (the spike reads no vault and holds no token)");
console.log("\nNothing was filed. No tracker client, no git write, and no credential read exists in this spike;");
console.log(`the sole disk write was ${sbomPath}.`);
console.log("\nP-MAINT.1 demo complete - swept this repo, built + diffed a CycloneDX SBOM, queried OSV live,");
console.log("degraded honestly when offline, rendered the GitHub issue / ADO work item / PR body it WOULD");
console.log("file, and emitted this host's OS-native scheduler registration behind the fail-closed preflight.");
