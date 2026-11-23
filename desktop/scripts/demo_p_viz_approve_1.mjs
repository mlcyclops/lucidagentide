// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_viz_approve_1.mjs
//
// P-VIZ.APPROVE1 (ADR-0655): real-browser check of tool-call approvals inside Visualize, on the ?vizDemo=1 feed (the
// page must already be at <engine>/?vizDemo=1 with first-run gates done; the demo parks three asks a cycle on its
// lanes, one red, and answers them locally, never through the real routes). With real input, in 3D and then in 2D:
//   1. Auto camera off and View > Fly to approvals on: a new demo ask flies the camera (a flight starts and ends
//      with the asking node near the middle of the stage);
//   2. the node's badge is on top at its own screen point (elementFromPoint), and a tap there opens the pop-out
//      beside the node with Approve, Auto and Deny on top; auditBoxes (ADR-0633) is clean on the pop-out;
//   3. Approve one ask and Deny the next: each leaves the probe's open asks and the pop-out closes;
// then:
//   4. Fly to approvals off (persisted as "0" in lucid.viz.flyToApprovals.v1): the next ask starts no flight;
//   5. the triage pill's count equals the open asks and the triage total; expanded it lists one row per ask and
//      passes auditBoxes; every header control is still on top at its center (the strip never covers one); after
//      4 s idle it folds back;
//   6. no uncaught page errors. Fly to approvals is switched back on at the end.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 node desktop/scripts/demo_p_viz_approve_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

