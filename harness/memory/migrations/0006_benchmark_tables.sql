-- migration 0006 — benchmark records (P7.2)
--
-- FROZEN once applied (invariant #10). One row per benchmarked request. The
-- prompt_prefix_version + prefix_hash tie cache behavior back to Increment 2:
-- a byte-stable prefix => repeated prefix_hash => cache hits; volatile-in-prefix
-- => unique hash each time => cache misses. Security outcomes (findings, blocked)
-- are recorded alongside so prompt/compaction changes can be compared against
-- BOTH cache/token metrics and security results.

CREATE TABLE bench_runs (
  bench_id              VARCHAR PRIMARY KEY,
  suite                 VARCHAR,
  prompt_prefix_version VARCHAR,
  prefix_hash           VARCHAR,
  model                 VARCHAR,
  source                VARCHAR,
  mode                  VARCHAR,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_hit             BOOLEAN NOT NULL DEFAULT FALSE,
  findings              INTEGER NOT NULL DEFAULT 0,
  blocked               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMP NOT NULL
);
