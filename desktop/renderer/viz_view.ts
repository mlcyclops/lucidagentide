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
// P-VIZ.NOFLASH1: a remount (quality, theme, motion, a restored GPU context) never shows a blank frame: the scene on
// screen stays as the `outgoing` picture (relieved to the new tier at once) above the new canvas until the new scene
// reports its first whole frame; the Auto step-down is spaced by perf_tier.mayStepDown and lands on supportedTier. A
// saved world not loaded yet holds the first mount (an opaque spinner on its last backdrop), so the scene never shows
// anime first and then pops to the world.
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
//
// P-WORLDS.1 (ADR-0648): the style toggle's Worlds button lists the installed Lucid Agent Worlds (viz_worlds:
// loaded, validated, entitled), selects one (scene.setStyle(`world:<key>`), tray.setStyle), shows "Get" with a
// lock for a world this account has not bought (the Plugins store, deps.openStore), the error of a world that
// cannot be shown, Export... (the signed package file) per world, Import world file... and Get more worlds. The
// View menu gains the selected world's options; a change saves it and rebuilds the figures. A saved world style
// draws as anime until its world loads (and stays saved if it is gone).
//
// P-WORLDS.CAST2 (ADR-0650): while a world is drawn the View menu has a Cast section (Balanced fleet or Same for
// all, a 10-shade skin ramp with warm, neutral and cool undertones, a hair-color ramp, hair style chips) and the
// node panel of the hub or a lane has "Customize look" (pin that node's presentation, skin, hair style and hair
// color). Both persist in viz_cast_prefs (lucid.viz.cast.v1) and rebuild the figures (scene.setCast). A world's
// `swatch` options draw as the same swatch buttons.
//
// P-WORLDS.BUILD1 (ADR-0653): every event the model takes also feeds the build book (viz_build_model): a subagent
// spawn adds scaffold pieces at the node's build site (the world's buildSites, else a holo ring beside the stage;
// viz_build.createScaffold riding the node through scene.anchor), a settled tool locks one in, a failed one flickers
// it red, and done or a commit reveals the build. A build with an artifact puts a chip over its node that opens the
// artifact popup (viz_artifact_popup: the engine's security gate first, then a sandboxed frame). The node panel of
// the hub or a live lane offers the world's mini-game templates (miniGames, else the host's two): one starts the
// brief as an ordinary prompt through the panel's own send path, and only that run's output can become an artifact.
// The ?vizDemo=1 feed plays one build per demo agent on a separate build channel, each ending in a labeled sample.
// P-WORLDS.BUILD2: each template row has Build and, when the template carries a `sample`, Play sample (the popup,
// labeled Sample, through the same gate and sandbox); the demo's builds rotate through the current world's samples.
//
// P-VIZ.APPROVE1 (ADR-0655): tool-call approvals (viz_approvals over viz_model's per-node asks): a pulsing badge over
// every node with an open ask, its pop-out (Approve, Auto, Deny through the grid card's and the chat card's own paths),
// the triage strip at the top of the stage, and View > Fly to approvals (persisted, on by default) that flies the
// camera to a new ask without moving focus. The node panel and the pop-out never show at once.
//
// P-PREVIEW.CHIP1: every agent whose preview loads or is ready (and the hub, for the composer's) gets the one preview
// chip (preview_chip.ts) beside its node, stacked over its artifact chip, with a hover card (title, path, Open
// preview, the agent's snapshots). A click flies the Preview panel out OVER this view (#preview.over-viz, z 94),
// resizable as in the composer, while the world keeps running. Its X, Esc or a press back on the world slides it away
// and focus returns to the chip; while it is up this dialog is not modal and Esc closes the panel before anything here.

import { $, el } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { popover, showToast } from "./ui.ts";
import { tipValue } from "./tip_text.ts";
import { bridge, type LaneEvent, type LaneView, type LucidBridge } from "./bridge.ts";
import { mayStepDown, pollDelay, supportedTier, type GovernorStats, type PerfTierWatcher } from "./perf_tier.ts";
import { vizBus, type VizBusEvent } from "./viz_bus.ts";
import { createDemo, type VizDemo } from "./viz_demo.ts";
import { artifactPopupState, closeArtifactPopup, mountArtifactChips, openArtifactPopup, type ArtifactChips } from "./viz_artifact_popup.ts"; // P-WORLDS.BUILD1 (ADR-0653)
import { mountWorldPreviewChips, type WorldChips } from "./preview_chip.ts"; // P-PREVIEW.CHIP1: the agents' preview chips
import type { ChipState } from "./preview_curtain.ts";
import type { WorldBuddySource } from "./agent_buddy.ts"; // P-BUDDY.1 (ADR-0667)
import type { WorldSpinupSource } from "./agent_spinup.ts"; // P-SPINUP.1 (ADR-0668)
import { createScaffold } from "./viz_build.ts";
import { adoptArtifact, armSample, armTemplate, artifactOf, buildEvent, buildSiteFor, createBuildBook, demoSampleAt, discardArtifact, dropBuild, keepArtifact, miniGamesFor, sampleArtifact, type BuildStep } from "./viz_build_model.ts";
import type { WorldDefinition, WorldScaffold } from "./viz_world_api.ts";
import { vizBrandFor } from "./viz_brand.ts"; // P-VIZ.7 (ADR-0641): the demo probe reports each figure's sponsor
import { mountLedger, type LedgerView } from "./viz_ledger.ts";
import { createLedger, ledgerEvent, ledgerFleet, ledgerFolder, ledgerHub, ledgerRows, ledgerSummary, syncLedger } from "./viz_ledger_model.ts";
import {
  applyEvent, applyFleet, applyRuns, census, committing, createOutput, createVizState, describeNode, drainEvents, drainNewApprovals, edgesOf, fmtRate, foldOutput, HUB_ID, idleSeconds,
  isBuiltinStyle, isTapped, layoutPositions, markAsked, nodeIntensity, PERSONAS, teamOf, tick, vizTierOpts,
  type Persona, type VizApproval, type VizAsk, type VizEvent, type VizLayout, type VizNode, type VizOutput, type VizState, type VizStyle, type VizTurn,
} from "./viz_model.ts";
import { placePanel, type NodeBox, type PanelSide } from "./viz_panel_place.ts";
import { mountApprovals, type ApprovalsView } from "./viz_approvals.ts"; // P-VIZ.APPROVE1 (ADR-0655)
import { mountVizScene, type SceneHit, type SceneNode, type SceneWorld, type VizSceneHandle, type VizTheme, type VizViewMode } from "./viz_scene.ts";
import { mountThrowTray, type ThrowTray } from "./viz_throw.ts";
import { getMarketProvider } from "./market_gate.ts";
import { createWorldHost } from "./viz_world_kit.ts";
import { kitLineup, type KitLineupReport } from "./viz_world_character_lineup.ts"; // P-WORLDS.KIT2 (ADR-0654): the demo probe's lineup
import { worldKey, type InstalledWorld, type WorldOption } from "./viz_world_api.ts";
import { loadOptions, loadWorlds, parseStyle, saveOption, savedWorldState, worldEnvironment, worldStyle, worldUsable, type WorldEntry } from "./viz_worlds.ts";
import { rowUpdate, type WorldUpdates } from "./world_updates.ts"; // P-WORLDS.UPDATE1 (ADR-0685)
import { HAIR_STYLES, HAIR_SWATCHES, SKIN_NAMES, SKIN_RAMP, skinTone, UNDERTONES, type HairStyle, type Presentation, type Undertone } from "./viz_cast.ts"; // P-WORLDS.CAST2 (ADR-0650)
import { loadCastPrefs, pinOf, PRESENTATIONS, saveCastPrefs, withFleet, withPin, type CastPin, type CastPrefs, type FleetCast } from "./viz_cast_prefs.ts";

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
  /** P-WORLDS.1 (ADR-0648): open the Plugins drawer on its premium store ("Get" on a world, "Get more worlds");
   *  `packId` names the world the user asked for. */
  openStore: (packId?: string) => void;
  /** P-WORLDS.UPDATE1 (ADR-0685): purchased worlds with a newer store version (world_updates.createWorldUpdates):
   *  each row's Update, the Worlds button's dot, and a refresh once a new version is on disk. */
  worldUpdates: Pick<WorldUpdates, "pending" | "busy" | "update" | "reconcile" | "onChange">;
  /** P-VIZ.APPROVE1 (ADR-0655): the approval pop-out's answers: a lane's like its grid card (fleetAnswer, and Auto
   *  through the grid's risk modal then fleetAuto), Main's through its chat card (null option = deny). */
  fleetAnswer: LucidBridge["fleetAnswer"];
  fleetAuto: LucidBridge["fleetAuto"];
  autoRiskModal: (onAccept: (allLanes: boolean) => void) => void;
  respondMain: (id: string, optionId: string | null) => void;
  /** P-PREVIEW.CHIP1: the Preview panel, from a node's preview chip. `open` swings it out OVER this view on that
   *  agent's tab ("main": the composer's Agent tab), `close` slides it back, `isOver` says it is up over this view,
   *  and `viewClosed` tells the app this view closed under it (the panel drops back to its side-panel tier). */
  preview: { open: (target: string, chip: HTMLElement) => void; close: () => void; isOver: () => boolean; viewClosed: () => void };
  /** P-BUDDY.1 (ADR-0667): floating Agent buddies beside each lane node (agent_buddy.attachWorlds); returns the detach. */
  attachBuddies: (stage: HTMLElement, src: WorldBuddySource) => () => void;
  /** P-SPINUP.1 (ADR-0668): a walking mini Lucid over each lane node still starting (agent_spinup.attachWorlds); returns the detach. */
  attachSpinup: (stage: HTMLElement, src: WorldSpinupSource) => () => void;
}

const POLL_MS = 2500; // the orbit's fleet cadence
/** P-FLEET.CONN1: how long one fleet poll waits for its reply before the chain moves on. */
const FLEET_WAIT_MS = 10_000;
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
/** P-VIZ.NOFLASH1: the scene a remount replaces. Every call goes to `scene` (the new one, rendering beneath); this one
 *  stays on top as the picture, relieved to the new tier's lighter settings and deaf to the pointer, until the new
 *  scene's first whole frame, then goes. Never a blank frame between them. */
