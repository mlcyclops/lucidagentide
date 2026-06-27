// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/loop_report.test.ts — P-GOAL.9 (ADR-0054): the After-Action Report's pure core.

import { describe, expect, test } from "bun:test";
import {
  bar,
  extractUrls,
  formatDuration,
  type LoopMetrics,
  mermaidBar,
  mermaidPie,
  normalizeToolName,
  parseNumstat,
  renderLoopReport,
  stallSignature,
  summarizeLoop,
} from "./loop_report.ts";

describe("normalizeToolName", () => {
  test("groups common omp kinds into stable types", () => {
    expect(normalizeToolName("Edit")).toBe("edit");
    expect(normalizeToolName("Write")).toBe("edit");
    expect(normalizeToolName("Bash")).toBe("shell");
    expect(normalizeToolName("execute_command")).toBe("shell");
    expect(normalizeToolName("Grep")).toBe("search");
    expect(normalizeToolName("Read")).toBe("read");
    expect(normalizeToolName("WebFetch")).toBe("web-fetch");
    expect(normalizeToolName("web_search")).toBe("web-search");
  });
  test("web-search is matched before web-fetch (order matters)", () => {
    expect(normalizeToolName("WebSearch")).toBe("web-search");
  });
  test("unknown kinds pass through slugged, never throw", () => {
    expect(normalizeToolName("MyCustomThing!!")).toBe("mycustomthing");
    expect(normalizeToolName("")).toBe("other");
  });
});

describe("extractUrls", () => {
  test("pulls, dedupes, and trims trailing punctuation", () => {
    const urls = extractUrls("see https://example.com/docs. also https://example.com/docs and http://a.io/x)");
    expect(urls).toEqual(["https://example.com/docs", "http://a.io/x"]);
  });
  test("ignores non-http text and respects the cap", () => {
    expect(extractUrls("nothing here, ftp://x not matched")).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => `https://h${i}.com`).join(" ");
    expect(extractUrls(many, 3)).toHaveLength(3);
  });
});

describe("parseNumstat", () => {
  test("sums added/removed and counts files", () => {
    const loc = parseNumstat("12\t3\tsrc/a.ts\n0\t8\tsrc/b.ts\n");
    expect(loc).toEqual({ added: 12, removed: 11, files: 2 });
  });
  test("skips binary (-) files for line counts but still counts the file", () => {
    const loc = parseNumstat("-\t-\timg.png\n5\t0\tnote.md");
    expect(loc).toEqual({ added: 5, removed: 0, files: 2 });
  });
  test("empty input is zeroed", () => {
    expect(parseNumstat("")).toEqual({ added: 0, removed: 0, files: 0 });
  });
});

describe("stallSignature", () => {
  test("collapses digits so a recurring blocker matches across rounds", () => {
    expect(stallSignature("3 of 5 tests fail")).toBe(stallSignature("2 of 5 tests fail"));
  });
  test("different blockers do not collide", () => {
    expect(stallSignature("lint errors remain")).not.toBe(stallSignature("type check fails"));
  });
});

describe("bar / formatDuration", () => {
  test("bar fills proportionally and is fixed width", () => {
    expect(bar(5, 10, 10)).toBe("█████░░░░░");
    expect(bar(0, 10, 4)).toBe("░░░░");
    expect(bar(99, 0, 4)).toBe("░░░░"); // max 0 → empty, no divide-by-zero
  });
  test("duration formats across scales", () => {
    expect(formatDuration(800)).toBe("0.8s");
    expect(formatDuration(192_000)).toBe("3m 12s");
    expect(formatDuration(3_840_000)).toBe("1h 04m");
  });
});

describe("mermaid helpers", () => {
  test("pie omits zero slices and returns '' when empty", () => {
    expect(mermaidPie("T", { edit: 3, read: 0 })).toContain('"edit" : 3');
    expect(mermaidPie("T", { edit: 3, read: 0 })).not.toContain("read");
    expect(mermaidPie("T", { a: 0 })).toBe("");
  });
  test("bar returns '' when all values are zero, else a valid xychart", () => {
    expect(mermaidBar("L", ["Added", "Removed"], [0, 0])).toBe("");
    const c = mermaidBar("L", ["Added", "Removed"], [12, 4], "Lines");
    expect(c).toContain("xychart-beta");
    expect(c).toContain("bar [12, 4]");
    expect(c).toContain("0 --> 12");
  });
});

