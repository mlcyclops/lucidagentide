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
