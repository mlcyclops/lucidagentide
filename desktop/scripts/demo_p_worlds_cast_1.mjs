// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_worlds_cast_1.mjs
//
// P-WORLDS.CAST1 (ADR-0649): real-browser proof that a Lucid Agent World casts the demo fleet as six different
// people. On the ?vizDemo=1 feed (Main, demo-1 to demo-6, subagents) with a world already installed, with real
// input, it proves:
//   1. the Worlds menu selects the installed world (the button shows its label);
//   2. the cast the host passed to the six agent figures (read from the demo-only probe, ?vizDemo=1 / ?vizScript=1,
//      the same read-only probe P-VIZ.6 added): six distinct appearances, at least 2 feminine and 2 masculine, and
//      light, medium and dark skin (the demo feed adds Main and then its six lanes, so they hold consecutive slots).
//      A world that casts agents as creatures gets no appearance; then only step 3 applies;
//   3. what the user sees: Fit (the header button) frames everyone, one screenshot of the stage, and in the head
//      half of each agent's frame the median of the skin-like pixels. At least 4 agents give a reading, at least 3
//      of them differ and they span light and deep (this holds for v1 packs too: they read the mixed seed).
// The caller owns the page and the engine. LUCID_DEMO_WORLD_KEY picks the world ("christmas"); default: the first
// usable one.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 [LUCID_DEMO_WORLD_KEY=<key>] node desktop/scripts/demo_p_worlds_cast_1.mjs

const AGENTS = ["demo-1", "demo-2", "demo-3", "demo-4", "demo-5", "demo-6"];

