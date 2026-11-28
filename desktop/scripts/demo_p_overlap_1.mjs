// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_overlap_1.mjs
//
// P-OVERLAP.1: real-UI proof of the four #677 overlaps, against an isolated QA engine (scripted fake agent), in a wide
// (1600x1000) and a narrow (1100x800) window:
//   1. a toast raised inside the Provider Hub (a real click on a provider's Save with no key) is topmost at its center,
//      not dimmed under the hub's own backdrop (#toasts used to sit at z 120 under .modal-ov at z 200);
//   2. a Fleet lane asking for approval: its floating Agent sits above the approval bar, never on the ask's text; the
//      text is topmost at its start and center, auditBoxes is clean on the bar, and a real click on Allow lands;
//   3. Agent Worlds, with a second lane that wrote the scripted penalty-shootout page: the lane's floating Agent never
//      covers its node's preview chip, zoomed in and zoomed out;
//   4. Agent Worlds: with the node panel docked over the stage's bottom-left corner, the role legend steps aside (it
//      used to show through the panel's prompt box) and comes back when the panel closes.
// The old bundle fails at step 1 (the toast's center hits #provHub).
//
// Setup (never a user's session): bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811, then the QA page open in a
// browser with remote debugging.
// Run: LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_overlap_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const GATES = "#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]";
const ASK_PROMPT = "Ship a PCI-safe checkout microservice"; // the script that asks for approval once per session
const PAGE_PROMPT = "Build a Lucid Agent World mini game: penalty shootout"; // the script that writes a previewable page
const HOME_KEY = "lucid.fleetHome.v1";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const meets = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

