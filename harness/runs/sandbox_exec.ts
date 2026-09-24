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
// unsharing the net. macOS Seatbelt is P-SANDBOX.4 (SeatbeltBackend, ADR-0168); Windows AppContainer is
// P-SANDBOX.6 (AppContainerBackend, ADR-0172) — the SEAM + flag contract for the first-party
// `lucid-appcontainer` helper land here; the native helper itself + Linux slirp raw-socket forwarding are
// follow-ups. Pure + hermetic: `which` is injectable and `ctx.proxy` is a plain path/URL record.

import { homedir, tmpdir } from "node:os";
import { win32 as win32Path } from "node:path";
import type { ProfileCaps } from "./profiles.ts";

/** Presence probe for a binary on PATH. Injectable so tests never depend on the host. */
export type WhichFn = (bin: string) => boolean;

const defaultWhich: WhichFn = (bin) => Bun.which(bin) != null;

/** FUNCTIONAL probe: presence on PATH is not capability. Injectable so tests never depend on the
 *  host kernel. See `defaultProbe` for why this exists at all. */
export type ProbeFn = (bin: string) => boolean;

/** Cache the functional probe per binary: resolveBackend runs at every omp spawn and the probe
 *  costs a process. Host capability does not change within a run. */
const probeCache = new Map<string, boolean>();

/** Does `bwrap` actually WORK here, not merely exist?
 *
 *  Ubuntu/Debian 24.04+ ship bubblewrap on PATH but restrict unprivileged user namespaces via
 *  AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`). bwrap then fails at startup with
 *  "setting up uid map: Permission denied" — AFTER we've committed to it as the backend. A
 *  presence-only probe therefore selected a backend that killed every wrapped child: `omp acp`
 *  never came up, the ACP session never opened, `configOptions` stayed empty and the picker fell
 *  back to its hardcoded Anthropic list — OpenAI/xAI models silently absent on a correctly
 *  OAuth'd box. Run the smallest real sandbox to find out, once. */
const defaultProbe: ProbeFn = (bin) => {
  const cached = probeCache.get(bin);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    ok = Bun.spawnSync({ cmd: [bin, "--ro-bind", "/", "/", "true"], stdout: "ignore", stderr: "ignore", stdin: "ignore" }).exitCode === 0;
  } catch {
    ok = false; // binary vanished between which() and here, or is not executable
  }
  probeCache.set(bin, ok);
  return ok;
};

/** Does `sandbox-exec` actually WORK here, not merely exist?
 *
 *  sandbox-exec ships on every macOS, so a presence-only check always selects Seatbelt. But a
 *  LUCID that is itself running under a sandbox (a sandboxed parent process: CI runners, MDM
 *  wrappers, a LUCID dev build launched from inside another agent's gated shell) cannot NEST a
 *  Seatbelt profile: the wrapped child dies instantly with "sandbox_apply: Operation not
 *  permitted" (exit 71). That is the exact bwrap failure mode above wearing macOS clothes:
 *  `omp acp` never comes up, the ACP session never opens, configOptions stays empty and the
 *  model picker sits blank on a correctly-authed box. Run the smallest real profile once to
 *  find out; cached per run (host capability does not change within a run). */
const seatbeltDefaultProbe: ProbeFn = (bin) => {
  const cached = probeCache.get(bin);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    ok = Bun.spawnSync({ cmd: [bin, "-p", "(version 1)(allow default)", "/usr/bin/true"], stdout: "ignore", stderr: "ignore", stdin: "ignore" }).exitCode === 0;
  } catch {
    ok = false; // binary vanished between which() and here, or is not executable
  }
  probeCache.set(bin, ok);
  return ok;
};

/** Does `lucid-appcontainer` actually WORK here, not merely exist?
 *
 *  Same doctrine as bwrap/Seatbelt above: presence is not capability. The helper can exist yet be
 *  unable to contain — `CreateAppContainerProfile` denied (mandatory-profile policy), a blocked
 *  DLL load, or a filesystem-ACL grant refused on this host. The helper is FAIL-CLOSED (a child
 *  it cannot contain never runs), so committing to it without a probe reproduces the exact
 *  bwrap-on-Ubuntu-24.04 failure: every wrapped spawn dies and the session never opens. Run the
 *  smallest real container once inside a throwaway workspace, cached per run.
 *
 *  P-SANDBOX.9 (ADR-0384): the probe is a STDIO ROUND TRIP, not `cmd /c exit 0`. The omp child speaks
 *  ACP over stdin/stdout, and a helper that never wired its std handles into the container still exits
 *  0 on `exit 0`: that is how beta.7 lit the green pill and then every turn died with "agent process
 *  exited (code 1)" and no stderr. A contained child must ECHO a marker back through our pipe. A helper
 *  that cannot (a stale build, a host that refuses the handle list) is not committed to. */
