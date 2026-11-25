// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_worlds_2.mjs
//
// P-WORLDS.2: a re-runnable real-UI QA and filming harness for Lucid Agent World packages (signed .lplugin.zip of
// kind "world"). For each package, on the ?vizDemo=1 feed of an ISOLATED QA engine, with real input:
//   1. a clean slate: every installed world is uninstalled, Fly to approvals is off, the page reloads at a fixed
//      viewport (1600x938, the size the published source videos are filmed at) and the first-run gates are passed;
//   2. verifyWorld (demo_p_worlds_1.mjs): import through Worlds > Import world file..., pick, a non-blank stage, the
//      tray's three throwables and the storm, an option rebuild, Export... returns the same package;
//   3. the sky reads light or dark from the stage's top band; LUCID_DEMO_SKY declares it per key (key=light|dark) and
//      a mismatch fails the run;
//   4. stills to LUCID_DEMO_OUT/<key>/: wide (Fit), hub and agent close crops, a throw in flight, the storm, a commit
//      set piece (the demo feed commits three times a cycle; window.__vizProbe.nodes() reports `committing`), and two
//      option changes; every throwable is thrown at an agent, the storm fires and rate-limits;
//   5. every value of every World option (select choices, both toggle states, two colors, every swatch) is applied
//      through the View menu, read back, and the stage still draws; the original values are restored;
//   6. the first template with a sample: Play sample in a node panel, the security gate passes, Play runs it in the
//      sandboxed frame (a still), Close;
//   7. no page error anywhere;
//   8. LUCID_DEMO_FILM=1: a ~106 s CDP screencast of the world in motion (auto camera on; throws, the storm, natural
//      commits and two option changes spread over it, nothing on top of the world from 12 s on except the brief View
//      menu), encoded with ffmpeg to
//      <LUCID_DEMO_FILM_DIR>/Lucid-Agent-Worlds-<Name>-v2.mp4 (Name as build_worlds.py source() derives it), the
//      input plugin-media/_build/build_worlds.py cuts into the store loop and poster.
//
// Boot mode (no LUCID_DEMO_CDP_URL / LUCID_DEMO_BROWSER_URL): builds the renderer bundle if it is missing or older
// than a renderer source, starts `bun desktop/scripts/fleet_demo/start_qa_fleet.mjs <port>` (an isolated temp HOME
// and data root, wiped at start; never the user's instance or data dir) and an isolated Chrome or Edge profile with
// remote debugging, runs, then stops both (LUCID_DEMO_KEEP=1 leaves them up and prints how to attach).
// Attach mode: LUCID_DEMO_CDP_URL=ws://... (or LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp>) and LUCID_DEMO_URL=
// http://127.0.0.1:<port>/?vizDemo=1 of an already running isolated QA engine and browser.
//
// Env:
//   LUCID_DEMO_WORLDS        package paths, ';'-separated (required; LUCID_DEMO_WORLD is accepted for one)
//   LUCID_DEMO_OUT           stills and result.json root (default: a fresh <tmp>/lucid-demo-worlds-2-XXXXXX)
//   LUCID_DEMO_PORT          boot mode engine port (default 7821); LUCID_DEMO_CDP_PORT browser port (default 9333)
//   LUCID_DEMO_CHROME        browser executable (default: Chrome, else Edge, at their usual install paths)
//   LUCID_DEMO_HEADLESS=1    headless browser (WebGL may fall back to software: the tier drops, films look poorer)
//   LUCID_DEMO_SIZE          viewport WxH (default 1600x938)
//   LUCID_DEMO_SKY           declared skies, e.g. "flight-deck=light;cyber-ops=dark"
//   LUCID_DEMO_FILM=1        film each package; LUCID_DEMO_FILM_SECONDS (default 106, kept within 100 to 110)
//   LUCID_DEMO_FILM_DIR      film output dir (default <Apps AI Vibe>/Lucid Agent Worlds Videos/Lucid Agent Worlds)
//   LUCID_DEMO_FILM_OVERWRITE=1  replace an existing film (refused by default: the shipped worlds' sources live there)
//   LUCID_DEMO_KEEP=1        boot mode: leave the engine and browser running afterwards
//   ffmpeg and ffprobe on PATH (or LUCID_FFMPEG / LUCID_FFPROBE) for filming.
//
// Run (boot):   LUCID_DEMO_WORLDS="<a.lplugin.zip>;<b.lplugin.zip>" [LUCID_DEMO_FILM=1] node desktop/scripts/demo_p_worlds_2.mjs
// Run (attach): LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 LUCID_DEMO_WORLDS=... node desktop/scripts/demo_p_worlds_2.mjs

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWorld } from "./demo_p_worlds_1.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const DESKTOP = join(REPO, "desktop");
const VIDEOS = resolve(REPO, "..", "..", "Lucid Agent Worlds Videos", "Lucid Agent Worlds");
const FILM_MIN_S = 100;
const FILM_MAX_S = 110;
const FPS = 30;
const POP_ART = ".popover.viz-art-pop";
/** build_worlds.py SOURCE_NAMES: keys whose video name is not the capitalized key. */
const SOURCE_NAMES = { valentines: "Valentines-Day", "st-patricks": "St-Patricks-Day", "swim-dive": "Swim-and-Dive" };

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const log = (...a) => console.log("[worlds-2]", ...a);

