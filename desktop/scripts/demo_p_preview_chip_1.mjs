// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_chip_1.mjs
//
// P-PREVIEW.CHIP1: real-browser proof of the ONE preview chip (preview_chip.ts, .pchip) in the composer, in a fleet
// lane and in Agent Worlds, driven through the real flow with real input. The QA engine runs the scripted fake agent
// (desktop/scripts/fleet_demo): its penalty-shootout script writes games/penalty-shootout/index.html, the one
// auto-surface page among the scripts, so prompting Main through the composer and a lane through /api/fleet/prompt
// sends each write through the real path (Main: the engine's preview-available; a lane: fleet_grid's lane sink ->
// previewLaneFile) into the loading curtain and its chips. In a wide (1600x1000) and a narrow (1100x800) window:
//   A. before any preview opens (opening one accepts every waiting invitation, which retires the composer chip):
//      the composer chip sits at the chat column's top-right and is topmost; the lane's chip is INSIDE the lane's
//      transcript view (not the card header), in its upper-right corner, topmost, clear of the lane's input and send
//      button and of everything below the transcript, on a wide card and on a narrow one (where it shows the miniature
//      page alone); auditBoxes passes on the lane card (with the transcript's own content set aside, which the chip
//      floats over by design) and on the transcript; the composer and lane chips share their computed look;
//   B. the composer chip's click opens the Preview on its head invitation's tab (Main's Agent tab or the lane's);
//   C. the lane chip's click opens the Preview on the lane's tab above the Fleet dock (elementFromPoint at its center
//      hits it, the dock stays open). In Visualize: the lane's chip and Main's stand over their nodes, topmost, with
//      the composer chip's look; hovering shows the card (title, path, Open preview, the agent's snapshots when it has
//      any) and auditBoxes passes on it; a click (or a snapshot) flies the Preview out OVER Visualize (#preview.over-viz;
//      elementFromPoint at the panel's center and its header hit it; Visualize stays open and stops being modal) on
//      the lane's tab; its resize edge works there and saves lucid.preview-w; X slides it back with Visualize open and
//      focus on the chip; Esc with focus in the panel does the same and a second Esc closes Visualize; a press back on
//      the world slides it away without picking a node;
//   D. Main's chip in Visualize opens the composer's Agent tab over Visualize.
// No uncaught page errors. The dock layout, the Fleet home view and the window size are restored; Visualize's auto camera
// is turned off for the run (a still camera) and its saved setting put back.
//
// Setup (an isolated QA engine and browser, never a user's session):
//   bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811
//   bun desktop/scripts/fleet_demo/seed_fleet.mjs http://127.0.0.1:7811/ --lanes 2 --no-main
//   open http://127.0.0.1:7811/?vizScript=1 in the QA browser (remote debugging on), past the first-run gates.
//   ?vizScript=1 turns on Visualize's read-only probe (window.__vizProbe: node and chip boxes) over real agents.
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:7811/?vizScript=1 node desktop/scripts/demo_p_preview_chip_1.mjs
// Optional: LUCID_DEMO_LANE=<lane id> picks the agent (default: the first idle one).

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const PROMPT = "Build a Lucid Agent World mini game: penalty shootout";
const DOCK_KEY = "lucid.fleetDock.v1";
const HOME_KEY = "lucid.fleetHome.v1";
const AUTO_CAM_KEY = "lucid.viz.autoCamera";
/** What "the same chip" means, property by property: everything but the size steps (padding, art size, fonts). */
const SHARED = {
  chip: ["background-color", "border-top-color", "border-top-style", "border-top-width", "border-top-left-radius", "box-shadow", "backdrop-filter", "color", "font-family", "cursor", "transition-property", "animation-name"],
  art: ["background-color", "border-top-color", "border-top-style", "overflow"],
  k: ["color", "font-weight", "white-space", "text-overflow"],
  name: ["color", "font-weight", "white-space", "text-overflow"],
};

