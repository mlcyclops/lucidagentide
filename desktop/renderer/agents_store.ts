// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/agents_store.ts - P-RAIL.AGENTS1: the pure model behind the rail's Agents view.
//
// An Agent is a folder. The list is the folders LUCID already knows you work in (Main's folder, the recent
// workspaces, every live fleet lane's main checkout) PLUS the ones you added with "+ Add agent" or kept by
// renaming, recoloring or dragging them (that marks an Agent `saved`, so it survives leaving the recents).
// `doc.agents` IS the display order: a folder seen for the first time enters at the top; until the user drags
// one, Main moving to a folder also lifts that Agent to the top; once the user has ordered the list by hand
// (`manual`), existing Agents stay where they were put. Removing one hides it (by id) until the user adds it
// again, so an auto Agent does not walk back in from the recents.
//
// No DOM, no storage: the rail module (agents_rail.ts) owns localStorage and calls these. Ids are the
// normalized folder path, the same comparison renderWorkspaceBar's same() makes (separators folded, trailing
// slash dropped, case-insensitive), so an id never changes for the same folder.

import { mainCheckoutCwd } from "./queue_model.ts";

export const AGENTS_KEY = "lucid.agents.v1";
export const VIEW_KEY = "lucid.rail.view";
export type RailView = "metrics" | "agents";

export type ThemeKey = "lucid" | "ember" | "glacier" | "orchid" | "solar" | "stealth";
export const THEME_KEYS: readonly ThemeKey[] = ["lucid", "ember", "glacier", "orchid", "solar", "stealth"];
export const NAME_MAX = 48;

export interface AgentRecord {
  /** normFolder(path): stable for the folder's life. */
  id: string;
  /** The folder as LUCID first saw it (original case and separators), shown in the module and passed to Activate. */
  path: string;
  /** The user's name; null = the auto name (basename, de-duplicated). */
  name: string | null;
  /** A mascot palette, or null for a custom hue (`hue`). */
  theme: ThemeKey | null;
  hue: number;
  /** Added, renamed, recolored or dragged: stays on the rail when it leaves the recents. */
  saved: boolean;
}

export interface AgentsDoc {
  v: 1;
  agents: AgentRecord[];
  /** Removed folder ids: never re-added automatically. */
  hidden: string[];
  /** The user has dragged the list into an order of their own. */
  manual: boolean;
  /** Main's folder id at the last merge, so a switch can lift the new folder (until `manual`). */
  main: string | null;
}

export interface Sources {
  main: string | null;
  recent: readonly { path: string }[];
  /** Live lanes' folders (any form; mapped to their main checkout here). */
  lanes: readonly string[];
}

export interface LaneLike { id: string; cwd: string; status: string; turns: number }

export function normFolder(p: string): string {
  const s = String(p ?? "").trim().replace(/[\\/]+/g, "/");
  return (s.length > 1 ? s.replace(/\/$/, "") : s).toLowerCase();
}

/** The folder's short name: its last path segment (a drive root keeps its letter). */
export function baseName(path: string): string {
  const parts = String(path ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : String(path ?? "");
}

/** A stable palette per folder so a fresh list is varied but never reshuffles. */
export function defaultTheme(id: string): ThemeKey {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return THEME_KEYS[(h >>> 0) % THEME_KEYS.length]!;
}

export function emptyDoc(): AgentsDoc { return { v: 1, agents: [], hidden: [], manual: false, main: null }; }

function autoRecord(path: string): AgentRecord {
  const id = normFolder(path);
  return { id, path, name: null, theme: defaultTheme(id), hue: 145, saved: false };
}

const clampHue = (h: unknown): number => {
  const n = Math.round(Number(h));
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : 145;
};

/** Parse the stored doc; anything malformed falls back to an empty doc (never throws). */
export function loadDoc(raw: string | null | undefined): AgentsDoc {
  if (!raw) return emptyDoc();
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return emptyDoc(); }
  if (!j || typeof j !== "object" || !("v" in j) || j.v !== 1) return emptyDoc();
  const o = j as Partial<AgentsDoc>; // persisted blob: every field below is re-checked at runtime before use
  const seen = new Set<string>();
  const agents: AgentRecord[] = [];
  for (const a of Array.isArray(o.agents) ? o.agents : []) {
    if (!a || typeof a !== "object" || typeof a.path !== "string" || !a.path.trim()) continue;
    const id = normFolder(a.path);
    if (seen.has(id)) continue;
    seen.add(id);
    const name = typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, NAME_MAX) : null;
    const theme = THEME_KEYS.includes(a.theme as ThemeKey) ? (a.theme as ThemeKey) : null;
    agents.push({ id, path: a.path, name, theme, hue: clampHue(a.hue), saved: !!a.saved });
  }
  const hidden = [...new Set((Array.isArray(o.hidden) ? o.hidden : []).filter((h): h is string => typeof h === "string").map(normFolder))];
  return { v: 1, agents, hidden, manual: !!o.manual, main: typeof o.main === "string" ? o.main : null };
}

