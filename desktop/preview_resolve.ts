// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_resolve.ts — P-PREVIEW.1 (ADR-0096): the pure rule that turns a preview target (a path
// the agent just wrote, or a URL) into a safe thing to render in the Preview panel's sandboxed <iframe>.
//
// The panel renders UNTRUSTED, agent-authored code, so this resolver is fail-safe: only a clearly-local
// file becomes a rendered `file://` src; a real http(s) URL is RECOGNIZED but not auto-loaded in this
// increment (remote is egress-gated in P-PREVIEW.3); anything ambiguous or empty is BLOCKED, never silently
// rendered. Pure — no I/O — so it is testable and shared between the renderer and (later) the agent tools.

import { isLocalFileTarget } from "./egress_policy.ts";

// P-PREVIEW.3 (ADR-0096): the hardened sandbox the preview <iframe> runs untrusted, agent-authored code in.
// Single source of truth so the markup and the security tests can't drift. The allowlist is deliberately
// MINIMAL — every powerful capability stays OFF:
//   allow-scripts  → the app needs to run JS (without allow-same-origin this is an OPAQUE origin: the page
//                    cannot read LUCID's origin, cookies, or localStorage).
//   allow-forms    → a previewed app may submit a form to itself; harmless in an opaque origin.
//   allow-modals   → P-PREVIEW.13: `alert()` / `confirm()` / `prompt()` THROW in a sandbox without this,
//                    and an uncaught throw aborts the rest of the page's script, so a demo whose first
//                    action is `alert('welcome')` rendered as a dead page. The grant is frame-confined by
//                    spec: a modal cannot reach the parent, the network, or another origin. Its only real
//                    cost is that a page can block its own frame, which the user closes or reloads.
//   EXCLUDED on purpose: allow-same-origin (would let it read LUCID's storage AND put untrusted previewed
//   code inside the origin that holds the per-launch capability token), allow-top-navigation (would let it
//   navigate LUCID away), allow-popups, allow-pointer-lock, allow-downloads.
//
//   NOTE on storage: because allow-same-origin stays OFF, `localStorage` / `sessionStorage` remain
//   unreachable here BY DESIGN. They are not fixed with a sandbox grant; the served document gets an
//   in-memory Storage from PREVIEW_SHIM_JS instead (desktop/preview_bridge.ts), which keeps the origin
//   opaque. See that file's header for why the obvious grant is the wrong answer.
export const PREVIEW_SANDBOX = "allow-scripts allow-forms allow-modals";
// Permissions-Policy for the frame: deny every powerful feature (camera, mic, geolocation, etc.). Empty = none.
export const PREVIEW_ALLOW = "";

// P-PREVIEW.4b (ADR-0096): the CSP for a SERVED preview document (loaded via `iframe.src` from
// `/api/preview/serve`, NOT srcdoc). A `srcdoc` frame INHERITS the renderer's strict `script-src 'self'`
// CSP, which blocks a previewed app's inline <script> — so the app's JS never ran and only its static HTML
// painted (the bug behind "only the HUD shows"). A document loaded via `src` carries its OWN CSP instead,
// so this per-frame policy lets a self-contained app actually RUN — inline JS/CSS, inline event handlers,
// data/blob images + audio, synthesized Web Audio, blob workers — while still:
//   • `connect-src 'none'` — NO network egress: a previewed, agent-authored app cannot fetch/XHR/WebSocket
//     out, so it can never bypass LUCID's egress gate (this used to ride on the inherited CSP; now explicit).
//   • paired with the opaque-origin sandbox (PREVIEW_SANDBOX, no allow-same-origin) so it can't read
//     LUCID's origin/storage, navigate the top frame, or open popups.
// `base-uri 'none'` + `form-action 'none'` close the remaining redirect/exfil seams.
export const PREVIEW_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "worker-src blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");
/** Sandbox tokens that must NEVER appear (they'd defeat the opaque-origin isolation). Used by the test.
 *
 *  P-PREVIEW.13: `allow-modals` was removed from this list and is now GRANTED. It is the one token here
 *  that never crossed the isolation boundary: a modal is frame-confined by spec and reaches no other
 *  origin, no parent, and no network. It sat in this list because the list started as "everything we do
 *  not need", not "everything that would break isolation". Keeping it here cost real function, because
 *  `alert()` THROWS without it and an uncaught throw aborts the page's remaining script. Every token
 *  still listed below is a genuine escape or escalation: same-origin would place untrusted previewed code
 *  inside the origin holding the capability token; top-navigation could navigate LUCID away; popups,
 *  pointer-lock and downloads all reach beyond the frame. */