let outgoing: VizSceneHandle | null = null;
/** P-VIZ.NOFLASH1: a lost WebGL context waits this long for the browser to restore it before the error shows. */
const RESTORE_WAIT_MS = 5000;
/** P-VIZ.NOFLASH1: one rebuild per loss; a loss again this soon after a restore is a crash loop, and the error shows. */
const RESTORE_AGAIN_MS = 60_000;
const LOST_MSG = "The graphics driver reset the 3D view. Your agents are not affected.";
let restoreTimer = 0;
let restoredAt = -Infinity;
/** P-VIZ.NOFLASH1: when the governor last stepped Auto down (perf_tier.mayStepDown spaces them). */
let lastStepAt = -Infinity;
/** P-VIZ.NOFLASH1: the saved style is a world not loaded yet. The scene mounts once the worlds have loaded (drawn as
 *  that world from its first frame, or anime when it turned out unavailable), never anime first and then the world;
 *  until then the spinner, on the world's last known backdrop (BACKDROP_KEY). `openSeq` tells this open's load from
 *  an earlier one's. */
let styleWait = false;
let openSeq = 0;
const BACKDROP_KEY = "lucid.viz.backdrop.v1";
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
let viewPop: { node: HTMLElement; close: () => void; reposition: () => void } | null = null;
let killArm: { id: string; until: number } | null = null;
/** P-VIZ.6 (ADR-0636): the throw tray (bottom center of the stage), built with the view. */
let tray: ThrowTray | null = null;
/** P-VIZ.APPROVE1 (ADR-0655): the approval badges, pop-out and triage strip (viz_approvals), mounted per open. The
 *  View menu's "Fly to approvals" (on by default, persisted) flies the camera to a new ask; `flights` counts the
 *  flights it started (the demo probe's proof). */
let asks: ApprovalsView | null = null;
const FLY_KEY = "lucid.viz.flyToApprovals.v1";
const FLY_HOLD_MS = 2600;
let flyAsks = ((): boolean => { try { return localStorage.getItem(FLY_KEY) !== "0"; } catch { return true; } })();
let flights = 0;
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
    // P-WORLDS.1: a saved world style stays saved; until it loads (or if it is gone) the scene draws anime.
    return { view: p.view === "2d" ? "2d" : "3d", layout: p.layout === "constellation" ? "constellation" : "orbit", style: parseStyle(p.style) };
  } catch { return { view: "3d", layout: "orbit", style: "anime" }; }
}
let prefs: Prefs = loadPrefs();
function savePrefs(): void { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* the choice still applies for this session */ } }

// ---------------------------------------------------------------------------------------------- P-WORLDS.1 (ADR-0648)
// Lucid Agent Worlds: the installed worlds (viz_worlds.loadWorlds, refreshed on every open and after an import),
// the selected one with its option values (one object per selection or option change, so the scene rebuilds the
// cast exactly when it changes), and the Worlds menu.

const worldHost = createWorldHost();
let worlds: WorldEntry[] = [];
let curWorld: SceneWorld | null = null;
let worldsPop: { node: HTMLElement; close: () => void; reposition: () => void } | null = null;
let worldsSeq = 0;
/** P-WORLDS.HEAL1: world package ids a purchase restore is still bringing back (plugins_flyout restorePurchases). */
let pendingRestores: ReadonlySet<string> = new Set();
/** The installed worlds were listed at least once (before that, a saved world is not "missing", just loading). */
let worldsListed = false;

/** P-WORLDS.HEAL1: the restore flow says which worlds are still on their way back. The saved style is left alone, so
 *  an open view re-lists the worlds and takes the saved one back the moment it is installed again. */
export function setPendingWorldRestores(ids: readonly string[]): void {
  pendingRestores = new Set(ids);
  if (isOpen()) void refreshWorlds();
}

/** The style the scene draws: the saved one, or anime while a saved world is not (or no longer) usable. */
function effStyle(): VizStyle {
  if (curWorld) return prefs.style;
  return prefs.style === "professional" ? "professional" : "anime";
}

/** The saved world's entry when it can be drawn now. */
function activeEntry(): WorldEntry | null {
  return worlds.find((w) => w.style === prefs.style && worldUsable(w)) ?? null;
}

/** Point curWorld at the saved world with its saved options (kept as is when nothing changed). */
function resolveWorld(): void {
  const def = activeEntry()?.def;
  if (!def) { curWorld = null; return; }
  const options = loadOptions(localStorage, def);
  const same = curWorld?.def === def && Object.keys(options).every((k) => curWorld?.options[k] === options[k]);
  if (!same) curWorld = { def, options };
}

/** Tell the scene and the tray the current style. A world whose sky is light on a dark theme (or the reverse)
 *  needs a remount: the scene picks its lights, blending and bloom when it starts. */
function applyStyle(): void {
  const style = effStyle();
  tray?.setStyle(style, curWorld?.def ?? null);
  paintToggles();
  paintWorldOptions();
  if (!scene || !view) return;
  const theme = sceneTheme(view);
  if (JSON.stringify(theme) !== themeSig) { remount(); return; }
  scene.setStyle(style, curWorld);
  rememberBackdrop(theme.bg); // P-VIZ.NOFLASH1: the next open's spinner wears this world's backdrop
}

/** Pick a style (the toggle, a world in the Worlds menu, or the probe). False when it cannot be drawn now. */
function selectStyle(style: VizStyle): boolean {
  if (style !== "anime" && style !== "professional") {
    const e = worlds.find((w) => w.style === style);
    if (!e || !worldUsable(e)) return false;
  }
  prefs.style = style;
  savePrefs();
  resolveWorld();
  applyStyle();
  return true;
}

/** List and load the installed worlds, then draw the saved one if it is among them. */
async function refreshWorlds(): Promise<void> {
  const seq = ++worldsSeq;
  const list = await loadWorlds({
    list: () => bridge.worldsList(),
    // A variable URL: the bundler leaves the import alone and the browser fetches the module from the engine.
    importModule: (url: string): Promise<unknown> => import(/* @vite-ignore */ url),
    host: worldHost,
    provider: getMarketProvider(),
    storage: localStorage,
    now: Date.now,
    previous: worlds,
  });
  if (seq !== worldsSeq) return; // a newer refresh (an import) owns the list
  worlds = list;
  worldsListed = true;
  // P-WORLDS.UPDATE1: an update installed from the store drawer (or a removed world) no longer offers Update.
  deps?.worldUpdates.reconcile(list.map((e) => ({ id: e.installed.id, version: e.installed.version })));
  resolveWorld();
  if (isOpen()) applyStyle();
  if (worldsPop) { paintWorldsMenu(worldsPop.node); worldsPop.reposition(); }
}

const LOCK_SVG = `<svg class="ic" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>`;

/** The Worlds menu: every installed world (select it, or Get it, or its error), import, export, the store. */
function openWorldsMenu(anchor: HTMLElement): void {
  if (worldsPop) { worldsPop.close(); worldsPop = null; return; }
  const p = popover(anchor, `<div class="viz-worlds" data-viz-worlds-menu></div>`, () => { worldsPop = null; });
  worldsPop = p;
  paintWorldsMenu(p.node);
  p.reposition(); // popover() measured the empty shell: size and place it for the rows just painted
  p.node.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    // P-WORLDS.UPDATE1: the store card's install path; the row shows Updating, then the result toasts.
    const upd = t.closest<HTMLButtonElement>("[data-viz-world-update]");
    if (upd) { if (!upd.disabled && deps) void deps.worldUpdates.update([upd.dataset.vizWorldUpdate ?? ""]); return; }
    const pick = t.closest<HTMLElement>("[data-viz-world-pick]");
    if (pick) {
      const e = worlds.find((w) => w.style === pick.dataset.vizWorldPick);
      if (!e) return;
      if (worldUsable(e)) { selectStyle(e.style); p.close(); worldsPop = null; return; }
      if (e.def && !e.error) openStore(e.installed.id); // locked: the store sells it
      return;
    }
    if (t.closest("[data-viz-world-import]")) { (p.node.querySelector("[data-viz-world-file]") as HTMLInputElement | null)?.click(); return; }
    if (t.closest("[data-viz-world-store]")) openStore();
  });
  p.node.addEventListener("change", (ev) => {
    const input = ev.target as HTMLInputElement;
    if (!input.matches("[data-viz-world-file]")) return;
    const file = input.files?.[0];
    input.value = "";
    if (file) void importWorldFile(file);
  });
}

/** The store lives in the Plugins drawer, under this overlay: close it first. */
function openStore(packId?: string): void {
  const d = deps;
  closeViz();
  d?.openStore(packId);
}

function paintWorldsMenu(node: HTMLElement): void {
  const root = node.querySelector<HTMLElement>("[data-viz-worlds-menu]");
  if (!root) return;
  const rows = worlds.map((e) => {
    const on = curWorld !== null && e.style === prefs.style;
    const locked = !!e.def && !e.error && e.access !== "allowed";
    const why = e.access === "signin" ? "Sign in with the Google account that bought it, or get it in the store." : "Not purchased on this account yet: get it in the store.";
    const tip = e.error ? tipAttr(e.label, `This world cannot be shown: ${e.error}.`) : locked ? tipAttr(e.label, `${e.tagline} ${why}`) : tipAttr(e.label, e.tagline);
    const exportName = `${e.installed.id}-${e.installed.version}.lplugin.zip`;
    // P-WORLDS.UPDATE1: a purchased world (usable here; a broken one too, a new version may fix it) whose store
    // version is newer offers Update beside Export...; it shows Updating while the install runs.
    const upd = deps ? rowUpdate(e.installed.id, e.installed.version, e.access === "allowed", deps.worldUpdates.pending()) : null;
    const updating = !!upd && !!deps?.worldUpdates.busy(e.installed.id);
    const to = upd ? upd.to.replace(/^v/, "") : "";
    const updBtn = upd
      ? `<button type="button" class="btn-mini viz-world-upd" data-viz-world-update="${esc(e.installed.id)}" aria-label="${esc(`Update ${e.label} to version ${to}`)}"${updating ? ` disabled aria-busy="true"` : ""} data-tip="${tipAttr(updating ? `Updating to v${to}` : `Update to v${to}`, `Installed: v${e.installed.version.replace(/^v/, "")}. The new version downloads from the LUCID store and passes the same signature, checksum and security scan checks as a purchase.`)}">${updating ? "Updating" : "Update"}</button>`
      : "";
    return `<div class="viz-world-row${on ? " on" : ""}${e.error ? " broken" : ""}">
      <button type="button" class="viz-world-pick" data-viz-world-pick="${esc(e.style)}" aria-pressed="${on}"${e.error ? " disabled" : ""} data-tip="${tip}">
        <b>${esc(e.label)}</b>${locked ? `<span class="viz-world-get">${LOCK_SVG}Get</span>` : ""}
      </button>
      ${updBtn}
      <a class="viz-world-export" href="${esc(bridge.worldExportUrl(e.installed.id))}" download="${esc(exportName)}" data-tip="${tipAttr("Export...", "Save the signed world file, to install it on another machine (Import world file there). It still needs your purchase to show.")}">Export...</a>
      ${e.error ? `<p class="viz-world-err" role="note">${esc(e.error)}</p>` : ""}
    </div>`;
  }).join("");
  // P-WORLDS.HEAL1: say why the saved world is not drawn instead of silently showing Anime.
  const saved = worldsListed ? savedWorldState(prefs.style, worlds.map((e) => e.style), pendingRestores) : null;
  const savedNote = saved === "pending"
    ? `<p class="viz-world-none" role="status" data-viz-world-saved="pending">Your saved world is being restored. Anime shows until it is back, then Visualize switches to it.</p>`
    : saved === "missing"
      ? `<p class="viz-world-none" role="note" data-viz-world-saved="missing">Your saved world is not installed here, so Anime shows. Reinstall it from the store or import its world file.</p>`
      : "";
  root.innerHTML = `<div class="viz-vmenu-h">Worlds</div>
    ${savedNote}${rows || (savedNote ? "" : `<p class="viz-world-none">No worlds installed yet.</p>`)}
    <div class="viz-world-acts">
      <button type="button" class="btn-mini orbit-btn" data-viz-world-import data-tip="${tipAttr("Import world file...", "Install a signed .lplugin.zip world file exported from another machine. Its signature and contents are checked first.")}">${icon("folder", 13)}<span>Import world file...</span></button>
      <button type="button" class="btn-mini orbit-btn" data-viz-world-store data-tip="${tipAttr("Get more worlds", "Open the Plugins store on its premium worlds.")}">${icon("plugins", 13)}<span>Get more worlds</span></button>
      <input type="file" accept=".zip" data-viz-world-file hidden>
    </div>`;
}

