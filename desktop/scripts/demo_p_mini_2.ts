// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_mini_2.ts
//
// P-MINI.2 (ADR-0583): Lucid may suggest a holiday theme and say what is new. Pure checks, no browser:
//   1. a live holiday is offered once per occasion, and "Wear it" pins it for that occasion only
//   2. the pinned theme comes off the day after the window ends, unless the user picked another by hand
//   3. "Don't ask again" ends holiday suggestions; a user who follows the calendar or wears a theme is not asked
//   4. what is new: the newest unseen note first, each shown once
//   5. not annoying: one suggestion per launch, never mid-turn, over a modal or before the first-run tour
//   6. the one setting silences both
//
// Run: bun run desktop/scripts/demo_p_mini_2.ts

import { dayOf } from "../renderer/seasons.ts";
import {
  WHATS_NEW, holidayOffer, holidayToast, nextNews, noteHolidayAnswer, noteNewsSeen, pickSuggestion, pinExpired, readHolidayMemory,
  readPin, readSeenNews, setSuggestEnabled, suggestEnabled, writePin, type SuggestInput, type SuggestStore,
} from "../renderer/lucid_suggest.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m: string): void => console.log(`   ok - ${m}`);

function memStore(): SuggestStore {
  const data: Record<string, string> = {};
  return { getItem: (k) => (k in data ? data[k]! : null), setItem: (k, v) => { data[k] = v; }, removeItem: (k) => { delete data[k]; } };
}
const at = (y: number, m: number, d: number): Date => new Date(y, m - 1, d, 12, 0, 0);
const offerOn = (store: SuggestStore, now: Date, over: { followsCalendar?: boolean; pinned?: string } = {}) =>
  holidayOffer({ now, enabled: suggestEnabled(store), memory: readHolidayMemory(store), followsCalendar: over.followsCalendar ?? false, pinned: over.pinned ?? "" });

console.log("1) a live holiday is offered once per occasion");
const store = memStore();
const first = offerOn(store, at(2026, 11, 25)) ?? fail("Thanksgiving week must produce an offer");
{
  if (first.season.id !== "thanksgiving") fail(`expected thanksgiving, got ${first.season.id}`);
  if (offerOn(store, at(2026, 8, 12))) fail("no holiday is live in mid August");
  const words = holidayToast(first);
  console.log(`      "${words.title}"`);
  console.log(`      "${words.desc}"`);
  noteHolidayAnswer(store, first, "wear");
  writePin(store, { id: first.season.id, until: first.until });
  if (offerOn(store, at(2026, 11, 27))) fail("the same occasion must not be offered twice");
  const nextYear = offerOn(store, at(2027, 11, 24));
  if (!nextYear || nextYear.occasion === first.occasion) fail("next year's Thanksgiving is a new occasion");
  ok(`offered on Nov 25 as ${first.occasion}, not again on Nov 27, offered again next year as ${nextYear!.occasion}`);
}

console.log("2) the theme Lucid pinned comes off by itself");
{
  const pin = readPin(store) ?? fail("Wear it must store a pin");
  if (pinExpired(pin, "thanksgiving", at(2026, 11, 27))) fail("the theme must stay on during the window");
  const lastDay = [26, 27, 28, 29, 30].find((d) => dayOf(at(2026, 11, d)) === pin.until) ?? fail("the window must end in late November");
  if (pinExpired(pin, "thanksgiving", at(2026, 11, lastDay))) fail("the theme must stay on through the last day");
  if (!pinExpired(pin, "thanksgiving", at(2026, 11, lastDay + 1))) fail("the theme must come off the day after the window ends");
  if (pinExpired(pin, "christmas", at(2026, 12, 20))) fail("a theme the user picked by hand since is never taken off");
  ok(`on through Nov ${lastDay}, off on Nov ${lastDay + 1}; a theme picked by hand afterwards is left alone`);
}

console.log("3) who is not asked");
{
  const s2 = memStore();
  const xmas = offerOn(s2, at(2026, 12, 24)) ?? fail("Christmas Eve must produce an offer");
  if (offerOn(s2, at(2026, 12, 24), { followsCalendar: true })) fail("a user who follows the calendar already gets the theme");
  if (offerOn(s2, at(2026, 12, 24), { pinned: "halloween" })) fail("a user who wears a special theme is not asked to change it");
  noteHolidayAnswer(s2, xmas, "never");
  if (offerOn(s2, at(2026, 12, 25)) || offerOn(s2, at(2027, 11, 24))) fail("Don't ask again must end every holiday suggestion");
  const s3 = memStore();
  const later = offerOn(s3, at(2026, 12, 24))!;
  noteHolidayAnswer(s3, later, "later");
  if (offerOn(s3, at(2026, 12, 26))) fail("Not now must not be asked again this season");
  if (!offerOn(s3, at(2027, 12, 24))) fail("Not now is asked again next year");
  ok("follows the calendar: no. Wears a theme: no. Don't ask again: never. Not now: next year");
}

console.log("4) what is new");
{
  const s4 = memStore();
  const order: string[] = [];
  for (let i = 0; i < WHATS_NEW.length + 2; i++) {
    const n = nextNews(readSeenNews(s4));
    if (!n) break;
    order.push(n.id);
    noteNewsSeen(s4, n.id);
  }
  const want = [...WHATS_NEW].reverse().map((n) => n.id);
  if (order.join() !== want.join()) fail(`expected newest first (${want.join()}), got ${order.join()}`);
  if (nextNews(readSeenNews(s4))) fail("a note is shown once");
  for (const n of WHATS_NEW) console.log(`      ${n.title}`);
  ok(`${order.length} notes, newest first, each shown once`);
}

console.log("5) not annoying");
{
  const base: SuggestInput = { enabled: true, shownThisLaunch: 0, streaming: false, overlayOpen: false, tourSeen: true, holiday: first, news: WHATS_NEW[0]! };
  const got = pickSuggestion(base);
  if (got?.kind !== "holiday") fail("a live holiday goes first: it is the one that expires");
  if (pickSuggestion({ ...base, holiday: null })?.kind !== "news") fail("with no holiday, the note is shown");
  const blocked: [string, Partial<SuggestInput>][] = [
    ["a second suggestion in one launch", { shownThisLaunch: 1 }],
    ["a running turn", { streaming: true }],
    ["a modal, the tour or the palette on screen", { overlayOpen: true }],
    ["a first run that has not seen the tour", { tourSeen: false }],
  ];
  for (const [why, over] of blocked) if (pickSuggestion({ ...base, ...over })) fail(`nothing may be suggested during ${why}`);
  ok(`holiday before news; nothing during: ${blocked.map(([w]) => w).join("; ")}`);
}

console.log("6) the one setting");
{
  const s6 = memStore();
  if (!suggestEnabled(s6)) fail("suggestions are on until the user turns them off");
  setSuggestEnabled(s6, false);
  if (offerOn(s6, at(2026, 12, 24))) fail("off must stop the holiday offer");
  if (pickSuggestion({ enabled: suggestEnabled(s6), shownThisLaunch: 0, streaming: false, overlayOpen: false, tourSeen: true, holiday: null, news: WHATS_NEW[0]! })) fail("off must stop the notes too");
  setSuggestEnabled(s6, true);
  if (!offerOn(s6, at(2026, 12, 24))) fail("turning it back on restores the offer");
  ok("off silences the holiday offer and the notes; on restores them");
}

console.log("\ndemo_p_mini_2 OK - Lucid offers a live holiday theme once and takes it off when the holiday ends, says what is new once per feature, shows at most one suggestion per launch, and one setting silences him.");
process.exit(0);
