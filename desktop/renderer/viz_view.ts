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
//
// P-VIZ.2 (ADR-0623): the header's Auto camera checkbox (persisted in localStorage `lucid.viz.autoCamera`,
// on by default) hands the camera to the scene's director, which follows the action. The scene unchecks it
// the moment the user drags, pans or zooms, and a short hint under it says how to hand the camera back.
// Fit frames everything and takes the camera off auto.
//
// P-VIZ.4 (ADR-0625): the overlay sits below the app titlebar (styles.css), so the window's own controls stay
// live and Electron's titlebar drag region no longer eats the header's clicks. The header gained the style
// toggle (Anime | Professional, persisted with the other prefs, scene.setStyle) and folded Layout and Quality
// into a small View menu so it stays one row. A click on a node makes its figure stare at you and opens the
// node PANEL above it (it follows the node as the camera moves): the agent's recent output (the same lane
// stream the grid card shows: a read-only watch's history seed, then the live events; Main's is the chat
// thread's last turn), Stop turn / End agent / Kill (moved here from the old node menu), Expand (the agent's
// Fleet card, or the chat for Main) and a prompt box (an idle agent gets the prompt, a busy one stages it,
// Main goes through the composer's own send path; subagents take no prompts and say why). Esc or a click on
// empty space closes it. A double click is an outburst and opens nothing. Each working lane's background
// subagent runs are polled (/api/subagents?laneId=) so a lane's subagents end when their runs do.
//
// P-VIZ.5 (ADR-0629): the node panel sits BESIDE its node (viz_panel_place.ts: the side with more room,
// hysteresis on flips, clamped on screen, docked at the nearest edge while the node is off screen), never over
// it. The header measures itself (a ResizeObserver) and takes the widest density that fits on one row: wide;
// medium (no subtitle, one census chip, icon-only Record and Recordings); narrow (icon segments, an icon Auto
// camera toggle, Record and Recordings inside the View menu). The close X is always at the far right.
//
// P-VIZ.6 (ADR-0635): the session ledger (viz_ledger.ts over viz_ledger_model.ts) sits in the stage's lower
// right. Every event the model takes counts in it too, the fleet poll brings each lane's session, repo and
// measured usage, and it repaints with the census. It outlives a close and starts over on a new hub session.
//
// P-VIZ.6 (ADR-0636): the throw tray (viz_throw.mountThrowTray) sits at the stage's bottom center with the
// style's three throwables and Storm. While one is armed a click on a node throws it (scene.throwAt) instead of
// opening the panel, and Esc puts it down before it closes anything else.

import { $, el } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { popover, showToast } from "./ui.ts";
import { tipValue } from "./tip_text.ts";
import { bridge, type LaneEvent, type LaneView, type LucidBridge } from "./bridge.ts";
import { hubLanes } from "./orbit_layout.ts";
import { pollDelay, type PerfTierWatcher } from "./perf_tier.ts";
import { vizBus, type VizBusEvent } from "./viz_bus.ts";
import { createDemo, type VizDemo } from "./viz_demo.ts";
import { vizBrandFor } from "./viz_brand.ts"; // P-VIZ.7 (ADR-0641): the demo probe reports each figure's sponsor
import { mountLedger, type LedgerView } from "./viz_ledger.ts";
import { createLedger, ledgerEvent, ledgerFleet, ledgerFolder, ledgerHub, ledgerRows, ledgerSummary, syncLedger } from "./viz_ledger_model.ts";
import {
  applyEvent, applyFleet, applyRuns, census, committing, createOutput, createVizState, describeNode, drainEvents, edgesOf, fmtRate, foldOutput, HUB_ID, idleSeconds,
  isTapped, layoutPositions, markAsked, nodeIntensity, PERSONAS, teamOf, tick, vizTierOpts,
  type Persona, type VizAsk, type VizEvent, type VizLayout, type VizNode, type VizOutput, type VizState, type VizStyle, type VizTurn,
} from "./viz_model.ts";
import { placePanel, type NodeBox, type PanelSide } from "./viz_panel_place.ts";
import { mountVizScene, type SceneHit, type SceneNode, type VizSceneHandle, type VizTheme, type VizViewMode } from "./viz_scene.ts";
import { mountThrowTray, type ThrowTray } from "./viz_throw.ts";

export interface VizDeps {
  fleetStatus: LucidBridge["fleetStatus"];
  fleetWatch: LucidBridge["fleetWatch"];
  fleetCancel: LucidBridge["fleetCancel"];
  fleetStop: LucidBridge["fleetStop"];
  fleetRemove: LucidBridge["fleetRemove"];
  /** Main's subagent runs, or with a lane id that lane's (P-VIZ.4). */
  subagents: LucidBridge["subagents"];
  /** The app-wide Performance mode (the Knowledge Graph's chip cycles the same one). */
  perf: PerfTierWatcher;
  /** Stop Main's running turn through the app's own Stop path. */
  stopMain: () => Promise<void> | void;
  mainBusy: () => boolean;
  /** P-VIZ.4 (ADR-0625): the node panel. A lane's history, its prompt and stage calls (the grid card's). */
  fleetTranscript: LucidBridge["fleetTranscript"];
  fleetPrompt: LucidBridge["fleetPrompt"];
  fleetQueueAdd: LucidBridge["fleetQueueAdd"];
  /** Main's recent turn from the chat thread (oldest first). */
  mainRecent: () => VizTurn[];
  /** Send `text` to Main through the composer's own send path; a reason string when it could not. */
  sendMain: (text: string) => string | null;
  /** Open the Fleet panel (Expand on an agent; the view then scrolls to and flashes its card). */
  openFleet: () => void;
  /** Focus the main composer (Expand on Main). */
  focusMain: () => void;
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
let censusSig = "";
const watches = new Map<string, { stop: () => void }>();
const recordings: Recording[] = [];
let recSeq = 0;
interface ActiveRec { mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; mime: string; at: number; end: number; meta: VizEvent[]; timer: number }
let rec: ActiveRec | null = null;
let recPop: { close: () => void } | null = null;
let viewPop: { node: HTMLElement; close: () => void } | null = null;
let killArm: { id: string; until: number } | null = null;
/** P-VIZ.6 (ADR-0636): the throw tray (bottom center of the stage), built with the view. */
let tray: ThrowTray | null = null;
const motionMq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

/** P-VIZ.4 (ADR-0625): lanes whose background subagent runs are polled per cycle, at most. */
const LANE_RUNS_MAX = 4;
/** The node panel: which node, the frame that keeps it beside its node, where the node was last seen (stage
 *  pixels) and which side the panel is on (P-VIZ.5), and what it last painted. */
interface Panel { id: string; raf: number; outSig: string; headSig: string; note: string; box: NodeBox | null; side: PanelSide | null; flipTimer: number }
let panel: Panel | null = null;
/** Each lane's recent output (viz_model.foldOutput), from the same events the model takes. */
const outputs = new Map<string, VizOutput>();
/** Lanes with a prompt from the panel in flight (a second send stages instead). */
const sending = new Set<string>();
let lastLanes: readonly LaneView[] = [];
/** P-VIZ.6 (ADR-0635): the session ledger. It outlives a close (reopening keeps this hub session's totals; it
 *  counts what streams while Visualize is open) and starts over on a new hub session, or between demo and real. */
let ledger = createLedger();
let ledgerIsDemo = false;
let ledgerView: LedgerView | null = null;
/** Main's folder (the current workspace), applied to Main's entry on every repaint. */
let mainFolder: string | null = null;

interface Prefs { view: VizViewMode; layout: VizLayout; style: VizStyle }
function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return { view: p.view === "2d" ? "2d" : "3d", layout: p.layout === "constellation" ? "constellation" : "orbit", style: p.style === "professional" ? "professional" : "anime" };
  } catch { return { view: "3d", layout: "orbit", style: "anime" }; }
}
let prefs: Prefs = loadPrefs();
function savePrefs(): void { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* the choice still applies for this session */ } }