async function importWorldFile(file: File): Promise<void> {
  let r: { ok: boolean; world?: InstalledWorld; error?: string };
  try { r = await bridge.worldImport(await file.arrayBuffer(), file.name); }
  catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  if (!r.ok || !r.world) { showToast({ title: "World not imported", desc: r.error ?? "The file could not be installed.", timeout: 5000 }); return; }
  // With the Worlds menu open the new row IS the confirmation; a toast there would cover the menu (top right).
  if (!worldsPop) showToast({ title: `World installed: ${r.world.name}`, desc: "Pick it in Worlds.", timeout: 3200 });
  await refreshWorlds();
}

/** The View menu's World options (the selected world's colors, choices, toggles and swatch ramps). A change
 *  saves the value and rebuilds the figures with it. */
function worldOptionsHtml(): string {
  const w = curWorld;
  if (!w || !w.def.options.length) return "";
  const row = (o: WorldOption): string => {
    const v = w.options[o.key];
    const k = esc(o.key);
    const name = `<span title="${esc(o.label)}">${esc(o.label)}</span>`; // P-VIZ.UI1: a long label ellipsizes, the title has it all
    if (o.type === "color") return `<label class="viz-wopt">${name}<input type="color" data-viz-wopt="${k}" value="${esc(fullHex(typeof v === "string" ? v : o.default))}"></label>`;
    if (o.type === "toggle") return `<label class="viz-wopt">${name}<input type="checkbox" data-viz-wopt="${k}"${v === true ? " checked" : ""}></label>`;
    if (o.type === "swatch") { // P-WORLDS.CAST2 (ADR-0650): a named ramp, drawn as swatch buttons
      const cur = o.swatches.find((s) => s.value === v) ?? o.swatches.find((s) => s.value === o.default);
      return `<div class="viz-wopt-sw">${castRowHead(o.label, cur?.label ?? "")}${swatchGrid(o.label, `wopt-${o.key}`, `data-viz-wopt-sw="${k}"`, o.swatches.map((s) => ({ ...s, color: s.value })), cur?.value ?? null, balancedCols(o.swatches.length))}</div>`;
    }
    return `<label class="viz-wopt">${name}<select data-viz-wopt="${k}">${o.choices.map((c) => `<option value="${esc(c.value)}"${c.value === v ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select></label>`;
  };
  return `<div class="viz-vmenu-h">World options</div><div class="viz-wopts" data-viz-wopts>${w.def.options.map(row).join("")}</div>`;
}

/** "#abc" -> "#aabbcc" (a color input takes only the long form). */
function fullHex(c: string): string {
  return /^#[0-9a-fA-F]{3}$/.test(c) ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c;
}

/** Repaint the World options and Cast sections of an open View menu (the selection changed under it). */
function paintWorldOptions(): void {
  const slot = viewPop?.node.querySelector<HTMLElement>("[data-viz-wopts-slot]");
  if (slot) { repaintKeepingFocus(slot, worldOptionsHtml()); viewPop?.reposition(); }
  paintCast();
  paintLook();
}

function onWorldOption(input: HTMLInputElement | HTMLSelectElement): void {
  const o = curWorld?.def.options.find((x) => x.key === input.dataset.vizWopt);
  if (o) setWorldOption(o.key, o.type === "toggle" ? (input as HTMLInputElement).checked : input.value);
}

function setWorldOption(key: string, value: string | boolean): void {
  const w = curWorld;
  if (!w || !w.def.options.some((x) => x.key === key)) return;
  curWorld = { def: w.def, options: saveOption(localStorage, w.def, key, value) };
  if (!scene) return;
  if (view && JSON.stringify(sceneTheme(view)) !== themeSig) { remount(); return; } // ADR-0652: an option turned the sky light or dark
  scene.setStyle(effStyle(), curWorld);
}

// ---------------------------------------------------------------------------------------------- P-WORLDS.CAST2 (ADR-0650)
// Cast customization for world figures: the View menu's Cast section (the fleet mode, a skin ramp with its
// undertone, a hair-color ramp and hair style chips) and a node's "Customize look" (its panel), which pins that
// lane's (or the hub's) look. Both persist in viz_cast_prefs (localStorage lucid.viz.cast.v1) and reach the
// scene's CastBook through scene.setCast, which rebuilds the figures. Shown while a world is drawn: the built-in
// Anime and Office casts do not read it.

let castPrefs: CastPrefs = loadCastPrefs(localStorage);
let lookPop: { id: string; node: HTMLElement; close: () => void; reposition: () => void } | null = null;

/** Columns for `n` swatches: at most 10 a row (what fits the View menu), spread evenly over the rows so a ramp of
 *  11 draws as 6 and 5, never 10 and a lone swatch. */
function balancedCols(n: number): number {
  return Math.max(1, Math.ceil(n / Math.ceil(n / 10)));
}

/** A ramp of named swatch buttons (one pressed, or none). `attrs` marks each button for the click router, which
 *  reads the button's data-value; `k` keys them so a repaint keeps keyboard focus. */
function swatchGrid(label: string, k: string, attrs: string, items: readonly { value: string; label: string; color: string }[], current: string | null, cols: number): string {
  return `<div class="viz-swatches" role="group" aria-label="${esc(label)}" style="--cols:${cols}">${items.map((s) =>
    `<button type="button" class="viz-swatch" ${attrs} data-value="${esc(s.value)}" data-k="${esc(`${k}:${s.value}`)}" aria-pressed="${s.value === current}" aria-label="${esc(s.label)}" data-tip="${tipAttr(s.label, label)}" style="--sw:${esc(s.color)}"></button>`).join("")}</div>`;
}

/** A row of text chips (one pressed, or none), the same contract as swatchGrid. */
function chipRow(label: string, k: string, attrs: string, items: readonly { value: string; label: string }[], current: string | null, cls: "viz-seg" | "viz-chips"): string {
  return `<div class="${cls}" role="group" aria-label="${esc(label)}">${items.map((c) =>
    `<button type="button" class="${cls === "viz-seg" ? "" : "viz-chip"}${c.value === current ? " on" : ""}" ${attrs} data-value="${esc(c.value)}" data-k="${esc(`${k}:${c.value}`)}" aria-pressed="${c.value === current}">${esc(c.label)}</button>`).join("")}</div>`;
}

/** A one-line label with the current value at its end (and an optional control after it). */
function castRowHead(label: string, value: string, extra = ""): string {
  return `<div class="viz-wopt"><span title="${esc(label)}">${esc(label)}</span><span class="viz-cast-val"><b title="${esc(value)}">${esc(value)}</b>${extra}</span></div>`;
}

/** Replace a section's markup; the focused control (by data-k) keeps focus. */
function repaintKeepingFocus(root: HTMLElement, html: string): void {
  const a = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.dataset.k : undefined;
  root.innerHTML = html;
  if (a) root.querySelector<HTMLElement>(`[data-k="${CSS.escape(a)}"]`)?.focus({ preventScroll: true });
}

const hairColorName = (hex: string): string => HAIR_SWATCHES.find((s) => s.value === hex)?.label ?? "";
const hairStyleName = (id: string): string => HAIR_STYLES.find((h) => h.id === id)?.label ?? id;
const skinItems = (undertone: Undertone): { value: string; label: string; color: string }[] =>
  SKIN_RAMP.map((_, i) => ({ value: String(i), label: SKIN_NAMES[i]!, color: skinTone(i, undertone) }));
const HAIR_COLOR_ITEMS = HAIR_SWATCHES.map((s) => ({ value: s.value, label: s.label, color: s.value }));
const UNDERTONE_ITEMS = UNDERTONES.map((u) => ({ value: u.id, label: u.label }));

/** The View menu's Cast section (fleet defaults). In Balanced fleet no shade is pressed (the fleet mixes them);
 *  picking a shade, color or style switches to Same for all. The undertone applies in both modes. */
function castHtml(): string {
  if (!curWorld) return "";
  const f = castPrefs.fleet;
  const same = f.mode === "same";
  return `<div class="viz-vmenu-h">Cast</div>
    <div class="viz-cast">
      ${chipRow("Cast mode", "cast-mode", `data-viz-cast="mode"`, [{ value: "balanced", label: "Balanced fleet" }, { value: "same", label: "Same for all" }], f.mode, "viz-seg")}
      ${castRowHead("Skin", same ? SKIN_NAMES[f.skin]! : "Mixed")}
      ${swatchGrid("Skin shade", "cast-skin", `data-viz-cast="skin"`, skinItems(f.undertone), same ? String(f.skin) : null, 10)}
      ${chipRow("Undertone", "cast-ut", `data-viz-cast="undertone"`, UNDERTONE_ITEMS, f.undertone, "viz-seg")}
      ${castRowHead("Hair color", same ? hairColorName(f.hairColor) : "Mixed")}
      ${swatchGrid("Hair color", "cast-hc", `data-viz-cast="hairColor"`, HAIR_COLOR_ITEMS, same ? f.hairColor : null, 8)}
      ${castRowHead("Hair style", same ? hairStyleName(f.hair) : "Mixed")}
      ${chipRow("Hair style", "cast-hair", `data-viz-cast="hair"`, HAIR_STYLES.map((h) => ({ value: h.id, label: h.label })), same ? f.hair : null, "viz-chips")}
      <p class="viz-cast-note">${same ? "Every figure wears these. Pin one agent's look from its panel." : "Each agent gets its own mixed look. Pick a shade or style to give everyone the same."}</p>
    </div>`;
}

function paintCast(): void {
  const slot = viewPop?.node.querySelector<HTMLElement>("[data-viz-cast-slot]");
  if (slot) { repaintKeepingFocus(slot, castHtml()); viewPop?.reposition(); }
}

/** Save, hand to the scene (it rebuilds the figures) and repaint whatever shows them. */
function setCastPrefs(next: CastPrefs): void {
  castPrefs = next;
  saveCastPrefs(localStorage, next);
  scene?.setCast(next);
  paintCast();
  paintLook();
}

function onCastPick(field: string, value: string): void {
  const patch: Partial<FleetCast> | null =
    field === "mode" ? { mode: value === "same" ? "same" : "balanced" }
    : field === "skin" ? { mode: "same", skin: Number(value) }
    : field === "undertone" ? { undertone: value as Undertone }
    : field === "hairColor" ? { mode: "same", hairColor: value }
    : field === "hair" ? { mode: "same", hair: value as HairStyle }
    : null;
  if (patch) setCastPrefs(withFleet(castPrefs, patch)); // withFleet drops anything invalid
}

/** "Customize look" (the node panel): pin this node's presentation, skin, hair style and hair color. */
function openLook(id: string): void {
  if (lookPop) { const again = lookPop.id === id; lookPop.close(); lookPop = null; if (again) return; }
  if (!view) return;
  const p = popover(panelEl("[data-viz-panel-acts]"), `<div class="viz-vmenu viz-look" data-viz-look-root></div>`, () => { if (lookPop?.node === p.node) lookPop = null; });
  lookPop = { id, ...p };
  paintLook();
  p.node.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-viz-look]");
    if (b) onLookPick(id, b.dataset.vizLook ?? "", b.dataset.value ?? "");
  });
  (p.node.querySelector<HTMLElement>("button[aria-pressed=true]") ?? p.node.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
}

function closeLook(): void {
  lookPop?.close();
  lookPop = null;
}

function paintLook(): void {
  const lp = lookPop;
  const root = lp?.node.querySelector<HTMLElement>("[data-viz-look-root]");
  if (!lp || !root) return;
  const n = model?.nodes.get(lp.id);
  const a = scene?.castOf(lp.id) ?? null;
  if (!n || !a || !curWorld) { closeLook(); return; } // the node left, or the world is gone
  const name = n.kind === "hub" ? "Main" : n.name;
  const pin: Readonly<CastPin> = pinOf(castPrefs, lp.id) ?? {};
  const auto = (field: string, on: boolean): string =>
    `<button type="button" class="viz-chip viz-chip-auto${on ? " on" : ""}" data-viz-look="${field}" data-value="" data-k="look-${field}:auto" aria-pressed="${on}" data-tip="${tipAttr("Auto", "Let the fleet decide this one.")}">Auto</button>`;
  const styles = HAIR_STYLES.filter((h) => !pin.presentation || h.suits.includes(pin.presentation));
  repaintKeepingFocus(root, `<div class="viz-vmenu-h" title="Look of ${esc(name)}">Look of ${esc(name)}</div>
    ${chipRow("Presentation", "look-pres", `data-viz-look="presentation"`, [{ value: "", label: "Auto" }, ...PRESENTATIONS.map((x) => ({ value: x.id, label: x.label }))], pin.presentation ?? "", "viz-seg")}
    ${castRowHead("Skin", SKIN_NAMES[a.skinIndex] ?? "", auto("skin", pin.skin === undefined))}
    ${swatchGrid("Skin shade", "look-skin", `data-viz-look="skin"`, skinItems(pin.undertone ?? castPrefs.fleet.undertone), pin.skin === undefined ? null : String(pin.skin), 10)}
    ${chipRow("Undertone", "look-ut", `data-viz-look="undertone"`, UNDERTONE_ITEMS, pin.undertone ?? castPrefs.fleet.undertone, "viz-seg")}
    ${castRowHead("Hair color", hairColorName(a.hairColor), auto("hairColor", pin.hairColor === undefined))}
    ${swatchGrid("Hair color", "look-hc", `data-viz-look="hairColor"`, HAIR_COLOR_ITEMS, pin.hairColor ?? null, 8)}
    ${castRowHead("Hair style", hairStyleName(a.hair), auto("hair", pin.hair === undefined))}
    ${chipRow("Hair style", "look-hair", `data-viz-look="hair"`, styles.map((h) => ({ value: h.id, label: h.label })), pin.hair ?? null, "viz-chips")}
    <div class="viz-vmenu-row"><button type="button" class="btn-mini orbit-btn" data-viz-look="reset" data-k="look-reset"${Object.keys(pin).length ? "" : " disabled"}>Reset to balanced</button></div>
    <p class="viz-cast-note">This look follows ${esc(name)} across worlds and restarts.</p>`);
  lp.reposition();
}

function onLookPick(id: string, field: string, value: string): void {
  if (field === "reset") { setCastPrefs(withPin(castPrefs, id, null)); return; }
  const pin: CastPin = { ...(pinOf(castPrefs, id) ?? {}) };
  if (field === "presentation") { if (value) pin.presentation = value as Presentation; else delete pin.presentation; }
  else if (field === "skin") { if (value) pin.skin = Number(value); else { delete pin.skin; delete pin.undertone; } }
  else if (field === "undertone") pin.undertone = value as Undertone;
  else if (field === "hair") { if (value) pin.hair = value as HairStyle; else delete pin.hair; }
  else if (field === "hairColor") { if (value) pin.hairColor = value; else delete pin.hairColor; }
  else return;
  setCastPrefs(withPin(castPrefs, id, pin)); // withPin drops anything invalid (and a style the pinned presentation does not wear)
}

/** The scene's theme: the app's, or (a world) the world's sky decides light, its fog color the base color; both
 *  for the user's options (P-WORLDS.FX1, ADR-0652: environmentFor). */
function sceneTheme(at: HTMLElement): VizTheme {
  const t = readTheme(at);
  const env = curWorld ? worldEnvironment(curWorld.def, curWorld.options) : null;
  if (!env) return t;
  return { ...t, light: env.light, bg: toHex(env.fog.color, t.bg), txt: env.light ? "#1a1d26" : "#e8eaf2" };
}

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
  // P-WORLDS.UPDATE1 (ADR-0685): the Worlds button's dot and the open menu follow the pending updates; a new version
  // on disk is loaded at once (its module URL names the version, so the world is rebuilt from it).
  d.worldUpdates.onChange((why) => {
    paintWorldsBadge();
    if (worldsPop) { paintWorldsMenu(worldsPop.node); worldsPop.reposition(); }
    if (why === "installed" && isOpen()) void refreshWorlds();
  });
  // P-VIZ.NOFLASH1: the scene on screen takes the new tier's lighter settings at once (live, same context) while the
  // new tier's scene builds beneath it; the swap happens on that scene's first whole frame.
  d.perf.onChange((tier) => {
    if (!isOpen()) return;
    paintQuality();
    (outgoing ?? scene)?.relieve(vizTierOpts(tier, !!motionMq?.matches));
    remount();
  });
}

/** True from open until close is asked (the fade-out that follows is not "open"). */
let opened = false;
export const isOpen = (): boolean => opened;

/** P-PREVIEW.CHIP1: each agent's preview chip ("main" is the hub, for the composer's preview), painted by app.ts
 *  exactly as it paints the fleet card's. Kept across a close, so a reopen shows the chips at once. */
const previewStates = new Map<string, ChipState>();
let previewChips: WorldChips | null = null;
/** P-BUDDY.1 (ADR-0667): detaches this open's floating Agent buddies. */
let detachBuddies: (() => void) | null = null;
/** P-SPINUP.1 (ADR-0668): detaches this open's spin-up walkers. */
let detachSpinup: (() => void) | null = null;

/** P-PREVIEW.CHIP1: show, update or (null) clear a target's chip ("main" or a lane id). */
export function paintVizPreview(target: string, v: ChipState | null): void {
  if (v) previewStates.set(target, v); else previewStates.delete(target);
  previewChips?.set(target, v);
}

/** P-PREVIEW.CHIP1: the Preview panel is up over this view, or gone again. While it is, this dialog is not modal:
 *  the panel beside it takes focus and Esc, and a press back on the world slides it away (buildView). */
export function setVizPreviewCover(on: boolean): void {
  view?.setAttribute("aria-modal", String(!on));
}

export function toggleViz(): void { if (isOpen()) closeViz(); else openViz(); }

/** P-WORLDS.1 (ADR-0648): open Visualize on an installed world (the store's "Open in Visualize"). Loads the
 *  installed list first, so a world installed a moment ago is offered; false when it cannot be drawn. */
export async function openVizWorld(packageId: string): Promise<boolean> {
  const key = worldKey(packageId);
  if (!key) return false;
  if (!isOpen()) openViz();
  await refreshWorlds();
  return selectStyle(worldStyle(key));
}

/** P-RAIL.AGENTS1: open Visualize (when it is not open) on one agent (`id` = its fleet lane id): wait for its node, as
 *  a lane spawned a moment ago joins on a fleet poll (asked for about once a second here, never more than the chain
 *  allows), then open its prompt panel with the input focused. False when the node did not appear within `waitMs`
 *  or the view closed meanwhile. */
export async function openVizAgent(id: string, waitMs = 10_000): Promise<boolean> {
  if (!isOpen()) openViz();
  if (!isOpen()) return false;
  const until = Date.now() + waitMs;
  let askedAt = 0;
  while (!model?.nodes.has(id)) {
    if (!isOpen() || Date.now() >= until) return false;
    if (Date.now() - askedAt >= 1000) { askedAt = Date.now(); void pollFleet(); }
    const tick = Promise.withResolvers<void>();
    window.setTimeout(tick.resolve, 120);
    await tick.promise;
  }
  openPanel(id);
  const input = view ? view.querySelector<HTMLTextAreaElement>("[data-viz-panel-input]") : null;
  if (input && !input.disabled) input.focus({ preventScroll: true });
  return panel?.id === id;
}

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
    // P-WORLDS.CAST1 (ADR-0649): in a world, the appearance its figure was cast with (null otherwise).
    nodes: () => (model ? [...model.nodes.values()].map((n) => {
      const b = vizBrandFor(n.model);
      return { id: n.id, kind: n.kind, name: n.name, box: scene?.screenBoxOf(n.id) ?? null, brand: b?.key ?? null, size: b?.size ?? null, committing: committing(n, Date.now()), cast: scene?.castOf(n.id) ?? null };
    }) : []),
    ...(scripted ? { shot: (id: string | null, opts?: Parameters<VizSceneHandle["scriptShot"]>[1]) => scene?.scriptShot(id, opts) } : {}),
    // P-WORLDS.1 (ADR-0648): the installed worlds and a style switch ("anime", "professional", "world:<key>"),
    // so a script can show a world; false when that style cannot be drawn now.
    worlds: () => worlds.map((e) => ({ id: e.installed.id, style: e.style, label: e.label, access: e.access, error: e.error })),
    style: (id: string): boolean => selectStyle(parseStyle(id)) && effStyle() === id,
    // P-WORLDS.FX1 (ADR-0652): what the edges draw and where (read-only), and a QA preview of a world's edges
    // (plasma-light, a token) merged as if its environmentFor returned them, for packs not yet migrated to v2.
    fx: () => scene?.edgeFxInfo() ?? null,
    fxPreview: (edges: Parameters<VizSceneHandle["previewEdges"]>[0]): boolean => scene?.previewEdges(edges) ?? false,
    // P-WORLDS.CAST2 (ADR-0650): the cast preferences in effect (a frozen copy of lucid.viz.cast.v1).
    castPrefs: (): CastPrefs => castPrefs,
    // P-WORLDS.KIT2 (ADR-0654): the character kit's lineup (presets, hair at every tier, the sleeve coverage pass
    // and three PNG sheets), drawn in its own offscreen renderer and freed before it returns; never the scene's.
    kitLineup: (o?: Parameters<typeof kitLineup>[0]): KitLineupReport => kitLineup(o),
    // P-VIZ.GPU1 (ADR-0651): the Quality mode and tier, the probed GPU, a governor step-down, and what the renderer
    // is doing (pixel ratio, MSAA, bloom, SSAO, DOF, contact shadows, the frame-time check). Read-only.
    quality: () => (deps ? { mode: deps.perf.mode(), tier: deps.perf.tier(), gpu: deps.perf.gpu(), steppedFrom: deps.perf.steppedFrom(), scene: scene?.quality() ?? null } : null),
    // P-VIZ.NOFLASH1: a missed frame budget, through the very path the scene's governor takes (Auto only, spaced by
    // mayStepDown; no measured frames, so one step), so demo_p_viz_noflash_1.mjs can force the step-down remount.
    // True when the tier stepped down.
    governorMiss: (): boolean => {
      const before = deps?.perf.tier();
      onFrameBudget("miss", null);
      return deps?.perf.tier() !== before;
    },
    // P-WORLDS.BUILD1 (ADR-0653): each node's build (the book and the scaffold drawn for it, with its chip's box)
    // and the artifact popup's state (gate verdict, iframe sandbox and src). Read-only.
    builds: () => [...builds.builds].map(([id, b]) => {
      const sc = scaffolds.get(id);
      const chip = view?.querySelector<HTMLElement>(`[data-viz-art-chip="${CSS.escape(id)}"]`);
      const r = chip && !chip.hidden ? chip.getBoundingClientRect() : null;
      return {
        id, pieces: b.pieces, locked: b.locked, failed: b.failed, revealed: b.revealed, template: b.template?.id ?? null,
        artifact: b.artifact ? { id: b.artifact.id, title: b.artifact.title, demo: b.artifact.demo, sample: b.artifact.sample, kept: b.artifact.kept, bytes: b.artifact.html.length } : null,
        scaffold: sc ? { pieces: sc.pieces, locked: sc.locked, revealed: sc.revealed } : null,
        chip: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } : null,
      };
    }),
    artifact: () => artifactPopupState(),
    // P-PREVIEW.CHIP1: each agent's preview chip (phase, box on screen, its hover card) for demo_p_preview_chip_1.mjs.
    previewChips: () => previewChips?.probe() ?? [],
    // P-VIZ.APPROVE1 (ADR-0655): the open asks with their badges, the strip and the pop-out, the Fly to approvals
    // setting, the flights it started and the node a flight is framing now. Read-only.
    approvals: () => (asks ? { ...asks.probe(), flyToApprovals: flyAsks, flights, flying: scene?.flying() ?? null } : null),
  };
  // P-WORLDS.1: the worlds load; P-VIZ.NOFLASH1: a saved world not loaded yet holds the mount until they have (styleWait)
  styleWait = !isBuiltinStyle(prefs.style) && !curWorld;
  const seq = ++openSeq;
  void refreshWorlds()
    .catch((e: unknown) => console.warn("[viz] the installed worlds did not load", e))
    .finally(() => { if (seq === openSeq) endStyleWait(); });
  if (!!demo !== ledgerIsDemo) { ledger = createLedger(); ledgerIsDemo = !!demo; mainFolder = null; }
  loadMainFolder();
  ledgerView = mountLedger($("[data-viz-stage]", view) as HTMLElement, () => !!motionMq?.matches);
  builds = createBuildBook(); // P-WORLDS.BUILD1 (ADR-0653): builds live as long as the model
  chips = mountArtifactChips($("[data-viz-stage]", view) as HTMLElement, (id) => scene?.screenBoxOf(id) ?? null, openChip);
  const d = deps;
  // P-PREVIEW.CHIP1: each agent's preview chip, stacked over its artifact chip; a click flies the Preview out over us.
  previewChips = mountWorldPreviewChips($("[data-viz-stage]", view) as HTMLElement, {
    boxOf: (id) => scene?.screenBoxOf(id) ?? null,
    below: (id) => { const h = chips?.heightOf(id) ?? 0; return h ? h + 6 : 0; },
    nameOf: (id) => model?.nodes.get(id)?.name ?? (id === HUB_ID ? "Main" : "this agent"),
    open: (id, chip) => d.preview.open(id, chip),
  });
  for (const [id, v] of previewStates) previewChips.set(id, v);
  // P-BUDDY.1 (ADR-0667): a floating Agent buddy up and left of each lane node, on the same boxes as the chips.
  // Only real lanes (lastLanes, the engine's): the demo's scripted lanes have no engine behind them to ask for ideas.
  const laneOf = (id: string): LaneView | undefined => lastLanes.find((l) => l.id === id);
  detachBuddies = d.attachBuddies($("[data-viz-stage]", view) as HTMLElement, {
    ids: () => lastLanes.filter((l) => model?.nodes.has(l.id)).map((l) => l.id),
    boxOf: (id) => scene?.screenBoxOf(id) ?? null,
    folderOf: (id) => laneOf(id)?.cwd || null,
    laneOf: (id) => laneOf(id)?.id ?? null,
  });
  // P-SPINUP.1 (ADR-0668): a mini Lucid paces over each lane node that is still starting, with a status bubble.
  detachSpinup = d.attachSpinup($("[data-viz-stage]", view) as HTMLElement, {
    ids: () => lastLanes.filter((l) => l.status === "starting" && model?.nodes.has(l.id)).map((l) => l.id),
    boxOf: (id) => scene?.screenBoxOf(id) ?? null,
    nameOf: (id) => laneOf(id)?.name || "Agent",
    folderOf: (id) => laneOf(id)?.cwd || null,
  });
  flights = 0;
  asks = mountApprovals({ // P-VIZ.APPROVE1 (ADR-0655)
    stage: $("[data-viz-stage]", view) as HTMLElement, model: () => model, demo: () => demo, boxOf: (id) => scene?.screenBoxOf(id) ?? null,
    fleetAnswer: d.fleetAnswer, fleetAuto: d.fleetAuto, autoRiskModal: d.autoRiskModal, respondMain: d.respondMain,
    jump: (id) => { scene?.flyTo(id, FLY_HOLD_MS); }, onOpen: closePanel, refresh: () => void pollFleet(),
  });
  const rows = ledgerRows(ledger); // what this session already counted; the scene's nodes join on the first tick
  ledgerView.paint(rows, ledgerSummary(rows));
  paintToggles();
  paintQuality();
  paintRecs();
  headRo = new ResizeObserver(fitHead);
  headRo.observe($("[data-viz-head]", view) as HTMLElement); // fires once now, then on every width change
  if (styleWait) showStarting(savedBackdrop()); else mount();
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
  closePanel(); closePlayer(); recPop?.close(); recPop = null; viewPop?.close(); viewPop = null; worldsPop?.close(); worldsPop = null; hideAutoHint();
  tray?.disarm();
  offBus?.(); offBus = null;
  ledgerView?.destroy(); ledgerView = null;
  closeArtifactPopup(); chips?.destroy(); chips = null; // P-WORLDS.BUILD1 (ADR-0653); the scene disposes the scaffolds
  previewChips?.destroy(); previewChips = null; // P-PREVIEW.CHIP1 (their states stay in previewStates)
  detachBuddies?.(); detachBuddies = null; // P-BUDDY.1 (ADR-0667)
  detachSpinup?.(); detachSpinup = null; // P-SPINUP.1 (ADR-0668)
  asks?.destroy(); asks = null; // P-VIZ.APPROVE1 (ADR-0655)
  headRo?.disconnect(); headRo = null;
  stopTimers();
  for (const w of watches.values()) w.stop();
  watches.clear();
  window.clearTimeout(restoreTimer); restoreTimer = 0;
  styleWait = false;
  retireOutgoing();
  scene?.destroy(); scene = null;
  model = null; demo = null; hover = null;
  outputs.clear(); sending.clear(); lastLanes = [];
  window.removeEventListener("keydown", onKey, true);
  document.removeEventListener("visibilitychange", onVisibility);
  motionMq?.removeEventListener("change", remount);
  opened = false;
  // P-PREVIEW.CHIP1: a Preview panel opened over this view stays open, back on its side-panel tier.
  if (deps?.preview.isOver()) deps.preview.viewClosed();
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
        <button type="button" class="viz-worlds-btn" data-viz-worlds aria-haspopup="true" aria-label="Worlds" data-tip="${tipAttr("Worlds", "Lucid Agent Worlds: add-on casts, skies, throwables and storms. Pick an installed world, import a world file, or get more in the store.")}">${icon("plugins", 14)}<span data-viz-worlds-label>Worlds</span></button>
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
  // P-PREVIEW.CHIP1: with the Preview panel up over this view, a press back on the world slides it away. On the scene
  // the press is spent on that (no pick, no drag); a control still gets its click. A preview chip and its card keep
  // theirs: another agent's chip switches the panel to that agent's tab instead.
  v.addEventListener("pointerdown", (ev) => {
    if (!deps?.preview.isOver()) return;
    const t = ev.target as HTMLElement;
    if (t.closest("[data-viz-preview-chip], .pchip-pop")) return;
    deps.preview.close();
    if (!t.closest("button, input, select, textarea, label, a, video")) { ev.preventDefault(); ev.stopPropagation(); }
  }, true);
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
  tray = mountThrowTray($("[data-viz-stage]", v) as HTMLElement, () => scene, effStyle(), curWorld?.def ?? null); // P-VIZ.6 (ADR-0636)
  return v;
}

function onViewClick(ev: Event): void {
  const t = ev.target as HTMLElement;
  if (t.closest("[data-viz-close]")) { closeViz(); return; }
  const vb = t.closest("[data-viz-view]") as HTMLElement | null;
  if (vb) { prefs.view = vb.dataset.vizView === "2d" ? "2d" : "3d"; savePrefs(); paintToggles(); scene?.setView(prefs.view); return; }
  const sb = t.closest("[data-viz-style]") as HTMLElement | null;
  if (sb) { selectStyle(sb.dataset.vizStyle === "professional" ? "professional" : "anime"); return; }
  const wb = t.closest("[data-viz-worlds]") as HTMLElement | null;
  if (wb) { openWorldsMenu(wb); return; } // P-WORLDS.1 (ADR-0648)
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
  const look = t.closest<HTMLElement>("[data-viz-look-open]");
  if (look) { openLook(look.dataset.vizLookOpen ?? ""); return; } // P-WORLDS.CAST2 (ADR-0650)
  const game = t.closest<HTMLButtonElement>("[data-viz-game]");
  if (game && !game.disabled) { void startMiniGame(game.dataset.vizNode ?? "", game.dataset.vizGame ?? ""); return; } // P-WORLDS.BUILD1 (ADR-0653)
  const sample = t.closest<HTMLButtonElement>("[data-viz-game-sample]");
  if (sample && !sample.disabled) { playSample(sample.dataset.vizNode ?? "", sample.dataset.vizGameSample ?? ""); return; } // P-WORLDS.BUILD2
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
    <div class="viz-vmenu-h">Approvals</div>
    <label class="viz-wopt" data-tip="${tipAttr("Fly to approvals", "When an agent asks for approval, the camera flies to it and its badge pulses. It never takes the keyboard from what you are typing.")}"><span>Fly to approvals</span><input type="checkbox" data-viz-flyask${flyAsks ? " checked" : ""}></label>
    <div data-viz-wopts-slot>${worldOptionsHtml()}</div>
    <div data-viz-cast-slot>${castHtml()}</div>
    ${recRows}
  </div>`, () => { viewPop = null; });
  viewPop = p;
  // P-WORLDS.1 (ADR-0648): a World options change saves it and rebuilds the figures with it.
  p.node.addEventListener("change", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.matches("input[data-viz-wopt], select[data-viz-wopt]")) onWorldOption(t as HTMLInputElement | HTMLSelectElement);
    if (t.matches("input[data-viz-flyask]")) { // P-VIZ.APPROVE1 (ADR-0655)
      flyAsks = (t as HTMLInputElement).checked;
      try { localStorage.setItem(FLY_KEY, flyAsks ? "1" : "0"); } catch { /* still applies for this session */ }
    }
  });
  paintViewMenu();
  paintRecs();
  p.reposition(); // popover() measured it before the quality label and World options painted
  p.node.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const lb = t.closest("[data-viz-layout]") as HTMLElement | null;
    if (lb) { prefs.layout = lb.dataset.vizLayout === "constellation" ? "constellation" : "orbit"; savePrefs(); paintViewMenu(); syncScene(); if (!autoCam) scene?.fit(); return; } // auto glides to the new layout itself
    if (t.closest("[data-viz-quality]")) { cycleQuality(); return; }
    if (t.closest("[data-viz-rec]")) { if (rec) stopRec("user"); else startRec(); return; }
    if (t.closest("[data-viz-recs]")) { p.close(); viewPop = null; openRecs(anchor); return; }
    // P-WORLDS.CAST2 (ADR-0650): a world's swatch option, and the Cast section.
    const sw = t.closest<HTMLElement>("[data-viz-wopt-sw]");
    if (sw) { setWorldOption(sw.dataset.vizWoptSw ?? "", sw.dataset.value ?? ""); paintWorldOptions(); return; }
    const cb = t.closest<HTMLElement>("[data-viz-cast]");
    if (cb) onCastPick(cb.dataset.vizCast ?? "", cb.dataset.value ?? "");
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
  const style = effStyle();
  for (const b of view.querySelectorAll<HTMLElement>("[data-viz-style]")) { const on = b.dataset.vizStyle === style; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }
  // P-WORLDS.1: the Worlds button is pressed and named while a world is drawn.
  const wb = $("[data-viz-worlds]", view) as HTMLElement | null;
  if (wb) {
    wb.classList.toggle("on", !!curWorld);
    ($("[data-viz-worlds-label]", wb) as HTMLElement).textContent = curWorld ? curWorld.def.label : "Worlds";
  }
  paintWorldsBadge();
}

