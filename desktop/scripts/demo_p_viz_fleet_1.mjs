// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_viz_fleet_1.mjs
//
// P-VIZ.FLEET1 (ADR-0680): Visualize (Agent Worlds) draws every running fleet lane, not only the spokes born under
// the current Main session. Against an isolated QA engine (scripted fake agent) it:
//   1. starts a Main session (hub A) and spawns two lanes under it;
//   2. starts a new Main session (hub B), so the engine reports both lanes under the older hub, the state an upgrade's
//      restart or a New session leaves behind;
//   3. opens Visualize in the real UI and asserts both lanes are drawn as agents (the scene probe) and the header's
//      census says so. Before the fix the scene showed "0 agents" while the ledger counted them.
//
// Run (QA engine: bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7821, and a Chrome with a CDP port):
//   LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7821/ node desktop/scripts/demo_p_viz_fleet_1.mjs

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

async function engineApi(base) {
  const html = await (await fetch(base)).text();
  const token = /<meta name="lucid-token" content="([^"]+)"/.exec(html)?.[1];
  assert(token, "no lucid-token meta on the engine page");
  const headers = { "x-lucid-token": token, "content-type": "application/json" };
  return async (path, body) => {
    const r = await fetch(new URL(path, base), body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    return { status: r.status, data: j?.data ?? j };
  };
}

export async function verifyVizFleet(page, base) {
  const api = await engineApi(base);
  // 1. hub A with two lanes
  const a = await api("/api/newSession", { force: true });
  assert(a.status < 400, `newSession (hub A) failed: HTTP ${a.status}`);
  const ws = (await api("/api/workspace")).data?.current;
  const ids = [];
  for (const name of ["viz-fleet-one", "viz-fleet-two"]) {
    const r = await api("/api/fleet/spawn", { name, ...(ws ? { cwd: ws } : {}) });
    const id = r.data?.lane?.id ?? r.data?.id;
    assert(id, `spawn ${name} failed: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    ids.push(id);
  }
  const hubA = (await api("/api/fleet/status")).data?.hub;
  // 2. hub B: the lanes now belong to an older Main session
  const b = await api("/api/newSession", { force: true });
  assert(b.status < 400, `newSession (hub B) failed: HTTP ${b.status}`);
  let st = null;
  for (let i = 0; i < 40; i++) {
    st = (await api("/api/fleet/status")).data;
    if (st?.hub && st.hub !== hubA) break;
    await pause(250);
  }
  const lanes = (st?.lanes ?? []).filter((l) => ids.includes(l.id));
  assert(lanes.length === 2, `the engine does not list both lanes: ${JSON.stringify(st?.lanes?.map((l) => l.id))}`);
  assert(st.hub && lanes.every((l) => l.hubSessionId && l.hubSessionId !== st.hub), `precondition: the lanes must sit under an older hub (hub ${st.hub}, lanes ${lanes.map((l) => l.hubSessionId)})`);

  // 3. Visualize, opened with the real control
  await page.goto(new URL("?vizScript=1", base).href, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ctViz", { timeout: 30000 });
  for (let i = 0; i < 6; i++) {
    const hit = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((n) => /^\s*(Skip|No - standard use|Later)/.test(n.textContent || "") && n.getBoundingClientRect().width > 0);
      if (b) { b.click(); return true; }
      return false;
    });
    if (!hit) break;
    await pause(700);
  }
  for (const t of await page.$$("#toasts .toast .h button")) await t.click().catch(() => {});
  const c = await page.$eval("#ctViz", (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(c.x, c.y);
  await page.waitForSelector("#vizView [data-viz-ledger]", { visible: true, timeout: 15000 });
  let drawn = [];
  for (let i = 0; i < 60; i++) {
    drawn = ((await page.evaluate(() => window.__vizProbe?.nodes?.() ?? [])) || []).filter((n) => n.kind === "agent").map((n) => n.id);
    if (ids.every((id) => drawn.includes(id))) break;
    await pause(500);
  }
  const census = await page.evaluate(() => document.querySelector("#vizView .viz-census, #vizView [data-viz-census]")?.textContent?.replace(/\s+/g, " ").trim() ?? "");
  assert(ids.every((id) => drawn.includes(id)), `Visualize draws ${drawn.length} agent(s) ${JSON.stringify(drawn)}; the fleet runs ${ids.length} under an older hub (census: "${census}")`);
  const agentsInCensus = Number(/(\d+)\s+agents?/.exec(census)?.[1] ?? NaN);
  assert(agentsInCensus >= ids.length, `the header census says "${census}", not ${ids.length} or more agents`);
  return { hub: st.hub, olderHub: lanes[0].hubSessionId, lanes: ids, drawn, census };
}

async function main() {
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const wsEndpoint = process.env.LUCID_DEMO_CDP_URL;
  const base = process.env.LUCID_DEMO_URL;
  if ((!browserURL && !wsEndpoint) || !base) {
    console.log("demo_p_viz_fleet_1: set LUCID_DEMO_BROWSER_URL (or LUCID_DEMO_CDP_URL) and LUCID_DEMO_URL to an isolated QA engine.");
    return;
  }
  assert(new URL(base).hostname === "127.0.0.1", "LUCID_DEMO_URL must be an isolated QA engine on 127.0.0.1");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(wsEndpoint ? { browserWSEndpoint: wsEndpoint } : { browserURL }), defaultViewport: null });
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.setViewport({ width: 1400, height: 900 });
    const r = await verifyVizFleet(page, base);
    console.log(JSON.stringify(r, null, 2));
    console.log("P-VIZ.FLEET1 passed: lanes born under an older Main session are drawn in Visualize and counted in its header.");
  } finally {
    browser.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("demo_p_viz_fleet_1.mjs")) {
  main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
}
