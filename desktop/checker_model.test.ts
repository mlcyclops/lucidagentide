// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/checker_model.test.ts
//
// P-GOAL.6 (ADR-0048): the checker-model recommender. Verifies it picks a cheap-but-capable, recent
// model from the user's OWN accessible list, biased to their current provider family; that it ranks
// small tiers over flagship overkill and newest over old; that unusable routes (RAG/image/review) are
// excluded; and that resolveCheckerModel honors a valid override but fails safe past a stale one.

import { describe, expect, test } from "bun:test";
import { isAsksageRouted, recommendCheckerModel, resolveCheckerModel, resolveLockdownModel, type ModelOption } from "./checker_model.ts";

const opt = (value: string): ModelOption => ({ value });
// A realistic slice of the live picker (multiple providers, snapshots + aliases).
const ANTHROPIC = ["anthropic/claude-3-haiku-20240307", "anthropic/claude-3-5-haiku-latest", "anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4-5-20251001", "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-8"].map(opt);
const OPENAI = ["openai-codex/gpt-5", "openai-codex/gpt-5.4", "openai-codex/gpt-5.4-mini", "openai-codex/gpt-5.4-nano", "openai-codex/gpt-5.5", "openai-codex/codex-auto-review"].map(opt);
const ASKSAGE = ["asksage-openai/gpt-5", "asksage-openai/gpt-5-mini", "asksage-openai/gpt-o3-mini", "asksage-openai/gpt-4.1", "asksage-query/rag"].map(opt);

describe("recommendCheckerModel", () => {
  test("anthropic flagship maker → newest haiku ALIAS (not the date-pinned snapshot, not old haiku-3)", () => {
    const r = recommendCheckerModel(ANTHROPIC, "anthropic/claude-opus-4-8");
    expect(r!.value).toBe("anthropic/claude-haiku-4-5"); // tier 2, newest (4.5), clean alias
    expect(r!.why).toContain("anthropic");
  });

  test("openai maker → newest *mini* (small) over nano (weaker) and over the full gpt-5.5 (overkill)", () => {
    const r = recommendCheckerModel(OPENAI, "openai-codex/gpt-5.5");
    expect(r!.value).toBe("openai-codex/gpt-5.4-mini");
  });

  test("stays in the user's provider family — asksage maker picks an asksage mini, not anthropic", () => {
    const mixed = [...ANTHROPIC, ...ASKSAGE];
    const r = recommendCheckerModel(mixed, "asksage-openai/gpt-5");
    expect(r!.value).toBe("asksage-openai/gpt-5-mini"); // same family beats a newer anthropic haiku
  });

  test("excludes unusable routes (RAG / auto-review)", () => {
    const r = recommendCheckerModel([opt("asksage-query/rag"), opt("openai-codex/codex-auto-review"), opt("anthropic/claude-haiku-4-5")], "anthropic/claude-opus-4-8");
    expect(r!.value).toBe("anthropic/claude-haiku-4-5");
  });

  test("flagship-only list still yields a (tier-0) recommendation, never crashes", () => {
    const r = recommendCheckerModel([opt("anthropic/claude-opus-4-8"), opt("anthropic/claude-sonnet-4-6")], "anthropic/claude-opus-4-8");
    expect(r).not.toBeNull();
    expect(r!.value).toBe("anthropic/claude-sonnet-4-6"); // the cheaper/newer of the two
  });

  test("empty list ⇒ null", () => {
    expect(recommendCheckerModel([], "anthropic/claude-opus-4-8")).toBeNull();
  });
});

describe("resolveCheckerModel", () => {
  const models = ANTHROPIC;
  test("a valid explicit choice wins", () => {
    expect(resolveCheckerModel({ chosen: "anthropic/claude-sonnet-4-6", models, current: "anthropic/claude-opus-4-8" }))
      .toEqual({ value: "anthropic/claude-sonnet-4-6", source: "chosen" });
  });
  test("a stale choice (no longer accessible) falls back to the recommendation, not an error", () => {
    const r = resolveCheckerModel({ chosen: "anthropic/removed-model", models, current: "anthropic/claude-opus-4-8" });
    expect(r.source).toBe("recommended");
    expect(r.value).toBe("anthropic/claude-haiku-4-5");
  });
  test("no choice + no models ⇒ falls back to the maker model (ADR-0046 default)", () => {
    expect(resolveCheckerModel({ chosen: "", models: [], current: "anthropic/claude-opus-4-8" }))
      .toEqual({ value: "anthropic/claude-opus-4-8", source: "maker" });
  });
});

// ADR-0217: AskSage lockdown enforcement (the fail-closed model clamp).
describe("isAsksageRouted", () => {
  test("matches real gov ids that carry NO 'gov' substring (the bug the old /gov/i test missed)", () => {
    expect(isAsksageRouted("asksage-openai/gpt-5.6-luna")).toBe(true);
    expect(isAsksageRouted("asksage-anthropic/google-claude-sonnet-5")).toBe(true);
    expect(isAsksageRouted("asksage-query/rag")).toBe(true);
  });
  test("direct providers are NOT AskSage-routed", () => {
    expect(isAsksageRouted("anthropic/claude-opus-4-8")).toBe(false);
    expect(isAsksageRouted("openai-codex/gpt-5.5")).toBe(false);
  });
});

describe("resolveLockdownModel", () => {
  const values = ["anthropic/claude-opus-4-8", "asksage-openai/gpt-5.6-luna", "asksage-anthropic/google-claude-sonnet-5"];
  test("lock OFF ⇒ the current model stands, whatever it is", () => {
    expect(resolveLockdownModel(false, "anthropic/claude-opus-4-8", values)).toEqual({ ok: true, model: "anthropic/claude-opus-4-8" });
  });
  test("lock ON + already gov ⇒ keep it", () => {
    expect(resolveLockdownModel(true, "asksage-openai/gpt-5.6-luna", values)).toEqual({ ok: true, model: "asksage-openai/gpt-5.6-luna" });
  });
  test("lock ON + on a DIRECT model ⇒ switch to the first gov option (the startup/respawn bug)", () => {
    expect(resolveLockdownModel(true, "anthropic/claude-opus-4-8", values)).toEqual({ ok: true, model: "asksage-openai/gpt-5.6-luna" });
  });
  test("lock ON + NO gov model available ⇒ FAIL-CLOSED (block, never route direct)", () => {
    const r = resolveLockdownModel(true, "anthropic/claude-opus-4-8", ["anthropic/claude-opus-4-8", "openai-codex/gpt-5.5"]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/AskSage API key|lockdown/i);
  });
});
