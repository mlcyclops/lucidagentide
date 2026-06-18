-- migration 0002 — telemetry ingestion table (P3.2)
--
-- FROZEN once applied (invariant #10). The JSONL telemetry stream (events.jsonl)
-- is ingested here so security events become queryable + replayable. event_id is
-- the stable per-event id (invariant #9) and the idempotent ingestion key:
-- re-ingesting the same file inserts zero new rows.
--
-- The fixed envelope columns are promoted for fast filtering and joins. Every
-- remaining field of an event is kept verbatim in `fields` (JSON) for ad-hoc
-- queries.

CREATE TABLE telemetry_events (
  event_id    VARCHAR PRIMARY KEY,
  ts          TIMESTAMP NOT NULL,
  event       VARCHAR NOT NULL,        -- an EventName (contracts.ts)
  run_id      VARCHAR NOT NULL,
  session_id  VARCHAR NOT NULL,
  artifact_id VARCHAR,                 -- present when an artifact is in scope
  fields      JSON,                    -- remaining event fields, verbatim
  ingested_at TIMESTAMP NOT NULL
);
