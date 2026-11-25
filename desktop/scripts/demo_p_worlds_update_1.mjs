// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_worlds_update_1.mjs
//
// P-WORLDS.UPDATE1 (ADR-0685): the real-UI proof that a purchased world with a newer store version gets ONE notice,
// an Update button in the Worlds menu, and an update through the store's verified install path. Against an isolated
// QA engine, in a fresh browser context (no storage carried over):
//   1. imports a signed world package (LUCID_DEMO_WORLD, default ../lucidagentIDEaddon/worlds/dist/
//      world-christmas-2.0.0.lplugin.zip) and clears the engine's announced list;
//   2. points the renderer's store at a loopback fake (the __LUCID_MARKET__ boot config seam the desktop preload fills,
//      functionsBaseUrl http://localhost:<port>, which the renderer CSP admits) whose getEntitlement says the world is
//      owned with a newer latestVersion, and a stored sign-in record (what the lucid://auth deep link saves);
//   3. passes the first-run gates and asserts the "World updates available" toast appears exactly once with Update all
//      and Later, the engine remembers "<id>@<version>", and the Visualize toolbar button carries the update dot;
//   4. clicks Later, clears localStorage (what a port-rolled launch on a new origin sees) and reloads: the check runs
//      again (the dot comes back) and NO second notice appears, because the memory is engine-side;
//   5. opens Visualize and Worlds with real clicks (each control hit-tested at its center), asserts the row's Update
//      sits beside Export... on one line, says "Update to v<latest>" in its tooltip, and the menu passes auditBoxes;
//   6. clicks Update: with LUCID_DEMO_WORLD_NEWER (a newer signed package of the same world, served by the fake store
//      over http://127.0.0.1, so the QA engine must run with QA_PLUGIN_DEV_LOOPBACK=1) the world updates, the row's
//      Update and the dot go and the engine lists the new version; without it the engine refuses the plain-http link
//      and the toast says so honestly while Update stays offered;
//   7. no page error anywhere.
//
// Run (QA engine: [QA_PLUGIN_DEV_LOOPBACK=1] bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7821, and a Chrome with a
// CDP port):
//   LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7821/ [LUCID_DEMO_WORLD=<zip>]
//   [LUCID_DEMO_WORLD_NEWER=<zip> [LUCID_DEMO_WORLD_NEWER_VERSION=<x.y.z>]] [LUCID_DEMO_SHOTS=<dir>]
//   node desktop/scripts/demo_p_worlds_update_1.mjs

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const DEFAULT_WORLD = resolve(REPO, "..", "lucidagentIDEaddon", "worlds", "dist", "world-christmas-2.0.0.lplugin.zip");
const GATES = ["#roleGateSkip", "#emailGateSkip", "#govGate [data-gov=no]", "#provChoice [data-prov=later]", ".coach-card [data-coach-skip]"];
const NOTICE = "World updates available";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

/** "world-christmas-2.0.0.lplugin.zip" -> "2.0.0" (the engine's own package naming). */
const versionOfName = (p) => /-(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.lplugin\.zip$/i.exec(basename(p))?.[1] ?? null;
/** "2.0.0" -> "2.0.1". */
function bump(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  assert(m, `the installed world reports an unparseable version "${v}"`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

async function engineApi(base) {
  const html = await (await fetch(base)).text();
  const token = /<meta name="lucid-token" content="([^"]+)"/.exec(html)?.[1];
  assert(token, "no lucid-token meta on the engine page");
  const headers = { "x-lucid-token": token, "content-type": "application/json" };
  const call = async (path, body) => {
    const r = await fetch(new URL(path, base), body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    return { status: r.status, ok: j?.ok, data: j?.data ?? null, error: j?.error };
  };
  call.importWorld = async (file) => {
    const r = await fetch(new URL("/api/worlds/import", base), { method: "POST", headers: { ...headers, "x-lucid-filename": encodeURIComponent(basename(file)) }, body: readFileSync(file) });
    const j = await r.json().catch(() => null);
    assert(j?.ok && j.data?.world, `importing ${basename(file)} failed: HTTP ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return j.data.world;
  };
  return call;
}

/** A loopback stand-in for the store's callables: getEntitlement says `worldId` is owned with `latest` published,
 *  getPackDownload hands out a link to `pkg` (404 when there is none). Listens on 127.0.0.1 and ::1 (localhost). */
async function startFakeStore(worldId, latest, pkg) {
  const hits = [];
  let port = 0;
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" };
  const handler = (req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === `/pkg/${worldId}.zip`) {
      hits.push("download");
      if (!pkg) { res.writeHead(404, cors); res.end(); return; }
      res.writeHead(200, { ...cors, "content-type": "application/zip", "content-length": String(pkg.length) });
      res.end(pkg);
      return;
    }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const name = url.pathname.replace(/^\//, "");
      let data = null;
      try { data = JSON.parse(body || "{}").data ?? null; } catch { /* answered as unknown below */ }
      hits.push(`${name}:${data?.packId ?? ""}`);
      let result = null;
      if (name === "getEntitlement") result = data?.packId === worldId ? { packId: worldId, state: "active", method: "card", latestVersion: latest } : null;
      else if (name === "getPackDownload") result = data?.packId === worldId ? { url: `http://127.0.0.1:${port}/pkg/${worldId}.zip` } : null;
      else if (name === "getGovAccess") result = { status: "none" };
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ result }));
    });
  };
  const v4 = createServer(handler);
  await new Promise((ok, fail) => { v4.once("error", fail); v4.listen(0, "127.0.0.1", ok); });
  port = v4.address().port;
  const v6 = createServer(handler);
  const has6 = await new Promise((ok) => { v6.once("error", () => ok(false)); v6.listen(port, "::1", () => ok(true)); });
  return { base: `http://localhost:${port}`, hits, close: () => { v4.close(); if (has6) v6.close(); } };
}

