// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/agent_spinup.test.ts - P-SPINUP.1 (ADR-0668): the pure parts of the spin-up walkers: the status
// lines (first line, deterministic shuffle per name, honest lines after 30 s and 90 s), name clamping, the timer
// text, the bubble width and the walk track math.

import { describe, expect, it } from "bun:test";
import { bubbleWidthFor, clampName, fmtElapsed, MIN_DUR_S, NAME_MAX, pickLine, readyLine, SLOW_MS, spinupLines, STUCK_MS, walkTrack } from "./agent_spinup.ts";

const PLAYFUL = [
  "X is getting dressed, hang on", "X is tying the headband", "X is stretching before the first task", "X is reading the folder map",
  "X is warming up the keyboard", "X is packing the tool belt", "X is finding a good desk", "X is waking up the model",
  "X is checking in with the security gate", "X is grabbing a coffee, back in a sec", "X is lacing up", "Almost there, X is on the way",
];
/** The playful part of a name's lines, with the name swapped for X (so two names compare by order alone). */
const order = (name: string): string[] => spinupLines(name).slice(1, 13).map((l) => l.replace(name, "X"));

describe("spinupLines", () => {
  it("starts with the getting-ready line and ends with the two honest lines", () => {
    const lines = spinupLines("Ada");
    expect(lines[0]).toBe("Ada is getting ready for some work");
    expect(lines.length).toBe(15);
    expect(lines[13]).toBe("Ada is taking longer than usual, still on it");
    expect(lines[14]).toBe("Ada is still starting: the machine looks busy");
  });
  it("holds every playful line once", () => {
    expect([...order("Ada")].sort()).toEqual([...PLAYFUL].sort());
  });
  it("shuffles the same way every time for one name", () => {
    expect(spinupLines("Ada")).toEqual(spinupLines("Ada"));
  });
  it("shuffles differently for different names", () => {
    expect(order("Ada")).not.toEqual(order("Lucid Docs"));
  });
  it("clamps long names in every line", () => {
    const long = "A very long agent name that keeps on going";
    const lines = spinupLines(long);
    const n = clampName(long);
    expect(lines[0]).toBe(`${n} is getting ready for some work`);
    expect(lines.every((l) => !l.includes(long))).toBe(true);
  });
});

describe("pickLine", () => {
  const lines = spinupLines("Ada");
  it("shows the first line in slot 0", () => {
    expect(pickLine(lines, 0, 0)).toBe(lines[0]!);
    expect(pickLine(lines, 0, STUCK_MS + 1)).toBe(lines[0]!);
  });
  it("cycles through the playful lines and wraps", () => {
    for (let i = 1; i <= 12; i++) expect(pickLine(lines, i, 1000)).toBe(lines[i]!);
    expect(pickLine(lines, 13, 1000)).toBe(lines[1]!);
  });
  it("never shows an honest line before 30 s", () => {
    for (let i = 0; i < 12; i++) expect(pickLine(lines, i, SLOW_MS - 1)).not.toMatch(/longer than usual|machine looks busy/);
  });
  it("interleaves the slow line every third slot after 30 s", () => {
    expect(pickLine(lines, 12, SLOW_MS)).toBe("Ada is taking longer than usual, still on it");
    expect(pickLine(lines, 13, SLOW_MS)).toBe(lines[1]!);
  });
  it("says the machine looks busy after 90 s", () => {
    expect(pickLine(lines, 36, STUCK_MS)).toBe("Ada is still starting: the machine looks busy");
    expect(pickLine(lines, 37, STUCK_MS)).toBe(lines[1]!);
  });
  it("falls back to the first line for a short list", () => {
    expect(pickLine(["only"], 5, 0)).toBe("only");
    expect(pickLine([], 5, 0)).toBe("");
  });
});

describe("names and text", () => {
  it("clamps names to NAME_MAX with an ellipsis", () => {
    const n = clampName("x".repeat(40));
    expect(n.length).toBe(NAME_MAX);
    expect(n.endsWith("\u2026")).toBe(true);
    expect(clampName("Ada")).toBe("Ada");
    expect(clampName("  Ada   Lovelace ")).toBe("Ada Lovelace");
    expect(clampName("   ")).toBe("Agent");
  });
  it("says ready with the clamped name", () => {
    expect(readyLine("Ada")).toBe("Ada is ready");
  });
  it("formats the elapsed timer", () => {
    expect(fmtElapsed(0)).toBe("0:00");
    expect(fmtElapsed(7400)).toBe("0:07");
    expect(fmtElapsed(92_000)).toBe("1:32");
    expect(fmtElapsed(-5)).toBe("0:00");
    expect(fmtElapsed(Number.NaN)).toBe("0:00");
  });
  it("sizes the bubble to the composer", () => {
    expect(bubbleWidthFor(300)).toBe(210);
    expect(bubbleWidthFor(1000)).toBe(400);
    expect(bubbleWidthFor(100)).toBe(160);
  });
});

describe("walkTrack", () => {
  it("insets the walk by half the bubble so it never leaves the track", () => {
    expect(walkTrack(700, 280, 25, 32)).toEqual({ inset: 146, run: 408, dur: 25.5 });
  });
  it("insets by half the walker when the bubble is narrower", () => {
    expect(walkTrack(60, 0, 25, 32)).toEqual({ inset: 18.5, run: 23, dur: MIN_DUR_S });
  });
  it("never runs a negative distance on a short track", () => {
    expect(walkTrack(100, 280, 25, 32)).toEqual({ inset: 146, run: 0, dur: MIN_DUR_S });
  });
  it("falls back to the default speed and tolerates garbage", () => {
    expect(walkTrack(400, 0, 25, 0)).toEqual({ inset: 18.5, run: 363, dur: 22.69 });
    expect(walkTrack(Number.NaN, Number.NaN, Number.NaN)).toEqual({ inset: 6, run: 0, dur: MIN_DUR_S });
  });
});
