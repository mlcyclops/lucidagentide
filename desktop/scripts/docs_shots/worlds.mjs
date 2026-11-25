// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/docs_shots/worlds.mjs
//
// P-DOCS.1b (ADR-0660): the shots of the "Lucid Agent Worlds" section of docs.lucid-agents.com (worlds/*.mdx in the
// docs repo). Run through docs_capture_p_docs_1.mjs:
//   bun desktop/scripts/docs_capture_p_docs_1.mjs worlds --port 7832
//
// What it uses, and why:
//   - the page opens with ?vizDemo=1, Visualize's deterministic DEMO feed (viz_demo.ts): a hub, demo agents and
//     subagents, a few approval asks a cycle (answered locally, never through the real routes) and sample builds.
//     Every surface of that feed says DEMO, and the docs say so too. It also exposes window.__vizProbe (read-only
//     node boxes, approvals, the artifact popup state), which this module reads to find what to click.
//   - three signed world packages (Christmas, Soccer, Basketball) are imported into the isolated engine through the
//     same route as Visualize's "Import world file..." (POST /api/worlds/import, every install gate). The QA engine
//     has no store configured, so an imported world is usable without a purchase (viz_worlds.worldAccess); nothing
//     about a purchase is faked. The packages come from the store repo's build output
//     (../lucidagentIDEaddon/worlds/dist, or LUCID_DOCS_WORLDS_DIR).
//   - the docs never show a price (house rule), so the store shots blank the card's price line (.plg-meta with a
//     currency amount) right before each capture; the button and every other pixel are the app's.
//   - it copies a few store card posters (desktop/renderer/assets/plugins/world-*-poster.webp) into the docs repo's
//     public/worlds/ for the section's gallery.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const DOCS = resolve(REPO, "..", "lucid-agent-docs");
const WORLDS_DIR = process.env.LUCID_DOCS_WORLDS_DIR ?? resolve(REPO, "..", "lucidagentIDEaddon", "worlds", "dist");
const WORLDS = ["christmas", "soccer", "basketball"];
const WORLD_VERSION = "2.0.0";
const POSTERS = ["christmas", "soccer", "hospital", "university", "grand-prix", "farm"];

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when `sel` exists and is laid out. */
const shown = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  if (!n) return false;
  const r = n.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}, sel);
const visible = (page, sel, timeout = 20000) => page.waitForSelector(sel, { visible: true, timeout })
  .catch(() => { throw new Error(`"${sel}" did not appear`); });
/** Park the mouse on the Visualize title, where no tooltip or node lives. */
async function calm(page, x = 60, y = 20) {
  await page.mouse.move(x, y);
  await pause(450);
}
async function clearToasts(page) {
  await page.evaluate(() => { for (const b of document.querySelectorAll("#toasts .toast .h button")) b.click(); });
  await pause(450);
}
/** The smallest viewport rect holding every selector, plus `pad`. */
const unionRect = (page, sels, pad = 12) => page.evaluate((list, p) => {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of list) {
    const n = document.querySelector(s);
    if (!n) throw new Error(`"${s}" is missing`);
    const r = n.getBoundingClientRect();
    x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top); x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom);
  }
  const x = Math.max(0, Math.floor(x1 - p)), y = Math.max(0, Math.floor(y1 - p));
  return { x, y, width: Math.ceil(Math.min(innerWidth, x2 + p) - x), height: Math.ceil(Math.min(innerHeight, y2 + p) - y) };
}, sels, pad);
const probe = (page, fn, ...args) => page.evaluate((f, a) => window.__vizProbe?.[f]?.(...a), fn, args);

