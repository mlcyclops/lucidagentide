// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/commands/file_store.ts — P-CMD.1 (ADR-0146): workspace-local UserCommand persistence as JSON files
// under `<root>/.omp/commands/<name>.json`. Mirrors harness/agent/file_store.ts: authored commands live with
// the workspace (editable, versionable, portable) rather than in the read-only-from-desktop DuckDB.
//
// Fail-closed both ways: `saveCommandFile` REFUSES an invalid command (never writes it); the readers
// re-validate and skip/return-null on a corrupted file. The command NAME is its filename and is charset-
// guarded (COMMAND_NAME_RE ⇒ no separators, no `..`) so a write can never escape `.omp/commands/`.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_NAME_RE, validateUserCommand, type UserCommand } from "./spec.ts";

const commandsDir = (root: string): string => join(root, ".omp", "commands");
const commandFile = (root: string, name: string): string => join(commandsDir(root), `${name}.json`);

/** Only the safe slash-token charset is allowed as a filename — never a path separator / traversal. */
function safeName(name: unknown): string | null {
  return typeof name === "string" && COMMAND_NAME_RE.test(name) ? name : null;
}

/** Validate then write a command to `<root>/.omp/commands/<name>.json`. Throws (fail-closed) if invalid. */
export function saveCommandFile(root: string, command: UserCommand): void {
  const v = validateUserCommand(command);
  if (!v.ok) throw new Error(`refusing to save invalid command: ${v.errors.join("; ")}`);
  const name = safeName(v.command!.name);
  if (!name) throw new Error(`invalid command name: ${String(command.name)}`);
  mkdirSync(commandsDir(root), { recursive: true });
  writeFileSync(commandFile(root, name), JSON.stringify(v.command, null, 2));
}

/** Load + re-validate a command by name. Returns null if absent, unreadable, or invalid (a corrupted file is
 *  never returned as a valid command). Reads directly in try/catch — no existsSync-then-read (CodeQL TOCTOU). */
export function loadCommandFile(root: string, name: string): UserCommand | null {
  const nm = safeName(name);
  if (!nm) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(commandFile(root, nm), "utf8"));
  } catch {
    return null;
  }
  const v = validateUserCommand(parsed);
  return v.ok ? v.command! : null;
}

/** List valid stored commands, newest first. Corrupted files are skipped, not fatal. */
export function listCommandFiles(root: string): UserCommand[] {
  let files: string[];
  try {
    files = readdirSync(commandsDir(root)).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no commands dir yet
  }
  const out: UserCommand[] = [];
  for (const f of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(commandsDir(root), f), "utf8"));
    } catch {
      continue;
    }
    const v = validateUserCommand(parsed);
    if (v.ok && v.command) out.push(v.command);
  }
  return out.sort((a, b) => b.updated_at - a.updated_at);
}

/** Delete a command file by name. Returns true if a file was removed. */
export function deleteCommandFile(root: string, name: string): boolean {
  const nm = safeName(name);
  if (!nm) return false;
  try {
    rmSync(commandFile(root, nm));
    return true;
  } catch {
    return false;
  }
}
