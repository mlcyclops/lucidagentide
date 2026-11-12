// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-JEV.1 (ADR-0374) + P-JEV.5 (ADR-0416): the judgment-backend clamp is a sovereignty control, so it is
// pinned by tests the way the ADR-0217 model clamp is. A judgment carries session state to the judge; under
// lockdown that must never reach api.typesafe.ai, whatever the user saved. P-JEV.5 adds the default (none),
// the explicit judge chain, and the bytes omp reads (the judge ROLE, not the legacy provider key).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JEV_SELECTOR, judgeChain, judgmentOverlayYaml, NO_JUDGE_SELECTOR, parseJudgmentProvider, resolveJudgmentProvider, writeJudgmentOverlay } from "./judgment_policy.ts";

describe("resolveJudgmentProvider (P-JEV.1)", () => {
  test("lock off: the stored choice passes through unclamped", () => {
    for (const m of ["none", "auto", "typesafe", "llm"] as const) {
      expect(resolveJudgmentProvider(m, false)).toEqual({ stored: m, effective: m, clamped: false, locked: false });
    }
  });
  test("lock on: a judge-using choice is pinned to llm; the stored choice survives so lifting the lock restores it", () => {
    expect(resolveJudgmentProvider("typesafe", true)).toEqual({ stored: "typesafe", effective: "llm", clamped: true, locked: true });
    // `auto` is the dangerous one: with a saved TYPESAFE_API_KEY it routes to TypeSafe, so it clamps too.
    expect(resolveJudgmentProvider("auto", true)).toEqual({ stored: "auto", effective: "llm", clamped: true, locked: true });
  });
  test("lock on with llm already chosen is locked but not clamped (nothing was overridden)", () => {
    expect(resolveJudgmentProvider("llm", true)).toEqual({ stored: "llm", effective: "llm", clamped: false, locked: true });
  });
  test("none sends nothing anywhere, so lockdown keeps it (P-JEV.5)", () => {
    expect(resolveJudgmentProvider("none", true)).toEqual({ stored: "none", effective: "none", clamped: false, locked: true });
    expect(resolveJudgmentProvider(undefined, true).effective).toBe("none");
  });
  test("an unknown or absent stored value is the default, none: judging is opt-in, never a guess at a judge", () => {
    expect(parseJudgmentProvider(undefined)).toBe("none");
    expect(parseJudgmentProvider("TYPESAFE")).toBe("none");
    expect(parseJudgmentProvider({ mode: "typesafe" })).toBe("none");
  });
});

describe("judgeChain (P-JEV.5): the candidates omp is told, in order", () => {
  const locals = ["dgx-spark/glm-5.3-flash", "ollama/qwen3"];
  const chat = "anthropic/claude-fable-5-1";
  test("none is no judge model at all, whatever is configured", () => {
    expect(judgeChain({ effective: "none", keySet: true, locals, chatModel: chat })).toEqual([]);
  });
  test("llm: local providers first, then the chat model, never Jev", () => {
    expect(judgeChain({ effective: "llm", keySet: true, locals, chatModel: chat })).toEqual([...locals, chat]);
  });
  test("typesafe: Jev first, then the same; auto: Jev only with a saved key", () => {
    expect(judgeChain({ effective: "typesafe", keySet: false, locals, chatModel: chat })).toEqual([JEV_SELECTOR, ...locals, chat]);
    expect(judgeChain({ effective: "auto", keySet: true, locals, chatModel: chat })).toEqual([JEV_SELECTOR, ...locals, chat]);
    expect(judgeChain({ effective: "auto", keySet: false, locals, chatModel: chat })).toEqual([...locals, chat]);
  });
  test("a chat model that is itself a local provider model appears once; an unknown chat model is left out", () => {
    expect(judgeChain({ effective: "llm", keySet: false, locals, chatModel: locals[0]! })).toEqual(locals);
    expect(judgeChain({ effective: "llm", keySet: false, locals: [], chatModel: "" })).toEqual([]);
  });
});

describe("judgment overlay (the bytes omp reads)", () => {
  test("writes the judge ROLE and its fallback chain, never the legacy providers.judgmentProvider key", () => {
    const y = judgmentOverlayYaml(["typesafe/jev-latest", "dgx-spark/glm-5.3-flash", "anthropic/claude-fable-5-1"]);
    expect(y).toContain('modelRoles:\n  judge: "typesafe/jev-latest"\n');
    expect(y).toContain('fallbackChains:\n    judge: ["dgx-spark/glm-5.3-flash", "anthropic/claude-fable-5-1"]\n');
    expect(y).not.toContain("judgmentProvider");
  });
  test("an empty chain pins the role to a selector nothing matches and an EMPTY fallback chain, so omp's built-in judge defaults (@tiny -> a local model by pattern) never apply", () => {
    const y = judgmentOverlayYaml([]);
    expect(y).toContain(`judge: ${JSON.stringify(NO_JUDGE_SELECTOR)}`);
    expect(y).toContain("judge: []");
  });
  test("writeJudgmentOverlay replaces the file wholesale on every spawn", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-jev-"));
    try {
      const f = join(dir, "lucid-judgment.yml");
      writeJudgmentOverlay(f, ["typesafe/jev-latest"]);
      writeJudgmentOverlay(f, []);
      const body = readFileSync(f, "utf8");
      expect(body).toContain(NO_JUDGE_SELECTOR);
      expect(body).not.toContain("typesafe");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
