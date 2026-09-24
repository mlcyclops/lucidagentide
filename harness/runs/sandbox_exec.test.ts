// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/sandbox_exec.test.ts — P-SANDBOX.1 (ADR-0157).
//
// Over-tests the fail-closed rules of the runtime-sandbox seam (invariant #3): backend resolution
// per platform, cap→flag mapping (canNetwork:false ⇒ --unshare-net total deny), refuse-exec for
// canExec:false profiles, the managed require-isolation knob, and the "never silently networked"
// rule for network-off profiles on a passthrough backend. Hermetic: `which` is injected everywhere.

import { expect, test } from "bun:test";
import {
  appContainerArgs,
  AppContainerBackend,
  appContainerProbeArgv,
  appContainerProbePassed,
  appContainerRuntimeGrants,
  APPCONTAINER_PROBE_MARKER,
  proxyChildEnv,
  BwrapBackend,
  listingExemptsMoniker,
  NoopBackend,
  resolveBackend,
  sandboxDisclosure,
  SeatbeltBackend,
  seatbeltProfile,
  wrapForProfile,
  type BackendResolution,
} from "./sandbox_exec.ts";
import { caps, chooseProfile } from "./profiles.ts";
import { managedRequireIsolation, parseRegistryPolicy } from "../../desktop/managed_config.ts";

const hasBwrap = () => true;
const noBwrap = () => false;
// Functional probes. bwrap being ON PATH and bwrap WORKING are different facts (Ubuntu 24.04+ blocks
// unprivileged user namespaces), so every linux resolveBackend call injects both — otherwise the
// default probe shells out to the host's real bwrap and these stop being hermetic.
const bwrapWorks = () => true;
const bwrapBlocked = () => false;
const has = (bin: string) => (b: string) => b === bin; // only `bin` is on PATH
const none = () => false;
// Seatbelt functional probes: sandbox-exec being ON PATH and sandbox-exec WORKING are different facts
// (a sandboxed parent cannot nest a profile), so every darwin resolveBackend call injects both -
// otherwise the default probe shells out to the host's real sandbox-exec and these stop being hermetic.
const seatbeltWorks = () => true;
const seatbeltBlocked = () => false;
// AppContainer functional probes: the helper being present and the helper being ABLE to contain are
// different facts (profile creation or the workspace ACL grant can be refused on a host), so every
// win32 resolveBackend call injects both - otherwise the default probe shells out to the host's real
// helper and these stop being hermetic.
const acWorks = () => true;
const acBroken = () => false;
const ARGV = ["/opt/omp", "acp", "-e", "/repo/gate.ts"];
const CTX = { workspace: "/work/ws", home: "/home/u" };
const PROXY = { host: "127.0.0.1", httpPort: 8888, httpProxyUrl: "http://127.0.0.1:8888" };

// ── backend resolution ────────────────────────────────────────────────────────

test("linux with bwrap on PATH resolves the ISOLATING backend (no disclosure)", () => {
  const r = resolveBackend({ platform: "linux", which: hasBwrap, probe: bwrapWorks });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.backend.name).toBe("bwrap");
    expect(r.backend.isolates).toBe(true);
    expect(r.disclosed).toBe(false);
  }
});

test("linux WITHOUT bwrap falls back to the disclosed passthrough (personal default)", () => {
  const r = resolveBackend({ platform: "linux", which: noBwrap, probe: bwrapBlocked });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.backend.name).toBe("noop");
    expect(r.disclosed).toBe(true);
  }
});

