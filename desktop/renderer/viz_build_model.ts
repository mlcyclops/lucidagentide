// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_build_model.ts - P-WORLDS.BUILD1 (ADR-0653): the pure rules of world build sites. No three,
// no DOM: viz_build.ts draws the scaffolding, viz_view.ts feeds this book and applies the steps it returns.
//
// Events drive a node's build (the same tapped events viz_model takes, after it took them):
//   subagent        scaffold pieces appear, one per assignment (a build that was revealed starts over first)
//   tool done       the oldest unlocked piece locks in (Main settles a call with tool-meta ok, a lane with done)
//   tool failed     the newest unlocked piece flickers red
//   done or commit  the build reveals; an artifact chip shows over the node when the build has an artifact
// An artifact comes from a lane's output ONLY when the user started one of the world's mini-game templates on that
// node (armTemplate): the text of that run is kept (bounded) and its last fenced html block (or a whole
// <!doctype html> document) is the artifact. The ?vizDemo=1 feed arms a labeled demo sample instead (armSample).
// Nothing here trusts the artifact: viz_artifact_popup.ts sends it through the engine's security gate first.

import { COMMIT_CALL_RE } from "./viz_model.ts";
import type { WorldBuildSite, WorldDefinition, WorldMiniGame, WorldScaffoldStyle, WorldTier } from "./viz_world_api.ts";

/** Pieces a build holds at most (the scene's tier budget may draw fewer). */
export const BUILD_MAX_PIECES = 12;
/** The largest artifact taken from a run's output (the engine gate refuses more, too). */
export const ARTIFACT_MAX_CHARS = 256_000;
/** A template run's text is kept up to this many characters (the newest; the artifact block comes last). */
export const TEMPLATE_TEXT_MAX = 300_000;
/** Mini-game templates a world offers at most. */
export const MINI_GAMES_MAX = 3;
/** Settled call ids remembered per node, so a call settled by two events locks one piece, not two. */
const SETTLED_MAX = 64;

export interface BuildArtifact {
  /** Stable for the session: `${node}:${seq}`. */
  id: string;
  node: string;
  title: string;
  html: string;
  /** The ?vizDemo=1 sample (labeled as one everywhere it shows). */
  demo: boolean;
  at: number;
  /** The user chose Keep: a new build on the node leaves it in place until a newer artifact replaces it. */
  kept: boolean;
}

export interface BuildTemplate { id: string; label: string; startedAt: number; /** turns to let pass first (the prompt was staged behind a running turn) */ waitTurns: number }

export interface NodeBuild {
  pieces: number;
  locked: number;
  failed: number;
  revealed: boolean;
  /** Commit or push calls still open (their settle reveals the build). */
  commits: Set<string>;
  settled: Set<string>;
  template: BuildTemplate | null;
  text: string;
  sample: { title: string; html: string } | null;
  artifact: BuildArtifact | null;
}

export interface BuildBook { builds: Map<string, NodeBuild>; seq: number }

export type BuildStep =
  | { kind: "reset"; node: string }
  | { kind: "add"; node: string; count: number }
  | { kind: "lock"; node: string }
  | { kind: "fail"; node: string }
  | { kind: "reveal"; node: string; artifact: BuildArtifact | null };

export function createBuildBook(): BuildBook { return { builds: new Map(), seq: 0 }; }

function newBuild(): NodeBuild {
  return { pieces: 0, locked: 0, failed: 0, revealed: false, commits: new Set(), settled: new Set(), template: null, text: "", sample: null, artifact: null };
}

function buildOf(book: BuildBook, node: string): NodeBuild {
  let b = book.builds.get(node);
  if (!b) { b = newBuild(); book.builds.set(node, b); }
  return b;
}

/** A new build on the node: the scaffold empties; an artifact the user did not keep goes with it. */
function restart(b: NodeBuild, node: string, out: BuildStep[]): void {
  const had = b.pieces > 0 || b.revealed;
  b.pieces = 0; b.locked = 0; b.failed = 0; b.revealed = false;
  if (b.artifact && !b.artifact.kept) b.artifact = null;
  if (had) out.push({ kind: "reset", node });
}

type Loose = { type: string; status?: unknown; ok?: unknown; id?: unknown; assignments?: unknown; text?: unknown; input?: unknown; detail?: unknown; intent?: unknown };

function isCommit(e: Loose): boolean {
  for (const v of [e.input, e.detail, e.intent]) if (typeof v === "string" && COMMIT_CALL_RE.test(v)) return true;
  return false;
}

