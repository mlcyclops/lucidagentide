// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/svg_check.ts - conservative server-side SVG scanner, run before any SVG artifact
// is stored (Design exports, DGX vectorize output).
//
// This is NOT a sanitizer and never rewrites anything: it either passes a document or refuses it with a
// reason. It is deliberately stricter than SVG needs, because a false refusal costs a re-export while a
// false pass is stored XSS (svgo GHSA-w27v-7q3p-w38r and fabric.js GHSA-hfvx-25r5-qc3w are the lessons).
// Linear scans only: no backtracking regex, no DOM, no entity expansion.
//
// Refused: <script>, <foreignObject> and other embedding elements; on* attributes; javascript:/vbscript:/
// data:text/html (also when split by whitespace or control characters); any data: URL other than
// base64 PNG/JPEG/GIF/WebP; href/src that is not a local #fragment or such an image data URL; xmlns
// values other than the SVG/XLink/XML namespaces; <!DOCTYPE>/<!ENTITY>/CDATA and every other markup
// declaration; processing instructions other than a leading <?xml ...?>; @import; url( not followed by
// #; CSS escapes or expression()/behavior in styles; numeric character references to ASCII (an
// obfuscation channel); entities other than the five XML ones; SMIL attributeName targeting href;
// unquoted or valueless attributes; documents over 20 MB.

export const SVG_MAX_BYTES = 20 * 1024 * 1024;

const REFUSED_ELEMENTS: ReadonlySet<string> = new Set([
  "script", "foreignobject", "iframe", "embed", "object", "applet", "frame", "frameset", "handler", "listener",
  "html", "body", "head", "meta", "link", "base", "audio", "video", "canvas", "portal",
]);
const ALLOWED_NAMESPACES: ReadonlySet<string> = new Set([
  "http://www.w3.org/2000/svg", "http://www.w3.org/1999/xlink", "http://www.w3.org/xml/1998/namespace",
]);
const IMAGE_DATA_PREFIXES = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/gif;base64,", "data:image/webp;base64,"];
const XML_ENTITIES: ReadonlySet<string> = new Set(["amp", "lt", "gt", "quot", "apos"]);
const SCRIPT_TOKENS = ["javascript:", "vbscript:", "livescript:", "data:text/html", "data:application/", "@import", "expression(", "-moz-binding", "behavior:"];

type Verdict = { ok: true } | { ok: false; reason: string };

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const isNameChar = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 58 || c === 95 || c === 46 || c === 45 || (c >= 65 && c <= 90);

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** Character and entity references: only the five XML entities and numeric references to non-ASCII. */
function checkReferences(lower: string): string | null {
  for (let i = lower.indexOf("&"); i >= 0; i = lower.indexOf("&", i + 1)) {
    const semi = lower.indexOf(";", i);
    if (semi < 0 || semi - i > 40) return "bare '&' or overlong reference";
    const body = lower.slice(i + 1, semi);
    if (body.startsWith("#")) {
      const hex = body[1] === "x";
      const digits = body.slice(hex ? 2 : 1);
      if (!digits.length) return "malformed character reference";
      for (const ch of digits) {
        const c = ch.charCodeAt(0);
        const ok = (c >= 48 && c <= 57) || (hex && c >= 97 && c <= 102);
        if (!ok) return "malformed character reference";
      }
      const cp = parseInt(digits, hex ? 16 : 10);
      if (!(cp >= 0x80)) return "numeric character reference to ASCII (obfuscation)";
      continue;
    }
    if (!XML_ENTITIES.has(body)) return `entity &${body.slice(0, 20)}; is not one of the XML predefined entities`;
  }
  return null;
}

/** Whitespace/control-stripped scan, so "java\tscript:" and "url (" cannot slip through. */
function checkSqueezed(lower: string): string | null {
  const sq = lower.replace(/[\u0000-\u0020]+/g, "");
  for (const tok of SCRIPT_TOKENS) if (sq.includes(tok)) return `forbidden token ${tok}`;
  for (let i = sq.indexOf("url("); i >= 0; i = sq.indexOf("url(", i + 4)) {
    let j = i + 4;
    if (sq[j] === "'" || sq[j] === "\"") j++;
    if (sq[j] !== "#") return "url( must reference a local #fragment";
  }
  for (let i = sq.indexOf("data:"); i >= 0; i = sq.indexOf("data:", i + 5)) {
    if (!IMAGE_DATA_PREFIXES.some((p) => sq.startsWith(p, i))) return "data: URL other than a base64 PNG/JPEG/GIF/WebP image";
  }
  return null;
}

