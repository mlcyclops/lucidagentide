// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/kg_orbit_layout.ts - P-KG-ORBIT.1 (ADR-0470): the pure, DOM-free core of the Knowledge
// view's ORBIT engine (graph_orbit.ts). Everything here is deterministic and unit-tested headlessly.
//
//   - sccs           : iterative Tarjan strongly-connected components (no recursion: import graphs are
//                      deep and cyclic, and a recursive walk would blow the stack on a big repo)
//   - layersOf       : dependency layer per node on the SCC CONDENSATION (a cycle shares one layer;
//                      layer = 1 + the deepest thing a node depends on; depends-on-nothing = 0)
//   - orbitLayout    : 3D placement. Height = layer, angular sector per kind proportional to its count,
//                      sub-sectors per directory/file inside a kind, radius widening with height (a
//                      funnel), and seeded jitter from a hash of the node id - same input, same picture
//   - lineage        : BFS transitive closure in one direction (upstream = what a node depends on,
//                      downstream = what depends on it, the blast radius)
//
// Edge direction is the graph's own: `from` depends on / imports / references `to`.
// The layout PATTERN (height axis + sectors + funnel + lineage dimming) follows the public curriculum
// explorer at withmarble.com/curriculum; no code was copied (ADR-0470).

export interface OrbitInNode { id: string; kind: string; count: number }
export interface OrbitInEdge { from: string; to: string }

export interface OrbitPoint {
  id: string;
  kind: string;
  x: number; // [-1, 1]
  y: number; // [0, 1], 0 = depends on nothing, 1 = the deepest layer
  z: number; // [-1, 1]
  layer: number;
  comp: number; // SCC id (nodes in one cycle share it)
  c: number; // centrality 0..1 (degree / max degree)
}

export interface OrbitLayout {
  points: OrbitPoint[]; // same order as the input nodes
  index: Map<string, number>;
  out: number[][]; // i depends on out[i][*] (deduped, no self loops)
  inn: number[][]; // in[i][*] depends on i
  layers: number; // number of distinct layers (max layer + 1)
  kinds: Array<{ kind: string; count: number }>; // sector order (count desc, then name)
}

/** FNV-1a 32-bit hash of a string. Stable across runs and platforms. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** A deterministic value in [0, 1) for (id, salt): mulberry32 seeded from the id hash. */
export function jitter(id: string, salt: number): number {
  let t = (hash32(id) + Math.imul(salt + 1, 0x6d2b79f5)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Strongly-connected components by an ITERATIVE Tarjan walk. Components are numbered in completion
 *  order, which for edges "v depends on w" means every dependency's component is numbered before its
 *  dependents' (comp[w] <= comp[v] for every edge v -> w). */
export function sccs(n: number, out: ReadonlyArray<ReadonlyArray<number>>): { comp: Int32Array; count: number } {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const edgeAt = new Int32Array(n);
  const stack: number[] = [];
  const call: number[] = [];
  let next = 0, count = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    index[s] = low[s] = next++; stack.push(s); onStack[s] = 1; call.push(s);
    while (call.length) {
      const v = call[call.length - 1]!;
      const adj = out[v] ?? [];
      if (edgeAt[v] < adj.length) {
        const w = adj[edgeAt[v]++]!;
        if (index[w] === -1) { index[w] = low[w] = next++; stack.push(w); onStack[w] = 1; call.push(w); }
        else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
        continue;
      }
      call.pop();
      if (call.length) { const u = call[call.length - 1]!; low[u] = Math.min(low[u]!, low[v]!); }
      if (low[v] === index[v]) {
        let w: number;
        do { w = stack.pop()!; onStack[w] = 0; comp[w] = count; } while (w !== v);
        count++;
      }
    }
  }
  return { comp, count };
}

/** Dependency layer per node, computed on the SCC condensation: a node that depends on nothing is
 *  layer 0; otherwise 1 + the highest layer among the OTHER components it depends on. Every node of a
 *  cycle gets the same layer. Linear in nodes + edges, no recursion. */
export function layersOf(n: number, out: ReadonlyArray<ReadonlyArray<number>>): { layer: Int32Array; comp: Int32Array } {
  const { comp, count } = sccs(n, out);
  // Bucket nodes by component so components are finished in ascending (dependencies-first) order.
  const head = new Int32Array(count).fill(-1);
  const link = new Int32Array(n).fill(-1);
  for (let v = 0; v < n; v++) { const c = comp[v]!; link[v] = head[c]!; head[c] = v; }
  const compLayer = new Int32Array(count);
  for (let c = 0; c < count; c++) {
    let best = 0;
    for (let v = head[c]!; v !== -1; v = link[v]!) {
      for (const w of out[v] ?? []) {
        const cw = comp[w]!;
        if (cw !== c) best = Math.max(best, compLayer[cw]! + 1);
      }
    }
    compLayer[c] = best;
  }
  const layer = new Int32Array(n);
  for (let v = 0; v < n; v++) layer[v] = compLayer[comp[v]!]!;
  return { layer, comp };
}

/** Transitive closure from `start` along `adj` by BFS, in visit order, excluding `start` itself.
 *  Pass `out` for upstream (what it depends on) or `inn` for downstream (what depends on it). */
export function lineage(start: number, adj: ReadonlyArray<ReadonlyArray<number>>): number[] {
  const seen = new Uint8Array(adj.length);
  seen[start] = 1;
  const order: number[] = [];
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    for (const w of adj[queue[qi]!] ?? []) {
      if (seen[w]) continue;
      seen[w] = 1; order.push(w); queue.push(w);
    }
  }
  return order;
}

