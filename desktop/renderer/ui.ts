// desktop/renderer/ui.ts — overlay layer: delayed custom tooltips, the ⌘K
// command palette, and the non-modal security toast/popover.

import { $, el } from "./dom.ts";
import { icon } from "./icons.ts";
import { esc } from "./format.ts";

// ───────────────────────── tooltip ─────────────────────────
// Markup: data-tip="Title|Description"  (Title optional)  data-tip-icon="shield"
export function initTooltips(): void {
  const tip = $("#tip")!;
  let timer: number | undefined;
  let cur: HTMLElement | null = null;

  const place = (target: HTMLElement) => {
    const raw = target.getAttribute("data-tip") || "";
    const [a, b] = raw.split("|");
    const title = b !== undefined ? a : "";
    const desc = b !== undefined ? b : a;
    const ico = target.getAttribute("data-tip-icon");
    tip.innerHTML =
      (title ? `<div class="tt">${ico ? icon(ico, 14) : ""}<span>${esc(title)}</span></div>` : "") +
      `<div class="d">${esc(desc)}</div>`;
    const r = target.getBoundingClientRect();
    tip.style.left = "0px"; tip.style.top = "0px";
    tip.classList.add("show");
    const tr = tip.getBoundingClientRect();
    let side: "top" | "bottom" | "right" = "top";
    let x = r.left + r.width / 2 - tr.width / 2;
    let y = r.top - tr.height - 9;
    const forced = target.getAttribute("data-tip-side");
    if (forced === "right" || (!forced && r.left < 130 && r.width < 60)) { // explicit, or rail-style narrow target
      side = "right"; x = r.right + 9; y = r.top + r.height / 2 - tr.height / 2;
    } else if (forced === "bottom" || (!forced && y < 8)) {
      side = "bottom"; y = r.bottom + 9;
    }
    y = Math.max(8, Math.min(y, window.innerHeight - tr.height - 8));
    x = Math.max(8, Math.min(x, window.innerWidth - tr.width - 8));
    tip.dataset.side = side;
    tip.style.setProperty("--ax", `${r.left + r.width / 2 - x}px`);
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  };

  document.addEventListener("mouseover", (e) => {
    const t = (e.target as HTMLElement).closest("[data-tip]") as HTMLElement | null;
    if (!t || t === cur) return;
    cur = t;
    clearTimeout(timer);
    timer = window.setTimeout(() => place(t), 340);
  });
  document.addEventListener("mouseout", (e) => {
    const t = (e.target as HTMLElement).closest("[data-tip]");
    if (t && t === cur) { cur = null; clearTimeout(timer); tip.classList.remove("show"); }
  });
  window.addEventListener("scroll", () => { tip.classList.remove("show"); cur = null; }, true);
}

// ───────────────────────── command palette ─────────────────────────
export interface Action { id: string; title: string; icon: string; hint?: string; run: () => void }

