// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_rail_agents_1c.mjs
//
// P-RAIL.AGENTS1c: real-browser proof that "+ Add agent" on the rail's Agents view opens a two-step popover instead of
// jumping straight to the OS folder dialog. Driven with real mouse and keyboard input against an isolated QA engine.
// A folder is made a recent workspace (switched to and back) and hidden from the rail, so it is offered as a recent
// folder. In a wide (1600x1000) and a narrow (1100x800) window:
//   1. a click on the Add box opens the popover (no OS dialog): it explains what an Agent is and that it lives in one
//      folder, offers the recent folder and "Choose a folder…", sits fully on screen, every control is topmost at its
//      center, auditBoxes passes; Esc closes it and focus returns to the Add box;
//   2. the recent folder leads to step 2: the name field holds the folder's auto name, the four purposes (the
//      workspace setup's app / docs / analysis / other) are offered, Add is disabled until one is chosen; Back returns
//      to step 1; auditBoxes passes;
//   3. typing in the name field replaces the auto name; Add puts the Agent at the top of the rail with that name and
//      purpose (persisted in lucid.agents.v1) and a toast says so;
//   4. the Agent's hover module shows its purpose line;
//   5. a click outside closes the popover without adding anything.
//
// Setup (an isolated QA engine and browser, never a user's session):
//   bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811
//   open http://127.0.0.1:7811/ in the QA browser (remote debugging on), past the first-run gates, Main idle.
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_rail_agents_1c.mjs
// The QA root defaults to <tmp>/lucid-qa-fleet-<port> (from fleet.json); LUCID_DEMO_QA_ROOT overrides it.

import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const AGENTS_KEY = "lucid.agents.v1";
const VIEW_KEY = "lucid.rail.view";

