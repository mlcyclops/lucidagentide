-- migration 0003 — memory layers (P4.1)
--
-- FROZEN once applied (invariant #10). Working / semantic / archive layers.
-- Episodic events are served by telemetry_events (0002) for now.
--
-- Every promoted/referenced memory item carries security metadata: a
-- trust_label and provenance back to the source artifact + archived raw span.
-- This is what the P4.3 semantic-promotion gate enforces (keystone #2).

-- Working memory: one current-state snapshot per run.
CREATE TABLE working_state (
  run_id      VARCHAR PRIMARY KEY,
  goal        VARCHAR,
  next_step   VARCHAR,
  blockers    VARCHAR,
  trust_label VARCHAR NOT NULL DEFAULT 'trusted',
  updated_at  TIMESTAMP NOT NULL
);

-- Archive: raw source-of-truth spans, preserved for replay/incident review.
CREATE TABLE archive_chunks (
  chunk_id       VARCHAR PRIMARY KEY,
  run_id         VARCHAR,
  artifact_id    VARCHAR REFERENCES content_artifacts(artifact_id),
  content        VARCHAR NOT NULL,
  content_sha256 VARCHAR NOT NULL,
  created_at     TIMESTAMP NOT NULL
);

-- Semantic memory: stable validated facts, each provenance-backed + trust-labeled.
CREATE TABLE semantic_entities (
  entity_id   VARCHAR PRIMARY KEY,
  name        VARCHAR NOT NULL UNIQUE,
  kind        VARCHAR,
  trust_label VARCHAR NOT NULL,
  created_at  TIMESTAMP NOT NULL
);

CREATE TABLE semantic_facts (
  fact_id                 VARCHAR PRIMARY KEY,
  entity_id               VARCHAR REFERENCES semantic_entities(entity_id),
  statement               VARCHAR NOT NULL,
  source_artifact_id      VARCHAR REFERENCES content_artifacts(artifact_id),
  source_archive_chunk_id VARCHAR REFERENCES archive_chunks(chunk_id),
  trust_label             VARCHAR NOT NULL,
  promoted_at             TIMESTAMP NOT NULL
);

CREATE TABLE semantic_links (
  link_id        VARCHAR PRIMARY KEY,
  from_entity_id VARCHAR REFERENCES semantic_entities(entity_id),
  to_entity_id   VARCHAR REFERENCES semantic_entities(entity_id),
  relation       VARCHAR NOT NULL,
  created_at     TIMESTAMP NOT NULL
);
