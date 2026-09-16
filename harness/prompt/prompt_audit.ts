// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/prompt/prompt_audit.ts
//
// P-CTX.1 (ADR-0350): the prompt-audit - a REAL per-block token breakdown of the
// assembled request, measured, never guessed. The desktop chat's baseline cost
// (everything the model carries before the first user message) had only ever been
// observed as one opaque provider number; cutting it requires knowing which block
// owns which tokens. This module assembles the SAME request shape the live desktop
// spawn produces (omp's own buildSystemPrompt via createAgentSession, plus the
// exact 7-policy append from acp_backend, plus the same -e tool extensions) fully
// offline: echo mock model, in-memory session store, temp auth, MCP/LSP off.
//
// Accounting parity is load-bearing: totals reuse omp's OWN counters (the agent's
// Tokenizer, estimateToolSchemaTokens, estimateSkillsTokens, computeNonMessageTokens)
// through the SAME tokenizer instance omp itself resolves for /context (session-stats.ts:
// `get #tokenizer() { return this.#host.agent.tokenizer; }`), so the audit's baseline is
// the number omp's /context panel would show, not a parallel estimate that drifts.
// Residuals are computed as differences, so every section's
// parts sum EXACTLY to the section total by construction.
//
// Honesty rules (token_speed.ts precedent): a block that is absent reports as
// absent (null), never as a plausible 0; the tokenizer mode (native vs ~4 chars
// per token estimate) is always named in the capture; what the hermetic mode
// excludes (user-global extension discovery, MCP servers, env-gated tools with no
// credential) is declared, not silently omitted.
//
// SOURCE OF TRUTH for what production loads: desktop/acp_backend.ts (ompArgv,
// appendedPolicy). prompt_audit.test.ts greps that file so drift fails loudly.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { computeNonMessageTokens, estimateSkillsTokens, estimateToolSchemaTokens } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import { loadProjectContextFiles } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { buildWorkspaceTree } from "@oh-my-pi/pi-coding-agent/workspace-tree";
import { createEchoModel, ensureMockApi } from "../testing/echo.ts";
import {
  AGENT_BUILDER_POLICY,
  BUILD_POLICY,
  DATA_INTEGRATION_POLICY,
  DELEGATION_POLICY,
  ENGAGEMENT_POLICY,
  PREVIEW_POLICY,
  SLASH_COMMAND_POLICY,
} from "./assembler.ts";

/** The desktop master chat's exact --append-system-prompt bytes (acp_backend.ts appendedPolicy). */
export function composeAppendedPolicy(): string {
  return `${DELEGATION_POLICY}\n\n${BUILD_POLICY}\n\n${PREVIEW_POLICY}\n\n${ENGAGEMENT_POLICY}\n\n${AGENT_BUILDER_POLICY}\n\n${SLASH_COMMAND_POLICY}\n\n${DATA_INTEGRATION_POLICY}`;
}

/** The 7 policies, individually countable (informational sub-rows of the appended total). */
export function policyParts(): Array<{ label: string; text: string }> {
  return [
    { label: "delegation", text: DELEGATION_POLICY },
    { label: "build", text: BUILD_POLICY },
    { label: "preview", text: PREVIEW_POLICY },
    { label: "engagement", text: ENGAGEMENT_POLICY },
    { label: "agent-builder", text: AGENT_BUILDER_POLICY },
    { label: "slash-commands", text: SLASH_COMMAND_POLICY },
    { label: "data-integration", text: DATA_INTEGRATION_POLICY },
  ];
}

/** Tool-registering -e extensions from the master spawn (acp_backend.ts ompArgv). The two scanner
 *  gates (security_extension, mcp_result_gate) are hook-only: they add no tool schemas and need the
 *  live sidecar, so the measurement seam excludes them - declared in `excluded`, never silent. */
