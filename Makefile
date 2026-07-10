# Makefile — agentic IDE harness (omp-based, Option A)
#
# Conventions:
#   make test            -> all tests (Bun harness + sidecar smoke)
#   make demo-00         -> increment 0 demo (proves fail-closed on day one)
#   make demo-<id>       -> per-increment runnable proof
#
# The harness is TypeScript on Bun. The only Python is scanner-sidecar/,
# managed by uv. See CLAUDE.md and DECISIONS.md.

SHELL := /bin/bash
.DEFAULT_GOAL := help

BUN        := bun
UV         := uv
SIDECAR_DIR := scanner-sidecar
PY         := $(UV) run --project $(SIDECAR_DIR) python

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

.PHONY: install
install: install-harness install-sidecar install-hooks ## Install harness + sidecar deps + git hooks

.PHONY: install-hooks
install-hooks: ## Point git at .githooks/ so the pre-commit license-header hook runs
	git config core.hooksPath .githooks
	@echo "✓ core.hooksPath -> .githooks (pre-commit applies BUSL-1.1 headers to staged source)"

.PHONY: install-harness
install-harness: ## Install Bun/TypeScript harness deps
	$(BUN) install

.PHONY: install-sidecar
install-sidecar: ## Create/sync the pinned Python sidecar venv
	cd $(SIDECAR_DIR) && $(UV) sync

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

.PHONY: test
test: test-harness test-sidecar ## Run all tests

.PHONY: test-harness
test-harness: ## Bun test suite (desktop/release is GENERATED — packaged repo copies must never be tested)
	$(BUN) test --path-ignore-patterns='desktop/release/**'

.PHONY: test-sidecar
test-sidecar: ## Sidecar smoke test: one request in, well-formed response out
	$(PY) -m pytest -q $(SIDECAR_DIR)/tests || \
		(echo "sidecar tests failed" && exit 1)

# ---------------------------------------------------------------------------
# Increment 0 demo
#   1. headless omp round-trip via the echo provider (no network/keys)
#   2. scanner sidecar: clean string + zero-width-injected string
#   3. FAIL-CLOSED PROOF: kill the sidecar mid-call, assert the gate blocks
# ---------------------------------------------------------------------------

.PHONY: demo-00
demo-00: ## Increment 0: omp echo round-trip + scanner + fail-closed proof
	@echo "== [1/3] omp echo-provider round-trip =="
	$(BUN) run harness/scripts/demo00_omp_echo.ts
	@echo "== [2/3] scanner clean vs poisoned =="
	$(BUN) run harness/scripts/demo00_scanner.ts
	@echo "== [3/3] FAIL-CLOSED: kill sidecar mid-call, expect BLOCK =="
	$(BUN) run harness/scripts/demo00_failclosed.ts
	@echo "== demo-00 OK =="

# The fail-closed proof is ALSO a permanent test, not just a demo.
# It lives in the harness suite so it can never silently regress.
.PHONY: test-failclosed
test-failclosed: ## Standalone run of the fail-closed regression test
	$(BUN) test harness/security/gate.failclosed.test.ts

# ---------------------------------------------------------------------------
# Placeholders for later increments (fill in as you build)
# ---------------------------------------------------------------------------

.PHONY: demo-01
demo-01: ## Boundary contracts: emit events + ToolResult round-trip
	$(BUN) run harness/scripts/demo01_contracts.ts

.PHONY: demo-02
demo-02: ## Cache-optimized prompt assembly: prefix bytes identical across tasks
	$(BUN) run harness/scripts/demo02_prefix_hash.ts

.PHONY: demo-P2.1
demo-P2.1: ## P2.1: scan adversarial fixtures; each finding fires, clean corpus is FP-free
	$(PY) $(SIDECAR_DIR)/demo_p2_1.py

.PHONY: demo-P2.3
demo-P2.3: ## P2.3: ingest a poisoned artifact -> artifact/scan/findings/sanitized rows
	$(BUN) run harness/scripts/demo03_ingest.ts

.PHONY: demo-P2.4
demo-P2.4: ## P2.4: poisoned tool call blocked by the omp pre-hook + approval workflow
	$(BUN) run harness/scripts/demo04_quarantine_hook.ts

.PHONY: demo-P3.1
demo-P3.1: ## P3.1: verification engine; security scan is a fail-closed completion precondition
	$(BUN) run harness/scripts/demo05_verification.ts

.PHONY: demo-P3.2
demo-P3.2: ## P3.2: ingest telemetry JSONL into DuckDB (idempotent) + sample security queries
	$(BUN) run harness/scripts/demo06_telemetry_ingest.ts

.PHONY: demo-P4.1
demo-P4.1: ## P4.1: memory layers (working/archive/semantic) + state artifacts
	$(BUN) run harness/scripts/demo07_memory.ts

.PHONY: demo-P4.2
demo-P4.2: ## P4.2: security-aware compaction (summaries from sanitized; raw preserved)
	$(BUN) run harness/scripts/demo08_compaction.ts

.PHONY: demo-P4.3
demo-P4.3: ## P4.3: semantic-promotion gate blocks suspicious-source promotions (keystone #2)
	$(BUN) run harness/scripts/demo09_promotion_gate.ts

.PHONY: demo-P5.1
demo-P5.1: ## P5.1: parent/child run lineage + subagent dispatch with per-run scan lineage
	$(BUN) run harness/scripts/demo10_lineage.ts

.PHONY: demo-P5.2
demo-P5.2: ## P5.2: sandbox profiles auto-downgrade + read-only security-review subagent
	$(BUN) run harness/scripts/demo11_sandbox.ts

.PHONY: demo-P6.1
demo-P6.1: ## P6.1: remote-runner gate scans payload before dispatch; routes suspicious to review
	$(BUN) run harness/scripts/demo12_remote_gate.ts

.PHONY: demo-P6.2
demo-P6.2: ## P6.2: safe export (MD/CSV/JSON); raw never rendered by default; export audited
	$(BUN) run harness/scripts/demo13_safe_export.ts

.PHONY: demo-P7.1
demo-P7.1: ## P7.1: materialize the six security dashboard views to safe CSVs
	$(BUN) run harness/scripts/demo14_dashboards.ts

.PHONY: demo-P7.2
demo-P7.2: ## P7.2: replay run tree/timeline + benchmark cache-hit per prompt-prefix version
	$(BUN) run harness/scripts/demo15_replay_bench.ts

.PHONY: demo-P-LOC.1
demo-P-LOC.1: ## P-LOC.1: AI-LOC attribution — count AI-authored lines per model/repo/identity
	$(BUN) run harness/scripts/demo16_ai_loc.ts

.PHONY: demo-ADR9A
demo-ADR9A: ## ADR-0009 Phase A: recall prior-session facts into a new session (suspicious never recalled)
	$(BUN) run harness/scripts/demo17_recall.ts

.PHONY: demo-P-CODE.1
demo-P-CODE.1: ## P-CODE.1 (ADR-0030): git workspace diffstat this month + fail-closed omit of non-git dirs
	$(BUN) run harness/scripts/demo_pcode1.ts

.PHONY: demo-P-TPS.1
demo-P-TPS.1: ## P-TPS.1 (ADR-0044): streaming output-token readout — output-only, prompt-excluded, provider-reconciled
	$(BUN) run harness/scripts/demo_ptps1.ts

