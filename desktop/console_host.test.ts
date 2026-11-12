// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-BROWSER.4 (ADR-0415): the omp spawn shares the engine's hidden console exactly when there is one.
// The rule mirrors omp's own (`hostHasInheritableConsole`): a console-less child hides every window it
// opens, which is how the agent's visible browser came up white.

import { describe, expect, test } from "bun:test";
import { agentSpawnWindowsHide, ensureHiddenConsole, shouldAllocateConsole } from "./console_host.ts";

describe("agentSpawnWindowsHide", () => {
  test("windows with a console window: the child attaches to it (no SW_HIDE)", () => {
    expect(agentSpawnWindowsHide({ platform: "win32", consoleWindow: true })).toBe(false);
  });
  test("windows without one: hide, so no console window ever pops up", () => {
    expect(agentSpawnWindowsHide({ platform: "win32", consoleWindow: false })).toBe(true);
  });
  test("elsewhere the flag is a no-op and keeps the value every spawn used before", () => {
    expect(agentSpawnWindowsHide({ platform: "linux", consoleWindow: false })).toBe(true);
    expect(agentSpawnWindowsHide({ platform: "darwin", consoleWindow: true })).toBe(true);
  });
});

describe("shouldAllocateConsole", () => {
  test("only a windowless, non-terminal windows engine allocates", () => {
    expect(shouldAllocateConsole({ platform: "win32", consoleWindow: false, stdioIsTTY: false })).toBe(true);
    expect(shouldAllocateConsole({ platform: "win32", consoleWindow: true, stdioIsTTY: false })).toBe(false);
  });
  test("a terminal run is never detached from its terminal", () => {
    expect(shouldAllocateConsole({ platform: "win32", consoleWindow: false, stdioIsTTY: true })).toBe(false);
  });
  test("never off windows", () => {
    expect(shouldAllocateConsole({ platform: "linux", consoleWindow: false, stdioIsTTY: false })).toBe(false);
  });
});

describe("ensureHiddenConsole", () => {
  test("never shows a window and is idempotent", () => {
    const first = ensureHiddenConsole();
    expect(first.hidden).toBe(true);
    const second = ensureHiddenConsole();
    expect(second.hidden).toBe(true);
    expect(second.allocated).toBe(false); // the second call finds the first's console (or still none)
    if (process.platform !== "win32") expect(first.window).toBe(false);
  });
});
