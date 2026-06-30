// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_file.test.ts — P-PREVIEW.4 (ADR-0096): the local-file content reader behind srcdoc render.

import { describe, expect, test } from "bun:test";
import { readPreviewFile } from "./preview_file.ts";

const io = (content: string, bytes = content.length) => ({ read: () => content, size: () => bytes });

describe("readPreviewFile", () => {
  test("reads a local .html file's content (+ filename label)", () => {
    const r = readPreviewFile("C:/Users/n/game.html", io("<h1>hi</h1>"));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.html).toBe("<h1>hi</h1>"); expect(r.label).toBe("game.html"); }
  });
  test("strips a file:// scheme before reading", () => {
    const seen: string[] = [];
    const r = readPreviewFile("file:///C:/Users/n/app.html", { read: (p) => { seen.push(p); return "x"; }, size: () => 1 });
    expect(r.ok).toBe(true);
    expect(seen[0]).toBe("C:/Users/n/app.html"); // scheme + leading slash stripped
  });
  test("rejects a non-local path", () => {
    expect(readPreviewFile("game.html", io("x")).ok).toBe(false);            // relative
    expect(readPreviewFile("https://x.com/a.html", io("x")).ok).toBe(false); // remote
  });
  test("rejects a non-previewable extension", () => {
    expect(readPreviewFile("/home/n/app.ts", io("x")).ok).toBe(false);
    expect(readPreviewFile("/home/n/notes.md", io("x")).ok).toBe(false);
  });
  test("rejects a file over the 5 MB cap (never reads it)", () => {
    let readCalled = false;
    const r = readPreviewFile("/a/big.html", { read: () => { readCalled = true; return ""; }, size: () => 6 * 1024 * 1024 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/large/);
    expect(readCalled).toBe(false);
  });
  test("a read/stat failure → typed error, never throws", () => {
    const r = readPreviewFile("/a/missing.html", { read: () => { throw new Error("ENOENT"); }, size: () => { throw new Error("ENOENT"); } });
    expect(r.ok).toBe(false);
  });
});
