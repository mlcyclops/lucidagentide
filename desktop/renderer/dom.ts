// desktop/renderer/dom.ts - DOM + dashboard render primitives shared by the
// inspector panels and status bar. Pure string/Element builders.

import { esc, fmtNum, goodColor, loadColor, pct } from "./format.ts";

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector(sel) as T | null;
export const $$ = (sel: string, root: ParentNode = document): Element[] => Array.from(root.querySelectorAll(sel));

/** Build an element from an HTML string (first root node). */
export function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

/** `good=true` flips the colour ramp so a HIGH value reads as healthy (cache hit). */
export function gauge(label: string, frac: number, valHtml = "", good = false): string {
  const p = pct(frac), c = good ? goodColor(frac) : loadColor(frac);
  return `<div class="gauge-row"><span class="lab">${esc(label)}</span>
    <span class="gbar"><span class="fill" style="width:${p}%;background:${c}"></span></span>
    <span class="val"><b style="color:${c}">${p}%</b> ${valHtml}</span></div>`;
}

export function pill(v: unknown): string {
  const k = String(v ?? "").toLowerCase();
  return `<span class="pill ${esc(k)}">${esc(v)}</span>`;
}

export interface Col { key: string; label: string; mono?: boolean; pill?: boolean }
export function table(cols: Col[], rows: Record<string, unknown>[]): string {
  if (!rows?.length) return `<div class="empty">no rows</div>`;
  const head = cols.map((c) => `<th>${esc(c.label)}</th>`).join("");
  const body = rows
    .map((r) => "<tr>" + cols.map((c) => {
      const v = r[c.key];
      if (c.pill) return `<td>${v != null ? pill(v) : ""}</td>`;
      return `<td class="${c.mono ? "mono" : ""}">${esc(v)}</td>`;
    }).join("") + "</tr>")
    .join("");
  return `<table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Smooth area sparkline (SVG) scaled to its own max. */
export function spark(vals: number[]): string {
  if (!vals?.length) return `<div class="empty">no turns yet</div>`;
  const w = 320, h = 42, max = Math.max(...vals, 1), n = vals.length;
  const x = (i: number) => (n <= 1 ? w : (i / (n - 1)) * w);
  const y = (v: number) => h - 2 - (v / max) * (h - 6);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgba(70,200,220,.28)"/><stop offset="1" stop-color="rgba(70,200,220,0)"/>
    </linearGradient></defs>
    <polygon points="0,${h} ${pts} ${w},${h}" fill="url(#sg)"/>
    <polyline points="${pts}" fill="none" stroke="var(--cyan)" stroke-width="2"/></svg>`;
}

/** A collapsible accordion with a slide-open body. `key` is a stable id so the
 *  open/closed state survives re-renders; `open` sets the initial state. */
export function accordion(key: string, title: string, sub: string, inner: string, open: boolean, count?: string): string {
  return `<div class="acc ${open ? "open" : ""}" data-acc="${esc(key)}">
    <div class="acc-head" data-acc-toggle="${esc(key)}">
      <span class="ttl">${title}${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</span>
      ${count != null ? `<span class="count">${esc(count)}</span>` : ""}
      <span class="chev">${chev()}</span>
    </div>
    <div class="acc-body"><div class="acc-inner"><div class="acc-pad">${inner}</div></div></div>
  </div>`;
}
const chev = () => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 6 15 12l-5.5 6"/></svg>`;

export { fmtNum };
