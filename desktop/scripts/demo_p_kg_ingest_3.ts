// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kg_ingest_3.ts
//
// Increment P-KG-INGEST.3 — chat stays responsive during an AI-mode ingest (issue #125, ADR-0081).
// Model-mode import fires a model completion per message, back-to-back, over the one omp connection, so a
// long import used to starve chat. Now each extraction awaits the ChatGate's whenIdle() first: while a chat
// turn is live the import pauses, so chat preempts it (at most one in-flight extraction of latency).

import { ChatGate } from "../chat_gate.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log("== #125 chat preempts a back-to-back ingest loop ==");

const g = new ChatGate();
const order: string[] = [];
// the import loop: every extraction yields to a live chat turn before running
const extraction = async (label: string) => { await g.whenIdle(); order.push(label); };

if (g.active) fail("a fresh gate must be idle");
let immediate = false;
void g.whenIdle().then(() => { immediate = true; });
await tick();
if (!immediate) fail("when idle, extraction should run immediately (no chat to yield to)");
ok("idle: extraction runs immediately — zero overhead when nobody is chatting");

g.begin(); // the user sends a chat message mid-import
const e1 = extraction("ingest-A");
const e2 = extraction("ingest-B");
await tick();
if (order.length !== 0) fail("no extraction may start while a chat turn is live");
ok("a chat turn is live → queued extractions PAUSE (chat isn't starved)");

order.push("chat-reply"); // chat does its work and finishes
g.end();
await Promise.all([e1, e2]);
if (order[0] !== "chat-reply") fail("chat should have replied before the paused extractions resumed");
if (!order.includes("ingest-A") || !order.includes("ingest-B")) fail("the import must resume after chat");
ok("chat replied first, THEN the import resumed where it left off (no work lost)");

console.log("demo-P-KG-INGEST.3 OK");
process.exit(0);
