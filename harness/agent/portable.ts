// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/portable.ts — P-AGENT.9 (ADR-0137): shareable Agent Builder export/import format.
//
// This is the USER-SHARE format, distinct from the enterprise deploy bundle in export.ts. It carries the
// AgentSpec and setup instructions, never credential values. The spec itself still declares SecretRef NAMES;
// on import LUCID asks the recipient to add values to their own OS-encrypted vault or request Just-In-Time
// tokens through their organization's KMS / IT ticketing process.

import { createHash } from "node:crypto";
import { validateSpec, type AgentSpec, type SecretRef } from "./spec.ts";
import { assertSecretFree } from "./secret_guard.ts";

export const PORTABLE_AGENT_FORMAT = "lucid-agent" as const;
export const PORTABLE_AGENT_VERSION = 1 as const;

export interface PortableAgentFile {
  format: typeof PORTABLE_AGENT_FORMAT;
  version: typeof PORTABLE_AGENT_VERSION;
  exported_at: number;
  spec_digest: string;
  setup_md: string;
  spec: AgentSpec;
}

export interface PortableParseResult {
  ok: boolean;
  spec?: AgentSpec;
  setupMd?: string;
  errors: string[];
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Deterministic JSON for digesting. Object keys are sorted recursively; arrays keep order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function specDigest(spec: AgentSpec): string {
  return sha256(canonicalJson(spec));
}

function secretSetupLines(secret: SecretRef): string[] {
  const out: string[] = [];
  out.push(`### ${secret.name}`);
  out.push(`- Kind: ${secret.kind}`);
  if (secret.purpose) out.push(`- Purpose: ${secret.purpose}`);
  const p = secret.provisioning;
  if (!p) {
    out.push("- Setup: Add the credential value in LUCID → Secrets & connections. It is stored in your OS-encrypted vault and is not embedded in this agent file.");
    return out;
  }
  if (p.method === "user-input") {
    out.push("- Setup: Paste your credential value into LUCID → Secrets & connections. LUCID stores it in the OS-encrypted vault on this machine; the agent file only stores this ref name.");
    if (p.instructions) out.push(`- How to obtain it: ${p.instructions}`);
    return out;
  }
  out.push("- Setup: Request a Just-In-Time token through your organization's KMS / IT access workflow, then paste the issued value into LUCID → Secrets & connections.");
  if (p.instructions) out.push(`- Request instructions: ${p.instructions}`);
  if (p.ticket) {
    out.push(`- Ticketing system: ${p.ticket.system}`);
    if (p.ticket.rationale) out.push(`- Access rationale: ${p.ticket.rationale}`);
    const entries = Object.entries(p.ticket.template ?? {});
    if (entries.length) {
      out.push("- Sample ticket fields:");
      for (const [k, v] of entries) out.push(`  - ${k}: ${v}`);
    }
  }
  return out;
}

export function setupInstructions(spec: AgentSpec): string {
  const lines: string[] = [
    `# Setup for ${spec.name}`,
    "",
    "This portable LUCID agent file does not contain credential values. It carries only credential ref names, tool allow-list data, and requested network egress patterns.",
    "",
    "## Tool allow-list",
    spec.tools.length ? spec.tools.map((t) => `- ${t}`).join("\n") : "- No tools allowed.",
    "",
    "## Network egress requested",
    spec.egress.length ? spec.egress.map((e) => `- ${e}`).join("\n") : "- No outbound network hosts requested.",
    "",
    "## Credentials to configure",
  ];
  if (!spec.secrets?.length) lines.push("- No credentials declared.");
  else {
    for (const s of spec.secrets) {
      lines.push("");
      lines.push(...secretSetupLines(s));
    }
  }
  lines.push("");
  lines.push("After import, review the workflow, approve the imported trust banner if acceptable, add credentials to the local vault, then run the agent.");
  return lines.join("\n");
}

export function exportPortableAgent(spec: AgentSpec, now: number = Date.now()): PortableAgentFile {
  const v = validateSpec(spec);
  if (!v.ok) throw new Error(`invalid spec: ${v.errors.join("; ")}`);
  assertSecretFree(v.spec!);
  return {
    format: PORTABLE_AGENT_FORMAT,
    version: PORTABLE_AGENT_VERSION,
    exported_at: now,
    spec_digest: specDigest(v.spec!),
    setup_md: setupInstructions(v.spec!),
    spec: v.spec!,
  };
}

function readPortableEnvelope(raw: unknown): { ok: boolean; file?: PortableAgentFile; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: ["portable agent must be an object"] };
  const obj = raw as Record<string, unknown>;
  const exportedAt = obj.exported_at;
  const claimedDigest = obj.spec_digest;
  const setupMd = obj.setup_md;
  if (obj.format !== PORTABLE_AGENT_FORMAT) errors.push(`format must be ${PORTABLE_AGENT_FORMAT}`);
  if (obj.version !== PORTABLE_AGENT_VERSION) errors.push(`version must be ${PORTABLE_AGENT_VERSION}`);
  if (typeof exportedAt !== "number") errors.push("exported_at must be a number");
  if (typeof claimedDigest !== "string" || !/^[a-f0-9]{64}$/.test(claimedDigest)) errors.push("spec_digest must be a sha256 hex string");
  if (typeof setupMd !== "string") errors.push("setup_md must be a string");
  if (obj.spec === undefined) errors.push("spec is required");
  if (errors.length || typeof exportedAt !== "number" || typeof claimedDigest !== "string" || typeof setupMd !== "string")
    return { ok: false, errors };
  const v = validateSpec(obj.spec);
  if (!v.ok) return { ok: false, errors: v.errors };
  if (specDigest(v.spec!) !== claimedDigest) return { ok: false, errors: ["portable agent digest mismatch — the spec was modified after export"] };
  assertSecretFree(v.spec!);
  return {
    ok: true,
    errors: [],
    file: {
      format: PORTABLE_AGENT_FORMAT,
      version: PORTABLE_AGENT_VERSION,
      exported_at: exportedAt,
      spec_digest: claimedDigest,
      setup_md: setupMd,
      spec: v.spec!,
    },
  };
}

export function parsePortableAgentJson(rawJson: string): PortableParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, errors: ["not valid JSON"] };
  }
  const r = readPortableEnvelope(parsed);
  if (!r.ok || !r.file) return { ok: false, errors: r.errors };
  return { ok: true, spec: r.file.spec, setupMd: r.file.setup_md, errors: [] };
}
