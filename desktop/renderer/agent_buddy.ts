// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/agent_buddy.ts - P-BUDDY.1 (ADR-0667): floating Agent buddies.
//
// A small copy of the rail's Agent glass brick (agents_rail_art.agentArt, in that folder's palette) floats over
// the main composer, over each visible Fleet lane card's composer and beside each lane node in Agent Worlds. It
// sits just above the composer's upper-left corner by default, drifts in a tiny ellipse and glows softly in its
// Agent's color; a drag moves it anywhere on its canvas (remembered per folder in `lucid.buddies.v1`), a
// double-click puts it back. A click opens its ideas bubble (the rail module's look): what the agent is doing
// and up to three short ideas from a smaller model (bridge.buddySuggest), each runnable in a parallel worktree
// agent or handed to the Ask Lucid fly-out. Ideas also arrive on their own after a turn ends (setting
// "Suggest ideas after each turn", at most once every 3 minutes per agent), shown as a badge and a short chip,
// never a toast.
//
// The pure parts (canvas geometry, stored spots, settings, when to fetch) are exported for unit tests;
// mountAgentBuddies owns the DOM. Folder names, lane names and model text are always escaped.

import { AGENTS_KEY, baseName, defaultTheme, displayNames, isLaneBusy, laneFolderIds, laneTurnEnds, loadDoc, normFolder, purposeOf, type AgentsDoc, type LaneLike, type LaneMemo } from "./agents_store.ts";
import { agentArt, paletteOf, paletteStyle, type AgentPalette, type ArtState } from "./agents_rail_art.ts";
import { DRAG_SLOP, loopDelay, placeModule } from "./agents_rail.ts";
import { esc } from "./format.ts";
import { baseTier, pollDelay, type PerfTier } from "./perf_tier.ts";
import type { BuddyIdea, BuddyReply, BuddySurface, FleetStatusView } from "./bridge.ts";
import type { ToastOpts } from "./ui.ts";

export const BUDDY_POS_KEY = "lucid.buddies.v1";
export const BUDDY_SETTINGS_KEY = "lucid.buddies.settings.v1";
/** Ideas older than this (or from before the agent's last turn) are fetched again when the bubble opens. */
export const STALE_MS = 120_000;
/** At most one automatic fetch per agent this often. */
export const AUTO_GAP_MS = 180_000;
/** The "2 ideas" chip after an automatic fetch. */
export const CHIP_MS = 8000;
/** One turn of the ellipse drift (CSS abdDrift runs this long). */
export const DRIFT_S = 8;
const TICK_MS = 1000;
const LANE_POLL_MS = 4000;

// ── pure helpers ───────────────────────────────────────────────────────────────────────────────────────────

export interface Pt { x: number; y: number }
export interface Size { w: number; h: number }
export interface Rect { left: number; top: number; width: number; height: number }
export interface Frac { fx: number; fy: number }
export interface Offset { dx: number; dy: number }
/** A stored spot: a fraction of the free canvas (main, lane cards) or a pixel offset from the node (worlds). */
export type Spot = Frac | Offset;
export interface BuddySettings { show: boolean; auto: boolean }

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Keep the buddy's box inside its canvas, `margin` px from every edge (a canvas smaller than the buddy pins it
 *  to the top-left margin). */
export function clampToCanvas(p: Pt, size: Size, canvas: Size, margin = 2): Pt {
  const maxX = Math.max(margin, canvas.w - size.w - margin), maxY = Math.max(margin, canvas.h - size.h - margin);
  return { x: Math.min(Math.max(num(p.x), margin), maxX), y: Math.min(Math.max(num(p.y), margin), maxY) };
}

/** A position as fractions of the canvas space the buddy can move in, so it lands in the same place after a
 *  resize. */
export function toFraction(p: Pt, size: Size, canvas: Size): Frac {
  const fw = Math.max(1, canvas.w - size.w), fh = Math.max(1, canvas.h - size.h);
  return { fx: clamp01(num(p.x) / fw), fy: clamp01(num(p.y) / fh) };
}

export function fromFraction(f: Frac, size: Size, canvas: Size): Pt {
  const fw = Math.max(0, canvas.w - size.w), fh = Math.max(0, canvas.h - size.h);
  return clampToCanvas({ x: clamp01(num(f.fx)) * fw, y: clamp01(num(f.fy)) * fh }, size, canvas);
}

/** The default spot, in canvas px: just above the composer box's top-left edge, a few px in from its left, so it
 *  never covers the composer's own controls. `anchor` and `canvas` are client rects. */
