// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_viz_prefs_1.mjs
//
// P-VIZ.PREFS1 (ADR-0697): Visualize's preferences survive a launch on a new port. Against an isolated QA engine:
//   1. Visualize opens with the real control; in the View menu, real clicks pick the Constellation layout and Always
//      animate, and untick Fly to approvals; the engine now keeps them (GET /api/viz/prefs);
//   2. the renderer origin's localStorage is wiped, which is exactly what a port-rolled launch (ADR-0458) gives the
//      renderer, and the page reloads;
//   3. in a wide (1600x1000) and a narrow (1100x800) window, Visualize opens and the View menu shows the same three
//      choices, each control topmost; the scene is drawn with Always animate (particles on under an emulated
//      reduced-motion system); the localStorage mirror is filled again from the engine.
// The old bundle fails at step 1's engine check (nothing reaches the engine) and at step 3 (the choices reset).
//
// Setup (never a user's session): bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811, then the QA page open in a
// browser with remote debugging.
// Run: LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_viz_prefs_1.mjs

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const GATES = "#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]";
const VIEW_KEY = "lucid.viz.v1";
const FLY_KEY = "lucid.viz.flyToApprovals.v1";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

export async function verifyVizPrefs(page, base) {
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
  const enginePrefs = () => page.evaluate(async () => {
    const t = document.querySelector('meta[name="lucid-token"]')?.content ?? "";
    const r = await fetch("/api/viz/prefs", { headers: { "x-lucid-token": t } });
    return (await r.json().catch(() => null))?.data?.prefs ?? null;
  });
  const quality = () => page.evaluate(() => window.__vizProbe?.quality?.() ?? null);
  const openViz = async () => {
    await page.goto(new URL("?vizScript=1", base).href, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ctViz", { timeout: 30_000 });
    await skipGates();
    // A wiped origin also forgets which first-run toasts were seen ("Make LucidAgent yours", a theme suggestion);
    // they sit over the Visualize header's right end. Dismissing them is setup, not the proof.
    await pause(1500);
    for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});
    await pause(300);
    await click("#ctViz", "the Visualize button");
    await until(() => shown("#vizView [data-viz-stage]"), "Visualize did not open", 10_000);
    await skipGates();
    await until(async () => (await quality())?.scene, "the scene did not report its quality", 20_000);
  };
  const openMenu = async () => {
    if (!(await shown(".viz-vmenu"))) await click("#vizView [data-viz-viewmenu]", "the View button");
    await until(() => shown(".viz-vmenu [data-viz-motion]"), "the View menu did not open", 4000);
  };
  const closeMenu = async () => { if (await shown(".viz-vmenu")) await click("#vizView [data-viz-viewmenu]", "the View button"); await pause(200); };
  const menuState = () => page.evaluate(() => ({
    layout: document.querySelector('.viz-vmenu [data-viz-layout][aria-pressed="true"]')?.getAttribute("data-viz-layout") ?? null,
    motion: document.querySelector('.viz-vmenu [data-viz-motion][aria-pressed="true"]')?.getAttribute("data-viz-motion") ?? null,
    fly: document.querySelector(".viz-vmenu input[data-viz-flyask]")?.checked ?? null,
  }));

  const cdp = await page.target().createCDPSession();
  const setSize = async (s) => { await cdp.send("Emulation.setDeviceMetricsOverride", { width: s.width, height: s.height, deviceScaleFactor: 0, mobile: false }); await pause(700); };
  const results = [];
  try {
    // A reduced-motion system, so Always animate is visible in the scene (particles), not just in the menu.
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await setSize(SIZES[0]);
    await openViz();
    // 1. three choices with real clicks
    await openMenu();
    await click('.viz-vmenu [data-viz-layout="constellation"]', "Constellation");
    await click('.viz-vmenu [data-viz-motion="always"]', "Always animate");
    if ((await menuState()).fly) await click(".viz-vmenu input[data-viz-flyask]", "Fly to approvals");
    const picked = await menuState();
    assert(picked.layout === "constellation" && picked.motion === "always" && picked.fly === false, `the clicks did not take: ${JSON.stringify(picked)}`);
    await closeMenu();
    const kept = await until(async () => {
      const p = await enginePrefs();
      const v = p?.[VIEW_KEY] ? JSON.parse(p[VIEW_KEY]) : null;
      return v?.layout === "constellation" && v?.motion === "always" && p?.[FLY_KEY] === "0" ? p : null;
    }, "the engine did not keep the choices (GET /api/viz/prefs)", 5000);
    results.push({ engine: { [VIEW_KEY]: JSON.parse(kept[VIEW_KEY]), [FLY_KEY]: kept[FLY_KEY] } });

    // 2. a port-rolled launch: a new origin, an empty localStorage
    await page.evaluate(() => localStorage.clear());

    // 3. the choices come back, wide and narrow
    for (const size of SIZES) {
      await setSize(size);
      await openViz();
      await openMenu();
      const back = await until(async () => { const s = await menuState(); return s.layout === "constellation" && s.motion === "always" && s.fly === false ? s : null; },
        `${size.name}: after the wipe the View menu shows ${JSON.stringify(await menuState())}, not the kept choices`, 6000);
      for (const sel of ['.viz-vmenu [data-viz-layout="constellation"]', '.viz-vmenu [data-viz-motion="always"]']) {
        const r = await rect(sel);
        const hit = await page.evaluate((x, y, s) => !!document.elementFromPoint(x, y)?.closest(s), (r.left + r.right) / 2, (r.top + r.bottom) / 2, sel);
        assert(hit, `${size.name}: ${sel} is covered`);
      }
      const q = await until(async () => { const v = await quality(); return v?.scene?.particles > 0 ? v : null; }, `${size.name}: the scene is not drawn with Always animate`, 15_000);
      await closeMenu();
      results.push({ size: size.name, menu: back, scene: `${q.tier}, ${q.scene.particles} particles` });
    }
    const mirrored = await page.evaluate((k) => localStorage.getItem(k), VIEW_KEY);
    assert(mirrored && JSON.parse(mirrored).motion === "always", "the localStorage mirror was not filled again from the engine");
    results.push({ mirror: "refilled from the engine" });
  } finally {
    // Leave the QA engine as it was: Follow system, Orbit, Fly to approvals on.
    await page.evaluate(async (vk, fk) => {
      const t = document.querySelector('meta[name="lucid-token"]')?.content ?? "";
      for (const key of [vk, fk]) await fetch("/api/viz/prefs", { method: "POST", headers: { "content-type": "application/json", "x-lucid-token": t }, body: JSON.stringify({ key, value: null }) }).catch(() => {});
      localStorage.removeItem(vk); localStorage.removeItem(fk);
    }, VIEW_KEY, FLY_KEY).catch(() => {});
    if (await shown("#vizView [data-viz-stage]").catch(() => false)) await page.$eval("[data-viz-close]", (b) => b.click()).catch(() => {});
    await cdp.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_viz_prefs_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const url = process.env.LUCID_DEMO_URL;
  if ((!endpoint && !browserURL) || !url) throw new Error("Set LUCID_DEMO_CDP_URL (or LUCID_DEMO_BROWSER_URL) and LUCID_DEMO_URL.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(endpoint ? { browserWSEndpoint: endpoint } : { browserURL }), defaultViewport: null, protocolTimeout: 120_000 });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url));
    if (!page) throw new Error(`No page at ${url}`);
    console.log(JSON.stringify(await verifyVizPrefs(page, url), null, 2));
    console.log("P-VIZ.PREFS1 passed: Visualize choices made with real clicks are kept by the engine and come back after the renderer's localStorage is wiped (a port-rolled launch), wide and narrow.");
  } finally { await browser.disconnect(); }
}
