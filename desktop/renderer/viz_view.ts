// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_view.ts - P-VIZ.1 (ADR-0622): the Visualize overlay (#vizView, z 93).
//
// Owns the chrome (title, live census, 2D/3D, Orbit/Constellation layout, Quality, Record, Recordings,
// Close), the feeds (the vizBus taps from the chat turn and the lane sinks, the fleet poll on the orbit's
// cadence, Main's subagent run poll, and a bounded set of read-only lane watches so a lane nobody has open
// still shows its stream), the node action menu (Stop turn, End agent, Kill; the hub stops Main's turn
// through the app's own Stop path; subagents are view-only and say why) and the recorder (canvas
// captureStream + MediaRecorder, a 2 minute cap, a session-lived bounded list with in-overlay playback).
//
// Opening never changes an agent. Closing stops every timer and watch, unsubscribes the bus and tears the
// WebGL scene down completely (viz_scene.destroy). The rules live in viz_model.ts (pure, tested); the
// drawing in viz_scene.ts. A deterministic DEMO feed (viz_demo.ts) runs only with ?vizDemo=1 in the URL.

import { $, el } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { popover, showToast } from "./ui.ts";
import { tipValue } from "./tip_text.ts";
import type { LaneView, LucidBridge } from "./bridge.ts";
import { hubLanes } from "./orbit_layout.ts";
import { pollDelay, type PerfTierWatcher } from "./perf_tier.ts";
import { vizBus, type VizBusEvent } from "./viz_bus.ts";
import { createDemo, type VizDemo } from "./viz_demo.ts";
import {
  applyEvent, applyFleet, applyRuns, census, createVizState, describeNode, drainEvents, edgesOf, fmtRate, HUB_ID, isTapped, layoutPositions,
  markAsked, nodeIntensity, PERSONAS, tick, vizTierOpts, type Persona, type VizAsk, type VizEvent, type VizLayout, type VizState,
} from "./viz_model.ts";
import { mountVizScene, type SceneHit, type SceneNode, type VizSceneHandle, type VizTheme, type VizViewMode } from "./viz_scene.ts";

export interface VizDeps {
  fleetStatus: LucidBridge["fleetStatus"];
  fleetWatch: LucidBridge["fleetWatch"];
  fleetCancel: LucidBridge["fleetCancel"];
  fleetStop: LucidBridge["fleetStop"];
  fleetRemove: LucidBridge["fleetRemove"];
  subagents: LucidBridge["subagents"];
  /** The app-wide Performance mode (the Knowledge Graph's chip cycles the same one). */
  perf: PerfTierWatcher;
  /** Stop Main's running turn through the app's own Stop path. */
  stopMain: () => Promise<void> | void;
  mainBusy: () => boolean;
}

const POLL_MS = 2500; // the orbit's fleet cadence
const RUNS_MS = 2500; // the subagent card's run cadence
const TICK_MS = 100;
/** Read-only lane watches the view opens itself, at most. Each is a long-lived request; the browser allows
 *  only a handful per origin, and the chat stream and the grid need theirs. */
const WATCH_MAX = 3;
const REC_MAX_MS = 120_000;
const REC_KEEP = 6;
const PREFS_KEY = "lucid.viz.v1";

interface Recording { id: number; url: string; size: number; mime: string; at: number; ms: number; meta: VizEvent[] }

let deps: VizDeps | null = null;
let view: HTMLElement | null = null;
let model: VizState | null = null;
let scene: VizSceneHandle | null = null;
let demo: VizDemo | null = null;
let demoPrev = 0;
let offBus: (() => void) | null = null;
let tickTimer = 0, fleetTimer = 0, runsTimer = 0;
let opener: HTMLElement | null = null;
let onCloseCb: (() => void) | null = null;
let fleetOffline = false;
let themeSig = "";
let hover: { hit: SceneHit; x: number; y: number } | null = null;
let censusAt = 0;
const watches = new Map<string, { stop: () => void }>();
const recordings: Recording[] = [];
let recSeq = 0;
interface ActiveRec { mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; mime: string; at: number; end: number; meta: VizEvent[]; timer: number }
let rec: ActiveRec | null = null;
let recPop: { close: () => void } | null = null;
let killArm: { id: string; until: number } | null = null;
const motionMq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

interface Prefs { view: VizViewMode; layout: VizLayout }
function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return { view: p.view === "2d" ? "2d" : "3d", layout: p.layout === "constellation" ? "constellation" : "orbit" };
  } catch { return { view: "3d", layout: "orbit" }; }
}
let prefs: Prefs = loadPrefs();
function savePrefs(): void { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* the choice still applies for this session */ } }

/** A data-tip value escaped for an HTML attribute. */
const tipAttr = (title: string, desc: string): string => esc(tipValue(title, desc));

/** Called once from app.ts with the bridge seam. */
export function initViz(d: VizDeps): void {
  deps = d;
  d.perf.onChange(() => { if (isOpen()) { paintQuality(); remount(); } });
}

