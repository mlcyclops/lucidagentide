// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/docs_shots/connect.mjs
//
// P-DOCS.1 (ADR-0660): the screenshots of the "Connect your apps and AI" section of docs.lucid-agents.com
// (connect/*.mdx in the docs repo). Run by desktop/scripts/docs_capture_p_docs_1.mjs:
//   bun desktop/scripts/docs_capture_p_docs_1.mjs connect --port 7822
//
// The QA engine has no provider and runs the scripted fake agent, so this module shapes a few engine answers
// in the browser (puppeteer request interception), never on disk:
//   - /api/config: no models until the demo Claude sign-in "lands", then the four Claude models of the
//     renderer's FALLBACK_CONFIG (desktop/renderer/bridge.ts); /api/setConfig and /api/config/refresh answer
//     from the same list, so no fake agent respawn is needed;
//   - /api/auth/oauth: answers "started" with a placeholder URL, so no sign-in broker and no browser runs;
//   - /api/auth: after that click, reports the Claude row as signed in as you@example.com (demo identity).
// The API key saved in the walkthrough is a real save into the isolated engine's vault, with an obviously fake
// value. The Quick connect click adds Fastmail to the isolated engine's MCP list.

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const THINKING = {
  id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: "high", options: [
    { value: "off", name: "Off" }, { value: "auto", name: "Auto" }, { value: "low", name: "Low" },
    { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "xhigh", name: "X-High" },
  ],
};
const MODE = { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] };
const CLAUDE_MODELS = [
  { value: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" }, { value: "anthropic/claude-opus-5", name: "Claude Opus 5" },
  { value: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" }, { value: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5" },
];
const DEMO_KEY = "sk-demo-0000-0000-0000-not-a-real-key-0000";

let signedIn = false;
let currentModel = "anthropic/claude-opus-5-5";
const config = () => (signedIn
  ? [{ id: "model", name: "Model", category: "model", type: "select", currentValue: currentModel, options: CLAUDE_MODELS }, MODE, THINKING]
  : [MODE, THINKING]);
const json = (data) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });

/** True when `sel` exists and is laid out. */
const shown = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  if (!n) return false;
  const r = n.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}, sel);
const visible = (page, sel, timeout = 15000) => page.waitForSelector(sel, { visible: true, timeout })
  .catch(() => { throw new Error(`"${sel}" did not appear`); });
