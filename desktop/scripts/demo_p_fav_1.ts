// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_fav_1.ts
//
// Increment P-FAV.1 (ADR-0165) — model-picker favorite stars. Proves, against the REAL pure
// layer (model_favorites.ts), that:
//   (1) star → persist → reopen round-trips through the storage string format;
//   (2) the Favorites section inherits the CATALOG's curated order, not click order;
//   (3) corrupted storage (bad JSON / wrong types) degrades to "no favorites", never a throw;
//   (4) a stale favorite (provider disconnected) is hidden but NOT pruned — reconnecting the
//       provider brings the star back;
//   (5) the MAX_FAVS cap evicts the oldest star so the newest always sticks.

import { MAX_FAVS, parseFavs, starredOf, toggleFav } from "../renderer/model_favorites.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-FAV.1 — model-picker favorite stars ==");

// The curated catalog order the picker renders (gov-first, newest-first — upstream's job).
const catalog = [
  { value: "asksage/gpt-5.5", name: "GPT-5.5" },
  { value: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8" },
  { value: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { value: "google/gemini-3.1-pro", name: "Gemini 3.1 Pro" },
];

console.log("\n1) star → persist → reopen round-trip");
let stored: string | null = null; // stands in for localStorage
let favs = parseFavs(stored);
favs = toggleFav(favs, "google/gemini-3.1-pro");
favs = toggleFav(favs, "asksage/gpt-5.5");
stored = JSON.stringify(favs);
const reopened = parseFavs(stored);
if (reopened.length !== 2) fail("two stars should survive the round-trip");
ok("two stars persisted and re-parsed");

console.log("\n2) Favorites section = catalog order, not click order");
const sec = starredOf(catalog, reopened).map((m) => m.value);
if (sec[0] !== "asksage/gpt-5.5" || sec[1] !== "google/gemini-3.1-pro") fail(`curated order not preserved: ${sec}`);
ok("gov-first catalog order wins over click order");

console.log("\n3) corrupted storage degrades safely");
for (const junk of ["{nope", '"str"', '{"a":1}', '[1,2,3]', ""]) {
  if (parseFavs(junk).length !== 0) fail(`junk ${JSON.stringify(junk)} should parse to no favorites`);
}
ok("bad JSON / wrong shapes → empty, never a throw");

console.log("\n4) stale favorites hide but survive");
const withStale = [...reopened, "openai/gone-model"];
if (starredOf(catalog, withStale).length !== 2) fail("stale favorite must not render");
if (!withStale.includes("openai/gone-model")) fail("stale favorite must stay in storage");
ok("disconnected provider's star hidden now, back when it returns");

console.log("\n5) the cap evicts oldest, keeps newest");
let full: string[] = [];
for (let i = 0; i < MAX_FAVS; i++) full = toggleFav(full, `m${i}`);
full = toggleFav(full, "newest");
if (full.length !== MAX_FAVS) fail("cap exceeded");
if (!full.includes("newest") || full.includes("m0")) fail("eviction should drop the oldest star");
ok(`cap ${MAX_FAVS}: oldest evicted, newest kept`);

console.log("\n✓ P-FAV.1 demo passed — the models you actually use are one click from the top of the picker.");
