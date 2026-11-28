// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_firstrun_1.mjs
//
// P-FIRSTRUN.1 (ADR-0698): one-time toasts stay one-time across a launch on a new port. Against an isolated QA engine
// whose personalization is not set up:
//   1. a fresh page shows "Make LucidAgent yours" (and, when one is due, Lucid's suggestion: a holiday theme while one
//      is live, else a What's new note); each is dismissed with a real click on its close button;
//   2. the engine now remembers them (GET /api/ui/prefs: lucid.personalNudged, and the suggestion memory);
//   3. the renderer origin's localStorage is wiped (what a port-rolled launch, ADR-0458, gives the renderer) and the
//      page reloads, in a wide (1600x1000) and a narrow (1100x800) window: neither toast comes back.
// The old bundle fails at step 2 (the engine keeps nothing) and step 3 (both toasts return).
//
// Setup (never a user's session): bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811 (fresh: personalization not
// set up), then the QA page open in a browser with remote debugging.
// Run: LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_firstrun_1.mjs

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const GATES = "#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]";
const NUDGE = "Make LucidAgent yours";
/** How long after a load the one-time toasts would have shown (the nudge waits 1.5 s, a suggestion 2.5 s after the
 *  session settles), with room to spare. */
const QUIET_MS = 9000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

export async function verifyFirstRun(page, base) {
  const until = async (read, what, ms = 20_000) => {
    for (const end = Date.now() + ms; ; await pause(200)) {
      const v = await read();
      if (v) return v;
      assert(Date.now() < end, what);
    }
  };
  const skipGates = async () => {
    for (let i = 0, idle = 0; i < 40 && idle < 6; i++) {
      const skip = await page.$(GATES);
      if (!skip) { idle++; await pause(400); continue; }
      idle = 0;
      await skip.click().catch(() => {});
      await pause(400);
    }
  };
  const toastTitles = () => page.evaluate(() => [...document.querySelectorAll("#toasts .toast .h")].map((h) => (h.firstChild?.textContent ?? h.textContent ?? "").trim()));
  /** A real click on the close button of the toast titled `title`. */
  const dismiss = async (title) => {
    const r = await page.evaluate((t) => {
      const toast = [...document.querySelectorAll("#toasts .toast")].find((n) => (n.querySelector(".h")?.textContent ?? "").includes(t));
      const b = toast?.querySelector(".h button")?.getBoundingClientRect();
      return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
    }, title);
    assert(r, `no close button on "${title}"`);
    const hit = await page.evaluate((x, y) => !!document.elementFromPoint(x, y)?.closest("#toasts .toast .h button"), r.x, r.y);
    assert(hit, `the close button on "${title}" is covered`);
    await page.mouse.click(r.x, r.y);
    await until(async () => !(await toastTitles()).some((t) => t.includes(title)), `"${title}" did not close`, 4000);
  };
  const enginePrefs = () => page.evaluate(async () => {
    const t = document.querySelector('meta[name="lucid-token"]')?.content ?? "";
    const r = await fetch("/api/ui/prefs", { headers: { "x-lucid-token": t } });
    return (await r.json().catch(() => null))?.data?.prefs ?? null;
  });
  const load = async () => {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ctViz", { timeout: 30_000 });
    await skipGates();
  };

  const cdp = await page.target().createCDPSession();
  const setSize = async (s) => { await cdp.send("Emulation.setDeviceMetricsOverride", { width: s.width, height: s.height, deviceScaleFactor: 0, mobile: false }); await pause(500); };
  const results = [];
  try {
    await setSize(SIZES[0]);
    // 1. a fresh origin: the toasts show, and are dismissed with real clicks
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await load();
    await until(async () => (await toastTitles()).includes(NUDGE), `"${NUDGE}" never showed on a fresh page`, 15_000);
    await pause(QUIET_MS - 4000); // a suggestion, if one is due, comes a little later
    const seen = (await toastTitles()).filter((t) => t === NUDGE || /^Lucid suggests|^New:/.test(t));
    for (const t of seen) await dismiss(t);
    results.push({ fresh: seen });

    // 2. the engine remembers
    const kept = await until(async () => { const p = await enginePrefs(); return p?.["lucid.personalNudged"] === "1" ? p : null; },
      "the engine did not keep lucid.personalNudged (GET /api/ui/prefs)", 5000);
    const memory = Object.keys(kept).filter((k) => k.startsWith("lucid.suggest.") || k === "lucid.personalNudged");
    results.push({ engine: memory });

    // 3. a port-rolled launch: an empty localStorage, wide and narrow
    for (const size of SIZES) {
      await setSize(size);
      await page.evaluate(() => localStorage.clear());
      await load();
      await pause(QUIET_MS);
      const back = (await toastTitles()).filter((t) => seen.includes(t));
      assert(back.length === 0, `${size.name}: after the wipe these one-time toasts came back: ${back.join(", ")}`);
      results.push({ size: size.name, afterWipe: "no one-time toast came back" });
    }
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_firstrun_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const url = process.env.LUCID_DEMO_URL;
  if ((!endpoint && !browserURL) || !url) throw new Error("Set LUCID_DEMO_CDP_URL (or LUCID_DEMO_BROWSER_URL) and LUCID_DEMO_URL.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(endpoint ? { browserWSEndpoint: endpoint } : { browserURL }), defaultViewport: null, protocolTimeout: 120_000 });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url));
    if (!page) throw new Error(`No page at ${url}`);
    console.log(JSON.stringify(await verifyFirstRun(page, url), null, 2));
    console.log("P-FIRSTRUN.1 passed: the one-time toasts show on a fresh origin, the engine remembers them once dismissed, and a wiped localStorage (a port-rolled launch) does not bring them back, wide and narrow.");
  } finally { await browser.disconnect(); }
}
