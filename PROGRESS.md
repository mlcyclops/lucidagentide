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

-----

## 2026-06-18 — Increment 2: cache-optimized prompt assembly

- **shipped:** `harness/prompt/assembler.ts` (FROZEN CONTRACT) — 9 PRD layers split
  hard at the cache breakpoint: byte-stable `FROZEN_PREFIX` (layers 1–4:
  identity/safety, tool-use/permission, coding rules, security/trust-boundary),
  volatile tail (5–9). Untrusted retrieved content enters only via `wrapUntrusted`
  (delimited, labeled, tail-only, invariant #5). `PREFIX_VERSION` gates any prefix
  change; sha256 `prefixHash` is the cache fingerprint. `demo-02` proves the prefix
  is byte-identical (2203 B, hash `e077d6fc…`) across two requests differing in
  task/cwd/branch/retrieved, AND that omp threads our prefix through as system
  block[0] (task lands in the tail). **ADR-0004** records the integration:
  passing `systemPrompt: [prefix, tail]` replaces omp's default wholesale
  (resolves ADR-0003 #5). All green: 22 harness tests (+7), 12 sidecar, demos
  00/01/02, tsc 0.
- **stubbed:** Layer-5 instruction-file loading + layer-8 volatile-context
  gathering are caller-supplied inputs (real omp instruction discovery wired in a
  later increment); tool-schema stability is omp-managed (noted, not yet asserted).
- **next:** Phase 2 / P2.1 — expand the scanner with mixed-script + homoglyph
  detection and build the adversarial fixture corpus (keystone #1, over-test).

-----

## 2026-06-18 — P2.1: Unicode scanner + adversarial fixtures (keystone #1)

- **shipped:** scanner `0.2.0` adds **mixed-script-homoglyph** detection — a
  token-level pass flagging Latin mixed with Cyrillic/Greek inside one word (the
  classic look-alike attack: Cyrillic `е` in `edit_file`, `pаypаl`, Greek omicron
  in `login`). Deliberately narrow so legit multilingual text (Japanese, Arabic,
  pure Cyrillic, Hangul, accented Latin) is NOT flagged. Adversarial corpus
  `fixtures/adversarial.py` (14 poisoned fixtures w/ expected types + 13 clean
  controls), all built via `chr()` (no literal invisibles). `test_fixtures.py`
  over-tests: every fixture fires its expected types, clean corpus is
  false-positive-free, every finding type exercised. `demo-P2.1`
  (`demo_p2_1.py`, UTF-8 stdout) prints the scan report + asserts. All green:
  54 sidecar tests (was 12), 22 harness, demos 00/01/02/P2.1, tsc 0.
- **stubbed:** confusable set is Cyrillic+Greek only (Cherokee/Coptic/fullwidth +
  a full confusables table = future, possibly a pinned offline dep per ADR-0001);
  homoglyph check is context-free (PRD's "sensitive fields" scoping comes later).
- **next:** P2.2+P2.3 — DuckDB bootstrap + security DDL, NFKC sanitation +
  sanitized-derivative + trust labeling; write artifact/scan/finding rows.

-----

## 2026-06-18 — P2.2 + P2.3: DuckDB bootstrap + sanitation + trust labeling

- **shipped:** `@duckdb/node-api` brought in (ADR-0005). `harness/memory/db.ts`
  — DuckDB wrapper + numbered-migration runner (`schema_migrations`-tracked,
  frozen-on-first-write, idempotent reopen). `migrations/0001_security_tables.sql`
  — the 7 PRD security tables (FKs within the security family; `run_id` a soft
  ref, deferred to P3.2). `sanitize.ts` — NFKC + strip zero-width/tag/bidi
  (homoglyph/PUA flagged-not-stripped). `ingest.ts` — scan → trust-label →
  sanitize → persist artifact/scan/findings/sanitized rows, **fail-closed**
  (dead scanner ⇒ artifact recorded quarantined), external-clean ⇒ `untrusted`
  (never auto-trusted), emits the P2 telemetry events. `demo-P2.3` ingests a
  multi-vector poisoned artifact and shows the rows. All green: 36 harness tests
  (+14), 54 sidecar, demos 00/01/02/P2.1/P2.3, tsc 0.
- **stubbed:** identity tables (`projects/sessions/runs`) deferred to P3.2 (hence
  soft `run_id`); approval/export/alert tables created but not yet written by a
  workflow (P2.4 approvals, P6 export); no JSONL→DuckDB telemetry ingestion yet
  (P3.2 reads the events.jsonl into tables).
- **next:** P2.4 — quarantine gate as an omp `pre`-hook on `tool_call` +
  approval workflow (notification payload, `approval_events` rows); prove
  blocked content cannot reach a tool call end-to-end through omp.

-----

## 2026-06-18 — P2.4: quarantine pre-hook + approval workflow (Phase 2 COMPLETE)

- **shipped:** `harness/hooks/quarantine_hook.ts` — `makeQuarantineExtension`, a
  real omp `ExtensionFactory` registering `pi.on("tool_call", …)` that scans the
  tool input via `scanAndDecide` and returns `{block, reason}` when quarantined,
  fail-closed. Proven through omp's OWN runtime: a poisoned tool call's
  `execute()` never runs (keystone test + `demo-P2.4`). `notification.ts`
  (`buildNotification`/`summarizeNotification`: source, trust, max severity,
  finding types, what's blocked — no raw content inline). `approvals.ts`
  (`recordApproval` → `approval_events`, emits approval_granted/denied).
  `testing/echo.ts` extended with scripted `responses`/`customTools`/`extensions`
  (mock tool-call → block → text). Replaced the Increment-0 gate stub. All green:
  45 harness tests (+9), 54 sidecar, demos 00/01/02/P2.1/P2.3/**P2.4**, tsc 0.
  **PRD Phase 2 acceptance met:** suspicious Unicode detected+classified; user
  sees finding type + severity before privileged execution; blocked content
  provably cannot reach a tool call.
- **stubbed:** notification raw/sanitized diff handles are artifact-id stubs (UI
  diff view is Phase 7); approvals are recorded but no release-re-scan loop yet
  (quarantine-release re-validation is a later refinement).
- **next:** P3.1 — verification engine (test/lint/typecheck runners wrapped) with
  the security scan as a fail-closed precondition for prompt/exec-bearing work.

-----

## 2026-06-18 — P3.1: verification engine with security precondition

- **shipped:** `harness/verification/engine.ts` — `runChecks` (spawns
  test/lint/typecheck command specs, per-check pass/fail + aggregate),
  `securityPrecondition` (a run's quarantined/suspicious artifacts that lack an
  approve/quarantine_release/promotion_approve block completion; fail_closed
  surfaced), and `verifyTask` gating: `completionAllowed = securityOk &&
  (allChecksPassed || acceptPartial)`. The security precondition is **fail-closed
  and NOT waivable** by `acceptPartial` — only a recorded approval clears it;
  partial only waives failed checks. `demo-P3.1` shows a quarantined artifact
  blocking completion despite green checks, then clearing after a
  quarantine_release approval. All green: 55 harness tests (+10), 54 sidecar,
  demos 00/01/02/P2.1/P2.3/P2.4/P3.1, tsc 0.
- **stubbed:** check specs are caller-supplied commands (repo-policy/task-type
  inference comes later); no verification telemetry event yet (EventName is a
  closed set — adding `verification_*` would be its own contract change + ADR);
  wrapping omp's built-in test/lint tools specifically is deferred (generic
  command runner suffices for now).
- **next:** P3.2 — JSONL→DuckDB ingestion (`post` hook ingests omp session JSONL
  into episodic/telemetry tables) + stable-ID guarantee; security events
  queryable & replayable.

-----

## 2026-06-18 — P3.2: JSONL→DuckDB ingestion + stable IDs (Phase 3 COMPLETE)

- **shipped:** every telemetry event now carries a stable `event_id` (Snowflake,
  invariant #9). Migration `0002_telemetry_tables.sql` adds `telemetry_events`
  (envelope columns promoted; rest kept in a `fields` JSON). `ingest_jsonl.ts`
  — `ingestTelemetryJsonl` reads events.jsonl into DuckDB, **idempotent** via
  `INSERT OR IGNORE` on `event_id`; malformed/incomplete/insert-failing lines are
  counted-skipped, never silently dropped. `queries.ts` — event-counts-by-type,
  findings-by-type, blocked-tool-calls, approvals-by-action, run-timeline
  (replay). `demo-P3.2` runs a task → ingests → re-ingests (0 new) → sample
  queries. Also fixed a real bug: the migration splitter broke on a `;` inside a
  comment → now strips line comments before splitting (the ADR-0005 caveat, hit
  for real). All green: 60 harness tests (+5), 54 sidecar, demos
  00/01/02/P2.1/P2.3/P2.4/P3.1/P3.2, tsc 0. **Phase 3 acceptance met:** stable
  IDs; security events queryable & replayable; export table audited.
- **stubbed:** ingests OUR telemetry JSONL (the security events); ingesting omp's
  own session JSONL into PRD episodic tables (tool_events/retrieval_events) is a
  later mapping task; auto-trigger via an omp session-end post-hook deferred
  (ingestion is an explicit call for now — the demo wires the full loop).
- **next:** Phase 4 / P4.1 — memory layers (working/episodic/semantic/archive) +
  state artifacts (NOW/PROGRESS/DECISIONS/FAILURES) with security metadata on
  every promoted artifact.

-----

## 2026-06-18 — P4.1: memory layers + state artifacts

- **shipped:** migration `0003_memory_tables.sql` — working_state (one snapshot
  per run), archive_chunks (raw source-of-truth + sha + artifact provenance),
  semantic_entities/facts/links. Every semantic fact carries **provenance**
  (source_artifact_id + source_archive_chunk_id) and a **trust_label** — the
  metadata the P4.3 gate will enforce. `memory.ts` — `upsertWorkingState`,
  `archiveChunk`, `promoteFact` (upserts entity, records provenance+trust),
  `getFacts`. `state.ts` — `StateArtifacts` managing NOW.md (overwritten
  snapshot) + PROGRESS/DECISIONS/FAILURES (append-only), injectable clock.
  `demo-P4.1` exercises all three layers + provenance + the state files. All
  green: 69 harness tests (+9), 54 sidecar, demos 00..P3.2 + P4.1, tsc 0.
- **stubbed:** PRD episodic tables (episode_events/tool_events/retrieval_events/
  verification_events) served by telemetry_events for now; promoteFact does NOT
  yet block suspicious sources — that GATE is P4.3 (keystone #2). semantic_links
  table created but unused until an entity-graph consumer needs it.
- **next:** P4.2 — security-aware compaction: summaries generated from sanitized
  derivatives; raw spans kept in archive; provenance links to source spans +
  scan findings preserved.

-----

## 2026-06-18 — P4.2: security-aware compaction

- **shipped:** migration `0004_compaction_tables.sql` — compaction_spans,
  compaction_summaries, compaction_promotions. `compaction.ts` — `compactSpan`
  generates the summary from **sanitized derivatives only** (the module never
  reads content_artifacts.raw_content; SQL selects sanitized_content), records
  `generated_from='sanitized'`, preserves the span's aggregate finding_count +
  artifact-id provenance, keeps raw spans in archive, and marks
  suspicious/quarantined sources promotion-INELIGIBLE (trusted/untrusted
  eligible). Injectable summarizer (LLM later); default is deterministic.
  `demo-P4.2` proves the summary has no invisibles while raw is preserved. All
  green: 75 harness tests (+6, incl. the keystone "summary from sanitized"), 54
  sidecar, demos 00..P4.1 + P4.2, tsc 0.
- **stubbed:** wiring `compactSpan` to omp's own compaction trigger is deferred
  (the transform is the security-bearing part; trigger is mechanism);
  compaction_promotions records ELIGIBILITY only — the enforced semantic-write
  gate is P4.3.
- **next:** P4.3 — semantic-promotion gate (keystone #2, over-test):
  suspicious-source promotions blocked until reviewed; resume-from-durable-state
  works; `demo-P4.3` proves a poisoned promotion is blocked.

-----

## 2026-06-18 — P4.3: semantic-promotion gate + safe resume (keystone #2, Phase 4 COMPLETE)

- **shipped:** `promotion_gate.ts` — `promoteFactGated` resolves a promotion's
  effective trust from its **source artifact's** trust (provenance wins; a caller
  CANNOT lie about trust), blocks suspicious/quarantined sources until a recorded
  approval (approve/quarantine_release/promotion_approve), and is **fail-closed**
  on unverifiable provenance (unknown source → block). Writes nothing to
  semantic memory on block; emits `memory_promotion_blocked`. `resume.ts` —
  `resumeRun` reconstructs working state + fact count and surfaces the security
  posture (unreviewed quarantined/suspicious artifacts) via the P3.1 precondition;
  `safe=false` until reviewed. `demo-P4.3` proves a poisoned promotion is blocked,
  fails closed on unknown provenance, unblocks after approval, and resumes safely.
  Over-tested (keystone #2): 11 gate+resume tests incl. the caller-cant-lie case.
  All green: 86 harness tests (+11), 54 sidecar, demos 00..P4.2 + P4.3, tsc 0.
  **PRD Phase 4 acceptance met:** suspicious artifacts can't auto-promote;
  compaction preserves provenance; a run resumes safely. Both correctness
  keystones (scanner P2.1, promotion gate P4.3) are in and over-tested.
- **stubbed:** promoteFactGated is the enforced path; compaction's
  promotion-eligibility flags (P4.2) are advisory and would feed this gate when
  compaction auto-promotes (not yet wired to auto-promote).
- **next:** Phase 5 / P5.1 — parent/child runs + subagent dispatch; each child
  run carries its own trace, sandbox, and scan lineage; store lineage.

-----

## 2026-06-18 — P5.1: parent/child run lineage + subagent dispatch

- **shipped:** migration `0005_runs_lineage.sql` — the `runs` table (the deferred
  identity table), with `parent_run_id` as a soft self-reference + kind / mode /
  sandbox_profile / status. `runs/lineage.ts` — `startRun` / `endRun` /
  `spawnSubagent` (links parent, inherits session), `getRunTree` (recursive CTE →
  nested tree with **per-run suspicious-artifact counts** = scan lineage), and
  `getLineage` (root-to-node chain). Each child carries its own trace (run_id-
  scoped telemetry), sandbox (column), and scan lineage (run_id-scoped artifacts).
  `demo-P5.1` spawns a root + 2 children + a grandchild, renders the run tree
  flagging where suspicious content entered, and shows a child's poisoned
  artifact being blocked from promotion into shared semantic memory (P4.3 gate
  across the child→parent boundary). All green: 92 harness tests (+6), 54
  sidecar, demos 00..P4.3 + P5.1, tsc 0.
- **stubbed:** sandbox_profile is recorded but not yet enforced (P5.2 maps
  profiles onto omp isolation backends + auto-downgrade); real omp subagent
  dispatch is modeled by our lineage records (wiring to omp's task system is the
  P5.2 integration); replay rendering here is a CLI tree (the Phase-7 dashboard
  consumes the same getRunTree).
- **next:** P5.2 — sandbox profiles mapped onto omp isolation backends;
  suspicious tasks auto-downgrade; security-review subagent is read-only/quarantine.

-----

## 2026-06-18 — P5.2: sandbox profiles + security-review subagent (Phase 5 COMPLETE)

- **shipped:** `runs/profiles.ts` — the 5 profiles as a policy layer over omp
  isolation: `PROFILE_CAPS` (write/exec/network + omp backend none/worktree/
  overlay) and `chooseProfile` **auto-downgrade** (suspicious → container-local,
  quarantined → quarantine, security-review/replay → read-only-audit, remote →
  remote-runner; approval lifts the downgrade; never upgrades past requested).
  `runs/security_review.ts` — `spawnSecurityReview` spawns a read-only child and
  **rejects any write-capable profile** (enforced, not convention). Extended
  `getRunTree` with per-run `findingCount` + `approvalCount` so replay renders
  injection + approval lineage. `demo-P5.2` shows the downgrade table, the
  capability matrix, the read-only security-review enforcement, and the run tree
  with injection/approval lineage. All green: 105 harness tests (+13), 54
  sidecar, demos 00..P5.1 + P5.2, tsc 0. **PRD Phase 5 acceptance met:** lineage
  stored; security-review read-only; replay renders injection/approval lineage.
- **stubbed:** profiles select the omp backend conceptually; binding
  `chooseProfile`'s output to omp's actual isolation at session-spawn time is the
  Phase-6 remote-runner integration; "overlay" resolves to fuse-overlay/ProjFS by
  platform inside omp (not re-implemented here).
- **next:** Phase 6 / P6.1 — remote runner gate: payload scanned BEFORE a run is
  created; suspicious → blocked or routed to security-review; findings + approval
  lineage on the run record.

-----

## 2026-06-18 — P6.1: remote runner gate (pre-dispatch scan)

- **shipped:** `runs/remote_gate.ts` — `dispatchRemoteRun` creates the run RECORD
  (not execution), runs the **pre-dispatch scan** by ingesting+scanning the
  comment/API payload under that run, then disposes: clean → `dispatched`
  (remote-runner); suspicious/quarantined → `blocked` (status=blocked,
  profile=quarantine) and, by default, **routed to a read-only security-review
  subagent**; fail-closed (unscannable payload → quarantined → blocked). Emits
  `remote_run_blocked`. Findings + approval lineage live on the run record
  (run_id-scoped). `lineage.ts` gained `setRunDisposition` + `blocked`/`dispatched`
  statuses. `demo-P6.1` shows clean-dispatch, poison→review, the P3.1 precondition
  blocking the build until a `quarantine_release` approval clears it, and hard
  no-route block. All green: 110 harness tests (+5), 54 sidecar, demos 00..P5.2 +
  P6.1, tsc 0. **PRD remote-runner reqs met:** payload scanned before dispatch;
  suspicious blocked/routed; run record stores findings + approval lineage; no
  privileged execution until reviewed.
- **stubbed:** the actual GitHub/Actions trigger wiring is omp's; this gate is the
  pre-dispatch policy that omp's comment/CI entrypoint would call. Re-dispatch of
  an approved run is modeled via the cleared securityPrecondition (no separate
  re-dispatch API yet).
- **next:** P6.2 — safe export + incident bundles: escaped MD report, sanitized-
  only CSV, JSON evidence bundle (raw flagged + separate), export metadata +
  payload hash; raw dangerous content never rendered by default.

-----

## 2026-06-18 — P6.2: safe export + incident bundles (Phase 6 COMPLETE)

- **shipped:** `export/safe_export.ts` — `exportMarkdownReport` (escaped MD,
  finding metadata + sanitized excerpt, raw referenced by sha only),
  `exportCsv` (sanitized-only finding rows), `exportJsonBundle` (raw OMITTED by
  default; when `includeRaw`, isolated under `raw_evidence` + flagged
  DANGEROUS_RAW_DO_NOT_RENDER). Defense in depth: `escapeMarkdown`/`csvField`
  neutralize ANY zero-width/tag/bidi/control codepoint to `\u{..}` notation, so
  an export can't emit an invisible even from unsanitized input. Every export
  writes an `export_events` audit row (type, sanitization_status, included_raw,
  reviewer, payload sha256) and emits safe_export_created / incident_bundle_
  created. `demo-P6.2` proves MD/CSV/default-JSON are invisible-free + raw-free
  while the raw bundle isolates+flags. All green: 117 harness tests (+7), 54
  sidecar, demos 00..P6.1 + P6.2, tsc 0. **PRD safe-export reqs met:** raw never
  rendered by default; sanitized/escaped derivatives only; export audit complete.
- **stubbed:** the dashboard-feed table is the CSV/finding-metadata shape here;
  rendering it as a live Observable page is Phase 7. Exports return content +
  audit row; writing files to disk is the caller's choice (custom-tool wrapper
  later).
- **next:** Phase 7 / P7.1 — Observable dashboards from DuckDB exports
  (operational + the six security dashboard views).

-----

## 2026-06-18 — P7.1: Observable dashboards from DuckDB exports

- **shipped:** `dashboards/views.ts` — the six PRD security views (findings
  overview, Unicode analysis, approval queue, quarantine review, memory-promotion
  risk, export audit) + operational (active runs), all selecting **metadata only**
  (no raw_content column is ever read). `dashboards/materialize.ts` —
  `materializeDashboards` runs every view and writes `<name>.csv` through the
  safe-export `csvField`, so the feed can never carry an invisible/control char.
  `observable/` — Framework config + `docs/{index,security}.md` pages (tables +
  Plot) consuming the CSVs, README, generated `docs/data/` gitignored.
  `materialize_dashboards.ts` CLI + `make dashboards`. `demo-P7.1` builds a
  workload, materializes all 7 views, and asserts no invisibles + expected
  contents. All green: 122 harness tests (+5), 54 sidecar, demos 00..P6.2 + P7.1,
  tsc 0. **PRD dashboard reqs met:** six security views; feed exposes metadata,
  never raw.
- **stubbed:** Observable Framework is not a harness dep (kept Bun install lean) —
  run on demand via `npx @observablehq/framework`; the materialized CSVs are the
  tested contract. Compaction-quality / verification-failures operational pages
  are future view additions on the same pipeline.
- **next:** P7.2 — replay + benchmark + prompt-version comparison; tie cache-hit
  rate / token consumption per prompt-prefix version back to Increment 2.

-----

## 2026-06-18 — P7.2: replay + benchmark + prompt-version comparison (Phase 7 + BUILD PLAN COMPLETE)

- **shipped:** `runs/replay.ts` — `buildReplay` reconstructs the run tree +
  telemetry timeline across the subtree + suspicious/injection/approval totals;
  `renderReplay` prints it. `bench/benchmark.ts` (+ migration `0006_benchmark_
  tables.sql`) — `runBenchmark` classifies each request as a prefix-cache hit/miss
  by the assembler's prefix hash, recording token splits + security outcomes;
  `cacheByPrefixVersion` + `outcomesByDimension(source|mode|model)` compare across
  versions/dimensions. `stablePrefixBuilder` vs `volatilePrefixBuilder` make the
  Increment-2 point concrete. `demo-P7.2`: stable prefix = **0.90 hit-rate / 4959
  cache-read tokens** vs the volatile anti-pattern = **0.00 / 5670 rewritten** —
  proof the KV-cache discipline holds. All green: **130 harness tests (+8)**, 54
  sidecar, **all 17 demos (00..P7.2)**, tsc 0. **PRD Phase 7 acceptance met:**
  finding-type trends inspectable; incidents comparable by model/source/mode;
  prompt changes evaluable against BOTH security outcomes and cache/token metrics.
- **stubbed:** token counts are a chars/4 estimate (swap a real tokenizer when a
  live model is wired); benchmark requests are synthetic (the framework records
  real runs once a non-echo provider is configured).
- **next:** BUILD PLAN complete (Increment 0–2, Phases 2–7). Optional follow-ups:
  real-model providers, live Observable build in CI, richer confusables set,
  compaction-quality/verification-failure dashboard pages.

## DX: memory dashboard + launcher model handoff (post-build)
- **shipped:** `/lucid:memory` + `bun run memory:tui` — a MEMORY & CONTEXT dashboard
  reading omp's own session jsonl (context-window gauge, KV-cache hit-rate proving
  invariant #6, token-growth sparkline, cost), `omp config` compaction policy,
  `agent.db` rate-limit budget, and the Lucid memory layers + promotion gate;
  shared `tools/_tui.ts` (gauges/sparklines/tables) now backs both dashboards.
- **shipped:** launcher passes `--models` (Ctrl+P live switch) and offers to
  relaunch omp after a model/provider switch, so panel choices actually reach omp.
- **next:** optional — persist last model across launches; per-turn compaction-event
  markers in the memory view once omp emits them to the session log.

## DX: web dashboard + ACP proof (Electron front-end spike)
- **shipped:** `bun run dashboard:web` — a live, auto-refreshing browser dashboard
  (tools/web/) serving the security + memory views from agent_obs.duckdb + omp,
  READ-ONLY (security reuses views.ts SQL via a READ_ONLY DuckDB adapter; memory
  via the new shared tools/memory_data.ts). Screenshotted rendering real data.
- **shipped:** `bun run acp:probe` proves omp speaks Agent Client Protocol
  (initialize handshake → caps + ~/.omp auth) — the seam an Electron/desktop shell
  (or acp-ui/Zed/JetBrains) uses. Gate stays in-process; invariants intact. ADR-0006.
- **next:** Electron shell embedding the web page + an omp `acp` chat panel;
  click-to-approve quarantine actions; SSE push instead of 4s polling.

## DX: Electron desktop GUI (chat + dashboards)
- **shipped:** desktop/ — a polished Electron shell. Renderer (vanilla TS): custom
  frameless titlebar, icon rail, sessions sidebar, streaming chat, collapsible
  Security + Memory inspector, ⌘K command palette, delayed SVG tooltips, and a
  non-modal fly-in toast when the gate quarantines a tool call. Screenshot-verified
  in-browser (bun run desktop:web); renderer + main + preload type-clean.
- **shipped:** main/preload/acp wire omp via `omp acp -e <gate>` (gate stays
  in-process on the chat path) + read-only dashboards; reuses ~/.omp credentials.
- **next:** confirm ACP session/update→event field shapes on a live model turn;
  surface tool-permission prompts in the UI; package installers (electron-builder).

## DX: desktop GUI — functional chat, model picker, zoom, omp commands
- **shipped:** captured the live omp ACP wire format and wired real chat
  (session/new → session/prompt, agent_message_chunk streaming, usage_update →
  live context/cost). main.ts/preload.ts/acp.ts use the exact shapes.
- **shipped (renderer, screenshot-verified):** titlebar Model·Mode·Thinking picker
  driven by omp configOptions (set via session/set_config_option); text-zoom
  controls (− 100% +, Ctrl ±/0; webFrame in Electron, CSS zoom in browser); the 39
  ACP slash commands surfaced in the ⌘K palette. Desktop dev port → 5319 (4318 hit
  a Windows excluded range).
- **next:** confirm tool_call event shapes in the live window; surface tool-
  permission prompts; persist per-session model choice.
