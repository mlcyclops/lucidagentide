-- migration 0004 — compaction tables (P4.2)
--
-- FROZEN once applied (invariant #10). Compaction is a deliberate transform:
-- summaries are generated from SANITIZED derivatives (never raw), raw spans are
-- kept in archive_chunks, and provenance + security findings tied to the span
-- are preserved.

CREATE TABLE compaction_spans (
  span_id       VARCHAR PRIMARY KEY,
  run_id        VARCHAR,
  trigger       VARCHAR NOT NULL,        -- token_threshold|verification_milestone|session_boundary|manual|handoff|security
  artifact_ids  JSON,                    -- artifacts covered by this span
  finding_count INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMP NOT NULL
);

CREATE TABLE compaction_summaries (
  summary_id     VARCHAR PRIMARY KEY,
  span_id        VARCHAR NOT NULL REFERENCES compaction_spans(span_id),
  generated_from VARCHAR NOT NULL,       -- always 'sanitized' (never 'raw')
  summary        VARCHAR NOT NULL,
  summary_sha256 VARCHAR NOT NULL,
  created_at     TIMESTAMP NOT NULL
);

-- Per-artifact promotion eligibility decided at compaction time. Suspicious /
-- quarantined sources are NOT eligible (promoted=false); the enforced gate that
-- consumes this is P4.3.
CREATE TABLE compaction_promotions (
  promotion_id VARCHAR PRIMARY KEY,
  span_id      VARCHAR NOT NULL REFERENCES compaction_spans(span_id),
  artifact_id  VARCHAR REFERENCES content_artifacts(artifact_id),
  trust_label  VARCHAR NOT NULL,
  promoted     BOOLEAN NOT NULL,
  reason       VARCHAR,
  created_at   TIMESTAMP NOT NULL
);