/** First settle of a call id on this node (an id-less settle always counts). */
function firstSettle(b: NodeBuild, id: unknown): boolean {
  if (typeof id !== "string" || !id) return true;
  if (b.settled.has(id)) return false;
  if (b.settled.size >= SETTLED_MAX) b.settled.clear();
  b.settled.add(id);
  return true;
}

/** Fold one event the model took on `node` into its build. Returns the steps the scene plays, in order. */
export function buildEvent(book: BuildBook, node: string, ev: { readonly type: string }, now: number): BuildStep[] {
  const e = ev as Loose;
  const out: BuildStep[] = [];
  switch (e.type) {
    case "subagent": {
      const b = buildOf(book, node);
      if (b.revealed) restart(b, node, out);
      const n = Math.max(1, Array.isArray(e.assignments) ? e.assignments.filter((a) => typeof a === "string").length : 0);
      const add = Math.min(n, BUILD_MAX_PIECES - b.pieces);
      if (add > 0) { b.pieces += add; out.push({ kind: "add", node, count: add }); }
      return out;
    }
    case "token": {
      const b = book.builds.get(node);
      if (!b?.template || typeof e.text !== "string") return out;
      b.text += e.text;
      if (b.text.length > TEMPLATE_TEXT_MAX) b.text = b.text.slice(b.text.length - TEMPLATE_TEXT_MAX);
      return out;
    }
    case "tool": {
      const b = buildOf(book, node);
      if (e.status === undefined || e.status === "open") {
        if (isCommit(e) && typeof e.id === "string" && e.id) b.commits.add(e.id);
        return out;
      }
      if (e.status === "done") settle(book, b, node, e.id, true, now, out);
      else if (e.status === "failed") settle(book, b, node, e.id, false, now, out);
      return out;
    }
    case "tool-meta": {
      if (e.ok !== true && e.ok !== false) return out;
      settle(book, buildOf(book, node), node, e.id, e.ok === true, now, out);
      return out;
    }
    case "done": {
      const b = book.builds.get(node);
      if (!b) return out;
      if (b.template && b.template.waitTurns > 0) { b.template.waitTurns--; b.text = ""; } // the turn the brief waited behind
      else reveal(book, b, node, now, out);
      return out;
    }
    case "error":
    case "no-response": {
      const b = book.builds.get(node);
      if (!b) return out;
      b.template = null; b.text = ""; // the run failed: no artifact from it
      if (!b.revealed && b.pieces > b.locked) { b.failed++; out.push({ kind: "fail", node }); }
      return out;
    }
    default:
      return out;
  }
}

function settle(book: BuildBook, b: NodeBuild, node: string, id: unknown, ok: boolean, now: number, out: BuildStep[]): void {
  if (!firstSettle(b, id)) return;
  const commit = typeof id === "string" && b.commits.delete(id);
  if (commit && ok) { reveal(book, b, node, now, out); return; }
  if (b.revealed || b.pieces <= b.locked) return;
  if (ok) { b.locked++; out.push({ kind: "lock", node }); }
  else { b.failed++; out.push({ kind: "fail", node }); }
}

/** The build stands revealed. A template run's artifact (or the demo's sample) comes with it. A node with nothing
 *  in progress reveals nothing. */
function reveal(book: BuildBook, b: NodeBuild, node: string, now: number, out: BuildStep[]): void {
  const pending = !!b.template || !!b.sample;
  if (b.revealed || (b.pieces === 0 && !pending)) return;
  if (b.pieces === 0) { b.pieces = 1; out.push({ kind: "add", node, count: 1 }); } // a run with no subagents still builds one piece
  let art: BuildArtifact | null = null;
  if (b.template) {
    const html = extractHtmlArtifact(b.text);
    if (html) art = { id: `${node}:${++book.seq}`, node, title: b.template.label, html, demo: false, at: now, kept: false };
    b.template = null; b.text = "";
  } else if (b.sample) {
    art = { id: `${node}:${++book.seq}`, node, title: b.sample.title, html: b.sample.html, demo: true, at: now, kept: false };
    b.sample = null;
  }
  b.revealed = true; b.locked = b.pieces;
  if (art) b.artifact = art;
  out.push({ kind: "reveal", node, artifact: art });
}

/** The user started a mini-game template on the node (an ordinary lane task). `staged`: the prompt waits behind a
 *  running turn, so that turn's end is not this run's. Starts a new build. */
export function armTemplate(book: BuildBook, node: string, game: { id: string; label: string }, staged: boolean, now: number): BuildStep[] {
  const b = buildOf(book, node);
  const out: BuildStep[] = [];
  restart(b, node, out);
  b.template = { id: game.id, label: game.label, startedAt: now, waitTurns: staged ? 1 : 0 };
  b.text = ""; b.sample = null;
  return out;
}

