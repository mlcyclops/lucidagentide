// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/sandbox_exec.ts — P-SANDBOX.1 (ADR-0157): the portable runtime-sandbox seam.
//
// Every execution control before this increment acted on TEXT at the tool boundary, BEFORE a
// process was spawned (argv classifier ADR-0066, egress verdicts ADR-0062/0106/0108, the scanner
// keystone). Once a process was running, LUCID had zero runtime containment — and
// harness/runs/profiles.ts DECLARED `canNetwork`/`canExec` per profile that nothing enforced.
// This seam makes those declared caps real at the omp spawn:
//
//   - `BwrapBackend` (Linux): wrap the spawn in bubblewrap — workspace bound rw, system paths ro,
//     `--unshare-net` when the profile denies network (total deny: a DNS-TXT exfil fails at the
//     syscall). The whole omp process TREE inherits the namespace, so bash/eval/python/pip children
//     are contained without per-command work.
//   - `NoopBackend` (platforms without a backend, v1 = macOS/Windows, or Linux without bwrap): a
//     DISCLOSED, audited passthrough — runs as today (argv gate + in-process scanner gate still
//     fully apply) and the caller emits the loud `sandboxDisclosure()` line. Enterprise-managed
//     policy (`security.exec.requireIsolation`, ADR-0068 tighten-only) flips this to fail-closed:
//     no isolating backend ⇒ refuse, never a silent unisolated run.
//
// FAIL-CLOSED RULES (invariant #3, enforced by `wrapForProfile`):
//   - managed require-isolation with no isolating backend  ⇒ refuse to spawn.
//   - caps.canExec === false (read-only-audit / quarantine) ⇒ refuse to spawn an exec-capable omp.
//   - caps.canNetwork === false on a NON-isolating backend  ⇒ refuse — a "network-off" profile that
//     cannot actually cut the network never silently runs networked.
//
// v1 scope note: bwrap here contains the NETWORK + process boundary (the ADR-0157 threat). The
// FILESYSTEM story stays with omp `--isolate` (ADR-0028: worktree / fuse-overlay / ProjFS), which is
// why $HOME is bound rw (omp session state, config, credentials live there). The mediated egress
// proxy for `canNetwork:true` profiles is wired in P-SANDBOX.2 (ADR-0166) via `ctx.proxy` — when a
// running proxy endpoint is supplied, `wrap` steers the child's DNS + HTTP(S) through it instead of
// unsharing the net. macOS Seatbelt is P-SANDBOX.4 (SeatbeltBackend, ADR-0168); Windows AppContainer
// (native) and Linux slirp raw-socket forwarding are their own follow-ups. Pure + hermetic: `which`
// is injectable and `ctx.proxy` is a plain path/URL record — nothing here touches the real system.

import { homedir } from "node:os";
import type { ProfileCaps } from "./profiles.ts";

/** Presence probe for a binary on PATH. Injectable so tests never depend on the host. */
export type WhichFn = (bin: string) => boolean;

const defaultWhich: WhichFn = (bin) => Bun.which(bin) != null;

export interface SandboxCtx {
  /** The workspace the agent works in — bound read-write inside the sandbox. */
  workspace: string;
  /** $HOME override (tests); defaults to os.homedir(). */
  home?: string;
  /** P-SANDBOX.2 (ADR-0166): the running loopback egress proxy for `canNetwork:true` profiles. When
   *  present, the sandbox steers the child's DNS + HTTP(S) egress THROUGH it (mediated) instead of
   *  granting raw network: a generated resolv.conf is bound over /etc/resolv.conf and HTTP(S)_PROXY is
   *  set. When ABSENT on a network-capable profile, `wrap` falls back to `--unshare-net` (network-off) —
   *  no mediator ⇒ no network, never raw unmediated egress (fail-closed, invariant #3). Only meaningful
   *  on an isolating backend; the passthrough discloses and ignores it. */
  proxy?: SandboxProxy;
}

