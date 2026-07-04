// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/n8n.ts — P-AGENT.10 (ADR-0136): n8n interop, both directions.
//
// EXPORT (`specToN8n`): lowers an AgentSpec into an importable n8n workflow JSON "scaffold": a manual
// trigger, one n8n node per LUCID step wired along the spec's edges, a REAL `wait` node per approval step
// (n8n genuinely halts there — stronger than our v1 prompt-line approvals), and a sticky note that carries
// the setup guidance PLUS the full portable `.lucid-agent` file in a fenced block. That fenced block is the
// ROUND-TRIP anchor: importing the exported workflow back into LUCID recovers the exact original spec
// (digest-checked). Credential VALUES never appear — n8n's own export model is name/id-only too.
//
// IMPORT (`n8nToSpec`): "own your workflow" — maps a generic n8n workflow into an AgentSpec: wait →
// approval, executeWorkflow → subagent, httpRequest → a `read` tool step (URL harvested into egress),
// code/AI nodes and everything unrecognized → prompt steps that carry the node's intent (nothing is
// silently dropped). Node credentials become SecretRef NAMES with user-input provisioning. The result is
// ALWAYS routed through the P-AGENT.5 import gate by the caller (scan + trust label + human approval) —
// this module only translates, it never widens trust.
//
// The direct PUSH to a private hosted n8n instance (POST /api/v1/workflows, X-N8N-API-KEY) is an
// enterprise connector in the private add-on (lucidagentIDEaddon/connectors/n8n); the public seam is
// desktop/addon_seam.ts. This module stays pure and dependency-free.

import { validateSpec, newSpecId, SPEC_VERSION, type AgentSpec, type AgentNode, type SecretKind, type SecretRef } from "./spec.ts";
import { topoOrder } from "./compiler.ts";
import { setupInstructions } from "./portable.ts";

// ── n8n workflow JSON shapes (the subset we read/write; extra fields pass through untouched) ────────────

export interface N8nConnectionRef {
  node: string;
  type: string;
  index: number;
}

export interface N8nNode {
  parameters: Record<string, unknown>;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  id?: string;
  notes?: string;
  credentials?: Record<string, { id?: string; name: string }>;
}

export interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main?: N8nConnectionRef[][] }>;
  settings: Record<string, unknown>;
}

/** The fence marking the embedded portable agent inside the provenance sticky note (round-trip anchor). */
export const LUCID_EMBED_FENCE = "lucid-agent";

/** Structural type guard: does this parsed JSON look like an n8n workflow? (nodes[] + connections{}).
 *  Member shapes are re-checked defensively inside `n8nToSpec` — external data is never trusted deeply,
 *  and the produced spec still passes the fail-closed validator + import gate downstream. */
export function isN8nWorkflowJson(parsed: unknown): parsed is N8nWorkflow {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const o = parsed as Record<string, unknown>;
  return Array.isArray(o.nodes) && typeof o.connections === "object" && o.connections !== null;
}

// ── export: AgentSpec -> n8n workflow ────────────────────────────────────────────────────────────────────

/** n8n node name for a LUCID step — unique (topo index prefix) and human-readable. */
function stepName(node: AgentNode, i: number): string {
  return `${i + 1}. ${node.label}`;
}

function stepToN8nNode(node: AgentNode, i: number, x: number, y: number): N8nNode {
  const base = { name: stepName(node, i), position: [x, y] as [number, number] };
  switch (node.kind) {
    case "approval":
      // A REAL halt in n8n: wait for a webhook/user resume before continuing (stronger than v1's prompt line).
      return {
        ...base,
        type: "n8n-nodes-base.wait",
        typeVersion: 1.1,
        parameters: { resume: "webhook" },
        notes: `LUCID approval step "${node.label}": a human must approve before the workflow continues.`,
      };
    case "subagent":
      return {
        ...base,
        type: "n8n-nodes-base.executeWorkflow",
        typeVersion: 1,
        parameters: { source: "database", workflowId: "" },
        notes: `LUCID sub-agent step: runs built agent ${node.subagentSpecId ?? "(unset)"} — import that agent as its own n8n workflow and select it here.`,
      };
    case "tool":
      return {
        ...base,
        type: "n8n-nodes-base.noOp",
        typeVersion: 1,
        parameters: {},
        notes: `LUCID tool step: calls the omp tool \`${node.tool ?? "(unset)"}\` under LUCID's allow-list + security gate. Replace with the equivalent n8n node for your stack (e.g. HTTP Request / integration node).`,
      };
    default:
      return {
        ...base,
        type: "n8n-nodes-base.noOp",
        typeVersion: 1,
        parameters: {},
        notes: node.prompt?.trim() ? `LUCID prompt step:\n${node.prompt.trim()}` : `LUCID prompt step "${node.label}".`,
      };
  }
}

/** Lower a validated spec into an importable n8n workflow. `portableJson` (the serialized `.lucid-agent`
 *  file) is embedded in the provenance sticky note so a LUCID on the other side can round-trip losslessly. */
