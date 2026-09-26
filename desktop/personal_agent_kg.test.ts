// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-KG.3: the SERVER seam binding the agent's memory_recall / memory_retain tools to the encrypted
// personal store (desktop/personal.ts agentRecall / agentRetain).
//
// The pure decision layer is tested exhaustively in harness/personal/agent_kg.test.ts. What is tested
// HERE is the part that layer cannot see: that the seam actually reaches a real AES-256-GCM store, that a
// retained fact SURVIVES a lock/unlock cycle (the store mutates in memory and needs an explicit save(),
// which is exactly the bug that made addReportToKg lose every report it ever wrote), and that a LOCKED or
// disabled vault fails closed on both directions.
//
// The locked-vault behaviour is the load-bearing one. A read against a locked vault must not look like
// "the user has told me nothing", and a write must not look like it succeeded: either lie teaches the
// model it has memory it does not have. So `locked` is asserted explicitly, not just the absence of hits.
//
// Isolation: LUCID_PERSONAL_DIR relocates the whole encrypted artifact set and LUCID_GUI_SETTINGS_FILE
// relocates the settings file, so nothing here can touch the developer's real store.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRecall, agentRetain, enablePersonal, lockPersonal, personalStatus, setScope, setupCui, setupPersonal, unlockCui, unlockPersonal } from "./personal.ts";

