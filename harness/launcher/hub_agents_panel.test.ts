// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.5 E2 (ADR-0434): the rail's AGENTS panel. Rows build purely from the fleet snapshot; the
// sort is priority DESC, then blocked-on-a-human first among equals, then name; priority is DISPLAY
// ORDER only and round-trips its own store file; lines never wrap (invariant 11); the click toggle
// is select-then-attach and never an approval answer.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentPrioritiesPath, agentRailLine, buildAgentRows, HubAgentsPanel, laneLocations, loadPriorities,
  modelShort, normalizePriority, savePriorities, statusGlyph, statusRank, type AgentRow,
} from "./hub_agents_panel.ts";
import { HubOpError, type Space } from "./hub_spaces.ts";

const lane = (name: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id: `id-${name}`, name, status, model: "anthropic/claude-sonnet-4-20250514", createdAt: 0, ...extra });

describe("statusGlyph / statusRank", () => {
  test("the LaneStatus vocabulary maps to glyph + hue; blocked = the attention states", () => {
    expect(statusGlyph("needs-approval")).toEqual({ glyph: "◉", hue: "attention" });
    expect(statusGlyph("awaiting-input")).toEqual({ glyph: "◉", hue: "attention" });
    expect(statusGlyph("working")).toEqual({ glyph: "●", hue: "busy" });
    expect(statusGlyph("starting")).toEqual({ glyph: "◐", hue: "busy" });
    expect(statusGlyph("done")).toEqual({ glyph: "○", hue: "ok" });
    expect(statusGlyph("error")).toEqual({ glyph: "✗", hue: "error" });
    expect(statusGlyph("stopped")).toEqual({ glyph: "■", hue: "off" });
  });
  test("an unknown status renders (never dropped) and ranks LAST, after stopped", () => {
    expect(statusGlyph("hibernating")).toEqual({ glyph: "?", hue: "unknown" });
    expect(statusRank("hibernating")).toBeGreaterThan(statusRank("stopped"));
    expect(statusRank("needs-approval")).toBeLessThan(statusRank("working"));
  });
});

describe("modelShort", () => {
  test("provider prefix, a -YYYYMMDD pin and a :tag drop; unknown shapes pass through", () => {
    expect(modelShort("anthropic/claude-sonnet-4-20250514")).toBe("claude-sonnet-4");
    expect(modelShort("qwen2.5-coder:14b")).toBe("qwen2.5-coder");
    expect(modelShort("gpt-5.3-codex")).toBe("gpt-5.3-codex");
    expect(modelShort("")).toBe("");
  });
});

describe("laneLocations", () => {
  test("laneId -> space:tab of the live agent pane; the FIRST host in rail order wins", () => {
    const spaces: Pick<Space, "name" | "tabs">[] = [
      {
        name: "main",
        tabs: [
          { id: "s1:t1", name: "editor", focus: 0, zoom: false, tree: { kind: "leaf", id: "s1:p1", deck: "agent", lane: "id-api" } },
          { id: "s1:t2", name: "logs", focus: 0, zoom: false, tree: { kind: "leaf", id: "s1:p2", deck: "agent", lane: "id-api" } },
        ],
      },
      { name: "ops", tabs: [{ id: "s2:t1", name: "t1", focus: 0, zoom: false, tree: { kind: "leaf", id: "s2:p1", deck: "overview" } }] },
    ];
    expect(laneLocations(spaces)).toEqual({ "id-api": "main:editor" });
  });
});

describe("buildAgentRows", () => {
  test("sort: priority DESC, then blocked first among equals, then name; cells filled", () => {
    const rows = buildAgentRows(
      [lane("web", "working"), lane("api", "working"), lane("ask", "needs-approval"), lane("low", "stopped", { createdAt: Date.now() - 120_000 })],
      { "id-api": "main:editor" },
      { low: 9, web: 2 },
      Date.now(),
    );
    expect(rows.map((r) => `${r.name}:p${r.priority}`)).toEqual(["low:p9", "web:p2", "ask:p0", "api:p0"]);
    const api = rows.find((r) => r.name === "api")!;
    expect(api).toMatchObject({ id: "id-api", location: "main:editor", status: "working", model: "claude-sonnet-4" });
    expect(rows.find((r) => r.name === "low")!.elapsed).toBe("2m");
  });
  test("a hand-edited priority outside 1-9 reads as unset, never sorts a row up", () => {
    const rows = buildAgentRows([lane("a", "working"), lane("b", "working")], {}, { a: 99, b: 1 } as never);
    expect(rows.map((r) => r.name)).toEqual(["b", "a"]);
    expect(rows[1]!.priority).toBe(0);
  });
});

