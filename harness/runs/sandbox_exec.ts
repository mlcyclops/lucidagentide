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
// proxy for `canNetwork:true` profiles is P-SANDBOX.2; macOS Seatbelt / Windows AppContainer are
// P-SANDBOX.4. Pure + hermetic: `which` is injectable, nothing here touches the real system.

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
}

/** A concrete spawn plan: what to ACTUALLY exec. `env` entries are ADDED to the child env. */
export interface SandboxPlan {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

export interface SandboxBackend {
  readonly name: "bwrap" | "noop";
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
    if (!caps.canNetwork) args.push("--unshare-net");
    args.push("--", ...argv);
    return { cmd: "bwrap", args, env: {} };
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
    `The argv gate + in-process scanner gate still apply (ADR-0157 P-SANDBOX.1; Linux bwrap leads, macOS/Windows land in P-SANDBOX.4).`
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
  if (opts.requireIsolation) {
    return {
      ok: false,
      reason:
        platform === "linux"
          ? "managed policy requires runtime isolation, but bwrap is not installed (install bubblewrap)"
          : `managed policy requires runtime isolation, but no sandbox backend exists for ${platform} yet (P-SANDBOX.4)`,
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
