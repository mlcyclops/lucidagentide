// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/lucid_suggest.ts - P-MINI.2 (ADR-0583): the two things Lucid may suggest, and when.
//
//   1. A HOLIDAY THEME while one is live. Special themes existed (seasons.ts) but nothing ever offered one:
//      the user had to find the picker. Lucid offers the live one in a small popup with three answers:
//        Wear it          the theme is pinned for THIS occasion only and comes off when its window ends
//        Not now          asked again next time this season comes round, not before
//        Don't ask again  no more holiday suggestions
//   2. WHAT IS NEW after an update: one short note per feature, shown once, with "Tell me more", which opens
//      the Ask Lucid fly-out where he explains it.
//
// NOT ANNOYING, BY RULE. At most one suggestion per launch. Never during a running turn, never over a modal
// or the first-run tour, never before the tour has been seen. One setting, "Lucid may suggest things",
// silences both. A holiday is never suggested to someone who already follows the calendar or already wears
// a special theme.
//
// Pure: no DOM. Storage and the clock are passed in, so every rule is unit-tested.

import { activeSeason, dayOf, nextWindow, type SeasonDef } from "./seasons.ts";

/** The slice of Storage this module uses. */
export interface SuggestStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export const SUGGEST_ENABLED_KEY = "lucid.suggest.enabled";
export const SUGGEST_HOLIDAY_KEY = "lucid.suggest.holiday";
export const SUGGEST_NEWS_KEY = "lucid.suggest.news";
export const SUGGEST_PIN_KEY = "lucid.suggest.pin";

function read(store: SuggestStore | null, key: string): string | null {
  try { return store?.getItem(key) ?? null; } catch { return null; }
}
function write(store: SuggestStore | null, key: string, value: string | null): void {
  try { if (value === null) store?.removeItem(key); else store?.setItem(key, value); } catch { /* storage blocked: the answer lasts for this window only */ }
}

/** "Lucid may suggest things": on unless the user turned it off. */
export function suggestEnabled(store: SuggestStore | null): boolean {
  return read(store, SUGGEST_ENABLED_KEY) !== "0";
}
export function setSuggestEnabled(store: SuggestStore | null, on: boolean): void {
  write(store, SUGGEST_ENABLED_KEY, on ? null : "0");
}

// ── the holiday theme ────────────────────────────────────────────────────────────────────────────────

/** What the user said to holiday suggestions: `never`, and for each occasion (season id plus the year its
 *  window starts in) that it was already asked. */
export interface HolidayMemory { never: boolean; asked: string[] }

export function parseHolidayMemory(text: string | null): HolidayMemory {
  let raw: unknown = null;
  try { raw = text ? JSON.parse(text) : null; } catch { raw = null; }
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const asked = Array.isArray(r.asked) ? r.asked.filter((a): a is string => typeof a === "string").slice(-40) : [];
  return { never: r.never === true, asked };
}
export function readHolidayMemory(store: SuggestStore | null): HolidayMemory {
  return parseHolidayMemory(read(store, SUGGEST_HOLIDAY_KEY));
}

/** PURE: the key for one occurrence of a season: its id and the day its current window starts. A holiday
 *  asked about this year is asked about again next year, not next week. */
export function occasionKey(season: SeasonDef, now: Date): string | null {
  const w = nextWindow(season, now);
  if (!w || w.start > dayOf(now)) return null; // not live
  return `${season.id}@${w.start}`;
}

export interface HolidayOffer { season: SeasonDef; occasion: string; /** The last day of the window. */ until: number }

export interface HolidayInput {
  now: Date;
  enabled: boolean;
  memory: HolidayMemory;
  /** The user already follows the calendar (Settings, Theme). */
  followsCalendar: boolean;
  /** The user has a special theme pinned by hand ("" = none). */
  pinned: string;
}

/** PURE: the holiday theme to offer right now, or null. */
export function holidayOffer(i: HolidayInput): HolidayOffer | null {
  if (!i.enabled || i.memory.never || i.followsCalendar || i.pinned) return null;
  const season = activeSeason(i.now);
  if (!season) return null;
  const occasion = occasionKey(season, i.now);
  const w = nextWindow(season, i.now);
  if (!occasion || !w || i.memory.asked.includes(occasion)) return null;
  return { season, occasion, until: w.end };
}

export type HolidayAnswer = "wear" | "later" | "never";

/** Record the answer to an offer. Every answer marks the occasion as asked; `never` ends all of them. */
export function noteHolidayAnswer(store: SuggestStore | null, offer: HolidayOffer, answer: HolidayAnswer): HolidayMemory {
  const prev = readHolidayMemory(store);
  const next: HolidayMemory = { never: prev.never || answer === "never", asked: prev.asked.includes(offer.occasion) ? prev.asked : [...prev.asked, offer.occasion] };
  write(store, SUGGEST_HOLIDAY_KEY, JSON.stringify(next));
  return next;
}

/** A theme Lucid pinned for one occasion: which season, and the last day it should stay on. */
export interface SuggestPin { id: string; until: number }

export function parsePin(text: string | null): SuggestPin | null {
  let raw: unknown = null;
  try { raw = text ? JSON.parse(text) : null; } catch { raw = null; }
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  if (!r || typeof r.id !== "string" || r.id === "" || typeof r.until !== "number" || !Number.isFinite(r.until)) return null;
  return { id: r.id, until: r.until };
}
export function readPin(store: SuggestStore | null): SuggestPin | null {
  return parsePin(read(store, SUGGEST_PIN_KEY));
}
export function writePin(store: SuggestStore | null, pin: SuggestPin | null): void {
  write(store, SUGGEST_PIN_KEY, pin ? JSON.stringify(pin) : null);
}

