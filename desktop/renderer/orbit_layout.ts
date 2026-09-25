// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/orbit_layout.ts - P-FLEET.L17: the PURE model behind the Fleet Orbit view (hub and
// spoke). The hub is the master session; every lane is a spoke arranged on an ellipse around it. This
// module owns the geometry (where each spoke sits, how many rings a big fleet needs), the one-line
// glance wording per lane state, and the spoke-switch menu model the takeover banner renders. DOM-free /
// IO-free so all three are unit-tested headless; fleet_orbit.ts owns the DOM, the SVG and the polling.

import type { LaneStatus } from "./bridge.ts";
import { promoteRefusal } from "./composer_target.ts";

/** One spoke's resting place, in stage coordinates relative to the hub (0,0 = stage center). `ring` is
 *  0-based from the innermost occupied ring; `angle` is degrees with -90 at 12 o'clock, clockwise. */
export interface OrbitSlot { x: number; y: number; ring: number; angle: number }

export interface OrbitOpts { nodeW?: number; nodeH?: number; pad?: number }

/** The card footprint the geometry reserves per spoke. fleet_orbit.ts sizes the real cards to match. */
export const ORBIT_NODE_W = 172;
export const ORBIT_NODE_H = 92;
const ORBIT_PAD = 26;

/** Ring radii as fractions of the full ellipse, by how many rings the fleet needs. Inner rings exist
 *  only when one ring cannot hold everyone at readable spacing, so a small fleet always gets the wide,
 *  dramatic circle and a big one nests instead of overlapping. */
const RING_FRACTIONS: readonly (readonly number[])[] = [[1], [0.55, 1], [0.4, 0.7, 1]];

/** How many spokes a ring can hold at a legible spacing: the node width plus a fifth of breathing room,
 *  measured against the ring's mean circumference. Never below 4 - three spokes on a giant ring is fine,
 *  but a capacity under 4 would push tiny fleets onto needless inner rings. */
function ringCapacity(rx: number, ry: number, frac: number, nodeW: number): number {
  const circumference = 2 * Math.PI * (((rx + ry) / 2) * frac);
  return Math.max(4, Math.floor(circumference / (nodeW * 1.2)));
}

/** Lay `count` spokes out around the hub inside a `w` x `h` stage. Deterministic: same inputs, same
 *  slots, in input order (fleet_orbit keys cards by lane id, so a lane keeps its seat between polls
 *  unless the census changes). Rings fill innermost-first with the leftovers on the outermost ring;
 *  past three full rings the outer ring simply tightens, which degrades spacing but never drops a lane. */
export function orbitSlots(count: number, w: number, h: number, opts?: OrbitOpts): OrbitSlot[] {
  if (count <= 0) return [];
  const nodeW = opts?.nodeW ?? ORBIT_NODE_W;
  const nodeH = opts?.nodeH ?? ORBIT_NODE_H;
  const pad = opts?.pad ?? ORBIT_PAD;
  // An ellipse, not a circle: a widescreen stage has far more x than y to give, and a circle sized to
  // the short axis wastes it. Floors keep a tiny window from folding the spokes onto the hub.
  const rx = Math.max(190, w / 2 - nodeW / 2 - pad);
  const ry = Math.max(150, h / 2 - nodeH / 2 - pad);
  // The smallest ring plan that seats everyone; the last plan is taken even when over capacity.
  let plan = RING_FRACTIONS[RING_FRACTIONS.length - 1]!;
  for (const fracs of RING_FRACTIONS) {
    const cap = fracs.reduce((sum, f) => sum + ringCapacity(rx, ry, f, nodeW), 0);
    if (count <= cap) { plan = fracs; break; }
  }
  // Seats per ring, proportional to each ring's capacity, corrected to sum exactly to `count` and to
  // never exceed a ring's capacity unless every ring is already full (the >3-ring overflow case).
  const caps = plan.map((f) => ringCapacity(rx, ry, f, nodeW));
  const total = caps.reduce((a, b) => a + b, 0);
  const seats = caps.map((c) => Math.floor((count * c) / total));
  let leftover = count - seats.reduce((a, b) => a + b, 0);
  for (let i = seats.length - 1; leftover > 0; i = (i - 1 + seats.length) % seats.length) {
    if (seats[i]! < caps[i]! || count > total) { seats[i]!++; leftover--; }
  }
  const slots: OrbitSlot[] = [];
  let placed = 0;
  for (let ring = 0; ring < plan.length && placed < count; ring++) {
    const n = Math.min(seats[ring]!, count - placed) || (ring === plan.length - 1 ? count - placed : 0);
    if (n <= 0) continue;
    const step = 360 / n;
    // Rings start at 12 o'clock; each deeper ring is staggered half a step so nested spokes interleave
    // instead of stacking into radial columns that read as overlap.
    const start = -90 + ring * (step / 2);
    for (let k = 0; k < n; k++) {
      const angle = start + k * step;
      const rad = (angle * Math.PI) / 180;
      slots.push({ x: rx * plan[ring]! * Math.cos(rad), y: ry * plan[ring]! * Math.sin(rad), ring, angle });
      placed++;
    }
  }
  return slots;
}

