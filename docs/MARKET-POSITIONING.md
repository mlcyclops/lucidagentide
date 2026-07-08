# LUCID Agent IDE - Market Positioning

> A public, qualitative slice of the positioning analysis. The quantitative half - segment sizing, the
> full competitive matrix, and the positioning graphic - is maintained in the enterprise add-on
> repository for engagement use; this document is the part that is safe and useful to state in the open.
> Nothing here is a forward-looking financial claim.

## The category

AI coding is consolidating into two poles:

1. **General AI coding assistants** - cloud-first, single-vendor-model, optimized for individual
   developer velocity. Security, provenance, and data-sovereignty are add-ons or roadmap items.
2. **Regulated / sovereign engineering** - government, defense, healthcare, finance, and critical
   infrastructure, where an agent that can write files and run commands is only adoptable if it is
   auditable, containable, model-agnostic, and deployable on locked-down or air-gapped machines.

**LUCID is built for the second pole while remaining a genuinely good tool for the first.** We call the
segment the **secure / sovereign agentic IDE**: the agent-native developer experience of the modern AI
IDE, wrapped in the assurance layer regulated buyers actually require.

## The wedge - what the open core does that general AI IDEs treat as an afterthought

| Capability | Why it is the differentiator |
|:--|:--|
| **Fail-closed security gate on every tool call** | Every tool call, every file save, every imported message, and every MCP tool result is scanned *before* it takes effect. The gate cannot fail open - "scan unavailable" is treated as "block", not "pass". Prompt-injection defense is the default, not a toggle. |
| **Provenance + AI-authorship attribution** | A tamper-evident ledger of which model wrote which lines, plus run lineage and replay - so AI spend *and* AI authorship are auditable. |
| **Any model, any provider - including air-gapped** | U.S. frontier models, the AskSage accredited gateway, and **self-hosted / local** models (Ollama, llama.cpp, vLLM, any OpenAI-compatible endpoint, VPN-reachable boxes). No hard dependency on one vendor's cloud. |
| **Sovereignty + CUI isolation** | Foreign-origin model acknowledgment, hard CUI isolation in a separate encrypted store, and an on-device encrypted personalization graph. Packaged for locked-down, air-gapped laptops with zero prerequisites. |
| **Enterprise governance + audit** | Centrally-managed (GPO/MDM) policy that only ever *tightens* the controls, plus an OCSF-aligned, metadata-only security-audit export seam for SIEM. |
| **A runtime execution boundary** | Approved subprocesses run OS-isolated with mediated egress - the agent can act without the machine becoming an open door. |

## Who buys it

- **Government / regulated / CUI teams** - the primary segment: air-gap-ready, sovereignty-aware,
  fail-closed, fully auditable.
- **Security-conscious engineering orgs** - teams that cannot ship a tool that scans tool calls "best
  effort".
- **Governance & FinOps owners** - who need per-model cost showback and AI-authorship attribution.
- **Agent-platform builders** - as a worked, test-backed example of adding security, provenance, and
  memory *around* a fast runtime via hooks/tools/SDK (extend, never fork).

## How LUCID is delivered

- **Open core** (this repository) - source-available under BUSL-1.1, a download-and-run desktop app
  (Windows / macOS / Linux), fully functional standalone.
- **Enterprise add-on tier** (separate repository) - optional, engagement-facing: executive reporting
  metrics *per platform*, showback → chargeback rollups, agent-development-kit bridges (Google ADK / AWS
  Strands / Azure AI Foundry), and the maintained market & competitive analysis. Nothing in the open
  core depends on it.

## What is deliberately *not* in this public document

Segment sizing, named-competitor scoring, pricing strategy, and the positioning graphic are quantitative
and engagement-specific; they are maintained in the enterprise add-on rather than asserted in a public
README. See the README's *"Where LUCID fits + the enterprise add-on tier"* section for the high-level
pointers.