// ── regression: bwrap present but NON-FUNCTIONAL (Ubuntu/Debian 24.04+) ──────────────────────────
// Shipped bug: `available()` probed PATH only. On 24.04 bwrap exists but AppArmor blocks unprivileged
// user namespaces, so it was chosen as the backend and then died with "setting up uid map: Permission
// denied" at every spawn — taking `omp acp` with it. No ACP session ⇒ empty configOptions ⇒ the picker
// showed only its hardcoded Anthropic fallback, so a correctly-OAuth'd OpenAI/xAI vanished silently.
test("linux with bwrap on PATH but BLOCKED userns does NOT resolve bwrap - it discloses instead", () => {
  const r = resolveBackend({ platform: "linux", which: hasBwrap, probe: bwrapBlocked });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.backend.name).toBe("noop"); // never "bwrap" — a backend that cannot spawn is not a backend
    expect(r.backend.isolates).toBe(false);
    expect(r.disclosed).toBe(true); // degraded, but DISCLOSED and the agent still runs
  }
});

test("BwrapBackend.available() requires presence AND capability", () => {
  expect(new BwrapBackend(hasBwrap, bwrapWorks).available()).toBe(true);
  expect(new BwrapBackend(hasBwrap, bwrapBlocked).available()).toBe(false); // the shipped bug
  expect(new BwrapBackend(noBwrap, bwrapWorks).available()).toBe(false);
});

test("managed require-isolation on a BLOCKED-userns host refuses with the actionable apparmor reason", () => {
  const r = resolveBackend({ platform: "linux", requireIsolation: true, which: hasBwrap, probe: bwrapBlocked });
  expect(r.ok).toBe(false); // gov/managed still fails CLOSED — degrading to passthrough is not an option
  if (!r.ok) {
    expect(r.reason).toMatch(/user namespace/);
    expect(r.reason).toMatch(/apparmor_restrict_unprivileged_userns/); // tells the admin what to actually do
    expect(r.reason).not.toMatch(/not installed/); // the old, misleading message
  }
});

test("darwin with sandbox-exec resolves the Seatbelt ISOLATING backend (P-SANDBOX.4)", () => {
  const r = resolveBackend({ platform: "darwin", which: has("sandbox-exec"), probe: seatbeltWorks });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.backend.name).toBe("seatbelt");
    expect(r.backend.isolates).toBe(true);
    expect(r.disclosed).toBe(false);
  }
});

test("win32 WITH the lucid-appcontainer helper resolves the ISOLATING AppContainer backend (P-SANDBOX.6)", () => {
  const r = resolveBackend({ platform: "win32", which: has("lucid-appcontainer"), probe: acWorks });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.backend.name).toBe("appcontainer");
    expect(r.backend.isolates).toBe(true);
    expect(r.disclosed).toBe(false);
  }
});

test("win32 WITHOUT the helper still discloses (helper ships in P-SANDBOX.7); darwin without sandbox-exec too", () => {
  const win = resolveBackend({ platform: "win32", which: has("bwrap") }); // bwrap "present" but not the win helper
  expect(win.ok && win.backend.name === "noop" && win.disclosed).toBe(true);
  const macNoSb = resolveBackend({ platform: "darwin", which: none });
  expect(macNoSb.ok && macNoSb.backend.name === "noop" && macNoSb.disclosed).toBe(true);
});

test("managed require-isolation with NO isolating backend REFUSES (fail-closed, never a passthrough)", () => {
  const linux = resolveBackend({ platform: "linux", requireIsolation: true, which: noBwrap, probe: bwrapBlocked });
  expect(linux.ok).toBe(false);
  if (!linux.ok) expect(linux.reason).toMatch(/bubblewrap/);
  const mac = resolveBackend({ platform: "darwin", requireIsolation: true, which: none });
  expect(mac.ok).toBe(false);
  if (!mac.ok) expect(mac.reason).toMatch(/Seatbelt/);
  const win = resolveBackend({ platform: "win32", requireIsolation: true, which: none }); // helper absent
  expect(win.ok).toBe(false);
  if (!win.ok) expect(win.reason).toMatch(/lucid-appcontainer/);
});

