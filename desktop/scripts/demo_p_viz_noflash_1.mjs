// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_viz_noflash_1.mjs
//
// P-VIZ.NOFLASH1: real-browser proof that Visualize never flashes a black (or white) frame under CPU pressure. Before
// the fix a quality change (the Auto governor's step-down, or the user's Quality pick) destroyed the scene and mounted
// a new WebGL canvas (alpha: false) at once, hiding the spinner after two animation frames: on a starved main thread
// the user saw a black canvas, then the scene, once per tier step. This script:
//   1. opens Visualize (#ctViz) and, when the ?vizDemo=1 probe lists a usable installed world, selects it through the
//      real Worlds menu (a light sky makes a black frame obvious), then closes and reopens Visualize under x10 CPU:
//      when the start spinner goes, the saved world must already be drawn (before the fix the anime scene showed
//      for seconds, then the world popped in);
//   2. records the page with CDP Page.startScreencast (jpeg, every frame) for about 20 s while the CPU is throttled
//      (Emulation.setCPUThrottlingRate 6, then 10);
//   3. forces tier changes the ways the UI makes them: the governor's miss (the probe's governorMiss, the very path a
//      missed frame budget takes; Auto only) and the View menu's Quality button, clicked through a full cycle so the
//      mode ends where it started (Auto, Full, Reduced, Minimal, Ultra, Cinematic);
//   4. watches the stage: every canvas added is a remount; the stage must never be left without a canvas, and the
//      "Starting the 3D view" spinner must not come back for a remount (the old picture stays until the new scene
//      has drawn);
//   5. decodes every frame's mean luminance over a region inside the canvas (clear of the header, the View menu, the
//      legend, the tray and toasts) in a separate about:blank page (OffscreenCanvas), and FAILS on a flash: a frame
//      that is near-black or near-white while the frames around it are not (|L - median(neighbours)| past the
//      threshold; the neighbours skip the 3 frames on each side, so a 1 to 3 frame flash cannot hide itself).
// Prints the remount count, the longest swap, and the worst frame. The caller owns the page, engine and browser
// lifecycle; run it against an isolated QA engine or a second instance, never a user's working session. The CPU
// throttle and the Quality mode are restored afterwards.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 bun desktop/scripts/demo_p_viz_noflash_1.mjs

const RECORD_MS = 20000;
/** Luminance (0..255) at or below which a frame is near-black, at or above which near-white. */
const NEAR_BLACK = 16;
const NEAR_WHITE = 240;
/** A flash departs from its neighbours' median by more than this (absolute) and by more than this share of the
 *  room it had (toward black: the median itself; toward white: 255 minus the median). */
const FLASH_MIN = 12;
const FLASH_SHARE = 0.5;
/** A blank frame is also flat: its luminance standard deviation over the region is at most this. A bright frame
 *  with detail (a camera pan across snow in the Christmas world) is content, not a flash. */
const BLANK_SD = 10;
/** The neighbours of frame i: frames i-NEAR_TO..i-SKIP and i+SKIP..i+NEAR_TO. */
const SKIP = 4;
const NEAR_TO = 12;
/** Frames decoded per page.evaluate (each is a base64 jpeg). */
const BATCH = 16;

