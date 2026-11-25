// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_askplus_1.mjs
//
// P-ASKPLUS.1 (ADR-0632): real-browser regression for the Ask Lucid "+" menu. The menu is a .popover (z 95) and
// Ask Lucid is z 250, so before the fix it opened BEHIND the panel: invisible when docked right or bottom, half
// hidden when floating. For each dock mode this script clicks "+" with real mouse input and proves, with
// document.elementFromPoint (what the user can actually see and click), that:
//   1. every menu row is the topmost element at its own center (not covered by Ask Lucid or anything else);
//   2. the menu sits inside the window and opens ABOVE the "+" (over the chips, not off the panel's edge);
//   3. clicking the Knowledge row opens its picker, also topmost;
//   4. Escape closes only that picker, never the Ask Lucid panel under it;
//   5. when Visualize or the Fleet Orbit is open, it ends where a docked Ask Lucid begins (run once with one open).
// The caller owns the page, first-run setup, engine and browser lifecycle; run it against an isolated QA engine
// or a second instance, never a user's working session. Ask Lucid's dock mode is restored afterwards.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:5329/ node desktop/scripts/demo_p_askplus_1.mjs

export async function verifyAskPlus(page) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const results = [];
  const panelOpen = () => page.evaluate(() => { const d = document.querySelector(".ald"); return !!d && !d.hidden && getComputedStyle(d).display !== "none" && d.getBoundingClientRect().width > 0; });
  if (!(await panelOpen())) await page.click("#tbAskLucid");
  await page.waitForFunction(() => { const d = document.querySelector(".ald"); return d && d.getBoundingClientRect().width > 0; }, { timeout: 5000 });
  const startMode = await page.evaluate(() => document.querySelector(".ald [aria-pressed=\"true\"].ald-tool")?.getAttribute("aria-label") ?? null);

  // Is every row of the open popover (and the popover matching `sel`) the topmost thing at its center?
  const probe = (sel) => page.evaluate((s) => {
    const pop = [...document.querySelectorAll(s)].find((n) => n.classList.contains("show")) ?? document.querySelector(s);
    if (!pop) return null;
    const r = pop.getBoundingClientRect();
    const rows = [...pop.querySelectorAll("[role=menuitem], .cfg-opt, button")].filter((n) => n.getBoundingClientRect().height > 0);
    const covered = rows.map((row) => {
      const b = row.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return pop.contains(hit) ? null : `${row.textContent.trim().slice(0, 30)} under ${hit ? `${hit.tagName}.${hit.className}` : "nothing"}`;
    }).filter(Boolean);
    return { rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, rows: rows.length, covered, z: getComputedStyle(pop).zIndex, vw: innerWidth, vh: innerHeight };
  }, sel);

  try {
    for (const mode of ["Dock right", "Dock bottom", "Float"]) {
      await page.click(`.ald .ald-tool[aria-label="${mode}"]`);
      await pause(450); // the dock animates into its new place
      const plus = await page.$(".ald .al-plus");
      assert(plus, `${mode}: no "+" button`);
      const plusBox = await plus.boundingBox();
      assert(plusBox && plusBox.width > 0, `${mode}: the "+" button is hidden (attachments off by managed policy?)`);
      const hitPlus = await page.evaluate((x, y) => !!document.elementFromPoint(x, y)?.closest(".al-plus"), plusBox.x + plusBox.width / 2, plusBox.y + plusBox.height / 2);
      assert(hitPlus, `${mode}: the "+" button is covered`);
      await page.mouse.click(plusBox.x + plusBox.width / 2, plusBox.y + plusBox.height / 2);
      await page.waitForSelector(".popover.att-menu-pop.show", { visible: true, timeout: 3000 });
      await pause(200);
      const menu = await probe(".popover.att-menu-pop");
      assert(menu && menu.rows >= 1, `${mode}: the menu has no rows`);
      assert(menu.covered.length === 0, `${mode}: menu rows covered: ${menu.covered.join("; ")}`);
      assert(menu.rect.top >= 0 && menu.rect.left >= 0 && menu.rect.right <= menu.vw && menu.rect.bottom <= menu.vh, `${mode}: menu off screen ${JSON.stringify(menu.rect)}`);
      assert(menu.rect.bottom <= plusBox.y, `${mode}: menu did not open above the "+" (${menu.rect.bottom} > ${plusBox.y})`);
      const entry = { mode, menuZ: menu.z, rows: menu.rows, side: "above" };
      // An open full-window view (Visualize, Fleet Orbit) gives way to a docked Ask Lucid instead of hiding
      // its header controls behind it.
      const view = await page.evaluate((m) => {
        const v = [...document.querySelectorAll(".viz-view, .orbit-view")].find((n) => !n.hidden && n.getBoundingClientRect().width > 0);
        if (!v) return null;
        const r = v.getBoundingClientRect(), d = document.querySelector(".ald").getBoundingClientRect();
        return { cls: v.className, clear: m === "Dock right" ? r.right <= d.left + 1 : m === "Dock bottom" ? r.bottom <= d.top + 1 : true };
      }, mode);
      if (view) { assert(view.clear, `${mode}: ${view.cls} runs under the docked Ask Lucid`); entry.view = view.cls; }

      const knowledge = await page.$(".popover.att-menu-pop [data-att-menu]:last-child");
      const label = await knowledge?.evaluate((n) => n.textContent.trim());
      if (label === "Knowledge") {
        await knowledge.click();
        await page.waitForFunction(() => [...document.querySelectorAll(".popover.show")].some((p) => !p.classList.contains("att-menu-pop")), { timeout: 3000 })
          .catch(async () => { throw new Error(`${mode}: the Knowledge picker never opened; popovers: ${await page.evaluate(() => JSON.stringify([...document.querySelectorAll(".popover")].map((p) => [p.className, p.style.zIndex])))}`); });
        await pause(200);
        const picker = await probe(".popover:not(.att-menu-pop)");
        assert(picker && picker.covered.length === 0, `${mode}: Knowledge picker covered: ${picker?.covered.join("; ")}`);
        entry.knowledgeZ = picker.z;
        await page.keyboard.press("Escape");
      } else {
        await page.keyboard.press("Escape");
      }
      await page.waitForFunction(() => !document.querySelector(".popover.show"), { timeout: 3000 })
        .catch(() => { throw new Error(`${mode}: Escape did not close the open menu`); });
      assert(await panelOpen(), `${mode}: Escape closed Ask Lucid instead of only the menu on top of it`);
      results.push(entry);
    }
  } finally {
    await page.evaluate(() => document.querySelectorAll(".popover.show").length).then((n) => n ? page.keyboard.press("Escape") : null).catch(() => {});
    if (startMode) await page.click(`.ald .ald-tool[aria-label="${startMode}"]`).catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_askplus_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyAskPlus(page), null, 2));
    console.log("P-ASKPLUS.1 passed: the Ask Lucid \"+\" menu and its Knowledge picker open above the bar and in front of the panel when docked right, docked bottom and floating.");
  } finally { await browser.disconnect(); }
}
