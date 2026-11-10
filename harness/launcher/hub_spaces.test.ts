// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.3 (ADR-0436) + P-TUI.5 (ADR-0433): the spaces model is the control plane's addressing
// contract. An id an agent holds must never silently point at a different pane or tab, the hub must
// never reach zero spaces, a space zero tabs or a tab zero panes, and a saved layout must restore
// exactly or not at all (a v1 file migrates one way; a v2 file never reads as v1).

import { describe, expect, test } from "bun:test";
import { dividerAt, HubOpError, Spaces, layoutOf, leaves, neighborPane, ratioForCells, splitBoxes } from "./hub_spaces.ts";
import { paneRects } from "./hub_tui.ts";

const isDeck = (d: string) => ["overview", "security", "fleet"].includes(d);
const code = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof HubOpError ? e.code : String(e); } return "no error"; };

describe("spaces", () => {
  test("ids climb and are never reused, even after closes", () => {
    const h = new Spaces();
    expect(h.list().map((s) => s.id)).toEqual(["s1"]);
    const p2 = h.split("s1:p1", "right");
    expect(p2.id).toBe("s1:p2");
    h.closePane("s1:p2");
    expect(h.split("s1:p1", "down").id).toBe("s1:p3");
    const s2 = h.create("work");
    h.close(s2.id);
    expect(h.create().id).toBe("s3");
  });

  test("the last space and a space's last pane refuse to close", () => {
    const h = new Spaces();
    expect(code(() => h.close("s1"))).toBe("last_space");
    expect(code(() => h.closePane("s1:p1"))).toBe("last_pane");
    h.create("two");
    h.close("s1");
    expect(h.active).toBe("s2");
  });

  test("closing a pane before the focused one keeps focus on the same pane", () => {
    const h = new Spaces();
    h.split("s1:p1", "right");
    h.split("s1:p2", "right");
    h.focusPane("s1:p3");
    h.closePane("s1:p1");
    expect(h.pane().leaf.id).toBe("s1:p3");
  });

  test("rebind and swap keep ids with their panes; swap stays inside one space", () => {
    const h = new Spaces();
    h.split(undefined, "right");
    h.rebind("s1:p2", "agent", { id: "lane-1", name: "alpha" });
    h.swap("s1:p1", "s1:p2");
    expect(layoutOf(h.tab.tree)).toBe("[s1:p2 | s1:p1]");
    expect(leaves(h.tab.tree)[0]).toEqual({ kind: "leaf", id: "s1:p2", deck: "agent", lane: "lane-1", laneName: "alpha" });
    h.create();
    expect(code(() => h.swap("s1:p1", "s2:p1"))).toBe("cross_space");
    expect(code(() => h.rebind("s1:p1", "agent"))).toBe("usage");
  });

  test("resize moves the nearest split of the matching orientation, clamped", () => {
    const h = new Spaces();
    h.split("s1:p1", "right");
    h.split("s1:p2", "down");
    expect(h.resize("s1:p3", "L", 20)).toBe(0.3);
    expect(h.resize("s1:p3", "D", 70)).toBe(0.9);
    expect(code(() => new Spaces().resize(undefined, "L", 5))).toBe("no_split");
  });

  test("names are validated; refs resolve by id or name", () => {
    const h = new Spaces();
    expect(code(() => h.rename(undefined, "bad\nname"))).toBe("bad_name");
    h.create("work");
    expect(h.focus("main").id).toBe("s1");
    expect(code(() => h.pane("s9:p1"))).toBe("not_found");
  });
});

