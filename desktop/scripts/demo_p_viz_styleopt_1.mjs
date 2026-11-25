// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_viz_styleopt_1.mjs
//
// P-VIZ.STYLEOPT1 (ADR-0688): the built-in Visualize styles (Anime, Professional) have their own options in the View
// menu, like an installed world's. Against an isolated QA engine, in a FRESH browser context (its own localStorage),
// on the ?vizDemo=1 feed, with the real controls:
//   1. the first-run gates are cleared; Visualize opens on Anime; the View menu shows "Anime options";
//   2. every background is picked and the stage's sky band is sampled: Sunset is warmer than Nebula, Studio and a
//      light Solid color are lighter, Aurora is greener, and a light Solid color flips the scene light (the remount);
//   3. every value of every option (selects, both toggle states, two colors, every swatch) is set through its control,
//      each control is on top (elementFromPoint) and the probe (window.__vizProbe.builtinLook) reports it; the
//      Particles option scales the scene's particle budget (Half, Off);
//   4. the values persist: after a reload the menu reads them back;
//   5. Professional: "Professional options", the floor grid toggles a visible change in the stage (pixels, with reduced
//      motion for a still scene, against a no-change baseline) and the probe reports it; Reset restores the defaults;
//   6. auditBoxes (ADR-0633) passes on the View menu for both styles, and no page error is raised anywhere.
//
// Run (QA engine: bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7821, and a Chrome with a CDP port):
//   LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7821/ node desktop/scripts/demo_p_viz_styleopt_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const GATES = "#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]";
const MENU = ".popover.show .viz-vmenu";
/** viz_model.vizTierOpts' flow particle budget per tier (0 under reduced motion). */
const TIER_PARTICLES = { minimal: 600, reduced: 2500, full: 6000, ultra: 12000, cinematic: 12000 };

async function clearGates(page) {
  let empty = 0;
  for (let i = 0; i < 40 && empty < 8; i++) {
    const hit = await page.evaluate((sel) => {
      const b = [...document.querySelectorAll(sel)].find((n) => n.getBoundingClientRect().width > 0);
      if (b) { b.click(); return true; }
      return false;
    }, GATES);
    empty = hit ? 0 : empty + 1;
    await pause(450);
  }
  for (const t of await page.$$("#toasts .toast .h button")) await t.click().catch(() => {});
}

async function openViz(page) {
  await page.waitForSelector("#ctViz", { timeout: 30000 });
  await clearGates(page);
  if (!(await page.$("#vizView [data-viz-ledger]"))) {
    const c = await page.$eval("#ctViz", (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.click(c.x, c.y);
  }
  await page.waitForSelector("#vizView [data-viz-viewmenu]", { visible: true, timeout: 15000 });
  await waitFor("the scene", () => page.evaluate(() => window.__vizProbe?.builtinLook?.() ?? null), 20000);
  await pause(800);
}

async function waitFor(what, fn, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await pause(250);
  }
}

async function openMenu(page) {
  if (!(await page.$(MENU))) {
    await pause(200); // a closing menu leaves the DOM 160 ms after Escape
    await page.click("#vizView [data-viz-viewmenu]");
    await page.waitForSelector(MENU, { visible: true, timeout: 5000 });
    await pause(300);
  }
}

/** Escape only while the View menu is open: with nothing open, Escape closes Visualize. */
async function closeMenu(page) {
  if (await page.$(MENU)) { await page.keyboard.press("Escape"); await pause(350); }
}

async function readOptions(page) {
  await openMenu(page);
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll(".popover.show [data-viz-wopts] [data-viz-wopt]")) {
      const key = el.dataset.vizWopt;
      if (el instanceof HTMLSelectElement) out.push({ key, type: "select", values: [...el.options].map((o) => o.value), current: el.value });
      else if (el.type === "checkbox") out.push({ key, type: "toggle", values: [!el.checked, el.checked], current: el.checked });
      else out.push({ key, type: "color", values: ["#e53935", "#1e88e5"], current: el.value.toLowerCase() });
    }
    const sw = new Map();
    for (const b of document.querySelectorAll(".popover.show [data-viz-wopts] [data-viz-wopt-sw]")) {
      const key = b.dataset.vizWoptSw;
      if (!sw.has(key)) sw.set(key, { key, type: "swatch", values: [], current: null });
      const o = sw.get(key);
      o.values.push(b.dataset.value);
      if (b.getAttribute("aria-pressed") === "true") o.current = b.dataset.value;
    }
    return [...out, ...sw.values()];
  });
}

