// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/commands/commands.test.ts — P-CMD.1 (ADR-0146): user-authored "/" slash commands. Covers the
// fail-closed validator (name charset + reserved tokens + caps), the sanitize/expand helpers, the
// traversal-safe file store, and the secret-guarded handoff — the load-bearing pure layer under
// desktop/user_commands.ts (whose scanner leg mirrors the already-tested P-AGENT.5 import-gate seam).

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateUserCommand,
  sanitizeCommandName,
  isValidCommandName,
  expandCommandBody,
  RESERVED_COMMAND_NAMES,
  MAX_BODY_LEN,
  type UserCommand,
} from "./spec.ts";
import { saveCommandFile, loadCommandFile, listCommandFiles, deleteCommandFile } from "./file_store.ts";
import { parseDraftedCommand, slashCommandCreateDraft } from "./handoff.ts";

function cmd(over: Partial<UserCommand> = {}): UserCommand {
  return {
    name: "pr-review",
    description: "Review the current diff",
    body: "Review the current git diff. Focus: $ARGS",
    mode: "send",
    spec_version: 1,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over,
  };
}

describe("validateUserCommand (P-CMD.1) — fail-closed", () => {
  test("a well-formed command validates and normalizes", () => {
    const r = validateUserCommand(cmd());
    expect(r.ok).toBe(true);
    expect(r.command!.name).toBe("pr-review");
    expect(r.command!.mode).toBe("send");
  });
  test("illegal names, reserved tokens, and oversized bodies are refused with reasons", () => {
    expect(validateUserCommand(cmd({ name: "PR review" as never })).ok).toBe(false);
    expect(validateUserCommand(cmd({ name: "../evil" as never })).ok).toBe(false);
    for (const reserved of ["agent", "goal", "help"]) expect(validateUserCommand(cmd({ name: reserved })).ok).toBe(false);
    expect(validateUserCommand(cmd({ body: "" })).ok).toBe(false);
    expect(validateUserCommand(cmd({ body: "x".repeat(MAX_BODY_LEN + 1) })).ok).toBe(false);
    expect(validateUserCommand(cmd({ mode: "daemon" as never })).ok).toBe(false);
    expect(validateUserCommand("nope").ok).toBe(false);
  });
  test("sanitizeCommandName coerces free text; isValidCommandName honors the reserved list", () => {
    expect(sanitizeCommandName("/PR Review!")).toBe("pr-review");
    expect(sanitizeCommandName("  9 lives  ")).toBe("lives");
    expect(sanitizeCommandName("///")).toBe("");
    expect(isValidCommandName("standup")).toBe(true);
    for (const r of RESERVED_COMMAND_NAMES) expect(isValidCommandName(r)).toBe(false);
  });
});

describe("expandCommandBody (P-CMD.1)", () => {
  test("$ARGS, positional $1..$9, and $$ follow the documented convention", () => {
    expect(expandCommandBody("Focus: $ARGS", "auth flows")).toBe("Focus: auth flows");
    expect(expandCommandBody("From $1 to $2 ($3)", "a b")).toBe("From a to b ()");
    expect(expandCommandBody("Costs $$5, topic $1", "x")).toBe("Costs $5, topic x");
  });
  test("a placeholder-free body still forwards typed args as a trailing paragraph", () => {
    expect(expandCommandBody("Summarize the day.", "include the failed builds")).toBe("Summarize the day.\n\ninclude the failed builds");
    expect(expandCommandBody("Summarize the day.", "")).toBe("Summarize the day.");
  });
});

describe("command file store (P-CMD.1) — traversal-safe, fail-closed both ways", () => {
  test("save → load → list → delete round-trip under .omp/commands/<name>.json", () => {
    const root = mkdtempSync(join(tmpdir(), "cmd-store-"));
    try {
      saveCommandFile(root, cmd());
      expect(loadCommandFile(root, "pr-review")).toEqual(cmd());
      expect(listCommandFiles(root).map((c) => c.name)).toEqual(["pr-review"]);
      expect(deleteCommandFile(root, "pr-review")).toBe(true);
      expect(loadCommandFile(root, "pr-review")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("invalid commands are never written; corrupted files are never returned; bad names never resolve", () => {
    const root = mkdtempSync(join(tmpdir(), "cmd-store-"));
    try {
      expect(() => saveCommandFile(root, cmd({ name: "agent" }))).toThrow(/invalid/);
      mkdirSync(join(root, ".omp", "commands"), { recursive: true });
      writeFileSync(join(root, ".omp", "commands", "broken.json"), "{nope");
      expect(loadCommandFile(root, "broken")).toBeNull();
      expect(listCommandFiles(root)).toEqual([]);
      expect(loadCommandFile(root, "../../etc/passwd")).toBeNull();
      expect(deleteCommandFile(root, "..")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("command handoff (P-CMD.1) — the agent can never register a malformed or leaky command", () => {
  test("a clean draft parses; bad JSON and invalid drafts are refused with steering messages", () => {
    const ok = parseDraftedCommand(JSON.stringify(cmd()));
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain("/pr-review");
    expect(parseDraftedCommand("not json").ok).toBe(false);
    expect(parseDraftedCommand(JSON.stringify(cmd({ name: "agent" }))).ok).toBe(false);
  });
  test("a credential VALUE in the body is rejected and pointed at the vault", () => {
    const leaky = parseDraftedCommand(JSON.stringify(cmd({ body: "call the API with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" })));
    expect(leaky.ok).toBe(false);
    expect(leaky.message).toContain("vault");
  });
  test("slashCommandCreateDraft keys on the unique commandJson arg and fail-closes on leaky drafts", () => {
    const draft = slashCommandCreateDraft("slash_command_create", { commandJson: JSON.stringify(cmd()) });
    expect(draft?.name).toBe("pr-review");
    expect(slashCommandCreateDraft("some_other_tool", { other: 1 })).toBeNull();
    expect(slashCommandCreateDraft("slash_command_create", { commandJson: JSON.stringify(cmd({ name: "agent" })) })).toBeNull();
    expect(slashCommandCreateDraft(undefined, { commandJson: "not json" })).toBeNull();
  });
});
