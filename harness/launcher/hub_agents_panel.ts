// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.5 E2 (ADR-0434) - the rail's AGENTS panel: every fleet lane as one visible, clickable row,
// ordered by a user-set PRIORITY. herdr's agents panel, in LUCID's own chrome.
//
// A row is: a status glyph (colored by the LaneStatus vocabulary), the lane name, where its live
// pane lives (space:tab, when one hosts it), the model short-name, elapsed since spawn, and a
// priority badge. Sort: priority DESCENDING, then status (blocked-on-a-human first among equals),
// then name. PRIORITY IS DISPLAY ORDER, NOT SCHEDULING: it never touches the engine, a lane's turn,
// or the gate; it only decides which row sits higher in the rail.
//
// Pure row-building and line-painting functions live up top (unit-tested, no I/O); the priority
// store (hub-agent-priorities.json beside hub-spaces.json, keyed by LANE NAME so a priority
// survives a lane restart under a new id) and the stateful panel bound into hub_tui's
// RailAgentsPanel seam live below. The panel NEVER answers approval prompts: attach and cancel ride
// the existing audited routes only.

import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HubOpError, leaves, type Space } from "./hub_spaces.ts";
import { fmtElapsed } from "./hub_tui.ts";

/** The seam's row shape (hub_tui.RailAgentsPanel.rows()): what the rail is promised. */
export interface AgentsPanelRow {
  id: string;
  name: string;
  /** "space:tab" hosting the lane's live agent pane; "" when none does. */
  location: string;
  /** The LaneStatus vocabulary verbatim (fleet_status.ts); unknown values render as-is, ranked last. */
  status: string;
  /** 1-9 user-set display order; 0 = unset. */
  priority: number;
}

/** The full row the panel builds: the seam shape plus the display-only cells. */
export interface AgentRow extends AgentsPanelRow {
  model: string;
  elapsed: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ---- status: glyph, hue, sort rank ---------------------------------------------------------------

/** How a status paints: the hub maps hues onto the styles.css palette. */
export type GlyphHue = "attention" | "busy" | "ok" | "error" | "off" | "unknown";

/** Glyph + hue per LaneStatus. "Blocked" = the engine's attention states (needs-approval,
 *  awaiting-input): the lane is waiting on a HUMAN. An unknown status is shown, never dropped. */
export function statusGlyph(status: string): { glyph: string; hue: GlyphHue } {
  switch (status) {
    case "needs-approval":
    case "awaiting-input": return { glyph: "◉", hue: "attention" };
    case "working": return { glyph: "●", hue: "busy" };
    case "starting": return { glyph: "◐", hue: "busy" };
    case "done": return { glyph: "○", hue: "ok" };
    case "error": return { glyph: "✗", hue: "error" };
    case "stopped": return { glyph: "■", hue: "off" };
    default: return { glyph: "?", hue: "unknown" };
  }
}

const STATUS_RANK = ["needs-approval", "awaiting-input", "working", "starting", "done", "error", "stopped"];

/** Sort rank among equals: blocked-on-a-human first, then busy, settled, dead; unknown last. */
export function statusRank(status: string): number {
  const i = STATUS_RANK.indexOf(status);
  return i === -1 ? STATUS_RANK.length : i;
}

// ---- row building (pure) -------------------------------------------------------------------------

/** "anthropic/claude-sonnet-4-20250514" -> "claude-sonnet-4": the last path segment, a trailing
 *  -YYYYMMDD date pin and a :tag dropped. Unknown shapes pass through untouched. */
export function modelShort(model: string): string {
  const tail = model.split("/").pop() ?? model;
  return tail.replace(/-\d{8}$/, "").replace(/:[^:]+$/, "");
}

/** laneId -> "space:tab" for every lane with a live agent pane; the first host (rail order) wins. */
export function laneLocations(spaces: readonly Pick<Space, "name" | "tabs">[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of spaces)
    for (const t of s.tabs)
      for (const leaf of leaves(t.tree))
        if (leaf.deck === "agent" && leaf.lane && !(leaf.lane in out)) out[leaf.lane] = `${s.name}:${t.name}`;
  return out;
}

/** The panel's rows from the same /api/fleet/status lanes the decks render: priority DESCENDING,
 *  then status (blocked first among equals - it needs the human), then name. Pure. */
export function buildAgentRows(
  lanes: readonly Record<string, unknown>[],
  locations: Readonly<Record<string, string>>,
  priorities: Readonly<Record<string, number>>,
  now = Date.now(),
): AgentRow[] {
  const rows = lanes.map(rec).map((l) => {
    const id = str(l.id);
    const name = str(l.name) || id;
    const p = priorities[name];
    return {
      id,
      name,
      location: locations[id] ?? "",
      status: str(l.status) || "?",
      priority: typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 9 ? p : 0,
      model: modelShort(str(l.model)),
      elapsed: fmtElapsed(Number(l.createdAt), now),
    };
  });
  return rows.sort((a, b) =>
    b.priority - a.priority || statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name));
}

// ---- line painting (pure) ------------------------------------------------------------------------

/** Painters for an agent rail line. Identity = plain text (tests); the hub passes colors. */
export interface AgentPaint {
  glyph(s: string, row: AgentsPanelRow): string;
  name(s: string, row: AgentsPanelRow): string;
  meta(s: string, row: AgentsPanelRow): string;
  badge(s: string, row: AgentsPanelRow): string;
}
const PLAIN = (s: string): string => s;
export const PLAIN_AGENT_PAINT: AgentPaint = { glyph: PLAIN, name: PLAIN, meta: PLAIN, badge: PLAIN };

