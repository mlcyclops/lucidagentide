// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/mini_lucid.ts - P-MINI.1 (ADR-0580): when mini Lucid shows up, and the user's say over it.
//
// Mini Lucid is the prompt-bar runner (mascot_runner.ts). Until this increment he existed only in the LUCID
// Agent role. Now he also VISITS the other roles on a new session:
//   - LUCID Agent role: always there, as before. A click greets him (he leaps).
//   - Developer role: the first new session of each app launch. A click sends him away.
//   - Any role: now and then on a new session (one in four), never twice within thirty minutes and at most
//     three times a day, so he stays a pleasant surprise. A click sends him away.
// The user's preference wins over all of it: Off (never, outside the Agent role; the default since P-MINI.3,
// ADR-0596), Sometimes (the rules above), Always (every session, like the Agent role). A right-click on him
// turns him off everywhere until turned back on, and the size is Small (mini Lucid's) or Large (classic).
//
// Pure: no DOM. Storage is passed in, so the policy and the bookkeeping are unit-tested.

/** How much of mini Lucid the user wants outside the LUCID Agent role. */
export type MiniPresence = "off" | "sometimes" | "always";
export const MINI_PRESENCES: readonly MiniPresence[] = ["off", "sometimes", "always"];
export const MINI_PRESENCE_LABEL: Record<MiniPresence, string> = {
  off: "Off",
  sometimes: "Sometimes",
  always: "Always",
};
export const MINI_PRESENCE_DESC: Record<MiniPresence, string> = {
  off: "He stays away, except in the LUCID Agent role where he lives.",
  sometimes: "He drops by on a new session now and then. Double-click him and he leaves.",
  always: "He is on the prompt bar in every session.",
};

export const MINI_PRESENCE_KEY = "lucid.mini.presence";
export const MINI_VISITS_KEY = "lucid.mini.visits";

/** One new session in four gets a visit under "sometimes". */
export const VISIT_CHANCE = 0.25;
/** Never two visits closer together than this. */
export const VISIT_GAP_MS = 30 * 60 * 1000;
/** At most this many visits in one local day. */
export const VISITS_PER_DAY = 3;

