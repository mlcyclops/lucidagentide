// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_fleet_dock_1.mjs
//
// P-FLEET.DOCK1: real-browser check of two fleet grid fixes, with real input on an already-open LUCID page (first-run
// gates done, at least one local agent idle in the fleet):
//   1. the Fleet button (#ctFleet) brings a MINIMIZED grid back, with the grid pinned and with the orbit pinned:
//      open the grid, minimize it with its own [data-dock-min], press #ctFleet, and the dock is shown, its pill is
//      gone, the orbit is not up, and elementFromPoint at the dock's center hits the dock; a second press closes it;
//   2. a lane card shows a turn it did not start: with the dock open, a prompt is POSTed straight to
//      /api/fleet/prompt (the page's lucid-token, never the card's composer), and within 10 s the card shows the
//      prompt and the agent's output (live text, thinking or a tool chip, or the settled reply). Once the turn ends,
//      the prompt is on the card exactly once and a reply follows it; auditBoxes (ADR-0633) is clean on the output;
//   3. no uncaught page errors. The "which view opens first" pin is put back as it was.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/ node desktop/scripts/demo_p_fleet_dock_1.mjs
// Optional: LUCID_DEMO_LANE=<lane id> picks the agent (default: the first idle one).

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const HOME_KEY = "lucid.fleetHome.v1";

