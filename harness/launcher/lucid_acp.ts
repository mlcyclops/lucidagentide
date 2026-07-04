#!/usr/bin/env bun
// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/launcher/lucid_acp.ts
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │  P-EXT.1 (ADR-0038) — `lucid acp`, the single sanctioned, FAIL-CLOSED     │
// │  ACP entrypoint. The trust anchor for the marketplace IDE extensions:     │
// │  the editor (the ACP *client*) spawns THIS, never bare `omp acp`.          │
// │                                                                           │
// │  It reproduces the EXACT gated command desktop/acp_backend.ts uses — omp  │
// │  with the in-process security gate (+ AskSage provider) and the same      │
// │  appended policy bytes — and FAIL-CLOSES at startup: if the gate is       │
// │  missing or the scanner sidecar is unreachable it refuses to start        │
// │  (exit non-zero), so the IDE shows "agent unavailable", never an ungated  │
// │  session. Holds invariants #3 (fail-closed) + #4 (gate in-process)        │
// │  regardless of extension code. See docs/EXT-SECURE-BUILD.md.              │
// └─────────────────────────────────────────────────────────────────────────┘

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { BUILD_POLICY, DELEGATION_POLICY } from "../prompt/assembler.ts";
import { ScannerClient, ScanUnavailableError } from "../security/scanner_client.ts";
import { runAgentFirewall } from "../mcp/agent_firewall.ts";

type Env = Record<string, string | undefined>;
const EXE = process.platform === "win32" ? ".exe" : "";
const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root. In a dev checkout / packaged resources/repo this file lives at <repo>/harness/launcher/.
 *  In a `bun build --compile` standalone `lucid` binary (P-EXT.4), import.meta is VIRTUALIZED, so the
 *  source-relative path is wrong — there we derive the repo from the real on-disk binary, which ships
 *  at <repo>/bin/lucid[.exe] (so repo = dirname(execPath)/..). */
export function repoRoot(): string {
  const fromSource = join(HERE, "..", "..");
  if (existsSync(join(fromSource, "harness", "omp", "security_extension.ts"))) return fromSource;
  return join(dirname(process.execPath), "..");
}

/** The desktop app's userData dir (Electron app.getPath('userData') == productName under the OS app-data
 *  root) — where first-run provisioning puts the scanner venv. The standalone launcher mirrors it so it
 *  can find that interpreter when an IDE (not Electron) spawned it. */
function userDataDir(): string {
  const home = homedir();
  if (process.platform === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "LucidAgentIDE");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "LucidAgentIDE");
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "LucidAgentIDE");
}

/** Point the scanner at the REAL on-disk sidecar + a usable Python, so the gate's fail-closed scan can
 *  actually run from a standalone/compiled launch. Best-effort: if no interpreter is found the preflight
 *  simply fails closed (never a false "safe"). Mutates `env` (and so the omp child inherits it). */
export function resolveScannerEnv(env: Env, repo: string): void {
  env.LUCID_SCANNER_DIR = join(repo, "scanner-sidecar");
  if (env.SCANNER_PYTHON && existsSync(env.SCANNER_PYTHON)) return;
  const py = process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
  for (const venv of [join(repo, "scanner-sidecar", ".venv"), join(userDataDir(), "runtimes", "scanner-venv")]) {
    const cand = join(venv, ...py);
    if (existsSync(cand)) { env.SCANNER_PYTHON = cand; return; }
  }
}

export interface LaunchAssets {
  repo: string;
  /** The security gate omp extension — MANDATORY (its absence is fail-closed). */
  gate: string;
  /** The AskSage gov-gateway provider extension — no-op without ASKSAGE_API_KEY. */
  asksage: string;
  /** Task-isolation config overlay (ADR-0028) — used only with --isolate. */
  acpConfig: string;
}

