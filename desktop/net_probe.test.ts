// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-NETSTAT.1 (ADR-0422): the engine probe is rate-limited however many renderers poll, and a provider
// switch starts a fresh window.
import { expect, test } from "bun:test";
import { MIN_GAP_MS, NetProbe } from "./net_probe.ts";

test("concurrent and too-early polls share one probe; the gap re-arms it", async () => {
  let now = 1_000_000;
  const hits: string[] = [];
  const probe = new NetProbe(async (url) => { hits.push(url); return 42; }, () => now);
  const [a, b] = await Promise.all([probe.check("https://api.anthropic.com"), probe.check("https://api.anthropic.com")]);
  expect(hits.length).toBe(1);
  expect(a.samples).toBe(1);
  expect(b.lastMs).toBe(42);
  now += MIN_GAP_MS - 1;
  await probe.check("https://api.anthropic.com");
  expect(hits.length).toBe(1);
  now += 1;
  const v = await probe.check("https://api.anthropic.com");
  expect(hits.length).toBe(2);
  expect(v.target).toBe("api.anthropic.com");
});

test("a failed probe is a failed sample, and a new target drops the old host's history", async () => {
  let now = 0;
  let answer: number | null = null;
  const probe = new NetProbe(async () => answer, () => now);
  await probe.check("https://api.openai.com"); now += MIN_GAP_MS;
  const off = await probe.check("https://api.openai.com");
  expect(off.state).toBe("offline");
  answer = 30;
  now += MIN_GAP_MS;
  const fresh = await probe.check("https://api.anthropic.com");
  expect(fresh.samples).toBe(1);
  expect(fresh.state).toBe("online");
});
