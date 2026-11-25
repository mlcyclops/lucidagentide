// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/docs_shots/get_started.mjs
//
// P-DOCS.1 (ADR-0660): the shots of the "Get started" section of docs.lucid-agents.com. Walks the real first-run
// sequence of a fresh QA engine (role picker, work email, Government CUI question, connect a provider, the guided
// tour, the personalization nudge), then the main window, Settings > Workspace & profile > Profile > Role, and About.
// Run through docs_capture_p_docs_1.mjs: bun desktop/scripts/docs_capture_p_docs_1.mjs get_started --port 7821

import { hostname, userInfo } from "node:os";

/** Wait for a selector to be laid out, then let its open animation settle. */
async function shown(ctx, sel, settle = 700) {
  await ctx.page.waitForSelector(sel, { visible: true, timeout: 20_000 });
  await ctx.pause(settle);
}
async function click(ctx, sel) {
  await ctx.page.waitForSelector(sel, { visible: true, timeout: 20_000 });
  await ctx.page.click(sel);
}
/** Park the pointer where it opens no tooltip. */
const park = (ctx) => ctx.page.mouse.move(720, 300);

export const steps = [
  {
    id: "scrub",
    step: "Replaces this machine's host and user name with demo values in every JSON answer of the engine, then reloads.",
    async run(ctx) {
      const real = [hostname(), userInfo().username].filter((s) => s && s.length > 2);
      await ctx.page.evaluateOnNewDocument((names) => {
        const orig = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const res = await orig(...args);
          if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;
          let text = await res.text();
          for (const n of names) text = text.split(n).join(n === names[0] ? "DEMO-PC" : "demo");
          return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
        };
      }, real);
      // The first load already marked the one-time personalization nudge as shown (possibly after this step
      // starts), so the reloaded document clears it before the app's scripts run.
      await ctx.page.evaluateOnNewDocument(() => {
        if (sessionStorage.getItem("docs-fresh")) return;
        localStorage.clear();
        sessionStorage.setItem("docs-fresh", "1");
      });
      await ctx.reload();
    },
  },
  {
    id: "get-started-first-launch-window",
    step: "Shoots the whole window on a fresh install: the role picker over the app.",
    async run(ctx) {
      await shown(ctx, "#roleGate .role-modal");
      await shown(ctx, "#toasts .toast.show", 800); // the personalization nudge pops 1.5 s after load
      await park(ctx);
      await ctx.shoot("get-started-first-launch-window", { boxes: { role: "#roleGate .role-modal", personalize: "#toasts .toast" } });
    },
  },
  {
    id: "get-started-role-picker",
    step: "Shoots the role picker with its five role cards and the Skip button.",
    async run(ctx) {
      await ctx.shoot("get-started-role-picker", {
        clip: "#roleGate .role-modal",
        boxes: {
          developer: '#roleGate [data-role="developer"]',
          security: '#roleGate [data-role="security"]',
          manager: '#roleGate [data-role="manager"]',
          executive: '#roleGate [data-role="executive"]',
          "lucid-agent": '#roleGate [data-role="lucid-agent"]',
          skip: "#roleGateSkip",
        },
      });
      await click(ctx, "#roleGateSkip");
    },
  },
  {
    id: "get-started-work-email",
    step: "Shoots the optional work email prompt, then skips it.",
    async run(ctx) {
      await shown(ctx, "#emailGate .modal");
      await ctx.shoot("get-started-work-email", {
        clip: "#emailGate .modal",
        boxes: { email: "#emailGateInput", skip: "#emailGateSkip", save: "#emailGateSave" },
      });
      await click(ctx, "#emailGateSkip");
    },
  },
  {
    id: "get-started-cui-question",
    step: "Shoots the Government CUI question, then answers No - standard use.",
    async run(ctx) {
      await shown(ctx, "#govGate .modal");
      await ctx.shoot("get-started-cui-question", {
        clip: "#govGate .modal",
        boxes: { yes: "#govGate [data-gov='yes']", no: "#govGate [data-gov='no']" },
      });
      await click(ctx, "#govGate [data-gov='no']");
    },
  },
  {
    id: "get-started-connect-provider",
    step: "Shoots the Connect an AI provider prompt (shown when no provider is set up), then chooses I'll do it later.",
    async run(ctx) {
      await shown(ctx, "#provChoice .modal");
      await ctx.shoot("get-started-connect-provider", {
        clip: "#provChoice .modal",
        boxes: { connect: "#provChoice [data-prov='yes']", later: "#provChoice [data-prov='later']" },
      });
      await click(ctx, "#provChoice [data-prov='later']");
    },
  },
  {
    id: "get-started-tour",
    step: "Shoots the first card of the guided tour over the whole window once the earlier notices have faded, then skips the tour.",
    async run(ctx) {
      await shown(ctx, ".coach-card.show", 900);
      // "Using workstation name" and "Standard mode" fade after 3.2 s; the tour card stays.
      await ctx.page.waitForFunction(() => document.querySelectorAll("#toasts .toast").length <= 1, { timeout: 15_000 });
      await ctx.pause(600);
      await park(ctx);
      await ctx.shoot("get-started-tour", {
        boxes: { card: ".coach-card", next: ".coach-card [data-coach-next]", skip: ".coach-card [data-coach-skip]" },
      });
      await click(ctx, ".coach-card [data-coach-skip]");
    },
  },
  {
    id: "get-started-personalize",
    step: "Shoots the Make LucidAgent yours card once the other notices have faded, then chooses Later.",
    async run(ctx) {
      await ctx.pause(3800); // "Tour skipped", "Standard mode" and "Using workstation name" time out
      const found = await ctx.page.evaluate(() => {
        const t = [...document.querySelectorAll("#toasts .toast")].find((n) => n.textContent?.includes("Make LucidAgent yours"));
        if (t) t.setAttribute("data-docs", "personalize");
        return !!t;
      });
      if (!found) throw new Error('the "Make LucidAgent yours" card is not showing');
      await park(ctx);
      await ctx.shoot("get-started-personalize", {
        clip: '[data-docs="personalize"]',
        boxes: {
          setup: '[data-docs="personalize"] .acts .btn-mini.ok',
          later: '[data-docs="personalize"] .acts .btn-mini:not(.ok)',
        },
      });
      await click(ctx, '[data-docs="personalize"] .acts .btn-mini:not(.ok)');
      await ctx.pause(800);
    },
  },
  {
    id: "get-started-main-window",
    step: "Shoots the whole main window after the first-run prompts, with its parts named.",
    async run(ctx) {
      // With no AI provider connected yet the model list never lands, so the status bar keeps "Loading models".
      await park(ctx);
      await ctx.pause(600);
      await ctx.shoot("get-started-main-window", {
        boxes: {
          rail: "nav.rail",
          sidebar: "#sidebar",
          newSession: "#newSession",
          model: "#modelBadge",
          composer: ".composer-row",
          inspector: "#inspector",
          status: "#statusbar",
          settings: '.rail-btn[data-rail="settings"]',
          about: "#railAbout",
        },
      });
    },
  },
  {
    id: "get-started-change-role",
    step: "Opens Settings > Workspace & profile, expands Profile and shoots the Role row.",
    async run(ctx) {
      await click(ctx, '.rail-btn[data-rail="settings"]');
      await shown(ctx, "#settings");
      await click(ctx, '#setNav [data-set-cat="workspace"]');
      await ctx.page.waitForSelector('#setBody [data-sec="profile"] .set-coll-h', { visible: true, timeout: 20_000 });
      const open = await ctx.page.$eval('#setBody [data-sec="profile"]', (n) => n.classList.contains("open"));
      if (!open) await ctx.page.click('#setBody [data-sec="profile"] .set-coll-h');
      await shown(ctx, '#setBody [data-sec="profile"] .role-seg-row', 900);
      await ctx.page.$eval('#setBody [data-sec="profile"]', (n) => n.scrollIntoView({ block: "start" }));
      await park(ctx);
      await ctx.pause(500);
      await ctx.shoot("get-started-change-role", {
        clip: "#settings",
        pad: 0,
        boxes: {
          category: '#setNav [data-set-cat="workspace"]',
          profile: '#setBody [data-sec="profile"] .set-coll-h',
          roles: '#setBody [data-sec="profile"] .role-seg-row',
          stage: '#setBody [data-sec="profile"] .role-seg-hero',
          tour: "#replayTour",
        },
      });
      await click(ctx, "#setClose");
      await ctx.pause(500);
    },
  },
  {
    id: "get-started-about",
    step: "Opens About from the left rail and shoots the version.",
    async run(ctx) {
      await click(ctx, "#railAbout");
      await shown(ctx, "#aboutModal .about-modal", 1200);
      await park(ctx);
      await ctx.shoot("get-started-about", {
        clip: "#aboutModal .about-modal",
        boxes: { version: "#aboutModal .about-ver", tour: "#aboutModal [data-about-tour]" },
      });
      await click(ctx, "#aboutModal .about-actions [data-about-close]");
    },
  },
];
