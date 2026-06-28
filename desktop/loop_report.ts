// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/loop_report.ts
//
// P-GOAL.9 (ADR-0054): the loop's AFTER-ACTION REPORT (AAR) and the pure helpers behind the loop's
// run-time instrumentation. loop-engineering's ship-readiness rubric (Observability §9) asks every
// unattended loop to "log each run: started, items found, actions taken" and to surface metrics the
// team can read WITHOUT scrolling chat. ADR-0046's durable goal-memory is the human-readable trail;
// this is the measurable one - a self-contained markdown record with portable graphs that renders on
// GitHub / VS Code / Obsidian (Mermaid, zero deps, fits the TS-only invariant) plus a plain-text
// scoreboard that renders even in our in-app `marked` view.
//
// PURE module: no I/O, no Date.now(). The backend (acp_backend.ts) collects a `LoopMetrics` during the
// run and calls `renderLoopReport` as the loop's LAST task; the file write is best-effort (goal_memory).
// Everything here is unit-tested - the same discipline as loop_estimate.ts / goal_verdict.ts.

import { formatTokens } from "./loop_estimate.ts";
import type { DialType, LoopDial, RiskTier } from "./exec_policy.ts";

// P-GOAL.13 (ADR-0067): a tool call the unattended loop STOPPED, and why. `risk-dial` = above the user's
// per-type Speed↔Risk ceiling; `catastrophic` = the T4 set (never auto-runnable); `security-gate` = the
// in-process Unicode scanner (a different layer - tallied separately, both shown).
export interface LoopBlock {
  iter: number;
  tool: string;
  tier: RiskTier;
  reason: "risk-dial" | "catastrophic" | "security-gate";
}

export interface IterStat {
  /** 1-based iteration number. */ n: number;
  /** tool calls the maker made this iteration. */ tools: number;
  /** errors recorded this iteration (failed/blocked tool calls). */ errors: number;
  /** did the checker pass this round? */ done: boolean;
  /** the checker's one-line reason (for the per-iteration log). */ reason: string;
}

export interface LocStat { added: number; removed: number; files: number }

export type LoopOutcome = "met" | "stopped" | "cancelled" | "error";

export interface LoopMetrics {
  goal: string;
  condition: string;
  command?: string;
  outcome: LoopOutcome;
  outcomeReason: string;
  iterations: number;
  maxIters: number;
  durationMs: number;
  /** tool-call tally keyed by normalized type (see normalizeToolName). */
  toolCalls: Record<string, number>;
  /** lines of code changed across the run; null when the workspace isn't a git repo. */
  loc: LocStat | null;
  /** every error recorded, with the iteration it happened in. */
  errors: { iter: number; detail: string }[];
  /** P-GOAL.13 (ADR-0067): every tool call the loop BLOCKED (risk-dial / catastrophic / security-gate). */
  blocks: LoopBlock[];
  /** P-GOAL.13: the per-command-type Speed↔Risk dial this run used (so the AAR is self-describing). */
  dial?: LoopDial;
  /** unique http(s) URLs the maker touched (web fetch / search / links in tool details). */
  websites: string[];
  perIteration: IterStat[];
  // P-GOAL.11 (ADR-0056): actual spend. null when no usage telemetry was observed.
  spendUsd?: number | null;
  /** peak context-window fill across the run (informational; not summed). */
  peakContextTokens?: number | null;
  /** the budget cap that was in force, if any (0/undefined = no cap). */
  budgetUsd?: number;
}

// ── pure collectors (used by the backend's instrumentation) ───────────────────

/** Group a raw omp tool kind/title into a small, stable set of TYPES for the "by type" chart.
 *  Unknown kinds pass through lowercased so a new tool still shows up (just ungrouped). */
export function normalizeToolName(raw: string): string {
  const n = (raw || "").toLowerCase().trim();
  if (!n) return "other";
  if (/web.?search|google|brave|ddg/.test(n)) return "web-search";
  if (/web.?fetch|fetch|http|curl|url|browse/.test(n)) return "web-fetch";
  if (/edit|write|patch|apply|create|insert|replace/.test(n)) return "edit";
  if (/bash|shell|exec|command|run|terminal|process/.test(n)) return "shell";
  if (/grep|glob|search|find|ripgrep|rg/.test(n)) return "search";
  if (/read|cat|open|view/.test(n)) return "read";
  if (/delete|remove|rm\b/.test(n)) return "delete";
  if (/task|agent|subagent|delegate|spawn/.test(n)) return "subagent";
  return n.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "other";
}

