// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/lucid_suggest.test.ts - P-MINI.2 (ADR-0583): what Lucid may suggest and when. The rules
// that keep him from being a nuisance are the point: one suggestion per launch, never mid-turn or over a
// modal, never twice for the same occasion, never after "Don't ask again", and a holiday theme he pinned
// comes off when the holiday is over.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dayNum } from "./seasons.ts";
import {
  SUGGEST_ENABLED_KEY,
  SUGGEST_HOLIDAY_KEY,
  SUGGEST_NEWS_KEY,
  SUGGEST_PIN_KEY,
  WHATS_NEW,
  holidayOffer,
  holidayToast,
  nextNews,
  noteHolidayAnswer,
  noteNewsSeen,
  occasionKey,
  parseHolidayMemory,
  parsePin,
  parseSeenNews,
  pickSuggestion,
  pinExpired,
  readHolidayMemory,
  readPin,
  readSeenNews,
  setSuggestEnabled,
  suggestEnabled,
  suggestToggleHtml,
  writePin,
  type HolidayInput,
  type SuggestInput,
  type SuggestStore,
} from "./lucid_suggest.ts";

function memStore(init: Record<string, string> = {}): SuggestStore & { data: Record<string, string> } {
  const data = { ...init };
  return { data, getItem: (k) => (k in data ? data[k]! : null), setItem: (k, v) => { data[k] = v; }, removeItem: (k) => { delete data[k]; } };
}
const at = (iso: string): Date => new Date(`${iso}T12:00:00`);
const THANKSGIVING = at("2026-11-25"); // inside the Nov 20 to Nov 29 window
const QUIET = at("2026-08-12"); // no special theme is live
const offerInput = (over: Partial<HolidayInput> = {}): HolidayInput => ({ now: THANKSGIVING, enabled: true, memory: { never: false, asked: [] }, followsCalendar: false, pinned: "", ...over });

describe("the holiday theme offer", () => {
  test("offers the live season, with the last day of its window", () => {
    const o = holidayOffer(offerInput());
    expect(o?.season.id).toBe("thanksgiving");
    expect(o?.until).toBe(dayNum(2026, 11, 29));
    expect(o?.occasion).toBe(`thanksgiving@${dayNum(2026, 11, 20)}`);
  });

  test("nothing when no special theme is live", () => {
    expect(holidayOffer(offerInput({ now: QUIET }))).toBeNull();
  });

  test("never to someone who follows the calendar, wears a pinned theme, or turned suggestions off", () => {
    expect(holidayOffer(offerInput({ followsCalendar: true }))).toBeNull();
    expect(holidayOffer(offerInput({ pinned: "halloween" }))).toBeNull();
    expect(holidayOffer(offerInput({ enabled: false }))).toBeNull();
    expect(holidayOffer(offerInput({ memory: { never: true, asked: [] } }))).toBeNull();
  });

  test("asked once per occasion: not again this year, again next year", () => {
    const store = memStore();
    const first = holidayOffer(offerInput())!;
    noteHolidayAnswer(store, first, "later");
    expect(holidayOffer(offerInput({ memory: readHolidayMemory(store) }))).toBeNull();
    expect(holidayOffer(offerInput({ now: at("2026-11-28"), memory: readHolidayMemory(store) }))).toBeNull(); // same window, days later
    const nextYear = holidayOffer(offerInput({ now: at("2027-11-24"), memory: readHolidayMemory(store) }));
    expect(nextYear?.season.id).toBe("thanksgiving");
    expect(nextYear?.occasion).not.toBe(first.occasion);
    // A different holiday the same year is its own occasion.
    expect(holidayOffer(offerInput({ now: at("2026-12-24"), memory: readHolidayMemory(store) }))?.season.id).toBe("christmas");
  });

  test("Don't ask again ends every holiday suggestion; the other answers do not", () => {
    const store = memStore();
    const o = holidayOffer(offerInput())!;
    expect(noteHolidayAnswer(store, o, "wear").never).toBe(false);
    expect(noteHolidayAnswer(store, o, "never").never).toBe(true);
    expect(holidayOffer(offerInput({ now: at("2026-12-24"), memory: readHolidayMemory(store) }))).toBeNull();
    // Answering twice does not list the occasion twice, and "never" is not undone by a later answer.
    expect(noteHolidayAnswer(store, o, "later")).toEqual({ never: true, asked: [o.occasion] });
  });

  test("occasionKey is null for a season that is not live", () => {
    const o = holidayOffer(offerInput())!;
    expect(occasionKey(o.season, QUIET)).toBeNull();
    expect(occasionKey(o.season, THANKSGIVING)).toBe(o.occasion);
  });

  test("the popup names the theme, says it comes off by itself, and points at Settings", () => {
    const w = holidayToast(holidayOffer(offerInput())!);
    expect(w.title).toBe("Lucid suggests the Thanksgiving theme");
    expect(w.desc).toContain("It comes off by itself when Thanksgiving is over.");
    expect(w.meta).toContain("Settings, Theme");
  });

  test("stored memory that is junk reads as nothing asked", () => {
    expect(parseHolidayMemory(null)).toEqual({ never: false, asked: [] });
    expect(parseHolidayMemory("{nope")).toEqual({ never: false, asked: [] });
    expect(parseHolidayMemory(JSON.stringify({ never: "yes", asked: [1, "a@1", null] }))).toEqual({ never: false, asked: ["a@1"] });
  });
});

