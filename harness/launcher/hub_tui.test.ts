// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.1 (part): the hub's pure keystones. The pane tree must never lose or duplicate a leaf
// (a lost pane is a lost capability view), fitBlock must hold exact geometry (one sheared row
// breaks every pane to its right), and deck rows must survive hostile engine strings.

import { describe, expect, test } from "bun:test";
import { closeLeaf, deckLines, modelCatalog, fitBlock, leaves, mapLeaf, type HubData, type PaneNode } from "./hub_tui.ts";

const leaf = (deck: "overview" | "security" | "fleet"): PaneNode => ({ kind: "leaf", deck });

describe("pane tree", () => {
  test("split replaces the focused leaf and keeps every other leaf in ring order", () => {
    let tree: PaneNode = leaf("overview");
    tree = mapLeaf(tree, 0, (l) => ({ kind: "split", dir: "v", a: l, b: leaf("security") }));
    tree = mapLeaf(tree, 1, (l) => ({ kind: "split", dir: "h", a: l, b: leaf("fleet") }));
    expect(leaves(tree).map((l) => l.deck)).toEqual(["overview", "security", "fleet"]);
  });

  test("closing a middle pane hands its region to the sibling; the last pane refuses", () => {
    let tree: PaneNode = { kind: "split", dir: "v", a: leaf("overview"), b: { kind: "split", dir: "h", a: leaf("security"), b: leaf("fleet") } };
    const closed = closeLeaf(tree, 1)!;
    expect(leaves(closed).map((l) => l.deck)).toEqual(["overview", "fleet"]);
    expect(closeLeaf(leaf("overview"), 0)).toBeNull();
  });
});

describe("fitBlock", () => {
  test("pads and clips to exact geometry, including overlong and missing rows", () => {
    const out = fitBlock(["abc", "this row is far too long for the pane"], 10, 4);
    expect(out).toHaveLength(4);
    for (const row of out) expect(Bun.stringWidth(row)).toBe(10);
    expect(out[0]).toBe("abc       ");
    expect(out[3]).toBe(" ".repeat(10));
  });
});

describe("deck rows", () => {
  const WL_HOST = "glm-box.tailnet-test.ts.net";
  const data: HubData = {
    build: { productName: "LucidAgentIDE", version: "9.9", flavor: "agent", port: 5319 },
    security: { live: { quarantined: [{ id: "b1", tool: "write", severity: "high", findings: "zero-width×2", at: "2026-09-28T10:00:00Z" }], dismissed: [] } },
    fleet: { lanes: [{ name: "lane-1", status: "running", turns: 2, model: "haiku" }] },
    sessions: [{ title: "line one\nline two\ttabbed", updatedAt: "2026-09-28T10:00" }],
    audit: { events: [] },
    usage: { models: [] },
    whitelist: [{ id: "wl_1", kind: "domain", pattern: WL_HOST, zone: "internal", scope: "always" }],
    posture: { allowAll: true, allowWebSearch: true },
    config: [{ id: "model", value: "glm-5.3-flash", options: [{ value: "glm-5.3-flash", name: "GLM 5.3 Flash" }, { value: "claude-haiku-4-5", name: "Claude Haiku 4.5" }] }],
  };

  test("a hostile title (newline, tab) still renders as ONE physical row", () => {
    const rows = deckLines("sessions", data, 60, -1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toMatch(/[\n\t]/);
    expect(rows[0]).toContain("line one line two tabbed");
  });

  test("security rows carry the selection cursor and never raw content", () => {
    const rows = deckLines("security", data, 60, 0);
    expect(rows[0]).toStartWith("▸");
    expect(rows[0]).toContain("write");
    expect(rows[0]).toContain("zero-width×2");
  });

  test("the network deck lists posture and the whitelist entry with a cursor", () => {
    const rows = deckLines("network", data, 90, 0);
    expect(rows.some((r) => r.includes("allow-all ON"))).toBe(true);
    const entry = rows.find((r) => r.includes(WL_HOST))!;
    expect(entry).toStartWith("▸");
    expect(entry).toContain("internal");
    expect(entry).toContain("always");
  });

  test("an off-shape engine answer degrades to '?' rows, never a crash", () => {
    const weird = { ...data, fleet: { lanes: [{}] }, build: {} } as HubData;
    expect(deckLines("overview", weird, 40, -1)[1]).toContain("?");
    expect(deckLines("fleet", weird, 40, -1)).toHaveLength(1);
    expect(deckLines("overview", null, 40, -1)).toEqual(["loading from the engine…"]);
  });
});

describe("modelCatalog", () => {
  test("finds the model entry, maps options, reports the current pick; off-shape is empty", () => {
    const cfg = [
      { id: "thinking", options: [{ value: "high" }] },
      { id: "model", value: "glm-5.3-flash", options: [{ value: "glm-5.3-flash", name: "GLM 5.3 Flash" }, { value: "haiku" }] },
    ];
    const { models, current } = modelCatalog(cfg);
    expect(models.map((m) => m.value)).toEqual(["glm-5.3-flash", "haiku"]);
    expect(models[1]!.name).toBe("haiku"); // name falls back to the value
    expect(current).toBe("glm-5.3-flash");
    expect(modelCatalog([])).toEqual({ models: [], current: "" });
    expect(modelCatalog([null, 4, "x"])).toEqual({ models: [], current: "" });
  });
});
