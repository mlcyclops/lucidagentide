// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_viz_ui_1.mjs
//
// P-VIZ.UI1: real-browser proof that the Visualize pop-outs read cleanly. On the ?vizDemo=1 feed (Main, demo-1 to
// demo-6, subagents), on a LIGHT world (default world:hospital) and a DARK one (default world:magic-show), with real
// input, it opens every pop-out and on each one asserts:
//   a. no clipped text: every visible text element fits its own box (scrollWidth <= clientWidth + 1, the same for
//      height under overflow hidden) unless it ellipsizes AND has a tooltip (title or data-tip), and, scrolled into
//      view, its box sits fully inside every clipping ancestor and at least 6 px inside the card's edge;
//   b. contrast: each label's computed color against its effective background (the composited background colors
//      of its ancestors; a translucent card is composited over both white and black and the worse one counts) is
//      >= 4.5:1, section headers (.viz-vmenu-h) >= 3:1; disabled controls are exempt (WCAG 1.4.3);
//   c. auditBoxes (desktop/scripts/demo_p_spacing_1.mjs) passes.
// The surfaces: the View menu scrolled to its top and to its bottom (the first header and the last note keep the
// menu's padding: >= 10 px from the scroll area's edges), the Quality tooltip, a node panel (Auto camera off first,
// then a click on the node's screen box from the read-only window.__vizProbe.nodes()), its Customize look menu
// (top and bottom), the Worlds menu and, when the header shows it, Recordings. Screenshots of each surface and of a
// name pill per world go to LUCID_DEMO_OUT (default: a new temp folder). The caller owns the page and the engine.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 [LUCID_DEMO_LIGHT_WORLD=world:hospital]
//      [LUCID_DEMO_DARK_WORLD=world:magic-show] [LUCID_DEMO_OUT=<dir>] node desktop/scripts/demo_p_viz_ui_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

