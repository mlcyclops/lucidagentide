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
import { isCreatorResources, type CreatorResourcesView } from "./creator_monitor.ts"; // CREATOR-0 (ADR-0283): odometer view types live there
import { isCreatorStudio, type CreatorStudioView } from "./creator_studio.ts"; // CREATOR-0 (ADR-0282): Studio view types live there
import { isEditorSession, type EditorSession } from "./creator_editor.ts"; // CREATOR-2 (ADR-0286): editor session view type lives there
import { isPipelineRunView, type PipelineRunView } from "./creator_pipeline.ts"; // CREATOR-3 (ADR-0287): the render run view + its fail-closed shape gate
import { isMixerTracksPayload, isRenderMixReport, type MixerTracksPayload, type RenderMixResult } from "./creator_mixer.ts"; // CREATOR-5 (ADR-0289): mixer view types live there
import type { TimelineDoc } from "../../harness/creator/timeline.ts"; // CREATOR-2: the pure timeline document, edited in the renderer
import type { MixGraph } from "../../harness/creator/mix.ts"; // CREATOR-5: the pure mix graph, edited in the renderer

/** CREATOR-0 (ADR-0279): what `GET /api/build-info` returns. `creatorBuild` is the ONLY thing that may
 *  reveal a Creator surface - never a persisted setting, never a role. */
export interface BuildInfoView {
  flavor: "agent" | "creator";
  creatorBuild: boolean;
  appId: string;
  productName: string;
  displayName: string;
  version: string;
  defaultPort: number;
  port: number;
  authProtocol: string;
  dataRoot: string;
  settingsFile: string;
  personalDir: string;
  vaultScope: string;
  features: { creatorMode: boolean; integrationRegistry: boolean; localMonitoring: boolean; cpuGpuOdometer: boolean; creatorLibrary: boolean };
}

/** CREATOR-IMG (ADR-0291): one model a live probe found on the configured image server. */
export interface CreatorModelView { id: string; kind: string; node: string }
/** CREATOR-IMG: a stored image artifact with the provenance that produced it. */
export interface CreatorArtifactView {
  id: string; kind: string; file: string; mime: string; bytes: number; sha256: string;
  createdAt: number; width: number; height: number; source: string; prompt: string; model: string;
  sidecars: string[];
}
/** CREATOR-IMG: raw RGBA on the wire, straight out of a canvas `getImageData()`. */
export interface WireFrameView { width: number; height: number; rgbaB64: string }
/** CREATOR-IMG: a generation request - the prompt pair, the model, the size, and named input images. */
export interface CreatorGenerateInput {
  prompt: string; negative?: string; model?: string; width?: number; height?: number; seed?: number;
  inputs?: { role: string; dataUrl: string }[];
}

/** CREATOR-0: one library mutation. `add` imports a picked file; `remix`/`reprompt` do the same and record
 *  lineage from `id`; `update` edits title/prompt/tags/rating/review; `remove` drops the track. */
export interface CreatorLibraryOp {
  op: "add" | "update" | "remix" | "reprompt" | "remove";
  id?: string;
  sourcePath?: string;
  title?: string;
  origin?: string;
  prompt?: string;
  lyrics?: string;
  tags?: string[];
  rating?: number | null;
  review?: string;
}

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
import type { NativePickResult } from "../native_dialog.ts"; // P-FS.2 (ADR-0265): backend-opened OS folder dialog
import type { RestoredTurn } from "../session_steps.ts"; // P-RESUME.1 (ADR-0171): restored agent activity
export type { RestoredTurn };
import type { ProcessView } from "../process_view.ts"; // P-INTERJECT.1: the unified Processes list rows (canonical shape - imported, never mirrored, so it cannot drift)
export type { ProcessView };
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

// P-FLEET.L1: the fleet grid's view shapes (renderer mirrors of desktop/fleet_lanes.ts - kept in parity
// at this one boundary, like ChatEvent).
export type LaneStatus = "starting" | "working" | "needs-approval" | "awaiting-input" | "done" | "error" | "stopped";
/** Approval scope: "once" answers only the pending ask; "session" also allows every same-kind ask for
 *  the rest of the lane's session (mirrors desktop/fleet_lanes.ts). */
export type ApprovalScope = "once" | "session";
export interface LaneView {
  id: string; name: string; cwd: string; model: string; status: LaneStatus;
  createdAt: number; lastActivityAt: number; turns: number;
  /** P-FLEET.L4: Retry is offered only when a last prompt exists; respawns counts in-place revivals. */
  canRetry: boolean; respawns: number;
  /** P-FLEET.L5: the omp session id behind this lane - the key into its on-disk history. */
  sessionId: string | null;
  pendingApproval?: { summary: string; kind: string };
  /** Full auto-mode: every ask is approved automatically (the security gate still scans every call). */
  autoApprove: boolean;
  /** Ask kinds the user allowed for the rest of this lane's session ("allow for session"). */
  sessionAllow: string[];
  /** P-FLEET.L3: staged-prompt previews (clamped text + image count), drained FIFO when idle. */
  queued: { text: string; images: number }[];
  /** P-FLEET.L8: the MAIN composer is attached to this lane right now (exactly one lane can be). */
  promoted: boolean;
  /** P-HEALTH.1: tool calls awaiting a result - the reason a long-silent lane is `quiet` and not probed. */
  openCalls: number;
  /** P-HEALTH.1: the harness's last self-action on this lane, so the card can show it was handled. */
  lastHealth?: { action: "probe" | "recover"; reason: string; at: number };
}
// P-FLEET.L5 (ADR-0274): the reviewable timeline - one row per session on this machine, every workspace,
// lanes labeled through the durable lane-session ledger.
export type TimelineKind = "chat" | "lane" | "ingest";
export interface TimelineEntry {
  sessionId: string; kind: TimelineKind; title: string; cwd: string; wsName: string;
  model: string; turns: number; updatedAt: number;
  laneId?: string; laneName?: string; laneEvents?: number;
  /** Present only when true: a throwaway from the repo's own echo/demo self-test scripts. */
  selfTest?: true;
}
/** `total` = pageable rows; `selfTest` = how many throwaways the engine held back (or marked). */
export interface TimelinePage { entries: TimelineEntry[]; total: number; selfTest: number }
/** P-FLEET.L3: a pasted image on a lane prompt - the P-VISION.1 shape the master chat uses. */
export interface LaneImage { data: string; mimeType: string }
/** P-FLEET.L3 (mirrors P-CHAT.1): a write's content, an edit's before/after pair, or a hashline patch. */
export interface LaneToolCode { path: string; content?: string; oldText?: string; newText?: string; patch?: string }
export type LaneEvent =
  | { type: "token" | "thinking"; text: string }
  /** P-FLEET.L7: `input` is the bounded, code-stripped rawInput - the command a code-less tool ran. */
  | { type: "tool"; name: string; detail: string; code?: LaneToolCode; input?: string }
  | { type: "permission"; summary: string; kind: string }
  | { type: "auto-approved"; summary: string; mode: "auto" | "session" }
  /** P-FLEET.L7: this lane's OWN measured context fill, window, and cost. */
  | { type: "usage"; used: number; size: number; cost: number }
  /** P-HEALTH.1: the harness probed or recovered this lane by itself. */
  | { type: "health"; action: "probe" | "recover"; reason: string }
  | { type: "status"; status: LaneStatus }
  | { type: "done" }
  | { type: "error"; message: string }
  /** P-FLEET.L8: only on /api/fleet/watch - the lane's bounded history, so a composer attaching mid-turn
   *  renders the conversation instead of an empty pane. Never emitted on a prompt stream. */
  | { type: "watch-seed"; turns: { role: "user" | "assistant"; text: string }[] };