describe("a theme Lucid pinned comes off when the holiday is over", () => {
  const pin = { id: "thanksgiving", until: dayNum(2026, 11, 29) };

  test("still on during the window and on its last day; off the day after", () => {
    expect(pinExpired(pin, "thanksgiving", at("2026-11-27"))).toBe(false);
    expect(pinExpired(pin, "thanksgiving", at("2026-11-29"))).toBe(false);
    expect(pinExpired(pin, "thanksgiving", at("2026-11-30"))).toBe(true);
  });

  test("a theme the user pinned by hand since is never taken off", () => {
    expect(pinExpired(pin, "christmas", at("2026-12-10"))).toBe(false);
    expect(pinExpired(pin, "", at("2026-12-10"))).toBe(false);
    expect(pinExpired(null, "thanksgiving", at("2026-12-10"))).toBe(false);
  });

  test("the pin round-trips and junk is no pin", () => {
    const store = memStore();
    writePin(store, pin);
    expect(readPin(store)).toEqual(pin);
    writePin(store, null);
    expect(SUGGEST_PIN_KEY in store.data).toBe(false);
    expect(parsePin("{nope")).toBeNull();
    expect(parsePin(JSON.stringify({ id: "", until: 5 }))).toBeNull();
    expect(parsePin(JSON.stringify({ id: "x", until: "soon" }))).toBeNull();
  });
});

describe("what is new", () => {
  test("the newest unseen note comes first, each is shown once, and then there is nothing", () => {
    const store = memStore();
    const order: string[] = [];
    for (let i = 0; i < WHATS_NEW.length + 2; i++) {
      const n = nextNews(readSeenNews(store));
      if (!n) break;
      order.push(n.id);
      noteNewsSeen(store, n.id);
    }
    expect(order).toEqual([...WHATS_NEW].reverse().map((n) => n.id));
    expect(nextNews(readSeenNews(store))).toBeNull();
    expect(JSON.parse(store.data[SUGGEST_NEWS_KEY]!)).toEqual(order);
  });

  test("every note has a one-line title, a short summary and a longer explanation, and ids are unique", () => {
    expect(new Set(WHATS_NEW.map((n) => n.id)).size).toBe(WHATS_NEW.length);
    for (const n of WHATS_NEW) {
      expect(n.title.includes("\n")).toBe(false);
      expect(n.title.length).toBeLessThanOrEqual(60);
      expect(n.summary.length).toBeGreaterThan(40);
      expect(n.summary.length).toBeLessThanOrEqual(220);
      expect(n.more.length).toBeGreaterThan(n.summary.length);
      for (const text of [n.title, n.summary, n.more]) expect(text.includes(String.fromCodePoint(0x2014)) || text.includes(String.fromCodePoint(0x2013))).toBe(false);
    }
  });

  test("Ask Lucid's note says proposals need Confirm", () => {
    expect(WHATS_NEW.find((n) => n.id === "ask-lucid")!.more).toContain("nothing runs until you press **Confirm**");
  });

  test("seen ids that are junk read as nothing seen; marking one twice keeps one", () => {
    expect(parseSeenNews("{nope")).toEqual([]);
    expect(parseSeenNews(JSON.stringify([1, "a", null]))).toEqual(["a"]);
    const store = memStore();
    noteNewsSeen(store, "ask-lucid");
    expect(noteNewsSeen(store, "ask-lucid")).toEqual(["ask-lucid"]);
  });
});

