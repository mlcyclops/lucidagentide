// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_inline.ts — P-PREVIEW.4c (ADR-0096): make MULTI-FILE apps previewable by INLINING their
// own relative assets into the served HTML, instead of widening the frame's CSP to reach the serving origin.
//
// The preview frame is opaque-origin + carries PREVIEW_FRAME_CSP (`connect-src 'none'`, no remote origins).
// A single file renders fine, but an app that splits into `index.html` + `style.css` + `game.js` can't load
// those relative refs — the frame's origin is opaque, so `'self'` matches nothing, and we must NOT allow the
// serving origin (that would let the sandboxed frame reach LUCID's own same-origin URLs). Instead we resolve
// the app's OWN relative `<link>`/`<script src>`/`<img src>` (and CSS `url(...)`) and fold them inline:
//   <link rel=stylesheet href=x.css>  →  <style>…</style>
//   <script src=game.js></script>     →  <script>…</script>
//   <img src=sprite.png> / url(f.png) →  data: URI
// This fits the EXISTING per-frame CSP exactly (`'unsafe-inline'` scripts/styles + `data:` img/font/media are
// already allowed, egress stays blocked). No CSP change, no second server, no base-URL/origin widening.
//
// Fail-SAFE + BOUNDED: only PURE-relative refs are touched (never a scheme/`//`/root-absolute/`#`, never a
// `..` traversal, never outside the app's own directory); a ref that can't be read is left as-is (the CSP
// then blocks it); per-asset and total byte caps prevent a runaway inline. Pure — I/O is injected — so the
// whole thing is unit-tested without a filesystem.

import { previewKindOf, type PreviewKind } from "./preview_resolve.ts"; // P-PREVIEW.12: the ONE kind table

/** Injected file reader (real impl reads the app's directory; tests pass fakes). */
export interface InlineIO {
  readText: (path: string) => string;
  readBytes: (path: string) => Uint8Array;
}

const DEFAULTS = { maxAssetBytes: 2 * 1024 * 1024, maxTotalBytes: 12 * 1024 * 1024 };

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp", avif: "image/avif",
  woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", webm: "video/webm", mp4: "video/mp4",
};
const mimeOf = (p: string): string => MIME[(p.split(".").pop() || "").toLowerCase()] ?? "application/octet-stream";

/** Resolve a PURE-relative ref against the app's directory, or null if it must not be inlined (scheme,
 *  protocol-relative, root-absolute, anchor, empty, or any `..` traversal). Query/hash are stripped. Pure. */
