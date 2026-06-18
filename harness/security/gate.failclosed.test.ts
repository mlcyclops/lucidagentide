// harness/security/gate.failclosed.test.ts
//
// KEYSTONE SAFETY TEST (CLAUDE.md #3, DECISIONS.md Increment 0 acceptance).
// If the scanner sidecar is unavailable, the gate MUST block. This test kills
// the sidecar and asserts the gate fails closed. It must stay green forever.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { ScannerClient } from "./scanner_client.ts";
import { scanAndDecide, decideFromFindings } from "./gate.ts";

const ZWSP = String.fromCodePoint(0x200b);
let client: ScannerClient;

beforeAll(() => {
  client = new ScannerClient({ timeoutMs: 4000 });
  client.start();
});

afterAll(() => {
  client.stop();
});

test("clean text passes the gate", async () => {
  const d = await scanAndDecide(client, "hello world, a normal prompt");
  expect(d.block).toBe(false);
  expect(d.trustLabel).toBe("trusted");
  expect(d.failClosed).toBe(false);
});

test("poisoned text (zero-width) is blocked and quarantined", async () => {
  const d = await scanAndDecide(client, `edit${ZWSP}file`);
  expect(d.block).toBe(true);
  expect(d.trustLabel).toBe("quarantined");
  expect(d.findings.some((f) => f.type === "zero-width")).toBe(true);
  expect(d.failClosed).toBe(false);
});

test("FAIL-CLOSED: killing the sidecar makes the gate BLOCK, not pass", async () => {
  client.stop();
  expect(client.alive).toBe(false);

  const d = await scanAndDecide(client, "totally benign text with no findings at all");
  // The text is clean, yet the decision MUST be block — because we could not scan.
  expect(d.block).toBe(true);
  expect(d.failClosed).toBe(true);
  expect(d.trustLabel).toBe("quarantined");
  expect(d.reason).toContain("fail-closed");
});

test("decideFromFindings is pure and severity-gated", () => {
  expect(decideFromFindings([]).block).toBe(false);
  expect(
    decideFromFindings([{ type: "zero-width", codepoint: "U+200B", index: 0, severity: "high" }]).block,
  ).toBe(true);
  // sub-threshold finding: allowed but labeled suspicious
  const sub = decideFromFindings([
    { type: "private-use-area", codepoint: "U+E000", index: 0, severity: "medium" },
  ]);
  expect(sub.block).toBe(false);
  expect(sub.trustLabel).toBe("suspicious");
});
