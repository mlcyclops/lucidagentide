// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { canAdoptTurn, canonicalTurnAnswer, priorTurnContext } from "./turn_restore.ts";

describe("turn recovery", () => {
  test("canonical completion replaces a longer answer polluted by connection notices", () => {
    expect(canonicalTurnAnswer("partial answer plus a long reconnect warning", "ready")).toBe("ready");
    expect(canonicalTurnAnswer("stale answer", "")).toBe("");
    expect(canonicalTurnAnswer("answer", undefined)).toBe("answer");
  });

  test("fresh boot adopts live work but not old completed history", () => {
    expect(canAdoptTurn(null)).toBe(false);
    expect(canAdoptTurn({ turnId: "current", running: true })).toBe(true);
    expect(canAdoptTurn({ turnId: "old", running: false })).toBe(false);
  });

  test("only a matching identity settles the completion race", () => {
    expect(canAdoptTurn({ turnId: "current", running: false }, "current")).toBe(true);
    expect(canAdoptTurn({ turnId: "other", running: true }, "current")).toBe(false);
    expect(canAdoptTurn({ turnId: "other", running: false }, "current")).toBe(false);
    expect(canAdoptTurn(null, "current")).toBe(false);
  });

  test("adoption keeps earlier context without duplicating the current prompt or partial answer", () => {
    const messages = [
      { role: "user", text: "earlier", turn: 1 },
      { role: "assistant", text: "earlier answer", turn: 1 },
      { role: "user", text: "continue", turn: 2 },
      { role: "assistant", text: "partial", turn: 2 },
    ];
    expect(priorTurnContext(messages, "continue")).toEqual(messages.slice(0, 2));
    expect(messages).toHaveLength(4);
    expect(messages[3].text).toBe("partial");
  });

  test("an unflushed current prompt does not remove unrelated history", () => {
    const messages = [{ role: "user", text: "previous" }, { role: "assistant", text: "answer" }];
    expect(priorTurnContext(messages, "new prompt")).toBe(messages);
    expect(priorTurnContext([], "new prompt")).toEqual([]);
  });

  test("repeated prompt text only replaces the latest matching turn", () => {
    const messages = [
      { role: "user", text: "again" }, { role: "assistant", text: "first result" },
      { role: "user", text: "again" }, { role: "assistant", text: "partial second result" },
    ];
    expect(priorTurnContext(messages, "again")).toEqual(messages.slice(0, 2));
  });
});
