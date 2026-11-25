// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_market_auth_2.mjs
//
// P-MARKET.AUTH2 (ADR-0684): a Patron who signed in once keeps every premium world, across a restart on another
// origin (a rolled port), an expired ID token and a store that cannot be reached. Against an isolated QA engine and a
// FRESH browser profile it:
//   1. imports signed world packages (Christmas, Soccer) through the real import route, starts a local fake store
//      (the Firebase callable protocol on http://localhost:<port>, a fixed fake token, CORS for the renderer) and
//      injects the store config the desktop preload would (window.__LUCID_MARKET__); no real Google or Stripe call;
//   2. seeds a LIVE sign-in (fake ID token + fake refresh token) through the engine route POST /api/market/auth, opens
//      Visualize > Worlds with real mouse input and asserts both worlds are unlocked by the fake store's "active"
//      answer and the engine now holds a receipt for each (GET /api/market/receipts);
//   3. "a day later, restarted on another port, offline": the fake store is shut down, the sign-in is re-seeded with
//      an ID token that expired 10 minutes ago (refresh token kept), the receipts are aged past their renewal window,
//      and the page is reloaded on a DIFFERENT origin (http://localhost:<enginePort>, so its localStorage is empty);
//   4. asserts the user still reads as signed in (window.__lucidMarketUser, never a token), the Worlds menu shows NO
//      Get chip and no sign-in tip on either world, every row is the topmost element at its center, auditBoxes
//      (demo_p_spacing_1.mjs) passes on the menu, and the engine still holds the renewable sign-in.
// Before ADR-0684 step 3 showed "Get" on both worlds: the sign-in and the receipts lived in the 127.0.0.1 origin's
// localStorage and the ID token was never renewed.
//
// Run (QA engine: bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811, and a Chrome with a CDP port on a fresh
// profile). The signed packages come from the store repo's build output (../lucidagentIDEaddon/worlds/dist, or
// LUCID_DEMO_WORLDS_DIR):
//   LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_market_auth_2.mjs

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORLDS_DIR = process.env.LUCID_DEMO_WORLDS_DIR ?? resolve(REPO, "..", "lucidagentIDEaddon", "worlds", "dist");
const WORLD_KEYS = ["christmas", "soccer"];
// Fake, demo-only strings: none of them is a credential anywhere.
const LIVE_ID = "demo-live-id-token";
const EXPIRED_ID = "demo-expired-id-token";
const REFRESH = "demo-refresh-token";
const EMAIL = "patron@demo.invalid";
const DAY = 24 * 3600_000;
const GATES = "#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

async function engineApi(base) {
  const html = await (await fetch(base)).text();
  const token = /<meta name="lucid-token" content="([^"]+)"/.exec(html)?.[1];
  assert(token, "no lucid-token meta on the engine page");
  return async (path, body, extra = {}) => {
    const raw = body instanceof Uint8Array;
    const init = body === undefined ? { headers: { "x-lucid-token": token } }
      : { method: "POST", headers: { "x-lucid-token": token, "content-type": "application/json", ...extra }, body: raw ? body : JSON.stringify(body) };
    const r = await fetch(new URL(path, base), init);
    const j = await r.json().catch(() => null);
    return { status: r.status, data: j?.data ?? j };
  };
}

/** The newest signed package of a world key in WORLDS_DIR. */
function worldPackage(key) {
  const files = existsSync(WORLDS_DIR) ? readdirSync(WORLDS_DIR).filter((f) => f.startsWith(`world-${key}-`) && f.endsWith(".lplugin.zip")) : [];
  const ver = (f) => f.slice(`world-${key}-`.length, -".lplugin.zip".length).split(".").map(Number);
  files.sort((a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0); return 0; });
  assert(files[0], `no signed world-${key} package in ${WORLDS_DIR} (set LUCID_DEMO_WORLDS_DIR)`);
  return join(WORLDS_DIR, files[0]);
}

/** A local stand-in for the store's Firebase callables: getEntitlement answers "active" for the live fake token. */
function fakeStore() {
  const seen = [];
  const sockets = new Set();
  const srv = createServer((req, res) => {
    const cors = { "access-control-allow-origin": req.headers.origin || "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "POST, OPTIONS" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const name = (req.url ?? "").replace(/^\/+/, "").split("?")[0];
      let packId = "";
      try { packId = JSON.parse(body)?.data?.packId ?? ""; } catch { /* not JSON */ }
      const live = req.headers.authorization === `Bearer ${LIVE_ID}`;
      seen.push({ name, packId, live });
      const reply = !live ? { error: { message: "UNAUTHENTICATED" } } : { result: name === "getEntitlement" ? { packId, state: "active" } : null };
      res.writeHead(live ? 200 : 401, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({
    port: srv.address().port,
    seen,
    close: () => new Promise((done) => { for (const s of sockets) s.destroy(); srv.close(() => done()); }),
  })));
}

async function passGates(page) {
  for (let i = 0; i < 10; i++) {
    await page.evaluate((sel) => {
      for (const b of document.querySelectorAll(sel)) { const r = b.getBoundingClientRect(); if (r.width > 0 && r.height > 0) b.click(); }
    }, GATES);
    await pause(450);
  }
}

async function dismissToasts(page) {
  for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});
  await pause(250);
}

