// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/fleet_orbit.ts - P-FLEET.L17: the Fleet Orbit view (hub and spoke) + the spoke takeover
// banner. The HUB is the master session; every lane is a SPOKE on an ellipse around it, connected by a
// live SVG line that carries the lane's state color (the fleet grid's own color language: only amber
// awaiting-input and red needs-approval animate, because those two block on a human). Clicking a spoke
// PROMOTES that lane into the main composer (the P-FLEET.L8 attach - the full IDE prompt window now
// drives the lane), and a fixed banner at the top of the screen names the spoke and carries the switch
// menu: Main, the whole fleet, or any other spoke by the name the user gave it.
//
// This file owns DOM, SVG and polling only. Geometry, glance wording and the switch-menu model live in
// orbit_layout.ts (pure, unit-tested). Like the grid, this view is a VIEWPORT, not a lifecycle owner:
// closing it never touches the lanes. The classic grid dock stays fully available ("Grid view") - the
// orbit is the map, the grid is the workbench.

import { $, el } from "./dom.ts";
import { gitAuthHint, parseGitRemote, providerLabel } from "../git_url.ts"; // P-FLEET.L18: the on-orbit form clones too
import { ageStr, esc } from "./format.ts";
import { icon, piMark } from "./icons.ts";
import { popover } from "./ui.ts";
import type { ApprovalScope, FleetStatusView, LaneView, LucidBridge, TimelineEntry } from "./bridge.ts";
import { isLaneTarget, type ComposerTarget } from "./composer_target.ts";
import { cycleSpoke, ghostKey, ghostSpokes, ORBIT_FPS_FLOOR, ORBIT_NODE_H, ORBIT_NODE_W, orbitMode, orbitSlots, readAllPages, spokeGlance, switchEntries, type GhostLists, type GhostMark, type GhostSpoke, type OrbitMode, type SwitchEntry } from "./orbit_layout.ts";

export interface FleetOrbitDeps {
  fleetStatus: LucidBridge["fleetStatus"];
  fleetAnswer: LucidBridge["fleetAnswer"];
  fleetRespawn: LucidBridge["fleetRespawn"];
  /** P-FLEET.L17 recovery: respawn a historical spoke under its old name/folder/model. */
  fleetSpawn: LucidBridge["fleetSpawn"];
  /** P-FLEET.L17 recovery: the durable lane-session ledger (P-FLEET.L5) - the memory ghosts rise from. */
  timelineList: LucidBridge["timelineList"];
  /** The P-FLEET.L8 attach/release pair, owned by app.ts (thread park/seed lives there). */
  promoteLane: (laneId: string) => void;
  demoteLane: () => void;
  /** Open the classic grid dock (the workbench: per-lane composers, queues and transcripts). */
  openGrid: () => void;
  /** The REAL OS folder dialog (fleet_grid's contract). Resolves null on cancel - never re-prompt. */
  pickFolder: (opts?: { title?: string; confirm?: string }) => Promise<string | null>;
  /** The master model picker's options, for the on-orbit spawn form's model select. */
  getModelOptions: () => { value: string; label: string }[];
  /** P-FLEET.L18: the grid form's vault pair, reused verbatim so a PAT typed here lands in the SAME
   *  per-host encrypted ref (git_pat_<host>) the grid writes. */
  saveGitToken: (input: { host: string; token: string; label: string }) => Promise<{ ok: boolean; error?: string }>;
  vaultAvailable: () => boolean;
  /** What the main composer is driving right now - the banner and the hub both read it. */
  getTarget: () => ComposerTarget;
  getMasterModel: () => string;
  getMasterCwd: () => string;
  /** The attached lane's OWN measured context fill (P-FLEET.L8 routes lane usage into state.liveUsage
   *  while promoted; P-FLEET.L19 seeds it on attach from the engine's last sample, and `size` is the
   *  same window the status ring divides by). null only for a lane that has never reported. */
  getLaneUsage: () => { used: number; size: number; cost: number } | null;
}

const POLL_MS = 2500;
/** How long an exiting card's fall-back-to-hub transition runs before the node is dropped. */
const EXIT_MS = 420;

// ---------------------------------------------------- P-FLEET.L18: which view the Fleet button opens
//
// The orbit is the default face of the fleet, but a grid-first user should not pay a detour every
// open. One persisted choice, set by the pin in either view's header; app.ts routes the ctFleet
// button through it. Shared from here (the grid imports it) so there is exactly one storage key.

const HOME_KEY = "lucid.fleetHome.v1";

export function fleetHome(): "orbit" | "grid" {
  try { return localStorage.getItem(HOME_KEY) === "grid" ? "grid" : "orbit"; } catch { return "orbit"; }
}

export function setFleetHome(v: "orbit" | "grid"): void {
  try { localStorage.setItem(HOME_KEY, v); } catch { /* degrade to per-session default */ }
  paintHomePin();
}

/** Repaint the orbit header's pin. The grid paints its own on the same call path. */
export function paintHomePin(): void {
  const pin = view ? ($("[data-orbit-pin]", view) as HTMLElement | null) : null;
  if (!pin) return;
  const on = fleetHome() === "orbit";
  pin.classList.toggle("on", on);
  pin.innerHTML = `${icon("star", 13)}${on ? " Default" : ""}`;
}

// ---------------------------------------------------------------- P-FLEET.L17: motion vs Lite mode
//
// The DECISION lives in orbit_layout.orbitMode (pure, spec-tested); this section only gathers the
// evidence: the WebGL renderer string (a software rasterizer means no GPU compositor is coming),
// prefers-reduced-motion, navigator.deviceMemory, the persisted user override, and - the honest gate -
// a measured frame rate from the first seconds the orbit is actually open. A verdict from measurement
// is persisted, so a machine that failed the floor once opens straight into Lite next time instead of
// stuttering for two seconds first. The header button lets the user overrule everything, both ways.

const MODE_KEY = "lucid.orbitMode.v1";

function readModeStore(): { user?: OrbitMode; measured?: number } {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(MODE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object") return {};
    const out: { user?: OrbitMode; measured?: number } = {};
    if ("user" in raw && (raw.user === "motion" || raw.user === "static")) out.user = raw.user;
    if ("measured" in raw && typeof raw.measured === "number") out.measured = raw.measured;
    return out;
  } catch { return {}; }
}
function writeModeStore(patch: { user?: OrbitMode | null; measured?: number }): void {
  const next = readModeStore();
  if (patch.user === null) delete next.user;
  else if (patch.user) next.user = patch.user;
  if (patch.measured !== undefined) next.measured = patch.measured;
  try { localStorage.setItem(MODE_KEY, JSON.stringify(next)); } catch { /* degrade to per-session memory */ }
}

/** The unmasked WebGL renderer, or null when WebGL itself is unavailable (a software signal too).
 *  Probed once: context creation is not free and the answer does not change mid-session. */
let webglRenderer: string | null | undefined;
function probeWebgl(): string | null {
  if (webglRenderer !== undefined) return webglRenderer;
  try {
    const gl = document.createElement("canvas").getContext("webgl") as WebGLRenderingContext | null;
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    webglRenderer = gl ? String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null;
  } catch { webglRenderer = null; }
  return webglRenderer;
}

function resolveMode(): OrbitMode {
  const stored = readModeStore();
  return orbitMode({
    override: stored.user ?? null,
    reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    webglRenderer: probeWebgl(),
    deviceMemoryGB: "deviceMemory" in navigator && typeof navigator.deviceMemory === "number" ? navigator.deviceMemory : undefined,
    measuredFps: stored.measured,
  });
}

let mode: OrbitMode = "motion";
/** "done" only once a measurement COMPLETES. An interrupted one (orbit closed, or Lite chosen, mid-
 *  window) re-arms, so the next open measures again instead of silently skipping the guard forever. */
let fpsGuard: "armed" | "measuring" | "done" = "armed";
/** Bumped when closeFleetOrbit abandons a measurement: its pending timer and rAF chain see a stale
 *  generation and stop, so frames from before a close/reopen never mix into the next window. */
let fpsGen = 0;

function applyMode(next: OrbitMode): void {
  mode = next;
  view?.classList.toggle("static", next === "static");
  banner?.classList.toggle("static", next === "static");
  const btn = view ? ($("[data-orbit-mode]", view) as HTMLElement | null) : null;
  if (btn) btn.innerHTML = next === "static" ? `${icon("spark", 13)} Lite` : `${icon("bolt", 13)} Motion`;
}

/** Measure ~2s of real frames once the entrance settles; a sustained miss of the floor persists the
 *  verdict and re-resolves the mode (so an explicit user "Motion" still wins, per orbitMode's spec).
 *  Completes once per session and only in motion mode - Lite has nothing left to measure. */
