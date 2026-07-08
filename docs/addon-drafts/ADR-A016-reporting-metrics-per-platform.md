# ADR-A016 — Reporting metrics (Evals): storage + per-platform collection & export

> **Repo:** `TechLead187/lucidagentIDEaddon` (private add-on). Prepared as a DRAFT in the public
> LucidAgentIDE repo (`docs/addon-drafts/`) to be committed into the add-on's `ADR-A###` sequence.
> **Status:** Proposed (draft). Pairs with the public run-report / **Model Evaluation (Evals)** increment
> (public LucidAgentIDE, P-CHAT.C + the run-report ADR).
> **Date:** 2026-07-07

## Context

The public LUCID core is adding a per-run **Model Evaluation (Evals)** report — an engineering report,
stored + browsable in the Reports module, rendered in the existing clean/printable format with horizontal
`.rchart` bar graphs and the podcast/TTS option. Its metrics (all grounded in official + emerging practice):

- **Efficiency:** tokens-per-net-LOC, tokens-per-clean-LOC (with per-file provenance), context efficiency,
  cost-per-resolved-task, steps/tool-calls, delegation ratio, throughput.
- **Reliability:** tool-call failure rate (count + type + reason), estimated wasted tokens.
- **Code quality:** gross/net LOC, churn %, defect proxy, per-file AI provenance.
- **Product:** acceptance-criteria coverage, spec-conformance, MoSCoW must-have rate, UAT/test pass, DoD,
  **predicted acceptance likelihood** (weighted composite), tokens-per-quality-feature.

Two needs go beyond one rendered report:

1. **These metrics must be STORED** — queryable, trended across runs, and feeding the Reports module's
   bar charts (and a future trend view), not just embedded in one markdown file.
2. **Reporting must work PER PLATFORM.** LUCID ships as a **desktop Electron app**, a **web-hosted
   service**, and **cloud deployments**, and — enterprise — targets **Google ADK**, **AWS Strands
   Agents**, and **Azure AI Foundry Agent Service (MS Agent Framework)** (ADR-A013). Telemetry
   availability and the destination sink differ per platform; a metric that is DIRECT on desktop may be
   unavailable off-platform. It must be reported honestly, never faked.

This follows the established **public-seam / private-IP split** — same as ADR-0068 (managed config),
ADR-0069/A011 (SIEM `Sink`), ADR-A012 (KMS), ADR-A014/A015 (remote publishers): the **public core** owns
the metric schema + local store + report render; **this add-on ADR** owns the per-platform collection
normalization, the export adapters, and the enterprise dashboards.

## Decision

### 1. The metric schema (frozen; PUBLIC core) — the stored contract

