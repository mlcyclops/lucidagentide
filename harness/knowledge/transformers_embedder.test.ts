// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-RAG.1b (ADR-0063): TransformersEmbedder contract. The CHEAP checks (id/dim/empty-batch) run in the
// normal suite without loading the model. The real-model proof (slow: downloads/loads bge-small) is
// OPT-IN via LUCID_TEST_EMBED=1 and otherwise lives in `make demo-P-RAG.1b`, so `bun test harness`
// stays fast and never needs network/weights.

import { test, expect } from "bun:test";
import { TransformersEmbedder } from "./transformers_embedder.ts";

test("advertises bge-small-en-v1.5 @ 384 dim (the dataset vector-space tag)", () => {
  const e = new TransformersEmbedder();
  expect(e.id).toBe("bge-small-en-v1.5");
  expect(e.dim).toBe(384);
});

test("embed([]) is a no-op and never loads the model", async () => {
  const e = new TransformersEmbedder();
  expect(await e.embed([])).toEqual([]);
});

const realTest = process.env.LUCID_TEST_EMBED === "1" ? test : test.skip;
realTest("real embeddings are 384-dim, unit-norm, and SEMANTIC (cat~feline > cat~revenue)", async () => {
  const e = new TransformersEmbedder();
  const [cat, feline, revenue] = await e.embed([
    "the cat sat on the mat",
    "a feline rested on a rug",
    "quarterly revenue grew twelve percent",
  ]);
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
  expect(cat!.length).toBe(384);
  expect(Math.sqrt(dot(cat!, cat!))).toBeCloseTo(1, 3); // L2-normalized
  expect(dot(cat!, feline!)).toBeGreaterThan(dot(cat!, revenue!)); // meaning, not shared words
});