/** PURE: should the theme Lucid pinned come off now? Only when the app's pinned season is still the one
 *  Lucid set (the user did not pick another by hand since) and its window has ended. */
export function pinExpired(pin: SuggestPin | null, pinnedNow: string, now: Date): boolean {
  return pin !== null && pinnedNow === pin.id && dayOf(now) > pin.until;
}

/** PURE: the popup's words for a holiday offer. */
export function holidayToast(offer: HolidayOffer): { title: string; desc: string; meta: string } {
  return {
    title: `Lucid suggests the ${offer.season.label} theme`,
    desc: `${offer.season.blurb} Wear it for the occasion? It comes off by itself when ${offer.season.label} is over.`,
    meta: "Change it any time in Settings, Theme",
  };
}

// ── what is new ──────────────────────────────────────────────────────────────────────────────────────

export interface NewsItem {
  id: string;
  /** The popup's title. One line. */
  title: string;
  /** The popup's one or two sentences. */
  summary: string;
  /** What Lucid says in the Ask Lucid fly-out when the user wants more. Markdown. */
  more: string;
}

/** Newest last. An id is shown once per browser profile, so an entry is added here, never renamed. */
export const WHATS_NEW: readonly NewsItem[] = [
  {
    id: "result-window",
    title: "New: tool output sized to your model",
    summary: "A local model with a small context window now gets a smaller slice of each tool result, with the rest kept as an artifact it can read back.",
    more: "**Tool output sized to your model.** LUCID shows a model at most one sixteenth of its context window from any one tool result: 2 KB for an 8K model, 8 KB for 32K. The rest is stored as a session artifact the model reads back in pages. Cloud models keep the 50 KB default.\n\nYou can change it in **Settings, Local Providers, Tool output window**.",
  },
  {
    id: "mini-lucid",
    title: "New: mini Lucid drops by",
    summary: "Turn him on for the prompt bar: he rests in its right corner, practicing or meditating, and types while a session is working.",
    more: "**Mini Lucid.** He is off on the prompt bar until you turn him on (the LUCID Agent role always has him). He rests in the right corner, practicing or meditating, sits and types while a session is working, and walks across about every five minutes. He never covers the prompt. Double-click him to send him off; right-click to turn him off.\n\nChoose **Off**, **Sometimes** or **Always**, and **Small** or **Large (classic)**, in **Settings, Mini Lucid**.",
  },
  {
    id: "ask-lucid",
    title: "New: Ask Lucid",
    summary: "A side conversation that does not interrupt your session. Lucid can see your fleet lanes, the Fleet Orbit and the knowledge graph.",
    more: "**Ask Lucid** is this panel. Ask about your fleet lanes, the Fleet Orbit goal or what the knowledge graph holds, or about anything else. It does not interrupt the session you are working in.\n\nI can also **propose** starting a lane, prompting one, or adding an orbit task. Each proposal is a card, and nothing runs until you press **Confirm**.\n\nDrag the header to float the panel, drop it on the right or bottom edge to dock it, or minimize it to a pill.",
  },
];

export function parseSeenNews(text: string | null): string[] {
  let raw: unknown = null;
  try { raw = text ? JSON.parse(text) : null; } catch { raw = null; }
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string").slice(-100) : [];
}
export function readSeenNews(store: SuggestStore | null): string[] {
  return parseSeenNews(read(store, SUGGEST_NEWS_KEY));
}
export function noteNewsSeen(store: SuggestStore | null, id: string): string[] {
  const prev = readSeenNews(store);
  const next = prev.includes(id) ? prev : [...prev, id];
  write(store, SUGGEST_NEWS_KEY, JSON.stringify(next));
  return next;
}

/** PURE: the next note to show: the NEWEST unseen one, so a user who skipped several updates hears about the
 *  latest feature first. */
export function nextNews(seen: readonly string[], items: readonly NewsItem[] = WHATS_NEW): NewsItem | null {
  for (let i = items.length - 1; i >= 0; i--) if (!seen.includes(items[i]!.id)) return items[i]!;
  return null;
}

// ── which one, and whether now ───────────────────────────────────────────────────────────────────────

export type Suggestion = { kind: "holiday"; offer: HolidayOffer } | { kind: "news"; item: NewsItem };

export interface SuggestInput {
  enabled: boolean;
  /** How many suggestions this launch has already shown. */
  shownThisLaunch: number;
  /** A turn is running. */
  streaming: boolean;
  /** A modal, the first-run tour or the command palette is on screen. */
  overlayOpen: boolean;
  /** The first-run tour has been finished or skipped. Nothing is suggested before it. */
  tourSeen: boolean;
  holiday: HolidayOffer | null;
  news: NewsItem | null;
}

/** PURE: the one suggestion to show now, or null. A live holiday goes first because it is the one that
 *  expires; a what's-new note waits for the next launch. */
export function pickSuggestion(i: SuggestInput): Suggestion | null {
  if (!i.enabled || i.shownThisLaunch > 0 || i.streaming || i.overlayOpen || !i.tourSeen) return null;
  if (i.holiday) return { kind: "holiday", offer: i.holiday };
  if (i.news) return { kind: "news", item: i.news };
  return null;
}

/** PURE: the Settings row for "Lucid may suggest things", in the `set-toggle` shape (one span of text). */
export function suggestToggleHtml(on: boolean): string {
  return `<label class="set-toggle"><input type="checkbox" id="lucidSuggest"${on ? " checked" : ""}/>
      <span><b>Lucid may suggest things</b> - a holiday theme while one is live, and what is new after an update. At most one suggestion each time you open the app, and never while a session is working.</span></label>`;
}
