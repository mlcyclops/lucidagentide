// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/ctxmenu.ts — P-SECACK.1 (ADR-0170): right-click Cut/Copy/Paste/Select-all for
// text fields (the prompt bar first and foremost). Electron ships NO default context menu, so
// before this the only clipboard path was Ctrl+C/Ctrl+V.
//
// Design: one document-level listener; a styled in-DOM menu (matches the app, works identically in
// Electron and the browser dev server); clipboard via navigator.clipboard (Electron grants it — no
// permission handler is installed; a refusing BROWSER degrades to a toast pointing at Ctrl+V).
// Password fields never offer Cut/Copy (a shoulder-surf leak); pasting IMAGES into the composer
// stages thumbnails through the exact P-VISION.1 path Ctrl+V uses.

// ── pure logic (unit-tested) ─────────────────────────────────────────────────────────────────────

export type CtxAction = "cut" | "copy" | "paste" | "selectall";
export interface CtxItem { act: CtxAction; label: string; kbd: string; enabled: boolean }
export interface CtxTargetState { editable: boolean; hasSelection: boolean; secret?: boolean }

/** The menu contract: which entries exist and which are actionable for a given field state. */
export function menuItemsFor(s: CtxTargetState): CtxItem[] {
  return [
    { act: "cut", label: "Cut", kbd: "Ctrl+X", enabled: s.editable && s.hasSelection && !s.secret },
    { act: "copy", label: "Copy", kbd: "Ctrl+C", enabled: s.hasSelection && !s.secret },
    { act: "paste", label: "Paste", kbd: "Ctrl+V", enabled: s.editable },
    { act: "selectall", label: "Select all", kbd: "Ctrl+A", enabled: true },
  ];
}

// P-COPY.1 (ADR-0203): a READ-ONLY copy menu for non-editable content - selected chat text and code blocks.
// Electron ships no default menu, so a right-click here previously did nothing; now it offers Copy (of the
// selection) and, inside a code fence, "Copy code block" (the whole snippet, no manual selecting).
export type ReadonlyAct = "copy" | "copycode";
export interface ReadonlyCtxItem { act: ReadonlyAct; label: string; kbd: string; enabled: boolean }
export interface ReadonlyCtxState { inCode: boolean; hasSelection: boolean }

/** Which read-only entries to show. Returns [] when there's nothing to copy, so an ordinary right-click (no
 *  selection, not a code block) keeps its default behavior instead of popping a useless menu. */
export function readonlyMenuItemsFor(s: ReadonlyCtxState): ReadonlyCtxItem[] {
  const items: ReadonlyCtxItem[] = [];
  if (s.hasSelection) items.push({ act: "copy", label: "Copy", kbd: "Ctrl+C", enabled: true });
  if (s.inCode) items.push({ act: "copycode", label: "Copy code block", kbd: "", enabled: true });
  return items;
}

/** Replace [start,end) of `value` with `insert`; returns the new value + caret position after the
 *  insert. Tolerates reversed/out-of-range offsets (clamped) so a stale selection can't corrupt. */
export function spliceText(value: string, start: number, end: number, insert: string): { value: string; caret: number } {
  const len = value.length;
  const rawA = Math.max(0, Math.min(Number.isFinite(start) ? start : 0, len));
  const rawB = Math.max(0, Math.min(Number.isFinite(end) ? end : rawA, len));
  const a = Math.min(rawA, rawB), b = Math.max(rawA, rawB);
  return { value: value.slice(0, a) + insert + value.slice(b), caret: a + insert.length };
}

// ── DOM wiring ───────────────────────────────────────────────────────────────────────────────────

type Field = HTMLTextAreaElement | HTMLInputElement;

// Input types where text selection/caret APIs exist and a clipboard menu makes sense.
const TEXTUAL_INPUTS: Record<string, true> = { "": true, text: true, search: true, url: true, tel: true, email: true, password: true };

export interface CtxMenuDeps {
  /** Surface a clipboard-refused notice (browser dev server; Electron always grants). */
  toast?: (t: { title: string; desc: string; tone?: "warn" }) => void;
}

let openMenu: HTMLElement | null = null;
let closeListeners: (() => void) | null = null;

function closeCtxMenu(): void {
  openMenu?.remove(); openMenu = null;
  closeListeners?.(); closeListeners = null;
}

