// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/handoff.ts — P-AGENT.8.2 (ADR-0130): the chat -> Agent-Builder handoff. Pure + fail-closed,
// shared by the `agent_builder_open` omp tool (agent feedback) and acp_backend (the authoritative gate before
// the canvas opens). A drafted spec is only accepted if it PARSES, VALIDATES (v1 DAG), and is SECRET-FREE
// (secret_guard) — so the handoff can never open the builder pre-populated with an invalid or credential-
// carrying draft.

import { validateSpec, type AgentSpec } from "./spec.ts";
import { scanSpecForSecrets } from "./secret_guard.ts";

export interface HandoffResult {
  ok: boolean;
  message: string; // human-readable status (also the agent-facing tool feedback)
  spec?: AgentSpec; // present only when ok
}

/** Parse + validate + secret-scan a drafted spec (JSON string). Fail-closed: a bad/leaky draft is rejected
 *  with a message that steers the agent to fix it (e.g. declare a credential NAME instead of a value). */
export function parseDraftedSpec(specJson: string): HandoffResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(specJson);
  } catch {
    return { ok: false, message: "the drafted spec must be valid JSON" };
  }
  const v = validateSpec(parsed);
  if (!v.ok) return { ok: false, message: `invalid spec: ${v.errors.join("; ")}` };
  const leaks = scanSpecForSecrets(v.spec!);
  if (leaks.length) {
    return {
      ok: false,
      message: `the draft embeds a secret in ${leaks.map((l) => l.where).join(", ")} — declare a credential NAME (a SecretRef) and have the user add the value in the vault, never in the spec`,
    };
  }
  return { ok: true, message: `ready: "${v.spec!.name}" (${v.spec!.nodes.length} steps)`, spec: v.spec! };
}

/** Detect an `agent_builder_open` tool call and return the drafted spec, or null. `specJson` is UNIQUE to this
 *  tool, so its presence (with a valid parse) is a reliable trigger regardless of how omp renders the call
 *  title (name vs label) — more robust than matching the title. Fail-closed: an invalid draft returns null. */
export function agentBuilderOpenSpec(toolName: string | null | undefined, rawInput: unknown): AgentSpec | null {
  const specJson = typeof (rawInput as { specJson?: unknown })?.specJson === "string" ? (rawInput as { specJson: string }).specJson : "";
  // Accept when the call carries specJson OR the title names our tool (belt-and-braces); both then re-validate.
  if (!specJson && !/\bagent_builder_open\b/i.test(toolName ?? "")) return null;
  if (!specJson) return null;
  const r = parseDraftedSpec(specJson);
  return r.ok ? r.spec! : null;
}
