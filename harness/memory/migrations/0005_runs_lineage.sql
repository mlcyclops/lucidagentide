-- migration 0005 — runs + lineage (P5.1)
--
-- FROZEN once applied (invariant #10). The runs table is the authoritative
-- parent/child lineage store for recursive execution. The soft run_id columns on
-- the security/telemetry/memory tables (ADR-0005) reference this table logically;
-- we do NOT retro-add FKs to them (DuckDB can't add FKs to existing tables, and
-- soft event run_ids are normal). parent_run_id is a soft self-reference for the
-- same reason (avoids insertion-order constraints on the tree).

CREATE TABLE runs (
  run_id          VARCHAR PRIMARY KEY,
  parent_run_id   VARCHAR,             -- NULL for root runs; soft self-reference
  session_id      VARCHAR,
  kind            VARCHAR NOT NULL,    -- root | subagent | security-review
  mode            VARCHAR,             -- plan|build|general|subagent|replay|security-review
  sandbox_profile VARCHAR,             -- trusted-local|container-local|remote-runner|read-only-audit|quarantine
  status          VARCHAR NOT NULL DEFAULT 'running',  -- running|completed|failed
  created_at      TIMESTAMP NOT NULL,
  ended_at        TIMESTAMP
);