function runFpsGuard(): void {
  if (fpsGuard !== "armed" || mode !== "motion") return;
  fpsGuard = "measuring";
  const gen = fpsGen;
  // Still ours and still meaningful? A close bumps fpsGen (and re-arms there); a switch to Lite re-arms here.
  const live = (): boolean => {
    if (gen !== fpsGen) return false;
    if (!view || view.hidden || mode !== "motion") { fpsGuard = "armed"; return false; }
    return true;
  };
  window.setTimeout(() => {
    if (!live()) return;
    let frames = 0;
    const t0 = performance.now();
    const tick = (): void => {
      if (!live()) return;
      frames++;
      const dt = performance.now() - t0;
      if (dt < 2000) { requestAnimationFrame(tick); return; }
      fpsGuard = "done";
      const fps = (frames / dt) * 1000;
      if (fps < ORBIT_FPS_FLOOR) { writeModeStore({ measured: Math.round(fps) }); applyMode(resolveMode()); }
    };
    requestAnimationFrame(tick);
  }, 900); // let the staggered entrance finish; measuring the fly-out would indict the spring, not the machine
}

// ------------------------------------------------------- P-FLEET.L17: historical spokes (recovery)
//
// The durable lane-session ledger (P-FLEET.L5 timeline) remembers every lane that ever ran; the fleet
// itself forgets on engine restart. Ghosts bridge the two: any logical spoke (name + folder) the ledger
// knows and the live fleet does not is retrievable - respawned under its old name, folder and model -
// FOREVER. Two marks, both timestamped so a fresh run always resurfaces the spoke, and both reversible
// renderer-local view state: ARCHIVE tucks it into a collapsed section; HIDE takes it off the list into
// the collapsed Hidden section, where Unhide brings it back. Neither deletes anything - the ledger and
// the Timeline keep every run - so neither needs a confirmation. The list is an IN-ORBIT PANEL, not a
// floating popover: it lives inside the view's own DOM and stacking context, so nothing between overlay
// layers can swallow it.

const HIDE_KEY = "lucid.orbitHidden.v1";
const ARCH_KEY = "lucid.orbitArchive.v1";
let ghostLists: GhostLists = { active: [], archived: [], hidden: [] };
let archOpen = false;
let hidOpen = false;
/** The last complete ledger read. Reads can overlap (open, census change, a recover); only the newest
 *  may land. */
let ghostLedger: TimelineEntry[] = [];
let ghostGen = 0;

function readMarks(storageKey: string): GhostMark[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const out: GhostMark[] = [];
    for (const t of raw) {
      if (t && typeof t === "object" && "key" in t && "at" in t && typeof t.key === "string" && typeof t.at === "number") {
        out.push({ key: t.key, at: t.at });
      }
    }
    return out;
  } catch { return []; }
}
function writeMarks(storageKey: string, marks: GhostMark[]): void {
  try { localStorage.setItem(storageKey, JSON.stringify(marks)); } catch { /* degrade to per-session marks */ }
}
function placeMark(storageKey: string, g: GhostSpoke): void {
  // The mark covers everything up to the CLICK, not up to the last ledger row this renderer had seen:
  // a lane still flushing rows (or one running under another engine on a shared ledger) would otherwise
  // out-race its own archive/hide within seconds. Future runs still resurface the spoke.
  writeMarks(storageKey, [...readMarks(storageKey).filter((t) => t.key !== g.key), { key: g.key, at: Math.max(g.lastAt, Date.now()) }]);
}
function dropMark(storageKey: string, g: GhostSpoke): void {
  writeMarks(storageKey, readMarks(storageKey).filter((m) => m.key !== g.key));
}

async function refreshGhosts(): Promise<void> {
  if (!deps || !view) return;
  const gen = ++ghostGen;
  const d = deps;
  // The WHOLE ledger, every page: a spoke whose latest run sits past page one is still recoverable.
  const entries = await readAllPages((limit, offset) => d.timelineList(limit, offset).catch(() => null));
  // A failed read keeps the ledger we had (a partial one would silently drop ghosts); a newer read wins.
  if (!entries || gen !== ghostGen) return;
  ghostLedger = entries;
  paintGhosts();
}

/** Re-derive the lists from the cached ledger + the live fleet + the marks. A row action (archive,
 *  hide, unhide) changes only the marks, so it repaints from here without re-reading the ledger. */
function paintGhosts(): void {
  if (!view) return;
  ghostLists = ghostSpokes(ghostLedger, lastStatus?.lanes ?? [], readMarks(HIDE_KEY), readMarks(ARCH_KEY));
  const n = ghostLists.active.length + ghostLists.archived.length;
  // Hidden spokes are not counted, but they still keep the button reachable: Unhide lives in the panel.
  const any = n + ghostLists.hidden.length > 0;
  for (const b of view.querySelectorAll("[data-orbit-recover]")) {
    const badge = b.querySelector("[data-orbit-ghostn]") as HTMLElement | null;
    if (badge) {
      if (badge.textContent !== String(n)) badge.textContent = String(n);
      badge.hidden = n === 0;
    }
    (b as HTMLElement).hidden = !any;
  }
  paintGhostPanel();
}

// ---------------------------------------------------------------------- the in-orbit side panels
// One panel at a time: "ghosts" (historical spokes) or "spawn" (new spoke). Both are children of the
// stage, so the fleet stays visible behind them and no popover positioning is involved.

type OrbitPanel = "ghosts" | "spawn";
let openedPanel: OrbitPanel | null = null;

function togglePanel(which: OrbitPanel): void {
  openedPanel = openedPanel === which ? null : which;
  const host = view ? ($("[data-orbit-panel]", view) as HTMLElement | null) : null;
  if (!host) return;
  host.hidden = openedPanel === null;
  host.classList.toggle("show", openedPanel !== null);
  // A closed panel keeps no DOM: the spawn form's password input must not hold a token while hidden.
  if (openedPanel === null) { const body = $("[data-orbit-panel-body]", host); if (body) body.innerHTML = ""; }
  if (openedPanel === "ghosts") { paintGhostPanel(); void refreshGhosts(); }
  if (openedPanel === "spawn") paintSpawnPanel();
}

/** Which list a row belongs to: active, archived ("z"), or hidden. */
type GhostList = "a" | "z" | "h";
const HIDE_BTN = `<button class="orbit-ghost-x" data-ghost-hide data-tip="Hide|Takes this spoke off the Recover list. Nothing is deleted: its conversation stays in the Timeline, and the Hidden section below brings it back. A future run also resurfaces it.">${icon("minus", 12)}</button>`;

/** A ghost row. Addressed by list + INDEX, never by key: the key embeds a NUL separator, and the HTML
 *  parser rewrites U+0000 in attribute values to U+FFFD, so a key round-tripped through the DOM would
 *  never match its own model again (found live: every row action silently no-opped). */
function ghostRow(g: GhostSpoke, i: number, list: GhostList): string {
  const actions = list === "h"
    ? `<button class="btn-mini orbit-btn" data-ghost-unhide data-tip="Unhide|Back on the Recover list.">${icon("eye", 12)} Unhide</button>`
    : `<button class="btn-mini orbit-btn" data-ghost-recover data-tip="Recover|Respawns this spoke with its old name, folder and model. New session; the old conversation stays reviewable in the Timeline.">${icon("restore", 12)} Recover</button>
      ${list === "z"
        ? `<button class="orbit-ghost-x" data-ghost-unarchive data-tip="Unarchive|Back to the main list.">${icon("archive", 12)}</button>`
        : `<button class="orbit-ghost-x" data-ghost-archive data-tip="Archive|Tucks this spoke into the archived section. Reversible; a future run also resurfaces it.">${icon("archive", 12)}</button>`}
      ${HIDE_BTN}`;
  return `<div class="orbit-ghost${list === "a" ? "" : " archived"}" data-ghost-i="${i}" data-ghost-list="${list}" title="${esc(g.cwd)}\n${esc(g.model)}">
      <i class="orbit-ghost-dot"></i>
      <span class="orbit-ghost-id"><b>${esc(g.name)}</b><small>${esc(folderTail(g.cwd))} \u00b7 ${g.turns} ${g.turns === 1 ? "turn" : "turns"} \u00b7 ${ageStr(g.lastAt)}</small><small class="orbit-ghost-err" data-ghost-err></small></span>
      ${actions}
    </div>`;
}

