// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_rail_agents_1.mjs
//
// P-RAIL.AGENTS1: real-browser proof of the rail's Agents view (agents_rail.ts), driven with real mouse and keyboard
// input against an isolated QA engine. Forty folders are created under the QA workspace dir and seeded as saved
// Agents (`lucid.agents.v1`); Main's own folder joins as an auto Agent. In a wide (1600x1000) and a narrow (1100x800)
// window:
//   1. the mini Lucid toggle (#railAgents, right of the expand button) is topmost at its center and flips the rail
//      Metrics -> Agents -> Metrics -> Agents; the choice persists in lucid.rail.view; the Agents view is opaque;
//   2. the list order is Main's folder first, then the seeded order; equal basenames get parent hints (alpha/api,
//      beta/api); every name is one ellipsized line inside its box;
//   3. one click on the thin down arrow scrolls by 3 Agents, a double-click by a full page; the up arrow shows once
//      scrolled and is hidden at the top; the wheel still scrolls;
//   4. a real mouse drag reorders (the box follows the pointer and neighbors look at it mid-drag); after the drop the
//      boxes it passed and landed between have data-eyes up/down, the moved one data-eyes="around", all cleared after
//      about 2 s; Alt+ArrowUp moves the focused Agent; the order survives a reload;
//   5. the hover module opens on a 140 ms hover (Activate collapsed) and on a click (Activate expanded), sits left of
//      the rail fully on screen, every control is topmost at its center, auditBoxes passes on it, Esc closes it and
//      focus returns to the box;
//   6. auditBoxes passes on the rail.
// Once (wide): a swatch recolors the box live and persists; Rename persists across a reload; Remove needs the second
// explicit confirm (Cancel keeps it), then a toast's Undo restores it at its place, and a removed auto Agent stays
// hidden across sync ticks; a lane working in an Agent's folder makes it type, the lane's turn end plays the ring
// (.changed); Activate > Start new Fleet session yields a new lane with that folder as cwd (activateAgentFolder).
//
// Setup (an isolated QA engine and browser, never a user's session):
//   bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811
//   open http://127.0.0.1:7811/ in the QA browser (remote debugging on), past the first-run gates, Main idle.
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_rail_agents_1.mjs
// The QA root defaults to <tmp>/lucid-qa-fleet-<port> (from fleet.json); LUCID_DEMO_QA_ROOT overrides it.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const AGENTS_KEY = "lucid.agents.v1";
const VIEW_KEY = "lucid.rail.view";
const SEEDED = 40;

