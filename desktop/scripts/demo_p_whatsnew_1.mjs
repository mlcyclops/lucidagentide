// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_whatsnew_1.mjs
//
// P-WHATSNEW.1 (ADR-0686): the one-time What's new popup after an upgrade, replayable from About. Against an
// isolated QA engine (fresh settings file) on a FRESH browser profile it:
//   1. loads the app, clears the first-run gates and asserts no popup on a fresh install, and that the engine
//      recorded the running version silently (GET /api/settings whatsNewSeen);
//   2. simulates an upgrade through the real engine route (POST /api/settings whatsNewSeen = an older version)
//      and reloads: the popup appears once, every card image has loaded (naturalWidth > 0), Dismiss, the close X
//      and a Learn more link are on top at their centers (elementFromPoint), auditBoxes finds no spacing fault,
//      and the engine now records the running version;
//   3. Dismiss closes it and shows the About hint toast;
//   4. a reload shows no popup;
//   5. About > What's new (elementFromPoint on the button, auditBoxes on About) reopens it read-only: the seen
//      version is unchanged and closing it shows no hint.
//
// Run (QA engine: bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7821, and a Chrome with a CDP port on a fresh
// profile):
//   LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7821/ node desktop/scripts/demo_p_whatsnew_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const OLDER = "2.0.0";
const GATES = "#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]";

async function engineApi(base) {
  const html = await (await fetch(base)).text();
  const token = /<meta name="lucid-token" content="([^"]+)"/.exec(html)?.[1];
  assert(token, "no lucid-token meta on the engine page");
  const headers = { "x-lucid-token": token, "content-type": "application/json" };
  return async (path, body) => {
    const r = await fetch(new URL(path, base), body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    return { status: r.status, data: j?.data ?? j };
  };
}

/** Clicks every first-run gate the page shows, a few rounds, so onboarding never covers what we measure. */
async function clearGates(page) {
  for (let i = 0; i < 10; i++) {
    await page.evaluate((sel) => { for (const b of document.querySelectorAll(sel)) if (b.getBoundingClientRect().width > 0) b.click(); }, GATES);
    await pause(450);
  }
}

