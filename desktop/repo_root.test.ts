// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-GATE-PATH.1 (ADR-0356). The defect these tests exist for is INVISIBLE in a dev checkout: a source
// checkout's `import.meta.dir` is a real directory, so the old source-relative derivation produced the
// right answer here and the wrong one only inside a `bun build --compile` binary, where Bun virtualizes
// import.meta to an embedded root (observed live as `B:\~BUN`). No amount of testing in this repo layout
// could have caught it. So the load-bearing test below FEEDS the resolver a virtualized source dir and
// asserts it falls through to the on-disk binary, and the source guard asserts the forbidden expression
// cannot return to the files whose paths cross a process boundary.
//
// join/dirname are INJECTED into the resolver, which is what lets these cases be pinned to one path
// flavor per test instead of inheriting the host's. ADR-0352 put this suite on Windows AND Linux CI, and
// a `"B:\\~BUN"` literal means two different things to the two platforms' `join`, so the flavor is chosen
// explicitly: posix for the general cases, win32 for the reported Windows shape.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { KEYSTONE, gatePath, gateRefusal, repoAsset, repoCandidates, resolveRepo, resolvedRepo } from "./repo_root.ts";

const px = { join: posix.join, dirname: posix.dirname };
const wx = { join: win32.join, dirname: win32.dirname };
// The shape Bun gives a compiled binary: a virtual root on no filesystem. `B:\~BUN` is the literal prefix
// from the reported v2.2.0 install ("Cannot find module 'B:\~BUN\harness\omp\security_extension.ts'").
const WIN_VIRTUAL = { sourceDir: "B:\\~BUN\\desktop", execPath: "C:\\app\\resources\\repo\\bin\\lucid-engine.exe" };
const POSIX_VIRTUAL = { sourceDir: "/$bunfs/root/desktop", execPath: "/opt/lucid/resources/repo/bin/lucid-engine" };

describe("repoCandidates", () => {
  test("source-relative is tried before the binary's own location", () => {
    // Order is load-bearing, not cosmetic: under `bun desktop/dev.ts` execPath is the BUN binary, so the
    // execPath candidate resolves to a bun install directory that can never carry the gate. Source-first
    // means the dev path is answered by the correct candidate and never has to rely on a probe rejecting
    // an unrelated directory that might, by coincidence, hold a file of the same name.
    expect(repoCandidates({ ...POSIX_VIRTUAL, ...px })).toEqual(["/$bunfs/root", "/opt/lucid/resources/repo"]);
  });
});

describe("resolveRepo", () => {
  test("THE REGRESSION (Windows shape): a virtualized source dir falls through to the on-disk binary", () => {
    // Exactly the reported failure. Before the fix, acp_backend.ts had no probe at all and handed omp
    // `B:\~BUN\harness\omp\security_extension.ts`; omp logged "Cannot find module" into its own log and
    // ran the session with NO GATE while every LUCID surface still reported healthy.
    const real = win32.join("C:\\app\\resources\\repo", ...KEYSTONE);
    const r = resolveRepo({ ...WIN_VIRTUAL, ...wx }, (p) => p === real);
    expect(r).toEqual({
      root: "C:\\app\\resources\\repo",
      proven: true,
      rejected: [win32.join("B:\\~BUN", ...KEYSTONE)],
    });
  });

  test("same fall-through on a posix compiled binary", () => {
    const real = posix.join("/opt/lucid/resources/repo", ...KEYSTONE);
    const r = resolveRepo({ ...POSIX_VIRTUAL, ...px }, (p) => p === real);
    expect(r.root).toBe("/opt/lucid/resources/repo");
    expect(r.proven).toBe(true);
  });

  test("a dev checkout is answered by the source-relative candidate, binary never consulted", () => {
    const probed: string[] = [];
    const r = resolveRepo({ sourceDir: "/repo/desktop", execPath: "/home/u/.bun/bin/bun", ...px }, (p) => {
      probed.push(p);
      return p === posix.join("/repo", ...KEYSTONE);
    });
    expect(r.root).toBe("/repo");
    expect(r.proven).toBe(true);
    expect(probed).toEqual([posix.join("/repo", ...KEYSTONE)]); // short-circuits: the bun-install candidate is never probed
  });

  test("the probe is handed the KEYSTONE path, never the bare root", () => {
    // A root-only probe would accept any directory that merely exists, which is how "resolved" and
    // "usable" drift apart. The gate file itself is the only evidence that matters.
    const seen: string[] = [];
    resolveRepo({ ...POSIX_VIRTUAL, ...px }, (p) => { seen.push(p); return false; });
    expect(seen).toEqual([posix.join("/$bunfs/root", ...KEYSTONE), posix.join("/opt/lucid/resources/repo", ...KEYSTONE)]);
    for (const p of seen) expect(p.endsWith(posix.join(...KEYSTONE))).toBe(true);
  });

  test("a throwing probe is a failed probe, not a crash and not an accepted candidate", () => {
    // An unreadable directory under an ACL throws from existsSync on some Windows configurations. That
    // must degrade to "this candidate is not it", never propagate out of resolution and never be taken
    // as a pass (the omp_bin.ts doctrine: a probe that throws is a probe that failed).
    const r = resolveRepo({ ...POSIX_VIRTUAL, ...px }, (p) => {
      if (p.startsWith("/$bunfs")) throw new Error("EPERM");
      return true;
    });
    expect(r.root).toBe("/opt/lucid/resources/repo");
    expect(r.proven).toBe(true);
  });

  test("nothing carries the gate: unproven, both probed paths named, root still nameable", () => {
    const r = resolveRepo({ ...POSIX_VIRTUAL, ...px }, () => false);
    expect(r.proven).toBe(false);
    expect(r.rejected).toEqual([posix.join("/$bunfs/root", ...KEYSTONE), posix.join("/opt/lucid/resources/repo", ...KEYSTONE)]);
    expect(r.root).toBe("/$bunfs/root"); // never empty: the caller has to NAME something while refusing
  });
});

