// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/native_dialog.test.ts - P-FS.2 (ADR-0265): pin the native-picker contract.
//
// The spawn paths need a desktop session, so the tests pin the PURE parts every platform shares:
// the win32 script uses the MODERN Explorer dialog (never the legacy tree) and passes caller text
// via env vars; stdout parsing is marker-anchored (compiler noise can never become a "path");
// AppleScript titles cannot break out of the string literal; linux titles are argv elements.

import { test, expect } from "bun:test";
import {
  CANCEL_MARK,
  PICKED_MARK,
  escapeAppleScript,
  linuxPickCommands,
  macPickSource,
  parseWinPick,
  winPickScript,
} from "./native_dialog.ts";

test("win32 script opens the modern IFileOpenDialog folder picker, not the legacy tree", () => {
  const s = winPickScript();
  expect(s).toContain("FOS_PICKFOLDERS");
  expect(s).toContain("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7"); // FileOpenDialog CLSID
  expect(s).not.toContain("FolderBrowserDialog"); // the cramped legacy dialog is exactly the bug
  // Caller text rides env vars; it is never spliced into the powershell source.
  expect(s).toContain("$env:LUCID_PICK_TITLE");
  expect(s).toContain("$env:LUCID_PICK_OK");
});

test("win32 stdout parse: picked / cancelled / garbage / noise before the marker", () => {
  expect(parseWinPick(`${PICKED_MARK}C:\\Users\\me\\data\r\n`)).toEqual({ status: "picked", path: "C:\\Users\\me\\data" });
  expect(parseWinPick(CANCEL_MARK)).toEqual({ status: "cancelled" });
  expect(parseWinPick("unexpected compiler output")).toEqual({ status: "error" });
  expect(parseWinPick(`warning noise\n${PICKED_MARK}D:\\x`)).toEqual({ status: "picked", path: "D:\\x" });
  expect(parseWinPick(PICKED_MARK)).toEqual({ status: "error" }); // a picked marker with no path is nonsense
});

test("applescript titles are escaped so a quote cannot break out of the source", () => {
  expect(escapeAppleScript('a "quoted" \\ title')).toBe('a \\"quoted\\" \\\\ title');
  expect(macPickSource('say "hi"')).toBe('POSIX path of (choose folder with prompt "say \\"hi\\"")');
});

test("linux candidates: zenity first, kdialog fallback, title as its own argv element", () => {
  const cmds = linuxPickCommands("My title; rm -rf /");
  expect(cmds[0]![0]).toBe("zenity");
  expect(cmds[1]![0]).toBe("kdialog");
  for (const argv of cmds) expect(argv).toContain("My title; rm -rf /"); // argv array = no shell parsing
});
