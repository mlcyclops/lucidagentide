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
**Phase D BUILT** (scoped — Logs view; transcripts + raw-reveal deferred, see Phase D below).
**Phase A** (cross-session memory recall) and **Phase B** (traceability) remain **Proposed** and are
assigned to contributor alexander-blackwell (issues #11 / #12). Each lands in its own increment.
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
