-- migration 0009 — per-turn prompt/response transcripts (ADR-0009 Phase B, issue #12)
--
-- FROZEN once applied (invariant #10). ADDITIVE: records each captured turn with a
-- stable id, ordering (seq), role, the SANITIZED text (escapeMarkdown'd — the only
-- text ever rendered), and provenance to the RAW span preserved in archive_chunks
-- (by content_sha256). Never ALTERs a frozen table.
--
-- captureTurn (harness/memory/turns.ts) archives the raw text, escapes it, writes one
-- row here, and emits the metadata-only turn_captured event. raw_sha256 mirrors the
-- archive chunk's hash so a transcript can be re-joined to its raw source for replay.
--
-- run_id is a SOFT reference (no FK), matching fact_sessions (0008) — a turn may be
-- captured GUI-side before a runs row exists. session_id is required.
CREATE TABLE turns (
  turn_id          VARCHAR PRIMARY KEY,
  run_id           VARCHAR,
  session_id       VARCHAR NOT NULL,
  seq              INTEGER NOT NULL,
  role             VARCHAR NOT NULL,
  sanitized_text   VARCHAR NOT NULL,
  raw_sha256       VARCHAR NOT NULL,
  archive_chunk_id VARCHAR REFERENCES archive_chunks(chunk_id),
  trust_label      VARCHAR NOT NULL,
  created_at       TIMESTAMP NOT NULL
);
