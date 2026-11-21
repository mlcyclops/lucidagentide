// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_viz_7.mjs
//
// P-VIZ.7 (ADR-0641): real-browser check of sponsors, size classes and the git commit animation, on the ?vizDemo=1
// feed (the page must already be at <engine>/?vizDemo=1 with first-run gates done). It proves:
//   1. the demo's six agents wear six sponsors (Claude, GPT, Gemini, Grok, a second Claude, TL187 for the
//      self-hosted model) across all three size classes;
//   2. a commit window (demo-6 commits from 8 s to about 17 s of the 48 s cycle) is reported for that agent only;
//   3. anime, 3D: while demo-6 commits, the sky above its cube holds a bright blue-white bolt (many more bright
//      pixels there than after the commit ends); professional and 2D render the commit without errors;
//   4. no uncaught page errors in either style or view.
// Screenshots of each style during the commit go to $TEMP (viz7-demo-*.png) for a human look.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 node desktop/scripts/demo_p_viz_7.mjs

export async function verifyViz7(page, opts = {}) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shots = opts.shots ?? null;
  const errors = [];
  const onError = (e) => errors.push(String(e?.message ?? e));
  page.on("pageerror", onError);
  const probe = () => page.evaluate(() => window.__vizProbe?.nodes() ?? []);
  const node = async (id) => (await probe()).find((n) => n.id === id);
  // Bright blue-white pixels (a lightning core and its glow) in the band above a node's frame.
  const bright = async (id, label = "") => {
    const n = await node(id);
    if (!n?.box) return -1;
    const vw = await page.evaluate(() => [innerWidth, innerHeight]);
    // A narrow column between the cube's top edge and the cloud, where only the bolt climbs (plasma edges cross it rarely).
    const x = Math.max(0, n.box.x - n.box.r * 0.7), y = Math.max(0, n.box.y - n.box.r * 3.2);
    const clip = { x, y, width: Math.min(n.box.r * 1.4, vw[0] - x), height: Math.max(4, n.box.y - n.box.r * 1.9 - y) };
    const b64 = await page.screenshot({ clip, encoding: "base64" });
    if (shots && label) await page.screenshot({ clip, path: `${shots}/viz7-demo-band-${label}.png` });
    return page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      let count = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i + 2] > 215 && px[i + 1] > 200 && px[i] > 150 && px[i + 2] >= px[i]) count++;
      return count;
    }, b64);
  };
  // Seconds into the demo's 48 s cycle (the feed starts when Visualize opens).
  let t0 = 0;
  const at = async (s) => { const wait = t0 + s * 1000 - Date.now(); if (wait > 0) await pause(wait); };
  const open = async (style, view) => {
    await page.evaluate(() => document.querySelector('#vizView [data-viz-close], #vizView [aria-label="Close"]')?.click());
    await pause(300);
    await page.evaluate(() => { document.querySelector("#fleetDock [data-dock-min]")?.click(); document.getElementById("ctViz")?.click(); });
    await page.waitForSelector("#vizView [data-viz-ledger]", { visible: true, timeout: 8000 });
    t0 = Date.now();
    await page.evaluate((s, v) => {
      document.querySelector(`#vizView [data-viz-style="${s}"]`)?.click();
      document.querySelector(`#vizView [data-viz-view="${v}"]`)?.click();
    }, style, view);
    await pause(1500);
    await page.evaluate(() => { document.querySelectorAll(".toast").forEach((t) => t.remove()); document.querySelector("#vizView button[data-viz-fit]")?.click(); });
    await pause(1200);
  };
  const results = {};
  try {
    // 1 + 2 + 3: anime, 3D
    await open("anime", "3d");
    const list = await probe();
    const agents = list.filter((n) => n.id.startsWith("demo-"));
    const brands = new Set(agents.map((n) => n.brand));
    const sizes = new Set(agents.map((n) => n.size));
    for (const b of ["anthropic", "openai", "google", "xai", "tl187"]) assert(brands.has(b), `no ${b} sponsor among ${[...brands].join(", ")}`);
    for (const s of ["large", "mid", "small"]) assert(sizes.has(s), `no ${s} figure among ${[...sizes].join(", ")}`);
    assert(agents.find((n) => n.id === "demo-6")?.brand === "tl187", "the self-hosted model does not wear TL187");
    results.sponsors = agents.map((n) => `${n.id}:${n.brand}:${n.size}`);

    await at(11);
    const mid = await probe();
    assert(mid.find((n) => n.id === "demo-6")?.committing === true, "demo-6 is not committing inside its commit window");
    assert(mid.find((n) => n.id === "demo-2")?.committing === false, "demo-2 reads as committing without a commit call");
    const during = await bright("demo-6", "during");
    if (shots) await page.screenshot({ path: `${shots}/viz7-demo-anime-commit.png` });
    await at(21);
    assert((await node("demo-6"))?.committing === false, "demo-6 still reads as committing after its commit settled");
    const after = await bright("demo-6", "after");
    // The band can catch a plasma edge or a glint, so "after" is not always zero; the bolt's blue glow dwarfs it.
    assert(during >= 3 * after + 15, `no lightning above demo-6 while it committed (bright px during ${during}, after ${after})`);
    results.bolt = { during, after };

    // 3: professional, 3D, and anime 2D render the commit without errors
    for (const [style, view] of [["professional", "3d"], ["anime", "2d"], ["professional", "2d"]]) {
      await open(style, view);
      await at(11);
      assert((await node("demo-6"))?.committing === true, `${style} ${view}: demo-6 is not committing in its window`);
      if (shots) await page.screenshot({ path: `${shots}/viz7-demo-${style}-${view}-commit.png` });
    }
    assert(errors.length === 0, `page errors: ${errors.slice(0, 3).join(" | ")}`);
    results.errors = 0;
  } finally {
    page.off("pageerror", onError);
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_viz_7.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine (?vizDemo=1).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyViz7(page, { shots: process.env.TEMP ?? null }), null, 2));
    console.log("P-VIZ.7 passed: six sponsors across three sizes, the commit window is per agent, the anime commit draws its bolt, and every style and view renders the commit without errors.");
  } finally { await browser.disconnect(); }
}
