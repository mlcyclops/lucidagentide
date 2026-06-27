// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/hooks/quarantine_hook.test.ts
//
// PHASE 2 KEYSTONE: blocked content provably cannot reach a tool call, enforced
// by omp's own pre-hook mechanism. Poisoned tool input -> execute() never runs;
// clean input -> runs; dead scanner -> fail-closed block.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { type } from "arktype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { ScannerClient } from "../security/scanner_client.ts";
import { makeQuarantineExtension } from "./quarantine_hook.ts";
import { createEchoSession } from "../testing/echo.ts";
import type { QuarantineNotification } from "../security/notification.ts";

const ZWSP = String.fromCodePoint(0x200b);
let scanner: ScannerClient;

beforeAll(() => {
  scanner = new ScannerClient();
  scanner.start();
});
afterAll(() => scanner.stop());

function makeRecordTool() {
  const state = { executed: false };
  const tool = {
    name: "record_note",
    label: "Record Note",
    description: "Persist a note (privileged).",
    parameters: type({ note: "string" }),
    async execute(_id: string, _params: { note: string }) {
      state.executed = true;
      return { content: [{ type: "text", text: "recorded" }] };
    },
  } as unknown as CustomTool;
  return { tool, state };
}

async function driveToolCall(note: string, client: ScannerClient) {
  const { tool, state } = makeRecordTool();
  let notification: QuarantineNotification | undefined;
  const ext = makeQuarantineExtension({ scanner: client, onBlock: (n) => (notification = n) });
  const { session, cleanup } = await createEchoSession({
    customTools: [tool],
    extensions: [ext],
    responses: [
      { content: [{ type: "toolCall", name: "record_note", arguments: { note } }] },
      { content: ["ok"] },
    ],
  });
  try {
    await session.prompt("go");
  } finally {
    cleanup();
  }
  return { executed: state.executed, notification };
}

test("poisoned tool input is BLOCKED — execute() never runs", async () => {
  const r = await driveToolCall(`edit${ZWSP}file`, scanner);
  expect(r.executed).toBe(false);
  expect(r.notification?.findingTypes).toContain("zero-width");
  expect(r.notification?.trustLabel).toBe("quarantined");
}, 20_000);

test("clean tool input is allowed — execute() runs", async () => {
  const r = await driveToolCall("a perfectly normal note", scanner);
  expect(r.executed).toBe(true);
  expect(r.notification).toBeUndefined();
}, 20_000);

test("FAIL-CLOSED: a dead scanner blocks the tool call", async () => {
  const dead = new ScannerClient();
  dead.start();
  dead.stop();
  const r = await driveToolCall("totally benign note", dead);
  expect(r.executed).toBe(false);
  expect(r.notification?.failClosed).toBe(true);
}, 20_000);