/** A collapsed section (Archived, Hidden): its toggle, then its rows only while open. */
function ghostSection(label: string, rows: GhostSpoke[], list: GhostList, open: boolean, toggleAttr: string): string {
  if (rows.length === 0) return "";
  return `<button class="orbit-arch-toggle${open ? " open" : ""}" ${toggleAttr}>${icon("chevron", 11)} ${label} <span>${rows.length}</span></button>`
    + (open ? rows.map((g, i) => ghostRow(g, i, list)).join("") : "");
}

function paintGhostPanel(): void {
  if (openedPanel !== "ghosts" || !view) return;
  const box = $("[data-orbit-panel-body]", view) as HTMLElement | null;
  if (!box) return;
  const { active, archived, hidden } = ghostLists;
  const head = `<div class="orbit-panel-h">${icon("restore", 14)}<b>Historical spokes</b><span>${active.length + archived.length}</span><button class="orbit-ghost-x" data-orbit-panel-close>${icon("close", 12)}</button></div>`;
  if (active.length === 0 && archived.length === 0 && hidden.length === 0) {
    box.innerHTML = `${head}<div class="orbit-ghosts-empty">No historical spokes yet. Every lane that runs is remembered here, and hiding one is always reversible.</div>`;
    return;
  }
  box.innerHTML = head
    + active.map((g, i) => ghostRow(g, i, "a")).join("")
    + ghostSection("Archived", archived, "z", archOpen, "data-ghost-archopen")
    + ghostSection("Hidden", hidden, "h", hidOpen, "data-ghost-hidopen");
}

/** Respawn the spoke under its recorded identity. A fresh omp session (the old one died with its
 *  process); the full old conversation stays reviewable in the Timeline, which is named right on the
 *  row so recovery never silently impersonates memory it does not have. */
async function recoverGhost(g: GhostSpoke, row: HTMLElement): Promise<void> {
  if (!deps) return;
  const btn = row.querySelector("[data-ghost-recover]") as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = "Recovering\u2026"; }
  const r = await deps.fleetSpawn({ cwd: g.cwd, name: g.name, ...(g.model ? { model: g.model } : {}) }).catch(() => null);
  if (!r?.ok) {
    // The folder may be gone, or pressure may refuse admission: say WHY, on the row, and let go.
    const err = row.querySelector("[data-ghost-err]") as HTMLElement | null;
    if (err) err.textContent = r?.reason ?? "The engine did not confirm the spawn.";
    if (btn) { btn.disabled = false; btn.innerHTML = `${icon("restore", 12)} Recover`; }
    return;
  }
  await refresh(false); // the recovered spoke flies out of the hub like any newborn lane
  void refreshGhosts();
}

/** Panel-internal clicks, routed from onViewClick. Returns true when the click was a panel action. */
function onPanelClick(t: HTMLElement): boolean {
  if (t.closest("[data-orbit-panel-close]")) { togglePanel(openedPanel ?? "ghosts"); return true; }
  if (t.closest("[data-ghost-archopen]")) { archOpen = !archOpen; paintGhostPanel(); return true; }
  if (t.closest("[data-ghost-hidopen]")) { hidOpen = !hidOpen; paintGhostPanel(); return true; }
  const row = t.closest("[data-ghost-i]") as HTMLElement | null;
  if (row) {
    const kind = row.dataset.ghostList;
    const list = kind === "z" ? ghostLists.archived : kind === "h" ? ghostLists.hidden : ghostLists.active;
    const g = list[Number(row.dataset.ghostI)];
    if (!g) return true;
    if (t.closest("[data-ghost-hide]")) {
      placeMark(HIDE_KEY, g);
      dropMark(ARCH_KEY, g); // hide beats archive; an unhidden spoke comes back to the main list
      paintGhosts();
    } else if (t.closest("[data-ghost-unhide]")) {
      dropMark(HIDE_KEY, g);
      paintGhosts();
    } else if (t.closest("[data-ghost-archive]")) {
      placeMark(ARCH_KEY, g);
      paintGhosts();
    } else if (t.closest("[data-ghost-unarchive]")) {
      dropMark(ARCH_KEY, g);
      paintGhosts();
    } else if (t.closest("[data-ghost-recover]")) {
      void recoverGhost(g, row);
    }
    return true;
  }
  // Spawn-panel controls.
  if (t.closest("[data-spawnp-browse]")) { void browseSpawnPanelFolder(); return true; }
  if (t.closest("[data-spawnp-go]")) { void submitSpawnPanel(); return true; }
  return t.closest("[data-orbit-panel]") !== null; // clicks on panel chrome stay in the panel
}

// ---------------------------------------------------------------------------- the on-orbit + Spoke form

