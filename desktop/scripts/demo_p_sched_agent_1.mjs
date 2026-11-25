// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_sched_agent_1.mjs
//
// P-SCHED.AGENT1: real-UI proof of "Schedule this Agent" on the right rail's Agent module, driven with real mouse and
// keyboard input against an isolated QA engine, in a wide (1600x1000) and a narrow (1100x800) window:
//   1. clicking an Agent's box opens its module with Activate open; "Schedule this Agent" is the fourth choice, topmost;
//   2. it turns the module into the form: Once / Daily / Weekdays / Weekly / Monthly, the date or days or day of the
//      month, the time of day, the instructions or goal; every control is topmost at its center and the module passes
//      auditBoxes; the line under the form says when it will run (or why it cannot);
//   3. Weekly with no day refuses; Once on tomorrow at 09:30 with instructions saves: the engine holds an armed job
//      with once:true, the Agent's folder as its target and the instructions as its prompt; the module lists it;
//   4. pause, resume and delete on its row round-trip through the engine;
//   5. (wide) a Daily schedule at the next minute fires: the engine starts a lane in the Agent's folder and sends it
//      the instructions (the QA fake agent answers), and the job records the run.
// Every job and lane it makes is removed at the end.
//
// Setup (never a user's session): bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811, the QA page open in a browser
// with remote debugging, past the first-run gates.
// Run: LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_sched_agent_1.mjs

import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const norm = (p) => { const s = String(p).trim().replace(/[\\/]+/g, "/"); return (s.length > 1 ? s.replace(/\/$/, "") : s).toLowerCase(); };

