// desktop/renderer/graph.ts — a tiny, dependency-free force-directed SVG graph for the
// personalization Knowledge view (ADR-0010 P9.3). Nodes = entities, edges = links; click
// a node to drill in. Hand-rolled simulation (O(n^2) — personal KGs are small). Supports
// drag, pan, wheel-zoom, and a kind/trust colour lens.

import type { GraphNode, PersonalGraphData } from "./bridge.ts";

const KIND_COLOR: Record<string, string> = {
  preference: "#46c8dc", interest: "#7ef0a8", decision: "#5e8df2", behavior: "#e8b23c",
  personality: "#e07bf0", skill: "#9bd2e0", goal: "#f3b8ff", relationship: "#84e3a6", link: "#aeb4c6",
};
const TRUST_COLOR: Record<string, string> = { trusted: "#46d27e", untrusted: "#5e8df2", suspicious: "#e8b23c", quarantined: "#ef5f5f" };
export const kindLabel = (k: string): string => k.replace(/^user:/, "");

interface SimNode extends GraphNode { x: number; y: number; vx: number; vy: number; r: number }
export interface GraphHandle { destroy: () => void; setLens: (l: "kind" | "trust") => void }

const NS = "http://www.w3.org/2000/svg";
const make = <K extends keyof SVGElementTagNameMap>(t: K): SVGElementTagNameMap[K] => document.createElementNS(NS, t);

export function mountGraph(host: HTMLElement, data: PersonalGraphData, onSelect: (id: string | null) => void): GraphHandle {
  host.innerHTML = "";
  const W = host.clientWidth || 600, H = host.clientHeight || 420;
  const cx = W / 2, cy = H / 2;
  let lens: "kind" | "trust" = "kind";
  let scale = 1, tx = 0, ty = 0;
  let sel: string | null = null;
  let stopped = false;

  const nodes: SimNode[] = data.nodes.map((n, i) => {
    const a = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
    return { ...n, x: cx + Math.cos(a) * 130 + (i % 7) * 4, y: cy + Math.sin(a) * 130 + (i % 5) * 4, vx: 0, vy: 0, r: 7 + Math.min(15, n.count * 2.5) };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = data.edges.filter((e) => byId.has(e.from) && byId.has(e.to));

  const svg = make("svg"); svg.setAttribute("class", "kg-svg"); svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
  const vp = make("g");
  const edgeG = make("g"); const nodeG = make("g");
  vp.append(edgeG, nodeG); svg.append(vp); host.append(svg);

  const lineFor = new Map<(typeof edges)[number], SVGLineElement>();
  for (const e of edges) { const l = make("line"); l.setAttribute("class", "kg-edge"); edgeG.append(l); lineFor.set(e, l); }

  const elFor = new Map<string, { g: SVGGElement; c: SVGCircleElement }>();
  for (const n of nodes) {
    const g = make("g"); g.setAttribute("class", "kg-node"); (g as SVGGElement & { dataset: DOMStringMap }).dataset.id = n.id;
    const c = make("circle"); c.setAttribute("r", String(n.r));
    const t = make("text"); t.setAttribute("class", "kg-label"); t.setAttribute("y", String(-n.r - 5)); t.textContent = n.name.length > 22 ? n.name.slice(0, 21) + "…" : n.name;
    g.append(c, t); nodeG.append(g); elFor.set(n.id, { g, c });
  }

  const paint = () => {
    for (const n of nodes) {
      const e = elFor.get(n.id)!;
      e.g.setAttribute("transform", `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
      e.c.setAttribute("fill", (lens === "trust" ? TRUST_COLOR[n.trust] : KIND_COLOR[kindLabel(n.kind)]) ?? "#888");
      e.g.classList.toggle("sel", n.id === sel);
    }
    for (const ed of edges) { const a = byId.get(ed.from)!, b = byId.get(ed.to)!, l = lineFor.get(ed)!; l.setAttribute("x1", a.x.toFixed(1)); l.setAttribute("y1", a.y.toFixed(1)); l.setAttribute("x2", b.x.toFixed(1)); l.setAttribute("y2", b.y.toFixed(1)); }
    vp.setAttribute("transform", `translate(${tx.toFixed(1)},${ty.toFixed(1)}) scale(${scale.toFixed(3)})`);
  };

  let drag: SimNode | null = null;
  let frames = 0, raf = 0;
  const tick = () => {
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!, b = nodes[j]!; let dx = a.x - b.x, dy = a.y - b.y; const d2 = dx * dx + dy * dy || 0.01;
      const d = Math.sqrt(d2), f = 2400 / d2; dx /= d; dy /= d; a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const e of edges) { const a = byId.get(e.from)!, b = byId.get(e.to)!; let dx = b.x - a.x, dy = b.y - a.y; const d = Math.hypot(dx, dy) || 0.01, f = (d - 92) * 0.02; dx /= d; dy /= d; a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f; }
    for (const n of nodes) { if (n === drag) { n.vx = n.vy = 0; continue; } n.vx += (cx - n.x) * 0.002; n.vy += (cy - n.y) * 0.002; n.vx *= 0.86; n.vy *= 0.86; n.x += n.vx; n.y += n.vy; }
    paint(); frames++;
    if (!stopped && frames < 700) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const reheat = () => { if (stopped) return; if (frames > 350) frames = 350; };

  let pan: { x: number; y: number } | null = null, moved = false;
  const onDown = (ev: MouseEvent) => {
    moved = false;
    const t = (ev.target as Element).closest(".kg-node") as (SVGGElement & { dataset: DOMStringMap }) | null;
    if (t) drag = byId.get(t.dataset.id!) ?? null;
    else pan = { x: ev.clientX - tx, y: ev.clientY - ty };
  };
  const onMove = (ev: MouseEvent) => {
    if (drag) { const r = svg.getBoundingClientRect(); drag.x = (ev.clientX - r.left - tx) / scale; drag.y = (ev.clientY - r.top - ty) / scale; moved = true; reheat(); }
    else if (pan) { tx = ev.clientX - pan.x; ty = ev.clientY - pan.y; moved = true; paint(); }
  };
  const onUp = () => {
    if (drag && !moved) { sel = sel === drag.id ? null : drag.id; onSelect(sel); paint(); }
    else if (pan && !moved) { if (sel) { sel = null; onSelect(null); paint(); } }
    drag = null; pan = null;
  };
  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const r = svg.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const ns = Math.max(0.3, Math.min(3, scale * Math.exp(-ev.deltaY * 0.0015)));
    tx = mx - (mx - tx) * (ns / scale); ty = my - (my - ty) * (ns / scale); scale = ns; paint();
  };
  svg.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  svg.addEventListener("wheel", onWheel, { passive: false });

  paint();
  return {
    destroy() { stopped = true; cancelAnimationFrame(raf); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); host.innerHTML = ""; },
    setLens(l) { lens = l; paint(); },
  };
}
