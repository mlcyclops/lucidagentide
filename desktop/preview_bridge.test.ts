// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_bridge.test.ts — P-PREVIEW.6b (ADR-0153): the injected inspect bridge.

import { test, expect, describe } from "bun:test";
import { injectPreviewBridge, PREVIEW_BRIDGE_JS } from "./preview_bridge.ts";

describe("injectPreviewBridge", () => {
  test("injects the bridge just before </body>", () => {
    const out = injectPreviewBridge("<html><body><h1>Hi</h1></body></html>");
    expect(out).toContain("<h1>Hi</h1><script>");
    expect(out.indexOf("<script>")).toBeLessThan(out.indexOf("</body>"));
    expect(out).toContain("__lucidInspect");
  });
  test("appends when there is no </body>", () => {
    const out = injectPreviewBridge("<h1>bare</h1>");
    expect(out.startsWith("<h1>bare</h1><script>")).toBe(true);
  });
  test("no arbitrary-code or unbounded-HTML surface (eval / Function / innerHTML / setAttribute)", () => {
    // Structured actions (click/type/focus/scroll) are allowed, but NEVER arbitrary JS or raw HTML injection.
    expect(/\beval\s*\(/.test(PREVIEW_BRIDGE_JS)).toBe(false);
    expect(/new\s+Function/.test(PREVIEW_BRIDGE_JS)).toBe(false);
    expect(/innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|setAttribute\s*\(|document\.write/.test(PREVIEW_BRIDGE_JS)).toBe(false);
    // it only talks to its own parent + tags its messages
    expect(PREVIEW_BRIDGE_JS).toContain("ev.source!==window.parent");
    expect(PREVIEW_BRIDGE_JS).toContain("inspect-result");
  });
  test("structured actions are a fixed allowlist (click / type / focus / scroll), routed on `action`", () => {
    expect(PREVIEW_BRIDGE_JS).toContain("cmd.action ? act(cmd) : inspect(cmd)");
    for (const a of ["click", "type", "focus", "scroll"]) expect(PREVIEW_BRIDGE_JS).toContain(`action==='${a}'`);
    // type only ever sets value/textContent on a real input/contenteditable, then dispatches input/change
    expect(PREVIEW_BRIDGE_JS).toContain("el.value=v");
    expect(PREVIEW_BRIDGE_JS).toContain("el.textContent=v");
  });
});
