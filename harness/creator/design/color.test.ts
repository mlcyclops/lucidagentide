// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { isHexColor, namedColor, normalizeColor, parseColor, toHex } from "./color.ts";

describe("parseColor", () => {
  test("accepts the hex and rgb()/rgba() forms", () => {
    expect(parseColor("#f00")).toEqual([255, 0, 0, 255]);
    expect(parseColor("#f008")).toEqual([255, 0, 0, 136]);
    expect(parseColor("#12AbEf")).toEqual([0x12, 0xab, 0xef, 255]);
    expect(parseColor("#12abef80")).toEqual([0x12, 0xab, 0xef, 0x80]);
    expect(parseColor(" rgb(1, 2, 3) ")).toEqual([1, 2, 3, 255]);
    expect(parseColor("RGBA(10,20,30,0.5)")).toEqual([10, 20, 30, 128]);
    expect(parseColor("rgb(100% 0% 50% / 25%)")).toEqual([255, 0, 128, 64]);
    expect(parseColor("rgb(300, -5, 2.6)")).toEqual([255, 0, 3, 255]);
  });

  test("refuses everything else", () => {
    for (const s of [
      "red", "transparent", "#12", "#12345", "#1234567", "#ggg", "rgb(1,2)", "rgb(1,2,3,4,5)", "rgb(1,2,3,)",
      "rgb(1 2,3)", "rgb(1,2,3", "hsl(0,0%,0%)", "url(#a)", "url(javascript:alert(1))", "var(--x)",
      "rgb(1e999,0,0)", "rgb(1,2,3) x", "", `#${"f".repeat(100)}`, "rgb(1 / 2 3)",
    ]) {
      expect(parseColor(s)).toBeNull();
    }
  });

  test("named colors are a separate lookup, never accepted by parseColor", () => {
    expect(namedColor("White")).toEqual([255, 255, 255, 255]);
    expect(namedColor(" rebeccapurple ")).toEqual([0x66, 0x33, 0x99, 255]);
    expect(namedColor("transparent")).toEqual([0, 0, 0, 0]);
    for (const s of ["constructor", "__proto__", "redd", "url(#a)", ""]) expect(namedColor(s)).toBeNull();
    expect(parseColor("white")).toBeNull();
  });

  test("normalizes to lowercase #rrggbb or #rrggbbaa", () => {
    expect(normalizeColor("#ABC")).toBe("#aabbcc");
    expect(normalizeColor("rgba(255,255,255,0)")).toBe("#ffffff00");
    expect(normalizeColor(42)).toBeNull();
    expect(toHex([255, 128, 0])).toBe("#ff8000");
    expect(toHex([1.4, 2.6, 300, 255])).toBe("#0103ff");
    expect(isHexColor("#a1b2c3")).toBe(true);
    expect(isHexColor("#a1b2c3d4")).toBe(true);
    expect(isHexColor("#abc")).toBe(false);
    expect(isHexColor("rgb(0,0,0)")).toBe(false);
  });
});