test("managed require-isolation is SATISFIED by an available sandbox-exec on macOS + lucid-appcontainer on Windows", () => {
  const mac = resolveBackend({ platform: "darwin", requireIsolation: true, which: has("sandbox-exec"), probe: seatbeltWorks });
  expect(mac.ok).toBe(true);
  if (mac.ok) expect(mac.backend.name).toBe("seatbelt");
  const win = resolveBackend({ platform: "win32", requireIsolation: true, which: has("lucid-appcontainer"), probe: acWorks });
  expect(win.ok).toBe(true);
  if (win.ok) expect(win.backend.name).toBe("appcontainer");
});

test("managed require-isolation is SATISFIED by an available bwrap", () => {
  const r = resolveBackend({ platform: "linux", requireIsolation: true, which: hasBwrap, probe: bwrapWorks });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.backend.name).toBe("bwrap");
});

// ── regression: sandbox-exec present but NON-FUNCTIONAL (sandboxed parent, P-SANDBOX.4) ──────────
// The bwrap-on-Ubuntu-24.04 silent-kill bug on macOS: sandbox-exec ships on EVERY macOS so presence
// always passes, but a LUCID itself running under a sandbox (CI runner, MDM wrapper, a dev build
// launched from another agent's gated shell) cannot NEST a Seatbelt profile - the wrapped child dies
// at spawn with "sandbox_apply: Operation not permitted", `omp acp` never comes up, and the model
// picker sits empty on a correctly-authed box.
test("darwin with sandbox-exec on PATH but BLOCKED sandbox_apply does NOT resolve seatbelt - it discloses instead", () => {
  const r = resolveBackend({ platform: "darwin", which: has("sandbox-exec"), probe: seatbeltBlocked });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.backend.name).toBe("noop"); // never "seatbelt" - a backend that cannot spawn is not a backend
    expect(r.backend.isolates).toBe(false);
    expect(r.disclosed).toBe(true); // degraded, but DISCLOSED and the agent still runs
  }
});

test("SeatbeltBackend.available() requires presence AND capability", () => {
  expect(new SeatbeltBackend(has("sandbox-exec"), seatbeltWorks).available()).toBe(true);
  expect(new SeatbeltBackend(has("sandbox-exec"), seatbeltBlocked).available()).toBe(false); // the silent-kill bug
  expect(new SeatbeltBackend(none, seatbeltWorks).available()).toBe(false);
});

test("managed require-isolation on a nested-sandbox mac refuses with the actionable nested-sandbox reason", () => {
  const r = resolveBackend({ platform: "darwin", requireIsolation: true, which: has("sandbox-exec"), probe: seatbeltBlocked });
  expect(r.ok).toBe(false); // gov/managed still fails CLOSED - degrading to passthrough is not an option
  if (!r.ok) {
    expect(r.reason).toMatch(/nested profiles are not permitted/);
    expect(r.reason).toMatch(/unsandboxed shell/); // tells the operator what to actually do
    expect(r.reason).not.toMatch(/not available/); // the old, misleading message
  }
});

// ── cap → flag mapping ────────────────────────────────────────────────────────

test("canNetwork:false maps to --unshare-net (total network deny, DNS included)", () => {
  const plan = new BwrapBackend(hasBwrap).wrap(ARGV, caps("container-local"), CTX);
  expect(plan.cmd).toBe("bwrap");
  expect(plan.args).toContain("--unshare-net");
});

test("canNetwork:true WITHOUT a proxy falls back to --unshare-net (P-SANDBOX.2: no mediator ⇒ no net, fail-closed)", () => {
  const plan = new BwrapBackend(hasBwrap).wrap(ARGV, caps("trusted-local"), CTX);
  expect(plan.args).toContain("--unshare-net");
});