.PHONY: demo-P-SKILL.1
demo-P-SKILL.1: ## P-SKILL.1 (ADR-0045): gated skill import — clean .md writes to .omp/skills/, poisoned blocks at the gate
	$(BUN) run harness/scripts/demo_pskill1.ts

.PHONY: demo-P-SKILL.4
demo-P-SKILL.4: ## P-SKILL.4 (ADR-0097): the Agent Skill directory - classify roots/trust, fail-closed re-scan locks a flagged skill, remove confined to project/user (immutable .agents refused)
	$(BUN) run harness/scripts/demo_pskill4.ts

.PHONY: demo-P-SKILLREG.1
demo-P-SKILLREG.1: ## P-SKILLREG.1 (ADR-0098): the enterprise skills registry READER - Ed25519 verify + fail-closed scan-gate on install; unsigned/untrusted-key/poisoned blocked, clean installs as an untrusted registry row
	$(BUN) run harness/scripts/demo_pskillreg1.ts

.PHONY: demo-P-SKILL.5
demo-P-SKILL.5: ## P-SKILL.5 (ADR-0101): Skill Studio - analyze recent work into candidate skills, codify each through the fail-closed gate (clean writes, poisoned blocks); analyze writes nothing
	$(BUN) run harness/scripts/demo_pskill5.ts

.PHONY: demo-P-SKILLREG.2
demo-P-SKILLREG.2: ## P-SKILLREG.2 (ADR-0102): the skill publish seam - sign + publish a codified skill to the Local Skills Registry (remote target no-ops fail-safe), then round-trip it back through the reader into a registry row
	$(BUN) run harness/scripts/demo_pskillreg2.ts

.PHONY: demo-P-KB.1
demo-P-KB.1: ## P-KB.1 (ADR-0099): the compiled KB - a clean doc compiles into a page graph, a poisoned source is quarantined (never compiled), a poisoned derived page is re-scanned + quarantined (never stored)
	$(BUN) run harness/scripts/demo_pkb1.ts

.PHONY: demo-P-KB.2
demo-P-KB.2: ## P-KB.2 (ADR-0100): the hybrid retrieval router (vector | compiled | both, delimited + cited) + the kept-in-sync generator (idempotent re-ingest, contradiction-flagged, prior page retained)
	$(BUN) run harness/scripts/demo_pkb2.ts

.PHONY: demo-P-KB.2b
demo-P-KB.2b: ## P-KB.2b (ADR-0099/0100 desktop): the desktop compiled-KB surface - ingest compiles into the process store, retrieve returns cited delimited hits, graph exposes pages+links, poisoned source quarantined
	$(BUN) run desktop/scripts/demo_p_kb_1.ts

.PHONY: demo-P-GOAL.9
demo-P-GOAL.9: ## P-GOAL.9 (ADR-0054): /goal After-Action Report — tool calls/LOC/errors/websites graphs + stall guard
	$(BUN) run harness/scripts/demo_pgoal9.ts

.PHONY: demo-P-GOAL.10
demo-P-GOAL.10: ## P-GOAL.10 (ADR-0055): /goal cross-run evaluation ledger — success rate, avg iters, failure breakdown
	$(BUN) run harness/scripts/demo_pgoal10.ts

.PHONY: demo-P-GOAL.11
demo-P-GOAL.11: ## P-GOAL.11 (ADR-0056): /goal live spend meter + budget kill switch — halts an unattended run at a $ cap
	$(BUN) run harness/scripts/demo_pgoal11.ts

.PHONY: demo-P-GOAL.12
demo-P-GOAL.12: ## P-GOAL.12 (ADR-0057): Pre-Flight Audit — readiness L0→L3, history awareness, interview, Loop Design report
	$(BUN) run harness/scripts/demo_pgoal12.ts

.PHONY: demo-P-RAG.1
demo-P-RAG.1: ## P-RAG.1 (ADR-0058): local knowledge spine — scan-gated ingest, fail-closed block, offline cosine retrieval, delimited injection
	$(BUN) run harness/scripts/demo_prag1.ts

.PHONY: demo-P-RAG.1b
demo-P-RAG.1b: ## P-RAG.1b (ADR-0063): real bge-small embedder — SEMANTIC retrieval (zero shared words), still scan-gated + delimited
	$(BUN) run harness/scripts/demo_prag1b.ts

.PHONY: demo-P-RAG.1c
demo-P-RAG.1c: ## P-RAG.1c (ADR-0064): PDF -> text through the SAME scan gate — semantic retrieval from a PDF, corrupt PDF fails closed
	$(BUN) run harness/scripts/demo_prag1c.ts

.PHONY: demo-P-BRIEF.1
demo-P-BRIEF.1: ## P-BRIEF.1 (ADR-0070): Executive Engineering Update from the repo's DECISIONS/PROGRESS — written brief + two-host podcast script, air-gap clean
	$(BUN) run harness/scripts/demo_pbrief1.ts

.PHONY: demo-P-BRIEF.2
demo-P-BRIEF.2: ## P-BRIEF.2 (ADR-0071): the exec-update script → one WAV via the OpenAI-compatible (Kokoro) TTS backend; mock transport offline, LUCID_TTS_BASE_URL for live
	$(BUN) run harness/scripts/demo_pbrief2.ts

.PHONY: demo-P-STT.1
demo-P-STT.1: ## P-STT.1 (ADR-0073): mic audio → text via the OpenAI-compatible (local Whisper) STT backend; mock transport offline, LUCID_STT_BASE_URL for live
	$(BUN) run harness/scripts/demo_pstt1.ts

.PHONY: demo-P-ASKSAGE.1
demo-P-ASKSAGE.1: ## P-ASKSAGE.1 (ADR-0059): AskSage tool-loop diagnostics + tolerant extraction — wrapped replies recovered, empty turns flagged
	$(BUN) run harness/scripts/demo_paskage1.ts

.PHONY: demo-B-KG.1
demo-B-KG.1: ## B-KG.1 (#112/#113/#114): KG interaction polish — large graph fits on open, idle CPU halts, forget is instant + snapshot-safe
	$(BUN) run desktop/scripts/demo_b_kg_1.ts

.PHONY: demo-P-KG-REL.1
demo-P-KG-REL.1: ## P-KG-REL.1 (#109/ADR-0075): manual relate — authored edge lands in the store + persists; drag/multi-select interaction logic
	$(BUN) run desktop/scripts/demo_p_kg_rel_1.ts

.PHONY: demo-B-KG.2
demo-B-KG.2: ## B-KG.2 (#115): export location is recoverable — persistent toast + Open folder / Copy path
	$(BUN) run desktop/scripts/demo_b_kg_2.ts

.PHONY: demo-P-ENT.1
demo-P-ENT.1: ## P-ENT.1 (ADR-0068): enterprise managed-policy override — set + lock exec/egress/model knobs via GPO/MDM, only ever tightening, fail-safe to unmanaged
	$(BUN) run harness/scripts/demo_pent1.ts

.PHONY: demo-P-KG-INGEST.1
demo-P-KG-INGEST.1: ## P-KG-INGEST.1 (#110/ADR-0076): non-blocking background ingest — progress countdown, fail-safe cancel, single-flight job
	$(BUN) run desktop/scripts/demo_p_kg_ingest_1.ts

.PHONY: demo-P-KG-INGEST.1b
demo-P-KG-INGEST.1b: ## P-KG-INGEST.1b (#110/ADR-0076): group the throwaway "Extract DURABLE facts…" ingest sessions out of the chat list
	$(BUN) run desktop/scripts/demo_p_kg_ingest_1b.ts

