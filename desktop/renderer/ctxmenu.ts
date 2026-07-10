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
  /** Stage pasted image files (the composer's P-VISION.1 path). Return true if consumed. */
  onImages?: (files: File[]) => boolean;
  /** Surface a clipboard-refused notice (browser dev server; Electron always grants). */
  toast?: (t: { title: string; desc: string; tone?: "warn" }) => void;
}

let openMenu: HTMLElement | null = null;
let closeListeners: (() => void) | null = null;

function closeCtxMenu(): void {
  openMenu?.remove(); openMenu = null;
  closeListeners?.(); closeListeners = null;
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
        // Image clipboard (snipping tool) → the composer's staged-thumbnail path, same as Ctrl+V.
        if (deps.onImages && typeof navigator.clipboard.read === "function") {
          const items = await navigator.clipboard.read().catch(() => null);
          const files: File[] = [];
          for (const it of items ?? []) {
            const type = it.types.find((t) => t.startsWith("image/"));
            if (type) files.push(new File([await it.getType(type)], "pasted-image" + (type === "image/png" ? ".png" : ""), { type }));
          }
          if (files.length && deps.onImages(files)) break;
        }
        const text = await navigator.clipboard.readText();
        if (!text) break;
        const pasted = spliceText(field.value, start, end, text);
        field.value = pasted.value;
        field.setSelectionRange(pasted.caret, pasted.caret);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        deps.toast?.({ title: "Clipboard blocked", desc: "The browser refused clipboard access — use Ctrl+V here.", tone: "warn" });
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
  try { await navigator.clipboard.writeText(text); }
  catch { deps.toast?.({ title: "Clipboard blocked", desc: "The browser refused clipboard access — use Ctrl+C here.", tone: "warn" }); }
}

interface MenuEntry { label: string; kbd: string; enabled: boolean; run: () => void }

/** Build + place the styled in-DOM menu at (x,y), clamped to the viewport, with the shared dismiss wiring. */
function spawnMenu(clientX: number, clientY: number, entries: MenuEntry[]): void {
  closeCtxMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
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

  const away = (ev: Event) => { if (!menu.contains(ev.target as Node)) closeCtxMenu(); };
  const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") closeCtxMenu(); };
  document.addEventListener("mousedown", away, true);
  document.addEventListener("wheel", away, { capture: true, passive: true });
  document.addEventListener("keydown", key, true);
  window.addEventListener("blur", closeCtxMenu);
  closeListeners = () => {
    document.removeEventListener("mousedown", away, true);
    document.removeEventListener("wheel", away, { capture: true } as EventListenerOptions);
    document.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", closeCtxMenu);
  };
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