/** The subset of the egress proxy's endpoint the sandbox needs to steer a child at it. Mirrors
 *  `EgressProxyEndpoint` (harness/runs/egress_proxy.ts) without importing it — the seam stays pure. */
export interface SandboxProxy {
  host: string;
  httpPort: number;
  /** `http://host:httpPort` — set as HTTP(S)_PROXY so libcurl/requests/pip tunnel through the proxy. */
  httpProxyUrl: string;
  /** Absolute path to the generated resolv.conf the proxy wrote at start(), bound read-only over
   *  /etc/resolv.conf to steer the child's stub resolver at us. OMITTED when the proxy could not claim a
   *  privileged :53 — DNS then stays with the host resolver and we mediate HTTP(S) only, with full
   *  in-namespace DNS steering completed in P-SANDBOX.4. When present, DNS is mediated too. */
  resolvConfPath?: string;
}

/** A concrete spawn plan: what to ACTUALLY exec. `env` entries are ADDED to the child env. */
export interface SandboxPlan {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

export interface SandboxBackend {
  readonly name: "bwrap" | "seatbelt" | "noop";
  /** true ⇒ this backend provides REAL OS-level containment (namespaces), not a passthrough. */
  readonly isolates: boolean;
  available(): boolean;
  /** Wrap `argv` (cmd + args) for `caps`. Callers MUST route through `wrapForProfile`, which owns
   *  the fail-closed refusals — `wrap` itself only builds the plan for an enforceable request. */
  wrap(argv: string[], caps: ProfileCaps, ctx: SandboxCtx): SandboxPlan;
}

/** Linux bubblewrap backend. Mount plan per ADR-0157: workspace rw, system paths ro(-try so a
 *  missing path never aborts), fresh proc/dev/tmp, die-with-parent, and — the enforcement bit —
 *  `--unshare-net` when the profile denies network (total deny; DNS included). */
export class BwrapBackend implements SandboxBackend {
  readonly name = "bwrap" as const;
  readonly isolates = true;
  constructor(private readonly which: WhichFn = defaultWhich) {}
  available(): boolean {
    return this.which("bwrap");
  }
  wrap(argv: string[], caps: ProfileCaps, ctx: SandboxCtx): SandboxPlan {
    const home = ctx.home ?? homedir();
    const args = [
      "--die-with-parent",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--ro-bind-try", "/usr", "/usr",
      "--ro-bind-try", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64",
      "--ro-bind-try", "/bin", "/bin",
      "--ro-bind-try", "/sbin", "/sbin",
      "--ro-bind-try", "/etc", "/etc",
      // omp session state / config / credentials; fs containment is omp --isolate's job (ADR-0028).
      "--bind-try", home, home,
      "--bind", ctx.workspace, ctx.workspace,
    ];
    const env: Record<string, string> = {};
    // P-SANDBOX.2 (ADR-0166): three network states for the wrap —
    //   (a) canNetwork:false           → --unshare-net (total deny; the DNS-TXT exfil dies at the syscall).
    //   (b) canNetwork:true + proxy     → MEDIATED: bind the generated resolv.conf over /etc/resolv.conf so
    //       the child's stub resolver targets the proxy, and set HTTP(S)_PROXY so pip/requests/curl tunnel
    //       through it. Every DNS/CONNECT is then decided by egressDecisionDetailed (the agent's own brain).
    //   (c) canNetwork:true + NO proxy  → fail-closed to --unshare-net: no mediator ⇒ no network, never raw
    //       unmediated egress (invariant #3). The live wiring only omits the proxy when it could not start.
    if (!caps.canNetwork) {
      args.push("--unshare-net");
    } else if (ctx.proxy) {
      env.HTTP_PROXY = env.HTTPS_PROXY = env.http_proxy = env.https_proxy = ctx.proxy.httpProxyUrl;
      // Loopback + our own hosts must bypass the HTTP proxy so the proxy's own upstream isn't self-tunnelled.
      env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1,::1";
      // Steer the stub resolver at us too WHEN we hold a privileged :53 (resolvConfPath present). The bind
      // is last-writer-wins over the /etc mount above (bwrap applies binds in order).
      if (ctx.proxy.resolvConfPath) args.push("--ro-bind", ctx.proxy.resolvConfPath, "/etc/resolv.conf");
    } else {
      args.push("--unshare-net");
    }
    args.push("--", ...argv);
    return { cmd: "bwrap", args, env };
  }
}

/** PURE: build the macOS Seatbelt (`sandbox-exec`) profile for `caps`/`ctx`. Mirrors the BwrapBackend
 *  network posture, but Seatbelt lets us do something bwrap can't cheaply: confine egress to LOOPBACK
 *  ONLY, so a raw-IP socket that ignores HTTP_PROXY is DENIED by the kernel (bwrap merely drops it via
 *  --unshare-net; the slirp funnel is still Linux follow-up work). FS stays permissive — filesystem
 *  containment remains omp `--isolate`'s job (ADR-0028), exactly as the bwrap plan binds $HOME rw.
 *
 *  Three network states, matching BwrapBackend:
 *   (a) canNetwork:false          → deny ALL network + deny mDNSResponder mach-lookup (DNS truly cut).
 *   (b) canNetwork:true + proxy    → deny outbound EXCEPT loopback (the proxy), set HTTP(S)_PROXY. Every
 *       TCP/HTTP reach-out is forced through the proxy or denied. (Residual: getaddrinfo still resolves
 *       via mDNSResponder, so a DNS-TXT *name* lookup can leak until a resolver interception lands — the
 *       macOS analogue of Linux's privileged-:53 item; recorded in ADR-0168.)
 *   (c) canNetwork:true + NO proxy → same total deny as (a): no mediator ⇒ no network (fail-closed). */
export function seatbeltProfile(caps: ProfileCaps, ctx: SandboxCtx): string {
  const lines = ["(version 1)", "(allow default)"];
  const mediated = caps.canNetwork && !!ctx.proxy;
  if (mediated) {
    // Confine egress to loopback so the ONLY route out is the proxy the harness runs.
    lines.push("(deny network-outbound)", '(allow network-outbound (remote ip "localhost:*"))', "(allow network-outbound (remote unix-socket))");
  } else {
    // network-off, or network-capable but unmediated (fail-closed): cut network AND DNS.
    lines.push("(deny network*)", '(deny mach-lookup (global-name "com.apple.mDNSResponder"))');
  }
  return lines.join("\n");
}

/** macOS Seatbelt backend (P-SANDBOX.4, ADR-0168): wrap the spawn in `sandbox-exec -p <profile>`. Real
 *  OS-level containment (the App Sandbox / TrustedBSD MAC layer), so `isolates` is true and a network-off
 *  profile genuinely cuts the network on macOS. `available()` = `sandbox-exec` on PATH (present on every
 *  supported macOS). Pure: `which` injectable, profile is a pure function of caps/ctx. */
export class SeatbeltBackend implements SandboxBackend {
  readonly name = "seatbelt" as const;
  readonly isolates = true;
  constructor(private readonly which: WhichFn = defaultWhich) {}
  available(): boolean {
    return this.which("sandbox-exec");
  }
  wrap(argv: string[], caps: ProfileCaps, ctx: SandboxCtx): SandboxPlan {
    const env: Record<string, string> = {};
    if (caps.canNetwork && ctx.proxy) {
      env.HTTP_PROXY = env.HTTPS_PROXY = env.http_proxy = env.https_proxy = ctx.proxy.httpProxyUrl;
      env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1,::1";
    }
    // `sandbox-exec -p <profile> <cmd> <args...>` — the wrapped argv is preserved verbatim as the tail.
    return { cmd: "sandbox-exec", args: ["-p", seatbeltProfile(caps, ctx), ...argv], env };
  }
}

/** The disclosed passthrough: identical spawn, zero containment. Callers MUST surface
 *  `sandboxDisclosure()` when this backend runs (the "loud signal" of ADR-0157). */
export class NoopBackend implements SandboxBackend {
  readonly name = "noop" as const;
  readonly isolates = false;
  available(): boolean {
    return true;
  }
  wrap(argv: string[]): SandboxPlan {
    return { cmd: argv[0]!, args: argv.slice(1), env: {} };
  }
}

/** The loud "you are not runtime-isolated" line — one set of bytes shared by every caller so the
 *  audit trail is greppable (mirrors the ext_parity discipline for the gate's block line). */
export function sandboxDisclosure(platform: NodeJS.Platform = process.platform): string {
  return (
    `[sandbox] exec is NOT runtime-isolated on this platform (${platform}) — no sandbox backend available. ` +
    `The argv gate + in-process scanner gate still apply (ADR-0157 P-SANDBOX.1; Linux bwrap + macOS Seatbelt lead, Windows AppContainer is a follow-up).`
  );
}

export type BackendResolution =
  | {
      ok: true;
      backend: SandboxBackend;
      /** true ⇒ passthrough in use; the caller MUST emit `sandboxDisclosure()`. */
      disclosed: boolean;
    }
  | { ok: false; reason: string };

export interface ResolveBackendOpts {
  platform?: NodeJS.Platform;
  /** Enterprise-managed `security.exec.requireIsolation` (ADR-0068, tighten-only). When true, an
   *  unavailable isolating backend is a REFUSAL, never a disclosed passthrough. */
  requireIsolation?: boolean;
  which?: WhichFn;
}

/** Pick the backend for this platform. PURE given its inputs (platform/which injectable). */
export function resolveBackend(opts: ResolveBackendOpts = {}): BackendResolution {
  const platform = opts.platform ?? process.platform;
  const which = opts.which ?? defaultWhich;
  if (platform === "linux") {
    const bwrap = new BwrapBackend(which);
    if (bwrap.available()) return { ok: true, backend: bwrap, disclosed: false };
  }
  if (platform === "darwin") {
    // P-SANDBOX.4 (ADR-0168): macOS gets real containment via Seatbelt (sandbox-exec ships with macOS).
    const seatbelt = new SeatbeltBackend(which);
    if (seatbelt.available()) return { ok: true, backend: seatbelt, disclosed: false };
  }
  if (opts.requireIsolation) {
    return {
      ok: false,
      reason:
        platform === "linux"
          ? "managed policy requires runtime isolation, but bwrap is not installed (install bubblewrap)"
          : platform === "darwin"
            ? "managed policy requires runtime isolation, but sandbox-exec is not available (macOS Seatbelt)"
            : `managed policy requires runtime isolation, but no sandbox backend exists for ${platform} yet (Windows AppContainer needs native support — tracked as a follow-up increment)`,
    };
  }
  return { ok: true, backend: new NoopBackend(), disclosed: true };
}

export type SandboxDecision =
  | { action: "spawn"; plan: SandboxPlan; isolated: boolean; disclosed: boolean }
  | { action: "refuse"; reason: string };

/**
 * The single decision point callers use at a spawn site. Owns every fail-closed rule so no caller
 * can accidentally treat "cannot isolate" as "run anyway" (invariant #3).
 */
export function wrapForProfile(o: {
  argv: string[];
  caps: ProfileCaps;
  ctx: SandboxCtx;
  resolution: BackendResolution;
}): SandboxDecision {
  if (!o.resolution.ok) return { action: "refuse", reason: o.resolution.reason };
  if (!o.caps.canExec) {
    return { action: "refuse", reason: "profile forbids exec (canExec=false) — refusing to spawn an exec-capable agent process" };
  }
  const { backend, disclosed } = o.resolution;
  if (!o.caps.canNetwork && !backend.isolates) {
    return {
      action: "refuse",
      reason:
        "profile requires network isolation (canNetwork=false) but no isolating backend is available — " +
        "refusing rather than running networked (fail-closed)",
    };
  }
  return { action: "spawn", plan: backend.wrap(o.argv, o.caps, o.ctx), isolated: backend.isolates, disclosed };
}
