// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1
// desktop/scripts/demo_p_viz_flash_1.mjs
//
// P-VIZ.FLASH1 (ADR-0687): real-browser proof that Visualize in 3D never shows an empty (flat, background-colored)
// frame while agents work. Before the fix, on the ultra tier (a discrete GPU picks it under Auto) the additive glows
// stacked in front of the auto camera summed past half-float's max in the composer's scene target; one Inf pixel
// became NaN in the bloom blur and the ACES tone map and the whole canvas presented one empty frame. Measured on a
// Radeon RX 580 (D3D11) under x6 CPU: 8 and 13 such frames in 35 s; after the fix 0.
//
// Against an isolated QA engine (start_qa_fleet.mjs) this script:
//   1. starts seed_fleet.mjs (six scripted lanes and Main, a fresh round every 20 s) so tokens, arcs and particles flow;
//   2. opens Visualize with the real toolbar button, picks 3D and Anime with their real buttons, Quality left on Auto;
//   3. records the page with CDP Page.startScreencast for LUCID_DEMO_SECS (default 35) under x6 CPU throttling;
//   4. decodes every frame's luminance over a region inside the canvas (clear of the header, legend and tray) and
//      FAILS on an empty frame: flat (standard deviation <= 3), dark, and at least 15 below the median of its
//      neighbours (skipping 3 frames each side, so a short run cannot hide itself); also fails on a lost WebGL
//      context. A dark frame with detail (the auto camera looking into empty space) is content, not a flash.
// Prints the tier the scene ran at; the flash only reproduced on ultra, so a machine that lands on full or below
// proves less (the script says so).
//
// Run (QA engine: bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7821; a Chrome with a CDP port and a GPU):
//   LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7821/ node desktop/scripts/demo_p_viz_flash_1.mjs

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const HERE = dirname(fileURLToPath(import.meta.url));
const SECS = Number(process.env.LUCID_DEMO_SECS ?? 35);
const THROTTLE = 6;
/** An empty frame: flat, dark, and well below its neighbours. */
const FLAT_SD = 3, DARK = 24, DROP = 15, SKIP = 4, NEAR_TO = 12;