export const PREVIEW_SANDBOX_FORBIDDEN = ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-pointer-lock", "allow-downloads"] as const;

// P-PREVIEW.12: the resolver's OWN verdict labels. Renamed off `PreviewKind` (which now names the FILE-kind
// union below) because one module cannot own two unions called the same thing, and the file kind is the one
// every other preview module needs to import.
export type PreviewTargetKind = "local" | "remote" | "blocked";

export interface PreviewTarget {
  kind: PreviewTargetKind;
  /** The value to put in the iframe `src` for a local target; "" for remote/blocked (not auto-loaded). */
  src: string;
  /** A short human label for the panel header / chip. */
  label: string;
  /** Why a target was blocked (empty for local/remote). */
  reason?: string;
}

/** Trim and strip matching pairs of surrounding single/double quotes: agents sometimes hand us a quoted
 *  path ('"C:\\x\\app.html"'), which would otherwise fail the local-file gate and block the preview. Pure. */
export function normalizePreviewPath(raw: string | null | undefined): string {
  let p = (raw ?? "").trim();
  while (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) {
    p = p.slice(1, -1).trim();
  }
  return p;
}

/** Percent-encode an OS path (already forward-slashed) for a file:// URL, per segment so "/" separators
 *  survive. The leading Windows drive segment stays LITERAL: encodeURIComponent("C:") is "C%3A", which
 *  breaks drive letters. Round-trips through preview_file.ts toFsPath's decodeURIComponent. */
function encodeFileUrlPath(p: string): string {
  return p.split("/").map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join("/");
}

/** Normalize a local path/`file://` target to a `file://` URL the iframe can load. Percent-encodes path
 *  segments (spaces in OneDrive-style dirs used to yield broken URLs); turns a Windows/UNC/POSIX path into
 *  file:// with backslashes flipped. An existing file:// URL is presumed already encoded and only literal
 *  spaces (never valid in a URL) are fixed up - %20 is never double-encoded. Pure. */
