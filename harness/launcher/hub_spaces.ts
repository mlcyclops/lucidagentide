// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.3 (ADR-0436) + P-TUI.5 (ADR-0433): the hub's SPACES model. A space is a named group of TABS
// (tmux: a session; herdr: a workspace), and a tab is one root layout holding its own binary split
// tree of panes (tmux: a window). Pure state, no I/O except the two persistence helpers at the
// bottom, so the TUI keys, the rail, the `:` prompt and the control server all drive ONE model.
//
// Ids are the control plane's addressing contract: spaces are s1, s2, ...; tabs are s<n>:t<m>; panes
// are s<n>:p<m>. Pane ids stay SPACE-scoped (not tab-scoped) so every id the v1 control plane handed
// out still resolves after the v2 migration. Every counter only ever climbs and is persisted with the
// layout, so an id an agent was handed never comes back pointing at a different thing (a reused id is
// how a scripted `kill-pane -t` hits the wrong pane). A pane keeps its id when its deck is rebound or
// it is swapped; only split and a new tab mint one.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckId } from "./hub_tui.ts";

/** A leaf is a capability deck, or a live AGENT pane bound to a fleet lane. */
export type PaneDeck = DeckId | "agent";
export interface PaneLeaf { kind: "leaf"; id: string; deck: PaneDeck; lane?: string; laneName?: string }
/** dir "v" = side by side (vertical divider), "h" = stacked. ratio = share of `a`, default 0.5. */
export interface PaneSplit { kind: "split"; dir: "h" | "v"; ratio?: number; a: PaneNode; b: PaneNode }
export type PaneNode = PaneLeaf | PaneSplit;

export interface Tab { id: string; name: string; tree: PaneNode; focus: number; zoom: boolean }
export interface Space { id: string; name: string; tabs: Tab[]; activeTab: string; nextPane: number; nextTab: number }

/** A refused or malformed hub operation. `code` is the stable machine-readable part of the error. */
export class HubOpError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** In-order leaves - the focus ring. */
export function leaves(node: PaneNode): PaneLeaf[] {
  return node.kind === "leaf" ? [node] : [...leaves(node.a), ...leaves(node.b)];
}

/** Every pane in a space, across its tabs. */
export function spacePanes(s: Space): number {
  return s.tabs.reduce((n, t) => n + leaves(t.tree).length, 0);
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

// Space and tab names render in the top bar and the rail: one physical row, no control bytes, bounded.
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,40}$/;
const SPACE_ID_RE = /^s(\d+)$/;
const TAB_ID_RE = /^(s\d+):t(\d+)$/;
const PANE_ID_RE = /^(s\d+):p(\d+)$/;

const activeTabOf = (s: Space): Tab => s.tabs.find((t) => t.id === s.activeTab) ?? s.tabs[0]!;

export class Spaces {
  spaces: Space[] = [];
  active = "";
  /** The hub's left rail (P-TUI.5) is open. Persisted with the layout: it is how the hub looks. */
  rail = true;
  #nextSpace = 1;
  /** Called after every structural mutation (persistence hook). Focus/zoom moves made directly on a
   *  Tab by the TUI keys are not structural; the hub saves those on exit. */
  onChange: () => void = () => {};

  constructor(fresh = true) {
    if (fresh) this.create("main");
  }

  get current(): Space {
    return this.spaces.find((s) => s.id === this.active) ?? this.spaces[0]!;
  }

  /** The active space's active tab: the layout on screen. */
  get tab(): Tab {
    return activeTabOf(this.current);
  }

  /** Resolve a space by id or exact name; omitted = the active space. */
  space(ref?: string): Space {
    if (ref === undefined || ref === "") return this.current;
    const s = this.spaces.find((x) => x.id === ref) ?? this.spaces.find((x) => x.name === ref);
    if (!s) throw new HubOpError("not_found", `no space "${ref}"`);
    return s;
  }

  /** Resolve a tab by id (s1:t2, any space) or exact name in the active space; omitted = the active tab. */
  findTab(ref?: string): { space: Space; tab: Tab } {
    if (ref === undefined || ref === "") return { space: this.current, tab: this.tab };
    const m = TAB_ID_RE.exec(ref);
    const space = m ? this.spaces.find((s) => s.id === m[1]) : this.current;
    const tab = space?.tabs.find((t) => (m ? t.id === ref : t.name === ref));
    if (!space || !tab) throw new HubOpError("not_found", `no tab "${ref}"`);
    return { space, tab };
  }

