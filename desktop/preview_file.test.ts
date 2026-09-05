// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_file.test.ts - P-PREVIEW.4 (ADR-0096): the local-file content reader behind the preview.
// P-PREVIEW.12: plus the widened kind table (every kind the panel can render, not just .html/.svg), the
// per-kind byte caps, and the binary path (a PNG/PDF must arrive as BYTES, never as a decoded string).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NOT_PREVIEWABLE, PREVIEWABLE_EXTENSIONS, isBinaryPreviewKind, previewMaxBytes, previewMimeType,
  probePreviewFile, readPreviewFile, toFsPath,
} from "./preview_file.ts";

const io = (content: string, bytes = content.length) => ({ read: () => content, size: () => bytes });

describe("toFsPath (round-trip partner of toFileUrl's percent-encoding)", () => {
  test("decodes %20 segments back to spaces (OneDrive-style dirs)", () => {
    expect(toFsPath("file:///C:/Users/x/OneDrive/Apps%20AI%20Vibe/app.html")).toBe("C:/Users/x/OneDrive/Apps AI Vibe/app.html");
    expect(toFsPath("file:///home/n/my%20app/x.html")).toBe("/home/n/my app/x.html");
  });
  test("decodes %25 back to a literal percent sign", () => {
    expect(toFsPath("file:///C:/Users/n/100%25%20done/x.html")).toBe("C:/Users/n/100% done/x.html");
  });
  test("a bare OS path (no file:// scheme) passes through untouched, %-sequences included", () => {
    expect(toFsPath("C:/Users/n/100% done/x.html")).toBe("C:/Users/n/100% done/x.html");
  });
  test("a malformed %-sequence never throws (falls back to the raw path)", () => {
    expect(toFsPath("file:///C:/Users/n/bad%zz/x.html")).toBe("C:/Users/n/bad%zz/x.html");
  });
});