/** Wait until Visualize shows a drawn scene: the stage is up and the "Starting the 3D view" spinner is gone. */
async function sceneReady(page) {
  await visible(page, "#vizView [data-viz-stage]");
  await page.waitForFunction(() => {
    const l = document.querySelector("#vizView [data-viz-loading]");
    return !!document.querySelector("#vizView [data-viz-stage] canvas") && (!l || l.hidden || l.getBoundingClientRect().height === 0);
  }, { timeout: 60000, polling: 250 }).catch(async () => {
    const st = await page.evaluate(() => {
      const l = document.querySelector("#vizView [data-viz-loading]");
      const e = document.querySelector("#vizView [data-viz-error]");
      return { loading: l ? { hidden: l.hidden, h: l.getBoundingClientRect().height, text: l.textContent } : null, error: e ? { hidden: e.hidden, text: e.textContent } : null, canvases: document.querySelectorAll("#vizView [data-viz-stage] canvas").length };
    });
    throw new Error(`Visualize never drew its scene: ${JSON.stringify(st)}`);
  });
  await pause(2500);
}
async function fit(page) {
  await page.click("#vizView [data-viz-fit]");
  await pause(1800);
}
/** Open the node panel of a demo agent (or Main) by clicking its figure where it is on screen. */
async function openPanel(page, want = (n) => n.kind === "agent") {
  for (let i = 0; i < 20; i++) {
    const nodes = ((await probe(page, "nodes")) ?? []).filter((n) => n.kind !== "subagent" && n.box && want(n));
    for (const n of nodes) {
      const free = await page.evaluate((x, y) => !!document.elementFromPoint(x, y)?.closest("#vizView canvas"), n.box.x, n.box.y);
      if (!free) continue;
      await page.mouse.click(n.box.x, n.box.y);
      await pause(800); // a single click waits out the double-click window
      if (await shown(page, "#vizView [data-viz-panel]:not([hidden]) .viz-panel-card")) return n;
    }
    await pause(500);
  }
  throw new Error("no node panel opened");
}
/** The docs never show a price: blank the price line of every store card (the layout stays as the app drew it). */
const hidePrices = (page) => page.evaluate(() => {
  for (const n of document.querySelectorAll(".plg-drawer .plg-meta, .plg-drawer .plg-sheet-price")) {
    if (/[$€£]\s?\d/.test(n.textContent ?? "")) n.style.visibility = "hidden";
  }
});