export function assets(repo: string = repoRoot()): LaunchAssets {
  const omp = (f: string) => join(repo, "harness", "omp", f);
  return { repo, gate: omp("security_extension.ts"), asksage: omp("asksage_extension.ts"), acpConfig: omp("acp_config.yml") };
}

/** Resolve the omp binary: explicit env → the bundled copy in the repo node_modules → the user's bun
 *  bin → bare `omp` on PATH. Mirrors acp_backend.ts ompBin(), and ALSO checks the bundled
 *  node_modules/.bin/omp that the desktop findOmp() misses (so a packaged launch needs no install). */
export function resolveOmp(env: Env = process.env, repo: string = repoRoot()): string {
  const candidates = [
    env.LUCID_OMP_BIN,
    join(repo, "node_modules", ".bin", `omp${EXE}`),
    join(homedir(), ".bun", "bin", `omp${EXE}`),
  ].filter((c): c is string => !!c);
  for (const c of candidates) if (existsSync(c)) return c;
  return "omp";
}

/** The appended policy, byte-identical to acp_backend.ts:124 (DELEGATION then BUILD). Reproducing
 *  these bytes exactly keeps the cache prefix stable across the desktop shell and the IDE (inv. #6). */
export const APPENDED_POLICY = `${DELEGATION_POLICY}\n\n${BUILD_POLICY}`;

export interface BuildArgsOpts {
  gate: string;
  /** Included when present; a missing asksage extension is not security-critical, so it's omitted, not fatal. */
  asksage?: string;
  acpConfig?: string;
  /** Opt-in task isolation (ADR-0028 containment). */
  isolate?: boolean;
}

/** Assemble the omp argv for the gated ACP session. The gate `-e` is mandatory and first. */
export function buildAcpArgs(o: BuildArgsOpts): string[] {
  const args = ["acp", "-e", o.gate];
  if (o.asksage) args.push("-e", o.asksage);
  if (o.isolate && o.acpConfig) args.push("--isolate", o.acpConfig);
  args.push("--append-system-prompt", APPENDED_POLICY);
  return args;
}

export interface PreflightResult { ok: boolean; reason?: string }

/** Probe the scanner sidecar: a trivial scan must succeed. ANY failure (dead sidecar, timeout,
 *  malformed reply) is fail-closed — the kill-the-sidecar guarantee, enforced at launch time. */
export async function probeScanner(timeoutMs = 4000): Promise<PreflightResult> {
  const client = new ScannerClient({ timeoutMs });
  try {
    client.start();
    await client.scan("lucid-acp-preflight");
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof ScanUnavailableError ? e.message : String(e) };
  } finally {
    client.stop();
  }
}

/** Fail-closed startup preflight: the gate extension must EXIST and the scanner must be REACHABLE.
 *  `scannerProbe` is injectable so the gate cannot be bypassed and so tests need no live sidecar. */
export async function preflight(o: { gate: string; scannerProbe?: () => Promise<PreflightResult> }): Promise<PreflightResult> {
  if (!existsSync(o.gate)) return { ok: false, reason: `security gate extension missing: ${o.gate}` };
  const scan = await (o.scannerProbe ?? probeScanner)();
  if (!scan.ok) return { ok: false, reason: `scanner sidecar unreachable: ${scan.reason ?? "unknown"}` };
  return { ok: true };
}

interface SpawnedLike { on(ev: "exit" | "error", cb: (arg: any) => void): void }
export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string; stdio: "inherit"; env: Env }) => SpawnedLike;

export interface RunAcpOpts {
  cwd?: string;
  isolate?: boolean;
  env?: Env;
  /** Injectable for tests; defaults to the real sidecar probe. */
  scannerProbe?: () => Promise<PreflightResult>;
  /** Injectable for tests; defaults to node child_process.spawn. */
  spawnFn?: SpawnFn;
  stderr?: (s: string) => void;
}

