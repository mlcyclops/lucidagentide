// desktop/renderer/graph.ts — a tiny, dependency-free force-directed SVG graph for the
// personalization Knowledge view (ADR-0010 P9.3). Nodes = entities, edges = links; click
// a node to drill in. Hand-rolled simulation (O(n^2) — personal KGs are small). Supports
// drag, pan, wheel-zoom, and a kind/trust colour lens.
//
// P9.3+ polish (ideas ported from vasturiano's force-graph, kept ZERO-DEP per ADR-0010):
//   - curved links (quadratic bezier) instead of straight lines
//   - animated directional particle-flow along each edge (conveys link direction)
//   - tuned d3-style forces (charge / spring / light collision) for cleaner spacing
//   - smooth zoom-to-fit on first layout + double-click to re-fit

import type { GraphNode, PersonalGraphData } from "./bridge.ts";

const KIND_COLOR: Record<string, string> = {
  preference: "#46c8dc", interest: "#7ef0a8", decision: "#5e8df2", behavior: "#e8b23c",
  personality: "#e07bf0", skill: "#9bd2e0", goal: "#f3b8ff", relationship: "#84e3a6", link: "#aeb4c6",
};
const TRUST_COLOR: Record<string, string> = { trusted: "#46d27e", untrusted: "#5e8df2", suspicious: "#e8b23c", quarantined: "#ef5f5f" };
export const kindLabel = (k: string): string => k.replace(/^user:/, "");

interface SimNode extends GraphNode { x: number; y: number; vx: number; vy: number; r: number }
export interface GraphHandle { destroy: () => void; setLens: (l: "kind" | "trust") => void; fit: () => void }