/** P-VIZ.2 (ADR-0623): the auto camera (follows the action; on unless the user turned it off last time). */
const AUTO_KEY = "lucid.viz.autoCamera";
const AUTO_HINT_MS = 4500;
let autoCam = ((): boolean => { try { return localStorage.getItem(AUTO_KEY) !== "0"; } catch { return true; } })();
let autoHintTimer = 0;

/** A data-tip value escaped for an HTML attribute. */
const tipAttr = (title: string, desc: string): string => esc(tipValue(title, desc));
const RECS_WHY = "Play back or save what you recorded in this session. Recordings are kept in memory until LUCID closes.";

/** P-VIZ.5 (ADR-0629): the header's densities, widest first; fitHead takes the first that fits on one row. */
const HEAD_FITS = ["wide", "medium", "narrow"] as const;
type HeadFit = (typeof HEAD_FITS)[number];
let headFit: HeadFit = "wide";
let headRo: ResizeObserver | null = null;

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
  outputs.clear(); sending.clear(); lastLanes = [];
  demo = new URLSearchParams(location.search).get("vizDemo") === "1" ? createDemo(now) : null; // the DEMO feed: only ever through the URL
  demoPrev = now;
  ($("[data-viz-demo]", view) as HTMLElement).hidden = !demo;
  if (!demo) offBus = vizBus.on(onBus);
  // P-VIZ.6: the demo (and only the demo, through the URL) exposes where each node is on screen, so a real-UI
  // check (desktop/scripts/demo_p_viz_6.mjs) can click an agent the way a user would. Read-only.
  // P-VIZ.7 (ADR-0641): ?vizScript=1 (a recorded walkthrough over real agents) gets the same read-only probe plus
  // scripted camera shots. Neither is reachable without the URL flag.
  const scripted = new URLSearchParams(location.search).get("vizScript") === "1";
  if (demo || scripted) (window as unknown as { __vizProbe?: unknown }).__vizProbe = {
    // P-VIZ.7 (ADR-0641): the sponsor and size class each figure wears, and whether it is committing right now.
    nodes: () => (model ? [...model.nodes.values()].map((n) => {
      const b = vizBrandFor(n.model);
      return { id: n.id, kind: n.kind, name: n.name, box: scene?.screenBoxOf(n.id) ?? null, brand: b?.key ?? null, size: b?.size ?? null, committing: committing(n, Date.now()) };
    }) : []),
    ...(scripted ? { shot: (id: string | null, opts?: Parameters<VizSceneHandle["scriptShot"]>[1]) => scene?.scriptShot(id, opts) } : {}),
  };
  if (!!demo !== ledgerIsDemo) { ledger = createLedger(); ledgerIsDemo = !!demo; mainFolder = null; }
  loadMainFolder();
  ledgerView = mountLedger($("[data-viz-stage]", view) as HTMLElement, () => !!motionMq?.matches);
  const rows = ledgerRows(ledger); // what this session already counted; the scene's nodes join on the first tick
  ledgerView.paint(rows, ledgerSummary(rows));
  paintToggles();
  paintQuality();
  paintRecs();
  headRo = new ResizeObserver(fitHead);
  headRo.observe($("[data-viz-head]", view) as HTMLElement); // fires once now, then on every width change
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
  closePanel(); closePlayer(); recPop?.close(); recPop = null; viewPop?.close(); viewPop = null; hideAutoHint();
  tray?.disarm();
  offBus?.(); offBus = null;
  ledgerView?.destroy(); ledgerView = null;
  headRo?.disconnect(); headRo = null;
  stopTimers();
  for (const w of watches.values()) w.stop();
  watches.clear();
  scene?.destroy(); scene = null;
  model = null; demo = null; hover = null;
  outputs.clear(); sending.clear(); lastLanes = [];
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
    <header class="orbit-head viz-head" data-viz-head data-viz-density="wide">
      <div class="orbit-title">${icon("visualize", 17)}<b>Visualize</b><span class="orbit-sub">agents and token flow</span><span class="viz-demo" data-viz-demo hidden>DEMO</span></div>
      <div class="viz-census" data-viz-census aria-live="polite"></div>
      <span class="orbit-headgap"></span>
      <div class="viz-seg" role="group" aria-label="View">
        <button type="button" data-viz-view="2d" aria-label="2D" data-tip="${tipAttr("2D", "Top-down map: pan and zoom. The Orbit layout here is the Fleet orbit itself.")}">${icon("view2d", 14)}<span>2D</span></button>
        <button type="button" data-viz-view="3d" aria-label="3D" data-tip="${tipAttr("3D", "Orbit around the agents: drag to rotate, right-drag to pan, scroll to zoom.")}">${icon("view3d", 14)}<span>3D</span></button>
      </div>
      <div class="viz-seg" role="group" aria-label="Style">
        <button type="button" data-viz-style="anime" aria-label="Anime" data-tip="${tipAttr("Anime", "Every agent is a mini Lucid in a glass cube, with plasma flowing between them.")}">${icon("styleAnime", 14)}<span>Anime</span></button>
        <button type="button" data-viz-style="professional" aria-label="Professional" data-tip="${tipAttr("Professional", "Office workers at their desks, Main as the boss in the middle, fiber optic lines between them.")}">${icon("stylePro", 14)}<span>Professional</span></button>
      </div>
      <label class="viz-auto" data-tip="${tipAttr("Auto camera", "Follows the action: the camera glides to the agent working hardest, and briefly to a kill or a failed tool. Drag, pan or zoom to take the camera yourself; this turns off until you check it again.")}"><input type="checkbox" data-viz-auto aria-label="Auto camera" checked>${icon("autoCamera", 14)}<span>Auto camera</span></label>
      <button type="button" class="btn-mini orbit-btn" data-viz-fit aria-label="Fit everything in view" data-tip="${tipAttr("Fit", "Bring every node back into view. Takes the camera off auto.")}">${icon("center", 13)}</button>
      <button type="button" class="btn-mini orbit-btn" data-viz-viewmenu aria-haspopup="true">${icon("gauge", 13)}<span>View</span></button>
      <button type="button" class="btn-mini orbit-btn viz-rec-btn" data-viz-rec></button>
      <button type="button" class="btn-mini orbit-btn" data-viz-recs aria-label="Recordings" data-tip="${tipAttr("Recordings", RECS_WHY)}">${icon("play", 13)}<span>Recordings</span><b class="orbit-ghost-n" data-viz-recn hidden></b></button>
      <button type="button" class="btn-mini orbit-btn orbit-x" data-viz-close aria-label="Close Visualize" data-tip="${tipAttr("Close (Esc)", "Your agents keep running; this view only watches them.")}">${icon("close", 13)}</button>
    </header>
    <div class="viz-stage" data-viz-stage>
      <div class="viz-state" data-viz-loading><span class="viz-spin" aria-hidden="true"></span><p>Starting the 3D view</p></div>
      <div class="viz-state viz-error" data-viz-error hidden role="alert"><p data-viz-error-msg></p><button type="button" class="btn-mini" data-viz-retry>Try again</button></div>
      <p class="viz-caption" data-viz-empty hidden>Main is idle. Start an agent or send a prompt to see tokens flow.</p>
      <div class="viz-recind" data-viz-recind hidden><i aria-hidden="true"></i><b>REC</b><span data-viz-rectime>0:00</span><span class="viz-rec-cap">stops at 2:00</span></div>
      <p class="viz-auto-hint" data-viz-auto-hint hidden role="status">You have the camera. Check Auto camera to hand it back.</p>
      <div class="viz-legend" data-viz-legend aria-label="Roles"></div>
      <div class="viz-tip" data-viz-tip hidden role="status"></div>
      <div class="viz-panel" data-viz-panel hidden role="dialog" aria-label="Agent">
        <div class="viz-panel-card">
          <div class="viz-panel-h">
            <i class="viz-panel-dot" aria-hidden="true"></i>
            <div class="viz-panel-id"><b data-viz-panel-name></b><span data-viz-panel-sub></span></div>
            <button type="button" class="viz-panel-btn" data-viz-panel-expand></button>
            <button type="button" class="viz-panel-btn" data-viz-panel-close aria-label="Close this panel" data-tip="${tipAttr("Close (Esc)", "The agent keeps working.")}">${icon("close", 12)}</button>
          </div>
          <div class="viz-panel-st" data-viz-panel-st></div>
          <div class="viz-panel-out" data-viz-panel-out></div>
          <div class="viz-panel-acts" data-viz-panel-acts></div>
          <form class="viz-panel-ask" data-viz-panel-form>
            <textarea class="viz-panel-in" data-viz-panel-input rows="2" aria-label="Message this agent"></textarea>
            <button type="submit" class="viz-panel-send" data-viz-panel-send aria-label="Send">${icon("send", 13)}</button>
          </form>
          <p class="viz-panel-note" data-viz-panel-note role="status"></p>
        </div>
      </div>
      <div class="viz-player" data-viz-player hidden>
        <div class="viz-player-head"><b data-viz-player-title>Recording</b><span class="viz-player-meta" data-viz-player-meta></span><span class="orbit-headgap"></span>
          <button type="button" class="btn-mini orbit-btn" data-viz-player-save>${icon("download", 13)} Save</button>
          <button type="button" class="btn-mini orbit-btn" data-viz-player-close>${icon("close", 13)} Back to live</button></div>
        <video class="viz-video" data-viz-video controls playsinline></video>
      </div>
    </div>
  </div>`);
  v.addEventListener("click", onViewClick);
  v.addEventListener("change", (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.matches("[data-viz-auto]")) setAutoCamera(t.checked, false);
  });
  // The panel's prompt: Enter sends, Shift+Enter is a new line (the composer's convention).
  v.addEventListener("submit", (ev) => { if ((ev.target as HTMLElement).matches("[data-viz-panel-form]")) { ev.preventDefault(); void sendFromPanel(); } });
  v.addEventListener("keydown", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.matches("[data-viz-panel-input]") && ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); void sendFromPanel(); }
  });
  tray = mountThrowTray($("[data-viz-stage]", v) as HTMLElement, () => scene, prefs.style); // P-VIZ.6 (ADR-0636)
  return v;
}

function onViewClick(ev: Event): void {
  const t = ev.target as HTMLElement;
  if (t.closest("[data-viz-close]")) { closeViz(); return; }
  const vb = t.closest("[data-viz-view]") as HTMLElement | null;
  if (vb) { prefs.view = vb.dataset.vizView === "2d" ? "2d" : "3d"; savePrefs(); paintToggles(); scene?.setView(prefs.view); return; }
  const sb = t.closest("[data-viz-style]") as HTMLElement | null;
  if (sb) { prefs.style = sb.dataset.vizStyle === "professional" ? "professional" : "anime"; savePrefs(); paintToggles(); scene?.setStyle(prefs.style); tray?.setStyle(prefs.style); return; }
  if (t.closest("[data-viz-fit]")) { if (autoCam) setAutoCamera(false, true); scene?.fit(); return; }
  const vm = t.closest("[data-viz-viewmenu]") as HTMLElement | null;
  if (vm) { openViewMenu(vm); return; }
  if (t.closest("[data-viz-rec]")) { if (rec) stopRec("user"); else startRec(); return; }
  const recsBtn = t.closest("[data-viz-recs]") as HTMLElement | null;
  if (recsBtn) { openRecs(recsBtn); return; }
  if (t.closest("[data-viz-retry]")) { remount(); return; }
  if (t.closest("[data-viz-player-close]")) { closePlayer(); return; }
  if (t.closest("[data-viz-player-save]")) { const r = recordings.find((x) => x.id === playingId); if (r) saveRec(r); return; }
  if (t.closest("[data-viz-panel-close]")) { closePanel(); return; }
  if (t.closest("[data-viz-panel-expand]")) { expandPanel(); return; }
  const act = t.closest("[data-viz-act]") as HTMLElement | null;
  if (act) { void runAction(act.dataset.vizNode ?? "", act.dataset.vizAct as VizAsk, act); return; }
}

/** Layout and Quality, folded out of the header so it stays one row (UX checklist: complexity budget). A narrow
 *  header (P-VIZ.5) folds Record and Recordings in here too. */
function openViewMenu(anchor: HTMLElement): void {
  if (viewPop) { viewPop.close(); viewPop = null; return; }
  const recRows = headFit === "narrow" ? `<div class="viz-vmenu-h">Record</div>
    <div class="viz-vmenu-row">
      <button type="button" class="btn-mini orbit-btn viz-rec-btn" data-viz-rec></button>
      <button type="button" class="btn-mini orbit-btn" data-viz-recs data-tip="${tipAttr("Recordings", RECS_WHY)}">${icon("play", 13)}<span>Recordings</span><b class="orbit-ghost-n" data-viz-recn hidden></b></button>
    </div>` : "";
  const p = popover(anchor, `<div class="viz-vmenu">
    <div class="viz-vmenu-h">Layout</div>
    <div class="viz-seg" role="group" aria-label="Layout">
      <button type="button" data-viz-layout="orbit" data-tip="${tipAttr("Orbit layout", "Main at the center and the agents on the Fleet orbit's ring; each agent's subagents on a small ring around it.")}">Orbit</button>
      <button type="button" data-viz-layout="constellation" data-tip="${tipAttr("Constellation", "The agents spread around Main in 3D, each with its subagents clustered close.")}">Constellation</button>
    </div>
    <div class="viz-vmenu-h">Quality</div>
    <button type="button" class="btn-mini orbit-btn" data-viz-quality></button>
    ${recRows}
  </div>`, () => { viewPop = null; });
  viewPop = p;
  paintViewMenu();
  paintRecs();
  p.node.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const lb = t.closest("[data-viz-layout]") as HTMLElement | null;
    if (lb) { prefs.layout = lb.dataset.vizLayout === "constellation" ? "constellation" : "orbit"; savePrefs(); paintViewMenu(); syncScene(); if (!autoCam) scene?.fit(); return; } // auto glides to the new layout itself
    if (t.closest("[data-viz-quality]")) { cycleQuality(); return; }
    if (t.closest("[data-viz-rec]")) { if (rec) stopRec("user"); else startRec(); return; }
    if (t.closest("[data-viz-recs]")) { p.close(); viewPop = null; openRecs(anchor); }
  });
}

/** P-VIZ.5 (ADR-0629): the widest header density whose row fits without overflowing (measured, so a long
 *  census, the DEMO badge or a Stop label are all accounted for). The writes and reads run in one task, so no
 *  intermediate density is ever painted. */
function fitHead(): void {
  const head = view ? ($("[data-viz-head]", view) as HTMLElement | null) : null;
  if (!head?.clientWidth) return;
  for (const f of HEAD_FITS) {
    headFit = f;
    // Not "data-viz-fit": that is the Fit button's hook, and the click router's closest("[data-viz-fit]") matched
    // this header, so every header button below the toggles (Record, Recordings, View) ran Fit instead.
    head.dataset.vizDensity = f;
    if (head.scrollWidth <= head.clientWidth + 1) break;
  }
  const narrow = headFit === "narrow";
  const vm = $("[data-viz-viewmenu]", head) as HTMLElement;
  vm.setAttribute("aria-label", narrow ? "View options: layout, quality and recording" : "View options: layout and quality");
  vm.setAttribute("data-tip", tipValue("View", narrow ? "Layout, Quality, Record and Recordings." : "Layout (Orbit or Constellation) and Quality."));
}

/** Turn the auto camera on or off (the checkbox, Fit, or the user grabbing the camera) and remember it. */
function setAutoCamera(on: boolean, hint: boolean): void {
  autoCam = on;
  try { localStorage.setItem(AUTO_KEY, on ? "1" : "0"); } catch { /* still applies for this session */ }
  paintToggles();
  scene?.setAuto(on);
  if (on) hideAutoHint(); else if (hint) showAutoHint();
}

/** The scene saw the user drag, pan or zoom: it already handed the camera over. */
function onUserCamera(): void {
  if (autoCam) setAutoCamera(false, true);
}

/** "You have the camera" for a few seconds, under the checkbox. */
function showAutoHint(): void {
  if (!view) return;
  const hint = $("[data-viz-auto-hint]", view) as HTMLElement;
  const box = $(".viz-auto", view) as HTMLElement;
  const stage = $("[data-viz-stage]", view) as HTMLElement;
  hint.hidden = false;
  const r = box.getBoundingClientRect(), s = stage.getBoundingClientRect();
  hint.style.left = `${Math.max(8, Math.min(s.width - hint.offsetWidth - 8, r.left - s.left))}px`;
  window.clearTimeout(autoHintTimer);
  autoHintTimer = window.setTimeout(hideAutoHint, AUTO_HINT_MS);
}

function hideAutoHint(): void {
  window.clearTimeout(autoHintTimer); autoHintTimer = 0;
  const hint = view ? ($("[data-viz-auto-hint]", view) as HTMLElement | null) : null;
  if (hint) hint.hidden = true;
}

function paintToggles(): void {
  if (!view) return;
  ($("[data-viz-auto]", view) as HTMLInputElement).checked = autoCam;
  for (const b of view.querySelectorAll<HTMLElement>("[data-viz-view]")) { const on = b.dataset.vizView === prefs.view; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }
  for (const b of view.querySelectorAll<HTMLElement>("[data-viz-style]")) { const on = b.dataset.vizStyle === prefs.style; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }
}

/** The View menu's layout toggle and quality button (only while the menu is open). */
function paintViewMenu(): void {
  const menu = viewPop?.node;
  if (!menu) return;
  for (const b of menu.querySelectorAll<HTMLElement>("[data-viz-layout]")) { const on = b.dataset.vizLayout === prefs.layout; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }
  paintQuality();
}

function paintQuality(): void {
  const b = viewPop ? ($("[data-viz-quality]", viewPop.node) as HTMLElement | null) : null;
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
    scene = mountVizScene(stage, vizTierOpts(deps.perf.tier(), !!motionMq?.matches), theme, prefs.view, autoCam);
  } catch (e) {
    scene = null;
    loading.hidden = true;
    showError(`The 3D view could not start on this machine: ${e instanceof Error ? e.message : String(e)}. Your agents are not affected.`);
    return;
  }
  scene.onHover(onHover);
  scene.onPick(onPick);
  scene.onDoublePick(onDoublePick);
  scene.onUserCamera(onUserCamera);
  scene.setStyle(prefs.style);
  tray?.attach(); // an armed throwable survives a remount (quality, theme, motion change)
  scene.onLost(() => { scene?.destroy(); scene = null; showError("The graphics driver reset the 3D view. Your agents are not affected."); });
  syncScene();
  requestAnimationFrame(() => requestAnimationFrame(() => { loading.hidden = true; }));
  scene.canvas.focus({ preventScroll: true });
}

function remount(): void {
  if (!isOpen()) return;
  if (rec) stopRec("quality");
  hideTip(); // the node panel stays: it finds its node again on the new scene
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
  const m = model;
  const nodes: SceneNode[] = list.map((n) => {
    const team = n.kind === "subagent" ? null : teamOf(m, n.id); // P-VIZ.4: an idle node with a working team supervises
    return {
      id: n.id, kind: n.kind, persona: n.persona, label: n.kind === "hub" ? "Main" : n.label, status: n.status,
      pos: pos.get(n.id) ?? [0, 0, 0], glow: nodeIntensity(n, now),
      team: team ? team.agents + team.subagents : 0, idleSec: idleSeconds(n, now),
      model: n.model, committing: committing(n, now), // P-VIZ.7 (ADR-0641): sponsor and the commit animation
    };
  });
  scene.sync(nodes, edgesOf(model, now));
}

// ---------------------------------------------------------------------------------------------- feeds

/** One tapped event: the model takes it (or drops a second stream's copy), and a lane's panel output
 *  follows exactly what the model took. */
function onBus(ev: VizBusEvent): void {
  if (!model || !applyEvent(model, ev, Date.now())) return;
  noteLedger(ev);
  if (ev.source === HUB_ID) return;
  let out = outputs.get(ev.source);
  if (!out) { out = createOutput(); outputs.set(ev.source, out); }
  foldOutput(out, ev.e);
}

/** P-VIZ.6 (ADR-0635): an event the model took also counts in the session ledger, on the node it came from. */
function noteLedger(ev: VizBusEvent): void {
  const n = model?.nodes.get(ev.source);
  if (n) ledgerEvent(ledger, n, ev.e, Date.now());
}

/** The ledger follows the scene's nodes and repaints (twice a second, with the census). */
function paintLedger(now: number): void {
  if (!model || !ledgerView) return;
  syncLedger(ledger, model.nodes.values(), now);
  ledgerFolder(ledger, HUB_ID, mainFolder);
  const rows = ledgerRows(ledger);
  ledgerView.paint(rows, ledgerSummary(rows));
}

/** Main works in the current workspace (the demo: its scripted folder). Read on every open and on a new hub
 *  session, so a workspace switch shows up. */
function loadMainFolder(): void {
  if (demo) { mainFolder = demo.cwd(HUB_ID); return; }
  void bridge.workspace().then((w) => { if (w?.current && !demo) mainFolder = w.current; }).catch(() => { /* the folder stays as it was */ });
}

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
    for (const e of st.events) if (applyEvent(model, e, now)) noteLedger(e);
  }
  tick(model, now);
  const fresh = drainEvents(model);
  syncScene();
  if (fresh.length) scene?.fire(fresh);
  if (now - censusAt >= 500) {
    censusAt = now;
    paintCensus(now);
    paintLedger(now);
    if (hover) paintTip(hover.hit, hover.x, hover.y);
    if (panel) paintPanel();
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
    const now = Date.now(), lanes = demo.lanes(now);
    applyFleet(m, lanes, now, "anthropic/claude-opus-4.6");
    syncLedger(ledger, m.nodes.values(), now);
    ledgerFleet(ledger, lanes.map((l) => ({ id: l.id, session: null, folder: demo!.cwd(l.id) })), now);
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
    // P-VIZ.6 (ADR-0635): a new hub session starts the ledger over (Main's folder is fetched again); each lane
    // brings its session, its repo (else its folder) and its measured usage.
    const now = Date.now();
    if (ledgerHub(ledger, st.hub)) loadMainFolder();
    syncLedger(ledger, m.nodes.values(), now);
    ledgerFleet(ledger, mine.map((l) => ({ id: l.id, session: l.sessionId, folder: l.repo?.repo?.root ?? l.cwd, ...(l.usage ? { usage: l.usage } : {}) })), now);
    lastLanes = mine;
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
  // P-VIZ.4 (ADR-0625): a lane's delegations run in the background, so only its own runs say when each ends.
  // Lanes with live subagents first, then working lanes (a delegation an unwatched lane made shows up this
  // way too). Never while the window is hidden: the backed-off cadence below covers Main alone.
  if (!document.hidden) {
    const live = new Set([...m.nodes.values()].filter((n) => n.kind === "subagent" && (n.status === "active" || n.status === "idle")).map((n) => n.parent));
    const lanes = [...m.nodes.values()]
      .filter((n) => n.kind === "agent" && n.goneAt === null && (live.has(n.id) || n.status === "active" || n.status === "waiting"))
      .sort((a, b) => Number(live.has(b.id)) - Number(live.has(a.id)))
      .slice(0, LANE_RUNS_MAX);
    for (const lane of lanes) {
      const lv = await deps.subagents(lane.id).catch(() => null);
      if (model !== m) return;
      if (lv?.runs) applyRuns(m, lv.runs, Date.now(), lane.id);
    }
  }
  runsTimer = window.setTimeout(() => void pollRuns(), pollDelay(RUNS_MS, deps.perf.tier(), document.hidden));
}

/** Watch (read-only, owns no turn) the most recently active live lanes, so their streams show even when
 *  no grid card or composer has them open. A second stream for a lane is deduplicated by the model.
 *  P-VIZ.4: the lane whose panel is open is watched first (its panel shows that stream). */
function syncWatches(lanes: readonly LaneView[]): void {
  if (!deps) return;
  const shown = panel?.id ?? "";
  const live = lanes.filter((l) => l.status !== "stopped" && (l.status !== "error" || l.id === shown));
  const rank = (l: LaneView): number => (l.id === shown ? 2 : l.status === "working" || l.status === "starting" || l.status === "needs-approval" || l.status === "awaiting-input" ? 1 : 0);
  const want = new Set(live.sort((a, b) => rank(b) - rank(a) || b.lastActivityAt - a.lastActivityAt).slice(0, WATCH_MAX).map((l) => l.id));
  for (const [id, w] of [...watches]) if (!want.has(id)) { w.stop(); watches.delete(id); }
  for (const id of want) {
    if (watches.has(id)) continue;
    const w = deps.fleetWatch(id, (e: LaneEvent) => onBus({ source: id, origin: "watch", e }));
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
  const agents = `${c.agents} agent${c.agents === 1 ? "" : "s"}`;
  const subs = `${c.subagents} subagent${c.subagents === 1 ? "" : "s"}`;
  // P-VIZ.5 (ADR-0629): the full chips, and the one chip a medium or narrow header shows instead (styles.css).
  const one = `<span class="viz-chip viz-census-one${c.tapped ? " hot" : ""}" data-tip="${tipAttr("Census", `${agents}, ${subs}, ${rate}.`)}">${esc(`${agents} \u00b7 ${c.subagents} sub \u00b7 ${c.tapped ? fmtRate(c.tokps) : "no stream"}`)}</span>`;
  const html = fleetOffline && !demo
    ? chip("Fleet status unavailable", " warn")
    : `<span class="viz-census-full">${chip(agents) + chip(subs) + chip(rate, c.tapped ? " hot" : "")}</span>${one}`;
  if (censusSig !== html) { censusSig = html; box.innerHTML = html; fitHead(); } // not innerHTML: the browser re-serializes the tip attribute
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
    ({ title, lines } = describeNode(n, now, n.kind === "subagent" ? undefined : teamOf(model, n.id)));
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

/** A click on a node: its figure stares at you (an interruption) and its panel opens beside it. Empty space
 *  closes the panel. P-VIZ.6 (ADR-0636): while a throwable is armed the click throws it instead (at a node; on
 *  empty space nothing happens). */
function onPick(hit: SceneHit | null): void {
  if (tray?.release(hit)) return;
  if (!hit || hit.kind !== "node") { closePanel(); return; }
  scene?.reactNode(hit.id, "stare");
  openPanel(hit.id);
}

/** A double click: an outburst at being interrupted that hard. Opens nothing; the work goes on. */
function onDoublePick(hit: SceneHit | null): void {
  if (hit?.kind === "node") scene?.reactNode(hit.id, "outburst");
}

const panelEl = (sel: string): HTMLElement => $(sel, view!) as HTMLElement;

function openPanel(id: string): void {
  if (!view || !model) return;
  const n = model.nodes.get(id);
  if (!n) return;
  hideTip();
  if (panel?.id !== id) {
    if (panel) { cancelAnimationFrame(panel.raf); window.clearTimeout(panel.flipTimer); }
    killArm = null;
    panel = { id, raf: 0, outSig: "", headSig: "", note: "", box: null, side: null, flipTimer: 0 };
    (panelEl("[data-viz-panel-input]") as HTMLTextAreaElement).value = "";
    panelEl("[data-viz-panel-out]").scrollTop = 0;
  }
  panelEl("[data-viz-panel]").hidden = false;
  paintPanel();
  if (n.kind === "agent" && !demo) {
    syncWatches(lastLanes); // this lane's stream first
    if (!outputs.get(id)?.seeded) void loadTranscript(id);
  }
  followPanel();
  const input = panelEl("[data-viz-panel-input]") as HTMLTextAreaElement;
  (input.disabled ? panelEl("[data-viz-panel-close]") : input).focus({ preventScroll: true });
}

function closePanel(): void {
  if (!panel || !view) { panel = null; return; }
  cancelAnimationFrame(panel.raf);
  window.clearTimeout(panel.flipTimer);
  panel = null;
  killArm = null;
  const box = panelEl("[data-viz-panel]");
  box.hidden = true;
  box.classList.remove("flip");
  panelEl("[data-viz-panel-out]").innerHTML = "";
  panelEl("[data-viz-panel-acts]").innerHTML = "";
  if (box.contains(document.activeElement)) scene?.canvas.focus({ preventScroll: true });
}

/** A lane nobody streamed yet: its bounded history (the grid card's catch-up seed), kept under any live text. */
async function loadTranscript(id: string): Promise<void> {
  if (!deps) return;
  const t = await deps.fleetTranscript(id).catch(() => null);
  if (!t || panel?.id !== id) return;
  let out = outputs.get(id);
  if (!out) { out = createOutput(); outputs.set(id, out); }
  if (out.seeded) return;
  const live = out.live;
  foldOutput(out, { type: "watch-seed", turns: t.turns });
  out.live = live;
  paintPanel();
}

function setPanelNote(text: string): void {
  if (!panel) return;
  panel.note = text;
  const note = panelEl("[data-viz-panel-note]");
  note.textContent = text;
  note.hidden = !text;
}

/** What a node's panel shows of its output: Main's last chat turn, a lane's folded stream, a subagent's task. */
function panelTurns(n: VizNode): { turns: VizTurn[]; live: string; empty: string } {
  if (n.kind === "subagent") {
    const what = n.assignment ? [{ role: "user" as const, text: n.assignment }] : [];
    return { turns: what, live: "", empty: "This subagent's task was not reported." };
  }
  if (demo) return { turns: [], live: "", empty: "DEMO: these agents are simulated and have no output." };
  if (n.kind === "hub") return { turns: deps?.mainRecent() ?? [], live: "", empty: "No chat in this session yet." };
  const out = outputs.get(n.id);
  return { turns: out?.turns.slice(-3) ?? [], live: out?.live ?? "", empty: out?.seeded ? "No output yet. Send a prompt below." : "Loading this agent's recent output..." };
}

function paintPanel(): void {
  if (!view || !model || !panel) return;
  const id = panel.id;
  const n = model.nodes.get(id);
  if (!n) { closePanel(); return; } // the node left the scene
  const now = Date.now();
  const box = panelEl("[data-viz-panel]");
  const kind = n.kind === "hub" ? "Main session" : n.kind === "agent" ? "Agent" : "Subagent";
  const d = describeNode(n, now, n.kind === "subagent" ? undefined : teamOf(model, id));
  const status = [d.lines[1] ?? "", n.kind !== "subagent" && isTapped(n, now) ? fmtRate(n.rate) : ""].filter(Boolean).join(" \u00b7 ");
  const mainBusy = n.kind === "hub" && (demo ? n.status === "active" : !!deps?.mainBusy());
  const armed = !!killArm && killArm.id === id && now < killArm.until;
  const parent = n.parent ? model.nodes.get(n.parent) : undefined;
  const ended = n.goneAt !== null || n.laneStatus === "stopped";
  const busy = n.status === "active" || n.status === "waiting" || sending.has(id);
  const headSig = [n.name, n.persona, n.kind, n.status, n.laneStatus, n.goneAt, mainBusy, armed, busy, demo ? 1 : 0, parent?.name].join("|");
  ($("[data-viz-panel-st]", box) as HTMLElement).textContent = status;
  if (headSig !== panel.headSig) {
    panel.headSig = headSig;
    box.setAttribute("aria-label", `${n.name}: ${kind}`);
    box.style.setProperty("--viz-c", PERSONAS[n.persona].color);
    panelEl("[data-viz-panel-name]").textContent = n.name;
    panelEl("[data-viz-panel-sub]").textContent = `${PERSONAS[n.persona].label} \u00b7 ${kind}`;
    const ex = panelEl("[data-viz-panel-expand]");
    const exTarget = n.kind === "subagent" ? parent : n;
    const toChat = !exTarget || exTarget.kind === "hub";
    const exWhy = onCloseCb ? "Back to the Fleet orbit, where this agent is a spoke." : toChat ? "Close Visualize and go to the main chat." : `Close Visualize and open ${exTarget?.name ?? "the agent"}'s card in the Fleet panel.`;
    ex.innerHTML = `${icon("arrowRight", 12)}<span>${toChat && !onCloseCb ? "Chat" : "Open"}</span>`;
    ex.setAttribute("aria-label", exWhy);
    ex.setAttribute("data-tip", tipValue("Expand", exWhy));
    const btn = (act: VizAsk, label: string, enabled: boolean, why: string, danger = false): string =>
      `<button type="button" class="viz-panel-act${danger ? " danger" : ""}${danger && armed ? " armed" : ""}" data-viz-act="${act}" data-viz-node="${esc(id)}"${enabled ? "" : " disabled"} data-tip="${tipAttr(label, why)}">${esc(label)}</button>`;
    let acts: string;
    if (n.kind === "subagent") {
      acts = `<p class="viz-panel-why">Subagents are view-only here: each runs for its parent and stops with it. Stop ${esc(parent?.name ?? "the parent")}'s turn to stop it.</p>`;
    } else if (n.kind === "hub") {
      acts = btn("cancel", "Stop the main turn", mainBusy, mainBusy ? "Stops Main's running turn, the same as the Stop button. The chat keeps everything so far." : "Main is not running a turn right now.");
    } else {
      const alive = n.status !== "ended" && n.status !== "killed" && n.goneAt === null;
      const running = n.status === "active" || n.status === "waiting";
      acts = btn("cancel", "Stop turn", running, running ? "Stops this agent's current turn. The agent stays and can take the next prompt." : "This agent is not running a turn.")
        + btn("end", "End agent", alive, alive ? "Stops the agent. Its card stays readable and Respawn brings it back." : "This agent has already ended.")
        + btn("kill", armed ? `Click again to kill ${n.name}` : "Kill", n.goneAt === null, "Removes the agent now, even mid-turn. Asks once more before it acts.", true);
    }
    panelEl("[data-viz-panel-acts]").innerHTML = acts;
    // The prompt box: what it does here, or why it is off.
    const input = panelEl("[data-viz-panel-input]") as HTMLTextAreaElement;
    const send = panelEl("[data-viz-panel-send]") as HTMLButtonElement;
    const off = n.kind === "subagent" ? `Subagents take no prompts: each one works for ${parent?.name ?? "its parent"}. Message ${parent?.name ?? "the parent"} instead.`
      : demo ? "DEMO: prompts are not sent to simulated agents."
      : n.kind === "agent" && ended ? "This agent has ended. Respawn it from the Fleet panel to talk to it."
      : "";
    const place = off || (n.kind === "hub" ? (mainBusy ? "Message Main (it waits for the running turn, like the composer)" : "Message Main (sent from the main composer)")
      : busy ? `Stage a prompt for ${n.name} (it runs when this turn ends)` : `Message ${n.name}`);
    input.disabled = !!off; send.disabled = !!off;
    input.placeholder = place;
    input.setAttribute("aria-label", place);
    send.setAttribute("aria-label", n.kind === "agent" && busy ? "Stage" : "Send");
    send.setAttribute("data-tip", tipValue(n.kind === "agent" && busy ? "Stage" : "Send", off || (n.kind === "agent" && busy ? `${n.name} is busy: the prompt waits in its queue and runs next.` : "Enter sends, Shift+Enter is a new line.")));
  }
  // The output: repainted only when it changed, and kept pinned to the newest line unless you scrolled up.
  const o = panelTurns(n);
  const who = (t: VizTurn): string => (t.role === "user" ? (n.kind === "subagent" ? "Task" : "You") : n.kind === "hub" ? "Main" : n.name);
  const html = o.turns.length || o.live
    ? o.turns.map((t) => `<div class="viz-panel-turn ${t.role}"><b>${esc(who(t))}</b><p>${esc(t.text.length > 1200 ? `\u2026${t.text.slice(-1200)}` : t.text)}</p></div>`).join("")
      + (o.live ? `<div class="viz-panel-turn assistant live"><b>${esc(n.kind === "hub" ? "Main" : n.name)}</b><p>${esc(o.live.length > 1600 ? `\u2026${o.live.slice(-1600)}` : o.live)}</p></div>` : "")
    : `<p class="viz-panel-empty">${esc(o.empty)}</p>`;
  if (html !== panel.outSig) {
    panel.outSig = html;
    const out = panelEl("[data-viz-panel-out]");
    const pinned = out.scrollTop + out.clientHeight >= out.scrollHeight - 12;
    out.innerHTML = html;
    if (pinned) out.scrollTop = out.scrollHeight;
  }
  setPanelNote(panel.note);
}

