// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/personal/agent_kg.test.ts - P-KG.3.
//
// agent_kg.ts is the whole decision layer for AGENT-initiated reads and writes of the encrypted personal
// knowledge graph, which is exactly why it is pure: every rule below is pinned with no vault, no
// passphrase, no crypto and no HTTP. If a rule here can only be exercised through a live store, it is in
// the wrong file.
//
// The load-bearing cases are the fail-closed ones, and they are the reason this file exists:
//   - a LOCKED vault yields empty reads and REFUSED writes, never a partial answer and never an
//     optimistic "stored" (that would teach the model it has memory it does not have),
//   - a suspicious/quarantined SOURCE can never write (correctness keystone #2), gated on the promotion
//     gate's OWN imported BLOCKED_TRUST set,
//   - an absent or unrecognized trust label is refused too, not treated as permissive,
//   - and a quarantined fact never comes back on READ either, so poison that predates a tightened gate
//     cannot leak into a prompt through recall.

import { describe, expect, test } from "bun:test";
import type { TrustLabel } from "../contracts.ts";
import { BLOCKED_TRUST } from "../memory/promotion_gate.ts";
import type { PersonalEntity, PersonalFact, PersonalGraph, UserKind } from "./store.ts";
import {
  AGENT_KG_KINDS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_SUBJECT_CHARS,
  MAX_TEXT_CHARS,
  normalizeKind,
  searchGraph,
  trustAdmits,
  vetAgentWrite,
} from "./agent_kg.ts";

const AT = "2026-09-01T00:00:00.000Z";

// Builders (many call sites, lockstep shape): a real PersonalEntity/PersonalFact, so the test cannot
// pass against a shape the encrypted store would reject.
const ent = (id: string, name: string, kind: UserKind, over: Partial<PersonalEntity> = {}): PersonalEntity => ({
  id, name, kind, trust_label: "trusted", confidence: 1, created_at: AT, ...over,
});
const fact = (id: string, entityId: string, statement: string, over: Partial<PersonalFact> = {}): PersonalFact => ({
  id, entity_id: entityId, statement, scope: "personal", trust_label: "trusted", confidence: 1,
  status: "active", promoted_at: AT, ...over,
});
const graph = (entities: PersonalEntity[], facts: PersonalFact[]): PersonalGraph => ({ entities, facts, links: [] });

// A minimal always-valid write payload; each test overrides only the field under test.
const GOOD = { kind: "user:preference", subject: "dark mode", text: "The user prefers dark mode." };
// Named rather than inferred so the fail-closed tests can assert a DELIBERATELY incomplete ctx (a
// missing `unlocked`, a missing `trust`) without `as never`, which is not a legal assertion here.
interface WriteCtx { trust: TrustLabel; unlocked: boolean; scope: string }
const UNLOCKED: WriteCtx = { trust: "trusted", unlocked: true, scope: "personal" };

// ── the ranked-read path ─────────────────────────────────────────────────────────────────────────────

describe("searchGraph: fail-closed on lock", () => {
  const g = graph([ent("e1", "dark mode", "user:preference")], [fact("f1", "e1", "prefers dark mode")]);

  test("ctx.unlocked === false returns [] even though a graph was handed in", () => {
    // A partial answer from a locked vault is worse than none: it looks authoritative.
    expect(searchGraph(g, { query: "dark mode" }, { unlocked: false })).toEqual([]);
  });
  test("a null/undefined graph (the locked-vault reality: nothing is decrypted) returns []", () => {
    expect(searchGraph(null, { query: "dark mode" })).toEqual([]);
    expect(searchGraph(undefined, { query: "dark mode" })).toEqual([]);
  });
  test("being handed a graph with no ctx is proof of unlock, so it still searches", () => {
    expect(searchGraph(g, { query: "dark mode" })).toHaveLength(1);
  });
  test("an empty or whitespace query returns [] rather than the whole graph", () => {
    expect(searchGraph(g, { query: "" })).toEqual([]);
    expect(searchGraph(g, { query: "   \n\t " })).toEqual([]);
  });
});

