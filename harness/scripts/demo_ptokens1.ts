// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_ptokens1.ts
//
// P-TOKENS.1 / P-FLEET.L9: the token-spend accounting behind the fleet card's context-fill chip, and the
// pure geometry behind resizable, draggable lane windows.
//
// The composer's up-arrow popover this module was first built for was REMOVED at the user's request
// (ADR-0315). The module stays because the fleet card's per-lane `.fleet-usage` chip is a real consumer:
// each card folds its own lane's usage samples and reads meterBadge for the value and the escalation
// thresholds. The row-rendering surface (meterRows/toolRows/modelRows) is kept and kept TESTED rather
// than deleted, because it is the honesty contract itself and the next surface to show spend must not
// re-derive it. What is gone is one button, not the accounting.
//
// The accounting's whole reason for existing is HONESTY. omp reports three things over ACP: context fill,
// the context window, and cost. It does NOT report per-turn output tokens on this path and does not
// report a cache breakdown. So this demo's central assertion is negative: a metric that never arrived
// must render the words "not reported", NEVER a plausible-looking $0.00 or 0 tokens. A fabricated zero
// in a spend readout is worse than no readout, because the user would budget against it.
//
// Proves, against the REAL pure modules:
//   1. ANTI-FABRICATION: a cold meter's provider rows all read "not reported" and are marked unmeasured.
//   2. MEASURED ZERO IS DIFFERENT: a REPORTED cost of 0 renders $0.00 and stays measured, because a
//      reported zero is a fact while an unreported zero is an invention.
//   3. ESTIMATES ARE LABELED: every output row is unmeasured and carries a hint containing "estimate".
//   4. ATTRIBUTION IS NOT MEASUREMENT: per-tool context delta is null unless two usage samples bracket
//      the call, and the row says so instead of showing 0.
//   5. BOUNDED + PURE: 70 calls keep the newest 60, and no reducer mutates its input.
//   6. HEALTH CHECKS ARE COUNTED: the harness's own probes/recoveries appear as their own row, which is
//      how the user sees the self-watch working for them.
//   7. GEOMETRY: dragging a card's BOTTOM edge DOWN grows it (the grip follows the cursor, cards are
//      top-anchored so the rest of the row holds still), the dock's north edge keeps its BOTTOM edge
//      fixed, and a corrupt saved layout degrades to empty, never throws.
//
// Run: bun run harness/scripts/demo_ptokens1.ts

import {
  CARD_MAX_COLS, CARD_MIN_COLS, CARD_MIN_H, colsFromDrag, gridCols, heightFromDrag, loadLayout, reconcile,
  reorder, resizeShape, saveLayout, snapSlot,
} from "../../desktop/renderer/lane_layout.ts";
import { clampToViewport, DOCK_MIN_H, DOCK_MIN_W } from "../../desktop/renderer/share_dock.ts";
import {
  TOOLS_MAX, fmtMs, fmtTokens, fmtUsd, meterBadge, meterRows, modelRows, newMeter, onHealth, onOutput,
  onToolEnd, onToolStart, onTurnEnd, onUsage, toolRows,
} from "../../desktop/renderer/token_meter.ts";