export const steps = [
  {
    id: "setup",
    step: "Copies six store posters into the docs, imports three signed world packages into the isolated engine, opens the page on the Visualize DEMO feed and answers the first-run questions.",
    async run(ctx) {
      const { page } = ctx;
      mkdirSync(join(DOCS, "public", "worlds"), { recursive: true });
      for (const key of POSTERS) {
        copyFileSync(join(REPO, "desktop", "renderer", "assets", "plugins", `world-${key}-poster.webp`), join(DOCS, "public", "worlds", `world-${key}-poster.webp`));
      }
      for (const key of WORLDS) {
        const file = join(WORLDS_DIR, `world-${key}-${WORLD_VERSION}.lplugin.zip`);
        if (!existsSync(file)) throw new Error(`no signed world package at ${file} (set LUCID_DOCS_WORLDS_DIR)`);
        const res = await ctx.api("/api/worlds/import", { method: "POST", body: readFileSync(file), headers: { "x-lucid-filename": encodeURIComponent(`world-${key}-${WORLD_VERSION}.lplugin.zip`) } });
        const body = await res.json().catch(() => null);
        if (!res.ok || body?.ok === false) throw new Error(`importing world-${key} failed: ${res.status} ${JSON.stringify(body)}`);
      }
      // This machine's host and user name never reach a shot.
      const real = [hostname(), userInfo().username].filter((s) => s && s.length > 2);
      await page.evaluateOnNewDocument((names) => {
        const orig = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const res = await orig(...args);
          if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;
          let text = await res.text();
          for (const n of names) text = text.split(n).join(n === names[0] ? "DEMO-PC" : "demo");
          return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
        };
      }, real);
      // A still camera (Auto camera and Fly to approvals off) keeps every box in place while it is measured; the
      // one-time personalization card would sit over every shot.
      await page.evaluate(() => {
        localStorage.setItem("lucid.personalNudged", "1");
        localStorage.setItem("lucid.viz.autoCamera", "0");
        localStorage.setItem("lucid.viz.flyToApprovals.v1", "0");
      });
      await page.goto(`${ctx.url}?vizDemo=1`, { waitUntil: "domcontentloaded" });
      const gates = ["#roleGateSkip", "#emailGateSkip", '#govGate [data-gov="no"]', '#provChoice [data-prov="later"]', ".coach-card [data-coach-skip]"];
      let quiet = 0;
      for (const until = Date.now() + 120000; quiet < 6;) {
        if (Date.now() > until) throw new Error("the first-run questions never finished");
        let any = false;
        for (const sel of gates) if (await shown(page, sel)) { any = true; await page.click(sel).catch(() => {}); await pause(600); }
        quiet = !any && (await shown(page, "#ctViz")) ? quiet + 1 : 0;
        await pause(500);
      }
      await page.waitForFunction(() => !document.querySelector(".spw-host"), { timeout: 90000, polling: 500 }).catch(() => {});
      await clearToasts(page);
    },
  },
  {
    id: "worlds-open-button",
    step: "Shoots the Visualize button in the message box's tools.",
    async run(ctx) {
      const { page } = ctx;
      await page.mouse.move(720, 300);
      await pause(500);
      await ctx.shoot("worlds-open-button", {
        clip: await unionRect(page, [".composer-row", "#ctViz"], 14),
        boxes: { viz: "#ctViz" },
      });
    },
  },
  {
    id: "worlds-visualize-2d",
    step: "Opens Visualize on the built-in Anime style, switches to 2D, fits the view and shoots the whole window and the header controls.",
    async run(ctx) {
      const { page } = ctx;
      await page.click("#ctViz");
      await sceneReady(page);
      if (!(await page.$eval('#vizView [data-viz-style="anime"]', (b) => b.classList.contains("on")))) {
        await page.click('#vizView [data-viz-style="anime"]');
        await sceneReady(page);
      }
      await page.click('#vizView [data-viz-view="2d"]');
      await pause(2500);
      await fit(page);
      await clearToasts(page);
      await calm(page);
      await ctx.shoot("worlds-visualize-2d", {
        boxes: {
          view: '#vizView .viz-seg[aria-label="View"]',
          style: '#vizView .viz-seg[aria-label="Style"]',
          auto: "#vizView .viz-auto",
          fit: "#vizView [data-viz-fit]",
          viewmenu: "#vizView [data-viz-viewmenu]",
          close: "#vizView [data-viz-close]",
        },
      });
      await ctx.shoot("worlds-header", {
        clip: await unionRect(page, ['#vizView .viz-seg[aria-label="View"]', "#vizView [data-viz-close]"], 10),
        boxes: {
          view: '#vizView .viz-seg[aria-label="View"]',
          anime: '#vizView [data-viz-style="anime"]',
          pro: '#vizView [data-viz-style="professional"]',
          worlds: "#vizView [data-viz-worlds]",
          auto: "#vizView .viz-auto",
          fit: "#vizView [data-viz-fit]",
          viewmenu: "#vizView [data-viz-viewmenu]",
          close: "#vizView [data-viz-close]",
        },
      });
    },
  },
  {
    id: "worlds-visualize-pro",
    step: "Switches to 3D and the built-in Professional style and shoots the whole window.",
    async run(ctx) {
      const { page } = ctx;
      await page.click('#vizView [data-viz-view="3d"]');
      await pause(1500);
      await page.click('#vizView [data-viz-style="professional"]');
      await sceneReady(page);
      await fit(page);
      await clearToasts(page);
      await calm(page);
      await ctx.shoot("worlds-visualize-pro", { boxes: { pro: '#vizView [data-viz-style="professional"]' } });
    },
  },
  {
    id: "worlds-menu",
    step: "Opens the Worlds menu with three imported worlds and shoots it, then picks Christmas.",
    async run(ctx) {
      const { page } = ctx;
      await page.click("#vizView [data-viz-worlds]");
      await visible(page, '.popover.show [data-viz-world-pick="world:christmas"]');
      await pause(500);
      await calm(page);
      await ctx.shoot("worlds-menu", {
        clip: await unionRect(page, ["#vizView [data-viz-worlds]", ".popover.show"], 12),
        boxes: {
          worlds: "#vizView [data-viz-worlds]",
          pick: '.popover.show [data-viz-world-pick="world:christmas"]',
          import: ".popover.show [data-viz-world-import]",
          store: ".popover.show [data-viz-world-store]",
        },
      });
      await page.click('.popover.show [data-viz-world-pick="world:christmas"]');
      await page.waitForFunction(() => document.querySelector("#vizView [data-viz-worlds-label]")?.textContent === "Christmas", { timeout: 30000 })
        .catch(() => { throw new Error("Christmas was not drawn"); });
      if (await page.$(".popover.show [data-viz-worlds-menu]")) await page.keyboard.press("Escape");
      await sceneReady(page);
      await fit(page);
      await clearToasts(page);
      await calm(page);
      await ctx.shoot("worlds-christmas", {
        boxes: { worlds: "#vizView [data-viz-worlds]", storm: "#vizView [data-viz-storm]", legend: "#vizView [data-viz-legend]" },
      });
    },
  },
  {
    id: "worlds-view-menu",
    step: "Opens the View menu in the Christmas world and shoots Layout, Quality, Approvals and World options, then the Cast section.",
    async run(ctx) {
      const { page } = ctx;
      await page.click("#vizView [data-viz-viewmenu]");
      await visible(page, ".popover.show [data-viz-quality]");
      await visible(page, ".popover.show .viz-cast");
      await pause(600);
      await calm(page);
      // Layout, Quality and Approvals only: a world's own option labels can name characters the docs do not name.
      await ctx.shoot("worlds-view-menu", {
        clip: await unionRect(page, [".popover.show .viz-vmenu-h", ".popover.show .viz-wopt:has(input[data-viz-flyask])"], 12),
        boxes: {
          layout: '.popover.show .viz-seg[aria-label="Layout"]',
          quality: ".popover.show [data-viz-quality]",
          fly: ".popover.show input[data-viz-flyask]",
        },
      });
      await page.$eval(".popover.show .viz-cast", (n) => n.scrollIntoView({ block: "end" }));
      await pause(500);
      await ctx.shoot("worlds-cast-fleet", {
        clip: ".popover.show [data-viz-cast-slot]",
        pad: 6,
        boxes: {
          mode: '.popover.show .viz-cast [aria-label="Cast mode"]',
          skin: '.popover.show .viz-cast [aria-label="Skin shade"]',
          undertone: '.popover.show .viz-cast [aria-label="Undertone"]',
          hair: '.popover.show .viz-cast [aria-label="Hair color"]',
          style: '.popover.show .viz-cast .viz-chips[aria-label="Hair style"]',
        },
      });
      await page.keyboard.press("Escape");
      await pause(500);
    },
  },
  {
    id: "worlds-node-panel",
    step: "Clicks a demo agent's figure in the Christmas world, shoots its panel, then opens Customize look and shoots it.",
    async run(ctx) {
      const { page } = ctx;
      await fit(page);
      await openPanel(page);
      await visible(page, "#vizView [data-viz-panel] [data-viz-look-open]");
      await pause(600);
      await calm(page);
      await ctx.shoot("worlds-node-panel", {
        clip: "#vizView [data-viz-panel] .viz-panel-card",
        boxes: {
          look: "#vizView [data-viz-panel] [data-viz-look-open]",
          games: "#vizView [data-viz-panel] .viz-panel-build",
        },
      });
      await page.click("#vizView [data-viz-panel] [data-viz-look-open]");
      await visible(page, ".popover.show [data-viz-look-root] .viz-seg");
      await pause(600);
      await calm(page);
      await ctx.shoot("worlds-cast-one", {
        clip: ".popover.show",
        pad: 0,
        boxes: {
          presentation: '.popover.show [data-viz-look-root] [aria-label="Presentation"]',
          skin: '.popover.show [data-viz-look-root] [aria-label="Skin shade"]',
          auto: '.popover.show [data-viz-look="skin"].viz-chip-auto',
        },
      });
      await page.$eval('.popover.show [data-viz-look="reset"]', (n) => n.scrollIntoView({ block: "end" }));
      await pause(500);
      await ctx.shoot("worlds-cast-one-reset", {
        clip: ".popover.show",
        pad: 0,
        boxes: {
          hair: '.popover.show [data-viz-look-root] .viz-chips[aria-label="Hair style"]',
          reset: '.popover.show [data-viz-look="reset"]',
          note: ".popover.show [data-viz-look-root] .viz-cast-note",
        },
      });
      await page.keyboard.press("Escape");
      await pause(400);
    },
  },
  {
    id: "worlds-game",
    step: "Presses Play sample on the agent's first mini game, shoots the popup after the security gate passed it, then presses Play and shoots the running game.",
    async run(ctx) {
      const { page } = ctx;
      if (!(await shown(page, "#vizView [data-viz-panel] [data-viz-game-sample]"))) await openPanel(page);
      await page.click("#vizView [data-viz-panel] [data-viz-game-sample]");
      await visible(page, ".popover.viz-art-pop [data-viz-art]");
      let st = null;
      for (let i = 0; i < 60; i++) { st = await probe(page, "artifact"); if (st?.verdict && st.verdict !== "pending") break; await pause(250); }
      if (st?.verdict !== "pass") throw new Error(`the security gate did not pass the sample: ${JSON.stringify(st)}`);
      await pause(600);
      await calm(page);
      await ctx.shoot("worlds-game-gate", {
        clip: ".popover.viz-art-pop",
        pad: 0,
        boxes: {
          tags: ".popover.viz-art-pop .viz-art-tags",
          status: ".popover.viz-art-pop [data-viz-art-st]",
          stage: ".popover.viz-art-pop [data-viz-art-stage]",
          play: ".popover.viz-art-pop [data-viz-art-play]",
          keep: ".popover.viz-art-pop [data-viz-art-keep]",
          discard: ".popover.viz-art-pop [data-viz-art-discard]",
        },
      });
      await page.click(".popover.viz-art-pop [data-viz-art-play]");
      await page.waitForSelector(".popover.viz-art-pop iframe[data-viz-art-frame]", { timeout: 8000 });
      await pause(3500);
      await calm(page);
      await ctx.shoot("worlds-game-playing", {
        clip: ".popover.viz-art-pop",
        pad: 0,
        boxes: { stage: ".popover.viz-art-pop [data-viz-art-stage]", restart: ".popover.viz-art-pop [data-viz-art-play]" },
      });
      await page.click(".popover.viz-art-pop [data-viz-art-close]");
      await pause(500);
      await page.keyboard.press("Escape"); // the node panel
      await pause(500);
    },
  },
  {
    id: "worlds-approvals",
    step: "Waits for a DEMO approval ask in the Christmas world, shoots its badge and the triage pill, opens the badge's pop-out, then the triage list.",
    async run(ctx) {
      const { page } = ctx;
      if (await shown(page, "#vizView [data-viz-panel]:not([hidden]) [data-viz-panel-close]")) {
        await page.click("#vizView [data-viz-panel] [data-viz-panel-close]");
        await pause(500);
      }
      await fit(page);
      await clearToasts(page);
      // The demo settles its own asks after a while: an ask that leaves mid-capture is skipped for the next one.
      const seen = [];
      for (let attempt = 1; ; attempt++) {
        const ask = await page.waitForFunction((known) => {
          const p = window.__vizProbe?.approvals?.();
          return p?.pending.find((a) => !known.includes(a.id) && a.badge && a.badge.x > 40 && a.badge.y > 120 && a.badge.x < innerWidth - 40 && a.badge.y < innerHeight - 160) ?? false;
        }, { timeout: 90000, polling: 250 }, seen).then((h) => h.jsonValue()).catch(() => { throw new Error("no demo approval ask came in within 90 s"); });
        seen.push(ask.id);
        const badge = `#vizView [data-viz-ask-badge="${ask.node}"]`;
        try {
          await visible(page, badge, 3000);
          await calm(page);
          await ctx.shoot("worlds-approval-badge", { boxes: { badge, pill: "#vizView [data-viz-tri-pill]" } });
          const b = await page.$eval(badge, (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
          await page.mouse.click(b.x, b.y);
          await visible(page, "#vizView [data-viz-ask] [data-viz-ask-act=once]", 3000);
          await pause(500);
          await calm(page);
          await ctx.shoot("worlds-approval-popout", {
            clip: await unionRect(page, [badge, "#vizView [data-viz-ask]"], 16),
            boxes: {
              badge,
              approve: "#vizView [data-viz-ask] [data-viz-ask-act=once]",
              auto: "#vizView [data-viz-ask] [data-viz-ask-act=auto]",
              deny: "#vizView [data-viz-ask] [data-viz-ask-act=deny]",
            },
          });
          break;
        } catch (e) {
          if (attempt >= 4) throw e;
          console.log(`  the demo ask on ${ask.node} changed during the capture (${e?.message ?? e}); trying the next one`);
          // Esc with nothing open would close Visualize itself.
          if (await shown(page, "#vizView [data-viz-ask] [data-viz-ask-act=once]")) await page.keyboard.press("Escape");
          await pause(400);
        }
      }
      await page.keyboard.press("Escape");
      await pause(500);
      await page.click("#vizView [data-viz-tri-pill]");
      await visible(page, "#vizView [data-viz-tri-row]");
      await pause(600);
      // Hold the pointer on the strip: it folds back after 4 s idle.
      const s = await page.$eval("#vizView [data-viz-tri-list]", (n) => { const r = n.getBoundingClientRect(); return { x: r.right - 6, y: r.bottom - 4 }; });
      await page.mouse.move(s.x, s.y);
      await pause(300);
      await ctx.shoot("worlds-approval-strip", {
        clip: "#vizView [data-viz-tri]",
        boxes: {
          pill: "#vizView [data-viz-tri-pill]",
          row: "#vizView [data-viz-tri-row]",
          jump: "#vizView [data-viz-tri-row] [data-viz-tri-jump]",
          approve: "#vizView [data-viz-tri-row] [data-viz-tri-ok]",
          deny: "#vizView [data-viz-tri-row] [data-viz-tri-no]",
        },
      });
      await calm(page);
    },
  },
  {
    id: "worlds-store",
    step: "Goes to the store from Worlds > Get more worlds with motion reduced (still posters), blanks the price lines, and shoots the World Packs, the world cards and the Installed tab.",
    async run(ctx) {
      const { page } = ctx;
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      if (!(await page.$(".popover.show [data-viz-world-store]"))) await page.click("#vizView [data-viz-worlds]");
      await visible(page, ".popover.show [data-viz-world-store]");
      await page.click(".popover.show [data-viz-world-store]");
      await visible(page, ".plg-layer.plg-in .plg-drawer");
      await pause(900);
      if (!(await page.$('[data-plg-tier="premium"][aria-selected="true"]'))) { await page.click('[data-plg-tier="premium"]'); await pause(500); }
      await page.waitForFunction(() => !!document.querySelector('[data-plg-act="world-christmas"]')?.textContent?.includes("Open in Visualize"), { timeout: 20000 })
        .catch(() => { throw new Error("the Christmas card does not say Open in Visualize"); });
      await clearToasts(page);
      await hidePrices(page);
      await page.mouse.move(700, 880);
      await pause(400);
      await ctx.shoot("worlds-store-packs", {
        clip: ".plg-drawer",
        pad: 0,
        boxes: {
          premium: '[data-plg-tier="premium"]',
          installed: '[data-plg-tier="installed"]',
          packs: "#plgSecPacks",
          patron: '[data-plg-card="bundle-patron"]',
          sponsor: '[data-plg-card="bundle-sponsor"]',
        },
      });
      await page.$eval("#plgSecWorlds", (n) => n.closest("section").scrollIntoView({ block: "start" }));
      await pause(700);
      await hidePrices(page);
      await ctx.shoot("worlds-store-worlds", {
        clip: ".plg-drawer",
        pad: 0,
        boxes: {
          heading: "#plgSecWorlds",
          import: "[data-plg-wimport]",
          installed: '[data-plg-act="world-christmas"]',
          buy: '[data-plg-act="world-valentines"]',
        },
      });
      await page.click('[data-plg-tier="installed"]');
      await visible(page, '[data-plg-iopen="world-christmas"]');
      await pause(700);
      await ctx.shoot("worlds-store-installed", {
        clip: ".plg-drawer",
        pad: 0,
        boxes: {
          restore: "[data-plg-restore]",
          card: '.plg-card[data-plg-card="world-christmas"]',
          open: '[data-plg-iopen="world-christmas"]',
        },
      });
      await page.click('[data-plg-tier="premium"]');
      await pause(300);
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    },
  },
];