/** Runs in the page (serialized by page.evaluate): every clipped-text and contrast violation under `rootSel`. */
export function checkText(rootSel) {
  const root = document.querySelector(rootSel);
  if (!root) return [`no element matches ${rootSel}`];
  const out = [];
  const name = (e) => {
    const cls = [...e.classList].slice(0, 2).map((c) => `.${c}`).join("");
    const text = (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32);
    return `${e.tagName.toLowerCase()}${cls}${text ? ` "${text}"` : ""}`;
  };
  // A computed color as [r, g, b, a] (0-255, alpha 0-1); null for transparent; "?" for a format this cannot read.
  const parse = (s) => {
    if (!s || s === "transparent") return null;
    let m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number.parseFloat);
      const c = [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
      return c[3] <= 0 ? null : c;
    }
    m = s.match(/^color\(srgb ([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number.parseFloat);
      const c = [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
      return c[3] <= 0 ? null : c;
    }
    return "?";
  };
  const over = (top, under) => {
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
  };
  const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  /** The background colors behind `e`, innermost first, down to the first opaque one (or the document). */
  const layersOf = (e) => {
    const layers = [];
    for (let a = e; a; a = a.parentElement) {
      const c = parse(getComputedStyle(a).backgroundColor);
      if (c === "?") return "?";
      if (c) { layers.push(c); if (c[3] >= 0.999) break; }
    }
    return layers;
  };
  const composite = (layers, base) => layers.reduceRight((acc, c) => over(c, acc), base);

  const texts = [...root.querySelectorAll("*")].filter((e) => {
    if (e.closest("svg, option, script, style")) return false;
    const own = [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!own && e.tagName !== "SELECT") return false;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (e.checkVisibility && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const s = getComputedStyle(e);
    return s.clipPath === "none" || !s.clipPath;
  });
  if (!texts.length) return [`${rootSel}: no visible text`];
  for (const e of texts) {
    const s = getComputedStyle(e);
    // a. clipping
    const tip = !!e.closest("[title]:not([title='']), [data-tip]");
    const ellipsis = s.textOverflow === "ellipsis";
    if (e.tagName !== "SELECT" && e.clientWidth > 0) {
      if (e.scrollWidth > e.clientWidth + 1 && !(ellipsis && tip)) {
        out.push(`clipped: ${name(e)} is ${e.scrollWidth}px of text in ${e.clientWidth}px${ellipsis ? " (ellipsis but no tooltip)" : " (no ellipsis)"}`);
      }
      const scroller = s.overflowY === "auto" || s.overflowY === "scroll";
      if (!scroller && s.overflowY !== "visible" && e.scrollHeight > e.clientHeight + 1) {
        out.push(`clipped: ${name(e)} is ${e.scrollHeight}px of text in ${e.clientHeight}px of height`);
      }
    }
    e.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = e.getBoundingClientRect();
    let tallIn = false; // taller than a scrolling ancestor: its top and bottom are reached by scrolling
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      const as = getComputedStyle(a);
      const clips = as.overflowX !== "visible" || as.overflowY !== "visible";
      if (clips) {
        // the client box in screen px (the node panel card is tilted in 3D: scale layout px by the projected size)
        const b = a.getBoundingClientRect();
        const sx = a.offsetWidth ? b.width / a.offsetWidth : 1, sy = a.offsetHeight ? b.height / a.offsetHeight : 1;
        const box = { left: b.left + a.clientLeft * sx, top: b.top + a.clientTop * sy, right: b.left + (a.clientLeft + a.clientWidth) * sx, bottom: b.top + (a.clientTop + a.clientHeight) * sy };
        // a paragraph taller than its scrolling log (the panel's output) is read by scrolling: only its sides count
        const tall = (as.overflowY === "auto" || as.overflowY === "scroll") && r.height > box.bottom - box.top;
        if (tall) tallIn = true;
        const outV = !tall && (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5);
        if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || outV) {
          out.push(`cut: ${name(e)} [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}] leaves ${name(a).slice(0, 40)}'s visible box [${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.right)},${Math.round(box.bottom)}] when scrolled into view`);
          break;
        }
      }
      if (a === root) break;
    }
    const cardNow = root.getBoundingClientRect();
    const inset = 6;
    const edgeV = !tallIn && (r.top < cardNow.top + inset - 0.5 || r.bottom > cardNow.bottom - inset + 0.5);
    if (r.left < cardNow.left + inset - 0.5 || r.right > cardNow.right - inset + 0.5 || edgeV) {
      out.push(`edge: ${name(e)} sits within ${inset}px of the card's edge (no padding)`);
    }
    // b. contrast
    if (e.closest(":disabled, [aria-disabled=true]")) continue;
    const fg = parse(s.color);
    const layers = layersOf(e);
    if (fg === "?" || layers === "?") { out.push(`contrast: ${name(e)} uses a color format this check cannot read (${s.color} / ${s.backgroundColor})`); continue; }
    if (!fg) continue;
    const opaque = layers.length && layers[layers.length - 1][3] >= 0.999;
    const bases = opaque ? [[0, 0, 0, 1]] : [[255, 255, 255, 1], [0, 0, 0, 1]];
    let worst = Infinity;
    for (const base of bases) {
      const bg = composite(layers, base);
      worst = Math.min(worst, ratio(fg[3] < 1 ? over(fg, bg) : fg, bg));
    }
    const px = Number.parseFloat(s.fontSize), bold = Number(s.fontWeight) >= 700;
    const large = px >= 24 || (bold && px >= 18.66);
    const need = e.matches(".viz-vmenu-h") || large ? 3 : 4.5;
    if (worst < need) out.push(`contrast: ${name(e)} is ${worst.toFixed(2)}:1 (${s.color} on its background), needs ${need}:1`);
  }
  return out;
}

export async function verifyVizUi(page, { light = "world:hospital", dark = "world:magic-show", outDir = null } = {}) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  const probe = (fn, ...args) => page.evaluate((f, a) => window.__vizProbe?.[f]?.(...a), fn, args);
  const topmost = (sel) => page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
  const clickTop = async (sel) => {
    await page.waitForSelector(sel, { visible: true, timeout: 5000 });
    await page.$eval(sel, (n) => n.scrollIntoView({ block: "nearest" }));
    assert(await topmost(sel), `${sel} is covered`);
    await page.click(sel);
  };
  const { mkdirSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = outDir ?? mkdtempSync(join(tmpdir(), "lucid-vizui1-"));
  mkdirSync(dir, { recursive: true });
  const shots = [];
  const shoot = async (file, sel = null) => {
    const path = join(dir, file);
    const clip = sel ? await page.$eval(sel, (n) => {
      const b = n.getBoundingClientRect(), m = 12;
      const x = Math.max(0, b.left - m), y = Math.max(0, b.top - m);
      return { x, y, width: Math.min(innerWidth - x, b.width + 2 * m), height: Math.min(innerHeight - y, b.height + 2 * m) };
    }) : null;
    await page.screenshot(clip ? { path, clip } : { path });
    shots.push(path);
  };
  const found = [];
  /** a, b and c on one surface; `textRoot` is the card (or its scroll area), `boxRoot` what auditBoxes walks. */
  const check = async (where, textRoot, boxRoot = textRoot) => {
    for (const v of await page.evaluate(checkText, textRoot)) found.push(`${where}: ${v}`);
    for (const v of await page.evaluate(auditBoxes, boxRoot, MIN_GAP)) found.push(`${where} spacing: ${v}`);
  };
  /** Scroll a scroll area to its top or bottom; returns how far its first and last child sit from its edges. */
  const scrollEdge = (sel, where) => page.$eval(sel, (n, w) => {
    n.scrollTop = w === "top" ? 0 : n.scrollHeight;
    const b = n.getBoundingClientRect();
    const kids = [...n.children].filter((k) => k.getBoundingClientRect().height > 0);
    const first = kids[0]?.getBoundingClientRect(), last = kids[kids.length - 1]?.getBoundingClientRect();
    const s = getComputedStyle(n);
    return {
      scrolls: n.scrollHeight > n.clientHeight + 1, overflowY: s.overflowY, padLeft: parseFloat(s.paddingLeft), padTop: parseFloat(s.paddingTop),
      firstGap: first ? first.top - (b.top + n.clientTop) : null, lastGap: last ? b.top + n.clientTop + n.clientHeight - last.bottom : null,
    };
  }, where);
  const closePops = async () => {
    for (let i = 0; i < 3 && (await page.$(".popover.show")); i++) { await page.keyboard.press("Escape"); await pause(250); }
  };

  await page.waitForSelector("#ctViz", { timeout: 20000 });
  // Fly to approvals (on by default) would move the camera off the nodes this demo clicks; it is read at load
  if ((await page.evaluate(() => localStorage.getItem("lucid.viz.flyToApprovals.v1"))) !== "0") {
    await page.evaluate(() => localStorage.setItem("lucid.viz.flyToApprovals.v1", "0"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ctViz", { timeout: 20000 });
  }
  if (!(await page.$("#vizView [data-viz-ledger]"))) await page.click("#ctViz");
  await page.waitForSelector("#vizView [data-viz-worlds]", { visible: true, timeout: 15000 });
  await pause(1500);
  for (const b of await page.$$("#toasts .toast .h button")) await b.click().catch(() => {});
  await pause(400);

  for (const [tone, style] of [["light", light], ["dark", dark]]) {
    // 0. the world, and the camera held still
    let ok = false;
    for (let i = 0; i < 30 && !ok; i++) { ok = !!(await probe("style", style)); if (!ok) await pause(500); }
    assert(ok, `cannot show ${style} (installed: ${JSON.stringify(await probe("worlds"))})`);
    await pause(2500);
    if (await page.$eval("#vizView [data-viz-auto]", (n) => n.checked)) await clickTop("#vizView .viz-auto");
    await pause(300);
    assert(!(await page.$eval("#vizView [data-viz-auto]", (n) => n.checked)), "Auto camera is still on");
    await clickTop("#vizView [data-viz-fit]");
    await pause(2500);
    await shoot(`${tone}-stage.png`, "#vizView [data-viz-stage]");

    // 1. the View menu, top and bottom
    const vm = ".popover.show > .viz-vmenu:not(.viz-look)";
    await clickTop("#vizView [data-viz-viewmenu]");
    await page.waitForSelector(`${vm} [data-viz-quality]`, { visible: true, timeout: 5000 });
    await pause(300);
    const top = await scrollEdge(vm, "top");
    assert(top.overflowY === "auto", `the View menu's scroll area is not the padded menu (overflow-y ${top.overflowY})`);
    assert(top.padLeft >= 12 && top.padTop >= 10, `the View menu has ${top.padLeft}px side / ${top.padTop}px top padding`);
    assert(top.firstGap >= 10, `at the top the first header is ${top.firstGap}px from the scroll area's edge`);
    await pause(150);
    await shoot(`${tone}-viewmenu-top.png`, ".popover.show:has(> .viz-vmenu)");
    await check(`${tone} View menu (top)`, vm);
    const bottom = await scrollEdge(vm, "bottom");
    assert(bottom.lastGap >= 10, `at the bottom the last item is ${bottom.lastGap}px from the scroll area's edge`);
    await pause(150);
    await shoot(`${tone}-viewmenu-bottom.png`, ".popover.show:has(> .viz-vmenu)");
    await check(`${tone} View menu (bottom)`, vm);
    const note = await page.$eval(vm, (n) => {
      const p = n.querySelector(".viz-cast-note");
      return p ? { display: getComputedStyle(p).display, kids: p.children.length } : null;
    });
    if (note) assert(note.display === "block" && note.kids === 0, `the Cast note is not a plain block paragraph: ${JSON.stringify(note)}`);

    // 2. the Quality tooltip
    await page.$eval(`${vm} [data-viz-quality]`, (n) => n.scrollIntoView({ block: "nearest" }));
    await page.hover(`${vm} [data-viz-quality]`);
    const tipShown = await page.waitForSelector("#tip.show", { visible: true, timeout: 3000 }).then(() => true, () => false);
    if (tipShown) {
      await pause(250);
      await shoot(`${tone}-quality-tip.png`, "#tip");
      for (const v of await page.evaluate(checkText, "#tip")) found.push(`${tone} Quality tooltip: ${v}`);
    } else found.push(`${tone} Quality tooltip: hovering Quality showed no #tip`);
    await page.mouse.move(5, 5);
    await closePops();

    // 3. a node panel: Auto camera is off, so the node stays where the probe says it is
    const nodes = (await probe("nodes")) ?? [];
    const target = nodes.find((n) => n.id === "demo-2" && n.box) ?? nodes.find((n) => n.kind === "agent" && n.box);
    assert(target, `no agent on screen: ${JSON.stringify(nodes.map((n) => [n.id, n.box]))}`);
    await page.mouse.click(target.box.x, target.box.y);
    await page.waitForSelector("#vizView [data-viz-panel]:not([hidden]) [data-viz-panel-acts]", { visible: true, timeout: 5000 });
    await pause(500);
    await shoot(`${tone}-panel.png`, "#vizView [data-viz-panel] .viz-panel-card");
    await check(`${tone} node panel`, "#vizView [data-viz-panel] .viz-panel-card");

    // 4. Customize look (top and bottom)
    const look = ".popover.show > .viz-look";
    if (await page.$(`#vizView [data-viz-look-open="${target.id}"]`)) {
      await clickTop(`#vizView [data-viz-look-open="${target.id}"]`);
      await page.waitForSelector(`${look} [data-viz-look]`, { visible: true, timeout: 5000 });
      await pause(300);
      const lt = await scrollEdge(look, "top");
      assert(lt.firstGap >= 10, `Customize look: the first header is ${lt.firstGap}px from the scroll area's edge`);
      await shoot(`${tone}-look-top.png`, ".popover.show:has(> .viz-look)");
      await check(`${tone} Customize look (top)`, look);
      const lb = await scrollEdge(look, "bottom");
      assert(lb.lastGap >= 10, `Customize look: the last note is ${lb.lastGap}px from the scroll area's edge`);
      await shoot(`${tone}-look-bottom.png`, ".popover.show:has(> .viz-look)");
      await check(`${tone} Customize look (bottom)`, look);
      await closePops();
    } else found.push(`${tone}: ${target.id}'s panel has no Customize look (is ${style} a human-cast world?)`);
    if (await page.$("#vizView [data-viz-panel]:not([hidden])")) await page.click("#vizView [data-viz-panel-close]").catch(() => {});
    await pause(300);

    // 5. the Worlds menu
    await clickTop("#vizView [data-viz-worlds]");
    await page.waitForSelector(".popover.show > .viz-worlds .viz-world-row", { visible: true, timeout: 5000 });
    await pause(300);
    const wt = await scrollEdge(".popover.show > .viz-worlds", "top");
    assert(wt.padLeft >= 12 && wt.firstGap >= 10, `the Worlds menu has ${wt.padLeft}px side padding and its header sits ${wt.firstGap}px from the top`);
    await shoot(`${tone}-worlds.png`, ".popover.show:has(> .viz-worlds)");
    await check(`${tone} Worlds menu`, ".popover.show > .viz-worlds");
    await closePops();

    // 6. Recordings, when the header shows the button
    if (await page.$eval("#vizView .viz-head [data-viz-recs]", (n) => n.getBoundingClientRect().width > 0).catch(() => false)) {
      await clickTop("#vizView .viz-head [data-viz-recs]");
      await page.waitForSelector(".popover.show > .viz-recs", { visible: true, timeout: 5000 });
      await pause(300);
      await shoot(`${tone}-recordings.png`, ".popover.show:has(> .viz-recs)");
      await check(`${tone} Recordings`, ".popover.show > .viz-recs");
      await closePops();
    }

    // 7. a name pill, for a person (the role chip and the name over the sky)
    const pill = ((await probe("nodes")) ?? []).find((n) => n.id === target.id)?.box;
    if (pill) {
      const path = join(dir, `${tone}-name-pill.png`);
      const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      const x = Math.max(0, pill.x - 180), y = Math.max(0, pill.y - pill.r);
      await page.screenshot({ path, clip: { x, y, width: Math.min(vp.w - x, 360), height: Math.min(vp.h - y, pill.r * 2 + 120) } });
      shots.push(path);
    }
  }

  assert(found.length === 0, `P-VIZ.UI1 found ${found.length} problem(s) (screenshots in ${dir}):\n  ${found.join("\n  ")}`);
  assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  return { worlds: [light, dark], screenshots: shots };
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_viz_ui_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL (an isolated QA page at <engine>/?vizDemo=1 with a light and a dark world installed).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url) ?? null;
    if (!page) throw new Error(`No existing QA page at ${url}`);
    const out = await verifyVizUi(page, {
      light: process.env.LUCID_DEMO_LIGHT_WORLD || "world:hospital",
      dark: process.env.LUCID_DEMO_DARK_WORLD || "world:magic-show",
      outDir: process.env.LUCID_DEMO_OUT || null,
    });
    console.log(JSON.stringify(out, null, 2));
    console.log("P-VIZ.UI1 passed: on a light and a dark world every Visualize pop-out keeps its text inside its padding, at AA contrast, with even spacing.");
  } finally {
    await browser.disconnect();
  }
}
