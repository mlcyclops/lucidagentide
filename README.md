<!--
  SEO / discovery metadata. GitHub renders this block invisibly; search engines, raw-file
  crawlers, and AI agents that read README.md pick it up. Repo TOPICS (set in repo settings)
  are the strongest GitHub-search signal - mirror these keywords there too.

  LucidAgentIDE - a fail-closed security, provenance, and memory layer around oh-my-pi (omp).
  Topics: ai-agent-security, prompt-injection-defense, llm-security, agent-observability,
  provenance, duckdb, kv-cache, prompt-caching, asksage, government-ai, cui, fips,
  personalization-knowledge-graph, ai-code-attribution, cost-showback, chatgpt-import,
  monaco, electron, bun, typescript, oh-my-pi, omp, agentic-coding, secure-ai-coding-assistant.
-->
<meta name="description" content="LucidAgentIDE - a fail-closed security, provenance, and memory layer around oh-my-pi (omp): prompt-injection defense, trust labeling, provenance-backed memory, sovereignty-aware model governance, AI-authorship attribution, one-command ChatGPT/Claude/Gemini migration, cross-model cost showback, and a read-write IDE where even Save is scanned." />
<meta name="keywords" content="AI agent security, prompt injection defense, fail-closed gate, Unicode scanner, LLM provenance, agent observability, DuckDB telemetry, KV-cache prompt optimization, prompt caching, AskSage government AI gateway, CUI, FIPS, personalization knowledge graph, AI code attribution, AI-authored lines of code, cross-model cost showback, ChatGPT import, Claude, Gemini, Monaco editor, Electron, Bun, TypeScript, oh-my-pi, omp, agentic coding, secure AI coding assistant, agent IDE" />
<meta name="robots" content="index, follow, max-image-preview:large" />
<meta name="googlebot" content="index, follow" />
<meta name="author" content="Nick Chadwick (TechLead187)" />

<div align="center">

<img src=".github/assets/techlead187-avatar.png" alt="TechLead187 - Nick Chadwick, creator of LucidAgentIDE" width="160" style="border-radius: 50%;" />

<br/>

<img src=".github/assets/banner.svg" alt="LucidAgentIDE - a fail-closed security, provenance and memory harness around oh-my-pi" width="100%" />

<br/>

<a href="https://github.com/mlcyclops/lucidagentide/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/mlcyclops/lucidagentide/ci.yml?branch=master&label=CI&logo=github&logoColor=white&style=flat-square" alt="CI" /></a>
<a href="https://github.com/mlcyclops/lucidagentide/actions/workflows/codeql.yml"><img src="https://img.shields.io/github/actions/workflow/status/mlcyclops/lucidagentide/codeql.yml?branch=master&label=CodeQL&logo=github&logoColor=white&style=flat-square" alt="CodeQL SAST" /></a>
<a href="https://github.com/mlcyclops/lucidagentide/actions/workflows/build-desktop.yml"><img src="https://img.shields.io/github/actions/workflow/status/mlcyclops/lucidagentide/build-desktop.yml?label=Windows%20Build&logo=windows&logoColor=white&style=flat-square" alt="Windows Build" /></a>
<a href="https://github.com/mlcyclops/lucidagentide/actions/workflows/build-desktop.yml"><img src="https://img.shields.io/github/actions/workflow/status/mlcyclops/lucidagentide/build-desktop.yml?label=macOS%20Build&logo=apple&logoColor=white&style=flat-square" alt="macOS Build" /></a>
<img src="https://img.shields.io/badge/tests-473%20harness%20%2B%20326%20desktop%20%2B%2055%20sidecar-46d27e?style=flat-square" alt="tests" />
<img src="https://img.shields.io/badge/gate-fail--closed-e07bf0?style=flat-square" alt="fail-closed gate" />

<br/>

<a href="https://github.com/mlcyclops/lucidagentide/releases/latest/download/LucidAgentIDE-Setup.exe"><img src="https://img.shields.io/badge/Download-Windows%20Installer-2ea44f?style=for-the-badge&logo=windows&logoColor=white" alt="Download Windows installer (latest release)" /></a>
<a href="https://github.com/mlcyclops/lucidagentide/releases/latest/download/LucidAgentIDE-mac-arm64.zip"><img src="https://img.shields.io/badge/Download-macOS%20Apple%20Silicon-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS Apple Silicon (latest release)" /></a>
<a href="https://github.com/mlcyclops/lucidagentide/releases/latest/download/LucidAgentIDE-mac-x64.zip"><img src="https://img.shields.io/badge/macOS-Intel-555555?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS Intel (latest release)" /></a>
<a href="https://github.com/mlcyclops/lucidagentide/releases/latest"><img src="https://img.shields.io/github/v/release/mlcyclops/lucidagentide?label=latest&style=for-the-badge&color=c64bd6&sort=semver" alt="Latest release version" /></a>

