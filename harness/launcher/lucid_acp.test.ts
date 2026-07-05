// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

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
  buildTuiArgs,
  main,
  preflight,
  repoRoot,
  resolveOmp,
  resolveScannerEnv,
  runAcp,
  runTui,
  type SpawnFn,
} from "./lucid_acp.ts";
import { BUILD_POLICY, DELEGATION_POLICY } from "../prompt/assembler.ts";
import { BwrapBackend, NoopBackend, type BackendResolution } from "../runs/sandbox_exec.ts";

const okProbe = async () => ({ ok: true });
const deadProbe = async () => ({ ok: false, reason: "scanner sidecar unavailable: exited code=1" });
// P-SANDBOX.1 (ADR-0157): hermetic sandbox resolutions so spawn-shape assertions never depend on the
// HOST platform/PATH (a Linux machine with bwrap installed would otherwise wrap the argv).
const NOOP_SANDBOX: BackendResolution = { ok: true, backend: new NoopBackend(), disclosed: true };
const BWRAP_SANDBOX: BackendResolution = { ok: true, backend: new BwrapBackend(() => true), disclosed: false };
const REFUSED_SANDBOX: BackendResolution = { ok: false, reason: "managed policy requires runtime isolation, but no sandbox backend exists for win32 yet (P-SANDBOX.4)" };

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
  const code = await runAcp({ scannerProbe: okProbe, spawnFn: spy.fn, cwd: "/work/dir", env: {}, sandbox: NOOP_SANDBOX, stderr: () => {} });
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
  const exited = await runAcp({ scannerProbe: okProbe, spawnFn: spawnSpy({ exit: 42 }).fn, env: {}, sandbox: NOOP_SANDBOX, stderr: () => {} });
  expect(exited).toBe(42);
  const errored = await runAcp({ scannerProbe: okProbe, spawnFn: spawnSpy({ error: new Error("ENOENT") }).fn, stderr: () => {}, env: {}, sandbox: NOOP_SANDBOX });
  expect(errored).toBe(127);
});

// -- P-SANDBOX.1 (ADR-0157): the runtime execution boundary at THE spawn --
test("managed require-isolation with no backend FAIL-CLOSES the launch - never an unisolated spawn", async () => {
  const spy = spawnSpy({ exit: 0 });
  let errOut = "";
  const code = await runAcp({ scannerProbe: okProbe, spawnFn: spy.fn, env: {}, sandbox: REFUSED_SANDBOX, stderr: (s) => (errOut += s) });
  expect(code).toBe(1);
  expect(spy.calls.length).toBe(0); // omp was NOT launched
  expect(errOut).toMatch(/FAIL-CLOSED/);
  expect(errOut).toMatch(/runtime isolation/);
});

test("the disclosed passthrough spawns the UNCHANGED argv and prints the loud disclosure line", async () => {
  const spy = spawnSpy({ exit: 0 });
  let errOut = "";
  const code = await runAcp({ scannerProbe: okProbe, spawnFn: spy.fn, cwd: "/work/dir", env: {}, sandbox: NOOP_SANDBOX, stderr: (s) => (errOut += s) });
  expect(code).toBe(0);
  expect(spy.calls[0]!.args[0]).toBe("acp"); // argv identical to the ungated-of-sandbox shape
  expect(errOut).toMatch(/NOT runtime-isolated/);
  expect(errOut).toMatch(/ADR-0157/);
});

test("an isolating backend WRAPS the spawn: cmd becomes bwrap, the omp argv preserved after --", async () => {
  const spy = spawnSpy({ exit: 0 });
  const code = await runAcp({ scannerProbe: okProbe, spawnFn: spy.fn, cwd: "/work/dir", env: {}, sandbox: BWRAP_SANDBOX, stderr: () => {} });
  expect(code).toBe(0);
  const call = spy.calls[0]!;
  expect(call.cmd).toBe("bwrap");
  const sep = call.args.indexOf("--");
  expect(sep).toBeGreaterThan(0);
  expect(call.args[sep + 2]).toBe("acp"); // [omp, "acp", ...] preserved verbatim
  expect(call.args).not.toContain("--unshare-net"); // trusted-local session keeps network (proxy = P-SANDBOX.2)
});

// ── CLI surface ───────────────────────────────────────────────────────────────
test("main rejects unknown subcommands (exit 2) and accepts --help (exit 0) without spawning", async () => {
  expect(await main(["frobnicate"])).toBe(2);
  expect(await main(["--help"])).toBe(0);
  expect(await main([])).toBe(0);
});

// ── lucid tui: the gated native terminal UI ──────────────────────────────────
test("buildTuiArgs reproduces the gated command WITHOUT the acp subcommand (gate first, passthru last)", () => {
  const a = assets("/repo");
  const args = buildTuiArgs({ gate: a.gate, asksage: a.asksage, passthru: ["--model", "haiku", "-p", "hi"] });
  expect(args).not.toContain("acp"); // native TUI, not the ACP stdio passthrough
  expect(args[0]).toBe("-e");
  expect(args[1]).toBe(a.gate); // the security gate is the FIRST -e (mandatory)
  expect(args).toContain(a.asksage);
  const p = args.indexOf("--append-system-prompt");
  expect(args[p + 1]).toBe(APPENDED_POLICY);
  expect(args.slice(-4)).toEqual(["--model", "haiku", "-p", "hi"]); // passthru appended verbatim, last
  expect(p + 1).toBeLessThan(args.length - 4); // policy comes BEFORE the passthru
});