export const MEASURED_EXTENSION_FILES = [
  "asksage_extension.ts",
  "preview_extension.ts",
  "codegraph_extension.ts",
  "knowledge_extension.ts",
  "agent_builder_extension.ts",
  "slash_command_extension.ts",
  "fleet_extension.ts",
  "interject_extension.ts",
  "browser_extension.ts",
  "tool_meta_extension.ts",
] as const;

export const EXCLUDED_FROM_MEASUREMENT = [
  "security_extension.ts (hook-only gate; needs live scanner sidecar; adds no tool schemas)",
  "mcp_result_gate.ts (hook-only gate; adds no tool schemas)",
  "user-global extension/tool discovery (hermetic mode; pass liveDiscovery to include)",
  "MCP servers (hermetic mode; pass liveDiscovery to include)",
  "per-turn tail: persona, KG recall, DESIGN.md, active skill (message content, not baseline)",
] as const;

export interface AuditTool {
  name: string;
  tokens: number;
  source: "builtin" | "extension";
}

export interface AuditCapture {
  cwd: string;
  /** Which countTokens path was active: omp's native tokenizer or the ~4 chars/token estimate. */
  tokenizer: "native" | "estimate";
  hermetic: boolean;
  /** session.systemPrompt blocks as omp assembled them (block 0 main, block 1 project footer). */
  blockTokens: number[];
  tools: AuditTool[];
  toolsTokens: number;
  skills: Array<{ name: string; tokens: number }>;
  skillsTokens: number;
  appendedPolicyTokens: number;
  policyRows: Array<{ label: string; tokens: number }>;
  contextFiles: Array<{ path: string; tokens: number }>;
  /** Tokens of the rendered workspace tree IF it is present in the assembled prompt; null when
   *  the includeWorkspaceTree setting kept it out (absent, never a fabricated 0). */
  workspaceTreeTokens: number | null;
  /** omp's own non-message total (computeNonMessageTokens) - the parity anchor. */
  nonMessageTokens: number;
  excluded: readonly string[];
}

export interface CaptureOptions {
  cwd?: string;
  /** Load the production tool extensions (default true). */
  withExtensions?: boolean;
  /** Turn ON user-global extension/custom-tool discovery and MCP (default false: hermetic). */
  liveDiscovery?: boolean;
}

/** Mirrors pi-agent-core/tokenizer.ts gating for Tokenizer#countTokens in its default
 *  "approximate" mode: under NODE_ENV=test it always estimates; otherwise a catalog-resolved
 *  encoding (or PI_TOKENIZER_ACCURATE=1 forcing o200k) counts natively. Display metadata only;
 *  counting always goes through that same Tokenizer so numbers can never diverge from omp's. */
function tokenizerMode(tokenizer: Tokenizer): "native" | "estimate" {
  if (Bun.env.NODE_ENV === "test") return "estimate";
  return tokenizer.encoding !== null || process.env.PI_TOKENIZER_ACCURATE === "1" ? "native" : "estimate";
}

interface ToolLike {
  name: string;
  description: string;
  parameters: unknown;
}

function toolList(session: { agent?: { state?: { tools?: unknown } } }): ToolLike[] {
  const raw = session.agent?.state?.tools;
  if (!Array.isArray(raw)) return [];
  const out: ToolLike[] = [];
  for (const t of raw) {
    if (t && typeof t === "object" && "name" in t && typeof t.name === "string") {
      const description = "description" in t && typeof t.description === "string" ? t.description : "";
      const parameters = "parameters" in t ? t.parameters : { type: "object" };
      out.push({ name: t.name, description, parameters });
    }
  }
  return out;
}

