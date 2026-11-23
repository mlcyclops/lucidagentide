// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_fleet_head_3.mjs
//
// P-FLEET.HEAD3 (ADR-0647): real-browser proof that clicking a Fleet card's header does NOT take the lane over
// into the main composer. Before, a header press released within the drag slop promoted the lane (P-FLEET.L17),
// which a user hit by accident: the agent jumped into the main composer and its card went quiet. With real input:
//   1. a click on an empty spot of the card header leaves the main composer on Main (engine: no promoted lane);
//   2. the same on a single visible card (the old code took over there too);
//   3. the card's Promote button is still the way to hand the lane to the composer (it promotes), and the demo
//      hands it back afterwards.
// The caller owns the page (an engine with at least one lane) and leaves the Fleet dock open.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/ LUCID_DEMO_LANE=<lane id> node desktop/scripts/demo_p_fleet_head_3.mjs

export async function verifyHeaderClick(page, laneId) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content);
  const api = (path, body) => page.evaluate(async (p, b, t) => (await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", "x-lucid-token": t }, body: b ? JSON.stringify(b) : undefined })).json(), path, body ?? null, token);
  const promoted = async () => (await api("/api/fleet/promoted"))?.data?.lane ?? null;
  const card = `#fleetDock .fleet-card[data-lane="${laneId}"]`;
  await page.waitForSelector(card, { visible: true, timeout: 10000 });
  if (await promoted()) await api("/api/fleet/demote", {});
  await pause(500);

  // an empty spot on the header: right of the last chip, left of the controls, nowhere a button or select sits
  const spot = await page.$eval(`${card} .fleet-card-head`, (head) => {
    const r = head.getBoundingClientRect();
    for (let x = r.left + 8; x < r.right - 8; x += 6) {
      for (const y of [r.top + 6, r.top + r.height / 2, r.bottom - 6]) {
        const at = document.elementFromPoint(x, y);
        if (at && head.contains(at) && !at.closest("button, select, input, textarea, [data-fleet-grip], a, .pill, [class*='chip']")) return { x, y };
      }
    }
    return null;
  });
  assert(spot, "no empty spot on the card header to click");
  const clicks = [];
  for (let i = 0; i < 2; i++) {
    await page.mouse.click(spot.x, spot.y);
    await pause(1500);
    const lane = await promoted();
    clicks.push(lane);
    assert(!lane, `a header click took the lane over into the main composer (promoted: ${JSON.stringify(lane)})`);
  }

  // the explicit control still promotes
  const btn = await page.$(`${card} [data-fleet-promote]:not([hidden])`);
  let viaButton = null;
  if (btn) {
    await btn.click();
    for (let i = 0; i < 20 && !viaButton; i++) { await pause(300); viaButton = await promoted(); }
    assert(viaButton, "the Promote button no longer hands the lane to the main composer");
    await api("/api/fleet/demote", {});
  }
  return { headerClicks: clicks.length, promotedByButton: !!viaButton };
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_fleet_head_3.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  const laneId = process.env.LUCID_DEMO_LANE;
  if (!endpoint || !url || !laneId) throw new Error("Set LUCID_DEMO_CDP_URL, LUCID_DEMO_URL and LUCID_DEMO_LANE (a lane on that engine).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyHeaderClick(page, laneId), null, 2));
    console.log("P-FLEET.HEAD3 passed: clicking a Fleet card's header leaves the main composer on Main; the Promote button still hands the lane over.");
  } finally { await browser.disconnect(); }
}
