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
**Status:** Proposed (finalize when the scanner lands in P2.1)

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
**Status:** Accepted as a roadmap. Phases P8.1–P8.4 are **Proposed** — each is built in
its own future increment with its own confirming ADR (or an addendum here) when the
frozen-contract changes land.
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
migration `0007_memory_session.sql` — sidecar `fact_sessions(fact_id, session_id, run_id,
recalled_at)`, never ALTER frozen `semantic_facts`; new `EventName` `memory_recalled`.

**Phase B — `P8.2-traceability` (prompt/response capture).** Satisfies #3. Capture each
turn's prompt + response with stable ids + provenance. Hook point is the **desktop-layer
`acp_backend.ts` `prompt()` stream** (the omp tool-call hook only sees tool calls, not the
user prompt or free-text reply); best-effort, buffered, flushed on `done`. Sanitized via
`escapeMarkdown`; raw preserved in `archive_chunks` by `content_sha256`. *Frozen-contract
impacts:* migration `0008_turn_transcripts.sql` — `turns(turn_id, run_id, session_id, seq,
role, sanitized_text, raw_sha256, archive_chunk_id, trust_label, created_at)`; new `EventName`
`turn_captured` (metadata only — ids/role/sha/blocked-count, no content).

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

**Phase D — `P8.4-dev-logging` (Developer-mode admin view).** Satisfies #4. Depends on B.
A Settings-gated, read-only view of telemetry, run lineage, and per-turn transcripts, with the
audited raw-reveal. Add `developerMode?: boolean` to `settings_store.ts` (+ `setDeveloperMode`)
and a Settings checkbox copying `headroomToggle`; when ON, reveal a new **Logs** rail tab.
Surfaces (READ_ONLY, gated server-side on `developerMode`): `telemetry_events` stream,
`getRunTree` lineage, `turns` transcripts (sanitized). Endpoints `GET
/api/dev/{telemetry,lineage,turns}` and `POST /api/dev/reveal` (the audited raw path).
*Frozen-contract impacts:* no migration; `raw_revealed` (shared with C); recommended
`developer_mode_toggled` (flipping the gate's posture is auditable).

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
**Status:** Accepted as a roadmap. Phases P10.1–P10.4 are **Proposed**.
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
