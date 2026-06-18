// harness/memory/sanitize.test.ts

import { test, expect } from "bun:test";
import { sanitize, policyLabel, DEFAULT_SANITIZE_POLICY } from "./sanitize.ts";

const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const TAG = String.fromCodePoint(0xe0041);
const CYR_E = String.fromCodePoint(0x0435);
const PUA = String.fromCodePoint(0xe000);

test("strips zero-width, tag-block, and bidi controls", () => {
  const out = sanitize(`a${ZWSP}b${RLO}c${TAG}d`);
  expect(out.sanitized).toBe("abcd");
  expect(out.changed).toBe(true);
});

test("leaves clean text untouched (changed=false)", () => {
  const out = sanitize("normal text 123, café");
  expect(out.sanitized).toBe("normal text 123, café");
  expect(out.changed).toBe(false);
});

test("homoglyphs are flagged-not-stripped: Cyrillic char survives sanitation", () => {
  const out = sanitize(`${CYR_E}dit_file`);
  expect(out.sanitized).toBe(`${CYR_E}dit_file`);
  expect(out.changed).toBe(false);
});

test("private-use-area is left in place by default (flagged, not stripped)", () => {
  const out = sanitize(`x${PUA}y`);
  expect(out.sanitized).toBe(`x${PUA}y`);
});

test("NFKC normalization folds compatibility forms", () => {
  // fullwidth 'Ａ' (U+FF21) -> 'A' under NFKC
  const out = sanitize("ＡBC");
  expect(out.sanitized).toBe("ABC");
  expect(out.changed).toBe(true);
});

test("policy can disable stripping", () => {
  const out = sanitize(`a${ZWSP}b`, { ...DEFAULT_SANITIZE_POLICY, stripZeroWidth: false });
  expect(out.sanitized).toBe(`a${ZWSP}b`);
});

test("policyLabel describes the active policy", () => {
  expect(policyLabel()).toBe("NFKC+strip(zero-width,tag,bidi)");
});