.PHONY: demo-P-VAULT-HINT.1
demo-P-VAULT-HINT.1: ## P-VAULT-HINT.1 (#111/ADR-0077): locked vault → content-free existence hint (agent offers to unlock; never decrypts)
	$(BUN) run desktop/scripts/demo_p_vault_hint_1.ts

.PHONY: demo-P-KG-REL.2
demo-P-KG-REL.2: ## P-KG-REL.2 (#122/ADR-0078): custom relation labels — typed label round-trips through the store; blank defaults to "related"
	$(BUN) run desktop/scripts/demo_p_kg_rel_2.ts

.PHONY: demo-P-KG-INGEST.2
demo-P-KG-INGEST.2: ## P-KG-INGEST.2 (#123/ADR-0079): bulk-clear ingest sessions — workspace-scoped, real chats survive, idempotent
	$(BUN) run desktop/scripts/demo_p_kg_ingest_2.ts

.PHONY: demo-P-VAULT-HINT.2
demo-P-VAULT-HINT.2: ## P-VAULT-HINT.2 (#124/ADR-0080): fact count in the locked-vault hint — in-memory at lock, never on disk, never content
	$(BUN) run desktop/scripts/demo_p_vault_hint_2.ts

.PHONY: demo-P-KG-INGEST.3
demo-P-KG-INGEST.3: ## P-KG-INGEST.3 (#125/ADR-0081): chat preempts a back-to-back ingest loop via the ChatGate (yields, then resumes)
	$(BUN) run desktop/scripts/demo_p_kg_ingest_3.ts

.PHONY: demo-P-KG-REL.3
demo-P-KG-REL.3: ## P-KG-REL.3 (#130/ADR-0082): remove a relationship — optimistic edge removal + store.removeLink persists (only the targeted edge)
	$(BUN) run desktop/scripts/demo_p_kg_rel_3.ts

.PHONY: demo-P-KG-SEARCH.1
demo-P-KG-SEARCH.1: ## P-KG-SEARCH.1 (#132/ADR-0083): find a node — case-insensitive substring matcher feeding highlight + center
	$(BUN) run desktop/scripts/demo_p_kg_search_1.ts

.PHONY: demo-P-PERF.1
demo-P-PERF.1: ## P-PERF.1 (#134/ADR-0084): instant cached session list + transcripts (SWR) — paint cache, refresh, re-render only if changed; LRU-capped
	$(BUN) run desktop/scripts/demo_p_perf_1.ts

.PHONY: demo-P-KG-INGEST.4
demo-P-KG-INGEST.4: ## P-KG-INGEST.4 (#136/ADR-0085): true ingest concurrency — dedicated util omp connection; fail-safe fallback; routing contract
	$(BUN) run desktop/scripts/demo_p_kg_ingest_4.ts

.PHONY: demo-P-ABOUT.1
demo-P-ABOUT.1: ## P-ABOUT.1 (ADR-0087): About panel — single-sourced app version (v1.8.7), LUCID + TechLead 187 + BUSL-1.1 licensing, animated rail glyph
	$(BUN) run desktop/scripts/demo_p_about_1.ts

.PHONY: demo-P-EXEC.1
demo-P-EXEC.1: ## P-EXEC.1 (ADR-0066): per-action exec approval — classifier (safe/risky/catastrophic), prompt interactive + block unattended, standing allows, managed denylist
	$(BUN) run desktop/scripts/demo_p_exec_1.ts

.PHONY: demo-P-GOAL.13
demo-P-GOAL.13: ## P-GOAL.13 (ADR-0067): unattended loop Speed↔Risk dial — graded tiers T0-T4, loopVerdict (T4 always blocks, unset=safest), managed ceiling, AAR Blocks section
	$(BUN) run desktop/scripts/demo_p_goal_13.ts

.PHONY: demo-P-ENT.2
demo-P-ENT.2: ## P-ENT.2 (ADR-0069): OCSF security audit export — each source → valid OCSF Detection Finding, fail-safe dispatcher (dead sink never blocks a turn)
	$(BUN) run desktop/scripts/demo_p_ent_2.ts

.PHONY: demo-P-ROLE.1
demo-P-ROLE.1: ## P-ROLE.1 (ADR-0088): role-based onboarding — closed role set, fail-safe normalize (unknown->developer), calm per-role default landing surface, cosmetic-only (gate untouched)
	$(BUN) run desktop/scripts/demo_p_role_1.ts

.PHONY: demo-P-ROLE.1b
demo-P-ROLE.1b: ## P-ROLE.1b (ADR-0089): first-run guided walkthrough — tailored per-role coachmark tour (opens on composer, closes on closer, no dangling targets), Back/Next/Skip card, replay-guard
	$(BUN) run desktop/scripts/demo_p_role_1b.ts

demo-P-NETDIAG.1: ## P-NETDIAG.1 (ADR-0090): in-app OAuth localhost-callback watcher - netstat/lsof parse, keeps loopback + all-interface listeners, flags a new callback-port listener as the bind-or-not evidence, read-only diagnostics (no gate verdict)
	$(BUN) run desktop/scripts/demo_p_netdiag_1.ts

demo-P-TOOLFAIL.1: ## P-TOOLFAIL.1 (ADR-0093): honest failed/rejected tool-call chip - distinguishes ran-and-errored (failed) from did-not-run (rejected/unavailable), surfaces omp's own message, never implies a security denial
	$(BUN) run desktop/scripts/demo_p_toolfail_1.ts

demo-P-EGRESS.2: ## P-EGRESS.2 (ADR-0094): a local-file browser open is labeled a local-file open (open-once/block, no host pin) not a website visit, http(s) egress unchanged, and the no-listener block is audited (folds in P-ENT.3)
	$(BUN) run desktop/scripts/demo_p_egress_2.ts

demo-P-LOC.3: ## P-LOC.3 (ADR-0095): the AI-authored code ledger is discoverable (command-palette entry) and never silently vanishes (always rendered when a session is active, with an explicit empty state)
	$(BUN) run desktop/scripts/demo_p_loc_3.ts

demo-P-PREVIEW.1: ## P-PREVIEW.1 (ADR-0096): in-app browser preview - resolver renders local files the agent builds, gates remote (egress, P-PREVIEW.3), blocks the ambiguous; panel + screenshot-to-chat seam
	$(BUN) run desktop/scripts/demo_p_preview_1.ts

demo-P-PREVIEW.2: ## P-PREVIEW.2 (ADR-0096): auto-surface the agent's freshly-written app - a write/edit of a previewable file (.html/.svg) lights up the Preview panel; reads + non-page writes never do
	$(BUN) run desktop/scripts/demo_p_preview_2.ts

demo-P-PREVIEW.3: ## P-PREVIEW.3 (ADR-0096): hardened preview sandbox - opaque-origin <iframe> (scripts on, same-origin off), no escape tokens, all powerful features denied
	$(BUN) run desktop/scripts/demo_p_preview_3.ts

demo-P-PREVIEW.3b: ## P-PREVIEW.3b (ADR-0096): a remote URL previews only through the egress gate - loads iff egress-approved AND https, opaque-origin; else stays gated (agent requests via egress flow)
	$(BUN) run desktop/scripts/demo_p_preview_3b.ts

