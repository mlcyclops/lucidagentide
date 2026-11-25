// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_viz_tray_2.mjs
//
// P-VIZ.TRAY2 (ADR-0690): the throw tray's reactions group, driven in the real UI against an isolated QA engine whose
// lanes are working (scripted fake agents). On a FRESH browser profile it:
//   1. clears the first-run gates, opens Visualize (?vizScript=1: real agents plus the read-only __vizProbe) with the
//      real control and waits for working lanes;
//   2. at 1600 px, in Anime 3D: the group starts folded (the chevron is hit-testable, aria-expanded false, the tray
//      clean under auditBoxes and clear of the legend, the ledger pill and any toast); the chevron folds it out; every
//      reaction is hit-testable, a real click makes every figure start it (__vizProbe.trayReactions().started) and puts
//      that button in its cooldown (.cool, aria-disabled, probe.cooling); the open tray is clean too; Esc folds it
//      back in (focus on the chevron, Visualize still open, the reactions out of reach);
//   3. the state persists: folded out, reloaded, opened again: still out; folded in, reloaded: still in;
//   4. the same in Professional (3D) and in 2D;
//   5. at 1000 px: the open and folded tray are hit-testable, clean, inside the stage and clear of the neighbors.
//
// Run (QA engine: bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7821; lanes working:
// bun desktop/scripts/fleet_demo/seed_fleet.mjs http://127.0.0.1:7821/ --every 20 --lanes 6; a Chrome with a CDP port
// and a fresh --user-data-dir):
//   LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7821/ node desktop/scripts/demo_p_viz_tray_2.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

/** viz_tray_reactions.TRAY_REACTION_COOLDOWN_MS, and a margin. */
const COOLDOWN_MS = 4500;
const GATES = "#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]";
const MORE = "#vizView [data-viz-throw-more]";
const STAGE = "#vizView [data-viz-stage]";

/** First-run gates on a fresh profile: click whatever shows, until 8 checks in a row find nothing (40 tries at most). */
async function clearGates(page) {
  let empty = 0;
  for (let i = 0; i < 40 && empty < 8; i++) {
    const hit = await page.evaluate((sel) => {
      const b = [...document.querySelectorAll(sel)].find((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (b) { b.click(); return true; }
      return false;
    }, GATES);
    empty = hit ? 0 : empty + 1;
    await pause(450);
  }
  for (const t of await page.$$("#toasts .toast .h button")) await t.click().catch(() => {});
}

/** The element's center, asserted to be what the pointer would hit there (document.elementFromPoint); a tray control
 *  is also a 24 px target or more. */
async function hitTest(page, sel, target = true) {
  const r = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return { ok: false, top: "nothing matches" };
    const b = el.getBoundingClientRect();
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const top = document.elementFromPoint(x, y);
    return { ok: !!top && (top === el || el.contains(top)), x, y, w: b.width, h: b.height, top: top ? `${top.tagName.toLowerCase()}.${[...top.classList].join(".")}` : "nothing" };
  }, sel);
  assert(r.ok, `${sel} is not hit-testable at its center (the pointer hits ${r.top})`);
  assert(!target || (r.w >= 24 && r.h >= 24), `${sel} is ${r.w}x${r.h}, too small a target`);
  return r;
}

async function click(page, sel, target = true) {
  // onboarding can still raise a gate (the work email step) after Visualize opened: skip it with its own control
  for (let i = 0; i < 6; i++) {
    const gate = await page.$(GATES);
    if (!gate) break;
    await gate.click().catch(() => {});
    await pause(400);
  }
  const c = await hitTest(page, sel, target);
  await page.mouse.click(c.x, c.y);
  return c;
}

const probe = (page) => page.evaluate(() => window.__vizProbe?.trayReactions?.() ?? null);

