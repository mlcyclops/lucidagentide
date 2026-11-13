// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/graph_orbit.ts - P-KG-ORBIT.1 (ADR-0470): the Knowledge view's ORBIT engine, a
// second renderer for #kgCanvas beside the flat SVG force graph (graph.ts stays the default).
//
// A dependency-free Canvas 2D scene with a hand-rolled 3D projection (yaw around Y, pitch around X,
// perspective divide). The placement comes from kg_orbit_layout.ts: height = dependency layer on the SCC
// condensation, one angular sector per kind, a funnel that widens with height, seeded jitter. Selecting
// a node computes its transitive UPSTREAM (what it depends on) and DOWNSTREAM (what depends on it, the
// blast radius) by BFS and dims everything else; a segmented toggle picks which lineage shows, the HUD
// lists the direct neighbors (click to walk) and Back steps through the walk. Slow auto-spin stops on
// hover, selection, search, the calm tier and prefers-reduced-motion. Drag rotates, wheel / pinch zooms,
// double-click on empty space re-fits. Nodes behind the near plane are skipped.
//
// The interaction pattern follows the public curriculum explorer at withmarble.com/curriculum; this is
// an independent implementation and no code was copied from it (ADR-0470).
//
// Mounted through the same GraphHandle contract as mountGraph, so app.ts swaps engines with no other
// change. Relate (drag-to-relate) is a flat-view tool: here it shows a hint instead.

import type { GraphNode, PersonalGraphData } from "./bridge.ts";
import { type GraphHandle, TRUST_COLOR, kindColor, kindLabel } from "./graph.ts";
import { lineage, orbitLayout, type OrbitLayout } from "./kg_orbit_layout.ts";

export interface OrbitView { yaw: number; pitch: number; zoom: number }
export interface OrbitPerfOpts {
  forceCalm?: boolean; // perf tier / KB preview: no spin, camera moves snap instead of gliding
  view?: OrbitView; // camera from the previous mount of this graph (per-engine cache, app.ts)
  onView?: (v: OrbitView) => void; // harvested on destroy
}
export type LineageDir = "up" | "down" | "both";

const HEIGHT = 1.5; // world height of the layer axis
const CAM = 3.4; // camera distance at zoom 1
const NEAR = 0.2; // anything closer than this to the camera is skipped
const SPIN = 0.00008; // rad per ms (about one turn every 80 s)
const ZMIN = 0.45, ZMAX = 5;
const TWEEN_MS = 700;
const DEFAULT_VIEW: OrbitView = { yaw: 0.55, pitch: 0.36, zoom: 1 };
const UP_COLOR = "#5ec8f2", DOWN_COLOR = "#e8b23c";
const MAX_ROWS = 6;

interface Cam { yaw: number; pitch: number; zoom: number; tx: number; ty: number; tz: number }