test("canNetwork:true WITH a proxy is MEDIATED — no --unshare-net, HTTP(S)_PROXY set, resolv.conf steered (P-SANDBOX.2)", () => {
  const proxy = { host: "127.0.0.1", httpPort: 8888, httpProxyUrl: "http://127.0.0.1:8888", resolvConfPath: "/tmp/lucid-egress-x/resolv.conf" };
  const plan = new BwrapBackend(hasBwrap).wrap(ARGV, caps("trusted-local"), { ...CTX, proxy });
  expect(plan.args).not.toContain("--unshare-net");
  expect(plan.args.join(" ")).toContain("--ro-bind /tmp/lucid-egress-x/resolv.conf /etc/resolv.conf");
  expect(plan.env.HTTPS_PROXY).toBe("http://127.0.0.1:8888");
  expect(plan.env.HTTP_PROXY).toBe("http://127.0.0.1:8888");
  expect(plan.env.NO_PROXY).toContain("127.0.0.1");
});

test("canNetwork:true WITH a proxy but no privileged :53 mediates HTTP only — no resolv.conf bind (P-SANDBOX.2)", () => {
  const proxy = { host: "127.0.0.1", httpPort: 8888, httpProxyUrl: "http://127.0.0.1:8888" }; // resolvConfPath omitted
  const plan = new BwrapBackend(hasBwrap).wrap(ARGV, caps("trusted-local"), { ...CTX, proxy });
  expect(plan.args).not.toContain("--unshare-net");
  expect(plan.args.join(" ")).not.toContain("/etc/resolv.conf");
  expect(plan.env.HTTPS_PROXY).toBe("http://127.0.0.1:8888");
});

// ── macOS Seatbelt (P-SANDBOX.4) ──────────────────────────────────────────────

test("seatbelt canNetwork:false denies ALL network + cuts DNS (mDNSResponder mach-lookup)", () => {
  const plan = new SeatbeltBackend(has("sandbox-exec")).wrap(ARGV, caps("container-local"), CTX);
  expect(plan.cmd).toBe("sandbox-exec");
  const profile = plan.args[1]!; // -p <profile> <cmd...>
  expect(profile).toContain("(deny network*)");
  expect(profile).toContain("mDNSResponder");
  expect(plan.env.HTTPS_PROXY).toBeUndefined(); // no network ⇒ no proxy env
});

test("seatbelt canNetwork:true WITHOUT a proxy fails closed to total network+DNS deny (no mediator ⇒ no net)", () => {
  const profile = seatbeltProfile(caps("trusted-local"), CTX); // no proxy in CTX
  expect(profile).toContain("(deny network*)");
  expect(profile).toContain("mDNSResponder");
  expect(profile).not.toContain("localhost:*");
});

test("seatbelt canNetwork:true WITH a proxy confines egress to LOOPBACK only + sets HTTP(S)_PROXY (raw-IP sockets denied)", () => {
  const plan = new SeatbeltBackend(has("sandbox-exec")).wrap(ARGV, caps("trusted-local"), { ...CTX, proxy: PROXY });
  const profile = plan.args[1]!;
  expect(profile).toContain("(deny network-outbound)");
  expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
  expect(profile).not.toContain("(deny network*)"); // DNS/loopback stay reachable for the mediated case
  expect(plan.env.HTTPS_PROXY).toBe("http://127.0.0.1:8888");
  expect(plan.env.NO_PROXY).toContain("127.0.0.1");
});

test("seatbelt preserves the wrapped argv verbatim as the tail (sandbox-exec -p <profile> <argv...>)", () => {
  const plan = new SeatbeltBackend(has("sandbox-exec")).wrap(ARGV, caps("trusted-local"), { ...CTX, proxy: PROXY });
  expect(plan.args[0]).toBe("-p");
  expect(plan.args.slice(2)).toEqual(ARGV);
});