/** The slice of Storage this module uses, so tests pass a plain object. */
export interface MiniStore { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** P-MINI.3 (ADR-0596): an untouched install has him OFF on the prompt bar; the LUCID Agent role still has
 *  him resident. A stored choice is kept. */
export function parsePresence(v: unknown): MiniPresence {
  return v === "sometimes" || v === "always" ? v : "off";
}
export function readPresence(store: MiniStore | null): MiniPresence {
  try { return parsePresence(store?.getItem(MINI_PRESENCE_KEY)); } catch { return "off"; }
}

/** P-MINI.3 (ADR-0596): how big the prompt-bar ninja and the Arcade ninja are drawn. "small" is mini Lucid's
 *  size (one CSS pixel per sprite cell, crisp on every display), the default; "large" is the classic two. */
export type MascotSize = "small" | "large";
export const MASCOT_SIZES: readonly MascotSize[] = ["small", "large"];
export const MASCOT_SIZE_KEY = "lucid.mascot.size";
/** CSS pixels per sprite cell for each size. */
export const MASCOT_CELL_CSS: Record<MascotSize, number> = { small: 1, large: 2 };
export const MASCOT_SIZE_LABEL: Record<MascotSize, string> = { small: "Small", large: "Large (classic)" };
export const MASCOT_SIZE_DESC: Record<MascotSize, string> = {
  small: "Mini Lucid's size, on the prompt bar and in the Arcade.",
  large: "The original, twice as big.",
};
export function parseMascotSize(v: unknown): MascotSize {
  return v === "large" ? "large" : "small";
}
export function readMascotSize(store: MiniStore | null): MascotSize {
  try { return parseMascotSize(store?.getItem(MASCOT_SIZE_KEY)); } catch { return "small"; }
}
export function writeMascotSize(store: MiniStore | null, s: MascotSize): void {
  try { store?.setItem(MASCOT_SIZE_KEY, s); } catch { /* storage blocked: the choice lasts for this window only */ }
}

/** P-MINI.3 (ADR-0596): a right-click on him turns him off everywhere, the LUCID Agent role included, until
 *  the user turns him back on (the toast's button or Settings). */
export const MASCOT_HIDDEN_KEY = "lucid.mascot.hidden";
export function readMascotHidden(store: MiniStore | null): boolean {
  try { return store?.getItem(MASCOT_HIDDEN_KEY) === "1"; } catch { return false; }
}
export function writeMascotHidden(store: MiniStore | null, hidden: boolean): void {
  try { store?.setItem(MASCOT_HIDDEN_KEY, hidden ? "1" : "0"); } catch { /* storage blocked: this window only */ }
}
export function writePresence(store: MiniStore | null, p: MiniPresence): void {
  try { store?.setItem(MINI_PRESENCE_KEY, p); } catch { /* storage blocked: the choice lasts for this window only */ }
}

/** The visit ledger: the local day it counts for, how many visits that day, and when the last one began. */
export interface VisitLedger { day: string; count: number; lastAt: number }

/** The local calendar day of `now`, as YYYY-MM-DD. */
export function localDay(now: number): string {
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** PURE: the ledger from stored text. Anything unreadable is an empty ledger, and a ledger from an earlier
 *  day keeps its `lastAt` (the gap rule still applies across midnight) with the count reset. */
export function parseLedger(text: string | null, now: number): VisitLedger {
  const day = localDay(now);
  let raw: unknown = null;
  try { raw = text ? JSON.parse(text) : null; } catch { raw = null; }
  if (typeof raw !== "object" || raw === null) return { day, count: 0, lastAt: 0 };
  const r = raw as Record<string, unknown>;
  const lastAt = typeof r.lastAt === "number" && Number.isFinite(r.lastAt) && r.lastAt > 0 && r.lastAt <= now ? r.lastAt : 0;
  const count = r.day === day && typeof r.count === "number" && Number.isInteger(r.count) && r.count > 0 ? r.count : 0;
  return { day, count, lastAt };
}

export function readLedger(store: MiniStore | null, now: number): VisitLedger {
  try { return parseLedger(store?.getItem(MINI_VISITS_KEY) ?? null, now); } catch { return parseLedger(null, now); }
}

/** Record that a visit began at `now`. */
export function noteVisit(store: MiniStore | null, now: number): VisitLedger {
  const prev = readLedger(store, now);
  const next: VisitLedger = { day: prev.day, count: prev.count + 1, lastAt: now };
  try { store?.setItem(MINI_VISITS_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
  return next;
}

export interface VisitInput {
  /** The role picker's value: "developer", "security", "manager", "executive", "lucid-agent", or null. */
  role: string | null;
  presence: MiniPresence;
  /** How many new sessions this launch has seen, counting this one (1 = the first). */
  newSessionNumber: number;
  ledger: VisitLedger;
  now: number;
  /** A fresh number in [0, 1), passed in so the rule is testable. */
  rand: number;
}

/** PURE: does mini Lucid visit this new session? Only meaningful under "sometimes": "off" and "always" and
 *  the LUCID Agent role never need a visit decided. */
export function shouldVisit(i: VisitInput): boolean {
  if (i.presence !== "sometimes" || i.role === "lucid-agent") return false;
  // The Developer's first new session of a launch always gets him, whatever the ledger says.
  if (i.role === "developer" && i.newSessionNumber === 1) return true;
  if (i.ledger.count >= VISITS_PER_DAY) return false;
  if (i.ledger.lastAt > 0 && i.now - i.ledger.lastAt < VISIT_GAP_MS) return false;
  return i.rand < VISIT_CHANCE;
}

/** What the prompt bar should hold right now. */
export type MiniMount =
  | { kind: "none" }
  /** The LUCID Agent role, or "always": he stays, and a click greets him. */
  | { kind: "resident" }
  /** A visit: he stays until clicked, then leaves. */
  | { kind: "visitor" };

/** PURE: the mount for the current role, preference and visit state. `hidden` (a right-click turned him off)
 *  beats everything, the LUCID Agent role included. */
export function miniMount(role: string | null, presence: MiniPresence, visiting: boolean, hidden = false): MiniMount {
  if (hidden) return { kind: "none" };
  if (role === "lucid-agent") return { kind: "resident" };
  if (presence === "always") return { kind: "resident" };
  if (presence === "sometimes" && visiting) return { kind: "visitor" };
  return { kind: "none" };
}

/** PURE: the Settings card body: one radio row per choice, in the Settings `set-toggle` shape (the row's
 *  text is ONE span, so the flex label never splits a sentence, invariant 11), and a note. */
export function miniLucidCardHtml(presence: MiniPresence, esc: (s: string) => string, infoIcon: string, size: MascotSize = "small", hidden = false): string {
  const row = (p: MiniPresence): string =>
    `<label class="set-toggle"><input type="radio" name="miniPresence" value="${p}"${p === presence ? " checked" : ""}/>
      <span><b>${esc(MINI_PRESENCE_LABEL[p])}</b> - ${esc(MINI_PRESENCE_DESC[p])}</span></label>`;
  const sizeRow = (s: MascotSize): string =>
    `<label class="set-toggle"><input type="radio" name="mascotSize" value="${s}"${s === size ? " checked" : ""}/>
      <span><b>${esc(MASCOT_SIZE_LABEL[s])}</b> - ${esc(MASCOT_SIZE_DESC[s])}</span></label>`;
  return `<label class="set-toggle"><input type="checkbox" id="mascotShown"${hidden ? "" : " checked"}/>
      <span><b>${esc("Show the Lucid mascot")}</b> - ${esc("Off after a right-click on him, in every role. Turn it back on here.")}</span></label>
    <div class="pscope-lbl">${esc("On the prompt bar")}</div>
    ${MINI_PRESENCES.map(row).join("\n    ")}
    <div class="pscope-lbl">${esc("Size")}</div>
    ${MASCOT_SIZES.map(sizeRow).join("\n    ")}
    <div class="set-note">${infoIcon} ${esc("Most of the time he rests in the right corner of the prompt bar, practicing or meditating, and types while a session works. About every five minutes he walks across. Double-click him to send him off, right-click to turn him off. He never covers the prompt, and he holds still when your system asks for reduced motion.")}</div>`;
}