export const APPCONTAINER_PROBE_MARKER = "lucid-appcontainer-stdio-ok";
export function appContainerProbeArgv(bin: string, workspace: string): string[] {
  return [bin, "--workspace", workspace, "--deny-network", "--", "cmd", "/c", `echo ${APPCONTAINER_PROBE_MARKER}`];
}
/** PURE: did the probe run AND carry the child's stdout back to us? */
export function appContainerProbePassed(r: { exitCode: number | null; stdout: string }): boolean {
  return r.exitCode === 0 && r.stdout.includes(APPCONTAINER_PROBE_MARKER);
}
const appContainerDefaultProbe: ProbeFn = (bin) => {
  const cached = probeCache.get(bin);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const r = Bun.spawnSync({ cmd: appContainerProbeArgv(bin, tmpdir()), stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    ok = appContainerProbePassed({ exitCode: r.exitCode, stdout: r.stdout.toString() });
  } catch {
    ok = false; // binary vanished between which() and here, or is not executable
  }
  probeCache.set(bin, ok);
  return ok;
};

/** The stable AppContainer moniker every LUCID-contained child runs under (mirrors the helper's
 *  APPCONTAINER_NAME — one name so ACL grants, WFP state and the loopback exemption all attribute
 *  to the same SID). */
export const APPCONTAINER_MONIKER = "LucidAgentIDE.Sandbox.v1";

/** PURE: does a `CheckNetIsolation LoopbackExempt -s` listing exempt our AppContainer?
 *  AppContainers are denied loopback BY DEFAULT, and mediated (network-on) profiles reach the egress
 *  proxy ONLY over loopback — so without this exemption an isolated network-on child has no route to
 *  ANYTHING (provider APIs included). Listing needs no elevation; REGISTERING does
 *  (`lucid-appcontainer --register-loopback`, ADR-0174, one-time per host). Matching is
 *  case-insensitive: CheckNetIsolation prints monikers lowercased. */
export function listingExemptsMoniker(listing: string, moniker: string = APPCONTAINER_MONIKER): boolean {
  return listing.toLowerCase().includes(moniker.toLowerCase());
}

let loopbackExemptCache: boolean | undefined;

/** Is the exemption registered on THIS host? Cached per run (a WFP config change mid-run is not a
 *  supported flow — restart the app after `--register-loopback`). Never throws: an unreadable
 *  listing means "not exempt", which degrades to the disclosed passthrough, never to a dead child. */
export function loopbackExempted(): boolean {
  if (loopbackExemptCache !== undefined) return loopbackExemptCache;
  let ok = false;
  try {
    const r = Bun.spawnSync({ cmd: ["CheckNetIsolation.exe", "LoopbackExempt", "-s"], stdin: "ignore", stderr: "ignore" });
    ok = r.exitCode === 0 && listingExemptsMoniker(r.stdout.toString());
  } catch {
    ok = false;
  }
  loopbackExemptCache = ok;
  return ok;
}

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
  /** P-SANDBOX.9 (ADR-0384): extra dirs the contained child must READ+EXECUTE (the app's own repo tree,
   *  the bun runtime the omp shim launches). Only the AppContainer backend consumes these: an
   *  AppContainer can read NOTHING its SID was not granted, unlike bwrap/Seatbelt's read-only host view. */
  grantRx?: string[];
  /** P-SANDBOX.9: extra dirs the contained child must READ+WRITE (omp's own state dir, ~/.omp). */
  grantRw?: string[];
  /** P-SANDBOX.9: TEMP/TMP for the contained child. The user's %TEMP% is not granted to the container,
   *  so bun and omp need a temp dir inside a granted rw tree. AppContainer only. */
  tmpDir?: string;
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

/** PURE: the env that steers a contained child's egress at the mediating proxy. P-SANDBOX.9 (ADR-0384):
 *  HTTP(S)_PROXY alone is NOT enough for omp. omp 18 installs its process-wide proxied `fetch` (and the
 *  per-provider inference transport) from PI_PROXY / PI_PROXY_<PROVIDER> only, and never consults
 *  HTTP(S)_PROXY there. Under bwrap/Seatbelt that was invisible (a direct dial still had a route); under
 *  a capability-less AppContainer a direct dial is kernel-dropped, so the chat died with a green pill.
 *  ALL_PROXY covers the remaining clients that read only that. Loopback always bypasses the proxy. */
export function proxyChildEnv(httpProxyUrl: string): Record<string, string> {
  const env: Record<string, string> = {};
  env.HTTP_PROXY = env.HTTPS_PROXY = env.http_proxy = env.https_proxy = httpProxyUrl;
  env.PI_PROXY = env.ALL_PROXY = env.all_proxy = httpProxyUrl;
  env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1,::1";
  return env;
}

/** PURE: the dirs a contained omp needs beyond its workspace, for the AppContainer backend (P-SANDBOX.9,
 *  ADR-0384). An AppContainer child can read NOTHING its SID was not granted, and the helper only granted
 *  the workspace plus the directory of the exe it launches (`node_modules\.bin`). The omp shim there then
 *  needs the bun runtime it execs, the `@oh-my-pi` package and our `-e` extensions (the repo tree), and
 *  omp + our extensions keep ALL their state under ~/.omp (sessions, agent.db, auth, audit logs).
 *    rx: the repo root; the bun runtime's dir; an omp installed OUTSIDE the repo (the managed
 *        `bun add -g` tree or ~/.bun) by its install root, two levels above `bin\omp.exe`.
 *    rw: ~/.omp. tmp: ~/.omp/lucid-sandbox-tmp (the user's %TEMP% is not granted).
 *  Windows paths via path.win32, so the rule is testable on any host. Deduped case-insensitively. */
export function appContainerRuntimeGrants(i: { repoRoot: string; home: string; bunBin?: string | null; ompBin?: string | null }): {
  grantRx: string[];
  grantRw: string[];
  tmpDir: string;
} {
  const w = win32Path;
  const under = (child: string, parent: string) => {
    const rel = w.relative(parent, child);
    return !!rel && !rel.startsWith("..") && !w.isAbsolute(rel);
  };
  const rx = [i.repoRoot];
  if (i.bunBin && w.isAbsolute(i.bunBin)) rx.push(w.dirname(i.bunBin));
  if (i.ompBin && w.isAbsolute(i.ompBin) && !under(i.ompBin, i.repoRoot)) rx.push(w.dirname(w.dirname(i.ompBin)));
  const seen = new Set<string>();
  const grantRx = rx.filter((d) => {
    const k = w.normalize(d).replace(/\\+$/, "").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const ompHome = w.join(i.home, ".omp");
  return { grantRx, grantRw: [ompHome], tmpDir: w.join(ompHome, "lucid-sandbox-tmp") };
}

/** A concrete spawn plan: what to ACTUALLY exec. `env` entries are ADDED to the child env. */
export interface SandboxPlan {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

export interface SandboxBackend {
  readonly name: "bwrap" | "seatbelt" | "appcontainer" | "noop";
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
  constructor(private readonly which: WhichFn = defaultWhich, private readonly probe: ProbeFn = defaultProbe) {}
  /** Presence AND capability — a bwrap that cannot unshare a user namespace is not a backend. */
  available(): boolean {
    return this.which("bwrap") && this.probe("bwrap");
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
      // Loopback + our own hosts bypass the HTTP proxy so the proxy's own upstream isn't self-tunnelled.
      Object.assign(env, proxyChildEnv(ctx.proxy.httpProxyUrl));
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
 *  supported macOS) AND functionally able to apply a profile (a sandboxed parent cannot nest Seatbelt,
 *  see seatbeltDefaultProbe). Pure: `which`/`probe` injectable, profile is a pure function of caps/ctx. */
export class SeatbeltBackend implements SandboxBackend {
  readonly name = "seatbelt" as const;
  readonly isolates = true;
  constructor(private readonly which: WhichFn = defaultWhich, private readonly probe: ProbeFn = seatbeltDefaultProbe) {}
  /** Presence AND capability - a sandbox-exec that cannot apply a profile is not a backend. */
  available(): boolean {
    return this.which("sandbox-exec") && this.probe("sandbox-exec");
  }
  wrap(argv: string[], caps: ProfileCaps, ctx: SandboxCtx): SandboxPlan {
    const env: Record<string, string> = {};
    if (caps.canNetwork && ctx.proxy) {
      Object.assign(env, proxyChildEnv(ctx.proxy.httpProxyUrl));
    }
    // `sandbox-exec -p <profile> <cmd> <args...>` — the wrapped argv is preserved verbatim as the tail.
    return { cmd: "sandbox-exec", args: ["-p", seatbeltProfile(caps, ctx), ...argv], env };
  }
}

/** PURE: the flag list for the first-party `lucid-appcontainer` helper (P-SANDBOX.6, ADR-0172). Windows
 *  has NO argv-wrapper for AppContainer (unlike bwrap / sandbox-exec) - it requires a native
 *  `CreateProcess` with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, which does not fit the seam's
 *  `wrap → {cmd,args,env}` contract. So we introduce a THIN first-party native helper that DOES fit the
 *  contract (`lucid-appcontainer <flags> -- <argv>`): it spawns the child inside a low-capability
 *  AppContainer + a per-child WFP egress rule. This function is the flags half - the SAME three network
 *  states as bwrap / Seatbelt - and is unit-tested here; the native helper that consumes them is the
 *  P-SANDBOX.7 follow-up (ADR-0172 phasing). Until it ships, `available()` is false ⇒ disclosed passthrough. */
export function appContainerArgs(caps: ProfileCaps, ctx: SandboxCtx): string[] {
  const args = ["--workspace", ctx.workspace]; // bound read-write inside the container (fs stays omp --isolate's job)
  if (ctx.home) args.push("--home", ctx.home);
  for (const d of ctx.grantRx ?? []) args.push("--grant-rx", d);
  for (const d of ctx.grantRw ?? []) args.push("--grant-rw", d);
  if (ctx.tmpDir) args.push("--grant-rw", ctx.tmpDir);
  if (!caps.canNetwork) {
    args.push("--deny-network"); // total deny (WFP blocks all outbound for the container SID)
  } else if (ctx.proxy) {
    // Mediated: only loopback (the proxy) is permitted out; everything else is WFP-denied, so a raw-IP
    // socket ignoring HTTP_PROXY is blocked (the same loopback-confinement Seatbelt achieves on macOS).
    args.push("--loopback-only");
  } else {
    args.push("--deny-network"); // fail-closed: no mediator ⇒ no network (invariant #3)
  }
  return args;
}

/** Windows AppContainer backend (P-SANDBOX.6, ADR-0172) via the first-party `lucid-appcontainer` helper.
 *  Real OS-level containment (AppContainer SID + workspace/tool-dir ACL grants + capability-less network).
 *  `isolates` is true; `helper` is either the bare name (PATH lookup, the dev loop after
 *  `make build-appcontainer`) or the ABSOLUTE packaged path (`<repo>/bin/lucid-appcontainer.exe`, shipped
 *  by P-SANDBOX.7 inside the `repo` extraResources — the caller resolves it via repo_root, ADR-0356).
 *  `available()` = presence AND a functional probe (the smallest real container), same
 *  presence-is-not-capability doctrine as bwrap/Seatbelt. Pure: `which`/`probe` injectable. */
export class AppContainerBackend implements SandboxBackend {
  readonly name = "appcontainer" as const;
  readonly isolates = true;
  constructor(
    private readonly which: WhichFn = defaultWhich,
    private readonly helper = "lucid-appcontainer",
    private readonly probe: ProbeFn = appContainerDefaultProbe,
  ) {}
  available(): boolean {
    return this.which(this.helper) && this.probe(this.helper);
  }
  wrap(argv: string[], caps: ProfileCaps, ctx: SandboxCtx): SandboxPlan {
    const env: Record<string, string> = {};
    if (caps.canNetwork && ctx.proxy) {
      Object.assign(env, proxyChildEnv(ctx.proxy.httpProxyUrl));
    }
    if (ctx.tmpDir) env.TEMP = env.TMP = ctx.tmpDir;
    // `lucid-appcontainer <flags> -- <cmd> <args...>` — the wrapped argv is preserved verbatim after `--`.
    return { cmd: this.helper, args: [...appContainerArgs(caps, ctx), "--", ...argv], env };
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
    `The argv gate + in-process scanner gate still apply (ADR-0157 P-SANDBOX.1; Linux bwrap + macOS Seatbelt lead; Windows AppContainer needs a WORKING lucid-appcontainer helper — missing here, or it failed its containment probe).`
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
  probe?: ProbeFn;
  /** P-SANDBOX.7: absolute path to the packaged `lucid-appcontainer.exe` when the caller has one
   *  (desktop resolves `<repo>/bin/lucid-appcontainer.exe` via repo_root and passes it ONLY when it
   *  exists on disk). Absent ⇒ bare-name PATH lookup, which is the dev loop. */
  appContainerHelper?: string;
}

/** Pick the backend for this platform. PURE given its inputs (platform/which/probe injectable). */
export function resolveBackend(opts: ResolveBackendOpts = {}): BackendResolution {
  const platform = opts.platform ?? process.platform;
  const which = opts.which ?? defaultWhich;
  const probe = opts.probe ?? defaultProbe;
  if (platform === "linux") {
    const bwrap = new BwrapBackend(which, probe);
    if (bwrap.available()) return { ok: true, backend: bwrap, disclosed: false };
  }
  if (platform === "darwin") {
    // P-SANDBOX.4 (ADR-0168): macOS gets real containment via Seatbelt (sandbox-exec ships with macOS).
    // Presence AND capability: a sandboxed parent (CI runner, MDM wrapper, a dev build launched from
    // another agent's gated shell) cannot nest a profile - sandbox_apply fails and the wrapped child
    // dies at spawn, which is the bwrap-on-Ubuntu-24.04 silent-kill bug on macOS (see seatbeltDefaultProbe).
    const seatbelt = new SeatbeltBackend(which, opts.probe ?? seatbeltDefaultProbe);
    if (seatbelt.available()) return { ok: true, backend: seatbelt, disclosed: false };
  }
  if (platform === "win32") {
    // P-SANDBOX.6/.7 (ADR-0172/0173): Windows gets containment via the first-party `lucid-appcontainer`
    // helper — the packaged absolute path when the caller resolved one, else PATH (dev loop). The
    // functional probe keeps a present-but-incapable helper from being committed to (bwrap doctrine).
    const ac = new AppContainerBackend(which, opts.appContainerHelper ?? "lucid-appcontainer", opts.probe ?? appContainerDefaultProbe);
    if (ac.available()) return { ok: true, backend: ac, disclosed: false };
  }
  if (opts.requireIsolation) {
    return {
      ok: false,
      reason:
        platform === "linux"
          ? which("bwrap")
            ? "managed policy requires runtime isolation, but bwrap cannot create a user namespace on this host — Ubuntu/Debian 24.04+ block unprivileged user namespaces via AppArmor (allow with `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or ship an AppArmor profile for bwrap)"
            : "managed policy requires runtime isolation, but bwrap is not installed (install bubblewrap)"
          : platform === "darwin"
            ? which("sandbox-exec")
              ? "managed policy requires runtime isolation, but sandbox-exec cannot apply a Seatbelt profile in this environment - this process is itself running under a sandbox (nested profiles are not permitted); launch LUCID from Finder or an unsandboxed shell"
              : "managed policy requires runtime isolation, but sandbox-exec is not available (macOS Seatbelt)"
            : platform === "win32"
              ? which(opts.appContainerHelper ?? "lucid-appcontainer")
                ? "managed policy requires runtime isolation, but the lucid-appcontainer helper failed its containment probe on this host — the smallest real AppContainer could not be established (profile creation or the workspace ACL grant refused); exec would be fail-closed blocked by the helper anyway"
                : "managed policy requires runtime isolation, but the lucid-appcontainer helper is not installed (Windows AppContainer; `<repo>/bin/lucid-appcontainer.exe`, built by `make build-appcontainer`)"
              : `managed policy requires runtime isolation, but no sandbox backend exists for ${platform} yet`,
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