describe("readPreviewFile", () => {
  test("reads a local .html file's content (+ filename label)", () => {
    const r = readPreviewFile("C:/Users/n/game.html", io("<h1>hi</h1>"));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.html).toBe("<h1>hi</h1>"); expect(r.label).toBe("game.html"); }
  });
  test("strips a file:// scheme before reading", () => {
    const seen: string[] = [];
    const r = readPreviewFile("file:///C:/Users/n/app.html", { read: (p) => { seen.push(p); return "x"; }, size: () => 1 });
    expect(r.ok).toBe(true);
    expect(seen[0]).toBe("C:/Users/n/app.html"); // scheme + leading slash stripped
  });
  test("rejects a non-local path", () => {
    expect(readPreviewFile("game.html", io("x")).ok).toBe(false);            // relative
    expect(readPreviewFile("https://x.com/a.html", io("x")).ok).toBe(false); // remote
  });
  test("rejects a non-previewable extension, and NAMES the kinds it can show (P-PREVIEW.12)", () => {
    const r = readPreviewFile("/home/n/app.ts", io("x"));
    expect(r.ok).toBe(false);
    // The refusal is what the agent reads, so it must say what IS previewable, not just "no".
    if (!r.ok) {
      expect(r.error).toBe(NOT_PREVIEWABLE);
      for (const kind of ["html", "svg", "image", "markdown", "text", "pdf"]) expect(r.error).toContain(kind);
      expect(r.error).not.toContain("\u2014"); // project rule: never an em dash in a user/agent-facing string
    }
    expect(readPreviewFile("/home/n/styles.css", io("x")).ok).toBe(false);
    expect(readPreviewFile("/home/n/setup.exe", io("x")).ok).toBe(false);
  });

  // P-PREVIEW.12: the whole point of the increment. Each of these used to be refused with
  // "not an .html/.svg file", which is why a model could not show a report, a payload, a table or a chart.
  test("reads every text-ish kind and reports its resolved kind + mime", () => {
    for (const [path, kind, mime] of [
      ["/a/app.html", "html", "text/html; charset=utf-8"],
      ["/a/page.htm", "html", "text/html; charset=utf-8"],
      ["/a/logo.svg", "svg", "image/svg+xml; charset=utf-8"],
      ["/a/REPORT.md", "markdown", "text/markdown; charset=utf-8"],
      ["/a/notes.markdown", "markdown", "text/markdown; charset=utf-8"],
      ["/a/data.json", "text", "application/json; charset=utf-8"],
      ["/a/rows.csv", "text", "text/csv; charset=utf-8"],
      ["/a/rows.tsv", "text", "text/tab-separated-values; charset=utf-8"],
      ["/a/run.log", "text", "text/plain; charset=utf-8"],
      ["/a/conf.yaml", "text", "text/plain; charset=utf-8"],
      ["/a/feed.xml", "text", "text/xml; charset=utf-8"],
    ] as const) {
      const r = readPreviewFile(path, io("CONTENT"));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.kind).toBe(kind);
        expect(r.mime).toBe(mime);
        expect(r.html).toBe("CONTENT"); // text kinds land in `html` (field name kept for dev.ts/renderer)
        expect(r.bytes).toBeUndefined(); // ... and never carry bytes
      }
    }
  });

  test("binary kinds are read as BYTES, never decoded as text", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
    let textReadCalled = false;
    const r = readPreviewFile("/a/chart.png", {
      read: () => { textReadCalled = true; return "NEVER"; },
      readBytes: () => png,
      size: () => png.length,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("image");
      expect(r.mime).toBe("image/png");
      expect([...r.bytes!]).toEqual([...png]); // the PNG signature (and the 0xff/0xfe bytes) survive intact
      expect(r.html).toBe("");
    }
    expect(textReadCalled).toBe(false); // a utf8 read here is the corruption bug this guards
  });

  // The real filesystem leg of the same property: a readFileSync(p, "utf8") mangles 0x89/0xff into U+FFFD,
  // so this writes actual PNG bytes to a temp file and asserts they come back identical.
  test("a real PNG on disk round-trips byte-for-byte through readPreviewFile", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x89, 0xff, 0xfe, 0x80, 0x00, 0x7f]);
    const path = join(mkdtempSync(join(tmpdir(), "lucid-preview-")), "chart.png");
    writeFileSync(path, png);
    try {
      const r = readPreviewFile(path);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.kind).toBe("image");
        expect([...r.bytes!]).toEqual([...png]);
        expect(r.label).toBe("chart.png");
      }
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("per-kind caps: 5 MB for text-ish, 25 MB for image/pdf", () => {
    expect(previewMaxBytes("html")).toBe(5 * 1024 * 1024);
    expect(previewMaxBytes("svg")).toBe(5 * 1024 * 1024);
    expect(previewMaxBytes("markdown")).toBe(5 * 1024 * 1024);
    expect(previewMaxBytes("text")).toBe(5 * 1024 * 1024);
    expect(previewMaxBytes("image")).toBe(25 * 1024 * 1024);
    expect(previewMaxBytes("pdf")).toBe(25 * 1024 * 1024);
    expect(isBinaryPreviewKind("image")).toBe(true);
    expect(isBinaryPreviewKind("pdf")).toBe(true);
    for (const k of ["html", "svg", "markdown", "text"] as const) expect(isBinaryPreviewKind(k)).toBe(false);
  });

  test("a 12 MB PDF is fine but a 12 MB markdown file is refused (per-kind cap, still never read)", () => {
    const twelveMb = 12 * 1024 * 1024;
    let read = false;
    const pdf = readPreviewFile("/a/spec.pdf", { readBytes: () => new Uint8Array(4), size: () => twelveMb });
    expect(pdf.ok).toBe(true);
    const md = readPreviewFile("/a/huge.md", { read: () => { read = true; return ""; }, size: () => twelveMb });
    expect(md.ok).toBe(false);
    if (!md.ok) expect(md.error).toMatch(/large/);
    expect(read).toBe(false); // the statSync guard still refuses before anything enters memory
  });

  // Widening the kind table must not leave a kind without a Content-Type: the serve route would send the
  // wrong header and the frame would render a PDF as text (or refuse it under nosniff).
  test("every extension in the kind table has a real mime type (drift guard)", () => {
    for (const ext of PREVIEWABLE_EXTENSIONS) {
      const mime = previewMimeType(`/a/x.${ext}`);
      expect(mime).not.toBe("application/octet-stream");
      expect(mime).toMatch(/^[a-z]+\/[a-z0-9.+-]+/);
    }
    expect(previewMimeType("/a/x.exe")).toBe("application/octet-stream");
    expect(previewMimeType("/a/chart.png?v=2")).toBe("image/png"); // a query never changes the type
  });
  test("rejects a file over the 5 MB cap (never reads it)", () => {
    let readCalled = false;
    const r = readPreviewFile("/a/big.html", { read: () => { readCalled = true; return ""; }, size: () => 6 * 1024 * 1024 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/large/);
    expect(readCalled).toBe(false);
  });
  test("a read/stat failure → typed error, never throws", () => {
    const r = readPreviewFile("/a/missing.html", { read: () => { throw new Error("ENOENT"); }, size: () => { throw new Error("ENOENT"); } });
    expect(r.ok).toBe(false);
  });
});

