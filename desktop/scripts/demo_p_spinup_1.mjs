// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_spinup_1.mjs
//
// P-SPINUP.1 (+ P-RAIL.AGENTS1d): real-browser proof that a starting agent is shown, not just noted, and that a
// working Agent stays bright on the rail. Real mouse input against an isolated QA engine whose fake agents take
// QA_AGENT_START_MS to start, like a real handshake. In a wide (1600x1000) and a narrow (1100x800) window:
//   1. rail: with an agent working in folder A, A's box is at full opacity while idle B rests at .55 (effective
//      opacity, ancestors included), with the left sidebar open AND collapsed; hovering the rail lifts B to 1;
//   2. lane: Activate > Start new Fleet session on B puts a walking mini Lucid on the new card's composer edge,
//      under a status bubble naming the Agent that cycles its lines; it never takes a click from the card; the
//      card's buddy waits; when the lane is ready the bubble says so and the walker leaves;
//   3. Worlds: Activate > Agent World session on B shows the walker over the new lane's node, then it leaves;
//   4. Main: a reload (Main's agent starting) shows the walker on the composer's edge naming Main's folder,
//      without covering the input, then it leaves once Main is ready.
//
// Setup (an isolated QA engine and browser, never a user's session):
//   QA_AGENT_START_MS=6000 bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811
//   open http://127.0.0.1:7811/ in the QA browser (remote debugging on), past the first-run gates, Main idle.
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_spinup_1.mjs
// The QA root defaults to <tmp>/lucid-qa-fleet-<port> (from fleet.json); LUCID_DEMO_QA_ROOT overrides it.

import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const AGENTS_KEY = "lucid.agents.v1";
const VIEW_KEY = "lucid.rail.view";
const PERF_KEY = "lucid.perfMode";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => { const s = String(p).trim().replace(/[\\/]+/g, "/"); return (s.length > 1 ? s.replace(/\/$/, "") : s).toLowerCase(); };

