// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/_tui.ts
//
// Shared terminal-rendering helpers for the LucidAgentIDE dashboards
// (security: dashboard_tui.ts, memory/context: memory_tui.ts). Pure string
// builders — no I/O — so both dashboards look identical and stay testable.

import type { Row } from "../harness/memory/db.ts";

export const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
};

export function cell(v: unknown): string {
  if (v == null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Render a box-drawn table with a colored frame and bold header row. */
export function table(title: string, headers: string[], rows: Row[], color = C.cyan): string {
  const cols = headers;
  const data = rows.map((r) => cols.map((c) => cell(r[c])));
  const w = cols.map((h, i) => Math.max(h.length, ...data.map((d) => d[i]!.length), 1));
  const sep = (l: string, m: string, r: string) => l + w.map((x) => "─".repeat(x + 2)).join(m) + r;

  const lines: string[] = [];
  lines.push(`${color}${C.bold}▸ ${title}${C.reset}`);
  if (rows.length === 0) {
    lines.push(`${C.dim}  (no rows)${C.reset}`);
    return lines.join("\n");
  }
  const fmtHead = (vals: string[]) => "│" + vals.map((v, i) => " " + v.padEnd(w[i]!) + " ").join("│") + "│";
  lines.push(color + sep("┌", "┬", "┐") + C.reset);
  lines.push(color + fmtHead(cols).replace(/[^│]+/g, (s) => C.bold + s + C.reset + color) + C.reset);
  lines.push(color + sep("├", "┼", "┤") + C.reset);
  for (const d of data)
    lines.push(
      color + "│" + C.reset + d.map((v, i) => " " + v.padEnd(w[i]!) + " ").join(C.dim + "│" + C.reset) + C.dim + "│" + C.reset,
    );
  lines.push(color + sep("└", "┴", "┘") + C.reset);
  return lines.join("\n");
}

/** A horizontal gauge bar: ████████░░░░ 67%. Color thresholds green→yellow→red. */
export function gauge(fraction: number, width = 28): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(f * width);
  const color = f >= 0.9 ? C.red : f >= 0.7 ? C.yellow : C.green;
  const bar = color + "█".repeat(filled) + C.dim + "░".repeat(width - filled) + C.reset;
  return `${bar} ${color}${(f * 100).toFixed(0).padStart(3)}%${C.reset}`;
}

const SPARK = "▁▂▃▄▅▆▇█";
/** A unicode sparkline for a series of values (scaled to its own max). */
export function sparkline(values: number[], color = C.cyan): string {
  if (values.length === 0) return `${C.dim}(no data)${C.reset}`;
  const max = Math.max(...values, 1);
  return color + values.map((v) => SPARK[Math.min(SPARK.length - 1, Math.max(0, Math.round((v / max) * (SPARK.length - 1))))]).join("") + C.reset;
}

/** 43377 -> "43.4k", 1_250_000 -> "1.25M". */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const a = Math.abs(n);
  if (a >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (a >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

export function fmtUSD(n: number): string {
  if (!Number.isFinite(n)) return "$?";
  return "$" + n.toFixed(n < 1 ? 4 : 2);
}

/** A clean, auto-sized LUCID banner. `title` headlines line 1; `desc` is the dim
 *  strapline on line 2. Width grows to fit the longest line; ANSI codes wrap
 *  whole rows so column math stays on raw (visible) text only. */
export function banner(title: string, desc: string): string {
  const l1 = "L U C I D   ·   " + title;
  const tag1 = "π";
  const tag2 = "omp + harness";
  const W = Math.max(l1.length + tag1.length, desc.length + tag2.length) + 6;
  const top = "╔" + "═".repeat(W) + "╗";
  const bot = "╚" + "═".repeat(W) + "╝";
  const row = (text: string, tag: string) => {
    const left = "  " + text;
    const pad = Math.max(1, W - left.length - tag.length - 2);
    return "║" + left + " ".repeat(pad) + tag + "  ║";
  };
  return (
    C.magenta + C.bold + top + "\n" +
    row(l1, tag1) + "\n" +
    C.reset + C.magenta + C.dim + row(desc, tag2) + C.reset + C.magenta + "\n" +
    bot + C.reset
  );
}