  #name(name: string, what: "space" | "tab"): string {
    const n = name.trim();
    if (!NAME_RE.test(n)) throw new HubOpError("bad_name", `a ${what} name is 1-40 printable characters`);
    return n;
  }

  /** Mint a tab (and its first pane) in `s`. Does not attach it. */
  #newTab(s: Space, name?: string): Tab {
    const id = `${s.id}:t${s.nextTab++}`;
    return { id, name: name === undefined ? id.slice(s.id.length + 1) : this.#name(name, "tab"), tree: { kind: "leaf", id: `${s.id}:p${s.nextPane++}`, deck: "overview" }, focus: 0, zoom: false };
  }

  create(name?: string): Space {
    const id = `s${this.#nextSpace++}`;
    const s: Space = { id, name: name === undefined ? id : this.#name(name, "space"), tabs: [], activeTab: "", nextPane: 1, nextTab: 1 };
    const t = this.#newTab(s);
    s.tabs.push(t);
    s.activeTab = t.id;
    this.spaces.push(s);
    this.active = id;
    this.onChange();
    return s;
  }

  rename(ref: string | undefined, name: string): Space {
    const s = this.space(ref);
    s.name = this.#name(name, "space");
    this.onChange();
    return s;
  }

  /** Close a space and every tab and pane in it. The hub always keeps one: closing the last refuses. */
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

  /** New tab in a space (default: the active one); it becomes the active tab of the active space. */
  createTab(spaceRef?: string, name?: string): Tab {
    const s = this.space(spaceRef);
    const t = this.#newTab(s, name);
    s.tabs.push(t);
    s.activeTab = t.id;
    this.active = s.id;
    this.onChange();
    return t;
  }

  renameTab(ref: string | undefined, name: string): Tab {
    const { tab } = this.findTab(ref);
    tab.name = this.#name(name, "tab");
    this.onChange();
    return tab;
  }

  /** Close a tab and its panes. A space always keeps one tab: closing the last refuses. */
  closeTab(ref?: string): Tab {
    const { space, tab } = this.findTab(ref);
    if (space.tabs.length === 1) throw new HubOpError("last_tab", "a space keeps at least one tab - close the space instead");
    const i = space.tabs.indexOf(tab);
    space.tabs.splice(i, 1);
    if (space.activeTab === tab.id) space.activeTab = space.tabs[Math.min(i, space.tabs.length - 1)]!.id;
    this.onChange();
    return tab;
  }

  /** Focus a tab, switching to its space. */
  focusTab(ref: string): Tab {
    const { space, tab } = this.findTab(ref);
    this.active = space.id;
    space.activeTab = tab.id;
    this.onChange();
    return tab;
  }

  /** Find a pane by full id (s1:p2), in any tab of its space; omitted = the focused pane on screen. */
  pane(ref?: string): { space: Space; tab: Tab; index: number; leaf: PaneLeaf } {
    if (ref === undefined || ref === "") {
      const space = this.current;
      const tab = activeTabOf(space);
      const ring = leaves(tab.tree);
      const index = Math.min(tab.focus, ring.length - 1);
      return { space, tab, index, leaf: ring[index]! };
    }
    const m = PANE_ID_RE.exec(ref);
    const space = m ? this.spaces.find((s) => s.id === m[1]) : undefined;
    for (const tab of space?.tabs ?? []) {
      const ring = leaves(tab.tree);
      const index = ring.findIndex((l) => l.id === ref);
      if (index >= 0) return { space: space!, tab, index, leaf: ring[index]! };
    }
    throw new HubOpError("not_found", `no pane "${ref}"`);
  }

  /** Split a pane right (side by side) or down (stacked). The new pane copies the source's deck and
   *  lane and gets a fresh id; focus stays on the source pane. */
  split(ref: string | undefined, dir: "right" | "down"): PaneLeaf {
    const { space, tab, index, leaf } = this.pane(ref);
    const fresh: PaneLeaf = { ...leaf, id: `${space.id}:p${space.nextPane++}` };
    tab.tree = mapLeaf(tab.tree, index, (l) => ({ kind: "split", dir: dir === "right" ? "v" : "h", a: l, b: fresh }));
    tab.zoom = false;
    this.onChange();
    return fresh;
  }

  /** Close a pane; its sibling takes the region. The last pane of a tab refuses (close the tab). */
  closePane(ref?: string): PaneLeaf {
    const { tab, index, leaf } = this.pane(ref);
    const next = closeLeaf(tab.tree, index);
    if (!next) throw new HubOpError("last_pane", "last pane in this tab - close the tab instead");
    tab.tree = next;
    if (index < tab.focus) tab.focus--;
    tab.focus = Math.min(tab.focus, leaves(next).length - 1);
    tab.zoom = false;
    this.onChange();
    return leaf;
  }

  /** Focus a pane, switching to its space and tab. */
  focusPane(ref: string): PaneLeaf {
    const { space, tab, index, leaf } = this.pane(ref);
    this.active = space.id;
    space.activeTab = tab.id;
    if (tab.focus !== index) tab.zoom = false;
    tab.focus = index;
    this.onChange();
    return leaf;
  }

  /** Toggle zoom on a pane (focusing it, its tab and its space first). */
  zoom(ref?: string): boolean {
    const { space, tab, index } = this.pane(ref);
    this.active = space.id;
    space.activeTab = tab.id;
    tab.zoom = tab.focus === index ? !tab.zoom : true;
    tab.focus = index;
    this.onChange();
    return tab.zoom;
  }

  /** Put another deck (or an agent lane) in a pane. The pane keeps its id. */
  rebind(ref: string | undefined, deck: PaneDeck, lane?: { id: string; name: string }): PaneLeaf {
    const { tab, index, leaf } = this.pane(ref);
    if (deck === "agent" && !lane) throw new HubOpError("usage", "an agent pane needs a lane");
    const next: PaneLeaf = deck === "agent" ? { kind: "leaf", id: leaf.id, deck, lane: lane!.id, laneName: lane!.name } : { kind: "leaf", id: leaf.id, deck };
    tab.tree = mapLeaf(tab.tree, index, () => next);
    this.onChange();
    return next;
  }

  /** Swap two panes' positions (ids travel with the panes). Same tab only. */
  swap(src: string, dst: string): void {
    const a = this.pane(src);
    const b = this.pane(dst);
    if (a.space !== b.space) throw new HubOpError("cross_space", "swap-pane works within one tab");
    if (a.tab !== b.tab) throw new HubOpError("cross_tab", "swap-pane works within one tab");
    if (a.index === b.index) return;
    a.tab.tree = mapLeaf(mapLeaf(a.tab.tree, a.index, () => b.leaf), b.index, () => a.leaf);
    this.onChange();
  }

  /** Move the border of the nearest enclosing split of the right orientation by `n` percent: L/U move
   *  it left/up, R/D right/down (tmux's sense). Clamped to 10-90% so no pane collapses to nothing.
   *  ponytail: percent, not cells - the model has no terminal width; cells need the render size. */
  resize(ref: string | undefined, dir: "L" | "R" | "U" | "D", n: number): number {
    const { tab, leaf } = this.pane(ref);
    const want = dir === "L" || dir === "R" ? "v" : "h";
    const path: PaneSplit[] = [];
    const find = (node: PaneNode): boolean => {
      if (node.kind === "leaf") return node.id === leaf.id;
      path.push(node);
      if (find(node.a) || find(node.b)) return true;
      path.pop();
      return false;
    };
    find(tab.tree);
    const split = path.reverse().find((s) => s.dir === want);
    if (!split) throw new HubOpError("no_split", `no ${want === "v" ? "side-by-side" : "stacked"} split around ${leaf.id}`);
    const delta = (dir === "L" || dir === "U" ? -n : n) / 100;
    split.ratio = Math.round(Math.min(0.9, Math.max(0.1, (split.ratio ?? 0.5) + delta)) * 100) / 100;
    this.onChange();
    return split.ratio;
  }

  /** Open or close the rail. */
  setRail(on: boolean): void {
    this.rail = on;
    this.onChange();
  }

  list(): { id: string; name: string; active: boolean; panes: number; tabs: number; activeTab: string }[] {
    return this.spaces.map((s) => ({ id: s.id, name: s.name, active: s.id === this.active, panes: spacePanes(s), tabs: s.tabs.length, activeTab: s.activeTab }));
  }

  /** Tabs of one space (default: every space). `active` = the space's active tab; `focused` = on screen. */
  tabList(spaceRef?: string): { id: string; space: string; name: string; active: boolean; focused: boolean; panes: number; zoom: boolean; layout: string }[] {
    const spaces = spaceRef === undefined ? this.spaces : [this.space(spaceRef)];
    return spaces.flatMap((s) => s.tabs.map((t) => ({
      id: t.id, space: s.id, name: t.name, active: s.activeTab === t.id, focused: s.id === this.active && s.activeTab === t.id,
      panes: leaves(t.tree).length, zoom: t.zoom, layout: layoutOf(t.tree),
    })));
  }

  /** Panes of every space, one space, or one tab. */
  paneList(scope: { space?: string; tab?: string } = {}): { id: string; space: string; tab: string; deck: PaneDeck; lane?: string; laneName?: string; focused: boolean; zoomed: boolean }[] {
    const tabs = scope.tab !== undefined
      ? [this.findTab(scope.tab)]
      : (scope.space === undefined ? this.spaces : [this.space(scope.space)]).flatMap((space) => space.tabs.map((tab) => ({ space, tab })));
    return tabs.flatMap(({ space: s, tab: t }) => leaves(t.tree).map((l, i) => ({
      id: l.id, space: s.id, tab: t.id, deck: l.deck, ...(l.lane ? { lane: l.lane, laneName: l.laneName } : {}),
      focused: s.id === this.active && s.activeTab === t.id && i === t.focus, zoomed: t.zoom && i === t.focus,
    })));
  }

  toJSON(): { v: 2; active: string; nextSpace: number; rail: boolean; spaces: Space[] } {
    return { v: 2, active: this.active, nextSpace: this.#nextSpace, rail: this.rail, spaces: this.spaces };
  }

  /** Rebuild from saved JSON. v2 loads as v2; a v1 file (P-TUI.3: one tree per space) migrates ONE
   *  WAY by wrapping each space's tree in tab t1, keeping every pane id. The version field decides the
   *  reading, never the shape, so a v2 file cannot load as v1 (or the reverse). Anything off-shape
   *  (unknown deck, malformed id, id collisions, a counter that would re-mint an existing id) is null:
   *  the hub starts fresh rather than render a guess. */
  static restore(raw: string, isDeck: (deck: string) => boolean): Spaces | null {
    let b: unknown;
    try { b = JSON.parse(raw); } catch { return null; }
    const o = b as Record<string, unknown>;
    if (typeof o !== "object" || o === null || (o.v !== 1 && o.v !== 2) || !Array.isArray(o.spaces) || o.spaces.length === 0) return null;
    if (typeof o.nextSpace !== "number" || !Number.isInteger(o.nextSpace)) return null;
    // v1 -> v2: the space's one layout becomes its first tab. Off-shape input stays off-shape (a space
    // without a tree wraps to a tab without one and fails validation below).
    const rawSpaces: unknown[] = o.v === 2 ? o.spaces : o.spaces.map((x) => {
      const s = x as Record<string, unknown>;
      if (typeof s !== "object" || s === null) return s;
      return { id: s.id, name: s.name, nextPane: s.nextPane, nextTab: 2, activeTab: `${String(s.id)}:t1`, tabs: [{ id: `${String(s.id)}:t1`, name: "t1", tree: s.tree, focus: s.focus, zoom: s.zoom }] };
    });
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
    const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
    for (const raw of rawSpaces) {
      const s = raw as Record<string, unknown>;
      if (typeof s !== "object" || s === null) return null;
      const m = typeof s.id === "string" ? SPACE_ID_RE.exec(s.id) : null;
      if (!m || Number(m[1]) >= o.nextSpace || out.spaces.some((x) => x.id === s.id)) return null;
      if (typeof s.name !== "string" || !NAME_RE.test(s.name)) return null;
      if (!count(s.nextPane) || !count(s.nextTab) || !Array.isArray(s.tabs) || s.tabs.length === 0) return null;
      const sid = s.id as string;
      const tabs: Tab[] = [];
      for (const rt of s.tabs) {
        const t = rt as Record<string, unknown>;
        if (typeof t !== "object" || t === null) return null;
        const tm = typeof t.id === "string" ? TAB_ID_RE.exec(t.id) : null;
        if (!tm || tm[1] !== sid || Number(tm[2]) >= s.nextTab || tabs.some((x) => x.id === t.id)) return null;
        if (typeof t.name !== "string" || !NAME_RE.test(t.name)) return null;
        const tree = node(t.tree, sid, s.nextPane);
        if (!tree) return null;
        const focus = count(t.focus) ? Math.max(0, Math.min(t.focus, leaves(tree).length - 1)) : 0;
        tabs.push({ id: t.id as string, name: t.name, tree, focus, zoom: t.zoom === true });
      }
      const activeTab = tabs.some((t) => t.id === s.activeTab) ? (s.activeTab as string) : tabs[0]!.id;
      out.spaces.push({ id: sid, name: s.name, tabs, activeTab, nextPane: s.nextPane, nextTab: s.nextTab });
    }
    out.#nextSpace = o.nextSpace;
    out.active = out.spaces.some((s) => s.id === o.active) ? (o.active as string) : out.spaces[0]!.id;
    out.rail = o.rail !== false;
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
