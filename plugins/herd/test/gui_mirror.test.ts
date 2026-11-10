// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0497 as the add-on): what the read-only GUI mirror shows of instance main. Tabs and the
// split tree in the ADR-0491 shape, agent panes with name, status and attention, metadata only, and
// an untrusted layout file or lane list never reaches the page off-shape.

import { describe, expect, test } from "bun:test";
import { cleanName, MIRROR_NAME_MAX, parseMirrorSpaces, projectMirror, type MirrorNode, type MirrorPane, type MirrorSplit } from "../src/gui_mirror.ts";
import { LAYOUT_LEAF_CAP } from "../src/layouts.ts";

const leaf = (id: string, deck: string, lane?: string, laneName?: string) => ({ kind: "leaf", id, deck, ...(lane ? { lane, laneName } : {}) });

const LAYOUT = {
  v: 2, active: "s1", nextSpace: 3, rail: true,
  spaces: [
    {
      id: "s1", name: "work", activeTab: "s1:t2", nextPane: 5, nextTab: 3,
      tabs: [
        { id: "s1:t1", name: "solo", focus: 0, zoom: false, tree: leaf("s1:p1", "fleet") },
        {
          id: "s1:t2", name: "columns", focus: 1, zoom: false,
          tree: {
            kind: "split", dir: "v", ratio: 0.6,
            a: leaf("s1:p2", "agent", "L1", "alpha"),
            b: { kind: "split", dir: "h", a: leaf("s1:p3", "agent", "L2", "beta"), b: leaf("s1:p4", "main") },
          },
        },
      ],
    },
    { id: "s2", name: "side", activeTab: "s2:t1", nextPane: 2, nextTab: 2, tabs: [{ id: "s2:t1", name: "t1", focus: 0, zoom: true, tree: leaf("s2:p1", "agent", "L3", "gamma") }] },
  ],
};

const LANES: unknown[] = [
  { id: "L1", name: "alpha", status: "needs-approval", attention: "needs-you", cwd: "C:/secret/repo", model: "secret-model", lastText: "PROMPT-TEXT" },
  { id: "L2", name: "beta", status: "done", attention: "unseen" },
  { id: "L9", name: "elsewhere", status: "working", attention: "none" },
];

const layout = () => {
  const spaces = parseMirrorSpaces(JSON.stringify(LAYOUT));
  if (!spaces) throw new Error("fixture layout is off-shape");
  return spaces;
};

const isSplit = (n: MirrorNode | null | undefined): n is MirrorSplit => !!n && "dir" in n;
const isPane = (n: MirrorNode | null | undefined): n is MirrorPane => !!n && !("dir" in n);

