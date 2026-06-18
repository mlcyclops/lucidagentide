# Build Plan (omp-based) — Local-First Agentic Coding IDE Harness (v3)

> Strategy change from the original plan: instead of building the core harness
> from scratch, we build **around oh-my-pi (omp)** as an SDK consumer +
> extensions. omp already provides tool-calling, a multi-provider model
> registry, streaming, sessions/branching, modes, sandbox isolation, and a TUI.
> Our real work becomes the v3 security/provenance/memory model, layered on top
> via hooks and custom tools — plus a cache-optimized prompt assembly.

-----

## Integration stance (read once, then don’t relitigate)

**Build as SDK + extensions, NOT a fork.** omp ships 300+ releases; a fork means
permanent merge pain. The extension surface is enough for almost everything in
the PRD:

|PRD subsystem                                             |omp seam                              |Notes                                                                                     |
|----------------------------------------------------------|--------------------------------------|------------------------------------------------------------------------------------------|
|Security scan / quarantine gate                           |`pre` hook on `tool_call` + ingestion |Hook can `return { block: true, reason }` — this *is* fail-closed quarantine              |
|Content scanner / sanitizer / export / incident bundle    |custom tools (`.omp/tools/*/index.ts`)|Return omp’s `{ content: [{type,text}] }` shape; adapt to PRD `ToolResult` at the boundary|
|DuckDB memory + telemetry                                 |`post` hook ingesting session JSONL   |omp already writes JSONL sessions with stable Snowflake IDs                               |
|Modes (plan/build/general/subagent/replay/security-review)|omp modes                             |plan/build/general/subagent exist; add replay + security-review as constrained configs    |
|Sandbox profiles                                          |omp isolation backends                |worktree / fuse-overlay / ProjFS already exist; your profiles are a policy layer          |
|Instruction loading + precedence                          |omp config discovery                  |omp already discovers AGENTS.md / CLAUDE.md / .claude / .codex etc.                       |
|Model routing                                             |omp model registry + roles            |40+ providers, role-based routing already present                                         |

**Hard rule:** if something seems to need a fork, first try a hook or custom
tool; if truly impossible, contribute upstream rather than fork. Record any such
decision in `DECISIONS.md`.

**Boundary adapter:** omp’s tool result is `{ content: [{type, text}] }`; the PRD
specifies a `ToolResult` dataclass. Write ONE adapter module that converts
between them and import it everywhere. This is a frozen contract file.

-----

## What collapses vs. the original plan

- **Original increments 0–P1.4 (build core harness) mostly disappear.**
  Instruction loading, prompt assembly, mode selection, model registry, and tool
  routing already exist in omp. Those increments become *configuration +
  constraint*, not construction.
- **Your first real code is the security layer** (was Phase 2). That’s also your
  genuinely novel contribution, so this is a feature, not a compromise.
- **“Stable IDs everywhere” is half-done for free** — omp’s Snowflake session
  IDs satisfy part of the PRD Phase 3 requirement.

-----

## The anti-drift spine (unchanged in spirit)

- **Contracts first**, but now they’re *boundary* contracts: the omp↔PRD
  ToolResult adapter, the `TrustLabel` enum, the `EventName` enum, the DuckDB
  schema, and the frozen prompt prefix.
- **Golden-path replay tests** using omp’s `--mode rpc` / `--mode json` +
  `--no-session` with a fake/echo provider in the registry. Fast (<5s),
  no live model.
- **Vertical slices with a `make demo-XX`.**
- **Frozen `CLAUDE.md` invariants file**, re-read at the top of every session.

-----

## Increment 0 — Harness bring-up + invariants (½ session)

**Goal:** a working omp install you drive programmatically, plus the rules file.

Deliverables:

- omp installed; confirm SDK import (`@oh-my-pi/pi-coding-agent`) and a headless
  run via `omp -p "..." --no-session`.
- Register a **fake/echo provider** in `~/.omp/agent/models.yml` (or project
  `models.yml`) pointing at a local stub, so tests need no network/keys.
- Repo skeleton for *your* code: `harness/{security,memory,telemetry,tools,hooks,prompt}/`.
- `CLAUDE.md` invariants (see original plan’s list) PLUS:
  - “We extend omp; we do not fork it. Hooks/tools first.”
  - The ToolResult adapter is the only place the two result shapes meet.
  - The frozen prompt prefix is byte-stable; nothing volatile goes in it.
- `make test` (empty green), `make demo-00` (echo-provider round-trip through omp).

**Acceptance:** headless omp call returns through the echo provider; `make test` green.

-----

## Increment 1 — Boundary contracts (1 session)

Freeze the shared types and the adapter.

- `harness/contracts.py` (or `.ts` if you co-locate with omp’s TS — pick one
  language for the harness and record it in DECISIONS.md): `TrustLabel`,
  `AgentMode`, `EventName`, `ExecutionProfile`, PRD `ToolResult`.
- `harness/tools/result_adapter`: omp `{content:[...]}` ↔ PRD `ToolResult`.
- `harness/telemetry/events`: `emit(event_name, **fields)` → JSONL; unknown
  event name raises; every event carries `run_id`, `session_id`, `artifact_id?`.

