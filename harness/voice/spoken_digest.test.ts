// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/spoken_digest.test.ts - P-VOICE.6: the slow-engine spoken digest prompt.
// The contract that matters: the digest is written for the EAR (the system prompt carries the
// no-lists/no-paths/three-sentence rules), long input is clipped head+tail (conclusion + verification
// survive, tool noise in the middle goes), and the thresholds keep short replies off the round-trip.

import { describe, expect, test } from "bun:test";
import { DIGEST_INPUT_CAP, DIGEST_MIN_CHARS, digestSpokenReply } from "./spoken_digest.ts";

describe("digestSpokenReply", () => {
  test("system prompt carries the ear-writing rules", () => {
    const { system } = digestSpokenReply("some reply");
    expect(system).toContain("three short sentences");
    expect(system).toContain("no lists");
    expect(system).toContain("file paths");
    expect(system).toContain("never say you are summarizing");
  });

  test("short input passes through untouched", () => {
    const text = "I fixed the bug. Tests are green.";
    expect(digestSpokenReply(text).user).toBe(text);
  });

  test("oversized input is clipped head plus tail with an elision marker", () => {
    const head = "CONCLUSION-FIRST ".repeat(400);
    const tail = "VERIFIED-AT-END ".repeat(400);
    const middle = "tool noise ".repeat(2000);
    const { user } = digestSpokenReply(head + middle + tail);
    expect(user.length).toBeLessThanOrEqual(DIGEST_INPUT_CAP + 10); // marker allowance
    expect(user.startsWith("CONCLUSION-FIRST")).toBe(true);
    expect(user.endsWith("VERIFIED-AT-END ".trim())).toBe(true);
    expect(user).toContain("[...]");
  });

  test("thresholds are coherent: the skip floor is far below the input cap", () => {
    expect(DIGEST_MIN_CHARS).toBeGreaterThan(100);
    expect(DIGEST_MIN_CHARS).toBeLessThan(DIGEST_INPUT_CAP / 10);
  });
});
