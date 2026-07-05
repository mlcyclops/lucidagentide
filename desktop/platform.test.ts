// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/platform.test.ts - OS-aware keyboard-shortcut labels (cross-platform hint display).

import { describe, expect, test } from "bun:test";
import { isMac, modCombo, modKey, modSymbol } from "./renderer/platform.ts";
import { stepsForRole } from "./renderer/tour.ts";

describe("modifier label is OS-aware and safe off-browser", () => {
  test("when navigator access throws (guarded read), it falls back to the Windows/Linux 'Ctrl' form", () => {
    // Bun ships a real `navigator` since 1.x, so simulate the guard's failure branch explicitly:
    // a throwing accessor proves the try/catch fallback, deterministically on any host OS.
    const orig = globalThis.navigator;
    try {
      Object.defineProperty(globalThis, "navigator", {
        get() { throw new Error("no navigator off-browser"); }, configurable: true,
      });
      expect(isMac()).toBe(false);
      expect(modKey()).toBe("Ctrl");
      expect(modCombo("K")).toBe("Ctrl+K");
      expect(modSymbol("+")).toBe("Ctrl +");
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: orig, configurable: true });
    }
  });

  test("non-mac platforms use the 'Ctrl+' form", () => {
    const orig = globalThis.navigator;
    try {
      Object.defineProperty(globalThis, "navigator", {
        value: { platform: "Linux x86_64", userAgent: "X11; Linux x86_64" }, configurable: true,
      });
      expect(isMac()).toBe(false);
      expect(modCombo("K")).toBe("Ctrl+K");
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: orig, configurable: true });
    }
  });

  test("the macOS forms use the ⌘ glyph (no '+', symbols spaced)", () => {
    // Simulate a mac UA so we exercise the other branch.
    const orig = globalThis.navigator;
    try {
      Object.defineProperty(globalThis, "navigator", {
        value: { platform: "MacIntel", userAgent: "Macintosh" }, configurable: true,
      });
      expect(isMac()).toBe(true);
      expect(modKey()).toBe("⌘");
      expect(modCombo("K")).toBe("⌘K");
      expect(modSymbol("+")).toBe("⌘ +");
    } finally {
      if (orig) Object.defineProperty(globalThis, "navigator", { value: orig, configurable: true });
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  });
});

describe("the tour copy renders the live OS shortcut, not a hardcoded glyph", () => {
  test("the commands step shows the combo resolved for THIS host and never the other OS's form", () => {
    // tour.ts resolves modCombo("K") at module import (renderer: always post-navigator). Assert the
    // live contract portably: the body carries the CURRENT resolution, not a hardcoded glyph for the
    // wrong platform — on mac hosts "⌘K" (and no "Ctrl+K"), elsewhere "Ctrl+K" (and no "⌘").
    const commands = stepsForRole("developer").find((s) => s.id === "commands")!;
    expect(commands.body).toContain(modCombo("K"));
    expect(commands.body).not.toContain(isMac() ? "Ctrl+K" : "⌘");
  });
});