/** P-WORLDS.UPDATE1 (ADR-0685): a dot on the Worlds button while a purchased world has an update. */
function paintWorldsBadge(): void {
  const wb = view ? ($("[data-viz-worlds]", view) as HTMLElement | null) : null;
  if (!wb) return;
  const n = deps?.worldUpdates.pending().length ?? 0;
  wb.classList.toggle("has-upd", n > 0);
  if (n > 0) wb.dataset.worldUpdates = String(n); else delete wb.dataset.worldUpdates;
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
  // P-VIZ.GPU1 (ADR-0651): Auto names the GPU it decided on ("Auto · ultra (RTX 4070)").
  const gpu = deps.perf.gpu();
  const from = deps.perf.steppedFrom();
  b.innerHTML = `${icon("gauge", 13)}<span>${esc(m === "auto" ? `Auto \u00b7 ${tier}${gpu?.name ? ` (${gpu.name})` : ""}` : m[0]!.toUpperCase() + m.slice(1))}</span>`; // P-VIZ.UI1: a long GPU name ellipsizes; the tip names it
  const gpuLine = gpu?.cls ? ` GPU: ${gpu.name ?? "unknown"}, ${gpu.cls}.` : "";
  const stepLine = from ? ` Stepped down from ${from}: frames missed the budget.` : "";
  b.setAttribute("data-tip", tipValue("Quality", `Auto, Full, Reduced, Minimal, Ultra or Cinematic: the same Performance mode as the Knowledge Graph. Auto picks by GPU, battery and CPU, and steps down one level when frames miss the budget. Cinematic: ultra plus ambient occlusion and depth of field. Ultra: 12000 particles, sharper pixels, smoothed edges, contact shadows, bloom on light worlds too. Full: 6000 particles, 60 fps, glass refraction and bloom. Reduced: 2500 particles, 30 fps. Minimal: 600 particles, 20 fps, no lightning. Now: ${tier}.${gpuLine}${stepLine}`));
}

