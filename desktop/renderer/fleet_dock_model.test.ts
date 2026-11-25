// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/fleet_dock_model.test.ts - P-FLEET.DOCK1: the Fleet button brings a minimized grid back whichever
// view is pinned, and a lane card's transcript backfill appends only what the card does not already show.

import { describe, expect, test } from "bun:test";
import { FOLLOW_MAX, fleetButtonAction, laneBusy, pickFollows, ranTitle, seedTail, seedText, shouldFollow, turnKey, type FollowCandidate, type SeedRecord } from "./fleet_dock_model.ts";

describe("fleetButtonAction", () => {
  test("a minimized grid comes back, whichever view is pinned", () => {
    expect(fleetButtonAction({ home: "grid", grid: "minimized", orbit: false })).toBe("restore-grid");
    expect(fleetButtonAction({ home: "orbit", grid: "minimized", orbit: false })).toBe("restore-grid");
    expect(fleetButtonAction({ home: "orbit", grid: "minimized", orbit: true })).toBe("restore-grid");
  });
  test("a shown surface toggles closed, the orbit first because it covers the grid", () => {
    expect(fleetButtonAction({ home: "grid", grid: "shown", orbit: false })).toBe("close-grid");
    expect(fleetButtonAction({ home: "orbit", grid: "shown", orbit: false })).toBe("close-grid");
    expect(fleetButtonAction({ home: "orbit", grid: "none", orbit: true })).toBe("close-orbit");
    expect(fleetButtonAction({ home: "grid", grid: "shown", orbit: true })).toBe("close-orbit");
  });
  test("with nothing up, the pin decides what opens", () => {
    expect(fleetButtonAction({ home: "grid", grid: "none", orbit: false })).toBe("open-grid");
    expect(fleetButtonAction({ home: "orbit", grid: "none", orbit: false })).toBe("open-orbit");
  });
});

describe("shouldFollow", () => {
  const base = { card: true, streaming: false, promoted: false, status: "working" };
  test("a working lane the card does not stream is followed", () => {
    expect(shouldFollow(base)).toBe(true);
    expect(shouldFollow({ ...base, status: "needs-approval" })).toBe(true);
    expect(shouldFollow({ ...base, status: "awaiting-input", promoted: true })).toBe(true);
  });
  test("never while the card owns the stream, off screen, idle or stopped", () => {
    expect(shouldFollow({ ...base, streaming: true })).toBe(false);
    expect(shouldFollow({ ...base, card: false })).toBe(false);
    expect(shouldFollow({ ...base, status: "awaiting-input" })).toBe(false);
    expect(shouldFollow({ ...base, status: "stopped", promoted: true })).toBe(false);
  });
  test("laneBusy names the turn-running states", () => {
    expect(["working", "needs-approval", "awaiting-input", "starting", "error", "stopped"].filter(laneBusy)).toEqual(["working", "needs-approval"]);
  });
});

describe("pickFollows", () => {
  const c = (id: string, at: number, extra: Partial<FollowCandidate> = {}): FollowCandidate => ({ id, promoted: false, visible: false, following: false, lastActivityAt: at, ...extra });
  test("never more than the cap, two by default", () => {
    const many = Array.from({ length: 12 }, (_, i) => c(`l${i}`, i));
    expect(FOLLOW_MAX).toBe(2);
    expect(pickFollows(many).size).toBe(2);
    expect(pickFollows(many, 5).size).toBe(5);
    expect(pickFollows(many, 0).size).toBe(0);
    expect(pickFollows([c("a", 1)]).size).toBe(1);
  });
  test("the promoted lane first, then visible cards, then the most recent activity", () => {
    const lanes = [c("old-visible", 1, { visible: true }), c("newest", 99), c("promoted", 0, { promoted: true }), c("new-visible", 50, { visible: true })];
    expect([...pickFollows(lanes, 1)]).toEqual(["promoted"]);
    expect([...pickFollows(lanes, 2)].sort()).toEqual(["new-visible", "promoted"]);
    expect([...pickFollows(lanes, 3)].sort()).toEqual(["new-visible", "old-visible", "promoted"]);
    expect([...pickFollows(lanes.filter((l) => !l.visible && !l.promoted), 1)]).toEqual(["newest"]);
  });
  test("a held follow keeps its slot among equals, so it is not reopened every poll", () => {
    expect([...pickFollows([c("held", 1, { following: true }), c("fresh", 9)], 1)]).toEqual(["held"]);
    expect([...pickFollows([c("held", 1, { following: true }), c("seen", 0, { visible: true })], 1)]).toEqual(["seen"]);
  });
  test("a freed slot goes to the next in line", () => {
    const lanes = [c("a", 3, { following: true }), c("b", 2, { following: true }), c("c", 1)];
    expect([...pickFollows(lanes)].sort()).toEqual(["a", "b"]);
    expect([...pickFollows(lanes.filter((l) => l.id !== "a"))].sort()).toEqual(["b", "c"]); // a went idle
  });
});

