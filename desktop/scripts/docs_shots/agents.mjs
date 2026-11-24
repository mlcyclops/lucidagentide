// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/docs_shots/agents.mjs
//
// P-DOCS.1b (ADR-0660): the screenshots of the "Agents and Fleet" section of docs.lucid-agents.com
// (agents/*.mdx in the docs repo). Run by desktop/scripts/docs_capture_p_docs_1.mjs:
//   bun desktop/scripts/docs_capture_p_docs_1.mjs agents --port 7831
//
// The QA engine runs the scripted fake agent (desktop/scripts/fleet_demo/scripts), so every lane, approval, preview
// and floating-Agent idea in these shots is real UI over scripted work. The module:
//   - makes four demo folders next to the sample workspace (website, docs-site, data-reports, trip-photos) and runs
//     git init in each, so lanes can start there;
//   - in the browser only (a fetch wrapper, never on disk): lists those folders as recent folders in the engine's
//     /api/workspace answer, and replaces this machine's host and user name with demo values in every JSON answer;
//   - seeds the Agents rail (lucid.agents.v1) with three saved Agents in preset colors and trip-photos removed, so
//     + Add agent offers it as a recent folder;
//   - pins Performance to Full (a headless browser lands on the minimal tier) and Agent Worlds' Auto camera off.
// Lanes are started and prompted through the engine API, the way seed_fleet.mjs does; the rest is clicked.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const FOLDERS = ["website", "docs-site", "data-reports", "trip-photos"];
const RELEASE_PROMPT = "Write the release notes and changelog";
const GAME_PROMPT = "Build a Lucid Agent World mini game: penalty shootout";
const SCHED_PROMPT = "Update the weekly sales report from the new numbers in the data folder, and list anything that changed by more than 10 percent.";
const norm = (p) => { const s = String(p).trim().replace(/[\\/]+/g, "/"); return (s.length > 1 ? s.replace(/\/$/, "") : s).toLowerCase(); };

/** State shared by the steps (one page, in order). */
const S = { dir: "", paths: {}, lanes: {} };

// ── helpers (copied from connect.mjs and get_started.mjs, plus a few for lanes) ──────────────────────────────────

const shown = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  if (!n || n.closest("[hidden]")) return false;
  const r = n.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}, sel);
const visible = (page, sel, timeout = 20000) => page.waitForSelector(sel, { visible: true, timeout })
  .catch(() => { throw new Error(`"${sel}" did not appear`); });
