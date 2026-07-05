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
  expandInlineCommands,
  slashTokenBeforeCaret,
  RESERVED_COMMAND_NAMES,
  MAX_BODY_LEN,
  type UserCommand,
} from "./spec.ts";
import { BUILTIN_COMMANDS, withBuiltins } from "./builtins.ts";
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

describe("builtin commands (P-CMD.2) — shipped like user commands, shadowable", () => {
  test("every builtin passes the SAME validator as user-authored commands", () => {
    expect(BUILTIN_COMMANDS.length).toBeGreaterThan(0);
    for (const b of BUILTIN_COMMANDS) {
      const r = validateUserCommand(b);
      expect(r.ok).toBe(true);
      expect(r.command!.name).toBe(b.name);
    }
  });
  test("/licensing is a guided, approval-gated send-mode walkthrough that never relicenses vendored code", () => {
    const lic = BUILTIN_COMMANDS.find((b) => b.name === "licensing")!;
    expect(lic.mode).toBe("send");
    expect(lic.body).toContain("$ARGS"); // a seed like “/licensing Apache-2.0 for Acme” flows in
    expect(lic.body).toContain("NEVER write a file before I approve");
    expect(lic.body).toContain("SPDX");
    expect(lic.body).toContain("vendor/"); // exclusions are explicit, not implied
    expect(lic.body).toContain("shebang"); // insertion correctness
    expect(lic.body).toContain("read each file then write it"); // the AGENTS.md TOCTOU rule rides along
  });
  test("withBuiltins: user-saved commands shadow builtins by name; deletion resurfaces them", () => {
    const merged = withBuiltins([]);
    expect(merged.some((c) => c.name === "licensing")).toBe(true);
    const mine = cmd({ name: "licensing", body: "my own licensing flow" });
    const shadowed = withBuiltins([mine]);
    expect(shadowed.filter((c) => c.name === "licensing")).toHaveLength(1);
    expect(shadowed.find((c) => c.name === "licensing")!.body).toBe("my own licensing flow");
  });
});

describe("expandInlineCommands (P-CMD.2) — slash commands anywhere in the body", () => {
  const cmds: UserCommand[] = [
    cmd({ name: "pr-review", body: "Review the current git diff.", mode: "send" }),
    cmd({ name: "tone", body: "Answer tersely.", mode: "skill" }),
  ];
  test("a send-mode token mid-sentence expands IN PLACE with no args", () => {
    const r = expandInlineCommands("Please run /pr-review on the auth module.", cmds);
    expect(r.text).toBe("Please run Review the current git diff. on the auth module.");
    expect(r.skillNames).toEqual([]);
  });
  test("paths, URLs, and unknown names are NEVER mangled", () => {
    const untouched = "open src/pr-review.ts and /usr/bin/env plus https://x.dev/pr-review?a=1 and /unknown-cmd";
    const r = expandInlineCommands(untouched, cmds);
    expect(r.text).toBe(untouched);
    // a known name followed by a slash is a PATH, not a command
    expect(expandInlineCommands("see /pr-review/notes.md", cmds).text).toBe("see /pr-review/notes.md");
  });
  test("skill-mode tokens are stripped, reported once, and the remaining prose survives", () => {
    const r = expandInlineCommands("/tone summarize the incident /tone", cmds);
    expect(r.skillNames).toEqual(["tone"]);
    expect(r.text).toBe("summarize the incident");
  });
  test("multiple send-mode tokens all expand; expansion is single-pass (never recursive)", () => {
    const selfRef = [cmd({ name: "loop", body: "see /loop for details", mode: "send" })];
    const r = expandInlineCommands("do /loop now", selfRef);
    expect(r.text).toBe("do see /loop for details now"); // the body's own /loop is NOT re-expanded
    const multi = expandInlineCommands("/pr-review then also /pr-review", cmds);
    expect(multi.text).toBe("Review the current git diff. then also Review the current git diff.");
  });
  test("sentence punctuation ends a token; case-insensitive match", () => {
    expect(expandInlineCommands("(run /pr-review)", cmds).text).toBe("(run Review the current git diff.)");
    expect(expandInlineCommands("run /PR-Review.", cmds).text).toBe("run Review the current git diff..");
  });
});

describe("slashTokenBeforeCaret (P-CMD.2) — autocomplete anywhere", () => {
  test("finds the token at the caret mid-body; whitespace or start required before the slash", () => {
    expect(slashTokenBeforeCaret("/lic")).toBe("/lic");
    expect(slashTokenBeforeCaret("fix this /lic")).toBe("/lic");
    expect(slashTokenBeforeCaret("fix this /")).toBe("/");
    expect(slashTokenBeforeCaret("src/lic")).toBeNull(); // a path, not a token
    expect(slashTokenBeforeCaret("fix this /lic done ")).toBeNull(); // caret past the token
    expect(slashTokenBeforeCaret("")).toBeNull();
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
