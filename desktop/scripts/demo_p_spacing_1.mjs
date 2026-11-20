// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_spacing_1.mjs
//
// P-SPACING.1 (ADR-0633): real-browser spacing audit. Unit tests cannot see layout, so this measures what the
// user sees in a running LUCID window. `auditBoxes(root)` runs IN THE PAGE and returns every violation of:
//   touch  two boxed controls (inputs, selects, buttons, bordered cards and notes) that are not nested in each
//          other sit closer than MIN_GAP px (or overlap) while lined up on the other axis;
//   width  text fields stacked one under the other on the same left edge differ in width;
//   rhythm sibling cards in one view are spaced unevenly, or their collapsed headers differ in height.
// A container marked `data-joined` (a segmented control, a split button) is exempt from `touch` inside it.
// `verifySettingsSpacing(page)` opens Settings, visits every category, opens every card one at a time and
// audits each state. Any UI surface can reuse `auditBoxes` with its own driver.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/ node desktop/scripts/demo_p_spacing_1.mjs
// against a QA instance or a second instance, never a user's working session.

export const MIN_GAP = 6;

/** Runs in the page (serialized by page.evaluate): every spacing violation under `rootSel`. */
export function auditBoxes(rootSel, minGap) {
  const root = document.querySelector(rootSel);
  if (!root) return [`no element matches ${rootSel}`];
  const rootBox = root.getBoundingClientRect();
  const out = [];
  // The part of `e` the user can see: its rect clipped by every scrolling or clipping ancestor up to the root.
  const seen = (e) => {
    const r = e.getBoundingClientRect();
    let top = r.top, bottom = r.bottom, left = r.left, right = r.right;
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const c = a.getBoundingClientRect();
      top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); left = Math.max(left, c.left); right = Math.min(right, c.right);
      if (a === root) break;
    }
    return { top, bottom, left, right, width: right - left, height: bottom - top };
  };
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const shut = e.parentElement?.closest("details:not([open])");
    if (shut && !e.closest("summary")?.parentElement?.isSameNode(shut)) return false; // a closed <details> still lays out its content
    const v = seen(e);
    if (v.width < r.width - 1 || v.height < r.height - 1) return false; // partly scrolled or clipped away: audited when in view
    if (r.bottom <= rootBox.top || r.top >= rootBox.bottom) return false;
    for (let a = e; a && a !== root; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.visibility === "hidden" || Number(s.opacity) < 0.05 || s.display === "none") return false;
    }
    return true;
  };
  const name = (e) => {
    const id = e.id ? `#${e.id}` : "";
    const cls = [...e.classList].slice(0, 2).map((c) => `.${c}`).join("");
    const text = (e.getAttribute("placeholder") || e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24);
    return `${e.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ""}`;
  };
  const boxed = (e) => {
    if (e.matches("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=hidden]), select, textarea")) return true;
    const s = getComputedStyle(e);
    const clear = (c) => /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(c);
    const side = (w, st, c) => parseFloat(w) > 0 && st !== "none" && !clear(c);
    const borders = [side(s.borderTopWidth, s.borderTopStyle, s.borderTopColor), side(s.borderBottomWidth, s.borderBottomStyle, s.borderBottomColor),
      side(s.borderLeftWidth, s.borderLeftStyle, s.borderLeftColor), side(s.borderRightWidth, s.borderRightStyle, s.borderRightColor)];
    // a full outline (not a divider line); a button also counts when it is a filled pill
    return borders.every(Boolean) || (e.tagName === "BUTTON" && !clear(s.backgroundColor));
  };
  const boxes = [...root.querySelectorAll("*")].filter((e) => visible(e) && boxed(e) && !e.closest("[data-joined]")
    && !(e.tagName === "BUTTON" && e.parentElement?.closest("button"))); // a button's own parts
  // touch: compare each pair once; nested boxes and a box's own label pieces are not pairs
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i], ra = a.getBoundingClientRect();
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      if (a.contains(b) || b.contains(a)) continue;
      const rb = b.getBoundingClientRect();
      const overlapX = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (overlapX > 2 && overlapY > 2) {
        out.push(`touch: ${name(a)} overlaps ${name(b)}`);
      } else if (overlapX > 2) {
        const gap = Math.max(rb.top - ra.bottom, ra.top - rb.bottom);
        if (gap < minGap - 0.5) out.push(`touch: ${name(a)} and ${name(b)} are ${Math.round(gap)}px apart vertically (min ${minGap})`);
      } else if (overlapY > 2) {
        const gap = Math.max(rb.left - ra.right, ra.left - rb.right);
        if (gap < minGap - 0.5) out.push(`touch: ${name(a)} and ${name(b)} are ${Math.round(gap)}px apart horizontally (min ${minGap})`);
      }
    }
  }
  // width: text fields stacked on one left edge, within 64px of each other vertically, share a width
  const fields = boxes.filter((e) => e.matches("input, textarea")).map((e) => ({ e, r: e.getBoundingClientRect() })).sort((p, q) => p.r.top - q.r.top);
  for (let i = 1; i < fields.length; i++) {
    const p = fields[i - 1], q = fields[i];
    if (Math.abs(p.r.left - q.r.left) <= 2 && q.r.top - p.r.bottom < 64 && Math.abs(p.r.width - q.r.width) > 2) {
      out.push(`width: ${name(p.e)} is ${Math.round(p.r.width)}px wide but ${name(q.e)} under it is ${Math.round(q.r.width)}px`);
    }
  }
  // rhythm: sibling cards (the direct card children of one container) are evenly spaced, and collapsed
  // headers share a height
  const cardSel = ".set-coll, .set-sec, .set-tile";
  const parents = new Set([...root.querySelectorAll(cardSel)].filter(visible).map((c) => c.parentElement));
  for (const parent of parents) {
    const cards = [...parent.children].filter((c) => c.matches(cardSel) && visible(c) && boxed(c));
    const rows = cards.map((c) => c.getBoundingClientRect()).sort((p, q) => p.top - q.top);
    const gaps = [];
    for (let i = 1; i < rows.length; i++) if (rows[i].top >= rows[i - 1].bottom - 1) gaps.push(Math.round(rows[i].top - rows[i - 1].bottom));
    if (gaps.length && Math.max(...gaps) - Math.min(...gaps) > 1) out.push(`rhythm: cards in ${name(parent)} are ${gaps.join("/")}px apart, not one even gap`);
    const heads = cards.filter((c) => c.matches(".set-coll:not(.open)")).map((c) => Math.round(c.querySelector(":scope > .set-coll-h")?.getBoundingClientRect().height ?? 0));
    if (heads.length > 1 && Math.max(...heads) - Math.min(...heads) > 1) out.push(`rhythm: collapsed card headers in ${name(parent)} are ${heads.join("/")}px tall, not one height`);
  }
  return out;
}