test("seatbelt through wrapForProfile: a network-off downgrade profile yields a network-denied, isolated plan", () => {
  const downgrade = chooseProfile({ requested: "trusted-local", trustLabel: "suspicious" }); // → container-local
  const res: BackendResolution = { ok: true, backend: new SeatbeltBackend(has("sandbox-exec")), disclosed: false };
  const d = wrapForProfile({ argv: ARGV, caps: caps(downgrade.profile), ctx: CTX, resolution: res });
  expect(d.action).toBe("spawn");
  if (d.action === "spawn") {
    expect(d.isolated).toBe(true);
    expect(d.plan.args[1]!).toContain("(deny network*)");
  }
});

// ── Windows AppContainer (P-SANDBOX.6) ────────────────────────────────────────

const AC = new AppContainerBackend(has("lucid-appcontainer"), "lucid-appcontainer", acWorks);

test("appContainerArgs canNetwork:false → --deny-network (total deny), binds the workspace", () => {
  const a = appContainerArgs(caps("container-local"), CTX);
  expect(a).toContain("--deny-network");
  expect(a).not.toContain("--loopback-only");
  expect(a.join(" ")).toContain("--workspace /work/ws");
});

test("appContainerArgs canNetwork:true WITHOUT a proxy fails closed to --deny-network (no mediator ⇒ no net)", () => {
  const a = appContainerArgs(caps("trusted-local"), CTX); // no proxy
  expect(a).toContain("--deny-network");
  expect(a).not.toContain("--loopback-only");
});

test("appContainer canNetwork:true WITH a proxy → --loopback-only + HTTP(S)_PROXY (raw-IP sockets WFP-denied)", () => {
  const plan = AC.wrap(ARGV, caps("trusted-local"), { ...CTX, proxy: PROXY });
  expect(plan.cmd).toBe("lucid-appcontainer");
  expect(plan.args).toContain("--loopback-only");
  expect(plan.args).not.toContain("--deny-network");
  expect(plan.env.HTTPS_PROXY).toBe("http://127.0.0.1:8888");
  expect(plan.env.NO_PROXY).toContain("127.0.0.1");
});

test("appContainer preserves the wrapped argv verbatim after the -- separator", () => {
  const plan = AC.wrap(ARGV, caps("trusted-local"), { ...CTX, proxy: PROXY });
  const sep = plan.args.indexOf("--");
  expect(sep).toBeGreaterThan(0);
  expect(plan.args.slice(sep + 1)).toEqual(ARGV);
});

test("appContainer available() needs presence AND a passing containment probe (P-SANDBOX.7)", () => {
  expect(new AppContainerBackend(has("lucid-appcontainer"), "lucid-appcontainer", acWorks).available()).toBe(true);
  expect(new AppContainerBackend(none, "lucid-appcontainer", acWorks).available()).toBe(false);
  expect(new AppContainerBackend(has("bwrap"), "lucid-appcontainer", acWorks).available()).toBe(false); // a different tool doesn't count
  // present but INCAPABLE (profile creation / ACL grant refused) ⇒ unavailable, same bwrap doctrine
  expect(new AppContainerBackend(has("lucid-appcontainer"), "lucid-appcontainer", acBroken).available()).toBe(false);
});

test("win32 with a present-but-incapable helper DISCLOSES rather than committing to a dead backend", () => {
  const r = resolveBackend({ platform: "win32", which: has("lucid-appcontainer"), probe: acBroken });
  expect(r.ok && r.backend.name === "noop" && r.disclosed).toBe(true);
});

test("win32 require-isolation with a present-but-incapable helper REFUSES and names the probe failure", () => {
  const r = resolveBackend({ platform: "win32", requireIsolation: true, which: has("lucid-appcontainer"), probe: acBroken });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(/containment probe/);
});

test("listingExemptsMoniker: only a listing carrying OUR moniker counts, case-insensitively (P-SANDBOX.7b)", () => {
  expect(listingExemptsMoniker("\nList Loopback Exempted AppContainers \n\nOK.\n")).toBe(false); // no exemptions (live -s shape)
  expect(listingExemptsMoniker("[1] -----\n    Name: lucidagentide.sandbox.v1\n    SID: S-1-15-2-1\nOK.")).toBe(true); // CheckNetIsolation lowercases
  expect(listingExemptsMoniker("[1] -----\n    Name: microsoft.windows.authhost.a\nOK.")).toBe(false); // someone else's exemption
});