/** DEMO only (viz_view calls it for ?vizDemo=1 feeds, never for a real event): the next reveal on the node carries
 *  this labeled sample. */
export function armSample(book: BuildBook, node: string, sample: { title: string; html: string }): void {
  buildOf(book, node).sample = { title: sample.title, html: sample.html };
}

/** The node's current artifact (the chip over it), or null. */
export function artifactOf(book: BuildBook, node: string): BuildArtifact | null { return book.builds.get(node)?.artifact ?? null; }

/** Keep: the artifact stays on the node through later builds until a newer one replaces it. */
export function keepArtifact(book: BuildBook, id: string): BuildArtifact | null {
  for (const b of book.builds.values()) if (b.artifact?.id === id) { b.artifact.kept = true; return b.artifact; }
  return null;
}

/** Discard: the artifact goes and the node's build empties. */
export function discardArtifact(book: BuildBook, id: string): BuildStep[] {
  for (const [node, b] of book.builds) {
    if (b.artifact?.id !== id) continue;
    b.artifact = null;
    const out: BuildStep[] = [];
    restart(b, node, out);
    return out;
  }
  return [];
}

/** A node left the scene: its build goes with it. */
export function dropBuild(book: BuildBook, node: string): void { book.builds.delete(node); }

/** The last fenced ```html block in `text`, else the last whole <!doctype html> or <html> document; null when there
 *  is none, it is empty, or it is over ARTIFACT_MAX_CHARS. */
export function extractHtmlArtifact(text: string): string | null {
  let found: string | null = null;
  for (const m of text.matchAll(/```html[^\n]*\n([\s\S]*?)```/gi)) found = m[1] ?? null;
  if (found === null) {
    for (const m of text.matchAll(/<!doctype html[\s\S]*?<\/html\s*>/gi)) found = m[0];
    if (found === null) for (const m of text.matchAll(/<html[\s>][\s\S]*?<\/html\s*>/gi)) found = m[0];
  }
  if (found === null) return null;
  const html = found.trim();
  if (!html || html.length > ARTIFACT_MAX_CHARS || !/<(html|body|script|canvas|div|button|svg)\b/i.test(html)) return null;
  return html;
}

// ------------------------------------------------------------------------------------------ sites + templates

export interface BuildSite { anchor: readonly [number, number, number]; style: WorldScaffoldStyle; color: string; label: string }

/** The host's default site: a holo build ring beside the stage, on its floor. */
export const DEFAULT_SITE_ANCHOR: readonly [number, number, number] = [0.95, -0.5, 0];
const STYLES: readonly WorldScaffoldStyle[] = ["wireframe", "holo", "panels"];
const HEX = /^#[0-9a-fA-F]{6}$/;

/** The site a node of `role` builds at: the world's first matching declared site (malformed fields fall back to the
 *  defaults), else the default ring. `fallbackColor` is the style's accent (a world's edge colorA). */
export function buildSiteFor(def: WorldDefinition | null, role: "hub" | "agent", fallbackColor: string): BuildSite {
  const sites = Array.isArray(def?.buildSites) ? (def!.buildSites as readonly unknown[]) : [];
  for (const raw of sites) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as WorldBuildSite;
    const roles = Array.isArray(s.roles) ? s.roles : null;
    if (roles && !roles.includes(role)) continue;
    const a = Array.isArray(s.anchor) && s.anchor.length === 3 && s.anchor.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 3)
      ? ([s.anchor[0], s.anchor[1], s.anchor[2]] as const) : DEFAULT_SITE_ANCHOR;
    return {
      anchor: a,
      style: STYLES.includes(s.style as WorldScaffoldStyle) ? (s.style as WorldScaffoldStyle) : "holo",
      color: typeof s.color === "string" && HEX.test(s.color) ? s.color : fallbackColor,
      label: typeof s.label === "string" && s.label.trim() ? s.label.trim().slice(0, 40) : "Build site",
    };
  }
  return { anchor: DEFAULT_SITE_ANCHOR, style: "holo", color: fallbackColor, label: "Build ring" };
}

const NO_NET = "Put everything in ONE self-contained HTML file: inline all CSS and JavaScript, no network requests, no external assets, "
  + "no fonts or images from anywhere else, no storage. Keep it under 20 KB. You may split the work across subagents. "
  + "End your reply with the complete file in a single ```html fenced block.";

