// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_viz_gpu_1.mjs
//
// P-VIZ.GPU1 (ADR-0651): real-browser proof of GPU-aware quality tiers. On the ?vizDemo=1 feed (Main, demo-1 to
// demo-6, subagents), with real input, it proves:
//   1. the probe sees the GPU (window.__vizProbe.quality(), read-only, ?vizDemo=1 / ?vizScript=1 only) and the
//      Quality control in the View menu reads "Auto · <tier> (<GPU name>)" under Auto;
//   2. clicking Quality cycles Auto, Full, Reduced, Minimal, Ultra and Cinematic, and each tier remounts the scene
//      with its renderer settings: pixel ratio capped at the tier's cap (1, 1.25, 1.5, 2, 2), MSAA 4 on the
//      post-processing target from ultra, bloom (on light themes too from ultra), contact shadows under the 3D
//      figures from ultra, SSAO and depth of field on cinematic, and the tier's particle budget;
//   3. the frame budget: every tier runs its 3 s frame-time check (busy frames after the scene settles); an
//      explicit tier is never stepped down even when it misses, and under Auto a miss steps down one tier until a
//      check passes (or minimal is reached);
//   4. the Quality control is on top (elementFromPoint) and the View menu passes the spacing audit (auditBoxes,
//      ADR-0633) at every tier's label.
// The user's Quality mode is restored at the end (it persists in localStorage). The caller owns the page and the
// engine (a QA instance, never a working session).
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 node desktop/scripts/demo_p_viz_gpu_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const TIERS = {
  minimal: { dprCap: 1, particles: 600, msaa: 0, post: false, bloomDark: false, bloomLight: false, shadows: false, ssao: false, dof: false },
  reduced: { dprCap: 1.25, particles: 2500, msaa: 0, post: false, bloomDark: false, bloomLight: false, shadows: false, ssao: false, dof: false },
  full: { dprCap: 1.5, particles: 6000, msaa: 0, post: null, bloomDark: true, bloomLight: false, shadows: false, ssao: false, dof: false },
  ultra: { dprCap: 2, particles: 12000, msaa: 4, post: true, bloomDark: true, bloomLight: true, shadows: true, ssao: false, dof: false },
  cinematic: { dprCap: 2, particles: 12000, msaa: 4, post: true, bloomDark: true, bloomLight: true, shadows: true, ssao: true, dof: true },
};
const MODES = ["auto", "full", "reduced", "minimal", "ultra", "cinematic"];

