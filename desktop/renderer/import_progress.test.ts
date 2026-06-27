// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for the import-progress pill formatter (P-KG-INGEST.1, ADR-0076).

import { expect, test } from "bun:test";
import { formatImportLine } from "./import_progress.ts";

test("running: pct + messages/total + facts; not done", () => {
  const r = formatImportLine({ state: "running", messages: 3, totalMessages: 10, learned: 5, blocked: 0 });
  expect(r.pct).toBe(30);
  expect(r.done).toBe(false);
  expect(r.line).toContain("3/10 messages");
  expect(r.line).toContain("5 facts");
});

test("blocked count appears only when nonzero", () => {
  expect(formatImportLine({ state: "running", messages: 1, totalMessages: 4, learned: 0, blocked: 2 }).line).toContain("2 blocked");
  expect(formatImportLine({ state: "running", messages: 1, totalMessages: 4, learned: 0, blocked: 0 }).line).not.toContain("blocked");
});

test("done is 100% and final", () => {
  const r = formatImportLine({ state: "done", messages: 10, totalMessages: 10, learned: 7, blocked: 0 });
  expect(r).toEqual({ pct: 100, line: "Done — learned 7 facts from 10 messages", done: true });
});

test("cancelled keeps the partial facts", () => {
  const r = formatImportLine({ state: "cancelled", messages: 4, totalMessages: 10, learned: 2, blocked: 0 });
  expect(r.done).toBe(true);
  expect(r.line).toContain("kept 2 facts");
});

test("failed", () => {
  expect(formatImportLine({ state: "failed", messages: 0, totalMessages: 0, learned: 0, blocked: 0 }).line).toBe("Import failed");
});

test("singular fact + zero total → 0% and no divide-by-zero", () => {
  const r = formatImportLine({ state: "running", messages: 0, totalMessages: 0, learned: 1, blocked: 0 });
  expect(r.pct).toBe(0);
  expect(r.line).toContain("1 fact");
  expect(r.line).not.toContain("facts"); // singular, not "1 facts"
});
