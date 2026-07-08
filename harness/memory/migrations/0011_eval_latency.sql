-- migration 0011 — eval-metrics + per-model API-latency tables (P-EVAL.2, ADR-0187 / ADR-A016)
--
-- FROZEN once applied (CLAUDE.md invariant #10). NEVER edit this file after it has
-- been applied to any database — add a new numbered migration instead.
--
-- api_latency: one row per model turn, captured at the chat seam (t_sent / t_first_token /
-- t_end) GUI-side and ingested here by the single writer (the GUI opens this DB read-only,
-- so it appends to lucid-latency.jsonl and latency_ingest.ts loads it — mirrors telemetry
-- 0002 / events.jsonl). The promoted columns yield evals.ts's ApiLatencyCall exactly
-- { model, ts, ttftMs=ttft_ms, totalMs=total_ms, ok }; the extra columns are provenance.
-- `id` is the stable per-turn id (invariant #9) and the idempotent ingestion key.
--
-- eval_metrics: one row per RUN of the pure evals.ts computeEvalMetrics output. Values are
-- NULL-not-zero when the signal is absent (the honesty rule, ADR-A016); the per-metric tier
-- (direct | proxy | needs_signal) is preserved verbatim in `tiers` (JSON) so a stored row can
-- be rendered without recomputation. Created here as a frozen contract; population is P-EVAL.3.

CREATE TABLE api_latency (
  id           VARCHAR PRIMARY KEY,   -- stable per-turn id (sessionId + t_sent); idempotent key
  model        VARCHAR NOT NULL,
  ts           TIMESTAMP NOT NULL,    -- t_sent: when the prompt was sent to the model
  ttft_ms      INTEGER NOT NULL,      -- t_first_token - t_sent (0 when no token ever arrived)
  total_ms     INTEGER NOT NULL,      -- t_end - t_sent
  ok           BOOLEAN NOT NULL,      -- the turn completed without an error/stall
  tokens_in    INTEGER,               -- context tokens for the turn (provenance; may be null)
  tokens_out   INTEGER,               -- output tokens for the turn (provenance; may be null)
  cost_usd     DOUBLE,                -- turn cost in USD (provenance; may be null)
  session_id   VARCHAR,
  ingested_at  TIMESTAMP NOT NULL
);

CREATE TABLE eval_metrics (
  run_id                  VARCHAR PRIMARY KEY,
  model                   VARCHAR NOT NULL,
  ts                      TIMESTAMP NOT NULL,
  gross_add               INTEGER NOT NULL,
  gross_del               INTEGER NOT NULL,
  net_loc                 INTEGER NOT NULL,
  churn_pct               DOUBLE,     -- NULL-not-zero: a metric whose signal is absent stays null
  tokens_per_net_loc      DOUBLE,
  tokens_per_clean_loc    DOUBLE,
  context_efficiency      DOUBLE,
  tool_fail_rate          DOUBLE,
  wasted_tokens_est       INTEGER,
  test_pass_rate          DOUBLE,
  spec_conformance        DOUBLE,
  predicted_acceptance    DOUBLE,
  tokens_per_quality_feat DOUBLE,
  tiers                   JSON,        -- { metricName: "direct"|"proxy"|"needs_signal" }
  ingested_at             TIMESTAMP NOT NULL
);

-- A quick server-side aggregate for dashboards: per-model, per (UTC) hour, over successful
-- calls only. The AUTHORITATIVE rollup — DST-correct Eastern business-hours (08:00–17:00 ET)
-- with nearest-rank p50/p95 and WoW/MoM deltas — is evals.ts rollupLatency() run on the raw
-- rows (read via latency_ingest.readLatencyCalls). This view intentionally stays timezone-naive
-- so it needs no ICU extension; it is a convenience, not the report source of truth.
CREATE VIEW latency_rollup AS
  SELECT
    model,
    date_trunc('hour', ts) AS hour_bucket,
    count(*)               AS calls,
    round(avg(ttft_ms))    AS avg_ttft_ms,
    round(avg(total_ms))   AS avg_total_ms,
    quantile_cont(ttft_ms, 0.5)   AS p50_ttft_ms,
    quantile_cont(ttft_ms, 0.95)  AS p95_ttft_ms,
    quantile_cont(total_ms, 0.5)  AS p50_total_ms,
    quantile_cont(total_ms, 0.95) AS p95_total_ms
  FROM api_latency
  WHERE ok
  GROUP BY model, date_trunc('hour', ts);
