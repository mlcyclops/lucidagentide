// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/acp.test.ts - P-STALL.2 (ADR-0263): a dead omp child must REJECT its in-flight requests.
// With the time-based turn cutoff removed, this event-driven rejection is the only thing standing
// between a crashed agent process and an infinite "Thinking..." - so it is pinned by a REAL child
// process, not a mock: the child exits while a request is parked, and the promise must reject.

import { describe, expect, test } from "bun:test";
import { ACPClient } from "./acp.ts";

describe("ACPClient transport death", () => {
  test("child exit rejects a parked request with the exit code (never a silent hang)", async () => {
    // Deliberate real-timer exception: the setTimeout runs INSIDE the spawned child, whose genuine
    // process exit is the platform behavior under test - fake timers cannot kill a real process. The
    // test itself awaits the rejection promise directly; there is no test-side sleep.
    const client = new ACPClient("bun", ["-e", "setTimeout(() => process.exit(7), 150)"], process.cwd());
    client.start();
    const t0 = Date.now();
    let err: Error | null = null;
    try {
      await client.request("session/prompt", { anything: true });
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("exited");
    expect(err!.message).toContain("7");
    expect(Date.now() - t0).toBeLessThan(10_000); // event-driven, not a clock
  }, 15_000);

  test("a spawn failure (missing binary) rejects instead of stranding", async () => {
    const client = new ACPClient("definitely-not-a-real-binary-xyz", [], process.cwd());
    client.start();
    let rejected = false;
    try {
      await client.request("initialize", {});
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  }, 15_000);
});
