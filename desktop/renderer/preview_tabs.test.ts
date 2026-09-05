// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-PREVIEW.10: unit tests for the pure lane-tab registry (upsert / cap-evict / remove / previewable test).

import { describe, expect, test } from "bun:test";
import {
  LANE_TAB_CAP, PREVIEW_KIND_ICON, isPreviewablePath, laneTabId, previewKindLabel, previewPathKind,
  removeLaneTab, upsertLaneTab, type PreviewTab,
} from "./preview_tabs.ts";
import { PREVIEW_KIND_EXT } from "../preview_resolve.ts";

const lane = (n: number): PreviewTab[] => {
  let tabs: PreviewTab[] = [];
  for (let i = 1; i <= n; i++) tabs = upsertLaneTab(tabs, `L${i}`, `Lane ${i}`, `C:/work/app${i}.html`);
  return tabs;
};

describe("upsertLaneTab", () => {
  test("adds a lane tab with the lane:<id> id, kind lane, and the lane name as label", () => {
    const tabs = upsertLaneTab([], "abc", "Checkout flow", "C:/w/index.html");
    expect(tabs).toEqual([{ id: "lane:abc", label: "Checkout flow", path: "C:/w/index.html", kind: "lane" }]);
  });

  test("falls back to the laneId when the name is empty", () => {
    const tabs = upsertLaneTab([], "abc", "", "a.html");
    expect(tabs[0]!.label).toBe("abc");
  });

  test("a rewrite replaces the path (and label) IN PLACE - same position, no duplicate", () => {
    const three = lane(3);
    const next = upsertLaneTab(three, "L2", "Lane 2 renamed", "C:/work/other.html");
    expect(next).toHaveLength(3);
    expect(next.map((t) => t.id)).toEqual(["lane:L1", "lane:L2", "lane:L3"]);
    expect(next[1]).toEqual({ id: "lane:L2", label: "Lane 2 renamed", path: "C:/work/other.html", kind: "lane" });
  });

  test("returns a NEW array and never mutates the input", () => {
    const before = lane(2);
    const snapshot = structuredClone(before);
    const next = upsertLaneTab(before, "L1", "Lane 1", "changed.html");
    expect(next).not.toBe(before);
    expect(before).toEqual(snapshot);
  });

  test("caps lane tabs at LANE_TAB_CAP, evicting the OLDEST", () => {
    const tabs = lane(LANE_TAB_CAP + 1);
    expect(tabs).toHaveLength(LANE_TAB_CAP);
    expect(tabs.some((t) => t.id === laneTabId("L1"))).toBe(false); // oldest gone
    expect(tabs[0]!.id).toBe(laneTabId("L2"));
    expect(tabs[tabs.length - 1]!.id).toBe(laneTabId(`L${LANE_TAB_CAP + 1}`)); // newest kept
  });

  test("a rewrite at the cap evicts nothing", () => {
    const full = lane(LANE_TAB_CAP);
    const next = upsertLaneTab(full, "L1", "Lane 1", "rewritten.html");
    expect(next).toHaveLength(LANE_TAB_CAP);
    expect(next.map((t) => t.id)).toEqual(full.map((t) => t.id));
    expect(next[0]!.path).toBe("rewritten.html");
  });
});

describe("removeLaneTab", () => {
  test("removes exactly the named lane's tab", () => {
    const next = removeLaneTab(lane(3), "L2");
    expect(next.map((t) => t.id)).toEqual(["lane:L1", "lane:L3"]);
  });

  test("is a no-op for an unknown lane", () => {
    const three = lane(3);
    expect(removeLaneTab(three, "nope")).toEqual(three);
  });
});

describe("isPreviewablePath (P-PREVIEW.12: delegates to the ONE kind table)", () => {
  test("accepts .html / .htm / .svg case-insensitively", () => {
    expect(isPreviewablePath("index.html")).toBe(true);
    expect(isPreviewablePath("page.htm")).toBe(true);
    expect(isPreviewablePath("logo.svg")).toBe(true);
    expect(isPreviewablePath("C:\\work\\INDEX.HTML")).toBe(true);
    expect(isPreviewablePath("art.SVG")).toBe(true);
  });

  test("rejects other extensions, empties, and near-misses", () => {
    expect(isPreviewablePath("app.ts")).toBe(false);
    expect(isPreviewablePath("style.css")).toBe(false);
    expect(isPreviewablePath("")).toBe(false);
    expect(isPreviewablePath(null)).toBe(false);
    expect(isPreviewablePath(undefined)).toBe(false);
    expect(isPreviewablePath("index.html.bak")).toBe(false);
    expect(isPreviewablePath("html")).toBe(false);
  });

  test("tolerates quoted paths and outer padding, including interior spaces", () => {
    expect(isPreviewablePath('"C:\\my work\\my page.html"')).toBe(true);
    expect(isPreviewablePath("'demo.svg'")).toBe(true);
    expect(isPreviewablePath("`site/out.htm`")).toBe(true);
    expect(isPreviewablePath("  spaced name.html  ")).toBe(true);
    expect(isPreviewablePath(' "wrapped.htm" ')).toBe(true);
    expect(isPreviewablePath('"app.js"')).toBe(false); // quotes stripped, still not previewable
  });

  // P-PREVIEW.12: a lane that writes a report, a payload, a table or a chart now earns a tab too. Before
  // this, only html/svg did, which is why most of what a model produces could never reach the panel.
  test("accepts every other kind in the table (report / data / chart / doc)", () => {
    for (const p of ["REPORT.md", "notes.markdown", "data.json", "rows.csv", "rows.tsv", "run.log",
                     "conf.yaml", "conf.yml", "feed.xml", "app.toml", "app.ini", "readme.txt",
                     "chart.png", "photo.jpg", "photo.jpeg", "anim.gif", "pic.webp", "pic.avif",
                     "old.bmp", "fav.ico", "spec.pdf"]) {
      expect(isPreviewablePath(p)).toBe(true);
    }
  });

  test("previewPathKind reports the KIND, so a tab can label/ice itself instead of assuming a web page", () => {
    expect(previewPathKind("index.html")).toBe("html");
    expect(previewPathKind("logo.svg")).toBe("svg");
    expect(previewPathKind("chart.png")).toBe("image");
    expect(previewPathKind("REPORT.md")).toBe("markdown");
    expect(previewPathKind("rows.csv")).toBe("text");
    expect(previewPathKind("spec.pdf")).toBe("pdf");
    expect(previewPathKind("app.ts")).toBeNull();
    expect(previewPathKind(null)).toBeNull();
    expect(previewPathKind("")).toBeNull();
  });

  test("previewPathKind unwraps a quoted / padded path before classifying", () => {
    expect(previewPathKind('"C:\\my work\\chart.png"')).toBe("image");
    expect(previewPathKind("  'notes.md'  ")).toBe("markdown");
    expect(previewPathKind("`out/report.pdf`")).toBe("pdf");
  });

  // Guards the tab strip against a kind added to the table with no icon or noun to render it with.
  test("every kind in the table has an icon name and a one-word label", () => {
    for (const kind of Object.keys(PREVIEW_KIND_EXT) as Array<keyof typeof PREVIEW_KIND_ICON>) {
      expect(typeof PREVIEW_KIND_ICON[kind]).toBe("string");
      expect(PREVIEW_KIND_ICON[kind].length).toBeGreaterThan(0);
      const label = previewKindLabel(kind);
      expect(label).not.toContain(" "); // INVARIANT 11: a tab label stays on ONE line
      expect(label.length).toBeGreaterThan(0);
    }
    expect(previewKindLabel(null)).toBe("file");
  });
});
