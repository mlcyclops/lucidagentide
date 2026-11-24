// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/docs_capture_p_docs_1.mjs
//
// P-DOCS.1 (ADR-0660 step 6): captures the screenshots of docs.lucid-agents.com from the REAL app, never by hand.
// It boots an isolated QA engine (fleet_demo/start_qa_fleet.mjs: temp HOME, USERPROFILE and LUCID_DATA_ROOT, every
// inherited LUCID_, PI_, OMP_ and FAKE_ variable dropped, the scripted fake agent), opens it in a headless Chrome,
// and runs the shot steps of one or more modules under desktop/scripts/docs_shots/, each module on a fresh engine and a
// fresh browser context, so each one starts from a first launch. Each shot is written to the docs
// repo as public/shots/<id>.webp and recorded, with its size and the named boxes the page annotates, in
// src/shots/<module>.json (one file per module, so modules can be captured separately and in parallel).
// A step that cannot find its element throws, and the run fails: that is how a UI change that breaks a page is found.
//
// Run: bun desktop/scripts/docs_capture_p_docs_1.mjs [module ...] [--port 7821] [--docs ../lucid-agent-docs]
//      (no module: every module in docs_shots/). LUCID_DOCS_CHROME overrides the Chrome path.
//
// A shot module exports `steps`: an array of { id, step, run(ctx) }, run in order on one page. `step` says, in one
// sentence, what the capture does (it is stored in the manifest for the reader of the docs repo). ctx gives:
//   page, browser, url, token, root, home, workspace, settingsFile, api(path, init?) (authed engine fetch),
//   pause(ms), reload(), and shoot(id, { boxes?, clip?, pad? }):
//     boxes: { name: selector | { x, y, width, height } } in page CSS pixels; each must be visible.
//     clip:  selector | { x, y, width, height }; default: the whole viewport. Boxes are stored relative to the clip.
//     pad:   pixels added around a selector clip (default 12).

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

if (typeof Bun === "undefined") {
  console.error("Run this with bun: bun desktop/scripts/docs_capture_p_docs_1.mjs [module ...]");
  process.exit(2);
}

const REPO = resolve(import.meta.dir, "..", "..");
const SHOTS_DIR = join(import.meta.dir, "docs_shots");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const port = Number(flag("--port", "7821"));
const DOCS = resolve(flag("--docs", join(REPO, "..", "lucid-agent-docs")));
const VIEW = { width: 1440, height: 900 };
const modules = args.length ? args : readdirSync(SHOTS_DIR).filter((n) => n.endsWith(".mjs")).map((n) => n.slice(0, -4)).sort();

if (!existsSync(join(DOCS, "astro.config.mjs"))) {
  console.error(`No docs repo at ${DOCS} (astro.config.mjs missing). Pass --docs <path>.`);
  process.exit(2);
}
const chromePath = process.env.LUCID_DOCS_CHROME ?? [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => existsSync(p));
if (!chromePath) {
  console.error("No Chrome found. Set LUCID_DOCS_CHROME to a Chrome or Chromium binary.");
  process.exit(2);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the isolated engine ─────────────────────────────────────────────────────────────────────────────────

// Published screenshots must never show the caller's accounts: the engine falls back to provider keys in the
// environment (GEMINI_API_KEY and the like), so it gets an allow-list of OS variables, not the caller's environment.
// Its temp dir is a neutral path too, so a workspace path in a shot does not carry the caller's user name.
const ENV_KEEP = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|LANG|LC_ALL|TZ|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|PROGRAMW6432|COMMONPROGRAMFILES|SHELL|QA_AGENT_START_MS)$/i;
const QA_TMP = process.platform === "win32" ? "C:\\LucidDemo" : "/tmp/lucid-demo";
mkdirSync(QA_TMP, { recursive: true });
const engineEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && ENV_KEEP.test(k)));
Object.assign(engineEnv, { TEMP: QA_TMP, TMP: QA_TMP, TMPDIR: QA_TMP, USERNAME: "demo", USER: "demo", LOGNAME: "demo" });
const root = join(QA_TMP, `lucid-qa-fleet-${port}`);
const url = `http://127.0.0.1:${port}/`;
const home = join(root, "home");
const workspace = join(root, "workspace", "sample-platform");
const settingsFile = join(home, ".omp", "lucid-gui.json");

