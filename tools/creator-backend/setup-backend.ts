// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/creator-backend/setup-backend.ts - drive a remote GPU host into being a LUCID Creator backend.
//
// This runs on YOUR workstation and orchestrates five phases over SSH: preflight, provision, tunnel, verify,
// register. It is the scripted version of the docs walkthrough, so the two of us can do it once and repeat it
// on any host.
//
// Safety rules, all enforced in code below:
//   * ARGV ONLY. Every remote invocation is a fixed argv array. Nothing is interpolated into a shell string,
//     and a host/user/path containing shell metacharacters is REFUSED rather than escaped and hoped for.
//   * KEYS ONLY. `BatchMode=yes` means a host that would prompt for a password fails fast instead of hanging.
//   * LOOPBACK ONLY. The remote listens on 127.0.0.1; access is the SSH tunnel this script opens.
//   * NO SECRET ON A COMMAND LINE. The LUCID token used for the optional registration step is read from the
//     environment, never passed as an argument to the remote.
//   * DRY RUN FIRST. `--dry-run` prints every command it WOULD run, in order, and touches nothing.
//
// Usage:
//   bun run tools/creator-backend/setup-backend.ts --host gpu-box --dry-run
//   bun run tools/creator-backend/setup-backend.ts --host gpu-box --user me --port 8188
//   bun run tools/creator-backend/setup-backend.ts --host gpu-box --workflow ./graph.json --dcgm
//   LUCID_TOKEN=<per-launch token> bun run tools/creator-backend/setup-backend.ts --host gpu-box \
//     --lucid-port 5320 --register
//
// The host is whatever your SSH config calls it. This file deliberately hardcodes no machine name.

import { existsSync } from "node:fs";
import { join } from "node:path";

// ── options ─────────────────────────────────────────────────────────────────

export interface SetupOptions {
  readonly host: string;
  readonly user: string;
  /** ComfyUI port on the remote, and the local end of the tunnel. */
  readonly port: number;
  readonly remoteDir: string;
  readonly identity: string;
  readonly dryRun: boolean;
  readonly skipProvision: boolean;
  readonly skipVerify: boolean;
  readonly withDcgm: boolean;
  readonly skipTorch: boolean;
  readonly torchIndex: string;
  /** Your exported ComfyUI graph, for the full end-to-end verification. */
  readonly workflow: string;
  /** Register the endpoint in a running Creator engine (needs LUCID_TOKEN in the environment). */
  readonly register: boolean;
  readonly lucidPort: number;
}

// TWO guards, because there are two threat models here and one regex for both produces a FALSE refusal,
// which is as dishonest as a false success.
//
// REMOTE_UNSAFE guards values that reach the remote SHELL: ssh joins its trailing arguments into a command
// string that the remote login shell parses, so a metacharacter in a host, user, remote path, or index URL
// really can break out. Those are refused, never escaped.
const REMOTE_UNSAFE = /[;&|`$(){}<>\n\r\t"'\\*?[\]!#]/;
// LOCAL_UNSAFE guards values that only ever occupy a slot in an argv array WE spawn (an SSH key path, a
// workflow file). No shell parses those, so a backslash, a parenthesis, or a space is an ordinary character
// in an ordinary Windows path: `C:\Users\me\.ssh\id_ed25519` and `C:\Program Files (x86)\...` are VALID.
// Refusing them was a bug, not caution. What stays refused is what could never be a real path and would
// matter if a future caller ever did build a string: control characters, quotes, backtick, and `$`.
const LOCAL_UNSAFE = /[\n\r\t\0"'`$]/;

export type ParseResult = { ok: true; options: SetupOptions } | { ok: false; error: string };