describe("tabs", () => {
  test("tab ids climb per space; pane ids stay space-scoped across tabs and are never reused", () => {
    const h = new Spaces();
    expect(h.tab.id).toBe("s1:t1");
    const t2 = h.createTab(undefined, "build");
    expect([t2.id, leaves(t2.tree)[0]!.id]).toEqual(["s1:t2", "s1:p2"]);
    expect(h.tab.id).toBe("s1:t2"); // a new tab is the one on screen
    expect(h.split(undefined, "right").id).toBe("s1:p3");
    h.closeTab("s1:t2");
    expect(h.createTab().id).toBe("s1:t3");
    expect(leaves(h.tab.tree)[0]!.id).toBe("s1:p4");
    expect(h.paneList({ space: "s1" }).map((p) => `${p.tab}/${p.id}`)).toEqual(["s1:t1/s1:p1", "s1:t3/s1:p4"]);
  });

  test("the last tab of a space refuses to close; closing the active tab lands on its neighbor", () => {
    const h = new Spaces();
    expect(code(() => h.closeTab())).toBe("last_tab");
    h.createTab(); h.createTab();
    h.focusTab("s1:t2");
    h.closeTab("s1:t2");
    expect(h.tab.id).toBe("s1:t3");
  });

  test("focusing a tab or a pane in another space switches space and tab together", () => {
    const h = new Spaces();
    h.createTab(undefined, "logs");
    h.create("work");
    expect(h.focusTab("s1:t2").name).toBe("logs");
    expect(h.active).toBe("s1");
    h.focusPane("s1:p1");
    expect([h.active, h.tab.id]).toEqual(["s1", "s1:t1"]);
    expect(h.findTab("logs").tab.id).toBe("s1:t2"); // names resolve in the active space
    expect(code(() => h.findTab("s2:t9"))).toBe("not_found");
  });

  test("swap and rename stay inside their tab; tab names are validated", () => {
    const h = new Spaces();
    h.createTab();
    expect(code(() => h.swap("s1:p1", "s1:p2"))).toBe("cross_tab");
    expect(code(() => h.renameTab(undefined, "\u0007"))).toBe("bad_name");
    expect(h.renameTab("s1:t1", "edit").name).toBe("edit");
  });
});

describe("persistence", () => {
  test("round-trips tabs, layout, focus, ratios, counters and the rail", () => {
    const h = new Spaces();
    h.split("s1:p1", "right");
    h.resize("s1:p2", "L", 10);
    h.createTab(undefined, "logs");
    h.create("work");
    h.focus("s1");
    h.setRail(false);
    const back = Spaces.restore(JSON.stringify(h), isDeck)!;
    expect(JSON.parse(JSON.stringify(back))).toEqual(JSON.parse(JSON.stringify(h)));
    expect(back.split("s1:p1", "down").id).toBe("s1:p4");
    expect(back.createTab("s1").id).toBe("s1:t3");
    expect(back.create().id).toBe("s3");
    expect(back.rail).toBe(false);
  });

  test("a v1 file migrates one way: each space's tree becomes tab t1, every pane id kept", () => {
    const v1 = {
      v: 1, active: "s2", nextSpace: 3, spaces: [
        { id: "s1", name: "main", tree: { kind: "split", dir: "v", ratio: 0.6, a: { kind: "leaf", id: "s1:p1", deck: "overview" }, b: { kind: "leaf", id: "s1:p3", deck: "fleet" } }, focus: 1, zoom: true, nextPane: 4 },
        { id: "s2", name: "ops", tree: { kind: "leaf", id: "s2:p1", deck: "agent", lane: "lane-9", laneName: "nine" }, focus: 0, zoom: false, nextPane: 2 },
      ],
    };
    const h = Spaces.restore(JSON.stringify(v1), isDeck)!;
    expect(h.tabList().map((t) => `${t.id}:${t.name}:${t.layout}:${t.zoom}`)).toEqual(["s1:t1:t1:[s1:p1 | s1:p3]:true", "s2:t1:t1:s2:p1:false"]);
    expect([h.active, h.pane().leaf.id, h.pane("s1:p3").tab.id]).toEqual(["s2", "s2:p1", "s1:t1"]);
    expect(h.split("s1:p1", "down").id).toBe("s1:p4"); // the v1 counter carries over: no re-mint
    expect(h.createTab("s1").id).toBe("s1:t2");
    expect(JSON.parse(JSON.stringify(h)).v).toBe(2);
  });

  test("the version field decides the reading: a v2 file never loads as v1, nor the reverse", () => {
    const v2 = JSON.parse(JSON.stringify(new Spaces()));
    expect(Spaces.restore(JSON.stringify({ ...v2, v: 1 }), isDeck)).toBeNull();
    const v1 = { v: 1, active: "s1", nextSpace: 2, spaces: [{ id: "s1", name: "main", tree: { kind: "leaf", id: "s1:p1", deck: "overview" }, focus: 0, zoom: false, nextPane: 2 }] };
    expect(Spaces.restore(JSON.stringify(v1), isDeck)).not.toBeNull();
    expect(Spaces.restore(JSON.stringify({ ...v1, v: 2 }), isDeck)).toBeNull();
    expect(Spaces.restore(JSON.stringify({ ...v2, v: 3 }), isDeck)).toBeNull();
  });

  test("anything off-shape restores as null, never a guess", () => {
    const good = JSON.parse(JSON.stringify(new Spaces()));
    expect(Spaces.restore("{", isDeck)).toBeNull();
    expect(Spaces.restore(JSON.stringify({ ...good, spaces: [] }), isDeck)).toBeNull();
    const badDeck = structuredClone(good); badDeck.spaces[0].tabs[0].tree.deck = "nope";
    expect(Spaces.restore(JSON.stringify(badDeck), isDeck)).toBeNull();
    const reuse = structuredClone(good); reuse.spaces[0].nextPane = 1; // would re-mint s1:p1
    expect(Spaces.restore(JSON.stringify(reuse), isDeck)).toBeNull();
    const reuseTab = structuredClone(good); reuseTab.spaces[0].nextTab = 1; // would re-mint s1:t1
    expect(Spaces.restore(JSON.stringify(reuseTab), isDeck)).toBeNull();
    const wrongSpace = structuredClone(good); wrongSpace.spaces[0].tabs[0].tree.id = "s2:p1";
    expect(Spaces.restore(JSON.stringify(wrongSpace), isDeck)).toBeNull();
    const noTabs = structuredClone(good); noTabs.spaces[0].tabs = [];
    expect(Spaces.restore(JSON.stringify(noTabs), isDeck)).toBeNull();
  });
});

