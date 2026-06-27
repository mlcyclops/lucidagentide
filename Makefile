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
install: install-harness install-sidecar ## Install harness + sidecar deps

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
test-harness: ## Bun test suite (empty-green to start)
	$(BUN) test

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

.PHONY: dashboards
dashboards: ## Materialize dashboard CSVs from a DuckDB into observable/docs/data (DB=path)
	$(BUN) run harness/scripts/materialize_dashboards.ts $(DB) observable/docs/data

# ---------------------------------------------------------------------------
# Hygiene
# ---------------------------------------------------------------------------

.PHONY: typecheck
typecheck: ## TS typecheck (no emit)
	$(BUN) x tsc --noEmit

.PHONY: clean
clean: ## Remove build/test artifacts (keeps committed source + DBs)
	rm -rf node_modules/.cache .bun 2>/dev/null || true
	find . -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