export async function verifySpinup(page, opts = {}) {
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  const until = async (read, ok, ms, what, every = 150) => {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      last = await read();
      if (ok(last)) return last;
      if (Date.now() > end) throw new Error(`${what} (last: ${JSON.stringify(last)})`);
      await pause(every);
    }
  };
  const base = new URL(page.url()).origin + "/";
  const port = new URL(base).port;
  const fleet = JSON.parse(readFileSync(join(opts.qaRoot ?? process.env.LUCID_DEMO_QA_ROOT ?? join(tmpdir(), `lucid-qa-fleet-${port}`), "fleet.json"), "utf8"));
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content);
  const api = async (path, body) => {
    const r = await page.evaluate(async (p, b, t) => {
      const res = await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", "x-lucid-token": t }, ...(b ? { body: JSON.stringify(b) } : {}) });
      return res.json();
    }, path, body ?? null, token);
    return r?.data ?? r;
  };
  const lanes = async () => (await api("/api/fleet/status"))?.lanes ?? [];
  const box = (sel) => page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n || n.closest("[hidden]")) return null;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height } : null;
  }, sel);
  const owner = (x, y) => page.evaluate((px, py) => {
    const at = document.elementFromPoint(px, py);
    if (!at) return "nothing";
    const o = at.closest("[id]");
    return `${at.tagName.toLowerCase()}${typeof at.className === "string" && at.className ? `.${at.className.split(" ")[0]}` : ""}${o ? ` in #${o.id}` : ""}`;
  }, x, y);
  const topmost = async (sel, what) => {
    const now = await page.evaluate((s) => {
      const n = document.querySelector(s);
      const r = n?.getBoundingClientRect();
      if (!r || r.width === 0 || n.closest("[hidden]")) return null;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const at = document.elementFromPoint(x, y);
      return { x, y, ok: !!at && n.contains(at) };
    }, sel);
    assert(now, `${what} is not visible`);
    assert(now.ok, `${what} is covered: ${await owner(now.x, now.y)} is at its center`);
    return now;
  };
  const dismissToasts = async () => {
    await page.evaluate(() => {
      for (const t of document.querySelectorAll("#toasts .toast")) {
        const btns = [...t.querySelectorAll("button")];
        const x = t.querySelector(".h button, .toast-x, [aria-label='close' i], [aria-label='dismiss' i]") ?? btns.find((b) => /^(Not now|Got it|Dismiss|OK|Close)$/i.test(b.textContent.trim()));
        x?.click();
      }
    });
    await pause(250);
  };
  const clickReal = async (sel, what) => { const b = await topmost(sel, what); await page.mouse.click(b.x, b.y); };
  /** Opacity as the user sees it: the element's times every ancestor's. */
  const seenOpacity = (sel) => page.$eval(sel, (n) => { let o = 1; for (let e = n; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return Math.round(o * 100) / 100; });
  const awayFromRail = async (size) => { await page.mouse.move(Math.round(size.width * 0.4), Math.round(size.height * 0.45)); await pause(450); };
  const vizShown = () => page.evaluate(() => { const v = document.getElementById("vizView"); return !!v && !v.hidden && v.classList.contains("open"); });
  const closeViz = async () => { for (let i = 0; i < 4 && (await vizShown()); i++) { await page.keyboard.press("Escape"); await pause(350); } };
  const tileSel = (id) => `.agr-tile[data-agent="${id.replace(/["\\]/g, "\\$&")}"]`;
  const ensureRail = async (label) => {
    await page.waitForSelector("#railAgents", { timeout: 20_000 });
    if (!(await page.$eval("#inspector", (n) => n.classList.contains("rail")))) { await clickReal("#inspCollapse", `${label}: collapse the inspector`); await pause(400); }
    if ((await page.$eval("#railAgents", (b) => b.getAttribute("aria-pressed"))) !== "true") { await clickReal("#railAgents", `${label}: the Agents toggle`); await pause(400); }
  };
  const activate = async (id, kind, label) => {
    await dismissToasts();
    await ensureRail(label);
    await page.$eval(tileSel(id), (t) => t.scrollIntoView({ block: "nearest" }));
    await clickReal(tileSel(id), `${label}: the Agent box`);
    const go = `.agr-pop.show [data-go="${kind}"]`;
    await until(() => box(go), Boolean, 3000, `${label}: the module did not open with Activate > ${kind}`);
    await clickReal(go, `${label}: Activate > ${kind}`);
  };
  /** Watches one walker host until it leaves: the lines it showed, how it moved, and its ready line. */
  const watchWalker = async (host, label, { surfaceEl, feetOn } = {}) => {
    const texts = new Set();
    const xs = [];
    let ready = "";
    let checked = false;
    const end = Date.now() + 90_000;
    for (;;) {
      const s = await page.evaluate((h) => {
        const n = document.querySelector(h);
        if (!n) return null;
        const w = n.querySelector(".spw")?.getBoundingClientRect();
        const b = n.querySelector(".spw-bubble")?.getBoundingClientRect();
        return { phase: n.dataset.spwPhase, text: n.querySelector(".spw-text")?.textContent?.trim() ?? "", time: n.querySelector(".spw-time")?.textContent ?? "", w: w && { left: w.left, right: w.right, top: w.top, bottom: w.bottom, x: w.left + w.width / 2, y: w.top + w.height / 2 }, b: b && { left: b.left, right: b.right, top: b.top, bottom: b.bottom } };
      }, host);
      if (!s) break;
      if (s.phase === "ready") ready = s.text;
      else if (s.text) texts.add(s.text);
      if (s.w) xs.push(s.w.left);
      if (!checked && s.w && s.b && s.phase !== "ready") {
        checked = true;
        // never takes a click: the point under the walker belongs to the surface
        const under = await page.evaluate((x, y) => !!document.elementFromPoint(x, y)?.closest(".spw-host"), s.w.x, s.w.y);
        assert(!under, `${label}: the walker takes the pointer (elementFromPoint hits it)`);
        assert(s.b.bottom <= s.w.top + 4, `${label}: the bubble is not over the walker (${JSON.stringify(s)})`);
        if (surfaceEl) {
          const c = await box(surfaceEl);
          assert(c && s.b.left >= c.left - 1 && s.b.right <= c.right + 1, `${label}: the bubble leaves its surface (${JSON.stringify({ bubble: s.b, surface: c })})`);
        }
        if (feetOn) {
          // A card that was just added is still settling (scrolled into view, its transcript sized): the walker
          // must be on the composer's edge within one of its layout ticks.
          let last = null;
          const onEdge = await until(async () => {
            const r = await page.evaluate((h, f) => {
              const w = document.querySelector(h)?.querySelector(".spw")?.getBoundingClientRect();
              const c = document.querySelector(f)?.getBoundingClientRect();
              return w && c ? { feet: w.bottom, edge: c.top } : null;
            }, host, feetOn);
            last = r;
            return !r || Math.abs(r.feet - r.edge) <= 10;
          }, Boolean, 1500, "").catch(() => false);
          assert(onEdge, `${label}: the walker's feet are not on the composer's edge (${JSON.stringify(last)})`);
        }
      }
      if (Date.now() > end) throw new Error(`${label}: the walker never left`);
      await pause(120);
    }
    return { lines: [...texts], moved: xs.length > 1 ? Math.round(Math.max(...xs) - Math.min(...xs)) : 0, ready };
  };

  const cdp = await page.target().createCDPSession();
  const started = [];
  const results = { sizes: [] };
  let perfBefore = null;
  try {
    const ws = (await api("/api/workspace"))?.current;
    assert(ws, "the engine reports no workspace folder");
    const root = join(fleet.root ?? join(fleet.workspace, "..", ".."), "workspace", "agents");
    const A = join(root, "spin-alpha"), B = join(root, "spin-bravo");
    for (const f of [A, B]) mkdirSync(f, { recursive: true });
    const doc = { v: 1, agents: [A, B].map((path) => ({ id: norm(path), path, name: null, theme: "lucid", hue: 145, saved: true })), hidden: [], manual: false, main: null };
    perfBefore = await page.evaluate((k, d, vk, pk) => { localStorage.setItem(k, JSON.stringify(d)); localStorage.setItem(vk, "agents"); const v = localStorage.getItem(pk); localStorage.setItem(pk, "full"); return v; }, AGENTS_KEY, doc, VIEW_KEY, PERF_KEY);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#input", { visible: true, timeout: 60_000 });
    await until(async () => !(await page.$(".spw-host")), Boolean, 60_000, "a boot walker never left before the run");
    const idA = norm(A), idB = norm(B);

    for (const size of SIZES) {
      const label = size.name;
      const entry = { size: label };
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      await pause(600);
      await dismissToasts();

      // 1. rail: a working Agent stays bright
      await ensureRail(label);
      let spA = null;
      for (const end = Date.now() + 240_000; ;) {
        spA = await api("/api/fleet/spawn", { cwd: A, name: `Spin A ${label}` });
        if (spA?.ok !== false || !/has been at \d+%/.test(spA?.reason ?? "") || Date.now() > end) break;
        await pause(5000);
      }
      const laneA = spA?.lane?.id;
      assert(laneA, `${label}: lane A did not spawn (${JSON.stringify(spA).slice(0, 200)})`);
      started.push(laneA);
      await until(async () => (await lanes()).find((l) => l.id === laneA)?.status, (s) => s && s !== "starting", 60_000, `${label}: lane A never became ready`);
      await page.evaluate((id, t) => { void fetch("/api/fleet/prompt", { method: "POST", headers: { "content-type": "application/json", "x-lucid-token": t }, body: JSON.stringify({ laneId: id, text: "[script release-notes] Write the release notes and changelog" }) }).then((r) => r.text()).catch(() => {}); }, laneA, token);
      await until(() => page.$eval(tileSel(idA), (n) => n.classList.contains("work")).catch(() => false), Boolean, 20_000, `${label}: A's box never showed its agent working`);
      const rail = {};
      for (const side of ["open", "collapsed"]) {
        const collapsed = await page.$eval("#app-inner", (n) => n.classList.contains("sidebar-collapsed"));
        if ((side === "collapsed") !== collapsed) { await clickReal("#sideToggle", `${label}: the sessions sidebar toggle`); await pause(500); }
        await awayFromRail(size);
        const a = await seenOpacity(tileSel(idA)), b = await seenOpacity(tileSel(idB));
        assert(a === 1, `${label} (sidebar ${side}): the working Agent is dimmed to ${a}`);
        assert(Math.abs(b - 0.55) <= 0.03, `${label} (sidebar ${side}): the idle Agent rests at ${b}, not .55`);
        const tb = await box(tileSel(idB));
        await page.mouse.move(tb.x, tb.y);
        await pause(450);
        const bh = await seenOpacity(tileSel(idB));
        assert(bh === 1, `${label} (sidebar ${side}): hovering the rail leaves the idle Agent at ${bh}`);
        rail[side] = { working: a, idle: b, idleHover: bh };
      }
      await clickReal("#sideToggle", `${label}: the sessions sidebar toggle (back)`);
      await awayFromRail(size);
      entry.rail = rail;
      await api("/api/fleet/stop", { laneId: laneA }).catch(() => {});

      // 2. lane: Activate > Start new Fleet session on B
      const before = new Set((await lanes()).map((l) => l.id));
      await activate(idB, "fleet", label);
      const lb = await until(async () => (await lanes()).find((l) => !before.has(l.id) && norm(l.cwd) === idB) ?? null, Boolean, 30_000, `${label}: no lane started in B`);
      started.push(lb.id);
      const laneHost = `.spw-host[data-spw-surface="lane"][data-spw-key="lane:${lb.id}"]`;
      await until(() => page.$(laneHost), Boolean, 15_000, `${label}: the starting lane's card shows no walker`, 100);
      const buddyHidden = await page.evaluate((id) => { const b = document.querySelector(`.abd[data-abd-lane="${id}"]`); return !b || !!b.closest("[hidden]"); }, lb.id);
      assert(buddyHidden, `${label}: the lane's buddy shows next to its walker`);
      const card = `.fleet-card[data-lane="${lb.id}"]`;
      const laneWatch = await watchWalker(laneHost, `${label} lane`, { surfaceEl: `${card} .fleet-card-main`, feetOn: `${card} .fleet-compose` });
      assert(laneWatch.lines.length >= 2, `${label}: the lane bubble did not cycle its lines (${JSON.stringify(laneWatch.lines)})`);
      assert(laneWatch.lines.some((t) => /getting ready for some work/.test(t)), `${label}: the lane bubble never said it is getting ready (${JSON.stringify(laneWatch.lines)})`);
      assert(laneWatch.moved >= 4, `${label}: the walker did not walk (${laneWatch.moved}px)`);
      assert(/is ready/.test(laneWatch.ready), `${label}: no ready line before the walker left (${laneWatch.ready})`);
      const ready = (await lanes()).find((l) => l.id === lb.id)?.status;
      assert(ready && ready !== "starting", `${label}: the walker left while the lane is still ${ready}`);
      entry.lane = laneWatch;
      await dismissToasts();

      // 3. Worlds: Activate > Agent World session on B
      const before2 = new Set((await lanes()).map((l) => l.id));
      await activate(idB, "world", label);
      const lw = await until(async () => (await lanes()).find((l) => !before2.has(l.id) && norm(l.cwd) === idB) ?? null, Boolean, 30_000, `${label}: no world lane started in B`);
      started.push(lw.id);
      await until(vizShown, Boolean, 10_000, `${label}: Agent Worlds did not open`);
      const worldHost = `#vizView .spw-host[data-spw-surface="world"][data-spw-key="world:${lw.id}"]`;
      await until(() => page.$(worldHost), Boolean, 15_000, `${label}: Agent Worlds shows no walker for the starting lane`, 100);
      const worldWatch = await watchWalker(worldHost, `${label} world`, { surfaceEl: "#vizView [data-viz-stage]" });
      assert(worldWatch.lines.length >= 1 && /is ready/.test(worldWatch.ready), `${label}: the world walker did not show its lines and ready line (${JSON.stringify(worldWatch)})`);
      entry.world = worldWatch;
      await closeViz();

      // 4. Main: a reload starts Main's agent again
      await page.reload({ waitUntil: "domcontentloaded" });
      const mainHost = '.spw-host[data-spw-surface="main"]';
      await until(() => page.$(mainHost), Boolean, 15_000, `${label}: no walker on the composer while Main starts`, 100);
      await page.waitForSelector("#input", { visible: true, timeout: 30_000 });
      const inputClear = await page.evaluate(() => { const i = document.querySelector("#input"); const r = i.getBoundingClientRect(); return i.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); });
      assert(inputClear, `${label}: the Main walker covers the composer input`);
      const mainWatch = await watchWalker(mainHost, `${label} main`, { feetOn: ".composer-wrap" });
      assert(mainWatch.lines.some((t) => /sample-platform/i.test(t)), `${label}: the Main bubble does not name Main's folder (${JSON.stringify(mainWatch.lines)})`);
      assert(/is ready/.test(mainWatch.ready), `${label}: no ready line on the composer (${mainWatch.ready})`);
      entry.main = mainWatch;

      for (const id of started.splice(0)) await api("/api/fleet/stop", { laneId: id }).catch(() => {});
      results.sizes.push(entry);
    }
    assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  } catch (e) {
    if (process.env.LUCID_DEMO_SHOTS) await page.screenshot({ path: `${process.env.LUCID_DEMO_SHOTS}/spinup-demo-fail.png` }).catch(() => {});
    throw e;
  } finally {
    for (const id of started) await api("/api/fleet/stop", { laneId: id }).catch(() => {});
    await page.evaluate((k, v) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }, PERF_KEY, perfBefore).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_spinup_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifySpinup(page), null, 2));
    console.log("P-SPINUP.1 passed: a working Agent stays bright on the rail (sidebar open and collapsed), and a starting lane, World lane and Main each show a walking mini Lucid with a cycling status bubble that names the Agent, ends on a ready line and leaves, wide and narrow.");
  } finally { await browser.disconnect(); }
}
