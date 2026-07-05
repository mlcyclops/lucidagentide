// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/model_favorites.test.ts — P-FAV.1 (ADR-0165): favorite-star persistence + selection.
// Over-tests the defensive parse (this reads localStorage — user-editable, corruptible) and the
// pure toggle/selection invariants the picker render depends on.

import { describe, expect, test } from "bun:test";
import { MAX_FAVS, parseFavs, starredOf, toggleFav } from "./model_favorites.ts";

describe("parseFavs — defensive against corrupted storage", () => {
  test("null / empty / bad JSON / non-array → empty list, never a throw", () => {
    expect(parseFavs(null)).toEqual([]);
    expect(parseFavs("")).toEqual([]);
    expect(parseFavs("{oops")).toEqual([]);
    expect(parseFavs('{"a":1}')).toEqual([]);
    expect(parseFavs("42")).toEqual([]);
  });

  test("keeps only non-empty strings, dedupes, preserves order", () => {
    expect(parseFavs('["a", 1, "b", null, "a", "", "c"]')).toEqual(["a", "b", "c"]);
  });

  test("caps at MAX_FAVS", () => {
    const many = JSON.stringify(Array.from({ length: MAX_FAVS + 10 }, (_, i) => `m${i}`));
    expect(parseFavs(many).length).toBe(MAX_FAVS);
  });
});

describe("toggleFav — pure add/remove", () => {
  test("adds when absent, removes when present, never mutates the input", () => {
    const base = ["a", "b"];
    const added = toggleFav(base, "c");
    expect(added).toEqual(["a", "b", "c"]);
    const removed = toggleFav(added, "a");
    expect(removed).toEqual(["b", "c"]);
    expect(base).toEqual(["a", "b"]); // untouched
  });

  test("adding beyond MAX_FAVS drops the OLDEST so the new star sticks", () => {
    const full = Array.from({ length: MAX_FAVS }, (_, i) => `m${i}`);
    const next = toggleFav(full, "new");
    expect(next.length).toBe(MAX_FAVS);
    expect(next).toContain("new");
    expect(next).not.toContain("m0");
  });
});

describe("starredOf — the Favorites section content", () => {
  const models = [{ value: "gov-x" }, { value: "claude-a" }, { value: "gpt-b" }];

  test("returns starred models in the CATALOG's curated order, not the star order", () => {
    expect(starredOf(models, ["gpt-b", "gov-x"]).map((m) => m.value)).toEqual(["gov-x", "gpt-b"]);
  });

  test("stale favorites (not in the catalog) are hidden, not an error", () => {
    expect(starredOf(models, ["gone-model", "claude-a"]).map((m) => m.value)).toEqual(["claude-a"]);
  });

  test("no favorites → empty (no Favorites section)", () => {
    expect(starredOf(models, [])).toEqual([]);
  });
});