demo-P-PREVIEW.3a: ## P-PREVIEW.3a (ADR-0096): agent-invoked preview_open tool (read-tier, real TSchema) - registration never breaks omp, execute gates local .html/.svg, acp_backend drives the panel off the call title (live omp+Electron verifies invocation)
	$(BUN) run desktop/scripts/demo_p_preview_3a.ts

demo-P-ENT.4: ## P-ENT.4 (ADR-0069): every per-action gate denial is auditable + attributed - explicit "denied by you" vs "fail-closed (turn ended / no response)"; closes the silent fail-closed-timeout gap
	$(BUN) run desktop/scripts/demo_p_ent_4.ts

demo-P-GATE-DIAG.1: ## P-GATE-DIAG.1 (ADR-0066/0062): dev-mode diagnostics recording the interactive-check inputs + decision for every exec/egress permission request (Logs → Exec / egress gate decisions) — reveals WHY a tool was auto-denied with no prompt
	$(BUN) run desktop/scripts/demo_p_gate_diag_1.ts

demo-P-PREVIEW.4: ## P-PREVIEW.4 (ADR-0096): RENDER local files in Preview via served-content + iframe srcdoc (Chromium blocks file:// from an http origin, so iframe.src=file:// never rendered)
	$(BUN) run desktop/scripts/demo_p_preview_4.ts

demo-P-PREVIEW.4b: ## P-PREVIEW.4b (ADR-0096): serve the preview with its OWN per-frame CSP (iframe.src, not srcdoc) so the app's inline scripts RUN - a srcdoc frame inherits script-src 'self' and blocked them; connect-src 'none' still blocks egress
	$(BUN) run desktop/scripts/demo_p_preview_4b.ts

demo-P-PREVIEW.3a-shot: ## P-PREVIEW.3a-shot (ADR-0096): the agent SEES its own UI - renderer caches a preview PNG, the preview_screenshot tool fetches it as ImageContent (read-tier); every failure path degrades to text
	$(BUN) run desktop/scripts/demo_p_preview_3a_shot.ts

demo-P-PREVIEW.4c: ## P-PREVIEW.4c (ADR-0096): MULTI-FILE apps render by inlining their own relative css/js/img/fonts (link→style, script src→inline, img/url→data:) under the SAME frame CSP; remote/traversal refs refused
	$(BUN) run desktop/scripts/demo_p_preview_4c.ts

.PHONY: demo-P-CHAT.1
demo-P-CHAT.1: ## P-CHAT.1 (ADR-0104): inline expandable code preview for tool steps - writes syntax-highlighted (Monaco), edits as green/red line diffs; proves the pure diff logic
	$(BUN) run desktop/scripts/demo_p_chat_1.ts

.PHONY: demo-P-FS.1
demo-P-FS.1: ## P-FS.1 (ADR-0103): full-tree workspace folder browser - browse above home to the FS root / drives, with an optional managed workspaceRoots confinement
	$(BUN) run desktop/scripts/demo_p_fs_1.ts

.PHONY: demo-P-NETWL.1
demo-P-NETWL.1: ## P-NETWL.1 (ADR-0106): curated network whitelist (domain wildcards + IP CIDR, internal/external, trust scopes) auto-allows egress under the managed ceiling; OS-encrypted credential vault fail-closes with no plaintext
	$(BUN) run desktop/scripts/demo_p_netwl_1.ts

.PHONY: demo-P-NETWL.3
demo-P-NETWL.3: ## P-NETWL.3 (ADR-0106): enforce project/loop trust scopes + per-loop call budget (first N auto-allow, then block), all under the managed ceiling
	$(BUN) run desktop/scripts/demo_p_netwl_3.ts

.PHONY: demo-P-KEYS.2
demo-P-KEYS.2: ## P-KEYS.2 (ADR-0107): credential rotation visibility (age/due/expiry, non-secret) + manual rotate-in-place (same ref, fail-closed)
	$(BUN) run desktop/scripts/demo_p_keys_2.ts

.PHONY: demo-P-PERF.2
demo-P-PERF.2: ## P-PERF.2 (ADR-0129): power/spec-aware perf tiers — battery→calm capped graph, low battery→viz paused (agent access untouched), poll backoff, user override
	$(BUN) run desktop/scripts/demo_p_perf_2.ts

.PHONY: demo-P-PERF.3
demo-P-PERF.3: ## P-PERF.3 (ADR-0130): KG layout continuity — re-open is a static paint (0 sim frames), refresh nestles newcomers, cold open exits on energy, positions never touch disk
	$(BUN) run desktop/scripts/demo_p_perf_3.ts

.PHONY: demo-P-PERF.4
demo-P-PERF.4: ## P-PERF.4 (ADR-0131): incremental session index (warm polls parse nothing) + tail-first transcript pages + AC-only prefetch gate
	$(BUN) run desktop/scripts/demo_p_perf_4.ts

.PHONY: demo-P-PERF.5
demo-P-PERF.5: ## P-PERF.5 (ADR-0132): switch hygiene - optimistic model switch, debounced lastModel write-behind (read-your-writes), memoized settings load, memoized picker
	$(BUN) run desktop/scripts/demo_p_perf_5.ts

.PHONY: demo-P-NETWL.5
demo-P-NETWL.5: ## P-NETWL.5 (ADR-0108): egress posture — allow-all + web-search toggles; whitelist enforces only when allow-all is off; still prompts for public IPs / foreign TLDs; managed clamp
	$(BUN) run desktop/scripts/demo_p_netwl_5.ts

.PHONY: demo-P-AGENT.1
demo-P-AGENT.1: ## P-AGENT.1 (ADR-0133): Agent Spec — a valid v1 DAG round-trips through DuckDB (migration 0010); a cyclic/invalid spec is refused fail-closed and never persisted
	$(BUN) run harness/scripts/demo_p_agent_1.ts

.PHONY: demo-P-AGENT.3
demo-P-AGENT.3: ## P-AGENT.3 (ADR-0133): the compiler buildAgent(spec) -> AgentBundle (system prompt + generated omp allow-list extension + manifest); the emitted extension enforces the allow-list; invalid spec refused
	$(BUN) run harness/scripts/demo_p_agent_3.ts

.PHONY: demo-P-AGENT.5
demo-P-AGENT.5: ## P-AGENT.5 (ADR-0133): untrusted-spec quarantine gate vs the real scanner — imported/poisoned specs are quarantined + blocked from auto-running; only a clean local spec is trusted + runnable
	$(BUN) run harness/scripts/demo_p_agent_5.ts

.PHONY: demo-P-AGENT.6
demo-P-AGENT.6: ## P-AGENT.6 (ADR-0133): enterprise export — package a compiled agent portably for electron/web/cloud with a tamper-evident content digest; verifyExport catches modification
	$(BUN) run harness/scripts/demo_p_agent_6.ts

.PHONY: demo-P-AGENT.4-live
demo-P-AGENT.4-live: ## P-AGENT.4-live (ADR-0133): run a BUILT agent on a REAL Claude model (Haiku). NEEDS a model + network — NOT part of `make test`. Proves the agent runs + follows its compiled spec, AND its allow-list extension hard-blocks disallowed tools.
	$(BUN) run harness/scripts/demo_p_agent_4_live.ts
	$(BUN) run harness/scripts/demo_p_agent_4_live_enforce.ts

.PHONY: demo-P-AGENT.8.1
demo-P-AGENT.8.1: ## P-AGENT.8.1 (ADR-0134): secret guardrail — agents DECLARE credential names (SecretRef); a secret VALUE embedded in a spec is refused at compile + save (secrets belong in the vault)
	$(BUN) run harness/scripts/demo_p_agent_8_1.ts

