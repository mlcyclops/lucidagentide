// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_auto_full_1.mjs
//
// P-AUTO.FULL1 (ADR-0639): real-browser check of the /goal Speed vs risk dial's new top stop, T4 "full auto".
// With real input in a running LUCID window:
//   1. typing /goal in the composer and pressing Enter opens the goal form;
//   2. every dial row has five stops (T0..T4) and the top stop reads "T4 full auto";
//   3. dragging a row's slider to the far right sets it to T4, and the choice persists (lucid.goalDial);
//   4. the dial passes the spacing audit (auditBoxes, ADR-0633).
// The verdict side (danger mode and a T4 dial run the catastrophic set; managed policy still stops them) is
// covered by exec_policy.test.ts and demo_p_exec_1 / demo_p_goal_13. The caller owns the page; use a QA
// engine or a second instance. The dial row it moves is put back afterwards.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/ node desktop/scripts/demo_p_auto_full_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

export async function verifyFullAutoDial(page) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const before = await page.evaluate(() => localStorage.getItem("lucid.goalDial"));
  try {
    await page.click("#input");
    await page.keyboard.type("/goal");
    await pause(300);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".goal-scrim #goalDial", { timeout: 5000 });
    // the guided form shows one step at a time; Advanced shows them all, the dial (step 4) included
    if (!(await page.$eval(".goal-scrim #goalDial", (d) => d.getClientRects().length > 0))) await page.click(".goal-scrim #goalModeToggle");
    await page.evaluate(() => { const d = document.querySelector(".goal-scrim #goalDial"); d.open = true; d.scrollIntoView({ block: "center" }); });
    await pause(400);
    const rows = await page.$$eval(".goal-scrim .goal-dial-slider", (ss) => ss.map((s) => ({ k: s.dataset.dk, min: s.min, max: s.max })));
    assert(rows.length === 6 && rows.every((r) => r.min === "0" && r.max === "4"), `dial rows are not five-stop sliders: ${JSON.stringify(rows)}`);
    const shell = await page.$('.goal-scrim .goal-dial-slider[data-dk="shell"]');
    const box = await shell.boundingBox();
    await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
    await pause(200);
    const badge = await page.$eval('.goal-scrim [data-dt="shell"]', (b) => b.textContent.replace(/\s+/g, " ").trim());
    assert(badge === "T4full auto" || badge === "T4 full auto", `the shell row at its top stop reads "${badge}", not "T4 full auto"`);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("lucid.goalDial") || "{}").shell);
    assert(saved === "T4", `the T4 choice was not persisted (lucid.goalDial.shell = ${saved})`);
    const spacing = await page.evaluate(auditBoxes, ".goal-scrim #goalDial", MIN_GAP);
    assert(spacing.length === 0, `dial spacing: ${spacing.join("; ")}`);
    return { rows: rows.length, stops: 5, top: badge };
  } finally {
    await page.evaluate((v) => { if (v === null) localStorage.removeItem("lucid.goalDial"); else localStorage.setItem("lucid.goalDial", v); }, before);
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(() => document.querySelector(".goal-scrim")?.remove());
    await page.evaluate(() => { const i = document.getElementById("input"); if (i) { i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); } });
  }
}

if (process.argv[1]?.endsWith("demo_p_auto_full_1.mjs")) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyFullAutoDial(page)));
    console.log("P-AUTO.FULL1 passed: /goal opens the form; every dial row has five stops with T4 full auto on top; the choice persists; spacing clean.");
  } finally { await browser.disconnect(); }
}
