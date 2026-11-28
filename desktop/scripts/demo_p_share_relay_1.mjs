// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_share_relay_1.mjs
//
// P-SHARE.RELAY1 (ADR-0700): real-UI proof of the Session Share relay setup, against an isolated QA engine, with the
// dock floating, snapped right and snapped left, in a wide (1600x1000) and a narrow (1100x800) window:
//   1. "Use the LUCID relay" is the big, centered button: at least 240x40, centered in its section, the theme's accent
//      gradient, the custom glyph (hub + two waves), and a glow that pulses (its shadow differs between two samples);
//      the narrow pass emulates reduced motion, where the global reset holds the glow steady and the waves lit;
//      it is topmost at its center, and auditBoxes is clean;
//   2. a real click saves the LUCID relay, and "Relay ready" names it with a one-line "TechLead 187 LLC relay" chip;
//      no chip anywhere in the dock says "self-hosted".
// The old bundle fails at step 1 (the button was a small right-aligned btn-mini).
//
// Setup (never a user's session): bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811, then the QA page open in a
// browser with remote debugging. On Windows, launch Chrome with --disable-features=CalculateNativeWinOcclusion
// --disable-backgrounding-occluded-windows: a covered window reports `hidden` and drops synthesized clicks.
// Run: LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_share_relay_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const SIDES = ["float", "right", "left"];
const GATES = "#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]";
const DOCK_KEY = "lucid.shareDock.v1";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

