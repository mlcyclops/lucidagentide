// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/sandbox_mxc.ts - P-MXC.1 (ADR-0441): Microsoft eXecution Container as a SandboxBackend,
// through the signed `wxc-exec.exe` executor and the 1.0.0 JSON request (the executor transport,
// decision 2). It sits BEHIND the seam sandbox_exec.ts owns: `wrapForProfile` still makes every
// fail-closed call; this file only builds an enforceable plan and probes whether the executor works
// HERE (presence is not capability, the bwrap doctrine).
//
// Facts this mapping rests on, measured on 2026-10-08 (Windows 10 19045, DACL tier, ADR-0441 spike):
//   - `--config-base64` carries the whole request on argv, so no request file ever touches a disk the
//     container can read, and `-- <argv>` passes the command as a vector, no re-quoting.
//   - the container does NOT inherit the executor's environment: proxy steering goes in `process.env`
//     (`KEY=VALUE` strings) with `inheritDefaultEnv: true`; MXC pins TEMP to the package's own AC\Temp.
//   - `containerId` names the AppContainer profile. Using the helper's moniker (ADR-0174's
//     `LucidAgentIDE.Sandbox.v1`) makes the ONE-TIME loopback exemption the user already registered
//     cover MXC too: with that moniker a container under egress/ingress deny reached a loopback listener,
//     and under any other moniker it could not. On the DACL tier `ingress.hostLoopback: "allow"` is
//     refused by Windows and a proxy needs `ingress.default: "allow"`, which MXC rejects next to a denied
//     egress on the AppContainer fallback; so mediated mode there is deny/deny/deny + the exemption.
//     The BaseContainer tier takes the explicit `hostLoopback: "allow"` instead.
//   - raw egress (`egress.default: "allow"`) appears in NO mapping (invariant 3).

import type { ProfileCaps } from "./profiles.ts";
import type { SandboxBackend, SandboxCtx, SandboxPlan } from "./sandbox_exec.ts";
import { proxyChildEnv } from "./sandbox_exec.ts";
import { MXC_SCHEMA_VERSION } from "./mxc_assets.ts";

/** The AppContainer moniker every LUCID-contained child runs under. MUST equal
 *  `APPCONTAINER_MONIKER` in sandbox_exec.ts (a test pins it): one SID, so the loopback exemption and the
 *  user's folder grants attribute to the same container whichever backend spawned it. */
export const MXC_CONTAINER_ID = "LucidAgentIDE.Sandbox.v1";

/** MXC's `IsolationTier` for the Windows ProcessContainer, as `wxc-exec --probe` reports it. */
export type MxcTier = "base-container" | "appcontainer-bfs" | "appcontainer-dacl";

export interface MxcNetwork {
  egress: { default: "deny" };
  ingress: { default: "deny"; hostLoopback: "deny" | "allow" };
}

/** The subset of the 1.0.0 one-shot request LUCID emits. */
export interface MxcRequest {
  version: typeof MXC_SCHEMA_VERSION;
  containment: "processcontainer";
  containerId: string;
  process: { cwd: string; env: string[]; inheritDefaultEnv: true; commandLine?: string };
  filesystem: { readwritePaths: string[]; readonlyPaths: string[] };
  network: MxcNetwork;
  ui: { disable: true };
}

/** PURE: the three network states of ADR-0172, in MXC terms, by tier. Mediated egress on the DACL tier
 *  relies on the moniker's loopback exemption (the caller checks `loopbackExempted()` before offering
 *  this backend for a network-on profile, exactly as it does for the helper). */
export function mxcNetwork(caps: ProfileCaps, ctx: SandboxCtx, tier: MxcTier): MxcNetwork {
  const mediated = caps.canNetwork && !!ctx.proxy;
  return {
    egress: { default: "deny" },
    ingress: { default: "deny", hostLoopback: mediated && tier === "base-container" ? "allow" : "deny" },
  };
}

