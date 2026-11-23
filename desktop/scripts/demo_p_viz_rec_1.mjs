// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_viz_rec_1.mjs
//
// P-VIZ.REC1 (ADR-0643): real-browser regression for the Visualize header. Since P-VIZ.5 the header carried
// data-viz-fit (its own width density) and the click router asked closest("[data-viz-fit]") for the Fit button, so
// every click inside the header that the router reached after that check (Record, Recordings, View, and the Auto
// camera checkbox) ran Fit instead: Record never started, Recordings never opened, and Auto camera switched itself
// off. With real mouse input on the ?vizDemo=1 feed this proves:
//   1. checking Auto camera leaves it checked;
//   2. Record starts (the button reads Stop, the REC indicator shows) and Auto camera stays on;
//   3. Stop keeps a clip; Recordings opens a list with Play and Save, topmost at its center;
//   4. Save downloads lucid-visualize-<time>.webm (the anchor download fires with that name);
//   5. View opens its menu.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 node desktop/scripts/demo_p_viz_rec_1.mjs

export async function verifyVizRec(page) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clickSel = async (sel) => {
    const b = await page.$eval(sel, (n) => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; });
    assert(b.w > 0, `${sel} is not laid out`);
    await page.mouse.click(b.x, b.y);
  };
  const topmost = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
  const results = {};

  if (!(await page.$("#vizView:not([hidden])"))) {
    await page.evaluate(() => { document.querySelector("#fleetDock [data-dock-min]")?.click(); document.getElementById("ctViz")?.click(); });
  }
  await page.waitForSelector("#vizView [data-viz-ledger]", { visible: true, timeout: 8000 });
  await page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
  const auto = () => page.$eval("#vizView input[data-viz-auto]", (i) => i.checked);

  // 1. Auto camera
  if (!(await auto())) await clickSel("#vizView input[data-viz-auto]");
  await pause(300);
  assert(await auto(), "checking Auto camera did not stick (the header click ran Fit and switched it off)");

  // 2. Record
  await clickSel("#vizView [data-viz-head] [data-viz-rec]");
  await page.waitForFunction(() => /Stop/.test(document.querySelector("#vizView [data-viz-head] [data-viz-rec]")?.textContent ?? ""), { timeout: 3000 })
    .catch(() => { throw new Error("Record did not start (the header click ran Fit instead)"); });
  assert(await page.$eval("#vizView [data-viz-recind]", (n) => !n.hidden), "the REC indicator is hidden while recording");
  assert(await auto(), "starting a recording switched Auto camera off");
  await pause(2500);

  // 3. Stop, then Recordings
  await clickSel("#vizView [data-viz-head] [data-viz-rec]");
  await page.waitForFunction(() => /Record/.test(document.querySelector("#vizView [data-viz-head] [data-viz-rec]")?.textContent ?? ""), { timeout: 3000 })
    .catch(() => { throw new Error("Stop did not end the recording"); });
  await pause(1200); // the recorder flushes its last chunk
  await page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
  await clickSel("#vizView [data-viz-head] [data-viz-recs]");
  await page.waitForSelector(".viz-recs [data-viz-rsave]", { visible: true, timeout: 3000 })
    .catch(() => { throw new Error("Recordings did not open a list with Save"); });
  assert(await topmost(".viz-recs [data-viz-rsave]"), "Save is covered");
  results.recordings = await page.$$eval(".viz-recs .viz-rec-row", (rs) => rs.length);

  // 4. Save downloads the clip
  await page.evaluate(() => {
    const w = window;
    w.__vizDownloads = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) w.__vizDownloads.push(this.download); return orig.call(this); };
  });
  await clickSel(".viz-recs [data-viz-rsave]");
  const names = await page.evaluate(() => window.__vizDownloads);
  assert(names.length === 1 && /^lucid-visualize-.+\.webm$/.test(names[0]), `Save did not download a clip: ${JSON.stringify(names)}`);
  results.saved = names[0];
  await page.keyboard.press("Escape");
  await pause(300);

  // 5. View menu
  await clickSel("#vizView [data-viz-head] [data-viz-viewmenu]");
  await page.waitForFunction(() => [...document.querySelectorAll(".popover.show")].some((p) => /Orbit|Constellation/.test(p.textContent ?? "")), { timeout: 3000 })
    .catch(() => { throw new Error("View did not open its menu"); });
  await page.keyboard.press("Escape");
  assert(await auto(), "Auto camera did not survive the header clicks");
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_viz_rec_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine (?vizDemo=1).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyVizRec(page), null, 2));
    console.log("P-VIZ.REC1 passed: Auto camera stays on, Record records, Recordings lists and saves the clip, and View opens.");
  } finally { await browser.disconnect(); }
}
