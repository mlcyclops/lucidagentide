// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/bridge.ts
//
// The single seam between the UI and the outside world. Dashboards, chat, and
// session config all go over the dev server's HTTP API - which is backed by a
// REAL `omp acp` session (desktop/acp_backend.ts), so prompts produce genuine
// model replies in both the browser build and Electron. The only thing that is
// native-only is window controls + crisp text zoom, exposed by the Electron
// preload as `window.lucid`; in a plain browser those fall back to CSS zoom.

import type { AgentSpec } from "../../harness/agent/spec.ts"; // P-AGENT.2b: Agent Builder spec type
import type { SpecFileSummary } from "../../harness/agent/file_store.ts"; // P-AGENT.2b: spec list summary
import type { UserCommand } from "../../harness/commands/spec.ts"; // P-CMD.1: user-authored slash commands
import type { AgentRunTrace, TraceSummary } from "../../harness/agent/trace.ts"; // P-AGENT.13: run traces
import { isSystemStatus, type SystemStatusView } from "./system_guard.ts"; // P-SYSRES.1: resource guard view (types owned there - layering rule)

/** P-AGENT.12: an MCP-discovered catalog entry (name is the omp runtime name: mcp__<server>_<tool>). */
export interface McpCatalogTool {
  name: string;
  desc: string;
  server: string;
}

/** P-AGENT.17: one revision snapshot of a saved agent (written on every save, pruned to the newest 20). */
export interface SpecRevisionSummary {
  updated_at: number;
  name: string;
  nodes: number;
  edges: number;
}

/** P-AGENT.17: one curated starter template (an in-repo .lucid-agent.json, digest-checked before listing). */
export interface AgentTemplateInfo {
  file: string;
  name: string;
  description: string;
  steps: number;
  tools: string[];
}
import type { LocalProviderDef } from "../local_providers.ts"; // P-LOCAL.3: self-hosted/custom LLM providers
import type { RestoredTurn } from "../session_steps.ts"; // P-RESUME.1 (ADR-0171): restored agent activity
export type { RestoredTurn };
import type { SkillRoot } from "../skills_gov.ts"; // P-SKILL.4 (ADR-0097): skill source roots
import type { TrustLabel } from "../../harness/contracts.ts"; // invariant #7: closed-set trust labels

export interface BlockRecord { id: string; tool: string; severity: string; findings: string; reason: string; at: string; status: "quarantined" | "approved" | "dismissed"; reviewer?: string }

/** P-AGENT.4-live/.11a: a built-agent run reply. `paused` = halted at an approval checkpoint (ENFORCED by
 *  the SegmentedRun machine server-side); resume with agentRunApprove. */
export interface AgentRunReply {
  output: string;
  error: string;
  blocked: boolean;
  reason: string;
  paused?: { runId: string; nodeId: string; label: string; outputSoFar: string } | null;
  runId?: string; // P-AGENT.13: the run's stable trace id
}
export interface SecuritySnapshot {
  findings: any[]; unicode: any[]; approvals: any[]; quarantine: any[];
  promotion: any[]; exports: any[]; runs: any[];
  // P-SECACK.1 (ADR-0170): GUI-owned review-acks - which DB-backed rows a human already reviewed
  // (releases NOTHING; view-state only) + the findings-seen watermark.
  acks?: { artifacts: Record<string, { at: string; reviewer?: string }>; findingsSeen?: number | null };
  // GUI-owned LIVE gate blocks (ADR-0019 C) - present even when the DuckDB views are empty.
  live?: { quarantined: BlockRecord[]; approved: BlockRecord[]; dismissed: BlockRecord[]; total: number };
  // P-SANDBOX.5 (ADR-0169): the live runtime-sandbox posture + refused subprocess reach-outs. Mirrors
  // desktop/sandbox_status.ts (SandboxStatus) - the client-side shape, kept in sync by hand like the rest
  // of this snapshot. Absent until the first omp spawn resolves a state.
  sandbox?: SandboxStatusView;
}
export interface SandboxStateView {
  backend: "bwrap" | "seatbelt" | "appcontainer" | "noop" | null;
  isolated: boolean; disclosed: boolean; platform: string;
  execBlocked: string | null; proxied: boolean; at: string;
}
export interface SandboxBlockView { host: string; channel: string; type: string; reason: string; at: string }
export interface SandboxStatusView { state: SandboxStateView | null; egressBlocks: SandboxBlockView[] }
export interface MemorySnapshot {
  session: null | {
    path: string; model: string; turns: number; window: number;
    current: number; peak: number; prompts: number[];
    cache: { read: number; write: number; fresh: number; hit: number }; cost: number; started: string;
  };
  compaction: Record<string, string> | null;
  budgets: { label: string; used: number; status: string; resetsAt: number | null }[] | null;
  harness: null | {
    counts: { working: number; archive: number; entities: number; facts: number };
    layers: { layer: string; rows: string; detail: string }[];
    facts: { entity: string; statement: string; trust_label: string }[];
    gate: { promoted: number; blocked: number };
  };
  aiLoc: AiLocSummary | null; // P-LOC.2 (ADR-0031): AI-authored lines per model/repo/identity
}

// P-LOC.2 (ADR-0031): AI-LOC attribution roll-up surfaced in the Memory tab.
export interface AiLocModel { model: string; added: number; removed: number; edits: number }
export interface AiLocRow { model: string; repo: string; identity: string; identitySource: string; edits: number; added: number; removed: number }
export interface AiLocSummary {
  totals: { added: number; removed: number; edits: number; models: number; repos: number };
  byModel: AiLocModel[];
  rows: AiLocRow[];
  identities: string[];
  generatedAt: string;
}

// P10.3: a live rate-limit reading probed from an API-key provider's response headers.
export interface ProbedLimit { provider: string; label: string; used: number; remaining: number; limit: number; resetsAt: number | null }

// P-MCP.1 (ADR-0020): a configured MCP server's masked status (token never crosses the wire).
export interface McpServerStatus { id: string; name: string; transport: "http" | "sse"; url: string; enabled: boolean; hasToken: boolean; tokenLast4?: string }
// P-AGENTFW.2 (ADR-0149): a configured remote ACP agent connection (command/args, never a secret).
export interface RemoteAgentStatus { id: string; name: string; kind: string; command: string; args: string[]; remoteUrl?: string; permissionPolicy: "deny" | "allow"; enabled: boolean }

// ADR-0009 Phase D: read-only developer Logs view (gated on Developer mode).
export interface TurnView { id: string; sessionId: string; seq: number; role: string; sanitized: string; rawSha256: string; trust: string; at: string }
export interface DevView {
  enabled: boolean;
  snapshot: { telemetry: any[]; runs: any[]; exports: any[] } | null;
  blocks: { quarantined: BlockRecord[]; approved: BlockRecord[]; total: number };
  // ADR-0009 Phase B (issue #12): captured prompt/response transcripts (sanitized; raw by sha).
  turns: TurnView[];
  // P-ASKSAGE.1 (ADR-0059): recent AskSage tool-loop call diagnostics (developer mode only).
  asksage?: Array<Record<string, unknown>>;
  // P-GATE-DIAG.1 (ADR-0066/0062): recent exec/egress gate-decision diagnostics (developer mode only) —
  // shows WHY a tool was auto-denied vs prompted (askActive / listener / goalActive / autoRunning).
  gate?: Array<Record<string, unknown>>;
  // P-ENT.2 (ADR-0069): the unified security-event stream (OCSF-ready) + per-sink delivery status.
  audit?: {
    events: { id: string; ts: string; category: string; type: string; severity: string; decision: string; tool?: string; reason?: string; tier?: string; host: string }[];
    sinks: { name: string; type: string; delivered: number; failed: number; lastError?: string }[];
  };
  // P-NETDIAG.1: live loopback / OAuth-callback watcher (developer mode only). Mirrors NetDiagView in
  // desktop/netdiag.ts - the renderer keeps its own copy of the shape (same pattern as DevView itself).
  netdiag?: NetDiagView | null;
}
export interface NetSocketView { proto: string; local: string; foreign: string; state: string; pid: string; proc: string; port: number; loopback: boolean; }
export interface NetEventView { at: number; kind: "listener" | "open" | "close" | "probe"; text: string; port?: number; proc?: string; candidate?: boolean; }
export interface NetDiagView {
  watching: boolean; platform: string; supported: boolean;
  ports: number[]; probes: { port: number; state: "open" | "closed" | "timeout" }[];
  listeners: NetSocketView[]; connections: NetSocketView[];
  dns: string[]; events: NetEventView[]; startedAt: number | null;
}
// P10.2 cross-model usage & cost ledger
export interface ModelUsage {
  model: string; provider: string; source: "subscription" | "local";
  sessions: number; turns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  savings: number; cacheHitRate: number;
}
export interface UsageLedger {
  models: ModelUsage[];
  totals: { sessions: number; turns: number; tokens: number; cost: number; savings: number; cacheHitRate: number };
  bySource: { subscription: { cost: number; tokens: number }; local: { cost: number; tokens: number } };
  files: number; truncated: boolean; generatedAt: string;
}
// ADR-0030 P-CODE.1: git workspace diffstat this month (repo activity, not AI authorship).
export interface CodeActivity {
  workspaces: { name: string; path: string; added: number; deleted: number; files: number; spend: number }[];
  totals: { added: number; deleted: number; files: number };
  month: string; daysInMonth: number;
}
export interface ConfigOption {
  id: string; name: string; category: string; type: string;
  currentValue: string; options: { value: string; name: string }[];
}
// P-VOICE.1 (ADR-0115): voice config + ElevenLabs voice for the pickers.
export interface VoiceSettingsView {
  sttProvider: "elevenlabs" | "whisper";
  sttUrl: string;
  ttsProvider: "elevenlabs" | "openai-tts" | "local-tts";
  ttsVoice: string;
  ttsVoiceFavorites: string[];
}
export interface ElevenVoiceView { voiceId: string; name: string; category?: string; description?: string; labels?: Record<string, string> }
// P-REPORT.1 (ADR-0116): a unified Reports-list row - a loop AAR or a saved Engineering Update brief.
export interface ReportEntry { kind: "aar" | "brief"; id: string; title: string; outcome: string; role: string; updatedAt: number; rel: string }
// P-REPORT.9 (ADR-0162): a candidate repo for cross-repo aggregation, and the per-repo selection sent back.
export interface ReportRepo { path: string; name: string; isGit: boolean; remoteUrl: string; host: string; isGitHub: boolean; lastActive: number }
export interface ReportRepoSelection { path: string; fetch?: boolean; prs?: boolean }
// P-CHAT.C (ADR-0190): a settled chat turn's OBSERVED telemetry, POSTed to /api/eval/report to build a
// Model-Evaluation brief (server maps it to evals.ts's RunRecord). All fields are what the renderer saw.
export interface EvalReportTurn {
  runId: string; model: string;
  ctxTokens: number; outputTokens: number; totalTokens: number; costUsd: number;
  tools: { name: string; path?: string; add?: number; del?: number }[];
  failures?: { tool: string; reason: string; cmd?: string }[];
  subagents?: number; when?: string;
}
export interface EvalReportResult { kind: string; id: string; rel: string | null; title: string }
export interface ModeOption { id: string; name: string; description?: string }
export interface ModeState { available: ModeOption[]; current: string; ui?: "agent" | "ask" | "plan"; permissionMode?: "auto" | "ask" }
export interface OmpCommand { name: string; description?: string; hint?: string }
export interface SessionInfo { id: string; title: string; model: string; updatedAt: number; turns: number; kind?: "chat" | "kg-ingest" }
// P-KG-INGEST.1b (ADR-0076): chats, with throwaway extraction sessions split into a collapsible group.
export interface SessionList { sessions: SessionInfo[]; ingest: SessionInfo[] }
// P-SKILL.1 (ADR-0045): per-file result of a gated skill import (mirrors desktop/skills_import.ts).
export interface SkillImportResult { ok: boolean; name: string; written?: boolean; path?: string; blocked?: boolean; reason?: string; trustLabel?: string; findings?: number }

