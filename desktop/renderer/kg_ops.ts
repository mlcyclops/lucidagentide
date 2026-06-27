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
