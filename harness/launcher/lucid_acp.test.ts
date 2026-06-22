// harness/launcher/lucid_acp.test.ts
//
// P-EXT.1 (ADR-0038) — over-tests the security-bearing guarantees of the `lucid acp` launcher:
// it reproduces the EXACT gated command, and it FAIL-CLOSES (never spawns omp) when the gate is
// missing or the scanner sidecar is unreachable. Uses injected probe/spawn so no live sidecar/omp
// is needed — the launcher is structured so the gate can't be bypassed.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPENDED_POLICY,
  assets,
  buildAcpArgs,
  main,
  preflight,
  repoRoot,
  resolveOmp,
  resolveScannerEnv,
  runAcp,
  type SpawnFn,
} from "./lucid_acp.ts";
import { BUILD_POLICY, DELEGATION_POLICY } from "../prompt/assembler.ts";

const okProbe = async () => ({ ok: true });
const deadProbe = async () => ({ ok: false, reason: "scanner sidecar unavailable: exited code=1" });

/** A spawn spy that records the call and drives a fake child to the given exit code (or error). */
function spawnSpy(opts: { exit?: number; error?: Error } = {}) {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const fn: SpawnFn = (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd });
    return {
      on(ev: "exit" | "error", cb: (a: any) => void) {
        if (ev === "exit" && !opts.error) queueMicrotask(() => cb(opts.exit ?? 0));
        if (ev === "error" && opts.error) queueMicrotask(() => cb(opts.error));
      },
    };
  };
  return { fn, calls };
}

// ── command assembly ────────────────────────────────────────────────────────
test("buildAcpArgs reproduces the exact gated command (gate first, policy last)", () => {
  const a = assets("/repo");
  const args = buildAcpArgs({ gate: a.gate, asksage: a.asksage, acpConfig: a.acpConfig });
  expect(args[0]).toBe("acp");
  expect(args[1]).toBe("-e");
  expect(args[2]).toBe(a.gate); // the security gate is the FIRST -e (mandatory)
  expect(args).toContain(a.asksage);
  expect(args[args.length - 2]).toBe("--append-system-prompt");
  expect(args[args.length - 1]).toBe(APPENDED_POLICY);
  // --isolate omitted by default
  expect(args).not.toContain("--isolate");
});

test("--isolate adds the config overlay; omitted otherwise", () => {
  const a = assets("/repo");
  const withIso = buildAcpArgs({ gate: a.gate, acpConfig: a.acpConfig, isolate: true });
  expect(withIso).toContain("--isolate");
  expect(withIso).toContain(a.acpConfig);
  const noAsksage = buildAcpArgs({ gate: a.gate });
  expect(noAsksage.filter((x) => x === "-e").length).toBe(1); // gate only when asksage absent
});

test("APPENDED_POLICY is byte-identical to acp_backend's DELEGATION+BUILD order (invariant #6)", () => {
  expect(APPENDED_POLICY).toBe(`${DELEGATION_POLICY}\n\n${BUILD_POLICY}`);
  expect(APPENDED_POLICY.indexOf("<delegation>")).toBeLessThan(APPENDED_POLICY.indexOf("<build>"));
});

test("assets resolve under the repo root", () => {
  const a = assets("/repo");
  expect(a.gate.replace(/\\/g, "/")).toBe("/repo/harness/omp/security_extension.ts");
  expect(a.asksage.replace(/\\/g, "/")).toBe("/repo/harness/omp/asksage_extension.ts");
  // host-independent: repoRoot() must point at a real repo (the gate file lives under it). NOT a string
  // match on the folder name — the CI checkout dir is lowercase `lucidagentide`, case-sensitive on Linux.
  expect(existsSync(join(repoRoot(), "harness", "omp", "security_extension.ts"))).toBe(true);
});

