// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/lane_groups.test.ts - P-FLEET.L18: the group model's contract. What a user would
// feel as a bug: a group eating a lane's flat order, an empty group vanishing right after they made
// it, a disband taking the lanes with it, or a corrupt payload taking down the grid.

import { describe, expect, test } from "bun:test";
import { assignLane, createGroup, groupSections, laneCollapsed, loadGroups, pruneLanes, removeGroup, saveGroups, toggleCollapsed } from "./lane_groups.ts";

const seeded = () => {
  let g = loadGroups(null);
  g = createGroup(g, "backend").next;
  g = createGroup(g, "docs").next;
  g = assignLane(g, "a", "backend");
  g = assignLane(g, "c", "backend");
  g = assignLane(g, "d", "docs");
  return g;
};

describe("lane groups", () => {
  test("sections keep flat order within groups; ungrouped trail; empty groups emit nothing", () => {
    expect(groupSections(["a", "b", "c", "d"], seeded())).toEqual([
      { group: "backend", ids: ["a", "c"] },
      { group: "docs", ids: ["d"] },
      { group: null, ids: ["b"] },
    ]);
    expect(groupSections(["x"], createGroup(loadGroups(null), "empty").next)).toEqual([{ group: null, ids: ["x"] }]);
  });
  test("create trims, caps and dedupes; blank creates nothing", () => {
    const g0 = loadGroups(null);
    expect(createGroup(g0, "  api   team ").name).toBe("api team");
    expect(createGroup(g0, "   ").name).toBeNull();
    const once = createGroup(g0, "x").next;
    expect(createGroup(once, "x").next.groups).toEqual(["x"]);
  });
  test("assign to an unknown group is refused; null unassigns", () => {
    const g = seeded();
    expect(assignLane(g, "a", "nope")).toBe(g);
    expect(groupSections(["a"], assignLane(g, "a", null))).toEqual([{ group: null, ids: ["a"] }]);
  });
  test("disband frees the lanes, never removes them", () => {
    const after = removeGroup(seeded(), "backend");
    expect(groupSections(["a", "b", "c", "d"], after)).toEqual([
      { group: "docs", ids: ["d"] },
      { group: null, ids: ["a", "b", "c"] },
    ]);
  });
  test("a dismissed lane leaves its group; the group survives EMPTY for the next lane", () => {
    const after = pruneLanes(seeded(), ["b", "d"]);
    expect(after.groups).toEqual(["backend", "docs"]);
    expect(groupSections(["b", "d"], after)).toEqual([
      { group: "docs", ids: ["d"] },
      { group: null, ids: ["b"] },
    ]);
  });
  test("a collapsed group hides exactly its own lanes, and only while collapsed", () => {
    // The grid's every status repaint derives each card's hidden class from this; a wrong answer is a
    // collapsed group unfolding on the next poll, or an ungrouped lane vanishing.
    const g = toggleCollapsed(seeded(), "backend");
    expect(["a", "b", "c", "d"].filter((id) => laneCollapsed(g, id))).toEqual(["a", "c"]);
    expect(laneCollapsed(toggleCollapsed(g, "backend"), "a")).toBe(false);
    expect(laneCollapsed(removeGroup(g, "backend"), "a")).toBe(false); // disbanded: back in the tail, visible
    // A dangling assignment renders in the ungrouped tail (groupSections), so it must never hide.
    expect(laneCollapsed({ groups: [], byLane: { a: "gone" }, collapsed: { gone: true } }, "a")).toBe(false);
  });
  test("collapse toggles and disband clears it", () => {
    let g = toggleCollapsed(seeded(), "backend");
    expect(g.collapsed["backend"]).toBe(true);
    expect(toggleCollapsed(g, "backend").collapsed["backend"]).toBeUndefined();
    expect(removeGroup(g, "backend").collapsed["backend"]).toBeUndefined();
  });
  test("round-trips through persistence; garbage degrades to no groups", () => {
    const g = seeded();
    expect(loadGroups(saveGroups(g))).toEqual(g);
    expect(loadGroups("not json")).toEqual({ groups: [], byLane: {}, collapsed: {} });
    expect(loadGroups(JSON.stringify({ byLane: { a: "ghost-group" } })).byLane).toEqual({});
  });
});
