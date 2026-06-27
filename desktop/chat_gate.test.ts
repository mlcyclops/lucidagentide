// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for the chat-yield gate (P-KG-INGEST.3, ADR-0081): background extraction yields to a live chat.

import { expect, test } from "bun:test";
import { ChatGate } from "./chat_gate.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("idle gate: whenIdle() resolves immediately", async () => {
  const g = new ChatGate();
  expect(g.active).toBe(false);
  let resolved = false;
  void g.whenIdle().then(() => { resolved = true; });
  await tick();
  expect(resolved).toBe(true);
});

test("active gate: whenIdle() pends until the chat turn ends", async () => {
  const g = new ChatGate();
  g.begin();
  expect(g.active).toBe(true);
  let resolved = false;
  void g.whenIdle().then(() => { resolved = true; });
  await tick();
  expect(resolved).toBe(false); // chat is live → extraction waits
  g.end();
  expect(g.active).toBe(false);
  await tick();
  expect(resolved).toBe(true); // released when the chat turn finished
});

test("end() releases ALL queued waiters (several pending extractions)", async () => {
  const g = new ChatGate();
  g.begin();
  let n = 0;
  void g.whenIdle().then(() => n++);
  void g.whenIdle().then(() => n++);
  await tick();
  expect(n).toBe(0);
  g.end();
  await tick();
  expect(n).toBe(2);
});

test("end() when already idle is a harmless no-op", () => {
  const g = new ChatGate();
  g.end();
  expect(g.active).toBe(false);
});

test("chat preempts a back-to-back extraction loop", async () => {
  // Model the import: each extraction awaits whenIdle() before running. While chat is live none start; once
  // it ends, they resume. So chat replies first even though extraction was already looping.
  const g = new ChatGate();
  const order: string[] = [];
  const extraction = async (label: string) => { await g.whenIdle(); order.push(label); };
  g.begin(); // user sends a chat mid-import
  const e1 = extraction("ingest-1");
  await tick();
  order.push("chat-reply"); // chat does its work...
  g.end();                   // ...and finishes
  await Promise.all([e1, extraction("ingest-2")]);
  expect(order[0]).toBe("chat-reply"); // chat went first; the import waited its turn
  expect(order).toContain("ingest-1");
  expect(order).toContain("ingest-2");
});