test("resolveOmp prefers an existing LUCID_OMP_BIN and never uses a bogus one", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-"));
  try {
    const fakeOmp = join(dir, "omp");
    writeFileSync(fakeOmp, "#!/bin/sh\n");
    // an existing explicit binary wins over every fallback
    expect(resolveOmp({ LUCID_OMP_BIN: fakeOmp }, dir)).toBe(fakeOmp);
    // a NON-existent LUCID_OMP_BIN is never returned blindly — it falls through to repo/bun/PATH
    // (resolves to a real omp or the bare name, machine-dependent, but never the bogus path)
    const r = resolveOmp({ LUCID_OMP_BIN: join(dir, "nope") }, join(dir, "empty"));
    expect(r).not.toBe(join(dir, "nope"));
    expect(r.length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveScannerEnv points the scanner at the repo's on-disk sidecar (compiled-launch path)", () => {
  const env: Record<string, string | undefined> = {};
  resolveScannerEnv(env, "/repo");
  expect(env.LUCID_SCANNER_DIR!.replace(/\\/g, "/")).toBe("/repo/scanner-sidecar");
  // an already-valid SCANNER_PYTHON is left as-is (the existing file wins)
  const withPy: Record<string, string | undefined> = { SCANNER_PYTHON: __filename };
  resolveScannerEnv(withPy, "/repo");
  expect(withPy.SCANNER_PYTHON).toBe(__filename);
});

// ── fail-closed preflight ─────────────────────────────────────────────────────
test("preflight fails closed when the gate extension is missing", async () => {
  const r = await preflight({ gate: "/does/not/exist/security_extension.ts", scannerProbe: okProbe });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/gate extension missing/);
});

test("preflight fails closed when the scanner is unreachable (kill-the-sidecar)", async () => {
  // real gate path exists in this repo; only the scanner is down
  const r = await preflight({ gate: assets().gate, scannerProbe: deadProbe });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/scanner sidecar unreachable/);
});

test("preflight passes when gate present AND scanner reachable", async () => {
  const r = await preflight({ gate: assets().gate, scannerProbe: okProbe });
  expect(r.ok).toBe(true);
});

// ── runAcp: the gate cannot be bypassed ───────────────────────────────────────
test("runAcp NEVER spawns omp when the scanner is down — returns 1, no ungated agent", async () => {
  const spy = spawnSpy({ exit: 0 });
  let errOut = "";
  const code = await runAcp({ scannerProbe: deadProbe, spawnFn: spy.fn, stderr: (s) => (errOut += s) });
  expect(code).toBe(1);
  expect(spy.calls.length).toBe(0); // omp was NOT launched
  expect(errOut).toMatch(/FAIL-CLOSED/);
});

test("runAcp spawns the gated omp when preflight passes, and threads the workspace as cwd", async () => {
  const spy = spawnSpy({ exit: 0 });
  const code = await runAcp({ scannerProbe: okProbe, spawnFn: spy.fn, cwd: "/work/dir", env: {} });
  expect(code).toBe(0);
  expect(spy.calls.length).toBe(1);
  const call = spy.calls[0]!;
  expect(call.args[0]).toBe("acp");
  expect(call.args).toContain("-e");
  expect(call.args.some((a) => a.endsWith("security_extension.ts"))).toBe(true); // gate loaded
  expect(call.args[call.args.length - 1]).toBe(APPENDED_POLICY);
  expect(call.cwd).toBe("/work/dir");
});

test("runAcp returns the child's exit code, and 127 on spawn error", async () => {
  const exited = await runAcp({ scannerProbe: okProbe, spawnFn: spawnSpy({ exit: 42 }).fn, env: {} });
  expect(exited).toBe(42);
  const errored = await runAcp({ scannerProbe: okProbe, spawnFn: spawnSpy({ error: new Error("ENOENT") }).fn, stderr: () => {}, env: {} });
  expect(errored).toBe(127);
});

// ── CLI surface ───────────────────────────────────────────────────────────────
test("main rejects unknown subcommands (exit 2) and accepts --help (exit 0) without spawning", async () => {
  expect(await main(["frobnicate"])).toBe(2);
  expect(await main(["--help"])).toBe(0);
  expect(await main([])).toBe(0);
});