describe("projectMirror", () => {
  test("tabs, the split tree with its ratios, focus, and agent name, status and attention", () => {
    const s = projectMirror({ instance: "main", up: true, layout: layout(), lanes: LANES });
    expect(s.up).toBe(true);
    expect(s.focusedTab).toBe("s1:t2");
    expect(s.spaces.map((x) => [x.id, x.name, x.active])).toEqual([["s1", "work", true], ["s2", "side", false]]);
    const tab = s.spaces[0]!.tabs[1]!;
    expect(tab).toMatchObject({ id: "s1:t2", name: "columns", active: true, zoom: false, panes: 3, needsYou: 1, unseen: 1 });
    const root = tab.tree;
    if (!isSplit(root)) throw new Error("expected a split");
    expect([root.dir, root.ratio]).toEqual(["v", 0.6]);
    expect(root.a).toEqual({ id: "s1:p2", deck: "agent", focused: false, agent: { name: "alpha", status: "needs-approval", attention: "needs-you" } });
    if (!isSplit(root.b)) throw new Error("expected a nested split");
    expect([root.b.dir, root.b.ratio]).toEqual(["h", 0.5]); // no ratio saved: the hub's default share
    expect(root.b.a).toEqual({ id: "s1:p3", deck: "agent", focused: true, agent: { name: "beta", status: "done", attention: "unseen" } });
    expect(root.b.b).toEqual({ id: "s1:p4", deck: "main", focused: false });
    // Every lane counts, shown in a pane or not.
    expect(s.counts).toEqual({ agents: 3, needsYou: 1, unseen: 1 });
  });

  test("metadata only: no lane id, cwd, model or text reaches the page", () => {
    const json = JSON.stringify(projectMirror({ instance: "main", up: true, layout: layout(), lanes: LANES }));
    for (const leak of ["L1", "L2", "secret", "PROMPT-TEXT", "cwd", "model", "lastText"]) expect(json).not.toContain(leak);
  });

  test("a hub that is down shows nothing else, whatever the other inputs say", () => {
    expect(projectMirror({ instance: "main", up: false, layout: layout(), lanes: LANES })).toEqual({
      v: 1, instance: "main", up: false, focusedTab: null, spaces: [], counts: { agents: 0, needsYou: 0, unseen: 0 },
    });
  });

  test("a hub that cannot list lanes reads unknown; a lane that left the engine reads gone", () => {
    const unknown = projectMirror({ instance: "main", up: true, layout: layout(), lanes: null });
    const pane = unknown.spaces[0]!.tabs[1]!.tree;
    if (!isSplit(pane)) throw new Error("expected a split");
    expect(pane.a).toMatchObject({ agent: { name: "alpha", status: "unknown", attention: "none" } });
    expect(unknown.counts).toEqual({ agents: 0, needsYou: 0, unseen: 0 });

    const gone = projectMirror({ instance: "main", up: true, layout: layout(), lanes: LANES }).spaces[1]!.tabs[0]!;
    expect(gone).toMatchObject({ zoom: true, panes: 1 });
    expect(gone.tree).toEqual({ id: "s2:p1", deck: "agent", focused: true, agent: { name: "gamma", status: "gone", attention: "none" } });
  });

  test("without the server's attention field only an open approval is an ask; an unknown status reads unknown", () => {
    const s = projectMirror({
      instance: "main", up: true, layout: layout(),
      lanes: [{ id: "L1", name: "alpha", status: "needs-approval" }, { id: "L2", name: "beta", status: "awaiting-input" }, { id: "L3", name: "gamma", status: "<script>", attention: "urgent" }],
    });
    const root = s.spaces[0]!.tabs[1]!.tree;
    if (!isSplit(root) || !isSplit(root.b)) throw new Error("expected splits");
    expect(isPane(root.a) && root.a.agent?.attention).toBe("needs-you");
    expect(isPane(root.b.a) && root.b.a.agent).toEqual({ name: "beta", status: "awaiting-input", attention: "none" });
    expect(s.spaces[1]!.tabs[0]!.tree).toMatchObject({ agent: { status: "unknown", attention: "none" } });
    expect(s.counts).toEqual({ agents: 3, needsYou: 1, unseen: 0 });
  });

  test("lane names are stripped of control and bidi characters and capped", () => {
    const s = projectMirror({ instance: "main", up: true, layout: layout(), lanes: [{ id: "L1", name: "\u202Eev\u0007il" + "x".repeat(80), status: "working" }] });
    const root = s.spaces[0]!.tabs[1]!.tree;
    if (!isSplit(root) || !isPane(root.a)) throw new Error("expected a split");
    expect(root.a.agent?.name).toBe(`evil${"x".repeat(MIRROR_NAME_MAX - 4)}`);
    expect(cleanName(42)).toBe("");
    expect(cleanName("  a\u2066b\u0000  ")).toBe("ab");
  });

  test("an up hub with no layout yet lists no tabs but still counts lanes", () => {
    expect(projectMirror({ instance: "main", up: true, layout: null, lanes: LANES })).toMatchObject({ up: true, spaces: [], focusedTab: null, counts: { agents: 3, needsYou: 1 } });
  });

  test("a tab over the layout leaf cap is listed without a tree", () => {
    const n = LAYOUT_LEAF_CAP + 1;
    let tree: Record<string, unknown> = leaf(`s1:p${n}`, "fleet");
    for (let i = n - 1; i >= 1; i--) tree = { kind: "split", dir: "v", a: leaf(`s1:p${i}`, "fleet"), b: tree };
    const big = { v: 2, active: "s1", nextSpace: 2, spaces: [{ id: "s1", name: "big", activeTab: "s1:t1", nextPane: n + 1, nextTab: 2, tabs: [{ id: "s1:t1", name: "wide", focus: 0, zoom: false, tree }] }] };
    const spaces = parseMirrorSpaces(JSON.stringify(big));
    expect(spaces).not.toBeNull();
    const tab = projectMirror({ instance: "main", up: true, layout: spaces, lanes: [] }).spaces[0]!.tabs[0]!;
    expect(tab).toMatchObject({ panes: n, tree: null });
  });
});

describe("parseMirrorSpaces", () => {
  test("an off-shape layout file is no layout", () => {
    expect(parseMirrorSpaces("{not json")).toBeNull();
    expect(parseMirrorSpaces(JSON.stringify({ ...LAYOUT, v: 9 }))).toBeNull();
    const good = JSON.stringify(LAYOUT);
    expect(parseMirrorSpaces(good.replace('"deck":"fleet"', '"deck":"../x"'))).toBeNull();
    expect(parseMirrorSpaces(good.replace('"name":"work"', `"name":${JSON.stringify("a\u0007b")}`))).toBeNull();
    expect(parseMirrorSpaces(good.replace('"lane":"L1",', ""))).toBeNull(); // an agent pane needs its lane
  });
});