export async function verifyCast(page, worldKey = null) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  const probe = (fn, ...args) => page.evaluate((f, a) => window.__vizProbe?.[f]?.(...a), fn, args);
  const topmost = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });

  if (!(await page.$("#vizView [data-viz-ledger]"))) { await page.click("#ctViz"); }
  await page.waitForSelector("#vizView [data-viz-worlds]", { visible: true, timeout: 15000 });
  await pause(1500);
  // boot-time toasts sit at the top right over the header (the sheet tier, on purpose): close them first
  for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});
  await pause(400);

  // 1. pick the installed world through the Worlds menu
  let world = null;
  for (let i = 0; i < 40 && !world; i++) {
    const ws = (await probe("worlds")) ?? [];
    world = ws.find((w) => !w.error && w.access === "allowed" && (!worldKey || w.style === `world:${worldKey}`)) ?? null;
    if (!world) await pause(500);
  }
  assert(world, `no usable installed world${worldKey ? ` "${worldKey}"` : ""}: ${JSON.stringify(await probe("worlds"))}`);
  const label = () => page.evaluate(() => document.querySelector("#vizView [data-viz-worlds-label]")?.textContent?.trim());
  for (let i = 0; i < 3 && (await label()) !== world.label; i++) {
    if (!(await page.$(`[data-viz-world-pick="${world.style}"]`))) await page.click("#vizView [data-viz-worlds]");
    await page.waitForSelector(`[data-viz-world-pick="${world.style}"]`, { visible: true, timeout: 5000 });
    assert(await topmost(`[data-viz-world-pick="${world.style}"]`), "the world's row in the Worlds menu is covered");
    await page.click(`[data-viz-world-pick="${world.style}"]`);
    await pause(2500);
  }
  assert((await label()) === world.label, `the Worlds button does not show the picked world (${await label()} vs ${world.label})`);

  // 2. the cast the six agent figures were built with
  const nodes = (await probe("nodes")) ?? [];
  const agents = AGENTS.map((id) => nodes.find((n) => n.id === id) ?? null);
  assert(agents.every(Boolean), `the demo fleet is not all on stage: ${JSON.stringify(nodes.map((n) => n.id))}`);
  const casts = agents.map((a) => a.cast);
  assert(casts.every((c) => c !== undefined), "the probe reports no cast: this build predates P-WORLDS.CAST1");
  let castSummary = "agents are creatures in this world (no appearance)";
  if (casts.some((c) => c !== null)) {
    assert(casts.every((c) => c !== null), `some agents were cast and some were not: ${JSON.stringify(casts)}`);
    const sigs = new Set(casts.map((c) => `${c.presentation}|${c.skin}|${c.hair}|${c.hairColor}|${c.body}|${c.face}`));
    assert(sigs.size === 6, `the six agents do not have six distinct appearances: ${JSON.stringify(casts)}`);
    const fem = casts.filter((c) => c.presentation === "feminine").length;
    const masc = casts.filter((c) => c.presentation === "masculine").length;
    assert(fem >= 2 && masc >= 2, `presentation is not balanced (${fem} feminine, ${masc} masculine)`);
    const bands = new Set(casts.map((c) => c.skinBand));
    assert(bands.size === 3, `skin does not span light, medium and dark: ${[...bands].join(", ")}`);
    castSummary = casts.map((c, i) => `${AGENTS[i]}: ${c.presentation}, ${c.skin} (${c.skinBand}), ${c.hair} ${c.hairColor}`).join("; ");
  }

  // 3. what the user sees: Fit, one shot of the stage, the skin-like pixels in the head half of each agent's frame
  if (await page.$("[data-viz-worlds-menu]")) { await page.click("#vizView [data-viz-worlds]"); await pause(400); } // fold the menu
  assert(await topmost("#vizView [data-viz-fit]"), "the Fit button is covered");
  await page.click("#vizView [data-viz-fit]");
  await pause(2500); // the camera springs to the fit
  const stageBox = await page.$eval("#vizView [data-viz-stage]", (n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
  const boxes = ((await probe("nodes")) ?? []).filter((n) => AGENTS.includes(n.id)).map((n) => ({ id: n.id, box: n.box }));
  const shot = await page.screenshot({ clip: stageBox, encoding: "base64", type: "png" });
  const skin = await page.evaluate(async (b64, stage, frames) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const k = img.width / stage.width; // device pixels per CSS pixel
    const g = document.createElement("canvas"); g.width = img.width; g.height = img.height;
    const x = g.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const hex = (v) => `#${v.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
    return frames.map(({ id, box }) => {
      if (!box) return { id, px: 0, color: null, luma: null, r: 0 };
      // the head half: the top of the node's frame down to its center, the middle half of its width
      const left = Math.max(0, Math.round((box.x - box.r / 2 - stage.x) * k));
      const top = Math.max(0, Math.round((box.y - box.r - stage.y) * k));
      const w = Math.min(img.width - left, Math.round(box.r * k));
      const h = Math.min(img.height - top, Math.round(box.r * k));
      if (w < 4 || h < 4) return { id, px: 0, color: null, luma: null, r: box.r };
      const d = x.getImageData(left, top, w, h).data;
      const rs = [], gs = [], bs = [];
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gg = d[i + 1], b = d[i + 2];
        const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
        const sat = max ? (max - min) / max : 0;
        // skin, light to deep: red over green over blue, warm but not a saturated persona accent
        if (r > gg && gg > b && r - b >= 25 && r - gg >= 8 && sat >= 0.12 && sat <= 0.72 && max >= 50) { rs.push(r); gs.push(gg); bs.push(b); }
      }
      if (rs.length < 12) return { id, px: rs.length, color: null, luma: null, r: box.r };
      const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
      const c = [med(rs), med(gs), med(bs)];
      return { id, px: rs.length, color: hex(c), luma: Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]), r: box.r };
    });
  }, shot, stageBox, boxes);
  const read = skin.filter((s) => s.color);
  assert(read.length >= 4, `too few agents show skin at this framing: ${JSON.stringify(skin)}`);
  const tones = new Set(read.map((s) => Math.round(s.luma / 12)));
  const spread = Math.max(...read.map((s) => s.luma)) - Math.min(...read.map((s) => s.luma));
  assert(tones.size >= 3 && spread >= 25, `the agents on screen still share one skin tone: ${JSON.stringify(skin)}`);

  assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  return { world: world.id, label: world.label, cast: castSummary, skinOnScreen: skin };
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_worlds_cast_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL (an isolated QA page at <engine>/?vizDemo=1 with a world installed).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyCast(page, process.env.LUCID_DEMO_WORLD_KEY || null), null, 2));
    console.log("P-WORLDS.CAST1 passed: the world cast the six demo agents as six different people, balanced in presentation and skin, and they read differently on screen.");
  } finally { await browser.disconnect(); }
}