// P-SKILL.4 (ADR-0097): the directory row for a DISCOVERED skill + the per-action results (mirror
// desktop/skills_data.ts; the renderer composes the bundled corpus into the same SkillView shape).
export interface SkillScanView { trust: TrustLabel; findings: number; at: string }
export interface SkillView { name: string; description: string; source: string; root: SkillRoot; trust: TrustLabel; invocation: string; removable: boolean; scanned?: SkillScanView | null }
export interface SkillResourceView { dir: string; files: string[] }
export interface SkillInspectView { ok: boolean; name: string; root?: SkillRoot; trust?: TrustLabel; body?: string; resources?: SkillResourceView[]; provenance?: string; reason?: string }
export interface SkillRescanView { ok: boolean; name: string; found: boolean; trust?: TrustLabel; findings?: number; blocked?: boolean; reason?: string }
export interface SkillRemoveView { ok: boolean; name: string; removed?: boolean; root?: SkillRoot; reason?: string }

// P-SKILL.5 (ADR-0101): Skill Studio — a model-drafted skill candidate + the analyze result.
export interface SkillCandidateView { name: string; description: string; body: string; rationale?: string }
export interface SkillStudioAnalyzeView { window: "today" | "week"; model: string; candidates: SkillCandidateView[] }

// P-KB.2b (ADR-0099/0100): the compiled knowledge base + the page-graph view.
export interface KbBlockedView { stage: "source" | "page"; slug?: string; reason: string; trustLabel: string; findings: number }
export interface KbIngestResultView { documentId: string; status: "compiled" | "quarantined"; pagesCompiled: number; pagesQuarantined: number; links: number; pageIds: string[]; blocked: KbBlockedView[] }
export interface KbRetrievedItemView { store: "vector" | "compiled"; citation: string; title: string; text: string; score: number; trustLabel: string }
export interface KbRetrieveResultView { mode: "vector" | "compiled" | "hybrid"; items: KbRetrievedItemView[]; wrapped: string }
export interface KbPageView { page_id: string; kind: string; slug: string; title: string; body_md: string; trust_label: string }
export interface KbLinkView { link_id: string; from_page_id: string; to_page_id: string; relation: string }
export interface KbGraphView { pages: KbPageView[]; links: KbLinkView[] }
export interface ProviderAuth {
  id: string; name: string; env: string; oauthId: string; canOauth: boolean;
  oauthActive: boolean; oauthIdentity?: string; keySet: boolean; keyLast4?: string;
}
export interface AuthStatus { gateway: ProviderAuth[]; majors: ProviderAuth[]; others: ProviderAuth[] }
export interface HeadroomStatus {
  installed: boolean; version: string | null; running: boolean; enabled: boolean;
  port: number; url: string; installHint: string;
}
// P-TRIV.3 (ADR-0176): the executive Trivia Wire's intel news line (mirrors desktop/intel_news.ts).
// Titles are scan-gated server-side and rendered as escaped TEXT only - never markdown, never prompts.
// The item type lives in trivia_news.ts so non-DOM scripts can use it without importing this file.
import type { IntelNewsItemView } from "./trivia_news.ts";
export type { IntelNewsItemView };
export interface IntelNewsView { items: IntelNewsItemView[]; fetchedAt: number; stale: boolean }
// P-TRIV.4 (ADR-0191): opt-in re-seed context sources + the generated-pack result the Recycle action gets back.
import type { TriviaQuestion } from "./trivia.ts";
export interface TriviaSeedSources { sessions: boolean; kg: boolean; codegraph: boolean }
export interface TriviaSeedView { ok: boolean; questions: TriviaQuestion[]; count: number; usedSources: string[]; model: string; blocked?: boolean; reason?: string }
export type PersonalScopeView = "work" | "personal" | "cui" | "combined";
export interface PersonalStatus {
  enabled: boolean; aiExtract: boolean; configured: boolean; unlocked: boolean;
  scope: PersonalScopeView; counts: { work: number; personal: number; cui: number } | null;
  // P9.5a hard CUI isolation: the CUI store is a separate file with its own passphrase.
  cuiConfigured: boolean; cuiUnlocked: boolean; legacyCuiInMain: number;
}
export interface ExportSummary {
  ok: boolean; error?: string; dest?: string;
  entities?: number; facts?: number; files?: number; bytes?: number;
  scopes?: string[]; includedCui?: boolean; payloadSha256?: string; manifestSha256?: string;
}
export interface ExportEvent {
  id: string; kind: "vault" | "cui-archive"; scopes: string[];
  entity_count: number; fact_count: number; file_count: number;
  payload_sha256: string; manifest_sha256?: string; dest?: string; included_cui: boolean; at: string;
}
export interface GraphNode { id: string; name: string; kind: string; trust: string; count: number }
export interface GraphEdge { from: string; to: string; relation: string }
export interface GraphFact { id: string; entity_id: string; statement: string; scope: string; trust: string; confidence: number; session?: string; at: string }
export interface PersonalGraphData { nodes: GraphNode[]; edges: GraphEdge[]; facts: GraphFact[] }
/** P-KG-CODE.1: the workspace code graph (file → import edges) + ingest status. Nodes/edges reuse the graph shapes. */
export interface CodeGraphView { level: "file" | "symbol"; ingested: boolean; root: string; fileCount: number; symbolCount: number; edgeCount: number; updatedAt: number; nodes: GraphNode[]; edges: GraphEdge[] }
export interface PersonalImportResult { ok: boolean; error?: string; vendor?: "openai" | "anthropic" | "gemini"; conversations?: number; messages?: number; learned?: number; blocked?: number; skipped?: number; extractor?: "heuristic" | "model"; cancelled?: boolean }
// P-KG-INGEST.1 (ADR-0076): the background import job - start returns a jobId; status is polled for a live countdown.
export interface PersonalImportStart { ok: boolean; jobId?: string; error?: string }
export interface PersonalImportJob {
  jobId: string; state: "running" | "done" | "failed" | "cancelled"; vendor?: string;
  messages: number; totalMessages: number; conversations: number; totalConversations: number;
  learned: number; blocked: number; startedAt: number; updatedAt: number;
  result?: PersonalImportResult; error?: string;
}
export interface PersonalImportEstimate { ok: boolean; error?: string; vendor?: "openai" | "anthropic" | "gemini"; conversations?: number; userMessages?: number; userChars?: number }
// P-IDE.5 (ADR-0036): gated read/write for the in-app editor.
export interface EditorReadResult { ok: boolean; error?: string; path?: string; content?: string; mtime?: number; sha256?: string }
export interface EditorSaveResult { ok: boolean; error?: string; blocked?: boolean; conflict?: boolean; reason?: string; path?: string; mtime?: number; sha256?: string; currentSha?: string }
export interface FsList {
  path: string; parent: string | null; home: string; isGit: boolean;
  dirs: { name: string; path: string; isGit: boolean }[];
}
export interface WorkspaceInfo {
  current: string; name: string; isGit: boolean;
  recent: { path: string; name: string; isGit: boolean }[];
  cloned?: boolean; error?: string;
}

// The LUCID session event union now lives in a DOM-free module (chat_events.ts) so node-side code that only
// needs the shape doesn't drag bridge.ts (a DOM file) into the non-DOM root typecheck. Re-exported here so
// every existing `import { type ChatEvent } from "./bridge.ts"` keeps working unchanged.
import type { ChatEvent } from "./chat_events.ts";
export type { ChatEvent };
/** P-GOAL.13 (ADR-0067): the per-command-type Speed↔Risk dial - each type's max auto-run tier (T0-T3). */
export type GoalDial = Partial<Record<"shell" | "edit" | "delete" | "web-fetch" | "web-search" | "subagent", "T0" | "T1" | "T2" | "T3">>;
export interface GoalOpts { goal: string; condition: string; command?: string; maxIters: number; resume?: string; budgetUsd?: number; criteria?: string; dial?: GoalDial }
// P-GOAL.4: a stopped loop that can be resumed from its on-disk memory file.
export interface ResumableLoop { rel: string; goal: string; condition: string; command?: string; iterations: number; updatedAt: number }
// P-GOAL.10 (ADR-0055): the cross-run evaluation surface (mirrors desktop/loop_runlog.ts).
export interface LoopRunRecord {
  ts: number; id: string; goal: string; outcome: "met" | "stopped" | "cancelled" | "error"; outcomeReason: string;
  iterations: number; maxIters: number; durationMs: number; tools: number; toolsByType: Record<string, number>;
  added: number; removed: number; hasLoc: boolean; errors: number; websites: number;
  spendUsd: number; hasSpend: boolean; command?: string;
}
export interface RunStats {
  runs: number; succeeded: number; successRate: number; avgItersToSucceed: number; avgDurationMs: number;
  totalTools: number; toolsByType: Record<string, number>; totalAdded: number; totalRemoved: number;
  totalErrors: number; totalSpendUsd: number; topBlockers: { reason: string; count: number }[];
}
export interface LoopRunStats { stats: RunStats; summary: string; recent: LoopRunRecord[] }
// P-GOAL.12 (ADR-0057): the Pre-Flight Audit (mirrors desktop/loop_preflight.ts).
export interface PreflightSpec {
  goal: string; command?: string; scope?: string; budgetUsd?: number; maxIters?: number; checkerIsCheap?: boolean;
  doneDefinition?: string; nonGoals?: string; risks?: string; feedback?: string;
}
export interface ReadinessCheck { key: string; label: string; ok: boolean; weight: number; nudge?: string }
export interface ReadinessReport { level: "L0" | "L1" | "L2" | "L3"; score: number; checks: ReadinessCheck[]; summary: string }
export interface PreflightResult { maturedGoal: string; criteria: string; reportMd: string; reportPath: string; readiness: ReadinessReport; prior: { total: number; relevant: number } }
export interface LoopScopes { current: string; branches: string[]; worktrees: string[] }
// P-GOAL.5: a scheduled automation - a saved /goal spec the in-process scheduler runs on a cadence.
export type Cadence = { kind: "interval"; everyMin: number } | { kind: "daily"; hhmm: string };
export interface Automation {
  id: string; goal: string; condition: string; command?: string; maxIters: number;
  cadence: Cadence; enabled: boolean; createdAt: number; lastRunAt?: number; lastResult?: string;
  kind?: "goal" | "agent"; agentSpecId?: string; agentPrompt?: string; agentModel?: string; // P-AGENT.14
}
export interface AutomationSpec {
  goal: string; condition?: string; command?: string; maxIters?: number; cadence: Cadence;
  kind?: "goal" | "agent"; agentSpecId?: string; agentPrompt?: string; agentModel?: string; // P-AGENT.14
}
// P-GOAL.6: the /goal checker-model picker state.
export interface ModelOption { value: string; name?: string; description?: string }
export interface CheckerModelInfo { selected: string; recommended: string; recommendedWhy: string; current: string; options: ModelOption[] }

