# DECISIONS.md

Architecture decision records for the omp-based agentic IDE harness.
One entry per decision. Never edit a past entry — supersede it with a new one.

-----

## ADR-0001 — Harness language: TypeScript, with an isolated Python scanner sidecar

**Date:** 2026-06-17
**Status:** Accepted
**Context increment:** Increment 0

### Decision

The harness is written in **TypeScript on Bun**, in-process with omp. Exactly
**one** component is allowed to be Python: the **Unicode scanner**, which runs as
a stateless sidecar subprocess behind a narrow JSON contract. DuckDB is accessed
via its **Node binding** from the TypeScript side.

### Why (the short version)

The integration surface (hooks, custom tools, SDK) wants TS — it’s in-process,
pays no serialization tax, and breaks loudly (compile errors) when omp updates.
The two correctness keystones (Unicode scanning, DuckDB analytics) want Python.
Option A resolves the tension by keeping everything security-*critical* in-process
and exporting only the scanner’s pure detection logic to Python.

### The load-bearing reason

The quarantine gate is **fail-closed**. It must run in-process with omp as a
`pre` hook so that a crash or boundary failure cannot let content through. The
scanner the gate *consumes* is pure (text in → findings out, no state, no I/O),
which makes it the single safest thing in the system to put across a process
boundary: if the sidecar dies, the gate (still in TS) treats “no scan result” as
“unscanned” → block. The boundary can only fail *closed*, never open.

### Consequences

- We own a small, well-tested IPC contract for the scanner (see ADR-0002 stub
  below / the contract file). Nothing else crosses a language boundary.
- DuckDB tooling is the Node binding, which is less mature than DuckDB-Python.
  Accepted cost. If a specific analytical/dashboard task proves painful in P3/P4/P7,
  that is a *future* localized ADR, not a reason to revisit the whole harness.
- The homoglyph/confusables and script-mixing detection lives in Python (its
  strongest ecosystem), inside the sidecar.
- One primary toolchain (Bun) for the harness + omp; Python exists only as a
  pinned sidecar runtime. The per-session baseline stays simple.

### What would have changed this decision

- If the team were meaningfully more fluent in Python, we’d have chosen Option B
  (Python harness, omp over RPC), because writing a fail-closed gate in the
  weaker language is a worse risk than an IPC boundary.
- If the memory/analytics/dashboard half were the *primary* product (not the
  agent/security integration), Option B’s DuckDB-Python advantage would dominate.

Neither held, so: Option A.

### Revisit triggers (when to write a superseding ADR)

- The scanner sidecar boundary shows any fail-*open* behavior in testing.
- DuckDB Node binding blocks a required analytical feature with no workaround.
- IPC latency on scan calls becomes a measured bottleneck (unlikely — scanning is
  per-artifact, not per-token).

-----

## ADR-0002 — Scanner sidecar IPC contract (stub — finalize in P2.1)

**Date:** 2026-06-17
**Status:** Accepted — finalized in P2.1. The scanner shipped (`scanner-sidecar/scanner.py`,
`server.py`) and is keystone-tested (CLAUDE.md keystone #1); the IPC contract below is the
implemented, frozen boundary.

The TS↔Python scanner boundary is a frozen contract. Proposed shape:

- **Transport:** one Python process per harness session, spoken to over
  stdin/stdout as newline-delimited JSON (NDJSON). One request → one response.
  (A subprocess-per-call model is simpler but pays Python startup cost per scan;
  a long-lived process avoids that. Decide for real in P2.1 with a benchmark.)
- **Request:** `{ "id": str, "text": str, "policy": {...} }`
- **Response:** `{ "id": str, "findings": [ {type, codepoint, index, severity} ], "scanner_version": str }`
- **Failure semantics (the important part):** any of — process dead, malformed
  response, timeout, missing `id` — is treated by the TS gate as
  **“no valid scan result”**, which the gate maps to **block / quarantine**, never
  pass. This is asserted by a test that kills the sidecar mid-run.
- **Version:** `scanner_version` is logged with every `content_scanned` event so
  findings are reproducible/forensic.

-----

# Increment 0 — concrete consequences of Option A

The plan’s Increment 0 (“Harness bring-up + invariants”) now has these specific
deliverables, given the decision above.

## Repo layout

```text
agent-workspace/
├── CLAUDE.md                      # invariants (see below)
├── DECISIONS.md                   # this file
├── PROGRESS.md                    # 3-line-per-session log
├── Makefile
├── package.json                  # Bun; harness deps incl. duckdb node binding
├── tsconfig.json
├── harness/                       # ALL TypeScript
│   ├── contracts.ts              # TrustLabel, AgentMode, EventName, ExecutionProfile, ToolResult (PRD shape)
│   ├── prompt/
│   │   └── assembler.ts          # 9-layer assembly, frozen prefix (Increment 2)
│   ├── security/
│   │   ├── gate.ts               # the fail-closed pre-hook (P2.4)
│   │   └── scanner_client.ts     # TS side of the sidecar IPC contract
│   ├── memory/
│   │   └── db.ts                 # DuckDB via node binding (P2.3)
│   ├── telemetry/
│   │   └── events.ts             # emit() -> JSONL
│   ├── tools/
│   │   └── result_adapter.ts     # omp {content:[...]} <-> PRD ToolResult  [FROZEN]
│   └── hooks/
│       └── index.ts              # registers pre/post hooks with omp
├── scanner-sidecar/               # the ONLY Python
│   ├── pyproject.toml            # uv-managed, pinned
│   ├── scanner.py                # unicodedata + confusables/script-mixing
│   ├── server.py                 # NDJSON stdin/stdout loop
│   └── fixtures/                 # adversarial strings (P2.1)
├── repos/project-alpha/           # sample workspace (.agent/, AGENTS.md, CLAUDE.md ...)
└── observable/                    # dashboards (Phase 7)
```

Rule encoded by this layout: **`scanner-sidecar/` is the only directory
containing Python.** If a second Python file ever appears outside it, that’s a
drift signal — stop and write an ADR.

## Toolchain / runtime setup

- **Harness:** Bun (matches omp). `package.json` pins omp SDK
  (`@oh-my-pi/pi-coding-agent`) and the DuckDB Node binding.
- **Sidecar:** `uv`-managed venv inside `scanner-sidecar/`, Python pinned. No
  network deps at runtime.
- **First task of Increment 0 (do this before anything else):** confirm the
  *actual* current shapes of omp’s `createAgentSession`, the hook API
  (`HookAPI`, the `on("tool_call", ...)` signature), and the custom-tool factory
  type against the installed omp version. The plan was written from the README;
  a repo at 300+ releases may differ. Record any deltas as an ADR.

## CLAUDE.md invariants (Option A additions)

The invariants file must include, on top of the generic anti-drift rules:

- **Language boundary:** harness is TypeScript; the *only* Python is
  `scanner-sidecar/`. Never add Python elsewhere; never reimplement the scanner
  in TS.
- **Fail-closed law:** any failure to obtain a valid scan result = block /
  quarantine. No code path may treat “scan unavailable” as “safe.”
- **Frozen contracts:** `contracts.ts`, `tools/result_adapter.ts`, the scanner
  IPC contract (ADR-0002), the DuckDB schema migrations, and the frozen prompt
  prefix. Editing any of these is its own deliberate increment.
- **omp posture:** extend via hooks/tools/SDK; never fork. Log exceptions here.
- **Prompt prefix:** volatile context (env/git/date that omp auto-injects) stays
  in the tail, never the cached prefix.

## Makefile targets for Increment 0

- `make test` — runs Bun tests (empty green to start) AND a sidecar smoke test
  (`echo a request, get a well-formed response`).
- `make demo-00` — three things:
1. headless omp round-trip through the **echo provider** (no network/keys),
1. start the scanner sidecar, send one clean string + one zero-width-injected
   string, print findings,
1. **kill the sidecar mid-call and assert the TS side blocks** (the fail-closed
   property, proven on day one).

## Acceptance for Increment 0 (revised)

- Headless omp call returns through the echo provider.
- Scanner sidecar answers a clean request and flags a poisoned one.
- Killing the sidecar causes the TS gate to block, not pass. ← the keystone
  safety property, tested before any feature code exists.
- `make test` green; `PROGRESS.md` has its first entry.

-----

## Open question carried into Increment 0

The harness/omp-hook code is TypeScript, but the PRD wrote `contracts` and
`ToolResult` as Python dataclasses. Under Option A those become **TypeScript**
types in `contracts.ts` (the Python sidecar only needs the finding shape, not the
full contract set). Confirm no other PRD code sample was assumed to be importable
Python by the harness — translate each to TS as it’s needed, and note any
non-obvious translation in an ADR.

-----

## ADR-0003 — omp 16.0.6 real API shapes confirmed (resolves the Increment 0 "first task")

**Date:** 2026-06-18
**Status:** Accepted
**Context increment:** Increment 0

### Decision

Confirmed the *actual* `@oh-my-pi/pi-coding-agent@16.0.6` API against the
installed package + vendored source (`vendor/oh-my-pi/`, HEAD `faa96a81`). The
integration seams in BUILD PLAN / CLAUDE.md were written from the README; this
ADR freezes what is really there. Most assumptions held; the deltas below are
load-bearing.

### Confirmed (matches our design)

- **Session entry:** `createAgentSession(options?) => Promise<{ session, eventBus, ... }>`
  (`dist/types/sdk.d.ts`). Drive a headless turn with `await session.prompt(text)`
  (returns `Promise<boolean>`); subscribe via `session.subscribe(event => ...)`.
- **Pre-tool hook + blocking (our fail-closed gate seam):** a `HookFactory =
  (pi: HookAPI) => void` registers `pi.on("tool_call", handler)`; the handler may
  return `{ block: true, reason }` (`ToolCallEventResult`) to stop execution.
  Post-tool hook is `pi.on("tool_result", handler)`. Event names are exactly
  `"tool_call"` / `"tool_result"`.
- **Custom tools:** `CustomTool` with `execute(...) => Promise<AgentToolResult>`,
  registered via `customTools` / `CustomToolFactory`.
- **System prompt seam:** `createAgentSession({ systemPrompt })` accepts a string,
  string[], or `(defaultBlocks: string[]) => string | string[]`.

### Deltas from the README-based plan (the important part)

1. **No `--no-session` in the SDK.** Stateless headless runs use an in-memory
   session (`SessionManager.inMemory()`), not a flag. Tests use that.
2. **No built-in echo/fake provider, and it is NOT a `models.yml` stub.** The
   real mechanism is programmatic: `pi.registerProvider("echo", { ...,
   streamSimple })` via an **extension**, where `streamSimple` returns an
   `AssistantMessageEventStream`. → BUILD PLAN Increment 0 said "register a fake
   provider in models.yml pointing at a local stub"; that is superseded — the
   echo provider is an in-code extension. (`extensibility/extensions/types.d.ts`.)
3. **Tool result shape is richer than `{ content: [{type,text}] }`.** Real type
   is `AgentToolResult = { content: (TextContent | ImageContent)[]; details?;
   isError?; useless? }` (`@oh-my-pi/pi-agent-core`). The frozen
   `result_adapter.ts` maps PRD `ToolResult` ↔ this exact shape, including
   `isError` and image content.
4. **Skills are NOT bundled in the npm package.** They are discovered at runtime
   from `.omp/skills/`, `~/.omp/agent/skills/`, and plugin dirs via
   `discoverSkills()`. The repo itself ships only two genuine vendor skills
   (`.omp/skills/{semantic-compression,system-prompts}`); everything else under
   `test/fixtures/skills/` is deliberately malformed test data. Those two were
   copied into `.agents/skills/` (see `.agents/skills/SOURCES.md`).
5. **Volatile context injection (relevant to Increment 2):** omp auto-injects
   env/git/date inside `buildSystemPrompt()`, and the SDK does **not** expose a
   clean seam to split a byte-stable prefix from that volatile tail. Achieving
   the frozen-prefix KV-cache discipline (invariant #6) will likely require
   replacing `systemPrompt` wholesale and appending volatile context ourselves.
   Flagged here; resolved for real in Increment 2 with its own ADR.

### Consequences

- The echo provider (Increment 0 deliverable) is implemented as a harness
  extension under `harness/` exposing `streamSimple`, not a YAML stub.
- `result_adapter.ts` targets `AgentToolResult` (with `isError`/image content),
  not the simplified README shape.
- ADR-0002's scanner IPC contract is unaffected (it never touched omp types).

-----

## ADR-0004 — Frozen-prefix integration: explicit `systemPrompt` array replaces omp's default

**Date:** 2026-06-18
**Status:** Accepted
**Context increment:** Increment 2
**Supersedes the open question in:** ADR-0003 #5

### Decision

The harness owns the entire system prompt. We assemble it ourselves
(`harness/prompt/assembler.ts`) as a two-block array `[FROZEN_PREFIX, tail]` and
pass it to `createAgentSession({ systemPrompt: blocks })`. omp uses that array
**verbatim** and does **not** prepend or interleave its own auto-injected
env/git/date context. Our frozen prefix (layers 1–4) is therefore byte-stable;
all volatile context (layers 5–9, incl. session state) lives in the tail, after
the cache breakpoint.

### Why this resolves ADR-0003 #5

ADR-0003 flagged that omp injects volatile context inside `buildSystemPrompt()`
with no clean split seam, and predicted we'd have to "replace systemPrompt
wholesale." Increment 2 confirms that is exactly the right move and that it
works cleanly: passing an explicit `systemPrompt` **string[]** overrides omp's
default system prompt entirely. We do not need to relocate omp's blocks — we
simply don't use them, and gather whatever volatile context we want into our own
tail layer 8.

### Evidence (demo-02 / `demo02_prefix_hash.ts`)

Driving a real headless omp session (echo model) with `systemPrompt: [prefix,
tail]`, the model received exactly **2** system blocks; `systemPrompt[0]` was our
`FROZEN_PREFIX` byte-for-byte (index 0), and the volatile task text appeared only
later, in the tail. Prefix sha256 was identical across two requests that differed
in task, cwd, git branch, and retrieved content.

### Consequences / scope

- `harness/prompt/assembler.ts` (the `FROZEN_PREFIX` constants, layers 1–4) is a
  **frozen contract**: changing any byte bumps `PREFIX_VERSION` + needs an ADR.
- Because we replace omp's default prompt, any omp-default guidance we still want
  (e.g. its tool-usage preamble) must be re-supplied by us deliberately — it is
  not inherited. Acceptable: the prefix is meant to be authored, not borrowed.
- Verified in an isolated headless session with no skills/context files. If a
  future increment re-enables omp's skill/context discovery, re-confirm that
  discovery output lands in the tail region, not ahead of the prefix.
- Provider-specific cache markers (e.g. Anthropic `cache_control`) are handled by
  omp/provider plumbing; our contribution is the byte-stable ordering, which is
  what every provider's longest-stable-prefix detection keys on.
-----

## ADR-0005 — DuckDB schema: numbered migrations, frozen on first write; soft run_id

**Date:** 2026-06-18
**Status:** Accepted
**Context increment:** P2.2 / P2.3

### Decision

The DuckDB schema (invariant #10) is managed by numbered SQL migrations under
`harness/memory/migrations/NNNN_name.sql`, applied in order and tracked in a
`schema_migrations(version, name, applied_at)` table that `db.ts` bootstraps.
Migration `0001_security_tables.sql` creates the seven PRD security tables. An
applied migration file is FROZEN — never edited in place; schema changes are new
numbered files only.

### Load-bearing choices

- **`run_id` is a soft reference, not a FK.** The identity tables
  (`projects`/`sessions`/`runs`) land later (P3.2). The PRD DDL FK'd
  `content_artifacts.run_id -> runs(run_id)`, but creating `runs` now would
  prematurely commit the identity schema, and DuckDB cannot cleanly add a FK to
  an existing table afterward. So `run_id` is a plain `VARCHAR` column;
  referential integrity is enforced only WITHIN the security family
  (scans→artifacts, findings→scans, sanitized→artifacts), where P2.3 ingestion
  needs it. Event run_ids being soft references is normal telemetry practice.
- **Raw original is stored verbatim** (`content_artifacts.raw_content` +
  `raw_sha256`) for forensics; the sanitized derivative lives in
  `sanitized_artifacts`. Raw and safe copies never share a column.
- **Statement splitting:** migrations are split on `;` (our DDL has no semicolons
  inside literals/comments). If a future migration needs them, switch to a real
  parser in that migration's era, documented then.

### Binding

`@duckdb/node-api@1.5.4-r.1` (the `-r.N` suffix is DuckDB's normal release
convention, not a prerelease signal). API used: `DuckDBInstance.create(path)` →
`connect()` → `run(sql, params)` (positional `$1` array or named `$id` object) →
`runAndReadAll(sql).getRowObjects()`; `closeSync()` on conn + instance. This is
the localized DuckDB-Node risk ADR-0001 flagged; no blocker hit so far.

-----

## ADR-0006 — GUI/desktop front end: read-only web surface + omp ACP, gate stays in-process

**Status:** accepted (spike proven). **Date:** 2026-06-18.

### Context

We want a graphical (eventually Electron/desktop) front end for LucidAgentIDE +
omp, instead of only the terminal TUIs. The risk is that a GUI becomes a *second*
place that touches the security path and quietly weakens an invariant (esp. #4
"the quarantine gate runs in-process" and fail-closed law #3).

### Decision

The GUI is a **front end only**. Two independent surfaces, neither of which moves
the security boundary:

1. **Agent loop → omp ACP.** omp ships `omp acp` (Agent Client Protocol, JSON-RPC
   over stdio). `tools/acp_probe.ts` confirms the `initialize` handshake against
   the installed omp 16.0.8: protocol v1, `loadSession`, session list/fork/resume/
   close, prompt embeddedContext/image, MCP http/sse, and **auth via existing
   `~/.omp` credentials** (no re-login). A desktop shell (custom, or existing ACP
   clients like acp-ui / Zed / JetBrains) drives omp over this channel. The gate
   still loads as the in-process omp hook (`-e harness/omp/security_extension.ts`),
   so invariant #4 and fail-closed (#3) are untouched — the GUI never decides
   "safe."

2. **Dashboards → local web server.** `tools/web/server.ts` (Bun.serve) serves a
   live, auto-refreshing page (`tools/web/index.html`) backed by JSON endpoints
   `/api/security` and `/api/memory`. The data layer is shared with the TUIs:
   security reuses the exact `harness/dashboards/views.ts` SQL via a **READ_ONLY**
   DuckDB adapter; memory reuses `tools/memory_data.ts`. Read-only by construction
   means the page can never contend with the live gate's writer and can never see
   `raw_content` (the views only ever select metadata — consistent with P7.1).

### Consequences

- An Electron app is now a thin shell: embed the web page, add an ACP chat panel.
  No security logic migrates into the GUI; this ADR is the guardrail if it ever
  tries to.
- New shared data module `tools/memory_data.ts` (extracted from `memory_tui.ts`)
  is the single source of truth for the memory/context view across TUI + web.
- `tools/web/` and `tools/acp_probe.ts` are front-end/proof code, not on the
  security path; they hold no frozen contracts.

### Addendum (Electron realization — single HTTP backend)

The desktop shell in `desktop/` implements decision #1+#2 above, but with the ACP
session living in the **Bun dev server**, not in Electron — one real backend for
both the browser build and the packaged app:

- `desktop/acp_backend.ts` is a singleton that spawns
  `omp acp -e harness/omp/security_extension.ts` (gate in-process) and exposes
  chat/config/commands. `desktop/dev.ts` serves it over HTTP: `/api/chat`
  (streaming NDJSON), `/api/config`, `/api/setConfig`, `/api/commands`, plus the
  read-only `/api/security|memory` dashboards.
- `desktop/renderer/bridge.ts` talks only HTTP, so prompts produce genuine model
  replies in a plain browser — no simulation. `desktop/main.ts` is a thin Electron
  shell (spawn dev server → frameless window → window-control IPC); `preload.ts`
  exposes only native zoom (`webFrame`) + window controls.

The exact ACP wire format was captured from a **live omp 16.0.8 turn** (no longer
spec-inferred): `session/new`→`configOptions`, `agent_message_chunk`,
`usage_update`, `available_commands_update`, `config_option_update`, and the setter
`session/set_config_option {sessionId,configId,value}`. Verified end-to-end: a real
`/api/chat` prompt returned a correct model reply with live usage. Still
unexercised: `tool_call`/`tool_call_update` shapes (the verifying turns used no
tools); the gate's stderr `[BLOCKED …]` line is the reliable block signal regardless.

-----

## ADR-0007 — AskSage gov gateway as an omp provider extension (no fork)

### Context

The earlier prototype (`AgentIDEHarness`) talked directly to the **AskSage**
accredited gov AI gateway (`https://api.civ.asksage.ai/server`) — a proxy fronting
OpenAI / Anthropic / Google behind a non-standard `x-access-tokens` header. We want
that capability inside LucidAgentIDE so the in-process scanner gate sits in front of
AskSage-routed traffic too. Constraint: extend omp, never fork (CLAUDE.md #1).

### Decision

AskSage is an **omp provider extension** loaded via a second `-e` flag alongside the
security gate (`omp acp -e <gate> -e <asksage>`; omp's `-e` is repeatable, verified).
`harness/omp/asksage_extension.ts` calls omp's first-class
`pi.registerProvider(name, { baseUrl, api, apiKey, headers })` — NOT a fork, NOT the
`registerCustomApi` path the initial planning pass guessed. Two providers map
AskSage's per-route paths to native omp APIs:

- `asksage-openai` → `api:"openai-completions"`, `baseUrl:.../server/openai/v1`
  (omp appends `/chat/completions`); GPT / o-series models.
- `asksage-anthropic` → `api:"anthropic-messages"`, `baseUrl:.../server/anthropic`
  (omp appends `/v1/messages`); Claude models.

Both inject `headers:{ "x-access-tokens": key }`; omp adds the provider-native auth
header (`Authorization: Bearer` / `x-api-key`) from `apiKey`. Models registered here
surface automatically over ACP, so the desktop picker needs no hardcoded list.
Google/Gemini deferred (more bespoke route).

### Load-bearing choices

- **Key handling.** `ASKSAGE_API_KEY` rides the existing key store
  (`~/.omp/lucid-gui.json`, mode 0600, git-ignored) + `applyEnv`; never committed,
  only masked status (last-4) leaves the server. Base URL + `asksageOnly` lockdown
  live in the same settings file.
- **Personas are untrusted.** AskSage personas are server-supplied text; injecting
  one as guidance is an untrusted-content path. Every persona passes the SAME Unicode
  scanner as tool calls (`scanAndDecide`) before use — quarantined personas are
  blocked (fail-closed), clean ones are wrapped in `UNTRUSTED_CONTENT_*` delimiters
  and delivered inside a user turn, never the frozen prefix (invariants #3, #5, #6).
- **Lockdown.** An "AskSage-only" toggle filters the model picker to gov models and
  auto-switches off any direct model, so a gov deployment can guarantee that every
  turn routes through the accredited gateway.

### Consequences

- The security gate is unaffected — it still wraps every tool call, fail-closed, on
  AskSage turns. The 130-test harness suite stays green.
- Verified: 8 gov models appear over ACP; persona scanning blocks a hidden-Unicode
  persona (42 findings) while allowing a clean one; lockdown filters the picker.
- Not yet exercised live: a full AskSage model reply (needs gateway quota) and SSE
  streaming on the passthrough routes (fallback to a `compat`/non-streaming shim if
  AskSage lacks SSE) — flagged for first live use.

### Addendum (live smoke test + quota model)

Smoke-tested against a real CIV account:
- **OpenAI route works end-to-end** — `asksage-openai/gpt-5.2` returned a real reply
  with usage; the `x-access-tokens` header is accepted and omp **streams** fine. Model
  ids corrected to the live `/openai/v1/models` list (o-series are `gpt-o3`/`gpt-o4-mini`,
  not `o3`; added gpt-5.5/5.4/5.1/4.1).
- **Anthropic route disabled (for now).** A live `claude-sonnet-4` turn via
  `/anthropic/v1/messages` consumed tokens but returned **no text** — AskSage serves
  Claude (and Gemini) **non-streamed**, which omp's `anthropic-messages`/google providers
  don't parse as a stream. Re-enabling Claude + adding Gemini will use a custom
  `streamSimple` adapter that calls AskSage's non-streaming endpoints and yields the
  text as one delta (next increment).
- **Quota is a local allowance.** `/count-monthly-tokens` returns tokens **used**
  (e.g. `{"response":1103216}`) but **no ceiling** — admins raise it in the AskSage
  console with no API to read it back. So the limit is a local, user-adjustable value
  (default **200k**) with +50K / +250K / +1M / Reset increments in Settings and a
  tooltip pointing to AskSage → Settings → Usage & Billing. `used` is live from the API.

### Addendum (streamSimple adapter — Claude + Gemini)

AskSage serves Claude and Gemini **non-streamed**, so omp's built-in
`anthropic-messages` / google providers (which expect SSE) returned no text. Rather
than fork, `harness/omp/asksage_stream.ts` provides a custom `streamSimple` (the
documented `pi.registerProvider({ api, streamSimple })` path): it flattens omp's
Context, POSTs AskSage's native non-streaming endpoints (`/anthropic/v1/messages`
with `anthropic-version`; `/google/v1beta/models/<id>:generateContent`), and replays
the full reply through omp's `AssistantMessageEventStream` (start → text_start →
text_delta → text_end → done). It is the one place the extension imports an omp type
(the event-stream class), imported from the package subpath so it resolves as a
value. Verified live: `claude-sonnet-4` → "CLAUDE OK", `gemini-2.5-flash` →
"GEMINI OK", both with usage. Claude (opus-4, sonnet-4) and Gemini (2.5 pro/flash)
re-enabled; the security gate still wraps these turns fail-closed.

-----

## ADR-0008 — headroom token-compression proxy (opt-in, on-device)

### Context

AskSage users have a monthly token quota; cutting tokens directly stretches it.
`headroom` (github.com/chopratejas/headroom) is an on-device, OpenAI-compatible
proxy that compresses tool outputs / context before the LLM (claimed 60–95%
reduction). The user asked to prototype it as an opt-in proxy.

### Decision

Ship the **opt-in lifecycle + detection** now, NOT a blind request-routing wire-up.
`desktop/headroom.ts` detects the `headroom` CLI, starts/stops `headroom proxy
--port 8787`, and reports status; a Settings toggle drives it (`/api/headroom`).
It is OFF by default and a pure no-op until the user installs headroom AND enables
it — a default install is unaffected. When headroom isn't present, Settings shows
the install hint (`pip install "headroom-ai[proxy]"`).

### Deliberately deferred (joint next step, needs headroom installed)

Request-routing (point omp's OpenAI-compatible providers' baseUrl at the proxy) and
the **gov-deployment security review** are NOT wired blind, because they can't be
verified without the dependency and carry real risk:
- **On-device:** headroom is documented local-first; must be CONFIRMED no context
  leaves the machine before any gov use.
- **Gate ordering:** the scanner gate must still see content before headroom
  compresses (the gate is on tool calls; headroom is on the model request path —
  orthogonal, but the ordering must be verified).
- **AskSage upstream:** the proxy must forward AskSage's custom host AND the
  non-standard `x-access-tokens` header (headroom forwards `Authorization`; the
  custom header needs confirming). Claude/Gemini go through our streamSimple
  adapter (not OpenAI-format), so only the OpenAI route is a candidate initially.

### Consequences

- No impact on the default app or the security invariants (off by default, no
  Python added to the harness — headroom runs as the user's own external process).
- A clean install-and-enable path; the high-value routing lands once headroom is
  installed and the three checks above pass.

### Addendum (native /query RAG route + dataset grounding)

Per the AskSage API docs, the primary endpoint is `POST /server/query`, which natively
supports `dataset: [...]` (RAG grounding) and `persona: <id>`. The passthrough
openai/anthropic/google routes cannot use these. So a fourth provider, `asksage-query`,
exposes an "AskSage RAG (dataset-grounded)" model via the same streamSimple adapter
(route "query"): it flattens the conversation into `/query`'s single `message`, grounds
on the datasets the user selected (env `ASKSAGE_DATASETS`, set from Settings), uses the
configurable underlying model (`ASKSAGE_QUERY_MODEL`, default gpt-5.2), and returns the
cited answer. The gov-datasets list in Settings is now SELECTABLE (toggle chips) — the
chosen sets ground the RAG model. Verified live: a NIST_NVD_CVE-grounded turn returned a
cited Log4Shell answer. (Personas also have no systemPrompt field server-side; the proper
application is /query's persona id — wired as env ASKSAGE_PERSONA, selectable next.)

### Addendum (RAG persona-id picker)

The /query route's native `persona: <int>` is now user-selectable. The Settings
"Gov datasets & persona" section (gov-only mode) gained a persona picker — a dropdown of
the account's personas (`POST /get-personas`) — persisted as `asksagePersona` and exported
as `ASKSAGE_PERSONA`; the streamSimple "query" route already reads it and sends
`persona: <int>` on grounded `/query` turns. This is deliberately distinct from the
**composer** persona (ADR-0007): that one injects server-supplied persona *text* into the
prompt, so it is SCANNED and UNTRUSTED_CONTENT-delimited (invariant #5). The RAG persona is
just an *id* AskSage applies server-side — no untrusted text enters our prompt, so no scan
is required (and none would have content to act on). Two personas, two trust postures.

Also fixed a latent bug surfaced while wiring this: `listPersonas` posted to
`${base}/server/get-personas`, but `base` already ends in `/server` (so it hit
`.../server/server/get-personas` → 404 → null). Corrected to `${base}/get-personas`, matching
the sibling calls (`/get-datasets`, `/count-monthly-tokens`) and the docs; 39 personas now load.

### Addendum (expandable RAG citations + premium model tooltips)

**Expandable citations.** A live probe showed AskSage's `/query` returns its separate
`references` field EMPTY and instead appends a `References\n[1] …\n[2] …` section to the end
of `message`, with `[n]` markers inline in the body. So the streamSimple "query" route now
parses that trailing block (`splitReferences`) and re-emits it as a collapsed
`<details class="rag-refs">` followed by a Markdown list (blank lines around it so marked
renders the list inside the HTML block). The chat's existing marked+DOMPurify path renders it:
`<details>/<summary>` are in DOMPurify's html profile, and the afterSanitizeAttributes hook
hardens the autolinked source URLs (`target=_blank rel=noopener`). Verified live: a Log4Shell
turn produced "📎 3 references · grounded on 1 dataset", collapsed by default, expand-on-click,
three NVD/Apache links. Replies with no "References" header pass through unchanged (graceful).

**Premium model tooltips.** Both model pickers now show a hover card per row, from a curated
`MODEL_INFO` table keyed by the shortened model id, with TWO ratings: **Token Expense** (1–5
red stars — how token/cost-heavy, 5 = priciest) and **Intelligence Level** (1–5 green stars —
raw capability), plus a one-line description, a practical "best for", context size, and the
model id. The green Intelligence stars also render inline in each dropdown row (the id moved
into the card to keep the row's width budget). It's a single delegated card (survives the
search re-render), `pointer-events:none` so it never intercepts the picker, and editorial (a
"not a benchmark" footer makes that explicit) — there is no live benchmark feed, by design.
Same session also fixed the model-dropdown layout (names were clipping to "C…" + a horizontal
scrollbar): name gets priority and the redundant "· AskSage Gov" suffix became a compact Gov
pill. Separately, both slide-out panels (left sessions sidebar, right inspector) now START
collapsed on boot (`toggleSidebar(true)` + `setInspectorRail(true)`) for a calmer first view.

-----

## ADR-0009 — Memory continuity, knowledge-graph export, and developer observability (roadmap)

**Date:** 2026-06-19
**Status:** Accepted as a roadmap. **Phase C** superseded by ADR-0013 (vault export, built).
**Phase D BUILT** (scoped — Logs view; raw-reveal still deferred; per-turn transcripts now
surfaced via Phase B). **Phase A BUILT** (cross-session memory recall; delta below).
**Phase B BUILT** (this increment — prompt/response traceability, issue #12; delta below).
Each lands in its own increment.
**Context increment:** P8.0 (planning only — no functional code shipped this session).

### Context

The user asked for four related capabilities: (1) better memory **across and between
sessions**, (2) an **Obsidian knowledge-graph** export option, (3) **more prompt/response
traceability**, and (4) an **optional admin/dev logging view**. Two of these touch FROZEN
contracts — the `EventName` enum (invariant #8) and the DuckDB schema (invariant #10) — so
under the one-increment-per-session rule they cannot all land at once. This ADR records the
agreed design and a phased build order so each future session ships one clean phase.

A planning sweep confirmed the **auto-distiller already exists**: `rememberActivity()` in
`harness/omp/security_extension.ts` already runs `ingestArtifact → promoteFactGated` on every
allowed tool call (best-effort, never affecting the block decision). So the *persist* half of
cross-session memory is partly built; the gap is **recall**.

### Decisions locked (with the user)

1. **Memory facts come from auto-distillation**, and every candidate fact passes through the
   existing **fail-closed promotion gate** (`harness/memory/promotion_gate.ts`, keystone #2)
   before entering semantic memory. Effective trust is re-derived from the *source artifact*,
   never the caller's claim; suspicious/quarantined sources are blocked.
2. **The dev/admin logging view is gated by a Settings "Developer mode" toggle**, persisted
   exactly like `headroomEnabled` (`desktop/settings_store.ts`). Gating is enforced
   **server-side**, not just by hiding UI.
3. **Content is sanitized + escaped by default** everywhere (reuse `escapeMarkdown` from
   `harness/export/safe_export.ts`; raw referenced by `sha256`). An admin may **explicitly
   "reveal raw (dangerous)"** behind a loud, **audited** gate (writes an `export_events` row +
   emits a `raw_revealed` event; raw is returned transient-only, never persisted anew).

### Decision — the four phases

Reuse-first: every phase leans on existing utilities — `promoteFactGated`,
`wrapUntrusted`/`FROZEN_PREFIX` (`harness/prompt/assembler.ts`),
`escapeMarkdown`/`export_events` (`harness/export/safe_export.ts`), `Telemetry.emit`
(`harness/telemetry/events.ts`), `getRunTree` (`harness/runs/lineage.ts`), the
`setPersona`/`personaDelivered` injection seam (`desktop/acp_backend.ts`), and the
`headroomEnabled` toggle pattern.

**Phase A — `P8.1-memory-recall` (cross-session memory) — recommended FIRST.** Satisfies #1.
Persist distilled facts per session (already happening) and **recall** them into later
sessions as delimited, post-cache context. New `harness/memory/recall.ts`
`buildRecall(db,{sessionId?,limit})` (read-only; `escapeMarkdown` each statement; only
`trusted`/`untrusted` facts — never suspicious/quarantined); inject via a new
`backend.setRecall(wrapped)` mirroring `setPersona` (first user turn, AFTER the cache
breakpoint, never the frozen prefix). *Frozen-contract impacts (own ADR when built):*
migration `0008_memory_session.sql` — sidecar `fact_sessions(fact_id, session_id, run_id,
recalled_at)`, never ALTER frozen `semantic_facts`; new `EventName` `memory_recalled`.

#### Phase A delta — BUILT (cross-session memory recall)

Shipped as specced: `harness/memory/recall.ts` `buildRecall(db, {sessionId?, runId?, limit, telemetry?})`
reads only `trusted`/`untrusted` semantic facts (keystone #2 — suspicious/quarantined excluded in
SQL), `escapeMarkdown`s every entity + statement, and returns a delimited `<recalled-memory>` block
injected in the first user turn via the new `backend.setRecall(wrapped)` seam
(`desktop/acp_backend.ts`, mirrors `setPersona`/`personaDelivered`; never the frozen prefix).
Migration `0008_memory_session.sql` adds the additive sidecar `fact_sessions(fact_id, session_id,
run_id, recalled_at)` (never ALTERs `semantic_facts`); a recall with a `sessionId` logs one row per
fact and emits the new `memory_recalled` event (carries `run_id`/`session_id`/`count`). Coverage:
`harness/memory/recall.test.ts` (keystone exclusion, escaping, sidecar+event, limits) + demo
`harness/scripts/demo17_recall.ts`. Prefix-hash test unaffected (recall is post-cache, user turn).
(Merge note: the migration shipped as `0008_memory_session.sql` and the demo as `demo17_recall.ts` —
renumbered from 0007/demo16 on merge, since master already claimed `0007_ai_loc_ledger.sql`/`demo16_ai_loc.ts`.)

**Phase B — `P8.2-traceability` (prompt/response capture).** Satisfies #3. Capture each
turn's prompt + response with stable ids + provenance. Hook point is the **desktop-layer
`acp_backend.ts` `prompt()` stream** (the omp tool-call hook only sees tool calls, not the
user prompt or free-text reply); best-effort, buffered, flushed on `done`. Sanitized via
`escapeMarkdown`; raw preserved in `archive_chunks` by `content_sha256`. *Frozen-contract
impacts:* migration `0008_turn_transcripts.sql` — `turns(turn_id, run_id, session_id, seq,
role, sanitized_text, raw_sha256, archive_chunk_id, trust_label, created_at)`; new `EventName`
`turn_captured` (metadata only — ids/role/sha/blocked-count, no content).

#### Phase B delta — BUILT (prompt/response traceability, issue #12)

Shipped as specced. **Harness core** (the contract-bearing, replayable half): migration
`0009_turn_transcripts.sql` adds the `turns` table exactly as designed (renumbered from `0008`
on merge — `0008` was already claimed by Phase A's `0008_memory_session.sql`, same wrinkle the
Phase A merge note records). New `EventName` `turn_captured` in `contracts.ts` (the frozen-contract
delta this ADR sanctions). `harness/memory/turns.ts` — `captureTurn(db, …)` archives the RAW text
in `archive_chunks` (source of truth, by `content_sha256`), `escapeMarkdown`s it into the `turns`
row (the only text ever rendered), and emits the **metadata-only** `turn_captured` event
(`turn_id`/`role`/`seq`/`raw_sha256`/`trust_label`/blocked-count — never the prompt or reply text;
the artifact in scope is the raw chunk). `getTurns(db, …)` reads transcripts in session/seq order
for replay + the Logs view. Trust defaults to `untrusted` (the safe floor); the caller may raise it
(e.g. `trusted` for model output). Coverage: `harness/memory/turns.test.ts` (raw-preserved-vs-
sanitized, metadata-only event, role closed-set, trust default, ordering/filter) + demo
`harness/scripts/demo18_turns.ts` (`demo-P8.2`).

**Desktop wiring** (the actual hook point — the omp tool-call hook never sees the prompt/reply, so
capture lives in the GUI's `acp_backend.prompt()` stream). The GUI can't co-write `agent_obs.duckdb`
(the omp child holds the single writer), so — exactly like `security_log.ts` / `skills_log.ts` —
`desktop/turns_log.ts` records each turn-pair to an append-only JSONL (`~/.omp/lucid-turns.jsonl`)
plus the metadata-only `turn_captured` event, SANITIZED + sha only (the raw text is never persisted
GUI-side). `acp_backend.prompt()` calls `recordTurns()` best-effort after `done` (alongside
`learnFromTurn`), so a capture failure can never break the chat. The Phase D **Logs** view now
surfaces the captured transcripts (a "Turn transcripts" accordion + a turns chip in `/api/dev`),
closing the Phase-D stub that deferred them here. `desktop/turns_log.test.ts` covers the
metadata-only event + the sanitized/sha-only JSONL. Verified live (browser preview): the panel
renders the transcripts, the corrupt-line guard drops a malformed record, no console errors.

*Carried forward (stubbed):* the GUI live path passes blocked-count `0` (the per-turn finding count
isn't yet correlated from the gate's `security_log`); the audited raw-reveal for a transcript shares
Phase D's deferred `raw_revealed` gate; the harness `turns` table is written by the tested core +
demo (and any future single-writer consumer) — live desktop capture goes to the JSONL sidecar, the
same two-process split Phase A and `security_log` use.

**Phase C — `P8.3-vault-export` (Obsidian KG).** Satisfies #2. Depends on A; reuses B.
Export the semantic graph as an Obsidian vault: note-per-entity (`semantic_entities`) with
YAML frontmatter (kind, trust_label, entity_id); facts as bullets with trust badges +
`[[run/<id>]]` provenance backlinks; `[[wikilinks]]` from `semantic_links`; an `_index.md`
MOC; `run/<id>.md` + `session/<id>.md` provenance notes. All text via `escapeMarkdown`;
frontmatter via a small YAML-safe escaper (export the currently-private `isDangerousCodepoint`
— additive, not a frozen contract). Raw spans only under a `> [!danger] RAW` callout, gated
by Developer mode, with a mandatory `export_events` row + emitted event. *Frozen-contract
impacts:* **no migration** for the sanitized path (reuses `semantic_*`, `archive_chunks`,
`export_events`); reuse `safe_export_created`; raw path shares `raw_revealed` (Phase D). New
`harness/export/vault_export.ts`; `POST /api/vault/export` in `dev.ts`.

**Phase D — `P8.4-dev-logging` (Developer-mode admin view). BUILT (scoped).** Satisfies #4.
`developerMode?: boolean` + `setDeveloperMode` in `settings_store.ts`; a Settings toggle reveals a
read-only **Logs** rail panel (`data-rail="dev"`, third inspector view). `GET /api/dev` is gated
server-side on `developerMode` (returns `{enabled:false, snapshot:null}` when off) and surfaces, all
READ_ONLY + metadata-only: the **telemetry_events stream** (new `telemetryStream` view), **run
lineage** (`activeRuns`), the **gate block audit** (the ADR-0019-C `security_log`), and the **export
audit**. `POST /api/dev {enabled}` flips the mode.
*Deferred (honest scope):* (1) **per-turn transcripts** depend on Phase B (traceability — open
ticket #12, not built), so the transcript surface is omitted, not faked; (2) the **audited
raw-reveal** (`POST /api/dev/reveal` + `raw_revealed`) is a deliberate fail-closed weakening best
done as its own careful pass — left for a follow-up. *Frozen-contract impacts of what shipped:* a
new additive read-only dashboard view (`telemetry_stream`); no migration; no new EventName.

### Recommended build order

`A → B → C`, with `D` reading over A/B/C. **First build (future session): Phase A** — smallest
frozen surface (one migration, one event), reuses the existing distiller + the persona-injection
seam, and is fully testable against the keystone-#2 fixtures and the prefix-hash test.

### Security guardrails (must hold in every phase)

- Recall/persona enters as delimited untrusted content in the **user turn**, never the frozen
  prefix (invariants #5/#6; the prefix-hash test must stay green).
- Distillation never bypasses `promoteFactGated`; suspicious/quarantined sources never become
  recallable (keystone #2; the scanner-kill test must stay green).
- Raw-reveal is a deliberate, isolated weakening of the sanitized-only posture: Developer-mode
  only, explicit confirm, mandatory `raw_revealed` audit, transient return, enforced server-side.
- DuckDB is single-writer: all GUI/vault/dev reads use the READ_ONLY adapter and degrade to
  `null` under write-lock contention; **sidecar tables only**, never ALTER a frozen table;
  migration filenames strictly `0007_*`/`0008_*`.
- Every new `EventName` is added to `harness/contracts.ts` in the **same** increment that emits
  it (else `Telemetry.emit` throws `UnknownEventError`).

### Consequences

- No code shipped this session; the planning ADR is the artifact. `bun test harness` stays green.
- Four future increments are now pre-scoped with their exact frozen-contract deltas, so each can
  be a clean, isolated, ADR-backed change rather than a sprawling one.
- The raw-reveal decision (allow raw behind an audited gate) is the one place this roadmap
  deliberately relaxes "sanitized-only"; it is constrained to Developer mode + audit so the
  default deployment posture is unchanged.

-----

## ADR-0010 — Personalization Knowledge Graph (private, FIPS-grade, inspectable) (roadmap)

**Date:** 2026-06-19
**Status:** Accepted as a roadmap. Phases P9.1–P9.4 are **Proposed** — each is built in its
own future increment with its own confirming ADR/addendum when its frozen-contract delta lands.
**Context increment:** P9.0 (planning only — no functional code shipped this session).
**Relationship:** **Refines ADR-0009 Phase C** (which was a security-export vault) into a full
personalization feature, and reframes the memory layer's primary purpose. ADR-0009 phases A
(recall), B (traceability), and D (dev-logging) still stand and integrate with this.

### Context

The user reframed the Obsidian/knowledge-graph idea: it is **primarily a private model OF THE
USER** for tailoring responses — a Karpathy-style "second brain" of the user's preferences,
decisions, behaviors, interests, personality, and (sanitized-but-working) links — that the agent
**learns, remembers, and recalls** to personalize the experience. The security/provenance angle
is demoted to a **secondary toggle/lens**. It must be **opt-in**, **FIPS-grade encrypted at
rest**, and **inspectable as an interactive node/edge Knowledge Graph with drill-down**.

### Decisions locked (with the user)

1. **Graph view:** a hand-rolled **SVG force-directed graph, zero dependencies** (matches the
   pure-DOM renderer; airgap/gov-friendly). Built with the existing `dom.ts`/`icons.ts` SVG helpers
   + CSS variables — not a vendored graph library.
2. **Store:** a **dedicated encrypted store** for user-profile facts (AES-256-GCM), separate from
   the shared observability `agent_obs.duckdb` (whose Bun DuckDB binding cannot be transparently
   encrypted). The Obsidian vault export + secrets are encrypted too.
3. **Key custody:** **OS keystore + passphrase fallback** — Electron `safeStorage` (Windows DPAPI /
   macOS Keychain / Linux libsecret) in the packaged app; PBKDF2-HMAC-SHA256 from a user passphrase
   in the plain-Bun dev/preview runtime.
4. **Distiller:** **model-based, auto-gated** — an LLM pass distills candidate user-facts each
   session; each passes the fail-closed scanner gate; clean facts are auto-remembered (the user can
   edit/forget later in the KG view).

### Honest FIPS posture (important)

The harness + dev server run on **Bun (BoringSSL), not Node/OpenSSL**, so a true **FIPS-140
*mode*** is unavailable in that runtime. This ADR therefore commits to **FIPS-*approved*
algorithms** — AES-256-GCM (authenticated), SHA-256, PBKDF2-HMAC-SHA256 (≥600k iters) — with the
data-encryption key (DEK) **custodied by the OS keystore** and held only in memory. True FIPS-140-3
validation is an OS/module concern the application cannot self-certify; it is captured as a
**FIPS-140-3 deployment checklist** (run on a FIPS-mode OS, use a validated cryptographic module,
enforce disk encryption, restrict file ACLs). We do not oversell "FIPS validated"; we provide
FIPS-approved algorithms + key custody + the operational checklist.

### Decision — architecture

Reuse-first: `promoteFactGated` / trust semantics (`harness/memory/promotion_gate.ts`),
`escapeMarkdown`+`export_events` (`harness/export/safe_export.ts`), `wrapUntrusted` + the tail
layer-9 home (`harness/prompt/assembler.ts`), `Telemetry.emit` (`harness/telemetry/events.ts`),
the `setPersona` seam + `prompt()` stream (`desktop/acp_backend.ts`), `node:crypto`
AES-256-GCM/PBKDF2, Electron `safeStorage` (main process), and the `headroomEnabled` toggle pattern.

- **Encrypted personal store** — new `harness/personal/store.ts` + `harness/personal/crypto.ts`.
  A separate encrypted document (e.g. `~/.omp/lucid-personal.kg.enc`) holding the KG: `entities`
  {id, name, kind ∈ `user:preference|decision|interest|behavior|personality|link|skill|goal|
  relationship`, trust_label, confidence, created_at}; `facts` {id, entity_id, statement,
  trust_label, confidence, source_session_id/run_id, provenance_artifact_id?, status
  active|forgotten, promoted_at}; `links` {id, from, to, relation}. The KG is small → decrypt into
  memory, mutate, re-encrypt on write. Envelope: AES-256-GCM (random 96-bit IV per write, GCM auth
  tag = tamper-evident); 256-bit DEK sealed by the OS keystore or wrapped by a PBKDF2 KEK; DEK in
  memory only; passphrase never stored. Versioned `personal-kg.v1` (its own frozen contract; schema
  bumps re-encrypt).
- **Conversation distiller** — new `harness/personal/distiller.ts`. Hooks the `acp_backend.ts`
  `prompt()` stream (user message + assistant reply); per session, off the critical path, a model
  pass extracts durable user-facts as JSON {kind, entity, statement, confidence, relations[]}. Each
  candidate's **source is the user's own turn → scanned via `scanAndDecide`** (a malicious pasted
  link/snippet quarantines and blocks that fact, fail-closed). Clean facts auto-remembered;
  suspicious/quarantined blocked. Links are extracted, the URL scanned, then stored **sanitized but
  working** (invisibles escaped, real href preserved).
- **Recall** — new `harness/personal/recall.ts`. Builds a compact `<user-profile>` block (top-N
  salient facts grouped by kind) and injects it into the **system-prompt tail, layer 9** (after the
  cache breakpoint, never the frozen prefix); untrusted-labeled facts delimited via `wrapUntrusted`.
  Only when personalization is enabled + unlocked.
- **Knowledge Graph view** — new `desktop/renderer/graph.ts` + a new **"Knowledge"** rail tab. A
  self-contained SVG force-directed graph (simple O(n²) sim — user KGs are small): nodes = entities
  (colored by kind, sized by fact count/confidence), edges = links (relation labels); pan/zoom/drag;
  click a node → drill-down panel (facts with trust badges, source session, confidence; edit/forget;
  clickable sanitized links). A **security/provenance lens toggle** overlays trust labels + source
  sessions (the demoted secondary view). Endpoint `GET /api/personal/graph` (decrypted in-memory,
  gated on enabled+unlocked); `POST /api/personal/fact` to edit/forget (audited).
- **Obsidian export (refined ADR-0009 Phase C)** — `harness/export/vault_export.ts`. Exports the
  personalization KG: note-per-entity (user:* kinds) with YAML frontmatter, facts as bullets with
  sanitized working links + trust badges, `[[wikilinks]]` from links, an `_index.md` MOC grouped by
  kind (Preferences / Interests / Decisions / Personality / Links…). An explicit **decrypt→write**
  action (audited like a raw-reveal); all text `escapeMarkdown`-escaped (no invisibles; links work).
- **Settings / opt-in** — `personalizationEnabled?: boolean` in `settings_store.ts` (default OFF). A
  "Personalization" Settings section: enable + key/passphrase setup, lock/unlock, "Open Knowledge
  Graph", "Export Obsidian vault", and data-subject controls (forget-all / export-all / lock).

### Phases (each its own future increment + ADR for its frozen-contract delta)

- **P9.1 — encrypted store + crypto + key custody + opt-in toggle.** Foundation: `store.ts`,
  `crypto.ts`, OS-keystore/passphrase, the Settings section. New `EventName` `personal_store_unlocked`.
  No DuckDB migration (the store is a separate encrypted file).
- **P9.2 — conversation distiller (model-based, auto-gated) + recall into the prompt tail.** New
  `EventName`s `personal_fact_learned`, `personal_recall_injected`.
- **P9.3 — in-app SVG Knowledge Graph view** (nodes/edges, drill-down, edit/forget, security-lens
  toggle). New `EventName` `personal_fact_forgotten`.
- **P9.4 — Obsidian vault export** (personalization-focused, audited decrypt-export). New `EventName`
  `personal_vault_exported`; reuse `export_events` for the audit row.

### Recommended build order

P9.1 → P9.2 → P9.3 → P9.4. **First build: P9.1** — the encrypted store + key custody is the
prerequisite for everything, has the smallest surface, needs no DuckDB migration, and adds one event.

### Security & privacy guardrails (must hold)

- Distillation respects the fail-closed gate (keystone #2): suspicious/quarantined sources never
  auto-remember; the scanner-kill test stays green.
- Recall enters the tail (layer 9) after the cache breakpoint, never the frozen prefix; untrusted
  facts delimited — the prefix-hash test stays green.
- Crypto: AES-256-GCM (auth-tagged, tamper-evident), PBKDF2-HMAC-SHA256 ≥600k iters, DEK sealed in the
  OS keystore and held only in memory; passphrase never persisted.
- Opt-in OFF by default; explicit enable + key setup; **forget / export-all / lock** controls so the
  user owns and can purge their data; everything is local-first (personal facts only ever enter the
  model context the user's own turns already feed — never sent anywhere else).
- Each new `EventName` is added to `harness/contracts.ts` in the same increment that emits it.

### Consequences

- No code shipped this session; the planning ADR is the artifact. `bun test harness` stays green.
- The four phases are pre-scoped with their exact `EventName` deltas and the new encrypted-store
  contract, so each future increment is clean and isolated.
- The personalization store is the project's first **encryption-at-rest** surface — a deliberate new
  capability, scoped to opt-in personal data, with an honest (not oversold) FIPS posture.

-----

## ADR-0011 — Observability & cost intelligence (roadmap)

**Date:** 2026-06-19
**Status:** Accepted as a roadmap. **P10.1 BUILT** + **P10.2 BUILT** + **P10.3 BUILT** (the live
header probe landed as an opt-in — `desktop/ratelimit_probe.ts`, parsers unit-tested, surfaced in
the budget panel). **P10.4 remains Proposed.** The proactive budget warning also shipped earlier
(chip turns red + a once-per-window toast at ≥90%, so you see the wall coming);
the live header probe is deferred. **P10.4 remains Proposed**.

> **P10.3 design note (learned in build):** the user's binding limit is the **Claude oauth 5-hour
> window**, which has **no rate-limit header to probe** — and a probe would *consume* the very budget
> being watched. So the valuable, correct move for the oauth case is the **proactive warning** off
> omp's reported figure (shipped), not a probe. The header probe (`anthropic-ratelimit-*` /
> `x-ratelimit-*`) is worthwhile only for **API-key** providers and needs a live key to verify;
> deferred as the remaining half of P10.3.
**Context increment:** P10.0 (planning; the related context-window display bug was fixed inline).

### Context

The user wants the GUI to be honest and informative about *what the agent is doing and what it costs*:
a live "thinking" HUD per response, accurate provider limits, and a cross-model token/cost ledger that
shows where their tokens go and which models earn the best prompt-cache savings. A first, concrete bug
surfaced this: switching to Gemini 2.5 Flash (1M) still showed 256k/200k context — **fixed inline** by a
per-model context-window map (`MODEL_CTX` in `app.ts`, `CTX_WINDOW` in `tools/memory_data.ts`).

### Decision — the four phases

**P10.1 — Response activity HUD.** During a streaming turn, show a live **MM:SS timer counting up**, a
**semantic "phase" label**, and a **running token-cost estimate** — a friendlier take on what Claude Code
shows. The phase label is driven by REAL signals already on the chat stream (`acp_backend.ts` emits `tool`
events with name/detail) plus a heuristic opening guess from the user's ask ("Searching the codebase…",
"Reasoning…", "Editing files…", "Running tests…"). Cost estimate accrues from the streamed `usage`
events × per-model pricing. Mostly client-side; no new contract. Also surface each model's context window in
the **model picker dropdown** (today's `MODEL_CTX` makes this trivial).

**P10.2 — Cross-model usage & cost ledger.** Aggregate tokens + cost **per model across sessions**: all-models
total, **provider/subscription vs. local** (if a local runtime is installed), average cost savings, *where*
the tokens go (top models), and **which models give the best prompt-cache hit-rate / savings**. A flippable
**savings card**: per-turn → per-model → an all-models summary with **estimated savings vs. full price**
(cacheRead billed at ~10%, so savings ≈ cacheRead × 0.9 × input-price). Source: the telemetry stream + omp
session transcripts + per-model pricing (the AskSage extension already carries `cost{input,output,cacheRead,
cacheWrite}`; omp carries native pricing). May add a usage-rollup migration if live aggregation is too slow.

**P10.3 — Live provider rate-limit probes.** The "Claude 5 Hour" figure is omp's last-seen value and lags.
Replace it with a **lightweight probe every 5 min** for each configured provider that has a key: a minimal
request whose **response rate-limit headers** carry the real remaining budget (Anthropic
`anthropic-ratelimit-*`; OpenAI `x-ratelimit-*` / usage endpoint). Show accurate "remaining / resets-at" per
provider; only runs when a Claude/OpenAI key (or AskSage gov) is present. Opt-in (a tiny request has a tiny
cost); reuses the existing 5-min budget-poll scheduler.

**P10.4 — Local vs. gateway attribution.** Tag each turn's spend as subscription/provider vs. local model
(if a local runtime is ever added) so the ledger can answer "how much am I spending where," and feed the
savings card.

### Open questions (resolve before building each phase)

- Exact provider rate-limit header semantics + whether a `count_tokens`/`max_tokens:1` probe is the cheapest
  way to read them without burning quota (P10.3).
- Whether per-model pricing lives in one shared table (the renderer + harness both need it; today `MODEL_CTX`
  is duplicated — pricing should probably be exposed via an API endpoint to avoid drift).
- Whether the usage ledger aggregates live from telemetry or needs a rollup table (perf at scale) (P10.2).

### Consequences / guardrails

- All read-only and additive; no change to the security gate or frozen prompt prefix.
- Provider probes are opt-in and only fire with a configured key; no telemetry leaves the machine.
- This is sequenced **after** the P9 personalization work; P9.1 (encrypted store) is the immediate next build.

-----

## ADR-0012 — Personalization compartments (Work / Personal / Combined / CUI) + portability

**Date:** 2026-06-19
**Status:** Accepted. The compartment data model + the Settings selector with risk notices shipped with
P9.1; the scope-aware portability/export and the CUI hardening option are **Proposed** (P9.4 / future).
**Relationship:** extends ADR-0010. Answers "can this connect to other harnesses/consumers for max
portability, with a Work/Personal/Combined/CUI slider and per-mode risk notices?" — **yes, scope-aware**.

### Context

The personalization knowledge graph should be **portable** to other harnesses / consumers / providers
(maximum reuse), AND **compartmentalized** so the user controls *what* is portable. Different categories of
personal knowledge carry very different handling duties — especially **CUI** (Controlled Unclassified
Information), which has formal handling rules (e.g. NIST SP 800-171). Portability and compartments are the
same design: you make Personal freely portable, gate Work, and never auto-export CUI.

### Decision — compartments

A fact belongs to exactly one **scope**: `work | personal | cui`. **Combined** is a VIEW (the union), never
a stored value. The active compartment scopes what is learned and recalled; new facts default to
**Personal**. Each compartment surfaces a security posture + a risk-mitigation notice in the UI:

| Compartment | Posture | Notice (shown to the user) |
|:--|:--|:--|
| **Personal Life** | private/default | Private to you, encrypted on device; used only to tailor responses. |
| **Work** | caution | May include employer-confidential context; don't store secrets/credentials; review before sharing. |
| **Combined** | caution | Union of all scopes; crosses boundaries — take care when exporting/sharing. New facts still default to Personal. |
| **CUI** | restricted | CUI handling: encrypted at rest, **never auto-exported / shared** with external consumers; follow org CUI policy; no classified info. |

Implemented in P9.1: `PersonalFact.scope`, `graph({scope})`, `scopeCounts()`, the `personalScope` setting,
and the Settings selector with the colored per-mode notice (green/amber/red).

### Decision — portability (the answer)

Three layers, **scope-aware**:

1. **The encrypted store is private by design** (`personal-kg.v1`, AES-256-GCM) — not portable without the
   DEK. This is the system of record, not the interchange format.
2. **Obsidian vault export = the portable, human-readable interchange** (P9.4): Markdown + `[[wikilinks]]`,
   readable by any tool. Export is **scope-filtered + audited**: Personal exports freely; Work/Combined warn;
   **CUI is excluded by default** and requires explicit, audited acknowledgment (mirrors the raw-reveal gate).
3. **A versioned interchange + connector contract** (future): a plaintext `personal-kg-export.v1` JSON
   schema (entities/facts/links + scope + provenance) and a **scope-declaring connector** so another harness
   can request a compartment it's permitted to read — e.g. exposed read-only over MCP. A consumer declares
   the scopes it may receive; **CUI never leaves without explicit per-export consent + an audit row**.

Honest caveat: any cross-tool sharing widens the trust boundary. The compartments + notices + scope-aware,
audited export ARE the mitigation; portability is **off by default for Work and CUI**.

### Open question (flagged for confirmation)

**CUI isolation strength.** P9.1 stores all compartments in one encrypted store, separated by the `scope`
tag + UI/export rules. A stronger future option is **hard isolation** — a separate encrypted store (or a
separate per-compartment DEK) for CUI, so a single key never decrypts both CUI and non-CUI. Recommended:
ship tag-based separation + the CUI notices now; treat hard isolation as a documented hardening upgrade if
an accreditation requires it.

### Consequences / guardrails

- New facts default to Personal; CUI must be chosen deliberately.
- CUI is never auto-exported, auto-recalled into shared contexts, or sent to external consumers without an
  explicit, audited consent step.
- The compartment model is forward-compatible (added to the fresh store before any data existed).

-----

## ADR-0013 — P9.4: audited Obsidian vault export + NARA-aligned CUI archive

**Date:** 2026-06-19
**Status:** Accepted. Built this increment (P9.4). Realizes ADR-0012 portability **layer 2**
(the portable interchange) and adds the **CUI-compartment migration for archive requirements**
the user asked for ("CUI migration option for archive requirements (National Archive Requirements)").
**Relationship:** implements ADR-0010 P9.4 and ADR-0012 §portability; the connector contract
(layer 3) remains future work.

### Context

The personalization KG is the system of record (encrypted, private). Users need a **portable,
human-readable** copy (Obsidian vault), and CUI-compartment data has **records-management** duties
(US National Archives / NARA) distinct from ordinary export. P9.4 delivers both as **explicit,
audited decrypt→write actions** — never automatic.

### Decision — two distinct export paths

1. **Obsidian vault export** (`buildVault`) — note-per-entity with YAML frontmatter, facts as
   bullets (trust + confidence + session provenance), sanitized-but-working links, `[[wikilinks]]`
   from KG links, and an `_index.md` MOC grouped by kind. **Scope-filtered**: defaults to
   `personal + work`; **CUI is excluded unless explicitly listed in `scopes`** (and then the index
   carries a loud warning). The portable, freely-shareable interchange.
2. **CUI archive** (`buildCuiArchive`) — a **separate, loud, danger-styled** action that exports
   **only** the `cui` scope into a records-managed package: a `_CUI_COVER_SHEET.md` (SF-901-style
   banner cover sheet), CUI **banner markings** top/bottom of every note + **`(CUI)` portion marks**
   on every fact, and a `_CUI_MANIFEST.json` carrying CUI designation fields (category, designating
   agency, controlled-by, dissemination controls, decontrol) and **NARA records-management** fields
   (records schedule, disposition, retention) plus a **SHA-256 inventory** of every file and a
   `manifest_sha256` that attests to that inventory.

### Honest posture (mirrors the FIPS posture in ADR-0010)

The tool **marks and packages**; it does **not certify a designation**. CUI/NARA fields that the
user does not supply are emitted as an explicit `REQUIRED — complete per your CUI/records program`
placeholder (never silently blank), and the manifest carries a notice that an authorized
CUI/records officer must complete and verify the designation (32 CFR Part 2002; NARA records
schedule). Honest scaffolding, not a compliance claim.

### Security guarantees (tested)

- **Scope isolation:** CUI never appears in the ordinary vault unless explicitly requested; the CUI
  archive contains only CUI (no personal/work leak). Both directions are unit-tested.
- **No invisible bytes:** every emitted string passes `escapeMarkdown` (defense in depth) — a
  zero-width/bidi/control codepoint becomes `\u{XXXX}`, never a raw invisible. Tested.
- **Links sanitized but working:** only a strict `https?://` URL with no dangerous codepoints
  becomes a clickable `[display](href)`; anything else degrades to escaped text. `isSafeUrl` rejects
  `javascript:`, embedded zero-width, and whitespace. Tested.
- **Path safety:** the writer refuses any file path that escapes the chosen destination directory.
- **Audited, two ways:** (1) an **encrypted, in-store** append-only trail (`PersonalExportEvent`) —
  as private and tamper-evident as the data it concerns; (2) a **metadata-only** telemetry event
  (`personal_vault_exported` / `personal_cui_archived`) to a local NDJSON audit log — counts +
  hashes + scopes only, **never** fact content and **never** the destination path.

### Frozen-contract deltas (this increment)

- **`contracts.ts` EventName** (closed enum): added `personal_vault_exported`,
  `personal_cui_archived`. Added in the same increment that emits them (invariant #8).
- **`personal-kg.v1` store contract:** **additive** — optional `PersonalGraph.exports?:
  PersonalExportEvent[]` (the audit trail). Backward compatible: a store written before P9.4
  decodes with `exports: []`. **No version bump** (old stores still open).
- **No DuckDB migration** — the personalization store is a separate encrypted file; the vault is
  written to a plain directory.

### Reuse / non-fork

`escapeMarkdown` is reused from `safe_export.ts` (its frozen surface untouched). `buildVault` /
`buildCuiArchive` are **pure** (no I/O, caller passes `now`) so the security-sensitive rendering is
fully unit-testable; the desktop layer (`desktop/personal.ts`) does decrypt → write → audit. New
endpoints `POST /api/personal/vault`, `POST /api/personal/cui-archive`, `GET /api/personal/exports`.

### Open items (unchanged from ADR-0012)

- **Connector contract (layer 3)** — the scope-declaring read-only MCP connector — remains future.
- **Hard CUI isolation** (separate store / per-compartment DEK) remains the documented hardening
  upgrade if an accreditation requires it; P9.4 keeps tag-based separation + the loud, audited,
  CUI-only archive path.

-----

## ADR-0014 — Hard CUI isolation: a separate encrypted store with its own DEK (roadmap)

**Date:** 2026-06-19
**Status:** Accepted — **built**. P9.5a shipped the separate `personal-cui.v1` store + independent
unlock + two-store routing + the data-layer isolation guard; P9.5b shipped the audited migration
(move legacy cui out of the main store) + NARA records-destruction. Resolves the **open question**
flagged in ADR-0012 ("CUI isolation strength"). (P9.5c — the dedicated CUI-lock UX polish — folded
into the existing compartment selector; remaining nice-to-haves tracked in PROGRESS.)
**Relationship:** hardens ADR-0010/ADR-0012; complements ADR-0013 (the CUI archive export) by also
isolating CUI **at rest in the working store**, not just at export time.

### Context — the weakness this closes

Today (P9.1–P9.4) all compartments — `work`, `personal`, `cui` — live in **one** encrypted store
(`lucid-personal.kg.enc`, `personal-kg.v1`) under **one DEK**, separated only by the `scope` tag +
UI/export rules. That tag-based separation is enough for handling discipline, but it has a real
limitation: **unlocking to use Personal necessarily decrypts CUI into the same process memory**, and
a single compromised secret (passphrase or keystore entry) exposes CUI alongside everything else.
ADR-0012 explicitly deferred the stronger option. This ADR designs it.

**Goal (the invariant to add):** *a single key never decrypts both CUI and non-CUI.* CUI can stay
locked while Personal/Work are in use (and vice versa), and CUI records can be destroyed
independently — directly serving the NARA records-destruction duty introduced in ADR-0013.

### Decision — Option A: a separate CUI store (separate file, separate DEK, separate custody)

Split CUI into its **own** encrypted document:

- **`~/.omp/lucid-personal.kg.enc`** (`personal-kg.v1`) — holds **work + personal** only. After
  migration it contains **no** `cui` facts, and the API **rejects** writing a `cui`-scoped fact into it.
- **`~/.omp/lucid-cui.kg.enc`** (new format **`personal-cui.v1`**, its own frozen contract) — holds
  **cui** only. Reuses the exact `crypto.ts` algorithm layer (AES-256-GCM, PBKDF2-HMAC-SHA256
  ≥600k, GCM auth tag) with an **independent** DEK, salt, and `wrappedDek`/keystore entry.

Two DEKs, each in memory **only while its own store is unlocked**. The Personal/Work unlock path
never derives or holds the CUI DEK — the new invariant holds by construction.

**Rejected alternatives.** *(B) One file, two wrapped DEKs* — granular, but co-locating ciphertext
couples lifecycle, so you can't destroy CUI by deleting a file (records destruction matters here).
*(C) Per-scope DEK via HKDF from one master KEK* — `crypto.ts` has no HKDF, and more importantly the
master KEK in memory could derive **both** keys, which **violates the goal**. Option A is the only
one that actually satisfies "one key never decrypts both."

### Why Option A pays off (beyond isolation)

1. **NARA records destruction (ties to ADR-0013):** zeroize the CUI DEK + delete `lucid-cui.kg.enc`
   = a clean, auditable destruction of CUI records that leaves Personal/Work untouched.
2. **Independent lifecycle:** lock CUI while Personal is open; require CUI re-auth more often; the CUI
   store file *is* the encrypted-at-rest archive, pairing with the P9.4 plaintext CUI archive.
3. **Independent custody:** the CUI store gets its **own** secret — a distinct passphrase
   (recommended, not forced) or a distinct OS-keystore entry (a separate named `safeStorage` blob).

### Behavior changes (designed; built in P9.5)

A small manager holds up to two stores (`main` = work+personal, `cui`). Routing becomes scope-aware:
- `graph({scope})`: `cui` → cui store; `work|personal` → main; `combined` → **union of both when both
  unlocked**; if CUI is locked, Combined shows non-CUI + an explicit **"CUI locked"** marker (chosen
  over blocking Combined entirely).
- **Learning** a `cui`-scoped fact requires the CUI store unlocked; if it's locked, the fact is
  **dropped, never silently written to the main store** (fail-closed — keystone #2 discipline).
- **Recall** of CUI facts happens only when the CUI store is unlocked.
- **Export:** `exportCuiArchive` (ADR-0013) reads the CUI store; the vault export reads main (CUI
  already excluded). No change to the export *formats*.
- `scopeCounts()` reports `cui` from the CUI store when unlocked, else a "locked" sentinel (count
  hidden, not zero — zero would mislead).

### KDF choice — PBKDF2 stays for the CUI path (Argon2/bcrypt rejected here, on purpose)

A fair challenge was raised: **Argon2id / bcrypt are memory-hard and resist GPU/ASIC cracking, so
why PBKDF2?** The answer is the federal/FIPS requirement, which inverts the usual recommendation:

| KDF | Memory-hard | FIPS-approved | Available |
|:--|:--|:--|:--|
| **PBKDF2-HMAC-SHA256** | no | **yes** (NIST SP 800-132) | `node:crypto` |
| Argon2id | yes (PHC winner) | **no** | Bun.password only → PHC string, **not** raw KEK bytes |
| scrypt | yes | **no** | `crypto.scryptSync` |
| bcrypt | partial | **no** | + 72-byte truncation; a password-storage hash, not a KDF |

For CUI / "max federal-platform integration," an **unapproved KDF is a compliance non-starter even
though it is cryptographically stronger** against GPUs. FIPS-approval wins for this data class.
bcrypt is additionally disqualified: not a key-derivation function (we need raw 32-byte KEK output
to wrap the DEK; bcrypt/`Bun.password` yield a verification hash) and it truncates at 72 bytes.

**Resolution:** PBKDF2-HMAC-SHA256 remains the **default and the only CUI-path KDF**, with the
iteration count compensating for the lack of memory-hardness — currently **600k**, at OWASP's
present recommendation; revisit upward over time. The envelope's version-tagged `kdf.algo` field was
built for exactly this, so **Argon2id may be added later as an explicitly-labeled NON-FIPS hardening
option** for non-federal deployments — never the CUI default. (Same honest posture as ADR-0010: the
strongest *approved* algorithms by default; document where a stronger-but-unapproved option exists.)
The Argon2id slot + a self-describing cipher-suite descriptor are specified in **ADR-0015**
(crypto-agility + PQC readiness), which this KDF decision feeds into.

### Frozen-contract deltas (for the future build increments)

- **New store format `personal-cui.v1`** — its own frozen contract (envelope identical in shape to
  `personal-kg.v1`; the algorithm layer is unchanged, PBKDF2-HMAC-SHA256).
- **New EventNames** (added in the increment that emits them, invariant #8):
  `personal_cui_store_unlocked`, `personal_cui_migrated`, `personal_cui_destroyed`.
- **No DuckDB migration** (the stores are separate encrypted files).
- `personal-kg.v1` is structurally unchanged; post-migration it simply holds no `cui` facts, and the
  main store's write path rejects `scope==="cui"`.

### Phases (each its own future increment + ADR delta)

- **P9.5a — CUI store + dual-custody unlock + routing.** The `personal-cui.v1` store, an independent
  unlock flow, the two-store manager, and scope routing (main store rejects `cui` writes; cui
  learning/recall/graph/export route to the CUI store). New format + `personal_cui_store_unlocked`.
- **P9.5b — audited migration + records destruction.** A one-time, **idempotent, audited** migration
  that moves existing `cui` entities/facts/links out of the main store into the CUI store (reuses the
  P9.4 audit trail); plus a loud, confirmed **"Destroy CUI records"** action (zeroize DEK + delete
  file). New events `personal_cui_migrated`, `personal_cui_destroyed`.
- **P9.5c — UI.** An independent CUI lock state in the compartment selector (unlock CUI separately),
  the Combined "CUI locked" handling, and the destroy-CUI confirm.

**Recommended first build:** P9.5a.

### Honest posture (unchanged)

Hard isolation strengthens **key separation** and **records destruction**; it does **not** change the
BoringSSL/approved-algorithms-not-FIPS-*mode* caveat from ADR-0010. Same algorithms, two keys.

### Resolved decisions (confirmed 2026-06-19) — these are now design requirements

1. **Separate CUI passphrase — recommend, do not force.** The CUI store may use the same or a
   distinct secret; the UI strongly suggests separate and never silently reuses. The **first-time
   passphrase setup** (for the CUI store, and retrofitted to the existing main-store setup field)
   MUST include: a **confirm-match** field (type the passphrase twice; create is disabled until they
   match), a **Caps Lock indicator** shown when Caps Lock is on, and a **show/reveal toggle** so the
   user can verify what they typed. (Folded into P9.5c; the main-store retrofit is a small, separable
   UI follow-up.)
2. **CUI auto-locks the moment it is not the selected compartment.** Switching the active compartment
   away from CUI immediately **zeroizes the CUI DEK + drops the CUI store**; returning to CUI requires
   re-entering the CUI passphrase/code. Consequence (decided): the **Combined** view therefore never
   silently includes CUI — when CUI isn't the active compartment it is locked, so Combined shows
   non-CUI facts + an explicit **"CUI locked"** marker. This is stricter than always-unlocked Combined
   and is the chosen behavior. (Supersedes the earlier "show non-CUI + marker vs. block" question.)
3. **Migration is explicit + audited**, and the broader goal is **maximum portability/integration with
   federal platforms and standards** for this data class. So beyond the explicit "Move my CUI data
   into the isolated store" action (audited, idempotent — see P9.5b), the CUI store + its ADR-0013
   archive should **align markings + metadata to federal standards in use**: the ISOO **CUI Registry**
   categories (32 CFR 2002), **NARA records schedules**, and a **federal-conformant interchange** for
   the future connector (ADR-0012 layer 3) — candidates to evaluate: NIEM-conformant export, and the
   relevant DoD/agency records-management metadata. Honest caveat (unchanged): the tool marks,
   packages, and structures to these standards; an authorized CUI/records officer still completes and
   certifies designations. Capturing the *specific* federal interchange target is its own scoping pass
   before the connector increment.

-----

## ADR-0015 — Crypto agility: Argon2 + PQC readiness (FIPS 203 / 204 / 205)

**Date:** 2026-06-19
**Status:** Accepted as a standing architectural principle (planning/posture — no functional code this
session). Establishes that LucidAgentIDE's cryptography is **algorithm-agile and post-quantum-ready**,
so newly-approved NIST algorithms drop into versioned slots without breaking existing data.
**Relationship:** generalizes the `kdf.algo` decision in ADR-0014 into a whole-system principle; sets
the crypto direction for the future connector (ADR-0012 layer 3) and signed exports (ADR-0013).
**Driver:** federal procurement is now pushing PQC. NIST finalized the first PQC standards (Aug 13,
2024): **FIPS 203 ML-KEM** (key encapsulation, from CRYSTALS-Kyber), **FIPS 204 ML-DSA** (digital
signatures, from CRYSTALS-Dilithium), **FIPS 205 SLH-DSA** (stateless hash-based signatures, from
SPHINCS+); plus **SP 800-208 LMS/XMSS** (stateful hash-based signatures). Symmetric **AES-256** (FIPS
197) and **SHA-384/512** (FIPS 180-4) remain approved. (User reference: safelogic.com/compliance/pqc-standards.)

### The reassuring headline (honest, and true today)

**Our data at rest is already quantum-resistant.** The personalization store and the CUI archive are
encrypted with **AES-256-GCM**, and the KEK is derived with **PBKDF2-HMAC-SHA256** — both symmetric /
hash-based. Quantum attacks (Grover) only *halve* symmetric strength: AES-256 → ~128-bit, SHA-256 →
~128-bit, which remain strong. Critically, **the at-rest path uses NO asymmetric cryptography**, so
there is **no "harvest-now-decrypt-later" exposure** for the stored data — HNDL threatens key-exchange
and signatures, which we don't use at rest. PQC matters for us the moment we add *asymmetric* crypto:
**sharing** a compartment to another consumer (key establishment) and **signing** exports (authenticity).

### Decision — crypto agility as a contract

Every cryptographic choice is **named + versioned** in the data it protects, so an algorithm can be
swapped without breaking old artifacts (the principle already present in `kdf.algo` + the
`personal-kg.v1` / `personal-cui.v1` / `lucid-cui-archive.v1` format versions). The build increment
generalizes this into an explicit **cipher-suite descriptor** carried by each envelope/export:

```
suite: { kdf: "pbkdf2-hmac-sha256" | "argon2id", aead: "aes-256-gcm",
         hash: "sha-256" | "sha-384" | "sha-512",
         kem?: "ml-kem-768",            // FIPS 203 — only when a channel/transfer needs it
         sig?: "ml-dsa-65" | "slh-dsa-…" | "lms" | "xmss" }   // FIPS 204/205 / SP 800-208
```

Old artifacts keep their recorded suite and still open; new artifacts can adopt stronger suites. No
silent algorithm changes — the suite is self-describing and audited.

### Where each PQC algorithm plugs in (the readiness map)

| NIST standard | Algorithm | Where it enters LucidAgentIDE |
|:--|:--|:--|
| **FIPS 203** | ML-KEM (Kyber) | **Connector (ADR-0012 layer 3):** post-quantum **key establishment** / DEK-wrapping when a compartment is shared to another harness/consumer. Hybrid X25519+ML-KEM during transition. |
| **FIPS 204** | ML-DSA (Dilithium) | **Signed exports:** authenticity signature over the vault / CUI archive + manifest (beyond today's SHA-256 *integrity* inventory). |
| **FIPS 205** | SLH-DSA (SPHINCS+) | **Long-term archival signatures:** conservative, hash-only security — ideal for decades-long **NARA records** provenance. |
| **SP 800-208** | LMS / XMSS | Stateful hash-based signing alternative for archive integrity where a state-managed signer is acceptable. |
| **FIPS 197 / 180-4** | AES-256, SHA-384/512 | Already approved + quantum-resistant. **Keep AES-256;** offer SHA-384/512 in the suite for extra hash margin. |
| (non-FIPS) | **Argon2id** | KDF hardening opt-in (ADR-0014) — memory-hard, but **not FIPS-approved**, so never the CUI/federal default. |

### Honest posture (the caveat that keeps this truthful)

This ADR makes the system **PQC-*ready*, not PQC-*implemented* today.** Bun/BoringSSL + `node:crypto`
do not yet expose ML-KEM / ML-DSA / SLH-DSA through a stable, FIPS-*validated* surface; these standards
are months old and the validated modules are still landing. Readiness here means: (1) the suite
descriptor + format-versioning so PQC artifacts are expressible and old ones still open; (2) algorithm
selection isolated behind the `crypto.ts` layer so adding a KEM/sig is a localized change; (3) a
preference for **hybrid** (classical + PQC) during any transition. When a validated module ships the
PQC primitives, we populate the `kem`/`sig` slots — no schema rewrite. Same discipline as the FIPS
posture in ADR-0010: approved algorithms now, an honest, documented path to the next bar.

### Accreditation impact (NIPR / SIPR / TS) — and how the design stays clean

Does shipping the non-FIPS **Argon2id** option jeopardize a future ATO? Answer: **only if it is
*reachable to protect the data* in the accredited configuration.** Mere presence in the binary is not
automatically disqualifying; assessors evaluate the **as-deployed configuration** against NIST SP
800-53 **SC-13** (Cryptographic Protection) + **IA-7** (Cryptographic Module Authentication).

- **NIPR (incl. CUI):** FISMA / FIPS 140-3. If Argon2id is *selectable* to key data in scope → an
  SC-13 finding. "Present but provably unreachable in the FIPS/gov configuration, documented" is
  defensible; **excluding it from the gov build** is cleaner.
- **SIPR (Secret) / TS (Top Secret):** National Security Systems — **CNSSP-15 / CNSA** (and **CNSA 2.0**
  for the PQC transition: ML-KEM, ML-DSA, AES-256, SHA-384/512, LMS/XMSS — i.e. the FIPS 203/204/205 +
  SP 800-208 set above), NSA-approved. Argon2id is **excluded, full stop**; FIPS validation is
  necessary but not sufficient on classified domains.

**The dominant gate is the module, not the algorithm.** Today the crypto runs on Bun/BoringSSL, which
is **not a CMVP-validated module** (ADR-0010). Using approved *algorithms* ≠ FIPS-compliant until the
calls execute inside a **validated module** (a validated OpenSSL, the OS module, or an HSM/validated
keystore). For any real NIPR/SIPR/TS ATO that module swap is the major work; Argon2id is a footnote.

**Resolution — three guards make "keeping Argon2id" a non-issue:**
1. **A `gov`/`fips` build profile** that excludes non-approved algorithms (Argon2id, scrypt) from the
   bundle entirely — minimal attack surface, nothing for an assessor to flag.
2. **An enforced runtime FIPS mode** (defense in depth): the algorithm registry **fails closed** on any
   non-approved suite when FIPS mode is on — never silently downgrades — and refuses to start unless
   backed by a validated module / self-test.
3. **Argon2id stays a clearly-labeled option only in the non-gov build** (for non-accreditation-bound
   users who want memory-hardness).

Honest caveat: final authority rests with the AO + the assessment; this is the posture assessors
expect, designed in now (a small registry guard) rather than bolted on later (a refactor).

### Frozen-contract deltas (for the future build increment)

- Extend the store/export envelopes with the **`suite` descriptor** (additive; absent ⇒ the documented
  P9.1/P9.4 defaults — back-compatible, no version bump unless a slot's *meaning* changes).
- **FIPS-mode flag + `gov`/`fips` build profile**: the algorithm registry is constrained to
  approved-only when set; non-approved algorithms are excluded from the gov bundle and unselectable at
  runtime (fail-closed). New EventName candidate `crypto_fips_mode` (added only when emitted).
- `crypto.ts` grows an internal **algorithm registry** (kdf/aead/hash/kem/sig) gating which suites are
  selectable in this runtime; selecting an unavailable algorithm fails loud, never silently downgrades.
- New EventName candidate `crypto_suite_selected` (added only when emitted).
- No DuckDB migration.

### Not now (scope discipline)

No code this session. The suite descriptor + Argon2id opt-in land with the P9.5 crypto work; the
KEM/sig slots are populated when (a) the connector increment needs key establishment and (b) a
validated PQC module is available. Tracked as **P9.6 — crypto-agility + PQC slots** in the roadmap.

-----

## ADR-0016 — Chat reading experience + the one renderer dependency (KaTeX)

**Date:** 2026-06-20
**Status:** Accepted. Built this increment (chat-UX overhaul).
**Relationship:** refines the GUI (ADR-0006) and the P10.1 HUD (ADR-0011).

### Context

The chat surface had real friction: model replies with LaTeX showed as raw `\frac`/`\int`,
output couldn't be copied or saved, code blocks were hard to scan, the column wasted horizontal
space, the model hover-cards got stuck on screen, and a rate-limited turn hung on "Thinking…"
forever (no ACP timeout — fixed separately in this session).

### Decision — the one dependency: KaTeX, bundled offline

The renderer was deliberately **zero-dependency** (airgap/gov; same reasoning that kept the
Knowledge graph hand-rolled). Proper LaTeX rendering is the one place a hand-rolled approach can't
keep up (the replies use `\begin{align*}`, `\mathbf`, matrices). So we add **exactly one** renderer
dep — **KaTeX** — and **vendor it fully offline** (no CDN): `desktop/renderer/vendor/katex/` holds
`katex.min.css` + 20 woff2 fonts, served from the renderer for both the dev server and the Electron
`file://` build. This preserves the airgap posture (nothing is fetched at runtime).

Safety: math is rendered up front with `katex.renderToString` (`trust:false` blocks `\href` etc.;
KaTeX escapes its own input), swapped for a private-use placeholder THROUGH marked+DOMPurify, then
the trusted KaTeX HTML is reinserted AFTER sanitizing (KaTeX needs inline styles that DOMPurify
would otherwise strip). A render cache keeps streaming cheap; a pure-number guard avoids `$10`
currency false positives. The `.katex` HTML is the only post-sanitize HTML we trust, and only
because we generated it.

### Also shipped (renderer-only, no contract change)

- Per-message **Copy markdown** + **Save .md** (raw markdown stashed on the node).
- HUD moved **below** the streaming line, with the live **token counter** kept on it.
- **Wider** thread/composer (`min(1080px, 94vw)`), font smoothing, clearer **code blocks** (distinct
  surface + accent edge + smooth horizontal scroll).
- **Stick-to-bottom** autoscroll (follows output only when already near the bottom — no yank when
  you scroll up to re-read).
- **Tooltip fix:** the model hover-card lives on `document.body` and was orphaned when the picker
  closed (its `mouseout` never fired); a global guard dismisses it the moment the pointer leaves a
  model row (and on click/wheel).

### Consequences

- JS bundle grows ~460KB (KaTeX) — the cost of offline math; acceptable for a desktop app.
- `desktop/renderer/vendor/` is now a tracked, shipped path (`.gitignore` exception added).
- The zero-dep stance still holds everywhere else; KaTeX is the single, justified, vendored exception.

-----

## ADR-0017 — Knowledge-graph relational edges + multi-vendor chat-export import

**Date:** 2026-06-20
**Status:** Accepted. Built this increment (P9.6 edges + P9.7 importer).
**Relationship:** completes the personalization KG (ADR-0010); imports feed it; reuses the
fail-closed distiller (keystone #2) and the compartment routing (ADR-0012 / ADR-0014).

### Context

Two user-reported gaps in the personalization knowledge graph:
1. **No relational lines.** The graph rendered nodes but never any edges.
2. **No way to seed it.** A new user starts empty; they wanted to import their existing
   ChatGPT (and Claude) history so the graph reflects them from day one.

### Part 1 — why there were no edges (P9.6)

The edge path was wired correctly at every layer EXCEPT the one that creates links. Links are
only written when a distilled fact candidate carries a `relations[]` array, and **neither
extractor produced one**: the heuristic emitted none, and the model extractor's prompt didn't
ask for relations (nor did its parser read them). So `store.links` stayed empty and the (correct)
renderer had nothing to draw.

**Fix:** the model extractor now requests + parses a `relations:[{to,relation}]` array (real
semantic edges, e.g. rust → "deploys with" → kubernetes). The offline heuristic chains a turn's
non-link facts with a weak, clearly-labelled `"mentioned with"` co-occurrence edge so structure
appears even without the model. `distillTurn` resolves a relation's target to the real
turn-entity (preserving its own kind, not the source fact's) and dedups undirected. This only
affects facts learned AFTER the fix — pre-existing facts have no recorded relations and stay
edgeless (no retroactive relink pass).

### Part 2 — multi-vendor import (P9.7)

**Decision: imports go through the SAME gated distiller as live chat — never a side door.** An
imported transcript is untrusted external content, so every imported USER message passes
`scanAndDecide` before any fact is stored. A poisoned message in an old export quarantines exactly
like a live one (keystone #2). Assistant messages are never distilled (the profile is built from
the user's own words). Imported facts carry `source_session_id = "import:<vendor>"` for provenance
in the graph drill-down.

**Vendor adapters** (`harness/personal/import_adapters.ts`, pure + offline): both vendors export a
top-level JSON array in `conversations.json`. ChatGPT uses a per-conversation `mapping` of message
nodes (`author.role`, `content.parts`); Claude uses `chat_messages[]` (`sender:human|assistant`,
`text`/`content`). `detectVendor` sniffs the shape; `parseExport` normalizes both to
`{title, messages:[{role,text}]}`. The design generalizes — a Gemini/Takeout adapter is ~30 lines.

**Importer** (`harness/personal/importer.ts`): runs each user message through `distillTurn`,
tallies learned/blocked, emits one metadata-only `personal_facts_imported` event, and saves the
store ONCE at the end (new `distillTurn` `persist:false` option avoids O(n²) re-encryption over a
large export). Routes to the active compartment; cui routes to the isolated CUI store and learns
nothing if it's locked (fail-closed). Per-message scan failures block only that message.

**Desktop**: `importChatExport(path)` accepts the extracted export FOLDER (finds
`conversations.json` inside) or the file itself; `POST /api/personal/import`; a "Import history"
button in the Knowledge toolbar reuses the in-app folder browser (now label-parameterized) and
toasts a summary incl. how many messages the gate quarantined.

### Frozen-contract impact

- New `EventName` `personal_facts_imported` — added in the same increment that emits it (else
  `emit` throws). This is the only frozen-contract change; hence this ADR.
- No DuckDB migration (the personalization store is a separate encrypted file, not DuckDB).
- The encrypted-store format (`personal-kg.v1`) is unchanged — imports use existing
  entity/fact/link shapes.

### Guardrails preserved

- Fail-closed: import scans every message; suspicious/quarantined sources teach nothing; the
  scanner-kill test stays green.
- Recall/prefix untouched — imports write to the store, not the prompt prefix.
- Opt-in + encrypted-at-rest + compartment routing all hold; cui isolation is respected.

-----

## ADR-0018 — Import enhancements: model extraction, Gemini, in-memory unzip (P9.8)

**Date:** 2026-06-20
**Status:** Accepted. Built this increment.
**Relationship:** extends the import path of ADR-0017 (P9.7). No new frozen-contract change
(reuses `personal_facts_imported`; richer payload fields only).

### Context

Three follow-ups to the chat-export importer, all chosen by the user: (1) optional model-based
extraction for richer facts + real relationships, (2) Google Gemini (Takeout) as a third vendor,
(3) import straight from the downloaded `.zip` instead of unzipping first.

### 1 — model-extractor import pass (opt-in)

The importer already takes a pluggable `extract` fn, so model mode is just
`modelExtractor(complete)` instead of `heuristicExtractor` — the entire gated pipeline (per-message
scan, provenance, store rules) is reused unchanged. The missing piece was a **standalone
completion seam**: the chat backend is a single stateful streaming session, and AskSage's API is
gov-key-only. **Decision: add `backend.complete(system, user)`** — a one-shot completion in a
THROWAWAY omp session that never touches the chat session, persona, or recall. It's serialized
through a `utilLock` so it can't race a chat turn's listener, ignores tool-call events (collects
only assistant text), and reuses whatever model the user already configured (no new keys). The
model only ever sees text that already passed the scanner gate; its output is still just
candidates the store governs.

Cost control: model mode is **capped at 500 user messages per import** (`MODEL_IMPORT_CAP`) and the
cap is **never silent** — `ImportSummary.skipped` reports the remainder and the UI says "re-run to
continue." Heuristic mode stays the free, unbounded default; an "AI" checkbox in the Knowledge
toolbar selects model mode.

### 2 — Gemini (Takeout "My Activity")

Google exports Gemini history as a flat `MyActivity.json` array of activity records
(`{header:"Gemini Apps", title:"Prompted …"}`) — only the user's prompts, which is exactly what we
distil from. `detectVendor` sniffs a Gemini/Bard `header`; `parseGemini` strips the leading prompt
verb and bundles the prompts into one synthetic conversation. `ImportVendor` gains `"gemini"`.

### 3 — in-memory unzip (no dependency)

**Decision: a minimal hand-rolled ZIP reader** (`harness/personal/unzip.ts`, pure `node:zlib`)
rather than a new dependency — consistent with the project's zero-dep / airgap posture. It walks
the central directory and inflates a single named entry (STORE + DEFLATE; no zip64/encryption,
which these exports don't use). `importChatExport` now accepts a folder, a `.json`, or a `.zip`,
and looks for `conversations.json` then `MyActivity.json` (then a lone `.json`).

### Guardrails preserved

- Fail-closed unchanged: every imported message is scanned before the model (or heuristic) ever
  sees it; the model can't pull facts from un-scanned text.
- `complete()` bypasses persona/recall and runs in an isolated session — no prompt-prefix impact.
- Cap is surfaced, never silent (no false "imported everything").

-----

## ADR-0019 — Scanner homoglyph precision + source-scoped gate + block observability

**Date:** 2026-06-20
**Status:** Accepted. Parts A, B, and C all built.
**Relationship:** refines keystone #1 (the Unicode scanner) and the quarantine gate (invariant #3/#4).
A deliberate, isolated fail-closed adjustment with its own ADR, as CLAUDE.md requires.

### Context

A user generating an image of a physics answer hit repeated false-positive blocks: the gate
quarantined the model's own `generate_image` content because it contained ordinary scientific
Unicode (`Δv`, `Σ`, `5μm`). Two distinct defects:
1. **Scanner over-flagged** — `mixed-script-homoglyph` fired on ANY Latin+Greek/Cyrillic token, so
   legitimate math notation (Greek letters with no Latin look-alike) was treated as a spoof.
2. **Blocks were invisible** — the chat showed 8 "Blocked …" chips, but the Security panel read
   0 quarantined / 0 findings (verified against `agent_obs.duckdb`), and the toast "Review" did
   nothing. Root cause: the gate runs in the omp CHILD process and only writes the block to stderr;
   its DuckDB persistence fails because the GUI server (a separate process) holds the single-writer
   DB. So nothing reaches the tables the panel reads, and "Review" opens an empty panel.

### Decision A — confusable-only homoglyph detection (scanner, keystone #1)

`_detect_homoglyphs` now flags a Greek/Cyrillic letter only when its codepoint is a genuine Latin
look-alike (`_LATIN_CONFUSABLE`: Α Β Ε … ο ν ρ; а е о р с …), not the whole Greek/Cyrillic block.
Non-confusable math/scientific letters (Δ Σ Π Λ Φ λ μ π θ) mixed with Latin pass clean. Real spoofs
(Cyrillic `а` in "pаypаl", Greek omicron in "lοgin") still fire — the existing adversarial fixtures
stay green, and new clean-corpus fixtures assert the physics case produces zero findings.

### Decision B — source-scoped gate (gate policy, invariant #3)

The gate scans the model's OWN tool args. A homoglyph-only hit there is not an injection against the
model, so it is **recorded-but-not-blocked**. New optional `GatePolicy.nonBlockingTypes` demotes
specified finding types: they stay in `findings` and keep the label **suspicious** (so keystone #2
still blocks promotion into memory), but don't quarantine on their own. The omp gate uses
`TOOL_POLICY = { blockAtOrAbove: "high", nonBlockingTypes: {mixed-script-homoglyph} }`. This is a
**bounded** relaxation: the never-legitimate vectors (zero-width, bidi-control, tag-block, PUA) still
hard-block; a dangerous finding ALONGSIDE a demoted one still blocks (type-scoped, not blanket); and
external/imported text — scanned on a different path with the strict `DEFAULT_POLICY` — is unchanged.
The fail-closed law is untouched: a missing/failed scan still blocks (gate.failclosed.test green).

### Decision C — block observability + review + approve (BUILT)

Block persistence moved to the GUI process — but NOT into `agent_obs.duckdb` (that's the same
single-writer file the gate's omp child can't reach; co-writing it from the GUI invites the same
contention). Instead a dedicated GUI-owned store, `desktop/security_log.ts`: an append-only JSONL
audit at `~/.omp/lucid-blocks.jsonl` + an in-memory view, metadata-only (tool/severity/findings/
reason, never raw content). The ACP client (`acp_backend.ts`, in the GUI process) calls `recordBlock`
on the gate's authoritative stderr `[BLOCKED …]` signal, and — importantly — the generic
`tool_call_update` rejection is **relabelled "tool call rejected" (not a security block)**, fixing
the mislabel that made ordinary tool failures look like quarantines. `/api/security` merges
`liveBlocks()` (so blocks show even when the DuckDB views are empty); the Security panel gains a
"Live blocks (this session)" accordion + the quarantined chip + rail badge count them; the
toast/chip "Review" opens it. `POST /api/security/approve` + an "Approve & retry" button release one
block (audited in the JSONL) and re-send the user's last message — the deliberate, bounded
fail-closed override. The gate itself is unchanged (still fail-closed); this only surfaces +
optionally overrides what it already did.

### Guardrails

- Fail-closed law intact; scanner clean-corpus still zero false-positives; adversarial spoofs still
  caught; keystone #2 (suspicious can't auto-promote) unaffected. harness 369 pass, scanner pytest green.

-----

## ADR-0020 — MCP Enterprise-Managed Auth Hub

**Date:** 2026-06-20
**Status:** Accepted as a roadmap — phased build **P-MCP.1–4** (see "Phases" below). New surface, not
a refinement. Review addendum added 2026-06-20 to align it with the harness invariants.
**Context increment:** planning only (no functional code this increment).

### Decision

We are building a centralized **MCP Server Connection Hub** into the IDE to automatically authenticate against enterprise MCP servers (such as internal tools or commercial SaaS) using the Zero-Touch, Identity-Provider-driven authorization model. 
This will support **Okta, Entra ID (Azure AD), and GCP Workload Identity Federation (WIF)** natively.

1. **Pop-out UI Behavior:** Advanced configurations will "pop out... into the main window" as a full-height overlay panel that slides over the main chat/workspace area when an MCP connector is clicked in the Settings sidebar. This gives maximum real estate for forms, logs, and token status without cluttering the narrow sidebar.
2. **Token Storage Security:** OAuth Access Tokens will be stored using an **OS-level secure credential vault interface** via Electron's `safeStorage`. **Seam:** `safeStorage` is an Electron **main-process** API, and our GUI server runs as a *separate* Bun process (ADR-0006) — so token seal/unseal must route through `main.ts` + preload (the exact custody seam ADR-0010 already uses), with a PBKDF2 passphrase fallback in the plain-Bun dev runtime. PQC note: ML-KEM is **already standardized** (FIPS 203, Aug 2024 — see ADR-0015); the real dependency is OS-vendor *keystore* adoption, so track it under ADR-0015 (crypto-agility) rather than as a fresh roadmap path here.
3. **OAuth Redirect URIs:** We will use an **Ephemeral Localhost Server with PKCE** for handling OAuth redirects, which adheres to IETF RFC 8252 (OAuth 2.0 for Native Apps) as the most secure and auditable standard for desktop applications. **Coordination:** we already run a localhost OAuth catcher (omp `auth-broker`, ~:1455). The MCP PKCE catcher MUST bind a *distinct ephemeral* port, validate `state`, and fully drain its child pipes + close on callback — the exact failure mode that previously took down provider OAuth (a wrapper that stopped draining stdout/stderr blocked the callback server).
4. **GCP WIF Profiles:** Because most enterprises front identity with **Entra ID or Okta** (with Yubikey / PIV as the *factors* behind it), we will configure GCP WIF to directly trust the Entra ID **OIDC provider**. The IDE performs the Entra ID flow and exchanges the resulting OIDC token directly with **GCP STS** (`token` endpoint) for a short-lived GCP access token, avoiding standalone Google credentials.
5. **Terraform Scope:** We will provide Terraform snippets to aid in configuring the Identity Provider side (Okta, Entra ID, GCP WIF pool), accompanied by README links to official docs for configuring the actual MCP server side. **Boundary:** `terraform/mcp_auth/` is **deployment IaC + docs only** — never on the build/test path, never imported by the harness, kept isolated like `scanner-sidecar/` so it does not widen the fixed TypeScript-+-one-Python language boundary (inv. #2).

### Why

Anthropic's Enterprise-Managed Auth demonstrated the power of zero-touch IdP integration for MCP. By managing auth centrally rather than requiring individual user API keys or personal access tokens, we maintain strong governance, auditability, and ease of use in enterprise deployments.

### Consequences

- A new `desktop/mcp_hub.ts` backend to handle the PKCE flows, localhost redirect catchers, and GCP STS exchanges.
- Electron's `safeStorage` dependency for token persistence.
- A new UI overlay system integrated into `desktop/renderer/app.ts` that interacts seamlessly with the existing `settingsShell()` (reusing the same slide-over pattern as Settings / Knowledge / the dev Logs view).
- A set of Terraform modules (`terraform/mcp_auth/`) included in the repo for deploying the required IdP configuration.

### Integration with the invariants (review addendum — 2026-06-20)

6. **Extend omp; never fork it (invariant #1) — the load-bearing decision.** omp ALREADY terminates
   MCP: `session/new` / `session/load` accept an `mcpServers[]` array (today `[]` in
   `acp_backend.ts:112/209`). The hub's job is **authentication + config assembly only** — it runs
   the IdP / PKCE / STS flows, obtains the token, and hands omp a fully-authenticated MCP server
   entry (URL + headers/token) through that `mcpServers` array on the next `session/new`. It does
   **not** implement MCP transport, tool discovery, or tool calling — omp owns that. So
   `desktop/mcp_hub.ts` is *auth + sealed storage + the omp-config seam*, nothing more. Re-implementing
   an MCP client would be a fork-shaped design and is out of scope.

**Security guardrails (load-bearing, not optional):**
- **Untrusted MCP output (invariant #5).** An MCP server is an untrusted source until scanned. Any
  tool result that re-enters the prompt passes the existing fail-closed gate (`scanAndDecide`,
  keystone #1) and is wrapped in `UNTRUSTED_CONTENT_START/END` after the cache breakpoint — exactly
  like imported/fetched text. Auth governs *access*; the gate still governs *content*.
- **Tokens never logged, never in the frozen prefix.** Access tokens live only in the sealed store +
  memory, are redacted from telemetry, and never touch prompt layers 1–4.
- **safeStorage only via Electron main** (Decision 2 seam); PBKDF2 passphrase fallback in dev.
- **Localhost catcher**: distinct ephemeral port, PKCE + `state`, drain-and-close on callback.

**Phases — one increment each (session ritual):**
- **P-MCP.1 — BUILT.** The omp `mcpServers` config seam (`mcpServersForAcp()` → `session/new`/
  `session/load`) + a manual (paste-a-token) MCP connector in a Settings "MCP connectors" card
  (list / add / enable-disable / remove; HTTP + SSE; bearer token → `Authorization` header).
  Tokens persist in the git-ignored `lucid-gui.json` (like provider keys) and the API only ever
  returns masked status (never the raw token); changes respawn omp so it re-reads `mcpServers`.
  EventName `mcp_server_connected` added to the enum. *Scoped:* the full slide-over overlay is
  deferred to P-MCP.2 (where the IdP forms/logs need the real estate); telemetry emission of the
  event awaits GUI-side telemetry persistence (the two-process-DuckDB gap).
- **P-MCP.2** — Generic-OIDC sign-in for an MCP connector (design spike below; **not yet built**).
  EventName `mcp_oauth_authorized` (+ `mcp_oauth_refresh_failed`, fail-closed).
- **P-MCP.3** — GCP WIF: exchange the Entra OIDC token with GCP STS for a short-lived GCP token.
- **P-MCP.4** — Terraform IaC modules + docs (deployment-only; no harness coupling).
Recommended first build: **P-MCP.1** (smallest surface; reuses the existing overlay + settings-key
storage pattern; proves the omp seam before any IdP work).

**Frozen-contract impacts:**
- New `EventName`s — `mcp_server_connected` (built), `mcp_oauth_authorized`, `mcp_oauth_refresh_failed`
  — each added in the increment that emits it (emitting an unknown name throws; inv. #8).
- **No DuckDB migration** (tokens live in the sealed safeStorage blob, not DuckDB).
- The MCP server registry persists in the git-ignored GUI settings file (`lucid-gui.json`, mode 0600)
  like provider keys — **never committed** (the standing keys-stay-out-of-git constraint).
- New deps: Electron `safeStorage` only (already implied by ADR-0010); Terraform is out-of-band
  tooling, not an npm/bun dependency.

### P-MCP.2 design spike (2026-06-20) — generic OIDC sign-in for MCP connectors

**Goal.** Replace the pasted bearer token (P-MCP.1) with one obtained from an enterprise OIDC IdP
via interactive sign-in, and upgrade custody from the 0600 `lucid-gui.json` field to OS-backed
`safeStorage`. The output is unchanged: the same `Authorization: Bearer <token>` header fed to omp
through `mcpServersForAcp()`. Only the token's *provenance and custody* change.

**Probe outcome (decisive) — omp's `auth-broker` cannot do this; we build our own catcher.**
`omp/16.0.8 auth-broker` is a **closed registry of ~50 LLM-inference providers** (anthropic,
openai-codex, google-gemini-cli, github-copilot, xai-oauth …). It authenticates you *to model
vendors*: `login` takes a provider id from that fixed list and has **no** `--issuer` / `--tenant` /
`--client-id` / `--scope` / `--redirect-uri` flag; there is no generic-OIDC/Entra/Okta entry.
`serve`/`token` expose omp's *own* broker bearer (so clients reach the broker) — not an IdP access
token for a downstream MCP server. So "just configure omp's broker" is closed. Building a capability
omp does not have, in our own TS, with the token still flowing through the existing `mcpServers`
seam, is **extend, not fork** (inv. #1) — this probe is the justification.

**Decisions locked this spike.** (1) **Generic OIDC only** — implement to spec via
`.well-known/openid-configuration` discovery; no vendor-specific code paths (Entra/Okta are just
issuer URLs). (2) **Fixed loopback redirect** `http://127.0.0.1:5319/api/mcp/oauth/callback` —
reuse the running dev server as the catcher (the launch already hard-binds 5319); admin registers
it once. PKCE S256, no client secret (RFC 8252 native-app flow), `state` verified.

**Flow.** renderer "Sign in" → `dev.ts` builds the authorize URL (PKCE challenge + state) →
Electron main `shell.openExternal` opens the *system* browser (never an in-app webview) → IdP 302s
to the fixed callback → `dev.ts` verifies `state`, exchanges `code`+verifier at `/token` →
`{access,refresh,expires_in}` → seal (below).

**safeStorage two-process seam (Option C).** `safeStorage` is Electron-main-only; the token is used
by the Bun dev server at `session/new`. They share no IPC today (only the stdout/stderr pipe). The
OAuth flow stays in Bun (it already owns the HTTP server + the `auth-broker login` callback
pattern); main becomes a **pure crypto oracle** exposing only `seal(blob)→ciphertext` /
`unseal(ciphertext)→blob`, gated by a **per-launch capability secret** that main injects into the
dev server's env (the `runtimeEnv` channel in `main.ts` already carries secrets down). Plaintext
never transits the renderer; the oracle never reveals provenance. (Rejected: A — renderer brokers
plaintext; B — a localhost decrypt endpoint, a broader oracle.)

**Refresh.** Lazy, at point-of-use: `mcpServersForAcp()` checks `expires_at` on assembly and, within
a skew window, refreshes via the sealed `refresh_token`, re-seals, then emits the header. No
background timer — matches the existing "respawn omp on change" model.

**Fail-closed.** A refresh or unseal failure **drops the connector** (no header emitted) — never
sends an empty/stale token that silently de-auths. `mcp_oauth_refresh_failed` records it. MCP tool
*output* is still scanned by the gate regardless of auth (auth ≠ trust).

**File-by-file (build path).** `desktop/oidc.ts` (new: PKCE, discovery, authorize-URL, code
exchange, refresh) · `desktop/dev.ts` (`/api/mcp/oauth/start` + `/api/mcp/oauth/callback`) ·
`desktop/main.ts`+`preload.ts` (`seal`/`unseal` ipc + launch secret) · `settings_store.ts`
(`McpServerEntry.auth?: {issuer, clientId, sealedTokens, expiresAt}`; the manual `token` path stays)
· `harness/contracts.ts` (**FROZEN** — `mcp_oauth_authorized` + `mcp_oauth_refresh_failed`, added in
the increment that emits each; inv. #8).

**Phasing (one increment each).**
- **P-MCP.2a** — the `safeStorage` seal/unseal seam (Option C) + re-custody the *existing manual*
  token into `safeStorage`. Lands the custody upgrade independent of OIDC.
- **P-MCP.2b** — OIDC discovery + PKCE authorize/callback + code exchange (the sign-in itself).
- **P-MCP.2c** — lazy refresh + fail-closed drop + the EventName/contract increment.

-----

## ADR-0021 — Right Rail UX: Memory Default, Security Triage, and Ledger Hierarchy

**Date:** 2026-06-20
**Status:** Built
**Context increment:** P11.2/UX

### Decision

We are refining the Right Rail (Inspector) default behavior, adding visual indicators for security alerts, and restructuring the Cost & Savings ledger.

1. **Default Tab:** The right rail Inspector will default to the **Memory** tab, surfacing context window, token spend, and cache hit-rates immediately. However, if the gate has quarantined content (fail-closed block), the Inspector overrides this to default to the **Security** tab to enforce triage.
2. **Visual Triage:** Security metrics requiring review will feature a CSS shimmer particle effect and a glowing pulse matching the severity color (`--red` or `--amber`) to instantly draw the eye to the blocked payload.
3. **Ledger Visibility:** The Cost & Savings ledger is restructured so the aggregate snapshot and the primary (highest-spend) model are permanently visible outside the accordion, while the remaining tail of models are hidden within the accordion.

### Why

The previous design hid the critical Cost & Savings snapshot inside a closed accordion and defaulted to the Security tab even when the user had no active threats. By defaulting to Memory, the user gets immediate token/cost feedback. By pulsing active threats, we ensure they don't miss quarantines. By pinning the aggregate snapshot outside the accordion, we maintain developer cost-awareness without vertical clutter.

### Integration with the invariants

4. **Fail-closed is law (invariant #3).** The visual triage only changes the *presentation* of the fail-closed gate blocks, not the gate itself. The quarantine mechanism and semantics are unaffected.
5. **No new dependencies.** The CSS pulse and shimmer effects are implemented via standard keyframe animations in `styles.css`. No external animation libraries are introduced.
6. **Extend omp; never fork it (invariant #1).** All changes are localized to the `desktop/renderer/app.ts` UI shell and CSS. No changes to the underlying `omp` or `scanner-sidecar` are required.

### Phases — one increment each (session ritual)

- **P11.2a/UX** — Implement the conditional default tab logic in `focusInspector()` and the conditional CSS class application for the `.pulse-glow` and `.shimmer-particle` animations in `securityHtml()`.
- **P11.2b/UX** — Refactor `ledgerBody()` to separate the snapshot card and the first model row from the `accordion()` wrapper, preserving the "Prompt-cache savings" layout below it.

-----

## ADR-0022 — Local control-plane hardening: loopback bind, origin/host gate, path containment

**Date:** 2026-06-21
**Status:** Built
**Context increment:** P11.3/SEC

### Context

CodeQL (`security-extended`, `.github/workflows/codeql.yml`) and a manual SAST pass
over the same sink classes surfaced that the desktop data plane is the shipped app's
real control plane, not just a dev convenience: `desktop/main.ts` spawns
`desktop/dev.ts` and the Electron window loads it over `http://localhost:5319`. That
server (and the read-only `tools/web/server.ts` dashboard) handled requests that set
provider API keys, unlock the encrypted personal/CUI stores with a passphrase, clone
repos, and browse the filesystem — with **no bind-address restriction, no
origin/CSRF check, and an unconstrained path** into the folder browser.

Three findings, by severity:

- **H1 — binds to all interfaces.** `Bun.serve` defaults to `0.0.0.0`; neither server
  passed `hostname`, so the secret-handling control plane was reachable from the LAN.
- **H2 — no origin/CSRF protection.** Handlers acted on `req.json()` with no `Origin`
  or `Host` check on a fixed, predictable port — so any web page the user visited (or a
  DNS-rebinding attack) could drive-by POST to clone repos, set keys, or brute-force
  the store passphrase.
- **M1 — path injection (`js/path-injection`).** `/api/fs/list` passed the request's
  `path` straight to `readdirSync`/`statSync`, an arbitrary directory-listing oracle.

### Decision

1. **Loopback bind (H1).** Both `Bun.serve` instances bind `hostname: "127.0.0.1"`.
   The Electron window already loads `http://localhost:PORT`, so loopback is the
   complete, correct surface; the LAN is removed entirely.
2. **A single front gate (H2).** `desktop/origin_guard.ts` — a pure, unit-tested
   `isAllowedRequest()` — runs before routing in both servers and 403s anything forged:
   - **Host allowlist** on *every* method (`localhost|127.0.0.1|[::1]:PORT`) — defeats
     DNS rebinding, where the socket is loopback but the `Host` is the attacker's domain.
   - **Origin allowlist** on state-changing methods — blocks drive-by cross-site POSTs
     (a null Origin is allowed for local non-browser tools; a browser attack always
     carries a non-null foreign Origin, and is already past the Host gate regardless).
   - **JSON content-type** on state-changing methods — blocks `<form>`/simple-request
     CSRF, which cannot set `application/json` without a preflight we never grant.
3. **Path containment (M1).** `desktop/path_guard.ts`'s `pathWithin()` canonicalizes
   the requested path (collapsing `../`) and confirms it stays inside the user's home
   subtree before `/api/fs/list` touches the FS; the returned `parent` is likewise
   clamped so the browser never offers a path above home. Separator-aware prefix
   matching avoids the `/home/user` vs `/home/user-evil` sibling-prefix bypass.

### Why

Defense in depth: loopback bind closes the LAN; the Host gate closes DNS rebinding;
the Origin + content-type gate closes drive-by CSRF from a page the user is browsing;
path containment turns the FS browser back into a folder picker. Each is independent,
so no single bypass re-opens the control plane.

### Integration with the invariants

- **Fail-closed is law (invariant #3).** The guard is allow-listed: an unrecognized
  Host/Origin or a missing JSON body is rejected, never waved through. The security
  gate, scanner, and quarantine semantics are untouched — this hardens the *transport*
  around them, not their logic.
- **Extend omp; never fork it (invariant #1).** All changes live in the GUI shell
  (`desktop/`, `tools/web/`). No omp or scanner-sidecar change.
- **The language boundary is fixed (invariant #2).** New code is TypeScript; no new
  Python surface.
- **No new dependencies.** Pure standard-library (`node:path`, WHATWG `URL`, `Headers`).

### Honest residual

- **Import / vault `dest` paths** (`/api/personal/import`, `/api/personal/vault`,
  `cui-archive`) still take an explicit user-supplied path. With H1+H2 the remote/CSRF
  vector is closed, so the residual is "the local user reads/writes their own chosen
  files" — the intended function. Tightening these to an allow-listed root is a
  candidate follow-up, not part of this increment.
- A **per-launch capability token** (minted in `main.ts`, required as a header) would
  add a fourth, transport-independent layer. Deferred: the Host + Origin + bind trio
  already defeats the realistic browser/LAN attacks without threading a secret through
  the renderer. Tracked as future hardening.

### Phases — one increment each (session ritual)

- **P11.3/SEC (this increment)** — `origin_guard.ts` + `path_guard.ts` (+ unit tests),
  loopback bind and the front gate wired into `desktop/dev.ts` and `tools/web/server.ts`,
  and the `/api/fs/list` containment. Verified live: legit GET 200; forged Host 403;
  cross-site JSON POST 403; `fs/list?path=/etc` returns home, not `/etc`.

-----

## ADR-0023 — GUI filesystem path containment: import sources & export destinations

**Date:** 2026-06-21
**Status:** Built
**Context increment:** P11.4/SEC

### Context

ADR-0022 closed the network/CSRF vectors on the local control plane (loopback bind,
Host/Origin gate) and confined the in-app folder browser (`/api/fs/list`) to the home
subtree (M1). It explicitly left one residual: the personalization endpoints still took
an unconstrained filesystem path —

- `/api/personal/import` → `importChatExport(path)` reads an arbitrary file/folder/zip;
- `/api/personal/vault` → `exportVault({ dest })` writes the Obsidian vault to an
  arbitrary directory;
- `/api/personal/cui-archive` → `exportCuiArchive({ dest })` writes the NARA-aligned CUI
  archive to an arbitrary directory.

`writeFiles()` already refused paths escaping the chosen `dest`, but the `dest` (and the
import source) themselves were unbounded — an arbitrary-read primitive on import and an
arbitrary-write location on export (CodeQL `js/path-injection`).

### Decision

Confine **every GUI-driven file path — import source and export destination — to the
user's home subtree**, the same boundary M1 already applies to the folder browser.

`desktop/personal.ts` gains `confineToHome(p)`, a one-liner over ADR-0022's
`pathWithin(homedir(), p)` (canonicalizes, collapses `../`, separator-aware prefix match
to avoid the `~user` vs `~user-evil` sibling bypass). It runs as **early input
validation** — before the personalization/store-unlocked guards — in `exportVault`,
`exportCuiArchive`, and `importChatExport`. An out-of-bounds path returns a plain
"…inside your home folder" error; an in-bounds path yields the canonical path used for
all subsequent FS work. Every default destination (`~/.omp/lucid-vault`,
`~/.omp/lucid-cui-archive`) already lives under home, so defaults are unaffected.

### Why

The home subtree is exactly what the in-app folder browser can navigate (M1) and where
every default already sits, so containment matches real usage while removing the
arbitrary read/write. Validating up front (before stateful guards) keeps the check in
one obvious place and makes it unit-testable without standing up an encrypted store.

### Integration with the invariants

- **Fail-closed is law (#3).** Allow-listed: a path that doesn't resolve inside home is
  rejected, never written to or read from. The scanner gate that imported messages still
  pass (keystone #2) is unchanged — this adds a path boundary *before* it.
- **Extend omp; never fork (#1) / language boundary (#2).** TypeScript only, all in
  `desktop/`. Reuses the ADR-0022 `path_guard.ts` helper; no new dependency.
- **Frozen contracts.** No contract, schema, or prompt-prefix change.

### Honest residual

- **External drives / paths outside home** (e.g. exporting a vault to a mounted backup
  volume) are now rejected. This is the deliberate tradeoff; a future increment can add an
  explicit, user-confirmed allow-list entry for a chosen external root rather than
  widening the default boundary.
- `setWorkspace`/`cloneRepo` already write under `~/.omp/lucid-workspaces`; tightening the
  local-folder `setWorkspace` path is a small follow-up, not bundled here.
- The per-launch capability token (ADR-0022's deferred 4th layer) remains future work;
  the chosen design is server-minted + HTML-injected so it covers both the Electron and
  the plain-browser dev runtimes.

### Phases — one increment each (session ritual)

- **P11.4/SEC (this increment)** — `confineToHome()` + early-validation wiring in
  `exportVault` / `exportCuiArchive` / `importChatExport`, with `desktop/personal_paths.test.ts`
  (7 tests: outside-home rejected with the home-folder message, inside-home passes
  containment, traversal-escape rejected).

-----

## ADR-0024 — Per-launch capability token: a transport-independent gate on the local control plane

**Date:** 2026-06-21
**Status:** Built
**Context increment:** P11.5/SEC

### Context

ADR-0022 hardened the desktop control plane (`desktop/dev.ts`, spawned by `main.ts` and loaded by
the Electron window over `http://localhost:PORT`) with three network-shaped layers: a loopback bind,
a Host allowlist (DNS-rebind defense), and an Origin + JSON-content-type gate (CSRF defense). Those
defeat the realistic browser/LAN attacks, but every one keys off request *headers* the browser
populates — so they share a failure mode: a future gap in that header logic, or any local process
that can forge a same-origin-looking request, would be through. ADR-0022 explicitly deferred a 4th,
*transport-independent* layer that doesn't rely on header heuristics.

### Decision

Mint a **per-launch capability token** and require it on the sensitive API surface.

1. **Mint.** `dev.ts` generates `randomBytes(32).toString("hex")` once per process. A fresh value
   each launch means a captured token never outlives the server that issued it.
2. **Deliver.** When serving `index.html`, the server injects `<meta name="lucid-token" content="…">`
   into `<head>`. The same-origin policy prevents a cross-origin page from reading this response
   body, so only the genuine renderer — which actually loaded our HTML — learns the token.
3. **Echo.** `bridge.ts` reads the meta once at load and sends it as `x-lucid-token` on every
   `/api` call (the two fetch wrappers plus the chat-stream and sessions fetches).
4. **Verify.** After the ADR-0022 Host/Origin gate, `dev.ts` requires `tokenValid(header, TOKEN)`
   on `p.startsWith("/api/")`. `tokenValid` (in `origin_guard.ts`) is a pure, constant-time-ish
   compare that fails closed on an empty/missing/wrong token.

**Exemptions:** `/api/health` (polled by `main.ts` *before* the page — and thus the token — exists;
returns no data) and all non-`/api` paths (HTML, `/app.js`, CSS, fonts — loaded before any JS could
carry a token, and free of secrets).

### Why this design (server-minted + HTML-injected)

It covers **both** runtimes with no `main.ts` change: the Electron window and the plain-browser dev
workflow (`bun run desktop:web`) both load the injected HTML and get a working token. A
`main.ts`-minted/env-passed token would have to be threaded into the renderer separately and would
break the browser-only dev/screenshot path. The token is a *defense-in-depth* layer, not the only
one — it sits behind the loopback bind and the Host/Origin gate, so a single bypass of any one layer
doesn't re-open the plane.

### Integration with the invariants

- **Fail-closed is law (#3).** `tokenValid` returns false for an empty configured token, a missing
  header, or any mismatch — never waves through. Health/asset exemptions carry no secrets and mutate
  nothing.
- **Extend omp; never fork (#1) / language boundary (#2).** TypeScript only, confined to `desktop/`.
- **Prompt prefix / frozen contracts.** Untouched — this is transport, not prompt or schema.
- **No new dependencies.** `node:crypto` (stdlib) for the mint; a `<meta>` tag for delivery.

### Honest residual

- **`tools/web/server.ts`** (the separate read-only dashboard on its own port) keeps only the
  ADR-0022 Host/Origin gate — it serves no `bridge.ts`/`app.js` to carry a token and exposes only
  read-only snapshots (no keys, passphrases, clone, or FS). Adding a token there is a low-value
  follow-up, not bundled.
- The token lives in the DOM of a trusted, same-origin page; a successful **XSS in the renderer**
  could read it. That is already a full compromise of the renderer (the markdown path is
  DOMPurify-sanitized, ADR-0016), so the token doesn't widen that blast radius — but it does mean
  the token defends the *network/CSRF* boundary, not an in-page script-injection one.

### Phases — one increment each (session ritual)

- **P11.5/SEC (this increment)** — `tokenValid` + tests in `origin_guard.ts`; mint/inject/verify in
  `dev.ts`; `x-lucid-token` on every `bridge.ts` fetch. Verified live: HTML carries the meta token;
  `/api/usage` and `/api/personal/unlock` 403 without it / 200 with it (the latter even with a valid
  Origin, proving independence); `/api/health` and static assets need none.

-----

## ADR-0025 — TOCTOU-safe import reader: read-and-handle, not stat-then-read

**Date:** 2026-06-21
**Status:** Built
**Context increment:** P11.6/SEC

### Context

CodeQL alert #15 (`js/file-system-race`, High) flagged `desktop/personal.ts`'s `loadExportText`.
It resolved a chat-export path by **checking then using**: `statSync(raw)` to branch on file vs
directory, then a *separate* `readFileSync(raw)`. Between the stat and the read the path can be
swapped (e.g. a symlink flip), so the bytes read need not be the bytes that were stat'd — a
time-of-check/time-of-use race. The directory branch had the same shape: `existsSync(join(dir,c))`
then `readFileSync(join(dir,c))` per candidate.

### Decision

Replace check-then-use with **use-and-handle**: perform the filesystem operation directly and let its
error classify the path. `loadExportText` now reads `raw` straight away; an `EISDIR` error means it
is a directory (fall through to the folder logic), `ENOENT` means it is gone. The directory branch
reads the listing **once** with `readdirSync` and selects from the returned names (`names.includes`)
instead of a per-file `existsSync` probe. No stat/exists precedes a read of the same path, so there
is no check/use window. `statSync`/`existsSync` are dropped from the module's `node:fs` imports.

Behavior and user-facing errors are preserved (missing → "That path doesn't exist."; unreadable file
→ "Couldn't read that file."; unreadable/empty folder → the folder guidance). An ambiguous folder
(multiple unnamed `.json`) is still rejected rather than guessed.

### Why

`use-and-handle` is the standard `js/file-system-race` remediation: collapsing the check and the use
into one operation removes the swap window entirely, and is also fewer syscalls. The path is already
confined to the home subtree (ADR-0023) and scanned fail-closed on import (keystone #2); this closes
the remaining race on top of those.

### Integration with the invariants

- **Fail-closed is law (#3).** Every read is wrapped; any error yields a typed `{ ok:false }` with a
  user-facing message — never an unguarded throw or a silent pass. The import scanner gate downstream
  is unchanged.
- **Extend omp; never fork (#1) / language boundary (#2).** TypeScript only, confined to `desktop/`.
- **No new dependencies / frozen contracts untouched.** Pure `node:fs` refactor.

### Honest residual

- `loadExportText` is now `export`ed solely so the FS branching is unit-testable directly
  (`desktop/export_loader.test.ts`); it remains an internal helper with no new caller.
- A swap to a *different regular file* between `readdirSync` and the subsequent `readFileSync(join(dir,
  name))` is still theoretically possible, but there is no longer a type-check being relied upon — the
  read either succeeds on whatever is there or fails closed, which is the property CodeQL requires.

### Phases — one increment each (session ritual)

- **P11.6/SEC (this increment)** — rewrite `loadExportText` to read-and-handle (EISDIR/ENOENT branch),
  read the directory listing once, drop `statSync`/`existsSync`, and add `desktop/export_loader.test.ts`
  (6 tests: file, dir-with-conversations.json, lone-json, missing→ENOENT, empty folder, ambiguous folder).

-----

## ADR-0026 — CodeQL alert sweep: stack-trace exposure, FS-race, store perms, dashboard attr escaping

**Date:** 2026-06-21
**Status:** Built
**Context increment:** P11.7/SEC

### Context

A pass over the open CodeQL code-scanning alerts on `master` (15 total) resolved into three buckets.
Two High alerts (#14/#15, `js/file-system-race` in `personal.ts`) were already fixed by ADR-0025
(#41) and auto-close on the next scan. Eight Medium alerts (#7–#12, #16, #17, "File data in outbound
network request" in `asksage.ts` and `ratelimit_probe.ts`) are **by design** — the data is the user's
API key flowing to its *own* configured provider endpoint (`api.anthropic.com`, `api.openai.com`, or
the user-set AskSage gateway); the key must reach the provider to authenticate, and the destinations
are not attacker-controlled. Those are dispositioned as dismiss-as-intended on the Security tab, not a
code change. This ADR covers the **five remaining real findings**.

### Decision

1. **Stack-trace exposure (#3 `desktop/dev.ts`, #4 `tools/web/server.ts`, `js/stack-trace-exposure`).**
   Both Bun servers caught `err` and returned `String(err)` to the client. Now the catch logs the
   detail server-side (`console.error`) and returns a generic `{ ok:false, error:"internal error" }`,
   so an internal error/stack never reaches the renderer or a forged caller.
2. **File-system race (#5 `harness/memory/state.ts`, `js/file-system-race`).** Seeding state headers
   was `if (!existsSync(p)) writeFileSync(p, …)` — a check/use gap. Now a single
   `writeFileSync(p, …, { flag: "wx" })` (create-or-fail) wrapped to swallow `EEXIST`: atomic, an
   existing file is preserved, no TOCTOU. `existsSync` dropped from the imports.
3. **Insecure temporary file (#6 `harness/personal/store.ts`, `js/insecure-temporary-file`).** The
   encrypted store was `writeFileSync(path, …)` then `chmodSync(0o600)` — a window where the blob is
   the default 0644. Now it is created owner-only at write time via `{ mode: 0o600 }`; the `chmod`
   stays to tighten an already-existing file on overwrite.
4. **Incomplete HTML-attribute sanitization (#1 `tools/web/index.html`,
   `js/incomplete-html-attribute-sanitization`).** The dashboard's `esc()` escaped only `& < >`, but
   its output lands inside double-quoted attributes (`class="pill ${esc(k)}"`), so a `"` could break
   out — attribute-injection XSS. `esc()` now also escapes `"`→`&quot;` and `'`→`&#39;`, matching the
   desktop renderer's `esc` (which already did and was therefore not flagged).

### Why

Each is the standard remediation for its rule: generic client errors + server-side logging for
information exposure; atomic `wx` create for the FS race; mode-at-creation for the perms window; and
quote-escaping for attribute-context output. All are pure hardening with behavior preserved (state
files still seed once and survive reopen; the store still round-trips; the dashboard renders the same
content, just correctly escaped).

### Integration with the invariants

- **Fail-closed is law (#3).** The error handlers still return a typed `{ ok:false }`; the FS-race
  and perms fixes only *narrow* what can go wrong. No path now treats an error as success.
- **Extend omp; never fork (#1) / language boundary (#2).** TypeScript/HTML only, in existing files.
- **Frozen contracts / no new dependencies.** Pure `node:fs`/string changes; the store envelope format
  and the prompt prefix are untouched.

### Honest disposition of the by-design alerts

The eight "File data in outbound network request" alerts are intentional credential transmission to a
configured provider; dismissing them as "won't fix (by design)" on the Security tab is the correct
disposition (chosen this session). They are recorded here so a future reader doesn't re-litigate them.

### Phases — one increment each (session ritual)

- **P11.7/SEC (this increment)** — the five fixes above + tests: a store-perms assertion
  (`personal.test.ts`, 0600) and reliance on the existing `state.test.ts` reopen/no-clobber coverage.
  Verified live: a forced handler error returns `{ok:false,error:"internal error"}` with the real
  `SyntaxError` only in the server log.

## ADR-0027 — ACP edit modes (Plan / Ask / Agent) + live thought streaming

**Date:** 2026-06-21
**Status:** **Built** — P-ACP.1 (thought streaming) + P-ACP.2 (Plan/Agent) + P-ACP.3 (Ask mode)
**Context increment:** P-ACP.1 / P-ACP.2 / P-ACP.3 (one increment each, below)

### Context

Two complaints about the GUI chat surface, both rooted in the same place — the ACP
session/update → ChatEvent mapping in `desktop/acp_backend.ts` only handles a subset of
omp's stream:

1. **Streaming "dumps" the reply.** It does *not*, at the omp level. A live probe of the
   installed `omp acp` (v16.0.8, gate loaded) shows omp streams the answer as multiple
   `agent_message_chunk`s, and with `thinking` on it streams several `agent_thought_chunk`s
   *first*. Measured turn (`thinking=high`, "think step by step…"):
   `THOUGHT #1 @8607ms`, `#2 @8854ms`, `#3 @8962ms`, then `msg_chunk #1 @8972ms`,
   `#2 @8972ms`. `acp_backend.ts` has **no case for `agent_thought_chunk`**, so the entire
   ~6s reasoning phase produces no UI events — the HUD sits on "Warming up…" — and then the
   answer arrives in a fast burst. That burst *reads* as a dump. The omp TUI shows the
   thinking block live (`--hide-thinking` exists precisely to suppress it), which is why the
   CLI feels different. **Fix: surface the thought chunks.**

2. **No edit-mode choice.** Claude Code lets the user pick Plan / Ask / Agent. omp's ACP
   exposes modes natively: `session/new` returns
   `modes: { availableModes: [{id:"default"…},{id:"plan", description:"Read-only planning
   mode that drafts a plan to a markdown file before any code changes"}], currentModeId }`,
   switchable with `session/set_mode` and echoed back via the `current_mode_update`
   notification. The GUI reads **neither** `sess.modes` nor sends `set_mode`; and
   `onRequest` auto-approves every `session/request_permission` — so today the app is
   permanently in an "Agent / yolo" posture. There is **no native "ask" mode** in omp;
   "Ask" is `default` mode + actually *forwarding* the permission request to the user.

### Decision

**1. Thought streaming (P-ACP.1).**
   - Extend the `ChatEvent` union (in `acp_backend.ts` and the renderer's `bridge.ts` copy)
     with `{ type: "thinking"; text: string }`.
   - `acp_backend.ts`: add `case "agent_thought_chunk": if (u.content?.type === "text")
     this.emit({ type: "thinking", text: u.content.text });`.
   - `app.ts` `onEvent`: on the first `thinking` event create a lazy, collapsible reasoning
     block above the answer; append streamed text live; set the HUD phase to "Thinking…".
     Collapse it to a one-line summary ("Thought for Ns") when the first answer token or
     `done` arrives — same pattern as the existing `createThoughts()` tool-activity window,
     but a distinct surface (reasoning ≠ tool steps).
   - Thinking text is **display-only**. It is omp-generated, never re-enters a prompt, and is
     **never** persisted into semantic memory (it is reasoning, not an artifact) — keystone
     #2 and the personalization distiller (`learnFromTurn`) consume only the assistant answer
     buffer, which stays separate from the thinking buffer.

**2. Mode selector — Plan / Agent (P-ACP.2).**
   - `ensureSession()` reads `sess.modes` (availableModes + currentModeId) and stores it;
     expose via a new `/api/modes` (GET current + list) and a `setMode` on the backend that
     calls `session/set_mode`. Handle the `current_mode_update` notification to keep the UI in
     sync if omp changes mode itself (e.g. Plan auto-exits after a plan is drafted).
   - UI mapping of the tri-state control:
     - **Plan** → ACP mode `plan` (omp's read-only planner; drafts a plan markdown, no edits).
     - **Agent** → ACP mode `default` + keep the auto-approve `onRequest` (fully autonomous).
   - A prominent segmented control in the composer (the model/mode/thinking picker already
     exists at `app.ts:1947+`; "mode" is also already an omp `configOption`, but `set_mode`
     is the canonical ACP path and is what emits `current_mode_update`). Selection persists
     per session.

**3. Ask mode — interactive approval round-trip (P-ACP.3, the hard part).**
   - **Ask** → ACP mode `default`, but `onRequest("session/request_permission")` no longer
     auto-selects. Instead the backend emits a `{ type: "permission"; id; tool; options }`
     ChatEvent down the open `/api/chat` NDJSON stream, parks the JSON-RPC response in a
     pending map, and the renderer shows an inline approve/deny prompt. The user's choice is
     POSTed to a new `/api/chat/permission { id, optionId }`, which resolves the parked
     promise so omp proceeds.
   - **Fail-closed (invariant #3):** if the user navigates away, the stream closes, or a
     bounded timeout elapses with no decision, the parked request resolves to
     `{ outcome: { outcome: "cancelled" } }` — **deny**, never allow.

### Why

The whole problem is an incomplete event map, not a transport defect — every layer
(`omp acp` → `ACPClient` → backend listener → dev.ts NDJSON → `bridge.streamChat` →
`app.ts`) already flushes per-event. Surfacing `agent_thought_chunk` makes the turn *feel*
streamed because the long pole (reasoning) becomes visible. Using omp's native modes +
permission requests means we adopt Claude-Code-style Plan/Ask/Agent **without forking omp**
(invariant #1) — the mechanisms already ship in the protocol.

### Integration with the invariants

- **Fail-closed is law (#3).** Ask-mode default on timeout/stream-close is *deny*. The
  security gate pre-hook still runs in **every** mode — mode is a UX/approval layer, not a
  security bypass. Plan mode is additionally read-only, which only narrows risk.
- **Quarantine gate in-process (#4).** Unchanged; the gate fires before any tool runs
  regardless of selected mode.
- **Untrusted content delimited + late (#5).** Thinking text is model output, display-only,
  and is not injected into any prompt or the frozen prefix.
- **Frozen prefix byte-stable (#6).** Modes and thinking touch neither prefix nor cache
  breakpoint; the prefix-hash test is unaffected.
- **Events use exact names (#8).** If we log mode changes or permission decisions, that needs
  new `EventName` enum values — a frozen-contract change, so it is its **own** sub-increment
  with an ADR, not a side effect of P-ACP.2/3.

### Phases — one increment each (session ritual)

- **P-ACP.1** — thought streaming. `ChatEvent.thinking` + backend case + bridge copy +
  `app.ts` reasoning block. Demo: a `thinking=high` turn shows reasoning text streaming
  before the answer (verified in the browser preview). Smallest, highest-value, lowest-risk —
  **the recommended first build.**
- **P-ACP.2** — Plan/Agent selector via `session/set_mode` + `current_mode_update`; segmented
  UI control; `/api/modes`.
- **P-ACP.3** — Ask mode: the bidirectional permission round-trip (`{type:"permission"}`
  event + `/api/chat/permission` + parked-promise resolution), fail-closed on no-decision.
- **P-ACP.4** — Stop button + prompt pre-staging. **— Built 2026-06-21.** (1) **Stop:** while a turn
  runs, the composer Send button becomes a red Stop control. Clicking it calls a new
  `/api/chat/cancel` → `backend.cancel()` → the ACP **`session/cancel` notification** (new
  `ACPClient.notify()` for id-less JSON-RPC). omp aborts the streaming reply AND in-flight tool calls
  and returns the pending `session/prompt`, so the turn's `done` fires and the UI settles. Verified
  live: interrupt lands in ~155ms and the reply stops growing (`grewAfterStop: 0`). (2) **Pre-staging:**
  typing + Enter while a turn is running no longer drops the input — it's queued (one slot; a newer
  entry replaces it) and shown in a "Queued · sends when this turn ends" chip with a cancel ✕. When the
  turn ends (naturally OR via Stop), the queued prompt auto-sends. Renderer state `state.queued` +
  `renderQueued()`; auto-send in `send()`'s `finally`. NO contract/schema change. **Build wrinkle
  found + fixed in verification:** the dev *server process* must be restarted to pick up `dev.ts`/
  `acp_backend.ts` changes (page reload only refreshes the renderer bundle); an early test hit a stale
  404 and looked like cancel was ignored.

### Open items to confirm at build time

- Exact `set_mode` request/response shape and whether `plan` auto-reverts to `default` after
  the plan file is written (drives the `current_mode_update` handling).
- Whether omp emits `agent_thought_chunk` with `content.type:"text"` for every provider, or
  only thinking-capable models (the probe used Anthropic Opus 4.8).

## ADR-0028 — Proactive subagent delegation via omp's Task tool (context- and cache-efficient)

**Date:** 2026-06-21
**Status:** **Built** — P-TASK.1 + P-TASK.2 + P-TASK.3 + P-TASK.4 (full ADR shipped) + isolation enablement

> **Isolation enablement (follow-up, built):** P-TASK.3 recorded a sandbox PROFILE but omp owned the
> actual execution (subagents ran trusted-local in the shared cwd). Now the `omp acp` server is
> launched with a `--config harness/omp/acp_config.yml` overlay setting `task.isolation.mode: auto`
> (merge: patch), which makes omp's per-spawn `isolated` option available + advertised; the PAL picks
> the platform backend (APFS/Btrfs/ZFS/reflink/overlayfs/ProjFS/block-clone) and falls back to rcopy
> on Windows. The frozen delegation policy (PREFIX_VERSION 2→3) now steers the model to spawn
> write/exec subtasks ISOLATED (changes captured as a reviewable patch; blast radius contained);
> read-only research subtasks skip it. omp has no global "force every spawn isolated" flag, so this is
> enable-the-mode + steer-the-model (invariant #1: extend, don't fork), not a hard guarantee — and
> isolated spawns require a git workspace. Verified: omp acp loads the overlay cleanly (handshake);
> prefix-hash green at v3. A full isolated patch-merge run wasn't exercised here (rcopy of this repo +
> node_modules is slow) — it's enabled and steered; best verified in a real git workspace in use.
**Context increment:** P-TASK.1 … P-TASK.4 (one increment each, below)

> **P-TASK.4 delta (result gating, as built):** a subagent's returned text re-enters via TWO seams,
> both now gated by keystone #2: (a) the subagent's own `yield`/tool calls run in the same omp process
> and already hit the gate's `tool_call` handler (confirmed live — artifacts `omp:yield`, `omp:read`
> appear under the live run); (b) the parent receives the assembled `<task-result …>` in a
> `tool_result`, which a new `tool_result` hook routes through `gateSubagentResult` →
> `ingestArtifact` (scan + trust-label) → `promoteFactGated` (suspicious/quarantined ⇒ never promoted).
> Verified live: a real explore result was ingested as a `subagent:explore` artifact; unit tests prove
> a clean result promotes and a hidden-Unicode result is quarantined with zero facts written. Two new
> `EventName`s added (`subagent_dispatched`, `subagent_result_gated`) — the only frozen-contract change.

> **Delivery-mechanism delta (P-TASK.2, discovered + resolved):** the `FROZEN_PREFIX` assembler
> (`harness/prompt/assembler.ts`) is NOT wired into the live ACP chat — `acp_backend.ts` spawns
> `omp acp` and omp owns its own system prompt there; `security_extension.ts` only hooks `tool_call`
> and injects no prompt. So putting the delegation policy in layer 3 alone would not reach the chat
> model. Resolution: the policy lives in layer 3 as the canonical, prefix-hash-covered source AND is
> exported as `DELEGATION_POLICY` and delivered to the live model via `omp acp
> --append-system-prompt <DELEGATION_POLICY>` (verified: omp 16.0.8 accepts the flag and the model
> receives the text). It is byte-stable with zero volatile content, so it sits in omp's cached
> system-prompt prefix — invariant #6 is honored. `PREFIX_VERSION` bumped 1→2 for the layer-3 change.

### Context

The ask: make the orchestrator delegate to subagents **proactively** when a significant
multi-file change (or a bounded research/triage/summarization subtask) is needed — the way
Claude Code reaches for its Task tool when a job is too large for the main loop, to protect
the orchestrator's **context window** and its **prompt-prefix KV cache** from absorbing all
the intermediate file reads and tool output.

What already exists (P5.1 / P5.2 — the run-tree *data layer*):
- `harness/runs/lineage.ts` — `startRun()`, `spawnSubagent()` (child inherits parent's
  `session_id`, sets `kind`/`mode`/`sandbox_profile`), `getRunTree()`, `getLineage()`. Schema
  `runs(run_id, parent_run_id, session_id, kind, mode, sandbox_profile, status, …)`.
- `harness/runs/security_review.ts` — `spawnSecurityReview()`, a read-only-**only** subagent.
- `harness/runs/profiles.ts` — `chooseProfile()` auto-downgrades by causal-chain trust
  (suspicious→`container-local`, quarantined→`quarantine`).
- `harness/runs/remote_gate.ts` — `dispatchRemoteRun()` scans a payload **before** dispatch
  and can route suspicious work to the review subagent.
- `harness/omp/security_extension.ts` — the pre-hook scans every `tool_call`'s strings and
  blocks fail-closed; a `task(...)` call's assignment/context strings are therefore *already*
  scanned, but with no Task-specific policy.

What is **missing** (the gap this ADR fills):
- No agent-side logic that *decides to delegate*. The harness only reacts (gate, remote gate).
- No surfacing/encouragement of omp's native **Task tool** through the ACP session, and no
  Task-aware UI — a `task` call renders as a generic tool chip (`acp_backend.ts` `tool_call`).
- No explicit **pre-dispatch gate** binding a Task call to a child run + profile.
- No **result gate**: a subagent's returned text can re-enter the orchestrator's memory
  without a scan / promotion check.

omp ships the delegation engine natively (the `task`/`agent` tools: single or batch
assignments, optional `schema`-validated returns, async/background jobs, and worktree/ProjFS
isolation). Per invariant #1 we **steer and wrap** that engine; we do not reimplement it.

> Build-time prerequisite (CLAUDE.md "known wrinkles"): the Task-tool surface below is read
> from omp's docs + the captured ACP wire format. The **first task of P-TASK.1 is to confirm
> the real `task` tool name, its ACP `tool_call` shape, and how sub-tool-calls inside a
> subagent surface**, against the installed omp, and ADR any deltas.

> **Confirmed wire shape (P-TASK.1, omp 16.0.8, live ACP probe):** the tool is `task`. A spawn does
> NOT arrive with `kind:"task"` — it arrives as `tool_call` with `kind:"other"` and a human `title`
> (e.g. "Spawning explore subagent…"), the real signal being `rawInput` = `{ agent, context,
> tasks:[{assignment, description}] }` (batch) or `{ agent, assignment }` (flat). So detection is
> rawInput-shape-based, not `kind`-based. omp runs subagents as **background jobs by default**, so the
> model then issues repeated `tool_call`s with `rawInput.poll:[<id>]` (also `kind:"other"`) until the
> job settles; the final poll's `content` carries a `<task-result …>` block. Sub-tool-calls *inside*
> the subagent do NOT surface on the parent ACP stream — only the spawn + the parent's poll calls do
> (the subagent's own omp child runs them, gated in-process by the same extension). Bundled agents:
> `explore, plan, designer, reviewer, task, quick_task, librarian, oracle`. P-TASK.1 surfaces the
> spawn as a `subagent` card and **suppresses** the poll/list/cancel/wait coordination calls as noise.

### Decision

**1. Delegation is omp-native, *steered by the frozen prompt*, never a fork (invariant #1).**
   The "when to delegate" policy lives in **prompt layer 3 (stable coding rules)** so it is
   byte-stable and stays inside the cached prefix (invariant #6). It instructs the model to
   hand off to a subagent when a task (a) will touch more than a small number of files,
   (b) is an isolable research/triage/summarization unit, or (c) is a bounded refactor — and
   to pass a **crisp assignment + minimal context**, then consume only the subagent's
   distilled result.

**2. Token / cache efficiency is the point, and it is mechanical, not magical.**
   - The subagent runs in **its own context window** (its own omp session/cache). The
     orchestrator pays only for the short assignment it sends and the compact result it gets
     back — not the subagent's file reads, diffs, and tool chatter.
   - Because the orchestrator's context stays small, its **frozen prefix stays cache-hot**:
     fewer tokens after the cache breakpoint ⇒ fewer cache busts ⇒ the savings the usage
     ledger already measures (`cacheHitRate`/`savings`) go *up*. This is a direct synergy with
     invariant #6, not a new caching mechanism.
   - Prefer **`schema`-validated returns** so a subagent yields a small structured object, not
     a wall of prose, keeping the re-entry cost (and the result-scan surface) minimal.

**3. Gate the assignment (pre-dispatch).** Make the existing pre-hook Task-aware: a `task`
   call's assignment + shared context are scanned with a Task policy *before* any subagent
   spawns; a suspicious/quarantined assignment is **blocked** (fail-closed) or **routed to the
   read-only security-review subagent**, reusing the `remote_gate.ts` dispatch pattern.

**4. Bind the dispatch to lineage.** On dispatch, `spawnSubagent()` mints a child run
   (`parent_run_id` = current run, inherits `session_id`, `kind:"task"`, `mode:"subagent"`)
   with a sandbox profile from `chooseProfile()` keyed to the assignment's trust. The
   subagent's own omp runtime loads the **same** `security_extension`, so its tool calls are
   gated **in-process** (invariant #4).

**5. Gate the result (promotion).** Before a subagent's returned text re-enters the
   orchestrator's memory or next prompt, it is scanned + trust-labelled; a suspicious result
   **never auto-promotes** into semantic memory (keystone #2 / `promotion_gate.ts`). This
   closes the open gap.

**6. Surface it in the UI.** Add a Task-aware `ChatEvent`
   (`{ type:"subagent"; phase:"spawn"|"progress"|"done"; id; assignment; result? }`) so the
   GUI shows a nested subagent activity card (Claude-Code-style Task chip with its own
   spinner/summary), distinct from the thinking surface (ADR-0027) and the tool-activity
   window.

### Why

This gives the user the seamless "it just spun up helpers for the big job" experience while
keeping LucidAgentIDE's whole reason for existing intact: **every** assignment and **every**
result crosses the fail-closed scanner, and **every** subagent is a first-class node in the
run lineage with a trust-appropriate sandbox. We get Claude-Code-grade delegation by wrapping
omp's engine, not by building our own.

### Integration with the invariants

- **Extend omp; never fork (#1).** Native `task`/`agent` tools + the existing pre-hook +
  lineage helpers. If sub-tool-calls inside a subagent cannot be gated by the in-process
  pre-hook, **STOP and ADR before any fork** — do not work around it.
- **Fail-closed (#3).** Assignment scan failure, missing scan id, or result scan failure ⇒
  block / quarantine; never dispatch, never promote.
- **Gate in-process (#4).** The subagent's omp child loads the same extension; its calls are
  blocked in-process, not over a network seam.
- **Untrusted content delimited + late (#5).** Retrieved/imported text that becomes an
  assignment stays delimited + scanned; a subagent result is treated as untrusted until
  scanned.
- **Frozen prefix byte-stable (#6).** The delegation policy goes in the **stable** layer 3;
  the prefix-hash test must stay green. Per-task volatile context rides the tail only.
- **Trust labels closed set (#7) / Stable IDs (#9).** Each dispatch + result reuses the
  child `run_id`; results carry one of the four labels, nothing new.
- **Events exact names (#8) / DuckDB freezes (#10).** New event names
  (e.g. `subagent_dispatched`, `subagent_result_gated`) are a **frozen-contract** change →
  their own sub-increment + ADR; any new lineage column is a numbered migration, never an
  in-place edit.

### Phases — one increment each (session ritual)

- **P-TASK.1** — confirm omp's real Task-tool/ACP shape; enable + surface it through the ACP
  session; add the `subagent` `ChatEvent` + UI subagent card. Demo: a multi-file ask spawns a
  *visible* subagent. (No new gating beyond the pre-hook yet.)
- **P-TASK.2** — the proactive delegation policy in the frozen layer-3 rules + a token-
  efficiency check (orchestrator context stays small; prefix-hash still green; ledger shows
  the cache stays hot across a delegated turn).
- **P-TASK.3** — explicit Task pre-dispatch gating + lineage binding (child run via
  `spawnSubagent`, profile downgrade, suspicious→security-review).
- **P-TASK.4** — result-promotion gating (keystone #2) + the `EventName` additions
  (frozen-contract sub-increment) + the DuckDB lineage rows.

### Relationship to ADR-0027

Independent but complementary: ADR-0027 makes a *single* turn legible (thinking streams,
modes are selectable); ADR-0028 makes a *large* turn tractable (delegate, protect context).
They share the `ChatEvent` union and the `acp_backend.ts` event map, so the two new event
kinds (`thinking`, `subagent`) should be added consistently.

## ADR-0029 — Model family picker, custom skills + `/task` proforma, and IDE slide-out panel

**Date:** 2026-06-21
**Status:** Accepted
**Context increment:** P-IDE.1 / P-IDE.2 / P-IDE.3 / P-IDE.4 / P-IDE.5 / P-IDE.6

### Context

Three features in the AgentIDEHarness COVERT Agent IDE prototype are mature enough to port
into LucidAgentIDE:

1. **Model family segregation.** AgentIDEHarness groups AskSage models into collapsible
   `<optgroup>` families (OpenAI GPT, o-series, Anthropic Claude, Google Gemini, Open Source).
   LucidAgentIDE's model picker (`app.ts MODEL_INFO`) renders a flat searchable list with hover
   cards — functional but unsorted. The family grouping improves discoverability as the model
   count grows.

2. **Custom skills.** AgentIDEHarness ships 18 hardcoded slash-command skills
   (`INSTALLED_SKILLS` in `renderer.js:2833–3058`) covering frontend-design, code-review,
   TDD, security audit, caveman mode, session handoff, etc. Each skill is a prompt template
   (`systemPrompt`) injected per-turn. LucidAgentIDE has no skills infrastructure beyond omp's
   native project-dir skill discovery. The built-in skills provide curated expert behaviours
   without requiring file-system skill installation.

3. **IDE slide-out panel.** AgentIDEHarness has a full Monaco editor surface with file tabs,
   "View in IDE" buttons on AI code blocks, and live preview. LucidAgentIDE has no code-editing
   surface — the inspector rail (Memory/Security/KG/Logs) occupies the right side. A slide-out
   Monaco panel lets users inspect and (later) edit AI-generated code with syntax highlighting.

### Resolved decisions

- **Skill curation → all 18 + `/task` proforma.** All 18 skills ship. Most-used skills
  surface to the top of the slash-command popup (usage count persisted in `localStorage`).
  Additionally, a `/task` command provides omp-style subagent delegation with a proforma
  template that **appends** multi-line subagent task assignments to whatever the user has
  already typed (preserving existing input). Default 3 sample subagent lines; user
  adds/removes freely.

- **Remote skill search → built-in only.** No remote skill discovery (skills.sh, GitHub).
  Maximum airgap / isolated-network portability. All skills are hardcoded in `INSTALLED_SKILLS`
  and ship with the app.

- **IDE panel scope → read-only first (P-IDE.4), then read-write via omp (P-IDE.5).**
  P-IDE.4 ships a read-only Monaco viewer for inspecting AI-generated code. P-IDE.5 adds
  editing + "Save" (routes through omp's `write_file` tool → security gate) + "Send to Chat"
  (pastes edited code back into composer). File-conflict handling (omp-modified-file reload
  prompt) lives in P-IDE.5.

### Decision

**1. Model family picker (P-IDE.1).**
   Add a `MODEL_FAMILIES` classification array with regex-based family assignment. Refactor
   the model picker dropdown to render collapsible family sections (icon + label + chevron →
   indented model rows). Search filters across all families; empty families hide. Existing
   per-model hover card (Token Expense / Intelligence / context / "best for") unchanged.

**2. Slash-command skills + `/task` proforma (P-IDE.2).**
   New `desktop/renderer/skills.ts`:
   - `INSTALLED_SKILLS` array — all 18 skills, hardcoded (airgap-safe).
   - `SkillDef` type with `usageCount` for frequency sorting.
   - Slash-command popup on `/` in the composer, sorted by `usageCount` descending (most-used
     first), persisted in `localStorage` under `skill_usage_counts`.
   - Selecting a skill sets `activeSkill`; its `systemPrompt` is delivered as a delimited preamble
     in the **user turn** (the volatile tail, after the cache breakpoint — invariant #6), once per
     turn while active — the SAME path the AskSage persona / personalization recall already use in
     `acp_backend.prompt()`. It must NOT use `--append-system-prompt`: that is a spawn-time flag that
     lands in omp's cached SYSTEM PROMPT (the frozen-prefix region), so switching skills that way
     would bust the KV cache or force an omp respawn per switch (dropping the ACP session).
     `--append-system-prompt` stays reserved for the byte-stable `DELEGATION_POLICY` (ADR-0028).
     [Review correction, 2026-06-21: the original draft said "via --append-system-prompt in the
     volatile tail," which conflated two different locations.]
   - `/task` is a special entry: does NOT set `activeSkill`, instead appends a proforma
     template to the composer (`Subagent 1 task: ...`, `Subagent 2 task: ...`, etc.) without
     erasing existing text. Delegation flows through omp's native Task tool (ADR-0028).
   - Skills browser sidebar panel (new activity-bar button) with skill cards.

**3. Skill telemetry event (P-IDE.3, frozen-contract change).**
   Add `"skill_activated"` to `EVENT_NAMES` in `contracts.ts`. Emit from the renderer via a
   new `POST /api/skill/activated` route (metadata-only: command, name, source — no user
   content). This is the isolated frozen-contract sub-increment.

**4. IDE panel read-only scaffold (P-IDE.4).**
   New `desktop/renderer/ide_panel.ts`. Vendor Monaco ESM (airgap-clean, ~4MB, matching the
   KaTeX vendoring pattern). Panel slides from right over the inspector (higher z-index) with
   CSS `transform: translateX(100%)` → `translateX(0)`. `readOnly: true`. "View in IDE"
   button on AI code blocks. Close + resize handle. Footer with Ln/Col.

**5. IDE panel read-write + pop-out (P-IDE.5).**
   Toggle `readOnly` via an inspect/edit button. "Save" routes through omp's `write_file` tool
   (existing `tool_call` gate fires). "Send to Chat" pastes into composer with language fence.
   Pop-out to Electron BrowserWindow (desktop only). Modified-dot indicator. File-conflict
   banner when omp modifies the open file externally.

**6. Polish + integration tests (P-IDE.6).**
   Cross-feature polish (skill + IDE interaction). Source attribution in skill cards. `/task`
   proforma line count adjustable. Integration tests: slash-command → skill injection → model
   response → "View in IDE" → edit → save.

### Integration with the invariants

- **Extend omp, never fork (#1).** Skills are prompt-template injection delivered in the user turn
  (the volatile tail), `/task` uses omp's native Task tool, and IDE panel save routes through omp's
  `write_file`. No omp fork needed.
- **Language boundary fixed (#2).** All new code is TypeScript in `desktop/renderer/`. No
  Python touched.
- **Fail-closed is law (#3).** Skill user inputs (selected code, `/task` text) flow through
  the existing `tool_call` gate before any tool executes. IDE panel "Save" goes through the
  same gate. No new bypass.
- **Quarantine gate in-process (#4).** Unchanged — the gate fires before any tool regardless
  of active skill or IDE panel state.
- **Untrusted content delimited + late (#5).** Skill `systemPrompt` is trusted (shipped with
  the app). User content in skill turns is scanned normally. Remote skill search rejected —
  external prompt templates would be untrusted text needing scanning. [Review correction: because
  these 18 prompts are injected as TRUSTED (bypassing the untrusted-content scanner), each one must
  be security-reviewed before shipping — a ported prompt that weakens safety would be a
  self-inflicted bypass. Treat the prompt corpus as a frozen, audited asset.]
- **Frozen prefix byte-stable (#6).** Skill prompts are injected in the volatile tail (after
  the cache breakpoint), never in the frozen prefix. The prefix-hash test is unaffected.
- **Trust labels closed set (#7).** No new labels.
- **Events exact names (#8).** One new `EventName` (`skill_activated`) — isolated to P-IDE.3
  as a frozen-contract change.
- **Stable IDs (#9).** No new ID minting required.
- **DuckDB schema freezes (#10).** No schema change in this ADR.

### Phases — one increment each (session ritual)

- **P-IDE.1** — model family picker. `MODEL_FAMILIES` classification, collapsible sections,
  search filter, CSS. Renderer-only, no contract change. **— Built 2026-06-21.** Pure
  classification/grouping extracted to `desktop/renderer/model_families.ts` (`familyOf`,
  `groupByFamily`, `filterModels`; regex order = o-series before GPT; gateway-prefix robust;
  unmatched → "Other") and unit-tested (`model_families.test.ts`, 15 tests). `app.ts` adds the
  collapsible UI (`familyListHTML` + persisted collapse in `localStorage["lucid.model-fam-collapsed"]`)
  to BOTH pickers (`openConfigPopover` + the composer `openOptionDropdown`); the family holding the
  current selection and any family during an active search are force-expanded; empty/no-match families
  are omitted. Hover card + row click unchanged. Verified live in the preview against real omp models:
  27 models → 5 families (claude 12 · o-series 3 · gpt 7 · gemini 4 · rag 1), collapse-toggle +
  persistence, cross-family search + auto-expand, empty state, no console errors.
- **P-IDE.1b** — model picker corrections (follow-up). **— Built 2026-06-21.** Five fixes, all
  verified live against the user's real omp catalog (which turned out to be **85 models**, not 27):
  (1) **Show ALL models** — `curatedModels` previously kept only the curated Claude ids + AskSage,
  silently dropping the user's **direct OAuth GPT (23) + Gemini (20)**; now it returns every model omp
  exposes, ordered by `MODEL_ORDER` for Claude and stable otherwise (family grouping arranges the rest).
  (2) **Collapse bug** — the family holding the selected model could never collapse (the `!hasSel`
  guard); removed it, so collapse is fully user-driven (selected family expanded by default, collapsible,
  persisted). (3) **Unavailable models** — `UNAVAILABLE` registry renders Fable 5 greyed + non-selectable
  (no `data-val`) with a "Currently Unavailable" tag and an ITAR explanation in the hover card; ready for
  the day the government clears it. (4) **AskSage-configured ordering** — when the gov gateway is
  configured, families reorder GPT/o-series/Gemini ABOVE Claude (`ASKSAGE_FAMILY_ORDER`, via a new
  optional `order` arg on `groupByFamily`). (5) **Gov advisory** — gov-gateway models carry a
  "restricted to internal prototype use only until cleared" banner in the hover card. Also: **cold-start
  responsiveness** — removed P-LOC.1's one-time startup omp respawn (it dropped the session + slowed
  first config load; see the ADR-0031 revision) and gave the popover a snappier non-bouncy open. Render
  measured at ~4ms for 85 rows (never the bottleneck). `model_families.test.ts` now 17 tests.
- **P-IDE.1c** — model picker curation + data-sovereignty gating (follow-up). **— Built 2026-06-21.**
  omp exposes no deprecation/provider metadata over ACP, so curation is rule-based + unit-tested in
  `model_families.ts`. (1) **Deprecation (moderate, user-chosen):** drop dated-snapshot duplicates
  (…-20251001) + `-latest` aliases, legacy Claude (3.x, 4.0/4.1; keep 4.5+) and Gemini 2.0 (keep 2.5+).
  (2) **GPT 5.4+ everywhere** (gov AND direct) — `gptVersion()` < 5.4 dropped; o-series + gpt-oss are
  version-less and kept. (3) **Gov-only-with-key** — gov (AskSage) models hidden unless an AskSage
  CIV/MIL key is configured (`state.asksage.configured`). (4) **Gov at top, newest→oldest** within each
  family (`sortGovFirstNewest` + `cmpModelsNewestFirst`; groupByFamily preserves the relative order).
  (5) **Drop omp auxiliary models** (tab-completion, codex auto-review). (6) **China-origin gate**
  (`isChinaModel`: DeepSeek/Kimi/Moonshot/MiniMax/GLM/Zhipu/Qwen/…) — hidden until the user types
  ACKNOWLEDGE in a Settings → "Restricted-origin models" card (persisted via `chinaModelsAcknowledged`
  in settings_store + `/api/china-ack`); the card renders ONLY when such a model exists (none in the
  current catalog → forward-looking guard). (7) **Provider disambiguation** — the same model can appear
  via multiple providers (Claude via Anthropic AND Antigravity); colliding display names get a small
  provider tag (Anthropic/Antigravity/Codex/Gemini CLI), suppressed on gov rows (Gov pill suffices), and
  a final dedup drops rows that would render identically. Verified live: the user's catalog curated from
  85 → 47 models, gov-first ordering, GPT<5.4 gone, zero visual duplicates, no console errors.
  `model_families.test.ts` now 27 tests.
- **P-IDE.1d** — picker polish + queued-chip refinement (follow-up). **— Built 2026-06-21.** (1)
  **Mythos 5 = Fable 5**: added to `UNAVAILABLE` (shared ITAR reason) + `MODEL_INFO`/`MODEL_CTX`, so it's
  greyed/non-selectable with the same rich hover card. (2) **Every listed model gets a hover card**:
  `resolveModelInfo()` falls back curated→base-id→`inferModelInfo()` (family + tier heuristic), so
  provider-routed copies of known models inherit ratings and unknown ones still get the full card
  framework; `modelRow` uses it too so every row shows stars + context. (3) **Cold-boot cache**: the
  last config is persisted to `localStorage["lucid.config-cache.v1"]` and painted instantly on boot via
  `loadCachedConfig()`; `loadConfig` now only ADOPTS the live config when omp actually returned one
  (non-empty model options) — a not-ready/cold omp no longer blanks the cached picker — and an
  "updating…" spinner shows while the live refresh is pending (`pickerRedraw` swaps cached→live in place
  when it lands, dropping revoked-provider models). (4) **Family headers**: removed the leading family
  icon, bolded the label + count (weight 700) and raised contrast (near-white). Queued chip (P-ACP.4):
  redesigned to a compact, subdued, right-aligned pill (11px) with a "Queued" tag + a delete (✕) that
  removes the pre-staged prompt before it sends. **Bug found + fixed in verification:** `inferModelInfo`
  referenced `familyOf` without importing it — a runtime ReferenceError that emptied the picker; neither
  `tsc` nor `Bun.build` flagged the undefined free variable (it became a runtime error). Verified live:
  47-model catalog renders, every row has stars, Mythos/Fable unavailable + matching cards, bold
  icon-less headers, queued pill + delete (deleted prompt does not send). desktop 235 pass.
- **P-IDE.2** — slash-command skills + `/task` proforma. `skills.ts` with all 18 skills +
  `/task`. Usage-frequency sorting. Skill badge. Skills browser panel. Renderer-only, no
  contract change. **Build per the settled review findings #2/#3:** ONE unified picker (sectioned
  "Built-in" + "Project", reusing the P-IDE.1 family-section UI), bundled prompts injected via the
  user-turn tail (omp-native skills stay on `useSkill`), inline auditable array (no `.md` on disk),
  each ported prompt security-reviewed as it lands. **— Built 2026-06-21.** `desktop/renderer/skills.ts`
  ships `INSTALLED_SKILLS` (12 audited, trusted prompts — Frontend Design, Code Review, TDD, Security
  Audit, Refactor, Debug, Write Tests, Explain, Performance, Accessibility, Session Handoff, Plan) +
  usage-frequency sorting (`localStorage`) + the `/task` proforma. The Skills button opens ONE picker:
  a "Built-in" section (`/task` + bundled, most-used first) and a "Project" section (omp-native via
  `/skill:`). Activating a bundled skill stores it and the trusted prompt is delivered as an
  `<active-skill>` preamble in the USER TURN via the persona/recall path (acp_backend `setSkill` +
  `skillDelivered`, re-delivered on new session/respawn) — never the frozen prefix, never
  `--append-system-prompt`; the distiller ignores it. Wiring: `/api/skill` (set/clear) + bridge
  `setActiveSkill/clearActiveSkill`; the composer Skills chip shows the active skill + a Clear row;
  command palette lists `/task` + bundled + project skills. Note: scoped to 12 strong prompts (not a
  literal 18) so each got a real safety pass (review finding #3) — more can be added the same way.
  Verified live: unified picker (12 built-in + 2 project), activation → chip "Code Review" + backend
  round-trips the active name, `/task` appends the template, Clear resets both, no console errors.
- **P-IDE.3** — skill telemetry event. `skill_activated` in `contracts.ts` + emit route.
  Frozen-contract sub-increment. **— Built 2026-06-21.** Added `skill_activated` to `EVENT_NAMES`
  (frozen contract). New `desktop/skills_log.ts` `recordSkillActivated({command,name,source})` emits via
  the canonical `Telemetry` class (validated against the enum) — METADATA ONLY, never user content — to
  an append-only NDJSON (`~/.omp/lucid-events.ndjson`), since the GUI can't co-write agent_obs.duckdb
  (the omp child holds it), mirroring `security_log.ts`. New `POST /api/skill/activated` + bridge
  `skillActivated`; the renderer fires it on bundled activation, project `useSkill`, and `/task`
  (source: bundled|project|task). Verified: 3 unit tests; live activation of Security Audit + /task
  appended valid `skill_activated` events with correct metadata. desktop 238 · harness 403 · typecheck
  clean (3 projects).
- **P-IDE.4** — Monaco vendor + IDE panel scaffold (read-only). Vendored ESM, slide animation,
  dark theme, "View in IDE" buttons, resize handle. No editing, no save, no pop-out. **— Built
  2026-06-21.** Monaco 0.55 added as a desktop dep; its AMD `min/vs` (~16MB) is served LOCALLY from
  node_modules via a guarded dev.ts route (`/vendor/monaco/*`, `pathWithin` traversal guard) — airgap-
  clean WITHOUT committing 16MB; packaged builds get it via electron-builder `files`
  (`node_modules/monaco-editor/min/**`). `desktop/renderer/ide_panel.ts` lazy-loads Monaco via its AMD
  loader on first open (never bloats app.js), creates a `readOnly` editor with a lucid-dark theme,
  slides in over the inspector (`transform: translateX`), header (title + language chip + close), footer
  (live Ln/Col + "Read-only"), and a drag resize handle (persisted width). "View in IDE" buttons are
  injected onto chat code blocks post-render (DOMPurify forbids `<button>` inside sanitized markdown) and
  open the panel via a delegated handler that reads the code + language from the block. Right-edge
  exclusivity: opening the IDE closes Settings + KG and vice-versa. **Worker note (ADR review #4):** a
  read-only viewer needs NO language-service worker (highlighting is main-thread); Monaco 0.55's worker
  is a hashed AMD chunk that's fragile to wire under our strict CSP (`script-src 'self'`, no blob), so
  the viewer uses the main-thread fallback and silences ONLY Monaco's benign "could not create web
  worker" notice — real workers are deferred to the read-write phase (P-IDE.5), exactly as the review
  anticipated. CSP gained `worker-src 'self'` + `font-src 'self'`. Verified live: editor renders +
  highlights TS/Python/Rust/Go, footer tracks the cursor, close + exclusivity + injected buttons work,
  zero console errors/CSP violations. desktop 238 · typecheck clean (3 projects). Packaged-build worker
  verification still pending (couldn't build a packaged app in this environment).
- **P-IDE.5** — IDE panel read-write + pop-out + save-through-omp. Edit toggle, Save via
  `write_file`, Send to Chat, pop-out, modified-dot, file-conflict banner.
- **P-IDE.6** — polish + integration tests. Cross-feature flows, source attribution, end-to-end
  test coverage.

### Alternatives considered

| Option | Rejected because |
|--------|------------------|
| Fork omp for native skill support | Violates invariant #1 |
| Remote skill install from skills.sh | Violates airgap requirement; external prompts are untrusted (invariant #5) |
| Full read-write IDE from day one | +250 LOC + conflict handling; read-only ships faster, read-write follows |
| Skills as `.md` files on disk | File-discovery surface; inline array is simpler, auditable, airgap-clean |
| Static subagent count in `/task` | User may want 1–N; default 3 sample lines, add/remove freely |

### Consequences

- **Bundle size:** +~4MB from vendored Monaco (matches KaTeX precedent).
- **Frozen contract:** one new `EventName` (`skill_activated`), isolated to P-IDE.3.
- **No new invariant violations.** Skills are prompt-template-only; IDE panel renders model
  output in a text editor; model picker is UI-only; `/task` is pure text insertion using omp's
  existing Task tool.
- **Deferred:** remote skill search/install (rejected for airgap); skill-specific tool
  definitions; IDE panel file-explorer (omp already manages files).

### Review findings (2026-06-21, before building)

Correctness/clarity fixes applied above, plus open items to resolve in the relevant phase:

1. **Injection mechanism (fixed in Decision #2 / invariant #1).** Skill prompts ride the user-turn
   tail (persona/recall pattern), NOT `--append-system-prompt` — see the inline correction.
2. **Two skill surfaces (resolve in P-IDE.2).** LucidAgentIDE already surfaces omp's native skills
   (`/api/skills` → `listSkills()`, the composer Skills button, `useSkill`). The 18 bundled
   `INSTALLED_SKILLS` would be a SECOND, parallel system. Reconcile before building: either present
   one unified picker (bundled + omp-native, sectioned by source) or ship the 18 as bundled omp skill
   files so there is a single discovery path. Don't ship two competing skill lists.
   **— Settled 2026-06-21: ONE unified picker, two delivery mechanisms behind it.** The existing
   composer Skills popup becomes the single discovery surface, listing both sources in labelled
   sections — "Built-in" (the 18 bundled) and "Project" (omp-native from `listSkills()`). The picker
   reuses the SAME family-section UI pattern just shipped for the model picker (P-IDE.1:
   `model_families.ts` collapsible sections), so there is one interaction model across pickers.
   Internally: bundled skills inject their `systemPrompt` via the user-turn tail (the persona/recall
   path in `acp_backend.prompt()`), while omp-native skills keep going through omp's existing
   `useSkill`/`/api/skills` path — an implementation detail, NOT a second list. We do NOT ship the 18
   as `.md` files on disk (keeps the ADR's inline, auditable, airgap-clean array — see the alternatives
   table) and we do NOT reimplement omp's native skill discovery. This satisfies "single discovery
   path" (#2) without forking omp (#1) or adding a file-discovery surface. The bundled badge in each
   card shows its source for transparency (#6 polish).
3. **Trusted prompt corpus (noted in invariant #5).** The 18 ported prompts are injected as trusted;
   audit each before shipping and treat the corpus as a frozen, reviewed asset.
   **— Settled 2026-06-21:** P-IDE.2 ports the 18 prompts ONE pass at a time, and each is
   security-reviewed as it lands (no prompt that weakens the safety/trust-boundary rules ships). The
   corpus becomes a frozen, reviewed asset: changing a bundled prompt is its own reviewed change, the
   same discipline as the frozen prompt prefix. Bundled-skill text is TRUSTED (injected without the
   untrusted-content scanner); USER content in a skill turn is still scanned by the gate as normal.
4. **Monaco airgap (P-IDE.4).** Vendoring the Monaco ESM is necessary but not sufficient — its web
   workers fetch separate scripts. Set `self.MonacoEnvironment.getWorker` to local vendored worker
   bundles, or the editor breaks offline / in the standalone build. Verify in a packaged build.
5. **Right-panel exclusivity (P-IDE.4/5).** The IDE slide-out shares the right edge with the
   inspector, Settings, and the Knowledge-graph panels (all `data-rail`/aside surfaces). Make them
   mutually exclusive (open one closes the others) and coordinate z-index, mirroring how Settings/KG
   already auto-collapse the sessions sidebar, so panels never overlap.

## ADR-0030 — Code activity dashboard: lines-of-code metric + monthly workspace ledger

**Date:** 2026-06-21
**Status:** Accepted
**Context increment:** P-CODE.1 / P-CODE.2 / P-CODE.3

### Context

The existing ledger card in the Memory tab (`ledgerSplit()` in `app.ts:1358`) shows cost-
focused metrics: spend · all models, est. cache savings, cache hit-rate, tokens, turns,
models, sessions, and API vs. subscription. There is no visibility into what the AI agent
actually **produced** — how many lines of code were written, how many files were touched,
and across which workspaces. This makes it difficult for users to assess productivity,
justify spend, or understand the scope of changes across repositories.

**Data gap:** The current `usageLedger()` in `tools/memory_data.ts` reads omp's JSONL
session transcripts for token/cost data, but there is no code-change tracking. omp
records `tool_call` events (including `write_file`, `edit_file`, `bash` commands), but
does not aggregate lines added/deleted/files edited. The most reliable source for code-
change metrics is `git diff --stat` run against each workspace's repository.

### Decision

**1. Top-line code activity metric in the ledger card (P-CODE.1).**

Insert a new `lc-row` in the ledger card, immediately below the "cache hit-rate" row,
showing:

```
lines of code    +1,247 / -318    # 42 files
```

Where:
- `+1,247` is green (`var(--green)`), showing total lines added across all workspaces
  in the current month.
- `/` is neutral separator.
- `-318` is red (`var(--red)`), showing total lines deleted.
- `# 42 files` shows total unique files edited, using `#` as the files sigil.

This same metric also appears as a new tile in the collapsed metrics rail:
`+1.2k/-318 · 42f` under the label "code" — compact enough for the rail's narrow tiles.

**2. Monthly workspace activity section (P-CODE.2).**

A new accordion section in `memoryHtml()`, positioned after the "Cost & savings ledger"
accordion, titled **"Workspace activity · \<month\> \<year\>"** (e.g., "Workspace activity ·
June 2026"). The time window is the current calendar month (system date, 28–31 days).

Contents:
- **Summary card** (same pattern as the ledger card, `ledger-card` class):
  - `spend · all models` — the existing `fmtUSD(t.cost)` (repeated for context)
  - `est. cash savings` — the existing `fmtUSD(t.savings)`
  - `cache hit-rate` — the existing `Math.round(t.cacheHitRate * 100)%`
  - `total tokens` — `fmtNum(t.tokens)`
  - `lines of code` — `+N` green `/` `-N` red (aggregated across all workspaces)
  - Footer: `N turns · N models · N sessions · API/subscription`

- **Per-workspace table** (below the summary card), one row per repository:

  | workspace | files | lines | spend |
  |-----------|-------|-------|-------|
  | LucidAgentIDE | 42 | +1,247 / -318 | $2.14 |
  | AgentIDEHarness | 8 | +92 / -15 | $0.38 |

  Where:
  - `workspace` is the repo directory basename (e.g., `LucidAgentIDE`).
  - `files` is the count of unique files edited in that repo this month.
  - `lines` uses the `+N` green `/` `-N` red format.
  - `spend` is the estimated cost attributed to sessions that touched that workspace
    (matched by `cwd` in omp session metadata).

**3. Git-based data collection (P-CODE.1 backend).**

New function in `tools/memory_data.ts`:

```typescript
export interface CodeActivity {
  workspaces: {
    name: string;       // repo basename
    path: string;       // absolute repo path
    added: number;      // lines added this month
    deleted: number;    // lines deleted this month
    files: number;      // unique files edited
    spend: number;      // estimated cost from matching sessions
  }[];
  totals: { added: number; deleted: number; files: number };
  month: string;        // "June 2026"
  daysInMonth: number;
}

export function codeActivity(opts?: { workspaces?: string[] }): CodeActivity
```

Implementation:
- For each known workspace (from omp's `projects` config or explicitly passed), run
  `git log --since="<month-start>" --until="<month-end>" --numstat --pretty=format:""` and
  parse the output for per-file add/delete counts. [Review correction: spawn git with an ARGS
  ARRAY, never a shell string (no injection via paths/refs); confine each workspace path with the
  existing `pathWithin` containment (ADR-0022/0023) before running git on it; apply an exec timeout.
  Add a pathspec to exclude vendored/generated/lockfiles so the metric reflects real source, not
  dependency churn: `-- . ':(exclude)node_modules' ':(exclude)vendor' ':(exclude)dist'
  ':(exclude)*.lock' ':(exclude)*.min.*'`.]
- Aggregate by workspace. Deduplicate files (same file edited multiple times counts as 1); handle
  rename rows (`{old => new}`) and the blank lines `--pretty=format:""` leaves between commits.
- Match workspace paths to omp session `cwd` to attribute spend from the usage ledger (an ESTIMATE —
  a session may touch files outside its cwd).
- Exposed via `GET /api/code-activity` from `dev.ts`.

**Why git instead of omp tool_call parsing:** omp's `tool_call` events record the content
passed to `write_file`/`edit_file`, but counting lines from tool args is unreliable (partial
edits, overwrites, bash commands writing files). `git diff --stat` is the ground truth for
what actually landed in the repo, and it's available on every workspace since all workspaces
are git repos (the FsList type checks `isGit`).

### Integration with the invariants

- **Extend omp, never fork (#1).** Data comes from `git log` on workspaces, not from an omp
  fork. The new API endpoint follows the existing `/api/usage` pattern.
- **Language boundary fixed (#2).** All new code is TypeScript in `tools/` and
  `desktop/renderer/`. No Python.
- **Fail-closed is law (#3).** If `git log` fails (not a git repo, git not installed), the
  workspace is omitted from results — never faked. The ledger card shows "–" if no git data
  is available.
- **Frozen prefix byte-stable (#6).** No prompt changes. This is a read-only metrics
  dashboard.
- **Events exact names (#8).** No new events. This is display-only, no telemetry emission.
- **DuckDB schema freezes (#10).** No schema change — data is computed on-the-fly from git,
  not stored in DuckDB. (A future ADR could add a `code_activity` table for historical
  trending, but that's deferred.)

### Phases — one increment each (session ritual)

- **P-CODE.1** — git data collection + top-line metric. New `codeActivity()` function in
  `tools/memory_data.ts`. New `GET /api/code-activity` endpoint. New `lc-row` in the ledger
  card showing `+N/-N # files`. New metrics rail tile. CSS for green/red line counts.
  Verified: ledger card shows live git stats for the current month.

- **P-CODE.2** — monthly workspace activity section. New accordion in `memoryHtml()` with
  the summary card (spend, savings, cache, tokens, lines) + per-workspace table. Calendar-
  month window derived from system date. Spend attribution by matching session `cwd` to
  workspace paths.
  Verified: accordion lists all workspaces with correct diffstats and spend.

- **P-CODE.3** — polish + edge cases. Handle: workspace with no git history this month
  (show "no changes"), non-git directories (skip gracefully), binary files in `git log`
  output (the `- -` format — exclude from line counts), detached HEAD or shallow clones.
  Add a "refresh" button on the workspace activity section. Integration tests.

### Alternatives considered

| Option | Rejected because |
|--------|------------------|
| Parse omp `tool_call` events for write_file content | Unreliable: partial edits, bash writes, tool args don't reflect final state |
| Store in DuckDB for historical trending | Over-scoped for v1; computed-on-the-fly is simpler and avoids a schema migration |
| Track per-session instead of per-month | Per-session is too granular; monthly is the natural billing/review cycle |
| Show only current session's changes | User wants a monthly workspace overview, not just the active session |

### Consequences

- **Performance:** `git log --numstat` is fast even for large repos (reads the pack index).
  One call per workspace per refresh cycle (every 5s poll, cached for 30s to avoid hammering).
- **No frozen-contract change.** No new `EventName`, no schema migration.
- **New API endpoint:** `GET /api/code-activity` — follows the existing pattern
  (`/api/usage`, `/api/memory`, `/api/security`).
- **New bridge type:** `CodeActivity` interface in `bridge.ts`.
- **Deferred:** Historical trending (DuckDB table), per-commit attribution (which AI session
  produced which commit), branch-level breakdown.

### Review findings (2026-06-21, before building)

1. **Attribution honesty (must fix the framing).** `git log --since=<month>` counts EVERY commit in
   the repo — your own commits, other contributors, merges, `git pull`s, vendored deps, generated
   files — so it cannot equal "what the AI agent produced." v1 must be labeled as **workspace / repo
   activity this month**, NOT AI authorship. The "what the AI agent actually produced" wording in
   Context is the inaccuracy to correct. Real AI attribution (commit author/marker for omp commits,
   or intersecting commit times with agent-session windows) stays the deferred item — but the v1 UI
   label and tooltip must not overclaim.
2. **Safe git invocation (security).** This adds an external-process surface on the hardened local
   control plane (ADR-0022/0024): spawn git with an args array (no shell), `pathWithin`-confine each
   workspace path, and add an exec timeout. (Folded into Decision #3 above.)
3. **Exclude dependency churn.** Pathspec excludes for node_modules/vendor/dist/lockfiles/minified, or
   one committed `node_modules` swamps the line counts. (Folded into Decision #3.)
4. **Perf claim nit.** `--numstat` computes per-file diffs; it does NOT just "read the pack index."
   Fine for a month of history with the 30s cache, but the justification is inaccurate.
5. **Merges.** `git log --numstat` shows no numstat for merge commits by default → merge churn is
   silently excluded (acceptable; note it).

### Future direction: premium BI add-on (separate private repo)

High-level seam ONLY in this repo; the real PRD + scaffolding/IaC live in the private add-on repo
(`mlcyclops/lucidagentIDEaddon`) to keep that IP separate.

- **Seam:** `codeActivity()` + the existing observability/ledger data (`usageLedger()`,
  `memorySnapshot()`, security/lineage) already expose stable, read-only JSON over the local
  `/api/*` surface. That JSON shape is the integration contract a future **premium MCP server**
  (built privately) would consume — it does NOT require changes to LucidAgentIDE's core beyond
  keeping those payloads stable and versioned.
- **Add-on (private repo, to be developed):** a paid MCP-server add-on that exports this
  observability/code-activity data into enterprise BI surfaces — GCC-High Power BI / Power Apps,
  Google Looker, AWS QuickSight, self-hosted Kibana, a SharePoint dashboard, and a standalone
  single-HTML CIO/CFO dashboard that renders the MCP payload — shipped with Terraform/IaC + config
  per target. Authored as separate, licensable IP; this repo stays add-on-agnostic (it just emits
  the data an authenticated MCP client can read). See the private repo's PRD for the full design.
- **Attribution identity (built in core; high level here).** Every metric carries an attribution
  identity so it rolls up + pushes traceably. Resolution, highest-assurance first: verified MCP-auth
  identity (X.509 client-cert subject via corporate CA / SPIFFE, or OAuth/OIDC claim — reusing the
  ADR-0020 IdP groundwork) → configured corporate email (Profile) → **workstation hostname** when the
  user skips the email prompt. Core implements the email/workstation tiers (Settings → Profile +
  first-open prompt with a Skip that records the hostname; `settings_store.attribution()`); the MCP
  add-on adds OAuth + **X.509 workload identity** (import a corporate-CA cert or generate a CSR via
  EST/SCEP/ACME) and OVERRIDES the local tag with the verified principal for non-repudiable exec/
  compliance reporting. Full auth model: private repo `docs/identity-and-auth.md`. Fail-closed; the
  metadata-only / CUI-excluded invariant holds regardless of identity.
- **Enterprise-managed config (capability built in core; high level here).** Admins can deploy a
  read-only policy file (GPO / Intune / JAMF / MDM) to a machine-wide, admin-only path
  (`%ProgramData%\LucidAgentIDE\managed-config.json`, `/Library/Application Support/…`, `/etc/…`, or
  the `LUCID_MANAGED_CONFIG` env). `desktop/managed_config.ts` reads it at startup and ENFORCES org
  policy — currently the attribution policy (`requireEmail`, `allowSkip`, `allowedEmailDomains`) +
  `orgName` + `asksageOnly`, validated server-side in `/api/settings` and reflected in the UI (no
  Skip, org-branded prompt, "Managed by …"). Security model: the file lives in an admin-only path (a
  non-admin cannot forge policy; POSIX rejects group/world-writable; Windows relies on the dir ACL);
  it only ever ADDS constraints, never relaxes the gate; absent/malformed ⇒ unmanaged (safe default).
  Schema is extensible (pinned MCP servers, locked workspace roots, BI endpoint to come). The tested
  policy TEMPLATE + the GPO/Intune/MDM deployment runbook live in the private repo
  (`managed-config/`); this repo holds only the consuming capability.

## ADR-0031 — AI-LOC attribution: count AI-authored lines at the gate, per model/repo/identity

**Date:** 2026-06-21
**Status:** Accepted
**Context increment:** P-LOC.1

### Context

ADR-0030 builds a code-activity dashboard from `git diff --stat`. Git answers "how much did
this repo change," but it **cannot honestly attribute authorship to a model** — a single
commit blends AI edits, human edits, merges, formatters, and generated files, and the commit
author is the human, not the model. The user's actual ask is per-**model** attribution: "how
many lines did each AI model write, per repo, attributed to a person." Git is the wrong
source for that metric (ADR-0030 itself flags this); the right source is the moment the AI
authors an edit and it passes our security gate.

We already gate **every** tool call in-process, fail-closed (`security_extension.ts`), and omp
emits a rich `tool_result` for its file-mutation tools — `write` (`{path, content}`) and
`edit` (all four modes: the default `hashline`, plus `replace`, `patch`, `apply_patch`). The
`edit` result carries `EditToolDetails.diff` — omp's **post-apply** unified diff of the change
actually made (line-numbered rows like `+42|code`). That is the authoritative "the AI wrote
these lines" signal, available exactly where we already sit.

### Decision

1. **Count at the gate's `tool_result` hook**, from omp's own post-apply signal — not git,
   not the model-specific input. A successful `edit` is counted from `details.diff` /
   `details.perFileResults[].diff`; a `write` is counted from `input.content`. Because we read
   the *result*, one counter covers all edit modes (incl. the default hashline) and we never
   over-count failed edits (a hashline hash-mismatch / no-match edit returns `isError`).
   Counting is a PURE module (`harness/runs/loc_count.ts`), over-tested as a keystone: the
   diff counter is robust to both omp's numbered format and plain unified diffs (`+`/`-` at
   column 0, excluding `+++`/`---`). `write` records `removed=0` (we lack the prior file; the
   honest claim is "lines authored," not churn).
2. **New frozen table** `ai_loc_ledger` (migration 0007): one row per file touched, with
   `model`, `identity`, `identity_source`, `repo`, `file_path`, `tool`, `added_lines`,
   `removed_lines`. `aiLocRollup()` groups by `(model, repo, identity)` for the dashboard and
   the future BI add-on push. New `EventName` `ai_edit_recorded` (frozen-contract change, part
   of this increment).
3. **Attribution context via env at spawn.** omp can't observe env changes after it execs, so
   the IDE sets `LUCID_MODEL` / `LUCID_IDENTITY` / `LUCID_IDENTITY_SOURCE` / `LUCID_REPO` before
   spawning `omp acp`; the in-process gate reads them. Identity is the ADR-0030 attribution
   identity (corporate email, or the workstation-name fallback). Model is seeded from the
   persisted last value; once omp reports its active model (`model` config option), the backend
   persists it and updates `process.env` so the NEXT spawn (and any later respawn — key change,
   "Refresh models") is exact. **[Revised under P-IDE.1b, 2026-06-21]:** the backend does NOT force a
   respawn to reconcile the model. The original design respawned omp once if the spawn-time model
   differed; that drops the ACP session and slows cold start for a best-effort metric, so it was
   removed. Net effect: in a brand-new install's FIRST session, edits made before the model is learned
   record model `unknown`; every session after that (model now persisted) is exact.
4. **Best-effort, never security-bearing.** Recording an edit is fire-and-forget in the gate;
   a DB-lock / open failure simply skips the row (verified: it no-ops, fail-safe). It NEVER
   influences the fail-closed decision.

### Consequences / constraints

- **Live model switching (known limitation):** because the child reads `LUCID_MODEL` at spawn, a
  *live* in-session model change (`setConfig("model")`) updates the persisted value + `process.env`
  for the next spawn but does NOT re-tag the running session — edits after a live switch carry the
  prior model until omp next respawns. We accept this rather than respawn-on-switch (which would drop
  the conversation/session and is a heavy cost for a best-effort metric). If exact live-switch tagging
  is ever required, the right fix is a live side-channel the gate re-reads per edit (e.g. a small model
  file written by the backend), NOT a session-dropping respawn.
- **Supersedes git for the AI-authored metric.** ADR-0030's `git diff --stat` stays as the
  *repo-activity* view (total human+AI+tooling churn); ADR-0031 is the *AI-authored* view.
  The dashboard surfaces both, clearly labelled — never conflated.
- The ledger lives in the same observability DB (`agent_obs.duckdb`) as telemetry/lineage; the
  `repo` column distinguishes edited workspaces (which differ from the DB's own location).

### Built P-LOC.2 (2026-06-21) — dashboard surface

The read side of AI-LOC. `tools/memory_data.ts` adds `aiLocSummary()` — a READ_ONLY DuckDB roll-up of
`ai_loc_ledger` (totals + per-model + per-(model,repo,identity), distinct identities), opened read-only
so it coexists with the live gate's write lock and degrades to null when the table is absent (no edits
yet). It is folded into the existing `MemorySnapshot` (no new endpoint/fetch) and rendered in the
Memory tab as an "AI-authored code" accordion: +added/−removed totals, a per-model table, and a
by-repo·identity breakdown (corporate email vs. the workstation-name fallback, marked `⌂`). Verified
live in the preview with seeded rows: totals/per-model/per-repo math exact, attribution + workstation
marker correct, card hidden when the table is empty, no console errors. Renderer + read-only reader
only — no schema/contract change beyond ADR-0031's frozen 0007 table.

## ADR-0032 — Revert isolate-writes steer: the agent builds files directly (bug fix)

**Date:** 2026-06-21
**Status:** Accepted
**Context increment:** fix (frozen-prefix change, PREFIX_VERSION 3 → 4)

### Context

User report: "the Agent not building a file." Investigation: the security gate's block log
(`~/.omp/lucid-blocks.jsonl`) showed NO write/edit block, so the gate was not stopping the write —
the file simply wasn't landing in the workspace. Root cause traced to ADR-0028 (P-TASK.3/4), which
(a) enabled omp task isolation (`harness/omp/acp_config.yml`: `mode: auto`, `merge: patch`) and (b)
added a `DELEGATION_POLICY` line steering the model: "when a delegated subtask will EDIT files … spawn
it ISOLATED so its changes are captured as a reviewable patch."

So a delegated file-build ran in an ISOLATED copy and came back as a patch. But LucidAgentIDE has **no
patch-review/apply UI**, and the Windows isolation→merge path (projfs/block-clone/rcopy + `git apply`)
is fragile and can fail silently. Net effect: the agent "built" the file in a throwaway workspace and
it never appeared on disk — exactly the reported bug. Isolation was meant as a blast-radius layer, but
the in-process, fail-closed security gate (which scans EVERY tool call) is the actual load-bearing
protection; isolation was an extra that, here, broke the product's core function.

### Decision

1. **`DELEGATION_POLICY` rewritten** (frozen prefix layer 3, also delivered live via
   `--append-system-prompt`): the agent now APPLIES FILE EDITS DIRECTLY in the workspace with its own
   write/edit tools (gate-scanned), and isolation is reserved for running UNTRUSTED/risky code, NEVER
   for creating or editing files. Delegation is still encouraged for read-only exploration/research/
   triage (context-window + cache efficiency) — and a delegated build subagent also writes directly.
   `PREFIX_VERSION` 3 → 4 (deliberate cache-busting prefix change; the self-consistent prefix-hash
   test still passes).
2. **Task isolation DISABLED** (`acp_config.yml`: `mode: none`). With isolation off, a `task` subagent
   runs in the REAL workspace, so its writes land where the user sees them — even if the model still
   attempts an isolated spawn.

### Consequences

- Restores reliable file-building; writes are still fully gate-protected (fail-closed, in-process).
- Blast-radius isolation is deferred until (a) a patch-review/apply UI exists and (b) the chosen
  backend's merge is verified reliable on Windows. Re-enabling is a one-line config + policy change.
- Supersedes the ADR-0028 P-TASK.3/4 "isolate write/exec subtasks" decision (kept in history); the
  P-TASK lineage bookkeeping (task_gate.ts, subagent_dispatched/result_gated) is unaffected.

## ADR-0033 — Build / anti-over-refusal policy: stop models declining buildable tasks (bug fix)

**Date:** 2026-06-21
**Status:** Accepted
**Context increment:** fix (frozen-prefix change, PREFIX_VERSION 4 → 5)

### Context

User report (screenshot): asked the agent (Gemini 3.1 Pro) to "reimage the game killer rabbit as a
single HTML file ... amazing graphics, music, and easy playability, put it in the OSP-Tests folder."
The model FLATLY REFUSED: "I cannot create a fully functional game ... My capabilities are limited to
code manipulation, file system operations, and text-based interactions. I cannot generate rich media
content ...". This is over-refusal: a self-contained HTML game (canvas graphics + Web Audio music +
requestAnimationFrame + inline JS) is ORDINARY CODE the agent writes — not external media it must fetch.
The restrictive phrasing was NOT in our prompt (grep-confirmed); the model invented the limit. ADR-0032
(the concurrent revert of the isolate-writes steer) fixed file-STRANDING; this is a different failure —
the model declining to even attempt the build.

### Decision

Add a `BUILD_POLICY` block to the frozen prompt prefix (layer 3, alongside `DELEGATION_POLICY`) that
explicitly affirms full build capability and forbids capability-based refusal of buildable work: a
self-contained app/game/visualization as one HTML file is code (canvas/SVG/CSS graphics, Web Audio
sound, rAF animation, inline JS — no external assets); deliver a complete working result and write it to
the requested location; ask a clarifying question only when genuinely ambiguous, never to avoid work.
Bump `PREFIX_VERSION` 4 → 5 (deliberate cache bump). Like `DELEGATION_POLICY`, `BUILD_POLICY` is
exported and also delivered to the live omp ACP chat via `--append-system-prompt` (acp_backend appends
`DELEGATION_POLICY` + `BUILD_POLICY`), since omp owns its own system prompt on that path.

### Verification

Live in the preview with the SAME model that refused (Gemini 3.1 Pro, `google-antigravity/gemini-3.1-pro`)
and the SAME prompt: the refusal was gone — the model designed ("Designing the Killer Rabbit Game ... a
single-HTML-file game") and BUILT it, writing `OSP-Tests/killer-rabbit.html` (a real game: 7× canvas,
Web Audio `AudioContext`, `requestAnimationFrame`, Monty Python "Caerbannog"/"Killer Rabbit" theme).
prefix-hash test green at v5; harness 403 pass; desktop 235 pass; typecheck clean (3 projects).

### Consequences

- One-time KV-cache bust on the v5 bump (by design). The prefix-hash test is behavior-based (asserts
  stability across requests + that versions differ), so it needed no value update.
- Guidance is model-agnostic; it helps any over-cautious model, not just Gemini. It does not weaken the
  safety/trust-boundary layers (layer 4 untrusted-content rules are unchanged).

## ADR-0034 — Onboard the modern (sharded) ChatGPT data export

**Date:** 2026-06-21
**Status:** Accepted
**Context increment:** P-IMP.1

### Context

A real OpenAI account export (669 MB unzipped) was inspected to scope ChatGPT→LucidAgentIDE
onboarding. Shape, by bytes: `conversations-000.json … -004.json` (5 shards, 21 MB, **420
conversations / 5,591 message nodes**) carry all the signal; `chat.html` (15 MB) is a derived
duplicate; the 793 MB of `*.dat` are renamed binary assets (~586 voice WAVs, ~90 JPEG
images, a few PDF/DOCX), mapped back to real names by `conversation_asset_file_names.json`.

Two findings drove the design:
1. **The export is sharded.** Modern exports have **no single `conversations.json`** — history
   is split across `conversations-NNN.json`. The existing import pipeline (ADR-0010/0012/0023/0025,
   P9.7) only ever resolved one named file, so it rejected a real 2026 export as an "ambiguous
   directory" — the single thing blocking onboarding. The gated distiller, scanner gate, encrypted
   store, KG view, and the in-app "Import history" button (folder browser → `personalImport`) all
   already existed and were unchanged.
2. **Voice is already transcribed in the JSON.** Voice turns arrive as `multimodal_text` with
   `audio_transcription` parts carrying `.text` (1,280 of them, ~114 K tokens). The 586 WAVs are
   therefore **redundant for the knowledge graph** — no Whisper/transcription compute is needed; the
   existing `partsText` reader already folds these into the user's words.

### Decision

Make the *existing* gated import shard-aware — extend, never fork (invariant #1); no new language
(invariant #2); same fail-closed gate (#3, #5) and the same suspicious-source promotion gate
(keystone #2). Three small, pure, over-tested additions:
- `unzip.ts`: `readZipEntriesMatching(buf, predicate)` — decompress **every** matching entry in one
  central-directory pass (pull all shards from a `.zip`).
- `import_adapters.ts`: `isConversationShard(basename)` (`conversations(-NNN)?.json`, case-insensitive)
  + `mergeConversationShards(shards)` (concatenate shard arrays in order; skip non-arrays so one bad
  shard can't abort an import). The merged array flows through the unchanged
  `detectVendor → parseExport → importConversations` path.
- `personal.ts`: `loadExportData(raw)` — a shard-aware sibling of `loadExportText` that gathers +
  merges shards from a folder **or** a `.zip` (loose or nested), falling back to the legacy
  single-file resolution (`conversations.json` / `MyActivity.json` / lone `.json`). Same TOCTOU-safe
  read discipline as `loadExportText` (one read per resource, classify by error code; js/file-system-
  race-safe per ADR-0025). `importChatExport` now calls it instead of `loadExportText` + `JSON.parse`.
  `loadExportText` is retained (its ADR-0025 contract test is unchanged).

No new EventName, no schema migration, no frozen-prefix change.

**Two ingestion methods, documented for the user (not both built — the deterministic path is the
default; the model path is the existing opt-in "AI" checkbox):**
- *Deterministic / heuristic (free, ~0 tokens):* the loader+gate+heuristic distiller. Structural
  facts ≈ 100 % accurate, zero hallucination; near-zero recall on narrative facts and no relationship
  inference — a skeleton, not the connective tissue.
- *AI extraction (opt-in `modelExtractor`, capped 500 msgs):* high recall on semantic
  facts/relationships at ~3–8 % hallucination — recommended scope is the high-signal slice (user text
  + transcripts ≈ 190 K input tokens), each fact carrying a source turn and still passing the
  promotion gate. Don't feed assistant boilerplate + chain-of-thought (`thoughts`/`reasoning_recap`,
  1,569 nodes) — that's the bulk of the ~1 M-token full corpus and almost all noise.

### Verification

Deterministic loader+parser on the **real** export: 5 shards → **420 conversations / 1,952 user
messages (~109 K tokens, voice transcripts included) in 98 ms**. Full gated pipeline on the real
content into a throwaway temp store (random key — the user's encrypted store was never touched):
**1,952 messages scanned through the real fail-closed scanner in ~1 s, 1 blocked (a genuine
finding), 100 facts learned** by the free heuristic — confirming both the gate at scale and the
documented entropy tradeoff (heuristic facts are free + zero-hallucination but noisy). New unit
tests: shard detection/merge, merged-shard parse, the `audio_transcription` capture path,
`readZipEntriesMatching` (multi-entry zip), and `loadExportData` folder/zip/legacy/missing cases.
**harness 408 pass, desktop 242 pass, typecheck clean (3 projects).**

### Consequences

- A real 2026 ChatGPT export folder (or its `.zip`) now imports directly via the existing UI —
  Enable personalization → set passphrase → Knowledge graph → **Import history** → pick the export
  folder. The live UI walk-through requires the user's passphrase, so it was proven at the
  pipeline/real-data level rather than by writing to the real store.
- The 793 MB of media `.dat` is intentionally **not** ingested: voice is already transcribed in the
  JSON, and images/PDFs would need OCR/vision (a future opt-in), not raw bytes.
- Per-shard parse is tolerant (a corrupt shard is skipped, not fatal) and never silently truncates —
  `ImportSummary` continues to report `messages`/`learned`/`blocked`/`skipped`.

### Addendum — live UI walkthrough (2026-06-22)

Drove the full import through the actual UI in an **isolated** preview so the user could test + give
feedback without touching their real store (one already existed: `~/.omp/lucid-personal.kg.enc`,
verified byte-identical before/after). Three small fixes fell out of doing it for real:
- **`LUCID_PERSONAL_DIR` override** (`settings_store.ts` `personalBaseDir()`): relocates the whole
  personalization artifact set (store, CUI store, audit, exports) as one unit; default `~/.omp`
  unchanged. Mirrors the existing `LUCID_PERSONAL_STORE_PATH` the seeder already reads. Override-only;
  it moves WHERE the encrypted file lives, never WHETHER content is gated. Enabled a fully isolated
  demo server (separate store dir) so the walkthrough never risked the real store.
- **`setupPersonal`/`setupCui` now `mkdir -p` the store dir** before `createWithPassphrase` (which
  uses a bare `writeFileSync`). Latent gap: invisible while `~/.omp` always pre-existed, but a fresh
  override dir made setup fail silently. Now first-run is robust anywhere.
- **Import tooltip** updated: "just pick the unzipped export FOLDER (a modern ChatGPT export has no
  single conversations.json — it ships conversations-000.json … and we merge them)". The old text
  pointed users at a `conversations.json` that no longer exists — the exact onboarding confusion.

UX feedback captured for later: the Personalization settings section is a **collapsed** accordion by
default, so a brand-new user may not discover enable→passphrase without expanding it; and the free
heuristic splits compound self-statements into lowercased fragments ("rust for systems work") — the
opt-in AI extractor is the quality path.

**Verification (live):** isolated demo server → enable → passphrase → KG → Import history → folder
browser → picked the synthetic sharded export → audit logged `personal_facts_imported`
{vendor:openai, conversations:4 (both shards merged via the picker), messages:5, learned:3,
blocked:0}; the graph rendered the imported nodes. Real store confirmed untouched; demo artifacts
torn down. Tests added for the override + base-dir defaults; harness/desktop suites green, typecheck
clean, renderer bundle builds.

### Related fix — IDE viewer (ADR-0029 / P-IDE.4)

The user hit "Couldn't load the editor" on **View in IDE**, and the button overlapped the per-message
copy / save-`.md` actions. Root causes + fixes:
- **Overlap:** `.code-ide-btn` was `top:6px;right:8px` inside the `pre`, colliding with the message
  actions at the message's top-right. Moved to the pre's **bottom-right** (with a drop shadow) — a
  measured 65px clear of the message actions.
- **"Couldn't load":** the load path itself is sound (verified Monaco loads + an editor renders in a
  fresh server), so the user's failure was a **stale dev server started before the `/vendor/monaco`
  route shipped** (`loader.js` 404 → `loader.onerror`). The real bug it exposed: `loadMonaco` cached
  the in-flight promise but never cleared it on failure, making one transient miss permanent until a
  full reload. Now failure nulls the cached promise so reopening retries; the error message says so.

## ADR-0035 — ChatGPT-import onboarding: first-run nudge + AI-default with a token/time warning

**Date:** 2026-06-22
**Status:** Accepted
**Context increment:** P-IMP.2

### Context

Live walkthrough of ADR-0034's import surfaced two onboarding gaps the user asked to close:
1. The **Personalization** settings section is a collapsed accordion by default — a brand-new user
   may never find enable→passphrase, so the import they came for is undiscoverable.
2. The free heuristic splits compound self-statements into lowercased fragments ("rust for systems
   work"); the opt-in AI extractor is the quality path, but it was off by default and gave the user no
   sense of its cost (it makes one *sequential, paid* model call per message, capped at 500).

(Also corrected: a verification claim of "18 graph nodes" was a bad DOM count — the renderer emits
several SVG primitives per node; the real graph was 3 nodes / 2 edges, matching `learned:3` and the
co-occurrence rule that only links facts from the *same* message.)

### Decision

A renderer-led onboarding increment plus one read-only server endpoint — no gate/contract/schema
change, no new EventName:
- **First-run nudge + expand-until-configured** (`app.ts`): on boot, if personalization is
  unconfigured, keep the Personalization section expanded (`SET_OPEN`) every launch and show a
  ONE-TIME nudge toast ("Make LucidAgent yours") whose CTA opens Settings scrolled to the section.
  The toast is gated by a `localStorage` flag; the expansion is tied to the unconfigured state (not
  the flag), so it persists until setup but never nags.
- **AI default on first import + token/time warning** (`app.ts` + `personal.ts` + `dev.ts` +
  `bridge.ts`): a new read-only `estimateChatExport(path)` (shard-aware load + parse + count user
  messages/chars; no scan, no store, home-confined) backs a pre-import confirm toast. First import
  (empty graph) defaults to **AI extraction** (listed first); the toast shows `~tokens · ~time`
  (capped at 500 msgs, ~200-tok prompt + msg in / ~100-tok out per call, ~2.5 s/call — explicitly
  "approximate") and offers AI / Quick (free) / Cancel. `timeout:0` forces an explicit choice because
  AI mode is paid and minutes-long.

### Verification

Drove it all live in an isolated demo (`LUCID_PERSONAL_DIR`, real store byte-identical throughout):
the nudge fired on first boot → CTA opened Settings with Personalization expanded + scrolled + the
passphrase field visible; after setup, Import → folder picker → confirm toast read "Import 4 ChatGPT
conversations? · 5 of your messages · AI: ~1.6k tokens · ~13s · Quick: free + instant" with AI
listed first (first-import default) and a warn tone; "Quick (free)" completed the import
(`personal_facts_imported {conversations:4, learned:3}`). Tests added for `estimateChatExport`
(merged-shard counts + home containment). harness/desktop suites green, typecheck clean, bundle
builds. Demo artifacts torn down.

### Consequences

- The token/time figures are deliberately rough (one number, labelled approximate) — they set
  expectations before a paid run, not a billing guarantee. The cap constant (`AI_IMPORT_CAP = 500`)
  is duplicated in the renderer with a comment pointing at `MODEL_IMPORT_CAP`; if that server cap
  changes, update both.
- Onboarding state lives in `localStorage` (renderer-local), not the GUI settings file — appropriate
  for one-time UI hints, and it means clearing site data re-arms the nudge.

## ADR-0036 — In-app code editor goes read-write: gated Save, Save-As, conflict banner, Send to chat

**Date:** 2026-06-22
**Status:** Accepted
**Context increment:** P-IDE.5

### Context

P-IDE.4 shipped a read-only Monaco viewer fed by chat code blocks. P-IDE.5 makes it an editor: edit
toggle, modified indicator, **Save**, "Save As" for snippets, a file-conflict banner, "Send to chat",
and a pop-out. The security crux is the write path — CLAUDE.md #3 (fail-closed) and #4 (gate
in-process) say nothing reaches disk unscanned.

### Decision

**Save is routed through the in-process scanner gate, not a raw fs write.** A new server module
`desktop/editor.ts` exposes `readEditorFile` + `saveEditorFile`; the latter, in order: (1) confines the
path to the user's home subtree via `pathWithin` (the established GUI file boundary, ADR-0023 — chosen
over workspace-scoping so it matches the home-rooted folder browser, import, and export, avoiding a
"picked a folder outside the workspace" papercut); (2) detects a conflict (on-disk hash drifted since
open, or a Save-As onto a file we never opened) and refuses to clobber without explicit overwrite;
(3) **`scanAndDecide(scanner, content)`** — a >=high finding (zero-width / bidi / tag-block / PUA …)
OR an unavailable scanner BLOCKS the write; (4) writes. omp's own ACP filesystem write is intentionally
disabled for the GUI (`acp_backend` initialize → `writeTextFile:false`), so this gated endpoint — not a
model tool call — is the editor's persistence path, and it keeps the gate in the loop. Routes:
`/api/editor/file` + `/api/editor/save` (token-guarded like every other API).

**Renderer** (`ide_panel.ts`): an Edit/View toggle (`readOnly` flips), a modified dot + footer status
(Read-only / Editing / Modified / Saving… / Saved ✓ / Conflict / Blocked), Ctrl/⌘-S, a Save that does
**Save-As** for unbound snippets (app.ts wires `pickSavePath` = folder browser → a new `promptText`
filename overlay) and writes back for bound files, a conflict **banner** (Overwrite / Reload from disk
/ Cancel), a blocked banner, **Send to chat** (drops the buffer into the composer as a fenced block via
the `setIdeHooks` callback — no app.ts import cycle), a detached **pop-out** (a new window with a
read-only textarea — no scripts, CSP-safe), and an unsaved-changes confirm on close.

**Language-service WORKERS remain deferred.** Editing tokenizes on the main thread (fine); semantic
IntelliSense needs Monaco's hashed worker chunk, which is genuinely hard under our strict
`script-src 'self'` (no blob/eval) CSP. It's a non-blocker for read-write and its own hardening task.

### Verification

Live (real scanner): a clean buffer saved; a buffer with a **zero-width space hidden in a comment** was
**blocked** ("quarantined: 1 finding(s), max severity exceeds high") and never reached disk; a path
outside home was rejected. Full UI Save-As (View→edit→Save→folder pick→filename→write), the conflict
banner (external on-disk edit → "changed on disk" → Overwrite wrote the buffer), Send-to-chat (fenced
block into the composer), modified dot/status transitions, pop-out (graceful "blocked" in the headless
preview; a real window in Electron), and the unsaved-changes close guard all confirmed. New unit tests
in `editor.test.ts` (confinement, gated block, conflict + overwrite, Save-As-onto-existing, clean
write; scanner injected). **typecheck clean (3 projects) · desktop 255 · harness 408 · bundle builds.**

### Consequences

- Saving anywhere in the home subtree (not just the workspace) is the trade for UI consistency; the gate
  scans every save regardless of location, so blast radius is bounded by the scanner, not the path.
- The shared `ScannerClient` serializes over one sidecar pipe; rapid *overlapping* saves can stall a
  response (seen only under artificial concurrent test load — real saves are sequential). A per-save
  timeout/queue is a possible future hardening, noted not fixed.
- Pop-out is a detached read-only COPY (edits there don't sync back) — deliberate MVP; a live second
  editor window is future scope.

## ADR-0037 — IDE polish: modal stacking, concurrent-save safety, lifecycle tests

**Date:** 2026-06-22
**Status:** Accepted
**Context increment:** P-IDE.6

### Context

Polish + hardening pass over the P-IDE.5 editor, driven by two issues seen in real use: the Save-As
folder browser rendered UNDER the IDE panel, and a slow/overlapping save could leave the UI stuck on
"Saving…".

### Decision

- **Modal stacking:** the IDE slide-out panel is `z-index:90`, but the folder browser / prompt scrim
  was `60/61` — so any GUI modal opened while the IDE was open (Save-As, and also import / workspace
  pickers) hid behind it. Lifted `.fb-scrim`→`110`, `.fb`→`111` (above the panel), and `#toasts`→`120`
  (so IDE-triggered toasts/notifications are never occluded either).
- **Concurrent-save safety:** a `saving` guard is now set BEFORE the async Save-As picker (a rapid
  double-click previously opened two folder browsers / two saves) and released in a `finally`; the Save
  button is disabled while in flight. The save request also races a 20 s timeout so a hung/slow scanner
  yields a definite "Save timed out → Retry" instead of an infinite spinner (the gate still fails closed
  server-side). This addresses the shared-`ScannerClient`-pipe stall noted in ADR-0036.
- **Copy + suggestion polish:** the Save-As dialog title dropped the inaccurate "(your workspace)"
  (saves are home-confined, ADR-0036), and an unbound snippet now suggests a clean `snippet.<ext>`
  rather than a name derived from the language chip ("rs.rs").

### Verification

Live: the Save-As browser now renders above the IDE panel (z 111 > 90, scrim dims the panel); a triple-
click on Save opened exactly ONE browser (guard holds); the refactored happy path still saved cleanly
("Saved ✓", title→filename, button re-disabled); suggested name "snippet.rs". Integration tests added to
`editor.test.ts` — the read↔save round-trip (read hash == save hash), the open→external-change→conflict
→overwrite→reopen cycle, and a chained-save sequence. **typecheck clean (3 projects) · desktop 258 ·
harness 408 · bundle builds.**

### Consequences

- z-index now has a documented ordering: panel 90 < modals 110/111 < toasts 120 < the main settings
  scrim sits at 100 (a modal opened over settings still wins at 110/111). Future top-layer surfaces
  should slot relative to these.
- The 20 s save timeout is a UI safety net, not a server cancel — a timed-out request may still complete
  on the server; the editor simply lets the user retry (an idempotent overwrite-or-conflict on re-save).

-----

## ADR-0038 — Marketplace IDE extensions (JetBrains + VS Code) that drive omp over ACP, gate stays in-process

**Date:** 2026-06-22
**Status:** **Draft (proposed)** — not built; this is the design to iterate on before any P-EXT increment.
**Context increments (one each):** P-EXT.1 (launcher) · P-EXT.2 (VS Code) · P-EXT.3 (JetBrains) · P-EXT.4 (packaging/CI + attach-mode)

### Context

Today LucidAgentIDE has exactly one graphical front end: the Electron desktop shell, whose Bun
control-plane spawns `omp acp -e harness/omp/security_extension.ts` so the gate loads in-process
(ADR-0006 addendum; `desktop/acp_backend.ts:124`). We want to meet developers in the editors they
already live in — **JetBrains IDEs** (IntelliJ/PyCharm/GoLand/…) and **VS Code** — with **installable
extensions published to the JetBrains Marketplace and the VS Code Marketplace (+ OpenVSX)** that connect
to the Lucid coding backend (omp) and talk to it over the **Agent Client Protocol (ACP)**.

ACP is already proven here: `tools/acp_probe.ts` confirmed the handshake against omp 16.0.8, and the
desktop addendum captured the live wire format (`session/new` → `configOptions`/`modes`,
`agent_message_chunk`, `agent_thought_chunk`, `tool_call(_update)`, `usage_update`, `session/set_mode`,
`session/request_permission`, `session/cancel`). `desktop/acp.ts` is a clean ~80-line JSON-RPC-over-stdio
ACP client we can reuse. ADR-0006 already named "existing ACP clients like acp-ui / Zed / JetBrains" as
the intended drivers, with the gate remaining the in-process omp hook.

**The trap.** In ACP the *editor is the client* and the *agent is the server*. The naive marketplace
extension would register "omp" as an agent and spawn **bare `omp acp`** — which loads **no `-e
security_extension.ts`** and therefore runs with **zero Lucid security**. That silently violates
invariant #4 (gate in-process) and the fail-closed law (#3): the most-replaceable, least-trusted piece in
the system (a marketplace extension) would be the thing deciding whether the gate is present. That cannot
be the design.

### Decision

**1. A single sanctioned, fail-closed ACP entrypoint: `lucid acp` (P-EXT.1).** The trust anchor is a
Lucid-owned launcher, *not* the extension. `lucid acp` is a thin wrapper (new `bin` in `package.json`,
shipped with the desktop app and installable standalone) that execs the **exact** gated command
`desktop/acp_backend.ts` already uses:

```
omp acp -e <repo>/harness/omp/security_extension.ts \
        -e <repo>/harness/omp/asksage_extension.ts \
        [--isolate <acp_config.yml>] \
        --append-system-prompt <BUILD_POLICY + DELEGATION_POLICY>
```

It resolves the omp binary (`ompBin()` logic), threads the AI-LOC attribution env (ADR-0031), and
**fail-closes at startup**: if the gate extension fails to load or the scanner sidecar can't be reached,
`lucid acp` returns an ACP `initialize` error and exits non-zero, so the IDE shows "agent unavailable" —
**never** an ungated session. This makes invariant #4 hold regardless of extension code: the gate is
always in the same OS process tree as omp, no network in the blocking path.

**2. The extensions are thin ACP clients of `lucid acp` (P-EXT.2 / P-EXT.3).** They never spawn bare
`omp acp`. Each extension:
   - locates the `lucid` binary (installed LucidAgentIDE app → PATH → user-set path; offer download if
     missing),
   - spawns `lucid acp` with the **opened workspace folder as cwd** (that folder is the omp workspace and
     the path-containment boundary, ADR-0022/0023),
   - drives the same loop already proven in `desktop/acp.ts` + `acp_backend.ts`: `session/new` → read
     `modes` → `session/prompt`, mapping `session/update` notifications to UI,
   - surfaces the ADR-0027 UX: **Plan / Ask / Agent** modes (`session/set_mode`), **live thought
     streaming** (`agent_thought_chunk`), tool-activity, **Stop** (`session/cancel`), and the
     **permission round-trip** for Ask mode — **fail-closed**: timeout / view-closed / no-decision ⇒
     `cancelled` (deny), exactly as P-ACP.3 specifies,
   - watches stderr for the gate's authoritative `[BLOCKED …]` line and renders a security-block banner
     (the same reliable signal the desktop shell uses).

   **VS Code (P-EXT.2):** TypeScript extension; **reuse `desktop/acp.ts` directly** as the ACP client in
   the extension host. UI = a Webview **view** in a Lucid activity-bar container (parity with the Electron
   renderer; full control over Plan/Ask/Agent + thinking + block banner). A VS Code *chat-participant* /
   Language Model API integration is a possible later add-on, not the MVP. Publish to **VS Code
   Marketplace + OpenVSX** (OpenVSX so Cursor/VSCodium/Windsurf users can install too).

   **JetBrains (P-EXT.3):** Gradle IntelliJ-Platform plugin (Kotlin). Port the tiny `desktop/acp.ts`
   client to Kotlin (it is line-delimited JSON-RPC — trivial) so the gate still lives in `lucid acp`, not
   in the JVM. UI = a Lucid **tool window**. Publish to the **JetBrains Marketplace**. (If a host already
   exposes a generic ACP "external agent" registration, a lighter path is to just contribute a `lucid acp`
   agent definition + panel; we still ship the full plugin so the experience does not depend on the host's
   ACP maturity.)

**3. No ungated escape hatch by default.** There is no setting that points an extension at a raw agent
command. If an "advanced: custom agent command" is ever added it must be opt-in behind a prominent
"⚠ Lucid security gate disabled" wall, and `lucid acp` itself still verifies the gate loaded and refuses
otherwise (#3). The marketplace is an untrusted distribution channel; the launcher is the chokepoint.

### Why

- **Real ACP, not a second protocol.** The user asked specifically for ACP. Driving `lucid acp` over
  stdio JSON-RPC is genuine ACP and reuses code already verified against omp 16.0.8 — no new wire format,
  no fork (invariant #1; the gate, modes, permissions are all native omp/ACP mechanisms).
- **The gate cannot be left out.** Putting the `-e security_extension.ts` decision in `lucid acp` (Lucid
  code) rather than in extension code means installing the marketplace extension can never produce an
  ungated session. Fail-closed at launcher startup covers the dead-sidecar / unloadable-gate cases.
- **Per-workspace sessions, no desktop app required.** Each IDE window gets its own gated omp session
  scoped to its folder — better than every IDE attaching to one shared Electron session.

### Integration with the invariants

- **Extend omp; never fork (#1).** ACP, modes, permission requests, and `-e` extensions are all native
  omp surfaces. The launcher is a wrapper; the extensions are clients. Nothing forks omp.
- **Fail-closed is law (#3).** `lucid acp` refuses to serve if the gate or sidecar is unavailable; Ask-mode
  permission requests default to *deny* on timeout/close. An IDE that cannot reach a gated launcher shows
  "unavailable," never falls back to bare omp.
- **Gate runs in-process (#4).** `lucid acp` == `omp acp -e security_extension.ts`, so the pre-hook fires
  inside omp's runtime before any tool runs, in the same process tree the IDE spawned. No network call in
  the blocking path. Identical posture to the desktop shell.
- **Untrusted content delimited + late (#5).** Unchanged — the gate and prompt assembler own this;
  extensions only transport prompts/replies. Thinking text stays display-only (ADR-0027) and never
  re-enters a prompt or semantic memory.
- **Frozen prefix byte-stable (#6).** The launcher passes the same `--append-system-prompt` policy bytes
  as `acp_backend.ts`; the editor's volatile context (cwd) is the workspace folder arg, not prefix bytes.
  Prefix-hash test unaffected.
- **Events use exact names (#8).** Logging "ide_session_started / attached" or per-IDE provenance would
  add `EventName` enum values — a **frozen-contract change**, so it is its own sub-increment + ADR, not a
  side effect of any P-EXT increment. Until then the extensions emit nothing new; the gate's existing
  events stand.
- **Local control-plane hardening (ADR-0022/0024).** The stdio launcher needs no socket, so the
  loopback/origin/token controls don't apply to the primary path. They *do* apply to the optional
  attach-mode below.

### Phases — one increment each (session ritual)

- **P-EXT.1 — `lucid acp` launcher.** The gated, fail-closed ACP entrypoint + a `lucid` bin in
  `package.json`. Demo: `lucid acp` serves a real model turn with the gate loaded; killing the sidecar
  makes `initialize` fail (fail-closed), proven the same way as the Increment-0 kill-the-sidecar test.
  Foundation for both extensions — **recommended first build.**
- **P-EXT.2 — VS Code extension (MVP).** Locate launcher → spawn `lucid acp` → reuse `desktop/acp.ts` →
  Webview view with Plan/Ask/Agent, thought streaming, permission round-trip (fail-closed), block banner.
  Demo: install the `.vsix`, open a folder, get a gated reply; a poisoned tool call shows the block banner.
- **P-EXT.3 — JetBrains plugin (MVP).** Gradle IntelliJ plugin, Kotlin ACP-client port, Lucid tool window,
  same semantics. Demo: install the plugin zip, same gated reply + block banner in IntelliJ.
- **P-EXT.4 — packaging, signing, CI + attach-mode.** Marketplace publish pipelines (VS Marketplace +
  OpenVSX `vsce`/`ovsx`; JetBrains `publishPlugin`), versioning/auto-update, publisher verification. Plus
  an **optional "attach to running LucidAgentIDE" mode** (Option B): if the desktop control-plane is up,
  the extension may instead talk to its loopback control-plane (ADR-0022 bind + ADR-0024 capability
  token) and share that gated session. ACP-over-`lucid acp` stays the default; attach-mode is a
  convenience, never a way to bypass the launcher's guarantees.

### Open items to confirm at build time

- Whether current JetBrains releases expose a stable generic-ACP "external agent" registration we can
  contribute to (lighter plugin) vs. needing the full embedded client + tool window.
- VS Code surface choice: custom Webview view (recommended, full parity) vs. the chat-participant /
  Language Model API (tighter native feel, less control over Plan/Ask/Agent) — prototype both in P-EXT.2.
- `lucid acp` repo/asset resolution when launched outside this checkout (absolute paths to
  `security_extension.ts` / `asksage_extension.ts` / `acp_config.yml` must resolve from the installed app
  location, mirroring the `REPO`/`GATE` constants in `acp_backend.ts`).
- Exact `initialize`-error shape omp emits when an `-e` extension fails to load (drives the launcher's
  fail-closed signal to the IDE).

-----

## ADR-0039 — Attach mode: IDE extensions share the running desktop's gated session (planning)

**Date:** 2026-06-22
**Status:** **Draft (proposed)** — planning only; not built. Deferred from ADR-0038 P-EXT.4 ("optional
attach-mode") so it gets its own security review rather than a tail-end addition.
**Context increment:** planning only — no functional code this session.

### Context

ADR-0038 made the IDE extensions thin ACP clients that spawn their OWN fail-closed `lucid acp` (P-EXT.1)
per workspace — the default, no desktop app required (built: P-EXT.1–4b). It also named an **optional
attach-mode** (Option B): when the LucidAgentIDE desktop app is already running, an extension MAY instead
talk to its loopback control-plane and **share that already-gated session** rather than spawning a second
omp.

Why anyone would want it:
- One gated session shared across the desktop shell + the IDE — same memory/recall/persona/usage ledger,
  one omp child instead of two.
- Lower resource use (no second omp + scanner per IDE window).
- The desktop already owns provider auth/secrets; the IDE rides on it with no credential setup.

The catch — and the reason this needs its own ADR: the desktop control-plane is deliberately
UNREACHABLE by other processes. ADR-0022 binds loopback-only + a Host/Origin guard; ADR-0024 requires a
**per-launch capability token** injected into the served HTML (only a same-origin document can read it).
An external IDE extension is exactly the caller those controls keep out. Attach-mode must narrowly open
a **same-machine, same-user** door — carefully.

### Decisions (proposed)

1. **stdio `lucid acp` stays the DEFAULT; attach-mode is opt-in + best-effort.** The extension attempts
   attach only when the user enabled it AND a live desktop is discoverable; on ANY failure it falls back
   to spawning `lucid acp`. Attach is never the only path and never a route to an ungated agent.

2. **Token custody via an owner-only userData handshake file.** The ADR-0024 token is per-launch +
   in-memory. To let a same-machine IDE present it, the desktop writes a small file to its userData dir
   on control-plane start — `{ port, token, pid, startedAt, workspace }` — with **owner-only perms**
   (0600 POSIX; user-ACL'd on Windows), rewritten each launch, removed on clean exit. The extension reads
   it (the SAME same-user trust boundary that already protects the omp credential vault + the AES-256
   personal store). The token rotates every launch and never outlives the process.

3. **Transport: the existing hardened loopback control-plane, UNCHANGED.** The extension calls
   `http://127.0.0.1:<port>` with `Host: 127.0.0.1`, the `x-lucid-token` header, and a JSON content-type
   — satisfying the ADR-0022 Host/Origin guard + the ADR-0024 token check AS-IS. No new bind, no new
   exemption. The gate (security_extension) still runs in the desktop's omp child (invariant #4) —
   attach-mode changes WHO talks to the control-plane, not where the gate runs.

4. **Shared session over the existing `/api/*` chat surface (recommended).** Reuse `/api/chat` (NDJSON
   gated stream) + `/api/newSession` / `/api/chat/cancel` / `/api/modes` / `/api/chat/permission` — all
   already gated, tested, and carrying the block + permission signals the extension UI needs (it maps the
   same ChatEvent stream the renderer consumes). A dedicated `/api/acp` bridge is the alternative, but
   reusing the proven chat surface is less new surface. Prompting is turn-serialized server-side; a
   second client prompting mid-turn is rejected as "busy", not silently interleaved.

5. **Discovery + liveness.** Read `{port, token, pid}` from the handshake file → probe `GET /api/health`
   → attach only if it answers and the pid is alive. A stale file (process gone) is ignored → fall back.
   The control-plane only honors ITS OWN in-memory token, so a stale token is rejected even if the file
   lingers.

### Why (security)

- **No weaker than today.** The control-plane controls are unchanged; attach-mode only gives a
  same-machine same-user client a legitimate way to present the token. The new surface is exactly one
  owner-only file in userData — the boundary that already holds the user's provider creds + encrypted
  store. An attacker who can read it can already read those.
- **Per-launch rotation + liveness binding.** The token dies with the process; the control-plane honors
  only its live in-memory value; a stale handshake is rejected by both the pid check and token mismatch.
  No durable secret.
- **Gate placement unchanged (#4); fail-safe (#3).** The gate runs in the desktop's omp child regardless;
  any attach failure falls back to the fail-closed `lucid acp`. Never spawns or reaches an ungated agent.

### Integration with the invariants

- **Extend omp; never fork (#1):** pure client/transport wiring over the existing control-plane + omp
  session. Nothing forks.
- **Untrusted content delimited + late (#5):** the desktop's existing prompt assembly owns this; the
  extension only transports prompts/replies.
- **Local control-plane hardening (ADR-0022/0024):** attach-mode is the FIRST sanctioned EXTERNAL consumer
  of the token; it adds the userData handshake file (owner-only) as the delivery channel and changes
  nothing else about the bind/guard/token.
- **Events (#8):** an `ide_attached` / `ide_session_started` EventName is a frozen-contract change → its
  own sub-increment + ADR, not part of attach-mode's build.

### Phases (each its own increment + ADR delta when built)

- **P-EXT.5a — desktop handshake writer.** On control-plane start, write `<userData>/lucid-attach.json`
  (owner-only) with `{port, token, pid, startedAt, workspace}`; remove on quit; NEVER log the token. New
  Settings toggle "Allow IDE attach" (default **OFF** — opt-in). No extension changes yet.
- **P-EXT.5b — extension attach path.** Behind a `lucid.attachToDesktop` setting: read the handshake,
  probe `/api/health`, attach over `/api/chat` (+ modes/cancel/permission/newSession); fall back to
  `lucid acp` on any failure. Surface "attached to desktop session" vs "own session" in the UI.
- **P-EXT.5c — concurrency + lifecycle.** Busy-turn handling, multi-IDE/multi-window arbitration,
  desktop-quit-while-attached recovery (auto-fall-back to `lucid acp`).

### Open items to resolve at build time

- **Workspace-boundary semantics (the key security question).** The desktop's gated session is scoped to
  the desktop's ONE workspace (path containment, ADR-0022/23). If the IDE's open folder differs, attaching
  would run the IDE's prompts against the DESKTOP's workspace — wrong and unsafe. Proposed rule: attach
  ONLY when the IDE workspace == the desktop workspace (compare via the handshake `workspace` field);
  otherwise spawn `lucid acp` for the IDE's own folder.
- Handshake file location + format per-OS; whether to embed more than the workspace.
- `/api/chat` reuse vs a dedicated `/api/acp` bridge.
- Concurrency model: one shared turn-serialized session vs a desktop-spawned per-IDE child session.
- Windows owner-only ACLs (no POSIX 0600) — confirm the mechanism (icacls / Node fs Windows ACL).

-----

## ADR-0040 — Standing user-turn guidance (persona, skill, personalization profile) is re-delivered every turn

**Date:** 2026-06-24
**Status:** **Accepted (built)** — desktop chat backend. Shipped this session (issue #54).
**Context increment:** UX bug-fix pass — persona/skill/personalization felt like they "stopped working" mid-conversation.

### Context

Three blocks ride the **user turn** (the volatile tail, AFTER the cache breakpoint — never the frozen
prefix, invariants #5/#6):
- the AskSage **persona** (ADR-0007), delimited untrusted;
- the active **bundled skill** (ADR-0029), trusted `<active-skill …>`;
- the **personalization profile** (ADR-0009 Phase A / P9.2), the `<user-profile note="…">` recall.

All three were delivered **once per session** — gated by a `*Delivered` flag set on the first user turn,
then never re-sent (`desktop/acp_backend.ts`). Over a multi-turn conversation the guidance faded: the
model effectively "forgot" the active skill/persona and the learned profile even though the UI still
showed them active. The reported symptom: after learning "likes caramel/custard," the agent answered a
follow-up by searching workspace files instead of using the knowledge-graph facts it had just learned —
because the `<user-profile>` block was delivered on turn 1 and gone by the later turn.

### Decision

**Re-deliver STANDING guidance on EVERY turn**, not once:
- persona, active skill, and the live `<user-profile>` profile are prepended to **every** user turn;
- the profile is **re-read each turn** (`recallPreamble()`), so facts learned mid-session appear next turn;
- the cross-session `<recalled-memory>` block (ADR-0009 prior-session facts) stays **once per session** — it
  is a session-start recall, not standing guidance, and re-injecting old facts every turn is bloat.

The assembly was extracted into a pure, unit-tested `buildUserTurnPreamble()` (`desktop/preamble.ts`), and
the now-unused `personaDelivered` / `skillDelivered` / `recallDelivered` flags were removed.

### Why this is safe (invariant #6)

These blocks live in the user turn **after the cache breakpoint**, so re-sending them every turn does **not**
mutate or bust the byte-stable frozen prefix or its KV cache. Verified: `demo02_prefix_hash` still green.
The only cost is a few input tokens per turn — exactly the tradeoff that makes the guidance persist. The
fail-closed gate and the metadata-only/CUI rules are untouched (persona stays delimited-untrusted; the CUI
profile still routes to the isolated store and learns nothing while locked).

### Consequences

- Persona / skill / personalization now hold across long conversations instead of fading after turn 1.
- Small, bounded per-turn token cost (the blocks are short; all post-cache).
- Cross-session memory recall behavior is unchanged (still once per session).
- 5 unit tests (`desktop/preamble.test.ts`) pin: persona/skill/profile present on both turn 1 and turn 2,
  while `<recalled-memory>` fires exactly once.

### Supersedes / relates to

- **Supersedes** the "delivered once per session" user-turn delivery in **ADR-0007** (persona) and
  **ADR-0029** (bundled skill), for STANDING guidance.
- **Refines ADR-0009 Phase A:** the P9.2 personalization `<user-profile>` recall is now re-delivered every
  turn; the cross-session `<recalled-memory>` recall stays once-per-session.
- Builds on the same session's recall hygiene: recall now excludes mechanical tool-call activity
  (`omp:*` / `subagent:*`) and stops promoting raw tool I/O as facts, so what rides the user turn is
  genuine knowledge, not noise.

-----

## ADR-0041 — omp version-pin policy: exact pin + compatibility-probe-gated bumps

**Date:** 2026-06-24
**Status:** **Accepted (built)** — exact pin shipped (PR #49), compatibility probe shipped (PR #67).
**Context increment:** derisking the dependency on a fast-moving upstream.

### Context

We **extend omp, never fork it** (invariant #1), so the whole harness rides omp's releases. But omp ships
~3 releases per day (755 commits between 16.0.6 and 16.1.16 alone) and has broken user-facing behavior
*within* a minor series (e.g. oh-my-pi#2976: `/model` effort selection vanished). A caret range
(`^16.0.6`) silently pulls those breaking releases on the next `bun install` — straight into the two
correctness keystones this project is built to protect: the **fail-closed scanner gate** and the
**byte-stable frozen prompt prefix**. Riding omp's releases is correct; riding them *blindly, daily* is not.

### Decision

1. **Exact-pin** all four `@oh-my-pi/*` packages (no caret) in `package.json`, and commit `bun.lock` (PR
   #49). The pinned, tested version (currently `16.0.6`) is the **supported baseline**; a fresh install can
   no longer drift.
2. **Never bump blindly.** A scheduled (weekly) + on-demand (`workflow_dispatch`) **compatibility probe**
   (`.github/workflows/omp-compat.yml`, PR #67) bumps omp to the latest (or a chosen version) **on a
   branch** and runs: root + desktop typecheck, the full harness + desktop suites, and the two named
   keystones — **KEYSTONE 1** (kill the sidecar mid-call → the gate must block) and **KEYSTONE 2**
   (`demo02_prefix_hash` → byte-identical frozen prefix) — plus the scanner pytest.
3. **Green → ready-to-merge bump PR** (master untouched); **red → tracking issue** (stay on the safe pin).
   A human reviews the omp seam changes — context/compaction, `eval`, thinking/reasoning, providers — and
   merges to **move the exact pin forward deliberately**. The probe never auto-merges.

### Why

This is how we capture omp's genuine reliability fixes (replay/stall fixes, OAuth quota rotation,
multi-key login) without gambling the gate or the prefix on hundreds of unreviewed commits. Risk is
localized to a single reviewed, fully-tested bump rather than a silent transitive update.

### Consequences

- omp features arrive deliberately (a small adoption lag vs bleeding edge) — an explicit, accepted trade.
- The pinned omp version is a **frozen-ish surface**: it changes only through the probe path, and each bump
  records the exact version in the commit (and the version + license in the SBOM, add-on Phase 3).
- The probe gives a recurring "is the latest omp safe?" signal with zero manual effort.

### Relates to

- Invariant #1 (extend omp, never fork) and the two correctness keystones (CLAUDE.md).
- POAM R-01 (exact pin + compatibility CI) and R-10 (license/version record) in the add-on repo, and the
  detailed memo `BD/omp-license-and-version-pin.md` (the IP-counsel-style license note + the 16.0.6 choice).

-----

## ADR-0042 — Opt-in model extraction for the personalization graph (cost vs quality)

**Date:** 2026-06-24
**Status:** **Accepted (built)** — Settings toggle, default OFF (PR #66).
**Context increment:** richer knowledge-graph relationships ("custard ↔ caramel" cross-turn linking).

### Context

Live learning (`learnFromTurn`, ADR-0010 P9.2) used the **offline `heuristicExtractor`**: conservative
regex over the user's own text, plus same-turn co-occurrence edges. A richer **`modelExtractor`** (semantic
facts + explicit `{to, relation}` links) already existed but was wired only into the chat-history *import*
path. The heuristic, by design, misses nuance — it could not connect related concepts stated across
different turns, and it often distilled a multi-part remark to a single fact, so there was nothing to link.

### Decision

Add an **opt-in** Settings toggle **"Richer graph (uses the model)"** (`personalAiExtract`, **default OFF**).
When on, `learnFromTurn` uses `modelExtractor` instead of the heuristic, pulling semantic facts +
relationships — at the cost of **one extra model call per turn**. It reuses the backend's existing
`complete()` util (the same one the import path uses); falls back to the heuristic if no model-call is
available. The toggle is surfaced only when the store is unlocked (that is when learning runs).

### Why off by default

A model call per turn is real latency and token cost, and silent recurring spend violates the project's
no-surprise-cost posture. The free baseline — the offline heuristic **plus** the always-on cross-turn
linker (ADR-0043-adjacent, PR #65) — covers most users; the model path is there for those who want the
smartest graph and accept the cost.

### Consequences

- Two learning modes: free/offline (default) and richer/paid (opt-in). The offline cross-turn linker runs
  underneath **either** mode.
- No behavioral or cost change unless a user flips the toggle; metadata-only / CUI-isolation / fail-closed
  gating are unchanged (the model extractor still feeds the same gated `distillTurn`).
- Plumbing: `personalAiExtract` setting + setter, `learnFromTurn(…, complete?)`, `acp_backend` passes
  `complete()`, `personalStatus.aiExtract`, `/api/personal/ai-extract`, and the UI toggle.

### Relates to

ADR-0010 (personalization graph); the import-path model extractor it generalizes.

-----

## ADR-0043 — Memory recall hygiene: tool I/O is provenance, not durable knowledge

**Date:** 2026-06-24
**Status:** **Accepted (built)** — read-side exclusion (PR #50) + write-side root cause (PR #56).
**Context increment:** the knowledge graph and chat were polluted with mechanical tool-call "facts".

### Context

`rememberActivity` (`harness/omp/security_extension.ts`) promoted a semantic fact for **every** allowed
tool call (entity `omp:<tool>`, e.g. `omp:web_search: best burgers Seattle`, `omp:job: job
RegularMarsupial`), and `buildRecall` (ADR-0009 Phase A) injected up to 20 of them into each new session's
first user turn. A live query found **17 of 17** stored facts were tool/subagent activity — zero genuine
knowledge. The result: the model was confused by stale, irrelevant "facts," and they rendered as visible
clutter in the chat (the `<recalled-memory>` block).

### Decision

1. **Read side (PR #50):** `buildRecall` excludes mechanical-activity entities (`omp:*` / `subagent:*`)
   via parameterized `NOT LIKE`. Defense in depth — even if such facts exist, they are never surfaced.
2. **Write side / root cause (PR #56):** `rememberActivity` no longer **promotes** raw tool I/O as a
   recallable fact. It still **ingests** the tool output as a scanned, trust-labelled artifact (provenance
   + audit), so the security trail is complete — it just stops treating mechanical tool mechanics as
   durable knowledge.

### What is deliberately unchanged

- A subagent's **summarized result** still promotes through the **keystone-#2 semantic-promotion gate**
  (`runs/task_gate.ts gateSubagentResult`) — suspicious/quarantined results still never auto-promote. That
  path and its tests are untouched: keystone #2 holds.
- Genuine user learning flows through the personalization graph (`learnFromTurn`, ADR-0010), not through
  tool-call observation.

### Consequences

- Cross-session recall now carries genuine knowledge, not noise; the model is no longer derailed by old
  tool calls, and nothing mechanical leaks into the chat or session titles.
- The semantic-memory store stops accumulating `omp:*` / `subagent:*` activity rows over time.
- Tests pin both halves (recall-exclusion + keystone-#2 promotion still green).

### Relates to

ADR-0009 Phase A (cross-session memory recall); CLAUDE.md keystone #2 (the semantic-promotion gate);
ADR-0040 (which cited this hygiene as the reason the user turn now carries knowledge, not noise).

-----

## ADR-0044 — P-TPS.1: streaming output-token readout (terminal + desktop), vendored from pi-token-speed

**Date:** 2026-06-24
**Status:** **Accepted (built)** — shared core + omp terminal adapter + desktop HUD readout + demo.
**Context increment:** P-TPS.1. User ask: *"show the streaming token count while the model is thinking/replying, minus the entire system prompt — so nobody thinks the prompt is re-charged each turn"* (à la Claude Code). They recalled an omp-upstream feature and asked which version.

### Context

The feature they remembered is the upstream extension **`pi-token-speed`** (Gabriel Sanhueza, MIT, v0.5.1) — it is an **extension, not a core-version feature**, so "which version" has no answer. Verifying it against the installed tree surfaced two facts that make a literal install impossible on *both* of our surfaces:

1. **It will not load under omp.** `settings.ts` / `commands.ts` import `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` at **runtime** (`getAgentDir`, `getSettingsListTheme`, `SettingsList`). Our tree is `@oh-my-pi/*` (omp). `omp -e node_modules/pi-token-speed/index.ts` crashes on first import. (The *type-only* imports are erased by Bun and would be fine; the value imports are not.)
2. **It is a no-op in the desktop IDE.** Its only renderer is `ctx.ui.setStatus` (omp's TUI status bar). On the ACP/RPC path the desktop spawns, omp stubs the entire `ExtensionUIContext` to `()=>{}` — the engine would run and the number would be discarded.

What *does* hold: its **pure engine** (`engine.ts` + `sliding-window.ts` + `constants.ts`) has **zero foreign imports**, and the figure is **output-only** by construction. omp documents `Usage.output` as *"Total output tokens for the turn, including thinking, assistant text, and tool-call argument tokens"* — `input` / `cacheRead` / `cacheWrite` are separate fields, so the system prompt (frozen prefix + tools) is never in it. That is exactly the user's "minus the prompt" requirement, satisfied at the data source, not by filtering.

### Decision

**Vendor the pure engine, write two thin adapters.** (User chose "vendor the pure engine" over a fragile `@earendil-works → @oh-my-pi` shim.)

1. **Shared core** — `harness/metrics/token_speed.ts`: a near-verbatim lift of pi-token-speed's engine + sliding window + word/punctuation estimator (MIT header preserved, modifications noted). Two intentional departures from upstream: **config is injected** via constructor (no `~/.pi/agent/settings.json` disk read), and the **clock is injectable** (`now()`) so the sliding window is deterministically testable. A plain-text `formatReadout()` (no ANSI) renders identically in a terminal or the DOM. Unit-tested (`token_speed.test.ts`) on the two load-bearing properties: the count reflects *only* the deltas fed in (nothing leaks in before `start()` / after `stop()`), and the figures (count, windowed tok/s, TTFT realignment, provider reconciliation) are correct against a controlled clock.
2. **Terminal adapter** — `harness/omp/token_speed_extension.ts`: an omp extension (typed `any`, no omp imports, "loads under any omp version" — same defensive style as `security_extension.ts`). Drives the core from `message_update` (`text_delta`/`thinking_delta`/`toolcall_delta`, with `ev.partial.usage.output` when present → exact counts, estimate as fallback) and paints `ctx.ui.setStatus` with a themed `⚡ TPS:`. Registers `/tps` to cycle display mode (replacing the package's `SettingsList` menu, which needed the foreign UI imports). Wired into the `omp:secure` npm script.
3. **Desktop adapter** — `desktop/renderer/app.ts`: the same engine, fed client-side from the `token`/`thinking` `ChatEvent`s already streaming over ACP, rendered in the per-message activity HUD as `· N tok out · R tok/s`. The existing context figure (from `usage_update`) is relabelled **`ctx`** so it is never mistaken for the per-turn output — directly resolving the confusion the user flagged.

### What is deliberately NOT done

- **The terminal extension is not added to the ACP launcher (`lucid_acp.ts`).** `ui.setStatus` is a no-op there, and adding a third `-e` would break the `ext_parity` / `lucid_acp` tests that assert the exact gate-first `-e` ordering. The desktop draws its own readout from the same core instead. Terminal-only by design.
- **No backend / `ChatEvent` / `acp_backend.ts` change.** The desktop readout is computed entirely from existing events — zero new wire surface, zero parity-test risk.
- **The context/`usage_update` figure is left intact** (only relabelled). It legitimately includes the prompt because it measures window *fill*; conflating it with output would be the very misrepresentation we are removing.

### Consequences

- The desktop shows a live, output-only `tok out · tok/s` while thinking and replying; the terminal `omp:secure` session shows `⚡ TPS:` in the status bar — one tested engine behind both.
- The desktop count is an **estimate** (ACP deltas carry no per-delta `usage.output`; `usage_update` is context, not output); the terminal count is **exact** whenever omp reports usage, estimate-bridged before the first usage figure. Acceptable: the figure is a live speedometer, not a billing ledger (cost is already priced correctly via the cache-aware `usage_update`).
- Prior art credited; we carry a small vendored copy rather than a dependency, consistent with the repo's "omp extensions are local `.ts`" convention. If upstream pi-token-speed materially improves its engine, re-vendoring is a localized future increment.

### Relates to

ADR-0041 (omp version-pin / compat-probe — this is a compat-probe outcome: the package's API matched omp's `ExtensionAPI`/`AssistantMessageEvent`/`Usage`, but its runtime package names did not); ADR-0027 (ACP session/usage plumbing the desktop figure rides on); CLAUDE.md invariant #6 (the output count is volatile tail data, never the frozen prefix).

-----

## ADR-0045 — Project skills: gated drop-import, model-assisted skill builder, and session-derived skills

**Date:** 2026-06-24
**Status:** **Accepted** — P-SKILL.1 (gated drop-import) built this increment; P-SKILL.2 (builder) and P-SKILL.3 (session-derived) designed here, deferred to their own increments.
**Context increment:** P-SKILL.1 (+ design for P-SKILL.2/3).

### Context

The desktop surfaces *project skills* — markdown files under the workspace's `.omp/skills/<name>/SKILL.md` — which omp discovers natively (`discoverSkills(currentWorkspace())`, `desktop/skills_data.ts`). A skill becomes the agent's standing guidance (`/skill:<name>`, or the bundled-skill `<active-skill>` preamble re-delivered every turn, ADR-0029). **Today, project skill files are NOT scanned by the Lucid security gate** — omp loads them directly, so the gate is *not* authoritative for project skills. Bundled skills are the only ones vetted (frozen, reviewed corpus; `desktop/renderer/skills.ts`).

The ask: (1) drag-and-drop `.md` skill files into Project Skills, *scanned at the gate*; (2) a "skills builder" that uses the **most-used model (by usage metrics)** to assess/normalize a skill; (3) build a new skill from **specific selected sessions**. A skill is *guidance the model obeys*, so a poisoned skill is a prompt-injection vector — making the gate authoritative for skill import is a security improvement, not just a feature.

### Decision

A three-phase design, one ADR, separate increments.

**P-SKILL.1 — Gated drop-import (built now).** Drop `.md` onto Project Skills → the desktop server scans the content **fail-closed** through the Python scanner (`scanAndDecide(scanner, text, DEFAULT_POLICY)`, the same path as `scanPersona`). Clean → written to `<workspace>/.omp/skills/<slug>/SKILL.md` (so omp discovers it natively) under a `pathWithin` confinement check. **Suspicious/quarantined → NOT written**; recorded via `recordBlock(...)` so it surfaces in the Security panel as a reviewable block (the user's chosen "block + review" posture). New `POST /api/skills/import`. This closes the unscanned-project-skill gap: the gate becomes authoritative for imported skills.

**P-SKILL.2 — Skills-builder assessment (deferred).** Opt-in (token cost, gated like the ADR-0042 model extractor). Runs the **most-used model** (`usageLedger().models[0]`, `ledgerProvider()`) via `backend.complete(system, user)` (one-shot, throwaway, already-gated session) to normalize a dropped draft into proper skill shape (`name`/`description` frontmatter + structured body) and flag issues. The model's output is **untrusted structure → re-scanned at the gate before save**; the user gets a preview/diff to accept. Wrinkle to resolve in that increment: `complete()` currently uses the *active chat* model, so targeting the most-used model needs a model override on the throwaway session.

**P-SKILL.3 — Session-derived skills (deferred).** Select specific sessions (`listSessions` / `sessionMessages` — preamble-stripped `{role,text}[]`) → distill a reusable skill `.md` with the most-used model. Most security-sensitive (derived + model-generated content), so: scan the inputs, scan the generated skill before save, present a draft to edit. Treated with keystone-#2 discipline — a session-derived skill never becomes trusted guidance without a clean scan (and, by the P-SKILL.1 posture, review if flagged).

### Security analysis (why this is sound)

- **Fail-closed (invariant #3):** import scans through the same `scanAndDecide` seam; scanner-dead / malformed / timeout → blocked, never written.
- **Gate becomes authoritative for skills:** previously project skills bypassed the scanner; the import path routes them through it. (Skills dropped *outside* the app — hand-placed in `.omp/skills/` — still bypass it; the ADR notes this as a known residual, mitigated by the fact that the app is the supported import path.)
- **Injection posture:** a skill is obeyed by the model, so clean ≠ automatically safe-as-instructions. Skills remain **user-selected** (the user picks which to activate) and are delivered **delimited** (invariant #5) like personas (`wrapPersona`); a flagged skill is quarantined for review, not silently usable.
- **Keystone #2 (P-SKILL.3):** model/session-derived skills are derived content; they are scanned before save and never auto-trusted.

### What is deliberately deferred / not done

- The builder (P-SKILL.2) and session-derived (P-SKILL.3) flows — designed, not built.
- No change to how bundled skills work (still the trusted frozen corpus).
- Hand-placed `.omp/skills/` files are not retroactively scanned (only the import path is gated).

### Relates to

ADR-0029 (P-IDE.2 active-skill delivery — skills as re-delivered, delimited guidance); ADR-0042 (opt-in model extraction — the cost-gated, scanned model-assist pattern P-SKILL.2 reuses); ADR-0019 (gate/quarantine + Security-panel block surfacing); CLAUDE.md invariants #3 (fail-closed), #5 (untrusted delimited), and keystone #2 (semantic-promotion gate).

-----

## ADR-0046 — The `/goal` loop primitive: capped maker iterations with a separate, objective checker

**Date:** 2026-06-24
**Status:** **Accepted** — P-GOAL.1 (the run-to-condition loop) built this increment; pause/resume/persistence deferred to P-GOAL.2.
**Context increment:** P-GOAL.1.

### Context

P-SLASH.1 *listed* `/goal` as a steering skill but omp has no native `/goal` (Claude Code / Codex do). The real primitive — the heart of Osmani's "Loop Engineering" — is a control loop: define a goal and a **verifiable** stop condition, the agent iterates, and **a separate checker (not the maker) decides "done."** This ADR builds that loop in the desktop ACP backend, where the two pieces already exist: `backend.prompt()` runs a turn on the **persistent** session (iterations build on each other), and `backend.complete()` runs a **throwaway** session — a natural maker≠checker split.

### Decision

A capped loop with an objective checker, fully gated. (User-chosen posture: objective-command-with-model-fallback; capped + auto-approve + gated.)

**Loop (`backend.runGoal({goal, condition, command, maxIters}, onEvent)`):** for each iteration up to `maxIters`: (1) emit `goal-iter`; (2) run a **maker** turn via `prompt()` toward the goal (streaming the usual `token`/`thinking`/`tool` events; the per-iteration `done` is swallowed so the client sees one continuous loop); (3) run the **checker** in a *separate* `complete()` session; (4) emit `goal-check {done, reason}`; stop with `goal-done` if met, else continue. A single `done` closes the stream at the end.

**Checker (`checkGoal`):** if a verification `command` is given, a separate checker session **runs it and reports exit-0** as strict JSON `{done, reason}` — a real proof (Osmani's "verifiable stopping condition"), and the checker is told NOT to modify anything. With no command, it falls back to a **model judgment** against the maker's reported work, conservative (unsure ⇒ not done). `parseGoalVerdict()` is a pure, unit-tested parser; **a failed/empty checker is treated as not-done** (fail-closed — the loop never *falsely* declares success).

**Safety (the load-bearing part of an unattended loop):**
- **Capped.** Hard `maxIters` (user-set, default 6) + **auto-stop on no-progress** (two iterations with no tool actions and still not done ⇒ stop). No runaway.
- **Gated.** During the loop the backend forces `permissionMode: "auto"` so it runs unattended — but **every tool call is still scanned fail-closed by the in-process gate** (CLAUDE.md invariant #3). The gate, not human approval, is the safety boundary; the cap bounds cost.
- **maker ≠ checker.** The checker is a distinct session (and may be a distinct model later); it never grades its own work.

**Surface:** `POST /api/goal` streams the loop as NDJSON (same shape as `/api/chat` plus the `goal-*` events). The composer's `/goal` opens a small launcher (goal · optional verify command · max iterations) and renders the loop inline with per-iteration dividers and the checker's verdict.

### What is deliberately deferred (P-GOAL.2+)

- **Pause / resume / clear** and on-disk loop state (the article's "memory") — phase 1 is run-to-condition, in-session.
- A **distinct checker model** (most-used / cheaper model) — phase 1's checker reuses the session model via `complete()`; ADR-0045's "model override on `complete()`" wrinkle applies here too.
- **Scheduled automations** (the loop's "heartbeat") — a separate Loop-Engineering building block this harness doesn't yet expose.

### Relates to

ADR-0045 / P-SLASH.1 (listed `/goal` as a skill; this builds the primitive); ADR-0027 (ACP session/prompt + `complete()` plumbing); ADR-0028 (subagent maker/checker split — same principle applied to the stop condition); CLAUDE.md invariant #3 (fail-closed gate is the loop's safety boundary).

-----

## ADR-0047 — Scheduled automations: the loop's in-process "heartbeat"

**Date:** 2026-06-24
**Status:** **Accepted** — P-GOAL.5 built this increment (in-process scheduler; interval + daily cadence; created disabled).
**Context increment:** P-GOAL.5.

### Context

ADR-0046 gave us the `/goal` loop (maker iterations + a separate objective checker), and
P-GOAL.2–4 added cancellation, durable on-disk memory, and resume. The one Loop-Engineering
building block (Osmani) the harness still didn't expose is the **automation** — the loop's
"heartbeat": a saved goal that runs on a *cadence* without a human kicking it off each time.
"The loop you don't have to start is the one that compounds."

### Decision

An **automation is just a saved `/goal` spec** — goal + verifiable condition + optional
verification command + iteration cap — **plus a cadence**. It reuses `runGoal` wholesale, so
every scheduled tick inherits the exact same safety envelope: maker ≠ checker, the durable
on-disk loop memory, and — load-bearing — the **in-process fail-closed gate scanning every
tool call** (CLAUDE.md #3/#4). Three forks were decided with the user:

1. **In-process scheduler only (app open).** A `setInterval` inside the harness ticks every
   30s and fires the first *due* automation. We deliberately do **not** register with the OS
   scheduler (Windows Task Scheduler): that would spawn omp in a process where the in-process
   gate isn't guaranteed armed — a fail-closed risk — and would drag platform-specific surface
   against the TS-only boundary (invariant #2). The safe envelope is "while the app is open";
   nothing runs once it's closed. The timer is `.unref()`'d so it never keeps the process alive.

2. **Cadence is interval *or* daily.** `{kind:"interval", everyMin}` ("every N minutes/hours")
   or `{kind:"daily", hhmm}` ("every day at HH:MM", local time). `isDue(a, now)` is a **pure**
   function (heavily unit-tested) so scheduling is deterministic and side-effect-free; the timer
   only decides *whether* to call `runGoal`, never *how* the loop behaves.

3. **Disabled until enabled.** A freshly-created automation is **inert** — saved but not armed.
   Nothing runs commands unattended on a cadence until the user explicitly flips it on. Safest
   default for an unattended-loop primitive; arming is a deliberate, reversible toggle.

### Mechanics / invariants preserved

- **Store:** a single JSON array at `<workspace>/.omp/automations.json`, confined via
  `pathWithin` and fully fail-safe — any read/parse/write error degrades to "no automations",
  never throwing into the timer. A malformed cadence is rejected at create time (fail-closed:
  a bad cadence never arms). `desktop/automations.ts` is the store + the pure scheduling math.
- **Never preempt the user.** A tick is skipped if a chat turn (`askActive`), another loop
  (`goalActive`), a pending permission, or an in-flight automation (`autoRunning`) is active.
  At most one automation runs per tick. `lastRunAt` is stamped *up-front* so a slow run can't be
  re-fired by the next tick before it finishes.
- **Background runs stream nowhere** — the durable goal-memory file written by `runGoal`
  (ADR-0046) is the audit trail; `lastResult` on the record is surfaced in the UI. A **"run
  now"** action streams the same goal events into the chat transcript, reusing the P-GOAL.1
  inline loop renderer.
- **Surface:** `GET/POST /api/automations`, `POST /api/automations/{enable,delete,run}`; the
  scheduler is armed once at dev-server startup (`backend.startAutomationScheduler()`). The
  `/goal` modal gained a schedule picker ("Run once now / Every… / Daily at…") and a saved-
  automations list (enable toggle · run-now · delete · last-run status).

### Consequences

The Loop-Engineering picture is now complete in this harness: maker/checker loop, cancellation,
durable memory, resume, and — now — scheduled automations. Still deferred: a distinct/cheaper
*checker* model (the checker currently shares the maker's model via `complete()`), and OS-level
scheduling for app-closed runs (intentionally out of scope on the fail-closed grounds above).

### Relates to

ADR-0046 / P-GOAL.1–4 (the loop, cancel, memory, resume this schedules); CLAUDE.md invariants
#2 (TS-only — why no OS scheduler), #3/#4 (the in-process fail-closed gate is what makes an
unattended cadence safe); ADR-0028 (maker/checker split the loop reuses).

-----

## ADR-0048 — A distinct, recommended CHECKER model for the `/goal` loop

**Date:** 2026-06-24
**Status:** **Accepted** — P-GOAL.6 built this increment (per-session checker model + auto recommendation + user override).
**Context increment:** P-GOAL.6.

### Context

ADR-0046 split the loop into a maker and a separate `complete()`-based checker, but both ran on
the *same* model — whatever the user picked for chat, often a flagship (e.g. `claude-opus-4-8`).
The checker is a small, frequent, read-only judgement ("did the verification command exit 0?" /
"is the condition met?") that runs once **per iteration**. Paying flagship rates for it — every
round, on every automation tick — is wasteful. The remaining stub on the loop was: let the
checker run on a cheaper model, user-selectable, with a smart default.

### Decision

The checker runs on a **resolved checker model**, in priority order: (1) the user's explicit
choice, if it's still in their accessible list; (2) an **auto recommendation**; (3) the maker's
model (the ADR-0046 default) when nothing else resolves. The recommendation is drawn **only from
the user's own model picker** — the models their configured providers/subscriptions actually
expose — so the default always works regardless of which APIs/keys/gateways they have.

**Recommendation heuristic** (`desktop/checker_model.ts`, a PURE, unit-tested module), in order:
1. **Tier** — prefer the small-but-capable class (`haiku` / `flash` / `mini` / `spark`) over both
   ultra-cheap-but-weak (`nano` / `lite` / `oss`) and flagship overkill (`opus` / `sonnet` / `pro`
   / full `gpt` / `o3`). Tier dominates the score.
2. **Same provider family** as the user's current chat model — same credentials/billing they're
   already using (a `google-antigravity` user gets a Gemini Flash, an AskSage-gov user an AskSage
   mini, never a model behind a key they don't have).
3. **Newest version** (date pins stripped so a snapshot id never reads as a huge version), minus a
   light flagship-cost penalty that only breaks ties *within* a tier (so a flagship-only fallback
   prefers e.g. `sonnet` over `opus`).
4. **Clean "latest" alias** over a date-pinned id, so the checker tracks the newest snapshot.

E.g. a maker on `anthropic/claude-opus-4-8` → checker auto-recommends `anthropic/claude-haiku-4-5`.

### Mechanics / invariants preserved

- **Per-session override, chat untouched.** `complete()` gained an optional `model`: the throwaway
  session does `session/set_config_option {model}` *before* the prompt, so the override is
  session-scoped and the chat session's model is never changed. Best-effort — if the set fails the
  completion just runs on the default model; the loop never blocks on it (fail-safe).
- **Fail-safe resolution.** A stale/removed override (model no longer in the list) silently falls
  through to the recommendation, never an error. An empty list falls through to the maker model.
- **Persistence.** The choice is a single `checkerModel` field in the git-ignored GUI settings
  (`""`/unset = auto). No new schema, no migration.
- **Surface.** `GET/POST /api/checker-model` (state = selected + recommended + why + current +
  accessible options). The `/goal` modal gained a **Checker model** picker: "Auto — recommended:
  <name>" first (with a one-line *why*), then the full list grouped by provider. Automations
  inherit it automatically (their ticks call the same `checkGoal`).

### Consequences

Every `/goal` round — interactive or scheduled (ADR-0047) — now judges on a cheap, capable, recent
model by default, with full user control. This closes the last stub on the goal loop: all of
Osmani's Loop-Engineering building blocks (maker/checker loop, cancel, durable memory, resume,
scheduled automations) are now exposed, and the checker is no longer pinned to the maker's model.

### Relates to

ADR-0046 (the maker/checker loop this refines); ADR-0047 (automations whose ticks inherit the
checker model); ADR-0031 (the `model` config option + AI-LOC authoring-model plumbing this reads);
CLAUDE.md invariant #3 (the checker's verdict is still parsed fail-closed via `parseGoalVerdict`).

### Addendum — P-GOAL.6.1 (same ADR): GOV lock, readability, token estimate

Three follow-ups landed on the checker picker the increment after P-GOAL.6:

- **AskSage GOV lock.** When the "AskSage only" lock is set (user setting OR org-managed config),
  the checker's accessible list is restricted to **GOV models routed through AskSage** (asksage
  provider + a `gov` id) — so a locked-down deployment never runs the checker on a non-GOV or
  non-AskSage route. `accessibleModels()` applies this filter (fail-safe: only narrows when such
  models exist), so it constrains BOTH the picker and the auto recommendation. e.g. locked → the
  recommendation becomes `asksage-google/google-gemini-3.5-flash-gov` (the GOV small-tier model).
- **Readability.** The picker, its label, and the "why" line are larger and higher-contrast
  (13px / `--txt-2`, up from 11px / `--txt-4`).
- **Token estimate + confirm.** A live, rough token estimate sits at the modal's lower-left
  (`desktop/loop_estimate.ts`, pure + unit-tested): `iters × (~9k maker + ~1.5k checker)`, clamped
  to the loop's 1..20 range. It updates as the iteration count and checker model change, and a hover
  explains the per-iteration assumptions, names the maker + checker models, and notes it's a CEILING
  (a loop usually stops earlier). The user confirms by clicking Run with the estimate in view. The
  "Auto" option label is em-dash-free (`Auto (recommended: <name>)`).

-----

## ADR-0049 — The /goal launcher as a run console: cost estimate + per-run model/skill/persona

**Date:** 2026-06-24
**Status:** **Accepted** — P-GOAL.7 built this increment.
**Context increment:** P-GOAL.7.

### Context

The /goal modal had a token estimate (P-GOAL.6.1) and a checker-model picker. The user asked to (a)
show a real DOLLAR estimate rounded to cents, rationalized against prompt-cache savings; (b) let the
loop choose its base (maker) model, thinking level, a skill, and a persona; (c) use the app's premium
tooltip for the estimate; and (d) enlarge the module's text for readability.

### Decision

The launcher becomes a small "run console". Three pieces:

- **Dollar estimate, cache-rationalized.** `desktop/model_pricing.ts` (pure, tested) prices a model two
  ways, in priority order: the user's ACTUAL metered price from the usage ledger (cost ÷ tokens per
  model — truest for them), else a built-in per-tier LIST table (approximate public prices). `desktop/
  loop_estimate.ts` gains `estimateGoalCost`: it splits each iteration into input/output tokens, prices
  maker + checker separately, and applies the prompt-cache discount to INPUT (cached input billed at
  ~10%), using the user's observed cache-hit rate (else a modest 0.35 — a loop re-sends a large,
  identical prefix every round, so reuse is real). Shown as `~$0.00 · ~Nk tokens · N loops` at the
  modal's lower-left; it's a CEILING (loops usually stop early). All estimates; the tooltip says so.
- **Per-run "Run with" pickers.** Base model, thinking, skill (None + bundled), and persona (when
  AskSage personas exist). They default to the current session state and update the estimate live, but
  are applied to the session ONLY at Run time (`applyRunWith`) — browsing the dropdowns never mutates
  the live session. `applyRunWith` only changes what differs from current, so a default run is a no-op;
  it's best-effort and never blocks the loop. (Saved automations don't capture these yet — noted stub.)
- **Premium tooltip + readability.** The estimate uses the app's `data-tip="Title|Body"` tooltip (the
  same one as the model badge), not a native title. The whole modal's type is larger / higher-contrast.

### Consequences

A user can see, before committing, roughly what a loop will cost in dollars for THEIR plan and cache
behaviour, and tune the model/thinking/skill/persona + checker to trade cost against capability. The
dollar figure is only as good as the price source: real when the model has metered usage, an approximate
list price otherwise (and list prices age — that's the main stub, alongside automations not yet carrying
the run-with selections and the flat per-iteration token assumptions).

### Relates to

ADR-0046 (the loop), ADR-0047 (automations), ADR-0048 (the checker model this prices alongside the
maker); P10.2 (the usage/cost ledger the actual prices come from); ADR-0029 (the active-skill + persona
paths the run-with pickers drive).

-----

## ADR-0050 — The /goal launcher: guided walkthrough, premium tooltips, lockdown model policy

**Date:** 2026-06-24
**Status:** **Accepted** — P-GOAL.8 built this increment.
**Context increment:** P-GOAL.8.

### Context

The /goal launcher had grown to a dense single screen (goal, verify command, iterations, checker,
run-with, schedule, estimate) — powerful but intimidating for a first-time user, and its cost tooltip
rendered UNDER the modal. Feedback: make it approachable, fix the tooltip, suggest common verify
commands, and stop the base-model picker from offering non-AskSage models under the gov lockdown.

### Decision

- **Guided walkthrough (default) ⇄ Advanced.** The modal defaults to a five-step walkthrough showing
  1–3 inputs at a time — (1) Goal, (2) Verification, (3) Effort + checker, (4) Run with, (5) Schedule —
  each with a one-line note and a premium info-dot tooltip. Back/Next navigate; step 1 requires a goal
  before advancing; the last step reveals Run / Save. A pill in the upper-right toggles **Advanced**
  (the old all-at-once view); the choice persists in `localStorage` (`lucid.goalMode`). The same field
  DOM backs both modes (one element per control), so all existing wiring — checker picker, run-with,
  cadence, live estimate — works unchanged; the mode only controls visibility + the button set.
- **Premium tooltips + z-index fix.** Every section has an info dot using the app's global
  `data-tip="Title|Body"` tooltip (same as the model badge). `#tip`'s z-index was below the goal
  scrim (120 < 200) so tooltips rendered under the modal — raised to 260.
- **Verify-command suggestions.** The command input is backed by a `<datalist>` of ~20 common
  commands (npm/pnpm/bun/pytest/go/cargo/make/…); the user can pick one or type anything.
- **AskSage lockdown model policy (per the user).** The CHECKER stays GOV-only (ADR-0048). The BASE
  model, which previously still offered non-AskSage models under lockdown, is now restricted to
  AskSage-routed models and grouped **Gemini, then GPT, then Anthropic** (GOV-suffixed first within
  each, via `groupByFamily` + `sortGovFirstNewest`); RAG/auxiliary routes are excluded. AskSage is the
  gov gateway, so all of these are compliant; this is the only policy that still surfaces GPT (no GPT
  id carries a literal `-gov` suffix).

### Consequences

A newcomer is walked through one decision at a time with inline help; a power user flips to Advanced
once and stays there. The cost tooltip is finally visible. Under lockdown the base model can no longer
escape the AskSage gateway. The walkthrough is presentation-only over the existing controls, so it adds
no new server surface and no new estimate/pricing logic.

### Relates to

ADR-0046/47/48/49 (the loop, automations, checker model, cost estimate this wraps); ADR-0029 P-IDE.1c
(`model_families` gov/ordering helpers reused for the lockdown base picker); the global tooltip system.

-----

## ADR-0051 — AskSage Claude tool use (streamSimple adapter)

**Date:** 2026-06-24
**Status:** **Accepted** — built this increment.
**Context increment:** P-ASKSAGE.TOOLS.

### Context

On the locked-down (AskSage gov gateway) system, Claude/Gemini models served through AskSage could
not write files, run commands, or use ANY omp tool: the agent emitted tool-call XML as plain text,
nothing executed, yet it reported success. Root cause was in `harness/omp/asksage_stream.ts` (the
custom `streamSimple` adapter for AskSage's non-streamed routes, ADR-0007): it never passed `tools`
to the Anthropic Messages API, flattened tool results to plain text, parsed only text from the reply,
and always reported `stopReason: "stop"` — so omp never knew to execute a tool and loop.

### Decision

The Anthropic route is now tool-capable (changes confined to that one file; no frozen contract touched):

- **Tools sent.** `callAnthropic` serializes `context.tools` to Anthropic `{name, description,
  input_schema}`, using omp's own `toolWireSchema` (resolves Zod / ArkType / JSON-Schema authoring
  shapes to a JSON Schema) so the schema matches what omp's native providers send.
- **Tool calls parsed.** The reply's `tool_use` content blocks become omp `ToolCall`s (`{type:
  "toolCall", id, name, arguments}`); `stop_reason: "tool_use"` (or any tool call present) maps to
  omp `stopReason: "toolUse"`.
- **Events emitted.** A new `toAnthropicMessages` builder preserves the tool-use conversation
  structure Claude requires — a prior assistant turn's `toolCall` content → `tool_use` blocks; omp
  `toolResult` messages → `tool_result` blocks (consecutive ones merged into one user turn). The
  stream emits `text_*` then, per call, `toolcall_start`/`toolcall_end`, and a final `done` with
  reason `toolUse`. omp executes each call and loops — and because they flow as real `toolcall`
  events, the **in-process security gate scans every one** (invariant #3/#4), unchanged.
- **Google + RAG unchanged.** Gemini tool use (needs `functionDeclarations`) is out of scope and
  stays text-only; the `/query` RAG route is single-message with no tool use. Neither regresses, and
  neither is ever sent a `tools` field.

### Verification

`harness/omp/asksage_stream.test.ts` (5 tests, fetch mocked): tool_use → toolcall events + `toolUse`
stop reason; mixed text+tool ordering and a content array with both; the request wire format carries
`input_schema` and a prior round-trip as `tool_use` + `tool_result`; text-only unchanged; Google
stays text-only (no `tools`). `bun test harness` 471 · `bun test desktop` 326 · typecheck clean.

### Relates to

ADR-0007 (the AskSage adapter); CLAUDE.md invariants #3/#4 (the gate scans the tool calls this now
emits); the TS-only boundary (the fix is TS in the existing adapter — no new surface).

-----

## ADR-0052 — Monaco CSP: allow data: fonts + blob: workers

**Date:** 2026-06-24
**Status:** **Accepted** — built this increment.
**Context increment:** P-IDE.CSP.

### Context

On the locked-down system the Monaco editor logged two CSP violations: its codicon icon font (inlined
as a `data:font/ttf;base64,…` URL in Monaco's min `editor.main.css`) was blocked by `font-src 'self'`,
and its language-service worker (a `blob:` URL) was blocked by `worker-src 'self'`. The P-IDE.6 strict
CSP (ADR-0036) plus a same-origin worker bootstrap worked on dev Chromium but not under the
locked-down browser's stricter enforcement — the font especially is unavoidable (Monaco's build inlines
it as data:, not a file we can serve).

### Decision

Relax exactly two CSP directives in `desktop/renderer/index.html`: `font-src 'self' data:` and
`worker-src 'self' blob:`. The same-origin worker bootstrap stays (preferred when assets are present);
`blob:` is the belt-and-suspenders fallback. This is the standard, documented Monaco CSP.

**Why it's safe:** both additions are same-origin-DERIVED and cannot exfiltrate — a data: font is
inert bytes, a blob: worker can only run code already admitted by `script-src 'self'`. The actual
egress controls are untouched: `connect-src 'self' http://localhost:* ws://localhost:*` and
`script-src 'self'` still block any network call or remote script. So the locked-down posture holds
where it matters; we relaxed only the two inert, same-origin resource types Monaco needs.

### Verification

CSP served with both relaxations; a `blob:` Worker now constructs without error and a `data:` font
load raises NO `securitypolicyviolation` (zero violations observed for both, where before each was
blocked). Editor functionality (IntelliSense workers) restored on the locked-down build.

### Relates to

ADR-0036 / P-IDE.6 (the strict CSP + same-origin worker bootstrap this minimally relaxes).

### Addendum — Gemini tool use (completes ADR-0051's deferred Fix 5)

The AskSage Gemini route is now tool-capable too (the bug doc had deferred it). Mirroring omp's own
native Google provider so the wire format matches what omp uses against real Gemini:

- **Tools sent** as `tools: [{ functionDeclarations: [{ name, description, parametersJsonSchema }] }]`,
  the schema via `normalizeSchemaForGoogle(toolWireSchema(tool))` (omp's Gemini normalizer).
- **Calls parsed** from `candidates[0].content.parts[].functionCall {name, args}` → omp `ToolCall`s.
  Gemini returns no call id, so we mint a synthetic one; omp's `requiresToolCallId` is false for
  non-Claude models, so results are replayed back by **name**, not id.
- **History preserved** by `toGoogleContents`: an assistant `toolCall` → a `functionCall` part in a
  `model` turn; an omp `toolResult` → a `functionResponse` part (`{output}` or `{error}`) merged into
  a single `user` turn — exactly omp's structure. Emission reuses the same `emit()` path (toolcall
  events + `toolUse`), so the gate scans Gemini tool calls identically.

Only the RAG `/query` route stays text-only (single-message endpoint, no tool use). 3 new Gemini tests
(functionCall→events, the `functionDeclarations`/`functionResponse` wire round-trip, text-only no-tools)
alongside the 4 Anthropic ones. `bun test harness` 473. Live gov-gateway verification is still the
manual check (same caveat as the Anthropic path — both are unit-tested against mocked HTTP).

-----

## ADR-0053 — Knowledge ingest: local RAG vector store + AskSage dataset training (SCOPE/PLAN)

**Date:** 2026-06-24
**Status:** **Proposed** — scope + plan only; no code this increment. Splits into P-RAG.1..4 below.
**Context increment:** P-RAG (planning).

### Context

The user wants a "Knowledge / Data" module that parses PDFs and images **locally** into a **local vector
datastore** for retrieval against multimodal models, AND lets AskSage **Civ** users train named AskSage
datasets — modeled on AskSage's own "Data Settings → Manage Datasets → File Ingest" popups, but with
clearer wording, premium hover tooltips, and a guided walkthrough + advanced mode (the P-GOAL.8 pattern).

Two distinct trust paths, which the UI must keep visually separate:
- **Local** — parse + embed + store **on this host**; nothing leaves the machine. The privacy/air-gap path.
- **AskSage** — upload/train into AskSage-hosted datasets via the gov gateway. Content leaves the host.

What already exists (research): DuckDB (`@duckdb/node-api`) with a frozen, numbered-migration schema; the
fail-closed Unicode scanner gate (`scanAndDecide`) + trust labels + `UNTRUSTED_CONTENT` delimiters
(invariant #5); the AskSage helpers (`desktop/asksage.ts`: `listDatasets`/`monthlyTokens`/persona scan)
and the `/query` RAG route; the compartment model (work/personal/cui, ADR-0012); and the P-GOAL.8 guided
walkthrough. What does NOT exist: any embedding model, PDF/image parsing, or vector column.

### Decision — vector datastore: DuckDB built-in cosine (no extension), HNSW later

Reuse the existing DuckDB. A new **migration `0010_knowledge_vectors.sql`** adds `kb_datasets`
(id, name, classification U|CUI, source local|asksage, embedding_model, dim, created_at) and `kb_chunks`
(chunk_id, dataset_id, artifact_id to content_artifacts, source_path, ordinal, text, trust_label,
`embedding FLOAT[]`, dim, created_at). Retrieval is **brute-force** `ORDER BY array_cosine_distance(
embedding::FLOAT[dim], $q) LIMIT k` using DuckDB's **built-in** array functions — **no extension to
install** (so it works air-gapped; `INSTALL vss` would require a network fetch). For a single-user,
hundreds-to-thousands-of-chunks knowledge base this is fast enough. The `vss`/HNSW index (usearch-based)
is a **future, optional accelerator** — and only if its binary is **bundled** (air-gap) and its
experimental-persistence corruption risk is accepted; brute-force avoids both. This honors invariant #10
(new numbered migration, never edit a frozen one) and adds no new datastore dependency.

### Decision — local parse + embed (phased, TS-only, air-gap-clean)

- **PDF text:** `unpdf` (or `pdfjs-dist`) — pure JS/WASM, no native binary, runs in the Bun harness.
- **Text embeddings:** `@huggingface/transformers` on the **WASM** backend (avoids the native
  `onnxruntime-node` the desktop build currently excludes), model `bge-small-en-v1.5` (384-dim) or
  `all-MiniLM-L6-v2`. Weights are **bundled as extraResources** (air-gap; no runtime download). Embedding
  runs server-side (harness/dev server), where the scanner + DuckDB write already live.
- **Images / multimodal (Phase 2):** prefer **caption-at-ingest** — the active multimodal model describes
  the image (and optional `tesseract.js` WASM OCR pulls embedded text); the caption+OCR text is scanned,
  embedded, and stored, and the image bytes are retained for later inclusion in multimodal prompts. This
  reuses existing models and keeps the new ML dependency to ONE text embedder. **CLIP shared-space
  embeddings** (`Xenova/clip-vit-base-patch32`) are the heavier alternative (true text-image search) —
  noted, not chosen for v1.

### Decision — security (this is a security product; non-negotiable)

- **Every extracted text chunk** (PDF text, image caption/OCR) is **scanned fail-closed** by the Unicode
  scanner before it is stored AND before it is ever injected — same `scanAndDecide` path as personas /
  skill import. Blocked chunks are recorded via `recordBlock`, never embedded.
- Stored chunks carry a **trust label**; retrieval wraps the top-k in `UNTRUSTED_CONTENT_START/END`
  (invariant #5) and injects only in the user-turn tail, never the frozen prefix.
- Each dataset has a **classification** (U / CUI), aligned with the compartment model. **CUI-classified
  content is never offered to the AskSage *Civ* endpoint** — the AskSage path is gated to U (or a gov
  base); the UI states the boundary plainly.
- New `EventName`s for the audit trail (a contracts change = its own increment): `knowledge_ingested`,
  `chunk_embedded`, `knowledge_retrieved` (reuse `content_ingested`/`content_scanned`/`artifact_quarantined`
  where they already fit). Artifacts persist to `content_artifacts` as today.

### Decision — AskSage training (Civ users)

Server-side wrappers mirroring the existing `listDatasets` pattern (POST, `x-access-tokens`, fail-soft),
new `/api/asksage/dataset/*` routes: list (`/get-datasets`, have it), **create** (`/add-dataset` or
`/dataset`), **train text** (`/train` — `{context, content, summarize, summarize_model, force_dataset}`),
**train file** (multipart `/file` aka `/train-with-file`), list files (`/get-all-files-ingested`), delete
file (`/delete-filename-from-dataset`), dataset info/results/copy. **Exact paths/params confirmed at
implementation** against a live gateway (the public docs expose `/train` + `/file`; the swagger UI also
shows `/train-with-file`/`/train-with-array` — some may be client-method names). Custom dataset names are
supported (the community note: pass the plain name, not the `user_content_…` mangled form).

### Decision — UI: one "Knowledge" popup, guided + advanced (P-GOAL.8 pattern)

A single modal, reusing the goal-modal walkthrough machinery (guided default vs Advanced toggle persisted
in `localStorage`, premium `data-tip` tooltips, info dots, step nav). **Guided steps:** (1) Destination —
**Local (stays on this host)** vs **AskSage dataset (uploads to the gateway)**, each explained; (2)
Dataset — pick existing or create with a **custom name + classification**; (3) Files — drag-drop PDF/image
(supported-formats list, clearer than AskSage's); (4) Parse + scan preview — show what was extracted and
the gate verdict per file BEFORE committing; (5) Ingest — embed+store locally, or upload to AskSage, with
a progress + result summary. **Advanced mode:** the AskSage-style one-screen grid (datasets, files,
filters, ingest, delete). **Wording upgrades over AskSage:** say *where data goes* and *why*, what parsing
+ embedding actually do, that everything is scanned at the gate, and what each classification means.

### Phasing

- **P-RAG.1** — local PDF to text ingest: migration 0010, `unpdf` parse, text embedder (bundled), DuckDB
  brute-force retrieval, scan-gated, the Knowledge popup (guided+advanced) for the LOCAL path, and RAG
  injection (delimited) into the chat turn.
- **P-RAG.2** — image/multimodal ingest (caption+OCR at ingest; image retained for multimodal prompts).
- **P-RAG.3** — AskSage dataset training UI (create/list/ingest/delete) for Civ users, classification-gated.
- **P-RAG.4** — polish: retrieval ranking/citations in replies, dataset management (rename/delete/stats),
  HNSW accelerator if the corpus grows.

### Resolved decisions (locked with the user 2026-06-24)

1. **Embedder weights → BUNDLE** the ONNX text-embedder into the installer (air-gap; works fully offline on
   the locked-down target; larger installer accepted).
2. **Images → CAPTION-AT-INGEST** for v1 (active multimodal model describes the image + optional OCR →
   embed the caption; image bytes retained for multimodal prompts). CLIP shared-space embeddings deferred.
3. **KB DB → SEPARATE `knowledge.duckdb`** (no write-lock contention with omp's `agent_obs.duckdb`).
4. **Retrieval trigger → MIRROR THE DATASET SELECTOR** (selecting a local dataset auto-retrieves + injects
   delimited chunks each turn, consistent with the existing AskSage datasets dropdown).

### Performance / laptop feasibility

Designed to run on a standard (incl. locked-down/gov) laptop — 8 GB+ RAM, modern CPU, **no GPU, no native
binaries, no internet** for the local path. Profile:

- **Querying is always fast.** DuckDB brute-force cosine over 384-dim vectors is sub-millisecond to a few
  ms for a realistic single-user KB (hundreds to tens of thousands of chunks).
- **Ingest is the heaviest moment, and it is one-time.** The WASM text embedder runs ~20–100 ms per chunk
  on CPU, so a large PDF (100–300 chunks) is a few seconds to ~30 s. Mitigated with **batched embedding,
  background ingest, and a progress bar** so the UI never blocks.
- **RAM stays modest.** Electron baseline + a transient ~0.3–0.5 GB while embedding; comfortable on 8 GB.
  Model weights ~33–90 MB; vectors ~1.5 KB/chunk (10k chunks ≈ 15 MB).
- **Image captioning is offloaded to the model API** (network call), so the laptop does no local vision
  compute. Optional `tesseract.js` OCR is the slowest *local* op (~1–5 s/image) — secondary to captioning.

Two real limits, with escape hatches: (1) brute-force scales linearly — fine to ~tens of thousands of
chunks; a *very* large KB (100k+) is when the deferred bundled **HNSW** accelerator (P-RAG.4) earns its
keep; (2) bulk OCR is CPU-bound — kept optional. Trade-off accepted: a larger installer (bundled weights)
in exchange for fully-offline operation. These constraints are *why* the design chose WASM over native
`onnxruntime`, brute-force over the network-`INSTALL`ed `vss` extension, and caption-at-ingest over a
second local vision model.

### Alternatives considered

- **Vector store:** sqlite-vec / LanceDB / Chroma / Qdrant — all add a new datastore + (LanceDB/Qdrant)
  native or server surface; DuckDB is already in-tree and air-gap-clean. **vss/HNSW extension** — needs a
  network `INSTALL` or a bundled binary + experimental-persistence (corruption) risk; deferred.
- **Embeddings:** remote embedding API (defeats local privacy / air-gap) — rejected for the local path.
  `onnxruntime-node` native — the desktop build already excludes it; WASM backend avoids per-platform
  native binaries.

### Invariants preserved

#2 (TS-only — `unpdf`/transformers.js/tesseract.js are JS/WASM; the only Python stays the scanner) · #3/#5
(every ingested chunk scanned fail-closed, stored with a trust label, injected only delimited + late) · #8
(new events via the `EventName` enum) · #9 (stable `*_id` for datasets/chunks) · #10 (a new numbered
migration; frozen ones untouched) · keystone #2 (suspicious-source content never auto-promotes — RAG
chunks are retrieval context, never semantic memory).

### Relates to

ADR-0007 (AskSage adapter + `/query` RAG this extends); ADR-0012 (compartments/classification); ADR-0019
(gate/quarantine + Security-panel surfacing); ADR-0050 / P-GOAL.8 (the guided-walkthrough UI pattern
reused); CLAUDE.md invariants #2/#3/#5/#10 + keystone #2.

-----

## ADR-0055 — Subagent edits are gated + attributed (no stash-masking) (R-06)

**Date:** 2026-06-24
**Status:** Accepted — verified + regression-locked this increment.
**Relationship:** depends on ADR-0032 (task isolation OFF) and ADR-0031 (AI-LOC code-activity
attribution); reconciles with the editor TOCTOU fix. Tracks add-on POAM **R-06**. (Numbered after
ADR-0054 / R-04, a sibling PI risk PR.)

### Context

omp's subagent `agent()`/`task` can git-stash isolate → apply → merge a subagent's edits. R-06's risk:
a stash-isolated edit could be masked from the in-process gate or from code-activity attribution
(the AI bill-of-changes), and the nested-repo dirty-state path could mis-attribute.

### Decision / finding

On THIS product the masking surface does not exist, because **task isolation is OFF** (ADR-0032,
`harness/omp/acp_config.yml` `task.isolation.mode: none`):

- A `task` subagent runs in the **real workspace**, so its `write`/`edit` tool calls route through the
  **same in-process fail-closed gate** as the main agent (keystone #1, invariants #3/#4). The
  kill-the-sidecar test already proves the gate intercepts *every* tool call.
- Code-activity attribution (ADR-0031) counts from that gate's `tool_result` hook. The counted event
  shape (`EditResultLike`) carries **no agent/provenance dimension** — so a subagent's edit is counted
  identically to a main-agent edit; there is no field a counter could use to drop it.
- Editor TOCTOU: the applied bytes equal the scanned bytes regardless of which agent applied them, so
  attribution counts exactly what the gate cleared.

`harness/runs/loc_count_subagent.test.ts` regression-locks that subagent writes/edits are counted and
that counting is provenance-independent.

### Consequences

- No code change needed to *track* subagent edits — isolation-off + the agent-agnostic gate hook make
  it automatic. The risk is closed by architecture, not a patch.
- **If isolation is ever re-enabled** (ADR-0032's conditions: a patch-review/apply UI + a verified
  reliable Windows merge-back), R-06 MUST be re-opened: the stash merge-back would need explicit gate
  scanning + attribution of the merged diff, and a nested-repo dirty-state test. This ADR is the
  tripwire for that.
## ADR-0054 — Thinking-item governance: reasoning is display-only, never durable (R-04)

**Date:** 2026-06-24
**Status:** Accepted — built this increment.
**Relationship:** ratifies ADR-0027 (the thinking stream is display-only) as a security policy; extends
keystone #2 (semantic-promotion gate) and invariants #3 (fail-closed) / #5 (untrusted content) to omp's
now-first-class reasoning/thinking items. Tracks add-on POAM **R-02 sibling R-04**.

### Context

omp made reasoning/thinking items first-class (a `--thinking` flag; reasoning items in replay). Raw
model reasoning is a sensitive surface: if it were persisted, learned-from, recalled, or exported it
could bypass the scan/trust-label gate, leak into semantic memory, or escape CUI exclusion.

### Decision

Thinking is **display-only and never durable**. The chat backend streams `agent_thought_chunk` to the
UI as a `thinking` event (live reasoning, like the omp TUI) but it is excluded from everything that
reaches durable state. The single chokepoint is `desktop/thinking_governance.ts`
`isLearnableAssistantText(e)` — **only `token` text is learnable**. The per-turn `assistant` buffer (the
sole input to both `recordTurns` persistence/transcripts and `learnFromTurn` — the personalization
distiller / memory promotion) is built through that predicate, so thinking, tool, block, subagent, and
usage events contribute nothing. Because thinking is never persisted, it is never recalled and never
reaches an export (exports read persisted data) — CUI exclusion holds by construction.

A future change that wants to persist thinking MUST first: scan it through the fail-closed gate,
trust-label it, gate it against semantic promotion (keystone #2), and CUI-exclude it from exports.
`desktop/thinking_governance.test.ts` regression-locks the invariant.

### Consequences

- The thinking-exclusion rule is now a tested pure function, not an inline `=== "token"` that could
  silently drift; `acp_backend.prompt()`'s `sink` consumes it.
- No new persistence/promotion/export path may special-case thinking without passing the four gates
  above — enforced by review against this ADR + the regression test.
- The desktop test suite (`bun test` / `make test`) covers it; note CI's `bun test harness` does not
  yet include `desktop/` (pre-existing; a CI-scope item for R-01).
## ADR-0054 — The `/goal` loop's After-Action Report + termination guards (P-GOAL.9)

**Date:** 2026-06-25
**Status:** Accepted — shipped this increment.
**Context increment:** P-GOAL.9.

### Context

We reviewed our `/goal` loop (ADR-0046–0050) against Cobus Greyling's **loop-engineering**
playbook (`cobusgreyling/loop-engineering`: failure-modes catalog + ship-readiness rubric,
itself drawing on Osmani/Cherny). Our loop already does the hard parts the rubric stresses —
a real **maker/checker split** on a separate, cheaper model (ADR-0048), a **fail-closed
checker** (`goal_verdict.ts`), **durable on-disk memory** with resume (ADR-0046/0047), an
iteration cap + no-progress stop, and a pre-run cost estimate (ADR-0049). The rubric exposed
four gaps, all sharpest for **long-running / unattended** loops:

1. **Resume injected the wrong end of memory.** `runGoal` fed `prior.slice(0, 3000)` — the
   *head* (header + oldest rounds) — so a long resumed loop never saw what it just did. A
   correctness bug squarely in the long-running case (their "State Rot").
2. **No "Infinite Fix Loop" guard (their #1 failure mode).** We stopped on *no actions*, but
   not on *acting-yet-never-converging* — the agent edits every round and the same check keeps
   failing until the cap.
3. **Tool failure was invisible to the loop.** A failed/blocked tool call emitted a generic
   `block` event the loop never counted or reacted to.
4. **No metrics/observability surface (rubric §9).** The markdown memory is human-readable but
   not *measurable*; nothing told the user what a run actually did.

The user asked specifically for an **After-Action Report** as the loop's **last task**, with
"the best type of graphs" for **Tool Calls (by type)**, **LOC changed (added/removed)**,
**Errors recorded**, and **websites visited**.

### Decision

One coherent increment — instrument the loop once, then use that data for both the
termination guards and the report.

- **Pure report core — `desktop/loop_report.ts`** (no I/O, no `Date.now()`; tested like
  `loop_estimate.ts`/`goal_verdict.ts`). Collectors: `normalizeToolName` (group raw omp kinds
  into a stable type set), `extractUrls`, `parseNumstat`, `stallSignature`. Renderer:
  `renderLoopReport(LoopMetrics)` emits a deterministic markdown AAR.
- **"Best type of graphs" = Mermaid + a text scoreboard.** The durable record lives on disk;
  Mermaid (`pie` for tool-calls-by-type, `xychart-beta` bars for LOC and per-iteration errors)
  renders natively on GitHub / VS Code / Obsidian — portable, zero-dependency, and TS-only
  (we generate text, not a charting lib; invariant #2). A unicode **scoreboard** + tables make
  it render even in our in-app `marked` view, which has no Mermaid. Sections with no data
  degrade to an honest one-liner — never an empty/invalid chart.
- **The report is the loop's LAST task.** Generated in `runGoal`'s `finally`, so *every* exit
  path (met / stopped / cancelled / error) produces one; emitted as a new `goal-report`
  ChatEvent (path + summary + markdown) and written beside the memory file via
  `saveGoalReport` (same `<id>-<slug>` stem, `.report.md`, confined by `pathWithin`).
- **Termination guards from the same instrumentation.** (#2) `stallSignature` collapses a
  recurring checker blocker across rounds; three identical not-done rounds stop the loop as
  "not converging" instead of burning the cap. (#3) per-iteration tool-failure counts are
  recorded and fed back into the next maker prompt ("N tool calls failed last round — fix the
  cause"), and surfaced in the report's Errors section.
- **LOC via best-effort git.** `gitHead()` pins a baseline commit; `gitDiffVs()` parses
  `git diff --numstat` of the tree vs that commit at the end, minus any changes already present
  at start. Non-git workspace ⇒ `loc: null` ⇒ the report says so. Never a precondition.
- **Resume fix (#1).** `prior.slice(0, 3000)` → `slice(-3000)` (the most-recent rounds).

Everything new is **best-effort**: a failure assembling/writing the report is swallowed so the
turn always settles with `done`. The fail-closed gate remains the only safety boundary.

### Alternatives considered

- **Render charts in-app (add a Mermaid/Chart.js dependency).** Rejected: a new vendored
  bundle + CSP surface for a report whose durable, portable home is the on-disk file. The text
  scoreboard covers the in-app view; the rich graphs live where they render for free.
- **Have the checker model write the report prose.** Rejected: the metrics are objective —
  deterministic generation is cheaper, reproducible, and can't hallucinate ("verifier theater"
  in the report itself).
- **A structured JSONL run-log instead of markdown.** Deferred — a good *next* increment for
  cross-run success-rate/eval. This increment delivers the per-run record the user asked for;
  the JSONL ledger + live token budget + escalation ping are the follow-ons.

### Invariants preserved

#2 (TS-only; the report is generated text, no new language surface, no charting lib) · #3
(the report is best-effort and never gates anything; the fail-closed scanner is still the
boundary) · #5 (no untrusted content enters the prefix; the report is a post-hoc artifact) ·
#8 (`goal-report` is an ACP **ChatEvent**, the UI stream — not an `EventName` provenance event) ·
path confinement via `pathWithin` for the on-disk report.

### Relates to

ADR-0046 (the maker/checker loop + durable memory this instruments); ADR-0047 (automations —
their background ticks now also produce a report); ADR-0048 (the checker model whose verdicts
feed the stall guard); ADR-0049/0050 (the launcher/cost estimate this complements with
*actuals*); `cobusgreyling/loop-engineering` (failure-modes #1 Infinite Fix Loop, State Rot,
Token Burn; ship-readiness §9 Observability — the external review that motivated this).

-----

## ADR-0055 — Cross-run evaluation: the `/goal` loop run-log + stats surface (P-GOAL.10)

**Date:** 2026-06-25
**Status:** Accepted — shipped this increment.
**Context increment:** P-GOAL.10.

### Context

ADR-0054 (P-GOAL.9) gave each `/goal` run an After-Action Report — metrics + graphs for ONE
run. loop-engineering's ship-readiness rubric (§9 Observability) also asks for the cross-run
view: "success metrics established", an "append-only run history" the team can read without
chat logs. That is the "metrics/evaluation layer" the user asked for in the original review.
We already compute a rich `LoopMetrics` per run (ADR-0054); nothing yet persists it across runs
or aggregates it.

### Decision

A flat, append-only **JSONL ledger** plus a PURE aggregator, reusing the P-GOAL.9 metrics.

- **`desktop/loop_runlog.ts`** (PURE; no I/O, no `Date.now()`; unit-tested):
  - `toRunRecord(LoopMetrics, {id, ts})` projects a finished run into a compact `LoopRunRecord`
    (outcome, iterations, duration, tool totals + by-type, LOC, errors, websites). `id`/`ts`
    come from the backend (pure modules can't read the clock).
  - `runRecordLine` / `parseRunLog` serialize to / from JSONL; a malformed line is skipped, never
    fatal (append-only, best-effort).
  - `aggregateRuns(records): RunStats` — runs, success rate, **average iterations-to-success**
    (over met runs only), avg duration, summed tools/LOC/errors, and a **failure breakdown** that
    groups non-success runs by recurring blocker via `stallSignature` (so "3 of 5 tests fail" and
    "2 of 5 tests fail" collapse to one). `summarizeRunStats` gives a one-line chip.
- **Persistence — `.omp/loops/run-log.jsonl`** (`appendRunLog`/`readRunLog` in `goal_memory.ts`,
  path-confined, best-effort). `runGoal`'s `finally` appends one line per completed run, right
  after writing the AAR — so the ledger and the per-run report are produced together as the
  loop's last task.
- **Surface** — backend `loopRunStats()` → `GET /api/goal/stats` → a compact **evaluation banner**
  in the `/goal` launcher (success rate, avg iters-to-win, avg duration, tool mix, most-common
  stop). Hidden until there's history, so a first-time user sees nothing extra.

**Why JSONL, not DuckDB.** The desktop `/goal` loop persists to `.omp/loops/` markdown
(goal-memory, ADR-0046) — this stays in that lightweight, air-gap-clean lane. The DuckDB schema
(invariant #10) is the harness security/provenance pipeline, a different layer; a per-loop eval
ledger does not belong there and must not trigger a migration. The flat file is inspectable,
append-only, and trivially exportable.

### Alternatives considered

- **Write to the DuckDB telemetry store.** Rejected — couples the desktop loop to the harness
  analytics DB + a frozen-schema migration (invariant #10) for a lightweight, workspace-local
  ledger. JSONL keeps it in the goal-memory lane.
- **Recompute stats by scanning the markdown memory/report files.** Rejected — parsing prose for
  metrics is brittle; a typed JSONL record is the stable contract the aggregator reads.
- **A full history table UI.** Deferred — the launcher banner is the high-value at-a-glance view;
  a deeper drill-down can come later (the records carry enough to build it without a migration).

### Invariants preserved

#2 (TS-only; pure aggregator + a flat file, no new language surface) · #3 (the ledger is
best-effort and never gates the loop; the fail-closed scanner remains the boundary) · #10 (does
NOT touch the frozen DuckDB schema — a separate workspace-local JSONL file) · path confinement via
`pathWithin` for the ledger.

### Relates to

ADR-0054 (the After-Action Report + `LoopMetrics` this serializes across runs); ADR-0046/0047
(the loop + automations whose every run now logs); `cobusgreyling/loop-engineering` (ship-
readiness §9 Observability — "append-only run history", "success metrics established"). Follow-ons:
a live per-loop token budget + kill switch, and an escalation ping on unattended stop.

-----

## ADR-0056 — Live per-loop spend meter + budget kill switch (P-GOAL.11)

**Date:** 2026-06-25
**Status:** Accepted — shipped this increment.
**Context increment:** P-GOAL.11.

### Context

loop-engineering's costliest failure mode is **Token Burn** — an unattended loop running full
turns until "the bill spikes"; its prescribed mitigation is a "daily budget limit" / "kill
switch". ADR-0049 already shows a pre-run cost ESTIMATE in the launcher, but the running loop had
no view of ACTUAL spend and no ceiling that could halt it. The only bound was `maxIters`, which
says nothing about dollars. For long-running / scheduled loops — exactly the ones the user cares
about — that's the gap.

### Decision

A live spend meter fed by the maker's usage telemetry, plus a hard dollar cap that stops the loop.

- **`desktop/loop_budget.ts`** (PURE, unit-tested): `LoopSpend` + `addTurnSpend` (sum each maker
  turn's PEAK cost; track context tokens as a high-water mark, never summed — `used` is cumulative
  within the persistent maker session), `overBudget(spent, cap)` (the kill switch — a non-positive
  cap means "no budget"), and `normalizeBudget` (clamp the user's input to a non-negative $ amount).
- **Why per-turn peak, summed.** `runGoal` owns the turn boundaries, so accounting needs no fragile
  counter-reset detection: omp's `usage_update.cost` is a per-turn figure, and each maker iteration
  is one turn, so total spend = Σ(per-turn peak cost). The checker runs in a separate throwaway
  `complete()` session whose usage never reaches the loop sink, so the meter measures maker spend —
  the dominant cost (the checker is cheap by ADR-0048's design).
- **Kill switch, two-stage.** In the maker sink, the moment `spend + thisTurnPeak` crosses the cap
  we `cancel()` the in-flight turn (stops mid-stream). After the turn, if `overBudget` we end the
  loop with `stopped: budget cap $X reached (spent $Y)` — before spending a checker call. The bill
  cannot run away unattended.
- **Surfaced everywhere the metrics already flow.** `LoopMetrics` gains `spendUsd` /
  `peakContextTokens` / `budgetUsd` (spend is `null`, not `$0`, when no usage telemetry was seen);
  the After-Action Report shows a "Spend $X of $Y cap · peak context N" row (ADR-0054); the run-log
  record + cross-run eval sum actual spend (ADR-0055); the launcher gains an optional "Budget cap"
  field next to Max iterations.

### Alternatives considered

- **Budget in tokens.** Rejected as the primary unit — "Token Burn" is about the bill, and `used`
  is cumulative context (re-counts the cached prefix each turn), so a token cap would be confusing.
  Dollars are what the user sets a ceiling on; tokens are shown as informational peak context.
- **Reset-detecting accumulator over a possibly-cumulative cost counter.** Rejected — the loop owns
  turn boundaries, so "sum per-turn peaks" is exact and simpler than guessing counter semantics.
- **A cap on scheduled automations too.** Deferred — needs an `Automation` schema field + form; the
  iteration cap still bounds automations today. A clean follow-on.

### Invariants preserved

#2 (TS-only; a pure meter, no new surface) · #3 (the meter is best-effort telemetry and the kill
switch only ever stops EARLY — it can never let a run continue past a limit; the fail-closed gate
remains the safety boundary) · #6 (the budget field is user-turn/launcher state, never the frozen
prefix). No schema/DuckDB change (spend rides the ADR-0055 JSONL ledger).

### Relates to

ADR-0049 (the pre-run cost estimate this complements with ACTUALS), ADR-0054 (the AAR that now
shows spend), ADR-0055 (the run-log/eval that now sums spend), ADR-0048 (the cheap checker that
keeps the meter ≈ maker spend); `cobusgreyling/loop-engineering` (Token Burn — "daily budget
limit", "kill switch"). Remaining follow-on: an escalation ping on unattended stop.

-----

## ADR-0057 — The Pre-Flight Audit: loop design + readiness before you build (P-GOAL.12)

**Date:** 2026-06-25
**Status:** Accepted — shipped this increment.
**Context increment:** P-GOAL.12.

### Context

loop-engineering ships two CLIs — `loop-init` (scaffold run-log/budget/state templates) and
`loop-audit` (score a repo 0→100, L0→L3, on readiness for unattended loops). We already *generate*
live what they scaffold static (run-log P-GOAL.10, budget kill switch P-GOAL.11, goal-memory
P-GOAL.4), so adopting the CLIs would be redundant + drift (Node CLIs for grok/codex workflows;
we're in-process Bun/Electron). But their **readiness rubric** is valuable — reframed from "is this
REPO ready?" to "is THIS loop well-formed?", surfaced at the moment of building a loop. The user
asked for an active **"Pre-Flight Audit"**: an optional button above the Goal input that pauses the
builder, scopes the loop (branch/worktree) and runs a prompt-engineering interview, reads past-run
history so context isn't lost, folds in **user/product-owner AND engineer** feedback, and emits a
**repeatable Loop Design report (.md)** the user adopts as the goal — whose matured success criteria
thread to the small checker so it grades against the real design. The whole thing closes a
**recursive self-improvement loop**: each run's After-Action Report + run-log feed the next loop's
Pre-Flight, which matures the next goal.

### Decision

- **`desktop/loop_preflight.ts`** (PURE, unit-tested): `assessReadiness` scores the spec L0→L3 with
  **gated** levels (L3 "unattended-capable" REQUIRES the safety-bearing four — verification command,
  budget cap, explicit scope, cheap checker — so a verbose goal can't buy L3 without a real verifier,
  defeating *Verifier Theater*). `renderLoopDesign` emits the repeatable report; `maturedGoalFrom`
  distills the adoptable goal; `successCriteria` distills the checker's grading rubric. History:
  `relevantPriorRuns` / `summarizePriorRuns` / `renderPriorRuns` surface prior runs of a similar loop
  (their AARs live in `.omp/loops/`). Interview: `preflightSystemPrompt` / `preflightUserPrompt` /
  `parsePreflightJson` / `mergeMatured` (user-provided values always win; the model fills blanks).
- **Backend** `preflightAudit(spec)`: reads the run-log for history, runs ONE interview pass on the
  cheap **checker** model (`complete()`, best-effort; deterministic fallback to the user's answers if
  the model is unavailable), scores readiness, writes the Loop Design under `.omp/loops/*.preflight.md`,
  and returns the matured goal + criteria + report. `loopScopes()` lists branches/worktrees (git,
  best-effort). It mutates nothing — a planning step.
- **Checker context (deterministic grading).** `runGoal`/`checkGoal` gain an optional `criteria`; the
  small checker now grades against the matured success criteria and **reports back which are met/unmet**
  — appropriate context, not a bare condition. Adopting a Pre-Flight design stashes its criteria and
  threads it to the next run.
- **UI**: an optional "Pre-Flight Audit" button above the Goal field opens a panel (scope picker +
  interview incl. user/PO feedback + engineer notes), runs the audit, shows the readiness chip + the
  rendered report + prior-run note, and "Adopt as goal" fills the Goal field (+ command) and stashes
  the criteria. The builder is paused until the user adopts or closes.

### Alternatives considered

- **Vendor loop-init / loop-audit.** Rejected — Node CLIs that scaffold static markdown for grok/codex;
  we already generate those live, and a CLI surface cuts against "extend, don't fork".
- **Open-ended multi-turn interview chat.** Rejected for this increment — a structured interview + one
  model maturation pass is reliable, testable, and bounded; a multi-turn agent can come later.
- **A passive readiness chip only.** Rejected — the user wanted an active design step that produces an
  adoptable artifact and carries history/feedback forward (the self-improvement loop).

### Invariants preserved

#2 (TS-only; a pure core + a model call via existing `complete()`, no new surface) · #3 (best-effort
throughout — git scopes, the model interview, the report write all degrade gracefully; the checker
stays fail-closed and the gate is still the boundary) · #5 (the matured goal is shown to the user to
review/edit before it ever runs — human in the loop) · #10 (the Loop Design + preflight reports are
flat `.omp/loops/` files; no DuckDB schema change).

### Relates to

ADR-0048 (the cheap checker that runs the interview + now grades against criteria), ADR-0054/0055
(the AARs + run-log this reads for history — the recursive loop), ADR-0056 (the budget cap the rubric
checks), ADR-0046/0047 (the loop + automations); loop-engineering's `loop-audit` rubric (L0→L3) and
`loop-design-checklist` (the report's shape). Follow-on: a budget field for automations; an escalation
ping on unattended stop.

-----
## ADR-0058 - P-RAG.1: the local knowledge spine (scan-gated ingest + offline cosine retrieval)

**Date:** 2026-06-24
**Status:** Accepted - BUILT.
**Increment:** P-RAG.1 (first build increment under ADR-0053).

### Context

ADR-0053 scoped the Knowledge module as one large increment (schema + PDF parse + WASM embedder +
retrieval + Knowledge popup + injection). Building all of that in one session is exactly the
half-finished-increment failure CLAUDE.md warns against, and the heaviest pieces (bundling ONNX weights,
`unpdf`, live multimodal captioning) need network / real environments that cannot be verified
deterministically in this dev host. So P-RAG.1 is narrowed to the load-bearing, air-gap-clean,
fully-testable CORE - the data + security + retrieval spine - and the heavy/UI pieces move to follow-ons.

### Decision - what P-RAG.1 builds (server-side, no new runtime deps)

1. **Separate `knowledge.duckdb`** (ADR-0053 decision #3). `Db.open(path, migrationsDir?)` gained an
   optional second arg selecting the migration set; it defaults to the core memory schema, so every
   existing caller is unchanged. The knowledge store passes its own dir
   (`harness/knowledge/migrations`), so migration `0010_knowledge_vectors.sql` applies ONLY to
   knowledge.duckdb and never to `agent_obs.duckdb` (invariant #10; frozen migrations untouched).
2. **Migration 0010** - `kb_datasets` (id, name, classification U|CUI, source local|asksage,
   embedding_model, dim) + `kb_chunks` (chunk_id, dataset_id FK, artifact_id soft-ref, source_path,
   ordinal, text, trust_label, `embedding FLOAT[]`, dim). The 0010 number keeps project migration
   numbering globally unique even though this is a distinct database.
3. **`chunk.ts`** - pure, deterministic, overlapping, boundary-preferring text chunker.
4. **`embedder.ts`** - an `Embedder` INTERFACE (`{id, dim, embed()}`) plus `HashEmbedder`, a
   deterministic, dependency-free hashed-bag-of-words embedder (L2-normalized). The pipeline depends on
   the interface, NOT a model, so the spine is testable and air-gap-clean today; P-RAG.1b drops in the
   real WASM `bge-small-en-v1.5` (384-dim) behind the same interface with weights bundled.
5. **`ingest.ts` `ingestText`** - the security keystone: chunk -> SCAN each chunk fail-closed
   (`scanAndDecide`/DEFAULT_POLICY, same seam as persona/skill import) -> embed ONLY clean chunks ->
   store with their trust label. A blocked chunk (quarantined, suspicious-over-threshold, OR
   scanner-unavailable) is NEVER embedded and NEVER stored. An `onBlock` audit hook lets the desktop
   layer `recordBlock()` without this harness module importing the desktop security log (clean layering).
6. **Retrieval** - `KnowledgeStore.retrieve()` brute-forces top-k by DuckDB's built-in
   `list_cosine_distance` (no vss/HNSW extension - air-gap clean). `wrapRetrieved()` renders hits inside
   `UNTRUSTED_CONTENT_START/END` for late, delimited injection (invariant #5/#6).

### Vectors are inlined as numeric SQL list literals (not bound params)

The `@duckdb/node-api` binding rejects a JS array bound as a parameter ("Cannot create values of type
ANY"). Probed: `list_cosine_distance(embedding, [<literal>])` works with no cast, on both INSERT and
SELECT. Embedding components are machine-generated finite floats (never user text), and `floatList()`
throws on any non-finite component, so inlining is safe and keeps retrieval in SQL.

### Deferred (explicit, so the boundary is honest)

- **P-RAG.1b** - real WASM text embedder (`@huggingface/transformers`, `bge-small-en-v1.5`) with weights
  bundled as extraResources; `unpdf` PDF->text; wire both behind the existing `Embedder` interface.
- **P-RAG.1c** - the Knowledge popup (guided + advanced, P-GOAL.8 pattern) for the LOCAL path, a
  `knowledge.duckdb` at a fixed app path, desktop `recordBlock` wiring via `onBlock`, and per-turn
  retrieval injection mirroring the dataset selector (ADR-0053 decision #4).
- **P-RAG.2** images/multimodal; **P-RAG.3** AskSage dataset training; **P-RAG.4** ranking/citations + HNSW.
- New `EventName`s (`knowledge_ingested`/`chunk_embedded`/`knowledge_retrieved`) remain deferred - a
  `contracts.ts` change is its own increment (ADR-0053); the spine reuses existing block-audit plumbing.

### Verification

`bun test harness/knowledge` 20/20 (chunk bounds/overlap/determinism; embedder shape/normalization/
ranking; store CRUD + cosine ranking + dim-mismatch-throws + dataset scoping; ingest clean-stores /
poison-blocked-never-stored / dead-scanner-fails-closed / delimited-wrap). Full harness 493, desktop 326,
typecheck clean (3 cfgs). `make demo-P-RAG.1` (`demo_prag1.ts`) proves the property against the REAL
scanner sidecar + a real temp knowledge.duckdb: clean doc stored, Trojan-Source (bidi U+202E + zero-width
U+200B) note blocked and never stored, cosine retrieval returns the relevant chunk first, injection
delimited.

### Invariants preserved

#2 (TS-only - no new Python; the scanner stays the only Python) - #3/#5 (every chunk scanned fail-closed,
stored with a trust label, injected only delimited + late) - #9 (stable Snowflake `*_id` for
datasets/chunks) - #10 (a new numbered migration in its own set; frozen ones untouched; `Db.open` change
is additive) - keystone #2 (RAG chunks are retrieval context, never auto-promoted into semantic memory).

### Relates to

ADR-0053 (the RAG scope/plan this first-builds); ADR-0045/P-SKILL.1 (the scan-gate import seam reused);
ADR-0012 (classification); ADR-0019 (gate/quarantine surfacing); CLAUDE.md invariants #2/#3/#5/#9/#10 +
keystone #2.

## ADR-0059 - P-ASKSAGE.1: AskSage tool-loop diagnostics + tolerant response extraction

**Date:** 2026-06-24
**Status:** Accepted - BUILT.
**Increment:** P-ASKSAGE.1.

### Context

Live UI testing surfaced a real defect the mocked tests could not: AskSage **Claude** and **Gemini**
models run tools (files get partially written) but then the agentic loop "gives up too soon" - no retry,
no visible reasoning, half-done work. The same prompts complete fine on the public (non-AskSage) models.
AskSage **GPT** is noticeably better. That last fact is the key clue: GPT goes through omp's NATIVE
`openai-completions` provider (real streaming, omp's battle-tested loop), while Claude/Gemini go through
our custom NON-streamed `streamSimple` adapter (`asksage_stream.ts`, ADR-0007/0051). So the early
termination is isolated to our adapter.

Most likely mechanism, and it is silent: each `streamSimple` call is one HTTP round-trip = one assistant
turn; omp drives the loop. If a follow-up response is parsed to EMPTY text + ZERO tool calls - because
the AskSage proxy wrapped the body in a shape our strict parser does not read - we emit a clean
`done`/`stop` with empty content, and omp concludes the model finished. The mock hand-builds the standard
Anthropic/Gemini shapes, so it never exercises a wrapped/odd live shape.

The user chose "add diagnostics first" (cannot reach the live gov gateway from the dev host), so this
increment makes the loop OBSERVABLE and adds the one safe robustness fix.

### Decision - per-call diagnostics (env-gated), surfaced in the developer Logs panel

`asksage_stream.ts` emits one `[ASKSAGE_DIAG] {json}` line per call to stderr when
`LUCID_ASKSAGE_DEBUG` is set. Each record carries the request summary (route, model, maxTokens, tool
names sent, message count) and the parsed response (HTTP status, top-level response keys, `via` = which
shape matched, text length, tool-call names, stopReason, usage). The give-up smoking gun is called out
explicitly: when an OK response yields empty text AND no tool calls, the record gets
`anomaly: "empty-response"` plus a truncated raw snippet; a `length`/`MAX_TOKENS` finish gets
`anomaly: "truncated"`. HTTP and fetch errors are logged with a raw snippet too.

`acp_backend.ts` enables `LUCID_ASKSAGE_DEBUG` in the omp child (inherited at spawn) **when developer
mode is on** - zero overhead otherwise - and its `onStderr` parses `[ASKSAGE_DIAG]` lines into a bounded
in-memory ring (last 200), echoing them to the dev-server console. `/api/dev` exposes the ring (developer
mode only); the renderer's **Logs -> AskSage tool calls** accordion shows one row per call and
auto-opens, with a chip, when any anomaly/error is present. Because the child reads the env only at
spawn, toggling developer mode (`POST /api/dev`) calls `backend.restart()` on a real change, so the
diagnostics take effect immediately with no app restart (the same respawn pattern as an API-key change).

### Decision - tolerant response extraction (the one safe fix)

`anthropicBlocks()` / `googleParts()` locate the content blocks/parts tolerantly: the standard shape
first (`content[]` / `candidates[0].content.parts`), then known wrappers (`response.content`,
`message.content`, OpenAI-style `choices[0].message` with `tool_calls`, or a plain string under
`response`/`message`/`completion`/`text`/`answer`). Fallbacks fire ONLY when the strict parse finds
nothing, so they can only RECOVER content that would otherwise be dropped (turning a premature empty stop
into a real turn), never change a good parse. `via` records which path matched, so a live test reveals
the real wire format rather than guessing.

### Deliberately deferred (pending the live diagnostics)

- Relaying the model's THINKING blocks (no reasoning is currently shown) - needs the live shape first.
- Raising/overriding `max_tokens` if `truncated` turns out to be the cause (diagnostics will say).
- Confirming omp re-invokes `streamSimple` after each tool result for a custom provider (the per-call
  log makes the invocation count visible). If it does not loop, that is a deeper omp-integration fix.
- A live gov-gateway tool round-trip remains the manual check this dev host cannot run.

### Verification

`asksage_stream.test.ts` 14/14 (the original 7 + 7 new: tolerant `response.content` / OpenAI-`choices` /
wrapped-Gemini recovery; diag off without the env; diag records request+parse; `empty-response` anomaly
flagged with a raw snippet; HTTP-error diag + stream error). Full harness 500, desktop 326, typecheck
clean (3 cfgs), renderer bundles. `make demo-P-ASKSAGE.1` proves wrapped replies are recovered, empty
turns are flagged, and diagnostics are off by default.

### Follow-ups from live testing

- **Stop now actually stops AskSage.** `SimpleStreamOptions.signal` carries omp's AbortSignal, aborted on
  session/cancel. The adapter ignored `_options`, so a non-streamed AskSage fetch (one long request per
  turn) kept running after Stop and the turn hung. Threaded `options.signal` into every fetch
  (anthropic/google/query) and, on abort, settle with a clean `done`/stop (no error toast). Native-provider
  models (GPT, public Claude) were already cancellable by omp; this closes the AskSage gap.
- **Developer Logs are live + readable.** The 4s poll now re-fetches `/api/dev` while the Logs tab is open
  (AskSage rows + transcripts no longer go stale mid-turn). Turn transcripts and AskSage calls render
  newest-first with a US-Eastern (`America/New_York`, auto EST/EDT) timestamp column.

### Invariants preserved

#2 (TS-only) - #3/#4 (every tool call the adapter surfaces is still scanned by the in-process gate;
diagnostics never bypass it) - the frozen prompt prefix is untouched (no prompt bytes changed). Logging
is metadata + a truncated snippet to stderr, developer-mode-gated, never persisted to the store.

### Relates to

ADR-0007 (the AskSage adapter), ADR-0051 (tool use added to the Claude+Gemini routes - the path this
hardens), ADR-0009 Phase D (the developer Logs panel reused), CLAUDE.md invariants #2/#3/#4/#6.

## ADR-0060 - Turn wellness-check + auto-continue ("is the big model still awake?") (SCOPE/PLAN)

**Date:** 2026-06-24
**Status:** Proposed - scope + plan only; no behavior code yet. Splits into P-CONTINUE.1..2.
**Context increment:** P-CONTINUE (planning).

### Context

Long turns can stop SHORT, and the user has to notice and type "continue":
- **Idle stall:** the non-streamed AskSage gov gateway emits nothing for minutes during a big call; the
  idle cap (now 5 min, ADR-0059 follow-up) ends the turn ("gave up on the provider"). Native streaming
  models rarely hit this - they emit tokens every few seconds.
- **Cut off:** the model stops mid-task (stopReason length/truncated, or it just ends early).

The user's idea: when a turn looks unfinished, have a SMALL, FAST model of the SAME family "check on the
big guy" - read the chat history, decide if the work is actually done, and if not, automatically push the
big model for another turn to finish, showing the check in the thinking panel. This is the `/goal`
maker/checker pattern (ADR-0046) applied to chat continuation, reusing `complete()` with a model override
(ADR-0048) and the existing thinking stream (ADR-0027).

### Decision - the loop

After a chat turn ENDS, if it looks potentially INCOMPLETE, run a CHECKER (cheap same-family model) on the
last user request + the assistant's final message. The checker returns COMPLETE or INCOMPLETE + a one-line
"what remains". If INCOMPLETE and under a cap, auto-send a continuation prompt to the BIG model on the same
session; surface the whole thing in the thinking panel. Stop when the checker says COMPLETE or the cap hits.

### Decision - when to trigger (conservative, cost-aware)

Run the checker ONLY when there's a real cut-off signal: the turn **idle-stalled**, OR stopReason was
**length/truncated**. Do NOT run on: a user-cancelled turn (Stop), an empty/errored turn, a `/goal` loop
turn (it has its own checker), or a turn that ended with a normal `end_turn` and no truncation (default:
assume complete - no checker, no cost). P-CONTINUE.2 may add a heuristic "looks mid-task" trigger
(unclosed code fence, ends on "Let me.../Next I'll...").

### Decision - checker model (same family, smaller)

Map the active model to its fast/small SAME-family sibling: Gemini Pro -> Gemini Flash; Claude Sonnet/Opus
-> Claude Haiku; GPT-big -> GPT-mini. Reuse `model_families.ts` + `recommendCheckerModel`
(`checker_model.ts`). For AskSage models, keep the checker on the AskSage route of the SAME family (gov
compliance - never route gov content to a non-gov checker). Fall back to the same model if no smaller
sibling exists. The checker runs via `complete(system, user, { model })` - a throwaway session that never
pollutes the chat (ADR-0048).

### Decision - the verdict is fail-closed

The checker is prompted to answer strictly `COMPLETE` / `INCOMPLETE` + reason + what-remains. Parsing
mirrors `parseGoalVerdict` (`goal_verdict.ts`): empty/garbled/ambiguous => treat as COMPLETE. Better to
under-continue than to loop forever. A hard cap `maxAutoContinue` (default 2) bounds it regardless.

### Decision - UX

Show the check live in the THINKING panel: "Checking whether the last turn finished... the response looks
cut off; asking the model to continue (what remains: ...)". The auto-sent continuation renders as a normal
assistant turn with a subtle "auto-continued" marker so the user knows it was the wellness-check, not them.
A Settings toggle (default ON, with the cap shown) lets users disable it. Continuation prompt: "Continue
and finish what you were doing - <what remains>. Do not repeat work you already completed."

### Phasing

- **P-CONTINUE.1** - core: detect cut-off (stall / length), pick the same-family checker, run it via
  `complete()`, auto-send ONE continuation on INCOMPLETE, fail-closed verdict, cap + Settings toggle,
  thinking-panel surfacing.
- **P-CONTINUE.2** - heuristic "looks mid-task" trigger, sharper "what remains" extraction, multi-continue
  tuning, and per-provider rate-limit backoff (don't hammer a 429'd gov gateway).

### Invariants preserved

#3/#4 (continuation turns + the checker's view still pass the in-process gate - every tool call scanned;
the checker only ever sees gate-clean assistant text) - #5 (no untrusted text enters the frozen prefix) -
keystone #2 (the checker is ephemeral judgment via `complete()`, never promoted to memory). The checker
is maker != checker (a different/smaller model), echoing the `/goal` separation.

### Relates to

ADR-0046 (`/goal` maker/checker loop reused), ADR-0048 (distinct recommended checker model + `complete()`
model override), ADR-0027 (the thinking stream surfaced to the UI), ADR-0059 (the idle-cap bump + AskSage
non-streamed adapter this compensates for), `model_families.ts` / `checker_model.ts`.

## ADR-0061 - P-RESIL.1: AskSage call resilience (retry transient 5xx + MALFORMED_FUNCTION_CALL)

**Date:** 2026-06-24
**Status:** Accepted - BUILT.
**Increment:** P-RESIL.1.

### Context

Live `[ASKSAGE_DIAG]` capture (developer mode, ADR-0059) showed two transient failures burning whole agent
turns - and 100k-200k INPUT tokens each - for zero output:
- **HTTP 504** from the gov gateway (overloaded/slow on big requests).
- Gemini **`finishReason: MALFORMED_FUNCTION_CALL`** with an EMPTY body: the model tried to emit a tool
  call, failed to form valid arguments, and returned nothing. Our adapter parsed it as `empty-response`,
  so omp got an empty turn and the loop wasted a step (often repeatedly).

Both are usually TRANSIENT (a 504 clears; a malformed call is stochastic at temperature), so a bounded
retry recovers the turn instead of wasting it.

### Decision

In `callAnthropic` and `callGoogle` (asksage_stream.ts), wrap the fetch + parse in a bounded retry loop:
`MAX_ATTEMPTS = 3` with short backoff `[800ms, 2000ms]`. Retry when:
- the fetch throws (network blip) and it was NOT a user abort,
- the HTTP status is **retriable** (`429` or `5xx`),
- (Gemini only) `finishReason === "MALFORMED_FUNCTION_CALL"` AND the parse yielded no text and no tool call.

Do NOT retry: success, 4xx client errors (except 429), or a user **Stop** (the abort signal short-circuits
the loop AND the backoff - `backoff()` rejects immediately on abort, so Stop never waits out a delay).
Each retry is logged (`retry:true`, `attempt`) so the diagnostics show the recovery. A persistent failure
still throws after the 3rd attempt (unchanged terminal behavior). A persistent malformed call is now
labelled `anomaly: "malformed-function-call"` (distinct from a plain `empty-response`) for the Logs panel.

### Why bounded + short

Three attempts with sub-2s backoff bounds the added latency (worst case ~2.8s) and the extra gov-gateway
load, while clearing the common one-off glitch. It is deliberately NOT an unbounded retry (that would mask
a real outage and hammer a rate-limited gateway). The auto-continue checker (ADR-0060) covers the
DIFFERENT case where the model legitimately stops short.

### Verification

5 new tests (asksage_stream.test.ts, 20 total): 504-then-success retries once and recovers;
MALFORMED-then-valid-tool-call recovers; persistent 504 gives up after exactly 3 attempts and errors; a
4xx is not retried; a first-try success makes exactly one request. Full harness 506, typecheck clean.

### Invariants preserved

#2 (TS-only) - #3/#4 (retries change nothing about the gate: every recovered tool call is still scanned
in-process) - the frozen prompt prefix is untouched. Retries are abort-aware so Stop (ADR-0059) still
cancels instantly.

### Relates to

ADR-0007/0051/0059 (the AskSage adapter + diagnostics this hardens), ADR-0060 (auto-continue, the
complementary fix for legitimate short-stops), CLAUDE.md #2/#3/#4.

## ADR-0062 - P-EGRESS.1: per-website approval for the agent's network-reaching tools

**Date:** 2026-06-24
**Status:** Accepted - BUILT.
**Increment:** P-EGRESS.1.

### Context

Live testing showed the agent autonomously navigating to arbitrary internet sites with omp's `browser`
tool (improvising a base64 upload of an audio file). In a security/provenance product, silent egress to
unknown hosts is a real risk (exfiltration, SSRF, fetching hostile content). The gate scans tool-call
CONTENT for hidden Unicode but does not govern WHERE the agent reaches. The user asked for a
prompt-before-each-external-fetch flow with rich, persisted choices.

Root cause of the silent browsing: omp's `tools.approvalMode` defaults to **`yolo`** (auto-approve all
tiers). But `tools.approval` (per-tool policy) is **honored in every approval mode** - so a per-tool
`prompt` override forces omp to request permission even under yolo.

### Decision - omp config forces a prompt; the desktop owns the dialog

`acp_config.yml` sets `tools.approval: { browser: prompt, web_search: prompt, web: prompt, fetch: prompt }`.
omp then sends `session/request_permission` for those tools. `acp_backend.onRequest` recognises an egress
request - by tool name OR by the call carrying an external `http(s)` URL (omp may report `browser` with a
generic kind, so name alone can miss it) - and, instead of the Agent-mode auto-approve, runs `askEgress`:
the per-website approval dialog. A standing decision can still auto-allow without prompting. Fail-closed:
no live UI / timeout (5 min) ⇒ the egress is BLOCKED.

### Decision - the five choices, and what they persist (egress_policy.ts)

The dialog offers four "Yes" and a "No", each mapped to a pure `EgressChoice` folded into a machine-level
store (`~/.omp/lucid-egress.json`):
- **allow-once** - approve this call, remember nothing.
- **allow-site** - approve + auto-allow this host forever (`allowHosts`).
- **ask-site** - approve, but PIN this host to always-prompt (`alwaysAskHosts`) - overrides danger mode.
- **danger** ("danger is my middle name") - global allow-all egress (`dangerMode`).
- **deny** - block; persist nothing.

`egressVerdict(store, url)` is fail-closed: `alwaysAsk` pin → prompt; allow-listed host → allow; danger →
allow; everything else (incl. an unparseable URL) → prompt. The decision logic is pure and unit-tested;
the chosen omp option (allow/deny) is resolved from omp's own `options`, so we never invent option ids.

### Decision - the dialog (the user's spec)

The card shows the **target URL prominently** with a **copy button**, a security note, and a **"Check this
site with Cloudflare Radar"** button that copies the URL and opens `https://radar.cloudflare.com/scan` in a
browser so the user can vet the site before allowing. Then the five choices, stacked. Amber-accented (it's
a network-egress gate, distinct from the standard Ask-mode card).

### Scope / deferred (P-EGRESS.2)

`web_search` (a search QUERY, no host) currently falls into the dialog as allow-once/danger/deny - the
per-site options are no-ops without a host; a query-aware variant is deferred. A Security-panel view of
egress decisions (and a "forget this site" / "exit danger mode" control) is deferred. Domain-allowlist
import and per-project (not just per-host) scoping are deferred.

### Verification

13 unit tests (egress_policy.test.ts): host extraction (URL / bare / junk), fail-closed verdict,
allow-list, danger mode, ask-site pin overriding danger, and choice-folding round-trips. Desktop 339,
typecheck clean, bundle OK; the dialog rendering was visually verified in the dev server. The LIVE
omp-permission round-trip (does omp emit request_permission for `browser` with the URL in rawInput?) is
the manual check - the config + the name-OR-url detection are built to handle either shape.

### Invariants preserved

#3/#4 (the gate is unchanged - it still scans every tool call; this adds an egress GATE on top, never
bypasses the content gate) - fail-closed (no UI / timeout ⇒ block) - the frozen prompt prefix is
untouched. Permission still parks the JSON-RPC response and pauses the idle clock (P-ACP.3), so a human
deciding is not a stalled turn.

### Relates to

ADR-0027/P-ACP.3 (the tool-permission forwarding this extends), ADR-0019 (the content gate this complements
with an egress gate), ADR-0059 (the diagnostics that surfaced the browser flailing). CLAUDE.md #3/#4.

-----

## ADR-0063 - P-RAG.1b: the real WASM embedder (bge-small-en-v1.5) behind the P-RAG.1 seam

**Date:** 2026-06-25
**Status:** Accepted - BUILT.
**Increment:** P-RAG.1b.

### Context

P-RAG.1 (ADR-0058) shipped the knowledge spine against a deterministic `HashEmbedder` stub: enough to
prove the scan-gate + store + cosine-retrieval plumbing, but a bag-of-words hash only matches SHARED
vocabulary - it has no notion of meaning, so "a small furry pet that meows" and "kittens are
housecats" look unrelated. The whole point of RAG is semantic recall. P-RAG.1b drops in a real model.

### Decision - one concrete embedder behind the existing seam

`TransformersEmbedder` (`harness/knowledge/transformers_embedder.ts`) implements the unchanged
`Embedder` interface (`id`, `dim`, `embed`) with **`bge-small-en-v1.5` (384-dim)** via
[transformers.js](https://github.com/huggingface/transformers.js) (`@huggingface/transformers`),
mean-pooled + L2-normalized so DuckDB `list_cosine_distance` stays meaningful. The model is loaded
LAZILY once and reused. Because it is just another `Embedder`, ingest.ts, store.ts, and every existing
test are untouched - **tests keep `HashEmbedder` (fast, no download); production passes this one**.

**Air-gap (ADR-0053).** `TransformersEmbedder({ modelPath })` sets `env.localModelPath` +
`env.allowRemoteModels = false`, so a bundled-weights deployment loads ONLY from disk and never reaches
the HuggingFace Hub. Without `modelPath` the model is fetched once and cached (dev / connected).

**Backend - WASM is the shipped path, deferred to P-RAG.1c.** transformers.js's Node build runs
`onnxruntime-node` (native CPU), which is present in the harness + dev server where ingest/retrieval run
today, so 1b works there now. The packaged desktop build excludes native binaries in favor of a WASM
backend (ADR-0053); transformers.js only exposes WASM through its separate **web build**
(`onnxruntime-web`), and `device: "wasm"` is NOT accepted by the node build. Wiring the WASM web build +
bundling the model weights as `extraResources` into the SHIPPED app is **P-RAG.1c** (the Knowledge UI
increment). This module is backend-agnostic - callers only ever see `Embedder` - so that switch never
touches ingest or retrieval.

**Scope - PDF deferred.** ADR-0053 paired the embedder with `unpdf` PDF->text. To keep one clean
increment, PDF (and image) ingest moves to **P-RAG.1c** alongside the ingest UI; 1b is the embedder.

### Consequences

- Retrieval is genuinely SEMANTIC. `make demo-P-RAG.1b` proves it: a query sharing **zero** content
  words with the target chunk still ranks it first (kittens d=0.47, vs unrelated 0.58 / 0.72), while the
  tampered note is still blocked fail-closed and the hit is still wrapped UNTRUSTED + delimited.
- New dep `@huggingface/transformers` (+ onnxruntime). It is NOT yet imported by the dev server / chat
  path (only the demo + test), so the packaged app loads no model until 1c wires it deliberately.
- The real-model test is opt-in (`LUCID_TEST_EMBED=1`); the normal suite stays fast and network-free.

### Invariants preserved

Same `Embedder` seam (#frozen-contract spirit - callers/tests unchanged); the fail-closed gate runs
UPSTREAM of the embedder, so poisoned text is never embedded (#3/#5); keystone #2 holds - RAG chunks are
retrieval context, never semantic-memory promotion.

### Relates to

ADR-0058 (the seam this fills), ADR-0053 (RAG scope: WASM / bundled weights / air-gap / the deferred PDF
+ UI), CLAUDE.md invariants #2 (transformers.js is JS/WASM, not a second Python) / #3 / #5 + keystone #2.

## ADR-0064 - P-RAG.1c (slice 1): PDF ingest through the unchanged scan gate

**Date:** 2026-06-25
**Status:** Accepted - BUILT.
**Increment:** P-RAG.1c, slice 1 of 4 (PDF; remaining: WASM packaging, per-turn injection, ingest UI + image captioning).

### Context

ADR-0053 paired the embedder with `unpdf` PDF->text; ADR-0063 deferred PDF to P-RAG.1c to keep the
embedder a clean increment. This slice adds PDF as an ingest SOURCE - the first of P-RAG.1c's four
independent slices - without touching the security-load-bearing ingest core.

### Decision - a PDF is just another text source; the gate is unchanged

`harness/knowledge/pdf.ts` adds two functions and NO new trust path:

- `extractPdfText(data)` pulls the text layer out page-by-page via **`unpdf`** (pdf.js serverless
  build - pure JS, no native binary, so it stays air-gap clean and bundles into the packaged app).
- `ingestPdf(args)` extracts, joins the pages with a blank line, and hands the text to the UNCHANGED
  `ingestText` (ADR-0058). So every page is chunked, **SCANNED fail-closed**, embedded, and stored
  exactly like a `.txt` source - poisoned text lifted out of a PDF is gated by the same DEFAULT_POLICY.

**Library choice - `unpdf`, not the transitively-present `mupdf`.** `mupdf@1.27` is only a transitive
dep of `markit-ai` (fragile - vanishes if that dep moves). `unpdf` is added as a DIRECT dependency, is
purpose-built for text extraction, and is the library ADR-0053 named. Both are pure-JS/WASM; `unpdf` is
the lighter, intentional choice.

**Fail-closed posture (two real surfaces, both proven).**
- A buffer with no `%PDF-` header, or one pdf.js cannot parse, **THROWS** - it is never read as empty
  text (a corrupt upload must not look like "clean, nothing to store"). The demo asserts a corrupt PDF
  throws and leaves the store count unchanged.
- A PDF whose extracted text trips the scanner is blocked per-chunk, and a dead scanner blocks every
  chunk - the same gate as text, covered by `pdf.test.ts` (a POISON page + a dead scanner).

**Honest scope note - the standard-font round-trip strips Unicode tricks.** A bidi/zero-width payload
embedded in a Helvetica content stream does NOT survive text extraction (it maps to ligatures/spaces
before the scanner sees it). So the threat the scanner catches on a PDF is poison in the *recovered*
text, not glyph-level Unicode attacks that extraction already neutralizes. The demo therefore proves the
PDF-boundary fail-closed with a corrupt buffer, and the per-chunk gate is proven in tests with an ASCII
marker - we do not stage a bidi-in-PDF demo that would misrepresent what stops it.

**Non-destructive extract.** pdf.js TRANSFERS (detaches) the typed array it is handed; `extractPdfText`
copies (`data.slice()`) first, so it never corrupts the caller's buffer and is safe to call twice.

**Test/demo fixture, no binary in git.** `pdf_fixture.ts` emits a minimal valid PDF (one Helvetica line
per page, correct xref offsets) so the suite needs no checked-in `.pdf`. It is a test-only writer, never
imported by production ingest.

### Consequences

- `make demo-P-RAG.1c` proves end-to-end: a real 3-page PDF -> scan gate -> real bge-small embeddings ->
  a zero-shared-word query ranks the right page first (kittens d=0.45 vs 0.58 / 0.70); a corrupt PDF
  fails closed; the hit is wrapped UNTRUSTED + delimited.
- New DIRECT dep `unpdf` (pure JS). Not yet imported by the dev server / chat path - only `pdf.ts`, its
  test, and the demo - so the packaged app pulls in no PDF code until a later slice wires the ingest UI.
- A scanned image-only PDF (no text layer) yields zero chunks, not an error - OCR / image captioning is
  a separate later 1c slice.

### Invariants preserved

The scan gate runs UPSTREAM of the embedder on PDF-extracted text exactly as on `.txt` (#3 fail-closed,
#5 untrusted-only-delimited); `unpdf` is JS/WASM, not a second Python surface (#2); `ingestText` and the
`Embedder` seam are untouched (frozen-contract spirit); keystone #2 holds - PDF chunks are retrieval
context, never semantic-memory promotion.

### Relates to

ADR-0063 (the embedder this feeds), ADR-0058 (the ingest seam it reuses), ADR-0053 (RAG scope: named
`unpdf`, air-gap, the remaining 1c slices), CLAUDE.md invariants #2 / #3 / #5 + keystone #2.

## ADR-0065 - P-RAG.1c (slice 2) FINDING: WASM-under-Bun is blocked; the embedder backend decision is deferred

**Date:** 2026-06-25
**Status:** Proposed - FINDING ONLY, decision DEFERRED (no code change this increment).
**Increment:** P-RAG.1c slice 2 (run the real embedder in the PACKAGED app). Spiked, not built.

### Context

The shipped embedder must run in the PACKAGED desktop app, not just the harness/dev server. Topology
(desktop/main.ts): the packaged app runs the harness by spawning the BUNDLED `bun` on `desktop/dev.ts`,
so ingest/retrieval/embedding execute under **Bun** (not the Electron renderer, not Node). ADR-0053 /
ADR-0063 ASSUMED the shipped backend would be transformers.js's WASM web build (onnxruntime-web), because
`desktop/package.json` excludes both `onnxruntime-node` and `onnxruntime-web` to keep the bundle lean and
"native-free". This increment set out to wire that WASM path. A feasibility spike says it does not work.

### Finding - the transformers.js WEB build cannot deliver the model under Bun

`@huggingface/transformers` resolves its **`node`** export under Bun -> `transformers.node.mjs` ->
`onnxruntime-node` (native). The WASM path is the **`default`/web** export -> `transformers.web.js` ->
`onnxruntime-web`. Spiking the web build (deep-imported by file path, since `exports` only maps "."):

- The WASM runtime **imports and runs under Bun** - no crash on browser globals. So WASM itself is fine.
- config.json / tokenizer.json load via a custom `env.fetch` shim that serves the LOCAL cached weights.
- The 133 MB **model.onnx fails**. Because Bun is detected as a node env (`apis.IS_NODE_ENV`), the web
  build calls `getModelFile(..., return_path=true)` - ORT wants a FILE PATH for the big model, not a
  buffer. But the web build's local-file reader is a BROWSER STUB (`node_fs_default.existsSync is not a
  function`), and a fetch-served `Response` is a buffer, not the `FileResponse.filePath` the path branch
  demands. The two loaders are mutually exclusive and both dead for that one file, and the stub is baked
  into the bundled web build - not reachable via `env`.

Net: pure-WASM-under-Bun with bundled weights is not achievable with the current transformers.js web
build without patching the vendored bundle.

### Options (for the deferred decision)

1. **Bundle `onnxruntime-node` per-platform (recommended).** Stop excluding it; ship the target platform's
   prebuilt ORT (the npm package already carries win/mac/linux + arm64/x64 binaries, ~211 MB unfiltered;
   electron-builder can prune to one platform's `bin/` ~tens of MB) + bundle bge-small weights
   (quantized ~30 MB) as `extraResources`; point the UNCHANGED 1b `TransformersEmbedder` at them via its
   existing `modelPath`. Air-gap clean, robust, zero embedder code change. Cost: ships a NATIVE ML runtime
   (reverses ADR-0053's WASM assumption) and adds ~40-90 MB to the installer. CI is already per-OS, so each
   build bundles only its own binary cleanly.
2. **Embed in the Electron renderer** (a real browser env, so the web build's WASM path works natively).
   Architecturally invasive: embedding moves out of the bun server, splitting ingest (renderer embeds ->
   server stores). Keeps it WASM/native-free but is a much bigger change.
3. **Patch the vendored `transformers.web.js`** to give it a working `node:fs` under Bun. Brittle - breaks
   on every transformers.js bump, fights the library. Not recommended.

### Decision

DEFERRED. Recorded so a future session picks with eyes open. The recommendation is Option 1
(bundle onnxruntime-node): it satisfies the REAL requirements - packaged + air-gap + win/mac/linux - and
reuses the unchanged embedder; "WASM" was a means, not an end. Revisit ADR-0053's native-free assumption
explicitly when this is taken up.

### Invariants preserved

No code changed; the fail-closed gate, the `Embedder` seam, and the frozen prefix are untouched. Whatever
backend is chosen, it stays UPSTREAM-gated and air-gap (local weights, no network) per #3 / ADR-0053.

### Relates to

ADR-0063 (the embedder that needs a shipped backend), ADR-0053 (the WASM / native-free assumption this
finding challenges), ADR-0064 (sibling 1c slice, PDF), CLAUDE.md invariant #3 + keystone #2.

## ADR-0066 - P-EXEC.1: per-action approval for the agent's exec tools (bash + eval) (SCOPE/PLAN)

**Date:** 2026-06-26
**Status:** Accepted - BUILT 2026-06-28 (issue #95). `exec_policy.ts` (classifier + verdict/apply/clamp,
107-test corpus), `acp_config.yml` bash/eval→prompt, `acp_backend` onRequest isExec branch + `askExec` +
in-memory allow-turn scope, renderer exec dialog (docked, high-risk red variant). `make demo-P-EXEC.1`.
**Increment:** P-EXEC.1 (v1 = bash + eval). ssh + task fast-follow as P-EXEC.2.
**Refined 2026-06-26:** program-level key (kept simple) + a non-silenceable catastrophic ALWAYS-PROMPT
set; added `allow-turn` (session-scoped, in-memory); exec danger-mode is a SEPARATE toggle from egress;
safe-program-dangerous-flag table; dropped precise out-of-workspace path analysis.

### Context - the gap

omp's permission schema already "requires confirmation for exec tools such as bash, eval, browser,
task, and ssh." P-EGRESS.1 (ADR-0062) closed that gap for the NETWORK tools: `acp_config.yml` forces
them to `prompt`, and the desktop intercepts `session/request_permission` to show a per-website dialog
EVEN in Agent mode, fail-closed. But the desktop's handler (acp_backend.ts) auto-approves everything
else in Agent / Plan mode (the default). So `bash`, `eval`, `ssh`, `task` run with NO human gate.

The in-process Unicode scanner still scans every tool call - but it catches MALFORMED / hidden content
(bidi, zero-width, homoglyph), NOT a perfectly well-formed destructive command: `rm -rf`,
`curl … | sh`, `dd`, `sudo`, `git reset --hard`, `ssh root@new-host`. Those are exactly the actions a
security/provenance product must put a human in front of. This is DEFENSE IN DEPTH, a distinct layer
from the scanner keystone - not a replacement for it.

### Decision - hybrid: a risk tier decides WHETHER to prompt; egress-style memory remembers the answer

Mirror the egress design (a pure verdict + pure apply + thin persistence + fail-closed), adding a risk
classifier so we do not nag on read-only commands.

**1. Risk tiering (the hard, over-tested part).** A pure `classifyCommand(cmd)` returns
`{ risk: "safe" | "risky", key: string | null }`:
- **safe** - argv0 is on a conservative read-only allowlist (`ls cat head tail grep rg find pwd echo wc
  which file stat`, read-only `git status|diff|log|show|branch`) AND the command carries NO
  semantics-changing markers AND no segment trips the **safe-program-dangerous-flag table** (refinement
  #2): a program that is read-only by default but destructive under a flag - `find -delete` / `find
  -exec`, `tar -x`, `sort -o`, `tee`, `xargs <risky>` - is forced to RISKY. Safe → auto-approve in Agent
  (still scanned).
- **risky** - ANY of: a mutating/dangerous program (`rm mv dd chmod chown sudo doas mkfs kill`), a
  network fetch (`curl wget nc scp ssh`), pipe-to-interpreter (`| sh|bash|python|node`), output
  redirection (`> >>`), command substitution (`$(…)` / backticks), chaining into a risky segment
  (`; && ||`), or package installs (`npm i`, `pip install`). Risky → prompt. **We do NOT attempt precise
  "writes outside the workspace" path analysis** (refinement #5 - unreliable from a raw command string and
  invites false confidence); redirection + write-capable-program markers + fail-closed cover it.
- **eval is ALWAYS risky** (arbitrary code execution) - it never auto-approves.
- **Fail-closed:** anything unparseable, compound-and-ambiguous, or simply unknown is classified RISKY.
  The classifier is a correctness keystone like the scanner: a clean read-only corpus must not produce
  prompts that matter, and a dangerous corpus must be 100% flagged. Over-test with fixtures.

**2. Standing decisions (the memory), keyed by PROGRAM.** When a risky call prompts, the dialog offers
five choices mapped to an `ExecChoice` folded into `~/.omp/lucid-exec.json` via a pure `applyExecChoice` /
`execVerdict`:
- `allow-once` → approve, remember nothing.
- `allow-turn` → approve + auto-allow matching risky calls for the REST OF THIS TURN/RUN only
  (refinement #3 - the missing middle for a legit multi-step risky sequence). IN-MEMORY ONLY: never
  written to `lucid-exec.json`, auto-expires when the turn/run ends. Lives on the backend turn state,
  not the store.
- `allow-program` → approve + auto-allow this argv0 (`git`, `npm`, …) from now on (persisted).
- `danger` → auto-allow ALL exec from now on. **A SEPARATE toggle from egress danger-mode** (refinement
  #4): it lives in `lucid-exec.json` and is never coupled to `lucid-egress.json` - enabling allow-all
  browsing must never enable allow-all shell (shell is the bigger blast radius).
- `deny` → block, no persistence.

**Keying = PROGRAM (argv0), with a non-silenceable catastrophic set.** The maintainer chose the simpler
program-level key over program+subcommand. To keep that simple key from re-opening the worst hole (an
`allow-program` for `git` would otherwise auto-run `git reset --hard`), a small fixed
**ALWAYS-PROMPT set ALWAYS prompts regardless of any standing allow or danger-mode** - mirroring how an
egress `ask-site` pin overrides danger: `sudo`/`doas`, `rm -rf`, pipe-to-interpreter, `dd`/`mkfs`, a fork
bomb, and `git reset --hard` / `git clean -f*` / `git push --force`. So a program-allow silences the
ordinary forms of that program but never a catastrophic one. A compound/unparseable command exposes ONLY
`allow-once` + `allow-turn` + `deny` (no safe program key to pin).

**3. Unattended automations block risky, run safe + pre-approved.** A `/goal` loop sets
`permissionMode:"auto"` (acp_backend.ts) and has no human to ask. There, the exec gate consults ONLY the
PERSISTED standing allowlist + exec danger-mode + the safe tier: a risky command with no standing allow is
BLOCKED (omp surfaces a rejected tool call; the loop records it). `allow-turn` is interactive-only (no
human = nothing to scope to), and the catastrophic ALWAYS-PROMPT set can never be auto-allowed, so it is
BLOCKED unattended. No silent auto-approve of an unrecognized risky command - fail-closed even when nobody
is watching.

### Plumbing (for the build increment)

- `desktop/exec_policy.ts` - mirrors `egress_policy.ts`: `ExecChoice`/`ExecStore`/`ExecVerdict`, pure
  `execVerdict` + `applyExecChoice`, `loadExec`/`recordExec`, the pure `classifyCommand` (with the
  safe-program-dangerous-flag table), and the fixed `ALWAYS_PROMPT` catastrophic-pattern set.
- `harness/omp/acp_config.yml` - add `bash: prompt`, `eval: prompt` under `tools.approval`.
- `acp_backend.ts onRequest` - a new `isExec` branch BEFORE the Agent auto-approve: classify; safe →
  approve; risky → if it hits `ALWAYS_PROMPT` skip standing allows; else turn-scope allow (in-memory) or
  `execDecision(key)` allow → approve; else live UI → `askExec` (mirror `askEgress`, showing the command +
  program); else (unattended / no UI) → block. The turn-scope set lives on the backend's turn state and is
  cleared when the turn/run ends. Fail-closed throughout.
- Renderer - extend the existing permission dialog with an exec variant (show the command + the program
  key); reuse the egress dialog's option rendering.
- `desktop/exec_policy.test.ts` - verdict/apply + a heavy `classifyCommand` fixture corpus (safe corpus
  → 0 false prompts; dangerous corpus → all flagged), the same rigor the scanner gets.

### Consequences / scope

- v1 covers bash + eval (highest-frequency + highest-risk). ssh (key = host - literally the egress
  model) and task (key = subagent type) are P-EXEC.2.
- A dedicated audit `EventName` (`exec_approved` / `exec_blocked`) is a `contracts.ts` change = its own
  increment (invariant #8); v1 reuses the existing permission/block emit plumbing.
- More prompts than today, but ONLY on genuinely risky actions; read-only agent work is unaffected.

### Invariants preserved

Fail-closed (#3) extends to a new layer; the frozen prompt prefix (#6) is untouched - this is runtime
permission logic, not prompt bytes; the scanner keystone is unchanged - this is defense in depth ON TOP
of it. Trust labels / event names are not redefined (no `contracts.ts` change in v1).

### Relates to

ADR-0062 (P-EGRESS.1 - the per-website pattern this mirrors), ADR-0028/0032 (the `task` tool + isolation,
relevant to P-EXEC.2), CLAUDE.md invariant #3 (fail-closed) + the scanner keystone (defense in depth).

### Addendum (2026-06-30) — P-GATE-DIAG.1: observe WHY the gate auto-denies (no-prompt diagnostics)

Two live runs (Claude, then GPT-5.5) showed the agent's verification tools (browser/bash/eval) **denied with
no approval prompt** — "I didn't even get an option to deny". omp is configured to forward these as permission
requests (acp_config.yml `tools.approval`), so the silent deny is OUR `onRequest` hitting the no-prompt block
path: the **interactive** check (`askActive && listener && !goalActive && !autoRunning`) was false when the
request arrived, so exec/egress fell through to the immediate fail-closed block instead of `askExec`/`askEgress`.
WHY it was false (a concurrency/state issue — chat `listener` clobbered by a concurrent utility completion? an
`autoRunning`/`goalActive` overlap? a model/streaming-path timing?) can't be pinned without the runtime state,
and the gate is too load-bearing to guess-fix (a wrong change could open an auto-allow hole).

So, mirroring P-ASKSAGE.1 (ship diagnostics → capture live → fix with confidence): a dev-mode ring
(`acp_backend.gateDiagnostics()`) records, for every exec/egress permission request, the interactive-check
inputs (`askActive`, `listener`, `goalActive`, `autoRunning`) + the `verdict`/`decision`. Surfaced in Logs →
**"Exec / egress gate decisions"** (with a chip + a ⛔ count on blocks). A `block(no-ui)` row then shows which
input was false — the root cause to fix. Observability only: no change to the gate's actual deny behavior;
fail-closed is preserved. New: the `gateDiag` ring + `recordGateDiag()` in `acp_backend.ts`, the two decision
records (exec + egress), `gate` in the `/api/dev` snapshot + `DevView`, the Logs accordion in the renderer,
`desktop/scripts/demo_p_gate_diag_1.ts`.

## ADR-0067 - P-GOAL.13: per-command Speed<->Risk dial for the loop + tools/blocks in the AAR (SCOPE/PLAN)

**Date:** 2026-06-26
**Status:** Accepted - BUILT 2026-06-28 (issue #97). `classifyCommand` graded to tiers T0-T4 +
`loopVerdict`/`clampDialRow`; `acp_backend` consults the dial unattended (T4 always blocks) + collects
blocks; `loop_report` gains `LoopMetrics.blocks` + a Blocks section + dial posture; renderer plasma-slider
matrix (persisted, rides `/api/goal`). 191 desktop loop/exec tests + `make demo-P-GOAL.13`.
**Increment:** P-GOAL.13. DEPENDS ON ADR-0066's exec classifier (P-EXEC.1) - the dial reads its risk tier.

### Context

ADR-0066 added a per-action exec gate for INTERACTIVE use (prompt the human). The `/goal` loop runs
UNATTENDED, where there is no human to prompt - so the same risk awareness has to become a STANDING
posture the user sets before the run. The ask: in the loop's advanced settings, a green->red "plasma"
slider PER COMMAND TYPE trading speed against risk, in a popover; and the After-Action Report should call
out which tools ran and what got blocked. The AAR already tallies tool calls by type
(`LoopMetrics.toolCalls`, loop_report.ts) but folds blocks into a generic `errors` list - there is no
first-class "blocks" dimension yet.

### Decision

**1. A graded risk ladder (extends ADR-0066's binary classifier).** `classifyCommand` is refined to
return an ordered TIER, not just safe/risky:
- **T0 read-only** (`ls cat grep` …) · **T1 local-mutate** (edit/write/mkdir within workspace) ·
  **T2 reach-out** (network fetch, package install, `git push`) · **T3 destructive** (`rm`, `chmod`,
  overwrite-`mv`, `ssh`) · **T4 catastrophic** (`sudo`, `rm -rf`, pipe-to-shell, `dd`/`mkfs`,
  force-push / hard-reset, fork bomb).
- T4 is the ADR-0066 ALWAYS-PROMPT set; in the loop it is **ALWAYS BLOCKED** (no human, never
  auto-runnable) regardless of any dial. Fail-closed: an unparseable/unknown command is T3.

**2. A per-command-type dial matrix (the slider popover).** In the loop's advanced settings (P-GOAL.8),
a popover module shows one **green->red plasma slider per command TYPE** (the existing `normalizeToolName`
classes: shell, edit, delete, web-fetch, web-search, subagent; read/search are fixed T0/green). Each
slider sets that type's **max auto-run tier** = the speed<->risk trade:
- green/left = T0 only (auto-run safe, BLOCK everything riskier - slowest, safest, most blocks),
- amber/middle = up to T1/T2,
- red/right = up to T3 (auto-run all but the catastrophic T4 - fastest, fewest blocks).
A command auto-runs in the loop **iff its classified tier <= that type's dial**; otherwise it is BLOCKED
and recorded. For `shell`, the per-COMMAND tier comes from the classifier (so `ls` is T0 even when the
shell dial is green); for the other classes the tool maps to one intrinsic tier. This per-command-type
dial IS the loop's unattended exec policy - it supersedes ADR-0066's generic unattended allowlist for loop
runs (the interactive per-program `lucid-exec.json` allowlist is an interactive-mode concept; the loop is
governed by the dial). Persisted with the loop's other advanced settings.

**3. Tools + blocks in the AAR.** `LoopMetrics` gains a first-class `blocks: { iter, tool, tier, reason }[]`
(`reason` ∈ `risk-dial` | `catastrophic` | `security-gate`), and `renderLoopReport` gains a **Blocks**
section: a count, a by-reason/by-tier breakdown, and a table of what was stopped - rendered next to the
existing tool-calls pie. Security-gate (Unicode scanner) blocks and risk-dial blocks are tallied SEPARATELY
(different layers, both shown). The report header also records the dial posture the run used, so an AAR is
self-describing ("this run was set to: shell=T1, web=T0, …").

### Plumbing (for the build increment[s])

- `desktop/exec_policy.ts` (ADR-0066) - `classifyCommand` returns a `tier` (T0-T4); add the pure
  `loopVerdict(dial, tier)` -> `auto` | `block`.
- Renderer - the plasma slider is pure CSS (a green->amber->red gradient track + a glowing thumb); the
  popover matrix lives in the goal advanced-settings panel (app.ts ~2357+); the dial matrix persists to the
  goal settings store and rides the `/api/goal` start payload.
- `acp_backend.ts` - in unattended loop mode, the exec branch consults `loopVerdict` instead of prompting;
  a `block` increments the loop's block metric and rejects the tool call (fail-closed).
- `desktop/loop_report.ts` - extend `LoopMetrics` + `renderLoopReport` with the Blocks section; the backend
  collects blocks during the run (it already collects tools/errors).
- `desktop/loop_report.test.ts` + `exec_policy.test.ts` - cover `loopVerdict` (every tier x every dial) and
  the new AAR section, plus the classifier tier corpus (scanner-level rigor).

### Suggested slicing

(a) classifier tier + `loopVerdict` + loop gate + AAR Blocks section (the security-meaningful core, no new
UI); (b) the plasma slider popover matrix UI on top. (a) is shippable and testable without the slider
(defaults: a conservative dial); (b) makes it user-tunable.

### Consequences / invariants

- Fail-closed extends to the loop: unknown tier = T3, T4 always blocks, and a missing/zeroed dial defaults
  to the safest (T0-only) posture - an unconfigured loop is the SAFEST loop, not the most permissive.
- No `contracts.ts` change: blocks are loop-side metrics reusing existing emit plumbing; a dedicated
  `exec_blocked` `EventName` stays a future increment (invariant #8). The frozen prompt prefix is untouched
  (#6). Defense in depth on top of the scanner keystone, not a replacement.

### Relates to

ADR-0066 (the exec classifier this grades + drives), ADR-0062 (egress - web tools already gate; the dial's
web rows compose with it), ADR-0054/0056 (the loop AAR this extends), ADR-0060 (unattended-loop posture),
CLAUDE.md invariant #3 + the scanner keystone.

## ADR-0068 - P-ENT.1: enterprise managed-policy override for the security knobs (GPO / MDM) (SCOPE/PLAN)

**Date:** 2026-06-26
**Status:** Accepted - BUILT (#96): the schema, the pure clamp/lock helpers, the Windows GPO reader, and the egress + models wiring shipped. Exec/loop ENFORCEMENT lands with ADR-0066/0067 (the schema + clamp helpers are ready for them); `logging` is consumed by ADR-0069. Public seam; the org's actual policy TEMPLATES are private-repo IP.
**Increment:** P-ENT.1. Extends the EXISTING `managed_config.ts` seam (it already governs attribution).

### Context

`desktop/managed_config.ts` already exists: an admin places a read-only policy file in a machine-only
path (`%ProgramData%\LucidAgentIDE` / `/Library/Application Support` / `/etc/lucidagentide`, or
`LUCID_MANAGED_CONFIG`), tamper-guarded, fail-safe (absent/malformed = unmanaged), and it only ever ADDS
constraints. Today it governs attribution (require corporate email, allowed domains, no-skip) and
`asksageOnly`. The new exec-risk controls - ADR-0066 (exec approval) and ADR-0067 (the loop Speed<->Risk
dial) - and the SIEM logging of ADR-0069 must be CENTRALLY governable by an org admin via GPO / Intune /
Jamf / Ansible, not left per-user. This ADR extends the seam; it invents no new mechanism.

### Decision - extend `ManagedConfig` with a `security` + `logging` block; managed values can LOCK

`ManagedConfig` gains (all optional; absent = unmanaged for that knob):
- `security.exec` - org default + CEILING for the per-command risk dial (ADR-0067 tiers), an optional
  `lock` (user may set SAFER than the org default but never riskier), `disableDangerMode` (forbid the
  "allow all" global), and program `allowlist`/`denylist`.
- `security.egress` - `allowedHosts`, `deniedHosts`, `disableDangerMode`, default verdict (ADR-0062).
- `security.loop` - a maximum auto-run tier ceiling for unattended `/goal` runs (clamps every dial row).
- `logging` - the SIEM/audit sink config consumed by ADR-0069 (sink type, endpoint, format, on/off).
- `models` - generalizes the existing `asksageOnly` lock (allowed providers/models).

**Precedence + enforcement.** Effective policy = `clampToManaged(userSetting, managed)`: managed is a
CEILING, never a floor that relaxes safety. A locked knob disables its UI control and shows "Managed by
<orgName>" (the attribution UI already does this). Enforcement is at the existing decision points -
`egress_policy` / `exec_policy` / the loop dial read the managed ceiling and can only tighten. The
security GATE itself (scanner, fail-closed) is never touched by policy (invariants #3/#4).

**Distribution channels (one build, many environments).** The canonical file path already works for any
MDM that can drop a file (Intune, Jamf, Ansible, SCCM). ADD a Windows **Group Policy** channel: an ADMX
template writes `HKLM\Software\Policies\LucidAgentIDE`, and `managed_config.ts` gains a Windows
registry-policy reader merged UNDER the file (HKLM policy is admin-only by ACL = the same tamper model).
The PUBLIC repo ships the schema + enforcement + the registry reader; the private add-on repo ships the
ADMX/Intune/Jamf/Ansible TEMPLATES + the deployment runbook (ADR-A010).

### Plumbing (build increment)

- `managed_config.ts` - add the `security`/`logging`/`models` types; a Windows `HKLM\...\Policies`
  reader; `clampToManaged` helpers; cache + tamper guard unchanged.
- `egress_policy.ts` / `exec_policy.ts` / the loop dial - read the managed ceiling/lock and tighten only.
- Renderer - disable + "Managed by <org>" on locked controls (mirror the attribution UI).
- Tests - `managed_config.test.ts` clamp/lock matrix; a managed policy can only tighten, never loosen.

### Invariants preserved

Managed policy only ADDS constraints (existing rule); fail-safe to unmanaged; the scanner/fail-closed gate
is independent of policy (#3/#4); no `contracts.ts` change.

### Relates to

`managed_config.ts` (the seam extended), ADR-0066/0067 (the knobs governed), ADR-0062 (egress), ADR-A009
(same managed-config file already carries `updateChannel`), ADR-0069 (consumes `logging`), and the private
ADR-A010 (the GPO/MDM templates - the "how").

## ADR-0069 - P-ENT.2: security audit event export seam (SIEM-ready, OCSF-aligned) (SCOPE/PLAN)

**Date:** 2026-06-26
**Status:** Accepted - BUILT 2026-06-28 (issue #98). `audit_export.ts` (versioned `SecurityEvent` + OCSF
Detection-Finding mapper + `Sink` interface + fail-safe `AuditDispatcher` + append-only `FileSink`);
emitted from `security_log` (scanner/approve/dismiss) + `acp_backend` exec/egress/loop decisions; `/api/audit`
+ a "Security event export (SIEM)" card in the Logs view. Tests: OCSF fixtures + dead-sink fail-safe.
`make demo-P-ENT.2`. Public defines the schema + sink interface + file sink; the per-SIEM CONNECTORS are
private-repo IP (ADR-A011).
**Increment:** P-ENT.2. Extends the EXISTING `security_log.ts` append-only audit.

### Context

`desktop/security_log.ts` already keeps an append-only JSONL audit of gate blocks
(`~/.omp/lucid-blocks.jsonl`, metadata only, never raw content) that the in-app dashboards read. A SOC
needs those events - plus the ADR-0066 exec-gate and ADR-0062 egress decisions, approvals/dismissals, and
ADR-0067 loop blocks - in the enterprise SIEM (Splunk, ACAS/Tenable, Elastic, AWS, Azure, GCP). This ADR
turns the local audit into a normalized, exportable security-event stream.

### Decision - one canonical, versioned, OCSF-aligned event; a pluggable sink interface

- **Canonical event.** A single versioned `SecurityEvent` (schemaVersion, id, ts RFC3339, category, type,
  severity, tool, decision = block|allow|prompt, reason, tier, sessionId/runId, host + attribution
  identity, orgName). Metadata ONLY - never raw scanned content (existing rule). Every source maps to it:
  scanner block, exec-gate decision, egress decision, approve/dismiss, loop block.
- **OCSF normalization.** The wire shape is **OCSF** (Open Cybersecurity Schema Framework) - the common
  denominator that maps cleanly to Splunk, Elastic ECS, AWS Security Lake, Azure Sentinel, and GCP
  Chronicle/SecOps - so the public emitter is vendor-neutral and the private connectors are thin field
  re-maps, not re-modeling.
- **Pluggable sinks.** Public ships (a) the enriched append-only FILE sink (the existing JSONL, now
  carrying every security event - the dashboards read it) and (b) a `Sink` INTERFACE + a config-driven
  dispatcher reading `managedConfig().logging`. The private add-on ships the network connectors keyed by
  sink type: Splunk HEC, syslog/CEF over TLS, Elastic bulk, AWS Security Lake / Firehose, Azure Monitor
  (Sentinel DCR), GCP Chronicle ingestion, ACAS/Tenable (ADR-A011).
- **Dashboards.** The in-app dashboards already read the JSONL; extend to the unified security-event
  stream + per-sink delivery status (so an admin sees "events forwarded to Splunk: ok").
- **Fail-safe, not fail-open.** A dead/slow SIEM sink NEVER blocks a turn - export is best-effort + buffered
  (like the existing audit append). Security DECISIONS stay fail-closed regardless of whether logging
  succeeds: logging is observability, not the gate.

### Plumbing (build increment)

- `desktop/audit_export.ts` (new) - the `SecurityEvent` type, the OCSF mapper, the `Sink` interface, the
  dispatcher, and the file sink.
- `security_log.ts` + the exec/egress/loop decision points - emit a `SecurityEvent` alongside their
  existing records (additive).
- `managed_config.ts` `logging` block (ADR-0068) selects + configures sinks centrally.
- Tests - OCSF mapping fixtures (each source -> valid OCSF), dispatcher fail-safe (dead sink never throws).

### Invariants preserved

Metadata-only audit (existing); fail-safe export, fail-closed gate (#3); new canonical event TYPES that
would extend the `EventName` enum are a `contracts.ts` change = their own increment (#8) - v1 maps EXISTING
block records into the export schema without adding enum values. Frozen prefix untouched (#6).

### Relates to

`security_log.ts` (the audit extended), ADR-0068 (carries the sink config), ADR-0066/0067/0062 (the
decisions exported), `contracts.ts` `EventName` (#8), and the private ADR-A011 (the per-SIEM connector
shapes - the "how").

### Addendum (2026-06-30) — P-ENT.4: every gate denial is auditable + attributed (close the silent fail-closed gap)

A live turn showed several "tool call denied by user" chips (browser/bash/eval, while the agent tried to
smoke-test a game it built) with **no matching record in the OCSF audit log**. Root cause: the per-action
approval prompts (`askExec`/`askEgress`) emitted a `SecurityEvent` only on the RESOLVE path (you click a
button); the **fail-closed TIMEOUT** path `setTimeout(() => settle(block()))` settled silently — a real
denial with zero audit trail. So "did I deny it, or did it auto-deny?" was unanswerable.

Fix: the timeout paths now `emitSecurityEvent(decision: block, …)` before settling, and a pure
`gateDenyReason(optionId, timedOut)` (`desktop/gate_audit.ts`) attributes every denial honestly —
**"denied by you"** (explicit Block) vs **"fail-closed (turn ended)"** (resolved with no optionId — the turn
ended/disconnected while pending) vs **"fail-closed (no response in 5m)"** (timeout). Both the exec and
egress deny paths use it. Now every per-action denial is in the audit feed with a cause; the omp-surfaced
"denied by user" chip (ADR-0093) is no longer the only signal, and it's no longer ambiguous about whether it
was the user. New: `gate_audit.ts` (+ test), the timeout emits + attribution in `acp_backend.ts`,
`desktop/scripts/demo_p_ent_4.ts`. (Note: the chip text itself is omp's wording; making the CHIP say
fail-closed-vs-you is a small follow-up — the audit trail is now authoritative.)

## ADR-0070 - P-BRIEF.1: Executive Engineering Update — repo logs → brief + podcast behind a vendor-agnostic audio seam

**Date:** 2026-06-26
**Status:** Accepted - BUILT (slice 1: the generator + the audio seam). Audio backends, the Goal Loop
accordion, and Slack/Drive delivery are follow-on slices (P-BRIEF.2/.3).
**Increment:** P-BRIEF.1. Informed by a deep-research pass (NotebookLM Enterprise API, ElevenLabs,
Podcastfy/Kokoro, Workspace OAuth, Slack) — findings folded in below.

### Context

Goal: an automated "Executive Engineering Update" - a curated written brief AND a podcast - generated
from a repo's own change history (PROGRESS.md, DECISIONS.md/ADRs, HANDOFF.md, and the goal-loop
After-Action Report), focused on LOAD-BEARING DEPENDENCIES, TECH DEBT, and UPCOMING DECISIONS, and
configurable from the Goal Loop UI. The open question was the audio-generation backend; a deep-research
pass resolved it (verified, 22/25 claims confirmed).

### Research findings (verified)

- **NotebookLM has an official ENTERPRISE API.** `notebooks.audioOverviews.create` (Discovery Engine
  `google.cloud.notebooklm.v1alpha`, HTTP POST, GCP bearer token) creates notebooks + Audio Overviews
  programmatically. It is `v1alpha`/Preview (pre-GA, one-audio-overview-per-notebook). The separate
  standalone Podcast API is DEPRECATED (no new-customer allowlisting) - do NOT build on it.
- **No headless browser.** omp DOES ship `puppeteer-core`, but driving the CONSUMER NotebookLM is
  unnecessary given the API and carries real Workspace-AUP suspension risk (24h cure §4.1; immediate
  §4.2). Rejected.
- **Multi-vendor alternatives.** ElevenLabs `POST /v1/studio/podcasts` (two-speaker "conversation" /
  "bulletin"; allowlist-gated). Air-gap: **Podcastfy** (Apache-2.0, vendor-agnostic `tts_model`) or Open
  Notebook for transcript/orchestration + a **self-hosted Kokoro TTS** server (OpenAI-compatible
  `/v1/audio/speech`, true offline `KOKORO_LOCAL_ONLY`). (Open Notebook's full-offline claim was REFUTED;
  rely on Podcastfy+Kokoro for the verified offline audio path.)
- **Auth.** GCP bearer via OAuth consent or a plain service account; AVOID domain-wide delegation (Google
  IAM best-practice - DWD can impersonate any user). Workspace/Drive delivery via the `google_workspace_mcp`
  server (3-legged OAuth 2.1+PKCE, auto refresh) - it does NOT cover NotebookLM. Slack delivery is a
  dedicated Slack bot (`files.upload` + `chat.postMessage`), not a provider connector.

### Decision

**1. A pure generator (BUILT this slice).** `harness/brief/engineering_update.ts` - no I/O, no Date.now,
no network: parse PROGRESS.md (shipped/stubbed/next) + DECISIONS.md (ADR status + `DEPENDS ON`/`Blocked
by`) + an optional AAR (`AarLike`, declared locally so harness never imports desktop) into a typed
`EngineeringUpdate` (recentlyShipped · loadBearingDependencies · techDebt · upcomingDecisions · risks).
Mapping: PROGRESS `stubbed` + `DEFERRED`/`FINDING` ADRs → tech debt; `Proposed`/`SCOPE/PLAN`/`DEFERRED`
ADRs + PROGRESS `next` → upcoming decisions; ADR `DEPENDS ON` edges → load-bearing; AAR
errors/blocks/non-met outcome → risks. Renders a written brief AND a TTS-ready two-host podcast SCRIPT.

**2. A vendor-agnostic `PodcastBackend` seam (BUILT).** `synthesize(script) → PodcastResult`. The default
`ScriptOnlyBackend` returns the script with NO audio, so the pipeline never hard-fails on a missing cloud
key and the AIR-GAP default ships today. The cloud/offline adapters (NotebookLM Enterprise, ElevenLabs,
Podcastfy+Kokoro) implement this same interface in P-BRIEF.2 - the generator never changes.

**3. Follow-on slices (deferred).** P-BRIEF.2: the audio adapters (behind the seam) + delivery (Slack bot,
Workspace MCP). P-BRIEF.3: the Goal Loop accordion - provider picker (script-only | NotebookLM-Enterprise
| ElevenLabs | Podcastfy+Kokoro), cadence, and destinations - wired as advanced config; the cloud paths
gate through egress (ADR-0062) + managed-config (ADR-0068) and keys live like other provider keys.

### Generation-option comparison

| Option | API today | Auth | Air-gap | ToS/risk | Role |
|---|---|---|---|---|---|
| NotebookLM Enterprise audioOverviews | yes (v1alpha/Preview) | GCP bearer (OAuth/SA) | no (cloud) | low (official API) | primary cloud |
| ElevenLabs studio/podcasts | yes (allowlist-gated) | xi-api-key | no | low | hosted multi-vendor |
| Podcastfy + self-hosted Kokoro | yes (OSS) | none (local) | YES (Kokoro `LOCAL_ONLY`) | none | air-gap |
| Headless consumer NotebookLM | n/a | Workspace OAuth | no | HIGH (suspension) | REJECTED |
| Script-only (default) | built | none | YES | none | fallback / no-vendor |

### Consequences / invariants

- Air-gap by default (script-only, pure, no network); the cloud backends are opt-in and egress-gated.
- The brief is a SUMMARY of already-local logs - no raw source/CUI leaves the host until a vendor backend
  is deliberately configured. The frozen prefix is untouched; no `contracts.ts` change.
- `make demo-P-BRIEF.1` generates a real update from THIS repo's logs (shipped/deps/debt/decisions + a
  two-host script) with no vendor. 10 unit tests; typecheck clean.

### Relates to

`desktop/loop_report.ts` (the AAR input), DECISIONS.md/PROGRESS.md (the inputs), ADR-0067 (the loop AAR
blocks feed Risks), ADR-0020 (MCP servers - the Workspace/Slack delivery surface), ADR-0062/0068
(egress + managed-config govern the cloud backends), and the deep-research pass that chose the backend.

## ADR-0071 - P-BRIEF.2: first audio backend — OpenAI-compatible (self-hosted Kokoro) TTS behind the seam

**Date:** 2026-06-26
**Status:** Accepted - BUILT (slice: one audio adapter). Delivery (Slack/Workspace) + the Goal Loop
accordion + the cloud adapters (NotebookLM Enterprise, ElevenLabs) remain P-BRIEF.2b/.3.
**Increment:** P-BRIEF.2. Fills the `PodcastBackend` seam from ADR-0070 with its first concrete backend.

### Context

ADR-0070 shipped the generator + the `PodcastBackend` seam with a `ScriptOnlyBackend` default. This slice
implements the FIRST real backend so the pipeline produces actual audio.

### Decision - OpenAI-compatible TTS first (air-gap, no allowlist, no new Python)

`harness/brief/tts_backend.ts` adds `OpenAiCompatibleTtsBackend implements PodcastBackend`. It POSTs each
podcast turn to `{baseUrl}/v1/audio/speech` (the shape a self-hosted **Kokoro** server exposes, and any
OpenAI-compatible TTS endpoint), with a per-speaker voice, and concatenates the returned WAV segments
into one briefing. Chosen as the first backend BECAUSE:
- **Air-gap** - the research's verified offline path (Kokoro `KOKORO_LOCAL_ONLY`); no cloud account.
- **No allowlist** - unlike ElevenLabs Studio (access-gated) and NotebookLM Enterprise (GCP project),
  this works against a localhost server out of the box.
- **Invariant #2** - it is a TypeScript HTTP client, NOT a second Python surface (Podcastfy, being
  Python, is deliberately NOT vendored; we call a TTS server over HTTP instead).

**Pure, testable audio stitch.** `parseWav` / `buildWav` / `concatWav` are PURE (chunk-aware - tolerant of
LIST/fact chunks, not the naive 44-byte assumption) and unit-tested without any server. The HTTP transport
is INJECTABLE (`fetchImpl`), so the adapter is fully tested with a mock; `make demo-P-BRIEF.2` runs the
whole repo-logs → script → synth → WAV pipeline against a mock by default (offline/CI-safe) and against a
real server when `LUCID_TTS_BASE_URL` is set.

**Fail-safe (inherited).** Any synth error (endpoint down, non-200) degrades to a script-only result with
the reason in `note` - the brief never hard-fails on a TTS problem. `PodcastResult` gained an additive
`audio?: Uint8Array` (the caller persists/delivers it; the backend stays I/O-light).

### Consequences

- One configurable env surface: `LUCID_TTS_BASE_URL` (+ optional `_API_KEY`, `_VOICE_HOST`, `_VOICE_GUEST`).
  The same adapter serves a localhost Kokoro (air-gap) or any hosted OpenAI-compatible TTS.
- Multi-WAV concatenation assumes a uniform PCM format across turns (true for one server/voice config);
  a format mismatch throws rather than emit a corrupt file.
- Cloud adapters (NotebookLM Enterprise audioOverviews, ElevenLabs studio/podcasts) implement the SAME
  interface later; the generator and this WAV stitch are unchanged.

### Invariants preserved

No second Python surface (#2 - TS HTTP client); fail-safe, never fail-open; pure audio helpers + injectable
transport keep it testable offline; no `contracts.ts` change; the frozen prefix is untouched.

### Relates to

ADR-0070 (the seam + generator this fills), the deep-research pass (Kokoro as the verified air-gap TTS),
ADR-0062/0068 (egress + managed-config will govern a hosted endpoint when delivery lands in P-BRIEF.2b).

## ADR-0072 - P-BRIEF.3: the Engineering Update in the Goal Loop UI (accordion + premium tooltip)

**Date:** 2026-06-26
**Status:** Accepted - BUILT (the accordion + the generate endpoint + the written brief inline). Audio
playback + Slack/Workspace delivery remain P-BRIEF.2b.
**Increment:** P-BRIEF.3. Surfaces P-BRIEF.1/.2 (ADR-0070/0071) from the Goal Loop UI.

### Context

The generator (ADR-0070) and a TTS backend (ADR-0071) exist as harness modules. They needed a UI: the
user asked for the config to live "as an accordion drop inside one of the steps or advanced config" of the
Goal Loop, with a PREMIUM hover tooltip explaining the value.

### Decision

- **A self-contained `<details class="goal-eu">` accordion** inside the goal modal's last step (no new
  required step, so the guided 1→Run flow is undisturbed). It holds an audio-provider `<select>`
  (Script only | Local TTS - Kokoro), a "Generate update now" button, and an inline result area. The
  provider choice persists to `localStorage` (`lucid.euProvider`).
- **A premium tooltip** via the existing `goalInfoDot("Title|Body")` (the project's "premium info dot"
  using the global `data-tip`), with the user's exact framing: the curated brief + podcast mitigates
  **"Cognitive Surrender and Information Overload"** and surfaces the **signal in the noise during
  orchestration looping** - what shipped, what is load-bearing, the tech debt, and the decisions that
  need a human.
- **A read-only server route `GET /api/brief`** (desktop/dev.ts): reads the repo's own DECISIONS.md /
  PROGRESS.md, runs the PURE `buildEngineeringUpdate` (ADR-0070), and returns `{ brief, scriptText,
  counts }`. The renderer renders the brief markdown with the existing DOMPurify-backed `renderMarkdown`.
  `bridge.engineeringBrief()` is the typed client.

### Verification

Live in the dev server (preview): `GET /api/brief` → 200 with the real repo's counts (6 shipped, 1
load-bearing, 7 tech-debt, 12 upcoming decisions); the served `/app.js` carries the `goal-eu` accordion,
the `euGenerate` handler, and the exact tooltip copy; full typecheck clean; no console errors.

### Consequences / invariants

- The route is read-only + air-gap (it summarizes already-local logs; nothing leaves the host). Audio is
  not generated here - the accordion configures provider intent; rendering audio is P-BRIEF.2b, where a
  hosted endpoint goes through egress (ADR-0062) + managed-config (ADR-0068).
- No `contracts.ts` change; the frozen prefix is untouched; the security gate is unaffected.

### Relates to

ADR-0070 (the generator the route calls), ADR-0071 (the TTS backend the provider picker will drive),
P-GOAL.8 (the goal modal + `goalInfoDot` this extends), the deep-research pass that scoped the feature.

## ADR-0073 - P-STT.1: speech-to-text (mic input) behind a vendor-agnostic transcription seam

**Date:** 2026-06-26
**Status:** Accepted - BUILT (the seam + the OpenAI-compatible/Whisper adapter). The mic UI in the chat +
goal composer is P-STT.2.
**Increment:** P-STT.1. The symmetric mirror of the P-BRIEF.2 TTS backend (ADR-0071) — voice IN, where
P-BRIEF was voice OUT.

### Context

With TTS shipped (ADR-0070/0071), the reverse — dictating a goal/prompt by mic, like Claude Code — lands
on two of this product's stated values: accessibility (older adults / vision-impaired, per the README) and
hands-free operation during long unattended loops. This builds the air-gap-clean core; the mic button is a
follow-on slice.

### Decision - one TranscriptionBackend seam; first backend is OpenAI-compatible (local Whisper)

`harness/voice/transcription.ts` adds `TranscriptionBackend { transcribe(audio, opts) -> TranscriptionResult }`
and a first concrete `OpenAiCompatibleSttBackend` that POSTs the audio as multipart to
`{baseUrl}/v1/audio/transcriptions` — the shape a SELF-HOSTED Whisper server (whisper.cpp / faster-whisper)
exposes, and any OpenAI-compatible endpoint. Chosen first for the same reasons as the Kokoro TTS adapter:
- **Air-gap default** — a local Whisper means audio NEVER leaves the host; no cloud account.
- **No new Python (invariant #2)** — a TS HTTP client to a transcription server, not a vendored model.
- **No new trust surface** — the returned transcript is ordinary USER INPUT; it enters the agent through
  the SAME scanned path as typed text. STT adds capture, not a new ingestion channel.

**Testable + fail-safe.** The transport is INJECTABLE (`fetchImpl`); empty audio short-circuits with no
network call; any error (endpoint down, non-200, missing `text`) returns an EMPTY transcript with a note
rather than throwing — a broken STT endpoint never crashes the composer, the user just types instead. The
audio buffer is copied before the multipart blob, so a detaching transport can't corrupt the caller's bytes.

### Consequences

- Env surface mirrors TTS: `LUCID_STT_BASE_URL` (+ optional `_API_KEY`, `_MODEL`). The same adapter serves
  a localhost Whisper (air-gap) or any hosted OpenAI-compatible STT.
- `make demo-P-STT.1` runs audio-bytes → transcript via a mock by default (offline/CI) and live with
  `LUCID_STT_BASE_URL`; it also proves the fail-safe (broken endpoint → empty text).
- A hosted endpoint is opt-in and must be governed by egress (ADR-0062) + managed-config (ADR-0068) so a
  locked-down / air-gapped deployment can FORBID cloud STT and pin to the local server (sovereignty).

### Deferred to P-STT.2 (the UI)

A mic button in the chat composer + the goal input: record → `transcribe` → drop the text into the field.
Two guardrails to honor there: (1) under managed lockdown, only a local STT endpoint is selectable (audio
sovereignty); (2) voice must NOT confirm a CATASTROPHIC exec-approval (ADR-0066 always-prompt set) — those
require a deliberate click, never a spoken "approve".

### Invariants preserved

No second Python surface (#2 — TS HTTP client); fail-safe, never fail-open; the transcript is gated by the
existing scanner on the normal input path (#3/#5); injectable transport keeps it testable offline; no
`contracts.ts` change; the frozen prefix is untouched.

### Relates to

ADR-0071 (the TTS backend this mirrors), ADR-0070 (the audio-platform-seam thesis), ADR-0062/0068 (egress +
managed-config govern a hosted endpoint), ADR-0066 (the exec-approval guardrail for voice in P-STT.2).

## ADR-0074 - P-GOAL-DIAG.1: maker-turn event-breakdown diagnostics (the Anthropic empty-loop bug)

**Date:** 2026-06-26
**Status:** Accepted - BUILT (dev-mode diagnostics only; no behavior change).
**Increment:** P-GOAL-DIAG.1. Same diagnostic-first pattern as P-ASKSAGE.1 (ADR-0059) for a model-specific
loop failure.

### Context

The `/goal` loop is ineffective with Anthropic models: the checker repeatedly reports "no output / no
changes / no tools called" (per-iteration log all 0s), while the SAME goal works with GPT-5.5. Root from
the code: the loop builds `work` ONLY from `token` events (`agent_message_chunk` text) and counts tools
ONLY from `tool_call` events; the model's THINKING (`agent_thought_chunk`) is display-only and excluded
from `work` (acp_backend.ts; isLearnableAssistantText is true only for `token`). The strong hypothesis is
that a Claude (Opus 4.8, high-thinking) maker turn streams thinking-only and surfaces no tool calls / no
answer through omp's ACP path, so the checker is handed "(no output)". But the exact failure (thinking-
only vs tools-not-surfacing vs empty/early turn end) can't be told apart from the existing logs.

### Decision - capture the truth before fixing (no behavior change)

Two dev-mode (developerMode-gated) `turnDiag` lines:
- `prompt.resolved … stopReason=<r>` - the omp `session/prompt` stop reason, so an empty/early turn end is
  visible (captured the `session/prompt` result, previously discarded).
- `goal.iter <i> maker-turn: answer_chars=<n> thinking=<events>/<chars>c tools=<n> blocks=<n> acted=<bool>`
  per maker iteration - the event-type breakdown. A Claude empty turn shows as `answer_chars=0 tools=0`
  with `thinking_chars>0`, pinpointing thinking-only; tools-not-counted would show `tools=0` with
  `answer_chars>0`; a truly empty turn shows all zeros + the stopReason.

One Claude `/goal` run (Developer mode on, launched so the dev-server console is visible) now reveals the
exact signature, and the fix follows precisely - manage maker thinking, feed thinking to the checker as a
fallback, or correct the event mapping / file an omp-side issue.

### Consequences / invariants

Dev-mode only (gated by developerMode; zero overhead + zero output otherwise); no loop behavior change; no
`contracts.ts` change; typecheck clean. The GPT-5.5 "stalls a bit after a lot of work" the user also saw is
the by-design maker->checker pause (a separate checker model grades between iterations with no streaming) -
not a bug; a "Checking…" indicator is a separate optional UX follow-up.

### Relates to

ADR-0059 (P-ASKSAGE.1 - same diagnostic-first approach), ADR-0054 (the loop + AAR), the `thinking`/`token`
split in acp_backend.ts `onNotify` + thinking_governance.ts.

## ADR-0075 - P-KG-REL.1: manual relationship authoring in the Knowledge Graph (drag-to-relate + multi-select Relate)

**Date:** 2026-06-27
**Status:** Accepted - BUILT. Surfaced from first real-user import feedback (a ~25-min ChatGPT-history
ingest). The graph was read-only; users can now assert relationships the extractor missed. Custom relation
labels beyond the neutral "related" default are deferred (see Consequences).
**Increment:** P-KG-REL.1. UI wiring of an existing, unused data-layer capability (`store.addLink`).

### Context

`harness/personal/store.ts` already has `addLink(fromEntityId, toEntityId, relation)` (≈line 159), but no UI
path reaches it. Edges today come only from import or the "Richer graph" model extractor (`app.ts` "AI
extraction" toggle). The graph (`desktop/renderer/graph.ts`, a zero-dep SVG force layout) supports
**single-node selection only** (`kgSelId` is one string; `onUp` toggles `sel` at graph.ts:186). The user
asked for two complementary gestures:
1. **Drag from one node onto another** to draw a relationship (direct, spatial).
2. **Click two or more nodes, then "Relate"**, and have the layout reform around the new edges (deliberate,
   multi-edge).

### Decision - add a UI authoring path that mints `trusted` user-authored edges; never an ingestion channel

Wire both gestures to `store.addLink()` via a new `bridge.personalRelate(from, to, relation)` →
`/api/personal/relate` route, mirroring the existing `personalForget` path (`app.ts` → `bridge.ts` →
`dev.ts` → `personal.ts` → `store.ts`).

1. **Drag-to-relate.** Extend `graph.ts onDown/onMove/onUp`: hold a modifier (or a "Relate" mode toggle so
   plain drag still repositions a node) and drop node A's cursor over node B → emit an `onRelate(a, b)`
   callback. Reuse the existing hit-test (`closest(".kg-node")`). A transient ghost edge follows the cursor.
2. **Multi-select + Relate.** Promote selection from a single `kgSelId` to an ordered `Set`. Shift/ctrl-click
   adds to the set; a "Relate" button in the side panel appears when ≥2 are selected; clicking it creates
   edges (chain or star — default chain in selection order) and `reheat()`s the sim so the layout reforms.
3. **Relation label.** Default the `relation` to a neutral `"related"`; allow a quick inline label. Keep it
   short and free-text; it is display metadata, not a typed ontology (out of scope here).

**Trust + provenance.** A user-authored edge is `trusted` by construction — the human asserted it in-app, it
is NOT externally-sourced content, so it does **not** pass through the scanner and is **never** treated as
model instructions. This is symmetric with `forgetFact` (a user decision mutates the store directly). The new
edge carries the user as author so lineage/attribution (ADR-0031) can distinguish authored edges from
extracted ones. Authoring an edge must NOT auto-promote either endpoint's facts into semantic memory
(keystone #2) — it relates existing nodes, it does not create or elevate facts.

**Refresh.** After a successful relate, mutate local `kgData.edges` optimistically and `kgHandle.update()` so
the edge appears immediately (the same instant-feedback fix tracked for the forget bug), then reconcile with
`refreshKnowledgeLive()`.

### Consequences

- Selection model in `graph.ts` becomes a set; the side panel renders 1 node (detail) or N nodes ("Relate"
  affordance). Encrypted/locked compartments stay un-authored — you cannot relate nodes you cannot see.
- `make demo-P-KG-REL.1`: select two nodes → Relate → assert an edge with `relation:"related"`, author=user,
  `trust:"trusted"` lands in the store and renders without a reload; drag A→B does the same.

### Invariants preserved

No scanner bypass for *external* content (#5 — authored edges are first-party, not ingested); closed trust
set (#7 — edge is `trusted`); no semantic auto-promotion (keystone #2); no `contracts.ts` change (edge shape
already exists); frozen prefix untouched; reuses the existing forget IPC pattern rather than a new boundary.

### Relates to

`harness/personal/store.ts` (`addLink`, the unused capability this wires), `desktop/renderer/graph.ts`
(selection + drag), the forget-flow IPC chain it mirrors, ADR-0031 (authored-vs-extracted attribution), the
KG instant-refresh bug (the optimistic-update fix both share).

## ADR-0076 - P-KG-INGEST.1: non-blocking background ingest with live progress + grouped ingest sessions

**Date:** 2026-06-27
**Status:** Accepted - **BUILT** (1a: non-blocking background job + live progress + cancel, #119; 1b:
detect + collapse the "Extract DURABLE facts…" ingest sessions into one group, decision #3).
The single highest-impact UX finding from the first real import: a ~25-minute ChatGPT-history ingest that
**froze the app**, showed **no progress**, and **polluted the session list** with hundreds of throwaway
"Extract DURABLE facts about…" chats.
**Increment:** P-KG-INGEST.1 (sliced 1a/1b). Two coupled problems (foreground blocking + session pollution)
with one root — the importer runs inline and each model extraction mints a visible chat session.

### Context

`harness/personal/importer.ts importConversations()` loops conversations and messages **sequentially**,
awaiting `distillTurn()` per user message; with model extraction on, each call hits the model backend. Three
defects compound:
1. **It blocks.** The work runs inline on the request the UI is awaiting; the app is unusable for ~25 min.
2. **No progress.** `importConversations` exposes `onProgress(done, total)` but it fires once per
   conversation and nothing surfaces it; the UI shows only a 2-second "Importing…" toast, then silence. The
   user only saw results after closing and reopening the panel.
3. **Session pollution.** Each model extraction calls `complete()` (`desktop/acp_backend.ts`), which opens an
   omp `session/new` (≈line 858). omp persists that session to disk before the close request, so every
   extraction becomes a row in the session list, titled from its first user message ("Extract DURABLE facts
   about…", `desktop/sessions.ts listSessions()`). For a large import that is hundreds of junk sessions.

### Decision - run ingest as a cancellable background job; emit a persistent progress channel; tag + collapse ingest sessions

1. **Background job, app stays live.** Move the ingest loop off the awaited request into a tracked background
   job (a `JobManager` keyed by `job_id`). The import endpoint returns the `job_id` immediately; the UI is
   never blocked and the user can work elsewhere (chat, graph, settings) while it runs. Honor a stable
   `EventName` for job lifecycle (`ingest.started|progress|done|failed`) carrying `run_id`/`session_id`.
2. **Live progress + periodic digest.** Push progress every conversation (and at least every 15–30 s) to a
   small **persistent** status surface — a pinned toast/status-pill showing `done/total`, a running
   elapsed/ETA, and a one-line digest of what was just ingested ("+12 facts, 3 new entities from 'Logistics
   planning'"). On completion: a summary (totals, duration) and a "View graph" action. On failure: fail-safe
   — partial facts already persisted stay, the job reports `failed` with a reason, nothing is half-written to
   the encrypted store mid-record.
3. **Tag ingest sessions; collapse them out of the chat list.** Stamp every session minted by the distiller's
   `complete()` with a `kind:"kg-ingest"` (or equivalent) marker at creation, and have `listSessions()` /
   the renderer **group** them under a single collapsible "Knowledge Graph Ingest" entry instead of N rows in
   the user's conversation history. They remain inspectable (provenance) but do not pollute the working list.
   Prefer suppressing disk persistence for these throwaway extraction sessions entirely if omp's SDK allows a
   non-persisted/ephemeral session; if not, the tag-and-group path is the fallback.

**Cancellable.** The job exposes cancel; cancel stops the loop at the next conversation boundary and leaves
already-distilled facts in place (fail-safe, never a torn write).

### Consequences

- The import IPC becomes async/polled (`start` → `job_id`; `status(job_id)` or an event stream). Reopening
  the panel is no longer how you discover results.
- A `kind` discriminator on sessions is additive; `sessions.ts` and the session-list renderer learn to fold
  the ingest group. This is the same machinery a future "system/automation sessions" grouping would want.
- `make demo-P-KG-INGEST.1`: kick a small import → assert the call returns before completion, progress events
  fire ≥1/15-30s, the app-equivalent request path stays responsive, ingest sessions carry `kind:"kg-ingest"`
  and collapse, and a mid-run cancel leaves a consistent store.

### Invariants preserved

Fail-closed/fail-safe (#3 — partial/cancelled/failed ingest never produces a torn encrypted record and never
marks unscanned content trusted); imported text still enters only via the scanned, delimited, late path
(#5 — backgrounding changes *when/where* it runs, not the gate it passes); event names stay in the
`EventName` enum (#8) with `run_id`/`session_id` (#9); no second Python surface (#2); frozen prefix untouched.

### Relates to

`harness/personal/importer.ts` (`importConversations`, the blocking loop + unused `onProgress`),
`harness/personal/distiller.ts` (`EXTRACT_SYSTEM`, the per-message extraction), `desktop/acp_backend.ts`
(`complete()` minting `session/new`), `desktop/sessions.ts` (`listSessions` titling/grouping), ADR-0073 (the
seam-then-UI slicing pattern), the KG instant-refresh bug (shared "results should appear without a reload").

## ADR-0077 - P-VAULT-HINT.1: locked-vault existence signal — the agent knows encrypted facts EXIST without seeing them

**Date:** 2026-06-27
**Status:** Accepted - **BUILT (boolean form)**. The fact COUNT lives inside the AES-GCM blob, so reading
it while locked would require a decrypt (forbidden, keystone #3) — per this ADR we degraded to the boolean
form: the hint signals a locked vault EXISTS, with no count. A count would need a non-secret sidecar manifest
(a future slice, gated by managed-config). Security-sensitive: it deliberately leaks only the EXISTENCE of a
locked vault across the boundary, so it gets its own over-tested gate.
**Increment:** P-VAULT-HINT.1. A narrow, audited change to the recall preamble when a compartment is locked.

### Context

`recallPreamble()` (`desktop/personal.ts` ≈line 317) builds the per-turn memory block. When a compartment is
**locked**, the store reference is null and it returns `""` — the agent gets **zero signal**. So when the
user asks "what do I like?" with their CUI/personal vault locked, the agent silently answers from nothing and
never says "I could answer better if you unlock your vault." The user explicitly wants the agent to *know
something is there and offer to unlock it*, while the actual data stays encrypted at rest. The decrypted
content is correctly walled off today (AES-256-GCM, DEK zeroed on lock, `crypto.ts`); only the **awareness**
is missing.

### Decision - when locked, inject a content-free existence hint built from already-known metadata; never decrypt

When a selected compartment is locked but configured (`PersonalStore.exists(...)` is already surfaced as
`cuiConfigured` in `PersonalStatus`, `personal.ts` ≈line 56), `recallPreamble()` returns a small structured
hint **instead of** the empty string:

```
<encrypted-vault locked="true" facts="N">
The user has a locked personal/CUI vault (N stored facts) that is encrypted and unreadable this turn.
If the answer would benefit from it, ASK the user to unlock — do not guess its contents.
</encrypted-vault>
```

1. **Metadata only, no content, ever.** The hint carries a **count** (and optionally coarse scope names like
   "personal", "CUI"), derived from cheap, non-secret metadata — NOT a decrypt. The decision is whether to
   expose even a count: yes, because a count is the minimum needed to make the offer credible and is far less
   sensitive than any fact. Expose **N** at most; if even the count is too revealing for a deployment, a
   managed-config knob (ADR-0068) can degrade it to a boolean ("a locked vault exists") or suppress it.
2. **It is an instruction to the agent, not untrusted data.** The block is first-party harness text in the
   trusted region telling the model how to behave (ask, don't fabricate). It contains no user/external
   content, so it does not pass — and must not appear to pass — through the untrusted-content delimiters.
3. **Fail-closed unchanged.** Locked still means **no decrypted facts reach the prompt** (#3). This ADR only
   adds a count-bearing breadcrumb on the locked path; the unlocked path is unchanged. The CUI hard-isolation
   (ADR-0014) holds — a locked CUI never decrypts to satisfy a hint; we read its fact count from metadata
   without opening the DEK.

### Consequences

- `PersonalStatus` may need a `lockedFactCount` (metadata, persisted outside the encrypted blob or derivable
  from a non-secret manifest) so the count is available *without* unlocking. If the count cannot be known
  without decrypting, degrade to the boolean form — never unlock to count.
- The agent's answers gain a polite "unlock for a fuller answer" path; the demo asserts the prompt contains
  the hint (with N) when locked, contains **no fact text**, and contains the normal recall when unlocked.
- `make demo-P-VAULT-HINT.1`: lock the vault, build the preamble, assert (a) a hint with a count is present,
  (b) **no** decrypted statement text appears anywhere in the prompt, (c) unlocking restores normal recall and
  drops the hint. This is a stop-the-line test alongside the semantic-promotion gate.

### Invariants preserved

Fail-closed (#3 — locked never yields decrypted content; a count is not content); untrusted-content delimiting
(#5 — the hint is first-party trusted instruction, not ingested data, and stays out of the untrusted block);
CUI hard isolation (ADR-0014 — no cross-compartment decrypt to satisfy a hint); closed trust set (#7);
frozen prefix untouched (the hint lives in the volatile recall tail, after the cache breakpoint, #6).

### Relates to

`desktop/personal.ts` (`recallPreamble`, `PersonalStatus.cuiConfigured`), `harness/personal/recall.ts`
(`buildRecallFromGraph` — the block this augments), `harness/personal/crypto.ts` (the lock that this respects),
ADR-0014 (CUI hard isolation), ADR-0068 (managed-config can degrade/suppress the count), keystones #2/#3.

## ADR-0078 - P-KG-REL.2: custom relation labels for manual relate

**Date:** 2026-06-27
**Status:** Accepted - BUILT.
**Increment:** P-KG-REL.2. UI completion of P-KG-REL.1 (ADR-0075) — the data layer already accepted any label.

### Context

P-KG-REL.1 shipped manual relationship authoring with a fixed `"related"` label (the ADR deferred custom
labels). `store.addLink` and the server-side `relateEntities` already accept + sanitize an arbitrary
relation string (control-char strip, whitespace collapse, 40-char cap). Only the inline-label UI was missing.

### Decision - a small optional label input in the Relate bar; pure resolution; server still sanitizes

`desktop/renderer/kg_ops.ts resolveRelationLabel(raw)` returns the trimmed input or `"related"` when blank.
The Relate bar gains a `#kgRelateLabel` text input (`maxlength=40`, placeholder `"related"`); both gestures
(drag-to-relate and multi-select Relate) read it via `currentRelationLabel()`, so a chain relate applies the
same label to every pair. The label flows through the existing optimistic path + `bridge.personalRelate`;
the SERVER remains the trust boundary (it sanitizes + caps, and links carry no trust label — first-party).

### Consequences

- No backend change: `relateEntities`/`addLink` already accept the label. `make demo-P-KG-REL.2` proves a
  custom label ("deploys with") round-trips through the encrypted store; the pure `resolveRelationLabel`
  default behavior is unit-tested.

### Invariants preserved

First-party authored edges (no scanner, no semantic promotion — keystone #2); the relation is display-only
(links never enter the prompt — recall is fact-only); server-side sanitation unchanged; closed trust set.

### Relates to

ADR-0075 (P-KG-REL.1, which this completes), `desktop/personal.ts` (`relateEntities`/`sanitizeRelation`),
`desktop/renderer/kg_ops.ts` (`resolveRelationLabel`).

## ADR-0079 - P-KG-INGEST.2: "Clear ingest sessions" bulk action

**Date:** 2026-06-27
**Status:** Accepted - BUILT.
**Increment:** P-KG-INGEST.2. Completes the housekeeping half of ADR-0076 (1b grouped them; this clears them).

### Context

P-KG-INGEST.1b grouped the throwaway "Extract DURABLE facts…" extraction sessions an import (and live
AI-learn) mint, but omp still persists each to disk; over time they accumulate. The user wanted them
cleanable in bulk, not one-by-one.

### Decision - one workspace-scoped bulk delete, gated by the SAME ingest detection

`desktop/sessions.ts clearIngestSessions(cwd, root?)` walks the omp session files and removes a file only
when it is BOTH (a) in the current workspace AND (b) an extractor throwaway (`isIngestPrompt` on its first
user message) — so a real chat is never deleted. Returns the count cleared (idempotent). Surfaced at
`POST /api/sessions/ingest/clear` + `bridge.clearIngestSessions()`; the renderer adds a trash affordance on
the "Knowledge Graph Ingest · N" group header with a confirm toast. The knowledge graph itself is a separate
encrypted store and is never touched — only the throwaway omp transcripts are removed.

### Consequences

- `make demo-P-KG-INGEST.2` proves: 9 throwaways cleared, the real chat survives, another workspace's
  ingest is left alone, and a second clear is a no-op. Two unit tests lock the same (incl. workspace scope).
- Still no ephemeral-session SDK seam (omp persists them up front); this is the cleanup path. If omp later
  exposes non-persisted sessions, the distiller's `complete()` should prefer that (then this becomes rare).

### Invariants preserved

The knowledge-graph store is untouched (only omp transcripts are deleted); deletion is workspace-scoped
(defense in depth, like `deleteSession`); no change to scanning/memory promotion; the append-only DuckDB
audit trail (issue #53) is intentionally separate and untouched.

### Relates to

ADR-0076 (P-KG-INGEST, 1b grouping this complements), `desktop/sessions.ts` (`isIngestPrompt`,
`deleteSession` — the scoped-delete pattern this mirrors).

## ADR-0080 - P-VAULT-HINT.2: a fact COUNT in the locked-vault hint — in memory, never on disk

**Date:** 2026-06-27
**Status:** Accepted - BUILT.
**Increment:** P-VAULT-HINT.2. Completes the count half deferred by ADR-0077.

### Context

P-VAULT-HINT.1 (ADR-0077) shipped the BOOLEAN locked-vault hint and deferred the count, noting the count
lives inside the AES blob (reading it while locked = a decrypt, forbidden). The backlog suggested a
"non-secret sidecar manifest" written on save to surface the count across restarts.

### Decision - capture the count IN MEMORY at lock time; reject the on-disk manifest (privacy)

We do NOT write a count manifest to disk. A plaintext fact-count next to the encrypted vault leaks
"this user has N stored facts" to anyone with file access — a privacy regression that contradicts the
product's security ethos. Instead, `lockPersonal()` / `lockCui()` capture the active fact count (the count
the user can already see while unlocked) into an in-memory `lastFactCount` the moment they lock. The locked
`recallPreamble()` passes that count to `lockedVaultHint`, which adds `facts="N"` ("about N stored facts").

Consequences of the in-memory choice:
- **No new on-disk surface, no decrypt** — the count is only ever derived from an ALREADY-unlocked store.
- The count appears in the COMMON flow (unlock → use → lock → ask). A FRESH locked start (app relaunch, vault
  never unlocked this session) has no count → it falls back to the boolean form (ADR-0077). That's the
  deliberate trade for not leaking a count to disk.
- A cross-restart count (the on-disk manifest) remains a possible OPT-IN follow-up, gated by managed-config
  per ADR-0077 — but off by default and not built here.

### Consequences

- `lockedVaultHint` gains an optional `count`; 0/omitted → boolean form. `make demo-P-VAULT-HINT.2` + 3 new
  `vault_hint.test.ts` cases prove the count enriches the hint, stays a number (never the facts), and reads
  naturally in the singular.

### Invariants preserved

Fail-closed (#3 — the count is captured only from an UNLOCKED store; locked never decrypts); the hint is
still a content-free, first-party signal (a number is not content); CUI isolation (ADR-0014 — counts kept
per compartment, surfaced only for the active scope); frozen prefix untouched (volatile recall tail).

### Relates to

ADR-0077 (P-VAULT-HINT.1, the boolean hint this enriches), `desktop/vault_hint.ts` (`lockedVaultHint`),
`desktop/personal.ts` (`lockPersonal`/`lockCui` capture, `recallPreamble`), ADR-0068 (managed-config would
gate an opt-in on-disk manifest), keystone #3.

## ADR-0081 - P-KG-INGEST.3: chat stays responsive during an AI-mode ingest

**Date:** 2026-06-27
**Status:** Accepted - BUILT.
**Increment:** P-KG-INGEST.3. The last import-UX item — finishes ADR-0076's "use the app while it ingests".

### Context

Model-mode ingest extracts facts by calling `backend.complete()` once per message, back-to-back, through
the SINGLE omp ACP connection. P-KG-INGEST.1a moved the import OFF the request thread (the app stays usable),
but a long AI import still fired extractions continuously, so a live chat turn competed with — and stalled
behind — the stream of extractions on the shared connection. The user saw chat freeze during AI imports.

### Decision - a ChatGate so background extraction YIELDS to a live chat turn (chat preempts the import)

`desktop/chat_gate.ts ChatGate` is a tiny state machine: `begin()`/`end()` bracket a chat turn; `whenIdle()`
resolves immediately when no chat turn is active, else when the current one ends. `prompt()` (chat) brackets
its turn with `chatGate.begin()/end()`; `complete()` (every utility completion — import extraction AND the
/goal checker) `await this.chatGate.whenIdle()` BEFORE creating its session. So while the user is chatting,
the import pauses between extractions and resumes after the reply — chat preempts the import with at most one
in-flight extraction of latency (seconds), instead of waiting out the whole import (minutes).

### Consequences

- Zero overhead when nobody is chatting (`whenIdle()` resolves synchronously). No change to import results —
  it's the same extractions in the same order, just yielding to chat. The /goal checker also yields (already
  sequenced after the maker turn, so a no-op there).
- A truly concurrent design (a SECOND omp process dedicated to extraction) would remove even the one-
  extraction latency, but it's a much larger change (a second backend instance) — deferred; the gate
  delivers responsive chat with a tiny, well-tested surface.

### Invariants preserved

No change to scanning/gating of imported text (keystone #2) or to memory promotion; the gate only reorders
WHEN extraction runs relative to chat. Fail-safe: `end()` always runs in `prompt()`'s `finally`, so a
stalled/errored chat turn can't leave the import permanently paused.

### Relates to

ADR-0076 (P-KG-INGEST.1a/1b, the background ingest this completes), `desktop/acp_backend.ts`
(`prompt`/`complete`/`utilLock`), `desktop/chat_gate.ts`.

## ADR-0082 - P-KG-REL.3: remove a relationship from the graph

**Date:** 2026-06-27
**Status:** Accepted - BUILT.
**Increment:** P-KG-REL.3. Completes manual relationship authoring — create (REL.1), label (REL.2), remove.

### Context

P-KG-REL.1/.2 let the user author relationships but never delete one — you could add an edge by mistake and
be stuck with it. The data layer had `addLink` but no removal.

### Decision - a removable relationships list in the node panel; mirror the relate path

`harness/personal/store.ts removeLink(from, to, relation?)` deletes matching user-authored link(s) (exact
relation, or all between the pair) and returns the count. `desktop/personal.ts unrelateEntities` wraps it
for the active scope (mirrors `relateEntities`); served at `POST /api/personal/unrelate` +
`bridge.personalUnrelate`. The node detail panel (`renderKgSide`) gains a **Relationships** section listing
each edge touching the node (with a direction arrow + the label) and a remove (×) button; clicking it
removes the edge OPTIMISTICALLY (`kg_ops.ts removeEdgeOptimistic`, rollback-safe) then calls the server.

### Consequences

- Symmetric with the forget-fact flow (optimistic mutate + reconcile + rollback). `make demo-P-KG-REL.3`
  proves the optimistic removal is rollback-safe AND `store.removeLink` persists the deletion through the
  encrypted store (only the targeted edge goes). Unit tests cover `removeEdgeOptimistic`.

### Invariants preserved

User-authored edges remain first-party (no scanner, no semantic promotion — keystone #2); removal is
scope-confined (the active store only); nodes/facts are untouched (only the edge is deleted); closed trust
set; no `contracts.ts` change.

### Relates to

ADR-0075/0078 (P-KG-REL.1/.2, which this completes), `harness/personal/store.ts` (`addLink`/`removeLink`),
`desktop/personal.ts` (`relateEntities`/`unrelateEntities`), `desktop/renderer/kg_ops.ts`
(`addEdgeOptimistic`/`removeEdgeOptimistic`).

## ADR-0083 - P-KG-SEARCH.1: find a node in the graph

**Date:** 2026-06-27
**Status:** Accepted - BUILT.
**Increment:** P-KG-SEARCH.1. Navigation for the large imported graphs the rest of this epic produces.

### Context

A real ChatGPT-history import yields hundreds of nodes. Finding a specific one means dragging the canvas
around hunting for a label — the single biggest navigation pain on a big graph. There was no search.

### Decision - a live search box that highlights + centers matches; pure matcher

A `#kgSearch` input in the KG toolbar. As the user types, `kg_ops.ts matchNodes(nodes, query)` (pure,
case-insensitive substring on name; empty → no matches) returns the matching ids, which the renderer hands
to `graph.setSearch(ids)`. The graph rings + brightens matches, **dims** the rest, and **centers** on the
matches (`computeFit` over the matched subset — reusing the #112 fit math). Esc (or clearing the box) drops
the filter. An active search is preserved across a live remount, like relate mode.

### Consequences

- Zero data change — display-only highlight/zoom. `make demo-P-KG-SEARCH.1` + unit tests cover the pure
  `matchNodes`; the SVG highlight/center is the renderer layer (verified by the browser bundle + by eye).
- Fitting to a single match zooms in on it (scale capped at the existing max), so a unique name jumps
  straight into view.

### Invariants preserved

Display-only (no store/scan/promotion change); reuses the existing fit math (#112) and the dirty-flag paint
loop (#114 — search just toggles node classes, no new per-frame cost).

### Relates to

ADR-0072-ish KG view, `desktop/renderer/kg_ops.ts` (`matchNodes`), `desktop/renderer/graph.ts`
(`setSearch`/`computeFit` subset), the #112 fit-transform this reuses.

## ADR-0084 - P-PERF.1: snappy cached UI — instant session list + transcripts (stale-while-revalidate)

**Date:** 2026-06-27
**Status:** Accepted - BUILT (first slice: session list + chat transcripts).
**Increment:** P-PERF.1. Make a RETURNING user's UI instant; the rest of the app stays on its live poll.

### Context

The bridge fetches with `cache: "no-store"`; every navigation re-fetches. The two user-felt costs are
(1) clicking a chat session re-loads its transcript from disk → a blank thread until it arrives, and
(2) the session list re-fetches on each load → a skeleton flash even for a returning user. The live panels
(security/memory/usage) are already instant on tab-switch because a global 4s poll keeps `state` warm and
the inspector is hash-memoized — so they're out of scope.

### Decision - a tiny localStorage-backed SWR cache for data that is ALREADY plaintext on disk

`desktop/renderer/swr_cache.ts`: paint the cached value immediately, then fetch fresh and re-render ONLY if
it changed (a `transcriptSig` compare avoids a flicker on a cache-hit). Persisted to `localStorage` so it
survives reload/restart. `renderSessions` hydrates the list from `lucid.sessions` on a cold list (no
skeleton for a returning user); `resumeSession` paints `cachedTranscript(id)` instantly, then reconciles.
Transcripts are LRU-capped (15 sessions × ≤400 msgs) so `localStorage` can't grow unbounded.

**Privacy boundary (deliberate).** ONLY the session list + chat transcripts are cached — and omp already
persists those as plaintext `~/.omp/.../*.jsonl`, so this adds NO new at-rest exposure. The encrypted
Knowledge-graph store is **never** written to `localStorage` (that would defeat its at-rest encryption); it
stays in-memory only. The cache module documents this boundary.

### Consequences

- A returning user: the session list appears with no skeleton, and clicking a session shows its transcript
  with no blank-thread gap; both refresh silently. `make demo-P-PERF.1` + `swr_cache.test.ts` cover the
  cache (round-trip, LRU eviction, per-transcript cap, sig-compare). Storage backend is injectable (an
  in-memory fallback) so it's testable headlessly and degrades safely when `localStorage` is absent/quota'd.
- Stale risk is bounded: a transcript edited elsewhere shows briefly stale then reconciles on the same open;
  the list re-caches on every fetch and on session create/delete (which re-render it).

### Invariants preserved

No new plaintext-at-rest surface (only already-plaintext omp transcripts; the encrypted KG is never
cached); best-effort + fail-safe (cache errors degrade to a normal fetch, never throw); no server change.

### Relates to

`desktop/renderer/bridge.ts` (`sessions`/`sessionMessages`, the `no-store` fetches this fronts),
`desktop/renderer/app.ts` (`renderSessions`/`resumeSession`), the existing `lucid.config` localStorage
pattern this mirrors, ADR-0010 (the encrypted personal store this deliberately does NOT cache).

## ADR-0085 - P-KG-INGEST.4: true ingest concurrency — a dedicated omp connection for extraction

**Date:** 2026-06-27
**Status:** Accepted - BUILT.
**Increment:** P-KG-INGEST.4. Supersedes the yield-based mechanism of P-KG-INGEST.3 (kept as the fallback).

### Context

Utility completions (`backend.complete()`: import + AI-learn fact extraction, and the /goal checker) ran on
the SINGLE omp ACP connection that chat uses. P-KG-INGEST.3 (ADR-0081) added a `ChatGate` so extraction
YIELDS to a live chat turn — but they still share one omp process, so chat waits out up to one in-flight
extraction. The user asked for TRUE concurrency: extraction on its own process, zero chat impact.

### Decision - a second, dedicated omp connection for util completions, with a fail-safe fallback

`acp_backend` lazily spawns a SECOND `omp acp` (`utilAcp`) the first time a util completion runs. It has its
own event sink (`utilSink` collects only `agent_message_chunk` text — extraction is text-only; no tools,
permissions, or gate-block surfacing) so it NEVER swaps the chat listener. `complete()` routes via the pure
`util_conn.ts completionPath()`:
- **dedicated** (util spawned) → `completeOn(utilAcp, …)` — runs flat-out, no ChatGate yield (the connections
  are independent). A 25-minute AI import no longer competes with chat at all.
- **shared-fallback** (util spawn failed) → `completeShared(…)` — the EXISTING path: shared connection,
  listener-swap, `ChatGate.whenIdle()` so chat still preempts. This is today's proven behavior, so a host
  that can't run a second omp degrades safely rather than erroring.

`restart()` tears down `utilAcp` too (so a key/env change respawns both).

### Consequences

- The chat path is UNCHANGED (`completeShared` is the old `complete()` body verbatim) — the full desktop +
  harness suites stay green, which is the load-bearing regression check for a core-backend change.
- Cost: a second omp process during extraction (memory + a model connection). Acceptable for true
  concurrency; it only spawns when a util completion actually runs (lazy), and is torn down on respawn.
- The live "import while chatting" property is integration behavior (real omp + model); it's verified here by
  design + the fail-safe + the suite, with a manual end-to-end check as a follow-up. The routing/fail-safe
  contract is unit-tested (`util_conn.test.ts`) + `make demo-P-KG-INGEST.4`.

### Invariants preserved

Imported text still enters only via the scanned, gated path (keystone #2 — the util omp still runs with the
gate `-e`); the dedicated connection never touches the chat listener/session (chat isolation); fail-safe
(spawn failure → proven shared path, never an error); no `contracts.ts` change.

### Relates to

ADR-0081 (P-KG-INGEST.3 ChatGate — now the fallback), `desktop/acp_backend.ts` (`startUtil`/`completeOn`/
`completeShared`), `desktop/util_conn.ts` (the routing contract), `desktop/chat_gate.ts` (fallback yield).

## ADR-0086 - Licensing: Business Source License 1.1 (source-available, converts to MPL-2.0)

**Date:** 2026-06-27
**Status:** Accepted - BUILT (LICENSE + per-file SPDX headers + package.json + README).
**Increment:** chore/busl-license. A repo-level legal decision, recorded here for future contributors.

### Context

The core needed an explicit license. We want a source-available model — read/modify/self-host + production
use allowed — that still protects the business from a competitor offering a hosted clone, with an eventual
open-source conversion. The HashiCorp/Terraform model (BSL 1.1) fits exactly.

### Decision - BUSL-1.1 with the Terraform-style parameters

`LICENSE` (root) is the canonical Business Source License 1.1 with:
- **Licensor:** TechLead 187 LLC.
- **Licensed Work:** LucidAgentIDE.
- **Additional Use Grant:** production use permitted EXCEPT offering a hosted/embedded commercial product
  competitive with TechLead 187 LLC's products (the non-compete).
- **Change Date:** 2030-06-27 (4 years).
- **Change License:** Mozilla Public License 2.0 (GPL-compatible per BSL Covenant #1; HashiCorp's choice).

Every FIRST-PARTY source file carries `// Copyright (c) 2026 TechLead 187 LLC` + `// SPDX-License-Identifier:
BUSL-1.1` (`#` for Python), applied idempotently by `tools/license_headers.ts` (`make license-headers`;
`make license-check` is the CI guard). `package.json` sets `"license": "BUSL-1.1"`.

**Excluded from headers (keep their own licenses):** `vendor/oh-my-pi`, `node_modules`, `desktop/release`
(packaged build), and the Python `.venv` / `__pycache__`.

### Consequences

- BSL is **source-available, NOT OSI open source** — the README's "OSS core" wording was corrected to
  "source-available core", and the prior "All Rights Reserved / no license granted" note replaced with the
  BSL summary. Each version converts to MPL-2.0 on its Change Date.
- The premium enterprise add-on remains a separate, separately-licensed repository.
- NOT legal advice — counsel should review before commercial reliance; the LLC is being registered (FL).

### Invariants preserved

Headers are comments only — no functional change; the byte-stable prompt prefix (#6) is unaffected
(prefix is built from string constants, not file bytes — `harness/prompt` tests stay green); the vendored
omp tree is untouched (extend-don't-fork, and its license is preserved).

### Relates to

`LICENSE`, `tools/license_headers.ts`, `package.json`, `README.md`. BSL 1.1 text © MariaDB (used per its
permission grant). Change License: Mozilla Public License 2.0.

-----

## ADR-0087 - About panel + a single-sourced, dynamic app version (launch baseline v1.8.7)

**Date:** 2026-06-27
**Status:** Accepted - BUILT.
**Increment:** P-ABOUT.1.

### Context

Approaching launch, the product had no in-app "About": no place stating what LUCID Agent IDE is, who owns
it (TechLead 187 LLC), the BUSL-1.1 license, or the version. The version also lived only in
`desktop/package.json` (and was a pre-launch `0.1.0`); nothing surfaced it to the user, and any UI display
would have been a hardcoded literal that drifts. Launch wants the version to jump to **v1.8.7**.

### Decision

- **Single-sourced version.** `desktop/version.ts` exports `APP_VERSION = "1.8.7"`; `desktop/package.json`
  `"version"` MIRRORS it (electron `app.getVersion()` / electron-builder read package.json). `about.test.ts`
  + `demo-P-ABOUT.1` assert the two are equal, so a bump in one is forced into the other. The renderer
  imports `APP_VERSION` (bundled), so the About panel shows the live version — never a hardcoded duplicate.
- **About panel.** A new animated rail glyph (`#railAbout`, a book + twinkling sparkle in the existing
  24×24 / 1.6-stroke icon family) sits ABOVE Commands + Settings on the activity rail. It opens a polished
  dark-mode modal (`desktop/renderer/about.ts`, a PURE string builder so it is demo/test-able without a
  DOM): the LUCID · AGENT IDE wordmark hero, a one-paragraph product summary, and a TechLead 187 LLC card
  with the emblem + the BUSL-1.1 terms (Change Date 2030-06-27 → MPL-2.0; "source-available, not OSI
  open-source"). Closes on the X / Close button, a backdrop click, or Escape; single instance.

### Consequences

- One number to bump per release (`version.ts`), guarded against drift by a test.
- `about.ts` is pure → the panel's content is unit-tested and demo-proven; `app.ts` only owns open/close.
- The interpolated version is HTML-escaped at the boundary (defensive; the value is first-party).
- Honors `prefers-reduced-motion` (all About animations disabled).

### Invariants preserved

Renderer-only + additive: no prompt prefix, no scanner, no trust-label, no schema change. New first-party
files carry the BUSL-1.1 header (ADR-0086).

### Relates to

`desktop/version.ts`, `desktop/package.json`, `desktop/renderer/about.ts`, `desktop/renderer/app.ts`
(`#railAbout` + `openAbout`), `desktop/renderer/styles.css` (`.about-*`), `desktop/about.test.ts`,
`desktop/scripts/demo_p_about_1.ts`.

## ADR-0088 - Role-based onboarding + opinionated, progressively-disclosed views (Dev / Sec / Mgr / Exec)

**Date:** 2026-06-28
**Status:** Accepted - SCOPE/PLAN.
**Increment:** P-ROLE.1 (phased: P-ROLE.1 / .2 / .3 / .4).

### Context

First-run onboarding is identity-only: `promptForEmailIfMissing()` (`desktop/renderer/app.ts`) captures a
corporate email — or skips to workstation attribution — and writes it via `setProfile()` to
`~/.omp/lucid-gui.json`. There is **no notion of who the user is by job function**. Meanwhile the UI has
grown dense: five inspector surfaces (Chat, Security, Memory, Knowledge, Dev-logs), an ~8-segment status
bar, an 8-tile quick-metrics rail, plus About / Commands / Settings rails. A developer chasing flow-state,
a security engineer triaging quarantine, a delivery manager watching spend, and an executive wanting one
reassuring posture light all see the **same** wall of metrics — most of it irrelevant to any one of them,
and overwhelming to all. The product needs opinionated, role-shaped defaults that streamline without
amputating capability.

Exactly one role-ish mechanic exists today and points the way: Dev-logs is hidden unless `developerMode`
is on, and **ADR-0021 auto-reveals the Security tab the instant a block fires**. That "hide until it
matters, then surface it" pattern is the seed we generalize.

### Decision

**The load-bearing rule: roles change DEFAULTS and CHROME, never ENFORCEMENT.** A role is a presentation
preset. It picks the landing surface, which pills/status-segments/quick-tiles render, and which rails are
visible by default. It does **not** touch the security gate, the scanner, trust labels, event emission, or
the prompt prefix. A Developer who never opens the Security panel is exactly as protected as a Security
Engineer: the fail-closed gate still blocks (invariant #3), the event is still emitted to the audit sink
(#8), and a real block still **force-reveals** the Security surface for every role.

- **Disclosure model = defaults + always-reachable** (not hard-hide). Nothing is ever removed from the
  app. Every panel stays reachable via the Command palette and a Settings "Show all panels" switch; the
  role only sets what is *foregrounded*. This is the safest stance against invariant #3 — a role can never
  bury a security surface beyond reach.

- **Four roles**, captured at onboarding and persisted as
  `userRole?: "developer" | "security" | "manager" | "executive"` in `GuiSettings`
  (`desktop/settings_store.ts`), reusing the existing `setProfile` → `/api/settings` → bridge path the
  email gate already uses. Unset ⇒ **Developer** (the safe, full-surface default). Each role's preset:

  - **Developer** (default) — lands on Chat + Memory (context / cache / cost). Rails: Chat, Memory,
    Knowledge. Status pills: model · context-fill · cache-% · session-cost. Quick tiles: cache-savings-% ·
    avg-tok/turn · context · AI-authored-LOC. Security collapsed to a single green "gate active" until a
    block lights the badge. Dev-logs off.
  - **Security Engineer** — lands on the Security inspector. Rails: Chat, Security, Dev-logs (on), Memory.
    The Security badge is **always on** (green "0 / gate active", never hidden). Pills: quarantined ·
    awaiting-review · findings-by-severity · promotion-gate (blocked/promoted) · egress-blocks ·
    exec-approvals (T0–T4) · trust-label mix · SIEM sink delivery (✓/✕). Transcripts + audit on.
  - **Manager** — lands on the cost / delivery ledger. Rails: Chat, Memory→Ledger, Loop/AAR. Pills:
    session + monthly spend · cache-savings-$ (% off full price) · AI-LOC by repo/model · loop
    success-rate & avg-iterations-to-win · budget-% · AskSage gov-usage-%. Security appears as a *count
    rollup* chip, not the findings table. Dev-logs off.
  - **Executive** — lands on a posture + spend summary; the Engineering Update Brief + podcast (P-BRIEF)
    is the marquee surface. Rails: Chat, Brief, Spend. Four reassurance tiles only: 🟢 security posture
    ("protected — N blocked this month") · monthly spend rollup · AI productivity (LOC/month) ·
    governance posture (gov-lockdown · FIPS · CUI-isolated · audit-export-ready). Everything operational
    is hidden (but reachable).

- **"Reveal on relevance" engine** (generalizes ADR-0021), three rules: (1) **Escalation reveal** — a
  hidden surface un-hides when an event of its class fires: a block lights the Security badge for everyone;
  a budget breach surfaces the budget chip for Mgr/Exec; a quarantine pulls the Exec posture tile 🟢→🟠.
  (2) **Always reachable** — Command palette + "Show all panels" open any surface regardless of role.
  (3) **Policy override wins** — managed GPO/MDM policy (ADR-0068) may pin a role or force-show audit for
  Sec, and may only *tighten*, never loosen.

- **Onboarding flow** — the existing email gate becomes a two-step modal: Step 1 picks a role (four cards,
  each with a one-line "what you'll see"), Step 2 is the unchanged email/attribution step. Role is also
  switchable any time from Settings → Profile. Managed policy can pin it (the switcher then shows the
  policy source and disables).

### Phasing

- **P-ROLE.1** — persist `userRole` + role→default-view map; two-step onboarding modal; Settings switcher.
- **P-ROLE.2** — per-role chrome presets (rails / status pills / quick tiles) over the panels that already
  exist. Pure presentation layer; no new dashboards.
- **P-ROLE.3** — the reveal-on-relevance engine (generalize ADR-0021) + managed-policy role pin.
- **P-ROLE.4** *(later)* — dedicated Manager (delivery/showback) and Executive (posture/brief) aggregate
  dashboards. These surfaces don't exist yet; until built, Mgr/Exec reuse the Memory ledger + P-BRIEF.

### Consequences

- Streamlines the first-run experience per job function without reducing any user's reachable capability.
- A role is cosmetic state in `lucid-gui.json` — no schema change, no DuckDB migration, no prompt-prefix
  byte (role lives in the volatile tail / settings, never layers 1–4, so the KV cache is untouched, #6).
- Adds a presentation-layer escalation engine; the security INVARIANT is unchanged because the gate's
  blocking path and event emission never consult `userRole`. A test must assert a Developer-role session
  still blocks + still emits on the kill-sidecar fixture (over-tested per the keystones list).
- Risk surfaced & rejected: hard-hiding surfaces by role could bury a security signal. Rejected in favor
  of defaults + always-reachable + forced reveal.

### Invariants preserved

#3 fail-closed (roles are cosmetic; the gate never reads `userRole`), #5/#7 untrusted delimiting + the
closed trust-label set untouched, #6 frozen prefix untouched (role is tail/settings state), #8 every event
still emitted regardless of who is looking. New first-party files carry the BUSL-1.1 header (ADR-0086).

### Relates to

`desktop/settings_store.ts` (`GuiSettings.userRole` + setter), `desktop/dev.ts` (`/api/settings`),
`desktop/renderer/bridge.ts` (`ProfileSettings`), `desktop/renderer/app.ts` (`promptForEmailIfMissing` →
two-step onboarding, `secProfile` switcher, rail/status/quick-tile presets, generalized ADR-0021 reveal),
ADR-0021 (auto-reveal Security on block), ADR-0068 (managed GPO/MDM policy), P-BRIEF (Exec marquee),
ADR-A008 (showback, Manager).

## ADR-0089 - First-run guided walkthrough (coachmark tour), role-tailored, reusing the model hover-card style

**Date:** 2026-06-28
**Status:** Accepted - SCOPE/PLAN.
**Increment:** P-ROLE.1b (runs right after role capture in P-ROLE.1; re-launchable from About per ADR-0087).

### Context

A first-time user lands in a dense IDE — rails, an inspector, a status bar of pills, a composer with model /
mode / thinking / persona controls. ADR-0088 picks a *role* and shapes the defaults, but it does not *teach*:
nothing points at "this rail is your Security queue," "this pill is your context window," "hover any model for
the full card." We already built one piece of UI delight worth echoing — the **premium per-model hover card**
(`.modeltip` / `modelTipHTML()` / `showModelTip`): a floating, anchored card that fades in with a
`translateY+scale`, reads from a pure string builder, and positions itself off a target's `getBoundingClientRect()`.
A guided walkthrough that *looks and moves like that card* will feel native, not bolted on. It must be skippable,
must never replay once dismissed, and must be re-launchable on demand from the About panel.

### Decision

A **role-tailored, first-run coachmark tour** — a sequence of premium cards, each anchored to (and spotlighting)
a real UI element, that reuses the model hover-card's visual language and positioning math.

- **Trigger / once-only.** The tour is the *third* onboarding step, after role (Step 1) and email (Step 2),
  fired from the same first-login signal the email gate uses (`!state.attribution?.decided` ⇒ no saved/cached
  profile). A new cosmetic flag `tourSeen?: boolean` in `GuiSettings` (`~/.omp/lucid-gui.json`, like `userRole`)
  gates replay: set `true` on **finish OR skip**, so the tour never re-appears uninvited. The init sequence
  awaits role + email, then — if `!tourSeen` — calls `startTour(role)`.

- **Re-launchable from About.** The About panel (ADR-0087, `about.ts`) gains a "Take the tour" button in
  `.about-actions`; clicking it closes About and calls `startTour(currentRole)` unconditionally (ignores
  `tourSeen`). This is the "do it later" path the user asked for.

- **The coachmark = the model card's twin.** A new `.coach` card borrows `.modeltip`'s tokens (`--bg-4`,
  `--line-strong`, `--shadow`, the `.show` fade-in with `translateY(4px) scale(.98)→none`) and its anchor
  math (position off the target's rect; flip to the other side when it would overflow the viewport). It DIFFERS
  in two ways the hover card cannot: it is **interactive** (`pointer-events:auto`; the hover card is
  `pointer-events:none`) and it paints a **spotlight backdrop** — a dimmed overlay with a transparent cutout
  around the target (a positioned ring element with a large-spread `box-shadow`), so the eye goes to the
  highlighted control. Each card carries: a title, a one/two-line description, a "Step N of M" dot row,
  Back / Next (Next→"Done" on the last step), and a persistent **Skip**. Esc = skip; Enter = next.

- **Role-tailored steps.** A master step catalog (pure data) maps each step to a target selector + copy; a
  `role → steps[]` table selects the subset that matters to the chosen role (mirrors ADR-0088's foregrounding):
  - *Developer* — composer → model picker (with the meta-hint "hover any model for the full card") → Memory
    inspector (context / cache / cost) → Knowledge rail → Command palette → About glyph.
  - *Security* — composer → Security rail + badge → quarantine / approvals queue → Dev-logs → audit export →
    Command palette.
  - *Manager* — composer → cost / delivery ledger → loop / AAR → spend + budget pills → Command palette.
  - *Executive* — composer → posture pill → spend rollup → the Engineering Update brief → Command palette.
  - *Universal closer* (all roles) — "Anything hidden is one ⌘K away; replay this tour any time from About."
  A step whose target is not in the DOM for that role (hidden surface) is **skipped gracefully**, never a
  dangling arrow pointing at nothing.

- **Motion / a11y.** Honors `prefers-reduced-motion` (no translate/scale, instant placement; backdrop fades
  only). Focus moves into the card; the card traps Tab between Back/Next/Skip; Esc always exits.

### Consequences

- New users get oriented to exactly the surface their role uses, in the app's own premium idiom — and can bail
  with one Skip, or replay from About forever.
- The visual language is shared with the model hover card, so polish stays consistent and the CSS is largely
  reuse, not new invention.
- `tourSeen` is cosmetic settings state — no schema change, no DuckDB migration, no prompt-prefix byte.
- Step content lives in a **pure builder** (`tour.ts`, like `about.ts`), so the catalog + per-role selection
  are unit-tested and demo-proven without a DOM; `app.ts` owns only the engine (backdrop, anchoring, nav).
- Risk: a step's target selector can rot if the UI is refactored. Mitigated by a test asserting every catalog
  selector is a constant referenced from the renderer, and by the skip-if-absent behavior failing *safe*
  (a missing target drops its step, never breaks the tour).

### Invariants preserved

Renderer-only + additive. #3 fail-closed untouched (the tour is cosmetic; it never gates or un-gates anything),
#5/#7 untrusted-delimiting + closed trust-label set untouched, #6 frozen prefix untouched (`tourSeen` is
tail/settings state), #8 event emission unaffected. New first-party files carry the BUSL-1.1 header (ADR-0086);
all tour copy is first-party + HTML-escaped at the boundary.

### Relates to

ADR-0088 (role onboarding — the tour is its teaching step), ADR-0087 (About panel — the re-launch button +
`.about-actions`), `desktop/renderer/about.ts` (`aboutHtml` gains "Take the tour"), `desktop/renderer/app.ts`
(`modeltip`/`showModelTip` anchor math reused by `startTour`; init sequencing after `promptForEmailIfMissing`),
`desktop/renderer/styles.css` (`.modeltip` tokens → `.coach*` + `.coach-spot` backdrop),
`desktop/settings_store.ts` (`GuiSettings.tourSeen`), new `desktop/renderer/tour.ts` (pure step catalog +
role→steps), `desktop/tour.test.ts`, `desktop/scripts/demo_p_role_1b.ts`.

## ADR-0090 - In-app network diagnostics for the OAuth localhost callback (developer-mode watcher)

**Date:** 2026-06-29
**Status:** Accepted - BUILT.
**Increment:** P-NETDIAG.1 (developer-mode only; lives in the existing Logs panel, ADR-0009 Phase D).

### Context

OAuth sign-in routes through omp's `auth-broker login`, which opens the provider in a browser and runs a
LOCAL loopback callback server to catch the redirect (OpenAI's Codex broker uses a fixed `127.0.0.1:1455`;
other providers use ephemeral ports). The recurring failure is the browser showing "localhost refused to
connect," which has three very different root causes the user cannot tell apart: (a) nothing ever bound the
port (the broker died before listening - e.g. the full-stdout-pipe hang `dev.ts` already warns about),
(b) some OTHER process squats the port, or (c) the bind landed on a different interface/family than the
browser hit. A first cut was a standalone terminal tool (`tools/netwatch.ts`); it works but is the wrong
ergonomics - you have to start it by hand at the right moment, and the OAuth window is easy to miss
(OTP entry stretches the flow to 30-45s, and the bind can be brief). Two bugs in that first cut also made it
report "nothing happened": it filtered to loopback-only (so an all-interface `0.0.0.0` bind was invisible),
and it printed only on change (so a long wait looked like a hang).

### Decision

A **continuous, in-app network-diagnostics watcher**, surfaced as a **Network diagnostics** accordion in the
read-only developer Logs panel (the same surface as telemetry / run lineage / AskSage diagnostics).

- **Always-on while developer mode is on.** A background poller (`desktop/netdiag.ts`, 2s interval) runs in
  the backend the entire time developer mode is enabled - started on the dev-mode POST and self-healed on
  each `/api/dev` read (so a boot-time `loadDev()` brings it up). By the time the Logs panel is opened, the
  OAuth window is already captured. It stops when developer mode is turned off.
- **What it captures.** A rolling event log (bounded, last 400) of: loopback connections, EVERY listener
  (loopback AND all-interface `0.0.0.0` / `[::]` binds - the fix for the missed-bind bug), an active TCP
  probe of the callback port(s) (`nc -z`-style), and the Windows DNS resolver cache. A brand-new LISTENING
  socket on a watched/loopback port is flagged a **callback candidate** - the single decisive "did the
  broker bind, and which process owns it?" signal. `127.0.0.1:1455` is always probed; any other (ephemeral)
  callback port is still caught by the socket diff.
- **OS tools, read-only.** Windows: `netstat -ano` + `tasklist` (PID→image) + `Get-DnsClientCache`.
  macOS/Linux: `lsof -nP -iTCP` (the command is the process; no DNS). It NEVER binds, blocks, or mutates -
  pure diagnostics. The TCP probe is a throwaway connect that is immediately destroyed.
- **Pure core, tested.** The parse (`parseNetstatLine` / `parseLsofLine` / `parseTasklistCsv`) and the
  snapshot DIFF (`diffSockets`, candidate-flagging) are pure and unit-tested against canned OS output; the
  timer and the `Bun.spawnSync` calls are the only impure parts. `tools/netwatch.ts` is kept as the
  standalone CLI for ad-hoc terminal use.

### Consequences

Developers get a self-collecting, always-on diagnostic for the most opaque sign-in failure, without dropping
to a terminal or hand-timing a capture. Cost: while developer mode is on, the backend shells out to
netstat/tasklist every ~2-6s and powershell (DNS) every ~6s - acceptable for an opt-in, off-by-default
developer surface, and zero when developer mode is off (the watcher never starts). The watcher is
Windows-first; macOS/Linux use the `lsof` path (no DNS); unknown platforms degrade to `supported:false` with
an empty, non-throwing view.

### Invariants preserved

#3 fail-closed UNTOUCHED - this is read-only diagnostics, never a gate input; it emits no allow/block/quarantine
verdict (the demo asserts the view shape carries no gate-like field). #2 language boundary preserved - all
TypeScript, no new `.py` (the watcher shells out to OS tools, it does not add a Python surface). #6 frozen
prefix untouched (no prompt change). #8 events untouched (the network event log is a developer-mode UI feed,
not an `EventName` telemetry event). New first-party files carry the BUSL-1.1 header (ADR-0086).

### Relates to

ADR-0009 Phase D (the developer Logs panel this extends), `desktop/dev.ts` (`startOauthBroker` - the callback
server being diagnosed; `/api/dev` now carries `netdiag`), new `desktop/netdiag.ts` (watcher + pure helpers),
`desktop/netdiag.test.ts`, `desktop/scripts/demo_p_netdiag_1.ts`, `desktop/renderer/bridge.ts`
(`DevView.netdiag` + `NetDiagView`), `desktop/renderer/app.ts` (`devHtml` Network diagnostics accordion),
`desktop/renderer/styles.css` (`.dev-subh`), `tools/netwatch.ts` (the standalone CLI sibling).

## ADR-0091 - OAuth re-login self-heal: clear a stale `disabled_cause` so a fresh login "sticks"

**Date:** 2026-06-29
**Status:** Accepted - BUILT.
**Increment:** P-NETDIAG.1b (the fix the P-NETDIAG.1 watcher led us to; same session).

### Context

Diagnosing a real "I logged into OpenAI but it didn't save" report (the case that motivated ADR-0090), the
credential vault (`~/.omp/agent/agent.db`, `auth_credentials`) showed the truth: the `openai-codex` row had a
**valid, freshly-written** OAuth token (`updated_at` = the login moment; access + refresh present), yet still
carried **`disabled_cause = "logged out by user"`** from an earlier *Disconnect*. omp counts a credential as
active only when that column is null (`auth_status.ts` filters `!disabled_cause`), so the good token was
ignored. Worse, omp's `auth-broker logout` *disables* the row rather than deleting it, and `auth-broker login`
updates the token blob without clearing the flag - so re-clicking "Connect via OAuth" can never recover; the
provider is stuck logged-out forever. omp exposes no `delete` / `re-enable` verb (`login|logout|status|list|
import|migrate` only), so the harness must compensate.

### Decision

A narrow vault helper, `desktop/auth_vault.ts` → `clearDisabledCredential(provider)`, that nulls ONLY the
`disabled_cause` column for a provider (the token blob, identity, and every other column are untouched), and
two call sites:

- **Automatic self-heal.** `dev.ts startOauthBroker`'s success path (broker exit 0) calls it for the just-
  logged-in `oauthId` *before* `backend.restart()`, so a successful login clears any stale logout flag and the
  respawned omp picks up the now-active provider. Re-login is now idempotent and always "sticks".
- **One-shot repair CLI.** `tools/omp_auth_reenable.ts <provider>` for an already-stuck vault (pairs with the
  read-only `tools/omp_auth_status.ts`). Used live to un-stick `openai-codex` this session.

Read-before-write (only writes when a disabled row exists), `PRAGMA busy_timeout=2000` to tolerate the running
app's lock, and fully best-effort: any failure (missing/locked db, future schema drift) returns "0 cleared"
and never throws.

### Consequences

The most confusing OAuth failure mode - "it logged in but nothing happened" - now self-corrects, and an
already-stuck credential is a one-command fix. Cost/risk: the harness now WRITES to omp's otherwise-private
vault. Mitigated by touching exactly one column, never the token; by failing closed/quiet on any error; and by
keeping it OUT of the security path (this is a convenience repair, not a gate - invariant #3 is about the
scanner). If a future omp changes the column name or starts clearing the flag itself, this degrades to a
harmless no-op.

### Invariants preserved

#1 extend-omp-don't-fork preserved - we compensate for omp behavior through a tiny vault helper, no fork, no
omp source change. #2 language boundary (TypeScript, `bun:sqlite`; no new `.py`). #3 fail-closed UNTOUCHED -
this never feeds the gate and emits no allow/block verdict; it only re-enables a credential the user already
obtained. #10 (DuckDB schema-freeze) untouched - this is omp's SQLite vault, not our DuckDB. New first-party
files carry the BUSL-1.1 header (ADR-0086).

### Relates to

ADR-0090 (the netdiag watcher whose investigation surfaced this), `desktop/dev.ts` (`startOauthBroker` success
path), new `desktop/auth_vault.ts` + `desktop/auth_vault.test.ts`, new `tools/omp_auth_reenable.ts`,
`tools/omp_auth_status.ts` (read-only sibling), `desktop/auth_status.ts` (the `!disabled_cause` active filter
this unblocks).

## ADR-0092 - P-DOC.1: Role-based user guides (per-role capability docs with screenshot placeholders, Tips, and cited Notes & References)

**Date:** 2026-06-29
**Status:** Accepted - SCOPE/PLAN + first pass shipped.
**Increment:** P-DOC.1.

### Context

ADR-0088 shaped the product into four roles (Developer / Security / Manager / Executive) that change
*defaults and chrome, never enforcement*, and ADR-0089 added a first-run coachmark tour that teaches each
role its foregrounded surfaces. But onboarding teaches the UI in ten seconds and then disappears; there is
no durable, role-shaped **reference** a user can read end to end, link a teammate to, or hand an auditor.
The repo's prose is engineer-facing (`README.md` capability tour, `DECISIONS.md` ADRs, `CLAUDE.md`
invariants, `CHEATSHEET.md` commands) - none of it is organized around *what a given role does, step by
step, with a picture of the screen in front of them.* A Security engineer triaging quarantine, a Manager
reading the cost ledger, and an Executive glancing at a posture light each need a different document, not
the same wall of features.

### Decision

Ship **one user guide per role** under `docs/guides/`, plus an index, each generated to a **fixed
structure** so the four read as a family and a fifth role (if one is ever added) slots in unchanged. Docs
only - no code, no schema, no prompt-prefix bytes - so every invariant is trivially preserved (the guides
*describe* the fail-closed gate, they never touch it).

- **Files.** `docs/guides/README.md` (index + "which guide is me?"), `docs/guides/developer-guide.md`,
  `security-guide.md`, `manager-guide.md`, `executive-guide.md`. Markdown carries **no SPDX header**
  (matches the existing `docs/*.md` convention; the header set is `harness/ desktop/ tools/
  scanner-sidecar/` only, ADR-0086). Screenshot binaries live under `docs/guides/images/` and are
  **placeholders in the first pass** (referenced, not committed) - the guide names exactly what each
  capture should show so a designer can fill them later.

- **Fixed per-guide structure** (the load-bearing contract this ADR freezes):
  1. **Title + role one-liner** and a **"Who this is for / What you'll see"** block - the role's landing
     surface and default rails, taken verbatim-in-spirit from ADR-0088's foregrounding map.
  2. **Getting started** - the onboarding recap (role picker -> email -> tour; switch in Settings ->
     Profile; replay the tour from About), scoped to that role.
  3. **Capability walkthroughs** - the role's foregrounded capabilities, each a numbered **step-by-step**
     with two mandatory ingredients:
     - a **screenshot placeholder**: `![alt text](images/<name>.png)` immediately followed by an italic
       *Figure N -* caption that explains **what the image shows and what to capture** (so the placeholder
       is self-documenting before the PNG exists);
     - one or more **Tips** as GitHub callouts (`> [!TIP]`) for design considerations, shortcuts, and
       gotchas. Risk/safety asides use `> [!NOTE]` / `> [!WARNING]`.
  4. **Notes and References** - a numbered list mixing (a) **LUCID public-repo documentation** the user
     should read next (specific `README.md` sections, ADRs, `CLAUDE.md`/`AGENTS.md`, `CHEATSHEET.md`,
     `PROGRESS.md`) and (b) **external design-pattern / research** sources with short relevance snippets,
     **all in MLA 9 format**. In-text superscript-style references (`[1]`, `[2]`) point back into this list.

- **Scope per role** (mirrors ADR-0088 so the guide foregrounds what the chrome does):
  - *Developer* - chat + composer (model picker, edit modes, thinking), the Memory inspector
    (context / cache / cost), Knowledge/RAG, the read-write gated IDE, `/goal` loop basics, command palette.
  - *Security* - the Security inspector + badge, quarantine/approvals queue, the fail-closed gate &
    scanner, exec-approval + Speed<->Risk dial, egress approval, the OCSF audit-export, Dev-logs.
  - *Manager* - the Cost & Savings ledger + showback, AI-authorship LOC ledger, `/goal` loop success-rate
    & after-action reports, budget kill switch, AskSage gov-usage.
  - *Executive* - the posture + spend summary, the Engineering Update brief + podcast (P-BRIEF),
    governance posture (gov-lockdown / FIPS / CUI-isolated / audit-export-ready).

- **Citations are real or they don't ship.** Every LUCID reference points to a file/section/ADR that
  exists in this repo at authoring time; external citations are to real, locatable works. A reference whose
  target cannot be verified is dropped, not faked (fail-closed applied to prose).

### Phasing

- **P-DOC.1** *(this increment)* - the structure + a first-pass of all four guides + the index, wired into
  the README "Project docs" table. Screenshots are documented placeholders.
- **P-DOC.2** *(later)* - capture and commit the real PNGs against each placeholder caption; add a
  link-check to CI so a renamed ADR/section can't silently rot a guide reference.
- **P-DOC.3** *(later)* - a "generate/refresh guides" maintenance pass keyed off new ADRs, and optional
  in-app deep-links (a role guide opens from the About panel next to "Take the tour").

### Consequences

- Each role gets a durable, linkable reference in its own language, consistent across the four because the
  structure is fixed - and a new role is a new file, not a redesign.
- Docs-only and additive: no schema change, no migration, no prompt-prefix byte, no enforcement path
  touched. The guides can never weaken the gate; they only explain it.
- The screenshot-placeholder convention lets the prose ship now and the images land later without churning
  the guide structure (the caption is the spec for the capture).
- Risk: a guide reference (ADR number, README anchor) can rot when the repo moves. Mitigated now by
  verifying every cited target exists at authoring time, and deferred-hardened by the P-DOC.2 CI link-check.
- Cost: the guides duplicate some README capability prose by design (role-scoped, step-by-step) - accepted;
  the README is a feature tour, the guides are task walkthroughs.

### Invariants preserved

Docs-only + additive. #3 fail-closed untouched (the guides describe the gate, never gate anything),
#5/#7 untrusted-delimiting + closed trust-label set untouched, #6 frozen prefix untouched (no prompt bytes),
#8 event emission unaffected, #10 DuckDB schema untouched. Markdown docs carry no SPDX header per the
existing `docs/*.md` convention (ADR-0086 scopes the header to source trees only).

### Relates to

ADR-0088 (role onboarding - the foregrounding map each guide mirrors), ADR-0089 (the coachmark tour - the
guides are its durable, re-readable counterpart), ADR-0087 (About panel - future deep-link target, P-DOC.3),
ADR-0086 (BUSL licensing + the source-only header scope), `README.md` (the capability tour the guides
task-scope per role), `CLAUDE.md`/`AGENTS.md` (invariants the Security guide cites), `CHEATSHEET.md`
(commands the Developer guide cites), new `docs/guides/` (the four guides + index this ADR defines).

## ADR-0093 - P-TOOLFAIL.1: An honest chip for a failed/rejected tool call (distinguish failure from denial, surface omp's reason)

**Date:** 2026-06-29
**Status:** Accepted - shipped.
**Increment:** P-TOOLFAIL.1.

### Context

A live turn (build a Minesweeper game) ended with two grey "tool call rejected" chips - a browser-open
("Opening game in browser") and a JS syntax-check ("execute [js]") - and no approval prompt. The user (and
the agent, which narrated "both tool calls were denied") read this as a security/permission DENIAL. It was
not. Investigation of `~/.omp/lucid-audit.jsonl` showed NO `exec_decision`/`egress_decision` block for that
turn, and every gate block path calls `emitSecurityEvent` (which appends there). So the gate never ran:
omp could not run those two tools (no browser-open / JS-execute capability in the session) and returned
the calls as `failed`/`rejected` BEFORE any permission request reached the gate.

The defect is in the messaging. omp's `tool_call_update` fires one generic signal for two very different
outcomes - a tool that RAN and errored (`status: "failed"`) and a tool that DID NOT run (`status:
"rejected"`: refused, unavailable, or cancelled) - and the desktop flattened both, verbatim, to the single
string `"tool call rejected"` (`acp_backend.ts`), discarding omp's own status and message. "Rejected" reads
as "denied"; the chip implied a decision was made when none was, and gave neither the user nor the agent
anything to act on.

This sits next to two related gaps the same investigation surfaced, each its own future increment: the
egress classifier would gate a LOCAL-file browser preview as internet egress purely because the tool name
contains "browser" (P-EGRESS.2, future), and the egress no-live-listener block at `acp_backend.ts` returns
`cancelled` with NO `emitSecurityEvent`, so a silent egress block leaves no audit trail (P-ENT.3, future).
The AI-LOC ledger discoverability fix (it renders only as a buried, conditionally-shown Memory accordion)
is also queued separately (P-LOC.3, future).

### Decision

Replace the hardcoded `"tool call rejected"` with omp's actual outcome, via a PURE, over-tested helper
`desktop/tool_failure.ts` so the chip explains itself and is never mistaken for a security denial.

- **`toolFailureReason(u)` → `{ didRun, reason }`** (pure; no I/O). `status === "failed"` ⇒ `didRun: true`
  ("tool failed"); anything else (`"rejected"`) ⇒ `didRun: false` ("tool did not run"). The fallback wording
  deliberately AVOIDS "rejected"/"denied" so an unavailable tool is not read as a gate block.
- **`toolFailureMessage(u)`** pulls omp's message wherever omp puts it - a `content[]` array (direct `text`
  or nested `content.text`), a `rawOutput` string or `{ error }`, or a top-level `message`/`error`/`reason`
  - normalized (collapsed whitespace) and capped at 160 chars. When present it is folded into the chip
  ("tool failed: syntax error at line 3" / "tool did not run: no such tool: execute").
- **The chip stays NEUTRAL.** This path emits `block` with `quarantined: false`; a real security quarantine
  is the gate's own stderr signal (unchanged). The renderer tooltip now reads "Tool call was not completed
  (failed or refused) - not a security block", making the not-a-quarantine distinction explicit.

No frozen-contract bytes change: the `block` `ChatEvent` already carried a `reason` field (we were
wasting it), the prompt prefix, scanner IPC, DuckDB schema, and `contracts.ts`/`result_adapter.ts` are
untouched.

### Consequences

A failed/unavailable tool now says WHY, and a denial is visibly distinct from a failure - the exact
ambiguity that made this turn unreadable. Limitation: when omp attaches no message to a `rejected` update
(as in the originating case), the chip is the bare "tool did not run" - honest, but it still cannot name
"the tool isn't enabled" vs "omp refused it" because omp itself does not tell us. Surfacing that would need
an omp-side change (out of scope; extend-don't-fork). The two egress gaps and the AI-LOC discoverability
fix remain queued as their own increments.

### Relates to

`acp_backend.ts` (the `tool_call_update` emit site + the egress no-listener block noted for P-ENT.3),
`desktop/renderer/app.ts` (`onBlock` neutral chip + tooltip), new `desktop/tool_failure.ts` +
`desktop/tool_failure.test.ts`, new `desktop/scripts/demo_p_toolfail_1.ts`, ADR-0062 (egress gate -
P-EGRESS.2 local-file follow-up), ADR-0066/0067 (exec gate - the other "blocked" path), ADR-0069 (the OCSF
audit feed whose absence proved the gate never ran), ADR-0031 (the AI-LOC ledger - P-LOC.3 discoverability).

## ADR-0094 - P-EGRESS.2: A local-file browser open is labeled (and audited) as a local file, not a website — plus audit the no-listener egress block (P-ENT.3)

**Date:** 2026-06-29
**Status:** Accepted - shipped.
**Increment:** P-EGRESS.2 (folds in P-ENT.3).

> Numbering: ADR-0093 (P-TOOLFAIL.1) lands in a sibling PR; this ADR is 0094 so the two never collide.
> They append to DECISIONS.md independently and are merged in order.

### Context

The same investigation that produced ADR-0093 (the "tool call rejected" mislabel) surfaced two real edge
cases in the egress gate (ADR-0062), in `acp_backend.ts`:

1. **A local-file browser open was treated identically to a website visit.** `isEgress` matches any tool
   whose name contains "browser", so "Opening game in browser" pointed at a local path
   (`C:\…\hormuz-minesweeper.html`) was routed to the per-WEBSITE dialog — "The agent wants to visit a
   website", a Cloudflare-Radar check on a file path (nonsense), and a "Always allow this site" pin that
   would persist a junk host key for a path. Opening a local file is not, strictly, the agent reaching the
   internet — but a rendered local HTML page CAN load remote resources, so the right answer is not "stop
   gating it" (that weakens the gate) but "label it accurately and keep prompting".
2. **The no-live-listener egress block was silent.** When there was no UI to ask, the egress path returned
   `cancelled` with NO `emitSecurityEvent` — the one gate path that left no audit trail (every exec block
   and every answered egress decision emits one). A fail-closed block that no one can see is a gap.

### Decision

- **Local-file detection (pure, tested).** New `isLocalFileTarget(target)` in `egress_policy.ts`:
  `file://` or a clearly-absolute local path (Windows drive / UNC / POSIX / `~`) ⇒ local; any other scheme
  (http(s), ftp, …), a bare host, or a relative/ambiguous string ⇒ NOT local (so it falls through to the
  normal egress prompt — fail-safe).
- **Accurate local-file approval (still a PROMPT).** A recognized local file is routed to
  `askEgress(localFile=true)`: it SKIPS the host-based `egressDecision` auto-allow (a path has no host),
  shows a distinct dialog ("open a local file in your browser", with the path and a "can still load remote
  resources" warning, no Radar), offers only **open-once / block** (`EGRESS_LOCAL_OPTIONS`), and persists
  NO host decision. The gate is preserved — a local-file open is never silently auto-approved, even in
  Agent mode. http(s) egress is completely unchanged.
- **Audit the no-listener block (P-ENT.3).** The no-UI egress block now emits an `egress_decision` /
  `decision: block` SecurityEvent (`tool: "egress"` or `"egress-local-file"`), so a fail-closed block is
  always traceable in the OCSF feed (ADR-0069).

`bridge.ts`'s `permission` `ChatEvent` gains an optional `localFile?: boolean` (renderer-side type, not a
frozen contract). No frozen-contract bytes change: the prompt prefix, scanner IPC, DuckDB schema, and
`contracts.ts`/`result_adapter.ts` are untouched; the in-process gate's blocking behavior is unchanged
(this only relabels a prompt and adds an audit emit).

### Consequences

A "preview the file I just made" no longer masquerades as a website visit, and a silent egress block is
now auditable. The gate is not weakened — local-file opens still require explicit approval. Limitation:
detection is conservative and path-shaped; a browser tool that passes a local file as a relative path (no
scheme, no leading slash) is treated as ambiguous and gets the website-style prompt rather than the
local-file one — acceptable (it still PROMPTS), and widening it risks misclassifying real bare-host targets.

### Relates to

`acp_backend.ts` (the egress decision block + `askEgress` + the audited no-listener block + the
`EGRESS_LOCAL_OPTIONS` set), `desktop/egress_policy.ts` (`isLocalFileTarget`) + `egress_policy.test.ts`,
`desktop/renderer/app.ts` (the local-file permission card + confirmation toast), `desktop/renderer/bridge.ts`
(`localFile?` on the permission event), new `desktop/scripts/demo_p_egress_2.ts`, ADR-0062 (the egress gate
this refines), ADR-0069 (the OCSF audit feed P-ENT.3 completes), ADR-0093 (the sibling chip fix from the
same investigation).

## ADR-0095 - P-LOC.3: The AI-authored code ledger is discoverable and never silently vanishes

**Date:** 2026-06-29
**Status:** Accepted - shipped.
**Increment:** P-LOC.3.

### Context

Third fix from the same session's investigation. The AI-authored code ledger (P-LOC.2, ADR-0031) is real
and persisted — a frozen DuckDB table `ai_loc_ledger`, written at the gate on every AI edit that passes,
read back by `aiLocSummary()` — but a user reported "where did the AI-LOC go? I don't see it anymore in any
menu." Two UI reasons, both confirmed:

1. **No entry point.** The ledger renders only as an accordion (`mem.ailoc`) inside the Memory panel, below
   the cost ledger. There is no rail glyph, no command-palette entry, no tab — you have to already know it
   is there and scroll to it.
2. **It silently vanishes when empty.** The section was gated `if (d?.aiLoc)`. `aiLocSummary()` returns
   `null` when the obs DB is missing/unreadable or has zero rows, so the WHOLE section disappeared with no
   placeholder — indistinguishable from "the feature was removed."

(The data itself was never at risk; this is purely surfacing.)

### Decision

- **Always render the section while a session is active, with an explicit empty state.** `memoryHtml`
  now renders `mem.ailoc` inside `if (d) { … }` and branches on a pure helper: data card when there is at
  least one recorded edit, else "No AI-authored lines recorded yet — they'll appear here … as the agent
  edits files through the gate." The section is therefore present in both states; it never just disappears.
- **A pure, tested visibility rule.** New `desktop/ailoc_view.ts` `aiLocHasData(aiLoc)` (null-safe; true iff
  `totals.edits > 0`) encodes the data-vs-empty decision out of the DOM-bound renderer, mirroring the
  `tool_failure.ts` pattern (ADR-0093) so the "never vanish" intent is locked by a unit test.
- **A command-palette entry point.** A new action — "Open AI-authored code ledger" — opens the Memory panel
  with the `mem.ailoc` accordion expanded (`OPEN.add("mem.ailoc"); focusInspector("memory")`), the same
  reveal idiom the Security panel uses for a live block. The ledger is now reachable without hunting.

No frozen-contract bytes change: storage (`ai_loc_ledger`, migration 0007), the prompt prefix, scanner IPC,
and `contracts.ts`/`result_adapter.ts` are untouched. This is presentation only.

### Consequences

The Manager-role headline metric (ADR-0088 foregrounds it; the manager guide leads with it) is now both
discoverable and self-explaining when empty. Limitation: it is still surfaced inside the Memory panel
rather than a dedicated dashboard — a fuller Manager/Exec aggregate view remains P-ROLE.4. The empty-state
copy assumes the gate-write path (ADR-0031); if that ever regresses, the section would read "none yet"
rather than erroring — acceptable (fail-quiet for a read-only dashboard), and the gate's own tests guard
the write path.

### Relates to

`desktop/renderer/app.ts` (the always-on section + empty state + the palette action), new
`desktop/ailoc_view.ts` + `desktop/ailoc_view.test.ts`, new `desktop/scripts/demo_p_loc_3.ts`, ADR-0031
(P-LOC.1/.2 — the ledger this surfaces), ADR-0088 (role foregrounding — Manager leads with this metric),
ADR-0093 (the sibling pure-helper pattern), the P-DOC.1 manager guide (which documents the ledger).

## ADR-0096 - P-PREVIEW.1-3: An in-app browser preview the agent can drive and screenshot (resizable fly-out)

**Date:** 2026-06-29
**Status:** Accepted - SCOPE/PLAN + P-PREVIEW.1 shipped (panel + local-file preview + screenshot-to-chat).
**Increment:** P-PREVIEW.1 (this); P-PREVIEW.2/.3 phased below.

### Context

LUCID writes web apps but cannot *run* them: the minesweeper turn (ADR-0093) wrote a self-contained HTML
game, tried to "open in browser", and dead-ended because no such capability exists — the agent (and the
user) had no way to see whether the UI actually worked. The product can author code but not close the
build→see→fix loop. A reviewer's natural ask: let the agent preview and screenshot the app it just built,
shown in a panel the user can watch — like the Knowledge Graph fly-out, resizable on the right.

The pieces already exist: LUCID is an **Electron** shell (so a page can be rendered in-app and the window
captured to a PNG), the **Knowledge Graph** panel is a resizable right-edge `<aside>` with a drag handle
and mutual-exclusion with the other right surfaces (the exact UX to clone), tool results already flow back
as `ToolResult`, and the **egress gate** (ADR-0062 / ADR-0094) already governs reaching out — a rendered
local page that fetches remote resources is exactly an egress concern.

### Decision

Add a **Preview** fly-out panel and (phased) the agent tools to drive it. Extend-don't-fork throughout: a
renderer panel + a thin Electron capture seam in the existing preload + (later) omp custom tools.

**P-PREVIEW.1 (this increment) — the panel + user-driven local preview + screenshot-to-chat:**
- A new right-edge `<aside id="preview">` cloned from the KG panel: a `data-resize="preview"` left-edge
  drag handle, persisted width, a rail glyph, and mutual exclusion with the inspector / KG / IDE / settings
  (reusing the existing `closeKnowledge`/`closeIde`/`closeSettings` idiom). A path/URL bar + Open + Reload.
- The page renders in a **sandboxed `<iframe sandbox="allow-scripts allow-forms">`** (works in both the
  Electron app and the dev-server browser; no `webviewTag` attack surface added). Local targets resolve to
  `file://`; the resolver is pure and shared.
- A pure `desktop/preview_resolve.ts` `resolvePreview(target)` → `{ kind: "local" | "remote" | "blocked",
  src, label }`, reusing `isLocalFileTarget` (ADR-0094). Remote (`http(s)`) is recognized but, in this
  increment, **not auto-loaded** — it is surfaced as `remote` and gated in P-PREVIEW.3; junk/empty ⇒
  `blocked`. Fail-safe: anything not clearly local is not silently rendered.
- **Screenshot-to-chat**: a button captures the panel via the existing window's `webContents.capturePage(rect)`
  (cropped to the iframe's bounding rect) through a new `lucid.capturePreview(rect)` preload→IPC seam, and
  drops the PNG into the composer as an attachment for the agent to react to. Electron-only; in the
  dev-server browser the button is disabled with a tooltip (no `capturePage` outside Electron).

**P-PREVIEW.2 (next) — the agent drives it.** Gated omp **custom tools** so the agent itself can
`preview_open(path)`, `preview_screenshot()` (returns the PNG as a `ToolResult` image so the agent *sees*
its own UI), `preview_snapshot()` (the DOM/a11y tree as text — cheap "does the element exist / what does it
say"), and `preview_click/fill/console`. The user watches the agent drive the panel live. Each tool call
is surfaced like any other (and the screenshot inline in chat).

**P-PREVIEW.3 (later) — remote + hardening.** Egress-gated remote URLs (a page load and any fetch it makes
route through ADR-0062/0094, or are blocked in a strict profile), a managed **preview profile**
(off / local-only / gated-remote) under ADR-0068, and sandbox hardening (CSP, partition isolation).

### Security

The preview renders **untrusted, agent-authored code**, so it is sandboxed (`<iframe sandbox>`, no
`allow-same-origin` for remote, no node access — the main window stays `contextIsolation: true,
nodeIntegration: false`). A local file open reuses the P-EGRESS.2 prompt/audit; remote loads are deferred
to the egress-gated P-PREVIEW.3 rather than shipped open. Screenshots are metadata-safe (they show only
what the user already sees on screen). Fail-closed: the resolver never renders an ambiguous target, and the
capture seam is absent (button disabled) outside Electron.

### Verification boundary (honest)

The pure resolver + the panel DOM are verified here (unit tests + a dev-server DOM snapshot). The Electron
**`capturePage` path cannot run in this sandbox** (no Electron/display), so it is implemented behind the
preload seam and verified live in the packaged app — called out in the PR, not claimed as tested.

### Relates to

`desktop/renderer/app.ts` (the panel + rail + resizer + screenshot button), `desktop/preload.ts` +
`desktop/main.ts` (`capturePreview` IPC), `desktop/renderer/bridge.ts` (the `capturePreview` seam), new
`desktop/preview_resolve.ts` + `desktop/preview_resolve.test.ts` + `desktop/scripts/demo_p_preview_1.ts`,
ADR-0062/0094 (egress gate the resolver + P-PREVIEW.3 build on), ADR-0093 (the minesweeper turn that
motivated this), the Knowledge-graph fly-out (the UX pattern cloned).

### Addendum (2026-06-30) — P-PREVIEW.2 re-scoped to "auto-on-write"; the custom-tool version moves later

Building P-PREVIEW.2 surfaced a feasibility constraint. The originally-planned version — the agent itself
calling `preview_open`/`preview_screenshot` custom tools and receiving its own screenshot as a multimodal
`ToolResult` — requires (a) a custom agent-tool registered through omp's `pi` plugin interface, which LUCID
does **not do anywhere today** (every extension uses only `pi.on(...)` hooks + `pi.registerProvider(...)`;
omp is a CLI, `@oh-my-pi/pi-agent-core`, and its custom-tool factory shape is unconfirmed — CLAUDE.md lists
confirming it as an open task), and (b) a cross-process round-trip (omp tool → desktop → renderer
`capturePage` → back to the tool) that **cannot be verified without live omp + Electron** (absent in CI/this
environment). Shipping that blind would put unverified code on the agent-tool surface of a security product.

So **P-PREVIEW.2 ships as the verifiable, equally-faithful "auto-on-write"**: LUCID already sees the agent's
`tool_call` stream, so when a write/edit produces a browser-previewable file (`.html`/`.svg`), a pure
`previewablePath()` detects it and the backend emits a `preview-available` event; the renderer auto-surfaces
it (renders live if the panel is open, else a one-click "Open preview" toast), and the panel defaults to the
agent's most recent previewable write. The user watches what the agent builds appear — desktop+renderer only,
unit-tested + DOM-verifiable, no omp custom tool. The surfaced path still flows through the fail-safe resolver
(local-only) before anything renders.

**Re-phasing:** the true agent-*invoked* preview (custom omp tools + screenshot-as-multimodal-ToolResult,
so the model sees and self-corrects on its own UI) becomes **P-PREVIEW.3a**, to be built where omp+Electron
can verify it, gated on confirming omp's custom-tool API. Egress-gated remote URLs + sandbox hardening +
managed preview profile remain **P-PREVIEW.3b**. New: `previewablePath()` in `preview_resolve.ts` (+ tests),
the `preview-available` `ChatEvent` (acp_backend + bridge), `onPreviewAvailable` in the renderer,
`desktop/scripts/demo_p_preview_2.ts`.

### Addendum (2026-06-30) — P-PREVIEW.3 sandbox hardening shipped; 3a feasibility CONFIRMED, deferred to a live env

**P-PREVIEW.3 (shipped):** hardened the sandbox the preview `<iframe>` runs untrusted, agent-authored code
in. A single source of truth (`PREVIEW_SANDBOX` / `PREVIEW_ALLOW` / `PREVIEW_SANDBOX_FORBIDDEN` in
`preview_resolve.ts`, used by the markup) keeps the policy and its security tests from drifting:
`sandbox="allow-scripts allow-forms"` (scripts run, but **opaque-origin** — no `allow-same-origin`, so the
page can't read LUCID's origin/cookies/localStorage), `allow=""` (Permissions-Policy denies camera, mic,
geolocation, and every other powerful feature), and a forbidden-token test that fails if `allow-same-origin`
/ `allow-top-navigation` / `allow-popups` / `allow-modals` / `allow-pointer-lock` / `allow-downloads` ever
creep in. 3 sandbox tests + `make demo-P-PREVIEW.3`.

**P-PREVIEW.3a feasibility — CONFIRMED (the open question is resolved).** omp's `pi` plugin interface **does**
expose `pi.registerTool({ name, parameters, execute })` ("Register tools the LLM can call" — omp CHANGELOG;
the built-in autoresearch extension uses `f.registerTool(...)` + `f.setActiveTools(...)`), and
`AgentToolResult.content` accepts `ImageContent` — so `preview_open` AND `preview_screenshot` (the agent
receiving its own screenshot as a multimodal result, then self-correcting) are buildable **without forking
omp** (invariant #1 holds). What blocks shipping it *now*: it requires a **new `-e` extension**, and a faulty
extension can break omp launch — unacceptable to ship into a tagged release **without live omp+Electron
verification** (absent here). So 3a is **ready to build in a live env**, not deferred for feasibility.
Its cross-process screenshot round-trip (omp tool ⇄ desktop `capturePage`) is the one piece still to design.

**Final phasing:** P-PREVIEW.1 (panel), .2 (auto-on-write), .3 (sandbox hardening) — **shipped**.
P-PREVIEW.3a (agent-invoked `preview_open`/`preview_screenshot` via `pi.registerTool`) and P-PREVIEW.3b
(egress-gated remote URLs + managed preview profile) — **ready, pending a live omp+Electron session**.
New here: `PREVIEW_SANDBOX`/`PREVIEW_ALLOW`/`PREVIEW_SANDBOX_FORBIDDEN` (+ tests),
`desktop/scripts/demo_p_preview_3.ts`. Shipped in **v1.8.14** (v1.8.13 skipped).

## ADR-0097 - P-SKILL.4: the Agent Skill directory + management menu (SCOPE/PLAN)

**Date:** 2026-06-28
**Status:** Accepted - SCOPE/PLAN. Designed here; build is its own increment. Renderer + desktop-server
only; no `contracts.ts`, scanner, prompt-prefix, or schema change. This is the local foundation the
enterprise skills registry (ADR-0098) plugs into.
**Increment:** P-SKILL.4. Unifies the EXISTING skill surfaces (ADR-0029 bundled corpus, ADR-0045
scan-gated import, omp's `discoverSkills`, the `.agents/skills/` curated tree) under one directory + a
management menu. Invents no new trust mechanism.

### Context

Skills already enter the app through four doors, but there is no single place to SEE and GOVERN them:

- **Bundled corpus** - `desktop/renderer/skills.ts` `INSTALLED_SKILLS`: airgap-clean, TRUSTED frozen
  guidance delivered in the user turn (ADR-0029). Immutable, reviewed assets.
- **omp-discovered** - `desktop/skills_data.ts` `listSkills()` wraps omp's `discoverSkills(workspace)`
  over project (`.omp/skills`), user (`~/.omp/agent/skills`), and plugin roots; invoked `/skill:<name>`.
- **Scan-gated import** - ADR-0045 / P-SKILL.1: a dropped `.md` is scanned fail-closed and, if clean,
  written to `<workspace>/.omp/skills/<slug>/SKILL.md`; suspicious/quarantined is recorded as a block.
- **Curated `.agents/skills/`** - operator-curated, vendor-trusted, with `SOURCES.md` as the provenance
  manifest (every entry's origin + trust).

The ADR-0029 picker shows bundled + project skills "under one roof" *for invocation*, but it is not a
management surface: you cannot see a skill's **source root** or **trust label** side by side, inspect its
body + bundled resources, enable/disable it, remove an imported one, re-scan it, or check it against the
whitepaper's deployment-readiness bar. With the registry add-on coming (ADR-0098), the app needs a real
directory the registry can register as just another source.

### Decision - one Skill Directory view + a per-skill management menu

A **Skills** view in the desktop app that ENUMERATES every skill from every root and exposes governance:

**Directory (the catalog).** One list, grouped by source, each row carrying:
- `name` (kebab-case), one-line `description` (the routing/trigger text), invocation id `/skill:<name>`.
- **Source root**: `bundled | project (.omp/skills) | user (~/.omp/agent/skills) | agents (.agents/skills) |
  plugin | registry` (the last reserved for ADR-0098).
- **Trust label** from the closed set (`trusted | untrusted | suspicious | quarantined`, invariant #7):
  bundled + `.agents` vendor-curated = `trusted` (frozen, reviewed); imported/project/user carry the
  scan verdict from the P-SKILL.1 gate; anything unscanned is shown as `untrusted` until scanned.
- **Progressive-disclosure cost note**: metadata only is always-loaded (~tens of tokens); the SKILL.md
  body + resources load on trigger - surfaced so the user sees the real token model (whitepaper §"Token
  budget: isolation is a trap").

**Per-skill management menu.** Actions, all renderer/desktop-server, all additive:
- **Inspect** - read-only view of the SKILL.md body + a tree of bundled `scripts/`/`references/`/`assets/`,
  with provenance (origin + trust from `.agents/skills/SOURCES.md` where present). Content is rendered as
  DATA inside the trust-boundary delimiters - never executed, never promoted to instructions (invariant #5).
- **Enable / disable** - a per-skill toggle persisted locally (extends the `lucid.skill-usage`
  localStorage pattern in `skills.ts`). A **disabled skill is never offered and never loaded** - the
  bundled-skill delivery path and the `/skill:` resolver both skip it. Default-on for trusted; **default-off
  and non-enableable for `suspicious`/`quarantined`** (fail-closed, invariant #3; keystone-#2 aligned -
  a flagged skill cannot become active guidance).
- **Re-scan** - run the EXISTING fail-closed gate (`scanAndDecide(scanner, text, DEFAULT_POLICY)`, the
  P-SKILL.1 path) over the skill's content on demand; show the verdict + update the trust label; a dead
  scanner = `quarantined` (never "safe").
- **Remove** - project/user/imported skills only (delete the `<slug>/` dir under a `pathWithin`
  confinement check, mirroring the import write). **Bundled + `.agents` are immutable** (read-only).
- **Readiness checklist** - surface the whitepaper's deployment bar per skill (frontmatter validates;
  description has what + when + when-not; security scan clean; no hard-coded secrets/paths). Advisory, not
  blocking; it is the same bar the registry (ADR-0098) will enforce at publish time.

**The registry seam.** ADR-0098's registry is modeled as one more **source root** (`registry`): the
directory enumerates remote skills the same way, and "install" = fetch → verify signature → scan-gate →
write into a local root → it appears as a normal row. The public app ships only this READER seam; the
hosting/runbooks are private add-on IP. This is the same public-seam / private-IP split as managed-config
(ADR-0068) and the SIEM `Sink` (ADR-0069).

### Plumbing (build increment, when scheduled)

- `desktop/skills_data.ts` - widen `SkillInfo` to `{ name, description, source, trust, enabled, root,
  invocation }`; merge bundled (`INSTALLED_SKILLS`) + `discoverSkills` + `.agents/skills` into one list;
  read enable/disable + trust from local state and the recorded scan verdicts.
- `desktop/renderer/skills.ts` - the bundled-skill delivery path and `/skill:` resolver SKIP disabled and
  non-`trusted`-enableable skills.
- New renderer **Skills** view (directory + the per-row menu) + a desktop-server route for inspect /
  re-scan / remove (reusing `importSkill`'s scan + `pathWithin` confinement; `recordBlock` on a flagged
  re-scan so it surfaces in the Security panel).
- Tests - a disabled skill is not delivered/invokable; a `suspicious` skill cannot be enabled; remove is
  confined to project/user roots and refuses bundled/`.agents`; re-scan with a dead scanner ⇒ `quarantined`.
- `make demo-P-SKILL.4`.

### Invariants preserved

Fail-closed (#3): disabled/suspicious/quarantined skills are never loaded; a dead scanner on re-scan =
quarantine. Trust labels are the closed set (#7). Untrusted skill bodies stay delimited DATA, never
instructions, never in the frozen prefix (#5/#6). Extend-don't-fork (#1): omp's `discoverSkills` stays
authoritative for discovery; we add a governance layer around it. No `contracts.ts` change (an
`skill_enabled`/`skill_removed` EventName, if we log governance actions, is a separate contracts increment).
New first-party files carry the BUSL-1.1 header (ADR-0086).

### Relates to

ADR-0029 (P-IDE.2 bundled corpus + the under-one-roof picker), ADR-0045 (P-SKILL.1/2/3 scan-gated import +
builder + session-derived), `desktop/skills_data.ts` / `desktop/renderer/skills.ts`, `.agents/skills/` +
`SOURCES.md`, ADR-0019 (gate + Security-panel block surfacing), ADR-0098 (the enterprise registry that
registers as a `registry` source), and CLAUDE.md invariants #3/#5/#6/#7 + keystone #2.

## ADR-0098 - P-SKILLREG.1: enterprise Agent Skills registry - capability spike (SCOPE/PLAN)

**Date:** 2026-06-28
**Status:** Accepted - SCOPE/PLAN (capability spike). This ADR records the cross-provider research and the
build-vs-adopt decision. The public repo ships only the **registry-reader seam** (ADR-0097's `registry`
source). The registry server, the per-provider Terraform runbooks, and their development ADRs are
**private add-on IP** (`mlcyclops/lucidagentIDEaddon`): ADR-A012 (reference architecture + distribution
model) and ADR-A013 (per-provider Terraform runbook framework + IL5). Same public-seam / private-IP split
as ADR-0068 (managed-config) and ADR-0069 (SIEM `Sink`).
**Increment:** P-SKILLREG.1. Builds on ADR-0097 (the local skill directory the registry plugs into) and
ADR-0045 (the fail-closed scan-gate every installed skill must clear).

### Context

Agent Skills (the agentskills.io open standard: a `SKILL.md` folder + optional `scripts/`/`references/`/
`assets/`, progressive disclosure) are becoming the portable unit of agent capability; public marketplaces
crossed ~40,000 listings by early 2026. Enterprises need to **publish, version, govern, sign, scan, and
distribute** skills privately - across the cloud they run AND on-prem/airgapped/IL5 - not pull from public
GitHub. The question this spike answers: **does a first-party skills registry already exist for each target
substrate, and where it doesn't, what do we build?**

Targets: AWS, Microsoft Azure, Google Cloud, Oracle Cloud Infrastructure (OCI), VMware vSphere/vCenter,
Nutanix Prism (AHV HCI), NetApp ONTAP, KVM/libvirt, IBM Cloud - plus the **separate-API IL5 government
partitions** for the providers that have them.

### Research findings (mid-2026; "if a registry exists yet, and if there are plans")

A first-party SKILL.md-aware registry now exists at the three hyperscalers, **all in preview, none GA, and
none with a Terraform resource for the registry itself** - Terraform covers only the surrounding artifact/
storage primitives. OCI, IBM Cloud, and every on-prem/HCI platform have **no** first-party skills registry.

| Substrate | First-party SKILL.md registry? | Maturity | TF for the registry itself | Best primitive to build/host on |
|:--|:--|:--|:--|:--|
| **AWS** (commercial) | **Partial** - Agent Registry in Bedrock AgentCore; SKILL.md-aware but stores **metadata only**, not the folder | Preview (Apr 2026) | **No** (FR #48381) | CodeArtifact generic packages (folders) · ECR/OCI · S3 |
| **Azure** (commercial) | **Yes** - Microsoft Foundry Agent Service "Skills" API (versioned, project-scoped, MCP-discoverable); Copilot Studio also consumes SKILL.md | Preview (Build 2026) | **No** (azapi/REST only) | ACR + ORAS (signed OCI artifacts) · Azure Artifacts Universal Packages · Blob |
| **Google Cloud** (commercial) | **Yes** - Skill Registry in Gemini Enterprise Agent Platform (governed, ADK-consumed) | Preview (I/O 2026) | **No** | Artifact Registry generic/OCI repos (IAM-governed) · GCS |
| **Oracle OCI** | **No** (GenAI Agents uses RAG/SQL/function/API tools + Knowledge Bases, not a skill catalog) | - | n/a | OCI Artifact Registry (`oci_artifacts_repository`) · Container Registry · Object Storage |
| **IBM Cloud** | **No** - watsonx Orchestrate "skills" are an older app-connector/RPA concept, NOT SKILL.md; ADK builder specs are authoring aids | - | n/a | IBM Cloud Container Registry (OCI artifacts) · Cloud Object Storage |
| **VMware vSphere/vCenter** | **No** (hypervisor platform) | - | n/a | Self-host Harbor/Zot on a VM; MinIO for S3 (no native object store) |
| **Nutanix Prism (AHV)** | **No** (HCI platform) | - | n/a | Self-host VM + **Nutanix Objects** (S3-compatible; `nutanix_object_store_v2`) - best all-in-one TF story |
| **NetApp ONTAP** | **No** (storage platform; runs no compute) | - | n/a | Registry compute elsewhere; **ONTAP S3** (`netapp-ontap_s3_bucket`) or StorageGRID as the artifact backend |
| **KVM/libvirt** | **No** (virtualization layer) | - | n/a | Self-host Harbor/Zot on a `libvirt_domain`; MinIO/Ceph-RGW for S3 (or Harvester HCI) |
| **IL5 partitions (all)** | **No** accredited skills registry | - | separate partitions | **Always self-host** the OCI+S3 registry inside the partition |

**Plans / direction.** AWS/Azure/Google have all publicly committed to expanding these registries (Google
stated Skill Registry will fold into a broader Agent Registry "shortly"); but as of this spike none is GA,
none is Terraform-manageable, AWS stores metadata only, and none is accredited for IL5. OCI, IBM, and the
on-prem platforms show **no plans** for a SKILL.md registry - expected, as those are infra/storage/agent-
tool platforms, not skill-distribution platforms.

### Decision

**1. The portable unit is skills-as-OCI-artifacts on an S3-compatible backend.** Every skill is packaged as
a signed (Cosign), versioned **OCI artifact** in an OCI-distribution registry (Harbor or Zot self-hosted;
or the cloud's native OCI repo - ECR / ACR / Artifact Registry / OCI Container Registry / ICR), with the
skill tarball + provenance (SLSA) backed by S3-compatible object storage. This is the one pattern that
works **identically** on every substrate above, GA today everywhere, and Terraform-able everywhere - unlike
the preview first-party registries. It matches the emerging community "Agent Skills as OCI artifacts"
convention.

**2. Build the portable registry everywhere; integrate the first-party registries only as optional sync in
commercial regions.** Because no first-party registry is GA, Terraform-manageable, or IL5-accredited, and
AWS's is metadata-only, we do **not** depend on them as the system of record. The Terraform runbooks stand
up the OCI+S3 registry on each substrate; where a first-party preview registry exists (AWS/Azure/GCP
commercial), an **optional** connector publishes/syncs metadata into it for native discovery. **In IL5 we
self-host, period** - the preview registries aren't accredited and IL5 uses separate API partitions.

**3. The public app is a read-only registry consumer.** Per ADR-0097, a registry is one more `registry`
source root: the app fetches a skill, **verifies its signature, runs it through the same fail-closed scan
gate, and only then installs it** into a local skill root. The public, source-available repo ships ONLY
this reader seam (signature verify + scan-gate + install). The registry server config and the runbooks are
private add-on IP. Fail-closed throughout: an unsigned, signature-mismatched, or scan-flagged skill is
**blocked**, never installed (invariant #3; keystone #2 - a registry skill never auto-promotes to trusted).

**4. IL5 is a first-class, separate-partition target.** The "separate APIs for IL5 regions" are real and
each runbook must handle them as a distinct Terraform provider configuration:
- **AWS** - partition `aws-us-gov` (`us-gov-west-1/east-1`); `arn:aws-us-gov:...`; FIPS endpoints; separate
  tenancy/IAM; gov Marketplace. Use the `aws_partition` data source - never hardcode `aws`.
- **Azure** - `environment = "usgovernment"`; `.us` endpoints (`management.usgovcloudapi.net`,
  `*.core.usgovcloudapi.net`, `login.microsoftonline.us`); separate Entra tenant; Azure Government Secret = IL6.
- **Oracle** - `oraclegovcloud.com`, realms **OC2** (US Defense / DoD, IL5/IL6) and **OC3** (US Gov,
  FedRAMP High); FIPS-compatible provider + realm-specific endpoint templates; no cross-realm subscription.
- **Google** - **same `googleapis.com` endpoints**, scoped by an **Assured Workloads** folder with the IL5
  control package (US regions, US-person support); guardrails are org-policy, not a separate partition.
- **IBM** - FedRAMP High (IC4G) confirmed; **DoD IL5 currency is weak/historical** and IBM's newest gov AI
  (watsonx) actually runs on **AWS GovCloud** - verify against the live DISA catalog before committing IL5
  to IC4G.

### Private add-on deliverables (the "build our own runbooks" path)

In `mlcyclops/lucidagentIDEaddon` (not this public repo):
- **ADR-A012** - Enterprise Skills Registry reference architecture + the skills-as-OCI-artifacts distribution
  model (Harbor/Zot, Cosign signing, SLSA provenance, the scan-gate-on-install contract the public reader honors).
- **ADR-A013** - the per-provider Terraform runbook framework: a shared `skills-registry` module (registry
  VM/cluster + OCI repo + S3 bucket + IAM/policy) instantiated per provider, plus the IL5 partition matrix
  (separate provider configs above). Notes the substrate gotchas: VMware provider moved to `vmware/vsphere`
  (Broadcom); Nutanix `nutanix_object_store_v2` is the strongest single-platform story; ONTAP runs no
  compute (pair with a hypervisor); StorageGRID's community TF provider is at-risk; libvirt/Harvester need
  MinIO/Ceph for S3.
- **`terraform/<provider>/`** skeleton runbooks (provider block + key resources stubbed + variables +
  README) for: aws, azure, gcp, oci, vmware-vsphere, nutanix, netapp-ontap, kvm-libvirt, ibmcloud, and an
  `il5/` overlay - enough to begin real development; not apply-ready (no creds to `terraform validate` here).

### Public-repo deliverables (this increment)

- This ADR (the spike + research of record).
- The ADR-0097 `registry` source seam (the reader the registry plugs into).
- README "Enterprise Skills Registry (coming soon)" - the public-facing "coming soon" marker.

### Invariants preserved

Fail-closed (#3): unsigned / signature-mismatched / scan-flagged registry skills are blocked, never
installed. Keystone #2: a registry skill is never auto-promoted to trusted guidance - it clears the gate
first. Extend-don't-fork (#1): the registry is an external source the existing directory consumes; omp's
discovery is untouched. Untrusted registry content stays delimited DATA (#5), never in the frozen prefix
(#6). Trust labels are the closed set (#7). Public ships seams only; the IP stays in the private add-on
repo (ADR-0086 licensing model). New first-party files carry the BUSL-1.1 header.

### Relates to

ADR-0097 (the skill directory + `registry` source), ADR-0045 (the scan-gate every install clears), ADR-0029
(bundled-corpus trust model), ADR-0068/0069 (the public-seam / private-IP pattern this mirrors), the private
ADR-A012/A013 (the architecture + runbooks), and CLAUDE.md invariants #1/#3/#5/#6/#7 + keystone #2.

## ADR-0099 - P-KB.1: the compiled KB (OpenKB-style), a sibling to the vector RAG spine (SCOPE/PLAN)

**Date:** 2026-06-30
**Status:** Accepted - SCOPE/PLAN. Designed here; build is its own increment. TypeScript + DuckDB only
(**no Python** - invariant #2). A NEW subsystem `harness/kb/` that sits ALONGSIDE the vector RAG spine
(ADR-0058 `kb_chunks`); it does not replace it and is not the personal KG (ADR-0010).
**Increment:** P-KB.1. Reuses the scan gate (ADR-0058/gate.ts), the `Db`/migration runner (ADR-0001),
the embedder seam (ADR-0063), and `backend.complete()` (ADR-0046). Models the OpenKB "compiled wiki".

### Context

The existing RAG spine (ADR-0058) is **pure vector RAG**: parse -> chunk -> scan -> embed -> cosine. Nothing
*accumulates* - knowledge is rediscovered per query. The user wants a redesign that mimics **OpenKB**
(github.com/VectifyAI/OpenKB): instead of opaque chunks, an LLM **compiles** documents into a persistent
substrate of **pages** - a *summary page* per source, *concept pages* synthesizing ideas across documents,
and *entity pages* (people/orgs/products) - all joined by **cross-reference wikilinks** and **kept in sync**.
Long documents get a **PageIndex-style hierarchical tree** for vectorless, reasoning-based retrieval. OpenKB
itself is Python (markitdown/pymupdf/PageIndex) writing Markdown files; we must instead build it in
**TypeScript + DuckDB**, reusing existing infra, and make it a **sibling** to the vector KB usable **in
parallel or individually** (ADR-0100 routes between them).

### Decision - a DuckDB-backed compiled-page graph, compiled by the most-used model, gated like everything else

**New `kb_graph.duckdb`** (own migration dir `harness/kb/migrations/`, frozen numbered files `0011_*`):
- `kb_documents` - the source registry: `document_id`, `source_path`, `title`, `sha256`, `classification`
  ('U'|'CUI'), `trust_label`, `status` ('compiled'|'quarantined'|'stale'), `ingested_at`.
- `kb_pages` - the compiled wiki, first-class objects: `page_id`, `kind` ('summary'|'concept'|'entity'|
  'source'), `slug`, `title`, `body_md`, `trust_label`, `classification`, `created_at`, `updated_at`.
- `kb_links` - cross-references (wikilinks): `link_id`, `from_page_id`, `to_page_id`, `relation`
  (default 'related'), `created_at`. (Same shape as the personal KG's `PersonalLink`, deliberately, so the
  ADR-0075 graph renderer can draw it.)
- `kb_page_sources` - provenance/citations: `page_id` -> `document_id` + `ordinal`/quote, soft-ref to
  `content_artifacts` (the citation trail OpenKB keeps).
- `kb_changelog` - append-only "kept in sync" log: what each (re)compilation added/changed/flagged
  (incl. contradiction flags), so the substrate is auditable and re-runs are idempotent-ish.
- `kb_page_embeddings` (optional, hybrid) - reuse the `Embedder` seam to embed page bodies for cosine,
  so retrieval can be structural OR vector OR both (ADR-0100).

**Pipeline (`harness/kb/ingest.ts` + `harness/kb/compiler.ts`):**
1. **Parse** - reuse `ingestPdf`/`unpdf` (ADR-0064) and the chunker only for building the long-doc tree.
2. **Scan-gate, fail-closed** - `scanAndDecide(scanner, rawText, DEFAULT_POLICY)` on the source BEFORE any
   compilation. Blocked -> `kb_documents.status='quarantined'`, `recordBlock`, **never compiled** (#3).
3. **Compile** - `backend.complete(compileSystem, docText, {model: usageLedger().models[0]})` produces/updates
   summary + concept + entity pages + links (the most-used model, like P-SKILL.2/ADR-0046).
4. **Re-scan derived pages** - every model-generated page body is **untrusted structure**: run it back
   through `scanAndDecide` before store. A flagged page is quarantined, never trusted (keystone #2 - derived
   content never auto-promotes). This is the load-bearing rule that separates a *compiled* KB from a poisoned one.
5. **Store + changelog + events** - write pages/links/sources, append `kb_changelog`, emit telemetry.

**Sibling, not replacement.** `kb_chunks` (vector) and `kb_pages` (compiled) are independent stores in
independent DuckDB files; a workspace may use one, the other, or both. The personal KG (encrypted, FIPS,
user facts) is untouched - this is a *document* KB.

### Plumbing (build increment, when scheduled)

- `harness/kb/migrations/0011_kb_graph.sql` (+ later numbered files); `harness/kb/store.ts` (wraps `Db.open`),
  `harness/kb/compiler.ts` (the `backend.complete` compile prompts + page diff/merge), `harness/kb/ingest.ts`
  (parse -> scan -> compile -> re-scan -> store). `make demo-P-KB.1` (real scanner + temp DB: a clean doc
  compiles to >=1 summary/concept/entity page with links; a poisoned doc is quarantined and never compiled;
  a model page that fails the re-scan is quarantined).
- Tests mirror `harness/knowledge/ingest.test.ts` (clean compiles, poison blocked, dead-scanner fail-closed,
  derived-page re-scan blocks).

### Invariants preserved

No Python (#2). Fail-closed (#3): source AND every derived page scanned; dead scanner = quarantine. Keystone
#2: compiled pages never auto-trusted. Trust labels are the closed set (#7). DuckDB schema frozen via numbered
migrations (#10). New EventName values (`kb_document_ingested`, `kb_page_compiled`, `kb_page_quarantined`) are
a **deferred `contracts.ts` increment** (#8) - named here, not added this round. BUSL header on new files.

### Relates to

ADR-0058/0063/0064 (the vector RAG spine + embedder + PDF parse this siblings), ADR-0001 (Db/migrations),
ADR-0046 (`backend.complete` + most-used model), ADR-0010/0075 (personal KG store shape + graph renderer
reused for viz), ADR-0100 (the retrieval router over both stores), and CLAUDE.md #2/#3/#7/#10 + keystone #2.

## ADR-0100 - P-KB.2: hybrid retrieval router (vector | compiled | both) + sync + graph viz (SCOPE/PLAN)

**Date:** 2026-06-30
**Status:** Accepted - SCOPE/PLAN. Designed here; build follows P-KB.1. Pure-TS router + a renderer reuse;
no new trust path, no schema change beyond P-KB.1.
**Increment:** P-KB.2. Sits on top of ADR-0099 (`kb_pages`) and ADR-0058 (`kb_chunks`).

### Context

With two sibling stores (vector `kb_chunks`, compiled `kb_pages`), the user wants them usable **in parallel or
individually**. We need a router that can answer from either or both, plus the "kept in sync" + visualization
generators OpenKB ships.

### Decision

**Retrieval router (`harness/kb/retrieve.ts`).** One entry point `retrieveKnowledge(query, {mode})` where
`mode in {'vector','compiled','hybrid'}` (default `hybrid`):
- `vector` -> existing `KnowledgeStore.retrieve()` cosine (ADR-0058), unchanged.
- `compiled` -> **structural/reasoning retrieval** over `kb_pages`: walk the PageIndex tree + entity/concept
  links to the most relevant pages (vectorless), optionally re-ranked by cosine over `kb_page_embeddings`.
- `hybrid` -> run both, merge + dedupe by source, return a single ranked, **delimited + cited** set wrapped in
  `UNTRUSTED_START/END` (reuse `wrapRetrieved`), each item labelled with its store + citation
  (`page:slug` or `source_path#ordinal`). The model is told which substrate each hit came from.

**Sync (the "kept in sync" generator).** Re-ingesting a changed document re-compiles its pages, appends a
`kb_changelog` entry, relinks cross-references, and **flags contradictions** (a new fact conflicting with an
existing page surfaces in the changelog for review rather than silently overwriting). Idempotent on unchanged
`sha256`.

**Visualization.** Reuse `desktop/renderer/graph.ts` (ADR-0075 zero-dep SVG force layout): concept/entity
pages are nodes, `kb_links` are edges; clicking a node opens the page body (read-only, rendered as DATA).
This is OpenKB's "visualization" generator with zero new dependencies.

### Plumbing (build increment)

- `harness/kb/retrieve.ts` (router + merge/dedupe), `harness/kb/sync.ts` (re-compile diff + contradiction
  flag). Desktop: a Knowledge view toggle (vector | compiled | both) + reuse the graph panel for the page
  graph. `make demo-P-KB.2` (router returns vector-only, compiled-only, and merged-cited results; a
  re-ingest appends a changelog entry and relinks). EventName `kb_retrieved` deferred to the contracts increment.

### Invariants preserved

Untrusted retrieved content stays delimited + post-cache (#5/#6). No new trust values (#7). Router is pure
read; sync writes via the P-KB.1 gated path only. Renderer reuse = no new dep (extend-don't-fork, #1).

### Relates to

ADR-0099 (the compiled store), ADR-0058 (vector retrieval reused), ADR-0075 (graph renderer), ADR-0053
(delimited injection), keystone #2.

## ADR-0101 - P-SKILL.5: Skill Studio - analyze recent work, draft skills (SCOPE/PLAN)

**Date:** 2026-06-30
**Status:** Accepted - SCOPE/PLAN. Designed here; build is its own increment. Concretizes the deferred
P-SKILL.2 (builder) and P-SKILL.3 (session-derived) from ADR-0045 into one user-facing button, and is the
OpenKB "skill distillation" generator applied to the user's OWN work.
**Increment:** P-SKILL.5. Reuses `backend.complete()` (ADR-0046), the work-history sources, and the
`importSkill` scan-gate seam (ADR-0045/P-SKILL.1).

### Context

The user wants a **button** that analyzes their **current day's** or **past week's** work and recommends +
drafts Agent Skills it can codify. All the inputs already exist: sessions + transcripts (`listSessions()` /
`sessionMessages()`, preamble-stripped), AI-authorship (`aiLoc`), the `/goal` loop run-log
(`aggregateRuns()`), and the usage ledger (most-used model). P-SKILL.2/.3 already designed the model-assisted
+ session-derived skill builders behind the same fail-closed gate; this ADR makes them a concrete surface.

### Decision - a "Skill Studio" panel: gather -> analyze -> draft -> gate -> review -> codify

- **Gather (`desktop/skill_studio.ts`, designed).** A window selector (Today | Past 7 days) collects: recent
  sessions + stripped transcripts, AI-LOC by repo/file, loop outcomes + recurring stall signatures, and the
  most-used model. No raw content leaves the host.
- **Analyze.** `backend.complete(analysisSystem, workDigest, {model: usageLedger().models[0]})` returns N
  **candidate skills**, each with a name (kebab-case), a *what + when + when-not* description (the routing
  text), and a draft `SKILL.md` body - "crystallize what the agent just did" (the whitepaper's Path B).
- **Gate + review.** Each draft is **untrusted model output**: run it through the `importSkill` seam
  (`scanAndDecide` fail-closed). Clean -> written to the local skill root `.omp/skills/<slug>/SKILL.md` via
  `pathWithin` confinement and surfaced in the ADR-0097 directory (source `project`/`studio`); flagged ->
  `recordBlock` + held in a review queue. The user **reviews/edits before codifying** (keystone #2; the
  whitepaper's "a reviewed agent-drafted skill can be excellent; an un-reviewed one is worse than none").
- **Publish.** A codified skill can be served locally and (spiked, ADR-0102) pushed to a remote registry.

### Plumbing (build increment)

- `desktop/skill_studio.ts` (gather + digest + parse the model's candidate list), a renderer panel + rail
  button (mirror the Knowledge/graph panel structure in `app.ts`), `POST /api/skill-studio/analyze` +
  `/draft` routes (reuse `importSkill`). `make demo-P-SKILL.5` (a synthetic week of sessions yields >=1
  scanned draft; a poisoned transcript yields a blocked draft). EventName `skill_drafted` deferred to the
  contracts increment.

### Invariants preserved

Fail-closed (#3): drafts scanned before save; dead scanner blocks. Keystone #2: drafts never auto-trusted -
human review gate. Confinement via `pathWithin` (no path escape). Untrusted transcript content stays DATA
(#5). BUSL header on new files.

### Relates to

ADR-0045 (P-SKILL.1/2/3 - the builder/session-derived design this realizes + the import gate), ADR-0046
(`complete` + most-used model), ADR-0097 (the directory the drafts appear in), ADR-0102 (publish), ADR-0099
(shares the "compile with the most-used model, re-scan the output" pattern), keystone #2.

## ADR-0102 - P-SKILLREG.2: skill publish seam - Local Skills Registry + remote-push spike (SCOPE/PLAN)

**Date:** 2026-06-30
**Status:** Accepted - SCOPE/PLAN (capability spike). Public ships ONLY the `RegistryPublisher` seam + a
default **local** publisher; the **remote** publishers (enterprise clouds + git providers) are private
add-on IP (`mlcyclops/lucidagentIDEaddon`): ADR-A014/A015. Same public-seam / private-IP split as ADR-0069
(SIEM `Sink`) and ADR-0098 (the registry reader). README roadmap hint only.
**Increment:** P-SKILLREG.2. The publish counterpart to ADR-0098's read/install reader; consumes ADR-0101's
codified skills.

### Context

ADR-0098 designed the registry **reader** (fetch -> verify signature -> scan-gate -> install). The user now
wants the **writer**: codified skills (from Skill Studio, ADR-0101) served to (1) a **Local Skills Registry**
and (2) **pushed to a remote registry** in enterprise clouds (AWS/Azure/GCP/Oracle/IBM) or **custom git**
(Enterprise GitLab/GitHub/Azure DevOps), implemented in the private add-on but **planned + spiked + hinted**
here. There is no git-push or git-provider-auth code in the repo today, so the remote side is net-new and
correctly belongs behind a seam.

### Decision - one publisher interface; local impl public, remote impls private

- **`RegistryPublisher` interface** (mirrors the SIEM `Sink`): `publish(artifact: SkillArtifact) ->
  Promise<PublishReceipt>` + `name`/`status`. A `SkillArtifact` is the ADR-0098 unit: the signed SKILL.md
  folder (Cosign + SLSA), versioned by digest. Public ships the interface, the `SkillArtifact`/`PublishReceipt`
  schema, a `PublishDispatcher` (fail-safe, never throws into a turn), and a config schema in `managed_config`.
- **Default `LocalRegistryPublisher` (public).** Serves the local skill roots as the **Local Skills Registry**
  (the ADR-0097 `registry` source, OCI-artifact-or-folder per ADR-0098), with local signing optional. This is
  buildable in the public core.
- **Remote publishers (private add-on IP, ADR-A014).** Implement the SAME interface:
  - **Cloud OCI registries:** AWS ECR/CodeArtifact, Azure ACR, GCP Artifact Registry, OCI Container Registry,
    IBM ICR (skills-as-OCI-artifacts per ADR-0098).
  - **Custom git:** Enterprise GitLab, GitHub, Azure DevOps - push the signed SKILL.md folder to a versioned
    path/branch via the provider API (PAT/OAuth/workload identity).
- **Egress + policy.** Every remote publish routes through `egress_policy` (`egressDecision`) and is clamped
  by managed-config (allowed hosts, IL5 partition rules per ADR-0098); a publish is a network-reaching action
  and is gated like any other. IL5: self-hosted/partitioned endpoints only.

### Plumbing (build increment - public part only)

- `desktop/skill_publish.ts`: the `RegistryPublisher` interface + `SkillArtifact`/`PublishReceipt` types +
  `PublishDispatcher` + `LocalRegistryPublisher`; `sinksFor`-style `publishersFor()` reading managed-config.
  `make demo-P-SKILLREG.2` (a codified skill publishes to the local registry and re-appears as an installable
  `registry`-source row; a remote target with no configured publisher is a clean no-op, never a throw).
  EventName `skill_published` deferred to the contracts increment. Remote publishers are NOT in this repo.

### Invariants preserved

Public ships seam + local impl; remote IP stays private (ADR-0086 licensing). Fail-closed (#3): a dead/missing
publisher never throws into a turn (mirrors the `AuditDispatcher`); a published artifact is still
verify-signature -> scan-gate -> install on the READ side (ADR-0098). Egress-gated (#3 spirit). No contract
bytes this round.

### Relates to

ADR-0098 (the reader half + OCI-artifact model), ADR-0097 (the `registry` source row), ADR-0101 (produces the
skills), ADR-0069 (the `Sink`/dispatcher pattern mirrored), ADR-0068/egress_policy (managed + egress gating),
the private ADR-A014/A015 (the remote publishers + runbooks).
### Addendum (2026-06-30) — P-PREVIEW.3b shipped: remote URLs preview only through the egress gate

A remote URL in the preview reaches the internet, so it is gated by the **existing egress allow-list**
(ADR-0062 / ADR-0094, honoring the managed ceiling) rather than a new approval path. Flow: the resolver
classifies an `http(s)` target as `remote`; the renderer asks the backend `/api/preview/egress-check?url=`
(→ `egressDecision(url)`), and a pure `canPreviewRemote(url, egressAllowed)` decides — it loads **iff the
site is already egress-approved AND the URL is https** (no plaintext into the sandbox). Otherwise it stays
gated with a message telling the user the agent must visit the site first (which triggers the normal egress
prompt). A loaded remote page uses the SAME hardened, opaque-origin sandbox as a local file (no
`allow-same-origin`). No new approval UI, no weakening of the gate; new sites still flow through the agent's
egress request. New: `canPreviewRemote()` in `preview_resolve.ts` (+ tests), `bridge.previewEgressAllows()`,
the `/api/preview/egress-check` endpoint, `desktop/scripts/demo_p_preview_3b.ts`.

**Remaining:** P-PREVIEW.3a (agent-invoked `preview_open`/`preview_screenshot` via `pi.registerTool` + the
cross-process screenshot round-trip) — the one piece that still needs a live omp+Electron session to verify
(a faulty `-e` extension can break omp launch).

### Addendum (2026-06-30) — P-PREVIEW.3a "preview_open" landed as a DRAFT (verify omp launch live before merge)

Built the agent-invoked **`preview_open`** half of 3a, as a flagged draft (the `preview_screenshot`
round-trip — the model seeing its own UI — is **P-PREVIEW.3a-shot**, still ahead). "The agent drives the
preview": a new `harness/omp/preview_extension.ts` registers a `preview_open(path)` tool via
`pi.registerTool`; the tool runs in the omp subprocess, validates a local `.html`/`.svg` path, and
acknowledges. The actual panel-opening is a desktop side effect: the `preview_open` tool_call streams to
acp_backend over ACP, which detects it (pure `previewOpenPath()`) and emits the existing `preview-available`
event → the renderer opens the panel and re-gates the path through `resolvePreview` before rendering.

**Why DRAFT, and how it's de-risked.** The genuinely-unverifiable-here parts are: (a) omp launches with the
new `-e` extension, (b) the exact `pi.registerTool` parameter-schema format the installed omp wants, (c) the
model invoking the tool. To keep this from ever **breaking omp launch**: the extension is verified to import
cleanly (no syntax/import error), registration is fully `try/catch`-wrapped (a missing or schema-rejecting
`registerTool` is a silent no-op — unit-tested: `previewExtension` NEVER throws), and the `-e` arg is added
only `existsSync`-guarded. So worst case `preview_open` is simply absent and the gate/chat/auto-on-write
preview keep working. The pure logic (registration, exec path-gating, `previewOpenPath` extraction) is
unit-tested with a mock `pi`; the desktop detection reuses the already-verified `preview-available` path.

**Merge discipline:** opened as a **draft PR** — merge only after a live omp+Electron run confirms omp
launches with the extension and the model can invoke `preview_open`. New: `harness/omp/preview_extension.ts`
(+ `preview_extension.test.ts`), `previewOpenPath()` in `preview_resolve.ts` (+ tests), the `-e` wiring +
`preview_open` detection in `acp_backend.ts`, `desktop/scripts/demo_p_preview_3a.ts`. P-PREVIEW.3a-shot
(screenshot-as-multimodal-ToolResult via a cross-process file-handshake) remains the final preview piece.

### Addendum (2026-06-30) — P-PREVIEW.4: the panel now actually RENDERS a local file (the file:// gap, fixed)

A live test revealed the Preview panel never *rendered* a local file - it only ever set `iframe.src = file://…`,
which **Chromium blocks from an http origin** (the renderer is served over `http://localhost`, in dev AND in
the packaged Electron app: "Not allowed to load local resource"). So the feature was visually broken since
P-PREVIEW.1 (my earlier check only confirmed the `src` was *set*, not that it rendered - the boundary I'd
flagged was real). Diagnosed alongside the gate work: the agent kept trying to open its built games in a
browser (no browser tool → denied) precisely because the in-app Preview wasn't rendering.

Fix: serve the local file's **content** same-origin behind the transport gate (`/api/preview/file?path=` →
pure `readPreviewFile()` in `desktop/preview_file.ts`, gated to a local `.html`/`.svg`, existing, ≤ 5 MB),
fetched by the authenticated bridge (`previewFile()`), and rendered via the iframe's **`srcdoc`** in the SAME
hardened opaque-origin sandbox (`PREVIEW_SANDBOX`, no `allow-same-origin`). Works in dev + packaged; ideal for
the self-contained single-file apps the agent builds. **Live-verified** end-to-end via the dev server: a real
local game renders (DOM + screenshot - "LUCID PREVIEW WORKS ✓" with CSS animation), through the actual Open
button → `loadPreview` → `previewFile` → `srcdoc` flow. Limitation: `srcdoc` has no base URL, so a multi-file
app's RELATIVE assets (external CSS/JS/images) won't load - fine for single-file games; a base-aware
http-served preview is a future P-PREVIEW.4b. New: `desktop/preview_file.ts` (+ test), the `/api/preview/file`
endpoint, `bridge.previewFile()`, the renderer srcdoc path, `desktop/scripts/demo_p_preview_4.ts`.

### Addendum (2026-06-30) — P-PREVIEW.3a FINALIZED: the agent drives the preview (the draft is now real)

The P-PREVIEW.3a `preview_open` tool shipped earlier as a DRAFT with two unverified guesses. Both are now
resolved against the **installed** omp (`@oh-my-pi/pi-coding-agent` extension API,
`dist/types/extensibility/extensions/types.d.ts`), and the draft is corrected to match:

1. **`registerTool` IS exposed to `-e` extensions.** Confirmed — `ExtensionAPI.registerTool(ToolDefinition)`
   is the same injected API that already gives `asksage_extension` its working `pi.registerProvider`. The
   earlier worry that user `-e` extensions can't register tools was wrong.
2. **The parameter schema must be a `TSchema`, not a raw JSON-schema object.** The draft's
   `parameters: { type: "object", … }` placeholder would have been rejected. Fixed to author the schema via
   the injected `pi.typebox` shim (`Type.Object({ path: Type.String(...) })`), which the API documents for
   extension-tool parameters. If the shim is somehow absent the extension is a silent no-op (still launch-safe).
3. **Approval tier.** `ToolDefinition.approval` defaults to `"exec"`; left unset, opening a preview would have
   hit the exec gate and been *blocked* — exactly the flailing 3a exists to stop. Set to **`"read"`** so a
   preview never trips exec/egress.

A second bug surfaced in the desktop bridge: a **custom** tool's name does not survive as the ACP
`session/update` `kind` (omp maps every custom tool to `kind: "other"`); omp renders the call **title** as
`"preview_open: <path>"`. So `acp_backend` now matches `previewOpenPath` against the **title** (and keeps
`previewablePath` on `kind`, which is `"edit"` for writes — that path already worked). Without this the agent's
`preview_open` calls would never have surfaced the panel.

**Root cause closed.** The live diagnostics showed the agent burning turns trying `browser`/`bash`/`eval` to
view its own web apps — all security-gated, so all DENIED — and inventing relative-iframe wrapper files
(whose relative child 404'd as "not found" under `srcdoc`). The fix is two-sided: (a) the now-real
`preview_open` tool lets the agent open a file directly, and (b) a new **`PREVIEW_POLICY`** in the frozen
prompt prefix (layer 3) tells the agent NOT to use browser/bash/eval to view its work — write the `.html`
(LUCID auto-opens the panel) or call `preview_open`, and prefer ONE self-contained file so it renders. The
prompt-prefix change is a deliberate **`PREFIX_VERSION` 5 → 6** bump (CLAUDE.md invariant #6).

Touched: `harness/omp/preview_extension.ts` (real TSchema + `approval:"read"`), `desktop/acp_backend.ts`
(title-keyed detection + appended `PREVIEW_POLICY`), `harness/prompt/assembler.ts` (`PREVIEW_POLICY` +
version bump), tests (`preview_extension.test.ts`, `preview_resolve.test.ts`), `demo_p_preview_3a.ts`.
Still ahead: **P-PREVIEW.3a-shot** (the `preview_screenshot` multimodal round-trip — the model seeing its own
rendered UI).

### Addendum (2026-06-30) — P-PREVIEW.4b: served preview with a per-frame CSP (why the game showed only its HUD)

Live testing of P-PREVIEW.4 surfaced a deeper bug: a self-contained game rendered only its static HUD in the
Preview panel while rendering FULLY when opened in a browser from `file://`. Root cause, proven by reproducing
the exact iframe sandbox in a headless browser: the renderer's `index.html` sets
`Content-Security-Policy: … script-src 'self'` (no `'unsafe-inline'`), and a **`srcdoc` iframe INHERITS its
parent's CSP** — so the previewed app's inline `<script>` blocks were blocked, its JS never ran, and only its
static HTML painted (`style-src 'unsafe-inline'` is why the HUD was still *styled*; the title overlay + canvas
are JS-driven, so they vanished). Repro without a CSP → full render; repro with LUCID's exact CSP → inline
scripts blocked. `srcdoc` can only *tighten* the inherited CSP, never re-enable inline scripts — so srcdoc can
never run a self-contained app under our policy.

Fix: serve the file via **`iframe.src`** from a new `/api/preview/serve?path=` endpoint that returns the
document with its **own per-frame CSP** (`PREVIEW_FRAME_CSP` in `preview_resolve.ts`) — a document loaded via
`src` carries its own policy instead of inheriting the parent's. That policy lets a self-contained app RUN
(`script-src 'unsafe-inline' 'unsafe-eval' blob:`, `style-src 'unsafe-inline'`, data/blob img+media, blob
workers) while **`default-src 'none'` + `connect-src 'none'`** block ALL network egress — so a previewed,
agent-authored app can never bypass LUCID's egress gate (this protection used to ride on the inherited CSP;
it's now explicit and frame-scoped). `base-uri`/`form-action` `'none'` close the redirect/exfil seams. The
frame stays in the opaque-origin sandbox (`PREVIEW_SANDBOX`, no `allow-same-origin`), so it still can't read
LUCID's origin/storage or navigate the top frame. An `<iframe src>` GET can't send a header, so this one
endpoint accepts the per-launch transport token as a `?t=` query param — same token, still behind the
loopback (H1) + Origin/Host/CSRF (H2) gate; a missing/wrong token is 403 (verified).

**Verified end-to-end in the real dev server:** `/api/preview/serve` returns the 64 KB game with the exact
`PREVIEW_FRAME_CSP` header (200 with token, 403 without), and driving the actual Preview panel renders the
FULL game — title, legend, and the JS-drawn **Play** button — where srcdoc showed only the HUD. This
supersedes P-PREVIEW.4's *render mechanism* (srcdoc → served frame) but reuses its pure reader
(`readPreviewFile`). New/changed: `PREVIEW_FRAME_CSP`, the `/api/preview/serve` endpoint + token-via-query,
`bridge.previewServeUrl()`, the renderer's `loadPreview` local branch, `preview_resolve.test.ts` (+CSP tests),
`desktop/scripts/demo_p_preview_4b.ts`. Still ahead: multi-file apps with RELATIVE assets (external CSS/JS)
need base-aware serving — a future increment; single-file apps (what the agent builds) render fully now.

### Addendum (2026-07-01) — P-PREVIEW.3a-shot: the agent SEES its own rendered UI (`preview_screenshot`)

Closes the "agent drives the preview" loop: a `preview_screenshot` tool that returns a PNG of the current
preview as `ImageContent`, so the model actually SEES how its app renders and can self-correct — instead of a
security-gated browser/bash/eval.

The cross-process problem: `capturePage` lives in the **Electron main** process, `dev.ts` (server + acp_backend)
is a **separate spawned** process, and the tool runs in the **omp subprocess** — three hops. Rather than a
fragile call-time round-trip, the **renderer proactively caches** a PNG after each preview render (it can
capture via the existing `capturePreview` IPC) by POSTing it to `/api/preview/shot-cache`; the tool just
**fetches** the cached shot from `/api/preview/shot`. omp reaches it because it **inherits `process.env`** from
`dev.ts`, which sets `LUCID_PREVIEW_SHOT_URL` (real bound port + token) after the server binds — so no
`ACPClient` env plumbing was needed. Like `/serve`, the shot GET accepts the token via `?t=` (the subprocess
gets a ready URL). The tool is **read-tier** (never trips the exec gate) and every failure path — no shot, no
desktop, fetch error — degrades to helpful TEXT (never throws, never a bogus image block). `ImageContent` is
`{ type:"image", data:<base64>, mimeType }` (confirmed against pi-ai) so the model genuinely sees it.

**Verified:** the desktop cache round-trip live in the real dev server (empty → cached → exact round-trip;
bad token → 403; a non-image body is rejected, not stored); the tool's fetch→`ImageContent` wrapping + all
graceful-degradation paths by unit test (mocked `fetch`/env) and `make demo-P-PREVIEW.3a-shot`. The
**model actually seeing the image** needs `capturePage`, i.e. the packaged/Electron app — the honest live
boundary (same class as 3a's model-invocation). New/changed: `previewShotImage` + the `preview_screenshot`
tool (`preview_extension.ts`), the shot cache state + `/api/preview/shot-cache` + `/api/preview/shot` +
`LUCID_PREVIEW_SHOT_URL` (`dev.ts`), `bridge.cachePreviewShot()`, `cacheRenderedPreviewShot()` on iframe load
(`app.ts`), tests (`preview_extension.test.ts`), `desktop/scripts/demo_p_preview_3a_shot.ts`.

### Addendum (2026-07-01) — P-PREVIEW.4c: MULTI-FILE apps render (inline the app's own relative assets)

The remaining preview gap: an app split into `index.html` + `style.css` + `game.js` (+ images/fonts) didn't
render — a single served file's relative refs couldn't load. The preview frame is opaque-origin (so `'self'`
matches nothing) and its CSP deliberately lists no remote origins, and we must NOT allow the serving origin
(that would let the sandboxed frame reach LUCID's own same-origin URLs — /app.js, token-gated /api, …).

**Chosen approach — inline, don't widen.** Before serving, fold the app's OWN *pure-relative* assets into the
HTML: `<link rel=stylesheet href=x.css>` → `<style>…</style>`, `<script src=game.js>` → inline `<script>`,
`<img src=…>` and CSS `url(…)` → `data:` URIs. This fits the EXISTING `PREVIEW_FRAME_CSP` exactly
(`script-src`/`style-src 'unsafe-inline'`, `img/media/font data:` already allowed, `connect-src 'none'`
preserved) — so it needs **no CSP change, no second server/origin, no base-URL widening**, and the egress
block is untouched. Considered but rejected: (a) allowing the serving origin in the frame CSP — leaks
same-origin reach into the sandbox; (b) a second isolated origin/port — more moving parts for no security
gain over inlining.

**Fail-safe + bounded** (`desktop/preview_inline.ts`, pure, I/O injected): only pure-relative refs are touched
— never a scheme/`//`/root-absolute/`#`, never a `..` traversal, never outside the app's own directory; a ref
that can't be read is left as-is (the CSP then blocks it); per-asset (2 MB) and total (12 MB) caps bound the
inline; a `</script>` inside an inlined file is neutralized so it can't break out. Wired into `/api/preview/serve`
(HTML only; `.svg` is self-contained) as best-effort — any inlining failure serves the raw HTML.

**Verified end-to-end in the real dev server:** a 4-file app (`index.html` + external CSS + external JS + a
PNG) served with `<link>`/`<script src>` gone and content folded in, and the actual Preview panel rendered it
correctly — styled green box (external CSS), JS-set text "MULTI-FILE OK ✓" (external JS ran), and the image
(inlined as `data:`) — under the unchanged opaque-origin/egress-blocked frame. New: `desktop/preview_inline.ts`
(+ `preview_inline.test.ts`, 13 cases), `toFsPath` exported from `preview_file.ts`, the `/api/preview/serve`
inlining step, `desktop/scripts/demo_p_preview_4c.ts`. This completes the preview render story for the apps the
agent builds (self-contained AND multi-file); a page that pulls from a real CDN still (intentionally) can't —
that's an egress concern, not a render bug.

### Addendum (2026-07-01) — auto-show the preview (no toast) + inline a nested relative `<iframe>` (wrapper support)

Two fixes from live use. (1) **Auto-show, don't ask.** P-PREVIEW.2 popped a "App ready to preview — Open /
Dismiss" toast when the panel was closed, but it auto-dismissed before the user could click it. "It's just a
preview" — so `onPreviewAvailable` now simply OPENS the Preview panel on the freshly-written file (or swaps to
it if already open); the toast is gone, and it always points at the new file (no stale prior value). (2) **The
self-test wrapper renders.** The agent often writes a tiny wrapper whose whole body is
`<iframe src="game.html?selftest=1">` — a relative nested iframe, which the frame CSP (`default-src 'none'`,
no `frame-src`) blocked. `inlinePreviewAssets` now also folds a relative `<iframe src="…​.html">` into `srcdoc`
by reading the target, RECURSIVELY inlining its own assets, attribute-escaping, and dropping the query (the
embedded page renders normally without it). Verified live: the wrapper you'd get from the agent now renders the
full game in the panel; **no CSP change needed** — Chromium allows the same-document `srcdoc` child under
`default-src 'none'`. Depth-capped (a self-referential wrapper can't loop) and budget-shared with the parent.
Touched: `desktop/preview_inline.ts` (iframe→srcdoc + recursion), `desktop/renderer/app.ts` (auto-show),
`preview_inline.test.ts` (+iframe cases), `demo_p_preview_4c.ts`.

## ADR-0103 - P-FS.1: full-tree workspace folder browser (supersedes ADR-0022 M1's home confinement)

**Date:** 2026-06-30
**Status:** Accepted - BUILT. Supersedes ONLY the **M1** decision of ADR-0022 (the folder browser's
home-subtree confinement). ADR-0022's **H1** (loopback bind) and **H2** (Origin/Host/CSRF + token gate)
are untouched and remain in force.
**Increment:** P-FS.1. (Numbered after PR #154's ADR-0097-0102, which are unmerged on another branch; when
both land the sequence is contiguous.)

### Context

ADR-0022 M1 confined the in-app folder browser (`/api/fs/list`) to the user's home subtree via
`pathWithin(homedir(), …)`, to neutralize a CodeQL `js/path-injection` "arbitrary directory-listing oracle"
finding. In practice this **locks the user into their home directory**: they cannot select a workspace that
lives on another drive, under `/opt`, `/srv`, a mounted volume, `C:\work`, etc. A desktop IDE (VS Code,
JetBrains, etc.) must be able to open a project folder ANYWHERE on the machine; the home confinement makes
the Workspace picker unable to do its core job.

### Decision - browse the whole machine; keep the transport gates; add a managed allowlist

1. **Lift the home confinement.** `/api/fs/list` now lists any directory: it can navigate **above home up to
   the filesystem root** (POSIX `/`) and, on Windows, to a **"computer" level that enumerates drives**
   (`C:\`, `D:\`, …). `setWorkspace` already accepts any existing path, so selecting the folder works once
   the browser can reach it. New pure module `desktop/fs_browse.ts` `listDir(want, opts)` owns the logic.
2. **Why this is safe (the M1 threat is moot for the only caller).** `/api/fs/list` is reachable ONLY by the
   local, authenticated user inside the Electron app, because ADR-0022's other two mitigations still stand:
   **H1** binds the server to loopback (`127.0.0.1`) so the LAN can't reach it, and **H2** runs the
   Origin/Host allowlist + JSON-content-type + per-session token gate before routing, defeating DNS-rebinding
   and drive-by CSRF. A "directory-listing oracle" is only a threat against an *attacker* who can call the
   endpoint; here the sole caller is the user browsing their own filesystem, which is the feature. Path
   **canonicalization is preserved** (`resolve` collapses `..`/relative segments), so paths are still normalized.
3. **Enterprise can re-confine (only tightens).** A new optional managed-config `workspaceRoots: string[]`
   (ADR-0068 model; also via the Windows GPO value `WorkspaceRoots`) re-restricts the browser to an org's
   allowlisted roots and never offers a parent above them. Unset = full filesystem (the individual-user
   default). This mirrors how managed policy only ever ADDS constraints.

### Plumbing (built this increment)

- `desktop/fs_browse.ts` - pure, dependency-injected `listDir`: full-tree traversal, FS-root/drive-root
  parent clamping, the `COMPUTER` drives sentinel (Windows), dotfile hiding, git flagging, and managed-root
  confinement. Selects `path.win32`/`path.posix` by platform so Windows semantics are correct (and unit-
  testable on POSIX CI).
- `desktop/dev.ts` - `/api/fs/list` now delegates to `listDir(path, { allowedRoots: managedWorkspaceRoots() })`;
  removed the now-unused `statSync`/`dirname` imports.
- `desktop/managed_config.ts` - `ManagedConfig.workspaceRoots?` + `managedWorkspaceRoots()` accessor + the
  `WorkspaceRoots` GPO list reader.
- `desktop/fs_browse.test.ts` (9 tests) + `desktop/scripts/demo_p_fs_1.ts` + `make demo-P-FS.1`.
- The renderer folder picker (`openFolderBrowser` in `app.ts`) is unchanged: it already renders whatever
  `dirs`/`parent`/`home` the endpoint returns and round-trips the `parent` string (incl. the COMPUTER sentinel).

### Invariants preserved

Fail-closed transport unchanged (ADR-0022 H1/H2; invariant #3 for the control plane). The security gate,
scanner, trust labels, and quarantine semantics are untouched - this is a *folder picker* scope change, not a
data-trust change. Managed policy only tightens (ADR-0068). `listDir` never throws on an unreadable directory
(returns an empty listing). New first-party files carry the BUSL-1.1 header.

### Relates to

ADR-0022 (supersedes M1; preserves H1/H2), ADR-0068 (the managed-config "only tightens" model + GPO reader),
`desktop/workspace.ts` (`setWorkspace`, already unconfined), `desktop/path_guard.ts` (`pathWithin`, still
used by the editor-save guard), and CLAUDE.md invariant #3 (the control-plane gates stay fail-closed).

## ADR-0104 - P-CHAT.1: inline expandable code preview for tool steps (writes highlighted, edits as diffs)

**Date:** 2026-07-01
**Status:** Accepted - BUILT.
**Increment:** P-CHAT.1.

### Context

The chat folds a turn's tool calls into one compact "steps" window, but each step was a one-liner (kind +
a short detail like the file path) - you couldn't see the code the agent actually wrote or changed. A user
asked for the inline, expandable code preview they liked in Claude Code.

### Decision

Make each tool step that carries authored code EXPANDABLE to an inline preview: a `write`/`create` shows the
new file, syntax-highlighted; an `edit` shows a green/red line diff (with a `+N −M` badge on the collapsed
row). Full syntax highlighting reuses the ALREADY-vendored Monaco via its `colorize` API (main-thread
tokenizer, no language-service worker, no new dependency) - lazy-loaded on first expand, with a plain-escaped
fallback if it fails.

- **Contract:** the `tool` ChatEvent gains an optional `code: { path, content?, patch?, oldText?, newText? }`
  (added to BOTH parallel definitions - `acp_backend.ts` and `bridge.ts`). `acp_backend` fills it from the
  tool_call's `rawInput`, bounded to 64 KB so a huge file can't bloat the event stream (the content is the
  SAME text the gate already scanned). The exact edit shape was confirmed at RUNTIME (a debug capture, since
  the minified omp bundle was inconclusive): omp's `edit` sends a **hashline patch** in a single `input`
  string (`[path#hash]` header + `SWAP`/anchor directives + `+`/`−` lines), NOT `oldText`/`newText`. So:
  `content` → a write; `input` on an edit-kind call → `patch`; `oldText`/`newText` and an `edits[]` array are
  kept as fallbacks for edit tools that send explicit before/after.
- **Rendering:** `createThoughts().step()` takes the `code` and, when present, renders the row as a toggle
  with a `.ts-code` panel; on first expand it lazily fills it - Monaco-highlighted HTML for a write (Monaco
  escapes its own text, safe to assign); a hashline `patch` colored per line via `patchLineType()`
  (add/del/meta/ctx); or an `oldText`/`newText` pair via `lineDiff()` (pure, LCS-based). Every diff/patch line
  is set with `textContent` (escaped) and colored by `.tc-add`/`.tc-del`/`.tc-meta`/`.tc-ctx`; the collapsed
  row shows a `+N −M` badge (`patchStat` / `diffStat`). All unit-tested (`linediff.test.ts`).

- **Open in editor:** each expanded preview has an "Open in editor" button that opens the file in the full
  Monaco IDE panel (ADR-0029/0036) for context - like Claude Code's expand. It prefers the real file on disk
  (`bridge.editorRead` → `openIde({path, sha256})`, so it's editable with a gate-protected save), and falls
  back to the in-hand content/patch as a snippet when there's no readable path.

### Safety

Code text is only ever inserted as escaped text (`textContent`) or as Monaco's own escaped colorize output -
never raw `innerHTML` of tool input. So agent/tool-authored code can't inject markup into the chat DOM. The
inline preview is display-only; opening the editor reuses the existing gate-protected save path.

### Scope / follow-ups

This increment covers the authored code (writes + edits) - the "code preview" itself. Showing a `bash`
command's OUTPUT and a `read`'s content inline needs correlating the tool_call with its later tool_result by
id (the command already shows in the step detail); that's a fast follow-up, not in this increment.

### Verification

`lineDiff`/`diffStat` unit-tested (`linediff.test.ts`). Live in the real dev server: the app bundles + loads
clean with the new imports; Monaco `colorize` returns highlighted token spans; and the injected step markup
renders exactly as intended - a write step with syntax-highlighted JS and an edit step with a `+N −M` badge
and a green/red diff. `make demo-P-CHAT.1`.

### Relates to

ADR-0029/0036 (the vendored Monaco + its same-origin worker setup this reuses), ADR-0027 (the reasoning/steps
surfaces this extends), the frozen ChatEvent shape (extended, not redefined, in both definitions).

## ADR-0105 - P-EDIT.1: use the `replace` edit tool (not omp's default `hashline`); native folder Browse

**Date:** 2026-07-01
**Status:** Accepted - BUILT.
**Increment:** P-EDIT.1.

### Context

Real edit turns produced a stream of tool failures: "this edit anchors to lines … that [file#hash] never
displayed", "anchor line X is already targeted by another hunk on line Y; issue ONE hunk per range". These are
omp's DEFAULT `hashline` edit tool rejecting the model's patches - hashline anchors each hunk to line-hash
markers the model must have "displayed", one hunk per range, which Claude/GPT frequently violate. Separately,
the Workspace "Browse" button used the in-app folder browser, which the user found still confined to the home
folder and couldn't create new folders.

### Decision

1. **`edit.mode: replace`** in `harness/omp/acp_config.yml`. omp's `edit.mode` accepts
   `hashline | replace | patch | apply_patch`; `replace` is the classic find-old→put-new (search/replace)
   format Claude Code / aider use - far more robust for these models, eliminating the anchor/hunk failures.
   Only the edit FORMAT changes; the security gate still scans every edit in-process, fail-closed. Extends omp
   via config (invariant #1). `replace` sends `edits: [{ old_text, new_text }]`, which also gives the inline
   preview (P-CHAT.1) a clean old→new diff (acp_backend now reads `old_text`/`new_text`, camelCase + top-level
   kept as fallbacks).
2. **Native folder Browse.** The Workspace "Browse" button now calls the native OS dialog
   (`bridge.pickFolder` → Electron `dialog.showOpenDialog` with `openDirectory` + `createDirectory`) - browse
   anywhere on the machine AND create new folders, no confinement. `setWorkspace` already accepts any existing
   path. Falls back to the in-app browser only in a plain-browser build (no native dialog).

### Verification

Live in the real dev server: a write+edit and follow-up edits ran with **zero** tool failures (vs the prior
hashline stream), and the inline preview showed a clean red/green diff (`−Three −beta / +Final +gamma`, +2 −2).
The native dialog is Electron-only, so it verifies in the packaged app (logic + typecheck clean).

### Relates to

ADR-0104 (P-CHAT.1, the inline diff this feeds), ADR-0103 (the workspace browser this Browse path supersedes
for the native case), CLAUDE.md invariant #1 (config overlay, not an omp fork) and #3 (the gate still scans
every edit fail-closed).

## ADR-0106 - P-NETWL.1: curated network whitelist (domains/IPs, trust scopes) + OS-encrypted credential vault

**Date:** 2026-07-01
**Status:** Accepted - BUILT (foundation increment; UI in P-NETWL.2-.4).
**Increment:** P-NETWL.1.

### Context

The product already gates every network-reaching tool call per-website (P-EGRESS.1/ADR-0062: browser/web_search
/web/fetch forced to prompt; the desktop shows an approval dialog; a standing "always allow this site" choice
is remembered in `~/.omp/lucid-egress.json`; the enterprise-managed ceiling in `managed_config.ts` clamps it,
tighten-only). That per-site memory is ad-hoc. Users need a **deliberate, structured whitelist** they curate up
front: separate **internal (intranet)** vs **external (internet)** domain lists, both TLD-level (`*.com`) and
sub-level exact (`api.example.com`); optional **IP / CIDR** ranges; a per-entry **trust scope** and **call
budget** mirroring how tool-call approvals scope; and, for endpoints that require auth (JWT/OAuth/SAML/PEM/
API-key/username+password), a way to store the secret **securely** with a native file-upload path for config/
token/key files. This whitelist must also surface in the Goal Loop (authorized search engines + preference-
ordered URLs) and be one click away from the netdiag DNS pills. That full surface is large; this increment lays
the load-bearing foundation everything else depends on. The one hard new requirement over the existing plaintext
-at-0600 API-key store (`settings_store.ts`): **secrets must be OS-encrypted, never plaintext** - this is a
security product.

### Decision

1. **`network_whitelist.ts` (pure, Bun-side).** A `WhitelistStore` of `WhitelistEntry` records:
   `{ id, kind: domain|ip, pattern, zone: internal|external, scope: always|project|loop, project?, callBudget?,
   auth? }`. Matching is pure + self-contained: `matchDomain` (`*.example.com` matches the base + any subdomain;
   exact matches only itself; case-insensitive), `matchIp` (IPv4 single + CIDR). `whitelistMatch` returns the
   granting entry or null. **Trust scopes are a CLOSED set** (`always | project | loop`); the schema is frozen
   now (WHITELIST_SCHEMA_VERSION = 1) so `.2/.3` add UI without a schema break. Persisted at
   `~/.omp/lucid-whitelist.json` (mode 0600, non-secret). `sanitizeStore` drops any malformed entry (a dropped
   entry = not whitelisted = fail-closed).
2. **Only the `always` scope is ENFORCED in P-NETWL.1.** `project`/`loop` entries and `callBudget` round-trip
   and persist but grant nothing yet - `project` lands with the Settings UI (.2), `loop` + the call budget with
   the Goal Loop (.3). Enforcing them now without their UI would be untestable dead policy.
3. **Wired into the live gate.** `egress_policy.egressDecision` now calls the new pure, store-injected
   `egressWhitelistAllows(store, url, managed)` FIRST: a whitelist match auto-allows - **but the managed ceiling
   still wins** (a managed-denied host, or one outside a restrictive managed allow-list, is never granted;
   tighten-only, identical rule to `clampEgress`). Any error → not allowed (fail-closed). A whitelist allow takes
   the same auto-allow path (and audit event) as a remembered `allowHosts` allow, so no acp_backend change is
   needed and the existing `egress_decision` audit still fires.
4. **`cred_vault.ts` + main-process IPC - the OS-encrypted credential vault.** Secrets are encrypted at rest by
   the OS key store via Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux). The
   module is dependency-injected (`SafeStorageLike` + `VaultIo`) so it unit-tests without Electron. **Fail-closed
   is non-negotiable: `storeCredential` THROWS if OS encryption is unavailable and writes nothing - there is no
   plaintext fallback.** The whitelist entry carries only an opaque `vaultRef` (+ non-secret metadata); the
   secret never touches the config JSON. `readCredential` (decrypt) is **main-process-only** - the renderer can
   store/list/delete but never receive a plaintext back. Refs are traversal-proof (`[A-Za-z0-9_-]`). Blobs live
   under `~/.omp/lucid-cred-vault/` (0600).
5. **Native file picker + bridge plumbing.** `lucid:pickFile` (native `openFile` dialog, optional filters) for
   uploading config/token/PEM/key files, and `lucid:credStore|credList|credDelete|credEncryptionAvailable` IPC,
   all exposed through preload + the renderer `bridge` (Electron-only; in a plain browser `pickFile`→null,
   `credList`→[], `credStore`→`{error:"os-encryption-unavailable"}`, i.e. fail-closed). The Settings section,
   Goal-Loop field, and DNS-pill quick-add that CONSUME these land in P-NETWL.2-.4.

### Why not just widen the existing egress allow-list?

`allowHosts` is a flat list of exact hosts with no zones, no wildcards/CIDR, no scoping, and no auth. Bolting all
of that onto it would overload a simple ad-hoc store and entangle the "remembered a click" semantics with a
"curated policy" semantics. A sibling module keeps each concern clean and lets the whitelist feed the gate through
one pure function that still defers to the same managed ceiling.

### Verification

`make demo-P-NETWL.1` (hermetic - injects a store + managed policy + a fake safeStorage, touches no user files):
a `*.githubusercontent.com` wildcard and a `10.0.0.0/8` CIDR auto-allow while `evil.com` falls through; a
managed-denied host and a host outside a restrictive managed allow-list are refused even though whitelisted;
`project`/`loop` entries persist but grant nothing; the vault blob contains no plaintext, decrypt roundtrips,
listing is metadata-only, and an unavailable-encryption store throws with nothing written. Tests: 27 new
(`network_whitelist.test.ts` domain/CIDR/verdict/sanitize + `cred_vault.test.ts` fail-closed/roundtrip/traversal).
Full desktop suite 844 pass / 5 fail (the 5 are pre-existing Windows-only path artifacts in `fs_browse.test.ts`,
green on Linux CI). Typecheck + license-check clean. The native dialog + safeStorage verify in the packaged app.

### Relates to

ADR-0062 (P-EGRESS.1, the per-site gate this extends), ADR-0068 (P-ENT.1, the managed ceiling this defers to),
CLAUDE.md invariant #1 (sibling module + config, not an omp fork), #3 (fail-closed: a whitelist can only grant,
and only under the managed ceiling; the vault refuses rather than writing plaintext), and #7 (trust labels are a
closed set - the trust SCOPES here are likewise a frozen closed set). Follow-ups: P-NETWL.2 (Settings UI +
file-upload + tooltips), P-NETWL.3 (Goal-Loop authorized engines/URLs + per-loop call budgets), P-NETWL.4 (netdiag
DNS-pill quick-add with trust/scope picker).

### P-NETWL.2 addendum (2026-07-01) - the Network Whitelist Settings UI

**Status:** BUILT + live-tested. v1.8.22.

Builds the visible tier on the P-NETWL.1 foundation: a **"Network Whitelist"** section in Settings
(`secWhitelist` in `desktop/renderer/app.ts`, between MCP connectors and More providers).

- **CRUD backend** (`desktop/dev.ts`): `GET /api/whitelist` (list), `POST /api/whitelist` (upsert, mints an
  id), `POST /api/whitelist/remove` - backed by the pure `network_whitelist` store (`upsertEntry`/`removeEntry`
  /`saveWhitelist`). Entries are NON-secret (patterns + zone/scope + an opaque `vaultRef`); `bridge` gains
  `whitelistList/Upsert/Remove` + `WhitelistEntryView`.
- **The section** lists entries with `domain|IP` / `internal|external` / scope badges (a non-`always` scope
  shows a "not yet enforced" tooltip - honest, since only `always` gates today) + a Remove button, and an add
  form with SEPARATE inputs for the pattern, kind (domain/IP), zone (intranet vs internet), trust scope, and a
  per-loop call budget. Every control carries a custom `data-tip` tooltip.
- **Credential attach** (optional, in a disclosure): choose an auth kind (JWT/OAuth/SAML/PEM/API-key/basic),
  a label, a username (basic), and the secret either **pasted** (`credStore`) or **uploaded as a file**
  (`credStoreFile` - a new main-process IPC that opens the native file dialog, reads + encrypts the file
  ENTIRELY in main; the secret bytes never cross to the renderer). Both paths store to the OS-encrypted vault
  and the entry keeps only the returned `vaultRef`.

**Live verification (real dev server, `preview_*`):** the section renders with all controls; adding
`*.githubusercontent.com` (external/always) and `10.0.0.0/8` (internal/project) persisted with correct badges;
**end-to-end the live egress gate now auto-allows the whitelisted host** (`/api/preview/egress-check` →
`raw.githubusercontent.com` and `objects.githubusercontent.com` both `allow:true`, `evil.example.com`
`allow:false`); the **fail-closed** path held - adding an entry with a pasted secret in the plain browser (no
`safeStorage`) was REFUSED with neither the domain nor the secret persisted (no plaintext); UI Remove worked;
test entries were cleaned up. The vault ENCRYPTION-success path + native file upload verify in the packaged
Electron app (safeStorage is Electron-only). Typecheck + license clean; `about`/`version` tests bumped to
1.8.22. Still deferred to later increments: `project`/`loop` scope + call-budget ENFORCEMENT (P-NETWL.3), last-4
masking (ADR-0107 / P-KEYS.1), and the DNS-pill quick-add (P-NETWL.4).

### P-NETWL.3 addendum (2026-07-01) - ENFORCE project/loop scope + per-loop call budget

**Status:** BUILT + tested. v1.8.23.

The scopes P-NETWL.1 only stored are now enforced. `whitelistMatch(store, target, ctx)` honors the trust scope
against a context: `always` everywhere; `project` only when `ctx.project` equals the entry's workspace (path
normalized - trailing-slash + case-insensitive); `loop` only when `ctx.loop` is true. `egress_policy` gains
`egressWhitelistEntry` (returns the granting entry) + `egressDecisionDetailed(url, ctx)` ({verdict, via, entry});
`egressDecision(url, ctx?)` now takes optional context. `acp_backend` threads `{ project: currentWorkspace(),
loop: this.goalActive }` at the egress site. The **per-loop call budget** is enforced by the loop runner (it
needs mutable state): a `loopHostCalls` Map (reset each `/goal` start) counts auto-allowed calls per host;
`withinCallBudget(used, budget)` (pure) caps them - once exhausted the whitelist stops auto-allowing that host
this loop (falls through to prompt / fail-closed block) and records a `call-budget` LoopBlock in the AAR. The
managed ceiling still wins over every scope. **Verified:** demo-P-NETWL.3 (project only in its workspace; loop
only in a loop; budget 3 → `allow allow allow block block`; managed-deny beats a project allow) + live
(loop-scoped host → egress-check with no loop context → `allow:false`). Tests: +scope/budget/normProject.

### P-NETWL.4 addendum (2026-07-01) - DNS-pill quick-add

**Status:** BUILT + live-tested. v1.8.23.

Each DNS pill in the Network-diagnostics panel (dev mode) is now click-to-whitelist: `openWhitelistQuickAdd`
opens a small `popover` with a zone / trust-scope / call-budget picker (an IP host defaults to the `ip` kind),
then `whitelistUpsert`s the host. **Live-verified:** generated real Gmail DNS resolutions (`Resolve-DnsName`,
no account access), clicked the `mail.google.com` pill, added it with `scope=loop, callBudget=5`, confirmed it
persisted and the popover closed; screenshot captured. Clean-up removed the test entry + restored dev mode.

## ADR-0107 - Credential lifecycle (public tier): type documentation, last-4 masking, labels, rotation visibility + manual rotation, one on-prem KMS connector

**Date:** 2026-07-01
**Status:** Accepted (design); implementation deferred to P-KEYS.1+. No code this session.
**Increment:** design ADR (paired with the add-on's ADR-A012 for the enterprise tier).

### Context

P-NETWL.1 (ADR-0106) shipped a local OS-encrypted credential vault (`cred_vault.ts`) that stores a credential's
`kind`, `label`, and an opaque `vaultRef`, and never returns plaintext. Users now need to (a) see WHAT a stored
credential is without exposing it, (b) rotate their own keys with good hygiene, and (c) optionally back a
credential with a key-management system. This ADR fixes that design AND the public-vs-private product split.
The main repo is **BUSL source-available (public)**; the enterprise/sellable capability lives in the private
add-on (`TechLead187/lucidagentIDEaddon`, its own `ADR-A###` sequence - see **ADR-A012** there). This ADR
covers only what belongs in the public IDE: the "help a user rotate their own keys" bucket.

### Decision (public tier - what stays in this repo)

1. **Documented, non-secret metadata.** Extend the vault's `CredMeta` with facts that are safe to persist and
   show: `kind` (the credential TYPE - already stored), user `label` (already stored), **`last4`** (at most the
   last 4 chars of the secret; for a PEM/cert, the last 4 of its fingerprint), `createdAt`, `rotatedAt`, optional
   `expiresAt`, optional `rotationIntervalDays`, `source: local | kms`, and for a KMS-backed entry a key
   REFERENCE only (provider + key id/URI). **Never store more than 4 chars.** The UI identifies a key as
   `JWT · "prod-gateway" · ••••3F9A` - enough to know which key, never enough to use it.
2. **Rotation visibility (pure/local).** Key age, last-rotated, a "rotation due" state when
   `now - rotatedAt > rotationIntervalDays`, and expiry warnings, surfaced as badges in the whitelist/settings
   UI. Pure math, no network - ideal for the public tier.
3. **Manual local rotation.** Replace a secret in place: re-encrypt, KEEP the same `vaultRef` (so whitelist
   entries never break), bump `rotatedAt`, refresh `last4`, best-effort overwrite of the old blob.
4. **One generic on-prem / self-host KMS connector.** A `KmsProvider` interface (`getSecret`/`rotate`/
   `describe`) with a single public backend targeting **HashiCorp Vault (OSS)** or a self-hosted endpoint - the
   "personal KMS on-prem" path the user called out. Secrets are fetched just-in-time in the main process and
   never persisted decrypted; the vault stores only the key reference. Fail-closed: a KMS fetch failure yields
   no secret, never a fallback.
5. **Audit.** Rotation/add/remove events (`credential_added` / `credential_rotated` / `credential_removed`)
   will be added to the `EventName` enum in `contracts.ts` - a frozen-contract change (invariant #8), so it is
   its own small increment when built.

### Non-goals here (they live in the add-on, ADR-A012)

Managed **cloud KMS** connectors (AWS KMS/Secrets Manager, Azure Key Vault, GCP Secret Manager/Cloud KMS,
Oracle OCI Vault, IBM Key Protect); **automated / policy-driven rotation**; **org-mandated** rotation intervals
and **KMS-only enforcement** (no local-vault secrets); **compliance** (rotation events → OCSF/SIEM, attestation
reports); **HSM / PKCS#11 / FIPS**.

### Rationale for the split

Last-4 masking, labels, rotation reminders, manual rotation, and a single OSS/self-host connector are
table-stakes hygiene that drive adoption and cost the enterprise offer nothing. The cloud connectors, rotation
automation, org policy, and compliance/attestation are exactly what enterprises (and, in a lighter tier, small
businesses) pay for - so they belong behind the private add-on.

### Verification

Design only this session. When built (P-KEYS.1): pure tests for `maskLast4` (never emits > 4 chars; handles a
secret shorter than 4; PEM → fingerprint), the rotation-due predicate, and the `KmsProvider` contract against a
fake backend; a demo proving `last4` is derived and stored as non-secret metadata and that manual rotation
preserves the `vaultRef`.

### Relates to

ADR-0106 (P-NETWL.1, the vault this extends), ADR-0068 (P-ENT.1, the managed ceiling the enterprise policy tier
builds on), the add-on's **ADR-A012** (the private counterpart), CLAUDE.md #3 (fail-closed: secrets never
plaintext, decrypt main-only, KMS fetch has no fallback) and #8 (new `EventName`s are a contract change).

### P-KEYS.1 addendum (2026-07-01) - last-4 masking (first slice of the public tier)

**Status:** BUILT + tested. v1.8.23.

Shipped the identify-without-revealing piece of ADR-0107: `cred_vault.deriveLast4(secret, kind)` (pure) derives
at most the last four characters as NON-secret metadata (`CredMeta.last4`), stored at credential-store time and
surfaced by `listCredentials`. For a PEM/cert the armor lines + whitespace are stripped so the last-4 identifies
the KEY (base64 body), not the boilerplate. The Network-Whitelist UI looks up each entry's `auth.vaultRef` in the
vault metadata and shows `••••XXXX` on the auth badge. **Verified:** unit tests (`deriveLast4` never > 4 chars,
PEM body, short-secret-as-is; `listCredentials` surfaces `last4` but never the full secret). The full store →
display roundtrip needs the packaged Electron app (safeStorage). Still deferred: rotation visibility + manual
rotation + the self-host `KmsProvider` connector (the rest of P-KEYS.1/ADR-0107), and the enterprise KMS tier
(add-on ADR-A012).

### P-KEYS.2 addendum (2026-07-01) - rotation visibility + manual rotate-in-place

**Status:** BUILT + tested. v1.8.24.

The rotation slice of ADR-0107's public tier. `CredMeta` gains non-secret `rotatedAt` / `expiresAt` /
`rotationIntervalDays`; `cred_vault` adds pure `rotationStatus(meta, now)` + `rotationLabel(status)` (worst
state wins: `expired` > `rotation due` > `expires in Nd` / `rotate in Nd` > `rotated Nd ago`, with an ok/warn/
danger tone) and `rotateCredential` - re-encrypts a new secret under the SAME `ref` (so a whitelist entry never
breaks), bumps `rotatedAt`, refreshes `last4`, preserves createdAt/label/kind/interval. **Fail-closed:** if the
OS keystore is unavailable `rotateCredential` throws and the old ciphertext is left intact (never clobbered or
plaintext-written). Main IPC: `credRotate` (paste) + `credRotateFile` (native file, read+encrypted in main).
UI: each whitelisted key shows a rotation badge (`••••XXXX` + `rotated Nd ago` / `rotation due` / `expired`),
a **Rotate** button opens a paste-or-file popover, and the add form has an optional "rotate every N days"
reminder. **Verified:** demo-P-KEYS.2 + 16 vault tests (rotationStatus/Label math, rotate roundtrip preserves
ref + bumps rotatedAt + refreshes last4, fail-closed leaves the old secret intact); live - the Rotate button +
popover render and the browser (no safeStorage) path fail-closes with "the old secret was left untouched". Still
deferred: the self-host `KmsProvider` connector (P-KEYS.3) + the enterprise KMS tier (add-on ADR-A012).

### P-KEYS.3 planning decision (2026-07-01) - external KMS is BYO + add-on-only; the public core ships NO KMS binary

**Status:** Decided (planning); implementation is an add-on increment. Supersedes ADR-0107's public-tier item 4.

Cost/size review of HashiCorp Vault (the intended self-host `KmsProvider` backend):
- **License:** Community edition is **BUSL-1.1** since Aug 2023 - source-available, not OSI open-source; free for
  internal/production use, only barred from *competing hosted/embedded* offerings. It is the **same license as
  LUCID**, so bundling its binary = redistributing a BUSL binary inside our BUSL app (legally awkward, avoid).
- **Size:** the binary is **large and growing** (~247 MB v1.14.1 → ~355 MB v1.14.2; container ~678 MB). Bundling
  would bloat our installers 3-4x per platform.
- **Our own vault has neither problem:** `cred_vault` rides Electron `safeStorage` = the OS keystore
  (DPAPI/Keychain/libsecret), **$0 and ~0 added bytes** - no binary shipped.

**Decision:** do NOT bundle Vault, and do NOT put an external-KMS connector in the public core at all. The public
tier's storage backend is the OS keystore only (already shipped: vault + last-4 + rotation). **All external KMS -
the self-host Vault BYO connector AND the managed cloud connectors - lives in the private add-on** (ADR-A012).
The self-host path is **bring-your-own**: LUCID's `KmsProvider` talks to a Vault the customer already runs over
its HTTP API (`VAULT_ADDR` + token/AppRole), fetching the secret just-in-time (never stored by us), configured
via an in-app "connect your Vault" card + instructions - the same "install/run it yourself" model as the optional
`headroom` proxy. This revises ADR-0107 item 4 (the "one self-host connector in the public tier") to: **no KMS
connector in the public core.** ADR-A012 is updated to own both the self-host BYO Vault connector and the cloud
connectors. P-KEYS.3 is therefore an ADR-A012 (add-on) increment, not a public-core one.

## ADR-0108 - P-NETWL.5: egress posture (allow-all + web-search toggles); whitelist enforces only when allow-all is off

**Date:** 2026-07-01
**Status:** Accepted - BUILT + tested. v1.8.25.
**Increment:** P-NETWL.5.

### Context

The curated whitelist (P-NETWL.1-.4) is fail-closed: with nothing whitelisted, the agent can't reach the
internet without a per-site prompt. For a **personal / non-enterprise** user that's too restrictive - "my agents
can't access the internet." We need an easy, default-on way to let agents work, while keeping the whitelist as
the opt-in restrictive mode and preserving the enterprise story.

### Decision

Add an **egress POSTURE** - two toggles, both **pre-checked** by default, stored in the whitelist store
(`EgressPosture { allowAll, allowWebSearch }`, default both true; a posture-less file upgrades to permissive):

1. **Allow web search** - `acp_backend` auto-approves the `web_search` tool (omp's built-in providers) when
   `allowWebSearch` is on; else it prompts.
2. **Allow all websites + local LAN** - when `allowAll` is on, `egressDecisionDetailed` auto-allows (`via:
   "allow-all"`) EXCEPT the still-prompt set: a **public IP literal** (country unverifiable) and a **foreign
   country-code TLD** (`isForeignTld`: a 2-letter ccTLD, excluding `.us` and generic-use `io/ai/co/me/tv/…`).
   LAN / private / loopback / intranet hosts (`isPrivateOrLanHost`) always auto-allow ("+ local LAN"). **The
   curated whitelist ENFORCES only when `allowAll` is OFF** - the UI dims it to "standby" while on.

The order in `egressDecisionDetailed`: an explicit whitelist entry wins first (so you can approve a specific
foreign site), then allow-all, then the standing egress store. **Fail-closed is preserved:** the scanner gate is
untouched; an unparseable target still prompts; and an **enterprise managed policy clamps `allowAll` OFF**
(`clampPosture`: a restrictive `allowedHosts` or `disableDangerMode` forces whitelist-enforced mode) - the
"contact your Support Desk" path. `web_search` is left to the user's toggle. Posture is served (effective +
`managedLocked`) at `/api/whitelist/posture`.

### Verification

`make demo-P-NETWL.5` + tests (allow-all classifier: LAN allow / public-IP + foreign-TLD prompt / US-generic
allow; `clampPosture` managed override; posture sanitize/default). **Live** (real dev server, `egress-check`):
with allow-all on, `github.com` + LAN auto-allow while `baidu.cn` + `8.8.8.8` still prompt; flip allow-all off →
`github.com` prompts (whitelist-enforced); the two pre-checked toggles render with premium tooltips and the
whitelist dims to standby. Full suite green; typecheck + license clean.

### Relates to

ADR-0062 (P-EGRESS.1, the per-site gate this sits over), ADR-0068 (P-ENT.1, the managed ceiling that clamps it),
ADR-0106 (P-NETWL.1-.4, the whitelist this makes opt-in), CLAUDE.md #3 (the SCANNER gate stays fail-closed; this
is the consent layer, defaulted permissive for personal use but clamped restrictive by managed policy and still
prompting for public IPs / foreign sites).

## ADR-0109 - P-IDE.1e: Fable 5 enabled behind a connected Claude account + a U.S.-government privacy notice

**Date:** 2026-07-01
**Status:** Accepted - BUILT + tested. v1.8.25.
**Increment:** P-IDE.1e.

### Context

Fable 5 (`claude-fable-5`) shipped in omp's model catalog but the app kept it **visible-but-disabled** under an
ITAR advisory (ADR-0029 P-IDE.1b). It's now to be **usable**, but it routes through Anthropic (so it needs a
Claude account) and it carries a specific data-handling caveat the user must see.

### Decision

1. **Gate on Claude auth.** Drop Fable 5 from the ITAR `UNAVAILABLE` map (Mythos 5 stays gated). `unavailableReason`
   now returns undefined for Fable **only when a Claude (Anthropic) account is connected** - `claudeAuthed()` =
   the `anthropic` major has `oauthActive` OR `keySet`. Without it, Fable stays greyed with a "connect a Claude
   account to enable" reason (not the ITAR one). `state.auth` loads from first paint, so the picker knows.
2. **U.S.-government privacy notice, three surfaces.** A small shield **row marker**, a **hover-card banner**, and
   a **persistent danger toast on selection** all state: *"Chat history for this model has NO expectation of
   absolute privacy from the U.S. government."* Selecting Fable raises the notice instead of the routine "applied"
   toast. Informational (not a typed-ACKNOWLEDGE wall like the China-origin unlock) - the user asked for a warning,
   not a hard gate.

### Verification

Live (real dev server, Claude OAuth active): omp lists `anthropic/claude-fable-5`; the picker row is **selectable**
with the shield marker; the hover card shows the privacy banner; selecting it switches to "Claude Fable 5" and
raises the persistent privacy toast (screenshot captured). Typecheck + license clean; full suite green (the change
is renderer-only UI logic).

### Relates to

ADR-0029 (P-IDE.1, model governance + the ITAR `UNAVAILABLE`/warning-wall pattern this extends), the Providers
auth surface (`anthropic` OAuth / `ANTHROPIC_API_KEY`) that gates it. Note: this is a data-sovereignty disclosure
in the same family as the AskSage gov advisory + the China-origin acknowledgment wall.

## ADR-0110 - P-EXEC.2: answer omp's FORM-elicitation tool approval (fixes every gated tool call silently failing "denied by user")

**Date:** 2026-07-01
**Status:** Accepted - BUILT + tested (live chat).
**Increment:** P-EXEC.2.

### Context

Live chat regressed: EVERY bash/eval/edit/delete tool call failed with a neutral "block" chip reading
`tool failed: … Tool call denied by user: bash`, and the user was **never shown an approve/deny prompt**.
Reproduced against the real dev server: a plain `echo hello123` was denied just like `node -e "…"`.

Root cause (omp `@oh-my-pi/pi-coding-agent` 16.1.20): a tool call now passes through **two** gates.
1. `#wrapToolForAcpPermission` (OUTER) → our `session/request_permission` handler - our authoritative gate.
   The gate-diagnostic (P-GATE-DIAG.1) confirmed we correctly returned `allow` (`optionId: allow_once`).
2. `ExtensionToolWrapper` (INNER) - applied to every tool **because we launch omp with `-e GATE -e ASKSAGE`**.
   Its approval check calls `uiContext.select(["Approve","Deny"])`, which in ACP mode maps to a FORM
   **elicitation** (`elicitation/create`) - but only if the client advertised `elicitation.form`. We advertised
   only `fs` capabilities, so omp's `select()` returned `undefined`, which `wrapper.ts` treats as **deny** →
   `throw "Tool call denied by user"`. The inner gate fires only AFTER the outer one allowed, so our allow was
   real but a redundant second gate we couldn't answer killed the call.

There is **no config-only fix**: forcing `tools.approvalMode: yolo` would silence the inner gate but also make
`#isExplicitAutoApproveMode()` true, which SKIPS our outer `session/request_permission` gate - losing our
classifier/prompt entirely. The two gates are driven by the same signal in opposite directions.

### Decision

1. **Advertise `elicitation: { form: {} }`** in the main session's ACP `initialize` (NOT the KG-extraction
   client, which answers every request with `{}` and calls no gated tools).
2. **Answer `elicitation/create`** in the ACP `onRequest` handler via `answerElicitation` →
   `elicitationApproval(options)` (pure, in `exec_policy.ts`, unit-tested). It reads the elicitation's single
   `value` enum and **accepts the affirmative option** (`/\b(approve|allow|yes|proceed|accept)\b/i`, whole-word
   so a `["Deny"]`-only set is never approval), returning `{ action: "accept", content: { value } }`; with no
   affirmative option (a custom question) it returns `{ action: "decline" }` - matching the pre-capability
   behavior where such prompts returned no value. Recorded in the gate diagnostics (`kind: "elicitation"`).

**Why auto-accept is safe (not a gate bypass):** the elicitation is omp's redundant INNER approval; it fires
only after our OUTER `session/request_permission` gate already ran (classify → prompt the user for a risky
unpinned command, or allow a pinned/danger-mode one). The real approve/deny decision is made there. Also
handles plan-mode approval (its select carries "Approve and execute"), preserving prior auto-approve.

### Verification

Live (real dev server, Claude OAuth, developer mode):
- **Before:** `node -e "console.log(2+2)"` and `echo hello123` → `block: Tool call denied by user: bash`; gate
  diag showed our verdict was `allow` yet the tool died. Raw omp options captured: `allow_once/allow_always/
  reject_once/reject_always`.
- **After:** `node` (pinned, `allowPrograms:["node"]`) → runs, reply `4`; gate diag shows `exec allow` +
  `elicitation accept:Approve`. An **unpinned** `python --version` → a real `permission` event surfaced
  (`program: python`), resolving it `exec:allow-once` ran the tool (reply `Python 3.14.2`). No more silent denies;
  the approve/deny prompt loop works end-to-end.
- `elicitationApproval` unit-tested (tool-approval, plan-mode, case-insensitivity, whole-word, junk input,
  decline-on-no-affirmative). Full `exec_policy.test.ts` green (164), desktop typecheck clean.

### Relates to

ADR-0066 (P-EXEC.1, the exec classifier + `session/request_permission` gate this complements), P-GATE-DIAG.1
(the gate-decision ring that pinpointed the bug), ADR-0062/0094 (egress gate on the same permission path).
Carries forward the CLAUDE.md wrinkle that omp seams must be confirmed against the installed version: 16.1.20
moved per-tool approval to a FORM elicitation that a client must now explicitly support.

## ADR-0111 - Chat history survives app upgrades: a STABLE default workspace (never the install dir)

**Date:** 2026-07-02
**Status:** Accepted - BUILT + tested.
**Increment:** P-WS.1.

### Context

Users lost their chat history on every version update. Root cause: chat sessions live in `~/.omp/agent/
sessions/` (user home - survives upgrades), but `listSessions` shows only sessions whose recorded `cwd`
equals `currentWorkspace()`. The default workspace was `REPO = join(import.meta.dir, "..")` - the app's
**install directory**, which `import.meta.dir` reports differently for every packaged version. On upgrade the
default cwd changed, so all prior sessions (recorded under the old install path) were filtered out - present
on disk, invisible in the UI.

### Decision

`currentWorkspace()` falls back to a new `defaultWorkspace()` that is **version-independent**:
- **Dev-from-source:** the checkout is a real git repo (`REPO/.git` exists) and a good default → keep REPO.
- **Packaged app:** no `.git` in `resources/repo` → use a fixed `~/.omp/lucid-workspaces/default` (created on
  demand). Never the versioned install dir. An explicitly-set workspace is always honored as before.

This stops the bleeding going forward (the default cwd is now stable across releases). Sessions created under
a *prior* version's install-dir default remain on disk but orphaned; they can be re-attached by opening that
old path as a workspace if it still exists (a future migration could re-home them by rewriting recorded cwd).

### Verification

Dev-from-source keeps REPO (has `.git`) - no behavior change for contributors; the packaged branch resolves to
the stable path. Typecheck clean; sessions continue to match by recorded cwd (sessions.ts unchanged).

### Relates to

sessions.ts (`listSessions` matches by recorded `cwd`), workspace.ts, settings persisted at `~/.omp/lucid-gui.json`.

## ADR-0112 - P-GOAL.14: browse PAST After-Action Reports

**Date:** 2026-07-02
**Status:** Accepted - BUILT + tested (live).
**Increment:** P-GOAL.14.

### Context

The loop After-Action Report (ADR-0054) streams into chat once, when a loop finishes, and is written to
`<workspace>/.omp/loops/<id>-<slug>.report.md`. There was no way to reopen a past AAR - the report files
existed on disk but nothing listed them. The cross-run stats banner (ADR-0055) showed aggregates, not the
individual reports.

### Decision

Pure/fs helpers in `goal_memory.ts`: `summarizeReport` (pull goal title + outcome badge from a report's
markdown), `listGoalReports` (list `*.report.md` most-recent first, confined to the loops root),
`readGoalReport` (read one back, traversal-rejected). Endpoint `GET /api/goal/reports` (list) and
`?rel=` (one). The goal modal's Loop-history area now renders a **"Past After-Action Reports"** list; each row
opens the full report markdown in a viewer modal. Shown whenever report files exist, even if the run-log
ledger is empty.

### Verification

Live: pointed the workspace at a project with a saved AAR → the list showed the report (✅ Goal met, correct
goal), clicking it opened the full report (Scoreboard, $5.33 spend). Unit tests for summarizeReport +
listGoalReports/readGoalReport (incl. traversal rejection). Typecheck clean.

## ADR-0113 - P-BRIEF.4: synthesize the podcast to real audio (WAV) + download; wire the P-BRIEF.2 TTS backend

**Date:** 2026-07-02
**Status:** Accepted - BUILT + tested (endpoint live, fail-safe path verified).
**Increment:** P-BRIEF.4.

### Context

The Engineering Update (ADR-0072) produced a two-host podcast **script** but no audio - `/api/brief` returned
text only ("audio synthesis is a later slice"). The TTS backend (ADR-0071, `harness/brief/tts_backend.ts`, an
OpenAI-compatible `/v1/audio/speech` client) was built + unit-tested but wired to nothing, so the UI's
"podcast" promise (and the "Local TTS - Kokoro" option) generated no sound. The accordion was also mislabeled
"from this run", which users conflated with the loop AAR.

### Decision

1. **Wire audio.** New `POST /api/brief/audio` builds the podcast script and synthesizes it via the existing
   `OpenAiCompatibleTtsBackend`, returning a base64 WAV. Two providers, both the same OpenAI `/v1/audio/speech`
   shape:
   - **local-tts** - a self-hosted Kokoro server (air-gap, no key; `LUCID_TTS_URL`, default `:8880`).
   - **openai-tts (ChatGPT)** - `https://api.openai.com`, the stored `OPENAI_API_KEY`, model
     `gpt-4o-mini-tts` (override `OPENAI_TTS_MODEL`), voices Host=`nova`/Engineer=`onyx`. A missing key is an
     actionable note, not an error; a synth failure returns the fail-safe note (never a 500).
2. **Download.** The renderer plays the WAV inline (`<audio>`) and offers **Download WAV** (`engineering-update.wav`).
3. **Relabel.** The accordion now reads "exec brief + podcast · from your repo logs" and its tooltip states it
   is NOT the loop AAR (which appears in chat after a loop). Added the ChatGPT option to the provider select.

WAV (not MP3) because the backend already emits WAV and MP3 needs an encoder dependency; the user accepted
"whichever is easier". The synthesis runs in the desktop process (not omp's egress gate), so it's a
user-initiated network call to the chosen endpoint.

### Verification

Live: `/api/brief/audio` with local-tts (no Kokoro running) fail-safed to "TTS unavailable … returning script
only" with `ok:false` + note (the exact UI-degrade path). Bundle builds with the audio + download UI; the
provider select shows script-only / ChatGPT / Kokoro. `openai-tts` uses the same verified backend path (not
exercised live to avoid real OpenAI charges). Typecheck clean.

### Relates to

ADR-0070 (podcast backend seam + vendor research), ADR-0071 (the TTS backend), ADR-0072 (the brief). Enabling
ChatGPT TTS = add an OpenAI key in Providers; the rest is automatic.

## ADR-0114 - P-CHAT.2: engagement policy — no autonomous action on a greeting; opt-in numbered next steps (PREFIX v7)

**Date:** 2026-07-02
**Status:** Accepted - BUILT + tested (live).
**Increment:** P-CHAT.2.

### Context

A user said only "hi" to Grok on a fresh session and it began scanning the working directory and making
unrequested edits/"improvements". The agentic system prompt (omp's default + our BUILD/DELEGATION policies)
plus the mere presence of files led some models to invent a task from the cwd. The user wants the agent to
respond only to what's asked, and on a low-signal opener to ask whether to review the cwd (or use the
knowledge-graph recall for hints), offering easy numbered next steps to choose from.

### Decision

Add a byte-stable `ENGAGEMENT_POLICY` (layer 3) delivered to the live omp ACP chat via
`--append-system-prompt` (like DELEGATION/BUILD/PREVIEW) and embedded in `LAYER_3_CODING`:
- Opening a chat is NOT a task; the directory's contents are NOT a request. On a new session and any
  low-signal opener (greeting/emoji/thanks/no concrete ask), do NOT scan/read-broadly/edit/run tools -
  reply briefly and WAIT. Take substantive action only on a concrete request or an explicitly chosen option.
- On a low-signal opener, offer a SHORT numbered list (2-4) of choose-by-number next steps drawn from the
  conversation + any recalled user-memory / KG hints in the prompt (NOT a fresh scan), always including
  "review the current working directory" as an explicit opt-IN. Numbered next steps are also the preferred
  way to close a reply when sensible follow-ups exist.

Because this changes the cached prefix (layer 3), `PREFIX_VERSION` bumps **6 → 7** (CLAUDE.md invariant #6:
a deliberate prefix change is its own increment + ADR). The prefix-hash test asserts stability + version-
binding (no hardcoded hash), so it stays green; re-ran demo02.

### Verification

Live (real dev server, fresh session, model claude-opus-4-8): sending "hi" produced ONLY token/usage/done
events - no tool calls, no edits, no cwd scan - and the reply was conversational ("Hey! What are you
working on?") followed by 4 numbered opt-in next steps, referencing the project from KG/recall context.
Prefix tests (assembler + prefix_compaction) green; demo02 green; typecheck clean. The policy is model-
agnostic (every model gets it via the appended system prompt), so it applies to Grok as well.

### Relates to

ADR-0028 (DELEGATION_POLICY), ADR-0033 (BUILD_POLICY), ADR-0096 (PREVIEW_POLICY) - the sibling layer-3
policies in the same `--append-system-prompt` set; the KG recall / user-profile preamble that supplies the
"what they're working on now" hints (buildUserTurnPreamble).

## ADR-0115 - P-VOICE.1: ElevenLabs TTS/STT + mic button + read-aloud + offline-STT engine choice

**Date:** 2026-07-02
**Status:** Accepted - BUILT + tested (endpoints + UI live; live ElevenLabs/mic pending a user key + mic grant).
**Increment:** P-VOICE.1.

### Context

The user wanted voice in the composer: an ElevenLabs API-key option for TTS (with a voice picker + favorites)
and STT (a mic button next to Skills), without bloating the install, plus offline STT options DoD can
approve. Foundations existed but were unwired: a `PodcastBackend` TTS seam (ADR-0071) and a
`TranscriptionBackend` STT seam (ADR-0073, never wired to any UI/endpoint).

### Decision

1. **ElevenLabs backends** (`harness/voice/elevenlabs.ts`, pure `fetch` clients - ZERO install bloat, no SDK):
   `ElevenLabsTtsBackend` (PodcastBackend; `/v1/text-to-speech/{voice}`, PCM→WAV concat, `eleven_turbo_v2_5`),
   `elevenLabsSpeak` (single-clip MP3 for read-aloud), `listElevenVoices` (`/v1/voices`), `ElevenLabsSttBackend`
   (`/v1/speech-to-text`, `scribe_v1`). `xi-api-key` header. Fail-safe throughout (unit-tested).
2. **Cloud vs air-gap split** (mirrors the app's gov-vs-personal posture): ElevenLabs is the PERSONAL path
   (audio leaves the device); the DoD/air-gap path is the self-hosted OpenAI-compatible Whisper (STT) / Kokoro
   (TTS) adapters. STT engine is user-selectable, **offline Whisper is the default**.
3. **Key + settings**: `ELEVENLABS_API_KEY` rides the existing provider key plumbing (auth `others`) but renders
   in a dedicated **Voice** settings card (excluded from the model-provider list; never in the model picker),
   with a **get-key link** and a **per-AAR cost estimate** (~$0.10–$0.30 per brief, a few cents per reply). New
   `GuiSettings`: `sttProvider`/`sttUrl`/`ttsProvider`/`ttsVoice`/`ttsVoiceFavorites` (`voiceSettings()`).
4. **Endpoints**: `/api/voices` (favorites first), `/api/voice-settings` (GET/POST), `/api/transcribe`
   (engine per settings), `/api/tts/speak` (read-aloud), and `/api/brief/audio` extended with `elevenlabs`.
5. **UI**: a mic **STT button** (custom SVG) next to Skills in the composer - click to record, click to stop,
   MediaRecorder → transcribe → INSERT into the composer for review (transcript is ordinary user input, scanned
   on send). TTS surfaces (all three requested): the Engineering Update **podcast** (ElevenLabs provider option
   + voice picker), **read-aloud** speaker button on assistant replies, and **AAR narration** ("Listen" in the
   report viewer). Voice picker lists **favorites first** with a ★ toggle.

### Offline STT for DoD (documented for the user)

whisper.cpp self-host (already supported via `OpenAiCompatibleSttBackend`, strongest fit) · in-app WASM Whisper
(transformers.js, no server/Python, same pattern as the RAG embedder) · faster-whisper (BYO server) · Vosk ·
NVIDIA Parakeet/Canary · Moonshine. Avoid Windows/Web Speech (routes to cloud). The discriminator is
on-device / no egress / open source.

### Verification

Live (dev server, no keys): bundle builds; `/api/voice-settings` returns defaults (whisper STT / elevenlabs
TTS); `/api/voices` + `/api/transcribe` (Whisper down) + `/api/tts/speak` (no key) all **fail-safe to notes**,
never 500. DOM: mic button present, Voice card renders (STT/TTS selects, voice picker, ElevenLabs key field +
get-key link + cost hint); STT toggle hides the Whisper-URL row + persists. `elevenlabs.test.ts` green (voice
parse, PCM→WAV, xi-api-key, fail-safe). Typecheck clean. Live ElevenLabs synth + mic recording pending the
user's key + a mic grant (backends unit-tested; endpoints fail-safe). NO version bump (batched for the weekly release).

### Relates to

ADR-0071 (TTS seam), ADR-0073 (STT seam), ADR-0113 (brief audio), the egress-posture / gov-gateway personal-vs-DoD split.

## ADR-0116 - P-REPORT.1: Engineering Reports rail feature - role-tailored briefs + a unified past-reports browser

**Date:** 2026-07-02
**Status:** Accepted - BUILT + tested (live). NO version bump (batched for the weekly release).
**Increment:** P-REPORT.1.

### Context

The Engineering Update lived buried in goal-form step 5 and produced one audience-neutral brief. The user
wanted it (a) a dedicated left-rail feature for ALL roles, (b) role-tailored so Dev/Security/Manager/Exec
each get a report framed for them, (c) with a right-side browser of ALL past reports - both the per-workspace
loop After-Action Reports and the repo-wide Engineering Update briefs - plus the P-VOICE.1 fixes (pre-generate
voice pick, ~10c cost note, and the inline-player bug).

### Decision

1. **Rail feature** (all roles): a new `report` rail glyph opens the **Engineering Reports** panel - generate
   (left) + past-reports list (right). Not gated by role.
2. **Role tailoring** (pure, ADR-0116, `renderEngineeringBrief(u, role)` + `buildPodcastScript(u, role)`):
   extraction stays audience-neutral; RENDER genuinely CHANGES CONTENT per audience - a per-role section set,
   an item filter, a cap, and whether ADR/increment codes appear. Only the **Developer** view keeps the ADR
   IDs, increment codes, and source tags (all 5 sections). Non-developers get **zero ADR references** (codes
   scrubbed from titles AND details via `scrubCodes`): **Security** shows only security-relevant items
   (`isSecurityItem` filter: gate/egress/auth/credential/vault/CUI/…) across Risks + Decisions + Dependencies +
   Shipped; **Manager** shows Shipped + Decisions + Risks in plain language (capped); **Executive** shows the
   top-4 Shipped + Risks + Decisions as **title-only headlines** (`dropDetail`), no tech-debt/dependencies.
   The scoreboard line only counts the sections that view shows. Default (no role) = the full "Engineering Update".
3. **Persisted briefs** (`desktop/report_store.ts`): a generated brief is saved to a global
   `~/.omp/lucid-briefs/<ts36>-<role>.md` (briefs are repo-wide) when `?save=1`. The goal-modal preview omits
   save; the Reports panel Generate saves.
4. **Unified list**: `GET /api/reports` merges per-workspace loop AARs (`listGoalReports`) + saved briefs
   (`listBriefs`), most-recent first, each tagged `kind: "aar" | "brief"`. `GET /api/report?kind=&rel=` reads
   one (confined to its store). Each row opens a viewer with a **Listen** (TTS) button.
5. **Reused P-VOICE.1**: the panel carries the voice picker (favorites, pre-generate), the ~10c cost note, and
   the blob-URL audio player + Download. The player bug (a big WAV as a `data:` URL wouldn't play) is fixed by
   a `URL.createObjectURL` blob URL, applied to the podcast, read-aloud, and AAR narration.

### Verification

Live (dev server): the rail glyph opens the panel (role select dev/sec/mgr/exec, provider, voice, cost). A
developer brief generated + saved + tailored (leads with "Tech debt", title "Developer Engineering Update").
`/api/reports` returns both a `brief` and the loop `aar`, and the panel's list renders both with badges;
clicking opens the viewer + Listen. Role-tailoring unit-tested (order per role, all sections present, role
label + framing, podcast title). Typecheck clean; engineering_update tests green (14).

### Relates to

ADR-0070/0072 (the brief), ADR-0113/0115 (audio + voice), ADR-0112 (the past-AAR browser this generalizes),
ADR-0088 (the roles this tailors to).

## ADR-0117 - P-REPORT.2/.3: report lifecycle - copy, download .md, two-stage archive/delete, push to KG

**Date:** 2026-07-02
**Status:** Accepted - BUILT + tested (both slices). NO version bump.
**Increment:** P-REPORT.2 (lifecycle) + P-REPORT.3 (KG push).

### Decision

Both report kinds (per-workspace loop AARs + repo-wide saved briefs) gain, in the Reports panel row + the viewer:
1. **Copy to clipboard** (the report markdown) and **Download .md** (`URL.createObjectURL` blob, `<title>.md`).
2. **Two-stage archive/delete**: the active row's action is **Archive** (soft-delete → an `archived/` subfolder,
   not gone). An **Active / Archived** tab switch reveals the archive, where a row's actions are **Restore**
   (→ active) and **Delete** (PERMANENT). So "delete twice = gone": first delete archives, second (in the
   archive) removes for good. Endpoints: `/api/report/{archive,restore,delete}`; `/api/reports?archived=1`.
   **Guard (invariant):** permanent delete only ever operates on an archived item - `deleteGoalReport` rejects
   any rel not under `.omp/loops/archived/`, and `deleteBrief` targets only the archive dir (no `force`, so a
   non-archived rel → false). Unit-tested: delete on an active report is refused; archive→restore and
   archive→delete round-trip.

### P-REPORT.3: push to the Knowledge Graph - BUILT (2026-07-02, no version bump)

The user asked to optionally **push a report into the personalization KG**, choosing the compartment when
more than one is unlocked and defaulting to the sole unlocked one. Now built.

- **Ingest shape (user-confirmed): "One report node."** The whole report enters as a single trusted node,
  not distilled/atomized facts. `addReportToKg(scope, title, markdown)` in `desktop/personal.ts`:
  `upsertEntity("Engineering Report: <title>", "user:decision", "trusted")` + one
  `addFact({ entityId, statement: markdown.slice(0, 20_000), trustLabel: "trusted", scope })`. Reports are
  first-party, so they enter **trusted** - the semantic-promotion gate (CLAUDE.md keystone) is not bypassed:
  it exists to stop *suspicious-source* content auto-promoting; a first-party report is an explicit,
  user-initiated trusted write, never an auto-promotion.
- **Compartment selection.** Client reads `bridge.personal()`; unlocked `main` store yields **work** +
  **personal** targets, unlocked `cui` yields **cui**. Zero unlocked → fail-closed toast ("Knowledge graph
  locked - unlock a compartment in Settings"). Exactly one → push directly, no prompt. More than one → a
  `.kg-pick` popover to choose. Endpoint `/api/report/to-kg` (kind, rel, scope, archived) re-derives the
  markdown server-side and calls `addReportToKg`, which **also** fail-closes if personalization is off or the
  chosen compartment is locked (defense in depth - never trust the client's unlock view alone).
- **Verified:** typecheck clean (root + desktop); endpoint returns `ok:false, "...locked - unlock it in
  Settings"` when the compartment is locked; UI renders the KG button on both the row and the viewer, and a
  locked click surfaces the fail-closed toast.

### Relates to

ADR-0116 (the Reports panel this extends), ADR-0010/P9.x (the personalization KG + compartments), the
semantic-promotion gate (P4.3).

## ADR-0118 - P-REPORT.4: premium UI pass on the Scoreboard + Engineering Reports

**Date:** 2026-07-02
**Status:** Accepted - BUILT + verified. NO version bump.
**Increment:** P-REPORT.4.

### Decision

A dedicated UX/visual pass on the two surfaces the user singled out as feeling "basic": the collapsed
quick-metrics **Scoreboard** rail and the **Engineering Report** viewer. Purely presentational - no data,
storage, or security path changes.

**Scoreboard (metrics rail tiles).** Every tile is the SAME calm neutral at rest - no per-metric colour, and
(per the user's second-round feedback) **no icons**. The interest is entirely in the *reaction*:
- **Neutral by default, react on *change* - like a game.** When a value changes the tile fires a short,
  eye-catching reaction: a **clockwise light races around its border** (2 fast laps then fades), a **diagonal
  shine sweeps** across it, and the number briefly flashes its accent. Then it settles back to neutral.
  `renderMetricsRail` remembers the last value per label (`prevMetrics`) + a `railPrimed` flag so the first
  paint never false-flashes, and signature-guards the DOM write so an idle poll doesn't restart animations.
- **Persistent clockwise pulse on attention.** A tile that needs triage - findings > 0 or quarantine > 0 -
  keeps a slow **clockwise** conic light pulse + accent border. The ring (both the racing and the pulse
  variants) is a masked pseudo-element animated via a registered `@property --sweep` angle, so the highlight
  travels the border instead of rotating a clipped square. `prefers-reduced-motion` disables all of it.
- (Reverted from the first attempt: an always-on custom-SVG icon chip per tile. The user explicitly did not
  want icons on the rail - the ask was uniform-until-it-changes, with a cool reaction. Icons removed.)

**Engineering Report viewer.** Scoped to `.aar-viewer` (the loop's inline AAR is untouched):
- **No more doubled title.** The stored report opens with a big `# After-Action Report: <goal>` H1 that just
  restated the modal-header title. `enhanceReportBody` drops that leading H1 in the viewer (header keeps the
  title). Body bumped 12.5px → **15.5px**, line-height 1.72; H2s become small uppercase section eyebrows with
  a gradient accent bar; styled lists / code / `pre` / blockquotes / tables.
- **Custom SVG outcome badge.** The `✅ / ⏹ / 🛑 / ❗` emoji in the outcome line is swapped for a real duotone
  glyph (`checkBadge` / `stopBadge` / `alertBadge`) in a coloured pill - the "checkbox" the user pointed at.
- **Beautiful charts (plasma-on-hover).** `enhanceReportBody` parses the report's ASCII "Scoreboard" block AND
  the raw (unrenderable) mermaid **pie** + **xychart** blocks and replaces each with a colour bar chart
  (`.rchart`): gradient fills, glow, per-metric colour (green add / red remove / amber errors / blue tools /
  palette rotation), and on hover a moving multi-hue **plasma** sheen + brighter glow. No raw code blocks are
  left in the report. The stored markdown is untouched (loop_report stays byte-stable / test-frozen).
- **Compact, non-wrapping buttons.** Header actions: less padding (5x10 → 4x9), larger **16px** glyphs, the
  Close becomes an icon-only `×`, Listen uses a duotone `headphones` glyph, and **"To KG" → "KG"** (it was
  wrapping onto two lines); the action row is `nowrap`.

### Why

Uniform-until-it-changes makes the Scoreboard read like a live game HUD: colour/motion means "this just moved
/ needs you," nothing competes at rest. The report pass fixes a genuinely duplicated title, too-small body,
an emoji standing in for a custom glyph, unreadable raw-mermaid "charts," and a two-line KG button.

### Verified

Typecheck clean (root + desktop). Live preview: 6 rail tiles render neutral with NO icons; forcing a change
resolves `tileRace` (racing ring) + `tileShine` (sweep) + `tileNumBloom` (number flash); an attention tile
resolves the persistent `tileSweep`. Report viewer: leading H1 removed (`h1Count 0`, first node is the badge
line), outcome badge is a real `<svg>` in a `.ro-badge.ro-met` pill, **4 charts built / 0 `<pre>` left**
(Scoreboard + pie + 2 xychart bars), body computes to 15.5px, KG button single-line, `rchartPlasma` keyframe
present. No console errors.

### Relates to

ADR-0116/0117 (the Reports panel + lifecycle this polishes), the metrics rail (ADR-0021), `icons.ts` (the
hand-drawn line-icon set this extends).

## ADR-0119 - P-EXEC.3: "TLDR" command explainer + spell-check + report-title cleanup

**Date:** 2026-07-02
**Status:** Accepted - BUILT + verified. NO version bump.
**Increment:** P-EXEC.3.

### Decision

Three small usability fixes, the substantive one being a plain-language command explainer.

**"TLDR" - explain an intimidating command with a cheap model.** The exec approval card (`The agent wants
to run a [HIGH-RISK] command`) now stacks a **TLDR** button directly under the Copy button (tight padding).
Clicking it makes ONE one-shot call to the cheapest available keyed model and drops a plain-English
explanation + risk flag inline; a second click toggles it. New surfaces:
- `desktop/explain_command.ts` - `explainCommand(cmd)`: picks the cheapest keyed provider (Anthropic
  `claude-haiku-4-5` → OpenAI `gpt-4o-mini` → Gemini `gemini-2.0-flash`), one request, 320-token cap,
  20s timeout. The command is handed to the explainer as clearly-delimited `<command>` DATA with a system
  instruction that it is inert and any embedded instructions are part of the data (same trust-boundary
  posture as the harness). **Fail-soft:** no key → an actionable "add an Anthropic/OpenAI/Gemini key"
  message; any HTTP/parse error → a calm message, never a crash. Mirrors the direct-keyed-fetch pattern
  already used by `ratelimit_probe.ts`.
- `POST /api/explain` in `dev.ts`; `bridge.explainCommand`; the card UI + `.perm-tldr` / `.perm-tldr-out`
  styling (accent-tinted panel, model attribution line).
- Why keyed-model-only: TLDR is user-initiated and wants a *cheaper* model than the maker; the OAuth path is
  managed by omp and not a clean one-shot. If only OAuth is configured, the fail-soft message points the user
  to add a small key (a Haiku/mini explanation is a fraction of a cent).

**Spell-check in the composer.** The prompt `<textarea>` gains `spellcheck="true"` (browser red-squiggles),
and - because Electron underlines misspellings but won't build the correction menu itself - `main.ts` adds a
`context-menu` handler that, ONLY when there's a misspelled word (so it never fights Monaco's own menu),
pops the dictionary suggestions (`replaceMisspelling`) + "Add to dictionary".

**Report title de-cluttered.** Removed the small glyph the report viewer printed before the title in its
header (the user pointed at it) - the title now stands alone.

### Verified

Typecheck clean (root + desktop); license-header check green (new file carries BUSL-1.1). Live: `/api/explain`
returns the fail-soft "add a key" message with no key set (endpoint + provider-selection wired); a mock exec
card renders the TLDR button stacked under Copy (2px 6px pad) with the explanation panel; composer `#input`
has `spellcheck="true"`; report viewer title has no leading `<svg>`. No console errors.

### Relates to

ADR-0066/0110 (the exec approval card this extends), `ratelimit_probe.ts` (the keyed-fetch pattern reused),
ADR-0118 (the report viewer this touches).

## ADR-0120 - P-REPORT.5: print / save-as-PDF, report-panel polish, subdued inline code

**Date:** 2026-07-02
**Status:** Accepted - BUILT + verified. NO version bump.
**Increment:** P-REPORT.5.

### Decision

Four presentational fixes from a report + chat review.

**Print / Save-as-PDF (white paper).** The report viewer gains a **Print** button (new `print` glyph) between
`.md` and `KG`. `printReport(title, bodyHtml)` drops the ALREADY-ENHANCED report HTML (light-friendly classes:
headings, tables, `.rchart` bars, `.ro-badge`) into a hidden same-origin `<iframe>` carrying a self-contained
**light** stylesheet (`PRINT_CSS`: white bg, dark text, print-safe colours re-mapped from the dark theme, no
glows, `-webkit-print-color-adjust:exact`, `@page{margin:16mm}`, `break-inside:avoid` on rows/tables/charts),
then calls the iframe's `print()` - the OS dialog offers **Save as PDF** and any printer. Same-origin iframe +
`window.print()` works in both the browser build and Electron (where `window.open` to non-http is denied). The
title (dropped from the body as a duplicate on screen) is re-added as the print `<h1>`.

**Report-panel polish.** Removed the little `graph` glyph the panel drew before the Active/Archived tabs (the
user pointed at it). Bumped the panel's intro paragraph to 13.5px / brighter for readability.

**Subdued inline code in chat.** `.msg .text code` was a loud cyan chip (`--cyan-dim` bg + cyan text). Re-toned
to a neutral mono chip (`color-mix(--txt-4 13% over --bg-2)` bg, `--line-soft` border, `--txt-2` text) so it
reads like the standard mono type in the lower-left status-bar model readout - present but calm.

### Verified

Typecheck clean (root + desktop). Live preview: reports panel tab-row has no `<svg>`, intro computes to 13.5px;
report viewer shows the Print button (Listen · Copy · .md · Print · KG · ×); a light-CSS render of the actual
report body shows a clean WHITE page - title, light tables, and the Scoreboard/Tool-call bars in print-safe
colour; chat inline code computes to a neutral gray chip (text `--txt-2`), no cyan. No console errors.

### Relates to

ADR-0116/0117/0118 (the reports panel + viewer this polishes), `icons.ts` (adds `print`).

## ADR-0121 - P-REPORT.5b: print "Prepared for" footer, cost-notice fix, Listen UX + voice hotkeys

**Date:** 2026-07-02
**Status:** Accepted - BUILT + verified. NO version bump.
**Increment:** P-REPORT.5b.

### Decision

Follow-ups from a print + voice review.

**Print "Prepared for:" footer.** The print document now carries its own bottom-left footer -
`Prepared for: <identity>` - where identity is the corporate email if set, else the attribution identity
(the workstation-name fallback). `position:fixed;bottom:6mm;left:0` so it repeats on every printed page.
(The dev browser's own URL footer, "localhost:5323", is a Chrome print-UI artifact not present in the
packaged Electron app; our content footer is what carries the intended "Prepared for" line.)

**Cost-notice layout fix.** The ElevenLabs/OpenAI TTS cost note (`REPORT_TTS_COST`) fragmented into 3 flex
columns because its `<b>` and text nodes were direct children of the flex `.goal-eu-cost`. Wrapped the
message in ONE `<span>` (so it wraps as prose), pinned the icon to `flex:none` and the span to `flex:1`, and
rewrote the copy: "ElevenLabs bills per character. Generating this report's audio costs about $0.10 (~10¢)
each time."

**Listen button - it already synthesizes on demand.** Clarified + hardened: the Listen / read-aloud button
is INDEPENDENT of the Generate panel's audio option - it calls `bridge.speak` fresh on each click, so it
works any time. `speakText` now shows a spinner + "Synthesizing…" while the model runs, flips to a "Stop"
control while playing, and on failure surfaces the real engine note ("Couldn't read it aloud - choose a TTS
engine in Settings → Voice…") instead of a quiet "No audio". (If it wasn't working before, the TTS engine
wasn't configured / the ElevenLabs key lacked `text_to_speech` - now the reason is shown.)

**Voice hotkeys.** `Ctrl/⌘+Space` toggles read-aloud while a report is open (listener added on open, removed
on close), and `Ctrl/⌘+D` toggles the mic from anywhere. Both are shown in their button tooltips via
`modCombo(...)` (OS-aware label).

### Verified

Typecheck clean (root + desktop). Live preview: cost note renders as one span (svg + span, single line);
mic tooltip shows "Ctrl+D", Listen tooltip shows "Ctrl+Space"; Ctrl+Space dispatched into the open viewer
fires the Listen handler; the real print doc built from a saved brief has `body{background:#fff}`, a
`.print-title`, and a `.print-foot` reading "Prepared for: nicholas.chadwick.ctr@gmail.com". No console errors.

### Relates to

ADR-0120 (the print/report pass this extends), ADR-0115 (voice: TTS/mic), ADR-0030 (attribution identity used
for "Prepared for").

## ADR-0122 - P-REPORT.6: Security-brief compliance crosswalk (NIST 800-171/800-53 + STIG CCIs) + POA&M CSV

**Date:** 2026-07-02
**Status:** Accepted - BUILT + tested. NO version bump.
**Increment:** P-REPORT.6.

### Decision

The **Security** engineering report now ends with a compliance crosswalk, and can export an eMASS-aligned
**POA&M**. Plus a readability bump on the brief preview.

- **New pure module `harness/brief/compliance.ts`.** From the SAME `EngineeringUpdate` the brief is built
  from, `buildComplianceRows` maps each security-relevant item (by keyword) to the control families its area
  touches - NIST **SP 800-171** paras, **800-53** controls, and representative **DISA STIG CCIs** - and tags a
  **disposition** derived from the source section + wording: shipped → Fixed/Improved, risk → Regressed/Open,
  debt → Open, upcoming → Planned. `renderComplianceSection` appends a table (Change · Disposition · 800-171 ·
  800-53 · STIG CCIs) + a fixed/improved/regressed/open/planned **rollup** to the security brief (codes scrubbed
  from the change title to honor the security view's no-ADR-IDs rule). `renderPoamCsv` emits a CSV whose column
  order matches the **eMASS POA&M import template** (Control Vulnerability Description, Security Control Number,
  Security Checks=CCIs, Status[Completed/Ongoing], Severity[CAT II/III], Mitigations, Recommendations, …), one
  row per mapped item, fully quoted/escaped; the "Source Identifying Vulnerability" column carries the change
  source (ADR/increment) for analyst traceability.
- **HONESTY (load-bearing):** this is a **DRAFT keyword crosswalk, not an authoritative assessment.** The
  section, the CSV recommendation column, and the export toast all say the control/CCI selections MUST be
  validated by a security analyst against the applicable RMF baseline + current STIG/CCI list before use in an
  assessment or eMASS. We generate a defensible STARTING POINT, never a compliance claim.
- **Wiring:** `GET /api/brief/poam` (builds the update, returns `{csv, rows, filename}`); `bridge.engineeringBriefPoam`;
  an **Export POA&M (CSV)** button in the Reports panel shown ONLY for the Security role, downloading the CSV
  via a Blob. Brief preview text enlarged (12→13.5px) + higher contrast (`--txt-1`, styled H1/H2).
- **Tested:** `compliance.test.ts` (6) - maps only security items, correct control families/CCIs/disposition,
  markdown has the disclaimer+table+rollup, CSV has the eMASS headers + one row per item + escaping, empty
  update degrades honestly. All 31 brief tests green; the security-brief "no ADR IDs" test still passes.

### Relates to

ADR-0116/0117 (the reports panel this extends), ADR-0070 (the engineering-update generator this maps from).

## ADR-0123 - P-REPORT.7: TTS-friendly podcast/read-aloud, Listen cost note, NotebookLM link

**Date:** 2026-07-02
**Status:** Accepted - BUILT + tested. NO version bump.
**Increment:** P-REPORT.7.

### Decision

Three voice/report tweaks.

- **speakable(text) (exported, pure, in engineering_update.ts).** Read aloud, technical tokens sound wrong -
  ADR/increment codes become letters-and-digits, a middot is silence, inline-code keeps its backticks. It
  strips fenced/inline code + markdown + heading hashes, removes ADR/increment/issue/version codes AND
  CCI-style AA-1234 + control numbers (3.13.11), turns symbols into words/pauses, expands the worst acronyms
  (POA&M, AAR, TTS, STT, KG, CUI), and sentence-ends each line. Applied to EVERY podcast turn (say wraps it)
  and to the read-aloud text in speakText (per-line), so both flow like speech.
- **Listen cost note.** The report viewer shows a banner: Listen narrates the WHOLE report (ElevenLabs ~
  $0.50-1.50); a podcast summary is shorter/cheaper. Same cost in the Listen tooltip.
- **NotebookLM link.** The viewer banner + a generate-panel tip link to notebooklm.google.com for a free
  two-host podcast; the viewer link COPIES the report markdown first (opens external via the window-open
  handler) so the user pastes it into a NotebookLM source and hits Audio Overview.

### Verified

Typecheck clean; 35 brief tests green (4 new speakable tests). Live: security podcast scriptText has no
ADR/increment/CCI tokens; viewer note shows the $0.50-1.50 cost + NotebookLM link; generate-panel tip present.

### Relates to

ADR-0115 (voice TTS/mic), ADR-0070/0116 (the podcast/brief this speaks), ADR-0121 (the Listen UX this notes).

## ADR-0124 - P-REPORT.8: change-annotated dependency graph + schema map annexes + STIG .ckl

**Date:** 2026-07-02
**Status:** Accepted - BUILT + tested. NO version bump.
**Increment:** P-REPORT.8.

### Decision

The technical engineering reports (developer + security) gain two visual ANNEXES, and the security report can
export a native STIG Viewer checklist.

- **New pure module harness/brief/change_graph.ts.** From git `diff --numstat` + `--name-status` over a range
  (default: the last up-to-10 commits; working-tree fallback on a shallow repo), it groups changed files into
  the architecture layers (renderer / desktop / harness / scanner / tools / extensions / core), sums +added /
  -removed lines per layer + file count, tags each by net direction, and links the dependency edges. It emits
  BOTH a hand-built styled **SVG** (layered by dependency depth, green=grew / red=shrank / blue=changed, with
  the line counts + a magnitude bar) AND **Mermaid flowchart** code marked `%% lucid:changegraph` (copyable,
  importable into draw.io). A parallel **data-schema map** (`buildSchemaChanges`) flags changed files that back
  a data store (DuckDB, personalization KG, settings, cred-vault/whitelist, sessions, report store) and draws
  file → store links, again as SVG + Mermaid (`%% lucid:schema`). `renderAnnexes` appends "Annex A - dependency
  graph" and "Annex B - data schema changes" (heading + change table + copyable Mermaid).
- **Backend (dev.ts):** `/api/brief` runs git (Bun.spawnSync, fail-soft) and appends the annexes for the
  developer + security roles only; `/api/brief/ckl` returns the STIG checklist.
- **Renderer:** `enhanceReportBody` (now also run on the generate-panel preview) swaps our marked Mermaid blocks
  for the styled SVG + a "Copy Mermaid (draw.io)" button + the raw Mermaid in a collapsible; it tags each Annex
  H2 `.annex-break` so the print doc starts each annex on a NEW PAGE (`break-before:page`) with the SVG printed
  as an image (Mermaid source hidden in print). Security-report exports row now offers **POA&M (CSV)** +
  **STIG (.ckl)**.
- **STIG .ckl (compliance.ts `renderCkl`):** one `<VULN>` per control-mapped change, each with the CCIs as
  `CCI_REF` STIG_DATA, disposition → STATUS (NotAFinding / Open / Not_Reviewed), CAT II/III → severity, and the
  change source in FINDING_DETAILS. Opens directly in STIG Viewer.
- **HONESTY:** the .ckl `Vuln_Num`/`Rule_ID` are SYNTHETIC (`LUCID-Vnnn`), not from a published benchmark, and
  every artifact (checklist COMMENTS, export toast, annex text) says it is a DRAFT crosswalk for analyst
  validation - not a benchmark scan or an authoritative control assessment.

### Verified

Typecheck clean; 43 brief tests green (7 change-graph: numstat/name-status parse skipping binaries, layer
grouping + net status, marked/classed Mermaid, SVG nodes, schema map, annex markdown, empty-degrades; 1 CKL:
well-formed XML, one VULN per item, CCI_REFs, mapped statuses). Live: developer brief carries both annexes +
Mermaid over real git ("+4326 / -142 across 52 files"); the viewer + preview render 2 styled SVGs (20-rect
dependency graph) + Copy-Mermaid buttons; print doc has `.annex-break` + `break-before:page` + the SVG; the
`.ckl` export downloads 17 VULNs. License header green on the new module. No console errors.

### Relates to

ADR-0120/0122 (the report print + compliance crosswalk this extends), ADR-0001 (the layered architecture the
graph mirrors), CLAUDE.md invariant 10 (the frozen-schema contract Annex B watches).

## ADR-0125 - P-APPEAR.1: personalized chat background (ambient 25% wash + flashlight-on-hover)

**Date:** 2026-07-02
**Status:** Accepted - BUILT + verified. NO version bump.
**Increment:** P-APPEAR.1.

### Decision

The user can set a personal background image for the chat interface, shown two ways:
- **Ambient** - the image faintly (25% opacity) behind the whole chat, subtle enough not to distract.
- **Flashlight** ("dark room") - the chat background stays black, and the image is revealed ONLY under the
  cursor, at 25%, via a radial mask that follows the mouse - like sweeping a flashlight across a dark room.

- **Storage (own file):** `desktop/chat_bg.ts` persists `{ image (data URL), mode, opacity }` to
  `~/.omp/lucid-chatbg.json` - deliberately SEPARATE from the main settings JSON so the hot `settings load()`
  never parses a multi-MB image. A ~9 MB image cap (12 MB data URL), mode/opacity validated, read-directly
  (no stat-then-read / CodeQL TOCTOU). `GET/POST /api/chat-bg`; `bridge.chatBackground/setChatBackground`.
- **Render:** a `.chat-bg` layer sits behind the chat content (which gets `z-index:1`). `applyChatBg` sets the
  inline `background-image` (data URL - allowed by `img-src data:`) and toggles `.ambient` / `.flashlight`.
  Flashlight masks the layer with `radial-gradient(circle var(--bg-r) at var(--mx) var(--my), ...)`, and a
  `mousemove` on `.center` writes `--mx/--my` (mouseleave parks it off-screen). Reduced-motion drops the fade.
  Loaded + applied at boot.
- **Settings:** a new "Chat background" card (Settings, above Developer) with an image picker (file → FileReader
  → data URL), a Display select (Off / Ambient / Flashlight), a thumbnail preview + Remove, and a note
  explaining both modes. Uploading with no mode set defaults to Ambient. Client caps the file at ~9 MB with a
  clear toast before upload.

### Verified

Typecheck clean; license header on the new module. Live preview: endpoint saves/loads + reports the mode; a
test gradient at Ambient shows a faint 25% wash behind the readable chat; Flashlight shows the image revealed
only in a soft cursor-tracked spotlight over black; the settings card renders the picker + Display select +
note; boot loads + applies. No console errors. (Test image reset afterward so users start clean.)

### Relates to

ADR-0011 (settings store this sits beside), the renderer CSP (`img-src data:` already permits the background).

## ADR-0126 - P-PREVIEW.5: preview markup tools (pen/rect/text) + Browse-cwd + status-line cleanup

**Date:** 2026-07-02
**Status:** Accepted - BUILT + verified. NO version bump.
**Increment:** P-PREVIEW.5.

### Decision

- **Markup on the preview.** A `<canvas>` overlays the preview iframe. A single **Markup** toolbar button
  drops a tools popover - **Pen** (freehand), **Rectangle** (rubber-band), **Text** (a floating input that
  commits to the canvas) - each a mini hand-drawn SVG icon, plus a colour row (red/yellow/green/blue/white),
  a **Cursor** (disarm) entry, and **Clear**. Arming a tool enables the canvas's pointer-events (so it catches
  the mouse) and sets a crosshair/text cursor; Cursor disarms so the iframe is interactive again. Because
  "Screenshot → chat" uses Electron's `capturePage` on the frame's screen region, the canvas markup is
  captured TOGETHER with the rendered app - the marked-up screenshot goes to the composer for the agent with
  NO compositing. The canvas backing-size tracks the frame via a ResizeObserver (drawing preserved on resize);
  loading a new file clears it. New icons: `pen`, `textT`, `markup`.
- **Browse the cwd.** A **Browse…** button opens the native OS file picker (`bridge.pickFile`, Electron) so the
  user can open a file from their working directory and preview it themselves; in a plain browser it toasts
  "desktop app only" and focuses the path input.
- **Status line.** Removed **tokens/s** from the HUD done/stream line (read as noise); the readout is now just
  "N tokens out · N context · ~$X". Raised the HUD text contrast (`--txt-3/4` → `--txt-2`) so the done line is
  legible.

### Verified

Typecheck clean. Live preview: toolbar shows Open · Browse… · Reload · Markup · Screenshot→chat; the Markup
dropdown lists Pen/Rectangle/Text (SVG icons) + 5 colour swatches + Cursor + Clear; selecting Pen closes the
menu, arms the canvas (pointer-events auto, crosshair) and lights the Markup button; the canvas draws a pen
stroke (exact colour), rectangle, and text (pixels confirmed). No console errors.

### Relates to

ADR-0096 (P-PREVIEW.* - the panel + capturePage screenshot this builds on).

## ADR-0127 - P-KG-CODE.1: workspace code graph (colbymchenry/codegraph-style) + KG header padding

**Date:** 2026-07-03
**Status:** Accepted - BUILT + tested. NO version bump.
**Increment:** P-KG-CODE.1.

### Decision

A **code knowledge graph** for the current workspace, in the spirit of colbymchenry/codegraph but rendered in
LucidAgentIDE's own graph canvas - plus a vertical-padding trim on the KG header.

- **New pure-ish module `desktop/code_graph.ts`.** Walks the workspace's source tree (skipping node_modules,
  .git, .claude/worktrees, dist, vendor, .omp, …), parses each file's `import`/`require`/dynamic-import
  specifiers, resolves the RELATIVE ones to files in the tree, and builds a file → file dependency graph in the
  EXACT shape the graph component already consumes (`{nodes:{id,name,kind,trust,count}, edges:{from,to,relation}}`).
  `kind` = the top-level directory so files colour by module under the existing Kind lens; `count` = degree.
  Persisted per-workspace at `<root>/.omp/codegraph.json` (gitignored), so the panel knows whether the cwd is
  already ingested and offers a re-sync instead of a first ingest. External packages are ignored (this is the
  internal architecture graph, not a dependency manifest).
- **Endpoint `/api/codegraph`:** GET = status + stored graph; POST = ingest/re-sync + fresh graph.
- **UI:** below the KG **Relate** button, a 2px-gap vertical **stack** adds **Code graph** (toggle) and
  **Update** (re-ingest, shown once ingested). Clicking Code graph ingests-on-first-use and renders the graph
  in the canvas (bypassing the personalization unlock - the code graph isn't private user data); clicking again
  returns to the personal graph. The live personal-graph refresh is suppressed in code mode. A big repo is
  capped to the top-600 most-connected hubs for readability (full graph still stored); the scope label shows
  `code · N files · M imports [· showing top 600 hubs]`. Selecting a node opens a side panel with its path,
  what it imports, and what imports it.
- **KG header padding** trimmed to 6px (ID selector, Settings unaffected).

### Verified

Typecheck clean; 3 code-graph unit tests green (resolves relative edges, skips node_modules/externals, node
kind = top dir, degree counts, ingest/status/load round-trip); license header on the new module. Live: the
builder graphs the real repo (354 source files, 754 imports across desktop/harness/tools/extensions/observable);
the stacked buttons render (Relate / Code graph / Update, 2px), toggling ingests + renders the force graph
(top-600 hubs), the Update button appears once ingested, and a node click shows the imports side panel. No
console errors. `.omp/codegraph.json` added to .gitignore.

### Relates to

ADR-0010/P9.x (the KG canvas + graph component this reuses), ADR-0124 (the layer change-graph - this is the
file-level companion), colbymchenry/codegraph (the inspiration).

## ADR-0128 - P-KG-SYM.1: symbol-level (AST) code graph, level-picker popup, agent codegraph_query tool

**Date:** 2026-07-03
**Status:** Accepted - BUILT + tested. NO version bump.
**Increment:** P-KG-SYM.1.

### Decision

The developer can build a **symbol-level** code graph (real TypeScript AST), choose file-vs-symbol in a popup
during ingest, and optionally expose the graph to the **agent** as a queryable tool via a dedicated checkbox.
(Directions confirmed with the user: full AST call graph · queryable tool · dedicated checkbox.)

- **`desktop/symbol_graph.ts`** parses each source file with the real `typescript` compiler (`createSourceFile`,
  JSX-aware ScriptKind) and builds a **symbol → symbol reference graph**: nodes = top-level declarations
  (functions, classes, methods, types/interfaces, enums, consts) with their `kind`; edges = "symbol A
  references symbol B", resolved **across files through named imports** and **within a file** through its own
  top-level names. Node id = `file#symbol`; degree = reference count. Persisted at
  `<root>/.omp/codegraph-symbol.json`. **HONESTY:** AST-accurate for identifier usage + import resolution
  (far better than regex), but it is a symbol-DEPENDENCY graph, NOT a fully type-resolved call graph - it
  doesn't resolve `obj.method()` value-typed dispatch, overloads, or dynamic dispatch. The UI + tool say so.
  On the real repo: 355 files → 3093 symbols / 5449 refs in <1s.
- **Level-picker popup.** Clicking Code graph now opens a modal: **File graph (fast)** vs **Symbol graph (AST,
  a few seconds)** with the trade-offs spelled out, plus a **"Let the agent query this graph"** checkbox. The
  chosen level threads through `/api/codegraph?level=` (GET load / POST build); the canvas caps to the top-600
  hubs (full graph still stored). The node side panel switches to symbol semantics (kind badge, **Uses / Used
  by**, `file#symbol` links that open the file in the IDE).
- **Agent tool (`harness/omp/codegraph_extension.ts`).** A read-only omp `-e` extension registering
  **`codegraph_query`**: `target` = a file/symbol/`file#symbol`, `level` = file|symbol → returns what it
  imports/uses + what imports/uses it (blast radius), or a hubs summary. It runs in omp's subprocess (cwd =
  workspace) and reads the stored graphs directly, so the agent gets a precise, compact answer instead of
  grepping + reading many whole files - the token-saving payoff. Loaded ONLY when the user opts in
  (`settings.codeGraphAgent`, `/api/codegraph/agent` POST restarts the backend); registration is defensively
  wrapped (a failure never blocks omp launch). Dedicated toggle - the existing "AI" box stays scoped to
  personalization-import AI extraction.

### Verified

Typecheck clean (root + desktop); 6 graph tests green (3 file + 3 symbol: kinds, cross-file + intra-file
reference resolution, ingest/load); `codegraph_query` match/describe logic exercised; license headers pass.
Live: the picker popup lists File/Symbol + the agent checkbox; building the symbol graph rendered 5095
symbols / 1672 refs on the user's project; the symbol side panel shows kind + Uses/Used-by + file links; the
agent toggle persists + restarts. `.omp/codegraph-symbol.json` gitignored. No console errors.

### Relates to

ADR-0127 (the file-level code graph this extends), ADR-0096 (the omp `-e` tool-extension pattern reused),
`typescript` compiler API.

## ADR-0129 - P-PERF.2: power/spec-aware performance tiers (battery-adaptive KG rendering + poll backoff)

**Date:** 2026-07-03
**Status:** Accepted - BUILT + tested. NO version bump.
**Increment:** P-PERF.2.

### Context

On a battery-throttled laptop the app went sluggish while model calls stayed fine: the renderer main
thread is one event loop, and the KG force simulation monopolized it. `graph.ts` runs an O(n^2)
pairwise kernel every frame for `SETTLE=480` frames (~8s) on every mount, re-fits the camera three
times mid-settle (the "nodes wildly pulled around" effect), and - unless the OS sets
prefers-reduced-motion - the particle loop never parks (~30fps forever, drop-shadow filter per
particle). Fixed `setInterval`s (1s status / 4s refresh / 15s sessions) polled regardless of battery
or window visibility. Toasts (revealed via rAF, `ui.ts`) queued behind the sim - hence "late toast on
KG lock." Windows power-saver stretches each frame 3-5x on battery, so work invisible on AC starves
everything queued behind it. No code adapted to battery/CPU (audit: zero uses of the Battery API,
`hardwareConcurrency`, or powerMonitor).

### Decision

A render TIER, never a data gate. New `desktop/renderer/perf_tier.ts` (pure core, kg_ops.ts pattern):

- **`resolveTier(mode, signals)`** - explicit user mode always wins; `auto` derives: discharging at
  ≤20% → `minimal`; on battery, ≤4 cores, or OS reduced-motion → `reduced`; else `full`. Unknown
  signals NEVER degrade (no Battery API reads as plugged in) - degrade only on evidence.
- **`pollDelay(base, tier, hidden)`** - battery tiers stretch polls 4x; a hidden window compounds 4x
  more; work is SKIPPED while hidden and caught up on visibilitychange. The 1s/4s/15s loops in app.ts
  now run through this (`adaptivePoll`).
- **`graphOpts(tier)`** → `mountGraph` knobs: `full` = today (no calm, 480 settle, uncapped);
  `reduced` = forceCalm + 240 settle + 400-node cap; `minimal` = forceCalm + 120 + 250 (reached only
  via "Render anyway"). `capGraph` generalizes the P-KG-CODE.1 top-hubs CAP, non-mutating - the FULL
  graph stays with the caller (search/facts/signature); only the DRAWN subset shrinks.
- **graph.ts** gains `GraphPerfOpts` (`forceCalm`, `settleFrames`) + `setCalm()` on the handle, so a
  plug/unplug event calms or wakes a LIVE graph in place (chip repaints; no remount, layout preserved).
- **Minimal tier pauses the visualization, not the knowledge.** Opening the KG at `minimal` paints a
  pause card BEFORE the decrypt ("Graph rendering is paused to save power... the agent still reads and
  writes your knowledge") with a one-shot per-run "Render anyway". An explicit Code-graph click still
  renders (the user asked) at minimal fidelity. The agent's KG access takes NO tier input anywhere -
  rejecting the "lock KG to plugged-in devices" framing: data access costs milliseconds; the
  visualization was the drain.
- **`watchPerfTier`** samples the Chromium Battery API (`getBattery`, chargingchange/levelchange),
  `hardwareConcurrency`, and reduced-motion in the RENDERER (works in Electron AND the dev.ts browser;
  no main-process/powerMonitor plumbing needed). User mode persists at localStorage `lucid.perfMode`
  (device-local like the ADR-0084 cache - a perf preference is per-machine by nature), fail-safe
  normalized (junk → `auto`, the P-ROLE.1 pattern). A `#kgPerf` chip in the KG toolbar shows
  `Auto · <tier>` and cycles auto → full → reduced → minimal with a toast.

### Verified

19 new tests (`perf_tier.test.ts`: tier matrix incl. charging-at-low-level ≠ minimal + never-degrade-
without-evidence, backoff math, per-tier knobs, cap top-hubs/no-mutate/identity, mode persistence +
fail-safe + notify) - suite green (1133 pass; the 5 pre-existing fs_browse Windows-host failures are
untouched and unrelated). `make demo-P-PERF.2` proves the contract end-to-end. Typecheck clean (root +
desktop); renderer bundle builds; sidecar pytest green. Prompt prefix untouched.

### Relates to

ADR-0084 (P-PERF.1 SWR cache - the sessions half of the perf epic), B-KG.1/#114 (idle-CPU frameWork
this extends), P-KG-CODE.1 (the CAP=600 pattern generalized), P-ROLE.1 (fail-safe normalize).
Follow-ups: P-PERF.3 (KG layout persistence + energy-based settle exit), P-PERF.4 (main-process
session index + paginated transcripts + AC-only prefetch), P-PERF.5 (async settings write, optimistic
model switch, build-once model picker).

## ADR-0130 - P-PERF.3: KG layout continuity (in-memory) + energy-based settle exit

**Date:** 2026-07-03
**Status:** Accepted - BUILT + tested. NO version bump.
**Increment:** P-PERF.3.

### Context

The "nodes wildly pulled around" complaint (and most of the KG's CPU bill) came from every mount
re-seeding nodes on a circle and running a FIXED 480-frame O(n^2) settle with three mid-settle camera
re-fits - on every re-open (rail switch, lock/unlock, live-refresh remount), not just first launch.
Most layouts converge in 100-150 frames; the rest of the budget burned for nothing.

### Decision

Two pure helpers in `kg_ops.ts` (headless-testable, the B-KG.1 pattern), wired into `graph.ts`:

- **Layout continuity.** `GraphPerfOpts` gains `positions` (seed) + `onPositions` (harvest on destroy).
  `mountGraph` seeds every returning node at its previous x/y; only genuinely NEW nodes take the circle
  seeding. `settleStart(seeded, total, settle)` decides the budget: fully seeded → **static paint, zero
  sim frames** (plus the one-time zoom-to-fit the frame-checkpoint fits would have done); ≥80% seeded
  (live refresh added a few) → short 120-frame nestle; else the full budget. `app.ts` holds
  `kgLayoutCache` - a module-level `Map` keyed `personal` / `code:file` / `code:symbol`.
- **Privacy boundary (ADR-0084) kept:** positions are entity-id-keyed structural metadata of the
  ENCRYPTED store, so the cache is IN-MEMORY ONLY - never localStorage, never disk. Cold app starts
  therefore still simulate; that cost is bounded by the second half:
- **Energy-based early exit.** The integration loop accumulates Σv² per frame; `settleDone(ke, n,
  frames)` ends the sim once mean per-node kinetic energy falls under `KE_REST = 0.02` (~0.14px/frame,
  visually still) after a 30-frame grace (young layouts are near-still before forces unfold them). On
  exit it runs the final fit (unless the user has panned/zoomed). A simulated 8%/frame decay exits at
  frame ~64 - ~87% of the fixed budget never runs. Drag-reheats converge the same way.

Non-goals, unchanged: `update()`'s position-preserving merge (already good), the reheat-on-update
behavior, and any on-disk persistence for the (non-private) code graph - deferred until proven needed.

### Verified

9 new tests in `kg_ops.test.ts` (settleStart: static/nestle/cold/tiny-budget/empty; settleDone:
rest-threshold, still-moving, grace boundary, empty graph) - suite 1142 green (the 5 pre-existing
fs_browse Windows-host failures untouched). `make demo-P-PERF.3` proves: re-open = 0 sim frames; +4-node
refresh = 120-frame nestle; cold open exits at frame 64 (~87% saved); grace period holds; in-memory-only
contract stated. Typecheck clean (root + desktop); renderer bundle builds; license headers pass. Prompt
prefix untouched.

### Relates to

ADR-0129 (P-PERF.2 - the tier knobs this composes with: a reduced-tier re-open is now calm AND static),
ADR-0084 (the privacy boundary that keeps this cache off disk), B-KG.1/#114 (frameWork idle parking -
the loop still parks after the early exit), #54 (update()'s position-preserving merge, the same idea
applied across mounts). Follow-ups: P-PERF.4 (session index + paginated transcripts + AC-only prefetch),
P-PERF.5 (async settings write, optimistic model switch, build-once model picker).

## ADR-0131 - P-PERF.4: incremental session index, tail-first transcript pages, AC-only prefetch

**Date:** 2026-07-03
**Status:** Accepted - BUILT + tested. NO version bump.
**Increment:** P-PERF.4.

### Context

The battery investigation's biggest I/O stall: `sessions.ts listSessions()` re-read and re-parsed EVERY
session `.jsonl` under `~/.omp/agent/sessions/` on EVERY call - and the sidebar polls it (15s base) -
so a long history cost megabytes of synchronous main-process reads per poll. `sessionMessages()` shipped
the WHOLE transcript over the wire and into the DOM on resume, unbounded for a long chat. The ADR-0084
SWR cache hid the PAINT latency but never reduced the backend I/O.

### Decision

- **Incremental index (`sessions.ts`).** A module-level `sessionIndex: Map<path, {mtimeMs, size, scwd,
  meta}>`. `listSessions` stat()s each file and re-parses ONLY on an mtime/size change (append-only
  .jsonl always changes both); empty/probe verdicts (`meta: null`) are cached too, so they aren't
  re-parsed every poll just to be skipped again. Entries for deleted files are pruned per scan, scoped
  to the scanned root (other roots - tests - untouched). The cache is cwd-agnostic (scwd stored, cwd
  filtered at query time) so workspace switches don't invalidate it. Test seams `__sessionIndexStats` /
  `__resetSessionIndex` (the swr_cache `__resetCache` precedent). A warm poll is now O(stat).
- **Tail-first transcript pages.** `sessionMessages(id, limit=0, root?)` returns `TranscriptPage
  { messages, total }` - the LAST `limit` messages (0 = all: export/audit paths unchanged in behavior).
  Threaded through `GET /api/session?id&limit` (dev.ts) and `bridge.sessionMessages(id, limit?)`, which
  tolerates an older server's bare array (the pre-1b wrap precedent). `app.ts resumeSession` requests
  `RESUME_TAIL = 400` - matching the ADR-0084 cache cap - and when `total > messages.length` prepends an
  honest `.thread-tail-note` ("Showing the last N of M") instead of truncating silently.
- **AC-only prefetch warm.** After a session-list refresh, `warmTranscripts` (once per run) fills the
  SWR transcript cache for the 5 most-recent uncached sessions - so even a FIRST click paints instantly -
  but ONLY at perf tier `full` (ADR-0129): prefetch is anti-battery by definition. It runs via
  `requestIdleCallback` (setTimeout fallback), fetches sequentially, and aborts mid-warm if the machine
  unplugs (tier re-checked per iteration).

Contract note: `sessionMessages`'s return type changed shape (array -> page) - a deliberate clean
cutover; all three consumers (dev.ts endpoint, bridge, resumeSession) migrated in this increment, no
compatibility alias left behind.

### Verified

5 new tests (`sessions_index.test.ts`: warm poll parses nothing / appended file re-parses only itself
with fresh results, deleted-file pruning scoped per root, cached skip verdicts, tail page + true total,
unknown-id empty page) - suite 1147 green (the 5 pre-existing fs_browse Windows-host failures untouched,
sidecar pytest green). `make demo-P-PERF.4`: 30-session corpus - cold scan 30 parses, 10 polls add zero,
one appended turn costs exactly 1 re-parse (fresh turn count shown), tail page last-6-of-20, AC/battery
prefetch gate proven via resolveTier. Typecheck clean (root + desktop); renderer bundle builds; license
headers pass. Prompt prefix untouched.

### Relates to

ADR-0084 (P-PERF.1 - the renderer SWR cache this feeds and bounds), ADR-0129 (P-PERF.2 - the tier gate
the prefetch reuses), ADR-0079/0076 (ingest-session grouping the parser preserves). Follow-up:
P-PERF.5 (async settings write, optimistic model switch, build-once model picker) - the last item from
the battery investigation.

## ADR-0132 - P-PERF.5: switch-path hygiene (optimistic model switch, write-behind lastModel, memoized load + picker)

**Date:** 2026-07-03
**Status:** Accepted - BUILT + tested. NO version bump.
**Increment:** P-PERF.5. Closes the battery-investigation epic (ADR-0129/0130/0131).

### Context

Switching models/modules felt stuck on a battery-throttled laptop: `applyConfig` AWAITED the omp
`session/set_config_option` round-trip before painting the new model name (a busy backend held the badge
hostage); `setLastModel` did a synchronous read-parse-write-chmod on EVERY model report from omp (the
P-LOC.1 `syncModelEnv` hook fires repeatedly); `settings_store.load()` re-read + re-parsed the file on
every call from nearly every request handler; and the model picker re-sorted + re-rendered 100-200 rows
on every open and keystroke.

### Decision

- **Optimistic switch (`app.ts applyConfig`).** Paint the switch immediately (config value, badge,
  status, composer tools) and fire the round-trip in the background; on success adopt the server's
  config array (source of truth), on failure KEEP the optimistic value (the prior semantic) but warn
  honestly ("the backend didn't acknowledge") instead of failing silently. Toasts (incl. the ADR-0109
  Fable privacy notice) now appear instantly.
- **Write-behind lastModel (`settings_store.ts`).** `setLastModel` defers the write 250ms via a
  generation token (no stored timer handle); a burst of flips coalesces to ONE write of the final pick.
  `lastModel()` is read-your-writes (serves the pending value); `flushPendingSettings()` (exported;
  used by the `process.on("exit")` hook and tests) makes flushing deterministic. ONLY this low-stakes,
  high-frequency setter is deferred - keys/MCP/scopes stay synchronous (losing a just-saved API key to
  a crash would be unacceptable; losing <=250ms of lastModel is not).
- **Memoized `load()`.** Parse memoized on the file's mtime AND size (two writes can share an mtime
  tick; a content change almost always changes byte length - the residual same-ms-same-size external
  blind spot is accepted: this process is the file's only writer). Callers receive `structuredClone`s,
  so today's read-modify-save pattern keeps exact semantics and a mutate-without-save bug can never
  poison other readers. stat-then-read replaces the existsSync/read TOCTOU pair. The path is resolved
  per call via `LUCID_GUI_SETTINGS_FILE` (test seam, immune to module-cache order; never set in prod).
- **Memoized picker (`app.ts`).** The built rows HTML is memoized on a key covering the curated list,
  selection, query, family-collapse state, and gov ordering - reopening the popover (the common
  flip-between-models flow) reuses the last build instead of re-rendering.

### Verified

6 new tests (`settings_perf.test.ts`: read-your-writes before flush + persisted after, burst coalescing
+ idempotent flush, blank guard, external-edit invalidation (which CAUGHT a real same-mtime-tick
staleness bug - fixed by adding size to the memo key), clone independence, missing-file behavior; no
wall-clock waits - flush is driven deterministically) - suite 1152 green; the remaining failures are the
5 pre-existing fs_browse Windows-host artifacts plus the known LUCID_ASKSAGE_DEBUG env leak on this
machine (test passes with the env unset; the variable comes from a developer-mode launch, not the repo).
`make demo-P-PERF.5`: burst -> zero writes -> one flush; 1000 memo-served loads; external-edit
invalidation; clone safety. Typecheck clean (root + desktop); renderer bundle builds; sidecar pytest
green; license headers pass. Prompt prefix untouched.

### Relates to

ADR-0129/0130/0131 (the battery epic this closes), ADR-0031/P-LOC.1 (syncModelEnv - the hot caller the
write-behind protects), ADR-0109 (the Fable notice that now fires instantly), P-IDE.1/1d (the family
picker the memo wraps).
## ADR-0133 - P-AGENT: Agent Builder - visual workflow canvas that compiles to gated LUCID agents (DESIGN)

**Date:** 2026-07-03
**Status:** Accepted. Design + kickoff decisions RESOLVED. **The core epic is COMPLETE: P-AGENT.1/.2/.3/.4/.5/.6
BUILT + tested, and P-AGENT.4-live wired end-to-end (in-app "Run ▸" button) + VERIFIED against a live Claude
model.** A Builder-authored agent can be authored on the canvas, compiled, quarantine-gated, RUN live inside
LUCID under the security gate + its tool allow-list (returned "Paris is the capital of France." on Haiku; the
allow-list extension hard-blocks disallowed tools, A/B proven), and exported portably. Remaining: streaming +
`agent_run_*` provenance events + egress registration (additive), and the deferred ADK adapters (ADR-A013). P-AGENT.1: Agent Spec + fail-closed DAG
validator + DuckDB store + migration 0010 + new contracts values. .2: workflow canvas (`agent_builder.ts` +
`file_store.ts` + `/api/agent` + `app.ts` wiring), verified live. .3: compiler `compiler.ts` `buildAgent(spec)
-> AgentBundle` (tail prompt + generated try/catch-wrapped BUSL-headered omp allow-list `-e` extension +
manifest; fail-closed + injection-safe; a test imports+runs the emitted extension). .4a: `runner.ts`
`materializeBundle` + `composeBuiltAgentArgs` (gate-ALWAYS-first argv). .5: `import_gate.ts` untrusted-spec
quarantine gate (keystone-#2 analogue: only a clean LOCAL spec auto-runs; imported/poisoned -> quarantined,
proven vs the real scanner). .6: `export.ts` portable, tamper-evident (SHA-256 digest) per-target export
(electron/web/cloud); deploy adapters + KMS signing are add-on. ADKs planned, not built (user's directive).
**Increment:** design ADR for the P-AGENT epic (P-AGENT.1 .. P-AGENT.7). Each phase below is its own future
session/increment with its own demo target; the frozen-contract touches (contracts.ts, a DuckDB migration,
the prompt prefix) each get their own ADR when built.

### Context

The user wants a **major new "Agent Builder" capability**: a visual **workflow canvas** on which the user
describes an agent, and **LUCID generates the agent's code for them** (they never hand-write it). The built
agents must:

1. **Run inside LUCID** through the same security-gated omp runtime, so they inherit LUCID's protections
   (fail-closed scanner gate, delimited/untrusted content, egress whitelist + credential vault, provenance).
2. Carry **all instructions needed to use LUCID's core features** when hosted inside LUCID.
3. For **enterprise**, be exportable from the **private add-on repo** (`lucidagentIDEaddon`) as a standalone
   **Electron app, web-hosted service, or cloud deployment**, and - as an enterprise-only extra - target the
   **Google Agent Development Kit (ADK)**, the **AWS Strands Agents SDK**, and the **Azure AI Foundry Agent
   Service (Microsoft Agent Framework)** for easy hosting. The ADK work is **planned only** in this ADR.
4. Bake in the **lessons learned** across this project (fail-closed, lazy-load heavy deps, try/catch-wrapped
   tool registration, delimited untrusted content, stable IDs, licensing headers, DuckDB migrations).

This ADR is the architecture + phased roadmap. It deliberately writes **no feature code** yet: a capability
this size violates "one increment per session" if built blind, and the user asked to plan the ADKs and hold.

### Decision - the architecture

Five layers, each mapping onto an EXISTING proven surface so we extend omp and reuse patterns (invariant #1):

**1. The Agent Spec (the single source of truth).** A canonical, versioned, validated JSON document that fully
describes an agent: identity/persona, model, the ordered **workflow** (nodes = steps: prompt / tool-call /
sub-agent / branch / loop / human-approval; edges = control+data flow), the **tool allow-list** (only tools
the agent may call), egress needs (whitelist entries it requests), and memory scope. The canvas edits it; the
compiler reads it; nothing else is authoritative. Validated with the omp-injected TypeBox (same shim the tools
use) so an invalid spec is rejected fail-closed. Every spec + node + edge has a stable `*_id` (invariant #9).
The spec is **untrusted data** when imported from outside and is scanned before use (invariant #5).

**2. The Canvas (visual workflow editor).** A new right-edge surface `#agentBuilder` (rail glyph + panel),
built exactly like the KG canvas: reuse the hand-rolled zero-dep SVG graph in `desktop/renderer/graph.ts`
(`mountGraph` / `GraphHandle`) and the node/side-panel/resizer patterns from the KG panel, plus the
mutual-exclusivity rule (opening it closes Settings/KG/Preview/IDE). Nodes are workflow steps; the side panel
edits the selected node; drag creates edges. No new dependency. New pure builder `desktop/renderer/
agent_builder.ts` (HTML/markup, testable without a browser, like `about.ts`), new `/api/agent/*` routes on the
bridge. The canvas serializes to / hydrates from the Agent Spec.

**3. The Compiler (spec -> generated agent code).** A pure function `buildAgent(spec) -> AgentBundle` that emits
a self-contained bundle following the FROZEN TEMPLATES already in the repo:
   - a system prompt assembled through `harness/prompt/assembler.ts` (frozen prefix layers 1-4 unchanged; the
     agent's persona/skills/workflow go in the volatile TAIL - invariant #6, no prefix churn);
   - one or more omp `-e` extensions in the **exact `codegraph_extension.ts` shape** - a try/catch-wrapped
     `export default function ext(pi){ pi.registerTool({name,label,description,approval,parameters:T.Object(..),
     execute}) }` so a broken generated tool is simply ABSENT and never blocks the runtime (fail-soft, the
     lesson from the `symbol_graph` lazy-load hardening this same session);
   - the LUCID core-feature instructions (how to use the gate, preview, egress vault, codegraph_query) as
     generated prompt/policy text;
   - the BUSL-1.1 SPDX header on every emitted first-party file (the pre-commit hook + CI check enforce it).
The compiler is where "lessons learned" are codified once and stamped into every agent it produces.

**4. The In-LUCID Runtime.** A built agent runs through the SAME `desktop/acp_backend.ts` -> `omp acp` path as
chat, with the **mandatory fail-closed security gate loaded first** (`harness/omp/security_extension.ts`) and
its tool allow-list + egress whitelist applied. The autonomous multi-step case reuses the **goal loop**
(`Backend.runGoal`, `desktop/goal_memory.ts`, `desktop/loop_report.ts`) - it is already "run a built agent to
a condition, gated, with an After-Action Report." A built agent is thus a saved spec + its compiled bundle +
a Run action; every tool call is scanned, every egress gated, every step a provenance event. No new trust path.

**5. Persistence.** A new numbered DuckDB migration `harness/memory/migrations/0010_agent_specs.sql` (never edit
in place - invariant #10) storing specs + build/run lineage, reusing omp Snowflake ids where available.

**Enterprise export (public core writes a portable bundle; the add-on deploys it).** The public core's job ends
at emitting a **portable, signed AgentBundle** (spec + generated code + LUCID-core instructions + manifest).
The `lucidagentIDEaddon` private repo owns the **deploy targets**: Electron packaging, web hosting, and cloud
deployment, plus the ADK adapters below. This mirrors the existing public/add-on split (ADR-0068/0069/A012:
public ships schema + enforcement; the add-on ships the enterprise connectors). Export is entitlement-gated
through the existing managed-config path.

### The ADK plan (enterprise, add-on repo, PLANNED - no work yet)

Deferred to a future **add-on ADR (ADR-A013)**. The AgentBundle is the neutral intermediate representation; each
adapter lowers it to a vendor SDK. Three targets, each an enterprise "easy hosting" option:

| Target | SDK / service | Lowering sketch | Hosting |
|--------|---------------|-----------------|---------|
| Google | **Agent Development Kit (ADK)** (open-source, Python/Java) | spec workflow -> ADK agents/tools; LUCID tools -> ADK `FunctionTool` | Vertex AI Agent Engine / Cloud Run |
| AWS | **Strands Agents SDK** (model-driven) | spec -> Strands `Agent` + `@tool` fns; allow-list -> tool registry | Lambda / Fargate / EKS / Bedrock AgentCore |
| Azure | **Azure AI Foundry Agent Service** (Microsoft Agent Framework, the Semantic-Kernel + AutoGen successor) | spec -> Foundry agent + tool definitions | Azure AI Foundry / Container Apps |

Each adapter must preserve the LUCID invariants it can (tool allow-list, egress whitelist, delimited untrusted
content) and clearly LABEL which host-side protections are outside LUCID's fail-closed gate once the agent runs
off-platform. This honesty note is a hard requirement, not a footnote. Scope, feasibility, and the
protection-parity matrix are the first deliverable of ADR-A013; nothing is built until then.

### Lessons-learned the generator codifies into every agent

Fail-closed on any missing scan; heavy/optional deps lazy-loaded so a missing dep degrades one feature not the
engine (the `symbol_graph` fix this session, ADR from packaging incident); tool registration try/catch-wrapped
(broken tool = absent, never a crash); untrusted content always delimited and late; stable `*_id`s; BUSL-1.1
headers; DuckDB via numbered migrations; no em dashes in UI copy; never widen a managed-policy ceiling.

### Invariants preserved

#1 extend-omp (canvas + `-e` extensions + hooks, no fork); #3 fail-closed (invalid spec / failed scan / dead
sidecar -> block, never run); #4 in-process gate (built agents run under the same live `pre` hook); #5 untrusted
specs delimited + scanned before use; #6 frozen prefix (agent content lives in the tail; no PREFIX_VERSION bump
unless a layer 1-4 change is truly needed, then its own ADR); #7/#8 any new TrustLabel is disallowed (closed
set) and new EventNames (e.g. `agent_spec_saved`, `agent_built`, `agent_run_started`, `agent_run_gated`) land in
`contracts.ts` as their own frozen-contract increment; #9 stable ids; #10 DuckDB migration `0010`, additive only.

### Phased roadmap (each = one increment + `make demo-*` + PROGRESS 3 lines)

- **P-AGENT.1** - Agent Spec contract + TypeBox validator + `0010_agent_specs.sql` + new EventNames. Demo:
  round-trip a valid spec through save/load; a malformed spec is rejected fail-closed.
- **P-AGENT.2** - Canvas UI (rail + `#agentBuilder` panel + `agent_builder.ts` builder + `mountGraph` reuse +
  `/api/agent/*`). Demo: build a 3-node workflow on the canvas and serialize it to a valid spec.
- **P-AGENT.3** - Compiler `buildAgent(spec) -> AgentBundle` emitting header-carrying, try/catch-wrapped omp
  extensions + tail-only prompt. Demo: compile a spec; the emitted extension typechecks + passes the license check.
- **P-AGENT.4** - In-LUCID run through omp + the fail-closed gate (Run action, provenance events, goal-loop reuse
  for autonomous agents). Demo: run a built agent end-to-end; the gate blocks an injected malicious step.
- **P-AGENT.5** - Untrusted-spec safety: scan + a promotion-style gate so an imported/suspicious spec can never
  auto-run (keystone #2 analogue). Demo: a spec from an untrusted source is quarantined, not executed.
- **P-AGENT.6** - Enterprise export: emit a portable, signed AgentBundle + target manifest (Electron/web/cloud),
  entitlement-gated; the add-on consumes it. Demo: export a bundle whose structure matches each target contract.
- **P-AGENT.7** (add-on, ADR-A013, DEFERRED) - Google ADK / AWS Strands / Azure Foundry adapters. Planned only.

### Kickoff decisions (resolved 2026-07-03, confirmed with the user)

1. **Workflow model: v1 = DAG only** (nodes + directed acyclic edges). The validator rejects cycles fail-closed.
   Branch/loop nodes are a later P-AGENT increment, added once the spine is proven.
2. **Trust identity: new values in `contracts.ts`** - a dedicated `AgentMode` (e.g. `built-agent`) and a dedicated
   `ExecutionProfile` so built agents are distinctly labeled in provenance/audit. Frozen-contract change =
   folded into P-AGENT.1 as its own contract touch (its own ADR note).
3. **Self-modification (spec self-editing at runtime): POLICY-GATED, split by tier.**
   - **Enterprise: OFF by default, controlled via managed policy** on the add-on's policy-management surfaces
     (`lucidagentIDEaddon`). Reuse the `clampToManaged` ceiling (ADR-0068): managed config can deny self-edit;
     tighten-only, never widened by the user.
   - **Individuals: ON (easier adoption, fewer functional breaks) but SANDBOXED:** self-edits + first runs
     execute in **audit mode / non-destructive dry-run** first (reuse the Goal Loop preflight + exec-gate dry-run
     posture); a **lessons-learned feedback loop** writes outcomes to memory + `.md` files (mirror
     `goal_memory.ts` + the After-Action Report); **secrets** flow through the OS-encrypted credential vault
     (ADR-0107) and the builder **always tells the user where + how secrets are stored and advises on safety** -
     never silent.
4. **Bundle signing:** scheme deferred to P-AGENT.6; not blocking P-AGENT.1.

### Cross-cutting Builder principles (user directive, apply across the whole epic)

- **Don't assume user expertise.** The Builder **lints, tests, and uses TDD** when generating agents - it emits
  tests and runs them (reuse the repo's test + preflight patterns), never just dumps code.
- **Offer authoritative docs.** When a choice depends on an external SDK/API, the Builder **asks whether the user
  wants LUCID to search official developer docs**, then **recommends an easy-to-understand course of action**.
- **Safety-first secrets UX** (see 3 above): disclose storage location + method and advise on safety every time.
- **Reuse Goal Loop engineering** for autonomous / self-editing runs: preflight, budget, stall detection, AAR.

These sharpen the roadmap: **P-AGENT.1** now explicitly ships the new `AgentMode`/`ExecutionProfile` values, a
`selfEdit` policy field on the spec (default on for individual, clampable off by managed config), and the
DAG-only (cycle-rejecting) validator. **P-AGENT.4/.5** add the audit-mode dry-run + the lessons-learned feedback
loop before any destructive self-edit runs.

### Relates to

ADR-0096 (omp `-e` tool-extension pattern - the generated-agent template), ADR-0128 (`codegraph_extension.ts`,
the exact try/catch-wrapped `registerTool` shape reused), ADR-0046 (the goal loop = the autonomous run harness),
ADR-0106/0107 (network whitelist + credential vault = built-agent egress), ADR-0068/0069/A012 (public-core vs
private-add-on split for the enterprise surface), the same-session `symbol_graph` lazy-load hardening (the
lazy-heavy-dep + fail-soft lesson the compiler stamps in). Future: ADR-A013 (the ADK adapters).

## ADR-0134 - P-AGENT.8: Conversational Agent Builder - chat drafts a secure agent, then hands off to the canvas (DESIGN + P-AGENT.8.1 BUILT)

**Date:** 2026-07-03
**Status:** Accepted. **FEATURE-COMPLETE + verified live against Opus.** P-AGENT.8.1 (secret guardrail) + .8.2
(chat->canvas handoff `agent_builder_open`) + .8.3 (`AGENT_BUILDER_POLICY`, frozen-prefix v7->v8) + .8.4
(Secrets & connections panel) + .8.5 (Approve connection -> whitelist `upsertEntry`, "How do I get this?"
doc-assist) + .8.6 (the `/agent` command that starts the interview) all BUILT + tested. Verified live: typing a
build request (or `/agent`) makes the agent interview the user, draft a spec, call `agent_builder_open`; the
canvas opens pre-populated; the Secrets & connections panel adds credentials to the vault (agent never sees
values), approves connections into the whitelist, and doc-assists token setup. Detection keys on the unique
`specJson` arg (omp renders a custom tool's TITLE as a summary, not the name). Optional future: tighten the
policy to invoke sooner; per-entry auth binding; the site-login->screen-capture->ingest collab.
**Increment:** P-AGENT.8.1 .. P-AGENT.8.6. Extends ADR-0133 (the Agent Builder). PREFIX_VERSION bump for .3 is
its own increment.

### Context

The user wants a SEAMLESS, guardrailed on-ramp: in a normal chat window, describe a goal ("search the internet
for DoD/DoW business-development opportunities, find who's applying, connect to my GovWin account, connect to
Salesforce…"), and LUCID (a) recognizes it's automatable, (b) explains how it would be built, (c) confirms the
spec, then (d) OPENS the Agent Builder pre-populated and builds the workflow - so the user never has to learn
the canvas. It must be GUARDRAILED so the user can't accidentally build something insecure. The load-bearing
rule (user's words): the agent must NEVER collect secret values. Credentials (GovWin password, a Salesforce API
token the user may not know how to generate) go in the OS-encrypted vault; the agent DECLARES which secrets it
needs and, where the user needs help, READS the official docs to walk them through generating a token - but the
token itself only ever lands in the vault.

### Decision - the flow + the guardrails

The chat agent, steered by a new **AGENT_BUILDER_POLICY**, recognizes an automatable request, explains the plan
in plain language, confirms specifics, and calls an **`agent_builder_open`** tool with a DRAFTED Agent Spec.
`acp_backend` detects that tool_call (the `preview_open` -> `previewOpenPath` -> `preview-available` pattern,
ADR-0096) and opens the Agent Builder canvas PRE-POPULATED with the draft; the user reviews/adjusts and
confirms. Secrets + egress are handled by dedicated UI, never by the agent collecting values.

**The security spine (grounded in the existing vault + whitelist):**
- **Secrets are DECLARATIONS, never values.** The Agent Spec gains `secrets: SecretRef[]` (`{ name, kind,
  purpose }`, kinds mirror `cred_vault.ts` AuthKind: jwt/oauth/saml/pem/apikey/basic). The value lives ONLY in
  the OS-encrypted vault (`storeCredential`, never crosses to the renderer); the runtime injects it. A SecretRef
  has NO value field - and the validator rejects a `secrets[]` entry that carries `value`/`secret`.
- **The secret GUARDRAIL (keystone).** `harness/agent/secret_guard.ts` `scanSpecForSecrets` inspects every
  free-text field (name/description/persona/node labels+prompts/secret purpose) for APPARENT secret VALUES
  (PEM keys, AWS/OpenAI-style/GitHub/Slack/Google key shapes, bearer tokens, `password/api_key = <value>`).
  `assertSecretFree` throws on any hit and is wired into `buildAgent` (compile), `saveSpecFile` + `saveSpec`
  (persist), and (transitively via compile) the run path - so a credential can NEVER be compiled, saved, or run
  inside an agent. Declared refs + env-var NAMES + prose stay clean (high-signal detectors, proven by tests).
- **Egress = declared + approved.** The spec's `egress[]` become PROPOSED `WhitelistEntry`s the user approves
  (existing `network_whitelist.ts` / `egress_policy.ts`); an entry's `auth?: AuthRef` points at a vault ref.
- **Doc-assisted setup.** When the user doesn't know how to make a token, the agent reads the vendor's OFFICIAL
  docs (web/RAG) and walks them through it - the resulting secret is pasted into the vault UI, not the chat.

### Phased roadmap

- **P-AGENT.8.1 (BUILT):** `SecretRef` in the spec + validator + `secret_guard.ts` (`scanSpecForSecrets` /
  `assertSecretFree`) wired into compile + both save paths. `make demo-P-AGENT.8.1`. 9 new tests; full suite
  1191 pass. This is the security FOUNDATION - everything below builds a secure spec that can't embed a secret.
- **P-AGENT.8.2:** the `agent_builder_open` omp tool (`harness/omp/agent_builder_extension.ts`) + `acp_backend`
  detection + the renderer opens the canvas pre-populated with the drafted spec (runs `assertSecretFree` +
  `validateSpec` first; a leaky/invalid draft is refused, never opened).
- **P-AGENT.8.3:** `AGENT_BUILDER_POLICY` in `assembler.ts` (the guardrail prompt: recognize automatable asks,
  explain, NEVER collect secret values - declare refs + point to the vault, declare egress for approval, read
  official docs for token setup, confirm before opening). PREFIX_VERSION 7 -> 8 + its own ADR note.
- **P-AGENT.8.4:** a "Secrets & connections" panel in the canvas - lists the spec's SecretRefs with "Add to
  vault" buttons (-> `cred_vault` via the existing IPC) + the egress domains to approve (-> whitelist).
- **P-AGENT.8.5:** doc-assisted API setup surfaced in the flow (read official docs -> step-by-step token guide).

### Invariants preserved

Secrets never leave the vault (the guardrail + the no-value SecretRef); #5 untrusted content (a drafted spec is
scanned - the import gate + the secret guard); #6 frozen prefix (the policy bump is its own increment w/ ADR);
the handoff reuses the proven `preview_open` tool_call detection (#1 extend-omp, no fork).

### Relates to

ADR-0133 (the Agent Builder this extends), ADR-0096 (the `preview_open` handoff pattern), ADR-0106/0107 (the
network whitelist + OS-encrypted credential vault this builds on), ADR-0114 (the ENGAGEMENT_POLICY pattern for a
new frozen policy block), the P-AGENT.5 import gate (the sibling untrusted-content guard).

## ADR-0135 - P-LOCAL: Local Providers - securely point LUCID at self-hosted / custom / VPN-routed LLMs

**Date:** 2026-07-04
**Status:** Accepted. **P-LOCAL.1 (foundation) + P-LOCAL.2 core BUILT + verified live.** Pure core
(`desktop/local_providers.ts`) + vault-backed persistence (`settings_store.ts`) + 20 unit tests +
`make demo-P-LOCAL.1`. The omp delivery mechanism is RESOLVED + verified against omp 16.0.8: the registry is
`~/.omp/agent/models.yml` (an open provider needs `auth:"none"`; `api` = `openai-completions`), and secrets
are delivered securely by **env-var reference** (`toOmpRuntimeOverlay` writes the env-var NAME in models.yml;
omp's `resolveConfigValue` reads it from the child env, which LUCID injects from the vault - the secret never
touches the file). Live: an overlay with an open Ollama + a bearer DGX-over-VPN provider made `omp models` list
BOTH. **P-LOCAL.2 delivery WIRED + verified:** `local_providers_runtime.ts` (safe models.yml merge + vault→child
env + egress) is called from `main.ts` at dev-server spawn (the omp acp runs in the dev child, but the vault is
main-only, so MAIN resolves secrets and injects them into the child env; models.yml holds only env-var refs).
Integrated live proof: the real materializer wrote `~/.omp/agent/models.yml` and `omp models` with the injected
env listed both providers. Remaining .2 = a runtime apply/restart trigger (a provider added after launch takes
effect on restart); .3 = the Settings UI.
**Increment:** P-LOCAL.1 .. P-LOCAL.3 (this ADR covers the epic; each phase is its own session/demo).

### Context

The user wants to run **privately hosted / custom LLMs** from inside LUCID: Ollama, llama.cpp, vLLM, LM Studio,
or a box reachable only over a **VPN tunnel** (e.g. a NVIDIA DGX Spark in a Vienna, VA office behind a SonicWall
VPN). It must be **easy and secure**: multiple servers + models, the API token/OAuth stored the most secure way,
and it must work "regardless of the model." A new **default-collapsed "Local Providers"** subsection sits under
Settings → Providers.

**Feasibility (verified against the installed omp 16.0.8 / `@oh-my-pi/pi-ai`):** omp already has first-class
**Ollama + any-OpenAI-compatible** provider support. Its `models.json` / `--config` overlay accepts a
`providers` map keyed by provider id, each carrying `baseUrl`, `apiKey`, `api`, `headers`, `compat`, and a
`models[]` list (fields `id/name/reasoning/input/cost/contextWindow/maxTokens`). So LUCID does **no inference of
its own** - it captures the declaration + secret, emits the overlay, and registers egress. Custom models then
appear in the existing picker automatically.

### Decision - the architecture (reuse LUCID's proven surfaces; extend omp, don't fork)

- **A Local Provider is a DECLARATION, never a secret** (`LocalProviderDef`: id, name, `ompProvider` slug,
  `baseUrl`, `api`, `authKind` none|bearer|apikey|basic, `zone` internal|external, `models[]`, `vaultRef`). The
  API key/token lives ONLY in the **OS-encrypted vault** (`cred_vault.ts`, safeStorage/DPAPI) - strictly better
  than the status-quo plaintext `lucid-gui.json` that frontier keys still use. The def carries an **opaque
  `vaultRef`**, never the value; the settings file never holds a secret (proven by a test + the demo).
- **Fail-closed validation** (`validateLocalProvider`): non-http(s) base URL, bad slug, zero models, duplicate
  model ids rejected; a provider id that would **shadow a built-in vendor** (anthropic/openai/…) is refused so a
  local box can never hijack real-vendor routing. `scanForInlineSecret` refuses a def where a key was pasted
  into a name/URL/model field (mirrors the ADR-0134 Agent Builder secret guardrail).
- **omp overlay emitter** (`toOmpConfigOverlay`): emits the exact `{ providers: { <id>: {...} } }` shape for the
  ENABLED, runnable providers; the secret is injected by the MAIN process from the vault at spawn time. A
  provider whose required secret is **absent is SKIPPED, never emitted half-authenticated** (fail-closed).
- **Egress** (`egressProposal`): the endpoint host becomes a whitelist proposal (domain or IP, honoring
  internal/external zone) with an `AuthRef → vaultRef`. The existing whitelist already matches internal IPs and
  CIDR - exactly what a LAN/VPN endpoint needs.
- **VPN posture (route-to-tunnel, user-chosen):** the OS VPN client (SonicWall NetExtender / Mobile Connect)
  brings up the tunnel; LUCID **routes to the tunnel endpoint** (internal DNS/IP:port), stores the key in the
  vault, and (P-LOCAL.2/.3) adds a reachability/TLS health check. LUCID does NOT manage the VPN client itself -
  smaller attack surface, keeps the tunnel under the enterprise's audited client.

### Phased roadmap

- **P-LOCAL.1 (BUILT):** pure core `local_providers.ts` (types, validation, overlay emitter, egress proposal,
  inline-secret guard) + `settings_store` CRUD (`listLocalProviders`/`upsertLocalProvider`/`remove`/`setEnabled`).
  17 tests + demo. No frozen-contract touch.
- **P-LOCAL.2:** materialize the overlay for `omp acp` at spawn (`acp_backend`/`dev.ts`): decrypt the vault
  secret in MAIN, deliver via a transient 0600 main-only overlay (or child env for known ids), pass `--config`;
  auto-register the endpoint in the whitelist with an `AuthRef`. Live-verify a custom model routes to a local
  OpenAI-compatible endpoint (and that `omp models --config` lists it).
- **P-LOCAL.3 (BUILT):** the default-collapsed "Local Providers" card under Settings → Providers -
  `desktop/renderer/local_providers_ui.ts` (`localProvidersCardBody`/`draftFromForm`/`providerStatus`) + app.ts
  wiring (`hydrateLocalProviders`/`addLocalProviderFromForm`/delete/enable) + `/api/local-providers` CRUD in
  dev.ts + bridge methods. Add a provider from the form; an authed provider's key is stored to the vault
  (`bridge.credStore`) and the def saved with only the `vaultRef`. 8 tests. Verified live: the card renders
  after "Providers", auto-collapsed, expands on click. Remaining polish: inline edit/re-key, a reachability/TLS
  "test connection", an external-zone toggle, and an apply-without-restart trigger.

### Invariants preserved

#3 fail-closed (missing-secret providers are dropped, never run open); secrets never leave the OS vault and never
reach the renderer (invariant carried from ADR-0107); #1 extend-omp-not-fork (omp's own custom-provider overlay);
the whitelist + vault are reused, not reinvented. No app version bump; no EventName/contract change in .1.

### Relates to

ADR-0106/0107 (network whitelist + OS-encrypted credential vault reused here), ADR-0007 (AskSage's custom
base-URL provider - the closest prior art), ADR-0134 (the secret-guardrail ethos `scanForInlineSecret` mirrors),
ADR-0029 (the model-picker gating a custom model flows through).

## ADR-0136 - P-VISION.1: paste / drop images into the composer (multimodal user prompts)

**Date:** 2026-07-04
**Status:** Accepted - **BUILT + verified live.** Pure `desktop/renderer/composer_attachments.ts` + composer
wiring + the send pipeline (renderer → `/api/chat` → `acp_backend.prompt` → ACP `session/prompt`). 11 unit
tests; full suite 1293 pass; tsc clean. First step of the broader multimodal/preview-review work (agent live
DOM review is P-PREVIEW.6; screenshot→RAG is deferred P-RAG.2).
**Increment:** P-VISION.1.

### Context

The user wants to paste a snipping-tool / desktop screenshot straight into the prompt bar, see a **mini
thumbnail just above the prompt bar**, add instructions, and send **only on Enter/Send** (no auto-push). Today
the composer is text-only: `/api/chat` takes `{ text }` → `session/prompt: [{type:text}]`. But omp's ACP
`session/prompt` already accepts `(text|image)[]` content (verified against `pi-ai` `ImageContent = {type:"image",
data:<base64>, mimeType}`; the agent's own `preview_screenshot` tool proves the image round-trip) - so only the
USER-input pipeline needed wiring.

### Decision

- **Attachments are validated image data URLs** (`composer_attachments.ts`, pure): `parseImageDataUrl` accepts
  only `image/(png|jpeg|webp|gif)` base64 (SVG excluded - script risk); `acceptAttachment` enforces
  count (≤6) + size (≤12 MB) fail-closed; `promptImageBlocks` → the `{type:"image",data,mimeType}` blocks omp
  wants. **No data URL is ever interpolated into HTML** - `thumbStripHtml` renders `<img>` shells and the
  caller sets `img.src` as a DOM PROPERTY (mirrors the existing `screenshotPreviewToChat` rule).
- **Staged, never auto-sent.** Pasted/dropped images land in `state.attachments` and render as thumbnails in a
  `#composerThumbs` strip above the prompt bar (each with a remove button). They travel only when the user
  hits Enter or Send; the thread message renders the images inline; the strip clears on send.
- **The pipeline carries content blocks.** `send()` computes `promptImageBlocks(state.attachments)` →
  `bridge.sendPrompt(text, onEvent, images)` → `/api/chat { text, images }` (defensively filtered) →
  `backend.prompt(text, emit, images)` → `session/prompt: [{type:text,text:body}, ...imageBlocks]`. All
  existing callers (goal loop) pass no images and are unchanged.

### Invariants preserved

No frozen-prefix change (the image blocks ride in the user-turn tail, like text); no new EventName; the XSS
rule (data URLs set as properties, strict data-URL regex) holds; existing text-only send path unchanged.
No app version bump.

### Relates to

ADR-0096 (the preview screenshot→image-content pattern this generalizes to user input), the agent
`preview_screenshot` tool (proves omp's image round-trip), P-PREVIEW.6 (agent live DOM review - next),
P-RAG.2 (screenshot→RAG ingest - deferred until RAG lands).
## ADR-0137 - P-AGENT.9: allow-list chip editor, live per-turn canvas collaboration, portable share/import with credential provisioning

**Date:** 2026-07-04
**Status:** Accepted - BUILT + tested. NO version bump.

**Context.** Three gaps after the P-AGENT.8 epic: (1) the tool allow-list had no management UI - the node
dropdown could ADD tools (auto-allow-list) but nothing could REMOVE one, so there was no way to block a tool
without deleting steps; (2) the chat->canvas handoff opened the Agent Builder once - during a collaborative
build the user couldn't watch the draft evolve; (3) the enterprise export (P-AGENT.6) targets deploy adapters,
not user-to-user sharing - and a shared agent said nothing about HOW its next user obtains the credentials it
declares.

**Decision.**
1. **Chips (renderer-only).** `toolChipsHtml` renders `spec.tools` as removable chips (in-use badge per
   tool-node reference) + an add-picker from `TOOL_CATALOG`. Removing a chip edits `spec.tools`; enforcement is
   unchanged - the compiled per-agent allow-list extension + the fail-closed gate already deny off-list calls,
   and the validator flags steps referencing a removed tool (nothing fails silently).
2. **Live collaboration.** `agent_builder_open` is now re-callable per turn: `openAgentBuilderWithSpec`
   detects `abOpen && same spec_id` and updates the canvas IN PLACE ("Draft updated" toast; Secrets flyout only
   re-surfaces when the draft GAINS secret/egress needs). AGENT_BUILDER_POLICY (frozen layer 3) grew three
   rules: re-open per changed turn + explain/recommend/ask, warn benefit/risk/mitigation for powerful grants
   (bash/eval/wildcard egress/write), and declare `provisioning` per SecretRef. Prefix-hash regression re-run
   green (the prefix stays byte-stable - content changed BY an increment, not per-request).
3. **Portable share/import.** New `harness/agent/portable.ts`: `.lucid-agent.json` = {format, version,
   exported_at, spec_digest (sha256 over canonical key-sorted JSON), setup_md, spec}. Export refuses invalid or
   secret-carrying specs (assertSecretFree); parse re-validates, digest-checks (tamper-evidence), re-scans.
   `SecretRef.provisioning` (spec.ts, additive+optional): {method: "user-input"|"jit-ticket", instructions,
   ticket:{system, template (string map), rationale}} - so an imported agent TELLS its user to paste a value
   into the OS-encrypted vault, or to request a Just-In-Time token from their KMS via IT ticketing (sample
   ServiceNow-style fields + rationale). Provisioning free text is scanned by secret_guard (a pasted value is a
   guardrail violation) AND included in `collectSpecText` (imported help-text is injection surface).
4. **Import trust is persistent.** Trust sidecar `<id>.trust.json` in file_store (spec stays pure/portable);
   `/api/agent/import` runs the P-AGENT.5 gate (scanner sidecar via lazy ScannerClient in dev.ts, fail-closed)
   and persists the label; `/api/agent/run` now loads the STORED label (imported-not-approved is refused);
   `/api/agent/trust` promotes untrusted/suspicious -> trusted after explicit review; QUARANTINED can never be
   approved from the UI. Renderer shows a trust banner with "Approve after review".

**Consequences.** A shared agent file carries workflow + credential NAMES + acquisition guidance, never
values; recipients re-scan on import and must approve before it runs. The chip editor makes the allow-list the
user-facing control surface it was designed to be. The catalog remains hand-curated (renderer constant) -
deriving it from the live omp instance stays future work.

## ADR-0138 - P-AGENT.10: n8n interop (export/import translator) + enterprise connector seam

**Date:** 2026-07-04
**Status:** Accepted - BUILT + tested. NO version bump.

**Context.** The n8n comparison (see PROGRESS 2026-07-04) surfaced two ownership asks: move a LUCID-built
workflow into a privately hosted n8n (maximize compatibility), and pull an n8n workflow into LUCID (own your
workflow). Also needed: a documented public/private seam for connector-class features, following the
established split (ADR-0068/0069/A012): public core ships complete features on portable artifacts; the
private add-on (`lucidagentIDEaddon`, sibling checkout) ships the connectors into private infrastructure.

**Decision.**
1. **Translator is public + pure** (`harness/agent/n8n.ts`). Export: manualTrigger + one node per LUCID step
   wired along spec edges; approval steps become REAL `n8n-nodes-base.wait` nodes (n8n genuinely halts -
   stronger than our v1 prompt-line approvals, closing that gap on the n8n side first); subagent ->
   `executeWorkflow` placeholder; prompt/tool -> `noOp` carrying instructions in node `notes`. A provenance
   stickyNote embeds setup guidance + the full portable `.lucid-agent` file in a ```lucid-agent fence - the
   ROUND-TRIP ANCHOR: re-importing the exported workflow restores the exact spec, digest-checked.
2. **Rejected: emitting `@n8n/n8n-nodes-langchain.agent` wiring.** It couples the export to n8n model
   credentials + fast-moving typeVersions; a scaffold of core nodes imports cleanly on any n8n and the human
   finishes the wiring with the sticky's guidance.
3. **Import maps honestly, never silently.** wait->approval, executeWorkflow->subagent, httpRequest->`read`
   tool + URL host harvested into egress, code/AI/unknown -> prompt steps carrying node intent + compacted
   parameters; node credentials -> SecretRef NAMES (kind guessed from cred type) with user-input provisioning;
   loop-back connections dropped (DAG invariant; native loops arrive with P-AGENT.11c); trigger nodes noted,
   not mapped (P-AGENT.14). Every mapping compromise lands in `notes[]` -> description + import toast.
4. **Both import formats, one gate.** `/api/agent/import` detects portable vs n8n JSON; EITHER path funnels
   through the P-AGENT.5 quarantine gate (scanner, fail-closed) + trust sidecar + human approval. Translation
   never widens trust.
5. **Enterprise seam** (`desktop/addon_seam.ts`): add-on root = env `LUCID_ADDON_DIR` else sibling
   `lucidagentIDEaddon` (the folder the user calls "LUCIDagentideadd-on" - the env override covers any
   rename). Connector contract: `connectors/<name>/src/cli.ts <verb> --file <artifact>` printing ONE JSON
   line {ok, detail, url?}. The seam only probes presence + dispatches child processes - add-on code is NEVER
   loaded into the engine process (isolation + licensing hygiene). Absent add-on => honest "not installed"
   note in the UI, never a fake success. The n8n PUSH connector (POST <instance>/api/v1/workflows,
   X-N8N-API-KEY) is add-on work, spec'd by this contract.

**Consequences.** `n8n ⇩` exports a file n8n imports as-is; `n8n ⇧` pushes when the add-on is present;
importing either share format stays review-gated. Fidelity is deliberately scaffold-grade in v1; the
round-trip anchor keeps LUCID<->LUCID lossless even when the file traveled through n8n.

## ADR-0139 - P-AGENT.11: the step-runner - enforced approvals, real sub-agents, then branching (DESIGN)

**Date:** 2026-07-04
**Status:** Accepted. **11a BUILT + tested** (same day, continued at user direction): `harness/agent/segments.ts`
(splitSegments + renderSegmentPrompt + the `SegmentedRun` keystone machine — the post-approval prompt does not
EXIST until approve()), segment orchestration + 30-min-TTL paused-run registry in desktop/agent_run.ts
(expired approval = refusal, fail-closed), `/api/agent/run` returns `paused`, `/api/agent/run/approve`
resolves, Run-flyout approval card. 10 keystone tests green. **11b BUILT + tested** (same day): subagent nodes
are boundaries too — `SegmentedRun` halts in "awaiting-subagent" and desktop/agent_run.ts runs the CHILD spec
via its own compiled bundle (child allow-list) under the child's STORED trust label (canAutoRun — a
non-trusted child refuses); `subagentGuard` fail-closes unset child / missing spec / cycle / depth >
SUBAGENT_MAX_DEPTH(3) / child-with-approvals (nested human halts refused, not parked); child output flows
into the parent's next segment prompt. Recursion covers grandchildren (guards re-run per level). **11c BUILT + tested** (same day): `branch`
node kind (spec v2) with labeled outgoing edges; the branch segment's prompt demands a terminal
`CHOICE: <option>` line; `parseBranchChoice` is strict (no parseable choice ⇒ the run FAILS with the
options named — the runner never guesses); `takeBranch` skips the not-taken subtree via reachability
(descendants of the branch minus those reachable from the chosen edge) — skipped approvals/subagents
never halt, join nodes and parallel chains are untouched; decisions land in the run trace.

**Context.** The v1 compiler lowers the DAG into a numbered system prompt; `approval` lowers to "pause for
human approval" PROSE and `subagent` to "run sub-agent <id>" prose (compiler.ts stepLine). A guarantee the
model can skip is not a guarantee. n8n's engine executes nodes discretely; we adopt the piece of that that
matters for security first.

**Decision (phased).**
- **11a - enforced approval halts.** Split topo order into SEGMENTS at approval boundaries. Run each segment
   as its own gated `omp -p` (existing runBuiltAgent mechanics), carry the prior segment's final text forward
   as context. At a boundary, STOP; surface an approval card in the canvas (who/what/segment output); only an
   explicit approve starts the next segment. Deny ends the run with a recorded reason. Keystone test: a
   workflow with an approval node NEVER emits post-approval output without the approve action - treat like
   the P4.3 promotion gate (stop-the-line on regression).
- **11b - real sub-agents.** `subagent` steps invoke `runBuiltAgent` on the CHILD spec: child's own compiled
   allow-list + stored trust label enforced (a non-trusted child refuses exactly like a top-level run); depth
   cap 3; cycle guard on the spec_id chain. Keystone test: child runs under ITS allow-list, not the parent's.
- **11c - branching.** New node kind `branch` + edge `label` ("yes"/"no"/custom). v1 semantics: the model
   running the branch segment picks the outgoing edge and must emit a machine-parseable choice line; the
   runner follows only that edge and records the rationale in the run trace. Deterministic expression
   predicates deferred until P-AGENT.13 traces exist to debug them. NODE_KINDS widens - spec_version bump
   bundled with P-AGENT.15's v2 (one migration, not two).

**Consequences.** Approvals become real security controls; the n8n export's wait-node mapping becomes
symmetric with LUCID behavior; the compiler keeps emitting the same prompt text as fallback for one-shot mode.

## ADR-0140 - P-AGENT.12: dynamic tool catalog - MCP servers + live omp discovery (DESIGN)

**Date:** 2026-07-04
**Status:** Accepted. **BUILT + tested** (same day). Naming VERIFIED against the pinned omp bundle: MCP tools
register as `mcp__<server>_<tool>` with the `<server>_` prefix de-duplicated — the catalog offers EXACTLY
those names so the compiled allow-list matches at tool_call time (a mismatch denies, fail-closed).
desktop/mcp_probe.ts speaks MCP JSON-RPC over streamable HTTP (initialize → initialized → tools/list,
mcp-session-id honored, SSE-framed bodies tolerated, bearer token from the server entry), 5-min cache,
tested against a LIVE in-process fixture server; legacy SSE-transport entries are skipped with an honest
note. `/api/agent/tools` serves the dynamic half; the renderer merges it with the static TOOL_CATALOG —
no MCP servers (or probe failure) degrades to exactly the built-in picker. Both pickers group
“MCP tools (third-party)” with per-tool provenance titles; AGENT_BUILDER_POLICY's risk bullet now names the
MCP server when warning (prefix regression re-run green). Live-omp tool enumeration remains future work.

**Context.** TOOL_CATALOG is a hand-curated 17-entry renderer constant (ADR-0137 stub). n8n's moat is 1,500
integrations; ours is MCP - the user's configured MCP servers (settings_store `listMcpServers`) already carry
exactly the integrations they chose, and omp exposes their tools at runtime.

**Decision.** New `/api/agent/tools`: static catalog ∪ enabled MCP server tools (namespaced
`mcp:<server>:<tool>`, described from the server's tool listing) ∪ omp-registered tool names when a session
is live. Renderer picker groups by source with a provenance chip (built-in vs MCP); MCP tools carry a
risk note (third-party surface) in the picker AND in the chat agent's risk-warning policy. The compiled
allow-list extension already string-matches names, so namespaced entries enforce unchanged. Fail-soft: no
MCP servers => exactly today's static catalog.

**Consequences.** The Builder's integration surface scales with the user's MCP config; no bespoke connector
treadmill; the catalog stub in ADR-0137 closes.

## ADR-0141 - P-AGENT.13: per-run execution trace in the canvas (DESIGN)

**Date:** 2026-07-04
**Status:** Accepted. **BUILT + tested** (same day) with one recorded DELTA from the sketch below: the desktop
engine holds agent_obs.duckdb READ-ONLY (omp's gate child is the single writer — the same constraint that
put authored specs in workspace files, ADR-0133), so v1 traces are FILES under `.omp/agent-runs/traces/
<run_id>.json` (`harness/agent/trace.ts`: fail-soft TraceRecorder — recording never breaks a run; snippet
truncation; corrupted files skipped; path-safe ids). DuckDB ingestion + EventName wiring move to the future
gate-child pipeline increment. Instrumented: one-shot runs, segments, approval decisions, sub-agent hops
(child runs get their OWN trace, linked by run id + lineage); the run's stable run_id doubles as the
approval-resume handle (invariant #9). Canvas: Runs flyout → trace list → per-step detail. Node-highlighting
on the canvas from a selected trace stays future polish.

**Context.** n8n shows every execution with per-node I/O; our Run panel returns final text only, while the
harness already owns lineage (runs/lineage.ts), replay (runs/replay.ts) and the agent_obs DuckDB.

**Decision.** agent_run.ts parses the gated child's event stream (gate stderr lines + omp output) into step
records {run_id, spec_id, node_id?, tool, started_at, finished_at, blocked, reason} written via a NEW numbered
migration (invariant #10) to agent_obs. Attribution v1 maps tool calls to tool-kind steps by allow-list name
(prompt steps get segment-level attribution until P-AGENT.11 segments exist - ordering noted). Canvas: a Runs
flyout lists recent runs; selecting one highlights nodes with per-step status + a detail panel. Any new event
names extend the EventName enum in contracts.ts - frozen-contract change, done as its own micro-increment
within the build (invariant #8, exact names only).

**Consequences.** "Click a node, see what it did" - and P-AGENT.11's approval cards get their audit surface
for free.

## ADR-0142 - P-AGENT.14: triggers - scheduled runs first, gated webhooks second (DESIGN)

**Date:** 2026-07-04
**Status:** Accepted. **Phase 1 (scheduled runs) BUILT + tested** (same day): automations grew kind
"agent" {agentSpecId, agentPrompt, agentModel} — created DISARMED like every automation; the pure
`agentAutomationGate` is the fail-closed pre-flight (missing spec or ANY non-trusted label ⇒ the schedule
SUSPENDS itself; approval checkpoints ⇒ the tick refuses but stays armed — unattended runs can't answer
approval cards); the run goes through the SAME startAgentRun pipeline (gate first, allow-list, stored
trust, P-AGENT.13 trace) and lastResult carries the outcome + run id. Builder grew a Schedule flyout
that mirrors the gate's refusals at authoring time. Phase 2 (token-gated webhooks) remains DESIGN.

**Context.** Built agents only run from the Run panel. n8n's trigger surface (cron/webhook/events) is the
feature gap users feel daily; LUCID already ships an automations engine (desktop/automations.ts, cadence
normalization + scheduling).

**Decision.** Phase 1: an automation kind "agent-run" {spec_id, prompt, model, cadence} - the scheduler calls
`runBuiltAgent` with the STORED trust label; only `trusted` specs are schedulable (an imported spec must be
approved first; a label downgrade suspends the schedule - fail-closed). Results land in the P-AGENT.13 trace
+ a notification. Phase 2: webhook trigger via dev.ts `POST /api/agent/hook/<spec_id>`: DISABLED by default,
per-spec random token minted on enable, request body enters the run as UNTRUSTED delimited content (invariant
#5), managed ceiling can force webhooks off org-wide. n8n-import then maps trigger nodes instead of dropping
them to notes.

**Consequences.** "Repeatable" finally means unattended - without widening trust: nothing non-trusted ever
runs unattended, and webhook payloads are data, never instructions.

## ADR-0143 - P-AGENT.15: spec v2 - retry, timeout, and on-error edges (DESIGN)

**Date:** 2026-07-04
**Status:** Accepted. **PARTIALLY BUILT** (same day, with 11c's spec v2 bump as planned): `node.retry`
{max≤3, backoffMs} + `node.timeoutMs` (bounded, fail-closed validation; node-editor inputs) lowered to
SEGMENT policy — retry budget = MAX of the segment's nodes, timeout = MIN (tightest step constrains the
spawn), linear backoff capped at 10s, every attempt traced. spec_version 2 accepted alongside 1 (v1
files stay valid forever; validation is field-driven). `edge.kind: onError` REMAINS DESIGN — additive
optional fields need no further version bump when it lands.

**Context.** One spawnSync + 120s hard timeout is the whole reliability story; n8n has retry-on-fail, error
workflows, DLQ patterns.

**Decision.** spec_version 2 (single bump shared with P-AGENT.11c's `branch` kind): optional
`node.retry {max<=3, backoffMs}`, `node.timeoutMs` (runner-clamped), `edge.kind: "then"|"onError"` (an
onError edge routes a step's failure to a handler subgraph; no handler => run fails with the recorded error,
never silent). Loader upgrades v1 files in place (validate v1 -> rewrite v2) - the frozen-schema rule applies
to DuckDB, not workspace JSON, but the upgrade is still one-way + logged. Validator: closed sets, clamps,
onError edges may not form cycles with retry. Compiler lowers fields to runner policy; one-shot mode ignores
them (documented).

**Consequences.** Failure handling becomes reviewable workflow structure - visible on the canvas and in the
n8n export - instead of prose hopes.

## ADR-0144 - P-AGENT.16: external secret providers via the add-on (DESIGN - ENTERPRISE)

**Date:** 2026-07-04
**Status:** Accepted. **CORE WIRING BUILT + tested** (post-#200/#201 merge; the private connector shipped as
add-on ADR-A014/TASK-019): `SecretProvisioning.provider {kind, ref}` (closed kinds vault/aws-sm/azure-kv/
gcp-sm/infisical; the ref's scheme MUST match the kind, fail-closed; refs are scanned by secret_guard — a
pasted VALUE is a guardrail violation — and by the import gate). Pure `harness/agent/kms.ts` builds the
ADR-A014 request artifact; `resolveProviderSecrets` (agent_run.ts) dispatches `kms fetch` through the
add-on seam, reads the 0600 env file, and DELETES both artifacts immediately (inject-then-drop; values
live only in process memory + the child run env). Wired into one-shot, segmented, and sub-agent paths —
a CHILD fetches under its OWN declarations, never the parent's. FAIL-CLOSED on a failed or lying fetch
attempt (missing values ⇒ refusal, no partial credential set); HONEST SKIP when no refs are declared or
no connector is installed (today's vault flow). Trace kind "secrets" records fetch outcomes (never
values). Managed-config “require provider-sourced secrets” remains design.

**Context.** P-AGENT.9 ships JIT *guidance* (ticket templates); n8n enterprise fetches from Vault/ASM/AKV/GCP
at runtime. The add-on already has a kms/vault connector tree (lucidagentIDEaddon/connectors/kms).

**Decision.** Public core: `SecretProvisioning` gains optional `provider {kind: "vault"|"aws-sm"|"azure-kv"|
"gcp-sm"|"infisical", ref}` (validated closed set; guidance fields unchanged). At run start, when a declared
secret has a provider AND the kms connector is installed (addon_seam contract, verb `fetch`), the value is
injected into the CHILD omp process env for that run only - never persisted, never in the spec, never echoed
to chat (secret_guard already scans provisioning text; fetched values never touch a scanned surface). No
connector => today's vault flow with the provisioning guidance. Managed config can REQUIRE provider-sourced
secrets (forbid local vault) for org policy.

**Consequences.** JIT tokens stop transiting humans where org infrastructure allows it; parity with n8n
enterprise external secrets; the private/public split stays: capability descriptor public, provider code IP.

## ADR-0145 - P-AGENT.17: spec revision history + template gallery (DESIGN)

**Date:** 2026-07-04
**Status:** Accepted. **BUILT + tested** (same day). History: saveSpecFile snapshots
`.omp/agents/history/<id>/<updated_at>.json` (identical re-saves overwrite; pruned to the newest 20;
snapshot failure never fails the save), listSpecHistory/loadSpecRevision (corrupted ⇒ skipped/null),
restore = re-save-as-current with a fresh updated_at (itself snapshotted — undoable); trust sidecar
untouched by restores. Gallery: `templates/agents/*.lucid-agent.json` (2 starters: web-research-digest
w/ approval checkpoint + retry, repo-issue-triage w/ branch + timeout — they demo the v2 features);
only digest-valid files list; "Use" mints a FRESH spec_id and routes through the STANDARD gated import
(scanner + trust + review — curated ≠ exempt), factored as dev.ts `gatedAgentImport` shared with
share/n8n imports. A CI-time test re-validates every shipped template (rot fails loud). Community
submissions still deferred until signing (ADR-A012).

**Decision.** (a) History: `saveSpecFile` also writes `.omp/agents/history/<spec_id>/<updated_at>.json`,
pruned to the newest 20; endpoints list/read/restore (restore = save-as-current with fresh updated_at, itself
versioned); canvas History flyout with restore + a name/step-count diff summary. Trust sidecar is NOT
versioned - trust applies to the spec identity, and a restore of an untrusted import stays untrusted.
(b) Gallery: a curated `templates/` of `.lucid-agent.json` files in-repo, listed in the Builder; "Use
template" routes through the STANDARD import path (scan + trust: local curated files still get scanned -
cheap consistency, no special path). Community submissions deferred until signing lands (ADR-A012 KMS).

**Consequences.** Undo-across-sessions for authored agents; a first-run experience that starts from working,
reviewed examples; zero new trust paths.

## ADR-0146 - P-CMD.1: user-authored "/" slash commands - describe it in chat, LUCID interviews, saves, gates

**Date:** 2026-07-04
**Status:** Accepted - BUILT + tested (authored across sessions; landed + numbered here).

**Context.** Users wanted their own "/" shortcuts ("make a /pr command that reviews the diff", "save this as
a skill I can call") without editing files. The Agent Builder epic already proved the pattern: a frozen
policy steers the chat agent, a custom omp tool hands the draft to LUCID, and LUCID re-validates
authoritatively, fail-closed.

**Decision.**
1. **UserCommand** (`harness/commands/spec.ts`, pure): a named PROMPT TEMPLATE with two modes - "send"
   (`/name args` expands `body` with $ARGS/$1..$9/$$ and sends it as the turn) and "skill" (activates the
   body as a persistent per-session instruction, same path as a bundled skill). The NAME is the stable id
   (invariant #9) AND the filename: `^[a-z][a-z0-9-]{0,31}$`, reserved tokens (agent/goal/help/…) refused,
   body ≤ 8000 chars. `validateUserCommand` is fail-closed on unknown input.
2. **Store** (`harness/commands/file_store.ts`): `.omp/commands/<name>.json`, charset-guarded filenames (no
   traversal), validate-on-save AND re-validate-on-load; corrupted files skipped, never returned.
3. **Three gates before a command exists** (`desktop/user_commands.ts`): validator → secret guard (a
   credential VALUE in a body is refused and pointed at the vault - same detectors as the Agent Builder
   guardrail) → the Python Unicode scanner (fail-closed: scan unavailable = rejected, the P-AGENT.5 seam).
   Metadata-only telemetry: EventName gains `command_created`/`command_rejected` (frozen contracts.ts
   change - acknowledged as part of THIS increment; names only, never bodies).
4. **Chat authoring loop**: frozen `SLASH_COMMAND_POLICY` (layer 3; PREFIX_VERSION 8→9 - prefix-hash
   regression green) + the `slash_command_create` omp tool (`harness/omp/slash_command_extension.ts`,
   validates + acknowledges; acp_backend detects via the unique `commandJson` arg and persists through the
   gates) + `/command` interview kickoff + "/" autocomplete ranking user commands first.

**Numbering note.** This work was authored referencing ADR-0135 before two upstream PRs (#197 local
providers, #199 vision) and this branch's Agent Builder ADRs consumed 0135-0145; every reference was
renumbered to ADR-0146 when landing. ADR numbers are minted at MERGE time from origin/master's tip - the
lesson recorded so the next parallel session avoids the same collision.

**Consequences.** Users mint personal automation vocabulary conversationally; nothing enters the "/" menu
without passing the same fail-closed content gates as imported agents; command JSONs are personal workspace
data (gitignored), never repo content.

## ADR-0147 - P-AGENTFW.1: Agent Firewall MCP - a fail-closed security proxy between LUCID and external ACP agent runtimes (hermes / openclaw)

**Date:** 2026-07-04
**Status:** Accepted. **P-AGENTFW.1 BUILT + tested** (the firewall core + registry + `lucid agent-firewall`
launcher subcommand + `remoteAgentMcpServers()` registration seam). Desktop Settings UI to add/edit
connections is the follow-up P-AGENTFW.2 (not built this increment).
**Increment:** P-AGENTFW.1. New surface (a first-party MCP server + a harness-side ACP client), not a refinement.

### Context

The user wants LUCID to connect to remote instances of **hermes** (NousResearch/hermes-agent, a Python ACP
runtime: `hermes acp`) and **openclaw** (openclaw/openclaw, a TS gateway-backed ACP bridge:
`openclaw acp --url wss://gateway`). Both are full coding-agent runtimes exposed over the **Agent Client
Protocol** (JSON-RPC over stdio) with a vast tool surface (terminal/exec, file writes, `execute_code`,
`delegate_task`, browser, vision). Talking to such an agent directly would splice its entire attack surface -
prompt-injection in its streamed output, exfiltration of anything we send it, its `session/request_permission`
asks - straight into LUCID's context. The ask: mediate the connection through **an MCP that acts as a firewall**,
bidirectional, leveraging LUCID's existing security stack (the Unicode scanner + fail-closed gate, trust labels,
quarantine, UNTRUSTED_CONTENT delimiting).

### Decision - the architecture

```
LUCID (omp) ──MCP (stdio)──▶ [ Agent Firewall ] ──ACP client (stdio)──▶ remote hermes / openclaw
                              scan ⇄ gate ⇄ label
```

1. **The firewall is a first-party MCP *server*, stdio transport.** omp spawns it as a subprocess and speaks
   MCP (`initialize` / `tools/list` / `tools/call`) over line-delimited JSON-RPC - the SAME wire we already
   hand-roll for ACP (`desktop/acp.ts`), so no MCP SDK dependency (air-gap clean). Stdio is chosen because ACP's
   `McpServer` union makes **stdio mandatory** ("All Agents MUST support this transport") while http/sse are
   capability-gated; stdio also means **no localhost port, no bearer, no HTTP server** - the smallest surface.
   Registered via the ACP `session/new.mcpServers` array as an `McpServerStdio` (`{name, command, args, env}`).
2. **The remote side is a harness ACP *client*** (`harness/mcp/acp_client.ts`, the proven `desktop/acp.ts`
   pattern copied into the harness so the core does not import the desktop shell). It spawns the configured
   remote command (`hermes acp` / `openclaw acp --url … --token-file …`), runs the ACP handshake with
   **least privilege** (`clientCapabilities.fs.read/write = false` - we never offer the remote our filesystem),
   and drives `session/new` -> `session/prompt`, collecting `agent_message_chunk` text from `session/update`.
3. **Exposed tool: `prompt`** (`{ prompt: string }`). One firewall process serves ONE connection (spawned
   `lucid agent-firewall --conn <id>`); omp namespaces the tool by server name, so a plain `prompt` is
   unambiguous. `session/new` is lazy + reused for conversation continuity.

### The bidirectional gate (the "firewall")

Both directions run through the existing fail-closed `scanAndDecide` (keystone #1) over the same Python scanner
sidecar, **fail-closed by law** (invariant #3): any scan failure => BLOCK, never "safe".

- **Outbound (LUCID -> remote), injection-relay direction.** Before a prompt is forwarded, it is scanned with
  the strict `DEFAULT_POLICY`. A hidden-vector payload (bidi / zero-width / homoglyph / PUA) that LUCID was
  coerced into relaying is **blocked and never sent** - so the firewall can't be turned into a relay for
  hidden-Unicode injection aimed at the remote. NOTE: `scanAndDecide` is the pure Unicode scanner, so this is
  NOT secret/PII DLP - a plaintext exfil instruction sails through (LUCID has no secret detector today).
  Outbound DLP, if wanted, is a separate capability + increment.
- **Inbound (remote -> LUCID), prompt-injection direction.** The assembled remote response is scanned. A
  quarantine verdict **withholds the response entirely** (an `isError` result carrying only a redacted reason -
  the poison never reaches LUCID's model). A clean/suspicious response is **wrapped in
  `UNTRUSTED_CONTENT_START/END` and trust-labeled** (`untrusted`, or `suspicious` for sub-threshold findings) so
  the model can only ever read it as delimited data, in the tool-result tail, never as instructions (invariant
  #5). Trust is **never** `trusted`.
- **Remote permission requests denied by default.** If the remote agent sends `session/request_permission`
  (asking our client to approve one of ITS privileged actions), the firewall **denies** (fail-closed) - LUCID
  is not a confused deputy for the remote's exec. Surfacing these for user approval is a follow-up.
- **Delimiter-injection breakout closed.** The remote is the adversary by design, so before wrapping, the
  firewall neutralizes any literal `UNTRUSTED_CONTENT_START/END` inside the remote's text/tool-activity
  (`neutralizeDelimiters`) - otherwise a hostile agent could embed the closing token to escape the envelope
  and have trailing bytes read as instructions. The Unicode scanner would NOT catch that ASCII token, so this
  is a distinct, required step. (`wrapRetrieved` in the RAG path shares this gap on less-adversarial input -
  fold `neutralizeDelimiters` in when P-MCP-GATE.1 / the RAG hardening lands.)
- **Egress:** deliberately NOT re-gated here. The remote endpoint is an explicitly user/admin-configured
  connection (like a P-MCP.1 server URL), not the agent autonomously reaching the internet; `egress_policy`
  governs the latter and is unchanged.

### Load-bearing finding - ADR-0020's MCP-output guardrail is UNIMPLEMENTED (flagged, not inherited)

ADR-0020 (L1677-1680) asserts that "any [MCP] tool result that re-enters the prompt passes the existing
fail-closed gate and is wrapped in `UNTRUSTED_CONTENT_START/END`." **This is not true in code today:**
`security_extension.ts`'s `tool_result` hook only does LOC attribution + `<task-result>` promotion gating; it
does NOT `scanAndDecide` general MCP results nor delimit them. So **every** P-MCP.1 connector currently feeds
un-scanned external text into the prompt. This ADR does not silently inherit that false claim. Scope decision:
- **This increment CLOSES it for hermes/openclaw at the firewall boundary** - the firewall owns the text it
  returns, so it scans + quarantines + delimits its own output (the guardrail, actually implemented, for this
  path).
- **omp's in-process `tool_call` gate remains the load-bearing backstop** (invariant #4): even if a poisoned
  result slipped through, any action an injected model then attempts is a `tool_call` and is gated in-process.
- **The general fix - an in-process `tool_result` scan+delimit for ALL MCP servers - is recommended as its own
  follow-up increment (P-MCP-GATE.1),** because it touches the core gate (perf + false-positive tuning on large
  file-read results) and is a distinct concern from this proxy.

### Custody

The connection registry (`~/.omp/lucid-agents.json`) is written **mode 0600** (dir `~/.omp` 0700), matching the
P-MCP.1 baseline (ADR-0020 L1706). It stores command/args, NOT secrets: the recommended pattern is
`openclaw acp --token-file <path>` so the gateway token stays in the remote agent's own file and never lands in
our store. This is plaintext-at-0600 (like `lucid-gui.json` pre-P-MCP.2), not Electron `safeStorage`, because
the omp-spawned firewall subprocess cannot reach the Electron main-process oracle.

### Invariants preserved

#1 extend-omp (a custom MCP server + ACP client through the native `mcpServers` seam - no fork); #3 fail-closed
(every scan failure blocks, both directions; the firewall refuses to serve tool calls when the scanner is
unavailable); #4 the in-process omp gate is untouched and remains the backstop; #5 remote output is scanned +
delimited + late; #7 trust labels stay the closed set (`untrusted`/`suspicious`/`quarantined`, never
`trusted`). **No frozen-contract change:** reuses existing `EventName`s (`mcp_server_connected`,
`artifact_quarantined`, `tool_call_blocked`) - `contracts.ts` is untouched. **Landmine avoided:** omp treats a
stdio MCP server that exits after the handshake as a fork loop, so the firewall process stays long-lived.

### File-by-file (P-AGENTFW.1)

- `harness/mcp/registry.ts` (new) - `RemoteAgentEntry` + 0600 read/write of `~/.omp/lucid-agents.json` +
  `remoteAgentMcpServers(lucidBin)` (the enabled connections as ACP `McpServerStdio[]`).
- `harness/mcp/acp_client.ts` (new) - harness ACP client (initialize/session/new/prompt/cancel; deny
  permissions; collect message chunks).
- `harness/mcp/mcp_server.ts` (new) - a minimal, injectable-I/O MCP stdio JSON-RPC server (initialize /
  tools/list / tools/call).
- `harness/mcp/agent_firewall.ts` (new) - the orchestration: bidirectional `scanAndDecide`, quarantine, trust
  label + `UNTRUSTED_CONTENT` wrap, fail-closed, `runAgentFirewall(connId)`.
- `harness/launcher/lucid_acp.ts` (edit) - `lucid agent-firewall --conn <id>` subcommand (fail-closed scanner
  preflight, then serve).
- `desktop/settings_store.ts` (edit) - `mcpServersForAcp()` concats `remoteAgentMcpServers()` so an enabled
  connection attaches to the live desktop session.
- Tests + `make demo-P-AGENTFW.1` (real scanner + a fake remote ACP agent: clean -> delimited untrusted;
  poisoned -> quarantined + withheld; kill the sidecar -> fail-closed block).

### Phased roadmap

- **P-AGENTFW.1 (BUILT):** the firewall core + registry + launcher + registration seam (this ADR).
- **P-AGENTFW.2:** a "Remote agents" Settings section (add/edit/enable hermes/openclaw connections; mirrors the
  P-MCP.1 connectors card) so connecting needs no hand-edited JSON.
- **P-AGENTFW.3:** surface the remote's denied `session/request_permission` asks to the user (opt-in approval),
  and forward richer ACP updates (tool activity, diffs) as scanned, labeled evidence.
- **P-MCP-GATE.1 (recommended, separate):** the in-process `tool_result` scan+delimit for ALL MCP servers -
  closes the general ADR-0020 gap.

### Relates to

ADR-0020 (P-MCP.1 - the `mcpServers` seam this reuses, and the guardrail this partially implements + flags),
ADR-0038 (the `lucid` launcher this extends), ADR-0002 (the scanner IPC), ADR-0019 (the gate policy), the
P-RAG.1 `wrapRetrieved` pattern (UNTRUSTED_CONTENT delimiting), invariants #3/#4/#5.

## ADR-0148 - P-CMD.2: builtin /licensing walkthrough + "/" commands anywhere in the prompt body

**Date:** 2026-07-05
**Status:** Accepted - BUILT + tested.

**Context.** Two user asks: a guided command that applies their company's licensing across a codebase, and
"/" commands that work in the WHOLE composer body (P-CMD.1 only recognized a start-anchored token, and the
autocomplete only opened when the entire input was one "/" token).

**Decision.**
1. **Builtin commands** (`harness/commands/builtins.ts`): shipped commands in the SAME UserCommand shape as
   user-authored ones — same validator (tested), same expansion, same autocomplete; merged server-side by
   `withBuiltins` where a user-saved command SHADOWS a builtin by name and deleting it resurfaces the
   builtin. Builtins are code (PR-reviewed), so the workspace scanner path does not apply to them.
2. **/licensing** is the first builtin: a guided, APPROVAL-GATED walkthrough — discover the repo's existing
   convention + counts first, ONE interview round (owner, SPDX id or proprietary text, years, first-party vs
   vendored trees), show the exact per-language header plan, WAIT for approval, apply idempotently
   (SPDX-line skip, shebang/XML-decl aware, read-then-write per the AGENTS.md TOCTOU rule), finish with
   totals + optional CI check/pre-commit hook/LICENSE file. Vendored trees are excluded loudly — the
   command's body forbids relicensing vendor/, node_modules/, dist/, or third-party code.
3. **Body-wide expansion** (`expandInlineCommands`, pure): a token counts only when preceded by
   start/whitespace AND followed by end/whitespace/sentence punctuation — paths (`src/foo`, `/usr/bin`,
   `/licensing/docs`) and URLs never match. Only KNOWN names expand; send-mode bodies replace the token IN
   PLACE with no args (surrounding prose is the context); skill-mode tokens are stripped + activated
   (deduped); expansion is single-pass over the ORIGINAL text (an expanded body's own "/words" are never
   re-scanned — no recursion). START-anchored commands keep the P-CMD.1 args contract exactly, and when one
   fires the inline pass is skipped for that turn.
4. **Autocomplete at the caret** (`slashTokenBeforeCaret`, pure): the "/" menu opens for the token at the
   caret anywhere in the body; completion/activation replaces ONLY that token, preserving surrounding prose
   (previously applySlash clobbered the whole input).

**Also.** Cleared the two long-standing server-tsconfig strictness debts (netdiag.ts ×9 noUncheckedIndexedAccess,
dev.ts oauth-broker stdin narrowing ×2) — `bun run typecheck` is green across all three configs for the
first time; netdiag's behavior tests unchanged.

**Consequences.** "/licensing Apache-2.0 for Acme Corp" works from a fresh install with zero setup; prose
like "run /pr-review before merging" now does what it reads like; mentioning paths or unknown "/words"
remains inert. 13 new tests (builtin validity + shadowing, the expansion matrix incl. path/URL immunity and
non-recursion, caret tokenization).
## ADR-0149 - P-AGENTFW.2 + .3: Remote-agents Settings UI + per-connection permission policy & surfaced ACP updates

**Date:** 2026-07-04
**Status:** Accepted. **BUILT + tested.** The two agent-firewall follow-ups flagged in ADR-0147, delivered
together (same subsystem). Based on `feat/agent-firewall-mcp` (#201). (ADR-0152 is the sibling P-MCP-GATE.1
PR.)
**Increment:** P-AGENTFW.2 (desktop UI) + P-AGENTFW.3 (permission policy + richer surfaced updates).

### P-AGENTFW.2 - "Remote agents" Settings card

A Settings card mirroring the P-MCP.1 "MCP connectors" card, so connecting a hermes/openclaw instance needs
no hand-edited `~/.omp/lucid-agents.json`. `GET/POST /api/agents` + `/api/agents/remove` + `/api/agents/toggle`
in `dev.ts` call the harness registry (`listRemoteAgents`/`upsertRemoteAgent`/`removeRemoteAgent`/
`setRemoteAgentEnabled`); a change `backend.restart()`s omp so enabled connections attach as `agentfw-*` MCP
servers next session. `bridge.remoteAgent*` (renamed off `agent*` to avoid colliding with the Agent-Builder
`agentList`), `RemoteAgentStatus`, and a `secAgents()` card (name/kind, command+args, permission badge,
enable/remove + an add form: name, kind, command, args, permission policy). No secret crosses the wire - the
registry stores command/args only (the note steers users to `--token-file`).

### P-AGENTFW.3 - per-connection permission policy + surfaced permission asks

The firewall used to hard-deny every remote `session/request_permission` (fail-closed). Now:
- **`RemoteAgentEntry.permissionPolicy: "deny" | "allow"`** (default **deny**). The `AcpAgentClient` honors
  it: `deny` → the ask is answered `cancelled`; `allow` → an approve option is selected (`pickApproveOption`).
  "allow" is an explicit per-connection opt-in for a trusted remote (e.g. a local dev gateway).
- **Every permission ask is RECORDED and SURFACED** (`AcpPromptResult.permissionRequests`): the firewall
  includes a `[permission-requests]` section in the delimited output so the user/model sees what the remote
  wanted and the decision. **This content is remote-controlled** (the toolCall title), so it is added to the
  inbound `scanAndDecide` text and neutralized - a hidden vector in a permission-ask title is quarantined
  exactly like the reply body (regression-tested).
- **Richer updates:** the client now also notes `plan` updates alongside `tool_call`/`tool_call_update`, all
  carried in `toolActivity` (scanned + delimited).

**Deliberately deferred:** a TRUE interactive per-request approval prompt. The firewall runs as an
omp-spawned MCP subprocess with no channel to the desktop UI, so live "ask the user now" isn't possible
without a new IPC surface; the per-connection policy + the surfaced-in-output record are the bounded MVP.
That interactive path is the next follow-up if wanted.

### Invariants preserved

#3 fail-closed (permission default deny; permissionRequests are scanned; a poisoned title quarantines); #5
remote content (incl. permission titles) is scanned + delimited + labeled untrusted; #7 trust stays the
closed set. **No frozen-contract change** (no `contracts.ts`; `permissionRequests` is an optional field on the
internal `AcpPromptResult`). The desktop UI is cosmetic chrome over the existing 0600 registry.

### File-by-file

- `harness/mcp/registry.ts` - `permissionPolicy` on the entry + upsert.
- `harness/mcp/acp_client.ts` - `permissionPolicy` option, `permissionRequestSummary`/`pickApproveOption`
  (pure), policy-driven `#answer`, `permissionRequests` capture, `plan` update note.
- `harness/mcp/agent_firewall.ts` - pass the connection's policy to the client; include permissionRequests in
  the SCANNED combined text AND the wrapped output.
- `desktop/dev.ts` - `/api/agents` CRUD. `desktop/renderer/bridge.ts` - `remoteAgent*` + `RemoteAgentStatus`.
  `desktop/renderer/app.ts` - `secAgents` card + hydrate + handlers.
- Tests: `acp_client.test.ts` (helpers), `registry.test.ts` (+policy), `agent_firewall.test.ts` (+surfacing,
  +poisoned-title quarantine). Docs: `docs/AGENT-FIREWALL.md` updated.

### Relates to

ADR-0147 (the agent-firewall these extend), ADR-0152 (the sibling MCP-result gate), ADR-0020 (the P-MCP.1
connectors card this UI mirrors).
## ADR-0152 - P-MCP-GATE.1: in-process gate for MCP tool RESULTS (closing the ADR-0020 guardrail for every MCP server)

**Date:** 2026-07-04
**Status:** Accepted. **P-MCP-GATE.1 BUILT + tested.** Follows P-AGENTFW.1 (ADR-0147), which flagged this gap.
**Increment:** P-MCP-GATE.1. Modifies the security-gate surface (a NEW, separately-loaded extension; the
`security_extension.ts` keystone is left untouched).

### Context

ADR-0020 (L1677-1680) promised that "any [MCP] tool result that re-enters the prompt passes the existing
fail-closed gate (`scanAndDecide`) and is wrapped in `UNTRUSTED_CONTENT_START/END`." ADR-0147 discovered this
was **never implemented**: `security_extension.ts`'s `tool_result` hook only does LOC attribution +
`<task-result>` promotion gating. So **every** P-MCP.1 connector's OUTPUT re-entered the model's context
**unscanned** — a standing prompt-injection hole. P-AGENTFW.1 closed it only for the agent-firewall's own
output; this closes it for ALL MCP servers.

### Decision

A **new omp extension**, `harness/omp/mcp_result_gate.ts`, registered on the `tool_result` hook. omp's
`tool_result` handler may **replace** the result (`ToolResultEventResult`), and the hook runner captures the
last handler's return; `security_extension` returns nothing for `tool_result`, so this gate's result wins
regardless of load order. It is a separate `-e` extension so the over-tested keystone is not modified.

- **Source-scoped to MCP results only.** A result is gated iff it comes from an MCP server — `toolName`
  starts with `mcp__` OR `details.serverName` is set (omp's `mcp/tool-bridge.ts` naming). Local built-in
  tools (`read`/`bash`/`write`/`edit`/`grep`/`glob`) are **left untouched**: scanning a user's own file read
  is semantically wrong (not untrusted-external), a false-positive magnet (legit Unicode in source), and a
  per-result perf cost. This is the same source-scoping philosophy as ADR-0019.
- **Fail-closed (inv #3).** The result text is run through `scanAndDecide` (strict `DEFAULT_POLICY`, external
  content). Any scan failure ⇒ block. Quarantine ⇒ the result content is **replaced** with a redacted block
  notice + `isError: true` — the poison never reaches the model.
- **Delimited + labeled (inv #5).** A clean/suspicious MCP result is wrapped in `UNTRUSTED_CONTENT_START/END`
  with a `[mcp-server name=… trust=…]` header, trust-labeled `untrusted`/`suspicious` (**never `trusted`**);
  embedded delimiter literals are neutralized so a hostile server can't break out of the envelope. Image
  content blocks pass through after the wrapped text.

### Why a separate extension (not editing security_extension.ts)

`security_extension.ts` + its tests are a load-bearing keystone (AGENTS.md: a failing test there is
stop-the-line). Adding the result gate as an independent `-e` extension keeps that surface untouched, makes
the new behavior independently testable, and lets the runner's last-non-undefined-wins semantics compose the
two cleanly.

### Invariants preserved

#3 fail-closed (unscannable/quarantined MCP result ⇒ withheld); #4 the gate runs in-process in omp's runtime
(this IS the in-process seam ADR-0020 intended); #5 MCP output is scanned + delimited + trust-labeled; #7
trust stays the closed set (never `trusted`). **No frozen-contract change** (no `contracts.ts` edit; reuses
the scanner IPC + gate). The frozen prompt prefix is untouched (the extension adds no prefix bytes).

### File-by-file

- `harness/omp/mcp_result_gate.ts` (new) - the extension + its pure core (`isMcpToolResult`, `mcpServerName`,
  `neutralizeDelimiters`, `blockNotice`, `wrapUntrusted`).
- `harness/launcher/lucid_acp.ts` + `desktop/acp_backend.ts` (edit) - load the new `-e` extension alongside
  the gate (guarded by existsSync; safe if absent).
- Tests + `make demo-P-MCP-GATE.1`.

### Relates to

ADR-0020 (the guardrail this finally implements), ADR-0147 (the agent-firewall that flagged it; folding its
`neutralizeDelimiters` into a shared home is a possible later cleanup), ADR-0019 (source-scoped gating),
ADR-0002 (scanner IPC). Supersedes the "recommended P-MCP-GATE.1 follow-up" noted in ADR-0147.
## ADR-0150 - P-NVIM.1: Neovim & terminal integration for the gated agent (`lucid tui` + `lucid.nvim`)

**Status:** Accepted / Built.

### Context

The marketplace IDE story (ADR-0038) covers VS Code + JetBrains, both thin ACP clients of the fail-closed
`lucid acp` launcher. Neovim users - a large, tooling-loyal audience - had no first-party path: no editor
plugin, and no way to get the gate in a pure-terminal workflow. omp itself is a full terminal agent (`omp`
bare = interactive TUI) AND a conformant ACP v1 server, so the missing piece was a Lucid-owned, fail-closed
way to reach either from Neovim without ever exposing an ungated command.

### Decision

Add TWO integration paths, both anchored on the existing `lucid` launcher (extend, never fork; invariants
#3/#4 unchanged):

1. **`lucid tui` subcommand** (`harness/launcher/lucid_acp.ts`). Runs omp's native interactive terminal UI
   with the SAME fail-closed preflight and the SAME gated command as `lucid acp`, minus the `acp`
   subcommand (so omp owns the tty). `buildTuiArgs` mirrors `buildAcpArgs`: gate `-e` first (mandatory),
   the byte-identical `APPENDED_POLICY` (DELEGATION+BUILD, invariant #6), then user passthru args (initial
   prompt, --model, --continue, --resume, -p) appended verbatim last. `runTui` reuses `preflight` +
   `resolveScannerEnv` + `resolveOmp`; the spawn was factored into a shared `execGated` so `acp` and `tui`
   share ONE inherited-stdio launch path. Fail-closed identically: a dead scanner or missing gate returns 1
   and NEVER spawns omp. A Neovim user gets the whole gated agent with just `:terminal lucid tui`.

2. **First-party Neovim plugin** (`extensions/neovim/`, `lucid.nvim`). A thin, untrusted client exactly like
   the VS Code/JetBrains extensions: it only ever spawns the `lucid` launcher, resolved fail-closed
   (`_resolve_cmd` returns nil rather than any non-lucid fallback). It hosts `lucid tui` inside a Neovim
   terminal buffer rather than reimplementing an ACP chat UI - maximally robust, zero protocol risk, gate
   stays in `lucid`. Surface: `:Lucid`/`:LucidToggle`/`:LucidSend` (visual selection or current file as
   `@path`)/`:LucidCheck`, `:checkhealth lucid` (runs `lucid check`), default keymaps. Pure helpers
   (`_build_tui_args`, `_selection_text`, `_resolve_cmd`) carry the logic and are asserted headlessly.

3. **Documented ACP-client path** (`docs/NEOVIM.md`). For inline buffer chat, an existing Neovim ACP plugin
   (e.g. CodeCompanion.nvim) can point its ACP adapter at `lucid acp`. The security guarantee doesn't
   depend on the plugin: `lucid acp` self-verifies + fail-closes regardless of which client spawned it.

### Why terminal-first for the plugin (not a hand-rolled ACP UI)

omp's terminal UI already implements streaming, thinking blocks, tool rendering, Plan/Ask/Agent modes, and
tool-approval prompts - all behind the gate. Re-building that in Lua would be a large, fragile surface with
weak test coverage. Hosting the real, already-gated TUI is the YAGNI-correct choice; the ACP path (Path 3)
remains available for those who want tighter buffer integration and accept a third-party dependency.

### Language-boundary note

`extensions/neovim/` introduces Lua - but as EDITOR-CLIENT code under `extensions/` (like the VS Code TS and
JetBrains Kotlin clients), NOT harness code. Invariant #2 (the harness is TypeScript; the only Python is the
scanner sidecar) governs the *harness*; `extensions/` has always been a per-editor polyglot client tree
outside the license-header roots. No harness Lua, no second Python surface.

### Consequences

- `buildAcpArgs`/`runAcp` behavior is unchanged (the `execGated` refactor is behavior-preserving, proven by
  the existing launcher tests). `buildTuiArgs` carries a forward-compat optional `mcpResultGate?` param;
  nothing populates it on master (the extension + `assets().mcpResultGate` live in the unmerged
  P-MCP-GATE.1 PR #206) - thread it through `runTui` once that lands.
- New CLI surface: `lucid tui` (usage text updated). No new EventNames, no `contracts.ts` change, no schema
  change, prompt prefix untouched (the appended policy is byte-identical to `acp`).
- `bin/lucid` (the compiled launcher) predates `tui`; a fresh signed build ships it. Until then, dev/live
  use runs from source.

### Files

- `harness/launcher/lucid_acp.ts` - `BuildTuiOpts`/`buildTuiArgs`, `RunTuiOpts`/`runTui`, `execGated`, the
  `main` `tui` route + usage.
- `extensions/neovim/{lua/lucid/init.lua, lua/lucid/health.lua, plugin/lucid.lua, test/helpers_spec.lua,
  README.md}`.
- `docs/NEOVIM.md`.
- Tests: `harness/launcher/lucid_acp.test.ts` (tui cases), `harness/launcher/neovim_plugin.test.ts`
  (headless-nvim driver). Demo: `harness/scripts/demo_pnvim1.ts` + `make demo-P-NVIM.1`.

### Verification

Live (Neovim 0.12, omp 16.3.6): `lucid check` OK; `lucid tui --model claude-haiku-4-5 -p ...` returned a
gated real turn (exit 0); `lucid acp` initialize -> protocol v1, loadSession, auth agent. `bun test harness`
plus `make demo-P-NVIM.1` green; root `tsc --noEmit` clean.

### Relates to

ADR-0038 (the `lucid` launcher + untrusted-editor/trust-anchor model this extends), invariants #2/#3/#4/#6,
ADR-0152/P-MCP-GATE.1 (the MCP result-gate to thread into `lucid tui` post-merge, #206).

## ADR-0151 - P-NVIM.2: distribute lucid.nvim as a standalone branch WITHOUT leaving the monorepo

**Status:** Accepted / Built.

### Context

P-NVIM.1 (ADR-0150) landed the Neovim plugin under `extensions/neovim/`. lazy.nvim / LazyVim - the
dominant Neovim plugin managers - install a plugin from a git repo via an `owner/repo` short name, and
CANNOT install a subdirectory of a monorepo. So the plugin was only installable via a local `dir` path (a
full monorepo checkout), not as a normal standalone plugin. The ask: a standalone, short-name-installable
plugin whose source still lives in the main IDE repo (no separate project to maintain).

### Decision

Publish the plugin as a generated **`lucid.nvim` branch of THIS repo** - plugin files at the tree root,
produced by `git subtree split --prefix=extensions/neovim`. lazy.nvim's `branch` field installs it:

```lua
{ "mlcyclops/lucidagentide", name = "lucid.nvim", branch = "lucid.nvim", main = "lucid", ... }
```

- **Source of truth stays `extensions/neovim/` on master** - all dev happens there.
- **CI publishes it** (`.github/workflows/nvim-plugin-mirror.yml`): on every master push touching
  `extensions/neovim/**`, subtree-split -> force-push `refs/heads/lucid.nvim` (permissions: contents:write).
- **`make nvim-plugin-split`** does the same locally (dry-run by default; `PUSH=1` force-pushes).
- One repo, no fork, no second project. Installers do a shallow single-branch clone, so the plugin branch
  never drags the monorepo's history/size.

### Why a branch, not a second repo or a submodule

A mirror repo or submodule is a second project to create, permission, and keep in sync - the exact thing
the ask rules out. A same-repo generated branch keeps everything in one place; `git subtree split`
preserves the plugin's own file history at root, and lazy/packer/vim-plug all support a `branch`.

### LazyVim specifics (documented in docs/NEOVIM.md)

- `main = "lucid"` - with `opts`, lazy auto-runs `require(main).setup(opts)`; without it lazy infers the
  module from the repo name (`lucidagentide`) and setup never runs.
- `cmd`/`keys` are required, not optional - LazyVim defaults plugins to lazy-loaded.
- Visual-mode send maps the `:LucidSend<cr>` colon form (applies the `'<,'>` range); the `<cmd>` form would
  send the whole file instead of the selection. `<leader>l...` is avoided (LazyVim's `:Lazy`).

### Consequences

- New CI workflow with `contents: write` (scoped: only force-pushes `lucid.nvim`). A `neovim` job added to
  `extensions.yml` runs the headless helper spec alongside the VS Code / JetBrains jobs.
- `extensions/neovim/LICENSE` added so the standalone branch is self-contained (BUSL-1.1, pointing at the
  canonical root LICENSE).
- The `lucid.nvim` branch is GENERATED - never hand-edit it; edit `extensions/neovim/` and let CI (or
  `make nvim-plugin-split PUSH=1`) regenerate it. Until #207 merges to master, publish manually if needed.

### Files

- `.github/workflows/nvim-plugin-mirror.yml`, `.github/workflows/extensions.yml` (neovim job), `Makefile`
  (`nvim-plugin-split`), `extensions/neovim/LICENSE`, `docs/NEOVIM.md` + `extensions/neovim/README.md`
  (branch-install docs).

### Verification

`git subtree split --prefix=extensions/neovim HEAD` produces a branch whose ROOT is the plugin
(`README.md`, `lua/lucid/*`, `plugin/lucid.lua`, `test/`, `LICENSE`) - confirmed locally; `make
nvim-plugin-split` dry-run prints the split sha. lazy.nvim `branch` + short-name install confirmed against
the lazy.nvim docs (`/folke/lazy.nvim`).

### Relates to

ADR-0150 (P-NVIM.1, the plugin this distributes), ADR-0038 (the marketplace/extension distribution model).
## ADR-0153 - P-PREVIEW.6: the agent reviews its work live in the Preview panel (glow + testing pill; DOM review phased)

**Date:** 2026-07-04
**Status:** Accepted - **P-PREVIEW.6a + .6b + .6c BUILT + verified live (epic COMPLETE).** .6a = the
"reviewing/testing" indicator (panel glow + pill). .6b = the agent READS the live preview DOM
(`preview_inspect`) over a held relay + a read-only postMessage bridge. .6c = the agent CLICKS/TYPES
(`preview_click`/`preview_type`) by CSS selector through the same relay/bridge (fixed action allowlist; no
eval). All live-verified end to end (6c: a click fired a button's handler → the DOM actually changed;
`preview_type` set an input value).
**Increment:** P-PREVIEW.6a (indicator) → .6b (DOM inspect) → .6c (structured actions) - all BUILT.
**Also fixed here:** the `preview_screenshot` tool read `body?.png` while the endpoint wraps `{ok,data:{png}}`,
so the agent had never actually SEEN its screenshots - now reads `body.data.png` (the review-your-work loop
works).

### Context

The user wants the agent to **screenshot and manipulate the live preview DOM**, and to **visually notify the
user while it's testing** by glowing the Preview panel + showing a "testing" pill - so the user watches the
agent review its work live. Two capabilities and one signal. The agent already screenshots the preview
(`preview_screenshot`, ADR-0096). The hard part is DOM manipulation, because the preview iframe is
**opaque-origin sandboxed** (`sandbox="allow-scripts allow-forms"`, `connect-src 'none'`) - the renderer
CANNOT touch the iframe DOM directly. So live DOM work needs a **postMessage bridge** injected into the served
preview; that is its own increment. The VISIBLE signal (glow + pill), by contrast, is self-contained and
delivers the "review in front of the user" experience immediately on top of the tools that already exist.

### Decision - phased

- **P-PREVIEW.6a (BUILT): the live indicator.** Pure `desktop/preview_activity.ts` `previewActivityLabel(title)`
  maps a preview tool-call title (screenshot / open / inspect / a future action) to a user-facing label
  (matching omp's tool-name titles AND human-summarized ones), else null. `acp_backend` emits a new
  `preview-activity` ChatEvent in the tool_call block (visuals-only, never a gate); the renderer
  `flashPreviewTesting(label)` adds `.testing` to `#preview` (a pulsing glow on `.preview-body`) + shows the
  `#prevPill` pill, surfaces the panel if a loaded preview is hidden, debounces (fades ~4.5s after the last
  signal), and clears on turn `done`. No frozen-prefix/contract change beyond the additive ChatEvent variant.
- **P-PREVIEW.6b (BUILT): DOM inspect via a postMessage bridge.** `preview_bridge.ts` injects a READ-ONLY
  bridge into the served preview HTML (in `/api/preview/serve`; inline JS is CSP-allowed, `connect-src 'none'`
  keeps egress blocked). It answers `postMessage` queries from the LUCID renderer (page text, headings,
  controls, element details by CSS selector, captured console errors) and posts a compact/clipped snapshot
  back - NO arbitrary eval, NO mutation (proven by tests: no `eval`/`Function`/`.click`/`.value=`/`innerHTML=`).
  `preview_inspect_relay.ts` (`InspectRelay`, unit-tested) is the held command/result queue: the agent's
  `preview_inspect` tool GETs `LUCID_PREVIEW_INSPECT_URL`; the dev server HOLDS the request; the renderer polls
  `/api/preview/inspect/next` (every 450ms while the panel is open), runs the query on the frame via the
  bridge, and POSTs `/api/preview/inspect/result` - resolving the held tool call (8s fail-closed timeout →
  "open a preview first"). New READ-tiered `preview_inspect` tool. Verified live end to end.
- **P-PREVIEW.6c (BUILT): structured actions.** `preview_click` / `preview_type` (by CSS selector) go through
  the SAME relay + bridge — the `InspectCommand` gained `action`/`value`, the bridge routes `cmd.action ? act
  : inspect`, and `act()` is a FIXED allowlist (click / type / focus / scroll): it only calls `el.click()`,
  sets `el.value`/`textContent` + dispatches input/change, or scrolls — never `eval`/`Function`/`innerHTML`
  (proven by tests). New `/api/preview/act` endpoint + `LUCID_PREVIEW_ACT_URL`. Read-tier (the preview is
  sandboxed + egress-blocked, so acting on it is safe) and the `preview_click`/`preview_type` calls light the
  6a "Testing the preview" pill. Verified live: `preview_click` on a button fired its onclick (the page's h1
  changed), `preview_type` set an input's value.

### Invariants preserved

Fail-closed unaffected (the indicator is display-only); the preview sandbox is NOT loosened (6b/6c use a
postMessage bridge, keeping opaque-origin isolation); #1 extend-omp (new tools are omp `-e` tools like the
existing preview ones). No app version bump.

### Relates to

ADR-0096 (the preview panel, `preview_open` / `preview_screenshot`, the shot-cache the relay extends),
ADR-0126 (the markup canvas overlaying the same iframe), P-VISION.1/ADR-0136 (the sibling multimodal work),
the streaming-state UI patterns (`.streaming` / `data-streaming`) the indicator mirrors.

## ADR-0154 - P-DESIGN / P-FIGMA: honor DESIGN.md invariants + native Figma import/review (`/figma`)

**Date:** 2026-07-04
**Status:** Accepted. **FEATURE-COMPLETE — P-DESIGN.1 (DESIGN.md honoring) + P-FIGMA.1 (import + preview) +
P-FIGMA.2 (guided review + build/pop-out DESIGN.md) all BUILT + green.**
P-FIGMA.1 verified live: `/figma` opens the secure form and the import endpoint validates end to end (a bad
URL is refused in the form). The successful-fetch path is unit-tested (URL parse, frame collection, board HTML)
+ loads through the existing preview pipeline; a real end-to-end import needs the user's PAT + file.
P-FIGMA.2 (2026-07-04): after import, a guided next-steps card offers review / open-or-build DESIGN.md; the
agent authoring a DESIGN.md emits an additive `design-available` event (pure `isDesignDocPath`, no false
positives) that pops the doc out in the Monaco IDE (`/api/design` GET) for the user to review/edit — then
P-DESIGN.1 honors it every turn. Unit-tested + renderer bundles clean (same `Bun.build` the dev server runs);
a full click-through needs a real PAT + file (token-gated API + preview-harness flakiness on this host).
**Increment:** P-DESIGN.1 (honor) → P-FIGMA.1 (import) → P-FIGMA.2 (review + build/pop-out DESIGN.md). DONE.

### Context

The user wants (a) a project's **DESIGN.md** to be honored as design invariants, and (b) a single **`/figma`**
command to enter a Figma file + API key SECURELY, view it in the Preview panel, have the agent review the
design (preview + snapshot + DESIGN.md), recommend follow-ups, and - if there's no DESIGN.md - offer to build
one (popped out in the IDE for the user to review/edit) that future design work adheres to.

### Decision - the architecture (recommended defaults; user did not override)

- **DESIGN.md is standing design guidance (like CLAUDE.md is for coding).** `desktop/design_doc.ts`
  `designInvariantsBlock` wraps a workspace-root `DESIGN.md` into a `<design-invariants>` block; `acp_backend`
  reads it EACH turn (`readDesignInvariants(workspace)`) and passes it to `buildUserTurnPreamble` (a new
  `designInvariants` field) so it rides in the user-turn tail (never the frozen prefix - no cache bust) and is
  re-delivered every turn (never fades). It's the user's OWN file → trusted INSTRUCTIONS (the point is the agent
  obeys it), not untrusted-delimited data. Clipped to 12k chars; absent DESIGN.md → no block, fail-soft.
- **Figma auth = Personal Access Token → the OS-encrypted vault** (like Local Providers). PAT (not OAuth) for
  v1: simplest, air-gap-friendly, user controls scope/revocation. main reads it from the vault and passes it to
  the dev child (`LUCID_FIGMA_TOKEN`) so `api.figma.com` is called SERVER-side; the key never reaches the
  renderer or the agent.
- **"View in the preview" = rendered frame IMAGES, not a live embed.** The preview iframe is opaque-origin +
  `connect-src 'none'`, so a live figma.com embed can't load (and loosening that is a security regression).
  Instead: server-side call `GET /v1/files/:key` + `GET /v1/images/:key` (PNG renders), inline the images as
  data URLs into a generated `.omp/figma/<key>.html`, and load it via the EXISTING preview pipeline (serve +
  inline + the P-PREVIEW.6b bridge). The agent then reviews it with `preview_screenshot` + `preview_inspect`.
- **`/figma` guided flow** (P-FIGMA.2): a client-side command (like `/goal`/`/agent`) → a secure form (file URL
  + PAT → vault) → import → "review the design?" → the agent screenshots + inspects the preview + reads
  DESIGN.md → recommendations → if no DESIGN.md, offer to build one → `openIde({path:"DESIGN.md",…})` pops it
  out for the user to review/edit.

### Invariants preserved

#6 frozen prefix (DESIGN.md rides in the volatile tail, not the cached prefix); secrets never leave the OS
vault / reach the renderer (the Figma PAT is server-side only); the preview sandbox is NOT loosened (Figma is
rendered as inlined images through the existing egress-blocked pipeline); #1 extend-omp. No version bump.

### Relates to

ADR-0107 (the OS-encrypted vault reused for the Figma PAT), ADR-0135 (Local Providers - the vault-key →
server-side pattern this mirrors), ADR-0137/P-PREVIEW.6 (the preview review tools the Figma review reuses),
ADR-0096 (the preview pipeline the Figma board loads through), the `buildUserTurnPreamble` standing-guidance
pattern (persona/skill/profile) that DESIGN.md joins.
## ADR-0155 - P-NVIM.3: session metrics in Neovim (`lucid stats` + statusline + `:LucidStats`)

**Status:** Accepted / Built.

### Context

The GUI's Memory inspector shows session **spend**, **KV-cache hit %**, and **context-fill**. Neovim
users (P-NVIM.1/2) had the gated agent but not those numbers. The data already exists: `tools/
memory_data.ts` reads per-turn tokens + KV-cache + cost from the omp session `.jsonl` and exposes
`memorySnapshot()` (the web dashboard's JSON). The problem: `memory_data.ts` imports `@duckdb/node-api`
at the top level (for its harness / AI-LOC views), and `memorySnapshot()` also spawns `omp config list`
and opens DuckDB twice — far too heavy for a launcher subcommand an editor statusline polls.

### Decision

1. **Extract a DuckDB-free `tools/session_metrics.ts`** — the session-transcript pieces (`CTX_WINDOW`,
   `shortModelId`, `ctxWindow`, `Turn`, `Session`, `findSession`, `sessionPathById`, `parseSession`,
   `Budget`, `rateLimits`) plus a new `sessionStats()` (spend + cache{read,write,fresh,hit} + context
   current/peak/fill) and `formatStats()`. `memory_data.ts` now IMPORTS and RE-EXPORTS these, so it
   stays the single import surface for the TUI / web dashboard / desktop (single source of truth, no
   duplication). The launcher imports ONLY `session_metrics.ts` — no DuckDB in the `lucid` binary.
2. **`lucid stats [--json] [--budgets] [--session <id|path>]`** — session-only fast path (plain `.jsonl`
   reads, one optional sqlite read for budgets). `--json` for editors; default is a human summary.
3. **`lucid.nvim`** renders it two ways: **`:LucidStats`** (a float mirroring the Memory inspector) and
   **`require("lucid").statusline()`** (a cached `Lucid $x · cache y% · ctx z%`, refreshed by a light
   poll of `lucid stats --json` — the session-only fast path, so no DuckDB / no omp subprocess per tick).

### Why not memorySnapshot() for the poll

`memorySnapshot()` unconditionally runs `omp config list --json` (compaction) + opens DuckDB twice
(harness + AI-LOC) + a sqlite read. Everything the user asked for (spend + KV-cache + context) is in the
cheap session block alone. The statusline polls the fast path; the fuller snapshot stays in the GUI /
`memory:tui` / web dashboard.

### Consequences

- `memory_data.ts` no longer defines the session-transcript primitives (imports them); all existing
  consumers (memory_tui, web/data, desktop/dev, code_activity/usage_ledger tests) resolve via the
  re-exports — verified by tsc + the full harness suite (580 pass / 0 fail).
- New CLI surface `lucid stats`; no new EventNames / contracts / schema; prompt prefix untouched.
- The numbers are computed from the SAME session `.jsonl` fields the GUI reads, so Neovim and the GUI
  agree.

### Files

- `tools/session_metrics.ts` (new), `tools/memory_data.ts` (import + re-export), `harness/launcher/
  lucid_acp.ts` (`stats` subcommand), `extensions/neovim/lua/lucid/init.lua` (`_pct`/`_bar`/
  `_fmt_statusline`/`_fmt_stats_lines`, `statusline()`, `stats()`), `plugin/lucid.lua` (`:LucidStats`),
  `docs/NEOVIM.md` + `extensions/neovim/README.md` (metrics section).
- Tests: `harness/launcher/session_metrics.test.ts` (sessionStats/formatStats over a fixture .jsonl);
  the headless nvim spec gains `_pct`/`_bar`/`_fmt_statusline`/`_fmt_stats_lines` assertions.

### Verification

Live: `lucid stats` on a real session printed model / turns / `$15.5611` spend / `99%` cache hit /
`28%` context-fill / rate-limit budgets; `lucid stats --json --budgets` emits the matching payload. `bun
test harness` 580 pass / 4 skip / 0 fail; root `tsc --noEmit` clean; headless nvim helper spec green.

### Relates to

ADR-0150/0151 (the Neovim plugin this extends), ADR-0011 (the usage/cost ledger in memory_data), the
GUI Memory inspector (ADR-0036 developer view).

## ADR-0156 - P-NVIM.4: Neovim top-notch pass - gate block banner, context sparkline, three real bugs

**Status:** Accepted / Built.

### Context

A deliberate review of the Neovim integration (P-NVIM.1-3) against the GUI asked: what does the GUI show
that Neovim doesn't, what's missing in the `lucid tui` path, and is the implementation sound? Findings:
three real bugs, and two GUI features worth porting. (A third - the ADR-0011 all-time usage ledger - was
considered and explicitly descoped by the user; the statusline poll stays session-only.)

### Bugs fixed

1. **Neovim 0.10 compat:** the plugin used `jobstart({term=true})`, which is 0.11+, while the README
   promises >= 0.10. `start_term()` now feature-detects: `jobstart{term=true}` on 0.11+, `termopen()`
   on 0.10 (same semantics - both attach to the current buffer, which `spawn()` sets first).
2. **`:10,20LucidSend` sent the wrong text:** a cmdline range was read through the `'<`/`'>` marks,
   which are STALE outside a genuine visual invocation. `send_range` now distinguishes: marks matching
   the passed range = fresh visual (charwise-precise selection); anything else = the requested LINES.
3. **`statusline = false` crashed:** `statusline()` indexed `config.statusline.interval` on a boolean.
   Now returns "" without starting the poll; `refresh_status` hardened the same way.

### GUI parity added

- **Security block banner.** The gate's authoritative `[BLOCKED tool_call:<n>] ... severity=<s>
  findings=<f>` stderr line - the exact signal the GUI banner and ide_client.ts BLOCK_RE parse, pinned
  by `harness/launcher/ext_parity.json` - is now parsed from the Lucid terminal's output stream
  (`_parse_block_line`, all four parity cases asserted) and raised as a `vim.notify` ERROR. Delivery is
  PROVEN, not assumed: the headless spec runs a real PTY job that prints the parity line to STDERR and
  asserts `on_stdout` delivered it parseably (PTY merges stderr; `%S+` stops before the PTY's CR).
- **Context sparkline.** `SessionStats` gains `prompts: number[]` (per-turn context occupancy - the
  series the GUI/memory-TUI graph draws); `:LucidStats` renders it as a `history` sparkline row
  (`_sparkline`: downsampled, min-max scaled, flat/empty-safe).

### Files

- `extensions/neovim/lua/lucid/init.lua` - `start_term`, `scan_block_output`, `_parse_block_line`,
  `_sparkline`, `send_range` fix, `statusline`/`refresh_status` guards, float `history` row.
- `tools/session_metrics.ts` - `prompts` in `SessionStats`.
- Tests: `extensions/neovim/test/helpers_spec.lua` (+16 assertions: 4 ext_parity block cases, sparkline
  shapes, statusline=false, float history row, the PTY wiring proof);
  `harness/launcher/session_metrics.test.ts` (prompts); `harness/scripts/demo_pnvim1.ts` now also
  asserts the MCP result-gate is loaded (locks the parity fix).
- Docs: `docs/NEOVIM.md` + `extensions/neovim/README.md` (banner, sparkline, `statusline=false`,
  cmdline ranges, 0.10 fallback).

### Verification

Headless spec green (all assertions incl. the live-PTY wiring proof); `bun test harness` green; root
`tsc --noEmit` clean; `make demo-P-NVIM.1` green; live `lucid stats --json` carries the real 117-point
`prompts` series for the current session.

### Relates to

ADR-0150/0151/0155 (the Neovim integration this hardens), ADR-0038 (ext_parity block-line contract),
ADR-0152 (the MCP result-gate the demo now asserts).

-----

## ADR-0157 - P-SANDBOX: enforce the runtime execution boundary (mediated subprocess egress + real profile capabilities) (SCOPE/PLAN)

**Date:** 2026-07-05
**Status:** Accepted - SCOPE/PLAN. Phased build P-SANDBOX.1-.4 (one increment per session, CLAUDE.md ritual).
**Increment:** P-SANDBOX (epic). Foundation = P-SANDBOX.1.

### Context - the post-approval runtime blind spot

Every execution/network control we ship today acts on **text at the tool boundary, BEFORE a process is spawned**:
`classifyCommand` (ADR-0066, `desktop/exec_policy.ts`) tiers an *argv string*; `egressVerdict` /
`egressDecisionDetailed` (ADR-0062/0106/0108, `desktop/egress_policy.ts` + `network_whitelist.ts`) allow/deny a
*URL string* for the agent's own `browser`/`web`/`fetch` tools; the scanner keystone (`scanner-sidecar/`) flags
*malformed/hidden text*. All three are pre-spawn, text-layer gates. **Once `bash`/`eval` is approved and a
process is running, LUCID has zero runtime visibility into it** - no syscall, network, DNS, or child-process
monitoring anywhere in the tree.

A public reviewer (Thom E.) named the exact hole: a Python package whose `__init__.py`, at **import time**, does
`socket.gethostbyname()` on a TXT record, decodes the answer, and `exec()`s it - **in-process, after `execve`
returned success**. The command the agent ran (`python train.py`, or a `pip install`) is well-formed and benign
to any argv classifier. `exec_policy.ts`'s own header (lines 6-9) and ADR-0066 concede this is out of scope for
the classifier ("does NOT catch a perfectly well-formed command"; "we do NOT attempt behavior analysis"). He is
right that this is a **harness/execution-layer** gap, not something measuring agent trajectories can catch.

Compounding it: `harness/runs/profiles.ts` **declares** `PROFILE_CAPS.canNetwork` / `canExec` per profile
(`container-local` + `quarantine` = `canNetwork:false`), and `chooseProfile` auto-downgrades a suspicious causal
chain to a network-off profile - but **no runtime code reads `canNetwork` to actually cut network.** It is policy
metadata consumed only by demos/tests. omp's `--isolate` (ADR-0028) is **filesystem** containment (fuse-overlay /
ProjFS) only - no network namespace, no seccomp. So even the "downgrade to a safer profile" path grants no real
network isolation, and DNS is not modeled anywhere in the codebase.

**This ADR makes the declared execution boundary real, while keeping LUCID usable for everyday agent work.**

### Non-goals / what this is NOT

- NOT a replacement for the scanner keystone or the argv/egress gates - it is **defense in depth beneath them**
  (exactly ADR-0066's framing). The in-process gate (inv #4) still scans every tool call fail-closed on every OS.
- NOT an attempt to "understand the payload." We assume the payload is undetectable as text (it is). We contain
  the process instead: the only thing that must be true is that a hostile in-process action has **no unmediated
  route out.**
- NOT an omp fork (inv #1). We wrap the omp process WE ALREADY SPAWN (`lucid_acp.ts` / `acp_backend.ts`); we do
  not modify how omp's bash tool executes internally.

### Decision - contain the process, mediate its egress with the brain we already have

**1. A portable sandbox seam (`harness/runs/sandbox_exec.ts`, TS/Bun - inv #2, no new Python).**
A `SandboxBackend` interface `{ available(): boolean; wrap(argv, caps, ctx): { cmd, args, env } }` and a pure
`resolveBackend(platform, managed)`:
- **`BwrapBackend` (Linux, v1):** wrap the spawn in `bwrap` - workspace bound rw, system paths ro, `--unshare-net`
  for the network boundary, `--seccomp` for a deny-list of the worst syscalls. All of omp's child exec tools
  (`bash`/`eval`/`python`/`pip`) inherit the namespace, so containment is at the process tree, not per-command.
- **`NoopBackend` (platforms without a backend, v1 = macOS/Windows):** a **disclosed, audited passthrough** - runs
  as today (argv gate + scanner still fully apply) and emits a loud "exec not runtime-isolated on this platform"
  signal. This is the "LUCID still functions" pressure-valve: we do not brick exec on Mac/Windows while the
  Linux backend leads. **Enterprise-managed policy can flip this to REQUIRE isolation** (`managed_config.ts`):
  then an unavailable backend fail-closes to *block exec* rather than disclose. Personal default = disclose.

**2. Make `canNetwork` / `canExec` actually enforced (closes the profiles.ts gap).**
`wrap` reads the chosen `ProfileCaps`. `canNetwork:false` (`container-local` / `quarantine`) →
`--unshare-net` with **no** proxy = total network deny (the DNS-TXT lookup fails at the syscall). `canExec:false`
(`read-only-audit` / `quarantine`) → exec tools are refused outright. The auto-downgrade path (a suspicious/
quarantined causal chain, `chooseProfile`) now yields a genuinely network-isolated run, not a label.

**3. The mediated egress proxy (`harness/runs/egress_proxy.ts`, TS/Bun) - the part that defeats the DNS exfil.**
For `canNetwork:true` profiles we do NOT want a dead network (that breaks `pip install`). Instead the sandbox's
only route out is a **loopback DNS resolver + HTTP/CONNECT proxy** the harness runs: inside the namespace,
`/etc/resolv.conf` is bind-mounted to `127.0.0.1` and `HTTP(S)_PROXY` points at the proxy. Every DNS query and
every CONNECT is decided by the **existing pure `egressDecisionDetailed(host, ctx)`** from `egress_policy.ts` -
we REUSE the allow/deny/whitelist/managed brain the browser tool already uses (inv: import, never re-derive), so
subprocess egress obeys the SAME curated whitelist (P-NETWL), managed ceiling (P-ENT.1), and posture (P-NETWL.5)
the user already curates. `socket.gethostbyname()` on a TXT record is now a **resolver event we see, log, and can
refuse** - the exact surface Thom said didn't exist. Fail-closed (inv #3): proxy unreachable / unparseable host →
DNS/CONNECT denied.

**4. "Still functions" is the reuse of the P-NETWL.5 posture, not a new toggle.**
- Personal default (`allowAll` on): subprocess egress is **allowed but now MEDIATED + LOGGED**, and the existing
  still-prompt heuristics (public-IP literal, foreign ccTLD - `isForeignTld` / `isPrivateOrLanHost`) extend to
  subprocess DNS. So `pip install requests` → PyPI resolves and works; a decode→`gethostbyname("<b64>.attacker.cn")`
  hits the foreign-TLD prompt / gets logged even in permissive mode.
- Restrictive/whitelist mode (`allowAll` off) or enterprise-managed: the TXT lookup to a non-whitelisted host is
  **hard-blocked** at the resolver - the payload can't phone home at all.
- Filesystem, local build, read-only commands: unchanged (workspace bound rw). Latency: namespace setup is ~ms;
  the proxy is loopback.

### Phasing (shippable, one increment per session)

- **P-SANDBOX.1** - the seam + `BwrapBackend` + `NoopBackend` + `resolveBackend`; enforce `canNetwork:false` /
  `canExec:false` (total-deny + refuse-exec) for the downgrade profiles; managed "require-isolation" flag; the
  disclosed-passthrough audit. Wired at the omp spawn in `lucid_acp.ts` (`execGated`) + `acp_backend.ts`, behind a
  preflight like the scanner probe. This alone makes the declared caps real for suspicious/quarantined runs.
- **P-SANDBOX.2** - `egress_proxy.ts` (loopback DNS resolver + CONNECT proxy) consulting `egressDecisionDetailed`;
  proxy-mediated egress for `canNetwork:true`; extend the P-NETWL.5 foreign-TLD/IP-literal prompt to subprocess
  DNS. This is the increment that directly answers the DNS-TXT exfil.
- **P-SANDBOX.3** - `contracts.ts` event additions (`exec_sandboxed`, `subprocess_egress_blocked`,
  `dns_query_blocked`) - ITS OWN increment + this ADR's follow-up per inv #8 (unknown event name must raise) -
  plus the Security-panel surfacing and the **kill-the-proxy fail-closed test** (mirrors the kill-the-sidecar
  guarantee: proxy dead ⇒ egress denied, local exec still runs).
- **P-SANDBOX.4** (later) - macOS Seatbelt (`sandbox-exec`) + Windows AppContainer backends; `slirp4netns`-style
  forwarding so raw non-proxied sockets (a direct connect to an IP literal, bypassing `HTTP_PROXY`) are also
  funneled through the proxy rather than merely dropped by `--unshare-net`.

### Plumbing (for the build increments)

- `harness/runs/sandbox_exec.ts` - `SandboxBackend`, `BwrapBackend`, `NoopBackend`, pure `resolveBackend`,
  `wrapForProfile(caps, ctx)`; injected `which`/`spawn` for hermetic tests.
- `harness/runs/egress_proxy.ts` - a loopback DNS (udp/53 forwarder) + HTTP CONNECT listener; each request →
  `egressDecisionDetailed`; fail-closed; a lifecycle `start()/stop()` + preflight probe like `ScannerClient`.
- `harness/launcher/lucid_acp.ts` (`execGated`) + `desktop/acp_backend.ts` - resolve the backend, start the proxy
  as a fail-closed dependency, spawn omp wrapped; NoopBackend disclosure path.
- `desktop/managed_config.ts` - a `requireIsolation` managed knob (tighten-only, like `clampEgress`/`clampPosture`).
- `harness/runs/profiles.ts` - unchanged types; `caps()` becomes a REAL consumer (the gap this closes).
- Tests: `sandbox_exec.test.ts` (backend resolution, cap→flag mapping, managed require-isolation fail-closed,
  NoopBackend discloses), `egress_proxy.test.ts` (DNS/CONNECT verdict reuse, fail-closed, kill-the-proxy),
  `make demo-P-SANDBOX.{1,2}` (a legit `pip install` succeeds mediated; a TXT-exfil `gethostbyname` to a
  non-whitelisted host is blocked+logged; proxy dead ⇒ egress denied, local exec still works).

### Consequences / honest risks

- **Linux-first.** Real runtime containment lands on Linux (the CI/remote-runner + most enterprise surface) in
  .1/.2; macOS/Windows get it in .4. Until then those platforms are **no worse than today** (argv gate + scanner)
  and say so out loud (the disclosure event) - but a Mac/Windows user is not yet protected from this threat unless
  managed policy requires isolation (which would block their exec). This is a deliberate, disclosed trade to keep
  the product usable, not a silent gap.
- **`--unshare-net` + proxy covers proxy-honoring egress and all DNS; raw-IP sockets that ignore `HTTP_PROXY` are
  DROPPED (no route) in v1, and only FORWARDED through the proxy in .4.** For the named threat (DNS-TXT) v1/.2 is
  sufficient; a raw-socket variant is contained (dropped) but not yet observable until .4.
- More moving parts (a proxy process) = a new fail-closed dependency; mitigated by treating it exactly like the
  scanner sidecar (preflight + kill test).
- `bwrap` must be present; absence on Linux → NoopBackend disclosure (or managed block). Packaging ships/pins it.

### Rejected alternatives

- **Interpreter audit hooks (`sys.addaudithook` to trap `socket.gethostbyname`/`exec`/`compile`).** Precise, but
  (a) it would require shipping a `.py` bootstrap outside `scanner-sidecar/` - a direct **inv #2** violation - and
  (b) it is Python-only and trivially bypassed by a non-Python payload. OS-level containment is language-agnostic.
- **A smarter argv classifier / static analysis of the imported package.** This is exactly what ADR-0066 rejected
  ("false confidence"); the payload is well-formed and behavior only manifests at runtime. Thom's point stands.
- **Widening the egress allow-list to subprocesses without a namespace.** A decision table isn't an enforcer - with
  no namespace the subprocess's libc `socket` call never passes through our code. Containment must be OS-level.

### Invariants preserved

Inv #1 (wrap the omp process we spawn - no omp fork). Inv #2 (all new code is TS/Bun; NO new Python - the audit-
hook path is rejected FOR this reason; the scanner stays the only Python). Inv #3 (fail-closed extends to a new
layer: no backend under managed-require ⇒ block; proxy dead ⇒ egress denied). Inv #4 (the in-process gate is
untouched and still runs on every OS; this is beneath it). Inv #6 (runtime only - the frozen prompt prefix is not
touched). Inv #7 (no new trust labels). Inv #8 (the new EVENT names are quarantined into their own P-SANDBOX.3
contracts increment; .1/.2 reuse existing `tool_call_blocked`/`remote_run_blocked` emit plumbing).

### Relates to

ADR-0066 (P-EXEC.1 - the argv classifier this sits beneath; the header that concedes this scope limit),
ADR-0062/0106/0108 (P-EGRESS/P-NETWL - the egress brain + posture this REUSES for subprocess traffic),
ADR-0028/0032 (omp `--isolate` = filesystem-only containment; this adds the network/exec dimension it lacks),
ADR-0068 (P-ENT.1 - the managed ceiling that can require isolation), `harness/runs/profiles.ts` (the declared
`canNetwork`/`canExec` this finally enforces), CLAUDE.md invariants #1/#2/#3/#4.

-----

## ADR-0158 - P-MARKET.1: the Plugin Marketplace popup (Excalidraw first, Obsidian-ranked integrations)

**Date:** 2026-07-05
**Status:** Accepted. **P-MARKET.1 BUILT + tested.** Install mechanics deferred to P-MARKET.2 (design below).

### Context

Product ask (goal loop): a plugin marketplace in a new popup menu, similar to the other menus, simple to
use, with https://github.com/excalidraw/excalidraw as the first option; then plan integrations that
Obsidian ranks highly in its integrations category, popularity-first. Obsidian's community directory is
JS-rendered, so popularity was sourced from obsidianstats.com (2026-07): the "3rd Party Integrations"
category ranks Git (2,765,510 downloads), Remotely Save (2,008,001), Copilot (1,496,747), then Importer,
BRAT, Advanced URI, Zotero, Paste URL into selection, LanguageTool, Readwise. Excalidraw itself is the
most-downloaded Obsidian plugin overall (6,487,654) though it lives in a different category - the pin to
first place is a product requirement, and the popularity data supports it anyway.

NOT ADR-0038: that draft is about distributing LUCID as a JetBrains/VS Code extension on THEIR
marketplaces; this is a marketplace INSIDE LUCID.

### Decision

1. **A curated, STATIC registry** (`desktop/renderer/marketplace.ts`, `MARKET_PLUGINS`). Nothing is
   fetched, executed, or installed from the catalog in P-MARKET.1 - each row's only live action is
   `window.open(repo, "_blank", "noopener")` on its GitHub URL. Fail-closed posture: a marketplace that
   cannot run code cannot be a supply-chain vector. Registry entries carry stable string ids
   (invariant 9), a closed status set (`featured | built-in | planned`), verified download counts where
   sourced (null renders no badge - never fabricated numbers), and a one-line `lucidPlan` mapping each
   entry onto LUCID's architecture.
2. **Popup on the About-modal conventions** (`openMarketplace()` in app.ts): single instance, scrim +
   centered dialog, closes on X / backdrop / Escape; opened from a new rail button (`#railMarket`,
   `market` package icon) and a command-palette action. One search box live-filters the rows
   (re-renders `#mktList` only). Pure builders (`marketplaceHtml`/`marketRowsHtml`) keep the module
   DOM-free and unit-testable, mirroring local_providers_ui.ts (ADR-0135).
3. **Ordering is the requirement, encoded:** `sortMarket` pins `featured` first, then canonical `rank`
   (the Obsidian category order). Excalidraw-first is a TESTED invariant, not registry luck.
4. **The integrations roadmap** (the "plan relevant integrations" half of the goal), popularity-first:
   - **Git** (planned): dedicated git panel over the agent's existing gated git tooling.
   - **Remotely Save** (planned): encrypted sync of sessions + semantic memory to user-owned
     S3/WebDAV, vault-held keys, scanner-gated on the way back in.
   - **Copilot** (built-in): LUCID core chat + Local Providers (ADR-0135) already cover BYOM.
   - **Importer** (planned): external notes into the knowledge graph, through the scanner gate,
     labeled untrusted (invariant 5/7).
   - **BRAT -> P-MARKET.2**: install a marketplace entry from a GitHub URL, gated exactly like
     agent-template import (digest check + scanner + trust label + approval; fail-closed).
   - **Advanced URI** (planned): lucid:// deep links (open session / run command / launch agent).
   - **Zotero, Paste-URL, LanguageTool, Readwise** (planned): research citations, editor nicety,
     self-hosted grammar pass, highlights-as-untrusted-sources respectively.
   Excalidraw itself: embed the whiteboard in the sandboxed Preview panel; sketches feed the agent as
   design context (pairs with DESIGN.md honoring, ADR-0154).

### Consequences

- Files: `desktop/renderer/marketplace.ts` (+`.test.ts`), `market` icon in icons.ts, `openMarketplace()`
  + rail button + palette action in app.ts, `.mkt-*` styles, `desktop/scripts/demo_p_market_1.ts`,
  `demo-P-MARKET.1` Makefile target.
- P-MARKET.2 (install path) MUST reuse the agent-template import gate seam, not invent a second one.
- Registry updates (new entries, refreshed download counts) are ordinary PRs touching one array.

### Verification

`bun test desktop/renderer/marketplace.test.ts` 14 pass (Excalidraw-first invariant, closed status set,
unique ids/ranks, https-GitHub-only repos, category-rank ordering, filter/format edges, escaping of
registry strings and hostile queries). `bun run desktop/scripts/demo_p_market_1.ts` green. Root
`tsc --noEmit` clean. Full `bun test`: no new failures (pre-existing: vendor/oh-my-pi environment
failures + desktop/fs_browse.test.ts, verified identical with the change stashed).

### Relates to

ADR-0135 (local-providers card, the pure-builder pattern reused), ADR-0087 (About modal conventions),
ADR-0038 (LUCID on external marketplaces - disambiguated), ADR-0020/0152 (the gate seams P-MARKET.2
must reuse).

-----

## ADR-0159 - P-SANDBOX.1: the runtime sandbox seam, BUILT (declared caps enforced at the omp spawn)

**Date:** 2026-07-05
**Status:** Accepted / Built. Increment 1 of the ADR-0157 epic (P-SANDBOX.2 proxy next).

### What shipped

`harness/runs/sandbox_exec.ts` - the portable seam exactly as scoped: `SandboxBackend`
(`bwrap` | `noop`), pure `resolveBackend(platform, requireIsolation, which)`, and
`wrapForProfile(argv, caps, ctx, resolution)` as the SINGLE fail-closed decision point:

- managed require-isolation + no isolating backend  => refuse (never a silent passthrough);
- `canExec:false` (read-only-audit / quarantine)    => refuse to spawn an exec-capable omp;
- `canNetwork:false` on a non-isolating backend     => refuse (never silently networked);
- `canNetwork:false` under bwrap                    => `--unshare-net` (total deny, DNS included).

The `chooseProfile` suspicious-chain downgrade to `container-local` now yields a genuinely
network-denied plan - the profiles.ts gap ADR-0157 named is closed. Wired at BOTH spawns:
`lucid_acp.ts` `execGated` (acp + tui share it; refused resolution = exit 1 before spawn, like the
scanner preflight) and `acp_backend.ts` `resolveSandboxPlan` at the ACPClient argv. Managed knob:
`security.exec.requireIsolation` (+ GPO flat value `ExecRequireIsolation`), tighten-only, read via
the tamper-guarded managed_config channels only - never env.

### Deliberate deltas from the ADR-0157 text (recorded, not silent)

1. **Launcher fail-closes the WHOLE start** under managed-require+no-backend, while the DESKTOP
   blocks exec selectively (spawn proceeds; every exec permission at the session/request_permission
   seam is denied + audited via the existing SecurityEvent plumbing - no new EventNames, honoring the
   P-SANDBOX.3 quarantine). Rationale: `lucid acp`/`tui` hand permission decisions to the IDE
   client, so a spawned-but-exec-blocked session cannot be guaranteed from our side of the boundary;
   the desktop CAN guarantee it and keeps chat/read useful.
2. **bwrap v1 binds $HOME rw.** omp session state/config/credentials live there; ADR-0157's v1 scope
   is the NETWORK + process boundary - filesystem containment remains omp `--isolate`'s job
   (ADR-0028). Tightening the mount plan is P-SANDBOX.2+ work alongside the proxy.
3. **Seccomp deferred.** `bwrap --seccomp` wants a compiled BPF program fd; shipping one is its own
   careful change, not a side effect. `--unshare-net` + `--die-with-parent` + ro system mounts are
   the v1 containment.
4. **Launcher tests inject the sandbox resolution** (`RunAcpOpts.sandbox`) - otherwise the spawn-
   shape assertions would depend on the HOST (a Linux dev box with bwrap would wrap the argv).

### Verification

`bun test harness` 801 pass / 0 fail (+21: sandbox_exec.test.ts 16, lucid_acp.test.ts wiring 4, and
the hermetic updates); desktop/managed_config.test.ts 28 pass; root + desktop + server `tsc --noEmit`
clean; `bun build --compile` of the standalone launcher still bundles (the new desktop/managed_config
import is node-builtins only); `make demo-P-SANDBOX.1` green (backend resolution, cap->flag mapping,
all four fail-closed rules, GPO knob, launcher wiring); `make demo-P-MARKET.1` still green.

### Relates to

ADR-0157 (the epic + threat model), ADR-0066/0068 (the argv gate this sits beneath; the managed-knob
pattern reused), ADR-0028 (omp --isolate owns the fs dimension), ADR-0038 (launcher trust anchor),
AGENTS.md invariants #1/#2/#3/#4.

## ADR-0160 - P-THEME.1: the LUCID skin for gated terminals (an omp theme + a per-session `-e` apply)

**Date:** 2026-07-05
**Status:** Accepted / Built.

### Context

`lucid tui` is deliberately "just omp" (ADR-0150): the product is the invisible gate, not the chrome.
The user asked the fair follow-up — can gated terminals at least LOOK like LUCID? omp ships a full
supported theming surface (docs/theme.md: JSON themes in `~/.omp/agent/themes/`, 66 required color
tokens, live file-watch reload) and an extension API with `ctx.ui.setTheme(name)` on the handler
context, wired to the real theme switcher in interactive mode and stubbed to a graceful
`{success:false}` in ACP/RPC/print modes. Crucially `setTheme(name)` swaps the in-memory theme
singleton WITHOUT persisting `theme.dark` to config.yml — a per-session skin needs no settings write.

### Decision

1. **`harness/omp/themes/lucid.json`** — the desktop design system (desktop/renderer/styles.css)
   translated to omp's theme schema: bg scale `#0a0b0f→#222736`, magenta accent `#c64bd6`/`#e07bf0`,
   cyan-for-data `#46c8dc`, semantic green/amber/red, `vars`-based so the palette is stated once.
   Alpha "dim" tints are flattened onto `--bg-1` (terminals have no alpha): toolSuccessBg `#162a24`,
   toolErrorBg `#2e1c21`, selectedBg `#2d1f3c`.
2. **`harness/omp/lucid_theme_extension.ts`** — a tiny `-e` extension: on `session_start` it
   provisions the JSON into omp's custom-themes dir (`$PI_CODING_AGENT_DIR/themes` else
   `~/.omp/agent/themes`; read-then-compare, write only on byte drift so omp's theme watcher isn't
   poked per launch) and calls `ctx.ui.setTheme("lucid")`. Escape hatch: `LUCID_THEME=off|0|false`
   disables, `LUCID_THEME=<name>` wears another theme (no provisioning). Pure core
   (`themesDir`/`requestedTheme`/`provisionTheme`/`applyLucidTheme`) exported for tests; the omp
   handler is a thin wrapper, defensively typed off `createAgentSession` like mcp_result_gate.ts.
3. **Launcher wiring** — `LaunchAssets.lucidTheme` + optional `BuildTuiOpts.lucidTheme`; `runTui`
   passes the `-e` when the file exists, AFTER the mandatory gate `-e` (gate stays first), before the
   byte-identical appended policy (invariant #6 untouched — the prefix-hash test still pins it).
   **TUI only**: ACP mode stubs setTheme as unavailable and the desktop shell has its own skin, so
   `buildAcpArgs` is deliberately not threaded.

### FAIL-OPEN, explicitly (the inverse of the gate)

Invariant #3 (fail-closed) governs scan results, not paint. The skin is cosmetic: every failure —
unwritable themes dir, malformed JSON, headless/ACP stub, setTheme rejection — degrades to
"not applied" on omp's default theme, logged at debug, NEVER thrown, and can never block or kill a
session. The demo + tests pin both directions: cosmetic fail-open AND untouched security fail-closed
(dead scanner still ⇒ exit 1, zero spawns). The skin also gives the gate a visible tell: a branded
terminal IS a gated terminal; bare omp keeps the user's own theme because nothing persists.

### Session note — baseline repair (pre-increment, recorded here)

The start-ritual baseline was red from two pre-existing rots, fixed before this increment's code:
(1) `desktop/platform.test.ts` assumed the Bun test runtime has no `navigator`; Bun ≥1.x ships one,
so on a mac host `isMac()` was correctly true — tests now stub a throwing accessor (the guard's
catch path) / a Linux navigator, and the tour assertion pins the LIVE `modCombo("K")` resolution
portably. (2) bare `bun test` crawled the GENERATED `desktop/release/**` packaged repo copies
(gitignored, but Bun's crawler doesn't honor gitignore) — `make test-harness` now runs with
`--path-ignore-patterns='desktop/release/**'` (suite: 340→156 real files).

### Verification

`make demo-P-THEME.1` green (token resolution, idempotent provisioning + setTheme via a fake ctx,
fail-open × fail-closed, argv order, truecolor palette swatches). Live: `lucid tui --model
claude-haiku-4-5 -p …` through the real launcher returned a gated turn (exit 0) and re-provisioned
`~/.omp/agent/themes/lucid.json` byte-identical after deletion — the extension loads under real omp
and session_start fires; interactive paint rides the verified extension-ui-controller setTheme path.
`bun test harness/omp/lucid_theme_extension.test.ts harness/launcher/lucid_acp.test.ts` green
(Tester-authored); full `make test` green (see PROGRESS.md for counts); root `tsc --noEmit` clean.

### Relates to

ADR-0150 (`lucid tui` — the surface this skins), ADR-0152 (the sibling optional `-e` pattern),
ADR-0038 (launcher trust anchor), P-IDE.4 (the desktop lucid-dark the palette mirrors),
AGENTS.md invariants #1 (extend, never fork — a theme file + a supported API), #3/#6 (untouched).
## ADR-0161 - P-NVIM.5: bare `lucid` starts the gated TUI (default subcommand)

**Status:** Accepted / Built.

**Context.** The gated TUI (ADR-0150) is the daily-driver surface, but it costs an extra word every
time: `lucid tui`. Every doc, keymap, and terminal invocation carries the subcommand, and a bare
`lucid` printed usage and exited 0 - a dead end for the most common intent.

**Decision.** `tui` becomes the DEFAULT subcommand. `main()` routes bare `lucid` - and any argv that
isn't a known subcommand (`acp`/`tui`/`stats`/`check`/`agent-firewall`) or a help flag
(`-h`/`--help`/`help`) - to `runTui` with the ENTIRE argv as omp passthru, so
`lucid "explain src/auth.ts"` and `lucid --model haiku -p hi` behave exactly like their `lucid tui`
spellings. `lucid tui` remains an explicit alias (nothing breaks); help flags now return 0 with usage
(a requested help is not an error). A `deps` injection seam on `main()` (mirroring the existing
`spawnFn`/`scannerProbe` seams) lets tests assert routing without ever spawning omp.

**Consequences.**
- Unknown-subcommand typos no longer exit 2 - they start the TUI with the typo as an initial prompt.
  That is the designed semantic (an initial prompt IS a first-class positional), accepted trade-off.
- The Neovim plugin (`_build_tui_args`) and all docs/messages drop the `tui` word; the plugin now
  requires a launcher with this change (the stale compiled `bin/lucid` predates `tui` entirely -
  unchanged status, ADR-0150).
- Fail-closed is untouched: the default path IS `runTui`, same preflight, same gate-first argv.

**Verification.** `main()` routing tests (bare/flags/prompt -> tui passthru; `tui` alias strips the
subcommand; `acp` never routes to tui; help flags exit 0 spawning nothing) via the deps seam;
`extensions/neovim/test/helpers_spec.lua` pins the subcommand-free argv; `make test` + sidecar green;
`tsc --noEmit` clean.

**Related.** ADR-0150 (`lucid tui`), ADR-0155/0156 (Neovim surface), ADR-0038 (launcher trust anchor),
invariants #3/#4 (fail-closed, gate can't be omitted - both untouched).
## ADR-0162 - P-REPORT.9: multi-repo remote fetch + PR aggregation for the Engineering Report

**Date:** 2026-07-05
**Status:** Accepted. **P-REPORT.9 BUILT + tested.**

### Context

Product ask: the Engineering Report was blind to anything not already committed on ONE repo's local
default branch. It reads `DECISIONS.md`/`PROGRESS.md` from the app repo plus a local `git diff
HEAD~10..HEAD` (`gitChangeInputs`, dev.ts) - it never fetched remotes, never spanned other branches,
never saw the other repos a user tracks, and had no concept of pull requests. Users running against
several remote repos (feature branches, PRs, `master` moving upstream) got a report missing the newest
work. They asked to pick which repos to include, verify their remotes, add missing ones, pull the latest,
and fold recent commits + PRs into one comprehensive report - targeting only the repos they choose.

### Decision

1. **Fetch-only sync, never pull.** The user picked fetch-only over `git pull`: `git fetch --prune
   --no-tags origin` per selected repo downloads remote commits/branches READ-ONLY - it never mutates the
   working tree or current branch, so it can't conflict across many repos with uncommitted work. `pull`
   and merge modes are deliberately out of scope (recorded as a follow-up, not a silent omission).
2. **A PURE renderer + a desktop collector, mirroring change_graph.ts / gitOut.**
   `harness/brief/repo_activity.ts` is pure (raw git/gh strings → `RepoActivity` → a "Cross-repo activity"
   annex markdown; no I/O, no Date) so it is fixture-tested. `desktop/repo_collect.ts` does the spawning:
   fetch, `git for-each-ref` branch enumeration (local heads + `origin/*`, remote HEAD symref filtered,
   capped at 8 by recency), `git log` per branch, the window diff for line totals, and gh for PRs.
3. **PRs via the `gh` CLI, opt-in per repo, GitHub only.** A per-row toggle, enabled only when the remote
   is GitHub AND `gh auth status` succeeds (cached 60s). Non-GitHub / unauthed / not-requested each yield
   an explicit `prStatus` that the annex renders as an honest "PRs skipped: <reason>" line. gh runs with
   `cwd` = the repo so it reads the origin remote itself.
4. **Repo source = workspaces ∪ recents ∪ a new `reportRepos` list** (settings_store.ts). "Add repo"
   takes a local path (validated `isGitRepo`) or a clone URL (reusing `cloneRepo`) and persists into
   `reportRepos` WITHOUT calling `setWorkspace`/`backend.restart()` - tracking a repo for reporting must
   never hijack the active omp session. The picker shows each repo's remote URL as the "verify" surface.
5. **`/api/brief` gains a POST path** `{ role, save, repos:[{path,fetch,prs}], window }`; when `repos` is
   present it appends the cross-repo annex for ALL roles. GET (single-repo default) is unchanged, so a
   plain Generate reproduces the prior brief exactly (back-compat). Two new endpoints: `GET
   /api/report/repos` (candidates + gh-auth) and `POST /api/report/repos/add`.

### Security

- **First-party control-plane egress**, exactly like `cloneRepo` (ADR-0111): server-side `Bun.spawn` of
  git/gh behind the loopback + per-launch-token gate (ADR-0022/0024), NOT the agent tool gate. Fetch is
  read-only with a 25s per-repo timeout; every step is fail-soft (a failed fetch still yields local refs,
  flagged; a bad repo contributes an empty labeled entry, never a throw or a blank).
- **Untrusted external content (invariant #5).** Commit subjects, PR titles, and author names are
  externally authored. `clean()` collapses newlines, strips code-fence/inline-code breakout, escapes HTML,
  escapes table pipes, and length-caps every field before it enters the markdown. The annex carries a
  provenance line stating the text is DATA, never instructions - it holds when the brief later flows to
  TTS / NotebookLM / the KG (`reportToKg`).

### Deliberate deltas / scope

The brief NARRATIVE still comes from the primary repo's DECISIONS/PROGRESS; only the additive annex is
cross-repo (broadening the narrative source is a follow-up). Non-GitHub PR providers (GitLab MRs, Azure
DevOps) are out of scope - detected and skipped with a reason, not half-supported.

### Verification

`bun test harness` 826 pass / 0 fail (+25 `repo_activity.test.ts`: URL parse GitHub-vs-not, commit/PR
parse, cross-branch dedup + totals, fetch-failure surfacing, each PR-skip reason, per-branch cap, and
untrusted-text escaping / fence-breakout). `make demo-P-REPORT.9` green. Renderer bundles clean. Live
against real repos: `listReportRepos()` resolved GitHub + GitLab + Azure-DevOps remotes and flagged
non-git folders; `collectRepoActivity` enumerated commits across feature/master/release branches with
line totals, and the annex escaped `&`. The 5 pre-existing `fs_browse.test.ts` env failures are unrelated.

### Relates to

ADR-0116/0117 (the Reports panel + brief store this extends), ADR-0072 (the Engineering Update engine),
ADR-0030 (`gitChangeInputs`, reused pattern), ADR-0111 (`cloneRepo` first-party git precedent),
ADR-0022/0024 (the loopback + token gate the endpoints sit behind), CLAUDE.md invariants #3 (fail-closed),
#5 (untrusted content delimited/as-data), #9 (stable ids).

-----

## ADR-0163 - P-TOOLFAIL.2: failed tool calls collapse into a toolbox badge (Tool Call Actions)

**Date:** 2026-07-05
**Status:** Accepted. **P-TOOLFAIL.2 BUILT + tested.**

### Context

Product ask (from a live session, screenshot evidence): three benign probe failures - a `grep`
that matched nothing (exit 1), `make` on a Windows box without make (exit 127), and an
"Async job manager unavailable" refusal - rendered as three full-width "tool failed" rows that
read like an alarm wall. P-TOOLFAIL.1 (ADR-0093) fixed the WORDING (failure ≠ denial); this
increment fixes the WEIGHT: a run of failures should be one small, quiet, clickable artifact,
with the detail available on demand - per failed action, the tool, the one-line reason, the
COMMAND ATTEMPTED, and the full error text.

### Decision

1. **Extraction (pure, `desktop/tool_failure.ts`):** `toolFailureCommand(u)` pulls what the call
   attempted - `rawInput`/`input` first across the SAME key set the exec-approval path reads
   (`command|cmd|script|code|source|input`), else omp's `$ …` call title (bare, `$ ` stripped;
   cap 400). `toolFailureDetail(u)` is the full multi-line error (same sources as
   `toolFailureMessage`, CRLF-normalized, line structure preserved, cap 2000). The module also
   converted from `any` to `unknown` + type guards (ts-no-any rule); behavior locked by the
   existing P-TOOLFAIL.1 tests, all green unmodified except the new imports.
2. **Event plumbing:** the `quarantined:false` block ChatEvent gains optional `command`/`detail`
   (acp_backend.ts emission + the bridge.ts union kept in sync). Security-block emissions are
   untouched - this stays the NEUTRAL path of ADR-0093.
3. **Rendering (`desktop/renderer/toolfail_group.ts`, pure builders like marketplace.ts):**
   consecutive failures collapse into ONE badge - a red `toolbox` icon (new icons.ts glyph) +
   count. Click toggles the "Tool Call Actions" list: per row the tool, reason, `$ command`,
   and a `<pre>` detail (skipped when the flattened detail adds nothing over the one-line
   reason). app.ts owns grouping: a group ends the moment anything else lands in the thread
   (the group element is no longer `#thread`'s last child), so failures from different phases
   never merge. Delegated click survives innerHTML repaints. Everything escaped; hostile tool
   output renders inert (tested).
4. **Not a security surface, still:** the badge tooltip carries "not a security block"; the
   gate's quarantine keeps its own loud `.evt.block` chip + toast path, byte-for-byte untouched.

### Consequences

- Files: tool_failure.ts (+command/detail, `unknown` conversion), acp_backend.ts + bridge.ts
  (event fields), renderer/toolfail_group.ts (+.test.ts, new), renderer/app.ts
  (addToolFailure + onBlock branch), icons.ts (`toolbox`), styles.css (`.toolfail`),
  scripts/demo_p_toolfail_2.ts, `demo-P-TOOLFAIL.2` Makefile target.
- The one-line `.evt` failure chip is REPLACED by the badge on this path; ADR-0093's honest
  wording lives on inside the rows (and the tests asserting it are unchanged).

### Verification

`bun test desktop/tool_failure.test.ts desktop/renderer/toolfail_group.test.ts` 28 pass
(command/detail extraction incl. caps + `$ `-title stripping; collapsed = badge only;
expanded = all rows; escaping of hostile tool/reason/command/detail; singular/plural tooltip).
`demo-P-TOOLFAIL.2` green against the EXACT three payloads from the reporting session;
demo-P-TOOLFAIL.1 still green (wording contract intact). Root `tsc --noEmit` clean. Full
`bun test desktop`: 1072 pass / 5 fail - all five are the PRE-EXISTING Windows
fs_browse.test.ts failures also named in ADR-0158's verification; none touch this change.
In-app visual pass on the packaged Electron build not yet done (pure-builder tests + demo
cover the HTML contract) - noted in PROGRESS.

### Relates to

ADR-0093 (P-TOOLFAIL.1 - the honest wording this keeps), ADR-0158 (pure-builder renderer
convention reused), ADR-0021 (quiet-vs-loud event discipline).

-----

> **ADR numbering note.** 0163 is the sibling increment **P-TOOLFAIL.2** (failed tool calls collapse into
> a toolbox badge), developed in parallel on `p-toolfail-2-toolbox-badge` / PR #223 and not yet on master
> when this branch forked. This increment therefore takes **0164**; on master the two are contiguous. The
> earlier P-REPORT.9 collision (0160 vs P-THEME.1) was already resolved to 0162 in merge #222.

## ADR-0164 - P-REPORT.10: a formal SecurityEvent per fetch / PR reach-out (Engineering Report)

**Date:** 2026-07-05
**Status:** Accepted. **P-REPORT.10 BUILT + tested.**

### Context

P-REPORT.9 (ADR-0162) gave the Engineering Report a multi-repo collector: for each selected repo it
`git fetch`es the remote read-only and (opt-in, GitHub + gh-authed) `gh pr list`s. Those are FIRST-PARTY
control-plane reach-outs - server-side `Bun.spawn` behind the loopback + token gate, deliberately NOT
routed through the agent tool security gate (that gate scans the AGENT's tool calls; these are the app
reaching out on the user's behalf). The gap ADR-0162 recorded as a follow-up: those network reach-outs
emitted NO audit record, so an operator watching the SIEM/OCSF stream (ADR-0069) saw exec/egress/scanner
gate decisions but was blind to the report generator dialing out - the one place the app egresses OUTSIDE
the agent gate. "Generate a report" could touch N remotes with no trace.

### Decision

1. **Emit a canonical desktop `SecurityEvent` per ACTUAL reach-out**, via the existing `emitSecurityEvent`
   seam (`audit_export.ts`, ADR-0069) - the SAME dispatcher, ring buffer, OCSF mapper, and file/SIEM sinks
   as every gate decision. A git fetch and a gh PR list each map to `category:"egress"`,
   `decision:"allow"` (a permitted first-party op, not a block), `severity:"info"`, with `type`
   `report_fetch` / `report_pr_list` and `tool` `git` / `gh`.
2. **Reuse the SecurityEvent seam - add NO `contracts.ts` EventName values.** `category:"egress"` already
   exists; a report reach-out IS network egress. This keeps the frozen contract untouched (invariant #8),
   matching the P-SANDBOX.1 precedent ("audited via existing SecurityEvent - no new EventNames").
3. **A PURE, total builder decides what fires.** `reachoutAuditEvents(ref, {fetched, fetchOk, prStatus})`
   returns the 0-2 events from what the collector already knows after a reach-out. A fetch event fires iff
   a fetch was ATTEMPTED (`fetched`); a PR event fires iff gh actually RAN (`prStatus` is `ok`=succeeded or
   `error`=ran-but-failed). The `skipped-*` PR statuses never spawned gh, so they emit NOTHING - the audit
   reflects reality, never a reach-out that did not happen. `collectRepoActivity` gains an injectable
   `emit` param (default `emitSecurityEvent`) so the wiring is unit-testable with zero network.

### Security

- **Metadata ONLY, no credential leak.** The `reason` carries the remote HOST (`ref.host`, already
  lowercased and credential-free - `parseRemoteUrl` strips any `user:token@` userinfo), never the raw
  remote URL (which can embed a token). A local / unparsed remote (blank host) is recorded as
  `(local/unparsed remote)` - the raw path is never echoed. Over-recording a benign local fetch is
  harmless; the posture is fail-toward-recording so a non-obvious reach-out (e.g. a UNC/SMB remote) is
  never silently un-audited.
- **Observability, never a gate.** Emission is best-effort and fail-safe (the dispatcher never throws
  into a turn); a dead sink never affects report generation. The reach-out itself is unchanged - this adds
  a record, not a decision. The existing first-party-egress posture (loopback + token gate, read-only
  fetch, 25s timeout, fail-soft) is untouched.

### Deliberate deltas / scope

One fetch event and one PR-list event per repo (the gh open+merged pair is one logical reach-out, one
event). `decision` is always `allow` - these are permitted first-party ops, not gate verdicts; a future
managed "no report egress" clamp could emit `block`, but no such policy exists today. Non-GitHub PR
providers remain out of scope (still `skipped-nonhub`, no reach-out, no event) - a P-REPORT.11 item.

### Verification

`bun test desktop` 910 pass / **5 fail** (post-merge with #223's toolfail tests folded in; the 5 are the
pre-existing `fs_browse` / `listDir` Windows env failures unrelated to this change - the desktop suite is
where this code lives); `bun test harness` 843 pass / **1
fail** (a pre-existing Windows path-separator assertion in the P-THEME.1 theme-asset test - harness
untouched here). The **+13** new `desktop/repo_collect.test.ts` all pass: `reachoutAuditEvents` across
fetch ok/fail, not-fetched, network vs local/blank host, PR `ok`/`error`, every `skipped-*` (no event),
the combined 2-event case, and a no-credential-leak assertion (a token-bearing URL never leaks the token
or `user:` / `@` into the reason); plus an OFFLINE wiring test - a temp repo with a LOCAL bare origin
fetched through `collectRepoActivity` with an injected recorder fires exactly one `report_fetch` event,
and `fetch:false` fires none. `demo-P-REPORT.10` green (pure builder + a LIVE offline reach-out through
the REAL dispatcher into an OCSF Detection Finding a SOC can ingest, `class_uid` 2004 / `disposition_id` 1); `demo-P-REPORT.9`
still green. Root + desktop `tsc --noEmit` report no errors in the touched files.

### Relates to

ADR-0162 (P-REPORT.9, the collector this audits + the follow-up it closes), ADR-0069 (P-ENT.2, the
SecurityEvent export seam / OCSF sinks reused), ADR-0159 (P-SANDBOX.1, the "audit via existing
SecurityEvent, no new EventNames" precedent), ADR-0111 (`cloneRepo` first-party git egress),
ADR-0022/0024 (the loopback + token gate), CLAUDE.md invariants #8 (exact event names / frozen contract),
#5 (metadata-only audit), #3 (fail-safe logging never weakens fail-closed).
