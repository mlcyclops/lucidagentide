// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_fleet_head_2.mjs
//
// P-FLEET.HEAD2 (ADR-0634): the Fleet window keeps one window control. Close and Minimize both hid the panel
// with the agents still running; Minimize also leaves the status-bar pill, so Close went. With real input this
// proves, in a running LUCID window:
//   1. the header has no Close button and exactly one window control, Minimize, which is on top at its center;
//   2. Minimize hides the panel and leaves the pill, on top at its center; the pill brings the panel back;
//   3. Escape with the More menu open closes only the menu; Escape inside the panel then minimizes it;
//   4. the header passes the spacing audit (auditBoxes, ADR-0633).
// The caller owns the page, engine and browser; run it on a QA engine or a second instance.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/ node desktop/scripts/demo_p_fleet_head_2.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

export async function verifyFleetHeader(page) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shown = () => page.evaluate(() => { const d = document.getElementById("fleetDock"); return !!d && !d.hidden && d.getBoundingClientRect().width > 0; });
  const onTop = (sel) => page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(s);
  }, sel);
  const clickCenter = async (sel) => {
    const box = await (await page.$(sel)).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };

  if (!(await shown())) {
    if (await page.$("#fleetDockPill")) await clickCenter("#fleetDockPill");
    else await page.click("#ctFleet");
    await page.waitForFunction(() => { const d = document.getElementById("fleetDock"); return d && !d.hidden; }, { timeout: 5000 });
  }
  const controls = await page.$$eval("#fleetDock .share-dock-head .share-dock-btn", (bs) => bs.map((b) => b.getAttribute("aria-label")));
  assert(!(await page.$("#fleetDock [data-fleet-close]")), "the Close button is still in the Fleet header");
  assert(controls.length === 1 && controls[0] === "Minimize to pill", `the header's window controls are ${JSON.stringify(controls)}, not just Minimize`);
  assert(await onTop("#fleetDock [data-dock-min]"), "Minimize is covered");
  const spacing = await page.evaluate(auditBoxes, "#fleetDock .share-dock-head", MIN_GAP);
  assert(spacing.length === 0, `Fleet header spacing: ${spacing.join("; ")}`);

  await clickCenter("#fleetDock [data-dock-min]");
  await pause(250);
  assert(!(await shown()), "Minimize did not hide the panel");
  assert(await onTop("#fleetDockPill"), "no clickable pill after Minimize");
  await clickCenter("#fleetDockPill");
  await pause(250);
  assert(await shown(), "the pill did not bring the panel back");

  // with the More menu open, Escape closes only the menu (it is the topmost overlay)
  await clickCenter("#fleetDock [data-fleet-more]");
  await page.waitForSelector(".popover.att-menu-pop.show", { visible: true, timeout: 3000 });
  await page.focus("#fleetDock [data-fleet-more]"); // focus inside the panel: the case where both used to close
  await page.keyboard.press("Escape");
  await pause(250);
  assert(!(await page.$(".popover.show")), "Escape left the More menu open");
  assert(await shown(), "Escape with the More menu open minimized the panel too");

  await page.focus("#fleetDock [data-fleet-more]");
  await page.keyboard.press("Escape");
  await pause(250);
  assert(!(await shown()), "Escape inside the panel did not minimize it");
  await clickCenter("#fleetDockPill");
  await pause(250);
  assert(await shown(), "the pill did not bring the panel back after Escape");
  return { controls, spacing: "clean" };
}

if (process.argv[1]?.endsWith("demo_p_fleet_head_2.mjs")) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyFleetHeader(page)));
    console.log("P-FLEET.HEAD2 passed: one window control (Minimize) in the Fleet header, pill and Escape minimize and restore, header spacing clean.");
  } finally { await browser.disconnect(); }
}
