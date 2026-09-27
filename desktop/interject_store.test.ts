// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/interject_store.test.ts - P-INTERJECT.1: queue discipline for mid-turn operator notes.

import { beforeEach, describe, expect, test } from "bun:test";
import { __resetInterjects, addInterject, addPeerNote, awaitPeerReply, drainInterjects, drainPeerNotes, pendingInterjectCount } from "./interject_store.ts";

beforeEach(() => __resetInterjects());

// P-OWN.1: peer notes are a separate queue with the same discipline; a waiter consumes exactly one.
describe("peer notes", () => {
  test("queue and drain FIFO, separately from operator notes", () => {
    addInterject("lane-b", "operator says hi");
    expect(addPeerNote("lane-b", "lane-a", "alpha", "  I am about to edit app.ts  ")).toEqual({ ok: true });
    expect(drainPeerNotes("lane-b")).toEqual([{ from: "lane-a", name: "alpha", text: "I am about to edit app.ts" }]);
    expect(drainPeerNotes("lane-b")).toEqual([]);
    expect(pendingInterjectCount("lane-b")).toBe(1); // the operator note is still there
  });

  test("refuses self, empty, over-long, and the ninth note", () => {
    expect(addPeerNote("lane-a", "lane-a", "alpha", "hello").ok).toBe(false);
    expect(addPeerNote("lane-b", "lane-a", "alpha", "   ").ok).toBe(false);
    expect(addPeerNote("lane-b", "lane-a", "alpha", "x".repeat(4001)).ok).toBe(false);
    for (let i = 0; i < 8; i++) expect(addPeerNote("lane-b", "lane-a", "alpha", `n${i}`).ok).toBe(true);
    expect(addPeerNote("lane-b", "lane-a", "alpha", "ninth").ok).toBe(false);
  });

  test("a queued matching note answers a waiter at once and leaves the queue", async () => {
    addPeerNote("lane-a", "lane-b", "beta", "take it");
    addPeerNote("lane-a", "master", "main composer", "unrelated");
    const r = await awaitPeerReply("lane-a", "lane-b", 0);
    expect(r).toEqual({ from: "lane-b", name: "beta", text: "take it" });
    expect(drainPeerNotes("lane-a")).toEqual([{ from: "master", name: "main composer", text: "unrelated" }]);
  });

  test("a note arriving while someone waits resolves the wait and is never drained again", async () => {
    const pending = awaitPeerReply("lane-a", "lane-b", 5_000);
    expect(addPeerNote("lane-a", "lane-b", "beta", "give me two minutes")).toEqual({ ok: true });
    expect(await pending).toEqual({ from: "lane-b", name: "beta", text: "give me two minutes" });
    expect(drainPeerNotes("lane-a")).toEqual([]);
  });

  test("a wait with no note times out to null; a zero timeout on an empty queue is null", async () => {
    expect(await awaitPeerReply("lane-a", "lane-b", 0)).toBeNull();
  });
});

describe("addInterject", () => {
  test("accepts a note and reports it pending", () => {
    expect(addInterject("master", "check the tests first")).toEqual({ ok: true });
    expect(pendingInterjectCount("master")).toBe(1);
  });

  test("trims the note before storing", () => {
    expect(addInterject("master", "  focus on the parser  ").ok).toBe(true);
    expect(drainInterjects("master")).toEqual(["focus on the parser"]);
  });

  test("refuses empty and whitespace-only notes", () => {
    expect(addInterject("master", "").ok).toBe(false);
    expect(addInterject("master", "   \n\t ").ok).toBe(false);
    expect(pendingInterjectCount("master")).toBe(0);
  });

  test("refuses a missing target", () => {
    const r = addInterject("  ", "hello");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("target");
  });

  test("accepts exactly 4000 chars, refuses 4001 (measured after trim)", () => {
    expect(addInterject("master", "x".repeat(4000)).ok).toBe(true);
    const over = addInterject("master", "y".repeat(4001));
    expect(over.ok).toBe(false);
    expect(over.reason).toContain("4000");
    // Surrounding whitespace does not count against the cap.
    expect(addInterject("master", `  ${"z".repeat(4000)}  `).ok).toBe(true);
    expect(pendingInterjectCount("master")).toBe(2);
  });

  test("caps pending notes at 8 per target and refuses the 9th with a reason", () => {
    for (let i = 0; i < 8; i++) expect(addInterject("lane-1", `note ${i}`).ok).toBe(true);
    const ninth = addInterject("lane-1", "one too many");
    expect(ninth.ok).toBe(false);
    expect(ninth.reason).toBeTruthy();
    expect(pendingInterjectCount("lane-1")).toBe(8);
    // Another target is unaffected by lane-1's full queue.
    expect(addInterject("lane-2", "still room here").ok).toBe(true);
  });
});

describe("drainInterjects", () => {
  test("returns notes FIFO and clears the queue", () => {
    addInterject("master", "first");
    addInterject("master", "second");
    expect(drainInterjects("master")).toEqual(["first", "second"]);
    expect(pendingInterjectCount("master")).toBe(0);
    expect(drainInterjects("master")).toEqual([]);
  });

  test("draining frees capacity for new notes", () => {
    for (let i = 0; i < 8; i++) addInterject("master", `note ${i}`);
    expect(addInterject("master", "refused").ok).toBe(false);
    drainInterjects("master");
    expect(addInterject("master", "accepted again").ok).toBe(true);
  });

  test("per-target isolation: draining one target leaves the others untouched", () => {
    addInterject("master", "for the master");
    addInterject("lane-a", "for lane a");
    addInterject("lane-b", "for lane b");
    expect(drainInterjects("lane-a")).toEqual(["for lane a"]);
    expect(pendingInterjectCount("master")).toBe(1);
    expect(pendingInterjectCount("lane-b")).toBe(1);
    expect(drainInterjects("master")).toEqual(["for the master"]);
    expect(drainInterjects("lane-b")).toEqual(["for lane b"]);
  });

  test("unknown target drains to an empty list", () => {
    expect(drainInterjects("never-seen")).toEqual([]);
  });
});