/** P-VIZ.5 (ADR-0629): keep the panel BESIDE its node every frame (the camera moves, the auto camera glides),
 *  on the side with more room, tilted toward the node, its tail aimed at it (viz_panel_place). A node off screen
 *  docks the panel at the nearest edge, dimmed, its tail pointing out toward the node; it never leaves the view.
 *  A side change glides (.flip) instead of jumping. */
function followPanel(): void {
  const p = panel;
  if (!p) return;
  cancelAnimationFrame(p.raf);
  let last = "";
  const step = (): void => {
    if (panel !== p || !view) return;
    const box = panelEl("[data-viz-panel]");
    const stage = panelEl("[data-viz-stage]").getBoundingClientRect();
    const seen = scene?.screenBoxOf(p.id) ?? null;
    if (seen) p.box = { x: seen.x - stage.left, y: seen.y - stage.top, r: seen.r };
    const node = p.box ?? { x: stage.width / 2, y: stage.height / 2, r: 0 }; // behind the camera since it opened
    const at = placePanel({ w: stage.width, h: stage.height }, { w: box.offsetWidth, h: box.offsetHeight }, node, p.side);
    if (p.side && at.side !== p.side) {
      box.classList.add("flip");
      window.clearTimeout(p.flipTimer);
      p.flipTimer = window.setTimeout(() => box.classList.remove("flip"), 280);
    }
    p.side = at.side;
    const lost = !seen || at.docked;
    const sig = `${at.left},${at.top},${at.side},${at.tailY},${lost ? 1 : 0}`;
    if (sig !== last) {
      last = sig;
      box.style.left = `${at.left}px`; box.style.top = `${at.top}px`;
      box.dataset.side = at.side;
      box.style.setProperty("--viz-ry", `${at.ry}deg`);
      box.style.setProperty("--viz-tail", `${at.tailY}px`);
      box.classList.toggle("lost", lost);
    }
    p.raf = requestAnimationFrame(step);
  };
  step(); // placed before the first paint, not a frame late at the stage's corner
}