/** Clear the first-run gates of a fresh profile: ~10 passes, 450 ms apart. */
async function passGates(page) {
  for (let i = 0; i < 10; i++) {
    await page.evaluate((sels) => {
      for (const s of sels) for (const n of document.querySelectorAll(s)) if (n.getClientRects().length) n.click();
    }, GATES).catch(() => {});
    await pause(450);
  }
}

/** Is `sel` the topmost element at its own center? */
const hitTest = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return { ok: false, why: `nothing matches ${s}` };
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { ok: false, why: `${s} has no box` };
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  return { ok: !!top && (top === el || el.contains(top)), why: top ? `covered by ${top.outerHTML.slice(0, 140)}` : "nothing at its center", x, y };
}, sel);

async function clickReal(page, sel, what) {
  const h = await hitTest(page, sel);
  assert(h.ok, `${what} is not hit-testable at its center: ${h.why}`);
  await page.mouse.click(h.x, h.y);
}

/** The toasts on screen whose title is `title` (or matches it), with their text and actions. */
const toasts = (page, title) => page.evaluate((t) => [...document.querySelectorAll("#toasts .toast")]
  .map((n) => ({ title: (n.querySelector(".h")?.textContent ?? "").trim(), desc: (n.querySelector(".d")?.textContent ?? "").trim(), acts: [...n.querySelectorAll(".acts button")].map((b) => b.textContent.trim()) }))
  .filter((x) => (t.startsWith("/") ? new RegExp(t.slice(1)).test(x.title) : x.title === t)), title);

/** Mark the toast action `label` of the toast titled `title`, so it can be hit-tested and clicked like any control. */
const markAction = (page, title, label) => page.evaluate((t, l) => {
  const toast = [...document.querySelectorAll("#toasts .toast")].find((n) => (n.querySelector(".h")?.textContent ?? "").trim() === t);
  const b = toast && [...toast.querySelectorAll(".acts button")].find((x) => x.textContent.trim() === l);
  if (b) b.setAttribute("data-demo-act", l);
  return !!b;
}, title, label);

async function until(what, fn, ms = 30000, every = 250) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const v = await fn();
    if (v) return v;
    await pause(every);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const vizDot = (page) => page.evaluate(() => document.querySelector("#ctViz")?.dataset.worldUpdates ?? null);

