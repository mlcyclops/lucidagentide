// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/omp_bin.test.ts - the OAuth EPERM defect, pinned (ADR-0330).
//
// A packaged Windows install put omp inside C:\Program Files, the resolver accepted it because the path
// EXISTED, and the OAuth broker's spawn died with Bun's own `EPERM reading ...cli.js`. Existence was never
// the question; runnability is. These tests are written against that exact failure.
//
// Reported on v2.0.0 but NOT a v2.0.0 regression: the offending resolver landed in c2d8cf9 (2026-07-15)
// and ships in every tag from v1.11.8 onward.

import { describe, expect, test } from "bun:test";
import { ompCandidates, resolveOmpBin, type OmpCandidateInput } from "./omp_bin.ts";

const posix = (...p: string[]) => p.join("/");
const input = (over: Partial<OmpCandidateInput> = {}): OmpCandidateInput =>
  ({ home: "/home/n", exeSuffix: "", join: posix, ...over });

const PROGRAM_FILES = "C:/Program Files/LucidAgentIDE/resources/repo/node_modules/.bin/omp";

describe("ompCandidates", () => {
  test("env binary first, then the user's bun bin, then the bare name", () => {
    expect(ompCandidates(input({ envBin: "/opt/omp" })))
      .toEqual(["/opt/omp", "/home/n/.bun/bin/omp", "omp"]);
  });

  test("an absent or blank env binary is simply not a candidate", () => {
    expect(ompCandidates(input())).toEqual(["/home/n/.bun/bin/omp", "omp"]);
    expect(ompCandidates(input({ envBin: "   " }))).toEqual(["/home/n/.bun/bin/omp", "omp"]);
    expect(ompCandidates(input({ envBin: undefined }))).toEqual(["/home/n/.bun/bin/omp", "omp"]);
  });

  test("the env binary is trimmed, because an env var picks up stray whitespace", () => {
    expect(ompCandidates(input({ envBin: "  /opt/omp  " }))[0]).toBe("/opt/omp");
  });

  test("the Windows suffix is applied to the bun-bin fallback", () => {
    expect(ompCandidates(input({ exeSuffix: ".exe" }))).toContain("/home/n/.bun/bin/omp.exe");
  });

  test("the bare name is ALWAYS last: it is the one candidate that cannot be an unreadable install file", () => {
    for (const over of [{}, { envBin: "/opt/omp" }, { exeSuffix: ".exe" }]) {
      const c = ompCandidates(input(over));
      expect(c[c.length - 1]).toBe("omp");
    }
  });
});

describe("resolveOmpBin", () => {
  test("THE REGRESSION: an install-dir binary that exists but cannot RUN is skipped, not returned", () => {
    // This is the reported failure. Under Program Files ACLs the spawn died with EPERM; the resolver had
    // accepted the path on existence alone. Now the probe rejects it and the next candidate wins.
    const r = resolveOmpBin(input({ envBin: PROGRAM_FILES }), (c) => c !== PROGRAM_FILES);
    expect(r.bin).toBe("/home/n/.bun/bin/omp");
    expect(r.proven).toBe(true);
    expect(r.rejected).toEqual([PROGRAM_FILES]);
  });

  test("a runnable env binary wins outright, and nothing else is probed", () => {
    const probed: string[] = [];
    const r = resolveOmpBin(input({ envBin: "/opt/omp" }), (c) => { probed.push(c); return true; });
    expect(r).toEqual({ bin: "/opt/omp", proven: true, rejected: [] });
    expect(probed).toEqual(["/opt/omp"]); // the fallbacks are never even asked
  });

  test("every candidate failing yields the bare name, flagged NOT proven, with the full attempt list", () => {
    // Deliberately not a throw: the caller's job is to report "omp is not installed or not on PATH",
    // which is a better message for a user than an exception out of a resolver.
    const r = resolveOmpBin(input({ envBin: PROGRAM_FILES }), () => false);
    expect(r.bin).toBe("omp");
    expect(r.proven).toBe(false);
    expect(r.rejected).toEqual([PROGRAM_FILES, "/home/n/.bun/bin/omp", "omp"]);
  });

  test("a THROWING probe counts as a failed probe, never as a crash", () => {
    // A probe that spawns can throw (EPERM, ENOENT, EACCES). The resolver must degrade, not propagate.
    const r = resolveOmpBin(input({ envBin: PROGRAM_FILES }), (c) => {
      if (c === PROGRAM_FILES) throw new Error("EPERM");
      return c === "/home/n/.bun/bin/omp";
    });
    expect(r.bin).toBe("/home/n/.bun/bin/omp");
    expect(r.proven).toBe(true);
  });

  test("a probe returning a truthy non-boolean is not treated as success", () => {
    // Strict === true: a probe that accidentally returns a string or an object must not authorize a spawn.
    const sloppy = ((c: string) => (c === PROGRAM_FILES ? "yes" : false)) as unknown as (c: string) => boolean;
    expect(resolveOmpBin(input({ envBin: PROGRAM_FILES }), sloppy).rejected).toContain(PROGRAM_FILES);
  });

  test("the bare name can itself be the proven answer on a dev box", () => {
    const r = resolveOmpBin(input(), (c) => c === "omp");
    expect(r).toEqual({ bin: "omp", proven: true, rejected: ["/home/n/.bun/bin/omp"] });
  });
});
