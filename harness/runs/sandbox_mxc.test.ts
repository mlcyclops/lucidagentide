// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/sandbox_mxc.test.ts - P-MXC.1 (ADR-0441): the pure MXC request mapping, the probe
// contract, and the backend's place in resolveBackend. The real executor is exercised by
// `make demo-P-MXC.1` (harness/scripts/demo_p_mxc_1.ts); nothing here spawns it.

import { describe, expect, test } from "bun:test";
import { APPCONTAINER_MONIKER, resolveBackend, wrapForProfile, type SandboxCtx } from "./sandbox_exec.ts";
import { MXC_CONTAINER_ID, MXC_PROBE_MARKER, MxcBackend, mxcArgs, mxcNetwork, mxcProbeArgv, mxcProbePassed, mxcRequest, parseMxcTier, type MxcHost, type MxcRequest } from "./sandbox_mxc.ts";
import type { ProfileCaps } from "./profiles.ts";
import { MXC_SCHEMA_VERSION, mxcPlatformKey, verifyMxcAsset, MXC_ASSETS } from "./mxc_assets.ts";

const NET_ON: ProfileCaps = { canWrite: true, canExec: true, canNetwork: true, isolation: "none" };
const NET_OFF: ProfileCaps = { canWrite: true, canExec: true, canNetwork: false, isolation: "none" };
const proxy = { host: "127.0.0.1", httpPort: 7788, httpProxyUrl: "http://127.0.0.1:7788" };
const ctx: SandboxCtx = { workspace: "C:\\work\\repo", grantRx: ["C:\\Program Files\\LUCID\\repo", "C:\\work\\REPO"], grantRw: ["C:\\Users\\me\\.omp"], tmpDir: "C:\\Users\\me\\.omp\\lucid-sandbox-tmp", proxy };

function decode(args: string[]): MxcRequest {
  const i = args.indexOf("--config-base64");
  return JSON.parse(Buffer.from(args[i + 1]!, "base64").toString("utf8")) as MxcRequest; // our own encoding, decoded for assertions
}

describe("the moniker and the pin", () => {
  test("MXC runs under the helper's AppContainer moniker, so one loopback exemption serves both backends", () => {
    expect(MXC_CONTAINER_ID).toBe(APPCONTAINER_MONIKER);
  });
  test("executors are pinned for both Windows arches and nowhere else", () => {
    expect(mxcPlatformKey("win32", "x64")).toBe("win32-x64");
    expect(mxcPlatformKey("win32", "arm64")).toBe("win32-arm64");
    expect(mxcPlatformKey("linux", "x64")).toBeNull();
    expect(mxcPlatformKey("darwin", "arm64")).toBeNull();
    expect(MXC_ASSETS.map((a) => `${a.platform}/${a.name}`).sort()).toEqual(["win32-arm64/wxc-exec.exe", "win32-arm64/wxc-host-prep.exe", "win32-x64/wxc-exec.exe", "win32-x64/wxc-host-prep.exe"]);
  });
  test("verifyMxcAsset refuses a wrong size before it looks at the hash, and a wrong hash by name", () => {
    const spec = MXC_ASSETS[0]!;
    expect(verifyMxcAsset(spec, spec.bytes + 1, spec.sha256)).toEqual({ ok: false, reason: `${spec.platform}/${spec.name}: ${spec.bytes + 1} bytes, pinned ${spec.bytes}` });
    const bad = verifyMxcAsset(spec, spec.bytes, "ab".repeat(32));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain(spec.sha256);
    expect(verifyMxcAsset(spec, spec.bytes, spec.sha256.toUpperCase())).toEqual({ ok: true });
  });
});