export function resolveLocalRef(baseDir: string, ref: string): string | null {
  const raw = (ref ?? "").trim().split(/[?#]/)[0]!.trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;    // scheme (http:, data:, blob:, javascript:, mailto:…)
  if (raw.startsWith("//") || raw.startsWith("/") || raw.startsWith("#") || raw.startsWith("\\")) return null; // protocol-rel / root / anchor
  const parts = raw.replace(/^\.\//, "").split(/[\\/]/);
  if (parts.some((s) => s === ".." )) return null;      // no escaping the app directory
  const base = baseDir.replace(/[\\/]+$/, "");
  return `${base}/${parts.filter((s) => s && s !== ".").join("/")}`;
}

/** Inline an app's own relative CSS/JS/image/font assets into `html`. Best-effort + bounded; never throws. */
export function inlinePreviewAssets(
  html: string,
  baseDir: string,
  io: InlineIO,
  opts: { maxAssetBytes?: number; maxTotalBytes?: number } = {},
): string {
  const maxAsset = opts.maxAssetBytes ?? DEFAULTS.maxAssetBytes;
  const box = { budget: opts.maxTotalBytes ?? DEFAULTS.maxTotalBytes }; // shared across nested-iframe recursion
  return inlineInto(html, baseDir, io, maxAsset, box, 0);
}

const MAX_IFRAME_DEPTH = 2; // wrapper → app → one more; caps recursion (and a self-referential wrapper)
/** Escape a string for use as a double-quoted HTML attribute value (for `srcdoc`). */
const attrEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** The recursive worker (see inlinePreviewAssets). `box.budget` is shared so nested iframes can't blow the cap. */
function inlineInto(html: string, baseDir: string, io: InlineIO, maxAsset: number, box: { budget: number }, depth: number): string {
  const readTextAsset = (ref: string): string | null => {
    const p = resolveLocalRef(baseDir, ref);
    if (!p) return null;
    try {
      const t = io.readText(p);
      const bytes = Buffer.byteLength(t, "utf8");
      if (bytes > maxAsset || bytes > box.budget) return null;
      box.budget -= bytes;
      return t;
    } catch { return null; }
  };
  const readDataUri = (ref: string): string | null => {
    const p = resolveLocalRef(baseDir, ref);
    if (!p) return null;
    try {
      const b = io.readBytes(p);
      if (b.length > maxAsset || b.length > box.budget) return null;
      box.budget -= b.length;
      return `data:${mimeOf(p)};base64,${Buffer.from(b).toString("base64")}`;
    } catch { return null; }
  };

  // Rewrite CSS `url(ref)` → data: (fonts/images). Skips anything resolveLocalRef rejects. Used on inlined
  // <link> CSS and on existing inline <style> blocks. `<` can't legally appear in a url() so `</style>`
  // injection isn't possible; we still guard by only substituting a data: URI we built ourselves.
  const inlineCssUrls = (css: string): string =>
    css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, _q, ref) => {
      const data = readDataUri(String(ref));
      return data ? `url(${data})` : m;
    });

  let out = html;

  // 1) <link rel="stylesheet" href="REL"> → <style>…</style>
  out = out.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag)) return tag;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) return tag;
    const css = readTextAsset(href);
    return css == null ? tag : `<style>\n${inlineCssUrls(css)}\n</style>`;
  });

  // 2) <script src="REL" …></script> → <script …>…</script> (drop src; keep type=module etc.)
  out = out.replace(/<script\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, pre, src, post) => {
    const js = readTextAsset(String(src));
    if (js == null) return tag;
    const attrs = `${String(pre)} ${String(post)}`.replace(/\s+/g, " ").trim();
    // Neutralize any accidental </script> in the file so it can't break out of the inline block.
    const safe = js.replace(/<\/script/gi, "<\\/script");
    return `<script${attrs ? " " + attrs : ""}>\n${safe}\n</script>`;
  });

  // 3) <img src="REL"> → data: (and srcset left alone; too rarely relative to be worth the complexity)
  out = out.replace(/(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'])/gi, (m, pre, src, post) => {
    const data = readDataUri(String(src));
    return data ? `${pre}${data}${post}` : m;
  });

  // 4) url(REL) inside existing inline <style> blocks → data: (fonts/bg images the author wrote inline)
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open, body, close) => `${open}${inlineCssUrls(String(body))}${close}`);

  // 5) <iframe src="REL.html"> → srcdoc with the target inlined (the "self-test wrapper" pattern the agent
  //    writes: one page whose whole body is <iframe src="game.html">). The target is read, RECURSIVELY inlined
  //    (its own assets), and folded into `srcdoc` so it renders under the same frame CSP. Any query is dropped
  //    (srcdoc has no URL) — fine, since the embedded page renders normally without it. Depth-capped.
  if (depth < MAX_IFRAME_DEPTH) {
    out = out.replace(/(<iframe\b[^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*>)/gi, (tag, pre, src, post) => {
      const p = resolveLocalRef(baseDir, String(src));
      if (!p || previewKindOf(p) !== "html") return tag;          // only inline a local .html/.htm target
      const child = readTextAsset(String(src));
      if (child == null) return tag;
      const childDir = p.replace(/[\\/][^\\/]*$/, "");
      const inlined = inlineInto(child, childDir, io, maxAsset, box, depth + 1);
      return `${pre} srcdoc="${attrEscape(inlined)}"${post}`;     // drop src; carry the inlined doc
    });
  }

  return out;
}

