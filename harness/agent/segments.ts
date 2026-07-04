// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/segments.ts — P-AGENT.11a (ADR-0137): the segment runner that makes approval nodes REAL.
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
// Segment prompts are TAIL content built from the same pieces as the one-shot compiler (stepLine +
// LUCID_CORE_INSTRUCTIONS); the frozen prefix is never touched (invariant #6). Prior segment output is
// agent-generated within the same run (same trust domain) and is carried forward as plain context.

import { validateSpec, type AgentSpec, type AgentNode } from "./spec.ts";
import { topoOrder, stepLine, LUCID_CORE_INSTRUCTIONS } from "./compiler.ts";

export interface ApprovalBoundary {
  nodeId: string;
  label: string;
}

export interface RunSegment {
  /** Topo-ordered non-approval node ids executed in this segment (may be empty, e.g. approval-first specs). */
  nodeIds: string[];
  /** Present when the segment ends at an approval node — the machine halts there until a human decides. */
  approvalAfter?: ApprovalBoundary;
}

/** Split the spec's topological order into segments at approval boundaries. The approval node itself is
 *  a BOUNDARY, not an executed step. A trailing non-empty run of steps forms the final segment; a spec
 *  whose last node is an approval simply completes right after that approval. */
export function splitSegments(spec: AgentSpec): RunSegment[] {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const segments: RunSegment[] = [];
  let acc: string[] = [];
  for (const id of topoOrder(spec)) {
    const node = byId.get(id)!;
    if (node.kind === "approval") {
      segments.push({ nodeIds: acc, approvalAfter: { nodeId: node.id, label: node.label } });
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

export type SegmentedRunState = "running" | "awaiting-approval" | "completed" | "denied";

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

  /** Record the finished segment's output and advance: to the boundary halt, the next segment, or done. */
  recordSegmentOutput(output: string): void {
    if (this.#state !== "running") throw new Error(`cannot record output in state "${this.#state}"`);
    this.#outputs.push(output);
    const seg = this.#segments[this.#index]!;
    if (seg.approvalAfter) {
      this.#state = "awaiting-approval";
      return;
    }
    this.#index++;
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
      this.#index++;
      this.#advanceOrComplete();
      return;
    }
    this.#state = "running";
  }
}
