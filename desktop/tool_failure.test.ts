// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/tool_failure.test.ts — P-TOOLFAIL.1 (ADR-0093): the failed/rejected tool_call_update
// → honest chip reason. Over-tested because this is the exact mislabel that made a benign tool
// failure read as a security denial.

import { describe, expect, test } from "bun:test";
import { toolFailureCommand, toolFailureDetail, toolFailureMessage, toolFailureReason } from "./tool_failure.ts";

describe("toolFailureReason — failed vs did-not-run", () => {
  test('"failed" status reports the tool RAN and errored', () => {
    const f = toolFailureReason({ status: "failed" });
    expect(f.didRun).toBe(true);
    expect(f.reason).toBe("tool failed");
  });

  test('"rejected" status reports the tool DID NOT run (no "rejected"/"denied" wording)', () => {
    const f = toolFailureReason({ status: "rejected" });
    expect(f.didRun).toBe(false);
    expect(f.reason).toBe("tool did not run");
    // The whole point: never imply a security/permission denial for a tool that just wasn't available.
    expect(f.reason).not.toContain("rejected");
    expect(f.reason).not.toContain("denied");
  });

  test("an unknown/absent status is treated as did-not-run (fail-safe wording)", () => {
    expect(toolFailureReason({}).didRun).toBe(false);
    expect(toolFailureReason({ status: "whatever" }).reason).toBe("tool did not run");
  });
});

describe("toolFailureMessage — surfaces omp's own message across shapes", () => {
  test("content[] with direct text", () => {
    expect(toolFailureMessage({ content: [{ type: "text", text: "no such tool: browser_open" }] }))
      .toBe("no such tool: browser_open");
  });

  test("content[] with nested content.text (ACP ToolCallContent)", () => {
    expect(toolFailureMessage({ content: [{ type: "content", content: { type: "text", text: "ENOENT: missing file" } }] }))
      .toBe("ENOENT: missing file");
  });

  test("rawOutput string and rawOutput.error", () => {
    expect(toolFailureMessage({ rawOutput: "boom" })).toBe("boom");
    expect(toolFailureMessage({ rawOutput: { error: "exit code 1" } })).toBe("exit code 1");
  });

  test("top-level message/error fields", () => {
    expect(toolFailureMessage({ message: "tool not enabled" })).toBe("tool not enabled");
    expect(toolFailureMessage({ error: "unsupported" })).toBe("unsupported");
  });

  test("whitespace is collapsed and the message is length-capped at 160", () => {
    const long = "x".repeat(500);
    expect(toolFailureMessage({ message: "a\n\n  b\t c" })).toBe("a b c");
    expect(toolFailureMessage({ message: long }).length).toBe(160);
  });

  test("nothing to show → empty string (caller falls back to the bare label)", () => {
    expect(toolFailureMessage({ status: "rejected" })).toBe("");
  });
});

describe("toolFailureCommand — the command the failed call attempted (P-TOOLFAIL.2)", () => {
  test("rawInput.command wins over the title", () => {
    expect(toolFailureCommand({ rawInput: { command: "make demo" }, title: "$ something-else" })).toBe("make demo");
  });

  test("falls back through the exec key set (cmd/script/code/source/input)", () => {
    expect(toolFailureCommand({ rawInput: { script: "pip install requests" } })).toBe("pip install requests");
    expect(toolFailureCommand({ input: { code: "1 + 1" } })).toBe("1 + 1");
  });

  test('omp\'s "$ cmd" title is used bare (the renderer adds its own $ marker)', () => {
    expect(toolFailureCommand({ title: "$ grep -n x Makefile" })).toBe("grep -n x Makefile");
  });

  test("a non-exec title or nothing command-like → empty string", () => {
    expect(toolFailureCommand({ title: "Opening game in browser" })).toBe("");
    expect(toolFailureCommand({})).toBe("");
    expect(toolFailureCommand(null)).toBe("");
  });

  test("length-capped at 400", () => {
    expect(toolFailureCommand({ rawInput: { command: "x".repeat(900) } }).length).toBe(400);
  });
});

describe("toolFailureDetail — full error text for the expanded row (P-TOOLFAIL.2)", () => {
  test("preserves line structure (CRLF normalized, trailing space trimmed)", () => {
    expect(toolFailureDetail({ rawOutput: "error: not found\r\nexit code 127  " }))
      .toBe("error: not found\nexit code 127");
  });

  test("joins multiple sources on newlines instead of flattening", () => {
    expect(toolFailureDetail({ content: [{ type: "text", text: "line one" }], message: "line two" }))
      .toBe("line one\nline two");
  });

  test("caps at 2000 and returns empty when nothing was attached", () => {
    expect(toolFailureDetail({ message: "y".repeat(5000) }).length).toBe(2000);
    expect(toolFailureDetail({ status: "rejected" })).toBe("");
  });
});

describe("toolFailureReason — message folded into the chip text", () => {
  test("a failed tool with a message", () => {
    expect(toolFailureReason({ status: "failed", content: [{ type: "text", text: "syntax error at line 3" }] }).reason)
      .toBe("tool failed: syntax error at line 3");
  });

  test("a did-not-run tool with an omp message (e.g. unavailable)", () => {
    expect(toolFailureReason({ status: "rejected", message: "no such tool" }).reason)
      .toBe("tool did not run: no such tool");
  });
});