/** Image items on the async clipboard as File objects; empty when there are none or access is refused. */
async function clipboardImageFiles(): Promise<File[]> {
  const items = await navigator.clipboard.read().catch(() => null);
  const files: File[] = [];
  for (const it of items ?? []) {
    const type = it.types.find((t) => t.startsWith("image/"));
    if (type) files.push(new File([await it.getType(type)], "pasted-image" + (type === "image/png" ? ".png" : ""), { type }));
  }
  return files;
}

/** Dispatch a real, cancelable `paste` carrying `files` on `field`. Returns true when a handler consumed
 *  it (called preventDefault), exactly the contract the composer and lane paste listeners already honour
 *  for Ctrl+V. */
function replayPaste(field: HTMLElement, files: File[]): boolean {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  return !field.dispatchEvent(ev);
}

async function runAction(act: CtxAction, field: Field, deps: CtxMenuDeps): Promise<void> {
  const start = field.selectionStart ?? 0, end = field.selectionEnd ?? 0;
  const selected = field.value.slice(Math.min(start, end), Math.max(start, end));
  switch (act) {
    case "copy":
      try { await navigator.clipboard.writeText(selected); } catch { /* nothing sensitive lost */ }
      break;
    case "cut": {
      try { await navigator.clipboard.writeText(selected); } catch { break; } // no copy → don't destroy the text
      const cut = spliceText(field.value, start, end, "");
      field.value = cut.value;
      field.setSelectionRange(cut.caret, cut.caret);
      field.dispatchEvent(new Event("input", { bubbles: true })); // autosize + send-enable react
      break;
    }
    case "paste": {
      try {
        // Image clipboard (snipping tool): replay it as a `paste` event on THIS field, so whichever
        // handler owns the field (the main composer's thumbnail strip, a fleet lane's per-card strip)
        // stages it exactly as Ctrl+V would. A single app-level "stage images" callback used to send a
        // lane's right-click paste into the main prompt bar; the field decides, not the menu.
        if (typeof navigator.clipboard.read === "function") {
          const files = await clipboardImageFiles();
          if (files.length && replayPaste(field, files)) break;
        }
        const text = await navigator.clipboard.readText();
        if (!text) break;
        const pasted = spliceText(field.value, start, end, text);
        field.value = pasted.value;
        field.setSelectionRange(pasted.caret, pasted.caret);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        deps.toast?.({ title: "Clipboard blocked", desc: "The browser refused clipboard access. Use Ctrl+V here.", tone: "warn" });
      }
      break;
    }
    case "selectall":
      field.select();
      break;
  }
}

/** Copy plain text to the clipboard, degrading to a toast when a browser refuses (Electron always grants). */
async function copyText(text: string, deps: CtxMenuDeps): Promise<void> {
  if (!text) return;
  if (!(await copyToClipboard(text))) deps.toast?.({ title: "Clipboard blocked", desc: "The browser refused clipboard access. Use Ctrl+C here.", tone: "warn" });
}

/** P-PUSH.PAR1 (ADR-pending): the one plain-text clipboard write menus share. False when refused (a
 *  browser without permission; Electron always grants), so the caller can say so instead of claiming
 *  "Copied". */
