// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_file.ts - P-PREVIEW.4 (ADR-0096): read a LOCAL previewable file's content for the Preview
// panel to render. The renderer is served over http, and Chromium blocks a `file://` iframe from an http
// origin, so `iframe.src = file://...` never rendered, so we serve the content same-origin (behind the
// transport gate). Self-contained single-file apps (what the agent builds) render perfectly this way.
//
// P-PREVIEW.12: this reader used to hold its OWN copy of `/\.(html?|svg)$/i`, so an agent that wrote a
// markdown report, a JSON payload, a CSV, a chart PNG or a plain log got "not an .html/.svg file" and had no
// way to show the user its work. The extension set now comes from the ONE kind table in preview_resolve.ts,
// and the result carries the resolved `kind` + `mime` so the serve route knows HOW to serve each one:
//   html / svg / markdown / text  → UTF-8 text, in `html` (field name kept: dev.ts + the renderer read it)
//   image / pdf                   → RAW BYTES, in `bytes` (a readFileSync(p, "utf8") corrupts a PNG)
// Text-ish kinds keep the 5 MB cap (a 25 MB markdown file is a mistake); image/pdf get 25 MB (a 25 MB PDF is
// ordinary). The statSync-before-read guard stays, so an oversized file is refused without being read at all.
//
// Fail-safe + bounded: only a local `file://`/absolute-path target whose extension is in the kind table, that
// exists and is within its per-kind cap, is read. Anything else is rejected (never throws). The local
// authenticated user could read the file directly anyway; the transport gate (ADR-0022) keeps the endpoint
// loopback+token only.

import { readFileSync, statSync } from "node:fs";
import { isLocalFileTarget } from "./egress_policy.ts";
import { PREVIEWABLE_EXT, PREVIEW_KIND_EXT, previewKindOf, type PreviewKind } from "./preview_resolve.ts";

/** 5 MB for text-ish kinds: generous for a single-file game, and a bigger text file is a mistake, not a doc. */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** 25 MB for image/pdf: a scanned PDF or a high-res chart legitimately runs this big. */
const MAX_BINARY_BYTES = 25 * 1024 * 1024;

/** P-PREVIEW.12: kinds whose payload is BYTES, not text. Decoding these as UTF-8 corrupts them. */
export function isBinaryPreviewKind(kind: PreviewKind): boolean {
  return kind === "image" || kind === "pdf";
}

/** P-PREVIEW.12: the read cap for a kind. Per-kind rather than one global number, because the two classes
 *  have genuinely different honest sizes (see MAX_TEXT_BYTES / MAX_BINARY_BYTES). */
export function previewMaxBytes(kind: PreviewKind): number {
  return isBinaryPreviewKind(kind) ? MAX_BINARY_BYTES : MAX_TEXT_BYTES;
}

// Content-Type per EXTENSION (not per kind: .json and .csv are both `text`, but a browser wants them typed
// differently). Keyed off the same extensions as PREVIEW_KIND_EXT; preview_file.test.ts asserts every
// extension in that table has an entry here, so widening the kind table cannot leave a kind untyped.
const MIME: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  md: "text/markdown; charset=utf-8", markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8", json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8",
  log: "text/plain; charset=utf-8", yml: "text/plain; charset=utf-8", yaml: "text/plain; charset=utf-8",
  xml: "text/xml; charset=utf-8", toml: "text/plain; charset=utf-8", ini: "text/plain; charset=utf-8",
  pdf: "application/pdf",
};

/** The Content-Type to serve this previewable path with, or octet-stream when it isn't previewable. Pure. */
export function previewMimeType(path: string): string {
  const m = PREVIEWABLE_EXT.exec((path ?? "").trim());
  return (m && MIME[m[1]!.toLowerCase()]) || "application/octet-stream";
}

/** Every extension the panel accepts, as one flat lowercase list. Used by the MIME drift test. */
export const PREVIEWABLE_EXTENSIONS: readonly string[] = Object.values(PREVIEW_KIND_EXT).flat();

/** The refusal for a file whose extension is not in the kind table. Names the kinds so the agent (which sees
 *  this string through preview_open / the serve route) learns what it CAN show instead of just being refused. */
export const NOT_PREVIEWABLE = "not a previewable file (html, svg, image, markdown, text, or pdf)";

export type PreviewFileResult =
  | {
      ok: true;
      /** The file's TEXT for html/svg/markdown/text kinds; "" for image/pdf (their payload is `bytes`).
       *  Named `html` for compatibility: dev.ts and the renderer already read this field. */
      html: string;
      /** Filename for the panel header / chip. */
      label: string;
      /** P-PREVIEW.12: which kind this file renders as, so the caller knows HOW to serve it. */
      kind: PreviewKind;
      /** Content-Type for the serve route. */
      mime: string;
      /** RAW bytes for image/pdf kinds; absent for text kinds. */
      bytes?: Uint8Array;
    }
  | { ok: false; error: string };

/** Strip a `file://` scheme to an OS path (the resolver/UI may hand us either form). Exported so the
 *  serve endpoint can derive the app's directory for relative-asset inlining (P-PREVIEW.4c). */
export function toFsPath(target: string): string {
  const t = target.trim();
  if (!/^file:\/\//i.test(t)) return t;
  let p = t.replace(/^file:\/\//i, "");
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // file:///C:/… → C:/…
  try { return decodeURIComponent(p); } catch { return p; }
}

/** Read a local previewable file, or a typed error. Pure-ish (I/O injectable for tests). Text kinds land in
 *  `html`, binary kinds in `bytes`; the size guard runs BEFORE any read so an oversized file never enters
 *  memory. Never throws. */
export function readPreviewFile(
  target: string,
  io: { read?: (p: string) => string; readBytes?: (p: string) => Uint8Array; size?: (p: string) => number } = {},
): PreviewFileResult {
  const read = io.read ?? ((p) => readFileSync(p, "utf8"));
  const readBytes = io.readBytes ?? ((p) => readFileSync(p));
  const size = io.size ?? ((p) => statSync(p).size);
  if (!target || !isLocalFileTarget(target)) return { ok: false, error: "not a local file path" };
  const kind = previewKindOf(target);
  if (!kind) return { ok: false, error: NOT_PREVIEWABLE };
  const fsPath = toFsPath(target);
  const cap = previewMaxBytes(kind);
  try {
    if (size(fsPath) > cap) return { ok: false, error: `file too large to preview (over ${Math.round(cap / (1024 * 1024))} MB)` };
    const label = fsPath.split(/[\\/]/).pop() || fsPath;
    const mime = previewMimeType(fsPath);
    // A PNG/PDF read as a string is silently mangled by UTF-8 replacement chars, so binary kinds take the
    // bytes path and leave `html` empty; the serve route writes `bytes` with `mime` and never touches `html`.
    if (isBinaryPreviewKind(kind)) return { ok: true, html: "", label, kind, mime, bytes: readBytes(fsPath) };
    return { ok: true, html: read(fsPath), label, kind, mime };
  } catch {
    return { ok: false, error: "file not found or unreadable" };
  }
}
