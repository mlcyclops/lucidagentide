// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_worlds_store_1.mjs
//
// P-WORLDS.STORE1: real-browser proof for the worlds store in the Plugins drawer. Before the fix, Visualize's
// Worlds > Get more worlds opened the Preview panel just to anchor the drawer: the panel flew out behind the drawer
// and stayed open after the drawer's X closed it. In a wide (1600x1000) and a narrow (1100x800) window this script
// drives the real controls with real mouse input and asserts, with document.elementFromPoint (what the user sees):
//   1. Get more worlds opens the drawer and the Preview panel stays CLOSED; the drawer sits in the work area
//      (below the title bar, above the status bar, right of the rail) and its X is the topmost thing at its center;
//   2. PREMIUM lists the Lucid Agent World Packs first (Patron Class, Sponsor), then the Lucid Agent Worlds, then
//      Civilian and Government; every world card has a video.plg-loop whose data-src ends in -loop.mp4;
//   3. scrolled into view, the first world's loop is decoding and playing (skipped, with the reason, when its media
//      file is not shipped yet or the page prefers reduced motion);
//   4. the Sponsor picker: 29 world tiles, Continue enabled only at exactly 6, then the license sheet carries the
//      picks. When the QA engine is signed in with a provider, Buy on the Sponsor card opens it; otherwise the
//      picker markup from plugins_flyout.ts is mounted in the live drawer, where the real controller drives it;
//   5. auditBoxes (demo_p_spacing_1.mjs) passes on the drawer and on the picker;
//   6. the drawer's X, and on a second open Escape, close ONLY the drawer: Preview is still closed after both.
// The caller owns the page, engine and browser lifecycle; run it against an isolated QA engine or a second
// instance, never a user's working session. The window size override is cleared afterwards.
//
// Run (bun, so the picker markup can be imported from the renderer source):
//   LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/ bun desktop/scripts/demo_p_worlds_store_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const PACKS_HEADING = "Lucid Agent World Packs";
const SECTION_ORDER = [PACKS_HEADING, "Lucid Agent Worlds", "Civilian", "Government"];
const PACK_IDS = ["bundle-patron", "bundle-sponsor"];
const PICKS = 6;