export async function verifyGpuTiers(page) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  const probe = (fn, ...args) => page.evaluate((f, a) => window.__vizProbe?.[f]?.(...a), fn, args);
  const quality = () => probe("quality");
  const topmost = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
  const waitFor = async (what, fn, ms) => {
    const until = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await pause(250); }
  };

  if (!(await page.$("#vizView [data-viz-ledger]"))) { await page.click("#ctViz"); }
  await page.waitForSelector("#vizView [data-viz-viewmenu]", { visible: true, timeout: 15000 });
  await pause(1500);
  for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});
  await pause(400);
  const q0 = await quality();
  assert(q0 && "scene" in q0, "the probe has no quality(): this build predates P-VIZ.GPU1");
  const startMode = q0.mode;
  // contact shadows, SSAO and DOF are 3D effects
  if (await page.$('#vizView [data-viz-view="3d"]')) { await page.click('#vizView [data-viz-view="3d"]'); await pause(600); }

  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  const openMenu = async () => {
    if (!(await page.$(".viz-vmenu [data-viz-quality]"))) { await page.click("#vizView [data-viz-viewmenu]"); await pause(350); }
    await page.waitForSelector(".viz-vmenu [data-viz-quality]", { visible: true, timeout: 5000 });
  };
  const label = () => page.$eval(".viz-vmenu [data-viz-quality]", (n) => n.textContent.trim().replace(/\s+/g, " "));
  const clickQuality = async () => {
    await openMenu();
    assert(await topmost(".viz-vmenu [data-viz-quality]"), "the Quality control is covered");
    await page.click(".viz-vmenu [data-viz-quality]");
  };

  // walk to Auto first (real clicks), then visit every mode once in cycle order
  for (let i = 0; i < MODES.length && (await quality()).mode !== "auto"; i++) { await clickQuality(); await pause(500); }
  assert((await quality()).mode === "auto", "Quality never reached Auto");
  const report = {};
  for (let step = 0; step < MODES.length; step++) {
    const mode = MODES[step];
    const q = await waitFor(`${mode} to mount`, async () => { const x = await quality(); return x?.mode === mode && x.scene && x.scene.tier === x.tier ? x : null; }, 15000);
    await openMenu();
    const text = await label();
    if (mode === "auto") {
      const want = `Auto \u00b7 ${q.tier}${q.gpu?.name ? ` (${q.gpu.name})` : ""}`;
      assert(text === want, `Auto label "${text}" is not "${want}"`);
    } else {
      assert(text.toLowerCase() === mode, `the ${mode} label reads "${text}"`);
    }
    const spacing = await page.evaluate(auditBoxes, ".viz-vmenu", MIN_GAP);
    assert(spacing.length === 0, `View menu spacing at ${mode}: ${spacing.join(" | ")}`);

    // the renderer settings of the tier
    const s = q.scene, t = TIERS[s.tier];
    assert(t, `unknown tier ${s.tier}`);
    assert(Math.abs(s.pixelRatio - Math.min(dpr, t.dprCap)) < 1e-6, `${s.tier}: pixel ratio ${s.pixelRatio}, want min(${dpr}, ${t.dprCap})`);
    assert(s.particles === t.particles || s.particles === 0, `${s.tier}: particles ${s.particles}, want ${t.particles}`); // 0 under reduced motion
    const bloomWant = s.lightTheme ? t.bloomLight : t.bloomDark;
    assert(s.bloom === bloomWant, `${s.tier}: bloom ${s.bloom} on a ${s.lightTheme ? "light" : "dark"} theme, want ${bloomWant}`);
    if (t.post === true) assert(s.post, `${s.tier}: no post-processing`);
    if (t.post === false) assert(!s.post, `${s.tier}: post-processing runs`);
    assert(s.msaa === t.msaa, `${s.tier}: MSAA ${s.msaa}, want ${t.msaa}`);
    assert(s.ssao === t.ssao && s.dof === t.dof, `${s.tier}: SSAO ${s.ssao} / DOF ${s.dof}, want ${t.ssao} / ${t.dof}`);
    if (t.shadows) assert(s.contactShadows >= 7, `${s.tier}: only ${s.contactShadows} figures stand on a contact shadow`);
    else assert(s.contactShadows === 0, `${s.tier}: contact shadows below ultra`);

    // the frame budget: the 3 s check completes; an explicit tier stays, Auto steps down on a miss
    const checked = await waitFor(`${mode}'s frame-time check`, async () => { const x = await quality(); return x?.scene && x.scene.governor.verdict !== "pending" ? x : null; }, 30000);
    const g = checked.scene.governor;
    const entry = { tier: checked.tier, gpu: checked.gpu, settings: { pixelRatio: s.pixelRatio, msaa: s.msaa, bloom: s.bloom, bloomStrength: s.bloomStrength, ssao: s.ssao, dof: s.dof, dofActive: s.dofActive, contactShadows: s.contactShadows, particles: s.particles }, frames: { verdict: g.verdict, frames: g.frames, meanMs: Math.round(g.meanMs * 10) / 10, budgetMs: Math.round(g.budgetMs * 10) / 10, slowShare: Math.round(g.slowShare * 100) / 100 } };
    if (mode === "auto") {
      // a miss steps Auto down one tier and the new tier checks again, until a check passes or minimal is reached
      let cur = checked;
      const path = [cur.tier];
      while (cur.scene.governor.verdict === "miss" && cur.tier !== "minimal") {
        const from = cur.tier;
        cur = await waitFor(`Auto to step down from ${from}`, async () => { const x = await quality(); return x?.scene && x.tier !== from && x.scene.tier === x.tier ? x : null; }, 5000);
        assert(cur.steppedFrom !== null, "Auto stepped down without reporting where from");
        path.push(cur.tier);
        cur = await waitFor(`${cur.tier}'s frame-time check`, async () => { const x = await quality(); return x?.scene && x.scene.governor.verdict !== "pending" ? x : null; }, 30000);
      }
      assert(cur.scene.governor.verdict === "ok" || cur.tier === "minimal", `Auto settled at ${cur.tier} and still misses its frame budget`);
      entry.autoPath = path;
    } else {
      await pause(1200);
      const after = await quality();
      assert(after.mode === mode && after.tier === mode, `the explicit ${mode} tier was changed to ${after.tier}: an explicit tier must always win`);
    }
    report[mode] = entry;
    await clickQuality(); // on to the next mode (cinematic wraps to auto)
    await pause(300);
  }

  // restore the user's mode
  for (let i = 0; i < MODES.length && (await quality()).mode !== startMode; i++) { await clickQuality(); await pause(500); }
  if (await page.$(".viz-vmenu")) { await page.click("#vizView [data-viz-viewmenu]"); await pause(200); }
  assert((await quality()).mode === startMode, `could not restore the Quality mode ${startMode}`);
  assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  return { devicePixelRatio: dpr, gpu: q0.gpu, restoredMode: startMode, tiers: report };
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_viz_gpu_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL (an isolated QA page at <engine>/?vizDemo=1).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyGpuTiers(page), null, 2));
    console.log("P-VIZ.GPU1 passed: the GPU was probed, Quality cycles all six modes with each tier's renderer settings, explicit tiers hold, and Auto settles within its frame budget.");
  } finally { await browser.disconnect(); }
}