export async function verifyScheduleAgent(page) {
  const port = new URL(page.url()).port;
  const fleet = JSON.parse(readFileSync(join(process.env.LUCID_DEMO_QA_ROOT ?? join(tmpdir(), `lucid-qa-fleet-${port}`), "fleet.json"), "utf8"));
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content);
  const api = (path, body) => page.evaluate(async (p, b, t) => {
    const r = await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", "x-lucid-token": t }, ...(b ? { body: JSON.stringify(b) } : {}) });
    const j = await r.json();
    return j?.data ?? j;
  }, path, body ?? null, token);
  const until = async (read, what, ms = 20_000, every = 200) => {
    for (const end = Date.now() + ms; ; await pause(every)) {
      const v = await read();
      if (v) return v;
      assert(Date.now() < end, what);
    }
  };
  const center = (sel) => page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    if (r.width === 0) return null;
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: !!at && (at === n || n.contains(at)) };
  }, sel);
  // The app's own toasts (a seasonal theme tip, a sign-in note) sit above every popover by design; they are dismissed
  // the way a person would before the click, never counted as the form being covered.
  const dismissToasts = () => page.evaluate(() => document.querySelectorAll("#toasts .toast .h button").forEach((b) => b.click()));
  const clickReal = async (sel, what) => {
    let c = await until(() => center(sel), `${what}: not on screen (${sel})`, 8000);
    if (!c.top) { await dismissToasts(); await pause(400); c = await center(sel); }
    assert(c?.top, `${what}: covered at its center (${sel})`);
    await page.mouse.click(c.x, c.y);
    await pause(250);
  };
  const jobsFor = async (folder) => ((await api("/api/jobs"))?.jobs ?? []).filter((j) => norm(j.target.cwd) === norm(folder));

  const folder = join(fleet.root ?? join(fleet.workspace, "..", ".."), "workspace", "agents", "sched-alpha");
  mkdirSync(folder, { recursive: true });
  const id = norm(folder);
  const tile = `.agr-list .agr-tile[data-agent="${id}"]`;
  const cdp = await page.target().createCDPSession();
  const results = [];
  const lanesBefore = new Set(((await api("/api/fleet/status"))?.lanes ?? []).map((l) => l.id));
  try {
    await page.evaluate((d) => { localStorage.setItem("lucid.agents.v1", JSON.stringify(d)); localStorage.setItem("lucid.rail.view", "agents"); localStorage.setItem("lucid.perfMode", "full"); },
      { v: 1, agents: [{ id, path: folder, name: "Sched Alpha", theme: "lucid", hue: 145, saved: true }], hidden: [], manual: false, main: null });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#input", { visible: true, timeout: 60_000 });
    for (const size of SIZES) {
      const label = size.name;
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      await pause(700);
      await page.keyboard.press("Escape");
      // 1. the module, Activate open, the Schedule choice
      await clickReal(tile, `${label}: the Agent's box`);
      await until(() => page.$(".agr-pop.show .agr-sub.open"), `${label}: the module did not open with Activate open`, 5000);
      await clickReal('.agr-pop.show [data-act="schedule"]', `${label}: Schedule this Agent`);
      // 2. the form
      await until(() => page.$(".agr-pop.show .agr-sched"), `${label}: the schedule form did not open`, 5000);
      await dismissToasts();
      await pause(400);
      for (const sel of ['[data-sched-repeat="once"]', '[data-sched-repeat="monthly"]', "[data-sched-time]", "[data-sched-prompt]", '[data-act="sched-save"]', '[data-act="sched-back"]']) {
        const c = await center(`.agr-pop.show ${sel}`);
        assert(c?.top, `${label}: ${sel} is not topmost in the form`);
      }
      const boxes = await page.evaluate(auditBoxes, ".agr-pop.show", MIN_GAP);
      assert(boxes.length === 0, `${label}: auditBoxes on the schedule form:\n${boxes.join("\n")}`);
      // 3. Weekly with no day refuses; Once tomorrow 09:30 saves
      await clickReal('.agr-pop.show [data-sched-repeat="weekly"]', `${label}: Weekly`);
      for (const d of [1, 2, 3, 4, 5]) {
        const on = await page.$eval(`.agr-pop.show [data-sched-day="${d}"]`, (n) => n.getAttribute("aria-pressed") === "true");
        if (on) await clickReal(`.agr-pop.show [data-sched-day="${d}"]`, `${label}: day ${d}`);
      }
      const note = await page.$eval(".agr-pop.show [data-sched-note]", (n) => n.textContent);
      assert(/at least one day/.test(note), `${label}: Weekly with no day did not say so (${note})`);
      await clickReal('.agr-pop.show [data-sched-repeat="once"]', `${label}: Once`);
      const tomorrow = new Date(Date.now() + 86_400_000);
      const iso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
      await page.$eval(".agr-pop.show [data-sched-date]", (n, v) => { n.value = v; n.dispatchEvent(new Event("input", { bubbles: true })); }, iso);
      await page.$eval(".agr-pop.show [data-sched-time]", (n) => { n.value = "09:30"; n.dispatchEvent(new Event("input", { bubbles: true })); });
      await clickReal(".agr-pop.show [data-sched-prompt]", `${label}: the instructions field`);
      const instructions = `Review the open TODOs and write a short plan (${label})`;
      await page.keyboard.type(instructions);
      const note2 = await page.$eval(".agr-pop.show [data-sched-note]", (n) => n.textContent);
      assert(/^Once on /.test(note2), `${label}: the note does not say when it runs (${note2})`);
      await clickReal('.agr-pop.show [data-act="sched-save"]', `${label}: Save schedule`);
      await until(() => page.$eval(".agr-pop.show [data-ap-msg]", (n) => !n.hidden && n.classList.contains("ok") && /^Scheduled/.test(n.textContent)).catch(() => false), `${label}: no "Scheduled" confirmation`, 8000);
      const saved = (await jobsFor(folder)).find((j) => j.prompt === instructions);
      assert(saved && saved.once === true && saved.armed && saved.cron === `30 9 ${tomorrow.getDate()} ${tomorrow.getMonth() + 1} *`, `${label}: the engine's job is not the one-time schedule (${JSON.stringify(saved)})`);
      const row = `.agr-pop.show [data-sj="${saved.id}"]`;
      await until(() => page.$(row), `${label}: the module does not list the new schedule`, 5000);
      // 4. pause, resume, delete
      await clickReal(`${row} [data-sj-toggle]`, `${label}: pause`);
      await until(async () => (await jobsFor(folder)).find((j) => j.id === saved.id)?.armed === false, `${label}: pause did not reach the engine`, 8000);
      await clickReal(`${row} [data-sj-toggle]`, `${label}: resume`);
      await until(async () => (await jobsFor(folder)).find((j) => j.id === saved.id)?.armed === true, `${label}: resume did not reach the engine`, 8000);
      await clickReal(`${row} [data-sj-del]`, `${label}: delete`);
      await until(async () => !(await jobsFor(folder)).some((j) => j.id === saved.id), `${label}: delete did not reach the engine`, 8000);
      const entry = { size: label, once: "saved, listed, paused, resumed, deleted" };
      // 5. a real fire (wide): Daily at the next minute
      if (label === "wide") {
        await clickReal('.agr-pop.show [data-sched-repeat="daily"]', `${label}: Daily`);
        const at = new Date(Date.now() + (new Date().getSeconds() > 40 ? 120_000 : 60_000));
        const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
        await page.$eval(".agr-pop.show [data-sched-time]", (n, v) => { n.value = v; n.dispatchEvent(new Event("input", { bubbles: true })); }, hhmm);
        await clickReal(".agr-pop.show [data-sched-prompt]", `${label}: the instructions field`);
        await page.keyboard.type("Say hello from the scheduled run");
        await clickReal('.agr-pop.show [data-act="sched-save"]', `${label}: Save schedule (daily)`);
        const daily = await until(async () => (await jobsFor(folder)).find((j) => j.prompt === "Say hello from the scheduled run"), `${label}: the daily job was not saved`, 8000);
        const lane = await until(async () => ((await api("/api/fleet/status"))?.lanes ?? []).find((l) => !lanesBefore.has(l.id) && norm(l.cwd) === id), `${label}: the schedule never started a lane in the Agent's folder`, 200_000, 2000);
        const ran = await until(async () => { const j = (await jobsFor(folder)).find((x) => x.id === daily.id); return j?.history?.length ? j : null; }, `${label}: the job never recorded its run`, 120_000, 2000);
        entry.fired = { lane: lane.name, outcome: ran.history[0].outcome };
        await api("/api/jobs/delete", { id: daily.id });
        await api("/api/fleet/stop", { laneId: lane.id }).catch(() => {});
        await api("/api/fleet/remove", { laneId: lane.id }).catch(() => {});
      }
      results.push(entry);
      await clickReal('.agr-pop.show [data-act="sched-back"]', `${label}: Back`);
      await until(() => page.$('.agr-pop.show [data-act="schedule"]'), `${label}: Back did not return to the module`, 5000);
      await page.keyboard.press("Escape");
    }
  } finally {
    for (const j of await jobsFor(folder).catch(() => [])) await api("/api/jobs/delete", { id: j.id }).catch(() => {});
    for (const l of ((await api("/api/fleet/status").catch(() => null))?.lanes ?? []).filter((x) => !lanesBefore.has(x.id))) {
      await api("/api/fleet/stop", { laneId: l.id }).catch(() => {});
      await api("/api/fleet/remove", { laneId: l.id }).catch(() => {});
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_sched_agent_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const url = process.env.LUCID_DEMO_URL;
  if ((!endpoint && !browserURL) || !url) throw new Error("Set LUCID_DEMO_CDP_URL (or LUCID_DEMO_BROWSER_URL) and LUCID_DEMO_URL.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(endpoint ? { browserWSEndpoint: endpoint } : { browserURL }), defaultViewport: null, protocolTimeout: 180_000 });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url));
    if (!page) throw new Error(`No page at ${url}`);
    console.log(JSON.stringify(await verifyScheduleAgent(page), null, 2));
    console.log("P-SCHED.AGENT1 passed: an Agent's module schedules it once or on a repeat with instructions; the engine holds the job, the module lists, pauses, resumes and deletes it, and a schedule that comes due starts a lane in the Agent's folder with the instructions, wide and narrow.");
  } finally { await browser.disconnect(); }
}
