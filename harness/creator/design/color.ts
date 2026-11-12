// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/color.ts - the only color syntax the Design suite accepts.
//
// A linear, hand-written scanner (no regex over untrusted input, so no ReDoS: d3-color GHSA-36jr-mh4h-2g58
// is the cautionary tale). Accepted: #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba() with comma or space
// separators, numbers or percentages, and an optional "/ alpha". Everything else (named colors, url(),
// var(), hsl(), expressions) is refused with null. Output alpha is an integer 0..255, like the channels.

export type RGBA = [number, number, number, number];

const MAX_COLOR_TEXT = 64;

function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

function parseHex(s: string): RGBA | null {
  const n = s.length - 1;
  if (n !== 3 && n !== 4 && n !== 6 && n !== 8) return null;
  const d: number[] = [];
  for (let i = 1; i < s.length; i++) {
    const v = hexVal(s.charCodeAt(i));
    if (v < 0) return null;
    d.push(v);
  }
  if (n === 3 || n === 4) {
    return [d[0]! * 17, d[1]! * 17, d[2]! * 17, n === 4 ? d[3]! * 17 : 255];
  }
  return [d[0]! * 16 + d[1]!, d[2]! * 16 + d[3]!, d[4]! * 16 + d[5]!, n === 8 ? d[6]! * 16 + d[7]! : 255];
}

interface NumTok { value: number; percent: boolean }

/** Scan one unsigned/signed decimal number with an optional trailing %, starting at `at`. */
function scanNumber(s: string, at: number): { tok: NumTok; end: number } | null {
  let i = at;
  let sign = 1;
  if (s[i] === "+" || s[i] === "-") { if (s[i] === "-") sign = -1; i++; }
  const start = i;
  let sawDigit = false, sawDot = false;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) { sawDigit = true; i++; continue; }
    if (c === 46 && !sawDot) { sawDot = true; i++; continue; }
    break;
  }
  if (!sawDigit) return null;
  const value = sign * Number(s.slice(start, i));
  if (!Number.isFinite(value)) return null;
  let percent = false;
  if (s[i] === "%") { percent = true; i++; }
  return { tok: { value, percent }, end: i };
}

function parseFunc(s: string): RGBA | null {
  const lower = s.toLowerCase();
  let i: number;
  if (lower.startsWith("rgba(")) i = 5;
  else if (lower.startsWith("rgb(")) i = 4;
  else return null;
  if (s[s.length - 1] !== ")") return null;
  const end = s.length - 1;
  const toks: NumTok[] = [];
  let slashAt = -1;
  let sawComma = false;
  let sawSpace = false;
  let pendingSep = false;
  const skipWs = () => { while (i < end && (s[i] === " " || s[i] === "\t")) i++; };
  skipWs();
  while (i < end) {
    const r = scanNumber(s, i);
    if (!r) return null;
    toks.push(r.tok);
    if (toks.length > 4) return null;
    pendingSep = false;
    i = r.end;
    const wsStart = i;
    skipWs();
    if (i >= end) break;
    if (s[i] === ",") { if (sawSpace) return null; sawComma = true; pendingSep = true; i++; skipWs(); continue; }
    if (s[i] === "/") { if (slashAt >= 0 || sawComma) return null; slashAt = toks.length; pendingSep = true; i++; skipWs(); continue; }
    // Space-separated syntax: whitespace must actually separate the numbers, and never mixes with commas.
    if (sawComma || i === wsStart) return null;
    sawSpace = true;
  }
  if (pendingSep) return null;
  if (toks.length !== 3 && toks.length !== 4) return null;
  if (slashAt >= 0 && slashAt !== 3) return null;
  const ch = (t: NumTok): number => Math.round(Math.min(255, Math.max(0, t.percent ? (t.value / 100) * 255 : t.value)));
  const al = (t: NumTok): number => Math.round(Math.min(1, Math.max(0, t.percent ? t.value / 100 : t.value)) * 255);
  return [ch(toks[0]!), ch(toks[1]!), ch(toks[2]!), toks.length === 4 ? al(toks[3]!) : 255];
}

/** Parse an accepted color string to [r, g, b, a] with every component an integer 0..255, or null. */
export function parseColor(s: string): RGBA | null {
  if (typeof s !== "string" || s.length > MAX_COLOR_TEXT) return null;
  const t = s.trim();
  if (t.startsWith("#")) return parseHex(t);
  return parseFunc(t);
}

const hex2 = (v: number): string => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");

/** #rrggbb when opaque, else #rrggbbaa. Channels are clamped and rounded. */
export function toHex(c: readonly number[]): string {
  const a = c[3] ?? 255;
  const base = `#${hex2(c[0] ?? 0)}${hex2(c[1] ?? 0)}${hex2(c[2] ?? 0)}`;
  return Math.round(a) >= 255 ? base : base + hex2(a);
}

/** Canonical lowercase #rrggbb / #rrggbbaa for any accepted input, else null. */
export function normalizeColor(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const c = parseColor(s);
  return c ? toHex(c) : null;
}

// CSS Color 4 named colors (https://www.w3.org/TR/css-color-4/#named-colors). Kept OUT of parseColor, whose
// grammar the contract fixes; SVG import consults this table as a plain lookup (no parsing involved).
const NAMED_TABLE =
  "aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4," +
  "black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0," +
  "chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff," +
  "darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9," +
  "darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000," +
  "darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f," +
  "darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969," +
  "dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc," +
  "ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080," +
  "honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa," +
  "lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff," +
  "lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1," +
  "lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899," +
  "lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000," +
  "mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371," +
  "mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585," +
  "midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080," +
  "oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa," +
  "palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f," +
  "pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f," +
  "royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee," +
  "sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa," +
  "springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0," +
  "violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32,transparent:00000000";

const NAMED_COLORS: ReadonlyMap<string, RGBA> = new Map(
  NAMED_TABLE.split(",").map((entry): [string, RGBA] => {
    const [name, hex] = entry.split(":") as [string, string];
    return [name, parseHex(`#${hex}`)!];
  }),
);

/** A CSS named color (case-insensitive, e.g. "white", "RebeccaPurple", "transparent"), else null. */
export function namedColor(s: string): RGBA | null {
  if (typeof s !== "string" || s.length > 24) return null;
  const c = NAMED_COLORS.get(s.trim().toLowerCase());
  return c ? [c[0], c[1], c[2], c[3]] : null;
}

/** Strict model check: exactly #rrggbb or #rrggbbaa (VPaint and doc.background). */
export function isHexColor(s: unknown): s is string {
  if (typeof s !== "string" || (s.length !== 7 && s.length !== 9) || s[0] !== "#") return false;
  for (let i = 1; i < s.length; i++) if (hexVal(s.charCodeAt(i)) < 0) return false;
  return true;
}