export function specToN8n(spec: AgentSpec, portableJson: string): N8nWorkflow {
  const v = validateSpec(spec);
  if (!v.ok) throw new Error(`invalid spec: ${v.errors.join("; ")}`);
  const s = v.spec!;
  const order = topoOrder(s);
  const rank = new Map(order.map((id, i) => [id, i])); // dynamic per-call lookup
  const byId = new Map(s.nodes.map((n) => [n.id, n]));

  const sticky: N8nNode = {
    name: "LUCID provenance",
    type: "n8n-nodes-base.stickyNote",
    typeVersion: 1,
    position: [-40, -260],
    parameters: {
      width: 520,
      height: 420,
      content: [
        `## Exported from LUCID Agent IDE`,
        `Agent: **${s.name}** (\`${s.spec_id}\`)`,
        "",
        "Credential VALUES are NOT in this file. Configure n8n credentials / LUCID vault entries per the setup below.",
        "",
        setupInstructions(s),
        "",
        "The fenced block below is the portable LUCID agent — importing this workflow back into a LUCID Agent IDE restores it exactly (digest-checked).",
        "",
        "```" + LUCID_EMBED_FENCE,
        portableJson.trim(),
        "```",
      ].join("\n"),
    },
  };

  const trigger: N8nNode = {
    name: "Start",
    type: "n8n-nodes-base.manualTrigger",
    typeVersion: 1,
    parameters: {},
    position: [0, 300],
  };

  const stepNodes = order.map((id, i) => {
    const n = byId.get(id)!;
    return stepToN8nNode(n, i, 260 + 240 * i, 300);
  });

  const nameOf = (nodeId: string): string => stepName(byId.get(nodeId)!, rank.get(nodeId)!);
  const connections: Record<string, { main?: N8nConnectionRef[][] }> = {};
  const addConn = (from: string, to: string): void => {
    const entry = (connections[from] ??= { main: [[]] });
    entry.main![0]!.push({ node: to, type: "main", index: 0 });
  };
  // The trigger feeds every root (zero-indegree) step; spec edges wire the rest.
  const hasIncoming = new Set(s.edges.map((e) => e.to));
  for (const id of order) if (!hasIncoming.has(id)) addConn("Start", nameOf(id));
  for (const e of s.edges) addConn(nameOf(e.from), nameOf(e.to));

  return {
    name: `${s.name} (LUCID)`,
    nodes: [sticky, trigger, ...stepNodes],
    connections,
    settings: {},
  };
}

// ── import: n8n workflow -> AgentSpec ────────────────────────────────────────────────────────────────────

export interface N8nImportResult {
  /** Set when the workflow carries an embedded portable LUCID agent — the caller should import THAT
   *  (lossless, digest-checked) instead of the generic mapping. */
  embeddedPortableJson?: string;
  spec?: AgentSpec;
  /** Human-readable notes about lossy mappings (dropped triggers, flattened branches, skipped cycles). */
  notes: string[];
}

const CRED_KIND_BY_HINT: Record<string, SecretKind> = {
  oauth: "oauth",
  oauth2: "oauth",
  basic: "basic",
  basicauth: "basic",
  jwt: "jwt",
};

function credKind(credType: string): SecretKind {
  const t = credType.toLowerCase();
  for (const [hint, kind] of Object.entries(CRED_KIND_BY_HINT)) if (t.includes(hint)) return kind;
  return "apikey";
}

