// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/agent_spinup.ts - P-SPINUP.1 (ADR-0668): spin-up walkers.
//
// While an agent is starting, the user gets more than a status note: a mini standing Lucid (agents_rail_art.
// lucidWalkerArt, in that folder's Agents palette) walks back and forth along the top edge of the composer that is
// waiting on it (the main composer, a Fleet lane card's composer) or paces over its node in Agent Worlds. A glass
// speech bubble travels above him, cycling playful status lines ("Ada is getting dressed, hang on") with a small
// elapsed timer, and turns honest after 30 s and 90 s. When the agent is ready the bubble says so, he hops once,
// and both fade out; a surface that disappears takes its walker with it at once. The surface's floating buddy
// (agent_buddy.ts) hides while its walker is up: the walker IS that agent arriving (same keys, see buddy layout).
//
// Nothing here takes the pointer. Reduced motion and perf tier "minimal" stand him still; the bubble still cycles.
// The pure parts (lines, cycling, track math) are exported for unit tests; mountSpinupWalkers owns the DOM.
// Names are always written as text, never markup.

import { AGENTS_KEY, baseName, defaultTheme, displayNames, laneFolderIds, loadDoc, type AgentsDoc } from "./agents_store.ts";
import { lucidWalkerArt, paletteOf, themePalette, type AgentPalette } from "./agents_rail_art.ts";
import { baseTier, type PerfTier } from "./perf_tier.ts";

/** One status line this long, then the next (with a quick crossfade). */
export const CYCLE_MS = 2600;
/** After this long the cycle interleaves "taking longer than usual". */
export const SLOW_MS = 30_000;
/** After this long the honest line says the machine looks busy. */
export const STUCK_MS = 90_000;
/** A very fast start still shows the walker this long before the ready line. */
export const MIN_SHOW_MS = 1200;
/** The ready line (and the hop) stays this long, then the walker fades. */
export const READY_MS = 1400;
/** The fade-out (CSS .spw-out transition). */
export const FADE_MS = 360;
/** Walking speed, px per second. */
export const WALK_SPEED = 32;
/** One there-and-back walk never runs faster than this many seconds. */
export const MIN_DUR_S = 3;
/** Names longer than this are clamped with an ellipsis. */
export const NAME_MAX = 28;
/** The bubble's widest (px); narrower composers get a narrower bubble (bubbleWidthFor). */
// Wide enough for a whole line ("<name> is checking in with the security gate") plus the timer: a line cut to an
// ellipsis says nothing, which is the one thing this bubble must not do.
export const BUBBLE_MAX = 400;
const BUBBLE_MIN = 160;
/** In Agent Worlds the bubble rides over a small node: a fixed max width. */
const WORLD_BUBBLE = 320;
/** Px kept clear between the bubble (or walker) and the track's ends. */
const EDGE = 6;
/** Walker height (CSS px): over a composer, in Agent Worlds. Width follows the art's 40 x 48 box. At 30 px the
 *  figure read as a blob; 44 px shows the headband, face and stride. */
const COMPOSER_H = 44;
const WORLD_H = 36;
/** The art's feet are this fraction of its height down (the floor shadow sits just below). */
const FEET = 44 / 48;
const SWAP_MS = 180;
const TICK_ON_MS = 500;
const TICK_OFF_MS = 2000;
const TICK_WORLDS_MS = 1000;

// ── pure helpers ───────────────────────────────────────────────────────────────────────────────────────────

/** A name fit for one bubble line: trimmed, never empty, at most NAME_MAX characters (ellipsized). */
export function clampName(name: string): string {
  const n = (name ?? "").replace(/\s+/g, " ").trim() || "Agent";
  return n.length > NAME_MAX ? `${n.slice(0, NAME_MAX - 1).trimEnd()}\u2026` : n;
}

const PLAYFUL: readonly ((n: string) => string)[] = [
  (n) => `${n} is getting dressed, hang on`,
  (n) => `${n} is tying the headband`,
  (n) => `${n} is stretching before the first task`,
  (n) => `${n} is reading the folder map`,
  (n) => `${n} is warming up the keyboard`,
  (n) => `${n} is packing the tool belt`,
  (n) => `${n} is finding a good desk`,
  (n) => `${n} is waking up the model`,
  (n) => `${n} is checking in with the security gate`,
  (n) => `${n} is grabbing a coffee, back in a sec`,
  (n) => `${n} is lacing up`,
  (n) => `Almost there, ${n} is on the way`,
];