/** The sub-sector a node sits in within its kind: a symbol's file (`file#symbol`), a path's directory,
 *  or the kind itself for flat ids (personal / KB graphs). */
export function groupOf(id: string, kind: string): string {
  const hash = id.indexOf("#");
  if (hash > 0) return id.slice(0, hash);
  const slash = id.lastIndexOf("/");
  return slash > 0 ? id.slice(0, slash) : kind;
}

const TAU = Math.PI * 2;

/** Proportional angular spans: `entries` sorted count desc then name, laid end to end from `start`. */
function spans(entries: Map<string, number>, start: number, total: number): Map<string, { a0: number; span: number }> {
  const sorted = [...entries].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const sum = sorted.reduce((s, [, c]) => s + c, 0) || 1;
  const outMap = new Map<string, { a0: number; span: number }>();
  let a = start;
  for (const [k, c] of sorted) { const span = (total * c) / sum; outMap.set(k, { a0: a, span }); a += span; }
  return outMap;
}

/** Deterministic 3D placement for the orbit view. Independent of input ORDER: the same set of nodes and
 *  edges always yields the same coordinates for each id. */
export function orbitLayout(nodes: ReadonlyArray<OrbitInNode>, edges: ReadonlyArray<OrbitInEdge>): OrbitLayout {
  const n = nodes.length;
  const index = new Map<string, number>();
  nodes.forEach((nd, i) => index.set(nd.id, i));
  const outSets: Array<Set<number>> = nodes.map(() => new Set<number>());
  for (const e of edges) {
    const a = index.get(e.from), b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    outSets[a]!.add(b);
  }
  const out = outSets.map((s) => [...s]);
  const inn: number[][] = nodes.map(() => []);
  out.forEach((ws, v) => { for (const w of ws) inn[w]!.push(v); });
  const { layer, comp } = layersOf(n, out);
  let maxLayer = 0;
  for (let i = 0; i < n; i++) maxLayer = Math.max(maxLayer, layer[i]!);
  let maxCount = 0;
  for (const nd of nodes) maxCount = Math.max(maxCount, nd.count);

  // Kind sectors (proportional to count), then directory/file sub-sectors inside each kind.
  const kindCount = new Map<string, number>();
  const groupCount = new Map<string, Map<string, number>>();
  for (const nd of nodes) {
    kindCount.set(nd.kind, (kindCount.get(nd.kind) ?? 0) + 1);
    const g = groupOf(nd.id, nd.kind);
    let m = groupCount.get(nd.kind);
    if (!m) { m = new Map(); groupCount.set(nd.kind, m); }
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  const kindSpan = spans(kindCount, -Math.PI / 2, TAU);
  const groupSpan = new Map<string, Map<string, { a0: number; span: number }>>();
  for (const [k, m] of groupCount) {
    const ks = kindSpan.get(k)!;
    const pad = Math.min(ks.span * 0.08, 0.12); // a visible gap between neighbouring kinds
    groupSpan.set(k, spans(m, ks.a0 + pad / 2, Math.max(0, ks.span - pad)));
  }

  const points: OrbitPoint[] = nodes.map((nd, i) => {
    const y = maxLayer > 0 ? layer[i]! / maxLayer : 0.5;
    const gs = groupSpan.get(nd.kind)!.get(groupOf(nd.id, nd.kind))!;
    const theta = gs.a0 + gs.span * (0.1 + 0.8 * jitter(nd.id, 1));
    const r = Math.min(0.98, 0.25 + 0.65 * y + 0.1 * (jitter(nd.id, 2) - 0.5));
    return {
      id: nd.id, kind: nd.kind,
      x: r * Math.cos(theta), y, z: r * Math.sin(theta),
      layer: layer[i]!, comp: comp[i]!,
      c: maxCount > 0 ? Math.max(0, nd.count) / maxCount : 0,
    };
  });
  const kinds = [...kindCount].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([kind, count]) => ({ kind, count }));
  return { points, index, out, inn, layers: maxLayer + 1, kinds };
}
