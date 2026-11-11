// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/stop_guard.test.ts - P-STOP-GUARD.1 (ADR-0555): a press aimed at Send never cancels the
// turn that started under it.

import { describe, expect, test } from "bun:test";
import { STOP_ARM_MS, stopClickIntent } from "./stop_guard.ts";

const SHOWN = 1_000_000;

describe("stopClickIntent", () => {
  test("the second click of a double click on Send does not stop the turn the first click started", () => {
    expect(stopClickIntent({ streaming: true, stopShownAt: SHOWN, pressedAt: SHOWN + 180, now: SHOWN + 260 })).toBe("send");
  });

  test("a press that began on Send is not a Stop, however late the click lands", () => {
    // A held prompt released while the button was already held down: the face changed under the pointer.
    expect(stopClickIntent({ streaming: true, stopShownAt: SHOWN, pressedAt: SHOWN - 40, now: SHOWN + 5_000 })).toBe("send");
  });

  test("a deliberate Stop once the face has been showing for the arm time stops the turn", () => {
    expect(stopClickIntent({ streaming: true, stopShownAt: SHOWN, pressedAt: SHOWN + STOP_ARM_MS, now: SHOWN + STOP_ARM_MS + 90 })).toBe("stop");
    expect(stopClickIntent({ streaming: true, stopShownAt: SHOWN, pressedAt: SHOWN + STOP_ARM_MS - 1, now: SHOWN + STOP_ARM_MS + 90 })).toBe("send");
  });

  test("a keyboard press has no pointer time and is judged at the click", () => {
    expect(stopClickIntent({ streaming: true, stopShownAt: SHOWN, pressedAt: null, now: SHOWN + 100 })).toBe("send");
    expect(stopClickIntent({ streaming: true, stopShownAt: SHOWN, pressedAt: null, now: SHOWN + 2_000 })).toBe("stop");
  });

  test("with no turn running the button is Send", () => {
    expect(stopClickIntent({ streaming: false, stopShownAt: SHOWN, pressedAt: SHOWN + 5_000, now: SHOWN + 5_100 })).toBe("send");
  });

  test("an unreadable clock never authorizes a Stop", () => {
    expect(stopClickIntent({ streaming: true, stopShownAt: Number.NaN, pressedAt: SHOWN, now: SHOWN })).toBe("send");
  });
});
