// harness/brief/engineering_update.test.ts — the Executive Engineering Update generator (P-BRIEF.1,
// ADR-0070). Pure parse → structured update → written brief + podcast script + the backend seam.

import { test, expect, describe } from "bun:test";
import {
  parseProgress, parseAdrs, buildEngineeringUpdate, renderEngineeringBrief,
  buildPodcastScript, renderScript, ScriptOnlyBackend, type EngineeringUpdate,
} from "./engineering_update.ts";

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
    expect(md).toContain("# Executive Engineering Update — demo");
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