/** Expand: the agent's real card in the Fleet panel (or back to the orbit it came from), Main's chat. */
function expandPanel(): void {
  if (!model || !panel || !deps) return;
  const n = model.nodes.get(panel.id);
  if (!n) return;
  const target = n.kind === "subagent" ? (n.parent ? model.nodes.get(n.parent) : undefined) : n;
  const d = deps;
  if (onCloseCb) { closeViz(); return; } // opened from the Fleet orbit: back to it, where this agent is a spoke
  closeViz();
  if (!target || target.kind === "hub") { d.focusMain(); return; }
  d.openFleet();
  revealCard(target.id, Date.now() + 3000);
}

/** Scroll the lane's Fleet card into view and flash it (the panel builds its cards on its first poll). */
function revealCard(id: string, until: number): void {
  const card = document.querySelector<HTMLElement>(`#fleetGrid .fleet-card[data-lane="${CSS.escape(id)}"]`);
  if (!card) { if (Date.now() < until) window.setTimeout(() => revealCard(id, until), 150); return; }
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  card.removeAttribute("data-fleet-flash");
  void card.offsetWidth; // restart the flash
  card.setAttribute("data-fleet-flash", "");
  window.setTimeout(() => card.removeAttribute("data-fleet-flash"), 1600);
}

