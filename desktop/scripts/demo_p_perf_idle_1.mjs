// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_perf_idle_1.mjs
//
// P-PERF.IDLE1: real-UI proof that opening LUCID runs no git, and that git runs only when the user asks for it.
//   1. The page is reloaded (the renderer's whole boot: dashboard refresh, repo chip, Agents rail and fleet polls)
//      and every process the engine starts is watched for WATCH_S seconds: not one git.exe may appear.
//   2. The metrics rail's "lines" tile shows the remembered count (or "count" before any), topmost at its center,
//      its label on one line, and the rail passes auditBoxes, in a wide (1600x1000) and a narrow (1100x800) window.
//   3. A real click on the tile shows "..." while git counts, then the number with "Counted just now" in its tip.
//   4. (QA fleet engine) a lane works in an Agent's folder: its rail figure moves, yet no rail loop free-runs (the
//      figure is stepped 8 times a second), and no idle figure animates. LUCID_DEMO_QA_FLEET=0 skips this step.
//
// Windows only (the process watch reads Win32_Process). Run against a QA engine or a second instance, never a
// user's working session:
//   LUCID_DEMO_BROWSER_URL=http://127.0.0.1:9351 LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_perf_idle_1.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const WATCH_S = Number(process.env.LUCID_DEMO_WATCH_S || 40);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

/** The engine's pid: the process listening on the page's port. */
function enginePid(port) {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -First 1).OwningProcess`], { encoding: "utf8" });
  const pid = Number(out.trim());
  assert(pid > 0, `nothing listens on port ${port}`);
  return pid;
}

/** Every git.exe whose parent chain reaches `root`, sampled every ~300 ms for `seconds`, in one PowerShell. */
function watchGit(root, seconds) {
  const script = `
