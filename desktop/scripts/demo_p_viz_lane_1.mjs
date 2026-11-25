// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_viz_lane_1.mjs
//
// P-VIZ.LANE1 (ADR-0683): the Agent Worlds node panel is a Fleet lane card body (lane_view.ts), with the lane's
// composer, its staged strip and a user size. Against an isolated QA engine (scripted fake agent) it:
//   1. spawns a lane, opens Visualize with the real control, turns the auto camera off and clicks the lane's node, so
//      its panel opens; the panel carries the lane renderer's transcript pane ([data-fleet-out]); the old hand-rolled
//      output box did not, and this is where the old bundle fails;
//   2. sends a prompt from the panel (Enter in its box) and asserts the live thinking block ([data-lane-live]
//      .fleet-think) streams text and a tool chip (.fleet-tchip) appears while the turn runs; the chip is topmost at
//      its center and its chevron opens its body; auditBoxes is clean on the panel;
//   3. pastes an image (a real ClipboardEvent on the box) and asserts a mini image chip with an x appears; the x is
//      topmost and removes it; a second paste plus a typed prompt, sent while the lane is busy (the send button reads
//      Stage), lands in the staged strip as a chip with "1 img" and in the engine's queue (fleet/status); auditBoxes
//      is clean with the strip shown; the strip's x is topmost and empties the engine's queue; the turn is cancelled;
//   4. drags the resize grip: the panel grows in both directions, its transcript gets taller, the size is saved in
//      localStorage lucid.viz.panelSize.v1 and comes back after the panel is closed and opened again; ArrowLeft on the
//      grip narrows it by one step; Home resets it to the natural size and forgets the saved one;
//   5. no page error; the lane's turn is cancelled and the lane removed at the end.
//
// Run (QA engine: bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7821, and a Chrome with a CDP port):
//   LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7821/ node desktop/scripts/demo_p_viz_lane_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const PANEL = "#vizView [data-viz-panel]";
const SIZE_KEY = "lucid.viz.panelSize.v1";
// A 1x1 PNG: what a snipping tool puts on the clipboard, in miniature.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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

