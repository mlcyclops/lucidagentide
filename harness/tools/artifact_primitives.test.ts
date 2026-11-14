// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-CAP.1a (ADR-0589): find, lookup, count and slice over a stored tool result.

import { describe, expect, test } from "bun:test";

import { buildMatcher, countIn, findIn, lookupIn, parseHandle, PRIM_LIMITS, primHeader, runPrim, sliceOf, splitLines, tokenHits } from "./artifact_primitives.ts";

/** A haystack of about `chars` characters: numbered filler lines, with needles planted at known lines. */
function haystack(chars: number, needles: Record<number, string> = {}): { text: string; lines: number } {
  const out: string[] = [];
  let size = 0;
  for (let i = 1; size < chars; i++) {
    const line = needles[i] ?? `[record ${i}] status ok region r${i % 7} latency ${(i * 37) % 900}ms`;
    out.push(line);
    size += line.length + 1;
  }
  return { text: out.join("\n"), lines: out.length };
}
const text = (r: { ok: boolean; text?: string; error?: string }): string => (r.ok ? r.text! : `ERROR ${r.error}`);
const SIZES: [string, number][] = [["8K", 8_000], ["64K", 64_000], ["512K", 512_000]];

describe("parseHandle and splitLines", () => {
  test("only artifact://<number> is a handle", () => {
    expect(parseHandle("artifact://12")).toBe("12");
    expect(parseHandle("  artifact://0 ")).toBe("0");
    for (const bad of ["12", 12, "artifact://", "artifact://x", "artifact://1:5-9", "artifact://-1", "ARTIFACT://1", "/tmp/artifacts/1.read.log", "artifact://1 artifact://2", null, undefined, {}, "artifact://1234567890"]) expect(parseHandle(bad)).toBeNull();
  });
  test("lines: a trailing newline is not an empty line, and CRLF is one break", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([""]);
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
  });
});

describe("artifact_find", () => {
  for (const [label, chars] of SIZES) {
    test(`${label}: a needle in the middle is found with its exact line number`, () => {
      const probe = haystack(chars);
      const at = Math.floor(probe.lines / 2);
      const h = haystack(chars, { [at]: "The deploy token rotation failed for cluster blue-9" });
      const r = text(findIn(splitLines(h.text), { pattern: "rotation failed" }));
      expect(r).toContain(`1 of ${h.lines.toLocaleString("en-US")} lines match "rotation failed"`);
      expect(r).toContain(`L${at}: The deploy token rotation failed for cluster blue-9`);
      expect(r.length).toBeLessThan(400); // the artifact's size never reaches the result
    });
  }
  test("nothing matches: it says NOT FOUND, never an empty success", () => {
    const r = findIn(splitLines(haystack(8000).text), { pattern: "no such thing" });
    expect(r.ok).toBe(true);
    expect(text(r)).toStartWith("NOT FOUND: no line of ");
  });
  test("context lines are numbered and marked, and overlapping windows are not repeated", () => {
    const lines = ["a", "b", "HIT one", "c", "HIT two", "d", "e", "f", "g", "HIT three"];
    expect(text(findIn(lines, { pattern: "HIT", context: 1 }))).toBe([
      '3 of 10 lines match "HIT". Showing matches 1 to 3.',
      "L2| b", "L3: HIT one", "L4| c", "L5: HIT two", "L6| d", "--", "L9| g", "L10: HIT three",
    ].join("\n"));
  });
  test("paging: limit and offset walk every match once", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `row ${i + 1} X`);
    const first = text(findIn(lines, { pattern: "X", limit: 30 }));
    expect(first).toContain("Showing matches 1 to 30.");
    expect(first).toContain("70 more matching lines: call again with offset 30.");
    const last = text(findIn(lines, { pattern: "X", limit: 40, offset: 90 }));
    expect(last).toContain("Showing matches 91 to 100.");
    expect(last).not.toContain("more matching lines");
    expect(text(findIn(lines, { pattern: "X", offset: 500 }))).toBe('100 lines match "X", and offset 500 is past the last one.');
    expect(text(findIn(lines, { pattern: "X", limit: 9999 })).split("\n").length).toBe(PRIM_LIMITS.matches + 2);
  });
  test("literal by default: regex characters mean themselves", () => {
    const lines = ["cost is $5.00 (est.)", "cost is 5x00"];
    expect(text(findIn(lines, { pattern: "$5.00 (est.)" }))).toContain("1 of 2 lines");
    expect(text(findIn(lines, { pattern: "5.00", regex: true }))).toContain("2 of 2 lines");
  });
  test("case: exact unless asked", () => {
    const lines = ["Error: disk", "error: net"];
    expect(text(findIn(lines, { pattern: "error" }))).toContain("1 of 2");
    expect(text(findIn(lines, { pattern: "error", ignoreCase: true }))).toContain("2 of 2");
    expect(text(findIn(lines, { pattern: "^error", regex: true, ignoreCase: true }))).toContain("2 of 2");
  });
  test("a very long line is shown as an excerpt around the match, with its column", () => {
    const line = `${"a".repeat(5000)}NEEDLE${"b".repeat(5000)}`;
    const r = text(findIn(["short", line], { pattern: "NEEDLE" }));
    expect(r).toContain("L2:C5001: [...]");
    expect(r).toContain("NEEDLE");
    expect(r.length).toBeLessThan(500);
  });
  test("the whole result is bounded even when every line matches and is long", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `${i} ${"x".repeat(2000)}`);
    expect(text(findIn(lines, { pattern: "x", context: 5 })).length).toBeLessThan(PRIM_LIMITS.out + 120);
  });
});

