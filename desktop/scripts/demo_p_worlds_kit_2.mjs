// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_worlds_kit_2.mjs
//
// P-WORLDS.KIT2 (ADR-0654): real-browser proof of the shared character kit (WorldKit.character). On a QA page at
// ?vizDemo=1 (the read-only window.__vizProbe), it opens Visualize the way a user does, optionally shows an installed
// world (LUCID_DEMO_WORLD_KEY), then asks the probe for the kit's lineup, which the page renders with the host's own
// WorldKit in an offscreen WebGL renderer (desktop/renderer/viz_world_character_lineup.ts), and proves:
//   1. the 12 body presets (feminine, masculine, neutral x 4 builds): shoulders grow with the build, feminine
//      shoulders narrower and hips wider than masculine;
//   2. all 16 hair styles build at every tier (minimal, reduced, full, ultra, cinematic), with more geometry at full
//      than minimal, strand cards from ultra (except buzz, locs, braids, headscarf, hijab) and a capSafe variant;
//   3. no skin above a sleeve: for every preset at three shoulder lifts (0.15, 0.9, 1.6 rad), seen from the front and
//      from above, the flat-color coverage pass counts ZERO red (upper-arm skin above the hem) pixels for the kit's
//      short and long sleeves, while soccer's old sleeve (top at +0.02, no cap), drawn the same way, shows red: the
//      detector sees the bug the kit fixes;
//   4. no page errors. The three sheets (lineup, heads with capSafe under a cap, coverage) are written as PNGs to
//      LUCID_DEMO_OUT (default: a new temp folder) for a person to look at.
// The caller owns the page and the engine.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/?vizDemo=1 [LUCID_DEMO_WORLD_KEY=<key>] [LUCID_DEMO_OUT=<dir>] node desktop/scripts/demo_p_worlds_kit_2.mjs

const HAIR = ["short", "buzz", "curls", "coils", "afro", "puffs", "locs", "braids", "long", "wavy", "bob", "pixie", "bun", "ponytail", "headscarf", "hijab"];
const NO_CARDS = new Set(["buzz", "locs", "braids", "headscarf", "hijab"]);
const TIERS = ["minimal", "reduced", "full", "ultra", "cinematic"];

export async function verifyKit(page, { worldKey = null, outDir = null } = {}) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  const probe = (fn, ...args) => page.evaluate((f, a) => window.__vizProbe?.[f]?.(...a), fn, args);

  if (!(await page.$("#vizView [data-viz-ledger]"))) await page.click("#ctViz");
  await page.waitForSelector("#vizView [data-viz-worlds]", { visible: true, timeout: 15000 });
  await page.waitForFunction(() => typeof window.__vizProbe?.kitLineup === "function", { timeout: 15000 })
    .catch(() => { throw new Error("the probe has no kitLineup: open the page with ?vizDemo=1 on a build with P-WORLDS.KIT2"); });

  // a world on stage, when asked for (the lineup itself does not depend on one)
  let world = null;
  if (worldKey) {
    const worlds = (await probe("worlds")) ?? [];
    world = worlds.find((w) => w.style === `world:${worldKey}`) ?? null;
    assert(world, `world "${worldKey}" is not installed: ${JSON.stringify(worlds)}`);
    assert(await probe("style", world.style), `the probe could not switch to ${world.style}: ${world.error ?? world.access}`);
    await pause(1500);
  }

  const r = await probe("kitLineup", { tier: "ultra" });
  assert(r && Array.isArray(r.presets), "kitLineup returned nothing");

  // 1. presets
  assert(r.presets.length === 12, `expected 12 presets, got ${r.presets.length}`);
  for (const p of ["feminine", "masculine", "neutral"]) {
    const b = r.presets.filter((x) => x.presentation === p).sort((x, y) => x.body - y.body);
    assert(b.length === 4, `${p}: expected 4 builds`);
    for (let i = 1; i < 4; i++) assert(b[i].shoulder > b[i - 1].shoulder && b[i].limb > b[i - 1].limb, `${p}: build ${i} is not broader than ${i - 1}`);
  }
  for (let body = 0; body < 4; body++) {
    const f = r.presets.find((x) => x.presentation === "feminine" && x.body === body);
    const m = r.presets.find((x) => x.presentation === "masculine" && x.body === body);
    assert(f.shoulder < m.shoulder && f.hip / f.waist > m.hip / m.waist, `build ${body}: feminine and masculine shapes do not differ as specified`);
  }

  // 2. hair
  assert(JSON.stringify(r.hair.map((h) => h.style)) === JSON.stringify(HAIR), `hair styles: ${r.hair.map((h) => h.style).join(",")}`);
  for (const h of r.hair) {
    for (const t of TIERS) assert(h.vertices[t] > 0, `${h.style} built nothing at ${t}`);
    assert(h.vertices.minimal < h.vertices.full, `${h.style}: minimal is not lighter than full`);
    for (const t of TIERS) {
      const want = (t === "ultra" || t === "cinematic") && !NO_CARDS.has(h.style);
      assert((h.cards[t] > 0) === want, `${h.style} at ${t}: cards ${h.cards[t]} (expected ${want ? "some" : "none"})`);
    }
    assert(h.capSafe > 0, `${h.style}: no capSafe variant`);
  }

  // 3. sleeves
  assert(r.coverage.length === 3, `expected 3 shoulder lifts, got ${r.coverage.length}`);
  for (const c of r.coverage) {
    assert(c.kitShort === 0, `skin shows above the kit's SHORT sleeve at ${c.angle} rad: ${c.kitShort} px`);
    assert(c.kitLong === 0, `skin shows above the kit's LONG sleeve at ${c.angle} rad: ${c.kitLong} px`);
  }
  const control = r.coverage.reduce((a, c) => a + c.soccer, 0);
  assert(control >= 50, `the control (soccer's sleeve) shows only ${control} skin px: the coverage pass would not catch the bug`);

  // 4. the sheets, for a person
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = outDir ?? mkdtempSync(join(tmpdir(), "lucid-kit2-"));
  mkdirSync(dir, { recursive: true });
  const files = {};
  for (const k of ["lineup", "heads", "coverageShot"]) {
    assert(typeof r[k] === "string" && r[k].startsWith("data:image/png;base64,"), `${k} is not a PNG`);
    const f = join(dir, `${k}.png`);
    writeFileSync(f, Buffer.from(r[k].slice("data:image/png;base64,".length), "base64"));
    files[k] = f;
  }
  if (world) {
    const box = await page.$eval("#vizView [data-viz-stage]", (n) => { const b = n.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; });
    files.world = join(dir, "world.png");
    await page.screenshot({ path: files.world, clip: box });
  }

  assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  return { gl: r.gl, ms: r.ms, world: world?.id ?? null, coverage: r.coverage, files };
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_worlds_kit_2.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL (an isolated QA page at <engine>/?vizDemo=1).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    const out = await verifyKit(page, { worldKey: process.env.LUCID_DEMO_WORLD_KEY || null, outDir: process.env.LUCID_DEMO_OUT || null });
    console.log(JSON.stringify(out, null, 2));
    console.log("P-WORLDS.KIT2 passed: 12 body presets, 16 hair styles at every tier with cards from ultra, and no skin above the kit's short or long sleeves at three shoulder lifts (soccer's old sleeve shows it).");
  } finally { await browser.disconnect(); }
}