const PASS = "correct-horse-battery";
const CUI_PASS = "a-distinct-cui-passphrase"; // ADR-0014: the isolated CUI store has its own key
let dir = "";
const saved = { personal: process.env.LUCID_PERSONAL_DIR, settings: process.env.LUCID_GUI_SETTINGS_FILE };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lucid-agentkg-"));
  process.env.LUCID_PERSONAL_DIR = dir;
  process.env.LUCID_GUI_SETTINGS_FILE = join(dir, "gui.json");
});
afterAll(() => {
  lockPersonal();
  for (const [k, v] of [["LUCID_PERSONAL_DIR", saved.personal], ["LUCID_GUI_SETTINGS_FILE", saved.settings]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
});

// A fact that is unambiguously findable, so a ranking miss cannot be mistaken for a storage miss.
const FACT = { kind: "preference", subject: "dark mode", text: "Prefers dark mode in every editor and terminal." };

describe("agentRetain / agentRecall against a real encrypted store", () => {
  beforeEach(() => {
    // Fresh unlocked store per test. setupPersonal refuses when one already exists, so fall back to
    // unlocking the one an earlier test created.
    enablePersonal(true);
    if (!setupPersonal(PASS).ok) unlockPersonal(PASS);
  });

  test("a vetted fact is stored, and is then RECALLABLE by query", () => {
    const w = agentRetain(FACT);
    expect(w.ok).toBe(true);
    expect(typeof w.id).toBe("string");
    expect(w.locked).toBeUndefined();

    const r = agentRecall({ query: "dark mode" });
    expect(r.ok).toBe(true);
    expect(r.locked).toBeUndefined();
    expect(r.hits!.length).toBeGreaterThan(0);
    expect(r.hits![0]!.text).toContain("dark mode");
    // An agent-written fact is never "trusted": the agent does not get to label its own input.
    expect(r.hits![0]!.trust).toBe("untrusted");
  });

  test("the fact SURVIVES a lock/unlock cycle (proves save() ran, not just an in-memory mutation)", () => {
    expect(agentRetain(FACT).ok).toBe(true);
    lockPersonal();
    expect(personalStatus().unlocked).toBe(false);
    expect(unlockPersonal(PASS).ok).toBe(true);

    const r = agentRecall({ query: "dark mode" });
    expect(r.hits!.length).toBeGreaterThan(0); // would be 0 if the store were never persisted
  });

  test("recall honors the limit cap and the kinds filter", () => {
    for (let i = 0; i < 12; i++) {
      expect(agentRetain({ kind: "preference", subject: `topic ${i}`, text: `Prefers option ${i} for topic ${i}.` }).ok).toBe(true);
    }
    expect(agentRecall({ query: "prefers", limit: 3 }).hits!.length).toBeLessThanOrEqual(3);
    // A kind nothing was stored under yields no hits, rather than falling back to everything.
    expect(agentRecall({ query: "prefers", kinds: ["goal"] }).hits!.length).toBe(0);
  });

  test("a malformed payload is REFUSED with a reason, and nothing is written", () => {
    for (const bad of [null, "a string", 42, [], {}, { kind: "preference" }, { kind: "not-a-kind", subject: "x", text: "y" }, { kind: "preference", subject: "   ", text: "y" }]) {
      const r = agentRetain(bad);
      expect(r.ok).toBe(false);
      expect(r.refused).toBeTruthy();
      expect(r.id).toBeUndefined();
    }
  });

  test("a payload-injected `scope` is IGNORED (the compartment comes from the session, not the model)", () => {
    const r = agentRetain({ ...FACT, scope: "cui" });
    expect(r.ok).toBe(true); // lands in the ACTIVE compartment (personal), not the one the payload asked for
    expect(agentRecall({ query: "dark mode" }).hits!.every((h) => h.trust === "untrusted")).toBe(true);
  });

  test("an agent may NEVER write into CUI, even with the CUI store unlocked and CUI active", () => {
    // CUI is heightened-handling data in its own isolated store with its own DEK (ADR-0014). Classifying
    // something as CUI is a call only the user may make, in the Knowledge panel. This is the REAL case:
    // the cui store is genuinely unlocked, so the refusal cannot be mistaken for the locked-vault path.
    setScope("cui");
    if (!setupCui(CUI_PASS).ok) expect(unlockCui(CUI_PASS).ok).toBe(true);
    expect(personalStatus().cuiUnlocked).toBe(true); // precondition: NOT refused merely for being locked
    try {
      const r = agentRetain(FACT);
      expect(r.ok).toBe(false);
      expect(r.locked).toBeUndefined(); // refused on POLICY, not on lock state
      expect(r.refused).toMatch(/CUI/);
      expect(r.refused).toMatch(/Knowledge panel/);
      expect(r.id).toBeUndefined();
    } finally { setScope("personal"); }
  });
});

describe("fail-closed: a LOCKED vault is distinguishable from an empty one", () => {
  beforeEach(() => {
    enablePersonal(true);
    if (!setupPersonal(PASS).ok) unlockPersonal(PASS);
    agentRetain(FACT); // there IS a stored fact, so an empty read can only mean "could not look"
    lockPersonal();
  });

  test("recall reports locked with NO hits and an actionable reason, never an empty success", () => {
    const r = agentRecall({ query: "dark mode" });
    expect(r.locked).toBe(true);
    expect(r.hits).toEqual([]);
    expect(r.reason).toMatch(/locked/i);
    // The reason must NOT read as "you have no stored facts", or the model will confidently say so.
    expect(r.reason).toMatch(/does not mean/i);
  });

  test("retain reports NOT stored, never an optimistic success", () => {
    const w = agentRetain(FACT);
    expect(w.ok).toBe(false);
    expect(w.locked).toBe(true);
    expect(w.refused).toMatch(/locked/i);
    expect(w.id).toBeUndefined();
  });
});

describe("fail-closed: personalization turned OFF", () => {
  test("both directions refuse when the feature is disabled, regardless of store state", () => {
    enablePersonal(true);
    if (!setupPersonal(PASS).ok) unlockPersonal(PASS);
    enablePersonal(false); // also drops the in-memory key

    const r = agentRecall({ query: "dark mode" });
    expect(r.locked).toBe(true);
    expect(r.hits).toEqual([]);

    const w = agentRetain(FACT);
    expect(w.ok).toBe(false);
    expect(w.locked).toBe(true);
  });
});