/** True from open until close is asked (the fade-out that follows is not "open"). */
let opened = false;
export const isOpen = (): boolean => opened;

export function toggleViz(): void { if (isOpen()) closeViz(); else openViz(); }

/** Open the overlay. `onClose` runs after it closes (the orbit uses it to come back). */
export function openViz(opts: { onClose?: () => void } = {}): void {
  if (!deps || opened) return;
  opened = true;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  onCloseCb = opts.onClose ?? null;
  if (!view) view = buildView();
  if (!view.isConnected) document.body.appendChild(view);
  view.hidden = false;
  view.classList.remove("open");
  requestAnimationFrame(() => view?.classList.add("open"));
  const now = Date.now();
  model = createVizState(now);
  demo = new URLSearchParams(location.search).get("vizDemo") === "1" ? createDemo(now) : null; // the DEMO feed: only ever through the URL
  demoPrev = now;
  ($("[data-viz-demo]", view) as HTMLElement).hidden = !demo;
  if (!demo) offBus = vizBus.on(onBus);
  paintToggles();
  paintQuality();
  paintRecs();
  mount();
  startTimers();
  fleetBusy = false; // a reply still in flight from a previous open is dropped by its model check
  void pollFleet();
  void pollRuns();
  window.addEventListener("keydown", onKey, true);
  document.addEventListener("visibilitychange", onVisibility);
  motionMq?.addEventListener("change", remount);
}

export function closeViz(): void {
  if (!view || !opened) return;
  if (rec) stopRec("closed");
  closeMenu(); closePlayer(); recPop?.close(); recPop = null;
  offBus?.(); offBus = null;
  stopTimers();
  for (const w of watches.values()) w.stop();
  watches.clear();
  scene?.destroy(); scene = null;
  model = null; demo = null; hover = null;
  window.removeEventListener("keydown", onKey, true);
  document.removeEventListener("visibilitychange", onVisibility);
  motionMq?.removeEventListener("change", remount);
  opened = false;
  view.classList.remove("open");
  const v = view;
  window.setTimeout(() => { if (!opened) v.hidden = true; }, 200);
  const back = opener; opener = null;
  const cb = onCloseCb; onCloseCb = null;
  if (cb) cb(); else if (back?.isConnected) back.focus();
}

// ---------------------------------------------------------------------------------------------- chrome

function buildView(): HTMLElement {
  const v = el(`<div id="vizView" class="viz-view" role="dialog" aria-modal="true" aria-label="Visualize: agents, subagents and token flow" hidden>
    <div class="orbit-nebula" aria-hidden="true"></div>
    <header class="orbit-head viz-head">
      <div class="orbit-title">${icon("visualize", 17)}<b>Visualize</b><span class="orbit-sub">agents and token flow</span><span class="viz-demo" data-viz-demo hidden>DEMO</span></div>
      <div class="viz-census" data-viz-census aria-live="polite"></div>
      <span class="orbit-headgap"></span>
      <div class="viz-seg" role="group" aria-label="View">
        <button type="button" data-viz-view="2d" data-tip="${tipAttr("2D", "Top-down map: pan and zoom. The Orbit layout here is the Fleet orbit itself.")}">2D</button>
        <button type="button" data-viz-view="3d" data-tip="${tipAttr("3D", "Orbit around the agents: drag to rotate, right-drag to pan, scroll to zoom.")}">3D</button>
      </div>
      <div class="viz-seg" role="group" aria-label="Layout">
        <button type="button" data-viz-layout="orbit" data-tip="${tipAttr("Orbit layout", "Main at the center and the agents on the Fleet orbit's ring; each agent's subagents on a small ring around it.")}">Orbit</button>
        <button type="button" data-viz-layout="constellation" data-tip="${tipAttr("Constellation", "The agents spread around Main in 3D, each with its subagents clustered close.")}">Constellation</button>
      </div>
      <button type="button" class="btn-mini orbit-btn" data-viz-fit aria-label="Fit everything in view" data-tip="${tipAttr("Fit", "Bring every node back into view.")}">${icon("center", 13)}</button>
      <button type="button" class="btn-mini orbit-btn" data-viz-quality></button>
      <button type="button" class="btn-mini orbit-btn viz-rec-btn" data-viz-rec></button>
      <button type="button" class="btn-mini orbit-btn" data-viz-recs data-tip="${tipAttr("Recordings", "Play back or save what you recorded in this session. Recordings are kept in memory until LUCID closes.")}">${icon("play", 13)}<span>Recordings</span><b class="orbit-ghost-n" data-viz-recn hidden></b></button>
      <button type="button" class="btn-mini orbit-btn orbit-x" data-viz-close aria-label="Close Visualize" data-tip="${tipAttr("Close (Esc)", "Your agents keep running; this view only watches them.")}">${icon("close", 13)}</button>
    </header>
    <div class="viz-stage" data-viz-stage>
      <div class="viz-state" data-viz-loading><span class="viz-spin" aria-hidden="true"></span><p>Starting the 3D view</p></div>
      <div class="viz-state viz-error" data-viz-error hidden role="alert"><p data-viz-error-msg></p><button type="button" class="btn-mini" data-viz-retry>Try again</button></div>
      <p class="viz-caption" data-viz-empty hidden>Main is idle. Start an agent or send a prompt to see tokens flow.</p>
      <div class="viz-recind" data-viz-recind hidden><i aria-hidden="true"></i><b>REC</b><span data-viz-rectime>0:00</span><span class="viz-rec-cap">stops at 2:00</span></div>
      <div class="viz-legend" data-viz-legend aria-label="Roles"></div>
      <div class="viz-tip" data-viz-tip hidden role="status"></div>
      <div class="viz-menu" data-viz-menu hidden role="menu"></div>
      <div class="viz-player" data-viz-player hidden>
        <div class="viz-player-head"><b data-viz-player-title>Recording</b><span class="viz-player-meta" data-viz-player-meta></span><span class="orbit-headgap"></span>
          <button type="button" class="btn-mini orbit-btn" data-viz-player-save>${icon("download", 13)} Save</button>
          <button type="button" class="btn-mini orbit-btn" data-viz-player-close>${icon("close", 13)} Back to live</button></div>
        <video class="viz-video" data-viz-video controls playsinline></video>
      </div>
    </div>
  </div>`);
  v.addEventListener("click", onViewClick);
  return v;
}

