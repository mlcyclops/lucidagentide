// harness/security/notification.test.ts

import { test, expect } from "bun:test";
import { buildNotification, summarizeNotification } from "./notification.ts";
import type { Finding } from "../contracts.ts";

const findings: Finding[] = [
  { type: "zero-width", codepoint: "U+200B", index: 4, severity: "high" },
  { type: "unicode-tag-block", codepoint: "U+E0041", index: 9, severity: "critical" },
  { type: "zero-width", codepoint: "U+200C", index: 12, severity: "high" },
];

test("builds a notification with max severity and unique finding types", () => {
  const n = buildNotification({
    source: "bash",
    trustLabel: "quarantined",
    findings,
    blocked: "tool_call:bash",
    reason: "quarantined",
    failClosed: false,
  });
  expect(n.maxSeverity).toBe("critical");
  expect(n.findingTypes.sort()).toEqual(["unicode-tag-block", "zero-width"]);
  expect(n.findingCount).toBe(3);
});

test("fail-closed notifications report critical severity even with no findings", () => {
  const n = buildNotification({
    source: "edit",
    trustLabel: "quarantined",
    findings: [],
    blocked: "tool_call:edit",
    reason: "fail-closed",
    failClosed: true,
  });
  expect(n.maxSeverity).toBe("critical");
  expect(n.findingTypes).toEqual([]);
});

test("summary never embeds raw content", () => {
  const n = buildNotification({
    source: "import",
    trustLabel: "quarantined",
    findings,
    blocked: "tool_call:import",
    reason: "quarantined",
    failClosed: false,
  });
  const s = summarizeNotification(n);
  expect(s).toContain("trust=quarantined");
  expect(s).toContain("severity=critical");
});