// ── P-PREVIEW.12: make the frame CSP LEGIBLE ────────────────────────────────────────────────────────────
// The CSP above is load-bearing and stays exactly as it is: no remote origins, `connect-src 'none'`. But it
// used to fail SILENTLY. A model that wrote a page pulling Chart.js / three.js / Tailwind off a CDN, or a
// remote <img>, or a webfont, or calling fetch(), got a blank or half-painted frame with nothing explaining
// it: the user saw an empty panel and the AGENT got no feedback at all, so it could not self-correct and
// kept writing the same CDN <script> next turn. These helpers close that loop without opening the egress:
// findBlockedRefs REPORTS what the CSP will refuse, blockedRefsMessage turns it into one actionable sentence
// for the agent-facing tool result, and blockedRefsBanner/injectBlockedRefsBanner put the same sentence on
// the page so the human is never staring at a blank frame. Pure (no DOM, no fs), so all of it is unit-tested.

export interface BlockedRef { kind: "script" | "style" | "image" | "font" | "frame" | "fetch"; url: string }

/** Report order (also the counting order in blockedRefsMessage) so the output is deterministic. */
const BLOCKED_KINDS = ["script", "style", "image", "font", "frame", "fetch"] as const;
/** Payload bounds: a pathological/generated file must not blow up a tool result or the injected banner. */
const MAX_BLOCKED_REFS = 20;
const MAX_BLOCKED_URL = 300;

/** Is this ref one the frame CSP will refuse? An absolute http(s) URL, or a PROTOCOL-RELATIVE `//host/x`
 *  (which inherits the frame's scheme and is just as remote). Relative refs, `data:`, `blob:`, `#anchor`
 *  and root-absolute `/x` are all NOT remote: the inliner handles the relative ones and the CSP already
 *  allows data:/blob:. Pure, and deliberately the mirror image of resolveLocalRef's refusals. */
const isRemoteRef = (ref: string | null | undefined): boolean => /^(?:https?:)?\/\//i.test((ref ?? "").trim());

// Attribute readers. Quoted or bare, case-insensitive; run against the captured attribute text of ONE tag.
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const HREF_ATTR = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const REL_ATTR = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const AS_ATTR = /\bas\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const attrOf = (attrs: string, re: RegExp): string | null => {
  const m = re.exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
};

/** Every `url(...)` value inside a CSS string. Same shape the inliner rewrites, so the two agree on what a
 *  ref IS: whatever the inliner did not fold in (because it is remote) is exactly what the CSP will refuse. */
const cssUrls = (css: string): string[] =>
  [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)].map((m) => String(m[2] ?? ""));