// P-HERD.2 / P-HERD.3 (ADR-0491, ADR-0492): the model ops the Herd add-on drives. The classic hub
// never calls them; they must still keep every id rule above.
describe("pane move and rename (Herd)", () => {
  /** s1:t1 = [p1 | p2], s1:t2 = [p3]. */
  const twoTabs = () => {
    const h = new Spaces();
    h.split("s1:p1", "right");
    h.createTab();
    return h;
  };

  test("a move to a new tab keeps the pane id, focuses it there, and the source tab closes the gap", () => {
    const h = twoTabs();
    const r = h.movePane("s1:p2", { newTab: true, name: "solo" });
    expect(r.pane.id).toBe("s1:p2");
    expect(r.from).toBe("s1:p2");
    expect(r.tab).toMatchObject({ id: "s1:t3", name: "solo" });
    expect(h.tab.id).toBe("s1:t3");
    expect(layoutOf(h.findTab("s1:t1").tab.tree)).toBe("s1:p1");
    expect(h.paneList().find((p) => p.id === "s1:p2")).toMatchObject({ tab: "s1:t3", focused: true });
  });

  test("a move into another tab splits off that tab's focused pane, id kept", () => {
    const h = twoTabs();
    h.movePane("s1:p2", { tab: "s1:t2", split: "down" });
    expect(layoutOf(h.findTab("s1:t2").tab.tree)).toBe("[s1:p3 / s1:p2]");
    expect(h.findTab("s1:t2").tab.focus).toBe(1);
    expect(h.split("s1:p1", "right").id).toBe("s1:p4"); // the counter never went back
  });

  test("into another space the pane gets a fresh id there; the old id is never reused", () => {
    const h = twoTabs();
    h.create("work"); // s2 with s2:p1
    const r = h.movePane("s1:p2", { tab: "s2:t1", split: "right" });
    expect(r).toMatchObject({ from: "s1:p2" });
    expect(r.pane.id).toBe("s2:p2");
    expect(code(() => h.pane("s1:p2"))).toBe("not_found");
    expect(Spaces.restore(JSON.stringify(h), isDeck)).not.toBeNull(); // still a valid layout
  });

  test("a tab's last pane, the same tab and a bad name refuse, changing nothing", () => {
    const h = twoTabs();
    const before = JSON.stringify(h);
    expect(code(() => h.movePane("s1:p3", { newTab: true }))).toBe("last_pane");
    expect(code(() => h.movePane("s1:p2", { tab: "s1:t1", split: "right" }))).toBe("same_tab");
    expect(code(() => h.movePane("s1:p2", { newTab: true, name: "bad\u0007name" }))).toBe("bad_name");
    expect(JSON.stringify(h)).toBe(before);
  });

  test("a pane name shows in pane list, survives a rebind and a restore, and --clear drops it", () => {
    const h = twoTabs();
    h.renamePane("s1:p1", "  build log ");
    h.rebind("s1:p1", "security");
    expect(h.paneList().find((p) => p.id === "s1:p1")).toMatchObject({ label: "build log", deck: "security" });
    expect(h.split("s1:p1", "down").label).toBeUndefined(); // a split copy starts unnamed
    const back = Spaces.restore(JSON.stringify(h), isDeck)!;
    expect(back.pane("s1:p1").leaf.label).toBe("build log");
    back.renamePane("s1:p1", null);
    expect(back.pane("s1:p1").leaf.label).toBeUndefined();
    expect(code(() => h.renamePane("s1:p1", "x".repeat(41)))).toBe("bad_name");
  });
});

