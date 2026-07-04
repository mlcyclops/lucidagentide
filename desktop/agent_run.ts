// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/agent_run.ts — P-AGENT.4-live (ADR-0133): run a BUILT agent one-shot INSIDE LUCID.
//
// Reuses the mechanism proven against a live model (demo_p_agent_4_live*): compile -> materialize -> spawn
// `omp -p` with the mandatory security gate loaded FIRST, then the agent's generated allow-list extension,
// then the compiled system prompt (TAIL). The tool allow-list is enforced by the extension at the omp layer.
//
// Fail-closed BEFORE spawning: a spec that isn't runnable-trust (P-AGENT.5 `canAutoRun`) is refused; an
// invalid spec is refused. Runs in an isolated per-agent dir under `.omp/agent-runs/` (v1 doesn't touch the
// user's workspace). Bounded by a hard timeout so a wedged run can't hang the engine.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildAgent } from "../harness/agent/compiler.ts";
import { materializeBundle } from "../harness/agent/runner.ts";
import { canAutoRun } from "../harness/agent/import_gate.ts";
import { SegmentedRun, subagentGuard, type SubagentBoundary } from "../harness/agent/segments.ts";
import { loadSpecFile, loadSpecTrust } from "../harness/agent/file_store.ts";
import { validateSpec, type AgentSpec } from "../harness/agent/spec.ts";
import type { TrustLabel } from "../harness/contracts.ts";

const REPO = join(import.meta.dir, "..");
// Absolute so the gate loads from THIS repo even when omp runs in the isolated run dir (mirrors acp_backend).
const GATE = join(REPO, "harness", "omp", "security_extension.ts");

function ompBin(): string {
  const fromMain = process.env.LUCID_OMP_BIN;
  if (fromMain && existsSync(fromMain)) return fromMain;
  for (const c of [join(homedir(), ".bun", "bin", "omp.exe"), join(homedir(), ".bun", "bin", "omp")]) if (existsSync(c)) return c;
  return "omp";
}

export interface AgentRunResult {
  ok: boolean;
  output?: string;
  error?: string;
  blocked?: boolean; // true when refused by the trust gate (not a runtime error)
  reason?: string;
  /** P-AGENT.11a: set when the run is HALTED at an approval boundary — resume via approveAgentRun(). */
  paused?: { runId: string; nodeId: string; label: string; outputSoFar: string };
}

export interface AgentRunOpts {
  spec: AgentSpec;
  prompt: string;
  model: string;
  workspace: string;
  trustLabel?: TrustLabel; // defaults to "trusted" (locally authored); imported specs pass their stored label
  withGate?: boolean; // default true — load the fail-closed security gate first (invariant #4)
  timeoutMs?: number;
}

/** Run a built agent one-shot. Returns its final text, a trust-gate refusal, or a runtime error. Never throws
 *  for the expected refusal paths (invalid spec / not runnable / empty prompt). */
export async function runBuiltAgent(opts: AgentRunOpts): Promise<AgentRunResult> {
  // P-AGENT.5: only a runnable-trust spec may auto-run — checked BEFORE anything is compiled or spawned.
  const gate = canAutoRun(opts.trustLabel ?? "trusted");
  if (!gate.allowed) return { ok: false, blocked: true, reason: gate.reason };

  const v = validateSpec(opts.spec);
  if (!v.ok) return { ok: false, error: `invalid spec: ${v.errors.join("; ")}` };
  if (!opts.prompt.trim()) return { ok: false, error: "enter a task for the agent to run" };

  const runDir = join(opts.workspace, ".omp", "agent-runs", v.spec!.spec_id);
  const run = materializeBundle(buildAgent(v.spec!), runDir);

  const gateArgs = opts.withGate !== false && existsSync(GATE) ? ["-e", GATE] : []; // gate FIRST (invariant #4)
  const args = [
    "-p",
    "--model",
    opts.model,
    "--no-lsp",
    "--no-session",
    ...gateArgs,
    ...run.ompExtensionArgs, // the agent's generated allow-list extension, AFTER the gate
    "--append-system-prompt",
    run.systemPrompt,
    opts.prompt,
  ];

  return spawnGatedOmp({ runDir, model: opts.model, systemPrompt: run.systemPrompt, ompExtensionArgs: run.ompExtensionArgs, prompt: opts.prompt, withGate: opts.withGate, timeoutMs: opts.timeoutMs });
}

