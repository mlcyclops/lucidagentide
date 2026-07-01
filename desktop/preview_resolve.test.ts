// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_resolve.test.ts — P-PREVIEW.1 (ADR-0096): the fail-safe preview-target resolver.

import { describe, expect, test } from "bun:test";
import { PREVIEW_ALLOW, PREVIEW_FRAME_CSP, PREVIEW_SANDBOX, PREVIEW_SANDBOX_FORBIDDEN, canPreviewRemote, previewOpenPath, previewablePath, resolvePreview, toFileUrl } from "./preview_resolve.ts";

describe("previewOpenPath (P-PREVIEW.3a, ADR-0096): the agent's preview_open tool call", () => {
  test("a preview_open call → its path", () => {
    expect(previewOpenPath("preview_open", { path: "C:/Users/n/game.html" })).toBe("C:/Users/n/game.html");
  });
  test("matches the ACP-rendered call title (custom tool name lands in the title, not kind)", () => {
    // omp maps a custom tool's `kind` to "other" and renders the call title as `"preview_open: <path>"`,
    // so acp_backend matches preview_open against the TITLE — this is the real-world input shape.
    expect(previewOpenPath("preview_open: C:/Users/n/game.html", { path: "C:/Users/n/game.html" })).toBe("C:/Users/n/game.html");
    expect(previewOpenPath("other", { path: "C:/Users/n/game.html" })).toBeNull(); // the bare kind never matches
  });
  test("any other tool → null (even with a path)", () => {
    expect(previewOpenPath("write", { path: "game.html" })).toBeNull();
    expect(previewOpenPath("bash", { path: "x.html" })).toBeNull();
  });
  test("missing/empty path → null", () => {
    expect(previewOpenPath("preview_open", {})).toBeNull();
    expect(previewOpenPath("preview_open", { path: "  " })).toBeNull();
    expect(previewOpenPath(null, { path: "x.html" })).toBeNull();
  });
});

describe("canPreviewRemote (P-PREVIEW.3b, ADR-0096)", () => {
  test("loads only when egress-approved AND https", () => {
    expect(canPreviewRemote("https://example.com/app", true)).toBe(true);
  });
  test("never loads an egress-approved but non-https URL (no plaintext into the sandbox)", () => {
    expect(canPreviewRemote("http://example.com/app", true)).toBe(false);
  });
  test("never loads when egress is not approved, even for https", () => {
    expect(canPreviewRemote("https://example.com/app", false)).toBe(false);
  });
  test("null/empty → false", () => {
    expect(canPreviewRemote("", true)).toBe(false);
    expect(canPreviewRemote(null, true)).toBe(false);
  });
});

describe("preview sandbox policy (P-PREVIEW.3, ADR-0096)", () => {
  const tokens = PREVIEW_SANDBOX.split(/\s+/).filter(Boolean);
  test("allows scripts (the app must run) but stays opaque-origin (no allow-same-origin)", () => {
    expect(tokens).toContain("allow-scripts");
    expect(tokens).not.toContain("allow-same-origin"); // opaque origin: can't read LUCID's storage/cookies
  });
  test("never grants any escape/escalation token", () => {
    for (const forbidden of PREVIEW_SANDBOX_FORBIDDEN) {
      expect(tokens).not.toContain(forbidden);
    }
  });
  test("Permissions-Policy denies all powerful features (empty allow)", () => {
    expect(PREVIEW_ALLOW).toBe("");
  });
});

describe("served-preview per-frame CSP (P-PREVIEW.4b, ADR-0096)", () => {
  const dirs = new Map(
    PREVIEW_FRAME_CSP.split(";").map((d) => {
      const [name, ...vals] = d.trim().split(/\s+/);
      return [name, vals];
    }),
  );
  test("lets a self-contained app RUN: inline scripts/styles + data/blob media", () => {
    // This is the whole point of 4b — a srcdoc frame inherits the renderer's script-src 'self' and blocks
    // these; a served frame carries this policy so the previewed app's inline JS/CSS actually execute.
    expect(dirs.get("script-src")).toContain("'unsafe-inline'");
    expect(dirs.get("style-src")).toContain("'unsafe-inline'");
    expect(dirs.get("img-src")).toEqual(expect.arrayContaining(["data:", "blob:"]));
    expect(dirs.get("media-src")).toEqual(expect.arrayContaining(["data:", "blob:"]));
  });
  test("blocks ALL network egress so a previewed app can't bypass the egress gate", () => {
    expect(dirs.get("connect-src")).toEqual(["'none'"]);
    expect(dirs.get("default-src")).toEqual(["'none'"]); // nothing is allowed unless explicitly listed
    expect(dirs.get("form-action")).toEqual(["'none'"]);
    expect(dirs.get("base-uri")).toEqual(["'none'"]);
  });
  test("never allows arbitrary remote script/style hosts (only inline + blob)", () => {
    for (const dir of ["script-src", "style-src"]) {
      for (const v of dirs.get(dir) ?? []) {
        expect(/^https?:/.test(v)).toBe(false); // no external origins — the app is self-contained
      }
    }
  });
});

