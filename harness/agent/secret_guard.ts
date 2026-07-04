// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/secret_guard.ts — P-AGENT.8 (ADR-0134): the SECRET guardrail for the conversational Agent
// Builder. The user's #1 rule: the agent must NEVER collect or embed a secret VALUE in an agent — credentials
// live only in the OS-encrypted vault (desktop/cred_vault.ts), referenced by name (SecretRef).
//
// `scanSpecForSecrets` inspects every piece of FREE TEXT in a spec (name/description/persona/node
// labels+prompts + secret `purpose` / provisioning help-text) for APPARENT secret values: PEM private keys, vendor API-key
// shapes (AWS/OpenAI-style/GitHub/Slack/Google), bearer tokens, and `password/secret/token = <value>`
// assignments. `assertSecretFree` throws on any hit — wired into save/compile/open so a spec carrying a
// credential can NEVER be persisted, compiled, or run. High-signal patterns only (declared SecretRefs, env-var
// NAMES, and ordinary prose stay clean — proven by the tests).

import type { AgentSpec } from "./spec.ts";

export interface SecretLeak {
  where: string; // which field the apparent secret was found in
  pattern: string; // which detector fired (human label)
  snippet: string; // a short, REDACTED excerpt (first few chars only) for the message — never the full secret
}

interface Detector {
  label: string;
  re: RegExp;
}

// Each detector is high-precision: it matches shapes that are almost always real credentials, not prose.
const DETECTORS: Detector[] = [
  { label: "PEM private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { label: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "OpenAI/Anthropic-style key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { label: "bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
  // `password: hunter2secret` / `api_key = abc123def456...` — a credential-ish key with a non-trivial value.
  { label: "inline credential assignment", re: /\b(?:pass(?:word|wd)?|secret|api[_-]?key|api[_-]?token|access[_-]?token|client[_-]?secret|auth[_-]?token)\b\s*[:=]\s*["']?[^\s"'{}<>]{8,}/i },
];

/** Every free-text field in a spec, tagged with where it came from. Tool names / ids / ref NAMES are excluded
 *  (identifiers, not free text — and a ref name like SALESFORCE_API_TOKEN must NOT trip the guardrail). */
function specTextFields(spec: AgentSpec): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  const add = (where: string, text: unknown) => { if (typeof text === "string" && text) out.push({ where, text }); };
  add("name", spec.name);
  add("description", spec.description);
  add("persona", spec.persona);
  for (const n of spec.nodes ?? []) {
    add(`node ${n.id} label`, n.label);
    add(`node ${n.id} prompt`, n.prompt);
  }
  for (const r of spec.secrets ?? []) {
    add(`secret ${r.name} purpose`, r.purpose); // help-text only; the NAME is skipped
    add(`secret ${r.name} provisioning instructions`, r.provisioning?.instructions);
    add(`secret ${r.name} provisioning ticket system`, r.provisioning?.ticket?.system);
    add(`secret ${r.name} provisioning ticket rationale`, r.provisioning?.ticket?.rationale);
    for (const [k, v] of Object.entries(r.provisioning?.ticket?.template ?? {})) add(`secret ${r.name} provisioning ticket ${k}`, v);
  }
  return out;
}

/** Scan a set of tagged free-text fields for APPARENT embedded secret values. Returns one leak per
 *  (field, detector) hit; empty = clean. Shared by `scanSpecForSecrets` (Agent Builder) and the user-command
 *  guardrail (P-CMD.1) so the SAME high-precision detector list is the single source of truth. */
export function scanTextsForSecrets(fields: Array<{ where: string; text: unknown }>): SecretLeak[] {
  const leaks: SecretLeak[] = [];
  for (const { where, text } of fields) {
    if (typeof text !== "string" || !text) continue;
    for (const d of DETECTORS) {
      const m = d.re.exec(text);
      if (m) leaks.push({ where, pattern: d.label, snippet: `${m[0].slice(0, 6)}…(redacted)` });
    }
  }
  return leaks;
}

/** Scan a spec for APPARENT embedded secret values. Returns one leak per (field, detector) hit; empty = clean. */
export function scanSpecForSecrets(spec: AgentSpec): SecretLeak[] {
  return scanTextsForSecrets(specTextFields(spec));
}

/** Throw (fail-closed) if the spec embeds any apparent secret. Wired into save/compile/open/run so a
 *  credential can never ride along inside an agent. */
export function assertSecretFree(spec: AgentSpec): void {
  const leaks = scanSpecForSecrets(spec);
  if (leaks.length === 0) return;
  const where = leaks.map((l) => `${l.where} (${l.pattern})`).join(", ");
  throw new Error(
    `refusing: this agent appears to embed a secret in ${where}. Secrets must go in the LUCID credential vault, ` +
      `not in the agent — declare a credential name (SecretRef) and add the value in the vault instead.`,
  );
}