/** Set one option through its control (scrolled into view and on top at its center, elementFromPoint). */
async function setOption(page, key, type, value) {
  await openMenu(page);
  const r = await page.evaluate((k, t, v) => {
    const el = t === "swatch"
      ? [...document.querySelectorAll(".popover.show [data-viz-wopt-sw]")].find((n) => n.dataset.vizWoptSw === k && n.dataset.value === v)
      : [...document.querySelectorAll(".popover.show [data-viz-wopt]")].find((n) => n.dataset.vizWopt === k);
    if (!el) return "missing";
    el.scrollIntoView({ block: "nearest" });
    const b = el.getBoundingClientRect();
    if (!el.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2))) return "covered";
    if (t === "swatch") { el.click(); return "ok"; }
    if (t === "toggle") el.checked = v; else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return "ok";
  }, key, type, value);
  assert(r === "ok", `option ${key} = ${JSON.stringify(value)}: the control is ${r}`);
}

/** The scene has (re)mounted and drawn: the spinner is gone and the probe answers. */
async function settled(page, ms = 1200) {
  await pause(300);
  await waitFor("the scene to draw", () => page.evaluate(() => {
    const l = document.querySelector("#vizView [data-viz-loading]");
    return (!l || l.hidden) && !document.querySelector("#vizView .viz-cv-out") && !!window.__vizProbe?.builtinLook?.();
  }), 15000);
  await pause(ms);
}

