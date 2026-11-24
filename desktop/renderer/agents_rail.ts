// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/agents_rail.ts - P-RAIL.AGENTS1: the collapsed inspector rail's Agents view.
//
// A mini Lucid toggle in the rail header (#railAgents, right of the expand button) flips the rail between the
// live metrics and your Agents (localStorage `lucid.rail.view`). Each Agent is a folder (agents_store.ts) shown
// as the metric tile's box holding a glass brick with a Lucid in the Agent's color (agents_rail_art.ts): typing
// while any agent works in that folder, meditating when idle, a short glance about once a minute, and the
// tile's racing-ring "changed" effect when a turn ends there. A click (or Enter) opens the hover module (also
// opened by a 140 ms hover): color, rename, Activate (three ways to start work in the folder, through the
// app's activateAgentFolder) and a two-step Remove with Undo. Agents reorder by drag (FLIP slide, the
// neighbors look at the moved box, the moved one looks around) or Alt+Arrow. Thin arrows page the list.
//
// The pure parts (module placement, scroll steps, drop slots, who looks where) are exported for unit tests;
// mountAgentsRail owns the DOM. Folder names and paths come from disk and are always escaped.

import {
  AGENTS_KEY, AGENT_PURPOSES, VIEW_KEY, addAgent, displayNames, type AgentPurpose, laneFolderIds, laneSourceFolders, laneTurnEnds, loadDoc, mergeSources,
  moveAgent, normFolder, recolorAgent, removeAgent, renameAgent, restoreAgent, saveDoc, workingFolders, isLaneBusy,
  NAME_MAX, type AgentRecord, type AgentsDoc, type LaneLike, type LaneMemo, type RailView, type ThemeKey,
} from "./agents_store.ts";
import { addArt, agentArt, agrIcon, paletteOf, paletteStyle, PRESETS, THEME_HUES, type AgentPalette, type ArtState } from "./agents_rail_art.ts";
import { esc } from "./format.ts";
import { baseTier, pollDelay, type PerfTier } from "./perf_tier.ts";
import type { FleetStatusView } from "./bridge.ts";
import type { ToastOpts } from "./ui.ts";
import type { JobsData, JobView } from "./jobs_view.ts";
import { agentJobs, DAY_NAMES, defaultTime, describeSchedule, fmtWhen, isoDay, jobName, nextRun, ONCE_MAX_DAYS, PROMPT_MAX, REPEATS, scheduleCron, scheduleSummary, type Repeat } from "./agent_schedule.ts";

export const DRAG_SLOP = 4;
export const HOVER_INTENT_MS = 140;
export const HOVER_GRACE_MS = 260;
export const NOTICE_MS = 2000;
export const RING_MS = 1600;
export const GLANCE_MS = 3300;
export const TURN_DEDUPE_MS = 4000;
export const SCROLL_STEP = 3;
const TICK_MS = 1000;
const LANE_POLL_MS = 2500;
/** P-FLEET.CONN1: how long one lane poll waits for the engine before it gives up. */
const FLEET_WAIT_MS = 8000;
/** P-PERF.IDLE1: how often a working figure's pose advances (see stepFigures). */
const STEP_FPS = 8;

export type ActivateKind = "takeover" | "fleet" | "world";
export type Eyes = "up" | "down" | "around";

export const readView = (raw: string | null | undefined): RailView => (raw === "agents" ? "agents" : "metrics");

// ── pure geometry ──────────────────────────────────────────────────────────────────────────────────────────

export interface Box { left: number; top: number; right: number; width: number; height: number }
export interface ModulePlace { x: number; y: number; side: "l" | "r"; nubX: number; nubY: number; maxH: number }

/** Where the hover module goes: left of its box (the rail is at the right edge), flipped right only when the
 *  left has no room, clamped inside the viewport; the nub points at the box center within the module's span. */
export function placeModule(box: Box, size: { w: number; h: number }, view: { w: number; h: number }, margin = 8, gap = 12): ModulePlace {
  const maxH = Math.max(120, view.h - 2 * margin);
  const h = Math.min(size.h, maxH), w = size.w;
  let side: "l" | "r" = "l";
  let x = box.left - gap - w;
  if (x < margin) {
    side = "r";
    x = box.right + gap;
    if (x + w > view.w - margin) { side = "l"; x = Math.max(margin, box.left - gap - w); }
  }
  x = Math.min(Math.max(x, margin), Math.max(margin, view.w - margin - w));
  const mid = box.top + box.height / 2;
  const y = Math.min(Math.max(mid - h / 2, margin), Math.max(margin, view.h - margin - h));
  const cy = Math.min(Math.max(mid, y + 18), y + h - 18);
  return { x, y, side, nubX: side === "l" ? x + w - 6.5 : x - 5.5, nubY: cy - 6, maxH };
}

const clampTop = (t: number, viewport: number, content: number): number => Math.min(Math.max(0, t), Math.max(0, content - viewport));

/** One arrow click: SCROLL_STEP Agents that way, snapped to whole boxes. */
export function scrollTarget(top: number, viewport: number, content: number, pitch: number, dir: 1 | -1, count = SCROLL_STEP): number {
  if (!(pitch > 0)) return clampTop(top, viewport, content);
  return clampTop((Math.round(top / pitch) + dir * count) * pitch, viewport, content);
}

/** A double-click: the next full page of Agents (as many whole boxes as fit) that way. */
export function pageTarget(top: number, viewport: number, content: number, pitch: number, gap: number, dir: 1 | -1): number {
  if (!(pitch > 0)) return clampTop(top, viewport, content);
  const per = Math.max(1, Math.floor((viewport + gap) / pitch));
  return clampTop((Math.round(top / pitch) + dir * per) * pitch, viewport, content);
}

export function arrowState(top: number, viewport: number, content: number): { up: boolean; down: boolean } {
  return { up: top > 1, down: top + viewport < content - 1 };
}

/** Drop slot for a dragged box: how many of the other boxes' centers lie above its center. */
export function slotFor(otherCenters: readonly number[], center: number): number {
  let n = 0;
  for (const c of otherCenters) if (c < center) n++;
  return n;
}

/** The boxes a move passed over (in the order before it). */
export function passedIds(before: readonly string[], after: readonly string[], moved: string): string[] {
  const from = before.indexOf(moved), to = after.indexOf(moved);
  if (from < 0 || to < 0 || from === to) return [];
  return to < from ? before.slice(to, from) : before.slice(from + 1, to + 1);
}

/** Who looks at the moved box and which way: the boxes it passed and the two it landed between. A box above
 *  the moved one looks down at it; one below looks up. */
export function lookDirs(after: readonly string[], moved: string, passed: readonly string[]): Map<string, "up" | "down"> {
  const out = new Map<string, "up" | "down">();
  const at = after.indexOf(moved);
  if (at < 0) return out;
  const near = new Set(passed);
  if (at > 0) near.add(after[at - 1]!);
  if (at < after.length - 1) near.add(after[at + 1]!);
  near.delete(moved);
  for (const id of near) {
    const i = after.indexOf(id);
    if (i >= 0) out.set(id, i < at ? "down" : "up");
  }
  return out;
}

/** About a minute between glances, jittered per Agent so the list never moves in unison. */
export function glanceDelay(rand: number, first: boolean): number {
  const r = Math.min(Math.max(Number(rand) || 0, 0), 1);
  return first ? 5000 + r * 50000 : 52000 + r * 16000;
}

/** A negative animation delay per folder, so idle loops do not breathe in step. */
export function loopDelay(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return -((h % 480) / 100);
}

// ── the mounted rail ───────────────────────────────────────────────────────────────────────────────────────

interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }

