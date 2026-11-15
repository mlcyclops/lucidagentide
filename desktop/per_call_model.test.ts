// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/per_call_model.test.ts - P-MODEL.11 (ADR-0602): the per-call model policy is clamped, never widened.

import { describe, expect, test } from "bun:test";
import { parsePerCallModelSetting, perCallModelOverlayYaml, resolvePerCallModel } from "./per_call_model.ts";

const free = { asksageLocked: false, models: undefined };

describe("resolvePerCallModel", () => {
  test("the stored choice stands when nothing restricts models", () => {
    expect(resolvePerCallModel("on", free)).toEqual({ stored: "on", effective: "on", clamp: null });
    expect(resolvePerCallModel("eval", free)).toEqual({ stored: "eval", effective: "eval", clamp: null });
  });

  test("AskSage lockdown turns it off and keeps the stored choice", () => {
    expect(resolvePerCallModel("on", { asksageLocked: true, models: undefined })).toEqual({ stored: "on", effective: "off", clamp: "asksage-lockdown" });
  });

  test("any managed model restriction turns it off; an empty policy does not", () => {
    for (const models of [{ allowed: ["anthropic/"] }, { denied: ["deepseek"] }, { lock: true }, { asksageOnly: true }]) {
      expect(resolvePerCallModel("on", { asksageLocked: false, models })).toMatchObject({ effective: "off", clamp: "org-model-policy" });
    }
    expect(resolvePerCallModel("on", { asksageLocked: false, models: { allowed: [], denied: [" "] } }).effective).toBe("on");
  });

  test("off is never reported as clamped", () => {
    expect(resolvePerCallModel("off", { asksageLocked: true, models: { lock: true } })).toEqual({ stored: "off", effective: "off", clamp: null });
  });
});

describe("parsePerCallModelSetting", () => {
  test("unknown values read as off", () => {
    for (const v of [undefined, null, "", "ON", true, 1, "yes"]) expect(parsePerCallModelSetting(v)).toBe("off");
    expect(parsePerCallModelSetting("eval")).toBe("eval");
  });
});

describe("perCallModelOverlayYaml", () => {
  test("off is written explicitly, so a global config cannot reopen it", () => {
    expect(perCallModelOverlayYaml("off")).toMatch(/^task:\n {2}perCallModel: off$/m);
  });
});