/** One agent rail line, exactly `w` cells: glyph + name on the left (the name ellipsizes, NEVER
 *  mid-word wraps: invariant 11), then location·model as a dim meta cell (dropped before the name
 *  shrinks below readability), elapsed and the p<n> badge on the right. */
export function agentRailLine(row: AgentRow | (AgentsPanelRow & Partial<AgentRow>), w: number, paint: AgentPaint = PLAIN_AGENT_PAINT): string {
  const g = statusGlyph(row.status);
  const mark = `  ${g.glyph} `;
  const badge = row.priority >= 1 ? ` p${row.priority}` : "";
  const right = `${row.elapsed ?? ""}${badge} `;
  const room = Math.max(1, w - Bun.stringWidth(mark) - Bun.stringWidth(right) - 1);
  const name = truncateToWidth(row.name, Math.max(1, Math.min(room, 12)));
  const metaRoom = room - Bun.stringWidth(name) - 1;
  const metaRaw = [row.location, row.model ?? ""].filter(Boolean).join("·");
  const meta = metaRoom >= 3 && metaRaw ? truncateToWidth(metaRaw, metaRoom) : "";
  const pad = Math.max(1, w - Bun.stringWidth(mark) - Bun.stringWidth(name) - Bun.stringWidth(meta) - Bun.stringWidth(right));
  const padLeft = meta ? 1 : 0;
  return paint.glyph(mark, row) + paint.name(name, row)
    + " ".repeat(padLeft) + paint.meta(meta, row) + " ".repeat(pad - padLeft) + paint.badge(right, row);
}

// ---- the priority store --------------------------------------------------------------------------
// Its own file beside hub-spaces.json: the Spaces store (hub_spaces.ts) validates strictly and
// serializes a FIXED shape, so a foreign key riding hub-spaces.json would be dropped on the next
// save. Keyed by lane NAME (operator direction): a priority survives the lane's id changing.

export function agentPrioritiesPath(dir: string): string {
  return join(dir, "hub-agent-priorities.json");
}

/** 1-9 or a refusal that names the contract. Display order only - never scheduling. */
export function normalizePriority(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 9) {
    throw new HubOpError("usage", "priority is an integer 1-9 (display order in the hub's agents panel, not scheduling)");
  }
  return n;
}

/** Load the store; a missing or off-shape file is {} (display order is convenience, never fatal).
 *  Only integer 1-9 values survive the read - a hand-edited 0 or "high" never renders. */
export function loadPriorities(path: string): Record<string, number> {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return {}; }
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return {}; }
  const top = rec(o);
  if (top.v !== 1) return {};
  const out: Record<string, number> = {};
  for (const [name, v] of Object.entries(rec(top.priorities)))
    if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 9) out[name] = v;
  return out;
}

/** tmp + rename, 0600, like hub-spaces.json: a crash mid-write leaves the previous store. */
export function savePriorities(path: string, priorities: Readonly<Record<string, number>>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ v: 1, priorities }) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

// ---- the panel -----------------------------------------------------------------------------------

/** What the panel needs from the hub. attach/cancel are the EXISTING audited mechanisms (the
 *  ADR-0420 live-agent-pane bind; /api/fleet/cancel); the panel itself never talks to the engine
 *  and never answers an approval prompt. */
export interface AgentsPanelHost {
  lanes(): Record<string, unknown>[];
  locations(): Record<string, string>;
  attach(id: string, name: string): void;
  cancel(id: string, name: string): void;
  /** The priority store file (agentPrioritiesPath). */
  path: string;
}

/** The RailAgentsPanel seam, implemented. Click once = select; click the selected row (or Enter on
 *  it) = attach into the focused pane. Priorities round-trip the store on every set. */
export class HubAgentsPanel {
  readonly #host: AgentsPanelHost;
  #priorities: Record<string, number>;
  /** The click-selected lane id (first click selects, the second attaches); null = none. */
  selected: string | null = null;

  constructor(host: AgentsPanelHost) {
    this.#host = host;
    this.#priorities = loadPriorities(host.path);
  }

  rows(): AgentRow[] {
    return buildAgentRows(this.#host.lanes(), this.#host.locations(), this.#priorities);
  }

  #row(id: string): AgentRow | undefined {
    return this.rows().find((r) => r.id === id);
  }

  /** First click selects the row; a click on the already-selected row attaches it. */
  onClick(id: string): void {
    const row = this.#row(id);
    if (!row) return;
    if (this.selected === id) this.#host.attach(id, row.name);
    else this.selected = id;
  }

  /** Enter on a row: attach outright (the row is already under the keyboard). */
  attach(id: string): void {
    const row = this.#row(id);
    if (row) this.#host.attach(id, row.name);
  }

  /** c on a row: cancel the lane's RUNNING turn via the existing route. Never an approval answer. */
  cancel(id: string): void {
    const row = this.#row(id);
    if (row) this.#host.cancel(id, row.name);
  }

  onPriority(id: string, n: number): void {
    const row = this.#row(id);
    if (row) this.setPriorityByName(row.name, n);
  }

  /** The CLI verb lands here (agent priority <name|id> <1-9>). Throws HubOpError on a bad n. */
  setPriorityByName(name: string, n: number): number {
    const v = normalizePriority(n);
    this.#priorities[name] = v;
    savePriorities(this.#host.path, this.#priorities);
    return v;
  }

  priorityOf(name: string): number {
    return this.#priorities[name] ?? 0;
  }
}
