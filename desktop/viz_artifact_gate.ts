// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/viz_artifact_gate.ts - P-WORLDS.BUILD1 (ADR-0653): the engine side of the Visualize artifact popup.
//
// A world build ends in ONE self-contained HTML file an agent wrote (or the ?vizDemo=1 sample). Before the renderer
// may show it, it passes the in-process security gate here (dev.ts POST /api/viz/artifact):
//   shape      a non-empty string of at most VIZ_ARTIFACT_MAX_CHARS that looks like HTML
//   scan       the scanner sidecar through harness/security scanAndDecideLarge (strict DEFAULT_POLICY)
// FAIL-CLOSED (AGENTS.md invariant 3): a scan that throws, answers nothing or answers malformed BLOCKS; a blocked
// artifact is never stored and never served, and the reason goes back to the popup, which says it.
//
// A passed artifact is held in memory (VizArtifactStore: a random id, a TTL, a cap) and served ONLY as
// GET /api/viz/artifact/frame?id= (query token, the /api/preview/serve convention). The served document is a shell
// whose HTTP CSP is the ADR's frame policy, holding the artifact in a `srcdoc` child with sandbox="allow-scripts".
// Why the shell: a srcdoc frame INHERITS its parent's CSP (ADR-0096 addendum P-PREVIEW.4b); directly under the
// renderer (script-src 'self') the artifact's inline script would never run. Under this shell the srcdoc child
// inherits VIZ_ARTIFACT_CSP instead: inline script and style run, every network fetch is refused.
// The renderer's iframe carries sandbox="allow-scripts" as well, so both layers are opaque-origin, never
// same-origin, with no popups, top navigation, forms or downloads.

/** The frame policy the ADR names, plus base-uri and form-action closed (both only tighten it). */
export const VIZ_ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
/** The only sandbox token either frame gets. Never allow-same-origin. */
export const VIZ_ARTIFACT_SANDBOX = "allow-scripts";
export const VIZ_ARTIFACT_MAX_CHARS = 256_000;
/** A held artifact is served this long after it passed. */
export const VIZ_ARTIFACT_TTL_MS = 30 * 60_000;
export const VIZ_ARTIFACT_KEEP = 24;

export interface ArtifactScanVerdict { block: boolean; reason: string }
export type VizArtifactGate = { ok: true } | { ok: false; reason: string };

/** Why `html` cannot even be scanned as an artifact, or null when its shape is acceptable. */
export function artifactShapeProblem(html: unknown): string | null {
  if (typeof html !== "string" || !html.trim()) return "the build produced no HTML file";
  if (html.length > VIZ_ARTIFACT_MAX_CHARS) return `the file is over the ${Math.round(VIZ_ARTIFACT_MAX_CHARS / 1000)} KB limit for a mini game`;
  if (!/<(html|body|script|canvas|div|button|svg)\b/i.test(html)) return "the file does not look like an HTML document";
  return null;
}

/** Shape, then the scan. Any failure to get a valid scan verdict blocks (fail-closed). */
export async function gateVizArtifact(html: unknown, scan: (text: string) => Promise<ArtifactScanVerdict>): Promise<VizArtifactGate> {
  const shape = artifactShapeProblem(html);
  if (shape) return { ok: false, reason: shape };
  let v: unknown;
  try { v = await scan(html as string); } catch { return { ok: false, reason: "fail-closed: the security scan could not run" }; }
  if (!v || typeof v !== "object" || typeof (v as ArtifactScanVerdict).block !== "boolean") return { ok: false, reason: "fail-closed: the security scan gave no valid verdict" };
  const d = v as ArtifactScanVerdict;
  if (d.block) return { ok: false, reason: d.reason ? `the security scan blocked it: ${d.reason}` : "the security scan blocked it" };
  return { ok: true };
}

/** Passed artifacts, by an unguessable id, for VIZ_ARTIFACT_TTL_MS; the oldest goes past VIZ_ARTIFACT_KEEP. */
export class VizArtifactStore {
  readonly #items = new Map<string, { html: string; at: number }>();
  readonly #now: () => number;
  readonly #mintId: () => string;
  constructor(now: () => number = Date.now, mintId: () => string = () => crypto.randomUUID()) { this.#now = now; this.#mintId = mintId; }
  put(html: string): string {
    this.#sweep();
    while (this.#items.size >= VIZ_ARTIFACT_KEEP) { const first = this.#items.keys().next().value; if (first === undefined) break; this.#items.delete(first); }
    const id = this.#mintId();
    this.#items.set(id, { html, at: this.#now() });
    return id;
  }
  get(id: string): string | null {
    this.#sweep();
    return this.#items.get(id)?.html ?? null;
  }
  drop(id: string): boolean { return this.#items.delete(id); }
  #sweep(): void {
    const cut = this.#now() - VIZ_ARTIFACT_TTL_MS;
    for (const [id, it] of this.#items) if (it.at < cut) this.#items.delete(id);
  }
}

/** The served shell: the artifact in a sandboxed srcdoc child that fills the frame (attribute-escaped, so the
 *  artifact cannot close the attribute and add markup to the shell). */
export function artifactFrameDoc(html: string): string {
  const srcdoc = html.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Untrusted artifact</title>`
    + `<style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style></head>`
    + `<body><iframe sandbox="${VIZ_ARTIFACT_SANDBOX}" referrerpolicy="no-referrer" title="Untrusted artifact" srcdoc="${srcdoc}"></iframe></body></html>`;
}

/** The answer for an id that is gone (expired, discarded, or never passed). */
export const ARTIFACT_GONE_DOC = `<!doctype html><html><head><meta charset="utf-8"><title>Artifact gone</title></head><body><p>This artifact is no longer available.</p></body></html>`;

/** Headers for both answers. */
export function artifactFrameHeaders(): Record<string, string> {
  return { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": VIZ_ARTIFACT_CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
}
