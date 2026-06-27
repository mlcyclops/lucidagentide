// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for the export-toast affordance plan (increment B-KG.2, issue #115).

import { describe, expect, test } from "bun:test";
import { exportActionPlan } from "./kg_export.ts";

describe("#115 exportActionPlan — recoverable export location", () => {
  test("desktop app with a dest → Open folder + Copy path, and keep the toast up", () => {
    expect(exportActionPlan("C:/Users/me/LucidVault", true)).toEqual({ reveal: true, copy: true, persist: true });
  });

  test("browser build with a dest → Copy path only (no native reveal), still persist", () => {
    expect(exportActionPlan("/home/me/LucidVault", false)).toEqual({ reveal: false, copy: true, persist: true });
  });

  test("no dest (export failed before writing) → no actions, auto-dismiss", () => {
    expect(exportActionPlan(undefined, true)).toEqual({ reveal: false, copy: false, persist: false });
    expect(exportActionPlan(null, true)).toEqual({ reveal: false, copy: false, persist: false });
    expect(exportActionPlan("", true)).toEqual({ reveal: false, copy: false, persist: false });
  });

  test("a native shell that can reveal is irrelevant when there's nothing to reveal", () => {
    expect(exportActionPlan("", true).reveal).toBe(false);
  });
});
