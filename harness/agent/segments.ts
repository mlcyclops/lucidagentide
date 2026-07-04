// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/segments.ts — P-AGENT.11a/.11b (ADR-0137): the segment runner that makes approval AND
// subagent nodes REAL.
//
// v1 lowered `approval` to prose in one big system prompt — a guarantee the model could skip. This module
// splits the topological order into SEGMENTS at approval boundaries and drives them through a small state
// machine, `SegmentedRun`, that ENFORCES the halt structurally:
//
//   - `currentSegment()` (the only source of a segment's system prompt) throws unless state === "running".
//   - Finishing a segment that ends at an approval boundary moves the machine to "awaiting-approval";
//     from there the ONLY transitions are approve() (continue) or deny() (terminal).
//
// The desktop spawn glue (desktop/agent_run.ts) cannot reach post-approval steps without the approve —
// there is no prompt to hand omp. This is the keystone property; its regression test is stop-the-line
// (AGENTS.md "over-test the keystones").
//
// P-AGENT.11b extends the same boundary mechanism to `subagent` nodes: the machine halts in
// "awaiting-subagent" and the ORCHESTRATOR runs the child agent — under the CHILD's compiled allow-list and
// the CHILD's stored trust label (a non-trusted child refuses exactly like a top-level run) — then records
// its output. `subagentGuard` fail-closes the holes: unset child, cycles, depth > SUBAGENT_MAX_DEPTH,
// missing spec, or a child with approval checkpoints (nested human halts are not parkable in v1).
//
// Segment prompts are TAIL content built from the same pieces as the one-shot compiler (stepLine +
// LUCID_CORE_INSTRUCTIONS); the frozen prefix is never touched (invariant #6). Prior segment output is
// agent-generated within the same run (same trust domain) and is carried forward as plain context.

import { validateSpec, type AgentSpec, type AgentNode } from "./spec.ts";
import { topoOrder, stepLine, LUCID_CORE_INSTRUCTIONS } from "./compiler.ts";

export interface ApprovalBoundary {
  nodeId: string;
  label: string;
}

export interface SubagentBoundary {
  nodeId: string;
  label: string;
  specId?: string; // the child agent's spec_id (unset in a half-built canvas — the orchestrator refuses)
}

export interface RunSegment {
  /** Topo-ordered plain node ids executed in this segment (may be empty, e.g. approval-first specs). */
  nodeIds: string[];
  /** Present when the segment ends at an approval node — the machine halts until a human decides. */
  approvalAfter?: ApprovalBoundary;
  /** P-AGENT.11b: present when the segment ends at a subagent node — the machine halts until the
   *  orchestrator has run the CHILD agent (under the child's own allow-list + trust) and recorded its output. */
  subagentAfter?: SubagentBoundary;
}

/** P-AGENT.11b: delegation depth cap — parent + children + grandchildren, no deeper. */
export const SUBAGENT_MAX_DEPTH = 3;

/** Pure pre-flight for executing a subagent boundary. `lineage` = spec_id chain from the root run down to
 *  (excluding) the child. Fail-closed on every hole: unset child, self/ancestor cycle, depth, a child that
 *  isn't loadable, or a child with approval checkpoints (v1 cannot park a nested human halt — run that agent
 *  directly instead). */
export function subagentGuard(lineage: readonly string[], boundary: SubagentBoundary, childSpec: AgentSpec | null): { ok: boolean; error?: string } {
  if (!boundary.specId) return { ok: false, error: `sub-agent step "${boundary.label}" has no agent selected` };
  if (lineage.includes(boundary.specId)) return { ok: false, error: `sub-agent cycle: ${[...lineage, boundary.specId].join(" → ")}` };
  if (lineage.length >= SUBAGENT_MAX_DEPTH) return { ok: false, error: `sub-agent depth limit (${SUBAGENT_MAX_DEPTH}) reached at "${boundary.label}"` };
  if (!childSpec) return { ok: false, error: `sub-agent "${boundary.label}" (${boundary.specId}) is not a saved agent in this workspace` };
  if (childSpec.nodes.some((n) => n.kind === "approval"))
    return { ok: false, error: `sub-agent "${childSpec.name}" has approval checkpoints; run it directly — nested human halts aren't supported (yet)` };
  return { ok: true };
}