describe("previewablePath (P-PREVIEW.2, ADR-0096): auto-surface a written app", () => {
  test("a write of an .html file → its path", () => {
    expect(previewablePath("write", { path: "C:\\Users\\n\\game.html" })).toBe("C:\\Users\\n\\game.html");
    expect(previewablePath("edit", { file_path: "/home/n/app.htm" })).toBe("/home/n/app.htm");
    expect(previewablePath("Write", { filename: "diagram.svg" })).toBe("diagram.svg");
  });
  test("a write of a NON-previewable file → null (only browser docs auto-surface)", () => {
    expect(previewablePath("write", { path: "src/index.ts" })).toBeNull();
    expect(previewablePath("edit", { path: "notes.md" })).toBeNull();
  });
  test("a non-write tool (read/search/bash) → null, even on an .html", () => {
    expect(previewablePath("read", { path: "game.html" })).toBeNull();
    expect(previewablePath("bash", { command: "cat game.html" })).toBeNull();
  });
  test("missing/empty path → null", () => {
    expect(previewablePath("write", {})).toBeNull();
    expect(previewablePath("write", { path: "   " })).toBeNull();
    expect(previewablePath("write", null)).toBeNull();
    expect(previewablePath(null, { path: "x.html" })).toBeNull();
  });
});

describe("toFileUrl", () => {
  test("leaves an existing file:// URL alone", () => {
    expect(toFileUrl("file:///C:/Users/n/game.html")).toBe("file:///C:/Users/n/game.html");
  });
  test("Windows drive path → file:/// with forward slashes", () => {
    expect(toFileUrl("C:\\Users\\n\\game.html")).toBe("file:///C:/Users/n/game.html");
    expect(toFileUrl("C:/Users/n/game.html")).toBe("file:///C:/Users/n/game.html");
  });
  test("POSIX absolute path → file://", () => {
    expect(toFileUrl("/home/n/game.html")).toBe("file:///home/n/game.html");
  });
});

describe("resolvePreview (fail-safe)", () => {
  test("a local file is rendered, with a filename label", () => {
    const r = resolvePreview("C:\\Users\\neorc\\Documents\\My Music\\hormuz-minesweeper.html");
    expect(r.kind).toBe("local");
    expect(r.src).toBe("file:///C:/Users/neorc/Documents/My Music/hormuz-minesweeper.html");
    expect(r.label).toBe("hormuz-minesweeper.html");
  });
  test("a file:// URL is local and keeps its src", () => {
    const r = resolvePreview("file:///home/n/game.html");
    expect(r.kind).toBe("local");
    expect(r.src).toBe("file:///home/n/game.html");
  });
  test("an http(s) URL is recognized as remote but NOT auto-loaded (src empty, gated)", () => {
    const r = resolvePreview("https://example.com/app");
    expect(r.kind).toBe("remote");
    expect(r.src).toBe("");
    expect(r.reason).toMatch(/gated/i);
  });
  test("empty / whitespace ⇒ blocked", () => {
    expect(resolvePreview("").kind).toBe("blocked");
    expect(resolvePreview("   ").kind).toBe("blocked");
    expect(resolvePreview(null).kind).toBe("blocked");
  });
  test("an ambiguous string (bare host / relative path) ⇒ blocked, never rendered", () => {
    expect(resolvePreview("example.com/x").kind).toBe("blocked");
    expect(resolvePreview("game.html").kind).toBe("blocked");
    const r = resolvePreview("game.html");
    expect(r.src).toBe("");
  });
});