/** FNV-1a: a stable 32-bit seed from a name. */
function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** mulberry32: a small seeded generator, so a name always shuffles the same way. */
function rng(seed: number): () => number {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The status lines for `name`: first always "<name> is getting ready for some work", then the playful lines in an
 *  order shuffled by the name (the same every time for one name), then the two honest lines pickLine interleaves:
 *  "taking longer than usual" (after SLOW_MS) and "the machine looks busy" (after STUCK_MS), always last. */
export function spinupLines(name: string): string[] {
  const n = clampName(name);
  const lines = PLAYFUL.map((f) => f(n));
  const r = rng(seedOf(n));
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [lines[i], lines[j]] = [lines[j]!, lines[i]!];
  }
  return [`${n} is getting ready for some work`, ...lines, `${n} is taking longer than usual, still on it`, `${n} is still starting: the machine looks busy`];
}

/** The line to show in cycle slot `i` (elapsed / CYCLE_MS) after `elapsedMs` of waiting: slot 0 is the first line,
 *  then the playful ones in turn; once SLOW_MS has passed every third slot is the honest line instead (the
 *  "machine looks busy" one after STUCK_MS). */
export function pickLine(lines: readonly string[], i: number, elapsedMs: number): string {
  if (lines.length < 4 || i <= 0) return lines[0] ?? "";
  if (i % 3 === 0 && elapsedMs >= STUCK_MS) return lines[lines.length - 1]!;
  if (i % 3 === 0 && elapsedMs >= SLOW_MS) return lines[lines.length - 2]!;
  const playful = lines.length - 3;
  return lines[1 + ((i - 1) % playful)]!;
}

export const readyLine = (name: string): string => `${clampName(name)} is ready`;

/** "0:07", "1:32", "12:05". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The bubble's max width over a composer `trackWidth` px wide: 60% of it, between 140 and BUBBLE_MAX. */
export function bubbleWidthFor(trackWidth: number): number {
  const w = Number.isFinite(trackWidth) ? trackWidth : 0;
  return Math.min(BUBBLE_MAX, Math.max(BUBBLE_MIN, Math.round(w * 0.7)));
}

/** The walk along a track `trackWidth` px wide: the walker's center stays `inset` px from either end (half the
 *  wider of the bubble and the walker, plus a small margin, so the bubble riding above him never leaves the track),
 *  `run` px of travel each way (never negative), and `dur` seconds for one there-and-back cycle at `speed` px/s
 *  (never under MIN_DUR_S, so a short track never makes him sprint). */
export function walkTrack(trackWidth: number, bubbleWidth: number, walkerWidth: number, speed = WALK_SPEED): { inset: number; run: number; dur: number } {
  const fin = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);
  const inset = Math.max(fin(bubbleWidth), fin(walkerWidth)) / 2 + EDGE;
  const run = Math.max(0, Math.round(fin(trackWidth) - 2 * inset));
  const v = Number.isFinite(speed) && speed > 0 ? speed : WALK_SPEED;
  const dur = Math.max(MIN_DUR_S, Math.round(((2 * run) / v) * 100) / 100);
  return { inset, run, dur };
}

/** A negative animation delay per walker, so two walkers never stride in step. */
function strideDelay(key: string): number {
  return -((seedOf(key) % 600) / 1000);
}

// ── the mounted walkers ────────────────────────────────────────────────────────────────────────────────────

interface KV { getItem(k: string): string | null }

export interface WorldSpinupSource {
  /** The lane node ids still starting, in this view's model. */
  ids(): string[];
  /** The node's frame on screen (client px), or null while it is off screen. */
  boxOf(id: string): { x: number; y: number; r: number } | null;
  /** The lane's name. */
  nameOf(id: string): string;
  /** The node's working folder (its lane cwd), or null when unknown. */
  folderOf(id: string): string | null;
}

export interface SpinupWalkersDeps {
  /** The main column (`main.center`): the main walker's canvas. */
  mainCanvas(): HTMLElement | null;
  /** `.composer-wrap`: the main walker walks along its top edge. */
  mainAnchor(): HTMLElement | null;
  /** `#fleetGrid`, when the Fleet panel has been built. */
  fleetGrid(): HTMLElement | null;
  /** Main is spinning up (booting, a takeover, a session restore, a model restart): who is arriving, or null. */
  mainSpinup(): { name: string; folder: string | null } | null;
  perfTier(): PerfTier;
  storage?: KV;
}

