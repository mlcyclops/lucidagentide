// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.6: the palette's pure keystones. The scorer's ORDERING is the product (a fuzzy finder that
// ranks wrong is worse than a substring filter), so the rank rules are pinned case by case:
// subsequence or null, consecutive-run length first, then word-boundary hits, then the shorter
// target, stable on full ties. Row building is pinned as the fused list contract: spaces, each
// space's tabs as "space › tab", agents with the LaneStatus verbatim in the hint, then the decks.

import { describe, expect, test } from "bun:test";
import { buildPaletteItems, compareScore, filterPalette, fuzzyScore } from "./hub_palette.ts";
import { Spaces } from "./hub_spaces.ts";
import { DECKS } from "./hub_tui.ts";

describe("fuzzyScore", () => {
  test("a query that is not a subsequence is null, never a low score", () => {
    expect(fuzzyScore("zz", "fleet")).toBeNull();
    expect(fuzzyScore("fleets", "fleet")).toBeNull(); // longer than the target
    expect(fuzzyScore("tf", "fleet")).toBeNull(); // right chars, wrong order
  });

  test("case-insensitive: query and target case never change the score", () => {
    expect(fuzzyScore("SEC", "security")).toEqual(fuzzyScore("sec", "SECURITY"));
    expect(fuzzyScore("sec", "Security")).toEqual({ run: 3, bounds: 1, len: 8 });
  });

  test("the empty query matches everything with run 0 (the open palette lists all)", () => {
    expect(fuzzyScore("", "anything")).toEqual({ run: 0, bounds: 0, len: 8 });
  });

  test("the alignment is chosen by best run, not greedy first-match", () => {
    // Greedy left-to-right would take a@0 then b@3 (run 1); the scorer must find a@2,b@3 (run 2).
    expect(fuzzyScore("ab", "axab")!.run).toBe(2);
  });

  test("word-boundary hits count matched chars at a start or after a non-alphanumeric", () => {
    // w@0 and t after the space: two boundary hits, runs of 1.
    expect(fuzzyScore("wt", "web tools")).toEqual({ run: 1, bounds: 2, len: 9 });
    // w@0 is a boundary, t mid-word is not.
    expect(fuzzyScore("wt", "white")).toEqual({ run: 1, bounds: 1, len: 5 });
  });

  test("ordering: longer consecutive run beats more boundary hits", () => {
    const run2 = fuzzyScore("ht", "light")!; // h,t adjacent: run 2, no boundaries
    const bounds2 = fuzzyScore("ht", "hub tab")!; // h@0, t after space: run 1, bounds 2
    expect(run2.run).toBe(2);
    expect(bounds2.bounds).toBe(2);
    expect(compareScore(run2, bounds2)).toBeLessThan(0);
  });

  test("ordering: equal runs fall to boundary hits, equal everything to the shorter target", () => {
    const boundary = fuzzyScore("se", "space two")!; // s@0, e... run vs "Sessions"
    const midword = fuzzyScore("se", "assent")!; // s,e adjacent mid-word: run 2 wins instead
    expect(compareScore(midword, boundary)).toBeLessThan(0); // run 2 > run 1 first
    const short = fuzzyScore("fleet", "Fleet")!;
    const long = fuzzyScore("fleet", "Fleet extras")!;
    expect(short.run).toBe(long.run);
    expect(short.bounds).toBe(long.bounds);
    expect(compareScore(short, long)).toBeLessThan(0); // shorter target first
  });
});

describe("filterPalette", () => {
  const item = (label: string, id = label) => ({ kind: "deck" as const, id, label, hint: "deck", icon: "◆" });

  test("ranks by the scorer and drops non-matches", () => {
    const out = filterPalette([item("s-e-c tools"), item("Security"), item("Fleet")], "sec");
    expect(out.map((x) => x.label)).toEqual(["Security", "s-e-c tools"]); // run 3 first; Fleet gone
  });

  test("full ties keep source order (stable)", () => {
    const out = filterPalette([item("alpha", "a"), item("alphb", "b")], "alph");
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });

  test("the empty query returns every item in source order", () => {
    const items = [item("b"), item("a")];
    expect(filterPalette(items, "")).toEqual(items);
  });
});

describe("buildPaletteItems", () => {
  const spaces = new Spaces();
  spaces.rename("s1", "work");
  spaces.renameTab("s1:t1", "main");
  spaces.createTab("s1", "logs");
  const ops = spaces.create("ops");
  const lanes = [
    { id: "lane-1", name: "api", status: "working" },
    { id: "lane-2", name: "web", status: "needs-approval" },
    { name: "ghost" }, // no id: never a row (Enter would have nothing to act on)
  ];
  const items = buildPaletteItems(spaces, lanes);

  test("one fused list: spaces, their tabs as space › tab, agents, then every deck", () => {
    expect(items.map((x) => `${x.kind}:${x.label}`)).toEqual([
      "space:work", "tab:work › main", "tab:work › logs",
      `space:${ops.name}`, `tab:${ops.name} › ${ops.tabs[0]!.name}`,
      "agent:api", "agent:web",
      ...DECKS.map((d) => `deck:${d.title}`),
    ]);
  });

  test("rows carry what Enter needs: real ids, the LaneStatus verbatim in the agent hint", () => {
    const web = items.find((x) => x.kind === "agent" && x.label === "web")!;
    expect(web.id).toBe("lane-2");
    expect(web.hint).toBe("agent · needs-approval");
    const tab = items.find((x) => x.label === "work › logs")!;
    expect(tab.id).toMatch(/^s1:t\d+$/);
    const deck = items.find((x) => x.kind === "deck" && x.label === "Security")!;
    expect(deck.id).toBe("security");
  });
});
