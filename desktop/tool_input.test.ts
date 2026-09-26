// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/tool_input.test.ts - P-PROGRESS.1: "the command used" reads as itself, code bodies never ride
// along, and the agent's intent is the one line it wrote.

import { describe, expect, test } from "bun:test";
import { toolInput, toolIntent, TOOL_INPUT_CAP } from "./tool_input.ts";

describe("toolInput", () => {
  test("a shell line reads as itself, a search carries its scope", () => {
    expect(toolInput({ rawInput: { command: " bun test ", i: "Running tests" } })).toBe("bun test");
    expect(toolInput({ rawInput: { pattern: "TODO", paths: ["src", "test"] } })).toBe("TODO\n  in: src, test");
    expect(toolInput({ rawInput: { pattern: "TODO", path: "src" } })).toBe("TODO\n  in: src");
  });

  test("code-bearing keys are stripped and an all-code call shows nothing", () => {
    expect(toolInput({ rawInput: { path: "a.ts", content: "x".repeat(100) } })).toBe(JSON.stringify({ path: "a.ts" }, null, 2));
    expect(toolInput({ rawInput: { content: "x", edits: [{ old_text: "a", new_text: "b" }] } })).toBeUndefined();
  });

  test("a string input is trimmed and capped; a bigint serializes; a cycle is silently not shown", () => {
    expect(toolInput({ input: "  x  " })).toBe("x");
    expect(toolInput({ rawInput: "y".repeat(TOOL_INPUT_CAP + 10) })!.length).toBe(TOOL_INPUT_CAP);
    expect(toolInput({ rawInput: { n: 10n } })).toContain('"n": "10"');
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    expect(toolInput({ rawInput: cyc })).toBeUndefined();
  });
});

describe("toolIntent", () => {
  test("is the agent's `i` phrase, trimmed and bounded, or nothing", () => {
    expect(toolIntent({ rawInput: { i: "  Reading model role settings " } })).toBe("Reading model role settings");
    expect(toolIntent({ rawInput: { i: "x".repeat(300) } })!.length).toBe(160);
    expect(toolIntent({ rawInput: { command: "ls" } })).toBeUndefined();
    expect(toolIntent({ rawInput: "ls" })).toBeUndefined();
  });
});