test("the packaged helper path (P-SANDBOX.7) becomes the plan's cmd verbatim", () => {
  const packaged = "C:\\app\\resources\\repo\\bin\\lucid-appcontainer.exe";
  const r = resolveBackend({ platform: "win32", which: has(packaged), appContainerHelper: packaged, probe: acWorks });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.backend.name).toBe("appcontainer");
    const plan = r.backend.wrap(ARGV, caps("container-local"), CTX);
    expect(plan.cmd).toBe(packaged);
  }
});

test("appContainer through wrapForProfile: a network-off downgrade yields a --deny-network isolated plan", () => {
  const downgrade = chooseProfile({ requested: "trusted-local", trustLabel: "suspicious" });
  const res: BackendResolution = { ok: true, backend: AC, disclosed: false };
  const d = wrapForProfile({ argv: ARGV, caps: caps(downgrade.profile), ctx: CTX, resolution: res });
  expect(d.action).toBe("spawn");
  if (d.action === "spawn") {
    expect(d.isolated).toBe(true);
    expect(d.plan.cmd).toBe("lucid-appcontainer");
    expect(d.plan.args).toContain("--deny-network");
  }
});

test("bwrap binds the workspace rw, home rw (omp state; fs containment stays omp --isolate's), system ro", () => {
  const plan = new BwrapBackend(hasBwrap).wrap(ARGV, caps("trusted-local"), CTX);
  const a = plan.args.join(" ");
  expect(a).toContain("--bind /work/ws /work/ws");
  expect(a).toContain("--bind-try /home/u /home/u");
  expect(a).toContain("--ro-bind-try /usr /usr");
  expect(a).toContain("--die-with-parent");
});

test("the wrapped argv is preserved verbatim after the -- separator", () => {
  const plan = new BwrapBackend(hasBwrap).wrap(ARGV, caps("trusted-local"), CTX);
  const sep = plan.args.indexOf("--");
  expect(sep).toBeGreaterThan(0);
  expect(plan.args.slice(sep + 1)).toEqual(ARGV);
});

// ── wrapForProfile: the fail-closed decision point ────────────────────────────

const bwrapRes: BackendResolution = { ok: true, backend: new BwrapBackend(hasBwrap), disclosed: false };
const noopRes: BackendResolution = { ok: true, backend: new NoopBackend(), disclosed: true };

test("a failed resolution refuses the spawn (managed require-isolation carries through)", () => {
  const d = wrapForProfile({ argv: ARGV, caps: caps("trusted-local"), ctx: CTX, resolution: { ok: false, reason: "policy requires isolation" } });
  expect(d.action).toBe("refuse");
  if (d.action === "refuse") expect(d.reason).toMatch(/policy requires isolation/);
});

test("canExec:false profiles (read-only-audit, quarantine) refuse exec on ANY backend", () => {
  for (const profile of ["read-only-audit", "quarantine"] as const) {
    for (const resolution of [bwrapRes, noopRes]) {
      const d = wrapForProfile({ argv: ARGV, caps: caps(profile), ctx: CTX, resolution });
      expect(d.action).toBe("refuse");
      if (d.action === "refuse") expect(d.reason).toMatch(/canExec=false/);
    }
  }
});

test("a network-off profile on the PASSTHROUGH refuses — never silently networked (fail-closed)", () => {
  const d = wrapForProfile({ argv: ARGV, caps: caps("container-local"), ctx: CTX, resolution: noopRes });
  expect(d.action).toBe("refuse");
  if (d.action === "refuse") expect(d.reason).toMatch(/canNetwork=false/);
});