<sub>⬆ Always the most recent successful release - links auto-update each version (no release yet? they appear after the first tagged build).</sub>

<br/>

<img src="https://img.shields.io/badge/Bun-%E2%89%A51.3-fbf0df?style=flat-square&logo=bun&logoColor=black" alt="Bun" />
<img src="https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
<img src="https://img.shields.io/badge/Electron-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" />
<img src="https://img.shields.io/badge/DuckDB-FFF000?style=flat-square&logo=duckdb&logoColor=black" alt="DuckDB" />

<br/>

**A security · provenance · memory layer built _around_ <a href="https://omp.sh">oh-my-pi</a> - not a fork.**
A fail-closed prompt-injection gate, provenance-backed memory, **sovereignty-aware model governance**,
**AI-authorship attribution**, **one-command migration from ChatGPT**, and a **read-write IDE where even
_Save_ is scanned** - wrapped in a polished desktop app, added entirely through omp's hooks, custom tools,
and SDK.

<sub>🔒 <b>What it does is open; how the hard parts work is not.</b> The deepest trust, provenance, and
personalization internals are proprietary and intentionally undocumented here - this README describes the
<i>capabilities and guarantees</i>, not the mechanisms behind them.</sub>

<a href="#-who-its-for"><b>Who it's for</b></a> ·
<a href="#-quick-start"><b>Quick start</b></a> ·
<a href="#-security-model"><b>Security</b></a> ·
<a href="#-token-cost-savings--showback"><b>Cost Savings</b></a> ·
<a href="#-knowledge--rag-coming-soon"><b>Knowledge / RAG</b></a> ·
<a href="#-contributing"><b>Contributing</b></a> ·
<a href="#-roadmap"><b>Roadmap</b></a> ·
<a href="DECISIONS.md"><b>Decisions (ADRs)</b></a>

</div>

---

## Table of contents

