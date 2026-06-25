// harness/knowledge/embedder.test.ts — the deterministic stub embedder: shape, normalization,
// determinism, and that shared-vocabulary texts embed closer than unrelated ones (so retrieval ranks).

import { describe, expect, test } from "bun:test";
import { HashEmbedder } from "./embedder.ts";

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

describe("HashEmbedder", () => {
  const emb = new HashEmbedder(128);

  test("id and dim are exposed and consistent", () => {
    expect(emb.dim).toBe(128);
    expect(emb.id).toBe("hash-bow-128");
  });

  test("produces unit-length vectors of the right dim", async () => {
    const [v] = await emb.embed(["the quick brown fox"]);
    expect(v!.length).toBe(128);
    const norm = Math.sqrt(dot(v!, v!));
    expect(norm).toBeCloseTo(1, 5);
  });

  test("deterministic for the same input", async () => {
    const [a] = await emb.embed(["hello knowledge base"]);
    const [b] = await emb.embed(["hello knowledge base"]);
    expect(a).toEqual(b!);
  });

  test("empty text → all-zeros (no NaN from normalization)", async () => {
    const [v] = await emb.embed([""]);
    expect(v!.every((x) => x === 0)).toBe(true);
  });

  test("shared vocabulary ranks closer than unrelated text", async () => {
    const [base, near, far] = await emb.embed([
      "duckdb stores vectors for retrieval",
      "vectors for retrieval are stored in duckdb",
      "the weather today is sunny and warm",
    ]);
    expect(dot(base!, near!)).toBeGreaterThan(dot(base!, far!));
  });
});
