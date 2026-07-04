// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/spec.ts — P-AGENT.1 (ADR-0133): the Agent Spec, the single source of truth for a
// Builder-authored agent. The canvas edits it, the compiler reads it, the runtime runs it; nothing else is
// authoritative. This module is PURE (types + a fail-closed validator + tiny helpers, no I/O) so it is cheap
// to import anywhere and trivial to over-test.
//
// The spec is a DAG (confirmed with the user): nodes + directed edges, NO cycles. The validator rejects
// cycles, dangling edges, duplicate ids, and tool nodes whose tool isn't in the spec's allow-list.
// `validateSpec` takes `unknown` and is fail-closed: any problem → { ok: false } with reasons, and an
// imported/untrusted spec must pass it before it is ever persisted or run.
//
// v2 (P-AGENT.11c/.15, ADR-0137/0141): adds the `branch` node kind (a decision point — the segment runner
// follows exactly ONE labeled outgoing edge), optional edge `label`s, and per-node reliability knobs
// (`retry`, `timeoutMs`). v1 files stay valid forever (additive fields; the version list is a compatibility
// marker, validation is field-driven). Loops remain out — still a DAG.

import { AGENT_MODES, isAgentMode, type AgentMode } from "../contracts.ts";

export const SPEC_VERSION = 2 as const;
/** Accepted on load — v1 files (pre-branch/reliability) remain valid without rewriting. */
export const SPEC_VERSIONS = [1, 2] as const;

// Self-edit policy (ADR-0133 kickoff decision). "individual" = the user's own agents may self-edit their spec
// at runtime (sandboxed to audit-mode dry-runs in later increments); "off" = never. Enterprise managed policy
// clamps this to "off" via `clampSelfEdit` (tighten-only, mirrors clampToManaged / ADR-0068).
export const SELF_EDIT_POLICIES = ["off", "individual"] as const;
export type SelfEditPolicy = (typeof SELF_EDIT_POLICIES)[number];