describe("directional resolution and cell resize (Herd)", () => {
  /** Three agent columns and a stacked utility column, as the columns-3 preset lays them out. */
  const columns = () => {
    const h = new Spaces();
    h.applyTree(undefined, {
      kind: "split", dir: "v", ratio: 0.25, a: { kind: "leaf", deck: "overview" },
      b: { kind: "split", dir: "v", ratio: 0.3333, a: { kind: "leaf", deck: "overview" },
        b: { kind: "split", dir: "v", ratio: 0.5, a: { kind: "leaf", deck: "overview" },
          b: { kind: "split", dir: "h", ratio: 0.5, a: { kind: "leaf", deck: "security" }, b: { kind: "leaf", deck: "fleet" } } } },
    });
    return h;
  };

  test("neighbors come from the rendered rects: left and right walk the columns, up and down the stack", () => {
    const h = columns();
    const boxes = paneRects(h.tab.tree, 100, 30);
    expect(neighborPane(boxes, 0, "right")).toBe(1);
    expect(neighborPane(boxes, 1, "right")).toBe(2);
    expect(neighborPane(boxes, 0, "left")).toBeNull(); // no wrap at the edge
    expect(neighborPane(boxes, 3, "down")).toBe(4); // Security over Fleet
    expect(neighborPane(boxes, 4, "up")).toBe(3);
    expect(neighborPane(boxes, 4, "left")).toBe(2); // the stack's left neighbor is the third column
    expect(neighborPane(boxes, 3, "up")).toBeNull();
  });

  test("a cell resize moves the divider by exactly that many cells under the renderer's arithmetic", () => {
    const h = new Spaces();
    h.split("s1:p1", "right");
    for (const w of [80, 97, 120, 203]) {
      const start = Math.floor(w * (h.tab.tree.kind === "split" ? (h.tab.tree.ratio ?? 0.5) : 0.5));
      const r = h.resizeCells("s1:p1", "R", 1, w, 30);
      expect(r).toMatchObject({ cells: start + 1, size: w });
      expect(paneRects(h.tab.tree, w, 30)[1]!.x).toBe(start + 1); // what the screen shows
      h.resizeCells("s1:p1", "L", 1, w, 30);
      expect(paneRects(h.tab.tree, w, 30)[1]!.x).toBe(start);
    }
    expect(code(() => h.resizeCells("s1:p1", "U", 1, 80, 30))).toBe("no_split");
  });

  test("the divider clamps so neither side drops below 10%", () => {
    for (const size of [7, 10, 33, 100, 2000]) {
      for (const cells of [-5, 0, 1, size / 2, size - 1, size + 5]) {
        const at = Math.floor(size * ratioForCells(cells, size));
        expect(at).toBeGreaterThanOrEqual(Math.ceil(size * 0.1) - (size < 10 ? 1 : 0));
        expect(at).toBeLessThanOrEqual(Math.floor(size * 0.9));
      }
      expect(Math.floor(size * ratioForCells(Math.floor(size / 2), size))).toBe(Math.floor(size / 2));
    }
  });

  test("a press on a divider names its split; the innermost wins where two cross; pane interiors miss", () => {
    const h = columns();
    const outer = splitBoxes(h.tab.tree, 100, 30)[0]!;
    expect(dividerAt(h.tab.tree, 100, 30, outer.at, 10)?.path).toBe("");
    expect(dividerAt(h.tab.tree, 100, 30, outer.at - 1, 10)?.path).toBe("");
    expect(dividerAt(h.tab.tree, 100, 30, 5, 10)).toBeNull();
    const stack = splitBoxes(h.tab.tree, 100, 30).find((s) => s.dir === "h")!;
    expect(dividerAt(h.tab.tree, 100, 30, stack.x + 3, stack.y + stack.at)?.path).toBe(stack.path);
    const moved = h.setSplitCells(undefined, stack.path, stack.at + 4, 100, 30);
    expect(moved.cells).toBe(stack.at + 4);
  });
});

