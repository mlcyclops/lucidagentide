// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/tools/output_minify_proto.test.ts — PROTOTYPE tests. Behavior, not plumbing:
// the invariants that make the passes safe (order-preserving, unique-preserving,
// ReDoS-safe, strip-before-dedup synergy), plus the token math.

import { test, expect } from "bun:test";
import {
  stripAnsi,
  dedupConsecutive,
  minify,
  estimateTokens,
} from "./output_minify_proto.ts";

const ESC = "\x1b";

test("stripAnsi removes CSI color codes but keeps the text", () => {
  const colored = `${ESC}[33mabc1234${ESC}[m commit message`;
  expect(stripAnsi(colored)).toBe("abc1234 commit message");
});

test("stripAnsi removes OSC (window-title) sequences, both BEL and ST terminated", () => {
  expect(stripAnsi(`${ESC}]0;my title\x07keep`)).toBe("keep");
  expect(stripAnsi(`${ESC}]0;t${ESC}\\keep`)).toBe("keep");
});

test("stripAnsi fast-paths clean text unchanged (referential no-op)", () => {
  const clean = "no escapes here\nline two";
  expect(stripAnsi(clean)).toBe(clean);
});

test("stripAnsi is linear on adversarial input — many bare ESC[ do not hang", () => {
  // A pathological string that a backtracking pattern could choke on.
  const evil = `${ESC}[`.repeat(50_000) + "x";
  const start = performance.now();
  const out = stripAnsi(evil);
  const ms = performance.now() - start;
  // Unterminated CSI (no final byte) is left as-is; the point is it returns fast.
  expect(out.length).toBeGreaterThan(0);
  expect(ms).toBeLessThan(500);
});

test("dedupConsecutive collapses adjacent identical lines with a count", () => {
  const r = dedupConsecutive("warn: x\nwarn: x\nwarn: x\ndone");
  expect(r.text).toBe("warn: x (x3)\ndone");
  expect(r.linesRemoved).toBe(2);
});

test("dedupConsecutive is ORDER-PRESERVING — non-adjacent duplicates stay separate", () => {
  const r = dedupConsecutive("a\nb\na");
  expect(r.text).toBe("a\nb\na");
  expect(r.linesRemoved).toBe(0);
});

test("dedupConsecutive never drops a unique line", () => {
  const r = dedupConsecutive("one\ntwo\ntwo\nthree");
  expect(r.text).toBe("one\ntwo (x2)\nthree");
});

test("dedupConsecutive normalizes CRLF so Windows output dedups too", () => {
  const r = dedupConsecutive("row\r\nrow\r\nrow\r\n");
  expect(r.text).toBe("row (x3)\n");
});

test("dedupConsecutive collapses trailing blank-line runs", () => {
  const r = dedupConsecutive("text\n\n\n\n");
  // 4 "\n" => ["text","","","",""]; the 4 empties collapse.
  expect(r.text).toBe("text\n (x4)");
});

test("minify: strip-before-dedup synergy — lines equal only after ANSI strip collapse", () => {
  // Two progress lines identical except for the color code around the percentage.
  const raw = `${ESC}[32mBuilding...${ESC}[m\n${ESC}[31mBuilding...${ESC}[m`;
  const { text, stats } = minify(raw);
  expect(text).toBe("Building... (x2)");
  expect(stats.linesRemoved).toBe(1);
  expect(stats.tokensSaved).toBeGreaterThan(0);
});

test("estimateTokens matches rtk ceil(chars/4)", () => {
  expect(estimateTokens("")).toBe(0);
  expect(estimateTokens("abcd")).toBe(1);
  expect(estimateTokens("abcde")).toBe(2);
});

test("minify pctSaved is 0 for empty input (no divide-by-zero)", () => {
  expect(minify("").stats.pctSaved).toBe(0);
});

test("minify leaves already-compact unique output essentially unchanged", () => {
  const compact = "line1\nline2\nline3";
  const { text, stats } = minify(compact);
  expect(text).toBe(compact);
  expect(stats.tokensSaved).toBe(0);
});
