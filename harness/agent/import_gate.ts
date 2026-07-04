// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/import_gate.ts — P-AGENT.5 (ADR-0133): the untrusted-spec quarantine gate. The keystone-#2
// analogue for agents: a spec that arrives from an EXTERNAL source, or whose text carries an injection /
// unicode attack, can NEVER auto-run. Only a locally-authored, clean spec is "trusted" and auto-runnable;
// everything else is held for explicit human review.
//
// Two seams, mirroring harness/security/gate.ts:
//   • scanSpec() is the FAIL-CLOSED seam — it scans the spec's model/human-facing text through the sidecar;
//     any scan failure quarantines (never passes).
//   • importDecision() / canAutoRun() are PURE — provenance + findings -> trust label -> run permission.

import type { Finding, TrustLabel } from "../contracts.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import { scanAndDecide, DEFAULT_POLICY, type GatePolicy, type GateDecision } from "../security/gate.ts";
import { validateSpec, type AgentSpec } from "./spec.ts";

/** Where a spec came from. "local" = authored in this LUCID; "import" = loaded from an external source. */
export type SpecSource = "local" | "import";

/** Every piece of model/human-facing FREE TEXT in a spec — the injection surface. Tool names / ids are
 *  validated identifiers, not free text, so they're excluded. */
export function collectSpecText(spec: AgentSpec): string {
  const parts: string[] = [spec.name];
  if (spec.description) parts.push(spec.description);
  if (spec.persona) parts.push(spec.persona);
  for (const n of spec.nodes) {
    parts.push(n.label);
    if (n.prompt) parts.push(n.prompt);
  }
  return parts.join("\n");
}

/** Scan a spec's text, fail-closed. Any scan failure -> a blocking (quarantined) decision. */
export function scanSpec(client: ScannerClient, spec: AgentSpec, policy: GatePolicy = DEFAULT_POLICY): Promise<GateDecision> {
  return scanAndDecide(client, collectSpecText(spec), policy);
}

/** Pure: combine provenance + the scan decision into the spec's trust label. A blocking decision (findings at
 *  or above threshold, or fail-closed) -> quarantined; sub-threshold findings -> suspicious; a clean scan ->
 *  trusted if locally authored, untrusted if imported (external provenance is never auto-trusted). */
export function importDecision(source: SpecSource, decision: GateDecision): { trustLabel: TrustLabel; reason: string } {
  if (decision.block) return { trustLabel: "quarantined", reason: decision.reason };
  if (decision.findings.length > 0) return { trustLabel: "suspicious", reason: decision.reason };
  if (source === "local") return { trustLabel: "trusted", reason: "locally authored, clean scan" };
  return { trustLabel: "untrusted", reason: "imported from an external source; review before running" };
}

/** Pure: may a spec with this trust label AUTO-RUN? Only "trusted" runs without review (keystone-#2 analogue). */
export function canAutoRun(trustLabel: TrustLabel): { allowed: boolean; reason: string } {
  switch (trustLabel) {
    case "trusted":
      return { allowed: true, reason: "trusted (locally authored, clean)" };
    case "untrusted":
      return { allowed: false, reason: "imported agent — review and approve it before running" };
    case "suspicious":
      return { allowed: false, reason: "suspicious content detected in the spec — review the findings before running" };
    case "quarantined":
      return { allowed: false, reason: "quarantined — blocked until cleared by a human" };
  }
}

export interface SpecImportResult {
  ok: boolean; // false only for a parse/validation failure
  spec?: AgentSpec;
  trustLabel: TrustLabel;
  canRun: boolean;
  findings: Finding[];
  errors: string[];
  reason: string;
}

/** Full import pipeline, fail-closed: parse -> validate -> scan -> label -> run-permission. A parse error or
 *  an invalid spec quarantines (never returns a runnable spec). The caller persists `spec` under `trustLabel`
 *  and must honor `canRun` before executing it. */
export async function importSpec(
  client: ScannerClient,
  rawJson: string,
  source: SpecSource,
  policy: GatePolicy = DEFAULT_POLICY,
): Promise<SpecImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, trustLabel: "quarantined", canRun: false, findings: [], errors: ["not valid JSON"], reason: "parse error" };
  }
  const v = validateSpec(parsed);
  if (!v.ok) {
    return { ok: false, trustLabel: "quarantined", canRun: false, findings: [], errors: v.errors, reason: "invalid spec" };
  }
  const decision = await scanSpec(client, v.spec!, policy);
  const { trustLabel, reason } = importDecision(source, decision);
  const { allowed } = canAutoRun(trustLabel);
  return { ok: true, spec: v.spec, trustLabel, canRun: allowed, findings: decision.findings, errors: [], reason };
}
