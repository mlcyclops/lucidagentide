// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.1 (part): the hub's pure keystones. fitBlock must hold exact geometry (one sheared row breaks
// every pane to its right), and deck rows must survive hostile engine strings. The pane tree's own
// keystones (no lost or duplicated leaf, stable ids) live in hub_spaces.test.ts (P-TUI.3).

import { describe, expect, test } from "bun:test";
import { agentTableLines, clickTarget, deckLines, deckStrip, deckStripEntries, fmtElapsed, kgPages, modelCatalog, fitBlock, paneRects, railLine, railRows, spaceTableLines, type HubData, type HubGeometry, type HubSpace } from "./hub_tui.ts";
import { Spaces } from "./hub_spaces.ts";

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

// P-TUI.4: the herdr-parity decks' pure row builders. One lane / one space is ONE physical row
// (invariant 11: cells truncate, never wrap), the LaneStatus vocabulary passes through verbatim,
// and off-shape or hostile engine strings degrade to "?" rows, never a crash.
describe("agents deck (P-TUI.4)", () => {
  const NOW = 1_700_000_000_000;
  const lane = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "lane_1", name: "scout", status: "working", model: "claude-haiku-4-5",
    createdAt: NOW - 125_000, turns: 3, ...over,
  });

  test("a full lane renders name, verbatim status, elapsed, model and repo#branch", () => {
    const repo = { repo: { name: "lucidagentide", branch: "feat/p-tui.4-decks", worktree: true } };
    const rows = agentTableLines([lane({ repo })], 0, NOW);
    const row = rows.find((l) => l.startsWith("▸"))!;
    expect(row).toContain("scout");
    expect(row).toContain("working");
    expect(row).toContain("2m");
    expect(row).toContain("claude-haiku-4-5");
    expect(row).toContain("lucidagentide#feat/p-tui.4-decks ·wt");
  });

  test("status vocabulary passes through verbatim; a parked ask is flagged", () => {
    const rows = agentTableLines([lane({ status: "needs-approval", pendingApproval: { summary: "run rm", kind: "exec" } })], -1, NOW);
    expect(rows.at(-1)).toContain("needs-approval");
    expect(rows.at(-1)).toContain("WAITING ON YOU");
  });

  test("no repo probe yet means an empty repo cell, never '?' debris", () => {
    const row = agentTableLines([lane()], 0, NOW).find((l) => l.startsWith("▸"))!;
    expect(row).not.toContain("undefined");
    expect(row.trimEnd().endsWith("claude-haiku-4-5")).toBe(true);
  });

  test("a hostile lane name (newline, tab) still renders as ONE physical row via deckLines", () => {
    const data = { fleet: { lanes: [lane({ name: "evil\nname\ttab" })] }, build: {}, security: {}, sessions: [], audit: {}, usage: {}, whitelist: [], posture: {}, config: [], kg: {}, kgGraph: null } as unknown as HubData;
    const rows = deckLines("agents", data, 60, 0);
    expect(rows.every((l) => !l.includes("\n") && !l.includes("\t"))).toBe(true);
  });

  test("no lanes teaches the spawn and attach keys", () => {
    const rows = agentTableLines([], 0, NOW);
    expect(rows.join("\n")).toContain("n  spawn");
    expect(rows.join("\n")).toContain("attach the selected agent");
  });

  test("an off-shape lane degrades to '?' cells, never a crash", () => {
    const rows = agentTableLines([{ bogus: true }], 0, NOW);
    expect(rows.find((l) => l.startsWith("▸"))).toContain("?");
  });
});

