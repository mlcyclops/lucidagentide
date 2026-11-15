// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/lucid_recs.ts - P-ASKLUCID.5 (ADR-0586): what Lucid suggests asking, and how he gets better at it.
//
// The four fixed questions an empty Ask Lucid showed had nothing to do with what the user was doing. This
// module builds the suggestions from what is going on: what is on the screen, which lanes are waiting or
// failed, where the orbit goal stands, the session in the main chat, and the knowledge graph.
//
// A MISS IS MEASURED. If the user looks at a set and uses none of it, or presses "Something else", the set
// failed: the kinds in it lose weight, the same suggestions are not shown again, and Lucid starts FOLLOWING
// THE SCREEN MORE CLOSELY: a suggestion for every surface that is open instead of only the top one, and for
// the surface the user keeps returning to. Using a suggestion gives its kind weight back and ends the close
// follow. Typing a question of one's own is not a miss: the user knew what to ask.
//
// Pure: no DOM. Storage, the clock and the signals are passed in.

export type RecKind = "approval" | "failure" | "screen" | "preview" | "orbit" | "lane" | "session" | "sessions" | "knowledge" | "trail" | "followup" | "feature";

export interface Rec {
  /** Stable for the same suggestion about the same thing, so a missed one is not shown twice. */
  id: string;
  kind: RecKind;
  /** The chip. One line. */
  label: string;
  /** What is asked when the chip is pressed. */
  question: string;
}

export interface RecLane { name: string; status: string; waiting: boolean }
export interface RecSurface { kind: string; title: string }

/** What the app knows right now. All of it is already on the user's screen or in views Lucid is shown. */
export interface RecSignals {
  /** The visible surfaces, top first (from the screen digest). */
  surfaces: readonly RecSurface[];
  /** A page is showing in the Preview panel. */
  previewTitle: string | null;
  lanes: readonly RecLane[];
  orbit: { title: string; status: string; blocked: boolean; tasks: number } | null;
  /** The main session: its title, and whether a turn is running. */
  sessionTitle: string;
  streaming: boolean;
  /** How many other sessions this workspace has. */
  otherSessions: number;
  /** The knowledge graph holds something. */
  knowledge: boolean;
}

export const REC_LIMITS = { label: 46, shown: 3, welcome: 4, trail: 12, missedIds: 40 } as const;

/** Surfaces that are always there and not worth a suggestion of their own. */
const CHROME = new Set(["Title bar", "Status bar", "Navigation rail", "Sidebar", "Chat", "Inspector", "Menu", "Guided tour"]);

function short(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}
function failed(status: string): boolean {
  return /error|fail|dead|stuck/i.test(status);
}
function working(status: string): boolean {
  return /work|busy|run/i.test(status);
}
function rec(kind: RecKind, key: string, label: string, question: string): Rec {
  return { id: `${kind}:${slug(key)}`, kind, label: short(label, REC_LIMITS.label), question };
}
function surfaceRec(s: RecSurface): Rec {
  const what = s.title && s.title !== s.kind ? `${s.kind} "${short(s.title, 60)}"` : s.kind;
  // A dialog is named by its title ("Connect a provider"); a panel by what it is ("Settings", "Fleet grid").
  return rec("screen", `${s.kind} ${s.title}`, `Explain: ${s.kind === "Dialog" && s.title ? s.title : s.kind}`, `Explain what I am looking at in the ${what}: what it shows, and what I can do here.`);
}

/** PURE: every suggestion the signals support. `close` (after a miss) adds one for each open surface, not
 *  only the top one. Unranked. */