One `eval_metrics` row per agent run, frozen via a **numbered DuckDB migration in the public core**
(CLAUDE.md invariant #10 — schema changes only through migrations). Fields come from telemetry LUCID
already keeps — `session_metrics.ts`, `ai_loc_ledger` (ADR-0031), `change_graph.ts`, the test-runner
output, and tool-call failures:

- **ids:** `run_id, session_id, model, started_at, duration_ms`
- **tokens:** `ctx, output, total, cost_usd`
- **trajectory:** `tool_calls, tool_failures` (json `{tool,reason,cmd}[]`), `subagents, steps`
- **latency (summary):** `ttft_p50_ms, ttft_p95_ms, total_p50_ms` for this run (rolls up the per-call `api_latency` rows in 1b)
- **code:** `files_changed, gross_add, gross_del, net_loc, churn_pct`, `ai_loc` (json per file
  `{path, ai_add, ai_del, net_kept}` — the provenance)
- **quality:** `tests_pass, tests_fail, clean_loc` (null until a lint signal), `defect_proxy`
- **efficiency (derived):** `tokens_per_net_loc, tokens_per_clean_loc, context_efficiency,
  wasted_tokens_est`
- **product (derived; null without an AC list):** `ac_total, ac_met, spec_conformance,
  moscow_must_rate, dod, predicted_acceptance, tokens_per_quality_feature`
- **tiers:** every metric carries an evidence tier — `direct | proxy | needs_signal` — that travels with
  it to every sink. A missing signal is stored `null` + `needs_signal`, **never zero-as-truth**.

The public core also adds a **`"eval"` report kind** to `report_store` (rendered markdown) beside
`aar`/`brief`, so the run report is browsable/printable/listenable like the others; and the structured
row makes cross-run trend charts (rchart over time) possible.

### 1b. API response latency (per-call) + business-hours rollups

**Capture (public core).** Time-to-first-token (TTFT) is the API-responsiveness signal - it isolates
provider/region/load from generation length; total round-trip is captured too. Three stamps per model
call at the request seam (`acp_backend` / `/api/chat`): `t_sent`, `t_first_token`, `t_end`, giving
`ttft_ms = first_token - sent` and `total_ms = end - sent`. Additive hook, no fork; a coarse per-turn
latency is also recoverable from the omp session `.jsonl` timestamps (`session_metrics`).

**Store (public core; frozen migration).** One `api_latency` row per model call:
`{run_id, model, ts, hour_et, business_hour, ttft_ms, total_ms, ok}`. `hour_et` / `business_hour` are
derived with `Intl.DateTimeFormat(timeZone:"America/New_York")` so EST/EDT DST is handled and the
08:00-17:00 ET window is exact. A `latency_rollup` view aggregates per period, model, and hour_et:
`{calls, avg, p50, p95}`.

**Report kinds.** Two rollup report kinds join `"eval"` in `report_store`: **`eval-weekly`** and
**`eval-monthly`** - per-model TTFT p50 by business hour (rchart bars) plus week-over-week /
month-over-month comparison (delta table). Printable + podcast like every other report; grouped in the
Reports accordion under "Latency rollups".

**Per-platform availability (private add-on).** Desktop times calls locally (DIRECT); web-hosted times
server-side per tenant (DIRECT); cloud + the enterprise agent platforms map latency from provider /
platform traces (Google ADK tracing, AWS Strands + OpenTelemetry spans, Azure Foundry / Azure Monitor,
OTel GenAI latency semantics). Where a platform exposes only total and not TTFT, TTFT is flagged
`needs_signal` - never faked. The business-hours window + timezone are org-configurable (default
08:00-17:00 America/New_York).

### 2. Per-platform collection + export (PRIVATE add-on — the "how")

A neutral `MetricsCollector` + `MetricsExporter` pair (mirrors the ADR-0069/A011 `Sink` dispatcher). The
public core emits the neutral `eval_metrics` record; the add-on maps **collection source** and
**destination** per platform.

**Hosting-platform matrix**

| Platform | Collection source | Local store | Export destination |
|---|---|---|---|
| Desktop (Electron) | local: `session_metrics` + `ai_loc_ledger` + `change_graph` + test output | local DuckDB | optional file / org SIEM (ADR-A011) |
| Web-hosted service | server-side, per-tenant (same seams) | tenant DB (Postgres/DuckDB) | tenant warehouse + SIEM |
| Cloud deployment | run telemetry via the OTel / SIEM pipeline | org data lake | Splunk / Elastic / Azure Monitor / GCP / AWS Security Lake / ACAS (ADR-A011) |

**Enterprise agent-platform matrix** (ADR-A013 targets) — map each platform's native telemetry/eval back
to the LUCID schema; flag fields a platform cannot produce:

| Target | Native telemetry / eval to map from | Maps cleanly | Flagged gaps (needs_signal) |
|---|---|---|---|
| Google ADK | ADK trajectory + response eval, tracing | tokens, steps, tool calls, resolved | ai_loc provenance & churn need the git-diff seam |
| AWS Strands Agents | Strands agent metrics + OpenTelemetry | tokens, latency, tool-call success | spec-conformance needs the AC list |
| Azure AI Foundry (Agent Service / MS Agent Framework) | Foundry Evaluation SDK + Azure Monitor / App Insights traces | cost, tokens, tool calls, LLM-judge scores | provenance/churn need the diff seam |

Exact mappings are validated as part of ADR-A013 (the adapters are themselves PLANNED); this ADR fixes
the **schema they normalize to** and the **honesty rule**: where a platform can't produce a metric, the
exporter emits `needs_signal`/`unavailable` — never a fabricated number — and **per-platform availability
is itself part of the report**.

### 3. Export sinks + enterprise dashboards (PRIVATE add-on)

Reuse ADR-A011's `Sink`: normalize `eval_metrics` to the org schema and forward to Splunk HEC /
syslog-CEF / Elastic bulk / AWS Security Lake / Azure Monitor (Sentinel DCR) / GCP Chronicle / ACAS, and
emit **OpenTelemetry GenAI / OpenLLMetry** for observability platforms. Cross-run dashboards trend the
headline metrics (tokens-per-clean-LOC, GitClear-style churn, cost-per-feature, predicted-acceptance
distribution, tool-call failure rate).

**Weekly per-model latency rollup on the dashboard reporting platforms.** The `latency_rollup`
(per model x hour_et, p50/p95 - see 1b) is exported as a first-class **recurring panel** to the org's
dashboard platforms - Grafana / Amazon Managed Grafana, Splunk, Elastic (Kibana), Datadog, Azure Monitor
Workbooks, AWS CloudWatch, GCP Cloud Monitoring - so the **weekly (and monthly) per-model TTFT p50/p95 by
business hour (08:00-17:00 ET)** sits beside the org's existing SRE/observability panels, refreshed on the
rollup cadence. The exporter ships it two ways: (a) **time-series points** (dimensions: `model`,
`hour_et`, `period`; measures: `p50, p95, avg, calls`) via the OTel/metrics sink for native dashboard
charting and alerting, and (b) the **rendered weekly/monthly rollup report** (the same artifact the in-app
Reports module prints) for archival + review. **Week-over-week / month-over-month deltas** travel as
labeled series so a dashboard can alert on a per-model latency regression (e.g. p95 up >20% WoW).
Availability, the business-hours window, and timezone follow 1b (default `America/New_York`,
org-configurable). Per the honesty rule, a platform that reports only total (not TTFT) publishes total +
flags TTFT `needs_signal` on the panel - never a fabricated series.

### 4. Honesty + governance

- Composites (predicted acceptance) **always** ship their sub-metrics + weights beside them (Goodhart /
  DORA warning: a lone score shown as a target gets gamed).
- The `direct/proxy/needs_signal` tier travels with every metric to every sink.
- Metrics are org-private; export honors the **same egress allow-list + managed-config** governance
  (ADR-0062/0068) as every other outbound path.

## Public-seam / private-IP split (explicit)

- **PUBLIC (LUCID core):** the `eval_metrics` schema + DuckDB migration; derivation of DIRECT/PROXY
  metrics from local telemetry; the `"eval"` report kind + `.rchart` render + print + podcast; a
  file/JSONL sink.
- **PRIVATE (add-on, this ADR):** per-platform collectors + exporters; enterprise SIEM/warehouse
  connectors (extends ADR-A011); the ADK/Strands/Foundry metric mappings (extends ADR-A013); cross-run
  dashboards; the per-platform availability matrix.

## Alternatives rejected

- **Assume one metric set everywhere** → fakes unavailable metrics off-desktop. Rejected (honesty).
- **Store only rendered markdown** (no structured row) → no trend/query/dashboards. Rejected — store
  structured **and** rendered.
- **Vendor-specific metric schemas** → lock-in, no cross-platform trend. Rejected — one neutral schema,
  per-platform adapters.

## Consequences

- The Reports module gains a stored, queryable Evals history + trend charts; enterprise gets per-platform
  export with honest availability flags.
- The frozen `eval_metrics` table is a public-core migration increment; the per-platform collectors +
  exporters + dashboards are add-on increments (ADR-A016 tasks).

## References

SWE-bench Verified (%Resolved, cost/step) · Cost-of-Pass (arXiv:2504.13359) · AgentBoard
(arXiv:2401.13178) · BAGEN wasted-tokens (28–64%) · AgentDiet / TRAJECT-Bench (trajectory) · GitClear AI
Code Quality 2024/25 (churn 3.3%→7.1%) · Nagappan & Ball, ICSE 2005 (churn→defects) · ISO/IEC 25010:2023 ·
SonarQube Clean Code / Quality Gate · ISO/IEC/IEEE 29148 (requirements traceability) · DSDM MoSCoW · ISTQB
UAT · DORA metrics · G-Eval / "A Survey on LLM-as-a-Judge" (arXiv:2411.15594) · SPACE (ACM Queue 2021).
Platform telemetry: Google ADK eval + tracing · AWS Strands metrics + OpenTelemetry · Azure AI Foundry
Evaluation SDK + Azure Monitor · OpenTelemetry GenAI / OpenLLMetry.

## Relates to

**Public:** the run-report / Evals increment (P-CHAT.C), P-LOC.1 / ADR-0031 (`ai_loc_ledger`),
`session_metrics.ts`, `change_graph.ts` (P-REPORT.8), `report_store` (ADR-0116/0117), the `.rchart` render
(P-REPORT.4). **Private:** ADR-A011 (SIEM `Sink`), ADR-A013 (ADK/Strands/Foundry adapters), ADR-A012 /
A014 / A015 (per-platform connectors), ADR-A008 (Manager showback), ADR-A010 (GPO/MDM per-platform
templates).