.PHONY: demo-P-AGENTFW.1
demo-P-AGENTFW.1: ## P-AGENTFW.1 (ADR-0147): agent-firewall MCP — scans both directions vs a remote ACP agent (hermes/openclaw); quarantines poisoned replies, neutralizes delimiter breakout, blocks outbound hidden vectors, fails closed when the scanner dies
	$(BUN) run harness/scripts/demo_pagentfw1.ts

.PHONY: demo-P-MCP-GATE.1
demo-P-MCP-GATE.1: ## P-MCP-GATE.1 (ADR-0148): in-process MCP tool_result gate — poisoned MCP result withheld, clean result delimited+labeled untrusted, LOCAL tool results untouched (source-scoped), fail-closed
	$(BUN) run harness/scripts/demo_pmcpgate1.ts

.PHONY: demo-P-LOCAL.1
demo-P-LOCAL.1: ## P-LOCAL.1 (ADR-0135): Local Providers — declare a self-hosted / custom OpenAI-compatible LLM (Ollama, llama.cpp, vLLM, DGX-over-VPN); validate fail-closed, emit the omp --config overlay (secret from the vault, skipped if absent), persist WITHOUT the secret
	$(BUN) run desktop/scripts/demo_p_local_1.ts

.PHONY: demo-P-VISION.1
demo-P-VISION.1: ## P-VISION.1 (ADR-0136): paste/drop a screenshot into the prompt bar — validate fail-closed (image-only, size/count caps), emit an omp image content block (base64, prefix stripped), and render a thumbnail strip that never interpolates the data URL (XSS-safe)
	$(BUN) run desktop/scripts/demo_p_vision_1.ts

.PHONY: demo-P-NVIM.1
demo-P-NVIM.1: ## P-NVIM.1 (ADR-0150): Neovim + terminal integration — `lucid tui` is the gated command minus `acp` (gate first, policy, passthru last), fail-closes (dead scanner ⇒ no spawn), and the Neovim plugin's pure helpers pass headless nvim
	$(BUN) run harness/scripts/demo_pnvim1.ts

.PHONY: demo-P-THEME.1
demo-P-THEME.1: ## P-THEME.1 (ADR-0160): the LUCID skin for gated terminals — themes/lucid.json resolves, session_start provisions (idempotent) + setTheme("lucid"), fail-OPEN cosmetics never weaken fail-CLOSED, and the theme -e rides behind the gate -e
	$(BUN) run harness/scripts/demo_ptheme1.ts

.PHONY: nvim-plugin-split
nvim-plugin-split: ## Split extensions/neovim -> the standalone `lucid.nvim` branch (add PUSH=1 to force-push to origin)
	@sha=$$(git subtree split --prefix=extensions/neovim HEAD); \
	echo "lucid.nvim split -> $$sha"; \
	if [ "$(PUSH)" = "1" ]; then git push -f origin "$$sha:refs/heads/lucid.nvim"; else echo "(dry run — add PUSH=1 to publish; CI does this on every master push)"; fi

.PHONY: demo-P-PREVIEW.6a
demo-P-PREVIEW.6a: ## P-PREVIEW.6a (ADR-0153): the agent reviews its work live in the preview — a preview tool-call (screenshot/open/inspect/action) maps to a user-facing label that glows the panel + shows a "reviewing/testing" pill; non-preview tools never trigger it
	$(BUN) run desktop/scripts/demo_p_preview_6a.ts

.PHONY: demo-P-PREVIEW.6b
demo-P-PREVIEW.6b: ## P-PREVIEW.6b (ADR-0153): the agent READS the live preview DOM — a held tool→server→renderer→iframe relay + a READ-ONLY postMessage bridge injected into the sandboxed preview (no eval/mutation), fail-closed on timeout
	$(BUN) run desktop/scripts/demo_p_preview_6b.ts

.PHONY: demo-P-PREVIEW.6c
demo-P-PREVIEW.6c: ## P-PREVIEW.6c (ADR-0153): the agent CLICKS/TYPES in the live preview by CSS selector — structured actions through the same relay + bridge (fixed allowlist click/type/focus/scroll; still no eval/innerHTML)
	$(BUN) run desktop/scripts/demo_p_preview_6c.ts

.PHONY: demo-P-DESIGN.1
demo-P-DESIGN.1: ## P-DESIGN.1 (ADR-0154): the agent honors a workspace DESIGN.md — read + wrapped as a <design-invariants> block and re-delivered in the user-turn preamble EVERY turn (never the frozen prefix); no DESIGN.md → no block
	$(BUN) run desktop/scripts/demo_p_design_1.ts

.PHONY: demo-P-MARKET.1
demo-P-MARKET.1: ## P-MARKET.1 (ADR-0158): the Plugin Marketplace popup - Excalidraw pinned first, then Obsidian's top-ranked integrations by community downloads; searchable scrim-modal on the About//goal conventions; rows only open their GitHub repo (installs are P-MARKET.2)
	$(BUN) run desktop/scripts/demo_p_market_1.ts

.PHONY: demo-P-FIGMA.1
demo-P-FIGMA.1: ## P-FIGMA.1 (ADR-0154): /figma — parse a Figma file URL → key, walk the doc → top frames (capped), build a design-board HTML with frames inlined as PNG data URLs (names escaped, only data:image src) for the sandboxed preview
	$(BUN) run desktop/scripts/demo_p_figma_1.ts

.PHONY: demo-P-FIGMA.2
demo-P-FIGMA.2: ## P-FIGMA.2 (ADR-0154): after /figma import, a guided step — review the design / open-or-build DESIGN.md; an agent write to DESIGN.md is detected (no false positives) → `design-available` pops it out in the IDE, then it's honored as standing guidance
	$(BUN) run desktop/scripts/demo_p_figma_2.ts

.PHONY: demo-P-SANDBOX.1
demo-P-SANDBOX.1: ## P-SANDBOX.1 (ADR-0157): the runtime execution boundary — sandbox seam (bwrap/noop), canNetwork/canExec caps ENFORCED at the omp spawn (suspicious-chain downgrade = real --unshare-net), managed require-isolation fail-closes, disclosed passthrough elsewhere
	$(BUN) run harness/scripts/demo_p_sandbox_1.ts

.PHONY: demo-P-SANDBOX.2
demo-P-SANDBOX.2: ## P-SANDBOX.2 (ADR-0166): mediated subprocess egress — a loopback DNS + CONNECT proxy decided by the agent's own egressDecisionDetailed brain (only allow passes; prompt/foreign-ccTLD/IP-literal/unparseable/thrown all DENY). Live: denied gethostbyname → REFUSED, upstream never contacted; allowed → forwarded. Proxy dead ⇒ egress denied but local exec still runs; wired at the omp spawn (HTTP(S)_PROXY + resolv.conf steer)
	$(BUN) run harness/scripts/demo_p_sandbox_2.ts

.PHONY: demo-P-SANDBOX.3
demo-P-SANDBOX.3: ## P-SANDBOX.3 (ADR-0167): the mediated-egress audit trail — a BLOCKED subprocess reach-out becomes one canonical `egress` SecurityEvent (block/high) on the audit/OCSF pipeline (P-REPORT.10 precedent; no new EventName, no approvable live-block); deduped by host so a looping exfil can't flood the SIEM; allowed reach-outs emit nothing; auditing never weakens the fail-closed guarantee (throwing sink swallowed, dead proxy still denies)
	$(BUN) run harness/scripts/demo_p_sandbox_3.ts

