// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_viz_6.mjs
//
// P-VIZ.6 (ADR-0635..0637): real-browser check of the Visualize session ledger and the throw tray, on the
// ?vizDemo=1 feed (the page must already be at <engine>/?vizDemo=1 with first-run gates done). With real input:
//   1. the ledger opens collapsed in the lower right as exactly two lines, on top, clear of the legend and tray;
//   2. it pops up into a card that shows 5 rows at a time and scrolls when there are more; values update live;
//   3. the card drags by its header in 3D and in 2D, stays inside the stage, and does not move the camera;
//      collapsing (Esc) returns it to the corner;
//   4. the throw tray shows the style's three throwables plus Storm (anime: stars, bolt, orb; professional:
//      paper, band, drink); arming one and clicking an agent throws it without opening the node panel;
//      Escape disarms; Storm rate-limits;
//   5. auditBoxes (ADR-0633) is clean on the ledger card and the tray;
//   6. no uncaught page errors while all of this runs.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 node desktop/scripts/demo_p_viz_6.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

export async function verifyViz6(page) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  const onError = (e) => errors.push(String(e?.message ?? e));
  page.on("pageerror", onError);
  const rect = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });
  const onTop = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && e.contains(hit); });
  const click = async (sel) => { const r = await rect(sel); await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2); };
  const results = {};
  try {
    if (!(await page.$("#vizView:not([hidden])"))) {
      await page.evaluate(() => document.querySelector("#fleetDock [data-dock-min]")?.click());
      await page.evaluate(() => document.getElementById("ctViz")?.click());
    }
    await page.waitForSelector("#vizView [data-viz-ledger]", { visible: true, timeout: 8000 });
    await page.evaluate(() => document.querySelector('#vizView [data-viz-view="3d"]')?.click());
    await pause(2500); // the demo feed fills in

    // 1. collapsed: two lines, lower right, on top, clear of the legend and the tray
    const stage = await rect("#vizView [data-viz-stage]");
    const pill = await rect("#vizView [data-lg-pill]");
    const lines = await page.$$eval("#vizView [data-lg-pill] > span", (ss) => ss.filter((s) => s.getBoundingClientRect().height > 0).map((s) => s.textContent.trim()));
    assert(lines.length === 2 && lines.every(Boolean), `collapsed ledger lines: ${JSON.stringify(lines)}`);
    assert(pill.right <= stage.right && pill.right > stage.right - 40 && pill.bottom <= stage.bottom && pill.bottom > stage.bottom - 60, `collapsed ledger is not in the lower right: ${JSON.stringify(pill)} in ${JSON.stringify(stage)}`);
    assert(await onTop("#vizView [data-lg-pill]"), "the collapsed ledger is covered");
    const tray = await rect("#vizView .viz-throw");
    const overlaps = (a, b) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
    assert(!overlaps(pill, tray), "the collapsed ledger overlaps the throw tray");
    const legend = await page.$("#vizView .orbit-legend, #vizView [data-viz-legend]");
    if (legend) assert(!overlaps(pill, await legend.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; })), "the collapsed ledger overlaps the legend");
    results.collapsed = lines;

    // 2. popped up: 5 rows visible, scrolls when more, values change live
    await click("#vizView [data-lg-pill]");
    await page.waitForSelector("#vizView [data-lg-card]:not([hidden])", { visible: true, timeout: 3000 });
    await pause(500);
    const list = await page.$eval("#vizView [data-lg-list]", (l) => {
      const rows = [...l.querySelectorAll(".viz-ledger-row")];
      const lb = l.getBoundingClientRect();
      const visible = rows.filter((r) => { const b = r.getBoundingClientRect(); return b.top >= lb.top - 1 && b.bottom <= lb.bottom + 1; }).length;
      return { rows: rows.length, visible, scrolls: l.scrollHeight > l.clientHeight + 1, text: l.textContent };
    });
    assert(list.rows >= 1, "the ledger has no rows on the demo feed");
    assert(list.visible === Math.min(5, list.rows), `the ledger shows ${list.visible} whole rows, expected ${Math.min(5, list.rows)}`);
    if (list.rows > 5) assert(list.scrolls, "more than 5 rows but the list does not scroll");
    await pause(3000);
    const later = await page.$eval("#vizView [data-lg-list]", (l) => l.textContent);
    assert(later !== list.text, "the ledger did not change in 3 s of demo activity");
    results.rows = list.rows;
    const cardSpacing = await page.evaluate(auditBoxes, "#vizView [data-lg-card]", MIN_GAP);
    assert(cardSpacing.length === 0, `ledger card spacing: ${cardSpacing.join("; ")}`);

    // 3. drag in 3D and 2D, clamped, then Esc collapses back to the corner
    for (const view of ["3d", "2d"]) {
      await page.evaluate((v) => document.querySelector(`#vizView [data-viz-view="${v}"]`)?.click(), view);
      await pause(800);
      const before = await rect("#vizView [data-lg-card]");
      const head = await rect("#vizView [data-lg-drag]");
      const sx = head.x + 30, sy = head.y + head.h / 2;
      const hubAt = () => page.evaluate(() => (window.__vizProbe?.nodes() ?? []).find((n) => n.kind === "hub")?.box ?? null);
      const hubBefore = await hubAt();
      // toward the stage center, so the move has room whichever corner the card is in
      const dx = before.x + before.w / 2 < stage.x + stage.w / 2 ? 220 : -220;
      const dy = before.y + before.h / 2 < stage.y + stage.h / 2 ? 160 : -160;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + dx, sy + dy, { steps: 8 });
      await page.mouse.up();
      await pause(300);
      const after = await rect("#vizView [data-lg-card]");
      assert(Math.abs(after.x - (before.x + dx)) < 3 && Math.abs(after.y - (before.y + dy)) < 3, `${view}: the card did not follow the drag (${JSON.stringify(before)} -> ${JSON.stringify(after)})`);
      const hubAfter = await hubAt();
      assert(hubBefore && hubAfter && Math.hypot(hubAfter.x - hubBefore.x, hubAfter.y - hubBefore.y) < 4, `${view}: dragging the card moved the camera (Main ${JSON.stringify(hubBefore)} -> ${JSON.stringify(hubAfter)})`);
      // a drag far past the edge is clamped inside the stage
      const h2 = await rect("#vizView [data-lg-drag]");
      await page.mouse.move(h2.x + 30, h2.y + h2.h / 2);
      await page.mouse.down();
      await page.mouse.move(h2.x - 4000, h2.y - 4000, { steps: 6 });
      await page.mouse.up();
      await pause(300);
      const clamped = await rect("#vizView [data-lg-card]");
      assert(clamped.x >= stage.x - 1 && clamped.y >= stage.y - 1, `${view}: the card left the stage (${JSON.stringify(clamped)})`);
      results[`drag${view}`] = "ok";
    }
    await page.focus("#vizView [data-lg-list]");
    await page.keyboard.press("Escape");
    await pause(600);
    assert(await page.$eval("#vizView [data-lg-card]", (c) => c.hidden), "Escape did not collapse the ledger");
    assert(await page.$eval("#vizView [data-viz-ledger]", (l) => l.offsetParent !== null), "Escape inside the ledger closed Visualize too");

    // 4. throw tray per style; arm, throw at an agent, no node panel; Escape disarms; Storm rate-limits
    await page.evaluate(() => document.querySelector('#vizView [data-viz-view="3d"]')?.click());
    for (const [style, kinds] of [["professional", ["paper", "band", "drink"]], ["anime", ["stars", "bolt", "orb"]]]) {
      await page.evaluate((s) => [...document.querySelectorAll("#vizView button")].find((b) => b.textContent.trim().toLowerCase() === s || (b.getAttribute("aria-label") ?? "").toLowerCase() === s)?.click(), style);
      await pause(1200);
      const got = await page.$$eval("#vizView [data-viz-throw]", (bs) => bs.map((b) => b.dataset.vizThrow));
      assert(JSON.stringify(got) === JSON.stringify(kinds), `${style} tray offers ${JSON.stringify(got)}, expected ${JSON.stringify(kinds)}`);
      assert(await page.$("#vizView [data-viz-storm]"), `${style} tray has no Storm`);
      const traySpacing = await page.evaluate(auditBoxes, "#vizView .viz-throw", MIN_GAP);
      assert(traySpacing.length === 0, `${style} tray spacing: ${traySpacing.join("; ")}`);
      for (const kind of kinds) {
        await click(`#vizView [data-viz-throw="${kind}"]`);
        assert(await page.$eval(`#vizView [data-viz-throw="${kind}"]`, (b) => b.getAttribute("aria-pressed") === "true"), `${kind} did not arm`);
        const target = await page.evaluate(() => {
          const ns = window.__vizProbe?.nodes() ?? [];
          const stageEl = document.querySelector("#vizView [data-viz-stage]").getBoundingClientRect();
          return ns.filter((n) => n.kind !== "hub" && n.box && n.box.x > stageEl.left + 40 && n.box.x < stageEl.right - 40 && n.box.y > stageEl.top + 40 && n.box.y < stageEl.bottom - 80)[0] ?? null;
        });
        assert(target, "no agent on screen to throw at (window.__vizProbe missing or nothing in view)");
        await page.mouse.click(target.box.x, target.box.y);
        await pause(900);
        assert(!(await page.$("#vizView [data-viz-panel]:not([hidden])")), `throwing ${kind} opened the node panel`);
        await page.keyboard.press("Escape");
        await pause(200);
        assert(await page.$eval(`#vizView [data-viz-throw="${kind}"]`, (b) => b.getAttribute("aria-pressed") !== "true"), `Escape did not disarm ${kind}`);
        assert(await page.$("#vizView:not([hidden])"), "Escape while armed closed Visualize");
      }
      await click("#vizView [data-viz-storm]");
      await pause(150);
      assert(await page.$eval("#vizView [data-viz-storm]", (b) => b.disabled || b.getAttribute("aria-disabled") === "true"), `${style}: Storm is not rate-limited right after use`);
      await pause(4300);
      results[style] = got;
    }
    assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
    return results;
  } finally {
    page.off("pageerror", onError);
  }
}

if (process.argv[1]?.endsWith("demo_p_viz_6.mjs")) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL (an isolated QA page at <engine>/?vizDemo=1).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyViz6(page), null, 2));
    console.log("P-VIZ.6 passed: ledger two lines in the corner, 5-row scrolling card that updates live, drag in 3D and 2D, Esc collapses; style trays throw without opening the panel; Storm rate-limited; spacing clean; no page errors.");
  } finally { await browser.disconnect(); }
}
