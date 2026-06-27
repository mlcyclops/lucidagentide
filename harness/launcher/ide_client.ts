// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/launcher/ide_client.ts
//
// P-EXT.2/3 (ADR-0038) — pure, editor-agnostic logic shared by the IDE clients (the VS Code
// extension here; the JetBrains plugin ports this to Kotlin). Two security-critical jobs:
//
//   1. Resolve the LUCID LAUNCHER binary — and ONLY a `lucid` launcher. The extension must spawn
//      `lucid acp` (the fail-closed gate trust anchor, P-EXT.1), never a bare agent command. Every
//      candidate here is a `lucid` binary or the user's explicit configured path; nothing in this
//      module can produce `omp` or any other command. (The gate-in-process guarantee, inv #4.)
//   2. Parse the gate's authoritative `[BLOCKED …]` stderr signal so the editor can show the
//      security-block banner — the same reliable signal the desktop shell uses (acp_backend.ts:182).
//
// No VS Code / Node-host imports: pure functions over injected env/predicates, so `bun test harness`
// covers them and both editors share one source of truth.

import { posix, win32 } from "node:path";

type Env = Record<string, string | undefined>;
type Platform = NodeJS.Platform;

/** Join paths for the TARGET platform (not the host running this code) — the extension resolves paths
 *  for the user's OS, and tests run cross-platform. */
function joiner(platform: Platform): (...parts: string[]) => string {
  return platform === "win32" ? win32.join : posix.join;
}

/** The launcher binary name for a platform. */
export function launcherBinaryName(platform: Platform = process.platform): string {
  return platform === "win32" ? "lucid.exe" : "lucid";
}

/** Per-OS default install locations of the LucidAgentIDE app, where the compiled `lucid` launcher ships
 *  in the bundled repo at `resources/repo/bin/lucid[.exe]` (P-EXT.4 build step; a real standalone binary,
 *  NOT a package.json-bin shim — those aren't created for the package itself). */
export function installedAppLauncherPaths(env: Env = process.env, platform: Platform = process.platform): string[] {
  const bin = launcherBinaryName(platform);
  const j = joiner(platform);
  const inRepo = (root: string) => j(root, "resources", "repo", "bin", bin);
  if (platform === "win32") {
    const la = env.LOCALAPPDATA;
    return la ? [inRepo(j(la, "Programs", "LucidAgentIDE"))] : [];
  }
  if (platform === "darwin") return [inRepo("/Applications/LucidAgentIDE.app/Contents")];
  return [inRepo("/opt/LucidAgentIDE"), j("/usr/local/bin", bin)];
}

export interface LauncherCandidateOpts {
  /** The user's `lucid.launcherPath` setting (trusted first when set). */
  configPath?: string;
  env?: Env;
  platform?: Platform;
  /** Directories from PATH to probe for a `lucid` binary. */
  pathDirs?: string[];
}

/**
 * Build the ORDERED launcher candidate list. SECURITY INVARIANT: every entry is the user's explicit
 * configured path or a `lucid` binary — never a bare agent command. Order: explicit config → installed
 * app → PATH dirs. The caller resolves the first that exists; if none, it must prompt to install Lucid,
 * NOT fall back to anything ungated.
 */
export function buildLauncherCandidates(o: LauncherCandidateOpts = {}): string[] {
  const platform = o.platform ?? process.platform;
  const bin = launcherBinaryName(platform);
  const config = o.configPath?.trim();
  const j = joiner(platform);
  const out: string[] = [];
  if (config) out.push(config);
  out.push(...installedAppLauncherPaths(o.env, platform));
  for (const d of o.pathDirs ?? []) if (d && d.trim()) out.push(j(d.trim(), bin));
  // SECURITY: keep ONLY the user's explicit config path + lucid-looking binaries. Nothing else can
  // enter the candidate list, so the extension can never be steered to spawn a non-lucid command.
  return out.filter((p) => p === config || isLucidBinary(p));
}

/** Whether a path is a `lucid` launcher binary (its basename is exactly `lucid` or `lucid.exe`). The
 *  security filter that keeps non-lucid commands (e.g. `omp`) out of the candidate list. Mirrored
 *  byte-for-byte by the JetBrains port; pinned by the ext_parity.json shared spec. */
export function isLucidBinary(p: string): boolean {
  return /(^|[\\/])lucid(\.exe)?$/.test(p);
}

/** Pick the first candidate that exists. Returns null if none — the caller must then prompt to install
 *  Lucid, never spawn a fallback agent. */
export function resolveLauncher(candidates: string[], exists: (p: string) => boolean): string | null {
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

// ── the gate's authoritative block signal ────────────────────────────────────
export interface BlockSignal { tool: string; severity: string; findings: string }

// Mirrors the parser in desktop/acp_backend.ts:182 — the gate writes this to stderr when it
// quarantines a tool call. This is the reliable, in-process signal for the editor's block banner.
const BLOCK_RE = /\[BLOCKED tool_call:(\w+)\].*?severity=(\w+).*?findings=(\S+)/;

/** Parse one stderr line into a block signal, or null if it isn't a gate block. */
export function parseBlockLine(line: string): BlockSignal | null {
  const m = BLOCK_RE.exec(line);
  return m ? { tool: m[1]!, severity: m[2]!, findings: m[3]! } : null;
}

// ── ACP session/update → normalized UI event ─────────────────────────────────
export type UiEvent =
  | { kind: "message"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; title: string; status?: string }
  | { kind: "usage"; tokens?: number; cost?: number }
  | { kind: "ignored" };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

/**
 * Map an ACP `session/update` payload to a normalized UI event for the webview. Thinking text is
 * surfaced as a distinct `thought` (display-only — ADR-0027; never re-fed to a prompt). Unknown update
 * types are `ignored`, so a new omp/ACP update can't break the editor.
 */
export function mapAcpUpdate(params: unknown): UiEvent {
  const u = (params as { update?: Record<string, unknown> })?.update ?? (params as Record<string, unknown>);
  if (!u || typeof u !== "object") return { kind: "ignored" };
  const t = (u.sessionUpdate ?? u.type) as string | undefined;
  switch (t) {
    case "agent_message_chunk": return { kind: "message", text: textOf(u.content) };
    case "agent_thought_chunk": return { kind: "thought", text: textOf(u.content) };
    case "tool_call":
    case "tool_call_update": return { kind: "tool", title: String(u.title ?? u.toolCallId ?? "tool"), status: u.status ? String(u.status) : undefined };
    case "usage_update": return { kind: "usage", tokens: typeof u.usedTokens === "number" ? u.usedTokens : undefined, cost: typeof u.cost === "number" ? u.cost : undefined };
    default: return { kind: "ignored" };
  }
}