test("buildTuiArgs omits asksage when absent and needs no passthru", () => {
  expect(buildTuiArgs({ gate: "/g/gate.ts" })).toEqual(["-e", "/g/gate.ts", "--append-system-prompt", APPENDED_POLICY]);
});

test("runTui NEVER spawns omp when the scanner is down — returns 1, no ungated terminal agent", async () => {
  const spy = spawnSpy({ exit: 0 });
  let errOut = "";
  const code = await runTui({ scannerProbe: deadProbe, spawnFn: spy.fn, stderr: (s) => (errOut += s) });
  expect(code).toBe(1);
  expect(spy.calls.length).toBe(0); // omp was NOT launched
  expect(errOut).toMatch(/FAIL-CLOSED/);
});

test("runTui fail-closes identically under managed require-isolation with no backend", async () => {
  const spy = spawnSpy({ exit: 0 });
  let errOut = "";
  const code = await runTui({ scannerProbe: okProbe, spawnFn: spy.fn, env: {}, sandbox: REFUSED_SANDBOX, stderr: (s) => (errOut += s) });
  expect(code).toBe(1);
  expect(spy.calls.length).toBe(0);
  expect(errOut).toMatch(/FAIL-CLOSED/);
});

test("runTui spawns the gated omp (native TUI, no acp) with passthru + workspace cwd", async () => {
  const spy = spawnSpy({ exit: 0 });
  const code = await runTui({ scannerProbe: okProbe, spawnFn: spy.fn, cwd: "/work/dir", passthru: ["--model", "haiku"], env: {}, sandbox: NOOP_SANDBOX, stderr: () => {} });
  expect(code).toBe(0);
  expect(spy.calls.length).toBe(1);
  const call = spy.calls[0]!;
  expect(call.args).not.toContain("acp");
  expect(call.args[0]).toBe("-e");
  expect(call.args.some((a) => a.endsWith("security_extension.ts"))).toBe(true); // gate loaded
  expect(call.args.some((a) => a.endsWith("mcp_result_gate.ts"))).toBe(true); // MCP result gate loaded too (parity with acp)
  expect(call.args).toContain("--append-system-prompt");
  expect(call.args.slice(-2)).toEqual(["--model", "haiku"]); // passthru threaded through
  expect(call.cwd).toBe("/work/dir");
});

test("runTui returns the child's exit code, and 127 on spawn error", async () => {
  const exited = await runTui({ scannerProbe: okProbe, spawnFn: spawnSpy({ exit: 7 }).fn, env: {}, sandbox: NOOP_SANDBOX, stderr: () => {} });
  expect(exited).toBe(7);
  const errored = await runTui({ scannerProbe: okProbe, spawnFn: spawnSpy({ error: new Error("ENOENT") }).fn, stderr: () => {}, env: {}, sandbox: NOOP_SANDBOX });
  expect(errored).toBe(127);
});

// ── lucid theme: the cosmetic skin -e (P-THEME.1, ADR-0160) ──────────────────
test("buildTuiArgs threads the theme -e AFTER the gate (gate first, policy after the -e block, passthru last)", () => {
  const a = assets("/repo");
  const args = buildTuiArgs({ gate: a.gate, mcpResultGate: a.mcpResultGate, asksage: a.asksage, lucidTheme: a.lucidTheme, passthru: ["-p", "hi"] });
  expect(args[0]).toBe("-e");
  expect(args[1]).toBe(a.gate); // the skin NEVER displaces the mandatory first -e
  const themeIdx = args.indexOf(a.lucidTheme);
  expect(args[themeIdx - 1]).toBe("-e");
  expect(themeIdx).toBeGreaterThan(args.indexOf(a.gate));
  expect(themeIdx).toBeGreaterThan(args.indexOf(a.mcpResultGate));
  expect(themeIdx).toBeLessThan(args.indexOf("--append-system-prompt"));
  expect(args.slice(-2)).toEqual(["-p", "hi"]);
});

test("buildTuiArgs without lucidTheme carries no theme extension (cosmetic = optional, never load-bearing)", () => {
  const a = assets("/repo");
  const args = buildTuiArgs({ gate: a.gate, asksage: a.asksage });
  expect(args.some((x) => x.endsWith("lucid_theme_extension.ts"))).toBe(false);
});

test("assets exposes the theme extension beside the gates", () => {
  expect(assets("/repo").lucidTheme).toBe("/repo/harness/omp/lucid_theme_extension.ts");
});

test("runTui loads the skin -e in the spawned argv (repo asset exists), gate still first", async () => {
  expect(existsSync(assets().lucidTheme)).toBe(true); // the bundled asset ships with the repo
  const spy = spawnSpy({ exit: 0 });
  const code = await runTui({ scannerProbe: okProbe, spawnFn: spy.fn, env: {}, sandbox: NOOP_SANDBOX, stderr: () => {} });
  expect(code).toBe(0);
  const call = spy.calls[0]!;
  expect(call.args[0]).toBe("-e");
  expect(call.args.some((x) => x.endsWith("security_extension.ts"))).toBe(true);
  expect(call.args.some((x) => x.endsWith("lucid_theme_extension.ts"))).toBe(true); // the skin rides along
  expect(call.args.indexOf(call.args.find((x) => x.endsWith("lucid_theme_extension.ts"))!)).toBeGreaterThan(call.args.indexOf(call.args.find((x) => x.endsWith("security_extension.ts"))!));
});
