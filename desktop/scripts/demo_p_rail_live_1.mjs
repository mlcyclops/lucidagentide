// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_rail_live_1.mjs
//
// P-FLEET.CONN1: live proof that the right rail tells working Agents from idle ones while several agents run.
// Real lanes on a real model (meant for a zero-cost local model), each in its own temp folder, their turns streamed
// by the window exactly like the Fleet grid holds them. Every second for the whole run it reads the engine's lane
// status (outside the window) and the rail's tiles (inside it) and fails when they disagree for longer than one
// poll cycle plus slack (STALE_MS). It also times a trivial request from the window each second: a window whose
// connections are all held by streams answers nothing (the bug), so a slow one fails the run.
//
//   LUCID_DEMO_BROWSER_URL=http://127.0.0.1:9340 LUCID_DEMO_URL=http://127.0.0.1:5401/ \
//   LUCID_DEMO_MODEL=dgx-spark/glm-5.3-flash LUCID_DEMO_LANES=5 node desktop/scripts/demo_p_rail_live_1.mjs
//
// Run against a second instance or a dev build, never a user's working session. Lanes and rail entries it adds are
// removed at the end.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LANES = Number(process.env.LUCID_DEMO_LANES || 5);
const MODEL = process.env.LUCID_DEMO_MODEL || "";
const STALE_MS = Number(process.env.LUCID_DEMO_STALE_MS || 7000);
const HEALTH_MAX_MS = 3000;
const RUN_MAX_MS = Number(process.env.LUCID_DEMO_RUN_MS || 15 * 60_000);
const PROMPT = "Write an 80-line poem about the sea in the chat, in four-line stanzas. Do not use any tools.";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => { const s = String(p).trim().replace(/[\\/]+/g, "/"); return (s.length > 1 ? s.replace(/\/$/, "") : s).toLowerCase(); };
const assert = (c, m) => { if (!c) throw new Error(m); };