function cycleQuality(): void {
  if (!deps) return;
  const m = deps.perf.cycleMode(); // notifies onChange, which repaints and remounts
  showToast({ title: `Quality: ${m}`, desc: m === "auto" ? `Following GPU, battery and CPU (now: ${deps.perf.tier()}). The Knowledge Graph uses the same mode.` : "The Knowledge Graph uses the same mode.", timeout: 2400 });
}

/** P-VIZ.GPU1 (ADR-0651): the scene's 3 s frame-time check missed: Auto steps down (an explicit tier is the user's
 *  and stays). The tier change remounts through perf.onChange. P-VIZ.NOFLASH1: as far as the measured frame time
 *  says (perf_tier.supportedTier; one tier without measured frames), and at most once per mayStepDown gap. */
function onFrameBudget(verdict: "ok" | "miss", stats: GovernorStats | null): void {
  if (verdict !== "miss" || !deps || deps.perf.mode() !== "auto") return;
  const now = performance.now();
  if (!mayStepDown(now, lastStepAt)) return; // P-VIZ.NOFLASH1: at most one step per settle and checks
  // P-VIZ.NOFLASH1: straight to the tier the measured frame time supports (one remount, not one per tier)
  const to = stats?.frames ? supportedTier(deps.perf.tier(), stats.meanMs, (t) => 1000 / vizTierOpts(t, false).fps) : undefined;
  const next = deps.perf.stepDown(to);
  if (!next) return;
  lastStepAt = now;
  showToast({ title: `Quality: Auto \u00b7 ${next}`, desc: "Frames missed the budget, so Visualize stepped down one level. Pick a Quality level in View to choose your own.", timeout: 3200 });
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

/** Mount a scene into the stage. P-VIZ.NOFLASH1: with an `outgoing` scene up, the new canvas goes in beneath it
 *  (mountVizScene prepends; the stage paints later siblings on top) and the spinner stays hidden; either way the
 *  spinner and the outgoing picture go on the new scene's first whole frame (its onFirstFrame, in the task that drew
 *  it), not on a guess. `failMsg` replaces the could-not-start text (a rebuild after a lost context keeps its own). */
function mount(failMsg: string | null = null): void {
  if (!view || !deps) return;
  const stage = $("[data-viz-stage]", view) as HTMLElement;
  const loading = $("[data-viz-loading]", view) as HTMLElement;
  const theme = sceneTheme(view); // P-WORLDS.1: a world's sky decides light
  themeSig = JSON.stringify(theme);
  if (outgoing) ($("[data-viz-error]", view) as HTMLElement).hidden = true;
  else showStarting(theme.bg);
  let s: VizSceneHandle;
  try {
    s = mountVizScene(stage, vizTierOpts(deps.perf.tier(), !!motionMq?.matches), theme, prefs.view, autoCam);
  } catch (e) {
    scene = null;
    retireOutgoing();
    loading.hidden = true;
    showError(failMsg ?? `The 3D view could not start on this machine: ${e instanceof Error ? e.message : String(e)}. Your agents are not affected.`);
    return;
  }
  scene = s;
  s.onHover(onHover);
  s.onPick(onPick);
  s.onDoublePick(onDoublePick);
  s.onUserCamera(onUserCamera);
  s.setCast(castPrefs); // P-WORLDS.CAST2 (ADR-0650): before the first world figure is cast
  s.setStyle(effStyle(), curWorld);
  tray?.attach(); // an armed throwable survives a remount (quality, theme, motion change)
  s.onLost(() => onSceneLost(s));
  s.onRestored(() => onSceneRestored(s));
  s.onFrameBudget((v, st) => { if (s === scene) onFrameBudget(v, st); }); // P-VIZ.GPU1 (ADR-0651): the 3 s frame-time check
  syncScene();
  scaffoldSig = ""; syncScaffolds(); // P-WORLDS.BUILD1 (ADR-0653): every build stands again on the new scene
  s.onFirstFrame(() => {
    if (s !== scene) return;
    loading.hidden = true;
    retireOutgoing();
    rememberBackdrop(theme.bg);
  });
  s.canvas.focus({ preventScroll: true });
}

/** P-VIZ.NOFLASH1: the spinner, opaque on `backdrop` (the scene's or the saved world's backdrop color; null: the
 *  theme's --bg-0) with text that reads on it, and no error. */
function showStarting(backdrop: string | null): void {
  if (!view) return;
  const stage = $("[data-viz-stage]", view) as HTMLElement;
  const loading = $("[data-viz-loading]", view) as HTMLElement;
  if (backdrop) stage.style.setProperty("--viz-backdrop", backdrop); else stage.style.removeProperty("--viz-backdrop");
  loading.classList.toggle("viz-state-light", !!backdrop && luminance(backdrop) > 0.5);
  loading.hidden = false;
  ($("[data-viz-error]", view) as HTMLElement).hidden = true;
}

/** P-VIZ.NOFLASH1: the worlds have loaded (or failed to): the saved world is applied or known unavailable, so the
 *  scene mounts now, drawing it (or anime) from its first frame. */
function endStyleWait(): void {
  if (!styleWait) return;
  styleWait = false;
  if (isOpen() && !scene) mount();
}

/** P-VIZ.NOFLASH1: the saved style's backdrop color from the last time it was drawn, else null. */
function savedBackdrop(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(BACKDROP_KEY) ?? "null") as { style?: unknown; bg?: unknown } | null;
    return v && v.style === prefs.style && typeof v.bg === "string" && /^#[0-9a-f]{6}$/i.test(v.bg) ? v.bg : null;
  } catch { return null; }
}