function checkAttribute(name: string, value: string): string | null {
  const colon = name.lastIndexOf(":");
  const local = colon >= 0 ? name.slice(colon + 1) : name;
  if (local.startsWith("on")) return `event handler attribute ${name.slice(0, 40)}`;
  if (name === "xml:base") return "xml:base is not allowed";
  const v = value.replace(/[\u0000-\u0020]+/g, "");
  if (name === "xmlns" || name.startsWith("xmlns:")) {
    if (!ALLOWED_NAMESPACES.has(v)) return `namespace ${v.slice(0, 60)} is not allowed`;
    return null;
  }
  if (local === "href" || local === "src") {
    if (v.startsWith("#") || IMAGE_DATA_PREFIXES.some((p) => v.startsWith(p))) return null;
    return `${name} must be a local #fragment or a base64 image data URL`;
  }
  if (local === "attributename" && v.endsWith("href")) return "animation targeting href is not allowed";
  if (local === "style" && value.includes("\\")) return "CSS escapes are not allowed in style attributes";
  return null;
}

/** Linear tag scanner over the ASCII-lowercased text (same indices as the input). */
function checkMarkup(lower: string): string | null {
  const n = lower.length;
  let i = 0;
  let sawMarkup = false;
  while (i < n) {
    const lt = lower.indexOf("<", i);
    if (lt < 0) break;
    i = lt;
    const next = lower[i + 1];
    if (lower.startsWith("<!--", i)) {
      const end = lower.indexOf("-->", i + 4);
      if (end < 0) return "unterminated comment";
      i = end + 3;
      continue;
    }
    if (next === "!") return "markup declarations (DOCTYPE, ENTITY, CDATA) are not allowed";
    if (next === "?") {
      if (sawMarkup || !lower.startsWith("<?xml", i) || !isWs(lower[i + 5])) return "processing instructions other than a leading <?xml?> are not allowed";
      const end = lower.indexOf("?>", i + 5);
      if (end < 0) return "unterminated XML declaration";
      sawMarkup = true;
      i = end + 2;
      continue;
    }
    sawMarkup = true;
    if (next === "/") {
      const end = lower.indexOf(">", i + 2);
      if (end < 0) return "unterminated end tag";
      i = end + 1;
      continue;
    }
    let j = i + 1;
    while (j < n && isNameChar(lower.charCodeAt(j))) j++;
    const tag = lower.slice(i + 1, j);
    if (!tag) return "malformed tag";
    const colon = tag.lastIndexOf(":");
    const local = colon >= 0 ? tag.slice(colon + 1) : tag;
    if (REFUSED_ELEMENTS.has(local)) return `element <${tag.slice(0, 40)}> is not allowed`;
    let selfClosing = false;
    for (;;) {
      while (j < n && isWs(lower[j])) j++;
      if (j >= n) return "unterminated tag";
      if (lower[j] === ">") { j++; break; }
      if (lower[j] === "/") {
        if (lower[j + 1] === ">") { selfClosing = true; j += 2; break; }
        return "malformed tag";
      }
      const nameStart = j;
      while (j < n && isNameChar(lower.charCodeAt(j))) j++;
      const name = lower.slice(nameStart, j);
      if (!name) return "malformed attribute";
      while (j < n && isWs(lower[j])) j++;
      if (lower[j] !== "=") return `attribute ${name.slice(0, 40)} has no value`;
      j++;
      while (j < n && isWs(lower[j])) j++;
      const q = lower[j];
      if (q !== "\"" && q !== "'") return `attribute ${name.slice(0, 40)} must be quoted`;
      const end = lower.indexOf(q, j + 1);
      if (end < 0) return "unterminated attribute value";
      const why = checkAttribute(name, lower.slice(j + 1, end));
      if (why) return why;
      j = end + 1;
    }
    if (local === "style" && !selfClosing) {
      const close = lower.indexOf("</", j);
      if (close < 0) return "unterminated <style>";
      const css = lower.slice(j, close);
      if (css.includes("\\")) return "CSS escapes are not allowed in <style>";
      if (css.includes("<")) return "markup inside <style> is not allowed";
    }
    i = j;
  }
  return null;
}

/** Pass or refuse an SVG document before it is stored. Never throws. */
export function svgSafetyCheck(text: string): Verdict {
  if (typeof text !== "string") return { ok: false, reason: "not a string" };
  if (text.length > SVG_MAX_BYTES || utf8Length(text) > SVG_MAX_BYTES) return { ok: false, reason: "larger than 20 MB" };
  if (text.includes("\u0000")) return { ok: false, reason: "NUL character" };
  // ASCII-only lowercasing keeps every index aligned with the input (toLowerCase can change lengths).
  const lower = text.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  const body = lower.charCodeAt(0) === 0xFEFF ? lower.slice(1) : lower;
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("<")) return { ok: false, reason: "does not start with markup" };
  if (!trimmed.includes("<svg")) return { ok: false, reason: "no <svg> element" };
  const why = checkReferences(body) ?? checkSqueezed(body) ?? checkMarkup(trimmed);
  return why ? { ok: false, reason: why } : { ok: true };
}
