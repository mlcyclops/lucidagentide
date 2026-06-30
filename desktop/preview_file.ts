// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_file.ts — P-PREVIEW.4 (ADR-0096): read a LOCAL previewable file's content for the Preview
// panel to render via the iframe's `srcdoc`. The renderer is served over http, and Chromium blocks a
// `file://` iframe from an http origin, so `iframe.src = file://…` never rendered — we serve the content
// same-origin (behind the transport gate) and srcdoc it instead. Self-contained single-file apps (which is
// what the agent builds) render perfectly this way.
//
// Fail-safe + bounded: only a local `file://`/absolute-path target with an .html/.htm/.svg extension, that
// exists and is ≤ MAX bytes, is read. Anything else is rejected (never throws). The local authenticated user
// could read the file directly anyway; the transport gate (ADR-0022) keeps the endpoint loopback+token only.

import { readFileSync, statSync } from "node:fs";
import { isLocalFileTarget } from "./egress_policy.ts";

const PREVIEWABLE = /\.(html?|svg)$/i;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — generous for a single-file game, bounded against a huge read.

export type PreviewFileResult =
  | { ok: true; html: string; label: string }
  | { ok: false; error: string };

/** Strip a `file://` scheme to an OS path (the resolver/UI may hand us either form). */
function toFsPath(target: string): string {
  const t = target.trim();
  if (!/^file:\/\//i.test(t)) return t;
  let p = t.replace(/^file:\/\//i, "");
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // file:///C:/… → C:/…
  try { return decodeURIComponent(p); } catch { return p; }
}

/** Read a local previewable file's content, or a typed error. Pure-ish (I/O injectable for tests). */
export function readPreviewFile(
  target: string,
  io: { read?: (p: string) => string; size?: (p: string) => number } = {},
): PreviewFileResult {
  const read = io.read ?? ((p) => readFileSync(p, "utf8"));
  const size = io.size ?? ((p) => statSync(p).size);
  if (!target || !isLocalFileTarget(target)) return { ok: false, error: "not a local file path" };
  if (!PREVIEWABLE.test(target)) return { ok: false, error: "not an .html/.svg file" };
  const fsPath = toFsPath(target);
  try {
    if (size(fsPath) > MAX_BYTES) return { ok: false, error: "file too large to preview (>5 MB)" };
    const html = read(fsPath);
    const label = fsPath.split(/[\\/]/).pop() || fsPath;
    return { ok: true, html, label };
  } catch {
    return { ok: false, error: "file not found or unreadable" };
  }
}