export function createPalette(getActions: () => Action[]) {
  const scrim = $("#scrim")!;
  const node = el(`<div class="palette" role="dialog" aria-label="Command palette">
    <div class="pal-input">${icon("search", 17)}<input type="text" placeholder="Type a command… (try: model, scan, dashboard)" /></div>
    <div class="pal-list"></div></div>`);
  document.body.appendChild(node);
  const input = $("input", node) as HTMLInputElement;
  const list = $(".pal-list", node)!;
  let actions: Action[] = [];
  let filtered: Action[] = [];
  let sel = 0;
  let open = false;

  const score = (a: Action, q: string) => {
    if (!q) return 1;
    const t = a.title.toLowerCase();
    if (t.startsWith(q)) return 3;
    if (t.includes(q)) return 2;
    return q.split("").every((c) => t.includes(c)) ? 1 : 0;
  };
  const render = () => {
    const q = input.value.toLowerCase().trim();
    filtered = actions.map((a) => [a, score(a, q)] as const).filter(([, s]) => s > 0)
      .sort((x, y) => y[1] - x[1]).map(([a]) => a);
    sel = Math.min(sel, Math.max(0, filtered.length - 1));
    list.innerHTML = filtered.length
      ? filtered.map((a, i) => `<div class="pal-item ${i === sel ? "sel" : ""}" data-i="${i}">
          ${icon(a.icon, 17)}<span class="t">${esc(a.title)}</span>${a.hint ? `<span class="hint">${esc(a.hint)}</span>` : ""}</div>`).join("")
      : `<div class="pal-empty">No matching commands</div>`;
  };
  const show = () => {
    actions = getActions(); sel = 0; input.value = "";
    render(); open = true;
    scrim.classList.add("show"); node.classList.add("show");
    setTimeout(() => input.focus(), 20);
  };
  const hide = () => { open = false; scrim.classList.remove("show"); node.classList.remove("show"); };
  const exec = (i: number) => { const a = filtered[i]; if (a) { hide(); a.run(); } };

  input.addEventListener("input", render);
  list.addEventListener("mousemove", (e) => {
    const it = (e.target as HTMLElement).closest("[data-i]") as HTMLElement | null;
    if (it) { sel = Number(it.dataset.i); for (const c of list.children) c.classList.toggle("sel", (c as HTMLElement).dataset.i === String(sel)); }
  });
  list.addEventListener("click", (e) => {
    const it = (e.target as HTMLElement).closest("[data-i]") as HTMLElement | null;
    if (it) exec(Number(it.dataset.i));
  });
  scrim.addEventListener("click", hide);
  node.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); render(); scrollSel(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); scrollSel(); }
    else if (e.key === "Enter") { e.preventDefault(); exec(sel); }
  });
  const scrollSel = () => list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open ? hide() : show(); }
  });
  return { show, hide };
}

// ───────────────────────── anchored popover ─────────────────────────
// A managed floating card anchored to an element; closes on outside-click / Esc.
export function popover(anchor: HTMLElement, inner: string, onClose?: () => void): { node: HTMLElement; close: () => void } {
  const node = el(`<div class="popover" role="dialog">${inner}</div>`);
  document.body.appendChild(node);
  const r = anchor.getBoundingClientRect();
  const pr = node.getBoundingClientRect();
  let x = Math.min(r.left, window.innerWidth - pr.width - 10);
  let y = r.bottom + 8;
  if (y + pr.height > window.innerHeight - 10) y = Math.max(10, r.top - pr.height - 8);
  node.style.left = `${Math.max(10, x)}px`;
  node.style.top = `${y}px`;
  requestAnimationFrame(() => node.classList.add("show"));
  const close = () => {
    node.classList.remove("show");
    setTimeout(() => node.remove(), 160);
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", onKey, true);
    onClose?.();
  };
  const outside = (e: MouseEvent) => { if (!node.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  setTimeout(() => { document.addEventListener("mousedown", outside, true); document.addEventListener("keydown", onKey, true); }, 0);
  return { node, close };
}

// ───────────────────────── toast / popover ─────────────────────────
export interface ToastAction { label: string; kind?: "ok" | "danger"; run?: () => void }
export interface ToastOpts { title: string; desc: string; meta?: string; actions?: ToastAction[]; timeout?: number }

export function showToast(o: ToastOpts): void {
  const host = $("#toasts")!;
  const node = el(`<div class="toast" role="alert">
    <div class="bar"></div>
    <div class="in">${icon("shield", 18)}
      <div style="flex:1;min-width:0">
        <div class="h">${esc(o.title)}<button aria-label="dismiss">${icon("close", 14)}</button></div>
        <div class="d">${esc(o.desc)}</div>
        ${o.meta ? `<div class="meta">${esc(o.meta)}</div>` : ""}
        <div class="acts"></div>
      </div></div></div>`);
  const acts = $(".acts", node)!;
  for (const a of o.actions ?? []) {
    const b = el(`<button class="btn-mini ${a.kind ?? ""}">${esc(a.label)}</button>`);
    b.addEventListener("click", () => { a.run?.(); dismiss(); });
    acts.appendChild(b);
  }
  if (!o.actions?.length) acts.remove();
  const dismiss = () => { node.classList.remove("show"); setTimeout(() => node.remove(), 260); };
  ($("button", $(".h", node) as HTMLElement) as HTMLElement).addEventListener("click", dismiss);
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));
  if (o.timeout) setTimeout(dismiss, o.timeout);
}
