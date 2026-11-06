// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/vault_redact_extension.ts - SECRET-INTAKE-AGENT-ENV-READBACK (wave B security review,
// finding 2): replace every vault secret value that shows up in a tool result with `[vault:<NAME>]`
// before the model, the transcript or the session file can see it.
//
// WHY. Vault secrets live in the agent's own environment: workspace `ws:` secrets are added to the master
// and lane spawn env, and `key:<ENV>` provider keys plus engine-resolved credential env sit in process.env,
// which the omp child inherits. So `printenv`, `echo $NAME`, a debug log or a `cat .env` written by a tool
// puts the value into tool output and from there into model context. That breaks the wave-B rule that a
// secret value never reaches the transcript or the model.
//
// HOW. The engine passes LUCID_VAULT_REDACT_NAMES: a comma-separated list of env var NAMES, never values.
// At load this extension reads each name's value from its own process.env and compiles one matcher over
// every form the value commonly takes in output: the plain value, its JSON-escaped form (a value inside a
// JSON blob), its base64 and base64url encodings (unpadded, so padded output is caught too) and its
// URL-encoded form. Longest needles are tried first, so when one value contains another the outer value
// redacts as a whole. omp's `tool_result` hook (ToolResultEventResult) then rewrites every text part of
// every tool result, built-in and MCP alike, and every string inside `details`. The redacted `details` are
// then serialized (class instances stringified, Map/Set as entries) and checked with the same matcher: if
// any secret form survives, or they cannot be serialized (a cycle), the details are dropped and the
// content says so (DETAILS_WITHHELD_NOTICE).
//
// THRESHOLD. Values shorter than MIN_REDACT_LENGTH (6) characters are skipped: a short value such as
// "1", "true" or "dev" would shred ordinary output, and a value that short is not a credential anyway.
//
// LOAD ORDER. omp chains tool_result handlers in extension load order, each one seeing the previous
// handler's result. This extension MUST load AFTER security_extension.ts and mcp_result_gate.ts so the
// gates rule on the raw call and result, and the model only sees the redacted text. It is the last
// result-mutating extension in the spawn args.
//
// FAIL-CLOSED, NEVER THROWS (invariant 3). A tool result the redactor fails on is replaced by
// WITHHELD_NOTICE (no original text, details dropped, isError); if the redactor cannot even be built while
// vault values are named, a handler that withholds EVERY tool result is registered instead. Each failure
// writes a stderr notice (no value, no error text that could carry one). Registers nothing when the
// variable is absent or none of its names hold a value of redactable length (nothing to protect), so a
// plain `omp` run is unaffected.

import { writeStderrNotice } from "./stderr_notice.ts";

/** One vault secret as the redactor sees it: the env var name (shown in the marker) and its value. */
export interface VaultSecret {
  name: string;
  value: string;
}

/** Values shorter than this are not redacted (see THRESHOLD in the header). */
export const MIN_REDACT_LENGTH = 6;

/** Text and image parts of a tool result (structurally omp's TextContent | ImageContent). */
type ResultContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** The replacement a tool_result handler returns (structurally omp's ToolResultEventResult). */
export interface RedactedResult {
  content?: ResultContent[];
  details?: unknown;
  isError?: boolean;
}

/** The sliver of omp's ExtensionAPI this module touches; omp's types are not exported to `-e` extensions. */
interface OmpHookApi {
  on?: (event: "tool_result", handler: (event: unknown) => RedactedResult | undefined) => void;
}

/** Compile one matcher over every encoded form of every secret. Returns the identity function when no
 *  secret is long enough, so callers can always apply the result. */
export function buildRedactor(secrets: readonly VaultSecret[]): (text: string) => string {
  // Null prototype: a value such as "toString" or "__proto__" must be an ordinary key, not an inherited one.
  const nameByNeedle: Record<string, string> = Object.create(null);
  for (const { name, value } of secrets) {
    if (value.length < MIN_REDACT_LENGTH) continue;
    const base64 = Buffer.from(value, "utf8").toString("base64").replace(/=+$/, "");
    const forms = [
      value,
      JSON.stringify(value).slice(1, -1),
      base64,
      base64.replace(/\+/g, "-").replace(/\//g, "_"),
      encodeURIComponent(value),
    ];
    for (const form of forms) if (!(form in nameByNeedle)) nameByNeedle[form] = name;
  }
  const needles = Object.keys(nameByNeedle).sort((a, b) => b.length - a.length);
  if (needles.length === 0) return (text) => text;
  // Alternation is tried left to right at each position, so longest-first means an outer value wins over
  // a value it contains.
  const matcher = new RegExp(needles.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return (text) => text.replace(matcher, (hit) => `[vault:${nameByNeedle[hit]}]`);
}

/** Replace every occurrence of a secret value (plain, JSON-escaped, base64, base64url, URL-encoded) in
 *  `text` with `[vault:<NAME>]`. */
export function redactVaultValues(text: string, secrets: readonly VaultSecret[]): string {
  return buildRedactor(secrets)(text);
}

/** Copy `value` with every string redacted. Only plain objects and arrays are walked (class instances
 *  pass through as is), unchanged subtrees keep their identity, and a cycle stops the walk. */
function redactDeep(value: unknown, redact: (text: string) => string, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redact(value);
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    const next = value.map((v) => redactDeep(v, redact, seen));
    return next.some((v, i) => v !== value[i]) ? next : value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    next[k] = redactDeep(v, redact, seen);
    if (next[k] !== v) changed = true;
  }
  return changed ? next : value;
}

/** Does `details` (after redactDeep) still carry a secret form anywhere? Serialized with every class
 *  instance stringified (`toJSON` when it has one, which JSON.stringify applies first; else String() plus
 *  its own enumerable fields; Map and Set as their entries) and run through the same matcher. A value that
 *  cannot be serialized (a cycle, a BigInt) cannot be checked, so it counts as holding one (fail-closed). */
function detailsHoldSecret(details: unknown, redact: (text: string) => string): boolean {
  if (details === undefined || details === null) return false;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(details, (_key, v: unknown) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return v;
      if (v instanceof Map) return [...v];
      if (v instanceof Set) return [...v];
      const proto = Object.getPrototypeOf(v);
      return proto === Object.prototype || proto === null ? v : { $string: String(v), ...v };
    });
  } catch {
    return true;
  }
  return serialized !== undefined && redact(serialized) !== serialized;
}

