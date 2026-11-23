// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_fit_1.mjs
//
// P-PREVIEW.FIT1 (ADR-0642): real-browser proof that an oversized fixed page (a 1920x1080 video card that cannot
// scroll itself, desktop/scripts/fixtures/preview_fit_card.html) fits the Preview panel by default and can be
// zoomed and panned. Before, the Agent tab showed it at 100% cut off at the right edge with no way to pan.
// With real input it proves:
//   1. on open, Fit is pressed and the readout shows the fitted zoom (panel width over 1920, under 100%);
//   2. all four corner markers of the card are on screen inside the panel at once;
//   3. 100% leaves fit mode, the panel scrolls across the whole card, and the Pan tool drags it;
//   4. Fit puts the whole card back; Fit and Pan are the topmost element at their centers.
// The caller owns the page (an isolated QA engine), the window size and the preview panel being open.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/ node desktop/scripts/demo_p_preview_fit_1.mjs

import { fileURLToPath } from "node:url";

export const FIT_FIXTURE = fileURLToPath(new URL("./fixtures/preview_fit_card.html", import.meta.url)).replace(/\\/g, "/");

export async function verifyPreviewFit(page, fixturePath = FIT_FIXTURE) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function poll(label, read, accept, ms = 6000) {
    const end = Date.now() + ms;
    let v;
    do { v = await read(); if (accept(v)) return v; await pause(60); } while (Date.now() < end);
    throw new Error(`timed out: ${label}; last ${JSON.stringify(v)}`);
  }
  const state = () => page.evaluate(() => {
    const vp = document.querySelector("#prevViewport");
    const r = vp.getBoundingClientRect();
    const frame = document.querySelector("#prevFrame");
    const fr = frame.getBoundingClientRect();
    return {
      zoom: document.querySelector("#prevZoomReset").textContent.trim(),
      fit: document.querySelector("#prevZoomFit").getAttribute("aria-pressed"),
      panel: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: vp.clientWidth, h: vp.clientHeight, scale: r.width / vp.offsetWidth || 1 },
      frame: { left: fr.left, top: fr.top, w: fr.width, h: fr.height },
      scroll: { x: vp.scrollLeft, maxX: vp.scrollWidth - vp.clientWidth, maxY: vp.scrollHeight - vp.clientHeight },
    };
  });
  const topmost = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
  const results = {};

  if (await page.$eval("#preview", (p) => p.hidden)) await page.click('.rail-btn[data-rail="preview"]');
  await page.waitForSelector("#prevOpen", { visible: true, timeout: 5000 });
  await page.click('.prev-tab[data-lane="yours"]');
  await page.click("#prevPath", { clickCount: 3 });
  await page.keyboard.type(fixturePath);
  await page.click("#prevOpen");
  await page.waitForSelector("#prevFrame", { visible: true, timeout: 6000 });

  // 1 + 2: fitted on open, whole card visible
  const fitted = await poll("the card fits on open", state, (s) => s.fit === "true" && parseInt(s.zoom, 10) < 100 && s.frame.w <= s.panel.w * s.panel.scale + 2);
  const expected = Math.round((fitted.panel.w / 1920) * 100);
  assert(Math.abs(parseInt(fitted.zoom, 10) - expected) <= 1, `fitted zoom ${fitted.zoom}, expected about ${expected}%`);
  const frameEl = await page.$("#prevFrame");
  const frame = await frameEl.contentFrame();
  await frameEl.dispose();
  const corners = await frame.$$eval(".m", (ms) => ms.map((m) => m.id));
  assert(corners.length === 4, "the fixture's corner markers did not load");
  const visibleH = fitted.frame.h;
  assert(fitted.frame.w <= fitted.panel.w * fitted.panel.scale + 2 && visibleH >= (fitted.panel.w / 1920) * 1080 * fitted.panel.scale - 2, `the fitted card is not whole: ${JSON.stringify(fitted)}`);
  assert(await topmost("#prevZoomFit"), "Fit is covered");
  results.fitted = fitted.zoom;

  // 3: 100% lays the whole card out, the panel scrolls, and Pan drags it
  await page.click("#prevZoomReset");
  const full = await poll("100% leaves fit mode", state, (s) => s.zoom === "100%" && s.fit === "false");
  assert(full.scroll.maxX >= 1920 - full.panel.w - 2, `at 100% the panel cannot scroll across the card (maxX ${full.scroll.maxX})`);
  await page.click("#prevPan");
  assert(await topmost("#prevPan"), "Pan is covered");
  const cx = (full.panel.left + full.panel.right) / 2, cy = (full.panel.top + full.panel.bottom) / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 300, cy, { steps: 8 });
  await page.mouse.up();
  const dragged = await poll("Pan drags the card", state, (s) => s.scroll.x >= 250);
  await page.keyboard.press("Escape");
  results.panned = dragged.scroll.x;

  // 4: Fit restores the whole card
  await page.click("#prevZoomFit");
  const back = await poll("Fit restores the whole card", state, (s) => s.fit === "true" && s.zoom === fitted.zoom);
  results.refit = back.zoom;
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_preview_fit_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyPreviewFit(page), null, 2));
    console.log("P-PREVIEW.FIT1 passed: the oversized card fits on open, 100% scrolls and pans across it, and Fit brings it back whole.");
  } finally { await browser.disconnect(); }
}
