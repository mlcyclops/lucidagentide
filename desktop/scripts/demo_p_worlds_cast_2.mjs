// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_worlds_cast_2.mjs
//
// P-WORLDS.CAST2 (ADR-0650): real-browser proof that cast customization works and persists. On the ?vizDemo=1
// feed (Main, demo-1 to demo-6, subagents) with a world installed, starting from no saved key, with real input:
//   1. the world is drawn and every agent figure carries the balanced cast (the read-only demo probe);
//   2. the View menu's Cast section (docked under the header) passes the spacing audit; picking a skin shade, the
//      warm undertone and a fashion hair color switches the fleet to "Same for all", and every agent figure is
//      rebuilt with exactly those (the skin hex is the pressed swatch's color);
//   3. a click on demo-2 opens its panel; "Customize look" opens the look menu (floating beside the panel), which
//      passes the spacing audit; pinning feminine, a light shade, the bob and blonde rebuilds demo-2 with that
//      look while the others keep the fleet's;
//   4. the page reloads (a restart of the renderer): Visualize opens on the same world, lucid.viz.cast.v1 holds
//      the same preferences, demo-2 keeps its pinned look, the others keep the fleet's, and the View menu shows
//      the saved shade pressed.
// It removes the key and reloads again at the end, so other demos see the default cast. The caller owns the page
// and the engine. LUCID_DEMO_WORLD_KEY picks the world ("christmas"); default: the first usable one.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 [LUCID_DEMO_WORLD_KEY=<key>] node desktop/scripts/demo_p_worlds_cast_2.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const CAST_KEY = "lucid.viz.cast.v1";
const AGENTS = ["demo-1", "demo-2", "demo-3", "demo-4", "demo-5", "demo-6"];
const PINNED = "demo-2";
const FLEET_SKIN = "8"; // Mocha
const PIN_SKIN = "1"; // Ivory

