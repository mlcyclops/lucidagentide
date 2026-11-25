// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_asklucid_speed_1.mjs
//
// P-ASKLUCID.SPEED1: real-UI proof that Ask Lucid shows what he is doing while he answers, and says which model
// answered and how long it took. Driven with real input (the toolbar button, typing, Enter) in a wide (1600x1000)
// and a narrow (1100x800) window, docked right:
//   1. within half a second of asking, a waiting line sits in the conversation, topmost at its center, on one line
//      (white-space:nowrap) with a timer;
//   2. while he works the line follows the engine's phases (at least two distinct lines, one of them naming the
//      model, e.g. "Asking Claude Haiku 4.5" / "Starting Claude Haiku 4.5" / "Claude Haiku 4.5 is writing") and the
//      timer counts up;
//   3. the answer replaces it, and the line under the answer says "Answered by <model> in <n> s".
// It reports the measured time to the answer.
//
// Run against any engine window with remote debugging on (a QA engine, or a dev build):
//   LUCID_DEMO_CDP_URL=ws://... (or LUCID_DEMO_BROWSER_URL=http://127.0.0.1:9340) LUCID_DEMO_URL=http://127.0.0.1:5401/ \
//     node desktop/scripts/demo_p_asklucid_speed_1.mjs

const SIZES = [{ name: "wide", width: 1600, height: 1000 }, { name: "narrow", width: 1100, height: 800 }];
const QUESTION = "In one short sentence: what is Ask Lucid for?";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function verifyAskLucidWait(page) {
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const results = [];
  const cdp = await page.target().createCDPSession();
  const topmost = (sel) => page.evaluate((s) => {
    const n = document.querySelector(s);
    const r = n?.getBoundingClientRect();
    if (!r || r.width === 0) return null;
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { ok: !!at && n.contains(at), ws: getComputedStyle(n.querySelector(".al-wait-t")).whiteSpace, h: r.height };
  }, sel);
  try {
    for (const size of SIZES) {
      const label = size.name;
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      await pause(600);
      // open Ask Lucid with the toolbar button, docked right
      if (!(await page.$(".ald.al-dock:not([hidden])"))) {
        const b = await page.$("#tbAskLucid");
        assert(b, `${label}: no Ask Lucid button`);
        await b.click();
      }
      await page.waitForSelector(".ald.al-dock textarea", { visible: true, timeout: 8000 });
      await page.evaluate(() => document.querySelector('.ald.al-dock [data-mode="right"], .ald.al-dock [data-dock="right"]')?.click());
      await pause(500);
      // P-ASKLUCID.SPEED1b: docked right, he flies out to the LEFT of the right rail, over the page, and nothing is
      // pushed aside for him.
      const place = await page.evaluate(() => {
        const d = document.querySelector(".ald.al-dock").getBoundingClientRect();
        const ins = document.querySelector("#inspector")?.getBoundingClientRect();
        const at = document.elementFromPoint(d.left + d.width / 2, d.top + d.height / 2);
        return { dockRight: d.right, dockLeft: d.left, insLeft: ins?.left ?? null, insRight: ins?.right ?? null, vw: innerWidth, onTop: !!at?.closest(".ald.al-dock"), reserved: document.documentElement.classList.contains("ask-r") };
      });
      assert(place.insLeft !== null && Math.abs(place.dockRight - place.insLeft) <= 2 && place.insRight >= place.vw - 2, `${label}: Ask Lucid is not flying out left of the right rail (${JSON.stringify(place)})`);
      assert(place.onTop && !place.reserved, `${label}: Ask Lucid is under something or pushes the page aside (${JSON.stringify(place)})`);
      const ta = await page.$(".ald.al-dock textarea");
      await ta.click();
      await page.keyboard.type(QUESTION);
      const answersBefore = await page.$$eval(".ald.al-dock .al-msg.al-lucid", (ns) => ns.length);
      const asked = Date.now();
      await page.keyboard.press("Enter");
      // 1. the waiting line, at once
      await page.waitForSelector(".ald.al-dock .al-wait", { visible: true, timeout: 500 }).catch(() => { throw new Error(`${label}: no waiting line within 500 ms of asking`); });
      const tm = await topmost(".ald.al-dock .al-wait");
      assert(tm?.ok, `${label}: the waiting line is covered`);
      assert(tm.ws === "nowrap", `${label}: the waiting line wraps (${tm.ws})`);
      // 2. phases and timer while he works; 3. the answer
      const lines = new Set();
      const timeline = [];
      const clocks = new Set();
      let answered = false;
      for (const end = Date.now() + 120_000; Date.now() < end;) {
        const s = await page.evaluate((n) => {
          const w = document.querySelector(".ald.al-dock .al-wait");
          const answers = document.querySelectorAll(".ald.al-dock .al-msg.al-lucid").length;
          const err = document.querySelector(".ald.al-dock .al-msg.al-err:last-child");
          return { line: w?.querySelector(".al-wait-t")?.textContent ?? null, clock: w?.querySelector(".al-wait-time")?.textContent ?? null, answered: answers > n, err: err?.textContent ?? null };
        }, answersBefore);
        if (s.line && !lines.has(s.line)) timeline.push(`${((Date.now() - asked) / 1000).toFixed(1)}s ${s.line}`);
        if (s.line) lines.add(s.line);
        if (s.clock) clocks.add(s.clock);
        if (s.answered || s.err) { answered = s.answered; if (s.err) throw new Error(`${label}: Ask Lucid answered with an error: ${s.err}`); break; }
        await pause(150);
      }
      const tookMs = Date.now() - asked;
      assert(answered, `${label}: no answer within 2 minutes (lines seen: ${[...lines].join(" | ")})`);
      assert(!(await page.$(".ald.al-dock .al-wait")), `${label}: the waiting line stayed after the answer`);
      assert(lines.size >= 2, `${label}: the waiting line never moved past its first phase (${[...lines].join(" | ")})`);
      assert([...lines].some((l) => (/^(Asking|Starting) /.test(l) || / is writing$/.test(l)) && !/the model/.test(l)), `${label}: the waiting line never named the model (${[...lines].join(" | ")})`);
      assert(clocks.size >= 2 || tookMs < 1500, `${label}: the timer did not count (${[...clocks].join(",")})`);
      const meta = await page.$$eval(".ald.al-dock .al-msg.al-lucid", (ns) => ns[ns.length - 1]?.nextElementSibling?.textContent ?? ns[ns.length - 1]?.querySelector(".al-meta")?.textContent ?? "");
      const metaAll = meta || (await page.$$eval(".ald.al-dock .al-meta", (ns) => ns.map((n) => n.textContent).join(" | ")));
      assert(/Answered by .+ in \d+(\.\d)? s\./.test(metaAll), `${label}: the answer does not say which model answered and how long it took (${metaAll.slice(0, 300)})`);
      results.push({ size: label, tookMs, timeline, answeredBy: (metaAll.match(/Answered by .+? in [\d.]+ s/) ?? [""])[0] });
      if (process.env.LUCID_DEMO_SHOTS) await page.screenshot({ path: `${process.env.LUCID_DEMO_SHOTS}/asklucid-${label}.png` }).catch(() => {});
    }
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_asklucid_speed_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const url = process.env.LUCID_DEMO_URL;
  if ((!endpoint && !browserURL) || !url) throw new Error("Set LUCID_DEMO_CDP_URL (or LUCID_DEMO_BROWSER_URL) and LUCID_DEMO_URL.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(endpoint ? { browserWSEndpoint: endpoint } : { browserURL }), defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url));
    if (!page) throw new Error(`No page at ${url}`);
    console.log(JSON.stringify(await verifyAskLucidWait(page), null, 2));
    console.log("P-ASKLUCID.SPEED1 passed: a waiting line appears at once, follows the engine's phases with the model named and a timer, and the answer says which model answered and how long it took, wide and narrow.");
  } finally { await browser.disconnect(); }
}