// Absolute-URL network calls in INLINE script text. `connect-src 'none'` refuses these, and a model that
// fetches its data from an API sees only a rejected promise. (WebSocket/EventSource are refused by the same
// directive; they are not reported here because a preview page realistically uses fetch or XHR.)
const FETCH_CALL = /\bfetch\s*\(\s*(['"`])((?:https?:)?\/\/[^'"`]+)\1/gi;
const XHR_OPEN = /\.open\s*\(\s*(['"`])[A-Za-z]+\1\s*,\s*(['"`])((?:https?:)?\/\/[^'"`]+)\2/gi;

/** P-PREVIEW.12: the remote references this document contains that the preview frame CSP will refuse.
 *  Deduped by kind+url, ordered by BLOCKED_KINDS, capped at MAX_BLOCKED_REFS. Pure: markup in, facts out.
 *  Run it on the ALREADY-INLINED html, so a relative ref the inliner folded in is never reported. */
export function findBlockedRefs(html: string): BlockedRef[] {
  const buckets = new Map<BlockedRef["kind"], BlockedRef[]>();
  const seen = new Set<string>();
  const add = (kind: BlockedRef["kind"], ref: string | null | undefined): void => {
    const url = (ref ?? "").trim().slice(0, MAX_BLOCKED_URL);
    if (!url || !isRemoteRef(url)) return;
    const key = `${kind}\u0000${url}`;
    if (seen.has(key)) return;
    const bucket = buckets.get(kind) ?? [];
    if (bucket.length >= MAX_BLOCKED_REFS) return; // per-kind bound: the flatten below caps the total too
    seen.add(key);
    bucket.push({ kind, url });
    buckets.set(kind, bucket);
  };

  // 1) Tags that pull a subresource. One sweep over the same markup the inliner rewrites.
  for (const m of (html ?? "").matchAll(/<(script|link|img|source|video|audio|iframe)\b([^>]*)>/gi)) {
    const tag = String(m[1] ?? "").toLowerCase();
    const attrs = String(m[2] ?? "");
    if (tag === "script") { add("script", attrOf(attrs, SRC_ATTR)); continue; }
    if (tag === "iframe") { add("frame", attrOf(attrs, SRC_ATTR)); continue; }
    if (tag === "link") {
      const rel = (attrOf(attrs, REL_ATTR) ?? "").toLowerCase();
      const href = attrOf(attrs, HREF_ATTR);
      if (/\bstylesheet\b/.test(rel)) { add("style", href); continue; }
      if (/\bmodulepreload\b/.test(rel)) { add("script", href); continue; }
      // A preload/prefetch is classified by what it preloads: `as=font` is the webfont case the CSP's
      // `font-src data:` refuses, and the rest map onto their own directive.
      if (/\b(?:preload|prefetch)\b/.test(rel)) {
        const as = (attrOf(attrs, AS_ATTR) ?? "").toLowerCase();
        if (as === "font") add("font", href);
        else if (as === "style") add("style", href);
        else if (as === "script") add("script", href);
        else if (as === "image") add("image", href);
      }
      continue;
    }
    add("image", attrOf(attrs, SRC_ATTR)); // img / source / video / audio
  }

  // 2) Inline <style> blocks: an @font-face url() is a FONT; any other remote url() is an image/background.
  for (const sm of (html ?? "").matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const rest = String(sm[1] ?? "").replace(/@font-face\s*\{[^}]*\}/gi, (block) => {
      for (const u of cssUrls(block)) add("font", u);
      return " "; // consumed, so the sweep below cannot double-count it as an image
    });
    for (const u of cssUrls(rest)) add("image", u);
  }

  // 3) Inline script text: absolute-URL fetch/XHR. An external <script src> is already counted in (1).
  for (const sm of (html ?? "").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = String(sm[1] ?? "");
    if (attrOf(attrs, SRC_ATTR)) continue;
    const body = String(sm[2] ?? "");
    for (const c of body.matchAll(FETCH_CALL)) add("fetch", String(c[2] ?? ""));
    for (const c of body.matchAll(XHR_OPEN)) add("fetch", String(c[3] ?? ""));
  }

  const out: BlockedRef[] = [];
  for (const kind of BLOCKED_KINDS) out.push(...(buckets.get(kind) ?? []));
  return out.slice(0, MAX_BLOCKED_REFS);
}

/** Singular / plural noun per kind, for the one-sentence summary. */
const BLOCKED_NOUN: Readonly<Record<BlockedRef["kind"], readonly [string, string]>> = {
  script: ["remote script", "remote scripts"],
  style: ["remote stylesheet", "remote stylesheets"],
  image: ["remote image", "remote images"],
  font: ["remote font", "remote fonts"],
  frame: ["remote iframe", "remote iframes"],
  fetch: ["network call", "network calls"],
};

/** P-PREVIEW.12: one short sentence naming what got blocked and the ACTIONABLE fix. This is the string the
 *  agent sees in its tool result, so it names the remedy (inline it, or vendor the asset next to the file and
 *  reference it relatively) rather than just reporting a failure: that is the whole feedback loop. "" when
 *  nothing is blocked, so a caller can treat empty as "no note to add". */
export function blockedRefsMessage(refs: BlockedRef[]): string {
  const list = (refs ?? []).filter((r) => r && r.url);
  if (!list.length) return "";
  const parts: string[] = [];
  for (const kind of BLOCKED_KINDS) {
    const n = list.filter((r) => r.kind === kind).length;
    if (n) parts.push(`${n} ${BLOCKED_NOUN[kind][n === 1 ? 0 : 1]}`);
  }
  const what = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]!;
  return `The preview frame has no network access, so it blocked ${what} (first: ${list[0]!.url}): inline that `
    + `script or CSS directly into the file, or save the asset next to the file and reference it with a relative path.`;
}

/** Escape for HTML TEXT and double-quoted attribute values (the banner embeds URLs from the document). */
const htmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** P-PREVIEW.12: the dismissible banner injected into a served document that has blocked refs, so the user
 *  gets an explanation instead of a blank frame. Styled INLINE because no stylesheet reaches the frame (the
 *  CSP allows `style-src 'unsafe-inline'` only), and dismissed by an inline handler for the same reason.
 *
 *  INVARIANT 11: this is a BLOCK paragraph with an ABSOLUTELY-POSITIONED icon, never a flex row. A flex box
 *  makes every raw text run and every inline tag its own flex item, which shatters a sentence like this one
 *  into stacked slivers. The text lives in exactly ONE element (`<p>`); nothing here is display:flex. */
export function blockedRefsBanner(refs: BlockedRef[]): string {
  const msg = blockedRefsMessage(refs);
  if (!msg) return "";
  const box = "position:relative;z-index:2147483647;margin:0;padding:11px 40px 11px 34px;"
    + "background:#2b1f08;color:#ffd79a;border-bottom:1px solid #6b4b12;"
    + "font:13px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;text-align:left";
  const ico = "position:absolute;left:13px;top:11px;line-height:1.55;font-weight:700";
  const btn = "position:absolute;right:7px;top:7px;width:22px;height:22px;padding:0;border:0;border-radius:5px;"
    + "background:transparent;color:inherit;font:15px/1 system-ui,sans-serif;cursor:pointer";
  return `<div id="lucid-blocked-refs" role="status" style="${box}">`
    + `<span aria-hidden="true" style="${ico}">&#9888;</span>`
    + `<p style="margin:0">${htmlEscape(msg)}</p>`
    + `<button type="button" aria-label="Dismiss this notice" onclick="this.parentNode.remove()" style="${btn}">&#215;</button>`
    + `</div>`;
}

// Where the banner goes, most-specific first. Prepending to the raw string is the LAST resort: content before
// a `<!doctype html>` throws the document into quirks mode, which would break the very page we are explaining.
const BANNER_ANCHORS = [/<body\b[^>]*>/i, /<\/head\s*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i];

/** P-PREVIEW.12: put the banner at the top of a served document's body. `refs` is computed from `html` when
 *  omitted; the html is returned UNCHANGED when nothing is blocked, so this is safe to call unconditionally. */
export function injectBlockedRefsBanner(html: string, refs?: BlockedRef[]): string {
  const doc = html ?? "";
  const banner = blockedRefsBanner(refs ?? findBlockedRefs(doc));
  if (!banner) return doc;
  for (const anchor of BANNER_ANCHORS) {
    const m = anchor.exec(doc);
    if (m) {
      const at = m.index + m[0].length;
      return doc.slice(0, at) + banner + doc.slice(at);
    }
  }
  return banner + doc;
}

/** How much text a wrapped text/markdown preview renders before it is truncated with a note. The reader's
 *  5 MB cap is about refusing a mistake; this is about not handing the frame a multi-megabyte DOM. */
const MAX_DOC_TEXT = 1024 * 1024;

/** P-PREVIEW.12: wrap a NON-markup preview (`markdown`, `text`) as a minimal self-contained HTML document so
 *  the serve route can hand it to the frame like any other page: escaped, wrapped, dark, monospace. `html`
 *  and `svg` are already documents and are returned untouched; binary kinds never come through here (they
 *  are served as bytes with their own content type). Pure. */
export function previewTextDocument(kind: PreviewKind, text: string, label: string): string {
  if (kind === "html" || kind === "svg") return text ?? "";
  const raw = text ?? "";
  const body = raw.length > MAX_DOC_TEXT
    ? `${raw.slice(0, MAX_DOC_TEXT)}\n\n[truncated at ${Math.round(MAX_DOC_TEXT / 1024)} KB of ${Math.round(raw.length / 1024)} KB]`
    : raw;
  const page = "margin:0;background:#0b0b10;color:#d8dbe4";
  const pre = "margin:0;padding:16px 20px;white-space:pre-wrap;overflow-wrap:anywhere;"
    + "font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${htmlEscape(label ?? "")}</title></head>`
    + `<body style="${page}"><pre style="${pre}">${htmlEscape(body)}</pre></body></html>`;
}
