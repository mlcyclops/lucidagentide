// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/brief/engineering_update.test.ts - the Executive Engineering Update generator (P-BRIEF.1,
// ADR-0070). Pure parse → structured update → written brief + podcast script + the backend seam.

import { test, expect, describe } from "bun:test";
import {
  parseProgress, parseAdrs, buildEngineeringUpdate, renderEngineeringBrief,
  buildPodcastScript, renderScript, ScriptOnlyBackend, speakable, type EngineeringUpdate,
} from "./engineering_update.ts";

describe("speakable() - TTS-friendly text (P-REPORT.7)", () => {
  test("strips codes, markdown, and code blocks that read badly aloud", () => {
    const t = speakable("**Fixed** `edit.mode` in ADR-0066 / P-EXEC.2 (v1.8.26)");
    expect(t).not.toMatch(/ADR-\d+|P-EXEC|1\.8\.26|`|\*\*/);
    expect(t.toLowerCase()).toContain("fixed");
  });
  test("expands the acronyms that mangle worst + turns symbols into words", () => {
    const t = speakable("Export the POA&M & AAR to the KG at 90% + more");
    expect(t).toContain("plan of action and milestones");
    expect(t).toContain("after-action report");
    expect(t).toContain("knowledge graph");
    expect(t).toContain(" and ");
    expect(t).toContain(" plus ");
    expect(t).toContain(" percent");
  });
  test("drops CCI / control numbers and ends like a sentence", () => {
    const t = speakable("Maps to SC-28 and CCI-002450 at 3.13.11");
    expect(t).not.toMatch(/CCI-\d+|3\.13\.11/);
    expect(t.endsWith(".")).toBe(true);
  });
  test("podcast turns are all run through speakable (no raw codes in audio)", () => {
    const u = buildEngineeringUpdate({ label: "R", progressMd: "---\n**P-EXEC.2 - answer omp**\n- **shipped:** the ADR-0110 fix.\n", decisionsMd: "" });
    const spoken = buildPodcastScript(u, "developer").turns.map((t) => t.text).join(" ");
    expect(spoken).not.toMatch(/ADR-\d+|P-EXEC/);
  });
});

const PROGRESS = `
# Progress

---
**P-EXEC.1 - exec approval**
- **shipped:** the per-action gate for bash/eval, classifier + catastrophic set.
- **stubbed:** ssh + task coverage deferred to P-EXEC.2.
- **next:** wire the loop dial.

---
**P-RAG.1c - PDF ingest**
- **shipped:** unpdf parser behind the scan gate.
- **stubbed:** image OCR not wired.
- **next:** WASM packaging decision.
`;

const DECISIONS = `
## ADR-0066 - P-EXEC.1: exec approval (bash + eval)
**Status:** Accepted - BUILT.
DEPENDS ON nothing.

## ADR-0067 - P-GOAL.13: loop risk dial
**Status:** Proposed - SCOPE/PLAN.
**Increment:** P-GOAL.13. DEPENDS ON ADR-0066's classifier.

## ADR-0065 - WASM finding
**Status:** Proposed - FINDING, decision DEFERRED.
`;

describe("parseProgress", () => {
  test("pulls shipped/stubbed/next per entry", () => {
    const p = parseProgress(PROGRESS);
    expect(p.length).toBe(2);
    expect(p[0]!.title).toContain("P-EXEC.1");
    expect(p[0]!.shipped).toContain("per-action gate");
    expect(p[0]!.stubbed).toContain("ssh + task");
    expect(p[1]!.next).toContain("WASM packaging");
  });
});

describe("parseAdrs", () => {
  test("captures id/title/status and DEPENDS ON", () => {
    const a = parseAdrs(DECISIONS);
    expect(a.map((x) => x.id)).toEqual(["ADR-0066", "ADR-0067", "ADR-0065"]);
    expect(a[1]!.status).toMatch(/SCOPE\/PLAN/);
    expect(a[1]!.dependsOn).toContain("ADR-0066");
  });
});

describe("buildEngineeringUpdate", () => {
  const u: EngineeringUpdate = buildEngineeringUpdate({ label: "test@abc123", progressMd: PROGRESS, decisionsMd: DECISIONS });

  test("recently shipped comes from PROGRESS shipped lines", () => {
    expect(u.recentlyShipped.some((i) => /exec approval|per-action gate/i.test(i.title + (i.detail ?? "")))).toBe(true);
  });
  test("tech debt collects stubbed + deferred/finding ADRs", () => {
    expect(u.techDebt.some((i) => /ssh \+ task|image OCR/i.test(i.detail ?? ""))).toBe(true);
    expect(u.techDebt.some((i) => /ADR-0065/.test(i.title))).toBe(true); // FINDING/deferred
  });
  test("upcoming decisions include open (Proposed/SCOPE/DEFERRED) ADRs and PROGRESS next", () => {
    expect(u.upcomingDecisions.some((i) => /ADR-0067/.test(i.title))).toBe(true);
    expect(u.upcomingDecisions.some((i) => /ADR-0065/.test(i.title))).toBe(true);
    expect(u.upcomingDecisions.some((i) => /^Next:/.test(i.title))).toBe(true);
    // a BUILT/Accepted ADR is NOT an open decision
    expect(u.upcomingDecisions.some((i) => /ADR-0066/.test(i.title))).toBe(false);
  });
  test("load-bearing dependencies surface the DEPENDS ON edges", () => {
    expect(u.loadBearingDependencies.some((i) => /ADR-0067 depends on ADR-0066/.test(i.title))).toBe(true);
  });
  test("folds an AAR into risks", () => {
    const withAar = buildEngineeringUpdate({
      label: "x", progressMd: PROGRESS, decisionsMd: DECISIONS,
      aar: { outcome: "stopped", outcomeReason: "stalled", iterations: 3, toolCalls: { shell: 4 }, loc: null, errors: [{ iter: 2, detail: "boom" }] },
    });
    expect(withAar.risks.some((r) => /error/i.test(r.title))).toBe(true);
    expect(withAar.risks.some((r) => /stopped/i.test(r.title))).toBe(true);
  });
});

describe("render + podcast seam", () => {
  const u = buildEngineeringUpdate({ label: "demo", progressMd: PROGRESS, decisionsMd: DECISIONS });

  test("the written brief has the three exec sections", () => {
    const md = renderEngineeringBrief(u);
    expect(md).toContain("# Engineering Update - demo"); // default (no role); role variants add a "<Role> " prefix (ADR-0116)
    expect(md).toContain("## Load-bearing dependencies");
    expect(md).toContain("## Tech debt");
    expect(md).toContain("## Upcoming decisions");
  });

  test("the podcast script is a two-host dialogue", () => {
    const s = buildPodcastScript(u);
    const speakers = new Set(s.turns.map((t) => t.speaker));
    expect(speakers.size).toBe(2);
    expect(s.turns.length).toBeGreaterThan(3);
    expect(renderScript(s)).toContain("**Host:**");
  });

  test("ScriptOnlyBackend returns the script with no audio (never hard-fails)", async () => {
    const r = await new ScriptOnlyBackend().synthesize(buildPodcastScript(u));
    expect(r.backendId).toBe("script-only");
    expect(r.audioPath).toBeUndefined();
    expect(r.script.turns.length).toBeGreaterThan(0);
  });
});

// P-REPORT.1 (ADR-0116): per-role tailoring ACTUALLY changes content - filter, section selection, and
// whether ADR/increment codes + source tags appear (only Developer keeps them).
describe("role-tailored brief (ADR-0116)", () => {
  const u: EngineeringUpdate = {
    label: "Repo",
    recentlyShipped: [{ title: "P-NETWL.5 - egress posture toggles", source: "ADR-0108" }, { title: "P-CHAT.1 - inline code preview", source: "PROGRESS.md" }],
    loadBearingDependencies: [{ title: "ADR-0110 - the exec gate", detail: "security gate", source: "ADR-0110" }],
    techDebt: [{ title: "P-RAG.1b - real WASM embedder", source: "PROGRESS.md" }],
    upcomingDecisions: [{ title: "P-KEYS.3 - credential vault rotation", detail: "auth secrets", source: "ADR-0106" }, { title: "P-BRIEF.4 - podcast audio", source: "ADR-0113" }],
    risks: [{ title: "Egress not approved for a foreign TLD", source: "AAR" }],
  };
  const sections = (md: string) => [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]);

  test("default (no role) shows all 5 sections WITH source tags", () => {
    const md = renderEngineeringBrief(u);
    expect(md).toContain("# Engineering Update - Repo");
    expect(md).not.toContain("view -");
    expect(sections(md).length).toBe(5);
    expect(md).toContain("_(ADR-0110)_"); // sources shown by default
  });
  test("DEVELOPER keeps ADR/source tags + codes and all 5 sections", () => {
    const md = renderEngineeringBrief(u, "developer");
    expect(md).toContain("# Developer Engineering Update - Repo");
    expect(sections(md).length).toBe(5);
    expect(md).toContain("_(ADR-0108)_");            // source tags kept
    expect(md).toContain("P-NETWL.5 - egress");       // increment code kept
  });
  test("EXECUTIVE drops tech-debt + dependencies, has NO ADR IDs or codes, and is capped", () => {
    const md = renderEngineeringBrief(u, "executive");
    const s = sections(md);
    expect(s).toContain("Recently shipped");
    expect(s).not.toContain("Tech debt");                 // dropped
    expect(s).not.toContain("Load-bearing dependencies");  // dropped
    expect(md).not.toMatch(/_\(ADR-\d+\)_/);               // no source tags
    expect(md).not.toMatch(/\bADR-\d+\b/);                 // no ADR IDs anywhere
    expect(md).not.toContain("P-NETWL");                   // increment codes stripped
    expect(md).toContain("Egress posture toggles");        // stripped title, sentence-cased
  });
  test("MANAGER drops tech-debt + dependencies and hides ADRs", () => {
    const s = sections(renderEngineeringBrief(u, "manager"));
    expect(s).toEqual(["Recently shipped", "Upcoming decisions", "Risks"]);
    expect(renderEngineeringBrief(u, "manager")).not.toMatch(/\bADR-\d+\b/);
  });
  test("SECURITY filters to security-relevant items only, no ADR IDs", () => {
    const md = renderEngineeringBrief(u, "security");
    expect(md).toContain("# Security Engineering Update - Repo");
    expect(md).not.toMatch(/\bADR-\d+\b/);
    // security items surface (gate / credential-vault / egress); the non-security "inline code preview" does not
    expect(md).toContain("The exec gate");
    expect(md).toContain("Credential vault rotation");
    expect(md).not.toContain("inline code preview");
  });
  test("podcast is role-tailored: title, framing, and no codes for non-dev", () => {
    const dev = buildPodcastScript(u, "developer");
    expect(dev.title).toBe("Developer Engineering Update - Repo");
    expect(dev.turns[0]!.text).toContain("Developer");
    const exec = renderScript(buildPodcastScript(u, "executive"));
    expect(exec).not.toMatch(/\bADR-\d+\b/);
    expect(exec).not.toContain("P-NETWL");
  });
});