/** P-VIZ.NOFLASH1: keep the drawn world's backdrop color for the next open's spinner (built-in styles need none). */
function rememberBackdrop(bg: string): void {
  if (!curWorld) return;
  try { localStorage.setItem(BACKDROP_KEY, JSON.stringify({ style: prefs.style, bg })); } catch { /* the next open starts on the theme's backdrop */ }
}

/** Rebuild the scene (a tier, theme or motion change, Try again). P-VIZ.NOFLASH1: the scene on screen becomes the
 *  `outgoing` picture until its replacement has drawn; when a replacement was still building, that one (never shown)
 *  goes and the picture on screen stays. */
function remount(): void {
  replaceScene(null);
}

function replaceScene(failMsg: string | null): void {
  if (!isOpen() || styleWait) return; // still waiting for the saved world: that mount takes the current tier and theme
  if (rec) stopRec("quality");
  hideTip(); // the node panel stays: it finds its node again on the new scene
  window.clearTimeout(restoreTimer); restoreTimer = 0;
  if (outgoing) scene?.destroy();
  else if (scene) { outgoing = scene; outgoing.canvas.classList.add("viz-cv-out"); }
  scene = null;
  mount(failMsg);
}

/** P-VIZ.NOFLASH1: drop the outgoing picture (its replacement drew, failed, or the view closes). */
function retireOutgoing(): void {
  outgoing?.destroy();
  outgoing = null;
}