describe("mxcNetwork: the three ADR-0172 states, by tier; raw egress never", () => {
  test("network-off is deny/deny/deny on every tier", () => {
    for (const tier of ["base-container", "appcontainer-bfs", "appcontainer-dacl"] as const) {
      expect(mxcNetwork(NET_OFF, ctx, tier)).toEqual({ egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } });
    }
  });
  test("mediated on the kernel tier allows host loopback explicitly; on the AppContainer tiers it stays deny and relies on the moniker exemption", () => {
    expect(mxcNetwork(NET_ON, ctx, "base-container").ingress.hostLoopback).toBe("allow");
    expect(mxcNetwork(NET_ON, ctx, "appcontainer-dacl").ingress.hostLoopback).toBe("deny");
    expect(mxcNetwork(NET_ON, ctx, "appcontainer-bfs").ingress.hostLoopback).toBe("deny");
  });
  test("network-on WITHOUT a proxy is network-off (no mediator, no network)", () => {
    expect(mxcNetwork(NET_ON, { ...ctx, proxy: undefined }, "base-container")).toEqual({ egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } });
  });
  test("egress.default is deny in every mapping", () => {
    for (const caps of [NET_ON, NET_OFF]) for (const c of [ctx, { ...ctx, proxy: undefined }]) for (const tier of ["base-container", "appcontainer-dacl"] as const) {
      expect(mxcNetwork(caps, c, tier).egress.default).toBe("deny");
    }
  });
});

describe("mxcRequest + mxcArgs", () => {
  test("workspace, grantRw and tmpDir are read-write; grantRx is read-only; a path cannot be both; dedupe is case-insensitive", () => {
    const r = mxcRequest(NET_OFF, { ...ctx, grantRx: [...ctx.grantRx!, "c:\\users\\me\\.omp"] }, "appcontainer-dacl");
    expect(r.filesystem.readwritePaths).toEqual(["C:\\work\\repo", "C:\\Users\\me\\.omp", "C:\\Users\\me\\.omp\\lucid-sandbox-tmp"]);
    expect(r.filesystem.readonlyPaths).toEqual(["C:\\Program Files\\LUCID\\repo"]); // the workspace dup and the rw dup are dropped
    expect(r.process.cwd).toBe("C:\\work\\repo");
    expect(r.containerId).toBe(MXC_CONTAINER_ID);
    expect(r.version).toBe(MXC_SCHEMA_VERSION);
    expect(r.ui).toEqual({ disable: true });
  });
  test("the proxy env rides INSIDE the request (the container inherits nothing from the executor), layered over MXC's defaults; absent when network-off", () => {
    const on = mxcRequest(NET_ON, ctx, "appcontainer-dacl");
    expect(on.process.inheritDefaultEnv).toBe(true);
    expect(on.process.env).toContain("PI_PROXY=http://127.0.0.1:7788");
    expect(on.process.env).toContain("HTTPS_PROXY=http://127.0.0.1:7788");
    expect(on.process.env).toContain("NO_PROXY=localhost,127.0.0.1,::1");
    expect(mxcRequest(NET_OFF, ctx, "appcontainer-dacl").process.env).toEqual([]);
  });
  test("args carry the request as base64 and the command as a vector after `--`", () => {
    const req = mxcRequest(NET_OFF, ctx, "appcontainer-dacl");
    const args = mxcArgs(req, ["C:\\bun\\bun.exe", "run", "a b.ts"]);
    expect(args.slice(0, 1)).toEqual(["--config-base64"]);
    expect(args.slice(2)).toEqual(["--", "C:\\bun\\bun.exe", "run", "a b.ts"]);
    expect(decode(args)).toEqual(req);
  });
});

