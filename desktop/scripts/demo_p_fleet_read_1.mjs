// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_fleet_read_1.mjs
//
// P-FLEET.READ1 (ADR-0646): real-browser proof that a markdown table in a Fleet card is readable, and that the
// reply can be copied whole from the card. Before, the card's break-anywhere text let a short column shrink to
// one character ("Ti / me", "0:0 / 0"), and the only per-turn copy was an invisible hover button at the top of
// the turn that copied a plain-text log. A lane is asked to reply with a fixed three-column table (times,
// short sections, long prose). With real input, at the caller's window size, it proves:
//   1. the time column is marked compact and each of its cells (header too) sits on ONE line;
//   2. no word in any cell is split across lines, and no cell's text overflows its cell;
//   3. the reply's copy button is visible at rest and is the topmost element at its center, and after the
//      output is scrolled to the middle of the reply it is still in view and still on top (sticky);
//   4. clicking it puts the reply's markdown on the clipboard (the table itself, not a "[assistant]" log);
//   5. the reply passes the spacing audit (auditBoxes, ADR-0633).
// The caller owns the page (an engine with a signed-in lane), the window size and the Fleet dock being open.
//
// Run: LUCID_DEMO_CDP_URL=ws://... LUCID_DEMO_URL=http://127.0.0.1:<port>/ LUCID_DEMO_LANE=<lane id> node desktop/scripts/demo_p_fleet_read_1.mjs

import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

export const TABLE = [
  "| Time | Section | What happens |",
  "|---|---|---|",
  "| 0:00 | Office, Monday 9 A.M. | Close on the red stapler and the TPS reports, then a desk's sponsor coin, then all four agents start typing at once. |",
  "| 0:43 | The boss gets an order | Debate the meaning of life and what changes if we knew for certain that aliens are real, so six subagents appear around his desk. |",
  "| 1:25 | Fleet panel, center screen | All four agents' output side by side: the cover sheet guide, test cases, office party ideas and a memo about a stapler. |",
  "| 3:11 | Finale | Another live commit and bolt, then a wide shot, then a cut back to the stapler. |",
].join("\n");