/** Split the spec's topological order into segments at approval AND subagent boundaries. The boundary node
 *  itself is never an executed prompt step: an approval waits for a human, a subagent waits for the child
 *  run. A trailing non-empty run of steps forms the final segment; a spec ending on a boundary completes
 *  right after it. */
export function splitSegments(spec: AgentSpec): RunSegment[] {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const segments: RunSegment[] = [];
  let acc: string[] = [];
  for (const id of topoOrder(spec)) {
    const node = byId.get(id)!;
    if (node.kind === "approval") {
      segments.push({ nodeIds: acc, approvalAfter: { nodeId: node.id, label: node.label } });
      acc = [];
    } else if (node.kind === "subagent") {
      segments.push({ nodeIds: acc, subagentAfter: { nodeId: node.id, label: node.label, ...(node.subagentSpecId ? { specId: node.subagentSpecId } : {}) } });
      acc = [];
    } else {
      acc.push(id);
    }
  }
  if (acc.length || segments.length === 0) segments.push({ nodeIds: acc });
  return segments;
}

/** Render the system prompt for ONE segment. Step numbers are the GLOBAL topo indices, so the model sees
 *  the same numbering the canvas and the one-shot prompt use. */
export function renderSegmentPrompt(spec: AgentSpec, segment: RunSegment, segmentIndex: number, totalSegments: number, priorOutput: string): string {
  const order = topoOrder(spec);
  const globalIndex = new Map(order.map((id, i) => [id, i])); // dynamic per-call lookup
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const steps = segment.nodeIds.map((id) => stepLine(byId.get(id)!, globalIndex.get(id)!)).join("\n");
  const toolsLine = spec.tools.length
    ? `You may ONLY use these tools: ${spec.tools.join(", ")}. Any other tool call is denied by policy.`
    : "You may not call any tools; reason and respond directly.";
  return [
    `You are "${spec.name}", an agent built with the LUCID Agent Builder.`,
    spec.description?.trim() ? `\n${spec.description.trim()}` : "",
    spec.persona?.trim() ? `\n${spec.persona.trim()}` : "",
    `\n## This run (part ${segmentIndex + 1} of ${totalSegments})`,
    `Execute ONLY the steps below, in order:\n${steps || "(no steps — this part is a checkpoint)"}`,
    segment.approvalAfter
      ? `\nThis part ends at the human approval checkpoint "${segment.approvalAfter.label}". Finish these steps and STOP; a person reviews your output before the workflow continues.`
      : "\nThese are the workflow's final steps.",
    priorOutput.trim() ? `\n## Output of the previous parts (your own earlier work — build on it)\n${priorOutput.trim()}` : "",
    `\n## Tools\n${toolsLine}`,
    `\n## Running inside LUCID\n${LUCID_CORE_INSTRUCTIONS}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export type SegmentedRunState = "running" | "awaiting-approval" | "awaiting-subagent" | "completed" | "denied";

export interface CurrentSegment {
  index: number;
  nodeIds: string[];
  systemPrompt: string;
}

/** The keystone state machine (P-AGENT.11a). Owns segment progression; the ONLY way to obtain a segment's
 *  system prompt is `currentSegment()` in the "running" state, so no caller can execute past an approval
 *  boundary without an explicit `approve()`. Pure — no I/O, fully unit-testable. */
export class SegmentedRun {
  readonly #spec: AgentSpec;
  readonly #segments: RunSegment[];
  #index = 0;
  #state: SegmentedRunState = "running";
  #outputs: string[] = [];
  #denyReason = "";

  constructor(spec: AgentSpec) {
    const v = validateSpec(spec);
    if (!v.ok) throw new Error(`invalid spec: ${v.errors.join("; ")}`);
    this.#spec = v.spec!;
    this.#segments = splitSegments(v.spec!);
    this.#enterSegment();
  }

  get state(): SegmentedRunState {
    return this.#state;
  }

  get segmentCount(): number {
    return this.#segments.length;
  }

  /** The approval the machine is halted at, when awaiting one. */
  pendingApproval(): ApprovalBoundary | null {
    return this.#state === "awaiting-approval" ? (this.#segments[this.#index]!.approvalAfter ?? null) : null;
  }

  /** P-AGENT.11b: the subagent boundary the machine is halted at, when awaiting the child run. */
  pendingSubagent(): SubagentBoundary | null {
    return this.#state === "awaiting-subagent" ? (this.#segments[this.#index]!.subagentAfter ?? null) : null;
  }

  /** All segment outputs so far (empty string for checkpoint-only segments). */
  transcript(): readonly string[] {
    return this.#outputs;
  }

  /** The run's final output — only meaningful once completed. */
  finalOutput(): string {
    return [...this.#outputs].reverse().find((o) => o.trim()) ?? "";
  }

  get denyReason(): string {
    return this.#denyReason;
  }

  /** The segment to execute now. THROWS unless running — this is the enforced halt. */
  currentSegment(): CurrentSegment {
    if (this.#state !== "running") throw new Error(`no executable segment in state "${this.#state}"`);
    const seg = this.#segments[this.#index]!;
    return {
      index: this.#index,
      nodeIds: seg.nodeIds,
      systemPrompt: renderSegmentPrompt(this.#spec, seg, this.#index, this.#segments.length, this.#outputs.join("\n\n")),
    };
  }

  /** Record the finished segment's output and advance: to a boundary halt, the next segment, or done. */
  recordSegmentOutput(output: string): void {
    if (this.#state !== "running") throw new Error(`cannot record output in state "${this.#state}"`);
    this.#outputs.push(output);
    const seg = this.#segments[this.#index]!;
    if (seg.approvalAfter) {
      this.#state = "awaiting-approval";
      return;
    }
    if (seg.subagentAfter) {
      this.#state = "awaiting-subagent";
      return;
    }
    this.#index++;
    this.#advanceOrComplete();
  }

  /** P-AGENT.11b: record the CHILD agent's output at the current subagent boundary and continue. Only the
   *  orchestrator that actually ran the child (under the child's allow-list + trust) may call this. */
  recordSubagentOutput(output: string): void {
    if (this.#state !== "awaiting-subagent") throw new Error(`no sub-agent pending in state "${this.#state}"`);
    this.#outputs.push(output);
    this.#index++;
    this.#state = "running";
    this.#advanceOrComplete();
  }

  /** Human approval at the current boundary. Anything but an explicit approve is a refusal. */
  approve(): void {
    if (this.#state !== "awaiting-approval") throw new Error(`nothing to approve in state "${this.#state}"`);
    this.#index++;
    this.#state = "running";
    this.#advanceOrComplete();
  }

  deny(reason = "denied by the user at the approval checkpoint"): void {
    if (this.#state !== "awaiting-approval") throw new Error(`nothing to deny in state "${this.#state}"`);
    this.#state = "denied";
    this.#denyReason = reason;
  }

  /** Skip checkpoint-only (empty) segments without exposing a prompt; settle on running/awaiting/completed. */
  #advanceOrComplete(): void {
    if (this.#index >= this.#segments.length) {
      this.#state = "completed";
      return;
    }
    this.#enterSegment();
  }

  #enterSegment(): void {
    if (this.#segments.length === 0) {
      this.#state = "completed";
      return;
    }
    const seg = this.#segments[this.#index]!;
    if (seg.nodeIds.length === 0) {
      // A checkpoint-only segment: nothing to run. Halt at its boundary, or fall through to the next.
      this.#outputs.push("");
      if (seg.approvalAfter) {
        this.#state = "awaiting-approval";
        return;
      }
      if (seg.subagentAfter) {
        this.#state = "awaiting-subagent";
        return;
      }
      this.#index++;
      this.#advanceOrComplete();
      return;
    }
    this.#state = "running";
  }
}