/** The panel's prompt box: Main through the composer, an idle agent gets the prompt, a busy one stages it. */
async function sendFromPanel(): Promise<void> {
  if (!view || !model || !deps || !panel) return;
  const id = panel.id;
  const n = model.nodes.get(id);
  const input = panelEl("[data-viz-panel-input]") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!n || !text || input.disabled) return;
  if (n.kind === "hub") {
    const why = deps.sendMain(text);
    if (why) { setPanelNote(why); return; }
    input.value = "";
    setPanelNote("Sent to Main from the main composer.");
    return;
  }
  if (n.kind !== "agent") return;
  if (sending.has(id) || n.status === "active" || n.status === "waiting" || n.laneStatus === "starting") {
    setPanelNote(`Staging for ${n.name}...`);
    const r = await deps.fleetQueueAdd(id, text).catch(() => null);
    if (panel?.id !== id) return;
    if (!r?.ok) { setPanelNote(r?.reason ? `Not staged: ${r.reason}. Your prompt is still in the box.` : "Not staged: the engine did not answer in time. Your prompt is still in the box."); return; }
    if (input.value.trim() === text) input.value = "";
    setPanelNote(`Staged: it runs when ${n.name} finishes this turn${r.queued ? ` (${r.queued} waiting)` : ""}.`);
    return;
  }
  input.value = "";
  let out = outputs.get(id);
  if (!out) { out = createOutput(); outputs.set(id, out); }
  foldOutput(out, { type: "user", text });
  sending.add(id);
  panel.headSig = ""; // the box turns into Stage
  setPanelNote(`Sent to ${n.name}.`);
  paintPanel();
  // The lane's own events reach the view through its watch (the panel's lane is watched first); this
  // stream only reports a refusal.
  const fail = (msg: string): void => { if (panel?.id === id) setPanelNote(`${n.name} did not take the prompt: ${msg}`); };
  void deps.fleetPrompt(id, text, (e: LaneEvent) => { if (e.type === "error") fail(e.message); })
    .catch((e: unknown) => fail(e instanceof Error ? e.message : "the engine did not answer"))
    .finally(() => { sending.delete(id); if (panel?.id === id) panel.headSig = ""; });
  void pollFleet();
}