$seen = @{}; $hits = @(); $end = (Get-Date).AddSeconds(${seconds})
while ((Get-Date) -lt $end) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
  $by = @{}; foreach ($p in $all) { $by[$p.ProcessId] = $p }
  foreach ($p in $all) {
    if ($p.Name -ne 'git.exe' -or $seen.ContainsKey($p.ProcessId)) { continue }
    $c = $by[$p.ParentProcessId]; $h = 0
    while ($c -and $h -lt 10) { if ($c.ProcessId -eq ${root}) { $seen[$p.ProcessId] = 1; $hits += $p.CommandLine; break }; $c = $by[$c.ParentProcessId]; $h++ }
  }
  Start-Sleep -Milliseconds 300
}
$hits | ForEach-Object { $_ }`;
  return new Promise((resolve, reject) => {
    import("node:child_process").then(({ execFile }) => {
      execFile("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      });
    });
  });
}

const tile = (page) => page.evaluate(() => {
  const t = document.querySelector('#railTiles [data-tile="lines"]');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const l = t.querySelector(".l");
  return { n: t.querySelector(".n")?.textContent ?? "", tip: t.getAttribute("data-tip") ?? "", onTop: !!at && t.contains(at), ws: l ? getComputedStyle(l).whiteSpace : "", oneLine: l ? l.scrollWidth <= l.clientWidth + 1 : false, w: r.width };
});

/** 4. A real QA lane works in an Agent's folder (the fake ACP's release-notes script): its rail figure moves, yet no
 *  CSS animation free-runs on the rail, so Chromium draws only the 8 steps a second; and every idle figure is still. */
async function verifySteppedFigures(page) {
  const port = new URL(page.url()).port;
  const fleet = JSON.parse(readFileSync(join(process.env.LUCID_DEMO_QA_ROOT ?? join(tmpdir(), `lucid-qa-fleet-${port}`), "fleet.json"), "utf8"));
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content);
  const api = (path, body) => page.evaluate(async (p, b, t) => {
    const res = await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", "x-lucid-token": t }, ...(b ? { body: JSON.stringify(b) } : {}) });
    const j = await res.json();
    return j?.data ?? j;
  }, path, body ?? null, token);
  const folder = join(fleet.root ?? join(fleet.workspace, "..", ".."), "workspace", "agents", "idle1-step");
  mkdirSync(folder, { recursive: true });
  const id = String(folder).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  await page.evaluate((d) => { localStorage.setItem("lucid.agents.v1", JSON.stringify(d)); localStorage.setItem("lucid.rail.view", "agents"); },
    { v: 1, agents: [{ id, path: folder, name: null, theme: "lucid", hue: 145, saved: true }], hidden: [], manual: false, main: null });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#input", { visible: true, timeout: 60_000 });
  let spawned = null;
  for (const end = Date.now() + 240_000; ;) {
    spawned = await api("/api/fleet/spawn", { cwd: folder, name: "Idle1 step" });
    if (spawned?.ok !== false || !/has been at \d+%/.test(spawned?.reason ?? "") || Date.now() > end) break;
    await pause(5000);
  }
  const laneId = spawned?.lane?.id;
  assert(laneId, `the QA lane did not spawn (${JSON.stringify(spawned).slice(0, 200)})`);
  try {
    for (const end = Date.now() + 60_000; ; await pause(300)) {
      const st = ((await api("/api/fleet/status"))?.lanes ?? []).find((l) => l.id === laneId)?.status;
      if (st && st !== "starting") break;
      assert(Date.now() < end, "the QA lane never became ready");
    }
    // the prompt route streams the turn; fire it from the page and never parse it
    await page.evaluate((lid, t) => { void fetch("/api/fleet/prompt", { method: "POST", headers: { "content-type": "application/json", "x-lucid-token": t }, body: JSON.stringify({ laneId: lid, text: "[script release-notes] Write the release notes and changelog" }) }).then((r) => r.text()).catch(() => {}); }, laneId, token);
    const tile = `.agr-list .agr-tile[data-agent="${id}"]`;
    for (const end = Date.now() + 30_000; ; await pause(200)) {
      if (await page.$eval(tile, (n) => n.classList.contains("work")).catch(() => false)) break;
      assert(Date.now() < end, "the Agent's box never showed its lane working");
    }
    const read = () => page.evaluate((s) => ({
      tail: getComputedStyle(document.querySelector(`${s} .agr-tail`)).transform,
      // CSS animations only: a state change's short transitions (the tile brightening) end on their own
      running: document.getAnimations().filter((a) => a instanceof CSSAnimation && a.playState === "running" && a.effect?.target?.closest?.(".agr-list")).map((a) => a.animationName),
    }), tile);
    const poses = new Set();
    let running = [];
    for (let i = 0; i < 8; i++) { const r = await read(); poses.add(r.tail); running = running.concat(r.running); await pause(260); }
    assert(poses.size >= 3, `the working figure did not move (${poses.size} distinct poses in 2 s)`);
    assert(running.filter((n) => n !== "agrBlinkG" && n !== "agrGaze" && n !== "agrHeadG").length === 0, `rail loops are free-running: ${[...new Set(running)].join(", ")}`);
    return { poses: poses.size, freeRunning: 0 };
  } finally {
    await api("/api/fleet/stop", { laneId }).catch(() => {});
  }
}

export async function verifyNoGitAtOpen(page, port) {
  const results = { gitAtOpen: [], sizes: [] };
  const root = enginePid(port);
  const watching = watchGit(root, WATCH_S);
  await page.evaluate(() => localStorage.setItem("lucid.perfMode", "full"));
  await page.reload({ waitUntil: "domcontentloaded" });
  results.gitAtOpen = await watching;
  assert(results.gitAtOpen.length === 0, `git ran while LUCID opened, before anything asked for it:\n${results.gitAtOpen.join("\n")}`);

  // the lines tile lives on the metrics face of the right rail: flip it there with the real toggle if Agents shows
  for (let i = 0; i < 5; i++) {
    const agentsToggle = await page.$('.agr-toggle[aria-pressed="true"]');
    if (!agentsToggle) break;
    await agentsToggle.click();
    await pause(700);
  }
  assert(!(await page.$('.agr-toggle[aria-pressed="true"]')), "the right rail would not flip from Agents to metrics");
  const cdp = await page.target().createCDPSession();
  try {
    for (const size of SIZES) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      await pause(800);
      const t = await tile(page);
      assert(t, `${size.name}: no lines tile on the metrics rail`);
      assert(t.n === "count" || /^\+[\d.,]+[kKmM]?$/.test(t.n), `${size.name}: the lines tile shows "${t.n}", not a remembered count or "count"`);
      assert(t.onTop, `${size.name}: the lines tile is covered at its center`);
      assert(t.oneLine, `${size.name}: the lines tile label wraps or is clipped`);
      const boxes = await page.evaluate(auditBoxes, "#metricsRail", MIN_GAP);
      assert(boxes.length === 0, `${size.name}: auditBoxes on the metrics rail:\n${boxes.join("\n")}`);
      results.sizes.push({ size: size.name, before: t.n });
    }
    // 3. the user asks: a real click on the tile
    const before = await tile(page);
    // a recount of unmoved repos can finish in a few ms, so the "..." state is recorded by an observer, not by polling
    await page.evaluate(() => {
      window.__linesSeen = [];
      const rail = document.querySelector("#railTiles");
      new MutationObserver(() => { const n = rail.querySelector('[data-tile="lines"] .n')?.textContent; if (n) window.__linesSeen.push(n); })
        .observe(rail, { childList: true, subtree: true, characterData: true });
    });
    const el = await page.$('#railTiles [data-tile="lines"]');
    await el.click();
    let sawCounting = false;
    let after = null;
    for (const end = Date.now() + 180_000; Date.now() < end; await pause(150)) {
      sawCounting = await page.evaluate(() => window.__linesSeen.includes("..."));
      const t = await tile(page);
      if (sawCounting && t && t.n !== "...") { after = t; break; }
    }
    assert(sawCounting, "the lines tile never showed it was counting after the click");
    assert(after && /^\+[\d.,]+[kKmM]?$/.test(after.n), `the lines tile did not show a count after the click (${after?.n})`);
    assert(/Counted just now/.test(after.tip), `the tip does not say when it was counted (${after.tip})`);
    results.click = { before: before.n, after: after.n };
    if (process.env.LUCID_DEMO_QA_FLEET !== "0") results.working = await verifySteppedFigures(page);
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_perf_idle_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const url = process.env.LUCID_DEMO_URL;
  if ((!endpoint && !browserURL) || !url) throw new Error("Set LUCID_DEMO_CDP_URL (or LUCID_DEMO_BROWSER_URL) and LUCID_DEMO_URL.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(endpoint ? { browserWSEndpoint: endpoint } : { browserURL }), defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url));
    if (!page) throw new Error(`No page at ${url}`);
    console.log(JSON.stringify(await verifyNoGitAtOpen(page, Number(new URL(url).port)), null, 2));
    console.log(`P-PERF.IDLE1 passed: no git ran in the ${WATCH_S} s after LUCID opened; the lines tile shows the remembered count and counts with git only when clicked, wide and narrow${process.env.LUCID_DEMO_QA_FLEET !== "0" ? "; a working Agent's figure moves in steps while no rail loop free-runs" : ""}.`);
  } finally { await browser.disconnect(); }
}
