// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/ctxmenu.test.ts — P-SECACK.1 (ADR-0170): the clipboard-menu contract and the
// text-splice math the paste/cut actions run on the prompt bar.

import { describe, expect, test } from "bun:test";
import { menuItemsFor, spliceText } from "./ctxmenu.ts";

describe("menuItemsFor — which entries are actionable", () => {
  test("selection in an editable field → everything enabled", () => {
    const on = menuItemsFor({ editable: true, hasSelection: true });
    expect(on.map((i) => [i.act, i.enabled])).toEqual([["cut", true], ["copy", true], ["paste", true], ["selectall", true]]);
  });

  test("no selection → cut/copy disabled, paste + select-all stay", () => {
    const items = menuItemsFor({ editable: true, hasSelection: false });
    expect(items.find((i) => i.act === "cut")?.enabled).toBe(false);
    expect(items.find((i) => i.act === "copy")?.enabled).toBe(false);
    expect(items.find((i) => i.act === "paste")?.enabled).toBe(true);
    expect(items.find((i) => i.act === "selectall")?.enabled).toBe(true);
  });

  test("password field → cut/copy NEVER enabled even with a selection (paste still works)", () => {
    const items = menuItemsFor({ editable: true, hasSelection: true, secret: true });
    expect(items.find((i) => i.act === "cut")?.enabled).toBe(false);
    expect(items.find((i) => i.act === "copy")?.enabled).toBe(false);
    expect(items.find((i) => i.act === "paste")?.enabled).toBe(true);
  });
});

describe("spliceText — the paste/cut math", () => {
  test("insert at caret (collapsed selection)", () => {
    expect(spliceText("hello world", 5, 5, ",")).toEqual({ value: "hello, world", caret: 6 });
  });
  test("replace a selection", () => {
    expect(spliceText("hello world", 6, 11, "there")).toEqual({ value: "hello there", caret: 11 });
  });
  test("delete a selection (cut)", () => {
    expect(spliceText("hello world", 5, 11, "")).toEqual({ value: "hello", caret: 5 });
  });
  test("reversed and out-of-range offsets are clamped, never a throw / corruption", () => {
    expect(spliceText("abc", 2, 1, "X")).toEqual({ value: "aXc", caret: 2 }); // reversed → normalized
    expect(spliceText("abc", -5, 99, "X")).toEqual({ value: "X", caret: 1 }); // clamped to the whole value
    expect(spliceText("abc", NaN, NaN, "X")).toEqual({ value: "Xabc", caret: 1 }); // NaN → start
  });
  test("empty value + empty insert stays sane", () => {
    expect(spliceText("", 0, 0, "")).toEqual({ value: "", caret: 0 });
  });
});
