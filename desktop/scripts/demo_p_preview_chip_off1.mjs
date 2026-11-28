// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_chip_off1.mjs
//
// P-PREVIEW.CHIPOFF1: real-UI proof that an Agent Worlds node's preview chip leaves with its node. Against an isolated
// QA engine (scripted fake agent), in a wide (1600x1000) and a narrow (1100x800) window:
//   1. a lane writes the scripted penalty-shootout page, so its node gets a "Preview ready" chip; Visualize opens
//      with the real control, the auto camera off and everything fitted: the chip stands over its node, topmost at
//      its center, and auditBoxes is clean on it;
//   2. the world is panned with a real right-button drag until the node is off the stage: the chip is hidden, like
//      the node's floating Agent (before, it pinned itself to the stage's edge, under a docked node panel);
//   3. Fit brings the node back, and its chip with it.
// The old bundle fails at step 2 ("the chip is still on the stage").
//
// Setup (never a user's session): bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811, then the QA page open in a
// browser with remote debugging.
// Run: LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_preview_chip_off1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const GATES = "#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]";
const PAGE_PROMPT = "Build a Lucid Agent World mini game: penalty shootout"; // the script that writes a previewable page
const HOME_KEY = "lucid.fleetHome.v1";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

export async function verifyChipOffStage(page, base) {
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content);
  const api = (path, body) => page.evaluate(async (p, b, t) => {
    const r = await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", "x-lucid-token": t }, ...(b ? { body: JSON.stringify(b) } : {}) });
    const j = await r.json().catch(() => null);
    return j?.data ?? j;
  }, path, body ?? null, token);
  /** /api/fleet/prompt answers when the turn ends: send it from the page and do not wait on it. */
  const promptLane = (laneId, text) => page.evaluate((id, x, t) => {
    void fetch("/api/fleet/prompt", { method: "POST", headers: { "content-type": "application/json", "x-lucid-token": t }, body: JSON.stringify({ laneId: id, text: x }) }).catch(() => {});
  }, laneId, text, token);
  const until = async (read, what, ms = 20_000) => {
    for (const end = Date.now() + ms; ; await pause(200)) {
      const v = await read();
      if (v) return v;
      assert(Date.now() < end, what);
    }
  };
  const rect = (sel) => page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e || e.closest("[hidden]")) return null;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
  }, sel);
  const shown = (sel) => rect(sel).then((r) => !!r);
  const skipGates = async () => {
    for (let i = 0, idle = 0; i < 40 && idle < 6; i++) {
      const skip = await page.$(GATES);
      if (!skip) { idle++; await pause(400); continue; }
      idle = 0;
      await skip.click().catch(() => {});
      await pause(400);
    }
  };
  const laneStatus = async (id) => ((await api("/api/fleet/status"))?.lanes ?? []).find((l) => l.id === id)?.status;
  const idle = async (id) => { const s = await laneStatus(id); return s === "awaiting-input" || s === "done"; };
  const nodeBox = (id) => page.evaluate((n) => (window.__vizProbe?.nodes?.() ?? []).find((x) => x.id === n)?.box ?? null, id);

  const cdp = await page.target().createCDPSession();
  const setSize = async (s) => { await cdp.send("Emulation.setDeviceMetricsOverride", { width: s.width, height: s.height, deviceScaleFactor: 0, mobile: false }); await pause(700); };
  const savedHome = await page.evaluate((h) => localStorage.getItem(h), HOME_KEY);
  const results = [];
  let laneId = null;
  try {
    await page.goto(new URL("?vizScript=1", base).href, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ctViz", { timeout: 30_000 });
    await skipGates();
    await setSize(SIZES[0]);

    // a lane that writes a previewable page
    const ws = (await api("/api/workspace"))?.current;
    const sp = await api("/api/fleet/spawn", { name: "chip-off", ...(ws ? { cwd: ws } : {}) });
    laneId = sp?.lane?.id ?? sp?.id;
    assert(laneId, `spawn failed: ${JSON.stringify(sp).slice(0, 200)}`);
    await until(() => idle(laneId), "the lane did not become idle", 60_000);
    await page.evaluate((k) => localStorage.setItem(k, "grid"), HOME_KEY);
    if (!(await shown("#fleetGrid"))) await page.$eval("#ctFleet", (b) => b.click());
    await until(() => shown("#fleetGrid"), "the Fleet button did not open the grid", 6000);
    for (let i = 0; i < 4 && (await idle(laneId)); i++) { await promptLane(laneId, PAGE_PROMPT); await pause(4000); }
    const card = `.fleet-card[data-lane="${laneId}"]`;
    await until(() => shown(`${card} [data-lane-preview]`), "the lane's page never became a preview chip", 150_000);
    // The session asks once: answering is setup here, through the DOM.
    for (let end = Date.now() + 240_000; !(await idle(laneId)); await pause(500)) {
      assert(Date.now() < end, "the page turn did not finish");
      if (await shown(`${card} [data-fleet-approve]`)) await page.$eval(`${card} [data-fleet-allow]`, (b) => b.click()).catch(() => {});
    }
    await page.$eval("#ctFleet", (b) => b.click()).catch(() => {});

    await page.$eval("#ctViz", (b) => b.click());
    await until(() => shown("#vizView [data-viz-stage]"), "Visualize did not open", 10_000);
    await skipGates();
    await page.$eval("[data-viz-auto]", (c) => { if (c.checked) c.click(); });
    const chip = `[data-viz-preview-chip="${laneId}"]`;
    for (const size of SIZES) {
      await setSize(size);
      // 1. on the stage: the chip over its node
      await page.$eval("[data-viz-fit]", (b) => b.click());
      await pause(1500);
      const st = await rect("#vizView [data-viz-stage]");
      const n = await until(() => nodeBox(laneId), "the lane's node is not on screen", 8000);
      const c = await until(() => rect(chip), `${size.name}: the node has no preview chip on the stage`, 8000);
      assert(Math.abs((c.left + c.right) / 2 - n.x) < 4 && c.bottom <= n.y, `${size.name}: the chip (${JSON.stringify(c)}) is not over its node (${JSON.stringify(n)})`);
      const hit = await page.evaluate((s) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!at && e.contains(at); }, chip);
      assert(hit, `${size.name}: the chip is covered at its center`);
      const bad = await page.evaluate(auditBoxes, chip, MIN_GAP);
      assert(bad.length === 0, `${size.name}: auditBoxes on the chip: ${bad.join(" | ")}`);

      // 2. pan the node off the stage's left edge with the right button
      for (let i = 0; i < 6; i++) {
        const b = await nodeBox(laneId);
        if (b && b.x < st.left - 20) break;
        await page.mouse.move(st.right - 60, st.top + 120);
        await page.mouse.down({ button: "right" });
        for (let k = 1; k <= 12; k++) { await page.mouse.move(st.right - 60 - k * 50, st.top + 120); await pause(16); }
        await page.mouse.up({ button: "right" });
        await pause(600);
      }
      const off = await nodeBox(laneId);
      assert(off && off.x < st.left, `${size.name}: could not pan the node off the stage (${JSON.stringify(off)})`);
      await pause(300);
      const left = await rect(chip);
      assert(!left, `${size.name}: the chip is still on the stage at ${JSON.stringify(left)} with its node off it at x ${Math.round(off.x)}`);
      assert(!(await rect(`.abd-host[data-where="world"] .abd[data-abd-lane="${laneId}"]`)), `${size.name}: the node's floating Agent is still on the stage`);

      // 3. back on the stage, the chip comes back with it
      await page.$eval("[data-viz-fit]", (b) => b.click());
      await until(() => rect(chip), `${size.name}: the chip did not come back with its node`, 6000);
      results.push({ size: size.name, chip: "over its node; hidden with the node off the stage; back with it" });
    }
  } finally {
    if (laneId) { await api("/api/fleet/stop", { laneId }).catch(() => {}); await api("/api/fleet/remove", { laneId }).catch(() => {}); }
    if (await shown("#vizView [data-viz-stage]").catch(() => false)) await page.$eval("[data-viz-close]", (b) => b.click()).catch(() => {});
    if (await shown("#fleetGrid").catch(() => false)) await page.$eval("#ctFleet", (b) => b.click()).catch(() => {});
    await page.evaluate((h, v) => { if (v === null) localStorage.removeItem(h); else localStorage.setItem(h, v); }, HOME_KEY, savedHome).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_preview_chip_off1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const url = process.env.LUCID_DEMO_URL;
  if ((!endpoint && !browserURL) || !url) throw new Error("Set LUCID_DEMO_CDP_URL (or LUCID_DEMO_BROWSER_URL) and LUCID_DEMO_URL.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(endpoint ? { browserWSEndpoint: endpoint } : { browserURL }), defaultViewport: null, protocolTimeout: 120_000 });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url));
    if (!page) throw new Error(`No page at ${url}`);
    console.log(JSON.stringify(await verifyChipOffStage(page, url), null, 2));
    console.log("P-PREVIEW.CHIPOFF1 passed: a node's preview chip stands over it, hides when the node leaves the stage and comes back with it, wide and narrow.");
  } finally { await browser.disconnect(); }
}