export function defaultSpot(anchor: Rect, canvas: Rect, size: Size, scale = 1): Pt {
  const s = scale > 0 ? scale : 1;
  return clampToCanvas(
    { x: (anchor.left - canvas.left) / s + 6, y: (anchor.top - canvas.top) / s - size.h - 2 },
    size, { w: canvas.width / s, h: canvas.height / s },
  );
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Parse the stored spots; anything malformed is dropped (never throws). */
export function loadPositions(raw: string | null | undefined): Record<string, Spot> {
  const out: Record<string, Spot> = {};
  let parsed: unknown;
  try { parsed = JSON.parse(String(raw ?? "")); } catch { return out; }
  if (!parsed || typeof parsed !== "object" || !("spots" in parsed)) return out;
  const spots = parsed.spots;
  if (!spots || typeof spots !== "object" || Array.isArray(spots)) return out;
  for (const [k, v] of Object.entries(spots)) {
    if (!k || !v || typeof v !== "object") continue;
    if ("fx" in v && "fy" in v && finite(v.fx) && finite(v.fy)) out[k] = { fx: clamp01(v.fx), fy: clamp01(v.fy) };
    else if ("dx" in v && "dy" in v && finite(v.dx) && finite(v.dy)) out[k] = { dx: v.dx, dy: v.dy };
  }
  return out;
}

export function savePositions(spots: Readonly<Record<string, Spot>>): string {
  return JSON.stringify({ v: 1, spots });
}

/** Both settings default on; only an explicit false turns one off. */
export function readBuddySettings(raw: string | null | undefined): BuddySettings {
  let p: unknown = null;
  try { p = JSON.parse(String(raw ?? "")); } catch { /* defaults */ }
  if (!p || typeof p !== "object") return { show: true, auto: true };
  return { show: !("show" in p) || p.show !== false, auto: !("auto" in p) || p.auto !== false };
}

export function saveBuddySettings(s: BuddySettings): string {
  return JSON.stringify({ show: !!s.show, auto: !!s.auto });
}

/** Fetch ideas on their own after a turn: the setting is on, the window is visible, a turn ended since the last
 *  fetch, and the last automatic fetch for this agent was at least AUTO_GAP_MS ago. */
export function shouldAutoSuggest(lastAt: number, now: number, turnsSeen: number, turns: number, visible: boolean, enabled: boolean): boolean {
  return enabled && visible && turns !== turnsSeen && now - lastAt >= AUTO_GAP_MS;
}

/** Ideas the bubble refetches when it opens: none yet, older than STALE_MS, or from before the agent's last turn. */
export function isStale(at: number, now: number, turnsAt: number, turns: number): boolean {
  return at <= 0 || now - at > STALE_MS || turns !== turnsAt;
}

/** A negative animation delay per buddy, so the drifts never move in step. */
export function driftDelay(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 33 + key.charCodeAt(i)) >>> 0;
  return -((h % (DRIFT_S * 100)) / 100);
}

export const ideaCount = (n: number): string => `${n} idea${n === 1 ? "" : "s"}`;

/** The Ask Lucid question for one idea: which agent, where, and what it suggested. */
export function askFraming(name: string, folder: string, idea: Pick<BuddyIdea, "title" | "prompt">): string {
  return `${name} (working in ${folder}) suggested this idea: ${idea.title}\n\n${idea.prompt}\n\nIs this worth doing, and how should I go about it?`;
}

// ── the mounted buddies ────────────────────────────────────────────────────────────────────────────────────

interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }

export interface WorldBuddySource {
  /** The lane node ids on the stage now. */
  ids(): string[];
  /** The node's frame on screen (client px), or null while it is off screen. */
  boxOf(id: string): { x: number; y: number; r: number } | null;
  /** The node's working folder (its lane cwd), or null when unknown. */
  folderOf(id: string): string | null;
  /** The fleet lane id behind the node, or null. */
  laneOf(id: string): string | null;
}

export interface AgentBuddiesDeps {
  /** The main column (`main.center`, holding #chat and the composer): the main buddy's canvas. */
  mainCanvas(): HTMLElement | null;
  /** `.composer-wrap`: the main buddy's default spot sits on its upper-left corner. */
  mainAnchor(): HTMLElement | null;
  /** `#fleetGrid`, when the Fleet panel has been built. */
  fleetGrid(): HTMLElement | null;
  getMainFolder(): string | null;
  isMainBusy(): boolean;
  fleetStatus(): Promise<FleetStatusView | null>;
  suggest(req: { surface: BuddySurface; laneId?: string; purpose?: "app" | "docs" | "analysis" | "other" | null }): Promise<BuddyReply | null>;
  /** Start a parallel worktree agent in `folder` whose first prompt is the idea (the app gives the feedback). */
  runInWorktree(folder: string, idea: BuddyIdea, name: string): Promise<void>;
  /** Open the Ask Lucid fly-out with `text` in its input. */
  askLucid(text: string): void;
  toast(o: ToastOpts): () => void;
  perfTier(): PerfTier;
  storage?: KV;
}

export interface AgentBuddies {
  /** Re-read settings, Main's folder and busy flag, the Agents palettes and the lane cards now. */
  sync(): void;
  /** A turn ended for an agent working in `folder`. */
  noteTurnEnd(folder: string): void;
  /** Agent Worlds: one buddy per lane node, following it every animation frame. Returns the detach. */
  attachWorlds(stage: HTMLElement, src: WorldBuddySource): () => void;
}

type Where = "main" | "lane" | "world";

