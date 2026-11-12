// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/tool_describe.test.ts - P-PROGRESS.1: the doing line prefers the agent's own words, then
// omp's prose title, then a sentence from the tool and its first argument; a bare kind never reads as prose.

import { describe, expect, test } from "bun:test";
import { describeTool } from "./tool_describe.ts";

describe("describeTool", () => {
  test("the agent's intent wins over everything", () => {
    expect(describeTool({ name: "bash", intent: "Running the lane tests", title: "bun test", input: "bun test" }).doing).toBe("Running the lane tests");
  });

  test("a prose title beats a built sentence; a bare tool name or kind is not prose", () => {
    expect(describeTool({ name: "other", title: "Reading model role settings" }).doing).toBe("Reading model role settings");
    expect(describeTool({ name: "bash", kind: "execute", title: "bash", input: "bun test desktop" }).doing).toBe("Running bun test desktop");
    expect(describeTool({ name: "execute", title: "execute" }).doing).toBe("Running a shell command");
  });

  test("the sentence uses the path for a write or edit and the first argument line otherwise", () => {
    expect(describeTool({ name: "edit", path: "src/app.ts" }).doing).toBe("Editing src/app.ts");
    expect(describeTool({ name: "grep", input: "TODO\n  in: src" }).doing).toBe("Searching TODO");
    expect(describeTool({ name: "read", input: "x".repeat(200) }).doing.length).toBeLessThan(120);
    // P-PROGRESS.2: arguments serialized as an object name their subject, never the opening brace.
    expect(describeTool({ name: "read", input: JSON.stringify({ path: "desktop/turn_progress.ts", limit: 40 }, null, 2) }).doing).toBe("Reading desktop/turn_progress.ts");
    expect(describeTool({ name: "other", input: "{\n  \"flag\": true" }).informative).toBe(false); // clipped, subject-less object
  });

  test("nothing known is still a sentence, keyed on the kind, flagged as saying nothing specific", () => {
    expect(describeTool({ name: "other" }).doing).toBe("Working with a tool");
    expect(describeTool({ name: "tool", title: "tool" }).informative).toBe(false); // P-PROGRESS.2: shown as processing
    expect(describeTool({ name: "read", input: "a.ts" }).informative).toBe(true);
    expect(describeTool({ name: "fetch" }).doing).toBe("Fetching a web resource");
    expect(describeTool({ name: "task" }).verb).toBe("Delegating");
  });
});