function paintSpawnPanel(): void {
  if (openedPanel !== "spawn" || !view || !deps) return;
  const box = $("[data-orbit-panel-body]", view) as HTMLElement | null;
  if (!box) return;
  const models = deps.getModelOptions();
  const master = deps.getMasterModel();
  box.innerHTML = `<div class="orbit-panel-h">${icon("plus", 14)}<b>New spoke</b><button class="orbit-ghost-x" data-orbit-panel-close>${icon("close", 12)}</button></div>
    <label class="orbit-spawn-l">name <i>optional</i><input type="text" data-spawnp-name placeholder="what this spoke is for (defaults to the folder name)" maxlength="64"></label>
    <label class="orbit-spawn-l">repo url <i>optional</i><input type="text" data-spawnp-repo spellcheck="false" autocomplete="off" placeholder="https://github.com/org/repo.git or git@host:org/repo"></label>
    <small class="orbit-spawn-note" data-spawnp-repo-note hidden></small>
    <div class="orbit-spawn-auth" data-spawnp-auth hidden>
      <input type="password" data-spawnp-pat autocomplete="off" spellcheck="false" placeholder="Personal access token (private repos)">
      <label class="orbit-spawn-save"><input type="checkbox" data-spawnp-save checked><span data-spawnp-save-txt>Remember this token for this host</span></label>
    </div>
    <label class="orbit-spawn-l"><span data-spawnp-cwd-lbl>folder</span><span class="orbit-spawn-row"><input type="text" data-spawnp-cwd value="${esc(deps.getMasterCwd())}" placeholder="the folder this spoke works in">
      <button class="btn-mini orbit-btn" data-spawnp-browse>${icon("folder", 12)} Browse</button></span></label>
    <label class="orbit-spawn-l">model<select data-spawnp-model>${models.map((m) => `<option value="${esc(m.value)}"${m.value === master ? " selected" : ""}>${esc(m.label)}</option>`).join("") || `<option value="">master's model</option>`}</select></label>
    <div class="orbit-spawn-row"><button class="btn-mini orbit-btn orbit-spawn-go" data-spawnp-go>${icon("bolt", 13)} Create spoke</button></div>
    <small class="orbit-ghost-err" data-spawnp-err></small>`;
  ($("[data-spawnp-name]", box) as HTMLInputElement | null)?.focus();
}

/** P-FLEET.L18: the live hint under the repo field - what was recognized, where the clone lands, and
 *  which credential the remote actually needs (an ssh remote hides the PAT row entirely; asking for a
 *  token there is a lie the user debugs for twenty minutes - the grid form's own rule). */
function paintOrbitRepoHint(): void {
  if (!view || openedPanel !== "spawn") return;
  const raw = ($("[data-spawnp-repo]", view) as HTMLInputElement | null)?.value.trim() ?? "";
  const note = $("[data-spawnp-repo-note]", view) as HTMLElement | null;
  const auth = $("[data-spawnp-auth]", view) as HTMLElement | null;
  const lbl = $("[data-spawnp-cwd-lbl]", view) as HTMLElement | null;
  const remote = raw ? parseGitRemote(raw) : null;
  if (lbl) lbl.textContent = remote ? "clone into" : "folder";
  if (!raw) { if (note) { note.hidden = true; note.textContent = ""; } if (auth) auth.hidden = true; return; }
  if (!remote) {
    if (auth) auth.hidden = true;
    if (note) { note.hidden = false; note.classList.add("bad"); note.textContent = "Not a repo URL. Paste an https:// link, or a git@host:org/repo remote."; }
    return;
  }
  const parent = ($("[data-spawnp-cwd]", view) as HTMLInputElement | null)?.value.trim() || "the shared LUCID workspaces folder";
  if (note) {
    note.hidden = false;
    note.classList.remove("bad");
    note.textContent = `${providerLabel(remote.provider)}: ${remote.owner ? `${remote.owner}/` : ""}${remote.repo} - clones into ${parent}, reusing it if already there. ${gitAuthHint(remote)}`;
  }
  if (auth) auth.hidden = remote.scheme !== "https";
  const vault = deps?.vaultAvailable() === true;
  const saveTxt = $("[data-spawnp-save-txt]", view) as HTMLElement | null;
  if (saveTxt) saveTxt.textContent = vault ? `Remember this token for ${remote.host}, encrypted by this machine` : "This build cannot store tokens - it will be used for this clone only";
  const save = $("[data-spawnp-save]", view) as HTMLInputElement | null;
  if (save) { save.disabled = !vault; if (!vault) save.checked = false; }
}

async function browseSpawnPanelFolder(): Promise<void> {
  if (!deps || !view) return;
  const picked = await deps.pickFolder({ title: "Choose or create the folder this spoke works in", confirm: "Use this folder" }).catch(() => null);
  if (!picked) return; // cancel leaves whatever is typed alone - never clear, never re-prompt
  const input = $("[data-spawnp-cwd]", view) as HTMLInputElement | null;
  if (input) input.value = picked;
}

async function submitSpawnPanel(): Promise<void> {
  if (!deps || !view) return;
  const cwd = ($("[data-spawnp-cwd]", view) as HTMLInputElement | null)?.value.trim() ?? "";
  const name = ($("[data-spawnp-name]", view) as HTMLInputElement | null)?.value.trim() ?? "";
  const model = ($("[data-spawnp-model]", view) as HTMLSelectElement | null)?.value ?? "";
  const repoRaw = ($("[data-spawnp-repo]", view) as HTMLInputElement | null)?.value.trim() ?? "";
  const patInput = $("[data-spawnp-pat]", view) as HTMLInputElement | null;
  const pat = patInput?.value ?? "";
  const remember = ($("[data-spawnp-save]", view) as HTMLInputElement | null)?.checked === true;
  const err = $("[data-spawnp-err]", view) as HTMLElement | null;
  // Same rules as the grid form: a repo makes the folder optional (it clones into the shared
  // workspaces folder), and a repo that does not parse is refused before anything runs.
  const remote = repoRaw ? parseGitRemote(repoRaw) : null;
  if (repoRaw && !remote) { if (err) err.textContent = "That is not a repo URL. Paste an https:// link, or a git@host:org/repo remote."; return; }
  if (!repoRaw && !cwd) { if (err) err.textContent = "Pick the folder this spoke works in, or paste a repo URL to clone."; return; }
  if (err) err.textContent = "";
  const go = $("[data-spawnp-go]", view) as HTMLButtonElement | null;
  if (go) { go.disabled = true; go.innerHTML = remote ? `${icon("git", 12)} Cloning\u2026` : `${icon("bolt", 13)} Spawning\u2026`; }
  // Vault the token BEFORE the clone (a slow clone must not be able to lose it), under the host it was
  // typed for - the same per-host ref the grid form writes. Failing to STORE is a warning, not a stop.
  let warn = "";
  if (remote && remote.scheme === "https" && pat && remember) {
    const s = await deps.saveGitToken({ host: remote.host, token: pat, label: `${providerLabel(remote.provider)} token (${remote.host})` })
      .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    if (!s.ok) warn = `Token not saved (${s.error ?? "vault unavailable"}) - used for this clone only. `;
  }
  const r = await deps.fleetSpawn({ cwd, ...(name ? { name } : {}), ...(model ? { model } : {}), ...(remote ? { repoUrl: repoRaw } : {}), ...(remote && pat ? { pat } : {}) }).catch(() => null);
  // The request is done with the token either way: never leave the plaintext sitting in the DOM (a
  // retry pastes it again; a remembered one is already in the vault).
  if (patInput) patInput.value = "";
  if (!r?.ok) {
    if (err) err.textContent = warn + (r?.reason ?? "The engine did not confirm the spawn.");
    if (go) { go.disabled = false; go.innerHTML = `${icon("bolt", 13)} Create spoke`; }
    return;
  }
  // Close; the newborn flies out of the hub on the refresh below. Only if the form is still the open
  // panel: togglePanel would otherwise REOPEN it (the user closed it, or switched to Recover, mid-clone).
  if (openedPanel === "spawn") togglePanel("spawn");
  await refresh(false);
  void refreshGhosts();
}

const folderTail = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

let deps: FleetOrbitDeps | null = null;
let view: HTMLElement | null = null;
let pollTimer: number | null = null;
let lastStatus: FleetStatusView | null = null;
/** Card + line per lane id. Cards are reconciled, never rebuilt, so state-glow animations don't restart
 *  on every poll (the fleet grid's pill lesson). */
const nodes = new Map<string, { card: HTMLElement; line: SVGLineElement }>();

export function initFleetOrbit(d: FleetOrbitDeps): void {
  deps = d;
  // P-FLEET.L17: fleet navigation from the keyboard, anywhere in the app. Ctrl/Cmd+Alt is free of the
  // app's Ctrl/Cmd bindings (zoom, mic, hands-free) and arrows cannot be produced by AltGr layouts, so
  // typing text can never trigger a spoke hop.
  //   Ctrl/Cmd+Alt+Right / Left  -> next / previous promotable spoke (wraps; from Main enters the ring)
  //   Ctrl/Cmd+Alt+Up            -> back to Main (release the composer)
  //   Ctrl/Cmd+Alt+Down          -> toggle the orbit map
  window.addEventListener("keydown", onSpokeHotkey);
}

function onSpokeHotkey(e: KeyboardEvent): void {
  if (!deps || !(e.ctrlKey || e.metaKey) || !e.altKey || e.shiftKey) return;
  if (e.key === "ArrowDown") { e.preventDefault(); toggleFleetOrbit(); return; }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    const t = deps.getTarget();
    if (isLaneTarget(t)) deps.demoteLane();
    closeFleetOrbit();
    return;
  }
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  e.preventDefault();
  const dir: 1 | -1 = e.key === "ArrowRight" ? 1 : -1;
  void (async () => {
    const s = await deps!.fleetStatus();
    if (!s) return;
    const t = deps!.getTarget();
    const next = cycleSpoke(s.lanes, isLaneTarget(t) ? t.laneId : null, dir);
    if (next) takeover(next);
  })();
}

export function toggleFleetOrbit(): void {
  if (view && !view.hidden) closeFleetOrbit(); else openFleetOrbit();
}

export function openFleetOrbit(): void {
  if (!deps) return;
  if (!view) view = buildView();
  if (!view.isConnected) document.body.appendChild(view);
  view.hidden = false;
  applyMode(resolveMode());
  paintHomePin();
  runFpsGuard();
  // Entrance replays: the overlay fades/scales in as one unit, then spokes fly out staggered.
  view.classList.remove("open");
  requestAnimationFrame(() => view?.classList.add("open"));
  void refresh(true);
  if (pollTimer == null) pollTimer = window.setInterval(() => void refresh(false), POLL_MS);
  window.addEventListener("resize", onResize);
  window.addEventListener("keydown", onKey, true);
}

export function closeFleetOrbit(): void {
  if (!view || view.hidden) return;
  if (openedPanel) togglePanel(openedPanel); // a hidden map keeps no half-filled form (or typed token) behind
  if (fpsGuard === "measuring") { fpsGuard = "armed"; fpsGen++; } // abandon a straddling measurement; the next open re-measures
  view.classList.remove("open");
  const v = view;
  window.setTimeout(() => { v.hidden = true; }, 220);
  if (pollTimer != null) { window.clearInterval(pollTimer); pollTimer = null; }
  window.removeEventListener("resize", onResize);
  window.removeEventListener("keydown", onKey, true);
  // Cards are kept (cheap, and reopening repaints instantly); only the census reconcile mutates them.
}

const onResize = (): void => { if (lastStatus) layoutStage(lastStatus.lanes); };
const onKey = (e: KeyboardEvent): void => {
  if (e.key !== "Escape" || !view || view.hidden) return;
  e.preventDefault(); e.stopPropagation();
  if (openedPanel) { togglePanel(openedPanel); return; } // one Esc per layer: panel first, then the map
  closeFleetOrbit();
};

// ---------------------------------------------------------------------------------------------- chrome

function buildView(): HTMLElement {
  const v = el(`<div id="orbitView" class="orbit-view" hidden>
    <div class="orbit-nebula" aria-hidden="true"></div>
    <header class="orbit-head">
      <div class="orbit-title">${icon("share", 17)}<b>LUCID Fleet</b><span class="orbit-sub">hub &amp; spoke</span></div>
      <div class="orbit-census" data-orbit-census></div>
      <div class="orbit-hud" data-orbit-hud data-tip="Fleet pressure|CPU and memory right now. A metric sustained over the line refuses NEW spokes; running ones are never touched."></div>
      <span class="orbit-headgap"></span>
      <button class="btn-mini orbit-btn" data-orbit-recover hidden data-tip="Historical spokes|Every lane that ever ran, remembered by the durable ledger. Recover one and it rejoins the orbit under its old name, folder and model; hide one and it waits in the Hidden section.">${icon("restore", 13)} Recover <b class="orbit-ghost-n" data-orbit-ghostn></b></button>
      <button class="btn-mini orbit-btn" data-orbit-spawn data-tip="New spoke|Create it right here: name, folder (real OS browser) and model, or paste a repo URL to clone it first.">${icon("plus", 13)} New spoke</button>
      <button class="btn-mini orbit-btn" data-orbit-mode data-tip="Motion vs Lite|Lite is the SAME hub and spoke as a still page: no motion, no blur - for machines without GPU compositing. Auto-picked (reduced-motion, software renderer, low memory, or a measured frame rate under 30); your click here overrules the probe both ways."></button>
      <button class="btn-mini orbit-btn" data-orbit-grid data-tip="Grid view|The classic fleet dashboard: streaming mini agent windows with per-lane composers, queues and transcripts.">${icon("layout", 13)} Grid</button>
      <button class="btn-mini orbit-btn orbit-pin" data-orbit-pin data-tip="Default view|Make ORBIT what the Fleet button opens. The grid header has the same pin for grid-first users."></button>
      <button class="btn-mini orbit-btn orbit-x" data-orbit-close data-tip="Close (Esc)|The spokes keep running; this view is a map, not a lifecycle owner.">${icon("close", 13)}</button>
    </header>
    <div class="orbit-stage" data-orbit-stage>
      <svg class="orbit-svg" data-orbit-svg aria-hidden="true"></svg>
      <div class="orbit-hub" data-orbit-hub role="button" tabindex="0">
        <span class="orbit-hub-ping" aria-hidden="true"></span><span class="orbit-hub-ping p2" aria-hidden="true"></span>
        <div class="orbit-hub-core">
          <span class="orbit-hub-mark">${piMark}</span>
          <b>Main</b>
          <span class="orbit-hub-model" data-orbit-hub-model></span>
          <span class="orbit-hub-here" data-orbit-hub-here></span>
        </div>
      </div>
      <div class="orbit-empty" data-orbit-empty hidden>
        <p>No spokes yet. The hub is all alone out here.</p>
        <button class="btn-mini orbit-btn" data-orbit-spawn>${icon("plus", 13)} Spawn your first spoke</button>
        <button class="btn-mini orbit-btn" data-orbit-recover hidden>${icon("restore", 13)} Recover a historical spoke <b class="orbit-ghost-n" data-orbit-ghostn></b></button>
      </div>
      <aside class="orbit-panel" data-orbit-panel hidden><div class="orbit-panel-body" data-orbit-panel-body></div></aside>
    </div>
  </div>`);
  v.addEventListener("click", onViewClick);
  // P-FLEET.L18: typing a remote (or changing the destination) re-derives the provider, the clone
  // path, and whether a token is even relevant - the grid form's own live-hint rule.
  v.addEventListener("input", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.matches?.("[data-spawnp-repo], [data-spawnp-cwd]")) paintOrbitRepoHint();
  });
  ($("[data-orbit-hub]", v) as HTMLElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHome(); }
  });
  return v;
}

function onViewClick(ev: Event): void {
  const t = ev.target as HTMLElement;
  if (t.closest("[data-orbit-close]")) { closeFleetOrbit(); return; }
  if (t.closest("[data-orbit-mode]")) {
    // An explicit choice, persisted: the probe proposes, the user disposes - in BOTH directions.
    writeModeStore({ user: mode === "motion" ? "static" : "motion" });
    applyMode(resolveMode());
    return;
  }
  if (t.closest("[data-orbit-pin]")) { setFleetHome("orbit"); return; }
  if (t.closest("[data-orbit-recover]")) { togglePanel("ghosts"); return; }
  // The on-orbit panel spawns (folder or repo clone + vault PAT, P-FLEET.L18), so creating a spoke never
  // leaves the screen; the grid stays one click away as the workbench.
  if (t.closest("[data-orbit-grid]")) { closeFleetOrbit(); deps?.openGrid(); return; }
  if (t.closest("[data-orbit-spawn]")) { togglePanel("spawn"); return; }
  if (t.closest("[data-orbit-panel]")) { onPanelClick(t); return; }
  if (t.closest("[data-orbit-hub]")) { goHome(); return; }
  const approveSession = t.closest("[data-orbit-allow-session]") as HTMLElement | null;
  if (approveSession) { void answer(approveSession.dataset.orbitAllowSession!, true, "session"); return; }
  const approve = t.closest("[data-orbit-allow]") as HTMLElement | null;
  if (approve) { void answer(approve.dataset.orbitAllow!, true, "once"); return; }
  const deny = t.closest("[data-orbit-deny]") as HTMLElement | null;
  if (deny) { void answer(deny.dataset.orbitDeny!, false); return; }
  const respawn = t.closest("[data-orbit-respawn]") as HTMLElement | null;
  if (respawn) { void deps?.fleetRespawn(respawn.dataset.orbitRespawn!); window.setTimeout(() => void refresh(false), 400); return; }
  const card = t.closest(".orbit-node") as HTMLElement | null;
  if (card?.dataset.laneId) { takeover(card.dataset.laneId); return; }
}

/** Hub click: come home. Attached to a spoke -> release the composer; already on Main -> just land. */
function goHome(): void {
  const target = deps?.getTarget();
  if (target && isLaneTarget(target)) deps?.demoteLane();
  closeFleetOrbit();
}

/** Spoke click: the takeover. Attach the main composer to this lane and leave the map - the banner at
 *  the top of the screen (renderSpokeBanner) now names where you are. Re-clicking the spoke you are
 *  already driving just returns you to the composer. */
function takeover(laneId: string): void {
  const target = deps?.getTarget();
  if (!(target && isLaneTarget(target) && target.laneId === laneId)) deps?.promoteLane(laneId);
  closeFleetOrbit();
}

/** P-FLEET.L19: every surface offers the grid's scope choice. "session" also allows every same-kind ask
 *  for the rest of the lane's session; the engine ignores scope on a deny (fail-closed). */
async function answer(laneId: string, allow: boolean, scope: ApprovalScope = "once"): Promise<void> {
  await deps?.fleetAnswer(laneId, allow, scope);
  void refresh(false);
  void bannerRefresh(); // the composer's ask dock and the banner chip settle now, not at the next poll
}

// ------------------------------------------------------------------------------------------ reconcile

async function refresh(first: boolean): Promise<void> {
  if (!deps || !view || view.hidden) return;
  const s = await deps.fleetStatus();
  if (!s || !view || view.hidden) return;
  lastStatus = s;
  paintHead(s);
  reconcile(s.lanes, first);
  layoutStage(s.lanes);
  paintHub();
  // Ghosts read the durable ledger, which only changes when a lane runs or dies - the open-time fetch
  // plus every census change keeps the Recover badge honest without hammering the ledger per poll.
  if (first || censusSig(s.lanes) !== ghostCensus) { ghostCensus = censusSig(s.lanes); void refreshGhosts(); }
}

/** The live identities that suppress ghosts; a spawn/stop/remove changes it, a status flip does not. */
let ghostCensus = "";
const censusSig = (lanes: LaneView[]): string => lanes.map((l) => ghostKey(l.name, l.cwd)).sort().join("\u0001");

function paintHead(s: FleetStatusView): void {
  const census = $("[data-orbit-census]", view!) as HTMLElement;
  const order = ["needs-approval", "awaiting-input", "working", "starting", "done", "error", "stopped"] as const;
  const html = order
    .map((st) => ({ st, n: s.lanes.filter((l) => l.status === st).length }))
    .filter((r) => r.n > 0)
    .map((r) => `<span class="fleet-pip lane-${r.st}" data-tip="${esc(r.st)}|${s.lanes.filter((l) => l.status === r.st).map((l) => esc(l.name)).join(", ")}"><i></i><b>${r.n}</b></span>`)
    .join("");
  const next = html || `<span class="orbit-census-zero">quiet skies</span>`;
  if (census.innerHTML !== next) census.innerHTML = next;
  const hud = $("[data-orbit-hud]", view!) as HTMLElement;
  const pct = (v: number | null): string => (v == null ? "--%" : `${Math.round(v)}%`);
  const hot = s.resources.cpuHotMs > 0 || s.resources.memHotMs > 0;
  const hudNext = `cpu ${pct(s.resources.cpuPct)} \u00b7 mem ${pct(s.resources.memPct)}`;
  if (hud.textContent !== hudNext) hud.textContent = hudNext;
  hud.classList.toggle("hot", hot);
}

function paintHub(): void {
  const model = $("[data-orbit-hub-model]", view!) as HTMLElement;
  const next = deps?.getMasterModel() || "";
  if (model.textContent !== next) model.textContent = next;
  const here = $("[data-orbit-hub-here]", view!) as HTMLElement;
  const target = deps?.getTarget();
  const onLane = !!target && isLaneTarget(target);
  const t = onLane ? "click to return" : "you are here";
  if (here.textContent !== t) here.textContent = t;
  $("[data-orbit-hub]", view!)?.classList.toggle("here", !onLane);
}

/** Census reconcile: create cards for new lanes (they fly OUT of the hub), update the rest in place,
 *  and let removed lanes fall back INTO the hub before their nodes drop. */
function reconcile(lanes: LaneView[], first: boolean): void {
  const stage = $("[data-orbit-stage]", view!) as HTMLElement;
  const svg = $("[data-orbit-svg]", view!) as unknown as SVGSVGElement;
  const seen = new Set<string>();
  lanes.forEach((lane, i) => {
    seen.add(lane.id);
    let entry = nodes.get(lane.id);
    if (!entry) {
      const card = buildNode(lane);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "orbit-line");
      svg.appendChild(line);
      stage.appendChild(card);
      entry = { card, line };
      nodes.set(lane.id, entry);
      // Born at the hub, flown to the slot: the var flip happens in layoutStage after this frame.
      entry.card.style.setProperty("--tx", "0px");
      entry.card.style.setProperty("--ty", "0px");
      entry.card.style.transitionDelay = first ? `${Math.min(i * 60, 600)}ms` : "0ms";
      entry.card.classList.add("orbit-enter");
      requestAnimationFrame(() => entry!.card.classList.remove("orbit-enter"));
    }
    paintNode(entry.card, lane);
    entry.line.setAttribute("data-status", lane.status);
    entry.line.classList.toggle("promoted", lane.promoted);
  });
  for (const [id, entry] of nodes) {
    if (seen.has(id)) continue;
    nodes.delete(id);
    entry.line.remove();
    entry.card.classList.add("orbit-exit");
    entry.card.style.setProperty("--tx", "0px");
    entry.card.style.setProperty("--ty", "0px");
    window.setTimeout(() => entry.card.remove(), EXIT_MS);
  }
  ($("[data-orbit-empty]", view!) as HTMLElement).hidden = lanes.length > 0;
}

function buildNode(lane: LaneView): HTMLElement {
  const card = el(`<div class="orbit-node" data-lane-id="${esc(lane.id)}" role="button" tabindex="0" style="--fd:${(Math.abs(hash(lane.id)) % 40) / 10}s;--fdur:${5 + (Math.abs(hash(lane.id)) % 3)}s">
    <div class="orbit-node-float">
      <div class="orbit-node-card">
        <div class="orbit-node-head"><i class="orbit-led"></i><b class="orbit-name"></b><span class="orbit-incomposer" hidden>${icon("arrowRight", 11)} composer</span></div>
        <div class="orbit-glance"></div>
        <div class="orbit-meta"><span class="orbit-model"></span></div>
        <div class="orbit-approve" hidden>
          <span class="orbit-approve-sum"></span>
          <span class="orbit-approve-btns">
            <button class="btn-mini orbit-allow" data-orbit-allow="${esc(lane.id)}" data-tip="Allow once|Approve only this ask. The next one asks again.">${icon("check", 12)} Once</button>
            <button class="btn-mini orbit-allow" data-orbit-allow-session="${esc(lane.id)}" data-tip="Allow for session|Approve this ask and every same-kind ask for the rest of this spoke's session.">${icon("check", 12)} Session</button>
            <button class="btn-mini orbit-deny" data-orbit-deny="${esc(lane.id)}">${icon("close", 12)} Deny</button>
          </span>
        </div>
        <div class="orbit-revive" hidden><button class="btn-mini" data-orbit-respawn="${esc(lane.id)}">${icon("refresh", 12)} Respawn</button></div>
        <div class="orbit-cta">${icon("arrowRight", 12)} open in composer</div>
      </div>
    </div>
  </div>`);
  // role=button semantics for the CARD itself: Enter and Space open it. Keys aimed at the nested native
  // buttons (Allow, Deny, Respawn) bubble through here and must be left to activate those buttons.
  card.addEventListener("keydown", (e) => {
    if (e.target !== card || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    takeover(lane.id);
  });
  return card;
}

/** Repaint a card in place. Text writes are guarded so an unchanged poll costs nothing and never
 *  restarts a running glow animation. */
function paintNode(card: HTMLElement, lane: LaneView): void {
  const cls = `orbit-node lane-${lane.status}${lane.promoted ? " promoted" : ""}`;
  const keep = card.classList.contains("orbit-enter") ? " orbit-enter" : "";
  if (card.getAttribute("class") !== cls + keep) card.setAttribute("class", cls + keep);
  setText(card, ".orbit-name", lane.name);
  card.title = `${lane.name}\n${lane.cwd}\n${lane.model}`;
  setText(card, ".orbit-glance", spokeGlance(lane));
  setText(card, ".orbit-model", lane.model);
  (card.querySelector(".orbit-incomposer") as HTMLElement).hidden = !lane.promoted;
  const ap = card.querySelector(".orbit-approve") as HTMLElement;
  ap.hidden = !lane.pendingApproval;
  if (lane.pendingApproval) setText(card, ".orbit-approve-sum", lane.pendingApproval.summary);
  (card.querySelector(".orbit-revive") as HTMLElement).hidden = !(lane.status === "error" || lane.status === "stopped");
}

function setText(root: HTMLElement, sel: string, text: string): void {
  const n = root.querySelector(sel) as HTMLElement | null;
  if (n && n.textContent !== text) n.textContent = text;
}

/** Deterministic tiny hash: seeds each spoke's idle-float phase so the constellation drifts out of
 *  sync (uniform bobbing reads as a glitch, not weather). */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Position every card and line from the pure layout. Cards transition on --tx/--ty; lines follow
 *  instantly (SVG attrs), which is invisible in practice because the poll repositions both together. */
function layoutStage(lanes: LaneView[]): void {
  if (!view || view.hidden) return;
  const stage = $("[data-orbit-stage]", view) as HTMLElement;
  const svg = $("[data-orbit-svg]", view) as unknown as SVGSVGElement;
  const w = stage.clientWidth, h = stage.clientHeight;
  if (w === 0 || h === 0) return;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const cx = w / 2, cy = h / 2;
  const slots = orbitSlots(lanes.length, w, h);
  // Decorative ring ellipses for each occupied ring, dash-drifting slowly (pure ornament, one per ring).
  const rings = [...new Set(slots.map((s) => s.ring))];
  const ringEls = svg.querySelectorAll(".orbit-ringline");
  if (ringEls.length !== rings.length) {
    ringEls.forEach((r) => r.remove());
    for (const ring of rings) {
      const sample = slots.find((s) => s.ring === ring)!;
      const rx = Math.hypot(sample.x, 0) || Math.abs(sample.y);
      const e = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
      e.setAttribute("class", "orbit-ringline");
      e.setAttribute("cx", String(cx)); e.setAttribute("cy", String(cy));
      // Recover the ellipse radii from any slot on the ring: x = rx cos a, y = ry sin a.
      const a = (sample.angle * Math.PI) / 180;
      e.setAttribute("rx", String(Math.abs(Math.cos(a)) > 0.01 ? Math.abs(sample.x / Math.cos(a)) : rx));
      e.setAttribute("ry", String(Math.abs(Math.sin(a)) > 0.01 ? Math.abs(sample.y / Math.sin(a)) : rx));
      svg.insertBefore(e, svg.firstChild);
    }
  }
  lanes.forEach((lane, i) => {
    const entry = nodes.get(lane.id);
    const slot = slots[i];
    if (!entry || !slot) return;
    entry.card.style.setProperty("--tx", `${Math.round(slot.x)}px`);
    entry.card.style.setProperty("--ty", `${Math.round(slot.y)}px`);
    entry.line.setAttribute("x1", String(cx));
    entry.line.setAttribute("y1", String(cy));
    entry.line.setAttribute("x2", String(cx + slot.x));
    entry.line.setAttribute("y2", String(cy + slot.y));
  });
}

// ------------------------------------------------------------------------- the spoke takeover banner
//
// P-FLEET.L17: while the main composer drives a spoke, the TOP of the screen says so, loudly enough
// that "which agent gets my next Enter" is never a memory test. The banner complements the composer's
// own P-FLEET.L8 chip (that one sits AT the prompt; this one is visible even scrolled into a long
// transcript) and carries the switch menu.

let banner: HTMLElement | null = null;
let menuPop: { close: () => void } | null = null;
let vitalsPop: { node: HTMLElement; close: () => void; reposition: () => void } | null = null;
let bannerTimer: number | null = null;
/** The banner's freshest LaneView for the attached lane, from its own 2.5s poll. Only ever the lane
 *  the banner NAMES (bannerLaneId): the vitals Allow/Deny answer this lane. */
let bannerLane: LaneView | null = null;
/** The lane the banner names, and a generation bumped whenever that changes or the banner goes away. A
 *  poll captures the generation before its await and drops its answer if it moved: a poll started for
 *  spoke A must never become bannerLane while the banner names spoke B. */
let bannerLaneId: string | null = null;
let bannerGen = 0;

/** Called by app.ts renderComposerTarget on every attach/detach. Master target = no banner. */
export function renderSpokeBanner(target: ComposerTarget): void {
  if (!isLaneTarget(target)) {
    menuPop?.close(); menuPop = null;
    vitalsPop?.close(); vitalsPop = null;
    if (bannerTimer != null) { window.clearInterval(bannerTimer); bannerTimer = null; }
    bannerGen++; bannerLaneId = null; bannerLane = null;
    paintAskDock(null, "", undefined); // the ask stays on the spoke's orbit/grid card; the composer left it
    if (banner) { banner.classList.remove("show"); const b = banner; banner = null; window.setTimeout(() => b.remove(), 260); }
    return;
  }
  if (!banner) {
    banner = el(`<div id="spokeBanner" class="spoke-banner" role="status">
      <span class="spoke-beacon" aria-hidden="true"></span>
      <span class="spoke-kicker">on spoke</span>
      <b class="spoke-name"></b>
      <span class="spoke-vitals">
        <button class="spoke-chip spoke-chip-mem" data-tip="Spoke memory|THIS lane's own measured context fill and session cost - never the master's. Click for the full vitals.">${icon("brain", 12)}<b class="spoke-ctx">ctx --</b></button>
        <button class="spoke-chip spoke-chip-sec" data-tip="Spoke security|Approval mode, pending asks and session-allowed tools for THIS lane. Click for the full vitals.">${icon("shield", 12)}<b class="spoke-sec">\u2026</b></button>
      </span>
      <button class="spoke-menu-btn" data-tip="Switch|Back to Main, the whole fleet in orbit, or any other spoke by name. Keyboard: Ctrl+Alt+Left/Right cycles spokes, Ctrl+Alt+Up returns to Main, Ctrl+Alt+Down opens the orbit.">${icon("share", 13)} Switch ${icon("chevronDown", 11)}</button>
    </div>`);
    ($(".spoke-menu-btn", banner) as HTMLElement).addEventListener("click", () => void openSwitchMenu());
    for (const chip of banner.querySelectorAll(".spoke-chip")) chip.addEventListener("click", () => void openVitals());
    banner.classList.toggle("static", resolveMode() === "static"); // Lite reaches the banner's ornaments too
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner?.classList.add("show"));
  }
  const switched = target.laneId !== bannerLaneId;
  if (switched) {
    // A different spoke: nothing it reported yet is on screen. Every poll in flight belongs to the old
    // one (the generation drops it), the old spoke's ask and menu leave with it, and the chips and the
    // vitals read "not reported" until this spoke's own poll lands - immediately, below.
    bannerGen++;
    bannerLaneId = target.laneId;
    bannerLane = null;
    menuPop?.close(); menuPop = null;
    if (askDock && askDock.dataset.laneId !== target.laneId) paintAskDock(null, "", undefined);
    paintVitalChips();
    if (vitalsPop) { paintVitals(vitalsPop.node); vitalsPop.reposition(); }
  }
  const name = $(".spoke-name", banner) as HTMLElement;
  if (name.textContent !== target.name) name.textContent = target.name;
  banner.title = `${target.name}\n${target.cwd}\n${target.model}`;
  // The banner runs its OWN status poll (grid cadence) so the security chip reacts to an approval ask
  // even when neither the orbit nor the grid is open.
  if (bannerTimer == null) bannerTimer = window.setInterval(() => void bannerRefresh(), POLL_MS);
  if (switched) void bannerRefresh();
}

async function bannerRefresh(): Promise<void> {
  if (!deps || !banner || bannerLaneId === null) return;
  const gen = bannerGen;
  const laneId = bannerLaneId;
  const s = await deps.fleetStatus();
  // Stale: the banner moved to another spoke (or went away) while this poll was in flight. Its answer
  // describes a lane the banner no longer names, so it may neither paint nor arm an Allow.
  if (gen !== bannerGen || !banner) return;
  const t = deps.getTarget();
  if (!isLaneTarget(t) || t.laneId !== laneId) return;
  bannerLane = s?.lanes.find((l) => l.id === laneId) ?? null;
  // A failed poll (null status) says nothing about the ask, so it never clears a docked prompt.
  if (s) paintAskDock(laneId, t.name, bannerLane?.pendingApproval);
  paintVitalChips();
  if (vitalsPop) { paintVitals(vitalsPop.node); vitalsPop.reposition(); } // an ask arriving grows the card
}

/** The two glance chips: context fill (escalates at the composer's own 70/90 lines) and security
 *  posture (red pending ask > amber full-auto > quiet ask-me). */
function paintVitalChips(): void {
  if (!banner) return;
  const u = deps?.getLaneUsage() ?? null;
  const pct = u && u.size > 0 ? Math.round((u.used / u.size) * 100) : null;
  const mem = $(".spoke-chip-mem", banner) as HTMLElement;
  const ctx = $(".spoke-ctx", banner) as HTMLElement;
  const ctxTxt = pct == null ? "ctx --" : `ctx ${pct}%`;
  if (ctx.textContent !== ctxTxt) ctx.textContent = ctxTxt;
  mem.classList.toggle("warn", pct != null && pct >= 70 && pct < 90);
  mem.classList.toggle("hot", pct != null && pct >= 90);
  const sec = $(".spoke-chip-sec", banner) as HTMLElement;
  const st = $(".spoke-sec", banner) as HTMLElement;
  const l = bannerLane;
  const label = !l ? "\u2026" : l.pendingApproval ? "1 ask" : l.autoApprove ? "auto" : "ask me";
  if (st.textContent !== label) st.textContent = label;
  sec.classList.toggle("hot", !!l?.pendingApproval);
  sec.classList.toggle("warn", !l?.pendingApproval && !!l?.autoApprove);
}

// ------------------------------------------------------------------ P-FLEET.L19: the spoke's ask dock
//
// While the composer drives a spoke, that spoke's pending approval is DOCKED above the prompt bar (the
// master's own exec/egress cards live in the same place and share the styling). It is not a popover: no
// outside click, Esc or scroll can dismiss it, because a lane blocks on the answer and a prompt the user
// cannot get back is a lane stuck forever. It leaves only when the ask is answered (here, the orbit, the
// grid, or the vitals popover), when the lane stops asking, or when the composer leaves the spoke.
// Sources: the banner's 2.5s status poll (truth) plus noteSpokeAsk from app.ts for the instant paint.

let askDock: HTMLElement | null = null;
let askKey = "";
/** The ask just answered here. A status poll already in flight can still report it, and repainting it for
 *  one poll would read as "my click did nothing"; a genuinely new ask carries a different key. */
let answeredAsk: { key: string; at: number } | null = null;
const ASK_ECHO_MS = 3000;

/** app.ts calls this when a lane stream (prompt or watch) reports a permission ask, so the dock appears
 *  with the ask instead of up to one poll later. Asks from lanes the composer is not driving are ignored;
 *  their cards in the orbit and the grid carry them. */
export function noteSpokeAsk(laneId: string, ask: { summary: string; kind: string }): void {
  const t = deps?.getTarget();
  if (!t || !isLaneTarget(t) || t.laneId !== laneId) return;
  paintAskDock(laneId, t.name, ask);
}

function paintAskDock(laneId: string | null, name: string, ask: { summary: string; kind: string } | undefined): void {
  if (!laneId || !ask) { askDock?.remove(); askDock = null; askKey = ""; return; }
  const key = `${laneId}\u0001${ask.kind}\u0001${ask.summary}`;
  if (answeredAsk && answeredAsk.key === key && Date.now() - answeredAsk.at < ASK_ECHO_MS) return;
  if (askDock?.isConnected && key === askKey) return;
  const wrap = $(".composer-wrap") as HTMLElement | null;
  if (!wrap) return;
  askDock?.remove();
  askKey = key;
  const node = el(`<div id="spokeAskDock" role="alertdialog" aria-label="Spoke approval">
    <div class="perm perm-egress perm-exec">
      <div class="perm-eg-head">${icon("shield", 13)}<span class="spoke-ask-title"></span></div>
      <div class="perm-egress-target"><code class="perm-url spoke-ask-sum"></code></div>
      <div class="perm-exec-why"><code class="perm-prog spoke-ask-kind"></code><span>Stays here until you answer. Clicking elsewhere never dismisses it.</span></div>
      <div class="perm-actions perm-actions-col">
        <button class="perm-btn eg-allow" data-spoke-ask="once">Allow once</button>
        <button class="perm-btn eg-allow" data-spoke-ask="session">Allow for this session (every ${esc(ask.kind)} ask on this spoke)</button>
        <button class="perm-btn eg-block" data-spoke-ask="deny">Deny</button>
      </div>
    </div>
  </div>`);
  node.dataset.laneId = laneId; // a spoke switch removes a dock that belongs to another lane
  ($(".spoke-ask-title", node) as HTMLElement).textContent = `${name} wants to run a gated action`;
  ($(".spoke-ask-sum", node) as HTMLElement).textContent = ask.summary;
  ($(".spoke-ask-kind", node) as HTMLElement).textContent = ask.kind;
  node.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest("[data-spoke-ask]") as HTMLElement | null;
    if (!b) return;
    const v = b.dataset.spokeAsk;
    for (const btn of node.querySelectorAll("button")) (btn as HTMLButtonElement).disabled = true;
    answeredAsk = { key, at: Date.now() };
    if (askDock === node) { askDock = null; askKey = ""; }
    node.remove();
    void answer(laneId, v !== "deny", v === "session" ? "session" : "once");
  });
  (wrap.querySelector(".composer-row") ?? wrap.firstElementChild)?.before(node);
  askDock = node;
}

/** The full vitals popover: THIS spoke's security posture and memory figures, live while open. */
async function openVitals(): Promise<void> {
  if (!deps || !banner) return;
  if (vitalsPop) { vitalsPop.close(); vitalsPop = null; return; }
  menuPop?.close(); menuPop = null;
  await bannerRefresh();
  const anchor = $(".spoke-vitals", banner) as HTMLElement;
  const p = popover(anchor, `<div class="spoke-vit"></div>`, () => { vitalsPop = null; });
  vitalsPop = p;
  paintVitals(p.node);
  // popover() measured the EMPTY shell and capped max-height to it; the painted card is ~340px taller.
  // Without this the vitals opened as a 10px sliver, so its Allow/Deny could not be reached at all.
  p.reposition();
  p.node.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("[data-vit-answer]") as HTMLElement | null;
    // Fail closed: answer only the lane the banner names AND the composer drives right now.
    const l = bannerLane;
    const t = deps?.getTarget();
    if (!btn || !l || l.id !== bannerLaneId || !t || !isLaneTarget(t) || t.laneId !== l.id) return;
    const v = btn.dataset.vitAnswer;
    void answer(l.id, v !== "deny", v === "session" ? "session" : "once");
  });
}

function paintVitals(node: HTMLElement): void {
  const box = $(".spoke-vit", node) as HTMLElement | null;
  if (!box) return;
  const l = bannerLane;
  if (!l) { box.innerHTML = `<div class="spoke-vit-dim">The fleet has not reported this lane yet.</div>`; return; }
  const u = deps?.getLaneUsage() ?? null;
  const pct = u && u.size > 0 ? Math.min(100, Math.round((u.used / u.size) * 100)) : null;
  const fmtK = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  const allow = l.sessionAllow.length
    ? l.sessionAllow.map((k) => `<i class="spoke-vit-kind">${esc(k)}</i>`).join("")
    : `<span class="spoke-vit-dim">none</span>`;
  box.innerHTML = `
    <div class="spoke-vit-h"><b>${esc(l.name)}</b><span>${esc(l.model || "model not reported")}</span></div>
    <div class="spoke-vit-s"><h4>${icon("shield", 13)} Security \u00b7 this spoke</h4>
      <div class="spoke-vit-row"><span>approval mode</span><b>${l.autoApprove ? "full auto (risk accepted)" : "ask me each time"}</b></div>
      ${l.pendingApproval ? `<div class="spoke-vit-ask"><span>${esc(l.pendingApproval.summary)}</span>
        <span class="spoke-vit-btns"><button class="btn-mini orbit-allow" data-vit-answer="once">${icon("check", 12)} Allow once</button>
        <button class="btn-mini orbit-allow" data-vit-answer="session">${icon("check", 12)} Allow for session</button>
        <button class="btn-mini orbit-deny" data-vit-answer="deny">${icon("close", 12)} Deny</button></span></div>` : ""}
      <div class="spoke-vit-row"><span>allowed for session</span><b class="spoke-vit-kinds">${allow}</b></div>
      <div class="spoke-vit-row"><span>open tool calls</span><b>${l.openCalls}</b></div>
      ${l.lastHealth ? `<div class="spoke-vit-row"><span>harness ${esc(l.lastHealth.action)}</span><b>${esc(l.lastHealth.reason)} \u00b7 ${ageStr(l.lastHealth.at)}</b></div>` : ""}
    </div>
    <div class="spoke-vit-s"><h4>${icon("brain", 13)} Memory &amp; context \u00b7 this spoke</h4>
      <div class="spoke-vit-row"><span>context window</span><b>${pct == null ? "no sample yet" : `${pct}% \u00b7 ${fmtK(u!.used)} / ${fmtK(u!.size)}`}</b></div>
      <div class="spoke-vit-bar"><i style="width:${pct ?? 0}%" class="${pct != null && pct >= 90 ? "hot" : pct != null && pct >= 70 ? "warn" : ""}"></i></div>
      <div class="spoke-vit-row"><span>session spend</span><b>${u ? `$${u.cost.toFixed(2)}` : "no sample yet"}</b></div>
      <div class="spoke-vit-row"><span>turns \u00b7 respawns \u00b7 queued</span><b>${l.turns} \u00b7 ${l.respawns} \u00b7 ${l.queued.length}</b></div>
      ${l.sessionId ? `<div class="spoke-vit-row"><span>session</span><b class="spoke-vit-mono">${esc(l.sessionId.slice(0, 18))}\u2026</b></div>` : ""}
    </div>`;
}

/** The switch menu, fetched fresh on open so a lane spawned seconds ago is already listed. */
async function openSwitchMenu(): Promise<void> {
  if (!deps || !banner) return;
  if (menuPop) { menuPop.close(); menuPop = null; return; }
  const anchor = $(".spoke-menu-btn", banner) as HTMLElement;
  const s = await deps.fleetStatus();
  const target = deps.getTarget();
  const current = isLaneTarget(target) ? target.laneId : null;
  const rows = switchEntries(s?.lanes ?? [], current);
  const html = `<div class="spoke-switch">${rows.map(rowHtml).join("")}
    <div class="spoke-sw-div" aria-hidden="true"></div>
    <div class="spoke-sw-keys">Ctrl+Alt+\u2190/\u2192 cycle spokes \u00b7 Ctrl+Alt+\u2191 Main \u00b7 Ctrl+Alt+\u2193 orbit</div></div>`;
  const p = popover(anchor, html, () => { menuPop = null; });
  menuPop = p;
  p.node.addEventListener("click", (ev) => {
    const r = (ev.target as HTMLElement).closest("[data-sw]") as HTMLElement | null;
    if (!r || r.classList.contains("current")) return;
    const kind = r.dataset.sw!;
    p.close(); menuPop = null;
    if (kind === "master") deps!.demoteLane();
    else if (kind === "orbit") openFleetOrbit();
    else if (kind === "lane") deps!.promoteLane(r.dataset.laneId!);
  });
}

function rowHtml(e: SwitchEntry): string {
  if (e.kind === "master") {
    return `<button class="spoke-sw-row${e.current ? " current" : ""}" data-sw="master">${piMark}<span>${esc(e.label)}</span>${e.current ? `<i class="spoke-sw-here">you are here</i>` : ""}</button>`;
  }
  if (e.kind === "orbit") {
    return `<button class="spoke-sw-row" data-sw="orbit">${icon("share", 14)}<span>${esc(e.label)}</span></button><div class="spoke-sw-div" aria-hidden="true"></div>`;
  }
  return `<button class="spoke-sw-row lane-${e.status}${e.current ? " current" : ""}" data-sw="lane" data-lane-id="${esc(e.laneId)}"><i class="spoke-sw-dot"></i><span>${esc(e.label)}</span>${e.current ? `<i class="spoke-sw-here">you are here</i>` : `<i class="spoke-sw-st">${esc(e.status)}</i>`}</button>`;
}