export interface Attribution {
  identity: string; source: "email" | "workstation"; email: string; workstation: string; decided: boolean;
  // Enterprise-managed policy view (ADR-0030): drives the prompt + "Managed by …" UI.
  managed: boolean; orgName: string; requireEmail: boolean; allowSkip: boolean; allowedDomains: string[];
}
// ADR-0088 (P-ROLE.1): the four onboarding roles (renderer-side mirror of settings_store's UserRole).
export type UserRole = "developer" | "security" | "manager" | "executive";
export interface ProfileSettings {
  username: string;
  email: string;
  // Effective code-activity attribution identity (ADR-0030): email if set, else workstation hostname.
  attribution?: Attribution;
  // ADR-0088/0089: cosmetic onboarding state. `role` shapes default surfacing; `tourSeen` guards the
  // first-run walkthrough replay. Both default safely (role→"developer", tourSeen→false) when absent.
  role?: UserRole;
  tourSeen?: boolean;
}
export interface ManagedPolicy {
  managed: boolean; orgName: string;
  attribution: { requireEmail?: boolean; allowSkip?: boolean; allowedEmailDomains?: string[] } | null;
  asksageOnly: boolean;
  /** ADR-0068 (P-ENT.1): which controls the managed policy locks (UI disables them + "Managed by <org>"). */
  locks?: { exec: boolean; egress: boolean; loop: boolean; models: boolean };
}
// P-COLLAB.3 (ADR-0192): the live-share surface. `CollabParticipantView` mirrors the host's roster entry;
// `CollabShareStatus` is what the Share panel polls; `CollabRelay` is the authorized relay (null = none).
export interface CollabParticipantView { peerId: number; name: string; role: "host" | "guest"; access: "view" | "edit" }
export interface CollabRelay { wsBase: string; httpBase: string; label: string; source: "self-hosted" | "public" | "embedded" }
/** P-COLLAB.7: the embedded-relay ("be the relay") status the toggle polls. `managed.locked` disables the
 *  control (+ "Managed by <org>"); `managed.allowServe:false` means the org forbids hosting a relay. */
/** P-COLLAB.14: a bindable address the "be the relay" toggle can offer (loopback / LAN / VPN). */
export interface CollabBindAddress { address: string; family: "IPv4" | "IPv6"; kind: "loopback" | "lan" | "vpn" | "other"; label: string }
export interface CollabRelayServeStatus {
  running: boolean;
  hostname?: string;
  port?: number;
  wsBase?: string;
  rooms?: number;
  /** This machine's bindable addresses (loopback first). Each is still bind-authorized fail-closed on serve. */
  addresses?: CollabBindAddress[];
  managed: { locked: boolean; allowServe: boolean; org: string | null };
}
/** P-COLLAB.10: the shared session's identity, as a joining guest receives it. */
export interface CollabSessionHeaderView { sessionId: string; title: string; model: string; hostName: string; startedAt: number }
/** P-COLLAB.10: the frames the guest stream (`/api/collab/join`) pushes to the Join panel. */
export type CollabGuestFrame =
  | { kind: "welcome"; header: CollabSessionHeaderView; transcript: { role: string; text: string }[]; participants: CollabParticipantView[]; readOnly: boolean }
  | { kind: "event"; event: ChatEvent }
  | { kind: "state"; participants: CollabParticipantView[]; model: string; contextPct: number | null }
  | { kind: "error"; message: string }
  | { kind: "end"; reason: string };

export interface CollabShareStatus {
  active: boolean;
  roomId?: string;
  fullLink?: string;
  viewLink?: string;
  browserLink?: string;
  relayLabel?: string;
  relaySource?: string;
  startedAt?: number;
  /** P-COLLAB.13: true when the share allows a full-link guest to drive the host. */
  allowEdit?: boolean;
  participantCount: number;
  participants: CollabParticipantView[];
  relay?: CollabRelay | null;
}

