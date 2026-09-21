// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-JEV.1 (ADR-0374): the judgment-backend clamp is a sovereignty control, so it is pinned by tests the way
// the ADR-0217 model clamp is. A judgment carries session state to the judge; under lockdown that must never
// reach api.typesafe.ai, whatever the user saved.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgmentOverlayYaml, parseJudgmentProvider, resolveJudgmentProvider, writeJudgmentOverlay } from "./judgment_policy.ts";

describe("resolveJudgmentProvider (P-JEV.1)", () => {
  test("lock off: the stored choice passes through unclamped", () => {
    for (const m of ["auto", "typesafe", "llm"] as const) {
      expect(resolveJudgmentProvider(m, false)).toEqual({ stored: m, effective: m, clamped: false, locked: false });
    }
  });
  test("lock on: every choice is pinned to llm; the stored choice survives so lifting the lock restores it", () => {
    expect(resolveJudgmentProvider("typesafe", true)).toEqual({ stored: "typesafe", effective: "llm", clamped: true, locked: true });
    // `auto` is the dangerous one: with a saved TYPESAFE_API_KEY omp's auto routes to TypeSafe, so it clamps too.
    expect(resolveJudgmentProvider("auto", true)).toEqual({ stored: "auto", effective: "llm", clamped: true, locked: true });
    expect(resolveJudgmentProvider(undefined, true).effective).toBe("llm");
  });
  test("lock on with llm already chosen is locked but not clamped (nothing was overridden)", () => {
    expect(resolveJudgmentProvider("llm", true)).toEqual({ stored: "llm", effective: "llm", clamped: false, locked: true });
  });
  test("an unknown or absent stored value is omp's default, auto, never a permissive guess at typesafe", () => {
    expect(parseJudgmentProvider(undefined)).toBe("auto");
    expect(parseJudgmentProvider("TYPESAFE")).toBe("auto");
    expect(parseJudgmentProvider({ mode: "typesafe" })).toBe("auto");
  });
});

describe("judgment overlay (the bytes omp reads)", () => {
  test("names exactly the one omp setting under providers", () => {
    expect(judgmentOverlayYaml("llm")).toMatch(/^providers:\n  judgmentProvider: llm\n$/m);
    expect(judgmentOverlayYaml("typesafe")).toContain("judgmentProvider: typesafe");
  });
  test("writeJudgmentOverlay replaces the file wholesale on every spawn", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-jev-"));
    try {
      const f = join(dir, "lucid-judgment.yml");
      writeJudgmentOverlay(f, "typesafe");
      writeJudgmentOverlay(f, "llm");
      const body = readFileSync(f, "utf8");
      expect(body).toContain("judgmentProvider: llm");
      expect(body).not.toContain("typesafe");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