**Acceptance:** `make demo-01` emits events + round-trips a ToolResult both ways.

-----

## Increment 2 — Cache-optimized prompt assembly (1 session)  ★ NEW

This is the KV-cache work. The technique is **stable-prefix discipline**, not
secret headers.

**Build:**

- A system-prompt composer that emits the PRD’s 9 layers with a hard split:
  - **Frozen prefix (layers 1–4):** identity + safety, tool-use/permission
    policy, stable coding rules, security/trust-boundary rules. Byte-identical
    across all requests.
  - **Volatile tail (layers 5–9):** instruction files, sanitized retrieved
    content (delimited), task request, session state, working-memory block.
- Place the cache breakpoint at the end of the frozen prefix (Anthropic:
  `cache_control: {type: "ephemeral"}` on the last stable block; other providers
  auto-detect longest prefix).
- Keep **tool definitions stable and ordered** — tool schemas are part of the
  cached prefix on most providers; never reorder per request.

**omp-specific gotcha to handle here:**

- omp auto-injects environment + git context (OS, cwd, branch, recent commits)
  into the system prompt by default. That content is **per-session volatile** —
  if it lands in the prefix it busts the cache every turn. Configure the system
  prompt (via `--system-prompt` / `SYSTEM.md` + `--append-system-prompt`) so all
  auto-injected volatile context is appended in the **tail**, after the cache
  breakpoint. Verify by hashing the prefix across two runs in different repos /
  branches — hashes must match.

**Tests:**

- Prefix hash identical across: different task, different cwd, different git
  branch, different retrieved content.
- Prefix hash *changes* only when you deliberately bump a prefix-policy version.
- Untrusted content never appears before the breakpoint.

**Acceptance:** `make demo-02` prints the assembled prompt for two different
tasks and asserts the prefix bytes (and hash) are identical.

-----

## Phase 2 — Security ingestion and review (your real first feature work)

### P2.1 — Unicode scanner + adversarial fixtures (1 session)  ★ fixtures added

- Port/expand the PRD `inspect_text` baseline into `harness/security/scanner`:
  zero-width, Unicode Tag block (U+E0000–E007F), bidi controls, private-use-area,
  mixed-script / homoglyph anomalies.
- Pure function: text → findings (type, codepoint, index, severity).
- **Adversarial fixture set** (`harness/security/fixtures/`): build real poisoned
  strings to assert detection. Good sources of *patterns* (NOT to ingest live):
  - Tag-block smuggling (instructions hidden in U+E00xx tag chars).
  - Zero-width joiner/non-joiner injection between visible tokens.
  - Bidi-override “RLO” tricks that make displayed text differ from logical text.
  - Homoglyph tool-name spoofing (Cyrillic ‘е’ in `edit_file`).
  - **Note:** repos like CL4R1T4S deliberately embed these payloads. Treat them
    as *fixture inspiration only*; copy hand-built minimal examples into the
    fixture file rather than ingesting the repo — ingesting it is precisely the
    attack this scanner exists to stop. Each fixture is a tiny string + the
    expected finding(s).
- **Over-test this.** It’s one of the two correctness keystones.

**Acceptance:** `make demo-P2.1` scans every fixture; each expected finding fires;
zero false positives on a clean control corpus.

### P2.2 + P2.3 — DuckDB bootstrap + sanitation + trust labeling (1 session)

- `harness/memory/db`: create `agent_obs.duckdb`, apply PRD security-table DDL
  (`content_artifacts`, `content_scans`, `security_findings`,
  `sanitized_artifacts`, `approval_events`, `export_events`, `security_alerts`).
  Versioned migrations; DDL frozen on first write.
- Sanitation: NFKC normalize, strip/escape per policy, produce sanitized
  derivative, preserve raw original, assign trust label from verdict, write rows.

**Acceptance:** `make demo-P2.3` ingests a poisoned artifact → DB rows for
artifact, scan, findings, sanitized derivative.

### P2.4 — Quarantine gate as omp hook + approval workflow (1 session)

- Implement the gate as a **`pre` hook on `tool_call`** (and on content ingestion
  points): if findings exceed policy threshold → `return { block: true, reason }`.
  This proves quarantined content cannot reach tool execution — enforced by omp’s
  own hook mechanism, tested.
- Notification payload (source, trust label, severity, finding type, what
  changed, what’s blocked, raw-vs-sanitized diff handle).
- `approval_events`: approve / deny / quarantine-release with user, time,
  rationale, scope.

**Acceptance (PRD Phase 2):** suspicious Unicode detected & classified; user sees
finding type + severity before privileged execution; blocked content provably
cannot reach a tool call. `make demo-P2.4` runs a poisoned import end to end and
shows the block.

-----

## Phase 3 — Verification and telemetry

### P3.1 — Verification engine with security precondition (1 session)

- Verification as task completion: test/lint/typecheck runners (omp already has
  these as tools — wrap them). **Security scan is a prerequisite** for
  prompt/execution-bearing artifacts; fail-closed when review required.

### P3.2 — JSONL→DuckDB ingestion + stable-ID guarantee (1 session)

