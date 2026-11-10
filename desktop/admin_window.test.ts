// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { ADMIN_DEFAULT_SIZE, adminBounds, adminNavigation } from "./admin_window.ts";
import { pluginOrigin } from "./plugins/ports.ts";

// P-RS-WINDOW.1 (ADR-0537): what the Remote Spokes admin window may load, and where it opens.
const PANEL = "http://127.0.0.1:47555";
const SCREEN = [{ x: 0, y: 0, width: 1920, height: 1040 }];

describe("adminNavigation", () => {
  test("the panel's own origin stays in the window; the same port under another host name is not the same origin", () => {
    expect(adminNavigation(PANEL, `${PANEL}/spokes?x=1#y`)).toBe("allow");
    expect(adminNavigation(PANEL, `${PANEL}/`)).toBe("allow");
    expect(adminNavigation(PANEL, "http://localhost:47555/")).toBe("deny");
  });

  test("an https page elsewhere goes to the system browser", () => {
    expect(adminNavigation(PANEL, "https://github.com/TechLead187/docs")).toBe("external");
  });

  test("everything else is denied: another plugin, plain http, other schemes, junk", () => {
    for (const url of [
      "http://127.0.0.1:47556/", "http://127.0.0.1:5319/", "http://example.com/", "file:///C:/Windows/win.ini",
      "javascript:alert(1)", "data:text/html,hi", "lucid://auth", "https://user:pw@example.com/", "", 42, null,
    ]) expect(adminNavigation(PANEL, url)).toBe("deny");
  });

  test("only a plugin loopback URL has an origin the window may open at", () => {
    expect(pluginOrigin(`${PANEL}/#bootstrap=abc`)).toBe(PANEL);
    for (const url of ["http://127.0.0.1:9/", "https://127.0.0.1:47555/", "http://10.0.0.5:47555/", "http://127.0.0.1:5319/"]) expect(pluginOrigin(url)).toBeNull();
  });
});

describe("adminBounds", () => {
  test("no file or a bad one opens at the default size, placed by the OS", () => {
    for (const text of [null, "", "not json", "[]", "null", JSON.stringify({ width: "1280", height: 860 })]) {
      expect(adminBounds(text, SCREEN)).toEqual({ ...ADMIN_DEFAULT_SIZE });
    }
  });

  test("a saved size and position on a screen come back", () => {
    expect(adminBounds(JSON.stringify({ x: 100, y: 80, width: 1400, height: 900 }), SCREEN)).toEqual({ x: 100, y: 80, width: 1400, height: 900 });
  });

  test("a size under the minimum falls back to the default", () => {
    expect(adminBounds(JSON.stringify({ x: 0, y: 0, width: 300, height: 200 }), SCREEN)).toEqual({ ...ADMIN_DEFAULT_SIZE });
  });

  test("a position off every screen keeps the size and lets the OS place it", () => {
    expect(adminBounds(JSON.stringify({ x: 4000, y: 80, width: 1280, height: 860 }), SCREEN)).toEqual({ width: 1280, height: 860 });
    expect(adminBounds(JSON.stringify({ x: 100, y: -500, width: 1280, height: 860 }), SCREEN)).toEqual({ width: 1280, height: 860 });
  });
});
