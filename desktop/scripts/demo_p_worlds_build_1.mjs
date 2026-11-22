// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_worlds_build_1.mjs
//
// P-WORLDS.BUILD1 (ADR-0653): real-browser proof of world build sites and the sandboxed artifact popup. On the
// ?vizDemo=1 feed (Main, demo-1 to demo-6; one build per demo agent a cycle on the build channel), with real input:
//   1. builds run from the event stream: scaffolding appears (pieces), pieces lock in, one flickers red (a failed
//      tool), and the build reveals with an artifact (the labeled demo sample); the scene's scaffold follows the book;
//   2. the artifact chip over the node is the topmost element at its center, and a real click opens the popup;
//   3. the popup asks the engine's security gate first (verdict pass), says Untrusted and Demo sample, and runs
//      nothing until Play; Play loads an iframe with sandbox="allow-scripts" (never allow-same-origin) whose served
//      frame carries the CSP default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
//   4. inside: the game's script ran (body[data-ready]) and plays (a click on Play spawns targets), and it has no
//      network (fetch to the engine is refused) and no reach into LUCID (parent.document and localStorage throw);
//   5. a blocked artifact (a bidi-control character) gets no id from the gate, so it can never render;
//   6. Keep marks the artifact kept; Discard closes the popup and removes the chip;
//   7. auditBoxes (desktop/scripts/demo_p_spacing_1.mjs) passes on the popup and on a node panel with its Mini game
//      row, in the current window and in a narrow one (820 x 640).
// The caller owns the page and the engine. LUCID_DEMO_WORLD_KEY draws the builds in an installed world (its build
// sites, else the default ring); default: the current style.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 [LUCID_DEMO_WORLD_KEY=<key>] node desktop/scripts/demo_p_worlds_build_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const AGENTS = ["demo-1", "demo-2", "demo-3", "demo-4", "demo-5", "demo-6"];
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";

