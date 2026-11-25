// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_docs_2.mjs
//
// P-DOCS.2 (ADR-0681): docs.lucid-agents.com is linked from About and from onboarding. Against an isolated QA engine:
//   1. opens About with the real rail button and asserts the Documentation link is visible, points at the docs root,
//      opens safely (target=_blank, rel=noopener noreferrer) and that elementFromPoint at its center hits it;
//   2. replays the tour with About's real "Take the tour" button, steps Next to the closer card and asserts its
//      Get started link the same way (and that the card stays open: the link is not a tour control);
//   3. shows the onboarding Connect a provider modal (window.__lucidShowProviderPrompt, the same builder the
//      first-run chain calls; the QA engine already has a provider, so the real gate would skip it) and asserts the
//      How to connect your AI link, then closes it with its real "I'll do it later" button;
//   4. runs auditBoxes on About, the closer card and the provider modal.
//
// Run (QA engine: bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7821, and a Chrome with a CDP port):
//   LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7821/ node desktop/scripts/demo_p_docs_2.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const DOCS = "https://docs.lucid-agents.com/";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

/** Visible, safe, hit-testable external anchor: returns its href + label. */
async function checkLink(page, sel, href) {
  await page.waitForSelector(sel, { visible: true, timeout: 15000 });
  const r = await page.$eval(sel, (a) => {
    const b = a.getBoundingClientRect();
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const hit = document.elementFromPoint(x, y);
    const s = getComputedStyle(a);
    return {
      href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"),
      text: a.textContent?.trim() ?? "", w: b.width, h: b.height, hits: !!hit && (hit === a || a.contains(hit)),
      hitName: hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join(".")}` : "none",
      nowrap: s.whiteSpace === "nowrap" || a.scrollWidth <= a.clientWidth + 1,
    };
  });
  assert(r.href === href, `${sel} href is ${r.href}, want ${href}`);
  assert(r.target === "_blank" && r.rel === "noopener noreferrer", `${sel} must open safely (target=${r.target}, rel=${r.rel})`);
  assert(r.w > 8 && r.h > 8, `${sel} is not visible (${r.w}x${r.h})`);
  assert(r.nowrap, `${sel} label wraps`);
  assert(r.hits, `elementFromPoint at the center of ${sel} hits ${r.hitName}, not the link`);
  return { sel, href: r.href, text: r.text };
}

async function audit(page, root) {
  const bad = await page.evaluate(auditBoxes, root, MIN_GAP);
  assert(bad.length === 0, `spacing on ${root}: ${bad.join(" | ")}`);
  return root;
}

async function clickCenter(page, sel) {
  const c = await page.$eval(sel, (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(c.x, c.y);
}

export async function verifyDocsLinks(page, base) {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#railAbout", { visible: true, timeout: 30000 });
  // Clear any first-run onboarding step the QA profile still shows, with its own skip controls.
  for (let i = 0; i < 10; i++) {
    const skip = await page.$("#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]");
    if (!skip) { await pause(500); continue; }
    await skip.click().catch(() => {});
    await pause(400);
  }
  for (const t of await page.$$("#toasts .toast .h button")) await t.click().catch(() => {});
  const links = [];
  const audited = [];

  // 1. About
  await clickCenter(page, "#railAbout");
  links.push(await checkLink(page, "#aboutModal a.about-docs", DOCS));
  audited.push(await audit(page, "#aboutModal .about-modal"));

  // 2. Tour closer (replayed from About)
  await clickCenter(page, "#aboutModal [data-about-tour]");
  await page.waitForSelector(".coach-card.show", { visible: true, timeout: 10000 });
  for (let i = 0; i < 12 && !(await page.$(".coach-card .coach-link")); i++) {
    await clickCenter(page, ".coach-card [data-coach-next]");
    await pause(350);
  }
  links.push(await checkLink(page, ".coach-card a.coach-link", `${DOCS}get-started/`));
  audited.push(await audit(page, ".coach-card"));
  await clickCenter(page, ".coach-card [data-coach-next]"); // Done
  await pause(300);
  assert(!(await page.$(".coach-card")), "the tour did not close on Done");

  // 3. Connect a provider modal
  await page.evaluate(() => window.__lucidShowProviderPrompt?.());
  links.push(await checkLink(page, "#provChoice a.modal-docs", `${DOCS}connect/`));
  audited.push(await audit(page, "#provChoice .modal"));
  await clickCenter(page, "#provChoice [data-prov=later]");
  await pause(200);
  assert(!(await page.$("#provChoice")), "the provider modal did not close on I'll do it later");
  return { links, audited };
}

async function main() {
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const wsEndpoint = process.env.LUCID_DEMO_CDP_URL;
  const base = process.env.LUCID_DEMO_URL;
  if ((!browserURL && !wsEndpoint) || !base) {
    console.log("demo_p_docs_2: set LUCID_DEMO_BROWSER_URL (or LUCID_DEMO_CDP_URL) and LUCID_DEMO_URL to an isolated QA engine.");
    return;
  }
  assert(new URL(base).hostname === "127.0.0.1", "LUCID_DEMO_URL must be an isolated QA engine on 127.0.0.1");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(wsEndpoint ? { browserWSEndpoint: wsEndpoint } : { browserURL }), defaultViewport: null });
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.setViewport({ width: 1400, height: 900 });
    const r = await verifyDocsLinks(page, base);
    console.log(JSON.stringify(r, null, 2));
    console.log("P-DOCS.2 passed: About, the tour closer and the Connect a provider modal link docs.lucid-agents.com, hit-testable and spaced.");
  } finally {
    browser.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("demo_p_docs_2.mjs")) {
  main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
}