async function runAction(id: string, ask: VizAsk, btnEl: HTMLElement): Promise<void> {
  if (!model || !deps) return;
  const n = model.nodes.get(id);
  if (!n || n.kind === "subagent") return;
  if (ask === "kill" && (!killArm || killArm.id !== id || Date.now() > killArm.until)) {
    killArm = { id, until: Date.now() + 4000 };
    paintPanel();
    (panelEl("[data-viz-panel-acts]").querySelector("[data-viz-act=kill]") as HTMLElement | null)?.focus();
    return;
  }
  killArm = null;
  btnEl.blur();
  if (ask === "kill") closePanel(); // the agent is leaving the scene
  else if (panel) panel.headSig = "";
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
  if (ledgerView?.ownsFocus()) { ledgerView.collapse(); return; } // P-VIZ.6: Esc inside the ledger folds it back
  if (viewPop) { viewPop.close(); viewPop = null; return; }
  if (playerOpen()) { closePlayer(); return; }
  if (recPop) { recPop.close(); recPop = null; return; }
  if (tray?.disarm()) return; // P-VIZ.6 (ADR-0636): Esc puts an armed throwable down first
  if (panel) { closePanel(); return; }
  closeViz();
}

// ---------------------------------------------------------------------------------------------- recording

/** The Record button in the header and, while a narrow header has folded it there, in the View menu. The label
 *  is its own span so a medium header can show the icon alone (P-VIZ.5). */
function paintRec(): void {
  if (!view) return;
  for (const b of recRoots().flatMap((r) => [...r.querySelectorAll<HTMLElement>("[data-viz-rec]")])) {
    b.classList.toggle("on", !!rec);
    b.innerHTML = rec ? `${icon("square", 13)}<span>Stop</span>` : `${icon("record", 13)}<span>Record</span>`;
    b.setAttribute("aria-label", rec ? "Stop recording" : "Record the visualization");
    b.setAttribute("data-tip", rec ? tipValue("Stop recording", "Keeps the clip in Recordings.") : tipValue("Record", "Captures this view as a video (up to 2 minutes) that you can play back here or save."));
  }
  ($("[data-viz-recind]", view) as HTMLElement).hidden = !rec;
  fitHead(); // Stop and Record differ in width
}

/** Where Record and Recordings live: the header, and the View menu while it is open. */
const recRoots = (): HTMLElement[] => [view, viewPop?.node].filter((r): r is HTMLElement => !!r);

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
  for (const n of recRoots().flatMap((r) => [...r.querySelectorAll<HTMLElement>("[data-viz-recn]")])) { n.hidden = recordings.length === 0; n.textContent = String(recordings.length); }
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
  closePanel(); hideTip();
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
