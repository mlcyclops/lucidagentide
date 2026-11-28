// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_viz_motion_1.mjs
//
// P-VIZ.MOTION1 (ADR-0696): real-UI proof of Visualize's Motion choice, against an isolated QA engine (scripted fake
// agent) with the page told the OS asks for reduced motion (CDP prefers-reduced-motion: reduce, what Windows reports
// with Animation effects off). In a wide (1600x1000) and a narrow (1100x800) window:
//   1. Follow system (the default): Auto reads the reduced-motion tier, the scene draws no particles, and the View
//      menu's Motion section says why, its choice topmost and auditBoxes clean on the menu;
//   2. a real click on Always animate: the scene rebuilds at the tier the machine gets without reduced motion, with
//      particles, the note goes away, and with a lane working the busy frames come at the tier's cadence (60 fps on
//      full and above), not the 15 fps a reduced-motion scene falls back to;
//   3. the choice survives a reload (lucid.viz.v1), and Follow system brings the reduced view back.
// The old bundle fails at step 1 (the View menu has no Motion choice).
//
// Setup (never a user's session): bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811, then the QA page open in a
// browser with remote debugging.
// Run: LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_viz_motion_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const GATES = "#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]";
const BUSY_PROMPT = "Ship a PCI-safe checkout microservice"; // a long scripted turn: the lane works while we measure
const PREFS_KEY = "lucid.viz.v1";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