.PHONY: demo-P-SANDBOX.4
demo-P-SANDBOX.4: ## P-SANDBOX.4 (ADR-0168): the macOS Seatbelt backend — real runtime containment on macOS via `sandbox-exec`. Declared caps enforced (network-off denies ALL network + cuts DNS via mDNSResponder); mediated egress CONFINED TO LOOPBACK so a raw-IP socket ignoring HTTP_PROXY is kernel-denied (bwrap only drops it); require-isolation fail-closed on macOS-without-sandbox-exec + Windows. Windows AppContainer (native) + Linux slirp raw-socket forwarding are named follow-ups
	$(BUN) run harness/scripts/demo_p_sandbox_4.ts

.PHONY: demo-P-SANDBOX.5
demo-P-SANDBOX.5: ## P-SANDBOX.5 (ADR-0169): the runtime-execution boundary made VISIBLE in the Security panel — a GUI-owned store of the live posture (bwrap/Seatbelt/disclosed/fail-closed-blocked) + a bounded newest-first ring of refused subprocess reach-outs; a PURE panel builder rendering green/amber/red posture (auto-opens when NOT isolated), escaping hostile host/reason text; the egress audit sink feeds one deduped panel row per refused host
	$(BUN) run desktop/scripts/demo_p_sandbox_5.ts

.PHONY: demo-P-SANDBOX.6
demo-P-SANDBOX.6: ## P-SANDBOX.6 (ADR-0172): the Windows AppContainer backend SEAM — a first-party `lucid-appcontainer <flags> -- <argv>` helper that fits the wrap→{cmd,args,env} contract (no OS argv-wrapper exists for AppContainer). Flag contract mirrors bwrap/Seatbelt's 3 network states (network-off → --deny-network; mediated → --loopback-only + HTTP(S)_PROXY, raw-IP sockets WFP-denied; no-proxy → fail-closed --deny-network); resolveBackend selects it when the helper is on PATH, else discloses; require-isolation fail-closed without it. The native helper itself ships in P-SANDBOX.7
	$(BUN) run harness/scripts/demo_p_sandbox_6.ts

.PHONY: demo-P-SANDBOX.7
demo-P-SANDBOX.7: ## P-SANDBOX.7 (ADR-0173): the native Windows AppContainer helper (bun-compiled TS+FFI). Parser fail-closes on malformed flags; main() refuses (non-zero) wherever it cannot contain (never a passthrough); LIVE on Windows a benign child runs but a networked child is BLOCKED (a no-capability AppContainer has no network); off-Windows it correctly refuses
	$(BUN) run harness/scripts/demo_p_sandbox_7.ts

.PHONY: build-appcontainer
build-appcontainer: ## P-SANDBOX.7: cross-compile the native lucid-appcontainer.exe helper (bun build --compile, Windows x64) into dist/
	$(BUN) build tools/appcontainer/lucid_appcontainer.ts --compile --target=bun-windows-x64 --outfile dist/lucid-appcontainer.exe

.PHONY: demo-P-REPORT.9
demo-P-REPORT.9: ## P-REPORT.9 (ADR-0162): multi-repo remote fetch + PR aggregation for the Engineering Report — remote-URL parse (GitHub vs not), commits aggregated across branches (deduped) + line totals, the Cross-repo activity annex, fail-soft on a failed fetch (local refs still shown), PRs skipped with a reason on non-GitHub/unauthed remotes, and untrusted commit/PR text neutralized (no HTML/fence breakout)
	$(BUN) run desktop/scripts/demo_p_report_9.ts

.PHONY: demo-P-TOOLFAIL.2
demo-P-TOOLFAIL.2: ## P-TOOLFAIL.2 (ADR-0163): failed tool calls collapse into a red toolbox badge, click expands the Tool Call Actions list (command attempted + full error); never a security surface
	$(BUN) run desktop/scripts/demo_p_toolfail_2.ts

.PHONY: demo-P-REPORT.10
demo-P-REPORT.10: ## P-REPORT.10 (ADR-0164): a formal SecurityEvent per fetch/PR reach-out — the report collector's first-party git fetch / gh PR list (which bypass the agent gate) each emit a canonical egress/allow SecurityEvent (OCSF/SIEM), metadata-only (host, no credential), skipped PR lists emit nothing, proven live+offline via a local bare-origin fetch through the real dispatcher
	$(BUN) run desktop/scripts/demo_p_report_10.ts

.PHONY: demo-P-FAV.1
demo-P-FAV.1: ## P-FAV.1 (ADR-0165): model-picker favorite stars - star a model to pin it into a Favorites section at the top of the picker; catalog order preserved, corrupted storage degrades safely, stale stars survive provider reconnects
	$(BUN) run desktop/scripts/demo_p_fav_1.ts

.PHONY: demo-P-SECACK.1
demo-P-SECACK.1: ## P-SECACK.1 (ADR-0170): reviewed security rows leave the active view - GUI-owned ack ledger (releases NOTHING, audit kept), findings-seen watermark counts only new findings, and the right-click Cut/Copy/Paste menu for the prompt bar (no Cut/Copy on password fields)
	$(BUN) run desktop/scripts/demo_p_secack_1.ts

.PHONY: demo-P-RESUME.1
demo-P-RESUME.1: ## P-RESUME.1 (ADR-0171): a resumed session keeps its thinking + tool-call + tool-failure history - per-session lucid-steps sidecar (omp's transcript untouched), turn anchors only move forward, quarantines not duplicated, hostile text escaped, corrupt sidecar degrades safely
	$(BUN) run desktop/scripts/demo_p_resume_1.ts

.PHONY: dashboards
dashboards: ## Materialize dashboard CSVs from a DuckDB into observable/docs/data (DB=path)
	$(BUN) run harness/scripts/materialize_dashboards.ts $(DB) observable/docs/data

# ---------------------------------------------------------------------------
# Hygiene
# ---------------------------------------------------------------------------

.PHONY: typecheck
typecheck: ## TS typecheck (no emit)
	$(BUN) x tsc --noEmit

.PHONY: license-headers
license-headers: ## Apply the BUSL-1.1 SPDX header to first-party source (idempotent)
	$(BUN) run tools/license_headers.ts

.PHONY: license-check
license-check: ## Fail if any first-party source file is missing the BUSL-1.1 header (CI guard)
	$(BUN) run tools/license_headers.ts --check

.PHONY: clean
clean: ## Remove build/test artifacts (keeps committed source + DBs)
	rm -rf node_modules/.cache .bun 2>/dev/null || true
	find . -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: demo-P-TRIV.1
demo-P-TRIV.1: ## P-TRIV.1 (ADR-0174): the Trivia Wire - a word-game ticker in the status bar's idle gap; seed bank valid + varied, no repeats until the bank empties, streak scoring capped at x3, corrupt/throwing storage degrades safely, streaming-only visibility, hostile question text renders as text (never markup)
	$(BUN) run harness/scripts/demo_ptriv1.ts

.PHONY: demo-P-TRIV.2
demo-P-TRIV.2: ## P-TRIV.2 (ADR-0175): role-aware Trivia Wire - executive→GovCon (M&A/opportunities/federal priorities), manager→CMMI-DEV L3 + PM, security→CMMC + RMF, developer/none→general; banks valid + domain-confined + duplicate-free; idle engagement wakes the ticker on an empty composer only when past sessions or an unlocked KG exist
	$(BUN) run harness/scripts/demo_ptriv2.ts