describe("searchGraph: fail-closed on trust, on the way OUT", () => {
  // One matching fact per trust label, so only the admissible ones may come back.
  const entities = [
    ent("e1", "editor", "user:preference"),
    ent("e2", "editor", "user:decision"),
    ent("e3", "editor", "user:goal"),
    ent("e4", "editor", "user:skill"),
  ];
  const facts = [
    fact("f1", "e1", "wants dark mode", { trust_label: "trusted" }),
    fact("f2", "e2", "wants dark mode", { trust_label: "untrusted" }),
    fact("f3", "e3", "wants dark mode", { trust_label: "suspicious" }),
    fact("f4", "e4", "wants dark mode", { trust_label: "quarantined" }),
  ];

  test("a quarantined fact NEVER appears in results", () => {
    const ids = searchGraph(graph(entities, facts), { query: "dark mode" }).map((h) => h.id);
    expect(ids).not.toContain("f4");
  });
  test("neither does a suspicious one; only trusted + untrusted survive (matches recall.ts)", () => {
    const hits = searchGraph(graph(entities, facts), { query: "dark mode" });
    expect(hits.map((h) => h.id).sort()).toEqual(["f1", "f2"]);
    expect(hits.every((h) => h.trust === "trusted" || h.trust === "untrusted")).toBe(true);
  });
  test("every label in the promotion gate's BLOCKED_TRUST is excluded (derived, so it cannot drift)", () => {
    for (const blocked of BLOCKED_TRUST) {
      const g = graph([ent("e1", "editor", "user:preference")],
        [fact("f1", "e1", "wants dark mode", { trust_label: blocked as TrustLabel })]);
      expect(searchGraph(g, { query: "dark mode" })).toEqual([]);
    }
  });
  test("an unrecognized label is refused too, not treated as permissive", () => {
    const g = graph([ent("e1", "editor", "user:preference")],
      [fact("f1", "e1", "wants dark mode", { trust_label: "trustworthy" as unknown as TrustLabel })]);
    expect(searchGraph(g, { query: "dark mode" })).toEqual([]);
    expect(trustAdmits("trustworthy")).toBe(false);
    expect(trustAdmits(undefined)).toBe(false);
  });
  test("a forgotten fact stays forgotten: recall must not resurrect it", () => {
    const g = graph([ent("e1", "editor", "user:preference")],
      [fact("f1", "e1", "wants dark mode", { status: "forgotten" })]);
    expect(searchGraph(g, { query: "dark mode" })).toEqual([]);
  });
});

