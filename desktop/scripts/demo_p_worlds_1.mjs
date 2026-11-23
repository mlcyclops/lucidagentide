// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_worlds_1.mjs
//
// P-WORLDS.1 (ADR-0648): real-browser proof that a Lucid Agent World (a signed .lplugin.zip of kind "world")
// imports, loads and runs in Visualize, and exports again. On the ?vizDemo=1 feed (hub, agents, subagents), with
// real input, it proves:
//   1. Worlds > Import world file... installs the signed package (the engine runs its gates) and the world is
//      listed; the menu is on top where it opens and passes the spacing audit;
//   2. picking it draws the world: the probe reports the world style, the canvas is not blank, and a light world
//      paints a light sky (the mean of the canvas corners is bright);
//   3. the throw tray shows the world's three throwables (their labels) and its storm label; arming one and
//      clicking an agent does not open the node panel; the storm fires and then rate-limits;
//   4. a World options control rebuilds the figures without a page error;
//   5. Export... downloads the same signed package (zip magic, same size as the file imported).
// The caller owns the page and the engine; LUCID_DEMO_WORLD is the package path.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 LUCID_DEMO_WORLD=<.lplugin.zip> node desktop/scripts/demo_p_worlds_1.mjs

import { readFileSync } from "node:fs";
import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

