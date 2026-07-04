-- migration 0010 — Agent Builder specs (P-AGENT.1, ADR-0129)
--
-- FROZEN once applied (invariant #10). ADDITIVE: stores each Agent Spec authored in the Builder. The full
-- validated spec lives in `json` (the single source of truth); the flat columns are denormalized for listing
-- and audit without parsing every row. `trust_label` is the closed-set label (a spec imported from an
-- untrusted source is stored suspicious/untrusted and never auto-run — enforced in later increments).
--
-- store.ts (harness/agent/store.ts) validates fail-closed BEFORE insert (a spec that fails validateSpec is
-- refused, never persisted) and re-validates on load (a corrupted row is not returned as a valid spec).
-- spec_id is a stable minted id (invariant #9). No FK — specs stand alone from the runs/security families.
CREATE TABLE agent_specs (
  spec_id      VARCHAR PRIMARY KEY,
  name         VARCHAR NOT NULL,
  spec_version INTEGER NOT NULL,
  mode         VARCHAR NOT NULL,
  self_edit    VARCHAR NOT NULL,
  trust_label  VARCHAR NOT NULL,
  json         VARCHAR NOT NULL,
  created_at   TIMESTAMP NOT NULL,
  updated_at   TIMESTAMP NOT NULL
);