export interface SpinupWalkers {
  /** Re-read Main's spin-up, the lane cards and the Agents palettes now. */
  sync(): void;
  /** Agent Worlds: a walker over each starting lane node, following it every animation frame. Returns the detach. */
  attachWorlds(stage: HTMLElement, src: WorldSpinupSource): () => void;
}

type Where = "main" | "lane" | "world";

interface Walker {
  /** "main" | "lane:<laneId>" | "world:<nodeId>" (the buddy keys). */
  key: string;
  where: Where;
  canvas: HTMLElement;
  anchor: HTMLElement | null;
  host: HTMLElement;
  text: HTMLElement;
  time: HTMLElement;
  name: string;
  folder: string | null;
  pal: string;
  lines: string[];
  lineIdx: number;
  startedAt: number;
  phase: "start" | "ready";
  /** Px; the last values written, so an unchanged layout writes nothing. */
  x: number; y: number; run: number; dur: number; bw: number;
  swapTimer: number;
  endTimer: number;
  ro: ResizeObserver | null;
}

interface Want { name: string; folder: string | null; canvas: HTMLElement; anchor: HTMLElement | null }

interface Attachment { stage: HTMLElement; src: WorldSpinupSource; raf: number; live: boolean }

function safeStorage(): KV {
  return { getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } } };
}

function applyPalette(el: HTMLElement, p: AgentPalette): void {
  for (const k of ["K", "D", "L", "G", "g"] as const) el.style.setProperty(`--${k}`, p[k]);
}

const shown = (el: HTMLElement | null): el is HTMLElement => !!el && el.isConnected && el.getClientRects().length > 0;
/** CSS px per client px of `el` (an ancestor's CSS zoom scales client rects, not style lengths). */
const scaleOf = (el: HTMLElement, r: DOMRect): number => (el.offsetWidth > 0 && r.width > 0 ? r.width / el.offsetWidth : 1);
/** A mutation that adds or removes a lane card (a streaming transcript's text never does). */
const touchesCards = (nodes: NodeList): boolean => [...nodes].some((n) => n instanceof Element && (n.matches(".fleet-card, .fleet-card-main") || !!n.querySelector(".fleet-card")));

const CHECK = '<svg class="spw-check" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.4 6.4l2.4 2.3 4.8-5.2"/></svg>';

