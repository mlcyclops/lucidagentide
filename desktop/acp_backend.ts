// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/acp_backend.ts
//
// A real omp-ACP-backed chat/config singleton for the dev server. This is what
// makes the browser build produce GENUINE model replies (not a simulation):
// dev.ts exposes /api/chat, /api/config, etc. over it. It spawns
// `omp acp -e harness/omp/security_extension.ts`, so the security gate is loaded
// on the chat path here too. The wire format was captured from a live omp turn
// (DECISIONS ADR-0006).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ACPClient } from "./acp.ts";
import { AGENT_BUILDER_POLICY, BUILD_POLICY, DELEGATION_POLICY, ENGAGEMENT_POLICY, PREVIEW_POLICY, SLASH_COMMAND_POLICY } from "../harness/prompt/assembler.ts";
import { currentWorkspace } from "./workspace.ts";
import { learnFromTurn, recallPreamble } from "./personal.ts";
import { buildUserTurnPreamble } from "./preamble.ts";
import { ChatGate } from "./chat_gate.ts";
import { completionPath } from "./util_conn.ts";
import { recordTurns } from "./turns_log.ts";
import { isLearnableAssistantText } from "./thinking_governance.ts";
import { recordBlock } from "./security_log.ts";
import { asksageOnly, attribution, checkerModel, lastModel, load as loadSettings, mcpServersForAcp, setCheckerModel, setLastModel } from "./settings_store.ts";
import { managedAsksageOnly, managedConfig } from "./managed_config.ts";
import { recommendCheckerModel, resolveCheckerModel, type ModelOption } from "./checker_model.ts";
import { parseGoalVerdict } from "./goal_verdict.ts";
import { appendGoalIteration, appendRunLog, finishGoalMemory, type GoalMemory, readRunLog, resumeGoalMemory, saveGoalReport, savePreflightReport, startGoalMemory } from "./goal_memory.ts";
import { extractUrls, type IterStat, type LocStat, type LoopBlock, type LoopMetrics, type LoopOutcome, normalizeToolName, parseNumstat, renderLoopReport, stallSignature, summarizeLoop } from "./loop_report.ts";
import { type LoopDial, clampDialRow, loopVerdict } from "./exec_policy.ts";
import { emitSecurityEvent } from "./audit_export.ts";
import { aggregateRuns, type LoopRunRecord, type RunStats, summarizeRunStats, toRunRecord } from "./loop_runlog.ts";
import { addTurnSpend, type LoopSpend, newLoopSpend, normalizeBudget, overBudget } from "./loop_budget.ts";
import { formatSpend } from "./loop_report.ts";
import { assessReadiness, maturedGoalFrom, mergeMatured, parsePreflightJson, type PreflightSpec, preflightSystemPrompt, preflightUserPrompt, type ReadinessReport, relevantPriorRuns, renderLoopDesign, successCriteria, summarizePriorRuns } from "./loop_preflight.ts";
import { execFileSync } from "node:child_process";
import { type Automation, agentAutomationGate, listAutomations, nextDueAutomation, updateAutomation } from "./automations.ts";
import { loadSpecFile, loadSpecTrust } from "../harness/agent/file_store.ts"; // P-AGENT.14: scheduled agent runs
import { startAgentRun } from "./agent_run.ts"; // P-AGENT.14: same gated pipeline as the Builder's Run
import { type EgressChoice, egressDecisionDetailed, egressPosture, extractHost, isLocalFileTarget, recordEgress } from "./egress_policy.ts";
import { withinCallBudget } from "./network_whitelist.ts";
import { previewOpenPath, previewablePath } from "./preview_resolve.ts";
import { agentBuilderOpenSpec } from "../harness/agent/handoff.ts"; // P-AGENT.8.2: chat -> Agent Builder handoff
import type { AgentSpec } from "../harness/agent/spec.ts";
import { slashCommandCreateDraft } from "../harness/commands/handoff.ts"; // P-CMD.1: chat -> user slash command
import type { UserCommand } from "../harness/commands/spec.ts";
import { gateDenyReason } from "./gate_audit.ts";
import { type ExecChoice, type ExecClass, classifyCommand, classifyEval, elicitationApproval, execStore, execVerdict, recordExec } from "./exec_policy.ts";
import { toolFailureReason } from "./tool_failure.ts";

// P-EGRESS.1 (ADR-0062): the network-reaching tools omp is told to PROMPT for (acp_config.yml). When omp
// requests permission for one of these, the desktop shows the per-website approval dialog instead of
// silently auto-approving in Agent mode.
const EGRESS_TOOLS = new Set(["browser", "web_search", "web", "fetch", "navigate"]);

// P-EXEC.1 (ADR-0066): the exec tools omp is told to PROMPT for (acp_config.yml). Each call is classified
// per-command — read-only auto-approves, risky gates, a catastrophic set always prompts. Detected by the
// tool name OR (the strong signal) a `command` string in the tool's rawInput.
const EXEC_TOOLS = /\b(bash|eval|shell|execute|terminal)\b/;
const EXEC_OPTIONS_FULL = [
  { optionId: "exec:allow-once", name: "Allow once", kind: "allow" },
  { optionId: "exec:allow-turn", name: "Allow for this turn", kind: "allow" },
  { optionId: "exec:allow-program", name: "Always allow this program", kind: "allow" },
  { optionId: "exec:danger", name: "Always allow every command", kind: "danger" },
  { optionId: "exec:deny", name: "Block", kind: "reject" },
];
// Catastrophic or compound calls (no single program to pin) expose only once / this-turn / deny.
const EXEC_OPTIONS_LIMITED = [
  { optionId: "exec:allow-once", name: "Allow once", kind: "allow" },
  { optionId: "exec:allow-turn", name: "Allow for this turn", kind: "allow" },
  { optionId: "exec:deny", name: "Block", kind: "reject" },
];
/** Pull the command/code an exec tool call will run, from its rawInput. */
function execCommand(tc: any): string | null {
  const ri = tc?.rawInput ?? tc?.input ?? {};
  for (const k of ["command", "cmd", "script", "code", "source", "input"]) if (typeof ri[k] === "string" && ri[k].trim()) return ri[k].trim();
  return null;
}
// The dialog's choices — clear and non-overlapping. ("allow once" and an "ask every time" pin had the
// same outcome — both ask again next time — so the pin was dropped.) Each maps to an EgressChoice the
// store folds in; the "allow" variants approve the call to omp, "deny" blocks it.
const EGRESS_OPTIONS: { optionId: string; name: string; kind?: string }[] = [
  { optionId: "egress:allow-once", name: "Allow once", kind: "allow" },
  { optionId: "egress:allow-site", name: "Always allow this site", kind: "allow" },
  { optionId: "egress:danger", name: "Always allow every site", kind: "danger" },
  { optionId: "egress:deny", name: "Block", kind: "reject" },
];
// P-EGRESS.2 (ADR-0094): opening a LOCAL file in a browser has no "site" to remember, so it offers only
// open-once / block (a host-pin would persist a junk key for a file path). Still a PROMPT — never auto-allow.
const EGRESS_LOCAL_OPTIONS: { optionId: string; name: string; kind?: string }[] = [
  { optionId: "egress:allow-once", name: "Open once", kind: "allow" },
  { optionId: "egress:deny", name: "Block", kind: "reject" },
];
/** Pull the URL (browser) or query (web_search) an egress tool call targets, from its rawInput/title. */
function egressTarget(tc: any): string | null {
  const ri = tc?.rawInput ?? tc?.input ?? {};
  for (const k of ["url", "href", "uri", "link"]) if (typeof ri[k] === "string" && ri[k].trim()) return ri[k].trim();
  if (typeof ri.query === "string" && ri.query.trim()) return ri.query.trim();
  const m = /(https?:\/\/[^\s)]+)/i.exec(String(tc?.title ?? ""));
  return m ? m[1]! : (String(tc?.title ?? "").trim() || null);
}

