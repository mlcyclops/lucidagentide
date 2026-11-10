// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0497 as the add-on, ADR-0535): what the read-only GUI mirror shows of instance `main`.
// PURE: no I/O, no DOM. gui_server.ts reads the instance's layout file and its `agent list` and hands
// both here; the page (gui_page.ts) only draws the result.
//
// The mirror is metadata only (ADR-0489 default c): tabs, the split tree with its ratios, and per
// agent pane the lane's name, status and attention. Never a lane id, a cwd, a model, a prompt or
// reply text, whatever the inputs carry. The tree has the ADR-0491 layout file shape (a split is the
// node with `dir`, "v" side by side, "h" stacked, `ratio` the share of `a`), so the arrangement a
// layout file names is the arrangement the page draws.
//
// Both inputs are untrusted: the layout file goes through the hub's own validator (Spaces.restore,
// with a deck pattern instead of the hub's deck list, which lives in Bun-only code), names are
// stripped of control and bidi characters and capped, a status outside the known set reads
// "unknown", and a tab over the layout leaf cap is listed without a tree.

import { LANE_STATUS_ORDER } from "../../../desktop/collab/fleet_status.ts";
import { leaves, Spaces, type PaneNode, type Space, type Tab } from "../../../harness/launcher/hub_spaces.ts";
import { LAYOUT_LEAF_CAP, type LayoutSplit } from "./layouts.ts";

/** ADR-0494: what a lane wants from the user, as the Herd server reports it beside `status`. */
export type MirrorAttention = "needs-you" | "unseen" | "none";
const ATTENTION: Readonly<Record<string, MirrorAttention>> = { "needs-you": "needs-you", unseen: "unseen", none: "none" };

/** The lane statuses the mirror shows verbatim; `gone` (the lane left the engine) and `unknown` (the
 *  hub could not list lanes, or sent an unknown status) are the mirror's own. */
export const MIRROR_STATUSES: readonly string[] = [...LANE_STATUS_ORDER, "gone", "unknown"];

/** A deck id as the mirror accepts it from a layout file: the hub's lowercase ids (and Herd's own,
 *  such as "main"); anything else makes the file off-shape. */
export const MIRROR_DECK_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** The longest name the mirror shows (ADR-0491 NAME_RE length). */
export const MIRROR_NAME_MAX = 40;

export interface MirrorAgent { name: string; status: string; attention: MirrorAttention }
export interface MirrorPane { id: string; deck: string; focused: boolean; agent?: MirrorAgent }
export interface MirrorSplit extends Omit<LayoutSplit, "a" | "b"> { a: MirrorNode; b: MirrorNode }
export type MirrorNode = MirrorSplit | MirrorPane;

export interface MirrorTab {
  id: string;
  name: string;
  /** The space's active tab. */
  active: boolean;
  zoom: boolean;
  panes: number;
  /** Null when the tab has more panes than LAYOUT_LEAF_CAP: listed, not drawn. */
  tree: MirrorNode | null;
  needsYou: number;
  unseen: number;
}
export interface MirrorSpace { id: string; name: string; active: boolean; tabs: MirrorTab[] }
export interface MirrorCounts { agents: number; needsYou: number; unseen: number }

export interface MirrorState {
  v: 1;
  instance: string;
  /** Instance answered its handshake. False: nothing else is filled. */
  up: boolean;
  /** The tab on screen in the hub (the active space's active tab), or null. */
  focusedTab: string | null;
  spaces: MirrorSpace[];
  counts: MirrorCounts;
}

export interface MirrorInput {
  instance: string;
  up: boolean;
  /** The validated layout (parseMirrorSpaces), or null when there is none or it is off-shape. */
  layout: { readonly active: string; readonly spaces: readonly Space[] } | null;
  /** `agent list` from the instance, or null when the hub could not list lanes. */
  lanes: readonly unknown[] | null;
}

// C0 and C1 controls, zero-width marks and bidi embeddings, overrides and isolates.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** A display name: unsafe characters removed, whitespace trimmed, at most `max` code points. */
export function cleanName(raw: unknown, max: number = MIRROR_NAME_MAX): string {
  if (typeof raw !== "string") return "";
  return Array.from(raw.replace(UNSAFE_TEXT_RE, "").trim()).slice(0, max).join("");
}

