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

## Status

**Increment 0 complete** — see [`PROGRESS.md`](PROGRESS.md). Everything green:
`demo-00`, 5 harness tests, 12 sidecar tests, `tsc --noEmit` clean.