interface SpawnOpts {
  runDir: string;
  model: string;
  systemPrompt: string;
  ompExtensionArgs: string[];
  prompt: string;
  withGate?: boolean;
  timeoutMs?: number;
}

/** One gated `omp -p` invocation (shared by the one-shot path and the P-AGENT.11a segment runner). The
 *  fail-closed gate loads FIRST (invariant #4), then the agent's generated allow-list extension. */
function spawnGatedOmp(o: SpawnOpts): AgentRunResult {
  const gateArgs = o.withGate !== false && existsSync(GATE) ? ["-e", GATE] : []; // gate FIRST (invariant #4)
  const args = ["-p", "--model", o.model, "--no-lsp", "--no-session", ...gateArgs, ...o.ompExtensionArgs, "--append-system-prompt", o.systemPrompt, o.prompt];
  try {
    const proc = Bun.spawnSync([ompBin(), ...args], {
      cwd: o.runDir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: o.timeoutMs ?? 120_000,
      killSignal: "SIGKILL",
    });
    const output = new TextDecoder().decode(proc.stdout).trim();
    const err = new TextDecoder().decode(proc.stderr).trim();
    if (!output && proc.exitCode !== 0) return { ok: false, error: err.slice(0, 500) || `omp exited ${proc.exitCode}` };
    return { ok: true, output };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── P-AGENT.11a (ADR-0137): segmented runs with ENFORCED approval halts ─────────────────────────────────
//
// The SegmentedRun machine (harness/agent/segments.ts) owns the halt; this registry only parks paused
// machines between the /api/agent/run request and the human's approve/deny. Entries expire after 30
// minutes — an expired approval is a refusal (fail-closed), never an auto-continue.

interface PausedEntry {
  machine: SegmentedRun;
  runDir: string;
  model: string;
  ompExtensionArgs: string[];
  prompt: string;
  withGate?: boolean;
  timeoutMs?: number;
  parkedAt: number;
  workspace: string; // P-AGENT.11b: child specs + trust labels are loaded from here
  lineage: string[]; // P-AGENT.11b: spec_id chain root→current for the cycle/depth guards
}

const PAUSE_TTL_MS = 30 * 60_000;
const pausedRuns = new Map<string, PausedEntry>(); // dynamic registry keyed by minted run id

function prunePaused(now: number): void {
  for (const [id, e] of pausedRuns) if (now - e.parkedAt > PAUSE_TTL_MS) pausedRuns.delete(id);
}

/** P-AGENT.11b: execute a subagent boundary — the CHILD agent under the CHILD's allow-list + trust label.
 *  Every guard hole is a run failure (fail-closed), never a skipped step. */
function execChildAgent(entry: PausedEntry, boundary: SubagentBoundary): AgentRunResult {
  const childSpec = boundary.specId ? loadSpecFile(entry.workspace, boundary.specId) : null;
  const guard = subagentGuard(entry.lineage, boundary, childSpec);
  if (!guard.ok) return { ok: false, error: guard.error };
  const trust = loadSpecTrust(entry.workspace, boundary.specId!);
  const gate = canAutoRun(trust.trustLabel);
  if (!gate.allowed) return { ok: false, blocked: true, reason: `sub-agent "${childSpec!.name}": ${gate.reason}` };
  const childDir = join(entry.workspace, ".omp", "agent-runs", childSpec!.spec_id);
  const run = materializeBundle(buildAgent(childSpec!), childDir); // the CHILD's bundle: its own allow-list extension
  const prior = entry.machine.transcript().filter((t) => t.trim()).join("\n\n");
  const childPrompt = `You are delegated the step "${boundary.label}" by a parent agent. Parent task: ${entry.prompt}${prior ? `\n\nContext from the parent agent's work so far:\n${prior}` : ""}`;
  const child = driveSegments({
    machine: new SegmentedRun(childSpec!),
    runDir: childDir,
    model: entry.model,
    ompExtensionArgs: run.ompExtensionArgs,
    prompt: childPrompt,
    withGate: entry.withGate,
    timeoutMs: entry.timeoutMs,
    parkedAt: Date.now(),
    workspace: entry.workspace,
    lineage: [...entry.lineage, childSpec!.spec_id],
  });
  // Defensive: the guard refuses children with approval nodes, so a nested park is unreachable — but if it
  // ever happened it would strand a machine; fail loudly instead.
  if (child.paused) return { ok: false, error: `sub-agent "${childSpec!.name}" halted at a nested approval — unsupported` };
  return child;
}

/** Drive the machine until it halts (approval), completes, or a segment fails. Subagent boundaries are
 *  resolved INLINE (the child runs now, under its own allow-list); approval boundaries park the run. */
function driveSegments(entry: PausedEntry): AgentRunResult {
  const m = entry.machine;
  for (;;) {
    if (m.state === "running") {
      const seg = m.currentSegment(); // the ONLY source of an executable prompt (keystone)
      const r = spawnGatedOmp({
        runDir: entry.runDir,
        model: entry.model,
        systemPrompt: seg.systemPrompt,
        ompExtensionArgs: entry.ompExtensionArgs,
        prompt: entry.prompt,
        withGate: entry.withGate,
        timeoutMs: entry.timeoutMs,
      });
      if (!r.ok) return r; // a failed segment fails the run — never skipped, never auto-approved
      m.recordSegmentOutput(r.output ?? "");
      continue;
    }
    if (m.state === "awaiting-subagent") {
      const boundary = m.pendingSubagent()!;
      const child = execChildAgent(entry, boundary);
      if (!child.ok) return child; // guard/trust/run failure fails the parent run — never silently skipped
      m.recordSubagentOutput(`Sub-agent "${boundary.label}" output:\n${child.output ?? ""}`);
      continue;
    }
    break;
  }
  if (m.state === "awaiting-approval") {
    const runId = `segrun_${crypto.randomUUID()}`;
    entry.parkedAt = Date.now();
    pausedRuns.set(runId, entry);
    const halt = m.pendingApproval()!;
    return { ok: true, paused: { runId, nodeId: halt.nodeId, label: halt.label, outputSoFar: m.transcript().filter((t) => t.trim()).join("\n\n") } };
  }
  if (m.state === "denied") return { ok: false, blocked: true, reason: m.denyReason };
  return { ok: true, output: m.finalOutput() };
}

/** Entry point used by /api/agent/run: one-shot for approval-free specs, segmented otherwise. */
export async function startAgentRun(opts: AgentRunOpts): Promise<AgentRunResult> {
  prunePaused(Date.now());
  // P-AGENT.11a/.11b: approval or subagent nodes need the segment runner; plain specs stay one-shot.
  const hasBoundary = opts.spec.nodes?.some?.((n) => n.kind === "approval" || n.kind === "subagent");
  if (!hasBoundary) return runBuiltAgent(opts);

  // Same fail-closed pre-flight as the one-shot path: trust gate, then validation, then materialize.
  const gate = canAutoRun(opts.trustLabel ?? "trusted");
  if (!gate.allowed) return { ok: false, blocked: true, reason: gate.reason };
  const v = validateSpec(opts.spec);
  if (!v.ok) return { ok: false, error: `invalid spec: ${v.errors.join("; ")}` };
  if (!opts.prompt.trim()) return { ok: false, error: "enter a task for the agent to run" };

  const runDir = join(opts.workspace, ".omp", "agent-runs", v.spec!.spec_id);
  const run = materializeBundle(buildAgent(v.spec!), runDir);
  return driveSegments({
    machine: new SegmentedRun(v.spec!),
    runDir,
    model: opts.model,
    ompExtensionArgs: run.ompExtensionArgs,
    prompt: opts.prompt,
    withGate: opts.withGate,
    timeoutMs: opts.timeoutMs,
    parkedAt: Date.now(),
    workspace: opts.workspace,
    lineage: [v.spec!.spec_id],
  });
}

/** Resolve a parked approval. Unknown/expired run ids are refusals (fail-closed), never auto-continues. */
export function approveAgentRun(runId: string, approve: boolean, reason?: string): AgentRunResult {
  prunePaused(Date.now());
  const entry = pausedRuns.get(runId);
  if (!entry) return { ok: false, error: "unknown or expired approval — run the agent again" };
  pausedRuns.delete(runId); // consumed either way; a re-pause mints a fresh id
  if (!approve) {
    entry.machine.deny(reason || "denied by the user at the approval checkpoint");
    return { ok: false, blocked: true, reason: entry.machine.denyReason };
  }
  entry.machine.approve();
  return driveSegments(entry);
}
