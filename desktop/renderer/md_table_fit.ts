// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/md_table_fit.ts - P-FLEET.READ1 (ADR-0646): readable markdown tables in a narrow Fleet card.
//
// A rendered table in a card a few hundred pixels wide let the browser squeeze a short column to one character
// ("Ti / me", "0:0 / 0") because the card text breaks anywhere. The CSS now breaks only between words, and this
// module marks the columns that hold compact data (numbers, times, dates, durations, sizes, versions) so they
// never wrap at all: such a value is unreadable split over two lines, and it is short enough to always fit.
// Text columns keep wrapping at word boundaries. Pure classification plus one DOM pass over a rendered turn.

/** A value that reads as one token: a number (signs, thousands, decimals, currency, a short unit or percent),
 *  a clock time, a date, a duration, or a version. Anything else is text. */
const COMPACT: readonly RegExp[] = [
  /^[-+~]?[$€£¥]?\d[\d,]*(\.\d+)?\s?(%|x|[kKMGTB]|ms|s|m|h|d|px|[kKMGT]?B|tok|°[CF]?)?$/,
  /^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(\s?[AaPp]\.?[Mm]\.?)?$/,
  /^(\d+(\.\d+)?\s?(ms|s|sec|m|min|h|hr|d)\s?){1,3}$/,
  /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/,
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
  /^v?\d+(\.\d+){1,3}([-+][\w.]+)?$/,
];
/** Empty and placeholder cells say nothing about the column. */
const PLACEHOLDER = /^(|-|--|n\/a|na|none|tbd|\?)$/i;
/** A compact value longer than this is not "short enough to always fit". */
const MAX_COMPACT = 24;

/** Is this cell's text a compact data value? */
export function isCompactValue(text: string): boolean {
  const s = text.trim();
  return s.length > 0 && s.length <= MAX_COMPACT && COMPACT.some((re) => re.test(s));
}

/** For each column of `rows` (the body cells' text, row by row), whether every real value in it is compact.
 *  A column of placeholders only is text. Ragged rows count the cells they have. */
export function compactColumns(rows: readonly (readonly string[])[]): boolean[] {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const out: boolean[] = [];
  for (let c = 0; c < width; c++) {
    let seen = 0;
    let ok = true;
    for (const r of rows) {
      const v = (r[c] ?? "").trim();
      if (PLACEHOLDER.test(v)) continue;
      seen++;
      if (!isCompactValue(v)) { ok = false; break; }
    }
    out.push(ok && seen > 0);
  }
  return out;
}

/** Mark every compact column of every table under `root` with `md-num` (header and body cells). */
export function fitTables(root: ParentNode): void {
  for (const table of root.querySelectorAll("table")) {
    const body = [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent ?? ""));
    const compact = compactColumns(body);
    if (!compact.some(Boolean)) continue;
    for (const tr of table.querySelectorAll("tr")) {
      [...tr.children].forEach((cell, i) => { if (compact[i]) cell.classList.add("md-num"); });
    }
  }
}
