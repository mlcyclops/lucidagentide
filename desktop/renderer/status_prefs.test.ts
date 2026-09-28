// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/status_prefs.test.ts - P-PROGRESS.3 (ADR-0412): with the experimental estimate off no
// expected time is ever printed, and with it on the user sees a number or nothing, never a placeholder.

import { describe, expect, test } from "bun:test";
import { queueWhen, shownEta } from "./status_prefs.ts";
import { ETA_ESTIMATING } from "../turn_progress.ts";
import type { SequenceEntry } from "../workspace_gate.ts";

describe("shownEta", () => {
  test("off hides every phrase; on shows a number and suppresses the no-history placeholder", () => {
    expect(shownEta("about 2 m left (est.)", false)).toBe("");
    expect(shownEta("about 2 m left (est.)", true)).toBe("about 2 m left (est.)");
    expect(shownEta(ETA_ESTIMATING, true)).toBe("");
  });
});

describe("queueWhen", () => {
  const now = 100_000;
  const running: SequenceEntry = { id: "a", name: "alpha", folder: "repo", state: "running", position: 0, sinceAt: now - 42_000, etaMs: 60_000, expectedStartAt: now - 42_000 };
  const waiting: SequenceEntry = { id: "b", name: "beta", folder: "repo", state: "waiting", position: 1, sinceAt: now - 5_000, etaMs: 30_000, expectedStartAt: now + 60_000 };
  test("with the estimate on, the running holder and the waiter carry their expected times", () => {
    expect(queueWhen(running, now, true)).toBe("running since 42 s ago, about 1 m left (est.)");
    expect(queueWhen(waiting, now, true)).toBe("waits, starts in about 1 m (est.)");
  });
  test("with the estimate off, no expected time is printed for anyone", () => {
    expect(queueWhen(running, now, false)).toBe("running since 42 s ago");
    expect(queueWhen(waiting, now, false)).toBe("waits its turn");
  });
});