export async function verifySettingsSpacing(page) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const wasOpen = await page.evaluate(() => document.body.classList.contains("set-open"));
  if (!wasOpen) await page.click('.rail-btn[data-rail="settings"]');
  await page.waitForSelector("#settings .set-nav-it", { visible: true, timeout: 5000 });
  const cats = await page.$$eval("#settings .set-nav-it[data-set-cat]", (bs) => bs.map((b) => b.dataset.setCat));
  const problems = [];
  const states = [];
  let layout = "";
  const audit = async (where) => {
    const found = await page.evaluate(auditBoxes, "#settings .set-body", MIN_GAP);
    states.push(`${layout} ${where}`);
    for (const f of found) problems.push(`${layout} ${where}: ${f}`);
  };
  // Both Settings layouts: the full window and the narrower side panel lay the same cards out differently.
  const startLayout = await page.$eval("#settings", (s) => s.dataset.layout);
  for (const want of ["window", "panel"]) {
    if (await page.$eval("#settings", (s) => s.dataset.layout) !== want) { await page.click("#setLayoutBtn"); await pause(450); }
    layout = want;
    for (const cat of cats) {
      await page.click(`#settings .set-nav-it[data-set-cat="${cat}"]`);
      await pause(450);
      // collapse every card, audit the collapsed list, then open each card alone and audit it
      await page.$$eval("#settings .set-body .set-coll.open > .set-coll-h", (hs) => hs.forEach((h) => h.click()));
      await pause(250);
      await audit(`${cat} (all collapsed)`);
      const keys = await page.$$eval("#settings .set-body .set-coll[data-sec]", (cs) => cs.filter((c) => c.getClientRects().length > 0).map((c) => c.dataset.sec));
      for (const key of keys) {
        await page.$eval(`#settings .set-body .set-coll[data-sec="${key}"] > .set-coll-h`, (h) => { h.scrollIntoView({ block: "start" }); h.click(); });
        await pause(450); // the card hydrates and animates open
        // its disclosures (<details>) open too, so their content is audited; they close again afterwards
        await page.$eval(`#settings .set-body .set-coll[data-sec="${key}"]`, (c) => c.querySelectorAll("details:not([open])").forEach((d) => { d.open = true; d.dataset.spacingOpened = "1"; }));
        await pause(150);
        // audit the open card a viewport at a time so tall cards are fully covered
        const steps = await page.$eval(`#settings .set-body .set-coll[data-sec="${key}"]`, (c) => Math.max(1, Math.ceil(c.getBoundingClientRect().height / (document.querySelector("#settings .set-body").clientHeight * 0.8))));
        for (let s = 0; s < steps; s++) {
          await page.$eval("#settings .set-body", (b, s, key) => {
            const c = b.querySelector(`.set-coll[data-sec="${key}"]`);
            if (c) b.scrollTop += c.getBoundingClientRect().top - b.getBoundingClientRect().top + s * b.clientHeight * 0.8 - 8;
          }, s, key);
          await pause(120);
          await audit(`${cat} / ${key}${steps > 1 ? ` part ${s + 1}` : ""}`);
        }
        await page.$eval(`#settings .set-body .set-coll[data-sec="${key}"]`, (c) => c.querySelectorAll("details[data-spacing-opened]").forEach((d) => { d.open = false; delete d.dataset.spacingOpened; }));
        await page.$eval(`#settings .set-body .set-coll[data-sec="${key}"] > .set-coll-h`, (h) => { if (h.parentElement.classList.contains("open")) h.click(); });
        await pause(200);
      }
    }
  }
  if (await page.$eval("#settings", (s) => s.dataset.layout) !== startLayout) await page.click("#setLayoutBtn");
  if (!wasOpen) await page.keyboard.press("Escape");
  return { states: states.length, problems: [...new Set(problems)] };
}

if (process.argv[1]?.endsWith("demo_p_spacing_1.mjs")) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    const r = await verifySettingsSpacing(page);
    for (const p of r.problems) console.log(`  x ${p}`);
    if (r.problems.length) { console.error(`P-SPACING.1 FAILED: ${r.problems.length} spacing problems across ${r.states} Settings states.`); process.exitCode = 1; }
    else console.log(`P-SPACING.1 passed: ${r.states} Settings states, no touching boxes, stacked fields share a width, cards evenly spaced with one header height.`);
  } finally { await browser.disconnect(); }
}
