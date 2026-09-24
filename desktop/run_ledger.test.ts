// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-RECOVER.1 (ADR-0385): the run ledger decides whether the previous run died and which engine it
// owned. A false "unclean" nags the user with a bogus incident; a false claim about the engine could
// point the reaper at the wrong process, so anything malformed must make no claim at all.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessPreviousRun, freshLedger, markClean, readLedgerText, runLedgerPath, serializeLedger, withEngine, writeLedger } from "./run_ledger.ts";

const SELF = 5000;
const base = freshLedger({ mainPid: 4000, mainStartedAt: 1_790_000_000_000, port: 5319, appVersion: "2.3.0" });
const engine = { pid: 4100, startedAt: 1_790_000_001_234, exe: "C:\\app\\bin\\lucid-engine.exe" };

describe("assessPreviousRun", () => {
  test("a run that never reached a clean quit is unclean and keeps its engine record", () => {
    const r = assessPreviousRun(serializeLedger(withEngine(base, engine)), SELF);
    expect(r.verdict).toBe("unclean");
    if (r.verdict === "unclean") expect(r.ledger.engine).toEqual(engine);
  });

  test("a run that quit normally is clean", () => {
    expect(assessPreviousRun(serializeLedger(markClean(withEngine(base, engine))), SELF).verdict).toBe("clean");
  });

  test("a crash before the engine spawned is unclean with no engine to claim", () => {
    const r = assessPreviousRun(serializeLedger(base), SELF);
    expect(r).toEqual({ verdict: "unclean", ledger: base });
  });

  test("missing, corrupt, foreign-version, or malformed ledgers make no claim", () => {
    const bad = (patch: Record<string, unknown>): string => JSON.stringify({ ...base, ...patch });
    for (const text of [
      null,
      "",
      "{\"version\":1,\"mainPid\":", // torn write
      bad({ version: 2 }),
      bad({ clean: "false" }),
      bad({ mainPid: -1 }),
      bad({ engine: { pid: 0, startedAt: 1, exe: "x" } }),
      bad({ engine: { pid: 4100, startedAt: 1_790_000_001_234, exe: "" } }),
      bad({ engine: "lucid-engine" }),
    ]) {
      expect(assessPreviousRun(text, SELF)).toEqual({ verdict: "none" });
    }
  });

  test("a ledger naming this very process is not a previous run", () => {
    expect(assessPreviousRun(serializeLedger(base), base.mainPid)).toEqual({ verdict: "none" });
  });
});

describe("ledger file", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

  test("the unclean-then-clean lifecycle reads back through the file", () => {
    dir = mkdtempSync(join(tmpdir(), "run-ledger-"));
    const path = runLedgerPath(dir);
    expect(readLedgerText(path)).toBeNull();
    expect(writeLedger(path, withEngine(base, engine))).toBe(true);
    expect(assessPreviousRun(readLedgerText(path), SELF).verdict).toBe("unclean");
    expect(writeLedger(path, markClean(withEngine(base, engine)))).toBe(true);
    expect(assessPreviousRun(readLedgerText(path), SELF).verdict).toBe("clean");
  });

  test("an unwritable path reports failure instead of throwing", () => {
    dir = mkdtempSync(join(tmpdir(), "run-ledger-"));
    writeFileSync(join(dir, "file"), "x");
    expect(writeLedger(join(dir, "file", "run-state.json"), base)).toBe(false);
  });
});
