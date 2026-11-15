// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/tip_text.ts - P-TIP.1 (ADR-0599): the pure text format of the premium tooltip.
// A `data-tip` value is "Title|Description" (title optional). The engine splits on the FIRST
// unescaped '|'; a literal pipe inside either part is written "\|". Pure so it is unit-tested and
// safe to import from any renderer module (no DOM, no imports).

/** Escape the '|' separator so `s` reads as literal text inside a data-tip value. */
export function tipEsc(s: string): string {
  return s.replaceAll("|", "\\|");
}

/** The data-tip value for a title and optional description. With no description the text is a
 *  one-line tip (shown as the body, like a bare `data-tip="..."`). Empty in, empty out. */
export function tipValue(title: string, desc?: string): string {
  if (desc === undefined || desc === "") return tipEsc(title);
  return `${tipEsc(title)}|${tipEsc(desc)}`;
}

/** Split a data-tip value into its bold title (may be empty) and body. Only the first unescaped
 *  '|' separates; every "\|" reads back as a literal pipe. */
export function parseTip(raw: string): { title: string; desc: string } {
  let cut = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "|" && (i === 0 || raw[i - 1] !== "\\")) { cut = i; break; }
  }
  const unesc = (s: string): string => s.replaceAll("\\|", "|");
  if (cut < 0) return { title: "", desc: unesc(raw) };
  return { title: unesc(raw.slice(0, cut)), desc: unesc(raw.slice(cut + 1)) };
}