export interface FleetStatusView {
  lanes: LaneView[];
  /** P-FLEET.L2: sustained-pressure evidence. No lane cap - the fleet is unlimited; only CPU or memory
   *  held at/above `pressurePct` for `sustainMs` refuses a new lane. `*HotMs` = unbroken ms above the
   *  line right now (0 = clear, or still just a burst). */
  resources: {
    cpuPct: number | null;
    memPct: number | null;
    pressurePct: number;
    sustainMs: number;
    cpuHotMs: number;
    memHotMs: number;
  };
  masterModel: string;
}
// P-VOICE.1 (ADR-0115): voice config + the voice lists behind the pickers.
export interface VoiceSettingsView {
  sttProvider: "elevenlabs" | "whisper";
  sttUrl: string;
  ttsProvider: "elevenlabs" | "openai-tts" | "local-tts";
  /** The voice chosen for `ttsProvider` — the store remembers one per engine (P-VOICE.2, ADR-0247). */
  ttsVoice: string;
  ttsVoiceFavorites: string[];
  /** P-VOICE.2 (ADR-0247): read every assistant reply aloud as it streams. Opt-in; off by default. */
  ttsAutoSpeak: boolean;
  /** P-VOICE.3: hands-free turn-taking - the reply ends, the mic opens, a silence sends. Needs ttsAutoSpeak. */
  ttsConversation: boolean;
}
// P-VOICE.2 (ADR-0247): what /api/voices returns for ONE engine — the list plus the picker's context.
export interface VoiceListView {
  provider: "elevenlabs" | "openai-tts" | "local-tts";
  /** Every engine with LIVE readiness \u2014 `ready:false` carries the specific reason it cannot speak. */
  engines: TtsEngineView[];
  voices: ElevenVoiceView[];
  favorites: string[];
  selected: string;
  autoSpeak: boolean;
  conversation: boolean;
  note?: string;
}
export interface TtsEngineView {
  id: "elevenlabs" | "openai-tts" | "local-tts";
  label: string;
  blurb: string;
  cloud: boolean;
  keyEnv: string | null;
  liveList: boolean;
  ready: boolean;
  /** Empty when ready; otherwise what the user has to do about it. */
  reason: string;
}
// P-STT.2b: managed on-device Whisper status for the no-code Voice card.
// P-STT.6 (ADR-0267): `offered` = installable through the picker (tiny/base/small; medium/large are
// remove-only), `reason` explains a grayed-out (non-runnable) tier, `diskMB` = real installed size.
export interface WhisperTierView {
  tier: string; label: string; runnable: boolean; installed: boolean;
  offered: boolean; reason: string; approxMB: number; diskMB: number | null;
}
export interface WhisperStatusView {
  capable: boolean; recommended: string | null; summary: string;
  /** The tier used when nothing is picked (tiny); the picker preselects it when no server runs. */
  defaultTier?: string | null;
  binAvailable: boolean; binHint: string;
  running: boolean; port: number; activeTier: string | null; serveUrl: string | null;
  tiers: WhisperTierView[];
  install: { active: boolean; tier: string | null; fraction: number; phase: "idle" | "downloading" | "starting" | "done" | "error"; reason?: string };
}
export interface WhisperActionView { ok: boolean; tier?: string; reason?: string }
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
  // P-EVAL.4 (ADR-0318): per-tool detail the report groups by. `name` is the REAL tool name when the
  // tool_meta extension reported one (omp's ACP update cannot carry it), otherwise it degrades to the
  // coarse ACP class. `kind` is ALWAYS that coarse class, so the server can group by name and fall back
  // to kind without guessing which one it received. `ok` is present only when genuinely observed: absent
  // means "not known", never "passed", because the report renders measured vs unmeasured from exactly
  // this distinction.
  tools: { name: string; path?: string; add?: number; del?: number; kind?: string; detail?: string; ok?: boolean }[];
  failures?: { tool: string; reason: string; cmd?: string }[];
  subagents?: number; when?: string;
}
export interface EvalReportResult { kind: string; id: string; rel: string | null; title: string }
export interface ModeOption { id: string; name: string; description?: string }
export interface ModeState { available: ModeOption[]; current: string; ui?: "agent" | "creator" | "ask" | "plan"; permissionMode?: "auto" | "ask" }
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
// P-KGPACK.2 (ADR-0205): the named-KG picker. `activeId` is the KG a no-arg store lookup resolves to; a
// mutation returns the refreshed list plus an optional `error` (validation failures don't null the list).
export interface KgListItemView { kg_id: string; name: string; read_only: boolean; source_kind: string }
export interface KgListView { kgs: KgListItemView[]; activeId: string | null; error?: string }
// P-KGPACK.3 (ADR-0205): seed a named KG from a folder (chat export or Obsidian markdown). All fields past
// `ok` are present only on success; `error` carries the friendly failure message.
export interface KbBatchResultView {
  ok: boolean; error?: string;
  kgId?: string; kgName?: string; kind?: "chat" | "obsidian"; vendor?: string | null;
  documents?: number; totalDocuments?: number; available?: number; skipped?: number;
  pagesCompiled?: number; pagesQuarantined?: number; documentsQuarantined?: number; errored?: number; links?: number; cancelled?: boolean;
}
// P-KGPACK.6 (ADR-0205): the batch seed is a BACKGROUND job. `kbIngestBatch` now returns a start (jobId or
// error); the renderer polls `kbIngestStatus` and can `kbIngestCancel`.
export interface KbIngestStartView { ok: boolean; jobId?: string; kgId?: string; kgName?: string; error?: string }
export interface KbIngestJobView {
  jobId: string; state: "running" | "done" | "failed" | "cancelled"; kgId: string; kgName: string;
  documents: number; totalDocuments: number; pagesCompiled: number; pagesQuarantined: number; documentsQuarantined: number; errored: number;
  startedAt: number; updatedAt: number; result?: KbBatchResultView; error?: string;
}
// P-KGPACK.4 (ADR-0205): .lkgpack pack author (export) + gated import.
export interface KbPackExportView { ok: boolean; error?: string; path?: string; signed?: boolean; pages?: number }
export interface KbPackImportView {
  ok: boolean; error?: string; stage?: string;
  kgId?: string; kgName?: string; signed?: boolean; keyId?: string; pages?: number; findings?: number;
}
// P-PROV.1 (ADR-0210): extra per-provider config env (Azure resource/version, Vertex project/location/ADC,
// Gemini-Enterprise project). Non-secret fields echo `value` to pre-fill; secret fields report `last4`.
export interface ProviderFieldAuth { env: string; label: string; placeholder?: string; secret?: boolean; set: boolean; value?: string; last4?: string }
export interface ProviderAuth {
  id: string; name: string; env: string; oauthId: string; canOauth: boolean;
  oauthActive: boolean; oauthIdentity?: string; keySet: boolean; keyLast4?: string;
  fields?: ProviderFieldAuth[];
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
/** Options for the native folder dialog (P-KG-INGEST.5, ADR-0264). */
export interface PickFolderOpts { title?: string; defaultPath?: string; buttonLabel?: string }
export interface PersonalImportStart { ok: boolean; jobId?: string; error?: string }
export interface PersonalImportJob {
  jobId: string; state: "running" | "done" | "failed" | "cancelled"; vendor?: string;
  messages: number; totalMessages: number; conversations: number; totalConversations: number;
  learned: number; blocked: number; startedAt: number; updatedAt: number;
  cancelRequestedAt?: number; // P-KG-INGEST.5: Stop pressed, run unwinding
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
// P-WSSETUP: the workspace-initialization offer. Mirrors desktop/workspace_setup.ts, plus the
// server-side `asked` flag (this folder was already offered setup, never re-ask).
export type WorkspacePurpose = "app" | "docs" | "analysis" | "other";
export interface WorkspaceProfile {
  path: string; isGit: boolean; isEmpty: boolean; hasAgentsFramework: boolean; hasCode: boolean;
  stack: string[]; fileCount: number; asked: boolean;
}
export interface AgentsInitResult { ok: boolean; created: string[]; skipped: string[]; error?: string }

// The LUCID session event union now lives in a DOM-free module (chat_events.ts) so node-side code that only
// needs the shape doesn't drag bridge.ts (a DOM file) into the non-DOM root typecheck. Re-exported here so
// every existing `import { type ChatEvent } from "./bridge.ts"` keeps working unchanged.
import type { ChatEvent } from "./chat_events.ts";
import { streamEndEvents, TERMINAL_EVENT_TYPES } from "./stream_end.ts"; // what to tell the UI when a turn stream ends badly
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
// ADR-0088 (P-ROLE.1): the onboarding roles (renderer-side mirror of settings_store's UserRole).
// P-AVATAR.1 (ADR-0251): + "lucid-agent", the one behavioral role (immersive stage).
export type UserRole = "developer" | "security" | "manager" | "executive" | "lucid-agent";
export interface ProfileSettings {
  username: string;
  email: string;
  // Effective code-activity attribution identity (ADR-0030): email if set, else workstation hostname.
  attribution?: Attribution;
  // ADR-0088/0089: cosmetic onboarding state. `role` shapes default surfacing; `tourSeen` guards the
  // first-run walkthrough replay. Both default safely (role→"developer", tourSeen→false) when absent.
  role?: UserRole;
  tourSeen?: boolean;
  // P-GOVCUI.1: the first-run Government/CUI answer. `null` = not asked yet (drives the gov onboarding step);
  // true = on the CUI (gov gateway) path; false = standard use. Cosmetic onboarding state, never gates.
  govconCui?: boolean | null;
  // P-THEME.1: the chosen app theme id, or "" when never chosen (then the OS light/dark preference
  // decides). An opaque string on purpose: theme.ts's THEMES registry is the only place ids are defined.
  theme?: string;
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
export interface CollabRelay { wsBase: string; httpBase: string; label: string; source: "self-hosted" | "public" | "embedded"; pwaBase?: string; gated?: boolean }
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
  /** P-COLLAB.19 (ADR-0241): the always-VIEW-ONLY browser/phone link - on an edit share, hand this to guests
   *  who should only watch (browserLink is the edit-capable twin). */
  browserViewLink?: string;
  relayLabel?: string;
  relaySource?: string;
  startedAt?: number;
  /** P-COLLAB.13: true when the share allows a full-link guest to drive the host. */
  allowEdit?: boolean;
  participantCount: number;
  participants: CollabParticipantView[];
  relay?: CollabRelay | null;
  /** P-COLLAB.17: true when THIS share is running over a direct WebRTC connection (relay used only to signal). */
  direct?: boolean;
}

/** P-COLLAB.17 (ADR-0202): the "prefer direct P2P" preference + STUN/TURN servers (stun:/turn: URLs). */
export interface CollabP2PConfig { preferDirect: boolean; iceUrls: string[]; turnUsername?: string; turnCredential?: string }

/** P-BROWSER.1 (wave 2): the agent-controlled visible browser window's live status (mirrors
 *  desktop/browser_control.ts BrowserStatus - the shared cross-agent contract shape). */
export interface BrowserStatusView { active: boolean; title: string; url: string; startedAt: number | null; shots: number }

export interface LucidBridge {
  isElectron: boolean;
  security(): Promise<SecuritySnapshot | null>;
  /** Release one quarantined call - the audited fail-closed override (ADR-0019 C). */
  securityApprove(id: string): Promise<BlockRecord | null>;
  securityDismiss(id: string): Promise<BlockRecord | null>;
  /** Bulk-acknowledge every active gate block. Releases NOTHING: each call stays blocked, audit kept. */
  securityDismissAll(): Promise<{ dismissed: number } | null>;
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
  /** Voices for `provider`, or for the engine currently selected in settings when omitted. */
  voices(provider?: string): Promise<VoiceListView | null>;
  transcribe(audioB64: string, mime: string, language?: string): Promise<{ text: string; note: string } | null>;
  // P-STT.2b: managed on-device Whisper - hardware-gated install / start / stop / status (no-code).
  whisperStatus(): Promise<WhisperStatusView | null>;
  whisperInstall(tier?: string): Promise<WhisperActionView | null>;
  whisperStart(tier?: string): Promise<WhisperActionView | null>;
  whisperStop(): Promise<{ ok: boolean } | null>;
  /** P-STT.6 (ADR-0267): delete a downloaded model's weights (never the running tier - stop first). */
  whisperRemove(tier: string): Promise<WhisperActionView | null>;
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
  /** `allowEdit` shares an EDIT link so a full-link guest can drive the host (P-COLLAB.13). `favModels`
   *  (P-REMOTE.11b, ADR-0238): the host's favorite model values - the backend offers edit guests just these
   *  plus the current model (favorites live in renderer localStorage; the backend cannot read them). */
  collabStart(opts?: { allowEdit?: boolean; favModels?: string[] }): Promise<{ ok: boolean; status?: CollabShareStatus; error?: string }>;
  collabStop(): Promise<CollabShareStatus | null>;
  collabSetRelay(patch: { url?: string; publicOptIn?: boolean }): Promise<{ relay: CollabRelay | null } | null>;
  // P-COLLAB.13: guest-write. The HOST polls collabGuestInbox and runs a pending guest prompt through its own
  // composer; the connected GUEST drives the host via collabGuestSendPrompt / collabGuestAbort.
  collabGuestInbox(): Promise<{ prompt: { text: string; from: string; images?: string[] } | null; abort: boolean; model: { value: string; from: string } | null; workspace: { path: string; from: string } | null } | null>;
  collabGuestSendPrompt(text: string, images?: string[]): Promise<{ ok: boolean; error?: string }>;
  collabGuestAbort(): Promise<unknown>;
  // P-COLLAB.14 (ADR-0228): the connected GUEST switches the host's model / already-used folder (EDIT only).
  collabGuestSetModel(value: string): Promise<{ ok: boolean; error?: string }>;
  collabGuestSetWorkspace(id: string): Promise<{ ok: boolean; error?: string }>;
  // P-COLLAB.7: host the embedded relay on this device ("be the relay"), governance-gated + fail-closed.
  collabRelayServeStatus(): Promise<CollabRelayServeStatus | null>;
  collabRelayServe(patch: { enabled: boolean; host?: string; port?: number }): Promise<{ ok: boolean; status?: CollabRelayServeStatus; error?: string }>;
  // P-COLLAB.10: JOIN a shared session read-only. `collabJoin` streams guest frames until the share ends or
  // `collabLeave` is called; a synchronous parse/policy failure surfaces as an `{kind:"error"}` frame.
  collabJoin(link: string, onFrame: (f: CollabGuestFrame) => void): Promise<void>;
  collabLeave(): Promise<unknown>;
  // P-COLLAB.17: the "prefer direct P2P (WebRTC)" preference + STUN/TURN config (the renderer owns the P2P
  // host/guest). `collabAuthorizeConnect` re-checks the managed relay policy before a renderer-side P2P join.
  collabP2PConfig(): Promise<{ config: CollabP2PConfig; guestName: string; managed: { locked: boolean } } | null>;
  collabSetP2P(patch: Partial<CollabP2PConfig>): Promise<{ config: CollabP2PConfig } | null>;
  /** P-REMOTE.2c: push a fresh Firebase ID token to the backend so the host socket can authenticate to a
   *  GATED hosted relay. Empty idToken clears the backend cache (→ anonymous connect). */
  collabPushToken(idToken: string, expiresAt: number): Promise<{ present: boolean } | null>;
  /** P-PREVIEW-PWA.1 (ADR-0237): broadcast a scaled-down Preview-panel snapshot to RELAY guests (the backend
   *  CollabHost re-broadcasts it as a preview event). No-op when not relay-sharing; direct-P2P uses teeEvent. */
  collabBroadcastPreview(image: string, label?: string): Promise<{ sent: boolean } | null>;
  collabAuthorizeConnect(endpoint: string): Promise<{ ok: boolean; error?: string }>;
  // P-COLLAB.18: report a direct-P2P share/join lifecycle event to the backend audit trail (fire-and-forget;
  // the backend maps the closed action set to a validated EventName + whitelists the metadata).
  collabAudit(action: "share_started" | "share_stopped" | "guest_joined" | "guest_left", meta: { transport?: string; access?: string; roomId?: string; guest?: string }): void;
  /** `share` (P-PREVIEW-PWA.3, ADR-0240): roster COUNTS for a renderer-hosted direct-P2P share, so the
   *  backend can build the trusted agent-awareness preamble (a relay share is computed backend-side). */
  sendPrompt(text: string, onEvent: (e: ChatEvent) => void, images?: { data: string; mimeType: string }[], from?: string, share?: { view: number; edit: number }): Promise<void>;
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
  // P-MODELDEF: the user's explicitly-chosen model ("" if never chosen). getChosenModel reads it;
  // setChosenModel persists it on a genuine user pick, so it survives across launches.
  chosenModel(): Promise<string>;
  setChosenModel(value: string): Promise<string | null>;
  // P-MODEL.2: the model the composer LAST ran on (backend-written from omp's reported active model).
  // Distinct from chosenModel: a user who switches models in the composer without ever opening the
  // picker has no chosenModel, and the boot default must still land on what they were last using.
  lastModel(): Promise<string>;
  // P-ACP.2 (ADR-0027): ACP session modes (Plan / Agent), switched via session/set_mode.
  modes(): Promise<ModeState | null>;
  setMode(modeId: string): Promise<ModeState | null>;
  // P-ACP.3: the composer's Plan/Ask/Agent + answering a forwarded permission request.
  // CREATOR-0: `creator` is offered only in a Creator build; the backend folds it to `agent` elsewhere.
  setUiMode(uiMode: "agent" | "creator" | "ask" | "plan"): Promise<ModeState | null>;
  respondPermission(id: string, optionId: string | null): Promise<unknown>;
  // P-ACP.4: Stop the in-flight turn (interrupt reply + tool calls).
  cancelChat(): Promise<unknown>;
  cancelGoal(): Promise<unknown>; // P-GOAL.2: stop a running /goal loop
  // P-FLEET.L1/L2: local lanes - concurrent headless LUCID agents in the fleet grid dashboard.
  fleetStatus(): Promise<FleetStatusView | null>;
  /** `repoUrl` (P-FLEET.L2) clones a GitHub/GitLab/Azure DevOps remote into `cwd` (or the shared
   *  workspaces root when cwd is blank) and runs the lane there; an existing clone is reused. `pat` is a
   *  freshly-typed token used ONLY to spawn that git process - it is redacted from errors and never
   *  persisted by the server (the encrypted copy is written separately through the OS vault). */
  fleetSpawn(opts: { cwd: string; model?: string; name?: string; repoUrl?: string; pat?: string }): Promise<{ ok: boolean; lane?: LaneView; reason?: string } | null>;
  /** P-FLEET.L3: `images` ride as ACP image blocks after the text, exactly like the master chat. */
  fleetPrompt(laneId: string, text: string, onEvent: (e: LaneEvent) => void, images?: LaneImage[]): Promise<void>;
  /** P-FLEET.L3: the staged-prompt queue - manager-owned; drain streams the next item like a prompt. */
  fleetQueueAdd(laneId: string, text: string, images?: LaneImage[]): Promise<{ ok: boolean; queued?: number; reason?: string } | null>;
  fleetQueueRemove(laneId: string, index: number): Promise<{ ok: boolean } | null>;
  fleetQueueMove(laneId: string, index: number, dir: -1 | 1): Promise<{ ok: boolean } | null>;
  fleetDrain(laneId: string, onEvent: (e: LaneEvent) => void): Promise<void>;
  // P-FLEET.L5: the reviewable timeline (list + open-a-point). Transcript reads are tail-limited.
  // `includeSelfTest` opts the repo's own echo/demo throwaways back in; they are hidden by default.
  timelineList(limit?: number, offset?: number, includeSelfTest?: boolean): Promise<TimelinePage | null>;
  timelineSession(id: string, limit?: number): Promise<{ messages: { role: string; text: string; turn?: number }[]; total: number; userTotal: number } | null>;
  /** P-FLEET.L4: re-send the lane's last prompt, streaming like fleetPrompt (recovers an error lane first). */
  fleetRetry(laneId: string, onEvent: (e: LaneEvent) => void): Promise<void>;
  /** P-FLEET.L4: revive an error/stopped lane in place - same id, transcript memory carried. */
  fleetRespawn(laneId: string): Promise<{ ok: boolean; lane?: LaneView; reason?: string } | null>;
  fleetAnswer(laneId: string, allow: boolean, scope?: ApprovalScope): Promise<{ ok: boolean } | null>;
  /** Full auto-mode. laneId omitted = ALL lanes + persisted default for new ones. The server refuses
   *  on=true unless the risk was accepted before or acceptRisk is true (which persists the acceptance). */
  fleetAuto(opts: { laneId?: string; on: boolean; acceptRisk?: boolean }): Promise<{ ok: boolean } | null>;
  fleetCancel(laneId: string): Promise<{ ok: boolean } | null>;
  fleetStop(laneId: string): Promise<{ ok: boolean } | null>;
  /** P-FLEET.L10: DISMISS a lane - stop parks it (reviewable, respawnable), this forgets it so the card
   *  leaves the grid. Refused while a turn is in flight unless `force`, so one click cannot destroy work.
   *  The lane's on-disk session log and ledger line survive, so it stays reviewable on the timeline. */
  fleetRemove(laneId: string, force?: boolean): Promise<{ ok: boolean; reason?: string } | null>;
  fleetSetModel(laneId: string, model: string): Promise<{ ok: boolean; model?: string; reason?: string } | null>;
  // -- P-FLEET.L8: promote a lane into the MAIN composer, and pull it back --------------------------
  /** Attach the main composer to this lane. The lane's omp child, session, cwd, and model are untouched,
   *  so this works MID-TURN. Returns the lane plus its bounded transcript to seed the thread with. */
  fleetPromote(laneId: string): Promise<{ ok: boolean; lane?: LaneView; transcript?: { role: "user" | "assistant"; text: string }[]; reason?: string } | null>;
  /** Release the composer back to the master session. Idempotent; laneId omitted demotes whichever lane
   *  currently holds it. */
  fleetDemote(laneId?: string): Promise<{ ok: boolean; lane?: LaneView } | null>;
  fleetPromoted(): Promise<{ lane: LaneView | null } | null>;
  /** FOLLOW a lane's live events WITHOUT owning a turn. Resolves when the stream ends; call the returned
   *  aborter to leave. This is what lets a promote join a turn that is already running. */
  fleetWatch(laneId: string, onEvent: (e: LaneEvent) => void): { done: Promise<void>; stop: () => void };
  fleetTranscript(laneId: string): Promise<{ turns: { role: "user" | "assistant"; text: string }[] } | null>;
  // -- P-HEALTH.1: the harness's self-watch ---------------------------------------------------------
  /** Read-only: where the stall ladder stands for the master session and every lane. Takes no action. */
  health(): Promise<{
    master: { action: string; silentMs: number; reason: string; pending: { label: string; elapsedMs: number }[]; last: { action: string; reason: string; at: number } | null };
    lanes: { laneId: string; action: string; silentMs: number; reason: string; openCalls: { label: string; elapsedMs: number }[] }[];
  } | null>;
  /** Force one ladder step now instead of waiting for the next tick. */
  healthTick(): Promise<{ master: { action: string; reason: string } | null; lanes: { laneId: string; action: string; reason: string }[] } | null>;
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
  // P-KGPACK.2 (ADR-0205): the named-KG picker. list = all KGs + active; create/rename/activate return the
  // refreshed list (with an optional `error` on validation failure). The graph view (kbGraph) reads the
  // ACTIVE KG, so activate + re-fetch shows a different graph.
  kbList(): Promise<KgListView | null>;
  kbCreate(name: string): Promise<KgListView | null>;
  kbRename(kgId: string, name: string): Promise<KgListView | null>;
  kbActivate(kgId: string): Promise<KgListView | null>;
  // P-KGPACK.3 (ADR-0205): seed a KG from a folder. `name` creates + names a new KG at ingest; otherwise
  // `kgId` (or the active KG) receives the documents. Gated fail-closed server-side.
  kbIngestBatch(input: { path: string; name?: string; kgId?: string }): Promise<KbIngestStartView | null>;
  kbIngestStatus(jobId?: string): Promise<KbIngestJobView | null>;
  kbIngestCancel(jobId?: string): Promise<{ ok: boolean } | null>;
  // P-KGPACK.4 (ADR-0205): export a KG as a .lkgpack; import one (integrity + origin verified, re-scanned
  // fail-closed, installed read-only + untrusted).
  kbPackExport(input: { kgId: string; dest: string; author?: string; version?: string; role?: string; description?: string }): Promise<KbPackExportView | null>;
  kbPackImport(input: { path: string }): Promise<KbPackImportView | null>;
  // P-KGMARKET.4 (ADR-0206): download a signed .lkgpack.zip URL and install it through the gate (read-only).
  kbPackInstallFromUrl(url: string): Promise<KbPackImportView | null>;
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
  // P-GOVCUI.1: persist the first-run Government/CUI answer (so the gov onboarding step asks exactly once).
  setGovconCui(govconCui: boolean): Promise<ProfileSettings | null>;
  // P-THEME.1: persist the chosen app theme id ("" clears it back to following the OS preference).
  setTheme(theme: string): Promise<ProfileSettings | null>;
  // Enterprise-managed policy (read-only; placed by admins via GPO/MDM).
  managed(): Promise<ManagedPolicy | null>;
  // P-IDE.1c: China-origin model data-sovereignty acknowledgement gate.
  chinaAck(): Promise<{ acknowledged: boolean } | null>;
  setChinaAck(acknowledge: boolean): Promise<{ acknowledged: boolean } | null>;
  // Third-party / non-U.S. / custom "More providers" acknowledgement gate (mirrors chinaAck).
  thirdPartyAck(): Promise<{ acknowledged: boolean } | null>;
  setThirdPartyAck(acknowledge: boolean): Promise<{ acknowledged: boolean } | null>;
  // ADR-0219: per chat-session CUI vs Search mode (defaults to the ACTIVE session when no id is given).
  sessionMode(id?: string): Promise<{ id: string; mode: "cui" | "search" } | null>;
  setSessionMode(mode: "cui" | "search", id?: string): Promise<{ id: string; mode: "cui" | "search" } | null>;
  // ADR-0221: BYO-embeddings config for semantic knowledge search.
  embeddingsConfig(): Promise<{ config: EmbeddingsConfigView | null; active: boolean } | null>;
  setEmbeddingsConfig(config: EmbeddingsConfigView | null): Promise<{ config: EmbeddingsConfigView | null; active: boolean; error?: string } | null>;
  embeddingsTest(input: { baseUrl: string; model: string; authKind: string; headerName?: string; secret?: string }): Promise<{ ok: boolean; dim?: number; error?: string } | null>;
  embeddingsReindex(): Promise<{ ok: boolean; kgs?: number; pages?: number; stored?: number; error?: string } | null>;
  auth(): Promise<AuthStatus | null>;
  saveKey(env: string, key: string): Promise<AuthStatus | null>;
  oauthLogin(oauthId: string, promptAnswer?: string): Promise<{ started: boolean; url: string; output: string } | null>;
  oauthLogout(oauthId: string): Promise<AuthStatus | null>;
  /** Sign out of ALL OAuth providers at once (clears orphaned/unreachable logins too). Returns refreshed status. */
  oauthLogoutAll(): Promise<AuthStatus | null>;
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
  cloneWorkspace(url: string, pat?: string): Promise<WorkspaceInfo | null>; // pat: optional inline git token (ADR-0216)
  /** Remove one folder from the recents list (does NOT change the active workspace, so no respawn). */
  removeRecentWorkspace(path: string): Promise<WorkspaceInfo | null>;
  // P-WSSETUP: the workspace-initialization offer - profile the current folder, scaffold the
  // .agents framework, or record a dismissal so the popup never re-asks for this folder.
  workspaceSetupProfile(): Promise<WorkspaceProfile | null>;
  agentsInit(purpose: WorkspacePurpose, scan: boolean): Promise<AgentsInitResult | null>;
  workspaceSetupDismiss(): Promise<{ asked: boolean } | null>;
  /** Native OS folder dialog in Electron (null in a plain browser). `title`/`buttonLabel` let each
   *  caller label its own dialog, so every folder pick is the real Explorer/Finder window. */
  pickFolder(opts?: PickFolderOpts): Promise<string | null>;
  /** P-FS.2 (ADR-0265): native OS folder dialog via the LOCAL backend when the GUI runs in a plain
   *  browser (LucidAgentIDE.bat / lucid.exe + default browser). The server runs on the same machine
   *  (loopback bind), so it opens the real Explorer / Finder / zenity dialog itself. `supported:false`
   *  (or null: request failed) = fall back to the in-app browser; `supported:true, path:null` = the
   *  user CANCELLED, never re-prompt. */
  pickFolderNative(opts?: PickFolderOpts): Promise<NativePickResult | null>;
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
  // P-IMG.1 (ADR-0208): stage a chat image into the preview panel — writes a self-contained wrapper HTML and
  // returns its path (for onPreviewAvailable), or null if the image failed the strict gate.
  previewImage(dataUrl: string): Promise<{ path: string } | null>;
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
  // ── P-BROWSER.1 (wave 2): the agent-controlled visible browser window (BrowserFeature section) ──
  // Status feeds the floating browser pill; close is shared with the Processes popover's Close action.
  browserStatus(): Promise<BrowserStatusView | null>;
  // Latest capture as a data:image/png;base64 URL (null before the first shot) - the pill's auto
  // send-to-phone fetches it here rather than re-driving a capture.
  browserShot(): Promise<string | null>;
  browserClose(): Promise<void>;
  // Same close POST; the stop-the-turn half happens renderer-side (the pill calls stopTurn itself).
  browserStop(): Promise<void>;
  // P-TASK.5 (ADR-0180): live subagent activity behind the current session's delegation
  subagents(): Promise<{ runs: { name: string; done: boolean; lastAt: number; assignment: string; model: string | null; tools: number; steps: { kind: string; tool?: string; label: string }[] }[] } | null>;
  // P-SYSRES.1 (ADR-0182): system resource profile + guard verdict (types live in system_guard.ts)
  systemStatus(fresh?: boolean): Promise<SystemStatusView | null>;
  // CREATOR-0 (ADR-0279): this build's identity + which Creator surfaces exist. Null in an old backend.
  buildInfo(): Promise<BuildInfoView | null>;
  // CREATOR-0 (ADR-0283): normalized CPU/GPU/memory telemetry for the odometer rail (Creator build only).
  creatorResources(fresh?: boolean): Promise<CreatorResourcesView | null>;
  // CREATOR-0 (ADR-0282/0281): the integration registry + the local track library, in one payload.
  creatorStudio(): Promise<CreatorStudioView | null>;
  // CREATOR-0: mutate the library (import, review, remix, re-prompt, remove) and get the fresh view back.
  creatorLibrary(op: CreatorLibraryOp): Promise<{ ok: boolean; error?: string; view: CreatorStudioView | null }>;
  // CREATOR-0: playable bytes for one track (base64 + mime, like the TTS path).
  creatorTrackAudio(id: string): Promise<{ audioB64: string; mime: string; title: string } | null>;
  // CREATOR-0: save or remove one endpoint declaration. Refused server-side when it is not well formed.
  creatorEndpoint(input: { endpoint?: Record<string, unknown>; remove?: string }): Promise<{ ok: boolean; error?: string }>;
  // CREATOR-0: save or remove a remote monitoring target (a DGX Spark, a GPU VM).
  creatorTarget(input: { target?: Record<string, unknown>; remove?: string }): Promise<{ ok: boolean; error?: string }>;
  // CREATOR-1 (ADR-0292): probe one provider (or all) and get the refreshed registry + job list back.
  creatorProbe(providerId?: string): Promise<{ ok: boolean; error?: string; registry: CreatorStudioView | null }>;
  // CREATOR-1: request a stop. The job settles only when its runner confirms.
  creatorCancelJob(id: string): Promise<{ ok: boolean; error?: string }>;
  // CREATOR-IMG (ADR-0291): the model dropdown - a LIVE probe of the configured image server.
  creatorModels(): Promise<{ models: CreatorModelView[]; endpoint: string; note: string } | null>;
  // CREATOR-IMG: generate through the user's own workflow template, mixing prompt + named input images.
  creatorGenerateImage(input: CreatorGenerateInput): Promise<{ ok: boolean; error?: string; produced?: CreatorArtifactView[] }>;
  // CREATOR-IMG: the artifact grid, and one artifact's bytes as a data URL (inline display + preview).
  creatorArtifacts(): Promise<CreatorArtifactView[] | null>;
  creatorArtifactData(id: string): Promise<{ artifact: CreatorArtifactView; dataUrl: string } | null>;
  // CREATOR-IMG: store a renderer-encoded PNG (a meme, a markup export) with its provenance.
  creatorStoreArtifact(input: { kind: string; dataUrl: string; width: number; height: number; source: string; prompt?: string; model?: string }): Promise<{ ok: boolean; error?: string; artifact?: CreatorArtifactView }>;
  // CREATOR-IMG: the provider-free builders - a sprite sheet PNG plus sidecars, and an animated GIF.
  creatorBuildSheet(input: { frames: WireFrameView[]; name?: string; columns?: number; durationMs?: number }): Promise<{ ok: boolean; error?: string; artifact?: CreatorArtifactView; css?: string; manifest?: string }>;
  creatorBuildGif(input: { frames: WireFrameView[]; delayMs?: number | number[]; loop?: number }): Promise<{ ok: boolean; error?: string; artifact?: CreatorArtifactView }>;
  // CREATOR-2 (ADR-0286): open ONE track as an editable timeline (document + audio + waveform + the
  // alignment provenance note), and save the rendered edit back as a new library track. Everything
  // between those two calls happens in the renderer against the pure core - the server never sees a
  // half-finished edit.
  creatorEditorOpen(opts: { trackId: string; text?: string; buckets?: number }): Promise<{ ok: boolean; error?: string; session?: EditorSession } | null>;
  creatorEditorSave(opts: { trackId: string; doc: TimelineDoc; title: string; prompt?: string }): Promise<{ ok: boolean; error?: string; trackId?: string } | null>;
  // CREATOR-5 (ADR-0289): the mixer touches the server exactly twice - once to LIST which library tracks
  // can play together (plus the format the mix will run at, which the pane never guesses), once to
  // RENDER. Every level, pan, fade, and ramp in between is applied in the renderer against the same pure
  // core the render uses, so a control move is instant and no half-built graph ever crosses the wire.
  creatorMixerTracks(): Promise<MixerTracksPayload | null>;
  creatorMixerRender(opts: { graph: MixGraph; title: string; prompt?: string; primaryTrackId: string; applyHeadroom?: boolean }): Promise<RenderMixResult | null>;
  // CREATOR-3 (ADR-0287): a video or 3D render. Fail-closed at the boundary as well as at the server: a run
  // payload this build cannot read becomes a named refusal rather than a half-painted report, because the
  // pane's whole job is to say what was PROVEN and a malformed run proves nothing.
  creatorRender(opts: { kind: string; prompt: string; model?: string; negative?: string; seed?: number; width?: number; height?: number; workflow?: string; maxArtifacts?: number }):
    Promise<{ ok: boolean; error?: string; run?: PipelineRunView } | null>;
  listDir(path?: string): Promise<FsList | null>; // in-app folder browser (works everywhere)
  revealPath(path: string): Promise<boolean>; // open a folder in the OS file manager (Electron only; false in browser)
  canRevealPath(): boolean; // whether the native shell can reveal a folder (Electron only)
  showInFolder(path: string): Promise<boolean>; // P-FSREVEAL.1: reveal a FILE highlighted in its parent folder (Electron only; false in browser)
  canShowInFolder(): boolean; // whether the native shell can reveal a file in its folder (Electron only)
  openExternal(url: string): Promise<boolean>; // open an http(s) URL in the OS browser (OAuth); false in browser → caller falls back to window.open
  // P-INTERJECT.1/.2 (wave 2): mid-turn operator interjection - queue a note the running turn's agent
  // reads at its next tool boundary (target "master" or a laneId; the server enforces trim, the 4000-char
  // limit, and the 8-note-per-target cap). Resolves the pending count, or null on refusal/transport failure.
  interject(target: string, text: string): Promise<{ pending: number } | null>;
  // P-INTERJECT.1: everything running right now - master turn, live lanes, import job, agent browsers.
  processes(): Promise<ProcessView[] | null>;
}

/** Non-secret metadata about a vault credential (P-NETWL.1, ADR-0106). No plaintext ever crosses this line;
 *  `last4` (P-KEYS.1, ADR-0107) is at most the last 4 chars, to identify a key without revealing it. */
export interface CredMetaView { ref: string; kind: string; label?: string; last4?: string; createdAt?: number; rotatedAt?: number; expiresAt?: number; rotationIntervalDays?: number }
// ADR-0221: BYO-embeddings config (non-secret; the key lives in the vault behind vaultRef).
export interface EmbeddingsConfigView { enabled: boolean; baseUrl: string; model: string; dim: number; authKind: "none" | "bearer" | "apikey"; headerName?: string; vaultRef?: string }

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
  pickFolder?(opts?: PickFolderOpts): Promise<string | null>;
  capturePreview?(rect: { x: number; y: number; width: number; height: number }): Promise<string | null>;
  openExternal?(url: string): Promise<boolean>;
  revealPath?(path: string): Promise<boolean>;
  showInFolder?(path: string): Promise<boolean>; // P-FSREVEAL.1: reveal a file highlighted in its parent folder
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
//
// P-MODEL.2: this list is what the picker shows during a cold boot, BEFORE the live config lands, so it
// is the "default model" the user actually sees and reports. It went stale at Opus 4.8 / Sonnet 4.6 /
// Haiku 4.5, which is precisely the "why does it keep defaulting to Claude 4.8 Opus" complaint: the real
// resolver (startup_model.ts) was already picking correctly, but this placeholder was painted first and
// often outlived the wait. It is deliberately a SHORT, current, ANTHROPIC-only list: the fallback exists
// for the offline case, and a long speculative catalog here would show models the user may not have.
// Keep the head in sync with model_families.DEFAULT_MODEL_PREFERENCE when a new flagship ships.
const FALLBACK_CONFIG: ConfigOption[] = [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "anthropic/claude-opus-5", options: [
    { value: "anthropic/claude-opus-5", name: "Claude Opus 5" }, { value: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" }, { value: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
  { id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: "high", options: [
    { value: "off", name: "Off" }, { value: "auto", name: "Auto" }, { value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "xhigh", name: "X-High" },
  ] },
];

// Generic NDJSON event stream (used by both /api/chat and the /api/goal loop). `signal` lets Stop abort
// the CLIENT read so the turn settles even if the server/omp never closes the stream (a wedged turn).
async function streamNdjson(path: string, body: unknown, onEvent: (e: ChatEvent) => void, signal?: AbortSignal, opts?: { tail?: boolean }): Promise<void> {
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
  // Did the turn end on its OWN terms? Only a terminal event seen on the wire proves that; anything else
  // ending this stream is a drop, and the server turn is probably still running (see stream_end.ts).
  let terminalDone = false;
  // TWO different faults, so TWO separate guards. A torn line is bad JSON and is skipped. A throw out of
  // onEvent is a RENDER bug, and the old single `catch {}` swallowed it as if it were bad JSON - so a
  // renderer exception silently ate an event with nothing logged. Neither fault may kill the read: one
  // unrenderable event must never cost the user the REST of the turn.
  const flush = (line: string) => {
    const s = line.trim();
    if (!s) return;
    let parsed: unknown;
    try { parsed = JSON.parse(s); }
    catch { return; } // a truncated/partial line, not a turn failure
    if (!parsed || typeof parsed !== "object" || !("type" in parsed) || typeof parsed.type !== "string") return;
    if (parsed.type === "ping") return; // server heartbeat: keeps the socket alive through long tool calls
    // `done`, but ALSO a fleet lane's terminal `error` - a turn that reported its own failure has explained
    // itself and must not get a "connection dropped" line stacked on top of it.
    if (TERMINAL_EVENT_TYPES[parsed.type]) terminalDone = true;
    // Narrowed above to an object with a string `type`. The payload fields are the engine's own ChatEvent
    // contract (same module, same process family), so this is the ONE documented boundary assertion.
    const ev = parsed as ChatEvent;
    try { onEvent(ev); }
    catch (e) { console.error("[TURN_DIAG] a chat event handler threw; the stream continues", e); }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) { flush(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    flush(buf);
  } catch { /* Stop aborted the read, or the socket died mid-turn - classified below, never silent. */ }
  // The reported bug: this used to end here. A mid-stream death left the composer frozen on the last event
  // it happened to receive - no error, no settle - while the engine kept working, so the only way to see
  // what the agent did was to stop the session and reopen it. Now an unaborted end with no terminal `done`
  // announces itself and settles the turn. A tail stream (fleet lane watch) opts out: it has no `done`.
  for (const ev of streamEndEvents({ aborted: !!signal?.aborted, terminalDone, tail: opts?.tail }).events) onEvent(ev);
}
// Stop must always recover the UI: aborting this controller ends the client read immediately, so the
// turn's finally runs even when omp is wedged. cancelChat() aborts it AND posts the server cancel.
let chatAbort: AbortController | null = null;
const streamChat = (text: string, onEvent: (e: ChatEvent) => void, images?: { data: string; mimeType: string }[], from?: string, share?: { view: number; edit: number }) => {
  chatAbort?.abort();
  chatAbort = new AbortController();
  // P-COLLAB.15: `from` attributes a guest-driven turn in the live collab broadcast (omitted for host turns).
  // P-PREVIEW-PWA.3: `share` carries direct-P2P roster COUNTS for the agent-awareness preamble.
  return streamNdjson("/api/chat", { text, ...(images?.length ? { images } : {}), ...(from ? { from } : {}), ...(share ? { share } : {}) }, onEvent, chatAbort.signal).finally(() => { chatAbort = null; });
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
  securityDismissAll: () => post("/api/security/dismiss-all", {}),
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
  voices: (provider) => getData(provider ? `/api/voices?provider=${encodeURIComponent(provider)}` : "/api/voices"),
  transcribe: (audioB64, mime, language) => post("/api/transcribe", { audioB64, mime, language }),
  whisperStatus: () => getData("/api/whisper/status"),
  whisperInstall: (tier) => post("/api/whisper/install", { tier }),
  whisperStart: (tier) => post("/api/whisper/start", { tier }),
  whisperStop: () => post("/api/whisper/stop", {}),
  whisperRemove: (tier) => post("/api/whisper/remove", { tier }), // P-STT.6 (ADR-0267)
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
  chosenModel: async () => (await getData("/api/model/chosen")) ?? "",
  setChosenModel: (value) => post("/api/model/chosen", { value }),
  lastModel: async () => (await getData("/api/model/last")) ?? "", // P-MODEL.2
  modes: () => getData("/api/modes"),
  setMode: (modeId) => post("/api/modes", { modeId }),
  setUiMode: (uiMode) => post("/api/uimode", { uiMode }),
  respondPermission: (id, optionId) => post("/api/chat/permission", { id, optionId }),
  cancelChat: () => { chatAbort?.abort(); return post("/api/chat/cancel", {}); },
  cancelGoal: () => post("/api/goal/cancel", {}),
  // P-FLEET.L1: the fleet grid's lane API. The prompt stream reuses the chat NDJSON reader.
  fleetStatus: () => getData("/api/fleet/status"),
  fleetSpawn: (opts) => post("/api/fleet/spawn", opts),
  timelineList: (limit = 100, offset = 0, includeSelfTest = false) => getData(`/api/timeline?limit=${limit}&offset=${offset}${includeSelfTest ? "&selfTest=1" : ""}`), // P-FLEET.L5
  timelineSession: (id, limit = 40) => post("/api/timeline/session", { id, limit }), // P-FLEET.L5
  fleetPrompt: (laneId, text, onEvent, images) => {
    // The lane stream carries LaneEvent lines; the reader's own fallback events (token/done) are
    // structurally valid LaneEvents too, so the sink types unify at this one boundary. Named cast per
    // house rule: structurally-compatible tagged unions the reader's ChatEvent signature can't express.
    const sink = onEvent as (e: ChatEvent) => void;
    return streamNdjson("/api/fleet/prompt", { laneId, text, ...(images?.length ? { images } : {}) }, sink);
  },
  fleetQueueAdd: (laneId, text, images) => post("/api/fleet/queue", { laneId, text, ...(images?.length ? { images } : {}) }),
  fleetQueueRemove: (laneId, index) => post("/api/fleet/queue/remove", { laneId, index }),
  fleetQueueMove: (laneId, index, dir) => post("/api/fleet/queue/move", { laneId, index, dir }),
  fleetDrain: (laneId, onEvent) => {
    const sink = onEvent as (e: ChatEvent) => void; // same tagged-union unification as fleetPrompt
    return streamNdjson("/api/fleet/drain", { laneId }, sink);
  },
  fleetRetry: (laneId, onEvent) => {
    const sink = onEvent as (e: ChatEvent) => void; // same tagged-union unification as fleetPrompt
    return streamNdjson("/api/fleet/retry", { laneId }, sink);
  },
  fleetRespawn: (laneId) => post("/api/fleet/respawn", { laneId }),
  fleetAnswer: (laneId, allow, scope) => post("/api/fleet/answer", { laneId, allow, ...(scope ? { scope } : {}) }),
  fleetAuto: (opts) => post("/api/fleet/auto", opts),
  fleetCancel: (laneId) => post("/api/fleet/cancel", { laneId }),
  fleetStop: (laneId) => post("/api/fleet/stop", { laneId }),
  fleetRemove: (laneId, force) => post("/api/fleet/remove", { laneId, ...(force ? { force: true } : {}) }),
  fleetSetModel: (laneId, model) => post("/api/fleet/model", { laneId, model }),
  // P-FLEET.L8: promote/demote is a pure ATTACH: no process churn, so it is safe mid-turn.
  fleetPromote: (laneId) => post("/api/fleet/promote", { laneId }),
  fleetDemote: (laneId) => post("/api/fleet/demote", laneId ? { laneId } : {}),
  fleetPromoted: () => getData("/api/fleet/promoted"),
  fleetWatch: (laneId, onEvent) => {
    // A watcher owns NO turn, so it gets its own AbortController rather than sharing the chat one:
    // aborting the chat stream must never silently unsubscribe the composer from the lane it is
    // attached to, and leaving a lane must never abort a running turn.
    const ac = new AbortController();
    const sink = onEvent as (e: ChatEvent) => void; // same tagged-union unification as fleetPrompt
    // `tail`: a lane WATCH is a live tail the server closes on release with no terminal `done` - a clean
    // close is its normal end, so it must not synthesize the dropped-turn notice into every lane.
    const done = streamNdjson("/api/fleet/watch", { laneId }, sink, ac.signal, { tail: true });
    return { done, stop: () => ac.abort() };
  },
  fleetTranscript: (laneId) => getData(`/api/fleet/transcript?laneId=${encodeURIComponent(laneId)}`),
  // P-HEALTH.1. NOT `/api/health`: that path is the ADR-0305 port-guard nonce probe, deliberately
  // unauthenticated and registered first, so it would shadow this and leak session telemetry ungated.
  health: () => getData("/api/session-health"),
  healthTick: () => post("/api/session-health/tick", {}),
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
  kbList: () => getData("/api/kb/list"),
  kbCreate: (name) => post("/api/kb/create", { name }),
  kbRename: (kgId, name) => post("/api/kb/rename", { kgId, name }),
  kbActivate: (kgId) => post("/api/kb/activate", { kgId }),
  kbIngestBatch: (input) => post("/api/kb/ingest-batch", input),
  kbIngestStatus: (jobId) => getData(`/api/kb/ingest-batch/status${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ""}`),
  kbIngestCancel: (jobId) => post("/api/kb/ingest-batch/cancel", { jobId }),
  kbPackExport: (input) => post("/api/kb/pack/export", input),
  kbPackImport: (input) => post("/api/kb/pack/import", input),
  kbPackInstallFromUrl: (url) => post("/api/kb/pack/install-from-url", { url }),
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
      const r = await fetch("/api/collab/start", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ allowEdit: !!opts?.allowEdit, favModels: opts?.favModels ?? [] }) });
      const j = await r.json();
      return j?.ok ? { ok: true, status: j.data as CollabShareStatus } : { ok: false, error: String(j?.error ?? `backend error ${r.status}`) };
    } catch (e) { return { ok: false, error: String((e as Error)?.message ?? "backend unreachable") }; }
  },
  collabStop: () => post("/api/collab/stop", {}),
  collabGuestInbox: () => getData("/api/collab/guest-inbox"),
  collabGuestSendPrompt: async (text, images) => {
    try {
      const r = await fetch("/api/collab/guest-prompt", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ text, ...(images?.length ? { images } : {}) }) });
      const j = await r.json();
      return j?.ok ? { ok: true } : { ok: false, error: String(j?.error ?? `backend error ${r.status}`) };
    } catch (e) { return { ok: false, error: String((e as Error)?.message ?? "backend unreachable") }; }
  },
  collabGuestAbort: () => post("/api/collab/guest-abort", {}),
  collabGuestSetModel: async (value) => {
    try {
      const r = await fetch("/api/collab/guest-model", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ value }) });
      const j = await r.json();
      return j?.ok ? { ok: true } : { ok: false, error: String(j?.error ?? `backend error ${r.status}`) };
    } catch (e) { return { ok: false, error: String((e as Error)?.message ?? "backend unreachable") }; }
  },
  collabGuestSetWorkspace: async (id) => {
    try {
      const r = await fetch("/api/collab/guest-workspace", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ id }) });
      const j = await r.json();
      return j?.ok ? { ok: true } : { ok: false, error: String(j?.error ?? `backend error ${r.status}`) };
    } catch (e) { return { ok: false, error: String((e as Error)?.message ?? "backend unreachable") }; }
  },
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
  collabP2PConfig: () => getData("/api/collab/p2p"),
  collabSetP2P: (patch) => post("/api/collab/p2p", patch),
  collabPushToken: (idToken, expiresAt) => post("/api/collab/token", { idToken, expiresAt }),
  collabBroadcastPreview: (image, label) => post("/api/collab/preview", { image, ...(label ? { label } : {}) }),
  collabAuthorizeConnect: async (endpoint) => {
    try {
      const r = await fetch("/api/collab/authorize-connect", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ endpoint }) });
      const j = await r.json();
      return j?.ok ? { ok: true } : { ok: false, error: String(j?.error ?? `backend error ${r.status}`) };
    } catch (e) { return { ok: false, error: String((e as Error)?.message ?? "backend unreachable") }; }
  },
  collabAudit: (action, meta) => {
    // fire-and-forget; a failed audit write must never affect the share
    void fetch("/api/collab/audit", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ action, meta }) }).catch(() => {});
  },
  getSettings: () => getData("/api/settings"),
  saveUsername: (username) => post("/api/settings", { username }),
  saveProfile: (p) => post("/api/settings", p),
  skipEmail: () => post("/api/settings", { skip: true }),
  saveRole: (role) => post("/api/settings", { role }),
  setTourSeen: (seen) => post("/api/settings", { tourSeen: seen }),
  setGovconCui: (govconCui) => post("/api/settings", { govconCui }),
  setTheme: (theme) => post("/api/settings", { theme }), // P-THEME.1
  managed: () => getData("/api/managed"),
  chinaAck: () => getData("/api/china-ack"),
  setChinaAck: (acknowledge) => post("/api/china-ack", { acknowledge }),
  thirdPartyAck: () => getData("/api/thirdparty-ack"),
  setThirdPartyAck: (acknowledge) => post("/api/thirdparty-ack", { acknowledge }),
  sessionMode: (id) => getData(id ? `/api/session-mode?id=${encodeURIComponent(id)}` : "/api/session-mode"), // ADR-0219
  setSessionMode: (mode, id) => post("/api/session-mode", { mode, ...(id ? { id } : {}) }),
  embeddingsConfig: () => getData("/api/embeddings-config"), // ADR-0221
  setEmbeddingsConfig: (config) => post("/api/embeddings-config", { config }),
  embeddingsTest: (input) => post("/api/embeddings/test", input),
  embeddingsReindex: () => post("/api/embeddings/reindex", {}),
  auth: () => getData("/api/auth"),
  saveKey: (env, key) => post("/api/auth/key", { env, key }),
  oauthLogin: (oauthId, promptAnswer?: string) => post("/api/auth/oauth", { oauthId, promptAnswer }),
  oauthLogout: (oauthId) => post("/api/auth/logout", { oauthId }),
  oauthLogoutAll: () => post("/api/auth/logout-all", {}),
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
  cloneWorkspace: (url, pat) => post("/api/workspace/clone", { url, ...(pat ? { pat } : {}) }),
  removeRecentWorkspace: (path) => post("/api/workspace/recent-remove", { path }),
  workspaceSetupProfile: () => getData("/api/workspace/setup-profile"), // P-WSSETUP
  agentsInit: (purpose, scan) => post("/api/workspace/agents-init", { purpose, scan }), // P-WSSETUP
  workspaceSetupDismiss: () => post("/api/workspace/setup-dismiss", {}), // P-WSSETUP
  pickFolder: (opts) => (shell?.pickFolder ? shell.pickFolder(opts) : Promise.resolve(null)),
  pickFolderNative: (opts) => post("/api/fs/pickfolder", opts ?? {}), // P-FS.2 (ADR-0265)
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
  // P-PREVIEW.4b. The `v` nonce makes every deliberate load a FRESH navigation: assigning an iframe src
  // its current value does not renavigate in Chromium, so without it a re-open (or a re-edit of the same
  // file) kept showing the previously served document forever, no matter what was on disk. The server
  // ignores `v`; the response is already no-store, the nonce only defeats the same-URL no-op.
  previewServeUrl: (path) => `/api/preview/serve?path=${encodeURIComponent(path)}${TOKEN ? `&t=${encodeURIComponent(TOKEN)}` : ""}&v=${Date.now().toString(36)}`,
  previewImage: (dataUrl) => post("/api/preview/image", { dataUrl }) as Promise<{ path: string } | null>, // P-IMG.1 (ADR-0208)
  cachePreviewShot: async (png) => { await post("/api/preview/shot-cache", { png }); }, // P-PREVIEW.3a-shot
  previewInspectNext: () => getData("/api/preview/inspect/next"), // P-PREVIEW.6b
  previewInspectResult: async (id, result) => { await post("/api/preview/inspect/result", { id, result }); }, // P-PREVIEW.6b
  previewElectronDetect: (path) => getData(`/api/preview/electron-detect?path=${encodeURIComponent(path)}`), // P-PREVIEW.7
  previewElectronLaunch: (path) => post("/api/preview/electron-launch", { path }), // P-PREVIEW.7
  // ── P-BROWSER.1 (wave 2): the agent-controlled visible browser window (BrowserFeature section) ──
  browserStatus: async () => { // fail-open null: a malformed/missing status just hides the pill
    const v: unknown = await getData("/api/browser/status");
    if (!v || typeof v !== "object" || !("active" in v)) return null;
    const s = v as Partial<BrowserStatusView>; // safe view: presence-checked object; fields re-defaulted below
    return { active: s.active === true, title: typeof s.title === "string" ? s.title : "", url: typeof s.url === "string" ? s.url : "", startedAt: typeof s.startedAt === "number" ? s.startedAt : null, shots: typeof s.shots === "number" ? s.shots : 0 };
  },
  browserShot: async () => { const d: unknown = await getData("/api/browser/shot"); return d && typeof d === "object" && "png" in d && typeof d.png === "string" ? d.png : null; },
  browserClose: async () => { await post("/api/browser/close", {}); },
  browserStop: async () => { await post("/api/browser/close", {}); }, // the turn-stop half is renderer-side
  subagents: () => getData("/api/subagents"), // P-TASK.5
  systemStatus: async (fresh) => { // P-SYSRES.1: fail-open - malformed/missing reads as null (never blocks)
    const v: unknown = await getData(`/api/system${fresh ? "?fresh=1" : ""}`).catch(() => null);
    return isSystemStatus(v) ? v : null;
  },
  // CREATOR-0 (ADR-0279): identity + feature reveal. A null (old backend, failed call) means NO Creator
  // surface renders - absent, never a greyed hint.
  buildInfo: async () => {
    const v: unknown = await getData("/api/build-info").catch(() => null);
    const o = v as BuildInfoView | null;
    return o && typeof o.creatorBuild === "boolean" && !!o.features ? o : null;
  },
  creatorResources: async (fresh) => {
    const v: unknown = await getData(`/api/creator/resources${fresh ? "?fresh=1" : ""}`).catch(() => null);
    return isCreatorResources(v) ? v : null;
  },
  creatorStudio: async () => {
    const v: unknown = await getData("/api/creator/registry").catch(() => null);
    return isCreatorStudio(v) ? v : null;
  },
  creatorLibrary: async (op) => {
    try {
      const res = await fetch("/api/creator/library", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(op) });
      const body = await res.json() as { ok?: boolean; error?: string; data?: unknown };
      return { ok: !!body.ok, error: body.error, view: isCreatorStudio(body.data) ? body.data : null };
    } catch { return { ok: false, error: "The Creator library did not answer.", view: null }; }
  },
  creatorTrackAudio: async (id) => {
    const v = await getData(`/api/creator/track?id=${encodeURIComponent(id)}`).catch(() => null) as { audioB64?: unknown; mime?: unknown; title?: unknown } | null;
    return v && typeof v.audioB64 === "string" && typeof v.mime === "string"
      ? { audioB64: v.audioB64, mime: v.mime, title: typeof v.title === "string" ? v.title : "" }
      : null;
  },
  creatorEndpoint: async (input) => {
    try {
      const res = await fetch("/api/creator/endpoint", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(input) });
      const body = await res.json() as { ok?: boolean; error?: string };
      return { ok: !!body.ok, error: body.error };
    } catch { return { ok: false, error: "The Creator registry did not answer." }; }
  },
  creatorTarget: async (input) => {
    try {
      const res = await fetch("/api/creator/target", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(input) });
      const body = await res.json() as { ok?: boolean; error?: string };
      return { ok: !!body.ok, error: body.error };
    } catch { return { ok: false, error: "The Creator monitor did not answer." }; }
  },
  // CREATOR-1 (ADR-0292): capability probes + job control.
  creatorProbe: async (providerId) => {
    try {
      const res = await fetch("/api/creator/probe", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(providerId ? { providerId } : {}) });
      const body = await res.json() as { ok?: boolean; error?: string; data?: { registry?: unknown } };
      const registry = body.data?.registry;
      return { ok: !!body.ok, error: body.error, registry: isCreatorStudio(registry) ? registry : null };
    } catch { return { ok: false, error: "The probe service did not answer.", registry: null }; }
  },
  creatorCancelJob: async (id) => {
    try {
      const res = await fetch("/api/creator/jobs", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ cancel: id }) });
      const body = await res.json() as { ok?: boolean; error?: string };
      return { ok: !!body.ok, error: body.error };
    } catch { return { ok: false, error: "The job service did not answer." }; }
  },
  // CREATOR-IMG (ADR-0291): image generation, artifacts, and the provider-free builders.
  creatorModels: async () => {
    const v = await getData("/api/creator/models").catch(() => null) as { models?: unknown; endpoint?: unknown; note?: unknown } | null;
    return v && Array.isArray(v.models)
      ? { models: v.models as CreatorModelView[], endpoint: typeof v.endpoint === "string" ? v.endpoint : "", note: typeof v.note === "string" ? v.note : "" }
      : null;
  },
  creatorGenerateImage: async (input) => {
    try {
      const res = await fetch("/api/creator/image", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(input) });
      const body = await res.json() as { ok?: boolean; error?: string; data?: { produced?: CreatorArtifactView[] } };
      return { ok: !!body.ok, error: body.error, produced: body.data?.produced };
    } catch { return { ok: false, error: "The image service did not answer." }; }
  },
  creatorArtifacts: async () => {
    const v = await getData("/api/creator/artifacts").catch(() => null) as { artifacts?: unknown } | null;
    return v && Array.isArray(v.artifacts) ? v.artifacts as CreatorArtifactView[] : null;
  },
  creatorArtifactData: async (id) => {
    const v = await getData(`/api/creator/artifacts?id=${encodeURIComponent(id)}`).catch(() => null) as { artifact?: unknown; dataUrl?: unknown } | null;
    return v && typeof v.dataUrl === "string" && v.artifact ? { artifact: v.artifact as CreatorArtifactView, dataUrl: v.dataUrl } : null;
  },
  creatorStoreArtifact: async (input) => {
    try {
      const res = await fetch("/api/creator/artifact", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(input) });
      const body = await res.json() as { ok?: boolean; error?: string; data?: { artifact?: CreatorArtifactView } };
      return { ok: !!body.ok, error: body.error, artifact: body.data?.artifact };
    } catch { return { ok: false, error: "The image service did not answer." }; }
  },
  creatorBuildSheet: async (input) => {
    try {
      const res = await fetch("/api/creator/sheet", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(input) });
      const body = await res.json() as { ok?: boolean; error?: string; data?: { artifact?: CreatorArtifactView; css?: string; manifest?: string } };
      return { ok: !!body.ok, error: body.error, artifact: body.data?.artifact, css: body.data?.css, manifest: body.data?.manifest };
    } catch { return { ok: false, error: "The image service did not answer." }; }
  },
  creatorBuildGif: async (input) => {
    try {
      const res = await fetch("/api/creator/gif", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(input) });
      const body = await res.json() as { ok?: boolean; error?: string; data?: { artifact?: CreatorArtifactView } };
      return { ok: !!body.ok, error: body.error, artifact: body.data?.artifact };
    } catch { return { ok: false, error: "The image service did not answer." }; }
  },
  // CREATOR-2 (ADR-0286): the session payload carries audio bytes + peaks, so it is returned TOP-LEVEL
  // (never mirrored under `data` as well - that would double a multi-MB body). The shape gate keeps a
  // malformed answer from opening a half-document.
  creatorEditorOpen: async (opts) => {
    try {
      const res = await fetch("/api/creator/editor/open", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(opts) });
      const body = await res.json() as { ok?: boolean; error?: string; session?: unknown };
      if (!body.ok) return { ok: false, error: body.error };
      return isEditorSession(body.session)
        ? { ok: true, session: body.session }
        : { ok: false, error: "The editor answered with a session this build cannot read." };
    } catch { return { ok: false, error: "The audio editor did not answer." }; }
  },
  creatorEditorSave: async (opts) => {
    try {
      const res = await fetch("/api/creator/editor/save", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(opts) });
      const body = await res.json() as { ok?: boolean; error?: string; trackId?: string };
      return { ok: !!body.ok, error: body.error, trackId: body.trackId };
    } catch { return { ok: false, error: "The audio editor did not answer." }; }
  },
  // CREATOR-5 (ADR-0289): both gates are fail-closed. A tracks payload this build cannot read paints
  // NOTHING (null), rather than a mixer sitting on a format nobody reported; a report missing its own
  // measurements becomes a named refusal, rather than blanks where a peak and a clip count belong.
  creatorMixerTracks: async () => {
    const v: unknown = await getData("/api/creator/mixer/tracks").catch(() => null);
    return isMixerTracksPayload(v) ? v : null;
  },
  creatorMixerRender: async (opts) => {
    try {
      const res = await fetch("/api/creator/mixer/render", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(opts) });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!body.ok) return { ok: false, error: body.error ?? "The mixer refused the render and did not say why." };
      return isRenderMixReport(body) ? body : { ok: false, error: "The mixer answered with a report this build cannot read." };
    } catch { return { ok: false, error: "The mixer did not answer." }; }
  },
  creatorRender: async (opts) => {
    try {
      const res = await fetch("/api/creator/render", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(opts) });
      const body = await res.json() as { ok?: boolean; error?: string; data?: { run?: unknown } };
      // A refusal that never reached the pipeline (no endpoint, no template) carries no run object at all,
      // so the error stands on its own; a run that came back malformed is refused rather than painted.
      if (!isPipelineRunView(body.data?.run)) return { ok: false, error: body.error ?? "The render service answered with a run this build cannot read." };
      return { ok: !!body.ok, error: body.error, run: body.data.run };
    } catch { return { ok: false, error: "The render service did not answer." }; }
  },
  // P-INTERJECT.1/.2 (wave 2, TurnControls section): mid-turn interjects + the unified Processes list.
  interject: (target, text) => post("/api/interject", { target, text }),
  processes: async () => { const d = await getData("/api/processes"); return Array.isArray((d as { processes?: unknown } | null)?.processes) ? (d as { processes: ProcessView[] }).processes : null; },
  listDir: (path) => getData(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  revealPath: (path) => (shell?.revealPath ? shell.revealPath(path) : Promise.resolve(false)),
  canRevealPath: () => !!shell?.revealPath,
  openExternal: (url) => (shell?.openExternal ? shell.openExternal(url) : Promise.resolve(false)),
  showInFolder: (path) => (shell?.showInFolder ? shell.showInFolder(path) : Promise.resolve(false)), // P-FSREVEAL.1 (ADR-0212)
  canShowInFolder: () => !!shell?.showInFolder,
  setZoom: (f) => {
    if (shell?.setZoom) { shell.setZoom(f); return; } // Electron: crisp native zoom
    // Browser: zoom #app and counter-scale its height so it still fills the viewport
    // exactly (so the layout reflows and the chat keeps its own scroll).
    const app = document.getElementById("app");
    if (app) { (app.style as any).zoom = String(f); app.style.height = `calc(100vh / ${f})`; }
  },
};
