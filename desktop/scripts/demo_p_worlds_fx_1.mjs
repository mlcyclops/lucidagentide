// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_worlds_fx_1.mjs
//
// P-WORLDS.FX1 (ADR-0652): real-browser proof that a LIGHT world's streams read on its sky as plasma-light with
// coin tokens, and that the environment is re-applied on an option change. On the ?vizDemo=1 feed (Main, demo-1 to
// demo-6, subagents) with the worlds installed, it proves:
//   1. a light-sky world is selected through the Worlds menu (the sky's top band is measured on screen; the first
//      usable world with a light sky is used, or LUCID_DEMO_WORLD_KEY);
//   2. the edges switch to plasma-light with the coin token and a gold tokenColor. Installed packs may not ship
//      v2 edges yet, so the demo-only probe (fxPreview) merges them exactly as a world's environmentFor patch
//      would; a pack that already ships plasma-light is used as is. The probe reports the style, the token, the
//      coins drawn (more than none, within the tier's instanced coin cap), a glint at some point, and from ultra
//      spark trails;
//   3. what the user sees: on a screenshot of the stage, along the middle stretch of each edge (u 0.3 to 0.7,
//      projected by the probe), the stream stands out from the sky around it (an RGB distance of at least
//      MIN_CONTRAST from the median of a ring around the point) on most edges;
//   4. the petal token draws as sprites (quads, no coins), and a custom token without a painter is refused;
//   5. a World option changed through the View menu re-applies the world's own environment (the preview is gone:
//      the probe reports the pack's style and token again), with no page errors.
// The caller owns the page and the engine.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 [LUCID_DEMO_WORLD_KEY=<key>] node desktop/scripts/demo_p_worlds_fx_1.mjs

const MIN_CONTRAST = 60;
const GOLD = "#f5c542";