const norm = (p) => { const s = String(p).trim().replace(/[\\/]+/g, "/"); return (s.length > 1 ? s.replace(/\/$/, "") : s).toLowerCase(); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function verifyAddAgent(page, opts = {}) {
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

  // ── a recent folder that is not on the rail ──
  const folder = join(fleet.root ?? join(fleet.workspace, "..", ".."), "workspace", "agents", "add-flow-site");
  mkdirSync(folder, { recursive: true });
  const fid = norm(folder);
  const home = (await api("/api/workspace"))?.current ?? fleet.workspace;
  await api("/api/workspace", { path: folder });
  await api("/api/workspace", { path: home });
  const info = await api("/api/workspace");
  assert((info?.recent ?? []).some((r) => norm(r.path ?? r) === fid), `the QA engine did not list ${folder} as a recent workspace`);
  const doc = { v: 1, agents: [], hidden: [fid], manual: false, main: null };

  // ── page helpers ──
  const topmost = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return b.width > 0 && n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
  const center = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width }; });
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
  const clickReal = async (sel, what) => {
    if (!(await topmost(sel))) await dismissToasts();
    const c = await center(sel);
    assert(c.w > 0, `${what} is not visible`);
    assert(await topmost(sel), `${what} is covered (elementFromPoint at its center hits something else)`);
    await page.mouse.click(c.x, c.y);
  };
  const audit = async (sel, where) => {
    const found = await page.evaluate(auditBoxes, sel, MIN_GAP);
    assert(found.length === 0, `${where} spacing: ${found.join("; ")}`);
  };
  const addOpen = () => page.evaluate(() => !!document.querySelector(".agr-add-pop.show"));
  const onScreen = () => page.$eval(".agr-add-pop", (n) => { const b = n.getBoundingClientRect(); return b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight; });
  const allTopmost = async (where) => {
    const sels = await page.$$eval(".agr-add-pop.show button, .agr-add-pop.show input", (ns) => ns.map((n, i) => { n.dataset.qaHit = String(i); return `[data-qa-hit="${i}"]`; }));
    for (const s of sels) assert(await topmost(s), `${where}: ${s} is covered at its center`);
  };
  const stored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), AGENTS_KEY);
  const seedAndReload = async () => {
    await page.evaluate((k, d, vk) => { localStorage.setItem(k, JSON.stringify(d)); localStorage.setItem(vk, "agents"); }, AGENTS_KEY, doc, VIEW_KEY);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#railAgents", { timeout: 20000 });
    if (!(await page.$eval("#inspector", (n) => n.classList.contains("rail")))) { await page.click("#inspCollapse"); await pause(400); }
    await page.waitForSelector("[data-agr-add]", { visible: true, timeout: 15000 });
    await pause(500);
  };

  const cdp = await page.target().createCDPSession();
  try {
    for (const size of SIZES) {
      const label = `${size.name} ${size.width}x${size.height}`;
      const entry = { size: label };
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      await seedAndReload();
      await dismissToasts();
      assert(!(await page.$(`.agr-tile[data-agent="${fid}"]`)), `${label}: the hidden folder is on the rail before it was added`);
      await page.$eval("[data-agr-add]", (n) => n.scrollIntoView({ block: "nearest" }));
      await pause(200);

      // 1. the explanation step
      await clickReal("[data-agr-add]", `${label}: + Add agent`);
      await page.waitForSelector(".agr-add-pop.show", { timeout: 3000 }).catch(() => { throw new Error(`${label}: + Add agent opened no popover (the OS dialog path?)`); });
      await pause(300);
      const intro = await page.$eval(".agr-add-pop", (n) => n.innerText.replace(/\s+/g, " "));
      assert(/mini Lucid that lives in one folder/i.test(intro), `${label}: step 1 does not explain what an Agent is: ${intro.slice(0, 160)}`);
      assert(await page.$(`.agr-add-pop [data-add-path]`), `${label}: step 1 offers no recent folder`);
      assert(await page.$('.agr-add-pop [data-add-act="pick"]'), `${label}: step 1 has no Choose a folder button`);
      assert(await onScreen(), `${label}: step 1 is not fully on screen`);
      await allTopmost(`${label} step 1`);
      await audit(".agr-add-pop", `${label} step 1`);
      await page.keyboard.press("Escape");
      await pause(250);
      assert(!(await addOpen()), `${label}: Esc did not close step 1`);
      assert(await page.evaluate(() => document.activeElement?.matches("[data-agr-add]") ?? false), `${label}: focus did not return to the Add box`);
      entry.intro = "explains Agents, offers the recent folder and the folder dialog, Esc closes";

      // 2. the purpose step, Back, and again
      await clickReal("[data-agr-add]", `${label}: + Add agent (again)`);
      await page.waitForSelector(".agr-add-pop.show [data-add-path]", { timeout: 3000 });
      const recentSel = await page.$$eval(".agr-add-pop [data-add-path]", (ns, fid) => {
        const norm = (p) => { const s = String(p).trim().replace(/[\\/]+/g, "/"); return (s.length > 1 ? s.replace(/\/$/, "") : s).toLowerCase(); };
        const i = ns.findIndex((n) => norm(n.dataset.addPath) === fid);
        if (i >= 0) ns[i].dataset.qaRecent = "1";
        return i >= 0 ? '[data-qa-recent="1"]' : null;
      }, fid);
      assert(recentSel, `${label}: step 1 does not offer ${folder}`);
      await clickReal(`.agr-add-pop ${recentSel}`, `${label}: the recent folder`);
      await page.waitForSelector(".agr-add-pop.show [data-add-kind]", { timeout: 3000 });
      await pause(250);
      const kind = await page.evaluate(() => ({
        name: document.querySelector(".agr-add-pop [data-add-name]")?.value,
        kinds: [...document.querySelectorAll(".agr-add-pop [data-add-kind]")].map((n) => n.dataset.addKind),
        addDisabled: document.querySelector('.agr-add-pop [data-add-act="add"]')?.disabled,
      }));
      assert(kind.name === "add-flow-site", `${label}: the name field holds ${JSON.stringify(kind.name)}, not the folder's auto name`);
      assert(JSON.stringify(kind.kinds) === JSON.stringify(["app", "docs", "analysis", "other"]), `${label}: purposes offered ${kind.kinds}`);
      assert(kind.addDisabled === true, `${label}: Add is enabled before a purpose is chosen`);
      assert(await onScreen(), `${label}: step 2 is not fully on screen`);
      await allTopmost(`${label} step 2`);
      await audit(".agr-add-pop", `${label} step 2`);
      await clickReal('.agr-add-pop [data-add-act="back"]', `${label}: Back`);
      await page.waitForSelector(".agr-add-pop.show [data-add-path]", { timeout: 3000 });
      await page.$$eval(".agr-add-pop [data-add-path]", (ns, fid) => {
        const norm = (p) => { const s = String(p).trim().replace(/[\\/]+/g, "/"); return (s.length > 1 ? s.replace(/\/$/, "") : s).toLowerCase(); };
        ns.find((n) => norm(n.dataset.addPath) === fid)?.setAttribute("data-qa-recent", "1");
      }, fid);
      await clickReal('.agr-add-pop [data-qa-recent="1"]', `${label}: the recent folder (after Back)`);
      await page.waitForSelector(".agr-add-pop.show [data-add-kind]", { timeout: 3000 });
      await pause(200);
      await clickReal('.agr-add-pop [data-add-kind="docs"]', `${label}: Analyze documents`);
      const pressed = await page.$$eval(".agr-add-pop [data-add-kind]", (ns) => ns.filter((n) => n.getAttribute("aria-pressed") === "true").map((n) => n.dataset.addKind));
      assert(JSON.stringify(pressed) === '["docs"]', `${label}: pressed purposes ${pressed}`);
      assert(!(await page.$eval('.agr-add-pop [data-add-act="add"]', (n) => n.disabled)), `${label}: Add stays disabled after a purpose is chosen`);
      entry.kind = "auto name, four purposes, Add gated on a choice, Back works";

      // 3. name it and add it
      await clickReal(".agr-add-pop [data-add-name]", `${label}: the name field`);
      await page.keyboard.type("Client Docs");
      assert((await page.$eval(".agr-add-pop [data-add-name]", (n) => n.value)) === "Client Docs", `${label}: typing did not replace the auto name`);
      await clickReal('.agr-add-pop [data-add-act="add"]', `${label}: Add agent`);
      await pause(500);
      assert(!(await addOpen()), `${label}: the popover stayed open after Add`);
      const d = await stored();
      const rec = d?.agents?.find((a) => a.id === fid);
      assert(rec && rec.name === "Client Docs" && rec.purpose === "docs" && !d.hidden.includes(fid), `${label}: stored ${JSON.stringify(rec)} hidden=${JSON.stringify(d?.hidden)}`);
      const first = await page.$eval(".agr-tile[data-agent]", (n) => ({ id: n.dataset.agent, label: n.querySelector(".l")?.textContent }));
      assert(first.id === fid && /client docs/i.test(first.label ?? ""), `${label}: the top Agent is ${JSON.stringify(first)}`);
      const toast = await page.$$eval("#toasts .toast", (ts) => ts.map((t) => t.innerText.replace(/\s+/g, " ")).join(" | "));
      assert(/Client Docs is on your rail/.test(toast), `${label}: no "on your rail" toast (${toast})`);
      entry.added = `"${first.label}" on top, purpose docs persisted`;
      await dismissToasts();

      // 4. the module shows the purpose
      const r = await page.$eval(`.agr-tile[data-agent="${fid}"]`, (n) => { const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
      await page.mouse.move(r.x, r.y);
      await page.waitForSelector(".agr-pop.show:not(.agr-add-pop) .agr-ph-kind", { timeout: 3000 }).catch(() => { throw new Error(`${label}: the hover module has no purpose line`); });
      const line = await page.$eval(".agr-pop.show:not(.agr-add-pop) .agr-ph-kind", (n) => n.textContent);
      assert(/document/i.test(line), `${label}: the purpose line reads ${JSON.stringify(line)}`);
      entry.module = line;
      await page.mouse.move(Math.round(size.width * 0.4), Math.round(size.height * 0.5));
      await page.keyboard.press("Escape");
      await pause(400);

      // 5. an outside click closes without adding
      await page.evaluate((k, d) => localStorage.setItem(k, JSON.stringify(d)), AGENTS_KEY, doc);
      await seedAndReload();
      await dismissToasts();
      await clickReal("[data-agr-add]", `${label}: + Add agent (outside-click check)`);
      await page.waitForSelector(".agr-add-pop.show", { timeout: 3000 });
      await page.mouse.click(Math.round(size.width * 0.4), Math.round(size.height * 0.4));
      await pause(300);
      assert(!(await addOpen()), `${label}: an outside click did not close the popover`);
      assert(!((await stored())?.agents ?? []).some((a) => a.id === fid), `${label}: an outside click added the Agent`);
      entry.outside = "closes, adds nothing";
      results.push(entry);
    }
  } finally {
    await page.evaluate((k) => localStorage.removeItem(k), AGENTS_KEY).catch(() => {});
    await api("/api/workspace/recent-remove", { path: folder }).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_rail_agents_1c.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyAddAgent(page), null, 2));
    console.log("P-RAIL.AGENTS1c passed: + Add agent explains Agents and their folder first, then asks the name and purpose, adds the Agent on top with both persisted, its module shows the purpose, and Esc or an outside click adds nothing, wide and narrow.");
  } finally { await browser.disconnect(); }
}