export interface AgentsRailDeps {
  inspector: HTMLElement;
  /** #railAgents in the rail header. */
  toggle: HTMLButtonElement;
  /** The empty container the view renders into (#railAgentsView, a sibling of #railTiles). */
  host: HTMLElement;
  /** WorkspaceInfo.recent, or null until the workspace has loaded (nothing is pruned before then). */
  getRecent(): readonly { path: string }[] | null;
  getMainFolder(): string | null;
  isMainBusy(): boolean;
  fleetStatus(): Promise<FleetStatusView | null>;
  pickFolder(): Promise<string | null>;
  toast(o: ToastOpts): () => void;
  activate(kind: ActivateKind, folder: string, name: string): Promise<{ ok: boolean; message?: string }>;
  /** P-SCHED.AGENT1: the engine's scheduled jobs (desktop/scheduled_jobs.ts); `changed` repaints the Jobs tile. */
  jobs: {
    list(): Promise<JobsData | null>;
    create(spec: Record<string, unknown>): Promise<JobView | null>;
    update(id: string, patch: Record<string, unknown>): Promise<JobView | null>;
    remove(id: string): Promise<unknown>;
    changed(): void;
  };
  perfTier(): PerfTier;
  storage?: KV;
}

export interface AgentsRail {
  view(): RailView;
  setView(v: RailView): void;
  /** First run on this version: land on Agents unless the user already chose a view. */
  adoptFirstRunDefault(): void;
  /** Re-read Main's folder, busy flag and the recents now (the rail also does this on its own clock). */
  sync(): void;
  /** A turn ended for an agent working in `folder`: that Agent's box plays the ring. */
  noteTurnEnd(folder: string): void;
}

function safeStorage(): KV {
  return {
    getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage off: the rail still works this session */ } },
  };
}

const reducedMotion = (): boolean => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Recolor in place: only the five palette variables change, so transient inline transforms survive. */
function applyPalette(el: HTMLElement, p: AgentPalette): void {
  for (const k of ["K", "D", "L", "G", "g"] as const) el.style.setProperty(`--${k}`, p[k]);
}

