// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/acp.test.ts - P-KG-INGEST.5 (ADR-0252): the ACP request layer must ALWAYS settle.
//
// The chat-history import wedged at "0/500 messages" because `request()` had no timeout and never
// rejected when the omp child died: the promise for `initialize` (or `session/new`) simply stayed
// pending forever, and every later call queued behind it. These tests pin the four ways a request can
// fail to get an answer - dead child, mute child, unspawnable binary, caller cancelled - and assert each
// one REJECTS. A regression here reintroduces an unkillable import, so treat a failure as stop-the-line.

import { expect, test } from "bun:test";
import { ACPClient } from "./acp.ts";

// Child processes are driven with `bun -e`, using the same runtime that runs the tests.
const BUN = process.execPath;

// Answers every request with {ok:true}: the happy path, so the bounds don't break normal traffic.
const ECHO = `
process.stdin.on("data", (d) => {
  for (const line of String(d).split("\\n")) {
    const s = line.trim();
    if (!s) continue;
    const m = JSON.parse(s);
    if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: true, method: m.method } }) + "\\n");
  }
});
`;
// Accepts the connection, reads the request, and never replies: a spawned-but-mute omp (the real bug).
const MUTE = `process.stdin.resume(); setTimeout(() => {}, 60000);`;
// Dies the moment it receives anything: a crashing omp mid-handshake.
const DIES = `process.stdin.on("data", () => process.exit(7));`;

const client = (script: string): ACPClient => new ACPClient(BUN, ["-e", script], process.cwd());

test("happy path still resolves with the agent's result", async () => {
  const acp = client(ECHO);
  acp.start();
  const r = await acp.request<{ ok: boolean; method: string }>("initialize", { protocolVersion: 1 }, { timeoutMs: 10_000 });
  expect(r.ok).toBe(true);
  expect(r.method).toBe("initialize");
  acp.stop();
});

test("a mute child rejects on the timeout instead of hanging forever", async () => {
  const acp = client(MUTE);
  acp.start();
  // 250ms is the CONTRACT under test (a request must honor its bound), not a race-prone sleep.
  await expect(acp.request("initialize", {}, { timeoutMs: 250 })).rejects.toThrow(/timed out/i);
  acp.stop();
});

test("a child that exits mid-request rejects every in-flight request", async () => {
  const acp = client(DIES);
  acp.start();
  // No timeout on purpose: the exit itself must settle the promise. This is the case that wedged the
  // import, because `pending` was never drained on exit.
  // Both matchers are attached synchronously: the child's exit rejects BOTH at once, and a handler
  // attached later would surface as an unhandled rejection in the gap.
  const a = expect(acp.request("initialize", {})).rejects.toThrow(/exited/i);
  const b = expect(acp.request("session/new", {})).rejects.toThrow(/exited/i);
  await Promise.all([a, b]);
  expect(acp.isDead).toBe(true);
});

test("a request after the child is gone rejects immediately", async () => {
  const acp = client(DIES);
  acp.start();
  await expect(acp.request("initialize", {})).rejects.toThrow(/exited/i);
  await expect(acp.request("session/new", {})).rejects.toThrow(/exited/i);
});

test("an unspawnable binary rejects (spawn error emits no exit event)", async () => {
  const acp = new ACPClient("lucid-no-such-binary-xyz", ["acp"], process.cwd());
  const exits: (number | null)[] = [];
  acp.onExit = (code) => exits.push(code);
  acp.start();
  await expect(acp.request("initialize", {})).rejects.toThrow(/failed to start|exited/i);
  expect(exits.length).toBe(1); // the owner is told exactly once, so it can respawn
});

test("an aborted signal rejects the in-flight request", async () => {
  const acp = client(MUTE);
  acp.start();
  const ctl = new AbortController();
  const pending = acp.request("session/prompt", {}, { signal: ctl.signal });
  ctl.abort();
  await expect(pending).rejects.toThrow(/cancelled/i);
  acp.stop();
});

test("an already-aborted signal rejects without sending anything", async () => {
  const acp = client(ECHO);
  acp.start();
  await expect(acp.request("session/prompt", {}, { signal: AbortSignal.abort() })).rejects.toThrow(/cancelled/i);
  acp.stop();
});

test("stop() settles anything still waiting", async () => {
  const acp = client(MUTE);
  acp.start();
  const pending = acp.request("initialize", {});
  acp.stop();
  await expect(pending).rejects.toThrow(/stopped/i);
});