async function createAuditSession(opts: {
  cwd: string;
  extensionPaths: string[];
  liveDiscovery: boolean;
  appended: string;
}) {
  ensureMockApi();
  const model = createEchoModel();
  const tmp = mkdtempSync(join(tmpdir(), "prompt-audit-"));
  const authStorage = await AuthStorage.create(join(tmp, "auth.db"));
  authStorage.setRuntimeApiKey("echo", "test-key");
  // Unchecked cast, deliberately: a rejecting stand-in for fetch so model discovery can never
  // reach the network. Same shape harness/testing/echo.ts uses; no runtime check is possible.
  const offlineFetch = (() => Promise.reject(new Error("prompt-audit is offline"))) as unknown as typeof fetch;
  const modelRegistry = new ModelRegistry(authStorage, join(tmp, "models.yml"), { fetch: offlineFetch });
  const { session } = await createAgentSession({
    model,
    cwd: opts.cwd,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    enableMCP: opts.liveDiscovery,
    enableLsp: false,
    skipPythonPreflight: true,
    disableExtensionDiscovery: !opts.liveDiscovery,
    additionalExtensionPaths: opts.extensionPaths,
    appendSystemPrompt: opts.appended,
  });
  const cleanup = () => {
    try { authStorage.close(); } catch { /* already closed */ }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir cleaner gets it */ }
  };
  return { session, cleanup };
}

/** Env-gated extensions register their tools only when a live desktop would have set these.
 *  Stub them for the duration of session creation, then restore, so the measured tool surface
 *  matches a running app. Credentials are NEVER stubbed (asksage stays env-gated off). */
async function withDesktopEnvStubs<T>(work: () => Promise<T>): Promise<T> {
  const stubs: Record<string, string> = {
    LUCID_BROWSER_URL: "http://127.0.0.1:1/audit-stub",
    LUCID_TOOL_META_URL: "http://127.0.0.1:1/audit-stub",
  };
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(stubs)) {
    prior[k] = process.env[k];
    if (process.env[k] === undefined) process.env[k] = v;
  }
  try {
    return await work();
  } finally {
    for (const [k, was] of Object.entries(prior)) {
      if (was === undefined) delete process.env[k];
      else process.env[k] = was;
    }
  }
}

/**
 * Assemble the request the way the live desktop spawn does and measure every block.
 * Two sessions are created (with and without the -e extensions) so each tool schema
 * is attributable to "builtin omp" vs "LUCID extension" by set difference.
 */