async function clickReal(page, sel, what) {
  const c = await page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, top: n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)) }; });
  assert(c.w > 0, `${what} is not visible`);
  assert(c.top, `${what} is covered (elementFromPoint at its center hits something else)`);
  await page.mouse.click(c.x, c.y);
}

/** Open Visualize > Worlds and wait for the rows of `styles`; returns what each row shows. */
async function openWorldsMenu(page, styles) {
  await page.waitForSelector("#ctViz", { timeout: 30000 });
  await dismissToasts(page);
  await clickReal(page, "#ctViz", "the Visualize button");
  await page.waitForSelector("#vizView [data-viz-worlds]", { visible: true, timeout: 20000 });
  await pause(600);
  await dismissToasts(page);
  if (!(await page.$("[data-viz-worlds-menu]"))) await clickReal(page, "#vizView [data-viz-worlds]", "the Worlds button");
  await page.waitForFunction((want) => want.every((s) => document.querySelector(`[data-viz-worlds-menu] [data-viz-world-pick="${s}"]`)), { timeout: 30000 }, styles)
    .catch(() => { throw new Error(`the Worlds menu never listed ${styles.join(", ")}`); });
  await pause(800); // a refresh in flight repaints the rows
  return page.evaluate((want) => want.map((s) => {
    const b = document.querySelector(`[data-viz-worlds-menu] [data-viz-world-pick="${s}"]`);
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { style: s, get: !!b.querySelector(".viz-world-get"), tip: b.getAttribute("data-tip") ?? "", disabled: b.disabled, w: r.width, h: r.height, topmost: b.contains(hit) };
  }), styles);
}