export async function verifyVizApprove(page) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  const onError = (e) => errors.push(String(e?.message ?? e));
  page.on("pageerror", onError);
  const probe = () => page.evaluate(() => window.__vizProbe?.approvals?.() ?? null);
  const center = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; });
  const onTop = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && e.contains(hit); });
  const click = async (sel) => { const c = await center(sel); assert(c.w > 0, `${sel} is not laid out`); await page.mouse.click(c.x, c.y); };
  const audit = async (root) => { const bad = await page.evaluate(auditBoxes, root, MIN_GAP); assert(bad.length === 0, `spacing on ${root}: ${bad.join(" | ")}`); };
  const seen = new Set();
  /** The next demo ask nobody has handled yet (the feed brings one every few seconds, three a 48 s cycle). */
  const nextAsk = async () => {
    const h = await page.waitForFunction((known) => {
      const p = window.__vizProbe?.approvals?.();
      return p?.pending.find((a) => !known.includes(a.id)) ?? false;
    }, { timeout: 60_000, polling: 100 }, [...seen]).catch(() => { throw new Error("no new demo approval arrived within 60 s"); });
    const ask = await h.jsonValue();
    seen.add(ask.id);
    return ask;
  };
  /** The View menu's Fly to approvals checkbox set to `on`, through the real menu. */
  const setFly = async (on) => {
    await click("#vizView [data-viz-head] [data-viz-viewmenu]");
    await page.waitForSelector(".popover.show input[data-viz-flyask]", { visible: true, timeout: 3000 })
      .catch(() => { throw new Error("the View menu has no Fly to approvals checkbox"); });
    if ((await page.$eval(".popover.show input[data-viz-flyask]", (i) => i.checked)) !== on) await click(".popover.show input[data-viz-flyask]");
    assert((await page.$eval(".popover.show input[data-viz-flyask]", (i) => i.checked)) === on, `Fly to approvals did not turn ${on ? "on" : "off"}`);
    await page.keyboard.press("Escape");
    await pause(200);
    const stored = await page.evaluate(() => localStorage.getItem("lucid.viz.flyToApprovals.v1"));
    // nothing stored yet means the default, which is on
    assert(stored === (on ? "1" : "0") || (on && stored === null), `Fly to approvals was not persisted (${stored})`);
    assert((await probe()).flyToApprovals === on, "the view did not take the Fly to approvals change");
  };
  /** The asking node's distance from the stage's middle, as a share of the stage's shorter side. */
  const offCenter = (node) => page.evaluate((id) => {
    const s = document.querySelector("#vizView [data-viz-stage]").getBoundingClientRect();
    const n = window.__vizProbe.nodes().find((x) => x.id === id);
    if (!n?.box) return 9;
    return Math.hypot(n.box.x - (s.left + s.width / 2), n.box.y - (s.top + s.height / 2)) / Math.min(s.width, s.height);
  }, node);
  /** An ask arrives: the camera flies to its node, then holds still there (Auto camera is off). */
  const flewTo = async (ask, before) => {
    await page.waitForFunction((b) => (window.__vizProbe.approvals()?.flights ?? 0) > b, { timeout: 3000 }, before)
      .catch(() => { throw new Error(`no flight started for ${ask.node}'s ask with Fly to approvals on`); });
    await page.waitForFunction(() => window.__vizProbe.approvals()?.flying === null, { timeout: 6000 })
      .catch(() => { throw new Error("the flight never ended"); });
    const off = await offCenter(ask.node);
    assert(off < 0.3, `the camera did not end on ${ask.node} (off center by ${off.toFixed(2)} of the stage)`);
    return off;
  };
  /** Tap the badge at its own screen point, then answer in the pop-out. */
  const tapAndAnswer = async (ask, act) => {
    const p = await probe();
    const badge = p.pending.find((a) => a.id === ask.id)?.badge;
    assert(badge, `${ask.node} has no badge on screen`);
    const hit = await page.evaluate((b, node) => document.elementFromPoint(b.x, b.y)?.closest("[data-viz-ask-badge]")?.getAttribute("data-viz-ask-badge") === node, badge, ask.node);
    assert(hit, `the badge of ${ask.node} is covered at its center`);
    const risk = await page.$eval(`#vizView [data-viz-ask-badge="${ask.node}"]`, (b) => b.dataset.risk);
    assert(risk === (ask.danger ? "danger" : "normal"), `the badge of ${ask.node} is ${risk}, expected ${ask.danger ? "danger" : "normal"}`);
    await page.mouse.click(badge.x, badge.y);
    await page.waitForFunction((id) => window.__vizProbe.approvals()?.pop.id === id, { timeout: 3000 }, ask.id)
      .catch(() => { throw new Error(`tapping ${ask.node}'s badge did not open its pop-out`); });
    await pause(250); // the pop-out's entry animation
    for (const a of ["once", "auto", "deny"]) assert(await onTop(`#vizView [data-viz-ask] [data-viz-ask-act="${a}"]`), `the pop-out's ${a} button is covered`);
    assert(await page.$eval("#vizView [data-viz-ask-demo]", (e) => !e.hidden && e.textContent === "DEMO"), "the demo pop-out is not labeled DEMO");
    await audit("#vizView [data-viz-ask]");
    await click(`#vizView [data-viz-ask] [data-viz-ask-act="${act}"]`);
    await page.waitForFunction((id) => { const p = window.__vizProbe.approvals(); return !p.pending.some((a) => a.id === id) && !p.pop.open; }, { timeout: 3000 }, ask.id)
      .catch(() => { throw new Error(`${act === "once" ? "Approve" : "Deny"} did not settle ${ask.node}'s ask`); });
  };

  const results = { modes: {} };
  try {
    if (!(await page.$("#vizView:not([hidden])"))) {
      await page.evaluate(() => { document.querySelector("#fleetDock [data-dock-min]")?.click(); document.getElementById("ctViz")?.click(); });
    }
    await page.waitForSelector("#vizView [data-viz-stage]", { visible: true, timeout: 8000 });
    await page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
    assert(await probe(), "no approvals probe: open the page with ?vizDemo=1");
    for (const a of (await probe()).pending) seen.add(a.id); // asks already open are not new
    if (await page.$eval("#vizView input[data-viz-auto]", (i) => i.checked)) await click("#vizView input[data-viz-auto]");
    await setFly(true);

    for (const mode of ["3d", "2d"]) {
      await click(`#vizView [data-viz-view="${mode}"]`);
      await pause(800);
      const r = {};
      for (const act of ["once", "deny"]) {
        const before = (await probe()).flights;
        for (const a of (await probe()).pending) seen.add(a.id); // one that came in meanwhile already flew: wait for a fresh one
        const ask = await nextAsk();
        r[act] = { node: ask.node, from: ask.from, danger: ask.danger, offCenter: await flewTo(ask, before) };
        await tapAndAnswer(ask, act);
      }
      results.modes[mode] = r;
    }

    // 4. Fly to approvals off: the next ask starts no flight
    await setFly(false);
    const before = (await probe()).flights;
    for (const a of (await probe()).pending) seen.add(a.id);
    const quiet = await nextAsk();
    await pause(1500);
    const after = await probe();
    assert(after.flights === before && after.flying === null, `a flight started for ${quiet.node}'s ask with Fly to approvals off`);
    results.flyOff = { node: quiet.node, flights: after.flights };

    // 5. the triage strip: counts, rows, header clear, folds back when idle
    const t = await probe();
    assert(t.pill.box, "the triage pill is not shown with asks open");
    assert(t.pill.count === t.pending.length && t.triage.total === t.pending.length, `pill ${t.pill.count}, triage ${t.triage.total}, open ${t.pending.length}`);
    const label = await page.$eval("#vizView [data-viz-tri-n]", (e) => e.textContent.trim());
    assert(label === `${t.pending.length} approval${t.pending.length === 1 ? "" : "s"}`, `the pill says "${label}" for ${t.pending.length} open asks`);
    for (const k of ["working", "waiting", "failed"]) assert(new RegExp(`\\d+ ${k}`).test(t.pill.text), `the pill has no ${k} count: "${t.pill.text}"`);
    assert(await onTop("#vizView [data-viz-tri-pill]"), "the triage pill is covered");
    await click("#vizView [data-viz-tri-pill]");
    await page.waitForFunction(() => window.__vizProbe.approvals()?.expanded === true, { timeout: 2000 });
    const rows = await page.$$eval("#vizView [data-viz-tri-row]", (rs) => rs.length);
    const open = (await probe()).pending.length;
    assert(rows === open, `the strip lists ${rows} rows for ${open} open asks`);
    await audit("#vizView [data-viz-tri]");
    const header = await page.$$eval("#vizView [data-viz-head] :is(button, label)", (els) => els.filter((e) => {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(e).visibility === "hidden") return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && !e.contains(hit) && !!hit.closest("[data-viz-tri], [data-viz-ask], [data-viz-ask-badge]");
    }).map((e) => e.getAttribute("aria-label") || e.textContent.trim()));
    assert(header.length === 0, `header controls covered: ${header.join(", ")}`);
    const strip = await center("#vizView [data-viz-tri]");
    const head = await center("#vizView [data-viz-head]");
    assert(strip.y - strip.h / 2 >= head.y + head.h / 2, "the triage strip reaches into the header");
    await page.mouse.move(5, 5); // leave it idle
    await page.waitForFunction(() => window.__vizProbe.approvals()?.expanded === false, { timeout: 6000 })
      .catch(() => { throw new Error("the triage strip did not fold back after 4 s idle"); });
    results.triage = { pill: t.pill.text, rows, triage: t.triage };
    assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
    return results;
  } finally {
    await setFly(true).catch(() => { /* best effort: leave the default on */ });
    page.off("pageerror", onError);
  }
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_viz_approve_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine (?vizDemo=1).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyVizApprove(page), null, 2));
    console.log("P-VIZ.APPROVE1 passed: asks fly the camera in 3D and 2D, badges open the pop-out, Approve and Deny settle, Fly to approvals off stays put, and the triage strip counts and folds.");
  } finally { await browser.disconnect(); }
}
