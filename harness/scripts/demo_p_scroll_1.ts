// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_scroll_1.ts - P-SCROLL.1 (ADR-0405): the chat follows new output until the
// READER scrolls up, a spoke switch lands on the newest message or where the reader left off, and a new
// spoke opens on the model the last spoke ran. The DOM wiring lives in app.ts / fleet_orbit.ts /
// fleet_grid.ts; this exercises the pure rules they read.

import { anchorTop, nextFollow, readingAnchor } from "../../desktop/renderer/scroll_jump.ts";
import { spawnModelDefault } from "../../desktop/renderer/spoke_prefs.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const m = (scrollHeight: number, scrollTop: number, clientHeight: number) => ({ scrollHeight, scrollTop, clientHeight });

console.log("== P-SCROLL.1 (ADR-0405): follow, spoke-switch landing, spawn model ==");

// 1) the reported bug: a burst taller than the stick window no longer releases the follow on its own
if (!nextFollow(true, 600, m(1900, 600, 400), false)) fail("a 900px burst released the follow with no reader input");
if (nextFollow(true, 600, m(1000, 560, 400), true)) fail("the reader's own scroll up must release the follow");
if (!nextFollow(true, 600, m(900, 300, 400), false)) fail("a reflow clamp is not the reader scrolling away");
if (!nextFollow(false, 300, m(1000, 600, 400), true)) fail("reaching the bottom must re-engage the follow");
ok("follow: content growth never releases it, the reader's scroll up does, the bottom re-engages it");

// 2) "return to where I left off": the anchor survives a re-render that dropped older turns
const boxes = [
  { key: "u:hi", top: 0, height: 100 }, { key: "a:hello", top: 100, height: 300 },
  { key: "u:ok", top: 400, height: 50 }, { key: "a:done", top: 450, height: 200 }, { key: "u:ok", top: 650, height: 50 },
];
const a = readingAnchor(boxes, 250) ?? fail("no anchor for a populated thread");
if (anchorTop(boxes.slice(1).map((b) => ({ ...b, top: b.top - 100 })), a) !== 150) fail("anchor lost after older turns dropped");
const second = readingAnchor(boxes, 660) ?? fail("no anchor on the second repeated prompt");
if (anchorTop(boxes, second) !== 660) fail("a repeated prompt must resolve to the occurrence nearest its old index");
if (anchorTop(boxes.slice(2), a) !== null) fail("a message that fell off must yield null (land on the newest)");
ok("resume: the reader's message is found by content, nearest index, and a vanished one lands on the newest");

// 3) the spawn model: last spoke's model, else the master's, never a silently unselected form
const opts = [{ value: "anthropic/claude-opus-5-5" }, { value: "anthropic/claude-sonnet-5" }];
if (spawnModelDefault(opts, "anthropic/claude-sonnet-5", "anthropic/claude-opus-5-5") !== "anthropic/claude-sonnet-5") fail("the last spoke model must win");
if (spawnModelDefault(opts, "retired/model", "anthropic/claude-opus-5-5") !== "anthropic/claude-opus-5-5") fail("a retired remembered model falls back to the master's");
if (spawnModelDefault(opts, "", "") !== "anthropic/claude-opus-5-5") fail("with nothing known, the first offered model is preselected");
ok("spawn: the last spoke's model when still offered, else the master's, else the first offered");

console.log("P-SCROLL.1 demo: PASS");