export function saveDoc(doc: AgentsDoc): string { return JSON.stringify(doc); }

/** Every source folder once, in recency order: Main's folder, the recents in their order, then lane folders. */
export function sourceFolders(s: Sources): { id: string; path: string }[] {
  const out: { id: string; path: string }[] = [];
  const seen = new Set<string>();
  const push = (p: string | null | undefined): void => {
    if (!p || !p.trim()) return;
    const id = normFolder(p);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, path: p });
  };
  push(s.main);
  for (const r of s.recent) push(r?.path);
  for (const l of s.lanes) push(mainCheckoutCwd(l));
  return out;
}

/** Fold the current sources into the doc: new folders enter at the top (in recency order), auto Agents that
 *  left every source drop out, saved ones stay, hidden ones never come back. */
export function mergeSources(doc: AgentsDoc, s: Sources): AgentsDoc {
  const hidden = new Set(doc.hidden);
  const folders = sourceFolders(s).filter((f) => !hidden.has(f.id));
  const present = new Set(folders.map((f) => f.id));
  const keep = doc.agents.filter((a) => a.saved || present.has(a.id));
  const known = new Set(keep.map((a) => a.id));
  const fresh = folders.filter((f) => !known.has(f.id)).map((f) => autoRecord(f.path));
  let agents = [...fresh, ...keep];
  const mainId = s.main ? normFolder(s.main) : null;
  if (!doc.manual && mainId && doc.main !== null && mainId !== doc.main) {
    const i = agents.findIndex((a) => a.id === mainId);
    if (i > 0) agents = [agents[i]!, ...agents.slice(0, i), ...agents.slice(i + 1)];
  }
  return { ...doc, agents, main: mainId ?? doc.main };
}

/** "+ Add agent": a saved Agent at the top; re-adding a removed folder un-hides it. */
export function addAgent(doc: AgentsDoc, path: string): AgentsDoc {
  const id = normFolder(path);
  if (!id) return doc;
  const hidden = doc.hidden.filter((h) => h !== id);
  const cur = doc.agents.find((a) => a.id === id);
  const rec: AgentRecord = cur ? { ...cur, saved: true } : { ...autoRecord(path), saved: true };
  return { ...doc, hidden, agents: [rec, ...doc.agents.filter((a) => a.id !== id)] };
}

export interface RemovedAgent { record: AgentRecord; index: number; wasHidden: boolean }

export function removeAgent(doc: AgentsDoc, id: string): { doc: AgentsDoc; removed: RemovedAgent | null } {
  const index = doc.agents.findIndex((a) => a.id === id);
  if (index < 0) return { doc, removed: null };
  const wasHidden = doc.hidden.includes(id);
  return {
    doc: { ...doc, agents: doc.agents.filter((a) => a.id !== id), hidden: wasHidden ? doc.hidden : [...doc.hidden, id] },
    removed: { record: doc.agents[index]!, index, wasHidden },
  };
}

/** Undo a removal: the same record back at its old place, un-hidden. */
export function restoreAgent(doc: AgentsDoc, r: RemovedAgent): AgentsDoc {
  const hidden = r.wasHidden ? doc.hidden : doc.hidden.filter((h) => h !== r.record.id);
  if (doc.agents.some((a) => a.id === r.record.id)) return { ...doc, hidden };
  const agents = doc.agents.slice();
  agents.splice(Math.min(Math.max(0, r.index), agents.length), 0, r.record);
  return { ...doc, hidden, agents };
}

function patch(doc: AgentsDoc, id: string, fn: (a: AgentRecord) => AgentRecord): AgentsDoc {
  if (!doc.agents.some((a) => a.id === id)) return doc;
  return { ...doc, agents: doc.agents.map((a) => (a.id === id ? fn(a) : a)) };
}

/** Rename (blank = back to the auto name). Marks the Agent saved. */
export function renameAgent(doc: AgentsDoc, id: string, name: string): AgentsDoc {
  const v = String(name ?? "").trim().slice(0, NAME_MAX);
  return patch(doc, id, (a) => ({ ...a, name: v || null, saved: true }));
}

