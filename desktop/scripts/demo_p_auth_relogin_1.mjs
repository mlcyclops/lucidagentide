// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_auth_relogin_1.mjs
//
// P-AUTH.RELOGIN1 (ADR-0640): real-browser proof of the re-login notice and the picker's Login row. Run it against
// an isolated QA engine whose vault holds a Claude OAuth row omp DISABLED after a failed refresh, whose settings
// say the user was on Claude Opus 5.5, and whose last-run marker names an older version (seed: see ADR-0640).
// With real mouse input and document.elementFromPoint (what the user can see and click), it proves:
//   1. a callout opens under the model pill, inside the window, naming Claude, the update and Opus 5.5, and its
//      "Log in" button is the topmost element at its center; the pill's dot is amber;
//   2. hovering "Log in" shows the premium tooltip that explains OAuth;
//   3. Escape (the "Not now" path) closes the callout for the launch, focus returns to the pill, the pill stays amber;
//   4. the model picker shows the Login row directly under the model name, before the search box: an amber
//      "Log in to Claude again" and a "Login" toggle that opens the provider list, all topmost, and the row
//      passes auditBoxes (no touching boxes);
//   5. clicking "Log in to Claude again" starts the anthropic sign-in (the POST is intercepted, so no broker or
//      browser runs) and closes the picker.
// The caller owns the engine, the browser and the window size; run it once narrow and once wide.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/ node desktop/scripts/demo_p_auth_relogin_1.mjs

import { auditBoxes } from "./demo_p_spacing_1.mjs";

