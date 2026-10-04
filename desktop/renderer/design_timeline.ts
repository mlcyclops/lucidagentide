// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/design_timeline.ts - the Motion timeline: per-layer tracks for x, y, scale, rotation and
// opacity, keyframes you add / drag / delete, an easing picker with a cubic-bezier curve editor, and a
// ruler you scrub. DOM-built (layer names are file/model text, so textContent only); the controller owns
// the document and is reached through the TimelineHost callbacks.

import type { AnimProp, DesignDoc, Ease, Keyframe } from "../../harness/creator/design/types.ts";
import { ANIM_PROPS } from "../../harness/creator/design/types.ts";
import { cubicBezierEase } from "../../harness/creator/design/anim.ts";
import { EASE_PRESETS, clampCubic, layerRows, snapToFrame } from "./design_logic.ts";

export interface KeyRef { layerId: string; prop: AnimProp; t: number }

export interface TimelineHost {
  doc(): DesignDoc | null;
  time(): number;
  playing(): boolean;
  selectedLayer(): string;
  selectedKey(): KeyRef | null;
  setTime(t: number): void;
  togglePlay(): void;
  selectLayer(id: string): void;
  selectKey(k: KeyRef | null): void;
  addKey(layerId: string, prop: AnimProp, t: number): void;
  moveKey(k: KeyRef, toT: number): void;
  deleteKey(k: KeyRef): void;
  setKeyEase(k: KeyRef, ease: Ease): void;
  setKeyValue(k: KeyRef, v: number): void;
  setTimeline(patch: { fps?: number; durationMs?: number; loop?: boolean }): void;
}