function dedupe(paths: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** PURE: the request for `caps` + `ctx`. Workspace, `grantRw` and `tmpDir` are read-write; `grantRx` is
 *  read-only (MXC has no execute-only grant; read covers execute for an AppContainer). The proxy env is
 *  the same `proxyChildEnv` every backend uses, layered over MXC's default environment. */
export function mxcRequest(caps: ProfileCaps, ctx: SandboxCtx, tier: MxcTier): MxcRequest {
  const env: Record<string, string> = {};
  if (caps.canNetwork && ctx.proxy) Object.assign(env, proxyChildEnv(ctx.proxy.httpProxyUrl));
  const readwritePaths = dedupe([ctx.workspace, ...(ctx.grantRw ?? []), ctx.tmpDir]);
  const rwKeys = new Set(readwritePaths.map((p) => p.toLowerCase()));
  return {
    version: MXC_SCHEMA_VERSION,
    containment: "processcontainer",
    containerId: MXC_CONTAINER_ID,
    process: { cwd: ctx.workspace, env: Object.entries(env).map(([k, v]) => `${k}=${v}`), inheritDefaultEnv: true },
    filesystem: {
      readwritePaths,
      // A path granted read-write is never ALSO listed read-only: MXC applies both and the stricter wins.
      readonlyPaths: dedupe(ctx.grantRx ?? []).filter((p) => !rwKeys.has(p.toLowerCase())),
    },
    network: mxcNetwork(caps, ctx, tier),
    ui: { disable: true },
  };
}

/** PURE: the executor argv for a request and the command to run inside it. */
export function mxcArgs(request: MxcRequest, argv: readonly string[]): string[] {
  return ["--config-base64", Buffer.from(JSON.stringify(request), "utf8").toString("base64"), "--", ...argv];
}

/** The round-trip probe (ADR-0386's rule, through MXC): the smallest real container must ECHO a marker
 *  back through our stdout pipe. A container that runs but cannot wire stdio would light the pill and
 *  kill every ACP turn, so an exit 0 without the marker is a failure. */
export const MXC_PROBE_MARKER = "lucid-mxc-stdio-ok";
export function mxcProbeArgv(exe: string, workspace: string): string[] {
  const req: MxcRequest = {
    version: MXC_SCHEMA_VERSION,
    containment: "processcontainer",
    containerId: MXC_CONTAINER_ID,
    process: { cwd: workspace, env: [], inheritDefaultEnv: true },
    filesystem: { readwritePaths: [workspace], readonlyPaths: [] },
    network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
    ui: { disable: true },
  };
  return [exe, ...mxcArgs(req, ["cmd.exe", "/c", `echo ${MXC_PROBE_MARKER}`])];
}
/** PURE: did the probe run AND carry the child's stdout back? */
export function mxcProbePassed(r: { exitCode: number | null; stdout: string }): boolean {
  return r.exitCode === 0 && r.stdout.includes(MXC_PROBE_MARKER);
}

/** PURE: the tier out of `wxc-exec --probe`'s JSON, or null for anything unreadable or unknown. */
export function parseMxcTier(stdout: string): MxcTier | null {
  try {
    const j = JSON.parse(stdout) as { tier?: unknown };
    return j.tier === "base-container" || j.tier === "appcontainer-bfs" || j.tier === "appcontainer-dacl" ? j.tier : null;
  } catch { return null; }
}

/** What the caller measured about the executor on this host, injected so the backend stays pure. */
export interface MxcHost {
  /** The verified executor: present, hash matches the pin, `--probe` answered. */
  exe: string;
  tier: MxcTier;
  /** The round-trip probe result for `exe`, cached per run by the caller. */
  probe: (exe: string) => boolean;
}

/** Windows ProcessContainer via MXC. `isolates` is true: an AppContainer SID (DACL tier) or a kernel
 *  BaseContainer (tier 1) with capability-less networking and per-request filesystem grants. */
export class MxcBackend implements SandboxBackend {
  readonly name = "mxc" as const;
  readonly isolates = true;
  constructor(private readonly host: MxcHost) {}
  get tier(): MxcTier { return this.host.tier; }
  available(): boolean {
    return this.host.probe(this.host.exe);
  }
  wrap(argv: string[], caps: ProfileCaps, ctx: SandboxCtx): SandboxPlan {
    // Proxy steering rides INSIDE the request (the container does not inherit our env); the plan's env
    // stays empty so a caller that merges it into the executor's environment changes nothing.
    return { cmd: this.host.exe, args: mxcArgs(mxcRequest(caps, ctx, this.host.tier), argv), env: {} };
  }
}
