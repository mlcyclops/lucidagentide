// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_worlds_build_2.mjs
//
// P-WORLDS.BUILD2 (ADR-0653): real-browser proof of template samples. On the ?vizDemo=1 feed, with real input:
//   1. a node panel's Mini game row lists each template of the current world (else the host's three) with Build and
//      Play sample; the row passes auditBoxes (desktop/scripts/demo_p_spacing_1.mjs) and Play sample is topmost;
//   2. a real click on Play sample opens the artifact popup: the engine's security gate answers first (verdict
//      pass), it is labeled Untrusted, Sample and Demo, nothing runs before Play, and the game area is 16:10 inside
//      the viewport; the popup passes auditBoxes;
//   3. Play loads an iframe with sandbox="allow-scripts" (never allow-same-origin), no referrer and no permissions,
//      from /api/viz/artifact/frame; the game's script ran inside it (body[data-ready]); its own Play starts a round;
//   4. the game canvas renders: a screenshot of the iframe's box has real pixels (luminance spread, several colors,
//      lit pixels), not a blank frame;
//   5. Restart loads a fresh frame; the grip resizes the game (arrow keys and a drag) and it stays 16:10 inside the
//      viewport;
//   6. Keep puts the sample on the node (a DEMO SAMPLE chip); Discard removes it; Close closes the popup;
//   7. all of it again in a narrow window (820 x 640).
// The caller owns the page and the engine. LUCID_DEMO_WORLD_KEY plays that installed world's samples (its templates
// with a `sample`); default: the current style (the host's three samples, P-WORLDS.GAMES3).
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 [LUCID_DEMO_WORLD_KEY=<key>] node desktop/scripts/demo_p_worlds_build_2.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const POP = ".popover.viz-art-pop";

