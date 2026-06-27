// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/markdown.ts - render assistant replies as human-readable
// Markdown, safely.
//
// Pipeline: shortcode emoji → marked (GFM: headings, lists, tables, code fences,
// blockquotes, links) → DOMPurify. The model's reply can contain raw HTML and
// inline SVG; we render them, but DOMPurify strips anything executable
// (<script>, on* handlers, javascript: URLs, foreignObject, etc.) so a reply can
// never run code in the renderer. (This is the CHAT display path - distinct from
// the security gate, which scans tool-call inputs before they run. Rendering text
// here doesn't go through, or trip, that scanner.)

import DOMPurify from "dompurify";
import { marked } from "marked";
import katex from "katex";

marked.setOptions({ gfm: true, breaks: true });

// ── LaTeX math (KaTeX, bundled offline) ──────────────────────────────────────
// KaTeX is XSS-safe (it escapes its input; trust:false blocks \href etc.) and emits
// HTML with INLINE STYLES that DOMPurify would otherwise strip — so we render math to
// HTML up front, swap it for a placeholder, run marked+DOMPurify on the rest, then
// reinsert the trusted KaTeX HTML AFTER sanitizing. A small cache avoids re-rendering
// the same expression on every streamed token.
const mathCache = new Map<string, string>();
function tex(src: string, display: boolean): string | null {
  const key = (display ? "D" : "I") + src;
  const hit = mathCache.get(key);
  if (hit !== undefined) return hit || null;
  let out: string;
  try { out = katex.renderToString(src, { displayMode: display, throwOnError: false, strict: false, trust: false }); }
  catch { out = ""; }
  if (mathCache.size > 500) mathCache.clear();
  mathCache.set(key, out);
  return out || null;
}
// Private-use sentinels survive marked + DOMPurify untouched; index maps back to KaTeX HTML.
const OPEN = "", CLOSE = "";
function extractMath(text: string, store: string[]): string {
  const stash = (html: string) => `${OPEN}${store.push(html) - 1}${CLOSE}`;
  const block = (m: string, disp: boolean, full: string) => { const h = tex(m.trim(), disp); return h ? stash(h) : full; };
  let s = text;
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (full, m) => block(m, true, full));            // $$ … $$
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (full, m) => block(m, true, full));            // \[ … \]
  s = s.replace(/\\begin\{(align\*?|aligned|equation\*?|gather\*?|gathered|alignat\*?|multline\*?|split|cases|array|matrix|[pbBvV]matrix|smallmatrix)\}[\s\S]+?\\end\{\1\}/g, (full) => block(full, true, full)); // math environments
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (full, m) => block(m, false, full));           // \( … \)
  s = s.replace(/(?<![\\$])\$(?!\s)([^\n$]+?)(?<!\s)\$(?!\$)/g, (full, m) => {         // $ … $ (skip pure currency)
    if (/^[\d.,\s]+$/.test(m)) return full;
    const h = tex(m.trim(), false); return h ? stash(h) : full;
  });
  return s;
}
function reinsertMath(html: string, store: string[]): string {
  return html.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"), (_, i) => store[Number(i)] ?? "");
}

// Open links in the OS browser, never in-app; harden every anchor.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// Common :shortcode: → emoji. Unicode emoji in the text already render as-is;
// this just lets the model's :rocket:-style shortcodes resolve too.
const EMOJI: Record<string, string> = {
  rocket: "🚀", check: "✅", white_check_mark: "✅", x: "❌", warning: "⚠️",
  fire: "🔥", bulb: "💡", lock: "🔒", shield: "🛡️", tada: "🎉", sparkles: "✨",
  thumbsup: "👍", thumbsdown: "👎", robot: "🤖", brain: "🧠", zap: "⚡",
  bug: "🐛", memo: "📝", wrench: "🔧", eyes: "👀", heart: "❤️", star: "⭐",
  hourglass: "⏳", package: "📦", mag: "🔍", bell: "🔔", clipboard: "📋",
};
const emojify = (t: string) => t.replace(/:([a-z0-9_+-]+):/gi, (m, name) => EMOJI[String(name).toLowerCase()] ?? m);

const SANITIZE = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  FORBID_TAGS: ["style", "form", "input", "button", "textarea"],
  FORBID_ATTR: ["style"],
};

const clean = (html: string): string => DOMPurify.sanitize(html, SANITIZE) as unknown as string;

/** Markdown (+ LaTeX math, safe HTML/SVG/emoji) → sanitized HTML for the chat thread. */
export function renderMarkdown(text: string): string {
  const math: string[] = [];
  const html = clean(marked.parse(emojify(extractMath(text, math)), { async: false }) as string);
  return reinsertMath(html, math);
}

/** Inline-only variant (no block wrapping) for one-liners. */
export function renderInline(text: string): string {
  const math: string[] = [];
  const html = clean(marked.parseInline(emojify(extractMath(text, math)), { async: false }) as string);
  return reinsertMath(html, math);
}
