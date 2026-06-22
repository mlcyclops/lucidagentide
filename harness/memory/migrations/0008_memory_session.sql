-- migration 0007 — cross-session memory recall (ADR-0009 Phase A)
--
-- FROZEN once applied (invariant #10). ADDITIVE sidecar ONLY: records WHICH
-- semantic facts were recalled INTO WHICH later session, with provenance back to
-- the fact and the recalling run. Never ALTERs the frozen semantic_facts table.
--
-- buildRecall (harness/memory/recall.ts) reads trusted/untrusted facts (keystone
-- #2: suspicious/quarantined are never recallable) and writes one row here per
-- recalled fact, then emits the memory_recalled event.
CREATE TABLE fact_sessions (
  fact_id     VARCHAR NOT NULL REFERENCES semantic_facts(fact_id),
  session_id  VARCHAR NOT NULL,
  run_id      VARCHAR,
  recalled_at TIMESTAMP NOT NULL
);
