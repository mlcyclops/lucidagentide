-- migration 0007 — AI-LOC attribution ledger (P-LOC.1, ADR-0031)
--
-- FROZEN once applied (invariant #10). One row per AI-authored file mutation that
-- PASSED the security gate (a successful omp `write`/`edit` tool_result). This is the
-- honest "the AI wrote these lines" signal — counted in-process at the gate from omp's
-- own applied diff — as distinct from git activity (which can't attribute authorship to
-- a model). See DECISIONS.md ADR-0030 (why git is insufficient) and ADR-0031 (this).
--
-- added_lines / removed_lines come from omp's post-apply unified diff (edit) or the
-- written content (write); they are non-negative. `model` is the model that authored the
-- edit (threaded from the IDE via env at omp spawn); `identity` + `identity_source` are the
-- attribution identity (corporate email, or the workstation-name fallback — ADR-0030). repo
-- is the edited workspace; this differs from the observability DB's own location.

CREATE TABLE ai_loc_ledger (
  edit_id         VARCHAR PRIMARY KEY,           -- minted per recorded edit (invariant #9)
  run_id          VARCHAR,                       -- soft ref to runs.run_id (ADR-0005 soft run_ids)
  session_id      VARCHAR,
  model           VARCHAR NOT NULL,              -- authoring model id, or 'unknown' if not yet known
  identity        VARCHAR NOT NULL,              -- corporate email or workstation name (ADR-0030)
  identity_source VARCHAR NOT NULL,              -- 'email' | 'workstation' | 'unknown'
  repo            VARCHAR NOT NULL,              -- edited workspace path
  file_path       VARCHAR,                       -- file touched (relative or absolute, as omp reported)
  tool            VARCHAR NOT NULL,              -- 'write' | 'edit'
  added_lines     INTEGER NOT NULL,             -- >= 0
  removed_lines   INTEGER NOT NULL,             -- >= 0
  created_at      TIMESTAMP NOT NULL
);

-- Roll-up reads group by (model, repo, identity); index the hot grouping columns.
CREATE INDEX ai_loc_ledger_rollup ON ai_loc_ledger (model, repo, identity);
