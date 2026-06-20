<div align="center">

<img src=".github/assets/techlead187-avatar.png" alt="TechLead187" width="160" style="border-radius: 50%;" />

<br/>

<img src=".github/assets/banner.svg" alt="LucidAgentIDE — a fail-closed security, provenance and memory harness around oh-my-pi" width="100%" />

<br/>

<a href="https://github.com/mlcyclops/lucidagentide/actions/workflows/build-desktop.yml"><img src="https://img.shields.io/github/actions/workflow/status/mlcyclops/lucidagentide/build-desktop.yml?label=Windows%20Build&logo=windows&logoColor=white&style=flat-square" alt="Windows Build" /></a>
<a href="https://github.com/mlcyclops/lucidagentide/actions/workflows/build-desktop.yml"><img src="https://img.shields.io/github/actions/workflow/status/mlcyclops/lucidagentide/build-desktop.yml?label=macOS%20Build&logo=apple&logoColor=white&style=flat-square" alt="macOS Build" /></a>
<img src="https://img.shields.io/badge/tests-130%20harness%20%2B%2054%20sidecar-46d27e?style=flat-square" alt="tests" />
<img src="https://img.shields.io/badge/gate-fail--closed-e07bf0?style=flat-square" alt="fail-closed gate" />

<br/>

<img src="https://img.shields.io/badge/Bun-%E2%89%A51.3-fbf0df?style=flat-square&logo=bun&logoColor=black" alt="Bun" />
<img src="https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
<img src="https://img.shields.io/badge/Electron-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" />
<img src="https://img.shields.io/badge/DuckDB-FFF000?style=flat-square&logo=duckdb&logoColor=black" alt="DuckDB" />

<br/>

**A security · provenance · memory layer built _around_ <a href="https://omp.sh">oh-my-pi</a> — not a fork.**
Prompt-injection defense, trust labeling, fail-closed quarantine, provenance-backed memory, replayable
telemetry, a gov AI gateway, and a polished desktop GUI — added through omp's hooks, custom tools, and SDK.

<a href="#-quick-start"><b>Quick start</b></a> ·
<a href="#-architecture"><b>Architecture</b></a> ·
<a href="#-security-model"><b>Security</b></a> ·
<a href="#-token-cost-savings--showback"><b>Cost Savings</b></a> ·
<a href="#-roadmap"><b>Roadmap</b></a> ·
<a href="DECISIONS.md"><b>Decisions (ADRs)</b></a>

</div>

---

## Table of contents