export async function verifyCastCustomization(page, worldKey = null) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  const probe = (fn, ...args) => page.evaluate((f, a) => window.__vizProbe?.[f]?.(...a), fn, args);
  const topmost = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
  const clickTop = async (sel) => {
    await page.waitForSelector(sel, { visible: true, timeout: 5000 });
    await page.$eval(sel, (n) => n.scrollIntoView({ block: "nearest" }));
    assert(await topmost(sel), `${sel} is covered`);
    await page.click(sel);
  };
  const casts = async () => {
    const nodes = (await probe("nodes")) ?? [];
    return Object.fromEntries(AGENTS.map((id) => [id, nodes.find((n) => n.id === id)?.cast ?? null]));
  };
  const audit = async (rootSel, where) => {
    const found = await page.evaluate(auditBoxes, rootSel, MIN_GAP);
    assert(found.length === 0, `${where} spacing: ${found.join("; ")}`);
  };

  /** Open Visualize (after a load), close boot toasts, and make sure the world is drawn. */
  const openOnWorld = async () => {
    await page.waitForSelector("#ctViz", { timeout: 20000 });
    if (!(await page.$("#vizView [data-viz-ledger]"))) await page.click("#ctViz");
    await page.waitForSelector("#vizView [data-viz-worlds]", { visible: true, timeout: 15000 });
    await pause(1500);
    for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});
    await pause(400);
    let world = null;
    for (let i = 0; i < 40 && !world; i++) {
      const ws = (await probe("worlds")) ?? [];
      world = ws.find((w) => !w.error && w.access === "allowed" && (!worldKey || w.style === `world:${worldKey}`)) ?? null;
      if (!world) await pause(500);
    }
    assert(world, `no usable installed world${worldKey ? ` "${worldKey}"` : ""}: ${JSON.stringify(await probe("worlds"))}`);
    const label = () => page.evaluate(() => document.querySelector("#vizView [data-viz-worlds-label]")?.textContent?.trim());
    for (let i = 0; i < 6 && (await label()) !== world.label; i++) {
      if (i >= 2) { // the saved world did not come back on its own: pick it like a user
        if (!(await page.$(`[data-viz-world-pick="${world.style}"]`))) await page.click("#vizView [data-viz-worlds]");
        await clickTop(`[data-viz-world-pick="${world.style}"]`);
      }
      await pause(1500);
    }
    assert((await label()) === world.label, `the Worlds button does not show the world (${await label()} vs ${world.label})`);
    for (let i = 0; i < 20 && Object.values(await casts()).some((c) => !c); i++) await pause(500);
    return world;
  };

  // 0. start from no saved key (the migration path)
  await page.evaluate((k) => localStorage.removeItem(k), CAST_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  const world = await openOnWorld();
  const balanced = await casts();
  assert(Object.values(balanced).every(Boolean), `the world casts agents as creatures or the probe has no cast: ${JSON.stringify(balanced)}`);
  assert((await probe("castPrefs"))?.fleet?.mode === "balanced", "with no key the fleet is not Balanced fleet");
  assert(new Set(Object.values(balanced).map((c) => c.skin)).size > 1, "the balanced fleet already shares one skin");

  // 2. the Cast section: pick a shade, the warm undertone and a fashion hair color
  await clickTop("#vizView [data-viz-viewmenu]");
  await page.waitForSelector('[data-viz-cast="skin"]', { visible: true, timeout: 5000 });
  await audit("[data-viz-cast-slot]", "Cast section (balanced)");
  await clickTop(`[data-viz-cast="skin"][data-value="${FLEET_SKIN}"]`);
  await pause(300);
  await clickTop('[data-viz-cast="undertone"][data-value="warm"]');
  await pause(300);
  const fashion = await page.$$eval('[data-viz-cast="hairColor"]', (bs) => bs.map((b) => b.dataset.value));
  assert(fashion.length === 14, `the hair-color ramp has ${fashion.length} swatches, not 8 natural plus 6 fashion`);
  const fleetHair = fashion[10];
  await clickTop(`[data-viz-cast="hairColor"][data-value="${fleetHair}"]`);
  await pause(800);
  const pressed = await page.$eval(`[data-viz-cast="skin"][data-value="${FLEET_SKIN}"]`, (b) => ({ on: b.getAttribute("aria-pressed"), hex: b.style.getPropertyValue("--sw").trim() }));
  assert(pressed.on === "true", "the picked skin shade is not pressed");
  assert(await page.$eval('[data-viz-cast="mode"][data-value="same"]', (b) => b.getAttribute("aria-pressed") === "true"), "picking a shade did not switch to Same for all");
  await audit("[data-viz-cast-slot]", "Cast section (same for all)");
  const same = await casts();
  for (const id of AGENTS) {
    const c = same[id];
    assert(c && c.skinIndex === Number(FLEET_SKIN) && c.skin === pressed.hex && c.hairColor === fleetHair, `${id} was not rebuilt with the fleet's look: ${JSON.stringify(c)} (want ${pressed.hex}, ${fleetHair})`);
  }
  await page.keyboard.press("Escape");
  await pause(300);
  if (await page.$("[data-viz-cast-slot]")) await page.click("#vizView [data-viz-viewmenu]");
  await pause(300);

  // 3. Customize look on demo-2
  await clickTop("#vizView [data-viz-fit]"); // frames everyone and takes the camera off auto: a still target
  await pause(2500);
  const box = ((await probe("nodes")) ?? []).find((n) => n.id === PINNED)?.box ?? null;
  assert(box, `${PINNED} is not on screen`);
  await page.mouse.click(box.x, box.y);
  await page.waitForSelector(`#vizView [data-viz-look-open="${PINNED}"]`, { visible: true, timeout: 5000 });
  await clickTop(`#vizView [data-viz-look-open="${PINNED}"]`);
  await page.waitForSelector("[data-viz-look-root] [data-viz-look]", { visible: true, timeout: 5000 });
  await audit("[data-viz-look-root]", "Customize look");
  await clickTop('[data-viz-look="presentation"][data-value="feminine"]');
  await pause(300);
  await clickTop(`[data-viz-look="skin"][data-value="${PIN_SKIN}"]`);
  await pause(300);
  await clickTop('[data-viz-look="hair"][data-value="bob"]');
  await pause(300);
  const blonde = await page.$$eval('[data-viz-look="hairColor"]', (bs) => bs.map((b) => b.dataset.value)[6]);
  await clickTop(`[data-viz-look="hairColor"][data-value="${blonde}"]`);
  await pause(800);
  const pinHex = await page.$eval(`[data-viz-look="skin"][data-value="${PIN_SKIN}"]`, (b) => b.style.getPropertyValue("--sw").trim());
  await audit("[data-viz-look-root]", "Customize look (pinned)");
  const want = { presentation: "feminine", skinIndex: Number(PIN_SKIN), skin: pinHex, hair: "bob", hairColor: blonde };
  const matches = (c, w) => !!c && Object.entries(w).every(([k, v]) => c[k] === v);
  const pinnedNow = await casts();
  assert(matches(pinnedNow[PINNED], want), `${PINNED} was not rebuilt with its pinned look: ${JSON.stringify(pinnedNow[PINNED])} (want ${JSON.stringify(want)})`);
  for (const id of AGENTS) if (id !== PINNED) assert(pinnedNow[id]?.skin === pressed.hex, `pinning ${PINNED} changed ${id}`);
  const saved = await probe("castPrefs");
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), CAST_KEY);
  assert(JSON.stringify(stored) === JSON.stringify(saved), `localStorage ${CAST_KEY} does not hold what is in effect`);
  await page.keyboard.press("Escape");
  await pause(300);

  // 4. restart: the looks come back from lucid.viz.cast.v1
  await page.reload({ waitUntil: "domcontentloaded" });
  await openOnWorld();
  const after = await casts();
  assert(JSON.stringify(await probe("castPrefs")) === JSON.stringify(saved), `after a reload the preferences differ: ${JSON.stringify(await probe("castPrefs"))}`);
  assert(matches(after[PINNED], want), `after a reload ${PINNED} lost its look: ${JSON.stringify(after[PINNED])}`);
  for (const id of AGENTS) {
    if (id === PINNED) continue;
    const c = after[id];
    assert(c && c.skin === pressed.hex && c.skinIndex === Number(FLEET_SKIN) && c.hairColor === fleetHair, `after a reload ${id} lost the fleet's look: ${JSON.stringify(c)}`);
  }
  await clickTop("#vizView [data-viz-viewmenu]");
  await page.waitForSelector('[data-viz-cast="skin"]', { visible: true, timeout: 5000 });
  assert(await page.$eval(`[data-viz-cast="skin"][data-value="${FLEET_SKIN}"]`, (b) => b.getAttribute("aria-pressed") === "true"), "after a reload the saved shade is not pressed");
  await audit("[data-viz-cast-slot]", "Cast section (after reload)");
  await page.keyboard.press("Escape");

  assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  return { world: world.id, fleet: saved.fleet, pinned: saved.pinned, figures: after };
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_worlds_cast_2.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL (an isolated QA page at <engine>/?vizDemo=1 with a world installed).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  let page = null;
  try {
    page = (await browser.pages()).find((p) => p.url() === url) ?? null;
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyCastCustomization(page, process.env.LUCID_DEMO_WORLD_KEY || null), null, 2));
    console.log("P-WORLDS.CAST2 passed: a picked skin shade, undertone and hair color dressed the whole fleet, a pinned look dressed one agent, and both came back after a reload.");
  } finally {
    // leave the QA page on the default cast
    if (page) { await page.evaluate((k) => localStorage.removeItem(k), CAST_KEY).catch(() => {}); await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {}); }
    await browser.disconnect();
  }
}