export function candidates(sig: RecSignals, close = false): Rec[] {
  const out: Rec[] = [];
  for (const l of sig.lanes) {
    if (l.waiting) out.push(rec("approval", l.name, `What is ${l.name} waiting on?`, `What is lane "${l.name}" waiting for, and should I approve it?`));
    else if (failed(l.status)) out.push(rec("failure", l.name, `Why did ${l.name} fail?`, `Why did lane "${l.name}" fail, and what would you do about it?`));
  }
  const surfaces = sig.surfaces.filter((s) => !CHROME.has(s.kind));
  for (const s of close ? surfaces : surfaces.slice(0, 1)) out.push(surfaceRec(s));
  if (sig.previewTitle !== null) out.push(rec("preview", sig.previewTitle, "Review what the preview shows", "Look at the page in the Preview panel and tell me what stands out, including any script errors."));
  if (sig.orbit) {
    out.push(sig.orbit.blocked
      ? rec("orbit", `blocked ${sig.orbit.title}`, "What is blocking the orbit goal?", `What is blocking the Fleet Orbit goal "${sig.orbit.title}", and what would unblock it?`)
      : rec("orbit", sig.orbit.title, "Where does the orbit goal stand?", `Where does the Fleet Orbit goal "${sig.orbit.title}" stand, and which task should move next?`));
  }
  const busy = sig.lanes.filter((l) => working(l.status)).length;
  if (busy > 0) out.push(rec("lane", "working", busy === 1 ? "What is my lane working on?" : `What are my ${busy} lanes working on?`, "What is each working lane doing right now, in one line each?"));
  if (sig.streaming) out.push(rec("session", "streaming", "What is the main session doing?", "What is the main session working on right now, judging by what is on my screen?"));
  else if (sig.sessionTitle) out.push(rec("session", sig.sessionTitle, `Where does "${sig.sessionTitle}" stand?`, `Summarize where the session "${sig.sessionTitle}" stands and what the next step is.`));
  if (sig.otherSessions > 0) out.push(rec("sessions", "others", "Catch me up on my other sessions", "Catch me up on my other recent sessions: what each was about and where it stopped."));
  if (sig.knowledge) {
    out.push(sig.sessionTitle
      ? rec("knowledge", sig.sessionTitle, "What does the graph know about this?", `What does the knowledge graph hold that is relevant to "${sig.sessionTitle}"?`)
      : rec("knowledge", "project", "What does the knowledge graph hold?", "What does the knowledge graph hold about this project?"));
  }
  return out;
}

// ── memory ───────────────────────────────────────────────────────────────────────────────────────────

/** How much each kind matters before anything is learned. */
export const BASE_PRIORITY: Record<RecKind, number> = {
  approval: 100, failure: 90, followup: 85, screen: 70, preview: 65, orbit: 60, lane: 55, session: 50, sessions: 42, knowledge: 40, trail: 38, feature: 20,
};
export const WEIGHT = { min: 0.4, max: 1.6, used: 0.15, missed: 0.1, closeScreen: 1.8 } as const;

export interface RecMemory {
  /** A multiplier per kind, 1 when nothing is learned. */
  weights: Partial<Record<RecKind, number>>;
  /** Misses in a row. 0 = the last set worked, or the user asked their own question. */
  misses: number;
  /** Suggestions shown and passed over during the current run of misses, newest last. Not shown again
   *  until the run ends (a suggestion is used, or the user asks their own question). */
  missedIds: string[];
}
export const NO_MEMORY: RecMemory = { weights: {}, misses: 0, missedIds: [] };
export const REC_MEMORY_KEY = "lucid.asklucid.recs.v1";

const KINDS = Object.keys(BASE_PRIORITY) as RecKind[];

export function parseMemory(text: string | null): RecMemory {
  let raw: unknown = null;
  try { raw = text ? JSON.parse(text) : null; } catch { raw = null; }
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const w = typeof r.weights === "object" && r.weights !== null ? (r.weights as Record<string, unknown>) : {};
  const weights: Partial<Record<RecKind, number>> = {};
  for (const k of KINDS) {
    const v = w[k];
    if (typeof v === "number" && Number.isFinite(v)) weights[k] = Math.min(WEIGHT.max, Math.max(WEIGHT.min, v));
  }
  const misses = typeof r.misses === "number" && Number.isFinite(r.misses) ? Math.min(50, Math.max(0, Math.round(r.misses))) : 0;
  const missedIds = Array.isArray(r.missedIds) ? r.missedIds.filter((v): v is string => typeof v === "string").slice(-REC_LIMITS.missedIds) : [];
  return { weights, misses, missedIds };
}

function bump(m: RecMemory, kinds: readonly RecKind[], by: number): Partial<Record<RecKind, number>> {
  const weights = { ...m.weights };
  for (const k of new Set(kinds)) weights[k] = Math.min(WEIGHT.max, Math.max(WEIGHT.min, (weights[k] ?? 1) + by));
  return weights;
}

/** PURE: the user pressed a suggestion. Its kind gains weight, the run of misses ends, and what was set
 *  aside during the run may be offered again: a lane that was waiting an hour ago and still is deserves a
 *  second mention. */
