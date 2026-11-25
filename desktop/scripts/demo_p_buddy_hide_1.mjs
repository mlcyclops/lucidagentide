// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_buddy_hide_1.mjs
//
// P-BUDDY.HIDE1: real-UI proof of the floating Agent's red x, driven with real mouse input against an isolated QA
// engine, in a wide (1600x1000) and a narrow (1100x800) window:
//   1. Main's buddy: at rest its x takes no clicks (the brick's upper-right corner is the brick's); hovering the brick
//      shows a small red x on that corner, topmost at its center; a real click hides the buddy and a toast offers
//      Undo (auditBoxes clean); Undo brings it back; hiding it again survives a reload (same session);
//   2. a Fleet lane's buddy on its card: the same hover and x; it hides from that card only, Main's buddy is not
//      touched by it.
// Every lane started is stopped and the hidden list is cleared at the end.
//
// Setup (never a user's session): bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811, then the QA page open in a
// browser with remote debugging, past the first-run gates.
// Run: LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_buddy_hide_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const HIDDEN_KEY = "lucid.buddies.hidden.v1";
const MAIN = '.abd[data-abd-surface="main"]';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

export async function verifyBuddyHide(page) {
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content);
  const api = (path, body) => page.evaluate(async (p, b, t) => {
    const r = await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", "x-lucid-token": t }, ...(b ? { body: JSON.stringify(b) } : {}) });
    const j = await r.json();
    return j?.data ?? j;
  }, path, body ?? null, token);
  const until = async (read, what, ms = 20_000) => {
    for (const end = Date.now() + ms; ; await pause(150)) {
      const v = await read();
      if (v) return v;
      assert(Date.now() < end, what);
    }
  };
  const boxOf = (sel) => page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n || n.closest("[hidden]")) return null;
    const r = n.getBoundingClientRect();
    return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2, right: r.right, top: r.top } : null;
  }, sel);
  // What the mouse would hit at the x's spot, read with the x's own box even while it is hidden.
  const xState = (brickSel) => page.evaluate((s) => {
    const btn = document.querySelector(s);
    const x = btn?.closest(".abd-brick")?.querySelector(".abd-x");
    if (!x) return null;
    const r = x.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const b = btn.getBoundingClientRect();
    return { hit: !!at && x.contains(at), vis: getComputedStyle(x).visibility, w: r.width, onCorner: Math.abs(r.left + r.width / 2 - b.right) <= 10 && Math.abs(r.top + r.height / 2 - b.top) <= 10 };
  }, brickSel);
  const hoverAndHide = async (brickSel, label) => {
    const rest = await xState(brickSel);
    assert(rest, `${label}: no red x on the buddy`);
    assert(!rest.hit && rest.vis === "hidden", `${label}: the x takes clicks before the brick is hovered (${JSON.stringify(rest)})`);
    // A card that is still settling rebuilds its buddy under a still mouse; a person's hand keeps moving, so move again.
    let over = null;
    for (let i = 0; i < 4 && !(over?.vis === "visible" && over.hit); i++) {
      const b = await boxOf(brickSel);
      await page.mouse.move(b.x - 2, b.y);
      await page.mouse.move(b.x, b.y);
      await pause(300);
      over = await xState(brickSel);
    }
    if (!(over.vis === "visible" && over.hit)) {
      const why = await page.evaluate((s) => {
        const n = document.querySelector(s); const r = n.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const name = (e) => e ? `${e.tagName.toLowerCase()}.${String(e.className?.baseVal ?? e.className ?? "").split(" ")[0]}` : "none";
        return { brick: [Math.round(r.left), Math.round(r.top)], atCenter: name(at), hovered: [...document.querySelectorAll(":hover")].slice(-3).map(name) };
      }, brickSel);
      throw new Error(`${label}: hovering the brick did not show a clickable x (${JSON.stringify(over)} ${JSON.stringify(why)})`);
    }
    assert(over.onCorner, `${label}: the x is not on the brick's upper-right corner`);
    assert(over.w <= 16, `${label}: the x is not tiny (${over.w}px)`);
    const x = await page.evaluate((s) => { const r = document.querySelector(s).closest(".abd-brick").querySelector(".abd-x").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, brickSel);
    await page.mouse.move(x.x, x.y);
    await page.mouse.down();
    await page.mouse.up();
    await until(async () => !(await page.$(brickSel)), `${label}: the buddy is still there after its x was clicked`, 5000);
  };
  const toastUndo = async (label) => {
    // The toast slides in: read its Undo only once two reads 200 ms apart agree, so the click lands on it.
    let prev = "";
    const t = await until(async () => { const v = await readUndo(); const k = v ? `${Math.round(v.x)},${Math.round(v.y)}` : ""; const ok = v && k === prev; prev = k; await pause(200); return ok ? v : null; }, `${label}: no "is hidden" toast with Undo`, 6000);
    assert(t.top, `${label}: the toast's Undo is covered`);
    const boxes = await page.evaluate(auditBoxes, ".toast", MIN_GAP);
    assert(boxes.length === 0, `${label}: auditBoxes on the toast:\n${boxes.join("\n")}`);
    return t;
  };
  const readUndo = () => page.evaluate(() => {
      const toast = [...document.querySelectorAll(".toast")].find((n) => /is hidden/.test(n.textContent || ""));
      const btn = toast && [...toast.querySelectorAll("button")].find((b) => /Undo/.test(b.textContent || ""));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: !!at && btn.contains(at) };
    });

  const cdp = await page.target().createCDPSession();
  const lanes = [];
  const results = [];
  try {
    // Default spots and the default Fleet dock: a buddy dragged, or a dock shrunk and moved, earlier in this profile
    // (another demo) could sit anywhere.
    await page.evaluate((keys) => { for (const k of keys) localStorage.removeItem(k); }, [HIDDEN_KEY, "lucid.buddies.v1", "lucid.fleetDock.v1", "lucid.fleetLayout.v1"]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#input", { visible: true, timeout: 60_000 });
    for (const size of SIZES) {
      const label = size.name;
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      await pause(700);
      if (await boxOf("#fleetGrid")) { await page.click("#ctFleet"); await pause(500); }
      await until(() => boxOf(MAIN), `${label}: Main's buddy never showed`);
      // 1. Main
      await hoverAndHide(MAIN, `${label} Main`);
      const undo = await toastUndo(`${label} Main`);
      await page.mouse.click(undo.x, undo.y);
      await until(() => boxOf(MAIN), `${label}: Undo did not bring Main's buddy back`, 5000);
      await page.mouse.move(5, 5);
      await pause(300);
      await hoverAndHide(MAIN, `${label} Main again`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#input", { visible: true, timeout: 60_000 });
      await pause(4000);
      assert(!(await page.$(MAIN)), `${label}: Main's hidden buddy came back after a reload in the same session`);
      // Main back for part 2, so it can show that hiding a lane's buddy leaves Main's alone.
      await page.evaluate((k) => localStorage.removeItem(k), HIDDEN_KEY);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#input", { visible: true, timeout: 60_000 });
      await until(() => boxOf(MAIN), `${label}: Main's buddy did not return once its hide was cleared`);
      // 2. a Fleet lane's buddy
      const ws = (await api("/api/workspace"))?.current;
      assert(ws, "the QA engine reports no workspace");
      let sp = null;
      for (const end = Date.now() + 180_000; ;) {
        sp = await api("/api/fleet/spawn", { cwd: ws, name: `Hide QA ${label}` });
        if (sp?.ok !== false || !/has been at \d+%/.test(sp?.reason ?? "") || Date.now() > end) break;
        await pause(5000);
      }
      const laneId = sp?.lane?.id;
      assert(laneId, `${label}: the QA lane did not spawn (${JSON.stringify(sp).slice(0, 200)})`);
      lanes.push(laneId);
      if (!(await boxOf("#fleetGrid"))) await page.click("#ctFleet");
      const laneSel = `.abd[data-abd-surface="lane"][data-abd-lane="${laneId}"]`;
      await until(() => boxOf(laneSel), `${label}: the lane's buddy never showed on its card`, 60_000);
      await hoverAndHide(laneSel, `${label} lane`);
      await toastUndo(`${label} lane`);
      await pause(3000);
      assert(!(await page.$(laneSel)), `${label}: the lane's hidden buddy came back on its card`);
      assert(await page.$(MAIN), `${label}: hiding the lane's buddy also removed Main's`);
      results.push({ size: label, main: "hidden, undone, hidden across reload", lane: "hidden on its card" });
      await page.click("#ctFleet");
      await page.evaluate((k) => localStorage.removeItem(k), HIDDEN_KEY);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#input", { visible: true, timeout: 60_000 });
    }
  } finally {
    for (const id of lanes) { await api("/api/fleet/stop", { laneId: id }).catch(() => {}); await api("/api/fleet/remove", { laneId: id }).catch(() => {}); }
    await page.evaluate((k) => localStorage.removeItem(k), HIDDEN_KEY).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_buddy_hide_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const url = process.env.LUCID_DEMO_URL;
  if ((!endpoint && !browserURL) || !url) throw new Error("Set LUCID_DEMO_CDP_URL (or LUCID_DEMO_BROWSER_URL) and LUCID_DEMO_URL.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(endpoint ? { browserWSEndpoint: endpoint } : { browserURL }), defaultViewport: null, protocolTimeout: 120_000 });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url));
    if (!page) throw new Error(`No page at ${url}`);
    console.log(JSON.stringify(await verifyBuddyHide(page), null, 2));
    console.log("P-BUDDY.HIDE1 passed: hovering a floating Agent shows a tiny red x on its upper-right corner; a click hides it for that session (Main or the lane), Undo brings it back, wide and narrow.");
  } finally { await browser.disconnect(); }
}
