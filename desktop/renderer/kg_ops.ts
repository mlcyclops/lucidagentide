// desktop/renderer/kg_ops.ts — pure, DOM-free helpers behind the Knowledge-graph view's
// interaction polish (increment B-KG.1, issues #112/#113/#114). Kept out of graph.ts/app.ts so the
// decision logic is unit-testable headlessly (bun test) and provable via `make demo-B-KG.1`.
//
//   - fitTransform : zoom-to-fit that can actually shrink a LARGE imported graph into the panel (#112)
//   - frameWork    : per-frame "what work is needed" decision so an idle graph stops burning CPU (#114)
//   - applyForget  : optimistic, snapshot-safe removal of a fact (+ its now-empty node/edges) (#113)

import type { PersonalGraphData } from "./bridge.ts";

// ───────────────────────── #112 zoom-to-fit ─────────────────────────

export interface FitBox { minX: number; minY: number; maxX: number; maxY: number }
export interface FitTransform { sc: number; tx: number; ty: number }
export interface FitOpts { margin?: number; min?: number; max?: number }

/** Transform that centers `box` in a W×H viewport and scales it to fit (with margin).
 *
 *  The bug (#112): the previous min-scale floor was 0.4, so a big imported graph whose bounding box
 *  needed e.g. 0.15 to fit stayed zoomed-in and overflowed the panel — the user had to hunt for it by
 *  dragging. The floor is now low enough (0.05) that large graphs genuinely fit. Returns null when the
 *  viewport has no size yet (host not laid out) so the caller never centers onto a 0×0 canvas. */
export function fitTransform(box: FitBox, W: number, H: number, opts: FitOpts = {}): FitTransform | null {
  const margin = opts.margin ?? 70, min = opts.min ?? 0.05, max = opts.max ?? 1.5;
  if (!(W > 0) || !(H > 0)) return null; // host has no usable size yet — don't fit onto nothing
  const bw = Math.max(1, box.maxX - box.minX), bh = Math.max(1, box.maxY - box.minY);
  const sc = Math.max(min, Math.min(max, Math.min((W - margin) / bw, (H - margin) / bh)));
  const bcx = (box.minX + box.maxX) / 2, bcy = (box.minY + box.maxY) / 2;
  return { sc, tx: W / 2 - bcx * sc, ty: H / 2 - bcy * sc };
}

// ───────────────────────── #114 idle CPU ─────────────────────────

export interface FrameInputs {
  simActive: boolean; // the force sim is still stepping (or a node is being dragged)
  easing: boolean;    // a zoom-to-fit transform is still easing toward its target
  calm: boolean;      // prefers-reduced-motion → particles are hidden entirely
  parity: number;     // a monotonically increasing frame counter, for idle throttling
}
export interface FrameWork {
  layout: boolean;    // recompute edge paths + node/viewport transforms (the expensive pass)
  particles: boolean; // step the flow particles (cheap; uses cached geometry)
  stop: boolean;      // nothing left to animate — halt the rAF loop until kicked
}

/** Decide the minimum work a frame needs. The old loop did a FULL repaint every single frame forever,
 *  which pegged CPU (~45%, #114) even on a settled, untouched graph. Now: only repaint layout when
 *  something actually moved; keep the particle flow alive (so it still looks good) but throttle it to
 *  ~30fps when idle; and when reduced-motion means there are no particles, stop the loop outright. */
export function frameWork({ simActive, easing, calm, parity }: FrameInputs): FrameWork {
  const moving = simActive || easing;
  return {
    layout: moving,
    particles: !calm && (moving || parity % 2 === 0), // idle → every other frame (~30fps), not 60
    stop: calm && !moving,
  };
}

// ───────────────────────── #113 optimistic forget ─────────────────────────

export interface ForgetResult { data: PersonalGraphData; nodeRemoved: string | null }

/** Remove a fact from the graph the way the server eventually will, but INSTANTLY and without mutating
 *  the input (so the caller can keep the original for rollback if the server call fails).
 *
 *  The bug (#113): forgetting awaited a 20-30s graph re-decrypt before anything changed on screen, with
 *  no button feedback — so the user kept clicking. Doing the removal locally first makes the fact row
 *  (and the node, if that was its last fact, plus its dangling edges) vanish on click. If the removed
 *  fact was the node's last, `nodeRemoved` names the dropped node so the selection can be cleared. */