export async function verifyRelogin(page) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const topmost = (sel) => page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n) return `${s}: missing`;
    const b = n.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return `${s}: not laid out`;
    if (b.left < 0 || b.top < 0 || b.right > innerWidth || b.bottom > innerHeight) return `${s}: outside the window ${JSON.stringify(b)}`;
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return n.contains(hit) ? null : `${s}: covered by ${hit ? `${hit.tagName}.${hit.className}` : "nothing"}`;
  }, sel);
  const result = { viewport: await page.evaluate(() => `${innerWidth}x${innerHeight}`) };

  // 1. the callout under the model pill
  await page.waitForSelector(".relogin-notice", { visible: true, timeout: 20000 })
    .catch(() => { throw new Error("no re-login notice appeared under the model pill"); });
  await pause(300); // entry animation
  const notice = await page.evaluate(() => {
    const n = document.querySelector(".relogin-notice");
    const badge = document.querySelector("#modelBadge").getBoundingClientRect();
    const r = n.getBoundingClientRect();
    return { title: n.querySelector("#reloginTitle")?.textContent, body: n.querySelector(".relogin-b")?.textContent, top: r.top, left: r.left, right: r.right, badgeBottom: badge.bottom, badgeLeft: badge.left, badgeRight: badge.right, amber: document.querySelector("#modelBadge").classList.contains("needs-login") };
  });
  assert(notice.title === "Log in to Claude again", `notice title: ${notice.title}`);
  assert(/ended your saved sign-in/.test(notice.body) && /LUCID was on 2\.5\.4-beta\.7/.test(notice.body) && /get back to Claude Opus 5\.5/.test(notice.body), `notice body: ${notice.body}`);
  assert(notice.top > notice.badgeBottom && notice.top - notice.badgeBottom < 24, `notice is not just under the pill (${notice.top} vs ${notice.badgeBottom})`);
  assert(notice.left < notice.badgeRight && notice.right > notice.badgeLeft, "notice is not beside the pill");
  assert(notice.amber, "the model pill dot is not amber");
  for (const sel of [".relogin-notice [data-relogin]", ".relogin-notice .relogin-acts [data-relogin-later]"]) {
    const bad = await topmost(sel); assert(!bad, bad);
  }
  result.notice = notice.title;

  // 2. the OAuth explainer on hover
  await page.hover(".relogin-notice [data-relogin]");
  await page.waitForFunction(() => /OAuth/.test(document.querySelector("#tip")?.textContent ?? "") && getComputedStyle(document.querySelector("#tip")).opacity !== "0", { timeout: 4000 })
    .catch(() => { throw new Error("hovering Log in did not show the OAuth tooltip"); });
  result.tip = await page.evaluate(() => document.querySelector("#tip").textContent.slice(0, 60));

  // 3. Esc (same path as Not now) closes it for the launch and hands focus back to the model pill
  await page.focus(".relogin-notice [data-relogin]");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".relogin-notice"), { timeout: 3000 })
    .catch(() => { throw new Error("Escape did not close the notice"); });
  assert(await page.evaluate(() => document.activeElement?.id === "modelBadge"), "focus did not return to the model pill");
  assert(await page.evaluate(() => document.querySelector("#modelBadge").classList.contains("needs-login")), "the pill lost its amber dot after Not now");

  // 4. the picker's Login row
  await page.click("#modelBadge");
  await page.waitForSelector(".popover.show .cfg-login", { visible: true, timeout: 4000 });
  await pause(250);
  const order = await page.evaluate(() => {
    const pop = document.querySelector(".popover.show");
    const lbl = pop.querySelector(".cfg-lbl").getBoundingClientRect();
    const row = pop.querySelector(".cfg-login").getBoundingClientRect();
    const search = pop.querySelector(".cfg-search").getBoundingClientRect();
    return { lbl: lbl.bottom, rowTop: row.top, rowBottom: row.bottom, search: search.top, lost: pop.querySelector(".cfg-login-btn.warn")?.textContent.trim() };
  });
  assert(order.rowTop >= order.lbl && order.rowBottom <= order.search, `Login row is not between the model name and the search box ${JSON.stringify(order)}`);
  assert(order.lost === "Log in to Claude again", `lost sign-in button: ${order.lost}`);
  for (const sel of [".popover.show .cfg-login-btn.warn", ".popover.show [data-login-toggle]"]) {
    const bad = await topmost(sel); assert(!bad, bad);
  }
  await page.click(".popover.show [data-login-toggle]");
  await page.waitForSelector(".popover.show .cfg-login-list:not([hidden])", { visible: true, timeout: 2000 });
  const rows = await page.evaluate(() => [...document.querySelectorAll(".popover.show .cfg-login-row")].map((r) => `${r.querySelector(".nm").textContent}:${r.querySelector("button")?.textContent.trim() ?? r.querySelector(".cfg-login-st")?.textContent.trim()}`));
  assert(rows[0] === "Claude:Log in again", `provider list does not lead with Claude: ${rows.join(", ")}`);
  const covered = (await Promise.all([1, 2, 3].map((i) => topmost(`.popover.show .cfg-login-row:nth-child(${i}) button`)))).filter(Boolean);
  assert(covered.length === 0, covered.join("; "));
  const boxes = await page.evaluate(auditBoxes, ".popover.show .cfg-login", 4);
  assert(boxes.length === 0, `Login row spacing: ${boxes.join("; ")}`);
  result.rows = rows;

  // 5. the Login click starts the anthropic sign-in
  let posted = null;
  await page.setRequestInterception(true);
  const onReq = (req) => {
    if (req.url().includes("/api/auth/oauth") && req.method() === "POST") {
      posted = JSON.parse(req.postData() ?? "{}");
      void req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { started: true, url: "", output: "intercepted by the demo" } }) });
    } else void req.continue();
  };
  page.on("request", onReq);
  try {
    await page.click(".popover.show .cfg-login-btn.warn");
    await page.waitForFunction(() => !document.querySelector(".popover.show"), { timeout: 3000 })
      .catch(() => { throw new Error("the picker stayed open after Login"); });
    for (let i = 0; i < 30 && !posted; i++) await pause(100);
    assert(posted?.oauthId === "anthropic", `Login did not start the anthropic sign-in (posted ${JSON.stringify(posted)})`);
  } finally {
    page.off("request", onReq);
    await page.setRequestInterception(false);
  }
  result.login = posted.oauthId;
  return result;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_auth_relogin_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyRelogin(page), null, 2));
    console.log("P-AUTH.RELOGIN1 passed: the re-login callout sits under the model pill, explains OAuth, and the picker leads with Login under the model name.");
  } finally { await browser.disconnect(); }
}
