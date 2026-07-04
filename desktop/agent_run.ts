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
import { SegmentedRun, subagentGuard, parseBranchChoice, type SubagentBoundary } from "../harness/agent/segments.ts";
import { loadSpecFile, loadSpecTrust } from "../harness/agent/file_store.ts";
import { TraceRecorder } from "../harness/agent/trace.ts"; // P-AGENT.13: best-effort run provenance
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
  /** P-AGENT.13: the run's stable trace id (invariant #9) — look the trace up via /api/agent/trace. */
  runId?: string;
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

// ── P-AGENT.11a (ADR-0139): segmented runs with ENFORCED approval halts ─────────────────────────────────
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
  runId: string; // P-AGENT.13: stable run/trace id; ALSO the approval-resume handle (one id per run)
  recorder: TraceRecorder; // P-AGENT.13: fail-soft provenance — recording never breaks the run
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
  const childPrompt = `You are delegated the step \"${boundary.label}\" by a parent agent. Parent task: ${entry.prompt}${prior ? `\n\nContext from the parent agent's work so far:\n${prior}` : ""}`;
  const childRunId = `run_${crypto.randomUUID()}`;
  const childLineage = [...entry.lineage, childSpec!.spec_id];
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
    lineage: childLineage,
    runId: childRunId,
    recorder: new TraceRecorder(entry.workspace, { run_id: childRunId, spec_id: childSpec!.spec_id, name: childSpec!.name, model: entry.model, prompt: childPrompt, lineage: childLineage }),
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
  const rec = entry.recorder;
  for (;;) {
    if (m.state === "running") {
      const seg = m.currentSegment(); // the ONLY source of an executable prompt (keystone)
      // P-AGENT.15: the segment's reliability policy — bounded retries with linear backoff, and the
      // TIGHTEST node timeout constraining the whole segment spawn.
      let r: AgentRunResult = { ok: false, error: "segment did not run" };
      for (let attempt = 0; attempt <= seg.policy.retryMax; attempt++) {
        if (attempt > 0) Bun.sleepSync(Math.min(10_000, seg.policy.backoffMs * attempt));
        const t0 = Date.now();
        r = spawnGatedOmp({
          runDir: entry.runDir,
          model: entry.model,
          systemPrompt: seg.systemPrompt,
          ompExtensionArgs: entry.ompExtensionArgs,
          prompt: entry.prompt,
          withGate: entry.withGate,
          timeoutMs: seg.policy.timeoutMs ?? entry.timeoutMs,
        });
        rec.step({
          kind: "segment",
          node_ids: seg.nodeIds,
          label: attempt ? `part ${seg.index + 1} (retry ${attempt}/${seg.policy.retryMax})` : `part ${seg.index + 1}`,
          started_at: t0,
          finished_at: Date.now(),
          ok: r.ok,
          detail: r.ok ? (r.output ?? "") : (r.error ?? "segment failed"),
        });
        if (r.ok) break;
      }
      if (!r.ok) { rec.status("error"); return { ...r, runId: entry.runId }; } // retries exhausted — the run fails
      m.recordSegmentOutput(r.output ?? "");
      continue;
    }
    if (m.state === "at-branch") {
      // P-AGENT.11c: the decision came back in the segment output as a `CHOICE: <option>` line. No parseable
      // choice → the run FAILS with the expected options named — the runner never guesses a path.
      const b = m.pendingBranch()!;
      const choice = parseBranchChoice(m.transcript().at(-1) ?? "", b.options);
      if (!choice) {
        const expected = b.options.map((o) => o.label).join(", ");
        rec.step({ kind: "branch", node_ids: [b.nodeId], label: b.label, started_at: Date.now(), finished_at: Date.now(), ok: false, detail: `no parseable CHOICE line; expected one of: ${expected}` });
        rec.status("error");
        return { ok: false, error: `branch "${b.label}": the agent did not emit a parseable CHOICE line (expected one of: ${expected})`, runId: entry.runId };
      }
      m.takeBranch(choice.edgeId);
      rec.step({ kind: "branch", node_ids: [b.nodeId], label: b.label, started_at: Date.now(), finished_at: Date.now(), ok: true, detail: `chose "${choice.label}" — the not-taken path is skipped` });
      continue;
    }
    if (m.state === "awaiting-subagent") {
      const boundary = m.pendingSubagent()!;
      const t0 = Date.now();
      const child = execChildAgent(entry, boundary);
      rec.step({ kind: "subagent", node_ids: [boundary.nodeId], label: boundary.label, started_at: t0, finished_at: Date.now(), ok: child.ok, detail: child.ok ? `child ${child.runId ?? "?"}: ${child.output ?? ""}` : (child.error ?? child.reason ?? "sub-agent failed") });
      if (!child.ok) { rec.status(child.blocked ? "blocked" : "error"); return { ...child, runId: entry.runId }; }
      m.recordSubagentOutput(`Sub-agent \"${boundary.label}\" output:\n${child.output ?? ""}`);
      continue;
    }
    break;
  }
  if (m.state === "awaiting-approval") {
    entry.parkedAt = Date.now();
    pausedRuns.set(entry.runId, entry); // the run's stable id IS the approval handle (invariant #9)
    const halt = m.pendingApproval()!;
    rec.status("awaiting-approval");
    return { ok: true, runId: entry.runId, paused: { runId: entry.runId, nodeId: halt.nodeId, label: halt.label, outputSoFar: m.transcript().filter((t) => t.trim()).join("\n\n") } };
  }
  if (m.state === "denied") { rec.status("denied"); return { ok: false, blocked: true, reason: m.denyReason, runId: entry.runId }; }
  rec.status("completed", m.finalOutput());
  return { ok: true, output: m.finalOutput(), runId: entry.runId };
}