export async function verifyOverlap(page, base) {
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content);
  const api = (path, body) => page.evaluate(async (p, b, t) => {
    const r = await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", "x-lucid-token": t }, ...(b ? { body: JSON.stringify(b) } : {}) });
    const j = await r.json().catch(() => null);
    return j?.data ?? j;
  }, path, body ?? null, token);
  /** /api/fleet/prompt answers when the turn ends: send it from the page and do not wait on it. */
  const promptLane = (laneId, text) => page.evaluate((id, x, t) => {
    void fetch("/api/fleet/prompt", { method: "POST", headers: { "content-type": "application/json", "x-lucid-token": t }, body: JSON.stringify({ laneId: id, text: x }) }).catch(() => {});
  }, laneId, text, token);
  const until = async (read, what, ms = 20_000) => {
    for (const end = Date.now() + ms; ; await pause(200)) {
      const v = await read();
      if (v) return v;
      assert(Date.now() < end, what);
    }
  };
  const rect = (sel) => page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e || e.closest("[hidden]")) return null;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
  }, sel);
  /** What a click at (x, y) would land on, as "inside <sel>" or the element it hits. */
  const hitAt = (x, y, sel) => page.evaluate((px, py, s) => {
    const at = document.elementFromPoint(px, py);
    return at?.closest(s) ? "ok" : at ? `${at.tagName.toLowerCase()}${at.id ? `#${at.id}` : ""}.${String(at.className).split(" ")[0]}` : "nothing";
  }, x, y, sel);
  const topmost = async (sel, what) => {
    const r = await rect(sel);
    assert(r, `${what} is not on screen`);
    const hit = await hitAt((r.left + r.right) / 2, (r.top + r.bottom) / 2, sel);
    assert(hit === "ok", `${what} is covered at its center by ${hit}`);
    return r;
  };
  const audit = async (sel, where) => {
    const bad = await page.evaluate(auditBoxes, sel, MIN_GAP);
    assert(bad.length === 0, `${where}: auditBoxes on ${sel}: ${bad.join(" | ")}`);
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
  const dismissToasts = async () => { for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {}); await pause(300); };
  const shown = (sel) => rect(sel).then((r) => !!r);
  const laneStatus = async (id) => ((await api("/api/fleet/status"))?.lanes ?? []).find((l) => l.id === id)?.status;
  const idle = async (id) => { const s = await laneStatus(id); return s === "awaiting-input" || s === "done"; };
  /** A prompt sent the moment a turn ends can be refused while the lane settles: send again until a turn starts. */
  const startTurn = async (id, text) => {
    for (let i = 0; i < 4; i++) {
      await promptLane(id, text);
      try { await until(async () => !(await idle(id)), "", 12_000); return; } catch { await pause(1500); }
    }
    throw new Error(`the lane never started a turn for "${text}"`);
  };

  const cdp = await page.target().createCDPSession();
  const setSize = async (s) => { await cdp.send("Emulation.setDeviceMetricsOverride", { width: s.width, height: s.height, deviceScaleFactor: 0, mobile: false }); await pause(700); };
  const savedHome = await page.evaluate((h) => localStorage.getItem(h), HOME_KEY);
  const results = [];
  let laneId = null;
  try {
    await page.goto(new URL("?vizScript=1", base).href, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ctViz", { timeout: 30_000 });
    await skipGates();
    await dismissToasts();

    // 1. a toast inside the Provider Hub is topmost
    for (const size of SIZES) {
      await setSize(size);
      // The rail's command button opens the palette (always in the DOM; .show is open).
      const palette = '.palette.show input[name="command-search"]';
      const cmd = await topmost("#railCmd", `${size.name}: the rail's command button`);
      await page.mouse.click((cmd.left + cmd.right) / 2, (cmd.top + cmd.bottom) / 2);
      await until(() => page.$(palette).then((h) => !!h), "the command button did not open the palette", 4000);
      await pause(100); // the palette focuses its box 20 ms after it opens
      await page.focus(palette);
      await page.keyboard.type("Connect a provider");
      await page.keyboard.press("Enter");
      await until(() => shown('#provHub [data-hub-tile="perplexity"]'), "the palette did not open the Provider Hub", 6000);
      await dismissToasts();
      await (await page.$('#provHub [data-hub-tile="perplexity"]')).click();
      const save = '#provHub [data-hub-item="perplexity"] [data-savekey]';
      await until(() => shown(save), "the provider card did not open", 4000);
      await (await page.$(save)).click(); // no key typed: the hub answers with a "Nothing to save" toast
      const toast = await until(() => page.evaluate(() => {
        const t = [...document.querySelectorAll("#toasts .toast")].find((n) => /Nothing to save/.test(n.textContent || ""));
        return t ? (t.id ||= "p-overlap-toast") : null;
      }), "no toast after Save", 4000);
      await pause(350); // its entrance
      await topmost(`#${toast}`, `${size.name}: the hub's toast`);
      await audit(`#${toast}`, `${size.name}: the hub's toast`);
      await page.$eval("#provHubClose", (b) => b.click());
      await until(async () => !(await shown("#provHub")), "the hub did not close", 4000);
      await dismissToasts();
      results.push({ size: size.name, hubToast: "topmost over the hub's backdrop" });
    }

    // 2. a lane's approval bar is clear of its floating Agent
    await setSize(SIZES[0]);
    const ws = (await api("/api/workspace"))?.current;
    const sp = await api("/api/fleet/spawn", { name: "overlap-one", ...(ws ? { cwd: ws } : {}) });
    laneId = sp?.lane?.id ?? sp?.id;
    assert(laneId, `spawn failed: ${JSON.stringify(sp).slice(0, 200)}`);
    await until(() => idle(laneId), "the lane did not become idle", 60_000);
    await startTurn(laneId, ASK_PROMPT);
    await page.evaluate((k) => localStorage.setItem(k, "grid"), HOME_KEY);
    if (!(await shown("#fleetGrid"))) await page.$eval("#ctFleet", (b) => b.click());
    await until(() => shown("#fleetGrid"), "the Fleet button did not open the grid", 6000);
    const card = `.fleet-card[data-lane="${laneId}"]`;
    const bar = `${card} [data-fleet-approve]`;
    await until(() => shown(bar), "the lane never asked for approval", 120_000);
    for (const size of SIZES) {
      await setSize(size);
      await pause(500); // the buddy re-lays out on the bar's ResizeObserver
      const b = await rect(bar);
      const buddy = await rect(`${card} .abd-host[data-where="lane"] .abd-brick`);
      assert(buddy, `${size.name}: the lane's floating Agent is not shown`);
      assert(!meets(buddy, b), `${size.name}: the floating Agent (${JSON.stringify(buddy)}) covers the approval bar (${JSON.stringify(b)})`);
      const txt = await rect(`${bar} [data-fleet-approve-txt]`);
      for (const [x, what] of [[txt.left + 6, "start"], [(txt.left + txt.right) / 2, "center"]]) {
        const hit = await hitAt(x, (txt.top + txt.bottom) / 2, "[data-fleet-approve]");
        assert(hit === "ok", `${size.name}: the ask's text is covered at its ${what} by ${hit}`);
      }
      await audit(bar, `${size.name}: the approval bar`);
      results.push({ size: size.name, approvalBar: "clear of the floating Agent" });
    }
    const allow = await topmost(`${bar} [data-fleet-allow]`, "Allow");
    await page.mouse.click((allow.left + allow.right) / 2, (allow.top + allow.bottom) / 2);
    await until(async () => !(await shown(bar)), "Allow did not answer the ask", 8000);
    await api("/api/fleet/stop", { laneId }); await api("/api/fleet/remove", { laneId });

    // a previewable page from a fresh lane (its script asks nothing), for the node's preview chip in Agent Worlds
    const sp2 = await api("/api/fleet/spawn", { name: "overlap-two", ...(ws ? { cwd: ws } : {}) });
    laneId = sp2?.lane?.id ?? sp2?.id;
    assert(laneId, `spawn failed: ${JSON.stringify(sp2).slice(0, 200)}`);
    await until(() => idle(laneId), "the second lane did not become idle", 60_000);
    await startTurn(laneId, PAGE_PROMPT);
    await until(() => shown(`.fleet-card[data-lane="${laneId}"] [data-lane-preview]`), "the lane's page never became a preview chip", 150_000);
    // The new session asks once too: answering it is setup here (step 2 proved the bar), so it goes through the DOM.
    const bar2 = `.fleet-card[data-lane="${laneId}"] [data-fleet-approve]`;
    for (let end = Date.now() + 240_000; !(await idle(laneId)); await pause(500)) {
      assert(Date.now() < end, "the page turn did not finish");
      if (await shown(bar2)) await page.$eval(`${bar2} [data-fleet-allow]`, (b) => b.click()).catch(() => {});
    }

    // 3. Agent Worlds: the buddy beside, never on, the node's preview chip
    await page.$eval("#ctFleet", (b) => b.click()).catch(() => {});
    await page.$eval("#ctViz", (b) => b.click());
    await until(() => shown("#vizView [data-viz-stage]"), "Visualize did not open", 10_000);
    await skipGates();
    await until(() => page.evaluate(() => (window.__vizProbe?.nodes?.() ?? []).length > 0), "no nodes in Visualize", 20_000);
    await page.$eval("[data-viz-auto]", (c) => { if (c.checked) c.click(); });
    const chip = `[data-viz-preview-chip="${laneId}"]`;
    const worldBuddy = `.abd-host[data-where="world"] .abd[data-abd-lane="${laneId}"]`;
    for (const size of SIZES) {
      await setSize(size);
      await page.$eval("[data-viz-fit]", (b) => b.click());
      await pause(1500);
      for (let step = 0; step < 4; step++) {
        const c = await rect(chip), bud = await rect(worldBuddy);
        if (c && bud) assert(!meets(bud, c), `${size.name}, zoom step ${step}: the floating Agent (${JSON.stringify(bud)}) covers the preview chip (${JSON.stringify(c)})`);
        if (step === 3) assert(c && bud, `${size.name}: zoomed out, the chip or the buddy is not on the stage`);
        const st = await rect("#vizView [data-viz-stage]");
        await page.mouse.move((st.left + st.right) / 2, (st.top + st.bottom) / 2);
        await page.mouse.wheel({ deltaY: 500 });
        await pause(900);
      }
      results.push({ size: size.name, worldBuddy: "beside the preview chip at every zoom" });
    }

    // 4. Agent Worlds: the legend steps aside under the docked panel
    for (const size of SIZES) {
      await setSize(size);
      await page.$eval("[data-viz-fit]", (b) => b.click());
      await pause(1500);
      const node = await until(() => page.evaluate((id) => (window.__vizProbe?.nodes?.() ?? []).find((n) => n.id === id && n.box)?.box ?? null, laneId), "the lane's node is not on screen", 8000);
      await page.mouse.click(node.x, node.y);
      await until(() => shown("#vizView [data-viz-panel]"), `${size.name}: clicking the node did not open its panel`, 6000);
      const legend = await rect("#vizView [data-viz-legend]");
      assert(legend, `${size.name}: the role legend is not shown`);
      // Pan the world right-to-left with the right button until the node leaves the stage: the panel docks at the
      // stage's left edge, over the legend's corner.
      const st = await rect("#vizView [data-viz-stage]");
      for (let i = 0; i < 6; i++) {
        const p = await rect("#vizView [data-viz-panel]");
        if (meets(p, legend)) break;
        await page.mouse.move(st.right - 80, st.top + 120);
        await page.mouse.down({ button: "right" });
        for (let k = 1; k <= 12; k++) { await page.mouse.move(st.right - 80 - k * 40, st.top + 120 + k * 22); await pause(16); }
        await page.mouse.up({ button: "right" });
        await pause(700);
      }
      const panel = await rect("#vizView [data-viz-panel]");
      assert(meets(panel, legend), `${size.name}: could not pan the panel over the legend (panel ${JSON.stringify(panel)}, legend ${JSON.stringify(legend)})`);
      await pause(300); // the legend's fade
      const vis = await page.$eval("#vizView [data-viz-legend]", (e) => getComputedStyle(e).visibility);
      assert(vis === "hidden", `${size.name}: the role legend shows through the node panel (visibility ${vis})`);
      await topmost("#vizView [data-viz-panel-input]", `${size.name}: the panel's prompt box`);
      await page.$eval("#vizView [data-viz-panel-close]", (b) => b.click());
      await until(async () => !(await shown("#vizView [data-viz-panel]")), "the panel did not close", 4000);
      await pause(300);
      const back = await page.$eval("#vizView [data-viz-legend]", (e) => getComputedStyle(e).visibility);
      assert(back === "visible", `${size.name}: the legend did not come back after the panel closed (visibility ${back})`);
      results.push({ size: size.name, legend: "steps aside under the panel, back when it closes" });
    }
  } finally {
    if (laneId) { await api("/api/fleet/stop", { laneId }).catch(() => {}); await api("/api/fleet/remove", { laneId }).catch(() => {}); }
    if (await shown("#vizView [data-viz-stage]").catch(() => false)) await page.$eval("[data-viz-close]", (b) => b.click()).catch(() => {});
    if (await shown("#fleetGrid").catch(() => false)) await page.$eval("#ctFleet", (b) => b.click()).catch(() => {});
    await page.evaluate((h, v) => { if (v === null) localStorage.removeItem(h); else localStorage.setItem(h, v); }, HOME_KEY, savedHome).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_overlap_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const url = process.env.LUCID_DEMO_URL;
  if ((!endpoint && !browserURL) || !url) throw new Error("Set LUCID_DEMO_CDP_URL (or LUCID_DEMO_BROWSER_URL) and LUCID_DEMO_URL.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(endpoint ? { browserWSEndpoint: endpoint } : { browserURL }), defaultViewport: null, protocolTimeout: 120_000 });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url));
    if (!page) throw new Error(`No page at ${url}`);
    console.log(JSON.stringify(await verifyOverlap(page, url), null, 2));
    console.log("P-OVERLAP.1 passed: a toast stays on top of the Provider Hub, a lane's floating Agent clears its approval bar, a world buddy clears its node's preview chip, and the role legend steps aside under the node panel, wide and narrow.");
  } finally { await browser.disconnect(); }
}
