// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_mini_3.ts
//
// P-MINI.3 (ADR-0596): a smaller, calmer Lucid who wears the theme. Pure checks, no browser:
//   1. an untouched install has him off on the prompt bar; the LUCID Agent role keeps him
//   2. a right-click's turn-off beats every role and preference, and turning him back on restores him
//   3. Small (mini Lucid's size) is the default; Large (classic) is twice as big and is remembered
//   4. the Settings card offers the show switch, the presence and the size, one span per row
//   5. a color theme recolors him; the Lucid themes keep the brand green; a broken accent never paints
//
// The calm route, the traverse, the double-click dash and the right-click are proved by demo-P-MASCOT.2 and
// demo-P-MASCOT.5 and mascot_runner.test.ts; the Arcade at both sizes by mascot_game.test.ts and
// mascot_minigames.test.ts.
//
// Run: bun run desktop/scripts/demo_p_mini_3.ts

import { MASCOT_PALETTE } from "../renderer/mascot.ts";
import { mascotPaletteFor } from "../renderer/mascot_theme.ts";
import {
  MASCOT_CELL_CSS, MASCOT_SIZES, MINI_PRESENCES, miniLucidCardHtml, miniMount, readMascotHidden, readMascotSize, readPresence,
  writeMascotHidden, writeMascotSize, writePresence, type MiniStore,
} from "../renderer/mini_lucid.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m: string): void => console.log(`   ok - ${m}`);
function memStore(): MiniStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => (k in data ? data[k]! : null), setItem: (k, v) => { data[k] = v; } };
}

console.log("1) off by default on the prompt bar, resident in the LUCID Agent role");
{
  const store = memStore();
  if (readPresence(store) !== "off") fail("an untouched install must read Off");
  for (const role of ["developer", "security", "manager", "executive", null]) {
    if (miniMount(role, readPresence(store), false).kind !== "none") fail(`role ${role} must not show him by default`);
  }
  if (miniMount("lucid-agent", readPresence(store), false).kind !== "resident") fail("the LUCID Agent role keeps him");
  writePresence(store, "always");
  if (miniMount("developer", readPresence(store), false).kind !== "resident") fail("Always shows him");
  ok("Off by default for every role but the LUCID Agent role; a stored choice is kept");
}

console.log("\n2) a right-click turns him off everywhere until he is turned back on");
{
  const store = memStore();
  writePresence(store, "always");
  writeMascotHidden(store, true);
  for (const role of ["lucid-agent", "developer"]) {
    if (miniMount(role, readPresence(store), true, readMascotHidden(store)).kind !== "none") fail(`hidden must beat role ${role}`);
  }
  writeMascotHidden(store, false);
  if (miniMount("developer", readPresence(store), false, readMascotHidden(store)).kind !== "resident") fail("turning him back on restores Always");
  ok("hidden beats the Agent role and Always; the toast's Turn back on restores the stored choice");
}

console.log("\n3) Small by default, Large (classic) twice as big");
{
  const store = memStore();
  if (readMascotSize(store) !== "small") fail("Small is the default");
  if (MASCOT_CELL_CSS.small !== 1 || MASCOT_CELL_CSS.large !== 2) fail("Small is one CSS pixel a cell (mini Lucid), Large two");
  writeMascotSize(store, "large");
  if (readMascotSize(store) !== "large") fail("Large is remembered");
  ok(`sizes ${MASCOT_SIZES.join(", ")}: 40 x 52 cells at ${MASCOT_CELL_CSS.small} and ${MASCOT_CELL_CSS.large} CSS px a cell`);
}

console.log("\n4) the Settings card");
{
  const h = miniLucidCardHtml("sometimes", (s) => s, "", "large", true);
  if (!h.includes('id="mascotShown"') || h.includes('id="mascotShown" checked')) fail("a hidden mascot shows an unchecked show switch");
  for (const p of MINI_PRESENCES) if (!h.includes(`name="miniPresence" value="${p}"`)) fail(`missing presence ${p}`);
  for (const z of MASCOT_SIZES) if (!h.includes(`name="mascotSize" value="${z}"`)) fail(`missing size ${z}`);
  const rows = h.match(/<label class="set-toggle"><input [^>]*\/>\s*<span>.*?<\/span><\/label>/gs)?.length ?? 0;
  if (rows !== 1 + MINI_PRESENCES.length + MASCOT_SIZES.length) fail(`every row is an input and one span (got ${rows})`);
  ok("show switch, Off / Sometimes / Always, Small / Large (classic), each row one span (invariant 11)");
}

console.log("\n5) he wears the color theme");
{
  if (mascotPaletteFor("lucid-dark", "#c64bd6", "#7d39c4") !== MASCOT_PALETTE) fail("Lucid Dark keeps the brand green");
  const ember = mascotPaletteFor("ember", "#f2653a", "#b8401f");
  if (ember.G !== "#f2653a" || ember.g !== "#b8401f") fail("Ember's accent goes on the headband and belt");
  if (ember.S !== MASCOT_PALETTE.S || ember.W !== MASCOT_PALETTE.W) fail("skin and eyes keep their contrast");
  if (mascotPaletteFor("ember", "", "") !== MASCOT_PALETTE) fail("an unreadable accent falls back to the brand palette");
  ok(`Ember: headband ${ember.G}, gi ${ember.K}; Lucid Dark: headband ${MASCOT_PALETTE.G}`);
}

console.log("\ndemo_p_mini_3 OK - Lucid is off on the prompt bar until turned on, a right-click turns him off with a way back, he is mini Lucid's size by default with the classic size kept, and he wears the color theme.");
process.exit(0);
