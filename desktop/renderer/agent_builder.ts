// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/agent_builder.ts — P-AGENT.2 (ADR-0133): the Agent Builder workflow canvas.
//
// Pure builders + spec↔graph adapters (NO DOM), so the panel markup, the node editor, and the
// serialization are unit-testable without a browser (the about.ts convention). The INTERACTIVE canvas reuses
// the existing zero-dep SVG graph engine: app.ts calls `mountGraph(host, specToGraphData(spec), …)` — the same
// engine the Knowledge-graph panel uses — so we add no new dependency and inherit its pan/zoom/drag/select.
//
// The Agent Spec (harness/agent/spec.ts) is the single source of truth: we IMPORT its types + validator here
// rather than redefine them. Client-side validation is for instant UX only; the backend re-validates
// fail-closed on save (a browser is untrusted).

import { esc } from "./format.ts";
import type { PersonalGraphData } from "./bridge.ts";
import {
  validateSpec,
  emptySpec,
  NODE_KINDS,
  type AgentSpec,
  type AgentNode,
  type NodeKind,
} from "../../harness/agent/spec.ts";
import type { TrustLabel } from "../../harness/contracts.ts";
import type { AgentRunTrace, TraceSummary } from "../../harness/agent/trace.ts"; // P-AGENT.13
import type { McpCatalogTool, SpecRevisionSummary, AgentTemplateInfo } from "./bridge.ts"; // P-AGENT.12/.17

/** P-AGENT.8: the `/agent` command's kickoff. Turns a (possibly empty) one-line description into a prompt that
 *  makes the chat agent run the "what kind of agent do you want to build" INTERVIEW — steered by the frozen
 *  AGENT_BUILDER_POLICY (declare secrets by name, read docs for tokens) — and finish by calling
 *  `agent_builder_open` so the Agent Builder opens pre-populated. Pure + testable. */