describe("a multi-line tool title (a heredoc bash command)", () => {
  // What an older engine recorded: each title raw (`slice(0, 160)`), so the heredoc spans three lines of the block.
  const heredoc = "$ cat > /tmp/qa.mjs <<'EOF'\nconst a = 1;\nEOF";
  const tools = [{ name: "bash", detail: "$ ls" }, { name: "bash", detail: heredoc }, { name: "bash", detail: "$ cd desktop && bun test" }, { name: "read", detail: "Viewing activate state" }];
  const oldText = `[ran: $ ls]\n[ran: ${heredoc}]\n[ran: $ cd desktop && bun test]\n[ran: Viewing activate state]\nAll four checks pass.`;
  test("the card shows only the prose: every title becomes a chip, none stays as text", () => {
    expect(seedText({ role: "assistant", text: oldText, tools })).toBe("All four checks pass.");
    expect(seedText({ role: "assistant", text: oldText.replace(/\nAll four checks pass\.$/, ""), tools })).toBe(""); // tools only
  });
  test("today's engine writes each title on one line, and the card strips that too", () => {
    expect(ranTitle(heredoc)).toBe("$ cat > /tmp/qa.mjs <<'EOF' const a = 1; EOF");
    const newText = `${tools.map((t) => `[ran: ${ranTitle(t.detail)}]`).join("\n")}\nAll four checks pass.`;
    expect(seedText({ role: "assistant", text: newText, tools })).toBe("All four checks pass.");
  });
  test("the record still anchors a backfill (its key carries no fragment of the block)", () => {
    expect(seedTail([{ role: "user", text: "check it" }, { role: "assistant", text: "All four checks pass." }], [
      { role: "user", text: "check it" }, { role: "assistant", text: oldText, tools }, { role: "user", text: "next" },
    ])).toBe(2);
  });
});

describe("seedText and turnKey", () => {
  test("an assistant record drops the engine's tool-title prefix and error tail when it has chips for them", () => {
    const r: SeedRecord = { role: "assistant", text: "[ran: bash]\n[ran: edit app.py]\nFixed it.\n[turn ended in error: boom]", tools: [{ name: "bash", detail: "bash" }], error: "boom" };
    expect(seedText(r)).toBe("Fixed it.");
    expect(seedText({ role: "assistant", text: "[ran: bash]\nHi" })).toBe("[ran: bash]\nHi"); // no chips: the lines are the only record
    expect(seedText({ role: "user", text: "[ran: x]" })).toBe("[ran: x]");
  });
  test("the card's text and the recorded text key the same", () => {
    expect(turnKey("assistant", "Fixed it.")).toBe(turnKey("assistant", "[ran: bash]\n Fixed   it.\n[turn ended in error: boom]"));
    expect(turnKey("user", "look at this")).toBe(turnKey("user", "look at this\n[attached 2 images]"));
    const long = "x".repeat(200);
    expect(turnKey("user", `${long.slice(0, 140)}\u2026 [1 image, 2 files]`)).toBe(turnKey("user", long)); // a drained preview
    expect(turnKey("assistant", `${long}\u2026[truncated]`)).toBe(turnKey("assistant", long));
    expect(turnKey("user", "hi")).not.toBe(turnKey("assistant", "hi"));
  });
  test("an error-only turn has no key", () => {
    expect(turnKey("assistant", "")).toBeUndefined();
    expect(turnKey("assistant", "[turn ended in error: boom]")).toBeUndefined();
  });
});

describe("seedTail", () => {
  const u = (text: string) => ({ role: "user" as const, text });
  const a = (text: string, partial?: boolean) => ({ role: "assistant" as const, text, ...(partial ? { partial } : {}) });

  test("a blank card takes the whole transcript", () => {
    expect(seedTail([], [u("p1"), a("r1")])).toBe(0);
    expect(seedTail([], [])).toBe(0);
  });
  test("turns the card streamed itself are never appended again", () => {
    expect(seedTail([u("p1"), a("r1")], [u("p1"), a("[ran: bash]\nr1")])).toBe(2);
  });
  test("only the turns after the card's last one are new (a turn started elsewhere)", () => {
    expect(seedTail([u("p1"), a("r1")], [u("p1"), a("r1"), u("p2 from another client"), a("r2")])).toBe(2);
  });
  test("the card's own prompt whose reply is not recorded yet", () => {
    expect(seedTail([u("p1"), a("r1"), u("p2")], [u("p1"), a("r1"), u("p2")])).toBe(3);
  });
  test("a partial followed reply stands for the recorded one, which is not appended twice", () => {
    expect(seedTail([u("p1"), a("half of r1", true)], [u("p1"), a("all of r1")])).toBe(2);
    expect(seedTail([u("p1"), a("half of r1", true)], [u("p1"), a("all of r1"), u("p2"), a("r2")])).toBe(2);
  });
  test("an error-only turn pairs with the next record of its role", () => {
    expect(seedTail([u("p1"), a("")], [u("p1"), a("[turn ended in error: boom]"), u("p2")])).toBe(2);
  });
  test("a recurring short reply anchors on the occurrence whose previous turn matches", () => {
    const seed = [u("p1"), a("Done."), u("p2 from another client"), a("Done.")];
    expect(seedTail([u("p1"), a("Done.")], seed)).toBe(2);
    expect(seedTail([u("p1"), a("Done."), u("p2 from another client"), a("Done.")], seed)).toBe(4);
  });
  test("a card turn that exists only on the card does not hide new records", () => {
    expect(seedTail([u("p1"), a("r1"), u("refused prompt")], [u("p1"), a("r1"), u("p2"), a("r2")])).toBe(2);
  });
  test("a window that rolled past every card turn appends nothing rather than risk a duplicate", () => {
    expect(seedTail([u("old"), a("old reply")], [u("p9"), a("r9")])).toBeNull();
  });
  test("the window's first record anchors even with no turn before it", () => {
    expect(seedTail([u("p0"), a("r0"), u("p1"), a("r1")], [a("r1"), u("p2"), a("r2")])).toBe(1);
  });
});
