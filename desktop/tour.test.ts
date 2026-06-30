// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/tour.test.ts — P-ROLE.1/.1b (ADR-0088/0089): the role catalog + first-run walkthrough.
//
// Pure surface only: the step catalog, per-role selection, the coach-card markup, and the
// role-normalisation fold. No DOM, no on-disk settings touched.

import { describe, expect, test } from "bun:test";
import { ROLE_META, TOUR_STEPS, USER_ROLE_LIST, coachHtml, roleDefaultTab, stepsForRole } from "./renderer/tour.ts";
import { normalizeRole, USER_ROLES } from "./settings_store.ts";
import type { UserRole } from "./renderer/bridge.ts";

describe("the four roles are a closed, ordered set", () => {
  test("exactly developer · security · manager · executive", () => {
    expect(USER_ROLE_LIST).toEqual(["developer", "security", "manager", "executive"]);
    // The renderer mirror and the settings_store source agree.
    expect([...USER_ROLES]).toEqual(USER_ROLE_LIST);
  });

  test("every role has display metadata (label, glyph, blurb, landing surface)", () => {
    for (const r of USER_ROLE_LIST) {
      const m = ROLE_META[r];
      expect(m.id).toBe(r);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.icon.length).toBeGreaterThan(0);
      expect(m.lands.length).toBeGreaterThan(0);
      expect(m.blurb.length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeRole folds unknown input to the safe default", () => {
  test("valid roles pass through", () => {
    for (const r of USER_ROLE_LIST) expect(normalizeRole(r)).toBe(r);
  });
  test("unset / unknown / junk → developer (the full-surface default)", () => {
    expect(normalizeRole(undefined)).toBe("developer");
    expect(normalizeRole(null)).toBe("developer");
    expect(normalizeRole("")).toBe("developer");
    expect(normalizeRole("root")).toBe("developer");
    expect(normalizeRole("ADMIN")).toBe("developer");
  });
});

describe("roleDefaultTab — Security analysts land on the queue, everyone else on Memory", () => {
  test("security → security, others → memory", () => {
    expect(roleDefaultTab("security")).toBe("security");
    expect(roleDefaultTab("developer")).toBe("memory");
    expect(roleDefaultTab("manager")).toBe("memory");
    expect(roleDefaultTab("executive")).toBe("memory");
  });
});

describe("stepsForRole is tailored, ordered, and well-formed", () => {
  test("each role's tour opens on the composer and closes on the target-less closer", () => {
    for (const r of USER_ROLE_LIST) {
      const steps = stepsForRole(r);
      expect(steps.length).toBeGreaterThanOrEqual(4);
      expect(steps[0]!.id).toBe("composer");
      expect(steps[steps.length - 1]!.id).toBe("closer");
    }
  });

  test("only the closer is target-less; every other step has a concrete selector", () => {
    for (const r of USER_ROLE_LIST) {
      for (const s of stepsForRole(r)) {
        if (s.id === "closer") expect(s.target).toBe("");
        else expect(s.target.length).toBeGreaterThan(0);
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.body.length).toBeGreaterThan(0);
        expect(s.icon.length).toBeGreaterThan(0);
      }
    }
  });

  test("the role tailoring actually differs (mirrors ADR-0088 foregrounding)", () => {
    const ids = (r: UserRole) => stepsForRole(r).map((s) => s.id);
    // The security analyst tours the queue + audit; the developer does not.
    expect(ids("security")).toContain("security");
    expect(ids("security")).toContain("devlogs");
    expect(ids("developer")).not.toContain("security");
    expect(ids("developer")).not.toContain("devlogs");
    // Manager + exec get the spend/delivery step.
    expect(ids("manager")).toContain("cost");
    expect(ids("executive")).toContain("cost");
    // The developer tours their private graph; the executive's tour is the leanest.
    expect(ids("developer")).toContain("knowledge");
    expect(ids("executive").length).toBeLessThan(ids("developer").length);
  });

  test("every referenced step id resolves in the master catalog", () => {
    for (const r of USER_ROLE_LIST) {
      for (const s of stepsForRole(r)) expect(TOUR_STEPS[s.id]).toBeDefined();
    }
  });
});

describe("coachHtml — the card markup (pure)", () => {
  const steps = stepsForRole("developer");
  const total = steps.length;

  test("shows the title, body, and a 'N / M' step counter", () => {
    const html = coachHtml(steps[1]!, 1, total);
    expect(html).toContain(steps[1]!.title);
    expect(html).toContain(steps[1]!.body);
    expect(html).toContain(`2 / ${total}`);
  });

  test("carries the Back / Next / Skip control hooks", () => {
    const mid = coachHtml(steps[2]!, 2, total);
    expect(mid).toContain("data-coach-back");
    expect(mid).toContain("data-coach-next");
    expect(mid).toContain("data-coach-skip");
  });

  test("no Back on the first step; 'Done' (not 'Next') on the last", () => {
    const first = coachHtml(steps[0]!, 0, total);
    expect(first).not.toContain("data-coach-back");
    expect(first).toContain(">Next<");
    const last = coachHtml(steps[total - 1]!, total - 1, total);
    expect(last).toContain(">Done<");
    expect(last).not.toContain(">Next<");
  });

  test("renders one dot per step with the active one marked", () => {
    const html = coachHtml(steps[1]!, 1, total);
    // `coach-dot` but not the `coach-dots` wrapper — one dot per step.
    expect((html.match(/coach-dot(?!s)/g) ?? []).length).toBe(total);
    expect(html).toContain("coach-dot on");
  });

  test("escapes interpolated copy (no raw injection)", () => {
    const evil = { id: "x", target: "#x", icon: "info", title: 'T<script>"&', body: "B<img>" };
    const html = coachHtml(evil, 0, 1);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img>");
    expect(html).toContain("&lt;script&gt;");
  });
});
