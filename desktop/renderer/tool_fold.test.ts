// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/tool_fold.test.ts - P-PROGRESS.2: the operator's rule for the activity window. A crash, a
// repeat or an empty call is "processing" whatever its length; otherwise under 5 s is summarized and the rest
// keep a row.

import { describe, expect, test } from "bun:test";
import { foldSummary, QUICK_MS, stepFate, stepKey } from "./tool_fold.ts";

describe("stepFate", () => {
  const good = { informative: true, redundant: false, ok: true };

  test("the 5 s line: just under is summarized, at it keeps a row", () => {
    expect(stepFate({ ...good, elapsedMs: QUICK_MS - 1 })).toBe("quick");
    expect(stepFate({ ...good, elapsedMs: QUICK_MS })).toBe("row");
  });

  test("a failed, repeated or empty call is processing even when it ran long", () => {
    expect(stepFate({ ...good, ok: false, elapsedMs: 60_000 })).toBe("processing");
    expect(stepFate({ ...good, redundant: true, elapsedMs: 60_000 })).toBe("processing");
    expect(stepFate({ ...good, informative: false, elapsedMs: 60_000 })).toBe("processing");
    expect(stepFate({ ...good, ok: false, elapsedMs: 100 })).toBe("processing"); // a quick crash is not a summary line
  });

  test("an unknown length is not called quick", () => {
    expect(stepFate({ informative: true, redundant: false })).toBe("row");
    expect(stepFate({ ...good, elapsedMs: Number.NaN })).toBe("row");
  });
});

describe("stepKey", () => {
  test("the same tool and arguments match across whitespace; a call without arguments is never a repeat", () => {
    expect(stepKey("bash", "git  status\n")).toBe(stepKey("execute", "git status"));
    expect(stepKey("read", "a.ts")).not.toBe(stepKey("bash", "a.ts"));
    expect(stepKey("tool", "", "")).toBe("");
  });
});

describe("foldSummary", () => {
  test("counts by kind in a fixed order, singular and plural, with processing last", () => {
    expect(foldSummary(["bash", "read", "grep", "read", "grep", "read"], 2)).toBe("Read 3 files, 2 searches, ran 1 command, processing 2");
  });

  test("only processing reads as a processing value", () => {
    expect(foldSummary([], 3)).toBe("Processing (3)");
    expect(foldSummary([], 0)).toBe("");
  });
});
