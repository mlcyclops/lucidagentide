// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_worlds_games_3.mjs
//
// P-WORLDS.GAMES3 (ADR-0691): real-browser proof that the host's three built-in mini games (Target tap, Memory cards,
// Agent runner) play with real input in the artifact popup. Against an isolated QA engine on a fresh profile it:
//   1. clears the first-run gates, opens Visualize (?vizDemo=1) with the real control, switches to a built-in style,
//      opens an agent's node panel and asserts the Mini game rows list the three host templates, each with Build and
//      Play sample topmost; auditBoxes (demo_p_spacing_1.mjs) on the rows;
//   2. for each game: a real click on Play sample opens the popup through the security gate (verdict pass); Play loads
//      the sandboxed frame; the game's start screen renders and its Play button is topmost inside the frame; a real
//      click starts it (body[data-state] play); the in-frame Pause, Sound and Restart buttons are topmost;
//   3. real clicks drive it for about four seconds (live targets, face-down cards, the runner's lanes, from
//      window.__sampleProbe), and screenshots of the iframe's box change over time; the game made progress (a score,
//      a flipped card);
//   4. P pauses (state paused, the overlay shows, two screenshots are the same frame), P resumes (state play, frames
//      move again), M toggles the sound button both ways;
//   5. the popup's Restart, Keep, Discard, Close and resize grip are topmost and the popup passes auditBoxes; the grip's
//      arrow keys shrink the game and the canvas follows the frame at its device pixel ratio, and focus leaving the
//      frame pauses the game;
//   6. no page error, no console error while a game plays, and no error event inside any game frame.
//
// Run (QA engine: bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7821, and a Chrome with a CDP port on a fresh
// profile):
//   LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7821/ node desktop/scripts/demo_p_worlds_games_3.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const POP = ".popover.viz-art-pop";
const FRAME = `${POP} iframe[data-viz-art-frame]`;
const GATES = "#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]";
const HOST_GAMES = ["target-tap", "memory-cards", "agent-runner"];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

async function clearGates(page) {
  let empty = 0;
  for (let i = 0; i < 40 && empty < 8; i++) {
    const hit = await page.evaluate((sel) => {
      const n = [...document.querySelectorAll(sel)].find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (!n) return false;
      n.click();
      return true;
    }, GATES).catch(() => false);
    empty = hit ? 0 : empty + 1;
    await pause(450);
  }
}

