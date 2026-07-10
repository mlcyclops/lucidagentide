// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/kg_packs.test.ts — P-KGPACK.5 (ADR-0205): the Role KG Packs catalog (pure builders).
// Pins: the curated registry is well-formed (stable unique ids, a product url + author on every row), the
// filter is a case-insensitive substring over the row fields, rows carry a "Get pack" repo handle + a role
// chip, the modal exposes search + list + the gated "Import a pack you own" action, and copy is escaped.

import { describe, expect, test } from "bun:test";
import { KG_PACKS, KG_PACKS_URL, filterKgPacks, kgPackRowsHtml, kgPacksHtml, type KgPack } from "./kg_packs.ts";

describe("KG_PACKS registry", () => {
  test("every pack has a stable unique id, a product url, and an author", () => {
    expect(KG_PACKS.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(KG_PACKS.map((p) => p.id));
    expect(ids.size).toBe(KG_PACKS.length); // ids are unique
    for (const p of KG_PACKS) {
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
      expect(p.url).toBe(KG_PACKS_URL);
      expect(p.author).toBeTruthy();
      expect(["first-party", "community"]).toContain(p.tier);
      expect(["one-time", "subscription"]).toContain(p.licensing); // P-KGMARKET.1
    }
  });
});

describe("filterKgPacks", () => {
  test("case-insensitive substring over name/role/desc/author/highlights; empty → everything", () => {
    expect(filterKgPacks(KG_PACKS, "")).toHaveLength(KG_PACKS.length);
    expect(filterKgPacks(KG_PACKS, "   ")).toHaveLength(KG_PACKS.length);
    expect(filterKgPacks(KG_PACKS, "contracts").some((p) => p.id === "govcon-contracts-officer")).toBe(true);
    expect(filterKgPacks(KG_PACKS, "RMF").some((p) => p.id === "cmmc-rmf-security-lead")).toBe(true);
    expect(filterKgPacks(KG_PACKS, "zzzznope")).toHaveLength(0);
  });
});

describe("kgPackRowsHtml", () => {
  test("each row carries a Get-pack handle (the pack id) + role + a licensing chip; empty search shows a message", () => {
    const h = kgPackRowsHtml(KG_PACKS, "");
    for (const p of KG_PACKS) expect(h).toContain(`data-kgpack-get="${p.id}"`);
    expect(h).toContain("Get pack");
    expect(h).toContain("Contracting Officer / Specialist"); // the role chip
    expect(h).toContain(">One-time<");     // licensing chips (P-KGMARKET.1)
    expect(h).toContain(">Subscription<");
    expect(kgPackRowsHtml(KG_PACKS, "zzzznope")).toContain("No KG pack matches");
  });

  test("a hostile pack name is escaped (defensive — catalog copy is first-party, but rows are built the same way)", () => {
    const evil: KgPack = { id: "x", name: "<img src=x onerror=alert(1)>", role: "R", desc: "d", author: "a", tier: "community", licensing: "one-time", url: KG_PACKS_URL, highlights: "h" };
    const h = kgPackRowsHtml([evil], "");
    expect(h).toContain("&lt;img");
    expect(h).not.toContain("<img src=x");
  });
});

describe("kgPacksHtml", () => {
  test("the modal has search, list, a close handle, and the gated import action", () => {
    const h = kgPacksHtml(KG_PACKS, "");
    expect(h).toContain('id="kgpackSearch"');
    expect(h).toContain('id="kgpackList"');
    expect(h).toContain("data-kgpack-close");
    expect(h).toContain("data-kgpack-import");
    expect(h).toContain("Import a pack you own");
    expect(h).toContain("re-scanned"); // the note explains packs are gated on import
  });
});