/** The glance line under a spoke's name: one short sentence answering "what is this lane doing and does
 *  it need me". Wording is load-bearing: the amber and red states name the USER's next move, because
 *  those are the two states that block on a human (the fleet grid's own animation rule). */
export function spokeGlance(l: { status: LaneStatus; turns: number; queued: readonly unknown[] }): string {
  const q = l.queued.length > 0 ? ` \u00b7 ${l.queued.length} queued` : "";
  switch (l.status) {
    case "starting": return "spinning up\u2026";
    case "working": return `working \u00b7 turn ${l.turns + 1}${q}`;
    case "needs-approval": return "needs your approval";
    case "awaiting-input": return `ready for your prompt${q}`;
    case "done": return `done \u00b7 ${l.turns} ${l.turns === 1 ? "turn" : "turns"}${q}`;
    case "error": return "crashed \u00b7 respawn to revive";
    case "stopped": return "stopped";
  }
}

/** P-FLEET.L17: motion vs Lite. The orbit is decorative physics on top of plain data; a machine that
 *  cannot composite it cheaply gets the SAME hub-and-spoke as a still page (Lite), not a broken slideshow.
 *  The SPEC, in precedence order:
 *    1. an explicit user override always wins ("motion" | "static", persisted by fleet_orbit);
 *    2. prefers-reduced-motion is an accessibility contract -> static;
 *    3. a software WebGL rasterizer (SwiftShader / llvmpipe / ANGLE software) means no GPU compositor
 *       is coming -> static;
 *    4. a reported device memory of 2GB or less -> static (backdrop blur alone hurts there);
 *    5. a MEASURED sustained frame rate under ORBIT_FPS_FLOOR while open -> static (the honest gate:
 *       measurement beats any heuristic, and fleet_orbit persists the verdict as an auto override).
 *  Everything else -> motion. */
export type OrbitMode = "motion" | "static";
export const ORBIT_FPS_FLOOR = 30;

export interface OrbitEnv {
  override: OrbitMode | null;
  reducedMotion: boolean;
  /** The WEBGL_debug_renderer_info UNMASKED_RENDERER_WEBGL string, "" when WebGL is unavailable
   *  (no WebGL at all is itself a software signal). */
  webglRenderer: string | null;
  /** navigator.deviceMemory in GB; undefined where unsupported (Firefox/Safari) - not a signal then. */
  deviceMemoryGB?: number;
  /** Mean fps over the guard window, when one has been measured this session. */
  measuredFps?: number;
}

const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render/i;

export function orbitMode(env: OrbitEnv): OrbitMode {
  if (env.override) return env.override;
  if (env.reducedMotion) return "static";
  if (env.webglRenderer === null || SOFTWARE_GL.test(env.webglRenderer)) return "static";
  if (env.deviceMemoryGB !== undefined && env.deviceMemoryGB <= 2) return "static";
  if (env.measuredFps !== undefined && env.measuredFps < ORBIT_FPS_FLOOR) return "static";
  return "motion";
}

/** One row of the spoke-switch menu (the takeover banner's dropdown and the orbit header share it). */
export type SwitchEntry =
  | { kind: "master"; label: string; current: boolean }
  | { kind: "orbit"; label: string }
  | { kind: "lane"; laneId: string; label: string; status: LaneStatus; current: boolean };

/** Build the switch menu: Main first (home is always one click), the whole-fleet view second, then every
 *  spoke by the name the user gave it, in fleet order. `currentLaneId` null = the master is current. */
export function switchEntries(
  lanes: readonly { id: string; name: string; status: LaneStatus }[],
  currentLaneId: string | null,
): SwitchEntry[] {
  const rows: SwitchEntry[] = [
    { kind: "master", label: "Main \u00b7 master session", current: currentLaneId === null },
    { kind: "orbit", label: "Entire fleet \u00b7 orbit view" },
  ];
  for (const l of lanes) rows.push({ kind: "lane", laneId: l.id, label: l.name, status: l.status, current: l.id === currentLaneId });
  return rows;
}

/** P-FLEET.L17: a HISTORICAL spoke - a lane the durable ledger remembers (P-FLEET.L5 timeline) that is
 *  not running right now. Always recoverable; nothing expires on its own and no mark deletes anything. */