export function noteUsed(m: RecMemory, used: Rec): RecMemory {
  return { weights: bump(m, [used.kind], WEIGHT.used), misses: 0, missedIds: [] };
}
/** PURE: a set was shown and passed over. Its kinds lose weight and its suggestions are set aside. */
export function noteMiss(m: RecMemory, shown: readonly Rec[]): RecMemory {
  if (shown.length === 0) return m;
  const missedIds = [...m.missedIds.filter((id) => !shown.some((s) => s.id === id)), ...shown.map((s) => s.id)].slice(-REC_LIMITS.missedIds);
  return { weights: bump(m, shown.map((s) => s.kind), -WEIGHT.missed), misses: Math.min(50, m.misses + 1), missedIds };
}
/** PURE: the user typed their own question. They knew what to ask: no weight changes, the run of misses ends. */
export function noteOwnQuestion(m: RecMemory): RecMemory {
  return m.misses === 0 && m.missedIds.length === 0 ? m : { ...m, misses: 0, missedIds: [] };
}

export type Follow = "normal" | "close" | "lost";
/** PURE: how closely Lucid should follow the screen. After one miss: close. After three in a row: lost,
 *  which is when a feature the user has not tried is brought up (P-ASKLUCID.6). */
export function followMode(m: RecMemory): Follow {
  return m.misses >= 3 ? "lost" : m.misses >= 1 ? "close" : "normal";
}

// ── the trail ────────────────────────────────────────────────────────────────────────────────────────

/** PURE: add the surface the user is on to the trail of recent ones (kept only while following closely). */
export function pushTrail(trail: readonly string[], kind: string): string[] {
  if (!kind || CHROME.has(kind)) return [...trail];
  return [...trail, kind].slice(-REC_LIMITS.trail);
}
/** PURE: a suggestion about the surface the user keeps returning to, when it is not the one open now. */
export function trailRec(trail: readonly string[], open: readonly RecSurface[]): Rec | null {
  const counts = new Map<string, number>();
  for (const k of trail) counts.set(k, (counts.get(k) ?? 0) + 1);
  let best: string | null = null;
  let n = 1; // at least two visits
  for (const [k, c] of counts) if (c > n && !open.some((s) => s.kind === k)) { best = k; n = c; }
  return best ? rec("trail", best, `A walkthrough of ${best}?`, `I keep coming back to the ${best}. Walk me through what it is for and the two or three things most worth doing there.`) : null;
}

// ── ranking ──────────────────────────────────────────────────────────────────────────────────────────

export interface RankOptions {
  max?: number;
  /** Suggestions to add when the contextual ones run dry (features, P-ASKLUCID.6). */
  fallback?: readonly Rec[];
  trail?: readonly string[];
}

/** PURE: the suggestions to show, best first. One per kind until every kind has had its turn, nothing the
 *  user already passed over, and in close mode the screen first. When fewer than `max` are left, the
 *  fallback fills the row, and when the user is lost it leads it. */
export function rank(sig: RecSignals, m: RecMemory, opts: RankOptions = {}): Rec[] {
  const max = opts.max ?? REC_LIMITS.shown;
  const mode = followMode(m);
  const close = mode !== "normal";
  const pool = candidates(sig, close);
  if (close && opts.trail) { const t = trailRec(opts.trail, sig.surfaces); if (t) pool.push(t); }
  const score = (r: Rec): number => BASE_PRIORITY[r.kind] * (m.weights[r.kind] ?? 1) * (close && (r.kind === "screen" || r.kind === "preview" || r.kind === "trail") ? WEIGHT.closeScreen : 1);
  const fresh = pool.filter((r) => !m.missedIds.includes(r.id)).map((r, order) => ({ r, order, s: score(r) })).sort((a, b) => b.s - a.s || a.order - b.order).map((x) => x.r);
  const picked: Rec[] = [];
  const kinds = new Set<RecKind>();
  for (const r of fresh) { if (picked.length < max && !kinds.has(r.kind)) { picked.push(r); kinds.add(r.kind); } }
  for (const r of fresh) { if (picked.length < max && !picked.includes(r)) picked.push(r); }
  const extra = (opts.fallback ?? []).filter((r) => !m.missedIds.includes(r.id) && !picked.some((p) => p.id === r.id));
  if (mode === "lost" && extra.length > 0) return [extra[0]!, ...picked].slice(0, max);
  for (const r of extra) { if (picked.length < max) picked.push(r); }
  return picked;
}

/** PURE: follow-up questions from a reply, as suggestions. */
export function followupRecs(questions: readonly string[]): Rec[] {
  return questions.map((q) => rec("followup", q, q, q));
}
