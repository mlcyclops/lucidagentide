// desktop/goal_memory.test.ts
//
// P-GOAL.3 (ADR-0046): the loop's durable on-disk memory. Verifies the markdown record (header +
// per-iteration outcomes + result), that a null/unwritable memory is a safe no-op, and that the path
// stays confined to `.omp/loops/` even for a hostile goal string.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendGoalIteration, finishGoalMemory, startGoalMemory } from "./goal_memory.ts";

describe("goal_memory", () => {
  test("writes a durable markdown record under .omp/loops/", () => {
    const ws = mkdtempSync(join(homedir(), ".lucid-goalmem-"));
    try {
      const mem = startGoalMemory(ws, "abc123", { goal: "Make auth tests pass", condition: "npm test exits 0", command: "npm test" });
      expect(mem).not.toBeNull();
      expect(mem!.rel.replace(/\\/g, "/")).toContain(".omp/loops/");
      expect(existsSync(mem!.path)).toBe(true);

      appendGoalIteration(mem, 1, "Fixed the token parser.", { done: false, reason: "1 test still failing" });
      appendGoalIteration(mem, 2, "Fixed the expiry check.", { done: true, reason: "all tests pass" });
      finishGoalMemory(mem, "Goal met in 2 iterations: all tests pass");

      const md = readFileSync(mem!.path, "utf8");
      expect(md).toContain("# Goal loop: Make auth tests pass");
      expect(md).toContain("- verify: `npm test`");
      expect(md).toContain("## Iteration 1");
      expect(md).toContain("**checker:** not yet");
      expect(md).toContain("## Iteration 2");
      expect(md).toContain("**checker:** condition met");
      expect(md).toContain("## Result");
      expect(md).toContain("Goal met in 2 iterations");
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  test("null memory (unwritable) is a safe no-op, never throws", () => {
    expect(() => { appendGoalIteration(null, 1, "x", { done: false, reason: "y" }); finishGoalMemory(null, "z"); }).not.toThrow();
  });

  test("path is confined to the loops root even for a hostile goal", () => {
    const ws = mkdtempSync(join(homedir(), ".lucid-goalmem2-"));
    try {
      const mem = startGoalMemory(ws, "id", { goal: "../../etc/passwd evil", condition: "c" });
      expect(mem).not.toBeNull();
      expect(mem!.path.replace(/\\/g, "/")).toContain("/.omp/loops/");
      expect(mem!.path).not.toContain("..");
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
});