/**
 * Run `lucid acp`: preflight (fail-closed), then exec the gated omp over INHERITED stdio (a transparent
 * ACP passthrough between the IDE and omp). Returns the child's exit code. On preflight failure it
 * returns 1 and NEVER spawns omp — the IDE sees the process die and shows "agent unavailable", which is
 * the whole point: installing an untrusted extension can never produce an ungated agent.
 */
export async function runAcp(o: RunAcpOpts = {}): Promise<number> {
  const env = o.env ?? process.env;
  const err = o.stderr ?? ((s) => void process.stderr.write(s));
  const a = assets();

  // Real path only (tests inject scannerProbe): point the scanner at the on-disk sidecar + interpreter
  // so the fail-closed probe can actually run from a standalone/compiled launch. The omp child inherits it.
  if (!o.scannerProbe) resolveScannerEnv(process.env, a.repo);

  const pf = await preflight({ gate: a.gate, scannerProbe: o.scannerProbe });
  if (!pf.ok) {
    err(`[lucid acp] FAIL-CLOSED: ${pf.reason}\n[lucid acp] refusing to start — the Lucid security gate must be loaded (never an ungated agent).\n`);
    return 1;
  }

  const omp = resolveOmp(env, a.repo);
  const asksage = existsSync(a.asksage) ? a.asksage : undefined;
  const args = buildAcpArgs({ gate: a.gate, asksage, acpConfig: a.acpConfig, isolate: o.isolate });
  const cwd = o.cwd ?? env.LUCID_WORKSPACE ?? process.cwd();
  const spawnFn = o.spawnFn ?? ((c, ar, op) => nodeSpawn(c, ar, op as never) as unknown as SpawnedLike);

  const child = spawnFn(omp, args, { cwd, stdio: "inherit", env });
  return await new Promise<number>((resolve) => {
    child.on("exit", (code: number | null) => resolve(code ?? 0));
    child.on("error", (e: unknown) => { err(`[lucid acp] failed to launch omp: ${String(e)}\n`); resolve(127); });
  });
}

/** CLI entry. `lucid acp [--isolate]` starts the gated session; `lucid check` runs the fail-closed
 *  preflight and exits (a diagnostic the IDE / installer can use); anything else prints usage. */
export async function main(argv: string[], env: Env = process.env): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "check") {
    const a = assets();
    resolveScannerEnv(process.env, a.repo);
    const pf = await preflight({ gate: a.gate });
    process.stdout.write(pf.ok ? "[lucid check] OK — gate + scanner ready\n" : `[lucid check] FAIL-CLOSED — ${pf.reason}\n`);
    return pf.ok ? 0 : 1;
  }
  if (sub === "agent-firewall") {
    const ci = rest.indexOf("--conn");
    const connId = ci >= 0 ? rest[ci + 1] : undefined;
    if (!connId) { process.stderr.write("usage: lucid agent-firewall --conn <id>\n"); return 2; }
    // Point the scanner at the real on-disk sidecar so the fail-closed gate runs from a standalone launch.
    resolveScannerEnv(process.env, assets().repo);
    await runAgentFirewall(connId); // long-lived: resolves only when the process is signalled to exit
    return 0;
  }
  if (sub !== "acp") {
    process.stderr.write(
      "usage: lucid acp [--isolate] | lucid check | lucid agent-firewall --conn <id>\n" +
        "  acp             Start the gated Lucid ACP agent (omp + the in-process security gate) for an IDE client.\n" +
        "  check           Run the fail-closed preflight (gate + scanner) and exit 0 (ready) / 1 (unavailable).\n" +
        "  agent-firewall  Serve the stdio MCP firewall proxy to a remote ACP agent (hermes/openclaw) — ADR-0135.\n" +
        "  Fail-closed: `acp` refuses to start if the gate or scanner sidecar is unavailable.\n",
    );
    return sub === undefined || sub === "-h" || sub === "--help" ? 0 : 2;
  }
  return runAcp({ isolate: rest.includes("--isolate"), env });
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => { process.stderr.write(`[lucid acp] fatal: ${String(e)}\n`); process.exit(1); });
}