describe("searchGraph: deterministic ranking", () => {
  // Query "dark mode": one exact phrase, one all-terms-out-of-order, one single-term partial.
  const entities = [
    ent("e1", "appearance", "user:preference"),
    ent("e2", "editor", "user:preference"),
    ent("e3", "diagrams", "user:preference"),
    ent("e4", "keyboard", "user:preference"),
  ];
  const facts = [
    fact("fA", "e1", "prefers dark mode everywhere"), //   phrase   -> 3
    fact("fB", "e2", "mode is set to dark in the editor"), // all terms -> 2
    fact("fC", "e3", "prefers dark colors in diagrams"), //  one term  -> 1.25
    fact("fD", "e4", "prefers vim keybindings"), //          no term   -> excluded
  ];
  const hits = searchGraph(graph(entities, facts), { query: "dark mode" });

  test("exact phrase beats all-terms beats any-term, and non-matches are excluded", () => {
    expect(hits.map((h) => h.id)).toEqual(["fA", "fB", "fC"]);
    expect(hits.map((h) => h.score)).toEqual([3, 2, 1.25]);
  });
  test("the any-term band can never reach the all-terms band", () => {
    const partial = hits.find((h) => h.id === "fC")!;
    expect(partial.score).toBeGreaterThan(1);
    expect(partial.score).toBeLessThan(2);
  });
  test("a phrase cannot straddle two fields (subject 'dark' + text 'mode' is not a phrase match)", () => {
    const g = graph([ent("e1", "dark", "user:preference")], [fact("f1", "e1", "mode")]);
    expect(searchGraph(g, { query: "dark mode" })[0]!.score).toBe(2); // all terms, NOT 3
  });
  test("ranking is case- and whitespace-insensitive", () => {
    const g = graph([ent("e1", "appearance", "user:preference")], [fact("f1", "e1", "Prefers  DARK   Mode")]);
    expect(searchGraph(g, { query: "dark mode" })[0]!.score).toBe(3);
  });
  test("the kind is searchable in both the bare and prefixed spelling", () => {
    const g = graph([ent("e1", "appearance", "user:decision")], [fact("f1", "e1", "irrelevant text")]);
    expect(searchGraph(g, { query: "decision" })).toHaveLength(1);
    expect(searchGraph(g, { query: "user:decision" })).toHaveLength(1);
  });
  test("ties break by confidence first, then by id ascending (never insertion order)", () => {
    const g = graph(
      [ent("e1", "a", "user:preference"), ent("e2", "b", "user:preference"), ent("e3", "c", "user:preference")],
      [
        fact("f-z", "e1", "dark mode", { confidence: 0.5 }),
        fact("f-a", "e2", "dark mode", { confidence: 0.5 }),
        fact("f-m", "e3", "dark mode", { confidence: 0.9 }),
      ],
    );
    // f-m wins on confidence despite sorting between the other two; the 0.5 pair falls back to id asc.
    expect(searchGraph(g, { query: "dark mode" }).map((h) => h.id)).toEqual(["f-m", "f-a", "f-z"]);
  });
  test("the same graph and query always yield the identical ordered array", () => {
    const g = graph(entities, facts);
    expect(searchGraph(g, { query: "dark mode" })).toEqual(searchGraph(g, { query: "dark mode" }));
  });
  test("a hit carries the fields the recall envelope needs", () => {
    const h = hits[0]!;
    expect(h).toMatchObject({ id: "fA", kind: "user:preference", subject: "appearance", trust: "trusted" });
    expect(h.text).toBe("prefers dark mode everywhere");
    expect(h.confidence).toBe(1);
  });
});

describe("searchGraph: bounds and filters", () => {
  // 30 identically-matching facts, distinct ids, so only the cap decides how many come back.
  const many = graph(
    Array.from({ length: 30 }, (_, i) => ent(`e${i}`, `subject ${i}`, "user:preference")),
    Array.from({ length: 30 }, (_, i) => fact(`f${String(i).padStart(2, "0")}`, `e${i}`, "dark mode")),
  );

  test(`a missing limit defaults to ${DEFAULT_LIMIT}`, () => {
    expect(searchGraph(many, { query: "dark mode" })).toHaveLength(DEFAULT_LIMIT);
  });
  test(`an oversized limit is hard-capped at ${MAX_LIMIT}`, () => {
    expect(searchGraph(many, { query: "dark mode", limit: 1000 })).toHaveLength(MAX_LIMIT);
  });
  test("a zero/negative limit still returns at least one hit", () => {
    expect(searchGraph(many, { query: "dark mode", limit: 0 })).toHaveLength(1);
    expect(searchGraph(many, { query: "dark mode", limit: -5 })).toHaveLength(1);
  });
  test("a garbage limit falls back to the default instead of returning everything", () => {
    expect(searchGraph(many, { query: "dark mode", limit: NaN })).toHaveLength(DEFAULT_LIMIT);
    expect(searchGraph(many, { query: "dark mode", limit: "20" as unknown as number })).toHaveLength(DEFAULT_LIMIT);
  });
  test("a fractional limit truncates rather than throwing", () => {
    expect(searchGraph(many, { query: "dark mode", limit: 3.9 })).toHaveLength(3);
  });

  const mixed = graph(
    [ent("e1", "appearance", "user:preference"), ent("e2", "runtime", "user:decision")],
    [fact("f1", "e1", "dark mode"), fact("f2", "e2", "dark mode")],
  );

  test("a kinds filter is honored, in the bare and the prefixed spelling", () => {
    expect(searchGraph(mixed, { query: "dark mode", kinds: ["preference"] }).map((h) => h.id)).toEqual(["f1"]);
    expect(searchGraph(mixed, { query: "dark mode", kinds: ["user:decision"] }).map((h) => h.id)).toEqual(["f2"]);
    expect(searchGraph(mixed, { query: "dark mode", kinds: ["preference", "decision"] })).toHaveLength(2);
  });
  test("an absent or empty kinds array means no filter", () => {
    expect(searchGraph(mixed, { query: "dark mode" })).toHaveLength(2);
    expect(searchGraph(mixed, { query: "dark mode", kinds: [] })).toHaveLength(2);
  });
  test("a filter we cannot parse matches NOTHING, rather than silently widening the answer", () => {
    expect(searchGraph(mixed, { query: "dark mode", kinds: ["nonsense"] })).toEqual([]);
  });
});

