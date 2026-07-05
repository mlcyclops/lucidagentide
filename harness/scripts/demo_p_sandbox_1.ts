// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_1.ts
//
// P-SANDBOX.1 (ADR-0157): the runtime execution boundary — the sandbox seam that finally makes the
// DECLARED `canNetwork` / `canExec` profile caps real at the omp spawn. Proves the load-bearing
// properties on any platform (the seam is pure; `which` is injected):
//   1. backend resolution: bwrap on Linux; the DISCLOSED passthrough elsewhere (LUCID still works);
//   2. the chooseProfile suspicious-chain downgrade now yields a GENUINELY network-denied plan
//      (--unshare-net: the DNS-TXT exfil of ADR-0157's threat model dies at the syscall);
//   3. fail-closed (invariant #3): canExec:false refuses exec; a network-off profile on a
//      passthrough refuses rather than silently running networked; managed require-isolation with
//      no backend refuses;
//   4. the managed knob rides the existing ADR-0068 channels (GPO flat value included);
//   5. the `lucid acp`/`lucid tui` launcher is WIRED: refused resolution ⇒ exit 1 + no spawn;
//      disclosed passthrough ⇒ unchanged argv + the loud line; isolating backend ⇒ wrapped argv.
//
// Run: bun run harness/scripts/demo_p_sandbox_1.ts

import {
  BwrapBackend,
  NoopBackend,
  resolveBackend,
  sandboxDisclosure,
  wrapForProfile,
  type BackendResolution,
} from "../runs/sandbox_exec.ts";
import { caps, chooseProfile } from "../runs/profiles.ts";
import { managedRequireIsolation, parseRegistryPolicy } from "../../desktop/managed_config.ts";
import { runAcp, type SpawnFn } from "../launcher/lucid_acp.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0157 P-SANDBOX.1: the runtime execution boundary (sandbox seam) ==\n");

// ── [1] backend resolution per platform ─────────────────────────────────────
console.log("[1] backend resolution — bwrap on Linux, disclosed passthrough elsewhere");
const linux = resolveBackend({ platform: "linux", which: () => true });
ok(linux.ok && linux.backend.name === "bwrap" && !linux.disclosed, "Linux with bwrap → the ISOLATING backend");
const win = resolveBackend({ platform: "win32" });
ok(win.ok && win.backend.name === "noop" && win.disclosed, "win32 → the disclosed passthrough (LUCID still functions)");
ok(sandboxDisclosure("win32").includes("NOT runtime-isolated"), "…and the disclosure line is loud + greppable");

// ── [2] the profiles.ts gap is closed ───────────────────────────────────────
console.log("\n[2] declared caps are now REAL — the suspicious-chain downgrade cuts the network");
const downgraded = chooseProfile({ requested: "trusted-local", trustLabel: "suspicious" });
ok(downgraded.profile === "container-local" && downgraded.downgraded, "suspicious causal chain auto-downgrades (as before)");
const bwrapRes: BackendResolution = { ok: true, backend: new BwrapBackend(() => true), disclosed: false };
const argv = ["/opt/omp", "acp", "-e", "/repo/gate.ts"];
const ctx = { workspace: "/work/ws", home: "/home/u" };
const denied = wrapForProfile({ argv, caps: caps(downgraded.profile), ctx, resolution: bwrapRes });
ok(denied.action === "spawn" && denied.plan.args.includes("--unshare-net"),
  "container-local under bwrap → --unshare-net: the DNS-TXT exfil fails at the syscall");
const open = wrapForProfile({ argv, caps: caps("trusted-local"), ctx, resolution: bwrapRes });
ok(open.action === "spawn" && open.plan.args.includes("--unshare-net"),
  "trusted-local with NO proxy now fails closed to --unshare-net (mediation is P-SANDBOX.2; see demo_p_sandbox_2)");