export async function verifyShareRelay1(page, base) {
  const until = async (read, what, ms = 10_000) => {
    for (const end = Date.now() + ms; ; await pause(150)) {
      const v = await read();
      if (v) return v;
      assert(Date.now() < end, what);
    }
  };
  const center = (sel) => page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    return { x, y, w: r.width, h: r.height, top: !!document.elementFromPoint(x, y)?.closest(s) };
  }, sel);
  const click = async (sel, what) => {
    await page.$eval(sel, (e) => e.scrollIntoView({ block: "center" })).catch(() => {});
    await pause(200);
    const c = await until(() => center(sel), `${what} is not on screen`, 5000);
    assert(c.top, `${what} is covered at its center`);
    await page.mouse.click(c.x, c.y);
  };
  /** The QA engine forgets its relay, so the dock opens on Relay setup. */
  const clearRelay = () => page.evaluate(async () => {
    const token = document.querySelector('meta[name="lucid-token"]')?.content ?? "";
    const r = await fetch("/api/collab/relay", { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-lucid-token": token } : {}) }, body: JSON.stringify({ url: "", publicOptIn: false }) });
    return r.ok;
  });
  /** Where the dock sits when it opens: floating (the default) or snapped to one side (its persisted state). */
  const placeDock = (side, vw, vh) => page.evaluate((key, sd, w, h) => {
    if (sd === "float") { localStorage.removeItem(key); return; }
    const dw = 372, dh = Math.min(560, h - 120);
    localStorage.setItem(key, JSON.stringify({ shape: { x: sd === "right" ? w - dw - 12 : 64, y: 70, w: dw, h: dh }, minimized: false, side: sd, collapsed: {} }));
  }, DOCK_KEY, side, vw, vh);

  const cdp = await page.target().createCDPSession();
  const results = [];
  try {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#railShare", { timeout: 30_000 });
    for (let i = 0, idle = 0; i < 40 && idle < 6; i++) { const s = await page.$(GATES); if (!s) { idle++; await pause(400); continue; } idle = 0; await s.click().catch(() => {}); await pause(400); }
    await pause(1200);
    for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});

    for (const size of SIZES) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      // the narrow pass also asks for reduced motion (Windows "Animation effects" off): a steady, lit glow
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: size.name === "narrow" ? "reduce" : "no-preference" }] });
      await pause(500);
      for (const side of SIDES) {
        const at = `${size.name}/${side}`;
        assert(await clearRelay(), `${at}: could not clear the QA engine's relay`);
        await placeDock(side, size.width, size.height);
        await click("#railShare", `${at}: the rail's Session Share button`);
        await until(() => center("#shareModal"), `${at}: the dock did not open`);
        const cls = await page.$eval("#shareModal", (e) => e.className);
        assert(cls.includes(`side-${side}`), `${at}: the dock opened as ${cls}`);

        // 1. the big, centered, themed, animated button
        const cta = "#shareModal [data-share-relay-hosted]";
        await until(() => center(cta), `${at}: no Use the LUCID relay button`);
        // the dock's first draw after a page load can replace the body once, so measure a laid-out button
        const look = await until(() => page.$eval(cta, (b) => {
          const r = b.getBoundingClientRect(), box = b.closest(".dock-sec-b").getBoundingClientRect(), cs = getComputedStyle(b);
          if (!(r.width > 0)) return null;
          const w2 = b.querySelector(".relay-glyph .rg-w2");
          return {
            cls: b.className, w: r.width, h: r.height, off: Math.abs((r.left + r.right) / 2 - (box.left + box.right) / 2),
            bg: cs.backgroundImage, anim: cs.animationName, glyph: !!b.querySelector("svg.relay-glyph .rg-core"),
            wave: w2 ? getComputedStyle(w2).animationName : "", text: b.textContent.trim(),
            reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
          };
        }).catch(() => null), `${at}: the button never laid out`, 5000);
        assert(look.cls.includes("share-hosted-cta"), `${at}: the button is still ${look.cls}`);
        assert(look.w >= 240 && look.h >= 40, `${at}: the button is ${Math.round(look.w)}x${Math.round(look.h)}, not at least 240x40`);
        assert(look.off <= 2, `${at}: the button is ${look.off.toFixed(1)} px off center`);
        assert(look.bg.includes("linear-gradient"), `${at}: no accent gradient (${look.bg})`);
        assert(look.anim === "relayGlow" && look.wave === "relayWave" && look.glyph, `${at}: glyph or glow missing (${look.anim}, ${look.wave}, glyph ${look.glyph})`);
        assert(look.text === "Use the LUCID relay", `${at}: the button reads ${JSON.stringify(look.text)}`);
        const glow = () => page.$eval(cta, (b) => getComputedStyle(b).boxShadow);
        const g1 = await glow(); await pause(1400); const g2 = await glow();
        if (look.reduced) {
          // the global reduced-motion reset stops the pulse; the resting glow and fully lit waves remain
          const waves = await page.$eval(`${cta} .rg-w2`, (w) => getComputedStyle(w).opacity);
          assert(g1 === g2 && g1.includes("rgb") && waves === "1", `${at}: under reduced motion the glow should hold steady and lit (${g1} / ${g2}, waves ${waves})`);
        } else assert(g1 !== g2, `${at}: the glow does not pulse`);
        assert((await center(cta)).top, `${at}: the button is covered at its center`);
        const bad = await page.evaluate(auditBoxes, '#shareModal .dock-sec[data-sec="sec-relay-setup"]', MIN_GAP);
        assert(bad.length === 0, `${at}: auditBoxes: ${bad.join(" | ")}`);

        // 2. the LUCID relay is named for who runs it
        await click(cta, `${at}: Use the LUCID relay`);
        const chip = await until(() => page.evaluate(() => {
          const t = document.querySelector("#shareModal .share-ready-note .share-peer-tag");
          return t ? { cls: t.className, text: t.textContent.trim(), lines: t.getClientRects().length, h: t.getBoundingClientRect().height } : null;
        }), `${at}: Relay ready did not show`);
        assert(chip.cls.includes("lucid") && chip.text === "TechLead 187 LLC relay", `${at}: the relay chip reads ${JSON.stringify(chip)}`);
        assert(chip.lines === 1 && chip.h < 24, `${at}: the chip wraps (${chip.lines} boxes, ${Math.round(chip.h)} px)`);
        const selfHosted = await page.$$eval("#shareModal .share-peer-tag", (ts) => ts.filter((t) => /self-hosted/i.test(t.textContent)).length);
        assert(selfHosted === 0, `${at}: a chip still says self-hosted`);
        results.push({ layout: at, button: `${Math.round(look.w)}x${Math.round(look.h)}, ${look.off.toFixed(1)} px off center, ${look.reduced ? "steady glow under reduced motion" : "glow pulses"}`, chip: chip.text });
        await click("#shareModal [data-share-close]", `${at}: Close`);
        await until(async () => !(await center("#shareModal")), `${at}: the dock did not close`, 4000);
      }
    }
  } finally {
    await clearRelay().catch(() => {});
    await page.evaluate((k) => localStorage.removeItem(k), DOCK_KEY).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_share_relay_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const url = process.env.LUCID_DEMO_URL;
  if ((!endpoint && !browserURL) || !url) throw new Error("Set LUCID_DEMO_CDP_URL (or LUCID_DEMO_BROWSER_URL) and LUCID_DEMO_URL.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(endpoint ? { browserWSEndpoint: endpoint } : { browserURL }), defaultViewport: null, protocolTimeout: 120_000 });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url));
    if (!page) throw new Error(`No page at ${url}`);
    console.log(JSON.stringify(await verifyShareRelay1(page, url), null, 2));
    console.log("ADR-0700 passed: Use the LUCID relay is the big, centered, glowing button, and the LUCID relay reads as the TechLead 187 LLC relay, never self-hosted, floating and snapped, wide and narrow.");
  } finally { await browser.disconnect(); }
}
