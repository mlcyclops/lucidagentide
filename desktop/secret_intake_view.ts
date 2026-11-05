// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/secret_intake_view.ts
//
// P-SECRET-INTAKE.1 (ADR-0476): the shapes the engine and the renderer share for the agent-triggered
// secret dialog. Pure types, literal lists and one shape gate, so the renderer bundle can import them
// without pulling in node modules. Nothing here ever carries a secret value: a request names WHAT is asked and WHY, an
// outcome names WHERE it was stored.

/** One pending `request_secret` call, as the dialog shows it. Every string from the agent (name, purpose)
 *  is rendered with textContent, never as markup. */
export interface SecretRequestView {
  id: string;
  /** Who asked, for the dialog header: the label of the caller the engine authenticated ("Main agent"),
   *  never a string from the request body. */
  requester: string;
  /** What the agent calls the secret, e.g. "OpenAI API key". */
  name: string;
  /** A VaultKind (apikey, token, pem, json, ...). */
  kind: string;
  /** Why the agent needs it, in its own words. */
  purpose: string;
  /** The env var it will be available as, when the agent named one. */
  envName: string | null;
  /** Workspace folder name when the secret is scoped to the current workspace. */
  workspace: string | null;
  /** The vault ref it lands under. */
  ref: string;
  /** An entry already exists under that ref and will be replaced (only after a second confirmation). */
  replaces: boolean;
  /** The saved entry's label (and last-4) the confirmation names; null when nothing is replaced. */
  replacesLabel: string | null;
  createdAt: number;
  expiresAt: number;
}

/** What `request_secret` returns to the agent: never a value. */
export type SecretIntakeResult =
  | { stored: true; ref: string; envName: string | null }
  | { stored: false; reason: string };

/** What the dialog learns after a store: where it went, never the value (last-4 is the UI-only hint,
 *  absent for secrets shorter than 12 characters). */
export interface SecretStoredView {
  ref: string;
  kind: string;
  label: string;
  envName: string | null;
  last4: string | null;
}
/** A dialog call's answer: stored metadata, or the engine's refusal (`code`: not-found, empty, refused,
 *  file, fallback, unreachable). */
export type SecretCallResult = ({ ok: true } & SecretStoredView) | { ok: false; error: string; code: string };

/** Shape gate for a store answer on the wire (`data` of a 200 reply). */
export function isSecretStoredView(d: unknown): d is SecretStoredView {
  if (!d || typeof d !== "object") return false;
  const nullableString = (k: string) => { const v = Reflect.get(d, k); return v === null || typeof v === "string"; };
  return Reflect.get(d, "stored") === true && typeof Reflect.get(d, "ref") === "string" && typeof Reflect.get(d, "kind") === "string" &&
    typeof Reflect.get(d, "label") === "string" && nullableString("envName") && nullableString("last4");
}

/** Contract C destination kinds the "another secrets manager?" question offers. */
export const SECRET_MANAGER_KINDS = ["azure-kv", "aws-sm", "gcp-sm", "hashicorp-vault"] as const;
export type SecretManagerKind = (typeof SECRET_MANAGER_KINDS)[number];
/** The user's answer: none, one of the Contract C kinds, or a manager LUCID has no connector for. */
export type SecretManagerAnswer = "none" | "other" | SecretManagerKind;
export const SECRET_MANAGER_LABELS: Record<SecretManagerAnswer, string> = {
  none: "No, only LUCID",
  "azure-kv": "Azure Key Vault",
  "aws-sm": "AWS Secrets Manager",
  "gcp-sm": "Google Secret Manager",
  "hashicorp-vault": "HashiCorp Vault",
  other: "Another one",
};

/** The answer to "Do you keep another secrets manager or vault?", as the engine reports it back. */
export interface SecretManagerOutcome {
  /** A Contract C destination entry was written (enterprise add-on installed and the entry validated). */
  saved: boolean;
  /** The preference was recorded locally (always true unless the write itself failed). */
  recorded: boolean;
  /** The enterprise add-on's kms connector is installed. */
  enterprise: boolean;
  /** One sentence for the dialog: what happened and, when nothing was saved, why and where to finish. */
  detail: string;
}