export async function verifyVizLane(page, base) {
  const api = await engineApi(base);
  const errors = [];
  const onError = (e) => errors.push(String(e?.message ?? e));
  page.on("pageerror", onError);
  const results = {};
  const until = async (fn, ok, ms, msg) => {
    const end = Date.now() + ms;
    let v;
    for (;;) {
      v = await fn();
      if (ok(v)) return v;
      if (Date.now() > end) throw new Error(`${msg} (last: ${JSON.stringify(v)?.slice(0, 300)})`);
      await pause(200);
    }
  };
  const box = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top }; });
  const topmost = async (sel, what) => {
    const hit = await page.$eval(sel, (e) => {
      const r = e.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { ok: !!at && (at === e || e.contains(at)), at: at ? `${at.tagName.toLowerCase()}.${String(at.className).split(" ")[0]}` : "nothing", w: r.width };
    });
    assert(hit.w > 0, `${what} is not laid out`);
    assert(hit.ok, `${what} is covered at its center by ${hit.at}`);
  };
  const audit = async (where) => {
    // At the newest line, as the pane follows a stream: the catch-up pair is away (it floats over the transcript only
    // while the reader is scrolled up, by design) and its fade has finished.
    await page.$eval(`${PANEL} [data-fleet-out]`, (o) => { o.scrollTop = o.scrollHeight; });
    await pause(450);
    const bad = await page.evaluate(auditBoxes, PANEL, MIN_GAP);
    assert(bad.length === 0, `${where}: auditBoxes on the panel: ${bad.join(" | ")}`);
  };
  const laneView = async (id) => ((await api("/api/fleet/status")).data?.lanes ?? []).find((l) => l.id === id);
  let laneId = null;
  try {
    // 1. a lane, Visualize, its node, its panel
    const ws = (await api("/api/workspace")).data?.current;
    const name = "viz-lane-one";
    const sp = await api("/api/fleet/spawn", { name, ...(ws ? { cwd: ws } : {}) });
    laneId = sp.data?.lane?.id ?? sp.data?.id;
    assert(laneId, `spawn failed: HTTP ${sp.status} ${JSON.stringify(sp.data).slice(0, 200)}`);
    await until(() => laneView(laneId), (l) => l?.status === "awaiting-input" || l?.status === "done", 60_000, "the lane did not become idle");
    await page.goto(new URL("?vizScript=1", base).href, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ctViz", { timeout: 30_000 });
    // A fresh QA profile shows first-run gates; clear them with their own skip controls.
    for (let i = 0, idle = 0; i < 40 && idle < 8; i++) { // gates can appear late on a cold engine
      const skip = await page.$("#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]");
      if (!skip) { idle++; await pause(500); continue; }
      idle = 0;
      await skip.click().catch(() => {});
      await pause(400);
    }
    for (const t of await page.$$("#toasts .toast .h button")) await t.click().catch(() => {});
    const viz = await box("#ctViz");
    await page.mouse.click(viz.x, viz.y);
    await page.waitForSelector("#vizView [data-viz-ledger]", { visible: true, timeout: 15_000 });
    await page.evaluate(() => { const c = document.querySelector("#vizView [data-viz-auto]"); if (c?.checked) c.click(); });
    await page.evaluate((k) => localStorage.removeItem(k), SIZE_KEY);
    const nodeBox = () => page.evaluate((id) => window.__vizProbe?.nodes?.().find((n) => n.id === id)?.box ?? null, laneId);
    const openPanel = async () => {
      for (let i = 0; i < 20; i++) {
        // onboarding can still raise a gate (the work email step) after Visualize opened: skip it, then click
        const gate = await page.$("#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]");
        if (gate) { await gate.click().catch(() => {}); await pause(400); continue; }
        const b = await nodeBox();
        if (b) {
          await page.mouse.click(b.x, b.y);
          const shown = await page.waitForFunction((sel, n) => { const p = document.querySelector(sel); return !!p && !p.hidden && p.querySelector("[data-viz-panel-name]")?.textContent === n; }, { timeout: 1500 }, PANEL, name).catch(() => null);
          if (shown) return;
        }
        await pause(500);
      }
      throw new Error(`the panel of ${name} did not open from a click on its node`);
    };
    await openPanel();
    assert(await page.$(`${PANEL} [data-fleet-out] [data-lane-live]`), "the node panel has no lane transcript pane ([data-fleet-out] with [data-lane-live]): it is not the Fleet lane renderer");
    await topmost(`${PANEL} [data-viz-panel-input]`, "the panel's prompt box");
    await topmost(`${PANEL} [data-viz-panel-send]`, "the panel's send button");
    await topmost(`${PANEL} [data-viz-panel-img]`, "the panel's Add images button");

    // 2. a prompt from the panel: live thinking and tool chips stream in
    await page.click(`${PANEL} [data-viz-panel-input]`);
    await page.keyboard.type("[script release-notes] Write the release notes and changelog");
    await page.keyboard.press("Enter");
    const think = await until(() => page.$eval(`${PANEL} [data-lane-live] [data-lane-think]`, (t) => ({ shown: !t.hidden && !t.closest("[hidden]"), text: t.textContent.trim() })).catch(() => null),
      (v) => !!v?.shown && v.text.length > 20, 30_000, "no live thinking streamed into the panel");
    results.thinking = think.text.slice(0, 80);
    await page.waitForSelector(`${PANEL} [data-fleet-out] .fleet-tchip`, { visible: true, timeout: 45_000 });
    results.toolChip = await page.$eval(`${PANEL} [data-fleet-out] .fleet-tchip`, (c) => c.textContent.replace(/\s+/g, " ").trim());
    await page.$eval(`${PANEL} [data-fleet-out] .fleet-tchip`, (c) => c.scrollIntoView({ block: "nearest" }));
    await topmost(`${PANEL} [data-fleet-out] .fleet-tchip`, "the first tool chip");
    const chev = await page.$(`${PANEL} [data-fleet-out] .fleet-tchip[aria-expanded]`);
    if (chev) {
      const b = await chev.evaluate((c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.mouse.click(b.x, b.y);
      assert(await chev.evaluate((c) => c.getAttribute("aria-expanded") === "true" && !!c.closest(".fleet-chip-row")?.querySelector(".fleet-tinline.open")), "the tool chip's chevron did not open its body");
      await page.mouse.click(b.x, b.y);
    }
    await audit("streaming");

    // 3. a pasted image chip with a working x, then a staged prompt with an image while the lane is busy
    const paste = () => page.$eval(`${PANEL} [data-viz-panel-input]`, (ta, b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "shot.png", { type: "image/png" }));
      ta.focus();
      ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, PNG_B64);
    await paste();
    await page.waitForSelector(`${PANEL} [data-viz-panel-attach] .fleet-attach-item img.fleet-thumb`, { visible: true, timeout: 5000 });
    assert((await page.$$(`${PANEL} [data-viz-panel-attach] .fleet-attach-item`)).length === 1, "one paste did not make exactly one image chip");
    await topmost(`${PANEL} [data-viz-panel-attach] .fleet-attach-x`, "the image chip's x");
    const x = await box(`${PANEL} [data-viz-panel-attach] .fleet-attach-x`);
    await page.mouse.click(x.x, x.y);
    await until(() => page.$$eval(`${PANEL} [data-viz-panel-attach] .fleet-attach-item`, (n) => n.length), (n) => n === 0, 3000, "the image chip's x did not remove it");
    await paste();
    await page.waitForSelector(`${PANEL} [data-viz-panel-attach] .fleet-attach-item`, { visible: true, timeout: 5000 });
    await until(() => page.$eval(`${PANEL} [data-viz-panel-send]`, (b) => b.getAttribute("aria-label")), (l) => l === "Stage", 15_000, "the send button did not turn into Stage while the lane works");
    await page.click(`${PANEL} [data-viz-panel-input]`);
    await page.keyboard.type("Stage me: add a short summary at the top");
    await page.keyboard.press("Enter");
    const chip = await until(() => page.$$eval(`${PANEL} [data-viz-panel-queue] .fleet-q-chip`, (cs) => cs.map((c) => ({ txt: c.querySelector(".fleet-q-txt")?.textContent ?? "", img: c.querySelector(".fleet-q-img")?.textContent ?? "" }))),
      (cs) => cs.some((c) => c.txt.startsWith("Stage me") && c.img === "1 img"), 15_000, "the staged prompt with its image is not in the panel's strip");
    results.staged = chip;
    assert((await page.$$(`${PANEL} [data-viz-panel-attach] .fleet-attach-item`)).length === 0, "the staged image stayed on the composer");
    const engineQ = await until(() => laneView(laneId), (l) => (l?.queued ?? []).some((q) => q.text.startsWith("Stage me") && q.images === 1), 8000, "the engine's queue does not hold the staged prompt");
    results.engineQueue = engineQ.queued.length;
    await audit("staged strip shown");
    await topmost(`${PANEL} [data-viz-panel-queue] [data-q-x="0"]`, "the staged chip's x");
    const qx = await box(`${PANEL} [data-viz-panel-queue] [data-q-x="0"]`);
    await page.mouse.click(qx.x, qx.y);
    await until(() => laneView(laneId), (l) => (l?.queued ?? []).length === 0, 8000, "the staged chip's x did not empty the engine's queue");
    // The script's approval ask would put a badge over the node the reopen below clicks: the turn ends here.
    await api("/api/fleet/cancel", { laneId });
    await until(() => laneView(laneId), (l) => l?.status !== "working" && l?.status !== "needs-approval", 30_000, "the lane's turn did not end on cancel");

    // 4. resize by the grip, persisted across a reopen, keyboard step, Home resets
    const before = await page.$eval(PANEL, (p) => ({ w: p.offsetWidth, h: p.offsetHeight, out: p.querySelector("[data-fleet-out]").clientHeight, side: p.dataset.side }));
    const g = await box(`${PANEL} .viz-panel-grip`);
    await topmost(`${PANEL} .viz-panel-grip`, "the resize grip");
    const dx = before.side === "left" ? -140 : 140;
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(g.x + (dx * i) / 10, g.y + (90 * i) / 10);
    await page.mouse.up();
    await pause(200);
    const after = await page.$eval(PANEL, (p) => ({ w: p.offsetWidth, h: p.offsetHeight, out: p.querySelector("[data-fleet-out]").clientHeight }));
    assert(after.w >= before.w + 100, `the drag did not widen the panel (${before.w} -> ${after.w})`);
    assert(after.h >= before.h + 100, `the drag did not make the panel taller (${before.h} -> ${after.h})`);
    assert(after.out > before.out + 60, `the transcript did not grow with the panel (${before.out} -> ${after.out} px)`);
    const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), SIZE_KEY);
    assert(saved && Math.abs(saved.w - after.w) <= 1 && Math.abs(saved.h - after.h) <= 1, `the size was not saved: ${JSON.stringify(saved)} vs ${JSON.stringify(after)}`);
    await page.click(`${PANEL} [data-viz-panel-close]`);
    await page.waitForFunction((sel) => document.querySelector(sel)?.hidden === true, { timeout: 3000 }, PANEL);
    await openPanel();
    await pause(200);
    const reopened = await page.$eval(PANEL, (p) => ({ w: p.offsetWidth, h: p.offsetHeight }));
    assert(Math.abs(reopened.w - after.w) <= 1 && Math.abs(reopened.h - after.h) <= 1, `the size did not come back on reopen: ${JSON.stringify(reopened)} vs ${JSON.stringify(after)}`);
    await page.focus(`${PANEL} .viz-panel-grip`);
    await page.keyboard.press("ArrowLeft");
    await pause(100);
    const stepped = await page.$eval(PANEL, (p) => p.offsetWidth);
    assert(stepped === reopened.w - 24, `ArrowLeft on the grip did not narrow the panel by one step (${reopened.w} -> ${stepped})`);
    await page.keyboard.press("Home");
    await pause(150);
    const reset = await page.$eval(PANEL, (p) => ({ sized: p.classList.contains("sized"), inline: p.style.width + p.style.height }));
    assert(!reset.sized && reset.inline === "", `Home did not reset the panel to its natural size: ${JSON.stringify(reset)}`);
    assert((await page.evaluate((k) => localStorage.getItem(k), SIZE_KEY)) === null, "Home did not forget the saved size");
    results.size = { before: { w: before.w, h: before.h, out: before.out }, dragged: after, reopened, arrowLeft: stepped };

    assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
    return results;
  } finally {
    page.off("pageerror", onError);
    if (laneId) {
      await api("/api/fleet/cancel", { laneId }).catch(() => {});
      await api("/api/fleet/remove", { laneId, force: true }).catch(() => {});
    }
  }
}

async function main() {
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const wsEndpoint = process.env.LUCID_DEMO_CDP_URL;
  const base = process.env.LUCID_DEMO_URL;
  if ((!browserURL && !wsEndpoint) || !base) {
    console.log("demo_p_viz_lane_1: set LUCID_DEMO_BROWSER_URL (or LUCID_DEMO_CDP_URL) and LUCID_DEMO_URL to an isolated QA engine.");
    return;
  }
  assert(new URL(base).hostname === "127.0.0.1", "LUCID_DEMO_URL must be an isolated QA engine on 127.0.0.1");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(wsEndpoint ? { browserWSEndpoint: wsEndpoint } : { browserURL }), defaultViewport: null });
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.setViewport({ width: 1400, height: 900 });
    const r = await verifyVizLane(page, base);
    console.log(JSON.stringify(r, null, 2));
    console.log("P-VIZ.LANE1 passed: the Agent Worlds panel streams thinking and tool chips like a Fleet lane, takes pasted images, stages prompts on the engine's queue and keeps its user size.");
  } finally {
    browser.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("demo_p_viz_lane_1.mjs")) {
  main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
}
