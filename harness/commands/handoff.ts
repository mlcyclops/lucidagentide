// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/commands/handoff.ts — P-CMD.1 (ADR-0146): the chat -> user-command handoff. Pure + fail-closed,
// shared by the `slash_command_create` omp tool (agent feedback) and acp_backend (the authoritative gate
// before a command is registered). A drafted command is only accepted if it PARSES, VALIDATES, and is
// SECRET-FREE (secret_guard) — so the agent can never register a malformed command or one that embeds a
// credential VALUE in its body. Mirrors harness/agent/handoff.ts (the Agent Builder handoff).

import { validateUserCommand, type UserCommand } from "./spec.ts";
import { scanTextsForSecrets } from "../agent/secret_guard.ts";

export interface CommandHandoffResult {
  ok: boolean;
  message: string; // human-readable status (also the agent-facing tool feedback)
  command?: UserCommand; // present only when ok (a normalized copy)
}

/** Parse + validate + secret-scan a drafted command (JSON string). Fail-closed: a bad/leaky draft is rejected
 *  with a message that steers the agent to fix it (a secret value belongs in the vault, never a command body). */
export function parseDraftedCommand(commandJson: string): CommandHandoffResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(commandJson);
  } catch {
    return { ok: false, message: "the drafted command must be valid JSON" };
  }
  const v = validateUserCommand(parsed);
  if (!v.ok) return { ok: false, message: `invalid command: ${v.errors.join("; ")}` };
  const cmd = v.command!;
  const leaks = scanTextsForSecrets([
    { where: "name", text: cmd.name },
    { where: "description", text: cmd.description },
    { where: "body", text: cmd.body },
  ]);
  if (leaks.length) {
    return {
      ok: false,
      message: `the command embeds a secret in ${leaks.map((l) => l.where).join(", ")} — never put a credential VALUE in a command; keep it in the LUCID vault and reference it by name`,
    };
  }
  return { ok: true, message: `ready: /${cmd.name} (${cmd.mode})`, command: cmd };
}

/** Detect a `slash_command_create` tool call and return the drafted command, or null. `commandJson` is UNIQUE
 *  to this tool, so its presence (with a valid parse) is a reliable trigger regardless of how omp renders the
 *  call title (name vs label). Fail-closed: an invalid/leaky draft returns null. Narrows the raw tool input
 *  with `in`/`typeof` — never an inline cast (the field could be anything). */
export function slashCommandCreateDraft(toolName: string | null | undefined, rawInput: unknown): UserCommand | null {
  let commandJson = "";
  if (rawInput && typeof rawInput === "object" && "commandJson" in rawInput) {
    const v = rawInput.commandJson; // unknown after `in` narrowing — validate before use
    if (typeof v === "string") commandJson = v;
  }
  // Accept when the call carries commandJson OR the title names our tool (belt-and-braces); both then re-validate.
  if (!commandJson && !/\bslash_command_create\b/i.test(toolName ?? "")) return null;
  if (!commandJson) return null;
  const r = parseDraftedCommand(commandJson);
  return r.ok ? r.command! : null;
}