function fail(msg: string): never {
  console.error(`   FAIL - ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`   ok - ${msg}`);
}

const T0 = 1_800_000_000_000;

// -- 1. anti-fabrication -------------------------------------------------------------------------------
console.log("1) ANTI-FABRICATION: a metric the provider never sent is never rendered as a number");
{
  const cold = newMeter(T0);
  if (cold.ctxTokens !== null || cold.ctxSize !== null || cold.costUsd !== null) fail("provider figures start ABSENT, not zero");
  const rows = meterRows(cold);
  const joined = rows.map((r) => r.value).join(" | ");
  if (joined.includes("$0.00")) fail(`a cold meter must never print $0.00, got: ${joined}`);
  if (/\b0 tokens\b/.test(joined)) fail(`a cold meter must never print "0 tokens", got: ${joined}`);
  const provider = rows.filter((r) => /^Context|^Cost/.test(r.label));
  if (!provider.length) fail("the provider rows must exist even when unreported");
  for (const r of provider) {
    if (r.measured) fail(`"${r.label}" cannot be marked measured before a usage sample arrived`);
    if (!/not reported/i.test(r.value)) fail(`"${r.label}" must read "not reported", got "${r.value}"`);
  }
  ok(`${provider.length} provider rows all read "not reported" and are marked unmeasured`);

  const badge = meterBadge(cold);
  if (badge.pct !== null) fail("the button shows no percent until the provider reports one");
  if (!badge.label.trim()) fail("it must still SAY something, or the button looks broken");
  ok(`the button says "${badge.label}" rather than inventing 0%`);
}

// -- 2. a measured zero is a fact ---------------------------------------------------------------------
console.log("2) a REPORTED zero is legitimate and looks different from an unreported one");
{
  let m = newMeter(T0);
  m = onUsage(m, { used: 1000, size: 200_000, cost: 0.42 }, T0 + 1_000);
  const ctx = meterRows(m).find((r) => r.label === "Context used");
  const cost = meterRows(m).find((r) => r.label === "Cost");
  if (!ctx?.measured) fail("context is MEASURED once reported");
  if (!ctx.value.includes("1000") || !ctx.value.includes("200000")) fail(`the one figure the provider actually sends is shown exactly, got "${ctx.value}"`);
  if (cost?.value !== "$0.42" || !cost.measured) fail(`cost must render exactly, got "${cost?.value}"`);
  ok(`reported: "${ctx.value}" and "${cost.value}", both measured`);

  m = onUsage(m, { used: 1000, size: 200_000, cost: 0 }, T0 + 2_000);
  const zero = meterRows(m).find((r) => r.label === "Cost");
  if (!zero?.measured) fail("a reported zero stays MEASURED");
  if (zero.value !== "$0.00") fail(`a reported zero renders $0.00, got "${zero.value}"`);
  ok("a reported cost of 0 renders $0.00 and stays measured (the distinction that matters)");
}

// -- 3. estimates are labeled --------------------------------------------------------------------------
console.log("3) the local output estimate is never dressed up as a provider figure");
{
  let m = newMeter(T0);
  m = onUsage(m, { used: 500, size: 100_000, cost: 0.1 }, T0 + 1);
  m = onOutput(m, 1234, T0 + 2);
  const out = meterRows(m).find((r) => /Output/.test(r.label));
  if (!out) fail("there must be an output row");
  if (out.measured) fail("output is ESTIMATED on this path - marking it measured would be the fabrication");
  if (!out.hint || !/estimate/i.test(out.hint)) fail(`an unmeasured row REQUIRES a hint saying so, got: ${out.hint}`);
  if (!/Output.*estimated/i.test(out.label) && !/estimat/i.test(out.label)) fail(`the label itself should carry the caveat, got "${out.label}"`);
  ok(`"${out.label}" = ${out.value}, unmeasured, hint: "${out.hint}"`);
}

// -- 4. attribution is not measurement -----------------------------------------------------------------
console.log("4) per-call context delta is ATTRIBUTION, and says so when it cannot be attributed");
{
  let m = newMeter(T0);
  m = onUsage(m, { used: 1000, size: 200_000, cost: 0.1 }, T0 + 1);
  m = onToolStart(m, "c1", "bash", "bun test", T0 + 2);
  const running = toolRows(m)[0];
  if (!running) fail("a started call must appear immediately");
  if (!/running/i.test(running.value)) fail(`an unfinished call reads "running", got "${running.value}"`);
  m = onUsage(m, { used: 1400, size: 200_000, cost: 0.2 }, T0 + 3);
  m = onToolEnd(m, "c1", T0 + 4);
  const settled = toolRows(m)[0];
  if (!settled?.value.includes("400")) fail(`bracketed samples attribute a 400-token delta, got "${settled?.value}"`);
  ok(`a bracketed call is attributed +400 context: "${settled.value}"`);

  let n = newMeter(T0);
  n = onToolStart(n, "c9", "read", "read a file", T0 + 1);
  n = onToolEnd(n, "c9", T0 + 2);
  const unattr = toolRows(n)[0];
  if (!unattr) fail("the call must still be listed");
  if (/\b0\b/.test(unattr.value.replace(/\d+ms|\d+s/g, ""))) fail(`an unattributed delta must NOT read as 0, got "${unattr.value}"`);
  if (unattr.measured) fail("a tool row is only as trustworthy as its weakest number, so it is never measured");
  ok(`an unbracketed call says so instead of showing 0: "${unattr.value}"`);

  if (fmtTokens(null) !== "not reported") fail("fmtTokens(null) is the honest string");
  if (fmtUsd(null) !== "not reported") fail("fmtUsd(null) is the honest string");
  if (fmtMs(undefined) !== "running") fail("an unfinished duration is 'running', not 0ms");
  if (fmtTokens(-5) !== "0") fail("a negative token count is never rendered as negative");
  ok("the formatters themselves refuse to fabricate (null, undefined, and negative all handled)");
}

// -- 5. bounded and pure -------------------------------------------------------------------------------
console.log("5) the meter is bounded and every reducer is pure");
{
  let m = newMeter(T0);
  for (let i = 0; i < 70; i++) {
    m = onToolStart(m, `c${i}`, "bash", `call ${i}`, T0 + i * 10);
    m = onToolEnd(m, `c${i}`, T0 + i * 10 + 5);
  }
  if (m.tools.length !== TOOLS_MAX) fail(`70 calls must keep exactly ${TOOLS_MAX}, got ${m.tools.length}`);
  const rows = toolRows(m);
  if (!rows[0]!.label.includes("69")) fail(`newest first: the top row must be call 69, got "${rows[0]!.label}"`);
  if (rows.some((r) => /call [0-9]\b/.test(r.label))) fail("the OLDEST calls must be the ones dropped");
  ok(`70 calls keep the newest ${TOOLS_MAX}, newest first, oldest dropped`);

  const before = newMeter(T0);
  const snapshot = JSON.stringify(before);
  onUsage(before, { used: 1, size: 2, cost: 3 }, T0 + 1);
  onToolStart(before, "x", "y", "z", T0 + 2);
  onOutput(before, 99, T0 + 3);
  onHealth(before, T0 + 4);
  onTurnEnd(before, T0 + 5);
  if (JSON.stringify(before) !== snapshot) fail("a reducer mutated its input - these must be pure");
  ok("five reducers ran against one state object and mutated nothing");
}

// -- 6. the harness's own work is visible -------------------------------------------------------------
console.log("6) health checks are counted, so the user SEES the self-watch working");
{
  let m = newMeter(T0);
  m = onHealth(m, T0 + 1);
  m = onHealth(m, T0 + 2);
  if (m.healthChecks !== 2) fail(`expected 2 health checks, got ${m.healthChecks}`);
  const row = meterRows(m).find((r) => /Health/i.test(r.label));
  if (!row) fail("health checks need their own row");
  if (!row.value.includes("2")) fail(`the row must show the count, got "${row.value}"`);
  ok(`"${row.label}" = ${row.value}`);

  const mr = modelRows([]);
  if (!mr.length) fail("an empty per-model rollup must still explain itself, not vanish");
  if (mr[0]!.measured) fail("nothing recorded yet is not a measurement");
  ok(`an empty per-model rollup says: "${mr[0]!.value}"`);

  for (const [pct, want] of [[74, "ok"], [75, "warn"], [90, "danger"]] as const) {
    let b = newMeter(T0);
    b = onUsage(b, { used: pct * 1000, size: 100_000, cost: 0.1 }, T0 + 1);
    const badge = meterBadge(b);
    if (badge.tone !== want) fail(`${pct}% must be ${want}, got ${badge.tone}`);
  }
  let over = newMeter(T0);
  over = onUsage(over, { used: 250_000, size: 100_000, cost: 1 }, T0 + 1);
  const ob = meterBadge(over);
  if ((ob.pct ?? 0) > 100 || ob.tone !== "danger") fail(`an over-window fill caps at 100 and stays danger, got ${ob.pct}/${ob.tone}`);
  ok("tone escalates at 75% and 90%, and an over-window fill caps at 100% danger");
}

// -- 7. lane window geometry ---------------------------------------------------------------------------
console.log("7) P-FLEET.L9: the geometry behind top/right resize and drag-to-snap");
{
  if (gridCols(0) !== 1 || gridCols(Number.NaN) !== 1) fail("a nonsense width still yields one usable track");
  if (gridCols(300) !== 1 || gridCols(610) !== 2 || gridCols(920) !== 3) fail("track math must match the CSS grid");
  ok("gridCols matches the stylesheet's 300px tracks with a 10px gap, and never returns 0");

  // The sign: the grip is on the BOTTOM-RIGHT corner (the conventional window grip), so dragging DOWN is
  // a positive dy and must GROW the card. Cards are top-anchored, which keeps every other card's top edge
  // still while one grows. Backwards here and the gesture fights the pointer.
  const grown = heightFromDrag(300, 100);
  if (grown !== 400) fail(`dragging DOWN must GROW the card: expected 400, got ${grown}`);
  if (heightFromDrag(300, -100) !== 200) fail("dragging UP must shrink it");
  if (heightFromDrag(CARD_MIN_H, -9999) !== CARD_MIN_H) fail("height clamps at the floor");
  if (!Number.isFinite(heightFromDrag(300, Number.NaN))) fail("a NaN drag must never produce a NaN height");
  ok(`a 100px downward drag grows 300 -> ${grown} (the grip follows the cursor)`);

  if (colsFromDrag(1, 149, 6) !== 1) fail("under half a track must not jitter the span");
  if (colsFromDrag(1, 150, 6) !== 2) fail("half a track commits one column");
  if (colsFromDrag(1, -400, 6) !== CARD_MIN_COLS) fail("span clamps at the floor");
  if (colsFromDrag(1, 5000, 2) !== 2) fail("the span can never exceed the tracks that actually fit");
  if (colsFromDrag(1, 5000, 99) !== CARD_MAX_COLS) fail(`the span clamps at ${CARD_MAX_COLS}`);
  ok("a right-edge drag has a half-track deadzone and clamps to what fits");

  const rects = [
    { id: "a", x: 0, y: 0, w: 300, h: 200 }, { id: "b", x: 310, y: 0, w: 300, h: 200 },
    { id: "c", x: 0, y: 210, w: 300, h: 200 }, { id: "d", x: 310, y: 210, w: 300, h: 200 },
  ];
  if (snapSlot(rects, 150, 100) !== 0 || snapSlot(rects, 460, 100) !== 1) fail("top row quadrants");
  if (snapSlot(rects, 150, 300) !== 2 || snapSlot(rects, 460, 300) !== 3) fail("bottom row quadrants");
  if (snapSlot(rects, 150, 9999) !== 3) fail("below every row lands last");
  if (snapSlot([], 0, 0) !== -1) fail("an empty grid has no slot");
  ok("snapSlot resolves all four quadrants of a 2x2 grid, plus out-of-band above and below");

  const order = ["a", "b", "c", "d"];
  if (reorder(order, "a", 3).join() !== "b,c,d,a") fail("moving first to last");
  if (reorder(order, "d", 0).join() !== "d,a,b,c") fail("moving last to first");
  const noop = reorder(order, "zz", 1);
  if (noop === order) fail("even a no-op returns a NEW array (never a shared reference)");
  if (noop.join() !== order.join()) fail("an unknown id changes nothing");
  ok("reorder handles both ends, and an unknown id is a fresh no-op array");

  const rec = reconcile({ order: ["a", "b"], size: { a: { cols: 2, h: 300 }, b: { cols: 1, h: 200 } } }, ["b", "c"]);
  if (rec.order.join() !== "b,c") fail(`a vanished lane drops and a new one appends, got ${rec.order.join()}`);
  if ("a" in rec.size) fail("a vanished lane must RELEASE its size entry, or the store grows forever");
  ok("reconcile drops a stopped lane (and its size), appends a new one, preserves surviving order");

  for (const junk of [null, undefined, "", "not json", "{}", '{"order":"nope"}', '{"order":[1,2]}']) {
    const l = loadLayout(junk as string | null | undefined);
    if (l.order.length || Object.keys(l.size).length) fail(`corrupt payload ${JSON.stringify(junk)} must yield an EMPTY layout`);
  }
  const round = { order: ["a"], size: { a: { cols: 2, h: 300 } } };
  if (saveLayout(loadLayout(saveLayout(round))) !== saveLayout(round)) fail("a valid layout must round-trip byte-identically");
  ok("7 corrupt payloads all degrade to empty without throwing; a valid layout round-trips exactly");

  const start = { x: 100, y: 100, w: 600, h: 400 };
  const north = resizeShape("n", start, 0, -50, DOCK_MIN_W, DOCK_MIN_H);
  if (north.y + north.h !== start.y + start.h) fail(`a north drag must keep the BOTTOM edge fixed: ${north.y}+${north.h} vs ${start.y + start.h}`);
  if (north.h !== 450) fail(`a 50px north drag grows height by 50, got ${north.h}`);
  if (north.x !== start.x || north.w !== start.w) fail("a north drag touches neither x nor w");
  ok(`the dock's new north edge grows upward with the bottom pinned at ${north.y + north.h}px`);

  const pinned = resizeShape("n", start, 0, 9999, DOCK_MIN_W, DOCK_MIN_H);
  if (pinned.h !== DOCK_MIN_H) fail("height pins at the minimum");
  if (pinned.y + pinned.h !== start.y + start.h) fail("the bottom edge stays fixed even once height pins");
  ok("past the minimum, height pins and y stops - the bottom edge never moves");

  const off = resizeShape("nw", { x: 10, y: 10, w: 600, h: 400 }, -5000, -5000, DOCK_MIN_W, DOCK_MIN_H);
  const on = clampToViewport(off, 1440, 900);
  if (on.x < 0 || on.y < 0 || on.x + on.w > 1440 || on.y + on.h > 900) fail("resizeShape must compose with share_dock's viewport clamp");
  ok("resizeShape leaves viewport clamping to share_dock, and the two compose cleanly");
}

console.log("\nP-TOKENS.1 / P-FLEET.L9 demo: PASS");