export async function verifyGames(page, base) {
  const pageErrors = [];
  const consoleErrors = [];
  let playing = null;
  page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/\/favicon\.ico$/.test(m.location()?.url ?? "")) return; // the engine page's favicon, not a game
    consoleErrors.push({ game: playing, text: m.text(), url: m.location()?.url ?? "" });
  });
  const probe = (fn, ...args) => page.evaluate((f, a) => window.__vizProbe?.[f]?.(...a), fn, args);
  const topmostAt = (x, y, sel) => page.evaluate((px, py, s) => !!document.elementFromPoint(px, py)?.closest(s), x, y, sel);
  const topmost = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return b.width > 0 && n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
  const audit = async (root) => { const bad = await page.evaluate(auditBoxes, root, MIN_GAP); assert(bad.length === 0, `spacing on ${root}: ${bad.join(" | ")}`); };
  const center = (sel) => page.$eval(sel, (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  // A toast or the hover tip can pass over a control for a moment: dismiss toasts and give it up to 3 s, then the
  // control must be on top (and the message names what covers it).
  const coveredBy = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return h ? `${h.tagName.toLowerCase()}.${[...h.classList].join(".")}` : "nothing"; });
  const realClick = async (sel) => {
    for (let i = 0; i < 12 && !(await topmost(sel)); i++) {
      for (const t of await page.$$("#toasts .toast .h button")) await t.click().catch(() => {});
      await page.mouse.move(2, 2);
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(await topmost(sel), `${sel} is covered by ${await coveredBy(sel)}`);
    const c = await center(sel);
    await page.mouse.click(c.x, c.y);
  };

  // 1. Visualize on the demo feed, opened with the real control
  await page.goto(new URL("?vizDemo=1", base).href, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ctViz", { timeout: 30000 });
  await clearGates(page);
  // Fly to approvals (on by default) would move the camera off the nodes this demo clicks; it is read at load
  if ((await page.evaluate(() => localStorage.getItem("lucid.viz.flyToApprovals.v1"))) !== "0") {
    await page.evaluate(() => localStorage.setItem("lucid.viz.flyToApprovals.v1", "0"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ctViz", { timeout: 30000 });
    await clearGates(page);
  }
  for (const t of await page.$$("#toasts .toast .h button")) await t.click().catch(() => {});
  if (!(await page.$("#vizView [data-viz-ledger]"))) await realClick("#ctViz");
  await page.waitForSelector("#vizView [data-viz-stage]", { visible: true, timeout: 15000 });
  await pause(1500);
  for (const t of await page.$$("#toasts .toast .h button")) await t.click().catch(() => {});
  assert((await page.evaluate(() => typeof window.__vizProbe?.artifact)) === "function", "the probe has no artifact(): this build predates P-WORLDS.BUILD1");
  assert(await probe("style", "anime"), "cannot switch to the built-in anime style (the host's templates belong to the built-in styles)");
  await pause(1500);
  await realClick("#vizView [data-viz-fit]");
  await pause(1500);

  /** One pass over the first-run gates: a late one (the work email step) is skipped with its own control. */
  const skipGate = async () => {
    const hit = await page.evaluate((sel) => { const n = [...document.querySelectorAll(sel)].find((b) => b.getBoundingClientRect().width > 0); if (n) n.click(); return !!n; }, GATES).catch(() => false);
    if (hit) await pause(450);
    return hit;
  };
  /** On top at its center, after any late gate is skipped. */
  const onTop = async (sel) => { for (let i = 0; i < 6; i++) { if (await topmost(sel)) return true; if (!(await skipGate())) await pause(300); } return topmost(sel); };
  const openPanel = async () => {
    for (let i = 0; i < 20; i++) {
      await skipGate(); // onboarding can raise a gate (the work email step) after Visualize opened
      const nodes = ((await probe("nodes")) ?? []).filter((n) => n.kind !== "subagent" && n.box);
      nodes.sort((a, b) => (a.kind === "agent" ? 0 : 1) - (b.kind === "agent" ? 0 : 1));
      for (const n of nodes) {
        if (!(await topmostAt(n.box.x, n.box.y, "#vizView canvas"))) continue;
        await page.mouse.click(n.box.x, n.box.y);
        await pause(700); // a single click waits out the double-click window
        if (await page.$("#vizView [data-viz-panel]:not([hidden]) .viz-panel-build [data-viz-game-sample]")) return n;
        await page.keyboard.press("Escape");
        await pause(300);
      }
      await pause(500);
    }
    return null;
  };
  const node = await openPanel();
  assert(node, "no node panel showed a Mini game row with Play sample");
  const rows = await page.$$eval("#vizView [data-viz-panel] [data-viz-game-row]", (rs) => rs.map((r) => ({
    id: r.dataset.vizGameRow,
    label: r.querySelector(".viz-panel-game-l")?.textContent.trim() ?? "",
    build: !!r.querySelector("[data-viz-game]"),
    sample: !!r.querySelector("[data-viz-game-sample]"),
  })));
  assert(JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(HOST_GAMES) && rows.every((r) => r.label && r.build && r.sample), `the Mini game rows are ${JSON.stringify(rows)}`);
  for (const r of rows) {
    assert(await onTop(`#vizView [data-viz-panel] [data-viz-game-row="${r.id}"] [data-viz-game]`), `Build for ${r.id} is covered`);
    assert(await onTop(`#vizView [data-viz-panel] [data-viz-game-sample="${r.id}"]`), `Play sample for ${r.id} is covered`);
  }
  await audit("#vizView [data-viz-panel] .viz-panel-build");

  // screenshots of the iframe's box: real pixels, and how much two of them differ
  const frameBox = () => page.$eval(FRAME, (f) => { const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, ox: r.left + f.clientLeft, oy: r.top + f.clientTop }; });
  const shot = async () => { const b = await frameBox(); return page.screenshot({ clip: { x: b.x, y: b.y, width: b.width, height: b.height }, encoding: "base64", type: "png" }); };
  const pixels = (b64) => page.evaluate(async (s) => {
    const img = new Image();
    img.src = `data:image/png;base64,${s}`;
    await img.decode();
    const g = document.createElement("canvas"); g.width = 96; g.height = 60;
    const x = g.getContext("2d"); x.drawImage(img, 0, 0, 96, 60);
    const d = x.getImageData(0, 0, 96, 60).data;
    let min = 255, max = 0, lit = 0;
    const colors = new Set();
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      min = Math.min(min, l); max = Math.max(max, l);
      if (l > 90) lit++;
      colors.add(`${d[i] >> 5},${d[i + 1] >> 5},${d[i + 2] >> 5}`);
    }
    return { spread: max - min, colors: colors.size, lit: lit / (d.length / 4) };
  }, b64);
  const diff = (a, b) => page.evaluate(async (pa, pb) => {
    const load = async (s) => {
      const img = new Image();
      img.src = `data:image/png;base64,${s}`;
      await img.decode();
      const g = document.createElement("canvas"); g.width = 160; g.height = 100;
      const x = g.getContext("2d"); x.drawImage(img, 0, 0, 160, 100);
      return x.getImageData(0, 0, 160, 100).data;
    };
    const p = await load(pa), q = await load(pb);
    let n = 0;
    for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 24) n++;
    return n / (p.length / 4);
  }, a, b);

  const findGame = async (src) => {
    const idPart = (src.match(/id=[^&]+/) ?? [""])[0];
    for (let i = 0; i < 40; i++) {
      const f = page.frames().find((x) => x.url() === "about:srcdoc" && x.parentFrame()?.url().includes(idPart)) ?? null;
      if (f && (await f.evaluate(() => document.body?.dataset.ready === "1").catch(() => false))) return f;
      await pause(250);
    }
    return null;
  };

  const playGame = async (row) => {
    // 2. Play sample, through the gate, into the sandboxed frame
    const sel = `#vizView [data-viz-panel] [data-viz-game-sample="${row.id}"]`;
    if (!(await page.$(sel))) assert(await openPanel(), "the node panel did not reopen");
    await realClick(sel);
    await page.waitForSelector(`${POP} [data-viz-art]`, { visible: true, timeout: 5000 });
    let st = null;
    for (let i = 0; i < 40; i++) { st = await probe("artifact"); if (st?.verdict && st.verdict !== "pending") break; await pause(250); }
    assert(st?.open && st.title === row.label && st.verdict === "pass", `the ${row.id} sample did not pass the gate into the popup: ${JSON.stringify(st)}`);
    await realClick(`${POP} [data-viz-art-play]`);
    await page.waitForSelector(FRAME, { timeout: 5000 });
    const src = await page.$eval(FRAME, (f) => f.getAttribute("src") ?? "");
    const game = await findGame(src);
    assert(game, `the ${row.id} script never ran in its sandboxed frame`);
    playing = row.id;
    await game.evaluate(() => {
      window.__errs = [];
      window.addEventListener("error", (e) => window.__errs.push(String(e.message || e)));
      window.addEventListener("unhandledrejection", (e) => window.__errs.push(String(e.reason)));
    });
    const gp = () => game.evaluate(() => window.__sampleProbe?.() ?? null);
    const inFrameTop = (s) => game.evaluate((q) => { const n = document.querySelector(q); if (!n) return false; const r = n.getBoundingClientRect(); return r.width > 0 && n.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }, s);
    const waitState = async (want) => { let s = null; for (let i = 0; i < 30; i++) { s = (await gp())?.state; if (want.includes(s)) return s; await pause(100); } return s; };

    // the start screen renders, with its Play button topmost
    assert((await gp())?.state === "ready", `${row.id} did not open on its start screen`);
    const startPx = await pixels(await shot());
    assert(startPx.spread > 60 && startPx.colors >= 6 && startPx.lit > 0.005, `${row.id}'s start screen looks blank: ${JSON.stringify(startPx)}`);
    assert(await inFrameTop("#start"), `${row.id}'s Play button is covered inside the frame`);
    const box = await frameBox();
    const at = async (p) => page.mouse.click(box.ox + p[0], box.oy + p[1]);
    const startAt = await game.evaluate(() => { const r = document.getElementById("start").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await at(startAt);
    assert((await waitState(["play"])) === "play", `${row.id} does not play after a real click on its Play button`);
    for (const b of ["#pause", "#mute", "#restart"]) assert(await inFrameTop(b), `${row.id}'s ${b} button is covered inside the frame`);

    // 3. real input for about four seconds; the frames change over time
    const drive = async (ms) => {
      const t0 = Date.now();
      let n = 0;
      while (Date.now() - t0 < ms) {
        const pr = await gp();
        if (!pr || pr.state !== "play") break;
        const pts = pr.points ?? [];
        if (pts.length && row.id === "agent-runner") {
          // Play it like a person: read the lanes ahead (the sample's top-level vars) and dodge. Random lane taps lose
          // three lives in a few seconds, which tests the driver, not the game. pts: [left, jump, right] tap spots.
          const plan = await game.evaluate(() => {
            const on = (o, l) => o.l === l || (o.wd && o.l + 1 === l);
            const near = (l) => objs.filter((o) => !o.done && OBS[o.t] && on(o, l) && o.z > -0.9 && o.z < 7).sort((a, b) => a.z - b.z)[0] ?? null;
            const cur = near(lane);
            if (!cur) return "stay";
            if (cur.t !== "wall" && cur.z < 2.2) return "jump";
            const free = [-1, 0, 1].filter((l) => !near(l)).sort((a, b) => Math.abs(a - lane) - Math.abs(b - lane));
            if (!free.length) return cur.t === "wall" ? "stay" : "jump";
            return free[0] < lane ? "left" : free[0] > lane ? "right" : "stay";
          }).catch(() => "stay");
          const p = plan === "left" ? pts[0] : plan === "right" ? pts[2] : plan === "jump" ? pts[1] : null;
          if (p) { await at(p); n++; }
        } else if (pts.length) {
          const p = pts[Math.floor(Math.random() * pts.length)];
          if (p) { await at(p); n++; }
        }
        await pause(row.id === "memory-cards" ? 420 : 200);
      }
      return n;
    };
    const before = await gp();
    let clicks = 0;
    if (row.id === "memory-cards") {
      const p = before.points[0];
      await at(p);
      clicks++;
      await pause(200);
      const after = await gp();
      assert(after.points.length === before.points.length - 1, `a real click did not flip a card: ${before.points.length} -> ${after.points.length} face down`);
    }
    const a = await shot();
    clicks += await drive(2000);
    const b = await shot();
    clicks += await drive(2000);
    const c = await shot();
    const moving = [await diff(a, b), await diff(b, c)];
    assert(moving.every((m) => m > 0.004), `${row.id}'s frames do not change over time while played: ${JSON.stringify(moving)}`);
    const mid = await gp();
    assert(["play", "clear"].includes(mid.state), `${row.id} left play while driven: ${JSON.stringify(mid.state)}`);
    if (row.id !== "memory-cards") assert(mid.score > 0, `${row.id} scored nothing after ${clicks} real clicks`);

    // 4. P pauses and resumes; M toggles the sound
    let paused = null;
    if (mid.state === "play") {
      await page.keyboard.press("p");
      assert((await waitState(["paused"])) === "paused", `${row.id} did not pause on P`);
      assert(await game.evaluate(() => !document.getElementById("ov").hidden), `${row.id} shows no pause overlay`);
      await pause(250);
      const p1 = await shot();
      await pause(500);
      const p2 = await shot();
      paused = await diff(p1, p2);
      assert(paused < 0.003, `${row.id} keeps moving while paused: ${paused}`);
      await page.keyboard.press("p");
      assert((await waitState(["play"])) === "play", `${row.id} did not resume on P`);
      await pause(700);
      const p3 = await shot();
      const resumed = await diff(p2, p3);
      assert(resumed > 0.004, `${row.id} did not move again after resuming: ${resumed}`);
    }
    const sound = async () => game.evaluate(() => document.getElementById("mute").textContent.trim());
    await page.keyboard.press("m");
    await pause(150);
    const off = await sound();
    await page.keyboard.press("m");
    await pause(150);
    const on = await sound();
    assert(off === "Sound off" && on === "Sound on", `M did not toggle ${row.id}'s sound: ${off} / ${on}`);

    // 5. the popup's controls are topmost; the grip resizes the game, which follows the frame and pauses on blur
    for (const s of ["[data-viz-art-play]", "[data-viz-art-keep]", "[data-viz-art-discard]", "[data-viz-art-close]", "[data-viz-art-grip]"]) {
      assert(await topmost(`${POP} ${s}`), `the popup's ${s} is covered while ${row.id} plays`);
    }
    await audit(POP);
    const w0 = (await probe("artifact")).stage.w;
    await page.focus(`${POP} [data-viz-art-grip]`);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await pause(400);
    const w1 = (await probe("artifact")).stage.w;
    assert(w1 < w0 - 40, `the grip did not shrink the ${row.id} game: ${w0} -> ${w1}`);
    const fit = await game.evaluate(() => { const c = document.getElementById("c"); const r = Math.min(2, window.devicePixelRatio || 1); return { cw: c.clientWidth, w: c.width, ch: c.clientHeight, h: c.height, r }; });
    assert(Math.abs(fit.w - Math.round(fit.cw * fit.r)) <= 1 && Math.abs(fit.h - Math.round(fit.ch * fit.r)) <= 1 && Math.abs(fit.cw - w1) <= 6, `${row.id}'s canvas does not follow its frame: ${JSON.stringify(fit)} at stage ${w1}`);
    const blurred = (await gp())?.state;
    assert(["paused", "clear", "over"].includes(blurred), `${row.id} keeps playing after focus left its frame: ${blurred}`);
    const endPx = await pixels(await shot());
    assert(endPx.spread > 60 && endPx.colors >= 6, `${row.id} looks blank after the resize: ${JSON.stringify(endPx)}`);

    // 6. no error inside the frame
    const errs = await game.evaluate(() => window.__errs ?? []);
    assert(errs.length === 0, `${row.id} raised errors in its frame: ${errs.join(" | ")}`);
    playing = null;
    await realClick(`${POP} [data-viz-art-close]`);
    await pause(300);
    assert(!(await page.$(POP)), `Close did not close the ${row.id} popup`);
    return { id: row.id, verdict: st.verdict, clicks, start: startPx, moving, paused, stage: { start: w0, shrunk: w1 }, canvas: fit, score: mid.score };
  };

  const played = [];
  for (const row of rows) played.push(await playGame(row));

  const gameConsole = consoleErrors.filter((e) => e.game || e.url === "about:srcdoc" || e.url.includes("/api/viz/artifact"));
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);
  assert(gameConsole.length === 0, `console errors while a game played: ${JSON.stringify(gameConsole)}`);
  return { node: node.id, rows, played, otherConsoleErrors: consoleErrors.filter((e) => !gameConsole.includes(e)) };
}

async function main() {
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const wsEndpoint = process.env.LUCID_DEMO_CDP_URL;
  const base = process.env.LUCID_DEMO_URL;
  if ((!browserURL && !wsEndpoint) || !base) {
    console.log("demo_p_worlds_games_3: set LUCID_DEMO_BROWSER_URL (or LUCID_DEMO_CDP_URL) and LUCID_DEMO_URL to an isolated QA engine.");
    return;
  }
  assert(new URL(base).hostname === "127.0.0.1", "LUCID_DEMO_URL must be an isolated QA engine on 127.0.0.1");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(wsEndpoint ? { browserWSEndpoint: wsEndpoint } : { browserURL }), defaultViewport: null });
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.setViewport({ width: 1400, height: 900 });
    const r = await verifyGames(page, base);
    console.log(JSON.stringify(r, null, 2));
    console.log("P-WORLDS.GAMES3 passed: the three built-in mini games played with real input through the gate in the sandboxed popup, animated, paused and resumed, toggled sound, followed the resized frame and raised no errors.");
  } finally {
    browser.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("demo_p_worlds_games_3.mjs")) {
  main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
}