export async function verifyFleetRead(page, laneId) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content);
  const api = (path, body) => page.evaluate(async (p, b, t) => (await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", "x-lucid-token": t }, body: b ? JSON.stringify(b) : undefined })).json(), path, body ?? null, token);
  const card = `#fleetDock .fleet-card[data-lane="${laneId}"]`;
  await page.waitForSelector(card, { visible: true, timeout: 10000 });

  // ask for the table and wait for the settled reply that holds it
  await api("/api/fleet/queue", { laneId, text: `Reply with exactly this markdown table and nothing else:\n\n${TABLE}` });
  // the newest settled reply with this table gets an id, so every step below addresses that one turn
  const mark = () => page.evaluate((c) => {
    const turns = [...document.querySelectorAll(`${c} [data-lane-turn][data-role="assistant"]`)].filter((t) => t.querySelector(".fleet-md table td.md-num") && t.textContent.includes("Fleet panel, center screen"));
    document.getElementById("demoReadTurn")?.removeAttribute("id");
    const t = turns[turns.length - 1];
    if (t) t.id = "demoReadTurn";
    return !!t;
  }, card);
  const end = Date.now() + 120_000;
  while (Date.now() < end && !(await mark())) await pause(700);
  assert(await page.$("#demoReadTurn"), "the lane's reply never rendered the table");
  const turnSel = "#demoReadTurn";

  // 1 + 2: compact column on one line, no split words, nothing overflows
  const layout = await page.evaluate((sel) => {
    const turn = document.querySelector(sel);
    const table = turn.querySelector(".fleet-md table");
    const lines = (node) => {
      const r = document.createRange(); r.selectNodeContents(node);
      return new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size;
    };
    const split = [];
    for (const cell of table.querySelectorAll("th, td")) {
      const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const re = /\S+/g; let m;
        while ((m = re.exec(n.data))) {
          const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
          const rows = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size;
          if (rows > 1) split.push(m[0]);
        }
      }
    }
    const numCells = [...table.querySelectorAll(".md-num")];
    return {
      numCols: [...table.querySelectorAll("thead th")].map((th) => th.classList.contains("md-num")),
      numLines: numCells.map(lines),
      numText: numCells.map((c) => c.textContent.trim()),
      split,
      overflow: [...table.querySelectorAll("th, td")].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.textContent.trim().slice(0, 20)),
      tableW: Math.round(table.getBoundingClientRect().width),
    };
  }, turnSel);
  assert(layout.numCols[0] === true && layout.numCols.slice(1).every((x) => !x), `only the Time column is compact, got ${JSON.stringify(layout.numCols)}`);
  assert(layout.numLines.every((n) => n === 1), `a time cell wraps: ${JSON.stringify(layout.numText)} -> ${JSON.stringify(layout.numLines)} lines`);
  assert(layout.split.length === 0, `words split across lines: ${layout.split.join(", ")}`);
  assert(layout.overflow.length === 0, `cells overflow: ${layout.overflow.join(", ")}`);

  // 3: the copy button is visible, on top, and stays in view down a long reply
  const btnSel = `${turnSel} .fleet-turn-copy`;
  const onTop = () => page.$eval(btnSel, (b) => {
    const r = b.getBoundingClientRect();
    const out = b.closest(".fleet-out").getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { hit: b.contains(at), inView: r.top >= out.top - 1 && r.bottom <= out.bottom + 1, opacity: Number(getComputedStyle(b).opacity) };
  });
  await page.$eval(`${card} .fleet-out`, (o) => { o.scrollTop = o.scrollHeight; });
  await page.mouse.move(2, 2); // not hovering: the resting look
  await pause(400);
  const atRest = await page.$eval(btnSel, (b) => Number(getComputedStyle(b).opacity));
  assert(atRest >= 0.5, `the reply's copy button is hidden at rest (opacity ${atRest})`);
  await page.$eval(turnSel, (t) => { const o = t.closest(".fleet-out"); o.scrollTop = t.offsetTop + Math.max(0, (t.offsetHeight - o.clientHeight) / 2); });
  await pause(300);
  const mid = await onTop();
  assert(mid.inView && mid.hit, `scrolled into the reply, the copy button is ${mid.inView ? "covered" : "out of view"}`);

  // 4: click it, the clipboard holds the table markdown
  const origin = new URL(page.url()).origin;
  await page.browserContext().overridePermissions(origin, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("before"));
  await page.click(btnSel);
  await pause(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert(!clip.startsWith("[assistant]"), "the copy wrote the plain-text log, not the reply");
  assert(/\|\s*Time\s*\|/.test(clip) && clip.includes("0:43") && clip.includes("| Finale |"), `the clipboard does not hold the table: ${clip.slice(0, 120)}`);

  // 5: spacing
  const spacing = await page.evaluate(auditBoxes, "#demoReadTurn", MIN_GAP);
  await page.evaluate(() => document.getElementById("demoReadTurn")?.removeAttribute("id"));
  assert(spacing.length === 0, `reply spacing: ${spacing.join("; ")}`);
  return { tableWidth: layout.tableW, timeCells: layout.numText, clipboardChars: clip.length };
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_fleet_read_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const url = process.env.LUCID_DEMO_URL;
  const laneId = process.env.LUCID_DEMO_LANE;
  if (!endpoint || !url || !laneId) throw new Error("Set LUCID_DEMO_CDP_URL, LUCID_DEMO_URL and LUCID_DEMO_LANE (a signed-in lane on that engine).");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    console.log(JSON.stringify(await verifyFleetRead(page, laneId), null, 2));
    console.log("P-FLEET.READ1 passed: the table's time column stays on one line, no word splits, and the reply's copy button stays in view and copies the table markdown.");
  } finally { await browser.disconnect(); }
}