export async function verifyNoFlash(page) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  const probe = (fn, ...args) => page.evaluate((f, a) => window.__vizProbe?.[f]?.(...a), fn, args);
  const hasProbe = async (fn) => (await page.evaluate((f) => typeof window.__vizProbe?.[f], fn)) === "function";
  const dismissToasts = async () => { for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {}); };

  // 1. Visualize, settled on its first scene
  if (!(await page.$eval("#vizView", (v) => !v.hidden && v.getBoundingClientRect().width > 0).catch(() => false))) await page.click("#ctViz");
  await page.waitForSelector("#vizView [data-viz-stage] canvas.viz-cv", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector("#vizView [data-viz-loading]")?.hidden === true, { timeout: 20000 })
    .catch(() => { throw new Error("the 3D view never finished starting (the spinner is still up)"); });
  await pause(1200);
  await dismissToasts();

  let world = null;
  if (await hasProbe("worlds")) {
    const usable = ((await probe("worlds")) ?? []).filter((w) => !w.error && w.access === "allowed");
    if (usable.length) {
      world = usable[0];
      if (!(await page.$(`[data-viz-world-pick="${world.style}"]`))) await page.click("#vizView [data-viz-worlds]");
      await page.waitForSelector(`[data-viz-world-pick="${world.style}"]`, { visible: true, timeout: 5000 });
      await page.click(`[data-viz-world-pick="${world.style}"]`);
      await pause(2500); // a world with a sky of the other lightness remounts: let it land before recording
    }
  }

  // 1b. the saved world draws from the first visible frame: close, then reopen under x10 CPU; when the spinner goes,
  // the Worlds button must already name the world (before the fix the anime scene showed for seconds, then the world)
  let reopen = null;
  if (world) {
    await page.click("#vizView [data-viz-close]");
    await page.waitForFunction(() => document.querySelector("#vizView")?.hidden === true, { timeout: 5000 });
    await page.evaluate(() => {
      const loading = document.querySelector("#vizView [data-viz-loading]");
      const r = { shown: false, label: null, mo: null };
      r.mo = new MutationObserver(() => {
        if (!loading.hidden) { r.shown = true; return; }
        if (r.shown && r.label === null) r.label = document.querySelector("#vizView [data-viz-worlds-label]")?.textContent?.trim() ?? "";
      });
      r.mo.observe(loading, { attributes: true, attributeFilter: ["hidden"] });
      window.__noflashReveal = r;
    });
    const throttle = await page.target().createCDPSession();
    try {
      await throttle.send("Emulation.setCPUThrottlingRate", { rate: 10 });
      await page.click("#ctViz");
      await page.waitForFunction(() => window.__noflashReveal?.label !== null, { timeout: 90000 })
        .catch(() => { throw new Error("reopening Visualize under x10 CPU: the scene never revealed"); });
    } finally {
      await throttle.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
      await throttle.detach().catch(() => {});
    }
    reopen = await page.evaluate(() => { const r = window.__noflashReveal; r.mo.disconnect(); delete window.__noflashReveal; return { shown: r.shown, label: r.label }; });
    // the button reads "Worlds" while no world is drawn (paintToggles), the world's name once it is
    assert(!!reopen.label && reopen.label !== "Worlds", `reopened on the built-in style ("${reopen.label}") before the saved world "${world.label}" was drawn`);
    await pause(1500);
    await dismissToasts();
  }

  // the region the luminance is measured over: inside the canvas, left of the View menu, above the legend and tray
  const stage = await page.$eval("#vizView [data-viz-stage]", (n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  assert(stage.w > 200 && stage.h > 200, `the stage is too small to measure: ${JSON.stringify(stage)}`);
  const region = { x0: stage.x + stage.w * 0.08, x1: stage.x + stage.w * 0.6, y0: stage.y + stage.h * 0.2, y1: stage.y + stage.h * 0.72 };

  // 4. the stage watch: canvases added (remounts), the fewest canvases at any moment, the longest two-canvas swap,
  // and the spinner coming back. Installed by this script on its own page, removed in the finally.
  await page.evaluate(() => {
    const st = document.querySelector("#vizView [data-viz-stage]");
    const loading = st.querySelector("[data-viz-loading]");
    const w = { added: 0, minCanvases: Infinity, maxCanvases: 0, swapStart: 0, longestSwapMs: 0, spinnerShows: 0, mo: null };
    const count = () => st.querySelectorAll("canvas.viz-cv").length;
    w.mo = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === "attributes" && m.target === loading && !loading.hidden) w.spinnerShows++;
        for (const n of m.addedNodes) if (n instanceof HTMLCanvasElement && n.classList.contains("viz-cv")) w.added++;
      }
      const c = count();
      w.minCanvases = Math.min(w.minCanvases, c);
      w.maxCanvases = Math.max(w.maxCanvases, c);
      const now = performance.now();
      if (c >= 2 && !w.swapStart) w.swapStart = now;
      if (c < 2 && w.swapStart) { w.longestSwapMs = Math.max(w.longestSwapMs, now - w.swapStart); w.swapStart = 0; }
    });
    w.mo.observe(st, { childList: true });
    w.mo.observe(loading, { attributes: true, attributeFilter: ["hidden"] });
    window.__noflashWatch = w;
  });

  const modeOf = (label) => (label.startsWith("Auto") ? "auto" : label.toLowerCase());
  const qualityLabel = () => page.$eval("[data-viz-quality]", (b) => b.textContent.trim());
  const withViewMenu = async (fn) => {
    // A click can land while another popover (the Worlds menu) is open, which only closes that one: retry.
    // A closing popover can still be in the DOM: wait for it to go before reopening.
    await page.waitForFunction(() => !document.querySelector("[data-viz-quality]"), { timeout: 6000 }).catch(() => {});
    for (let i = 0; i < 4 && !(await page.$("[data-viz-quality]")); i++) {
      await page.click("#vizView [data-viz-viewmenu]");
      await page.waitForSelector("[data-viz-quality]", { visible: true, timeout: 6000 }).catch(() => {});
    }
    await page.waitForSelector("[data-viz-quality]", { visible: true, timeout: 15000 });
    try { return await fn(); } finally {
      if (await page.$("[data-viz-quality]")) await page.click("#vizView [data-viz-viewmenu]").catch(() => {});
      await page.waitForFunction(() => !document.querySelector("[data-viz-quality]"), { timeout: 6000 }).catch(() => {});
    }
  };
  const clickQuality = () => withViewMenu(async () => { await page.click("[data-viz-quality]"); return qualityLabel(); });
  const startMode = modeOf(await withViewMenu(qualityLabel));

  const cdp = await page.target().createCDPSession();
  const frames = [];
  const steps = [];
  const onFrame = (f) => {
    frames.push({ data: f.data, at: f.metadata.timestamp ?? Date.now() / 1000, dw: f.metadata.deviceWidth, dh: f.metadata.deviceHeight });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  };
  let decodePage = null;
  try {
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 960, maxHeight: 960, everyNthFrame: 1 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    const t0 = Date.now();
    const at = async (ms) => { const wait = t0 + ms - Date.now(); if (wait > 0) await pause(wait); };
    const miss = async (label) => {
      if (!(await hasProbe("governorMiss"))) { steps.push({ at: Date.now() - t0, via: label, skipped: "no probe (open with ?vizDemo=1)" }); return; }
      steps.push({ at: Date.now() - t0, via: label, stepped: await probe("governorMiss") });
    };
    const pick = async (label) => steps.push({ at: Date.now() - t0, via: label, now: await clickQuality() });

    // 3. the governor's step-down, then a whole Quality cycle (6 clicks: back where it started), throttle 6 then 10
    await at(1500); await miss("governor miss (x6 CPU)");
    await at(4000); await pick("Quality click 1 (x6 CPU)");
    await at(6000); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 10 });
    await at(7000); await pick("Quality click 2 (x10 CPU)");
    await at(9500); await pick("Quality click 3 (x10 CPU)");
    await at(12000); await pick("Quality click 4 (x10 CPU)");
    await at(14500); await pick("Quality click 5 (x10 CPU)");
    await at(16500); await pick("Quality click 6 (x10 CPU)");
    await at(18500); await miss("governor miss again (x10 CPU)");
    await at(RECORD_MS);
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    await cdp.send("Page.stopScreencast").catch(() => {});
    cdp.off("Page.screencastFrame", onFrame);
    for (let i = 0; i < 6; i++) { // the Quality mode ends where it started
      const now = await withViewMenu(qualityLabel).catch(() => null);
      if (now === null || modeOf(now) === startMode) break;
      await clickQuality().catch(() => {});
    }
    await cdp.detach().catch(() => {});
  }
  const watch = await page.evaluate(() => {
    const w = window.__noflashWatch;
    w.mo.disconnect();
    delete window.__noflashWatch;
    return { remounts: w.added, minCanvases: w.minCanvases, maxCanvases: w.maxCanvases, longestSwapMs: Math.round(w.longestSwapMs), spinnerShows: w.spinnerShows };
  });
  assert(frames.length >= 20, `the screencast delivered only ${frames.length} frames`);

  // 5. luminance per frame, decoded in a separate about:blank page (falls back to this page, throttle already off)
  try { decodePage = await page.browser().newPage(); await decodePage.goto("about:blank"); } catch { decodePage = null; }
  const decoder = decodePage ?? page;
  const luma = [];
  try {
    for (let i = 0; i < frames.length; i += BATCH) {
      const batch = frames.slice(i, i + BATCH).map((f) => ({ data: f.data, dw: f.dw, dh: f.dh }));
      luma.push(...(await decoder.evaluate(async (list, r) => {
        const out = [];
        for (const f of list) {
          const bin = atob(f.data);
          const bytes = new Uint8Array(bin.length);
          for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
          const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
          const sx = bmp.width / (f.dw || bmp.width), sy = bmp.height / (f.dh || bmp.height);
          const x0 = Math.max(0, Math.round(r.x0 * sx)), y0 = Math.max(0, Math.round(r.y0 * sy));
          const w = Math.max(1, Math.min(bmp.width - x0, Math.round((r.x1 - r.x0) * sx)));
          const h = Math.max(1, Math.min(bmp.height - y0, Math.round((r.y1 - r.y0) * sy)));
          const oc = new OffscreenCanvas(w, h);
          const ctx = oc.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(bmp, x0, y0, w, h, 0, 0, w, h);
          bmp.close();
          const d = ctx.getImageData(0, 0, w, h).data;
          let sum = 0, sq = 0, n = 0;
          for (let p = 0; p < d.length; p += 16) { const y = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]; sum += y; sq += y * y; n++; }
          const mean = n ? sum / n : 0;
          out.push({ mean, sd: n ? Math.sqrt(Math.max(0, sq / n - mean * mean)) : 0 });
        }
        return out;
      }, batch, region)));
    }
  } finally { await decodePage?.close().catch(() => {}); }

  // the flash check: near-black or near-white while the neighbours (skipping 3 frames each side) are not
  const median = (a) => { const s = [...a].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN; };
  const flagged = [];
  let worst = { index: -1, at: 0, luma: 0, neighbours: 0, delta: 0 };
  for (let i = 0; i < luma.length; i++) {
    const near = [];
    for (let j = i - NEAR_TO; j <= i + NEAR_TO; j++) if (j >= 0 && j < luma.length && Math.abs(j - i) >= SKIP) near.push(luma[j].mean);
    if (near.length < 3) continue;
    const med = median(near), L = luma[i].mean, delta = Math.abs(L - med);
    const room = L < med ? med : 255 - med;
    if (delta > worst.delta) worst = { index: i, at: +(frames[i].at - frames[0].at).toFixed(3), luma: +L.toFixed(1), sd: +luma[i].sd.toFixed(1), neighbours: +med.toFixed(1), delta: +delta.toFixed(1) };
    const extreme = L <= NEAR_BLACK || L >= NEAR_WHITE;
    if (extreme && luma[i].sd <= BLANK_SD && delta > Math.max(FLASH_MIN, FLASH_SHARE * room)) flagged.push(i);
  }
  const runs = [];
  for (const i of flagged) {
    const last = runs[runs.length - 1];
    if (last && i === last.to + 1) last.to = i; else runs.push({ from: i, to: i });
  }
  const flashes = runs.map((r) => ({
    frames: r.to - r.from + 1, at: +(frames[r.from].at - frames[0].at).toFixed(3),
    luma: luma.slice(r.from, r.to + 1).map((x) => +x.mean.toFixed(1)),
    sd: luma.slice(r.from, r.to + 1).map((x) => +x.sd.toFixed(1)),
  }));

  // LUCID_DEMO_SHOTS: keep each flash's frames and the frames 6 before and after, to look at what flashed.
  if (process.env.LUCID_DEMO_SHOTS && runs.length) {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(process.env.LUCID_DEMO_SHOTS, { recursive: true });
    for (const r of runs) for (let i = Math.max(0, r.from - 6); i <= Math.min(frames.length - 1, r.to + 6); i++) {
      writeFileSync(join(process.env.LUCID_DEMO_SHOTS, `noflash-${String(i).padStart(5, "0")}${i >= r.from && i <= r.to ? "-FLASH" : ""}.jpg`), Buffer.from(frames[i].data, "base64"));
    }
  }

  const result = {
    world: world?.style ?? null, reopen, frames: frames.length, region: { x: Math.round(region.x0), y: Math.round(region.y0), w: Math.round(region.x1 - region.x0), h: Math.round(region.y1 - region.y0) },
    steps, startMode, ...watch, worst, flashes, pageErrors: errors,
  };
  console.log(JSON.stringify(result, null, 2));
  console.log(`remounts: ${watch.remounts}; longest swap: ${watch.longestSwapMs} ms; worst frame: #${worst.index} at ${worst.at} s, luma ${worst.luma} vs neighbours ${worst.neighbours}`);
  assert(watch.remounts >= 6, `only ${watch.remounts} remounts happened: the tier changes did not run`);
  assert(watch.minCanvases >= 1, "the stage was left without a canvas during a remount");
  assert(watch.spinnerShows === 0, `the "Starting the 3D view" spinner came back ${watch.spinnerShows} time(s) during remounts`);
  assert(!flashes.length, `${flashes.length} flash(es) inside the canvas: ${JSON.stringify(flashes)}`);
  return result;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_viz_noflash_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    await verifyNoFlash(page);
    console.log("P-VIZ.NOFLASH1 passed: under x6 and x10 CPU throttling, every tier change (the governor's step-down and a full Quality cycle) swapped scenes with no black or white frame, no empty stage and no spinner.");
  } finally { await browser.disconnect(); }
}
