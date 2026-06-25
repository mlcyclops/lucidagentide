// harness/knowledge/embedder.ts
//
// P-RAG.1 (ADR-0058): the embedding seam. The ingest + retrieval pipeline depends on this interface,
// NOT on any concrete model, so the spine is testable and air-gap-clean today and the real model drops
// in later without touching callers.
//
// `HashEmbedder` is a deterministic, dependency-free embedder: a hashed bag-of-words projected into
// `dim` dimensions and L2-normalized, so array_cosine_distance is meaningful and documents that share
// vocabulary rank closer. It is good enough to PROVE the store/retrieval/scan-gate plumbing end to end
// without a network download. P-RAG.1b swaps in the real WASM `bge-small-en-v1.5` (384-dim) behind this
// same interface, with weights bundled as extraResources (ADR-0053).

export interface Embedder {
  readonly id: string;   // model identifier recorded on the dataset (vector-space tag)
  readonly dim: number;  // vector dimensionality
  /** Embed each text into a `dim`-length unit vector. Order-preserving. */
  embed(texts: string[]): Promise<number[][]>;
}

/** FNV-1a 32-bit hash of a token → stable bucket + sign, no deps. */
function hashToken(tok: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < tok.length; i++) {
    h ^= tok.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export class HashEmbedder implements Embedder {
  readonly id: string;
  constructor(readonly dim: number = 256) {
    this.id = `hash-bow-${dim}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    for (const tok of tokenize(text)) {
      const h = hashToken(tok);
      const bucket = h % this.dim;
      const sign = (h & 0x10000) ? 1 : -1; // a stable second bit decorrelates collisions
      v[bucket]! += sign;
    }
    // L2-normalize so cosine distance is purely directional (zero vector → all-zeros, distance 1).
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm === 0) return v;
    for (let i = 0; i < v.length; i++) v[i]! /= norm;
    return v;
  }
}