describe("layout templates and slots (Herd)", () => {
  test("applyTree mints fresh ids and retires the old ones; waiting agent panes persist and restore", () => {
    const h = new Spaces();
    h.split("s1:p1", "right");
    const tab = h.applyTree(undefined, { kind: "split", dir: "v", ratio: 0.5, a: { kind: "leaf", deck: "agent", slot: { by: "priority", index: 1 } }, b: { kind: "leaf", deck: "agent", slot: { by: "name", pattern: "web-*" } } });
    expect(leaves(tab.tree).map((l) => l.id)).toEqual(["s1:p3", "s1:p4"]);
    expect(h.paneList()[1]).toMatchObject({ deck: "agent", slot: { by: "name", pattern: "web-*" } });
    const back = Spaces.restore(JSON.stringify(h), isDeck)!;
    expect(back.paneList().map((p) => p.slot)).toEqual([{ by: "priority", index: 1 }, { by: "name", pattern: "web-*" }]);
    back.rebind("s1:p4", "agent", { id: "lane_9", name: "web-a" });
    expect(back.pane("s1:p4").leaf.slot).toBeUndefined(); // a filled pane is an ordinary agent pane
  });

  test("an agent template leaf without a slot, or a deck leaf with one, refuses", () => {
    const h = new Spaces();
    expect(code(() => h.applyTree(undefined, { kind: "leaf", deck: "agent" }))).toBe("usage");
    expect(code(() => h.applyTree(undefined, { kind: "leaf", deck: "overview", slot: { by: "priority", index: 1 } }))).toBe("usage");
    expect(layoutOf(h.tab.tree)).toBe("s1:p1");
  });

  test("restore refuses a slot that is off-shape, on a deck pane, or beside a lane", () => {
    const good = JSON.parse(JSON.stringify(new Spaces()));
    const withLeaf = (leaf: Record<string, unknown>) => {
      const x = structuredClone(good);
      x.spaces[0].tabs[0].tree = { kind: "leaf", id: "s1:p1", ...leaf };
      return JSON.stringify(x);
    };
    expect(Spaces.restore(withLeaf({ deck: "agent", slot: { by: "priority", index: 2 } }), isDeck)).not.toBeNull();
    expect(Spaces.restore(withLeaf({ deck: "agent", slot: { by: "priority", index: 0 } }), isDeck)).toBeNull();
    expect(Spaces.restore(withLeaf({ deck: "agent", slot: { by: "name", pattern: "x", cwd: "/" } }), isDeck)).toBeNull();
    expect(Spaces.restore(withLeaf({ deck: "overview", slot: { by: "main" } }), isDeck)).toBeNull();
    expect(Spaces.restore(withLeaf({ deck: "agent", lane: "l1", slot: { by: "main" } }), isDeck)).toBeNull();
    expect(Spaces.restore(withLeaf({ deck: "overview", label: "\u001b[31mred" }), isDeck)).toBeNull();
  });
});