const norm = (p) => { const s = String(p).trim().replace(/[\\/]+/g, "/"); return (s.length > 1 ? s.replace(/\/$/, "") : s).toLowerCase(); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function verifyRailAgents(page, opts = {}) {
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const base = new URL(page.url()).origin + "/";
  const port = new URL(base).port;
  const fleet = JSON.parse(readFileSync(join(opts.qaRoot ?? process.env.LUCID_DEMO_QA_ROOT ?? join(tmpdir(), `lucid-qa-fleet-${port}`), "fleet.json"), "utf8"));
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content);
  const headers = { "x-lucid-token": token, "content-type": "application/json" };
  const api = async (path, body) => {
    const res = await fetch(new URL(path, base), body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    const j = await res.json();
    return j?.data ?? j;
  };
  const results = [];
  const spawned = [];

  // ── folders on disk + the seeded doc ──
  const root = join(fleet.root ?? join(fleet.workspace, "..", ".."), "workspace", "agents");
  const folders = [];
  for (let i = 1; i <= SEEDED - 2; i++) folders.push(join(root, `rail-agent-${String(i).padStart(2, "0")}`));
  folders.splice(4, 0, join(root, "alpha", "api"), join(root, "beta", "api"));
  for (const f of folders) mkdirSync(f, { recursive: true });
  const seeded = folders.map((path) => ({ id: norm(path), path, name: null, theme: "lucid", hue: 145, saved: true }));
  const doc = { v: 1, agents: seeded, hidden: [], manual: false, main: null };
  const mainId = norm(fleet.workspace);

  // ── page helpers ──
  const ids = () => page.$$eval(".agr-tile[data-agent]", (ts) => ts.map((t) => t.dataset.agent));
  const stored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), AGENTS_KEY);
  const tileRect = (id) => page.evaluate((id) => {
    const t = [...document.querySelectorAll(".agr-tile[data-agent]")].find((n) => n.dataset.agent === id);
    if (!t) return null;
    t.scrollIntoView({ block: "nearest" });
    const b = t.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width };
  }, id);
  // Runs `fn(tile)` in the page on the Agent's box (null when absent); callFunctionOn, so the page's CSP never matters.
  const tileDo = async (id, fn) => {
    const h = await page.evaluateHandle((id) => [...document.querySelectorAll(".agr-tile[data-agent]")].find((n) => n.dataset.agent === id) ?? null, id);
    try { return await h.evaluate(fn); } finally { await h.dispose(); }
  };
  const labelOf = (id) => tileDo(id, (t) => t?.querySelector(".l")?.textContent ?? null);
  const accentOf = (id) => tileDo(id, (t) => t?.style.getPropertyValue("--G").trim() ?? null);
  const topmost = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return b.width > 0 && n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
  const center = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width }; });
  const clickReal = async (sel, what, clickOpts) => {
    const c = await center(sel);
    assert(c.w > 0, `${what} is not visible`);
    assert(await topmost(sel), `${what} is covered (elementFromPoint at its center hits something else)`);
    await page.mouse.click(c.x, c.y, clickOpts);
  };
  const clickTile = async (id, what) => {
    const r = await tileRect(id);
    assert(r, `${what}: no box for ${id}`);
    await pause(150);
    const hit = await page.evaluate((x, y, id) => document.elementFromPoint(x, y)?.closest(".agr-tile")?.dataset.agent === id, r.x, r.y, id);
    assert(hit, `${what}: the box is covered at its center`);
    await page.mouse.click(r.x, r.y);
  };
  const popOpen = () => page.evaluate(() => !!document.querySelector(".agr-pop.show"));
  const audit = async (sel, where) => {
    const found = await page.evaluate(auditBoxes, sel, MIN_GAP);
    assert(found.length === 0, `${where} spacing: ${found.join("; ")}`);
  };
  const awayFromRail = async () => { const v = await page.evaluate(() => ({ w: innerWidth, h: innerHeight })); await page.mouse.move(Math.round(v.w * 0.4), Math.round(v.h * 0.5)); };
  // Close every toast: its X, else a "Not now" style action (the seasonal theme suggestion has no timeout).
  const dismissToasts = async () => {
    await page.evaluate(() => {
      for (const t of document.querySelectorAll("#toasts .toast")) {
        const btns = [...t.querySelectorAll("button")];
        const x = t.querySelector(".h button, .toast-x, [aria-label='close' i], [aria-label='dismiss' i]") ?? btns.find((b) => /^(Not now|Got it|Dismiss|OK|Close)$/i.test(b.textContent.trim()));
        x?.click();
      }
    });
    await pause(300);
  };
  const closePop = async () => { if (await popOpen()) { await page.keyboard.press("Escape"); await pause(250); } };
  const waitFor = (fn, arg, ms, msg) => page.waitForFunction(fn, { timeout: ms }, arg).catch(() => { throw new Error(msg); });
  const ensureAgentsRail = async (label) => {
    await page.waitForSelector("#railAgents", { timeout: 20000 });
    if (!(await page.$eval("#inspector", (n) => n.classList.contains("rail")))) { await page.click("#inspCollapse"); await pause(400); }
    if ((await page.$eval("#railAgents", (b) => b.getAttribute("aria-pressed"))) !== "true") await clickReal("#railAgents", `${label}: the toggle`);
    await waitFor((n) => document.querySelectorAll(".agr-tile[data-agent]").length >= n, SEEDED, 15000, `${label}: the Agents list did not render ${SEEDED} Agents`);
    await pause(300);
  };
  const reload = async (label) => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await ensureAgentsRail(`${label} (after reload)`);
  };
  const scrollTop0 = async () => { await page.$eval("[data-agr-list]", (l) => { l.scrollTop = 0; }); await pause(250); };

  const cdp = await page.target().createCDPSession();
  try {
    // Seed and start on Metrics, so the toggle is proven both ways from a known state.
    await page.evaluate((k, v, d, vk) => { localStorage.setItem(k, JSON.stringify(d)); localStorage.setItem(vk, v); }, AGENTS_KEY, "metrics", doc, VIEW_KEY);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#railAgents", { timeout: 20000 });

    for (const [si, size] of SIZES.entries()) {
      const label = `${size.name} ${size.width}x${size.height}`;
      const entry = { size: label };
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      await pause(600);
      await dismissToasts();
      if (!(await page.$eval("#inspector", (n) => n.classList.contains("rail")))) { await page.click("#inspCollapse"); await pause(400); }

      // 1. the toggle, both ways
      const pressed = () => page.$eval("#railAgents", (b) => b.getAttribute("aria-pressed"));
      if ((await pressed()) === "true") { await clickReal("#railAgents", `${label}: the toggle`); await pause(300); }
      // the rail animates its width when it collapses or a view changes: read the header once it has settled
      let sides = null;
      for (let i = 0; i < 20; i++) {
        const now = await page.evaluate(() => { const t = document.querySelector("#railAgents").getBoundingClientRect(), e = document.querySelector("#railExpand").getBoundingClientRect(); return { t: { left: t.left, top: t.top, bottom: t.bottom }, e: { right: e.right, top: e.top, bottom: e.bottom } }; });
        if (sides && JSON.stringify(sides) === JSON.stringify(now)) break;
        sides = now;
        await pause(100);
      }
      assert(sides.t.left >= sides.e.right && Math.abs((sides.t.top + sides.t.bottom) - (sides.e.top + sides.e.bottom)) < 4, `${label}: the toggle is not right of the expand button`);
      await clickReal("#railAgents", `${label}: the toggle (to Agents)`);
      await pause(400);
      let st = await page.evaluate((vk) => ({ view: localStorage.getItem(vk), cls: document.querySelector("#inspector").classList.contains("agents-view"), pressed: document.querySelector("#railAgents").getAttribute("aria-pressed"), op: getComputedStyle(document.querySelector("#inspector")).opacity, tiles: getComputedStyle(document.querySelector("#railTiles")).display }), VIEW_KEY);
      assert(st.view === "agents" && st.cls && st.pressed === "true" && st.tiles === "none", `${label}: the toggle did not switch to Agents ${JSON.stringify(st)}`);
      assert(Number(st.op) === 1, `${label}: the Agents view is not at full opacity (${st.op})`);
      await clickReal("#railAgents", `${label}: the toggle (to Metrics)`);
      await pause(400);
      st = await page.evaluate((vk) => ({ view: localStorage.getItem(vk), cls: document.querySelector("#inspector").classList.contains("agents-view"), list: document.querySelector("#railAgentsView").hidden, tiles: getComputedStyle(document.querySelector("#railTiles")).display }), VIEW_KEY);
      assert(st.view === "metrics" && !st.cls && st.list && st.tiles !== "none", `${label}: the toggle did not switch back to Metrics ${JSON.stringify(st)}`);
      await clickReal("#railAgents", `${label}: the toggle (to Agents again)`);
      await waitFor((n) => document.querySelectorAll(".agr-tile[data-agent]").length >= n, SEEDED, 15000, `${label}: the Agents list did not render`);
      await awayFromRail();
      await pause(500);
      entry.toggle = "Metrics -> Agents -> Metrics -> Agents, persisted";

      // 2. order + autonames
      if (si === 0) {
        const order = await ids();
        const seededIds = seeded.map((a) => a.id);
        const onlySeeded = order.filter((id) => seededIds.includes(id));
        assert(JSON.stringify(onlySeeded) === JSON.stringify(seededIds), `${label}: seeded order not kept: ${onlySeeded.slice(0, 6).join(", ")}...`);
        const mi = order.indexOf(mainId);
        assert(mi >= 0 && mi < order.indexOf(seededIds[0]), `${label}: Main's folder (${mainId}) is not above the saved Agents (index ${mi})`);
        const names = await page.evaluate((a, b) => {
          const lab = (id) => [...document.querySelectorAll(".agr-tile[data-agent]")].find((n) => n.dataset.agent === id)?.querySelector(".l");
          return { a: lab(a)?.textContent, b: lab(b)?.textContent };
        }, norm(folders[4]), norm(folders[5]));
        assert(names.a === "alpha/api" && names.b === "beta/api", `${label}: duplicate basenames not hinted: ${JSON.stringify(names)}`);
        entry.order = `Main's folder at ${mi}, then the ${SEEDED} seeded Agents in order; alpha/api + beta/api`;
      }
      const lines = await page.$$eval(".agr-tile .l", (ls) => ls.filter((l) => l.getBoundingClientRect().height > 0).map((l) => {
        const s = getComputedStyle(l), t = l.closest(".agr-tile").getBoundingClientRect(), b = l.getBoundingClientRect();
        return { ok: s.whiteSpace === "nowrap" && s.textOverflow === "ellipsis" && b.height < 14 && b.right <= t.right + 0.5 && b.left >= t.left - 0.5, text: l.textContent };
      }));
      const bad = lines.filter((l) => !l.ok);
      assert(bad.length === 0, `${label}: names not single-line ellipsized inside their box: ${bad.map((l) => l.text).join(", ")}`);
      const tileSize = await page.evaluate(() => {
        const a = document.querySelector(".agr-tile[data-agent]").getBoundingClientRect();
        return { w: Math.round(a.width), h: Math.round(a.height) };
      });
      entry.box = `${tileSize.w}x${tileSize.h}`;

      // 3. arrows: 3 per click, a page per double-click, the wheel
      await scrollTop0();
      const arrows = () => page.evaluate(() => ({ up: document.querySelector("[data-agr-up]").classList.contains("agr-on"), down: document.querySelector("[data-agr-down]").classList.contains("agr-on") }));
      let ar = await arrows();
      assert(!ar.up && ar.down, `${label}: at the top the arrows should be down only ${JSON.stringify(ar)}`);
      const geo = () => page.$eval("[data-agr-list]", (l) => {
        const ts = l.querySelectorAll(".agr-tile");
        const pitch = ts[1].offsetTop - ts[0].offsetTop;
        return { top: l.scrollTop, vp: l.clientHeight, content: l.scrollHeight, pitch, gap: pitch - ts[0].offsetHeight };
      });
      let g = await geo();
      await clickReal("[data-agr-down]", `${label}: the down arrow`);
      await pause(900);
      let after = await geo();
      const want3 = Math.min(3 * g.pitch, g.content - g.vp);
      assert(Math.abs(after.top - want3) <= 2, `${label}: one click scrolled to ${after.top}, expected ${want3} (3 Agents of ${g.pitch}px)`);
      ar = await arrows();
      assert(ar.up, `${label}: the up arrow did not appear once scrolled`);
      g = after;
      await clickReal("[data-agr-down]", `${label}: the down arrow (double-click)`, { count: 2, clickCount: 2, delay: 40 });
      await pause(1100);
      after = await geo();
      const per = Math.max(1, Math.floor((g.vp + g.gap) / g.pitch));
      const wantPage = Math.min((Math.round(g.top / g.pitch) + per) * g.pitch, g.content - g.vp);
      assert(Math.abs(after.top - wantPage) <= 2, `${label}: a double-click scrolled to ${after.top}, expected the next page at ${wantPage} (${per} Agents)`);
      await scrollTop0();
      const lr = await page.$eval("[data-agr-list]", (l) => { const b = l.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
      await page.mouse.move(lr.x, lr.y);
      await page.mouse.wheel({ deltaY: 240 });
      await pause(500);
      assert((await geo()).top > 0, `${label}: the wheel did not scroll the Agents`);
      await scrollTop0();
      await awayFromRail();
      entry.scroll = `click ${want3}px (3 x ${g.pitch}), double-click to ${wantPage}px (${per} per page), wheel ok`;

      // 4. drag reorder + eyes + keyboard + persistence
      const before = await ids();
      const moved = before[1], target = before[4];
      const from = await tileRect(moved), to = await tileRect(target);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      const steps = 14;
      let midEyes = false;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(from.x, from.y + ((to.y + 8 - from.y) * i) / steps);
        await pause(18);
        if (i === Math.round(steps * 0.6)) {
          midEyes = await page.evaluate((m) => [...document.querySelectorAll(".agr-tile[data-agent]")].some((t) => t.dataset.agent !== m && (t.dataset.eyes === "up" || t.dataset.eyes === "down")), moved);
          const follows = await tileDo(moved, (t) => !!t && t.classList.contains("agr-dragging") && /translateY/.test(t.style.transform));
          assert(follows, `${label}: the dragged box does not follow the pointer`);
        }
      }
      await page.mouse.up();
      await awayFromRail();
      await pause(120);
      assert(midEyes, `${label}: no neighbor looked at the box while it moved`);
      const expect = before.filter((id) => id !== moved);
      expect.splice(4, 0, moved);
      const now = await ids();
      assert(JSON.stringify(now) === JSON.stringify(expect), `${label}: the drag did not reorder: ${now.slice(0, 6).join(", ")}`);
      const eyes = await page.evaluate((list) => Object.fromEntries(list.map((id) => [id, [...document.querySelectorAll(".agr-tile[data-agent]")].find((n) => n.dataset.agent === id)?.dataset.eyes ?? null])), [before[2], before[3], before[4], before[5], moved]);
      assert(eyes[before[2]] === "down" && eyes[before[3]] === "down" && eyes[before[4]] === "down", `${label}: the boxes passed over do not look down at the moved one ${JSON.stringify(eyes)}`);
      assert(eyes[before[5]] === "up", `${label}: the box below the drop does not look up ${JSON.stringify(eyes)}`);
      assert(eyes[moved] === "around", `${label}: the moved box does not look around ${JSON.stringify(eyes)}`);
      await pause(2300);
      const left = await page.$$eval(".agr-tile[data-eyes]", (ts) => ts.length);
      assert(left === 0, `${label}: ${left} boxes still have data-eyes after 2 s`);
      const saved = await stored();
      assert(saved.manual && JSON.stringify(saved.agents.map((a) => a.id)) === JSON.stringify(expect), `${label}: the dragged order is not persisted`);
      // keyboard: the moved box keeps focus; Alt+ArrowUp lifts it one place
      await tileDo(moved, (t) => t?.focus());
      await page.keyboard.down("Alt"); await page.keyboard.press("ArrowUp"); await page.keyboard.up("Alt");
      await pause(300);
      const kb = await ids();
      assert(kb.indexOf(moved) === 3, `${label}: Alt+ArrowUp did not move the focused Agent up (index ${kb.indexOf(moved)})`);
      await pause(2200);
      entry.drag = `moved ${moved.split("/").pop()} from 1 to 4 (neighbors looked, it looked around), Alt+ArrowUp to 3`;

      // 5. the hover module: hover intent, click, placement, topmost, audit, Esc
      const hovered = (await ids())[5];
      const hr = await tileRect(hovered);
      await page.mouse.move(hr.x, hr.y);
      await pause(450);
      const hov = await page.evaluate(() => ({ open: !!document.querySelector(".agr-pop.show"), exp: document.querySelector('.agr-pop [data-act="activate"]')?.getAttribute("aria-expanded") }));
      assert(hov.open && hov.exp === "false", `${label}: hovering did not open the module collapsed ${JSON.stringify(hov)}`);
      await awayFromRail();
      await pause(700);
      assert(!(await popOpen()), `${label}: the module did not close after the hover grace`);
      const opened = (await ids())[2];
      await dismissToasts(); // feature announcements land top-right, over where the module opens
      await clickTile(opened, `${label}: the Agent box`);
      await page.waitForSelector(".agr-pop.show", { timeout: 3000 });
      await pause(350);
      const place = await page.evaluate((id) => {
        const p = document.querySelector(".agr-pop").getBoundingClientRect();
        const t = [...document.querySelectorAll(".agr-tile[data-agent]")].find((n) => n.dataset.agent === id).getBoundingClientRect();
        return { p: { left: p.left, right: p.right, top: p.top, bottom: p.bottom }, tileLeft: t.left, vw: innerWidth, vh: innerHeight, exp: document.querySelector('.agr-pop [data-act="activate"]').getAttribute("aria-expanded"), gos: document.querySelectorAll(".agr-pop .agr-sub.open [data-go]").length };
      }, opened);
      assert(place.exp === "true" && place.gos === 3, `${label}: a click did not open the module with Activate expanded`);
      assert(place.p.left >= 0 && place.p.top >= 0 && place.p.right <= place.vw && place.p.bottom <= place.vh, `${label}: the module is off screen ${JSON.stringify(place.p)}`);
      assert(place.p.right <= place.tileLeft, `${label}: the module is not left of the rail`);
      for (const sel of ['.agr-pop [data-sw="lucid"]', '.agr-pop [data-sw="stealth"]', ".agr-pop [data-agr-hue]", '.agr-pop [data-act="rename"]', '.agr-pop [data-act="activate"]',
        '.agr-pop [data-go="takeover"]', '.agr-pop [data-go="fleet"]', '.agr-pop [data-go="world"]', '.agr-pop [data-act="remove"]']) {
        assert(await topmost(sel), `${label}: ${sel} is covered inside the module`);
      }
      await audit(".agr-pop", `${label} hover module`);
      await page.keyboard.press("Escape");
      await pause(300);
      const esc = await page.evaluate((id) => ({ open: !!document.querySelector(".agr-pop.show"), focus: document.activeElement?.dataset?.agent === id }), opened);
      assert(!esc.open && esc.focus, `${label}: Esc did not close the module and return focus to its box ${JSON.stringify(esc)}`);
      entry.module = `left of the rail at ${Math.round(place.p.left)},${Math.round(place.p.top)}, 9 controls topmost`;

      // 6. the rail's spacing, at rest
      await awayFromRail();
      await scrollTop0();
      await pause(400);
      await audit("#metricsRail", `${label} Agents rail`);

      if (si === 0) {
        // recolor via a swatch (live + persisted)
        const recolor = (await ids())[6];
        await clickTile(recolor, `${label}: the box to recolor`);
        await page.waitForSelector(".agr-pop.show", { timeout: 3000 });
        await pause(300);
        await clickReal('.agr-pop [data-sw="ember"]', `${label}: the Ember swatch`);
        await pause(200);
        const g1 = await accentOf(recolor);
        assert(g1 === "#ff9354", `${label}: the swatch did not recolor the box (--G ${g1})`);
        assert((await stored()).agents.find((a) => a.id === recolor)?.theme === "ember", `${label}: the color is not persisted`);
        await closePop();
        // rename (Enter saves)
        const renamed = (await ids())[7];
        await clickTile(renamed, `${label}: the box to rename`);
        await page.waitForSelector(".agr-pop.show", { timeout: 3000 });
        await pause(300);
        await clickReal('.agr-pop [data-act="rename"]', `${label}: Rename`);
        await page.waitForSelector(".agr-pop .agr-ph-name-in", { timeout: 2000 });
        await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
        await page.keyboard.type("QA Renamed");
        await page.keyboard.press("Enter");
        await pause(250);
        assert((await labelOf(renamed)) === "QA Renamed", `${label}: Rename did not update the box`);
        await closePop();
        const orderBefore = await ids();
        await reload(label);
        assert(JSON.stringify(await ids()) === JSON.stringify(orderBefore), `${label}: the order did not survive a reload`);
        assert((await labelOf(renamed)) === "QA Renamed", `${label}: Rename did not persist across a reload`);
        assert((await accentOf(recolor)) === "#ff9354", `${label}: the color did not persist across a reload`);
        entry.edit = "Ember swatch recolored live; Rename and order persisted across a reload";

        // remove: second explicit confirm, Cancel keeps it, Undo restores, a removed auto Agent stays hidden
        await dismissToasts();
        const at = (await ids()).indexOf(mainId);
        await clickTile(mainId, `${label}: Main's folder Agent`);
        await page.waitForSelector(".agr-pop.show", { timeout: 3000 });
        await pause(300);
        await clickReal('.agr-pop [data-act="remove"]', `${label}: Remove from rail`);
        await pause(150);
        assert(await page.$('.agr-pop [data-act="remove-yes"]') && await page.$('.agr-pop [data-act="remove-no"]'), `${label}: Remove did not ask to confirm`);
        assert((await ids()).includes(mainId), `${label}: the first Remove click already removed the Agent`);
        await audit(".agr-pop", `${label} hover module (confirm)`);
        await clickReal('.agr-pop [data-act="remove-no"]', `${label}: Cancel`);
        await pause(150);
        assert(await page.$('.agr-pop [data-act="remove"]') && (await ids()).includes(mainId), `${label}: Cancel did not keep the Agent`);
        await clickReal('.agr-pop [data-act="remove"]', `${label}: Remove from rail (again)`);
        await pause(150);
        await clickReal('.agr-pop [data-act="remove-yes"]', `${label}: Yes`);
        await pause(300);
        assert(!(await ids()).includes(mainId), `${label}: Yes did not remove the Agent`);
        await pause(2600); // two sync ticks: Main's folder is still a source, and must not come back
        assert(!(await ids()).includes(mainId) && (await stored()).hidden.includes(mainId), `${label}: the removed auto Agent came back`);
        const undo = await page.evaluateHandle(() => [...document.querySelectorAll("#toasts .toast .btn-mini")].find((b) => b.textContent.trim() === "Undo") ?? null);
        assert(await undo.evaluate((b) => !!b), `${label}: no Undo toast after Remove`);
        await undo.evaluate((b) => { b.dataset.qaUndo = "1"; });
        await clickReal('#toasts [data-qa-undo="1"]', `${label}: Undo`);
        await pause(300);
        const back = await ids();
        assert(back.indexOf(mainId) === at && !(await stored()).hidden.includes(mainId), `${label}: Undo did not restore the Agent at index ${at} (now ${back.indexOf(mainId)})`);
        entry.remove = "confirm required, Cancel kept it, hidden across ticks, Undo restored it in place";
        await dismissToasts();
      }
      results.push(entry);
    }

    // ── once, back in the wide window: a lane makes an Agent type, its turn end rings, Activate starts a lane ──
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 0, mobile: false });
    await pause(500);
    const laneEntry = { size: "wide (lanes)" };
    for (const f of [folders[10], folders[12]]) spawnSync("git", ["init", "-q"], { cwd: f });
    const typer = norm(folders[10]);
    await page.$eval("[data-agr-list]", (l) => {
      window.__agrRings = [];
      new MutationObserver((ms) => { for (const m of ms) { const t = m.target; if (t.classList?.contains("changed") && t.dataset?.agent) window.__agrRings.push(t.dataset.agent); } })
        .observe(l, { subtree: true, attributes: true, attributeFilter: ["class"] });
    });
    const sp = await api("/api/fleet/spawn", { cwd: folders[10], name: "Rail QA" });
    assert(sp?.ok && sp.lane?.id, `lane spawn refused: ${sp?.reason ?? JSON.stringify(sp)}`);
    const laneId = sp.lane.id;
    spawned.push(laneId);
    await pause(1500);
    const streamDone = fetch(new URL("/api/fleet/prompt", base), { method: "POST", headers, body: JSON.stringify({ laneId, text: "[script release-notes] Write the release notes" }) })
      .then(async (r) => { const rd = r.body?.getReader(); if (rd) for (;;) { const { done } = await rd.read(); if (done) break; } }).catch(() => {});
    const typing = await page.waitForFunction((id) => [...document.querySelectorAll(".agr-tile[data-agent]")].find((n) => n.dataset.agent === id)?.dataset.state === "work", { timeout: 25000, polling: 250 }, typer).then(() => true).catch(() => false);
    assert(typing, "the Agent did not type while a lane worked in its folder");
    await page.evaluate((id) => [...document.querySelectorAll(".agr-tile[data-agent]")].find((n) => n.dataset.agent === id)?.scrollIntoView({ block: "nearest" }), typer);
    await pause(3000); // at least one rail fleet poll sees the lane busy
    await api("/api/fleet/cancel", { laneId });
    let rang = await page.waitForFunction((id) => window.__agrRings.includes(id), { timeout: 15000, polling: 200 }, typer).then(() => true).catch(() => false);
    if (!rang) {
      // The cancel did not end the turn: let it finish, answering its one approval ask.
      for (const deadline = Date.now() + 150000; !rang && Date.now() < deadline;) {
        const s = await api("/api/fleet/status").catch(() => null);
        const l = s?.lanes?.find((x) => x.id === laneId);
        if (l?.status === "needs-approval") await api("/api/fleet/answer", { laneId, allow: true, scope: "session" });
        rang = await page.evaluate((id) => window.__agrRings.includes(id), typer);
        await pause(1000);
      }
    }
    assert(rang, "the lane's turn end did not play the ring on its Agent");
    const idle = await page.waitForFunction((id) => [...document.querySelectorAll(".agr-tile[data-agent]")].find((n) => n.dataset.agent === id)?.dataset.state === "idle", { timeout: 10000 }, typer).then(() => true).catch(() => false);
    assert(idle, "the Agent kept typing after its lane went idle");
    void streamDone;
    laneEntry.working = "typing while the lane worked, ring on its turn end, meditating after";

    // Activate > Start new Fleet session
    await dismissToasts();
    const act = norm(folders[12]);
    const lanesBefore = new Set(((await api("/api/fleet/status"))?.lanes ?? []).map((l) => l.id));
    await clickTile(act, "the Agent to activate");
    await page.waitForSelector('.agr-pop.show [data-go="fleet"]', { visible: true, timeout: 3000 });
    await pause(300);
    await clickReal('.agr-pop [data-go="fleet"]', "Activate > Start new Fleet session");
    let newLane = null;
    for (const deadline = Date.now() + 25000; !newLane && Date.now() < deadline;) {
      await pause(700);
      const s = await api("/api/fleet/status").catch(() => null);
      newLane = s?.lanes?.find((l) => !lanesBefore.has(l.id) && norm(l.cwd) === act) ?? null;
    }
    if (newLane) spawned.push(newLane.id);
    const msg = await page.evaluate(() => document.querySelector(".agr-pop [data-ap-msg]")?.textContent ?? "");
    assert(newLane, `Start new Fleet session did not start a lane in ${act}${msg ? ` (module says: ${msg})` : ""}`);
    laneEntry.activate = `lane ${newLane.id} started in ${newLane.cwd}`;
    results.push(laneEntry);
  } finally {
    for (const id of spawned) await api("/api/fleet/stop", { laneId: id }).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_rail_agents_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyRailAgents(page), null, 2));
    console.log("P-RAIL.AGENTS1 passed: the toggle flips Metrics and Agents, the list orders and names folders, arrows step 3 and a page, drag reorders with the neighbors noticing and persists, the hover module is on screen with topmost controls, recolor, rename and remove with Undo work, a working lane types and its turn end rings, and Activate starts a lane, wide and narrow.");
  } finally { await browser.disconnect(); }
}
