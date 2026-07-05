// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pnvim1.ts
//
// P-NVIM.1 (ADR-0150): the Neovim + terminal integration for the gated agent. Proves, without a live
// model: (1) `lucid tui` assembles the SAME gated command as `lucid acp` minus the `acp` subcommand
// (gate first, policy present, passthru last); (2) it FAIL-CLOSES — a dead scanner makes `runTui`
// return non-zero and NEVER spawn omp (never an ungated terminal agent); (3) a passing preflight spawns
// the gated omp in the workspace cwd; (4) the Neovim plugin's pure helpers pass a headless `nvim -l`
// assertion (skipped with a note if nvim isn't installed).
//
// Run: bun run harness/scripts/demo_pnvim1.ts

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPENDED_POLICY, assets, buildTuiArgs, runTui, type SpawnFn } from "../launcher/lucid_acp.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};
const ok = (m: string): void => console.log(`   ok — ${m}`);

const okProbe = async () => ({ ok: true });
const deadProbe = async () => ({ ok: false, reason: "scanner sidecar unavailable: exited code=1" });

/** Records spawn calls and drives a fake child to exit 0. */
function spawnSpy() {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const fn: SpawnFn = (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd });
    return {
      on(ev: "exit" | "error", cb: (a: number) => void) {
        if (ev === "exit") queueMicrotask(() => cb(0));
      },
    };
  };
  return { fn, calls };
}

console.log("1) buildTuiArgs — gated command WITHOUT `acp` (gate first, policy present, passthru last)");
{
  const a = assets("/repo");
  const args = buildTuiArgs({ gate: a.gate, asksage: a.asksage, passthru: ["--model", "claude-haiku-4-5"] });
  if (args.includes("acp")) fail("tui must NOT use the acp subcommand");
  if (args[0] !== "-e" || args[1] !== a.gate) fail("the security gate must be the first -e");
  if (!args.includes(APPENDED_POLICY)) fail("the appended policy must be present (prefix parity)");
  if (args.slice(-2).join(" ") !== "--model claude-haiku-4-5") fail("passthru must be appended last");
  ok(`-e ${a.gate.split("/").pop()} … --append-system-prompt <policy> --model claude-haiku-4-5`);
}

console.log("2) runTui FAIL-CLOSED — dead scanner ⇒ exit 1, omp NEVER spawned");
{
  const spy = spawnSpy();
  let err = "";
  const code = await runTui({ scannerProbe: deadProbe, spawnFn: spy.fn, stderr: (s) => (err += s) });
  if (code !== 1) fail(`expected exit 1, got ${code}`);
  if (spy.calls.length !== 0) fail("omp must NOT be spawned when the scanner is down");
  if (!/FAIL-CLOSED/.test(err)) fail("must announce FAIL-CLOSED");
  ok("scanner down → exit 1, zero spawns (never an ungated terminal agent)");
}

console.log("3) runTui preflight passes ⇒ spawns the gated omp in the workspace cwd");
{
  const spy = spawnSpy();
  const code = await runTui({ scannerProbe: okProbe, spawnFn: spy.fn, cwd: "/work/dir", passthru: ["-p", "hi"], env: {} });
  if (code !== 0) fail(`expected exit 0, got ${code}`);
  if (spy.calls.length !== 1) fail("expected exactly one spawn");
  const call = spy.calls[0]!;
  if (call.args.includes("acp")) fail("native TUI must not pass acp");
  if (!call.args.some((x) => x.endsWith("security_extension.ts"))) fail("the gate must be loaded");
  if (!call.args.some((x) => x.endsWith("mcp_result_gate.ts"))) fail("the MCP result gate must be loaded (parity with acp)");
  if (call.cwd !== "/work/dir") fail("workspace cwd must be threaded");
  ok(`spawned ${call.cmd.split("/").slice(-1)[0]} with the gate loaded, cwd=${call.cwd}`);
}

console.log("4) Neovim plugin pure helpers — headless nvim assertions");
{
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const pluginDir = join(repo, "extensions", "neovim");
  const spec = join(pluginDir, "test", "helpers_spec.lua");
  const hasNvim = spawnSync("nvim", ["--version"], { stdio: "ignore" }).status === 0;
  if (!hasNvim) {
    console.log("   skip — nvim not installed (the Bun suite skips this test too; install Neovim to run it)");
  } else {
    const r = spawnSync("nvim", ["--headless", "--clean", "--cmd", `set rtp^=${pluginDir}`, "-l", spec], { encoding: "utf8" });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (r.status !== 0 || !out.includes("LUCID_NVIM_OK")) fail(`headless nvim spec failed:\n${out}`);
    ok("_build_tui_args / _selection_text / _resolve_cmd (fail-closed) all pass under nvim -l");
  }
}

console.log("\ndemo_pnvim1 OK — `lucid tui` is the gated command minus `acp`, fail-closes, and the Neovim plugin helpers hold.");
process.exit(0);