const REPO = join(import.meta.dir, "..");
// Absolute so the gate loads from THIS repo even when omp runs in another workspace.
const GATE = join(REPO, "harness", "omp", "security_extension.ts");
// AskSage gov-gateway provider extension, loaded alongside the gate (omp -e is
// repeatable). No-op unless ASKSAGE_API_KEY is set in the spawn env. ADR-0007.
const ASKSAGE = join(REPO, "harness", "omp", "asksage_extension.ts");
// P-PREVIEW.3a (ADR-0096) — DRAFT: registers the agent-callable `preview_open` tool. Defensively wrapped so
// a registration failure never breaks omp launch (see preview_extension.ts). Only added when the file exists.
const PREVIEW_EXT = join(REPO, "harness", "omp", "preview_extension.ts");
const AGENT_BUILDER_EXT = join(REPO, "harness", "omp", "agent_builder_extension.ts"); // P-AGENT.8.2: chat -> canvas handoff tool
const SLASH_CMD_EXT = join(REPO, "harness", "omp", "slash_command_extension.ts"); // P-CMD.1: slash_command_create tool
// P-KG-SYM.1: registers the read-only `codegraph_query` tool. Added ONLY when the user opted in
// (settings.codeGraphAgent) AND the file exists — so a bad/absent extension never blocks omp launch.
const CODEGRAPH_EXT = join(REPO, "harness", "omp", "codegraph_extension.ts");
// P-TASK.3/4 (ADR-0028): config overlay that turns ON task isolation (mode: auto) so subagents
// can run isolated and return a reviewable patch — containing the blast radius of a bad tool call.
const ACP_CONFIG = join(REPO, "harness", "omp", "acp_config.yml");
function ompBin(): string {
  // Prefer the path the Electron main process resolved (bundled or app-managed
  // install); fall back to the user's bun bin, then PATH.
  const fromMain = process.env.LUCID_OMP_BIN;
  if (fromMain && existsSync(fromMain)) return fromMain;
  for (const c of [join(homedir(), ".bun", "bin", "omp.exe"), join(homedir(), ".bun", "bin", "omp")]) if (existsSync(c)) return c;
  return "omp";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  // P-CHAT.1 (ADR-0104): `code` carries the tool's authored content so the chat can show an inline,
  // expandable code/diff preview — a write's `content`, or an edit's `oldText`/`newText` (rendered as a
  // diff). Bounded server-side. Absent for tools with no authored code (read/search/bash command shown as detail).
  | { type: "tool"; name: string; detail: string; code?: { path: string; content?: string; oldText?: string; newText?: string; patch?: string } }
  | { type: "subagent"; id: string; agent: string; title: string; assignments: string[] }
  | { type: "block"; tool: string; reason: string; severity: string; findings: string; id?: string; quarantined?: boolean }
  | { type: "permission"; id: string; tool: string; detail: string; options: { optionId: string; name: string; kind?: string }[]; url?: string; egress?: boolean; localFile?: boolean; exec?: boolean; program?: string; reason?: string; danger?: boolean }
  | { type: "preview-available"; path: string } // P-PREVIEW.2 (ADR-0096): the agent wrote a previewable file
  | { type: "agent-builder-open"; spec: AgentSpec } // P-AGENT.8.2 (ADR-0134): open the Agent Builder pre-populated
  | { type: "slash-command-created"; command: UserCommand } // P-CMD.1 (ADR-0146): the agent created a user "/" command
  | { type: "usage"; used: number; size: number; cost: number }
  // P-GOAL.1 (ADR-0046): /goal loop events — an iteration begins, the separate checker's verdict,
  // the loop met its condition, or it stopped (cap / no-progress).
  | { type: "goal-memory"; path: string }
  | { type: "goal-iter"; n: number; max: number }
  | { type: "goal-check"; n: number; done: boolean; reason: string }
  | { type: "goal-done"; iters: number; reason: string }
  | { type: "goal-stop"; reason: string }
  // P-GOAL.9 (ADR-0054): the loop's last task — an After-Action Report (metrics + portable graphs).
  | { type: "goal-report"; path: string; summary: string; markdown: string }
  | { type: "done"; text?: string }; // text = the authoritative full assistant reply (reconciles lossy streaming)

class Backend {
  private acp: ACPClient | null = null;
  private sessionId: string | null = null;
  private starting: Promise<void> | null = null;
  private listener: ((e: ChatEvent) => void) | null = null;
  // Approved (scanned + delimited) AskSage persona. STANDING guidance: re-delivered EVERY turn in the
  // user turn (never the frozen prefix; ADR-0007 / invariant #5) so it doesn't fade (issue #54).
  private persona: string | null = null;
  // Personalization recall (P9.2): the live <user-profile> block, re-read and re-delivered every turn
  // (never the frozen prefix). Off unless personalization is enabled+unlocked.
  // Cross-session memory recall (ADR-0009 Phase A): a <recalled-memory> block of facts distilled in
  // EARLIER sessions, delivered ONCE per session in the user turn (a session-start recall, not standing
  // guidance) — never the frozen prefix (invariant #5/#6). Distinct from the P9.2 recall above.
  private memoryRecall: string | null = null;
  private memoryRecallDelivered = false;
  // P-IDE.2 (ADR-0029): an active BUNDLED skill's trusted guidance. STANDING guidance: re-delivered
  // every turn (never the frozen prefix, never --append-system-prompt) so the skill keeps guiding the
  // agent until cleared (issue #54). Already wrapped (`<active-skill name="…">…</active-skill>`).
  private skill: string | null = null;
  private skillName = "";
  configOptions: any[] = [];
  commands: any[] = [];
  // P-ACP.2 (ADR-0027): ACP session modes (omp exposes [default, plan]). Plan is a read-only
  // planner; default ("Agent") is autonomous. Switched via session/set_mode; omp echoes the
  // active mode back with a current_mode_update notification (and may change it itself, e.g.
  // Plan auto-exiting once a plan is drafted), so we track that to keep the UI in sync.
  availableModes: any[] = [];
  currentModeId = "default";
  // P-ACP.3 (ADR-0027): "Ask" is a CLIENT mode (omp has no native ask) — omp mode stays `default`
  // (so it can edit) but every tool-permission request is forwarded to the UI for an explicit
  // decision instead of being auto-approved. The composer's 3-way Plan/Ask/Agent is derived from
  // (currentModeId, permissionMode). Fail-closed: no decision (timeout / disconnect) ⇒ deny.
  permissionMode: "auto" | "ask" = "auto";
  // P-GOAL.2 (ADR-0046): a /goal loop is running, and a request to stop it after the current iteration.
  private goalActive = false;
  private goalCancelled = false;
  // P-GOAL.5 (ADR-0047): in-process automation scheduler. A timer ticks while the app is open and runs
  // the first DUE automation through runGoal. `autoRunning` guards against a tick overlapping itself.
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private autoRunning = false;
  private static readonly AUTO_TICK_MS = 30_000;
  private askActive = false;            // true only during a chat turn (never the util `complete()`)
  // P-EXEC.1 (ADR-0066): the in-memory allow-turn scope — risky programs the user OK'd for the rest of
  // THIS interactive turn only. NEVER persisted; cleared at every turn boundary. `execTurnAll` is the
  // compound-command equivalent (no single program to key on).
  private execTurnPrograms = new Set<string>();
  private execTurnAll = false;
  // P-GOAL.13 (ADR-0067): the active unattended-loop dial (per-command-type Speed↔Risk ceiling) + the
  // blocks it caused. Set while a /goal loop runs; null otherwise. `loopIter` tags each block.
  private loopDial: LoopDial | null = null;
  private loopBlocks: LoopBlock[] = [];
  private loopIter = 0;
  // P-NETWL.3 (ADR-0106): per-loop count of auto-allowed calls to each whitelisted host, so a whitelist
  // entry's `callBudget` caps how many times it auto-allows PER LOOP. Reset at each /goal loop start.
  private loopHostCalls = new Map<string, number>();
  private permSeq = 0;
  private permPending = new Map<string, (optionId: string | null) => void>();
  private pendingPerms = 0;             // while > 0 the turn's idle/stall clock is paused
  private static readonly PERM_MS = 300_000; // 5 min to decide, then fail-closed (deny)

  /** Set/clear the active persona. Pass the ALREADY-scanned, delimiter-wrapped text. */
  setPersona(wrapped: string | null): void { this.persona = wrapped; }

  /** Set/clear the cross-session recall block. Pass the ALREADY-escaped, delimiter-wrapped
   *  text from buildRecall(); re-delivered in the first user turn of each session. */
  setRecall(wrapped: string | null): void { this.memoryRecall = wrapped; this.memoryRecallDelivered = false; }

  /** P-IDE.2: set/clear the active bundled skill. `wrapped` is the trusted `<active-skill …>` block
   *  (or null to clear). Re-delivered on the next turn so a skill change takes effect immediately. */
  setSkill(wrapped: string | null, name = ""): void { this.skill = wrapped; this.skillName = wrapped ? name : ""; }
  activeSkillName(): string { return this.skillName; }

  private emit(e: ChatEvent): void { this.listener?.(e); }

  // P-ASKSAGE.1 (ADR-0059): a bounded ring of AskSage tool-loop diagnostics, parsed from the omp child's
  // `[ASKSAGE_DIAG]` stderr lines. Surfaced (developer-mode only) in the Logs panel so the non-streamed
  // AskSage tool loop — and the "empty-response → gives up early" anomaly — is observable from a UI test.
  private asksageDiag: Array<Record<string, unknown>> = [];
  /** Recent AskSage call diagnostics (most-recent last), capped. Empty unless developer mode is on. */
  asksageDiagnostics(): Array<Record<string, unknown>> { return this.asksageDiag.slice(-100); }

  // P-GATE-DIAG.1 (ADR-0066/0062): a bounded ring recording the interactive-check inputs + decision for
  // every exec/egress permission request. Surfaced (developer mode) in the Logs panel so the "I never got
  // a prompt — it was just denied" anomaly is observable: it shows WHY the gate auto-denied (askActive /
  // listener / goalActive / autoRunning) instead of prompting. Best-effort; never throws.
  private gateDiag: Array<Record<string, unknown>> = [];
  /** Recent exec/egress gate-decision diagnostics (most-recent last), capped. */
  gateDiagnostics(): Array<Record<string, unknown>> { return this.gateDiag.slice(-100); }
  private recordGateDiag(rec: Record<string, unknown>): void {
    try { this.gateDiag.push({ at: Date.now(), ...rec }); if (this.gateDiag.length > 200) this.gateDiag.shift(); } catch { /* never break the gate on a log */ }
  }

  /** P-EXEC.2 (ADR-0110): answer omp's FORM elicitation — its per-tool "Approve/Deny" approval and
   *  plan-mode approval. omp maps a `select` to a one-property schema `{ value: { enum: [...] } }`; we
   *  accept the affirmative option (Approve/Allow/Yes/Proceed) because this elicitation is a redundant
   *  INNER gate that only fires AFTER our authoritative `session/request_permission` gate already
   *  allowed the call. A non-approval elicitation (a custom question with no affirmative option) gets no
   *  synthesized answer — declined, matching the pre-capability behavior where such prompts returned no
   *  value. Surfaced in the gate diagnostics (developer mode) for the Logs panel. */
  private answerElicitation(params: any): { action: string; content?: { value: string } } {
    const enumVals: unknown = params?.requestedSchema?.properties?.value?.enum;
    const opts: string[] = Array.isArray(enumVals) ? enumVals.filter((v): v is string => typeof v === "string") : [];
    const approve = elicitationApproval(opts);
    this.recordGateDiag({ kind: "elicitation", options: opts.slice(0, 8), decision: approve ? `accept:${approve}` : "decline" });
    return approve ? { action: "accept", content: { value: approve } } : { action: "decline" };
  }

  // Turn-lifecycle diagnostics (developer mode). Prints to the dev-server console so a hung long
  // multi-tool turn reveals WHERE it stalls: did prompt() resolve (server finished, browser orphaned) or
  // never resolve (omp wedge)? did complete() clobber the chat listener? did the browser stream break?
  private turnDiag(msg: string): void {
    if (!loadSettings().developerMode) return;
    try { console.error(`[TURN_DIAG] ${msg}`); } catch { /* never break a turn on a log */ }
  }

  private async start(): Promise<void> {
    if (this.acp) return;
    if (!this.starting) {
      this.starting = (async () => {
        // P-TASK.2 (ADR-0028): append the byte-stable proactive-delegation policy to omp's system
        // prompt. omp owns the system prompt on the ACP path, so --append-system-prompt is how our
        // cached, stable layer-3 policy reaches the chat model (no volatile bytes → cache stays hot).
        // The isolation overlay ships under harness/** and resolves like GATE in dev AND packaged
        // builds; add it ONLY if present so a missing file degrades isolation off rather than crashing
        // `omp acp` (bundled-safety, fail-open on a non-security knob — the gate still scans every call).
        const isoCfg = existsSync(ACP_CONFIG) ? ["--config", ACP_CONFIG] : [];
        // P-LOC.1 (ADR-0031): thread the AI-LOC attribution context to the gate via env. The spawned
        // omp child inherits process.env, so the in-process gate tags each AI-authored edit with the
        // authoring model + the attribution identity + the edited workspace. Set BEFORE spawn (env is
        // copied at exec; the child can't see later changes).
        this.applyAttributionEnv();
        // P-ASKSAGE.1 (ADR-0059): enable AskSage tool-loop diagnostics in the omp child when developer
        // mode is on (the child inherits process.env at spawn). Off otherwise — zero overhead in normal use.
        if (loadSettings().developerMode) process.env.LUCID_ASKSAGE_DEBUG = "1"; else delete process.env.LUCID_ASKSAGE_DEBUG;
        // ADR-0033: also append the build / anti-over-refusal policy so the chat model doesn't decline
        // a buildable task (e.g. "make a game/graphics/music in one HTML file") by mis-reading its scope.
        const appendedPolicy = `${DELEGATION_POLICY}\n\n${BUILD_POLICY}\n\n${PREVIEW_POLICY}\n\n${ENGAGEMENT_POLICY}\n\n${AGENT_BUILDER_POLICY}\n\n${SLASH_COMMAND_POLICY}`;
        const previewArgs = existsSync(PREVIEW_EXT) ? ["-e", PREVIEW_EXT] : []; // P-PREVIEW.3a (draft)
        const codegraphArgs = loadSettings().codeGraphAgent && existsSync(CODEGRAPH_EXT) ? ["-e", CODEGRAPH_EXT] : []; // P-KG-SYM.1: opt-in
        const agentBuilderArgs = existsSync(AGENT_BUILDER_EXT) ? ["-e", AGENT_BUILDER_EXT] : []; // P-AGENT.8.2: agent_builder_open
        const slashCmdArgs = existsSync(SLASH_CMD_EXT) ? ["-e", SLASH_CMD_EXT] : []; // P-CMD.1: slash_command_create
        const acp = new ACPClient(ompBin(), ["acp", "-e", GATE, "-e", ASKSAGE, ...previewArgs, ...codegraphArgs, ...agentBuilderArgs, ...slashCmdArgs, ...isoCfg, "--append-system-prompt", appendedPolicy], currentWorkspace());
        acp.onNotify = (method, params) => {
          if (method !== "session/update") return;
          const u = params?.update ?? params;
          switch (u?.sessionUpdate) {
            case "agent_message_chunk": if (u.content?.type === "text") this.emit({ type: "token", text: u.content.text }); break;
            // P-ACP.1 (ADR-0027): the model's reasoning stream. omp emits these BEFORE the answer when
            // thinking is on; without this case they were dropped, so the whole reasoning phase showed
            // nothing and the answer then arrived in a burst (the "big dump"). Surface them so the UI
            // streams thinking live, like the omp TUI. Display-only — never added to the assistant buffer
            // the personalization distiller learns from, and never persisted.
            case "agent_thought_chunk": if (u.content?.type === "text") this.emit({ type: "thinking", text: u.content.text }); break;
            case "tool_call": {
              // P-TASK.1 (ADR-0028): omp's `task` tool surfaces as a generic tool_call (kind "other")
              // whose rawInput carries { agent, context, tasks[] } (batch) or { agent, assignment } (flat).
              // Detect it and emit a distinct `subagent` event so the UI shows a delegation card instead
              // of a nameless "other" chip. (The rawInput strings are still scanned by the pre-hook gate.)
              const ri = u.rawInput ?? {};
              if (ri.agent && (Array.isArray(ri.tasks) || typeof ri.assignment === "string")) {
                const items: any[] = Array.isArray(ri.tasks) ? ri.tasks : [{ assignment: ri.assignment, description: ri.description }];
                this.emit({
                  type: "subagent", id: String(u.toolCallId ?? u.title ?? ""), agent: String(ri.agent),
                  title: String(u.title ?? `${ri.agent} subagent`),
                  assignments: items.map((t) => String(t?.description ?? t?.assignment ?? "").slice(0, 200)).filter(Boolean),
                });
              } else if (ri.poll || ri.cancel || ri.list || ri.wait) {
                // job-coordination calls (poll/list/cancel/wait of background subagents) are internal
                // bookkeeping while a task runs — don't surface them as separate tool chips.
              } else {
                // P-CHAT.1 (ADR-0104): carry the tool's authored code for the chat's inline preview. A
                // write's `content`, or an edit's `oldText`/`newText` (→ diff). Bounded so a huge file can't
                // bloat the event stream; the content is already gate-scanned (it's the same tool_call text).
                const CODE_CAP = 64 * 1024;
                const clip = (s: unknown) => (typeof s === "string" ? s.slice(0, CODE_CAP) : undefined);
                // The agent often writes/edits with a RELATIVE path (relative to the workspace it runs in).
                // Preview + "Open in editor" need an ABSOLUTE path, so resolve any relative path against the
                // workspace here (a path that's already file://, a URL, or OS-absolute is left untouched).
                const absPath = (p: string): string => {
                  if (!p || /^(file:\/\/|https?:\/\/|[A-Za-z]:[\\/]|\/|\\\\|~[\\/])/i.test(p)) return p;
                  try { return join(currentWorkspace(), p); } catch { return p; }
                };
                const codePath = absPath(typeof ri.path === "string" ? ri.path : typeof ri.file_path === "string" ? ri.file_path : "");
                let code: { path: string; content?: string; oldText?: string; newText?: string; patch?: string } | undefined;
                if (typeof ri.content === "string") code = { path: codePath, content: clip(ri.content) };
                // `replace` mode (ADR-0105, our configured edit tool) sends `edits: [{ old_text, new_text }]`
                // (one call may bundle several hunks) — join them into one before/after pair for the diff.
                // camelCase + top-level are kept as fallbacks for other edit-tool variants.
                else if (Array.isArray(ri.edits) && ri.edits.length) {
                  const olds = ri.edits.map((e: any) => String(e?.old_text ?? e?.oldText ?? "")).join("\n");
                  const news = ri.edits.map((e: any) => String(e?.new_text ?? e?.newText ?? "")).join("\n");
                  code = { path: codePath, oldText: clip(olds) ?? "", newText: clip(news) ?? "" };
                }
                else if (typeof ri.old_text === "string" || typeof ri.new_text === "string") code = { path: codePath, oldText: clip(ri.old_text) ?? "", newText: clip(ri.new_text) ?? "" };
                else if (typeof ri.oldText === "string" || typeof ri.newText === "string") code = { path: codePath, oldText: clip(ri.oldText) ?? "", newText: clip(ri.newText) ?? "" };
                // omp's default `hashline` edit sends a patch in a single `input` string (kept for completeness).
                else if (typeof ri.input === "string" && (u.kind === "edit" || /\bedit\b/i.test(String(u.title ?? "")))) code = { path: codePath, patch: clip(ri.input) };
                this.emit({ type: "tool", name: String(u.kind ?? u.title ?? "tool"), detail: String(u.title ?? ri.command ?? ""), ...(code ? { code } : {}) });
                // P-PREVIEW.2 (ADR-0096): if this write/edit produced a browser-previewable file, tell the UI
                // so it can auto-surface it in the Preview panel. Pure detection (previewablePath); the path
                // is still gated by the resolver before anything renders.
                // P-PREVIEW.3a (ADR-0096): the agent's own `preview_open` tool call drives the panel too —
                // same `preview-available` path (the renderer re-gates via resolvePreview before rendering).
                // A CUSTOM tool's name does NOT survive as `u.kind` (ACP maps it to "other"); omp renders the
                // call title as `"preview_open: <path>"`, so preview_open must be matched against the TITLE.
                // A write/edit, by contrast, keeps a real `kind` ("edit"), which previewablePath keys on.
                const pvRaw = previewOpenPath(String(u.title ?? ""), ri) ?? previewablePath(String(u.kind ?? u.title ?? ""), ri);
                const pv = pvRaw ? absPath(pvRaw) : pvRaw; // resolve a relative write path to absolute so the panel can render it
                if (pv) this.emit({ type: "preview-available", path: pv });
                // P-AGENT.8.2 (ADR-0134): the agent's `agent_builder_open` tool call opens the Agent Builder
                // pre-populated. Re-parsed + validated + secret-scanned here (authoritative) before it opens.
                // NOTE: omp renders a custom tool's call TITLE as a human summary (e.g. "Opening agent builder
                // for X"), NOT the tool name — so we key on the unique `specJson` arg (in rawInput OR input),
                // not the title. Fail-closed: a leaky/invalid draft parses to null here and never opens.
                const abArgs = (u.rawInput ?? (u as { input?: unknown }).input ?? ri) as unknown;
                const abSpec = agentBuilderOpenSpec(String(u.title ?? ""), abArgs);
                if (abSpec) this.emit({ type: "agent-builder-open", spec: abSpec });
                // P-CMD.1 (ADR-0146): the agent's `slash_command_create` tool call creates a user "/" command.
                // Same detection shape as agent_builder_open — key on the unique `commandJson` arg, re-parse +
                // validate + secret-scan here (fail-closed: a leaky/invalid draft parses to null and is ignored).
                // The renderer then persists it authoritatively through the gate (createUserCommand).
                const scCommand = slashCommandCreateDraft(String(u.title ?? ""), abArgs);
                if (scCommand) this.emit({ type: "slash-command-created", command: scCommand });
              }
              break;
            }
            // A failed/rejected tool call is omp's GENERIC signal — it fires for the security
            // gate AND for ordinary tool failures, so it must NOT claim "blocked by the security
            // gate" (that mislabel made benign failures look like quarantines). The authoritative
            // security block is the gate's own stderr signal, handled in onStderr below.
            // P-TOOLFAIL.1 (ADR-0093): surface omp's ACTUAL status + message instead of a flat
            // "tool call rejected" — distinguish a tool that ran-and-errored ("failed") from one that
            // never ran ("rejected": refused / unavailable / cancelled), so the neutral chip says WHY
            // and is never mistaken for a security denial. (toolFailureReason is pure; see tool_failure.ts.)
            case "tool_call_update": if (u.status === "failed" || u.status === "rejected") this.emit({ type: "block", tool: String(u.kind ?? "tool"), reason: toolFailureReason(u).reason, severity: "low", findings: "", quarantined: false }); break;
            case "usage_update": this.emit({ type: "usage", used: Number(u.used ?? 0), size: Number(u.size ?? 0), cost: Number(u.cost?.amount ?? 0) }); break;
            case "available_commands_update": this.commands = u.availableCommands ?? []; break;
            case "config_option_update": if (u.configOptions) { this.configOptions = u.configOptions; this.syncModelEnv(); } break;
            case "current_mode_update": this.currentModeId = String(u.currentModeId ?? this.currentModeId); break;
          }
        };
        acp.onRequest = async (m, params) => {
          // P-EXEC.2 (ADR-0110): omp (≥16.1) routes its per-tool "Approve/Deny" approval — and plan-mode
          // approval — through an ACP FORM elicitation (`elicitation/create`), gated on the client
          // advertising `elicitation.form`. This approval runs as an INNER wrapper, AFTER (and only if)
          // our `session/request_permission` gate already allowed the call — so it is a redundant second
          // gate. We advertise the capability (in `initialize`) and answer here: pick the affirmative
          // option so an already-gated call proceeds. Without this omp's `select()` returned `undefined`,
          // which its tool wrapper treats as "Tool call denied by user" — silently failing EVERY
          // bash/eval/edit/delete call with no prompt (the exact "denied without being asked" bug).
          if (m === "elicitation/create") return this.answerElicitation(params);
          if (m === "session/request_permission") {
            const opts: any[] = params?.options ?? [];
            const tc = params?.toolCall ?? params?.tool_call ?? {};
            const toolName = [tc.kind, tc.title, tc.name, tc.toolName, params?.tool, params?.toolName].filter(Boolean).join(" ").toLowerCase();
            const target = egressTarget(tc);
            // P-EXEC.1 (ADR-0066): an exec tool (bash/eval). Classify the command BEFORE the Agent
            // auto-approve — read-only auto-approves, risky gates, a catastrophic set always prompts. A
            // shell command is handled here (not egress), so `curl … | sh` is caught as catastrophic exec.
            const isEvalTool = /\beval\b/.test(toolName);
            const cmd = execCommand(tc);
            if (isEvalTool || cmd !== null || EXEC_TOOLS.test(toolName)) {
              const cls: ExecClass = isEvalTool ? classifyEval() : classifyCommand(cmd ?? toolName);
              // Interactive = a live chat turn with a UI listener and NOT an unattended loop/automation.
              const interactive = this.askActive && !!this.listener && !this.goalActive && !this.autoRunning;
              const approveOpt = () => { const a = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? "")) ?? opts[0]; return a ? { outcome: { outcome: "selected", optionId: a.optionId } } : { outcome: { outcome: "cancelled" } }; };
              // P-GOAL.13 (ADR-0067): an unattended /goal loop is governed by the per-command-type DIAL,
              // not the interactive allowlist — a command auto-runs iff its tier ≤ the shell dial; T4
              // always blocks. A block is recorded for the AAR. Default dial (unset) = safest (T0 only).
              if (this.goalActive && this.loopDial) {
                if (loopVerdict(this.loopDial.shell, cls.tier) === "auto") return approveOpt();
                this.loopBlocks.push({ iter: this.loopIter, tool: cls.key ?? "shell", tier: cls.tier, reason: cls.alwaysPrompt ? "catastrophic" : "risk-dial" });
                // P-ENT.2: a loop dial/catastrophic block is a SecurityEvent (fail-safe; never throws).
                emitSecurityEvent({ category: "loop", type: "loop_block", decision: "block", severity: cls.alwaysPrompt ? "critical" : "high", tool: cls.key ?? "shell", tier: cls.tier, reason: cls.reason, sessionId: this.sessionId ?? undefined });
                return { outcome: { outcome: "cancelled" } }; // blocked by the dial
              }
              const turnAllowed = interactive && (this.execTurnAll || (!!cls.key && this.execTurnPrograms.has(cls.key)));
              const verdict = execVerdict(execStore(), cls, { unattended: !interactive, turnAllowed });
              // P-GATE-DIAG.1: record WHY this exec call gets its outcome (esp. a no-prompt block).
              this.recordGateDiag({ kind: "exec", tool: cls.key ?? toolName, tier: cls.tier, askActive: this.askActive, listener: !!this.listener, goalActive: this.goalActive, autoRunning: this.autoRunning, interactive, verdict, decision: verdict === "allow" ? "allow" : (verdict === "prompt" && interactive) ? "prompt" : "block(no-ui)" });
              if (verdict === "allow") return approveOpt();
              if (verdict === "prompt" && interactive) return this.askExec(params, opts, cls, isEvalTool ? "eval" : (cmd ?? toolName));
              // P-ENT.2: an exec call blocked with no human to ask (unattended risky / catastrophic).
              emitSecurityEvent({ category: "exec", type: "exec_decision", decision: "block", severity: cls.alwaysPrompt ? "critical" : "high", tool: cls.key ?? "shell", tier: cls.tier, reason: cls.reason, sessionId: this.sessionId ?? undefined });
              return { outcome: { outcome: "cancelled" } }; // block: unattended risky, catastrophic, or no UI to ask
            }
            // P-EGRESS.1 (ADR-0062): a network-reaching tool — matched by name OR by carrying an external
            // http(s) URL (omp may report the browser tool with a generic kind, so name alone can miss it).
            // Unless a standing decision already allows the target, force the per-website approval dialog —
            // EVEN in Agent mode (egress is never silently auto-approved). Fail-closed: no live UI ⇒ deny.
            const isEgress = [...EGRESS_TOOLS].some((t) => toolName.includes(t)) || (!!target && /^https?:\/\//i.test(target));
            if (isEgress) {
              // P-NETWL.5 (ADR-0108): a web_search call (omp's default search providers, no arbitrary browse)
              // auto-approves when the user's posture allows web search - the pre-checked personal default.
              if ((toolName.includes("web_search") || toolName.includes("web-search")) && egressPosture().allowWebSearch) {
                this.recordGateDiag({ kind: "egress", tool: toolName.slice(0, 40), target: (target ?? "").slice(0, 80), localFile: false, askActive: this.askActive, listener: !!this.listener, goalActive: this.goalActive, autoRunning: this.autoRunning, decision: "allow(web-search)" });
                const a = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? "")) ?? opts[0];
                return a ? { outcome: { outcome: "selected", optionId: a.optionId } } : { outcome: { outcome: "cancelled" } };
              }
              // P-EGRESS.2 (ADR-0094): a browser-open of a LOCAL file (file:// or an absolute path) is not a
              // website visit — a host-based standing allow can't apply, so we still PROMPT, but with an
              // accurate local-file dialog (and never persist a host decision for it).
              const localFile = !!target && isLocalFileTarget(target);
              // P-NETWL.3 (ADR-0106): decide WITH context so `project`/`loop`-scoped whitelist entries apply,
              // and enforce a matched entry's per-loop `callBudget`. In a loop, once a budgeted host's calls
              // are used up the whitelist stops auto-allowing it (falls through to prompt/fail-closed block).
              const inLoop = this.goalActive;
              const d = !localFile && !!target
                ? egressDecisionDetailed(target, { project: currentWorkspace(), loop: inLoop })
                : { verdict: "prompt" as const, via: "host" as const };
              let standingAllow = d.verdict === "allow";
              if (standingAllow && d.via === "whitelist" && inLoop && d.entry?.callBudget != null) {
                const host = extractHost(target!) ?? target!;
                const used = this.loopHostCalls.get(host) ?? 0;
                if (!withinCallBudget(used, d.entry.callBudget)) {
                  standingAllow = false; // budget exhausted this loop → no longer auto-allowed
                  this.loopBlocks.push({ iter: this.loopIter, tool: "egress", tier: "T2", reason: "call-budget" });
                } else {
                  this.loopHostCalls.set(host, used + 1);
                }
              }
              // P-GATE-DIAG.1: record WHY this egress call gets its outcome (esp. a no-prompt block).
              this.recordGateDiag({ kind: "egress", tool: toolName.slice(0, 40), target: (target ?? "").slice(0, 80), localFile, askActive: this.askActive, listener: !!this.listener, goalActive: this.goalActive, autoRunning: this.autoRunning, decision: standingAllow ? "allow(standing)" : (this.askActive && this.listener) ? "prompt" : "block(no-ui)" });
              if (standingAllow) {
                const a = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? "")) ?? opts[0];
                return a ? { outcome: { outcome: "selected", optionId: a.optionId } } : { outcome: { outcome: "cancelled" } };
              }
              if (this.askActive && this.listener) return this.askEgress(params, opts, target ?? toolName, localFile);
              // P-ENT.3 (ADR-0094): no live UI to ask → fail-closed block, now AUDITED (was a silent block
              // with no SecurityEvent — the one gate path that left no trail).
              emitSecurityEvent({ category: "egress", type: "egress_decision", decision: "block", severity: "medium", tool: localFile ? "egress-local-file" : "egress", reason: `blocked (no UI to ask) · ${target ?? toolName}`.slice(0, 200), sessionId: this.sessionId ?? undefined });
              return { outcome: { outcome: "cancelled" } }; // no UI to ask → block the egress
            }
            // Ask mode (and only inside a live chat turn): hand the decision to the user.
            if (this.permissionMode === "ask" && this.askActive && this.listener) return this.askUser(params, opts);
            // Agent / Plan: auto-approve.
            const a = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? "")) ?? opts[0];
            return a ? { outcome: { outcome: "selected", optionId: a.optionId } } : { outcome: { outcome: "cancelled" } };
          }
          return {};
        };
        acp.onStderr = (chunk) => {
          for (const line of chunk.split("\n")) {
            // P-ASKSAGE.1 (ADR-0059): capture AskSage call diagnostics into the ring + echo to the dev
            // server console for terminal visibility. Best-effort parse — a malformed line is ignored.
            const di = line.indexOf("[ASKSAGE_DIAG]");
            if (di !== -1) {
              const jstart = line.indexOf("{", di);
              if (jstart !== -1) {
                try {
                  const rec = JSON.parse(line.slice(jstart));
                  this.asksageDiag.push({ at: Date.now(), ...rec });
                  if (this.asksageDiag.length > 200) this.asksageDiag.shift();
                  console.error(line.slice(di)); // surface in the dev server / Electron log
                } catch { /* not valid JSON — ignore */ }
              }
              continue;
            }
            const m = /\[BLOCKED tool_call:(\w+)\].*?severity=(\w+).*?findings=([^\s]+)/.exec(line);
            if (m) {
              // The authoritative security-gate block. Persist it GUI-side (the gate's own omp
              // child can't co-write the DB) so it reaches the Security panel + is reviewable.
              const rec = recordBlock({ tool: m[1]!, severity: m[2]!, findings: m[3]!, reason: "hidden-Unicode content quarantined", sessionId: this.sessionId ?? undefined });
              this.emit({ type: "block", tool: m[1]!, reason: "hidden-Unicode content quarantined", severity: m[2]!, findings: m[3]!, id: rec.id, quarantined: true });
            }
          }
        };
        acp.start();
        // P-EXEC.2 (ADR-0110): advertise `elicitation.form` so omp delivers its per-tool approval (and
        // plan-mode approval) as an `elicitation/create` we can answer (see answerElicitation). Without it
        // omp's tool wrapper silently denies every gated tool call ("Tool call denied by user").
        await acp.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, elicitation: { form: {} } } });
        this.acp = acp;
      })();
    }
    await this.starting;
  }

  private async ensureSession(): Promise<void> {
    await this.start();
    if (this.sessionId) return;
    const s: any = await this.acp!.request("session/new", { cwd: currentWorkspace(), mcpServers: mcpServersForAcp() });
    this.sessionId = s?.sessionId ?? s?.id ?? null;
    if (Array.isArray(s?.configOptions)) this.configOptions = s.configOptions;
    if (s?.modes) { this.availableModes = s.modes.availableModes ?? []; this.currentModeId = String(s.modes.currentModeId ?? "default"); }
    await sleep(350); // let available_commands_update arrive
    this.syncModelEnv();
  }

  /** P-LOC.1: the omp-reported active model id (from the `model` config option), or "" if unknown. */
  private activeModel(): string {
    const opt = this.configOptions.find((c) => c?.id === "model");
    const v = opt?.currentValue ?? opt?.value;
    return typeof v === "string" ? v : "";
  }
  /** P-LOC.1: set the AI-LOC attribution env for the NEXT omp spawn (model from the persisted last
   *  value; identity/source/repo from settings). The running child keeps the env it was spawned with. */
  private applyAttributionEnv(): void {
    const a = attribution();
    process.env.LUCID_MODEL = lastModel(); // "" until omp first reports one → gate records "unknown"
    process.env.LUCID_IDENTITY = a.identity;
    process.env.LUCID_IDENTITY_SOURCE = a.source;
    process.env.LUCID_REPO = currentWorkspace();
  }
  /** P-LOC.1: reconcile the authoring model for AI-LOC. Once omp reports its active model, persist it
   *  (so the NEXT omp spawn tags edits with it) and update process.env so any later respawn — provider
   *  key change, manual "Refresh models" — is accurate. We deliberately do NOT force a respawn here: a
   *  respawn drops the ACP session and slows cold start, and AI-LOC is best-effort. Net effect: edits in
   *  a brand-new install's first session (before the model is learned) record model 'unknown'; every
   *  session after that is exact. (ADR-0031, revised under P-IDE.1b.) */
  private syncModelEnv(): void {
    const model = this.activeModel();
    if (!model) return;
    setLastModel(model);
    process.env.LUCID_MODEL = model;
  }

  async getConfig(): Promise<any[]> { await this.ensureSession(); return this.configOptions; }
  /** The composer's 3-way control, derived from the omp mode + the client permission posture. */
  uiMode(): "agent" | "ask" | "plan" {
    if (this.currentModeId === "plan") return "plan";
    return this.permissionMode === "ask" ? "ask" : "agent";
  }
  /** P-ACP.2/3: the ACP session modes + the active omp mode + the derived 3-way UI mode. */
  async getModes(): Promise<{ available: any[]; current: string; ui: string; permissionMode: string }> {
    await this.ensureSession();
    return { available: this.availableModes, current: this.currentModeId, ui: this.uiMode(), permissionMode: this.permissionMode };
  }
  /** Switch the ACP session mode via session/set_mode (canonical; emits current_mode_update). */
  async setMode(modeId: string): Promise<{ available: any[]; current: string }> {
    await this.ensureSession();
    await this.acp!.request("session/set_mode", { sessionId: this.sessionId, modeId }).catch(() => {});
    this.currentModeId = modeId; // optimistic; current_mode_update will confirm/correct
    return { available: this.availableModes, current: this.currentModeId };
  }
  /** P-ACP.3: set the composer's Plan/Ask/Agent. Plan→omp `plan`; Agent/Ask→omp `default`, with
   *  Ask flipping permission forwarding on (the user approves each tool call). */
  async setUiMode(uiMode: "agent" | "ask" | "plan"): Promise<{ available: any[]; current: string; ui: string; permissionMode: string }> {
    this.permissionMode = uiMode === "ask" ? "ask" : "auto";
    await this.setMode(uiMode === "plan" ? "plan" : "default");
    return { available: this.availableModes, current: this.currentModeId, ui: this.uiMode(), permissionMode: this.permissionMode };
  }

  /** P-ACP.3: forward one tool-permission request to the UI and await the user's choice. Parks the
   *  JSON-RPC response until /api/chat/permission resolves it; fail-closed to "deny" on timeout. */
  private askUser(params: any, opts: any[]): Promise<any> {
    const id = `perm_${++this.permSeq}`;
    const tc = params?.toolCall ?? params?.tool_call ?? {};
    this.pendingPerms++; // pause the turn's idle/stall clock while we wait for a human
    this.emit({
      type: "permission", id,
      tool: String(tc.kind ?? tc.title ?? params?.tool ?? "tool"),
      detail: String(tc.title ?? tc.rawInput?.command ?? ""),
      options: opts.map((o) => ({ optionId: String(o.optionId ?? o.id ?? ""), name: String(o.name ?? o.optionId ?? "option"), kind: o.kind })),
    });
    return new Promise((resolve) => {
      const settle = (outcome: any) => { clearTimeout(t); this.permPending.delete(id); this.pendingPerms = Math.max(0, this.pendingPerms - 1); resolve(outcome); };
      const t = setTimeout(() => settle({ outcome: { outcome: "cancelled" } }), Backend.PERM_MS); // fail-closed
      this.permPending.set(id, (optionId) => settle(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } }));
    });
  }

  /** P-EGRESS.1 (ADR-0062): forward an EGRESS request as the per-website approval dialog (the rich
   *  options + the target URL for the Cloudflare-Radar check). The user's choice is persisted to the
   *  egress store, then mapped back to omp's own allow/deny option. Fail-closed: timeout ⇒ deny.
   *  P-EGRESS.2 (ADR-0094): when `localFile`, the target is a local file open (not a website) — show the
   *  open-once/block options, label it a local-file event in the audit, and persist no host decision. */
  private askEgress(params: any, opts: any[], target: string, localFile = false): Promise<any> {
    const id = `perm_${++this.permSeq}`;
    const tc = params?.toolCall ?? params?.tool_call ?? {};
    this.pendingPerms++;
    this.emit({ type: "permission", id, tool: String(tc.kind ?? "browser"), detail: target, url: target, egress: true, localFile, options: localFile ? EGRESS_LOCAL_OPTIONS : EGRESS_OPTIONS });
    const allowOpt = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? "")) ?? opts[0];
    const denyOpt = opts.find((o) => /(deny|reject|cancel|no)/i.test(o.kind ?? o.optionId ?? ""));
    const approve = () => allowOpt ? { outcome: { outcome: "selected", optionId: allowOpt.optionId } } : { outcome: { outcome: "cancelled" } };
    const block = () => denyOpt ? { outcome: { outcome: "selected", optionId: denyOpt.optionId } } : { outcome: { outcome: "cancelled" } };
    return new Promise((resolve) => {
      const settle = (outcome: any) => { clearTimeout(t); this.permPending.delete(id); this.pendingPerms = Math.max(0, this.pendingPerms - 1); resolve(outcome); };
      // P-ENT.4 (ADR-0069): audit the fail-closed TIMEOUT block too (was silent).
      const t = setTimeout(() => {
        emitSecurityEvent({ category: "egress", type: "egress_decision", decision: "block", severity: "medium", tool: localFile ? "egress-local-file" : "egress", reason: `${gateDenyReason(null, true)} · ${target}`.slice(0, 200), sessionId: this.sessionId ?? undefined });
        settle(block());
      }, Backend.PERM_MS);
      this.permPending.set(id, (optionId) => {
        const choice = String(optionId ?? "").replace(/^egress:/, "") as EgressChoice;
        const denied = !optionId || choice === "deny";
        // P-ENT.2 (ADR-0069): the egress decision as a SecurityEvent. P-ENT.4: distinguish you-blocked from
        // a fail-closed (turn-ended) auto-deny so the audit answers "did I deny it, or did it auto-deny?".
        emitSecurityEvent({ category: "egress", type: "egress_decision", decision: denied ? "block" : "allow", severity: "medium", tool: localFile ? "egress-local-file" : "egress", reason: `${denied ? gateDenyReason(optionId) : choice} · ${target}`.slice(0, 200), sessionId: this.sessionId ?? undefined });
        if (denied) { settle(block()); return; }
        // A local file has no host to remember (allow-once only), so persist nothing for it.
        if (!localFile) { try { recordEgress(target, choice); } catch { /* best-effort persistence */ } }
        settle(approve());
      });
    });
  }
  /** P-EXEC.1 (ADR-0066): forward a risky exec request as the per-command approval dialog (command +
   *  program key + why). The user's choice folds into the exec store (allow-program / danger) or the
   *  in-memory turn scope (allow-turn); allow-once / deny persist nothing. Fail-closed: timeout ⇒ block. */
  private askExec(params: any, opts: any[], cls: ExecClass, command: string): Promise<any> {
    const id = `perm_${++this.permSeq}`;
    this.pendingPerms++;
    // No pinnable program (catastrophic or compound) ⇒ only once / this-turn / deny.
    const limited = cls.alwaysPrompt || !cls.key;
    this.emit({
      type: "permission", id, tool: "exec", detail: command, exec: true,
      program: cls.key ?? undefined, reason: cls.reason, danger: cls.alwaysPrompt,
      options: limited ? EXEC_OPTIONS_LIMITED : EXEC_OPTIONS_FULL,
    });
    const allowOpt = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? "")) ?? opts[0];
    const denyOpt = opts.find((o) => /(deny|reject|cancel|no)/i.test(o.kind ?? o.optionId ?? ""));
    const approve = () => allowOpt ? { outcome: { outcome: "selected", optionId: allowOpt.optionId } } : { outcome: { outcome: "cancelled" } };
    const block = () => denyOpt ? { outcome: { outcome: "selected", optionId: denyOpt.optionId } } : { outcome: { outcome: "cancelled" } };
    return new Promise((resolve) => {
      const settle = (o: any) => { clearTimeout(t); this.permPending.delete(id); this.pendingPerms = Math.max(0, this.pendingPerms - 1); resolve(o); };
      // P-ENT.4 (ADR-0069): a fail-closed TIMEOUT is a real block — audit it too (it used to settle silently,
      // so a denial could happen with no SecurityEvent — the "why did I get a deny with no record?" gap).
      const t = setTimeout(() => {
        emitSecurityEvent({ category: "exec", type: "exec_decision", decision: "block", severity: cls.alwaysPrompt ? "critical" : "high", tool: cls.key ?? "shell", tier: cls.tier, reason: `${gateDenyReason(null, true)} · ${cls.reason}`, sessionId: this.sessionId ?? undefined });
        settle(block());
      }, Backend.PERM_MS);
      this.permPending.set(id, (optionId) => {
        const choice = String(optionId ?? "").replace(/^exec:/, "") as ExecChoice;
        // P-ENT.2 (ADR-0069): record the human's exec decision as a SecurityEvent (fail-safe). P-ENT.4: the
        // reason distinguishes an explicit "denied by you" from a "fail-closed (turn ended)" auto-deny.
        const denied = !optionId || choice === "deny";
        emitSecurityEvent({ category: "exec", type: "exec_decision", decision: denied ? "block" : "allow", severity: cls.alwaysPrompt ? "critical" : "medium", tool: cls.key ?? "shell", tier: cls.tier, reason: `${denied ? gateDenyReason(optionId) : choice} · ${cls.reason}`, sessionId: this.sessionId ?? undefined });
        if (denied) { settle(block()); return; }
        if (choice === "allow-turn") { if (cls.key) this.execTurnPrograms.add(cls.key); else this.execTurnAll = true; } // in-memory only
        else { try { recordExec(cls, choice); } catch { /* best-effort persistence */ } }
        settle(approve());
      });
    });
  }
  /** Resolve a parked permission from the UI. `optionId` null/empty ⇒ deny (cancelled). */
  resolvePermission(id: string, optionId: string | null): boolean {
    const fn = this.permPending.get(id);
    if (!fn) return false;
    fn(optionId && optionId.length ? optionId : null);
    return true;
  }
  async getCommands(): Promise<any[]> { await this.ensureSession(); return this.commands.map((c) => ({ name: c.name, description: c.description, hint: c.input?.hint })); }
  async setConfig(configId: string, value: string): Promise<any[]> {
    await this.ensureSession();
    const r: any = await this.acp!.request("session/set_config_option", { sessionId: this.sessionId, configId, value }).catch(() => null);
    if (Array.isArray(r?.configOptions)) this.configOptions = r.configOptions;
    if (configId === "model") this.syncModelEnv(); // persist the new authoring model for AI-LOC (ADR-0031)
    return this.configOptions;
  }
  /** The live ACP session id (matches the omp on-disk session id), or null when fresh.
   *  Used by the delete route to close the session before removing its file (#53). */
  currentSessionId(): string | null { return this.sessionId; }

  /** Resume a past session so the next prompt continues it. */
  async loadSession(id: string): Promise<void> {
    await this.start();
    await this.acp!.request("session/load", { sessionId: id, cwd: currentWorkspace(), mcpServers: mcpServersForAcp() }).catch(() => {});
    this.sessionId = id;
  }

  async newSession(): Promise<void> {
    await this.start();
    if (this.sessionId) await this.acp!.request("session/close", { sessionId: this.sessionId }).catch(() => {});
    this.sessionId = null;
    this.memoryRecallDelivered = false; // re-deliver the cross-session recall once in the fresh session
    await this.ensureSession();
  }

  /** Tear down the omp process so the next call respawns it (e.g. after an API
   *  key changes - the new env is picked up on the fresh spawn). */
  restart(): void {
    try { this.acp?.stop(); } catch { /* ignore */ }
    try { this.utilAcp?.stop(); } catch { /* ignore */ } // P-KG-INGEST.4: respawn the util omp too (fresh env/keys)
    this.acp = null; this.starting = null; this.sessionId = null; this.listener = null;
    this.utilAcp = null; this.utilStarting = null; this.utilSink = null;
    this.memoryRecallDelivered = false; // persona/skill/profile are re-delivered every turn anyway (#54)
    this.availableModes = []; this.currentModeId = "default"; // re-captured from the fresh session
    // Drop any parked permission (deny) but KEEP permissionMode — the user's Ask choice survives a respawn.
    for (const [, fn] of this.permPending) fn(null);
    this.permPending.clear(); this.pendingPerms = 0; this.askActive = false;
  }

  // Max silence (no token/tool/usage event) before we treat a turn as stalled. omp's
  // ACP request has no timeout, so without this a rate-limited / hung turn leaves the UI
  // on "Thinking…" forever. Resets on every event, so a legitimately long turn is fine —
  // only TOTAL silence for this long trips it.
  // 5 min. Native providers stream tokens every few seconds so they almost never trip this; the headroom
  // is for the NON-STREAMED AskSage gov gateway, where a single big call emits nothing for minutes and a
  // 2-min cap false-stalled live turns ("gave up on the provider"). The auto-continue checker (ADR-0060)
  // will eventually turn a stall into a wellness-check + resume rather than a dead end.
  private static readonly IDLE_MS = 300_000;

  /** Run one turn, streaming events to onEvent; resolves after `done`. Captures the
   *  assistant reply so the personalization distiller can learn from the turn (P9.2).
   *  A stall (no activity for IDLE_MS) ends the turn with a clear error instead of hanging. */
  async prompt(text: string, onEvent: (e: ChatEvent) => void): Promise<void> {
    let assistant = "";
    let stalled = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let onStall: (e: Error) => void = () => {};
    // While a permission is awaiting the user (Ask mode), pause the idle/stall clock — a human
    // deciding is not a stalled turn (askUser has its own fail-closed timeout).
    const arm = () => { if (idle) clearTimeout(idle); if (this.pendingPerms > 0) return; idle = setTimeout(() => { stalled = true; onStall(new Error("the model did not respond for 2 minutes — the provider may be rate-limited (check your hourly budget) or the turn stalled. Try again.")); }, Backend.IDLE_MS); };
    let enqueueErr = 0; // counts browser-stream write failures (orphaned/closed client stream)
    // Only learnable assistant text accrues to `assistant` (→ recordTurns + learnFromTurn). Thinking
    // and other display-only events are excluded by construction (R-04 / ADR-0054).
    const sink = (e: ChatEvent) => { arm(); if (isLearnableAssistantText(e)) assistant += e.text; try { onEvent(e); } catch { enqueueErr++; } };
    this.listener = sink;
    this.askActive = true; // permission requests in THIS turn may be forwarded to the UI (Ask mode)
    this.execTurnPrograms.clear(); this.execTurnAll = false; // P-EXEC.1: allow-turn scope is per-turn
    this.chatGate.begin(); // P-KG-INGEST.3: a chat turn is live → background extraction should yield to it
    this.turnDiag(`prompt.start session=${this.sessionId}`);
    try {
      await this.ensureSession();
      // Assemble the user-turn preamble (never the frozen prefix; invariant #5/#6). Issue #54:
      // persona + skill + the live <user-profile> profile are STANDING guidance re-delivered every
      // turn; the cross-session <recalled-memory> is a one-time session-start recall. See preamble.ts.
      const built = buildUserTurnPreamble({
        persona: this.persona,
        skill: this.skill,
        profile: recallPreamble(), // P9.2: re-read each turn so newly-learned facts show up
        memoryRecall: this.memoryRecall,
        memoryRecallDelivered: this.memoryRecallDelivered,
      });
      this.memoryRecallDelivered = built.memoryRecallDelivered;
      const body = built.preamble + text;
      arm(); // start the idle clock now (covers a stall BEFORE the first token)
      const stall = new Promise<never>((_, reject) => { onStall = reject; });
      const promptRes = await Promise.race<any>([
        this.acp!.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: body }] }),
        stall,
      ]);
      // P-GOAL-DIAG.1 (ADR-0074): the omp turn's stopReason tells us WHY a maker turn ended (e.g. an
      // empty/early end on a thinking-heavy Claude turn) — invaluable for the model-specific loop bug.
      this.turnDiag(`prompt.resolved session=${this.sessionId} chars=${assistant.length} stopReason=${promptRes?.stopReason ?? "?"} enqueueErr=${enqueueErr} listenerIntact=${this.listener === sink}`);
    } catch (e) {
      this.turnDiag(`prompt.${stalled ? "stalled" : "error"} session=${this.sessionId} chars=${assistant.length} enqueueErr=${enqueueErr} listenerIntact=${this.listener === sink} msg=${String((e as any)?.message ?? e).slice(0, 80)}`);
      onEvent({ type: "token", text: `\n[${stalled ? "stalled" : "agent unavailable"}: ${String((e as any)?.message ?? e)}]` });
    } finally {
      if (idle) clearTimeout(idle);
      this.askActive = false;
      this.chatGate.end(); // P-KG-INGEST.3: chat turn done → release any extraction waiting to resume
      // Fail-closed: any permission still parked at turn's end (stall/disconnect) is denied.
      for (const [id, fn] of this.permPending) { this.permPending.delete(id); fn(null); }
      this.pendingPerms = 0;
    }
    this.listener = null;
    // Carry the FULL accumulated reply on `done` so the UI can reconcile a lossy live stream (if some
    // token chunks didn't reach the browser, the turn still renders the complete final answer on settle).
    onEvent({ type: "done", text: assistant });
    void learnFromTurn(text, assistant, (sys, usr) => this.complete(sys, usr)); // best-effort; the model extractor (opt-in) uses complete()
    // ADR-0009 Phase B (issue #12): capture the turn for traceability. Sanitized + sha only,
    // GUI-side (can't co-write DuckDB); fully guarded so it never affects the chat.
    recordTurns({ sessionId: this.sessionId ?? "", userText: text, assistantText: assistant });
  }

  // P-GOAL.1 (ADR-0046): the /goal loop. Run MAKER iterations on the persistent session toward `goal`,
  // and after each one a SEPARATE checker decides if the verifiable `condition` is met (running `command`
  // when given). Capped at `maxIters`, auto-stops on no-progress. Runs UNATTENDED — permissions are
  // auto-approved for the duration, but every tool call is still scanned fail-closed by the in-process
  // gate (that, not human approval, is the safety boundary). Streams the usual chat events plus goal-*.
  async runGoal(opts: { goal: string; condition: string; command?: string; maxIters: number; resume?: string; budgetUsd?: number; criteria?: string; dial?: LoopDial }, onEvent: (e: ChatEvent) => void): Promise<void> {
    const goal = opts.goal.trim();
    const condition = (opts.condition || opts.command || "the goal is fully accomplished").trim();
    const command = opts.command?.trim() || "";
    const criteria = opts.criteria?.trim() || ""; // P-GOAL.12: matured success criteria for the checker
    const maxIters = Math.min(Math.max(1, Math.floor(opts.maxIters) || 6), 20); // hard ceiling
    const budgetUsd = normalizeBudget(opts.budgetUsd); // P-GOAL.11: 0 = no cap (iteration cap stays the ceiling)
    const prevMode = this.permissionMode;
    this.permissionMode = "auto"; // unattended: auto-approve tool calls (the gate still scans every one)
    this.goalActive = true; this.goalCancelled = false;
    // P-GOAL.13 (ADR-0067): the loop's exec policy is the per-command-type DIAL, clamped by the managed
    // loop ceiling (ADR-0068, tighten-only). An unset dial defaults to the safest posture (T0 only).
    const loopMax = managedConfig().config?.security?.loop?.maxAutoTier;
    const rawDial = opts.dial ?? {};
    this.loopDial = { shell: clampDialRow(rawDial.shell, loopMax), edit: clampDialRow(rawDial.edit, loopMax), delete: clampDialRow(rawDial.delete, loopMax), "web-fetch": clampDialRow(rawDial["web-fetch"], loopMax), "web-search": clampDialRow(rawDial["web-search"], loopMax), subagent: clampDialRow(rawDial.subagent, loopMax) };
    this.loopBlocks = []; this.loopIter = 0; this.loopHostCalls.clear();
    // P-GOAL.3/4: durable on-disk memory (best-effort). `resume` continues an existing loop-memory file
    // and injects its prior progress; otherwise start a fresh record.
    const resumed = opts.resume ? resumeGoalMemory(currentWorkspace(), opts.resume) : null;
    // P-GOAL.9: a stable id shared by the memory file and the After-Action Report (same `<id>-<slug>`
    // stem). When resuming, reuse the existing file's id so the report lands beside it.
    const loopId = resumed ? (resumed.mem.rel.split("/").pop()?.split("-")[0] || Date.now().toString(36)) : Date.now().toString(36);
    const mem: GoalMemory | null = resumed ? resumed.mem : startGoalMemory(currentWorkspace(), loopId, { goal, condition, command });
    if (mem) onEvent({ type: "goal-memory", path: mem.rel });
    const memNote = mem ? ` Your durable progress memory is the file ${mem.rel} (it records what's done across iterations).` : "";
    // P-GOAL.9 fix: inject the TAIL of the prior progress (the most-recent iterations), not the head —
    // a long resumed loop must see what it just did, not the stale opening rounds.
    const resumeNote = resumed ? `\n\nThis loop was already in progress. Below is the most recent progress — do NOT redo completed work, continue from where it stopped:\n${resumed.prior.slice(-3000)}` : "";

    // ── P-GOAL.9 (ADR-0054): run-time instrumentation feeding the After-Action Report ──────────────
    const startedAt = Date.now();
    const toolCalls: Record<string, number> = {};
    const errors: { iter: number; detail: string }[] = [];
    const websites = new Set<string>();
    const perIteration: IterStat[] = [];
    // LOC: pin a baseline COMMIT now; at the end, diff the tree against it (captures committed-since +
    // uncommitted) and subtract any changes that were already present at start. Best-effort, git-only.
    const startRef = this.gitHead();
    const startDiff = startRef ? this.gitDiffVs(startRef) : null;
    let terminalOutcome: LoopOutcome = "stopped";
    let terminalReason = `stopped: hit the ${maxIters}-iteration cap without meeting the condition`;

    let noProgress = 0;
    let lastSig = "";       // P-GOAL.9 (#2 Infinite Fix Loop): the prior round's blocker signature
    let stallCount = 0;     // consecutive rounds stuck on the SAME blocker
    let lastIterErrors = 0; // P-GOAL.9 (#3): tool failures last round, fed back into the next prompt
    // P-GOAL.11 (ADR-0056): live spend + budget kill switch. We own the turn boundaries, so spend is
    // just the sum of each maker turn's PEAK cost; context tokens are tracked as a peak, never summed.
    let spend: LoopSpend = newLoopSpend();
    let sawUsage = false;   // false ⇒ no usage telemetry at all ⇒ report spend as "unknown", not "$0"
    try {
      for (let i = 1; i <= maxIters; i++) {
        if (this.goalCancelled) { terminalOutcome = "cancelled"; terminalReason = "stopped by you"; onEvent({ type: "goal-stop", reason: terminalReason }); finishGoalMemory(mem, terminalReason); return; }
        this.loopIter = i; // P-GOAL.13: tag any dial/scanner block this iteration with its round number
        onEvent({ type: "goal-iter", n: i, max: maxIters });
        let work = "";
        let actedThisIter = false;
        let iterTools = 0, iterErrors = 0;
        let iterThink = 0, iterThinkChars = 0; // P-GOAL-DIAG.1 (ADR-0074): catch a thinking-only maker turn
        let turnPeakCost = 0, turnPeakCtx = 0, budgetHit = false;
        // Forward the maker's stream, but swallow the per-iteration `done` so the client sees ONE loop.
        const sink = (e: ChatEvent) => {
          if (e.type === "done") return;
          if (e.type === "token") work += e.text;
          if (e.type === "tool") { actedThisIter = true; iterTools++; const t = normalizeToolName(e.name); toolCalls[t] = (toolCalls[t] ?? 0) + 1; for (const u of extractUrls(e.detail)) websites.add(u); }
          else if (e.type === "subagent") { actedThisIter = true; iterTools++; toolCalls.subagent = (toolCalls.subagent ?? 0) + 1; }
          else if (e.type === "block") {
            iterErrors++; errors.push({ iter: i, detail: `${e.tool}: ${e.reason}`.slice(0, 200) });
            // P-GOAL.13: a fail-closed SCANNER block (quarantined) is also a first-class loop block —
            // a DIFFERENT layer from the risk dial, tallied separately in the AAR's Blocks section.
            if (e.quarantined) this.loopBlocks.push({ iter: i, tool: e.tool, tier: "T4", reason: "security-gate" });
          }
          else if (e.type === "thinking") { iterThink++; iterThinkChars += e.text.length; }
          else if (e.type === "usage") {
            sawUsage = true;
            turnPeakCost = Math.max(turnPeakCost, e.cost);
            turnPeakCtx = Math.max(turnPeakCtx, e.used);
            // P-GOAL.11 kill switch: abort THIS turn the instant running spend crosses the cap.
            if (!budgetHit && overBudget(spend.usd + turnPeakCost, budgetUsd)) { budgetHit = true; this.cancel(); }
          }
          onEvent(e);
        };
        // P-GOAL.9 (#3): when the previous round had failed/blocked tool calls, tell the maker so it
        // changes approach instead of re-issuing the same failing call.
        const failNote = lastIterErrors > 0 ? ` Note: ${lastIterErrors} tool call${lastIterErrors === 1 ? "" : "s"} failed or were blocked last round — fix the cause (paths, permissions, syntax) rather than repeating them.` : "";
        const iterText = i === 1
          ? `${goal}\n\nWork toward this goal now. The stop condition is: ${condition}${command ? ` (verified by running \`${command}\`)` : ""}. Take the next concrete step.${memNote}${resumeNote}`
          : `Continue toward the goal. Stop condition: ${condition}. Take the next concrete step; if you believe the condition now holds, say so briefly and stop.${memNote}${failNote}`;
        await this.prompt(iterText, sink);
        // P-GOAL-DIAG.1 (ADR-0074): dev-mode breakdown of WHAT this maker turn emitted. A model-specific
        // empty turn (e.g. Claude with high thinking streaming thinking-only, no tool calls / no answer)
        // shows here as answer_chars=0 tools=0 with thinking_chars>0 — the exact signature behind the
        // checker's "no output / no changes" verdict. Off unless developer mode is on.
        this.turnDiag(`goal.iter ${i} maker-turn: answer_chars=${work.length} thinking=${iterThink}/${iterThinkChars}c tools=${iterTools} blocks=${iterErrors} acted=${actedThisIter}`);
        for (const u of extractUrls(work)) websites.add(u); // links the maker mentioned in its own text
        lastIterErrors = iterErrors;
        spend = addTurnSpend(spend, turnPeakCost, turnPeakCtx); // P-GOAL.11: fold this turn's peak into the running spend
        if (this.goalCancelled) { perIteration.push({ n: i, tools: iterTools, errors: iterErrors, done: false, reason: "cancelled" }); terminalOutcome = "cancelled"; terminalReason = "stopped by you"; onEvent({ type: "goal-stop", reason: terminalReason }); finishGoalMemory(mem, terminalReason); return; }
        // P-GOAL.11 (ADR-0056): budget kill switch — once spend crosses the cap, stop the loop (the
        // current turn was already aborted mid-stream above). The bill can't run away unattended.
        if (overBudget(spend.usd, budgetUsd)) {
          perIteration.push({ n: i, tools: iterTools, errors: iterErrors, done: false, reason: `budget cap ${formatSpend(budgetUsd)} reached` });
          terminalReason = `stopped: budget cap ${formatSpend(budgetUsd)} reached (spent ${formatSpend(spend.usd)})`;
          onEvent({ type: "goal-stop", reason: terminalReason }); finishGoalMemory(mem, terminalReason); return;
        }

        const verdict = await this.checkGoal({ goal, condition, command, lastWork: work, criteria });
        onEvent({ type: "goal-check", n: i, done: verdict.done, reason: verdict.reason });
        appendGoalIteration(mem, i, work, verdict);
        perIteration.push({ n: i, tools: iterTools, errors: iterErrors, done: verdict.done, reason: verdict.reason });
        if (verdict.done) { terminalOutcome = "met"; terminalReason = verdict.reason; onEvent({ type: "goal-done", iters: i, reason: verdict.reason }); finishGoalMemory(mem, `Goal met in ${i} iteration${i === 1 ? "" : "s"}: ${verdict.reason}`); return; }

        // P-GOAL.9 (#2): if the checker reports the SAME blocker three rounds running, the loop is not
        // converging — stop and surface it rather than burning iterations on an unbreakable wall.
        const sig = stallSignature(verdict.reason);
        stallCount = sig && sig === lastSig ? stallCount + 1 : 1;
        lastSig = sig;
        if (stallCount >= 3) { terminalReason = `stopped: not converging — the same blocker held for ${stallCount} rounds (${verdict.reason})`; onEvent({ type: "goal-stop", reason: terminalReason }); finishGoalMemory(mem, terminalReason); return; }

        noProgress = actedThisIter ? 0 : noProgress + 1;
        if (noProgress >= 2) { terminalReason = "stopped: two iterations with no actions and the condition still unmet"; onEvent({ type: "goal-stop", reason: terminalReason }); finishGoalMemory(mem, "stopped: no progress for two iterations"); return; }
      }
      onEvent({ type: "goal-stop", reason: terminalReason });
      finishGoalMemory(mem, terminalReason);
    } catch (e) {
      terminalOutcome = "error";
      terminalReason = `loop error: ${String((e as Error)?.message ?? e)}`;
      onEvent({ type: "goal-stop", reason: terminalReason });
      finishGoalMemory(mem, terminalReason);
    } finally {
      this.goalActive = false;
      this.permissionMode = prevMode;
      // P-GOAL.9: the loop's LAST task — assemble metrics + render the After-Action Report. Wholly
      // best-effort: a failure here is swallowed so the turn always settles with `done`.
      try {
        let loc: LocStat | null = null;
        if (startRef) {
          const end = this.gitDiffVs(startRef);
          if (end) loc = { added: Math.max(0, end.added - (startDiff?.added ?? 0)), removed: Math.max(0, end.removed - (startDiff?.removed ?? 0)), files: end.files };
        }
        const metrics: LoopMetrics = {
          goal, condition, command: command || undefined,
          outcome: terminalOutcome, outcomeReason: terminalReason || "(no reason recorded)",
          iterations: perIteration.length, maxIters, durationMs: Date.now() - startedAt,
          toolCalls, loc, errors, websites: [...websites], perIteration,
          // P-GOAL.13 (ADR-0067): what the dial/scanner stopped, and the dial posture this run used.
          blocks: [...this.loopBlocks], dial: this.loopDial ?? undefined,
          // P-GOAL.11: actual spend (null when no usage telemetry was seen) + the cap that was in force.
          spendUsd: sawUsage ? spend.usd : null,
          peakContextTokens: sawUsage ? spend.peakContextTokens : null,
          budgetUsd: budgetUsd || undefined,
        };
        const markdown = renderLoopReport(metrics);
        const path = saveGoalReport(currentWorkspace(), loopId, goal, markdown) ?? "";
        if (mem && path) { try { finishGoalMemory(mem, `After-Action Report: ${path}`); } catch { /* best-effort */ } }
        // P-GOAL.10: append this run to the cross-run evaluation ledger (best-effort).
        try { appendRunLog(currentWorkspace(), toRunRecord(metrics, { id: loopId, ts: Date.now() })); } catch { /* best-effort */ }
        onEvent({ type: "goal-report", path, summary: summarizeLoop(metrics), markdown });
      } catch { /* the report never blocks the loop's completion */ }
      // P-GOAL.13: clear the loop's exec posture so a later interactive turn isn't governed by a stale dial.
      this.loopDial = null; this.loopBlocks = []; this.loopIter = 0;
      onEvent({ type: "done" });
    }
  }

  /** P-GOAL.9: the current HEAD commit, or null when the workspace isn't a git repo / git is absent.
   *  Best-effort and quick (5s cap); a missing baseline just means the report shows "LOC n/a". */
  private gitHead(): string | null {
    try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: currentWorkspace(), encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
    catch { return null; }
  }
  /** P-GOAL.9: parsed `git diff --numstat <ref>` for the working tree vs `ref` (tracked changes,
   *  staged + unstaged + committed-since). Null on any git failure — LOC tracking is best-effort. */
  private gitDiffVs(ref: string): LocStat | null {
    try { return parseNumstat(execFileSync("git", ["diff", "--numstat", ref], { cwd: currentWorkspace(), encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })); }
    catch { return null; }
  }

  /** P-GOAL.2: stop a running /goal loop — aborts the current maker turn and halts further iterations.
   *  No-op when no loop is active. */
  cancelGoal(): void { if (this.goalActive) { this.goalCancelled = true; this.cancel(); } }
  /** Whether a /goal loop is currently running (so the UI routes Stop to cancelGoal, not cancelChat). */
  isGoalRunning(): boolean { return this.goalActive; }

  /** P-GOAL.10 (ADR-0055): the cross-run evaluation surface — aggregate stats over the run-log plus the
   *  most-recent runs for a compact history view. Reads the workspace's `.omp/loops/run-log.jsonl`. */
  loopRunStats(limit = 10): { stats: RunStats; summary: string; recent: LoopRunRecord[] } {
    const records = readRunLog(currentWorkspace());
    const stats = aggregateRuns(records);
    return { stats, summary: summarizeRunStats(stats), recent: records.slice(0, Math.max(0, limit)) };
  }

  /** P-GOAL.12 (ADR-0057): the branches + worktrees the Pre-Flight Audit offers as loop scope. Best-effort. */
  private gitLines(args: string[]): string[] {
    try { return execFileSync("git", args, { cwd: currentWorkspace(), encoding: "utf8", timeout: 5_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\n").map((s) => s.trim()).filter(Boolean); }
    catch { return []; }
  }
  loopScopes(): { current: string; branches: string[]; worktrees: string[] } {
    const current = this.gitLines(["rev-parse", "--abbrev-ref", "HEAD"])[0] ?? "";
    const branches = this.gitLines(["branch", "--format=%(refname:short)"]);
    const worktrees = this.gitLines(["worktree", "list", "--porcelain"]).filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9).trim());
    return { current, branches, worktrees };
  }

  /** P-GOAL.12 (ADR-0057): the Pre-Flight Audit. Reads prior-run history (so the new loop carries past
   *  context, not re-solving old blockers), runs ONE prompt-engineering interview pass on the cheap checker
   *  model to mature the goal (best-effort; falls back to the user's structured answers), scores readiness
   *  against the rubric, and writes a durable Loop Design report. Returns the matured goal to adopt + the
   *  report. Never mutates the loop or the session — it's a planning step. */
  async preflightAudit(spec: PreflightSpec): Promise<{ maturedGoal: string; criteria: string; reportMd: string; reportPath: string; readiness: ReadinessReport; prior: { total: number; relevant: number } }> {
    const ws = currentWorkspace();
    const records = readRunLog(ws);                                  // history awareness
    const relevant = relevantPriorRuns(records, spec.goal, 3);
    let matured: PreflightSpec = spec;
    let maturedGoal = "";
    try {
      const model = resolveCheckerModel({ chosen: checkerModel(), models: this.accessibleModels(), current: this.activeModel() }).value;
      const out = await this.complete(preflightSystemPrompt(), preflightUserPrompt(spec, summarizePriorRuns(relevant)), { idleMs: 90_000, model });
      const fields = parsePreflightJson(out);
      matured = mergeMatured(spec, fields);
      maturedGoal = fields.maturedGoal || "";
    } catch { /* model unavailable — fall back to the user's structured answers */ }
    if (!maturedGoal) maturedGoal = maturedGoalFrom(matured);        // deterministic fallback
    const readiness = assessReadiness(matured);
    const reportMd = renderLoopDesign(matured, readiness, maturedGoal, { total: records.length, relevant });
    const reportPath = savePreflightReport(ws, Date.now().toString(36), spec.goal || "loop", reportMd) ?? "";
    return { maturedGoal, criteria: successCriteria(matured), reportMd, reportPath, readiness, prior: { total: records.length, relevant: relevant.length } };
  }

  // P-GOAL.5 (ADR-0047): the automation scheduler. Arm a timer that, while the app is open, fires the
  // first DUE automation through runGoal — same maker/checker loop, same fail-closed gate, same durable
  // memory. The OS is never involved; nothing runs once the app is closed (that's the safe envelope).
  startAutomationScheduler(): void {
    if (this.autoTimer) return;
    this.autoTimer = setInterval(() => { void this.tickAutomations(); }, Backend.AUTO_TICK_MS);
    if (typeof (this.autoTimer as any)?.unref === "function") (this.autoTimer as any).unref(); // don't keep the process alive
  }
  stopAutomationScheduler(): void { if (this.autoTimer) { clearInterval(this.autoTimer); this.autoTimer = null; } }

  /** One scheduler tick: never overlap a live chat turn or another loop; run at most one due automation. */
  private async tickAutomations(): Promise<void> {
    if (this.askActive || this.goalActive || this.autoRunning || this.pendingPerms > 0) return; // never preempt the user
    const due = nextDueAutomation(currentWorkspace(), Date.now());
    if (!due) return;
    await this.runAutomation(due.id).catch(() => {}); // a background run must never crash the timer
  }

  /** Run one saved automation now (the scheduler's tick, or a manual "run now"). Records the outcome to
   *  the store so the UI can show last-run status. Background runs stream nowhere — the durable goal
   *  memory file (written by runGoal) is the audit trail. */
  async runAutomation(id: string, onEvent?: (e: ChatEvent) => void): Promise<{ ran: boolean; result?: string }> {
    if (this.autoRunning || this.goalActive || this.askActive) return { ran: false };
    const ws = currentWorkspace();
    const a: Automation | undefined = listAutomations(ws).find((x) => x.id === id);
    if (!a) return { ran: false };
    this.autoRunning = true;
    // Stamp lastRunAt up-front so a slow run can't be re-fired by the next tick before it finishes.
    updateAutomation(ws, id, { lastRunAt: Date.now() });
    // P-AGENT.14 (ADR-0142): scheduled BUILT-AGENT runs. Fail-closed gate first: only a trusted, loadable,
    // approval-free spec runs unattended. A missing/untrusted agent SUSPENDS the schedule (disable + reason);
    // approval checkpoints refuse the tick but keep the schedule armed. The run itself goes through the SAME
    // startAgentRun pipeline as the Builder's Run button — gate first, allow-list, stored trust, run trace.
    if (a.kind === "agent") {
      let result = "ran";
      try {
        const spec = a.agentSpecId ? loadSpecFile(ws, a.agentSpecId) : null;
        const trust = a.agentSpecId ? loadSpecTrust(ws, a.agentSpecId) : { trustLabel: "quarantined" as const, reason: "no agent" };
        const gate = agentAutomationGate(spec, trust.trustLabel);
        if (!gate.run) {
          result = gate.result ?? "refused";
          if (gate.disable) updateAutomation(ws, id, { enabled: false });
        } else {
          const r = await startAgentRun({ spec: spec!, prompt: a.agentPrompt ?? "", model: a.agentModel || "haiku", workspace: ws, trustLabel: trust.trustLabel });
          result = r.blocked ? `blocked: ${r.reason ?? "refused"}` : r.error ? `error: ${r.error}` : r.paused ? "refused: halted at an approval checkpoint" : `ok: ${(r.output ?? "").slice(0, 160) || "(no output)"}${r.runId ? ` [${r.runId}]` : ""}`;
        }
      } catch (e) {
        result = `error: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        this.autoRunning = false;
        updateAutomation(ws, id, { lastRunAt: Date.now(), lastResult: result.slice(0, 200) });
      }
      return { ran: true, result };
    }
    let result = "ran";
    try {
      await this.runGoal(
        { goal: a.goal, condition: a.condition, command: a.command, maxIters: a.maxIters },
        (e) => {
          if (e.type === "goal-done") result = `goal met: ${e.reason}`;
          else if (e.type === "goal-stop") result = e.reason;
          onEvent?.(e);
        },
      );
    } catch (e) {
      result = `error: ${String((e as Error)?.message ?? e)}`;
    } finally {
      this.autoRunning = false;
      updateAutomation(ws, id, { lastRunAt: Date.now(), lastResult: result.slice(0, 200) });
    }
    return { ran: true, result };
  }

  /** The "AskSage only" model lock, from either the user's setting or org-managed config (the new
   *  `models.asksageOnly` block plus the legacy top-level flag, via managedAsksageOnly). */
  private asksageLocked(): boolean { return asksageOnly() || managedAsksageOnly(); }

  // P-GOAL.6 (ADR-0048): the user's accessible models, as the model config reports them (provider-
  // prefixed value + display name). Empty until omp has reported a config.
  private accessibleModels(): ModelOption[] {
    const opt = this.configOptions.find((c) => c?.id === "model");
    const list = Array.isArray(opt?.options) ? opt!.options : [];
    const models = list.filter((o: any) => o?.value).map((o: any) => ({ value: String(o.value), name: o.name, description: o.description }));
    // P-GOAL.6.1: when the AskSage lock is on, the checker must use a GOV model routed through AskSage —
    // restrict to asksage providers whose id is a GOV model. Fail-safe: only narrow if such models exist
    // (never empty the list, which would drop the picker / the recommendation to the maker model).
    if (this.asksageLocked()) {
      const gov = models.filter((m: ModelOption) => /^asksage/i.test(m.value) && /gov/i.test(m.value));
      if (gov.length) return gov;
    }
    return models;
  }
  /** P-GOAL.6: the CHECKER model picker state for the UI — the user's saved choice, the auto
   *  recommendation, the current (maker) model, and the full accessible list. */
  checkerModelInfo(): { selected: string; recommended: string; recommendedWhy: string; current: string; options: ModelOption[] } {
    const models = this.accessibleModels();
    const current = this.activeModel();
    const rec = recommendCheckerModel(models, current);
    return { selected: checkerModel(), recommended: rec?.value ?? current, recommendedWhy: rec?.why ?? "", current, options: models };
  }
  /** P-GOAL.6: persist the checker-model choice ("" = auto/recommended). Returns the refreshed state. */
  setCheckerModelChoice(value: string): ReturnType<Backend["checkerModelInfo"]> {
    setCheckerModel(value);
    return this.checkerModelInfo();
  }

  /** P-GOAL.1: the loop's "done" checker, run in a SEPARATE complete() session (maker ≠ checker). With a
   *  verification command it runs it and reports exit-0 (a real proof); otherwise it judges the goal
   *  against the maker's reported work, conservatively. Fail-closed: an empty/failed reply ⇒ not done.
   *  P-GOAL.6: runs on the resolved CHECKER model (the user's choice, else a cheap/capable recommendation,
   *  else the maker's model) — a distinct, cheaper judge that costs less to run every iteration. */
  private async checkGoal(a: { goal: string; condition: string; command: string; lastWork: string; criteria?: string }): Promise<{ done: boolean; reason: string }> {
    const model = resolveCheckerModel({ chosen: checkerModel(), models: this.accessibleModels(), current: this.activeModel() }).value;
    // P-GOAL.12 (ADR-0057): give the small checker the matured SUCCESS CRITERIA from the Pre-Flight design,
    // and have it report back against EACH — appropriate context for a deterministic grade, not a bare check.
    const criteriaBlock = a.criteria ? `\n\nGrade against these success criteria (report which are met / unmet):\n${a.criteria.slice(0, 1500)}` : "";
    if (a.command) {
      const out = await this.complete(
        `You are a verification CHECKER, separate from the agent that did the work. Run the given command EXACTLY in the workspace and report only the outcome. Do NOT modify any files or try to fix anything. ${a.criteria ? "Also note any success criterion that the command does not cover. " : ""}Output ONLY strict JSON on one line: {"done": <true only if the command finished with exit code 0${a.criteria ? " AND every success criterion holds" : ""}>, "reason": "<short summary: what happened + which criteria are met/unmet>"}.`,
        `Run this verification command and report whether it passed:\n\n\`\`\`\n${a.command}\n\`\`\`${criteriaBlock}`,
        { idleMs: 180_000, model },
      );
      return parseGoalVerdict(out);
    }
    const out = await this.complete(
      `You are a strict CHECKER, separate from the agent that did the work. Decide whether the goal is fully met against the success criteria. Be conservative: if you are not sure, answer done=false. Output ONLY strict JSON on one line: {"done": bool, "reason": "<one line: which criteria are met/unmet>"}.`,
      `Goal: ${a.goal}\nStop condition: ${a.condition}${criteriaBlock}\n\nThe agent reported:\n${(a.lastWork || "(no output)").slice(0, 4000)}\n\nIs the goal fully met?`,
      { idleMs: 120_000, model },
    );
    return parseGoalVerdict(out);
  }

  /** P-ACP.4: interrupt the in-flight turn. Sends the ACP `session/cancel` notification — omp aborts
   *  the streaming reply AND in-flight tool calls and returns the pending `session/prompt` with a
   *  cancelled stopReason, so the turn's `done` fires normally and the UI settles. No-op when idle. */
  cancel(): void {
    try { if (this.acp && this.sessionId) this.acp.notify("session/cancel", { sessionId: this.sessionId }); } catch { /* best-effort */ }
  }

  // Serializes utility completions so they never clobber a concurrent chat turn's listener.
  private utilLock: Promise<void> = Promise.resolve();
  // P-KG-INGEST.3 (ADR-0081): lets background extraction (complete()) yield to a live chat turn on the
  // SHARED connection (the fallback path below). Superseded by the dedicated util connection when available.
  private chatGate = new ChatGate();

  // P-KG-INGEST.4 (ADR-0085): a SECOND, dedicated omp connection for utility completions (import / AI-learn
  // extraction + the /goal checker). It runs TRULY concurrently with chat — separate process, separate
  // event sink — so a long AI ingest never touches the chat connection. Fail-safe: if this second omp can't
  // spawn, complete() falls back to the shared connection (with the ChatGate so chat still preempts).
  private utilAcp: ACPClient | null = null;
  private utilStarting: Promise<ACPClient | null> | null = null;
  private utilSink: ((text: string) => void) | null = null; // active util completion's text collector

  /** Lazily spawn the dedicated util omp. Returns null on spawn failure (→ shared-connection fallback). */
  private async startUtil(): Promise<ACPClient | null> {
    if (this.utilAcp) return this.utilAcp;
    if (!this.utilStarting) {
      this.utilStarting = (async () => {
        try {
          this.applyAttributionEnv(); // same env threading as the chat spawn
          const isoCfg = existsSync(ACP_CONFIG) ? ["--config", ACP_CONFIG] : [];
          const acp = new ACPClient(ompBin(), ["acp", "-e", GATE, "-e", ASKSAGE, ...(existsSync(PREVIEW_EXT) ? ["-e", PREVIEW_EXT] : []), ...isoCfg], currentWorkspace());
          // A util completion is TEXT-ONLY: collect assistant text into the active sink, ignore everything
          // else (no tool calls, no permissions, no gate-block surfacing — that's the chat connection's job).
          acp.onNotify = (method: string, params: any) => {
            if (method !== "session/update") return;
            const u = params?.update ?? params;
            if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") this.utilSink?.(u.content.text);
          };
          acp.onRequest = async () => ({}); // no interactive permissions during extraction
          acp.onStderr = () => { /* no tools here → nothing to surface */ };
          acp.start();
          await acp.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
          this.utilAcp = acp;
          return acp;
        } catch { this.utilAcp = null; return null; }
      })();
    }
    const acp = await this.utilStarting;
    this.utilStarting = null; // allow a retry on a later call if this spawn failed
    return acp;
  }

  /** One-shot, non-streaming completion in a THROWAWAY session — never touches the chat
   *  session, persona, or recall. Returns the aggregated assistant text ("" on any failure).
   *  Serialized via utilLock so it can't race a chat turn. Used by the import model-extractor:
   *  the model only ever sees text that already passed the scanner gate, and tool-call events
   *  (if any) are ignored — only assistant text is collected. */
  async complete(system: string, user: string, opts: { idleMs?: number; model?: string } = {}): Promise<string> {
    const run = this.utilLock.then(async () => {
      await this.start();
      // P-KG-INGEST.4: prefer the DEDICATED util connection (true concurrency — never touches chat). If it
      // couldn't spawn, fall back to the shared connection with the ChatGate (chat preempts, ≤1 extraction).
      const util = await this.startUtil();
      return completionPath(!!util) === "dedicated" ? this.completeOn(util!, system, user, opts) : this.completeShared(system, user, opts);
    });
    this.utilLock = run.then(() => {}, () => {}); // next complete() waits for this one
    return run;
  }

  /** Run a completion on the DEDICATED util connection (P-KG-INGEST.4): independent process + sink, so it
   *  never swaps the chat listener and never needs to yield to chat. Serialized via utilLock, so utilSink
   *  is never contended. */
  private async completeOn(acp: ACPClient, system: string, user: string, opts: { idleMs?: number; model?: string }): Promise<string> {
    let sid: string | null = null;
    let text = "";
    let idle: ReturnType<typeof setTimeout> | undefined;
    let onStall: (e: Error) => void = () => {};
    try {
      const s: any = await acp.request("session/new", { cwd: currentWorkspace(), mcpServers: mcpServersForAcp() });
      sid = s?.sessionId ?? s?.id ?? null;
      if (!sid) return "";
      if (opts.model) await acp.request("session/set_config_option", { sessionId: sid, configId: "model", value: opts.model }).catch(() => {});
      const IDLE = opts.idleMs ?? 60_000;
      const arm = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => onStall(new Error("stall")), IDLE); };
      this.utilSink = (t) => { arm(); text += t; };
      arm();
      const stall = new Promise<never>((_, reject) => { onStall = reject; });
      await Promise.race([
        acp.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: `${system}\n\n${user}` }] }),
        stall,
      ]);
      return text;
    } catch { return text; }
    finally {
      if (idle) clearTimeout(idle);
      this.utilSink = null;
      this.turnDiag(`complete.util chars=${text.length}`);
      if (sid) acp.request("session/close", { sessionId: sid }).catch(() => {});
    }
  }

  /** Fallback path: run on the SHARED chat connection, swapping the listener + yielding to a live chat turn
   *  via the ChatGate (P-KG-INGEST.3). Used only when the dedicated util omp couldn't spawn. */
  private async completeShared(system: string, user: string, opts: { idleMs?: number; model?: string }): Promise<string> {
    const prev = this.listener;
    let sid: string | null = null;
    let text = "";
    let idle: ReturnType<typeof setTimeout> | undefined;
    let onStall: (e: Error) => void = () => {};
    let myListener: ((e: ChatEvent) => void) | null = null;
    try {
      await this.chatGate.whenIdle(); // chat preempts extraction on the shared connection
      const s: any = await this.acp!.request("session/new", { cwd: currentWorkspace(), mcpServers: mcpServersForAcp() });
      sid = s?.sessionId ?? s?.id ?? null;
      if (!sid) return "";
      if (opts.model) await this.acp!.request("session/set_config_option", { sessionId: sid, configId: "model", value: opts.model }).catch(() => {});
      const IDLE = opts.idleMs ?? 60_000;
      const arm = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => onStall(new Error("stall")), IDLE); };
      myListener = (e: ChatEvent) => { arm(); if (e.type === "token") text += e.text; };
      this.listener = myListener;
      arm();
      const stall = new Promise<never>((_, reject) => { onStall = reject; });
      await Promise.race([
        this.acp!.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: `${system}\n\n${user}` }] }),
        stall,
      ]);
      return text;
    } catch { return text; }
    finally {
      if (idle) clearTimeout(idle);
      // Only restore if WE are still the active listener (a chat turn may have taken over a long overlap).
      const clobber = myListener !== null && this.listener !== myListener;
      this.turnDiag(`complete.shared clobberAvoided=${clobber} chars=${text.length}`);
      if (!clobber) this.listener = prev;
      if (sid) this.acp!.request("session/close", { sessionId: sid }).catch(() => {});
    }
  }
}

export const backend = new Backend();
