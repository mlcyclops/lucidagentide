// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.3 (ADR-0431): the hub's SPACES model. A space is a named root layout (tmux: a window; herdr: a
// workspace) holding its own binary split tree of panes. Pure state, no I/O except the two persistence
// helpers at the bottom, so the TUI keys, the `:` prompt and the control server all drive ONE model.
//
// Ids are the control plane's addressing contract: spaces are s1, s2, ... and panes are s<n>:p<m>. Both
// counters only ever climb and are persisted with the layout, so an id an agent was handed never comes
// back pointing at a different pane (a reused id is how a scripted `kill-pane -t` hits the wrong thing).
// A pane keeps its id when its deck is rebound or it is swapped; only split mints a new one.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckId } from "./hub_tui.ts";

/** A leaf is a capability deck, or a live AGENT pane bound to a fleet lane. */
export type PaneDeck = DeckId | "agent";
export interface PaneLeaf { kind: "leaf"; id: string; deck: PaneDeck; lane?: string; laneName?: string }
/** dir "v" = side by side (vertical divider), "h" = stacked. ratio = share of `a`, default 0.5. */
export interface PaneSplit { kind: "split"; dir: "h" | "v"; ratio?: number; a: PaneNode; b: PaneNode }
export type PaneNode = PaneLeaf | PaneSplit;

export interface Space { id: string; name: string; tree: PaneNode; focus: number; zoom: boolean; nextPane: number }

/** A refused or malformed hub operation. `code` is the stable machine-readable part of the error. */
export class HubOpError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** In-order leaves - the focus ring. */
export function leaves(node: PaneNode): PaneLeaf[] {
  return node.kind === "leaf" ? [node] : [...leaves(node.a), ...leaves(node.b)];
}

/** Replace the `index`-th leaf via `f` - returns a new tree. */
function mapLeaf(node: PaneNode, index: number, f: (leaf: PaneLeaf) => PaneNode): PaneNode {
  let seen = 0;
  const walk = (n: PaneNode): PaneNode => {
    if (n.kind === "leaf") return seen++ === index ? f(n) : n;
    return { ...n, a: walk(n.a), b: walk(n.b) };
  };
  return walk(node);
}

/** Drop the `index`-th leaf; its sibling takes the whole region. Null = last pane, not removable. */
function closeLeaf(node: PaneNode, index: number): PaneNode | null {
  if (node.kind === "leaf") return null;
  let seen = 0;
  const walk = (n: PaneNode): PaneNode | null => {
    if (n.kind === "leaf") return seen++ === index ? null : n;
    const a = walk(n.a);
    const b = walk(n.b);
    if (a === null) return b;
    if (b === null) return a;
    return { ...n, a, b };
  };
  return walk(node);
}

/** tmux-ish one-line layout: `[s1:p1 | [s1:p2 / s1:p3]]` (| side by side, / stacked). */
export function layoutOf(node: PaneNode): string {
  return node.kind === "leaf" ? node.id : `[${layoutOf(node.a)} ${node.dir === "v" ? "|" : "/"} ${layoutOf(node.b)}]`;
}

// Space names render in the hub's top bar: one physical row, no control bytes, bounded.
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,40}$/;
const SPACE_ID_RE = /^s(\d+)$/;
const PANE_ID_RE = /^(s\d+):p(\d+)$/;

export class Spaces {
  spaces: Space[] = [];
  active = "";
  #nextSpace = 1;
  /** Called after every structural mutation (persistence hook). Focus/zoom moves made directly on a
   *  Space by the TUI keys are not structural; the hub saves those on exit. */
  onChange: () => void = () => {};

  constructor(fresh = true) {
    if (fresh) this.create("main");
  }

  get current(): Space {
    return this.spaces.find((s) => s.id === this.active) ?? this.spaces[0]!;
  }

