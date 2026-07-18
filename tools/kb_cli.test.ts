// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kbList, kbPages, kbShow, kbSearch, snippetAround, runKb } from "./kb_cli.ts";
import {
  _resetKbStoreForTest, kbStore, activeKgId, createKg, setActiveKg, stopKb,
} from "../desktop/kb_store.ts";

describe("kb_cli", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kb-cli-"));
    process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb");
    process.env.LUCID_KG_REGISTRY_PATH = join(dir, "kg_registry.json");
    _resetKbStoreForTest();
  });
  afterEach(async () => {
    await stopKb();
    delete process.env.LUCID_KB_DB_PATH;
    delete process.env.LUCID_KG_REGISTRY_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed() {
    const store = await kbStore();
    const alphaId = await store.addPage({ kind: "concept", slug: "alpha", title: "Alpha concept", bodyMd: "Alpha is first, relates to beta.", trustLabel: "untrusted", classification: "U" });
    const betaId = await store.addPage({ kind: "entity", slug: "beta", title: "Beta entity", bodyMd: "Beta follows alpha.", trustLabel: "untrusted", classification: "U" });
    return { alphaId, betaId };
  }

  // ── kbList ──────────────────────────────────────────────────────────────────

  test("returns ≥1 KG; exactly one active; active KG page count reflects seeded pages", async () => {
    await seed();
    const kgs = await kbList();
    expect(kgs.length).toBeGreaterThanOrEqual(1);
    const activeKgs = kgs.filter((k) => k.active);
    expect(activeKgs).toHaveLength(1);
    expect(activeKgs[0]!.pages).toBe(2);
  });

  // ── kbPages ─────────────────────────────────────────────────────────────────

  test("returns the seeded pages with kind/slug/title populated", async () => {
    await seed();
    const pages = await kbPages();
    const slugs = pages.map((p) => p.slug).sort();
    expect(slugs).toEqual(["alpha", "beta"]);
    for (const p of pages) {
      expect(p.kind).toBeTruthy();
      expect(p.slug).toBeTruthy();
      expect(p.title).toBeTruthy();
      expect(p.page_id).toBeTruthy();
    }
  });

  // ── kbShow ──────────────────────────────────────────────────────────────────

  test("by slug returns title + body", async () => {
    await seed();
    const page = await kbShow("alpha");
    expect(page).toBeDefined();
    expect(page!.title).toBe("Alpha concept");
    expect(page!.body_md).toContain("first");
  });

  test("by page_id resolves the same page", async () => {
    const { alphaId } = await seed();
    const page = await kbShow(alphaId);
    expect(page).toBeDefined();
    expect(page!.title).toBe("Alpha concept");
  });

  test("unknown id or slug → undefined", async () => {
    await seed();
    expect(await kbShow("nonexistent")).toBeUndefined();
  });

  test("JSON.stringify does not throw (BigInt regression guard)", async () => {
    await seed();
    const page = await kbShow("alpha");
    expect(page).toBeDefined();
    expect(() => JSON.stringify(page)).not.toThrow();
  });

  // ── kbSearch ────────────────────────────────────────────────────────────────

  test("'beta' → non-empty; first hit slug is beta (title match first); each hit has a snippet", async () => {
    await seed();
    const hits = await kbSearch("beta");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.slug).toBe("beta");
    for (const h of hits) {
      expect(h.snippet.length).toBeGreaterThan(0);
    }
  });

  test("empty query → []", async () => {
    await seed();
    expect(await kbSearch("")).toEqual([]);
  });

  // ── snippetAround ──────────────────────────────────────────────────────────

  test("centres on match and adds ellipses when truncated", () => {
    const body = "A".repeat(100) + " MATCH " + "B".repeat(100);
    const s = snippetAround(body, "match", 10);
    expect(s).toContain("MATCH");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
  });

  test("a miss returns a prefix of the body", () => {
    const body = "Some body text here about nothing.";
    const s = snippetAround(body, "zzzznotfound", 60);
    expect(s).toContain("Some body");
    expect(s).not.toContain("…");
  });

  // ── runKb ──────────────────────────────────────────────────────────────────

  test("list --json → parseable JSON array", async () => {
    await seed();
    const { code, out } = await runKb(["list", "--json"]);
    expect(code).toBe(0);
    let parsed: unknown;
    expect(() => { parsed = JSON.parse(out); }).not.toThrow();
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("list (text) contains '*' for the active KG", async () => {
    await seed();
    const { code, out } = await runKb(["list"]);
    expect(code).toBe(0);
    expect(out).toContain("*");
  });

  test("pages --json lists seeded pages", async () => {
    await seed();
    const { code, out } = await runKb(["pages", "--json"]);
    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    if (Array.isArray(parsed)) {
      expect(parsed).toHaveLength(2);
    }
  });

  test("show alpha --json → code 0, out contains 'Alpha concept'", async () => {
    await seed();
    const { code, out } = await runKb(["show", "alpha", "--json"]);
    expect(code).toBe(0);
    expect(out).toContain("Alpha concept");
  });

  test("show missing --json → code 1", async () => {
    await seed();
    const { code } = await runKb(["show", "missing", "--json"]);
    expect(code).toBe(1);
  });

  test("show (no arg) → code 2", async () => {
    await seed();
    const { code } = await runKb(["show"]);
    expect(code).toBe(2);
  });

  test("search beta --json → code 0, out mentions beta", async () => {
    await seed();
    const { code, out } = await runKb(["search", "beta", "--json"]);
    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("beta");
  });

  test("search (no query) → code 2", async () => {
    await seed();
    const { code } = await runKb(["search"]);
    expect(code).toBe(2);
  });

  test("bogus action → code 2", async () => {
    await seed();
    const { code } = await runKb(["bogus"]);
    expect(code).toBe(2);
  });

  test("--kg <id> targets a specific KG", async () => {
    await seed();
    const kg2 = createKg({ name: "Second KG" });
    const store2 = await kbStore(kg2.kg_id);
    await store2.addPage({ kind: "entity", slug: "gamma", title: "Gamma only", bodyMd: "Unique to KG2.", trustLabel: "untrusted", classification: "U" });

    const { code, out } = await runKb(["pages", "--kg", kg2.kg_id, "--json"]);
    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    if (Array.isArray(parsed)) {
      expect(parsed).toHaveLength(1);
      const first: unknown = parsed[0];
      expect(first).toBeDefined();
      expect(typeof first === "object" && first !== null && "slug" in first && first.slug).toBe("gamma");
    }
  });
});