async function stageBox(page) {
  return page.$eval("#vizView [data-viz-stage]", (n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
}

/** Pixel data of a screenshot region, decoded in the page (createImageBitmap: no data: URL, so no CSP question). */
async function shot(page, clip) {
  const b64 = await page.screenshot({ clip, encoding: "base64", type: "png" });
  return { b64, clip };
}

async function stats(page, s) {
  return page.evaluate(async (src) => {
    const bin = atob(src);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext("2d");
    x.drawImage(bmp, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let r = 0, g = 0, b = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    r /= n; g /= n; b /= n;
    return { r, g, b, lum: 0.2126 * r + 0.7152 * g + 0.0722 * b };
  }, s.b64);
}

/** The share of pixels that differ clearly between two shots of the same region. */
async function diff(page, a, b) {
  return page.evaluate(async (s1, s2) => {
    const px = async (src) => {
      const bin = atob(src);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      const x = c.getContext("2d");
      x.drawImage(bmp, 0, 0);
      return x.getImageData(0, 0, c.width, c.height).data;
    };
    const d1 = await px(s1), d2 = await px(s2);
    let changed = 0;
    for (let i = 0; i < d1.length; i += 4) if (Math.abs(d1[i] - d2[i]) + Math.abs(d1[i + 1] - d2[i + 1]) + Math.abs(d1[i + 2] - d2[i + 2]) > 24) changed++;
    return changed / (d1.length / 4);
  }, a.b64, b.b64);
}

const probe = (page, fn) => page.evaluate((f) => window.__vizProbe?.[f]?.() ?? null, fn);

async function menuChecks(page, heading) {
  await openMenu(page);
  const h = await page.$$eval(`${MENU} .viz-vmenu-h`, (ns) => ns.map((n) => n.textContent.trim()));
  assert(h.some((t) => t.toLowerCase() === heading.toLowerCase()), `the View menu has no "${heading}" section: ${JSON.stringify(h)}`);
  const spacing = await page.evaluate(auditBoxes, MENU, MIN_GAP);
  assert(spacing.length === 0, `View menu spacing (${heading}): ${spacing.join(" | ")}`);
  const reset = await page.$eval(`${MENU} [data-viz-wopt-reset]`, (n) => {
    n.scrollIntoView({ block: "nearest" });
    const b = n.getBoundingClientRect();
    return n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2));
  }).catch(() => null);
  assert(reset === true, `the ${heading} Reset control is ${reset === null ? "missing" : "covered"}`);
}

export async function verifyStyleOptions(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  const report = {};
  await openViz(page);
  if (await page.$('#vizView [data-viz-view="3d"]')) { await page.click('#vizView [data-viz-view="3d"]'); await pause(500); }
  await page.click('#vizView [data-viz-style="anime"]');
  await waitFor("Anime", async () => (await probe(page, "builtinLook"))?.style === "anime", 10000);
  await settled(page);

  // 1. the Anime options panel
  await menuChecks(page, "Anime options");

  // 2. every background, with the sky sampled from the top down to the horizon (left part of the stage, menu closed):
  // a gradient backdrop such as Sunset is purple at the top and warm toward the horizon, so a thin top band misreads it
  const st = await stageBox(page);
  const sky = { x: Math.round(st.x + st.width * 0.04), y: Math.round(st.y + st.height * 0.1), width: Math.round(st.width * 0.4), height: Math.round(st.height * 0.45) };
  await setOption(page, "bgColor", "color", "#ece6d6"); // a light Solid color: Solid flips the scene light
  const bg = {};
  for (const value of ["nebula", "night", "sunset", "aurora", "studio", "deep", "solid"]) {
    await setOption(page, "background", "select", value);
    await closeMenu(page);
    await waitFor(`background ${value}`, async () => (await probe(page, "builtinLook"))?.background === value, 15000);
    await settled(page);
    bg[value] = { ...(await stats(page, await shot(page, sky))), light: (await probe(page, "quality"))?.scene?.lightTheme ?? null };
  }
  report.backgrounds = bg;
  const warm = (s) => s.r - s.b;
  assert(warm(bg.sunset) > warm(bg.nebula) + 8, `Sunset is not warmer than Nebula: ${JSON.stringify({ sunset: bg.sunset, nebula: bg.nebula })}`);
  if (!bg.nebula.light) { // the default dark theme: the soft gray studio and a light solid color read lighter
    assert(bg.studio.lum > bg.nebula.lum + 8, `Studio is not lighter than Nebula: ${bg.studio.lum} vs ${bg.nebula.lum}`);
    assert(bg.solid.lum > bg.nebula.lum + 60, `a light Solid color is not lighter than Nebula: ${bg.solid.lum} vs ${bg.nebula.lum}`);
    assert(bg.night.light === false && bg.deep.light === false, "Night sky or Deep space drew a light scene");
  } else { // a light theme: Night sky flips the scene dark
    assert(Math.abs(bg.studio.lum - bg.nebula.lum) > 4, `Studio looks like Nebula: ${bg.studio.lum} vs ${bg.nebula.lum}`);
    assert(bg.night.light === false && bg.night.lum < bg.nebula.lum - 60, `Night sky did not draw a dark scene on a light theme: ${JSON.stringify(bg.night)}`);
  }
  assert(bg.solid.light === true, `a light Solid color did not draw a light scene: ${JSON.stringify(bg.solid)}`);
  assert(bg.aurora.g - bg.aurora.r > bg.nebula.g - bg.nebula.r, `Aurora is not greener than Nebula: ${JSON.stringify({ aurora: bg.aurora, nebula: bg.nebula })}`);
  assert(bg.nebula.light === bg.studio.light, "Studio does not follow the theme's light");
  await setOption(page, "background", "select", "nebula");
  await closeMenu(page);
  await settled(page);

  // 3. every value of every option through its control
  const opts = await readOptions(page);
  const keys = opts.map((o) => o.key);
  for (const k of ["background", "bgColor", "stars", "drift", "accent", "particles", "lighting", "labels", "plate"]) assert(keys.includes(k), `Anime options lack ${k}: ${keys.join(", ")}`);
  const full = (await probe(page, "quality"))?.scene?.particles ?? 0;
  let applied = 0;
  for (const o of opts) {
    for (const v of o.values) {
      await setOption(page, o.key, o.type, v);
      applied++;
      await pause(o.key === "background" || o.key === "accent" || o.key === "particles" || o.key === "bgColor" ? 900 : 250);
      if (o.key === "particles") {
        await settled(page, 300);
        const q = await probe(page, "quality");
        const p = q?.scene?.particles;
        const base = full === 0 ? 0 : TIER_PARTICLES[q?.scene?.tier] ?? full; // the governor may step the tier down meanwhile
        const want = v === "off" ? 0 : v === "half" ? Math.round(base / 2) : base;
        assert(p === want, `Particles ${v}: the scene budget is ${p} at ${q?.scene?.tier}, want ${want}`);
      }
      const look = await probe(page, "builtinLook");
      assert(look, `no built-in look after ${o.key} = ${JSON.stringify(v)}`);
      if (o.key === "labels") assert(look.labels === v, `Name tags ${v}: the scene draws ${look.labels}`);
      if (o.key === "lighting") assert(look.lighting === v, `Lighting ${v}: the scene lights ${look.lighting}`);
    }
  }
  report.applied = applied;
  await settled(page, 400);
  const before = await readOptions(page);
  const saved = Object.fromEntries(before.map((o) => [o.key, o.current]));

  // 4. persistence across a reload
  await page.reload({ waitUntil: "domcontentloaded" });
  await openViz(page);
  const after = Object.fromEntries((await readOptions(page)).map((o) => [o.key, o.current]));
  assert(JSON.stringify(after) === JSON.stringify(saved), `the Anime options did not persist: ${JSON.stringify({ saved, after })}`);
  report.persisted = saved;
  await closeMenu(page);

  // 5. Professional: the floor grid, still scene (reduced motion), 3D
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.click('#vizView [data-viz-style="professional"]');
  await waitFor("Professional", async () => (await probe(page, "builtinLook"))?.style === "professional", 15000);
  await settled(page, 1500);
  await menuChecks(page, "Professional options");
  const pro = await readOptions(page);
  for (const k of ["grid", "desk"]) assert(pro.some((o) => o.key === k), `Professional options lack ${k}`);
  assert(pro.find((o) => o.key === "background")?.current === "studio", "Professional does not default to Studio");
  await setOption(page, "grid", "toggle", false);
  await closeMenu(page);
  await settled(page, 800);
  const floor = { x: Math.round(st.x + st.width * 0.04), y: Math.round(st.y + st.height * 0.55), width: Math.round(st.width * 0.55), height: Math.round(st.height * 0.4) };
  // The ?vizDemo=1 feed keeps tokens and chips moving even under reduced motion, so one pair of shots is noisy: take
  // three shots per state and require the grid-on vs grid-off difference to clearly exceed the same-state noise.
  const shots = async () => { const out = []; for (let i = 0; i < 3; i++) { out.push(await shot(page, floor)); await pause(500); } return out; };
  const off = await shots();
  await setOption(page, "grid", "toggle", true);
  await closeMenu(page);
  await settled(page, 800);
  const g = await probe(page, "builtinLook");
  assert(g?.grid === true, `the probe does not report the floor grid: ${JSON.stringify(g)}`);
  const on = await shots();
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const within = mean([await diff(page, off[0], off[1]), await diff(page, off[1], off[2]), await diff(page, on[0], on[1]), await diff(page, on[1], on[2])]);
  const between = mean([await diff(page, off[0], on[0]), await diff(page, off[1], on[1]), await diff(page, off[2], on[2])]);
  report.grid = { within, between };
  assert(between > Math.max(0.01, within * 1.5) && between - within > 0.02, `the floor grid made no visible change: ${(between * 100).toFixed(2)}% of pixels between states vs ${(within * 100).toFixed(2)}% within a state`);
  await openMenu(page);
  await page.click(`${MENU} [data-viz-wopt-reset]`);
  await pause(600);
  const reset = Object.fromEntries((await readOptions(page)).map((o) => [o.key, o.current]));
  assert(reset.grid === false && reset.background === "studio" && reset.desk === "tinted", `Reset did not restore the defaults: ${JSON.stringify(reset)}`);
  await closeMenu(page);
  await settled(page, 300);
  assert((await probe(page, "builtinLook"))?.grid === false, "the grid is still drawn after Reset");
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);

  assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  return report;
}

