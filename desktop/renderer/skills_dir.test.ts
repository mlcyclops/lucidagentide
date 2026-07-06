// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/skills_dir.test.ts — P-SKILL.4 (ADR-0097): the PURE directory + inspect builders.
// Over-tests the security-visible contract: a flagged row's enable toggle is LOCKED (no toggle button),
// destructive/re-scan actions only appear where allowed, and ALL skill-supplied text (name/description/
// body) is HTML-escaped (a skill is untrusted data, never markup — invariant #5).

import { describe, expect, test } from "bun:test";
import { renderSkillInspect, renderSkillsDirectory, renderStudioCandidate, type SkillDirRow } from "./skills_dir.ts";
import type { SkillInspectView } from "./bridge.ts";

const row = (over: Partial<SkillDirRow> = {}): SkillDirRow => ({
  key: "project:x", name: "x", description: "d", root: "project", trust: "untrusted",
  invocation: "/skill:x", removable: true, enabled: true, enableable: true, fileBacked: true, scanned: null, ...over,
});

describe("renderSkillsDirectory — grouping + counts", () => {
  test("groups by source root and shows an enabled-of-total note", () => {
    const html = renderSkillsDirectory([
      row({ key: "bundled:a", name: "a", root: "bundled", trust: "trusted", fileBacked: false, removable: false }),
      row({ key: "project:b", name: "b", root: "project" }),
      row({ key: "agents:c", name: "c", root: "agents", trust: "trusted", removable: false, enabled: false }),
    ]);
    expect(html).toContain("Built-in");
    expect(html).toContain("Project");
    expect(html).toContain("Curated");
    expect(html).toContain("<b>2</b> of <b>3</b> enabled"); // c is disabled
  });
  test("empty input still renders the note + an empty marker", () => {
    const html = renderSkillsDirectory([]);
    expect(html).toContain("No skills discovered.");
  });
});

describe("renderSkillsDirectory — per-row actions gate on trust/root/backing", () => {
  test("an enableable row has a toggle; inspect is always present", () => {
    const html = renderSkillsDirectory([row({ enabled: true })]);
    expect(html).toContain('data-skill-act="toggle"');
    expect(html).toContain('data-skill-act="inspect"');
    expect(html).toContain(">On<");
  });
  test("a FLAGGED (non-enableable) row shows a LOCKED pill, never a toggle", () => {
    const html = renderSkillsDirectory([row({ trust: "suspicious", enableable: false, enabled: false })]);
    expect(html).not.toContain('data-skill-act="toggle"');
    expect(html).toContain("skdir-locked");
    expect(html).toContain("skdir-trust suspicious");
    expect(html).toContain("skdir-row disabled"); // rendered dimmed
  });
  test("re-scan appears only for file-backed skills; remove only for removable roots", () => {
    const bundled = renderSkillsDirectory([row({ key: "bundled:a", root: "bundled", trust: "trusted", fileBacked: false, removable: false })]);
    expect(bundled).not.toContain('data-skill-act="rescan"');
    expect(bundled).not.toContain('data-skill-act="remove"');
    const project = renderSkillsDirectory([row({ fileBacked: true, removable: true })]);
    expect(project).toContain('data-skill-act="rescan"');
    expect(project).toContain('data-skill-act="remove"');
    const agents = renderSkillsDirectory([row({ key: "agents:c", root: "agents", trust: "trusted", fileBacked: true, removable: false })]);
    expect(agents).toContain('data-skill-act="rescan"'); // discovered ⇒ re-scannable
    expect(agents).not.toContain('data-skill-act="remove"'); // but immutable ⇒ not removable
  });
});

describe("renderSkillsDirectory — hostile skill text is escaped (data, not markup)", () => {
  test("a <script> in the name/description never survives as a tag", () => {
    const html = renderSkillsDirectory([row({ name: "<script>alert(1)</script>", description: "<img src=x onerror=alert(2)>" })]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderSkillInspect — body framed + escaped as data", () => {
  test("shows the 'data, never instructions' banner and escapes the body", () => {
    const v: SkillInspectView = { ok: true, name: "x", root: "project", trust: "untrusted", body: "<img src=x onerror=alert(1)>", resources: [] };
    const html = renderSkillInspect(v);
    expect(html).toContain("shown as <b>data</b>");
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&lt;img");
    expect(html).toContain("No bundled resources.");
  });
  test("a flagged skill shows the locked note; a clean one does not", () => {
    const flagged = renderSkillInspect({ ok: true, name: "x", root: "project", trust: "quarantined", body: "", resources: [] });
    expect(flagged).toContain("skdir-locknote");
    const clean = renderSkillInspect({ ok: true, name: "x", root: "bundled", trust: "trusted", body: "hello", resources: [] });
    expect(clean).not.toContain("skdir-locknote");
  });
  test("a failed inspect renders a soft message, never throws", () => {
    const html = renderSkillInspect({ ok: false, name: "x", reason: "not found" });
    expect(html).toContain("Could not inspect");
    expect(html).toContain("not found");
  });
});

describe("renderStudioCandidate — P-SKILL.5 candidate card escapes untrusted model output", () => {
  test("shows an editable body textarea + a Codify button, name/desc carried in escaped attrs", () => {
    const html = renderStudioCandidate({ name: "auth-triage", description: "triage auth failures", body: "# steps\n1. check", rationale: "recurring" });
    expect(html).toContain('data-sk-codify');
    expect(html).toContain('data-cand-name="auth-triage"');
    expect(html).toContain('<textarea class="sk-cand-body"');
    expect(html).toContain("triage auth failures");
  });
  test("a hostile name/description/body is escaped (model output is DATA, not markup)", () => {
    const html = renderStudioCandidate({ name: "x", description: '"><img src=x onerror=alert(1)>', body: "<script>alert(2)</script>" });
    expect(html).not.toContain("<img src=x onerror");
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;"); // the quote that would break out of the attribute is escaped
  });
});
