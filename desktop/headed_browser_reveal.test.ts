// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from "bun:test";
import { isHeadedOmpBrowser, windowsToReveal, type TopWindow } from "./headed_browser_reveal.ts";

const PROFILE = "--user-data-dir=C:\\Users\\u\\.omp\\run\\daemons\\3ceb7907897e7b63\\omp.browser.headed.profile";

test("only the ROOT process of omp's headed Chromium matches: not its helpers, not the headless one, not the user's Chrome", () => {
  expect(isHeadedOmpBrowser(`"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --no-first-run ${PROFILE} about:blank --no-startup-window --remote-debugging-port=0`)).toBe(true);
  expect(isHeadedOmpBrowser(`chrome.exe --type=renderer ${PROFILE}`)).toBe(false);
  expect(isHeadedOmpBrowser("chrome.exe --user-data-dir=C:\\Users\\u\\.omp\\run\\daemons\\x\\omp.browser.headless.profile --headless=new")).toBe(false);
  expect(isHeadedOmpBrowser("\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\" --restore-last-session")).toBe(false);
  expect(isHeadedOmpBrowser("")).toBe(false);
});

test("reveal: a hidden, titled frame of a headed omp browser, once; visible, untitled, or foreign frames never", () => {
  const w = (hwnd: number, pid: number, visible: boolean, titled = true): TopWindow => ({ hwnd, pid, visible, titled });
  const headed = (pid: number) => pid === 7;
  const windows = [w(1, 7, false), w(2, 7, true), w(3, 7, false, false), w(4, 9, false)];
  expect(windowsToReveal(windows, headed, new Set())).toEqual([1]);
  expect(windowsToReveal(windows, headed, new Set([1]))).toEqual([]); // shown once: a window Chrome hides later stays hidden
});

test("command lines are read only for candidate windows (hidden and titled)", () => {
  const asked: number[] = [];
  const headed = (pid: number) => { asked.push(pid); return false; };
  windowsToReveal([{ hwnd: 1, pid: 1, visible: true, titled: true }, { hwnd: 2, pid: 2, visible: false, titled: false }, { hwnd: 3, pid: 3, visible: false, titled: true }], headed, new Set());
  expect(asked).toEqual([3]);
});