// ── the vetted-write path ────────────────────────────────────────────────────────────────────────────

describe("vetAgentWrite: fail-closed on lock", () => {
  test("a locked vault refuses, and the reason tells the agent how it gets unlocked", () => {
    const v = vetAgentWrite(GOOD, { ...UNLOCKED, unlocked: false });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toMatch(/locked/i);
    expect(v.reason).toMatch(/Knowledge panel/);
    expect(v.reason).toMatch(/nothing was stored/i); // never an optimistic success
  });
  test("a missing unlocked flag is locked, not unlocked (no permissive default)", () => {
    expect(vetAgentWrite(GOOD, { trust: "trusted", scope: "personal" } as WriteCtx).ok).toBe(false);
    expect(vetAgentWrite(GOOD, { ...UNLOCKED, unlocked: "yes" as unknown as boolean }).ok).toBe(false);
  });
});

describe("vetAgentWrite: fail-closed on trust (correctness keystone #2)", () => {
  test("every label in the imported BLOCKED_TRUST is refused, and named in the reason", () => {
    // Derived from the promotion gate's OWN set: if that set ever grows, this covers the new label too.
    expect([...BLOCKED_TRUST].sort()).toEqual(["quarantined", "suspicious"]);
    for (const blocked of BLOCKED_TRUST) {
      const v = vetAgentWrite(GOOD, { ...UNLOCKED, trust: blocked as TrustLabel });
      expect(v.ok).toBe(false);
      if (v.ok) throw new Error("unreachable");
      expect(v.reason).toContain(blocked);
      expect(v.reason).toMatch(/not stored/i);
    }
  });
  test("an absent trust label is refused fail-closed, mirroring promoteFactGated", () => {
    const v = vetAgentWrite(GOOD, { unlocked: true, scope: "personal" } as WriteCtx);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toMatch(/fail-closed/);
  });
  test("an unrecognized trust label is refused (invariant #7 is a closed set)", () => {
    for (const bogus of ["trustworthy", "TRUSTED", "", "safe"]) {
      expect(vetAgentWrite(GOOD, { ...UNLOCKED, trust: bogus as TrustLabel }).ok).toBe(false);
    }
  });
  test("the two admissible labels are accepted", () => {
    expect(vetAgentWrite(GOOD, { ...UNLOCKED, trust: "trusted" }).ok).toBe(true);
    expect(vetAgentWrite(GOOD, { ...UNLOCKED, trust: "untrusted" }).ok).toBe(true);
  });
});