export async function verifyVizMotion(page, base) {
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content);
  const api = (path, body) => page.evaluate(async (p, b, t) => {
    const r = await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", "x-lucid-token": t }, ...(b ? { body: JSON.stringify(b) } : {}) });
    const j = await r.json().catch(() => null);
    return j?.data ?? j;
  }, path, body ?? null, token);
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
  /** A real click at the control's center, after proving the click would land on it. */
  const click = async (sel, what) => {
    const r = await until(() => rect(sel), `${what} is not on screen`, 6000);
    const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
    const hit = await page.evaluate((px, py, s) => { const at = document.elementFromPoint(px, py); return !!at?.closest(s); }, x, y, sel);
    assert(hit, `${what} is covered at its center`);
    await page.mouse.click(x, y);
  };
  const skipGates = async () => {
    for (let i = 0, idle = 0; i < 40 && idle < 6; i++) {
      const skip = await page.$(GATES);
      if (!skip) { idle++; await pause(400); continue; }
      idle = 0;
      await skip.click().catch(() => {});
      await pause(400);
    }
  };
  const quality = () => page.evaluate(() => window.__vizProbe?.quality?.() ?? null);
  const laneStatus = async (id) => ((await api("/api/fleet/status"))?.lanes ?? []).find((l) => l.id === id)?.status;
  const openViz = async () => {
    await page.goto(new URL("?vizScript=1", base).href, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ctViz", { timeout: 30_000 });
    await skipGates();
    await page.$eval("#ctViz", (b) => b.click()); // opening the view is setup; the Motion control gets real input
    await until(() => shown("#vizView [data-viz-stage]"), "Visualize did not open", 10_000);
    await skipGates();
    await until(async () => (await quality())?.scene, "the scene did not report its quality", 20_000);
  };
  const openMenu = async () => {
    if (!(await shown(".viz-vmenu"))) await click("#vizView [data-viz-viewmenu]", "the View button");
    await until(() => shown(".viz-vmenu [data-viz-motion]"), "the View menu has no Motion choice", 4000);
  };
  const closeMenu = async () => { if (await shown(".viz-vmenu")) await click("#vizView [data-viz-viewmenu]", "the View button"); await pause(200); };
  const pressed = (v) => page.$eval(`.viz-vmenu [data-viz-motion="${v}"]`, (b) => b.getAttribute("aria-pressed"));

  const cdp = await page.target().createCDPSession();
  const setSize = async (s) => { await cdp.send("Emulation.setDeviceMetricsOverride", { width: s.width, height: s.height, deviceScaleFactor: 0, mobile: false }); await pause(700); };
  const savedPrefs = await page.evaluate((k) => localStorage.getItem(k), PREFS_KEY);
  const results = [];
  let laneId = null;
  try {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await page.evaluate((k) => { const p = JSON.parse(localStorage.getItem(k) ?? "{}"); delete p.motion; localStorage.setItem(k, JSON.stringify(p)); }, PREFS_KEY);
    // a lane that keeps working while the frames are measured
    const ws = (await api("/api/workspace"))?.current;
    const sp = await api("/api/fleet/spawn", { name: "motion-one", ...(ws ? { cwd: ws } : {}) });
    laneId = sp?.lane?.id ?? sp?.id;
    assert(laneId, `spawn failed: ${JSON.stringify(sp).slice(0, 200)}`);
    await until(async () => ["awaiting-input", "done"].includes(await laneStatus(laneId)), "the lane did not become idle", 60_000);

    await openViz();
    assert(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), "the page does not see reduced motion");
    for (const size of SIZES) {
      await setSize(size);
      // 1. Follow system
      await openMenu();
      assert((await pressed("system")) === "true", `${size.name}: Follow system is not the default`);
      assert(await shown(".viz-vmenu [data-viz-motion-note]"), `${size.name}: no note says the system asked for reduced motion`);
      const bad = await page.evaluate(auditBoxes, ".viz-vmenu", MIN_GAP);
      assert(bad.length === 0, `${size.name}: auditBoxes on the View menu: ${bad.join(" | ")}`);
      const q0 = await quality();
      assert(q0.scene.particles === 0, `${size.name}: Follow system on a reduced-motion OS still draws ${q0.scene.particles} particles`);
      // 2. Always animate, with a real click
      await click('.viz-vmenu [data-viz-motion="always"]', `${size.name}: Always animate`);
      await until(async () => (await pressed("always")) === "true", `${size.name}: Always animate did not take`, 3000);
      assert(!(await shown(".viz-vmenu [data-viz-motion-note]")), `${size.name}: the note stays after Always animate`);
      const q1 = await until(async () => { const q = await quality(); return q?.scene && q.scene.particles > 0 ? q : null; }, `${size.name}: Always animate did not bring the particles back`, 15_000);
      assert(q1.tier === q1.scene.tier, `${size.name}: the scene (${q1.scene.tier}) is not on the view's tier (${q1.tier})`);
      assert(q1.tier !== q0.tier || q0.tier === "minimal", `${size.name}: Auto stayed on the reduced-motion tier (${q0.tier})`);
      await closeMenu();
      if (size.name === "wide") {
        // busy frames at the tier's cadence while a lane works (the governor measures busy frames only)
        await page.evaluate((id, x, t) => { void fetch("/api/fleet/prompt", { method: "POST", headers: { "content-type": "application/json", "x-lucid-token": t }, body: JSON.stringify({ laneId: id, text: x }) }).catch(() => {}); }, laneId, BUSY_PROMPT, token);
        await until(async () => !["awaiting-input", "done"].includes(await laneStatus(laneId)), "the lane did not start working", 15_000);
        const g = await until(async () => { const q = await quality(); const s = q?.scene?.governor; return s && s.frames >= 60 ? s : null; }, "the scene measured no busy frames while the lane worked", 20_000);
        const want = q1.scene.fps;
        assert(g.meanMs < (1000 / want) * 1.5, `busy frames average ${g.meanMs.toFixed(1)} ms, not the ${want} fps cadence (${(1000 / want).toFixed(1)} ms)`);
        results.push({ size: size.name, busyFrames: `${g.frames} frames, mean ${g.meanMs.toFixed(1)} ms at ${want} fps` });
      }
      // 3. back to Follow system for the next size
      await openMenu();
      await click('.viz-vmenu [data-viz-motion="system"]', `${size.name}: Follow system`);
      await until(async () => (await quality())?.scene?.particles === 0, `${size.name}: Follow system did not hold the motion back again`, 15_000);
      await closeMenu();
      results.push({ size: size.name, motion: `follow system: ${q0.tier}, 0 particles; always animate: ${q1.tier}, ${q1.scene.particles} particles` });
    }
    // the choice survives a reload
    await openMenu();
    await click('.viz-vmenu [data-viz-motion="always"]', "Always animate");
    await until(async () => (await quality())?.scene?.particles > 0, "Always animate did not take before the reload", 15_000);
    await openViz();
    const q2 = await until(async () => { const q = await quality(); return q?.scene?.particles > 0 ? q : null; }, "Always animate did not survive a reload", 15_000);
    results.push({ reload: `still always animate (${q2.tier}, ${q2.scene.particles} particles)` });
  } finally {
    if (laneId) { await api("/api/fleet/stop", { laneId }).catch(() => {}); await api("/api/fleet/remove", { laneId }).catch(() => {}); }
    if (await shown("#vizView [data-viz-stage]").catch(() => false)) await page.$eval("[data-viz-close]", (b) => b.click()).catch(() => {});
    await page.evaluate((k, v) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }, PREFS_KEY, savedPrefs).catch(() => {});
    await cdp.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_viz_motion_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const url = process.env.LUCID_DEMO_URL;
  if ((!endpoint && !browserURL) || !url) throw new Error("Set LUCID_DEMO_CDP_URL (or LUCID_DEMO_BROWSER_URL) and LUCID_DEMO_URL.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(endpoint ? { browserWSEndpoint: endpoint } : { browserURL }), defaultViewport: null, protocolTimeout: 120_000 });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url));
    if (!page) throw new Error(`No page at ${url}`);
    console.log(JSON.stringify(await verifyVizMotion(page, url), null, 2));
    console.log("P-VIZ.MOTION1 passed: on a reduced-motion OS, Visualize follows it by default and says so; Always animate brings back the full tier, particles and full-rate busy frames, survives a reload, and Follow system holds the motion back again, wide and narrow.");
  } finally { await browser.disconnect(); }
}