export async function verifyWorldUpdate(browser, base, opts) {
  const api = await engineApi(base);
  const shots = opts.shots;
  if (shots) mkdirSync(shots, { recursive: true });
  const result = {};

  // 1. a purchased world at an older version; nothing announced yet
  const world = await api.importWorld(opts.world);
  const id = world.id;
  const latest = opts.newerVersion ?? bump(world.version);
  assert(latest !== world.version, `the newer package (${latest}) is the installed version`);
  await api("/api/worlds/update-notices", { announced: [] });
  result.world = { id, installed: world.version, latest };

  // 2. the store: a loopback fake behind the boot config seam, signed in
  const store = await startFakeStore(id, latest, opts.newer ? readFileSync(opts.newer) : null);
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
    const record = JSON.stringify({ idToken: "qa-world-update-token", email: "qa-worlds@example.invalid", expiresAt: Date.now() + 6 * 3600_000 });
    await page.evaluateOnNewDocument((cfg, rec) => {
      window.__LUCID_MARKET__ = cfg;
      try { localStorage.setItem("lucid.market.auth", rec); localStorage.setItem("lucid.suggest.enabled", "0"); } catch { /* not this origin */ }
    }, { mode: "firebase", functionsBaseUrl: store.base, signInUrl: `${store.base}/signin` }, record);

    // 3. one notice, remembered engine-side; the toolbar dot
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ctViz", { timeout: 30000 });
    await passGates(page);
    const notice = await until("the World updates available toast", async () => (await toasts(page, NOTICE))[0], 40000);
    await pause(1500);
    const all = await toasts(page, NOTICE);
    assert(all.length === 1, `expected exactly one "${NOTICE}" toast, saw ${all.length}`);
    assert(notice.desc.includes(latest), `the notice does not name the new version ${latest}: "${notice.desc}"`);
    assert(JSON.stringify(notice.acts) === JSON.stringify(["Update all", "Later"]), `the notice's actions are ${JSON.stringify(notice.acts)}`);
    const remembered = (await api("/api/worlds/update-notices")).data?.announced ?? [];
    assert(remembered.includes(`${id}@${latest}`), `the engine did not remember ${id}@${latest}: ${JSON.stringify(remembered)}`);
    assert((await vizDot(page)) === "1", `the Visualize button's update dot says ${await vizDot(page)}`);
    assert(store.hits.includes(`getEntitlement:${id}`), `the store was never asked about ${id}: ${store.hits.join(", ")}`);
    result.notice = notice;
    if (shots) await page.screenshot({ path: join(shots, "worlds-update-notice.png") });

    // 4. Later; a new origin's empty localStorage still gets no second notice
    await passGates(page);
    assert(await markAction(page, NOTICE, "Later"), "the notice has no Later button");
    await clickReal(page, "[data-demo-act=Later]", "the notice's Later");
    await until("the notice to close", async () => (await toasts(page, NOTICE)).length === 0, 5000);
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ctViz", { timeout: 30000 });
    await passGates(page);
    await until("the update check after the reload (the dot)", async () => (await vizDot(page)) === "1", 40000);
    await pause(2500);
    assert((await toasts(page, NOTICE)).length === 0, "the notice came back after a reload with an empty localStorage");
    result.reannounced = false;

    // 5. Visualize > Worlds: the row's Update
    for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});
    await pause(300);
    await clickReal(page, "#ctViz", "the Visualize button");
    await page.waitForSelector("#vizView [data-viz-worlds]", { visible: true, timeout: 15000 });
    assert(await page.$eval("#vizView [data-viz-worlds]", (n) => n.classList.contains("has-upd")), "the Worlds button has no update dot");
    await clickReal(page, "#vizView [data-viz-worlds]", "the Worlds button");
    const UPD = `.popover.show [data-viz-world-update="${id}"]`;
    await page.waitForSelector(UPD, { visible: true, timeout: 20000 });
    const geo = await page.$eval(UPD, (b) => {
      const row = b.closest(".viz-world-row");
      const ex = row?.querySelector(".viz-world-export");
      const r = b.getBoundingClientRect(), rr = row.getBoundingClientRect(), er = ex.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(b).lineHeight) || parseFloat(getComputedStyle(b).fontSize) * 1.3;
      return {
        text: b.textContent.trim(), tip: b.getAttribute("data-tip") ?? "", disabled: b.disabled,
        inRow: r.top >= rr.top - 0.5 && r.bottom <= rr.bottom + 0.5, beside: r.right <= er.left && Math.abs((r.top + r.bottom) / 2 - (er.top + er.bottom) / 2) <= 4,
        oneLine: b.scrollWidth <= b.clientWidth + 1 && r.height < lh * 2, h: r.height,
      };
    });
    assert(geo.text === "Update" && !geo.disabled, `the row's Update says "${geo.text}" (disabled ${geo.disabled})`);
    assert(geo.tip.includes(`Update to v${latest.replace(/^v/, "")}`), `the Update tooltip is "${geo.tip}"`);
    assert(geo.inRow && geo.beside, `the Update button is not on its row beside Export... (${JSON.stringify(geo)})`);
    assert(geo.oneLine, `the Update label wraps or overflows (${JSON.stringify(geo)})`);
    const boxes = await page.evaluate(auditBoxes, ".popover.show .viz-worlds", MIN_GAP);
    assert(boxes.length === 0, `Worlds menu spacing: ${boxes.join("; ")}`);
    if (shots) await page.screenshot({ path: join(shots, "worlds-update-menu.png") });
    result.button = geo;

    // 6. Update: the store's verified install path
    await clickReal(page, UPD, "the row's Update");
    const busy = await page.$eval(UPD, (b) => ({ text: b.textContent.trim(), disabled: b.disabled })).catch(() => null);
    const early = (await toasts(page, "/ (updated|was not updated)$")).length > 0;
    assert(early || busy === null || (busy.disabled && busy.text === "Updating"), `while the update runs the row says "${busy?.text}" (disabled ${busy?.disabled})`);
    const outcome = await until("the update's outcome toast", async () => (await toasts(page, "/ (updated|was not updated)$"))[0], 120000);
    result.busy = busy;
    result.outcome = outcome;
    assert(store.hits.includes(`getPackDownload:${id}`), `Update never asked the store for a download link: ${store.hits.join(", ")}`);
    const now = (await api("/api/worlds")).data?.worlds?.find((w) => w.id === id);
    if (opts.newer) {
      assert(!/was not updated$/.test(outcome.title), `the update failed: ${outcome.title}: ${outcome.desc}`);
      assert(now?.version === latest, `the engine lists ${id} at ${now?.version}, not ${latest}`);
      await until("the row's Update to go", async () => !(await page.$(UPD)), 15000);
      await until("the update dot to go", async () => (await vizDot(page)) === null, 5000);
    } else {
      assert(/was not updated$/.test(outcome.title) && outcome.desc.length > 10, `expected an honest failure, got "${outcome.title}: ${outcome.desc}"`);
      assert(now?.version === world.version, `a refused update changed the installed version to ${now?.version}`);
      await until("Update to be offered again", async () => page.$eval(UPD, (b) => !b.disabled && b.textContent.trim() === "Update").catch(() => false), 5000);
    }
    if (shots) await page.screenshot({ path: join(shots, "worlds-update-outcome.png") });

    // 7. no page error
    assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
    return result;
  } finally {
    await context.close().catch(() => {});
    store.close();
  }
}