export async function verifyRailLive(page) {
  const base = new URL(page.url()).origin;
  const token = await page.evaluate(async () => (window.lucid?.token ? await window.lucid.token() : document.querySelector('meta[name="lucid-token"]')?.content));
  assert(token, "no engine token in the page");
  // The engine's truth is read OUTSIDE the window, so a starved window cannot hide it.
  const engine = async (path, body) => {
    const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-lucid-token": token }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return (await r.json())?.data;
  };
  const root = mkdtempSync(join(tmpdir(), "lucid-rail-live-"));
  const ids = [];
  const folders = [];
  await page.evaluate(() => localStorage.setItem("lucid.rail.view", "agents"));
  try {
    for (let i = 0; i < LANES; i++) {
      const folder = join(root, `rail-live-${i + 1}`);
      mkdirSync(folder, { recursive: true });
      folders.push(folder);
      let r = null;
      for (const end = Date.now() + 180_000; ;) {
        r = await engine("/api/fleet/spawn", { cwd: folder, name: `Rail live ${i + 1}`, ...(MODEL ? { model: MODEL } : {}) });
        if (r?.ok !== false || !/has been at \d+%/.test(r?.reason ?? "") || Date.now() > end) break;
        await pause(5000);
      }
      assert(r?.lane?.id, `lane ${i + 1} did not spawn: ${JSON.stringify(r).slice(0, 240)}`);
      ids.push(r.lane.id);
    }
    for (const end = Date.now() + 180_000; ; await pause(1000)) {
      const st = (await engine("/api/fleet/status"))?.lanes ?? [];
      if (ids.every((id) => { const s = st.find((l) => l.id === id)?.status; return s && s !== "starting"; })) break;
      assert(Date.now() < end, "the lanes never became ready");
    }
    // Each turn is streamed BY THE WINDOW, one held connection per lane, as the Fleet grid does.
    for (const id of ids) {
      await page.evaluate((lid, t, text) => {
        void fetch("/api/fleet/prompt", { method: "POST", headers: { "content-type": "application/json", "x-lucid-token": t }, body: JSON.stringify({ laneId: lid, text }) }).then((r) => r.text()).catch(() => {});
      }, id, token, PROMPT);
      await pause(500); // staggered, like a person sending prompts in quick succession
    }
    const want = new Map(ids.map((id, i) => [id, norm(folders[i])]));
    const since = new Map(); // folder -> when rail and engine started to disagree
    let samples = 0, worstLag = 0, worstHealth = 0, sawWorking = 0;
    const timeline = [];
    const started = Date.now();
    for (;;) {
      const st = (await engine("/api/fleet/status"))?.lanes ?? [];
      // The rail's own rule (agents_store.isLaneBusy): a lane is working while it runs a turn or waits on an approval.
      const busy = new Set(st.filter((l) => want.has(l.id) && ["working", "needs-approval"].includes(l.status)).map((l) => want.get(l.id)));
      for (const l of st) if (want.has(l.id)) timeline.push(`${((Date.now() - started) / 1000).toFixed(1)}s ${want.get(l.id).split("/").pop()} engine=${l.status}`);
      const seen = await page.evaluate(async () => {
        const t0 = performance.now();
        const h = await Promise.race([fetch("/api/health").then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
        const tiles = [...document.querySelectorAll(".agr-list .agr-tile[data-path]")].map((t) => ({ path: t.dataset.path, work: t.classList.contains("work") }));
        return { healthMs: h ? Math.round(performance.now() - t0) : 99999, tiles };
      });
      samples++;
      worstHealth = Math.max(worstHealth, seen.healthMs);
      assert(seen.healthMs <= HEALTH_MAX_MS, `the window waited ${seen.healthMs} ms for /api/health with ${busy.size} agents working (connections starved)`);
      sawWorking = Math.max(sawWorking, busy.size);
      const now = Date.now();
      for (const f of want.values()) {
        const tile = seen.tiles.find((t) => norm(t.path) === f);
        timeline.push(`${((now - started) / 1000).toFixed(1)}s ${f.split("/").pop()} rail=${tile ? (tile.work ? "working" : "idle") : "missing"}`);
        const ok = tile ? tile.work === busy.has(f) : !busy.has(f);
        if (ok) { since.delete(f); continue; }
        if (!since.has(f)) since.set(f, now);
        const lag = now - since.get(f);
        worstLag = Math.max(worstLag, lag);
        if (lag > STALE_MS) console.error(timeline.filter((l) => l.includes(` ${f.split("/").pop()} `)).slice(-24).join("\n"));
        assert(lag <= STALE_MS, `the rail shows ${f.split("/").pop()} as ${tile ? (tile.work ? "working" : "idle") : "missing"} while the engine says ${busy.has(f) ? "working" : "idle"}, for ${lag} ms`);
      }
      if (busy.size === 0 && now - started > 20_000) break;
      assert(now - started < RUN_MAX_MS, "the turns did not finish in time");
      await pause(1000);
    }
    assert(sawWorking >= Math.min(LANES, 4), `only ${sawWorking} lanes were ever working at once`);
    return { lanes: LANES, model: MODEL || "(default)", samples, peakWorking: sawWorking, worstRailLagMs: worstLag, worstHealthMs: worstHealth, ranSec: Math.round((Date.now() - started) / 1000) };
  } finally {
    for (const id of ids) { await engine("/api/fleet/stop", { laneId: id }).catch(() => {}); await engine("/api/fleet/remove", { laneId: id }).catch(() => {}); }
    await page.evaluate((fs) => {
      const raw = localStorage.getItem("lucid.agents.v1");
      if (!raw) return;
      const doc = JSON.parse(raw);
      const drop = new Set(fs.map((f) => f.replace(/[\\/]+/g, "/").toLowerCase()));
      doc.agents = doc.agents.filter((a) => !drop.has(String(a.path).replace(/[\\/]+/g, "/").toLowerCase()));
      localStorage.setItem("lucid.agents.v1", JSON.stringify(doc));
    }, folders).catch(() => {});
    // A stopped lane's process can still hold its folder for a moment on Windows; leftovers are only temp dirs.
    try { rmSync(root, { recursive: true, force: true }); } catch { /* the OS temp cleanup takes it */ }
  }
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_rail_live_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const url = process.env.LUCID_DEMO_URL;
  if ((!endpoint && !browserURL) || !url) throw new Error("Set LUCID_DEMO_CDP_URL (or LUCID_DEMO_BROWSER_URL) and LUCID_DEMO_URL.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(endpoint ? { browserWSEndpoint: endpoint } : { browserURL }), defaultViewport: null, protocolTimeout: 120_000 });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url));
    if (!page) throw new Error(`No page at ${url}`);
    console.log(JSON.stringify(await verifyRailLive(page), null, 2));
    console.log("P-FLEET.CONN1 live passed: with every agent's turn streamed by the window, the rail matched the engine's working/idle state within one poll cycle and the window kept answering.");
  } finally { await browser.disconnect(); }
}
