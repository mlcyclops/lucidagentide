// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_chip_x1.mjs
//
// P-PREVIEW.CHIPX1: real-UI proof of the red x on a Fleet lane's preview chip, driven with real mouse input against an
// isolated QA engine, in a wide (1600x1000) and a narrow (1100x800) window, in both places the chip floats:
//   1. the lane's card in the Fleet grid: at rest the x takes no clicks (the chip's corner stays the transcript's);
//      hovering the chip shows a tiny red x on its upper-right corner, topmost at its center and not clipped by the
//      transcript; a real click hides the chip and a toast offers Undo (topmost, auditBoxes clean); Undo brings the
//      ready chip back;
//   2. the lane's spoke in the Fleet Orbit: the same hover and x; a click hides the chip without taking the lane over
//      (the orbit stays open, the lane does not get the main composer); Undo brings it back;
//   3. (wide only) hidden again, the lane writing the SAME page once more keeps the chip away.
// The page comes from the scripted fake agent's penalty-shootout turn (desktop/scripts/fleet_demo), the one script
// that writes a previewable page, through the real lane sink -> previewLaneFile -> curtain path.
// Every lane started is stopped and removed; the dock layout and Fleet home are restored.
//
// Setup (never a user's session): bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811, then the QA page open in a
// browser with remote debugging, past the first-run gates.
// Run: LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_preview_chip_x1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const PROMPT = "Build a Lucid Agent World mini game: penalty shootout";
const DOCK_KEY = "lucid.fleetDock.v1";
const HOME_KEY = "lucid.fleetHome.v1";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