/** Harvest a hostname from an n8n url parameter (skips n8n `={{ }}` expressions we can't resolve). */
function hostOf(url: unknown): string | null {
  if (typeof url !== "string" || !url || url.includes("{{")) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Compact one-line JSON for carrying node parameters into a prompt (never lose intent silently). */
function compactParams(params: Record<string, unknown>): string {
  const json = JSON.stringify(params);
  if (!json || json === "{}") return "";
  return json.length > 400 ? `${json.slice(0, 400)}…` : json;
}

/** Map a generic n8n workflow into an AgentSpec draft. The caller MUST route the result through the
 *  P-AGENT.5 import gate (scan + trust label); this function only translates shapes. */
export function n8nToSpec(wf: N8nWorkflow, now: number = Date.now()): N8nImportResult {
  const notes: string[] = [];
  // Defensive: the guard above is shallow; drop members that don't carry the fields we read (external data).
  const allNodes = wf.nodes.filter((n) => n && typeof n === "object" && typeof n.type === "string" && typeof n.name === "string" && n.parameters && typeof n.parameters === "object");
  if (allNodes.length !== wf.nodes.length) notes.push(`${wf.nodes.length - allNodes.length} malformed node entr${wf.nodes.length - allNodes.length === 1 ? "y" : "ies"} skipped`);

  // Round-trip anchor: a sticky note carrying a fenced `lucid-agent` block wins outright.
  for (const n of allNodes) {
    if (!n.type.endsWith("stickyNote")) continue;
    const content = typeof n.parameters.content === "string" ? n.parameters.content : "";
    const m = content.match(new RegExp("```" + LUCID_EMBED_FENCE + "\\n([\\s\\S]*?)```"));
    if (m?.[1]) return { embeddedPortableJson: m[1].trim(), notes: ["restored the embedded portable LUCID agent (lossless round-trip)"] };
  }

  const isTrigger = (t: string): boolean => /trigger|webhook$/i.test(t);
  const stepSources = allNodes.filter((n) => !n.type.endsWith("stickyNote") && !isTrigger(n.type));
  const dropped = allNodes.filter((n) => !n.type.endsWith("stickyNote") && isTrigger(n.type));
  if (dropped.length) notes.push(`trigger nodes have no LUCID equivalent yet (P-AGENT.14) and were noted, not mapped: ${dropped.map((n) => n.name).join(", ")}`);

  const tools = new Set<string>();
  const egress = new Set<string>();
  const secrets = new Map<string, SecretRef>();
  const idByName = new Map<string, string>();
  const nodes: AgentNode[] = [];

  for (const [i, n] of stepSources.entries()) {
    const id = `n${i + 1}`;
    idByName.set(n.name, id);
    const t = n.type.toLowerCase();
    const label = n.name.trim() || n.type; // n8n enforces non-empty names; belt-and-braces for our validator
    let node: AgentNode;
    if (t.includes("wait")) {
      node = { id, kind: "approval", label };
    } else if (t.includes("executeworkflow")) {
      node = { id, kind: "subagent", label };
      notes.push(`"${n.name}": link the sub-agent manually (n8n workflow ids don't map to LUCID spec ids)`);
    } else if (t.includes("httprequest")) {
      node = { id, kind: "tool", label, tool: "read" };
      tools.add("read");
      const host = hostOf(n.parameters.url);
      if (host) egress.add(host);
      else notes.push(`"${n.name}": URL is an n8n expression — add its host to egress manually`);
    } else {
      const params = compactParams(n.parameters);
      const what = t.includes("code") || t.includes("function")
        ? "Reproduce this n8n Code node's logic"
        : `Perform the work of n8n node type ${n.type}`;
      node = { id, kind: "prompt", label, prompt: `${what}.${params ? ` Original parameters: ${params}` : ""}` };
    }
    nodes.push(node);

    for (const [credType, cred] of Object.entries(n.credentials ?? {})) {
      const ref = cred.name.toUpperCase().replace(/[^A-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "N8N_CREDENTIAL";
      if (!secrets.has(ref))
        secrets.set(ref, {
          name: ref,
          kind: credKind(credType),
          purpose: `used by n8n node "${n.name}" (${credType})`,
          provisioning: {
            method: "user-input",
            instructions: "Recreate the value this credential holds in your n8n instance, then paste it into LUCID's Secrets & connections (it is stored in the OS-encrypted vault).",
          },
        });
    }
  }

  // Edges: follow n8n connections between mapped steps; keep the DAG invariant by dropping back-edges
  // (n8n permits loops; our validator rejects cycles — P-AGENT.11c will bring native branching/loops).
  const rankOf = new Map(nodes.map((n, i) => [n.id, i]));
  const edges: AgentSpec["edges"] = [];
  let droppedEdges = 0;
  for (const [fromName, outs] of Object.entries(wf.connections)) {
    const from = idByName.get(fromName);
    if (!from || !outs || typeof outs !== "object") continue; // trigger/sticky source or malformed entry
    const lanes = Array.isArray(outs.main) ? outs.main : [];
    for (const lane of lanes) {
      if (!Array.isArray(lane)) continue;
      for (const ref of lane) {
        const to = ref && typeof ref === "object" && typeof ref.node === "string" ? idByName.get(ref.node) : undefined;
        if (!to) continue;
        if ((rankOf.get(from) ?? 0) >= (rankOf.get(to) ?? 0)) {
          droppedEdges++;
          continue;
        }
        edges.push({ id: `e${edges.length + 1}`, from, to });
      }
    }
  }
  if (droppedEdges) notes.push(`${droppedEdges} loop-back connection(s) dropped to keep the workflow a DAG (LUCID v1 has no loops)`);

  if (!nodes.length) nodes.push({ id: "n1", kind: "prompt", label: "Imported workflow", prompt: `The n8n workflow "${wf.name}" had no mappable steps.` });

  const spec: AgentSpec = {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name: `${wf.name || "n8n workflow"} (imported from n8n)`,
    description: `Imported from an n8n workflow.${notes.length ? ` Mapping notes: ${notes.join("; ")}.` : ""}`,
    mode: "built-agent",
    tools: [...tools],
    egress: [...egress],
    selfEdit: "individual",
    ...(secrets.size ? { secrets: [...secrets.values()] } : {}),
    nodes,
    edges,
    created_at: now,
    updated_at: now,
  };
  return { spec, notes };
}