/** The source video name build_worlds.py source() looks for. */
export function sourceName(key) {
  return SOURCE_NAMES[key] ?? key.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("-");
}

/** "flight-deck=light;cyber-ops=dark" -> { "flight-deck": "light", "cyber-ops": "dark" } */
function parseSky(s) {
  const out = {};
  for (const part of (s ?? "").split(/[;,]/)) {
    const [k, v] = part.split("=").map((x) => x?.trim());
    if (k && (v === "light" || v === "dark")) out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------------------------------------ boot (isolated)

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
}

function ensureRendererBundle() {
  const bundle = join(DESKTOP, "renderer", "app.bundle.js");
  const newest = readdirSync(join(DESKTOP, "renderer")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .reduce((m, f) => Math.max(m, statSync(join(DESKTOP, "renderer", f)).mtimeMs), 0);
  if (existsSync(bundle) && statSync(bundle).mtimeMs >= newest) return false;
  log("renderer bundle missing or stale: bun run build-renderer");
  const r = spawnSync("bun", ["run", "build-renderer"], { cwd: DESKTOP, stdio: "inherit", shell: process.platform === "win32" });
  assert(r.status === 0, "bun run build-renderer failed");
  return true;
}

function startEngine(port) {
  return new Promise((ok, fail) => {
    const child = spawn("bun", [join(DESKTOP, "scripts", "fleet_demo", "start_qa_fleet.mjs"), String(port)], {
      cwd: REPO, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    let out = "";
    const timer = setTimeout(() => { killTree(child); fail(new Error(`the QA engine was not ready in 180 s:\n${out}`)); }, 180_000);
    const onData = (b) => {
      out += b.toString();
      if (out.includes("QA fleet engine ready")) { clearTimeout(timer); ok(child); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (b) => { out += b.toString(); });
    child.on("exit", (code) => { clearTimeout(timer); fail(new Error(`the QA engine exited (${code}):\n${out}`)); });
  });
}

function browserPath() {
  if (process.env.LUCID_DEMO_CHROME) return process.env.LUCID_DEMO_CHROME;
  const pf = process.env.ProgramFiles ?? "C:/Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)";
  const local = process.env.LOCALAPPDATA ?? "";
  const list = [
    join(pf, "Google", "Chrome", "Application", "chrome.exe"), join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    join(local, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"), join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ];
  const hit = list.find((p) => p && existsSync(p));
  assert(hit, "no Chrome or Edge found: set LUCID_DEMO_CHROME");
  return hit;
}

function startBrowser(cdpPort, url, size) {
  const profile = mkdtempSync(join(tmpdir(), `lucid-qa-worlds-browser-${cdpPort}-`));
  const args = [
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--autoplay-policy=no-user-gesture-required", `--window-size=${size.w + 40},${size.h + 160}`,
    ...(process.env.LUCID_DEMO_HEADLESS === "1" ? ["--headless=new"] : []), url,
  ];
  return spawn(browserPath(), args, { stdio: "ignore", detached: process.platform !== "win32" });
}

async function connectBrowser(puppeteer, opts) {
  let last;
  for (let i = 0; i < 60; i++) {
    try { return await puppeteer.connect({ ...opts, defaultViewport: null }); } catch (e) { last = e; await pause(500); }
  }
  throw new Error(`could not attach over CDP: ${last?.message ?? last}`);
}

// ------------------------------------------------------------------------------------------ page helpers

async function passGates(page) {
  const sels = ["#roleGateSkip", "#emailGateSkip", "#govGate [data-gov='no']", "#provChoice [data-prov='later']", "[data-coach-skip]"];
  let quiet = 0;
  for (let i = 0; i < 80 && quiet < 6; i++) {
    let hit = false;
    for (const s of sels) {
      const h = await page.$(s);
      if (h && (await h.evaluate((n) => n.getClientRects().length > 0).catch(() => false))) {
        await h.click().catch(() => {});
        hit = true;
        await pause(500);
      }
    }
    quiet = hit ? 0 : quiet + 1;
    await pause(400);
  }
}

async function dismissToasts(page) {
  for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});
  await pause(250);
}

/** Uninstall every world, Fly to approvals off, reload at the fixed viewport, gates passed. */
async function cleanSlate(page, base, size) {
  await page.setViewport({ width: size.w, height: size.h, deviceScaleFactor: 1 });
  if (!page.url().startsWith(new URL(base).origin)) await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ctViz", { timeout: 30000 });
  const removed = await page.evaluate(async () => {
    const t = document.querySelector('meta[name="lucid-token"]')?.content ?? "";
    const h = t ? { "x-lucid-token": t } : {};
    const j = await (await fetch("/api/worlds", { cache: "no-store", headers: h })).json().catch(() => null);
    const ids = (j?.data?.worlds ?? []).map((w) => w.id);
    for (const id of ids) await fetch("/api/worlds/uninstall", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ id }) });
    localStorage.setItem("lucid.viz.flyToApprovals.v1", "0");
    localStorage.removeItem("lucid.viz.autoCamera");
    return ids;
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ctViz", { timeout: 30000 });
  await passGates(page);
  await dismissToasts(page);
  await page.bringToFront();
  return removed;
}

const stageBox = (page) => page.$eval("#vizView [data-viz-stage]", (n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });

/** Luminance of the stage: mean, spread, and the top band's mean (the sky). */
async function stageStats(page) {
  const clip = await stageBox(page);
  const b64 = await page.screenshot({ clip, encoding: "base64", type: "png" });
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const W = 64, H = 40;
    const g = document.createElement("canvas"); g.width = W; g.height = H;
    const x = g.getContext("2d"); x.drawImage(img, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data;
    let sum = 0, min = 255, max = 0, top = 0, topN = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      sum += l; min = Math.min(min, l); max = Math.max(max, l);
      if (i / 4 < W * Math.round(H * 0.3)) { top += l; topN++; }
    }
    return { mean: Math.round(sum / (d.length / 4)), spread: Math.round(max - min), top: Math.round(top / topN) };
  }, b64);
}

const probe = (page, fn, ...args) => page.evaluate((f, a) => window.__vizProbe?.[f]?.(...a), fn, args);

async function onScreenNode(page, kind) {
  return page.evaluate((k) => {
    const st = document.querySelector("#vizView [data-viz-stage]")?.getBoundingClientRect();
    if (!st) return null;
    const ns = (window.__vizProbe?.nodes() ?? []).filter((n) => n.kind === k && n.box && n.box.x > st.left + 40 && n.box.x < st.right - 40 && n.box.y > st.top + 40 && n.box.y < st.bottom - 90);
    ns.sort((a, b) => (b.box.r ?? 0) - (a.box.r ?? 0));
    return ns[0] ?? null;
  }, kind);
}

async function clickSel(page, sel) {
  const b = await page.$eval(sel, (n) => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; });
  assert(b.w > 0, `${sel} is not laid out`);
  await page.mouse.click(b.x, b.y);
}

async function ensureAutoCamera(page) {
  const on = await page.$eval("#vizView input[data-viz-auto]", (i) => i.checked).catch(() => null);
  if (on === false) { await clickSel(page, "#vizView input[data-viz-auto]"); await pause(300); }
}

async function closeOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const open = await page.evaluate(() => !!document.querySelector(".popover.show, .popover.viz-art-pop") || !!document.querySelector("#vizView [data-viz-panel]:not([hidden])"));
    if (!open) break;
    await page.keyboard.press("Escape");
    await pause(350);
  }
  // Escape never reaches past the last overlay, but make sure Visualize is still up
  if (!(await page.$("#vizView:not([hidden]) [data-viz-ledger]"))) { await page.click("#ctViz"); await page.waitForSelector("#vizView [data-viz-ledger]", { visible: true, timeout: 10000 }); }
}