export function mountAgentsRail(d: AgentsRailDeps): AgentsRail {
  const kv = d.storage ?? safeStorage();
  let doc: AgentsDoc = loadDoc(kv.getItem(AGENTS_KEY));
  let view: RailView = readView(kv.getItem(VIEW_KEY));
  let lanes: LaneLike[] = [];
  let laneNames = new Map<string, string>();
  let lanesLoaded = false;
  let laneMemo: Map<string, LaneMemo> | null = null;
  let lastLanePoll = 0;
  let working = new Set<string>();
  let renderedSig = "";
  let dragging = false;
  let suppressClick = false;
  const lastRing = new Map<string, number>();
  let glanceTimer: number | undefined;
  const eyeTimers = new Map<string, number>();

  d.host.classList.add("agr-view");
  d.host.innerHTML = `<button class="agr-arrow agr-up" type="button" data-agr-up tabindex="-1" aria-label="Scroll Agents up">${agrIcon("up", 14)}</button>`
    + `<div class="agr-list" role="group" aria-label="Agents" data-agr-list></div>`
    + `<button class="agr-arrow agr-down" type="button" data-agr-down tabindex="-1" aria-label="Scroll Agents down">${agrIcon("down", 14)}</button>`;
  const list = d.host.querySelector("[data-agr-list]") as HTMLElement; // built just above
  const upBtn = d.host.querySelector("[data-agr-up]") as HTMLButtonElement;
  const downBtn = d.host.querySelector("[data-agr-down]") as HTMLButtonElement;

  const pop = document.createElement("div");
  pop.className = "popover agr-pop agent-pop";
  pop.setAttribute("role", "dialog");
  pop.tabIndex = -1;
  document.body.append(pop);
  const nub = document.createElement("div");
  nub.className = "agr-nub";
  nub.setAttribute("aria-hidden", "true");
  document.body.append(nub);

  const commit = (next: AgentsDoc): void => { if (next === doc) return; doc = next; kv.setItem(AGENTS_KEY, saveDoc(doc)); };
  const agentById = (id: string): AgentRecord | undefined => doc.agents.find((a) => a.id === id);
  const names = (): Map<string, string> => displayNames(doc.agents);
  const tiles = (): HTMLElement[] => [...list.querySelectorAll<HTMLElement>(".agr-tile[data-agent]")];
  const tileOf = (id: string): HTMLElement | undefined => tiles().find((t) => t.dataset.agent === id);
  const stateOf = (id: string): ArtState => (working.has(id) ? "work" : "idle");
  const active = (): boolean => view === "agents" && d.inspector.classList.contains("rail") && !document.hidden;
  const calm = (): boolean => baseTier(d.perfTier()) === "minimal";

  // ── view toggle ──
  function applyView(): void {
    const agents = view === "agents";
    d.inspector.classList.toggle("agents-view", agents);
    d.host.hidden = !agents;
    d.toggle.setAttribute("aria-pressed", String(agents));
    const tip = agents ? "Metrics|Back to the live metrics" : "Agents|Show your Agents: one Lucid per folder you work in";
    d.toggle.setAttribute("aria-label", agents ? "Show metrics" : "Show Agents");
    d.toggle.dataset.tip = tip;
  }
  function setView(v: RailView): void {
    if (v === view) return;
    if (v === "agents" && d.inspector.classList.contains("rail")) {
      // Keep the width the metrics view measured, so flipping never shifts the center column.
      const w = d.inspector.getBoundingClientRect().width;
      if (w > 0) d.inspector.style.setProperty("--agr-w", `${Math.round(w)}px`);
    }
    view = v;
    kv.setItem(VIEW_KEY, v);
    closeModule(false);
    laneMemo = null; // a turn that ended while the view was away is not news
    applyView();
    if (v === "agents") { renderedSig = ""; void tick(); }
  }
  d.toggle.addEventListener("click", () => { setView(view === "agents" ? "metrics" : "agents"); d.toggle.focus(); });

  // ── data ──
  async function pollLanes(): Promise<string[]> {
    lastLanePoll = Date.now();
    // P-FLEET.CONN1: a reply that never comes must not freeze the rail on the state of the last answer (two working
    // Agents shown idle for a whole turn); this poll gives up after FLEET_WAIT_MS and the next one asks again.
    const st = await Promise.race([d.fleetStatus().catch(() => null), new Promise<null>((r) => window.setTimeout(() => r(null), FLEET_WAIT_MS))]);
    if (!st) { lanesLoaded = true; return []; }
    lanes = st.lanes.map((l) => ({ id: l.id, cwd: l.cwd, status: l.status, turns: l.turns }));
    laneNames = new Map(st.lanes.map((l) => [l.id, l.name]));
    lanesLoaded = true;
    const { ended, next } = laneTurnEnds(laneMemo, lanes);
    laneMemo = next;
    return ended;
  }
  function sync(): void {
    const recent = d.getRecent();
    if (recent && lanesLoaded) {
      const next = mergeSources(doc, { main: d.getMainFolder(), recent, lanes: laneSourceFolders(lanes) });
      if (saveDoc(next) !== saveDoc(doc)) commit(next);
    }
    working = workingFolders({ folder: d.getMainFolder(), busy: d.isMainBusy() }, lanes);
    if (view === "agents") render();
    syncStepper();
  }

  // ── working figures, stepped ──
  // P-PERF.IDLE1: a working figure's CSS loops stay paused (styles.css) and this timer moves their clock (--dl) on at
  // STEP_FPS. A free-running loop makes Chromium draw 60 frames a second for as long as it runs: five working Agents
  // cost about 0.8 of a core in the renderer and GPU that way, and about a quarter of that stepped.
  let stepTimer = 0;
  let stepT = 0;
  function syncStepper(): void {
    const want = active() && working.size > 0 && !calm() && !reducedMotion();
    if (want && !stepTimer) stepTimer = window.setInterval(stepFigures, 1000 / STEP_FPS);
    else if (!want && stepTimer) { clearInterval(stepTimer); stepTimer = 0; }
  }
  function stepFigures(): void {
    if (!active()) { syncStepper(); return; }
    stepT += 1 / STEP_FPS;
    for (const t of list.querySelectorAll<HTMLElement>(".agr-tile.work")) {
      const v = `${(loopDelay(t.dataset.agent ?? "") - stepT).toFixed(3)}s`;
      t.style.setProperty("--dl", v);
      t.querySelector<SVGElement>(".agr-art")?.style.setProperty("--dl", v);
    }
  }
  let timer = 0;
  let ticking = false;
  async function tick(): Promise<void> {
    if (ticking) return; // a poll is in flight; its own reschedule follows
    ticking = true;
    if (timer) { clearTimeout(timer); timer = 0; }
    try {
      if (active()) {
        // P-FLEET.CONN1: who is working is information, not decoration, so a visible rail polls at LANE_POLL_MS on
        // every render tier. The frame governor caps the tier on a busy machine (exactly when several agents run),
        // and its x4 stretch left a working Agent shown idle for ten seconds and more.
        const due = !lanesLoaded || Date.now() - lastLanePoll >= LANE_POLL_MS;
        const ended = due ? await pollLanes() : [];
        sync();
        for (const f of ended) ring(f);
      } else laneMemo = null;
    } finally {
      ticking = false;
      timer = window.setTimeout(() => void tick(), pollDelay(TICK_MS, "full", document.hidden)); // hidden still backs off
    }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void tick(); });

  // ── render ──
  function tileHtml(a: AgentRecord, name: string): string {
    const st = stateOf(a.id);
    return `<div class="tile agent agr-tile${st === "work" ? " work" : ""}" role="button" tabindex="0" aria-haspopup="dialog" aria-label="${esc(name)}"`
      + ` data-agent="${esc(a.id)}" data-path="${esc(a.path)}" data-state="${st}" style="${paletteStyle(paletteOf(a))}">`
      + `<i class="agr-led" aria-hidden="true"></i>${agentArt(st, loopDelay(a.id))}<div class="l">${esc(name)}</div></div>`;
  }
  const sigOf = (n: Map<string, string>): string => doc.agents.map((a) => `${a.id}\u0001${n.get(a.id) ?? ""}`).join("\u0002");

  function render(): void {
    if (dragging) return;
    const n = names();
    const sig = sigOf(n);
    if (sig !== renderedSig) {
      const top = list.scrollTop;
      const focused = (document.activeElement as HTMLElement | null)?.closest?.(".agr-tile")?.getAttribute("data-agent") ?? null;
      list.innerHTML = doc.agents.map((a) => tileHtml(a, n.get(a.id) ?? a.path)).join("")
        + `<div class="tile agent agr-tile agr-add" role="button" tabindex="0" aria-label="Add a folder as an Agent" data-agr-add>${addArt()}<div class="l">add agent</div></div>`;
      list.scrollTop = top;
      renderedSig = sig;
      if (focused) tileOf(focused)?.focus({ preventScroll: true });
      if (cur) {
        const t = tileOf(cur.id);
        if (t) { cur.tile = t; t.classList.add("hot"); } else closeModule(false);
      }
    }
    for (const t of tiles()) {
      const a = agentById(t.dataset.agent ?? "");
      if (!a) continue;
      const p = paletteOf(a);
      if (t.style.getPropertyValue("--G") !== p.G || t.style.getPropertyValue("--K") !== p.K) applyPalette(t, p);
      const st = stateOf(a.id);
      if (t.dataset.state !== st) {
        t.dataset.state = st;
        t.classList.toggle("work", st === "work");
        const svg = t.querySelector(".agr-art");
        if (svg) svg.outerHTML = agentArt(st, loopDelay(a.id));
      }
    }
    d.host.classList.toggle("agr-calm", calm());
    syncGlances();
    updateArrows();
    if (cur) refreshModuleState();
  }

  // ── turn ring ──
  function ring(folder: string): void {
    const now = Date.now();
    for (const id of laneFolderIds(folder)) {
      if (now - (lastRing.get(id) ?? 0) < TURN_DEDUPE_MS) continue;
      const t = tileOf(id);
      if (!t) continue;
      lastRing.set(id, now);
      t.classList.remove("changed");
      void t.offsetWidth; // restart the one-shot animation
      t.classList.add("changed");
      window.setTimeout(() => t.classList.remove("changed"), RING_MS);
    }
  }

  // ── glances ──
  // P-PERF.IDLE1: ONE glance about once a minute for the whole rail, by a random idle Agent. A timer per Agent kept
  // ten Agents glancing for half of every minute, and every glance is a stretch of repainted frames.
  function syncGlances(): void {
    if (glanceTimer === undefined) scheduleGlance(true);
  }
  function scheduleGlance(first: boolean): void {
    glanceTimer = window.setTimeout(() => {
      glanceTimer = undefined;
      const idle = doc.agents.filter((a) => stateOf(a.id) === "idle");
      const pick = idle[Math.floor(Math.random() * idle.length)];
      if (pick && active() && !dragging && !reducedMotion() && baseTier(d.perfTier()) === "full") glance(pick.id);
      if (doc.agents.length) scheduleGlance(false);
    }, glanceDelay(Math.random(), first));
  }
  function glance(id: string): void {
    const t = tileOf(id);
    const svg = t?.querySelector(".agr-art");
    if (!t || !svg || t.dataset.eyes) return;
    svg.classList.remove("agr-glance");
    void t.offsetWidth;
    svg.classList.add("agr-glance");
    t.dataset.glance = "1";
    window.setTimeout(() => { svg.classList.remove("agr-glance"); delete t.dataset.glance; }, GLANCE_MS);
  }

  // ── eyes (drag "noticed" / "looks around") ──
  function setEyes(t: HTMLElement, eyes: Eyes | null, holdMs = 0): void {
    const id = t.dataset.agent ?? "";
    const h = eyeTimers.get(id);
    if (h) { clearTimeout(h); eyeTimers.delete(id); }
    if (eyes) t.dataset.eyes = eyes; else delete t.dataset.eyes;
    if (eyes && holdMs > 0) eyeTimers.set(id, window.setTimeout(() => { eyeTimers.delete(id); const n = tileOf(id); if (n) delete n.dataset.eyes; }, holdMs));
  }

  // ── scrolling ──
  const pitchOf = (): { pitch: number; gap: number } => {
    const ts = [...list.querySelectorAll<HTMLElement>(".agr-tile")];
    if (ts.length >= 2) { const p = ts[1]!.offsetTop - ts[0]!.offsetTop; return { pitch: p, gap: Math.max(0, p - ts[0]!.offsetHeight) }; }
    return { pitch: (ts[0]?.offsetHeight ?? 49) + 7, gap: 7 };
  };
  // A click during a smooth scroll steps from where that scroll is going, not from mid-flight.
  let goal = 0, goalAt = 0, preTop = 0, preAt = 0;
  const scrollListTo = (top: number): void => {
    goal = top; goalAt = Date.now();
    list.scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
  };
  function updateArrows(): void {
    const s = arrowState(Math.round(list.scrollTop), list.clientHeight, list.scrollHeight);
    upBtn.classList.toggle("agr-on", s.up);
    downBtn.classList.toggle("agr-on", s.down);
    upBtn.setAttribute("aria-hidden", String(!s.up));
    downBtn.setAttribute("aria-hidden", String(!s.down));
  }
  const arrow = (btn: HTMLButtonElement, dir: 1 | -1): void => {
    btn.addEventListener("click", (e) => {
      if (e.detail > 1) return; // the second click of a double-click: dblclick pages from where the first started
      preTop = Date.now() - goalAt < 600 ? goal : list.scrollTop;
      preAt = Date.now();
      const { pitch } = pitchOf();
      scrollListTo(scrollTarget(preTop, list.clientHeight, list.scrollHeight, pitch, dir));
    });
    btn.addEventListener("dblclick", () => {
      const { pitch, gap } = pitchOf();
      const from = Date.now() - preAt < 700 ? preTop : list.scrollTop; // a dblclick without its first click pages from here
      scrollListTo(pageTarget(from, list.clientHeight, list.scrollHeight, pitch, gap, dir));
    });
  };
  arrow(upBtn, -1);
  arrow(downBtn, 1);
  list.addEventListener("scroll", () => { updateArrows(); if (cur) place(); }, { passive: true });
  window.addEventListener("resize", () => { updateArrows(); if (cur) place(); });

  // ── reorder (drag and Alt+Arrow), with FLIP and the neighbors' eyes ──
  function finishMove(id: string, to: number, firstTops: Map<HTMLElement, number>, focusAfter: boolean): void {
    const before = doc.agents.map((a) => a.id);
    commit(moveAgent(doc, id, to));
    const after = doc.agents.map((a) => a.id);
    const addTile = list.querySelector(".agr-add");
    const byId = new Map(tiles().map((t) => [t.dataset.agent ?? "", t]));
    for (const t of byId.values()) { t.style.transition = "none"; t.style.transform = ""; t.classList.remove("agr-dragging"); }
    for (const a of after) { const t = byId.get(a); if (t) list.insertBefore(t, addTile); }
    renderedSig = sigOf(names());
    const animate = !reducedMotion() && !calm();
    for (const [t, top0] of firstTops) {
      const dy = top0 - t.getBoundingClientRect().top;
      if (animate && Math.abs(dy) > 0.5) t.style.transform = `translateY(${dy}px)`;
    }
    void list.offsetWidth;
    for (const t of byId.values()) { t.style.transition = ""; t.style.transform = ""; }
    const moved = byId.get(id);
    const dirs = lookDirs(after, id, passedIds(before, after, id));
    for (const t of byId.values()) {
      const a = t.dataset.agent ?? "";
      if (a === id) setEyes(t, "around", NOTICE_MS);
      else if (dirs.has(a)) setEyes(t, dirs.get(a)!, NOTICE_MS);
      else if (t.dataset.eyes) setEyes(t, null);
    }
    if (moved && focusAfter) { moved.focus({ preventScroll: true }); moved.scrollIntoView({ block: "nearest", behavior: animate ? "smooth" : "auto" }); }
    updateArrows();
  }

  interface Drag { id: string; tile: HTMLElement; from: number; slot: number; startY: number; startScroll: number; tops: number[]; h: number; pitch: number; all: HTMLElement[] }
  let drag: Drag | null = null;

  function startDrag(tile: HTMLElement, y: number): boolean {
    const all = tiles();
    const from = all.indexOf(tile);
    if (from < 0 || all.length < 2) return false;
    closeModule(false);
    clearTimeout(tOpen);
    dragging = true;
    const tops = all.map((t) => t.offsetTop);
    drag = { id: tile.dataset.agent ?? "", tile, from, slot: from, startY: y, startScroll: list.scrollTop, tops, h: tile.offsetHeight, pitch: pitchOf().pitch, all };
    list.classList.add("agr-sorting");
    tile.classList.add("agr-dragging");
    return true;
  }
  function dragMove(y: number): void {
    if (!drag) return;
    const r = list.getBoundingClientRect();
    if (y < r.top + 18) list.scrollTop -= 8; else if (y > r.bottom - 18) list.scrollTop += 8;
    const dy = y - drag.startY + (list.scrollTop - drag.startScroll);
    drag.tile.style.transform = `translateY(${dy}px)`;
    const center = drag.tops[drag.from]! + drag.h / 2 + dy;
    const others = drag.all.map((_, i) => i).filter((i) => i !== drag!.from);
    drag.slot = slotFor(others.map((i) => drag!.tops[i]! + drag!.h / 2), center);
    // The others slide out of the way; the two at the slot (and the ones passed) look at the moving box.
    const lo = Math.min(drag.from, drag.slot), hi = Math.max(drag.from, drag.slot);
    others.forEach((i, k) => {
      const t = drag!.all[i]!;
      const shift = i > drag!.from && k < drag!.slot ? -drag!.pitch : i < drag!.from && k >= drag!.slot ? drag!.pitch : 0;
      t.style.transform = shift ? `translateY(${shift}px)` : "";
      const near = k === drag!.slot - 1 || k === drag!.slot || (i >= lo && i <= hi);
      if (near) setEyes(t, drag!.tops[i]! + shift + drag!.h / 2 < center ? "down" : "up");
      else if (t.dataset.eyes) setEyes(t, null);
    });
  }
  function endDrag(): void {
    if (!drag) return;
    const d0 = drag;
    drag = null;
    const firstTops = new Map(d0.all.map((t) => [t, t.getBoundingClientRect().top]));
    list.classList.remove("agr-sorting");
    dragging = false;
    finishMove(d0.id, d0.slot, firstTops, true);
  }
  list.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || dragging) return;
    const tile = (e.target as Element).closest<HTMLElement>(".agr-tile[data-agent]");
    if (!tile) return;
    const ox = e.clientX, oy = e.clientY;
    let started = false;
    const move = (m: PointerEvent): void => {
      if (!started) {
        if (Math.abs(m.clientX - ox) < DRAG_SLOP && Math.abs(m.clientY - oy) < DRAG_SLOP) return;
        started = startDrag(tile, oy);
        if (!started) { off(); return; }
      }
      m.preventDefault();
      dragMove(m.clientY);
    };
    const up = (): void => {
      off();
      if (!started) return;
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 0);
      endDrag();
    };
    // On the window, like the fleet cards: a re-render or a lost capture must never strand a lifted box.
    const off = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });

  function keyMove(tile: HTMLElement, dir: 1 | -1): void {
    const all = tiles();
    const i = all.indexOf(tile);
    const to = i + dir;
    if (i < 0 || to < 0 || to >= all.length) return;
    finishMove(tile.dataset.agent ?? "", to, new Map(all.map((t) => [t, t.getBoundingClientRect().top])), true);
  }

  // ── add ──
  // "+ Add agent" opens a small popout beside its box (the same module shell as an Agent's): step 1 says what an
  // Agent is and that it lives in one folder, then picks that folder (a recent one in a click, or the folder
  // dialog); step 2 names it and asks what it is for (the workspace setup purposes). Nothing is added until Add.
  const addPop = document.createElement("div");
  addPop.className = "popover agr-pop agr-add-pop";
  addPop.setAttribute("role", "dialog");
  addPop.setAttribute("aria-label", "Add an Agent");
  addPop.tabIndex = -1;
  addPop.setAttribute("style", paletteStyle(paletteOf({ theme: "lucid", hue: 145 })));
  document.body.append(addPop);
  let adding: { tile: HTMLElement; path: string | null; purpose: AgentPurpose | null } | null = null;
  const PURPOSE_ICON: Record<AgentPurpose, "code" | "doc" | "search" | "spark"> = { app: "code", docs: "doc", analysis: "search", other: "spark" };

  function placeAdd(): void {
    if (!adding) return;
    addPop.style.maxHeight = `${Math.max(120, innerHeight - 16)}px`;
    const p = placeModule(adding.tile.getBoundingClientRect(), { w: addPop.offsetWidth, h: addPop.offsetHeight }, { w: innerWidth, h: innerHeight });
    addPop.style.left = `${Math.round(p.x)}px`;
    addPop.style.top = `${Math.round(p.y)}px`;
    addPop.dataset.side = p.side;
    nub.className = `agr-nub show ${p.side}`;
    nub.style.left = `${Math.round(p.nubX)}px`;
    nub.style.top = `${Math.round(p.nubY)}px`;
  }
  /** Recent folders that are not on the rail yet: one click makes them the new Agent's home. */
  function freshRecents(): { path: string; name: string }[] {
    const have = new Set(doc.agents.filter((a) => !doc.hidden.includes(a.id)).map((a) => a.id));
    const out: { path: string; name: string }[] = [];
    for (const r of d.getRecent() ?? []) {
      const id = normFolder(r.path);
      if (!id || have.has(id) || out.some((o) => normFolder(o.path) === id)) continue;
      out.push({ path: r.path, name: displayNames([{ id, path: r.path, name: null }]).get(id) ?? r.path });
      if (out.length === 3) break;
    }
    return out;
  }
  function introHtml(): string {
    const recents = freshRecents();
    return `<div class="agr-ph"><div class="agr-ph-art">${agentArt("idle", 0)}</div><div class="agr-ph-id">`
      + `<div class="agr-ph-name">Add an Agent</div><div class="agr-ph-state"><i></i><span>A mini Lucid for one folder</span></div></div></div>`
      + `<div class="cfg-sec agr-add-tx">`
      + `<p>An Agent is a mini Lucid that lives in one folder on this computer: an application's repo, a project, or a set of documents.</p>`
      + `<p>Everything it starts (taking over the main composer, a Fleet session, an Agent World session) works inside that folder, and its box here shows when any agent is working there.</p>`
      + `</div><div class="cfg-sec agr-acts">`
      + (recents.length ? `<div class="cfg-lbl"><span>Recent folders</span></div>` + recents.map((r) =>
        `<button class="ctx-it" type="button" data-add-path="${esc(r.path)}" title="${esc(r.path)}">${agrIcon("folder", 15)}<span class="agr-nm">${esc(r.name)}</span></button>`).join("") : "")
      + `<button class="ctx-it agr-add-pick" type="button" data-add-act="pick">${agrIcon("folder", 15)}<span class="agr-nm">Choose a folder…</span></button>`
      + `<div class="agr-add-row"><button class="btn-mini" type="button" data-add-act="cancel">Cancel</button></div>`
      + `<div class="agr-msg" data-add-msg role="status" hidden></div></div>`;
  }
  function kindHtml(path: string): string {
    const id = normFolder(path);
    const auto = displayNames([...doc.agents.filter((a) => a.id !== id), { id, path, name: null }]).get(id) ?? "";
    const kinds = AGENT_PURPOSES.map((k) =>
      `<button class="ctx-it agr-kind" type="button" data-add-kind="${k.purpose}" aria-pressed="${adding?.purpose === k.purpose}">`
      + `<span class="agr-ic">${agrIcon(PURPOSE_ICON[k.purpose], 15)}</span><span class="agr-nm">${esc(k.label)}</span></button>`).join("");
    return `<div class="agr-ph"><div class="agr-ph-art">${agentArt("idle", 0)}</div><div class="agr-ph-id">`
      + `<input class="agr-ph-name-in" data-add-name maxlength="${NAME_MAX}" value="${esc(auto)}" aria-label="Agent name" spellcheck="false">`
      + `<div class="agr-ph-path" title="${esc(path)}">${esc(path)}</div></div></div>`
      + `<div class="cfg-sec agr-acts"><div class="cfg-lbl"><span>What will this Agent do?</span></div>${kinds}`
      + `<div class="agr-add-row"><button class="btn-mini" type="button" data-add-act="back">${agrIcon("back", 13)}Back</button>`
      + `<button class="btn-mini ok" type="button" data-add-act="add"${adding?.purpose ? "" : " disabled"}>Add agent</button></div>`
      + `<div class="agr-msg" data-add-msg role="status" hidden></div></div>`;
  }
  function paintAdd(): void {
    if (!adding) return;
    addPop.innerHTML = adding.path ? kindHtml(adding.path) : introHtml();
    placeAdd();
  }
  function openAdd(tile: HTMLElement): void {
    closeModule(false);
    adding = { tile, path: null, purpose: null };
    tile.classList.add("hot");
    paintAdd();
    addPop.classList.add("show");
    placeAdd();
    window.setTimeout(() => addPop.querySelector<HTMLElement>("[data-add-path], [data-add-act='pick']")?.focus({ preventScroll: true }), 0);
  }
  function closeAdd(refocus: boolean): void {
    if (!adding) return;
    const t = adding.tile;
    t.classList.remove("hot");
    adding = null;
    addPop.classList.remove("show");
    nub.classList.remove("show");
    if (refocus && t.isConnected) t.focus({ preventScroll: true });
  }
  function choosePath(path: string): void {
    if (!adding) return;
    adding.path = path;
    paintAdd();
    window.setTimeout(() => addPop.querySelector<HTMLElement>("[data-add-kind]")?.focus({ preventScroll: true }), 0);
  }
  async function pickInto(): Promise<void> {
    const p = await d.pickFolder().catch(() => null);
    if (p && adding) choosePath(p);
  }
  function finishAdd(): void {
    if (!adding?.path || !adding.purpose) return;
    const path = adding.path;
    const typed = addPop.querySelector<HTMLInputElement>("[data-add-name]")?.value ?? "";
    const id = normFolder(path);
    const auto = displayNames([...doc.agents.filter((a) => a.id !== id), { id, path, name: null }]).get(id) ?? "";
    commit(addAgent(doc, path, { name: typed.trim() && typed.trim() !== auto ? typed : null, purpose: adding.purpose }));
    const label = AGENT_PURPOSES.find((k) => k.purpose === adding?.purpose)?.label ?? "";
    closeAdd(false);
    render();
    scrollListTo(0);
    const name = names().get(id) ?? path;
    d.toast({ tone: "ok", title: `${name} is on your rail`, desc: `${label}. Hover it to color it, or Activate it to start working in its folder.`, timeout: 6000 });
    window.setTimeout(() => tileOf(id)?.focus({ preventScroll: true }), 0);
  }
  addPop.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button");
    if (!b || !adding) return;
    if (b.dataset.addPath) { choosePath(b.dataset.addPath); return; }
    if (b.dataset.addKind) {
      adding.purpose = b.dataset.addKind as AgentPurpose; // only AGENT_PURPOSES keys are rendered
      addPop.querySelectorAll<HTMLElement>("[data-add-kind]").forEach((k) => k.setAttribute("aria-pressed", String(k.dataset.addKind === adding?.purpose)));
      const go = addPop.querySelector<HTMLButtonElement>("[data-add-act='add']");
      if (go) go.disabled = false;
      return;
    }
    switch (b.dataset.addAct) {
      case "pick": void pickInto(); return;
      case "cancel": closeAdd(true); return;
      case "back": adding.path = null; adding.purpose = null; paintAdd(); return;
      case "add": finishAdd(); return;
    }
  });
  // The name field starts on the folder's auto name: focusing it selects it, so typing replaces it.
  addPop.addEventListener("focusin", (e) => { if ((e.target as HTMLElement).matches("[data-add-name]")) (e.target as HTMLInputElement).select(); });
  addPop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeAdd(true); return; }
    if (e.key === "Enter" && (e.target as HTMLElement).matches("[data-add-name]")) { e.preventDefault(); finishAdd(); }
  });
  document.addEventListener("pointerdown", (e) => {
    if (adding && !(e.target instanceof Element && e.target.closest(".agr-add-pop, [data-agr-add]"))) closeAdd(false);
  }, true);
  function addFolder(tile?: HTMLElement): void {
    const t = tile ?? list.querySelector<HTMLElement>("[data-agr-add]");
    if (!t) return;
    if (adding) { closeAdd(true); return; }
    openAdd(t);
  }

  // ── hover module ──
  interface Cur { id: string; tile: HTMLElement; locked: boolean }
  let cur: Cur | null = null;
  /** P-SCHED.AGENT1: the engine's jobs as last read (refreshed when a module opens). */
  let jobsCache: JobView[] = [];
  let tOpen = 0, tClose = 0;

  function whereLine(id: string): string {
    if (!working.has(id)) return "Meditating · idle";
    const main = d.getMainFolder();
    if (d.isMainBusy() && main && normFolder(main) === id) return "Typing · Main composer";
    const lane = lanes.find((l) => isLaneBusy(l.status) && laneFolderIds(l.cwd).includes(id));
    return `Typing · ${lane ? `Fleet lane ${laneNames.get(lane.id) ?? lane.id}` : "an agent"}`;
  }
  function moduleHtml(a: AgentRecord, name: string, expanded: boolean): string {
    const p = paletteOf(a);
    const st = stateOf(a.id);
    const sw = PRESETS.map((t) => `<button type="button" data-sw="${t.key}" style="--sg:${t.palette.G};--sk:${t.palette.K}" aria-label="${esc(t.palette.name)}" title="${esc(t.palette.name)}" aria-pressed="${a.theme === t.key}"></button>`).join("");
    const go = (k: ActivateKind, icon: "chat" | "fleet" | "world", t: string, s: string): string =>
      `<button class="ctx-it" type="button" data-go="${k}"><span class="agr-ic">${agrIcon(icon, 15)}</span><span class="agr-tx"><b>${t}</b><i>${s}</i></span></button>`;
    return `<div class="agr-ph"><div class="agr-ph-art">${agentArt(st, loopDelay(a.id))}</div><div class="agr-ph-id">`
      + `<div class="agr-ph-name" title="${esc(name)}">${esc(name)}</div>`
      + `<div class="agr-ph-path" title="${esc(a.path)}">${esc(a.path)}</div>`
      + (a.purpose ? `<div class="agr-ph-kind">${esc(AGENT_PURPOSES.find((k) => k.purpose === a.purpose)?.line ?? "")}</div>` : "")
      + `<div class="agr-ph-state${st === "work" ? " work" : ""}" data-agr-state><i></i><span>${esc(whereLine(a.id))}</span></div></div></div>`
      + `<div class="cfg-sec"><div class="cfg-lbl"><span>Color</span><span class="cur" data-cur>${esc(p.name)}</span></div>`
      + `<input class="agr-hue" type="range" min="0" max="359" step="1" value="${p.hue}" aria-label="Agent color hue" data-agr-hue>`
      + `<div class="agr-sw" role="group" aria-label="Color presets">${sw}</div></div>`
      + `<div class="cfg-sec agr-acts">`
      + `<button class="ctx-it" type="button" data-act="rename">${agrIcon("pencil", 15)}<span class="agr-nm">Rename</span></button>`
      + `<button class="ctx-it" type="button" data-act="activate" aria-expanded="${expanded}">${agrIcon("play", 15)}<span class="agr-nm">Activate</span>${agrIcon("chev", 14, "agr-chev")}</button>`
      + `<div class="agr-sub${expanded ? " open" : ""}" role="group" aria-label="Activate">`
      + go("takeover", "chat", "Take over main composer", "Main moves to this folder")
      + go("fleet", "fleet", "Start new Fleet session", "A fresh lane in this folder")
      + go("world", "world", "Agent World session", "A lane plus its Agent Worlds prompt")
      // P-SCHED.AGENT1: run this Agent later, or on a repeat, with instructions (the engine's scheduled jobs).
      + `<button class="ctx-it" type="button" data-act="schedule"><span class="agr-ic">${agrIcon("clock", 15)}</span>`
      + `<span class="agr-tx"><b>Schedule this Agent</b><i data-sched-sum>${esc(scheduleSummary(agentJobs(jobsCache, a.path), Date.now()))}</i></span></button>`
      + `</div><div class="agr-rm" data-agr-rm>${removeButton()}</div>`
      + `<div class="agr-msg" data-ap-msg role="status" hidden></div></div>`;
  }
  const removeButton = (): string => `<button class="ctx-it" type="button" data-act="remove">${agrIcon("trash", 15)}<span class="agr-nm">Remove from rail</span></button>`;

  function place(): void {
    if (!cur) return;
    if (!cur.tile.isConnected) { const t = tileOf(cur.id); if (!t) { closeModule(false); return; } cur.tile = t; }
    pop.style.maxHeight = `${Math.max(120, innerHeight - 16)}px`;
    const p = placeModule(cur.tile.getBoundingClientRect(), { w: pop.offsetWidth, h: pop.offsetHeight }, { w: innerWidth, h: innerHeight });
    pop.style.left = `${Math.round(p.x)}px`;
    pop.style.top = `${Math.round(p.y)}px`;
    pop.style.transformOrigin = p.side === "l" ? "100% 50%" : "0 50%";
    pop.dataset.side = p.side;
    nub.className = `agr-nub show ${p.side}`;
    nub.style.left = `${Math.round(p.nubX)}px`;
    nub.style.top = `${Math.round(p.nubY)}px`;
  }
  function openModule(tile: HTMLElement, expanded: boolean): void {
    clearTimeout(tClose); clearTimeout(tOpen);
    const id = tile.dataset.agent ?? "";
    const a = agentById(id);
    if (!a || dragging) return;
    if (adding) closeAdd(false);
    if (cur && cur.id === id) {
      if (expanded) setActivateOpen(true);
      return;
    }
    if (cur) cur.tile.classList.remove("hot");
    cur = { id, tile, locked: false };
    tile.classList.add("hot");
    const name = names().get(id) ?? a.path;
    pop.setAttribute("style", paletteStyle(paletteOf(a)));
    pop.setAttribute("aria-label", `Agent ${name}`);
    sched = null;
    pop.innerHTML = moduleHtml(a, name, expanded);
    pop.classList.add("show");
    place();
    void loadJobs(); // P-SCHED.AGENT1: the Schedule item's line says what is scheduled
  }
  function closeModule(refocus: boolean): void {
    clearTimeout(tOpen); clearTimeout(tClose);
    if (!cur) return;
    const t = cur.tile;
    t.classList.remove("hot");
    cur = null;
    sched = null;
    pop.classList.remove("show");
    nub.classList.remove("show");
    if (refocus && t.isConnected) t.focus({ preventScroll: true });
  }
  function setActivateOpen(open: boolean): void {
    const sub = pop.querySelector(".agr-sub");
    const b = pop.querySelector('[data-act="activate"]');
    sub?.classList.toggle("open", open);
    b?.setAttribute("aria-expanded", String(open));
    place();
  }
  function refreshModuleState(): void {
    if (!cur) return;
    const a = agentById(cur.id);
    if (!a) { closeModule(false); return; }
    const st = stateOf(a.id);
    const line = pop.querySelector("[data-agr-state]");
    if (line) {
      line.classList.toggle("work", st === "work");
      const span = line.querySelector("span");
      const txt = whereLine(a.id);
      if (span && span.textContent !== txt) span.textContent = txt;
    }
    const art = pop.querySelector(".agr-ph-art");
    if (art && !art.querySelector(`.agr-${st}`)) art.innerHTML = agentArt(st, loopDelay(a.id));
  }
  function refreshColor(a: AgentRecord): void {
    const p = paletteOf(a);
    const t = tileOf(a.id);
    if (t) applyPalette(t, p);
    if (cur?.id === a.id) {
      applyPalette(pop, p);
      const c = pop.querySelector("[data-cur]");
      if (c) c.textContent = p.name;
      pop.querySelectorAll<HTMLElement>("[data-sw]").forEach((b) => b.setAttribute("aria-pressed", String(a.theme === b.dataset.sw)));
    }
  }
  function showMsg(text: string, ok = false): void {
    const m = pop.querySelector<HTMLElement>("[data-ap-msg]");
    if (!m) return;
    m.textContent = text;
    m.hidden = !text;
    m.classList.toggle("ok", ok);
    place();
  }

  function startRename(): void {
    const box = pop.querySelector(".agr-ph-name");
    if (!box || !cur) return;
    const a = agentById(cur.id);
    if (!a) return;
    cur.locked = true;
    const id = a.id;
    const inp = document.createElement("input");
    inp.className = "agr-ph-name-in";
    inp.value = a.name ?? names().get(id) ?? "";
    inp.maxLength = NAME_MAX;
    inp.setAttribute("aria-label", "Agent name");
    inp.dataset.agrRename = "1";
    box.replaceWith(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      if (save && inp.value.trim() !== (names().get(id) ?? "")) { commit(renameAgent(doc, id, inp.value)); render(); }
      const nm = names().get(id) ?? a.path;
      const div = document.createElement("div");
      div.className = "agr-ph-name";
      div.title = nm;
      div.textContent = nm;
      if (inp.isConnected) inp.replaceWith(div);
      if (cur?.id === id) { cur.locked = false; pop.setAttribute("aria-label", `Agent ${nm}`); }
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); pop.querySelector<HTMLElement>('[data-act="rename"]')?.focus(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); pop.querySelector<HTMLElement>('[data-act="rename"]')?.focus(); }
    });
    inp.addEventListener("blur", () => finish(true));
  }

  async function runActivate(kind: ActivateKind): Promise<void> {
    if (!cur) return;
    const a = agentById(cur.id);
    if (!a) return;
    const name = names().get(a.id) ?? a.path;
    const fail = (e: unknown): { ok: boolean; message?: string } => ({ ok: false, message: e instanceof Error ? e.message : String(e) });
    // Every choice gets out of the way at once: the take-over confirm docks over the composer, the Fleet card or the
    // Agent Worlds panel opens right away while the agent loads (a real agent can take a minute), and the app's own
    // toasts say what is happening. A failure brings the module back on its box with the reason, or a toast when
    // the user has moved on.
    const tile = cur.tile;
    closeModule(false);
    const r = await d.activate(kind, a.path, name).catch(fail);
    void tick();
    if (r.ok) return;
    const fallback = kind === "takeover" ? "Main did not move to this folder." : "That session could not start.";
    const t = tile.isConnected ? tile : tileOf(a.id);
    if (!t || cur) { d.toast({ tone: "warn", title: kind === "takeover" ? "Could not take over the main composer" : `${name}: the session did not start`, desc: r.message || fallback, timeout: 8000 }); return; }
    openModule(t, true);
    showMsg(r.message || fallback);
  }

  // ── P-SCHED.AGENT1: Schedule this Agent ──
  // The module turns into a short form: when (once on a date, daily, weekdays, chosen days, or a day of the month), the
  // time of day, and the instructions or goal. Saving writes one engine scheduled job that targets this Agent's folder
  // (the engine wakes or starts a lane there at that time); the Agent's existing schedules are listed above the form,
  // each with pause / resume and delete. The Jobs tile on the metrics rail shows them all.
  interface SchedDraft { repeat: Repeat; time: string; date: string; days: number[]; dom: number; prompt: string; auto: boolean }
  let sched: SchedDraft | null = null;
  async function loadJobs(): Promise<void> {
    const data = await d.jobs.list().catch(() => null);
    if (!data) return;
    jobsCache = data.jobs;
    const a = cur ? agentById(cur.id) : undefined;
    if (!a) return;
    const sum = pop.querySelector<HTMLElement>("[data-sched-sum]");
    if (sum) sum.textContent = scheduleSummary(agentJobs(jobsCache, a.path), Date.now());
    if (sched) paintSchedList(a);
  }
  const schedFields = (s: SchedDraft): string => {
    const now = Date.now();
    if (s.repeat === "once") return `<label class="agr-field"><span>Date</span><input type="date" data-sched-date value="${esc(s.date)}" min="${isoDay(now)}" max="${isoDay(now, ONCE_MAX_DAYS)}"></label>`;
    if (s.repeat === "weekly") {
      return `<div class="agr-field"><span>Days</span><div class="agr-days" role="group" aria-label="Days of the week">`
        + DAY_NAMES.map((n, i) => `<button type="button" class="agr-day" data-sched-day="${i}" aria-pressed="${s.days.includes(i)}">${n}</button>`).join("") + `</div></div>`;
    }
    if (s.repeat === "monthly") {
      return `<label class="agr-field"><span>Day of the month</span><select data-sched-dom>`
        + Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}"${s.dom === i + 1 ? " selected" : ""}>${i + 1}</option>`).join("") + `</select></label>`;
    }
    return "";
  };
  function schedHtml(a: AgentRecord, name: string): string {
    const s = sched!;
    return `<div class="agr-ph"><div class="agr-ph-art">${agentArt(stateOf(a.id), loopDelay(a.id))}</div><div class="agr-ph-id">`
      + `<div class="agr-ph-name" title="${esc(name)}">${esc(name)}</div><div class="agr-ph-path" title="${esc(a.path)}">${esc(a.path)}</div></div></div>`
      + `<div class="cfg-sec agr-sched"><div class="cfg-lbl"><span>Schedule this Agent</span></div>`
      + `<div class="agr-sj-list" data-sched-list></div>`
      + `<div class="agr-seg" role="radiogroup" aria-label="Repeat">`
      + REPEATS.map((r) => `<button type="button" role="radio" class="agr-seg-b" data-sched-repeat="${r.key}" aria-checked="${s.repeat === r.key}">${r.label}</button>`).join("") + `</div>`
      + `<div data-sched-fields>${schedFields(s)}</div>`
      + `<label class="agr-field"><span>Time of day</span><input type="time" data-sched-time value="${esc(s.time)}"></label>`
      + `<label class="agr-field"><span>Instructions or goal</span><textarea data-sched-prompt rows="4" maxlength="${PROMPT_MAX}" placeholder="What should it do, and what counts as done?">${esc(s.prompt)}</textarea></label>`
      + `<label class="agr-check"><input type="checkbox" data-sched-auto${s.auto ? " checked" : ""}><span>Approve its tool calls on its own during the run</span></label>`
      + `<p class="agr-sched-note" data-sched-note></p>`
      + `<div class="agr-add-row"><button class="btn-mini" type="button" data-act="sched-back">${agrIcon("back", 13)}Back</button>`
      + `<button class="btn-mini ok" type="button" data-act="sched-save">Save schedule</button></div>`
      + `<div class="agr-msg" data-ap-msg role="status" hidden></div></div>`;
  }
  function paintSchedList(a: AgentRecord): void {
    const box = pop.querySelector<HTMLElement>("[data-sched-list]");
    if (!box) return;
    const now = Date.now();
    const mine = agentJobs(jobsCache, a.path);
    box.innerHTML = mine.map((j) => {
      const live = j.armed && !j.suspended;
      const when = j.suspended ? j.suspended : live && j.nextFireAt ? `Next ${fmtWhen(j.nextFireAt)}` : j.once && !j.armed && j.lastRunAt ? `${j.lastOutcome === "cancelled" ? "Missed (LUCID was closed)" : "Ran"} ${fmtWhen(j.lastRunAt)}` : "Paused";
      return `<div class="agr-sj${live ? "" : " off"}" data-sj="${esc(j.id)}"><div class="agr-sj-tx">`
        + `<b title="${esc(j.prompt)}">${esc(describeSchedule(j.cron, j.once === true, now))}</b><i title="${esc(when)}">${esc(when)}</i></div>`
        + (j.once && !j.armed && j.lastRunAt ? "" : `<button type="button" class="agr-sj-b" data-sj-toggle="${esc(j.id)}" aria-label="${live ? "Pause" : "Resume"} this schedule" title="${live ? "Pause" : "Resume"}">${agrIcon(live ? "pause" : "play", 13)}</button>`)
        + `<button type="button" class="agr-sj-b" data-sj-del="${esc(j.id)}" aria-label="Delete this schedule" title="Delete">${agrIcon("trash", 13)}</button></div>`;
    }).join("");
    box.hidden = !mine.length;
    place();
  }
  function paintSchedNote(): void {
    const n = pop.querySelector<HTMLElement>("[data-sched-note]");
    if (!n || !sched) return;
    const now = Date.now();
    const c = scheduleCron(sched, now);
    if (!c.ok) { n.textContent = c.reason; n.classList.add("warn"); return; }
    n.classList.remove("warn");
    const next = nextRun(c.cron, now);
    n.textContent = `${describeSchedule(c.cron, c.once, now)}.${next && !c.once ? ` Next: ${fmtWhen(next)}.` : ""} LUCID must be open then (minimized is fine).`;
  }
  function openSchedule(): void {
    if (!cur) return;
    const a = agentById(cur.id);
    if (!a) return;
    const now = Date.now();
    sched ??= { repeat: "daily", time: defaultTime(now), date: isoDay(now, 1), days: [1, 2, 3, 4, 5], dom: Math.min(28, new Date(now).getDate()), prompt: "", auto: false };
    cur.locked = true; // a form is open: hovering away must not close it
    pop.innerHTML = schedHtml(a, names().get(a.id) ?? a.path);
    paintSchedList(a);
    paintSchedNote();
    place();
    pop.querySelector<HTMLElement>("[data-sched-prompt]")?.focus({ preventScroll: true });
    void loadJobs();
  }
  function closeSchedule(): void {
    if (!cur) return;
    const a = agentById(cur.id);
    sched = null;
    cur.locked = false;
    if (!a) { closeModule(false); return; }
    pop.innerHTML = moduleHtml(a, names().get(a.id) ?? a.path, true);
    place();
    pop.querySelector<HTMLElement>('[data-act="schedule"]')?.focus({ preventScroll: true });
  }
  async function saveSchedule(): Promise<void> {
    if (!cur || !sched) return;
    const a = agentById(cur.id);
    if (!a) return;
    const prompt = sched.prompt.trim();
    const c = scheduleCron(sched, Date.now());
    if (!c.ok) { showMsg(c.reason); return; }
    if (!prompt) { showMsg("Write what it should do: the instructions or the goal."); pop.querySelector<HTMLElement>("[data-sched-prompt]")?.focus(); return; }
    const name = names().get(a.id) ?? a.path;
    const save = pop.querySelector<HTMLButtonElement>('[data-act="sched-save"]');
    if (save) save.disabled = true;
    const job = await d.jobs.create({ name: jobName(name, prompt), prompt, target: { name, cwd: a.path }, cron: c.cron, once: c.once, armed: true, autoApprove: sched.auto, missed: "run-once" }).catch(() => null);
    if (save) save.disabled = false;
    if (!job) { showMsg("The engine did not accept that schedule. Check the time and try again."); return; }
    sched.prompt = "";
    const ta = pop.querySelector<HTMLTextAreaElement>("[data-sched-prompt]");
    if (ta) ta.value = "";
    showMsg(`Scheduled: ${describeSchedule(job.cron, job.once === true, Date.now())}.`, true);
    d.jobs.changed();
    await loadJobs();
  }

  function confirmRemove(): void {
    const box = pop.querySelector("[data-agr-rm]");
    if (!box) return;
    box.innerHTML = `<div class="agr-confirm"><span class="agr-confirm-q">Remove?</span>`
      + `<button class="agr-yes" type="button" data-act="remove-yes">Yes</button>`
      + `<button class="agr-no" type="button" data-act="remove-no">Cancel</button></div>`;
    box.querySelector<HTMLElement>('[data-act="remove-no"]')?.focus();
    place();
  }
  function doRemove(): void {
    if (!cur) return;
    const id = cur.id;
    const name = names().get(id) ?? id;
    const all = tiles();
    const i = all.findIndex((t) => t.dataset.agent === id);
    const r = removeAgent(doc, id);
    if (!r.removed) return;
    const removed = r.removed;
    closeModule(false);
    commit(r.doc);
    render();
    const next = tiles()[Math.min(Math.max(0, i), tiles().length - 1)];
    (next ?? d.toggle).focus({ preventScroll: true });
    d.toast({
      tone: "info", title: "Agent removed", desc: `${name} is off the rail. Add its folder again any time.`, timeout: 6000,
      actions: [{ label: "Undo", run: () => { commit(restoreAgent(doc, removed)); render(); } }],
    });
  }

  pop.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button");
    if (!b || !cur) return;
    const a = agentById(cur.id);
    if (!a) return;
    if (b.dataset.sw) {
      const k = b.dataset.sw as ThemeKey; // only our own PRESETS keys are rendered into data-sw
      commit(recolorAgent(doc, a.id, { theme: k }));
      const hue = pop.querySelector<HTMLInputElement>("[data-agr-hue]");
      if (hue) hue.value = String(THEME_HUES[k]);
      const next = agentById(a.id);
      if (next) refreshColor(next);
      return;
    }
    // P-SCHED.AGENT1: the schedule form's own controls.
    if (sched) {
      const ds = b.dataset;
      if (ds.schedRepeat) {
        sched.repeat = ds.schedRepeat as Repeat; // only REPEATS keys are rendered into data-sched-repeat
        pop.querySelectorAll<HTMLElement>("[data-sched-repeat]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
        const f = pop.querySelector<HTMLElement>("[data-sched-fields]");
        if (f) f.innerHTML = schedFields(sched);
        paintSchedNote();
        place();
        return;
      }
      if (ds.schedDay !== undefined) {
        const day = Number(ds.schedDay);
        sched.days = sched.days.includes(day) ? sched.days.filter((x) => x !== day) : [...sched.days, day];
        b.setAttribute("aria-pressed", String(sched.days.includes(day)));
        paintSchedNote();
        return;
      }
      if (ds.sjToggle || ds.sjDel) {
        const id = ds.sjToggle ?? ds.sjDel ?? "";
        const j = jobsCache.find((x) => x.id === id);
        void (async () => {
          if (ds.sjDel) await d.jobs.remove(id).catch(() => null);
          else if (j) await d.jobs.update(id, { armed: !(j.armed && !j.suspended) }).catch(() => null);
          d.jobs.changed();
          await loadJobs();
        })();
        return;
      }
    }
    switch (b.dataset.act) {
      case "schedule": openSchedule(); return;
      case "sched-back": closeSchedule(); return;
      case "sched-save": void saveSchedule(); return;
      case "rename": startRename(); return;
      case "activate": setActivateOpen(b.getAttribute("aria-expanded") !== "true"); return;
      case "remove": confirmRemove(); return;
      case "remove-no": {
        const box = pop.querySelector("[data-agr-rm]");
        if (box) { box.innerHTML = removeButton(); box.querySelector<HTMLElement>("button")?.focus(); }
        place();
        return;
      }
      case "remove-yes": doRemove(); return;
    }
    const go = b.dataset.go;
    if (go === "takeover" || go === "fleet" || go === "world") void runActivate(go);
  });
  pop.addEventListener("input", (e) => {
    const t = e.target as HTMLElement;
    if (sched && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) {
      if (t.matches("[data-sched-time]")) sched.time = t.value;
      else if (t.matches("[data-sched-date]")) sched.date = t.value;
      else if (t.matches("[data-sched-dom]")) sched.dom = Number(t.value);
      else if (t.matches("[data-sched-prompt]")) { sched.prompt = t.value; return; }
      else if (t instanceof HTMLInputElement && t.matches("[data-sched-auto]")) { sched.auto = t.checked; return; }
      else return;
      paintSchedNote();
      return;
    }
    if (!cur || !(t instanceof HTMLInputElement) || !t.matches("[data-agr-hue]")) return;
    commit(recolorAgent(doc, cur.id, { hue: Number(t.value) }));
    const a = agentById(cur.id);
    if (a) refreshColor(a);
  });

  // Hover intent: open after 140 ms, close after a 260 ms grace so the pointer can cross the gap.
  const zone = (n: EventTarget | null): Element | null => (n instanceof Element ? n.closest(".agr-tile[data-agent], .agr-pop") : null);
  list.addEventListener("pointerover", (e) => {
    if (dragging) return;
    const t = (e.target as Element).closest<HTMLElement>(".agr-tile[data-agent]");
    if (!t) return;
    clearTimeout(tClose);
    if (cur && cur.tile === t) return;
    clearTimeout(tOpen);
    tOpen = window.setTimeout(() => openModule(t, false), HOVER_INTENT_MS);
  });
  pop.addEventListener("pointerover", () => { clearTimeout(tClose); clearTimeout(tOpen); });
  const leave = (e: PointerEvent): void => {
    const from = zone(e.target);
    if (!from) return;
    const to = zone(e.relatedTarget);
    if (to === from) return;
    clearTimeout(tOpen);
    if (to || !cur || cur.locked) return;
    tClose = window.setTimeout(() => { if (cur && !cur.locked && !pop.contains(document.activeElement)) closeModule(false); }, HOVER_GRACE_MS);
  };
  list.addEventListener("pointerout", leave);
  pop.addEventListener("pointerout", leave);
  document.addEventListener("pointerdown", (e) => {
    if (cur && !(e.target instanceof Element && e.target.closest(".agr-pop, .agr-tile[data-agent]"))) closeModule(false);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !cur) return;
    if (e.target instanceof HTMLElement && e.target.dataset.agrRename) return; // the rename field cancels itself
    e.preventDefault();
    e.stopPropagation();
    closeModule(true);
  }, true);

  list.addEventListener("click", (e) => {
    if (suppressClick) return;
    const t = (e.target as Element).closest<HTMLElement>(".agr-tile");
    if (!t) return;
    if (t.matches("[data-agr-add]")) { addFolder(t); return; }
    openModule(t, true);
  });
  list.addEventListener("keydown", (e) => {
    const t = (e.target as Element).closest<HTMLElement>(".agr-tile");
    if (!t || e.target !== t) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (t.matches("[data-agr-add]")) { addFolder(t); return; }
      openModule(t, true);
      window.setTimeout(() => pop.querySelector<HTMLElement>(".agr-sub [data-go]")?.focus(), 0);
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const dir: 1 | -1 = e.key === "ArrowUp" ? -1 : 1;
    if (e.altKey) { if (t.dataset.agent) { closeModule(false); keyMove(t, dir); } return; }
    const all = [...list.querySelectorAll<HTMLElement>(".agr-tile")];
    all[all.indexOf(t) + dir]?.focus();
  });

  applyView();
  void tick();

  return {
    view: () => view,
    setView,
    adoptFirstRunDefault: () => { if (kv.getItem(VIEW_KEY) === null) setView("agents"); },
    sync: () => void tick(),
    noteTurnEnd: (folder: string) => { if (folder && view === "agents") ring(folder); },
  };
}
