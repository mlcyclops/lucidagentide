// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_fleet_drain_1.mjs
//
// P-FLEET.DRAIN1 (ADR-0644): real-browser proof that a staged lane prompt runs exactly once when status polls
// answer late and out of order (what a machine at 100% CPU does). Every other GET /api/fleet/status is answered
// by the engine at once but handed to the page 4 s later, so a poll asked before a drain lands after it. Three
// prompts are staged on one idle lane through the engine's queue, one after another. It asserts on the lane's
// Fleet card, as the user sees it:
//   1. each prompt shows up exactly once as a user turn;
//   2. no red "queue is empty" line appears (the engine's answer to a second drain of an already-popped head);
//   3. the engine ran each prompt once (its transcript holds one user turn per prompt).
// Before the fix, a late poll put the popped prompt back into the card's queue and the drain's end ran it a
// second time: the card printed the prompt twice and "queue is empty" in red.
// The caller owns the page (an engine with at least one signed-in lane) and leaves the Fleet dock open.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/ LUCID_DEMO_LANE=<lane id> node desktop/scripts/demo_p_fleet_drain_1.mjs

export async function verifyDrainOnce(page, laneId) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content);
  const api = (path, body) => page.evaluate(async (p, b, t) => {
    const r = await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", "x-lucid-token": t }, body: b ? JSON.stringify(b) : undefined });
    return r.json();
  }, path, body ?? null, token);
  const lane = async () => (await api("/api/fleet/status")).data.lanes.find((l) => l.id === laneId);
  assert(await page.$("#fleetDock"), "open the Fleet dock first");
  const start = await lane();
  assert(start, `no lane ${laneId}`);
  for (let i = 0; i < 60 && !["done", "awaiting-input"].includes((await lane()).status); i++) await pause(1000);

  // the late, out-of-order status answers
  let n = 0;
  const onRequest = async (r) => {
    if (r.url().includes("/api/fleet/status") && n++ % 2 === 0) {
      try {
        const res = await fetch(r.url(), { headers: r.headers() });
        const body = await res.text();
        setTimeout(() => r.respond({ status: res.status, contentType: "application/json", body }).catch(() => {}), 4000);
      } catch { r.continue().catch(() => {}); }
    } else r.continue().catch(() => {});
  };
  await page.setRequestInterception(true);
  page.on("request", onRequest);
  const stamp = Date.now().toString(36);
  const words = ["alpha", "bravo", "charlie"].map((w) => `${w}-${stamp}`);
  try {
    for (const w of words) {
      await api("/api/fleet/queue", { laneId, text: `Reply with exactly: ${w}.` });
      await pause(9000);
    }
    await pause(6000);
  } finally {
    page.off("request", onRequest);
    await page.setRequestInterception(false);
  }

  const card = await page.evaluate((id) => {
    const el = document.querySelector(`#fleetDock .fleet-card[data-lane="${id}"]`);
    return el ? el.innerText : null;
  }, laneId);
  assert(card !== null, `no Fleet card for ${laneId}`);
  const shown = words.map((w) => (card.match(new RegExp(`Reply with exactly: ${w}`, "g")) ?? []).length);
  assert(shown.every((c) => c === 1), `each staged prompt must show once on the card, saw ${shown.join(", ")}`);
  assert(!/queue is empty/.test(card), "the card shows a red \"queue is empty\": a drained prompt was drained again");
  const tr = await api(`/api/fleet/transcript?laneId=${encodeURIComponent(laneId)}`);
  const users = (tr.data?.turns ?? []).filter((t) => t.role === "user").map((t) => t.text);
  const ran = words.map((w) => users.filter((t) => t.includes(w)).length);
  assert(ran.every((c) => c === 1), `the engine must run each prompt once, ran ${ran.join(", ")}`);
  return { shown, ran, delayedPolls: Math.ceil(n / 2) };
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_fleet_drain_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  const laneId = process.env.LUCID_DEMO_LANE;
  if (!endpoint || !url || !laneId) throw new Error("Set LUCID_DEMO_CDP_URL, LUCID_DEMO_URL and LUCID_DEMO_LANE (a signed-in lane on that engine).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyDrainOnce(page, laneId), null, 2));
    console.log("P-FLEET.DRAIN1 passed: with late, out-of-order status polls each staged prompt ran once, showed once, and no \"queue is empty\" appeared.");
  } finally { await browser.disconnect(); }
}
