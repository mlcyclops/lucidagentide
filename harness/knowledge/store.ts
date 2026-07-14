// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/knowledge/store.ts
//
// P-RAG.1 (ADR-0058): the local knowledge vector store. Wraps a SEPARATE knowledge.duckdb (its own
// migration set, ADR-0053 decision #3) and exposes dataset + chunk CRUD and brute-force cosine
// retrieval over DuckDB's built-in `list_cosine_distance` — no vss/HNSW extension, so it runs
// air-gapped (invariant: air-gap clean).
//
// Vectors are stored/queried as inlined numeric SQL list literals: the @duckdb/node-api binding
// rejects a JS array bound as a parameter ("Cannot create values of type ANY"), and the components are
// machine-generated finite floats (never user text), so inlining is safe and keeps retrieval in SQL.

import { join } from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Db } from "../memory/db.ts";

export const KNOWLEDGE_MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export type Classification = "U" | "CUI";
export type KbSource = "local" | "asksage";

export interface KbDataset {
  dataset_id: string;
  name: string;
  classification: Classification;
  source: KbSource;
  embedding_model: string;
  dim: number;
  created_at: string;
}

export interface KbChunkInput {
  datasetId: string;
  artifactId?: string | null;
  sourcePath: string;
  ordinal: number;
  text: string;
  trustLabel: string;
  embedding: number[];
}

export interface RetrievedChunk {
  chunk_id: string;
  dataset_id: string;
  source_path: string;
  ordinal: number;
  text: string;
  trust_label: string;
  distance: number;
}

/** Render a vector as a DuckDB numeric list literal `[a,b,c]`. Throws on a non-finite component so a
 *  bad embedding can never be silently stored or queried (NaN would poison cosine distance). */
function floatList(v: number[]): string {
  return "[" + v.map((x) => {
    if (!Number.isFinite(x)) throw new Error("non-finite embedding component");
    return x;
  }).join(",") + "]";
}

export class KnowledgeStore {
  private constructor(private readonly db: Db) {}

  /** Open (or create) knowledge.duckdb at `path` and apply the knowledge migration set. */
  static async open(path: string): Promise<KnowledgeStore> {
    return new KnowledgeStore(await Db.open(path, KNOWLEDGE_MIGRATIONS_DIR));
  }

  close(): void { this.db.close(); }

  async createDataset(opts: {
    name: string;
    classification: Classification;
    source: KbSource;
    embeddingModel: string;
    dim: number;
  }): Promise<KbDataset> {
    const dataset_id = Snowflake.next();
    const created_at = new Date().toISOString();
    await this.db.run(
      "INSERT INTO kb_datasets VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [dataset_id, opts.name, opts.classification, opts.source, opts.embeddingModel, opts.dim, created_at],
    );
    return { dataset_id, name: opts.name, classification: opts.classification, source: opts.source, embedding_model: opts.embeddingModel, dim: opts.dim, created_at };
  }

  async getDataset(id: string): Promise<KbDataset | undefined> {
    return (await this.db.get("SELECT * FROM kb_datasets WHERE dataset_id = $1", [id])) as KbDataset | undefined;
  }

  async listDatasets(): Promise<KbDataset[]> {
    return (await this.db.all("SELECT * FROM kb_datasets ORDER BY created_at DESC")) as unknown as KbDataset[];
  }

  /** Insert one already-scanned, already-embedded chunk. Mints its stable id. The embedding length
   *  must match the dataset's dim — enforced here so a vector-space mismatch fails loudly at write,
   *  never silently at retrieval. */
  async addChunk(c: KbChunkInput): Promise<string> {
    const ds = await this.getDataset(c.datasetId);
    if (!ds) throw new Error(`unknown dataset: ${c.datasetId}`);
    if (c.embedding.length !== ds.dim) {
      throw new Error(`embedding dim ${c.embedding.length} != dataset dim ${ds.dim}`);
    }
    const chunk_id = Snowflake.next();
    await this.db.run(
      `INSERT INTO kb_chunks (chunk_id, dataset_id, artifact_id, source_path, ordinal, text, trust_label, embedding, dim, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, ${floatList(c.embedding)}, $8, $9)`,
      [chunk_id, c.datasetId, c.artifactId ?? null, c.sourcePath, c.ordinal, c.text, c.trustLabel, c.embedding.length, new Date().toISOString()],
    );
    return chunk_id;
  }

  /** Brute-force top-k within a dataset, nearest first (ascending cosine distance). */
  async retrieve(datasetId: string, queryEmbedding: number[], k: number = 5): Promise<RetrievedChunk[]> {
    const rows = await this.db.all(
      `SELECT chunk_id, dataset_id, source_path, ordinal, text, trust_label,
              list_cosine_distance(embedding, ${floatList(queryEmbedding)}) AS distance
       FROM kb_chunks WHERE dataset_id = $1
       ORDER BY distance ASC LIMIT $2`,
      [datasetId, Math.max(1, Math.floor(k))],
    );
    return rows.map((r) => ({
      chunk_id: String(r.chunk_id),
      dataset_id: String(r.dataset_id),
      source_path: String(r.source_path),
      ordinal: Number(r.ordinal),
      text: String(r.text),
      trust_label: String(r.trust_label),
      distance: Number(r.distance),
    }));
  }

  async chunkCount(datasetId: string): Promise<number> {
    const r = await this.db.get("SELECT count(*) AS n FROM kb_chunks WHERE dataset_id = $1", [datasetId]);
    return Number(r?.n ?? 0);
  }

  /** ADR-0215: drop all chunks in a dataset so a re-index rebuilds it cleanly (idempotent, no duplicates). */
  async clearChunks(datasetId: string): Promise<void> {
    await this.db.run("DELETE FROM kb_chunks WHERE dataset_id = $1", [datasetId]);
  }
}