// P-PREVIEW-PWA.4 (ADR-0335): the missing signal. /api/preview/serve answers a FAILED preview with HTTP 200
// and an HTML body that says so (an iframe pointed at a 404 shows browser error chrome instead), so nothing
// client-side could tell a rendered app from a rendered failure. That is how the phone auto-send captured an
// error page and published it to a guest as a permanent transcript card.
describe("probePreviewFile", () => {
  test("a resolvable target reports its kind", () => {
    const r = probePreviewFile("/a/game.html", { size: () => 1234 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("html");
  });

  test("THE BUG: a missing file does NOT resolve", () => {
    // The exact field-report case: a stale `game.html` the engine could no longer read.
    const r = probePreviewFile("/a/game.html", { size: () => { throw new Error("ENOENT"); } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("file not found or unreadable");
  });

  test("it NEVER reads the file, whatever the size", () => {
    // The whole point of a separate probe: asking "would this render" about a 20 MB PDF must not cost a
    // 20 MB read. `probePreviewFile` takes no reader at all, so this is structural, and the type enforces it.
    const r = probePreviewFile("/a/big.pdf", { size: () => 20 * 1024 * 1024 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("pdf");
  });

  test("it agrees with readPreviewFile on every refusal, so the gate cannot drift from the render", () => {
    const cases: { target: string; size: number }[] = [
      { target: "", size: 1 },
      { target: "http://example.com/x.html", size: 1 },
      { target: "/a/notes.docx", size: 1 },
      { target: "/a/huge.html", size: 6 * 1024 * 1024 },
      { target: "/a/huge.pdf", size: 26 * 1024 * 1024 },
    ];
    for (const c of cases) {
      const probed = probePreviewFile(c.target, { size: () => c.size });
      const read = readPreviewFile(c.target, { read: () => "x", readBytes: () => new Uint8Array(1), size: () => c.size });
      expect(probed.ok).toBe(false);
      expect(read.ok).toBe(false);
      if (!probed.ok && !read.ok) expect(probed.error).toBe(read.error); // same verdict AND same wording
    }
  });

  test("a non-previewable extension is refused with the shared message", () => {
    const r = probePreviewFile("/a/thing.docx", { size: () => 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(NOT_PREVIEWABLE);
  });

  test("the per-kind cap is honored: 5 MB text, 25 MB binary", () => {
    expect(probePreviewFile("/a/x.html", { size: () => 5 * 1024 * 1024 }).ok).toBe(true);
    expect(probePreviewFile("/a/x.html", { size: () => 5 * 1024 * 1024 + 1 }).ok).toBe(false);
    expect(probePreviewFile("/a/x.pdf", { size: () => 25 * 1024 * 1024 }).ok).toBe(true);
    expect(probePreviewFile("/a/x.pdf", { size: () => 25 * 1024 * 1024 + 1 }).ok).toBe(false);
  });
});