describe("agentRailLine (invariant 11: one line, exact width, ellipsize never wrap)", () => {
  const row: AgentRow = { id: "id-api", name: "api", location: "main:editor", status: "working", priority: 5, model: "claude-sonnet-4", elapsed: "4m" };
  test("glyph, name, meta, elapsed and the p-badge land on one 27-cell line", () => {
    const l = agentRailLine(row, 27);
    expect(Bun.stringWidth(l)).toBe(27);
    expect(l).toContain("● api");
    expect(l).toContain("4m p5 ");
    expect(l).toContain("main:edi"); // the meta truncates before the name does
  });
  test("a hostile long name ellipsizes; the line never exceeds the rail", () => {
    const l = agentRailLine({ ...row, name: "a-very-long-agent-lane-name", priority: 0 }, 27);
    expect(Bun.stringWidth(l)).toBe(27);
    expect(l).not.toContain("a-very-long-agent-lane-name");
    expect(l).toContain("…");
  });
  test("too narrow for meta: the name and the right side survive, meta drops", () => {
    const l = agentRailLine(row, 16);
    expect(Bun.stringWidth(l)).toBe(16);
    expect(l).toContain("api");
    expect(l).not.toContain("main");
  });
});

describe("the priority store", () => {
  const dir = mkdtempSync(join(tmpdir(), "lucid-agents-panel-"));
  const path = agentPrioritiesPath(dir);
  test("round-trips 0600 and drops off-shape values on read", () => {
    savePriorities(path, { api: 5, web: 2 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadPriorities(path)).toEqual({ api: 5, web: 2 });
    writeFileSync(path, JSON.stringify({ v: 1, priorities: { api: 3, bad: "high", zero: 0, big: 10, frac: 2.5 } }));
    expect(loadPriorities(path)).toEqual({ api: 3 });
  });
  test("a missing, corrupt or wrong-version file is {} - display order is never fatal", () => {
    expect(loadPriorities(join(dir, "nope.json"))).toEqual({});
    writeFileSync(path, "{not json");
    expect(loadPriorities(path)).toEqual({});
    writeFileSync(path, JSON.stringify({ v: 2, priorities: { api: 5 } }));
    expect(loadPriorities(path)).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });
  test("normalizePriority refuses non-1-9 with the display-order contract named", () => {
    expect(normalizePriority(1)).toBe(1);
    expect(normalizePriority(9)).toBe(9);
    for (const bad of [0, 10, 2.5, NaN]) expect(() => normalizePriority(bad)).toThrow(HubOpError);
    expect(() => normalizePriority(0)).toThrow(/display order/);
  });
});

describe("HubAgentsPanel", () => {
  const make = () => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-agents-panel-"));
    const calls: string[] = [];
    const panel = new HubAgentsPanel({
      lanes: () => [lane("api", "working"), lane("web", "needs-approval")],
      locations: () => ({ "id-api": "main:editor" }),
      attach: (id, name) => calls.push(`attach:${id}:${name}`),
      cancel: (id, name) => calls.push(`cancel:${id}:${name}`),
      path: agentPrioritiesPath(dir),
    });
    return { dir, calls, panel };
  };
  test("click once selects; a click on the selected row attaches; unknown ids no-op", () => {
    const { dir, calls, panel } = make();
    panel.onClick("id-api");
    expect(panel.selected).toBe("id-api");
    expect(calls).toEqual([]);
    panel.onClick("id-api");
    expect(calls).toEqual(["attach:id-api:api"]);
    panel.onClick("id-gone");
    panel.onPriority("id-gone", 5);
    expect(panel.selected).toBe("id-api");
    expect(loadPriorities(agentPrioritiesPath(dir))).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });
  test("Enter attaches outright; c cancels through the host; neither touches approvals", () => {
    const { dir, calls, panel } = make();
    panel.attach("id-web");
    panel.cancel("id-web");
    expect(calls).toEqual(["attach:id-web:web", "cancel:id-web:web"]);
    rmSync(dir, { recursive: true, force: true });
  });
  test("onPriority persists by NAME and reorders rows(); the store survives a fresh panel", () => {
    const { dir, panel } = make();
    expect(panel.rows().map((r) => r.name)).toEqual(["web", "api"]); // blocked first among p0 equals
    panel.onPriority("id-api", 7);
    expect(panel.rows().map((r) => `${r.name}:p${r.priority}`)).toEqual(["api:p7", "web:p0"]);
    expect(JSON.parse(readFileSync(agentPrioritiesPath(dir), "utf8"))).toEqual({ v: 1, priorities: { api: 7 } });
    const fresh = new HubAgentsPanel({ lanes: () => [lane("api", "working")], locations: () => ({}), attach: () => {}, cancel: () => {}, path: agentPrioritiesPath(dir) });
    expect(fresh.priorityOf("api")).toBe(7);
    rmSync(dir, { recursive: true, force: true });
  });
});