function onViewClick(ev: Event): void {
  const t = ev.target as HTMLElement;
  if (t.closest("[data-viz-close]")) { closeViz(); return; }
  const vb = t.closest("[data-viz-view]") as HTMLElement | null;
  if (vb) { prefs.view = vb.dataset.vizView === "2d" ? "2d" : "3d"; savePrefs(); paintToggles(); scene?.setView(prefs.view); return; }
  const lb = t.closest("[data-viz-layout]") as HTMLElement | null;
  if (lb) { prefs.layout = lb.dataset.vizLayout === "constellation" ? "constellation" : "orbit"; savePrefs(); paintToggles(); syncScene(); scene?.fit(); return; }
  if (t.closest("[data-viz-fit]")) { scene?.fit(); return; }
  if (t.closest("[data-viz-quality]")) { cycleQuality(); return; }
  if (t.closest("[data-viz-rec]")) { if (rec) stopRec("user"); else startRec(); return; }
  const recsBtn = t.closest("[data-viz-recs]") as HTMLElement | null;
  if (recsBtn) { openRecs(recsBtn); return; }
  if (t.closest("[data-viz-retry]")) { remount(); return; }
  if (t.closest("[data-viz-player-close]")) { closePlayer(); return; }
  if (t.closest("[data-viz-player-save]")) { const r = recordings.find((x) => x.id === playingId); if (r) saveRec(r); return; }
  const act = t.closest("[data-viz-act]") as HTMLElement | null;
  if (act) { void runAction(act.dataset.vizNode ?? "", act.dataset.vizAct as VizAsk, act); return; }
  if (!t.closest("[data-viz-menu]") && !(t instanceof HTMLCanvasElement)) closeMenu();
}

function paintToggles(): void {
  if (!view) return;
  for (const b of view.querySelectorAll<HTMLElement>("[data-viz-view]")) { const on = b.dataset.vizView === prefs.view; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }
  for (const b of view.querySelectorAll<HTMLElement>("[data-viz-layout]")) { const on = b.dataset.vizLayout === prefs.layout; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }
}

function paintQuality(): void {
  const b = view ? ($("[data-viz-quality]", view) as HTMLElement | null) : null;
  if (!b || !deps) return;
  const m = deps.perf.mode(), tier = deps.perf.tier();
  b.innerHTML = `${icon("gauge", 13)} ${m === "auto" ? `Auto \u00b7 ${tier}` : m[0]!.toUpperCase() + m.slice(1)}`;
  b.setAttribute("data-tip", tipValue("Quality", `Auto, Full, Reduced or Minimal: the same Performance mode as the Knowledge Graph. Full: 6000 particles, 60 fps, glass refraction and bloom. Reduced: 2500 particles, 30 fps. Minimal: 600 particles, 20 fps, no lightning. Now: ${tier}.`));
}

function cycleQuality(): void {
  if (!deps) return;
  const m = deps.perf.cycleMode(); // notifies onChange, which repaints and remounts
  showToast({ title: `Quality: ${m}`, desc: m === "auto" ? `Following battery and CPU (now: ${deps.perf.tier()}). The Knowledge Graph uses the same mode.` : "The Knowledge Graph uses the same mode.", timeout: 2400 });
}

// ---------------------------------------------------------------------------------------------- scene

