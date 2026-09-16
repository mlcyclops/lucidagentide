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
import { bunProbeVerdict, isOmpSpawnFailure, nodeProbeVerdict, OMP_PROBE_TIMEOUT_MS, ompCandidates, ompUnavailableReport, resolveOmpBin, type OmpCandidateInput } from "./omp_bin.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    expect(r).toEqual({ bin: "/opt/omp", proven: true, rejected: [], timedOut: [] });
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
    expect(r).toEqual({ bin: "omp", proven: true, rejected: ["/home/n/.bun/bin/omp"], timedOut: [] });
  });
});

// ── P-OMP-BOOT.2 (ADR-0358): a slow probe is not a missing binary ────────────────────────────────────
//
// The REAL cause of the reported v2.2.0 outage, and the correction to ADR-0357's attribution. The
// reporting user's engine log carries 21 v2.2.0 boots from one install; exactly 10 of them decided omp
// was unrunnable and 11 did not. No missing file explains a 50% split. The probe budget was 6000 ms and
// the bundled omp is a shim over a 98 MB bun that loads a large cli.js: cold, with a real-time virus
// scanner, on a 15 W laptop, it can exceed that. The old resolver counted the timeout as a rejection and
// fell through to a bare `omp`, which on a packaged install is the one candidate guaranteed absent.
describe("a timed-out probe", () => {
  const BUNDLED = "C:/app/resources/repo/node_modules/.bin/omp.exe";

  test("is NOT a rejection: the slow candidate is used, flagged indeterminate", () => {
    const r = resolveOmpBin(input({ envBin: BUNDLED }), (c) => (c === BUNDLED ? "timeout" : false));
    expect(r.bin).toBe(BUNDLED); // the whole fix: we use it
    expect(r.proven).toBe(false); // but we do not claim we proved it
    expect(r.indeterminate).toBe(true);
    expect(r.timedOut).toEqual([BUNDLED]);
    expect(r.rejected).not.toContain(BUNDLED); // never listed as broken: it was never shown to be
  });

  test("still loses to a candidate that actually ANSWERS", () => {
    // Slowness is not preference. If something later provably runs, take that instead.
    const r = resolveOmpBin(input({ envBin: BUNDLED }), (c) => (c === BUNDLED ? "timeout" : c === "/home/n/.bun/bin/omp"));
    expect(r.bin).toBe("/home/n/.bun/bin/omp");
    expect(r.proven).toBe(true);
    expect(r.indeterminate).toBeUndefined();
    expect(r.timedOut).toEqual([BUNDLED]); // still reported, so a slow install stays diagnosable
  });

  test("the FIRST timeout wins when several are slow, preserving candidate order", () => {
    const r = resolveOmpBin(input({ envBin: BUNDLED, installed: ["/managed/omp"] }), () => "timeout");
    expect(r.bin).toBe(BUNDLED);
    expect(r.timedOut).toEqual([BUNDLED, "/managed/omp", "/home/n/.bun/bin/omp", "omp"]);
    expect(r.rejected).toEqual([]);
  });

  test("THE REGRESSION: a timeout must never degrade to the bare name", () => {
    // This is precisely what produced `Executable not found in $PATH: "omp"` 192 times in the field log:
    // the resolver discarded a real, working, installed shim in favour of a name with nothing behind it.
    const r = resolveOmpBin(input({ envBin: BUNDLED }), (c) => (c === BUNDLED ? "timeout" : false));
    expect(r.bin).not.toBe("omp");
    expect(r.bin).toBe(BUNDLED);
  });

  test("a genuine all-fail still reports not-proven with the bare name and no timeouts", () => {
    const r = resolveOmpBin(input({ envBin: BUNDLED }), () => false);
    expect(r.bin).toBe("omp");
    expect(r.proven).toBe(false);
    expect(r.indeterminate).toBeUndefined();
    expect(r.timedOut).toEqual([]);
  });
});

