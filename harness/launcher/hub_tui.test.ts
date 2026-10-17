// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.1 (part): the hub's pure keystones. fitBlock must hold exact geometry (one sheared row breaks
// every pane to its right), and deck rows must survive hostile engine strings. The pane tree's own
// keystones (no lost or duplicated leaf, stable ids) live in hub_spaces.test.ts (P-TUI.3).

import { describe, expect, test } from "bun:test";
import { deckLines, kgPages, modelCatalog, fitBlock, type HubData } from "./hub_tui.ts";

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
    kg: { kgs: [{ kg_id: "kg1", name: "My Knowledge", source_kind: "manual", provenance: "default" }, { kg_id: "kg2", name: "Research", source_kind: "pack", provenance: "ArXiv pack", read_only: true }], activeId: "kg1" },
    kgGraph: { kgId: "kg1", totalPages: 2, totalLinks: 1, pages: [{ page_id: "p1", title: "Fail-closed gate", slug: "gate", degree: 1, trust_label: "trusted" }, { page_id: "p2", title: "Prompt prefix", slug: "prefix", degree: 1, trust_label: "untrusted" }], links: [{ from_page_id: "p1", to_page_id: "p2", relation: "links" }] },
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

describe("knowledge deck", () => {
  const kgData = {
    build: {}, security: {}, fleet: { lanes: [] }, sessions: [], audit: {}, usage: {},
    whitelist: [], posture: {}, config: [],
    kg: { kgs: [{ kg_id: "kg1", name: "My Knowledge", source_kind: "manual", provenance: "default" }, { kg_id: "kg2", name: "Research", source_kind: "pack", provenance: "ArXiv pack", read_only: true }], activeId: "kg1" },
    kgGraph: {
      kgId: "kg1", totalPages: 2, totalLinks: 1,
      pages: [{ page_id: "p1", title: "Fail-closed gate", slug: "gate", degree: 1, trust_label: "trusted" }, { page_id: "p2", title: "Prompt prefix", slug: "prefix", degree: 1, trust_label: "untrusted" }],
      links: [{ from_page_id: "p1", to_page_id: "p2", relation: "links" }],
    },
  } as unknown as HubData; // fixture: only the kg slices matter here

  test("lists KGs with the active marker, pages with outgoing links, and filters live", () => {
    const rows = deckLines("kg", kgData, 100, 0);
    expect(rows.some((l) => l.includes("● My Knowledge") && l.includes("written by you"))).toBe(true);
    expect(rows.some((l) => l.includes("Research") && l.includes("installed pack · ArXiv pack · read-only"))).toBe(true);
    expect(rows.some((l) => l.includes("2 pages · 1 link"))).toBe(true);
    const sel = rows.find((l) => l.startsWith("▸"))!;
    expect(sel).toContain("[trusted] Fail-closed gate (1)");
    expect(sel).toContain("→  Prompt prefix");
    const filtered = deckLines("kg", kgData, 100, 0, "prefix");
    expect(filtered.some((l) => l.includes("Prompt prefix"))).toBe(true);
    expect(filtered.some((l) => l.includes("Fail-closed gate ("))).toBe(false);
    expect(kgPages(kgData, "gate").map((p) => p.page_id)).toEqual(["p1"]);
  });
});
