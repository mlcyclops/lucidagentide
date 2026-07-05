// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/sandbox_status.test.ts — P-SANDBOX.5 (ADR-0169): the GUI-owned runtime-sandbox status store.

import { afterEach, expect, test } from "bun:test";
import {
  recordEgressBlockView,
  resetSandboxStatus,
  sandboxStatus,
  setSandboxState,
  type SandboxState,
} from "./sandbox_status.ts";

afterEach(() => resetSandboxStatus());

const state = (over: Partial<SandboxState> = {}): SandboxState => ({
  backend: "seatbelt", isolated: true, disclosed: false, platform: "darwin", execBlocked: null, proxied: true, at: "2026-07-05T00:00:00Z", ...over,
});

test("starts empty — no state, no blocks", () => {
  expect(sandboxStatus()).toEqual({ state: null, egressBlocks: [] });
});

test("setSandboxState replaces the state (a respawn re-resolves the live posture)", () => {
  setSandboxState(state({ backend: "bwrap" }));
  setSandboxState(state({ backend: "noop", isolated: false, disclosed: true }));
  expect(sandboxStatus().state?.backend).toBe("noop");
  expect(sandboxStatus().state?.isolated).toBe(false);
});

test("recordEgressBlockView keeps newest-first and is bounded to the ring cap (50)", () => {
  for (let i = 0; i < 60; i++) recordEgressBlockView({ host: `h${i}.cn`, channel: "dns", type: "dns_query_blocked", reason: "r", at: "t" });
  const b = sandboxStatus().egressBlocks;
  expect(b).toHaveLength(50);
  expect(b[0]!.host).toBe("h59.cn"); // newest first
  expect(b.at(-1)!.host).toBe("h10.cn"); // oldest 10 evicted
});

test("sandboxStatus returns a COPY of the ring — callers can't mutate the store", () => {
  recordEgressBlockView({ host: "a.cn", channel: "connect", type: "subprocess_egress_blocked", reason: "r", at: "t" });
  const snap = sandboxStatus();
  snap.egressBlocks.push({ host: "injected", channel: "dns", type: "x", reason: "y", at: "t" });
  expect(sandboxStatus().egressBlocks).toHaveLength(1); // the store is unaffected
});

test("resetSandboxStatus clears both state and blocks", () => {
  setSandboxState(state());
  recordEgressBlockView({ host: "a.cn", channel: "dns", type: "dns_query_blocked", reason: "r", at: "t" });
  resetSandboxStatus();
  expect(sandboxStatus()).toEqual({ state: null, egressBlocks: [] });
});
