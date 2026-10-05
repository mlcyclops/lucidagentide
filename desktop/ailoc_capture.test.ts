// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiLocCaptureTracker } from "./ailoc_capture.ts";
import { readAiLocSamples } from "./ailoc_read.ts";
import { buildToolCallStartUpdate } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-event-mapper";
import { toolCode } from "./tool_code.ts";
import { toolChip } from "./renderer/answer_chips.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(cap?: number) {
  const repo = mkdtempSync(join(tmpdir(), "ailoc-capture-"));
  dirs.push(repo);
  const logPath = join(repo, "ledger.jsonl");
  const tracker = new AiLocCaptureTracker({ logPath, cap });
  const context = { model: "model-start", identity: "owner-start", identitySource: "email", repo };
  const start = (id: string, rawInput: unknown, session = "s", extra: Record<string, unknown> = {}) => tracker.observe(session,
    { sessionUpdate: "tool_call", toolCallId: id, kind: "edit", rawInput, status: "pending", ...extra }, context);
  const update = (id: string, status: string, rawOutput?: unknown, session = "s", extra: Record<string, unknown> = {}) => tracker.observe(session,
    { sessionUpdate: "tool_call_update", toolCallId: id, status, rawOutput, ...extra }, context);
  const rows = () => readAiLocSamples(logPath).map(({ filePath, tool, added, removed, sessionId }) => ({ filePath, tool, added, removed, sessionId }));
  return { tracker, context, start, update, rows, logPath, repo };
}
const replacement = { path: "src/a.ts", old_string: "anchor\n", new_string: "anchor\none\ntwo\nthree\nfour\n" };
const output = (diff: string, path?: string) => ({ details: { diff, ...(path ? { path } : {}) } });