const mediated = wrapForProfile({ argv, caps: caps("trusted-local"), ctx: { ...ctx, proxy: { host: "127.0.0.1", httpPort: 8888, httpProxyUrl: "http://127.0.0.1:8888" } }, resolution: bwrapRes });
ok(mediated.action === "spawn" && !mediated.plan.args.includes("--unshare-net") && mediated.plan.env.HTTPS_PROXY === "http://127.0.0.1:8888",
  "trusted-local WITH a proxy → mediated egress (HTTP(S)_PROXY set, network kept)");

// ── [3] fail-closed rules (invariant #3) ────────────────────────────────────
console.log("\n[3] fail-closed: cannot-enforce NEVER means run-anyway");
const noopRes: BackendResolution = { ok: true, backend: new NoopBackend(), disclosed: true };
const netRefuse = wrapForProfile({ argv, caps: caps("container-local"), ctx, resolution: noopRes });
ok(netRefuse.action === "refuse", "network-off profile on a passthrough → REFUSED (never silently networked)");
for (const p of ["quarantine", "read-only-audit"] as const) {
  const d = wrapForProfile({ argv, caps: caps(p), ctx, resolution: bwrapRes });
  ok(d.action === "refuse", `${p} (canExec=false) → exec REFUSED on any backend`);
}
const required = resolveBackend({ platform: "win32", requireIsolation: true });
ok(!required.ok, "managed require-isolation with no backend → resolution REFUSED");

// ── [4] the managed knob rides the ADR-0068 channels ────────────────────────
console.log("\n[4] enterprise: security.exec.requireIsolation (tighten-only)");
const reg = [
  "HKEY_LOCAL_MACHINE\\Software\\Policies\\LucidAgentIDE",
  "    OrgName    REG_SZ    Acme Corp",
  "    ExecRequireIsolation    REG_DWORD    0x1",
].join("\r\n");
const cfg = parseRegistryPolicy(reg);
ok(managedRequireIsolation(cfg), "GPO ExecRequireIsolation=1 parses → managedRequireIsolation true");
ok(!managedRequireIsolation(null) && !managedRequireIsolation({}), "unmanaged/absent → no requirement (personal default)");

// ── [5] the launcher spawn is wired ─────────────────────────────────────────
console.log("\n[5] `lucid acp` wiring — the decision happens at THE spawn");
const okProbe = async () => ({ ok: true });
function spy() {
  const calls: { cmd: string; args: string[] }[] = [];
  const fn: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    return { on(ev: "exit" | "error", cb: (a: unknown) => void) { if (ev === "exit") setTimeout(() => cb(0), 0); } };
  };
  return { calls, fn };
}

{
  let errOut = "";
  const s = spy();
  const code = await runAcp({ scannerProbe: okProbe, spawnFn: s.fn, env: {}, stderr: (t) => (errOut += t),
    sandbox: { ok: false, reason: "managed policy requires runtime isolation, but no sandbox backend exists for win32 yet (P-SANDBOX.4)" } });
  ok(code === 1 && s.calls.length === 0 && /FAIL-CLOSED/.test(errOut),
    "refused resolution → exit 1, omp NEVER spawned, FAIL-CLOSED on stderr");
}
{
  let errOut = "";
  const s = spy();
  const code = await runAcp({ scannerProbe: okProbe, spawnFn: s.fn, env: {}, stderr: (t) => (errOut += t), sandbox: noopRes });
  ok(code === 0 && s.calls.length === 1 && s.calls[0]!.args[0] === "acp" && /NOT runtime-isolated/.test(errOut),
    "disclosed passthrough → unchanged argv + the loud disclosure line");
}
{
  const s = spy();
  const code = await runAcp({ scannerProbe: okProbe, spawnFn: s.fn, env: {}, stderr: () => {}, sandbox: bwrapRes });
  const call = s.calls[0]!;
  const sep = call.args.indexOf("--");
  ok(code === 0 && call.cmd === "bwrap" && sep > 0 && call.args[sep + 2] === "acp",
    "isolating backend → spawn wrapped in bwrap, omp argv preserved after --");
}

console.log("\n✓ P-SANDBOX.1 demo passed — the declared execution boundary is real: enforced where a backend exists, disclosed where not, refused where policy demands.");
process.exit(0);