// One fresh engine per module (start_qa_fleet wipes its root first), so every module starts from a first launch.
async function startEngine() {
  const engine = Bun.spawn([process.execPath, join(import.meta.dir, "fleet_demo", "start_qa_fleet.mjs"), String(port)], {
    cwd: REPO, env: engineEnv, stdin: "ignore", stdout: "pipe", stderr: "inherit",
  });
  let banner = "";
  const reader = engine.stdout.getReader();
  const dec = new TextDecoder();
  for (const deadline = Date.now() + 150_000; !/QA fleet engine ready/.test(banner);) {
    if (Date.now() > deadline) { await stopEngine(engine); throw new Error("the QA engine did not report ready in 150 s"); }
    const { value, done } = await reader.read();
    if (done) throw new Error(`the QA engine exited before it was ready:\n${banner}`);
    banner += dec.decode(value);
  }
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return; } })();
  const token = /<meta name="lucid-token" content="([^"]+)"/.exec(await (await fetch(url)).text())?.[1];
  if (!token) { await stopEngine(engine); throw new Error("the QA engine served no token"); }
  return { engine, token };
}

async function stopEngine(engine) {
  // start_qa_fleet stops its lanes and engine on SIGINT; Windows has no signals, so end the whole tree there.
  if (process.platform === "win32") Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(engine.pid)], { stdout: "ignore", stderr: "ignore" });
  else engine.kill("SIGINT");
  await Promise.race([engine.exited, pause(8000)]);
  if (engine.exitCode === null) engine.kill();
}

// ── the browser ─────────────────────────────────────────────────────────────────────────────────────────

const { default: puppeteer } = await import("puppeteer-core");
const { default: sharp } = await import("sharp");
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  defaultViewport: { ...VIEW, deviceScaleFactor: 1 },
  args: [`--window-size=${VIEW.width},${VIEW.height}`, "--force-color-profile=srgb", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check"],
});

async function rectOf(page, target) {
  if (typeof target !== "string") return target;
  const r = await page.evaluate((sel) => {
    const n = document.querySelector(sel);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return b.width > 0 && b.height > 0 ? { x: b.left, y: b.top, width: b.width, height: b.height } : null;
  }, target);
  if (!r) throw new Error(`"${target}" is missing or not laid out`);
  return r;
}

let failed = false;
let running = null;
try {
  for (const name of modules) {
    const mod = await import(join(SHOTS_DIR, `${name}.mjs`));
    running = await startEngine();
    const { token } = running;
    const api = (path, init = {}) => fetch(new URL(path.replace(/^\//, ""), url), {
      ...init, headers: { "x-lucid-token": token, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const context = await browser.createBrowserContext(); // no storage carried over from the previous module
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const record = { module: name, capturedAt: new Date().toISOString(), shots: {} };
    const ctx = {
      page, browser, url, token, root, home, workspace, settingsFile, api, pause,
      reload: () => page.reload({ waitUntil: "domcontentloaded" }),
      async shoot(id, { boxes = {}, clip, pad = 12 } = {}) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`shot id "${id}" must be lowercase words joined by hyphens`);
        let area = { x: 0, y: 0, ...VIEW };
        if (clip) {
          const c = await rectOf(page, clip);
          const p = typeof clip === "string" ? pad : 0;
          const x = Math.max(0, Math.floor(c.x - p)), y = Math.max(0, Math.floor(c.y - p));
          area = { x, y, width: Math.min(VIEW.width - x, Math.ceil(c.width + 2 * p)), height: Math.min(VIEW.height - y, Math.ceil(c.height + 2 * p)) };
        }
        const stored = {};
        for (const [key, target] of Object.entries(boxes)) {
          const b = await rectOf(page, target);
          stored[key] = [Math.round(b.x - area.x), Math.round(b.y - area.y), Math.round(b.width), Math.round(b.height)];
        }
        const png = await page.screenshot({ type: "png", clip: area });
        const file = `${id}.webp`;
        mkdirSync(join(DOCS, "public", "shots"), { recursive: true });
        await sharp(png).webp({ quality: 84 }).toFile(join(DOCS, "public", "shots", file));
        record.shots[id] = { file, width: area.width, height: area.height, boxes: stored, step: ctx.currentStep };
        console.log(`  shot ${id} (${area.width}x${area.height}, ${Object.keys(stored).length} boxes)`);
      },
      currentStep: "",
    };
    console.log(`${name}:`);
    for (const s of mod.steps) {
      ctx.currentStep = s.step;
      await s.run(ctx);
    }
    mkdirSync(join(DOCS, "src", "shots"), { recursive: true });
    writeFileSync(join(DOCS, "src", "shots", `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
    await context.close();
    await stopEngine(running.engine);
    running = null;
  }
} catch (e) {
  failed = true;
  console.error(`capture failed: ${e?.stack ?? e}`);
} finally {
  await browser.close().catch(() => {});
  if (running) await stopEngine(running.engine);
}
process.exit(failed ? 1 : 0);