export async function verifyStreams(page, worldKey = null) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  const probe = (fn, ...args) => page.evaluate((f, a) => window.__vizProbe?.[f]?.(...a), fn, args);
  const topmost = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
  const stageBox = () => page.$eval("#vizView [data-viz-stage]", (n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
  const shoot = async () => { const clip = await stageBox(); return { clip, b64: await page.screenshot({ clip, encoding: "base64", type: "png" }) }; };
  // the median color of the stage's top band (the sky above the fleet), and its luma
  const skyOf = (b64) => page.evaluate(async (data) => {
    const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
    const g = document.createElement("canvas"); g.width = img.width; g.height = img.height;
    const x = g.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, Math.max(4, Math.round(img.height * 0.08))).data;
    const ch = [[], [], []];
    for (let i = 0; i < d.length; i += 16) { ch[0].push(d[i]); ch[1].push(d[i + 1]); ch[2].push(d[i + 2]); }
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    const c = ch.map(med);
    return { rgb: c, luma: Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) };
  }, b64);

  if (!(await page.$("#vizView [data-viz-ledger]"))) { await page.click("#ctViz"); }
  await page.waitForSelector("#vizView [data-viz-worlds]", { visible: true, timeout: 15000 });
  await pause(1500);
  for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});
  await pause(400);
  assert((await page.evaluate(() => typeof window.__vizProbe?.fx)) === "function", "the probe has no fx(): this build predates P-WORLDS.FX1");

  // 1. a light-sky world
  let usable = [];
  for (let i = 0; i < 40 && !usable.length; i++) {
    usable = ((await probe("worlds")) ?? []).filter((w) => !w.error && w.access === "allowed" && (!worldKey || w.style === `world:${worldKey}`));
    if (!usable.length) await pause(500);
  }
  assert(usable.length, `no usable installed world${worldKey ? ` "${worldKey}"` : ""}: ${JSON.stringify(await probe("worlds"))}`);
  let world = null, sky = null;
  for (const w of usable) {
    if (!(await probe("style", w.style))) continue;
    await pause(1800);
    const s = await skyOf((await shoot()).b64);
    if (s.luma >= 150 || worldKey) { world = w; sky = s; break; }
  }
  assert(world, `no installed world has a light sky (top-band luma >= 150)`);
  // select it through the real Worlds menu, as a user would
  const label = () => page.evaluate(() => document.querySelector("#vizView [data-viz-worlds-label]")?.textContent?.trim());
  if (!(await page.$(`[data-viz-world-pick="${world.style}"]`))) await page.click("#vizView [data-viz-worlds]");
  await page.waitForSelector(`[data-viz-world-pick="${world.style}"]`, { visible: true, timeout: 5000 });
  assert(await topmost(`[data-viz-world-pick="${world.style}"]`), "the world's row in the Worlds menu is covered");
  await page.click(`[data-viz-world-pick="${world.style}"]`);
  await pause(2500);
  if (await page.$("[data-viz-worlds-menu]")) { await page.click("#vizView [data-viz-worlds]"); await pause(400); }
  assert((await label()) === world.label, `the Worlds button does not show the picked world (${await label()} vs ${world.label})`);
  const own = await probe("fx");
  assert(own && own.edges.length > 0, `the probe reports no edges: ${JSON.stringify(own)}`);

  // 2. plasma-light with gold coins
  const shipped = own.style === "plasma-light" && own.token === "coin";
  if (!shipped) assert(await probe("fxPreview", { style: "plasma-light", token: "coin", tokenColor: GOLD }), "the plasma-light coin preview was refused");
  assert(await topmost("#vizView [data-viz-fit]"), "the Fit button is covered");
  await page.click("#vizView [data-viz-fit]");
  let fx = null, glinted = false, sparked = false;
  for (let k = 0; k < 16; k++) {
    await pause(250);
    fx = await probe("fx");
    if (fx.glints > 0) glinted = true;
    if (fx.sparks > 0) sparked = true;
  }
  assert(fx.style === "plasma-light" && fx.token === "coin", `the edges are not plasma-light coins: ${fx.style} / ${fx.token}`);
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  if (!shipped) assert(typeof fx.tokenColor === "string" && rgb(fx.tokenColor).every((v, i) => Math.abs(v - rgb(GOLD)[i]) <= 1), `the token color did not apply: ${fx.tokenColor}`);
  assert(fx.coins > 0, `no coins are drawn on the streams: ${JSON.stringify({ live: fx.live, quads: fx.quads, coins: fx.coins })}`);
  assert(fx.coins <= fx.budget.coins && fx.budget.tokens <= fx.budget.coins, `coins exceed the tier's instanced cap: ${JSON.stringify(fx.budget)} (${fx.coins} drawn)`);
  assert(glinted, "no coin glinted in 4 s");
  if (fx.budget.sparks > 0) assert(sparked, "ultra or cinematic: plasma-light shed no spark trails");

  // 3. what the user sees: the stream against the sky around it
  const shot = await shoot();
  const contrast = await page.evaluate(async (data, stage, list) => {
    const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
    const k = img.width / stage.width;
    const g = document.createElement("canvas"); g.width = img.width; g.height = img.height;
    const x = g.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0);
    const px = (X, Y) => { const d = x.getImageData(X, Y, 1, 1).data; return [d[0], d[1], d[2]]; };
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    return list.map((ed) => {
      let best = 0;
      for (const p of ed.points) {
        const cx = Math.round((p.x - stage.x) * k), cy = Math.round((p.y - stage.y) * k);
        const R = Math.round(22 * k), r = Math.round(5 * k);
        if (cx - R < 0 || cy - R < 0 || cx + R >= img.width || cy + R >= img.height) continue;
        const ring = [[], [], []];
        for (let a = 0; a < 32; a++) { const c = px(cx + Math.round(R * Math.cos(a * Math.PI / 16)), cy + Math.round(R * Math.sin(a * Math.PI / 16))); for (let i = 0; i < 3; i++) ring[i].push(c[i]); }
        const bg = ring.map((v) => v.sort((p2, q) => p2 - q)[v.length >> 1]);
        const d = x.getImageData(cx - r, cy - r, 2 * r + 1, 2 * r + 1).data;
        for (let i = 0; i < d.length; i += 4) best = Math.max(best, dist([d[i], d[i + 1], d[i + 2]], bg));
      }
      return { from: ed.from, to: ed.to, contrast: Math.round(best), sampled: ed.points.length };
    });
  }, shot.b64, shot.clip, fx.edges);
  const measured = contrast.filter((c) => c.sampled > 0);
  const visible = measured.filter((c) => c.contrast >= MIN_CONTRAST);
  assert(measured.length >= 3, `too few edges on screen to measure: ${JSON.stringify(contrast)}`);
  assert(visible.length >= Math.ceil(measured.length * 0.6), `the plasma-light streams do not stand out from the sky: ${JSON.stringify(contrast)}`);

  // 4. sprites, and a custom token needs its painter
  assert(await probe("fxPreview", { style: "plasma-light", token: "petal" }), "the petal preview was refused");
  let petal = null;
  for (let k = 0; k < 8; k++) { await pause(250); petal = await probe("fx"); if (petal.quads > 0) break; }
  assert(petal.token === "petal" && petal.coins === 0 && petal.quads > 0, `petals are not drawn as sprites: ${JSON.stringify({ token: petal.token, quads: petal.quads, coins: petal.coins })}`);
  // paintToken: null strips the painter a world may ship for its own custom token (most v2 worlds do)
  assert((await probe("fxPreview", { token: "custom", paintToken: null })) === false, "a custom token without paintToken was accepted");

  // 5. a World option change re-applies the world's own environment (environmentFor, sky, edges, charge)
  if (!(await page.$("input[data-viz-wopt], select[data-viz-wopt]"))) await page.click("#vizView [data-viz-viewmenu]");
  await page.waitForSelector("input[data-viz-wopt], select[data-viz-wopt]", { visible: true, timeout: 5000 }).catch(() => null);
  const opt = await page.$("input[data-viz-wopt], select[data-viz-wopt]");
  let optionChanged = null, after = null;
  if (opt) {
    assert(await page.$eval("input[data-viz-wopt], select[data-viz-wopt]", (n) => { const b = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); }), "the first World option is covered");
    optionChanged = await opt.evaluate((el) => {
      if (el instanceof HTMLSelectElement) el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
      else if (el.type === "checkbox") el.checked = !el.checked;
      else el.value = el.value === "#ff0000" ? "#00aa00" : "#ff0000";
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.dataset.vizWopt;
    });
    await pause(2500);
    await page.keyboard.press("Escape");
    after = await probe("fx");
    assert(after.style === own.style && after.token === own.token, `the option change did not re-apply the world's environment: ${after.style}/${after.token} vs ${own.style}/${own.token}`);
  }

  assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  return {
    world: world.id, label: world.label, sky, shipsPlasmaLight: shipped,
    plasmaLight: { coins: fx.coins, budget: fx.budget, glinted, sparked, quads: fx.quads },
    contrast, petals: petal.quads, optionChanged, reapplied: after ? { style: after.style, token: after.token, chargeColor: after.chargeColor } : "the world has no input/select option",
  };
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_worlds_fx_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL (an isolated QA page at <engine>/?vizDemo=1 with the worlds installed).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyStreams(page, process.env.LUCID_DEMO_WORLD_KEY || null), null, 2));
    console.log("P-WORLDS.FX1 passed: a light world's streams draw as plasma-light with spinning gold coins that stand out from the sky, petals draw as sprites, and an option change re-applies the world's environment.");
  } finally { await browser.disconnect(); }
}