/** The instance's layout file through the hub's own validator, or null when it is off-shape. */
export function parseMirrorSpaces(raw: string): Spaces | null {
  return Spaces.restore(raw, (deck) => MIRROR_DECK_RE.test(deck));
}

interface LaneFacts { name: string; status: string; attention: MirrorAttention }

/** ADR-0494 fallback for a lane without the server's `attention` field: only an open approval is an
 *  ask (an engine lane at rest sits in awaiting-input, so that is not one). */
function laneAttention(x: Record<string, unknown>, status: string): MirrorAttention {
  const given = typeof x.attention === "string" && Object.hasOwn(ATTENTION, x.attention) ? ATTENTION[x.attention] : undefined;
  return given ?? (status === "needs-approval" ? "needs-you" : "none");
}

function laneFacts(lanes: readonly unknown[]): { byId: Map<string, LaneFacts>; byName: Map<string, LaneFacts> } {
  const byId = new Map<string, LaneFacts>();
  const byName = new Map<string, LaneFacts>();
  for (const raw of lanes) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const x: Record<string, unknown> = { ...raw };
    if (typeof x.id !== "string" || !x.id || byId.has(x.id)) continue;
    const status = typeof x.status === "string" && LANE_STATUS_ORDER.includes(x.status) ? x.status : "unknown";
    const facts: LaneFacts = { name: cleanName(x.name), status, attention: laneAttention(x, status) };
    byId.set(x.id, facts);
    if (facts.name && !byName.has(facts.name)) byName.set(facts.name, facts);
  }
  return { byId, byName };
}

/** The mirror's view of one instance. Pure; the inputs are not mutated. */
export function projectMirror(input: MirrorInput): MirrorState {
  const counts: MirrorCounts = { agents: 0, needsYou: 0, unseen: 0 };
  const base: MirrorState = { v: 1, instance: cleanName(input.instance, 32), up: input.up, focusedTab: null, spaces: [], counts };
  if (!input.up) return base;
  const lanes = input.lanes === null ? null : laneFacts(input.lanes);
  if (lanes) {
    for (const l of lanes.byId.values()) {
      counts.agents++;
      if (l.attention === "needs-you") counts.needsYou++;
      else if (l.attention === "unseen") counts.unseen++;
    }
  }
  const layout = input.layout;
  if (!layout) return base;

  const agentOf = (lane: string | undefined, laneName: string | undefined): MirrorAgent => {
    const facts = lane === undefined || lanes === null ? undefined : lanes.byId.get(lane) ?? (laneName ? lanes.byName.get(cleanName(laneName)) : undefined);
    const name = facts?.name || cleanName(laneName) || "agent";
    if (lanes === null) return { name, status: "unknown", attention: "none" };
    return facts ? { name, status: facts.status, attention: facts.attention } : { name, status: "gone", attention: "none" };
  };

  const projectTab = (space: Space, t: Tab): MirrorTab => {
    const panes = leaves(t.tree).length;
    let index = 0, needsYou = 0, unseen = 0;
    const node = (n: PaneNode): MirrorNode => {
      if (n.kind === "split") return { dir: n.dir, ratio: n.ratio ?? 0.5, a: node(n.a), b: node(n.b) };
      const focused = index++ === t.focus;
      if (n.deck !== "agent") return { id: n.id, deck: n.deck, focused };
      const agent = agentOf(n.lane, n.laneName);
      if (agent.attention === "needs-you") needsYou++;
      else if (agent.attention === "unseen") unseen++;
      return { id: n.id, deck: "agent", focused, agent };
    };
    const tree = panes > LAYOUT_LEAF_CAP ? null : node(t.tree);
    return { id: t.id, name: cleanName(t.name), active: space.activeTab === t.id, zoom: t.zoom, panes, tree, needsYou, unseen };
  };

  const spaces = layout.spaces.map((s): MirrorSpace => ({
    id: s.id, name: cleanName(s.name), active: s.id === layout.active, tabs: s.tabs.map((t) => projectTab(s, t)),
  }));
  const focused = spaces.find((s) => s.active);
  return { ...base, spaces, focusedTab: focused?.tabs.find((t) => t.active)?.id ?? null };
}