export function agentInterviewPrompt(description: string): string {
  const desc = description.trim();
  return [
    "I want to build a reusable AGENT using LUCID's Agent Builder. Please run the \"what kind of agent do you want to build\" interview with me, step by step:",
    desc ? `\nWhat I have in mind: ${desc}` : "",
    "\n1. Ask what the agent should DO — its goal and the ordered steps of its workflow.",
    "2. Ask which tools it needs and which websites / APIs it must reach.",
    "3. Ask which CREDENTIALS it needs — but declare each by NAME only (e.g. SALESFORCE_API_TOKEN). NEVER ask me for a password, API key, or token VALUE; I add values in the Secrets & connections panel, which stores them in the encrypted vault.",
    "4. If I don't know how to obtain a credential, read the vendor's official docs and walk me through generating it.",
    "Keep each step short and ask ONE thing at a time. Once we've agreed on the plan, call the `agent_builder_open` tool to open it in the Agent Builder for me to review and confirm.",
    desc ? "\nStart by briefly confirming my idea, then ask your first clarifying question." : "\nAsk your first question now: what should this agent do?",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Human label for a node kind (sentence case, matches the KG label family). */
export function kindLabel(kind: NodeKind): string {
  switch (kind) {
    case "prompt":
      return "Prompt";
    case "tool":
      return "Tool";
    case "subagent":
      return "Sub-agent";
    case "approval":
      return "Approval";
    case "branch":
      return "Branch";
  }
}

/** Adapt an Agent Spec into the graph engine's data shape so the canvas can mount it with `mountGraph`.
 *  Node `count` = incident-edge degree (drives node size in the engine); edges carry a "then" relation. */
export function specToGraphData(spec: AgentSpec): PersonalGraphData {
  const degree = new Map<string, number>();
  for (const ed of spec.edges) {
    degree.set(ed.from, (degree.get(ed.from) ?? 0) + 1);
    degree.set(ed.to, (degree.get(ed.to) ?? 0) + 1);
  }
  return {
    nodes: spec.nodes.map((n) => ({
      id: n.id,
      name: n.label,
      kind: n.kind,
      trust: "trusted",
      count: degree.get(n.id) ?? 0,
    })),
    edges: spec.edges.map((ed) => ({ from: ed.from, to: ed.to, relation: ed.label?.trim() || "then" })), // P-AGENT.11c: choice labels ride the edge
    facts: [],
  };
}

/** UI-ready validation messages for the current spec (empty array = valid). The server re-validates
 *  fail-closed on save; this is only for instant in-canvas feedback. */
export function saveErrors(spec: unknown): string[] {
  const v = validateSpec(spec);
  return v.ok ? [] : v.errors;
}

/** A fresh spec backing a new canvas (one prompt node). */
export function newCanvasSpec(name: string, now: number): AgentSpec {
  return emptySpec(name, now);
}

/** The toolbar's "add node" buttons — one per node kind. */
function addNodeButtons(): string {
  return NODE_KINDS.map(
    (k) =>
      `<button class="ab-add" data-ab-add="${esc(k)}" data-tip="Add ${esc(kindLabel(k))} node">+ ${esc(kindLabel(k))}</button>`,
  ).join("");
}

/** The Agent Builder panel chrome — a right-edge surface (`#agentBuilder`) mirroring the KG panel layout:
 *  a header, a toolbar (add-node kinds · Validate · Save), the canvas host, and a node-editor flyout.
 *  app.ts injects this into buildShell and mounts the graph into `#abCanvas`. */
export function agentBuilderPanelHtml(): string {
  return `<aside class="kg ab-panel" id="agentBuilder" hidden>
    <div class="resizer resizer-l" data-resize="agentBuilder"></div>
    <div class="set-head">
      <div class="set-title">Agent Builder</div>
      <div class="ab-tools">
        ${addNodeButtons()}
        <button class="ab-btn" id="abConnect" data-tip="Connect mode|Drag from one node to another to add a step edge; toggle off to reposition nodes">Connect</button>
        <button class="ab-btn" id="abToolsBtn" data-tip="Tools|Manage the tool allow-list — remove a tool to BLOCK the agent from ever calling it">Tools</button>
                <button class="ab-btn" id="abRunsBtn" data-tip="Runs|Recent executions of this agent — per-step trace, approvals, sub-agent hops">Runs</button>
                <button class="ab-btn" id="abScheduleBtn" data-tip="Schedule|Run this agent on a cadence while LUCID is open. Only TRUSTED, approval-free agents run unattended; schedules are created disarmed">Schedule</button>
        <button class="ab-btn" id="abHistoryBtn" data-tip="History|The last 20 saved revisions of this agent — restore any of them (the restore is itself a new revision)">History</button>
        <button class="ab-btn" id="abTemplatesBtn" data-tip="Templates|Start from a curated example workflow. Templates go through the same scan + review as any import">Templates</button>
        <button class="ab-btn" id="abValidate" data-tip="Check the workflow is a valid DAG">Validate</button>
        <button class="ab-btn ok" id="abSave" data-tip="Validate + save this agent">Save</button>
        <button class="ab-btn" id="abSecrets" data-tip="Secrets & connections|Add the API credentials this agent needs to the encrypted vault (never to the agent), and confirm the sites it may reach">Secrets &amp; connections</button>
        <button class="ab-btn" id="abRun" data-tip="Run|Give the agent a task and run it live inside LUCID (under the security gate + its tool allow-list)">Run ▸</button>
        <button class="ab-btn" id="abExport" data-tip="Export|Compile + package this agent (electron target) as a portable, tamper-evident bundle for the enterprise add-on">Export</button>
        <button class="ab-btn" id="abShare" data-tip="Share|Save a portable .lucid-agent.json another LUCID Agent IDE can import. Carries the workflow + credential NAMES and setup guidance — never credential values">Share</button>
        <button class="ab-btn" id="abImportBtn" data-tip="Import|Load a shared .lucid-agent.json OR an n8n workflow JSON. Either is security-scanned and held for YOUR review before it can run">Import</button>
        <button class="ab-btn" id="abN8n" data-tip="Export for n8n|Save this workflow as an importable n8n workflow JSON — approvals become real Wait nodes; a provenance sticky embeds the portable LUCID agent for lossless round-trip">n8n ⇩</button>
        <button class="ab-btn" id="abN8nPush" data-tip="Push to n8n|Send this workflow straight to your private hosted n8n instance. Requires the LUCID enterprise add-on's n8n connector">n8n ⇧</button>
        <input type="file" id="abImportFile" accept=".json,application/json" hidden />
      </div>
    </div>
    <div class="ab-trust" id="abTrust" hidden></div>
    <div class="ab-errs" id="abErrs" hidden></div>
    <div class="ab-main">
      <div class="kg-canvas ab-canvas" id="abCanvas"></div>
      <div class="kg-side ab-side" id="abSide" hidden></div>
    </div>
  </aside>`;
}

/** The "Secrets & connections" flyout (P-AGENT.8.4): the easy-to-find place the agent directs the user to.
 *  Lists the agent's CONNECTIONS (egress domains / API server addresses to confirm) and its CREDENTIALS (the
 *  declared SecretRefs). Credentials go into the OS-encrypted vault via a per-row paste field — NEVER into the
 *  agent or the spec. `inVault` = credential ref names already stored; `isElectron` gates the vault (desktop-only). */
export function secretsPanelHtml(spec: AgentSpec, inVault: Set<string>, isElectron: boolean, approvedEgress: Set<string> = new Set()): string {
  const secrets = spec.secrets ?? [];
  const egress = spec.egress ?? [];
  const connRows = egress.length
    ? egress
        .map((e) => {
          const approved = approvedEgress.has(e);
          const action = approved
            ? `<span class="ab-conn-tag ok">✓ approved</span>`
            : `<button class="ab-btn ab-conn-approve">Approve</button>`;
          return `<li class="ab-conn-row" data-conn="${esc(e)}"><span class="ab-conn-host">${esc(e)}</span>${action}</li>`;
        })
        .join("")
    : `<li class="ab-conn-row ab-conn-empty">No outbound connections declared.</li>`;
  const credRows = secrets.length
    ? secrets
        .map((s) => {
          const stored = inVault.has(s.name);
          const status = stored
            ? `<span class="ab-cred-status ok">✓ in vault</span>`
            : `<span class="ab-cred-status need">needs a value</span>`;
          const help = stored
            ? ""
            : `<button class="ab-cred-help" data-purpose="${esc(s.purpose ?? "")}">How do I get this?</button>`;
          const adder = stored
            ? ""
            : `<div class="ab-cred-add">
                 <input type="password" class="ab-in ab-cred-secret" placeholder="paste the secret value" autocomplete="off" spellcheck="false" />
                 <button class="ab-btn ok ab-cred-save">Add to vault</button>
               </div>`;
          // P-AGENT.9: provisioning guidance carried by a SHARED agent — how THIS user obtains the credential
          // (paste an existing value, or request a Just-In-Time token via their org's KMS / IT ticketing).
          const p = s.provisioning;
          const provBits: string[] = [];
          if (p?.instructions) provBits.push(`<div class="ab-cred-purpose">${esc(p.instructions)}</div>`);
          if (p?.method === "jit-ticket") {
            provBits.push(`<div class="ab-cred-purpose">Request a Just-In-Time token via <b>${esc(p.ticket?.system ?? "your IT ticketing system")}</b>, then paste the issued value below — it goes to the vault, never into the agent.</div>`);
            if (p.ticket?.rationale) provBits.push(`<div class="ab-cred-purpose">Ticket rationale: ${esc(p.ticket.rationale)}</div>`);
            const tpl = Object.entries(p.ticket?.template ?? {});
            if (tpl.length)
              provBits.push(`<ul class="ab-cred-tpl">${tpl.map(([k, v]) => `<li><b>${esc(k)}</b>: ${esc(v)}</li>`).join("")}</ul>`);
          }
          return `<li class="ab-cred-row" data-cred="${esc(s.name)}" data-kind="${esc(s.kind)}">
              <div class="ab-cred-head"><b>${esc(s.name)}</b><span class="ab-kind ab-kind-tool">${esc(s.kind)}</span>${status}</div>
              ${s.purpose ? `<div class="ab-cred-purpose">${esc(s.purpose)}</div>` : ""}
              ${provBits.join("")}
              ${help}
              ${adder}
            </li>`;
        })
        .join("")
    : `<li class="ab-cred-row ab-conn-empty">No credentials required.</li>`;
  const vaultNote = isElectron
    ? `Credentials are encrypted by your OS keystore and are NEVER given to the agent, the spec, or chat — the agent only sees the name.`
    : `The credential vault is available in the LUCID desktop app only; open it there to store secrets securely.`;
  return `<div class="ab-conn">
    <div class="ab-ed-head"><span class="ab-kind">Secrets &amp; connections</span></div>
    <div class="ab-conn-note">${esc(vaultNote)}</div>
    <div class="ab-conn-sec">Connections</div>
    <ul class="ab-conn-list">${connRows}</ul>
    <div class="ab-conn-sec">Credentials</div>
    <ul class="ab-conn-list">${credRows}</ul>
  </div>`;
}

/** The Run flyout: a task box + Run button + an output area. The run executes live inside LUCID (P-AGENT.4-live)
 *  under the security gate + the agent's tool allow-list. `model` is shown so the user knows what they're running. */
export function runPanelHtml(model: string): string {
  return `<div class="ab-run">
    <div class="ab-ed-head"><span class="ab-kind">Run agent</span><span class="ab-run-model">${esc(model)}</span></div>
    <label class="ab-fld"><span>Task for the agent</span>
      <textarea class="ab-in ab-ta" id="abRunPrompt" placeholder="e.g. What is the capital of France?"></textarea></label>
    <button class="ab-btn ok" id="abRunGo" data-tip="Run this agent on the task">Run agent</button>
    <div class="ab-run-out" id="abRunOut" hidden></div>
  </div>`;
}

/** The omp tools a Builder-authored agent can call. The tool node's dropdown offers this CATALOG (plus
 *  anything already allow-listed, e.g. from a chat-drafted spec) — picking a tool that isn't allow-listed yet
 *  AUTO-ADDS it to `spec.tools` in app.ts, so the validator invariant (a tool node references an allow-listed
 *  tool) always holds. Names match omp's registered tool names 1:1; at run time the generated allow-list
 *  extension + the security gate deny anything outside the list, so the catalog is a UX affordance, not a
 *  security boundary. */
export const TOOL_CATALOG: ReadonlyArray<{ name: string; desc: string }> = [
  { name: "read", desc: "Read files, directories, and URLs" },
  { name: "write", desc: "Create or overwrite a file" },
  { name: "edit", desc: "Surgical text edits in an existing file" },
  { name: "search", desc: "Regex search across file contents" },
  { name: "find", desc: "Find files by name or glob" },
  { name: "ast_grep", desc: "Structural (AST) code search" },
  { name: "ast_edit", desc: "Structural (AST) codemods" },
  { name: "lsp", desc: "Code intelligence: definitions, references, rename" },
  { name: "bash", desc: "Run shell commands (under the security gate)" },
  { name: "eval", desc: "Run code in a persistent kernel" },
  { name: "web_search", desc: "Search the web" },
  { name: "browser", desc: "Drive a real browser tab" },
  { name: "github", desc: "GitHub repos, issues, and pull requests" },
  { name: "inspect_image", desc: "Analyze an image with a vision model" },
  { name: "generate_image", desc: "Generate or edit an image" },
  { name: "tts", desc: "Generate speech audio from text" },
  { name: "codegraph_query", desc: "Query the workspace code graph" },
];

/** Static tool → description lookup derived from the catalog (for option tooltips). */
const TOOL_DESC: Record<string, string> = Object.fromEntries(TOOL_CATALOG.map((t) => [t.name, t.desc]));

/** The Tools flyout (P-AGENT.9): the allow-list as removable CHIPS + an add-picker from the omp catalog.
 *  Removing a chip BLOCKS the agent from calling that tool at run time (the compiled per-agent allow-list
 *  extension and LUCID's security gate deny anything off-list). A removed tool still referenced by a step is
 *  flagged by the validator until the step is fixed or the tool re-added — nothing fails silently. */
export function toolChipsHtml(spec: AgentSpec, mcpTools: McpCatalogTool[] = []): string {
  const inUse = new Map<string, number>(); // dynamic count of tool-node references per tool
  for (const n of spec.nodes) if (n.kind === "tool" && n.tool) inUse.set(n.tool, (inUse.get(n.tool) ?? 0) + 1);
  const mcpByName = new Map(mcpTools.map((t) => [t.name, t])); // dynamic per-call lookup
  const chips = spec.tools.length
    ? spec.tools
        .map((t) => {
          const uses = inUse.get(t) ?? 0;
          const badge = uses
            ? `<span class="ab-chip-uses" title="Used by ${uses} step${uses > 1 ? "s" : ""} — removing blocks the call and flags the step">${uses} step${uses > 1 ? "s" : ""}</span>`
            : "";
          const mcp = mcpByName.get(t);
          const title = mcp ? `${mcp.desc} — third-party MCP tool from "${mcp.server}"` : t.startsWith("mcp__") ? "Third-party MCP tool" : TOOL_DESC[t];
          return `<li class="ab-chip" data-tool="${esc(t)}"><span class="ab-chip-name"${title ? ` title="${esc(title)}"` : ""}>${esc(t)}</span>${badge}<button class="ab-chip-rm" data-rm-tool="${esc(t)}" data-tip="Remove ${esc(t)} — the agent will be BLOCKED from calling it">×</button></li>`;
        })
        .join("")
    : `<li class="ab-chip ab-chip-empty">No tools allow-listed — this agent cannot call any tools.</li>`;
  const addable = TOOL_CATALOG.filter((t) => !spec.tools.includes(t.name));
  const addableMcp = mcpTools.filter((t) => !spec.tools.includes(t.name));
  const adder = addable.length || addableMcp.length
    ? `<div class="ab-chip-add"><select class="ab-in" id="abToolAdd"><option value="" selected disabled>Add a tool to the allow-list…</option>${
        addable.length ? `<optgroup label="omp tools">${addable.map((t) => `<option value="${esc(t.name)}" title="${esc(t.desc)}">${esc(t.name)}</option>`).join("")}</optgroup>` : ""
      }${
        addableMcp.length
          ? `<optgroup label="MCP tools (third-party)">${addableMcp.map((t) => `<option value="${esc(t.name)}" title="${esc(`${t.desc} — third-party MCP tool from \"${t.server}\"`)}">${esc(t.name)}</option>`).join("")}</optgroup>`
          : ""
      }</select></div>`
    : "";
  return `<div class="ab-toolchips">
    <div class="ab-ed-head"><span class="ab-kind">Tool allow-list</span></div>
    <div class="ab-conn-note">The agent may ONLY call tools on this list — every other tool call is denied at run time by its compiled allow-list and LUCID's security gate. Remove a tool to block it.</div>
    <ul class="ab-chip-list">${chips}</ul>
    ${adder}
  </div>`;
}

/** P-AGENT.17: the History flyout — saved revisions, newest first, each restorable. */
export function historyPanelHtml(revisions: SpecRevisionSummary[]): string {
  const rows = revisions.length
    ? revisions
        .map(
          (r) =>
            `<li class="ab-runrow" data-rev="${r.updated_at}"><span class="ab-runrow-when">${esc(new Date(r.updated_at).toLocaleString())}</span><span class="ab-runrow-meta">${esc(r.name)} · ${r.nodes} node${r.nodes === 1 ? "" : "s"} / ${r.edges} edge${r.edges === 1 ? "" : "s"}</span><button class="ab-btn" data-restore="${r.updated_at}" data-tip="Restore this revision as the current spec (the restore itself is versioned — nothing is lost)">Restore</button></li>`,
        )
        .join("")
    : `<li class="ab-runrow ab-runrow-empty">No revisions yet — every save snapshots one (the newest 20 are kept).</li>`;
  return `<div class="ab-runs">
    <div class="ab-ed-head"><span class="ab-kind">Revision history</span></div>
    <ul class="ab-run-list">${rows}</ul>
  </div>`;
}

/** P-AGENT.17: the Templates flyout — curated starter workflows. Using one goes through the STANDARD
 *  import gate (scan + trust + review); curated files are not exempt from the pipeline. */
export function templatesPanelHtml(templates: AgentTemplateInfo[]): string {
  const rows = templates.length
    ? templates
        .map(
          (t) =>
            `<li class="ab-runrow" data-tpl="${esc(t.file)}"><div class="ab-tpl-main"><b>${esc(t.name)}</b><div class="ab-tpl-desc">${esc(t.description)}</div><div class="ab-runrow-meta">${t.steps} steps · tools: ${esc(t.tools.join(", ") || "none")}</div></div><button class="ab-btn ok" data-use-tpl="${esc(t.file)}">Use</button></li>`,
        )
        .join("")
    : `<li class="ab-runrow ab-runrow-empty">No templates found in this build.</li>`;
  return `<div class="ab-runs">
    <div class="ab-ed-head"><span class="ab-kind">Starter templates</span></div>
    <div class="ab-conn-note">Templates are scanned and held for your review exactly like any imported agent — then they're yours to edit.</div>
    <ul class="ab-run-list">${rows}</ul>
  </div>`;
}

/** P-AGENT.14: the Schedule flyout — create a DISARMED agent-run automation for this agent. `blockedWhy`
 *  (untrusted spec / approval checkpoints) replaces the form with the honest reason: those can never run
 *  unattended, so we refuse at authoring time exactly like the scheduler's fail-closed gate would. */
export function schedulePanelHtml(spec: AgentSpec, blockedWhy: string | null): string {
  if (blockedWhy) {
    return `<div class="ab-runs">
    <div class="ab-ed-head"><span class="ab-kind">Schedule</span></div>
    <div class="ab-conn-note">${esc(blockedWhy)}</div>
  </div>`;
  }
  return `<div class="ab-runs">
    <div class="ab-ed-head"><span class="ab-kind">Schedule “${esc(spec.name)}”</span></div>
    <label class="ab-fld"><span>Task each run</span>
      <textarea class="ab-in ab-ta" id="abSchedPrompt">${esc(spec.description?.trim() ? `Run the workflow: ${spec.description.trim()}` : "Run the workflow.")}</textarea></label>
    <div class="ab-fld-row">
      <label class="ab-fld"><span>Cadence</span>
        <select class="ab-in" id="abSchedKind"><option value="interval" selected>Every N minutes</option><option value="daily">Daily at HH:MM</option></select></label>
      <label class="ab-fld"><span>Value</span>
        <input class="ab-in" id="abSchedValue" value="60" placeholder="60  |  09:30" /></label>
    </div>
    <div class="ab-conn-note">Runs only while LUCID is open, through the same gate + allow-list + trust checks as Run ▸, and each run leaves a trace in Runs. Created DISARMED — arm it in the Goal panel's Automations list. If this agent is ever un-trusted, the schedule suspends itself.</div>
    <button class="ab-btn ok" id="abSchedCreate">Create schedule (disarmed)</button>
  </div>`;
}

/** P-AGENT.13: one line per recent run of the current agent (status pill + when + step count). */
export function runsPanelHtml(traces: TraceSummary[]): string {
  const rows = traces.length
    ? traces
        .map((t) => {
          const when = new Date(t.started_at).toLocaleString();
          const dur = t.finished_at ? `${Math.max(1, Math.round((t.finished_at - t.started_at) / 1000))}s` : "—";
          return `<li class="ab-runrow" data-run="${esc(t.run_id)}"><span class="pill ${esc(t.status)}">${esc(t.status)}</span><span class="ab-runrow-when">${esc(when)}</span><span class="ab-runrow-meta">${t.steps} step${t.steps === 1 ? "" : "s"} · ${esc(dur)}</span></li>`;
        })
        .join("")
    : `<li class="ab-runrow ab-runrow-empty">No runs yet — use Run ▸ and the trace lands here.</li>`;
  return `<div class="ab-runs">
    <div class="ab-ed-head"><span class="ab-kind">Recent runs</span></div>
    <ul class="ab-run-list">${rows}</ul>
  </div>`;
}

/** P-AGENT.13: one run's full trace — status, duration, and a per-step list (segments, approvals,
 *  sub-agent hops) with truncated detail snippets. Node ids let a future increment highlight the canvas. */
export function traceDetailHtml(trace: AgentRunTrace): string {
  const dur = trace.finished_at ? `${Math.max(1, Math.round((trace.finished_at - trace.started_at) / 1000))}s` : "still open";
  const steps = trace.steps
    .map((s) => {
      const icon = s.ok ? "✓" : "✗";
      return `<li class="ab-trace-step ${s.ok ? "ok" : "fail"}"><span class="ab-trace-ic">${icon}</span><b>${esc(s.kind)}</b> ${esc(s.label)}${s.detail ? `<div class="ab-trace-detail">${esc(s.detail)}</div>` : ""}</li>`;
    })
    .join("");
  return `<div class="ab-runs">
    <div class="ab-ed-head"><button class="ab-btn" id="abRunsBack">← Runs</button><span class="pill ${esc(trace.status)}">${esc(trace.status)}</span></div>
    <div class="ab-conn-note">${esc(trace.name)} · ${esc(new Date(trace.started_at).toLocaleString())} · ${esc(dur)} · model ${esc(trace.model)}${trace.lineage.length > 1 ? ` · depth ${trace.lineage.length}` : ""}</div>
    <ul class="ab-trace-steps">${steps || "<li class='ab-trace-step'>no steps recorded</li>"}</ul>
    ${trace.final_output ? `<div class="ab-run-out">${esc(trace.final_output)}</div>` : ""}
  </div>`;
}

/** The in-run approval card (P-AGENT.11a): shown when a run HALTS at an approval checkpoint. The halt is
 *  enforced server-side by the SegmentedRun machine — this card is the resume/deny control, not the guard. */
export function runApprovalHtml(label: string, outputSoFar: string): string {
  return `<div class="ab-run-approval">
    <div class="ab-run-approval-head">⏸ Waiting for your approval — <b>${esc(label)}</b></div>
    ${outputSoFar.trim() ? `<div class="ab-run-out ab-run-approval-out">${esc(outputSoFar)}</div>` : ""}
    <div class="ab-run-approval-acts">
      <button class="ab-btn ok" id="abRunApprove" data-tip="Approve|Continue the workflow past this checkpoint">Approve — continue</button>
      <button class="ab-btn" id="abRunDeny" data-tip="Deny|Stop the workflow here. The remaining steps never run">Deny — stop</button>
    </div>
  </div>`;
}

/** The trust banner (P-AGENT.9) for an imported agent. Empty for "trusted". Approval (the human-review step)
 *  is offered for untrusted/suspicious; a QUARANTINED spec cannot be approved from the UI — fix + re-import. */
export function trustBannerHtml(label: TrustLabel, reason: string): string {
  if (label === "trusted") return "";
  const approve =
    label === "quarantined"
      ? ""
      : `<button class="ab-btn ok" id="abApprove" data-tip="Approve|Mark this agent trusted so it can run. Only approve after reviewing every step, tool, connection, and credential it declares.">Approve after review</button>`;
  return `<span class="ab-trust-label ab-trust-${esc(label)}">${esc(label)}</span><span class="ab-trust-reason">${esc(reason)}</span>${approve}`;
}

/** The node-editor flyout for a selected node. Fields are kind-specific; `tools` is the spec's allow-list.
 *  The tool dropdown offers the allow-list PLUS the omp TOOL_CATALOG (picking an un-listed tool auto-adds it
 *  to the allow-list in app.ts — enforced again by the validator + the runtime extension). */
export function nodeEditorHtml(node: AgentNode, tools: string[], mcpTools: McpCatalogTool[] = [], spec?: AgentSpec): string {
  const label = `<label class="ab-fld"><span>Label</span>
    <input class="ab-in" id="abLabel" value="${esc(node.label)}" /></label>`;
  let kindFields = "";
  if (node.kind === "prompt") {
    kindFields = `<label class="ab-fld"><span>Prompt</span>
      <textarea class="ab-in ab-ta" id="abPrompt">${esc(node.prompt ?? "")}</textarea></label>`;
  } else if (node.kind === "tool") {
    // Selectable = allow-list ∪ built-in catalog ∪ MCP-discovered tools (P-AGENT.12) ∪ this node's current
    // tool (kept visible even if it's in none — the validator flags it rather than silently dropping it).
    const mcpByName = new Map(mcpTools.map((t) => [t.name, t])); // dynamic per-call lookup
    const names = [...new Set([...tools, ...TOOL_CATALOG.map((t) => t.name), ...mcpTools.map((t) => t.name), ...(node.tool ? [node.tool] : [])])];
    const inList = new Set(tools);
    const opt = (t: string) => {
      const mcp = mcpByName.get(t);
      const title = mcp ? `${mcp.desc} — third-party MCP tool from "${mcp.server}"; calls leave LUCID via that server` : TOOL_DESC[t];
      return `<option value="${esc(t)}"${t === node.tool ? " selected" : ""}${title ? ` title="${esc(title)}"` : ""}>${esc(t)}</option>`;
    };
    const listed = names.filter((t) => inList.has(t)).map(opt).join("");
    const builtin = names.filter((t) => !inList.has(t) && !mcpByName.has(t)).map(opt).join("");
    const mcp = names.filter((t) => !inList.has(t) && mcpByName.has(t)).map(opt).join("");
    const placeholder = node.tool ? "" : `<option value="" selected disabled>(choose a tool)</option>`;
    kindFields = `<label class="ab-fld"><span>Tool</span>
      <select class="ab-in" id="abTool">${placeholder}${listed ? `<optgroup label="In the allow-list">${listed}</optgroup>` : ""}${builtin ? `<optgroup label="omp tools — picking one adds it to the allow-list">${builtin}</optgroup>` : ""}${mcp ? `<optgroup label="MCP tools (third-party) — picking one adds it to the allow-list">${mcp}</optgroup>` : ""}</select></label>
    <div class="ab-conn-note">This agent may only call allow-listed tools; choosing a tool here allow-lists it automatically.${mcp ? " MCP tools run on the third-party server that provides them." : ""}</div>`;
  } else if (node.kind === "subagent") {
    kindFields = `<label class="ab-fld"><span>Sub-agent spec id</span>
      <input class="ab-in" id="abSub" value="${esc(node.subagentSpecId ?? "")}" /></label>`;
  } else if (node.kind === "branch") {
    // P-AGENT.11c: name each outgoing choice. The agent picks EXACTLY one path at run time; the not-taken
    // subtree (steps, approvals, sub-agents) is skipped.
    const outs = spec ? spec.edges.filter((e) => e.from === node.id) : [];
    const nodeById = new Map((spec?.nodes ?? []).map((n) => [n.id, n])); // dynamic per-call lookup
    kindFields = outs.length
      ? `<div class="ab-conn-note">Name each choice — the agent picks exactly one path at run time.</div>${outs
          .map((e) => `<label class="ab-fld"><span>Choice → ${esc(nodeById.get(e.to)?.label ?? e.to)}</span><input class="ab-in" data-edge-label="${esc(e.id)}" value="${esc(e.label ?? "")}" placeholder="e.g. yes / no / escalate" /></label>`)
          .join("")}`
      : `<div class="ab-conn-note">Connect this branch to at least two next steps (Connect mode), then name the choices here.</div>`;
  }
  // P-AGENT.15: reliability knobs for executable step kinds (segment-granular at run time — see ADR-0141).
  const reliability =
    node.kind === "prompt" || node.kind === "tool" || node.kind === "subagent"
      ? `<div class="ab-fld-row">
      <label class="ab-fld"><span>Retries (0–3)</span><input class="ab-in" id="abRetry" type="number" min="0" max="3" value="${node.retry?.max ?? 0}" /></label>
      <label class="ab-fld"><span>Timeout (s)</span><input class="ab-in" id="abTimeout" type="number" min="5" max="600" value="${node.timeoutMs ? String(Math.round(node.timeoutMs / 1000)) : ""}" placeholder="default" /></label>
    </div>`
      : "";
  return `<div class="ab-editor" data-node="${esc(node.id)}">
    <div class="ab-ed-head"><span class="ab-kind ab-kind-${esc(node.kind)}">${esc(kindLabel(node.kind))}</span></div>
    ${label}
    ${kindFields}
    ${reliability}
    <button class="ab-del" id="abDelNode" data-tip="Remove this node + its edges">Delete node</button>
  </div>`;
}
