// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/gate_audit.test.ts — P-ENT.4 (ADR-0069): a gate denial is attributed honestly.

import { describe, expect, test } from "bun:test";
import { gateDenyReason } from "./gate_audit.ts";

describe("gateDenyReason", () => {
  test("an explicit deny optionId → 'denied by you' (your decision)", () => {
    expect(gateDenyReason("exec:deny")).toBe("denied by you");
    expect(gateDenyReason("egress:deny")).toBe("denied by you");
  });
  test("no optionId (turn ended / disconnected while pending) → fail-closed, NOT you", () => {
    expect(gateDenyReason(null)).toBe("fail-closed (turn ended)");
    expect(gateDenyReason(undefined)).toBe("fail-closed (turn ended)");
  });
  test("a timeout → fail-closed (no response), NOT you — even if an optionId were present", () => {
    expect(gateDenyReason(null, true)).toBe("fail-closed (no response in 5m)");
    expect(gateDenyReason("exec:deny", true)).toBe("fail-closed (no response in 5m)");
  });
});
