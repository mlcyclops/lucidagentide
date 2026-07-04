// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/commands/spec.ts — P-CMD.1 (ADR-0146): the UserCommand, a user-authored "/" slash command.
// A user describes a shortcut in chat ("make a /pr command that reviews the current diff…"); the agent,
// steered by the frozen SLASH_COMMAND_POLICY, gathers requirements (asking refining questions when the ask
// is under-specified) and hands a drafted command to LUCID via the `slash_command_create` tool. This module
// is the single source of truth for that command: PURE (types + a fail-closed validator + tiny helpers, no
// I/O), cheap to import anywhere, and trivial to over-test.
//
// A UserCommand is a named PROMPT TEMPLATE with two invocation modes:
//   • "send"  — typing `/name [args]` expands `body` (with $ARGS / $1..$9 substitution) and sends it as the
//               user's turn. This is the plain "slash command".
//   • "skill" — typing `/name` activates `body` as a persistent per-session instruction (delivered as an
//               <active-skill> preamble, same path as a bundled skill). This is the "skill they can call".
//
// The command NAME is its stable id (invariant #9): a safe slash token AND a safe filename, so it never
// regenerates and can never traverse out of `.omp/commands/`. Fail-closed everywhere: `validateUserCommand`
// takes `unknown` and rejects anything malformed, reserved, or oversized; an invalid command is never
// persisted or registered.

export const COMMAND_SPEC_VERSION = 1 as const;

// Invocation modes — a closed set (mirrors the trust-label / node-kind closed-set convention).
export const COMMAND_MODES = ["send", "skill"] as const;
export type CommandMode = (typeof COMMAND_MODES)[number];

// Caps — body mirrors the active-skill prompt cap in dev.ts (`/api/skill` slices to 8000); description is a
// one-line autocomplete hint. Oversized text is a validation failure (fail-closed), never silently truncated.
export const MAX_BODY_LEN = 8000;
export const MAX_DESCRIPTION_LEN = 200;

// The slash token / filename charset: a lowercase letter then lowercase alnum + hyphen, ≤ 32 chars. This is a
// safe URL segment, a safe filename (no separators, no `..`), and a clean "/" autocomplete token.
export const COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

// Names that collide with LUCID's built-in "/" handling (the kickoff commands, the skill prefix, omp/goal
// primitives, and generic verbs the composer intercepts). A user command may not shadow these.
export const RESERVED_COMMAND_NAMES: readonly string[] = [
  "agent", "command", "commands", "skill", "skills", "goal", "loop", "task",
  "help", "new", "clear", "stop", "cancel", "reset", "undo", "redo",
];

export interface UserCommand {
  name: string; // the slash token WITHOUT the leading "/", e.g. "pr-review" — also the stable id + filename
  description: string; // one-line hint shown in the "/" autocomplete
  body: string; // the prompt template ("send") or persistent instruction ("skill"); may use $ARGS / $1..$9
  mode: CommandMode;
  spec_version: typeof COMMAND_SPEC_VERSION;
  created_at: number; // epoch ms
  updated_at: number; // epoch ms
}

export interface CommandValidation {
  ok: boolean;
  errors: string[];
  command?: UserCommand; // present only when ok — a normalized copy (defaults filled, name lowercased)
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => isStr(v) && v.trim().length > 0;

/** Best-effort coercion of a free-text label into a conforming command name. Returns "" when nothing usable
 *  survives (the caller then treats it as invalid). Used by the tool/handoff to normalize an agent-supplied
 *  name before validation, and by the UI when a user types a display label. */
export function sanitizeCommandName(raw: unknown): string {
  if (!isStr(raw)) return "";
  const s = raw
    .trim()
    .replace(/^\/+/, "") // a leading "/" the user/agent may include
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // collapse anything non-alnum to a single hyphen
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, 32);
  // The first char must be a letter (COMMAND_NAME_RE); drop leading digits/hyphens left after slicing.
  const t = s.replace(/^[^a-z]+/, "");
  return COMMAND_NAME_RE.test(t) ? t : "";
}

/** True if `name` is a legal, non-reserved command token. */
export function isValidCommandName(name: unknown): name is string {
  return isStr(name) && COMMAND_NAME_RE.test(name) && !RESERVED_COMMAND_NAMES.includes(name);
}