describe("the probe contract", () => {
  test("the probe is a deny-everything container that must echo the marker back through our pipe", () => {
    const argv = mxcProbeArgv("C:\\mxc\\wxc-exec.exe", "C:\\tmp\\probe");
    expect(argv[0]).toBe("C:\\mxc\\wxc-exec.exe");
    const req = decode(argv.slice(1));
    expect(req.network).toEqual({ egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } });
    expect(req.filesystem.readwritePaths).toEqual(["C:\\tmp\\probe"]);
    expect(argv.slice(-3)).toEqual(["cmd.exe", "/c", `echo ${MXC_PROBE_MARKER}`]);
    expect(mxcProbePassed({ exitCode: 0, stdout: `${MXC_PROBE_MARKER}\r\n` })).toBe(true);
    expect(mxcProbePassed({ exitCode: 0, stdout: "" })).toBe(false); // ran, but stdio never reached us
    expect(mxcProbePassed({ exitCode: 1, stdout: MXC_PROBE_MARKER })).toBe(false);
  });
  test("parseMxcTier reads --probe JSON and refuses anything else", () => {
    expect(parseMxcTier('{"tier":"appcontainer-dacl","warnings":[]}')).toBe("appcontainer-dacl");
    expect(parseMxcTier('{"tier":"base-container"}')).toBe("base-container");
    expect(parseMxcTier('{"tier":"hyperlight"}')).toBeNull();
    expect(parseMxcTier("not json")).toBeNull();
  });
});

describe("MxcBackend in resolveBackend", () => {
  const host = (ok: boolean, tier: MxcHost["tier"] = "appcontainer-dacl"): MxcHost => ({ exe: "C:\\mxc\\wxc-exec.exe", tier, probe: () => ok });
  const noHelper = { which: () => false, probe: () => false };

  test("on win32 a verified executor whose round trip passes is the backend, ahead of the helper", () => {
    const r = resolveBackend({ platform: "win32", ...noHelper, mxc: host(true), appContainerHelper: "C:\\bin\\lucid-appcontainer.exe" });
    expect(r.ok && r.backend.name).toBe("mxc");
    expect(r.ok && r.backend.isolates).toBe(true);
    expect(r.ok && !r.disclosed).toBe(true);
  });
  test("a failed round trip falls through: to the helper when it works, else to the disclosed passthrough, else to refusal under managed policy", () => {
    const helperOk = { which: (b: string) => b === "C:\\bin\\lucid-appcontainer.exe", probe: () => true };
    const viaHelper = resolveBackend({ platform: "win32", ...helperOk, mxc: host(false), appContainerHelper: "C:\\bin\\lucid-appcontainer.exe" });
    expect(viaHelper.ok && viaHelper.backend.name).toBe("appcontainer");
    const disclosed = resolveBackend({ platform: "win32", ...noHelper, mxc: host(false) });
    expect(disclosed.ok && disclosed.backend.name).toBe("noop");
    expect(disclosed.ok && disclosed.disclosed).toBe(true);
    const refused = resolveBackend({ platform: "win32", ...noHelper, mxc: host(false), requireIsolation: true });
    expect(refused.ok).toBe(false);
  });
  test("never offered off Windows, whatever the caller passes", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const r = resolveBackend({ platform, ...noHelper, mxc: host(true) });
      expect(r.ok && r.backend.name).not.toBe("mxc");
    }
  });
  test("wrapForProfile through the mxc backend: the plan runs the executor, keeps the plan env empty, and the fail-closed rules stay the seam's", () => {
    const b = new MxcBackend(host(true, "base-container"));
    const spawn = wrapForProfile({ argv: ["C:\\bun\\bun.exe", "x.ts"], caps: NET_ON, ctx, resolution: { ok: true, backend: b, disclosed: false } });
    expect(spawn.action).toBe("spawn");
    if (spawn.action === "spawn") {
      expect(spawn.plan.cmd).toBe("C:\\mxc\\wxc-exec.exe");
      expect(spawn.plan.env).toEqual({});
      expect(decode(spawn.plan.args).network.ingress.hostLoopback).toBe("allow");
      expect(spawn.isolated).toBe(true);
    }
    const noExec = wrapForProfile({ argv: ["x"], caps: { ...NET_OFF, canExec: false }, ctx, resolution: { ok: true, backend: b, disclosed: false } });
    expect(noExec.action).toBe("refuse");
  });
});
