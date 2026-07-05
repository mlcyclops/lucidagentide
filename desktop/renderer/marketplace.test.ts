// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/marketplace.test.ts — P-MARKET.1 (ADR-0158): the Plugin Marketplace popup.

import { test, expect, describe } from "bun:test";
import {
  MARKET_PLUGINS, sortMarket, filterMarket, fmtDownloads, marketRowsHtml, marketplaceHtml,
  type MarketPlugin,
} from "./marketplace.ts";

function mk(over: Partial<MarketPlugin> = {}): MarketPlugin {
  return {
    id: "x", name: "X", desc: "d", repo: "https://github.com/o/x", category: "c",
    downloads: null, rank: 50, status: "planned", lucidPlan: "p", ...over,
  };
}

describe("registry", () => {
  test("Excalidraw is the first option — the product requirement", () => {
    const sorted = sortMarket(MARKET_PLUGINS);
    expect(sorted[0]!.id).toBe("excalidraw");
    expect(sorted[0]!.repo).toBe("https://github.com/excalidraw/excalidraw");
    expect(sorted[0]!.status).toBe("featured");
  });
  test("ids and ranks are unique; statuses are the closed set", () => {
    expect(new Set(MARKET_PLUGINS.map((p) => p.id)).size).toBe(MARKET_PLUGINS.length);
    expect(new Set(MARKET_PLUGINS.map((p) => p.rank)).size).toBe(MARKET_PLUGINS.length);
    for (const p of MARKET_PLUGINS) expect(["featured", "built-in", "planned"]).toContain(p.status);
  });
  test("every repo is an https GitHub URL (the row's only live action must be safe to open)", () => {
    for (const p of MARKET_PLUGINS) expect(p.repo).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  });
  test("the integrations follow Obsidian's category ranking: Git, then Remotely Save, then Copilot", () => {
    const ids = sortMarket(MARKET_PLUGINS).map((p) => p.id);
    expect(ids.indexOf("git")).toBeLessThan(ids.indexOf("remotely-save"));
    expect(ids.indexOf("remotely-save")).toBeLessThan(ids.indexOf("copilot"));
  });
});

describe("sortMarket", () => {
  test("featured pins to the top even with a worse rank", () => {
    const list = [mk({ id: "a", rank: 1 }), mk({ id: "feat", rank: 99, status: "featured" })];
    expect(sortMarket(list).map((p) => p.id)).toEqual(["feat", "a"]);
  });
  test("otherwise rank asc; input is not mutated", () => {
    const list = [mk({ id: "b", rank: 2 }), mk({ id: "a", rank: 1 })];
    expect(sortMarket(list).map((p) => p.id)).toEqual(["a", "b"]);
    expect(list.map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("filterMarket", () => {
  test("empty / whitespace query keeps everything", () => {
    expect(filterMarket(MARKET_PLUGINS, "")).toHaveLength(MARKET_PLUGINS.length);
    expect(filterMarket(MARKET_PLUGINS, "   ")).toHaveLength(MARKET_PLUGINS.length);
  });
  test("case-insensitive match over name, desc, category and plan", () => {
    expect(filterMarket(MARKET_PLUGINS, "ZOTERO").map((p) => p.id)).toEqual(["zotero"]);
    expect(filterMarket(MARKET_PLUGINS, "whiteboard").map((p) => p.id)).toContain("excalidraw");
    expect(filterMarket(MARKET_PLUGINS, "deep links").map((p) => p.id)).toEqual(["advanced-uri"]);
  });
  test("no match → empty list", () => {
    expect(filterMarket(MARKET_PLUGINS, "definitely-not-a-plugin")).toHaveLength(0);
  });
});

describe("fmtDownloads", () => {
  test("millions get one decimal, a trailing .0 is dropped; thousands round to K; null/0 → empty", () => {
    expect(fmtDownloads(6_487_654)).toBe("6.5M");
    expect(fmtDownloads(2_765_510)).toBe("2.8M");
    expect(fmtDownloads(1_000_000)).toBe("1M");
    expect(fmtDownloads(412_000)).toBe("412K");
    expect(fmtDownloads(999)).toBe("999");
    expect(fmtDownloads(null)).toBe("");
    expect(fmtDownloads(0)).toBe("");
  });
});

describe("html builders", () => {
  test("the modal has the search input, the list, and a close control; Excalidraw renders first", () => {
    const h = marketplaceHtml(MARKET_PLUGINS, "");
    expect(h).toContain('id="mktSearch"');
    expect(h).toContain('id="mktList"');
    expect(h).toContain("data-mkt-close");
    expect(h).toContain('role="dialog"');
    expect(h.indexOf('data-mkt-id="excalidraw"')).toBeLessThan(h.indexOf('data-mkt-id="git"'));
  });
  test("every row carries its repo on the View-repo button", () => {
    const h = marketRowsHtml(MARKET_PLUGINS, "");
    for (const p of MARKET_PLUGINS) expect(h).toContain(`data-mkt-repo="${p.repo}"`);
  });
  test("a no-match query renders the empty state with the query escaped", () => {
    const h = marketRowsHtml(MARKET_PLUGINS, '<script>alert(1)</script>');
    expect(h).toContain("mkt-empty");
    expect(h).not.toContain("<script>");
  });
  test("plugin-sourced strings are escaped (no raw HTML from the registry)", () => {
    const evil = mk({ name: '<img src=x onerror=alert(1)>', desc: '<b>d</b>', lucidPlan: '<i>p</i>' });
    const h = marketRowsHtml([evil], "");
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<b>");
    expect(h).not.toContain("<i>");
  });
});