export function toFileUrl(target: string): string {
  const t = target.trim();
  if (/^file:\/\//i.test(t)) return t.replace(/ /g, "%20");
  const p = encodeFileUrlPath(t.replace(/\\/g, "/"));
  if (/^[A-Za-z]:\//.test(p)) return `file:///${p}`;       // C:/Users/... → file:///C:/Users/...
  if (p.startsWith("//")) return `file:${p}`;               // //server/share → file://server/share (UNC)
  if (p.startsWith("/")) return `file://${p}`;              // /home/n/x.html → file:///home/n/x.html
  return `file://${p}`;
}

// P-PREVIEW.2 (ADR-0096): auto-surface the app the agent just built. When the agent's write/edit tool
// produces a browser-previewable file, LUCID lights up the Preview panel on it — no custom agent tool, just
// the desktop reacting to the tool stream it already sees. This pure helper decides whether a tool call is
// such a write, and returns the path to preview (else null). Tested + demoed.

/** P-PREVIEW.3b (ADR-0096): may a REMOTE URL load in the preview iframe? Two conditions, both required:
 *  the egress allow-list already approves the site (`egressAllowed`, decided desktop-side by the egress gate
 *  ADR-0062/0094), AND it's https (no plaintext http into the sandbox). Pure — the gating is testable. */
export function canPreviewRemote(url: string | null | undefined, egressAllowed: boolean): boolean {
  return egressAllowed && /^https:\/\//i.test((url ?? "").trim());
}

/** P-PREVIEW.3a (ADR-0096): if this tool_call is the agent's `preview_open`, return the path it asked to
 *  preview (else null). Lets acp_backend drive the panel from the agent's own tool call — "the agent drives
 *  the preview". Pure; the path is still re-gated by resolvePreview before anything renders. */
export function previewOpenPath(toolName: string | null | undefined, rawInput: any): string | null {
  if (!/\bpreview_open\b/i.test(toolName ?? "")) return null;
  const p = normalizePreviewPath(typeof (rawInput ?? {}).path === "string" ? rawInput.path : "");
  return p || null;
}

// P-PREVIEW.12: what the panel can render, BY EXTENSION, as ONE table. This used to be a bare
// `/\.(html?|svg)$/i` copied into preview_file.ts and renderer/preview_tabs.ts, and it was the single
// biggest reason "the model can't show me what it built": a markdown report, a JSON payload, a CSV, a chart
// PNG or a plain log was refused with "not a local .html/.svg file", so the agent had no way to surface most
// of what it produces. Widened to every kind the sandboxed frame can honestly render, and the regex below is
// DERIVED from this table so adding an extension in one place can never leave the other behind.
export type PreviewKind = "html" | "svg" | "image" | "markdown" | "text" | "pdf";

/** The ONE previewable-extension set (lowercase, no leading dot). Exported so a self-contained mirror of it
 *  (harness/omp/preview_extension.ts, which runs in omp's subprocess and must not import desktop code) can
 *  be pinned against it by a drift test instead of quietly diverging. */
export const PREVIEW_KIND_EXT: Readonly<Record<PreviewKind, readonly string[]>> = {
  html: ["html", "htm"],
  svg: ["svg"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"],
  markdown: ["md", "markdown"],
  text: ["txt", "json", "csv", "tsv", "log", "yml", "yaml", "xml", "toml", "ini"],
  pdf: ["pdf"],
};

/** Flattened extension -> kind lookup, built once from PREVIEW_KIND_EXT. */
const EXT_KIND: ReadonlyMap<string, PreviewKind> = new Map(
  (Object.entries(PREVIEW_KIND_EXT) as Array<[PreviewKind, readonly string[]]>)
    .flatMap(([kind, exts]) => exts.map((ext) => [ext, kind] as [string, PreviewKind])),
);

/** File extensions we can render in the sandboxed preview iframe. BUILT from PREVIEW_KIND_EXT (never hand
 *  written) so the table and the regex cannot drift. A trailing query/hash (`chart.png?v=2`, `page.html#top`)
 *  and trailing whitespace still classify; `index.html.bak` and a bare `html` do not (the dot is required and
 *  the extension must be last). Case-insensitive. */
export const PREVIEWABLE_EXT: RegExp = new RegExp(String.raw`\.(${[...EXT_KIND.keys()].join("|")})(?:[?#][\s\S]*)?\s*$`, "i");

/** P-PREVIEW.12: which PreviewKind this path renders as, or null when the panel cannot show it. Pure; the
 *  single classifier behind preview_file.ts's reader, the renderer's tab strip, and previewablePath below. */
export function previewKindOf(path: string | null | undefined): PreviewKind | null {
  const m = PREVIEWABLE_EXT.exec((path ?? "").trim());
  return m ? EXT_KIND.get(m[1]!.toLowerCase()) ?? null : null;
}

/** Tool names that WRITE a file (omp's write/edit family). Read/search/etc. never auto-surface a preview. */
const WRITE_TOOLS = /\b(write|edit|create|save)\b/i;

/** If `toolName` is a write/edit of a previewable file, return its path; else null. Pure, defensive: pulls the
 *  path from the common rawInput shapes (path/file_path/filename/file), trims, and requires both a write-class
 *  tool AND a previewable extension - so a `read` of an .html, or a write of a .ts, won't fire. P-PREVIEW.12:
 *  the write-class gate is what stops a `read` of some random .png hijacking the panel, so it stays; the kind
 *  table widening means a written .md/.json/.csv/.png report now auto-surfaces the same way an .html does. */
export function previewablePath(toolName: string | null | undefined, rawInput: any): string | null {
  const name = (toolName ?? "").toLowerCase();
  if (!WRITE_TOOLS.test(name)) return null;
  const ri = rawInput ?? {};
  let path = "";
  for (const k of ["path", "file_path", "filePath", "filename", "file", "target"]) {
    if (typeof ri[k] === "string" && normalizePreviewPath(ri[k])) { path = normalizePreviewPath(ri[k]); break; }
  }
  if (!path || !PREVIEWABLE_EXT.test(path)) return null;
  return path;
}

/** Resolve a preview target into a safe, labeled render decision. Fail-safe: only a clearly-local file is
 *  rendered; http(s) is flagged `remote` (not loaded here — P-PREVIEW.3); everything else is `blocked`. */
export function resolvePreview(target: string | null | undefined): PreviewTarget {
  const t = normalizePreviewPath(target);
  if (!t) return { kind: "blocked", src: "", label: "(nothing to preview)", reason: "empty target" };
  if (isLocalFileTarget(t)) {
    const src = toFileUrl(t);
    return { kind: "local", src, label: t.replace(/^file:\/\/\/?/i, "").split(/[\\/]/).pop() || t };
  }
  if (/^https?:\/\//i.test(t)) {
    // Recognized, but a remote page (and the fetches it makes) is an egress concern — gated in P-PREVIEW.3,
    // not auto-loaded here. Surfaced so the UI can offer "open via the egress gate" rather than silently load.
    return { kind: "remote", src: "", label: t, reason: "remote URLs are gated (P-PREVIEW.3)" };
  }
  return { kind: "blocked", src: "", label: t.slice(0, 80), reason: "not a local file or http(s) URL" };
}