function readTheme(at: HTMLElement): VizTheme {
  const cs = getComputedStyle(at);
  const v = (k: string, d: string): string => cs.getPropertyValue(k).trim() || d;
  const rgb = (s: string): string => (/^\d+\s+\d+\s+\d+$/.test(s) ? `rgb(${s.split(/\s+/).join(",")})` : s);
  const bg = toHex(v("--bg-0", "#0b0d14"), "#0b0d14");
  return {
    bg, txt: toHex(v("--txt", "#e8eaf2"), "#e8eaf2"),
    accent: toHex(rgb(v("--accent-rgb", "198 75 214")), "#c64bd6"),
    cyan: toHex(rgb(v("--cyan-rgb", "70 200 220")), "#46c8dc"),
    light: luminance(bg) > 0.5,
  };
}

/** Any CSS color the stylesheet uses, normalized to #rrggbb by the canvas parser (one context, reused: the
 *  theme is re-read twice a second while open, to catch a theme switch). */
let colorCtx: CanvasRenderingContext2D | null = null;
function toHex(css: string, fallback: string): string {
  colorCtx ??= document.createElement("canvas").getContext("2d");
  const c = colorCtx;
  if (!c) return fallback;
  c.fillStyle = fallback;
  c.fillStyle = css;
  const s = String(c.fillStyle);
  if (s.startsWith("#")) return s;
  const m = s.match(/[\d.]+/g);
  if (!m || m.length < 3) return fallback;
  return `#${m.slice(0, 3).map((x) => Math.round(Number(x)).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

function mount(): void {
  if (!view || !deps) return;
  const stage = $("[data-viz-stage]", view) as HTMLElement;
  const loading = $("[data-viz-loading]", view) as HTMLElement;
  const err = $("[data-viz-error]", view) as HTMLElement;
  loading.hidden = false; err.hidden = true;
  const theme = readTheme(view);
  themeSig = JSON.stringify(theme);
  try {
    scene = mountVizScene(stage, vizTierOpts(deps.perf.tier(), !!motionMq?.matches), theme, prefs.view);
  } catch (e) {
    scene = null;
    loading.hidden = true;
    showError(`The 3D view could not start on this machine: ${e instanceof Error ? e.message : String(e)}. Your agents are not affected.`);
    return;
  }
  scene.onHover(onHover);
  scene.onPick(onPick);
  scene.onLost(() => { scene?.destroy(); scene = null; showError("The graphics driver reset the 3D view. Your agents are not affected."); });
  syncScene();
  requestAnimationFrame(() => requestAnimationFrame(() => { loading.hidden = true; }));
  scene.canvas.focus({ preventScroll: true });
}

function remount(): void {
  if (!isOpen()) return;
  if (rec) stopRec("quality");
  closeMenu(); hideTip();
  scene?.destroy(); scene = null;
  mount();
}

function showError(msg: string): void {
  if (!view) return;
  ($("[data-viz-error-msg]", view) as HTMLElement).textContent = msg;
  const err = $("[data-viz-error]", view) as HTMLElement;
  err.hidden = false;
  ($("[data-viz-retry]", err) as HTMLElement).focus();
}

function syncScene(): void {
  if (!scene || !model) return;
  const now = Date.now();
  const list = [...model.nodes.values()];
  const pos = layoutPositions(list, prefs.layout);
  const nodes: SceneNode[] = list.map((n) => ({
    id: n.id, kind: n.kind, persona: n.persona, label: n.kind === "hub" ? "Main" : n.label, status: n.status,
    pos: pos.get(n.id) ?? [0, 0, 0], glow: nodeIntensity(n, now),
  }));
  scene.sync(nodes, edgesOf(model, now));
}

// ---------------------------------------------------------------------------------------------- feeds

function onBus(ev: VizBusEvent): void { if (model) applyEvent(model, ev, Date.now()); }

function startTimers(): void {
  stopTimers();
  tickTimer = window.setInterval(onTick, TICK_MS);
}

function stopTimers(): void {
  window.clearInterval(tickTimer); tickTimer = 0;
  window.clearTimeout(fleetTimer); fleetTimer = 0;
  window.clearTimeout(runsTimer); runsTimer = 0;
}

function onTick(): void {
  if (!model) return;
  const now = Date.now();
  if (demo) {
    const st = demo.step(demoPrev, now);
    demoPrev = now;
    for (const a of st.asks) markAsked(model, a.id, a.ask);
    for (const e of st.events) applyEvent(model, e, now);
  }
  tick(model, now);
  const fresh = drainEvents(model);
  syncScene();
  if (fresh.length) scene?.fire(fresh);
  if (now - censusAt >= 500) {
    censusAt = now;
    paintCensus(now);
    if (hover) paintTip(hover.hit, hover.x, hover.y);
    if (view && themeSig && JSON.stringify(readTheme(view)) !== themeSig) remount(); // a theme switch while open
  }
}

/** One fleet poll chain: an extra call (after an action) runs now and re-arms the single timer. A reply that
 *  lands after a close, or after a reopen made a new model, is dropped. */
let fleetBusy = false;
async function pollFleet(): Promise<void> {
  const m = model;
  if (!m || !deps || fleetBusy) return;
  window.clearTimeout(fleetTimer);
  const tier = deps.perf.tier();
  if (demo) {
    applyFleet(m, demo.lanes(Date.now()), Date.now(), "anthropic/claude-opus-4.6");
    fleetTimer = window.setTimeout(() => void pollFleet(), 500);
    return;
  }
  fleetBusy = true;
  const st = await deps.fleetStatus().catch(() => null);
  fleetBusy = false;
  if (model !== m) return;
  fleetOffline = !st;
  if (st) {
    const mine = hubLanes(st.lanes, st.hub);
    applyFleet(m, mine.map((l) => ({ id: l.id, name: l.name, model: l.model, status: l.status, ...(l.usage ? { usage: l.usage } : {}) })), Date.now(), st.masterModel);
    syncWatches(mine);
  }
  fleetTimer = window.setTimeout(() => void pollFleet(), pollDelay(POLL_MS, tier, document.hidden));
}

async function pollRuns(): Promise<void> {
  const m = model;
  if (!m || !deps) return;
  if (demo) {
    applyRuns(m, demo.runs(Date.now()), Date.now());
    runsTimer = window.setTimeout(() => void pollRuns(), 1000);
    return;
  }
  const v = await deps.subagents().catch(() => null);
  if (model !== m) return;
  if (v?.runs) applyRuns(m, v.runs, Date.now());
  runsTimer = window.setTimeout(() => void pollRuns(), pollDelay(RUNS_MS, deps.perf.tier(), document.hidden));
}

/** Watch (read-only, owns no turn) the most recently active live lanes, so their streams show even when
 *  no grid card or composer has them open. A second stream for a lane is deduplicated by the model. */
function syncWatches(lanes: readonly LaneView[]): void {
  if (!deps) return;
  const live = lanes.filter((l) => l.status !== "stopped" && l.status !== "error");
  const busy = (l: LaneView): number => (l.status === "working" || l.status === "starting" || l.status === "needs-approval" || l.status === "awaiting-input" ? 1 : 0);
  const want = new Set(live.sort((a, b) => busy(b) - busy(a) || b.lastActivityAt - a.lastActivityAt).slice(0, WATCH_MAX).map((l) => l.id));
  for (const [id, w] of [...watches]) if (!want.has(id)) { w.stop(); watches.delete(id); }
  for (const id of want) {
    if (watches.has(id)) continue;
    const w = deps.fleetWatch(id, (e) => { if (model) applyEvent(model, { source: id, origin: "watch", e }, Date.now()); });
    watches.set(id, w);
    w.done.catch(() => { /* aborted on close, or the engine went away: the next poll decides again */ }).finally(() => { if (watches.get(id) === w) watches.delete(id); });
  }
}

function onVisibility(): void {
  if (!isOpen()) return;
  if (document.hidden) { window.clearInterval(tickTimer); tickTimer = 0; scene?.setVisible(false); }
  else { if (!tickTimer) tickTimer = window.setInterval(onTick, TICK_MS); scene?.setVisible(!playerOpen()); }
}

// ---------------------------------------------------------------------------------------------- census + legend

function paintCensus(now: number): void {
  if (!view || !model) return;
  const c = census(model, now);
  const box = $("[data-viz-census]", view) as HTMLElement;
  const chip = (txt: string, cls = ""): string => `<span class="viz-chip${cls}">${esc(txt)}</span>`;
  const rate = c.tapped ? fmtRate(c.tokps) : "no token stream yet";
  const html = fleetOffline && !demo
    ? chip("Fleet status unavailable", " warn")
    : chip(`${c.agents} agent${c.agents === 1 ? "" : "s"}`) + chip(`${c.subagents} subagent${c.subagents === 1 ? "" : "s"}`) + chip(rate, c.tapped ? " hot" : "");
  if (box.innerHTML !== html) box.innerHTML = html;
  const hub = model.nodes.get(HUB_ID);
  const quiet = c.agents === 0 && c.subagents === 0 && (!hub || (hub.status !== "active" && !isTapped(hub, now)));
  ($("[data-viz-empty]", view) as HTMLElement).hidden = !quiet;
  const seen = [...new Set([...model.nodes.values()].map((n) => n.persona))] as Persona[];
  const legend = seen.map((p) => `<span class="viz-legend-i" style="--viz-c:${PERSONAS[p].color}"><i></i><span>${esc(PERSONAS[p].label)}</span></span>`).join("");
  const lg = $("[data-viz-legend]", view) as HTMLElement;
  if (lg.innerHTML !== legend) lg.innerHTML = legend;
}

// ---------------------------------------------------------------------------------------------- hover + menu

function onHover(hit: SceneHit | null, x: number, y: number): void {
  hover = hit ? { hit, x, y } : null;
  if (!hit) { hideTip(); return; }
  paintTip(hit, x, y);
}

function hideTip(): void {
  const tip = view ? ($("[data-viz-tip]", view) as HTMLElement | null) : null;
  if (tip) tip.hidden = true;
}

function paintTip(hit: SceneHit, x: number, y: number): void {
  if (!view || !model) return;
  const now = Date.now();
  const tip = $("[data-viz-tip]", view) as HTMLElement;
  let title = "", lines: string[] = [];
  if (hit.kind === "node") {
    const n = model.nodes.get(hit.id);
    if (!n) { hideTip(); return; }
    ({ title, lines } = describeNode(n, now));
  } else {
    const a = model.nodes.get(hit.from), b = model.nodes.get(hit.to);
    if (!a || !b) { hideTip(); return; }
    title = `${a.name} \u2192 ${b.name}`;
    lines = [a.kind === "subagent" ? `${a.status === "active" ? "live" : a.status}, ${a.tools} tool${a.tools === 1 ? "" : "s"}` : isTapped(a, now) ? fmtRate(a.rate) : a.status === "active" ? "working, token stream not tapped" : "no flow"];
  }
  tip.innerHTML = `<b>${esc(title)}</b>${lines.map((l) => `<span>${esc(l)}</span>`).join("")}`;
  tip.hidden = false;
  placeIn(tip, x + 14, y + 14);
}

/** Position a floating element at client (x, y), kept inside the stage. */
function placeIn(node: HTMLElement, x: number, y: number): void {
  const stage = view ? ($("[data-viz-stage]", view) as HTMLElement) : null;
  if (!stage) return;
  const r = stage.getBoundingClientRect();
  const w = node.offsetWidth, h = node.offsetHeight;
  node.style.left = `${Math.max(8, Math.min(r.width - w - 8, x - r.left))}px`;
  node.style.top = `${Math.max(8, Math.min(r.height - h - 8, y - r.top))}px`;
}

function onPick(hit: SceneHit | null, x: number, y: number): void {
  if (!hit || hit.kind !== "node") { closeMenu(); return; }
  openMenu(hit.id, x, y);
}

function openMenu(id: string, x: number, y: number): void {
  if (!view || !model) return;
  const n = model.nodes.get(id);
  if (!n) return;
  hideTip();
  killArm = null;
  const menu = $("[data-viz-menu]", view) as HTMLElement;
  const btn = (act: VizAsk, label: string, enabled: boolean, why: string, danger = false): string =>
    `<button type="button" role="menuitem" class="viz-menu-i${danger ? " danger" : ""}" data-viz-act="${act}" data-viz-node="${esc(id)}"${enabled ? "" : " disabled"} data-tip="${tipAttr(label, why)}">${esc(label)}</button>`;
  const head = `<div class="viz-menu-h"><b>${esc(n.name)}</b><span>${esc(PERSONAS[n.persona].label)}${n.kind === "hub" ? " \u00b7 Main session" : n.kind === "agent" ? " \u00b7 Agent" : " \u00b7 Subagent"}</span></div>`;
  let body: string;
  if (n.kind === "subagent") {
    body = `<p class="viz-menu-note">Subagents are view-only here: each runs inside its parent's turn and stops with it. Stop the parent's turn to stop it.</p>`;
  } else if (n.kind === "hub") {
    const busy = demo ? n.status === "active" : !!deps?.mainBusy();
    body = btn("cancel", "Stop the main turn", busy, busy ? "Stops Main's running turn, the same as the Stop button. The chat keeps everything so far." : "Main is not running a turn right now.");
  } else {
    const alive = n.status !== "ended" && n.status !== "killed" && n.goneAt === null;
    const running = n.status === "active" || n.status === "waiting";
    body = btn("cancel", "Stop turn", running, running ? "Stops this agent's current turn. The agent stays and can take the next prompt." : "This agent is not running a turn.")
      + btn("end", "End agent", alive, alive ? "Stops the agent. Its card stays readable and Respawn brings it back." : "This agent has already ended.")
      + btn("kill", "Kill", n.goneAt === null, "Removes the agent now, even mid-turn. Asks once more before it acts.", true);
  }
  menu.innerHTML = head + body + (demo ? `<p class="viz-menu-note">DEMO: actions here play on the demo agents only.</p>` : "");
  menu.hidden = false;
  placeIn(menu, x + 6, y + 6);
  (menu.querySelector("button:not([disabled])") as HTMLElement | null)?.focus();
}

function closeMenu(): void {
  const menu = view ? ($("[data-viz-menu]", view) as HTMLElement | null) : null;
  if (menu && !menu.hidden) { menu.hidden = true; menu.innerHTML = ""; scene?.canvas.focus({ preventScroll: true }); }
  killArm = null;
}

async function runAction(id: string, ask: VizAsk, btnEl: HTMLElement): Promise<void> {
  if (!model || !deps) return;
  const n = model.nodes.get(id);
  if (!n || n.kind === "subagent") return;
  if (ask === "kill" && (!killArm || killArm.id !== id || Date.now() > killArm.until)) {
    killArm = { id, until: Date.now() + 4000 };
    btnEl.textContent = `Click again to kill ${n.name}`;
    btnEl.classList.add("armed");
    return;
  }
  closeMenu();
  markAsked(model, id, ask);
  if (demo) { demo.act(id, ask, Date.now()); return; }
  if (n.kind === "hub") { await deps.stopMain(); return; }
  const r = ask === "cancel" ? await deps.fleetCancel(id).catch(() => null)
    : ask === "end" ? await deps.fleetStop(id).catch(() => null)
    : await deps.fleetRemove(id, true).catch(() => null);
  if (!r?.ok) {
    if (model) { const m = model.nodes.get(id); if (m) m.asked = null; }
    const verb = ask === "cancel" ? "stop the turn of" : ask === "end" ? "end" : "kill";
    const reason = r && "reason" in r && typeof r.reason === "string" ? r.reason : "the engine did not answer";
    showToast({ tone: "danger", title: `Could not ${verb} ${n.name}`, desc: `${reason}. Nothing was changed; try again from the Fleet panel.`, timeout: 5000 });
    return;
  }
  void pollFleet();
}

// ---------------------------------------------------------------------------------------------- keyboard

function onKey(e: KeyboardEvent): void {
  if (e.key !== "Escape" || !view || view.hidden) return;
  const active = document.activeElement;
  if (active && active !== document.body && !view.contains(active)) return; // a layer above us owns this Esc
  e.preventDefault(); e.stopPropagation();
  const menu = $("[data-viz-menu]", view) as HTMLElement;
  if (!menu.hidden) { closeMenu(); return; }
  if (playerOpen()) { closePlayer(); return; }
  if (recPop) { recPop.close(); recPop = null; return; }
  closeViz();
}

// ---------------------------------------------------------------------------------------------- recording

function paintRec(): void {
  const b = view ? ($("[data-viz-rec]", view) as HTMLElement | null) : null;
  if (!b) return;
  b.classList.toggle("on", !!rec);
  b.innerHTML = rec ? `${icon("square", 13)} Stop` : `${icon("record", 13)} Record`;
  b.setAttribute("aria-label", rec ? "Stop recording" : "Record the visualization");
  b.setAttribute("data-tip", rec ? tipValue("Stop recording", "Keeps the clip in Recordings.") : tipValue("Record", "Captures this view as a video (up to 2 minutes) that you can play back here or save."));
  const ind = $("[data-viz-recind]", view!) as HTMLElement;
  ind.hidden = !rec;
}

function startRec(): void {
  if (!scene || rec) return;
  const canvas = scene.canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream };
  if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") {
    showToast({ tone: "warn", title: "Recording is not available", desc: "This build cannot capture the canvas as video.", timeout: 4000 });
    return;
  }
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) { showToast({ tone: "warn", title: "Recording is not available", desc: "No WebM video encoder is available.", timeout: 4000 }); return; }
  let stream: MediaStream, mr: MediaRecorder;
  try {
    stream = canvas.captureStream(30);
    mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  } catch (e) {
    showToast({ tone: "danger", title: "Recording could not start", desc: e instanceof Error ? e.message : String(e), timeout: 5000 });
    return;
  }
  const r: ActiveRec = { mr, stream, chunks: [], mime, at: Date.now(), end: 0, meta: [], timer: 0 };
  mr.ondataavailable = (ev) => { if (ev.data.size) r.chunks.push(ev.data); };
  mr.onstop = () => finishRec(r);
  mr.start(1000);
  rec = r;
  scene.setRecording(true);
  r.timer = window.setInterval(() => {
    const ms = Date.now() - r.at;
    const t = view ? ($("[data-viz-rectime]", view) as HTMLElement | null) : null;
    if (t) t.textContent = clockStr(ms);
    if (ms >= REC_MAX_MS) stopRec("cap");
  }, 250);
  paintRec();
}

function stopRec(why: "user" | "cap" | "closed" | "quality"): void {
  const r = rec;
  if (!r) return;
  rec = null;
  window.clearInterval(r.timer);
  r.end = Date.now();
  r.meta = model ? model.log.filter((e) => e.at >= r.at && e.at <= r.end) : []; // the clip's event slice, taken before a close drops the model
  try { if (r.mr.state !== "inactive") r.mr.stop(); } catch { /* already stopped */ }
  for (const tr of r.stream.getTracks()) tr.stop();
  scene?.setRecording(false);
  paintRec();
  if (why === "cap") showToast({ tone: "info", title: "Recording stopped at 2 minutes", desc: "That is the cap for one clip. It is in Recordings.", timeout: 4000 });
  if (why === "quality") showToast({ tone: "info", title: "Recording stopped", desc: "Changing quality restarts the 3D view. The clip so far is in Recordings.", timeout: 4000 });
}

function finishRec(r: ActiveRec): void {
  const blob = new Blob(r.chunks, { type: r.mime.split(";")[0] });
  if (!blob.size) { showToast({ tone: "warn", title: "Nothing was recorded", desc: "No frames reached the recorder. Try again with the view visible.", timeout: 4000 }); return; }
  const item: Recording = { id: ++recSeq, url: URL.createObjectURL(blob), size: blob.size, mime: blob.type, at: r.at, ms: (r.end || Date.now()) - r.at, meta: r.meta };
  recordings.unshift(item);
  while (recordings.length > REC_KEEP) { const old = recordings.pop()!; URL.revokeObjectURL(old.url); }
  paintRecs();
  showToast({ title: "Recording saved to Recordings", desc: `${clockStr(item.ms)}, ${mb(item.size)}. Kept in memory for this session.`, actions: [{ label: "Play", run: () => playRec(item.id) }, { label: "Save", run: () => saveRec(item) }], timeout: 6000 });
}

function paintRecs(): void {
  const n = view ? ($("[data-viz-recn]", view) as HTMLElement | null) : null;
  if (n) { n.hidden = recordings.length === 0; n.textContent = String(recordings.length); }
  paintRec();
}

function openRecs(anchor: HTMLElement): void {
  if (recPop) { recPop.close(); recPop = null; return; }
  const rows = recordings.map((r) => `<div class="viz-rec-row">
      <span class="viz-rec-name">${esc(new Date(r.at).toLocaleTimeString())} \u00b7 ${clockStr(r.ms)} \u00b7 ${mb(r.size)} \u00b7 ${r.meta.length} event${r.meta.length === 1 ? "" : "s"}</span>
      <button type="button" class="btn-mini" data-viz-rplay="${r.id}">${icon("play", 12)} Play</button>
      <button type="button" class="btn-mini" data-viz-rsave="${r.id}">${icon("download", 12)} Save</button>
      <button type="button" class="btn-mini" data-viz-rdel="${r.id}" aria-label="Delete this recording">${icon("trash", 12)}</button>
    </div>`).join("");
  const p = popover(anchor, `<div class="viz-recs"><div class="viz-recs-h"><b>Recordings</b><span>this session, up to ${REC_KEEP}</span></div>${rows || `<p class="viz-recs-empty">No recordings yet. Record captures this view as a video you can play back here or save.</p>`}</div>`, () => { recPop = null; });
  recPop = p;
  p.node.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const play = t.closest("[data-viz-rplay]") as HTMLElement | null;
    const save = t.closest("[data-viz-rsave]") as HTMLElement | null;
    const del = t.closest("[data-viz-rdel]") as HTMLElement | null;
    if (play) { p.close(); playRec(Number(play.dataset.vizRplay)); }
    else if (save) { const r = recordings.find((x) => x.id === Number(save.dataset.vizRsave)); if (r) saveRec(r); }
    else if (del) {
      const i = recordings.findIndex((x) => x.id === Number(del.dataset.vizRdel));
      if (i >= 0) { const [gone] = recordings.splice(i, 1); if (gone) { if (playingId === gone.id) closePlayer(); URL.revokeObjectURL(gone.url); } }
      paintRecs();
      p.close();
    }
  });
}

let playingId = 0;
const playerOpen = (): boolean => !!view && !($("[data-viz-player]", view) as HTMLElement).hidden;

function playRec(id: number): void {
  const r = recordings.find((x) => x.id === id);
  if (!view || !r) return;
  closeMenu(); hideTip();
  playingId = id;
  const pl = $("[data-viz-player]", view) as HTMLElement;
  const video = $("[data-viz-video]", view) as HTMLVideoElement;
  ($("[data-viz-player-title]", view) as HTMLElement).textContent = `Recording from ${new Date(r.at).toLocaleTimeString()}`;
  ($("[data-viz-player-meta]", view) as HTMLElement).textContent = `${clockStr(r.ms)} \u00b7 ${summarize(r.meta)}`;
  video.src = r.url;
  pl.hidden = false;
  scene?.setVisible(false); // the live view parks under the player
  void video.play().catch(() => { /* autoplay refused: the controls are right there */ });
  video.focus();
}

function closePlayer(): void {
  if (!view) return;
  const pl = $("[data-viz-player]", view) as HTMLElement;
  if (pl.hidden) return;
  const video = $("[data-viz-video]", view) as HTMLVideoElement;
  video.pause();
  video.removeAttribute("src");
  video.load();
  pl.hidden = true;
  playingId = 0;
  scene?.setVisible(!document.hidden);
  scene?.canvas.focus({ preventScroll: true });
}

function saveRec(r: Recording): void {
  const stamp = new Date(r.at).toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const a = document.createElement("a");
  a.href = r.url; a.download = `lucid-visualize-${stamp}.webm`;
  document.body.appendChild(a); a.click(); a.remove();
}

/** "2 surges, 1 tool failure, 1 killed" for a recording's event slice. */
function summarize(meta: readonly VizEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of meta) {
    const k = e.kind === "power" ? e.power : e.kind;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const words: Record<string, [string, string]> = {
    surge: ["surge", "surges"], spawn: ["new node", "new nodes"], "tool-failed": ["tool failure", "tool failures"],
    paused: ["pause", "pauses"], ended: ["ended", "ended"], killed: ["killed", "killed"],
  };
  const parts = [...counts].map(([k, n]) => `${n} ${(words[k] ?? [k, k])[n === 1 ? 0 : 1]}`);
  return parts.length ? parts.join(", ") : "no events";
}

function clockStr(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function mb(bytes: number): string { return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`; }