async function main() {
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const wsEndpoint = process.env.LUCID_DEMO_CDP_URL;
  const base = process.env.LUCID_DEMO_URL;
  if ((!browserURL && !wsEndpoint) || !base) {
    console.log("demo_p_worlds_update_1: set LUCID_DEMO_BROWSER_URL (or LUCID_DEMO_CDP_URL) and LUCID_DEMO_URL to an isolated QA engine.");
    return;
  }
  assert(new URL(base).hostname === "127.0.0.1", "LUCID_DEMO_URL must be an isolated QA engine on 127.0.0.1");
  const world = process.env.LUCID_DEMO_WORLD || DEFAULT_WORLD;
  assert(existsSync(world), `no signed world package at ${world} (set LUCID_DEMO_WORLD to a signed world .lplugin.zip)`);
  const newer = process.env.LUCID_DEMO_WORLD_NEWER || null;
  if (newer) assert(existsSync(newer), `LUCID_DEMO_WORLD_NEWER: no file at ${newer}`);
  const newerVersion = newer ? (process.env.LUCID_DEMO_WORLD_NEWER_VERSION || versionOfName(newer)) : null;
  if (newer) assert(newerVersion, "set LUCID_DEMO_WORLD_NEWER_VERSION: the newer package's file name does not carry its version");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(wsEndpoint ? { browserWSEndpoint: wsEndpoint } : { browserURL }), defaultViewport: null });
  try {
    const r = await verifyWorldUpdate(browser, base, { world, newer, newerVersion, shots: process.env.LUCID_DEMO_SHOTS || null });
    console.log(JSON.stringify(r, null, 2));
    console.log(newer
      ? "P-WORLDS.UPDATE1 passed: one notice per world and version (remembered engine-side), the Worlds menu's Update installed the newer signed package through the store path."
      : "P-WORLDS.UPDATE1 passed: one notice per world and version (remembered engine-side), the Worlds menu's Update ran the store path and the refusal was reported honestly.");
  } finally {
    browser.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("demo_p_worlds_update_1.mjs")) {
  main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
}