describe("a pattern is hostile input", () => {
  test("empty, over-long, multi-line and invalid patterns are refused with the reason", () => {
    expect(buildMatcher({})).toEqual({ ok: false, error: "a pattern is required" });
    expect(buildMatcher({ pattern: 7 })).toEqual({ ok: false, error: "a pattern is required" });
    expect((buildMatcher({ pattern: "x".repeat(PRIM_LIMITS.pattern + 1) }) as { error: string }).error).toContain("the limit is 300");
    expect((buildMatcher({ pattern: "a\nb" }) as { error: string }).error).toContain("cannot contain a line break");
    expect((buildMatcher({ pattern: "(unclosed", regex: true }) as { error: string }).error).toContain("not valid");
    expect(buildMatcher({ pattern: "(unclosed" }).ok).toBe(true); // literal: fine
  });
  test("a regex sees only a bounded prefix of a line, so one huge line cannot be used to stall it", () => {
    const line = `${"a".repeat(PRIM_LIMITS.regexLine + 500)}TAIL`;
    expect(text(findIn([line], { pattern: "TAIL", regex: true }))).toStartWith("NOT FOUND");
    expect(text(findIn([line], { pattern: "TAIL" }))).toContain("1 of 1"); // the literal search reads the whole line
  });
  test("an empty regex match still advances", () => {
    expect(text(countIn(["abc"], { pattern: "x*", regex: true }))).toContain("occurrences");
  });
  test("the time budget stops a search that runs long, with an error, not a partial answer", () => {
    let t = 0;
    const slow = (): number => { t += 1500; return t; };
    const lines = Array.from({ length: 5000 }, (_, i) => `row ${i}`);
    for (const r of [findIn(lines, { pattern: "row" }, slow), countIn(lines, { pattern: "row" }, slow), lookupIn(lines, { keys: ["row"] }, slow)]) {
      expect(r.ok).toBe(false);
      expect(text(r)).toContain("took too long");
    }
  });
});

