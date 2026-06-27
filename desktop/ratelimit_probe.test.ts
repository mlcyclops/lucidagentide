// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/ratelimit_probe.test.ts — P10.3 pure header-parser coverage. The live fetch needs a real
// key to exercise; these lock the parsing/math that turns provider headers into the budget shape.
import { expect, test } from "bun:test";
import { parseAnthropic, parseDuration, parseOpenAI } from "./ratelimit_probe.ts";

test("parseAnthropic: token limit/remaining + RFC3339 reset → used fraction", () => {
  const h = new Headers({
    "anthropic-ratelimit-tokens-limit": "100000",
    "anthropic-ratelimit-tokens-remaining": "25000",
    "anthropic-ratelimit-tokens-reset": "2026-06-20T12:00:00Z",
  });
  const r = parseAnthropic(h)!;
  expect(r.provider).toBe("anthropic");
  expect(r.limit).toBe(100000);
  expect(r.remaining).toBe(25000);
  expect(r.used).toBeCloseTo(0.75, 5);
  expect(r.resetsAt).toBe(Date.parse("2026-06-20T12:00:00Z"));
});

test("parseAnthropic: missing headers → null (fails soft)", () => {
  expect(parseAnthropic(new Headers())).toBeNull();
  expect(parseAnthropic(new Headers({ "anthropic-ratelimit-tokens-limit": "0", "anthropic-ratelimit-tokens-remaining": "0" }))).toBeNull();
});

test("parseOpenAI: token headers + duration reset → absolute time", () => {
  const now = 1_000_000;
  const r = parseOpenAI(new Headers({
    "x-ratelimit-limit-tokens": "200000",
    "x-ratelimit-remaining-tokens": "180000",
    "x-ratelimit-reset-tokens": "6m0s",
  }), now)!;
  expect(r.provider).toBe("openai");
  expect(r.used).toBeCloseTo(0.1, 5);
  expect(r.resetsAt).toBe(now + 6 * 60_000);
});

test("parseDuration: ms/s/m/h + compound + invalid", () => {
  expect(parseDuration("100ms", 0)).toBe(100);
  expect(parseDuration("1.5s", 0)).toBe(1500);
  expect(parseDuration("6m0s", 0)).toBe(360_000);
  expect(parseDuration("1h2m", 0)).toBe(3_600_000 + 120_000);
  expect(parseDuration("", 0)).toBeNull();
  expect(parseDuration(null, 0)).toBeNull();
  expect(parseDuration("garbage", 0)).toBeNull();
});
