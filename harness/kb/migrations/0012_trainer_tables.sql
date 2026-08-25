-- migration 0012 - knowledge-trainer tables (ADR-0253, P-TRAINER.2)
--
-- FROZEN once applied (invariant #10). Lives in the kb migration set so a firm's extracted process
-- knowledge stays inside its per-KG kb_graph.duckdb and rides the existing registry, backup, and
-- .lkgpack machinery. The leading number continues the project's global migration numbering after
-- the 0011 pair (memory/0011 + kb/0011 collided; 0012 is the next free number).
--
-- coverage_objectives: the pack-authored coverage map - the TacticalGenAI objective map inverted:
--   how completely each part of a business role is CAPTURED, not learned. `elicitation` is JSON
--   (scenario seeds, direct probes, edge-case probes). `weight` is extraction priority.
-- knowledge_units: the distilled knowledge itself. kind procedure|edge_case|exception|checklist|
--   glossary|escalation (closed set enforced by the TS guard, invariant-7 style). APPEND-ONLY:
--   a correction mints a successor and sets superseded_by on the old row - never an in-place edit
--   (provenance chain, auditable in a regulated vertical). `trust_label` is the invariant-7 closed
--   set; `completeness` 0-100 is an ordinary column, never a trust signal. Coverage per objective
--   is DERIVED from live units by a pure function, never stored.
-- extraction_sessions: one interview sitting. `expert_label` is a display handle, deliberately not
--   an identity record.
-- teachback_results: the verification trail. A `confirmed` verdict carries the approval_events id
--   (agent_obs.duckdb) that unblocks the keystone-#2 promotion gate (ADR-0254).

CREATE TABLE coverage_objectives (
  objective_id VARCHAR PRIMARY KEY,      -- stable, pack-authored (e.g. 'wmo-2.1'), invariant #9
  pack_id      VARCHAR NOT NULL,
  domain       VARCHAR NOT NULL,
  title        VARCHAR NOT NULL,
  description  VARCHAR NOT NULL,
  weight       DOUBLE NOT NULL,          -- extraction priority (the exam-weight idea repurposed)
  elicitation  VARCHAR NOT NULL,         -- JSON: { scenarios[], probes[], edgeProbes[] }
  created_at   TIMESTAMP NOT NULL
);

CREATE TABLE knowledge_units (
  unit_id            VARCHAR PRIMARY KEY, -- minted once (invariant #9), never reused
  objective_id       VARCHAR NOT NULL REFERENCES coverage_objectives(objective_id),
  kind               VARCHAR NOT NULL,    -- procedure|edge_case|exception|checklist|glossary|escalation
  title              VARCHAR NOT NULL,
  body_md            VARCHAR NOT NULL,    -- re-scanned clean before store; PII redacted BEFORE storage
  structure          VARCHAR NOT NULL,    -- JSON: ordered steps (actor/system/timing) or trigger/resolution
  trust_label        VARCHAR NOT NULL,    -- invariant-7 closed set; born 'untrusted' (keystone #2)
  completeness       INTEGER NOT NULL,    -- 0-100, extraction completeness (never a trust signal)
  source_session_id  VARCHAR,             -- extraction_sessions ref
  source_artifact_id VARCHAR,             -- content_artifacts ref in agent_obs.duckdb (soft, cross-DB)
  confirmed_at       TIMESTAMP,           -- set by a confirmed teach-back, never at capture
  confirmed_by       VARCHAR,
  superseded_by      VARCHAR,             -- successor unit_id, or the teachback_id tombstone on reject
  created_at         TIMESTAMP NOT NULL
);

CREATE TABLE extraction_sessions (
  session_id   VARCHAR PRIMARY KEY,
  pack_id      VARCHAR NOT NULL,
  expert_label VARCHAR NOT NULL,          -- display handle only
  started_at   TIMESTAMP NOT NULL,
  ended_at     TIMESTAMP,
  stats        VARCHAR                    -- JSON summary written at close
);

CREATE TABLE teachback_results (
  teachback_id      VARCHAR PRIMARY KEY,
  unit_id           VARCHAR NOT NULL REFERENCES knowledge_units(unit_id),
  verdict           VARCHAR NOT NULL,     -- confirmed|corrected|rejected
  notes             VARCHAR,
  approval_event_id VARCHAR,              -- approval_events ref in agent_obs.duckdb (soft, cross-DB)
  created_at        TIMESTAMP NOT NULL
);

CREATE INDEX idx_coverage_objectives_pack ON coverage_objectives(pack_id);
CREATE INDEX idx_knowledge_units_objective ON knowledge_units(objective_id);
CREATE INDEX idx_knowledge_units_kind ON knowledge_units(kind);
CREATE INDEX idx_teachback_results_unit ON teachback_results(unit_id);
