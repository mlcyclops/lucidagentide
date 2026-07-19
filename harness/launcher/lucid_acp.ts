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
import { formatStats, rateLimits, sessionStats } from "../../tools/session_metrics.ts";
import { runKb } from "../../tools/kb_cli.ts";
import { runBlocks } from "../../tools/blocks_cli.ts";
import { resolveBackend, sandboxDisclosure, wrapForProfile, type BackendResolution, type SandboxProxy } from "../runs/sandbox_exec.ts";
import { ensureEgressProxy } from "../runs/egress_proxy.ts"; // P-SANDBOX.2 (ADR-0166)
import { egressAuditSink } from "../../desktop/egress_audit.ts"; // P-SANDBOX.3 (ADR-0167)
import { caps } from "../runs/profiles.ts";
import { managedConfig, managedRequireIsolation } from "../../desktop/managed_config.ts";

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
  /** The MCP tool-result gate omp extension (P-MCP-GATE.1) — scans/withholds external MCP output. */
  mcpResultGate: string;
  /** The AskSage gov-gateway provider extension — no-op without ASKSAGE_API_KEY. */
  asksage: string;
  /** The LUCID skin extension (P-THEME.1) — cosmetic, fail-open; skins the TUI session only. */
  lucidTheme: string;
  /** Task-isolation config overlay (ADR-0028) — used only with --isolate. */
  acpConfig: string;
}

export function assets(repo: string = repoRoot()): LaunchAssets {
  const omp = (f: string) => join(repo, "harness", "omp", f);
  return { repo, gate: omp("security_extension.ts"), asksage: omp("asksage_extension.ts"), acpConfig: omp("acp_config.yml"), mcpResultGate: omp("mcp_result_gate.ts"), lucidTheme: omp("lucid_theme_extension.ts") };
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
  /** The MCP tool-result gate extension (P-MCP-GATE.1); included when present. */
  mcpResultGate?: string;
  /** Opt-in task isolation (ADR-0028 containment). */
  isolate?: boolean;
}

/** Assemble the omp argv for the gated ACP session. The gate `-e` is mandatory and first. */
export function buildAcpArgs(o: BuildArgsOpts): string[] {
  const args = ["acp", "-e", o.gate];
  if (o.mcpResultGate) args.push("-e", o.mcpResultGate);
  if (o.asksage) args.push("-e", o.asksage);
  if (o.isolate && o.acpConfig) args.push("--isolate", o.acpConfig);
  args.push("--append-system-prompt", APPENDED_POLICY);
  return args;
}

export interface BuildTuiOpts {
  gate: string;
  /** Included when present; a missing asksage extension is not security-critical, so it's omitted, not fatal. */
  asksage?: string;
  /** The MCP tool-result gate extension (P-MCP-GATE.1, ADR-0152); included when present so `lucid tui`
   *  scans external MCP tool results exactly like `lucid acp`. */
  mcpResultGate?: string;
  /** The LUCID skin extension (P-THEME.1, ADR-0160); included when present so the gated terminal wears
   *  the brand theme. Cosmetic + fail-open — never load-bearing, so absence is fine. */
  lucidTheme?: string;
  /** omp args appended verbatim after the gated flags (initial prompt, --model, --continue, --resume, -p). */
  passthru?: string[];
}

/** Assemble the omp argv for the gated INTERACTIVE terminal session. Same gated `-e` extensions (gate
 *  first) + byte-identical appended policy as `buildAcpArgs`, but WITHOUT the `acp` subcommand — so omp
 *  runs its native TUI. User passthru args come last (omp reads them as flags + the initial prompt). */
export function buildTuiArgs(o: BuildTuiOpts): string[] {
  const args = ["-e", o.gate];
  if (o.mcpResultGate) args.push("-e", o.mcpResultGate);
  if (o.asksage) args.push("-e", o.asksage);
  if (o.lucidTheme) args.push("-e", o.lucidTheme);
  args.push("--append-system-prompt", APPENDED_POLICY);
  if (o.passthru?.length) args.push(...o.passthru);
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
  /** Injectable for tests; defaults to the real platform/PATH/managed-policy resolution (ADR-0157). */
  sandbox?: BackendResolution;
  /** Injectable for tests; defaults to starting the real mediated-egress proxy (ADR-0166). */
  proxyStart?: ProxyStartFn;
  stderr?: (s: string) => void;
}

