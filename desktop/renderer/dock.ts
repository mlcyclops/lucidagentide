// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/dock.ts - P-ASKLUCID.1 (ADR-0581): a generic dock window, used by Ask Lucid.
//
// Ported to TypeScript from LUCID Tradepass's ui/js/dock.js (TP-010, same owner and license), which is the
// fly-out this increment was asked to bring over. Modes:
//   right     full height under the title bar, width 320..760 by a left-edge handle (reserves space)
//   bottom    full width at the bottom, height 200..70vh by a top-edge handle (reserves space)
//   floating  drag by the header, resize by 8 handles, kept inside the viewport (overlays)
//   minimized collapses to a pill on its dock edge (a flag on top of the placement mode)
// Dragging a floating dock with the pointer within 48 px of the right or bottom edge shows a snap preview
// and docks on release; pulling a docked header undocks it. It slides in from the right (right, floating)
// or from below (bottom). Esc closes, Alt+Arrow moves a floating dock, Alt+Shift+Arrow resizes. It is a
// non-modal complementary region: no focus trap. Placement persists in localStorage. Geometry is set
// through CSSOM only.
//
// The geometry helpers at the top are pure and unit-tested. `createDock` is the DOM half.

export type DockMode = "right" | "bottom" | "floating";
export const DOCK_MODES: readonly DockMode[] = ["right", "bottom", "floating"];
export const DOCK_LIMITS = { rightMin: 320, rightMax: 760, bottomMin: 200, bottomMaxRatio: 0.7, floatMinW: 320, floatMinH: 260, snap: 48, step: 16 } as const;
const ANIM_IN = 300;
const ANIM_OUT = 240;
const EASE_OUT = "cubic-bezier(.16,1,.3,1)";
const EASE_IN = "cubic-bezier(.5,0,.75,0)";
/** Below these viewport sizes a docked panel overlays instead of squeezing the page. */
const RESERVE_MIN_W = 900;
const RESERVE_MIN_H = 560;

