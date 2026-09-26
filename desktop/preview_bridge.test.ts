// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_bridge.test.ts — P-PREVIEW.6b (ADR-0153): the injected inspect bridge.
// P-PREVIEW.13: plus the EARLY shim that repairs the opaque-origin environment before page code runs.

import { test, expect, describe } from "bun:test";
import { injectPreviewBridge, injectPreviewShim, PREVIEW_BRIDGE_JS, PREVIEW_SHIM_JS } from "./preview_bridge.ts";

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

// P-PREVIEW.13. The bug this guards: the preview frame is sandboxed WITHOUT allow-same-origin, so its
// origin is opaque and the `localStorage` getter THROWS. A page whose first line reads a saved high score
// therefore died on line 1, leaving HTML and CSS painted but nothing scripted, which is the "preview panel
// doesn't work" report. Reproduced and isolated live: the identical game with only that line removed
// animates correctly in the same sandbox.
describe("injectPreviewShim (P-PREVIEW.13)", () => {
  test("injects immediately after <head>, so it is the FIRST script the page runs", () => {
    const out = injectPreviewShim("<html><head><title>t</title></head><body><script>x()</script></body></html>");
    expect(out).toContain("<head><script>");
    // Position is the whole point: it must precede the page's own script, not merely be present.
    expect(out.indexOf("__lucidShim")).toBeLessThan(out.indexOf("x()"));
    expect(out.indexOf("__lucidShim")).toBeLessThan(out.indexOf("<title>"));
  });
  test("falls back to after <html>, then to prepending, when there is no <head>", () => {
    expect(injectPreviewShim("<html><body>b</body></html>")).toContain("<html><script>");
    expect(injectPreviewShim("<h1>bare</h1>").startsWith("<script>")).toBe(true);
  });
  test("tolerates attributes on the head/html tags", () => {
    const out = injectPreviewShim(`<html lang="en"><head data-x="1"><meta charset="utf-8"></head><body></body></html>`);
    expect(out).toContain(`<head data-x="1"><script>`);
    expect(out.indexOf("__lucidShim")).toBeLessThan(out.indexOf("<meta"));
  });
  test("polyfills BOTH storages, and only when the real one is unreachable", () => {
    expect(PREVIEW_SHIM_JS).toContain("localStorage");
    expect(PREVIEW_SHIM_JS).toContain("sessionStorage");
    // The probe must be guarded, because reading the getter is itself what throws.
    expect(PREVIEW_SHIM_JS).toMatch(/try\s*\{\s*var s = window\[name\]/);
    // A reachable Storage is left ALONE (a top-level open has a real one; clobbering it would lose data).
    expect(PREVIEW_SHIM_JS).toContain("if (ok) return;");
    // The full surface real code calls, or the polyfill just moves the crash.
    for (const m of ["getItem", "setItem", "removeItem", "clear", "key", "length"]) {
      expect(PREVIEW_SHIM_JS).toContain(m);
    }
  });
  test("shares ONE error buffer with the bridge, so an early throw still reaches preview_inspect", () => {
    // The bridge registers its listener before </body>, far too late to catch a throw from the page's
    // own first script. Both must therefore read and write the same array.
    expect(PREVIEW_SHIM_JS).toContain("window.__lucidErrs = window.__lucidErrs || []");
    expect(PREVIEW_BRIDGE_JS).toContain("window.__lucidErrs = window.__lucidErrs || []");
  });
  test("captures errors + unhandled rejections, and surfaces a dead page instead of leaving it blank", () => {
    expect(PREVIEW_SHIM_JS).toContain("addEventListener('error'");
    expect(PREVIEW_SHIM_JS).toContain("addEventListener('unhandledrejection'");
    expect(PREVIEW_SHIM_JS).toContain("lucid-script-error");
    // Shown once, and dismissible: a stuck banner over someone's app is its own bug.
    expect(PREVIEW_SHIM_JS).toContain("if (shown) return;");
    expect(PREVIEW_SHIM_JS).toContain("d.remove()");
  });
  test("idempotent: a double injection cannot double-install or double-banner", () => {
    expect(PREVIEW_SHIM_JS).toContain("if (window.__lucidShim) return;");
    const twice = injectPreviewShim(injectPreviewShim("<html><head></head><body></body></html>"));
    expect(twice.split("__lucidShim = 1").length - 1).toBe(2); // both present...
    expect(PREVIEW_SHIM_JS.indexOf("__lucidShim")).toBeLessThan(PREVIEW_SHIM_JS.indexOf("errs")); // ...guard runs first
  });
  test("no arbitrary-code or raw-HTML surface (same bar as the bridge)", () => {
    expect(/\beval\s*\(/.test(PREVIEW_SHIM_JS)).toBe(false);
    expect(/new\s+Function/.test(PREVIEW_SHIM_JS)).toBe(false);
    expect(/innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|document\.write/.test(PREVIEW_SHIM_JS)).toBe(false);
    // The banner text is attacker-influenced (it quotes the page's own error), so it MUST be textContent.
    expect(PREVIEW_SHIM_JS).toContain("p.textContent =");
    // The only setAttribute is a static style string, never interpolated page data.
    expect(/setAttribute\('style',[^)]*\$\{/.test(PREVIEW_SHIM_JS)).toBe(false);
  });
  test("no egress: the shim never reaches the network (connect-src is 'none' anyway)", () => {
    expect(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon/.test(PREVIEW_SHIM_JS)).toBe(false);
  });
});
