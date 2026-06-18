-- migration 0001 — security tables (PRD "Security table intent", P2.2)
--
-- FROZEN once applied (CLAUDE.md invariant #10). NEVER edit this file after it
-- has been applied to any database — add a new numbered migration instead.
--
-- run_id is a SOFT reference to the future runs(run_id): the identity tables
-- (projects/sessions/runs) land in a later increment (P3.2). FKs are enforced
-- WITHIN the security family, where they matter for P2.3 ingestion integrity.

CREATE TABLE content_artifacts (
  artifact_id   VARCHAR PRIMARY KEY,
  run_id        VARCHAR,                 -- soft ref to runs(run_id) (deferred)
  source_type   VARCHAR NOT NULL,        -- paste|import|retrieval|comment|generated|...
  source_path   VARCHAR,
  trust_label   VARCHAR NOT NULL,        -- trusted|untrusted|suspicious|quarantined
  raw_content   VARCHAR,                 -- raw original preserved for forensics
  raw_sha256    VARCHAR NOT NULL,
  created_at    TIMESTAMP NOT NULL
);

CREATE TABLE content_scans (
  scan_id         VARCHAR PRIMARY KEY,
  artifact_id     VARCHAR NOT NULL REFERENCES content_artifacts(artifact_id),
  scanner_name    VARCHAR NOT NULL,
  scanner_version VARCHAR NOT NULL,
  verdict         VARCHAR NOT NULL,      -- clean|suspicious|quarantined
  risk_score      DOUBLE,
  finding_count   INTEGER NOT NULL DEFAULT 0,
  fail_closed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMP NOT NULL
);

CREATE TABLE security_findings (
  finding_id   VARCHAR PRIMARY KEY,
  scan_id      VARCHAR NOT NULL REFERENCES content_scans(scan_id),
  finding_type VARCHAR NOT NULL,         -- zero-width|unicode-tag-block|bidi-control|...
  severity     VARCHAR NOT NULL,         -- info|low|medium|high|critical
  codepoint    VARCHAR,                  -- "U+XXXX"
  char_index   INTEGER,
  description  VARCHAR,
  created_at   TIMESTAMP NOT NULL
);

CREATE TABLE sanitized_artifacts (
  sanitized_id      VARCHAR PRIMARY KEY,
  artifact_id       VARCHAR NOT NULL REFERENCES content_artifacts(artifact_id),
  scan_id           VARCHAR REFERENCES content_scans(scan_id),
  policy            VARCHAR NOT NULL,    -- e.g. "NFKC+strip(zero-width,tag,bidi)"
  sanitized_content VARCHAR NOT NULL,    -- safe derivative for prompts/memory/export
  sanitized_sha256  VARCHAR NOT NULL,
  changed           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMP NOT NULL
);

CREATE TABLE approval_events (
  approval_id VARCHAR PRIMARY KEY,
  artifact_id VARCHAR REFERENCES content_artifacts(artifact_id),
  action      VARCHAR NOT NULL,          -- approve|deny|quarantine_release|promotion_approve
  decided_by  VARCHAR NOT NULL,
  rationale   VARCHAR,
  scope       VARCHAR,
  created_at  TIMESTAMP NOT NULL
);

CREATE TABLE export_events (
  export_id           VARCHAR PRIMARY KEY,
  export_type         VARCHAR NOT NULL,  -- md_report|csv|json_bundle|dashboard_feed
  source_artifact_ids JSON,
  sanitization_status VARCHAR,
  included_raw        BOOLEAN NOT NULL DEFAULT FALSE,
  reviewer            VARCHAR,
  payload_sha256      VARCHAR,
  created_at          TIMESTAMP NOT NULL
);

CREATE TABLE security_alerts (
  alert_id    VARCHAR PRIMARY KEY,
  artifact_id VARCHAR REFERENCES content_artifacts(artifact_id),
  severity    VARCHAR NOT NULL,
  state       VARCHAR NOT NULL,          -- open|acknowledged|resolved
  summary     VARCHAR,
  created_at  TIMESTAMP NOT NULL
);