/** Appended to a result whose `details` were dropped because a secret form survived redaction in them. */
export const DETAILS_WITHHELD_NOTICE = "[LUCID withheld this tool result's details: they could have shown a secret.]";

/** Redact one tool_result event: `undefined` when nothing matched (omp keeps the result), otherwise the
 *  changed `content` and/or `details`. When a secret form still shows in the serialized details (inside a
 *  class instance redactDeep does not walk, or a form only serialization reveals), the details are dropped
 *  (`null`) and the content says so. Exported for direct testing; the omp handler is a thin wrapper. */
export function redactToolResult(redact: (text: string) => string, event: unknown): RedactedResult | undefined {
  if (!event || typeof event !== "object") return undefined;
  const out: RedactedResult = {};
  const content = "content" in event ? event.content : undefined;
  if (Array.isArray(content)) {
    let changed = false;
    const next = content.map((part: ResultContent) => {
      if (part?.type !== "text" || typeof part.text !== "string") return part;
      const text = redact(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    if (changed) out.content = next;
  }
  const details = "details" in event ? event.details : undefined;
  const nextDetails = redactDeep(details, redact, new WeakSet());
  if (detailsHoldSecret(nextDetails, redact)) {
    out.details = null;
    const base: ResultContent[] = out.content ?? (Array.isArray(content) ? content : []);
    out.content = [...base, { type: "text", text: DETAILS_WITHHELD_NOTICE }];
    return out;
  }
  if (nextDetails !== details) out.details = nextDetails;
  return out.content || out.details !== undefined ? out : undefined;
}

/** What the model gets instead of a tool result the redactor could not process. Carries nothing from the
 *  original output (it may hold a secret). */
export const WITHHELD_NOTICE =
  "[LUCID withheld this tool result: vault redaction failed on it, so it could have shown a secret. Run the step again, or tell the user it failed.]";

/** The replacement for a result that could not be redacted: the notice as the only content, details
 *  dropped (`null`: omp keeps the original details when a handler returns `undefined` for them), and
 *  flagged as an error so the model does not build on it. */
export function withheldResult(): RedactedResult {
  return { content: [{ type: "text", text: WITHHELD_NOTICE }], details: null, isError: true };
}

/** Test seam: the redactor builder (default buildRedactor). omp passes only `pi`. */
export interface VaultRedactSeams { build?: typeof buildRedactor }

export default function vaultRedactExtension(pi: unknown, seams: VaultRedactSeams = {}): void {
  const api = (pi && typeof pi === "object" ? pi : {}) as OmpHookApi;
  if (typeof api.on !== "function") return;
  // Nothing named: not launched by the engine, or no vault value in this session's env. Nothing to protect.
  const names = process.env.LUCID_VAULT_REDACT_NAMES;
  if (!names) return;
  let handler: (event: unknown) => RedactedResult | undefined;
  try {
    const secrets: VaultSecret[] = [];
    for (const raw of names.split(",")) {
      const name = raw.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      const value = process.env[name];
      if (value && value.length >= MIN_REDACT_LENGTH) secrets.push({ name, value });
    }
    if (secrets.length === 0) return; // the named vars hold nothing worth redacting
    const redact = (seams.build ?? buildRedactor)(secrets);
    handler = (event) => {
      try {
        return redactToolResult(redact, event);
      } catch {
        // FAIL-CLOSED (invariant 3): a result we could not redact never reaches the model as it was.
        writeStderrNotice("\n[LucidAgentIDE] vault redaction failed on a tool result; it was withheld\n");
        return withheldResult();
      }
    };
  } catch {
    // FAIL-CLOSED: vault values are in this session's env but the redactor could not be built, so every
    // tool result is withheld rather than shown unredacted.
    writeStderrNotice("\n[LucidAgentIDE] vault redaction could not load; every tool result is withheld\n");
    handler = () => withheldResult();
  }
  try {
    api.on("tool_result", handler);
  } catch {
    writeStderrNotice("\n[LucidAgentIDE] vault redaction could not register its tool_result hook\n");
  }
}
