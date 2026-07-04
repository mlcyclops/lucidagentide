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
