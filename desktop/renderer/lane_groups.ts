// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/lane_groups.ts - P-FLEET.L18: named lane GROUPS on the fleet grid. The pure model:
// which groups exist, which lane belongs where, which groups are collapsed, and how the grid's flat
// card order folds into sections. DOM-free / IO-free; fleet_grid.ts owns the chips, the dividers and
// the localStorage round-trip. Groups partition the PRESENTATION only - the manager, the orbit and
// layout.order know nothing about them, so a group can never change what a lane does.

export interface LaneGroups {
  /** Creation order - also the render order of the sections. */
  groups: string[];
  /** laneId -> group name. A lane not in the map is ungrouped. */
  byLane: Record<string, string>;
  /** Collapsed group names (presence = collapsed). */
  collapsed: Record<string, true>;
}

export const EMPTY_GROUPS: LaneGroups = { groups: [], byLane: {}, collapsed: {} };
const NAME_CAP = 40;

/** Parse a persisted payload; anything malformed degrades to no groups (the grid still works). */
export function loadGroups(raw: string | null): LaneGroups {
  if (!raw) return structuredClone(EMPTY_GROUPS);
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return structuredClone(EMPTY_GROUPS);
    const out = structuredClone(EMPTY_GROUPS);
    if ("groups" in v && Array.isArray(v.groups)) {
      for (const g of v.groups) if (typeof g === "string" && g && !out.groups.includes(g)) out.groups.push(g.slice(0, NAME_CAP));
    }
    if ("byLane" in v && v.byLane && typeof v.byLane === "object") {
      for (const [id, g] of Object.entries(v.byLane)) if (typeof g === "string" && out.groups.includes(g)) out.byLane[id] = g;
    }
    if ("collapsed" in v && v.collapsed && typeof v.collapsed === "object") {
      for (const g of Object.keys(v.collapsed)) if (out.groups.includes(g)) out.collapsed[g] = true;
    }
    return out;
  } catch { return structuredClone(EMPTY_GROUPS); }
}

export function saveGroups(g: LaneGroups): string {
  return JSON.stringify(g);
}

/** Create (or return) a group by name: trimmed, capped, deduped exactly. "" creates nothing. */
export function createGroup(g: LaneGroups, name: string): { next: LaneGroups; name: string | null } {
  const n = name.replace(/\s+/g, " ").trim().slice(0, NAME_CAP);
  if (!n) return { next: g, name: null };
  if (g.groups.includes(n)) return { next: g, name: n };
  return { next: { ...g, groups: [...g.groups, n] }, name: n };
}

/** Assign a lane to a group (must exist), or remove it from any group with null. */
export function assignLane(g: LaneGroups, laneId: string, group: string | null): LaneGroups {
  const byLane = { ...g.byLane };
  if (group === null) delete byLane[laneId];
  else if (g.groups.includes(group)) byLane[laneId] = group;
  else return g;
  return { ...g, byLane };
}

/** Whether a lane's card is folded away: it sits in an EXISTING group the user collapsed (a dangling
 *  assignment renders in the ungrouped tail, so it never hides). The grid derives the card's hidden
 *  state from this on every repaint, so a status poll can never unfold a collapsed group. */
export function laneCollapsed(g: LaneGroups, laneId: string): boolean {
  const name = g.byLane[laneId];
  return name !== undefined && g.collapsed[name] === true && g.groups.includes(name);
}

export function toggleCollapsed(g: LaneGroups, group: string): LaneGroups {
  const collapsed = { ...g.collapsed };
  if (collapsed[group]) delete collapsed[group]; else if (g.groups.includes(group)) collapsed[group] = true;
  return { ...g, collapsed };
}

/** Disband a group: the group and its collapse state go; its lanes become ungrouped. Their cards and
 *  their work are untouched - a group is presentation, never lifecycle. */
export function removeGroup(g: LaneGroups, group: string): LaneGroups {
  const byLane: Record<string, string> = {};
  for (const [id, name] of Object.entries(g.byLane)) if (name !== group) byLane[id] = name;
  const collapsed = { ...g.collapsed };
  delete collapsed[group];
  return { groups: g.groups.filter((n) => n !== group), byLane, collapsed };
}

/** Drop assignments for lanes that no longer exist. Groups themselves survive empty - the user just
 *  made one to file the NEXT lane into; a poll must not eat it. */
export function pruneLanes(g: LaneGroups, liveIds: readonly string[]): LaneGroups {
  const live = new Set(liveIds);
  const byLane: Record<string, string> = {};
  for (const [id, name] of Object.entries(g.byLane)) if (live.has(id)) byLane[id] = name;
  return { ...g, byLane };
}

export interface GroupSection { group: string | null; ids: string[] }

/** Fold the grid's flat order into sections: each named group (creation order) with its members in
 *  flat-order, then the ungrouped tail under `group: null`. Groups without members emit no section;
 *  relative order WITHIN a section is exactly layout.order, so drag-to-reorder semantics survive. */
export function groupSections(order: readonly string[], g: LaneGroups): GroupSection[] {
  const out: GroupSection[] = [];
  for (const name of g.groups) {
    const ids = order.filter((id) => g.byLane[id] === name);
    if (ids.length > 0) out.push({ group: name, ids });
  }
  const loose = order.filter((id) => !(id in g.byLane) || !g.groups.includes(g.byLane[id]!));
  if (loose.length > 0) out.push({ group: null, ids: loose });
  return out;
}
