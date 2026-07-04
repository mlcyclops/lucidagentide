// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/runner.ts — P-AGENT.4a (ADR-0129): materialize a compiled AgentBundle onto disk and produce
// the omp launch inputs to run it INSIDE LUCID. This is the seam P-AGENT.4b uses to actually spawn omp; it is
// kept PURE-of-omp (just fs + arg assembly) so it's unit-testable without a live model.
//
// A built agent runs through the SAME `acp_backend -> omp acp` path as chat, with:
//   • the mandatory fail-closed security gate loaded FIRST (unchanged, invariant #4), then
//   • this agent's generated allow-list extension appended via `-e <allowlist.ts>` (defense-in-depth), and
//   • the agent's system prompt appended via `--append-system-prompt` (TAIL content — never the frozen prefix).
// The agent's requested egress patterns are surfaced for the caller to register with the network whitelist
// under the managed ceiling (fail-closed); the runner does not widen egress itself.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { AgentBundle, AgentManifest } from "./compiler.ts";

export interface MaterializedRun {
  runDir: string;
  extensionPath: string; // absolute path to the generated allow-list `-e` extension
  systemPromptPath: string;
  systemPrompt: string; // to append via omp `--append-system-prompt` (TAIL content)
  ompExtensionArgs: string[]; // ["-e", extensionPath] — appended AFTER the gate, never before
  egress: string[]; // whitelist patterns the agent requests (caller registers under the managed ceiling)
  manifest: AgentManifest;
}

export interface BuiltAgentLaunch {
  /** The full omp argv (after the binary): `acp -e <gate> [-e <extra>…] -e <allowlist> --append-system-prompt …` */
  args: string[];
  /** The exact text passed to `--append-system-prompt` (base policy + the agent's TAIL prompt). */
  appendSystemPrompt: string;
}

/** Compose the omp launch argv + appended system prompt for running a built agent. INVARIANT #4: the mandatory
 *  security gate is ALWAYS the first `-e` extension — the agent's own allow-list extension is appended AFTER it,
 *  never before, so a built agent can never displace the gate. The agent's system prompt is TAIL content
 *  appended after any base policy (never the frozen prefix). Pure — assembles args only; spawns nothing. */
export function composeBuiltAgentArgs(opts: {
  gate: string; // path to the fail-closed security gate extension (loaded FIRST)
  run: MaterializedRun;
  basePolicy?: string; // optional base system-prompt policy prepended to the agent's prompt
  extraExtensions?: string[]; // additional `-e` extension paths (e.g. preview), after the gate
}): BuiltAgentLaunch {
  const extra = (opts.extraExtensions ?? []).flatMap((p) => ["-e", p]);
  const appendSystemPrompt = opts.basePolicy?.trim()
    ? `${opts.basePolicy.trim()}\n\n${opts.run.systemPrompt}`
    : opts.run.systemPrompt;
  const args = ["acp", "-e", opts.gate, ...extra, ...opts.run.ompExtensionArgs, "--append-system-prompt", appendSystemPrompt];
  return { args, appendSystemPrompt };
}

/** Write every bundle file under `runDir` and return the omp launch inputs. Directories are created as needed;
 *  nested file paths in the bundle are honored. Pure of omp — no process is spawned here. */
export function materializeBundle(bundle: AgentBundle, runDir: string): MaterializedRun {
  mkdirSync(runDir, { recursive: true });
  for (const f of bundle.files) {
    const p = join(runDir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }
  const extensionPath = join(runDir, bundle.manifest.extension);
  return {
    runDir,
    extensionPath,
    systemPromptPath: join(runDir, "SYSTEM_PROMPT.md"),
    systemPrompt: bundle.systemPrompt,
    ompExtensionArgs: ["-e", extensionPath],
    egress: bundle.manifest.egress,
    manifest: bundle.manifest,
  };
}