/** P-VIZ.NOFLASH1: a scene's WebGL context was lost. The outgoing picture simply goes (the spinner covers until its
 *  replacement draws). The live scene waits RESTORE_WAIT_MS for the browser to restore the context and is rebuilt
 *  once on it; no restore, or a loss again within RESTORE_AGAIN_MS of a restore, shows the error. */
function onSceneLost(s: VizSceneHandle): void {
  if (!view) return;
  const loading = $("[data-viz-loading]", view) as HTMLElement;
  if (s === outgoing) { retireOutgoing(); loading.hidden = false; return; }
  if (s !== scene) return;
  if (performance.now() - restoredAt < RESTORE_AGAIN_MS) { failLost(); return; }
  if (!outgoing) loading.hidden = false; // the lost canvas shows nothing: the spinner, not a blank stage
  window.clearTimeout(restoreTimer);
  restoreTimer = window.setTimeout(() => { restoreTimer = 0; if (scene === s) failLost(); }, RESTORE_WAIT_MS);
}

/** P-VIZ.NOFLASH1: the browser restored the lost context: rebuild the scene once (its GPU resources are gone). The
 *  lost scene never becomes the outgoing picture (it has none); a picture already up stays until the rebuild draws. */
function onSceneRestored(s: VizSceneHandle): void {
  if (s !== scene || !restoreTimer) return;
  window.clearTimeout(restoreTimer); restoreTimer = 0;
  restoredAt = performance.now();
  if (!outgoing) { s.destroy(); scene = null; }
  replaceScene(LOST_MSG);
}

function failLost(): void {
  window.clearTimeout(restoreTimer); restoreTimer = 0;
  scene?.destroy(); scene = null;
  retireOutgoing();
  if (view) ($("[data-viz-loading]", view) as HTMLElement).hidden = true;
  showError(LOST_MSG);
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
      parentKind: n.kind === "subagent" && n.parent ? (m.nodes.get(n.parent)?.kind ?? null) : null, // P-WORLDS.1: a world casts helpers by their parent
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
  noteBuild(ev.source, ev.e); // P-WORLDS.BUILD1 (ADR-0653)
  if (ev.source === HUB_ID) return;
  let out = outputs.get(ev.source);
  if (!out) { out = createOutput(); outputs.set(ev.source, out); }
  foldOutput(out, ev.e);
}

/** P-VIZ.APPROVE1 (ADR-0655): new asks pulse their badges; with Fly to approvals on, the camera flies to the newest
 *  (the scene cuts under reduced motion). Focus never moves: a reply being typed anywhere keeps its caret. */
