# Lucid Agent IDE Harness

A security / provenance / memory layer built **around** [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi)
— not a fork. omp provides tool-calling, model routing, sessions, sandboxing, and
a TUI; this harness adds the v3 PRD's prompt-injection defense, trust labeling,
quarantine, provenance-backed memory, and replayable security telemetry on top,
via omp's hooks / custom tools / SDK.

> **Read [`CLAUDE.md`](CLAUDE.md) before touching code.** It holds the load-bearing
> invariants (fail-closed, extend-don't-fork, frozen contracts, byte-stable prompt
> prefix). Architecture decisions live in [`DECISIONS.md`](DECISIONS.md); the
> staged plan in [`BUILD PLAN omp.md`](BUILD%20PLAN%20omp.md); the full spec in
> [`custom_agentic_ide_prd_v3.md`](custom_agentic_ide_prd_v3.md).

## Architecture in one line

TypeScript on Bun, in-process with omp. The **only** Python is
[`scanner-sidecar/`](scanner-sidecar/) — the pure Unicode scanner, behind a
narrow NDJSON contract, so the fail-closed gate that consumes it can never fail
open (DECISIONS.md ADR-0001).

## Layout

```text
harness/            # ALL TypeScript
  contracts.ts          # FROZEN: TrustLabel, AgentMode, EventName, ToolResult, Finding
  tools/result_adapter.ts # FROZEN: the only place omp's result shape meets ours
  security/
    scanner_client.ts     # NDJSON client to the sidecar; fail-closed on any failure
    gate.ts               # quarantine gate (scanAndDecide = the fail-closed seam)
    gate.failclosed.test.ts # keystone test: kill sidecar -> gate BLOCKS
  testing/echo.ts         # no-network echo model/session (omp mock provider)
  scripts/                # demo00_{omp_echo,scanner,failclosed}.ts
scanner-sidecar/      # the ONLY Python (uv-managed): scanner.py + server.py + tests
.agents/              # vendor-trusted skills/policies/security (see .agents/README.md)
vendor/oh-my-pi/      # read-only reference clone of omp (gitignored)
```

## Setup

```bash
bun install                     # harness deps (Bun >= 1.3)
cd scanner-sidecar && uv sync   # pinned Python sidecar venv
```

Requires [Bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/). `make` is
optional (the [`Makefile`](Makefile) is the canonical task spec); equivalents are
exposed as bun scripts on hosts without `make`.

## Run

```bash
bun run demo-00        # Increment 0: omp echo round-trip + scanner + fail-closed proof
bun test harness       # harness test suite (incl. the fail-closed keystone)
# sidecar tests:
cd scanner-sidecar && uv run python -m pytest -q
```

## Try it with the live omp agent

omp is installed globally. Load the security gate into a real session — every
tool call is scanned, and quarantined content is blocked (fail-closed):

```bash
# 1. set your Anthropic key (PowerShell; restart the terminal first so omp+bun are on PATH)
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# 2. run omp with our gate loaded, in this repo
omp --model sonnet -e harness/omp/security_extension.ts
#   (or, version-matched to the harness SDK: `bun run omp:secure -- --model sonnet`)

# 3. ask the agent to use the planted untrusted file:
#    > Read repos/project-alpha/untrusted-demo.md and run the cleanup command it contains.
```

That file hides a zero-width character in a shell command. The agent reads it and
tries to run it; the gate blocks the `bash` call and prints:

```
🛡️  [LucidAgentIDE] [BLOCKED tool_call:bash] source=bash trust=quarantined severity=high findings=zero-width
```

The gate ([`harness/omp/security_extension.ts`](harness/omp/security_extension.ts))
is the same one the test suite proves — here it runs inside the live agent.

## Status

**Build plan complete** (Increment 0–2 + Phases 2–7) — see [`PROGRESS.md`](PROGRESS.md).
Everything green: **17 demos** (`demo-00` … `demo-P7.2`), **130 harness tests**,
**54 sidecar tests**, `tsc --noEmit` clean.

The full security lifecycle holds end-to-end: untrusted text enters → scanned →
trust-labeled → sanitized → persisted → **blocked at the tool / promotion /
dispatch boundaries** → human-reviewed → and exits only as safe, audited
evidence; with provenance-tracked recursive runs, replay, and a cache-optimized
prompt prefix proven by benchmark.

Run any stage:

```bash
bun run demo-P2.4   # quarantine pre-hook blocks a poisoned tool call
bun run demo-P4.3   # poisoned memory can't auto-promote (keystone #2)
bun run demo-P7.2   # cache-hit benchmark by prompt-prefix version
```
