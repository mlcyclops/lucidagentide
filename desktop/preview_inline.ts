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
  const maxTotal = opts.maxTotalBytes ?? DEFAULTS.maxTotalBytes;
  let budget = maxTotal;

  const readTextAsset = (ref: string): string | null => {
    const p = resolveLocalRef(baseDir, ref);
    if (!p) return null;
    try {
      const t = io.readText(p);
      const bytes = Buffer.byteLength(t, "utf8");
      if (bytes > maxAsset || bytes > budget) return null;
      budget -= bytes;
      return t;
    } catch { return null; }
  };
  const readDataUri = (ref: string): string | null => {
    const p = resolveLocalRef(baseDir, ref);
    if (!p) return null;
    try {
      const b = io.readBytes(p);
      if (b.length > maxAsset || b.length > budget) return null;
      budget -= b.length;
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

  return out;
}
