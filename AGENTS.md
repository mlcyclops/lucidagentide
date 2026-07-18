# AGENTS.md — Invariants

> Read this file at the start of EVERY session before touching code.
> These are the load-bearing rules. Breaking one silently is how this project
> rots across sessions. If you must break one, it’s a deliberate, isolated
> increment with its own ADR in DECISIONS.md — never a side effect.

-----

## Session ritual

**START**

1. Read this file.
1. `make test && make demo-<previous-increment>` — the baseline must be green
   before you change anything.
1. State out loud the single increment ID you are building this session. One
   increment per session.

**END**

1. New `make demo-<this-increment>` passes.
1. Full `make test` green (every prior demo still passes).
1. If you touched the prompt prefix, re-run the prefix-hash test.
1. Append exactly 3 lines to PROGRESS.md: shipped / stubbed / next.

Do not start the next increment in the same session. A half-finished second
increment is the exact failure this whole structure exists to prevent.

-----

## The architecture in one paragraph

We are building a security/provenance/memory layer **around** oh-my-pi (omp),
not from scratch. The harness is **TypeScript on Bun, in-process with omp**. The
**only** Python is `scanner-sidecar/` (the pure Unicode scanner). We extend omp
through hooks, custom tools, and its SDK. See DECISIONS.md ADR-0001.

-----

## Writing style

- **Never use em dashes** (the long dash, Unicode U+2014). Use commas, periods,
  colons, or hyphens instead. This applies everywhere: code, comments, UI strings,
  commit messages, ADRs, and PROGRESS.md.

-----

## Invariants (do not violate)

### 1. Extend omp; never fork it.

Prefer a hook or custom tool over any change that would require forking omp.
omp ships hundreds of releases; a fork is permanent merge pain. If you believe
something genuinely cannot be done via hook/tool/SDK, STOP and write an ADR
before forking anything.

### 2. The language boundary is fixed.

The harness is TypeScript. The ONLY directory containing Python is
`scanner-sidecar/`. Never add a `.py` file anywhere else. Never reimplement the
scanner in TypeScript. If a second Python surface seems necessary, that’s a
drift signal — stop and write an ADR.

### 3. Fail-closed is law.

Any failure to obtain a valid scan result — sidecar dead, malformed response,
timeout, missing id — MUST be treated as “block / quarantine,” never “safe.”
No code path may treat “scan unavailable” as “pass.” There is a test that kills
the sidecar mid-run and asserts the gate blocks; it must stay green forever.

### 4. The quarantine gate runs in-process.

The security gate is a `pre` hook inside omp’s runtime. It must not depend on a
network call or a fragile boundary to do its blocking. The scanner (pure, behind
the sidecar) may be out-of-process; the GATE that acts on its output may not.

### 5. Untrusted content is always delimited and always late.

All user-provided, retrieved, imported, or externally stored text enters prompts
only inside `UNTRUSTED_CONTENT_START` / `UNTRUSTED_CONTENT_END`, only after
scanning + sanitation, and only AFTER the cache breakpoint (never in the frozen
prefix). The system prompt instructs the model to treat delimited content as
data, never instructions.

### 6. The prompt prefix is frozen and byte-stable.

Prompt layers 1–4 (identity/safety, tool-use/permission policy, stable coding
rules, security/trust-boundary rules) are byte-identical across all requests.
Volatile context — date, cwd, git branch/status, env — that omp auto-injects
MUST live in the tail, after the cache breakpoint. Putting volatile bytes in the
prefix busts the KV cache every turn. Verify with the prefix-hash test.

### 7. Trust labels are a closed set.

Exactly: `trusted | untrusted | suspicious | quarantined`. No other values.

### 8. Events use exact names.

Every logged event uses a name from the `EventName` enum in `contracts.ts`.
Emitting an unknown event name must raise. Every event carries `run_id`,
`session_id`, and `artifact_id` when an artifact is in scope.

### 9. Stable IDs everywhere.

Every run, finding, and approval has a stable string `*_id`. Reuse omp’s
Snowflake session/run IDs; mint your own for findings/approvals. IDs are never
regenerated for the same logical entity.

### 10. DuckDB schema freezes on first write.

Schema changes only ever happen through numbered migration files. Never edit a
table definition in place. The schema is a frozen contract.

-----

## Frozen contract files (changing any one is its own increment + ADR)

- `harness/contracts.ts` — TrustLabel, AgentMode, EventName, ExecutionProfile,
  ToolResult (PRD shape, translated to TS).
- `harness/tools/result_adapter.ts` — the ONLY place omp’s
  `{ content: [{type,text}] }` and the PRD `ToolResult` meet.
- The scanner IPC contract (DECISIONS.md ADR-0002).
- DuckDB schema migration files.
- The frozen prompt prefix (layers 1–4).

If you import one of these, import it — never redefine its types locally.

-----

## Two correctness keystones (over-test these)

- **The Unicode scanner** (`scanner-sidecar/`, increment P2.1). Every finding
  type has fixtures; clean control corpus must produce zero false positives.
- **The semantic-promotion gate** (increment P4.3). Suspicious-source content
  must never auto-promote into semantic memory.

Everything security-related leans on these two. Treat a failing test in either
as a stop-the-line event.

-----

## Known wrinkles carried forward

- The PRD wrote `contracts` and `ToolResult` as Python dataclasses. Under
  Option A they are TypeScript in `contracts.ts`. The Python sidecar only needs
  the finding shape. Translate other PRD Python samples to TS as needed; note
  non-obvious translations in an ADR.
- The integration seams were written from omp’s README. The FIRST task of
  Increment 0 is to confirm the real `createAgentSession`, hook API, and
  custom-tool factory shapes against the installed omp version, and ADR any
  deltas.
- DuckDB uses the Node binding (less mature than DuckDB-Python). If a specific
  analytics task is blocked by it, that’s a localized future ADR — not a reason
  to revisit the harness language.

-----

## Licensing & commit hygiene

Every first-party source file under `harness/`, `desktop/`, `tools/`, and
`scanner-sidecar/` carries the BUSL-1.1 SPDX header (`Copyright (c) 2026 TechLead
187 LLC` + `SPDX-License-Identifier: BUSL-1.1`; `#` for Python). This is enforced
two ways and you must keep both working:

- A **pre-commit hook** (`.githooks/pre-commit`) auto-applies the header to staged
  source. Run **`make install-hooks` once per clone** to activate it — git cannot
  self-install hooks on clone, so a fresh checkout (yours or a collaborator’s) has
  NO hook until this runs. `make install` runs it for you.
- **CI** runs `tools/license_headers.ts --check` as a backstop, so nothing
  unheadered can land on master even if the hook was never installed.

Vendored / generated trees (`vendor/`, `node_modules/`, `desktop/release/`,
`.venv`, `__pycache__`, `dist/`) keep their own licenses and are NEVER
relicensed. New first-party files get the header automatically (hook) or via
`make license-headers`. When adding the header in code, read the file then write —
never `existsSync`-then-read (CodeQL flags that pair as a TOCTOU race).