// Node kinds. "prompt" = an LLM step; "tool" = call one allow-listed tool; "subagent" = invoke another
// built agent; "approval" = a human-approval checkpoint; "branch" (v2) = a decision point with ≥2 labeled
// outgoing edges — the runner follows exactly one. Kind-specific config is validated loosely.
export const NODE_KINDS = ["prompt", "tool", "subagent", "approval", "branch"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

// Reliability knobs (P-AGENT.15, v2). Applied at SEGMENT granularity by the runner: a segment's retry
// budget is the MAX of its nodes' `retry.max`; its timeout is the MIN of its nodes' `timeoutMs` (tightest
// constraint wins), clamped to sane bounds. Documented in ADR-0141.
export const RETRY_MAX_LIMIT = 3;
export const TIMEOUT_MS_MIN = 5_000;
export const TIMEOUT_MS_MAX = 600_000;
export interface NodeRetry {
  max: number; // 1..RETRY_MAX_LIMIT re-attempts after the first failure
  backoffMs?: number; // base backoff between attempts (linear × attempt), default runner-chosen
}

// Secret DECLARATIONS (P-AGENT.8 / ADR-0134). An agent declares WHICH credentials it needs — it NEVER holds
// the value. `name` maps to an OS-encrypted vault entry (the user fills it in via the vault UI; the runtime
// injects it). Kinds mirror the credential vault's AuthKind (desktop/cred_vault.ts) so a SecretRef.name lines
// up 1:1 with a stored credential. There is deliberately NO `value` field — a secret value in a spec is a
// guardrail violation caught by secret_guard.ts.
export const SECRET_KINDS = ["jwt", "oauth", "saml", "pem", "apikey", "basic"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

// Provisioning guidance (P-AGENT.9): HOW the next user of a SHARED agent obtains this credential on their
// machine. "user-input" = paste an existing value into Secrets & connections (stored in the OS-encrypted
// vault); "jit-ticket" = request a Just-In-Time token from the org's KMS via its IT ticketing process —
// `ticket` carries the system name (ServiceNow, Jira SM, …), sample request fields, and the access rationale
// to paste into the ticket. GUIDANCE ONLY: free text here is scanned by secret_guard (a pasted value is a
// guardrail violation) and by the import gate (injection surface on an imported spec).
export const PROVISIONING_METHODS = ["user-input", "jit-ticket"] as const;
export type ProvisioningMethod = (typeof PROVISIONING_METHODS)[number];
export interface TicketGuide {
  system: string; // the ticketing system, e.g. "ServiceNow" or "Jira Service Management"
  template?: Record<string, string>; // sample ticket fields (catalog item, assignment group, short description, …)
  rationale?: string; // the access justification to include in the ticket
}
export interface SecretProvisioning {
  method: ProvisioningMethod;
  instructions?: string; // step-by-step help shown on import — NEVER a secret value
  ticket?: TicketGuide; // for "jit-ticket": how to request the JIT token
}
export interface SecretRef {
  name: string; // stable ref, e.g. "SALESFORCE_API_TOKEN" — maps to a vault credential; NEVER the value
  kind: SecretKind;
  purpose?: string; // what it's for / where the user gets it (help text) — NEVER the secret
  provisioning?: SecretProvisioning; // P-AGENT.9: how a SHARED agent's next user obtains this credential
}

export interface AgentNode {
  id: string;
  kind: NodeKind;
  label: string;
  prompt?: string; // kind "prompt"
  tool?: string; // kind "tool" — MUST be in spec.tools (the allow-list)
  subagentSpecId?: string; // kind "subagent"
  retry?: NodeRetry; // v2 (P-AGENT.15): re-attempts on failure, segment-granular
  timeoutMs?: number; // v2 (P-AGENT.15): per-step ceiling, TIMEOUT_MS_MIN..TIMEOUT_MS_MAX
}

export interface AgentEdge {
  id: string;
  from: string; // an AgentNode id
  to: string; // an AgentNode id
  label?: string; // v2 (P-AGENT.11c): the choice name on a branch node's outgoing edge ("yes", "retry", …)
}

export interface AgentSpec {
  spec_id: string; // stable minted id (invariant #9)
  spec_version: (typeof SPEC_VERSIONS)[number];
  name: string;
  description?: string;
  persona?: string; // system persona text (scanned as untrusted when imported)
  model?: string;
  mode: AgentMode; // built agents use "built-agent"
  nodes: AgentNode[];
  edges: AgentEdge[];
  tools: string[]; // the tool allow-list — the ONLY tools this agent may call
  egress: string[]; // requested network-whitelist patterns (gated at run time)
  secrets?: SecretRef[]; // declared credential NAMES the agent needs (values live in the vault, never here)
  selfEdit: SelfEditPolicy;
  created_at: number; // epoch ms
  updated_at: number; // epoch ms
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  spec?: AgentSpec; // present only when ok
}

/** Mint a stable, unique spec id (invariant #9). */
export function newSpecId(): string {
  return `agent_${crypto.randomUUID()}`;
}

/** A minimal valid starting spec (one prompt node, no edges) for a new canvas. */
export function emptySpec(name: string, now: number): AgentSpec {
  const nodeId = `n_${crypto.randomUUID()}`;
  return {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name,
    mode: "built-agent",
    nodes: [{ id: nodeId, kind: "prompt", label: "Start", prompt: "" }],
    edges: [],
    tools: [],
    egress: [],
    selfEdit: "individual",
    created_at: now,
    updated_at: now,
  };
}

/** Tighten-only clamp of the self-edit policy against a managed ceiling. If the managed policy denies
 *  self-edit (enterprise default), force "off"; the user's choice can never widen it. Returns a new spec. */
export function clampSelfEdit(spec: AgentSpec, managedAllowsSelfEdit: boolean): AgentSpec {
  if (managedAllowsSelfEdit) return spec;
  if (spec.selfEdit === "off") return spec;
  return { ...spec, selfEdit: "off" };
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => isStr(v) && v.trim().length > 0;

/** Detect a cycle in the node/edge graph via DFS colouring. Returns true if any cycle exists. */
function hasCycle(nodeIds: Set<string>, edges: AgentEdge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) adj.get(e.from)?.push(e.to);
  const state = new Map<string, 0 | 1 | 2>(); // 0/undef = unvisited, 1 = on stack, 2 = done
  const visit = (u: string): boolean => {
    state.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const s = state.get(v);
      if (s === 1) return true; // back-edge → cycle
      if (s === undefined && visit(v)) return true;
    }
    state.set(u, 2);
    return false;
  };
  for (const id of nodeIds) if (state.get(id) === undefined && visit(id)) return true;
  return false;
}

/** Fail-closed validation of an untrusted value as an AgentSpec. Any structural problem, an unknown mode, a
 *  duplicate/dangling id, a cycle, or a tool node whose tool isn't allow-listed → { ok: false, errors }.
 *  Only a fully valid v1 DAG returns { ok: true, spec }. */
export function validateSpec(input: unknown): ValidationResult {
  const errors: string[] = [];
  const fail = (): ValidationResult => ({ ok: false, errors });

  if (typeof input !== "object" || input === null) {
    errors.push("spec must be an object");
    return fail();
  }
  const s = input as Record<string, unknown>;

  if (!isNonEmpty(s.spec_id)) errors.push("spec_id must be a non-empty string");
  if (!(SPEC_VERSIONS as readonly number[]).includes(s.spec_version as number))
    errors.push(`spec_version must be one of: ${SPEC_VERSIONS.join(", ")}`);
  if (!isNonEmpty(s.name)) errors.push("name must be a non-empty string");
  if (!isAgentMode(s.mode)) errors.push(`mode must be one of: ${AGENT_MODES.join(", ")}`);
  if (!(SELF_EDIT_POLICIES as readonly string[]).includes(s.selfEdit as string))
    errors.push(`selfEdit must be one of: ${SELF_EDIT_POLICIES.join(", ")}`);
  if (typeof s.created_at !== "number") errors.push("created_at must be a number (epoch ms)");
  if (typeof s.updated_at !== "number") errors.push("updated_at must be a number (epoch ms)");
  for (const optStr of ["description", "persona", "model"] as const)
    if (s[optStr] !== undefined && !isStr(s[optStr])) errors.push(`${optStr} must be a string when present`);

  const tools = s.tools;
  if (!Array.isArray(tools) || !tools.every(isStr)) errors.push("tools must be a string[]");
  const egress = s.egress;
  if (!Array.isArray(egress) || !egress.every(isStr)) errors.push("egress must be a string[]");

  // secrets (P-AGENT.8) are optional; when present each must be a well-formed REF (name + valid kind, no value).
  if (s.secrets !== undefined) {
    if (!Array.isArray(s.secrets)) {
      errors.push("secrets must be an array when present");
    } else {
      const secretNames = new Set<string>();
      for (const [i, r0] of s.secrets.entries()) {
        if (typeof r0 !== "object" || r0 === null) { errors.push(`secrets[${i}] must be an object`); continue; }
        const r = r0 as Record<string, unknown>;
        if (!isNonEmpty(r.name) || !/^[A-Za-z0-9_.-]+$/.test(r.name as string))
          errors.push(`secrets[${i}].name must be a non-empty ref (letters/digits/_.-)`);
        else if (secretNames.has(r.name as string)) errors.push(`duplicate secret ref: ${r.name}`);
        else secretNames.add(r.name as string);
        if (!(SECRET_KINDS as readonly string[]).includes(r.kind as string))
          errors.push(`secrets[${i}].kind must be one of: ${SECRET_KINDS.join(", ")}`);
        if ("value" in r || "secret" in r) errors.push(`secrets[${i}] must NOT carry a value — secrets live in the vault`);
        // provisioning (P-AGENT.9) is optional guidance for obtaining the credential on another machine.
        if (r.provisioning !== undefined) {
          if (typeof r.provisioning !== "object" || r.provisioning === null) {
            errors.push(`secrets[${i}].provisioning must be an object when present`);
          } else {
            const p = r.provisioning as Record<string, unknown>;
            if (!(PROVISIONING_METHODS as readonly string[]).includes(p.method as string))
              errors.push(`secrets[${i}].provisioning.method must be one of: ${PROVISIONING_METHODS.join(", ")}`);
            if (p.instructions !== undefined && !isStr(p.instructions))
              errors.push(`secrets[${i}].provisioning.instructions must be a string when present`);
            if ("value" in p || "secret" in p) errors.push(`secrets[${i}].provisioning must NOT carry a value`);
            if (p.ticket !== undefined) {
              if (typeof p.ticket !== "object" || p.ticket === null) {
                errors.push(`secrets[${i}].provisioning.ticket must be an object when present`);
              } else {
                const t = p.ticket as Record<string, unknown>;
                if (!isNonEmpty(t.system)) errors.push(`secrets[${i}].provisioning.ticket.system must name the ticketing system`);
                if (t.rationale !== undefined && !isStr(t.rationale))
                  errors.push(`secrets[${i}].provisioning.ticket.rationale must be a string when present`);
                if (t.template !== undefined) {
                  const tpl = t.template;
                  if (typeof tpl !== "object" || tpl === null || Array.isArray(tpl) || !Object.values(tpl).every(isStr))
                    errors.push(`secrets[${i}].provisioning.ticket.template must map field names to string values`);
                }
              }
            }
          }
        }
      }
    }
  }

  const nodes = s.nodes;
  const nodeIds = new Set<string>();
  if (!Array.isArray(nodes) || nodes.length === 0) {
    errors.push("nodes must be a non-empty array");
  } else {
    for (const [i, n0] of nodes.entries()) {
      if (typeof n0 !== "object" || n0 === null) {
        errors.push(`nodes[${i}] must be an object`);
        continue;
      }
      const n = n0 as Record<string, unknown>;
      if (!isNonEmpty(n.id)) errors.push(`nodes[${i}].id must be a non-empty string`);
      else if (nodeIds.has(n.id)) errors.push(`duplicate node id: ${n.id}`);
      else nodeIds.add(n.id);
      if (!(NODE_KINDS as readonly string[]).includes(n.kind as string))
        errors.push(`nodes[${i}].kind must be one of: ${NODE_KINDS.join(", ")}`);
      if (!isNonEmpty(n.label)) errors.push(`nodes[${i}].label must be a non-empty string`);
      if (n.kind === "tool") {
        if (!isNonEmpty(n.tool)) errors.push(`nodes[${i}] (tool) must name a tool`);
        else if (Array.isArray(tools) && !tools.includes(n.tool))
          errors.push(`tool node "${n.tool}" is not in the tools allow-list`);
      }
      // v2 reliability knobs (P-AGENT.15) — optional, bounded, fail-closed on nonsense.
      if (n.retry !== undefined) {
        const r = n.retry as unknown;
        if (typeof r !== "object" || r === null) {
          errors.push(`nodes[${i}].retry must be an object when present`);
        } else {
          const retry = r as Record<string, unknown>;
          if (typeof retry.max !== "number" || !Number.isInteger(retry.max) || retry.max < 1 || retry.max > RETRY_MAX_LIMIT)
            errors.push(`nodes[${i}].retry.max must be an integer 1..${RETRY_MAX_LIMIT}`);
          if (retry.backoffMs !== undefined && (typeof retry.backoffMs !== "number" || retry.backoffMs < 0))
            errors.push(`nodes[${i}].retry.backoffMs must be a non-negative number when present`);
        }
      }
      if (n.timeoutMs !== undefined && (typeof n.timeoutMs !== "number" || n.timeoutMs < TIMEOUT_MS_MIN || n.timeoutMs > TIMEOUT_MS_MAX))
        errors.push(`nodes[${i}].timeoutMs must be ${TIMEOUT_MS_MIN}..${TIMEOUT_MS_MAX}`);
    }
  }

  const edges = s.edges;
  const edgeIds = new Set<string>();
  if (!Array.isArray(edges)) {
    errors.push("edges must be an array");
  } else {
    for (const [i, e0] of edges.entries()) {
      if (typeof e0 !== "object" || e0 === null) {
        errors.push(`edges[${i}] must be an object`);
        continue;
      }
      const e = e0 as Record<string, unknown>;
      if (!isNonEmpty(e.id)) errors.push(`edges[${i}].id must be a non-empty string`);
      else if (edgeIds.has(e.id)) errors.push(`duplicate edge id: ${e.id}`);
      else edgeIds.add(e.id);
      if (!isStr(e.from) || !nodeIds.has(e.from)) errors.push(`edges[${i}].from is not an existing node id`);
      if (!isStr(e.to) || !nodeIds.has(e.to)) errors.push(`edges[${i}].to is not an existing node id`);
      if (isStr(e.from) && e.from === e.to) errors.push(`edges[${i}] is a self-loop (${e.from})`);
      if (e.label !== undefined && !isStr(e.label)) errors.push(`edges[${i}].label must be a string when present`);
    }
  }

  // v2 (P-AGENT.11c): a branch is only a decision if there is something to decide — ≥2 outgoing edges.
  if (Array.isArray(nodes) && Array.isArray(edges)) {
    for (const n0 of nodes) {
      if (typeof n0 !== "object" || n0 === null) continue;
      const n = n0 as Record<string, unknown>;
      if (n.kind !== "branch" || !isStr(n.id)) continue;
      const outs = (edges as unknown[]).filter((e0) => typeof e0 === "object" && e0 !== null && (e0 as Record<string, unknown>).from === n.id);
      if (outs.length < 2) errors.push(`branch node "${String(n.label ?? n.id)}" needs at least two outgoing edges`);
    }
  }

  // DAG check only once the node/edge ids are known-good, so a cycle report isn't muddied by bad refs.
  if (errors.length === 0 && hasCycle(nodeIds, edges as AgentEdge[])) {
    errors.push("workflow must be acyclic (v1 is a DAG); a cycle was found");
  }
  // A DAG needs at least one entry (a node with no incoming edge) or it can't start.
  if (errors.length === 0) {
    const hasIncoming = new Set((edges as AgentEdge[]).map((e) => e.to));
    if (![...nodeIds].some((id) => !hasIncoming.has(id)))
      errors.push("workflow has no entry node (every node has an incoming edge)");
  }

  if (errors.length > 0) return fail();
  return { ok: true, errors, spec: input as AgentSpec };
}
