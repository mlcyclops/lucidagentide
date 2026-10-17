// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-MARKET.1c: real browser QA on an already-running, isolated engine and browser.
// The caller owns the page, first-run setup, engine, and browser lifecycle.
export async function verifyCatalogTitles(page) {
  const results = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  async function open(command, modal) {
    await page.keyboard.down("Control");
    try { await page.keyboard.press("k"); } finally { await page.keyboard.up("Control"); }
    const input = await page.waitForSelector('.palette input[name="command-search"]', { visible: true });
    await input.click({ clickCount: 3 });
    await input.type(command);
    await page.keyboard.press("Enter");
    await page.waitForSelector(modal, { visible: true });
  }
  async function inspect(modal) {
    return page.$eval(modal, root => {
      const rows = [...root.querySelectorAll(".mkt-row")].map(row => {
        const name = row.querySelector(".mkt-name");
        const title = row.querySelector(".mkt-title");
        const badges = row.querySelector(".mkt-badges");
        if (!title || !badges) throw new Error("Catalog row lacks its title or badge group");
        const range = document.createRange();
        range.selectNodeContents(title);
        const style = getComputedStyle(title);
        return {
          name: title.textContent, tooltip: title.title,
          lines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size,
          nowrap: style.whiteSpace === "nowrap", clipped: style.overflowX === "hidden",
          ellipsis: style.textOverflow === "ellipsis", width: title.clientWidth,
          available: name.clientWidth, truncated: title.scrollWidth > title.clientWidth,
          badgesBelow: badges.getBoundingClientRect().top >= title.getBoundingClientRect().bottom,
          bareText: [...name.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()),
        };
      });
      const list = root.querySelector(".mkt-list");
      return { rows, horizontalOverflow: list.scrollWidth > list.clientWidth + 1 };
    });
  }
  const original = page.viewport();
  try {
    for (const width of [1280, 375]) {
      await page.setViewport({ width, height: 720 });
      for (const [command, modal, search, query] of [
        ["Browse Role KG Packs", "#kgpackModal", "#kgpackSearch", "Senior Proposal Manager"],
        ["Open Plugin Marketplace", "#mktModal", "#mktSearch", "Zotero"],
      ]) {
        await open(command, modal);
        const snapshot = await inspect(modal);
        assert(snapshot.rows.length > 0, `${command}: catalog is empty`);
        assert(!snapshot.horizontalOverflow, `${command}: list overflows horizontally at ${width}px`);
        for (const row of snapshot.rows) {
          assert(row.lines === 1 && row.nowrap && row.clipped && row.ellipsis, `${row.name}: title is not one ellipsized line`);
          assert(row.tooltip === row.name, `${row.name}: full title tooltip is missing`);
          assert(Math.abs(row.width - row.available) <= 1 && row.width > 100, `${row.name}: title does not take the available row width`);
          assert(row.badgesBelow && !row.bareText, `${row.name}: badges compete with primary text`);
        }
        const input = await page.$(search);
        await input.type(query);
        await page.waitForFunction((selector, text) => {
          const titles = [...document.querySelectorAll(`${selector} .mkt-title`)];
          return titles.length === 1 && titles[0].textContent.includes(text);
        }, {}, modal, query);
        const filtered = await inspect(modal);
        assert(filtered.rows[0].lines === 1 && filtered.rows[0].tooltip === filtered.rows[0].name, "Filtered title lost its layout or tooltip");
        results.push({ command, width, rows: snapshot.rows.length, truncated: snapshot.rows.filter(row => row.truncated).map(row => row.name) });
        await page.keyboard.press("Escape");
      }
    }
    return results;
  } finally {
    await page.keyboard.up("Control");
    await page.keyboard.press("Escape");
    if (original) await page.setViewport(original);
  }
}

if (import.meta.main) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) throw new Error("Set LUCID_DEMO_CDP_URL and LUCID_DEMO_URL to an already-running isolated QA browser and engine.");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  try {
    const page = (await browser.pages()).find(page => page.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyCatalogTitles(page), null, 2));
    console.log("P-MARKET.1c passed: live pack and plugin titles stay on one line, badges wrap below, full tooltips and search survive.");
  } finally { await browser.disconnect(); }
}