/** ADR-0157 (P-SANDBOX.1): the real backend resolution for this machine — platform + PATH + the
 *  managed require-isolation knob (admin-only file/registry, never env-forgeable). */
function liveSandboxResolution(): BackendResolution {
  return resolveBackend({ requireIsolation: managedRequireIsolation(managedConfig().config) });
}

/** P-SANDBOX.2 (ADR-0166): start (once) the mediated-egress proxy and hand back what the sandbox needs
 *  to steer the child at it, or null if it could not come up (⇒ the wrap falls back to network-off). */
export type ProxyStartFn = () => Promise<SandboxProxy | null>;

// P-SANDBOX.3 (ADR-0167): one deduped audit sink for the launcher process's proxy (blocked subprocess
// reach-outs → `egress` SecurityEvents on the audit / OCSF trail).
const launcherEgressAudit = egressAuditSink();

const liveProxyStart: ProxyStartFn = async () => {
  // Best-effort privileged :53 so a bound resolv.conf can point at us; degrades to ephemeral (HTTP(S)
  // mediation only) if unprivileged. Loopback HTTP bind failing ⇒ null ⇒ caller runs network-off.
  const ep = await ensureEgressProxy({ dnsPort: 53, onEvent: launcherEgressAudit });
  if (!ep) return null;
  return {
    host: ep.host,
    httpPort: ep.httpPort,
    httpProxyUrl: ep.httpProxyUrl,
    resolvConfPath: ep.dnsPort === 53 ? ep.resolvConfPath : undefined,
  };
};

/** Spawn the gated omp over inherited stdio; resolve the child's exit code (127 on spawn error). The
 *  single spawn path shared by `lucid acp` (ACP passthrough) and `lucid tui` (native terminal), so both
 *  surfaces inherit the same fail-closed launch. */
async function execGated(o: { omp: string; args: string[]; cwd: string; env: Env; spawnFn: SpawnFn; sandbox: BackendResolution; proxyStart?: ProxyStartFn; err: (s: string) => void; label: string }): Promise<number> {
  // P-SANDBOX.1 (ADR-0157): the runtime execution boundary, decided at THE spawn. The interactive
  // launcher session runs trusted-local caps; wrapForProfile owns the fail-closed rules (a managed
  // require-isolation with no backend refuses here, exactly like the scanner preflight).
  const profileCaps = caps("trusted-local");
  // P-SANDBOX.2 (ADR-0166): on an ISOLATING backend, a network-capable profile routes egress through the
  // mediated proxy. If the proxy cannot start, `proxy` stays undefined and `wrap` falls back to
  // --unshare-net (network-off) — fail-closed: no mediator ⇒ no raw network. A passthrough backend has
  // nothing to steer, so we skip the proxy (it discloses as un-isolated).
  let proxy: SandboxProxy | undefined;
  if (o.sandbox.ok && o.sandbox.backend.isolates && profileCaps.canNetwork) {
    proxy = (await (o.proxyStart ?? liveProxyStart)()) ?? undefined;
    if (!proxy) o.err(`[${o.label}] mediated egress proxy unavailable — running network-off (fail-closed, ADR-0166).\n`);
  }
  const d = wrapForProfile({ argv: [o.omp, ...o.args], caps: profileCaps, ctx: { workspace: o.cwd, proxy }, resolution: o.sandbox });
  if (d.action === "refuse") {
    o.err(`[${o.label}] FAIL-CLOSED: ${d.reason}\n[${o.label}] refusing to start — exec must be runtime-isolated under this org's policy (ADR-0157).\n`);
    return Promise.resolve(1);
  }
  if (d.disclosed) o.err(`[${o.label}] ${sandboxDisclosure()}\n`);
  // P-NVIM.7: point the in-process gate at the lock-free block log so `lucid blocks` / :LucidBlocks can
  // show quarantines DURING a live session (the gate holds agent_obs.duckdb, blocking a cross-process
  // read). Bare-lucid only — the desktop GUI spawns omp directly (not execGated), so it never double-writes.
  const child = o.spawnFn(d.plan.cmd, d.plan.args, { cwd: o.cwd, stdio: "inherit", env: { ...o.env, ...d.plan.env, LUCID_BLOCK_LOG: o.env.LUCID_BLOCK_LOG ?? join(homedir(), ".omp", "lucid-blocks.jsonl") } });
  return new Promise<number>((resolve) => {
    child.on("exit", (code: number | null) => resolve(code ?? 0));
    child.on("error", (e: unknown) => { o.err(`[${o.label}] failed to launch omp: ${String(e)}\n`); resolve(127); });
  });
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
  const args = buildAcpArgs({ gate: a.gate, asksage, acpConfig: a.acpConfig, isolate: o.isolate, mcpResultGate: existsSync(a.mcpResultGate) ? a.mcpResultGate : undefined });
  const cwd = o.cwd ?? env.LUCID_WORKSPACE ?? process.cwd();
  const spawnFn = o.spawnFn ?? ((c, ar, op) => nodeSpawn(c, ar, op as never) as unknown as SpawnedLike);

  return await execGated({ omp, args, cwd, env, spawnFn, sandbox: o.sandbox ?? liveSandboxResolution(), proxyStart: o.proxyStart, err, label: "lucid acp" });
}

