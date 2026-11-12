// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/svg_sanitize.ts - make an untrusted SVG (a dgx-cad drawing preview, a user's import, a
// DGX vectorize reply) safe to show or to turn into Design shapes.
//
// One hardened DOMPurify (>= 3.4.16) configuration for every path:
//   * the SVG profile only, no filters: no HTML, no MathML, no <script>, no <foreignObject>;
//   * no <style> (CSS can fetch url()s and restyle), no <image>, <a>, <use>, and no SMIL (<animate>, <set>,
//     <animateMotion>, <animateTransform>, <animateColor>: <set> is the classic href-to-javascript: vector);
//   * no style attribute, and the only URI any attribute may hold is a same-document fragment (#id).
// Never IN_PLACE, never ADD_TAGS/ADD_ATTR hooks, never setConfig (the 2026 advisories live there).
//
// Display: the cleaned SVG is shown as an <img> data: URL, never inlined into the document. An SVG image
// runs no script and loads no external resource; the CSP (img-src 'self' data:) allows exactly this.
// Import: the sanitized STRING is parsed by DOMParser (image/svg+xml, an inert document), walked into a
// plain SvgNode tree, and handed to the engine's svgNodesToShapes. No SVG markup ever enters the live DOM.

import DOMPurify from "dompurify";
import type { SvgNode } from "../../harness/creator/design/svg_import.ts";

const SVG_FORBID_TAGS = ["style", "image", "a", "animate", "set", "animatemotion", "animatetransform", "animatecolor", "use", "foreignObject", "script"];

function sanitizeSvgString(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: false },
    FORBID_TAGS: SVG_FORBID_TAGS,
    FORBID_ATTR: ["style"],
    ALLOWED_URI_REGEXP: /^#/,
  });
}

/** Sanitize `svg` and return a data: URL for an <img>, or "" when nothing safe remains. */
export function sanitizedSvgDataUrl(svg: string): string {
  const frag = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: false },
    FORBID_TAGS: SVG_FORBID_TAGS,
    FORBID_ATTR: ["style"],
    ALLOWED_URI_REGEXP: /^#/,
    RETURN_DOM_FRAGMENT: true,
  });
  const root = frag.querySelector("svg");
  if (!root) return "";
  // XMLSerializer writes the SVG namespace back, which an <img> needs to decode the document at all.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
}

/** Hard caps on what an import may walk: 20 MB of text, 50k elements, 64 levels, 64 attributes each. */
export const SVG_IMPORT_LIMITS = { maxBytes: 20 * 1024 * 1024, maxNodes: 50_000, maxDepth: 64, maxAttrs: 64, maxAttrLen: 2_000_000, maxText: 2_000 } as const;

/** Untrusted SVG text -> a sanitized, inert SvgNode tree, or a named refusal. */
export function svgTextToNode(svg: string): { ok: true; root: SvgNode } | { ok: false; error: string } {
  if (typeof svg !== "string" || !svg.trim()) return { ok: false, error: "That SVG is empty." };
  if (svg.length > SVG_IMPORT_LIMITS.maxBytes) return { ok: false, error: "That SVG is larger than 20 MB." };
  const clean = sanitizeSvgString(svg);
  if (!clean.trim()) return { ok: false, error: "Nothing safe remained after sanitizing that SVG." };
  const parsed = new DOMParser().parseFromString(clean, "image/svg+xml");
  if (parsed.getElementsByTagName("parsererror").length) return { ok: false, error: "The sanitized SVG did not parse as XML." };
  const top = parsed.documentElement;
  if (!top || top.localName.toLowerCase() !== "svg") return { ok: false, error: "That file has no <svg> root." };
  let count = 0;
  const root: SvgNode = { tag: "svg", attrs: new Map(), children: [] };
  // Iterative walk: (element, its SvgNode, depth). No recursion, so a deep file cannot blow the stack.
  const stack: [Element, SvgNode, number][] = [[top, root, 0]];
  while (stack.length) {
    const [el, node, depth] = stack.pop()!;
    if (++count > SVG_IMPORT_LIMITS.maxNodes) return { ok: false, error: `That SVG has more than ${SVG_IMPORT_LIMITS.maxNodes} elements.` };
    const attrs = el.attributes;
    for (let i = 0; i < attrs.length && i < SVG_IMPORT_LIMITS.maxAttrs; i++) {
      const a = attrs[i]!;
      if (a.value.length <= SVG_IMPORT_LIMITS.maxAttrLen) node.attrs.set(a.localName, a.value);
    }
    let text = "";
    const kids: SvgNode[] = [];
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 || c.nodeType === 4) { if (text.length < SVG_IMPORT_LIMITS.maxText) text += (c.nodeValue ?? "").slice(0, SVG_IMPORT_LIMITS.maxText - text.length); continue; }
      if (c.nodeType !== 1 || depth + 1 > SVG_IMPORT_LIMITS.maxDepth) continue;
      const ce = c as Element;
      const child: SvgNode = { tag: ce.localName, attrs: new Map(), children: [] };
      kids.push(child);
      stack.push([ce, child, depth + 1]);
    }
    node.children = kids;
    if (text.trim()) node.text = text;
  }
  return { ok: true, root };
}
