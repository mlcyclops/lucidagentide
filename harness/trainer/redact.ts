// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/redact.ts - P-TRAINER.3 (ADR-0254 decision 5): procedures, never people.
//
// PII redaction runs BEFORE storage or model calls - by the time a captured span reaches the
// artifact store, the distiller prompt, or an exportable pack, client identities are placeholders.
// (Redacting after storage is redacting never: the data would already live in the KG and its
// embeddings.) Two classes:
//   - REDACTABLE: emails, phone numbers, dollar amounts, honorific-name references - replaced with
//     typed placeholders; the unit proceeds.
//   - HARD: SSNs and account-number-shaped digit runs - also replaced, but their presence marks the
//     capture `hard`, and the distiller stores the unit QUARANTINED (never promotable, never
//     exportable) pending human review. A number that identifies an account does not belong in a
//     process description at all; its appearance is a signal the answer was about a client, not a
//     procedure.
// Pure and deliberately conservative: patterns over inference, no network, no model.

export type PiiKind = "email" | "phone" | "ssn" | "account_number" | "dollar_amount" | "client_name";

export interface PiiFinding {
  kind: PiiKind;
  /** The placeholder the match was replaced with. */
  placeholder: string;
  index: number;
}

export interface RedactionResult {
  text: string;
  findings: PiiFinding[];
  /** True when a HARD kind (ssn / account_number) was present - the unit must quarantine. */
  hard: boolean;
}

const PLACEHOLDER: Record<PiiKind, string> = {
  email: "[EMAIL]",
  phone: "[PHONE]",
  ssn: "[SSN]",
  account_number: "[ACCOUNT]",
  dollar_amount: "[AMOUNT]",
  client_name: "[CLIENT]",
};

const HARD_KINDS: ReadonlySet<PiiKind> = new Set(["ssn", "account_number"]);

// Order matters: SSN before phone (both are digit runs with dashes), account numbers after both so
// a matched SSN/phone is not re-matched as an account run.
const PATTERNS: Array<{ kind: PiiKind; re: RegExp }> = [
  { kind: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "phone", re: /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g },
  { kind: "account_number", re: /\b\d{8,17}\b/g },
  { kind: "dollar_amount", re: /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|mm|bn|million|billion|thousand)?\b/gi },
  { kind: "client_name", re: /\b(?:Mr|Mrs|Ms|Dr|Miss)\.?\s+[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)?/g },
];

/** Redact PII into typed placeholders. Idempotent: placeholders never re-match. */
export function redactPii(text: string): RedactionResult {
  const findings: PiiFinding[] = [];
  let out = text;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, (match, ...rest) => {
      const index = rest[rest.length - 2] as number; // offset arg precedes the full string
      findings.push({ kind, placeholder: PLACEHOLDER[kind], index });
      return PLACEHOLDER[kind];
    });
  }
  return { text: out, findings, hard: findings.some((f) => HARD_KINDS.has(f.kind)) };
}