async function openViz(page, base) {
  await page.goto(new URL("?vizScript=1", base).href, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ctViz", { timeout: 30000 });
  await clearGates(page);
  await click(page, "#ctViz", false);
  await page.waitForSelector("#vizView [data-viz-ledger]", { visible: true, timeout: 15000 });
  await page.waitForSelector(MORE, { visible: true, timeout: 15000 });
  for (const t of await page.$$("#toasts .toast .h button")) await t.click().catch(() => {});
}

/** The figures on screen; waits for at least `min` (Main plus working lanes). */
async function figures(page, min) {
  let list = [];
  for (let i = 0; i < 120; i++) {
    list = ((await page.evaluate(() => window.__vizProbe?.nodes?.() ?? [])) || []).filter((n) => n.box);
    if (list.length >= min && list.some((n) => n.kind === "agent")) return list;
    await pause(500);
  }
  throw new Error(`Visualize draws ${list.length} figure(s); start the lanes (seed_fleet.mjs) first`);
}

async function pick(page, attr, value) {
  const sel = `#vizView [${attr}="${value}"]`;
  if ((await page.$eval(sel, (b) => b.getAttribute("aria-pressed"))) !== "true") await click(page, sel, false);
  for (let i = 0; i < 20 && (await page.$eval(sel, (b) => b.getAttribute("aria-pressed"))) !== "true"; i++) await pause(250);
  assert((await page.$eval(sel, (b) => b.getAttribute("aria-pressed"))) === "true", `${sel} did not take`);
  await pause(1500); // the figures rebuild
}

/** The tray is inside the stage and touches no neighbor: auditBoxes inside it and around it, and no overlap with the
 *  legend, the ledger pill or a toast. */
async function layout(page, where) {
  const inside = await page.evaluate(auditBoxes, "#vizView .viz-throw", MIN_GAP);
  const around = (await page.evaluate(auditBoxes, STAGE, MIN_GAP)).filter((p) => /viz-throw|viz-react/.test(p));
  const problems = [...inside, ...around];
  assert(problems.length === 0, `${where}: auditBoxes: ${problems.join("; ")}`);
  const l = await page.evaluate((stageSel) => {
    const shown = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && Number(s.opacity) > 0.05; };
    const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    const stage = document.querySelector(stageSel), tray = document.querySelector("#vizView .viz-throw");
    const near = [...document.querySelectorAll("#vizView .viz-legend > *, #vizView .viz-ledger-pill, #toasts .toast")].filter(shown)
      .map((e) => ({ name: `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}`, r: box(e) }));
    return { stage: box(stage), tray: box(tray), near };
  }, STAGE);
  const { stage, tray } = l;
  assert(tray.left >= stage.left && tray.right <= stage.right && tray.top >= stage.top && tray.bottom <= stage.bottom, `${where}: the tray leaves the stage ${JSON.stringify(l)}`);
  const mid = (stage.left + stage.right) / 2, trayMid = (tray.left + tray.right) / 2;
  assert(Math.abs(mid - trayMid) <= 2, `${where}: the tray is not centered (${trayMid} vs ${mid})`);
  for (const n of l.near) {
    const ox = Math.min(tray.right, n.r.right) - Math.max(tray.left, n.r.left), oy = Math.min(tray.bottom, n.r.bottom) - Math.max(tray.top, n.r.top);
    assert(!(ox > 0 && oy > 0), `${where}: the tray overlaps ${n.name}`);
  }
  return { width: Math.round(tray.right - tray.left) };
}

async function setOpen(page, want) {
  if ((await probe(page))?.open !== want) await click(page, MORE);
  await pause(400); // the fold animation
  const p = await probe(page);
  assert(p?.open === want && p.saved === want, `the reactions group is not ${want ? "open" : "folded"}: ${JSON.stringify(p)}`);
  assert((await page.$eval(MORE, (b) => b.getAttribute("aria-expanded"))) === String(want), "aria-expanded does not follow the group");
  const group = await page.$eval("#vizReactGroup", (g) => ({ role: g.getAttribute("role"), label: g.getAttribute("aria-label"), inert: g.hasAttribute("inert") }));
  assert(group.role === "group" && group.label === "Reactions" && group.inert === !want, `the group's semantics: ${JSON.stringify(group)}`);
}