const NS = "http://www.w3.org/2000/svg";
const make = <K extends keyof SVGElementTagNameMap>(t: K): SVGElementTagNameMap[K] => document.createElementNS(NS, t);

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function mountGraph(host: HTMLElement, data: PersonalGraphData, onSelect: (id: string | null) => void): GraphHandle {
  host.innerHTML = "";
  const calm = reducedMotion(); // reduced-motion: no particle flow, instant fit, gentler settle
  const W = host.clientWidth || 600, H = host.clientHeight || 420;
  const cx = W / 2, cy = H / 2;
  let lens: "kind" | "trust" = "kind";
  let scale = 1, tx = 0, ty = 0;
  let sel: string | null = null;
  let stopped = false;
  let userMoved = false; // suppresses the one-time auto-fit once the user interacts

  const nodes: SimNode[] = data.nodes.map((n, i) => {
    const a = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
    return { ...n, x: cx + Math.cos(a) * 130 + (i % 7) * 4, y: cy + Math.sin(a) * 130 + (i % 5) * 4, vx: 0, vy: 0, r: 7 + Math.min(15, n.count * 2.5) };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = data.edges.filter((e) => byId.has(e.from) && byId.has(e.to));

  const colorOf = (n: SimNode): string => (lens === "trust" ? TRUST_COLOR[n.trust] : KIND_COLOR[kindLabel(n.kind)]) ?? "#888";

  const svg = make("svg"); svg.setAttribute("class", "kg-svg"); svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");

  // ── one reusable, cheap soft-glow filter (a single blur shared by every node) ──
  const defs = make("defs");
  const filt = make("filter");
  filt.setAttribute("id", "kgGlow");
  filt.setAttribute("x", "-60%"); filt.setAttribute("y", "-60%");
  filt.setAttribute("width", "220%"); filt.setAttribute("height", "220%");
  const blur = make("feGaussianBlur");
  blur.setAttribute("in", "SourceGraphic"); blur.setAttribute("stdDeviation", "2.4"); blur.setAttribute("result", "b");
  const merge = make("feMerge");
  const m1 = make("feMergeNode"); m1.setAttribute("in", "b");
  const m2 = make("feMergeNode"); m2.setAttribute("in", "SourceGraphic");
  merge.append(m1, m2); filt.append(blur, merge); defs.append(filt); svg.append(defs);

  const vp = make("g");
  const edgeG = make("g"); const partG = make("g"); const nodeG = make("g");
  nodeG.setAttribute("class", "kg-nodes"); // hosts the shared glow filter via CSS
  vp.append(edgeG, partG, nodeG); svg.append(vp); host.append(svg);
  if (calm) partG.style.display = "none"; // reduced-motion: hide the flow particles entirely

  // ── edges as curved paths + a few flow particles each (cap for perf on bigger graphs) ──
  const PPE = edges.length > 36 ? 1 : edges.length > 14 ? 2 : 3; // particles per edge
  interface EdgeEl { e: (typeof edges)[number]; path: SVGPathElement; parts: SVGCircleElement[] }
  const edgeEls: EdgeEl[] = edges.map((e) => {
    const path = make("path"); path.setAttribute("class", "kg-edge"); edgeG.append(path);
    const parts: SVGCircleElement[] = [];
    for (let i = 0; i < PPE; i++) { const c = make("circle"); c.setAttribute("class", "kg-part"); c.setAttribute("r", "1.7"); partG.append(c); parts.push(c); }
    return { e, path, parts };
  });

  const elFor = new Map<string, { g: SVGGElement; c: SVGCircleElement }>();
  for (const n of nodes) {
    const g = make("g"); g.setAttribute("class", "kg-node"); (g as SVGGElement & { dataset: DOMStringMap }).dataset.id = n.id;
    const c = make("circle"); c.setAttribute("r", String(n.r));
    const t = make("text"); t.setAttribute("class", "kg-label"); t.setAttribute("y", String(-n.r - 5)); t.textContent = n.name.length > 22 ? n.name.slice(0, 21) + "…" : n.name;
    g.append(c, t); nodeG.append(g); elFor.set(n.id, { g, c });
  }

  // quadratic-bezier helpers (a gentle, consistent curve per edge)
  const ctrl = (a: SimNode, b: SimNode): [number, number] => {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    let dx = b.x - a.x, dy = b.y - a.y; const len = Math.hypot(dx, dy) || 1;
    const k = Math.min(46, len * 0.16); // curvature scales with length, capped
    return [mx + (-dy / len) * k, my + (dx / len) * k];
  };
  const bez = (a: number, c: number, b: number, t: number): number => { const u = 1 - t; return u * u * a + 2 * u * t * c + t * t * b; };

  let phase = 0; // advances every frame to drive particle flow
  const paint = () => {
    for (const ed of edgeEls) {
      const a = byId.get(ed.e.from)!, b = byId.get(ed.e.to)!;
      const [ccx, ccy] = ctrl(a, b);
      ed.path.setAttribute("d", `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${ccx.toFixed(1)} ${ccy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
      if (calm) continue; // reduced-motion: particles are hidden, skip their work
      const col = colorOf(a); // flow direction + colour come from the source node
      for (let i = 0; i < ed.parts.length; i++) {
        const t = ((phase * 0.0045) + i / ed.parts.length) % 1; // calmer travel, source → target
        const c = ed.parts[i]!;
        c.setAttribute("cx", bez(a.x, ccx, b.x, t).toFixed(1));
        c.setAttribute("cy", bez(a.y, ccy, b.y, t).toFixed(1));
        c.setAttribute("fill", col); c.style.color = col; // color drives the CSS drop-shadow glow
      }
    }
    for (const n of nodes) {
      const e = elFor.get(n.id)!;
      e.g.setAttribute("transform", `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
      e.c.setAttribute("fill", colorOf(n));
      e.g.classList.toggle("sel", n.id === sel);
    }
    vp.setAttribute("transform", `translate(${tx.toFixed(1)},${ty.toFixed(1)}) scale(${scale.toFixed(3)})`);
  };

  // ── smooth zoom-to-fit (eased toward a target transform over a few frames) ──
  let fitT: { sc: number; tx: number; ty: number } | null = null;
  const computeFit = () => {
    if (!nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) { minX = Math.min(minX, n.x - n.r); minY = Math.min(minY, n.y - n.r); maxX = Math.max(maxX, n.x + n.r); maxY = Math.max(maxY, n.y + n.r); }
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    const sc = Math.max(0.4, Math.min(1.5, Math.min((W - 70) / bw, (H - 70) / bh)));
    const bcx = (minX + maxX) / 2, bcy = (minY + maxY) / 2;
    fitT = { sc, tx: W / 2 - bcx * sc, ty: H / 2 - bcy * sc };
  };

  let drag: SimNode | null = null;
  let frames = 0, raf = 0;
  const SETTLE = 480;
  const tick = () => {
    if (stopped) return;
    phase++;
    const simActive = frames < SETTLE || !!drag;
    if (simActive) {
      // charge (repulsion) + light collision
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!, b = nodes[j]!; let dx = a.x - b.x, dy = a.y - b.y; const d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2); let f = 3000 / d2; dx /= d; dy /= d;
        const overlap = a.r + b.r + 6 - d; if (overlap > 0) f += overlap * 0.35; // collision push
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
      }
      // springs (link distance scales with node sizes)
      for (const e of edges) {
        const a = byId.get(e.from)!, b = byId.get(e.to)!; let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01, target = 72 + a.r + b.r, f = (d - target) * 0.03; dx /= d; dy /= d;
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
      }
      // settling damping eases from looser → tighter so motion glides to rest instead of buzzing
      const damp = frames < 120 ? 0.86 : 0.8;
      for (const n of nodes) { if (n === drag) { n.vx = n.vy = 0; continue; } n.vx += (cx - n.x) * 0.0025; n.vy += (cy - n.y) * 0.0025; n.vx *= damp; n.vy *= damp; n.x += n.vx; n.y += n.vy; }
      frames++;
      if (frames === 90 && !userMoved) computeFit(); // one-time auto-fit once the layout forms
    }
    if (fitT) { // ease current transform toward the fit target (snap instantly for reduced-motion)
      const k = calm ? 1 : 0.12; // gentler glide than before, less springy
      scale += (fitT.sc - scale) * k; tx += (fitT.tx - tx) * k; ty += (fitT.ty - ty) * k;
      if (calm || (Math.abs(fitT.sc - scale) < 0.002 && Math.abs(fitT.tx - tx) < 0.5 && Math.abs(fitT.ty - ty) < 0.5)) { scale = fitT.sc; tx = fitT.tx; ty = fitT.ty; fitT = null; }
    }
    paint();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const reheat = () => { if (!stopped && frames > SETTLE - 160) frames = SETTLE - 160; };

  let pan: { x: number; y: number } | null = null, moved = false;
  const onDown = (ev: MouseEvent) => {
    moved = false; fitT = null;
    const t = (ev.target as Element).closest(".kg-node") as (SVGGElement & { dataset: DOMStringMap }) | null;
    if (t) drag = byId.get(t.dataset.id!) ?? null;
    else pan = { x: ev.clientX - tx, y: ev.clientY - ty };
  };
  const onMove = (ev: MouseEvent) => {
    if (drag) { const r = svg.getBoundingClientRect(); drag.x = (ev.clientX - r.left - tx) / scale; drag.y = (ev.clientY - r.top - ty) / scale; moved = true; userMoved = true; reheat(); paint(); }
    else if (pan) { tx = ev.clientX - pan.x; ty = ev.clientY - pan.y; moved = true; userMoved = true; paint(); }
  };
  const onUp = () => {
    if (drag && !moved) { sel = sel === drag.id ? null : drag.id; onSelect(sel); paint(); }
    else if (pan && !moved) { if (sel) { sel = null; onSelect(null); paint(); } }
    drag = null; pan = null;
  };
  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault(); fitT = null; userMoved = true;
    const r = svg.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const ns = Math.max(0.3, Math.min(3, scale * Math.exp(-ev.deltaY * 0.0015)));
    tx = mx - (mx - tx) * (ns / scale); ty = my - (my - ty) * (ns / scale); scale = ns; paint();
  };
  const onDbl = (ev: MouseEvent) => { if (!(ev.target as Element).closest(".kg-node")) computeFit(); };
  svg.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  svg.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("dblclick", onDbl);

  paint();
  return {
    destroy() { stopped = true; cancelAnimationFrame(raf); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); host.innerHTML = ""; },
    setLens(l) { lens = l; paint(); },
    fit() { userMoved = true; computeFit(); },
  };
}
