// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/mcp/acp_client.test.ts
//
// P-AGENTFW.3 (ADR-0149): the pure permission helpers behind the per-connection permission policy —
// summarizing what the remote asked, and picking an approve option only when policy = "allow".

import { test, expect } from "bun:test";
import { permissionRequestSummary, pickApproveOption } from "./acp_client.ts";

test("permissionRequestSummary extracts the toolCall title, then kind, else a generic label", () => {
  expect(permissionRequestSummary({ toolCall: { title: "rm -rf /" } })).toBe("rm -rf /");
  expect(permissionRequestSummary({ toolCall: { kind: "execute" } })).toBe("execute");
  expect(permissionRequestSummary({ toolCall: {} })).toBe("a privileged action");
  expect(permissionRequestSummary({})).toBe("a privileged action");
  expect(permissionRequestSummary(null)).toBe("a privileged action");
});

test("pickApproveOption returns an 'allow*' optionId, else undefined (→ deny)", () => {
  expect(pickApproveOption({ options: [{ optionId: "a", kind: "allow_once" }, { optionId: "d", kind: "reject_once" }] })).toBe("a");
  expect(pickApproveOption({ options: [{ optionId: "b", kind: "allow_always" }] })).toBe("b");
  expect(pickApproveOption({ options: [{ optionId: "d", kind: "reject_once" }] })).toBeUndefined();
  expect(pickApproveOption({ options: [] })).toBeUndefined();
  expect(pickApproveOption({})).toBeUndefined();
  expect(pickApproveOption(null)).toBeUndefined();
});
