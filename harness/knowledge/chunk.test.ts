// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/knowledge/chunk.test.ts — pure chunking: bounds, overlap, boundary preference, determinism.

import { describe, expect, test } from "bun:test";
import { chunkText } from "./chunk.ts";

describe("chunkText", () => {
  test("short text returns a single trimmed chunk", () => {
    expect(chunkText("  hello world  ")).toEqual(["hello world"]);
  });

  test("empty / whitespace-only returns no chunks", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t  ")).toEqual([]);
  });

  test("long text splits into multiple chunks under the size bound", () => {
    const text = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} has some words in it.`).join(" ");
    const chunks = chunkText(text, { maxChars: 200, overlapChars: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });

  test("consecutive chunks overlap (carry-over context)", () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(text, { maxChars: 60, overlapChars: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    // the tail of chunk[0] should reappear at the head of chunk[1]
    const tail = chunks[0]!.slice(-10);
    expect(chunks[1]!.includes(tail.trim().split(" ")[0]!)).toBe(true);
  });

  test("deterministic: same input → same chunks", () => {
    const text = "Alpha beta gamma. ".repeat(80);
    expect(chunkText(text, { maxChars: 150 })).toEqual(chunkText(text, { maxChars: 150 }));
  });

  test("prefers a sentence boundary near the window end", () => {
    // The sentence ends at char ~36 — inside the chunker's last-40% preference band for a 40-char window.
    const text = "Alpha beta gamma delta epsilon zeta. Then come many more words after the boundary here.";
    const chunks = chunkText(text, { maxChars: 40, overlapChars: 5 });
    expect(chunks[0]!.endsWith(".")).toBe(true);
  });
});
