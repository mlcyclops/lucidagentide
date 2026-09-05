// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_resolve.test.ts — P-PREVIEW.1 (ADR-0096): the fail-safe preview-target resolver.

import { describe, expect, test } from "bun:test";
import { PREVIEWABLE_EXT, PREVIEW_ALLOW, PREVIEW_FRAME_CSP, PREVIEW_KIND_EXT, PREVIEW_SANDBOX, PREVIEW_SANDBOX_FORBIDDEN, canPreviewRemote, normalizePreviewPath, previewKindOf, previewOpenPath, previewablePath, resolvePreview, toFileUrl, type PreviewKind } from "./preview_resolve.ts";
import { toFsPath } from "./preview_file.ts";
import { PREVIEWABLE_EXTS } from "../harness/omp/preview_extension.ts"; // P-PREVIEW.12: the omp-side mirror

describe("previewOpenPath (P-PREVIEW.3a, ADR-0096): the agent's preview_open tool call", () => {
  test("a preview_open call → its path", () => {
    expect(previewOpenPath("preview_open", { path: "C:/Users/n/game.html" })).toBe("C:/Users/n/game.html");
  });
  test("a QUOTED path (agents sometimes wrap paths in quotes) → unwrapped path", () => {
    expect(previewOpenPath("preview_open", { path: '"C:/Users/n/game.html"' })).toBe("C:/Users/n/game.html");
    expect(previewOpenPath("preview_open", { path: " 'C:\\Users\\n\\game.html' " })).toBe("C:\\Users\\n\\game.html");
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
  test("missing/empty path \u2192 null", () => {
    expect(previewOpenPath("preview_open", {})).toBeNull();
    expect(previewOpenPath("preview_open", { path: "  " })).toBeNull();
    expect(previewOpenPath(null, { path: "x.html" })).toBeNull();
  });

  // P-PREVIEW.11 (ADR-0308): THE FIELD BUG, pinned so nobody "fixes" the panel by trusting the title again.
  // omp's acp-event-mapper buildToolTitle returns the model's INTENT as the ACP call title whenever intent
  // tracing is on (sdk.ts injects an `i` field into every tool schema), shadowing the "preview_open: <path>"
  // form this function keys on - and buildToolCallStartUpdate carries NO tool-name field, so the tool is
  // simply not identifiable from the stream. That is why preview_open now reports itself over its own
  // channel (LUCID_PREVIEW_OPEN_URL -> /api/preview/open -> backend.openPreview) and this title match is
  // only a fallback for the intent-tracing-off case.
  test("an INTENT-shadowed title no longer identifies the call (why the direct channel exists)", () => {
    const ri = { path: "C:/Users/n/deck.html", i: "Opening rendered deck in preview" };
    // Real titles observed with intent tracing on: prose, no tool name anywhere.
    expect(previewOpenPath("Opening rendered deck in preview", ri)).toBeNull();
    expect(previewOpenPath("Opening the preview", ri)).toBeNull();
    expect(previewOpenPath("Showing the user the rendered page", ri)).toBeNull();
    // The fallback still works when intent tracing is OFF and omp builds the name-based title.
    expect(previewOpenPath("preview_open: C:/Users/n/deck.html", ri)).toBe("C:/Users/n/deck.html");
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

// P-PREVIEW.12: the kind table is the fix for "the model can't show me what it built". These tests pin BOTH
// halves of the contract: every kind classifies, and PREVIEWABLE_EXT is DERIVED from the table (so a future
// extension added to one is added to both, which is exactly what drifted three ways before this increment).
describe("previewKindOf (P-PREVIEW.12): the one previewable-kind table", () => {
  test("classifies every extension in the table to its own kind", () => {
    for (const [kind, exts] of Object.entries(PREVIEW_KIND_EXT) as Array<[PreviewKind, readonly string[]]>) {
      for (const ext of exts) expect(previewKindOf(`/tmp/report.${ext}`)).toBe(kind);
    }
  });
  test("covers the kinds the agent actually produces (page, vector, chart, report, data, doc)", () => {
    expect(previewKindOf("index.html")).toBe("html");
    expect(previewKindOf("page.htm")).toBe("html");
    expect(previewKindOf("diagram.svg")).toBe("svg");
    expect(previewKindOf("chart.png")).toBe("image");
    expect(previewKindOf("photo.jpeg")).toBe("image");
    expect(previewKindOf("REPORT.md")).toBe("markdown");
    expect(previewKindOf("data.json")).toBe("text");
    expect(previewKindOf("rows.csv")).toBe("text");
    expect(previewKindOf("run.log")).toBe("text");
    expect(previewKindOf("spec.pdf")).toBe("pdf");
  });
  test("is case-insensitive", () => {
    expect(previewKindOf("C:\\work\\INDEX.HTML")).toBe("html");
    expect(previewKindOf("art.SVG")).toBe("svg");
    expect(previewKindOf("shot.PNG")).toBe("image");
    expect(previewKindOf("notes.MarkDown")).toBe("markdown");
  });
  test("tolerates a query string, a hash, and trailing whitespace", () => {
    expect(previewKindOf("chart.png?v=2")).toBe("image");
    expect(previewKindOf("page.html#top")).toBe("html");
    expect(previewKindOf("app.html?cache=1#frag")).toBe("html");
    expect(previewKindOf("  notes.md  ")).toBe("markdown");
    expect(previewKindOf("data.json?t=9 ")).toBe("text");
  });
  test("returns null for anything the panel cannot honestly render", () => {
    for (const p of ["app.ts", "tool.exe", "styles.css", "bundle.js", "README", "index.html.bak", "html", "", "   "]) {
      expect(previewKindOf(p)).toBeNull();
    }
    expect(previewKindOf(null)).toBeNull();
    expect(previewKindOf(undefined)).toBeNull();
  });
  test("PREVIEWABLE_EXT is DERIVED from the kind table: the two agree on every entry", () => {
    const all = Object.values(PREVIEW_KIND_EXT).flat();
    expect(all.length).toBeGreaterThan(20);
    for (const ext of all) {
      expect(PREVIEWABLE_EXT.test(`/tmp/x.${ext}`)).toBe(true);   // in the table  -> matches the regex
      expect(previewKindOf(`/tmp/x.${ext}`)).not.toBeNull();      // ... and classifies
    }
    for (const ext of ["ts", "tsx", "css", "js", "exe", "zip", "mp4"]) {
      expect(PREVIEWABLE_EXT.test(`/tmp/x.${ext}`)).toBe(false);  // not in the table -> refused by both
      expect(previewKindOf(`/tmp/x.${ext}`)).toBeNull();
    }
  });
  test("the table has no duplicate extension (one extension, one kind)", () => {
    const all = Object.values(PREVIEW_KIND_EXT).flat();
    expect(new Set(all).size).toBe(all.length);
  });
  // P-PREVIEW.12: harness/omp/preview_extension.ts runs as an omp `-e` inside omp's OWN subprocess, so it
  // cannot import this module (a top-level import there would sit outside the try/catch that guarantees a
  // registration failure never breaks omp launch, and it would pull desktop modules into the harness
  // typecheck program). It therefore MIRRORS this list. This is the alarm if the two ever diverge: the
  // agent-facing `preview_open` gate must accept exactly what the panel can actually render.
  test("the omp preview_open mirror (harness/omp/preview_extension.ts) holds exactly these extensions", () => {
    const mirrored = [...PREVIEWABLE_EXTS].sort();
    const authoritative = Object.values(PREVIEW_KIND_EXT).flat().sort();
    expect(mirrored).toEqual(authoritative);
  });
});

describe("previewablePath (P-PREVIEW.2, ADR-0096): auto-surface a written app", () => {
  test("a write of an .html file → its path", () => {
    expect(previewablePath("write", { path: "C:\\Users\\n\\game.html" })).toBe("C:\\Users\\n\\game.html");
    expect(previewablePath("edit", { file_path: "/home/n/app.htm" })).toBe("/home/n/app.htm");
    expect(previewablePath("Write", { filename: "diagram.svg" })).toBe("diagram.svg");
  });
  test("a QUOTED path is unwrapped before the extension check", () => {
    expect(previewablePath("write", { path: '"C:\\Users\\n\\game.html"' })).toBe("C:\\Users\\n\\game.html");
    expect(previewablePath("edit", { file_path: "'/home/n/app.htm'" })).toBe("/home/n/app.htm");
  });
  // P-PREVIEW.12: a written .md/.json/.csv/.png now DOES auto-surface (that was the whole bug: the model
  // could not show a markdown report or a chart PNG). Only a non-previewable extension stays null.
  test("a write of a previewable NON-markup file → its path (P-PREVIEW.12)", () => {
    expect(previewablePath("edit", { path: "notes.md" })).toBe("notes.md");
    expect(previewablePath("write", { path: "/tmp/report.json" })).toBe("/tmp/report.json");
    expect(previewablePath("write", { path: "/tmp/chart.png" })).toBe("/tmp/chart.png");
    expect(previewablePath("write", { path: "/tmp/run.log" })).toBe("/tmp/run.log");
  });
  test("a write of a NON-previewable file → null (source/binaries never hijack the panel)", () => {
    expect(previewablePath("write", { path: "src/index.ts" })).toBeNull();
    expect(previewablePath("write", { path: "styles.css" })).toBeNull();
    expect(previewablePath("write", { path: "setup.exe" })).toBeNull();
    expect(previewablePath("write", { path: "Makefile" })).toBeNull();
  });
  // The write-class gate is the thing that stops a `read` of some random .png taking over the panel now
  // that images are previewable, so it is pinned against the newly-admitted kinds too.
  test("a non-write tool never surfaces a preview, not even for a newly previewable kind", () => {
    expect(previewablePath("read", { path: "game.html" })).toBeNull();
    expect(previewablePath("bash", { command: "cat game.html" })).toBeNull();
    expect(previewablePath("read", { path: "/tmp/chart.png" })).toBeNull();
    expect(previewablePath("search", { path: "/tmp/notes.md" })).toBeNull();
    expect(previewablePath("grep", { path: "/tmp/run.log" })).toBeNull();
  });
  test("missing/empty path → null", () => {
    expect(previewablePath("write", {})).toBeNull();
    expect(previewablePath("write", { path: "   " })).toBeNull();
    expect(previewablePath("write", null)).toBeNull();
    expect(previewablePath(null, { path: "x.html" })).toBeNull();
  });
});

describe("normalizePreviewPath (quoted/padded agent paths)", () => {
  test("trims and strips matching surrounding quote pairs, even nested", () => {
    expect(normalizePreviewPath('  "C:/x/app.html"  ')).toBe("C:/x/app.html");
    expect(normalizePreviewPath("'/home/n/app.html'")).toBe("/home/n/app.html");
    expect(normalizePreviewPath("\"'C:/x/a.html'\"")).toBe("C:/x/a.html");
  });
  test("leaves unquoted / mismatched-quote paths alone; null-safe", () => {
    expect(normalizePreviewPath("C:/x/app.html")).toBe("C:/x/app.html");
    expect(normalizePreviewPath('"C:/x/app.html')).toBe('"C:/x/app.html');
    expect(normalizePreviewPath(null)).toBe("");
    expect(normalizePreviewPath(undefined)).toBe("");
  });
});

describe("toFileUrl", () => {
  test("leaves an existing file:// URL alone (only literal spaces get encoded, %20 never double-encodes)", () => {
    expect(toFileUrl("file:///C:/Users/n/game.html")).toBe("file:///C:/Users/n/game.html");
    expect(toFileUrl("file:///C:/Users/n/My Docs/game.html")).toBe("file:///C:/Users/n/My%20Docs/game.html");
    expect(toFileUrl("file:///C:/Users/n/My%20Docs/game.html")).toBe("file:///C:/Users/n/My%20Docs/game.html");
  });
  test("Windows drive path → file:/// with forward slashes", () => {
    expect(toFileUrl("C:\\Users\\n\\game.html")).toBe("file:///C:/Users/n/game.html");
    expect(toFileUrl("C:/Users/n/game.html")).toBe("file:///C:/Users/n/game.html");
  });
  test("POSIX absolute path → file://", () => {
    expect(toFileUrl("/home/n/game.html")).toBe("file:///home/n/game.html");
  });
  test("percent-encodes spaces per segment (OneDrive-style dirs used to produce broken URLs)", () => {
    expect(toFileUrl("C:/Users/x/OneDrive/Apps AI Vibe/app.html")).toBe("file:///C:/Users/x/OneDrive/Apps%20AI%20Vibe/app.html");
    expect(toFileUrl("C:\\Users\\x\\OneDrive\\Apps AI Vibe\\app.html")).toBe("file:///C:/Users/x/OneDrive/Apps%20AI%20Vibe/app.html");
    expect(toFileUrl("/home/n/my app/x.html")).toBe("file:///home/n/my%20app/x.html");
  });
  test("the Windows drive segment stays LITERAL (never C%3A, which breaks drive letters)", () => {
    const u = toFileUrl("C:/Users/x/OneDrive/Apps AI Vibe/app.html");
    expect(u.startsWith("file:///C:/")).toBe(true);
    expect(u).not.toContain("%3A");
  });
  test("encodes other URL-hostile characters (# would truncate as a fragment, % must survive)", () => {
    expect(toFileUrl("/home/n/a#b/x.html")).toBe("file:///home/n/a%23b/x.html");
    expect(toFileUrl("C:/Users/n/100% done/x.html")).toBe("file:///C:/Users/n/100%25%20done/x.html");
  });
  test("round-trips through toFsPath (preview_file.ts) back to the original OS path", () => {
    for (const p of [
      "C:/Users/x/OneDrive/Apps AI Vibe/app.html",
      "C:/Users/neorc/OneDrive/Desktop/Apps AI Vibe/10-COVERT AGENT IDE/game.html",
      "/home/n/my app/x.html",
      "C:/Users/n/100% done/x.html",
    ]) {
      expect(toFsPath(toFileUrl(p))).toBe(p);
    }
  });
});

describe("resolvePreview (fail-safe)", () => {
  test("a local file is rendered with a percent-encoded src and a human filename label", () => {
    const r = resolvePreview("C:\\Users\\neorc\\Documents\\My Music\\hormuz-minesweeper.html");
    expect(r.kind).toBe("local");
    expect(r.src).toBe("file:///C:/Users/neorc/Documents/My%20Music/hormuz-minesweeper.html");
    expect(r.label).toBe("hormuz-minesweeper.html"); // label stays human-readable (no %20)
  });
  test("an OneDrive-style path with spaces resolves to a loadable, encoded src", () => {
    const r = resolvePreview("C:/Users/x/OneDrive/Apps AI Vibe/app.html");
    expect(r.kind).toBe("local");
    expect(r.src).toBe("file:///C:/Users/x/OneDrive/Apps%20AI%20Vibe/app.html");
    expect(r.src).not.toContain("%3A"); // drive colon stays literal
  });
  test("a QUOTED local path is unwrapped, then rendered", () => {
    const r = resolvePreview('"C:\\Users\\n\\game.html"');
    expect(r.kind).toBe("local");
    expect(r.src).toBe("file:///C:/Users/n/game.html");
    expect(r.label).toBe("game.html");
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