export async function verifyBuild(page, worldKey = null) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  const probe = (fn, ...args) => page.evaluate((f, a) => window.__vizProbe?.[f]?.(...a), fn, args);
  const topmostAt = (x, y, sel) => page.evaluate((px, py, s) => !!document.elementFromPoint(px, py)?.closest(s), x, y, sel);
  const topmost = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
  const audit = async (root) => { const bad = await page.evaluate(auditBoxes, root, MIN_GAP); assert(bad.length === 0, `spacing on ${root}: ${bad.join(" | ")}`); };

  if (!(await page.$("#vizView [data-viz-ledger]"))) await page.click("#ctViz");
  await page.waitForSelector("#vizView [data-viz-stage]", { visible: true, timeout: 15000 });
  await pause(1500);
  for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});
  assert((await page.evaluate(() => typeof window.__vizProbe?.builds)) === "function", "the probe has no builds(): this build predates P-WORLDS.BUILD1");
  if (worldKey) {
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) { ok = !!(await probe("style", `world:${worldKey}`)); if (!ok) await pause(500); }
    assert(ok, `the world "${worldKey}" cannot be drawn: ${JSON.stringify(await probe("worlds"))}`);
    await pause(2000);
  }
  // Fit takes the camera off auto, so the chips hold still for a click
  assert(await topmost("#vizView [data-viz-fit]"), "the Fit button is covered");
  await page.click("#vizView [data-viz-fit]");

  // 1. builds from the event stream (one demo cycle is 48 s; the first reveal comes about 12 s in)
  const saw = { pieces: 0, locked: 0, failed: 0, revealed: new Set(), scaffoldMatches: 0, scaffolds: 0 };
  let target = null;
  for (let i = 0; i < 240 && (saw.revealed.size < 2 || !target); i++) {
    const bs = (await probe("builds")) ?? [];
    for (const b of bs) {
      saw.pieces = Math.max(saw.pieces, b.pieces); saw.locked = Math.max(saw.locked, b.locked); saw.failed = Math.max(saw.failed, b.failed);
      if (b.scaffold) { saw.scaffolds++; if (b.scaffold.revealed === b.revealed) saw.scaffoldMatches++; }
      if (b.revealed && b.artifact) saw.revealed.add(b.id);
      if (AGENTS.includes(b.id) && b.artifact?.demo && b.chip && !target) target = b;
    }
    if (saw.revealed.size < 2 || !target) await pause(250);
  }
  assert(saw.pieces >= 2 && saw.locked >= 1, `no scaffolding built up: ${JSON.stringify({ ...saw, revealed: [...saw.revealed] })}`);
  assert(saw.failed >= 1, "no piece flickered red on a failed tool");
  assert(saw.scaffolds > 0 && saw.scaffoldMatches === saw.scaffolds, "the scene's scaffold does not follow the build book");
  assert(target, `no revealed build put a demo artifact chip on screen: ${JSON.stringify(await probe("builds"))}`);
  assert(target.artifact.title.includes("demo sample"), `the artifact is not labeled a demo sample: ${target.artifact.title}`);

  const openPopup = async () => {
    const b = ((await probe("builds")) ?? []).find((x) => x.id === target.id);
    assert(b?.chip, `the chip over ${target.id} is gone`);
    assert(await topmostAt(b.chip.x, b.chip.y, `[data-viz-art-chip="${target.id}"]`), `the chip over ${target.id} is covered`);
    await page.mouse.click(b.chip.x, b.chip.y);
    await page.waitForSelector(".popover.viz-art-pop [data-viz-art]", { visible: true, timeout: 5000 });
    let st = null;
    for (let i = 0; i < 40; i++) { st = await probe("artifact"); if (st?.verdict && st.verdict !== "pending") break; await pause(250); }
    return st;
  };

  // 2, 3. the chip opens the popup; the gate answers first; nothing runs before Play
  let st = await openPopup();
  assert(st?.open && st.id === target.artifact.id, `the popup did not open on the artifact: ${JSON.stringify(st)}`);
  assert(st.verdict === "pass", `the security gate did not pass the demo sample: ${JSON.stringify(st)}`);
  assert(!st.playing && !(await page.$(".popover.viz-art-pop iframe")), "something rendered before Play");
  const tags = await page.$$eval(".popover.viz-art-pop .viz-art-tag", (ns) => ns.map((n) => n.textContent.trim()));
  assert(tags.includes("Untrusted") && tags.includes("Demo sample"), `the popup labels are ${JSON.stringify(tags)}`);
  await audit(".popover.viz-art-pop");
  assert(await topmost(".popover.viz-art-pop [data-viz-art-play]"), "Play is covered");
  await page.click(".popover.viz-art-pop [data-viz-art-play]");
  await page.waitForSelector(".popover.viz-art-pop iframe[data-viz-art-frame]", { timeout: 5000 });
  st = await probe("artifact");
  assert(st.playing && st.sandbox === "allow-scripts", `the iframe sandbox is ${st.sandbox}`);
  assert(!/allow-same-origin/.test(st.sandbox ?? ""), "the iframe is same-origin");
  assert((st.src ?? "").startsWith("/api/viz/artifact/frame?id="), `the iframe src is ${st.src}`);
  const head = await page.evaluate(async (src) => { const r = await fetch(src, { cache: "no-store" }); return { status: r.status, csp: r.headers.get("content-security-policy"), body: await r.text() }; }, st.src);
  assert(head.status === 200 && (head.csp ?? "").startsWith(CSP), `the frame's CSP is ${head.csp}`);
  assert(/<iframe sandbox="allow-scripts"[^>]*srcdoc="/.test(head.body) && !/allow-same-origin/.test(head.body), "the served frame does not hold the artifact in a sandboxed srcdoc child");

  // 4. inside the frame: it runs, it plays, it reaches nothing
  const engine = new URL(page.url()).origin;
  let game = null;
  for (let i = 0; i < 40 && !game; i++) {
    game = page.frames().find((f) => f.url() === "about:srcdoc" && f.parentFrame()?.url().includes("/api/viz/artifact/frame")) ?? null;
    if (!game) await pause(250);
  }
  assert(game, "the artifact's srcdoc frame never loaded");
  const inside = await game.evaluate(async (origin) => {
    const out = { ready: document.body?.dataset.ready === "1", title: document.title, net: "open", parent: "open", storage: "open" };
    try { await fetch(`${origin}/api/health`, { cache: "no-store" }); } catch { out.net = "blocked"; }
    try { void parent.document.title; } catch { out.parent = "blocked"; }
    try { void window.localStorage.length; } catch { out.storage = "blocked"; }
    return out;
  }, engine);
  assert(inside.ready, "the game's inline script did not run under the frame's CSP");
  assert(/demo sample/i.test(inside.title), `the game is not labeled a demo sample: ${inside.title}`);
  assert(inside.net === "blocked", "the artifact reached the network");
  assert(inside.parent === "blocked" && inside.storage === "blocked", `the artifact reached LUCID: ${JSON.stringify(inside)}`);
  const outerNet = await game.parentFrame().evaluate(async (origin) => { try { await fetch(`${origin}/api/health`); return "open"; } catch { return "blocked"; } }, engine);
  assert(outerNet === "blocked", "the served frame reached the network");
  await game.evaluate(() => document.getElementById("start")?.click());
  await pause(900);
  assert((await game.$$(".t")).length > 0, "the game does not play (no targets after Play)");

  // 5. a blocked artifact gets no id, so it can never render
  const blocked = await page.evaluate(async () => {
    const t = window.lucid?.token?.() || document.querySelector('meta[name="lucid-token"]')?.content || "";
    const r = await fetch("/api/viz/artifact", { method: "POST", headers: { "content-type": "application/json", ...(t ? { "x-lucid-token": t } : {}) }, body: JSON.stringify({ html: "<div>evil\u202Etxt.exe</div>" }) });
    return (await r.json())?.data ?? null;
  });
  assert(blocked && blocked.ok === false && !blocked.id && typeof blocked.reason === "string", `a bidi-control artifact was not blocked: ${JSON.stringify(blocked)}`);

  // 6. Keep, then Discard
  await page.click(".popover.viz-art-pop [data-viz-art-keep]");
  await pause(200);
  assert(((await probe("builds")) ?? []).find((x) => x.id === target.id)?.artifact?.kept === true, "Keep did not keep the artifact");

  // 7. spacing in a narrow window too, and the node panel's Mini game row
  await page.keyboard.press("Escape");
  await pause(300);
  const auditSurfaces = async () => {
    const nodes = (await probe("nodes")) ?? [];
    const n = nodes.find((x) => x.id === target.id);
    if (n?.box && (await topmostAt(n.box.x, n.box.y, "#vizView canvas"))) {
      await page.mouse.click(n.box.x, n.box.y);
      await pause(700); // a single click waits out the double-click window
      if (await page.$("#vizView [data-viz-panel]:not([hidden]) .viz-panel-build")) await audit("#vizView [data-viz-panel]");
      await page.keyboard.press("Escape");
      await pause(300);
    }
    st = await openPopup();
    assert(st?.verdict === "pass", `the popup did not reopen: ${JSON.stringify(st)}`);
    await audit(".popover.viz-art-pop");
  };
  await auditSurfaces();
  await page.keyboard.press("Escape");
  await pause(300);
  await page.setViewport({ width: 820, height: 640 }); // a narrow window
  await pause(1200);
  await page.click("#vizView [data-viz-fit]").catch(() => {});
  await pause(2000);
  await auditSurfaces();
  await page.click(".popover.viz-art-pop [data-viz-art-discard]");
  await pause(300);
  assert(!(await page.$(".popover.viz-art-pop")), "Discard did not close the popup");
  const after = ((await probe("builds")) ?? []).find((x) => x.id === target.id);
  assert(!after?.artifact && !(await page.$(`[data-viz-art-chip="${target.id}"]`)), "Discard left the artifact or its chip");
  await page.setViewport(null).catch(() => {});

  assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  return { node: target.id, artifact: target.artifact.title, builds: { maxPieces: saw.pieces, maxLocked: saw.locked, sawFail: saw.failed, revealed: [...saw.revealed] }, frameCsp: head.csp, inside, blocked: blocked.reason };
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_worlds_build_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL (an isolated QA page at <engine>/?vizDemo=1).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyBuild(page, process.env.LUCID_DEMO_WORLD_KEY || null), null, 2));
    console.log("P-WORLDS.BUILD1 passed: the demo builds ran from the event stream, the chip opened the gated popup, and the artifact ran sandboxed with no network.");
  } finally { await browser.disconnect(); }
}