describe("probe verdict rules", () => {
  test("bun: exit 0 runs, non-zero fails, killed-with-no-exit is a timeout", () => {
    expect(bunProbeVerdict({ exitCode: 0 })).toBe(true);
    expect(bunProbeVerdict({ exitCode: 255 })).toBe(false); // the real "bun is not installed" exit
    expect(bunProbeVerdict({ exitCode: null, signalCode: "SIGTERM" })).toBe("timeout");
    expect(bunProbeVerdict({ exitedDueToTimeout: true, exitCode: null })).toBe("timeout");
    expect(bunProbeVerdict({ exitCode: null, signalCode: null })).toBe(false); // no signal, no exit: not a timeout claim
  });

  test("node: same rule over status/signal, plus ETIMEDOUT", () => {
    expect(nodeProbeVerdict({ status: 0 })).toBe(true);
    expect(nodeProbeVerdict({ status: 255 })).toBe(false);
    expect(nodeProbeVerdict({ status: null, signal: "SIGTERM" })).toBe("timeout");
    expect(nodeProbeVerdict({ error: { code: "ETIMEDOUT" } })).toBe("timeout");
    expect(nodeProbeVerdict({ status: null, signal: null })).toBe(false);
    expect(nodeProbeVerdict({ error: { code: "ENOENT" }, status: null })).toBe(false); // missing file is a REAL failure
  });

  test("the shared budget is well clear of a cold start (warm measured about 1.2s)", () => {
    expect(OMP_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });
});

// ── P-OMP-BOOT.1 (ADR-0357) ──────────────────────────────────────────────────────────────────────────
//
// The v2.2.0 report, whose ATTRIBUTION ADR-0358 later corrected (see the P-OMP-BOOT.2 block above:
// the outage was the 6 s probe budget, not this). `desktop/runtime.ts:findOmp()` was
// `firstExisting([bundledOmp(), ...])`, and the packaged shim always exists, so it was accepted without
// ever being run. `needsBootstrap()` therefore said there was nothing to provision, and LUCID_OMP_BIN
// was handed to every child as a path that could not execute: the bundled omp is a BUN SHIM
// (`omp.bunx` names `bun` plus a relative cli.js) and the install provided no reachable bun. That is the
// same defect this module's header describes, in a FOURTH call site upstream of the three it fixed. The
// tests below pin the two halves: the resolver can now carry main's install candidates, and the failure
// reports itself once, in words, naming every path it tried.

describe("installed candidates (Electron main's own locations)", () => {
  const BUNDLED = "C:/app/resources/repo/node_modules/.bin/omp.exe";
  const MANAGED = "C:/Users/j/AppData/Roaming/LucidAgentIDE/runtimes/bun-global/bin/omp.exe";

  test("they are probed after envBin and before the generic fallbacks", () => {
    expect(ompCandidates(input({ envBin: "/opt/omp", installed: [BUNDLED, MANAGED] })))
      .toEqual(["/opt/omp", BUNDLED, MANAGED, "/home/n/.bun/bin/omp", "omp"]);
  });

  test("null, undefined and blank entries are not candidates (main passes unresolved lookups as null)", () => {
    expect(ompCandidates(input({ installed: [null, undefined, "   ", BUNDLED] })))
      .toEqual([BUNDLED, "/home/n/.bun/bin/omp", "omp"]);
  });

  test("a duplicate is probed ONCE: main's bundled path is often also envBin", () => {
    // Without dedupe the same unrunnable shim is spawned twice per resolution, and it appears twice in
    // the rejected list, which makes the diagnostic read as if two different things were broken.
    const c = ompCandidates(input({ envBin: BUNDLED, installed: [BUNDLED, MANAGED] }));
    expect(c.filter((x) => x === BUNDLED)).toHaveLength(1);
    expect(c).toEqual([BUNDLED, MANAGED, "/home/n/.bun/bin/omp", "omp"]);
  });

  test("THE REGRESSION: a bundled shim that EXISTS but cannot run is rejected, and a managed one wins", () => {
    // Exactly the reported chain. Before the fix `findOmp()` returned BUNDLED on existence and never
    // provisioned MANAGED, so the app shipped an unrunnable path to every child for ten days.
    const r = resolveOmpBin(input({ installed: [BUNDLED, MANAGED] }), (c) => c === MANAGED);
    expect(r.bin).toBe(MANAGED);
    expect(r.proven).toBe(true);
    expect(r.rejected).toEqual([BUNDLED]);
  });

  test("nothing runnable anywhere reports UNPROVEN, which is what makes provisioning run at all", () => {
    // findOmp() returns null on !proven, so needsBootstrap() becomes true and ensureRuntimes installs.
    const r = resolveOmpBin(input({ installed: [BUNDLED, MANAGED] }), () => false);
    expect(r.proven).toBe(false);
    expect(r.rejected).toEqual([BUNDLED, MANAGED, "/home/n/.bun/bin/omp", "omp"]);
  });
});

describe("isOmpSpawnFailure", () => {
  test("recognizes the three real messages from the v2.2.0 engine log", () => {
    // Verbatim from the reported bundle. They arrive from three different layers, none of which gives us
    // a code we control, which is why this matches text.
    expect(isOmpSpawnFailure(new Error(`acp: agent process failed to start: Executable not found in $PATH: "omp"`))).toBe(true);
    expect(isOmpSpawnFailure(new Error(`ENOENT: no such file or directory, uv_spawn 'C:\\Temp\\x\\resources\\repo\\node_modules\\.bin\\omp.exe'`))).toBe(true);
    expect(isOmpSpawnFailure(new Error(`EPERM reading "C:\\Program Files\\LucidAgentIDE\\resources\\repo\\node_modules\\.bin\\omp.exe"`))).toBe(true);
  });

  test("the v2.0.0 shape too, which named the shim's TARGET rather than the shim (version.ts:394)", () => {
    expect(isOmpSpawnFailure(new Error(`EPERM reading "C:\\Program Files\\LucidAgentIDE\\resources\\repo\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js"`))).toBe(true);
  });

  test("a plain string is accepted, because not every layer throws an Error", () => {
    expect(isOmpSpawnFailure("agent process failed to start")).toBe(true);
  });

  test("an UNRELATED error is never swallowed as the known condition", () => {
    // This is the load-bearing negative: misclassifying here would hide a real internal error behind a
    // reassuring "omp cannot start" and suppress its stack trace, which is worse than the spam.
    for (const e of [
      new Error("ENOENT: no such file or directory, open '/tmp/whatever.json'"),
      new Error("DuckDB: could not acquire lock"),
      new Error("scanner sidecar timed out"),
      new Error("EPERM reading \"C:\\\\Users\\\\j\\\\.omp\\\\agent\\\\agent.db\""),
      new Error(""),
      null,
      undefined,
      { message: "agent process failed to start" }, // not an Error and not a string: not our business
    ]) expect(isOmpSpawnFailure(e)).toBe(false);
  });
});

describe("ompUnavailableReport", () => {
  test("NAMES every path tried, in order, numbered", () => {
    const r = resolveOmpBin(input({ envBin: PROGRAM_FILES }), () => false);
    const { title, detail } = ompUnavailableReport(r);
    expect(title).toContain("cannot start");
    for (const [n, c] of r.rejected.entries()) expect(detail).toContain(`${n + 1}. ${c}`);
  });

  test("carries the remedy, and never a stack trace or a credential-shaped string", () => {
    const detail = ompUnavailableReport(resolveOmpBin(input(), () => false)).detail;
    expect(detail).toContain("reinstall");
    expect(detail).toContain("bun.sh");
    expect(detail).not.toMatch(/\bat\s+\w+\s+\(/); // no stack frames: this is shown to a human in a dialog
    expect(detail).not.toMatch(/sk-|Bearer |api[_-]?key/i);
  });
});

describe("runtime.ts cannot go back to existence", () => {
  // desktop/runtime.ts imports `electron`, so it cannot be imported here. Its SOURCE is the contract.
  // Existence-based omp resolution was a real defect (ADR-0357) even though ADR-0358 later showed it was
  // not what caused the field outage, so the guard stays. The comment-stripping is the same discipline
  // as repo_root.test.ts: these files deliberately QUOTE the defect they fixed, and a guard that cannot
  // tell code from prose fires on its own documentation.
  const code = (file: string): string =>
    readFileSync(join(import.meta.dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
  const runtime = code("runtime.ts");

  test("the stripper left real code behind (not a vacuous green)", () => {
    expect(runtime).toContain("export function findOmp");
    expect(runtime.length).toBeGreaterThan(1000);
    expect(runtime).not.toContain("cold-start probe that runs out of time"); // a comment: must be gone
  });

  test("findOmp resolves through the ONE probed resolver, not firstExisting", () => {
    // firstExisting may still serve bun/uv/python; it must never again decide which omp to hand out.
    // findOmp delegates to ompResolution (P-OMP-BOOT.2 memoized it), so the guard follows the
    // delegation rather than demanding both facts live in one body.
    const body = (name: string): string =>
      new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`).exec(runtime)?.[0] ?? "";
    const findOmpBody = body("findOmp");
    const resolutionBody = body("ompResolution");
    expect(findOmpBody.length).toBeGreaterThan(20); // the regex matched something real
    expect(resolutionBody.length).toBeGreaterThan(20);
    expect(findOmpBody).not.toContain("firstExisting");
    expect(resolutionBody).not.toContain("firstExisting");
    expect(resolutionBody).toContain("resolveOmpBin");
    // And findOmp must reach the resolver, by calling it directly or via ompResolution.
    expect(/resolveOmpBin|ompResolution/.test(findOmpBody)).toBe(true);
  });

  test("an INDETERMINATE resolution is treated as usable, never as missing", () => {
    // The P-OMP-BOOT.2 correction. If findOmp returned null on a timeout, ensureRuntimes would reinstall
    // omp over a perfectly good one every time the machine was busy, and main would show the fatal
    // dialog for a laptop that was merely cold.
    const findOmpBody = new RegExp("export function findOmp\\([\\s\\S]*?\\n\\}").exec(runtime)?.[0] ?? "";
    expect(findOmpBody).toContain("indeterminate");
  });

  test("the probe budget is the shared constant, never a local 6000", () => {
    expect(runtime).toContain("OMP_PROBE_TIMEOUT_MS");
    expect(runtime).not.toMatch(/timeout:\s*6000/);
  });

  test("the PATH augmentation cannot prepend a relative dir again", () => {
    // `dirname(bun)` where bun was the bare name `"bun"` yields `"."`, and existsSync(".") is true, so
    // this prepended the CWD to the agent's PATH on every machine without bun: no bun provided, and a
    // workspace-dropped bun.exe preferred over a real one.
    expect(runtime).toContain("isAbsolute");
    expect(runtime).not.toMatch(/\[\s*dirname\(bun\)\s*,/);
  });

  test("a provisioned omp is re-PROVEN rather than assumed from its path", () => {
    expect(runtime).not.toMatch(/existsSync\(managedOmp\(\)\)\s*\?/);
  });
});