const wrapAngle = (a: number): number => { const t = Math.PI * 2; return ((((a + Math.PI) % t) + t) % t) - Math.PI; };
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function mountOrbitGraph(host: HTMLElement, data: PersonalGraphData, onSelect: (id: string | null) => void, perf: OrbitPerfOpts = {}): GraphHandle {
  host.innerHTML = "";
  host.classList.remove("kg-relating"); // a flat mount in relate mode may have left its crosshair
  const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let calmForced = !!perf.forceCalm;
  let calm = calmForced || !!mq?.matches;
  const onMq = () => { calm = calmForced || !!mq?.matches; kick(); };
  mq?.addEventListener("change", onMq);

  // ── DOM: canvas + HUD (selection) + legend (kinds) + relate hint ──
  const root = mk("div", "orb");
  const cv = mk("canvas", "orb-cv");
  cv.setAttribute("role", "img");
  const hud = mk("div", "orb-hud"); hud.hidden = true;
  const hudName = mk("div", "orb-hud-name");
  const dirSeg = mk("div", "seg kg-lens orb-dir");
  const dirBtns: Record<LineageDir, HTMLButtonElement> = {
    up: mk("button", "", "Upstream"), down: mk("button", "", "Downstream"), both: mk("button", "on", "Both"),
  };
  dirBtns.up.title = "What this depends on, transitively";
  dirBtns.down.title = "What depends on this, transitively (blast radius)";
  dirBtns.both.title = "Upstream and downstream";
  for (const d of ["up", "down", "both"] as const) { dirBtns[d].type = "button"; dirBtns[d].dataset.dir = d; dirSeg.append(dirBtns[d]); }
  const hudCount = mk("div", "orb-hud-count");
  const upSec = mk("div", "orb-sec"), downSec = mk("div", "orb-sec");
  const backBtn = mk("button", "btn-mini orb-back", "Back"); backBtn.type = "button"; backBtn.hidden = true;
  hud.append(hudName, dirSeg, hudCount, upSec, downSec, backBtn);
  const legend = mk("div", "orb-legend");
  const axisNote = mk("div", "orb-axis", "Height: dependency layer. Bottom depends on nothing.");
  const hint = mk("div", "orb-hint", "Relate needs Flat view. Switch the view to Flat to draw relationships."); hint.hidden = true;
  root.append(cv, hud, legend, axisNote, hint);
  host.append(root);
  const ctx = cv.getContext("2d");

  // ── state ──
  let nodes: GraphNode[] = [];
  let L: OrbitLayout = orbitLayout([], []);
  let wx = new Float32Array(0), wy = new Float32Array(0), wz = new Float32Array(0);
  let sx = new Float32Array(0), sy = new Float32Array(0), sd = new Float32Array(0), sr = new Float32Array(0);
  let vis = new Uint8Array(0);
  let lmask = new Uint8Array(0); // 1 upstream, 2 downstream (3 = both, possible through a cycle)
  let smask = new Uint8Array(0); // search matches
  let upList: number[] = [], downList: number[] = [];
  let lens: "kind" | "trust" = "kind";
  let dir: LineageDir = "both";
  let selIdx = -1, hovered = -1;
  let searchIds: Set<string> | null = null;
  const hiddenKinds = new Set<string>();
  const back: string[] = [];
  const v0 = perf.view ?? DEFAULT_VIEW;
  const cam: Cam = { yaw: v0.yaw, pitch: v0.pitch, zoom: v0.zoom, tx: 0, ty: 0, tz: 0 };
  let tween: { from: Cam; to: Cam; t0: number } | null = null;
  let W = 0, H = 0, dpr = 1;
  let theme = { txt: "#e6e8ee", txt2: "#aeb4c6", bg: "#0d0f14", line: "#3a4150", font: "system-ui, sans-serif" };
  let stopped = false, raf = 0, last = 0;

  const readTheme = () => {
    const cs = getComputedStyle(host);
    const v = (k: string, d: string) => cs.getPropertyValue(k).trim() || d;
    theme = { txt: v("--txt", theme.txt), txt2: v("--txt-2", theme.txt2), bg: v("--bg-0", theme.bg), line: v("--line-strong", theme.line), font: cs.fontFamily || theme.font };
  };
  const colorOf = (i: number): string => {
    const n = nodes[i]!;
    return lens === "trust" ? TRUST_COLOR[n.trust] ?? "#888" : kindColor(n.kind);
  };

  const load = (d: PersonalGraphData) => {
    const keepSel = selIdx >= 0 ? nodes[selIdx]?.id ?? null : null;
    nodes = d.nodes.slice();
    L = orbitLayout(nodes, d.edges);
    const n = nodes.length;
    wx = new Float32Array(n); wy = new Float32Array(n); wz = new Float32Array(n);
    sx = new Float32Array(n); sy = new Float32Array(n); sd = new Float32Array(n); sr = new Float32Array(n);
    vis = new Uint8Array(n); lmask = new Uint8Array(n); smask = new Uint8Array(n);
    L.points.forEach((p, i) => { wx[i] = p.x; wy[i] = (p.y - 0.5) * HEIGHT; wz[i] = p.z; });
    for (const k of [...hiddenKinds]) if (!L.kinds.some((x) => x.kind === k)) hiddenKinds.delete(k);
    selIdx = keepSel ? L.index.get(keepSel) ?? -1 : -1;
    hovered = -1;
    applySearch();
    computeLineage();
    renderLegend();
    renderHud();
    cv.setAttribute("aria-label", `Orbit graph: ${n} nodes in ${L.layers} dependency layers`);
  };

  // ── lineage + HUD ──
  const computeLineage = () => {
    lmask.fill(0); upList = []; downList = [];
    if (selIdx < 0) return;
    upList = lineage(selIdx, L.out);
    downList = lineage(selIdx, L.inn);
    for (const i of upList) lmask[i] |= 1;
    for (const i of downList) lmask[i] |= 2;
  };
  const rowsFor = (sec: HTMLElement, title: string, ids: number[]) => {
    sec.replaceChildren();
    sec.append(mk("div", "orb-sec-lbl", `${title} (${ids.length})`));
    const sorted = ids.slice().sort((a, b) => L.points[a]!.layer - L.points[b]!.layer || nodes[a]!.name.localeCompare(nodes[b]!.name));
    for (const i of sorted.slice(0, MAX_ROWS)) {
      const row = mk("button", "orb-row"); row.type = "button"; row.dataset.idx = String(i);
      const dot = mk("i", "orb-dot"); dot.style.background = colorOf(i);
      row.append(dot, mk("span", "orb-row-txt", nodes[i]!.name));
      row.title = nodes[i]!.id;
      sec.append(row);
    }
    if (sorted.length > MAX_ROWS) sec.append(mk("div", "orb-more", `+${sorted.length - MAX_ROWS} more`));
    else if (!sorted.length) sec.append(mk("div", "orb-more", "none"));
  };
  const renderHud = () => {
    if (selIdx < 0) { hud.hidden = true; return; }
    hud.hidden = false;
    const n = nodes[selIdx]!;
    hudName.textContent = n.name; hudName.title = n.id;
    for (const d of ["up", "down", "both"] as const) dirBtns[d].classList.toggle("on", d === dir);
    const up = mk("span", "orb-up", `${upList.length} upstream`), down = mk("span", "orb-down", `${downList.length} downstream`);
    hudCount.replaceChildren(up, document.createTextNode(" \u00b7 "), down, document.createTextNode(` \u00b7 layer ${L.points[selIdx]!.layer}`));
    upSec.hidden = dir === "down"; downSec.hidden = dir === "up";
    rowsFor(upSec, "Depends on directly", L.out[selIdx] ?? []);
    rowsFor(downSec, "Used by directly", L.inn[selIdx] ?? []);
    backBtn.hidden = back.length === 0;
    backBtn.textContent = back.length ? `Back (${back.length})` : "Back";
  };

  const renderLegend = () => {
    legend.replaceChildren();
    for (const k of L.kinds) {
      const chip = mk("button", "orb-chip"); chip.type = "button"; chip.dataset.kind = k.kind;
      chip.classList.toggle("off", hiddenKinds.has(k.kind));
      chip.title = hiddenKinds.has(k.kind) ? "Show this kind" : "Hide this kind";
      const dot = mk("i", "orb-dot"); dot.style.background = lens === "trust" ? "#8a90a0" : kindColor(k.kind);
      chip.append(dot, mk("span", "orb-chip-txt", `${kindLabel(k.kind)} ${k.count}`));
      legend.append(chip);
    }
  };

  // ── camera ──
  const tweenTo = (to: Partial<Cam>) => {
    const target: Cam = { ...cam, ...to };
    target.yaw = cam.yaw + wrapAngle(target.yaw - cam.yaw); // shortest way round
    if (calm) { Object.assign(cam, target); tween = null; kick(); return; }
    tween = { from: { ...cam }, to: target, t0: performance.now() };
    kick();
  };
  const focusNode = (i: number) => {
    const r = Math.hypot(wx[i]!, wz[i]!);
    const to: Partial<Cam> = { tx: wx[i]!, ty: wy[i]!, tz: wz[i]!, zoom: Math.max(cam.zoom, 1.35) };
    if (r > 0.05) to.yaw = -Math.PI / 2 - Math.atan2(wz[i]!, wx[i]!); // the node's side of the funnel faces the camera
    tweenTo(to);
  };

  const selectIdx = (i: number, push: boolean) => {
    if (push && selIdx >= 0 && selIdx !== i) back.push(nodes[selIdx]!.id);
    selIdx = i;
    computeLineage(); renderHud(); focusNode(i);
    onSelect(nodes[i]!.id);
  };
  const deselect = () => {
    if (selIdx < 0) return;
    selIdx = -1; back.length = 0;
    computeLineage(); renderHud();
    tweenTo({ tx: 0, ty: 0, tz: 0 });
    onSelect(null);
  };

  const applySearch = () => {
    smask.fill(0);
    if (!searchIds) return;
    for (const id of searchIds) { const i = L.index.get(id); if (i !== undefined) smask[i] = 1; }
  };

  // ── projection + paint ──
  const project = () => {
    const cyw = Math.cos(cam.yaw), syw = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const dist = CAM / cam.zoom, unit = Math.min(W, H) * 0.42, k = unit / 320;
    for (let i = 0; i < nodes.length; i++) {
      if (hiddenKinds.has(nodes[i]!.kind)) { vis[i] = 0; continue; }
      const X = wx[i]! - cam.tx, Y = wy[i]! - cam.ty, Z = wz[i]! - cam.tz;
      const x1 = X * cyw - Z * syw, z1 = X * syw + Z * cyw;
      const y1 = Y * cp + z1 * sp, z2 = z1 * cp - Y * sp;
      const depth = dist + z2;
      if (depth < NEAR) { vis[i] = 0; continue; } // behind the near plane
      const s = CAM / depth;
      vis[i] = 1;
      sx[i] = W / 2 + x1 * s * unit; sy[i] = H / 2 - y1 * s * unit; sd[i] = depth;
      sr[i] = Math.max(1.2, (2.3 + Math.sqrt(L.points[i]!.c) * 7) * s * k);
    }
    return dist;
  };
  const projectPoint = (X0: number, Y0: number, Z0: number): [number, number] | null => {
    const cyw = Math.cos(cam.yaw), syw = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const X = X0 - cam.tx, Y = Y0 - cam.ty, Z = Z0 - cam.tz;
    const x1 = X * cyw - Z * syw, z1 = X * syw + Z * cyw;
    const y1 = Y * cp + z1 * sp, depth = CAM / cam.zoom + z1 * cp - Y * sp;
    if (depth < NEAR) return null;
    const s = CAM / depth, unit = Math.min(W, H) * 0.42;
    return [W / 2 + x1 * s * unit, H / 2 - y1 * s * unit];
  };

  const paint = () => {
    if (!ctx || !W || !H) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const dist = project();
    const n = nodes.length;
    const selOn = selIdx >= 0, searchOn = !!searchIds && searchIds.size > 0;
    const shown = dir === "up" ? 1 : dir === "down" ? 2 : 3; // lmask bits the active lineage direction keeps lit
    const dimmed = (i: number): boolean => (selOn && i !== selIdx && (lmask[i]! & shown) === 0) || (searchOn && !smask[i]);
    const fog = (i: number): number => Math.max(0.3, Math.min(1, 1.35 - (sd[i]! - dist * 0.55) / (dist + 1.4)));

    // the layer axis: a faint spine from "depends on nothing" (bottom) to the deepest layer (top)
    const a0 = projectPoint(0, -HEIGHT / 2, 0), a1 = projectPoint(0, HEIGHT / 2, 0);
    ctx.font = `600 10px ${theme.font}`;
    if (a0 && a1) {
      ctx.globalAlpha = 0.35; ctx.strokeStyle = theme.line; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.moveTo(a0[0], a0[1]); ctx.lineTo(a1[0], a1[1]); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = 0.6; ctx.fillStyle = theme.txt2; ctx.textAlign = "left";
      ctx.fillText("layer 0", a0[0] + 6, a0[1] + 4);
      ctx.fillText(`layer ${Math.max(0, L.layers - 1)}`, a1[0] + 6, a1[1] - 4);
    }

    // edges: one batched faint pass, then the selected lineage on top in its direction's color
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.line;
    ctx.globalAlpha = selOn || searchOn ? 0.05 : 0.16;
    ctx.beginPath();
    for (let v = 0; v < n; v++) {
      if (!vis[v]) continue;
      for (const w of L.out[v]!) { if (!vis[w]) continue; ctx.moveTo(sx[v]!, sy[v]!); ctx.lineTo(sx[w]!, sy[w]!); }
    }
    ctx.stroke();
    if (selOn) {
      ctx.lineWidth = 1.4; ctx.globalAlpha = 0.8;
      if (dir !== "down") { // edges v -> w inside the upstream closure
        ctx.strokeStyle = UP_COLOR; ctx.beginPath();
        for (const v of [selIdx, ...upList]) {
          if (!vis[v]) continue;
          for (const w of L.out[v]!) if (vis[w] && lmask[w]! & 1) { ctx.moveTo(sx[v]!, sy[v]!); ctx.lineTo(sx[w]!, sy[w]!); }
        }
        ctx.stroke();
      }
      if (dir !== "up") { // edges u -> v inside the downstream closure
        ctx.strokeStyle = DOWN_COLOR; ctx.beginPath();
        for (const v of [selIdx, ...downList]) {
          if (!vis[v]) continue;
          for (const u of L.inn[v]!) if (vis[u] && lmask[u]! & 2) { ctx.moveTo(sx[u]!, sy[u]!); ctx.lineTo(sx[v]!, sy[v]!); }
        }
        ctx.stroke();
      }
    }

    // nodes, far to near
    const order: number[] = [];
    for (let i = 0; i < n; i++) if (vis[i]) order.push(i);
    order.sort((a, b) => sd[b]! - sd[a]!);
    for (const i of order) {
      ctx.globalAlpha = dimmed(i) ? 0.1 : fog(i);
      ctx.fillStyle = colorOf(i);
      ctx.beginPath(); ctx.arc(sx[i]!, sy[i]!, sr[i]!, 0, Math.PI * 2); ctx.fill();
      if ((searchOn && smask[i]) || i === hovered) {
        ctx.globalAlpha = 0.9; ctx.strokeStyle = theme.txt; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(sx[i]!, sy[i]!, sr[i]! + 2.5, 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (selOn && vis[selIdx]) {
      ctx.globalAlpha = 1; ctx.strokeStyle = theme.txt; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx[selIdx]!, sy[selIdx]!, sr[selIdx]! + 4, 0, Math.PI * 2); ctx.stroke();
    }

    // labels: the selection, its direct neighbors, search hits, the hover, else the biggest front hubs
    const want = new Set<number>();
    if (selOn) {
      want.add(selIdx);
      if (dir !== "down") for (const w of L.out[selIdx]!.slice(0, 16)) want.add(w);
      if (dir !== "up") for (const u of L.inn[selIdx]!.slice(0, 16)) want.add(u);
    } else if (searchOn) {
      for (const i of order) { if (smask[i]) want.add(i); if (want.size >= 24) break; }
    } else {
      const hubs = order.filter((i) => sd[i]! < dist + 0.2).sort((a, b) => L.points[b]!.c - L.points[a]!.c).slice(0, calm ? 6 : 10);
      for (const i of hubs) want.add(i);
    }
    if (hovered >= 0) want.add(hovered);
    ctx.font = `600 11px ${theme.font}`; ctx.textAlign = "center"; ctx.lineJoin = "round";
    for (const i of want) {
      if (!vis[i]) continue;
      const strong = i === selIdx || i === hovered;
      const name = nodes[i]!.name, max = strong ? 48 : 28;
      const label = name.length > max ? name.slice(0, max - 1) + "\u2026" : name;
      const ly = sy[i]! - sr[i]! - 6;
      ctx.globalAlpha = strong ? 1 : dimmed(i) ? 0.3 : 0.85;
      ctx.lineWidth = 3; ctx.strokeStyle = theme.bg; ctx.strokeText(label, sx[i]!, ly);
      ctx.fillStyle = strong ? theme.txt : theme.txt2; ctx.fillText(label, sx[i]!, ly);
    }
    ctx.globalAlpha = 1;
  };

  // ── loop: runs only while spinning or gliding; parks when idle ──
  const frame = (t: number) => {
    raf = 0;
    if (stopped) return;
    const dt = last ? Math.min(64, t - last) : 16;
    let animating = false;
    if (tween) {
      const p = Math.min(1, (performance.now() - tween.t0) / TWEEN_MS), e = ease(p);
      const f = tween.from, g = tween.to;
      cam.yaw = f.yaw + (g.yaw - f.yaw) * e; cam.pitch = f.pitch + (g.pitch - f.pitch) * e; cam.zoom = f.zoom + (g.zoom - f.zoom) * e;
      cam.tx = f.tx + (g.tx - f.tx) * e; cam.ty = f.ty + (g.ty - f.ty) * e; cam.tz = f.tz + (g.tz - f.tz) * e;
      if (p >= 1) tween = null; else animating = true;
    }
    // auto-spin only while nothing holds attention: no hover, selection, search, drag, calm tier or reduced motion
    if (!calm && selIdx < 0 && hovered < 0 && pointers.size === 0 && !searchIds) { cam.yaw += dt * SPIN; animating = true; }
    paint();
    if (animating) { last = t; raf = requestAnimationFrame(frame); } else last = 0;
  };
  const kick = () => { if (!stopped && raf === 0) raf = requestAnimationFrame(frame); };

  // ── sizing (devicePixelRatio aware) ──
  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    const d = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    if (!w || !h || (w === W && h === H && d === dpr)) return;
    W = w; H = h; dpr = d;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    readTheme();
    kick();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  // ── input: drag rotates, wheel / pinch zooms, click picks, hover labels ──
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; yaw: number; pitch: number } | null = null;
  let pinch: { d0: number; z0: number } | null = null;
  let moved = false;
  // The bounding rect is in VISUAL px; W / H (and the projected sx / sy) are layout px. Under a CSS `zoom` on an
  // ancestor (the browser build's app zoom, bridge.setZoom) the two differ, and an unscaled offset made every
  // pick land ~8% toward the top-left of where the user pointed. Electron's native zoom keeps the ratio at 1.
  const local = (ev: PointerEvent | MouseEvent): [number, number] => {
    const r = cv.getBoundingClientRect();
    return [(ev.clientX - r.left) * (r.width ? W / r.width : 1), (ev.clientY - r.top) * (r.height ? H / r.height : 1)];
  };
  const pick = (mx: number, my: number): number => {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (!vis[i]) continue;
      const dx = sx[i]! - mx, dy = sy[i]! - my, d = dx * dx + dy * dy, rad = Math.max(9, sr[i]! + 5);
      if (d <= rad * rad && d - sd[i]! * 4 < bestD) { best = i; bestD = d - sd[i]! * 4; } // ties go to the nearer node
    }
    return best;
  };
  const pinchDist = (): number => { const [a, b] = [...pointers.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
  const onDown = (ev: PointerEvent) => {
    cv.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 1) { drag = { x: ev.clientX, y: ev.clientY, yaw: cam.yaw, pitch: cam.pitch }; moved = false; }
    else if (pointers.size === 2) { pinch = { d0: pinchDist() || 1, z0: cam.zoom }; drag = null; moved = true; }
  };
  const onMove = (ev: PointerEvent) => {
    if (pointers.has(ev.pointerId)) {
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinch && pointers.size >= 2) {
        cam.zoom = Math.max(ZMIN, Math.min(ZMAX, pinch.z0 * (pinchDist() / pinch.d0)));
        tween = null; kick(); return;
      }
      if (drag) {
        const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        if (moved) {
          cam.yaw = drag.yaw + dx * 0.008;
          cam.pitch = Math.max(-1.3, Math.min(1.3, drag.pitch + dy * 0.006));
          tween = null; kick();
        }
        return;
      }
    }
    const [mx, my] = local(ev);
    const h = pick(mx, my);
    if (h !== hovered) { hovered = h; cv.style.cursor = h >= 0 ? "pointer" : ""; kick(); }
  };
  const onUp = (ev: PointerEvent) => {
    const wasClick = !!drag && !moved && pointers.size === 1;
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) drag = null;
    if (wasClick) {
      const [mx, my] = local(ev);
      const i = pick(mx, my);
      if (i < 0 || i === selIdx) deselect();
      else selectIdx(i, true);
    }
    kick();
  };
  const onLeave = () => { if (hovered >= 0 && pointers.size === 0) { hovered = -1; cv.style.cursor = ""; kick(); } };
  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    cam.zoom = Math.max(ZMIN, Math.min(ZMAX, cam.zoom * Math.exp(-ev.deltaY * 0.0015)));
    tween = null; kick();
  };
  const onDbl = (ev: MouseEvent) => { const [mx, my] = local(ev); if (pick(mx, my) < 0) fit(); };
  cv.addEventListener("pointerdown", onDown);
  cv.addEventListener("pointermove", onMove);
  cv.addEventListener("pointerup", onUp);
  cv.addEventListener("pointercancel", onUp);
  cv.addEventListener("pointerleave", onLeave);
  cv.addEventListener("wheel", onWheel, { passive: false });
  cv.addEventListener("dblclick", onDbl);

  hud.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const d = t.closest("[data-dir]") as HTMLElement | null;
    if (d) { dir = d.dataset.dir as LineageDir; renderHud(); kick(); return; }
    const row = t.closest("[data-idx]") as HTMLElement | null;
    if (row) { selectIdx(Number(row.dataset.idx), true); return; }
    if (t.closest(".orb-back")) {
      while (back.length) {
        const i = L.index.get(back.pop()!);
        if (i !== undefined) { selectIdx(i, false); return; }
      }
      renderHud();
    }
  });
  legend.addEventListener("click", (ev) => {
    const chip = (ev.target as HTMLElement).closest("[data-kind]") as HTMLElement | null;
    if (!chip) return;
    const k = chip.dataset.kind!;
    if (hiddenKinds.has(k)) hiddenKinds.delete(k); else hiddenKinds.add(k);
    if (hovered >= 0 && hiddenKinds.has(nodes[hovered]!.kind)) hovered = -1;
    renderLegend(); kick();
  });

  const fit = () => tweenTo({ pitch: DEFAULT_VIEW.pitch, zoom: DEFAULT_VIEW.zoom, tx: 0, ty: 0, tz: 0 });

  load(data);
  resize();
  kick();

  return {
    destroy() {
      stopped = true;
      cancelAnimationFrame(raf); raf = 0;
      ro.disconnect();
      mq?.removeEventListener("change", onMq);
      perf.onView?.({ yaw: cam.yaw, pitch: cam.pitch, zoom: cam.zoom });
      host.innerHTML = "";
    },
    setLens(l) { lens = l; renderLegend(); renderHud(); kick(); },
    fit,
    update(next) { load(next); kick(); },
    setRelateMode(on) { hint.hidden = !on; }, // relate is a flat-view tool; say so instead of silently ignoring
    clearRelatePicks() { /* no picks exist in the orbit view */ },
    setSearch(ids) {
      searchIds = ids && ids.size ? ids : null;
      applySearch();
      if (searchIds) { // focus the centroid of the drawn matches
        let cx = 0, cy = 0, cz = 0, c = 0;
        for (let i = 0; i < nodes.length; i++) if (smask[i] && !hiddenKinds.has(nodes[i]!.kind)) { cx += wx[i]!; cy += wy[i]!; cz += wz[i]!; c++; }
        if (c) tweenTo({ tx: cx / c, ty: cy / c, tz: cz / c });
      }
      kick();
    },
    setCalm(on) { calmForced = on; calm = on || !!mq?.matches; kick(); },
    select(id) {
      if (!id) { deselect(); kick(); return; }
      const i = L.index.get(id);
      if (i === undefined) { onSelect(id); return; } // not drawn (capped out): the side panel still opens
      if (hiddenKinds.delete(nodes[i]!.kind)) renderLegend(); // a picked node is always shown
      selectIdx(i, true);
    },
  };
}