/** The host's templates for a world that declares none (and the two built-in styles). */
export const DEFAULT_MINI_GAMES: readonly WorldMiniGame[] = [
  { id: "target-tap", label: "Target tap game", brief: `Build a small target-tap mini game: targets pop up at random spots, the player taps them before they fade, a 30 second round, a score and a restart button. ${NO_NET}` },
  { id: "memory-cards", label: "Memory cards game", brief: `Build a small memory cards mini game: a 4 by 4 grid of face-down cards, flip two at a time to find pairs, count the moves, and offer a restart. ${NO_NET}` },
];

/** The world's valid templates (id, label and brief checked, at most three), else the host's defaults. */
export function miniGamesFor(def: WorldDefinition | null): readonly WorldMiniGame[] {
  const raw = Array.isArray(def?.miniGames) ? (def!.miniGames as readonly unknown[]) : [];
  const out: WorldMiniGame[] = [];
  const ids = new Set<string>();
  for (const g of raw) {
    if (out.length >= MINI_GAMES_MAX) break;
    if (!g || typeof g !== "object") continue;
    const { id, label, brief } = g as Partial<WorldMiniGame>;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(id) || ids.has(id)) continue;
    if (typeof label !== "string" || !label.trim() || typeof brief !== "string" || !brief.trim() || brief.length > 4000) continue;
    ids.add(id);
    out.push({ id, label: label.trim().slice(0, 40), brief: brief.trim() });
  }
  return out.length ? out : DEFAULT_MINI_GAMES;
}

// ------------------------------------------------------------------------------------------ the artifact popup

/** The sandbox the popup's iframe gets (and the engine's frame gives its srcdoc child): scripts only. Never
 *  allow-same-origin: the artifact is agent-built. */
export const ARTIFACT_SANDBOX = "allow-scripts";

/** The gate's answer as the popup reads it. Anything else (no answer, an error, a malformed reply) is a block. */
export type ArtifactGateVerdict = { state: "pass"; frameId: string } | { state: "blocked"; reason: string };
/** What the popup shows: waiting for the gate, or its answer. */
export type ArtifactVerdict = { state: "pending" } | ArtifactGateVerdict;

/** The engine's /api/viz/artifact `data` to a verdict, fail-closed: only an explicit pass with a well-formed id
 *  passes. */
export function readVerdict(data: unknown): ArtifactGateVerdict {
  if (!data || typeof data !== "object") return { state: "blocked", reason: "fail-closed: the security gate did not answer" };
  const d = data as { ok?: unknown; id?: unknown; reason?: unknown };
  if (d.ok === true && typeof d.id === "string" && /^[0-9a-f-]{16,64}$/i.test(d.id)) return { state: "pass", frameId: d.id };
  if (d.ok === false) return { state: "blocked", reason: typeof d.reason === "string" && d.reason ? d.reason : "the security gate blocked it" };
  return { state: "blocked", reason: "fail-closed: the security gate gave no valid verdict" };
}

/** The iframe's attributes for a passed artifact. The token rides the query (an iframe GET cannot send a header);
 *  no referrer, no permissions. */
export function frameAttrs(frameId: string, token: string): Record<string, string> {
  return {
    sandbox: ARTIFACT_SANDBOX,
    src: `/api/viz/artifact/frame?id=${encodeURIComponent(frameId)}${token ? `&t=${encodeURIComponent(token)}` : ""}`,
    referrerpolicy: "no-referrer",
    allow: "",
    title: "Untrusted artifact",
  };
}

// ------------------------------------------------------------------------------------------ budgets

/** What a scaffold draws at a tier: pieces, holo beams, floating panels, progress ring segments, flash pool. */
export interface ScaffoldBudget { pieces: number; beams: number; panels: number; ringSegments: number; flashes: number }

/** Per-tier budgets. Unknown tiers read as "full" (a v1 world or an older host never passes the newer ones). */
export function scaffoldBudget(tier: WorldTier | string): ScaffoldBudget {
  switch (tier) {
    case "minimal": return { pieces: 4, beams: 0, panels: 0, ringSegments: 24, flashes: 1 };
    case "reduced": return { pieces: 6, beams: 2, panels: 2, ringSegments: 40, flashes: 1 };
    case "ultra": return { pieces: BUILD_MAX_PIECES, beams: 6, panels: 4, ringSegments: 96, flashes: 3 };
    case "cinematic": return { pieces: BUILD_MAX_PIECES, beams: 8, panels: 4, ringSegments: 128, flashes: 3 };
    default: return { pieces: 8, beams: 4, panels: 3, ringSegments: 64, flashes: 2 };
  }
}