export interface RunTuiOpts {
  cwd?: string;
  /** User-supplied omp args appended verbatim (initial prompt, --model, --continue, --resume, -p). */
  passthru?: string[];
  env?: Env;
  /** Injectable for tests; defaults to the real sidecar probe. */
  scannerProbe?: () => Promise<PreflightResult>;
  /** Injectable for tests; defaults to node child_process.spawn. */
  spawnFn?: SpawnFn;
  /** Injectable for tests; defaults to the real platform/PATH/managed-policy resolution (ADR-0157). */
  sandbox?: BackendResolution;
  /** Injectable for tests; defaults to starting the real mediated-egress proxy (ADR-0166). */
  proxyStart?: ProxyStartFn;
  stderr?: (s: string) => void;
}

/**
 * Run `lucid tui`: the SAME fail-closed preflight + gated omp command as `lucid acp`, but launched in
 * omp's native interactive TERMINAL UI instead of the ACP stdio passthrough — the terminal-native /
 * Neovim-friendly way to use the gated agent. stdio is inherited so omp owns the tty; extra args pass
 * through to omp (initial prompt, --model, --continue, --resume, -p). Fail-closes identically: a dead
 * scanner or missing gate returns 1 and NEVER spawns omp (never an ungated terminal agent).
 */
export async function runTui(o: RunTuiOpts = {}): Promise<number> {
  const env = o.env ?? process.env;
  const err = o.stderr ?? ((s) => void process.stderr.write(s));
  const a = assets();

  if (!o.scannerProbe) resolveScannerEnv(process.env, a.repo);

  const pf = await preflight({ gate: a.gate, scannerProbe: o.scannerProbe });
  if (!pf.ok) {
    err(`[lucid tui] FAIL-CLOSED: ${pf.reason}\n[lucid tui] refusing to start — the Lucid security gate must be loaded (never an ungated agent).\n`);
    return 1;
  }

  const omp = resolveOmp(env, a.repo);
  const asksage = existsSync(a.asksage) ? a.asksage : undefined;
  const mcpResultGate = existsSync(a.mcpResultGate) ? a.mcpResultGate : undefined;
  const lucidTheme = existsSync(a.lucidTheme) ? a.lucidTheme : undefined;
  const args = buildTuiArgs({ gate: a.gate, asksage, mcpResultGate, lucidTheme, passthru: o.passthru });
  const cwd = o.cwd ?? env.LUCID_WORKSPACE ?? process.cwd();
  const spawnFn = o.spawnFn ?? ((c, ar, op) => nodeSpawn(c, ar, op as never) as unknown as SpawnedLike);

  return await execGated({ omp, args, cwd, env, spawnFn, sandbox: o.sandbox ?? liveSandboxResolution(), proxyStart: o.proxyStart, err, label: "lucid tui" });
}