describe("the gate contract", () => {
  test("gatePath() resolves to a file that is actually on disk in this checkout", () => {
    const gate = gatePath();
    expect(gate).not.toBeNull();
    expect(existsSync(gate!)).toBe(true);
  });

  test("every omp -e asset acp_backend names is on disk under the resolved root", () => {
    // The direct form of "the -e path exists". The asset NAMES are read out of the production source
    // rather than restated here, so adding an extension to the spawn without shipping its file fails
    // this test instead of failing at runtime as an omp log line nobody reads.
    const src = readFileSync(join(import.meta.dir, "acp_backend.ts"), "utf8");
    const named = [...src.matchAll(/repoAsset\("harness", "omp", "([^"]+)"\)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThanOrEqual(10); // the real spawn carries a dozen; a regex matching nothing must not pass
    for (const file of named) expect(existsSync(repoAsset("harness", "omp", file))).toBe(true);
  });

  test("repoAsset builds under the resolved root", () => {
    expect(repoAsset("harness", "omp", "security_extension.ts")).toBe(join(resolvedRepo().root, "harness", "omp", "security_extension.ts"));
  });

  test("the refusal NAMES every path it probed, so a broken install is diagnosable from the message", () => {
    // The failure this replaces was diagnosable only by reading omp's own log file, which no user does.
    // Whatever surface shows this string has to carry enough to act on: what was looked for, and where.
    const unproven = resolveRepo({ ...POSIX_VIRTUAL, ...px }, () => false);
    const msg = gateRefusal(unproven);
    expect(msg).toContain("fail-closed");
    for (const probed of unproven.rejected) expect(msg).toContain(probed);
  });
});

describe("the forbidden expression cannot come back", () => {
  // These four files build strings that cross a PROCESS boundary (omp `-e` arguments, a sibling checkout
  // path). Inside a compiled binary `import.meta.dir` is not a directory, so deriving a repo root from it
  // is wrong by construction here, however correct it looks in a dev checkout. harness/launcher already
  // carried the probe and worked on the very install where the engine failed; the engine did not. One
  // shared resolver is the fix, and this test is what keeps it one.
  const CROSS_PROCESS = ["acp_backend.ts", "agent_run.ts", "addon_seam.ts", join("..", "harness", "launcher", "lucid_acp.ts")];

  /** Source with comments removed. The guard is about CODE: these files deliberately QUOTE the forbidden
   *  expression in their comments to explain the bug, and a guard that cannot tell the two apart would
   *  fire on its own documentation (it did, on the first run). Mangling a `https://` inside a string
   *  literal is acceptable collateral: it cannot manufacture a `join(import.meta.dir, "..")` match. */
  const code = (file: string): string =>
    readFileSync(join(import.meta.dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

  test.each(CROSS_PROCESS)("%s derives no repo root from import.meta", (file) => {
    const src = code(file);
    expect(src).not.toMatch(/join\(\s*import\.meta\.dir\s*,\s*"\.\."/);
    expect(src).not.toMatch(/join\(\s*HERE\s*,\s*"\.\."\s*,\s*"\.\."/);
  });

  test("the comment-stripper does not simply blank the file (the guard must still be looking at code)", () => {
    // Without this, a stripper bug would make every assertion above vacuously true - the ADR-0303 trap.
    for (const file of CROSS_PROCESS) {
      const src = code(file);
      expect(src).toContain("import");
      expect(src.length).toBeGreaterThan(500);
    }
    // And it really does remove the quoting comments that broke the first run.
    expect(code("acp_backend.ts")).not.toContain("VIRTUAL embedded root");
  });

  test.each(CROSS_PROCESS)("%s resolves its paths through repo_root.ts", (file) => {
    expect(code(file)).toMatch(/from "(\.|\.\.\/\.\.\/desktop)\/repo_root\.ts"/);
  });

  test("repo_root.ts is the only production module allowed to read import.meta.dir for the root", () => {
    expect(code("repo_root.ts")).toContain("sourceDir: import.meta.dir");
  });
});