describe("vetAgentWrite: compartment", () => {
  test("work and personal are writable", () => {
    expect(vetAgentWrite(GOOD, { ...UNLOCKED, scope: "work" }).ok).toBe(true);
    expect(vetAgentWrite(GOOD, { ...UNLOCKED, scope: "personal" }).ok).toBe(true);
  });
  test("an unknown compartment is refused fail-closed (no safe store to write to)", () => {
    const v = vetAgentWrite(GOOD, { ...UNLOCKED, scope: "combined" }); // a VIEW, never a stored scope
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toMatch(/fail-closed/);
    expect(vetAgentWrite(GOOD, { ...UNLOCKED, scope: "" }).ok).toBe(false);
  });
  test("cui is refused on the AGENT path: only the user may classify data as CUI (ADR-0014)", () => {
    const v = vetAgentWrite(GOOD, { ...UNLOCKED, scope: "cui" });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toMatch(/CUI/);
    expect(v.reason).toMatch(/Knowledge panel/);
  });
});

describe("vetAgentWrite: the closed kind allow-list", () => {
  test("every kind on the allow-list is accepted and returned canonicalized", () => {
    for (const kind of AGENT_KG_KINDS) {
      const v = vetAgentWrite({ ...GOOD, kind }, UNLOCKED);
      expect(v.ok).toBe(true);
      if (!v.ok) throw new Error("unreachable");
      expect(v.write.kind).toBe(kind);
    }
  });
  test("the bare form models actually emit is normalized onto the prefixed kind", () => {
    const v = vetAgentWrite({ ...GOOD, kind: "  Preference " }, UNLOCKED);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error("unreachable");
    expect(v.write.kind).toBe("user:preference");
    expect(normalizeKind("decision")).toBe("user:decision");
  });
  test("a kind off the list is refused, and the reason enumerates the allowed kinds", () => {
    for (const kind of ["user:secret", "note", "", "   ", 7, null, undefined]) {
      const v = vetAgentWrite({ ...GOOD, kind }, UNLOCKED);
      expect(v.ok).toBe(false);
      if (v.ok) throw new Error(`unreachable for ${String(kind)}`);
      expect(v.reason).toContain("user:preference"); // the agent is told what IS allowed
    }
    expect(normalizeKind("user:secret")).toBeUndefined();
  });
  test("the allow-list is exactly the store's UserKind taxonomy, with no invented kinds", () => {
    expect([...AGENT_KG_KINDS].sort()).toEqual([
      "user:behavior", "user:decision", "user:goal", "user:interest", "user:link",
      "user:personality", "user:preference", "user:relationship", "user:skill",
    ]);
  });
});

describe("vetAgentWrite: bounded, non-empty payloads", () => {
  test("an empty or whitespace-only subject is refused", () => {
    for (const subject of ["", "   ", "\n\t"]) {
      expect(vetAgentWrite({ ...GOOD, subject }, UNLOCKED).ok).toBe(false);
    }
  });
  test("an empty or whitespace-only text is refused", () => {
    for (const text of ["", "   ", "\n\t"]) {
      expect(vetAgentWrite({ ...GOOD, text }, UNLOCKED).ok).toBe(false);
    }
  });
  test("a non-string subject/text is refused rather than coerced", () => {
    expect(vetAgentWrite({ ...GOOD, subject: 42 }, UNLOCKED).ok).toBe(false);
    expect(vetAgentWrite({ ...GOOD, text: { a: 1 } }, UNLOCKED).ok).toBe(false);
  });
  test("oversized text is refused, with the limit and the actual length in the reason", () => {
    const text = "x".repeat(MAX_TEXT_CHARS + 1);
    const v = vetAgentWrite({ ...GOOD, text }, UNLOCKED);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toContain(String(MAX_TEXT_CHARS));
    expect(v.reason).toContain(String(MAX_TEXT_CHARS + 1));
    expect(vetAgentWrite({ ...GOOD, text: "x".repeat(MAX_TEXT_CHARS) }, UNLOCKED).ok).toBe(true);
  });
  test("an oversized subject is refused", () => {
    expect(vetAgentWrite({ ...GOOD, subject: "s".repeat(MAX_SUBJECT_CHARS + 1) }, UNLOCKED).ok).toBe(false);
    expect(vetAgentWrite({ ...GOOD, subject: "s".repeat(MAX_SUBJECT_CHARS) }, UNLOCKED).ok).toBe(true);
  });
  test("subject and text are returned trimmed, so the store never holds padded duplicates", () => {
    const v = vetAgentWrite({ ...GOOD, subject: "  dark mode \n", text: "  prefers it.  " }, UNLOCKED);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error("unreachable");
    expect(v.write).toEqual({ kind: "user:preference", subject: "dark mode", text: "prefers it." });
  });
  test("a non-object payload is refused (the model can send anything over JSON)", () => {
    for (const input of [null, undefined, "a string", 7, [GOOD], true]) {
      expect(vetAgentWrite(input, UNLOCKED).ok).toBe(false);
    }
  });
});