describe("artifact_lookup", () => {
  for (const [label, chars] of SIZES) {
    test(`${label}: eight keys scattered through the artifact are all found in one pass, and a ninth is reported missing`, () => {
      const probe = haystack(chars);
      const keys = ["amber-fox", "blue-kite", "coral-ant", "dune-owl", "ember-yak", "fern-eel", "gold-bat", "hazel-elk"];
      const needles: Record<number, string> = {};
      keys.forEach((k, i) => { needles[Math.floor(((i + 1) * probe.lines) / (keys.length + 1))] = `One of the special magic numbers for ${k} is: ${1000 + i * 111}.`; });
      const h = haystack(chars, needles);
      const r = text(lookupIn(splitLines(h.text), { keys: [...keys, "ivory-cod"] }));
      expect(r).toStartWith("8 of 9 keys found.");
      keys.forEach((k, i) => {
        const line = Math.floor(((i + 1) * probe.lines) / (keys.length + 1));
        expect(r).toContain(`key "${k}": 1 record\nL${line}: One of the special magic numbers for ${k} is: ${1000 + i * 111}.`);
      });
      expect(r).toContain(`key "ivory-cod": NOT FOUND in ${h.lines.toLocaleString("en-US")} lines.`);
      expect(r.length).toBeLessThan(1600);
    });
  }
  test("a key matches only as a whole token", () => {
    expect(tokenHits("for alpha-7 is 1", "alpha-7")).toEqual([4]);
    expect(tokenHits("alpha-77 x-alpha-7 alpha-7b alpha-7_x", "alpha-7")).toEqual([]);
    expect(tokenHits('{"id":"alpha-7","v":1}', "alpha-7")).toEqual([7]);
    expect(tokenHits("alpha-7,alpha-7;alpha-7.", "alpha-7")).toEqual([0, 8, 16]);
    expect(tokenHits("id=42 uid=142 id=420", "42")).toEqual([3]);
    const r = text(lookupIn(["user 42 ok", "user 142 ok", "user 420 ok"], { keys: ["42"] }));
    expect(r).toContain('key "42": 1 record\nL1: user 42 ok');
  });
  test("many records for one key: the count is exact and the first few are shown", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `evt ${i} host web-1`);
    const r = text(lookupIn(lines, { keys: ["web-1"] }));
    expect(r).toContain(`key "web-1": 50 records (first ${PRIM_LIMITS.perKey} shown)`);
    expect(r.split("\n").length).toBe(2 + PRIM_LIMITS.perKey);
  });
  test("keys are validated: none, too many, empty, multi-line, over-long", () => {
    const err = (keys: unknown): string => text(lookupIn(["x"], { keys }));
    expect(err([])).toContain("at least one key is required");
    expect(err(undefined)).toContain("at least one key is required");
    expect(err(Array.from({ length: PRIM_LIMITS.keys + 1 }, (_, i) => `k${i}`))).toContain("the limit is 20");
    expect(err(["ok", " "])).toContain("non-empty single line");
    expect(err(["a\nb"])).toContain("non-empty single line");
    expect(err(["x".repeat(PRIM_LIMITS.key + 1)])).toContain("the limit is 200");
    expect(text(lookupIn(["id 7"], { keys: "7" }))).toContain("1 of 1 keys found."); // one key as a plain string
    expect(text(lookupIn(["id 7"], { keys: ["7", "7"] }))).toContain("1 of 1 keys found."); // duplicates collapse
  });
});

describe("artifact_count", () => {
  for (const [label, chars] of SIZES) {
    test(`${label}: the count matches a count made by hand`, () => {
      const h = haystack(chars);
      const lines = splitLines(h.text);
      const want = lines.filter((l) => l.includes("region r3")).length;
      const r = text(countIn(lines, { pattern: "region r3" }));
      expect(r).toStartWith(`${want.toLocaleString("en-US")} occurrences of "region r3" on ${want.toLocaleString("en-US")} of ${h.lines.toLocaleString("en-US")} lines`);
    });
  }
  test("occurrences and lines are counted separately, with the first and last line", () => {
    expect(text(countIn(["a a a", "b", "a"], { pattern: "a" }))).toBe('4 occurrences of "a" on 2 of 3 lines (first on L1, last on L3).');
    expect(text(countIn(["b"], { pattern: "a" }))).toBe('0: nothing in 1 lines matches "a".');
  });
  test("distinct: the capture group's values, most frequent first, ties in order", () => {
    const lines = ["code=E1 x", "code=E2 x", "code=E1 y", "code=E3", "code=E1"];
    expect(text(countIn(lines, { pattern: "code=(E\\d)", regex: true, distinct: true }))).toBe([
      "5 occurrences of regex /code=(E\\d)/ on 5 of 5 lines (first on L1, last on L5).",
      "3 distinct values:", "3x E1", "1x E2", "1x E3",
    ].join("\n"));
  });
  test("distinct values are bounded in the listing", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `id=${i}`);
    const r = text(countIn(lines, { pattern: "id=(\\d+)", regex: true, distinct: true }));
    expect(r).toContain(`300 distinct values (top ${PRIM_LIMITS.distinct} shown):`);
    expect(r.split("\n").length).toBe(2 + PRIM_LIMITS.distinct);
  });
});