export function parseArgs(argv: readonly string[]): ParseResult {
  const value = (name: string, fallback = ""): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback;
  };
  const flag = (name: string): boolean => argv.includes(`--${name}`);

  const host = value("host").trim();
  if (!host) return { ok: false, error: "--host is required (the SSH host or alias of the GPU machine)" };
  if (REMOTE_UNSAFE.test(host)) return { ok: false, error: "--host contains characters that are not valid in a hostname" };
  const user = value("user").trim();
  if (user && REMOTE_UNSAFE.test(user)) return { ok: false, error: "--user contains characters that are not valid in a username" };

  const portRaw = value("port", "8188");
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: `--port must be an integer between 1 and 65535 (got ${portRaw})` };

  const lucidRaw = value("lucid-port", "5320");
  const lucidPort = Number(lucidRaw);
  if (!Number.isInteger(lucidPort) || lucidPort < 1 || lucidPort > 65535) return { ok: false, error: `--lucid-port must be an integer between 1 and 65535 (got ${lucidRaw})` };

  // The remote directory is interpolated into the provisioner's command line on the far side, so it keeps
  // the strict guard.
  const remoteDir = value("remote-dir", "").trim();
  if (remoteDir && REMOTE_UNSAFE.test(remoteDir)) return { ok: false, error: "--remote-dir is a path on the REMOTE machine and must carry no shell characters" };
  // The key and the workflow are LOCAL paths that only ever sit in an argv slot, so a Windows path with
  // backslashes, spaces, or parentheses is accepted as written.
  const identity = value("identity", "").trim();
  if (identity && LOCAL_UNSAFE.test(identity)) return { ok: false, error: "--identity must be a plain local file path (no quotes or control characters)" };
  const torchIndex = value("torch-index", "https://download.pytorch.org/whl/cu130").trim();
  if (!/^https:\/\/[A-Za-z0-9./_-]+$/.test(torchIndex)) return { ok: false, error: "--torch-index must be a plain https URL" };
  const workflow = value("workflow", "").trim();
  if (workflow && LOCAL_UNSAFE.test(workflow)) return { ok: false, error: "--workflow must be a plain local file path (no quotes or control characters)" };

  return {
    ok: true,
    options: {
      host, user, port, lucidPort, remoteDir, identity, torchIndex, workflow,
      dryRun: flag("dry-run"),
      skipProvision: flag("skip-provision"),
      skipVerify: flag("skip-verify"),
      withDcgm: flag("dcgm"),
      skipTorch: flag("skip-torch"),
      register: flag("register"),
    },
  };
}

/** `user@host` when a user was given, else the bare host (so an SSH config alias keeps working). */
export const sshTarget = (o: SetupOptions): string => (o.user ? `${o.user}@${o.host}` : o.host);

const baseSshOptions = (o: SetupOptions): string[] => [
  "-o", "BatchMode=yes",      // keys only: a password prompt fails fast instead of hanging a script
  "-o", "ConnectTimeout=10",
  ...(o.identity ? ["-i", o.identity] : []),
];

/** A remote command as a FIXED argv. The remote command words are passed as separate argv entries, so
 *  nothing is ever concatenated into a shell string on this side. */
export function sshArgs(o: SetupOptions, remote: readonly string[]): string[] {
  return ["ssh", ...baseSshOptions(o), sshTarget(o), ...remote];
}

export function scpArgs(o: SetupOptions, localPath: string, remotePath: string): string[] {
  return ["scp", ...baseSshOptions(o), localPath, `${sshTarget(o)}:${remotePath}`];
}

/** The tunnel: local port -> the remote's loopback. `-N` = no remote command, this is a pipe only. */
export function tunnelArgs(o: SetupOptions): string[] {
  return ["ssh", ...baseSshOptions(o), "-N", "-L", `${o.port}:127.0.0.1:${o.port}`, sshTarget(o)];
}

/** One shell-free preflight command whose output `parsePreflight` reads. */
export const PREFLIGHT_REMOTE: readonly string[] = [
  "uname -m; uname -s; nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null || echo 'NO_NVIDIA_SMI'; python3 --version 2>&1 || echo 'NO_PYTHON'; command -v git >/dev/null && echo 'GIT_OK' || echo 'NO_GIT'; command -v systemctl >/dev/null && echo 'SYSTEMD_OK' || echo 'NO_SYSTEMD'",
];

export interface PreflightInfo {
  readonly arch: string;
  readonly os: string;
  readonly gpu: string;
  readonly driver: string;
  readonly memoryTotal: string;
  readonly python: string;
  readonly hasGit: boolean;
  readonly hasSystemd: boolean;
  readonly hasNvidiaSmi: boolean;
}