describe("vetAgentWrite: optional fields", () => {
  test("confidence is clamped into [0, 1] rather than ranking a fact above honest ones", () => {
    for (const [raw, want] of [[5, 1], [-2, 0], [0.42, 0.42], [0, 0], [1, 1]] as const) {
      const v = vetAgentWrite({ ...GOOD, confidence: raw }, UNLOCKED);
      expect(v.ok).toBe(true);
      if (!v.ok) throw new Error("unreachable");
      expect(v.write.confidence).toBe(want);
    }
  });
  test("a malformed confidence is a malformed call, so it is refused, never guessed", () => {
    for (const confidence of ["high", NaN, Infinity, {}]) {
      expect(vetAgentWrite({ ...GOOD, confidence }, UNLOCKED).ok).toBe(false);
    }
  });
  test("an omitted or null confidence is left for the store's default", () => {
    for (const confidence of [undefined, null]) {
      const v = vetAgentWrite({ ...GOOD, confidence }, UNLOCKED);
      expect(v.ok).toBe(true);
      if (!v.ok) throw new Error("unreachable");
      expect("confidence" in v.write).toBe(false);
    }
  });
  test("an entity id passes through trimmed; a blank one is dropped, not stored empty", () => {
    const withEntity = vetAgentWrite({ ...GOOD, entity: "  ent-123 " }, UNLOCKED);
    if (!withEntity.ok) throw new Error("unreachable");
    expect(withEntity.write.entity).toBe("ent-123");

    const blank = vetAgentWrite({ ...GOOD, entity: "   " }, UNLOCKED);
    if (!blank.ok) throw new Error("unreachable");
    expect("entity" in blank.write).toBe(false);
    expect(vetAgentWrite({ ...GOOD, entity: "e".repeat(MAX_SUBJECT_CHARS + 1) }, UNLOCKED).ok).toBe(false);
  });
  test("unknown extra fields are dropped: only vetted fields reach the encrypted store", () => {
    const v = vetAgentWrite({ ...GOOD, trust_label: "trusted", status: "active", id: "spoofed" }, UNLOCKED);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error("unreachable");
    expect(Object.keys(v.write).sort()).toEqual(["kind", "subject", "text"]);
  });
});

describe("the two directions agree", () => {
  test("a fact the write path would refuse on trust is also unreadable if it somehow exists", () => {
    // Belt and braces: the write gate is not the only thing standing between poison and a prompt.
    for (const blocked of BLOCKED_TRUST) {
      const label = blocked as TrustLabel;
      expect(vetAgentWrite(GOOD, { ...UNLOCKED, trust: label }).ok).toBe(false);
      expect(trustAdmits(label)).toBe(false);
    }
    expect(trustAdmits("trusted")).toBe(true);
    expect(trustAdmits("untrusted")).toBe(true);
  });
});
