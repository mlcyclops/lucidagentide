# HANDOFF — Lucid Agent IDE harness

Cold-start context for a fresh or **remote** Claude session (see
`.github/workflows/claude.yml`). Read this, then `CLAUDE.md` (invariants), before
touching code.

## What this is

A security / provenance / memory layer built **around** oh-my-pi (omp) — not a
fork. TypeScript on Bun, in-process with omp; the only Python is
`scanner-sidecar/` (the pure Unicode scanner). See `README.md` and
`BUILD PLAN omp.md`.

## Current state (2026-06-18)

**The build plan is complete** — Increment 0–2 + Phases 2–7, shipped one
increment per commit (17 commits). All green:

- **130 harness tests** (`bun test harness`), **54 sidecar tests** (pytest),
  **17 demos** (`demo-00` … `demo-P7.2`), `tsc --noEmit` clean.
- Both correctness keystones are in and over-tested: the **Unicode scanner**
  (`scanner-sidecar/`) and the **semantic-promotion gate**
  (`harness/memory/promotion_gate.ts`).
- 6 numbered DuckDB migrations (`harness/memory/migrations/`); 6 ADRs
  (`DECISIONS.md`).

The end-to-end guarantee holds: untrusted text → scanned → trust-labeled →
sanitized → persisted → blocked at the tool / promotion / dispatch boundaries →
human-reviewed → exits only as safe, audited evidence.

## How to run

```bash
bun install
(cd scanner-sidecar && uv sync)

bun test harness                         # harness suite
(cd scanner-sidecar && uv run python -m pytest -q)   # scanner suite
bun run demo-00                          # … through demo-P7.2
bun x tsc --noEmit                       # typecheck
```

`make` is the canonical task spec but is not installed on the origin host; the
`bun run demo-*` scripts mirror every target.

## Session ritual (from CLAUDE.md — follow it)

1. Read `CLAUDE.md`. Confirm a green baseline (`bun test harness` + the previous
   `demo-*`) before changing anything.
2. Build **exactly one** increment. Keep every invariant (fail-closed; extend
   omp, never fork; untrusted content delimited + late; byte-stable prompt
   prefix; closed trust-label/event sets; stable IDs; DuckDB schema only via
   numbered migrations).
3. Do **not** edit frozen contracts (`contracts.ts`, `tools/result_adapter.ts`,
   the frozen prompt prefix, applied migrations) as a side effect.
4. Append a 3-line `PROGRESS.md` entry: shipped / stubbed / next. Use
   `/ship-docs` to do this review + update.

## Next / optional follow-ups

The plan is done; these are optional (noted at the end of `PROGRESS.md`):

- Wire a real (non-echo) model provider; swap the chars/4 token estimate in
  `harness/bench/benchmark.ts` for a real tokenizer.
- Run the Observable build in CI (`observable/`, `make dashboards`).
- Richer confusables set in the scanner (beyond Cyrillic/Greek).
- Compaction-quality / verification-failure dashboard pages on the existing
  `harness/dashboards/` pipeline.

## Map

- `harness/security/` — scanner client, fail-closed gate.
- `harness/hooks/` — omp quarantine pre-hook (blocks poisoned tool calls).
- `harness/memory/` — DuckDB, ingest, sanitize, compaction, promotion gate,
  resume, migrations.
- `harness/runs/` — run lineage, sandbox profiles, security-review, remote gate,
  replay.
- `harness/{telemetry,verification,export,dashboards,bench,prompt}/` — the rest.
- `scanner-sidecar/` — the only Python; the Unicode scanner + fixtures.