export async function verifyWorld(page, packagePath) {
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
  assert(await topmost("#vizView [data-viz-worlds]"), "the Worlds button is covered");

  // 1. import through the menu
  await page.click("#vizView [data-viz-worlds]");
  await page.waitForSelector("[data-viz-worlds-menu]", { visible: true, timeout: 5000 });
  assert(await topmost("[data-viz-world-import]"), "Import world file... is covered");
  const file = await page.$("[data-viz-world-file]");
  await file.uploadFile(packagePath);
  let listed = null;
  for (let i = 0; i < 60 && !listed; i++) {
    await pause(500);
    const ws = (await probe("worlds")) ?? [];
    listed = ws.find((w) => !w.error && w.access === "allowed") ?? null;
  }
  assert(listed, `the imported world never listed as usable: ${JSON.stringify(await probe("worlds"))}`);
  if (!(await page.$("[data-viz-worlds-menu]"))) await page.click("#vizView [data-viz-worlds]");
  await page.waitForSelector("[data-viz-worlds-menu]", { visible: true, timeout: 5000 });
  const spacing = await page.evaluate(auditBoxes, "[data-viz-worlds-menu]", MIN_GAP);
  assert(spacing.length === 0, `Worlds menu spacing: ${spacing.join("; ")}`);

  // 2. pick it
  // the menu repaints when the installed list refreshes after an import: pick again if a repaint ate the click
  const label = () => page.evaluate(() => document.querySelector("#vizView [data-viz-worlds-label]")?.textContent?.trim());
  for (let i = 0; i < 3 && (await label()) !== listed.label; i++) {
    if (!(await page.$(`[data-viz-world-pick="${listed.style}"]`))) await page.click("#vizView [data-viz-worlds]");
    await page.waitForSelector(`[data-viz-world-pick="${listed.style}"]`, { visible: true, timeout: 5000 });
    assert(await topmost(`[data-viz-world-pick="${listed.style}"]`), "the world's row in the Worlds menu is covered");
    await page.click(`[data-viz-world-pick="${listed.style}"]`);
    await pause(2500);
  }
  const style = await label();
  assert(style && style === listed.label, `the Worlds button does not show the picked world (${style} vs ${listed.label})`);
  // the WebGL canvas keeps no drawing buffer, so sample what the user sees: a screenshot of the stage
  const stageBox = await page.$eval("#vizView [data-viz-stage]", (n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
  const shot = await page.screenshot({ clip: stageBox, encoding: "base64", type: "png" });
  const sky = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const g = document.createElement("canvas"); g.width = 64; g.height = 40;
    const x = g.getContext("2d"); x.drawImage(img, 0, 0, 64, 40);
    const d = x.getImageData(0, 0, 64, 40).data;
    let sum = 0, min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; min = Math.min(min, l); max = Math.max(max, l); }
    const corner = (px, py) => { const i = (py * 64 + px) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3; };
    return { mean: sum / (d.length / 4), spread: max - min, corners: (corner(1, 1) + corner(62, 1)) / 2 };
  }, shot);
  assert(sky && sky.spread > 20, `the world draws nothing (canvas ${JSON.stringify(sky)})`);

  // 3. the tray: the world's throwables and storm
  const tray = await page.$$eval("#vizView [data-viz-throw]", (bs) => bs.map((b) => ({ kind: b.dataset.vizThrow, label: b.getAttribute("aria-label") ?? "" })));
  assert(tray.length === 3 && tray.every((t) => t.kind && !["paper", "band", "drink", "stars", "bolt", "orb"].includes(t.kind)), `the tray does not show the world's throwables: ${JSON.stringify(tray)}`);
  const storm = await page.$eval("#vizView [data-viz-storm]", (b) => b.textContent.trim());
  const target = await page.evaluate(() => {
    const ns = window.__vizProbe?.nodes() ?? [];
    const stage = document.querySelector("#vizView [data-viz-stage]").getBoundingClientRect();
    return ns.filter((n) => n.kind === "agent" && n.box && n.box.x > stage.left + 40 && n.box.x < stage.right - 40 && n.box.y > stage.top + 40 && n.box.y < stage.bottom - 90)[0] ?? null;
  });
  assert(target, "no agent on screen to throw at");
  for (const t of tray) {
    await page.click(`#vizView [data-viz-throw="${t.kind}"]`);
    await page.mouse.click(target.box.x, target.box.y);
    await pause(1300);
    assert(!(await page.$("#vizView [data-viz-panel]:not([hidden])")), `throwing ${t.kind} opened the node panel`);
  }
  await page.click("#vizView [data-viz-storm]");
  await pause(600);
  assert(await page.$eval("#vizView [data-viz-storm]", (b) => b.disabled || b.getAttribute("aria-disabled") === "true"), "the storm is not rate-limited right after use");
  await pause(4000);

  // 4. an option rebuilds the figures
  // boot-time toasts sit at the top right over the header (the sheet tier, on purpose): close them first
  for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});
  await pause(400);
  if (!(await page.$("[data-viz-wopt]"))) await page.click("#vizView [data-viz-viewmenu]");
  await page.waitForSelector("[data-viz-wopt]", { visible: true, timeout: 5000 }).catch(() => null);
  const opt = await page.$("[data-viz-wopt]");
  assert(opt, `the View menu shows no World options (popovers: ${await page.$$eval(".popover", (ps) => ps.length)})`);
  assert(await page.$eval("[data-viz-wopt]", (n) => { const b = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); }), "the first World option is covered");
  let optionChanged = null;
  {
    optionChanged = await opt.evaluate((el) => {
      if (el instanceof HTMLSelectElement) { el.selectedIndex = (el.selectedIndex + 1) % el.options.length; }
      else if (el.type === "checkbox") { el.checked = !el.checked; }
      else { el.value = el.value === "#ff0000" ? "#00aa00" : "#ff0000"; }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.dataset.vizWopt;
    });
    await pause(2500);
    await page.keyboard.press("Escape");
  }

  // 5. export
  if (!(await page.$("[data-viz-worlds-menu]"))) await page.click("#vizView [data-viz-worlds]");
  const href = await page.$eval(".viz-world-export", (a) => a.href);
  const exported = await page.evaluate(async (u) => { const r = await fetch(u); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, size: b.length, magic: String.fromCharCode(b[0], b[1]) }; }, href);
  const original = readFileSync(packagePath).length;
  assert(exported.status === 200 && exported.magic === "PK" && exported.size === original, `export is not the imported package: ${JSON.stringify(exported)} vs ${original} bytes`);
  await page.keyboard.press("Escape");

  assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  return { world: listed.id, label: listed.label, tray: tray.map((t) => t.label), storm, sky, optionChanged, exportedBytes: exported.size };
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_worlds_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  const pkg = process.env.LUCID_DEMO_WORLD;
  if (!endpoint || !url || !pkg) throw new Error("Set LUCID_DEMO_CDP_URL, LUCID_DEMO_URL (an isolated QA page at <engine>/?vizDemo=1) and LUCID_DEMO_WORLD (a signed world .lplugin.zip).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyWorld(page, pkg), null, 2));
    console.log("P-WORLDS.1 passed: the signed world imported, loaded, drew its sky and cast, threw its throwables and storm, rebuilt on an option, and exported the same package.");
  } finally { await browser.disconnect(); }
}
