// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_agent_activate_1.mjs
//
// P-RAIL.AGENTS1 (Activate): real-browser proof of the Agents rail's three Activate choices (app.ts
// activateAgentFolder, agent_activate.ts), driven through the rail's hover module with real mouse input. Every control
// is clicked at its center after document.elementFromPoint there hits it (the user can see and reach it). Against a
// QA engine, in a wide (1600x1000) and a narrow (1100x800) window:
//   fleet     Start new Fleet session on a second folder: a new lane runs in that folder, the Fleet dock is open on
//             its card and the card's prompt input has focus;
//   world     Agent World session: a new background lane in that folder, Visualize open with THAT lane's prompt
//             panel open and its input focused;
//   takeover  (wide) Main idle with a conversation: Main's folder becomes the second folder, a lane in Main's old
//             folder resumes Main's previous session id, and the composer has focus. Then back home.
//   takeover  (narrow) Main busy: the confirm docks above the composer (After this turn focused, all three choices
//             topmost, auditBoxes clean); After this turn shows the quiet pending status with Cancel handoff and
//             Main stays put while the turn runs; when the turn ends (its asks answered as a user would) Main
//             switches and a lane resumes the session. Then back home.
// No uncaught page errors. Every lane the run started is stopped and removed, Main ends on its starting folder and
// the window size override is cleared.
//
// Setup (an isolated QA engine and browser, never a user's session):
//   bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811   (the scripted fake agent: FAKE_ACP_MODE=script)
//   open http://127.0.0.1:7811/ in the QA browser (remote debugging on), past the first-run gates, Main idle.
// The second folder is a fresh temp folder (or LUCID_DEMO_AGENT_FOLDER); it joins the recents through
// POST /api/workspace (there and back), which restarts Main twice, so the page is reloaded once before the run.
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_agent_activate_1.mjs

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
/** The scripted fake agent picks its script by this marker; release-notes runs about a minute with one ask. */
const MAIN_PROMPT = "[script release-notes] Write the release notes and changelog";
const TURN_MS = 180_000;

/** The same folder comparison agent_activate.ts makes (separators, trailing separator, drive-letter case). */
const folderKey = (path) => {
  let p = String(path ?? "").trim().replace(/\\/g, "/");
  while (p.length > 1 && p.endsWith("/") && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1);
  return /^[A-Za-z]:/.test(p) ? p.toLowerCase() : p;
};
const same = (a, b) => !!a && !!b && folderKey(a) === folderKey(b);

