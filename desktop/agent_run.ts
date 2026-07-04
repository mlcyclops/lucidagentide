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

  try {
    const proc = Bun.spawnSync([ompBin(), ...args], {
      cwd: runDir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts.timeoutMs ?? 120_000,
      killSignal: "SIGKILL",
    });
    const output = new TextDecoder().decode(proc.stdout).trim();
    const err = new TextDecoder().decode(proc.stderr).trim();
    if (!output && proc.exitCode !== 0) return { ok: false, error: err.slice(0, 500) || `omp exited ${proc.exitCode}` };
    return { ok: true, output };
  } catch (e) {
    return { ok: false, error: String((e as { message?: unknown })?.message ?? e) };
  }
}
