// harness/memory/state.test.ts

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateArtifacts, STATE_FILES } from "./state.ts";

let dir: string;
const fixedClock = () => "2026-06-18T00:00:00Z";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "state-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("initializes all four artifacts with headers", () => {
  const s = new StateArtifacts(join(dir, "state"), { now: fixedClock });
  for (const f of STATE_FILES) {
    expect(existsSync(s.path(f))).toBe(true);
  }
  expect(s.read("FAILURES.md")).toContain("# FAILURES");
});

test("NOW.md is overwritten each write (current snapshot)", () => {
  const s = new StateArtifacts(join(dir, "state"), { now: fixedClock });
  s.writeNow("first");
  s.writeNow("second");
  const now = s.read("NOW.md");
  expect(now).toContain("second");
  expect(now).not.toContain("first");
});

test("PROGRESS / DECISIONS / FAILURES are append-only", () => {
  const s = new StateArtifacts(join(dir, "state"), { now: fixedClock });
  s.appendProgress("line A");
  s.appendProgress("line B");
  const prog = s.read("PROGRESS.md");
  expect(prog).toContain("line A");
  expect(prog).toContain("line B");

  s.appendDecision("Use Bun", "It matches omp.");
  expect(s.read("DECISIONS.md")).toContain("## Use Bun (2026-06-18T00:00:00Z)");

  s.appendFailure("flaky test");
  expect(s.read("FAILURES.md")).toContain("[2026-06-18T00:00:00Z] flaky test");
});

test("existing files are not re-initialized (state survives reopen)", () => {
  const a = new StateArtifacts(join(dir, "state"), { now: fixedClock });
  a.appendProgress("persisted line");
  const b = new StateArtifacts(join(dir, "state"), { now: fixedClock });
  expect(b.read("PROGRESS.md")).toContain("persisted line");
});
