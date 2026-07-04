// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/agent_builder.ts — P-AGENT.2 (ADR-0129): the Agent Builder workflow canvas.
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
    edges: spec.edges.map((ed) => ({ from: ed.from, to: ed.to, relation: "then" })),
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
        <button class="ab-btn" id="abValidate" data-tip="Check the workflow is a valid DAG">Validate</button>
        <button class="ab-btn ok" id="abSave" data-tip="Validate + save this agent">Save</button>
        <button class="ab-btn" id="abSecrets" data-tip="Secrets & connections|Add the API credentials this agent needs to the encrypted vault (never to the agent), and confirm the sites it may reach">Secrets &amp; connections</button>
        <button class="ab-btn" id="abRun" data-tip="Run|Give the agent a task and run it live inside LUCID (under the security gate + its tool allow-list)">Run ▸</button>
        <button class="ab-btn" id="abExport" data-tip="Export|Compile + package this agent (electron target) as a portable, tamper-evident bundle for the enterprise add-on">Export</button>
      </div>
    </div>
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
          return `<li class="ab-cred-row" data-cred="${esc(s.name)}" data-kind="${esc(s.kind)}">
              <div class="ab-cred-head"><b>${esc(s.name)}</b><span class="ab-kind ab-kind-tool">${esc(s.kind)}</span>${status}</div>
              ${s.purpose ? `<div class="ab-cred-purpose">${esc(s.purpose)}</div>` : ""}
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

/** The node-editor flyout for a selected node. Fields are kind-specific; `tools` is the spec's allow-list
 *  (a tool node may only reference an allow-listed tool — enforced again by the validator). */
export function nodeEditorHtml(node: AgentNode, tools: string[]): string {
  const label = `<label class="ab-fld"><span>Label</span>
    <input class="ab-in" id="abLabel" value="${esc(node.label)}" /></label>`;
  let kindFields = "";
  if (node.kind === "prompt") {
    kindFields = `<label class="ab-fld"><span>Prompt</span>
      <textarea class="ab-in ab-ta" id="abPrompt">${esc(node.prompt ?? "")}</textarea></label>`;
  } else if (node.kind === "tool") {
    const opts = tools.length
      ? tools
          .map((t) => `<option value="${esc(t)}"${t === node.tool ? " selected" : ""}>${esc(t)}</option>`)
          .join("")
      : `<option value="">(no tools in the allow-list)</option>`;
    kindFields = `<label class="ab-fld"><span>Tool</span>
      <select class="ab-in" id="abTool">${opts}</select></label>`;
  } else if (node.kind === "subagent") {
    kindFields = `<label class="ab-fld"><span>Sub-agent spec id</span>
      <input class="ab-in" id="abSub" value="${esc(node.subagentSpecId ?? "")}" /></label>`;
  }
  return `<div class="ab-editor" data-node="${esc(node.id)}">
    <div class="ab-ed-head"><span class="ab-kind ab-kind-${esc(node.kind)}">${esc(kindLabel(node.kind))}</span></div>
    ${label}
    ${kindFields}
    <button class="ab-del" id="abDelNode" data-tip="Remove this node + its edges">Delete node</button>
  </div>`;
}
