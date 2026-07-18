// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pnvim6.ts
//
// P-NVIM.6 (view the knowledge graph from Neovim): the `lucid kb` data CLI that backs `:LucidKb`. Proves,
// against a seeded TEMP KG (never the user's ~/.omp), that:
// (1) the typed reads (kbList / kbPages / kbShow / kbSearch) return the KGs, pages, a page body, and hits;
// (2) `runKb(argv)` dispatches list | pages | show | search and honours --json (machine) vs text (terminal);
// (3) `show` on a missing page exits non-zero (so the Neovim client can surface "not found").
//
// Run: bun run harness/scripts/demo_pnvim6.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeKgId, kbStore, stopKb } from "../../desktop/kb_store.ts";
import { kbList, kbPages, kbSearch, kbShow, runKb } from "../../tools/kb_cli.ts";

const dir = mkdtempSync(join(tmpdir(), "lucid-pnvim6-"));
// Point the KG registry + store at the temp dir BEFORE any read (paths are read lazily, so this holds).
process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb");
process.env.LUCID_KG_REGISTRY_PATH = join(dir, "kg_registry.json");

async function fail(m: string): Promise<never> {
  await stopKb().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  console.error(`FAIL: ${m}`);
  process.exit(1);
}
const ok = (m: string): void => console.log(`   ok — ${m}`);
function isJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

try {
  console.log("P-NVIM.6 — the `lucid kb` KG viewer (seeded temp KG)");

  // Seed the active (default "My Knowledge") KG with two linked pages.
  const store = await kbStore();
  const p1 = await store.addPage({ kind: "concept", slug: "alpha", title: "Alpha concept", bodyMd: "Alpha is the first entry. It relates to beta.", trustLabel: "untrusted", classification: "U" });
  const p2 = await store.addPage({ kind: "entity", slug: "beta", title: "Beta entity", bodyMd: "Beta follows alpha in the graph.", trustLabel: "untrusted", classification: "U" });
  await store.addLink({ fromPageId: p1, toPageId: p2, relation: "related" });

  console.log("1) kbList — the KG picker data (active flag + page counts)");
  {
    const kgs = await kbList();
    const active = kgs.find((k) => k.active);
    if (!active) await fail("exactly one KG must be marked active");
    if ((active?.pages ?? 0) < 2) await fail("the active KG must report its 2 seeded pages");
    const out = (await runKb(["list", "--json"])).out;
    if (!isJson(out) || !out.includes(active!.name)) await fail("runKb list --json must emit valid JSON naming the KG");
    if (!(await runKb(["list"])).out.includes("*")) await fail("runKb list (text) must mark the active KG with *");
    ok(`${kgs.length} KG(s); active "${active!.name}" with ${active!.pages} pages`);
  }

  console.log("2) kbPages — the active KG's pages");
  {
    const pages = await kbPages();
    if (pages.length !== 2) await fail(`expected 2 pages, got ${pages.length}`);
    if (!pages.some((p) => p.slug === "alpha") || !pages.some((p) => p.slug === "beta")) await fail("pages must include alpha + beta");
    const out = (await runKb(["pages", "--json"])).out;
    if (!isJson(out) || !out.includes("Alpha concept")) await fail("runKb pages --json must list the pages");
    ok(`${pages.length} pages: ${pages.map((p) => p.slug).join(", ")}`);
  }

  console.log("3) kbShow — a page body (by slug or id)");
  {
    const bySlug = await kbShow("alpha");
    if (!bySlug || bySlug.title !== "Alpha concept" || !bySlug.body_md.includes("first entry")) await fail("kbShow(slug) must return the page body");
    const byId = await kbShow(p2);
    if (!byId || byId.slug !== "beta") await fail("kbShow(page_id) must resolve by id too");
    const show = await runKb(["show", "alpha", "--json"]);
    if (show.code !== 0 || !show.out.includes("Alpha concept")) await fail("runKb show --json must emit the page");
    const missing = await runKb(["show", "does-not-exist", "--json"]);
    if (missing.code !== 1) await fail("runKb show on a missing page must exit 1 (so the client shows 'not found')");
    ok("show by slug + by id; missing page → exit 1");
  }

  console.log("4) kbSearch — lexical search, title matches first");
  {
    const hits = await kbSearch("beta");
    if (hits.length === 0 || hits[0]?.slug !== "beta") await fail("search 'beta' must rank the beta page first");
    if (!hits[0]?.snippet) await fail("a hit must carry a snippet");
    const out = (await runKb(["search", "alpha", "--json"])).out;
    if (!isJson(out) || !out.includes("Alpha")) await fail("runKb search --json must emit hits");
    ok(`search 'beta' → ${hits.length} hit(s), top = ${hits[0]?.slug}`);
  }

  console.log("\nsample `lucid kb list` (text):\n");
  console.log((await runKb(["list"])).out);

  await stopKb().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  console.log("\ndemo_pnvim6 OK — `lucid kb` reads the shared KG registry; :LucidKb has its data source.");
  process.exit(0);
} catch (e) {
  await fail(e instanceof Error ? (e.stack ?? e.message) : String(e));
}
