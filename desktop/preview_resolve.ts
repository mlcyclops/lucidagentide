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
