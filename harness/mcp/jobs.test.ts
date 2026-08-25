// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-FLEET.1 (ADR-0256): the pure job table. What matters: the closed state set, sticky terminals (a
// cancelled job whose remote turn later settles must never become done), the unknown-id rule, key dedupe,
// the queue cap, and the custody rule that metadata views can never leak an envelope or a prompt.

import { expect, test } from "bun:test";
import { DEFAULT_MAX_QUEUE, JobTable, isTerminal, pollHintMs } from "./jobs.ts";

/** Deterministic table: injected clock + sequential ids. */
function table(opts: { maxQueue?: number } = {}) {
  let t = 1_000_000;
  let n = 0;
  const tb = new JobTable({ maxQueue: opts.maxQueue, now: () => t, mintId: () => `job-${String(n++).padStart(8, "0")}` });
  return { tb, tick: (ms: number) => { t += ms; } };
}

test("admit -> queued with a stable job-<8> id; start returns the prompt and clears it", () => {
  const { tb } = table();
  const a = tb.admit("do the thing");
  if (!a.ok) throw new Error("admit refused");
  expect(a.id).toMatch(/^job-[0-9a-f-]{8}$/i);
  expect(a.state).toBe("queued");
  expect(a.queuePosition).toBe(0);
  expect(tb.start(a.id)).toBe("do the thing");
  expect(tb.view(a.id)!.state).toBe("running");
  expect(tb.view(a.id)!.prompt).toBe(""); // minimal retention: the prompt does not linger
});

test("terminal states are sticky - a cancelled job can never become done", () => {
  const { tb } = table();
  const a = tb.admit("x");
  if (!a.ok) throw new Error("admit refused");
  tb.start(a.id);
  expect(tb.cancel(a.id)!.prior).toBe("running");
  tb.finish(a.id, "late envelope");            // the remote turn settled after the cancel
  expect(tb.view(a.id)!.state).toBe("cancelled");
  expect(tb.view(a.id)!.envelope).toBeUndefined();
  tb.fail(a.id, "error", "late error");        // and a late error cannot flip it either
  expect(tb.view(a.id)!.state).toBe("cancelled");
});

test("unknown id: view undefined, cancel undefined - never 'running'", () => {
  const { tb } = table();
  expect(tb.view("job-deadbeef")).toBeUndefined();
  expect(tb.cancel("job-deadbeef")).toBeUndefined();
});

test("key dedupe: the same live key returns the SAME id and admits no second job", () => {
  const { tb } = table();
  const a = tb.admit("refactor the auth module", "auth-refactor");
  if (!a.ok) throw new Error("admit refused");
  const b = tb.admit("refactor the auth module", "auth-refactor");
  if (!b.ok) throw new Error("dedupe refused");
  expect(b.id).toBe(a.id);
  expect(b.deduped).toBe(true);
  expect(tb.liveIds()).toHaveLength(1);
  // Once terminal, the key is free again - a NEW job is minted.
  tb.start(a.id);
  tb.finish(a.id, "env");
  const c = tb.admit("again", "auth-refactor");
  if (!c.ok) throw new Error("re-admit refused");
  expect(c.id).not.toBe(a.id);
  expect(c.deduped).toBe(false);
});

test("queue cap: dispatch past the cap refuses and the queue length is unchanged", () => {
  const { tb } = table({ maxQueue: 2 });
  expect(tb.admit("a").ok).toBe(true);
  expect(tb.admit("b").ok).toBe(true);
  const refused = tb.admit("c");
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("unreachable");
  expect(refused.reason).toContain("queue is full");
  expect(tb.liveIds()).toHaveLength(2);
});

test("queue positions count the running job and earlier queued jobs", () => {
  const { tb } = table();
  const a = tb.admit("a"); const b = tb.admit("b"); const c = tb.admit("c");
  if (!a.ok || !b.ok || !c.ok) throw new Error("admit refused");
  tb.start(a.id);
  expect(tb.queuePosition(a.id)).toBe(0); // running
  expect(tb.queuePosition(b.id)).toBe(1); // behind the running job
  expect(tb.queuePosition(c.id)).toBe(2);
  tb.finish(a.id, "env");
  expect(tb.queuePosition(b.id)).toBe(0); // next up
});

test("viewAll is metadata only: no envelope, no prompt, counts-only progress", () => {
  const { tb, tick } = table();
  const a = tb.admit("secret prompt text");
  if (!a.ok) throw new Error("admit refused");
  tb.start(a.id);
  tb.progress(a.id, { textChars: 120, toolLines: 3, permissionAsks: 1 });
  tick(4_000);
  tb.finish(a.id, "THE-ENVELOPE");
  const all = tb.viewAll();
  expect(all).toHaveLength(1);
  const flat = JSON.stringify(all);
  expect(flat).not.toContain("THE-ENVELOPE");
  expect(flat).not.toContain("secret prompt text");
  expect(all[0]!.progress).toEqual({ textChars: 120, toolLines: 3, permissionAsks: 1, lastActivityAt: 1_000_000 });
  expect(all[0]!.elapsedMs).toBe(4_000);
});

test("live jobs carry a poll hint; terminal jobs do not; the hint clamps 5-60s", () => {
  const { tb, tick } = table();
  const a = tb.admit("x");
  if (!a.ok) throw new Error("admit refused");
  tb.start(a.id);
  tick(2_000);
  expect(tb.viewAll()[0]!.pollHintMs).toBe(5_000);   // floor
  tick(300_000);
  expect(tb.viewAll()[0]!.pollHintMs).toBe(60_000);  // ceiling
  tb.expire(a.id, "deadline");
  expect(tb.viewAll()[0]!.pollHintMs).toBeUndefined();
  expect(pollHintMs(30_000)).toBe(15_000);           // the mid-range formula
});

test("cancel a queued job drops it (prompt cleared) with prior 'queued'; expire lands timeout", () => {
  const { tb } = table();
  const a = tb.admit("a"); const b = tb.admit("b");
  if (!a.ok || !b.ok) throw new Error("admit refused");
  tb.start(a.id);
  expect(tb.cancel(b.id)!.prior).toBe("queued");
  expect(tb.view(b.id)!.state).toBe("cancelled");
  expect(tb.view(b.id)!.prompt).toBe("");
  tb.expire(a.id, "took too long");
  expect(tb.view(a.id)!.state).toBe("timeout");
  expect(isTerminal(tb.view(a.id)!.state)).toBe(true);
  expect(tb.liveIds()).toHaveLength(0);
});

test("colliding mint re-rolls: ids are never reused", () => {
  let n = 0;
  const ids = ["job-same0000", "job-same0000", "job-uniq0001"];
  const tb = new JobTable({ now: () => 0, mintId: () => ids[Math.min(n++, ids.length - 1)]! });
  const a = tb.admit("a"); const b = tb.admit("b");
  if (!a.ok || !b.ok) throw new Error("admit refused");
  expect(a.id).toBe("job-same0000");
  expect(b.id).toBe("job-uniq0001");
});

test("the default queue cap is 8", () => {
  expect(DEFAULT_MAX_QUEUE).toBe(8);
});
