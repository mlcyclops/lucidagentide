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

marked.setOptions({ gfm: true, breaks: true });

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

/** Markdown (+ safe HTML/SVG/emoji) → sanitized HTML for the chat thread. */
export function renderMarkdown(text: string): string {
  return clean(marked.parse(emojify(text), { async: false }) as string);
}

/** Inline-only variant (no block wrapping) for one-liners. */
export function renderInline(text: string): string {
  return clean(marked.parseInline(emojify(text), { async: false }) as string);
}