describe("completed successful mutation ledger", () => {
  test("patch-mode creates show authored additions rather than context-only zero counts", () => {
    const create = toolCode({ kind: "edit", rawInput: { path: "new.ts", edits: [{ op: "create", diff: "first\nsecond\nthird\n" }] } }, path => path);
    expect(toolChip("edit", "new.ts", create).diffstat).toEqual({ add: 3, del: 0 });
    const mixed = toolCode({ kind: "edit", rawInput: { path: "new.ts", edits: [
      { op: "create", diff: "first\nsecond\n" }, { op: "update", diff: "-first\n+changed" },
    ] } }, path => path);
    expect(toolChip("edit", "new.ts", mixed).diffstat).toEqual({ add: 3, del: 1 });
  });
  test("apply_patch retains counts and preview when the real ACP mapper calls it other", () => {
    const f = setup();
    const input = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch";
    const call = buildToolCallStartUpdate({ toolCallId: "patch-wire", toolName: "apply_patch", args: { input }, intent: "Updating a file" });
    expect(toolCode(call, path => path)?.patch).toBe(input);
    f.tracker.observe("s", call, f.context);
    f.update("patch-wire", "completed", output("-1|old\n+1|new", "a.ts"));
    expect(f.rows()).toEqual([{ filePath: join(f.repo, "a.ts"), tool: "edit", added: 1, removed: 1, sessionId: "s" }]);
  });
  test("canonical insertion records +4 only after completion", () => {
    const f = setup();
    expect(f.start("a", replacement)).toEqual([]);
    expect(f.update("a", "in_progress", output("+1|one\n+2|two\n+3|three\n+4|four"))).toEqual([]);
    expect(f.rows()).toEqual([]);
    f.update("a", "completed", output(" 1|anchor\n+2|one\n+3|two\n+4|three\n+5|four"));
    expect(f.rows()).toEqual([{ filePath: join(f.repo, "src", "a.ts"), tool: "edit", added: 4, removed: 0, sessionId: "s" }]);
  });
  test("replace_all counts every applied occurrence, not the input pair", () => {
    const f = setup();
    f.start("a", { path: "a.ts", old_string: "before", new_string: "after", replace_all: true });
    f.update("a", "completed", output("-1|before\n+1|after\n 2|context\n-3|before\n+3|after\n-4|before\n+4|after"));
    expect(f.rows()).toEqual([{ filePath: join(f.repo, "a.ts"), tool: "edit", added: 3, removed: 3, sessionId: "s" }]);
  });
  test("deletion counts removals; no-op and missing result diffs append nothing", () => {
    const f = setup();
    f.start("delete", { path: "a.ts", old_string: "a\nb\n", new_string: "" });
    f.update("delete", "completed", output("-1|a\n-2|b"));
    f.start("noop", { path: "a.ts", old_string: "a", new_string: "a" });
    f.update("noop", "completed", output(" 1|a"));
    f.start("no-result", replacement);
    f.update("no-result", "completed");
    expect(f.rows()).toEqual([{ filePath: join(f.repo, "a.ts"), tool: "edit", added: 0, removed: 2, sessionId: "s" }]);
  });
  test("blocked writes and failed, rejected, or cancelled calls cannot record or resurrect", () => {
    const f = setup();
    for (const status of ["failed", "rejected", "cancelled", "canceled"]) {
      f.start(status, { path: "a.ts", content: "written\n" });
      expect(f.update(status, status)).toEqual([]);
      expect(f.update(status, "completed", output("+1|written"))).toEqual([]);
    }
    f.start("blocked", { path: "a.ts", content: "written\n" });
    expect(f.update("blocked", "completed", { isError: true, details: { diff: "+1|written" } })).toEqual([]);
    expect(f.rows()).toEqual([]);
  });
  test("large write and applied edit counts are independent of preview limits", () => {
    const f = setup();
    f.start("write", { path: "large.ts", content: "line\n".repeat(20000) });
    f.update("write", "completed");
    f.start("edit", { path: "large.ts", old_string: "anchor", new_string: "small preview" });
    f.update("edit", "completed", output("+1|line\n".repeat(20000)));
    expect(f.rows().map(({ tool, added, removed }) => ({ tool, added, removed }))).toEqual([
      { tool: "write", added: 20000, removed: 0 }, { tool: "edit", added: 20000, removed: 0 },
    ]);
  });
  test("session and call IDs isolate mutations and duplicate completions append once", () => {
    const f = setup();
    f.start("same", { path: "first.ts", content: "a\nb\n" }, "first");
    f.start("same", { path: "second.ts", content: "c\n" }, "second");
    expect(f.update("missing", "completed", output("+1|ignored"), "first")).toEqual([]);
    f.update("same", "completed", undefined, "second");
    f.update("same", "completed", undefined, "first");
    f.update("same", "completed", undefined, "first");
    f.start("same", { path: "first.ts", content: "duplicate" }, "first", { status: "completed" });
    expect(f.rows()).toEqual([
      { filePath: join(f.repo, "second.ts"), tool: "write", added: 1, removed: 0, sessionId: "second" },
      { filePath: join(f.repo, "first.ts"), tool: "write", added: 2, removed: 0, sessionId: "first" },
    ]);
  });
  test("clear and pending eviction discard orphan updates even when they supply input", () => {
    const f = setup(1);
    f.start("evicted", replacement);
    f.start("cleared", replacement);
    f.tracker.clear();
    for (const id of ["evicted", "cleared"]) {
      expect(f.update(id, "completed", output("+1|ignored"), "s", { kind: "edit", rawInput: replacement })).toEqual([]);
    }
    expect(f.rows()).toEqual([]);
  });
  test("attribution and relative paths stay pinned to the start, including late input", () => {
    const f = setup();
    f.start("late", undefined);
    const next = { model: "model-next", identity: "owner-next", identitySource: "settings", repo: join(f.repo, "other") };
    f.tracker.observe("s", { sessionUpdate: "tool_call_update", toolCallId: "late", status: "completed", rawInput: replacement, rawOutput: output("+1|one") }, next);
    expect(readAiLocSamples(f.logPath).map(({ model, identity, identitySource, repo, filePath }) => ({ model, identity, identitySource, repo, filePath }))).toEqual([
      { ...f.context, filePath: join(f.repo, "src", "a.ts") },
    ]);
  });
  test("per-file diffs keep exact paths and individual counts, skipping errors and unnamed files", () => {
    const f = setup();
    f.start("patch", { input: "*** Begin Patch\n*** Update File: a.ts\n+x\n*** End Patch" });
    f.update("patch", "completed", { details: { diff: "+combined\n+must-not-double-count", perFileResults: [
      { path: "nested/a.ts", diff: "+1|x\n+2|y\n-1|old" },
      { path: join(f.repo, "b.ts"), diff: "-1|removed" },
      { path: "blocked.ts", diff: "+1|blocked", isError: true },
      { diff: "+1|unnamed" },
    ] } });
    expect(f.rows()).toEqual([
      { filePath: join(f.repo, "nested", "a.ts"), tool: "edit", added: 2, removed: 1, sessionId: "s" },
      { filePath: join(f.repo, "b.ts"), tool: "edit", added: 0, removed: 1, sessionId: "s" },
    ]);
  });
  test("initial completed mutations record, but read content and unidentified results do not", () => {
    const f = setup();
    f.start("initial", replacement, "s", { status: "completed", rawOutput: output("+1|one") });
    f.start("patch-array", { path: "a.ts", edits: [{ op: "update", diff: "@@\n+new" }] }, "s", { status: "completed", rawOutput: output("+1|new") });
    f.start("read", { path: "read.ts", content: "not authored" }, "s", { kind: "read", status: "completed" });
    f.start("unknown", { path: "unknown.ts" }, "s", { status: "completed", rawOutput: output("+1|unknown") });
    expect(f.rows()).toEqual([
      { filePath: join(f.repo, "src", "a.ts"), tool: "edit", added: 1, removed: 0, sessionId: "s" },
      { filePath: join(f.repo, "a.ts"), tool: "edit", added: 1, removed: 0, sessionId: "s" },
    ]);
  });
});
