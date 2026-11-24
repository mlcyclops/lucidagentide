// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_worlds_checkout_1.mjs
//
// P-WORLDS.STORE1b: the LIVE store proof that Buy takes the user to Stripe Checkout. P-WORLDS.STORE1's demo drove
// the drawer with no signed-in provider, so it never pressed a real Buy; the 2026-11-23 outage (the store's CORS
// refused the desktop origin http://127.0.0.1) would have passed it. This script signs a throwaway account into a
// QA renderer served from http://127.0.0.1:<port> (the desktop app's origin), presses the real controls with real
// mouse input, and asserts a Stripe Checkout page opens with the right item and price:
//   1. a world (Christmas, $9.99): Buy, license sheet, accept, Continue to checkout;
//   2. Patron Class ($99.99): the same;
//   3. Sponsor ($49.99): Buy opens the picker, 6 picks, Continue, license sheet lists the picks, checkout.
// Each Stripe page is screenshotted into LUCID_DEMO_SHOTS (default: the OS temp dir). Nothing is paid: the live
// Checkout Sessions are left unpaid and expire on their own. The throwaway account is deleted at the end.
//
// It talks to the PRODUCTION store, so it runs only when LUCID_DEMO_LIVE_STORE=1. Run against an isolated QA
// engine (bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811) and a Chrome with a CDP port:
//   LUCID_DEMO_LIVE_STORE=1 LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:7811/ bun desktop/scripts/demo_p_worlds_checkout_1.mjs

import { tmpdir } from "node:os";
import { join } from "node:path";

const FUNCTIONS = "https://us-central1-lucid-agent.cloudfunctions.net";
const SIGNIN = "https://lucid-agent.web.app/signin";
// The PUBLIC Firebase web key of project lucid-agent (it ships in the /buy page; it identifies the project only).
const API_KEY = "AIzaSyC0YWHhH0BXGQawz7kZxLqUdBbfvGwubYE";
const IDT = "https://identitytoolkit.googleapis.com/v1/accounts";
const SPONSOR_PICKS = ["world-christmas", "world-soccer", "world-circus", "world-farm", "world-esports", "world-wave-riders"];

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

async function throwawayAccount() {
  const r = await fetch(`${IDT}:signUp?key=${API_KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `qa-checkout-${Date.now()}@example.com`, password: crypto.randomUUID(), returnSecureToken: true }),
  });
  const s = await r.json();
  assert(s.idToken, `could not create the throwaway account: ${JSON.stringify(s.error ?? s)}`);
  return s;
}

async function deleteAccount(idToken) {
  const r = await fetch(`${IDT}:delete?key=${API_KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken }) });
  return r.status;
}