describe("fmtElapsed (P-TUI.4)", () => {
  const NOW = 1_700_000_000_000;
  test("buckets: seconds, minutes, hours+minutes, days; bad input is '?'", () => {
    expect(fmtElapsed(NOW - 42_000, NOW)).toBe("42s");
    expect(fmtElapsed(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(fmtElapsed(NOW - (2 * 3600_000 + 13 * 60_000), NOW)).toBe("2h13m");
    expect(fmtElapsed(NOW - 3 * 86_400_000, NOW)).toBe("3d");
    expect(fmtElapsed(Number.NaN, NOW)).toBe("?");
    expect(fmtElapsed(0, NOW)).toBe("?");
    expect(fmtElapsed(NOW + 1000, NOW)).toBe("?"); // a clock from the future stays honest
  });
});

describe("spaces deck (P-TUI.4)", () => {
  const spaces: HubSpace[] = [
    { id: "sp1", name: "main", panes: 3, focused: true },
    { id: "sp2", name: "review", panes: 1, focused: false },
  ];

  test("rows carry the focus marker, the cursor and the pane count (singular/plural)", () => {
    const rows = spaceTableLines(spaces, 1);
    expect(rows.some((l) => l.includes("●") && l.includes("main") && l.includes("3 panes"))).toBe(true);
    const sel = rows.find((l) => l.startsWith("▸"))!;
    expect(sel).toContain("review");
    expect(sel).toContain("1 pane");
    expect(sel).not.toContain("1 panes");
  });

  test("no spaces teaches the create key; a hostile name stays one row via deckLines", () => {
    expect(spaceTableLines([], 0).join("\n")).toContain("n creates one");
    const data = { fleet: { lanes: [] }, build: {}, security: {}, sessions: [], audit: {}, usage: {}, whitelist: [], posture: {}, config: [], kg: {}, kgGraph: null } as unknown as HubData;
    const rows = deckLines("spaces", data, 60, 0, "", [{ id: "s", name: "two\nline", panes: 2, focused: false }]);
    expect(rows.every((l) => !l.includes("\n"))).toBe(true);
    expect(rows.some((l) => l.includes("two line"))).toBe(true);
  });
});

// P-TUI.5: the rail and click routing. Headless runs cannot send a real mouse event, so the meaning of
// a click is a pure function of the rendered geometry and is pinned here.
describe("rail (P-TUI.5)", () => {
  const model = () => {
    const h = new Spaces();
    h.createTab(undefined, "agents");
    h.split(undefined, "right");
    h.rebind("s1:p2", "agent", { id: "lane-a", name: "a" });
    h.rebind("s1:p3", "agent", { id: "lane-a", name: "a" }); // the same lane twice is ONE lane
    h.create("a-very-long-space-name-that-cannot-fit");
    h.focusTab("s1:t2");
    return h;
  };

  test("rows: SPACES header, each space with its tabs beneath, then the AGENTS seam header", () => {
    const rows = railRows(model());
    expect(rows.map((r) => (r.kind === "space" || r.kind === "tab" ? `${r.kind}:${r.id}` : r.kind))).toEqual([
      "gap", "spaces-head", "space:s1", "tab:s1:t1", "tab:s1:t2", "space:s2", "tab:s2:t1", "gap", "agents-head",
    ]);
    const t2 = rows[4]!;
    expect(t2.kind === "tab" && [t2.focused, t2.lanes, t2.panes, t2.last]).toEqual([true, ["lane-a"], 2, true]);
    const s2 = rows[5]!;
    expect(s2.kind === "space" && s2.focused).toBe(false);
    expect(rows.at(-1)).toEqual({ kind: "agents-head", count: null });
    expect(railRows(model(), 4).at(-1)).toEqual({ kind: "agents-head", count: 4 });
  });

  test("lines are exactly the rail width; a long name ellipsizes instead of wrapping", () => {
    const rows = railRows(model());
    const lines = rows.map((r) => railLine(r, 27));
    for (const l of lines) expect(Bun.stringWidth(l)).toBe(27);
    expect(lines[2]).toContain("▎◆ main");
    expect(lines[4]).toMatch(/└ agents\s+◎1 2▣ $/);
    expect(lines[5]).toContain(" ◇ a-very-long");
    expect(lines[5]).toContain("…");
    expect(lines[5]).toMatch(/1▣ $/);
    expect(lines[8]).toContain("◎ AGENTS");
  });

  test("pane rectangles split with the renderer's floor arithmetic", () => {
    const h = new Spaces();
    h.split(undefined, "right");
    h.resize("s1:p1", "R", 10); // ratio 0.6
    h.split("s1:p2", "down");
    expect(paneRects(h.tab.tree, 101, 30)).toEqual([
      { index: 0, x: 0, y: 0, w: 60, h: 30 },
      { index: 1, x: 60, y: 0, w: 41, h: 15 },
      { index: 2, x: 60, y: 15, w: 41, h: 15 },
    ]);
  });

  test("click routing: rail rows act on their space/tab, the rest falls through to the pane below", () => {
    const h = model();
    const rail = railRows(h);
    const g: HubGeometry = { left: 28, rail, top: 1, height: 38, panes: paneRects(h.tab.tree, 112, 38) };
    expect(clickTarget(g, 5, 1 + 2)).toEqual({ kind: "space", id: "s1", row: 2 });
    expect(clickTarget(g, 20, 1 + 3)).toEqual({ kind: "tab", id: "s1:t1", row: 3 });
    expect(clickTarget(g, 0, 1 + 6)).toEqual({ kind: "tab", id: "s2:t1", row: 6 });
    expect(clickTarget(g, 3, 1 + 1)).toEqual({ kind: "spaces-head", row: 1 });
    expect(clickTarget(g, 3, 1 + 0)).toBeNull(); // a gap row
    expect(clickTarget(g, 3, 1 + 8)).toBeNull(); // the AGENTS header (E2 adds its rows below it)
    expect(clickTarget(g, 3, 1 + 20)).toBeNull(); // empty rail space
    expect(clickTarget(g, 28, 5)).toEqual({ kind: "pane", index: 0 }); // first column right of the rail
    expect(clickTarget(g, 28 + 56, 5)).toEqual({ kind: "pane", index: 1 });
    expect(clickTarget(g, 50, 0)).toBeNull(); // the top bar
    expect(clickTarget(g, 50, 39)).toBeNull(); // the status bar
    // Rail closed: the deck list column takes no clicks; panes still do.
    const closed: HubGeometry = { ...g, left: 20, rail: null };
    expect(clickTarget(closed, 5, 3)).toBeNull();
    expect(clickTarget(closed, 20, 3)).toEqual({ kind: "pane", index: 0 });
  });

  // P-TUI.5 E2: the AGENTS panel's rows ride under the header; clicks map to their lane id.
  test("agent rows: the panel's rows sit under the AGENTS header (which counts them) and take clicks", () => {
    const agents = [
      { id: "lane-a", name: "a", location: "main:t1", status: "working", priority: 5, model: "sonnet", elapsed: "4m" },
      { id: "lane-b", name: "b", location: "", status: "needs-approval", priority: 0, model: "opus", elapsed: "1h2m" },
    ];
    const rows = railRows(model(), agents);
    expect(rows.at(-3)).toEqual({ kind: "agents-head", count: 2 });
    expect(rows.slice(-2).map((r) => (r.kind === "agent" ? r.row.id : r.kind))).toEqual(["lane-a", "lane-b"]);
    const lines = rows.map((r) => railLine(r, 27));
    for (const l of lines) expect(Bun.stringWidth(l)).toBe(27);
    expect(lines.at(-2)).toContain("● a");
    expect(lines.at(-2)).toContain("4m p5 ");
    expect(lines.at(-1)).toContain("◉ b"); // blocked-on-a-human glyph, no badge when unset
    expect(lines.at(-1)).not.toContain("p0");
    const g: HubGeometry = { left: 28, rail: rows, top: 1, height: 38, panes: paneRects(model().tab.tree, 112, 38) };
    expect(clickTarget(g, 5, 1 + 9)).toEqual({ kind: "agent", id: "lane-a", row: 9 });
    expect(clickTarget(g, 5, 1 + 10)).toEqual({ kind: "agent", id: "lane-b", row: 10 });
  });
});

// P-TUI.6: the deck strip. Entries carry the SAME live counts the sidebar badges show; layout is
// pure column geometry (the click seam reads the cells), and narrowing drops names first, then
// glyphs, then counts - the digits that rebind panes are the last thing standing (invariant 11:
// cells drop whole, nothing shears or wraps).
describe("deck strip (P-TUI.6)", () => {
  const data: HubData = {
    build: {}, audit: {}, usage: {}, whitelist: [], posture: {}, config: [], kg: {}, kgGraph: null,
    security: { live: { quarantined: [{ id: "b1" }, { id: "b2" }] } },
    fleet: { lanes: [{ name: "a" }, { name: "b" }, { name: "c" }] },
    sessions: [{ id: "s1" }],
  };

  test("entries mirror the deck badges: quarantined (alert), lanes, sessions, spaces", () => {
    const by = Object.fromEntries(deckStripEntries(data, 4).map((e) => [e.id, e]));
    expect(by.security).toMatchObject({ key: "2", count: "2", alert: true });
    expect(by.fleet!.count).toBe("3");
    expect(by.agents!.count).toBe("3");
    expect(by.sessions!.count).toBe("1");
    expect(by.spaces).toMatchObject({ count: "4", alert: false });
    expect(by.overview!.count).toBeNull();
  });

  test("before the first engine answer only the client-side Spaces count shows", () => {
    const entries = deckStripEntries(null, 2);
    expect(entries.find((e) => e.id === "spaces")!.count).toBe("2");
    expect(entries.filter((e) => e.count !== null)).toHaveLength(1);
  });

  test("wide: digit glyph name count, cells at exact non-overlapping columns", () => {
    const entries = deckStripEntries(data, 4);
    const { level, cells } = deckStrip(entries, 200);
    expect(level).toBe(0);
    expect(cells).toHaveLength(10);
    expect(cells[0]!.text).toBe("1 ◆ Overview");
    expect(cells[1]!.text).toBe("2 ⛨ Security 2");
    expect(cells[0]!.x).toBe(1); // one leading space
    for (let i = 1; i < cells.length; i++) expect(cells[i]!.x).toBe(cells[i - 1]!.x + cells[i - 1]!.w + 2);
    const last = cells.at(-1)!;
    expect(last.x + last.w).toBeLessThanOrEqual(200);
  });

  test("narrowing drops names, then glyphs, then counts - digits never leave", () => {
    const entries = deckStripEntries(data, 4);
    const at = (w: number) => deckStrip(entries, w);
    expect(at(90).level).toBe(1); // names gone, glyphs + counts stay
    expect(at(90).cells[1]!.text).toBe("2 ⛨ 2");
    expect(at(50).level).toBe(2); // glyphs gone, counts stay
    expect(at(50).cells[1]!.text).toBe("2 2");
    expect(at(30).level).toBe(3); // counts gone, digits stand
    expect(at(30).cells.map((c) => c.text)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
  });

  test("cells that still overflow drop WHOLE from the tail, never sheared", () => {
    const entries = deckStripEntries(data, 4);
    const { cells } = deckStrip(entries, 12); // narrower than ten level-3 cells
    expect(cells.length).toBeLessThan(10);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c.x + c.w).toBeLessThanOrEqual(12);
  });

  test("a click on a strip cell is that deck; the separator and the status row are nothing", () => {
    const entries = deckStripEntries(data, 4);
    const { cells } = deckStrip(entries, 200);
    const g: HubGeometry = { left: 0, rail: null, top: 1, height: 37, panes: [], strip: { row: 38, cells } };
    expect(clickTarget(g, cells[1]!.x, 38)).toEqual({ kind: "deck", id: "security" });
    expect(clickTarget(g, cells[1]!.x + cells[1]!.w - 1, 38)).toEqual({ kind: "deck", id: "security" });
    expect(clickTarget(g, cells[1]!.x + cells[1]!.w, 38)).toBeNull(); // the gap between cells
    expect(clickTarget(g, cells[0]!.x, 39)).toBeNull(); // the status line is not the strip
  });
});
