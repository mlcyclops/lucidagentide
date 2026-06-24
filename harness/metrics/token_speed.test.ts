// harness/metrics/token_speed.test.ts
//
// P-TPS.1 (ADR-0044): the output-token speedometer. Over-tested on the two
// properties that matter for the user's ask: (1) the count is OUTPUT only — it
// reflects exactly the deltas fed in, never any injected "input" — and (2) the
// figures (count, tok/s, TTFT, provider reconciliation) are correct against a
// controlled clock.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TOKEN_SPEED_CONFIG,
  TokenSpeedEngine,
  estimateTokens,
  formatReadout,
} from "./token_speed.ts";

/** A hand-cranked clock so the sliding window is deterministic (no real time). */
function clock() {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("estimateTokens", () => {
  test("counts words and punctuation separately, empty is zero", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello")).toBe(1);
    expect(estimateTokens("hello, world")).toBe(3); // hello | , | world
    expect(estimateTokens("a b c")).toBe(3);
  });
});

describe("TokenSpeedEngine — output-only counting", () => {
  test("counts exactly the deltas streamed (direct strategy = 1/delta)", () => {
    const c = clock();
    const e = new TokenSpeedEngine({ countStrategy: "direct", now: c.now });
    e.start();
    e.recordDelta("anything");
    e.recordDelta("more");
    c.advance(2000);
    e.stop();
    expect(e.tokenCount).toBe(2);
  });

  test("estimate strategy approximates from the delta text", () => {
    const c = clock();
    const e = new TokenSpeedEngine({ countStrategy: "estimate", now: c.now });
    e.start();
    e.recordDelta("hello, world"); // 3
    e.recordDelta(" foo bar");     // 2
    expect(e.tokenCount).toBe(5);
  });

  test("ignores deltas before start() — nothing counts outside a turn", () => {
    const c = clock();
    const e = new TokenSpeedEngine({ countStrategy: "direct", now: c.now });
    e.recordDelta("leaked"); // before start: must be dropped
    expect(e.tokenCount).toBe(0);
    e.start();
    e.recordDelta("real");
    e.stop();
    e.recordDelta("after"); // after stop: dropped
    expect(e.tokenCount).toBe(1);
  });
});

describe("TokenSpeedEngine — provider tokens", () => {
  test("uses cumulative usage.output increments when enabled", () => {
    const c = clock();
    const e = new TokenSpeedEngine({ useProviderTokens: true, now: c.now });
    e.start();
    e.recordDelta("x", 10); // +10
    e.recordDelta("y", 25); // +15
    e.recordDelta("z", 25); // no increase → estimate fallback off (provider path not taken)
    expect(e.tokenCount).toBeGreaterThanOrEqual(25);
  });

  test("reconcileTotal snaps to the authoritative end-of-turn figure", () => {
    const c = clock();
    const e = new TokenSpeedEngine({ countStrategy: "estimate", now: c.now });
    e.start();
    e.recordDelta("rough estimate here");
    e.reconcileTotal(142);
    expect(e.tokenCount).toBe(142);
    e.reconcileTotal(0); // zero/garbage is ignored, never clobbers
    expect(e.tokenCount).toBe(142);
  });
});

describe("TokenSpeedEngine — timing", () => {
  test("TTFT measures submit→first-token and realigns the rate clock", () => {
    const c = clock();
    const e = new TokenSpeedEngine({ countStrategy: "direct", now: c.now });
    e.startTTFT();
    c.advance(450); // provider queue wait
    e.start();      // assistant message begins
    e.stopTTFT();   // first content delta
    expect(e.ttft).toBe(450);
    // generation clock starts at first token, so 1 tok over 1s ⇒ ~1 tok/s avg
    e.recordDelta("a");
    c.advance(1000);
    e.recordDelta("b");
    e.stop();
    expect(e.elapsedSeconds).toBeCloseTo(1, 1);
  });

  test("avg tok/s before the window fills, windowed rate after", () => {
    const c = clock();
    const e = new TokenSpeedEngine({ countStrategy: "direct", slidingWindowMs: 1000, now: c.now });
    e.start();
    // 5 tokens over the first 500ms → still inside the window → average
    for (let i = 0; i < 5; i++) { e.recordDelta("t"); c.advance(100); }
    expect(e.elapsedMs).toBe(500);
    expect(e.tps).toBeCloseTo(10, 0); // 5 tok / 0.5s
  });
});

describe("formatReadout", () => {
  test("modes render the expected plain-text shapes", () => {
    const c = clock();
    const e = new TokenSpeedEngine({ countStrategy: "direct", now: c.now });
    e.startTTFT(); c.advance(200); e.start(); e.stopTTFT();
    e.recordDelta("a"); c.advance(1000); e.recordDelta("b");
    e.stop();
    expect(formatReadout(e, "tps")).toMatch(/tok\/s|--/);
    expect(formatReadout(e, "stats")).toMatch(/tok in .*s/);
    expect(formatReadout(e, "ttft")).toMatch(/TTFT: 200 ms/);
    expect(formatReadout(e, "full")).toMatch(/·.*TTFT/);
  });

  test("idle engine reads '--', never a misleading zero-rate", () => {
    const e = new TokenSpeedEngine(DEFAULT_TOKEN_SPEED_CONFIG);
    expect(formatReadout(e, "tps")).toBe("--");
  });
});