/** Pull http(s) URLs out of arbitrary text (tool details, the maker's stream). Deduped, trailing
 *  punctuation trimmed, capped so a chatty run can't bloat the report. */
export function extractUrls(text: string, cap = 50): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s"'`)<>\]}]+/gi;
  for (const m of (text || "").matchAll(re)) {
    const m0 = m[0];
    if (!m0) continue;
    let u = m0.replace(/[.,;:!?)\]]+$/, ""); // strip trailing sentence punctuation
    if (u.length > 200) u = u.slice(0, 200);
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
    if (out.length >= cap) break;
  }
  return out;
}

/** Parse `git diff --numstat` output into totals. Binary files (numstat shows "-\t-") are skipped.
 *  Pure so it can be unit-tested without a git repo; the backend runs git, this reads the bytes. */
export function parseNumstat(out: string): LocStat {
  let added = 0, removed = 0, files = 0;
  for (const line of (out || "").split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    files++;
    if (m[1] !== "-") added += Number(m[1]);
    if (m[2] !== "-") removed += Number(m[2]);
  }
  return { added, removed, files };
}

/** A normalized signature of a checker's not-done reason, so the loop can detect it is STUCK on the
 *  SAME failure round after round (loop-engineering's #1 "Infinite Fix Loop"). Digits/punctuation
 *  dropped so "3 of 5 tests fail" and "2 of 5 tests fail" collapse to the same recurring blocker. */