export async function verifyWorldsStore(page) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const results = [];
  const previewOpen = () => page.evaluate(() => { const p = document.querySelector("#preview"); return !!p && !p.hidden && p.getBoundingClientRect().width > 0; });
  const drawerOpen = () => page.evaluate(() => { const d = document.querySelector(".plg-layer .plg-drawer"); return !!d && d.getBoundingClientRect().width > 0; });
  const center = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width }; });
  const topmost = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
  const clickReal = async (sel, what) => {
    const c = await center(sel);
    assert(c.w > 0, `${what} is not visible`);
    assert(await topmost(sel), `${what} is covered (elementFromPoint at its center hits something else)`);
    await page.mouse.click(c.x, c.y);
  };
  const dismissToasts = async () => { for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {}); await pause(300); };
  const audit = async (sel, where) => {
    const found = await page.evaluate(auditBoxes, sel, MIN_GAP);
    assert(found.length === 0, `${where} spacing: ${found.join("; ")}`);
  };

  // Get more worlds from Visualize's Worlds menu, exactly as the user reaches the store.
  const openFromVisualize = async (label) => {
    if (await drawerOpen()) { await page.keyboard.press("Escape"); await pause(400); }
    // Get more worlds closes Visualize on its way to the store, so every pass opens it again.
    const vizOpen = await page.$eval("#vizView", (v) => !v.hidden && v.getBoundingClientRect().width > 0).catch(() => false);
    if (!vizOpen) await page.click("#ctViz");
    await page.waitForSelector("#vizView [data-viz-worlds]", { visible: true, timeout: 15000 });
    await pause(600);
    await dismissToasts();
    if (!(await page.$("[data-viz-worlds-menu]"))) await clickReal("#vizView [data-viz-worlds]", `${label}: the Worlds button`);
    await page.waitForSelector("[data-viz-world-store]", { visible: true, timeout: 5000 });
    await clickReal("[data-viz-world-store]", `${label}: Get more worlds`);
    await page.waitForFunction(() => document.querySelector(".plg-layer.plg-in .plg-drawer"), { timeout: 5000 })
      .catch(() => { throw new Error(`${label}: Get more worlds did not open the Plugins drawer`); });
    await pause(500); // the drawer slides in
    await dismissToasts();
  };

  const cdp = await page.target().createCDPSession();
  try {
    for (const size of SIZES) {
      const label = `${size.name} ${size.width}x${size.height}`;
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      await pause(500);
      if (await previewOpen()) { await page.click("#prevClose"); await pause(400); }
      assert(!(await previewOpen()), `${label}: could not start with the Preview panel closed`);
      const entry = { size: label };

      // 1. the drawer opens on its own, in the work area, with a reachable X
      await openFromVisualize(label);
      assert(!(await previewOpen()), `${label}: Get more worlds opened the Preview panel (it must stay closed; the drawer anchors to the work area)`);
      const box = await page.evaluate(() => {
        const r = (s) => { const n = document.querySelector(s); if (!n) return null; const b = n.getBoundingClientRect(); return b.width > 0 ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom } : null; };
        return { drawer: r(".plg-drawer"), title: r(".titlebar"), status: r("#statusbar"), rail: r(".rail"), vw: innerWidth, vh: innerHeight };
      });
      const d = box.drawer;
      assert(d && d.left >= 0 && d.right <= box.vw + 1 && d.top >= 0 && d.bottom <= box.vh + 1, `${label}: drawer off screen ${JSON.stringify(d)}`);
      assert(Math.abs(d.right - box.vw) <= 1, `${label}: with Preview closed the drawer must sit on the right edge (right ${d.right}, window ${box.vw})`);
      if (box.title) assert(d.top >= box.title.bottom - 1, `${label}: drawer runs under the title bar (${d.top} < ${box.title.bottom})`);
      if (box.status) assert(d.bottom <= box.status.top + 1, `${label}: drawer runs under the status bar (${d.bottom} > ${box.status.top})`);
      if (box.rail) assert(d.left >= box.rail.right - 1, `${label}: drawer slides under the left rail (${d.left} < ${box.rail.right})`);
      assert(await topmost("[data-plg-close]"), `${label}: the drawer's X is covered`);
      entry.drawer = { left: Math.round(d.left), top: Math.round(d.top), width: Math.round(d.right - d.left), height: Math.round(d.bottom - d.top) };

      // 2. packs first, then worlds; world cards carry their loops
      if (!(await page.$('[data-plg-tier="premium"][aria-selected="true"]'))) { await clickReal('[data-plg-tier="premium"]', `${label}: the Premium tab`); await pause(300); }
      const layout = await page.evaluate(() => {
        const secs = [...document.querySelectorAll("#plgBody .plg-sec")];
        const first = secs[0];
        return {
          headings: secs.map((s) => s.querySelector(".plg-h")?.textContent?.trim() ?? ""),
          firstCards: first ? [...first.querySelectorAll("[data-plg-card]")].map((c) => c.dataset.plgCard) : [],
          worlds: [...document.querySelectorAll('#plgBody [data-plg-card^="world-"]')].map((c) => {
            const v = c.querySelector("video.plg-loop");
            return { id: c.dataset.plgCard, src: v?.dataset.src ?? null };
          }),
        };
      });
      assert(layout.headings[0] === PACKS_HEADING, `${label}: the first section is "${layout.headings[0]}", not "${PACKS_HEADING}"`);
      assert(JSON.stringify(layout.headings) === JSON.stringify(SECTION_ORDER), `${label}: section order ${JSON.stringify(layout.headings)}`);
      assert(JSON.stringify(layout.firstCards) === JSON.stringify(PACK_IDS), `${label}: the packs section holds ${JSON.stringify(layout.firstCards)}`);
      assert(layout.worlds.length === 29, `${label}: ${layout.worlds.length} world cards, expected 29`);
      const noLoop = layout.worlds.filter((w) => !w.src || !w.src.endsWith(`${w.id}-loop.mp4`));
      assert(noLoop.length === 0, `${label}: world cards without their loop: ${noLoop.map((w) => w.id).join(", ")}`);
      for (const id of PACK_IDS) {
        const src = await page.$eval(`[data-plg-card="${id}"]`, (c) => c.querySelector("video.plg-loop")?.dataset.src ?? "");
        assert(src.endsWith(`${id}-loop.mp4`), `${label}: the ${id} card has no collage loop`);
      }
      await audit("#plgDrawer", `${label} drawer (top)`);

      // 3. the first world's loop plays once it is on screen
      const first = layout.worlds[0].id;
      const media = await page.evaluate(async (id) => {
        const card = document.querySelector(`[data-plg-card="${id}"]`);
        card.scrollIntoView({ block: "center" });
        const v = card.querySelector("video.plg-loop");
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        // GET, not HEAD: the engine's static route may answer only GET; the body is dropped unread.
        // A missing file must not pass as an HTML fallback page answered with 200.
        const head = await fetch(v.dataset.src).then((r) => { void r.body?.cancel(); return r.ok && !/html/i.test(r.headers.get("content-type") ?? ""); }).catch(() => false);
        return { reduced, present: head, src: v.dataset.src };
      }, first);
      if (media.reduced) entry.loop = `SKIPPED: the page prefers reduced motion, so ${first} shows its poster by design`;
      else if (!media.present) entry.loop = `SKIPPED: ${media.src} is not shipped yet (media worker still generating it)`;
      else {
        const playing = await page.waitForFunction((id) => {
          const v = document.querySelector(`[data-plg-card="${id}"] video.plg-loop`);
          return v && v.readyState >= 2 && !v.paused;
        }, { timeout: 8000 }, first).then(() => true).catch(() => false);
        const state = await page.$eval(`[data-plg-card="${first}"] video.plg-loop`, (v) => ({ readyState: v.readyState, paused: v.paused, src: v.getAttribute("src") }));
        assert(playing, `${label}: ${first}'s loop is not playing on screen: ${JSON.stringify(state)}`);
        entry.loop = `${first} playing (readyState ${state.readyState})`;
      }
      await audit("#plgDrawer", `${label} drawer (worlds)`);

      // 4. the Sponsor picker
      await page.$eval("#plgBody", (b) => { b.scrollTop = 0; });
      await pause(300);
      const sponsorKind = await page.$eval('[data-plg-act="bundle-sponsor"]', (b) => b.dataset.kind);
      if (sponsorKind === "buy") {
        await clickReal('[data-plg-act="bundle-sponsor"]', `${label}: Buy on the Sponsor card`);
        entry.picker = "opened by Buy on the Sponsor card (signed-in provider)";
      } else {
        // Not signed in on this QA engine: mount the real picker markup in the live drawer. Its clicks go through the
        // drawer's own controller (togglePick, continuePicks), exactly like a sheet the controller showed itself.
        const flyout = await import("../renderer/plugins_flyout.ts");
        const catalog = await import("../renderer/plugin_catalog.ts");
        const worlds = catalog.PREMIUM_PLUGINS.filter(catalog.isWorldPlugin);
        const html = flyout.sponsorPickerSheetHtml(worlds, new Set());
        await page.evaluate((markup) => {
          const scrim = document.createElement("div");
          scrim.className = "plg-sheet-scrim";
          scrim.innerHTML = markup;
          document.querySelector(".plg-drawer").append(scrim);
        }, html);
        entry.picker = `mounted from plugins_flyout.ts (Sponsor card says "${sponsorKind}": no signed-in provider on this engine)`;
      }
      await page.waitForSelector(".plg-sheet [data-plg-pickgrid]", { visible: true, timeout: 4000 });
      const tiles = await page.$$eval(".plg-sheet [data-plg-pick]", (ts) => ts.map((t) => ({ id: t.dataset.plgPick, disabled: t.disabled })));
      assert(tiles.length === 29, `${label}: the picker shows ${tiles.length} worlds, expected 29`);
      const free = tiles.filter((t) => !t.disabled).map((t) => t.id);
      assert(free.length >= PICKS + 1, `${label}: only ${free.length} worlds can be picked`);
      const goDisabled = () => page.$eval(".plg-sheet [data-plg-picks-go]", (b) => b.disabled);
      const count = () => page.$eval(".plg-sheet [data-plg-pickcount]", (n) => n.textContent.trim());
      assert(await goDisabled(), `${label}: Continue is enabled before any pick`);
      for (let i = 0; i < PICKS; i++) {
        const sel = `.plg-sheet [data-plg-pick="${free[i]}"]`;
        await page.$eval(sel, (t) => t.scrollIntoView({ block: "nearest" }));
        await clickReal(sel, `${label}: the ${free[i]} tile`);
        await pause(80);
        if (i < PICKS - 1) assert(await goDisabled(), `${label}: Continue enabled at ${i + 1} picks`);
      }
      assert((await count()) === `${PICKS} of ${PICKS} picked`, `${label}: the counter says "${await count()}"`);
      assert(!(await goDisabled()), `${label}: Continue is still disabled at exactly ${PICKS} picks`);
      // a seventh pick is refused while full
      const seventh = `.plg-sheet [data-plg-pick="${free[PICKS]}"]`;
      await page.$eval(seventh, (t) => t.scrollIntoView({ block: "nearest" }));
      await clickReal(seventh, `${label}: a seventh tile`);
      assert((await page.$eval(seventh, (t) => t.getAttribute("aria-pressed"))) === "false", `${label}: a seventh world was picked`);
      await audit(".plg-sheet", `${label} picker`);
      await clickReal(".plg-sheet [data-plg-picks-go]", `${label}: Continue`);
      await page.waitForSelector(".plg-sheet [data-plg-checkout]", { visible: true, timeout: 3000 });
      const carried = await page.$eval(".plg-sheet [data-plg-checkout]", (b) => b.dataset.plgPicks ?? "");
      assert(carried === free.slice(0, PICKS).join(","), `${label}: the license sheet carries picks "${carried}"`);
      await page.keyboard.press("Escape");
      await pause(250);
      assert(!(await page.$(".plg-sheet")), `${label}: Escape did not close the sheet`);
      assert(await drawerOpen(), `${label}: Escape on the sheet closed the drawer too`);

      // 6. X closes only the drawer
      await dismissToasts();
      await clickReal("[data-plg-close]", `${label}: the drawer's X`);
      await page.waitForFunction(() => !document.querySelector(".plg-layer"), { timeout: 3000 })
        .catch(() => { throw new Error(`${label}: the drawer's X did not close the drawer`); });
      assert(!(await previewOpen()), `${label}: the Preview panel is open after the drawer's X`);

      // ... and so does Escape
      await openFromVisualize(label);
      assert(!(await previewOpen()), `${label}: the second Get more worlds opened the Preview panel`);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".plg-layer"), { timeout: 3000 })
        .catch(() => { throw new Error(`${label}: Escape did not close the drawer`); });
      assert(!(await previewOpen()), `${label}: the Preview panel is open after Escape closed the drawer`);
      results.push(entry);
    }
  } finally {
    if (await drawerOpen().catch(() => false)) await page.keyboard.press("Escape").catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_worlds_store_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyWorldsStore(page), null, 2));
    console.log("P-WORLDS.STORE1 passed: Get more worlds opens the drawer without the Preview panel, packs then worlds lead PREMIUM with their loops, the Sponsor picker takes exactly 6, and X and Escape close only the drawer, wide and narrow.");
  } finally { await browser.disconnect(); }
}
