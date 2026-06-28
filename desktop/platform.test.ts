// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/platform.test.ts - OS-aware keyboard-shortcut labels (cross-platform hint display).

import { describe, expect, test } from "bun:test";
import { isMac, modCombo, modKey, modSymbol } from "./renderer/platform.ts";
import { stepsForRole } from "./renderer/tour.ts";

describe("modifier label is OS-aware and safe off-browser", () => {
  test("with no navigator (Node/test), it falls back to the Windows/Linux 'Ctrl' form", () => {
    // The test runtime has no `navigator`, so the guarded read defaults to non-mac.
    expect(isMac()).toBe(false);
    expect(modKey()).toBe("Ctrl");
    expect(modCombo("K")).toBe("Ctrl+K");
    expect(modSymbol("+")).toBe("Ctrl +");
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
  test("the commands step shows the resolved combo (Ctrl+K off-browser) and no stray ⌘", () => {
    const commands = stepsForRole("developer").find((s) => s.id === "commands")!;
    expect(commands.body).toContain("Ctrl+K");
    expect(commands.body).not.toContain("⌘");
  });
});
