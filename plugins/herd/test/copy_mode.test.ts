// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535; P-HERD.3, ADR-0492 item 5): copy mode over a frozen pane. What is yanked is exactly
// what was selected on screen, the cursor never leaves the text, search wraps and says when nothing
// matched, and a yank becomes OSC 52 bytes the terminal puts on its clipboard.

import { describe, expect, test } from "bun:test";
import { clipboardCommand, CopyMode, osc52 } from "../src/copy_mode.ts";

const TEXT = ["first line here", "", "› hello herd", "  the reply   "];

describe("copy mode", () => {
  test("starts on the last line; y with no selection yanks that line without its trailing blanks", () => {
    const c = new CopyMode("s1:p1", "agent", TEXT);
    expect(c.cursor).toEqual({ row: 3, col: 0 });
    expect(c.feed("y", 10)).toEqual({ kind: "yank", text: "  the reply" });
  });

  test("v then movement selects across lines, inclusive of the cursor", () => {
    const c = new CopyMode("s1:p1", "agent", TEXT);
    c.feed("g", 10);
    c.feed("w", 10); // "line"
    c.feed("v", 10);
    c.feed("j", 10); // the blank line clamps the column
    c.feed("j", 10);
    c.feed("$", 10);
    expect(c.feed("\r", 10)).toEqual({ kind: "yank", text: "line here\n\n› hello herd" });
  });

  test("the cursor stays inside the text", () => {
    const c = new CopyMode("s1:p1", "x", TEXT);
    for (let i = 0; i < 10; i++) c.feed("j", 10);
    expect(c.cursor.row).toBe(3);
    for (let i = 0; i < 40; i++) c.feed("l", 10);
    expect(c.cursor.col).toBe(Array.from(TEXT[3]!).length - 1);
    c.feed("k", 10); // onto "› hello herd": the column clamps to that line
    expect(c.cursor.col).toBe(Array.from(TEXT[2]!).length - 1);
    c.feed("g", 10);
    for (let i = 0; i < 5; i++) c.feed("h", 10);
    expect(c.cursor).toEqual({ row: 0, col: 0 });
  });

  test("search finds forward and back, wrapping, and says when nothing matches", () => {
    const c = new CopyMode("s1:p1", "x", TEXT);
    c.feed("g", 10);
    for (const k of ["/", "H", "e", "r", "d", "\r"]) c.feed(k, 10);
    expect(c.cursor).toEqual({ row: 2, col: 8 });
    c.feed("n", 10); // wraps to the same (only) match
    expect(c.cursor).toEqual({ row: 2, col: 8 });
    for (const k of ["/", "l", "i", "n", "e", "\r"]) c.feed(k, 10);
    expect(c.cursor).toEqual({ row: 0, col: 6 }); // wrapped past the end to the top
    for (const k of ["/", "z", "z", "z", "\r"]) c.feed(k, 10);
    expect(c.note).toBe('no match for "zzz"');
    expect(c.cursor).toEqual({ row: 0, col: 6 });
  });

  test("esc drops a selection first, then leaves; q leaves at once", () => {
    const c = new CopyMode("s1:p1", "x", TEXT);
    c.feed("v", 10);
    expect(c.feed("\x1b", 10)).toEqual({ kind: "none" });
    expect(c.anchor).toBeNull();
    expect(c.feed("\x1b", 10)).toEqual({ kind: "exit" });
    expect(new CopyMode("s1:p1", "x", TEXT).feed("q", 10)).toEqual({ kind: "exit" });
  });

  test("the view scrolls to keep the cursor on screen and marks the selection", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `row ${i}`);
    const c = new CopyMode("s1:p1", "x", lines);
    let view = c.view(10);
    expect(view.map((r) => r.text)).toEqual(lines.slice(40));
    expect(view.at(-1)!.cursor).toBe(0);
    c.feed("v", 10);
    c.feed("k", 10);
    view = c.view(10);
    expect(view.at(-1)!.sel).toEqual([0, 1]);
    expect(view.at(-2)!.sel).toEqual([0, 6]); // "row 48", whole, through the line's end
    c.feed("g", 10);
    expect(c.view(10)[0]!.text).toBe("row 0");
  });

  test("an empty pane is one empty line, and yanking it yields nothing to yank", () => {
    expect(new CopyMode("s1:p1", "x", []).feed("y", 10)).toEqual({ kind: "yank", text: "" });
  });
});

describe("the clipboard", () => {
  test("OSC 52 carries the text base64-encoded to the clipboard selection", () => {
    expect(osc52("› hello herd")).toBe(`\x1b]52;c;${Buffer.from("› hello herd").toString("base64")}\x07`);
  });

  test("the OS clipboard command per platform, and none over SSH", () => {
    expect(clipboardCommand("darwin", {})).toEqual(["pbcopy"]);
    expect(clipboardCommand("win32", {})).toEqual(["clip.exe"]);
    expect(clipboardCommand("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual(["wl-copy"]);
    expect(clipboardCommand("linux", { DISPLAY: ":0" })).toEqual(["xclip", "-selection", "clipboard"]);
    expect(clipboardCommand("linux", {})).toBeNull();
    expect(clipboardCommand("darwin", { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" })).toBeNull();
  });
});