/** Entry point used by /api/agent/run: one-shot for approval-free specs, segmented otherwise. */
export async function startAgentRun(opts: AgentRunOpts): Promise<AgentRunResult> {
  prunePaused(Date.now());
  const runId = `run_${crypto.randomUUID()}`; // stable per run (invariant #9): trace id + approval handle
  // P-AGENT.11a/.11b: approval or subagent nodes need the segment runner; plain specs stay one-shot.
  const hasBoundary = opts.spec.nodes?.some?.((n) => n.kind === "approval" || n.kind === "subagent");
  if (!hasBoundary) {
    // P-AGENT.13: the one-shot path is a single-step trace (refusals + errors are audit-worthy too).
    const rec = new TraceRecorder(opts.workspace, {
      run_id: runId,
      spec_id: opts.spec.spec_id ?? "unknown",
      name: opts.spec.name ?? "agent",
      model: opts.model,
      prompt: opts.prompt,
      lineage: [opts.spec.spec_id ?? "unknown"],
    });
    const t0 = Date.now();
    const r = await runBuiltAgent(opts);
    rec.step({ kind: "segment", node_ids: (opts.spec.nodes ?? []).map((n) => n.id), label: "one-shot run", started_at: t0, finished_at: Date.now(), ok: r.ok, detail: r.ok ? (r.output ?? "") : (r.error ?? r.reason ?? "run failed") });
    rec.status(r.ok ? "completed" : r.blocked ? "blocked" : "error", r.output);
    return { ...r, runId };
  }

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
    runId,
    recorder: new TraceRecorder(opts.workspace, { run_id: runId, spec_id: v.spec!.spec_id, name: v.spec!.name, model: opts.model, prompt: opts.prompt, lineage: [v.spec!.spec_id] }),
  });
}

/** Resolve a parked approval. Unknown/expired run ids are refusals (fail-closed), never auto-continues. */
export function approveAgentRun(runId: string, approve: boolean, reason?: string): AgentRunResult {
  prunePaused(Date.now());
  const entry = pausedRuns.get(runId);
  if (!entry) return { ok: false, error: "unknown or expired approval — run the agent again" };
  pausedRuns.delete(runId); // consumed either way; a resumed run re-parks under the SAME stable id
  const halt = entry.machine.pendingApproval();
  const t0 = Date.now();
  if (!approve) {
    entry.machine.deny(reason || "denied by the user at the approval checkpoint");
    entry.recorder.step({ kind: "approval", node_ids: halt ? [halt.nodeId] : [], label: halt?.label ?? "approval", started_at: t0, finished_at: Date.now(), ok: false, detail: entry.machine.denyReason });
    entry.recorder.status("denied");
    return { ok: false, blocked: true, reason: entry.machine.denyReason, runId: entry.runId };
  }
  entry.recorder.step({ kind: "approval", node_ids: halt ? [halt.nodeId] : [], label: halt?.label ?? "approval", started_at: t0, finished_at: Date.now(), ok: true, detail: "approved by the user" });
  entry.machine.approve();
  return driveSegments(entry);
}
