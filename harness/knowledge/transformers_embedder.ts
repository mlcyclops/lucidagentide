// harness/knowledge/transformers_embedder.ts
//
// P-RAG.1b (ADR-0063): the REAL embedder behind the P-RAG.1 `Embedder` seam (ADR-0058). Drops in
// `bge-small-en-v1.5` (384-dim) via transformers.js, replacing the HashEmbedder stub with genuine
// SEMANTIC vectors — documents that MEAN the same thing now rank close even with no shared words
// (the hash bag-of-words stub can only match shared vocabulary). Same `Embedder` interface, so
// ingest.ts / store.ts and every test are untouched: tests keep HashEmbedder, production swaps this in.
//
// Air-gap (ADR-0053): pass `modelPath` to load BUNDLED weights with the network disabled, so an
// offline / air-gapped deployment never reaches the HuggingFace Hub. Without it, the model is fetched
// once and cached (dev / connected).
//
// Backend note: transformers.js's Node build runs onnxruntime-node (native CPU) — fine for the harness
// + dev server (where ingest/retrieval run today). The packaged desktop app excludes that native binary
// in favor of a WASM backend (ADR-0053); wiring the WASM web build into the SHIPPED app is the
// P-RAG.1c packaging step. This module is backend-agnostic — callers only see `Embedder` — so that
// switch never touches ingest or retrieval.

import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { Embedder } from "./embedder.ts";

const MODEL_ID = "Xenova/bge-small-en-v1.5"; // the ONNX build on the Hub
const DIM = 384;

export interface TransformersEmbedderOptions {
  /** A local directory of bundled model weights. When set, remote model fetches are DISABLED
   *  (air-gap): transformers.js loads ONLY from this path, never the network. */
  modelPath?: string;
}

export class TransformersEmbedder implements Embedder {
  readonly id = "bge-small-en-v1.5"; // recorded on the dataset as its vector-space tag
  readonly dim = DIM;
  private pipe: Promise<FeatureExtractionPipeline> | null = null;

  constructor(private readonly opts: TransformersEmbedderOptions = {}) {}

  /** Lazily load the model ONCE and reuse it across calls. */
  private load(): Promise<FeatureExtractionPipeline> {
    if (!this.pipe) {
      if (this.opts.modelPath) {
        env.localModelPath = this.opts.modelPath;
        env.allowRemoteModels = false; // air-gap: never touch the network
      }
      this.pipe = pipeline("feature-extraction", MODEL_ID) as Promise<FeatureExtractionPipeline>;
    }
    return this.pipe;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []; // no-op, and no model load for an empty batch
    const pipe = await this.load();
    // bge wants mean-pooled + L2-normalized sentence embeddings → unit vectors for cosine.
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    const rows = out.tolist() as number[][];
    // Fail LOUD on a dim mismatch — a wrong-width vector would silently poison cosine retrieval.
    if (rows[0] && rows[0].length !== DIM) {
      throw new Error(`TransformersEmbedder: expected ${DIM}-dim vectors, got ${rows[0].length}`);
    }
    return rows;
  }
}
