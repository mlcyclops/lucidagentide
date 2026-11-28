// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_plugins_premium_2.mjs
//
// P-PLUGINS.PREMIUM2 (ADR-0699): real-UI proof of the Plugins drawer changes, against
// an isolated QA engine, in a wide (1600x1000) and a narrow (1100x800) window:
//   1. a real click on the left rail's Plugins button opens the drawer on PREMIUM, also after FREE was the last tab;
//   2. the Lucid Agent Worlds show exactly two full rows at the drawer's column count, the rest folded; the toggle
//      under them ("Show all N worlds") is topmost, a real click unfolds every world, a second folds them again; the
//      Civilian apps follow the folded worlds; a search lists every matching world with no fold and no toggle;
//   3. the LUCID Meeting Hub card reads "$9.99/mo per license" with a topmost "Request a quote" (an https link), and the
//      Tactical GenAI Trainer card reads "$9.99/mo"; auditBoxes is clean on both cards and on the toggle.
// The old bundle fails at step 1 (the rail button opened FREE).
//
// Setup (never a user's session): bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811, then the QA page open in a
// browser with remote debugging.
// Run: LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_plugins_premium_2.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const GATES = "#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

export async function verifyPremium2(page, base) {
  const until = async (read, what, ms = 10_000) => {
    for (const end = Date.now() + ms; ; await pause(150)) {
      const v = await read();
      if (v) return v;
      assert(Date.now() < end, what);
    }
  };
  const rect = (sel) => page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
  }, sel);
  /** A real click at the control's center, after scrolling it into view and proving the click would land on it. */
  const click = async (sel, what) => {
    await page.$eval(sel, (e) => e.scrollIntoView({ block: "center" })).catch(() => {});
    await pause(250);
    const r = await until(() => rect(sel), `${what} is not on screen`, 4000);
    const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
    const hit = await page.evaluate((px, py, s) => !!document.elementFromPoint(px, py)?.closest(s), x, y, sel);
    assert(hit, `${what} is covered at its center`);
    await page.mouse.click(x, y);
  };
  const topmost = async (sel, what) => {
    await page.$eval(sel, (e) => e.scrollIntoView({ block: "center" }));
    await pause(250);
    const r = await rect(sel);
    assert(r, `${what} is not on screen`);
    const hit = await page.evaluate((px, py, s) => !!document.elementFromPoint(px, py)?.closest(s), (r.left + r.right) / 2, (r.top + r.bottom) / 2, sel);
    assert(hit, `${what} is covered at its center`);
  };
  const audit = async (sel, what) => {
    const bad = await page.evaluate(auditBoxes, sel, MIN_GAP);
    assert(bad.length === 0, `${what}: auditBoxes: ${bad.join(" | ")}`);
  };
  const selectedTab = () => page.evaluate(() => document.querySelector('.plg-drawer [data-plg-tier][aria-selected="true"]')?.getAttribute("data-plg-tier") ?? null);
  const worlds = () => page.evaluate(() => {
    const grid = document.querySelector("#plgWorldsGrid");
    if (!grid) return null;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;
    const cards = [...grid.children];
    const shown = cards.filter((c) => c.getClientRects().length > 0).length;
    const more = document.querySelector("[data-plg-worlds-more]");
    return { cols, total: cards.length, shown, more: more && more.getClientRects().length > 0 ? { text: more.textContent?.trim(), expanded: more.getAttribute("aria-expanded") } : null };
  });
  const closeDrawer = async () => { await page.keyboard.press("Escape"); await until(async () => !(await rect(".plg-drawer")), "the drawer did not close", 4000); await pause(300); };

  const cdp = await page.target().createCDPSession();
  const setSize = async (s) => { await cdp.send("Emulation.setDeviceMetricsOverride", { width: s.width, height: s.height, deviceScaleFactor: 0, mobile: false }); await pause(600); };
  const results = [];
  try {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#railMarket", { timeout: 30_000 });
    for (let i = 0, idle = 0; i < 40 && idle < 6; i++) { const s = await page.$(GATES); if (!s) { idle++; await pause(400); continue; } idle = 0; await s.click().catch(() => {}); await pause(400); }
    await pause(1500);
    for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});

    for (const size of SIZES) {
      await setSize(size);
      // 1. the rail button lands on Premium, also after Free was the last tab
      await click("#railMarket", `${size.name}: the rail's Plugins button`);
      await until(() => rect(".plg-drawer"), `${size.name}: the drawer did not open`);
      assert((await selectedTab()) === "premium", `${size.name}: the drawer opened on ${await selectedTab()}, not Premium`);
      await click('.plg-drawer [data-plg-tier="free"]', `${size.name}: the Free tab`);
      await until(async () => (await selectedTab()) === "free", `${size.name}: Free did not take`);
      await closeDrawer();
      await click("#railMarket", `${size.name}: the rail's Plugins button`);
      await until(() => rect(".plg-drawer"), `${size.name}: the drawer did not open again`);
      assert((await selectedTab()) === "premium", `${size.name}: after Free, the drawer reopened on ${await selectedTab()}`);

      // 2. two full rows of worlds, the rest folded; the toggle unfolds and folds
      const w = await until(worlds, `${size.name}: no Lucid Agent Worlds grid`);
      assert(w.shown === Math.min(w.total, 2 * w.cols), `${size.name}: ${w.shown} worlds shown at ${w.cols} columns, not ${2 * w.cols}`);
      assert(w.more && w.more.text === `Show all ${w.total} worlds` && w.more.expanded === "false", `${size.name}: the toggle reads ${JSON.stringify(w.more)}`);
      const civAfter = await page.evaluate(() => {
        const t = document.querySelector("[data-plg-worlds-more]")?.getBoundingClientRect(), c = document.querySelector("#plgSecCiv")?.getBoundingClientRect();
        return t && c ? Math.round(c.top - t.bottom) : null;
      });
      assert(civAfter !== null && civAfter >= 0 && civAfter < 120, `${size.name}: the Civilian apps do not follow the folded worlds (${civAfter} px below the toggle)`);
      await topmost("[data-plg-worlds-more]", `${size.name}: the worlds toggle`);
      await audit("#plgSecWorlds", `${size.name}: the worlds heading`);
      await click("[data-plg-worlds-more]", `${size.name}: Show all worlds`);
      const open = await until(async () => { const v = await worlds(); return v?.shown === v?.total ? v : null; }, `${size.name}: Show all did not unfold every world`);
      assert(open.more?.text === "Show fewer worlds" && open.more.expanded === "true", `${size.name}: unfolded toggle reads ${JSON.stringify(open.more)}`);
      await click("[data-plg-worlds-more]", `${size.name}: Show fewer worlds`);
      await until(async () => (await worlds())?.shown === 2 * w.cols, `${size.name}: Show fewer did not fold the worlds back`);

      // 3. the two monthly apps
      const meta = (id) => page.$eval(`[data-plg-card="${id}"] .plg-meta`, (e) => e.textContent?.trim());
      assert((await meta("lucid-meeting-hub")) === "$9.99/mo per license", `${size.name}: Meeting Hub reads ${await meta("lucid-meeting-hub")}`);
      assert((await meta("tactical-genai-trainer")) === "$9.99/mo", `${size.name}: the Trainer reads ${await meta("tactical-genai-trainer")}`);
      const quote = '[data-plg-card="lucid-meeting-hub"] [data-plg-ext]';
      assert((await page.$eval(quote, (e) => e.textContent?.trim())) === "Request a quote", `${size.name}: no Request a quote on the Meeting Hub card`);
      assert((await page.$eval(quote, (e) => e.getAttribute("data-plg-ext") ?? "")).startsWith("https://"), `${size.name}: the quote link is not https`);
      assert(!(await page.$('[data-plg-card="tactical-genai-trainer"] [data-plg-ext]')), `${size.name}: the Trainer card offers a quote`);
      await topmost(quote, `${size.name}: Request a quote`);
      await audit('[data-plg-card="lucid-meeting-hub"]', `${size.name}: the Meeting Hub card`);
      await audit('[data-plg-card="tactical-genai-trainer"]', `${size.name}: the Trainer card`);

      // a search lists every matching world, with no fold and no toggle
      await click(".plg-drawer .plg-search", `${size.name}: the search box`);
      await page.keyboard.type("world");
      const found = await until(async () => { const v = await worlds(); return v && !v.more && v.shown === v.total ? v : null; }, `${size.name}: a search still folds the worlds`);
      await page.$eval(".plg-drawer .plg-search", (e) => { e.value = ""; e.dispatchEvent(new Event("input", { bubbles: true })); });
      results.push({ size: size.name, landing: "premium", worlds: `${w.shown} of ${w.total} at ${w.cols} columns, toggle unfolds and folds`, search: `${found.shown} worlds unfolded`, prices: "Meeting Hub $9.99/mo per license + quote, Trainer $9.99/mo" });
      await closeDrawer();
    }
  } finally {
    if (await rect(".plg-drawer").catch(() => null)) await page.keyboard.press("Escape").catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_plugins_premium_2.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const url = process.env.LUCID_DEMO_URL;
  if ((!endpoint && !browserURL) || !url) throw new Error("Set LUCID_DEMO_CDP_URL (or LUCID_DEMO_BROWSER_URL) and LUCID_DEMO_URL.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(endpoint ? { browserWSEndpoint: endpoint } : { browserURL }), defaultViewport: null, protocolTimeout: 120_000 });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url));
    if (!page) throw new Error(`No page at ${url}`);
    console.log(JSON.stringify(await verifyPremium2(page, url), null, 2));
    console.log("ADR-0699 passed: the Plugins drawer lands on Premium, the worlds fold to two rows with a working toggle, and the Meeting Hub and Trainer show their monthly prices (Hub per license with a quote), wide and narrow.");
  } finally { await browser.disconnect(); }
}