async function until(read, ms, what, every = 300) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    last = await read();
    if (last) return last;
    if (Date.now() > end) throw new Error(`${what} (last: ${JSON.stringify(last)})`);
    await pause(every);
  }
}
/** Park the mouse where no tooltip lives and let any open tooltip fade. */
async function calm(page, x = 560, y = 380) {
  await page.mouse.move(x, y);
  await pause(450);
}
/** Close every toast: its X, else a "Not now" style action. */
async function clearToasts(page) {
  await page.evaluate(() => {
    for (const t of document.querySelectorAll("#toasts .toast")) {
      const btns = [...t.querySelectorAll("button")];
      const x = t.querySelector(".h button") ?? btns.find((b) => /^(Not now|Got it|Dismiss|OK|Close|Later)$/i.test(b.textContent.trim()));
      x?.click();
    }
  });
  await page.waitForFunction(() => !document.querySelector("#toasts")?.children.length, { timeout: 2500 }).catch(() => {});
  await pause(200);
}
/** Wait for the toast whose title contains `title`, mark it, and return a selector for it. */
async function toast(page, title, timeout = 30000) {
  await page.waitForFunction((t) => [...document.querySelectorAll("#toasts .toast.show")].some((x) => x.querySelector(".h")?.textContent?.includes(t)), { timeout }, title)
    .catch(() => { throw new Error(`no "${title}" toast appeared`); });
  await page.evaluate((t) => {
    for (const x of document.querySelectorAll("#toasts .toast")) {
      if (x.querySelector(".h")?.textContent?.includes(t)) x.setAttribute("data-docs", "toast"); else x.removeAttribute("data-docs");
    }
  }, title);
  await pause(500);
  return '#toasts .toast[data-docs="toast"]';
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
/** Click an element at its center with the real mouse. */
async function clickAt(page, sel) {
  await visible(page, sel);
  const c = await page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await page.mouse.click(c.x, c.y);
}
async function hoverAt(page, sel) {
  await visible(page, sel);
  const c = await page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await page.mouse.move(c.x, c.y);
}
/** Drag an element by (dx, dy) with the real mouse, in small steps. */
async function drag(page, sel, dx, dy) {
  await visible(page, sel);
  const c = await page.$eval(sel, (n) => { const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(c.x + (dx * i) / 12, c.y + (dy * i) / 12); await pause(16); }
  await page.mouse.up();
  await pause(400);
}
/** The Agent box for the folder named `name` on the rail, marked so a selector finds it. */
async function tile(page, name) {
  const sel = `.agr-tile[data-docs-tile="${name}"]`;
  await until(() => page.evaluate((n) => {
    const t = [...document.querySelectorAll(".agr-tile[data-agent]")].find((x) => x.dataset.agent.endsWith(`/${n}`));
    if (!t) return false;
    t.setAttribute("data-docs-tile", n);
    t.scrollIntoView({ block: "nearest" });
    return true;
  }, name), 15000, `the rail shows no Agent for ${name}`);
  return sel;
}
async function json(ctx, path, body) {
  const r = await ctx.api(path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  const t = await r.json().catch(() => null);
  return t?.data ?? t;
}
const lanes = async (ctx) => (await json(ctx, "/api/fleet/status"))?.lanes ?? [];
const laneOf = async (ctx, id) => (await lanes(ctx)).find((l) => l.id === id) ?? null;
/** Start a lane in `cwd` and wait until it is past "starting" (the engine refuses while the machine is overloaded). */
async function spawnLane(ctx, cwd, name) {
  let r = null;
  for (const end = Date.now() + 240000; ;) {
    r = await json(ctx, "/api/fleet/spawn", { cwd, name });
    if (r?.ok !== false || !/has been at \d+%/.test(r?.reason ?? "") || Date.now() > end) break;
    await pause(5000);
  }
  const id = r?.lane?.id;
  if (!id) throw new Error(`lane ${name} did not start: ${JSON.stringify(r).slice(0, 300)}`);
  await until(async () => { const l = await laneOf(ctx, id); return l && l.status !== "starting" ? l : null; }, 90000, `lane ${name} never became ready`);
  return id;
}
/** Prompt a lane; its NDJSON stream is read to its end in the background. */
function promptLane(ctx, laneId, text) {
  void ctx.api("/api/fleet/prompt", { method: "POST", body: JSON.stringify({ laneId, text }) }).then((r) => r.text()).catch(() => {});
}
/** Click Allow on Main's open approval cards until Main's turn ends. */
async function finishMain(ctx) {
  await until(async () => {
    await ctx.page.evaluate(() => {
      const btns = [...document.querySelectorAll(".perm [data-oid]")].filter((b) => !b.closest("#switchSheet") && !b.disabled && b.getBoundingClientRect().width > 0);
      (btns.find((b) => b.classList.contains("eg-allow") || b.classList.contains("ok")) ?? btns.find((b) => /allow|approve|yes|once/i.test(b.textContent ?? "")))?.click();
    });
    return !(await json(ctx, "/api/session/busy"))?.busy;
  }, 240000, "Main's turn did not end", 1000);
}
/** Wait for a lane's turn to end, answering its one approval ask with Allow. */
async function finishLane(ctx, id) {
  await until(async () => {
    const l = await laneOf(ctx, id);
    if (l?.status === "needs-approval") await json(ctx, "/api/fleet/answer", { laneId: id, allow: true, scope: "session" });
    return l && l.turns >= 1 && !["working", "needs-approval", "starting"].includes(l.status);
  }, 240000, `lane ${id} did not finish its turn`, 1000);
}
const vizShown = (page) => page.evaluate(() => { const v = document.getElementById("vizView"); return !!v && !v.hidden && v.classList.contains("open"); });
async function closeViz(page) {
  for (let i = 0; i < 5 && (await vizShown(page)); i++) { await page.keyboard.press("Escape"); await pause(400); }
  await page.waitForFunction(() => { const v = document.getElementById("vizView"); return !v || v.hidden; }, { timeout: 3000 }).catch(() => {});
}
const dockOpen = (page) => shown(page, "#fleetDock");
async function closeDock(page) { if (await dockOpen(page)) { await clickAt(page, "#ctFleet"); await pause(600); } }
async function openDock(page) { if (!(await dockOpen(page))) { await clickAt(page, "#ctFleet"); await visible(page, "#fleetDock"); await pause(700); } }
/** The rail collapsed and on its Agents view. */
async function agentsRail(page) {
  if (!(await page.$eval("#inspector", (n) => n.classList.contains("rail")))) { await clickAt(page, "#inspCollapse"); await pause(600); }
  if ((await page.$eval("#railAgents", (b) => b.getAttribute("aria-pressed"))) !== "true") { await clickAt(page, "#railAgents"); await pause(600); }
  await visible(page, ".agr-tile[data-agent]");
}
async function closeModule(page) {
  if (await page.$(".agr-pop.show")) { await page.keyboard.press("Escape"); await pause(350); }
}

export const steps = [
  {
    id: "setup",
    step: "Makes the demo folders, lists them as recent folders and scrubs host names in the browser, seeds the Agents rail, and walks past the first-run prompts.",
    async run(ctx) {
      const { page } = ctx;
      S.dir = dirname(ctx.workspace);
      for (const f of FOLDERS) {
        const p = join(S.dir, f);
        mkdirSync(p, { recursive: true });
        spawnSync("git", ["init", "-q"], { cwd: p });
        S.paths[f] = p;
      }
      S.paths["sample-platform"] = ctx.workspace;
      const real = [hostname(), userInfo().username].filter((s) => s && s.length > 2);
      const recents = FOLDERS.map((f) => ({ path: S.paths[f], name: f, isGit: true }));
      await page.evaluateOnNewDocument((names, extra) => {
        const orig = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const res = await orig(...args);
          if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;
          let text = await res.text();
          for (const n of names) text = text.split(n).join(n === names[0] ? "DEMO-PC" : "demo");
          const url = String(args[0] instanceof Request ? args[0].url : args[0]);
          const method = String(args[1]?.method ?? (args[0] instanceof Request ? args[0].method : "GET")).toUpperCase();
          if (/\/api\/workspace(\?|$)/.test(url) && method === "GET") {
            try {
              const j = JSON.parse(text);
              const d = j?.data ?? j;
              if (d && Array.isArray(d.recent)) {
                const have = new Set(d.recent.map((r) => String(r.path).toLowerCase()));
                for (const r of extra) if (!have.has(r.path.toLowerCase())) d.recent.push(r);
                text = JSON.stringify(j);
              }
            } catch { /* not ours to fix */ }
          }
          return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
        };
      }, real, recents);
      const agent = (f, theme) => ({ id: norm(S.paths[f]), path: S.paths[f], name: null, theme, hue: 145, saved: true });
      const doc = { v: 1, agents: [agent("website", "ember"), agent("docs-site", "glacier"), agent("data-reports", "orchid")], hidden: [norm(S.paths["trip-photos"])], manual: false, main: null };
      await page.evaluate((d) => {
        localStorage.setItem("lucid.personalNudged", "1");
        localStorage.setItem("lucid.perfMode", "full");
        localStorage.setItem("lucid.viz.autoCamera", "0");
        localStorage.setItem("lucid.rail.view", "agents");
        localStorage.setItem("lucid.fleetHome.v1", "grid");
        localStorage.setItem("lucid.agents.v1", JSON.stringify(d));
      }, doc);
      await ctx.reload();
      // The first-run prompts, in whatever order they come.
      let quiet = 0;
      for (const end = Date.now() + 150000; quiet < 6;) {
        if (Date.now() > end) throw new Error("the first-run prompts did not end");
        let acted = false;
        for (const sel of ["#roleGateSkip", "#emailGateSkip", '#govGate [data-gov="no"]', '#provChoice [data-prov="later"]', ".coach-card [data-coach-skip]"]) {
          if (await shown(page, sel)) { await page.click(sel).catch(() => {}); acted = true; await pause(600); }
        }
        quiet = acted ? 0 : quiet + 1;
        await pause(500);
      }
      await page.waitForFunction(() => !document.querySelector(".spw-host"), { timeout: 120000, polling: 500 })
        .catch(() => { throw new Error("Main's spin-up walker never left"); });
      await clearToasts(page);
      await agentsRail(page);
      await tile(page, "website");
    },
  },
  {
    id: "agents-rail",
    step: "Starts a lane in docs-site and prompts it, so that Agent is lit, then shoots the whole window with the rail on its Agents view.",
    async run(ctx) {
      const { page } = ctx;
      S.lanes.docs = await spawnLane(ctx, S.paths["docs-site"], "Docs writer");
      promptLane(ctx, S.lanes.docs, RELEASE_PROMPT);
      await until(() => page.evaluate(() => [...document.querySelectorAll(".agr-tile[data-agent]")].some((t) => t.dataset.agent.endsWith("/docs-site") && t.dataset.state === "work")), 60000, "the docs-site Agent did not light up");
      await page.waitForFunction(() => !document.querySelector(".spw-host"), { timeout: 60000, polling: 500 }).catch(() => {});
      await closeDock(page);
      await clearToasts(page);
      await calm(page);
      const work = await tile(page, "docs-site");
      const idle = await tile(page, "website");
      await ctx.shoot("agents-rail", {
        boxes: { rail: "#metricsRail", toggle: "#railAgents", work, idle, add: "[data-agr-add]" },
      });
    },
  },
  {
    id: "agents-metrics",
    step: "Flips the rail to Metrics with the toggle and shoots the rail, then flips it back to Agents.",
    async run(ctx) {
      const { page } = ctx;
      await clickAt(page, "#railAgents");
      await pause(900);
      await calm(page);
      // The rail is as tall as the window; the clip ends under its last laid-out tile.
      const { clip, tiles } = await page.evaluate(() => {
        const ins = document.querySelector("#inspector").getBoundingClientRect();
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const t of document.querySelectorAll("#railTiles > *")) {
          const r = t.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top); x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom); }
        }
        return {
          clip: { x: Math.floor(ins.left), y: Math.floor(ins.top), width: Math.ceil(ins.width), height: Math.ceil(y2 - ins.top + 14) },
          tiles: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
        };
      });
      await ctx.shoot("agents-metrics", { clip, boxes: { toggle: "#railAgents", tiles } });
      await clickAt(page, "#railAgents");
      await pause(900);
      await visible(page, ".agr-tile[data-agent]");
    },
  },
  {
    id: "agents-module",
    step: "Hovers the website Agent and shoots its module beside the rail.",
    async run(ctx) {
      const { page } = ctx;
      const t = await tile(page, "website");
      await hoverAt(page, t);
      await visible(page, ".agr-pop.show");
      await pause(700);
      const clip = await unionRect(page, [".agr-pop.show", t, "#railAgents"], 14);
      await ctx.shoot("agents-module", {
        clip,
        boxes: {
          tile: t,
          name: ".agr-pop.show .agr-ph-name",
          state: ".agr-pop.show [data-agr-state]",
          color: ".agr-pop.show .agr-sw",
          hue: ".agr-pop.show [data-agr-hue]",
          rename: '.agr-pop.show [data-act="rename"]',
          activate: '.agr-pop.show [data-act="activate"]',
          remove: '.agr-pop.show [data-act="remove"]',
        },
      });
    },
  },
  {
    id: "agents-remove-confirm",
    step: "Clicks the website Agent, clicks Remove from rail and shoots the confirm, then chooses Cancel.",
    async run(ctx) {
      const { page } = ctx;
      await calm(page);
      await pause(800);
      const t = await tile(page, "website");
      await clickAt(page, t);
      await visible(page, '.agr-pop.show [data-act="remove"]');
      await pause(400);
      await clickAt(page, '.agr-pop.show [data-act="remove"]');
      await visible(page, '.agr-pop.show [data-act="remove-yes"]');
      await pause(400);
      await ctx.shoot("agents-remove-confirm", {
        clip: ".agr-pop.show",
        pad: 3,
        boxes: { yes: '.agr-pop.show [data-act="remove-yes"]', no: '.agr-pop.show [data-act="remove-no"]' },
      });
      await clickAt(page, '.agr-pop.show [data-act="remove-no"]');
      await pause(300);
      await closeModule(page);
      await calm(page);
    },
  },
  {
    id: "agents-add-intro",
    step: "Clicks + Add agent and shoots the first step of the popover.",
    async run(ctx) {
      const { page } = ctx;
      await clearToasts(page);
      await page.$eval("[data-agr-add]", (n) => n.scrollIntoView({ block: "nearest" }));
      await clickAt(page, "[data-agr-add]");
      await visible(page, ".agr-add-pop.show [data-add-path]");
      await pause(600);
      const clip = await unionRect(page, [".agr-add-pop.show", "[data-agr-add]"], 14);
      await ctx.shoot("agents-add-intro", {
        clip,
        boxes: {
          add: "[data-agr-add]",
          about: ".agr-add-pop.show .agr-add-tx",
          recent: ".agr-add-pop.show [data-add-path]",
          pick: '.agr-add-pop.show [data-add-act="pick"]',
          cancel: '.agr-add-pop.show [data-add-act="cancel"]',
        },
      });
    },
  },
  {
    id: "agents-add-purpose",
    step: "Picks the recent folder trip-photos, types a name, picks Something else, and shoots the second step.",
    async run(ctx) {
      const { page } = ctx;
      await clickAt(page, ".agr-add-pop.show [data-add-path]");
      await visible(page, ".agr-add-pop.show [data-add-name]");
      await pause(400);
      await clickAt(page, ".agr-add-pop.show [data-add-name]");
      await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
      await page.keyboard.type("Trip photos");
      await clickAt(page, '.agr-add-pop.show [data-add-kind="other"]');
      await pause(500);
      const clip = await unionRect(page, [".agr-add-pop.show", "[data-agr-add]"], 14);
      await ctx.shoot("agents-add-purpose", {
        clip,
        boxes: {
          name: ".agr-add-pop.show [data-add-name]",
          path: ".agr-add-pop.show .agr-ph-path",
          purposes: '.agr-add-pop.show [data-add-kind="app"]',
          chosen: '.agr-add-pop.show [data-add-kind="other"]',
          back: '.agr-add-pop.show [data-add-act="back"]',
          add: '.agr-add-pop.show [data-add-act="add"]',
        },
      });
    },
  },
  {
    id: "agents-add-done",
    step: "Clicks Add agent and shoots the new Agent at the top of the rail with its toast.",
    async run(ctx) {
      const { page } = ctx;
      await clickAt(page, '.agr-add-pop.show [data-add-act="add"]');
      await toast(page, "is on your rail");
      await clearToasts(page);
      await calm(page);
      const t = await tile(page, "trip-photos");
      await page.$eval("[data-agr-list]", (l) => { l.scrollTop = 0; });
      await pause(600);
      await ctx.shoot("agents-add-done", {
        clip: await unionRect(page, ["#railAgents", t, "[data-agr-add]"], 14),
        boxes: { tile: t },
      });
    },
  },
  {
    id: "agents-activate-menu",
    step: "Clicks the website Agent so its module opens with Activate expanded, and shoots the four choices.",
    async run(ctx) {
      const { page } = ctx;
      await calm(page);
      const t = await tile(page, "website");
      await clickAt(page, t);
      await visible(page, '.agr-pop.show [data-go="fleet"]');
      await pause(800);
      await ctx.shoot("agents-activate-menu", {
        clip: ".agr-pop.show",
        pad: 3,
        boxes: {
          activate: '.agr-pop.show [data-act="activate"]',
          takeover: '.agr-pop.show [data-go="takeover"]',
          fleet: '.agr-pop.show [data-go="fleet"]',
          world: '.agr-pop.show [data-go="world"]',
          schedule: '.agr-pop.show [data-act="schedule"]',
        },
      });
    },
  },
  {
    id: "agents-activate-fleet",
    step: "Chooses Start new Fleet session and shoots the window once the new lane's card is ready.",
    async run(ctx) {
      const { page } = ctx;
      const before = new Set((await lanes(ctx)).map((l) => l.id));
      await clickAt(page, '.agr-pop.show [data-go="fleet"]');
      const lane = await until(async () => (await lanes(ctx)).find((l) => !before.has(l.id) && norm(l.cwd) === norm(S.paths.website)) ?? null, 60000, "no lane started in website");
      S.lanes.website = lane.id;
      await toast(page, "is ready", 90000);
      const card = `#fleetDock .fleet-card[data-lane="${lane.id}"]`;
      await visible(page, `${card} [data-fleet-input]`);
      await page.waitForFunction((c) => !document.querySelector(`${c}[data-status="starting"]`) && !document.querySelector(".spw-host"), { timeout: 60000 }, card).catch(() => {});
      await pause(1200);
      await page.focus(`${card} [data-fleet-input]`);
      await page.mouse.move(700, 880);
      await pause(500);
      await ctx.shoot("agents-activate-fleet", {
        boxes: { card, folder: `${card} [data-fleet-cwd]`, input: `${card} [data-fleet-input]` },
      });
      await clearToasts(page);
      await closeDock(page);
    },
  },
  {
    id: "agents-activate-world",
    step: "Chooses Agent World session on the data-reports Agent and shoots Agent Worlds with the new agent's prompt panel open.",
    async run(ctx) {
      const { page } = ctx;
      await calm(page);
      const t = await tile(page, "data-reports");
      await clickAt(page, t);
      await visible(page, '.agr-pop.show [data-go="world"]');
      await pause(400);
      const before = new Set((await lanes(ctx)).map((l) => l.id));
      await clickAt(page, '.agr-pop.show [data-go="world"]');
      const lane = await until(async () => (await lanes(ctx)).find((l) => !before.has(l.id) && norm(l.cwd) === norm(S.paths["data-reports"])) ?? null, 60000, "no lane started in data-reports");
      S.lanes.reports = lane.id;
      await toast(page, "is ready in Agent Worlds", 90000);
      await until(() => page.evaluate(() => document.activeElement?.matches?.("#vizView [data-viz-panel-input]")), 30000, "the prompt panel's input does not have focus");
      await clearToasts(page);
      await page.$eval("#vizView [data-viz-auto]", (i) => { if (i.checked) i.click(); });
      await page.focus("#vizView [data-viz-panel-input]");
      await page.mouse.move(1430, 890);
      await pause(1500);
      await ctx.shoot("agents-activate-world", {
        boxes: { panel: "#vizView [data-viz-panel]", input: "#vizView [data-viz-panel-input]" },
      });
      await closeViz(page);
    },
  },
  {
    id: "agents-activate-busy",
    step: "Sends Main a prompt, chooses Take over main composer on the website Agent while Main works, shoots the question, then chooses Stay here and lets Main finish.",
    async run(ctx) {
      const { page } = ctx;
      await closeDock(page);
      await clearToasts(page);
      await clickAt(page, "#input");
      await page.keyboard.type(RELEASE_PROMPT);
      await page.keyboard.press("Enter");
      await until(async () => !!(await json(ctx, "/api/session/busy"))?.busy, 20000, "Main did not start its turn");
      await pause(1500);
      const t = await tile(page, "website");
      await clickAt(page, t);
      await visible(page, '.agr-pop.show [data-go="takeover"]');
      await pause(400);
      await clickAt(page, '.agr-pop.show [data-go="takeover"]');
      await visible(page, '#switchSheet [data-takeover="after"]', 30000);
      await clearToasts(page);
      await calm(page, 560, 200);
      await pause(600);
      const clip = await unionRect(page, ["#switchSheet", "#input", "#send"], 8);
      await ctx.shoot("agents-activate-busy", {
        clip,
        boxes: {
          after: '#switchSheet [data-takeover="after"]',
          now: '#switchSheet [data-takeover="now"]',
          stay: '#switchSheet [data-takeover="stay"]',
        },
      });
      await clickAt(page, '#switchSheet [data-takeover="stay"]');
      await pause(500);
      await finishMain(ctx);
      await clearToasts(page);
      // A new chat, so later shots do not carry this turn's transcript (its usage line shows a cost).
      let asked = false;
      for (let i = 0; i < 4 && !asked; i++) {
        // The sessions sidebar collapses once Main has a conversation; its + button runs the same handler.
        await page.$eval("#newSession", (b) => b.click());
        const ask = await toast(page, "Start a new session?", 6000).catch(() => null);
        asked = !!ask && await page.evaluate((s) => {
          const b = [...document.querySelectorAll(`${s} button`)].find((x) => x.textContent.trim() === "New session");
          b?.click();
          return !!b;
        }, ask);
        if (!asked) {
          await page.screenshot({ path: join(ctx.root, `agents-newsession-${i}.png`) });
          if (await shown(page, "#switchSheet")) await page.keyboard.press("Escape");
          await pause(3000);
        }
      }
      if (!asked) throw new Error(`New session did not ask to confirm; see ${ctx.root}\\agents-newsession-*.png`);
      await until(() => page.evaluate(() => !document.querySelector("#thread .msg")), 15000, "the new chat still shows the old transcript");
      await clearToasts(page);
    },
  },
  {
    id: "agents-schedule-form",
    step: "Opens Schedule this Agent on data-reports, chooses Weekly on Monday, Wednesday and Friday, types instructions and shoots the form.",
    async run(ctx) {
      const { page } = ctx;
      await calm(page);
      const t = await tile(page, "data-reports");
      await clickAt(page, t);
      await visible(page, '.agr-pop.show [data-act="schedule"]');
      await pause(400);
      await clickAt(page, '.agr-pop.show [data-act="schedule"]');
      await visible(page, ".agr-pop.show [data-sched-prompt]");
      await clickAt(page, '.agr-pop.show [data-sched-repeat="weekly"]');
      await visible(page, '.agr-pop.show [data-sched-day="2"]');
      await clickAt(page, '.agr-pop.show [data-sched-day="2"]');
      await clickAt(page, '.agr-pop.show [data-sched-day="4"]');
      await page.$eval(".agr-pop.show [data-sched-time]", (i) => {
        i.value = "09:00";
        i.dispatchEvent(new Event("input", { bubbles: true }));
        i.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await clickAt(page, ".agr-pop.show [data-sched-prompt]");
      await page.keyboard.type(SCHED_PROMPT);
      await pause(600);
      await ctx.shoot("agents-schedule-form", {
        clip: ".agr-pop.show",
        pad: 3,
        boxes: {
          repeat: ".agr-pop.show .agr-seg",
          days: ".agr-pop.show .agr-days",
          time: ".agr-pop.show [data-sched-time]",
          prompt: ".agr-pop.show [data-sched-prompt]",
          auto: ".agr-pop.show .agr-check",
          note: ".agr-pop.show [data-sched-note]",
          save: '.agr-pop.show [data-act="sched-save"]',
        },
      });
    },
  },
  {
    id: "agents-schedule-saved",
    step: "Clicks Save schedule and shoots the schedule listed in the module with its pause and delete buttons.",
    async run(ctx) {
      const { page } = ctx;
      await clickAt(page, '.agr-pop.show [data-act="sched-save"]');
      await visible(page, ".agr-pop.show .agr-sj [data-sj-toggle]", 15000);
      await pause(700);
      await ctx.shoot("agents-schedule-saved", {
        clip: ".agr-pop.show",
        pad: 3,
        boxes: {
          row: ".agr-pop.show .agr-sj",
          pause: ".agr-pop.show .agr-sj [data-sj-toggle]",
          remove: ".agr-pop.show .agr-sj [data-sj-del]",
          msg: ".agr-pop.show [data-ap-msg]",
        },
      });
      await clickAt(page, '.agr-pop.show [data-act="sched-back"]');
      await pause(400);
      await closeModule(page);
    },
  },
  {
    id: "agents-fleet-grid",
    step: "Waits for the Docs writer lane to ask for approval, opens the Fleet and shoots the window with its lanes.",
    async run(ctx) {
      const { page } = ctx;
      await until(async () => (await laneOf(ctx, S.lanes.docs))?.status === "needs-approval", 180000, "the Docs writer lane never asked for approval");
      await openDock(page);
      const card = `#fleetDock .fleet-card[data-lane="${S.lanes.docs}"]`;
      await visible(page, `${card} [data-fleet-approve]`);
      await page.$eval(card, (c) => c.scrollIntoView({ block: "nearest" }));
      await clearToasts(page);
      // The lane's floating Agent sits on the approval bar's text; drag it up into the transcript, as a reader would.
      await drag(page, `.abd[data-abd-surface="lane"][data-abd-lane="${S.lanes.docs}"]`, 0, -90);
      await page.mouse.move(700, 880);
      await pause(800);
      await ctx.shoot("agents-fleet-grid", {
        boxes: {
          button: "#ctFleet",
          name: `${card} [data-fleet-name]`,
          folder: `${card} [data-fleet-cwd]`,
          model: `${card} [data-fleet-model]`,
          stop: `${card} [data-fleet-stop]`,
          approve: `${card} [data-fleet-approve]`,
          input: `${card} [data-fleet-input]`,
          add: "#fleetDock [data-fleet-add]",
        },
      });
    },
  },
  {
    id: "agents-fleet-approval",
    step: "Shoots the Docs writer lane's card with its approval question.",
    async run(ctx) {
      const { page } = ctx;
      const card = `#fleetDock .fleet-card[data-lane="${S.lanes.docs}"]`;
      await ctx.shoot("agents-fleet-approval", {
        clip: card,
        pad: 6,
        boxes: {
          ask: `${card} [data-fleet-approve-txt]`,
          allow: `${card} [data-fleet-allow]`,
          session: `${card} [data-fleet-allow-session]`,
          deny: `${card} [data-fleet-deny]`,
        },
      });
      await clickAt(page, `${card} [data-fleet-allow]`);
      await pause(800);
    },
  },
  {
    id: "agents-fleet-new",
    step: "Clicks + Agent in the Fleet and shoots the new-agent form, then closes it.",
    async run(ctx) {
      const { page } = ctx;
      await clickAt(page, "#fleetDock [data-fleet-add]");
      await visible(page, "#fleetDock .fleet-spawn-card [data-spawn-go]");
      await page.$eval("#fleetDock .fleet-spawn-card", (c) => c.scrollIntoView({ block: "nearest" }));
      await page.mouse.move(700, 880);
      await pause(800);
      const f = "#fleetDock .fleet-spawn-card";
      await ctx.shoot("agents-fleet-new", {
        clip: f,
        pad: 6,
        boxes: {
          folder: `${f} [data-spawn-cwd]`,
          browse: `${f} [data-spawn-browse]`,
          name: `${f} [data-spawn-name]`,
          model: `${f} [data-spawn-model]`,
          spawn: `${f} [data-spawn-go]`,
        },
      });
      await clickAt(page, `${f} [data-spawn-cancel]`);
      await pause(500);
    },
  },
  {
    id: "agents-preview-lane",
    step: "Starts a Mini Games lane in the sample workspace, prompts it for the penalty shootout page, and shoots its card once the preview chip says Preview ready.",
    async run(ctx) {
      const { page } = ctx;
      await closeDock(page);
      S.lanes.game = await spawnLane(ctx, ctx.workspace, "Mini Games");
      await openDock(page);
      const card = `#fleetDock .fleet-card[data-lane="${S.lanes.game}"]`;
      await visible(page, card);
      promptLane(ctx, S.lanes.game, GAME_PROMPT);
      const chip = `${card} [data-lane-preview]`;
      await until(() => page.evaluate((s) => document.querySelector(s)?.dataset.phase === "ready", chip), 180000, "the Mini Games lane never showed a ready preview chip");
      await until(async () => (await laneOf(ctx, S.lanes.game))?.status !== "working", 120000, "the Mini Games lane kept working");
      const st = (await laneOf(ctx, S.lanes.game))?.status;
      if (st === "needs-approval") await json(ctx, "/api/fleet/answer", { laneId: S.lanes.game, allow: false });
      await until(async () => !["working", "needs-approval"].includes((await laneOf(ctx, S.lanes.game))?.status), 120000, "the Mini Games lane did not settle");
      await page.$eval(card, (c) => c.scrollIntoView({ block: "nearest" }));
      await page.$eval(`${card} [data-fleet-out]`, (o) => { o.scrollTop = o.scrollHeight; });
      await clearToasts(page);
      await page.mouse.move(700, 880);
      await pause(1200);
      await ctx.shoot("agents-preview-lane", {
        clip: card,
        pad: 6,
        boxes: { chip, transcript: `${card} [data-fleet-out]`, input: `${card} [data-fleet-input]` },
      });
    },
  },
  {
    id: "agents-preview-composer",
    step: "Closes the Fleet and shoots the composer's preview chip at the top right of the chat column.",
    async run(ctx) {
      const { page } = ctx;
      await closeDock(page);
      await until(() => page.evaluate(() => document.querySelector("#prevCurtainChip")?.dataset.phase === "ready"), 30000, "the composer chip is not ready");
      await clearToasts(page);
      await calm(page);
      await ctx.shoot("agents-preview-composer", { boxes: { chip: "#prevCurtainChip" } });
    },
  },
  {
    id: "agents-preview-panel",
    step: "Opens the Fleet, clicks the lane's preview chip, and shoots the Preview panel open on the lane's tab.",
    async run(ctx) {
      const { page } = ctx;
      await openDock(page);
      const card = `#fleetDock .fleet-card[data-lane="${S.lanes.game}"]`;
      await page.$eval(card, (c) => c.scrollIntoView({ block: "nearest" }));
      await pause(400);
      await clickAt(page, `${card} [data-lane-preview]`);
      await until(() => page.evaluate(() => { const p = document.getElementById("preview"); return !!p && !p.hidden && !p.classList.contains("pchip-leave") && p.getBoundingClientRect().width > 0; }), 8000, "the lane chip did not open the Preview panel");
      await pause(2500);
      await clearToasts(page);
      await page.mouse.move(700, 880);
      await pause(500);
      await ctx.shoot("agents-preview-panel", {
        boxes: { panel: "#preview", tab: `#prevTabs .prev-tab.active`, close: "#prevClose" },
      });
      await clickAt(page, "#prevClose");
      await pause(800);
      await closeDock(page);
    },
  },
  {
    id: "agents-preview-worlds",
    step: "Opens Agent Worlds with motion reduced and shoots the Mini Games agent's preview chip over its node.",
    async run(ctx) {
      const { page } = ctx;
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await clickAt(page, "#ctViz");
      await until(() => vizShown(page), 10000, "Agent Worlds did not open");
      await page.$eval("#vizView [data-viz-auto]", (i) => { if (i.checked) i.click(); });
      const chip = `#vizView [data-viz-preview-chip="${S.lanes.game}"]`;
      await visible(page, chip, 30000);
      await page.mouse.move(1430, 890);
      await clearToasts(page);
      // Wait for a frame where the chip holds still for a second, so its box is stable in the capture.
      await until(async () => {
        const a = await page.$eval(chip, (n) => { const b = n.getBoundingClientRect(); return [b.left, b.top].map(Math.round).join(","); });
        await pause(1000);
        const b = await page.$eval(chip, (n) => { const r = n.getBoundingClientRect(); return [r.left, r.top].map(Math.round).join(","); });
        return a === b;
      }, 30000, "the Worlds chip never held still");
      // The agent's floating Agent stands on the chip's text; drag it aside, as a reader would.
      const wb = `#vizView .abd[data-abd-surface="world"][data-abd-lane="${S.lanes.game}"]`;
      if (await shown(page, wb)) { await drag(page, wb, -70, 70); await page.mouse.move(1430, 890); await pause(800); }
      const r = await page.$eval(chip, (n) => { const b = n.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width }; });
      const x = Math.max(0, Math.round(r.x + r.w / 2 - 330)), y = Math.max(96, Math.round(r.y - 120));
      await ctx.shoot("agents-preview-worlds", { clip: { x, y, width: Math.min(660, 1440 - x), height: Math.min(360, 900 - y) }, boxes: { chip } });
      await closeViz(page);
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    },
  },
  {
    id: "agents-buddy-main",
    step: "Hovers Main's floating Agent over the composer and shoots it with its hover helper.",
    async run(ctx) {
      const { page } = ctx;
      await closeDock(page);
      await clearToasts(page);
      const b = '.abd[data-abd-surface="main"]';
      await visible(page, b, 30000);
      await calm(page);
      await hoverAt(page, b);
      await visible(page, "#tip.show", 5000);
      await pause(700);
      const clip = await unionRect(page, ['.abd-host[data-where="main"]', ".composer-wrap", "#tip"], 16);
      await ctx.shoot("agents-buddy-main", {
        clip,
        boxes: { buddy: b, name: '.abd-host[data-where="main"] .abd-name', tip: "#tip" },
      });
      await calm(page);
    },
  },
  {
    id: "agents-buddy-ideas",
    step: "Lets the Docs writer lane finish its turn, clicks its floating Agent in the Fleet, and shoots the ideas bubble.",
    async run(ctx) {
      const { page } = ctx;
      await finishLane(ctx, S.lanes.docs);
      await openDock(page);
      const card = `#fleetDock .fleet-card[data-lane="${S.lanes.docs}"]`;
      const b = `.abd[data-abd-surface="lane"][data-abd-lane="${S.lanes.docs}"]`;
      await page.$eval(card, (c) => c.scrollIntoView({ block: "nearest" }));
      await visible(page, b, 30000);
      await clearToasts(page);
      await pause(600);
      await clickAt(page, b);
      await until(() => page.$$eval(".abd-pop.show [data-abd-ask]", (ns) => ns.length >= 1), 60000, "the ideas bubble lists no ideas");
      await page.mouse.move(700, 890);
      await pause(900);
      await ctx.shoot("agents-buddy-ideas", {
        clip: await unionRect(page, [".abd-pop.show", b], 4),
        boxes: {
          buddy: b,
          idea: ".abd-pop.show .abd-idea",
          run: '.abd-pop.show [data-abd-run="0"]',
          ask: '.abd-pop.show [data-abd-ask="0"]',
          more: ".abd-pop.show [data-abd-refresh]",
        },
      });
      await page.keyboard.press("Escape");
      await pause(400);
    },
  },
  {
    id: "agents-buddy-hide",
    step: "Hovers the Docs writer lane's floating Agent so its red x shows, shoots it, clicks the x and shoots the toast.",
    async run(ctx) {
      const { page } = ctx;
      const host = `.abd-host[data-where="lane"]:has(.abd[data-abd-lane="${S.lanes.docs}"])`;
      const brick = `${host} .abd-brick`;
      await hoverAt(page, `${host} .abd`);
      await page.waitForFunction((s) => { const x = document.querySelector(s); return !!x && getComputedStyle(x).visibility === "visible"; }, { timeout: 5000 }, `${host} .abd-x`);
      await visible(page, "#tip.show", 5000);
      await pause(700);
      await ctx.shoot("agents-buddy-hide", {
        clip: await unionRect(page, [host, "#tip.show"], 10),
        boxes: { x: `${host} .abd-x`, brick },
      });
      await clickAt(page, `${host} .abd-x`);
      const note = await toast(page, "is hidden");
      await page.mouse.move(700, 890);
      await pause(400);
      await ctx.shoot("agents-buddy-hidden", {
        clip: note,
        boxes: { undo: `${note} .acts button` },
      });
      await page.$eval(`${note} .acts button`, (b) => b.click());
      await pause(500);
      await closeDock(page);
    },
  },
  {
    id: "agents-buddy-settings",
    step: "Opens Settings > Appearance > Floating Agents and shoots its two switches.",
    async run(ctx) {
      const { page } = ctx;
      await clearToasts(page);
      await clickAt(page, '.rail-btn[data-rail="settings"]');
      await visible(page, "#settings");
      await clickAt(page, '#setNav [data-set-cat="appearance"]');
      const sec = '#setBody [data-sec="floatingAgents"]';
      await visible(page, `${sec} .set-coll-h`);
      const open = await page.$eval(sec, (n) => n.classList.contains("open"));
      if (!open) await page.click(`${sec} .set-coll-h`);
      await visible(page, "#buddyShow + span", 5000);
      await page.$eval(sec, (n) => n.scrollIntoView({ block: "center" }));
      await calm(page, 30, 880);
      await pause(800);
      await ctx.shoot("agents-buddy-settings", {
        clip: "#settings",
        pad: 0,
        boxes: {
          category: '#setNav [data-set-cat="appearance"]',
          card: `${sec} .set-coll-h`,
          show: '#setBody label.set-toggle:has(#buddyShow)',
          auto: '#setBody label.set-toggle:has(#buddyAuto)',
        },
      });
      await clickAt(page, "#setClose");
      await pause(500);
    },
  },
];