export function mountSpinupWalkers(d: SpinupWalkersDeps): SpinupWalkers {
  const kv = d.storage ?? safeStorage();
  let docRaw: string | null | undefined;
  let doc: AgentsDoc = loadDoc(null);
  let names = new Map<string, string>();
  const walkers = new Map<string, Walker>();
  const worlds = new Set<Attachment>();
  let gridRoot: HTMLElement | null = null;
  let gridObs: MutationObserver | null = null;
  let gridQueued = false;

  const calm = (): boolean => baseTier(d.perfTier()) === "minimal";

  // ── Agents records: palette ──
  function reloadDoc(): void {
    const raw = kv.getItem(AGENTS_KEY);
    if (raw === docRaw) return;
    docRaw = raw;
    doc = loadDoc(raw);
    names = displayNames(doc.agents);
  }
  /** The folder's Agents palette (its own record, else its main checkout's), the Lucid theme with no folder. */
  function paletteFor(folder: string | null): AgentPalette {
    if (!folder) return themePalette("lucid");
    const ids = laneFolderIds(folder);
    for (const id of ids) { const rec = doc.agents.find((a) => a.id === id); if (rec) return paletteOf(rec); }
    return paletteOf({ theme: defaultTheme(ids[ids.length - 1]!), hue: 145 });
  }
  /** A lane card's name: its own attribute, else the header, else its Agents name or folder. */
  function cardName(card: HTMLElement): string {
    const n = card.dataset.laneName?.trim() || card.querySelector("[data-fleet-name]")?.textContent?.trim();
    if (n) return n;
    const cwd = card.dataset.laneCwd;
    if (!cwd) return "Agent";
    for (const id of laneFolderIds(cwd)) { const nm = names.get(id); if (nm) return nm; }
    return baseName(cwd);
  }

  // ── walker elements ──
  function make(key: string, where: Where, w: Want, startedAt: number): Walker {
    const host = document.createElement("div");
    host.className = "spw-host";
    host.dataset.spwSurface = where;
    host.dataset.spwKey = key;
    host.dataset.spwPhase = "start";
    host.style.setProperty("--spw-h", `${where === "world" ? WORLD_H : COMPOSER_H}px`);
    host.innerHTML = '<div class="spw-walk"><div class="spw-bubble">' + CHECK
      + '<span class="spw-text" role="status" aria-live="polite"></span><span class="spw-time" aria-hidden="true"></span></div>'
      + `<div class="spw-face"><div class="spw">${lucidWalkerArt(strideDelay(key))}</div></div></div>`;
    const walker: Walker = {
      key, where, canvas: w.canvas, anchor: w.anchor, host,
      text: host.querySelector(".spw-text") as HTMLElement, time: host.querySelector(".spw-time") as HTMLElement,
      name: "", folder: w.folder, pal: "", lines: [], lineIdx: -1, startedAt, phase: "start",
      x: NaN, y: NaN, run: -1, dur: -1, bw: -1, swapTimer: 0, endTimer: 0, ro: null,
    };
    if (where !== "world" && typeof ResizeObserver !== "undefined") {
      walker.ro = new ResizeObserver(() => { if (walkers.get(key) === walker) layoutAnchored(walker); });
      walker.ro.observe(w.canvas);
      if (w.anchor) walker.ro.observe(w.anchor);
    }
    w.canvas.classList.add("spw-canvas");
    w.canvas.append(host);
    walkers.set(key, walker);
    paint(walker, w, Date.now());
    return walker;
  }
  function drop(key: string): void {
    const w = walkers.get(key);
    if (!w) return;
    clearTimeout(w.swapTimer);
    clearTimeout(w.endTimer);
    w.ro?.disconnect();
    w.host.remove();
    walkers.delete(key);
  }
  /** Name, palette, calm, the status line and the timer. */
  function paint(w: Walker, want: Want | null, now: number): void {
    if (want) {
      if (want.name !== w.name) { w.name = want.name; w.lines = spinupLines(want.name); w.lineIdx = -1; }
      w.folder = want.folder;
      w.anchor = want.anchor;
    }
    const p = paletteFor(w.folder);
    if (p.G !== w.pal) { w.pal = p.G; applyPalette(w.host, p); }
    const c = calm();
    w.host.classList.toggle("spw-calm", c);
    w.host.classList.toggle("agr-calm", c);
    if (w.phase !== "start") return;
    const el = now - w.startedAt;
    const t = fmtElapsed(el);
    if (w.time.textContent !== t) w.time.textContent = t;
    const idx = Math.floor(el / CYCLE_MS);
    if (idx === w.lineIdx) return;
    const fade = w.lineIdx >= 0;
    w.lineIdx = idx;
    setLine(w, pickLine(w.lines, idx, el), fade);
  }
  function setLine(w: Walker, line: string, fade: boolean): void {
    clearTimeout(w.swapTimer);
    if (!fade) { w.text.textContent = line; w.text.classList.remove("spw-swap"); return; }
    // Screen readers hear the first line and the ready line, not a new playful line every few seconds.
    w.text.setAttribute("aria-live", "off");
    w.text.classList.add("spw-swap");
    w.swapTimer = window.setTimeout(() => { w.text.textContent = line; w.text.classList.remove("spw-swap"); }, SWAP_MS);
  }

  /** The surface wants a walker: make it, refresh it, or bring a fading one back (the agent is starting again). */
  function want(key: string, where: Where, w: Want): Walker {
    let cur = walkers.get(key);
    let startedAt = Date.now();
    if (cur && cur.canvas !== w.canvas) { startedAt = cur.startedAt; drop(key); cur = undefined; }
    if (!cur) return make(key, where, w, startedAt);
    // Worlds asks every frame: an unchanged walker only takes the anchor (the tick repaints the line and timer).
    if (cur.phase === "start" && cur.name === w.name && cur.folder === w.folder) { cur.anchor = w.anchor; return cur; }
    if (cur.phase !== "start") {
      clearTimeout(cur.endTimer);
      cur.endTimer = 0;
      cur.phase = "start";
      cur.host.dataset.spwPhase = "start";
      cur.host.classList.remove("spw-out");
      cur.lineIdx = -1;
    }
    paint(cur, w, Date.now());
    return cur;
  }
  /** The surface is no longer spinning up. `ok`: it is ready (the ready line and a hop), else it failed or stopped
   *  (a quiet fade). A walker younger than MIN_SHOW_MS stays until then (the next tick asks again). */
  function finish(key: string, ok: boolean): void {
    const w = walkers.get(key);
    if (!w || w.phase !== "start") return;
    if (!w.canvas.isConnected) { drop(key); return; }
    if (ok && Date.now() - w.startedAt < MIN_SHOW_MS) return;
    w.phase = "ready";
    w.host.dataset.spwPhase = "ready";
    clearTimeout(w.swapTimer);
    const fadeOut = (): void => {
      w.host.classList.add("spw-out");
      w.endTimer = window.setTimeout(() => { if (walkers.get(key) === w) drop(key); }, FADE_MS);
    };
    if (!ok) { fadeOut(); return; }
    w.text.classList.remove("spw-swap");
    w.text.setAttribute("aria-live", "polite");
    w.text.textContent = readyLine(w.name);
    w.endTimer = window.setTimeout(fadeOut, READY_MS);
  }

  // ── layout ──
  function place(w: Walker, x: number, y: number, run: number, dur: number, bw: number): void {
    const rx = Math.round(x), ry = Math.round(y);
    if (rx !== w.x || ry !== w.y) { w.x = rx; w.y = ry; w.host.style.setProperty("translate", `${rx}px ${ry}px`); }
    if (run !== w.run) { w.run = run; w.host.style.setProperty("--spw-run", `${run}px`); w.host.classList.toggle("spw-still", run <= 0); }
    if (dur !== w.dur) { w.dur = dur; w.host.style.setProperty("--spw-dur", `${dur}s`); }
    if (bw !== w.bw) { w.bw = bw; w.host.style.setProperty("--spw-bw", `${bw}px`); }
  }
  const sizeOf = (where: Where): { w: number; h: number } => {
    const h = where === "world" ? WORLD_H : COMPOSER_H;
    return { w: (h * 40) / 48, h };
  };
  /** Main and lane walkers: along the composer's top edge, feet on its border. */
  function layoutAnchored(w: Walker): void {
    if (!shown(w.canvas)) { w.host.hidden = true; return; }
    w.host.hidden = false;
    const c = w.canvas.getBoundingClientRect();
    const s = scaleOf(w.canvas, c);
    const a = shown(w.anchor) ? w.anchor.getBoundingClientRect() : null;
    const left = a ? (a.left - c.left) / s : 8;
    const width = a ? a.width / s : c.width / s - 16;
    const top = a ? (a.top - c.top) / s : c.height / s - 80;
    const size = sizeOf(w.where);
    const bw = bubbleWidthFor(width);
    const t = walkTrack(width, bw, size.w);
    place(w, left + t.inset - size.w / 2, top - size.h * FEET, t.run, t.dur, bw);
  }
  /** World walkers: pacing over the node's box (box.x +- r), standing on its top (box.y - r). */
  function layoutWorld(w: Walker, att: Attachment, id: string, s: DOMRect): void {
    const box = att.src.boxOf(id);
    // A node off the stage (panned or orbited away) hides its walker, never piled on the stage's edge.
    if (!box || box.x < s.left || box.x > s.right || box.y < s.top || box.y > s.bottom) { w.host.hidden = true; return; }
    w.host.hidden = false;
    const k = scaleOf(att.stage, s);
    const size = sizeOf("world");
    const width = (2 * box.r) / k;
    const t = walkTrack(width, 0, size.w);
    // Steps of 4 px: a zoom never restarts the stride every frame.
    const q = walkTrack(Math.floor(t.run / 4) * 4 + 2 * t.inset, 0, size.w);
    // A node near the stage's edge: narrow the pace so the bubble (centered on him) stays on the stage.
    const stageW = s.width / k;
    const bw = Math.max(BUBBLE_MIN, Math.min(WORLD_BUBBLE, stageW - 2 * EDGE));
    const lo = bw / 2 + EDGE - size.w / 2, hi = stageW - bw / 2 - EDGE - size.w / 2;
    let x = (box.x - box.r - s.left) / k + t.inset - size.w / 2;
    let end = x + q.run;
    x = Math.min(Math.max(x, lo), hi);
    end = Math.max(x, Math.min(end, hi));
    const run = Math.floor((end - x) / 4) * 4;
    const dur = q.run > 0 ? Math.max(MIN_DUR_S, (q.dur * run) / q.run) : q.dur;
    place(w, x, (box.y - box.r - s.top) / k - size.h * FEET, run, dur, bw);
  }
  window.addEventListener("resize", () => { for (const w of walkers.values()) if (w.where !== "world") layoutAnchored(w); });

  // ── surfaces ──
  function syncMain(): void {
    const m = d.mainSpinup();
    const canvas = d.mainCanvas();
    if (!canvas) { drop("main"); return; }
    if (!m) { finish("main", true); return; }
    layoutAnchored(want("main", "main", { name: m.name, folder: m.folder, canvas, anchor: d.mainAnchor() }));
  }
  function watchGrid(): void {
    const root = d.fleetGrid();
    if (root === gridRoot) return;
    gridObs?.disconnect();
    gridRoot = root;
    gridObs = null;
    if (!root) return;
    // A card's status flips, cards come and go: one scan per frame, however many such mutations.
    gridObs = new MutationObserver((recs) => {
      if (gridQueued || !recs.some((r) => r.type === "attributes" || touchesCards(r.addedNodes) || touchesCards(r.removedNodes))) return;
      gridQueued = true;
      requestAnimationFrame(() => { gridQueued = false; syncLanes(); schedule(); });
    });
    gridObs.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-status"] });
  }
  function syncLanes(): void {
    const status = new Map<string, string>();
    const root = gridRoot;
    if (root) {
      for (const card of root.querySelectorAll<HTMLElement>(".fleet-card[data-lane]")) {
        const laneId = card.dataset.lane ?? "";
        const key = `lane:${laneId}`;
        status.set(key, card.dataset.status ?? "");
        if (card.dataset.status !== "starting") continue;
        const canvas = card.querySelector<HTMLElement>(".fleet-card-main");
        if (!laneId || !canvas) continue;
        const w = want(key, "lane", { name: cardName(card), folder: card.dataset.laneCwd || null, canvas, anchor: card.querySelector<HTMLElement>(".fleet-compose") });
        layoutAnchored(w);
      }
    }
    for (const [key, w] of walkers) {
      if (w.where !== "lane" || status.get(key) === "starting") continue;
      const st = status.get(key);
      if (st === undefined) drop(key); // the card is gone
      else finish(key, st !== "error" && st !== "stopped");
    }
  }

  // ── Agent Worlds ──
  function frameWorld(att: Attachment): void {
    att.raf = 0;
    if (!att.live || document.hidden || !shown(att.stage)) return; // resumed by the tick
    const s = att.stage.getBoundingClientRect();
    const starting = new Set<string>();
    for (const id of att.src.ids()) {
      const key = `world:${id}`;
      starting.add(key);
      layoutWorld(want(key, "world", { name: att.src.nameOf(id), folder: att.src.folderOf(id), canvas: att.stage, anchor: null }), att, id, s);
    }
    let any = false;
    for (const [key, w] of walkers) {
      if (w.where !== "world" || w.canvas !== att.stage) continue;
      any = true;
      if (starting.has(key)) continue;
      finish(key, true);
      if (walkers.get(key) === w) layoutWorld(w, att, key.slice("world:".length), s); // the ready line follows its node
    }
    if (any) att.raf = requestAnimationFrame(() => frameWorld(att));
  }
  const runWorld = (att: Attachment): void => { if (att.live && !att.raf) att.raf = requestAnimationFrame(() => frameWorld(att)); };

  function attachWorlds(stage: HTMLElement, src: WorldSpinupSource): () => void {
    const att: Attachment = { stage, src, raf: 0, live: true };
    worlds.add(att);
    runWorld(att);
    schedule();
    return () => {
      if (!att.live) return;
      att.live = false;
      if (att.raf) cancelAnimationFrame(att.raf);
      att.raf = 0;
      worlds.delete(att);
      for (const [key, w] of walkers) if (w.where === "world" && w.canvas === stage) drop(key);
    };
  }

  // ── clock ──
  function syncAll(): void {
    reloadDoc();
    watchGrid();
    syncMain();
    syncLanes();
    const now = Date.now();
    for (const w of walkers.values()) paint(w, null, now);
    for (const att of worlds) runWorld(att);
  }
  let timer = 0;
  function schedule(): void {
    clearTimeout(timer);
    const ms = document.hidden ? TICK_OFF_MS : walkers.size ? TICK_ON_MS : worlds.size ? TICK_WORLDS_MS : TICK_OFF_MS;
    timer = window.setTimeout(tick, ms);
  }
  function tick(): void {
    timer = 0;
    try { syncAll(); } finally { schedule(); }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  tick();

  return {
    sync(): void { tick(); },
    attachWorlds,
  };
}