interface Buddy {
  /** "main" | "lane:<laneId>" | "world:<nodeId>" */
  key: string;
  where: Where;
  /** "main" or the lane id: the ideas it shows (a lane's card and world buddies share them). */
  agent: string;
  laneId: string | null;
  folder: string;
  /** "main" | "lane:<folderId>" | "world:<folderId>" */
  spotKey: string;
  canvas: HTMLElement;
  anchor: HTMLElement | null;
  host: HTMLElement;
  btn: HTMLButtonElement;
  badge: HTMLElement;
  chip: HTMLElement;
  st: ArtState;
  name: string;
  pal: string;
  /** Top-left in canvas px. */
  pos: Pt;
  dragging: boolean;
  chipTimer: number;
  /** Main and lane buddies: re-lays out the moment its canvas or composer changes size, not on the next tick. */
  ro: ResizeObserver | null;
}

interface Ideas { reply: BuddyReply | null; error: string | null; at: number; turnsAt: number; loading: Promise<void> | null; unseen: number; lastAuto: number }

interface Attachment { stage: HTMLElement; src: WorldBuddySource; raf: number; live: boolean }

function safeStorage(): KV {
  return {
    getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage off: positions hold for this session */ } },
  };
}

function applyPalette(el: HTMLElement, p: AgentPalette): void {
  for (const k of ["K", "D", "L", "G", "g"] as const) el.style.setProperty(`--${k}`, p[k]);
}

const shown = (el: HTMLElement | null): el is HTMLElement => !!el && el.isConnected && el.getClientRects().length > 0;
/** P-SPINUP.1 (ADR-0668): this surface's agent is still starting and its spin-up walker (agent_spinup.ts, same key,
 *  same canvas) stands in for the buddy until it has faded out. */
const spinningUp = (b: Pick<Buddy, "canvas" | "key">): boolean => !!b.canvas.querySelector(`:scope > .spw-host[data-spw-key="${CSS.escape(b.key)}"]`);
/** CSS px per client px of `el` (an ancestor's CSS zoom scales client rects, not style lengths). */
const scaleOf = (el: HTMLElement, r: DOMRect): number => (el.offsetWidth > 0 && r.width > 0 ? r.width / el.offsetWidth : 1);

const WITHHELD = "This agent's recent work did not pass the security scan, so nothing was sent to a model and no ideas were made.";
const NO_ANSWER = "The ideas service did not answer. Try New ideas in a moment.";

