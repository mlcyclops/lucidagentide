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
  test("CREATOR-3b: capture is routed BEFORE the action allowlist, and both older routes still read", () => {
    // The chain is written so the pre-existing routing contract stays a literal substring of the same line.
    expect(PREVIEW_BRIDGE_JS).toContain("cmd.capture ? capture(cmd) : cmd.action ? act(cmd) : inspect(cmd)");
    expect(PREVIEW_BRIDGE_JS).toContain("cmd.action ? act(cmd) : inspect(cmd)");
  });
  test("CREATOR-3b: the capture path calls only a hook the DOCUMENT defined, behind a typeof check", () => {
    // This is the security line for the whole feature: LUCID never evaluates scene code, it calls a function
    // the previewed document itself installed. The absence assertions above cover the rest of the surface.
    expect(PREVIEW_BRIDGE_JS).toContain("typeof window.lucidRenderAt==='function'");
    expect(PREVIEW_BRIDGE_JS).toContain("window.lucidRenderAt(t)");
    expect(PREVIEW_BRIDGE_JS).toContain("toDataURL('image/png')");
  });
  test("CREATOR-3b: the capture caps are literal in the bridge, so the driver can pin itself to them", () => {
    expect(PREVIEW_BRIDGE_JS).toContain("CAP_MAX_FRAMES=64");
    expect(PREVIEW_BRIDGE_JS).toContain("CAP_MAX_EDGE=2048");
  });
  test("CREATOR-3b: a sampled capture is LABELED rather than presented as driven", () => {
    // `driven` rides every reply, which is what lets the parent refuse to call a sampled pass reproducible.
    expect(PREVIEW_BRIDGE_JS).toContain("driven:driven");
  });
  test("P-PREVIEW.7: the one-shot health report is present, read-only, and parent-only", () => {
    expect(PREVIEW_BRIDGE_JS).toContain("preview-health");
    expect(PREVIEW_BRIDGE_JS).toContain("emptyBody: bodyEmpty()");
    expect(PREVIEW_BRIDGE_JS).toContain("healthSent");           // fire-once guard
    expect(PREVIEW_BRIDGE_JS).toContain("errs.slice(-6)");       // bounded error tail, no full dumps
  });
});