export async function verifyCheckout(browser, page, url, shots) {
  const results = [];
  const center = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width }; });
  const clickReal = async (sel, what) => {
    await page.waitForSelector(sel, { visible: true, timeout: 15000 }).catch(() => { throw new Error(`${what} never appeared (${sel})`); });
    await page.$eval(sel, (n) => n.scrollIntoView({ block: "center" }));
    await pause(250);
    const c = await center(sel);
    const top = await page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
    assert(c.w > 0 && top, `${what} is hidden or covered`);
    await page.mouse.click(c.x, c.y);
  };
  const dismissToasts = async () => { for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {}); await pause(300); };

  // Get more worlds from Visualize, the way the user reaches the store.
  await page.click("#ctViz");
  await page.waitForSelector("#vizView [data-viz-worlds]", { visible: true, timeout: 20000 });
  await pause(800);
  await dismissToasts();
  await clickReal("#vizView [data-viz-worlds]", "the Worlds button");
  await clickReal("[data-viz-world-store]", "Get more worlds");
  await page.waitForSelector(".plg-layer.plg-in .plg-drawer", { timeout: 8000 });
  if (!(await page.$('[data-plg-tier="premium"][aria-selected="true"]'))) await clickReal('[data-plg-tier="premium"]', "the Premium tab");

  // Signed in: the cards must say Buy (not "Sign in to buy"), which also proves getEntitlement answered.
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-plg-act="world-christmas"]');
    return b && b.getAttribute("data-kind") === "buy";
  }, { timeout: 20000 }).catch(async () => {
    const kind = await page.$eval('[data-plg-act="world-christmas"]', (n) => `${n.getAttribute("data-kind")} "${n.textContent}"`).catch(() => "missing");
    throw new Error(`the Christmas card never offered Buy while signed in (it shows ${kind})`);
  });
  await page.screenshot({ path: join(shots, "checkout-0-store-signed-in.png") });

  const viaStripe = async (id, label, expect, prep) => {
    const opened = new Promise((resolve) => {
      const on = async (t) => {
        if (t.type() !== "page") return;
        const p = await t.page();
        browser.off("targetcreated", on);
        resolve(p);
      };
      browser.on("targetcreated", on);
    });
    await clickReal(`[data-plg-act="${id}"]`, `${label}: Buy`);
    if (prep) await prep();
    await page.waitForSelector("[data-plg-accept]", { visible: true, timeout: 8000 });
    const lead = await page.$eval(".plg-sheet .plg-sheet-price", (n) => n.textContent ?? "");
    await page.screenshot({ path: join(shots, `checkout-${id}-license.png`) });
    await clickReal("[data-plg-accept]", `${label}: the license box`);
    await clickReal("[data-plg-checkout]", `${label}: Continue to checkout`);
    const tab = await Promise.race([opened, pause(25000).then(() => null)]);
    if (!tab) {
      const note = await page.$eval(`[data-plg-foot="${id}"] .plg-note`, (n) => n.textContent).catch(() => "(no note)");
      throw new Error(`${label}: Continue to checkout opened no page. Card note: ${note}`);
    }
    await tab.waitForFunction(() => location.hostname === "checkout.stripe.com" && document.body && document.body.innerText.length > 200, { timeout: 30000 })
      .catch(() => { throw new Error(`${label}: the opened page is not a loaded Stripe Checkout (${tab.url()})`); });
    await pause(1500);
    const text = await tab.evaluate(() => document.body.innerText);
    for (const e of expect) assert(text.includes(e), `${label}: the Stripe page does not show "${e}"`);
    const shot = join(shots, `checkout-${id}-stripe.png`);
    await tab.setViewport({ width: 1280, height: 900 });
    await tab.screenshot({ path: shot });
    const note = await page.$eval(`[data-plg-foot="${id}"] .plg-note`, (n) => n.textContent).catch(() => "");
    results.push({ item: label, stripe: tab.url().split("#")[0].slice(0, 70) + "...", shows: expect, lead: lead.slice(0, 90), cardNote: note, shot });
    await tab.close();
    await page.bringToFront();
    await pause(500);
  };

  await viaStripe("world-christmas", "Christmas", ["9.99"]);
  await viaStripe("bundle-patron", "Patron Class", ["99.99"]);
  await viaStripe("bundle-sponsor", "Sponsor", ["49.99"], async () => {
    await page.waitForSelector("[data-plg-pick]", { visible: true, timeout: 8000 });
    for (const w of SPONSOR_PICKS) await clickReal(`[data-plg-pick="${w}"]`, `Sponsor picker: ${w}`);
    const count = await page.$eval("[data-plg-pickcount]", (n) => n.textContent);
    assert(count === "6 of 6 picked", `Sponsor picker count says "${count}"`);
    await page.screenshot({ path: join(shots, "checkout-bundle-sponsor-picker.png") });
    await clickReal("[data-plg-picks-go]", "Sponsor picker: Continue");
  });
  return results;
}

async function main() {
  if (process.env.LUCID_DEMO_LIVE_STORE !== "1") {
    console.log("demo_p_worlds_checkout_1: set LUCID_DEMO_LIVE_STORE=1 to run the live store checkout proof (it creates and deletes a throwaway account).");
    return;
  }
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an isolated QA browser and engine.");
  assert(new URL(url).hostname === "127.0.0.1", "LUCID_DEMO_URL must be http://127.0.0.1:<port>/, the desktop app's origin");
  const shots = process.env.LUCID_DEMO_SHOTS || tmpdir();
  const acct = await throwawayAccount();
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url)) ?? (await browser.newPage());
    await page.setViewport({ width: 1320, height: 1000 });
    const record = JSON.stringify({ idToken: acct.idToken, email: acct.email, expiresAt: Date.now() + Number(acct.expiresIn) * 1000 });
    // The desktop preload injects __LUCID_MARKET__; in a plain browser this does the same, and the stored token is
    // what the lucid://auth deep link would have saved.
    await page.evaluateOnNewDocument((cfg, rec) => {
      window.__LUCID_MARKET__ = cfg;
      try { localStorage.setItem("lucid.market.auth", rec); } catch { /* not this origin */ }
    }, { mode: "firebase", functionsBaseUrl: FUNCTIONS, signInUrl: SIGNIN }, record);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    for (let i = 0; i < 5; i++) {
      const hit = await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((n) => /^\s*(Skip|No - standard use)/.test(n.textContent || "") && n.getBoundingClientRect().width > 0);
        if (b) { b.click(); return true; }
        return false;
      });
      if (!hit) break;
      await pause(900);
    }
    const results = await verifyCheckout(browser, page, url, shots);
    console.log(JSON.stringify(results, null, 2));
    console.log("P-WORLDS.STORE1b passed: signed in from http://127.0.0.1, Buy on a world, Patron Class and Sponsor (6 picks) each opened a live Stripe Checkout with the right price.");
  } finally {
    console.log(`throwaway account deleted: HTTP ${await deleteAccount(acct.idToken)}`);
    browser.disconnect();
  }
}

if (import.meta.main) await main();