export interface LucidBridge {
  isElectron: boolean;
  security(): Promise<SecuritySnapshot | null>;
  /** Release one quarantined call - the audited fail-closed override (ADR-0019 C). */
  securityApprove(id: string): Promise<BlockRecord | null>;
  securityDismiss(id: string): Promise<BlockRecord | null>;
  /** P-SECACK.1 (ADR-0170): mark DB-backed security rows reviewed (GUI ack ledger; releases nothing). */
  securityAck(input: { ids?: string[]; findings?: boolean }): Promise<{ acked: number; findingsSeen: number | null } | null>;
  /** P-BRIEF.3 (ADR-0072) / P-REPORT.1 (ADR-0116): the Engineering Update from the repo's own logs,
   *  optionally tailored to a role and persisted (save) so the Reports panel lists it.
   *  P-REPORT.9 (ADR-0162): pass `repos` to also aggregate recent commits + PRs across the selected repos
   *  (fetched read-only) into a Cross-repo activity annex; that path POSTs. `window` = commits per branch. */
  engineeringBrief(role?: string, save?: boolean, repos?: ReportRepoSelection[], window?: number): Promise<{ brief: string; scriptText: string; counts: Record<string, number>; role: string; savedRel: string | null } | null>;
  /** P-REPORT.9: the candidate repos for a report (workspace ∪ recents ∪ report-only tracked) + gh-auth state. */
  reportRepos(): Promise<{ repos: ReportRepo[]; ghAuth: boolean } | null>;
  /** P-REPORT.9: add a report-target repo by local path or clone URL (does NOT change the active workspace). */
  addReportRepo(input: { path?: string; url?: string }): Promise<{ repos: ReportRepo[]; ghAuth: boolean; error?: string } | null>;
  /** P-REPORT.1: the unified Reports list (loop AARs + saved briefs) and reading one. `archived` = the archive view. */
  reports(archived?: boolean): Promise<ReportEntry[] | null>;
  report(kind: string, rel: string, archived?: boolean): Promise<{ kind: string; rel: string; markdown: string } | null>;
  /** P-REPORT.2 (ADR-0117): two-stage lifecycle - archive (soft), restore, and permanent delete (archive only). */
  reportArchive(kind: string, rel: string): Promise<{ archived: boolean } | null>;
  reportRestore(kind: string, rel: string): Promise<{ restored: boolean } | null>;
  reportDelete(kind: string, rel: string): Promise<{ deleted: boolean } | null>;
  /** P-REPORT.3 (ADR-0117): push a report into the KG as one trusted node, in the chosen compartment. */
  reportToKg(kind: string, rel: string, scope: string, archived?: boolean): Promise<{ ok: boolean; error?: string } | null>;
  /** P-CHAT.C (ADR-0190): build + save a Model-Evaluation brief from a settled turn's observed telemetry. */
  evalReport(turn: EvalReportTurn): Promise<EvalReportResult | null>;
  /** P-EVAL.3 Part B (ADR-0187): build + save the cross-run Model-Evaluation rollup from persisted metrics + latency. */
  evalRollup(): Promise<EvalReportResult | null>;
  /** P-EXEC.3: "TLDR" - plain-language explanation of a command via a cheap keyed model. */
  explainCommand(command: string): Promise<{ ok: boolean; text?: string; model?: string; error?: string } | null>;
  /** P-REPORT.6: the Security control crosswalk as an eMASS-aligned POA&M CSV. */
  engineeringBriefPoam(): Promise<{ csv: string; rows: number; filename: string } | null>;
  /** P-REPORT.8: the Security control crosswalk as a STIG Viewer .ckl checklist. */
  engineeringBriefCkl(): Promise<{ ckl: string; rows: number; filename: string } | null>;
  /** P-KG-CODE.1 / P-KG-SYM.1: the workspace code graph at `level` (file imports | symbol AST). `codeGraph` reads
   *  the stored graph; `codeGraphIngest` (re-)builds it. */
  codeGraph(level: "file" | "symbol"): Promise<CodeGraphView | null>;
  codeGraphIngest(level: "file" | "symbol"): Promise<CodeGraphView | null>;
  /** P-KG-SYM.1: read / set whether the agent gets the read-only codegraph_query tool (set restarts the backend). */
  codeGraphAgent(): Promise<{ enabled: boolean } | null>;
  /** P-AGENT.2b: Agent Builder spec persistence (workspace .omp/agents/). Save validates fail-closed server-side. */
  agentList(): Promise<SpecFileSummary[]>;
  agentLoad(id: string): Promise<AgentSpec | null>;
  agentSave(spec: AgentSpec): Promise<{ saved?: boolean; spec_id?: string; errors?: string[] } | null>;
  agentDelete(id: string): Promise<{ deleted: boolean } | null>;
  agentExport(spec: AgentSpec, target: string): Promise<{ dir: string; target: string; digest: string; files: number } | null>;
  /** P-AGENT.9: portable share/import (.lucid-agent.json, credential NAMES only) + the human approval step. */
  agentShare(spec: AgentSpec): Promise<{ path?: string; fileName?: string; json?: string; setup?: string; digest?: string; error?: string } | null>;
  agentImport(raw: string): Promise<{ spec?: AgentSpec; trustLabel?: string; canRun?: boolean; reason?: string; findings?: number; setup?: string; notes?: string[]; error?: string } | null>;
  agentTrust(id: string): Promise<{ trustLabel?: string; error?: string } | null>;
  /** P-AGENT.10: n8n interop — export a workflow scaffold; push via the enterprise add-on connector. */
  agentN8nExport(spec: AgentSpec): Promise<{ path?: string; fileName?: string; json?: string; pushAvailable?: boolean; pushNote?: string; error?: string } | null>;
  agentN8nPush(spec: AgentSpec): Promise<{ ok?: boolean; detail?: string; url?: string; error?: string } | null>;
  agentRun(spec: AgentSpec, prompt: string, model: string): Promise<AgentRunReply | null>;
  /** P-AGENT.11a: resolve a run parked at an approval checkpoint (deny is terminal). */
  agentRunApprove(runId: string, approve: boolean): Promise<AgentRunReply | null>;
  /** P-AGENT.13: run traces — summaries per spec, and one full trace by run id. */
  agentTraces(specId: string): Promise<TraceSummary[]>;
  agentTrace(runId: string): Promise<AgentRunTrace | null>;
  /** P-AGENT.12: tools discovered from enabled MCP servers (omp runtime names) + per-server probe status. */
  agentMcpTools(): Promise<{ tools: McpCatalogTool[]; servers: { server: string; ok: boolean; count: number; error: string }[] }>;
  /** P-AGENT.17: revision history (snapshots per save) + restore; the starter-template gallery. */
  agentHistory(id: string): Promise<SpecRevisionSummary[]>;
  agentHistoryRestore(id: string, ts: number): Promise<{ spec?: AgentSpec; error?: string } | null>;
  agentTemplates(): Promise<AgentTemplateInfo[]>;
  agentTemplateUse(file: string): Promise<{ spec?: AgentSpec; trustLabel?: string; reason?: string; setup?: string; notes?: string[]; error?: string } | null>;
  /** P-LOCAL.3 (ADR-0135): Local Providers (self-hosted/custom OpenAI-compatible LLMs). Declarations only —
   *  the API key is stored via credStore into the OS-encrypted vault, never through these. */
  localProvidersList(): Promise<LocalProviderDef[]>;
  localProviderUpsert(provider: LocalProviderDef): Promise<{ saved?: boolean; id?: string; errors?: string[] } | null>;
  localProviderDelete(id: string): Promise<{ deleted: boolean } | null>;
  localProviderEnable(id: string, enabled: boolean): Promise<{ ok: boolean } | null>;
  /** Reachability/TLS probe of a base URL's /models endpoint (no key sent). */
  localProviderTest(baseUrl: string): Promise<{ reachable: boolean; status?: number; authed?: boolean; error?: string } | null>;
  /** Restart the desktop app so a spawned omp picks up new local providers (Electron only; no-op in browser). */
  relaunch(): Promise<void>;
  /** P-FIGMA.1 (ADR-0154): import a Figma file's frames as a design board → returns the local HTML path to
   *  preview. The PAT (if passed) is used server-side + should already be stored in the vault by the caller. */
  figmaImport(fileUrl: string, pat?: string): Promise<{ path?: string; fileName?: string; frames?: number; hasDesign?: boolean; error?: string } | null>;
  /** P-FIGMA.2 (ADR-0154): read the workspace DESIGN.md (content) so it can be popped out in the IDE. */
  designDoc(): Promise<{ exists: boolean; path?: string; name?: string; content?: string } | null>;
  setCodeGraphAgent(enabled: boolean): Promise<{ enabled: boolean } | null>;
  /** P-APPEAR.1: the personalized chat background (image data URL + display mode + opacity). */
  chatBackground(): Promise<{ image: string; mode: "off" | "ambient" | "flashlight"; opacity: number } | null>;
  setChatBackground(patch: { image?: string; mode?: "off" | "ambient" | "flashlight"; opacity?: number }): Promise<{ image: string; mode: "off" | "ambient" | "flashlight"; opacity: number } | null>;
  /** P-TRIV.4 (ADR-0191): AI re-seed the Trivia Wire - generate a per-role pack on the selected model from the opt-in sources. */
  triviaReseed(opts: { model: string; role: string; sources: TriviaSeedSources }): Promise<TriviaSeedView | null>;
  /** P-BRIEF.4 (ADR-0113): synthesize the podcast to WAV audio (base64) via a TTS provider. */
  engineeringBriefAudio(provider: "openai-tts" | "local-tts" | "elevenlabs", voiceId?: string): Promise<{ note: string; audioB64: string | null; mime: string } | null>;
  // P-VOICE.1 (ADR-0115): voice config (STT engine + TTS voice/favorites), the ElevenLabs voice list,
  // mic transcription, and read-aloud TTS.
  voiceSettings(): Promise<VoiceSettingsView | null>;
  setVoiceSettings(patch: Partial<VoiceSettingsView>): Promise<VoiceSettingsView | null>;
  voices(): Promise<{ voices: ElevenVoiceView[]; favorites: string[]; selected: string; note?: string } | null>;
  transcribe(audioB64: string, mime: string, language?: string): Promise<{ text: string; note: string } | null>;
  speak(text: string, voiceId?: string, provider?: string): Promise<{ audioB64: string | null; mime: string; note: string } | null>;
  /** P-GOAL.14 (ADR-0112): list past After-Action Reports, and read one by its workspace-relative path. */
  pastReports(): Promise<{ rel: string; id: string; goal: string; outcome: string; updatedAt: number }[] | null>;
  pastReport(rel: string): Promise<{ rel: string; markdown: string } | null>;
  memory(): Promise<MemorySnapshot | null>;
  budget(): Promise<{ label: string; used: number; status: string; resetsAt: number | null }[] | null>;
  // P10.3: live API-key rate-limit probe (opt-in). `rateLimits()` returns probed limits ([] when off);
  // `setRateLimitProbe` flips the opt-in.
  rateLimits(force?: boolean): Promise<{ enabled: boolean; limits: ProbedLimit[] } | null>;
  setRateLimitProbe(enabled: boolean): Promise<unknown>;
  // ADR-0009 Phase D: developer Logs view + its opt-in toggle.
  dev(): Promise<DevView | null>;
  setDeveloperMode(enabled: boolean): Promise<unknown>;
  // P-MCP.1 (ADR-0020): MCP server registry (masked - never the raw token).
  mcpList(): Promise<McpServerStatus[] | null>;
  mcpUpsert(e: { id?: string; name: string; transport?: "http" | "sse"; url: string; token?: string; enabled?: boolean }): Promise<McpServerStatus | null>;
  mcpRemove(id: string): Promise<unknown>;
  mcpToggle(id: string, enabled: boolean): Promise<unknown>;
  // P-AGENTFW.2 (ADR-0149): remote ACP agent (hermes/openclaw) connections proxied through the firewall.
  remoteAgentList(): Promise<RemoteAgentStatus[] | null>;
  remoteAgentUpsert(e: { id?: string; name: string; kind?: string; command: string; args?: string; cwd?: string; remoteUrl?: string; permissionPolicy?: string; enabled?: boolean }): Promise<RemoteAgentStatus | null>;
  remoteAgentRemove(id: string): Promise<unknown>;
  remoteAgentToggle(id: string, enabled: boolean): Promise<unknown>;
  usage(): Promise<UsageLedger | null>;
  codeActivity(): Promise<CodeActivity | null>;
  // P-COLLAB.3 (ADR-0192): live session sharing (view-only host). `status` is the poll; `start` mints the
  // room + view/full links + stands up the host (fails closed if no relay); `stop` ends it; `setRelay`
  // configures the authorized relay (self-hosted default, public opt-in).
  collabStatus(): Promise<CollabShareStatus | null>;
  /** `allowEdit` shares an EDIT link so a full-link guest can drive the host (P-COLLAB.13). */
  collabStart(opts?: { allowEdit?: boolean }): Promise<{ ok: boolean; status?: CollabShareStatus; error?: string }>;
  collabStop(): Promise<CollabShareStatus | null>;
  collabSetRelay(patch: { url?: string; publicOptIn?: boolean }): Promise<{ relay: CollabRelay | null } | null>;
  // P-COLLAB.13: guest-write. The HOST polls collabGuestInbox and runs a pending guest prompt through its own
  // composer; the connected GUEST drives the host via collabGuestSendPrompt / collabGuestAbort.
  collabGuestInbox(): Promise<{ prompt: { text: string; from: string } | null; abort: boolean } | null>;
  collabGuestSendPrompt(text: string): Promise<{ ok: boolean; error?: string }>;
  collabGuestAbort(): Promise<unknown>;
  // P-COLLAB.7: host the embedded relay on this device ("be the relay"), governance-gated + fail-closed.
  collabRelayServeStatus(): Promise<CollabRelayServeStatus | null>;
  collabRelayServe(patch: { enabled: boolean; host?: string; port?: number }): Promise<{ ok: boolean; status?: CollabRelayServeStatus; error?: string }>;
  // P-COLLAB.10: JOIN a shared session read-only. `collabJoin` streams guest frames until the share ends or
  // `collabLeave` is called; a synchronous parse/policy failure surfaces as an `{kind:"error"}` frame.
  collabJoin(link: string, onFrame: (f: CollabGuestFrame) => void): Promise<void>;
  collabLeave(): Promise<unknown>;
  sendPrompt(text: string, onEvent: (e: ChatEvent) => void, images?: { data: string; mimeType: string }[]): Promise<void>;
  // P-GOAL.1 (ADR-0046): run a /goal loop - streams the same events plus goal-iter/check/done/stop.
  runGoal(opts: GoalOpts, onEvent: (e: ChatEvent) => void): Promise<void>;
  resumableLoops(): Promise<ResumableLoop[] | null>; // P-GOAL.4: loops that stopped without meeting their condition
  loopRunStats(): Promise<LoopRunStats | null>; // P-GOAL.10 (ADR-0055): cross-run evaluation stats + recent runs
  loopScopes(): Promise<LoopScopes | null>;     // P-GOAL.12 (ADR-0057): branches/worktrees for the Pre-Flight scope picker
  preflightAudit(spec: PreflightSpec): Promise<PreflightResult | null>; // P-GOAL.12: readiness + matured goal + design report
  // P-GOAL.5 (ADR-0047): scheduled automations - CRUD + arm/disarm + run-now (run-now streams goal events).
  automations(): Promise<Automation[] | null>;
  automationCreate(spec: AutomationSpec): Promise<Automation | null>;
  automationEnable(id: string, enabled: boolean): Promise<Automation | null>;
  automationDelete(id: string): Promise<unknown>;
  automationRun(id: string, onEvent: (e: ChatEvent) => void): Promise<void>;
  // P-GOAL.6 (ADR-0048): the loop's checker-model picker (auto recommendation + override).
  checkerModel(): Promise<CheckerModelInfo | null>;
  setCheckerModel(value: string): Promise<CheckerModelInfo | null>;
  config(): Promise<ConfigOption[]>;
  /** Respawn omp + re-read its model list (after connecting a provider via OAuth or key). */
  refreshConfig(): Promise<ConfigOption[]>;
  setConfig(configId: string, value: string): Promise<ConfigOption[]>;
  // P-ACP.2 (ADR-0027): ACP session modes (Plan / Agent), switched via session/set_mode.
  modes(): Promise<ModeState | null>;
  setMode(modeId: string): Promise<ModeState | null>;
  // P-ACP.3: the composer's 3-way Plan/Ask/Agent + answering a forwarded permission request.
  setUiMode(uiMode: "agent" | "ask" | "plan"): Promise<ModeState | null>;
  respondPermission(id: string, optionId: string | null): Promise<unknown>;
  // P-ACP.4: Stop the in-flight turn (interrupt reply + tool calls).
  cancelChat(): Promise<unknown>;
  cancelGoal(): Promise<unknown>; // P-GOAL.2: stop a running /goal loop
  commands(): Promise<OmpCommand[]>;
  skills(): Promise<SkillView[] | null>;
  // P-SKILL.4 (ADR-0097): the directory's per-skill management menu (all confined, all additive).
  skillInspect(name: string): Promise<SkillInspectView | null>;
  skillRescan(name: string): Promise<SkillRescanView | null>;
  skillRemove(name: string): Promise<SkillRemoveView | null>;
  // P-SKILL.5 (ADR-0101): analyze recent work → candidate skills; draft = codify one through the gate.
  skillStudioAnalyze(window: "today" | "week"): Promise<SkillStudioAnalyzeView | null>;
  skillStudioDraft(candidate: SkillCandidateView): Promise<SkillImportResult | null>;
  // P-KB.2b (ADR-0099/0100): compiled-KB ingest / retrieve / page-graph.
  kbIngest(doc: { sourcePath: string; title: string; text: string }): Promise<KbIngestResultView | null>;
  kbRetrieve(query: string, mode: "vector" | "compiled" | "hybrid"): Promise<KbRetrieveResultView | null>;
  kbGraph(): Promise<KbGraphView | null>;
  // P-CMD.1 (ADR-0146): user-authored "/" slash commands (workspace .omp/commands/). Create validates +
  // scans fail-closed server-side. `list` = stored commands; `create` returns the persisted command or errors.
  userCommands(): Promise<UserCommand[]>;
  userCommandCreate(command: UserCommand): Promise<{ ok: boolean; command?: UserCommand; errors?: string[]; blocked?: boolean; reason?: string } | null>;
  userCommandDelete(name: string): Promise<{ deleted: boolean } | null>;
  // P-SKILL.1 (ADR-0045): import dropped .md skill files - each is scanned at the gate; clean ones are
  // written under .omp/skills/, flagged ones are held for Security-panel review.
  skillImport(files: { name: string; content: string }[]): Promise<{ results: SkillImportResult[] } | null>;
  // P-IDE.2: set/clear the active bundled skill (its trusted prompt rides the user-turn preamble).
  setActiveSkill(name: string, prompt: string): Promise<{ active: string } | null>;
  clearActiveSkill(): Promise<{ active: string } | null>;
  // P-IDE.3: record a skill activation as telemetry (metadata only).
  skillActivated(command: string, name: string, source: "bundled" | "project" | "task"): Promise<unknown>;
  sessions(): Promise<SessionList | null>;
  // P-PERF.4: tail-first transcript page - `limit` returns only the last N messages (+ the true total).
  // P-RESUME.1 (ADR-0171): user messages carry their `turn` ordinal; `steps` is the restored agent
  // activity (thinking/tool/failure groups) recorded in the lucid-steps sidecar, keyed by that ordinal.
  sessionMessages(id: string, limit?: number): Promise<{ messages: { role: string; text: string; turn?: number }[]; total: number; userTotal?: number; steps?: RestoredTurn[] } | null>;
  resumeSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<{ ok: boolean; error?: string }>;
  clearIngestSessions(): Promise<{ ok: boolean; cleared: number } | null>; // P-KG-INGEST.2: bulk-delete ingest throwaways
  newSession(): Promise<void>;
  setZoom(factor: number): void;
  // settings + provider auth
  getSettings(): Promise<ProfileSettings | null>;
  saveUsername(username: string): Promise<ProfileSettings | null>;
  // Corporate email = attribution identity (ADR-0030). Save email (and/or username) together.
  saveProfile(p: { username?: string; email?: string }): Promise<ProfileSettings | null>;
  // User skips the email prompt → attribute by workstation hostname instead (recorded, traceable).
  skipEmail(): Promise<ProfileSettings | null>;
  // ADR-0088/0089 (P-ROLE.1/.1b): persist the onboarding role + the first-run-tour replay guard.
  saveRole(role: UserRole): Promise<ProfileSettings | null>;
  setTourSeen(seen: boolean): Promise<ProfileSettings | null>;
  // Enterprise-managed policy (read-only; placed by admins via GPO/MDM).
  managed(): Promise<ManagedPolicy | null>;
  // P-IDE.1c: China-origin model data-sovereignty acknowledgement gate.
  chinaAck(): Promise<{ acknowledged: boolean } | null>;
  setChinaAck(acknowledge: boolean): Promise<{ acknowledged: boolean } | null>;
  // Third-party / non-U.S. / custom "More providers" acknowledgement gate (mirrors chinaAck).
  thirdPartyAck(): Promise<{ acknowledged: boolean } | null>;
  setThirdPartyAck(acknowledge: boolean): Promise<{ acknowledged: boolean } | null>;
  auth(): Promise<AuthStatus | null>;
  saveKey(env: string, key: string): Promise<AuthStatus | null>;
  oauthLogin(oauthId: string): Promise<{ started: boolean; url: string; output: string } | null>;
  oauthLogout(oauthId: string): Promise<AuthStatus | null>;
  /** Device-authorization flow: forward a code the user copied from the provider's page to the broker's stdin. */
  oauthCode(oauthId: string, code: string): Promise<{ sent: boolean; reason?: string } | null>;
  // AskSage gov gateway (ADR-0007)
  asksage(): Promise<{ configured: boolean; base: string; only: boolean; limit: number; datasets: string[]; queryModel: string; persona: string } | null>;
  saveAsksage(opts: { baseUrl?: string; only?: boolean; limit?: number; datasets?: string[]; queryModel?: string; persona?: string }): Promise<{ configured: boolean; base: string; only: boolean; limit: number; datasets: string[]; queryModel: string; persona: string } | null>;
  asksageTokens(): Promise<{ used: number; remaining: number | null; limit: number } | null>;
  asksageDatasets(): Promise<string[] | null>;
  asksagePersonas(): Promise<{ id: string; description: string }[] | null>;
  applyPersona(id: string | null): Promise<{ applied?: boolean; cleared?: boolean; scan?: { ok: boolean; reason?: string; findings: number } } | null>;
  // headroom token-compression proxy (opt-in, on-device)
  headroom(): Promise<HeadroomStatus | null>;
  setHeadroom(enabled: boolean): Promise<HeadroomStatus | null>;
  // P-TRIV.3 (ADR-0176): executive Trivia Wire intel news
  intelNews(): Promise<IntelNewsView | null>;
  // personalization knowledge graph (opt-in, encrypted - ADR-0010/0012)
  personal(): Promise<PersonalStatus | null>;
  personalEnable(enabled: boolean): Promise<PersonalStatus | null>;
  personalAiExtract(enabled: boolean): Promise<PersonalStatus | null>;
  personalSetup(passphrase: string): Promise<{ ok: boolean; error?: string } | null>;
  personalUnlock(passphrase: string): Promise<{ ok: boolean; error?: string } | null>;
  personalLock(): Promise<PersonalStatus | null>;
  personalScope(scope: PersonalScopeView): Promise<PersonalStatus | null>;
  // P9.5a: the isolated CUI store's own setup / unlock / lock
  personalCuiSetup(passphrase: string): Promise<{ ok: boolean; error?: string } | null>;
  personalCuiUnlock(passphrase: string): Promise<{ ok: boolean; error?: string } | null>;
  personalCuiLock(): Promise<PersonalStatus | null>;
  // P9.5b: audited migration of legacy cui out of the main store + records destruction
  personalCuiMigrate(): Promise<{ ok: boolean; error?: string; moved?: number; entities?: number } | null>;
  personalCuiDestroy(): Promise<{ ok: boolean; error?: string; destroyed?: boolean; facts?: number } | null>;
  personalGraph(scope?: PersonalScopeView): Promise<PersonalGraphData | null>;
  personalForget(factId: string): Promise<{ ok: boolean } | null>;
  // P-KG-REL.1 (ADR-0075): user-authored relationship between two existing, visible nodes.
  personalRelate(from: string, to: string, relation?: string): Promise<{ ok: boolean; error?: string; id?: string } | null>;
  personalUnrelate(from: string, to: string, relation?: string): Promise<{ ok: boolean; error?: string; removed?: number } | null>; // P-KG-REL.3
  // P9.7: import a ChatGPT / Claude / Gemini data export (folder, .json, or .zip) into the active
  // compartment, through the fail-closed gate. `model` runs the richer LLM extractor (capped).
  // P-KG-INGEST.1: starts a BACKGROUND import job (returns a jobId); poll status + cancel below.
  personalImport(path: string, model?: boolean): Promise<PersonalImportStart | null>;
  personalImportStatus(jobId?: string): Promise<PersonalImportJob | null>;
  personalImportCancel(jobId?: string): Promise<{ ok: boolean } | null>;
  // P-IMP.2: read-only pre-import estimate (counts) for the AI-mode token/time warning.
  personalImportEstimate(path: string): Promise<PersonalImportEstimate | null>;
  // P-IDE.5: in-app editor - read a workspace file, and save the buffer THROUGH the scanner gate.
  editorRead(path: string): Promise<EditorReadResult | null>;
  editorSave(opts: { path: string; content: string; baseSha?: string; overwrite?: boolean }): Promise<EditorSaveResult | null>;
  // P9.4: audited Obsidian vault export + NARA-aligned CUI archive
  personalExportVault(opts: { scopes?: string[]; dest?: string; reviewer?: string }): Promise<ExportSummary | null>;
  personalCuiArchive(opts: { dest?: string; reviewer?: string }): Promise<ExportSummary | null>;
  personalExports(): Promise<ExportEvent[] | null>;
  // workspace (folder the agent works in; local or cloned remote)
  workspace(): Promise<WorkspaceInfo | null>;
  setWorkspace(path: string): Promise<WorkspaceInfo | null>;
  cloneWorkspace(url: string): Promise<WorkspaceInfo | null>;
  pickFolder(): Promise<string | null>; // native dialog in Electron; null in browser
  // P-NETWL.1 (ADR-0106): native FILE picker + OS-encrypted credential vault. All Electron-only; in a plain
  // browser pickFile/credList resolve null/[] and credStore reports the vault as unavailable (fail-closed).
  pickFile(opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  credStore(input: { ref?: string; kind: string; secret: string; label?: string; expiresAt?: number; rotationIntervalDays?: number }): Promise<CredMetaView | { error: string }>;
  credStoreFile(input: { kind: string; label?: string; expiresAt?: number; rotationIntervalDays?: number }): Promise<CredMetaView | { error: string } | null>;
  // P-KEYS.2 (ADR-0107): rotate a stored secret in place (same ref) by paste or file.
  credRotate(input: { ref: string; secret: string; expiresAt?: number }): Promise<CredMetaView | { error: string }>;
  credRotateFile(input: { ref: string }): Promise<CredMetaView | { error: string } | null>;
  credList(): Promise<CredMetaView[]>;
  credDelete(ref: string): Promise<boolean>;
  credEncryptionAvailable(): Promise<boolean>;
  // P-NETWL.2 (ADR-0106): curated network-whitelist CRUD (persisted server-side; non-secret).
  whitelistList(): Promise<WhitelistEntryView[]>;
  whitelistUpsert(entry: Partial<WhitelistEntryView>): Promise<WhitelistEntryView | null>;
  whitelistRemove(id: string): Promise<void>;
  // P-NETWL.5 (ADR-0108): the egress posture (allow-all + web-search toggles; managedLocked when enterprise-forced).
  whitelistPosture(): Promise<EgressPostureView>;
  setWhitelistPosture(patch: { allowAll?: boolean; allowWebSearch?: boolean }): Promise<EgressPostureView | null>;
  // P-PREVIEW.1 (ADR-0096): capture the preview region (window capturePage, cropped) → PNG data URL.
  // Electron-only; resolves null in a plain browser (no capturePage).
  capturePreview(rect: { x: number; y: number; width: number; height: number }): Promise<string | null>;
  // P-PREVIEW.3b (ADR-0096): may this remote URL load in the preview iframe? True only if the egress
  // allow-list (honoring the managed ceiling) already approves the site; else it stays gated.
  previewEgressAllows(url: string): Promise<boolean>;
  // P-PREVIEW.4 (ADR-0096): a local file's content for the iframe's srcdoc (file:// can't load from an http
  // origin). Returns the HTML, or null if the path isn't a readable local previewable file.
  previewFile(path: string): Promise<string | null>;
  // P-PREVIEW.4b (ADR-0096): the same-origin URL that SERVES a local file as a document with its own
  // per-frame CSP, for the iframe's `src`. Carries the transport token as a query param (an iframe src GET
  // can't set a header). Used instead of srcdoc so the previewed app's inline scripts actually run.
  previewServeUrl(path: string): string;
  // P-PREVIEW.3a-shot (ADR-0096): cache a PNG of the just-rendered preview desktop-side so the agent's
  // preview_screenshot tool can fetch it (capturePage is Electron-only + in the main process, unreachable
  // from omp). No-op if the store rejects it. The agent SEEING the shot needs the packaged/Electron app.
  cachePreviewShot(png: string): Promise<void>;
  // P-PREVIEW.6b (ADR-0153): the DOM-inspect relay. The renderer polls for the agent's next queued inspect
  // command, runs it on the sandboxed iframe (via the postMessage bridge), and posts the result back.
  previewInspectNext(): Promise<{ id?: string; command?: { selector?: string; what?: string }; none?: boolean } | null>;
  previewInspectResult(id: string, result: unknown): Promise<void>;
  // P-PREVIEW.7 (ADR-0179): Electron-app detection + USER-initiated external launch
  previewElectronDetect(path: string): Promise<{ electron: boolean; reasons: string[]; appDir: string; launchable: boolean; via: string | null } | null>;
  previewElectronLaunch(path: string): Promise<{ launched: boolean; via?: string; appDir?: string; reason?: string } | null>;
  // P-TASK.5 (ADR-0180): live subagent activity behind the current session's delegation
  subagents(): Promise<{ runs: { name: string; done: boolean; lastAt: number; assignment: string; model: string | null; tools: number; steps: { kind: string; tool?: string; label: string }[] }[] } | null>;
  // P-SYSRES.1 (ADR-0182): system resource profile + guard verdict (types live in system_guard.ts)
  systemStatus(fresh?: boolean): Promise<SystemStatusView | null>;
  listDir(path?: string): Promise<FsList | null>; // in-app folder browser (works everywhere)
  revealPath(path: string): Promise<boolean>; // open a folder in the OS file manager (Electron only; false in browser)
  canRevealPath(): boolean; // whether the native shell can reveal a folder (Electron only)
}

/** Non-secret metadata about a vault credential (P-NETWL.1, ADR-0106). No plaintext ever crosses this line;
 *  `last4` (P-KEYS.1, ADR-0107) is at most the last 4 chars, to identify a key without revealing it. */
export interface CredMetaView { ref: string; kind: string; label?: string; last4?: string; createdAt?: number; rotatedAt?: number; expiresAt?: number; rotationIntervalDays?: number }

/** The egress posture (P-NETWL.5, ADR-0108): the two pre-checked toggles + whether an enterprise policy locks them. */
export interface EgressPostureView { allowAll: boolean; allowWebSearch: boolean; managedLocked: boolean }

/** A curated network-whitelist entry (P-NETWL.2, ADR-0106). Non-secret: `auth` holds only an opaque
 *  `vaultRef` into the credential vault, never the secret itself. Mirrors network_whitelist.ts WhitelistEntry. */
export interface WhitelistEntryView {
  id: string;
  kind: "domain" | "ip";
  pattern: string;
  zone: "internal" | "external";
  scope: "always" | "project" | "loop";
  project?: string | null;
  callBudget?: number | null;
  auth?: { kind: string; vaultRef: string; username?: string; header?: string; note?: string } | null;
  addedAt?: number;
}

/** Native shell injected by the Electron preload (window controls + crisp zoom). */
interface NativeShell {
  isElectron?: boolean;
  setZoom?(factor: number): void;
  pickFolder?(): Promise<string | null>;
  capturePreview?(rect: { x: number; y: number; width: number; height: number }): Promise<string | null>;
  revealPath?(path: string): Promise<boolean>;
  relaunch?(): Promise<void>; // P-LOCAL.3 polish: restart the app to apply local-provider changes
  win?: { minimize(): void; toggleMaximize(): void; close(): void };
  // P-NETWL.1 (ADR-0106): native file picker + OS-encrypted credential vault (Electron-only).
  pickFile?(opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  credStore?(input: { ref?: string; kind: string; secret: string; label?: string; expiresAt?: number; rotationIntervalDays?: number }): Promise<CredMetaView | { error: string }>;
  credStoreFile?(input: { kind: string; label?: string; expiresAt?: number; rotationIntervalDays?: number }): Promise<CredMetaView | { error: string } | null>;
  credRotate?(input: { ref: string; secret: string; expiresAt?: number }): Promise<CredMetaView | { error: string }>;
  credRotateFile?(input: { ref: string }): Promise<CredMetaView | { error: string } | null>;
  credList?(): Promise<CredMetaView[]>;
  credDelete?(ref: string): Promise<boolean>;
  credEncryptionAvailable?(): Promise<boolean>;
}
declare global { interface Window { lucid?: NativeShell } }
const shell: NativeShell | undefined = typeof window !== "undefined" ? window.lucid : undefined;

// ADR-0024: the per-launch capability token, injected into the served HTML by dev.ts. We echo it
// on every /api call so the server can tell the real renderer from a forged request. Read once at
// load; absent in a stray non-injected page (then calls are simply rejected, fail-closed).
const TOKEN = typeof document !== "undefined"
  ? (document.querySelector('meta[name="lucid-token"]') as HTMLMetaElement | null)?.content ?? ""
  : "";
const authHeaders = (extra?: Record<string, string>): Record<string, string> =>
  ({ ...(TOKEN ? { "x-lucid-token": TOKEN } : {}), ...extra });

async function getData(path: string): Promise<any> {
  try { return (await (await fetch(path, { cache: "no-store", headers: authHeaders() })).json())?.data ?? null; } catch { return null; }
}
async function post(path: string, body: unknown): Promise<any> {
  try { return (await (await fetch(path, { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(body) })).json())?.data ?? null; } catch { return null; }
}

// Mock config only as a last resort if the backend can't be reached (no omp).
const FALLBACK_CONFIG: ConfigOption[] = [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "anthropic/claude-opus-4-8", options: [
    { value: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8" }, { value: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" }, { value: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
  { id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: "high", options: [
    { value: "off", name: "Off" }, { value: "auto", name: "Auto" }, { value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "xhigh", name: "X-High" },
  ] },
];

// Generic NDJSON event stream (used by both /api/chat and the /api/goal loop). `signal` lets Stop abort
// the CLIENT read so the turn settles even if the server/omp never closes the stream (a wedged turn).
async function streamNdjson(path: string, body: unknown, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(body), signal });
  } catch {
    if (signal?.aborted) return; // Stop pressed - the caller's finally settles the UI; no error line
    onEvent({ type: "token", text: "[backend unreachable - is the GUI server running?]" });
    onEvent({ type: "done" });
    return;
  }
  if (res.status === 404) { onEvent({ type: "token", text: "[backend is out of date - close the GUI server window and relaunch (launcher → G)]" }); onEvent({ type: "done" }); return; }
  if (!res.ok || !res.body) { onEvent({ type: "token", text: `[backend error ${res.status}]` }); onEvent({ type: "done" }); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  // Drop server heartbeats ({type:"ping"}) - they only keep the socket alive through long tool calls.
  const flush = (line: string) => { const s = line.trim(); if (!s) return; try { const ev = JSON.parse(s); if (ev && ev.type === "ping") return; onEvent(ev); } catch { /* skip */ } };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) { flush(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    flush(buf);
  } catch { /* Stop aborted the read, or the stream errored - return so the caller's finally settles. */ }
}
// Stop must always recover the UI: aborting this controller ends the client read immediately, so the
// turn's finally runs even when omp is wedged. cancelChat() aborts it AND posts the server cancel.
let chatAbort: AbortController | null = null;
const streamChat = (text: string, onEvent: (e: ChatEvent) => void, images?: { data: string; mimeType: string }[]) => {
  chatAbort?.abort();
  chatAbort = new AbortController();
  return streamNdjson("/api/chat", { text, ...(images?.length ? { images } : {}) }, onEvent, chatAbort.signal).finally(() => { chatAbort = null; });
};

// P-COLLAB.10: JOIN a shared session. /api/collab/join returns EITHER a JSON error envelope (malformed link /
// policy refusal) OR an NDJSON stream of guest frames — so we peek the content-type and surface an error as a
// frame. `collabLeave`/close aborts the client read so the Join panel settles even if the host is wedged.
let collabJoinAbort: AbortController | null = null;
const streamCollabJoin = async (link: string, onFrame: (f: CollabGuestFrame) => void): Promise<void> => {
  collabJoinAbort?.abort();
  collabJoinAbort = new AbortController();
  let res: Response;
  try {
    res = await fetch("/api/collab/join", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ link }), signal: collabJoinAbort.signal });
  } catch (e) {
    if (!collabJoinAbort?.signal.aborted) onFrame({ kind: "error", message: String((e as Error)?.message ?? "backend unreachable") });
    return;
  }
  const ctype = res.headers.get("content-type") ?? "";
  if (!res.ok || !res.body || ctype.includes("application/json")) {
    let msg = `couldn't join (backend ${res.status})`;
    try { const j = await res.json(); if (j?.error) msg = String(j.error); } catch { /* keep default */ }
    onFrame({ kind: "error", message: msg });
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const flush = (line: string) => { const s = line.trim(); if (!s) return; try { const f = JSON.parse(s); if (f && f.type === "ping") return; if (f && f.kind) onFrame(f as CollabGuestFrame); } catch { /* skip */ } };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) { flush(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    flush(buf);
  } catch { /* leave aborted the read - the panel's own state settles */ }
  finally { collabJoinAbort = null; }
};