export async function verifyPreviewChipX(page) {
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content);
  const api = (path, body) => page.evaluate(async (p, b, t) => {
    const r = await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", "x-lucid-token": t }, ...(b ? { body: JSON.stringify(b) } : {}) });
    const j = await r.json();
    return j?.data ?? j;
  }, path, body ?? null, token);
  /** /api/fleet/prompt answers when the turn ends: send it from the page and do not wait on it. */
  const promptLane = (laneId) => page.evaluate((id, text, t) => {
    window.__chipXPrompt = fetch("/api/fleet/prompt", { method: "POST", headers: { "content-type": "application/json", "x-lucid-token": t }, body: JSON.stringify({ laneId: id, text }) })
      .then((r) => r.text()).catch((e) => `failed: ${String(e)}`);
  }, laneId, PROMPT, token);
  const until = async (read, what, ms = 20_000) => {
    for (const end = Date.now() + ms; ; await pause(150)) {
      const v = await read();
      if (v) return v;
      assert(Date.now() < end, what);
    }
  };
  /** The chip's state: shown (laid out, not inside anything hidden) and its phase. */
  const chipState = (chipSel) => page.evaluate((s) => {
    const c = document.querySelector(s);
    if (!c || c.closest("[hidden]")) return { shown: false };
    const r = c.getBoundingClientRect();
    return { shown: r.width > 0 && r.height > 0, phase: c.dataset.phase ?? "", x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, chipSel);
  /** What the mouse would hit at the x's spot, read from the x's own box even while it is hidden. */
  const xState = (chipSel, clipSel) => page.evaluate((s, cs) => {
    const chip = document.querySelector(s);
    const x = chip?.closest(".pchip-wrap")?.querySelector("[data-pchip-close]");
    if (!x) return null;
    const r = x.getBoundingClientRect(), b = chip.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const clip = cs ? document.querySelector(cs)?.getBoundingClientRect() : null;
    return {
      hit: !!at && x.contains(at), vis: getComputedStyle(x).visibility, w: r.width,
      onCorner: Math.abs(r.left + r.width / 2 - b.right) <= 10 && Math.abs(r.top + r.height / 2 - b.top) <= 10,
      inside: !clip || (r.top >= clip.top - 0.5 && r.right <= clip.right + 0.5),
      x: r.left + r.width / 2, y: r.top + r.height / 2,
    };
  }, chipSel, clipSel ?? null);
  const readUndo = () => page.evaluate(() => {
    const toast = [...document.querySelectorAll(".toast")].find((n) => /Preview chip hidden/.test(n.textContent || ""));
    const btn = toast && [...toast.querySelectorAll("button")].find((b) => /Undo/.test(b.textContent || ""));
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: !!at && btn.contains(at) };
  });
  const dismissToasts = async () => { for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {}); await pause(250); };
  const toastUndo = async (label) => {
    // The toast slides in: read its Undo only once two reads 200 ms apart agree, so the click lands on it.
    let prev = "";
    const t = await until(async () => { const v = await readUndo(); const k = v ? `${Math.round(v.x)},${Math.round(v.y)}` : ""; const ok = v && k === prev; prev = k; await pause(200); return ok ? v : null; }, `${label}: no "Preview chip hidden" toast with Undo`, 6000);
    assert(t.top, `${label}: the toast's Undo is covered`);
    const boxes = await page.evaluate(auditBoxes, ".toast", MIN_GAP);
    assert(boxes.length === 0, `${label}: auditBoxes on the toast:\n${boxes.join("\n")}`);
    return t;
  };
  /** At rest no clicks; hovered a tiny clickable x on the chip's corner; a real click hides the chip. */
  const hoverAndHide = async (chipSel, clipSel, label) => {
    await page.mouse.move(4, 4);
    await pause(300);
    const rest = await xState(chipSel, clipSel);
    assert(rest, `${label}: no x on the preview chip`);
    assert(!rest.hit && rest.vis === "hidden", `${label}: the x takes clicks before the chip is hovered (${JSON.stringify(rest)})`);
    let over = null;
    for (let i = 0; i < 4 && !(over?.vis === "visible" && over.hit); i++) {
      const c = await chipState(chipSel);
      assert(c.shown, `${label}: the chip is not showing`);
      await page.mouse.move(c.x - 2, c.y);
      await page.mouse.move(c.x, c.y);
      await pause(300);
      over = await xState(chipSel, clipSel);
    }
    if (!(over.vis === "visible" && over.hit)) {
      const why = await page.evaluate((x, y) => { const at = document.elementFromPoint(x, y); return at ? `${at.tagName.toLowerCase()}.${String(at.className?.baseVal ?? at.className ?? "").split(" ")[0]}` : "none"; }, over.x, over.y);
      throw new Error(`${label}: hovering the chip did not show a clickable x (${JSON.stringify(over)}; at its center: ${why})`);
    }
    assert(over.onCorner, `${label}: the x is not on the chip's upper-right corner`);
    assert(over.w <= 16, `${label}: the x is not tiny (${over.w}px)`);
    assert(over.inside, `${label}: the x pokes out of the view that holds the chip`);
    await page.mouse.move(over.x, over.y); // crossing from the chip to its x keeps it shown
    await pause(150);
    const still = await xState(chipSel, clipSel);
    assert(still.vis === "visible" && still.hit, `${label}: the x vanished when the pointer reached it`);
    if (process.env.LUCID_DEMO_SHOTS) { // optional evidence for the PR: the hovered chip and its x
      const c = await chipState(chipSel);
      await page.screenshot({ path: `${process.env.LUCID_DEMO_SHOTS}/chipx-${label.replace(/\W+/g, "-")}.png`, clip: { x: Math.max(0, c.x - 260), y: Math.max(0, c.y - 90), width: 420, height: 200 } });
    }
    await page.mouse.down();
    await page.mouse.up();
    await until(async () => !(await chipState(chipSel)).shown, `${label}: the chip is still there after its x was clicked`, 5000);
  };
  const shown = (sel) => page.evaluate((s) => { const v = document.querySelector(s); if (!v || v.closest("[hidden]")) return false; const r = v.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, sel);
  const orbitOpen = () => shown("#orbitView");
  // Switching between the grid and the orbit is setup, not the proof: the docked Fleet panel can sit over the
  // composer's Fleet button, so the button is pressed through the DOM. The chip and its x get real mouse input.
  const openGrid = async () => {
    if (await orbitOpen()) { await page.keyboard.press("Escape"); await until(async () => !(await orbitOpen()), "Esc did not close the orbit", 4000); }
    await page.evaluate((k) => localStorage.setItem(k, "grid"), HOME_KEY);
    if (!(await shown("#fleetGrid"))) await page.$eval("#ctFleet", (b) => b.click());
    await until(() => shown("#fleetGrid"), "the Fleet button did not open the grid", 5000);
    await pause(400);
  };
  const openOrbit = async () => {
    if (await shown("#fleetGrid")) { await page.$eval("#ctFleet", (b) => b.click()); await until(async () => !(await shown("#fleetGrid")), "the Fleet button did not close the grid", 4000); }
    await page.evaluate((k) => localStorage.setItem(k, "orbit"), HOME_KEY);
    await page.$eval("#ctFleet", (b) => b.click());
    await until(() => shown("#orbitView .orbit-node"), "the Fleet button did not open the orbit", 6000);
    await pause(900); // the spokes' entrance
  };

  const cdp = await page.target().createCDPSession();
  const saved = await page.evaluate((d, h) => ({ dock: localStorage.getItem(d), home: localStorage.getItem(h) }), DOCK_KEY, HOME_KEY);
  const lanes = [];
  const results = [];
  try {
    await page.evaluate((d) => localStorage.removeItem(d), DOCK_KEY);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#input", { visible: true, timeout: 60_000 });
    // A QA engine with no model provider asks for one on every load; that is not what this proof is about.
    for (let i = 0; i < 12; i++) {
      await pause(500);
      const later = await page.$$eval(".modal-ov button", (bs) => { const b = bs.find((x) => /^I.ll do it later/.test((x.textContent || "").trim())); if (b) b.click(); return !!b; }).catch(() => false);
      if (later) break;
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: SIZES[0].width, height: SIZES[0].height, deviceScaleFactor: 0, mobile: false });
    await pause(500);

    // A lane of our own, and its page through the real flow.
    const ws = (await api("/api/workspace"))?.current;
    assert(ws, "the QA engine reports no workspace");
    let sp = null;
    for (const end = Date.now() + 180_000; ;) {
      sp = await api("/api/fleet/spawn", { cwd: ws, name: "Chip X QA" });
      if (sp?.ok !== false || !/has been at \d+%/.test(sp?.reason ?? "") || Date.now() > end) break;
      await pause(5000);
    }
    const laneId = sp?.lane?.id;
    assert(laneId, `the QA lane did not spawn (${JSON.stringify(sp).slice(0, 200)})`);
    lanes.push(laneId);
    await openGrid();
    const cardSel = `#fleetGrid .fleet-card[data-lane="${laneId}"]`;
    const cardChip = `${cardSel} [data-lane-preview]`;
    const spokeChip = `#orbitView .orbit-node[data-lane-id="${laneId}"] [data-orbit-preview]`;
    await page.waitForSelector(cardSel, { timeout: 60_000 });
    let lastStatus = "";
    const idle = async () => {
      const l = ((await api("/api/fleet/status"))?.lanes ?? []).find((x) => x.id === laneId);
      lastStatus = l?.status ?? "gone";
      // The scripted turn ends on an approval (its publish step); deny it so the turn finishes.
      if (l?.status === "needs-approval") await api("/api/fleet/answer", { laneId, allow: false });
      return !!l && !["working", "needs-approval", "starting"].includes(l.status);
    };
    await until(idle, "the QA lane never went idle", 120_000);
    await promptLane(laneId);
    await until(async () => (await chipState(cardChip)).phase === "ready", "the lane never showed a ready preview chip on its card", 150_000);

    for (const size of SIZES) {
      const label = size.name;
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      await pause(700);
      await dismissToasts();
      // 1. the Fleet grid card
      await openGrid();
      await page.$eval(cardSel, (c) => c.scrollIntoView({ block: "nearest" }));
      await until(async () => (await chipState(cardChip)).shown, `${label}: the card's chip is not showing`, 5000);
      await hoverAndHide(cardChip, `${cardSel} .fleet-out-wrap`, `${label} card`);
      let undo = await toastUndo(`${label} card`);
      await page.mouse.click(undo.x, undo.y);
      await until(async () => (await chipState(cardChip)).phase === "ready", `${label}: Undo did not bring the card's ready chip back`, 5000);
      await dismissToasts();
      // 2. the Fleet Orbit spoke
      await openOrbit();
      await until(async () => (await chipState(spokeChip)).shown, `${label}: the spoke's chip is not showing`, 6000);
      await hoverAndHide(spokeChip, null, `${label} spoke`);
      assert(await orbitOpen(), `${label}: the spoke's x closed the orbit (a takeover click)`);
      const promoted = ((await api("/api/fleet/status"))?.lanes ?? []).find((x) => x.id === laneId)?.promoted;
      assert(!promoted, `${label}: the spoke's x gave the lane the main composer`);
      undo = await toastUndo(`${label} spoke`);
      await page.mouse.click(undo.x, undo.y);
      await until(async () => (await chipState(spokeChip)).phase === "ready", `${label}: Undo did not bring the spoke's chip back`, 5000);
      await dismissToasts();
      results.push({ size: label, card: "x on hover, hid, Undo restored", spoke: "x on hover, hid without a takeover, Undo restored" });
    }

    // 3. the same page again keeps a hidden chip away
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: SIZES[0].width, height: SIZES[0].height, deviceScaleFactor: 0, mobile: false });
    await pause(500);
    await openGrid();
    await hoverAndHide(cardChip, `${cardSel} .fleet-out-wrap`, "wide card (before the same page again)");
    await dismissToasts();
    await until(idle, `the QA lane did not go idle before its second turn (status ${lastStatus})`, 120_000);
    await promptLane(laneId);
    await until(async () => !(await idle()), "the second turn never started", 20_000).catch(() => {});
    await until(idle, `the second turn never finished (status ${lastStatus})`, 150_000);
    await pause(4000); // the curtain's probe and verdict
    assert(!(await chipState(cardChip)).shown, "the hidden chip came back when the lane wrote the same page again");
    results.push({ samePageAgain: "chip stayed hidden" });
  } finally {
    for (const id of lanes) { await api("/api/fleet/stop", { laneId: id }).catch(() => {}); await api("/api/fleet/remove", { laneId: id }).catch(() => {}); }
    if (await shown("#fleetGrid").catch(() => false)) await page.$eval("#ctFleet", (b) => b.click()).catch(() => {});
    if (await orbitOpen().catch(() => false)) await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate((d, h, s) => {
      if (s.dock === null) localStorage.removeItem(d); else localStorage.setItem(d, s.dock);
      if (s.home === null) localStorage.removeItem(h); else localStorage.setItem(h, s.home);
    }, DOCK_KEY, HOME_KEY, saved).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_preview_chip_x1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const url = process.env.LUCID_DEMO_URL;
  if ((!endpoint && !browserURL) || !url) throw new Error("Set LUCID_DEMO_CDP_URL (or LUCID_DEMO_BROWSER_URL) and LUCID_DEMO_URL.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(endpoint ? { browserWSEndpoint: endpoint } : { browserURL }), defaultViewport: null, protocolTimeout: 120_000 });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url));
    if (!page) throw new Error(`No page at ${url}`);
    console.log(JSON.stringify(await verifyPreviewChipX(page), null, 2));
    console.log("P-PREVIEW.CHIPX1 passed: hovering a lane's preview chip shows a tiny red x on its corner, on the Fleet card and the Orbit spoke; a click hides it (no takeover), Undo brings it back, the same page again keeps it hidden, wide and narrow.");
  } finally { await browser.disconnect(); }
}