async function disarm(page) {
  const armed = await page.$("#vizView [data-viz-throw][aria-pressed='true']");
  if (armed) { await armed.click(); await pause(200); }
}

async function throwAt(page, kind, nodeKind = "agent") {
  const btn = `#vizView [data-viz-throw="${kind}"]`;
  if ((await page.$eval(btn, (b) => b.getAttribute("aria-pressed"))) !== "true") await clickSel(page, btn);
  const t = await onScreenNode(page, nodeKind) ?? await onScreenNode(page, "hub");
  assert(t, "no node on screen to throw at");
  await page.mouse.click(t.box.x, t.box.y);
  return t;
}

async function stormReady(page, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const off = await page.$eval("#vizView [data-viz-storm]", (b) => b.disabled || b.getAttribute("aria-disabled") === "true");
    if (!off) return true;
    if (Date.now() > end) return false;
    await pause(250);
  }
}

/** A 16:10 crop around a node, inside the stage. */
function closeClip(node, st) {
  const w = Math.round(Math.min(st.width * 0.6, Math.max(480, (node.box.r ?? 40) * 8)));
  const h = Math.round(w / 1.6);
  const x = Math.round(Math.min(Math.max(node.box.x - w / 2, st.x), st.x + st.width - w));
  const y = Math.round(Math.min(Math.max(node.box.y - h * 0.55, st.y), st.y + st.height - h));
  return { x, y, width: w, height: h };
}

