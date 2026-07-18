// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/tools/output_cmdaware_proto.test.ts — PROTOTYPE tests for command-aware
// filters. Behavior + the safety invariants (keep-by-default, summary survival,
// hint stripping, dir grouping + cap-with-recovery-marker).

import { test, expect } from "bun:test";
import { filterGitStatus, filterTestFailuresOnly, filterLogDedup } from "./output_cmdaware_proto.ts";

const GIT_STATUS = `On branch feature/x
Your branch is ahead of 'origin/main' by 2 commits.
  (use "git push" to publish your local commits)

Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
\tmodified:   src/core/a.ts
\tnew file:   src/core/b.ts

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
\tmodified:   src/cmds/git.ts
\tdeleted:    docs/old.md

Untracked files:
  (use "git add <file>..." to include in what will be committed)
\tsrc/core/c.ts
\tsrc/core/d.ts
\ttests/e.test.ts

no changes added to commit (use "git add" and/or "git commit -a")
`;

test("filterGitStatus: compacts branch/tracking, drops all (use …) hints", () => {
  const out = filterGitStatus(GIT_STATUS);
  expect(out).toContain("feature/x ahead:2");
  expect(out).not.toContain("(use ");
  expect(out).not.toContain("Your branch is");
});

test("filterGitStatus: groups staged/unstaged by dir with short status", () => {
  const out = filterGitStatus(GIT_STATUS);
  expect(out).toContain("staged (2):");
  expect(out).toContain("src/core/: M a.ts, A b.ts");
  expect(out).toContain("unstaged (2):");
  expect(out).toContain("src/cmds/: M git.ts");
  expect(out).toContain("docs/: D old.md");
});

test("filterGitStatus: untracked summarized as per-dir counts", () => {
  const out = filterGitStatus(GIT_STATUS);
  expect(out).toContain("untracked (3): src/core/(2) tests/(1)");
});

test("filterGitStatus: per-group cap emits a recovery marker", () => {
  const many = [
    "On branch main",
    "Changes to be committed:",
    ...Array.from({ length: 20 }, (_, i) => `\tmodified:   pkg/f${i}.ts`),
  ].join("\n");
  const out = filterGitStatus(many, { perGroupCap: 5 });
  expect(out).toContain("staged (20):");
  expect(out).toContain("(+15 more)");
});

test("filterGitStatus: clean tree yields just the branch line", () => {
  const out = filterGitStatus("On branch main\nnothing to commit, working tree clean\n");
  expect(out.trim()).toBe("main");
});

const BUN_TEST = `bun test v1.3.14

harness/tools/x.test.ts:
(pass) does a thing [0.5ms]
(pass) does another [0.3ms]
(fail) breaks on edge
  error: expected 1 to be 2
      at x.test.ts:42
(pass) yet another [0.2ms]

 2 pass
 1 fail
 5 expect() calls
Ran 3 tests across 1 file. [80ms]
`;

test("filterTestFailuresOnly: drops (pass) lines, keeps (fail) + its error block", () => {
  const { text, hiddenPass } = filterTestFailuresOnly(BUN_TEST);
  expect(hiddenPass).toBe(3);
  expect(text).toContain("(fail) breaks on edge");
  expect(text).toContain("error: expected 1 to be 2");
  expect(text).not.toContain("(pass)");
});

test("filterTestFailuresOnly: SUMMARY lines survive (not mistaken for pass-noise)", () => {
  const { text } = filterTestFailuresOnly(BUN_TEST);
  expect(text).toContain("2 pass");
  expect(text).toContain("1 fail");
});

test("filterTestFailuresOnly: cargo per-test 'ok' dropped, 'test result' kept", () => {
  const cargo = [
    "test utils::parse ... ok",
    "test utils::format ... ok",
    "test utils::edge ... FAILED",
    "",
    "test result: FAILED. 2 passed; 1 failed; 0 ignored",
  ].join("\n");
  const { text, hiddenPass } = filterTestFailuresOnly(cargo);
  expect(hiddenPass).toBe(2);
  expect(text).toContain("edge ... FAILED");
  expect(text).toContain("test result: FAILED. 2 passed; 1 failed");
});

test("filterTestFailuresOnly: KEEP-BY-DEFAULT — unrecognized lines retained", () => {
  const weird = "some tool output\nwith no known pass marker\n::stacktrace::";
  const { text, hiddenPass } = filterTestFailuresOnly(weird);
  expect(hiddenPass).toBe(0);
  expect(text).toBe(weird);
});

test("filterLogDedup: collapses timestamp-only-different lines exact-dedup CANNOT", () => {
  const log = [
    "2026-07-08T10:00:01.001Z INFO GET /healthz 200",
    "2026-07-08T10:00:02.517Z INFO GET /healthz 200",
    "2026-07-08T10:00:03.244Z INFO GET /healthz 200",
  ].join("\n");
  const { text, linesRemoved } = filterLogDedup(log);
  expect(linesRemoved).toBe(2);
  // first concrete line kept verbatim (real timestamp, nothing fabricated) + count
  expect(text).toBe("2026-07-08T10:00:01.001Z INFO GET /healthz 200 (x3)");
});

test("filterLogDedup: masks latency/duration tokens too", () => {
  const log = "Reply from 127.0.0.1: bytes=32 time<1ms TTL=128\nReply from 127.0.0.1: bytes=32 time=3ms TTL=128";
  const { linesRemoved } = filterLogDedup(log);
  expect(linesRemoved).toBe(1);
});

test("filterLogDedup: distinct messages are NOT merged (order-preserving)", () => {
  const log = [
    "2026-07-08T10:00:01Z INFO GET /healthz 200",
    "2026-07-08T10:00:02Z WARN slow query 1200ms",
    "2026-07-08T10:00:03Z INFO GET /healthz 200",
  ].join("\n");
  const { text, linesRemoved } = filterLogDedup(log);
  expect(linesRemoved).toBe(0);
  expect(text.split("\n")).toHaveLength(3);
});

test("filterLogDedup: aggressive mode groups by endpoint shape, default keeps ids", () => {
  const log = "GET /user/1 200\nGET /user/2 200\nGET /user/3 200";
  expect(filterLogDedup(log).linesRemoved).toBe(0); // conservative: ids differ
  expect(filterLogDedup(log, { aggressiveNumbers: true }).linesRemoved).toBe(2);
});