export async function verifyPreviewChip(page, opts = {}) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  const onError = (e) => errors.push(String(e?.message ?? e));
  page.on("pageerror", onError);
  /** Poll `read` until `ok(value)`, or fail with the last value seen. */
  const until = async (read, ok, ms, what) => {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      last = await read();
      if (ok(last)) return last;
      if (Date.now() > end) throw new Error(`${what} (last: ${JSON.stringify(last)})`);
      await pause(120);
    }
  };
  /** The element's box when it is laid out and not inside anything hidden, else null. */
  const box = (sel) => page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n || n.closest("[hidden]")) return null;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, sel);
  const hits = (sel, x, y) => page.evaluate((s, px, py) => { const n = document.querySelector(s); const at = document.elementFromPoint(px, py); return !!n && !!at && n.contains(at); }, sel, x, y);
  const owner = (x, y) => page.evaluate((px, py) => {
    const at = document.elementFromPoint(px, py);
    if (!at) return "nothing";
    const o = at.closest("[id]");
    return `${at.tagName.toLowerCase()}${typeof at.className === "string" && at.className ? `.${at.className.split(" ")[0]}` : ""}${o ? ` in #${o.id}` : ""}`;
  }, x, y);
  const dismissToasts = async () => { for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {}); await pause(200); };
  const clickReal = async (sel, what) => {
    await dismissToasts();
    const b = await box(sel);
    assert(b, `${what} is not visible`);
    assert(await hits(sel, b.x, b.y), `${what} is covered: ${await owner(b.x, b.y)} is at its center`);
    await page.mouse.click(b.x, b.y);
    return b;
  };
  const audit = async (sel, where) => {
    const found = await page.evaluate(auditBoxes, sel, MIN_GAP);
    assert(found.length === 0, `${where} spacing: ${found.join("; ")}`);
  };
  const overlaps = (a, b) => !!a && !!b && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
  const styleOf = (sel) => page.$eval(sel, (b, keys) => {
    const pick = (el, props) => { const s = getComputedStyle(el); return Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)])); };
    return { chip: pick(b, keys.chip), art: pick(b.querySelector(".pchip-art"), keys.art), k: pick(b.querySelector(".pchip-k"), keys.k), name: pick(b.querySelector(".pchip-name"), keys.name) };
  }, SHARED);
  // Same style = same keywords and colors, and every length within sub-pixel snapping: the Fleet dock's cards sit under
  // a CSS zoom, where Chromium snaps a 1px border to whole device pixels (0.86 to 0.93px computed). That is the
  // container's scale, not a different chip.
  const PX = /(-?\d*\.?\d+)px/g; // only lengths get the tolerance; colors, weights and other numbers must match exactly
  const near = (x, y) => {
    if (x === y) return true;
    if (x.replace(PX, "#px") !== y.replace(PX, "#px")) return false;
    const nx = [...x.matchAll(PX)].map((m) => Number(m[1])), ny = [...y.matchAll(PX)].map((m) => Number(m[1]));
    return nx.every((v, i) => Math.abs(v - ny[i]) <= Math.max(0.2, Math.abs(ny[i]) * 0.16));
  };
  const sameStyle = (a, b, what) => {
    for (const part of Object.keys(SHARED)) for (const p of SHARED[part]) assert(near(a[part][p], b[part][p]), `${what}: ${part} ${p} differs ("${a[part][p]}" vs "${b[part][p]}")`);
  };
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content).catch(() => "");
  const api = (path, body) => page.evaluate(async (p, b, t) => {
    const r = await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", ...(t ? { "x-lucid-token": t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) });
    return r.json();
  }, path, body ?? null, token);
  const previewShown = () => page.evaluate(() => { const p = document.getElementById("preview"); return !!p && !p.hidden && !p.classList.contains("pchip-leave") && p.getBoundingClientRect().width > 0; });
  const previewGone = () => page.evaluate(() => document.getElementById("preview")?.hidden === true);
  const vizShown = () => page.evaluate(() => { const v = document.getElementById("vizView"); return !!v && !v.hidden && v.classList.contains("open"); });
  const activeTab = () => page.evaluate(() => document.querySelector("#prevTabs .prev-tab.active")?.dataset.lane ?? null);
  const focusedChip = () => page.evaluate(() => document.activeElement?.dataset?.vizPreviewChip ?? null);
  const phaseOf = (sel) => page.evaluate((s) => { const c = document.querySelector(s); return c && !c.closest("[hidden]") ? c.dataset.phase ?? "" : null; }, sel);
  const q = (id) => String(id).replace(/["\\]/g, "\\$&");

  const cdp = await page.target().createCDPSession();
  const saved = await page.evaluate((d, h, a) => ({ dock: localStorage.getItem(d), home: localStorage.getItem(h), auto: localStorage.getItem(a) }), DOCK_KEY, HOME_KEY, AUTO_CAM_KEY);
  const results = { sizes: [] };
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: SIZES[0].width, height: SIZES[0].height, deviceScaleFactor: 0, mobile: false });
    await pause(500);
    if (await previewShown()) { await page.click("#prevClose"); await until(previewGone, Boolean, 3000, "the Preview panel did not close before the run"); }
    for (let i = 0; i < 3 && (await vizShown()); i++) { await page.keyboard.press("Escape"); await pause(350); }
    await page.evaluate((h) => localStorage.setItem(h, "grid"), HOME_KEY);

    /** Float the Fleet grid over the left part of the window at `shape` (closing and reopening it). */
    const floatDock = async (shape) => {
      if (await page.$("#fleetDock")) {
        await page.click("#ctFleet");
        await until(async () => !(await page.$("#fleetDock")), Boolean, 3000, "the Fleet button did not close the dock");
      }
      await page.evaluate((k, s) => localStorage.setItem(k, JSON.stringify({ shape: s, minimized: false, side: "float", collapsed: {} })), DOCK_KEY, shape);
      await page.click("#ctFleet");
      await page.waitForSelector("#fleetDock", { visible: true, timeout: 5000 });
      await pause(400);
    };

    // ── the real flow: Main through its composer, then a lane through the engine ────────────────────────────
    const composerChip = "#prevCurtainChip";
    if ((await phaseOf(composerChip)) !== "ready") {
      await page.$eval("#input", (t) => { t.value = ""; t.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.focus("#input");
      await page.keyboard.type(PROMPT);
      await clickReal("#send", "the composer's Send button");
    }
    // Main's scripted turn does not always reach its write in the QA fake (2026-11-23 run: it stopped after its first
    // reply), so Main's page is not required here: the composer chip must turn ready from whichever invitation
    // lands first (Main's or the lane's), checked after the lane below.
    const mainPhases = new Set();

    const idle = (l) => l.status === "awaiting-input" || l.status === "done";
    const lane = await until(async () => {
      const lanes = (await api("/api/fleet/status"))?.data?.lanes ?? [];
      return opts.lane ? lanes.find((l) => l.id === opts.lane) ?? null : lanes.find(idle) ?? null;
    }, (l) => !!l && idle(l), 240_000, opts.lane ? `agent ${opts.lane} is not in the fleet or never went idle` : "no idle agent in the fleet: seed one with seed_fleet.mjs --lanes 2 --no-main");
    const vw0 = SIZES[0].width, vh0 = SIZES[0].height;
    await floatDock({ x: Math.round(vw0 * 0.04), y: 64, w: Math.round(vw0 * 0.5), h: Math.round(vh0 * 0.66) });
    const cardSel = `#fleetDock .fleet-card[data-lane="${q(lane.id)}"]`;
    const laneChip = `${cardSel} [data-lane-preview]`;
    await page.waitForSelector(cardSel, { timeout: 8000 });
    await page.evaluate((laneId, text, t) => {
      window.__previewChipDemo = fetch("/api/fleet/prompt", { method: "POST", headers: { "content-type": "application/json", ...(t ? { "x-lucid-token": t } : {}) }, body: JSON.stringify({ laneId, text }) })
        .then((r) => r.text()).catch((e) => `failed: ${String(e)}`);
    }, lane.id, PROMPT, token);
    const lanePhases = new Set();
    await until(async () => { const p = await phaseOf(laneChip); if (p) lanePhases.add(p); return p; }, (p) => p === "ready", 150_000, `the lane ${lane.name} never showed a ready chip in its card`);
    results.lane = { name: lane.name, id: lane.id, phasesSeen: [...lanePhases] };
    await until(async () => { const p = await phaseOf(composerChip); if (p) mainPhases.add(p); return p; }, (p) => p === "ready", 30_000, "the composer chip never turned ready for a ready page (Main's or the lane's)");
    results.composer = { phasesSeen: [...mainPhases] };

    // ── A. placement and look, before any preview opens ──────────────────────────────────────────────────
    let composerStyle = null, laneStyle = null;
    const laneChecks = async (label) => {
      await page.$eval(cardSel, (c) => c.scrollIntoView({ block: "nearest" }));
      await pause(200);
      const chip = await box(laneChip);
      assert(chip, `${label}: the lane chip is not visible`);
      const placed = await page.$eval(laneChip, (c) => ({
        inHead: !!c.closest(".fleet-card-head"), inWrap: !!c.closest(".fleet-out-wrap"),
        text: getComputedStyle(c.querySelector(".pchip-txt")).display !== "none", host: c.closest(".pchip-host").getBoundingClientRect().width,
      }));
      assert(!placed.inHead, `${label}: the lane chip is still in the card header`);
      assert(placed.inWrap, `${label}: the lane chip is not inside the lane's transcript view`);
      const wrap = await box(`${cardSel} .fleet-out-wrap`);
      assert(chip.top >= wrap.top - 0.5 && chip.top - wrap.top <= 12, `${label}: the lane chip is not at the top of the transcript (chip ${Math.round(chip.top)}, view ${Math.round(wrap.top)})`);
      assert(chip.right <= wrap.right + 0.5 && wrap.right - chip.right <= 40, `${label}: the lane chip is not in the transcript's right corner (chip ${Math.round(chip.right)}, view ${Math.round(wrap.right)})`);
      assert(chip.bottom <= wrap.bottom + 0.5, `${label}: the lane chip runs out of the transcript into what is below it`);
      assert(await hits(laneChip, chip.x, chip.y), `${label}: the lane chip is covered: ${await owner(chip.x, chip.y)} is at its center`);
      for (const [sel, what] of [[`${cardSel} [data-fleet-input]`, "the lane's input"], [`${cardSel} [data-fleet-send]`, "the lane's send button"], [`${cardSel} .fleet-compose`, "the lane's composer row"]]) {
        assert(!overlaps(chip, await box(sel)), `${label}: the lane chip overlaps ${what}`);
      }
      // styles.css: @container (max-width:299px) shows the miniature page alone
      if (placed.host <= 299) assert(!placed.text, `${label}: a ${Math.round(placed.host)}px corner still shows the chip's text`);
      else if (placed.host >= 300) assert(placed.text, `${label}: a ${Math.round(placed.host)}px corner hides the chip's text`);
      // The chip floats over the transcript's content by design (like the jump pair), so the card is audited with that
      // content set aside, and the transcript is audited on its own.
      await page.$eval(`${cardSel} [data-fleet-out]`, (o) => { o.style.visibility = "hidden"; });
      try { await audit(cardSel, `${label} lane card`); } finally { await page.$eval(`${cardSel} [data-fleet-out]`, (o) => { o.style.visibility = ""; }); }
      await audit(`${cardSel} [data-fleet-out]`, `${label} lane transcript`);
      return { w: Math.round(chip.w), h: Math.round(chip.h), text: placed.text, corner: Math.round(placed.host) };
    };
    for (const size of SIZES) {
      const label = `${size.name} ${size.width}x${size.height}`;
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      await pause(500);
      const entry = { size: label };
      // the composer chip, top-right of the chat column, on top
      const comp = await box(composerChip);
      assert(comp, `${label}: the composer chip is not visible`);
      const col = await box("main.center");
      assert(col.right - comp.right >= 0 && col.right - comp.right <= 60 && comp.top - col.top <= 40, `${label}: the composer chip is not at the chat column's top-right`);
      assert(await hits(composerChip, comp.x, comp.y), `${label}: the composer chip is covered: ${await owner(comp.x, comp.y)}`);
      composerStyle = await styleOf(composerChip);
      // a wide card, then a narrow one
      await floatDock({ x: Math.round(size.width * 0.04), y: 64, w: Math.round(size.width * 0.5), h: Math.round(size.height * 0.66) });
      await page.waitForSelector(laneChip, { visible: true, timeout: 5000 });
      entry.laneWide = await laneChecks(`${label} wide card`);
      laneStyle = await styleOf(laneChip);
      sameStyle(composerStyle, laneStyle, `${label}: the lane chip does not look like the composer chip`);
      await floatDock({ x: Math.round(size.width * 0.04), y: 64, w: 300, h: Math.round(size.height * 0.66) });
      await page.waitForSelector(laneChip, { visible: true, timeout: 5000 });
      entry.laneNarrow = await laneChecks(`${label} narrow card`);
      assert(!entry.laneNarrow.text, `${label}: the 300px dock did not make a narrow card (its chip corner is ${entry.laneNarrow.corner}px)`);
      results.sizes.push(entry);
    }

    // ── B. the composer chip opens its head invitation's tab (the newest ready page: Main's or the lane's) ──────
    await clickReal(composerChip, "the composer chip");
    await until(previewShown, Boolean, 3000, "the composer chip did not open the Preview panel");
    const composerTab = await activeTab();
    assert(composerTab === "agent" || composerTab === `lane:${lane.id}`, `the composer chip opened the ${composerTab} tab, not one of its invitations`);
    results.composer.opened = composerTab;
    await pause(600); // the swing
    await clickReal("#prevClose", "the Preview's X");
    await until(previewGone, Boolean, 3000, "the Preview's X did not close it");

    // The lane's script ends on a permission ask: deny it once it is up, so Visualize's fly-to-approvals has nothing
    // of the lane's to chase while chips are measured (its turn then ends; the chip and its tab stay).
    const laneStatus = await until(async () => (await api("/api/fleet/status"))?.data?.lanes?.find((l) => l.id === lane.id)?.status ?? "gone",
      (s) => s !== "working", 90_000, `the lane ${lane.name} never finished its turn`);
    if (laneStatus === "needs-approval") await api("/api/fleet/answer", { laneId: lane.id, allow: false });

    // ── C. per size: the lane chip over the Fleet dock, then Agent Worlds ────────────────────────────────
    const vizProbe = () => page.evaluate((laneId) => {
      const p = window.__vizProbe;
      if (!p?.previewChips) return null;
      const chips = p.previewChips(), nodes = p.nodes(), builds = p.builds?.() ?? [];
      const pick = (id) => ({ chip: chips.find((c) => c.id === id) ?? null, node: nodes.find((n) => n.id === id) ?? null, art: builds.find((b) => b.id === id)?.chip ?? null });
      return { lane: pick(laneId), main: pick("main") };
    }, lane.id);
    const openViz = async (label) => {
      // a Visualize still fading out (hidden 200ms after its close) would swallow the reopen
      await until(() => page.evaluate(() => { const v = document.getElementById("vizView"); return !v || v.hidden || v.classList.contains("open"); }), Boolean, 2000, `${label}: Visualize never finished closing`);
      if (!(await vizShown())) await clickReal("#ctViz", `${label}: the Visualize button`);
      await until(vizShown, Boolean, 8000, `${label}: Visualize did not open`);
      await until(() => page.evaluate(() => typeof window.__vizProbe?.previewChips), (t) => t === "function", 8000, `${label}: no Visualize probe with previewChips (open the page with ?vizScript=1, on a build with P-PREVIEW.CHIP1)`);
      await page.$eval("[data-viz-auto]", (i) => { if (i.checked) i.click(); }); // a still camera, so node and chip are read from one frame
      return until(vizProbe, (v) => !!v?.lane.chip?.box && !!v?.lane.node?.box && !!v?.main.chip?.box && !!v?.main.node?.box, 20_000, `${label}: the lane's or Main's preview chip is not standing over its node in Visualize`);
    };
    const vizChip = (id) => `#vizView [data-viz-preview-chip="${q(id)}"]`;
    /** Move the pointer somewhere neutral on the stage (left middle, outside any panel), so no hover card lingers. */
    const stageSpot = async () => {
      const s = await box("#vizView [data-viz-stage]");
      for (const [fx, fy] of [[0.12, 0.5], [0.1, 0.35], [0.15, 0.65], [0.2, 0.45]]) {
        const x = s.left + s.w * fx, y = s.top + s.h * fy; // box() reports w/h, not width/height
        const free = await page.evaluate((px, py) => {
          const at = document.elementFromPoint(px, py);
          return !!at?.closest("#vizView [data-viz-stage]") && !at.closest("button, input, select, textarea, label, a, video, [data-viz-preview-chip], .pchip-pop, [data-viz-panel]");
        }, x, y);
        if (free) return { x, y };
      }
      throw new Error("no free spot on the Visualize stage to press");
    };
    const openFromChip = async (id, label) => {
      await clickReal(vizChip(id), `${label}: the ${id === "main" ? "hub's" : "lane's"} Worlds chip`);
      const spot = await stageSpot();
      await page.mouse.move(spot.x, spot.y);
      await until(previewShown, Boolean, 3000, `${label}: the Worlds chip did not open the Preview panel`);
      await pause(500); // the swing
    };
    const closedBack = async (id, label, how) => {
      await until(previewGone, Boolean, 3000, `${label}: ${how} did not slide the Preview panel back`);
      assert(await vizShown(), `${label}: ${how} closed Visualize too`);
      await until(focusedChip, (f) => f === id, 2000, `${label}: after ${how} focus did not return to the chip`);
    };
    for (const size of SIZES) {
      const label = `${size.name} ${size.width}x${size.height}`;
      const entry = results.sizes.find((s) => s.size === label);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      await pause(500);
      await floatDock({ x: Math.round(size.width * 0.04), y: 64, w: Math.round(size.width * 0.5), h: Math.round(size.height * 0.66) });
      // the lane chip opens the lane's tab above the Fleet dock
      await page.waitForSelector(laneChip, { visible: true, timeout: 5000 });
      await page.$eval(cardSel, (c) => c.scrollIntoView({ block: "nearest" }));
      await clickReal(laneChip, `${label}: the lane chip`);
      await until(previewShown, Boolean, 3000, `${label}: the lane chip did not open the Preview panel`);
      await pause(500);
      assert((await activeTab()) === `lane:${lane.id}`, `${label}: the lane chip opened the ${await activeTab()} tab`);
      const pv = await box("#preview");
      assert(await hits("#preview", pv.x, pv.y), `${label}: ${await owner(pv.x, pv.y)} paints over the Preview's center`);
      const dock = await box("#fleetDock");
      assert(dock, `${label}: opening the lane's preview closed the Fleet dock`);
      const ov = { left: Math.max(dock.left, pv.left), right: Math.min(dock.right, pv.right), top: Math.max(dock.top, pv.top), bottom: Math.min(dock.bottom, pv.bottom) };
      if (ov.right - ov.left > 20 && ov.bottom - ov.top > 20) assert(await hits("#preview", (ov.left + ov.right) / 2, (ov.top + ov.bottom) / 2), `${label}: the Fleet dock paints over the Preview`);
      await page.click("#prevClose");
      await until(previewGone, Boolean, 3000, `${label}: the Preview's X did not close it`);

      // Agent Worlds: each chip stands centered over its node, above its artifact chip when it has one. The chip moves
      // on the frame after the camera, so the check retries until a frame where the camera (or a fly-to an approval) is
      // at rest.
      await openViz(label);
      // A node near the stage's top keeps its chip on the stage (preview_curtain.chipStackAt clamps it 4px inside), so
      // "stands over" allows that clamp; a chip may never leave the stage.
      const stage = await box("#vizView [data-viz-stage]");
      const standsOver = (t) => {
        if (!t?.chip?.box || !t.node?.box) return false;
        const c = t.chip.box, n = t.node.box, bottom = c.y + c.h / 2, top = c.y - c.h / 2;
        if (top < stage.top + 3 || bottom > stage.bottom - 3) return false;
        const want = Math.max(n.y - n.r - 6 - (t.art ? t.art.h + 6 : 0), stage.top + 4 + c.h);
        const xOk = Math.abs(c.x - n.x) <= 6 || c.x - c.w / 2 <= stage.left + 5 || c.x + c.w / 2 >= stage.right - 5;
        return xOk && Math.abs(bottom - want) <= 8 && (!t.art || bottom <= t.art.y - t.art.h / 2 - 5 || top >= t.art.y + t.art.h / 2 + 5);
      };
      const v = await until(vizProbe, (p) => standsOver(p?.lane) && standsOver(p?.main), 10_000,
        `${label}: a Worlds chip is not standing over its node (or overlaps its artifact chip)`);
      for (const id of [lane.id, "main"]) {
        const c = (id === lane.id ? v.lane : v.main).chip.box;
        assert(await hits(vizChip(id), c.x, c.y), `${label}: ${id}'s Worlds chip is covered: ${await owner(c.x, c.y)}`);
      }
      entry.worlds = { lane: v.lane.chip.box, main: v.main.chip.box, artifactStack: v.lane.art || v.main.art ? "checked" : "no artifact chip on these nodes in this run (stacking is unit-tested: chipStackAt)" };
      const rest = await stageSpot(); // no chip under the pointer (a hovered chip lights its border), past the transition
      await page.mouse.move(rest.x, rest.y);
      await pause(300);
      const worldStyle = await styleOf(vizChip(lane.id));
      sameStyle(laneStyle, worldStyle, `${label}: the Worlds chip does not look like the lane chip`);
      sameStyle(composerStyle, worldStyle, `${label}: the Worlds chip does not look like the composer chip`);
      sameStyle(worldStyle, await styleOf(vizChip("main")), `${label}: Main's Worlds chip does not look like the lane's`);

      // the hover card
      const lc = await box(vizChip(lane.id));
      await page.mouse.move(lc.x, lc.y);
      await page.waitForSelector("#vizView .pchip-pop:not([hidden])", { visible: true, timeout: 3000 }).catch(() => { throw new Error(`${label}: hovering the Worlds chip showed no card`); });
      await pause(250);
      const card = await page.$eval("#vizView .pchip-pop", (p) => ({
        title: p.querySelector(".pchip-pop-title")?.textContent?.trim() ?? "", path: p.querySelector(".pchip-pop-path")?.textContent?.trim() ?? "",
        open: !!p.querySelector("[data-pchip-open]:not([disabled])"), shots: p.querySelectorAll("[data-lane-shot]").length,
      }));
      assert(card.title && card.path.includes("penalty-shootout"), `${label}: the hover card does not name the page (${JSON.stringify(card)})`);
      assert(card.open, `${label}: the hover card has no Open preview`);
      await audit("#vizView .pchip-pop", `${label} hover card`);
      entry.card = { title: card.title, shots: card.shots };

      // open over Visualize: from a snapshot when the agent has any, else from the chip
      if (card.shots) {
        await clickReal("#vizView .pchip-pop [data-lane-shot]", `${label}: the hover card's snapshot`);
        const spot = await stageSpot();
        await page.mouse.move(spot.x, spot.y);
        await until(previewShown, Boolean, 3000, `${label}: a snapshot did not open the Preview panel`);
        await pause(500);
        entry.openedFrom = "snapshot";
      } else {
        await openFromChip(lane.id, label);
        entry.openedFrom = "chip (no snapshots from this agent yet)";
      }
      assert((await activeTab()) === `lane:${lane.id}`, `${label}: Worlds opened the ${await activeTab()} tab`);
      const layer = await page.evaluate(() => ({ over: document.getElementById("preview").classList.contains("over-viz"), modal: document.getElementById("vizView").getAttribute("aria-modal"), z: getComputedStyle(document.getElementById("preview")).zIndex }));
      assert(layer.over && layer.z === "94", `${label}: the Preview is not on the over-Visualize tier (${JSON.stringify(layer)})`);
      assert(layer.modal === "false", `${label}: Visualize stayed modal under the Preview`);
      assert(await vizShown(), `${label}: opening the Preview closed Visualize`);
      const pz = await box("#preview");
      for (const [x, y, where] of [[pz.x, pz.y, "center"], [pz.left + 40, pz.top + 24, "header"]]) assert(await hits("#preview", x, y), `${label}: ${await owner(x, y)} paints over the Preview's ${where} in Visualize`);
      // its resize edge, over the world
      const edgeSel = '#preview [data-resize="preview"]';
      const drag = async (dx) => {
        const e = await box(edgeSel);
        assert(e && (await hits(edgeSel, e.x, e.y)), `${label}: the Preview's resize edge is covered in Visualize`);
        await page.mouse.move(e.x, e.y);
        await page.mouse.down();
        await page.mouse.move(e.x + dx, e.y, { steps: 10 });
        await page.mouse.up();
        await pause(300);
        return (await box("#preview")).w;
      };
      const w0 = pz.w, narrower = await drag(160);
      assert(narrower < w0 - 60, `${label}: dragging the edge right over Visualize did not narrow the Preview (${Math.round(w0)} -> ${Math.round(narrower)})`);
      const wider = await drag(-100);
      assert(wider > narrower + 50, `${label}: dragging the edge left over Visualize did not widen the Preview (${Math.round(narrower)} -> ${Math.round(wider)})`);
      const width = await page.evaluate(() => ({ saved: localStorage.getItem("lucid.preview-w"), css: document.getElementById("preview").offsetWidth }));
      assert(width.saved && Math.abs(parseFloat(width.saved) - width.css) <= 2, `${label}: the width was not saved (lucid.preview-w ${width.saved}, ${width.css} CSS px)`);
      assert(await vizShown(), `${label}: resizing the Preview closed Visualize`);
      entry.resize = [Math.round(w0), Math.round(narrower), Math.round(wider)];
      // X slides it back; focus goes to the chip
      await clickReal("#prevClose", `${label}: the Preview's X over Visualize`);
      await closedBack(lane.id, label, "the X");
      // Esc with focus in the panel slides it back; the next Esc closes Visualize
      await openFromChip(lane.id, label);
      assert(await page.evaluate(() => document.getElementById("preview").contains(document.activeElement)), `${label}: focus is not in the Preview after the chip opened it`);
      await page.keyboard.press("Escape");
      await closedBack(lane.id, label, "Esc");
      await page.keyboard.press("Escape");
      await until(async () => !(await vizShown()), Boolean, 2000, `${label}: the second Esc did not close Visualize`);
      // a press back on the world slides it away, and picks nothing
      await openViz(label);
      await openFromChip(lane.id, label);
      const spot = await stageSpot();
      await page.mouse.click(spot.x, spot.y);
      await closedBack(lane.id, label, "a press on the world");
      assert(await page.$eval("#vizView [data-viz-panel]", (p) => p.hidden), `${label}: the press that closed the Preview also opened a node panel`);
      for (let i = 0; i < 3 && (await vizShown()); i++) { await page.keyboard.press("Escape"); await pause(350); }
      assert(!(await vizShown()), `${label}: Visualize did not close`);
    }

    // ── D. Main's chip opens the composer's Agent tab over Visualize ─────────────────────────────────────
    await openViz("hub");
    await openFromChip("main", "hub");
    assert((await activeTab()) === "agent", `Main's Worlds chip opened the ${await activeTab()} tab, not the composer's Agent tab`);
    assert(await page.evaluate(() => document.getElementById("preview").classList.contains("over-viz")), "Main's Worlds chip did not open the Preview over Visualize");
    await clickReal("#prevClose", "the Preview's X over Visualize (hub)");
    await closedBack("main", "hub", "the X");
    await page.keyboard.press("Escape");
    await until(async () => !(await vizShown()), Boolean, 2000, "Esc did not close Visualize after the hub check");

    await page.evaluate(() => window.__previewChipDemo);
    assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
    return results;
  } finally {
    page.off("pageerror", onError);
    await page.evaluate((s, d, h, a) => {
      const put = (k, v) => { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); };
      put(d, s.dock); put(h, s.home); put(a, s.auto);
    }, saved, DOCK_KEY, HOME_KEY, AUTO_CAM_KEY).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_preview_chip_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL (with ?vizScript=1) to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyPreviewChip(page, { lane: process.env.LUCID_DEMO_LANE }), null, 2));
    console.log("P-PREVIEW.CHIP1 passed: one preview chip in the composer, inside the lane's transcript and beside its agent in Agent Worlds, the same look everywhere; a Worlds chip flies the Preview out over Visualize, resizable, and X, Esc or a press on the world slides it back to the chip, wide and narrow.");
  } finally { await browser.disconnect(); }
}