export async function captureAssembly(options: CaptureOptions = {}): Promise<AuditCapture> {
  const cwd = options.cwd ?? process.cwd();
  const withExtensions = options.withExtensions ?? true;
  const liveDiscovery = options.liveDiscovery ?? false;
  const appended = composeAppendedPolicy();
  const extDir = join(import.meta.dir, "..", "omp");
  const extensionPaths = withExtensions ? MEASURED_EXTENSION_FILES.map((f) => join(extDir, f)) : [];

  const base = await createAuditSession({ cwd, extensionPaths: [], liveDiscovery: false, appended });
  const builtinNames = new Set(toolList(base.session).map((t) => t.name));
  base.cleanup();

  const main = await withDesktopEnvStubs(() =>
    createAuditSession({ cwd, extensionPaths, liveDiscovery, appended }),
  );
  try {
    const session = main.session;
    // The parity anchor: omp resolves this same instance for its /context panel
    // (session-stats.ts `get #tokenizer() { return this.#host.agent.tokenizer; }`).
    const tokenizer = session.agent.tokenizer;
    const blocks: string[] = session.systemPrompt ?? [];
    const blockTokens = blocks.map((b) => tokenizer.countTokens(b));

    const tools = toolList(session);
    const auditTools: AuditTool[] = tools.map((t) => ({
      name: t.name,
      tokens: estimateToolSchemaTokens([t], tokenizer),
      source: builtinNames.has(t.name) ? "builtin" : "extension",
    }));

    const skills = session.skills ?? [];
    const skillRows = skills.map((s: { name: string; description: string }) => ({
      name: s.name,
      tokens: tokenizer.countTokens([s.name, s.description]),
    }));

    const contextFiles = (await loadProjectContextFiles({ cwd })).map((f) => {
      const rel = relative(cwd, f.path);
      return {
        // cwd-relative for readable one-line report rows; walk-up files keep their ../ prefix.
        path: rel === "" ? f.path : rel,
        tokens: tokenizer.countTokens(f.content),
      };
    });

    // The tree renders into the project footer only when the includeWorkspaceTree setting is on.
    // Detect presence from the assembled bytes themselves rather than re-reading settings.
    let workspaceTreeTokens: number | null = null;
    const tree = await buildWorkspaceTree(cwd, { timeoutMs: 5000 });
    const treeProbe = tree.rendered.split("\n").find((l) => l.trim().length > 0);
    if (treeProbe && blocks.some((b) => b.includes(treeProbe))) {
      workspaceTreeTokens = tokenizer.countTokens(tree.rendered);
    }

    return {
      cwd,
      tokenizer: tokenizerMode(tokenizer),
      hermetic: !liveDiscovery,
      blockTokens,
      tools: auditTools,
      toolsTokens: estimateToolSchemaTokens(tools, tokenizer),
      skills: skillRows,
      skillsTokens: estimateSkillsTokens(skills, tokenizer),
      appendedPolicyTokens: tokenizer.countTokens(appended),
      policyRows: policyParts().map((p) => ({ label: p.label, tokens: tokenizer.countTokens(p.text) })),
      contextFiles,
      workspaceTreeTokens,
      nonMessageTokens: computeNonMessageTokens(session, tokenizer),
      excluded: EXCLUDED_FROM_MEASUREMENT,
    };
  } finally {
    main.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Attribution + report (pure; unit-testable without a session)
// ---------------------------------------------------------------------------

export interface AuditSection {
  label: string;
  tokens: number;
  rows: Array<{ label: string; tokens: number; note?: string }>;
}

export interface AuditReport {
  sections: AuditSection[];
  /** The parity anchor: omp's computeNonMessageTokens for the same session. */
  total: number;
  /** sections' sum; equals `total` by construction (residual rows are differences). */
  accounted: number;
  window: number;
  target: number;
  workingRoom: number;
  overTarget: number;
  tokenizer: "native" | "estimate";
  hermetic: boolean;
  excluded: readonly string[];
}

export interface ReportOptions {
  /** Model context window the baseline is judged against. Default 65536: the Laguna 2.1
   *  deployment window (the preset claims 262144; the served vLLM limit is what binds). */
  window?: number;
  /** Baseline budget. Default 10000 (P-CTX target: leave Laguna ~55k of working room). */
  target?: number;
}

export function buildReport(c: AuditCapture, options: ReportOptions = {}): AuditReport {
  const window = options.window ?? 65536;
  const target = options.target ?? 10000;

  const block0 = c.blockTokens[0] ?? 0;
  const block1 = c.blockTokens[1] ?? 0;
  const extraBlocks = c.blockTokens.slice(2).reduce((a, b) => a + b, 0);

  const byTokensDesc = <T extends { tokens: number }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => b.tokens - a.tokens);

  const builtinTools = c.tools.filter((t) => t.source === "builtin");
  const extensionTools = c.tools.filter((t) => t.source === "extension");
  const toolsSection: AuditSection = {
    label: `tool schemas (${c.tools.length} tools: ${builtinTools.length} builtin, ${extensionTools.length} extension)`,
    tokens: c.toolsTokens,
    rows: byTokensDesc(
      c.tools.map((t) => ({
        label: t.source === "extension" ? `${t.name} [ext]` : t.name,
        tokens: t.tokens,
      })),
    ),
  };

  const coreResidual = block0 - c.skillsTokens - c.appendedPolicyTokens;
  const block0Section: AuditSection = {
    label: "system prompt (block 0)",
    tokens: block0,
    rows: [
      { label: `skills list (${c.skills.length} skills)`, tokens: c.skillsTokens },
      {
        label: "LUCID appended policies (7)",
        tokens: c.appendedPolicyTokens,
        note: c.policyRows.map((p) => `${p.label} ${p.tokens}`).join(", "),
      },
      { label: "omp core prompt + tool guidance (residual)", tokens: coreResidual },
    ],
  };

  const ctxSum = c.contextFiles.reduce((a, f) => a + f.tokens, 0);
  const treeTokens = c.workspaceTreeTokens ?? 0;
  const footerResidual = block1 - ctxSum - treeTokens;
  const block1Rows: AuditSection["rows"] = c.contextFiles.map((f) => ({
    label: `context file: ${f.path}`,
    tokens: f.tokens,
  }));
  block1Rows.push(
    c.workspaceTreeTokens === null
      ? { label: "workspace tree", tokens: 0, note: "not in prompt (includeWorkspaceTree off)" }
      : { label: "workspace tree", tokens: c.workspaceTreeTokens },
  );
  block1Rows.push({ label: "environment + framing (residual)", tokens: footerResidual });
  const block1Section: AuditSection = {
    label: "project footer (block 1)",
    tokens: block1,
    rows: block1Rows,
  };

  const sections = [toolsSection, block0Section, block1Section];
  if (extraBlocks > 0) {
    sections.push({ label: "additional system blocks", tokens: extraBlocks, rows: [] });
  }
  const accounted = sections.reduce((a, s) => a + s.tokens, 0);

  return {
    sections,
    total: c.nonMessageTokens,
    accounted,
    window,
    target,
    workingRoom: window - c.nonMessageTokens,
    overTarget: c.nonMessageTokens - target,
    tokenizer: c.tokenizer,
    hermetic: c.hermetic,
    excluded: c.excluded,
  };
}

function pad(s: string, w: number): string {
  // One-line labels always: clamp with an ellipsis rather than letting a long label
  // shatter column alignment (AGENTS.md invariant #11, applied to terminal tables).
  if (s.length > w - 2) return `${s.slice(0, w - 5)}...  `;
  return s + " ".repeat(w - s.length);
}

function num(n: number, w: number): string {
  const s = String(n);
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

/** Render the audit as an aligned text report. Top `detail` rows per section (default 8). */
export function renderReport(r: AuditReport, detail = 8): string {
  const lines: string[] = [];
  const pct = (n: number) => (r.total > 0 ? `${((100 * n) / r.total).toFixed(1)}%` : "-");
  lines.push("LUCID prompt-audit (P-CTX.1): non-message baseline of the assembled request");
  lines.push(
    `tokenizer: ${r.tokenizer}${r.tokenizer === "estimate" ? " (~4 chars/token; PI_TOKENIZER_ACCURATE=1 for native counts)" : ""}`,
  );
  lines.push(`mode: ${r.hermetic ? "hermetic" : "live discovery"}`);
  lines.push("");
  for (const s of r.sections) {
    lines.push(`${pad(s.label, 58)}${num(s.tokens, 7)}  ${pct(s.tokens)}`);
    for (const row of s.rows.slice(0, detail)) {
      const note = row.note ? `  (${row.note})` : "";
      lines.push(`  ${pad(row.label, 56)}${num(row.tokens, 7)}${note}`);
    }
    const hidden = s.rows.length - detail;
    if (hidden > 0) {
      const hiddenSum = s.rows.slice(detail).reduce((a, x) => a + x.tokens, 0);
      lines.push(`  ${pad(`... ${hidden} more`, 56)}${num(hiddenSum, 7)}`);
    }
  }
  lines.push(pad("-", 58).replace(/ /g, "-") + "-------");
  lines.push(`${pad("non-message baseline (omp computeNonMessageTokens)", 58)}${num(r.total, 7)}`);
  if (r.accounted !== r.total) {
    lines.push(`${pad("section sum (skills estimator vs in-prompt rendering)", 58)}${num(r.accounted, 7)}`);
  }
  lines.push("");
  lines.push(`window ${r.window}: baseline leaves ${r.workingRoom} tokens of working room`);
  lines.push(
    r.overTarget > 0
      ? `target ${r.target}: OVER by ${r.overTarget}`
      : `target ${r.target}: under target by ${-r.overTarget}`,
  );
  lines.push("");
  lines.push("not measured here (declared, never silent):");
  for (const e of r.excluded) lines.push(`  - ${e}`);
  return lines.join("\n");
}
