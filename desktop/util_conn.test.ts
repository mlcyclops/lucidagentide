// Tests for the utility-completion routing contract (P-KG-INGEST.4, ADR-0085).

import { expect, test } from "bun:test";
import { completionPath, needsChatYield } from "./util_conn.ts";

test("a ready dedicated connection → the dedicated path (true concurrency)", () => {
  expect(completionPath(true)).toBe("dedicated");
});

test("no dedicated connection → the shared-connection fallback (fail-safe, today's behavior)", () => {
  expect(completionPath(false)).toBe("shared-fallback");
});

test("only the shared fallback yields to a live chat turn; the dedicated path never does", () => {
  expect(needsChatYield("shared-fallback")).toBe(true);   // shares the chat connection → must yield (ChatGate)
  expect(needsChatYield("dedicated")).toBe(false);        // own process → runs flat-out, zero chat impact
});
