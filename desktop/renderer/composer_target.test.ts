// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/composer_target.test.ts - P-FLEET.L8: the pure model behind promoting a fleet lane into the
// main composer and pulling it back (target identity, badge wording, capability mask, transcript seed,
// fail-closed promotion refusals, and the provenance audit strings).

import { describe, expect, it } from "bun:test";
import {
  MASTER_TARGET, isLaneTarget, sameTarget, targetBadge, targetCaps, seedTurns,
  promoteNotice, demoteNotice, promoteRefusal, promoteAgentNote, demoteAgentNote,
  type ComposerTarget, type SeedTurn,
} from "./composer_target.ts";

const EM_DASH = "\u2014";
type Lane = Extract<ComposerTarget, { kind: "lane" }>;

function lane(over: Partial<Lane> = {}): Lane {
  return {
    kind: "lane",
    laneId: "L1",
    name: "refactor auth",
    cwd: "C:\\Users\\neorc\\Desktop\\LucidAgentIDE",
    model: "anthropic/claude-opus-5",
    ...over,
  };
}

describe("target identity (P-FLEET.L8)", () => {
  it("narrows with isLaneTarget and leaves the master target alone", () => {
    expect(isLaneTarget(MASTER_TARGET)).toBe(false);
    const t: ComposerTarget = lane();
    expect(isLaneTarget(t)).toBe(true);
    if (isLaneTarget(t)) expect(t.laneId).toBe("L1"); // the guard is what makes this compile
    expect(MASTER_TARGET.kind).toBe("master");
  });

  it("MASTER_TARGET is frozen: a shared singleton must not be retargetable", () => {
    expect(Object.isFrozen(MASTER_TARGET)).toBe(true);
  });

  it("master equals master", () => {
    expect(sameTarget(MASTER_TARGET, MASTER_TARGET)).toBe(true);
    expect(sameTarget(MASTER_TARGET, { kind: "master" })).toBe(true);
  });

  it("two lane targets are equal iff laneId matches; name/cwd/model drift does not retarget", () => {
    const a = lane();
    const b = lane({ name: "renamed", cwd: "D:/elsewhere", model: "openai/gpt-5" });
    expect(sameTarget(a, b)).toBe(true);
    expect(sameTarget(a, lane({ laneId: "L2" }))).toBe(false);
  });

  it("a lane is never the master", () => {
    expect(sameTarget(MASTER_TARGET, lane())).toBe(false);
    expect(sameTarget(lane(), MASTER_TARGET)).toBe(false);
  });
});

describe("targetBadge (P-FLEET.L8)", () => {
  it("is null for the master composer: no badge at all", () => {
    expect(targetBadge(MASTER_TARGET)).toBeNull();
  });

  it("carries the lane name and the cwd BASENAME in label, the FULL cwd and model in title", () => {
    const b = targetBadge(lane())!;
    expect(b).not.toBeNull();
    expect(b.label).toContain("refactor auth");
    expect(b.label).toContain("LucidAgentIDE");
    expect(b.label).not.toContain("C:\\Users"); // the full path would blow out the chip
    expect(b.label).not.toContain("Users");
    expect(b.title).toContain("C:\\Users\\neorc\\Desktop\\LucidAgentIDE");
    expect(b.title).toContain("anthropic/claude-opus-5");
    // The verb names the DESTINATION the user has in mind. "Back to main chat" described the wrong object
    // (it read as navigating away, not as releasing the lane), so the wording is pinned here.
    expect(b.back).toBe("Return to Fleet Agent");
    expect(b.back).toMatch(/fleet/i);
  });

  it("takes the basename from a forward-slash path and ignores trailing separators", () => {
    expect(targetBadge(lane({ cwd: "/home/neo/work/lane-a" }))!.label).toContain("lane-a");
    expect(targetBadge(lane({ cwd: "C:\\work\\lane-b\\" }))!.label).toContain("lane-b");
    expect(targetBadge(lane({ cwd: "bare" }))!.label).toContain("bare");
  });

  it("label is ONE ellipsis-safe text run: no newline, no tab, bounded length (invariant #11)", () => {
    const b = targetBadge(lane({ name: "line one\nline two\twith tab", cwd: "C:/w/proj" }))!;
    expect(b.label).not.toContain("\n");
    expect(b.label).not.toContain("\t");
    expect(b.label).toContain("line one line two with tab");

    const long = targetBadge(lane({ name: "x".repeat(300) }))!;
    expect(long.label).not.toContain("\n");
    expect(long.label.length).toBeLessThan(120);
    expect(long.title).toContain("x".repeat(300)); // the hover keeps the whole name
  });

  it("never fabricates a folder or a model: unreported fields say so", () => {
    const b = targetBadge(lane({ name: "", cwd: "", model: "" }))!;
    expect(b.label).toContain("not reported");
    expect(b.title).toContain("not reported");
    expect(b.label).toContain("L1"); // falls back to the lane id rather than showing a blank chip
  });

  it("contains no em dash", () => {
    const b = targetBadge(lane())!;
    expect(b.label).not.toContain(EM_DASH);
    expect(b.title).not.toContain(EM_DASH);
    expect(b.back).not.toContain(EM_DASH);
  });
});