describe("artifact_slice", () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `row ${i + 1}`);
  test("an inclusive range, each line with its number", () => {
    expect(text(sliceOf(lines, { from: 498, to: 501 }))).toBe("Lines 498 to 501 of 1,000.\nL498: row 498\nL499: row 499\nL500: row 500\nL501: row 501");
  });
  test("to defaults to forty lines, and the end of the artifact is the end", () => {
    expect(text(sliceOf(lines, { from: 1 })).split("\n").length).toBe(41);
    expect(text(sliceOf(lines, { from: 998, to: 5000 }))).toBe("Lines 998 to 1,000 of 1,000.\nL998: row 998\nL999: row 999\nL1000: row 1000");
  });
  test("a range over the limit is cut, and says where to continue", () => {
    const r = text(sliceOf(lines, { from: 1, to: 900 }));
    expect(r).toStartWith(`Lines 1 to ${PRIM_LIMITS.slice} of 1,000.`);
    expect(r).toContain(`500 more lines were asked for: call again with from ${PRIM_LIMITS.slice + 1}`);
  });
  test("out of range is an error that states the real range", () => {
    expect(text(sliceOf(lines, { from: 0 }))).toContain("the artifact has lines 1 to 1,000");
    expect(text(sliceOf(lines, { from: 1001 }))).toContain("the artifact has lines 1 to 1,000");
    expect(text(sliceOf(lines, { from: 10, to: 5 }))).toContain("to (5) is before from (10)");
    expect(text(sliceOf(lines, {}))).toContain("from is required");
    expect(text(sliceOf(lines, { from: "3" }))).toContain("from is required");
  });
});

describe("record identity, and determinism", () => {
  test("a line number from find is the line slice returns, at every size", () => {
    for (const [, chars] of SIZES) {
      const probe = haystack(chars);
      const at = probe.lines - 3;
      const h = haystack(chars, { [at]: "UNIQUE-MARKER-771" });
      const lines = splitLines(h.text);
      const found = /L(\d+): UNIQUE-MARKER-771/.exec(text(findIn(lines, { pattern: "UNIQUE-MARKER-771" })))![1]!;
      expect(Number(found)).toBe(at);
      expect(text(sliceOf(lines, { from: Number(found), to: Number(found) }))).toContain(`L${at}: UNIQUE-MARKER-771`);
      expect(/L(\d+): UNIQUE-MARKER-771/.exec(text(lookupIn(lines, { keys: ["UNIQUE-MARKER-771"] })))![1]).toBe(found);
    }
  });
  test("the same call twice gives the same bytes", () => {
    const h = haystack(64_000);
    for (const [name, params] of [["artifact_find", { pattern: "region r3", context: 2 }], ["artifact_lookup", { keys: ["r3", "nope"] }], ["artifact_count", { pattern: "r(\\d)", regex: true, distinct: true }], ["artifact_slice", { from: 5, to: 9 }]] as const) {
      expect(runPrim(name, h.text, params)).toEqual(runPrim(name, h.text, params));
    }
  });
  test("the header names the artifact, its size, its source and its trust label", () => {
    expect(primHeader("3", "a\nb\nc", "mcp:github", "untrusted")).toBe("artifact://3: 3 lines, 5 characters. Source: mcp:github. Trust: untrusted.");
  });
});