const EASES = ["linear", "hold", "ease", "ease-in", "ease-out", "ease-in-out", "cubic"] as const;
const PROP_LABEL: Record<AnimProp, string> = { x: "X", y: "Y", scale: "Scale", rotation: "Rotation", opacity: "Opacity" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const pct = (t: number, dur: number) => `${(Math.max(0, Math.min(dur, t)) / Math.max(1, dur)) * 100}%`;

/** Time under a pointer in a lane, snapped to the frame grid. */
function laneTime(lane: HTMLElement, clientX: number, doc: DesignDoc): number {
  const r = lane.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
  return Math.min(doc.timeline.durationMs, snapToFrame(f * doc.timeline.durationMs, doc.timeline.fps));
}

function keyAt(doc: DesignDoc, k: KeyRef): Keyframe | undefined {
  return doc.timeline.tracks.find((t) => t.layerId === k.layerId && t.prop === k.prop)?.keys.find((x) => x.t === k.t);
}

/** Paint the whole timeline into `host`. Cheap enough to rebuild on every change; the playhead alone is
 *  moved by `movePlayhead` during playback. */
export function buildTimeline(host: HTMLElement, h: TimelineHost): void {
  host.replaceChildren();
  const doc = h.doc();
  if (!doc) return;
  const dur = doc.timeline.durationMs;

  const head = el("div", "dsn-tl-head");
  const play = el("button", "btn-mini ok", h.playing() ? "Pause" : "Play");
  play.type = "button";
  play.addEventListener("click", () => h.togglePlay());
  const time = el("span", "cmk-pageno", `${(h.time() / 1000).toFixed(2)} s`);
  time.setAttribute("data-dsn-tl-time", "");
  const fps = el("input", "prov-key dsn-num");
  fps.type = "number"; fps.min = "1"; fps.max = "60"; fps.value = String(doc.timeline.fps);
  fps.addEventListener("change", () => h.setTimeline({ fps: Number(fps.value) }));
  const durIn = el("input", "prov-key dsn-num");
  durIn.type = "number"; durIn.min = "0.1"; durIn.max = "600"; durIn.step = "0.1"; durIn.value = String(dur / 1000);
  durIn.addEventListener("change", () => h.setTimeline({ durationMs: Math.round(Number(durIn.value) * 1000) }));
  const loopLbl = el("label", "dsn-row");
  const loop = el("input");
  loop.type = "checkbox"; loop.checked = doc.timeline.loop;
  loop.addEventListener("change", () => h.setTimeline({ loop: loop.checked }));
  loopLbl.append(loop, el("span", "dsn-lbl-wide", "Loop"));
  head.append(play, time, el("span", "dsn-lbl", "fps"), fps, el("span", "dsn-lbl", "seconds"), durIn, loopLbl);
  host.appendChild(head);

  const grid = el("div", "dsn-tl-grid");
  // Ruler: scrub by press-and-drag.
  const rulerRow = el("div", "dsn-tl-row");
  rulerRow.appendChild(el("span", "dsn-tl-name", ""));
  const ruler = el("div", "dsn-tl-lane dsn-tl-ruler");
  const secs = Math.floor(dur / 1000);
  for (let s = 0; s <= secs; s++) {
    const tick = el("span", "dsn-tl-tick", `${s}s`);
    tick.style.left = pct(s * 1000, dur);
    ruler.appendChild(tick);
  }
  ruler.addEventListener("pointerdown", (e) => {
    ruler.setPointerCapture(e.pointerId);
    h.setTime(laneTime(ruler, e.clientX, doc));
    const move = (ev: PointerEvent) => h.setTime(laneTime(ruler, ev.clientX, doc));
    const up = () => { ruler.removeEventListener("pointermove", move); ruler.removeEventListener("pointerup", up); };
    ruler.addEventListener("pointermove", move);
    ruler.addEventListener("pointerup", up);
  });
  rulerRow.appendChild(ruler);
  grid.appendChild(rulerRow);

  const sel = h.selectedLayer();
  const selKey = h.selectedKey();
  for (const row of layerRows(doc)) {
    const l = doc.layers[row.id];
    if (!l) continue;
    const tracks = doc.timeline.tracks.filter((t) => t.layerId === l.id && t.keys.length > 0);
    const props: AnimProp[] = l.id === sel ? [...ANIM_PROPS] : tracks.map((t) => t.prop);
    const header = el("div", `dsn-tl-row dsn-tl-layer${l.id === sel ? " on" : ""}`);
    const name = el("span", "dsn-tl-name", l.name);
    name.title = l.name;
    name.style.paddingLeft = `${4 + row.depth * 12}px`;
    name.addEventListener("click", () => h.selectLayer(l.id));
    header.appendChild(name);
    header.appendChild(el("div", "dsn-tl-lane dsn-tl-lane-head"));
    grid.appendChild(header);
    for (const prop of props) {
      const r = el("div", "dsn-tl-row");
      r.appendChild(el("span", "dsn-tl-name dsn-tl-prop", PROP_LABEL[prop]));
      const lane = el("div", "dsn-tl-lane");
      lane.setAttribute("data-dsn-lane", `${l.id}|${prop}`);
      const track = tracks.find((t) => t.prop === prop);
      for (const k of track?.keys ?? []) {
        const on = !!selKey && selKey.layerId === l.id && selKey.prop === prop && selKey.t === k.t;
        const d = el("span", `dsn-key${on ? " on" : ""}`);
        d.style.left = pct(k.t, dur);
        d.title = `${(k.t / 1000).toFixed(3)} s = ${Math.round(k.v * 1000) / 1000}`;
        d.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          const ref: KeyRef = { layerId: l.id, prop, t: k.t };
          h.selectKey(ref);
          d.setPointerCapture(e.pointerId);
          let to = k.t;
          const move = (ev: PointerEvent) => { to = laneTime(lane, ev.clientX, doc); d.style.left = pct(to, dur); };
          const up = () => {
            d.removeEventListener("pointermove", move);
            d.removeEventListener("pointerup", up);
            if (to !== k.t) h.moveKey(ref, to);
          };
          d.addEventListener("pointermove", move);
          d.addEventListener("pointerup", up);
        });
        lane.appendChild(d);
      }
      lane.addEventListener("pointerdown", (e) => {
        if (e.target !== lane) return;
        h.addKey(l.id, prop, laneTime(lane, e.clientX, doc));
      });
      r.appendChild(lane);
      grid.appendChild(r);
    }
  }
  const ph = el("div", "dsn-tl-playhead");
  ph.setAttribute("data-dsn-playhead", "");
  grid.appendChild(ph);
  host.appendChild(grid);
  movePlayhead(host, h.time(), dur);

  const k = selKey ? keyAt(doc, selKey) : undefined;
  if (selKey && k) host.appendChild(keyEditor(selKey, k, h));
}

/** Move the playhead and the time readout without rebuilding the panel (playback, scrubbing). */
export function movePlayhead(host: HTMLElement, t: number, durationMs: number): void {
  const ph = host.querySelector<HTMLElement>("[data-dsn-playhead]");
  const ruler = host.querySelector<HTMLElement>(".dsn-tl-ruler");
  const grid = host.querySelector<HTMLElement>(".dsn-tl-grid");
  if (ph && ruler && grid) {
    const gr = grid.getBoundingClientRect(), rr = ruler.getBoundingClientRect();
    ph.style.left = `${rr.left - gr.left + (Math.max(0, Math.min(durationMs, t)) / Math.max(1, durationMs)) * rr.width}px`;
  }
  const time = host.querySelector<HTMLElement>("[data-dsn-tl-time]");
  if (time) time.textContent = `${(t / 1000).toFixed(2)} s`;
}