export function applyForget(data: PersonalGraphData, factId: string): ForgetResult {
  const fact = data.facts.find((f) => f.id === factId);
  const facts = data.facts.filter((f) => f.id !== factId);
  if (!fact) return { data: { ...data, facts }, nodeRemoved: null };
  const entityId = fact.entity_id;
  const nodeStillHasFacts = facts.some((f) => f.entity_id === entityId);
  if (nodeStillHasFacts) {
    const nodes = data.nodes.map((n) => (n.id === entityId ? { ...n, count: Math.max(0, n.count - 1) } : n));
    return { data: { ...data, nodes, facts }, nodeRemoved: null };
  }
  const nodes = data.nodes.filter((n) => n.id !== entityId);
  const edges = data.edges.filter((e) => e.from !== entityId && e.to !== entityId);
  return { data: { nodes, edges, facts }, nodeRemoved: entityId };
}

// ───────────────────────── P-KG-REL.1 manual relate (#109 / ADR-0075) ─────────────────────────

export interface HitNode { id: string; x: number; y: number; r: number }

/** The id of the node under a point in graph-space (for drag-to-relate's drop target), or null.
 *  `excludeId` skips the node the link drag started from so you can't relate a node to itself. */
export function nodeAtPoint(nodes: HitNode[], x: number, y: number, excludeId?: string): string | null {
  for (const n of nodes) {
    if (n.id === excludeId) continue;
    const dx = n.x - x, dy = n.y - y, rr = n.r + 6; // small grab padding around the node
    if (dx * dx + dy * dy <= rr * rr) return n.id;
  }
  return null;
}

/** Toggle a node in the ordered multi-select pick list (for the "Relate" action). Preserves click order
 *  so the relate is chained in the sequence the user picked. */
export function togglePick(picks: string[], id: string): string[] {
  return picks.includes(id) ? picks.filter((p) => p !== id) : [...picks, id];
}

/** Consecutive [from,to] pairs from an ordered pick list — a 3-pick A,B,C → A→B, B→C (a chain, not a
 *  clique), which is the least-surprising default for "relate these nodes". */
export function chainPairs(ids: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i + 1 < ids.length; i++) out.push([ids[i]!, ids[i + 1]!]);
  return out;
}

/** Ids of nodes whose name matches a search query (P-KG-SEARCH.1) — case-insensitive substring. An empty
 *  query matches nothing (→ no filter / clear). Pure so the matching is unit-testable. */
export function matchNodes(nodes: ReadonlyArray<{ id: string; name: string }>, query: string): Set<string> {
  const q = query.trim().toLowerCase();
  const out = new Set<string>();
  if (!q) return out;
  for (const n of nodes) if (n.name.toLowerCase().includes(q)) out.add(n.id);
  return out;
}

/** The relationship label from a raw input (P-KG-REL.2): trimmed, or "related" when blank/whitespace.
 *  The server still sanitizes + length-caps it; this is the UI default. */
export function resolveRelationLabel(raw: string | null | undefined): string {
  return (raw ?? "").trim() || "related";
}

/** Optimistically add a user-authored edge (dedup on from+to+relation), without mutating the input — so
 *  the edge shows instantly and the caller can roll back if the server rejects it. */
export function addEdgeOptimistic(data: PersonalGraphData, from: string, to: string, relation: string): PersonalGraphData {
  if (data.edges.some((e) => e.from === from && e.to === to && e.relation === relation)) return data;
  return { ...data, edges: [...data.edges, { from, to, relation }] };
}

/** Optimistically remove an edge (P-KG-REL.3) without mutating the input — so it vanishes on click and the
 *  caller can roll back on server failure. Matches the exact from+to+relation triple. */
export function removeEdgeOptimistic(data: PersonalGraphData, from: string, to: string, relation: string): PersonalGraphData {
  const edges = data.edges.filter((e) => !(e.from === from && e.to === to && e.relation === relation));
  return edges.length === data.edges.length ? data : { ...data, edges };
}