export interface GhostSpoke {
  /** Logical identity: the user-given name + folder. Survives engine restarts, which mint new lane ids. */
  key: string;
  name: string; cwd: string; model: string; turns: number;
  /** Latest activity across every recorded run of this logical spoke. */
  lastAt: number;
}

/** A user-chosen mark on a logical spoke (a hide or an archive tuck-away). Both are reversible view
 *  state: neither touches the ledger or the Timeline. `at` matters: a mark placed TODAY must not
 *  suppress the ghost a brand-new run earns TOMORROW, so a mark only covers activity at or before its
 *  own time - a fresh run always resurfaces the spoke. */
export interface GhostMark { key: string; at: number }

export const ghostKey = (name: string, cwd: string): string => `${name}\u0000${cwd}`;

export interface GhostLists { active: GhostSpoke[]; archived: GhostSpoke[]; hidden: GhostSpoke[] }

/** Collapse the ledger into recoverable spokes: lane entries only, deduped to the LATEST run per
 *  logical spoke, minus everything alive in the fleet right now. Three fates, by the user's marks:
 *  HIDDEN (hide mark covers the latest run) leaves the recover list for the hidden list, where an
 *  unhide brings it back; ARCHIVED (archive mark covers it) is tucked into the archived list, still
 *  recoverable; everything else is active. Hide beats archive. Newest first in every list. */
export function ghostSpokes(
  entries: readonly { kind: string; laneId?: string; laneName?: string; cwd: string; model: string; turns: number; updatedAt: number }[],
  live: readonly { name: string; cwd: string }[],
  hides: readonly GhostMark[],
  archives: readonly GhostMark[] = [],
): GhostLists {
  const latestMark = (marks: readonly GhostMark[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const t of marks) m.set(t.key, Math.max(t.at, m.get(t.key) ?? 0));
    return m;
  };
  const stowed = latestMark(hides);
  const tucked = latestMark(archives);
  const alive = new Set(live.map((l) => ghostKey(l.name, l.cwd)));
  const best = new Map<string, GhostSpoke>();
  for (const e of entries) {
    if (e.kind !== "lane" || !e.laneName || !e.cwd) continue;
    const key = ghostKey(e.laneName, e.cwd);
    if (alive.has(key)) continue;
    const prior = best.get(key);
    if (!prior || e.updatedAt > prior.lastAt) {
      best.set(key, { key, name: e.laneName, cwd: e.cwd, model: e.model, turns: e.turns, lastAt: e.updatedAt });
    }
  }
  const active: GhostSpoke[] = [], archived: GhostSpoke[] = [], hidden: GhostSpoke[] = [];
  for (const g of best.values()) {
    const hid = stowed.get(g.key);
    const arch = tucked.get(g.key);
    (hid !== undefined && g.lastAt <= hid ? hidden : arch !== undefined && g.lastAt <= arch ? archived : active).push(g);
  }
  const newestFirst = (a: GhostSpoke, b: GhostSpoke): number => b.lastAt - a.lastAt;
  return { active: active.sort(newestFirst), archived: archived.sort(newestFirst), hidden: hidden.sort(newestFirst) };
}

/** P-FLEET.L17: read EVERY page of a paged listing. The timeline caps a page at 500 rows, and a spoke
 *  whose latest run sits past the first page must still be recoverable. Stops once `total` is covered
 *  or on a short page (a ledger that shrank mid-read). Any failed page fails the whole read (null): a
 *  partial ledger would silently drop ghosts, so the caller keeps what it had instead. IO is injected. */
export async function readAllPages<T>(
  fetchPage: (limit: number, offset: number) => Promise<{ entries: T[]; total: number } | null>,
  pageSize = 500,
): Promise<T[] | null> {
  const out: T[] = [];
  for (;;) {
    const page = await fetchPage(pageSize, out.length);
    if (!page) return null;
    out.push(...page.entries);
    if (page.entries.length < pageSize || out.length >= page.total) return out;
  }
}

/** P-FLEET.L17: the Ctrl/Cmd+Alt+Arrow cycle order. Walks the fleet in fleet order, skipping lanes the
 *  attach would REFUSE anyway (composer_target.promoteRefusal is the single authority - a hotkey that
 *  lands on a refusal toast is a dead end, not a shortcut). From the master (currentLaneId null) the
 *  cycle enters at the first promotable spoke going right, the last going left. Wraps. Returns null
 *  when nothing is promotable. */
export function cycleSpoke(
  lanes: readonly { id: string; status: LaneStatus }[],
  currentLaneId: string | null,
  dir: 1 | -1,
): string | null {
  const ids = lanes.filter((l) => promoteRefusal(l.status) === null).map((l) => l.id);
  if (ids.length === 0) return null;
  const at = currentLaneId === null ? -1 : ids.indexOf(currentLaneId);
  if (at === -1) return dir === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[(at + dir + ids.length) % ids.length]!;
}