function onApprovals(list: readonly VizApproval[]): void {
  asks?.arrived(list.map((a) => a.id));
  const a = list[list.length - 1];
  if (flyAsks && a && scene?.flyTo(a.node, FLY_HOLD_MS)) flights++;
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
    for (const e of st.events) if (applyEvent(model, e, now)) { noteLedger(e); noteBuild(e.source, e.e); }
    // P-WORLDS.BUILD1 (ADR-0653): the demo's build channel; each build's spawn arms the labeled sample it ends in.
    // P-WORLDS.BUILD2: the current world's template samples in turn (else the host's two).
    for (const b of st.builds) {
      if (b.e.type === "subagent") armSample(builds, b.source, demoSampleAt(buildWorld(), demoSampleTurn++));
      noteBuild(b.source, b.e);
    }
  }
  tick(model, now);
  const fresh = drainEvents(model);
  syncScene();
  if (fresh.length) scene?.fire(fresh);
  const arrived = drainNewApprovals(model); // P-VIZ.APPROVE1 (ADR-0655)
  if (arrived.length) onApprovals(arrived);
  asks?.sync(now);
  if (now - censusAt >= 500) {
    censusAt = now;
    paintCensus(now);
    paintLedger(now);
    if (hover) paintTip(hover.hit, hover.x, hover.y);
    syncScaffolds(); // P-WORLDS.BUILD1: a style, view or tier change rebuilds them; a gone node's build goes
    if (panel) paintPanel();
    if (view && themeSig && JSON.stringify(sceneTheme(view)) !== themeSig) remount(); // a theme switch while open
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
  // P-FLEET.CONN1: a reply that never comes (the window's connections to the engine all held by streams) must not
  // stop the poll chain for good; after FLEET_WAIT_MS this cycle counts as offline and the next one asks again.
  const st = await Promise.race([deps.fleetStatus().catch(() => null), new Promise<null>((r) => window.setTimeout(() => r(null), FLEET_WAIT_MS))]);
  fleetBusy = false;
  if (model !== m) return;
  fleetOffline = !st;
  if (st) {
    // P-VIZ.FLEET1 (ADR-0680): every lane in the fleet, not only the spokes born under the current Main session
    // (ADR-0410's hub scope is the orbit's). A new Main session, or an upgrade's restart, otherwise emptied Visualize
    // while those lanes kept running, and the ledger, which counts them, disagreed with the scene.
    const mine = st.lanes;
    applyFleet(m, mine.map((l) => ({ id: l.id, name: l.name, model: l.model, status: l.status, ...(l.usage ? { usage: l.usage } : {}), ...(l.pendingApproval ? { pendingApproval: l.pendingApproval } : {}) })), Date.now(), st.masterModel);
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
  if (!hit || hit.kind !== "node") { closePanel(); asks?.close(); return; } // P-VIZ.APPROVE1: the pop-out too
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
  asks?.close(); // P-VIZ.APPROVE1: one card beside a node at a time
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
  closeLook(); // P-WORLDS.CAST2: the look menu belongs to the panel
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
  // P-WORLDS.CAST2 (ADR-0650): a world's human figure (the hub or a lane) can have its look pinned.
  const castable = n.kind !== "subagent" && !!curWorld && !!scene?.castOf(id);
  const headSig = [n.name, n.persona, n.kind, n.status, n.laneStatus, n.goneAt, mainBusy, armed, busy, demo ? 1 : 0, parent?.name, castable, buildWorld()?.id ?? ""].join("|"); // P-WORLDS.BUILD1: the templates follow the world
  const stEl = $("[data-viz-panel-st]", box) as HTMLElement;
  if (stEl.textContent !== status) stEl.textContent = stEl.title = status; // ellipsizes; the title has the full line
  if (headSig !== panel.headSig) {
    panel.headSig = headSig;
    box.setAttribute("aria-label", `${n.name}: ${kind}`);
    box.style.setProperty("--viz-c", PERSONAS[n.persona].color);
    const nameEl = panelEl("[data-viz-panel-name]"), subEl = panelEl("[data-viz-panel-sub]");
    nameEl.textContent = nameEl.title = n.name; // P-VIZ.UI1: both ellipsize; the title has the full text
    subEl.textContent = subEl.title = `${PERSONAS[n.persona].label} \u00b7 ${kind}`;
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
    if (castable) {
      const who = n.kind === "hub" ? "Main" : n.name;
      acts += `<button type="button" class="viz-panel-act" data-viz-look-open="${esc(id)}" aria-haspopup="true" data-tip="${tipAttr("Customize look", `Pin ${who}'s presentation, skin, hair style and hair color. The look follows ${who} across worlds and restarts.`)}">Customize look</button>`;
    }
    if (n.kind !== "subagent") acts += miniGameActs(n, ended); // P-WORLDS.BUILD1 (ADR-0653)
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
  // P-PREVIEW.CHIP1: the Preview panel over this view goes first (with focus inside it, its own Esc closes it, since
  // the panel is the layer above us), then a preview chip's hover card; the next Esc is ours again.
  if (deps?.preview.isOver()) { deps.preview.close(); return; }
  if (previewChips?.escape()) return;
  if (ledgerView?.ownsFocus()) { ledgerView.collapse(); return; } // P-VIZ.6: Esc inside the ledger folds it back
  if (asks?.escape()) return; // P-VIZ.APPROVE1 (ADR-0655): the approval pop-out, then a strip holding focus
  if (lookPop) { closeLook(); return; } // P-WORLDS.CAST2 (ADR-0650)
  if (artifactPopupState().open) { closeArtifactPopup(); return; } // P-WORLDS.BUILD1 (ADR-0653)
  if (viewPop) { viewPop.close(); viewPop = null; return; }
  if (worldsPop) { worldsPop.close(); worldsPop = null; return; }
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

// ---------------------------------------------------------------------------------------------- P-WORLDS.BUILD1 (ADR-0653)
// Build sites: the build book (viz_build_model, fed after the model took an event), the scaffold riding each building
// node (viz_build through scene.anchor), the artifact chips and popup (viz_artifact_popup) and the mini-game templates
// in the node panel.

/** What each node builds and its artifact; made new on every open, like the model. */
let builds = createBuildBook();
/** The scaffold drawn for each node on the current scene (the scene disposes them with itself or their node). */
const scaffolds = new Map<string, WorldScaffold>();
/** The style, world, view and tier the scaffolds were made for; a change rebuilds them from the book. */
let scaffoldSig = "";
let chips: ArtifactChips | null = null;
/** P-WORLDS.BUILD2: which sample the next ?vizDemo=1 build ends in (demoSampleAt rotates through the world's). */
let demoSampleTurn = 0;

/** The world being drawn (its build sites and templates), or null in a built-in style. */
function buildWorld(): WorldDefinition | null {
  const s = effStyle();
  return s === "anime" || s === "professional" ? null : curWorld?.def ?? null;
}

/** The node's scaffold, made empty at its build site when it has none yet. Null without a scene, for a subagent, or
 *  when the scene does not have the node yet (syncScaffolds tries again). */
function scaffoldFor(id: string): WorldScaffold | null {
  const have = scaffolds.get(id);
  if (have) return have;
  const n = model?.nodes.get(id);
  if (!scene || !deps || !n || n.kind === "subagent") return null;
  const def = buildWorld();
  const site = buildSiteFor(def, n.kind === "hub" ? "hub" : "agent", def ? def.environment.edges.colorA : effStyle() === "professional" ? "#ffd166" : "#8fe3ff");
  let seed = 7;
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) | 0;
  const sc = createScaffold({ style: site.style, color: site.color, tier: deps.perf.tier(), flat: prefs.view === "2d", seed });
  const ok = scene.anchor(id, "build", {
    object: sc.group, offset: site.anchor, update: sc.update,
    dispose: () => { sc.dispose(); if (scaffolds.get(id) === sc) scaffolds.delete(id); },
  });
  if (!ok) { sc.dispose(); return null; }
  scaffolds.set(id, sc);
  return sc;
}

/** Play the book's steps on the scaffolds and chips. A scaffold made by a step starts from the book's state before it. */
function applyBuildSteps(steps: readonly BuildStep[]): void {
  for (const s of steps) {
    const b = builds.builds.get(s.node);
    const fresh = !scaffolds.has(s.node);
    switch (s.kind) {
      case "reset":
        scaffolds.get(s.node)?.reset();
        chips?.set(s.node, artifactOf(builds, s.node)); // a kept artifact stays
        break;
      case "add": {
        const sc = scaffoldFor(s.node);
        if (sc && fresh && b) sc.restore(Math.max(0, b.pieces - s.count), Math.min(b.locked, Math.max(0, b.pieces - s.count)), false);
        sc?.addPieces(s.count);
        break;
      }
      case "lock": scaffolds.get(s.node)?.lockIn(); break;
      case "fail": scaffolds.get(s.node)?.fail(); break;
      case "reveal": {
        const sc = scaffoldFor(s.node);
        if (sc && fresh && b) sc.restore(b.pieces, 0, false);
        sc?.reveal();
        if (s.artifact) chips?.set(s.node, s.artifact);
        break;
      }
    }
  }
  if (steps.length) scene?.wake();
}

/** An event the model took on `source` (or the demo's build channel) also drives its build. */
function noteBuild(source: string, e: { readonly type: string }): void {
  applyBuildSteps(buildEvent(builds, source, e, Date.now()));
}

/** Twice a second and after a mount: rebuild the scaffolds when the style, world, view or tier changed, stand up a
 *  build whose node joined the scene late, and drop the build of a node that left. */
function syncScaffolds(): void {
  if (!scene || !deps || !model) return;
  const sig = `${effStyle()}|${buildWorld()?.id ?? ""}|${prefs.view}|${deps.perf.tier()}`;
  if (sig !== scaffoldSig) {
    scaffoldSig = sig;
    for (const id of [...scaffolds.keys()]) scene.anchor(id, "build", null);
  }
  for (const [id, b] of builds.builds) {
    if (!model.nodes.has(id)) { dropBuild(builds, id); chips?.set(id, null); continue; }
    if ((b.pieces > 0 || b.revealed) && !scaffolds.has(id)) scaffoldFor(id)?.restore(b.pieces, b.locked, b.revealed);
  }
}

/** A chip was clicked: its artifact's popup (the gate first; Keep and Discard act on the book). */
function openChip(node: string, chip: HTMLElement): void {
  const a = artifactOf(builds, node);
  if (!a) { chips?.set(node, null); return; }
  openArtifactPopup(chip, a, {
    keep: (x) => { keepArtifact(builds, x.id); },
    discard: (x) => { applyBuildSteps(discardArtifact(builds, x.id)); chips?.set(x.node, null); },
  });
}

/** The node panel's Mini game row: the world's templates (or the host's), each an ordinary task for this node. */
function miniGameActs(n: VizNode, ended: boolean): string {
  const who = n.kind === "hub" ? "Main" : n.name;
  const def = buildWorld();
  const site = buildSiteFor(def, n.kind === "hub" ? "hub" : "agent", "#ffffff").label.toLowerCase();
  const off = demo ? "DEMO: the demo agents build their own sample game. Templates go to real agents."
    : n.kind === "agent" && (ended || n.status === "killed") ? `${who} has ended. Respawn it from the Fleet panel first.`
    : "";
  const why = `Sends this brief to ${who} as an ordinary task. Its subagents build at the ${site}; the single HTML file it ends with opens from a chip over ${who} after the security gate, untrusted and sandboxed.`;
  const sampleWhy = "Plays the template's ready-made sample now, no agent needed. It passes the same security gate and runs in the same sandbox. Keep puts it on this node.";
  // P-WORLDS.BUILD2: one row per template: its label, Build (the brief as a task), Play sample (when it has one).
  return `<div class="viz-panel-build" role="group" aria-label="Mini games"><span class="viz-panel-build-h">Mini game</span>${miniGamesFor(def).map((g) =>
    `<div class="viz-panel-game" data-viz-game-row="${esc(g.id)}"><span class="viz-panel-game-l" title="${esc(g.label)}">${esc(g.label)}</span>`
    + `<button type="button" class="viz-panel-act" data-viz-game="${esc(g.id)}" data-viz-node="${esc(n.id)}"${off ? " disabled" : ""} aria-label="Build ${esc(g.label)}" data-tip="${tipAttr(`Build ${g.label}`, off || why)}">${icon("bolt", 12)}<span>Build</span></button>`
    + (g.sample ? `<button type="button" class="viz-panel-act" data-viz-game-sample="${esc(g.id)}" data-viz-node="${esc(n.id)}" aria-label="Play the ${esc(g.label)} sample" data-tip="${tipAttr(`${g.label} sample`, sampleWhy)}">${icon("play", 12)}<span>Play sample</span></button>` : "")
    + `</div>`).join("")}</div>`;
}

/** P-WORLDS.BUILD2: the node panel's Play sample. The template's sample opens in the artifact popup labeled Sample
 *  (and Demo on the ?vizDemo=1 feed): the same gate first, the same sandbox. It is not on the node until Keep. */
function playSample(id: string, gameId: string): void {
  if (!view || !model || !panel || panel.id !== id) return;
  const n = model.nodes.get(id);
  const game = miniGamesFor(buildWorld()).find((g) => g.id === gameId);
  if (!n || n.kind === "subagent" || !game) return;
  const a = sampleArtifact(builds, id, game, Date.now());
  if (!a) return;
  if (demo) a.demo = true;
  openArtifactPopup(panelEl("[data-viz-panel-acts]"), a, {
    keep: (x) => { chips?.set(x.node, adoptArtifact(builds, x)); },
    discard: (x) => { if (artifactOf(builds, x.node)?.id === x.id) { applyBuildSteps(discardArtifact(builds, x.id)); chips?.set(x.node, null); } },
  });
}

/** Start a template on the panel's node: arm the build book (only this run's output can become an artifact), then
 *  send the brief through the panel's own send path (Main via the composer; a lane gets it now or staged). */
async function startMiniGame(id: string, gameId: string): Promise<void> {
  if (!view || !model || !panel || panel.id !== id || demo) return;
  const n = model.nodes.get(id);
  const game = miniGamesFor(buildWorld()).find((g) => g.id === gameId);
  if (!n || n.kind === "subagent" || !game) return;
  const input = panelEl("[data-viz-panel-input]") as HTMLTextAreaElement;
  if (input.disabled) return;
  const staged = n.kind === "hub" ? !!deps?.mainBusy() : sending.has(id) || n.status === "active" || n.status === "waiting" || n.laneStatus === "starting";
  applyBuildSteps(armTemplate(builds, id, game, staged, Date.now()));
  const draft = input.value;
  input.value = game.brief;
  await sendFromPanel();
  if (!input.value && draft) input.value = draft; // sent: the user's own draft comes back
}