describe("which suggestion, and whether now", () => {
  const holiday = holidayOffer(offerInput())!;
  const news = WHATS_NEW[0]!;
  const input = (over: Partial<SuggestInput> = {}): SuggestInput => ({ enabled: true, shownThisLaunch: 0, streaming: false, overlayOpen: false, tourSeen: true, holiday, news, ...over });

  test("a live holiday goes first; otherwise the what's-new note; otherwise nothing", () => {
    expect(pickSuggestion(input())).toEqual({ kind: "holiday", offer: holiday });
    expect(pickSuggestion(input({ holiday: null }))).toEqual({ kind: "news", item: news });
    expect(pickSuggestion(input({ holiday: null, news: null }))).toBeNull();
  });

  test("at most one per launch", () => {
    expect(pickSuggestion(input({ shownThisLaunch: 1 }))).toBeNull();
  });

  test("never during a turn, over a modal, before the first-run tour, or when the user turned it off", () => {
    expect(pickSuggestion(input({ streaming: true }))).toBeNull();
    expect(pickSuggestion(input({ overlayOpen: true }))).toBeNull();
    expect(pickSuggestion(input({ tourSeen: false }))).toBeNull();
    expect(pickSuggestion(input({ enabled: false }))).toBeNull();
  });
});

describe("the setting", () => {
  test("on by default, off when the user says so, and stored as absence when on", () => {
    const store = memStore();
    expect(suggestEnabled(store)).toBe(true);
    setSuggestEnabled(store, false);
    expect(store.data[SUGGEST_ENABLED_KEY]).toBe("0");
    expect(suggestEnabled(store)).toBe(false);
    setSuggestEnabled(store, true);
    expect(SUGGEST_ENABLED_KEY in store.data).toBe(false);
    expect(suggestEnabled(null)).toBe(true);
  });

  test("a blocked store neither throws nor loses the default", () => {
    const blocked: SuggestStore = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(suggestEnabled(blocked)).toBe(true);
    expect(() => setSuggestEnabled(blocked, false)).not.toThrow();
    expect(readHolidayMemory(blocked)).toEqual({ never: false, asked: [] });
    expect(readSeenNews(blocked)).toEqual([]);
    expect(readPin(blocked)).toBeNull();
    expect(noteNewsSeen(blocked, "x")).toEqual(["x"]);
  });

  test("the Settings row is a checkbox with ONE span of text (invariant 11)", () => {
    const on = suggestToggleHtml(true);
    expect(on).toContain('id="lucidSuggest" checked');
    expect(suggestToggleHtml(false)).not.toContain(" checked");
    expect(on.match(/<label class="set-toggle"><input [^>]*\/>\s*<span>.*?<\/span><\/label>/gs)?.length).toBe(1);
    expect(on).toContain("At most one suggestion each time you open the app");
  });
});

describe("the wiring in app.ts", () => {
  const app = readFileSync(join(import.meta.dir, "app.ts"), "utf8");
  const start = app.indexOf("function maybeSuggest(): void {");
  const body = app.slice(start, app.indexOf("\nlet agentArcade", start));

  test("a suggestion is decided in one place, after a delay, on a new session", () => {
    expect(start).toBeGreaterThan(0);
    expect(app.split("maybeSuggest").length - 1).toBe(2); // the definition and the one timer that calls it
    expect(app).toContain("setTimeout(maybeSuggest, SUGGEST_DELAY_MS);");
  });

  test("the popup leaves by itself, the holiday counts as asked when shown, and the news as seen when shown", () => {
    expect(body.split("timeout: SUGGEST_TOAST_MS").length - 1).toBe(2);
    expect(body.indexOf('noteHolidayAnswer(store, offer, "later");')).toBeLessThan(body.indexOf("showToast({"));
    expect(body).toContain("noteNewsSeen(store, item.id);");
  });

  test("Wear it pins the season with its end day; Tell me more opens Ask Lucid", () => {
    expect(body).toContain("writePin(store, { id: offer.season.id, until: offer.until });");
    expect(body).toContain("setSeasonPref(SEASON_PICK_KEY, offer.season.id);");
    expect(body).toContain("askLucid().say(item.more)");
  });

  test("an expired pin is taken off before anything is suggested", () => {
    expect(body.trimStart().split("\n")[1]!.trim()).toBe("expireSuggestedTheme();");
    expect(app).toContain('if (pinExpired(pin, pinnedNow, new Date())) { writePin(store, null); setSeasonPref(SEASON_PICK_KEY, ""); }');
  });
});

// The holiday rule uses the seasons registry as it is, so a change to a window shows up here.
test("the fixtures above still describe real windows", () => {
  expect(holidayOffer(offerInput({ now: at("2026-11-19") }))).toBeNull(); // the day before the window
  expect(holidayOffer(offerInput({ now: at("2026-11-20") }))?.season.id).toBe("thanksgiving");
  expect(holidayOffer(offerInput({ now: at("2026-11-30") }))?.season.id ?? null).not.toBe("thanksgiving");
  expect(SUGGEST_HOLIDAY_KEY).toBe("lucid.suggest.holiday");
});
