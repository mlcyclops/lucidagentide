// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/loc_count.test.ts
//
// P-LOC.1 (ADR-0031): the AI-LOC counter is only as honest as this pure module, so it is
// over-tested — every omp edit mode's RESULT shape, both diff formats, and the degrade-safe
// paths. countEdit reads omp's post-apply tool_result (numbered unified diff for `edit`,
// written content for `write`), so the same tests cover hashline/replace/patch/apply_patch.

import { describe, expect, it } from "bun:test";
import { countContentLines, countDiffLines, countEdit, type EditResultLike } from "./loc_count.ts";

describe("countContentLines", () => {
  it("counts lines, trailing newline terminates rather than adds", () => {
    expect(countContentLines("a\nb\n")).toBe(2);
    expect(countContentLines("a\nb")).toBe(2);
  });
  it("single line, no newline", () => expect(countContentLines("hello")).toBe(1));
  it("empty string is zero lines", () => expect(countContentLines("")).toBe(0));
  it("a lone newline is one (empty) line", () => expect(countContentLines("\n")).toBe(1));
  it("blank lines in the middle count", () => expect(countContentLines("a\n\nb\n")).toBe(3));
});

describe("countDiffLines — omp numbered format (+N|, -N|)", () => {
  it("counts numbered +/- rows, ignores context and gap rows", () => {
    const diff = [" 40|unchanged", "+41|new line one", "+42|new line two", "-43|gone", " 44|unchanged"].join("\n");
    expect(countDiffLines(diff)).toEqual({ added: 2, removed: 1 });
  });
  it("hunk headers and elision rows don't count", () => {
    const diff = ["@@ -1,2 +1,3 @@", " 1|a", "+2|b", "⋮", " 3|c"].join("\n");
    expect(countDiffLines(diff)).toEqual({ added: 1, removed: 0 });
  });
});

describe("countDiffLines — plain unified diff", () => {
  it("counts +/- body lines, excludes +++/--- file headers", () => {
    const diff = ["--- a/f.ts", "+++ b/f.ts", "@@ -1,1 +1,2 @@", "-old", "+new1", "+new2"].join("\n");
    expect(countDiffLines(diff)).toEqual({ added: 2, removed: 1 });
  });
  it("empty diff is zero/zero", () => expect(countDiffLines("")).toEqual({ added: 0, removed: 0 }));
});

describe("countEdit — write tool", () => {
  it("counts written content as added, removed 0, captures path", () => {
    const ev: EditResultLike = { toolName: "write", input: { path: "src/a.ts", content: "l1\nl2\nl3\n" } };
    expect(countEdit(ev)).toEqual({ countable: true, tool: "write", added: 3, removed: 0, files: ["src/a.ts"] });
  });
  it("empty write is not countable", () => {
    expect(countEdit({ toolName: "write", input: { path: "x", content: "" } }).countable).toBe(false);
  });
});

describe("countEdit — edit tool (single-file details.diff)", () => {
  it("counts from omp's numbered diff, prefers details.path", () => {
    const ev: EditResultLike = {
      toolName: "edit",
      input: { path: "ignored.ts" },
      details: { path: "real.ts", diff: ["+10|added", "-11|removed", " 12|ctx"].join("\n") },
    };
    expect(countEdit(ev)).toEqual({ countable: true, tool: "edit", added: 1, removed: 1, files: ["real.ts"] });
  });
  it("falls back to input.path when details has no path", () => {
    const ev: EditResultLike = { toolName: "edit", input: { path: "in.ts" }, details: { diff: "+1|x" } };
    expect(countEdit(ev).files).toEqual(["in.ts"]);
  });
});

describe("countEdit — edit tool (multi-file perFileResults)", () => {
  it("sums per-file diffs and lists each file", () => {
    const ev: EditResultLike = {
      toolName: "edit",
      details: {
        perFileResults: [
          { path: "a.ts", diff: ["+1|a", "+2|b"].join("\n") },
          { path: "b.ts", diff: ["-3|c"].join("\n") },
        ],
      },
    };
    expect(countEdit(ev)).toEqual({ countable: true, tool: "edit", added: 2, removed: 1, files: ["a.ts", "b.ts"] });
  });
  it("skips errored per-file entries", () => {
    const ev: EditResultLike = {
      toolName: "edit",
      details: {
        perFileResults: [
          { path: "ok.ts", diff: "+1|x" },
          { path: "bad.ts", isError: true, diff: "+9|should-not-count" },
        ],
      },
    };
    expect(countEdit(ev)).toEqual({ countable: true, tool: "edit", added: 1, removed: 0, files: ["ok.ts"] });
  });
});

describe("countEdit — degrade-safe (never throws, returns not-countable)", () => {
  it("errored results are not counted", () => {
    expect(countEdit({ toolName: "edit", isError: true, details: { diff: "+1|x" } }).countable).toBe(false);
    expect(countEdit({ toolName: "write", isError: true, input: { content: "a\nb" } }).countable).toBe(false);
  });
  it("non-edit tools are not counted", () => {
    expect(countEdit({ toolName: "bash", input: { command: "ls" } }).countable).toBe(false);
    expect(countEdit({ toolName: "read", input: { path: "x" } }).countable).toBe(false);
  });
  it("edit with no diff / no details is not countable", () => {
    expect(countEdit({ toolName: "edit", input: {} }).countable).toBe(false);
    expect(countEdit({ toolName: "edit", details: { diff: "" } }).countable).toBe(false);
  });
  it("a no-op diff (only context) is not countable", () => {
    expect(countEdit({ toolName: "edit", details: { diff: " 1|ctx\n 2|ctx" } }).countable).toBe(false);
  });
  it("malformed event degrades to not-countable", () => {
    expect(countEdit({} as EditResultLike).countable).toBe(false);
    expect(countEdit({ toolName: "edit" }).countable).toBe(false);
  });
});