.PHONY: demo-P-TRIV.3
demo-P-TRIV.3: ## P-TRIV.3 (ADR-0176): 100-question dev/security/manager banks + 50 executive - and the executive INTEL WIRE: curated defense/intel RSS fetched first-party (host-only egress audit), scan-gated FAIL-CLOSED (findings or a dead scanner drop the batch), fail-quiet offline, rendered as escaped text between questions
	$(BUN) run harness/scripts/demo_ptriv3.ts

.PHONY: demo-P-PREVIEW.7
demo-P-PREVIEW.7: ## P-PREVIEW.7 (ADR-0179): the silent-white preview explained + runnable - the injected bridge posts a one-shot health report (empty body + bounded errors); Electron apps detect evidence-based (fail-false for plain pages); launch plan prefers the app's own electron, falls back to PATH, null otherwise; non-Electron paths never plan a launch
	$(BUN) run harness/scripts/demo_ppreview7.ts

.PHONY: demo-P-TASK.5
demo-P-TASK.5: ## P-TASK.5 (ADR-0180): live subagent activity - the delegation card opens each subtask (generated name, live now-line, thinking/tool/text steps tailed from omp's per-subtask transcripts); read-only + path-confined + corrupt-tolerant + bounded; never-delegated sessions fail-quiet
	$(BUN) run harness/scripts/demo_ptask5.ts

.PHONY: demo-P-SYSRES.1
demo-P-SYSRES.1: ## P-SYSRES.1 (ADR-0182): the system resource guard - a weak CPU under heavy load / RAM pressure pauses the KG + Code Graph builds behind a notice (why + machine line + top-processes panel + re-check, no escape hatch); FAIL-OPEN (no evidence never blocks); read-only fixed-argv process listing
	$(BUN) run desktop/scripts/demo_p_sysres_1.ts

.PHONY: demo-P-KGVIZ.1
demo-P-KGVIZ.1: ## P-KGVIZ.1 (ADR-0183): form in place - the KG/code-graph settle runs OFF-SCREEN (time-boxed presettle) so hundreds of nodes open already formed at the final center, parked; live merges settle silently; resizes re-fit without reheating; drag is the only visible sim
	$(BUN) run desktop/scripts/demo_p_kgviz_1.ts

.PHONY: demo-P-KGPACK.1
demo-P-KGPACK.1: ## P-KGPACK.1 (ADR-0205): named, swappable KGs (file-per-KG + JSON registry) - the pre-existing combined kb_graph.duckdb is ADOPTED as the default "My Knowledge" KG (zero data loss), new role KGs are ISOLATED files (a page in one is invisible from another), rename touches only the label, and switching the active KG re-points a no-arg store lookup
	$(BUN) run desktop/scripts/demo_p_kgpack_1.ts

.PHONY: demo-P-KGUI.1
demo-P-KGUI.1: ## P-KGUI.1 (ADR-0184): the KG header decluttered - title "KG" (hover: Knowledge Graph, icon dropped) and the Relate/Code-graph/Compiled-KB stack consolidated into ONE labeled dropdown (hover tip lists the options; the menu explains each inline; active view checked)
	$(BUN) run desktop/scripts/demo_p_kgui_1.ts

.PHONY: demo-P-KGUI.2
demo-P-KGUI.2: ## P-KGUI.2 (ADR-0185): the Data dropdown - Import history / AI-extraction toggle / Export vault / CUI archive folded from three buttons + a checkbox into one self-describing menu; the AI toggle is remembered state (never closes the menu); CUI keeps its danger look + confirm toast
	$(BUN) run desktop/scripts/demo_p_kgui_2.ts

.PHONY: demo-P-TRIV.4
demo-P-TRIV.4: ## P-TRIV.4 (ADR-0191): the Settings toggle + an AI re-seed ("recycle") for the Trivia Wire - regenerate a per-role pack on the user's SELECTED model from opt-in context (sessions/KG/code graph); context is scanned FAIL-CLOSED (a finding or a dead scanner drops the whole re-seed, model never called), delimited + late, generated questions clear the SAME isTriviaQuestion gate as the seed floor, fail-quiet to the seed bank
	$(BUN) run harness/scripts/demo_ptriv4.ts
.PHONY: demo-P-EVAL.1
demo-P-EVAL.1: ## P-EVAL.1 (ADR-0187): the PURE Model-Evaluation metrics + per-model API-latency rollup core - metric formulas with direct/proxy/needs_signal honesty tiers (a missing signal is null, never zero), DST-correct business-hours (08:00-17:00 ET) bucketing + nearest-rank p50/p95, per-model-by-hour weekly/monthly rollup with WoW/MoM deltas, and ASCII-only mermaid xychart markdown the existing report viewer bar-ifies
	$(BUN) run harness/scripts/demo_peval1.ts
.PHONY: demo-P-CHAT.A
demo-P-CHAT.A: ## P-CHAT.A (ADR-0188): sectioned agent turn - PURE fence-aware heading/rule splitter (sectionizeAnswer) that turns a settled answer into collapsible sections (streaming unchanged; a trivial answer is never accordioned) + subagent card collapsed by default. Pure keystone verified here; the app.ts settle-transform + collapse are typechecked and QA-gated in-app
	$(BUN) run harness/scripts/demo_pchata.ts
.PHONY: demo-P-CHAT.B
demo-P-CHAT.B: ## P-CHAT.B (ADR-0189): inline tool-event chips - PURE fence-aware / block-boundary interleave (interleaveChips) that threads each tool call back into the settled answer as an expandable chip anchored where it fired (prose parts still sectionize via P-CHAT.A; a no-tool answer is unchanged) + a +/- diffstat per edit/write + a lazy drilldown. Pure keystone verified here; the app.ts settle interleave + chip drilldowns + thoughts-window drop are typechecked and QA-gated in-app
	$(BUN) run harness/scripts/demo_pchatb.ts
.PHONY: demo-P-CHAT.C
demo-P-CHAT.C: ## P-CHAT.C (ADR-0190): settled-turn "Generate engineering report" - PURE observed-turn->RunRecord adapter (buildRunRecord/renderTurnEvalReport) that maps a turn's tool calls + diffstats + tokens into evals.ts's RunRecord (reads/searches/bash are not files, repeated edits merge, the surplus is a re-edit, no AC/test signal stays needs_signal not faked) and renders the reused Model-Evaluation markdown. Pure keystone verified here; the run-footer CTA + /api/eval/report route are typechecked and QA-gated in-app
	$(BUN) run harness/scripts/demo_pchatc.ts
.PHONY: demo-P-STALL.1
demo-P-STALL.1: ## P-STALL.1 (ADR-0186): patience for overloaded providers - the chat turn waits 10 min (was 5, message falsely said 2); a slow event at each silent 2-min mark keeps the wait visible (HUD phase + one toast naming the cap); the stall error derives its duration from the constant
	$(BUN) run desktop/scripts/demo_p_stall_1.ts
.PHONY: demo-P-EVAL.2
demo-P-EVAL.2: ## P-EVAL.2 (ADR-0187): the API-latency CAPTURE + PERSISTENCE pipeline - the GUI-side sink turns t_sent/t_first_token/t_end into a LatencySample appended to an append-only JSONL (the GUI opens the observer DB read-only), the frozen migration 0011 creates api_latency + eval_metrics + the latency_rollup view, the single-writer ingest loads the JSONL idempotently, and readLatencyCalls round-trips the rows back into evals.ts's ApiLatencyCall (ok-only) so rollupLatency + render stay the P-EVAL.1 source of truth
	$(BUN) run harness/scripts/demo_peval2.ts