// ------------------------------------------------------------------------------------------ options

async function openViewMenu(page) {
  if (!(await page.$(".popover.show .viz-vmenu"))) {
    await dismissToasts(page);
    await pause(200); // a closing menu leaves the DOM 160 ms after Escape
    await clickSel(page, "#vizView [data-viz-viewmenu]");
    await page.waitForSelector(".popover.show .viz-vmenu", { visible: true, timeout: 5000 });
    await pause(300);
  }
}

/** Escape only while the View menu is open: with nothing open, Escape closes Visualize. */
async function closeViewMenu(page) {
  if (await page.$(".popover.show .viz-vmenu")) { await page.keyboard.press("Escape"); await pause(300); }
}

async function readOptions(page) {
  await openViewMenu(page);
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll(".popover.show [data-viz-wopts] [data-viz-wopt]")) {
      const key = el.dataset.vizWopt;
      if (el instanceof HTMLSelectElement) out.push({ key, type: "select", values: [...el.options].map((o) => o.value), current: el.value });
      else if (el.type === "checkbox") out.push({ key, type: "toggle", values: [!el.checked, el.checked], current: el.checked });
      else out.push({ key, type: "color", values: ["#e53935", "#1e88e5"], current: el.value });
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

async function readOption(page, key, type) {
  await openViewMenu(page);
  return page.evaluate((k, t) => {
    if (t === "swatch") return [...document.querySelectorAll(".popover.show [data-viz-wopt-sw]")].find((n) => n.dataset.vizWoptSw === k && n.getAttribute("aria-pressed") === "true")?.dataset.value ?? null;
    const el = [...document.querySelectorAll(".popover.show [data-viz-wopt]")].find((n) => n.dataset.vizWopt === k);
    if (!el) return null;
    return t === "toggle" ? el.checked : t === "color" ? el.value.toLowerCase() : el.value;
  }, key, type);
}

async function setOption(page, key, type, value) {
  await openViewMenu(page);
  const ok = await page.evaluate((k, t, v) => {
    if (t === "swatch") {
      const b = [...document.querySelectorAll(".popover.show [data-viz-wopt-sw]")].find((n) => n.dataset.vizWoptSw === k && n.dataset.value === v);
      if (!b) return false;
      b.click();
      return true;
    }
    const el = [...document.querySelectorAll(".popover.show [data-viz-wopt]")].find((n) => n.dataset.vizWopt === k);
    if (!el) return false;
    if (t === "toggle") el.checked = v; else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, key, type, value);
  assert(ok, `World option ${key} has no control for ${JSON.stringify(value)}`);
}

// ------------------------------------------------------------------------------------------ one package

async function runPackage(page, pkg, ctx) {
  const t0 = Date.now();
  const timings = {};
  const lap = (name, since) => { timings[name] = Math.round((Date.now() - since) / 100) / 10; };
  const errors = [];
  const onErr = (e) => errors.push(String(e?.message ?? e));
  page.on("pageerror", onErr);
  try {
    let t = Date.now();
    const removed = await cleanSlate(page, ctx.base, ctx.size);
    lap("slate_s", t);

    // 2. import, render, tray, storm, an option, export
    t = Date.now();
    const verified = await verifyWorld(page, pkg);
    lap("verify_s", t);
    // verifyWorld leaves its first option changed: drop the saved values and reload, so the stills, the option
    // pass and the film start from the world's own defaults (the picked world is kept)
    await page.evaluate(() => localStorage.removeItem("lucid.worlds.options.v1"));
    await page.goto(ctx.base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ctViz", { timeout: 30000 });
    await passGates(page);
    await dismissToasts(page);
    if (!(await page.$("#vizView [data-viz-ledger]"))) await page.click("#ctViz");
    await page.waitForSelector("#vizView [data-viz-worlds]", { visible: true, timeout: 15000 });
    const picked = await page.evaluate(() => document.querySelector("#vizView [data-viz-worlds-label]")?.textContent?.trim() ?? "");
    assert(picked && !/^(Anime|Professional)$/.test(picked), `the world was not kept across the reload (label ${JSON.stringify(picked)})`);
    await pause(2500);
    const key = verified.world.replace(/^world-/, "");
    const out = join(ctx.out, key);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const still = async (name, clip) => { await page.screenshot({ path: join(out, `${name}.png`), type: "png", ...(clip ? { clip } : {}) }); return `${name}.png`; };
    const stills = [];
    await closeOverlays(page);
    await dismissToasts(page);
    await disarm(page);

    // 3. the sky
    t = Date.now();
    await pause(1500);
    const sky = await stageStats(page);
    const reads = sky.top >= 150 ? "light" : sky.top <= 110 ? "dark" : "mid";
    const declared = ctx.sky[key] ?? null;
    if (declared) assert(reads === declared, `${key} declares a ${declared} sky but its top band reads ${reads} (${JSON.stringify(sky)})`);

    // 4. stills: wide, hub, agent
    await clickSel(page, "#vizView [data-viz-fit]");
    await pause(2500);
    stills.push(await still("wide"));
    const st = await stageBox(page);
    const hub = (await probe(page, "nodes"))?.find((n) => n.kind === "hub" && n.box) ?? null;
    assert(hub, "the hub is not on screen");
    stills.push(await still("hub", closeClip(hub, st)));
    const agent = await onScreenNode(page, "agent");
    assert(agent, "no agent on screen");
    stills.push(await still("agent", closeClip(agent, st)));

    // every throwable on an agent, one still in flight
    const tray = await page.$$eval("#vizView [data-viz-throw]", (bs) => bs.map((b) => b.dataset.vizThrow));
    assert(tray.length === 3, `the tray shows ${tray.length} throwables`);
    for (const [i, kind] of tray.entries()) {
      await throwAt(page, kind);
      if (i === 0) { await pause(320); stills.push(await still("throw")); }
      await pause(1300);
      assert(!(await page.$("#vizView [data-viz-panel]:not([hidden])")), `throwing ${kind} opened the node panel`);
    }
    await disarm(page);

    // the storm
    assert(await stormReady(page, 20000), "the storm never became available");
    await clickSel(page, "#vizView [data-viz-storm]");
    await pause(700);
    stills.push(await still("storm"));
    assert(await page.$eval("#vizView [data-viz-storm]", (b) => b.disabled || b.getAttribute("aria-disabled") === "true"), "the storm is not rate-limited right after use");
    assert(await stormReady(page, 15000), "the storm stayed rate-limited");

    // the commit set piece (the demo feed commits three times a 48 s cycle)
    let commit = null;
    for (let i = 0; i < 130 && !commit; i++) {
      commit = ((await probe(page, "nodes")) ?? []).find((n) => n.committing) ?? null;
      if (!commit) await pause(500);
    }
    assert(commit, "no commit set piece played in 65 s of the demo feed");
    await pause(900);
    stills.push(await still("commit"));
    lap("stills_s", t);

    // 5. every World option value
    t = Date.now();
    const options = await readOptions(page);
    const tried = [];
    let optionStills = 0;
    for (const o of options) {
      for (const v of o.values) {
        await setOption(page, o.key, o.type, v);
        await pause(o.type === "swatch" || o.type === "color" ? 700 : 1100);
        const back = await readOption(page, o.key, o.type);
        assert(back === (typeof v === "string" ? (o.type === "color" ? v.toLowerCase() : v) : v), `World option ${o.key} reads ${JSON.stringify(back)} after setting ${JSON.stringify(v)}`);
        const s = await stageStats(page);
        assert(s.spread > 20, `the stage went blank after ${o.key}=${JSON.stringify(v)} (${JSON.stringify(s)})`);
        assert(errors.length === 0, `page errors after ${o.key}=${JSON.stringify(v)}: ${errors.join(" | ")}`);
        tried.push(`${o.key}=${v}`);
        if (optionStills < 2 && v !== o.current) {
          await closeViewMenu(page);
          await pause(900);
          optionStills++;
          stills.push(await still(`option-${optionStills}`));
          break; // the next value reopens the menu; one still per option
        }
      }
    }
    // the remaining values of options cut short by a still, then the originals back
    for (const o of options) for (const v of o.values) if (!tried.includes(`${o.key}=${v}`)) {
      await setOption(page, o.key, o.type, v);
      await pause(900);
      tried.push(`${o.key}=${v}`);
    }
    for (const o of options) if (o.current !== null) { await setOption(page, o.key, o.type, o.current); await pause(500); }
    await closeOverlays(page);
    await pause(1200);
    const after = await stageStats(page);
    assert(after.spread > 20, `the stage is blank after the options were restored (${JSON.stringify(after)})`);
    lap("options_s", t);

    // 6. a mini game sample
    t = Date.now();
    const game = await playSample(page, still, stills);
    lap("minigame_s", t);

    assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
    const result = {
      package: pkg, key, removedBefore: removed, verified, sky: { ...sky, reads, declared }, tray, commitBy: commit.id,
      options: options.map((o) => ({ key: o.key, type: o.type, values: o.values.length, current: o.current })), optionValuesTried: tried.length,
      game, stills, out, timings,
    };

    // 8. the film
    if (ctx.film) {
      t = Date.now();
      result.film = await film(page, key, tray, options, ctx);
      lap("film_s", t);
      assert(errors.length === 0, `page errors while filming: ${errors.join(" | ")}`);
    }
    timings.total_s = Math.round((Date.now() - t0) / 100) / 10;
    writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    page.off("pageerror", onErr);
  }
}

async function playSample(page, still, stills) {
  await disarm(page);
  await closeOverlays(page);
  let node = null;
  for (let i = 0; i < 15 && !node; i++) {
    const ns = ((await probe(page, "nodes")) ?? []).filter((n) => n.kind !== "subagent" && n.box);
    ns.sort((a, b) => (a.kind === "agent" ? 0 : 1) - (b.kind === "agent" ? 0 : 1));
    for (const n of ns) {
      const top = await page.evaluate((x, y) => !!document.elementFromPoint(x, y)?.closest("#vizView canvas"), n.box.x, n.box.y);
      if (!top) continue;
      await page.mouse.click(n.box.x, n.box.y);
      await pause(800);
      if (await page.$("#vizView [data-viz-panel]:not([hidden]) [data-viz-game-sample]")) { node = n; break; }
      if (await page.$("#vizView [data-viz-panel]:not([hidden])")) { await page.keyboard.press("Escape"); await pause(300); }
    }
    if (!node) await pause(500);
  }
  if (!node) {
    await closeOverlays(page);
    log("no node panel offered Play sample (the world ships no template sample?)");
    return { sample: null, note: "no node panel offered Play sample" };
  }
  const id = await page.$eval("#vizView [data-viz-panel]:not([hidden]) [data-viz-game-sample]", (b) => b.dataset.vizGameSample);
  await clickSel(page, `#vizView [data-viz-panel] [data-viz-game-sample="${id}"]`);
  await page.waitForSelector(`${POP_ART} [data-viz-art]`, { visible: true, timeout: 5000 });
  let st = null;
  for (let i = 0; i < 40; i++) { st = await probe(page, "artifact"); if (st?.verdict && st.verdict !== "pending") break; await pause(250); }
  assert(st?.open && st.verdict === "pass", `the ${id} sample did not pass the security gate: ${JSON.stringify(st)}`);
  await clickSel(page, `${POP_ART} [data-viz-art-play]`);
  await page.waitForSelector(`${POP_ART} iframe[data-viz-art-frame]`, { timeout: 5000 });
  await pause(2500);
  const box = await page.$eval(`${POP_ART} iframe[data-viz-art-frame]`, (f) => { const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
  assert(box.width > 100 && Math.abs(box.width / box.height - 1.6) < 0.05, `the game frame is not 16:10: ${JSON.stringify(box)}`);
  stills.push(await still("minigame"));
  const playing = (await probe(page, "artifact"))?.playing === true;
  assert(playing, "the sample is not playing after Play");
  await clickSel(page, `${POP_ART} [data-viz-art-close]`);
  await pause(400);
  assert(!(await page.$(POP_ART)), "Close did not close the sample popup");
  await closeOverlays(page);
  return { sample: id, node: node.id, verdict: st.verdict, frame: { w: Math.round(box.width), h: Math.round(box.height) } };
}

// ------------------------------------------------------------------------------------------ film

function tool(name) {
  const env = process.env[`LUCID_${name.toUpperCase()}`];
  return env || name;
}

async function film(page, key, tray, options, ctx) {
  const seconds = Math.min(FILM_MAX_S - 2, Math.max(FILM_MIN_S + 2, Number(process.env.LUCID_DEMO_FILM_SECONDS ?? 106)));
  const dest = join(ctx.filmDir, `Lucid-Agent-Worlds-${sourceName(key)}-v2.mp4`);
  assert(!existsSync(dest) || process.env.LUCID_DEMO_FILM_OVERWRITE === "1", `${dest} exists (a shipped source?); set LUCID_DEMO_FILM_OVERWRITE=1 to replace it`);
  mkdirSync(ctx.filmDir, { recursive: true });
  const frames = mkdtempSync(join(tmpdir(), `lucid-worlds-film-${key}-`)); // a fresh, private dir: never a guessable path

  // the world alone: no menus, auto camera on, tray down
  await closeOverlays(page);
  await dismissToasts(page);
  await disarm(page);
  await ensureAutoCamera(page);
  await page.bringToFront();
  await page.mouse.move(2, 2);
  await pause(1500);

  // two option changes (a non-current value), restored before the end
  const changes = options.filter((o) => o.values.some((v) => v !== o.current)).slice(0, 2)
    .map((o) => ({ o, to: o.values.find((v) => v !== o.current) }));
  const plan = [
    [12, "throw", 0], [18, "throw", 1], [24, "throw", 2], [30, "storm"], [38, "option", 0],
    [47, "throw", 0], [53, "throw", 1], [59, "storm"], [66, "option", 1], [75, "throw", 2],
    [81, "storm"], [88, "restore", 0], [95, "throw", 0], [100, "restore", 1],
  ];

  const cdp = await page.target().createCDPSession();
  const shots = [];
  // the View menu is never filmed: frames are dropped while an option changes and the clock skips the gap
  let muted = false;
  let gapAt = 0;
  let offset = 0;
  const mute = (on) => {
    const now = Date.now() / 1000;
    if (on && !muted) gapAt = now;
    if (!on && muted) offset += now - gapAt;
    muted = on;
  };
  cdp.on("Page.screencastFrame", (f) => {
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    if (muted) return;
    const name = `f${String(shots.length).padStart(6, "0")}.jpg`;
    writeFileSync(join(frames, name), Buffer.from(f.data, "base64"));
    // the arrival clock, not the compositor's timestamp: the two drift apart under load and the film ran long
    shots.push({ name, t: Date.now() / 1000 - offset });
  });
  const done = [];
  const missed = [];
  let commits = 0;
  let wasCommitting = false;
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: ctx.size.w, maxHeight: ctx.size.h, everyNthFrame: 1 });
  const start = Date.now();
  const until = async (s) => {
    while (Date.now() - start - offset * 1000 < s * 1000) {
      const c = ((await probe(page, "nodes").catch(() => [])) ?? []).some((n) => n.committing);
      if (c && !wasCommitting) commits++;
      wasCommitting = c;
      await pause(400);
    }
  };
  try {
    for (const [at, what, arg] of plan) {
      await until(at);
      try {
        if (what === "throw") { await throwAt(page, tray[arg % tray.length]); await pause(150); await disarm(page); }
        else if (what === "storm") { if (!(await stormReady(page, 3000))) throw new Error("storm cooling down"); await clickSel(page, "#vizView [data-viz-storm]"); }
        else {
          const c = changes[arg];
          if (!c) continue;
          mute(true);
          try {
            await openViewMenu(page);
            await pause(800);
            await setOption(page, c.o.key, c.o.type, what === "option" ? c.to : c.o.current);
            await pause(1000);
            await closeViewMenu(page);
            await pause(600);
          } finally { mute(false); }
        }
        await page.mouse.move(2, 2); // park the pointer off the stage: no node or button tooltip in the film
        done.push(`${at}s ${what}${arg === undefined ? "" : ` ${arg}`}`);
      } catch (e) {
        missed.push(`${at}s ${what}: ${e?.message ?? e}`);
      }
    }
    await until(seconds);
  } finally {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  const stopT = Date.now() / 1000 - offset;
  assert(shots.length > FPS * 10, `the screencast delivered only ${shots.length} frames`);
  // restore anything a missed step left changed
  for (const c of changes) { await setOption(page, c.o.key, c.o.type, c.o.current).catch(() => {}); }
  await closeOverlays(page).catch(() => {});

  // a variable-rate frame list -> constant 30 fps
  const lines = ["ffconcat version 1.0"];
  for (let i = 0; i < shots.length; i++) {
    const next = i + 1 < shots.length ? shots[i + 1].t : stopT;
    lines.push(`file '${shots[i].name}'`, `duration ${Math.max(0.001, next - shots[i].t).toFixed(4)}`);
  }
  lines.push(`file '${shots[shots.length - 1].name}'`);
  const list = join(frames, "frames.ffconcat");
  writeFileSync(list, `${lines.join("\n")}\n`);
  const enc = spawnSync(tool("ffmpeg"), [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", `fps=${FPS},scale=${ctx.size.w}:${ctx.size.h}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-movflags", "+faststart", "-an", dest,
  ], { stdio: ["ignore", "inherit", "inherit"] });
  assert(enc.status === 0, `ffmpeg failed (${enc.status ?? enc.error?.message})`);
  const pr = spawnSync(tool("ffprobe"), ["-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json", dest], { encoding: "utf8" });
  const info = pr.status === 0 ? JSON.parse(pr.stdout) : null;
  const dur = info ? Number(info.format?.duration) : NaN;
  const v = info?.streams?.[0];
  rmSync(frames, { recursive: true, force: true });
  if (info) {
    assert(dur >= FILM_MIN_S && dur <= FILM_MAX_S, `the film is ${dur.toFixed(1)} s, not ${FILM_MIN_S} to ${FILM_MAX_S} s`);
    assert(v?.width === ctx.size.w && v?.height === ctx.size.h, `the film is ${v?.width}x${v?.height}, not ${ctx.size.w}x${ctx.size.h}`);
  }
  return { path: dest, seconds: Number.isFinite(dur) ? Math.round(dur * 10) / 10 : null, frames: shots.length, avgFps: Math.round(shots.length / Math.max(1, stopT - shots[0].t)), commits, done, missed };
}

// ------------------------------------------------------------------------------------------ main

export async function runWorlds2(page, packages, ctx) {
  const results = [];
  for (const pkg of packages) {
    log(`package ${pkg}`);
    const r = await runPackage(page, pkg, ctx);
    log(`${r.key}: passed in ${r.timings.total_s} s ${JSON.stringify(r.timings)}${r.film ? `, film ${r.film.path} (${r.film.seconds} s, ${r.film.commits} commits, missed ${r.film.missed.length})` : ""}`);
    results.push(r);
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_worlds_2.mjs"))) {
  const packages = (process.env.LUCID_DEMO_WORLDS ?? process.env.LUCID_DEMO_WORLD ?? "").split(";").map((s) => s.trim()).filter(Boolean).map((p) => resolve(p));
  if (!packages.length) throw new Error("Set LUCID_DEMO_WORLDS to one or more world .lplugin.zip paths, ';'-separated.");
  for (const p of packages) assert(existsSync(p), `no package at ${p}`);
  const [w, h] = (process.env.LUCID_DEMO_SIZE ?? "1600x938").split("x").map(Number);
  const size = { w: w || 1600, h: h || 938 };
  const out = resolve(process.env.LUCID_DEMO_OUT ?? mkdtempSync(join(tmpdir(), "lucid-demo-worlds-2-")));
  const filmOn = process.env.LUCID_DEMO_FILM === "1";
  if (filmOn) {
    const ff = spawnSync(tool("ffmpeg"), ["-version"], { stdio: "ignore" });
    assert(ff.status === 0, "LUCID_DEMO_FILM=1 needs ffmpeg on PATH (or LUCID_FFMPEG)");
  }
  const { default: puppeteer } = await import("puppeteer-core");
  const attach = process.env.LUCID_DEMO_CDP_URL || process.env.LUCID_DEMO_BROWSER_URL;
  let engine = null, chrome = null, browser = null, base = process.env.LUCID_DEMO_URL ?? "";
  const keep = process.env.LUCID_DEMO_KEEP === "1";
  const started = Date.now();
  try {
    if (attach) {
      assert(base, "attach mode needs LUCID_DEMO_URL (http://127.0.0.1:<port>/?vizDemo=1 of an isolated QA engine)");
      browser = await connectBrowser(puppeteer, process.env.LUCID_DEMO_CDP_URL ? { browserWSEndpoint: process.env.LUCID_DEMO_CDP_URL } : { browserURL: process.env.LUCID_DEMO_BROWSER_URL });
    } else {
      const port = Number(process.env.LUCID_DEMO_PORT ?? 7821);
      const cdpPort = Number(process.env.LUCID_DEMO_CDP_PORT ?? 9333);
      ensureRendererBundle();
      log(`starting the isolated QA engine on ${port}`);
      engine = await startEngine(port);
      base = `http://127.0.0.1:${port}/?vizDemo=1`;
      log(`starting an isolated browser profile, CDP on ${cdpPort}`);
      chrome = startBrowser(cdpPort, base, size);
      browser = await connectBrowser(puppeteer, { browserURL: `http://127.0.0.1:${cdpPort}` });
    }
    const origin = new URL(base).origin;
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      page = (await browser.pages()).find((p) => p.url().startsWith(origin)) ?? null;
      if (!page) await pause(500);
    }
    if (!page) { page = await browser.newPage(); await page.goto(base, { waitUntil: "domcontentloaded" }); }
    const ctx = { base, size, out, sky: parseSky(process.env.LUCID_DEMO_SKY), film: filmOn, filmDir: resolve(process.env.LUCID_DEMO_FILM_DIR ?? VIDEOS) };
    mkdirSync(out, { recursive: true });
    const results = await runWorlds2(page, packages, ctx);
    await page.setViewport(null).catch(() => {});
    writeFileSync(join(out, "summary.json"), JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), results }, null, 2));
    console.log(JSON.stringify(results.map((r) => ({ key: r.key, sky: r.sky.reads, tray: r.verified.tray, storm: r.verified.storm, options: r.options.length, valuesTried: r.optionValuesTried, game: r.game.sample, stills: r.stills.length, timings: r.timings, film: r.film ?? null })), null, 2));
    console.log(`P-WORLDS.2 passed: ${results.length} world package(s) imported, drew, threw, stormed, committed, cycled every option value and played a sample with no page error; stills in ${out}.`);
  } finally {
    await browser?.disconnect().catch(() => {});
    if (keep && engine) log(`left running: ${base} (attach with LUCID_DEMO_BROWSER_URL=http://127.0.0.1:${process.env.LUCID_DEMO_CDP_PORT ?? 9333} LUCID_DEMO_URL=${base})`);
    else { killTree(chrome); killTree(engine); }
  }
}