export function mountAgentBuddies(d: AgentBuddiesDeps): AgentBuddies {
  const kv = d.storage ?? safeStorage();
  let settings = readBuddySettings(kv.getItem(BUDDY_SETTINGS_KEY));
  let spots = loadPositions(kv.getItem(BUDDY_POS_KEY));
  let docRaw: string | null = null;
  let doc: AgentsDoc = loadDoc(null);
  let names = new Map<string, string>();
  let lanes: (LaneLike & { name: string })[] = [];
  let laneMemo: Map<string, LaneMemo> | null = null;
  let lastLanePoll = 0;
  let mainTurns = 0;
  const buddies = new Map<string, Buddy>();
  const ideas = new Map<string, Ideas>();
  const worlds = new Set<Attachment>();
  let gridRoot: HTMLElement | null = null;
  let gridObs: MutationObserver | null = null;
  let gridQueued = false;

  const pop = document.createElement("div");
  pop.className = "popover agr-pop abd-pop";
  pop.setAttribute("role", "dialog");
  pop.tabIndex = -1;
  document.body.append(pop);
  const nub = document.createElement("div");
  nub.className = "agr-nub";
  nub.setAttribute("aria-hidden", "true");
  document.body.append(nub);
  let cur: Buddy | null = null;

  const calm = (): boolean => baseTier(d.perfTier()) === "minimal";
  const ideasOf = (agent: string): Ideas => {
    let s = ideas.get(agent);
    if (!s) { s = { reply: null, error: null, at: 0, turnsAt: 0, loading: null, unseen: 0, lastAuto: 0 }; ideas.set(agent, s); }
    return s;
  };
  const laneById = (id: string | null): (LaneLike & { name: string }) | undefined => (id ? lanes.find((l) => l.id === id) : undefined);
  const turnsOf = (agent: string): number => (agent === "main" ? mainTurns : laneById(agent)?.turns ?? 0);

  // ── Agents records: palette, name, purpose ──
  function reloadDoc(): void {
    const raw = kv.getItem(AGENTS_KEY);
    if (raw === docRaw) return;
    docRaw = raw;
    doc = loadDoc(raw);
    names = displayNames(doc.agents);
  }
  /** The Agent record for a folder: its own, else (for a LUCID worktree) its main checkout's. */
  function recordOf(folder: string): { id: string; rec: AgentsDoc["agents"][number] | undefined } {
    const ids = laneFolderIds(folder);
    for (const id of ids) { const rec = doc.agents.find((a) => a.id === id); if (rec) return { id, rec }; }
    return { id: ids[ids.length - 1]!, rec: undefined };
  }
  function paletteFor(folder: string): AgentPalette {
    const { id, rec } = recordOf(folder);
    return paletteOf(rec ?? { theme: defaultTheme(id), hue: 145 });
  }
  function nameFor(where: Where, folder: string, laneId: string | null): string {
    const lane = laneById(laneId);
    if (where !== "main" && lane?.name) return lane.name;
    const { id, rec } = recordOf(folder);
    return (rec ? names.get(id) : null) ?? baseName(folder);
  }
  const purposeFor = (folder: string): "app" | "docs" | "analysis" | "other" | null => {
    for (const id of laneFolderIds(folder)) { const p = purposeOf(doc, id); if (p) return p; }
    return null;
  };
  function stateOf(b: Pick<Buddy, "where" | "laneId">): ArtState {
    if (b.where === "main") return d.isMainBusy() ? "work" : "idle";
    const l = laneById(b.laneId);
    return l && isLaneBusy(l.status) ? "work" : "idle";
  }
  function whereLine(b: Buddy): string {
    if (b.st !== "work") return "Meditating · idle";
    return b.where === "main" ? "Typing · Main composer" : `Typing · Fleet lane ${b.name}`;
  }

  // ── buddy elements ──
  function makeBuddy(key: string, where: Where, agent: string, laneId: string | null, folder: string, canvas: HTMLElement, anchor: HTMLElement | null): Buddy {
    const host = document.createElement("div");
    host.className = "abd-host";
    host.dataset.where = where;
    host.innerHTML = `<span class="abd-drift" style="--abd-ph:${driftDelay(key).toFixed(2)}s"><button type="button" class="abd" aria-haspopup="dialog"></button></span><span class="abd-chip" aria-hidden="true"></span>`;
    const btn = host.querySelector(".abd") as HTMLButtonElement; // built just above
    btn.dataset.abdSurface = where;
    btn.dataset.abdKey = key;
    if (laneId) btn.dataset.abdLane = laneId;
    const b: Buddy = {
      key, where, agent, laneId, folder, spotKey: where === "main" ? "main" : `${where}:${normFolder(folder)}`, canvas, anchor, host, btn,
      badge: document.createElement("i"), chip: host.querySelector(".abd-chip") as HTMLElement, st: "idle", name: "", pal: "", pos: { x: 0, y: 0 }, dragging: false, chipTimer: 0, ro: null,
    };
    if (where !== "world" && typeof ResizeObserver !== "undefined") {
      b.ro = new ResizeObserver(() => { if (buddies.get(key) === b) layoutAnchored(b); });
      b.ro.observe(canvas);
      if (anchor) b.ro.observe(anchor);
    }
    b.badge.className = "abd-badge";
    b.badge.setAttribute("aria-hidden", "true");
    b.badge.hidden = true;
    canvas.classList.add("abd-canvas");
    canvas.append(host);
    paintBuddy(b, true);
    wireBuddy(b);
    buddies.set(key, b);
    return b;
  }
  function paintBuddy(b: Buddy, force = false): void {
    const st = stateOf(b);
    const name = nameFor(b.where, b.folder, b.laneId);
    const p = paletteFor(b.folder);
    if (force || st !== b.st) {
      b.st = st;
      b.btn.innerHTML = agentArt(st, loopDelay(b.key));
      b.btn.append(b.badge);
      b.btn.dataset.state = st;
    }
    if (force || p.G !== b.pal) { b.pal = p.G; applyPalette(b.host, p); }
    if (force || name !== b.name) {
      b.name = name;
      b.btn.setAttribute("aria-label", `${name}: ideas`);
      b.btn.title = `${name}: ideas`;
    }
    const n = ideasOf(b.agent).unseen;
    b.badge.hidden = n <= 0;
    if (n > 0 && b.badge.textContent !== String(n)) b.badge.textContent = String(n);
    b.host.classList.toggle("abd-calm", calm());
    b.host.classList.toggle("agr-calm", calm());
  }
  function dropBuddy(key: string): void {
    const b = buddies.get(key);
    if (!b) return;
    if (cur === b) closePop(false);
    clearTimeout(b.chipTimer);
    b.ro?.disconnect();
    b.host.remove();
    buddies.delete(key);
  }
  function setPos(b: Buddy, p: Pt): void {
    b.pos = p;
    b.host.style.setProperty("translate", `${Math.round(p.x)}px ${Math.round(p.y)}px`);
  }
  const sizeOf = (b: Buddy): Size => ({ w: b.btn.offsetWidth || 32, h: b.btn.offsetHeight || 24 });

  /** Main and lane buddies: the stored fraction of the canvas, else the default spot on the composer. */
  function layoutAnchored(b: Buddy): void {
    if (b.dragging) return;
    if (!shown(b.canvas) || spinningUp(b)) { b.host.hidden = true; return; }
    b.host.hidden = false;
    const c = b.canvas.getBoundingClientRect();
    const s = scaleOf(b.canvas, c);
    const size = sizeOf(b);
    const canvas = { w: c.width / s, h: c.height / s };
    const spot = spots[b.spotKey];
    if (spot && "fx" in spot) { setPos(b, fromFraction(spot, size, canvas)); return; }
    const a = shown(b.anchor) ? b.anchor.getBoundingClientRect() : null;
    setPos(b, a ? defaultSpot(a, c, size, s) : clampToCanvas({ x: 8, y: canvas.h - size.h - 72 }, size, canvas));
  }

  /** A world buddy's default top-left in stage px: centered up and left of its node, at (box.x - r, box.y - r). */
  function worldBase(b: Buddy, att: Attachment, nodeId: string, s: DOMRect): Pt | null {
    const box = att.src.boxOf(nodeId);
    // A node off the stage (panned or orbited away) takes its buddy with it, never piled on the stage's edge.
    if (!box || box.x < s.left || box.x > s.right || box.y < s.top || box.y > s.bottom) return null;
    const k = scaleOf(att.stage, s);
    const size = sizeOf(b);
    return { x: (box.x - box.r - s.left) / k - size.w / 2, y: (box.y - box.r - s.top) / k - size.h / 2 };
  }
  /** World buddies: the default spot plus the stored offset, kept on the stage. */
  function layoutWorld(b: Buddy, att: Attachment, nodeId: string, s: DOMRect): void {
    if (b.dragging) return;
    const base = worldBase(b, att, nodeId, s);
    if (!base || spinningUp(b)) { b.host.hidden = true; return; }
    b.host.hidden = false;
    const k = scaleOf(att.stage, s);
    const off = spots[b.spotKey];
    const o = off && "dx" in off ? off : { dx: 0, dy: 0 };
    setPos(b, clampToCanvas({ x: base.x + o.dx, y: base.y + o.dy }, sizeOf(b), { w: s.width / k, h: s.height / k }));
    if (cur === b) placePop();
  }
  const attOf = (b: Buddy): { att: Attachment; node: string } | null => {
    if (b.where !== "world") return null;
    for (const att of worlds) if (att.stage === b.canvas) return { att, node: b.key.slice("world:".length) };
    return null;
  };

  function saveSpot(b: Buddy): void {
    const c = b.canvas.getBoundingClientRect();
    const s = scaleOf(b.canvas, c);
    if (b.where === "world") {
      const w = attOf(b);
      const base = w ? worldBase(b, w.att, w.node, c) : null;
      if (!base) return;
      spots = { ...spots, [b.spotKey]: { dx: Math.round(b.pos.x - base.x), dy: Math.round(b.pos.y - base.y) } };
    } else {
      spots = { ...spots, [b.spotKey]: toFraction(b.pos, sizeOf(b), { w: c.width / s, h: c.height / s }) };
    }
    kv.setItem(BUDDY_POS_KEY, savePositions(spots));
  }
  function resetSpot(b: Buddy): void {
    if (!(b.spotKey in spots)) return;
    const next = { ...spots };
    delete next[b.spotKey];
    spots = next;
    kv.setItem(BUDDY_POS_KEY, savePositions(spots));
    if (b.where !== "world") layoutAnchored(b);
    if (cur === b) placePop();
  }

  // ── drag, click, double-click ──
  function wireBuddy(b: Buddy): void {
    let suppressClick = false;
    b.btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // a press on the buddy is never the canvas's (the Worlds camera, a lane card's own drags)
      const ox = e.clientX, oy = e.clientY;
      const start = { ...b.pos };
      let started = false;
      let k = 1, canvas: Size = { w: 0, h: 0 };
      const move = (m: PointerEvent): void => {
        // A release we never heard (focus lost mid-press) or a buddy rebuilt under the press: never drag a buddy
        // with no button held, and never write a dropped buddy's spot over its replacement's.
        if ((m.buttons & 1) === 0 || buddies.get(b.key) !== b) { up(); return; }
        if (!started) {
          if (Math.abs(m.clientX - ox) < DRAG_SLOP && Math.abs(m.clientY - oy) < DRAG_SLOP) return;
          started = true;
          b.dragging = true;
          b.host.classList.add("abd-dragging");
          const c = b.canvas.getBoundingClientRect();
          k = scaleOf(b.canvas, c);
          canvas = { w: c.width / k, h: c.height / k };
        }
        m.preventDefault();
        setPos(b, clampToCanvas({ x: start.x + (m.clientX - ox) / k, y: start.y + (m.clientY - oy) / k }, sizeOf(b), canvas));
        if (cur === b) placePop();
      };
      const up = (): void => {
        off();
        if (!started) return;
        suppressClick = true;
        window.setTimeout(() => { suppressClick = false; }, 0);
        b.dragging = false;
        b.host.classList.remove("abd-dragging");
        if (buddies.get(b.key) === b) saveSpot(b);
      };
      // On the window, like the rail: a re-render or a lost capture must never strand a lifted buddy.
      const off = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
    b.btn.addEventListener("click", (e) => {
      if (suppressClick || e.detail > 1) return; // a drag's release, or a double-click's second click
      if (cur === b) closePop(true); else openPop(b);
    });
    // The double-click's first click opened the bubble; the reset is the intent, so it closes again.
    b.btn.addEventListener("dblclick", () => { if (cur === b) closePop(false); resetSpot(b); });
    b.btn.addEventListener("keydown", (e) => { if (e.key === "Escape" && cur === b) { e.preventDefault(); closePop(true); } });
  }

  // ── ideas ──
  function fetchIdeas(agent: string, auto: boolean): Promise<void> {
    const s = ideasOf(agent);
    if (s.loading) return s.loading;
    const folder = agent === "main" ? d.getMainFolder() : laneById(agent)?.cwd ?? null;
    const purpose = folder ? purposeFor(folder) : null;
    const req = agent === "main" ? { surface: "main" as const, purpose } : { surface: "lane" as const, laneId: agent, purpose };
    const job = (async () => {
      const r = await d.suggest(req).catch(() => null);
      s.loading = null;
      s.at = Date.now();
      s.turnsAt = turnsOf(agent);
      if (!r) { s.error = NO_ANSWER; }
      else if (r.withheld) { s.reply = r; s.error = null; }
      else if (!r.ok) { s.error = r.error || NO_ANSWER; }
      else {
        s.reply = { ...r, ideas: r.ideas.slice(0, 3) };
        s.error = null;
        const n = s.reply.ideas.length;
        if (auto && n && cur?.agent !== agent) { s.unseen = n; showChip(agent, n); }
      }
      for (const b of buddies.values()) if (b.agent === agent) paintBuddy(b);
      if (cur?.agent === agent) paintPop();
    })();
    s.loading = job;
    if (cur?.agent === agent) paintPop();
    return job;
  }
  function showChip(agent: string, n: number): void {
    for (const b of buddies.values()) {
      if (b.agent !== agent || b.host.hidden) continue;
      clearTimeout(b.chipTimer);
      b.chip.textContent = ideaCount(n);
      b.chip.classList.add("show");
      b.chipTimer = window.setTimeout(() => b.chip.classList.remove("show"), CHIP_MS);
    }
  }
  function maybeAuto(agent: string): void {
    if (![...buddies.values()].some((b) => b.agent === agent)) return;
    const s = ideasOf(agent);
    const now = Date.now();
    if (s.loading || !shouldAutoSuggest(s.lastAuto, now, s.turnsAt, turnsOf(agent), !document.hidden, settings.show && settings.auto)) return;
    s.lastAuto = now;
    void fetchIdeas(agent, true);
  }

  // ── the ideas bubble ──
  function bodyHtml(b: Buddy): string {
    const s = ideasOf(b.agent);
    if (s.loading && !s.reply) return `<p class="abd-note" role="status">Thinking about what to suggest...</p>`;
    if (s.error && !s.reply) return `<p class="abd-note abd-warn" role="status">${esc(s.error)}</p>`;
    const r = s.reply;
    if (!r) return `<p class="abd-note" role="status">Thinking about what to suggest...</p>`;
    if (r.withheld) return `<p class="abd-note abd-warn" role="status">${esc(WITHHELD)}</p>`;
    const top = s.loading ? `<p class="abd-note" role="status">Thinking about what to suggest...</p>` : s.error ? `<p class="abd-note abd-warn" role="status">${esc(s.error)}</p>` : "";
    if (!r.ideas.length) return `${top}<p class="abd-note">No ideas right now. Ask again after its next turn.</p>`;
    return top + r.ideas.map((it, i) => `<div class="abd-idea">`
      + `<div class="abd-idea-t" title="${esc(it.title)}">${esc(it.title)}</div>`
      + `<div class="abd-idea-p" title="${esc(it.prompt)}">${esc(it.prompt)}</div>`
      + `<div class="abd-idea-acts"><button class="btn-mini ok" type="button" data-abd-run="${i}">Run in parallel worktree</button>`
      + `<button class="btn-mini" type="button" data-abd-ask="${i}">Ask Lucid</button></div></div>`).join("");
  }
  function paintPop(): void {
    if (!cur) return;
    const b = cur;
    const s = ideasOf(b.agent);
    const doing = s.reply?.doing?.trim() || whereLine(b);
    const model = s.reply?.model ?? "";
    const active = document.activeElement instanceof HTMLElement && pop.contains(document.activeElement) ? document.activeElement : null;
    pop.innerHTML = `<div class="agr-ph"><div class="agr-ph-art">${agentArt(b.st, loopDelay(b.key))}</div><div class="agr-ph-id">`
      + `<div class="agr-ph-name" title="${esc(b.name)}">${esc(b.name)}</div>`
      + `<div class="agr-ph-path" title="${esc(b.folder)}">${esc(b.folder)}</div>`
      + `<div class="agr-ph-state${b.st === "work" ? " work" : ""}"><i></i><span title="${esc(doing)}">${esc(doing)}</span></div></div></div>`
      + `<div class="cfg-sec abd-ideas" aria-live="polite">${bodyHtml(b)}</div>`
      + `<div class="abd-foot"><button class="btn-mini" type="button" data-abd-refresh${s.loading ? " disabled" : ""}>New ideas</button>`
      + `<span class="abd-model" title="${esc(model)}">${esc(model)}</span></div>`;
    // A repaint while the user was on a button keeps them on the same one.
    if (active) {
      const ds = active.dataset;
      const sel = ds.abdRun !== undefined ? `[data-abd-run="${ds.abdRun}"]` : ds.abdAsk !== undefined ? `[data-abd-ask="${ds.abdAsk}"]` : active.hasAttribute("data-abd-refresh") ? "[data-abd-refresh]" : null;
      const el = sel ? pop.querySelector<HTMLButtonElement>(sel) : null;
      (el && !el.disabled ? el : pop).focus({ preventScroll: true });
    }
    placePop();
  }
  function placePop(): void {
    if (!cur) return;
    if (!cur.host.isConnected || cur.host.hidden) { closePop(false); return; }
    pop.style.maxHeight = `${Math.max(120, innerHeight - 16)}px`;
    const p = placeModule(cur.btn.getBoundingClientRect(), { w: pop.offsetWidth, h: pop.offsetHeight }, { w: innerWidth, h: innerHeight });
    pop.style.left = `${Math.round(p.x)}px`;
    pop.style.top = `${Math.round(p.y)}px`;
    pop.style.transformOrigin = p.side === "l" ? "100% 50%" : "0 50%";
    pop.dataset.side = p.side;
    nub.className = `agr-nub show ${p.side}`;
    nub.style.left = `${Math.round(p.nubX)}px`;
    nub.style.top = `${Math.round(p.nubY)}px`;
  }
  function openPop(b: Buddy): void {
    if (cur) closePop(false);
    cur = b;
    b.btn.setAttribute("aria-expanded", "true");
    pop.setAttribute("style", paletteStyle(paletteFor(b.folder)));
    pop.setAttribute("aria-label", `${b.name}: ideas`);
    const s = ideasOf(b.agent);
    s.unseen = 0;
    for (const o of buddies.values()) if (o.agent === b.agent) { paintBuddy(o); o.chip.classList.remove("show"); }
    paintPop();
    pop.classList.add("show");
    placePop();
    pop.focus({ preventScroll: true });
    if (!s.loading && (!s.reply || isStale(s.at, Date.now(), s.turnsAt, turnsOf(b.agent)))) void fetchIdeas(b.agent, false);
  }
  function closePop(refocus: boolean): void {
    if (!cur) return;
    const b = cur;
    cur = null;
    b.btn.setAttribute("aria-expanded", "false");
    pop.classList.remove("show");
    nub.classList.remove("show");
    if (refocus && b.btn.isConnected) b.btn.focus({ preventScroll: true });
  }
  pop.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("button");
    if (!btn || !cur) return;
    const b = cur;
    if (btn.hasAttribute("data-abd-refresh")) { void fetchIdeas(b.agent, false); return; }
    const list = ideasOf(b.agent).reply?.ideas ?? [];
    const run = btn.dataset.abdRun, ask = btn.dataset.abdAsk;
    const idea = list[Number(run ?? ask)];
    if (!idea) return;
    closePop(false);
    if (run !== undefined) {
      if (!b.folder) { d.toast({ tone: "warn", title: "No folder to run in", desc: "Open a workspace first, then try the idea again.", timeout: 6000 }); return; }
      void d.runInWorktree(b.folder, idea, b.name).catch((err: unknown) => {
        d.toast({ tone: "warn", title: `${b.name}: the worktree agent did not start`, desc: err instanceof Error ? err.message : String(err), timeout: 8000 });
      });
    } else {
      d.askLucid(askFraming(b.name, b.folder, idea));
    }
  });
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePop(true); }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!cur) return;
    const t = e.target;
    if (t instanceof Node && (pop.contains(t) || cur.btn.contains(t))) return;
    closePop(false);
  }, true);
  window.addEventListener("resize", () => { for (const b of buddies.values()) if (b.where !== "world") layoutAnchored(b); placePop(); });

  // ── surfaces ──
  function syncMain(): void {
    const folder = d.getMainFolder();
    const canvas = d.mainCanvas();
    if (!settings.show || !folder || !canvas) { dropBuddy("main"); return; }
    const b = buddies.get("main");
    if (b && (b.canvas !== canvas || normFolder(b.folder) !== normFolder(folder))) dropBuddy("main");
    const m = buddies.get("main") ?? makeBuddy("main", "main", "main", null, folder, canvas, d.mainAnchor());
    m.anchor = d.mainAnchor();
    paintBuddy(m);
    layoutAnchored(m);
  }
  const gridShown = (): boolean => shown(gridRoot);
  /** A mutation that adds or removes a lane card (a streaming transcript's text never does). */
  const touchesCards = (nodes: NodeList): boolean => [...nodes].some((n) => n instanceof Element && (n.matches(".fleet-card, .fleet-card-main") || !!n.querySelector(".fleet-card")));
  function watchGrid(): void {
    const root = d.fleetGrid();
    if (root === gridRoot) return;
    gridObs?.disconnect();
    gridRoot = root;
    gridObs = null;
    if (!root) return;
    // Cards come, go and are rebuilt as the grid changes: one scan per frame, however many such mutations.
    gridObs = new MutationObserver((recs) => {
      if (gridQueued || !recs.some((r) => touchesCards(r.addedNodes) || touchesCards(r.removedNodes))) return;
      gridQueued = true;
      requestAnimationFrame(() => { gridQueued = false; syncLanes(); });
    });
    gridObs.observe(root, { childList: true, subtree: true });
  }
  function syncLanes(): void {
    const seen = new Set<string>();
    const root = gridRoot;
    if (settings.show && root && shown(root)) {
      for (const card of root.querySelectorAll<HTMLElement>(".fleet-card[data-lane]")) {
        const laneId = card.dataset.lane ?? "";
        const lane = laneById(laneId);
        const canvas = card.querySelector<HTMLElement>(".fleet-card-main");
        if (!lane?.cwd || !canvas) continue;
        const key = `lane:${laneId}`;
        seen.add(key);
        let b = buddies.get(key);
        if (b && (b.canvas !== canvas || normFolder(b.folder) !== normFolder(lane.cwd))) { dropBuddy(key); b = undefined; }
        b ??= makeBuddy(key, "lane", laneId, laneId, lane.cwd, canvas, card.querySelector<HTMLElement>(".fleet-compose"));
        paintBuddy(b);
        layoutAnchored(b);
      }
    }
    for (const [key, b] of buddies) if (b.where === "lane" && !seen.has(key)) dropBuddy(key);
  }

  // ── Agent Worlds ──
  function frameWorld(att: Attachment): void {
    att.raf = 0;
    if (!att.live) return;
    if (document.hidden || !shown(att.stage)) return; // resumed by visibilitychange or the next tick
    const s = att.stage.getBoundingClientRect();
    const seen = new Set<string>();
    if (settings.show) {
      for (const id of att.src.ids()) {
        const folder = att.src.folderOf(id);
        const laneId = att.src.laneOf(id);
        if (!folder || !laneId) continue;
        const key = `world:${id}`;
        seen.add(key);
        let b = buddies.get(key);
        if (b && (b.canvas !== att.stage || normFolder(b.folder) !== normFolder(folder) || b.laneId !== laneId)) { dropBuddy(key); b = undefined; }
        b ??= makeBuddy(key, "world", laneId, laneId, folder, att.stage, null);
        layoutWorld(b, att, id, s);
      }
    }
    for (const [key, b] of buddies) if (b.where === "world" && b.canvas === att.stage && !seen.has(key)) dropBuddy(key);
    att.raf = requestAnimationFrame(() => frameWorld(att));
  }
  const runWorld = (att: Attachment): void => { if (att.live && !att.raf) att.raf = requestAnimationFrame(() => frameWorld(att)); };
  const worldsShown = (): boolean => [...worlds].some((a) => a.live && shown(a.stage));

  function attachWorlds(stage: HTMLElement, src: WorldBuddySource): () => void {
    const att: Attachment = { stage, src, raf: 0, live: true };
    worlds.add(att);
    runWorld(att);
    lastLanePoll = 0;
    void tick();
    return () => {
      if (!att.live) return;
      att.live = false;
      if (att.raf) cancelAnimationFrame(att.raf);
      att.raf = 0;
      worlds.delete(att);
      for (const [key, b] of buddies) if (b.where === "world" && b.canvas === stage) dropBuddy(key);
    };
  }

  // ── clock ──
  async function pollLanes(): Promise<string[]> {
    lastLanePoll = Date.now();
    const st = await d.fleetStatus().catch(() => null);
    if (!st) return [];
    lanes = st.lanes.map((l) => ({ id: l.id, cwd: l.cwd, status: l.status, turns: l.turns, name: l.name }));
    const prev = laneMemo;
    const ended = prev ? lanes.filter((l) => laneTurnEnds(prev, [l]).ended.length > 0).map((l) => l.id) : [];
    laneMemo = laneTurnEnds(prev, lanes).next;
    return ended;
  }
  function syncAll(): void {
    settings = readBuddySettings(kv.getItem(BUDDY_SETTINGS_KEY));
    reloadDoc();
    watchGrid();
    syncMain();
    syncLanes();
    for (const b of buddies.values()) if (b.where === "world") paintBuddy(b);
    for (const att of worlds) runWorld(att);
    if (cur) {
      const line = pop.querySelector(".agr-ph-state");
      if (line && !ideasOf(cur.agent).reply?.doing) {
        line.classList.toggle("work", cur.st === "work");
        const span = line.querySelector("span");
        const txt = whereLine(cur);
        if (span && span.textContent !== txt) { span.textContent = txt; span.title = txt; }
      }
      placePop();
    }
  }
  let timer = 0;
  let ticking = false;
  async function tick(): Promise<void> {
    if (ticking) return; // a poll is in flight; its own reschedule follows
    ticking = true;
    if (timer) { clearTimeout(timer); timer = 0; }
    try {
      watchGrid();
      // Lanes are only polled while a lane buddy can be on screen (the Fleet grid or Agent Worlds).
      if (settings.show && !document.hidden && (gridShown() || worldsShown())) {
        const ended = Date.now() - lastLanePoll >= pollDelay(LANE_POLL_MS, d.perfTier(), false) ? await pollLanes() : [];
        syncAll();
        for (const id of ended) maybeAuto(id);
      } else {
        laneMemo = null; // a turn that ended while no lane buddy was showing is not news
        syncAll();
      }
    } finally {
      ticking = false;
      timer = window.setTimeout(() => void tick(), pollDelay(TICK_MS, d.perfTier(), document.hidden));
    }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void tick(); });
  void tick();

  return {
    sync: syncAll,
    noteTurnEnd(folder: string): void {
      const id = normFolder(folder);
      const main = d.getMainFolder();
      if (main && normFolder(main) === id) { mainTurns++; maybeAuto("main"); }
      // A lane's turn count comes from the next poll, which notices the end and fetches.
      if (lanes.some((l) => laneFolderIds(l.cwd).includes(id))) { lastLanePoll = 0; void tick(); }
    },
    attachWorlds,
  };
}