/** Fold out, click every reaction and see every figure play it and the button cool down, audit, Esc folds it in. */
async function exercise(page, where) {
  const shown = await figures(page, 2);
  await setOpen(page, false);
  await hitTest(page, MORE);
  const folded = await layout(page, `${where}, folded`);
  await setOpen(page, true);
  const open = await layout(page, `${where}, open`);
  assert(open.width > folded.width + 100, `${where}: the tray did not widen (${folded.width} -> ${open.width} px)`);
  const kinds = (await probe(page)).kinds;
  assert(kinds.join() === "celebrate,wave,coffee,dance", `${where}: the tray offers ${kinds}`);
  const played = {};
  for (const kind of kinds) {
    const sel = `#vizView [data-viz-react="${kind}"]`;
    // every figure on screen when the button is clicked plays it (a subagent that leaves meanwhile is not counted)
    const before = (await figures(page, 2)).map((n) => n.id);
    const clickAt = await page.evaluate(() => performance.now());
    await click(page, sel);
    await pause(150);
    const cool = await page.$eval(sel, (b) => ({ cool: b.classList.contains("cool"), disabled: b.getAttribute("aria-disabled") }));
    assert(cool.cool && cool.disabled === "true" && (await probe(page)).cooling.includes(kind), `${where}: ${kind} shows no cooldown ${JSON.stringify(cool)}`);
    // reach is read from the start each figure recorded (kept after its part ends), so a slow poll never races it
    const reached = new Set();
    let still = before;
    const until = Date.now() + 8000; // the widest stagger (1.3 s) plus a loaded page's slow frames
    while (Date.now() < until) {
      const p = await probe(page);
      for (const [id, r] of Object.entries(p.started)) if (r.kind === kind && r.startedAt >= clickAt) reached.add(id);
      const now = new Set((await figures(page, 1)).map((n) => n.id));
      still = before.filter((id) => now.has(id));
      if (still.every((id) => reached.has(id))) break;
      await pause(100);
    }
    const missed = still.filter((id) => !reached.has(id));
    if (still.length < 2 || missed.length) {
      const q = await page.evaluate(() => { const x = window.__vizProbe?.quality?.(); return x ? { tier: x.tier, steppedFrom: x.steppedFrom } : null; });
      const p = await probe(page);
      throw new Error(`${where}: ${kind} did not reach ${missed.length} of ${still.length} figures (${missed.map((id) => `${id}: ${JSON.stringify(p.started[id] ?? null)}`).join(", ")}; quality ${JSON.stringify(q)})`);
    }
    played[kind] = still.length;
  }
  await layout(page, `${where}, open after the reactions`);
  const last = await page.$eval(`#vizView [data-viz-react="${kinds[kinds.length - 1]}"]`, (b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.keyboard.press("Escape");
  await pause(400);
  const after = await page.evaluate((x, y) => ({
    viz: !document.querySelector("#vizView")?.hidden,
    focus: document.activeElement?.hasAttribute("data-viz-throw-more") ?? false,
    under: document.elementFromPoint(x, y)?.closest("[data-viz-react]")?.getAttribute("data-viz-react") ?? null,
  }), last.x, last.y);
  assert(after.viz, `${where}: Esc closed Visualize instead of folding the reactions`);
  assert((await probe(page)).open === false, `${where}: Esc did not fold the reactions`);
  assert(after.focus, `${where}: focus did not return to the chevron`);
  assert(after.under === null, `${where}: a folded reaction (${after.under}) is still under the pointer`);
  await layout(page, `${where}, folded by Esc`);
  return { figures: shown.length, played, width: { folded: folded.width, open: open.width } };
}

export async function verifyTrayReactions(page, base) {
  const out = {};
  await page.setViewport({ width: 1600, height: 900 });
  await openViz(page, base);
  const first = await probe(page);
  assert(first && first.open === false && first.saved === false, `the reactions group must start folded on a fresh profile: ${JSON.stringify(first)}`);
  await pick(page, "data-viz-view", "3d");
  await pick(page, "data-viz-style", "anime");
  out.anime = await exercise(page, "Anime 3D at 1600 px");

  // persistence, both ways, across a reload
  await setOpen(page, true);
  await openViz(page, base);
  assert((await probe(page))?.open === true, "the open reactions group did not survive a reload");
  assert(await page.$eval("#vizView .viz-throw", (t) => t.classList.contains("open")), "the reloaded tray is not drawn open");
  await setOpen(page, false);
  await openViz(page, base);
  assert((await probe(page))?.open === false, "the folded reactions group did not survive a reload");
  out.persisted = true;

  await pick(page, "data-viz-style", "professional");
  out.professional = await exercise(page, "Professional 3D at 1600 px");
  await pause(COOLDOWN_MS + 300); // Professional's cooldowns run out
  await pick(page, "data-viz-style", "anime");
  await pick(page, "data-viz-view", "2d");
  out.map2d = await exercise(page, "Anime 2D at 1600 px");
  await pick(page, "data-viz-view", "3d");

  await page.setViewport({ width: 1000, height: 800 });
  await pause(800);
  await pause(COOLDOWN_MS); // the 2D run's cooldowns run out
  out.narrow = await exercise(page, "Anime 3D at 1000 px");
  return out;
}

async function main() {
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const wsEndpoint = process.env.LUCID_DEMO_CDP_URL;
  const base = process.env.LUCID_DEMO_URL;
  if ((!browserURL && !wsEndpoint) || !base) {
    console.log("demo_p_viz_tray_2: set LUCID_DEMO_BROWSER_URL (or LUCID_DEMO_CDP_URL) and LUCID_DEMO_URL to an isolated QA engine.");
    return;
  }
  assert(new URL(base).hostname === "127.0.0.1", "LUCID_DEMO_URL must be an isolated QA engine on 127.0.0.1");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(wsEndpoint ? { browserWSEndpoint: wsEndpoint } : { browserURL }), defaultViewport: null });
  // A fresh browser context per run: its own localStorage, so "starts folded on a fresh profile" holds on a re-run.
  const ctx = await browser.createBrowserContext();
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
    const r = await verifyTrayReactions(page, base);
    assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
    console.log(JSON.stringify(r, null, 2));
    console.log("P-VIZ.TRAY2 passed: the reactions group folds out and back (chevron, Esc), persists, every reaction reaches every figure with its own cooldown in Anime, Professional and 2D, and the tray stays centered, clean and clear of its neighbors at 1600 and 1000 px.");
  } finally {
    await ctx.close().catch(() => {});
    browser.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("demo_p_viz_tray_2.mjs")) {
  main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
}
