// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/rolepack.test.ts - P-TRAINER.8: the role-agnostic pack generator is pure + deterministic,
// so the trainer can extract ANY role. These pin the slug, PD parsing, dedupe/caps, and objective shape.

import { describe, expect, it } from "bun:test";
import { buildRolePack, extractTasksFromPd, slugRole } from "./rolepack.ts";

describe("slugRole", () => {
  it("namespaces + slugifies a role name", () => {
    expect(slugRole("Wire Ops Analyst")).toBe("role-wire-ops-analyst");
    expect(slugRole("  ER Charge Nurse!! ")).toBe("role-er-charge-nurse");
  });
  it("falls back when nothing usable remains", () => {
    expect(slugRole("!!!")).toBe("role-custom");
  });
});

describe("extractTasksFromPd", () => {
  it("prefers bulleted duties, strips markers + trailing punctuation, dedupes", () => {
    const pd = `Responsibilities:\n- Triage incoming patients by acuity.\n* Coordinate bed assignments with charge.\n1) Escalate critical labs to the physician.\n- Triage incoming patients by acuity.`;
    const tasks = extractTasksFromPd(pd);
    expect(tasks).toEqual([
      "Triage incoming patients by acuity",
      "Coordinate bed assignments with charge",
      "Escalate critical labs to the physician",
    ]);
  });
  it("drops too-short and too-long lines", () => {
    const pd = `- ok\n- ${"x".repeat(200)}\n- Reconcile the daily cash drawer to the ledger`;
    expect(extractTasksFromPd(pd)).toEqual(["Reconcile the daily cash drawer to the ledger"]);
  });
  it("falls back to plain lines when there are few bullets", () => {
    const pd = "Handle escalations from tier-1 support\nOwn the weekly release checklist";
    expect(extractTasksFromPd(pd)).toEqual(["Handle escalations from tier-1 support", "Own the weekly release checklist"]);
  });
});

describe("buildRolePack", () => {
  it("makes one objective per duty, namespaced ids, scenario-first elicitation", () => {
    const pack = buildRolePack({ role: "Charge Nurse", tasks: ["Triage incoming patients by acuity"] });
    expect(pack).toHaveLength(1);
    const o = pack[0]!;
    expect(o.packId).toBe("role-charge-nurse");
    expect(o.objectiveId).toBe("role-charge-nurse-1");
    expect(o.title).toBe("Triage incoming patients by acuity");
    expect(o.elicitation.scenarios[0]).toContain("Walk me through");
    expect(o.elicitation.edgeProbes[0]).toContain("went wrong");
    expect(o.weight).toBeGreaterThan(0);
  });
  it("merges explicit tasks + PD duties, dedupes, and caps at 14", () => {
    const tasks = Array.from({ length: 20 }, (_, i) => `Duty number ${i} that is long enough`);
    const pack = buildRolePack({ role: "Ops", tasks, pdText: "- Duty number 0 that is long enough\n- A brand new PD-only duty here" });
    expect(pack.length).toBe(14); // capped
    const ids = new Set(pack.map((o) => o.objectiveId));
    expect(ids.size).toBe(pack.length); // ids unique
  });
  it("returns [] when no usable duty is present", () => {
    expect(buildRolePack({ role: "Ops", tasks: [], pdText: "hi" })).toEqual([]);
  });
});