/** Park the mouse where no tooltip lives and let any open tooltip fade. */
async function calm(page) {
  await page.mouse.move(720, 120);
  await pause(450);
}
async function clearToasts(page) {
  await page.evaluate(() => { for (const b of document.querySelectorAll("#toasts .toast .h button")) b.click(); });
  await pause(450);
}
/** Wait for the toast titled `title`, mark it, and return a selector for it. */
async function toast(page, title, timeout = 15000) {
  await page.waitForFunction((t) => [...document.querySelectorAll("#toasts .toast.show")].some((x) => x.querySelector(".h")?.textContent?.includes(t)), { timeout }, title)
    .catch(() => { throw new Error(`no "${title}" toast appeared`); });
  await page.evaluate((t) => {
    for (const x of document.querySelectorAll("#toasts .toast")) {
      if (x.querySelector(".h")?.textContent?.includes(t)) x.setAttribute("data-docs", "toast"); else x.removeAttribute("data-docs");
    }
  }, title);
  await pause(400);
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
const scrollTo = (page, sel, block = "center") => page.$eval(sel, (n, b) => n.scrollIntoView({ block: b }), block);

export const steps = [
  {
    id: "first-run",
    step: "Shapes the engine answers in the browser, reloads, skips the role, email and CUI questions, and photographs the Connect an AI provider prompt.",
    async run(ctx) {
      const { page } = ctx;
      await page.setRequestInterception(true);
      page.on("request", async (req) => {
        const url = new URL(req.url());
        const p = url.pathname, m = req.method();
        try {
          if ((p === "/api/config" && m === "GET") || p === "/api/config/refresh") return void (await req.respond(json(config())));
          if (p === "/api/setConfig") {
            const b = JSON.parse(req.postData() ?? "{}");
            if (b.configId === "model" && CLAUDE_MODELS.some((o) => o.value === b.value)) currentModel = b.value;
            return void (await req.respond(json(config())));
          }
          if (p === "/api/auth/oauth") return void (await req.respond(json({ started: true, url: "https://example.com/lucid-docs-demo-sign-in", output: "" })));
          if (p === "/api/auth" && m === "GET" && signedIn) {
            const real = await (await ctx.api("/api/auth")).json();
            for (const prov of real?.data?.majors ?? []) if (prov.id === "anthropic") { prov.oauthActive = true; prov.oauthIdentity = "you@example.com"; delete prov.relogin; }
            return void (await req.respond(json(real.data)));
          }
        } catch (e) {
          console.error(`  interception of ${p} failed: ${e?.message ?? e}`);
        }
        if (!req.isInterceptResolutionHandled?.()) await req.continue();
      });
      // The one-time personalization toast would sit over every shot.
      await page.evaluate(() => localStorage.setItem("lucid.personalNudged", "1"));
      await ctx.reload();
      const deadline = Date.now() + 90_000;
      for (;;) {
        if (await shown(page, "#provChoice .modal")) break;
        if (Date.now() > deadline) {
          const auth = (await (await ctx.api("/api/auth")).json())?.data;
          const configured = [...(auth?.gateway ?? []), ...(auth?.majors ?? []), ...(auth?.others ?? [])]
            .filter((x) => x.oauthActive || x.keySet || (x.fields ?? []).some((f) => f.set)).map((x) => x.id);
          const overlays = await page.evaluate(() => [...document.querySelectorAll(".modal-ov, .coach-card")].map((n) => n.id || n.className));
          await page.screenshot({ path: `${ctx.root}/connect-debug.png` });
          throw new Error(`the Connect an AI provider prompt never appeared (configured: ${configured.join(",") || "none"}; overlays: ${overlays.join(",") || "none"}; screenshot ${ctx.root}/connect-debug.png)`);
        }
        for (const sel of ["#roleGateSkip", "#emailGateSkip", '#govGate [data-gov="no"]']) {
          if (await shown(page, sel)) { await page.click(sel); await pause(500); }
        }
        await pause(300);
      }
      await clearToasts(page);
      await calm(page);
      await ctx.shoot("connect-first-run", {
        clip: "#provChoice .modal",
        boxes: { connect: '#provChoice [data-prov="yes"]', later: '#provChoice [data-prov="later"]' },
      });
    },
  },
  {
    id: "window",
    step: "Chooses I'll do it later, skips the tour, and photographs the window with the model pill and the Settings button.",
    async run(ctx) {
      const { page } = ctx;
      await page.click('#provChoice [data-prov="later"]');
      await visible(page, ".coach-card [data-coach-skip]");
      await pause(400); // the card's entry animation
      await page.click(".coach-card [data-coach-skip]");
      // Esc is the tour's other skip; use it if the click landed during a re-layout.
      for (const until = Date.now() + 10000; await page.$(".coach-card");) {
        if (Date.now() > until) throw new Error("the guided tour did not close");
        await page.keyboard.press("Escape");
        await pause(400);
      }
      // While the agent starts, a spin-up walker paces over the message box. Photograph the window after it leaves.
      // The status bar keeps saying "Loading models" while no provider is connected; that is the true state.
      await page.waitForFunction(() => !document.querySelector(".spw-host"), { timeout: 90000, polling: 500 })
        .catch(async () => {
          const status = await page.evaluate(() => ({ walker: !!document.querySelector(".spw-host"), text: (document.body.innerText.match(/(Loading models|Waiting for a stable network)[^\n]*/) ?? [""])[0] }));
          throw new Error(`the window never settled: ${JSON.stringify(status)}`);
        });
      await pause(800);
      await clearToasts(page);
      await calm(page);
      await ctx.shoot("connect-window", {
        boxes: { pill: "#modelBadge", settings: '.rail-btn[data-rail="settings"]' },
      });
    },
  },
  {
    id: "picker-new",
    step: "Opens the model picker with nothing connected and waits for the model check to finish, so the Login row and the empty list show.",
    async run(ctx) {
      const { page } = ctx;
      await page.click("#modelBadge");
      await visible(page, ".popover.show .cfg-login");
      // Opening the picker starts a model check (about 9 s with no provider); wait for its "No models yet".
      // Settled = "No models yet" with the updating spinner hidden, for 3 s in a row (a check can restart).
      await page.waitForFunction(() => {
        const ok = /No models yet/.test(document.querySelector("#cfgModelList")?.textContent ?? "") && !!document.querySelector("#cfgLoading")?.hidden;
        const w = window;
        if (!ok) { w.__docsSettledAt = 0; return false; }
        w.__docsSettledAt ||= Date.now();
        return Date.now() - w.__docsSettledAt > 3000;
      }, { timeout: 60000, polling: 250 })
        .catch(() => { throw new Error("the picker never settled on No models yet"); });
      if (await shown(page, ".popover.show .cfg-login-list[hidden]") || !(await shown(page, ".popover.show .cfg-login-list"))) await page.click(".popover.show [data-login-toggle]");
      await calm(page);
      await ctx.shoot("connect-picker-login", {
        clip: await unionRect(page, ["#modelBadge", ".popover.show"]),
        boxes: {
          pill: "#modelBadge",
          login: ".popover.show [data-login-toggle]",
          list: ".popover.show .cfg-login-list",
          empty: "#cfgModelList",
          add: "#cfgAddProv",
        },
      });
    },
  },
  {
    id: "hub",
    step: "Clicks Add or manage providers and photographs the top of the Provider Hub.",
    async run(ctx) {
      const { page } = ctx;
      await page.click("#cfgAddProv");
      await visible(page, '#provHub [data-hub-tile="anthropic"]');
      await pause(700);
      await calm(page);
      await ctx.shoot("connect-hub", {
        clip: "#provHub .modal",
        pad: 0,
        boxes: { title: "#provHubTitle", guide: '#provHub [data-guide="choosing"]', close: "#provHubClose" },
      });
    },
  },
  {
    id: "hub-claude",
    step: "Opens the Claude tile in the Provider Hub and photographs its Connect via OAuth button and its key box.",
    async run(ctx) {
      const { page } = ctx;
      await scrollTo(page, '#provHub [data-hub-tile="anthropic"]', "start");
      await page.click('#provHub [data-hub-tile="anthropic"]');
      const oauth = '#provHub [data-hub-item="anthropic"] [data-oauth="anthropic"]';
      await visible(page, oauth);
      await scrollTo(page, oauth);
      await pause(400);
      await calm(page);
      await ctx.shoot("connect-hub-claude", {
        clip: "#provHub .modal",
        pad: 0,
        boxes: {
          oauth,
          key: '#provHub [data-hub-item="anthropic"] .prov-grid .prov-key[data-env="ANTHROPIC_API_KEY"]',
        },
      });
    },
  },
  {
    id: "signin",
    step: "Closes the hub (its backdrop blurs notices), clicks Login next to Claude in the model picker (the request is answered in the browser, so no broker or browser opens), photographs the browser notice, then lets the demo sign-in land and photographs the result.",
    async run(ctx) {
      const { page } = ctx;
      await page.click("#provHubClose");
      await page.waitForFunction(() => !document.querySelector("#provHub"), { timeout: 5000 });
      await pause(400);
      await page.evaluate(() => { window.open = () => null; });
      await page.click("#modelBadge");
      await visible(page, ".popover.show [data-login-toggle]");
      await pause(300);
      const login = '.popover.show .cfg-login-row [data-login="anthropic"]';
      if (!(await shown(page, login))) await page.click(".popover.show [data-login-toggle]");
      await visible(page, login);
      await page.click(login);
      const t1 = await toast(page, "Finish signing in in your browser");
      await calm(page);
      await ctx.shoot("connect-signin-browser", {
        clip: t1,
        boxes: { open: `${t1} .acts .btn-mini.ok`, copy: `${t1} .acts .btn-mini:not(.ok)` },
      });
      signedIn = true;
      await clearToasts(page);
      const t2 = await toast(page, "Connected - models updated", 30000);
      await calm(page);
      await ctx.shoot("connect-signin-done", { clip: t2 });
      await clearToasts(page);
    },
  },
  {
    id: "api-key",
    step: "Opens the Provider Hub again, opens the ChatGPT tile, types an obviously fake key, photographs it, saves it, and photographs the connected tiles.",
    async run(ctx) {
      const { page } = ctx;
      await page.click("#modelBadge");
      await visible(page, "#cfgAddProv");
      await page.click("#cfgAddProv");
      await visible(page, '#provHub [data-hub-tile="openai"]');
      await pause(700);
      const tile = '#provHub [data-hub-tile="openai"]';
      await scrollTo(page, tile, "start");
      await page.click(tile);
      const key = '#provHub [data-hub-item="openai"] .prov-grid .prov-key[data-env="OPENAI_API_KEY"]';
      const save = '#provHub [data-hub-item="openai"] [data-savekey="OPENAI_API_KEY"]';
      await visible(page, key);
      await scrollTo(page, key);
      await page.type(key, DEMO_KEY);
      await pause(300);
      await calm(page);
      await ctx.shoot("connect-hub-key", { clip: "#provHub .modal", pad: 0, boxes: { key, save } });
      await page.click(save);
      await toast(page, "OPENAI_API_KEY saved");
      await clearToasts(page);
      await visible(page, '#provHub [data-hub-tile="openai"] .provhub-badge.ok');
      await scrollTo(page, '#provHub [data-hub-tile="openai"]');
      await pause(400);
      await ctx.shoot("connect-hub-connected", {
        clip: "#provHub .modal",
        pad: 0,
        boxes: {
          claude: '#provHub [data-hub-tile="anthropic"] .provhub-badge.ok',
          chatgpt: '#provHub [data-hub-tile="openai"] .provhub-badge.ok',
        },
      });
      await page.click("#provHubClose");
      await page.waitForFunction(() => !document.querySelector("#provHub"), { timeout: 5000 });
      await pause(400);
    },
  },
  {
    id: "choose-model",
    step: "Opens the model picker with Claude signed in, photographs the list, opens the Login row, picks Claude Sonnet 4.6, and photographs the pill.",
    async run(ctx) {
      const { page } = ctx;
      await page.click("#modelBadge");
      const row = '#cfgModelList [data-val="anthropic/claude-sonnet-4-6"]';
      await visible(page, row, 20000);
      await page.waitForFunction(() => document.querySelector("#cfgLoading")?.hidden !== false, { timeout: 20000 });
      await calm(page);
      await ctx.shoot("connect-picker-models", {
        clip: await unionRect(page, ["#modelBadge", ".popover.show"]),
        boxes: {
          pill: "#modelBadge",
          search: ".popover.show .cfg-search",
          current: "#cfgModelList .cfg-opt.on",
          row,
          login: ".popover.show [data-login-toggle]",
        },
      });
      if (!(await shown(page, ".popover.show .cfg-login-list"))) await page.click(".popover.show [data-login-toggle]");
      await visible(page, ".popover.show .cfg-login-list");
      await calm(page);
      await ctx.shoot("connect-picker-login-signed-in", {
        clip: ".popover.show .cfg-login",
        boxes: {
          toggle: ".popover.show [data-login-toggle]",
          signedin: ".popover.show .cfg-login-row .cfg-login-st",
          login: ".popover.show .cfg-login-row [data-login]",
        },
      });
      await page.type("#cfgModelSearch", "sonnet");
      await pause(300);
      await page.click(row);
      await page.waitForFunction(() => /Sonnet 4\.6/.test(document.querySelector("#modelName")?.textContent ?? ""), { timeout: 10000 })
        .catch(() => { throw new Error("the pill did not switch to Claude Sonnet 4.6"); });
      await pause(500);
      await clearToasts(page);
      await calm(page);
      await ctx.shoot("connect-model-chosen", {
        clip: await unionRect(page, [".titlebar .brand", "#modelBadge"], 10),
        boxes: { pill: "#modelBadge" },
      });
    },
  },
  {
    id: "settings-providers",
    step: "Opens Settings, Models & providers, expands Providers, and photographs the Provider Hub button and the note on where keys are kept.",
    async run(ctx) {
      const { page } = ctx;
      await page.click('.rail-btn[data-rail="settings"]');
      await visible(page, '#setNav [data-set-cat="models"]');
      await page.click('#setNav [data-set-cat="models"]');
      await visible(page, '#setBody [data-setcard="providers"]');
      if (!(await shown(page, "#openProvHub"))) await page.click('#setBody [data-setcard="providers"]');
      await visible(page, "#openProvHub");
      const tagged = await page.evaluate(() => {
        const n = [...document.querySelectorAll('#setBody [data-sec="providers"] .set-note')].find((x) => /OS vault|user-only file/.test(x.textContent ?? ""));
        if (n) n.setAttribute("data-docs", "vault-note");
        return !!n;
      });
      if (!tagged) throw new Error("the Providers card shows no note on where keys are kept");
      await scrollTo(page, '#setBody [data-sec="providers"]', "start");
      await pause(500);
      await calm(page);
      await ctx.shoot("connect-settings-providers", {
        clip: "#settings",
        pad: 0,
        boxes: {
          nav: '#setNav [data-set-cat="models"]',
          hub: "#openProvHub",
          vault: '[data-docs="vault-note"]',
          key: '#setBody [data-prov-acc="openai"] > summary .abadge.set',
          oauth: '#setBody [data-prov-acc="anthropic"] > summary .abadge.ok',
        },
      });
    },
  },
  {
    id: "quick-connect",
    step: "Opens Settings, Connectors, filters Quick connect to Email and calendar, photographs it, connects Fastmail and photographs the notice and the MCP connectors list.",
    async run(ctx) {
      const { page } = ctx;
      await page.click('#setNav [data-set-cat="connectors"]');
      await visible(page, '#setBody [data-mcpq-cat="email"]');
      await page.click('#setBody [data-mcpq-cat="email"]');
      const fast = '#setBody [data-mcpq-connect="fastmail"]';
      await visible(page, fast);
      await scrollTo(page, '#setBody [data-sec="mcpQuick"]', "start");
      await pause(500);
      await calm(page);
      await ctx.shoot("connect-quick-connect", {
        clip: "#settings",
        pad: 0,
        boxes: {
          nav: '#setNav [data-set-cat="connectors"]',
          chip: '#setBody [data-mcpq-cat="email"]',
          connect: '#setBody [data-mcpq-connect="gmail"]',
          docs: '#setBody .mcpq-tile:first-child .mcpq-docs',
        },
      });
      await scrollTo(page, fast);
      await page.click(fast);
      const t = await toast(page, "Fastmail added");
      await calm(page);
      await ctx.shoot("connect-quick-connect-added", { clip: t });
      await clearToasts(page);
      await visible(page, '#setBody [data-setcard="mcp"]');
      if (!(await shown(page, "#setBody [data-mcp-remove]"))) await page.click('#setBody [data-setcard="mcp"]');
      await visible(page, "#setBody [data-mcp-remove]");
      await scrollTo(page, '#setBody [data-sec="mcp"]', "start");
      await pause(500);
      await calm(page);
      await ctx.shoot("connect-mcp-connectors", {
        clip: "#settings",
        pad: 0,
        boxes: {
          server: '#setBody [data-sec="mcp"] .set-coll-body > .prov:first-child',
          toggle: "#setBody [data-mcp-toggle]",
          remove: "#setBody [data-mcp-remove]",
        },
      });
    },
  },
];
