// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_resolve.test.ts — P-PREVIEW.1 (ADR-0096): the fail-safe preview-target resolver.

import { describe, expect, test } from "bun:test";
import { resolvePreview, toFileUrl } from "./preview_resolve.ts";

describe("toFileUrl", () => {
  test("leaves an existing file:// URL alone", () => {
    expect(toFileUrl("file:///C:/Users/n/game.html")).toBe("file:///C:/Users/n/game.html");
  });
  test("Windows drive path → file:/// with forward slashes", () => {
    expect(toFileUrl("C:\\Users\\n\\game.html")).toBe("file:///C:/Users/n/game.html");
    expect(toFileUrl("C:/Users/n/game.html")).toBe("file:///C:/Users/n/game.html");
  });
  test("POSIX absolute path → file://", () => {
    expect(toFileUrl("/home/n/game.html")).toBe("file:///home/n/game.html");
  });
});

describe("resolvePreview (fail-safe)", () => {
  test("a local file is rendered, with a filename label", () => {
    const r = resolvePreview("C:\\Users\\neorc\\Documents\\My Music\\hormuz-minesweeper.html");
    expect(r.kind).toBe("local");
    expect(r.src).toBe("file:///C:/Users/neorc/Documents/My Music/hormuz-minesweeper.html");
    expect(r.label).toBe("hormuz-minesweeper.html");
  });
  test("a file:// URL is local and keeps its src", () => {
    const r = resolvePreview("file:///home/n/game.html");
    expect(r.kind).toBe("local");
    expect(r.src).toBe("file:///home/n/game.html");
  });
  test("an http(s) URL is recognized as remote but NOT auto-loaded (src empty, gated)", () => {
    const r = resolvePreview("https://example.com/app");
    expect(r.kind).toBe("remote");
    expect(r.src).toBe("");
    expect(r.reason).toMatch(/gated/i);
  });
  test("empty / whitespace ⇒ blocked", () => {
    expect(resolvePreview("").kind).toBe("blocked");
    expect(resolvePreview("   ").kind).toBe("blocked");
    expect(resolvePreview(null).kind).toBe("blocked");
  });
  test("an ambiguous string (bare host / relative path) ⇒ blocked, never rendered", () => {
    expect(resolvePreview("example.com/x").kind).toBe("blocked");
    expect(resolvePreview("game.html").kind).toBe("blocked");
    const r = resolvePreview("game.html");
    expect(r.src).toBe("");
  });
});