/** Fail-closed validation of an untrusted value as a UserCommand. Any structural problem, an illegal or
 *  reserved name, an unknown mode, an empty/oversized body, or an oversized description → { ok:false, errors }.
 *  Only a fully valid command returns { ok:true, command } (a normalized copy). */
export function validateUserCommand(input: unknown): CommandValidation {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null) {
    errors.push("command must be an object");
    return { ok: false, errors };
  }
  const c = input as Record<string, unknown>;

  const name = isStr(c.name) ? c.name.trim().replace(/^\/+/, "").toLowerCase() : "";
  if (!COMMAND_NAME_RE.test(name)) {
    errors.push("name must be a lowercase token: a letter then letters/digits/hyphens, 1–32 chars (no spaces, no leading '/')");
  } else if (RESERVED_COMMAND_NAMES.includes(name)) {
    errors.push(`name "${name}" is reserved by a built-in command — choose another`);
  }

  if (!isNonEmpty(c.body)) errors.push("body must be a non-empty string (the prompt the command runs)");
  else if ((c.body as string).length > MAX_BODY_LEN) errors.push(`body must be ≤ ${MAX_BODY_LEN} characters`);

  if (c.description !== undefined && !isStr(c.description)) errors.push("description must be a string when present");
  else if (isStr(c.description) && c.description.length > MAX_DESCRIPTION_LEN) errors.push(`description must be ≤ ${MAX_DESCRIPTION_LEN} characters`);

  const mode = c.mode ?? "send";
  if (!(COMMAND_MODES as readonly string[]).includes(mode as string)) errors.push(`mode must be one of: ${COMMAND_MODES.join(", ")}`);

  if (c.spec_version !== undefined && c.spec_version !== COMMAND_SPEC_VERSION) errors.push(`spec_version must be ${COMMAND_SPEC_VERSION}`);
  if (c.created_at !== undefined && typeof c.created_at !== "number") errors.push("created_at must be a number (epoch ms) when present");
  if (c.updated_at !== undefined && typeof c.updated_at !== "number") errors.push("updated_at must be a number (epoch ms) when present");

  if (errors.length) return { ok: false, errors };

  const now = Date.now();
  const command: UserCommand = {
    name,
    description: isStr(c.description) ? c.description.trim() : "",
    body: (c.body as string),
    mode: mode as CommandMode,
    spec_version: COMMAND_SPEC_VERSION,
    created_at: typeof c.created_at === "number" ? c.created_at : now,
    updated_at: typeof c.updated_at === "number" ? c.updated_at : now,
  };
  return { ok: true, errors: [], command };
}

// Placeholder substitution. `$ARGS` = the whole trailing argument string; `$1`..`$9` = positional args
// (whitespace-split). A `$$` is a literal "$". This is the well-known Claude-Code / GitHub slash-command
// convention, so authored templates behave the way users expect.
const HAS_PLACEHOLDER_RE = /\$(?:ARGS\b|[1-9])/;

/** Expand a command body with the user's trailing args.
 *  - Substitutes `$ARGS` with the full args string and `$1..$9` with positional (whitespace-split) args.
 *  - `$$` becomes a literal "$".
 *  - If the body uses NO placeholder and `args` is non-empty, the args are appended as a trailing paragraph
 *    (so `/foo extra text` still forwards the user's extra text to a placeholder-free template).
 *  Pure + deterministic. */
export function expandCommandBody(body: string, args: string): string {
  const trimmedArgs = (args ?? "").trim();
  const positional = trimmedArgs.length ? trimmedArgs.split(/\s+/) : [];
  const hasPlaceholder = HAS_PLACEHOLDER_RE.test(body);
  // Substitute in a single pass so a literal `$$` never re-enters substitution.
  const expanded = body.replace(/\$\$|\$ARGS\b|\$([1-9])/g, (m, pos) => {
    if (m === "$$") return "$";
    if (m === "$ARGS") return trimmedArgs;
    const i = Number(pos) - 1;
    return positional[i] ?? "";
  });
  if (!hasPlaceholder && trimmedArgs.length) return `${expanded.trimEnd()}\n\n${trimmedArgs}`;
  return expanded;
}
