// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/goal_memory.test.ts
//
// P-GOAL.3 (ADR-0046): the loop's durable on-disk memory. Verifies the markdown record (header +
// per-iteration outcomes + result), that a null/unwritable memory is a safe no-op, and that the path
// stays confined to `.omp/loops/` even for a hostile goal string.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendGoalIteration, finishGoalMemory, listResumableLoops, parseGoalMemory, resumeGoalMemory, saveGoalReport, startGoalMemory } from "./goal_memory.ts";

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

describe("parseGoalMemory + resume (P-GOAL.4)", () => {
  test("parseGoalMemory extracts params + progress; succeeded reflects the Result", () => {
    const ws = mkdtempSync(join(homedir(), ".lucid-goalparse-"));
    try {
      const mem = startGoalMemory(ws, "p1", { goal: "Fix the build", condition: "make exits 0", command: "make" })!;
      appendGoalIteration(mem, 1, "tweaked the Makefile", { done: false, reason: "still failing" });
      finishGoalMemory(mem, "stopped: hit the cap");
      const parsed = parseGoalMemory(readFileSync(mem.path, "utf8"))!;
      expect(parsed.goal).toBe("Fix the build");
      expect(parsed.condition).toBe("make exits 0");
      expect(parsed.command).toBe("make");
      expect(parsed.iterations).toBe(1);
      expect(parsed.succeeded).toBe(false); // "stopped" ⇒ resumable
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  test("parseGoalMemory: a met goal is NOT resumable; junk content ⇒ null", () => {
    expect(parseGoalMemory("# Goal loop: x\n\n## Result\nGoal met in 2 iterations: all pass\n")!.succeeded).toBe(true);
    expect(parseGoalMemory("just some markdown, not a loop")).toBeNull();
  });

  test("listResumableLoops returns only the stopped loop, newest first", () => {
    const ws = mkdtempSync(join(homedir(), ".lucid-goallist-"));
    try {
      const done = startGoalMemory(ws, "aaa", { goal: "Done one", condition: "c" })!;
      finishGoalMemory(done, "Goal met in 1 iteration: ok");
      const open = startGoalMemory(ws, "bbb", { goal: "Open one", condition: "c", command: "npm test" })!;
      finishGoalMemory(open, "stopped: hit the cap");
      const list = listResumableLoops(ws);
      expect(list.map((l) => l.goal)).toContain("Open one");
      expect(list.map((l) => l.goal)).not.toContain("Done one"); // succeeded loops are excluded
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  test("resumeGoalMemory reopens an existing file (marks Resumed, returns prior); rejects traversal", () => {
    const ws = mkdtempSync(join(homedir(), ".lucid-goalresume-"));
    try {
      const mem = startGoalMemory(ws, "r1", { goal: "Resume me", condition: "c" })!;
      const r = resumeGoalMemory(ws, mem.rel);
      expect(r).not.toBeNull();
      expect(r!.prior).toContain("Resume me");
      expect(readFileSync(mem.path, "utf8")).toContain("## Resumed");
      expect(resumeGoalMemory(ws, "../../../etc/passwd")).toBeNull(); // confinement
      expect(resumeGoalMemory(ws, ".omp/loops/nope.md")).toBeNull();   // missing
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
});

describe("saveGoalReport (P-GOAL.9)", () => {
  test("writes the AAR beside the memory file, confined to the loops root", () => {
    const ws = mkdtempSync(join(homedir(), ".lucid-goalreport-"));
    try {
      const rel = saveGoalReport(ws, "rep1", "Make auth tests pass", "# After-Action Report: x\n\nbody\n");
      expect(rel).not.toBeNull();
      expect(rel!.replace(/\\/g, "/")).toBe(".omp/loops/rep1-make-auth-tests-pass.report.md");
      expect(readFileSync(join(ws, rel!), "utf8")).toContain("After-Action Report");
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  test("shares the memory file's <id>-<slug> stem so they co-locate", () => {
    const ws = mkdtempSync(join(homedir(), ".lucid-goalreport2-"));
    try {
      const mem = startGoalMemory(ws, "stem9", { goal: "Fix the build", condition: "c" })!;
      const rel = saveGoalReport(ws, "stem9", "Fix the build", "report")!;
      // same directory + same id prefix as the memory file, distinguished by the .report.md suffix
      expect(mem.rel.replace(/\\/g, "/")).toBe(".omp/loops/stem9-fix-the-build.md");
      expect(rel.replace(/\\/g, "/")).toBe(".omp/loops/stem9-fix-the-build.report.md");
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  test("a hostile goal cannot escape the loops root", () => {
    const ws = mkdtempSync(join(homedir(), ".lucid-goalreport3-"));
    try {
      const rel = saveGoalReport(ws, "id", "../../etc/passwd evil", "x");
      expect(rel).not.toBeNull();
      expect(rel!).not.toContain("..");
      expect(rel!.replace(/\\/g, "/")).toContain(".omp/loops/");
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
});