describe("targetCaps (P-FLEET.L8)", () => {
  it("master is all-true with an empty why", () => {
    const c = targetCaps(MASTER_TARGET);
    expect(c).toEqual({ images: true, modes: true, goalLoop: true, slashCommands: true, why: "" });
  });

  it("a lane is all-false with a why that explains each removal", () => {
    const c = targetCaps(lane());
    expect(c.images).toBe(false);
    expect(c.modes).toBe(false);
    expect(c.goalLoop).toBe(false);
    expect(c.slashCommands).toBe(false);
    const why = c.why.toLowerCase();
    expect(why.length).toBeGreaterThan(0);
    expect(why).toContain("image");
    expect(why).toContain("mode");
    expect(why).toContain("goal loop");
    expect(why).toContain("slash command");
    expect(c.why).not.toContain(EM_DASH);
  });
});

describe("seedTurns (P-FLEET.L8)", () => {
  it("empty transcript yields an empty array", () => {
    expect(seedTurns([])).toEqual([]);
  });

  it("returns a NEW array and does not mutate the input", () => {
    const src: SeedTurn[] = [{ role: "user", text: "hi" }];
    const out = seedTurns(src);
    expect(out).not.toBe(src as unknown as SeedTurn[]);
    expect(out).toEqual([{ role: "user", text: "hi" }]);
    out.push({ role: "user", text: "mutated" });
    expect(src).toHaveLength(1);
  });

  it("drops blank entries and preserves order", () => {
    const out = seedTurns([
      { role: "user", text: "first" },
      { role: "assistant", text: "   " },
      { role: "assistant", text: "" },
      { role: "user", text: "\n\t\n" },
      { role: "assistant", text: "second" },
      { role: "user", text: "third" },
    ]);
    expect(out.map((t) => t.text)).toEqual(["first", "second", "third"]);
    expect(out.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
  });

  it("collapses [ran: x] prefix lines into ONE leading note and keeps the prose verbatim", () => {
    const out = seedTurns([{ role: "assistant", text: "[ran: read]\n[ran: edit]\nHello" }]);
    expect(out).toHaveLength(1);
    const lines = out[0]!.text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("[ran 2 tool calls: read, edit]");
    expect(lines[1]).toBe("Hello"); // prose survives byte for byte
  });

  it("keeps multi-line prose, its blank lines and its indentation verbatim", () => {
    const prose = "  indented first\n\nsecond para\ttabbed";
    const out = seedTurns([{ role: "assistant", text: `[ran: bash]\n${prose}\n` }]);
    expect(out[0]!.text.split("\n").slice(1).join("\n")).toBe(prose);
    expect(out[0]!.text.startsWith("[ran 1 tool call: bash]\n")).toBe(true);
  });

  it("counts every call but lists each distinct name once, and never reorders the names", () => {
    const out = seedTurns([{ role: "assistant", text: "[ran: read]\n[ran: read]\n[ran: edit]\ndone" }]);
    expect(out[0]!.text.split("\n")[0]).toBe("[ran 3 tool calls: read, edit]");
  });

  it("bounds the note's name list and says how many it withheld", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const out = seedTurns([{ role: "assistant", text: `${names.map((n) => `[ran: ${n}]`).join("\n")}\ndone` }]);
    expect(out[0]!.text.split("\n")[0]).toBe("[ran 10 tool calls: a, b, c, d, e, f, g, h, +2 more]");
  });

  it("handles a real folded turn: tool lines lead, the error tail stays prose", () => {
    // Shape produced by fleet_lanes.ts #foldLiveTurn.
    const raw = "[ran: bash]\n[ran: edit]\nPatched the loader.\n[turn ended in error: child exited]";
    const out = seedTurns([{ role: "assistant", text: raw }]);
    expect(out[0]!.text).toBe("[ran 2 tool calls: bash, edit]\nPatched the loader.\n[turn ended in error: child exited]");
  });

  it("names no tool it was not given, and keeps a tools-only turn", () => {
    const out = seedTurns([{ role: "assistant", text: "[ran: ]" }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("[ran 1 tool call]");
  });

  it("leaves a user turn verbatim even when it looks like a tool line", () => {
    const out = seedTurns([{ role: "user", text: "[ran: read]\nwhat did that do?" }]);
    expect(out[0]!.text).toBe("[ran: read]\nwhat did that do?");
  });

  it("leaves an assistant turn with no tool lines untouched", () => {
    const out = seedTurns([{ role: "assistant", text: "just prose" }]);
    expect(out[0]!.text).toBe("just prose");
  });

  it("emits no em dash", () => {
    const out = seedTurns([{ role: "assistant", text: "[ran: read]\n[ran: write]\nok" }]);
    expect(out[0]!.text).not.toContain(EM_DASH);
  });
});

describe("promoteRefusal (P-FLEET.L8)", () => {
  it("allows an in-flight lane: promoting a working lane is the whole point", () => {
    expect(promoteRefusal("working")).toBeNull();
  });

  it("allows awaiting-input and done", () => {
    expect(promoteRefusal("awaiting-input")).toBeNull();
    expect(promoteRefusal("done")).toBeNull();
  });

  it("refuses stopped and error with a reason naming respawn", () => {
    for (const s of ["stopped", "error"]) {
      const r = promoteRefusal(s);
      expect(r).not.toBeNull();
      expect(r!.toLowerCase()).toContain("respawn");
      expect(r).not.toContain(EM_DASH);
    }
  });

  it("refuses starting and needs-approval", () => {
    expect(promoteRefusal("starting")).not.toBeNull();
    expect(promoteRefusal("needs-approval")).not.toBeNull();
  });

  it("is FAIL-CLOSED on an unknown status: never treats unavailable as allowed", () => {
    for (const s of ["", "   ", "banana", "ok", "running", "WORKING?", "null", "undefined"]) {
      const r = promoteRefusal(s);
      expect(r).not.toBeNull();
      expect(r!.length).toBeGreaterThan(0);
      expect(r).not.toContain(EM_DASH);
    }
  });

  it("still refuses when the status is not a string at all", () => {
    expect(promoteRefusal(undefined as unknown as string)).not.toBeNull();
    expect(promoteRefusal(null as unknown as string)).not.toBeNull();
  });

  it("normalizes case and surrounding whitespace on a KNOWN status only", () => {
    expect(promoteRefusal("  Working  ")).toBeNull();
    expect(promoteRefusal("DONE")).toBeNull();
    expect(promoteRefusal("wor king")).not.toBeNull();
  });

  it("bounds a pathological status string it echoes back", () => {
    const r = promoteRefusal("z".repeat(500))!;
    expect(r).not.toBeNull();
    expect(r.length).toBeLessThan(200);
  });
});

describe("promoteNotice / demoteNotice (P-FLEET.L8)", () => {
  it("promoteNotice names the lane, folder, model and turn count", () => {
    const n = promoteNotice(lane(), 7);
    expect(n).toContain("refactor auth");
    expect(n).toContain("C:\\Users\\neorc\\Desktop\\LucidAgentIDE");
    expect(n).toContain("anthropic/claude-opus-5");
    expect(n).toContain("7 turns");
    expect(n).not.toContain(EM_DASH);
  });

  it("pluralizes a single carried turn", () => {
    expect(promoteNotice(lane(), 1)).toContain("1 turn of");
    expect(promoteNotice(lane(), 0)).toContain("0 turns");
  });

  it("never fabricates a turn count: a non-finite or negative count reads as not reported", () => {
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, -3]) {
      const s = promoteNotice(lane(), n);
      expect(s).toContain("not reported");
      expect(s).not.toContain("NaN");
      expect(s).not.toContain("Infinity");
      expect(s).not.toContain("0 turns");
    }
  });

  it("demoteNotice names the lane, folder and model, and says the lane keeps running", () => {
    const n = demoteNotice(lane());
    expect(n).toContain("refactor auth");
    expect(n).toContain("C:\\Users\\neorc\\Desktop\\LucidAgentIDE");
    expect(n).toContain("anthropic/claude-opus-5");
    expect(n.toLowerCase()).toContain("keeps running");
    expect(n).not.toContain(EM_DASH);
  });

  it("both notices are single-line audit lines with unreported fields spelled out", () => {
    const bare = lane({ name: "", cwd: "", model: "" });
    for (const s of [promoteNotice(bare, 2), demoteNotice(bare)]) {
      expect(s).not.toContain("\n");
      expect(s).toContain("not reported");
      expect(s).toContain("L1"); // the lane id is the last identity that survives
      expect(s).not.toContain(EM_DASH);
    }
  });
});