export const bridge: LucidBridge = {
  isElectron: !!shell?.isElectron,
  security: () => getData("/api/security"),
  securityApprove: (id) => post("/api/security/approve", { id }),
  securityDismiss: (id) => post("/api/security/dismiss", { id }),
  securityAck: (input) => post("/api/security/ack", input),
  engineeringBrief: (role, save, repos, window) => (repos && repos.length
    ? post("/api/brief", { role, save, repos, window }) // P-REPORT.9: multi-repo path POSTs the selection
    : getData(`/api/brief${role || save ? "?" : ""}${role ? `role=${encodeURIComponent(role)}` : ""}${save ? `${role ? "&" : ""}save=1` : ""}`)),
  reportRepos: () => getData("/api/report/repos"),
  addReportRepo: (input) => post("/api/report/repos/add", input),
  reports: (archived) => getData(`/api/reports${archived ? "?archived=1" : ""}`),
  report: (kind, rel, archived) => getData(`/api/report?kind=${encodeURIComponent(kind)}&rel=${encodeURIComponent(rel)}${archived ? "&archived=1" : ""}`),
  evalReport: (turn) => post("/api/eval/report", turn), // P-CHAT.C (ADR-0190)
  evalRollup: () => post("/api/eval/rollup", {}), // P-EVAL.3 Part B (ADR-0187)
  triviaReseed: (opts) => post("/api/trivia/reseed", opts), // P-TRIV.4 (ADR-0191)
  reportArchive: (kind, rel) => post("/api/report/archive", { kind, rel }),
  reportRestore: (kind, rel) => post("/api/report/restore", { kind, rel }),
  reportDelete: (kind, rel) => post("/api/report/delete", { kind, rel }),
  reportToKg: (kind, rel, scope, archived) => post("/api/report/to-kg", { kind, rel, scope, archived }),
  explainCommand: (command) => post("/api/explain", { command }),
  engineeringBriefPoam: () => getData("/api/brief/poam"),
  engineeringBriefCkl: () => getData("/api/brief/ckl"),
  codeGraph: (level) => getData(`/api/codegraph?level=${level}`),
  codeGraphIngest: (level) => post("/api/codegraph", { level }),
  codeGraphAgent: () => getData("/api/codegraph/agent"),
  agentList: async () => (await getData("/api/agent"))?.specs ?? [], // P-AGENT.2b
  agentLoad: async (id) => (await getData(`/api/agent?id=${encodeURIComponent(id)}`))?.spec ?? null, // P-AGENT.2b
  agentSave: (spec) => post("/api/agent", { spec }), // P-AGENT.2b (server validates fail-closed)
  agentDelete: (id) => post("/api/agent/delete", { id }), // P-AGENT.2b
  agentExport: (spec, target) => post("/api/agent/export", { spec, target }), // P-AGENT.6
  agentShare: (spec) => post("/api/agent/share", { spec }), // P-AGENT.9
  agentImport: (raw) => post("/api/agent/import", { raw }), // P-AGENT.9
  agentTrust: (id) => post("/api/agent/trust", { id }), // P-AGENT.9
  agentN8nExport: (spec) => post("/api/agent/n8n-export", { spec }), // P-AGENT.10
  agentN8nPush: (spec) => post("/api/agent/n8n-push", { spec }), // P-AGENT.10
  agentRun: (spec, prompt, model) => post("/api/agent/run", { spec, prompt, model }), // P-AGENT.4-live/.11a
  agentRunApprove: (runId, approve) => post("/api/agent/run/approve", { runId, approve }), // P-AGENT.11a
  agentTraces: async (specId) => (await getData(`/api/agent/traces?spec=${encodeURIComponent(specId)}`))?.traces ?? [], // P-AGENT.13
  agentTrace: async (runId) => (await getData(`/api/agent/trace?id=${encodeURIComponent(runId)}`))?.trace ?? null, // P-AGENT.13
  agentMcpTools: async () => (await getData("/api/agent/tools")) ?? { tools: [], servers: [] }, // P-AGENT.12 (fail-soft: static catalog only)
  agentHistory: async (id) => (await getData(`/api/agent/history?id=${encodeURIComponent(id)}`))?.revisions ?? [], // P-AGENT.17
  agentHistoryRestore: (id, ts) => post("/api/agent/history/restore", { id, ts }), // P-AGENT.17
  agentTemplates: async () => (await getData("/api/agent/templates"))?.templates ?? [], // P-AGENT.17
  agentTemplateUse: (file) => post("/api/agent/template-use", { file }), // P-AGENT.17 (standard gated import path)
  localProvidersList: async () => (await getData("/api/local-providers"))?.providers ?? [], // P-LOCAL.3
  localProviderUpsert: (provider) => post("/api/local-providers", { provider }), // P-LOCAL.3 (server validates fail-closed)
  localProviderDelete: (id) => post("/api/local-providers/delete", { id }), // P-LOCAL.3
  localProviderEnable: (id, enabled) => post("/api/local-providers/enable", { id, enabled }), // P-LOCAL.3
  localProviderTest: (baseUrl) => post("/api/local-providers/test", { baseUrl }), // P-LOCAL.3 polish
  relaunch: () => (shell?.relaunch ? shell.relaunch() : Promise.resolve()), // P-LOCAL.3 polish (Electron only)
  figmaImport: (fileUrl, pat) => post("/api/figma/import", { fileUrl, ...(pat ? { pat } : {}) }), // P-FIGMA.1
  designDoc: () => getData("/api/design"), // P-FIGMA.2
  setCodeGraphAgent: (enabled) => post("/api/codegraph/agent", { enabled }),
  chatBackground: () => getData("/api/chat-bg"),
  setChatBackground: (patch) => post("/api/chat-bg", patch),
  engineeringBriefAudio: (provider, voiceId) => post("/api/brief/audio", { provider, voiceId }),
  voiceSettings: () => getData("/api/voice-settings"),
  setVoiceSettings: (patch) => post("/api/voice-settings", patch),
  voices: () => getData("/api/voices"),
  transcribe: (audioB64, mime, language) => post("/api/transcribe", { audioB64, mime, language }),
  speak: (text, voiceId, provider) => post("/api/tts/speak", { text, voiceId, provider }),
  pastReports: () => getData("/api/goal/reports"),
  pastReport: (rel) => getData(`/api/goal/reports?rel=${encodeURIComponent(rel)}`),
  memory: () => getData("/api/memory"),
  budget: () => getData("/api/budget"),
  rateLimits: (force) => getData(`/api/ratelimits${force ? "?force=1" : ""}`),
  setRateLimitProbe: (enabled) => post("/api/ratelimits", { enabled }),
  dev: () => getData("/api/dev"),
  setDeveloperMode: (enabled) => post("/api/dev", { enabled }),
  mcpList: () => getData("/api/mcp"),
  mcpUpsert: (e) => post("/api/mcp", e),
  mcpRemove: (id) => post("/api/mcp/remove", { id }),
  mcpToggle: (id, enabled) => post("/api/mcp/toggle", { id, enabled }),
  remoteAgentList: () => getData("/api/agents"),
  remoteAgentUpsert: (e) => post("/api/agents", e),
  remoteAgentRemove: (id) => post("/api/agents/remove", { id }),
  remoteAgentToggle: (id, enabled) => post("/api/agents/toggle", { id, enabled }),
  usage: () => getData("/api/usage"),
  codeActivity: () => getData("/api/code-activity"),
  sendPrompt: streamChat,
  runGoal: (opts, onEvent) => streamNdjson("/api/goal", opts, onEvent),
  resumableLoops: () => getData("/api/goal/resumable"),
  loopRunStats: () => getData("/api/goal/stats"),
  loopScopes: () => getData("/api/goal/scopes"),
  preflightAudit: (spec) => post("/api/goal/preflight", spec),
  automations: () => getData("/api/automations"),
  automationCreate: (spec) => post("/api/automations", spec),
  automationEnable: (id, enabled) => post("/api/automations/enable", { id, enabled }),
  automationDelete: (id) => post("/api/automations/delete", { id }),
  automationRun: (id, onEvent) => streamNdjson("/api/automations/run", { id }, onEvent),
  checkerModel: () => getData("/api/checker-model"),
  setCheckerModel: (value) => post("/api/checker-model", { value }),
  config: async () => (await getData("/api/config")) ?? FALLBACK_CONFIG,
  refreshConfig: async () => (await post("/api/config/refresh", {})) ?? FALLBACK_CONFIG,
  setConfig: async (id, value) => (await post("/api/setConfig", { configId: id, value })) ?? FALLBACK_CONFIG,
  modes: () => getData("/api/modes"),
  setMode: (modeId) => post("/api/modes", { modeId }),
  setUiMode: (uiMode) => post("/api/uimode", { uiMode }),
  respondPermission: (id, optionId) => post("/api/chat/permission", { id, optionId }),
  cancelChat: () => { chatAbort?.abort(); return post("/api/chat/cancel", {}); },
  cancelGoal: () => post("/api/goal/cancel", {}),
  commands: async () => (await getData("/api/commands")) ?? [],
  skills: () => getData("/api/skills"),
  userCommands: async () => (await getData("/api/usercommand")) ?? [], // P-CMD.1
  userCommandCreate: (command) => post("/api/usercommand", { command }), // P-CMD.1 (server validates + scans fail-closed)
  userCommandDelete: (name) => post("/api/usercommand/delete", { name }), // P-CMD.1
  skillImport: (files) => post("/api/skills/import", { files }),
  skillInspect: (name) => post("/api/skills/inspect", { name }),
  skillRescan: (name) => post("/api/skills/rescan", { name }),
  skillRemove: (name) => post("/api/skills/remove", { name }),
  skillStudioAnalyze: (window) => post("/api/skill-studio/analyze", { window }),
  skillStudioDraft: (candidate) => post("/api/skill-studio/draft", { candidate }),
  kbIngest: (doc) => post("/api/kb/ingest", doc),
  kbRetrieve: (query, mode) => post("/api/kb/retrieve", { query, mode }),
  kbGraph: () => getData("/api/kb/graph"),
  setActiveSkill: (name, prompt) => post("/api/skill", { name, prompt }),
  clearActiveSkill: () => post("/api/skill", { clear: true }),
  skillActivated: (command, name, source) => post("/api/skill/activated", { command, name, source }),
  sessions: async () => {
    try {
      const r = await fetch("/api/sessions", { cache: "no-store", headers: authHeaders() });
      if (r.status === 404) return null; // server predates the sessions route → out of date
      const data = (await r.json())?.data;
      // Tolerate an older server that returned a bare array (pre-1b): wrap it as { sessions, ingest }.
      if (Array.isArray(data)) return { sessions: data, ingest: [] };
      return data ?? { sessions: [], ingest: [] };
    } catch { return null; }
  },
  sessionMessages: async (id, limit = 0) => {
    const data: { messages: { role: string; text: string }[]; total: number } | { role: string; text: string }[] | null =
      await getData(`/api/session?id=${encodeURIComponent(id)}&limit=${limit}`);
    if (!data) return null;
    // Tolerate an older server that returned the bare array (pre-P-PERF.4): wrap it as a full page.
    return Array.isArray(data) ? { messages: data, total: data.length } : data;
  },
  resumeSession: async (id) => { await post("/api/session/load", { id }); },
  deleteSession: async (id) => (await post("/api/session/delete", { id })) ?? { ok: false, error: "no response" },
  clearIngestSessions: () => post("/api/sessions/ingest/clear", {}),
  newSession: async () => { await post("/api/newSession", {}); },
  // P-COLLAB.3 (ADR-0192): live session sharing.
  collabStatus: () => getData("/api/collab/status"),
  collabStart: async (opts) => {
    try {
      const r = await fetch("/api/collab/start", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ allowEdit: !!opts?.allowEdit }) });
      const j = await r.json();
      return j?.ok ? { ok: true, status: j.data as CollabShareStatus } : { ok: false, error: String(j?.error ?? `backend error ${r.status}`) };
    } catch (e) { return { ok: false, error: String((e as Error)?.message ?? "backend unreachable") }; }
  },
  collabStop: () => post("/api/collab/stop", {}),
  collabGuestInbox: () => getData("/api/collab/guest-inbox"),
  collabGuestSendPrompt: async (text) => {
    try {
      const r = await fetch("/api/collab/guest-prompt", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ text }) });
      const j = await r.json();
      return j?.ok ? { ok: true } : { ok: false, error: String(j?.error ?? `backend error ${r.status}`) };
    } catch (e) { return { ok: false, error: String((e as Error)?.message ?? "backend unreachable") }; }
  },
  collabGuestAbort: () => post("/api/collab/guest-abort", {}),
  collabSetRelay: (patch) => post("/api/collab/relay", patch),
  collabRelayServeStatus: () => getData("/api/collab/relay/status"),
  collabRelayServe: async (patch) => {
    try {
      const r = await fetch("/api/collab/relay/serve", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(patch) });
      const j = await r.json();
      return j?.ok ? { ok: true, status: j.data as CollabRelayServeStatus } : { ok: false, error: String(j?.error ?? `backend error ${r.status}`) };
    } catch (e) { return { ok: false, error: String((e as Error)?.message ?? "backend unreachable") }; }
  },
  collabJoin: (link, onFrame) => streamCollabJoin(link, onFrame),
  collabLeave: () => { collabJoinAbort?.abort(); return post("/api/collab/leave", {}); },
  getSettings: () => getData("/api/settings"),
  saveUsername: (username) => post("/api/settings", { username }),
  saveProfile: (p) => post("/api/settings", p),
  skipEmail: () => post("/api/settings", { skip: true }),
  saveRole: (role) => post("/api/settings", { role }),
  setTourSeen: (seen) => post("/api/settings", { tourSeen: seen }),
  managed: () => getData("/api/managed"),
  chinaAck: () => getData("/api/china-ack"),
  setChinaAck: (acknowledge) => post("/api/china-ack", { acknowledge }),
  thirdPartyAck: () => getData("/api/thirdparty-ack"),
  setThirdPartyAck: (acknowledge) => post("/api/thirdparty-ack", { acknowledge }),
  auth: () => getData("/api/auth"),
  saveKey: (env, key) => post("/api/auth/key", { env, key }),
  oauthLogin: (oauthId) => post("/api/auth/oauth", { oauthId }),
  oauthLogout: (oauthId) => post("/api/auth/logout", { oauthId }),
  oauthCode: (oauthId, code) => post("/api/auth/oauth-code", { oauthId, code }),
  asksage: () => getData("/api/asksage"),
  saveAsksage: (opts) => post("/api/asksage", opts),
  asksageTokens: () => getData("/api/asksage/tokens"),
  asksageDatasets: () => getData("/api/asksage/datasets"),
  asksagePersonas: () => getData("/api/asksage/personas"),
  applyPersona: (id) => post("/api/asksage/persona", id ? { id } : { clear: true }),
  headroom: () => getData("/api/headroom"),
  setHeadroom: (enabled) => post("/api/headroom", { enabled }),
  intelNews: () => getData("/api/intel-news"),
  personal: () => getData("/api/personal"),
  personalEnable: (enabled) => post("/api/personal/enable", { enabled }),
  personalAiExtract: (enabled) => post("/api/personal/ai-extract", { enabled }),
  personalSetup: (passphrase) => post("/api/personal/setup", { passphrase }),
  personalUnlock: (passphrase) => post("/api/personal/unlock", { passphrase }),
  personalLock: () => post("/api/personal/lock", {}),
  personalScope: (scope) => post("/api/personal/scope", { scope }),
  personalCuiSetup: (passphrase) => post("/api/personal/cui/setup", { passphrase }),
  personalCuiUnlock: (passphrase) => post("/api/personal/cui/unlock", { passphrase }),
  personalCuiLock: () => post("/api/personal/cui/lock", {}),
  personalCuiMigrate: () => post("/api/personal/cui/migrate", {}),
  personalCuiDestroy: () => post("/api/personal/cui/destroy", {}),
  personalGraph: (scope) => getData(`/api/personal/graph${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`),
  personalForget: (factId) => post("/api/personal/forget", { factId }),
  personalRelate: (from, to, relation) => post("/api/personal/relate", { from, to, relation }),
  personalUnrelate: (from, to, relation) => post("/api/personal/unrelate", { from, to, relation }),
  personalImport: (path, model) => post("/api/personal/import", { path, model: !!model }),
  personalImportStatus: (jobId) => getData(`/api/personal/import/status${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ""}`),
  personalImportCancel: (jobId) => post("/api/personal/import/cancel", { jobId }),
  personalImportEstimate: (path) => post("/api/personal/import/estimate", { path }),
  editorRead: (path) => post("/api/editor/file", { path }),
  editorSave: (opts) => post("/api/editor/save", opts),
  personalExportVault: (opts) => post("/api/personal/vault", opts),
  personalCuiArchive: (opts) => post("/api/personal/cui-archive", opts),
  personalExports: () => getData("/api/personal/exports"),
  workspace: () => getData("/api/workspace"),
  setWorkspace: (path) => post("/api/workspace", { path }),
  cloneWorkspace: (url) => post("/api/workspace/clone", { url }),
  pickFolder: () => (shell?.pickFolder ? shell.pickFolder() : Promise.resolve(null)),
  pickFile: (opts) => (shell?.pickFile ? shell.pickFile(opts) : Promise.resolve(null)), // P-NETWL.1
  credStore: (input) => (shell?.credStore ? shell.credStore(input) : Promise.resolve({ error: "os-encryption-unavailable" })), // P-NETWL.1 (fail-closed in browser)
  credStoreFile: (input) => (shell?.credStoreFile ? shell.credStoreFile(input) : Promise.resolve({ error: "os-encryption-unavailable" })), // P-NETWL.2
  credRotate: (input) => (shell?.credRotate ? shell.credRotate(input) : Promise.resolve({ error: "os-encryption-unavailable" })), // P-KEYS.2
  credRotateFile: (input) => (shell?.credRotateFile ? shell.credRotateFile(input) : Promise.resolve({ error: "os-encryption-unavailable" })), // P-KEYS.2
  credList: () => (shell?.credList ? shell.credList() : Promise.resolve([])), // P-NETWL.1
  credDelete: (ref) => (shell?.credDelete ? shell.credDelete(ref) : Promise.resolve(false)), // P-NETWL.1
  credEncryptionAvailable: () => (shell?.credEncryptionAvailable ? shell.credEncryptionAvailable() : Promise.resolve(false)), // P-NETWL.1
  whitelistList: async () => (await getData("/api/whitelist")) ?? [], // P-NETWL.2
  whitelistUpsert: (entry) => post("/api/whitelist", entry), // P-NETWL.2
  whitelistRemove: async (id) => { await post("/api/whitelist/remove", { id }); }, // P-NETWL.2
  whitelistPosture: async () => (await getData("/api/whitelist/posture")) ?? { allowAll: true, allowWebSearch: true, managedLocked: false }, // P-NETWL.5
  setWhitelistPosture: (patch) => post("/api/whitelist/posture", patch), // P-NETWL.5
  capturePreview: (rect) => (shell?.capturePreview ? shell.capturePreview(rect) : Promise.resolve(null)), // P-PREVIEW.1
  previewEgressAllows: async (url) => { const d = await getData(`/api/preview/egress-check?url=${encodeURIComponent(url)}`); return !!(d as { allow?: boolean } | null)?.allow; }, // P-PREVIEW.3b
  previewFile: async (path) => { const d = await getData(`/api/preview/file?path=${encodeURIComponent(path)}`); const h = (d as { html?: unknown } | null)?.html; return typeof h === "string" ? h : null; }, // P-PREVIEW.4
  previewServeUrl: (path) => `/api/preview/serve?path=${encodeURIComponent(path)}${TOKEN ? `&t=${encodeURIComponent(TOKEN)}` : ""}`, // P-PREVIEW.4b
  cachePreviewShot: async (png) => { await post("/api/preview/shot-cache", { png }); }, // P-PREVIEW.3a-shot
  previewInspectNext: () => getData("/api/preview/inspect/next"), // P-PREVIEW.6b
  previewInspectResult: async (id, result) => { await post("/api/preview/inspect/result", { id, result }); }, // P-PREVIEW.6b
  previewElectronDetect: (path) => getData(`/api/preview/electron-detect?path=${encodeURIComponent(path)}`), // P-PREVIEW.7
  previewElectronLaunch: (path) => post("/api/preview/electron-launch", { path }), // P-PREVIEW.7
  subagents: () => getData("/api/subagents"), // P-TASK.5
  systemStatus: async (fresh) => { // P-SYSRES.1: fail-open - malformed/missing reads as null (never blocks)
    const v: unknown = await getData(`/api/system${fresh ? "?fresh=1" : ""}`).catch(() => null);
    return isSystemStatus(v) ? v : null;
  },


  listDir: (path) => getData(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  revealPath: (path) => (shell?.revealPath ? shell.revealPath(path) : Promise.resolve(false)),
  canRevealPath: () => !!shell?.revealPath,
  setZoom: (f) => {
    if (shell?.setZoom) { shell.setZoom(f); return; } // Electron: crisp native zoom
    // Browser: zoom #app and counter-scale its height so it still fills the viewport
    // exactly (so the layout reflows and the chat keeps its own scroll).
    const app = document.getElementById("app");
    if (app) { (app.style as any).zoom = String(f); app.style.height = `calc(100vh / ${f})`; }
  },
};
