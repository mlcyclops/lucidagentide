-- migration 0010 — knowledge vector store (ADR-0053 / ADR-0054, P-RAG.1)
--
-- FROZEN once applied (invariant #10). Lives in its OWN migration set
-- (harness/knowledge/migrations) applied to a SEPARATE knowledge.duckdb, so it never
-- touches agent_obs.duckdb and there is no write-lock contention with omp's writer
-- (ADR-0053 decision #3). The leading number 0010 keeps the project's migration
-- numbering globally unique/ADR-aligned even though this is a distinct database.
--
-- kb_datasets: one row per named knowledge collection. classification is U | CUI
-- (compartment model, ADR-0012); source is local | asksage; embedding_model + dim
-- pin the vector space so retrieval never mixes incompatible embeddings.
--
-- kb_chunks: the embedded text units. Every chunk was SCANNED fail-closed before it
-- was stored (invariant #3/#5) and carries the resulting trust_label; quarantined
-- content is never written here. embedding is a fixed-width FLOAT[dim] used by
-- DuckDB's built-in array_cosine_distance for brute-force retrieval (no vss/HNSW
-- extension — air-gap clean, ADR-0053). artifact_id is a SOFT reference to the
-- content_artifacts row in the core DB (cross-database, so no FK).
CREATE TABLE kb_datasets (
  dataset_id      VARCHAR PRIMARY KEY,
  name            VARCHAR NOT NULL,
  classification  VARCHAR NOT NULL,   -- 'U' | 'CUI'
  source          VARCHAR NOT NULL,   -- 'local' | 'asksage'
  embedding_model VARCHAR NOT NULL,
  dim             INTEGER NOT NULL,
  created_at      TIMESTAMP NOT NULL
);

CREATE TABLE kb_chunks (
  chunk_id    VARCHAR PRIMARY KEY,
  dataset_id  VARCHAR NOT NULL REFERENCES kb_datasets(dataset_id),
  artifact_id VARCHAR,                -- soft ref to content_artifacts (separate DB)
  source_path VARCHAR NOT NULL,       -- the file/origin this chunk came from
  ordinal     INTEGER NOT NULL,       -- chunk order within its source
  text        VARCHAR NOT NULL,       -- the sanitized chunk text (scanned clean)
  trust_label VARCHAR NOT NULL,       -- trusted | suspicious (quarantined never stored)
  embedding   FLOAT[] NOT NULL,       -- length == dataset.dim
  dim         INTEGER NOT NULL,
  created_at  TIMESTAMP NOT NULL
);

CREATE INDEX idx_kb_chunks_dataset ON kb_chunks(dataset_id);
