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
//   EXCLUDED on purpose: allow-same-origin (would let it read LUCID's storage), allow-top-navigation
//   (would let it navigate LUCID away), allow-popups, allow-modals, allow-pointer-lock, allow-downloads.
export const PREVIEW_SANDBOX = "allow-scripts allow-forms";
// Permissions-Policy for the frame: deny every powerful feature (camera, mic, geolocation, etc.). Empty = none.
export const PREVIEW_ALLOW = "";
/** Sandbox tokens that must NEVER appear (they'd defeat the opaque-origin isolation). Used by the test. */
export const PREVIEW_SANDBOX_FORBIDDEN = ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-modals", "allow-pointer-lock", "allow-downloads"] as const;

export type PreviewKind = "local" | "remote" | "blocked";

export interface PreviewTarget {
  kind: PreviewKind;
  /** The value to put in the iframe `src` for a local target; "" for remote/blocked (not auto-loaded). */
  src: string;
  /** A short human label for the panel header / chip. */
  label: string;
  /** Why a target was blocked (empty for local/remote). */
  reason?: string;
}

/** Normalize a local path/`file://` target to a `file://` URL the iframe can load. Leaves an existing
 *  file:// URL alone; turns a Windows/UNC/POSIX path into file:// with backslashes flipped. Pure. */
export function toFileUrl(target: string): string {
  const t = target.trim();
  if (/^file:\/\//i.test(t)) return t;
  let p = t.replace(/\\/g, "/");
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
  const p = typeof (rawInput ?? {}).path === "string" ? rawInput.path.trim() : "";
  return p || null;
}

/** File extensions we can render directly in the sandboxed preview iframe (a self-contained page). */
const PREVIEWABLE_EXT = /\.(html?|svg)$/i;
/** Tool names that WRITE a file (omp's write/edit family). Read/search/etc. never auto-surface a preview. */
const WRITE_TOOLS = /\b(write|edit|create|save)\b/i;

/** If `toolName` is a write/edit of a browser-previewable file, return its path; else null. Pure, defensive:
 *  pulls the path from the common rawInput shapes (path/file_path/filename/file), trims, and requires both a
 *  write-class tool AND a previewable extension — so a `read` of an .html, or a write of a .ts, won't fire. */
export function previewablePath(toolName: string | null | undefined, rawInput: any): string | null {
  const name = (toolName ?? "").toLowerCase();
  if (!WRITE_TOOLS.test(name)) return null;
  const ri = rawInput ?? {};
  let path = "";
  for (const k of ["path", "file_path", "filePath", "filename", "file", "target"]) {
    if (typeof ri[k] === "string" && ri[k].trim()) { path = ri[k].trim(); break; }
  }
  if (!path || !PREVIEWABLE_EXT.test(path)) return null;
  return path;
}

/** Resolve a preview target into a safe, labeled render decision. Fail-safe: only a clearly-local file is
 *  rendered; http(s) is flagged `remote` (not loaded here — P-PREVIEW.3); everything else is `blocked`. */
export function resolvePreview(target: string | null | undefined): PreviewTarget {
  const t = (target ?? "").trim();
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