async function main() {
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const wsEndpoint = process.env.LUCID_DEMO_CDP_URL;
  const base = process.env.LUCID_DEMO_URL;
  if ((!browserURL && !wsEndpoint) || !base) {
    console.log("demo_p_viz_styleopt_1: set LUCID_DEMO_BROWSER_URL (or LUCID_DEMO_CDP_URL) and LUCID_DEMO_URL to an isolated QA engine.");
    return;
  }
  const url = new URL(base);
  assert(url.hostname === "127.0.0.1", "LUCID_DEMO_URL must be an isolated QA engine on 127.0.0.1");
  url.searchParams.set("vizDemo", "1");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(wsEndpoint ? { browserWSEndpoint: wsEndpoint } : { browserURL }), defaultViewport: null });
  // a fresh profile: its own localStorage, so first-run gates and saved options start clean
  const ctx = browser.createBrowserContext ? await browser.createBrowserContext() : await browser.createIncognitoBrowserContext();
  try {
    const page = await ctx.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    const r = await verifyStyleOptions(page);
    console.log(JSON.stringify(r, null, 2));
    console.log("P-VIZ.STYLEOPT1 passed: Anime and Professional options draw, persist and reset through the View menu.");
  } finally {
    await ctx.close().catch(() => {});
    browser.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("demo_p_viz_styleopt_1.mjs")) {
  main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
}