// The notes that go INTO the agent's session, as opposed to the human transcript. These exist because of
// an observed confusion: driven from the main composer for several turns and then released, the model was
// asked to "restate what was written in the main composer" and had no idea what that meant, because
// nothing had ever told it a main composer was involved. The session was always the same session; only
// the statement of WHICH SURFACE was driving it was missing.
describe("agent-facing promote/demote notes (P-FLEET.L8)", () => {
  it("promoteAgentNote names the main composer in the user's own vocabulary", () => {
    const s = promoteAgentNote(lane());
    expect(s).toMatch(/main composer/i);
    // The point of the note: the user WILL say "the main composer" next turn, so the phrase has to be in
    // the context for the model to resolve it.
    expect(s).toContain("\"the main composer\"");
    expect(s).not.toContain(EM_DASH);
  });

  it("demoteAgentNote says the lane is back on its card AND that the history is still its own", () => {
    const s = demoteAgentNote(lane());
    expect(s).toMatch(/fleet lane card/i);
    expect(s).toMatch(/same session/i); // the model must not think it lost the turns
    expect(s).not.toContain(EM_DASH);
  });

  it("both are OPERATOR notes that never read as a stop order", () => {
    for (const s of [promoteAgentNote(lane()), demoteAgentNote(lane())]) {
      expect(s).toMatch(/operator note/i);
      expect(s).toMatch(/no reply needed/i);
      // Load-bearing: an attach or release must never end the work it interrupted.
      expect(s).toMatch(/continue/i);
    }
  });

  it("both identify the lane, and report an unreported field instead of rendering a blank", () => {
    for (const s of [promoteAgentNote(lane()), demoteAgentNote(lane())]) {
      expect(s).toContain("LucidAgentIDE");
    }
    const bare = { kind: "lane" as const, laneId: "L9", name: "", cwd: "", model: "" };
    for (const s of [promoteAgentNote(bare), demoteAgentNote(bare)]) {
      expect(s).toContain("L9");
      expect(s).toContain("not reported");
    }
  });
});