- `post` hook ingests omp’s session JSONL into episodic/telemetry tables.
- Guarantee every run/finding/approval has a stable ID (omp Snowflake IDs +
  your own for findings/approvals). Security events queryable & replayable;
  export events audited.

**Acceptance (PRD Phase 3):** stable IDs; security events replayable/queryable;
export audited. `make demo-P3.2` runs a task, ingests, runs a sample SQL query.

-----

## Phase 4 — Memory and compaction

(omp has compaction already — you’re adding the **security-aware** layer.)

### P4.1 — Memory layers + state artifacts (1 session)

Working/episodic/semantic/archive tables + `NOW.md` / `PROGRESS.md` /
`DECISIONS.md` / `FAILURES.md`; security metadata on every promoted artifact.

### P4.2 — Security-aware compaction (1 session)

Hook omp’s compaction so summaries are generated from **sanitized derivatives**;
raw spans kept in archive; provenance links to source spans + scan findings
preserved.

### P4.3 — Semantic promotion gate / poisoned-memory prevention (1 session) ★ keystone

Suspicious-source promotions blocked until reviewed. Resume-from-durable-state
works. **Second correctness keystone — over-test.**

**Acceptance (PRD Phase 4):** suspicious artifacts can’t auto-promote; compaction
preserves provenance; run resumes safely. `make demo-P4.3` attempts a poisoned
promotion and proves it’s blocked.

-----

## Phase 5 — Recursive execution and sandboxing

### P5.1 — Parent/child runs + subagent dispatch (1 session)

Use omp’s subagent/task system; ensure each child run carries its own trace,
sandbox, and scan lineage; store lineage.

### P5.2 — Sandbox profiles + security-review subagent (1 session)

Map your profiles (`trusted-local | container-local | remote-runner | read-only-audit | quarantine`) onto omp isolation backends. Suspicious tasks
auto-downgrade. security-review subagent is read-only/quarantine.

**Acceptance (PRD Phase 5):** lineage stored; security-review subagent read-only;
replay renders injection/approval lineage.

-----

## Phase 6 — Remote runners and safe export

### P6.1 — Remote runner gate (1 session)

omp already supports comment/CI-triggered runs; add the **pre-dispatch scan**:
payload scanned before a run is created; suspicious → blocked or routed to
security-review; findings + approval lineage on the run record.

### P6.2 — Safe export + incident bundles (1 session)

Custom tools: escaped Markdown report, sanitized-only CSV, JSON evidence bundle
(raw stored separately + flagged), export metadata + payload hash. Raw dangerous
content never rendered by default.

**Acceptance (PRD Phase 6):** comment-triggered runs scan before dispatch; safe
exports never render raw by default; export audit complete.

-----

## Phase 7 — Visualization and benchmarking

### P7.1 — Observable dashboards from DuckDB exports (1 session)

Operational pages + the six security dashboard views.

### P7.2 — Replay + benchmark + prompt-version comparison (1 session)

Replay renders run tree + suspicious-content flow; benchmark suite; compare
outcomes by model/source/mode and across prompt-prefix versions. **Tie this back
to Increment 2:** benchmark cache-hit rate / token consumption per prompt-prefix
version so you can prove the cache optimization is working over time.

**Acceptance (PRD Phase 7):** finding-type trends inspectable; incidents
comparable by model/source/mode; prompt/compaction changes evaluable against
both security outcomes and cache/token metrics.

-----

## Session checklist (paste into each Claude Code session)

```
START
- [ ] Read CLAUDE.md (invariants + frozen contracts + "extend, don't fork")
- [ ] make test && make demo-<previous>      # baseline green
- [ ] State the single increment ID for this session

DURING
- [ ] Prefer hook/custom-tool over forking omp; log any exception in DECISIONS.md
- [ ] Don't edit frozen contracts (ToolResult adapter, enums, schema migrations,
      frozen prompt prefix) unless THIS increment is explicitly a contract change
- [ ] Volatile context (env/git/date) stays in the prompt TAIL, never the prefix
- [ ] Untrusted text only inside UNTRUSTED_CONTENT_START/END, after the breakpoint

END
- [ ] New make demo-<this> passes; full make test green
- [ ] If prefix touched: re-run the prefix-hash test
- [ ] Append 3 lines to PROGRESS.md: shipped / stubbed / next
```

-----

## Key judgment calls

- **Extend omp via SDK + hooks + tools; never fork** unless provably necessary.
  omp’s release velocity makes forks expensive; the extension surface covers the
  PRD.
- **The cache win is ordering discipline, not headers.** Freeze layers 1–4
  bytewise, mark the breakpoint, keep tool schemas stable, push omp’s
  auto-injected env/git context into the tail. Verify with a prefix-hash test.
- **Scanner (P2.1) and promotion gate (P4.3) are the correctness keystones** —
  over-test both.
- **DuckDB DDL freezes on first write**; all change via numbered migrations.
- **Poisoned-prompt repos are fixture inspiration, not ingestion targets.**
  Hand-copy minimal adversarial strings into the fixture file; never point the
  harness at such a repo as live input — that’s the exact attack the scanner
  defends against.