export interface Viewport { w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface DockState { mode: DockMode; minimized: boolean; w: number; hb: number; fx: number; fy: number; fw: number; fh: number }

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Width of a right dock for the viewport: 320..760 and never more than the viewport minus a sliver of page. */
export function clampRight(w: unknown, vp: Viewport): number {
  const L = DOCK_LIMITS;
  return Math.round(clamp(num(w, 420), Math.min(L.rightMin, vp.w), Math.min(L.rightMax, Math.max(L.rightMin, vp.w - 120))));
}

/** Height of a bottom dock: 200..70vh. */
export function clampBottom(hb: unknown, vp: Viewport): number {
  const L = DOCK_LIMITS;
  return Math.round(clamp(num(hb, 320), Math.min(L.bottomMin, vp.h), Math.floor(vp.h * L.bottomMaxRatio)));
}

/** Floating rect kept fully inside the viewport, at least the minimum size (or the viewport if smaller). */
export function clampFloat(rect: { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null | undefined, vp: Viewport): Rect {
  const L = DOCK_LIMITS;
  const minW = Math.min(L.floatMinW, vp.w);
  const minH = Math.min(L.floatMinH, vp.h);
  const w = Math.round(clamp(num(rect?.w, 420), minW, vp.w));
  const h = Math.round(clamp(num(rect?.h, 560), minH, vp.h));
  const x = Math.round(clamp(num(rect?.x, vp.w - w - 24), 0, vp.w - w));
  const y = Math.round(clamp(num(rect?.y, Math.max(0, (vp.h - h) / 2)), 0, vp.h - h));
  return { x, y, w, h };
}

/** Sanitized state from anything (stored JSON, partial objects); unknown modes fall back to the default. */
export function normalizeDockState(raw: unknown, vp: Viewport): DockState {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mode: DockMode = DOCK_MODES.includes(s.mode as DockMode) ? (s.mode as DockMode) : "right";
  const f = clampFloat({ x: s.fx ?? undefined, y: s.fy ?? undefined, w: s.fw ?? 420, h: s.fh ?? 560 }, vp);
  return { mode, minimized: s.minimized === true, w: clampRight(s.w ?? 420, vp), hb: clampBottom(s.hb ?? 320, vp), fx: f.x, fy: f.y, fw: f.w, fh: f.h };
}

export function parseDockState(text: string | null, vp: Viewport): DockState {
  let raw: unknown = null;
  try { raw = text ? JSON.parse(text) : null; } catch { raw = null; }
  return normalizeDockState(raw, vp);
}

export function serializeDockState(s: DockState): string {
  return JSON.stringify({ v: 1, mode: s.mode, minimized: s.minimized, w: s.w, hb: s.hb, fx: s.fx, fy: s.fy, fw: s.fw, fh: s.fh });
}

/** Snap target for a pointer at (px, py): "right", "bottom" or null; the nearer edge wins in the corner. */
export function snapZone(px: number, py: number, vp: Viewport, threshold: number = DOCK_LIMITS.snap): "right" | "bottom" | null {
  const dr = vp.w - px;
  const db = vp.h - py;
  const r = dr <= threshold;
  const b = db <= threshold;
  if (r && b) return dr <= db ? "right" : "bottom";
  if (r) return "right";
  if (b) return "bottom";
  return null;
}

/** Floating rect after dragging handle `dir` (n, s, e, w, ne, nw, se, sw) by (dx, dy), within the viewport. */
export function resizeFloat(rect: Rect, dir: string, dx: number, dy: number, vp: Viewport): Rect {
  const L = DOCK_LIMITS;
  const minW = Math.min(L.floatMinW, vp.w);
  const minH = Math.min(L.floatMinH, vp.h);
  let { x, y, w, h } = rect;
  if (dir.includes("e")) w = clamp(w + dx, minW, vp.w - x);
  if (dir.includes("w")) { const nx = clamp(x + dx, 0, x + w - minW); w += x - nx; x = nx; }
  if (dir.includes("s")) h = clamp(h + dy, minH, vp.h - y);
  if (dir.includes("n")) { const ny = clamp(y + dy, 0, y + h - minH); h += y - ny; y = ny; }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** Floating rect moved by (dx, dy) and kept inside the viewport. */
export function moveFloat(rect: Rect, dx: number, dy: number, vp: Viewport): Rect {
  return clampFloat({ x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h }, vp);
}

/** PURE: whether a shown dock in `mode` pushes the page aside (true) or lies over it (false). */
export function reservesSpace(mode: DockMode, shown: boolean, vp: Viewport): { right: boolean; bottom: boolean } {
  return { right: shown && mode === "right" && vp.w >= RESERVE_MIN_W, bottom: shown && mode === "bottom" && vp.h >= RESERVE_MIN_H };
}

/** PURE: a computed `zoom` value as a factor. Anything that is not a positive number is 1. */
export function pageZoom(computed: string | null | undefined): number {
  const z = Number.parseFloat(computed ?? "");
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** PURE: `px` viewport pixels as a length inside an element drawn at `zoom`, to a tenth of a pixel. */
export function reservedInside(px: number, zoom: number): number {
  return Math.round((px / (zoom > 0 ? zoom : 1)) * 10) / 10;
}

// ---------------- DOM ----------------

const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
const MODE_BTNS: readonly { mode: DockMode; label: string; path: string[] }[] = [
  { mode: "right", label: "Dock right", path: ["M4.5 5.5h15v13h-15z", "M14 5.5v13"] },
  { mode: "bottom", label: "Dock bottom", path: ["M4.5 5.5h15v13h-15z", "M4.5 13.5h15"] },
  { mode: "floating", label: "Float", path: ["M8.5 8.5h11v10h-11z", "M5 15.5V5h10.5"] },
];

function svgIcon(paths: readonly string[]): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  const attrs: Record<string, string> = { class: "ic", viewBox: "0 0 24 24", width: "15", height: "15", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const d of paths) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); svg.appendChild(p); }
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function toolBtn(label: string, paths: readonly string[], cls = ""): HTMLButtonElement {
  const b = el("button", `ald-tool ${cls}`.trim(), { type: "button", "aria-label": label, title: label });
  b.appendChild(svgIcon(paths));
  return b;
}

function reducedMotion(): boolean {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

function viewport(): Viewport {
  return { w: window.innerWidth, h: window.innerHeight };
}

export interface DockOptions {
  label?: string;
  /** localStorage key for the placement. */
  storageKey: string;
  /** Selector of the bar a right dock sits under (its bottom edge is the dock's top). */
  topBar?: string;
  /** Selector of the element whose CSS `zoom` the page content is drawn at. The dock lives in <body> at zoom
   *  1 and sizes itself in viewport pixels; the space the page gives up is a margin INSIDE that zoomed element,
   *  so it is published a second time divided by the zoom (`--ask-r-app`, `--ask-b-app`). */
  zoomOf?: string;
  headerStart?: Node;
  body?: Node;
  pillContent?: Node;
  onShow?: () => void;
  onHide?: () => void;
  onClose?: () => void;
  onModeChange?: (state: DockState) => void;
}

export interface DockHandle {
  root: HTMLElement;
  pill: HTMLButtonElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  isVisible(): boolean;
  state(): DockState;
  setMode(mode: DockMode | "minimized"): void;
  minimize(): void;
  restore(): void;
  reload(): void;
  setUnread(on: boolean): void;
  /** Re-apply the geometry and the reserved space (call after the page's zoom changes). */
  reflow(): void;
}

type Drag =
  | { kind: "move" | "pull"; id: number; sx: number; sy: number; rect: Rect; zone: "right" | "bottom" | null }
  | { kind: "edge" | "rz"; dir: string; id: number; sx: number; sy: number; rect: Rect; w: number; hb: number };

export function createDock(opts: DockOptions): DockHandle {
  const label = opts.label ?? "Panel";
  let state = normalizeDockState(null, viewport());
  let open = false;
  let unread = false;
  let anim: Animation | null = null;

  const root = el("section", "ald", { role: "complementary", "aria-label": label, tabindex: "-1" });
  root.hidden = true;
  const frame = el("div", "ald-frame");
  const head = el("header", "ald-head");
  const start = el("div", "ald-head-start");
  if (opts.headerStart) start.appendChild(opts.headerStart);
  const tools = el("div", "ald-tools", { role: "group", "aria-label": "Dock position" });
  const modeBtns = MODE_BTNS.map((m) => {
    const b = toolBtn(m.label, m.path);
    b.dataset.mode = m.mode;
    b.addEventListener("click", () => setMode(m.mode));
    tools.appendChild(b);
    return b;
  });
  const minBtn = toolBtn("Minimize", ["M6 17.5h12"]);
  minBtn.addEventListener("click", () => minimize());
  const closeBtn = toolBtn(`Close ${label}`, ["M7 7l10 10", "M17 7 7 17"], "ald-close");
  closeBtn.addEventListener("click", () => close());
  tools.append(minBtn, closeBtn);
  head.append(start, tools);
  const body = el("div", "ald-body");
  if (opts.body) body.appendChild(opts.body);
  frame.append(head, body);
  root.appendChild(frame);

  // Edge handle for the docked modes (a keyboard-reachable separator) and 8 floating handles.
  const edge = el("div", "ald-edge", { role: "separator", tabindex: "0", "aria-label": `Resize ${label}` });
  root.appendChild(edge);
  const handles = HANDLES.map((dir) => {
    const hd = el("div", `ald-rz ald-rz-${dir}`, { "aria-hidden": "true" });
    hd.dataset.dir = dir;
    root.appendChild(hd);
    return hd;
  });

  const pill = el("button", "ald-pill", { type: "button", "aria-label": `Restore ${label}` });
  pill.hidden = true;
  if (opts.pillContent) pill.appendChild(opts.pillContent);
  const dot = el("span", "ald-unread", { "aria-hidden": "true" });
  dot.hidden = true;
  pill.appendChild(dot);
  pill.addEventListener("click", () => restore());

  const snap = el("div", "ald-snap", { "aria-hidden": "true" });
  snap.hidden = true;

  let mounted = false;
  const ensureMounted = (): void => {
    if (mounted) return;
    mounted = true;
    document.body.append(snap, root, pill);
    window.addEventListener("resize", onResize);
    reload();
  };

  const topOffset = (): number => {
    const tb = opts.topBar ? document.querySelector(opts.topBar) : null;
    const b = tb ? tb.getBoundingClientRect().bottom : 0;
    return Math.max(0, Math.round(b));
  };

  const persist = (): void => {
    try { localStorage.setItem(opts.storageKey, serializeDockState(state)); } catch { /* storage blocked */ }
  };

  const reserve = (): void => {
    const de = document.documentElement;
    const r = reservesSpace(state.mode, open && !state.minimized, viewport());
    de.classList.toggle("ask-r", r.right);
    de.classList.toggle("ask-b", r.bottom);
    const zoomEl = opts.zoomOf ? document.querySelector(opts.zoomOf) : null;
    const zoom = pageZoom(zoomEl ? getComputedStyle(zoomEl).zoom : "1");
    const put = (name: string, on: boolean, px: number): void => {
      if (on) { de.style.setProperty(name, `${px}px`); de.style.setProperty(`${name}-app`, `${reservedInside(px, zoom)}px`); }
      else { de.style.removeProperty(name); de.style.removeProperty(`${name}-app`); }
    };
    put("--ask-r", r.right, state.w);
    put("--ask-b", r.bottom, state.hb);
  };

  const apply = (): void => {
    const vp = viewport();
    state = normalizeDockState(state, vp);
    const st = root.style;
    st.left = st.top = st.right = st.bottom = st.width = st.height = "";
    if (state.mode === "right") {
      st.top = `${topOffset()}px`;
      st.right = "0px";
      st.bottom = "0px";
      st.width = `${state.w}px`;
      edge.setAttribute("aria-orientation", "vertical");
      edge.setAttribute("aria-valuemin", String(DOCK_LIMITS.rightMin));
      edge.setAttribute("aria-valuemax", String(DOCK_LIMITS.rightMax));
      edge.setAttribute("aria-valuenow", String(state.w));
    } else if (state.mode === "bottom") {
      st.left = "0px";
      st.right = "0px";
      st.bottom = "0px";
      st.height = `${state.hb}px`;
      edge.setAttribute("aria-orientation", "horizontal");
      edge.setAttribute("aria-valuemin", String(DOCK_LIMITS.bottomMin));
      edge.setAttribute("aria-valuemax", String(Math.floor(vp.h * DOCK_LIMITS.bottomMaxRatio)));
      edge.setAttribute("aria-valuenow", String(state.hb));
    } else {
      st.left = `${state.fx}px`;
      st.top = `${state.fy}px`;
      st.width = `${state.fw}px`;
      st.height = `${state.fh}px`;
    }
    root.dataset.mode = state.mode;
    pill.dataset.edge = state.mode === "bottom" ? "bottom" : "right";
    edge.hidden = state.mode === "floating";
    for (const hd of handles) hd.hidden = state.mode !== "floating";
    for (const b of modeBtns) b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
    reserve();
  };

  const animate = (target: HTMLElement, frames: Keyframe[], duration: number, easing: string): Animation | null => {
    if (reducedMotion() || typeof target.animate !== "function") return null;
    return target.animate(frames, { duration, easing, fill: "none" });
  };

  const slideFrames = (inbound: boolean): Keyframe[] => {
    const r = root.getBoundingClientRect();
    const off = state.mode === "bottom" ? `translateY(${Math.round(r.height + 24)}px)` : state.mode === "right" ? `translateX(${Math.round(r.width + 24)}px)` : "translateX(56px)";
    const from: Keyframe = { transform: off, opacity: 0 };
    const to: Keyframe = { transform: "translate(0, 0)", opacity: 1 };
    return inbound ? [from, to] : [to, from];
  };

  const stopAnim = (): void => {
    if (anim) { anim.onfinish = null; anim.cancel(); anim = null; }
  };

  const showPanel = (): void => {
    stopAnim();
    pill.hidden = true;
    root.hidden = false;
    apply();
    anim = animate(root, slideFrames(true), ANIM_IN, EASE_OUT);
    opts.onShow?.();
  };

  const hidePanel = (then?: () => void): void => {
    stopAnim();
    reserve();
    const a = root.hidden ? null : animate(root, slideFrames(false), ANIM_OUT, EASE_IN);
    const finish = (): void => { anim = null; root.hidden = true; then?.(); };
    opts.onHide?.();
    if (!a) { finish(); return; }
    anim = a;
    a.onfinish = finish;
  };

  const showPill = (): void => {
    pill.hidden = false;
    dot.hidden = !unread;
    const pre = pill.dataset.edge === "bottom" ? "translateX(-50%) " : "";
    animate(pill, [{ transform: `${pre}scale(.7)`, opacity: 0 }, { transform: `${pre}scale(1)`, opacity: 1 }], 260, "cubic-bezier(.34,1.56,.64,1)");
  };

  function openDock(): void {
    ensureMounted();
    if (open && !state.minimized && !root.hidden) return;
    open = true;
    if (state.minimized) { apply(); root.hidden = true; reserve(); showPill(); return; }
    showPanel();
  }

  function close(): void {
    if (!open) return;
    open = false;
    pill.hidden = true;
    hidePanel(() => opts.onClose?.());
  }

  function minimize(): void {
    if (!open || state.minimized) return;
    state.minimized = true;
    persist();
    hidePanel(() => showPill());
    opts.onModeChange?.({ ...state });
  }

  function restore(): void {
    ensureMounted();
    open = true;
    state.minimized = false;
    persist();
    showPanel();
    opts.onModeChange?.({ ...state });
  }

  function setMode(mode: DockMode | "minimized"): void {
    if (mode === "minimized") { minimize(); return; }
    if (!DOCK_MODES.includes(mode)) return;
    const was = state.mode;
    state.mode = mode;
    state.minimized = false;
    persist();
    if (!open) { apply(); return; }
    stopAnim();
    pill.hidden = true;
    root.hidden = false;
    apply();
    if (was !== mode) {
      const off = mode === "bottom" ? "translateY(28px)" : "translateX(28px)";
      anim = animate(root, [{ transform: off, opacity: 0.4 }, { transform: "translate(0, 0)", opacity: 1 }], 260, EASE_OUT);
    }
    opts.onModeChange?.({ ...state });
  }

  // ---- pointer: move (floating), undock (docked), resize ----
  let drag: Drag | null = null;
  const setDragging = (on: boolean, cursor?: string): void => {
    document.body.classList.toggle("ald-dragging", on);
    if (on && cursor) document.body.style.cursor = cursor; else document.body.style.removeProperty("cursor");
  };

  const showSnap = (zone: "right" | "bottom" | null): void => {
    if (!zone) { snap.hidden = true; return; }
    const vp = viewport();
    const s = snap.style;
    s.left = s.top = s.right = s.bottom = s.width = s.height = "";
    if (zone === "right") {
      s.top = `${topOffset()}px`;
      s.right = "0px";
      s.bottom = "0px";
      s.width = `${clampRight(state.w, vp)}px`;
    } else {
      s.left = "0px";
      s.right = "0px";
      s.bottom = "0px";
      s.height = `${clampBottom(state.hb, vp)}px`;
    }
    snap.dataset.zone = zone;
    if (snap.hidden) { snap.hidden = false; animate(snap, [{ opacity: 0 }, { opacity: 1 }], 160, EASE_OUT); }
  };

  const INTERACTIVE = "button, a, input, select, textarea, [role=menu]";
  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !(e.target instanceof Element) || e.target.closest(INTERACTIVE)) return;
    const r = root.getBoundingClientRect();
    drag = { kind: state.mode === "floating" ? "move" : "pull", id: e.pointerId, sx: e.clientX, sy: e.clientY, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, zone: null };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId || (drag.kind !== "move" && drag.kind !== "pull")) return;
    const vp = viewport();
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (drag.kind === "pull") {
      if (Math.hypot(dx, dy) < 8) return;
      // Undock under the pointer, keeping the grab point inside the header.
      const fw = clampFloat({ w: state.fw, h: state.fh, x: 0, y: 0 }, vp);
      const gx = clamp(e.clientX - drag.rect.x, 24, fw.w - 120);
      const f = clampFloat({ x: e.clientX - gx, y: e.clientY - 18, w: fw.w, h: fw.h }, vp);
      state.mode = "floating";
      state.fx = f.x;
      state.fy = f.y;
      apply();
      drag = { ...drag, kind: "move", sx: e.clientX, sy: e.clientY, rect: f };
      setDragging(true, "grabbing");
      return;
    }
    setDragging(true, "grabbing");
    const f = moveFloat(drag.rect, dx, dy, vp);
    state.fx = f.x;
    state.fy = f.y;
    root.style.left = `${f.x}px`;
    root.style.top = `${f.y}px`;
    drag.zone = snapZone(e.clientX, e.clientY, vp);
    showSnap(drag.zone);
  });
  const endHeadDrag = (e: PointerEvent): void => {
    if (!drag || drag.id !== e.pointerId || (drag.kind !== "move" && drag.kind !== "pull")) return;
    const zone = drag.kind === "move" ? drag.zone : null;
    const moved = drag.kind === "move";
    drag = null;
    setDragging(false);
    showSnap(null);
    if (zone) setMode(zone);
    else if (moved) { persist(); opts.onModeChange?.({ ...state }); }
  };
  head.addEventListener("pointerup", endHeadDrag);
  head.addEventListener("pointercancel", endHeadDrag);
  head.addEventListener("dblclick", (e) => {
    if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return;
    setMode(state.mode === "floating" ? "right" : "floating");
  });

  const startResize = (e: PointerEvent, kind: "edge" | "rz", dir: string): void => {
    if (e.button !== 0 || !(e.currentTarget instanceof HTMLElement)) return;
    e.preventDefault();
    const r = root.getBoundingClientRect();
    drag = { kind, dir, id: e.pointerId, sx: e.clientX, sy: e.clientY, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, w: state.w, hb: state.hb };
    e.currentTarget.setPointerCapture(e.pointerId);
    const cursor = kind === "edge" ? (state.mode === "bottom" ? "ns-resize" : "ew-resize") : getComputedStyle(e.currentTarget).cursor;
    setDragging(true, cursor);
    root.classList.add("resizing");
  };
  const moveResize = (e: PointerEvent): void => {
    if (!drag || drag.id !== e.pointerId || (drag.kind !== "edge" && drag.kind !== "rz")) return;
    const vp = viewport();
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (drag.kind === "edge") {
      if (state.mode === "right") state.w = clampRight(drag.w - dx, vp);
      else if (state.mode === "bottom") state.hb = clampBottom(drag.hb - dy, vp);
    } else {
      const f = resizeFloat(drag.rect, drag.dir, dx, dy, vp);
      state.fx = f.x; state.fy = f.y; state.fw = f.w; state.fh = f.h;
    }
    apply();
  };
  const endResize = (e: PointerEvent): void => {
    if (!drag || drag.id !== e.pointerId || (drag.kind !== "edge" && drag.kind !== "rz")) return;
    drag = null;
    setDragging(false);
    root.classList.remove("resizing");
    persist();
    opts.onModeChange?.({ ...state });
  };
  edge.addEventListener("pointerdown", (e) => startResize(e, "edge", ""));
  edge.addEventListener("pointermove", moveResize);
  edge.addEventListener("pointerup", endResize);
  edge.addEventListener("pointercancel", endResize);
  for (const hd of handles) {
    hd.addEventListener("pointerdown", (e) => startResize(e, "rz", hd.dataset.dir ?? ""));
    hd.addEventListener("pointermove", moveResize);
    hd.addEventListener("pointerup", endResize);
    hd.addEventListener("pointercancel", endResize);
  }

  // ---- keyboard ----
  const nudge = (dx: number, dy: number, resize: boolean): boolean => {
    const vp = viewport();
    if (state.mode === "floating") {
      const r = { x: state.fx, y: state.fy, w: state.fw, h: state.fh };
      const f = resize ? clampFloat({ x: r.x, y: r.y, w: r.w + dx, h: r.h + dy }, vp) : moveFloat(r, dx, dy, vp);
      state.fx = f.x; state.fy = f.y; state.fw = f.w; state.fh = f.h;
    } else if (resize && state.mode === "right") state.w = clampRight(state.w - dx, vp);
    else if (resize && state.mode === "bottom") state.hb = clampBottom(state.hb - dy, vp);
    else return false;
    apply();
    persist();
    return true;
  };
  const ARROWS: Record<string, readonly [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  root.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); close(); return; }
    const a = ARROWS[e.key];
    if (a && e.altKey && !e.ctrlKey && !e.metaKey) {
      const step = DOCK_LIMITS.step;
      if (nudge(a[0] * step, a[1] * step, e.shiftKey)) e.preventDefault();
    }
  });
  edge.addEventListener("keydown", (e) => {
    const a = ARROWS[e.key];
    if (!a || e.altKey || e.ctrlKey || e.metaKey) return;
    const step = e.shiftKey ? DOCK_LIMITS.step * 3 : DOCK_LIMITS.step;
    if (nudge(a[0] * step, a[1] * step, true)) e.preventDefault();
  });

  function onResize(): void {
    if (open) apply();
  }

  function reload(): void {
    let text: string | null = null;
    try { text = localStorage.getItem(opts.storageKey); } catch { text = null; }
    state = parseDockState(text, viewport());
    if (open) {
      if (state.minimized) { root.hidden = true; apply(); showPill(); }
      else { pill.hidden = true; root.hidden = false; apply(); }
    } else apply();
  }

  return {
    root,
    pill,
    open: openDock,
    close,
    toggle: () => (open ? close() : openDock()),
    isOpen: () => open,
    isVisible: () => open && !state.minimized && !root.hidden,
    state: () => ({ ...state }),
    setMode,
    minimize,
    restore,
    reload,
    setUnread(on) { unread = on; dot.hidden = !unread; },
    reflow() { if (open) apply(); },
  };
}
