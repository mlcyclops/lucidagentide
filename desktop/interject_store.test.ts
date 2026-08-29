// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/interject_store.test.ts - P-INTERJECT.1: queue discipline for mid-turn operator notes.

import { beforeEach, describe, expect, test } from "bun:test";
import { __resetInterjects, addInterject, drainInterjects, pendingInterjectCount } from "./interject_store.ts";

beforeEach(() => __resetInterjects());

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
