# PROGRESS.md

Three lines per session: **shipped / stubbed / next** (CLAUDE.md session ritual).

-----

## 2026-06-18 — Increment 0: harness bring-up + invariants

- **shipped:** Toolchain (Bun 1.3.14 + uv 0.11.21); repo skeleton; omp vendored
  (`vendor/oh-my-pi@faa96a81`) + SDK installed (`@oh-my-pi/pi-coding-agent@16.0.6`);
  **ADR-0003** confirming real omp API shapes; frozen contracts (`contracts.ts`,
  `tools/result_adapter.ts`); Python scanner sidecar (zero-width / tag / bidi /
  PUA / Cf detection over NDJSON, ADR-0002); `scanner_client.ts` + fail-closed
  `gate.ts`; no-network echo model/session on omp's mock provider; `.agents/`
  framework folder + 2 vendor-trusted skills with provenance. All green:
  `demo-00` (echo + scanner + **fail-closed**), 5 bun tests, 12 pytest, tsc 0.
- **stubbed:** `makeQuarantineHook` omp pre-hook wiring (full at P2.4);
  `telemetry/events.ts` (Increment 1); DuckDB (P2.3); homoglyph / mixed-script
  detection (P2.1); `make` not installed on this host → use `bun run demo-00` /
  `bun test harness` (Makefile remains the canonical spec).
- **next:** Increment 1 — boundary contracts demo (`demo-01`): `emit()` events to
  JSONL + `ToolResult` round-trips through the adapter both ways.

-----

## 2026-06-18 — Increment 1: boundary contracts

- **shipped:** `harness/telemetry/events.ts` — `Telemetry.emit()` writes the typed
  JSONL envelope (ts/run_id/session_id/artifact_id?), validates the name against
  the `EventName` enum and **raises `UnknownEventError`** on an off-enum name
  (invariant #8); file or custom sink; injectable clock. `demo-01` proves the
  emitter + the `result_adapter` round-trip BOTH ways (PRD→omp→PRD keeps
  tool_name/success/summary/duration; omp→PRD→omp keeps text + isError). IDs minted
  via omp `Snowflake` (invariant #9). All green: `demo-01`, 15 harness tests
  (+10: events + adapter), 12 sidecar, tsc 0; demo-00 regression OK.
- **stubbed:** events.ts uses `appendFileSync` (fine at this volume; a stream is a
  later perf concern); no DuckDB ingestion yet (P3.2 reads this JSONL); finding/
  approval ID minting helper deferred until those entities exist (P2.x).
- **next:** Increment 2 — cache-optimized prompt assembly (`demo-02`): 9-layer
  composer with a byte-stable frozen prefix; push omp's auto-injected env/git/date
  into the tail; prefix-hash test identical across tasks/cwd/branch.
