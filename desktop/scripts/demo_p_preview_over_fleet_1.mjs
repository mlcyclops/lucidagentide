// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_over_fleet_1.mjs
//
// P-PREVIEW.OVERFLEET1 (ADR-0645): real-browser proof that the Preview fly-out opens ON TOP of a Fleet dock floating
// over the middle of the window, and that its resize edge works there. Before, the preview column had no z-index
// and the fixed Fleet dock (z 55) painted over it, resize edge included, so a lane's Preview could not be seen
// or resized without minimizing Fleet. With real input, at the caller's window size, it proves:
//   1. with the dock floating across the preview's left part, `elementFromPoint` inside that overlap hits the
//      preview, not the dock, and the resize edge's center hits the resize edge;
//   2. dragging that edge right narrows the preview and dragging it left widens it again (up to its 50vw cap),
//      over the dock, and the last width is saved (`lucid.preview-w`);
//   3. the Fleet dock stays open the whole time (not closed, not minimized);
//   4. the preview header passes the spacing audit (auditBoxes, ADR-0633).
// The caller owns the page (an isolated QA engine) and the window size; the demo floats the dock itself.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/ node desktop/scripts/demo_p_preview_over_fleet_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

export async function verifyPreviewOverFleet(page) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rect = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; });
  const hits = (sel, x, y) => page.evaluate((s, px, py) => { const n = document.querySelector(s); const at = document.elementFromPoint(px, py); return !!n && !!at && n.contains(at); }, sel, x, y);
  const dockOpen = () => page.evaluate(() => { const d = document.getElementById("fleetDock"); return !!d && !d.hidden && getComputedStyle(d).display !== "none" && d.getBoundingClientRect().width > 200; });

  // float the Fleet dock across the middle of the window, wide enough to reach well under the preview
  const vw = await page.evaluate(() => window.innerWidth);
  const vh = await page.evaluate(() => window.innerHeight);
  if (await page.$("#fleetDock")) await page.click("#ctFleet");
  await page.evaluate((w, h) => localStorage.setItem("lucid.fleetDock.v1", JSON.stringify({ shape: { x: Math.round(w * 0.12), y: 64, w: Math.round(w * 0.76), h: Math.round(h * 0.8) }, minimized: false, side: "float", collapsed: {} })), vw, vh);
  await page.click("#ctFleet");
  await page.waitForSelector("#fleetDock", { visible: true, timeout: 5000 });
  assert(await dockOpen(), "the Fleet dock did not open");

  // open the preview the way a user does (the rail button), with Fleet still up
  if (await page.$eval("#preview", (p) => p.hidden)) await page.click('.rail-btn[data-rail="preview"]');
  await page.waitForSelector("#preview", { visible: true, timeout: 5000 });
  await pause(500); // the slide-in
  const dock = await rect("#fleetDock");
  const prev = await rect("#preview");
  const overlap = { left: Math.max(dock.left, prev.left), right: Math.min(dock.right, prev.right), top: Math.max(dock.top, prev.top), bottom: Math.min(dock.bottom, prev.bottom) };
  assert(overlap.right - overlap.left > 40 && overlap.bottom - overlap.top > 40, `the dock does not reach under the preview (dock ${JSON.stringify(dock)}, preview ${JSON.stringify(prev)})`);

  // toasts sit above both on purpose (the sheet tier, 115): close any boot-time toast so it is not in the way
  for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});
  await pause(400);

  // 1. the overlap belongs to the preview, and so does its resize edge
  const probes = [[0.25, 0.25], [0.5, 0.5], [0.25, 0.8], [0.75, 0.4]].map(([fx, fy]) => [overlap.left + (overlap.right - overlap.left) * fx, overlap.top + (overlap.bottom - overlap.top) * fy]);
  const owner = (x, y) => page.evaluate((px, py) => { const at = document.elementFromPoint(px, py); const o = at?.closest("[id]"); return o ? `#${o.id}` : at?.tagName ?? "nothing"; }, x, y);
  for (const [x, y] of probes) assert(await hits("#preview", x, y), `at (${Math.round(x)}, ${Math.round(y)}) ${await owner(x, y)} paints over the preview`);
  const edge = await rect('#preview [data-resize="preview"]');
  const ex = edge.left + edge.w / 2, ey = Math.min(edge.bottom - 10, overlap.top + (overlap.bottom - overlap.top) / 2);
  assert(await hits('#preview [data-resize="preview"]', ex, ey), "the preview's resize edge is covered");

  // 2. drag the edge right (narrower), then left (wider): the preview follows and remembers the last width
  const drag = async (dx) => {
    const e = await rect('#preview [data-resize="preview"]');
    const x = e.left + e.w / 2;
    assert(await hits('#preview [data-resize="preview"]', x, ey), "the preview's resize edge is covered");
    await page.mouse.move(x, ey);
    await page.mouse.down();
    await page.mouse.move(x + dx, ey, { steps: 10 });
    await page.mouse.up();
    await pause(300);
    return (await rect("#preview")).w;
  };
  const before = prev.w;
  const narrower = await drag(200);
  assert(narrower < before - 60, `dragging the edge right did not narrow the preview (${Math.round(before)} -> ${Math.round(narrower)})`);
  const after = await drag(-120);
  assert(after > narrower + 60, `dragging the edge left did not widen the preview (${Math.round(narrower)} -> ${Math.round(after)})`);
  // the app may run zoomed (the titlebar magnifier), so the saved width is compared in CSS pixels
  const { saved, css } = await page.evaluate(() => ({ saved: localStorage.getItem("lucid.preview-w"), css: document.getElementById("preview").offsetWidth }));
  assert(saved && Math.abs(parseFloat(saved) - css) <= 2, `the new width was not saved (lucid.preview-w ${saved}, width ${css} CSS px)`);

  // 3. Fleet is still up
  assert(await dockOpen(), "opening or resizing the preview closed or hid the Fleet dock");

  // 4. spacing
  const spacing = await page.evaluate(auditBoxes, "#preview .set-head", MIN_GAP);
  assert(spacing.length === 0, `preview header spacing: ${spacing.join("; ")}`);
  return { window: `${vw}x${vh}`, overlap: Math.round(overlap.right - overlap.left), width: [Math.round(before), Math.round(narrower), Math.round(after)], saved };
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_preview_over_fleet_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyPreviewOverFleet(page), null, 2));
    console.log("P-PREVIEW.OVERFLEET1 passed: the Preview opens over the floating Fleet dock, its edge resizes it and the width is saved, and Fleet stays open.");
  } finally { await browser.disconnect(); }
}