test("the chooseProfile suspicious-chain downgrade now yields a GENUINELY network-denied plan", () => {
  // ADR-0157's profiles.ts gap: chooseProfile downgraded to container-local but nothing enforced it.
  const downgrade = chooseProfile({ requested: "trusted-local", trustLabel: "suspicious" });
  expect(downgrade.profile).toBe("container-local");
  const d = wrapForProfile({ argv: ARGV, caps: caps(downgrade.profile), ctx: CTX, resolution: bwrapRes });
  expect(d.action).toBe("spawn");
  if (d.action === "spawn") {
    expect(d.isolated).toBe(true);
    expect(d.plan.args).toContain("--unshare-net");
  }
});

test("trusted-local on the passthrough spawns the IDENTICAL argv, flagged disclosed", () => {
  const d = wrapForProfile({ argv: ARGV, caps: caps("trusted-local"), ctx: CTX, resolution: noopRes });
  expect(d.action).toBe("spawn");
  if (d.action === "spawn") {
    expect(d.plan.cmd).toBe(ARGV[0]!);
    expect(d.plan.args).toEqual(ARGV.slice(1));
    expect(d.isolated).toBe(false);
    expect(d.disclosed).toBe(true); // the caller MUST emit sandboxDisclosure()
  }
});

test("the disclosure line names the platform and the un-isolated state (greppable audit bytes)", () => {
  const line = sandboxDisclosure("darwin");
  expect(line).toContain("darwin");
  expect(line).toMatch(/NOT runtime-isolated/);
  expect(line).toContain("ADR-0157");
});

// ── the managed knob (ADR-0068 channel plumbing) ──────────────────────────────

test("GPO flat value ExecRequireIsolation parses into security.exec.requireIsolation", () => {
  const reg = [
    "HKEY_LOCAL_MACHINE\\Software\\Policies\\LucidAgentIDE",
    "    OrgName    REG_SZ    Acme Corp",
    "    ExecRequireIsolation    REG_DWORD    0x1",
  ].join("\r\n");
  const cfg = parseRegistryPolicy(reg);
  expect(cfg?.security?.exec?.requireIsolation).toBe(true);
  expect(managedRequireIsolation(cfg)).toBe(true);
});

test("managedRequireIsolation is tighten-only: absent/false/unmanaged means no requirement", () => {
  expect(managedRequireIsolation(null)).toBe(false);
  expect(managedRequireIsolation({})).toBe(false);
  expect(managedRequireIsolation({ security: { exec: { requireIsolation: false } } })).toBe(false);
  expect(managedRequireIsolation({ security: { exec: { requireIsolation: true } } })).toBe(true);
});

// ── P-SANDBOX.9 (ADR-0386): contained chat actually works ─────────────────────

test("proxyChildEnv steers omp too: PI_PROXY + ALL_PROXY ride with HTTP(S)_PROXY, loopback bypasses", () => {
  const env = proxyChildEnv("http://127.0.0.1:8888");
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "PI_PROXY", "ALL_PROXY", "all_proxy"]) expect(env[k]).toBe("http://127.0.0.1:8888");
  expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
});

test("every isolating backend sets PI_PROXY on a mediated wrap (omp 18 reads only PI_PROXY for inference)", () => {
  expect(AC.wrap(ARGV, caps("trusted-local"), { ...CTX, proxy: PROXY }).env.PI_PROXY).toBe("http://127.0.0.1:8888");
  expect(new SeatbeltBackend(has("sandbox-exec"), seatbeltWorks).wrap(ARGV, caps("trusted-local"), { ...CTX, proxy: PROXY }).env.PI_PROXY).toBe("http://127.0.0.1:8888");
  expect(new BwrapBackend(hasBwrap, bwrapWorks).wrap(ARGV, caps("trusted-local"), { ...CTX, proxy: PROXY }).env.PI_PROXY).toBe("http://127.0.0.1:8888");
  // network-off never gets a proxy (there is nothing to steer at)
  expect(AC.wrap(ARGV, caps("container-local"), CTX).env.PI_PROXY).toBeUndefined();
});

