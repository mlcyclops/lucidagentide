// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TIP.1 (ADR-0599): the data-tip text format round-trips titles and bodies that contain pipes.
import { describe, expect, test } from "bun:test";
import { parseTip, tipEsc, tipValue } from "./tip_text.ts";

describe("tip text", () => {
  test("a bare value is a body with no title", () => {
    expect(parseTip("Edit this file")).toEqual({ title: "", desc: "Edit this file" });
  });
  test("the first pipe separates title from body", () => {
    expect(parseTip("Ask Lucid|A side conversation")).toEqual({ title: "Ask Lucid", desc: "A side conversation" });
  });
  test("a later pipe stays in the body instead of truncating it", () => {
    expect(parseTip("T|a|b")).toEqual({ title: "T", desc: "a|b" });
  });
  test("an escaped pipe is literal text", () => {
    expect(tipEsc("a|b")).toBe("a\\|b");
    expect(parseTip(tipEsc("a|b"))).toEqual({ title: "", desc: "a|b" });
  });
  test("tipValue round-trips titles and bodies with pipes", () => {
    expect(parseTip(tipValue("x|y", "p|q"))).toEqual({ title: "x|y", desc: "p|q" });
    expect(parseTip(tipValue("only|one"))).toEqual({ title: "", desc: "only|one" });
    expect(tipValue("Label", "")).toBe("Label");
    expect(tipValue("")).toBe("");
  });
  test("backslashes that do not guard a pipe are untouched (Windows paths)", () => {
    expect(parseTip(tipValue("C:\\Users\\me\\repo"))).toEqual({ title: "", desc: "C:\\Users\\me\\repo" });
  });
});