/** The element at `sel`'s center is `sel` itself (or inside it): nothing covers the control. */
async function onTop(page, sel) {
  const r = await page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n) return { found: false };
    n.scrollIntoView({ block: "center", inline: "nearest" });
    const b = n.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { found: true, hit: !!hit && (hit === n || n.contains(hit)), what: hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join(".")}` : "nothing" };
  }, sel);
  assert(r.found, `${sel} is not on the page`);
  assert(r.hit, `${sel} is covered at its center by ${r.what}`);
}

async function audit(page, sel) {
  const faults = await page.evaluate(auditBoxes, sel, MIN_GAP);
  assert(faults.length === 0, `spacing faults in ${sel}:\n  ${faults.join("\n  ")}`);
}

const modalShown = (page) => page.evaluate(() => !!document.querySelector("#whatsNewModal"));

async function waitForModal(page, ms) {
  for (let t = 0; t < ms; t += 400) {
    if (await modalShown(page)) return true;
    await page.evaluate((sel) => { for (const b of document.querySelectorAll(sel)) if (b.getBoundingClientRect().width > 0) b.click(); }, GATES);
    await pause(400);
  }
  return false;
}

async function seenVersion(api) { return (await api("/api/settings")).data?.whatsNewSeen ?? null; }

export async function verifyWhatsNew(page, base) {
  const api = await engineApi(base);
  const current = (await api("/api/build-info")).data?.version;
  assert(/^\d+\.\d+\.\d+/.test(current ?? ""), `no app version from /api/build-info: ${current}`);

  // 1. fresh install: no popup, the version recorded silently
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#input", { visible: true, timeout: 60000 });
  await clearGates(page);
  await pause(2500);
  assert(!(await modalShown(page)), "a fresh install showed the What's new popup");
  let seen = null;
  for (let i = 0; i < 20 && seen !== current; i++) { seen = await seenVersion(api); if (seen !== current) await pause(300); }
  assert(seen === current, `a fresh install did not record ${current} (whatsNewSeen=${seen})`);

  // 2. an upgrade: the engine says the user last saw an older version
  const set = await api("/api/settings", { whatsNewSeen: OLDER });
  assert(set.status < 400 && set.data?.whatsNewSeen === OLDER, `POST /api/settings whatsNewSeen failed: ${JSON.stringify(set.data)}`);
  const bad = await api("/api/settings", { whatsNewSeen: "<script>" });
  assert(bad.data?.whatsNewSeen === OLDER, "the engine stored a non-version whatsNewSeen");
  await page.reload({ waitUntil: "domcontentloaded" });
  assert(await waitForModal(page, 20000), "the What's new popup did not appear after the upgrade");
  for (let i = 0; i < 30; i++) {
    const done = await page.evaluate(() => [...document.querySelectorAll("#whatsNewModal .wn-shot img")].every((i) => i.complete));
    if (done) break;
    await pause(200);
  }
  const imgs = await page.evaluate(() => [...document.querySelectorAll("#whatsNewModal .wn-shot img")].map((i) => ({ src: i.getAttribute("src"), w: i.naturalWidth })));
  assert(imgs.length > 0, "the popup has no cards");
  const broken = imgs.filter((i) => !(i.w > 0));
  assert(broken.length === 0, `images did not load: ${broken.map((i) => i.src).join(", ")}`);
  const groups = await page.evaluate(() => [...document.querySelectorAll("#whatsNewModal [data-wn-group]")].map((g) => g.getAttribute("data-wn-group")));
  assert(groups[0] === "feature", `the first group is not New features: ${groups}`);
  await onTop(page, "#whatsNewModal [data-wn-dismiss]");
  await onTop(page, "#whatsNewModal [data-wn-close]");
  await onTop(page, "#whatsNewModal .wn-more");
  const more = await page.$eval("#whatsNewModal .wn-more", (a) => ({ href: a.href, target: a.target, rel: a.rel }));
  assert(/^https:\/\/(docs\.)?lucid-agents\.com\//.test(more.href) && more.target === "_blank" && more.rel === "noopener noreferrer", `Learn more is not a safe external link: ${JSON.stringify(more)}`);
  // The Dismiss row is sticky: cards scroll beneath it by design. Audit at the end of the list, where the row sits in
  // its own place below the last card, so only real layout faults count.
  await page.$eval("#whatsNewModal .about-modal", (m) => { m.scrollTop = m.scrollHeight; });
  await pause(200);
  await audit(page, "#whatsNewModal .about-modal");
  const suggestion = await page.evaluate(() => [...document.querySelectorAll("#toasts .toast")].map((t) => t.textContent ?? "").filter((t) => /Tell me more|Wear it/.test(t)));
  assert(suggestion.length === 0, "Lucid's suggestion toast stacked on the popup");
  for (let i = 0; i < 20 && seen !== current; i++) { seen = await seenVersion(api); if (seen !== current) await pause(300); }
  assert(seen === current, `showing the popup did not record ${current} (whatsNewSeen=${seen})`);

  // 3. Dismiss: closed, and the toast says where to find it again
  const d = await page.$eval("#whatsNewModal [data-wn-dismiss]", (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(d.x, d.y);
  await pause(400);
  assert(!(await modalShown(page)), "Dismiss did not close the popup");
  const hint = await page.evaluate(() => [...document.querySelectorAll("#toasts .toast")].map((t) => t.textContent ?? "").find((t) => t.includes("About > What's new")) ?? "");
  assert(hint, "no About > What's new hint toast after Dismiss");

  // 4. once only
  await page.reload({ waitUntil: "domcontentloaded" });
  assert(!(await waitForModal(page, 6000)), "the popup came back after a reload");

  // 5. About > What's new replays it, read-only
  await page.evaluate(() => { for (const t of document.querySelectorAll("#toasts .toast .h button")) t.click(); });
  await page.evaluate(() => document.querySelector("#railAbout, .rail-about")?.click());
  await page.waitForSelector("#aboutModal [data-about-whatsnew]", { visible: true, timeout: 10000 });
  await audit(page, "#aboutModal .about-modal");
  await onTop(page, "#aboutModal [data-about-whatsnew]");
  const a = await page.$eval("#aboutModal [data-about-whatsnew]", (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(a.x, a.y);
  assert(await waitForModal(page, 4000), "About > What's new did not open the popup");
  assert(!(await page.evaluate(() => !!document.querySelector("#aboutModal"))), "About stayed open under the popup");
  await page.keyboard.press("Escape");
  await pause(400);
  assert(!(await modalShown(page)), "Esc did not close the replayed popup");
  assert((await seenVersion(api)) === current, "the About replay changed the seen version");
  return { current, simulatedFrom: OLDER, cards: imgs.length, groups, learnMore: more.href, hint: hint.replace(/\s+/g, " ").trim() };
}

async function main() {
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const wsEndpoint = process.env.LUCID_DEMO_CDP_URL;
  const base = process.env.LUCID_DEMO_URL;
  if ((!browserURL && !wsEndpoint) || !base) {
    console.log("demo_p_whatsnew_1: set LUCID_DEMO_BROWSER_URL (or LUCID_DEMO_CDP_URL) and LUCID_DEMO_URL to an isolated QA engine.");
    return;
  }
  assert(new URL(base).hostname === "127.0.0.1", "LUCID_DEMO_URL must be an isolated QA engine on 127.0.0.1");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(wsEndpoint ? { browserWSEndpoint: wsEndpoint } : { browserURL }), defaultViewport: null });
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.setViewport({ width: 1400, height: 900 });
    const r = await verifyWhatsNew(page, base);
    console.log(JSON.stringify(r, null, 2));
    console.log("P-WHATSNEW.1 passed: a fresh install records silently, an upgrade shows What's new once with its pictures, Dismiss points at About, and About replays it read-only.");
  } finally {
    browser.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("demo_p_whatsnew_1.mjs")) {
  main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
}
