// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/turn_progress.test.ts - P-PROGRESS.1: a dead agent process is the one state a worker reports,
// and it outranks a turn in flight.

import { describe, expect, test } from "bun:test";
import { humanMs, progressView } from "./turn_progress.ts";

describe("progressView", () => {
  test("a dead child outranks a running turn, and idle is only idle when nothing runs", () => {
    expect(progressView({ busy: true, dead: true }).liveness).toBe("dead");
    expect(progressView({ busy: false, dead: true }).liveness).toBe("dead");
    expect(progressView({ busy: true, dead: false }).liveness).toBe("running");
    expect(progressView({ busy: false, dead: false }).liveness).toBe("idle");
  });
});

describe("humanMs", () => {
  test("seconds, then minutes with seconds, then hours with minutes; junk is ?", () => {
    expect(humanMs(59_400)).toBe("59 s");
    expect(humanMs(59_600)).toBe("1 m");
    expect(humanMs(185_000)).toBe("3 m 5 s");
    expect(humanMs(3_720_000)).toBe("1 h 2 m");
    expect(humanMs(Number.NaN)).toBe("?");
    expect(humanMs(-1)).toBe("?");
  });
});
