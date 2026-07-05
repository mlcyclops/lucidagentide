// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/user_commands.ts — P-CMD.1 (ADR-0146): create + persist user-authored "/" slash commands, gated.
//
// A drafted command (from the `slash_command_create` tool, via acp_backend, or the renderer) is the
// AUTHORITATIVE create path here: it is (1) VALIDATED fail-closed, (2) SECRET-scanned (a command body may
// never embed a credential VALUE — same detector list as the Agent Builder guardrail), and (3) run through
// the Python Unicode scanner fail-closed (same seam as the project-skill import, so a hidden-Unicode
// injection can never ride into a saved command). Only a clean command is written to
// `<workspace>/.omp/commands/<name>.json` and enabled. Metadata-only telemetry marks create/reject.

import { ScannerClient } from "../harness/security/scanner_client.ts";
import { DEFAULT_POLICY, scanAndDecide, type GateDecision } from "../harness/security/gate.ts";
import { validateUserCommand, type UserCommand } from "../harness/commands/spec.ts";
import { scanTextsForSecrets } from "../harness/agent/secret_guard.ts";
import { deleteCommandFile, listCommandFiles, saveCommandFile } from "../harness/commands/file_store.ts";
import { withBuiltins } from "../harness/commands/builtins.ts"; // P-CMD.2: shipped "/" commands (/licensing)
import { Telemetry } from "../harness/telemetry/events.ts";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { currentWorkspace } from "./workspace.ts";
import { recordBlock } from "./security_log.ts";
import { EVENTS_LOG_PATH } from "./skills_log.ts";

let scanner: ScannerClient | null = null;
function getScanner(): ScannerClient {
  if (!scanner) {
    scanner = new ScannerClient();
    scanner.start();
  }
  return scanner;
}
/** Stop the command scanner sidecar (used by the demo/tests for clean teardown). */
export function stopCommandScanner(): void {
  try {
    scanner?.stop();
  } catch {
    /* ignore */
  }
  scanner = null;
}

export interface CommandCreateResult {
  ok: boolean; // true ⇒ persisted + enabled
  name?: string;
  command?: UserCommand; // present only when ok (the normalized, saved command)
  errors?: string[]; // validation errors (fail-closed) when the draft is malformed
  blocked?: boolean; // scanned but flagged (secret / injection / scanner-unavailable) → not saved
  reason?: string;
  trustLabel?: string;
  findings?: number;
}

// Metadata-only telemetry (name/mode/reason) — NEVER the command body. Best-effort: a write failure never
// affects command creation. Same append-only NDJSON sink the skill-activation telemetry uses.
function emitCommandEvent(event: "command_created" | "command_rejected", fields: Record<string, unknown>): void {
  try {
    new Telemetry({ runId: Snowflake.next(), sessionId: "gui", sink: EVENTS_LOG_PATH }).emit(event, fields);
  } catch {
    /* telemetry is best-effort */
  }
}

/**
 * Validate → secret-scan → Unicode-scan (all fail-closed) → persist a drafted user command. Returns a result
 * the API/renderer surfaces. NEVER writes an invalid, secret-carrying, or unscanned command.
 */
export async function createUserCommand(draft: unknown, workspace: string = currentWorkspace()): Promise<CommandCreateResult> {
  const v = validateUserCommand(draft);
  if (!v.ok) {
    emitCommandEvent("command_rejected", { name: "", reason: "invalid" });
    return { ok: false, errors: v.errors, reason: v.errors[0] };
  }
  const cmd = v.command!;

  // Guardrail: a command body must never embed a secret VALUE (same detectors as the Agent Builder).
  const leaks = scanTextsForSecrets([
    { where: "name", text: cmd.name },
    { where: "description", text: cmd.description },
    { where: "body", text: cmd.body },
  ]);
  if (leaks.length) {
    const where = leaks.map((l) => l.where).join(", ");
    recordBlock({ tool: "slash_command_create", severity: "high", findings: String(leaks.length), reason: `/${cmd.name} blocked — embeds a secret in ${where}` });
    emitCommandEvent("command_rejected", { name: cmd.name, reason: "embedded-secret" });
    return { ok: false, name: cmd.name, blocked: true, reason: `embeds a secret in ${where} — keep credentials in the vault, not a command body` };
  }

  // Fail-closed Unicode scan of the command's free text (scanner dead/malformed/timeout ⇒ blocked).
  let decision: GateDecision;
  try {
    decision = await scanAndDecide(getScanner(), `${cmd.name}\n${cmd.description}\n${cmd.body}`, DEFAULT_POLICY);
  } catch (e) {
    recordBlock({ tool: "slash_command_create", severity: "high", findings: "scanner-unavailable", reason: `/${cmd.name} blocked — scanner unavailable` });
    emitCommandEvent("command_rejected", { name: cmd.name, reason: "scanner-unavailable" });
    return { ok: false, name: cmd.name, blocked: true, reason: `scanner unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (decision.block) {
    recordBlock({ tool: "slash_command_create", severity: decision.trustLabel === "quarantined" ? "high" : "medium", findings: String(decision.findings.length), reason: `/${cmd.name} blocked — ${decision.reason}` });
    emitCommandEvent("command_rejected", { name: cmd.name, reason: decision.reason });
    return { ok: false, name: cmd.name, blocked: true, reason: decision.reason, trustLabel: decision.trustLabel, findings: decision.findings.length };
  }

  try {
    saveCommandFile(workspace, cmd);
  } catch (e) {
    return { ok: false, name: cmd.name, reason: `write failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  emitCommandEvent("command_created", { name: cmd.name, mode: cmd.mode });
  return { ok: true, name: cmd.name, command: cmd, trustLabel: decision.trustLabel, findings: decision.findings.length };
}

/** List valid stored user commands (newest first) plus LUCID's builtins (P-CMD.2). A user-saved command
 *  with a builtin's name SHADOWS it; deleting that user command resurfaces the builtin. */
export function listUserCommands(workspace: string = currentWorkspace()): UserCommand[] {
  return withBuiltins(listCommandFiles(workspace));
}

/** Delete a user command by name. Returns true if a file was removed. */
export function deleteUserCommand(name: string, workspace: string = currentWorkspace()): boolean {
  return deleteCommandFile(workspace, name);
}