function keyEditor(ref: KeyRef, k: Keyframe, h: TimelineHost): HTMLElement {
  const box = el("div", "dsn-key-editor");
  box.appendChild(el("span", "dsn-lbl", `${PROP_LABEL[ref.prop]} @ ${(ref.t / 1000).toFixed(3)} s`));
  const val = el("input", "prov-key dsn-num");
  val.type = "number"; val.step = ref.prop === "opacity" || ref.prop === "scale" ? "0.01" : "1"; val.value = String(Math.round(k.v * 1000) / 1000);
  val.addEventListener("change", () => { const v = Number(val.value); if (Number.isFinite(v)) h.setKeyValue(ref, v); });
  const ease = el("select", "prov-key");
  const current = typeof k.ease === "string" ? k.ease : "cubic";
  for (const e of EASES) { const o = el("option", undefined, e === "cubic" ? "cubic-bezier" : e); o.value = e; o.selected = e === current; ease.appendChild(o); }
  ease.addEventListener("change", () => {
    const v = ease.value;
    if (v === "cubic") h.setKeyEase(ref, { cubic: typeof k.ease === "string" ? [...(EASE_PRESETS[k.ease] ?? [0.25, 0.1, 0.25, 1])] as [number, number, number, number] : k.ease.cubic });
    else h.setKeyEase(ref, v as Exclude<Ease, { cubic: [number, number, number, number] }>);
  });
  const del = el("button", "btn-mini danger", "Delete key");
  del.type = "button";
  del.addEventListener("click", () => h.deleteKey(ref));
  const row = el("div", "dsn-row");
  row.append(el("span", "dsn-lbl", "Value"), val, el("span", "dsn-lbl", "Ease"), ease, del);
  box.appendChild(row);
  box.appendChild(el("p", "dsn-note", "The ease shapes the motion from this key to the next."));
  if (typeof k.ease !== "string") box.appendChild(cubicEditor(k.ease.cubic, (c) => h.setKeyEase(ref, { cubic: c })));
  return box;
}

/** A 160 px cubic-bezier editor: drag the two handles; numbers follow. y may overshoot (-0.5..1.5 shown). */
export function cubicEditor(init: [number, number, number, number], onChange: (c: [number, number, number, number]) => void): HTMLElement {
  const wrap = el("div", "dsn-cubic");
  const S = 160, PAD = 30;
  const c = el("canvas", "dsn-cubic-canvas");
  c.width = S; c.height = S + PAD * 2;
  let cur = clampCubic(init);
  const inputs = [0, 1, 2, 3].map((i) => {
    const n = el("input", "prov-key dsn-num");
    n.type = "number"; n.step = "0.01";
    n.addEventListener("change", () => { const next = [...cur] as [number, number, number, number]; next[i] = Number(n.value); cur = clampCubic(next); paint(); onChange(cur); });
    return n;
  });
  const toPx = (x: number, y: number) => ({ x: x * S, y: PAD + (1 - y) * S });
  const fromPx = (px: number, py: number) => ({ x: Math.max(0, Math.min(1, px / S)), y: Math.max(-0.5, Math.min(1.5, 1 - (py - PAD) / S)) });
  function paint(): void {
    inputs.forEach((n, i) => { n.value = String(Math.round(cur[i]! * 100) / 100); });
    const g = c.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.strokeStyle = "rgba(128,128,128,.35)";
    g.strokeRect(0, PAD, S, S);
    const p0 = toPx(0, 0), p3 = toPx(1, 1), p1 = toPx(cur[0], cur[1]), p2 = toPx(cur[2], cur[3]);
    g.strokeStyle = "rgba(128,128,128,.8)";
    g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.moveTo(p3.x, p3.y); g.lineTo(p2.x, p2.y); g.stroke();
    const f = cubicBezierEase(cur[0], cur[1], cur[2], cur[3]);
    g.strokeStyle = "#4b8bff"; g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i <= 64; i++) { const t = i / 64; const p = toPx(t, f(t)); if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); }
    g.stroke();
    g.lineWidth = 1;
    g.fillStyle = "#ff7a45";
    for (const p of [p1, p2]) { g.beginPath(); g.arc(p.x, p.y, 5, 0, Math.PI * 2); g.fill(); }
  }
  let drag: 0 | 1 | null = null;
  c.addEventListener("pointerdown", (e) => {
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * c.width, y = ((e.clientY - r.top) / r.height) * c.height;
    const p1 = toPx(cur[0], cur[1]), p2 = toPx(cur[2], cur[3]);
    drag = Math.hypot(x - p1.x, y - p1.y) <= Math.hypot(x - p2.x, y - p2.y) ? 0 : 1;
    c.setPointerCapture(e.pointerId);
  });
  c.addEventListener("pointermove", (e) => {
    if (drag === null) return;
    const r = c.getBoundingClientRect();
    const p = fromPx(((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height);
    const next = [...cur] as [number, number, number, number];
    next[drag * 2] = p.x; next[drag * 2 + 1] = p.y;
    cur = clampCubic(next);
    paint();
  });
  c.addEventListener("pointerup", () => { if (drag !== null) { drag = null; onChange(cur); } });
  const nums = el("div", "dsn-row");
  nums.append(...inputs);
  wrap.append(c, nums);
  paint();
  return wrap;
}