export async function verifyNoEmptyFrames(browser, base) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  try {
    await page.setViewport({ width: 1400, height: 860 });
    await page.evaluateOnNewDocument(() => {
      window.__flashCtx = { lost: 0 };
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        const ctx = orig.call(this, type, ...rest);
        if (ctx && /webgl/.test(type) && !this.__flashHooked) {
          this.__flashHooked = true;
          this.addEventListener("webglcontextlost", () => { window.__flashCtx.lost++; });
        }
        return ctx;
      };
    });
    await page.goto(new URL("?vizDemo=1", base).href, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ctViz", { timeout: 30000 });
    for (let i = 0, idle = 0; i < 40 && idle < 8; i++) { // a fresh QA profile shows first-run gates
      const skip = await page.$("#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]");
      if (!skip) { idle++; await pause(500); continue; }
      idle = 0;
      await skip.click().catch(() => {});
      await pause(400);
    }
    for (const t of await page.$$("#toasts .toast .h button")) await t.click().catch(() => {});
    await page.click("#ctViz");
    await page.waitForSelector("#vizView [data-viz-stage] canvas.viz-cv", { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector("#vizView [data-viz-loading]")?.hidden === true, { timeout: 30000 });
    for (const label of ["3D", "Anime"]) {
      const b = await page.evaluateHandle((l) => [...document.querySelectorAll("#vizView button")].find((x) => x.textContent.trim() === l) ?? null, label);
      const el = b.asElement();
      assert(el, `no ${label} button in Visualize`);
      await el.click();
      await pause(800);
    }
    await pause(3000);
    for (const t of await page.$$("#toasts .toast .h button")) await t.click().catch(() => {});
    const agents = (await page.evaluate(() => window.__vizProbe?.nodes?.() ?? [])).filter((n) => n.kind === "agent").length;
    assert(agents >= 2, `only ${agents} agents are drawn: the seeded fleet did not start`);

    const stage = await page.$eval("#vizView [data-viz-stage]", (n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const region = { x0: stage.x + stage.w * 0.08, x1: stage.x + stage.w * 0.6, y0: stage.y + stage.h * 0.2, y1: stage.y + stage.h * 0.72 };
    const cdp = await page.createCDPSession();
    const frames = [];
    const onFrame = (f) => { frames.push({ data: f.data, at: f.metadata.timestamp, dw: f.metadata.deviceWidth, dh: f.metadata.deviceHeight }); cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); };
    cdp.on("Page.screencastFrame", onFrame);
    try {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 960, maxHeight: 960, everyNthFrame: 1 });
      await pause(SECS * 1000);
    } finally {
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
      cdp.off("Page.screencastFrame", onFrame);
      await cdp.detach().catch(() => {});
    }
    const quality = await page.evaluate(() => window.__vizProbe?.quality?.() ?? null);
    const lost = await page.evaluate(() => window.__flashCtx.lost);
    assert(frames.length >= 100, `the screencast delivered only ${frames.length} frames`);

    const dec = await browser.newPage();
    const luma = [];
    try {
      await dec.goto("about:blank");
      for (let i = 0; i < frames.length; i += 16) {
        luma.push(...(await dec.evaluate(async (list, r) => {
          const out = [];
          for (const f of list) {
            const bin = atob(f.data);
            const bytes = new Uint8Array(bin.length);
            for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
            const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
            const sx = bmp.width / (f.dw || bmp.width), sy = bmp.height / (f.dh || bmp.height);
            const x0 = Math.round(r.x0 * sx), y0 = Math.round(r.y0 * sy);
            const w = Math.max(1, Math.round((r.x1 - r.x0) * sx)), h = Math.max(1, Math.round((r.y1 - r.y0) * sy));
            const oc = new OffscreenCanvas(w, h);
            const ctx = oc.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(bmp, x0, y0, w, h, 0, 0, w, h);
            bmp.close();
            const d = ctx.getImageData(0, 0, w, h).data;
            let s = 0, q = 0, n = 0;
            for (let p = 0; p < d.length; p += 16) { const y = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]; s += y; q += y * y; n++; }
            const m = n ? s / n : 0;
            out.push({ mean: m, sd: n ? Math.sqrt(Math.max(0, q / n - m * m)) : 0 });
          }
          return out;
        }, frames.slice(i, i + 16).map((f) => ({ data: f.data, dw: f.dw, dh: f.dh })), region)));
      }
    } finally { await dec.close().catch(() => {}); }

    const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
    const flagged = [];
    for (let i = 0; i < luma.length; i++) {
      const near = [];
      for (let j = i - NEAR_TO; j <= i + NEAR_TO; j++) if (j >= 0 && j < luma.length && Math.abs(j - i) >= SKIP) near.push(luma[j].mean);
      if (near.length < 3) continue;
      const L = luma[i];
      if (L.sd <= FLAT_SD && L.mean <= DARK && median(near) - L.mean >= DROP) flagged.push(i);
    }
    const runs = [];
    for (const i of flagged) { const last = runs[runs.length - 1]; if (last && i === last.to + 1) last.to = i; else runs.push({ from: i, to: i }); }
    const flashes = runs.map((r) => ({ frames: r.to - r.from + 1, at: +(frames[r.from].at - frames[0].at).toFixed(2), luma: +luma[r.from].mean.toFixed(1) }));
    const result = { tier: quality?.tier ?? null, bloom: quality?.scene?.bloom ?? null, msaa: quality?.scene?.msaa ?? null, agents, frames: frames.length, lostContexts: lost, flashes, pageErrors: errors };
    console.log(JSON.stringify(result, null, 2));
    if (result.tier !== "ultra" && result.tier !== "cinematic") console.log(`note: the scene ran at "${result.tier}"; the flash reproduced on ultra (a discrete GPU), so this run proves less.`);
    assert(lost === 0, `${lost} WebGL context(s) were lost while recording`);
    assert(!flashes.length, `${flashes.length} empty frame run(s) inside the canvas: ${JSON.stringify(flashes)}`);
    assert(!errors.length, `page errors: ${errors.join(" | ")}`);
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const wsEndpoint = process.env.LUCID_DEMO_CDP_URL;
  const base = process.env.LUCID_DEMO_URL;
  if ((!browserURL && !wsEndpoint) || !base) {
    console.log("demo_p_viz_flash_1: set LUCID_DEMO_BROWSER_URL (or LUCID_DEMO_CDP_URL) and LUCID_DEMO_URL to an isolated QA engine.");
    return;
  }
  assert(new URL(base).hostname === "127.0.0.1", "LUCID_DEMO_URL must be an isolated QA engine on 127.0.0.1");
  const seeder = spawn("bun", [join(HERE, "fleet_demo", "seed_fleet.mjs"), base, "--every", "20", "--lanes", "6"], { stdio: "ignore" });
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(wsEndpoint ? { browserWSEndpoint: wsEndpoint } : { browserURL }), defaultViewport: null });
  try {
    await pause(8000); // the lanes spawn and their first turns start streaming
    await verifyNoEmptyFrames(browser, base);
    console.log("P-VIZ.FLASH1 passed: 3D Visualize with the fleet working under x6 CPU presented no empty frame and lost no WebGL context.");
  } finally {
    browser.disconnect();
    seeder.kill();
  }
}

if (process.argv[1]?.endsWith("demo_p_viz_flash_1.mjs")) {
  main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
}