/** CLI entry. Bare `lucid` (no subcommand — optionally with omp passthru args like an initial prompt,
 *  `--model`, `-p`) starts the gated TUI, exactly like `lucid tui`; `lucid acp [--isolate]` starts the
 *  gated ACP session; `lucid check` runs the fail-closed preflight and exits (a diagnostic the IDE /
 *  installer can use); `-h`/`--help`/`help` prints usage. `deps` is an injection seam for tests. */
export async function main(argv: string[], env: Env = process.env, deps?: { tui?: typeof runTui; acp?: typeof runAcp }): Promise<number> {
  const tui = deps?.tui ?? runTui;
  const acp = deps?.acp ?? runAcp;
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
  if (sub === "stats") {
    const json = rest.includes("--json");
    const wantBudgets = rest.includes("--budgets");
    const si = rest.indexOf("--session");
    const sessionArg = si >= 0 ? rest[si + 1] : undefined;
    const stats = sessionStats(sessionArg);
    const budgets = wantBudgets ? rateLimits() : undefined;
    if (json) process.stdout.write(JSON.stringify(wantBudgets ? { session: stats, budgets } : { session: stats }) + "\n");
    else process.stdout.write(formatStats(stats, budgets));
    return 0;
  }
  if (sub === "kb") {
    // Read-only KG viewer data source (P-NVIM.6): list | pages | show | search, over the shared ~/.omp
    // registry the GUI uses. No agent, no tool calls — so no fail-closed preflight (a pure data read).
    const { code, out } = await runKb(rest);
    process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
    return code;
  }
  if (sub === "blocks") {
    // Read-only security-block viewer (P-NVIM.7): the list the GUI Security panel shows, in the terminal /
    // Neovim. Merges the lock-free block log + the DuckDB quarantines. No agent, no gate spawn — a pure read.
    const { code, out } = await runBlocks(rest);
    process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
    return code;
  }
  if (sub === "tui") return tui({ passthru: rest, env });
  if (sub === "acp") return acp({ isolate: rest.includes("--isolate"), env });

  if (sub === "-h" || sub === "--help" || sub === "help") {
    process.stderr.write(
      "usage: lucid [omp args…] | lucid acp [--isolate] | lucid tui [omp args…] | lucid kb [list|pages|show|search] | lucid blocks [--all] | lucid stats [--json] | lucid check | lucid agent-firewall --conn <id>\n" +
        "  (default)       Bare `lucid` starts the gated TUI — same as `lucid tui`. Non-subcommand args pass through to omp (initial prompt, --model, -p, …).\n" +
        "  acp             Start the gated Lucid ACP agent (omp + the in-process security gate) for an IDE client.\n" +
        "  tui             Start the gated Lucid agent in omp's native terminal UI (explicit alias of the default).\n" +
        "  stats           Print session spend + KV-cache + context metrics (--json for editors; --budgets adds rate limits).\n" +
        "  kb              Browse the knowledge graph(s): list | pages | show <id|slug> | search <query> (--json for editors, --kg <id> to target a KG).\n" +
        "  blocks          List the tool calls the security gate blocked (quarantined) — the GUI Security panel, in the terminal (--all includes reviewed; --json for editors).\n" +
        "  check           Run the fail-closed preflight (gate + scanner) and exit 0 (ready) / 1 (unavailable).\n" +
        "  agent-firewall  Serve the stdio MCP firewall proxy to a remote ACP agent (hermes/openclaw) — ADR-0147.\n" +
        "  Fail-closed: the TUI and `acp` refuse to start if the gate or scanner sidecar is unavailable.\n",
    );
    return 0;
  }

  // Default subcommand (ADR-0161): everything else IS the gated TUI — `lucid` == `lucid tui`,
  // and any args are omp passthru (`lucid "explain src/auth.ts"`, `lucid --model haiku -p hi`).
  return tui({ passthru: argv, env });
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => { process.stderr.write(`[lucid acp] fatal: ${String(e)}\n`); process.exit(1); });
}