.PHONY: demo-P-EVAL.3
demo-P-EVAL.3: ## P-EVAL.3 Part A (ADR-0187): the per-run eval-metrics PERSISTENCE pipeline - evalMetricsForTurn maps an observed turn to EvalMetrics (reuses P-CHAT.C + P-EVAL.1), the GUI-side sink flattens it to a sample + appends to an append-only JSONL keeping the honesty rule (a no-signal metric is null not 0, tier preserved), the single-writer ingest loads eval_metrics idempotently on run_id, and readEvalMetricsRows round-trips the rows back (NULLs + tiers intact) for the cross-run rollup
	$(BUN) run harness/scripts/demo_peval3.ts
.PHONY: demo-P-EVAL.3b
demo-P-EVAL.3b: ## P-EVAL.3 Part B (ADR-0187): the cross-run Model-Evaluation ROLLUP report (the /api/eval/rollup path) - the eval-metrics + latency JSONL ledgers ingest into a throwaway GUI-owned DuckDB, aggregateEvalMetrics rolls per model (means over runs-with-signal; a no-signal metric stays "no signal", never a fake 0), rollupLatency adds the per-model p50/p95, and the combined ASCII markdown (xychart-beta the viewer bar-ifies) saves as an `evals` brief; an empty ledger yields a friendly report, never an error
	$(BUN) run harness/scripts/demo_peval3b.ts
.PHONY: demo-P-COLLAB.1
demo-P-COLLAB.1: ## P-COLLAB.1 (ADR-0192): the live-collaboration transport KEYSTONE - a host mints a room (id + 32B key + 16B write token) + a full/view invite link (roomId.base64url(secret), reusing omp's @oh-my-pi/pi-wire constants), SEALS a LUCID ChatEvent frame (AES-256-GCM, [12B IV][ct+tag]) + envelopes it with its peer id, and a guest holding the link unpacks + opens it end-to-end; the relay only ever sees opaque bytes (a wrong key can't open, a tampered byte fails the tag), and a view link is read-only. The relay client, host/guest, and Share UI are P-COLLAB.2-.4
	$(BUN) run harness/scripts/demo_pcollab1.ts
.PHONY: demo-P-COLLAB.2
demo-P-COLLAB.2: ## P-COLLAB.2 (ADR-0192): the relay CLIENT + the view-only broadcast HOST, proven end-to-end offline - an in-memory relay routes opaque envelopes between a REAL host CollabSocket (driven by a REAL CollabHost) and REAL guest sockets: a guest joins with a view link + hello, the host answers with a unicast E2E welcome (header + replayed transcript + roster), broadcasts live ChatEvents the guests open, a 2nd guest joins mid-stream and its state shows the folded context fill, and view-only is enforced host-side even for a full-token guest (Phase 1); the relay never sees plaintext. Fail-closed: a bad-key frame terminates the socket (no reconnect). The Share panel UI + guest join/render + guest-write are P-COLLAB.3
	$(BUN) run harness/scripts/demo_pcollab2.ts
.PHONY: demo-P-COLLAB.3
demo-P-COLLAB.3: ## P-COLLAB.3 (ADR-0192): the backend host LIFECYCLE (CollabManager) dev.ts wires to /api/collab/* + the /api/chat ChatEvent tap - a REAL CollabManager mints a room over an in-memory relay (self-hosted-default resolveRelay), a REAL guest socket joins with the view link + gets an E2E welcome, the manager taps live ChatEvents through to the guest (the passthrough), status reflects the roster, stop tears it down + sends bye, and start REFUSES when no relay is authorized (fail-closed - no self-hosted URL + public opt-in off). The Share panel UI + guest join/render + guest-write are the next slice
	$(BUN) run harness/scripts/demo_pcollab3.ts
.PHONY: demo-P-COLLAB.4
demo-P-COLLAB.4: ## P-COLLAB.4/.5 (ADR-0192): the read-only GUEST + the OPTIONAL embedded relay, end-to-end over REAL localhost WebSockets - LUCID starts its OWN relay (127.0.0.1, no third party), a real host (CollabSocket+CollabHost) + real guest (CollabSocket+CollabGuest) connect through it: the guest pastes the view link + gets an E2E welcome, the host's live ChatEvents stream host->relay->guest read-only, the roster tracks a 2nd guest join/leave, a guest to a nonexistent room is refused (fail-closed, relay saw only ciphertext), and stop tells the guest. The Join panel UI + the 'be the relay' toggle are the UI slice
	$(BUN) run harness/scripts/demo_pcollab4.ts
.PHONY: demo-P-COLLAB.12
demo-P-COLLAB.12: ## P-COLLAB.12 (ADR-0198): guest-WRITE over a real relay - a guest with EDIT access (full link + valid write token) drives the host: its prompt reaches onGuestPrompt (which in the app runs it in the host's omp session, where the fail-closed scan gate + exec/egress approvals still apply - the guest bypasses nothing) + onGuestAbort. A VIEW-only guest is refused BOTH client-side (sendPrompt returns false, never hits the wire) AND host-side (a hand-crafted raw prompt frame is refused with a read-only error, never runs). Token-gated + fail-closed
	$(BUN) run harness/scripts/demo_pcollab12.ts
.PHONY: demo-P-COLLAB.11
demo-P-COLLAB.11: ## P-COLLAB.11 (ADR-0197): WebRTC signaling over the relay - the SDP offer/answer + trickled ICE route host<->guest as `signal` frames through the relay's peer routing (signal to peer 0 -> host; to the guest's peer id -> guest), a `signal` frame is recognized by the demux (session handlers ignore it), and close is terminal. This SignalingChannel is what WebRtcTransport consumes before the peers go DIRECT P2P (RTCPeerConnection is renderer-only, so the DataChannel itself is preview-verified)
	$(BUN) run harness/scripts/demo_pcollab11.ts
.PHONY: demo-P-COLLAB.9
demo-P-COLLAB.9: ## P-COLLAB.9 (ADR-0195): the STANDALONE relay broker (tools/relay) - spawns `bun run tools/relay/serve.ts` as a separate process exactly like a jumpbox/systemd would, waits for /healthz, then connects a REAL host + REAL guest THROUGH the deployed process (hello->welcome->live event->bye), and confirms /healthz reflects the live room + peer counts (never content). Validates the deployable, not just the in-process library. Self-contained (no npm deps); deploy on an office server / Ubuntu 24 jumpbox / DGX Spark
	$(BUN) run harness/scripts/demo_pcollab9.ts
.PHONY: demo-P-COLLAB.6
demo-P-COLLAB.6: ## P-COLLAB.6 (ADR-0193): enterprise/MDM governance for the embedded relay - fail-closed + absolute allowlisting. Unmanaged = the user's call; a managed allowServe:false FORBIDS hosting (startRelayServer THROWS, no listener); under management a LAN/0.0.0.0 bind is REFUSED unless it's on the absolute host:port allowlist (localhost always ok); allowedRelays whitelists which relay endpoints a user may connect to (malformed fails closed). The 'be the relay' toggle UI reads this + managedLocks.collab
	$(BUN) run harness/scripts/demo_pcollab6.ts