export async function verifyMarketAuth2(page, base) {
  const api = await engineApi(base);
  const store = await fakeStore();
  const ids = WORLD_KEYS.map((k) => `world-${k}`);
  const styles = WORLD_KEYS.map((k) => `world:${k}`);
  const out = { worlds: ids };
  try {
    // 1. the worlds, a clean custody, the store config
    const installed = ((await api("/api/worlds")).data?.worlds ?? []).map((w) => w.id);
    for (const key of WORLD_KEYS) {
      if (installed.includes(`world-${key}`)) continue;
      const file = worldPackage(key);
      const r = await api("/api/worlds/import", new Uint8Array(readFileSync(file)), { "x-lucid-filename": encodeURIComponent(file.split(/[\\/]/).pop()) });
      assert(r.status < 400, `importing world-${key} failed: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    }
    await api("/api/market/auth/clear", {});
    await api("/api/market/receipts", { drop: ids });
    const cfg = { mode: "firebase", functionsBaseUrl: `http://localhost:${store.port}`, signInUrl: `http://localhost:${store.port}/signin` };
    await page.evaluateOnNewDocument((c) => { window.__LUCID_MARKET__ = c; }, cfg);

    // 2. a live sign-in on origin A unlocks both worlds and leaves engine receipts
    const seeded = await api("/api/market/auth", { record: { idToken: LIVE_ID, email: EMAIL, expiresAt: Date.now() + 3600_000, refreshToken: REFRESH } });
    assert(seeded.status === 200 && seeded.data?.renewable === true, `seeding the live sign-in failed: HTTP ${seeded.status}`);
    assert(!JSON.stringify(seeded.data).includes(REFRESH) && !JSON.stringify(seeded.data).includes(LIVE_ID), "the sign-in route echoed a token");
    const originA = new URL(base).origin;
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await passGates(page);
    const rowsA = await openWorldsMenu(page, styles);
    assert(rowsA.every((r) => !r.get), `origin A: a live sign-in with an active entitlement still shows Get: ${JSON.stringify(rowsA)}`);
    const asked = store.seen.filter((s) => s.name === "getEntitlement" && s.live).map((s) => s.packId);
    assert(ids.every((id) => asked.includes(id)), `the fake store was not asked for every world with the live token: ${JSON.stringify(store.seen)}`);
    const receipts = (await api("/api/market/receipts")).data?.receipts ?? {};
    assert(ids.every((id) => typeof receipts[id] === "number"), `the engine holds no receipt for every world: ${JSON.stringify(receipts)}`);
    out.originA = { origin: originA, rows: rowsA, storeAsked: asked };

    // 3. a day later, restarted on another port, offline, the ID token expired
    await store.close();
    const again = await api("/api/market/auth", { record: { idToken: EXPIRED_ID, email: EMAIL, expiresAt: Date.now() - 10 * 60_000, refreshToken: REFRESH } });
    assert(again.status === 200, `re-seeding the expired sign-in failed: HTTP ${again.status}`);
    await api("/api/market/receipts", { drop: ids });
    await api("/api/market/receipts", { set: Object.fromEntries(ids.map((id) => [id, Date.now() - 2 * DAY])) });
    const b = new URL(base);
    b.hostname = "localhost";
    const originB = b.origin;
    assert(originB !== originA, "the second origin must differ from the first");
    await page.goto(b.href, { waitUntil: "domcontentloaded" });
    const storeAtB = await page.evaluate(() => ({ auth: localStorage.getItem("lucid.market.auth"), receipts: localStorage.getItem("lucid.worlds.receipts.v1") }));
    // Nothing keeps the sign-in or the receipts in an origin's localStorage any more: only the engine can unlock here.
    assert(storeAtB.auth === null && storeAtB.receipts === null, `origin B's localStorage holds a sign-in or receipts: ${JSON.stringify(storeAtB)}`);
    await passGates(page);

    // 4. still signed in, no Get, no sign-in tip, hit-testable rows, clean spacing
    let user = null;
    for (let i = 0; i < 40; i++) {
      user = await page.evaluate(() => window.__lucidMarketUser?.() ?? null);
      if (user?.signedIn) break;
      await pause(250);
    }
    assert(user?.signedIn === true && user.email === EMAIL, `origin B: the Patron reads as signed out after a restart with an expired ID token: ${JSON.stringify(user)}`);
    const rowsB = await openWorldsMenu(page, styles);
    assert(rowsB.every((r) => !r.get), `origin B, offline, expired ID token: a world shows Get: ${JSON.stringify(rowsB)}`);
    assert(rowsB.every((r) => !/sign in/i.test(r.tip)), `origin B: a world row asks to sign in: ${JSON.stringify(rowsB.map((r) => r.tip))}`);
    assert(rowsB.every((r) => !r.disabled && r.w > 0 && r.h > 0 && r.topmost), `origin B: a world row is not clickable where it is drawn: ${JSON.stringify(rowsB)}`);
    const toasts = await page.evaluate(() => [...document.querySelectorAll("#toasts .toast")].map((t) => t.textContent ?? "").join(" | "));
    assert(!/sign in/i.test(toasts), `origin B: a toast asks to sign in: ${toasts}`);
    const spacing = await page.evaluate(auditBoxes, "[data-viz-worlds-menu]", MIN_GAP);
    assert(spacing.length === 0, `Worlds menu spacing: ${spacing.join("; ")}`);
    const held = (await api("/api/market/auth")).data?.view;
    assert(held?.renewable === true && held.email === EMAIL, `the engine dropped the renewable sign-in: ${JSON.stringify(held && { ...held, idToken: "(hidden)" })}`);
    out.originB = { origin: originB, user, rows: rowsB.map(({ style, get, topmost }) => ({ style, get, topmost })) };
    return out;
  } finally {
    await store.close().catch(() => {});
    await api("/api/market/auth/clear", {}).catch(() => {});
    await api("/api/market/receipts", { drop: ids }).catch(() => {});
  }
}

async function main() {
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const wsEndpoint = process.env.LUCID_DEMO_CDP_URL;
  const base = process.env.LUCID_DEMO_URL;
  if ((!browserURL && !wsEndpoint) || !base) {
    console.log("demo_p_market_auth_2: set LUCID_DEMO_BROWSER_URL (or LUCID_DEMO_CDP_URL) and LUCID_DEMO_URL to an isolated QA engine.");
    return;
  }
  assert(new URL(base).hostname === "127.0.0.1", "LUCID_DEMO_URL must be an isolated QA engine on 127.0.0.1");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(wsEndpoint ? { browserWSEndpoint: wsEndpoint } : { browserURL }), defaultViewport: null });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    const r = await verifyMarketAuth2(page, base);
    console.log(JSON.stringify(r, null, 2));
    console.log("P-MARKET.AUTH2 passed: after a restart on another origin, with an expired ID token and the store offline, the Patron is still signed in and every premium world is unlocked.");
    await page.close().catch(() => {});
  } finally {
    browser.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("demo_p_market_auth_2.mjs")) {
  main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
}