export async function copyToClipboard(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

interface MenuEntry { label: string; kbd: string; enabled: boolean; run: () => void }
/** `focus`: move focus into the menu (first enabled item) so arrows/Enter work at once; Escape then returns
 *  it to `returnFocus`. The field menus leave focus in the field, so the text selection survives. */
interface MenuOpts { focus?: boolean; returnFocus?: HTMLElement | null; className?: string }

/** Build + place the styled in-DOM menu at (x,y), clamped to the viewport, with the shared dismiss wiring:
 *  Escape, a press or wheel outside it, any scroll, and window blur close it; arrow keys, Home and End
 *  move between enabled items (Enter or Space activates the focused one, as on any button). */
function spawnMenu(clientX: number, clientY: number, entries: MenuEntry[], opts: MenuOpts = {}): void {
  closeCtxMenu();
  const menu = document.createElement("div");
  menu.className = opts.className ? `ctx-menu ${opts.className}` : "ctx-menu";
  menu.setAttribute("role", "menu");
  for (const it of entries) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "ctx-it"; btn.disabled = !it.enabled;
    btn.setAttribute("role", "menuitem");
    const lab = document.createElement("span"); lab.textContent = it.label;
    const kbd = document.createElement("span"); kbd.className = "kbd"; kbd.textContent = it.kbd;
    btn.append(lab, kbd);
    // mousedown would steal focus (and with it the field/text selection) — act on click, block the steal.
    btn.addEventListener("mousedown", (ev) => ev.preventDefault());
    btn.addEventListener("click", () => { closeCtxMenu(); it.run(); });
    menu.append(btn);
  }
  document.body.append(menu);
  // Clamp into the viewport (menu is position:fixed).
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - r.height - 8))}px`;
  openMenu = menu;
  const items = [...menu.querySelectorAll<HTMLButtonElement>(".ctx-it:not(:disabled)")];
  if (opts.focus) items[0]?.focus();

  // P-PUSH.PAR1 (ADR-pending): pointerdown (not mousedown) so a TAP outside closes it too, which also covers
  // a touch scroll (every swipe starts with one). Not touchmove: the finger that long-pressed the menu open
  // is still down, and its moves target the row it started on. A programmatic scroll (a streaming reply
  // following its tail) must not close it, so there is deliberately no `scroll` listener.
  const away = (ev: Event) => { if (!menu.contains(ev.target as Node)) closeCtxMenu(); };
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault(); ev.stopPropagation();
      closeCtxMenu();
      if (opts.returnFocus?.isConnected) opts.returnFocus.focus();
      return;
    }
    if (ev.key === "Tab") { closeCtxMenu(); return; }
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (!items.length || (at < 0 && !opts.focus)) return; // a field menu: arrows still move the caret
    const to = ev.key === "ArrowDown" ? (at + 1) % items.length
      : ev.key === "ArrowUp" ? (at <= 0 ? items.length - 1 : at - 1)
      : ev.key === "Home" ? 0
      : ev.key === "End" ? items.length - 1
      : -1;
    if (to < 0) return;
    ev.preventDefault(); ev.stopPropagation();
    items[to]!.focus();
  };
  document.addEventListener("pointerdown", away, true);
  document.addEventListener("wheel", away, { capture: true, passive: true });
  document.addEventListener("keydown", key, true);
  window.addEventListener("blur", closeCtxMenu);
  closeListeners = () => {
    document.removeEventListener("pointerdown", away, true);
    document.removeEventListener("wheel", away, { capture: true } as EventListenerOptions);
    document.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", closeCtxMenu);
  };
}

// ── P-PUSH.PAR1 (ADR-pending): an item menu on any list row, by right-click OR long-press ──────────────

export interface CtxMenuEntry { label: string; kbd?: string; enabled?: boolean; run: () => void }

/** Open the shared styled menu at (x,y) with focus inside it (keyboard-ready); Escape hands focus back to
 *  `returnFocus`. Same look, dismiss rules and single-instance rule as the field menu above. */
export function openCtxMenu(clientX: number, clientY: number, entries: CtxMenuEntry[], opts: { returnFocus?: HTMLElement | null; className?: string } = {}): void {
  spawnMenu(clientX, clientY, entries.map((e) => ({ label: e.label, kbd: e.kbd ?? "", enabled: e.enabled !== false, run: e.run })), { ...opts, focus: true });
}

/** A press shorter than this is a tap; holding it this long on touch or pen opens the item menu. */
export const LONG_PRESS_MS = 500;
/** A finger that drifts further than this (px) is scrolling, not holding: the long-press is cancelled. */
export const LONG_PRESS_SLOP_PX = 10;
/** Did the pointer travel far enough from where it went down to count as a drag/scroll? */
export function longPressMoved(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > LONG_PRESS_SLOP_PX;
}

/** Wire an item menu on every `selector` row inside `root` (delegated, so rows rebuilt by innerHTML keep
 *  working; bind once per root). A mouse right-click opens it at the pointer; on touch or pen, holding a
 *  row for LONG_PRESS_MS opens it (cancelled by lifting, or by moving past LONG_PRESS_SLOP_PX). The
 *  browser's own long-press contextmenu right after ours is swallowed, as is the release's click, so the
 *  hold can never also press the button under the finger. */
export function bindItemMenu(root: HTMLElement, selector: string, open: (row: HTMLElement, clientX: number, clientY: number) => void): void {
  let timer = 0;
  let start: { x: number; y: number; id: number } | null = null;
  let firedAt = 0;
  const cancel = (): void => { if (timer) window.clearTimeout(timer); timer = 0; start = null; };
  const rowOf = (t: EventTarget | null): HTMLElement | null => {
    const row = (t as HTMLElement | null)?.closest?.(selector) as HTMLElement | null;
    return row && root.contains(row) ? row : null;
  };
  root.addEventListener("contextmenu", (e) => {
    const row = rowOf(e.target); if (!row) return;
    e.preventDefault(); e.stopPropagation(); // the document-level copy menu must not replace this one
    cancel();
    if (Date.now() - firedAt < 1000) return; // the browser's echo of a long-press that already opened it
    open(row, e.clientX, e.clientY);
  });
  root.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    const row = rowOf(e.target); if (!row) return;
    cancel();
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    timer = window.setTimeout(() => {
      timer = 0;
      const at = start; start = null;
      if (!at) return;
      // A repaint during the hold may have rebuilt the rows (innerHTML); the row under the finger is the
      // same logical item, so resolve it again instead of dropping the long-press.
      const live = row.isConnected ? row : rowOf(document.elementFromPoint(at.x, at.y));
      if (!live) return;
      firedAt = Date.now();
      window.getSelection?.()?.removeAllRanges(); // a hold also selects a word; the menu is the copy path
      const swallow = (ev: Event): void => { ev.preventDefault(); ev.stopPropagation(); };
      const release = (): void => {
        window.removeEventListener("pointerup", release, true);
        window.removeEventListener("pointercancel", release, true);
        window.setTimeout(() => window.removeEventListener("click", swallow, true), 350);
      };
      window.addEventListener("click", swallow, true);
      window.addEventListener("pointerup", release, true);
      window.addEventListener("pointercancel", release, true);
      open(live, at.x, at.y);
    }, LONG_PRESS_MS);
  });
  root.addEventListener("pointermove", (e) => {
    if (start && e.pointerId === start.id && longPressMoved(e.clientX - start.x, e.clientY - start.y)) cancel();
  });
  const end = (e: PointerEvent): void => { if (start && e.pointerId === start.id) cancel(); };
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", end);
}

/** One document-level contextmenu hook. A textual FIELD gets the full clipboard menu; otherwise a right-click
 *  on SELECTED text or inside a CODE BLOCK gets a Copy menu (P-COPY.1). Everything else keeps its default.
 *  Idempotent per document. */
export function installTextContextMenu(deps: CtxMenuDeps = {}): void {
  document.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement | null;

    // 1) Editable field → cut / copy / paste / select-all.
    const field = target?.closest?.("textarea, input") as Field | null;
    if (field && !field.disabled && !field.readOnly && !(field instanceof HTMLInputElement && !TEXTUAL_INPUTS[field.type])) {
      e.preventDefault();
      const start = field.selectionStart ?? 0, end = field.selectionEnd ?? 0;
      const items = menuItemsFor({ editable: true, hasSelection: end > start, secret: field instanceof HTMLInputElement && field.type === "password" });
      spawnMenu(e.clientX, e.clientY, items.map((it) => ({ label: it.label, kbd: it.kbd, enabled: it.enabled, run: () => { field.focus(); void runAction(it.act, field, deps); } })));
      return;
    }

    // 2) Read-only content (chat text + code blocks) → Copy the selection / the whole code block. Without this,
    //    Electron's missing default menu means a right-click here does nothing.
    const pre = target?.closest?.("pre") as HTMLElement | null;
    const inCode = !!(pre && pre.querySelector("code"));
    const selection = (typeof window.getSelection === "function" ? window.getSelection()?.toString() : "") ?? "";
    const items = readonlyMenuItemsFor({ inCode, hasSelection: !!selection.trim() });
    if (!items.length) return; // nothing to copy → keep the default behavior
    e.preventDefault();
    spawnMenu(e.clientX, e.clientY, items.map((it) => ({
      label: it.label, kbd: it.kbd, enabled: it.enabled,
      run: () => { void copyText(it.act === "copycode" ? (pre?.querySelector("code")?.textContent ?? "") : selection, deps); },
    })));
  });
}
