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
  BwrapBackend,
  NoopBackend,
  resolveBackend,
  sandboxDisclosure,
  wrapForProfile,
  type BackendResolution,
} from "./sandbox_exec.ts";
import { caps, chooseProfile } from "./profiles.ts";
import { managedRequireIsolation, parseRegistryPolicy } from "../../desktop/managed_config.ts";

const hasBwrap = () => true;
const noBwrap = () => false;
const ARGV = ["/opt/omp", "acp", "-e", "/repo/gate.ts"];
const CTX = { workspace: "/work/ws", home: "/home/u" };

// ── backend resolution ────────────────────────────────────────────────────────

test("linux with bwrap on PATH resolves the ISOLATING backend (no disclosure)", () => {
  const r = resolveBackend({ platform: "linux", which: hasBwrap });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.backend.name).toBe("bwrap");
    expect(r.backend.isolates).toBe(true);
    expect(r.disclosed).toBe(false);
  }
});

test("linux WITHOUT bwrap falls back to the disclosed passthrough (personal default)", () => {
  const r = resolveBackend({ platform: "linux", which: noBwrap });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.backend.name).toBe("noop");
    expect(r.disclosed).toBe(true);
  }
});

test("win32/darwin resolve the disclosed passthrough in v1 (backends land in P-SANDBOX.4)", () => {
  for (const platform of ["win32", "darwin"] as const) {
    const r = resolveBackend({ platform, which: hasBwrap }); // even with bwrap "present": linux-only
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backend.name).toBe("noop");
      expect(r.disclosed).toBe(true);
    }
  }
});

test("managed require-isolation with NO isolating backend REFUSES (fail-closed, never a passthrough)", () => {
  const linux = resolveBackend({ platform: "linux", requireIsolation: true, which: noBwrap });
  expect(linux.ok).toBe(false);
  if (!linux.ok) expect(linux.reason).toMatch(/bubblewrap/);
  const win = resolveBackend({ platform: "win32", requireIsolation: true, which: hasBwrap });
  expect(win.ok).toBe(false);
  if (!win.ok) expect(win.reason).toMatch(/P-SANDBOX\.4/);
});

test("managed require-isolation is SATISFIED by an available bwrap", () => {
  const r = resolveBackend({ platform: "linux", requireIsolation: true, which: hasBwrap });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.backend.name).toBe("bwrap");
});

// ── cap → flag mapping ────────────────────────────────────────────────────────

test("canNetwork:false maps to --unshare-net (total network deny, DNS included)", () => {
  const plan = new BwrapBackend(hasBwrap).wrap(ARGV, caps("container-local"), CTX);
  expect(plan.cmd).toBe("bwrap");
  expect(plan.args).toContain("--unshare-net");
});

test("canNetwork:true does NOT unshare the network (the mediated proxy is P-SANDBOX.2)", () => {
  const plan = new BwrapBackend(hasBwrap).wrap(ARGV, caps("trusted-local"), CTX);
  expect(plan.args).not.toContain("--unshare-net");
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