export async function verifySamples(page, worldKey = null) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  const probe = (fn, ...args) => page.evaluate((f, a) => window.__vizProbe?.[f]?.(...a), fn, args);
  const topmostAt = (x, y, sel) => page.evaluate((px, py, s) => !!document.elementFromPoint(px, py)?.closest(s), x, y, sel);
  const topmost = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
  const audit = async (root) => { const bad = await page.evaluate(auditBoxes, root, MIN_GAP); assert(bad.length === 0, `spacing on ${root}: ${bad.join(" | ")}`); };
  const viewport = () => page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

  // Fly to approvals (on by default) would move the camera off the nodes this demo clicks; it is read at load
  if ((await page.evaluate(() => localStorage.getItem("lucid.viz.flyToApprovals.v1"))) !== "0") {
    await page.evaluate(() => localStorage.setItem("lucid.viz.flyToApprovals.v1", "0"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ctViz", { timeout: 20000 });
  }
  if (!(await page.$("#vizView [data-viz-ledger]"))) await page.click("#ctViz");
  await page.waitForSelector("#vizView [data-viz-stage]", { visible: true, timeout: 15000 });
  await pause(1500);
  for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});
  assert((await page.evaluate(() => typeof window.__vizProbe?.artifact)) === "function", "the probe has no artifact(): this build predates P-WORLDS.BUILD1");
  if (worldKey) {
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) { ok = !!(await probe("style", `world:${worldKey}`)); if (!ok) await pause(500); }
    assert(ok, `the world "${worldKey}" cannot be drawn: ${JSON.stringify(await probe("worlds"))}`);
    await pause(2000);
  } else {
    // the host's templates belong to the built-in styles; the page may still be on a world from an earlier demo
    assert(await probe("style", "anime"), "cannot switch to the built-in anime style");
    await pause(1500);
  }
  assert(await topmost("#vizView [data-viz-fit]"), "the Fit button is covered");
  await page.click("#vizView [data-viz-fit]");
  await pause(1500);

  // 1. a node panel's Mini game row (a demo agent, else Main)
  const openPanel = async () => {
    for (let i = 0; i < 20; i++) {
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
  assert(rows.length >= 1 && rows.every((r) => r.label && r.build), `the Mini game rows are ${JSON.stringify(rows)}`);
  const withSample = rows.filter((r) => r.sample);
  assert(withSample.length >= 1, `no template offers Play sample: ${JSON.stringify(rows)}`);
  if (!worldKey) assert(JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(["target-tap", "memory-cards", "agent-runner"]) && withSample.length === 3, `the host's templates are ${JSON.stringify(rows)}`);
  await audit("#vizView [data-viz-panel]");

  // 2-5 on one template's sample
  const playOne = async (row, narrow) => {
    const sel = `#vizView [data-viz-panel] [data-viz-game-sample="${row.id}"]`;
    assert(await topmost(sel), `Play sample for ${row.id} is covered`);
    await page.click(sel);
    await page.waitForSelector(`${POP} [data-viz-art]`, { visible: true, timeout: 5000 });
    let st = null;
    for (let i = 0; i < 40; i++) { st = await probe("artifact"); if (st?.verdict && st.verdict !== "pending") break; await pause(250); }
    assert(st?.open && st.title === row.label, `the popup did not open on the ${row.id} sample: ${JSON.stringify(st)}`);
    assert(st.verdict === "pass", `the security gate did not pass the ${row.id} sample: ${JSON.stringify(st)}`);
    assert(st.sample && st.demo, `the popup's artifact is not a demo sample: ${JSON.stringify(st)}`);
    assert(["Untrusted", "Sample", "Demo"].every((t) => st.labels.includes(t)), `the popup labels are ${JSON.stringify(st.labels)}`);
    assert(!st.playing && !(await page.$(`${POP} iframe`)), "something rendered before Play");
    const vp = await viewport();
    const in16x10 = (s) => s && Math.abs(s.w / s.h - 1.6) < 0.03 && s.x >= 0 && s.y >= 0 && s.x + s.w <= vp.w + 0.5 && s.y + s.h <= vp.h + 0.5;
    assert(in16x10(st.stage), `the game area is not 16:10 inside the ${vp.w}x${vp.h} viewport: ${JSON.stringify(st.stage)}`);
    const card = await page.$eval(POP, (n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom }; });
    assert(card.x >= 0 && card.y >= 0 && card.r <= vp.w + 0.5 && card.b <= vp.h + 0.5, `the popup leaves the viewport: ${JSON.stringify(card)}`);
    const clipped = await page.$$eval(`${POP} .viz-art-tag, ${POP} .viz-panel-act span`, (ns) => ns.filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent.trim()));
    assert(clipped.length === 0, `clipped labels in the popup: ${JSON.stringify(clipped)}`);
    await audit(POP);

    // 3. Play: the sandboxed frame
    assert(await topmost(`${POP} [data-viz-art-play]`), "Play is covered");
    await page.click(`${POP} [data-viz-art-play]`);
    await page.waitForSelector(`${POP} iframe[data-viz-art-frame]`, { timeout: 5000 });
    const attrs = await page.$eval(`${POP} iframe[data-viz-art-frame]`, (f) => ({ sandbox: f.getAttribute("sandbox"), src: f.getAttribute("src"), referrer: f.getAttribute("referrerpolicy"), allow: f.getAttribute("allow") }));
    assert(attrs.sandbox === "allow-scripts" && !/allow-same-origin/.test(attrs.sandbox), `the iframe sandbox is ${attrs.sandbox}`);
    assert((attrs.src ?? "").startsWith("/api/viz/artifact/frame?id=") && attrs.referrer === "no-referrer" && attrs.allow === "", `the iframe attributes are ${JSON.stringify(attrs)}`);
    st = await probe("artifact");
    assert(st.playing && st.sandbox === "allow-scripts", `the probe reads ${JSON.stringify(st)}`);
    const findGame = async (src) => {
      const idPart = (src.match(/id=[^&]+/) ?? [""])[0];
      for (let i = 0; i < 40; i++) {
        const f = page.frames().find((x) => x.url() === "about:srcdoc" && x.parentFrame()?.url().includes(idPart)) ?? null;
        if (f && (await f.evaluate(() => document.body?.dataset.ready === "1").catch(() => false))) return f;
        await pause(250);
      }
      return null;
    };
    const game = await findGame(attrs.src);
    assert(game, "the sample's script never ran in its sandboxed srcdoc frame");
    const started = await game.evaluate(() => { const s = document.getElementById("start"); if (!s) return false; s.click(); return true; });
    await pause(1500);
    if (started && (await game.evaluate(() => document.body.hasAttribute("data-state")))) {
      assert((await game.evaluate(() => document.body.dataset.state)) === "play", "the sample does not play after its Play button");
    }

    // 4. the canvas renders: real pixels in the iframe's box
    const box = await page.$eval(`${POP} iframe[data-viz-art-frame]`, (f) => { const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
    const shot = await page.screenshot({ clip: box, encoding: "base64", type: "png" });
    const px = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
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
    }, shot);
    assert(px.spread > 60 && px.colors >= 6 && px.lit > 0.005, `the game canvas looks blank: ${JSON.stringify(px)}`);

    // 5. Restart: a fresh frame; the grip resizes within the viewport at 16:10
    const label = await page.$eval(`${POP} [data-viz-art-play]`, (b) => b.textContent.trim());
    assert(label === "Restart", `Play did not become Restart (${label})`);
    await page.evaluate((s) => { document.querySelector(s).dataset.old = "1"; }, `${POP} iframe[data-viz-art-frame]`);
    await page.click(`${POP} [data-viz-art-play]`);
    await page.waitForSelector(`${POP} iframe[data-viz-art-frame]:not([data-old])`, { timeout: 5000 });
    assert((await page.$$(`${POP} iframe`)).length === 1, "Restart left more than one frame");
    const w0 = (await probe("artifact")).stage.w;
    await page.focus(`${POP} [data-viz-art-grip]`);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await pause(200);
    const s1 = (await probe("artifact")).stage;
    assert(s1.w < w0 - 40 && in16x10(s1), `the arrow keys did not shrink the game at 16:10: ${w0} -> ${JSON.stringify(s1)}`);
    await page.keyboard.press("ArrowRight");
    await pause(200);
    const s1b = (await probe("artifact")).stage;
    assert(s1b.w > s1.w + 20 && in16x10(s1b), `the arrow keys did not grow the game at 16:10: ${JSON.stringify(s1)} -> ${JSON.stringify(s1b)}`);
    let grip = await page.$eval(`${POP} [data-viz-art-grip]`, (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    assert(await topmostAt(grip.x, grip.y, `${POP} [data-viz-art-grip]`), "the resize grip is covered");
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x - 30, grip.y, { steps: 4 });
    await page.mouse.move(grip.x - 60, grip.y, { steps: 4 });
    await page.mouse.up();
    await pause(300);
    const s2 = (await probe("artifact")).stage;
    assert(s2.w < s1b.w - 10 && in16x10(s2), `dragging the grip did not resize the game at 16:10 inside the viewport: ${JSON.stringify(s1b)} -> ${JSON.stringify(s2)}`);
    grip = await page.$eval(`${POP} [data-viz-art-grip]`, (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x + 4000, grip.y + 4000, { steps: 6 }); // far past the edge: the room caps it
    await page.mouse.up();
    await pause(300);
    const s3 = (await probe("artifact")).stage;
    assert(in16x10(s3), `a huge drag left the viewport or 16:10: ${JSON.stringify(s3)}`);
    await audit(POP);

    // 6. Keep puts it on the node; Discard removes it
    const id = st.id;
    await page.click(`${POP} [data-viz-art-keep]`);
    await pause(250);
    const kept = ((await probe("builds")) ?? []).find((b) => b.id === node.id)?.artifact;
    assert(kept && kept.id === id && kept.kept && kept.sample, `Keep did not put the sample on ${node.id}: ${JSON.stringify(kept)}`);
    const badge = await page.$eval(`[data-viz-art-chip="${node.id}"] .viz-art-badge`, (n) => n.textContent.trim()).catch(() => "");
    assert(badge === "DEMO SAMPLE", `the kept sample's chip says ${JSON.stringify(badge)}`);
    await page.click(`${POP} [data-viz-art-discard]`);
    await pause(300);
    assert(!(await page.$(POP)), "Discard did not close the popup");
    const gone = ((await probe("builds")) ?? []).find((b) => b.id === node.id)?.artifact;
    assert(gone?.id !== id, "Discard left the sample on the node");

    // Close: opens again, then the header's Close shuts it and leaves nothing on the node
    if (!(await page.$(sel))) assert(await openPanel(), "the node panel did not reopen");
    await page.click(sel);
    await page.waitForSelector(`${POP} [data-viz-art]`, { visible: true, timeout: 5000 });
    const again = await probe("artifact");
    assert(await topmost(`${POP} [data-viz-art-close]`), "Close is covered");
    await page.click(`${POP} [data-viz-art-close]`);
    await pause(300);
    assert(!(await page.$(POP)), "Close did not close the popup");
    assert(((await probe("builds")) ?? []).find((b) => b.id === node.id)?.artifact?.id !== again.id, "Close put the sample on the node");
    return { id: row.id, narrow, verdict: st.verdict, sandbox: attrs.sandbox, pixels: px, stage: { start: w0, keys: s1.w, drag: s2.w, capped: s3.w } };
  };

  const played = [];
  for (const row of withSample) played.push(await playOne(row, false));

  // 7. a narrow window
  await page.keyboard.press("Escape");
  await pause(300);
  await page.setViewport({ width: 820, height: 640 });
  await pause(1200);
  await page.click("#vizView [data-viz-fit]").catch(() => {});
  await pause(2000);
  if (!(await page.$("#vizView [data-viz-panel]:not([hidden]) [data-viz-game-sample]"))) assert(await openPanel(), "no node panel in the narrow window");
  await audit("#vizView [data-viz-panel]");
  played.push(await playOne(withSample[0], true));
  await page.setViewport(null).catch(() => {});

  assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  return { node: node.id, rows, played };
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_worlds_build_2.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL (an isolated QA page at <engine>/?vizDemo=1).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifySamples(page, process.env.LUCID_DEMO_WORLD_KEY || null), null, 2));
    console.log("P-WORLDS.BUILD2 passed: every template sample played from the node panel through the security gate, sandboxed, drew its canvas, resized at 16:10 and kept, discarded and closed.");
  } finally { await browser.disconnect(); }
}