export async function verifyAgentActivate(page, opts) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  const onError = (e) => errors.push(String(e?.message ?? e));
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
  const box = (sel) => page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n || n.closest("[hidden]")) return null;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } : null;
  }, sel);
  const hits = (sel, x, y) => page.evaluate((s, px, py) => { const n = document.querySelector(s); const at = document.elementFromPoint(px, py); return !!n && !!at && n.contains(at); }, sel, x, y);
  const owner = (x, y) => page.evaluate((px, py) => {
    const at = document.elementFromPoint(px, py);
    if (!at) return "nothing";
    const o = at.closest("[id]");
    return `${at.tagName.toLowerCase()}${typeof at.className === "string" && at.className ? `.${at.className.split(" ")[0]}` : ""}${o ? ` in #${o.id}` : ""}`;
  }, x, y);
  // Close every toast: its X, else a "Not now" style action (announcements and handoff toasts can stay up).
  const dismissToasts = async () => {
    await page.evaluate(() => {
      for (const t of document.querySelectorAll("#toasts .toast")) {
        const btns = [...t.querySelectorAll("button")];
        const x = t.querySelector(".h button, .toast-x, [aria-label='close' i], [aria-label='dismiss' i]") ?? btns.find((b) => /^(Not now|Got it|Dismiss|OK|Close)$/i.test(b.textContent.trim()));
        x?.click();
      }
    });
    // a dismissed toast animates out before it leaves the DOM; wait for it (bounded)
    await page.waitForFunction(() => !document.querySelector("#toasts")?.children.length, { timeout: 1500 }).catch(() => {});
    await pause(100);
  };
  const topmost = async (sel, what) => {
    const b = await box(sel);
    assert(b, `${what} is not visible`);
    assert(await hits(sel, b.x, b.y), `${what} is covered: ${await owner(b.x, b.y)} is at its center`);
    return b;
  };
  const clickReal = async (sel, what, { keepToasts = false } = {}) => {
    if (!keepToasts) await dismissToasts();
    const b = await topmost(sel, what);
    await page.mouse.click(b.x, b.y);
  };
  const audit = async (sel, where) => {
    const found = await page.evaluate(auditBoxes, sel, MIN_GAP);
    assert(found.length === 0, `${where} spacing: ${found.join("; ")}`);
  };
  const q = (s) => String(s).replace(/["\\]/g, "\\$&");
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content).catch(() => "");
  const api = async (path, body) => {
    const r = await page.evaluate(async (p, b, t) => {
      const res = await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", ...(t ? { "x-lucid-token": t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) });
      return res.json();
    }, path, body ?? null, token);
    return r?.data ?? r;
  };
  const lanes = async () => (await api("/api/fleet/status"))?.lanes ?? [];
  const mainState = () => api("/api/session/busy");
  const workspace = () => api("/api/workspace");
  const vizShown = () => page.evaluate(() => { const v = document.getElementById("vizView"); return !!v && !v.hidden && v.classList.contains("open"); });
  const closeViz = async () => { for (let i = 0; i < 4 && (await vizShown()); i++) { await page.keyboard.press("Escape"); await pause(350); } };
  const focusedIs = (sel) => page.evaluate((s) => !!document.activeElement?.matches?.(s), sel);

  // ── the rail: collapsed, on the Agents view; a folder's Agent box; its hover module's Activate choice ───────────
  const openAgentsView = async (label) => {
    if (!(await page.$eval("#inspector", (n) => n.classList.contains("rail")))) {
      await clickReal("#inspCollapse", `${label}: the inspector's collapse button`);
      await until(() => page.$eval("#inspector", (n) => n.classList.contains("rail")), Boolean, 3000, `${label}: the inspector did not collapse to the rail`);
    }
    if ((await page.$eval("#railAgents", (b) => b.getAttribute("aria-pressed"))) !== "true") {
      await clickReal("#railAgents", `${label}: the Agents toggle`);
      await until(() => page.$eval("#railAgents", (b) => b.getAttribute("aria-pressed")), (v) => v === "true", 3000, `${label}: the Agents toggle did not switch the rail`);
    }
  };
  /** The Agent box for `folder` (its data-path is the folder as the recents list gives it). */
  const tileFor = async (folder, label) => {
    const path = await until(() => page.evaluate((key) => {
      const k = (p) => { let s = String(p ?? "").trim().replace(/\\/g, "/"); while (s.length > 1 && s.endsWith("/") && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1); return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s; };
      return [...document.querySelectorAll(".tile.agent[data-path]")].map((t) => t.dataset.path).find((p) => k(p) === key) ?? null;
    }, folderKey(folder)), Boolean, 5000, `${label}: the rail shows no Agent for ${folder}`);
    return `.tile.agent[data-path="${q(path)}"]`;
  };
  const activate = async (folder, kind, label) => {
    // switching Main to a fresh folder asks once about the .agents framework (#wsSetup); answer Not now like a user
    await page.evaluate(() => { const ov = document.getElementById("wsSetup"); (ov?.querySelector("#wsSetupNo") ?? [...(ov?.querySelectorAll("button") ?? [])].find((b) => /not now|skip|no/i.test(b.textContent ?? "")))?.click(); });
    await pause(200);
    await openAgentsView(label);
    const tile = await tileFor(folder, label);
    await page.$eval(tile, (t) => t.scrollIntoView({ block: "nearest" }));
    await clickReal(tile, `${label}: the Agent for ${folder}`);
    const go = `.popover.agent-pop.show [data-go="${kind}"]`;
    await until(() => box(go), Boolean, 3000, `${label}: the hover module did not open with Activate > ${kind}`);
    await clickReal(go, `${label}: Activate > ${kind}`);
  };

  // ── Main's turn through the composer, its asks answered as a user would ─────────────────────────────────────
  const sendMain = async (label) => {
    assert(!(await mainState())?.busy, `${label}: Main is already busy`);
    // the fleet step left the floating Fleet dock open over the composer; a user puts it away with the Fleet button
    const dockOver = await page.evaluate(() => {
      const d = document.querySelector("#fleetDock"), i = document.querySelector("#input");
      if (!d || !i || d.hidden) return false;
      const a = i.getBoundingClientRect(), b = d.getBoundingClientRect();
      return b.width > 0 && Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
    });
    if (dockOver) { await clickReal("#ctFleet", `${label}: the Fleet button`); await pause(500); }
    await clickReal("#input", `${label}: the composer`);
    await page.keyboard.type(MAIN_PROMPT);
    await page.keyboard.press("Enter");
    await until(async () => !!(await mainState())?.busy, Boolean, 15_000, `${label}: Main did not start the turn`);
  };
  const answerAsks = () => page.evaluate(() => {
    const btns = [...document.querySelectorAll(".perm [data-oid]")].filter((b) => !b.closest("#switchSheet") && !b.disabled && b.getBoundingClientRect().width > 0);
    // the exec / egress cards mark the allow choices eg-allow, the plain tool card marks them ok
    const allow = btns.find((b) => b.classList.contains("eg-allow") || b.classList.contains("ok")) ?? btns.find((b) => /allow|approve|yes|once/i.test(b.textContent ?? ""));
    allow?.click();
    return !!allow;
  });
  const finishMain = (label) => until(async () => { await answerAsks(); return !(await mainState())?.busy; }, Boolean, TURN_MS, `${label}: Main's turn did not end`);

  const startLanes = new Set((await lanes()).map((l) => l.id));
  const seen = new Set(); // lanes this run already accounted for
  const newLane = (where, label, extra = () => true) => until(async () => (await lanes()).find((l) => !startLanes.has(l.id) && !seen.has(l.id) && same(l.cwd, where) && extra(l)) ?? null, Boolean, 30_000, `${label}: no new lane in ${where}`);
  const cdp = await page.target().createCDPSession();
  const results = { sizes: [] };
  let home = null;
  try {
    // The second folder joins the recents (there and back restarts Main twice), then the page starts clean.
    const ws0 = await workspace();
    home = ws0?.current;
    assert(home, "the engine reports no workspace folder");
    assert(!same(home, opts.other), "the second folder is Main's own folder");
    assert(!(await mainState())?.busy, "Main is busy: start the run with Main idle");
    if (!(ws0.recent ?? []).some((r) => same(r.path, opts.other))) {
      await api("/api/workspace", { path: opts.other });
      await api("/api/workspace", { path: home });
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#input", { visible: true, timeout: 30_000 });
    page.on("pageerror", onError);
    const other = (await workspace())?.recent?.find((r) => same(r.path, opts.other))?.path;
    assert(other, `${opts.other} did not join the recents`);

    for (const size of SIZES) {
      const label = size.name;
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      await pause(500);
      const entry = { size: label };

      // ── fleet: a new lane in the folder, its card up and its input focused ──────────────────────────────────
      await activate(other, "fleet", label);
      const fl = await newLane(other, `${label} fleet`);
      seen.add(fl.id);
      const card = `#fleetDock .fleet-card[data-lane="${q(fl.id)}"]`;
      await until(() => box(card), Boolean, 8000, `${label}: the new lane's card is not shown in the Fleet dock`);
      await until(() => focusedIs(`${card} [data-fleet-input]`), Boolean, 5000, `${label}: the new card's prompt input does not have focus`);
      // the dock slides in (and a freshly shown card scrolls into view) before its input is on top
      const inputSel = `${card} [data-fleet-input]`;
      await until(async () => { const b = await box(inputSel); return !!b && (await hits(inputSel, b.x, b.y)); }, Boolean, 3000, `${label}: the new card's prompt input stays covered`);
      await topmost(inputSel, `${label}: the new card's prompt input`);
      entry.fleet = { lane: fl.id, cwd: fl.cwd };

      // ── world: a background lane, Visualize on its panel, input focused ─────────────────────────────────────
      await activate(other, "world", label);
      const wl = await newLane(other, `${label} world`);
      seen.add(wl.id);
      assert(!wl.promoted, `${label}: the world lane was promoted to the composer`);
      await until(vizShown, Boolean, 5000, `${label}: Visualize did not open`);
      await until(() => focusedIs("#vizView [data-viz-panel-input]"), Boolean, 15_000, `${label}: the agent's prompt panel input does not have focus`);
      const panelName = await page.$eval("#vizView [data-viz-panel-name]", (n) => (n.textContent ?? "").trim());
      assert(panelName && (panelName.includes(wl.name) || wl.name.includes(panelName)), `${label}: the panel shows "${panelName}", not the new lane "${wl.name}"`);
      await topmost("#vizView [data-viz-panel-input]", `${label}: the panel's prompt input`);
      entry.world = { lane: wl.id, panel: panelName };
      await closeViz();
      assert(!(await vizShown()), `${label}: Visualize did not close`);

      if (label === "wide") {
        // ── takeover, Main idle with a conversation ─────────────────────────────────────────────────────────
        await sendMain(label);
        await finishMain(label);
        const prev = (await mainState())?.sessionId;
        assert(prev, `${label}: Main reports no session after its turn`);
        await activate(other, "takeover", label);
        await until(async () => same((await workspace())?.current, other), Boolean, 30_000, `${label}: Main did not switch to ${other}`);
        const handed = await newLane(home, `${label} takeover`, (l) => l.sessionId === prev);
        seen.add(handed.id);
        assert(!handed.promoted, `${label}: the handoff lane was promoted`);
        await until(() => focusedIs("#input"), Boolean, 5000, `${label}: the composer does not have focus after the takeover`);
        entry.takeoverIdle = { lane: handed.id, resumed: prev };
      } else {
        // ── takeover, Main busy: confirm, After this turn, runs when the turn ends ──────────────────────────
        await sendMain(label);
        // a fresh conversation gets its session id a moment after its turn starts
        const prev = (await until(mainState, (s) => !!s?.sessionId, 15_000, `${label}: Main reports no session while busy`)).sessionId;
        await activate(other, "takeover", label);
        const after = '#switchSheet [data-takeover="after"]';
        await until(() => box(after), Boolean, 5000, `${label}: the takeover confirm did not appear`);
        assert(await focusedIs(after), `${label}: After this turn does not have focus`);
        for (const c of ["after", "now", "stay"]) await topmost(`#switchSheet [data-takeover="${c}"]`, `${label}: the confirm's ${c} choice`);
        await audit("#switchSheet", `${label}: the takeover confirm`);
        await clickReal(after, `${label}: After this turn`);
        await until(() => page.evaluate(() => [...document.querySelectorAll("#toasts .toast")].some((t) => /Handoff after this turn/.test(t.textContent ?? "") && [...t.querySelectorAll(".acts button")].some((b) => /Cancel handoff/.test(b.textContent ?? "")))), Boolean, 3000, `${label}: no pending status with Cancel handoff`);
        assert(!(await page.$("#switchSheet")), `${label}: the confirm stayed open`);
        assert(same((await workspace())?.current, home), `${label}: Main switched before its turn ended`);
        await finishMain(label);
        await until(async () => same((await workspace())?.current, other), Boolean, 30_000, `${label}: Main did not switch after its turn ended`);
        const handed = await newLane(home, `${label} takeover after the turn`, (l) => l.sessionId === prev);
        seen.add(handed.id);
        entry.takeoverAfterTurn = { lane: handed.id, resumed: prev };
      }
      // back home: Main on the second folder holds no conversation, so this is a plain switch
      await activate(home, "takeover", `${label} back home`);
      await until(async () => same((await workspace())?.current, home), Boolean, 30_000, `${label}: Main did not come back to ${home}`);
      results.sizes.push(entry);
    }
    assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
    return results;
  } finally {
    page.off("pageerror", onError);
    await page.keyboard.press("Escape").catch(() => {});
    await closeViz().catch(() => {});
    for (const l of await lanes().catch(() => [])) {
      if (startLanes.has(l.id)) continue;
      await api("/api/fleet/stop", { laneId: l.id }).catch(() => {});
      await api("/api/fleet/remove", { laneId: l.id, force: true }).catch(() => {});
    }
    if (home && !same((await workspace().catch(() => null))?.current, home)) {
      await api("/api/workspace", { path: home }).catch(() => {});
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_agent_activate_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const other = process.env.LUCID_DEMO_AGENT_FOLDER || mkdtempSync(join(tmpdir(), "lucid-agent-activate-"));
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyAgentActivate(page, { other }), null, 2));
    console.log("P-RAIL.AGENTS1 Activate passed: Start new Fleet session opens a lane in the folder with its card focused, Agent World session opens Visualize on the new lane's prompt panel, Take over moves Main's session to a Fleet lane and Main to the folder, and a busy Main asks first and hands off after its turn, wide and narrow.");
  } finally { await browser.disconnect(); }
}
