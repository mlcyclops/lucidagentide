// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { cachedRuntimeCurrent, parsePins, satisfiesMinimum } from "./runtime_pin.ts";

const OLD = "a".repeat(64);
const NEW = "b".repeat(64);

describe("a cached runtime is reused only when it came from the current pin (issue #598)", () => {
  test("the 1.4.2 to 1.4.4 case: a runtime recorded under the old pin is fetched again", () => {
    expect(cachedRuntimeCurrent(true, { "bun-win32-x64.exe": OLD }, "bun-win32-x64.exe", NEW)).toBe(false);
  });
  test("a runtime with no record (fetched before the check existed) is fetched again", () => {
    expect(cachedRuntimeCurrent(true, {}, "bun-win32-x64.exe", NEW)).toBe(false);
  });
  test("a runtime recorded under the current pin is reused", () => {
    expect(cachedRuntimeCurrent(true, { "bun-win32-x64.exe": NEW }, "bun-win32-x64.exe", NEW)).toBe(true);
  });
  test("a record without the file, or a spec with no pin, never counts as cached", () => {
    expect(cachedRuntimeCurrent(false, { "bun-win32-x64.exe": NEW }, "bun-win32-x64.exe", NEW)).toBe(false);
    expect(cachedRuntimeCurrent(true, { "bun-win32-x64.exe": "" }, "bun-win32-x64.exe", "")).toBe(false);
  });
  test("an unreadable or off-shape record reads as nothing recorded", () => {
    expect(parsePins(null)).toEqual({});
    expect(parsePins("not json")).toEqual({});
    expect(parsePins("[1,2]")).toEqual({});
    expect(parsePins(JSON.stringify({ ok: NEW, short: "abc", upper: "A".repeat(64), num: 5 }))).toEqual({ ok: NEW });
  });
});

describe("the bundled Bun must satisfy omp's engines.bun", () => {
  test("1.4.2 is refused under >=1.4.4; 1.4.4 and later pass", () => {
    expect(satisfiesMinimum("1.4.2", ">=1.4.4")).toBe(false);
    expect(satisfiesMinimum("1.4.4", ">=1.4.4")).toBe(true);
    expect(satisfiesMinimum("1.5.0", ">=1.4.4")).toBe(true);
    expect(satisfiesMinimum("2.0.0", ">= 1.4.4")).toBe(true);
    expect(satisfiesMinimum("1.3.99", ">=1.4.4")).toBe(false);
  });
  test("a version or range it does not understand fails closed", () => {
    expect(satisfiesMinimum("garbage", ">=1.4.4")).toBe(false);
    expect(satisfiesMinimum("1.4.4", "^1.4.4")).toBe(false);
    expect(satisfiesMinimum("1.4.4", "")).toBe(false);
  });
});