export function stallSignature(reason: string): string {
  return (reason || "")
    .toLowerCase()
    .replace(/[0-9]+/g, "#")
    .replace(/[^a-z#]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 12)
    .join(" ");
}

// ── rendering ─────────────────────────────────────────────────────────────────

/** A fixed-width unicode meter, e.g. bar(3, 10, 20) → "██████░░░░░░░░░░░░░░". */
export function bar(value: number, max: number, width = 20): string {
  const filled = max > 0 ? Math.max(0, Math.min(width, Math.round((value / max) * width))) : 0;
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Dollars for the report: 2-dp, but a tiny non-zero spend shows "<$0.01" rather than "$0.00". */
export function formatSpend(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${(Math.round(usd * 100) / 100).toFixed(2)}`;
}

/** "3m 12s" / "0.8s" / "1h 04m" - compact, no library. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `${h}h ${String(rm).padStart(2, "0")}m`;
}

/** Quote+sanitize a label for a Mermaid string literal (no quotes/newlines/brackets). */
function mlabel(s: string): string {
  return s.replace(/["\n\r[\]{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, 32) || "?";
}

/** Escape arbitrary text for a single Markdown table cell. Backslashes are escaped FIRST - otherwise a
 *  trailing "\" in the input would escape the cell's closing "|" and corrupt the row - then pipes, then
 *  newlines are flattened (a table cell can't span lines). */
function mdCell(s: string): string {
  return (s || "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

/** A Mermaid pie chart, or "" when there's nothing to plot (an empty pie is invalid Mermaid). */
export function mermaidPie(title: string, data: Record<string, number>): string {
  const entries = Object.entries(data).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "";
  const rows = entries.map(([k, v]) => `  "${mlabel(k)}" : ${v}`).join("\n");
  return "```mermaid\npie showData title " + mlabel(title) + "\n" + rows + "\n```";
}

/** A Mermaid bar chart (xychart-beta), or "" when every value is zero. */
export function mermaidBar(title: string, xLabels: (string | number)[], values: number[], yTitle = "Count"): string {
  if (!values.length || values.every((v) => v === 0)) return "";
  const max = Math.max(1, ...values);
  const xs = xLabels.map((x) => `"${mlabel(String(x))}"`).join(", ");
  return (
    "```mermaid\nxychart-beta\n" +
    `  title "${mlabel(title)}"\n` +
    `  x-axis [${xs}]\n` +
    `  y-axis "${mlabel(yTitle)}" 0 --> ${max}\n` +
    `  bar [${values.join(", ")}]\n` +
    "```"
  );
}

const BLOCK_REASON_LABEL: Record<LoopBlock["reason"], string> = {
  "risk-dial": "Risk dial",
  catastrophic: "Catastrophic (T4)",
  "security-gate": "Security gate (scanner)",
};

/** Render the loop's Blocks section: the dial posture this run used, a by-reason/by-tier breakdown, and a
 *  table of what was stopped. Risk-dial and security-gate blocks are tallied separately (different layers,
 *  both shown). Deterministic; degrades to an honest one-liner when nothing was blocked. */
export function renderBlocks(blocks: LoopBlock[], dial?: LoopDial): string {
  const out: string[] = [];
  // The dial posture - what speed↔risk trade this run was set to (self-describing AAR).
  if (dial && Object.keys(dial).length) {
    const order: DialType[] = ["shell", "edit", "delete", "web-fetch", "web-search", "subagent"];
    const posture = order.filter((t) => dial[t]).map((t) => `${t}=${dial[t]}`).join(" · ");
    if (posture) out.push(`**Dial posture:** ${posture}  _(a command auto-ran only if its tier ≤ its type's dial; T4 always blocked)_`);
  } else {
    out.push("**Dial posture:** default - safest (T0 only; everything riskier blocked).");
  }
  out.push("");

  if (!blocks.length) { out.push("_Nothing blocked. ✅_"); return out.join("\n"); }

  const byReason: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  for (const b of blocks) { byReason[b.reason] = (byReason[b.reason] ?? 0) + 1; byTier[b.tier] = (byTier[b.tier] ?? 0) + 1; }
  const reasonLine = (Object.keys(BLOCK_REASON_LABEL) as LoopBlock["reason"][])
    .filter((r) => byReason[r]).map((r) => `${BLOCK_REASON_LABEL[r]}: **${byReason[r]}**`).join(" · ");
  const tierLine = Object.keys(byTier).sort().map((t) => `${t}: ${byTier[t]}`).join(" · ");

  out.push(`**${blocks.length}** call${blocks.length === 1 ? "" : "s"} blocked - ${reasonLine}.`);
  out.push("");
  out.push(`By tier: ${tierLine}.`);
  out.push("");
  out.push("| Iter | Tool | Tier | Reason |");
  out.push("|---|---|---|---|");
  for (const b of blocks.slice(0, 50)) out.push(`| ${b.iter} | ${mdCell(String(b.tool).slice(0, 60))} | ${b.tier} | ${BLOCK_REASON_LABEL[b.reason]} |`);
  if (blocks.length > 50) out.push(`| … | | | _${blocks.length - 50} more_ |`);
  return out.join("\n");
}

const OUTCOME_BADGE: Record<LoopOutcome, string> = {
  met: "✅ Goal met",
  stopped: "⏹️ Stopped",
  cancelled: "🛑 Cancelled",
  error: "❗ Error",
};

/** One-line summary for the event payload / in-app banner. */
export function summarizeLoop(m: LoopMetrics): string {
  const tools = Object.values(m.toolCalls).reduce((a, b) => a + b, 0);
  const loc = m.loc ? `+${m.loc.added}/-${m.loc.removed} LOC` : "LOC n/a";
  const spend = m.spendUsd != null ? ` · ${formatSpend(m.spendUsd)}` : "";
  const blocks = m.blocks.length ? ` · ${m.blocks.length} blocked` : "";
  return `${m.iterations} iter · ${tools} tool calls · ${loc} · ${m.errors.length} errors${blocks} · ${m.websites.length} sites${spend}`;
}

/** Render the full After-Action Report markdown. Deterministic: the same metrics always produce the
 *  same bytes (so a future diff/regression test is stable). Sections that have no data degrade to an
 *  honest one-liner rather than an empty/invalid chart. */
export function renderLoopReport(m: LoopMetrics): string {
  const totalTools = Object.values(m.toolCalls).reduce((a, b) => a + b, 0);
  const added = m.loc?.added ?? 0, removed = m.loc?.removed ?? 0;
  const scoreMax = Math.max(1, totalTools, added, removed, m.errors.length, m.websites.length);
  const pad = (s: string) => s.padEnd(14);
  const scoreboard = [
    `${pad("Tool calls")}${bar(totalTools, scoreMax)}  ${totalTools}`,
    `${pad("Lines added")}${bar(added, scoreMax)}  +${added}`,
    `${pad("Lines removed")}${bar(removed, scoreMax)}  -${removed}`,
    `${pad("Errors")}${bar(m.errors.length, scoreMax)}  ${m.errors.length}`,
    `${pad("Websites")}${bar(m.websites.length, scoreMax)}  ${m.websites.length}`,
  ].join("\n");

  const out: string[] = [];
  out.push(`# After-Action Report: ${m.goal}`);
  out.push("");
  out.push(`**${OUTCOME_BADGE[m.outcome]}** - ${m.outcomeReason}`);
  out.push("");
  out.push(`| | |`);
  out.push(`|---|---|`);
  out.push(`| Iterations | ${m.iterations} of ${m.maxIters} |`);
  out.push(`| Duration | ${formatDuration(m.durationMs)} |`);
  out.push(`| Stop condition | ${m.condition || "-"} |`);
  out.push(`| Verification | ${m.command ? "`" + m.command + "`" : "checker judgement (no command)"} |`);
  if (m.spendUsd != null) {
    const cap = m.budgetUsd && m.budgetUsd > 0 ? ` of ${formatSpend(m.budgetUsd)} cap` : "";
    out.push(`| Spend | ${formatSpend(m.spendUsd)}${cap}${m.peakContextTokens ? ` · peak context ${formatTokens(m.peakContextTokens)}` : ""} |`);
  }
  out.push("");

  out.push("## Scoreboard");
  out.push("");
  out.push("```text");
  out.push(scoreboard);
  out.push("```");
  out.push("");

  out.push("## Tool calls by type");
  out.push("");
  const pie = mermaidPie("Tool calls by type", m.toolCalls);
  if (pie) {
    out.push(pie);
    out.push("");
    out.push("| Tool | Calls |");
    out.push("|---|---|");
    for (const [k, v] of Object.entries(m.toolCalls).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])) {
      out.push(`| ${k} | ${v} |`);
    }
  } else {
    out.push("_No tool calls recorded._");
  }
  out.push("");

  out.push("## Lines of code changed");
  out.push("");
  if (m.loc) {
    const bars = mermaidBar("Lines of code changed", ["Added", "Removed"], [added, removed], "Lines");
    if (bars) out.push(bars);
    else out.push("_No lines changed._");
    out.push("");
    out.push(`Net **+${added} / -${removed}** across **${m.loc.files}** file${m.loc.files === 1 ? "" : "s"}.`);
  } else {
    out.push("_Not a git workspace - line-change tracking unavailable._");
  }
  out.push("");

  out.push("## Errors recorded");
  out.push("");
  if (m.errors.length) {
    const perIterErrors = m.perIteration.map((it) => it.errors);
    const xs = m.perIteration.map((it) => it.n);
    const chart = mermaidBar("Errors recorded per iteration", xs, perIterErrors, "Errors");
    if (chart) { out.push(chart); out.push(""); }
    out.push("| Iter | Error |");
    out.push("|---|---|");
    for (const e of m.errors.slice(0, 50)) out.push(`| ${e.iter} | ${mdCell(e.detail.slice(0, 160))} |`);
    if (m.errors.length > 50) out.push(`| … | _${m.errors.length - 50} more_ |`);
  } else {
    out.push("_No errors recorded. 🎉_");
  }
  out.push("");

  out.push("## Blocks");
  out.push("");
  out.push(renderBlocks(m.blocks, m.dial));
  out.push("");

  out.push("## Websites visited");
  out.push("");
  if (m.websites.length) {
    out.push("| # | URL |");
    out.push("|---|---|");
    m.websites.forEach((u, i) => out.push(`| ${i + 1} | ${u.replace(/\|/g, "%7C")} |`));
  } else {
    out.push("_None._");
  }
  out.push("");

  out.push("## Per-iteration log");
  out.push("");
  out.push("| Iter | Tools | Errors | Checker |");
  out.push("|---|---|---|---|");
  for (const it of m.perIteration) {
    const verdict = `${it.done ? "✅ met" : "… not yet"} - ${mdCell((it.reason || "").slice(0, 120))}`;
    out.push(`| ${it.n} | ${it.tools} | ${it.errors} | ${verdict} |`);
  }
  out.push("");

  return out.join("\n");
}