  /** Resolve a space by id or exact name; omitted = the active space. */
  space(ref?: string): Space {
    if (ref === undefined || ref === "") return this.current;
    const s = this.spaces.find((x) => x.id === ref) ?? this.spaces.find((x) => x.name === ref);
    if (!s) throw new HubOpError("not_found", `no space "${ref}"`);
    return s;
  }

  #name(name: string): string {
    const n = name.trim();
    if (!NAME_RE.test(n)) throw new HubOpError("bad_name", "a space name is 1-40 printable characters");
    return n;
  }

  create(name?: string): Space {
    const id = `s${this.#nextSpace++}`;
    const s: Space = { id, name: name === undefined ? id : this.#name(name), tree: { kind: "leaf", id: `${id}:p1`, deck: "overview" }, focus: 0, zoom: false, nextPane: 2 };
    this.spaces.push(s);
    this.active = id;
    this.onChange();
    return s;
  }

  rename(ref: string | undefined, name: string): Space {
    const s = this.space(ref);
    s.name = this.#name(name);
    this.onChange();
    return s;
  }

  /** Close a space and every pane in it. The hub always keeps one: closing the last refuses. */
  close(ref?: string): Space {
    const s = this.space(ref);
    if (this.spaces.length === 1) throw new HubOpError("last_space", "the hub keeps at least one space");
    const i = this.spaces.indexOf(s);
    this.spaces.splice(i, 1);
    if (this.active === s.id) this.active = this.spaces[Math.min(i, this.spaces.length - 1)]!.id;
    this.onChange();
    return s;
  }

  focus(ref: string): Space {
    const s = this.space(ref);
    this.active = s.id;
    this.onChange();
    return s;
  }

  /** Find a pane by full id (s1:p2); omitted = the active space's focused pane. */
  pane(ref?: string): { space: Space; index: number; leaf: PaneLeaf } {
    if (ref === undefined || ref === "") {
      const space = this.current;
      const ring = leaves(space.tree);
      const index = Math.min(space.focus, ring.length - 1);
      return { space, index, leaf: ring[index]! };
    }
    const m = PANE_ID_RE.exec(ref);
    const space = m ? this.spaces.find((s) => s.id === m[1]) : undefined;
    const index = space ? leaves(space.tree).findIndex((l) => l.id === ref) : -1;
    if (!space || index < 0) throw new HubOpError("not_found", `no pane "${ref}"`);
    return { space, index, leaf: leaves(space.tree)[index]! };
  }

  /** Split a pane right (side by side) or down (stacked). The new pane copies the source's deck and
   *  lane and gets a fresh id; focus stays on the source pane. */
  split(ref: string | undefined, dir: "right" | "down"): PaneLeaf {
    const { space, index, leaf } = this.pane(ref);
    const fresh: PaneLeaf = { ...leaf, id: `${space.id}:p${space.nextPane++}` };
    space.tree = mapLeaf(space.tree, index, (l) => ({ kind: "split", dir: dir === "right" ? "v" : "h", a: l, b: fresh }));
    space.zoom = false;
    this.onChange();
    return fresh;
  }

  /** Close a pane; its sibling takes the region. The last pane of a space refuses (close the space). */
  closePane(ref?: string): PaneLeaf {
    const { space, index, leaf } = this.pane(ref);
    const next = closeLeaf(space.tree, index);
    if (!next) throw new HubOpError("last_pane", "last pane in this space - close the space instead");
    space.tree = next;
    if (index < space.focus) space.focus--;
    space.focus = Math.min(space.focus, leaves(next).length - 1);
    space.zoom = false;
    this.onChange();
    return leaf;
  }

  /** Focus a pane, switching to its space. */
  focusPane(ref: string): PaneLeaf {
    const { space, index, leaf } = this.pane(ref);
    this.active = space.id;
    if (space.focus !== index) space.zoom = false;
    space.focus = index;
    this.onChange();
    return leaf;
  }

  /** Toggle zoom on a pane (focusing it first). */
  zoom(ref?: string): boolean {
    const { space, index } = this.pane(ref);
    this.active = space.id;
    space.zoom = space.focus === index ? !space.zoom : true;
    space.focus = index;
    this.onChange();
    return space.zoom;
  }

  /** Put another deck (or an agent lane) in a pane. The pane keeps its id. */
  rebind(ref: string | undefined, deck: PaneDeck, lane?: { id: string; name: string }): PaneLeaf {
    const { space, index, leaf } = this.pane(ref);
    if (deck === "agent" && !lane) throw new HubOpError("usage", "an agent pane needs a lane");
    const next: PaneLeaf = deck === "agent" ? { kind: "leaf", id: leaf.id, deck, lane: lane!.id, laneName: lane!.name } : { kind: "leaf", id: leaf.id, deck };
    space.tree = mapLeaf(space.tree, index, () => next);
    this.onChange();
    return next;
  }

  /** Swap two panes' positions (ids travel with the panes). Same space only. */
  swap(src: string, dst: string): void {
    const a = this.pane(src);
    const b = this.pane(dst);
    if (a.space !== b.space) throw new HubOpError("cross_space", "swap-pane works within one space");
    if (a.index === b.index) return;
    a.space.tree = mapLeaf(mapLeaf(a.space.tree, a.index, () => b.leaf), b.index, () => a.leaf);
    this.onChange();
  }

  /** Move the border of the nearest enclosing split of the right orientation by `n` percent: L/U move
   *  it left/up, R/D right/down (tmux's sense). Clamped to 10-90% so no pane collapses to nothing.
   *  ponytail: percent, not cells - the model has no terminal width; cells need the render size. */
  resize(ref: string | undefined, dir: "L" | "R" | "U" | "D", n: number): number {
    const { space, leaf } = this.pane(ref);
    const want = dir === "L" || dir === "R" ? "v" : "h";
    const path: PaneSplit[] = [];
    const find = (node: PaneNode): boolean => {
      if (node.kind === "leaf") return node.id === leaf.id;
      path.push(node);
      if (find(node.a) || find(node.b)) return true;
      path.pop();
      return false;
    };
    find(space.tree);
    const split = path.reverse().find((s) => s.dir === want);
    if (!split) throw new HubOpError("no_split", `no ${want === "v" ? "side-by-side" : "stacked"} split around ${leaf.id}`);
    const delta = (dir === "L" || dir === "U" ? -n : n) / 100;
    split.ratio = Math.round(Math.min(0.9, Math.max(0.1, (split.ratio ?? 0.5) + delta)) * 100) / 100;
    this.onChange();
    return split.ratio;
  }

  list(): { id: string; name: string; active: boolean; panes: number; zoom: boolean; layout: string }[] {
    return this.spaces.map((s) => ({ id: s.id, name: s.name, active: s.id === this.active, panes: leaves(s.tree).length, zoom: s.zoom, layout: layoutOf(s.tree) }));
  }

  paneList(spaceRef?: string): { id: string; space: string; deck: PaneDeck; lane?: string; laneName?: string; focused: boolean; zoomed: boolean }[] {
    const spaces = spaceRef === undefined ? this.spaces : [this.space(spaceRef)];
    return spaces.flatMap((s) => leaves(s.tree).map((l, i) => ({
      id: l.id, space: s.id, deck: l.deck, ...(l.lane ? { lane: l.lane, laneName: l.laneName } : {}),
      focused: s.id === this.active && i === s.focus, zoomed: s.zoom && i === s.focus,
    })));
  }

  toJSON(): { v: 1; active: string; nextSpace: number; spaces: Space[] } {
    return { v: 1, active: this.active, nextSpace: this.#nextSpace, spaces: this.spaces };
  }

  /** Rebuild from saved JSON. Anything off-shape (unknown deck, malformed id, id collisions, a counter
   *  that would re-mint an existing id) is null: the hub starts fresh rather than render a guess. */
  static restore(raw: string, isDeck: (deck: string) => boolean): Spaces | null {
    let b: unknown;
    try { b = JSON.parse(raw); } catch { return null; }
    const o = b as Record<string, unknown>;
    if (typeof o !== "object" || o === null || o.v !== 1 || !Array.isArray(o.spaces) || o.spaces.length === 0) return null;
    if (typeof o.nextSpace !== "number" || !Number.isInteger(o.nextSpace)) return null;
    const out = new Spaces(false);
    const ids = new Set<string>();
    const node = (n: unknown, sid: string, max: number): PaneNode | null => {
      const x = n as Record<string, unknown>;
      if (typeof x !== "object" || x === null) return null;
      if (x.kind === "leaf") {
        const m = typeof x.id === "string" ? PANE_ID_RE.exec(x.id) : null;
        if (!m || m[1] !== sid || Number(m[2]) >= max || ids.has(x.id as string)) return null;
        if (typeof x.deck !== "string" || (x.deck !== "agent" && !isDeck(x.deck))) return null;
        if (x.deck === "agent" && (typeof x.lane !== "string" || !x.lane)) return null;
        ids.add(x.id as string);
        return x.deck === "agent"
          ? { kind: "leaf", id: x.id as string, deck: "agent", lane: x.lane as string, laneName: typeof x.laneName === "string" ? x.laneName : (x.lane as string) }
          : { kind: "leaf", id: x.id as string, deck: x.deck as DeckId };
      }
      if (x.kind !== "split" || (x.dir !== "h" && x.dir !== "v")) return null;
      const a = node(x.a, sid, max);
      const c = a && node(x.b, sid, max);
      if (!a || !c) return null;
      const ratio = typeof x.ratio === "number" && x.ratio >= 0.1 && x.ratio <= 0.9 ? x.ratio : undefined;
      return { kind: "split", dir: x.dir, ...(ratio === undefined ? {} : { ratio }), a, b: c };
    };
    for (const raw of o.spaces) {
      const s = raw as Record<string, unknown>;
      if (typeof s !== "object" || s === null) return null;
      const m = typeof s.id === "string" ? SPACE_ID_RE.exec(s.id) : null;
      if (!m || Number(m[1]) >= o.nextSpace || out.spaces.some((x) => x.id === s.id)) return null;
      if (typeof s.name !== "string" || !NAME_RE.test(s.name)) return null;
      if (typeof s.nextPane !== "number" || !Number.isInteger(s.nextPane)) return null;
      const tree = node(s.tree, s.id as string, s.nextPane);
      if (!tree) return null;
      const focus = typeof s.focus === "number" && Number.isInteger(s.focus) ? Math.max(0, Math.min(s.focus, leaves(tree).length - 1)) : 0;
      out.spaces.push({ id: s.id as string, name: s.name, tree, focus, zoom: s.zoom === true, nextPane: s.nextPane });
    }
    out.#nextSpace = o.nextSpace;
    out.active = out.spaces.some((s) => s.id === o.active) ? (o.active as string) : out.spaces[0]!.id;
    return out;
  }
}

/** Where the layout persists: beside the discovery files (LUCID_DATA_ROOT or ~/.omp). */
export function spacesPath(dir: string): string {
  return join(dir, "hub-spaces.json");
}

/** tmp + rename so a crash mid-write leaves the previous layout, never a torn one.
 *  ponytail: last writer wins when two hubs share a data root; per-hub files if that ever matters. */
export function saveSpaces(path: string, spaces: Spaces): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(spaces) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** Load a saved layout; missing or invalid is null (the caller starts fresh). */
export function loadSpaces(path: string, isDeck: (deck: string) => boolean): Spaces | null {
  try { return Spaces.restore(readFileSync(path, "utf8"), isDeck); } catch { return null; }
}
