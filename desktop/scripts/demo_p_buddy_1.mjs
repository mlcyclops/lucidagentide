// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_buddy_1.mjs
//
// P-BUDDY.1: real-browser proof of the floating Agent buddies (agent_buddy.ts), their ideas (POST /api/buddy/suggest,
// agent_buddy_service.ts) and the Ask Lucid restyle, driven with real mouse input against an isolated QA engine.
// In a wide (1600x1000) and a narrow (1100x800) window:
//   1. Main's buddy (with its name under it, unframed, on one line) sits on the upper-left corner of the composer,
//      topmost at its center, and covers none of the composer's controls; it holds still (P-BUDDY.2: no drift), has
//      its color glow, and hovering it shows the app's hover helper (name, what it is doing, what a click does), not
//      a browser tooltip;
//   2. a real drag moves it, the spot persists across a reload, a double-click puts it back;
//   3. with no conversation yet there is nothing to suggest: a click pops nothing up, a chip says so;
//   4. a Fleet lane in the workspace (its first turn is the scripted 'buddy-ideas' reply) gets its own buddy on the
//      upper-left corner of its card's composer; after the turn ends the buddy fetches ideas on its own (the chip or
//      badge shows); a click opens them (on screen, controls topmost, auditBoxes clean); "Ask Lucid" opens the Ask
//      Lucid fly-out prefilled with the idea, showing the boxless Lucid figure in the Agents style; "Run in parallel
//      worktree" (wide) starts a worktree lane;
//   5. Agent Worlds shows a buddy for the lane's node;
//   6. Settings > Floating Agents > Show floating Agents hides every buddy and brings them back.
// The idea model is the QA engine's scripted fake agent: desktop/scripts/fleet_demo/scripts/09_buddy_ideas.json
// answers the buddy prompt with fixed JSON, so the run is deterministic. Every lane started is stopped.
//
// Setup (an isolated QA engine and browser, never a user's session):
//   bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811
//   open http://127.0.0.1:7811/ in the QA browser (remote debugging on), past the first-run gates, Main idle.
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_buddy_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const POS_KEY = "lucid.buddies.v1";
const SET_KEY = "lucid.buddies.settings.v1";
const PERF_KEY = "lucid.perfMode";
const CAM_KEY = "lucid.viz.autoCamera";
const MAIN = '.abd[data-abd-surface="main"]';
const POP = ".abd-pop.show";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function verifyBuddies(page) {
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  const until = async (read, ok, ms, what) => {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      last = await read();
      if (ok(last)) return last;
      if (Date.now() > end) throw new Error(`${what} (last: ${JSON.stringify(last)})`);
      await pause(200);
    }
  };
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
  const hits = (sel, x, y) => page.evaluate((s, px, py) => { const n = document.querySelector(s); const at = document.elementFromPoint(px, py); return !!n && !!at && n.contains(at); }, sel, x, y);
  // Measured and hit-tested in one evaluate: a World buddy follows its node every frame.
  const topmost = async (sel, what) => {
    const b = await box(sel);
    assert(b, `${what} is not visible`);
    const now = await page.evaluate((s) => {
      const n = document.querySelector(s);
      const r = n?.getBoundingClientRect();
      if (!r) return null;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const at = document.elementFromPoint(x, y);
      return { x, y, ok: !!at && n.contains(at) };
    }, sel);
    assert(now?.ok, `${what} is covered: ${now ? await owner(now.x, now.y) : "nothing"} is at its center`);
    return { ...b, x: now.x, y: now.y };
  };
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
  const clickReal = async (sel, what) => { const b = await topmost(sel, what); await page.mouse.click(b.x, b.y); };
  const audit = async (sel, where) => {
    const found = await page.evaluate(auditBoxes, sel, MIN_GAP);
    assert(found.length === 0, `${where} spacing: ${found.join("; ")}`);
  };
  const allTopmost = async (root, where) => {
    const sels = await page.$$eval(`${root} button`, (ns) => ns.map((n, i) => { n.dataset.qaHit = String(i); return `[data-qa-hit="${i}"]`; }));
    for (const s of sels) await topmost(`${root} ${s}`, `${where}: ${s}`);
  };
  const onScreen = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight; });
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content).catch(() => "");
  const api = async (path, body) => {
    const r = await page.evaluate(async (p, b, t) => {
      const res = await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", ...(t ? { "x-lucid-token": t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) });
      return res.json();
    }, path, body ?? null, token);
    return r?.data ?? r;
  };
  const lanes = async () => (await api("/api/fleet/status"))?.lanes ?? [];
  /** The buddy's own rect, sampled `n` times over `ms`: the drift's range in px. */
  const driftRange = async (sel, n = 16, ms = 4000) => {
    const xs = [], ys = [];
    for (let i = 0; i < n; i++) {
      const b = await box(sel);
      if (b) { xs.push(b.left); ys.push(b.top); }
      await pause(ms / n);
    }
    return { x: Math.max(...xs) - Math.min(...xs), y: Math.max(...ys) - Math.min(...ys) };
  };
  /** Evidence frames when LUCID_DEMO_SHOTS names a folder; nothing otherwise. */
  const shot = async (name) => { if (process.env.LUCID_DEMO_SHOTS) await page.screenshot({ path: `${process.env.LUCID_DEMO_SHOTS}/buddy-${name}.png` }).catch(() => {}); };
  // P-SPINUP.1: while Main's agent starts, its walker stands in for the buddy; the buddy is back once it leaves.
  const mainReady = async () => {
    // Absent for 2 s in a row: right after a load the walker may not have arrived yet.
    let since = 0;
    await until(async () => {
      const gone = await page.evaluate(() => !document.querySelector('.spw-host[data-spw-surface="main"]'));
      if (!gone) since = 0; else if (!since) since = Date.now();
      return gone && Date.now() - since >= 2000;
    }, Boolean, 120_000, "Main's spin-up walker never left");
    await page.waitForSelector(MAIN, { visible: true, timeout: 30_000 });
  };
  const closeLayers = async () => { for (let i = 0; i < 3; i++) { await page.keyboard.press("Escape"); await pause(200); } };
  const vizShown = () => page.evaluate(() => { const v = document.getElementById("vizView"); return !!v && !v.hidden && v.classList.contains("open"); });

  const cdp = await page.target().createCDPSession();
  const started = [];
  const results = { sizes: [] };
  const startLanes = new Set((await lanes()).map((l) => l.id));
  let perfBefore = null, camBefore = null;
  try {
    const ws = (await api("/api/workspace"))?.current;
    assert(ws, "the engine reports no workspace folder");
    // A headless QA browser without a GPU lands on the "minimal" perf tier, where buddies hold still by design: pin
    // Performance to Full the way a user would in Settings (restored after the run).
    perfBefore = await page.evaluate((a, b, k) => { localStorage.removeItem(a); localStorage.removeItem(b); const v = localStorage.getItem(k); localStorage.setItem(k, "full"); return v; }, POS_KEY, SET_KEY, PERF_KEY);
    // Agent Worlds' Auto camera glides to the busiest agent (here the worktree lane), taking other nodes, and the
    // buddies that ride on them, off the stage; the overview camera keeps the lane's node in view.
    camBefore = await page.evaluate((k) => { const v = localStorage.getItem(k); localStorage.setItem(k, "0"); return v; }, CAM_KEY);
    await page.reload({ waitUntil: "domcontentloaded" });
    await mainReady();

    for (const size of SIZES) {
      const label = size.name;
      const entry = { size: label };
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      await pause(800);
      await dismissToasts();
      // The last size's lane steps left the Fleet dock floating over the chat; a user puts it away with its button.
      if (await box("#fleetGrid")) { await clickReal("#ctFleet", `${label}: the Fleet button (close the dock)`); await pause(500); }

      // 1. Main's buddy: where it sits (its name under it, both off the composer), what it leaves alone, no drift,
      // the glow, and the app's own hover helper instead of a browser tooltip
      const mb = await topmost(MAIN, `${label}: Main's buddy`);
      const mh = await box('.abd-host[data-where="main"]');
      const cw = await box(".composer-wrap");
      assert(cw, `${label}: no composer`);
      assert(Math.abs(mh.left - cw.left) <= 28 && mh.bottom <= cw.top + 8 && mh.bottom >= cw.top - 30, `${label}: Main's buddy is not on the composer's upper-left corner (buddy ${JSON.stringify(mh)}, composer ${JSON.stringify(cw)})`);
      const nameInfo = await page.$eval('.abd-host[data-where="main"] .abd-name', (n) => {
        const r = n.getBoundingClientRect(), b = n.parentElement.querySelector(".abd").getBoundingClientRect(), cs = getComputedStyle(n);
        return { text: n.textContent, top: r.top, btnBottom: b.bottom, h: r.height, lh: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2, border: cs.borderTopStyle, bg: cs.backgroundColor, ws: cs.whiteSpace };
      });
      assert(nameInfo.text && nameInfo.top >= nameInfo.btnBottom - 1, `${label}: the Agent's name is not under the buddy (${JSON.stringify(nameInfo)})`);
      assert(nameInfo.border === "none" && /rgba\(0, 0, 0, 0\)|transparent/.test(nameInfo.bg) && nameInfo.ws === "nowrap" && nameInfo.h <= nameInfo.lh * 1.5, `${label}: the name is framed or wraps (${JSON.stringify(nameInfo)})`);
      assert(!(await page.$eval(MAIN, (n) => n.hasAttribute("title"))), `${label}: the buddy still has a browser tooltip`);
      await page.mouse.move(mb.x, mb.y);
      const tipText = await until(() => page.evaluate(() => { const t = document.querySelector("#tip.show"); return t ? t.innerText.replace(/\s+/g, " ") : ""; }), Boolean, 3000, `${label}: hovering the buddy shows no hover helper`);
      assert(tipText.includes(nameInfo.text) && /Drag to move it/.test(tipText), `${label}: the hover helper says: ${tipText}`);
      entry.tip = tipText;
      await page.mouse.move(Math.round(size.width * 0.4), Math.round(size.height * 0.3));
      await pause(300);
      const controls = await page.$$eval(".composer-wrap button, .composer-wrap textarea, #input", (ns) => ns.filter((n) => n.getBoundingClientRect().width > 0 && !n.closest("[hidden]")).map((n, i) => { n.dataset.qaCtl = String(i); return `[data-qa-ctl="${i}"]`; }));
      for (const c of controls) {
        const b = await box(c);
        if (!b) continue;
        const under = await page.evaluate((x, y) => !!document.elementFromPoint(x, y)?.closest(".abd-host"), b.x, b.y);
        assert(!under, `${label}: Main's buddy covers the composer control ${c}`);
      }
      // P-BUDDY.2: the little ellipse drift is gone; the buddy holds still where it was put
      const drift = await driftRange(MAIN, 10, 2500);
      assert(drift.x < 0.01 && drift.y < 0.01, `${label}: the buddy still drifts (${JSON.stringify(drift)})`);
      const glow = await page.$eval(MAIN, (n) => getComputedStyle(n, "::before").backgroundImage);
      assert(/radial-gradient/.test(glow), `${label}: no glow behind the buddy (${glow})`);
      entry.main = { at: [Math.round(mb.left), Math.round(mb.top)], drift };
      await shot(`${label}-1-main`);

      // 2. drag, persist, double-click home
      const from = await box(MAIN);
      const dx = Math.round(size.width * 0.2), dy = -Math.round(size.height * 0.3);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) { await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10); await pause(16); }
      await page.mouse.up();
      await pause(300);
      const moved = await box(MAIN);
      assert(Math.abs(moved.left - from.left - dx) <= 6 && Math.abs(moved.top - from.top - dy) <= 6, `${label}: the drag did not move the buddy with the pointer (${JSON.stringify({ from, moved })})`);
      assert(!(await box(POP)), `${label}: the drag's release opened the bubble`);
      const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), POS_KEY);
      assert(stored?.spots?.main && "fx" in stored.spots.main, `${label}: the spot was not stored (${JSON.stringify(stored)})`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await mainReady();
      await pause(800);
      const back = await box(MAIN);
      assert(Math.abs(back.left - moved.left) <= 6 && Math.abs(back.top - moved.top) <= 6, `${label}: the spot did not survive a reload (${JSON.stringify({ moved, back })})`);
      await page.mouse.click(back.x, back.y, { count: 2 });
      await pause(400);
      assert(!(await box(POP)), `${label}: the double-click left the bubble open`);
      const home = await box(MAIN);
      assert(Math.abs(home.left - mb.left) <= 6 && Math.abs(home.top - mb.top) <= 6, `${label}: a double-click did not put the buddy back (${JSON.stringify({ mb, home })})`);
      entry.drag = "moves with the pointer, persists across a reload, double-click resets";

      // 3. Main with no conversation yet: nothing to suggest, so a click pops nothing up; a chip says so
      await clickReal(MAIN, `${label}: Main's buddy`);
      const chip = '.abd-host[data-where="main"] .abd-chip';
      const said = await until(() => page.$eval(chip, (n) => (n.classList.contains("show") ? n.textContent : "")), (t) => /Nothing to suggest right now/.test(t ?? ""), 30_000, `${label}: the chip never said there is nothing to suggest`);
      assert(!(await box(POP)), `${label}: the ideas bubble popped up with nothing to suggest`);
      await pause(1200);
      assert(!(await box(POP)), `${label}: the ideas bubble popped up late with nothing to suggest`);
      entry.mainClick = `${said}; no popup`;

      // 4. a lane in the workspace: its buddy, auto ideas, the bubble, Ask Lucid, the worktree
      // The engine refuses new agents while the machine is under sustained CPU or memory pressure; wait it out.
      let sp = null;
      for (const end = Date.now() + 240_000; ;) {
        sp = await api("/api/fleet/spawn", { cwd: ws, name: `Buddy QA ${label}` });
        if (sp?.ok !== false || !/has been at \d+%/.test(sp?.reason ?? "") || Date.now() > end) break;
        await pause(5000);
      }
      const laneId = sp?.lane?.id ?? sp?.id;
      assert(laneId, `${label}: the lane did not spawn (${JSON.stringify(sp).slice(0, 200)})`);
      started.push(laneId);
      await until(async () => (await lanes()).find((l) => l.id === laneId)?.status, (s) => s && s !== "starting", 60_000, `${label}: the lane never became ready`);
      // The Fleet grid is open while the lane works, as a user watching it would have it.
      if (!(await box("#fleetGrid"))) await clickReal("#ctFleet", `${label}: the Fleet button`);
      const laneBuddy = `.abd[data-abd-surface="lane"][data-abd-lane="${laneId}"]`;
      const card = `.fleet-card[data-lane="${laneId}"]`;
      await until(() => box(card), Boolean, 15_000, `${label}: the lane's card is not shown`);
      await page.$eval(card, (n) => n.scrollIntoView({ block: "nearest" }));
      await until(() => box(laneBuddy), Boolean, 10_000, `${label}: the lane card has no buddy`);
      await pause(400);
      const lb = await topmost(laneBuddy, `${label}: the lane's buddy`);
      const fc = await box(`${card} .fleet-compose`);
      // The host (brick plus its name) is what sits on the corner; the brick is centered over the name.
      const lh = await page.$eval(laneBuddy, (n) => { const r = n.closest(".abd-host").getBoundingClientRect(); return { left: r.left, bottom: r.bottom }; });
      assert(fc && Math.abs(lh.left - fc.left) <= 28 && lh.bottom <= fc.top + 8 && lh.bottom >= fc.top - 30, `${label}: the lane's buddy is not on its composer's upper-left corner (buddy ${JSON.stringify(lb)}, composer ${JSON.stringify(fc)})`);
      // /api/fleet/prompt streams the turn as NDJSON: start it and read it to the end in the page, unawaited.
      await page.evaluate((id, t) => { void fetch("/api/fleet/prompt", { method: "POST", headers: { "content-type": "application/json", "x-lucid-token": t }, body: JSON.stringify({ laneId: id, text: "[script buddy-ideas] Say hello" }) }).then((r) => r.text()).catch(() => {}); }, laneId, token);
      await until(async () => (await lanes()).find((l) => l.id === laneId), (l) => l && l.turns >= 1 && !["working", "needs-approval", "starting"].includes(l.status), 60_000, `${label}: the lane's first turn did not end`);
      const auto = await until(() => page.evaluate((s) => {
        const b = document.querySelector(s);
        const host = b?.closest(".abd-host");
        return { badge: !!b?.querySelector(".abd-badge:not([hidden])"), chip: host?.querySelector(".abd-chip")?.classList.contains("show") ?? false, text: b?.querySelector(".abd-badge")?.textContent ?? "" };
      }, laneBuddy), (v) => v.badge || v.chip, 45_000, `${label}: the lane's buddy did not fetch ideas after the turn`);
      entry.autoIdeas = auto;
      await clickReal(laneBuddy, `${label}: the lane's buddy`);
      await until(() => page.$$eval(`${POP} [data-abd-ask]`, (ns) => ns.length), (n) => n >= 1, 45_000, `${label}: the lane's bubble lists no ideas`);
      const ideas = await page.$$eval(`${POP} .abd-idea-t`, (ns) => ns.map((n) => n.textContent));
      assert(ideas.length === 3, `${label}: expected the 3 scripted ideas, got ${JSON.stringify(ideas)}`);
      assert(await onScreen(POP), `${label}: the lane's bubble is not fully on screen`);
      await allTopmost(POP, `${label} lane bubble`);
      await audit(POP, `${label} lane bubble`);
      const model = await page.$eval(`${POP} .abd-model`, (n) => n.textContent);
      entry.ideas = { titles: ideas, model };
      await shot(`${label}-2-ideas`);
      await clickReal(`${POP} [data-abd-ask="0"]`, `${label}: Ask Lucid on the first idea`);
      await until(() => box(".ald.al-dock"), Boolean, 5000, `${label}: Ask Lucid did not fly out`);
      const al = await page.evaluate(() => {
        const d = document.querySelector(".ald.al-dock");
        const ta = d?.querySelector("textarea");
        const fig = d?.querySelector(".al-head .al-fig svg.agr-fig");
        return { value: ta?.value ?? "", focused: !!ta && document.activeElement === ta, fig: !!fig, brick: !!fig?.querySelector(".agr-bk-trim"), g: getComputedStyle(d).getPropertyValue("--G").trim() };
      });
      assert(al.value.includes(ideas[0]), `${label}: Ask Lucid is not prefilled with the idea (${al.value.slice(0, 160)})`);
      assert(al.fig && !al.brick, `${label}: Ask Lucid's header is not the boxless Lucid figure (${JSON.stringify(al)})`);
      assert(al.g, `${label}: the Ask Lucid dock carries no Agents palette`);
      entry.askLucid = { prefilled: true, focused: al.focused, figure: "boxless" };
      await shot(`${label}-3-asklucid`);
      await page.evaluate(() => document.querySelector(".ald.al-dock .ald-close")?.click());
      await pause(400);
      if (label === "wide") {
        await closeLayers();
        await clickReal(laneBuddy, `${label}: the lane's buddy (again)`);
        await until(() => page.$$eval(`${POP} [data-abd-run]`, (ns) => ns.length), (n) => n >= 1, 10_000, `${label}: the bubble lost its ideas`);
        const before = new Set((await lanes()).map((l) => l.id));
        await clickReal(`${POP} [data-abd-run="1"]`, `${label}: Run in parallel worktree`);
        const wt = await until(async () => (await lanes()).find((l) => !before.has(l.id)) ?? null, Boolean, 60_000, `${label}: no worktree lane started`);
        started.push(wt.id);
        assert(/lucid-worktrees/i.test(wt.cwd), `${label}: the new lane is not in a worktree (${wt.cwd})`);
        entry.worktree = wt.cwd;
      }
      await closeLayers();
      await dismissToasts();

      // 5. Agent Worlds: a buddy for the lane's node
      await clickReal("#ctViz", `${label}: the Agent Worlds button`);
      await until(vizShown, Boolean, 8000, `${label}: Agent Worlds did not open`);
      const wsel = `#vizView .abd[data-abd-surface="world"][data-abd-lane="${laneId}"]`;
      await until(() => box(wsel), Boolean, 20_000, `${label}: Agent Worlds shows no buddy for the lane`);
      await pause(600);
      const diag = await page.$eval(wsel, (n) => {
        const r = n.getBoundingClientRect(), host = n.closest(".abd-host"), st = host?.parentElement?.getBoundingClientRect();
        return { buddy: [r.left, r.top, r.width, r.height].map(Math.round), stage: st && [st.left, st.top, st.width, st.height].map(Math.round), z: host && getComputedStyle(host).zIndex, order: host && [...host.parentElement.children].map((c) => c.className.baseVal ?? c.className).join(" | ") };
      });
      // Nodes orbit, so the lane's node (and its buddy) can be off the stage for a moment: wait for a frame where it
      // is on screen, then it must be on top there.
      await until(() => page.evaluate((s) => {
        const n = document.querySelector(s);
        const r = n?.getBoundingClientRect();
        if (!r || r.width === 0) return false;
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!at && n.contains(at);
      }, wsel), Boolean, 20_000, `${label}: the lane's world buddy is never on top on screen ${JSON.stringify(diag)}`);
      const wd = await driftRange(wsel, 8, 1600);
      entry.world = { drift: wd };
      await shot(`${label}-4-worlds`);
      for (let i = 0; i < 4 && (await vizShown()); i++) { await page.keyboard.press("Escape"); await pause(350); }
      assert(!(await vizShown()), `${label}: Agent Worlds did not close`);

      // 6. the settings switch
      await clickReal('.rail-btn[data-rail="settings"]', `${label}: Settings`);
      await until(() => box('[data-set-cat="appearance"]'), Boolean, 8000, `${label}: Settings has no Appearance category`);
      await clickReal('[data-set-cat="appearance"]', `${label}: Settings > Appearance`);
      await until(() => page.$('[data-sec="floatingAgents"] [data-setcard]'), Boolean, 8000, `${label}: Appearance has no Floating Agents card`);
      if (!(await page.$eval('[data-sec="floatingAgents"]', (n) => n.classList.contains("open")))) {
        await page.$eval('[data-sec="floatingAgents"]', (n) => n.scrollIntoView({ block: "center" }));
        await pause(250);
        await clickReal('[data-sec="floatingAgents"] [data-setcard]', `${label}: the Floating Agents card`);
      }
      await pause(300);
      await audit('[data-sec="floatingAgents"]', `${label} Settings > Floating Agents`);
      await page.$eval("#buddyShow", (n) => { n.closest("label").dataset.qaToggle = "1"; n.scrollIntoView({ block: "center" }); });
      await pause(300);
      const toggle = 'label[data-qa-toggle="1"]';
      await clickReal(toggle, `${label}: Show floating Agents`);
      await until(() => page.$$eval(".abd", (ns) => ns.filter((n) => n.getBoundingClientRect().width > 0).length), (n) => n === 0, 3000, `${label}: buddies stay after Show floating Agents is off`);
      await clickReal(toggle, `${label}: Show floating Agents (on again)`);
      await until(() => page.$$eval(".abd-host:not([hidden]) .abd", (ns) => ns.length), (n) => n >= 1, 3000, `${label}: buddies did not come back`);
      await page.evaluate(() => document.querySelector('.rail-btn[data-rail="settings"]')?.click());
      await closeLayers();
      entry.settings = "off hides every buddy, on brings them back";

      for (const id of started.splice(0)) await api("/api/fleet/stop", { laneId: id }).catch(() => {});
      results.sizes.push(entry);
    }
    assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  } catch (e) {
    if (process.env.LUCID_DEMO_SHOTS) await page.screenshot({ path: `${process.env.LUCID_DEMO_SHOTS}/buddy-demo-fail.png` }).catch(() => {});
    throw e;
  } finally {
    for (const id of started) await api("/api/fleet/stop", { laneId: id }).catch(() => {});
    for (const l of await lanes().catch(() => [])) if (!startLanes.has(l.id)) await api("/api/fleet/stop", { laneId: l.id }).catch(() => {});
    await page.evaluate((k, v) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }, PERF_KEY, perfBefore).catch(() => {});
    await page.evaluate((k, v) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }, CAM_KEY, camBefore).catch(() => {});
    await page.emulateMediaFeatures([]).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_buddy_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyBuddies(page), null, 2));
    console.log("P-BUDDY.1 passed: Main's and each lane's buddy sit on their composer's corner with their name under them, hold still with their glow and a hover helper, drag and persist, pop ideas up only when there are some, fetch ideas after a turn from the smaller model, Ask Lucid flies out prefilled in the Agents style, an idea starts a worktree lane, Agent Worlds shows the lane's buddy, and the settings switch hides and restores them, wide and narrow.");
  } finally { await browser.disconnect(); }
}