export async function verifyFleetDock(page, opts = {}) {
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
      await pause(150);
    }
  };
  const click = async (sel) => {
    // boot and status toasts sit top-right, over the orbit header's buttons: close them first, as a person would
    for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});
    const c = await page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; });
    assert(c.w > 0, `${sel} is not laid out`);
    await page.mouse.click(c.x, c.y);
  };
  /** What the user sees of the fleet: the dock, its pill, and the orbit. */
  const surfaces = () => page.evaluate(() => {
    const d = document.getElementById("fleetDock");
    const o = document.getElementById("orbitView");
    const orbit = !!o && !o.hidden && o.classList.contains("open");
    const pill = !!document.getElementById("fleetDockPill")?.isConnected;
    if (!d) return { dock: "none", pill, orbit, onTop: false };
    const r = d.getBoundingClientRect();
    const hit = r.width > 0 ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    return { dock: d.hidden ? "hidden" : "shown", pill, orbit, onTop: !!hit && d.contains(hit), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const setHome = (v) => page.evaluate((k, val) => { if (val == null) localStorage.removeItem(k); else localStorage.setItem(k, val); }, HOME_KEY, v);
  /** Nothing of the fleet up: press the Fleet button until both views are gone (a minimized grid comes back first). */
  const clear = async () => {
    for (let i = 0; i < 4; i++) {
      const s = await surfaces();
      if (s.dock === "none" && !s.orbit) return;
      // the open orbit covers the composer (and its Fleet button): close it with its own header button
      await click(s.orbit ? "#orbitView [data-orbit-close]" : "#ctFleet");
      await pause(450); // the orbit's close fade is 220 ms
    }
    const s = await surfaces();
    assert(s.dock === "none" && !s.orbit, `the Fleet button could not clear the fleet: ${JSON.stringify(s)}`);
  };
  const shownOnTop = (what) => until(surfaces, (s) => s.dock === "shown" && s.onTop && !s.pill && !s.orbit, 3000, what);
  /** Minimize through the dock's own button, then press the Fleet button: the dock must be back and on top. */
  const minimizeAndRestore = async (label) => {
    await click("#fleetDock [data-dock-min]");
    await until(surfaces, (s) => s.dock === "hidden" && s.pill, 3000, `${label}: minimize did not leave the pill`);
    await click("#ctFleet");
    return shownOnTop(`${label}: the Fleet button did not bring the minimized dock back on top`);
  };

  const homeBefore = await page.evaluate((k) => localStorage.getItem(k), HOME_KEY);
  const results = {};
  try {
    // 1a. the grid pinned
    await setHome("grid");
    await clear();
    await click("#ctFleet");
    await shownOnTop("grid pinned: the Fleet button did not open the dock on top");
    results.gridPinned = await minimizeAndRestore("grid pinned");
    await click("#ctFleet");
    await until(surfaces, (s) => s.dock === "none" && !s.orbit, 3000, "grid pinned: a second press did not close the shown dock");

    // 1b. the orbit pinned: the grid is reached through the orbit's Grid button, and a minimized grid still comes back
    await setHome("orbit");
    await clear();
    await click("#ctFleet");
    await until(surfaces, (s) => s.orbit, 3000, "orbit pinned: the Fleet button did not open the orbit");
    await click("#orbitView [data-orbit-grid]");
    await shownOnTop("orbit pinned: the orbit's Grid button did not show the dock on top");
    results.orbitPinned = await minimizeAndRestore("orbit pinned");
    await click("#ctFleet");
    await until(surfaces, (s) => s.dock === "none" && !s.orbit, 3000, "orbit pinned: a second press did not close the shown dock");

    // 2. a turn the card did not start shows on the card
    await setHome("grid");
    await clear();
    await click("#ctFleet");
    await shownOnTop("the dock did not open for the backfill check");
    const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content).catch(() => "");
    const api = (path, body) => page.evaluate(async (p, b, t) => {
      const r = await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", ...(t ? { "x-lucid-token": t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) });
      return r.json();
    }, path, body ?? null, token);
    const status = await api("/api/fleet/status");
    const lanes = status?.data?.lanes ?? [];
    const idle = (l) => l.status === "awaiting-input" || l.status === "done";
    const lane = opts.lane ? lanes.find((l) => l.id === opts.lane) : lanes.find(idle);
    assert(lane, opts.lane ? `no agent ${opts.lane} in the fleet` : "no idle agent in the fleet: start one with + Agent first");
    assert(idle(lane), `agent ${lane.name} is ${lane.status}, not idle`);
    const cardSel = `#fleetDock .fleet-card[data-lane="${lane.id}"]`;
    await page.waitForSelector(cardSel, { timeout: 6000 });
    const prompt = `P-FLEET.DOCK1 check ${Date.now()}: reply with one short sentence that names a color.`;
    /** The card as the user sees it: how often the prompt is shown, and the agent's output after it. */
    const card = () => page.evaluate((sel, text) => {
      const out = document.querySelector(`${sel} [data-fleet-out]`);
      if (!out) return null;
      const turns = [...out.querySelectorAll("[data-lane-turn]")];
      const mine = turns.filter((t) => t.querySelector(".fleet-turn-user")?.textContent?.includes(text));
      const at = mine.length ? turns.indexOf(mine[0]) : -1;
      const reply = at >= 0 ? turns.slice(at + 1).filter((t) => !t.querySelector(".fleet-turn-user")).map((t) => t.textContent.trim()).join(" ").trim() : "";
      const live = out.querySelector("[data-lane-live]");
      const shown = !!live && !live.hidden;
      const liveOut = shown ? `${live.querySelector("[data-lane-txt]")?.textContent ?? ""}${live.querySelector("[data-lane-think]")?.textContent ?? ""}`.trim() || (live.querySelector(".fleet-chip-row") ? "[tool call]" : "") : "";
      const empty = out.querySelector("[data-lane-empty]");
      return { prompts: mine.length, reply: reply.slice(0, 160), live: liveOut.slice(0, 160), liveShown: shown, empty: empty && !empty.hidden ? empty.textContent.trim() : "" };
    }, cardSel, prompt);
    // Started from outside the card: the page's own fetch, which the card never sees.
    await page.evaluate((laneId, text, t) => {
      window.__fleetDockDemo = fetch("/api/fleet/prompt", { method: "POST", headers: { "content-type": "application/json", ...(t ? { "x-lucid-token": t } : {}) }, body: JSON.stringify({ laneId, text }) })
        .then((r) => r.text()).catch((e) => `failed: ${String(e)}`);
    }, lane.id, prompt, token);
    const started = Date.now();
    const seen = await until(card, (c) => !!c && c.prompts >= 1 && (c.live !== "" || c.reply !== ""), 10_000, `the card of ${lane.name} showed no output for a turn it did not start within 10 s`);
    results.backfill = { lane: lane.name, ms: Date.now() - started, live: seen.live, reply: seen.reply };
    // Once the turn ends: the prompt once, a reply after it, nothing live left over.
    const end = await until(async () => {
      const s = await api("/api/fleet/status");
      const l = (s?.data?.lanes ?? []).find((x) => x.id === lane.id);
      return { status: l?.status, card: await card() };
    }, (v) => v.status !== "working" && v.status !== "needs-approval" && !!v.card && v.card.reply !== "" && !v.card.liveShown, 120_000, `the turn on ${lane.name} did not settle on the card`);
    assert(end.card.prompts === 1, `the prompt shows ${end.card.prompts} times on the card`);
    results.settled = { status: end.status, reply: end.card.reply };
    const bad = await page.evaluate(auditBoxes, `${cardSel} [data-fleet-out]`, MIN_GAP);
    assert(bad.length === 0, `spacing on the card output: ${bad.join(" | ")}`);
    await page.evaluate(() => window.__fleetDockDemo);
    assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
    return results;
  } finally {
    await setHome(homeBefore).catch(() => { /* best effort: the pin is the user's */ });
    page.off("pageerror", onError);
  }
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_fleet_dock_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyFleetDock(page, { lane: process.env.LUCID_DEMO_LANE }), null, 2));
    console.log("P-FLEET.DOCK1 passed: the Fleet button brings a minimized grid back on top with the grid or the orbit pinned, and a lane card shows a turn it did not start.");
  } finally { await browser.disconnect(); }
}
