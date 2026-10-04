// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.3 (ADR-0431): the spaces model is the control plane's addressing contract. An id an agent
// holds must never silently point at a different pane, the hub must never reach zero spaces or a
// space zero panes, and a saved layout must restore exactly or not at all.

import { describe, expect, test } from "bun:test";
import { HubOpError, Spaces, layoutOf, leaves } from "./hub_spaces.ts";

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
    expect(layoutOf(h.current.tree)).toBe("[s1:p2 | s1:p1]");
    expect(leaves(h.current.tree)[0]).toEqual({ kind: "leaf", id: "s1:p2", deck: "agent", lane: "lane-1", laneName: "alpha" });
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

describe("persistence", () => {
  test("round-trips layout, focus, ratios and counters", () => {
    const h = new Spaces();
    h.split("s1:p1", "right");
    h.resize("s1:p2", "L", 10);
    h.create("work");
    h.focus("s1");
    const back = Spaces.restore(JSON.stringify(h), isDeck)!;
    expect(JSON.parse(JSON.stringify(back))).toEqual(JSON.parse(JSON.stringify(h)));
    expect(back.split("s1:p1", "down").id).toBe("s1:p3");
    expect(back.create().id).toBe("s3");
  });

  test("anything off-shape restores as null, never a guess", () => {
    const good = JSON.parse(JSON.stringify(new Spaces()));
    expect(Spaces.restore("{", isDeck)).toBeNull();
    expect(Spaces.restore(JSON.stringify({ ...good, spaces: [] }), isDeck)).toBeNull();
    const badDeck = structuredClone(good); badDeck.spaces[0].tree.deck = "nope";
    expect(Spaces.restore(JSON.stringify(badDeck), isDeck)).toBeNull();
    const reuse = structuredClone(good); reuse.spaces[0].nextPane = 1; // would re-mint s1:p1
    expect(Spaces.restore(JSON.stringify(reuse), isDeck)).toBeNull();
    const wrongSpace = structuredClone(good); wrongSpace.spaces[0].tree.id = "s2:p1";
    expect(Spaces.restore(JSON.stringify(wrongSpace), isDeck)).toBeNull();
  });
});