test("appContainerArgs passes the runtime grants and the temp dir as --grant-rx / --grant-rw", () => {
  const a = appContainerArgs(caps("trusted-local"), { ...CTX, proxy: PROXY, grantRx: ["C:\\repo"], grantRw: ["C:\\Users\\u\\.omp"], tmpDir: "C:\\Users\\u\\.omp\\lucid-sandbox-tmp" });
  expect(a.join(" ")).toContain("--grant-rx C:\\repo");
  expect(a.join(" ")).toContain("--grant-rw C:\\Users\\u\\.omp");
  expect(a.join(" ")).toContain("--grant-rw C:\\Users\\u\\.omp\\lucid-sandbox-tmp");
  expect(a).toContain("--loopback-only");
});

test("appContainer wrap points TEMP/TMP at the granted temp dir (the user's %TEMP% is not granted)", () => {
  const plan = AC.wrap(ARGV, caps("trusted-local"), { ...CTX, proxy: PROXY, tmpDir: "C:\\t" });
  expect(plan.env.TEMP).toBe("C:\\t");
  expect(plan.env.TMP).toBe("C:\\t");
  expect(AC.wrap(ARGV, caps("trusted-local"), { ...CTX, proxy: PROXY }).env.TEMP).toBeUndefined();
});

test("appContainerRuntimeGrants: bundled omp -> repo + bun dir rx, ~/.omp rw, temp inside it", () => {
  const g = appContainerRuntimeGrants({
    repoRoot: "C:\\Users\\u\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\repo",
    home: "C:\\Users\\u",
    bunBin: "C:\\Users\\u\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\runtimes\\bun-win32-x64.exe",
    ompBin: "C:\\Users\\u\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\repo\\node_modules\\.bin\\omp.exe",
  });
  expect(g.grantRx).toEqual([
    "C:\\Users\\u\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\repo",
    "C:\\Users\\u\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\runtimes",
  ]); // omp under the repo adds nothing
  expect(g.grantRw).toEqual(["C:\\Users\\u\\.omp"]);
  expect(g.tmpDir).toBe("C:\\Users\\u\\.omp\\lucid-sandbox-tmp");
});

test("appContainerRuntimeGrants: an omp outside the repo is granted by its install root; bare names are skipped", () => {
  const g = appContainerRuntimeGrants({ repoRoot: "C:\\r", home: "C:\\Users\\u", bunBin: "bun", ompBin: "C:\\Users\\u\\.bun\\bin\\omp.exe" });
  expect(g.grantRx).toEqual(["C:\\r", "C:\\Users\\u\\.bun"]);
  // same dir twice (case differs) is granted once
  const d = appContainerRuntimeGrants({ repoRoot: "C:\\R", home: "C:\\h", bunBin: "c:\\r\\bun.exe", ompBin: null });
  expect(d.grantRx).toEqual(["C:\\R"]);
});

test("the AppContainer probe is a stdio round trip: exit 0 WITHOUT the echoed marker does not pass", () => {
  const argv = appContainerProbeArgv("lucid-appcontainer", "C:\\tmp");
  expect(argv.slice(0, 4)).toEqual(["lucid-appcontainer", "--workspace", "C:\\tmp", "--deny-network"]);
  expect(argv.join(" ")).toContain(`echo ${APPCONTAINER_PROBE_MARKER}`);
  expect(appContainerProbePassed({ exitCode: 0, stdout: `${APPCONTAINER_PROBE_MARKER}\r\n` })).toBe(true);
  expect(appContainerProbePassed({ exitCode: 0, stdout: "" })).toBe(false); // the beta.7 helper: runs, but no stdio
  expect(appContainerProbePassed({ exitCode: 3, stdout: APPCONTAINER_PROBE_MARKER })).toBe(false);
});