/** Read the preflight output. Every field is optional: a missing line becomes "", never a guess. */
export function parsePreflight(raw: string): PreflightInfo {
  const lines = (raw ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const arch = lines[0] ?? "";
  const os = lines[1] ?? "";
  const hasNvidiaSmi = !lines.includes("NO_NVIDIA_SMI");
  const gpuLine = hasNvidiaSmi ? (lines[2] ?? "") : "";
  const [gpu = "", driver = "", memoryTotal = ""] = gpuLine.split(",").map((c) => c.trim());
  const python = lines.find((l) => l.startsWith("Python ")) ?? "";
  return {
    arch, os, gpu, driver, memoryTotal, python,
    hasGit: lines.includes("GIT_OK"),
    hasSystemd: lines.includes("SYSTEMD_OK"),
    hasNvidiaSmi,
  };
}

export interface PreflightVerdict {
  readonly ok: boolean;
  readonly blockers: readonly string[];
  readonly notes: readonly string[];
}

/** Refuse only on things that genuinely stop the install; everything else is a note the user can read. */
export function preflightVerdict(info: PreflightInfo): PreflightVerdict {
  const blockers: string[] = [];
  const notes: string[] = [];
  if (!info.hasNvidiaSmi) blockers.push("no nvidia-smi on that host: ComfyUI needs an NVIDIA GPU");
  if (!info.python) blockers.push("no python3 on that host");
  if (!info.hasGit) blockers.push("no git on that host");
  if (info.os && info.os !== "Linux") notes.push(`the remote reports ${info.os}; these scripts assume a Linux host`);
  if (!info.hasSystemd) notes.push("no systemd: the provisioner will print a manual start command instead of installing a unit");
  if (info.arch === "aarch64") {
    notes.push("aarch64 host: the cu130 wheel index is the one carrying ARM CUDA 13 builds, which Blackwell (sm_121) requires");
  } else if (info.arch && info.arch !== "aarch64") {
    notes.push(`${info.arch} host: cu130 wheels exist for it too, but override --torch-index if your driver predates CUDA 13`);
  }
  if (info.gpu) notes.push(`gpu: ${info.gpu}${info.driver ? ` (driver ${info.driver})` : ""}${info.memoryTotal ? `, ${info.memoryTotal}` : ""}`);
  return { ok: blockers.length === 0, blockers, notes };
}

/** The remote provisioner invocation, argv only. */
export function provisionRemoteArgs(o: SetupOptions, scriptPath: string): string[] {
  const args = ["bash", scriptPath, "--port", String(o.port)];
  if (o.remoteDir) args.push("--dir", o.remoteDir);
  if (o.torchIndex) args.push("--torch-index", o.torchIndex);
  if (o.withDcgm) args.push("--dcgm");
  if (o.skipTorch) args.push("--skip-torch");
  if (o.dryRun) args.push("--dry-run");
  return args;
}

/** The verifier invocation. Probe-only unless the user supplied their own graph. */
export function verifyArgs(o: SetupOptions): string[] {
  const args = ["bun", "run", "harness/scripts/verify_creator_comfy.ts", "--url", `http://127.0.0.1:${o.port}`];
  if (o.workflow) args.push("--workflow", o.workflow);
  return args;
}

/** The endpoint DECLARATION LUCID stores: no secret, and the zone marks it as a tunnel/VPN reachable host. */
export function registerBody(o: SetupOptions): { endpoint: Record<string, unknown> } {
  return {
    endpoint: {
      id: `comfyui-${o.host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "remote"}`,
      providerId: "comfyui",
      label: `ComfyUI on ${o.host}`,
      baseUrl: `http://127.0.0.1:${o.port}`,
      zone: "internal",
      enabled: true,
    },
  };
}

// ── the run ─────────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT_LOCAL = join(REPO_ROOT, "tools", "creator-backend", "provision-comfyui.sh");
const SCRIPT_REMOTE = "/tmp/lucid-provision-comfyui.sh";

const say = (msg: string) => console.log(msg);
const step = (n: number, title: string) => console.log(`\n${n}) ${title}`);
const shown = (argv: readonly string[]) => argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");

async function runLocal(argv: readonly string[], opts: { dryRun: boolean; capture?: boolean }): Promise<{ code: number; out: string }> {
  say(`   $ ${shown(argv)}`);
  if (opts.dryRun) return { code: 0, out: "" };
  const proc = Bun.spawn([...argv], { cwd: REPO_ROOT, stdout: opts.capture ? "pipe" : "inherit", stderr: opts.capture ? "pipe" : "inherit" });
  const out = opts.capture ? await new Response(proc.stdout).text() : "";
  const code = await proc.exited;
  if (opts.capture && code !== 0) {
    const err = await new Response(proc.stderr).text();
    if (err.trim()) say(`   ! ${err.trim().split("\n").slice(0, 4).join("\n   ! ")}`);
  }
  return { code, out };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`setup-backend: ${parsed.error}\n`);
    console.error("  bun run tools/creator-backend/setup-backend.ts --host <ssh-host> [--user u] [--port 8188]");
    console.error("     [--dry-run] [--skip-provision] [--skip-verify] [--dcgm] [--skip-torch] [--workflow ./graph.json]");
    console.error("     [--register --lucid-port 5320]   (LUCID_TOKEN must be in the environment to register)");
    return 2;
  }
  const o = parsed.options;
  say(`LUCID Creator backend setup -> ${sshTarget(o)}${o.dryRun ? "  (DRY RUN: nothing will be executed)" : ""}`);
  say(`ComfyUI will listen on the remote's loopback:${o.port}, reached through an SSH tunnel.`);

  step(1, "preflight: what is that machine?");
  const pre = await runLocal(sshArgs(o, PREFLIGHT_REMOTE), { dryRun: o.dryRun, capture: true });
  if (o.dryRun) {
    say("   (dry run: skipping the verdict, since nothing was asked)");
  } else if (pre.code !== 0) {
    say("   FAIL - could not run a command on that host over SSH.");
    say("   Check: the host resolves, your key is loaded (BatchMode refuses password prompts), and you can `ssh <host> true`.");
    return 1;
  } else {
    const info = parsePreflight(pre.out);
    const verdict = preflightVerdict(info);
    for (const note of verdict.notes) say(`   note - ${note}`);
    for (const b of verdict.blockers) say(`   FAIL - ${b}`);
    if (!verdict.ok) return 1;
    say(`   ok   - ${info.os} ${info.arch}, ${info.python}`);
  }

  if (o.skipProvision) {
    step(2, "provision: skipped by request");
  } else {
    step(2, "provision: install or update headless ComfyUI (loopback only, no sudo)");
    if (!existsSync(SCRIPT_LOCAL)) { say(`   FAIL - ${SCRIPT_LOCAL} is missing`); return 1; }
    const copy = await runLocal(scpArgs(o, SCRIPT_LOCAL, SCRIPT_REMOTE), { dryRun: o.dryRun });
    if (!o.dryRun && copy.code !== 0) { say("   FAIL - could not copy the provisioner"); return 1; }
    const prov = await runLocal(sshArgs(o, provisionRemoteArgs(o, SCRIPT_REMOTE)), { dryRun: o.dryRun });
    if (!o.dryRun && prov.code !== 0) { say("   FAIL - the provisioner exited non-zero (its output is above)"); return 1; }
  }

  step(3, "tunnel: bring the remote loopback port to this machine");
  const tunnel = tunnelArgs(o);
  say(`   $ ${shown(tunnel)}`);
  let tunnelProc: ReturnType<typeof Bun.spawn> | null = null;
  if (!o.dryRun) {
    tunnelProc = Bun.spawn([...tunnel], { stdout: "pipe", stderr: "pipe" });
    let up = false;
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(250);
      try { if ((await fetch(`http://127.0.0.1:${o.port}/object_info`)).ok) { up = true; break; } } catch { /* not yet */ }
    }
    say(up ? `   ok   - http://127.0.0.1:${o.port} answers through the tunnel` : `   FAIL - nothing answered on 127.0.0.1:${o.port}`);
    if (!up) {
      say("   The tunnel may be fine while ComfyUI is still starting. On the remote: journalctl --user -u lucid-comfyui -f");
      try { tunnelProc.kill(); } catch { /* already gone */ }
      return 1;
    }
  }

  try {
    if (o.skipVerify) {
      step(4, "verify: skipped by request");
    } else {
      step(4, o.workflow ? "verify: full path, using your workflow template" : "verify: probe only (pass --workflow for the full path)");
      const ver = await runLocal(verifyArgs(o), { dryRun: o.dryRun });
      if (!o.dryRun && ver.code !== 0) { say("   FAIL - verification reported a problem (see above)"); return 1; }
    }

    step(5, "register: store the endpoint declaration in the running Creator engine");
    if (!o.register) {
      const body = registerBody(o);
      say("   skipped (pass --register). In the app: Creator Studio -> ComfyUI -> Connect, then");
      say(`   base URL http://127.0.0.1:${o.port}, zone internal, and paste your workflow template.`);
      say(`   Declaration that would be saved: ${JSON.stringify(body.endpoint)}`);
    } else {
      const token = (process.env.LUCID_TOKEN ?? "").trim();
      if (!token) {
        say("   FAIL - --register needs LUCID_TOKEN in the environment (read it from the running app's page).");
        return 1;
      }
      const body = registerBody(o);
      say(`   POST http://127.0.0.1:${o.lucidPort}/api/creator/endpoint  ${JSON.stringify(body.endpoint)}`);
      if (!o.dryRun) {
        const res = await fetch(`http://127.0.0.1:${o.lucidPort}/api/creator/endpoint`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-lucid-token": token },
          body: JSON.stringify(body),
        }).catch(() => null);
        const payload = res ? await res.json().catch(() => null) as { ok?: boolean; error?: string } | null : null;
        if (!payload?.ok) { say(`   FAIL - the engine refused the declaration: ${payload?.error ?? "no answer on that port"}`); return 1; }
        say("   ok   - declaration stored. Press Probe in Creator Studio to confirm what it proves.");
      }
    }
  } finally {
    if (tunnelProc) {
      say("\nThe tunnel is still open in this process. Keep it running while you use the backend;");
      say("close it with Ctrl+C, or run it yourself in a dedicated terminal:");
      say(`  ${shown(tunnelArgs(o))}`);
      await tunnelProc.exited;
    }
  }

  say(`\n${o.dryRun ? "DRY RUN COMPLETE - nothing was executed." : "BACKEND READY."}`);
  return 0;
}

// Importable for tests: only run the orchestration when invoked directly.
if (import.meta.main) process.exit(await main());