- [<img src=".github/assets/icons/overview.svg" width="16" alt=""> Overview](#-overview)
- [<img src=".github/assets/icons/novelty.svg" width="16" alt=""> What makes it novel](#-what-makes-it-novel)
- [🎯 Who it's for](#-who-its-for)
- [💰 Token Cost Savings & Showback](#-token-cost-savings--showback)
- [<img src=".github/assets/icons/architecture.svg" width="16" alt=""> Architecture](#-architecture)
- [<img src=".github/assets/icons/security.svg" width="16" alt=""> Security model](#-security-model)
- [<img src=".github/assets/icons/memory.svg" width="16" alt=""> Memory and the personalization graph](#-memory-and-the-personalization-graph)
- [<img src=".github/assets/icons/gateway.svg" width="16" alt=""> Models and the AskSage gateway](#-models-and-the-asksage-gateway)
- [📚 Knowledge & RAG (Coming Soon)](#-knowledge--rag-coming-soon)
- [<img src=".github/assets/icons/builton.svg" width="16" alt=""> Built on](#-built-on)
- [<img src=".github/assets/icons/quickstart.svg" width="16" alt=""> Quick start](#-quick-start)
- [<img src=".github/assets/icons/desktop.svg" width="16" alt=""> Desktop app](#-desktop-app)
- [🤝 Contributing](#-contributing)
- [<img src=".github/assets/icons/roadmap.svg" width="16" alt=""> Roadmap](#-roadmap)
- [<img src=".github/assets/icons/docs.svg" width="16" alt=""> Project docs](#-project-docs)

---

## <img src=".github/assets/icons/overview.svg" width="28" align="top" alt=""> Overview

**LucidAgentIDE** wraps [oh-my-pi (omp)](https://omp.sh) - a fast agentic coding runtime that provides
tool-calling, model routing, sessions, sandboxing, and a TUI - with the security/provenance/memory layer
from the project's v3 PRD. The wrapper rides omp's hundreds of releases instead of forking it: everything
is added through **hooks, custom tools, and the SDK**.

The whole system enforces one lifecycle, end to end:

> untrusted text enters → **scanned** → **trust-labeled** → **sanitized** → **persisted with provenance**
> → **blocked at the tool / memory-promotion / dispatch boundaries** → **human-reviewed** → and exits only
> as **safe, audited evidence** - with provenance-tracked recursive runs, replay, and a KV-cache-optimized
> prompt prefix proven by benchmark.

The architecture in one line: **TypeScript on Bun, in-process with omp.** The *only* Python is the pure
Unicode `scanner-sidecar/`, behind a narrow NDJSON contract, so the fail-closed gate that consumes it can
never fail open.

<div align="center">

| <img src=".github/assets/icons/security.svg" width="20" alt=""> Security | <img src=".github/assets/icons/memory.svg" width="20" alt=""> Provenance | <img src=".github/assets/icons/roadmap.svg" width="20" alt=""> Memory |
|:--|:--|:--|
| Unicode scanner + fail-closed quarantine gate, in-process on every tool call | Stable IDs, trust labels, and a DuckDB audit trail for every run, finding & approval | Promotion-gated semantic memory **+ a shipped, encrypted, cross-session personalization graph** |

</div>

## <img src=".github/assets/icons/novelty.svg" width="28" align="top" alt=""> What makes it novel

- **🛡️ Security *around* a moving target, not a fork.** The injection defense lives in omp extensions, so it
  upgrades with omp instead of accumulating merge debt.
- **🔒 A gate that cannot fail open.** The Unicode scanner is a pure sidecar behind an NDJSON contract; if it
  dies, times out, or returns garbage, the gate **blocks** (`trust=quarantined`). A test kills the sidecar
  mid-run and asserts the block - and stays green forever.
- **🧬 Provenance-gated memory.** Suspicious or quarantined content can **never auto-promote** into semantic
  memory (the second correctness keystone) - trust is re-derived from the source artifact, never the caller's
  claim.
- **🧊 A byte-stable, KV-cache-optimized prompt prefix.** Identity/safety/tool/security layers are frozen and
  byte-identical across requests; untrusted content only ever enters **delimited** and **after** the cache
  breakpoint - verified by a prefix-hash test and a cache-hit benchmark.
- **🏛️ A gov-grade gateway, gated.** [AskSage](https://asksage.ai) is integrated as an omp provider with an
  "AskSage-only" lockdown, **scanned** personas, and dataset-grounded RAG that returns expandable citations.
- **🧠 An encrypted personalization knowledge graph (shipped).** A private, **FIPS-grade-encrypted**,
  inspectable node/edge graph the agent learns from you and **recalls across sessions** to tailor responses -
  CUI-isolated, compartmentalized (work / personal / CUI), and exportable to an Obsidian vault.
- **🪪 AI-authorship attribution.** A tamper-evident ledger of *which model wrote which lines* - per repo, per
  identity, per session - so AI-generated code is governable, auditable, and attributable. The attribution
  engine is *proprietary*; the dashboard over it is in-app.
- **🌐 Sovereignty-aware model governance.** Gov-only lockdown, accredited-gateway gating, curated gov-model
  lists, and an explicit **data-sovereignty acknowledgment wall** for foreign-origin models - choose raw
  capability *and* provenance, by policy, not by accident.
- **⬇️ One-command migration from ChatGPT / Claude / Gemini.** Bring years of history in; **every message is
  scanned through the fail-closed gate** and distilled into your encrypted personal graph - onboard a new user
  in minutes, with a token/runtime estimate before any model call.
- **✍️ A read-write IDE where _Save_ is gated.** Edit code in an embedded editor and save it back through the
  *same* in-process scanner - a hidden-Unicode payload is **blocked before a single byte lands on disk**.
- **🔁 Loop engineering, not just a loop.** The `/goal` primitive iterates an agent to a **verifiable** stop
  condition with a **separate, cheaper checker model**, durable on-disk memory, and resume - then adds the
  operational spine unattended loops actually need: a **budget kill switch** (a hard `$` ceiling that aborts
  the run mid-turn before the bill runs away), **convergence-stall + tool-failure guards** that stop a loop
  spinning on the same blocker, an **After-Action Report** (portable Mermaid graphs of tool calls, LOC,
  errors, and sites visited - rendered straight on GitHub/VS Code), and a **cross-run evaluation ledger**
  (success rate, avg iterations-to-win, failure breakdown). Inspired by the
  [loop-engineering](https://github.com/cobusgreyling/loop-engineering) playbook; every action still passes
  the fail-closed gate.
- **💰 Cross-model cost tracking & showback.** Real-time per-model token usage, cache savings, and estimated
  cost with a built-in showback ledger - know exactly what every conversation costs.

---

## 🎯 Who it's for

| If you are… | Why it matters here |
|:--|:--|
| **Government / regulated / CUI teams** | An AskSage-gated, **sovereignty-aware** agent with hard **CUI isolation**, a fail-closed gate, and a full provenance/audit trail - packaged for **locked-down, air-gapped laptops** with *zero prerequisites* (Bun + the Python sidecar are bundled). |
| **Security-conscious engineers** | Every tool call, **every _Save_**, every persona, and every imported message is scanned by a gate that **cannot fail open**. Prompt-injection defense is the default, not a toggle. |
| **Teams that need governance & showback** | Real **cost per model** with cache-savings showback, plus a tamper-evident ledger of **which model wrote which lines** - so AI spend and AI authorship are both auditable. |
| **Anyone leaving ChatGPT / Claude / Gemini** | **One-command import** brings your history in (gated + distilled into an encrypted personal graph) and keeps your context **across sessions**. |
| **Agent-platform builders** | A worked, test-backed example of adding security, provenance, and memory **around** a fast runtime via hooks/tools/SDK - **extend, never fork**. |

It's a **desktop app you can just download and run** (Windows installer/portable + macOS), and a **source-available codebase** you can study, run from source, and build on.

## 💰 Token Cost Savings & Showback

<div align="center">

<table><tr><td>

> **Real-time cost visibility across every model and session.**
>
> LucidAgentIDE's **Cost & Savings Ledger** (P10.2 · [ADR-0011](DECISIONS.md)) tracks token usage,
> estimated cache savings, and per-model cost breakdowns - giving you full showback visibility over
> your AI spend. No surprises, no black-box billing.

<br/>

| Metric | Value |
|:--|--:|
| **Total Spend (all models)** | **$35.73** |
| **Est. Cache Savings** | **$73.66** *(67% off full price)* |
| **Cache Hit-Rate** | **82%** |
| **Tokens Processed** | **21.34M** across 1,998 turns |
| **Models Used** | **29** across 1,041 sessions |

<br/>

**Per-model breakdown** *(top models · 24 more in the ledger):*

| Model | Turns | Tokens | Cost | Saved | Cache % |
|:--|--:|--:|--:|--:|--:|
| claude-opus-4-8 | 242 | 18.26M | $32.51 | $67.89 | **84%** |
| claude-opus-4-6 | 14 | 791.7k | $1.32 | $3.17 | **92%** |
| gpt-5.5 | 21 | 659.8k | $1.15 | $2.24 | 76% |
| claude-sonnet-4-5 | 4 | 114.6k | $0.31 | $0.18 | 64% |
| claude-sonnet-4-6 | 4 | 141.9k | $0.30 | $0.18 | 48% |

</td></tr></table>

<table>
<tr>
<td align="center" valign="top">
<img src=".github/assets/cost-savings-dashboard.png" alt="LucidAgentIDE Cost & Savings Ledger - real-time cross-model token usage, estimated prompt-cache savings, cache hit-rate, and per-model cost showback" width="420" />
<br/>
<sub><b>↑ Cost &amp; Savings Ledger</b> - spend, cache savings, and cost per model, live</sub>
</td>
<td align="center" valign="top">
<img src=".github/assets/ai-loc-dashboard.png" alt="LucidAgentIDE AI-authored code ledger - lines of code attributed per model, repo, and identity (AI authorship attribution / provenance)" width="420" />
<br/>
<sub><b>↑ AI-authored Code Ledger</b> - which model wrote which lines, by repo &amp; identity</sub>
</td>
</tr>
</table>

</div>

<br/>

**Key capabilities:**

- 📊 **Cross-model cost ledger** - unified spend view across Claude, GPT, Gemini, and all AskSage-routed models
- 💵 **Estimated cache savings** - see how much the KV-cache-optimized prompt prefix saves you in real dollars
- 📈 **Cache hit-rate tracking** - per-model cache efficiency metrics updated in real time
- 🔍 **Per-session drill-down** - break costs down by model, turn count, and token volume
- 🏷️ **Showback-ready** - built for teams that need to attribute AI costs to projects or users
- 🪪 **AI-authored code ledger** - a tamper-evident count of *which model wrote which lines*, per repo and identity (authorship attribution, not just git activity)

> **🏛️ Enterprise rollups (premium, coming soon).** A separately-licensed add-on rolls this showback
> up into executive **BI dashboards** - Power BI (GCC-High), QuickSight, Looker, SharePoint, or an
> airgap-friendly single-file HTML view - and adds **loop-efficiency and ROI** reporting per model and
> per program: cost-per-outcome, productivity, and security posture in one pane for the CFO / CIO / CISO.
> Read-only and **metadata-only** by construction (no code, prompts, or CUI leave the host); the
> analytics methodology is proprietary.

---

## <img src=".github/assets/icons/architecture.svg" width="28" align="top" alt=""> Architecture

```text
harness/                  # ALL TypeScript (Bun)
  contracts.ts              # FROZEN: TrustLabel · AgentMode · EventName · ToolResult · Finding
  security/                 # scanner_client (NDJSON, fail-closed) · gate (scanAndDecide)
  memory/                   # DuckDB store · promotion gate (keystone #2) · cross-session recall · migrations 0001-0009
  personal/                 # encrypted personalization graph · distiller · CUI isolation · ChatGPT/Claude/Gemini import
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
cached; everything volatile - instruction files, *delimited* retrieved content, the task, session state,
working memory - lives in the **tail after the cache breakpoint**. Untrusted bytes never touch the prefix.

## <img src=".github/assets/icons/security.svg" width="28" align="top" alt=""> Security model

| Stage | Mechanism | Guarantee |
|:--|:--|:--|
| **Scan** | `scanner-sidecar/` (pure Unicode) behind NDJSON | finds zero-width, bidi, tag-block, homoglyph, PUA, `Cf` |
| **Decide** | `gate.ts` → `scanAndDecide` | any scan failure ⇒ **block / quarantine** (never "safe") |
| **Gate** | `harness/omp/security_extension.ts` (omp pre-hook) | runs **in-process** on every tool call |
| **Label** | closed set `trusted · untrusted · suspicious · quarantined` | no other values exist |
| **Promote** | `promotion_gate.ts` | suspicious/quarantined sources can't enter semantic memory |
| **Export** | `safe_export.ts` | invisibles escaped to `\u{..}`; raw referenced by `sha256`, never inline |

Try it live - a planted file hides a zero-width character in a shell command; the agent reads it, tries to
run it, and the gate blocks the `bash` call:

```
🛡️  [LucidAgentIDE] [BLOCKED tool_call:bash] source=bash trust=quarantined severity=high findings=zero-width
```

The gate that blocks here is the exact one the test suite proves - see [`CLAUDE.md`](CLAUDE.md) for the
load-bearing invariants (fail-closed, extend-don't-fork, frozen contracts, byte-stable prefix).

## <img src=".github/assets/icons/memory.svg" width="28" align="top" alt=""> Memory and the personalization graph

**Shipped.** A [DuckDB](https://duckdb.org) store (schema frozen on first write, evolved only by numbered
migrations) holds working state, archived chunks, and a **promotion-gated** semantic graph of
entities/facts/links - each fact carrying provenance and a trust label. Memory fills from ordinary turns,
and poisoned content is blocked from promotion.

**Shipped ([ADR-0009](DECISIONS.md) / [ADR-0010](DECISIONS.md)).** A private **personalization knowledge
graph** - a "second brain" of your preferences, decisions, interests, personality, and sanitized-but-working
links that the agent learns, **recalls across sessions**, and uses to tailor responses (and that you can seed
in minutes by importing an existing ChatGPT / Claude / Gemini history). It is:

- **Opt-in** and **local-first**, stored in a dedicated **AES-256-GCM** encrypted store (key sealed by the OS
  keystore via Electron `safeStorage`, with a PBKDF2 passphrase fallback).
- **Inspectable** as an interactive, hand-drawn **SVG node/edge graph** with drill-down - exportable to an
  [Obsidian](https://obsidian.md) vault with `[[wikilinks]]`.
- **Honest about FIPS:** FIPS-*approved* algorithms + OS-keystore custody + a documented deployment checklist
  (the runtime is Bun/[BoringSSL](https://boringssl.googlesource.com/boringssl/), so there is no FIPS *mode*
  in-process - true 140-3 validation is an OS/module concern, not something the app self-certifies).

## <img src=".github/assets/icons/gateway.svg" width="28" align="top" alt=""> Models and the AskSage gateway

Models from any omp provider work out of the box (Claude, GPT, Gemini, …). On top of that, the
[**AskSage**](https://asksage.ai) accredited government AI gateway is integrated as an omp provider extension
([ADR-0007](DECISIONS.md)):

- **Lockdown mode** routes *every* turn through the gov gateway and hides direct providers.
- **Scanned personas** - server-supplied persona text passes the same Unicode scanner before it can enter a
  prompt; flagged personas are blocked.
- **Dataset-grounded RAG** via AskSage's `/query` route, returning **expandable citations** grounded on the
  knowledge bases you select.
- **Premium model picker** with per-model **Token Expense** + **Intelligence Level** ratings and a monthly
  token-quota meter.

Optionally, the on-device [**headroom**](https://github.com/chopratejas/headroom) token-compression proxy can
be enabled to stretch a gov token quota ([ADR-0008](DECISIONS.md)).

## 📚 Knowledge & RAG (Coming Soon)

> **Designed in [ADR-0053](DECISIONS.md); building next as `P-RAG.1-4`.** Bring your own documents into the
> agent's context - **two paths, one trust boundary**, both scanned by the same fail-closed gate.

- **🔒 Local-first vector store (air-gapped).** Drag in PDFs and images; they're parsed, embedded, and indexed
  **entirely on your machine** in a local [DuckDB](https://duckdb.org) vector store - **no document ever leaves
  the host.** Retrieved chunks are injected as **scanned, delimited, untrusted context** (never the cached
  prefix), so RAG can't become a prompt-injection vector.
- **🖼️ PDF + image ingest.** Local PDF text extraction, plus **caption-at-ingest** for images - the multimodal
  model describes each image (with optional on-device OCR) and the image is kept for multimodal prompts.
- **💻 Built for a standard laptop.** WASM embeddings (**no GPU, no native binaries**), **bundled weights** so it
  works fully **offline**, and brute-force cosine that stays **sub-millisecond** at realistic sizes - an HNSW
  accelerator is held in reserve for very large corpora.
- **🏛️ AskSage dataset training (gov cloud), classification-aware.** Civ users can create **custom-named
  datasets** and ingest files straight into the AskSage gateway - and **CUI content is never sent to a Civ
  endpoint**. The UI tells you *where your data goes and why*.
- **🧭 One guided popup.** A walkthrough (with an advanced one-screen mode), premium hover help at every step,
  and a **parse-and-scan preview** that shows what was extracted - and the gate verdict - *before* anything is
  stored.

Every ingested chunk runs the **same lifecycle as everything else**: scanned → trust-labeled → quarantined if
poisoned - *before* it can ever be embedded or recalled. Suspicious sources can't auto-promote into semantic
memory (keystone #2 holds for RAG too).

## <img src=".github/assets/icons/builton.svg" width="28" align="top" alt=""> Built on

LucidAgentIDE is a thin, principled layer over best-in-class building blocks - credit where it's due:

| Project | What it is | How LucidAgentIDE uses it |
|:--|:--|:--|
| [**oh-my-pi (omp)**](https://omp.sh) <sub>· [repo](https://github.com/can1357/oh-my-pi)</sub> | A fast agentic coding runtime: tool-calling, model routing, sessions, sandboxing, ACP, extensions, skills | The host. Everything is added via omp **hooks / custom tools / SDK** - **never a fork** |
| [**DuckDB**](https://duckdb.org) | An in-process analytical (OLAP) SQL database | The append-only **provenance + memory store** (findings, telemetry, semantic memory, run lineage) |
| [**Obsidian**](https://obsidian.md) | A local-first Markdown knowledge base with `[[wikilinks]]` + a graph view | The **export format** for the personalization knowledge graph (roadmap) |
| [**BoringSSL**](https://boringssl.googlesource.com/boringssl/) | Google's streamlined fork of OpenSSL (Bun's crypto backend) | Context for the **FIPS posture** - FIPS-approved algorithms; no FIPS *mode* in Bun's runtime |
| [**headroom**](https://github.com/chopratejas/headroom) | An on-device, OpenAI-compatible token-compression proxy (60-95% reduction) | **Opt-in** context compression to stretch gov token quotas |
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

Requires [Bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/). `make` is optional - the
[`Makefile`](Makefile) is the canonical task spec, mirrored as bun scripts on hosts without `make`.

## <img src=".github/assets/icons/desktop.svg" width="28" align="top" alt=""> Desktop app

A polished Electron shell: a **gated agent chat**, plus live **Security** and **Memory & Context** inspectors
(collapsible sections, custom tooltips, ⌘K palette, a non-modal fly-in toast when the gate quarantines a tool
call).

```bash
bun run desktop:web      # http://localhost:5319 - full GUI (chat + dashboards) in a browser
bun run dashboard:web    # http://localhost:4317 - dashboards only, live, read-only
cd desktop && bun install && bun run start   # the packaged Electron app
```

`desktop:web` runs the exact same renderer with a **real omp chat backend** (the dev server drives
`omp acp -e harness/omp/security_extension.ts`), so the **security gate stays loaded in-process on the chat
path** and you get genuine model replies in a plain browser - no Electron needed. See
[`desktop/README.md`](desktop/README.md) and [ADR-0006](DECISIONS.md).

### Platform Builds

CI builds desktop installers for **both platforms** on every tag push:

| Platform | Artifact | Status | Download (latest release) |
|:--|:--|:--|:--|
| **Windows** | NSIS installer + portable `.exe` (x64) | [![Windows Build](https://img.shields.io/github/actions/workflow/status/mlcyclops/lucidagentide/build-desktop.yml?label=passing&logo=windows&logoColor=white&style=flat-square)](https://github.com/mlcyclops/lucidagentide/actions/workflows/build-desktop.yml) | [**Installer**](https://github.com/mlcyclops/lucidagentide/releases/latest/download/LucidAgentIDE-Setup.exe) · [Portable](https://github.com/mlcyclops/lucidagentide/releases/latest/download/LucidAgentIDE-portable.exe) |
| **macOS** | `.zip` app bundle (arm64 + x64) | [![macOS Build](https://img.shields.io/github/actions/workflow/status/mlcyclops/lucidagentide/build-desktop.yml?label=passing&logo=apple&logoColor=white&style=flat-square)](https://github.com/mlcyclops/lucidagentide/actions/workflows/build-desktop.yml) | [**Apple Silicon**](https://github.com/mlcyclops/lucidagentide/releases/latest/download/LucidAgentIDE-mac-arm64.zip) · [Intel](https://github.com/mlcyclops/lucidagentide/releases/latest/download/LucidAgentIDE-mac-x64.zip) |

Both builds bundle [Bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/) runtimes so the installed app
needs **zero prerequisites**. Code-signing and notarization are supported when certs are configured.

> **macOS:** the download is a zipped `LucidAgentIDE.app` - unzip it and drag the app into **Applications**.
> (Builds ship as `.zip` rather than `.dmg`; in-app auto-update uses the same zip feed.)

## <img src=".github/assets/icons/roadmap.svg" width="28" align="top" alt=""> Roadmap

**Shipped** - Increment 0-2 + Phases 2-10 + the personalization, attribution, migration, and IDE phases:
the full security lifecycle, provenance lineage, replay, the cache-optimized prefix, the desktop GUI, the
AskSage gov gateway, cross-model observability, CUI isolation, the encrypted personalization graph with
cross-session recall, AI-authorship attribution, one-command ChatGPT/Claude/Gemini migration, and a
read-write IDE with gated saves, AskSage **tool use on the gov gateway** (Claude *and* Gemini), and the
**`/goal` agentic loop** with full loop-engineering instrumentation - After-Action Reports, a budget kill
switch, convergence/tool-failure guards, and a cross-run evaluation ledger. Everything green:
**473 harness tests**, **326 desktop tests**, **55 sidecar tests**, `tsc --noEmit` clean across 3 projects
(TypeScript 6.0 + Python).

### Recent updates

| Phase | Feature | ADR |
|:--|:--|:--|
| **P-GOAL.9-11** | **Loop engineering** for the `/goal` loop - an **After-Action Report** (Mermaid graphs: tool calls by type, LOC ±, errors, sites visited), **convergence-stall + tool-failure guards**, a **cross-run evaluation ledger** (success rate / avg iterations-to-win / failure breakdown), and a **budget kill switch** (a hard `$` cap that aborts an unattended run mid-turn) | [ADR-0054-0056](DECISIONS.md) |
| **P-GOAL.1-8** | The **`/goal` agentic loop** - iterate to a verifiable stop condition with a separate (cheaper, recommended) checker model, durable on-disk memory, resume, scheduled automations, a cost estimate, and a guided walkthrough | [ADR-0046-0050](DECISIONS.md) |
| **AskSage tool use** | Claude **and** Gemini routed through the **gov gateway can now use omp tools** (write files, run commands) - the streamSimple adapter parses tool calls + scans each through the gate | [ADR-0051](DECISIONS.md) |
| **P-IDE.5-6** | Read-write Monaco IDE - **Save routed through the scanner gate** (≥high finding or dead scanner *blocks* the write), Save-As, conflict banner, Send-to-chat | [ADR-0036/0037](DECISIONS.md) |
| **P-IMP.1-2** | One-command **ChatGPT/Claude/Gemini import** - shard-aware, fully gated, with a first-run onboarding nudge + token/runtime estimate | [ADR-0034/0035](DECISIONS.md) |
| **P-LOC.1-2** | **AI-authorship attribution** - per-model/repo/identity LOC ledger + dashboard rollup | [ADR-0031](DECISIONS.md) |
| **P-IDE.1** | Sovereignty-aware **model governance** - gov curation, accredited-gateway gating, foreign-origin acknowledgment wall | [ADR-0029](DECISIONS.md) |
| **P8.1** | **Cross-session memory recall** - prior-session facts resurface as delimited, post-cache context | [ADR-0009](DECISIONS.md) |
| **P9.5** | Hard CUI isolation - separate encrypted CUI store | [ADR-0014](DECISIONS.md) |
| **P10.2** | Cross-model usage & cost ledger | [ADR-0011](DECISIONS.md) |

**Next** - designed in ADRs, building one increment per session:

| Theme | ADR |
|:--|:--|
| **Knowledge & RAG** - local PDF/image ingest into an air-gapped DuckDB vector store + AskSage dataset training | [ADR-0053](DECISIONS.md) |
| Prompt/response traceability · dev-mode logging deepening | [ADR-0009](DECISIONS.md) |

See [`PROGRESS.md`](PROGRESS.md) for the per-session log (shipped / stubbed / next).

## 🤝 Contributing

Built in the open, **one disciplined increment at a time.** If you want to run it from source, file an issue,
or propose a change, start here:

- **Read [`CLAUDE.md`](CLAUDE.md) first.** It's the load-bearing contract - fail-closed, **extend omp (don't
  fork)**, frozen contracts, a byte-stable prompt prefix. A change that silently breaks an invariant won't land.
- **ADR-first.** Non-trivial work begins as an ADR in [`DECISIONS.md`](DECISIONS.md) (**53 and counting**) -
  scope, decision, alternatives, invariants preserved. The whole roadmap is designed this way; pick one up or
  propose your own.
- **One increment per change** - small, verifiable, with a demo + tests. See [`PROGRESS.md`](PROGRESS.md) for
  the cadence and [`CHEATSHEET.md`](CHEATSHEET.md) for day-to-day commands.
- **Tests are the gate.** `bun test harness && bun test desktop` stay green, `tsc --noEmit` is clean across all
  projects, and any prompt-prefix change must pass the prefix-hash test. CI runs the build + CodeQL on every push.
- **The only Python is the scanner sidecar.** Everything else is TypeScript on Bun - please don't add a second
  Python surface.

**Good first areas:** the desktop GUI + dev server, scanner fixtures, docs/wording, and platform/build
robustness (Windows + macOS installers).

> **License & boundary.** This repo is shared publicly for **transparency and evaluation**. The *capabilities
> and guarantees* are open; the deepest **trust, provenance, and personalization mechanisms are proprietary**
> (© 2026 Nick Chadwick - **All Rights Reserved**; no open-source license is granted). Please **open an issue or
> discussion before any large change** so we can align on scope and contribution terms.

## <img src=".github/assets/icons/docs.svg" width="28" align="top" alt=""> Project docs

| Doc | What's in it |
|:--|:--|
| [`CLAUDE.md`](CLAUDE.md) | **Read first.** The load-bearing invariants (fail-closed, extend-don't-fork, frozen contracts, byte-stable prefix) |
| [`DECISIONS.md`](DECISIONS.md) | Architecture decision records (ADR-0001 … ADR-0053) |
| [`PROGRESS.md`](PROGRESS.md) | Per-session build log: shipped / stubbed / next |
| [`desktop/README.md`](desktop/README.md) | The desktop GUI + dev server |
| [`CHEATSHEET.md`](CHEATSHEET.md) | Day-to-day commands |

<div align="center">
<br/>
<sub>Built around <a href="https://omp.sh">oh-my-pi</a> · extend, never fork · fail-closed by construction</sub>
<br/>
<a href="https://www.linkedin.com/in/nickchadwick-techlead187/"><img src="https://img.shields.io/badge/Connect%20on-LinkedIn-0A66C2?style=flat-square&logo=linkedin&logoColor=white" alt="Connect with Nick Chadwick on LinkedIn" /></a>
<a href="https://x.com/TechLead187"><img src="https://img.shields.io/badge/Follow-%40TechLead187-1DA1F2?style=flat-square&logo=x&logoColor=white" alt="Follow @TechLead187 on X" /></a>
<br/>
<sub>© 2026 Nick Chadwick (<a href="https://www.linkedin.com/in/nickchadwick-techlead187/">LinkedIn</a> · <a href="https://x.com/TechLead187">@TechLead187</a>) · All Rights Reserved</sub>
</div>