- [<img src=".github/assets/icons/overview.svg" width="16" alt=""> Overview](#-overview)
- [<img src=".github/assets/icons/novelty.svg" width="16" alt=""> What makes it novel](#-what-makes-it-novel)
- [💰 Token Cost Savings & Showback](#-token-cost-savings--showback)
- [<img src=".github/assets/icons/architecture.svg" width="16" alt=""> Architecture](#-architecture)
- [<img src=".github/assets/icons/security.svg" width="16" alt=""> Security model](#-security-model)
- [<img src=".github/assets/icons/memory.svg" width="16" alt=""> Memory and the personalization graph](#-memory-and-the-personalization-graph)
- [<img src=".github/assets/icons/gateway.svg" width="16" alt=""> Models and the AskSage gateway](#-models-and-the-asksage-gateway)
- [<img src=".github/assets/icons/builton.svg" width="16" alt=""> Built on](#-built-on)
- [<img src=".github/assets/icons/quickstart.svg" width="16" alt=""> Quick start](#-quick-start)
- [<img src=".github/assets/icons/desktop.svg" width="16" alt=""> Desktop app](#-desktop-app)
- [<img src=".github/assets/icons/roadmap.svg" width="16" alt=""> Roadmap](#-roadmap)
- [<img src=".github/assets/icons/docs.svg" width="16" alt=""> Project docs](#-project-docs)

---

## <img src=".github/assets/icons/overview.svg" width="28" align="top" alt=""> Overview

**LucidAgentIDE** wraps [oh-my-pi (omp)](https://omp.sh) — a fast agentic coding runtime that provides
tool-calling, model routing, sessions, sandboxing, and a TUI — with the security/provenance/memory layer
from the project's v3 PRD. The wrapper rides omp's hundreds of releases instead of forking it: everything
is added through **hooks, custom tools, and the SDK**.

The whole system enforces one lifecycle, end to end:

> untrusted text enters → **scanned** → **trust-labeled** → **sanitized** → **persisted with provenance**
> → **blocked at the tool / memory-promotion / dispatch boundaries** → **human-reviewed** → and exits only
> as **safe, audited evidence** — with provenance-tracked recursive runs, replay, and a KV-cache-optimized
> prompt prefix proven by benchmark.

The architecture in one line: **TypeScript on Bun, in-process with omp.** The *only* Python is the pure
Unicode `scanner-sidecar/`, behind a narrow NDJSON contract, so the fail-closed gate that consumes it can
never fail open.

<div align="center">

| <img src=".github/assets/icons/security.svg" width="20" alt=""> Security | <img src=".github/assets/icons/memory.svg" width="20" alt=""> Provenance | <img src=".github/assets/icons/roadmap.svg" width="20" alt=""> Memory |
|:--|:--|:--|
| Unicode scanner + fail-closed quarantine gate, in-process on every tool call | Stable IDs, trust labels, and a DuckDB audit trail for every run, finding & approval | Promotion-gated semantic memory + a roadmap to a private, encrypted personalization graph |

</div>

## <img src=".github/assets/icons/novelty.svg" width="28" align="top" alt=""> What makes it novel

- **🛡️ Security *around* a moving target, not a fork.** The injection defense lives in omp extensions, so it
  upgrades with omp instead of accumulating merge debt.
- **🔒 A gate that cannot fail open.** The Unicode scanner is a pure sidecar behind an NDJSON contract; if it
  dies, times out, or returns garbage, the gate **blocks** (`trust=quarantined`). A test kills the sidecar
  mid-run and asserts the block — and stays green forever.
- **🧬 Provenance-gated memory.** Suspicious or quarantined content can **never auto-promote** into semantic
  memory (the second correctness keystone) — trust is re-derived from the source artifact, never the caller's
  claim.
- **🧊 A byte-stable, KV-cache-optimized prompt prefix.** Identity/safety/tool/security layers are frozen and
  byte-identical across requests; untrusted content only ever enters **delimited** and **after** the cache
  breakpoint — verified by a prefix-hash test and a cache-hit benchmark.
- **🏛️ A gov-grade gateway, gated.** [AskSage](https://asksage.ai) is integrated as an omp provider with an
  "AskSage-only" lockdown, **scanned** personas, and dataset-grounded RAG that returns expandable citations.
- **🧠 A personalization knowledge graph (roadmap).** A private, **FIPS-grade-encrypted**, inspectable
  node/edge graph the agent learns from you and recalls to tailor responses — security/provenance becomes a
  toggle, not the headline (see [ADR-0010](DECISIONS.md)).
- **💰 Cross-model cost tracking & showback.** Real-time per-model token usage, cache savings, and estimated
  cost with a built-in showback ledger — know exactly what every conversation costs.

---

## 💰 Token Cost Savings & Showback

<div align="center">

<table><tr><td>

> **Real-time cost visibility across every model and session.**
>
> LucidAgentIDE's **Cost & Savings Ledger** (P10.2 · [ADR-0011](DECISIONS.md)) tracks token usage,
> estimated cache savings, and per-model cost breakdowns — giving you full showback visibility over
> your AI spend. No surprises, no black-box billing.

<br/>

| Metric | Value |
|:--|--:|
| **Total Spend (all models)** | **$13.38** |
| **Est. Cache Savings** | **$26.47** *(66% off full price)* |
| **Cache Hit-Rate** | **81%** |
| **Tokens Processed** | **7.49M** across 743 turns |
| **Models Used** | **12** across 399 sessions |

<br/>

**Per-model breakdown:**

| Model | Turns | Tokens | Cost | Saved | Cache % |
|:--|--:|--:|--:|--:|--:|
| claude-opus-4-8 | 86 | 6.25M | $11.44 | $22.94 | **83%** |
| claude-opus-4-6 | 14 | 791.7k | $1.32 | $3.17 | **92%** |
| claude-sonnet-4-5 | 4 | 114.6k | $0.31 | $0.18 | 64% |
| claude-sonnet-4-6 | 4 | 141.9k | $0.30 | $0.18 | 48% |

</td></tr></table>

<img src=".github/assets/cost-savings-dashboard.png" alt="Cost & Savings Ledger — real-time cross-model token usage, cache savings, and cost showback" width="520" />

<sub><b>↑ The in-app Cost & Savings Ledger</b> — live per-model token tracking with cache-hit analysis</sub>

</div>

<br/>

**Key capabilities:**

- 📊 **Cross-model cost ledger** — unified spend view across Claude, GPT, Gemini, and all AskSage-routed models
- 💵 **Estimated cache savings** — see how much the KV-cache-optimized prompt prefix saves you in real dollars
- 📈 **Cache hit-rate tracking** — per-model cache efficiency metrics updated in real time
- 🔍 **Per-session drill-down** — break costs down by model, turn count, and token volume
- 🏷️ **Showback-ready** — built for teams that need to attribute AI costs to projects or users

---

## <img src=".github/assets/icons/architecture.svg" width="28" align="top" alt=""> Architecture

```text
harness/                  # ALL TypeScript (Bun)
  contracts.ts              # FROZEN: TrustLabel · AgentMode · EventName · ToolResult · Finding
  security/                 # scanner_client (NDJSON, fail-closed) · gate (scanAndDecide)
  memory/                   # DuckDB store · promotion gate (keystone #2) · migrations 0001–0006
  telemetry/                # stable-id event stream → DuckDB (replayable)
  runs/                     # provenance lineage · sandbox profiles · replay
  export/                   # safe_export: escaped, sanitized-only by default
  prompt/                   # the frozen prefix + delimited untrusted tail (assembler)
  omp/                      # security_extension (the in-process gate) · asksage_extension (provider)
scanner-sidecar/          # the ONLY Python (uv-managed): pure Unicode scanner + tests
desktop/                  # Electron shell + Bun dev server (chat + live dashboards)
observable/               # P10 observability: activity HUD, context windows, cost ledger
.github/                  # CI (desktop installer build) + brand assets
```

Trust boundary, layered: the **frozen prefix** (identity → tool policy → coding rules → security policy) is
cached; everything volatile — instruction files, *delimited* retrieved content, the task, session state,
working memory — lives in the **tail after the cache breakpoint**. Untrusted bytes never touch the prefix.

## <img src=".github/assets/icons/security.svg" width="28" align="top" alt=""> Security model

| Stage | Mechanism | Guarantee |
|:--|:--|:--|
| **Scan** | `scanner-sidecar/` (pure Unicode) behind NDJSON | finds zero-width, bidi, tag-block, homoglyph, PUA, `Cf` |
| **Decide** | `gate.ts` → `scanAndDecide` | any scan failure ⇒ **block / quarantine** (never "safe") |
| **Gate** | `harness/omp/security_extension.ts` (omp pre-hook) | runs **in-process** on every tool call |
| **Label** | closed set `trusted · untrusted · suspicious · quarantined` | no other values exist |
| **Promote** | `promotion_gate.ts` | suspicious/quarantined sources can't enter semantic memory |
| **Export** | `safe_export.ts` | invisibles escaped to `\u{..}`; raw referenced by `sha256`, never inline |

Try it live — a planted file hides a zero-width character in a shell command; the agent reads it, tries to
run it, and the gate blocks the `bash` call:

```
🛡️  [LucidAgentIDE] [BLOCKED tool_call:bash] source=bash trust=quarantined severity=high findings=zero-width
```

The gate that blocks here is the exact one the test suite proves — see [`CLAUDE.md`](CLAUDE.md) for the
load-bearing invariants (fail-closed, extend-don't-fork, frozen contracts, byte-stable prefix).

## <img src=".github/assets/icons/memory.svg" width="28" align="top" alt=""> Memory and the personalization graph

**Shipped.** A [DuckDB](https://duckdb.org) store (schema frozen on first write, evolved only by numbered
migrations) holds working state, archived chunks, and a **promotion-gated** semantic graph of
entities/facts/links — each fact carrying provenance and a trust label. Memory fills from ordinary turns,
and poisoned content is blocked from promotion.

**Roadmap ([ADR-0009](DECISIONS.md) / [ADR-0010](DECISIONS.md)).** A private **personalization knowledge
graph** — a Karpathy-style "second brain" of your preferences, decisions, interests, personality, and
sanitized-but-working links that the agent learns, remembers, and recalls to tailor responses. It is:

- **Opt-in** and **local-first**, stored in a dedicated **AES-256-GCM** encrypted store (key sealed by the OS
  keystore via Electron `safeStorage`, with a PBKDF2 passphrase fallback).
- **Inspectable** as an interactive, hand-drawn **SVG node/edge graph** with drill-down — exportable to an
  [Obsidian](https://obsidian.md) vault with `[[wikilinks]]`.
- **Honest about FIPS:** FIPS-*approved* algorithms + OS-keystore custody + a documented deployment checklist
  (the runtime is Bun/[BoringSSL](https://boringssl.googlesource.com/boringssl/), so there is no FIPS *mode*
  in-process — true 140-3 validation is an OS/module concern, not something the app self-certifies).

## <img src=".github/assets/icons/gateway.svg" width="28" align="top" alt=""> Models and the AskSage gateway

Models from any omp provider work out of the box (Claude, GPT, Gemini, …). On top of that, the
[**AskSage**](https://asksage.ai) accredited government AI gateway is integrated as an omp provider extension
([ADR-0007](DECISIONS.md)):

- **Lockdown mode** routes *every* turn through the gov gateway and hides direct providers.
- **Scanned personas** — server-supplied persona text passes the same Unicode scanner before it can enter a
  prompt; flagged personas are blocked.
- **Dataset-grounded RAG** via AskSage's `/query` route, returning **expandable citations** grounded on the
  knowledge bases you select.
- **Premium model picker** with per-model **Token Expense** + **Intelligence Level** ratings and a monthly
  token-quota meter.

Optionally, the on-device [**headroom**](https://github.com/chopratejas/headroom) token-compression proxy can
be enabled to stretch a gov token quota ([ADR-0008](DECISIONS.md)).

## <img src=".github/assets/icons/builton.svg" width="28" align="top" alt=""> Built on

LucidAgentIDE is a thin, principled layer over best-in-class building blocks — credit where it's due:

| Project | What it is | How LucidAgentIDE uses it |
|:--|:--|:--|
| [**oh-my-pi (omp)**](https://omp.sh) <sub>· [repo](https://github.com/can1357/oh-my-pi)</sub> | A fast agentic coding runtime: tool-calling, model routing, sessions, sandboxing, ACP, extensions, skills | The host. Everything is added via omp **hooks / custom tools / SDK** — **never a fork** |
| [**DuckDB**](https://duckdb.org) | An in-process analytical (OLAP) SQL database | The append-only **provenance + memory store** (findings, telemetry, semantic memory, run lineage) |
| [**Obsidian**](https://obsidian.md) | A local-first Markdown knowledge base with `[[wikilinks]]` + a graph view | The **export format** for the personalization knowledge graph (roadmap) |
| [**BoringSSL**](https://boringssl.googlesource.com/boringssl/) | Google's streamlined fork of OpenSSL (Bun's crypto backend) | Context for the **FIPS posture** — FIPS-approved algorithms; no FIPS *mode* in Bun's runtime |
| [**headroom**](https://github.com/chopratejas/headroom) | An on-device, OpenAI-compatible token-compression proxy (60–95% reduction) | **Opt-in** context compression to stretch gov token quotas |
| [**AskSage**](https://asksage.ai) | An accredited government generative-AI gateway fronting OpenAI/Anthropic/Google | An omp **provider extension**: lockdown, scanned personas, dataset-grounded RAG |

Runtime stack: [Bun](https://bun.sh) (harness + dev server), [Electron](https://electronjs.org) (desktop),
[uv](https://docs.astral.sh/uv/)-managed Python (scanner sidecar).

## <img src=".github/assets/icons/quickstart.svg" width="28" align="top" alt=""> Quick start

```bash
bun install                       # harness deps (Bun >= 1.3)
cd scanner-sidecar && uv sync     # pinned Python sidecar venv

# prove it end-to-end
bun run demo-00                   # omp echo round-trip + scanner + fail-closed proof
bun test harness                  # harness suite (incl. the fail-closed keystone)
bun run demo-P4.3                 # poisoned memory can't auto-promote (keystone #2)
```

Requires [Bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/). `make` is optional — the
[`Makefile`](Makefile) is the canonical task spec, mirrored as bun scripts on hosts without `make`.

## <img src=".github/assets/icons/desktop.svg" width="28" align="top" alt=""> Desktop app

A polished Electron shell: a **gated agent chat**, plus live **Security** and **Memory & Context** inspectors
(collapsible sections, custom tooltips, ⌘K palette, a non-modal fly-in toast when the gate quarantines a tool
call).

```bash
bun run desktop:web      # http://localhost:5319 — full GUI (chat + dashboards) in a browser
bun run dashboard:web    # http://localhost:4317 — dashboards only, live, read-only
cd desktop && bun install && bun run start   # the packaged Electron app
```

`desktop:web` runs the exact same renderer with a **real omp chat backend** (the dev server drives
`omp acp -e harness/omp/security_extension.ts`), so the **security gate stays loaded in-process on the chat
path** and you get genuine model replies in a plain browser — no Electron needed. See
[`desktop/README.md`](desktop/README.md) and [ADR-0006](DECISIONS.md).

### Platform Builds

CI builds desktop installers for **both platforms** on every tag push:

| Platform | Artifact | Status |
|:--|:--|:--|
| **Windows** | NSIS installer + portable `.exe` (x64) | [![Windows Build](https://img.shields.io/github/actions/workflow/status/mlcyclops/lucidagentide/build-desktop.yml?label=passing&logo=windows&logoColor=white&style=flat-square)](https://github.com/mlcyclops/lucidagentide/actions/workflows/build-desktop.yml) |
| **macOS** | `.dmg` + `.zip` (arm64 + x64 universal) | [![macOS Build](https://img.shields.io/github/actions/workflow/status/mlcyclops/lucidagentide/build-desktop.yml?label=passing&logo=apple&logoColor=white&style=flat-square)](https://github.com/mlcyclops/lucidagentide/actions/workflows/build-desktop.yml) |

Both builds bundle [Bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/) runtimes so the installed app
needs **zero prerequisites**. Code-signing and notarization are supported when certs are configured.

## <img src=".github/assets/icons/roadmap.svg" width="28" align="top" alt=""> Roadmap

**Shipped** — Increment 0–2 + Phases 2–10: the full security lifecycle, provenance lineage, replay, the
cache-optimized prefix, the desktop GUI, the AskSage gov gateway, the headroom scaffold, cross-model
observability, CUI isolation, and the knowledge graph. Everything green:
**17 demos**, **130 harness tests**, **54 sidecar tests**, `tsc --noEmit` clean.

### Recent updates

| Phase | Feature | Commit |
|:--|:--|:--|
| **P10.2** | Cross-model usage & cost ledger (ADR-0011) | `d866723` |
| **P10.1** | Response activity HUD + per-model context window | `bd30066` |
| **P9.5** | Hard CUI isolation — separate encrypted CUI store (ADR-0014) | `43be5b8` |
| **P9.4** | Audited Obsidian vault export + NARA CUI archive (ADR-0013) | `2240964` |
| **P9.3** | In-app SVG Knowledge Graph view — curved links + flow particles | `6e00efd` |
| **P9.2** | Conversation distiller + scope-aware recall (ADR-0012) | `838168b` |
| — | Binary pinning + SHA-256 verification (supply-chain hardening) | `18bbd5d` |
| — | Stalled-turn recovery — surface stuck turns instead of hanging | `93f8ece` |
| — | macOS unsigned build fix + Electron `checkout@v5` | `cd88222` |

**Next** — designed in ADRs, building one increment per session:

| Phase | Theme | ADR |
|:--|:--|:--|
| **P8.1–P8.4** | Cross-session memory recall · prompt/response traceability · Obsidian export · dev-mode logging | [ADR-0009](DECISIONS.md) |
| **P9.1–P9.4** | Encrypted personal store · model-distilled user facts · the SVG knowledge-graph view · vault export | [ADR-0010](DECISIONS.md) |

See [`PROGRESS.md`](PROGRESS.md) for the per-session log (shipped / stubbed / next).

## <img src=".github/assets/icons/docs.svg" width="28" align="top" alt=""> Project docs

| Doc | What's in it |
|:--|:--|
| [`CLAUDE.md`](CLAUDE.md) | **Read first.** The load-bearing invariants (fail-closed, extend-don't-fork, frozen contracts, byte-stable prefix) |
| [`DECISIONS.md`](DECISIONS.md) | Architecture decision records (ADR-0001 … ADR-0015) |
| [`PROGRESS.md`](PROGRESS.md) | Per-session build log: shipped / stubbed / next |
| [`desktop/README.md`](desktop/README.md) | The desktop GUI + dev server |
| [`CHEATSHEET.md`](CHEATSHEET.md) | Day-to-day commands |

<div align="center">
<br/>
<sub>Built around <a href="https://omp.sh">oh-my-pi</a> · extend, never fork · fail-closed by construction</sub>
<br/>
<sub>© 2026 <a href="https://x.com/TechLead187">@TechLead187</a> · All Rights Reserved</sub>
</div>
