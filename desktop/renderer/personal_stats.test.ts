// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/personal_stats.test.ts - P-KGUI.3. The reported defect was a CUI tile rendered for a
// vault that does not exist, so the first assertion is that it is OMITTED rather than shown as locked. The
// second cluster is the dash-versus-zero rule: a count that has not arrived yet must never render as 0.

import { describe, expect, test } from "bun:test";
import { personalStatTiles, personalStatsHtml, type PersonalStatsInput } from "./personal_stats.ts";

const input = (over: Partial<PersonalStatsInput> = {}): PersonalStatsInput => ({
  counts: { personal: 264, work: 521, cui: 12 },
  cuiConfigured: false,
  cuiUnlocked: false,
  kgs: [],
  kgPages: {},
  ...over,
});

const ids = (i: PersonalStatsInput): string[] => personalStatTiles(i).map((t) => t.id);

describe("personalStatTiles: the CUI rule", () => {
  test("THE DEFECT: no CUI vault means NO CUI tile, not a locked one", () => {
    // The card used to render "- CUI (LOCKED)" for a user who had never created a CUI store, which
    // advertises a locked door where there is no room behind it.
    expect(ids(input({ cuiConfigured: false }))).toEqual(["scope:personal", "scope:work"]);
  });

  test("a vault that EXISTS but is locked does get a tile, because that is real information", () => {
    const t = personalStatTiles(input({ cuiConfigured: true, cuiUnlocked: false }));
    const cui = t.find((x) => x.id === "scope:cui");
    expect(cui).toBeDefined();
    expect(cui?.value).toBe("-");
    expect(cui?.note).toBe("locked");
  });

  test("an unlocked vault shows its real count and carries no qualifier", () => {
    const cui = personalStatTiles(input({ cuiConfigured: true, cuiUnlocked: true })).find((x) => x.id === "scope:cui");
    expect(cui?.value).toBe("12");
    expect(cui?.note).toBeUndefined();
  });
});

describe("personalStatTiles: a dash is not a zero", () => {
  test("a KG whose count has not arrived shows a dash", () => {
    const t = personalStatTiles(input({ kgs: [{ kg_id: "k1", name: "Contested Logistics", read_only: false, active: false }] }));
    expect(t.at(-1)?.value).toBe("-");
  });

  test("a KG that really is empty shows 0, which is a different statement", () => {
    const t = personalStatTiles(input({
      kgs: [{ kg_id: "k1", name: "Fresh", read_only: false, active: false }],
      kgPages: { k1: 0 },
    }));
    expect(t.at(-1)?.value).toBe("0");
  });

  test("a non-finite or non-numeric count degrades to a dash rather than to NaN on screen", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const t = personalStatTiles(input({
        kgs: [{ kg_id: "k1", name: "Broken", read_only: false, active: false }],
        kgPages: { k1: bad },
      }));
      expect(t.at(-1)?.value).toBe("-");
    }
  });

  test("missing compartment counts dash out too, never render as zero facts", () => {
    const t = personalStatTiles(input({ counts: null, cuiConfigured: true, cuiUnlocked: true }));
    expect(t.map((x) => x.value)).toEqual(["-", "-", "-"]);
  });
});

describe("personalStatTiles: many KGs", () => {
  const many = Array.from({ length: 12 }, (_, n) => ({ kg_id: `k${n}`, name: `KG ${n}`, read_only: n % 3 === 0, active: n === 7 }));

  test("the ACTIVE KG leads, so it is visible without scrolling a long strip", () => {
    const t = personalStatTiles(input({ kgs: many }));
    expect(t[2]?.id).toBe("kg:k7"); // straight after personal + work (no CUI vault here)
    expect(t[2]?.note).toBe("active");
  });

  test("the rest keep registry order rather than being reshuffled", () => {
    const rest = personalStatTiles(input({ kgs: many })).filter((t) => t.tone === "kg").slice(1).map((t) => t.id);
    expect(rest).toEqual(["kg:k0", "kg:k1", "kg:k2", "kg:k3", "kg:k4", "kg:k5", "kg:k6", "kg:k8", "kg:k9", "kg:k10", "kg:k11"]);
  });

  test("every tile id is unique and stable, so a repaint cannot duplicate or reorder by accident", () => {
    const got = ids(input({ kgs: many, cuiConfigured: true }));
    expect(new Set(got).size).toBe(got.length);
    expect(got.length).toBe(15); // personal + work + cui + 12 KGs
  });

  test("a read-only pack is marked, unless it is also the active one", () => {
    const t = personalStatTiles(input({ kgs: [
      { kg_id: "ro", name: "Backend Engineer", read_only: true, active: false },
      { kg_id: "act", name: "Mine", read_only: true, active: true },
    ] }));
    expect(t.find((x) => x.id === "kg:ro")?.note).toBe("read only");
    expect(t.find((x) => x.id === "kg:act")?.note).toBe("active"); // active outranks the lock marker
  });

  test("an unnamed KG still gets a readable caption", () => {
    const t = personalStatTiles(input({ kgs: [{ kg_id: "k", name: "   ", read_only: false, active: false }] }));
    expect(t.at(-1)?.label).toBe("Untitled KG");
  });
});

describe("personalStatsHtml", () => {
  test("a user-authored KG name is ESCAPED, never injected as markup", () => {
    const html = personalStatsHtml(personalStatTiles(input({
      kgs: [{ kg_id: "x", name: `<img src=x onerror="alert(1)">`, read_only: false, active: false }],
    })));
    // The property is that nothing PARSES as markup, not that the word "onerror" is absent: escaping
    // neutralizes the brackets and quotes, so the payload survives as inert text, which is correct.
    expect(html).not.toContain("<img");
    expect(html).not.toContain(`onerror="`); // no raw quote, so no attribute can form
    expect(html).toContain("&lt;img");
    expect(html).toContain("&quot;alert(1)&quot;");
  });

  test("a hostile name cannot break out of the title attribute either", () => {
    const html = personalStatsHtml(personalStatTiles(input({
      kgs: [{ kg_id: "x", name: `" onmouseover="steal()`, read_only: false, active: false }],
    })));
    expect(html).not.toContain(`" onmouseover=`);
  });

  test("every tile carries a title, so a name too long for a narrow tile is recoverable (invariant 11)", () => {
    const html = personalStatsHtml(personalStatTiles(input({
      kgs: [{ kg_id: "x", name: "Predictive Logistics for Contested Environments", read_only: true, active: false }],
    })));
    const titles = html.match(/title="/g) ?? [];
    expect(titles).toHaveLength(3); // personal, work, the KG
    expect(html).toContain(`title="Predictive Logistics for Contested Environments (read only)"`);
  });

  test("the tile count is exposed so the layout can be asserted from the served bytes", () => {
    expect(personalStatsHtml(personalStatTiles(input()))).toContain(`data-stat-count="2"`);
  });

  test("no em dash reaches the markup", () => {
    const html = personalStatsHtml(personalStatTiles(input({ cuiConfigured: true, kgs: [{ kg_id: "k", name: "A", read_only: true, active: false }] })));
    expect(html).not.toContain("\u2014");
  });
});