function metrics(over: Partial<LoopMetrics> = {}): LoopMetrics {
  return {
    goal: "make auth tests pass",
    condition: "npm test exits 0",
    command: "npm test",
    outcome: "met",
    outcomeReason: "all tests pass",
    iterations: 2,
    maxIters: 6,
    durationMs: 192_000,
    toolCalls: { edit: 4, shell: 6, read: 2 },
    loc: { added: 40, removed: 9, files: 3 },
    errors: [{ iter: 1, detail: "tool call rejected: bash" }],
    websites: ["https://example.com/docs"],
    perIteration: [
      { n: 1, tools: 7, errors: 1, done: false, reason: "1 test still failing" },
      { n: 2, tools: 5, errors: 0, done: true, reason: "all green" },
    ],
    ...over,
  };
}

describe("renderLoopReport", () => {
  test("includes every required section and graph", () => {
    const md = renderLoopReport(metrics());
    expect(md).toContain("# After-Action Report: make auth tests pass");
    expect(md).toContain("✅ Goal met");
    expect(md).toContain("## Scoreboard");
    expect(md).toContain("## Tool calls by type");
    expect(md).toContain("```mermaid"); // at least one chart
    expect(md).toContain("## Lines of code changed");
    expect(md).toContain("+40 / -9");
    expect(md).toContain("## Errors recorded");
    expect(md).toContain("## Websites visited");
    expect(md).toContain("https://example.com/docs");
    expect(md).toContain("## Per-iteration log");
    expect(md).toContain("Iterations | 2 of 6");
  });

  test("degrades honestly when data is absent (no charts crash)", () => {
    const md = renderLoopReport(metrics({
      toolCalls: {}, loc: null, errors: [], websites: [],
      outcome: "stopped", outcomeReason: "hit the cap",
      perIteration: [{ n: 1, tools: 0, errors: 0, done: false, reason: "no progress" }],
    }));
    expect(md).toContain("⏹️ Stopped");
    expect(md).toContain("_No tool calls recorded._");
    expect(md).toContain("Not a git workspace");
    expect(md).toContain("_No errors recorded");
    expect(md).toContain("_None._"); // websites
    // an all-absent report must NOT emit an (invalid) empty mermaid block
    expect(md).not.toContain("```mermaid\npie showData title Tool calls by type\n```");
  });

  test("is deterministic — same metrics, same bytes", () => {
    expect(renderLoopReport(metrics())).toBe(renderLoopReport(metrics()));
  });

  test("table cells escape backslash before pipe (CodeQL: incomplete escaping)", () => {
    // A trailing backslash must NOT be left able to escape the cell's closing pipe.
    const md = renderLoopReport(metrics({
      errors: [{ iter: 1, detail: "path C:\\tmp | bad" }],
      perIteration: [{ n: 1, tools: 1, errors: 1, done: false, reason: "regex a\\|b failed" }],
    }));
    expect(md).toContain("C:\\\\tmp \\| bad");   // backslash → \\, pipe → \|
    expect(md).toContain("regex a\\\\\\|b failed"); // a, \ →\\, | →\|, b
    // every body row still has the right number of cell delimiters (not broken by a stray pipe)
    for (const line of md.split("\n").filter((l) => /^\| 1 \|/.test(l))) {
      expect(line.endsWith(" |")).toBe(true);
    }
  });
});

describe("summarizeLoop", () => {
  test("compact one-liner for the banner / event", () => {
    expect(summarizeLoop(metrics())).toBe("2 iter · 12 tool calls · +40/-9 LOC · 1 errors · 1 sites");
  });
  test("notes when LOC is unavailable", () => {
    expect(summarizeLoop(metrics({ loc: null }))).toContain("LOC n/a");
  });
});
