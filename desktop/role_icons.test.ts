// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/role_icons.test.ts - the animated role glyphs for the onboarding splash (ADR-0089).

import { describe, expect, test } from "bun:test";
import { roleIcon } from "./renderer/role_icons.ts";
import { USER_ROLE_LIST } from "./renderer/tour.ts";

describe("each role has a distinct, animated, family-matching glyph", () => {
  test("every role returns an SVG in the icon family (28 viewBox, currentColor)", () => {
    for (const r of USER_ROLE_LIST) {
      const svg = roleIcon(r);
      expect(svg).toContain("<svg");
      expect(svg).toContain('viewBox="0 0 28 28"');
      expect(svg).toContain('stroke="currentColor"');
      expect(svg).toContain('aria-hidden="true"');
    }
  });

  test("the four glyphs are distinct and carry their animated hook class", () => {
    const rootClass: Record<string, string> = {
      developer: "ri-dev", security: "ri-sec", manager: "ri-mgr", executive: "ri-exec",
    };
    const hooks: Record<string, string> = {
      developer: "ri-caret", security: "ri-check", manager: "ri-bar", executive: "ri-bust",
    };
    const seen = new Set<string>();
    for (const r of USER_ROLE_LIST) {
      const svg = roleIcon(r);
      expect(svg).toContain(rootClass[r]!);  // per-role root class
      expect(svg).toContain(hooks[r]!);      // its CSS-animated part
      seen.add(svg);
    }
    expect(seen.size).toBe(USER_ROLE_LIST.length); // all distinct
  });
});