export type AgentColor = { theme: ThemeKey } | { hue: number };

export function recolorAgent(doc: AgentsDoc, id: string, c: AgentColor): AgentsDoc {
  return patch(doc, id, (a) => ("theme" in c ? { ...a, theme: c.theme, saved: true } : { ...a, theme: null, hue: clampHue(c.hue), saved: true }));
}

/** Drag or Alt+Arrow: move `id` to `toIndex` of the final list. The order becomes the user's (manual). */
export function moveAgent(doc: AgentsDoc, id: string, toIndex: number): AgentsDoc {
  const from = doc.agents.findIndex((a) => a.id === id);
  if (from < 0) return doc;
  const rest = doc.agents.filter((a) => a.id !== id);
  const to = Math.min(Math.max(0, Math.round(toIndex)), rest.length);
  rest.splice(to, 0, { ...doc.agents[from]!, saved: true });
  return { ...doc, agents: rest, manual: true };
}

/** The label per Agent: the user's name, else the basename; equal basenames get parent hints
 *  (`work/api`, `games/api`), climbing until they differ or the path runs out. */
export function displayNames(agents: readonly Pick<AgentRecord, "id" | "path" | "name">[]): Map<string, string> {
  const out = new Map<string, string>();
  const segs = new Map<string, string[]>();
  for (const a of agents) segs.set(a.id, String(a.path).split(/[\\/]+/).filter(Boolean));
  const label = (id: string, depth: number): string => {
    const p = segs.get(id) ?? [];
    return p.slice(Math.max(0, p.length - depth)).join("/") || p.join("/");
  };
  const auto = agents.filter((a) => !a.name);
  const depth = new Map(auto.map((a) => [a.id, 1]));
  for (let round = 0; round < 8; round++) {
    const groups = new Map<string, string[]>();
    for (const a of auto) {
      const k = label(a.id, depth.get(a.id)!).toLowerCase();
      groups.set(k, [...(groups.get(k) ?? []), a.id]);
    }
    let changed = false;
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) {
        const d = depth.get(id)!;
        if (d < (segs.get(id)?.length ?? 0)) { depth.set(id, d + 1); changed = true; }
      }
    }
    if (!changed) break;
  }
  for (const a of agents) out.set(a.id, a.name ?? (label(a.id, depth.get(a.id) ?? 1) || a.path));
  return out;
}

export const isLaneBusy = (status: string): boolean => status === "working" || status === "needs-approval";

/** A lane counts for both its own folder and (for a LUCID worktree) the main checkout it branched from. */
export function laneFolderIds(cwd: string): string[] {
  const a = normFolder(cwd), b = normFolder(mainCheckoutCwd(cwd));
  return a === b ? [a] : [a, b];
}

/** Live lanes' folders as Agent sources (their main checkout); a stopped lane no longer counts. */
export function laneSourceFolders(lanes: readonly LaneLike[]): string[] {
  return lanes.filter((l) => l.status !== "stopped" && l.cwd).map((l) => mainCheckoutCwd(l.cwd));
}

/** Folder ids with an agent working in them right now: Main mid-turn in its folder, or any busy lane. */
export function workingFolders(main: { folder: string | null; busy: boolean }, lanes: readonly LaneLike[]): Set<string> {
  const out = new Set<string>();
  if (main.busy && main.folder) out.add(normFolder(main.folder));
  for (const l of lanes) if (isLaneBusy(l.status) && l.cwd) for (const id of laneFolderIds(l.cwd)) out.add(id);
  return out;
}

export interface LaneMemo { busy: boolean; turns: number; folders: string[] }

/** Which folders just saw a lane turn end since the last poll (busy -> idle, or the turn count rose). The
 *  first poll (prev null) reports nothing: a turn that ended before the rail looked is not news. */
export function laneTurnEnds(prev: ReadonlyMap<string, LaneMemo> | null, lanes: readonly LaneLike[]): { ended: string[]; next: Map<string, LaneMemo> } {
  const next = new Map<string, LaneMemo>();
  const ended = new Set<string>();
  for (const l of lanes) {
    const memo: LaneMemo = { busy: isLaneBusy(l.status), turns: Number(l.turns) || 0, folders: l.cwd ? laneFolderIds(l.cwd) : [] };
    next.set(l.id, memo);
    const p = prev?.get(l.id);
    if (p && ((p.busy && !memo.busy) || memo.turns > p.turns)) for (const f of memo.folders) ended.add(f);
  }
  return { ended: [...ended], next };
}
