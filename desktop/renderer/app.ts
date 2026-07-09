// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/app.ts - the LucidAgentIDE renderer.
//
// Assembles the shell (titlebar · rail · sidebar · chat · inspector · status),
// wires interaction, polls the live security/memory snapshots, and streams the
// agent turn. Same renderer in Electron (real omp ACP via window.lucid) and in
// the browser dev server (simulated). Pure DOM, no framework.

import { bridge, type AgentRunReply, type McpCatalogTool, type ChatEvent, type CollabShareStatus, type ConfigOption, type EvalReportTurn, type GoalDial, type MemorySnapshot, type OmpCommand, type ProviderAuth, type RestoredTurn, type SecuritySnapshot, type SessionInfo, type SessionList, type SkillInspectView, type SkillView, type UserRole, type WorkspaceInfo } from "./bridge.ts";
import { ROLE_META, USER_ROLE_LIST, coachHtml, roleDefaultTab, stepsForRole, type TourStep } from "./tour.ts";
import { modCombo, modSymbol } from "./platform.ts";
import { aiLocHasData } from "../ailoc_view.ts";
import { PREVIEW_ALLOW, PREVIEW_SANDBOX, canPreviewRemote, resolvePreview } from "../preview_resolve.ts";
import { roleIcon } from "./role_icons.ts";
import { providerHasApiKey, providerKeywords } from "./budget_gate.ts";
import { cachedSessions, cachedTranscript, setCachedSessions, setCachedTranscript, transcriptSig } from "./swr_cache.ts";
import { $, $$, accordion, el, fmtNum, gauge, spark, table, type Col } from "./dom.ts";
import { freshFindings, splitReviewed } from "./sec_review.ts"; // P-SECACK.1 (ADR-0170): reviewed rows leave the active view
import { installTextContextMenu } from "./ctxmenu.ts"; // P-SECACK.1 (ADR-0170): right-click clipboard menu
import { restoredTurnHtml } from "./steps_restore.ts"; // P-RESUME.1 (ADR-0171): resumed thinking/tool history
import { ageStr, esc, fmtUSD, goodColor, loadColor } from "./format.ts";
import { icon, piMark } from "./icons.ts";
import { aboutHtml, readmeMark } from "./about.ts";
import { createTriviaGame, isTriviaQuestion, triviaExplainHtml, triviaQuestionHtml, triviaVisible, type TriviaGame, type TriviaQuestion } from "./trivia.ts"; // P-TRIV.1 (ADR-0174)
import { bankForRole } from "./trivia_roles.ts"; // P-TRIV.2 (ADR-0175): role-aware banks
import { isIntelNewsItem, newsLineHtml } from "./trivia_news.ts"; // P-TRIV.3 (ADR-0176): the executive INTEL WIRE
import { sectionizeAnswer, shouldSectionize, type AnswerSection } from "./answer_sections.ts"; // P-CHAT.A (ADR-0188): settled-turn collapsible sections
import { interleaveChips, chipsInterleave, toolChip, type ToolMark, type ToolChip } from "./answer_chips.ts"; // P-CHAT.B (ADR-0189) + .B.1: inline tool-event chips (only when they interleave)
import { MARKET_PLUGINS, marketplaceHtml, marketRowsHtml } from "./marketplace.ts"; // P-MARKET.1 (ADR-0158)
import { toolfailGroupHtml, type ToolFailEntry } from "./toolfail_group.ts"; // P-TOOLFAIL.2 (ADR-0163)
import { APP_VERSION } from "../version.ts";
import { renderMarkdown } from "./markdown.ts";
import { type GraphHandle, kindLabel, mountGraph } from "./graph.ts";
import { addEdgeOptimistic, applyForget, chainPairs, matchNodes, removeEdgeOptimistic, resolveRelationLabel } from "./kg_ops.ts";
import { capGraph, graphOpts, pollDelay, watchPerfTier } from "./perf_tier.ts";
import { kgDataMenuHtml, kgViewActive, kgViewLabel, kgViewsMenuHtml } from "./kg_header.ts"; // P-KGUI.1/.2 (ADR-0184/0185)
import { TURN_PATIENCE_MS, slowPhaseLabel, slowToastCopy } from "./stall_notice.ts"; // P-STALL.1 (ADR-0186)
import { guardBlockedHtml, resourcePanelBodyHtml, resourcePanelHtml, type SystemStatusView } from "./system_guard.ts"; // P-SYSRES.1 (ADR-0182)
import type { KbGraphView, PersonalGraphData } from "./bridge.ts";
import { agentBuilderPanelHtml, specToGraphData, nodeEditorHtml, saveErrors, newCanvasSpec, runPanelHtml, secretsPanelHtml, agentInterviewPrompt, toolChipsHtml, trustBannerHtml, runApprovalHtml, runsPanelHtml, traceDetailHtml, schedulePanelHtml, historyPanelHtml, templatesPanelHtml } from "./agent_builder.ts"; // P-AGENT.2b/.4-live/.8/.9/.11a/.13/.14/.17
import type { TrustLabel } from "../../harness/contracts.ts"; // P-AGENT.9: imported-agent trust banner
import { localProvidersCardBody, draftFromForm } from "./local_providers_ui.ts"; // P-LOCAL.3 (ADR-0135): Settings → Local Providers
import { acceptAttachment, promptImageBlocks, thumbStripHtml, MAX_ATTACHMENT_BYTES, type Attachment } from "./composer_attachments.ts"; // P-VISION.1 (ADR-0136): pasted images
import type { AgentSpec, NodeKind } from "../../harness/agent/spec.ts"; // P-AGENT.2b
import { expandCommandBody, expandInlineCommands, slashTokenBeforeCaret, type UserCommand } from "../../harness/commands/spec.ts"; // P-CMD.1/.2: user "/" commands, body-wide
import { type Action, type ToastAction, attachRichTip, createPalette, initTooltips, popover, showToast } from "./ui.ts";
import { exportActionPlan } from "./kg_export.ts";
import { formatImportLine } from "./import_progress.ts";
import { ASKSAGE_FAMILY_ORDER, familyOf, filterModels, groupByFamily, isAuxiliaryModel, isChinaModel, isDeprecatedModel, isGovModel, sortGovFirstNewest } from "./model_families.ts";
import { FAVS_KEY, parseFavs, starredOf, toggleFav } from "./model_favorites.ts"; // P-FAV.1 (ADR-0165)
import { renderSandboxSection } from "./sandbox_panel.ts"; // P-SANDBOX.5 (ADR-0169)
import { INSTALLED_SKILLS, bumpSkillUsage, bundledSkillsByUsage, isSkillEnabled, setSkillEnabled, taskProforma } from "./skills.ts";
import { renderSkillInspect, renderSkillsDirectory, renderStudioCandidate, type SkillDirRow } from "./skills_dir.ts"; // P-SKILL.4 (ADR-0097) / P-SKILL.5 (ADR-0101)
import { skillKey, type SkillRoot, trustEnableable } from "../skills_gov.ts"; // P-SKILL.4 (ADR-0097)
import { CHECKER_TOKENS_PER_ITER, MAKER_TOKENS_PER_ITER, estimateGoalCost, estimateGoalTokens, formatTokens, formatUSD } from "../loop_estimate.ts";
import { speakable } from "../../harness/brief/engineering_update.ts"; // P-REPORT.7: make read-aloud text TTS-friendly
import { changeGraphSvg, schemaSvg, type ChangeGraph, type ModuleChange, type GraphEdge, type StoreChange } from "../../harness/brief/change_graph.ts"; // P-REPORT.8: report annex graphs
import { assumedCacheRate, priceFor } from "../model_pricing.ts";
import { closeIde, colorizeCode, guessLanguage, openIde, setIdeExclusivity, setIdeHooks } from "./ide_panel.ts";
import { lineDiff, diffStat, patchLineType, patchStat, type DiffRow } from "./linediff.ts";
// P-TPS.1 (ADR-0044): the shared output-token speedometer - same engine the omp
// terminal adapter uses. Drives the HUD's live "tok out · tok/s" readout from the
// streaming text/thinking deltas (output only; never the system prompt).
import { TokenSpeedEngine } from "../../harness/metrics/token_speed.ts";

type Tab = "security" | "memory" | "dev";
const state = {
  inspectorTab: "memory" as Tab, // ADR-0021: default to Memory; overridden to Security when active blocks exist
  lastPreviewablePath: "" as string, // P-PREVIEW.2 (ADR-0096): the agent's most recent browser-previewable write
  sidebarCollapsed: false,
  inspectorRail: false,
  model: "claude-opus-4-8",
  security: null as SecuritySnapshot | null,
  memory: null as MemorySnapshot | null,
  ledger: null as import("./bridge.ts").UsageLedger | null, // P10.2 cross-model usage ledger
  codeActivity: null as import("./bridge.ts").CodeActivity | null, // ADR-0030 P-CODE.1 git workspace diffstat
  config: [] as ConfigOption[],
  configCached: false, // P-IDE.1d: current config came from the local cache; live refresh pending
  uiMode: "agent" as "agent" | "ask" | "plan", // P-ACP.2/3: composer Plan/Ask/Agent (derived from backend)
  commands: [] as OmpCommand[],
  skills: [] as SkillView[], // P-SKILL.4 (ADR-0097): discovered skills, widened with root/trust/removable/scan verdict
  userCommands: [] as UserCommand[], // P-CMD.1: user-authored "/" slash commands (workspace .omp/commands/)
  activeSkill: null as { command: string; name: string } | null, // P-IDE.2: active bundled skill
  liveUsage: null as { used: number; size: number; cost: number } | null,
  username: "" as string, // the "You" label on your messages (Settings → Profile)
  email: "" as string, // corporate email - attribution identity (ADR-0030); prompted on first open
  attribution: null as import("./bridge.ts").ProfileSettings["attribution"] | null, // identity + source (email|workstation)
  budgetWarned: new Set<string>(), // provider budgets we've already warned about this window
  chatBg: { image: "", mode: "off" as "off" | "ambient" | "flashlight", opacity: 0.25 }, // P-APPEAR.1: personalized chat background
  codeGraphAgent: false, // P-KG-SYM.1: expose the code graph to the agent as a queryable tool
  workspace: null as WorkspaceInfo | null,
  asksage: null as { configured: boolean; base: string; only: boolean; limit: number; datasets: string[]; queryModel: string; persona: string } | null,
  asksageTokens: null as { used: number; remaining: number | null; limit: number } | null,
  chinaAck: false as boolean, // P-IDE.1c: user acknowledged the China-origin data-sovereignty warning (Settings unlock)
  thirdPartyAck: false as boolean, // user acknowledged the third-party / non-U.S. "More providers" warning
  auth: null as import("./bridge.ts").AuthStatus | null, // full provider-auth status (gateway/majors/others)
  persona: null as string | null, // active persona id (AskSage)
  personas: [] as { id: string; description: string }[],
  zoom: 1,
  settingsOpen: false,
  lastOk: 0,
  streaming: false,
  streamStartedAt: null as number | null, // P-TRIV.1 (ADR-0174): when the current turn began streaming - gates the Trivia Wire
  queued: null as string | null, // P-ACP.4: a prompt the user pre-staged while a turn was running
  lastPrompt: "" as string, // last user message - re-sent by an Approve & retry (ADR-0019 C)
  probedLimits: [] as import("./bridge.ts").ProbedLimit[], // P10.3 live API-key rate limits
  probeEnabled: false, // P10.3 opt-in state for the live rate-limit probe
  developerMode: false, // ADR-0009 Phase D
  dev: null as import("./bridge.ts").DevView | null, // ADR-0009 Phase D logs snapshot
  mcpServers: [] as import("./bridge.ts").McpServerStatus[], // P-MCP.1 (ADR-0020)
  agents: [] as import("./bridge.ts").RemoteAgentStatus[], // P-AGENTFW.2 (ADR-0149) remote ACP agent connections
  whitelist: [] as import("./bridge.ts").WhitelistEntryView[], // P-NETWL.2 (ADR-0106) curated network whitelist
  creds: [] as import("./bridge.ts").CredMetaView[], // P-KEYS.1 (ADR-0107) vault metadata (ref → kind/label/last4)
  localProviders: [] as import("../local_providers.ts").LocalProviderDef[], // P-LOCAL.3 (ADR-0135) self-hosted/custom LLM endpoints
  attachments: [] as Attachment[], // P-VISION.1 (ADR-0136) pasted/dropped images staged for the next message
  posture: { allowAll: true, allowWebSearch: true, managedLocked: false } as import("./bridge.ts").EgressPostureView, // P-NETWL.5 (ADR-0108)
  managed: null as import("./bridge.ts").ManagedPolicy | null, // ADR-0068 (P-ENT.1) enterprise locks
  userRole: null as UserRole | null, // ADR-0088 (P-ROLE.1): chosen role; null until onboarding picks one
  tourSeen: false, // ADR-0089 (P-ROLE.1b): first-run walkthrough already shown (finished or skipped)
};
const prettyModel = (v: string) => v.replace(/^anthropic\//, "");
// Strip the redundant "· AskSage Gov" / "· Gov" suffix from a model's display name
// (the gov origin is shown by a compact pill instead); shorten the technical id by
// dropping the asksage-<provider>/ prefix the name already conveys.
const cleanModelName = (name: string) => name.replace(/\s*·\s*(?:AskSage(?:\s+Gov)?|Gov)\s*$/i, "").trim() || name;
const shortModelId = (v: string) => v.replace(/^anthropic\//, "").replace(/^asksage-[a-z]+\//, "");
// Context-window sizes (tokens) per model, keyed by the SHORT id (provider prefix
// stripped). The source of truth for the status-bar + Memory-panel denominators:
// omp's reported usage `size` is unreliable for the AskSage gateway models (it reports
// 256k for a 1M Gemini), so we prefer this. Keep in sync with tools/memory_data.ts CTX_WINDOW.
const MODEL_CTX: Record<string, number> = {
  "claude-fable-5": 1_000_000, "claude-mythos-5": 1_000_000, "claude-opus-4-8": 1_000_000, "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000, "claude-sonnet-4-6": 1_000_000, "claude-sonnet-4-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "gpt-5.2": 256_000, "gpt-5.5": 256_000, "gpt-5.4": 256_000, "gpt-5.1": 256_000, "gpt-5": 256_000,
  "gpt-5-mini": 256_000, "gpt-4.1": 1_000_000, "gpt-o3": 200_000, "gpt-o3-mini": 200_000, "gpt-o4-mini": 200_000,
  "google-claude-45-opus": 200_000, "google-claude-45-sonnet": 200_000, "google-claude-45-haiku": 200_000,
  "google-claude-sonnet-5": 200_000, "google-claude-fable-5": 200_000,
  "google-claude-48-opus": 200_000, "google-claude-47-opus": 200_000, "google-claude-46-opus": 200_000, "google-claude-46-sonnet": 200_000,
  "aws-bedrock-claude-45-sonnet-gov": 200_000, "claude-opus-4": 200_000, "claude-sonnet-4": 200_000,
  "google-gemini-3.1-pro-com": 1_000_000, "google-gemini-3.5-flash-gov": 1_000_000,
  "google-gemini-2.5-pro": 1_000_000, "google-gemini-2.5-flash": 1_000_000,
  "rag": 256_000,
};
const modelCtx = (v: string): number | undefined => MODEL_CTX[shortModelId(v)];
// Friendly label for the CURRENTLY-selected model - resolve its name from config,
// falling back to the bare value before config has loaded.
function modelLabel(value: string): string {
  const opt = state.config.find((c) => c.id === "model")?.options.find((o) => o.value === value);
  return opt ? cleanModelName(opt.name) : prettyModel(value);
}
const OPEN = new Set<string>(["sec.quarantine", "sec.approvals", "mem.context", "mem.cache"]);
let lastInspHash = "";
let autoCollapsedSessions = false; // collapse the sessions panel once, on the first chat message

// ───────────────────────── shell ─────────────────────────
function buildShell(): void {
  $("#app")!.appendChild(el(`
  <div id="app-inner" style="display:contents">
    <div class="titlebar">
      <div class="brand"><span class="lucid-word">LUCID</span><span class="pi">${piMark}</span></div>
      <button class="model-badge" id="modelBadge" data-tip="Model · mode · thinking|Click to choose" data-tip-icon="spark">
        <span class="dot"></span><span id="modelName">${esc(modelLabel(state.model))}</span>${icon("chevron", 13)}
      </button>
      <!-- Persona + Skills live in the titlebar (full-width, so they don't squish when a right surface opens). -->
      <button class="ctool tb-chip" id="ctPersona" data-tip="AskSage persona|Server-supplied role guidance - scanned before use" hidden>${icon("user", 14)}<span id="ctPersonaName">Persona</span>${icon("chevron", 11)}</button>
      <button class="ctool tb-chip" id="ctSkill" data-tip="Skills|Built-in skills, /task delegation, and project skills" hidden>${icon("bolt", 14)}<span>Skills</span>${icon("chevron", 11)}</button>
      <div class="tb-spacer"></div>
      <div class="zoom" role="group" aria-label="Text zoom">
        <button id="zoomOut" data-tip="Zoom out|${modSymbol("−")}">${icon("minus", 13)}</button>
        <span class="lvl" id="zoomLvl" data-tip="Reset zoom|${modSymbol("0")}">100%</span>
        <button id="zoomIn" data-tip="Zoom in|${modSymbol("+")}">${icon("plus", 13)}</button>
      </div>
      <div class="win-ctrls">
        <button id="winMin" data-tip="Minimise">${icon("minus", 15)}</button>
        <button id="winMax" data-tip="Maximise">${icon("square", 13)}</button>
        <button id="winClose" class="close" data-tip="Close">${icon("close", 14)}</button>
      </div>
    </div>

    <div class="body">
      <nav class="rail">
        <button class="rail-btn" id="sideToggle" data-tip="Sessions panel|Show / hide" data-tip-side="right">${icon("sidebar", 20)}</button>
        <button class="rail-btn active" data-rail="chat" data-tip="Conversation" data-tip-icon="chat">${icon("chat", 20)}</button>
        <button class="rail-btn" data-rail="security" data-tip="Security|Findings, quarantine & approvals" data-tip-icon="shield">${icon("shield", 20)}<span class="badge" id="railBadge" hidden>0</span></button>
        <button class="rail-btn" data-rail="memory" data-tip="Memory & context|Context window, prompt-cache savings, semantic memory" data-tip-icon="savings">${icon("savings", 20)}</button>
        <button class="rail-btn" data-rail="knowledge" data-tip="Knowledge graph|Your private, encrypted personalization graph - nodes, edges, drill-down" data-tip-icon="graph">${icon("graph", 20)}</button>
        <button class="rail-btn" data-rail="preview" data-tip="Preview|Open a local app/page the agent built in a sandboxed in-app browser, and send a screenshot to chat" data-tip-icon="eye">${icon("eye", 20)}</button>
        <button class="rail-btn" data-rail="agentBuilder" data-tip="Agent Builder|Design an AI agent on a visual workflow canvas - LUCID builds the gated code for you" data-tip-icon="spark">${icon("spark", 20)}</button>
        <button class="rail-btn" data-rail="skills" data-tip="Skills|Every agent skill - built-in, project, curated - in one directory: source, trust label, enable/disable, inspect & re-scan through the gate" data-tip-icon="bulb">${icon("bulb", 20)}</button>
        <button class="rail-btn" id="railMarket" data-tip="Plugin Marketplace|Curated integrations ordered by community popularity - Excalidraw, Git, Remotely Save & more" data-tip-icon="market">${icon("market", 20)}</button>
        <button class="rail-btn" id="railReports" data-tip="Engineering Reports|Generate a role-tailored engineering brief (with podcast audio), and browse every past loop After-Action Report + brief" data-tip-icon="report">${icon("report", 20)}</button>
        <button class="rail-btn" id="railShare" data-tip="Share session (live)|Invite someone to watch this session live, end-to-end encrypted through your relay - view-only" data-tip-icon="share">${icon("share", 20)}<span class="rail-live-dot" id="railShareDot" hidden></span></button>
        <button class="rail-btn" id="railLogs" data-rail="dev" hidden data-tip="Logs|Read-only developer logs: telemetry, run lineage, transcripts, gate-block audit, AskSage tool-call diagnostics" data-tip-icon="logs">${icon("logs", 20)}</button>
        <div class="spacer"></div>
        <button class="rail-btn rail-about" id="railAbout" data-tip="About LUCID Agent IDE|Version, license & credits" data-tip-icon="info">${readmeMark()}</button>
        <button class="rail-btn" id="railCmd" data-tip="Commands|${modCombo("K")}" data-tip-icon="command">${icon("command", 20)}</button>
        <button class="rail-btn" data-rail="settings" data-tip="Settings" data-tip-icon="sliders">${icon("sliders", 20)}</button>
      </nav>

      <aside class="sidebar" id="sidebar">
        <button class="ws-bar" id="wsBar" data-tip="Workspace · click to change" data-tip-side="right" hidden></button>
        <div class="side-head"><span>Sessions</span>
          <div class="side-actions">
            <button class="side-new" id="newSession" data-tip="New session">${icon("plus", 15)}</button>
            <button class="side-new" id="sideCollapse" data-tip="Collapse panel" data-tip-side="bottom">${icon("expand", 15)}</button>
          </div></div>
        <div class="side-list" id="sessList"></div>
        <div class="resizer resizer-r" data-resize="sidebar" data-tip="Drag to resize" data-tip-side="right"></div>
      </aside>

      <main class="center">
        <div class="chat-bg" id="chatBg" aria-hidden="true"></div>
        <div class="chat" id="chat"><div class="thread" id="thread"></div></div>
        <button class="jump-down" id="jumpDown" type="button" aria-label="Jump down a page" data-tip="Jump down a page">${icon("chevronsDown", 18)}</button>
        <div class="composer-wrap">
          <!-- P-VISION.1 (ADR-0136): thumbnails of pasted/dropped images, just above the prompt bar; sent
               with the next message only when the user hits Enter/Send. -->
          <div class="composer-thumbs" id="composerThumbs" hidden></div>
          <div class="composer-row">
            <div class="composer">
              <textarea id="input" rows="1" spellcheck="true" placeholder="Ask the agent…  every tool call is scanned before it runs"></textarea>
            </div>
            <button class="send-btn" id="send" data-tip="Send|Enter" disabled>${icon("send", 18)}</button>
          </div>
          <div class="composer-tools" id="composerTools">
            <!-- Persona + Skills moved to the titlebar (next to the model picker); the composer keeps only the
                 mic so it never squishes when a right-edge surface (KG / IDE / Agent Builder) narrows the center. -->
            <button class="ctool ctool-icon" id="ctMic" data-tip="Voice input · ${modCombo("D")}|Click (or press ${modCombo("D")}) to record, again to stop - transcribed into the composer (Settings → Voice sets the engine)">${icon("mic", 15)}</button>
          </div>
        </div>
      </main>

      <aside class="inspector" id="inspector">
        <div class="resizer resizer-l" data-resize="inspector" data-tip="Drag to resize" data-tip-side="left"></div>
        <div class="insp-tabs">
          <button class="insp-tab sec" data-insp="security">${icon("shield", 15)} Security</button>
          <button class="insp-tab mem active" data-insp="memory">${icon("savings", 15)} Memory</button>
          <button class="insp-collapse" id="inspCollapse" data-tip="Collapse to metrics|Slide into a live quick-metrics rail" data-tip-side="bottom">${icon("collapse", 16)}</button>
        </div>
        <div class="insp-body" id="inspBody"></div>
        <div class="metrics-rail" id="metricsRail">
          <button class="rail-expand" id="railExpand" data-tip="Expand panel" data-tip-side="right">${icon("expand", 16)}</button>
          <div class="rail-tiles" id="railTiles"></div>
        </div>
      </aside>

      <aside class="settings" id="settings" hidden>
        <div class="set-head">
          <div class="set-title">${icon("sliders", 17)} Settings</div>
          <button class="set-close" id="setClose" data-tip="Close settings">${icon("close", 16)}</button>
        </div>
        <div class="set-body" id="setBody"></div>
      </aside>

      <aside class="settings skills-dir" id="skillsDir" hidden>
        <div class="set-head">
          <div class="set-title">${icon("bulb", 17)} Skills <span class="set-sub">directory &amp; governance</span></div>
          <button class="set-close" id="skillsClose" data-tip="Close">${icon("close", 16)}</button>
        </div>
        <div class="set-body" id="skillsBody"></div>
      </aside>

      <aside class="kg" id="knowledge" hidden>
        <div class="resizer resizer-l" data-resize="kg" data-tip="Drag to resize|Collapse toward the chat or widen the graph" data-tip-side="left"></div>
        <div class="set-head">
          <div class="set-title" data-tip="Knowledge Graph|Your private, encrypted personalization graph - nodes, edges, drill-down.">KG <span class="set-sub" id="kgScopeLbl"></span></div>
          <div class="kg-tools">
            <input id="kgSearch" class="kg-search" type="search" placeholder="Find a node…" spellcheck="false" autocomplete="off" data-tip="Find a node|Type to highlight + center matching nodes. Esc clears." />
            <div class="seg kg-lens" data-kg-lens>
              <button class="on" data-lens="kind">Kind</button><button data-lens="trust">Trust</button>
            </div>
            <button class="btn-mini" id="kgPerf" data-tip="Performance mode|Auto adapts rendering to battery + CPU: on battery the graph goes calm (no particle flow, shorter settle, capped nodes); LOW battery pauses the visualization entirely - the agent still uses your knowledge. Click to cycle auto → full → reduced → minimal.">${icon("gauge", 13)} Auto</button>
            <button class="btn-mini" id="kgViews" data-tip="Graph views & tools · dropdown|Opens a menu with three options: Relate nodes (author your own relationships), Code graph (this workspace as a file/symbol graph), and Compiled KB (the knowledge base as a page graph). The label shows the graph you're viewing.">${icon("graph", 13)} <span id="kgViewsLbl">Personal</span> <span class="kgv-caret">▾</span></button>
            <button class="btn-mini btn-icon" id="kgCodeUpdate" data-tip="Re-sync the code graph|Re-ingest the workspace to pick up new files + import changes since the last build." hidden>${icon("refresh", 14)}</button>
            <button class="btn-mini" id="kgData" data-tip="Data · dropdown|Opens a menu with: Import chat history (a ChatGPT / Claude / Gemini export - every message scanned before anything is learned), the AI-extraction toggle for imports, Export Obsidian vault (CUI excluded by design), and the CUI archive (records-managed, 32 CFR 2002 · NARA). Everything is audited.">${icon("folder", 13)} Data <span class="kgv-caret">▾</span></button>
            <button class="set-close" id="kgClose" data-tip="Close">${icon("close", 16)}</button>
          </div>
        </div>
        <div class="kg-relate-bar" id="kgRelateBar" hidden>
          <span class="kg-relate-hint">${icon("info", 12)} Drag a node onto another, or click nodes then Relate.</span>
          <input id="kgRelateLabel" class="kg-relate-label" type="text" maxlength="40" placeholder="related" spellcheck="false" autocomplete="off" data-tip="Name the relationship|Optional. e.g. 'deploys with', 'used for'. Defaults to 'related'." />
          <span class="kg-relate-count" id="kgRelateCount"></span>
          <button class="btn-mini ok" id="kgRelateDo" disabled>Relate</button>
          <button class="btn-mini" id="kgRelateClear">Clear</button>
        </div>
        <div class="kg-main">
          <div class="kg-canvas" id="kgCanvas"></div>
          <button class="kg-center-btn" id="kgCenter" type="button" data-tip="Re-center the graph|Fit the whole graph back into view." data-tip-side="left" hidden>${icon("center", 17)}</button>
          <div class="resizer resizer-l kg-side-resizer" id="kgSideResizer" data-resize="kgside" data-tip="Drag to resize the panel" data-tip-side="left" hidden></div>
          <div class="kg-side" id="kgSide"></div>
        </div>
      </aside>

      <aside class="kg preview-panel" id="preview" hidden>
        <div class="resizer resizer-l" data-resize="preview" data-tip="Drag to resize|Widen the preview or collapse toward the chat" data-tip-side="left"></div>
        <div class="set-head">
          <div class="set-title">${icon("eye", 17)} Preview <span class="set-sub" id="prevKind"></span></div>
          <div class="kg-tools">
            <input id="prevPath" class="kg-search" type="text" placeholder="Open a local file… (path or file://)" spellcheck="false" autocomplete="off" data-tip="Open a local file|Paste a path to an HTML file the agent built, then Open. Local files only in this build; remote URLs are egress-gated (coming next)." />
            <button class="btn-mini" id="prevOpen">${icon("download", 13)} Open</button>
            <button class="btn-mini" id="prevBrowse" data-tip="Browse your workspace|Open a file from the current working directory to preview it yourself (native file picker).">${icon("folder", 13)} Browse…</button>
            <button class="btn-mini" id="prevReload" data-tip="Reload the preview">${icon("refresh", 13)} Reload</button>
            <button class="btn-mini" id="prevMarkup" data-tip="Markup tools|Draw on the preview - pen, rectangle, text - then send the marked-up screenshot to chat.">${icon("markup", 14)} Markup ${icon("chevron", 10)}</button>
            <button class="btn-mini" id="prevShot" data-tip="Send a screenshot to chat|Capture the preview (with your markup) and attach it to the composer for the agent to react to. Desktop app only.">${icon("eye", 13)} Screenshot → chat</button>
            <button class="set-close" id="prevClose" data-tip="Close">${icon("close", 16)}</button>
          </div>
        </div>
        <div class="preview-body" id="prevBody">
          <!-- P-PREVIEW.6a (ADR-0153): a live "reviewing / testing" pill shown while the agent looks at the preview. -->
          <div class="preview-pill" id="prevPill" hidden aria-live="polite"><span class="preview-pill-dot"></span><span id="prevPillLabel">Reviewing the preview</span></div>
          <!-- P-PREVIEW.7 (ADR-0179): the explain-overlay for pages the sandbox can't run (e.g. Electron renderers). -->
          <div class="preview-notice" id="prevNotice" hidden aria-live="polite"></div>
          <iframe id="prevFrame" class="preview-frame" sandbox="${PREVIEW_SANDBOX}" allow="${PREVIEW_ALLOW}" referrerpolicy="no-referrer" title="App preview" hidden></iframe>
          <canvas id="prevCanvas" class="preview-canvas" aria-hidden="true"></canvas>
          <div class="empty preview-empty" id="prevEmpty"><span class="preview-empty-msg" id="prevEmptyMsg">Open a local HTML file to preview it here - paste its path above and press <b>Open</b>. (The agent driving this itself is coming next; remote URLs are egress-gated.)</span></div>
        </div>
      </aside>
      ${agentBuilderPanelHtml()}
    </div>

    <div class="statusbar" id="statusbar"></div>
  </div>`));
}

// ───────────────────────── sidebar (real omp sessions) ─────────────────────────
function relTime(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown"; // a missing/unparseable timestamp must not render "NaNd ago"
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
// #11 perceived-latency: a few placeholder session cards painted INSTANTLY so the
// sidebar never looks empty/broken while /api/sessions is in flight.
function sessSkeleton(): string {
  return `<div class="skel-group">${Array.from({ length: 5 }, () =>
    `<div class="skel-sess"><div class="skel skel-line t"></div><div class="skel skel-line m"></div></div>`).join("")}</div>`;
}
let ingestExpanded = false; // P-KG-INGEST.1b: the "Knowledge Graph Ingest" group is collapsed by default
function sessRow(s: SessionInfo, active: boolean): string {
  return `<div class="sess ${active ? "active" : ""}" data-sid="${esc(s.id)}" data-tip="${esc(s.title)}|${esc(modelLabel(s.model))} · ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${relTime(s.updatedAt)}" data-tip-side="right">
      <div class="t">${esc(s.title)}</div>
      <div class="m"><b>${esc(modelLabel(s.model))}</b> · ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${relTime(s.updatedAt)}</div>
      <button class="sess-del" data-del="${esc(s.id)}" data-tip="Delete session" aria-label="Delete session" tabindex="-1">${icon("trash", 13)}</button>
    </div>`;
}
function renderSessionList(data: SessionList): void {
  const list = $("#sessList"); if (!list) return;
  const { sessions, ingest } = data;
  if (!sessions.length && !ingest.length) { list.innerHTML = `<div class="side-empty">No sessions yet - send a prompt to start one. They persist here across runs.</div>`; return; }
  const chats = sessions.map((s, i) => sessRow(s, i === 0)).join("");
  // P-KG-INGEST.1b: collapse the throwaway "Extract DURABLE facts…" extraction sessions an import mints
  // into ONE foldable group so they don't pollute the chat history (they stay inspectable when expanded).
  const ingestGroup = ingest.length ? `<div class="sess-group">
      <div class="sess-group-head">
        <button class="sess-group-toggle" data-ingest-toggle aria-expanded="${ingestExpanded}" data-tip="Throwaway model-extraction sessions from imports + AI learning. Grouped so they don't clutter your chats.">
          <span class="sess-group-chev ${ingestExpanded ? "open" : ""}">${icon("chevron", 12)}</span> Knowledge Graph Ingest <span class="sess-group-count">${ingest.length}</span>
        </button>
        <button class="sess-group-clear" data-ingest-clear data-tip="Clear ingest sessions|Delete all ${ingest.length} throwaway extraction sessions from disk. Your chats and knowledge graph are untouched.">${icon("trash", 12)}</button>
      </div>
      <div class="sess-group-body" ${ingestExpanded ? "" : "hidden"}>${ingest.map((s) => sessRow(s, false)).join("")}</div>
    </div>` : "";
  list.innerHTML = chats + ingestGroup;
}
async function renderSessions(): Promise<void> {
  const list = $("#sessList");
  if (!list) return;
  // P-PERF.1: on a cold list (first load / skeleton), paint the CACHED session list instantly so a
  // returning user never sees a skeleton; fall back to the skeleton only when there's no cache yet.
  const cached = cachedSessions<SessionList>();
  const cold = !list.firstElementChild || !!$(".skel-group", list);
  if (cold) { if (cached) renderSessionList(cached); else list.innerHTML = sessSkeleton(); }
  const data = await bridge.sessions().catch(() => null);
  if (data === null) { // keep the cached list on a transient error instead of blanking it
    if (cold && !cached) list.innerHTML = `<div class="side-empty">Couldn't load history - the GUI server looks out of date. Relaunch it (launcher → <b>G</b>), or restart <code>bun run desktop:web</code>.</div>`;
    return;
  }
  renderSessionList(data);
  setCachedSessions(data); // refresh the cache for next launch
  void warmTranscripts(data); // P-PERF.4: AC-only idle prefetch (no-op on battery tiers)
}
// P-PERF.4 (ADR-0131): warm the transcript cache for the most-recent sessions so clicking one paints
// instantly even on the FIRST visit. Strictly AC-only (perf tier `full`) - prefetch is anti-battery -
// and off the interactive path via requestIdleCallback; sequential fetches keep the server load flat.
let warmedTranscripts = false;
async function warmTranscripts(data: SessionList): Promise<void> {
  if (warmedTranscripts || perfWatch.tier() !== "full") return;
  warmedTranscripts = true;
  const run = async (): Promise<void> => {
    for (const s of data.sessions.slice(0, 5)) {
      if (perfWatch.tier() !== "full") break; // unplugged mid-warm -> stop spending
      if (cachedTranscript(s.id)) continue;
      const page = await bridge.sessionMessages(s.id, RESUME_TAIL).catch(() => null);
      if (page?.messages.length) setCachedTranscript(s.id, page.messages, Date.now());
    }
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => void run());
  else window.setTimeout(() => void run(), 1500);
}
// P-KG-INGEST.2: bulk-delete the throwaway extraction sessions (chats + knowledge graph untouched).
function confirmClearIngest(): void {
  showToast({
    title: "Clear ingest sessions?",
    desc: "Deletes the throwaway 'Extract DURABLE facts…' extraction sessions from disk. Your chats and your knowledge graph are NOT affected.",
    tone: "warn",
    actions: [
      { label: "Cancel" },
      { label: "Clear", kind: "danger", run: async () => {
        const r = await bridge.clearIngestSessions().catch(() => null);
        if (!r?.ok) { showToast({ tone: "danger", title: "Couldn't clear", desc: "Some sessions may still be open. Try again.", actions: [{ label: "OK" }], timeout: 5000 }); return; }
        showToast({ title: r.cleared ? `Cleared ${r.cleared} ingest session${r.cleared === 1 ? "" : "s"}` : "Nothing to clear", desc: "Your chats and knowledge graph are unchanged.", timeout: 3000 });
        void renderSessions();
      } },
    ],
    timeout: 0,
  });
}

// ───────────────────────── chat ─────────────────────────
function seedThread(): void {
  $("#thread")!.innerHTML = `<div class="chat-hint" id="chatHint">
    <div class="bs">${piMark}</div>
    <div class="h">Ask the agent anything</div>
    <div class="d">Secure prompting and code generation</div></div>`;
}
function addMessage(role: "user" | "assistant", text: string, attachments?: Attachment[]): HTMLElement {
  $("#chatHint")?.remove();
  // Copy + Save .md on BOTH roles (copy your own prompts too).
  // P-VOICE.1 (ADR-0115): read-aloud (TTS) only on the assistant's replies.
  const speakBtn = role === "assistant" ? `<button class="msg-act" data-msg-speak data-tip="Read aloud|Speak this reply (Settings → Voice sets the engine)">${icon("volume", 13)}</button>` : "";
  const actions = `<div class="msg-actions"><button class="msg-act" data-msg-copy data-tip="Copy markdown">${icon("copy", 13)}</button><button class="msg-act" data-msg-save data-tip="Save as .md">${icon("download", 13)}</button>${speakBtn}</div>`;
  const who = role === "user" ? (state.username || "You") : "LucidAgent";
  const node = el(`<div class="msg ${role}">
    <div class="who">${esc(who)}</div>
    <div class="av">${role === "user" ? icon("user", 16) : piMark}</div>
    <div class="text"></div>${actions}</div>`);
  (node as MsgNode)._md = text; // raw markdown, for copy / save-as-.md
  const textEl = $(".text", node) as HTMLElement;
  // P-CHAT.A (ADR-0188): a settled assistant answer sectionizes on its own headings; user prompts stay inline.
  if (role === "assistant") renderAnswerBody(textEl, text);
  else { textEl.innerHTML = renderMarkdown(text); enhanceCodeBlocks(textEl); }
  // P-VISION.1 (ADR-0136): render attached images inline. Each img.src is set as a DOM PROPERTY (never
  // interpolated into the HTML) so a data URL can't break out of the markup.
  if (attachments?.length) {
    const row = el(`<div class="msg-imgs"></div>`);
    for (const a of attachments) {
      const img = document.createElement("img");
      img.className = "msg-img"; img.alt = "attached image"; img.loading = "lazy"; img.src = a.dataUrl;
      row.appendChild(img);
    }
    textEl.appendChild(row);
  }
  $("#thread")!.appendChild(node);
  scrollChat();
  return node;
}

// ── P-VISION.1 (ADR-0136): composer image attachments ────────────────────────────────────────────
let attSeq = 0;
/** Re-paint the thumbnail strip above the composer and set each thumb's img.src as a PROPERTY. */
function renderComposerThumbs(): void {
  const strip = $("#composerThumbs") as HTMLElement | null; if (!strip) return;
  strip.innerHTML = thumbStripHtml(state.attachments);
  strip.hidden = state.attachments.length === 0;
  for (const a of state.attachments) {
    const img = strip.querySelector(`.cx-thumb[data-att="${a.id}"] .cx-thumb-img`) as HTMLImageElement | null;
    if (img) img.src = a.dataUrl; // property, never interpolated
  }
  setSendEnabled();
}
/** Validate + stage a pasted/dropped image (data URL) for the next message. */
function addPastedImage(dataUrl: string, name?: string): void {
  const r = acceptAttachment(state.attachments, dataUrl, `att_${++attSeq}`, name);
  if (!r.ok || !r.attachment) { showToast({ tone: "warn", title: "Couldn't attach image", desc: r.reason ?? "" }); return; }
  state.attachments.push(r.attachment);
  renderComposerThumbs();
  showToast({ title: "Image attached", desc: "Add instructions, then press Enter to send.", timeout: 1800 });
}
/** Read image files (from paste or drop) into staged attachments. Returns true if any were image files. */
function stageImageFiles(files: FileList | File[] | null | undefined): boolean {
  let any = false;
  for (const f of Array.from(files ?? [])) {
    if (!f.type.startsWith("image/")) continue;
    any = true;
    if (f.size > MAX_ATTACHMENT_BYTES) { showToast({ tone: "warn", title: "Image too large", desc: `${f.name || "image"} exceeds the limit.` }); continue; }
    const reader = new FileReader();
    reader.onload = () => addPastedImage(String(reader.result), f.name);
    reader.readAsDataURL(f);
  }
  return any;
}
interface MsgNode extends HTMLElement { _md?: string }

// ── P-IMP.2 (ADR-0035): chat-export import onboarding ────────────────────────────────
// Mirrors MODEL_IMPORT_CAP in desktop/personal.ts - AI mode sends at most this many user messages
// to the model (one sequential call each), so the warning's token/time math caps here too.
const AI_IMPORT_CAP = 500;
/** Rough AI-extraction cost for the pre-import warning. Per capped message: ~200-token extract
 *  prompt + the message (chars/4) in, ~100-token JSON out; calls run sequentially at ~2.5 s each.
 *  Deliberately approximate - it exists to set expectations before a paid, minutes-long run. */
function estimateAiImport(est: import("./bridge.ts").PersonalImportEstimate): { tokens: number; secs: number; overCap: boolean } {
  const msgs = est.userMessages ?? 0;
  const capped = Math.min(msgs, AI_IMPORT_CAP);
  const avgChars = msgs ? (est.userChars ?? 0) / msgs : 0;
  const tokens = Math.round(capped * (200 + avgChars / 4 + 100));
  const secs = Math.round(capped * 2.5);
  return { tokens, secs, overCap: msgs > AI_IMPORT_CAP };
}
const fmtDur = (s: number): string => (s < 90 ? `~${s}s` : s < 3600 ? `~${Math.round(s / 60)} min` : `~${(s / 3600).toFixed(1)} h`);
/** Run the gated import in the chosen mode and report the outcome (shared by both confirm actions). */
const vendorName = (v?: string): string => (v === "openai" ? "ChatGPT" : v === "anthropic" ? "Claude" : v === "gemini" ? "Gemini" : "export");
// P-KG-INGEST.1 (ADR-0076): a persistent, non-blocking status pill for a background import. The app stays
// usable while it runs; the pill shows a live countdown + a Cancel button and is updated by polling.
let importPollTimer = 0;
function ensureImportPill(): HTMLElement {
  let pill = document.getElementById("importPill");
  if (!pill) {
    pill = el(`<div class="import-pill" id="importPill" hidden>
      <div class="import-pill-head">${icon("download", 13)} <b>Importing chat history</b> <span class="import-pill-vendor" id="importPillVendor"></span></div>
      <div class="import-pill-bar"><div class="import-pill-fill" id="importPillFill"></div></div>
      <div class="import-pill-row"><span class="import-pill-text" id="importPillText">Starting…</span><button class="btn-mini" id="importPillCancel">Cancel</button></div>
    </div>`);
    document.body.appendChild(pill);
  }
  return pill as HTMLElement;
}
function hideImportPill(): void {
  if (importPollTimer) { clearTimeout(importPollTimer); importPollTimer = 0; }
  const pill = document.getElementById("importPill"); if (pill) (pill as HTMLElement).hidden = true;
}
async function runPersonalImport(folder: string, useModel: boolean): Promise<void> {
  const started = await bridge.personalImport(folder, useModel);
  if (!started?.ok || !started.jobId) {
    showToast({ tone: started?.error?.includes("already running") ? "warn" : "danger", title: "Import didn't start", desc: started?.error ?? "Personalization is off or locked.", actions: [{ label: "OK" }], timeout: 6000 });
    return;
  }
  const jobId = started.jobId;
  const pill = ensureImportPill();
  pill.hidden = false;
  const fill = $("#importPillFill", pill) as HTMLElement, text = $("#importPillText", pill) as HTMLElement, ven = $("#importPillVendor", pill) as HTMLElement;
  const cancelBtn = $("#importPillCancel", pill) as HTMLButtonElement;
  cancelBtn.disabled = false; cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = () => { cancelBtn.disabled = true; cancelBtn.textContent = "Stopping…"; void bridge.personalImportCancel(jobId); };
  const poll = async () => {
    const st = await bridge.personalImportStatus(jobId).catch(() => null);
    if (!st) { hideImportPill(); return; }
    const { pct, line, done } = formatImportLine(st);
    fill.style.width = `${pct}%`; text.textContent = line; ven.textContent = vendorName(st.vendor);
    if (!done) { importPollTimer = window.setTimeout(() => void poll(), 1200); return; }
    hideImportPill();
    const r = st.result;
    if (st.state === "failed" || !r?.ok) {
      showToast({ tone: "danger", title: "Import failed", desc: st.error ?? r?.error ?? "Something went wrong.", actions: [{ label: "OK" }], timeout: 6000 });
      return;
    }
    const notes = [
      r.extractor === "model" ? "AI extraction" : "quick extraction",
      r.blocked ? `${r.blocked} quarantined by the gate` : "all passed the gate",
      r.skipped ? `${r.skipped} skipped (${AI_IMPORT_CAP}-message AI cap - re-run to continue)` : "",
      st.state === "cancelled" ? "stopped early - re-run to continue" : "",
    ].filter(Boolean).join(" · ");
    showToast({
      title: st.state === "cancelled" ? `Import stopped (${vendorName(r.vendor)})` : `Imported from ${vendorName(r.vendor)}`,
      desc: `${r.learned} facts learned from ${r.messages} messages across ${r.conversations} conversations.`,
      meta: notes, actions: [{ label: "OK" }], timeout: 9000,
    });
    if (kgOpen && !kgCodeMode && !kbGraphMode) void renderKnowledge(); // redraw with the new nodes + edges (personal graph only)
  };
  void poll();
}
// P-IDE.4 (ADR-0029): add a "View in IDE" affordance to each code block (DOMPurify forbids <button>
// inside the sanitized markdown, so the button is injected post-render via the DOM). The click handler
// (wired once, delegated) reads the code + language from the block and opens the read-only Monaco panel.
function enhanceCodeBlocks(container: HTMLElement): void {
  container.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement as HTMLElement | null;
    if (!pre || pre.querySelector(".code-ide-btn")) return;
    pre.style.position = "relative";
    const langCls = [...code.classList].find((c) => c.startsWith("language-"));
    const lang = langCls ? langCls.slice("language-".length) : "";
    pre.appendChild(el(`<button class="code-ide-btn" type="button" data-ide-open data-lang="${esc(lang)}">${icon("layout", 12)} View in IDE</button>`));
  });
}
function addEvent(html: string): HTMLElement {
  const node = el(html);
  $("#thread")!.appendChild(node);
  scrollChat();
  return node;
}
// P-TOOLFAIL.2 (ADR-0163): consecutive failed/didn't-run tool calls collapse into ONE small red
// toolbox badge (toolfail_group.ts builds the HTML); clicking the badge toggles the "Tool Call
// Actions" list. A group closes the moment anything else lands in the thread (it is no longer the
// last child), so failures from different phases of a turn never merge misleadingly.
let tfGroup: { el: HTMLElement; entries: ToolFailEntry[] } | null = null;
function addToolFailure(entry: ToolFailEntry): void {
  const thread = $("#thread")!;
  if (!tfGroup || tfGroup.el !== thread.lastElementChild) {
    const g = { el: el(`<div class="toolfail"></div>`), entries: [] as ToolFailEntry[] };
    // Delegated click (survives innerHTML repaints): only the badge toggles.
    g.el.addEventListener("click", (ev) => {
      if (!(ev.target as HTMLElement).closest(".tf-head")) return;
      g.el.classList.toggle("open");
      g.el.innerHTML = toolfailGroupHtml(g.entries, g.el.classList.contains("open"));
    });
    thread.appendChild(g.el);
    tfGroup = g;
  }
  tfGroup.entries.push(entry);
  tfGroup.el.innerHTML = toolfailGroupHtml(tfGroup.entries, tfGroup.el.classList.contains("open"));
  scrollChat();
}
// Stick-to-bottom autoscroll, rAF-batched for buttery playback under rapid tokens.
// Many scrollChat() calls within one frame coalesce into a SINGLE scrollTop write, so the
// browser never thrashes layout mid-stream. We only follow output while the user is parked
// near the bottom (STICK_PX); the moment they scroll UP to re-read, autoscroll releases and
// stays released until they come back down - so re-reading mid-stream is never yanked.
// Tight stick window: we only auto-FOLLOW while the user is essentially parked at the bottom.
// Slow output advances < STICK_PX per frame, so it keeps pace; a fast burst grows the page by more
// than STICK_PX between frames, which releases the follow - and the jump-down button (below) lets the
// reader catch up a page at a time instead of being yanked. That's the behaviour the user asked for.
const STICK_PX = 72;
let scrollPending = false; // a follow-frame is already queued
let lastWroteTop = -1;     // the scrollTop value WE last wrote - lets us spot a user scroll-up
const nearBottom = (c: HTMLElement): boolean => c.scrollHeight - c.scrollTop - c.clientHeight < STICK_PX;
const scrollChat = (): void => {
  const c = $("#chat");
  if (!c) return;
  // A user scroll-up since our last programmatic write releases the stick until they return.
  if (lastWroteTop >= 0 && c.scrollTop < lastWroteTop - 2 && !nearBottom(c)) { updateJump(); return; }
  if (scrollPending || !nearBottom(c)) { updateJump(); return; }
  scrollPending = true;
  requestAnimationFrame(() => {
    scrollPending = false;
    const cc = $("#chat");
    if (cc && nearBottom(cc)) { cc.scrollTop = cc.scrollHeight; lastWroteTop = cc.scrollTop; }
    updateJump();
  });
};

// ── Jump-to-latest (catch up on fast output) ──
// A double-down-arrow in the LucidAgent accent appears, tucked just inside the scrollbar, whenever
// there's a screen-plus of content below the fold. Clicking advances ONE viewport but overlaps the
// last visible line, so a reader resumes exactly where they left off rather than losing their place.
const JUMP_SHOW_PX = 140; // content below the fold before the catch-up button shows
let jumpRaf = false;
function lineHeightPx(): number {
  const t = $("#thread")?.querySelector(".msg .text") as Element | null;
  const lh = t ? parseFloat(getComputedStyle(t).lineHeight) : NaN;
  return Number.isFinite(lh) && lh > 0 ? lh : 28;
}
function updateJump(): void {
  const c = $("#chat"), b = $("#jumpDown");
  if (!c || !b) return;
  const show = c.scrollHeight - c.scrollTop - c.clientHeight > JUMP_SHOW_PX;
  if (show) {
    const cw = $(".composer-wrap");
    b.style.bottom = `${(cw ? cw.getBoundingClientRect().height : 64) + 14}px`;
  }
  b.classList.toggle("show", show);
}
const scheduleJump = (): void => { if (jumpRaf) return; jumpRaf = true; requestAnimationFrame(() => { jumpRaf = false; updateJump(); }); };
function jumpDownOnePage(): void {
  const c = $("#chat");
  if (!c) return;
  const step = Math.max(c.clientHeight - lineHeightPx() - 8, 80); // one viewport, minus a line of overlap
  c.scrollTo({ top: Math.min(c.scrollTop + step, c.scrollHeight), behavior: "smooth" });
}

// P10.1 (ADR-0011) + UI polish: a friendly, honest "what's happening" label. We classify the user's
// ask into a coarse INTENT, then pick a fitting line for each phase (warming → thinking → writing),
// randomized WITHIN the intent so repeat asks don't read identically. Real tool events still override
// these with the concrete action (phaseForTool) the moment they arrive.
type Intent = "code" | "debug" | "search" | "test" | "explain" | "general";
function classifyIntent(text: string): Intent {
  const t = text.toLowerCase();
  if (/\b(fix|bug|error|broken|crash|fail(s|ed|ing)?|debug|stack ?trace)\b|isn'?t working|doesn'?t work/.test(t)) return "debug";
  if (/\b(test|tests|jest|vitest|pytest|spec|coverage)\b/.test(t)) return "test";
  if (/\b(find|search|where|locate|grep)\b|look for|which file/.test(t)) return "search";
  if (/\b(build|create|make|write|implement|add|code|app|game|function|component|refactor|generate|script|feature)\b/.test(t)) return "code";
  if (/\b(explain|how|what|why|describe|summar\w*|compare|overview|understand)\b|tell me/.test(t)) return "explain";
  return "general";
}
// Phase lines by intent. `warm` = before anything streams; `think` = during reasoning; `write` = while
// the answer streams. Keep them upbeat but honest - they describe the kind of work, not fake specifics.
const PHASE_LINES: Record<"warm" | "think" | "write", Record<Intent, string[]>> = {
  warm: {
    code: ["Cooking up something great…", "Spinning up the build…", "Sketching the approach…", "Rolling up my sleeves…"],
    debug: ["Sizing up the problem…", "Putting on my detective hat…", "Reading the symptoms…"],
    search: ["Casing the codebase…", "Getting my bearings…", "Lining up the search…"],
    test: ["Prepping the test bench…", "Lining up the checks…", "Warming up the harness…"],
    explain: ["Gathering my thoughts…", "Pulling the threads together…", "Framing the answer…"],
    general: ["Warming up…", "Getting oriented…", "On it…", "Spinning up…"],
  },
  think: {
    code: ["Thinking through the design…", "Weighing the approach…", "Planning the build…"],
    debug: ["Tracing the root cause…", "Reasoning about the failure…", "Following the clues…"],
    search: ["Working out where to look…", "Mapping it out…", "Narrowing it down…"],
    test: ["Reasoning about edge cases…", "Planning the checks…"],
    explain: ["Organizing the explanation…", "Connecting the ideas…", "Thinking it through…"],
    general: ["Thinking it through…", "Reasoning it out…", "Mulling it over…", "Working it out…"],
  },
  write: {
    code: ["Cooking up something great…", "Writing the code…", "Building it out…", "Wiring it together…"],
    debug: ["Walking through the fix…", "Writing up the fix…", "Laying out the solution…"],
    search: ["Writing up what I found…", "Pulling the findings together…"],
    test: ["Writing the tests…", "Laying out the checks…"],
    explain: ["Writing it up…", "Putting it into words…", "Composing the answer…"],
    general: ["Putting it together…", "Writing it up…", "Drafting the reply…"],
  },
};
const pickLine = (kind: "warm" | "think" | "write", intent: Intent): string => {
  const pool = PHASE_LINES[kind][intent];
  return pool[Math.floor(Math.random() * pool.length)]!;
};
function phaseForTool(name: string, detail: string): string {
  const n = name.toLowerCase(), d = (detail || "").toLowerCase();
  if (/read|grep|glob|search|find|^ls|list/.test(n)) return "Searching the codebase…";
  if (/edit|write|notebook|patch|apply|create/.test(n)) return "Editing files…";
  if (/bash|shell|run|exec|command/.test(n)) return /\b(test|jest|vitest|pytest|build|tsc)\b/.test(d) ? "Running tests…" : "Running commands…";
  if (/fetch|web|http|browse/.test(n)) return "Searching the web…";
  return `Using ${name}…`;
}
// A category icon for a tool, so each consolidated activity step reads at a glance.
function phaseIcon(name: string): string {
  const n = name.toLowerCase();
  if (/read|grep|glob|search|find|^ls|list/.test(n)) return "search";
  if (/edit|write|notebook|patch|apply|create/.test(n)) return "folder";
  if (/bash|shell|run|exec|command/.test(n)) return "bolt";
  if (/fetch|web|http|browse/.test(n)) return "runs";
  return "eye";
}
const fmtClock = (ms: number): string => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

// P-CHAT.1 (ADR-0104): the authored code a tool step can expand to preview inline.
type ToolCode = { path: string; content?: string; oldText?: string; newText?: string; patch?: string };
// P-CHAT.B (ADR-0189): the opaque payload a tool mark round-trips to fill its chip drilldown (code or detail).
interface ChipData { code?: ToolCode; detail: string; }

/** Fill an expandable step's panel with the tool's code — a write's content (syntax-highlighted via the
 *  vendored Monaco), an edit's hashline `patch` (colored +/− lines), or an old→new pair as a line diff.
 *  Safe: Monaco HTML escapes its own text; every diff/patch line is set via textContent. Lazy + best-effort. */
/** P-CHAT.1 (ADR-0104): open the step's file in the full Monaco IDE panel for context (like Claude Code's
 *  expand). Prefers the real file on disk (editable, gate-protected save); falls back to the in-hand
 *  content/patch as a snippet when there's no readable path. */
async function openStepInEditor(code: ToolCode): Promise<void> {
  const path = (code.path || "").trim();
  const name = path.split(/[\\/]/).pop() || "Code";
  if (path && /^(file:\/\/|[A-Za-z]:[\\/]|\/|~[\\/]|\\\\)/.test(path)) {
    const r = await bridge.editorRead(path).catch(() => null);
    if (r?.ok && typeof r.content === "string") { await openIde({ path, code: r.content, sha256: r.sha256, mtime: r.mtime }); return; }
  }
  if (code.content !== undefined) { await openIde({ title: name, code: code.content, language: guessLanguage(path) }); return; }
  await openIde({ title: `${name} - patch`, code: code.patch ?? "", language: "diff" });
}

async function renderToolCode(panel: HTMLElement, code: ToolCode): Promise<void> {
  if (panel.dataset.filled) return;
  panel.dataset.filled = "1";
  // A small bar: the filename + "Open in editor" (expand into the full Monaco panel for context).
  const barName = (code.path || "").split(/[\\/]/).pop() || code.path || "code";
  const bar = el(`<div class="tc-bar"><span class="tc-name">${esc(barName)}</span><button class="tc-open" type="button" data-tip="Open in the editor for full context">Open in editor ${icon("arrowRight", 12)}</button></div>`);
  ($(".tc-open", bar) as HTMLButtonElement).addEventListener("click", (e) => { e.stopPropagation(); void openStepInEditor(code); });
  panel.appendChild(bar);
  if (code.content !== undefined) {
    const pre = el(`<pre class="tc-code"></pre>`);
    pre.textContent = code.content;                         // readable default before highlight resolves
    panel.appendChild(pre);
    const html = await colorizeCode(code.content, code.path || "").catch(() => null);
    if (html && panel.contains(pre)) pre.innerHTML = html;  // Monaco-highlighted HTML (its text is escaped)
  } else if (code.patch !== undefined) {
    const box = el(`<div class="tc-diff"></div>`);
    for (const raw of code.patch.split("\n")) {
      const line = el(`<div class="tc-line tc-${patchLineType(raw)}"></div>`);
      line.textContent = raw;                               // hashline already carries its own +/− prefixes
      box.appendChild(line);
    }
    panel.appendChild(box);
  } else {
    const box = el(`<div class="tc-diff"></div>`);
    for (const r of lineDiff(code.oldText ?? "", code.newText ?? "")) {
      const line = el(`<div class="tc-line tc-${r.type}"></div>`);
      line.textContent = `${r.type === "add" ? "+" : r.type === "del" ? "−" : " "} ${r.text}`;
      box.appendChild(line);
    }
    panel.appendChild(box);
  }
}

// ── Consolidating activity window (the "working / agent thoughts" surface) ──
// Instead of an ever-growing stack of raw .evt chips, the agent's tool calls collapse into
// ONE compact window per turn: a head (live current step + a count) you can expand to see the
// full step list, and a tidy one-line summary on done. Security blocks are NEVER folded in
// here - onBlock keeps emitting its own loud .evt.block chip alongside this window.
interface ThoughtsWin {
  el: HTMLElement;
  /** Record a tool/activity step. `code` (P-CHAT.1) makes the step expandable to an inline code/diff preview. */
  step(name: string, detail: string, code?: ToolCode): void;
  /** Collapse into the final one-line summary (auto-collapse on done). */
  finish(ms: number): void;
}
function createThoughts(): ThoughtsWin {
  const win = el(`<div class="thoughts open" data-streaming="1">
    <button class="thoughts-head" type="button" aria-expanded="true">
      <span class="thoughts-spin">${icon("spark", 13)}</span>
      <span class="thoughts-cur">Working…</span>
      <span class="thoughts-count" hidden>0</span>
      <span class="thoughts-chev">${icon("chevron", 14)}</span>
    </button>
    <div class="thoughts-body"></div>
  </div>`);
  const headBtn = $(".thoughts-head", win) as HTMLButtonElement;
  const curEl = $(".thoughts-cur", win) as HTMLElement;
  const countEl = $(".thoughts-count", win) as HTMLElement;
  const body = $(".thoughts-body", win) as HTMLElement;
  let steps = 0;
  const files = new Set<string>();
  const toggle = (open: boolean) => {
    win.classList.toggle("open", open);
    headBtn.setAttribute("aria-expanded", String(open));
  };
  headBtn.addEventListener("click", () => toggle(!win.classList.contains("open")));
  return {
    el: win,
    step(name: string, detail: string, code?: ToolCode) {
      steps++;
      const label = phaseForTool(name, detail);
      curEl.textContent = label;
      countEl.hidden = false;
      countEl.textContent = String(steps);
      if (/edit|write|notebook|patch|apply|create/i.test(name) && detail) files.add(detail.trim());
      const hasCode = !!code && (code.content !== undefined || code.patch !== undefined || code.oldText !== undefined || code.newText !== undefined);
      if (!hasCode) {
        body.appendChild(el(`<div class="thoughts-step">${icon(phaseIcon(name), 13)}<span class="ts-k">${esc(name)}</span><span class="ts-d">${esc(detail)}</span></div>`));
      } else {
        // P-CHAT.1: an expandable step — click the row to reveal the written code / the edit diff inline.
        let badge = "";
        if (code!.content === undefined) {
          const { add, del } = code!.patch !== undefined ? patchStat(code!.patch) : diffStat(lineDiff(code!.oldText ?? "", code!.newText ?? ""));
          badge = `<span class="ts-diffstat"><span class="ts-add">+${add}</span> <span class="ts-del">−${del}</span></span>`;
        }
        const row = el(`<div class="thoughts-step has-code">
          <button class="ts-row" type="button" aria-expanded="false">${icon(phaseIcon(name), 13)}<span class="ts-k">${esc(name)}</span><span class="ts-d">${esc(detail)}</span>${badge}<span class="ts-chev">${icon("chevron", 13)}</span></button>
          <div class="ts-code" hidden></div>
        </div>`);
        const btn = $(".ts-row", row) as HTMLButtonElement;
        const codeEl = $(".ts-code", row) as HTMLElement;
        btn.addEventListener("click", () => {
          const opening = codeEl.hasAttribute("hidden");
          if (opening) { void renderToolCode(codeEl, code!); codeEl.removeAttribute("hidden"); }
          else codeEl.setAttribute("hidden", "");
          btn.setAttribute("aria-expanded", String(opening));
          row.classList.toggle("open", opening);
        });
        body.appendChild(row);
      }
      // Keep the newest step in view while expanded, without stealing the page scroll.
      if (win.classList.contains("open")) body.scrollTop = body.scrollHeight;
    },
    finish(ms: number) {
      win.removeAttribute("data-streaming");
      win.classList.add("done");
      toggle(false); // auto-collapse to the tidy summary
      const fileBit = files.size ? ` · ${files.size} file${files.size === 1 ? "" : "s"}` : "";
      const secs = ms / 1000;
      const timeBit = secs >= 0.05 ? ` · ${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s` : "";
      curEl.textContent = steps
        ? `${steps} step${steps === 1 ? "" : "s"}${fileBit}${timeBit}`
        : "No tools used";
      countEl.hidden = true;
    },
  };
}

// ── Reasoning stream (the agent's live "thinking") - P-ACP.1 (ADR-0027) ──
// omp streams `agent_thought_chunk`s before the answer when thinking is on. We render them into a
// collapsible block that sits ABOVE the answer and fills in live, then auto-collapses to a tidy
// "Thought for Ns" summary once the answer starts (mirrors the omp TUI). It's a distinct surface
// from the tool-activity .thoughts window: reasoning text, not tool steps.
interface ReasoningWin {
  el: HTMLElement;
  /** Append streamed reasoning text. */
  push(text: string): void;
  /** Collapse to the "Thought for Ns" summary. */
  finish(ms: number): void;
}
function createReasoning(): ReasoningWin {
  const win = el(`<div class="reasoning open" data-streaming="1">
    <button class="reasoning-head" type="button" aria-expanded="true">
      <span class="reasoning-spin">${icon("bulb", 13)}</span>
      <span class="reasoning-cur">Thinking…</span>
      <span class="reasoning-chev">${icon("chevron", 14)}</span>
    </button>
    <div class="reasoning-body"></div>
  </div>`);
  const headBtn = $(".reasoning-head", win) as HTMLButtonElement;
  const curEl = $(".reasoning-cur", win) as HTMLElement;
  const body = $(".reasoning-body", win) as HTMLElement;
  let raw = "";
  let done = false;
  const toggle = (open: boolean) => { win.classList.toggle("open", open); headBtn.setAttribute("aria-expanded", String(open)); };
  headBtn.addEventListener("click", () => toggle(!win.classList.contains("open")));
  return {
    el: win,
    push(text: string) {
      raw += text;
      body.textContent = raw; // plain text - reasoning is not markdown-rendered
      if (win.classList.contains("open")) body.scrollTop = body.scrollHeight; // keep newest in view
    },
    finish(ms: number) {
      if (done) return;
      done = true;
      win.removeAttribute("data-streaming");
      win.classList.add("done");
      toggle(false); // auto-collapse once the answer takes over
      const secs = ms / 1000;
      curEl.textContent = `Thought for ${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s`;
    },
  };
}

// ── Tool-permission prompt (Ask mode) - P-ACP.3 (ADR-0027) ──
// In Ask mode omp asks before each tool call; the backend forwards the request as a `permission`
// event. We render an inline approve/deny card; the choice is POSTed back to resolve the parked
// request. Unanswered at turn's end ⇒ Denied (the backend already fail-closes server-side).
const isAllowOpt = (kind?: string, optionId?: string) => /allow|approve|grant|accept|yes/i.test(`${kind ?? ""} ${optionId ?? ""}`);
function createPermissionCard(e: Extract<ChatEvent, { type: "permission" }>): { el: HTMLElement; finalize: () => void } {
  let win: HTMLElement;
  if (e.egress) {
    // P-EGRESS.1 (ADR-0062): the agent wants to reach the internet. Docked above the composer. Subdued
    // styling that matches the app; the target URL with a copy button + a one-click Cloudflare-Radar check,
    // then the per-website choices (kind: allow → neutral, danger → amber, reject → block).
    const url = e.url ?? e.detail ?? "";
    const egCls = (k?: string) => k === "reject" ? "eg-block" : k === "danger" ? "eg-danger" : "eg-allow";
    const btns = e.options.map((o) => `<button class="perm-btn ${egCls(o.kind)}" data-oid="${esc(o.optionId)}">${esc(o.name)}</button>`).join("");
    if (e.localFile) {
      // P-EGRESS.2 (ADR-0094): a LOCAL file open, not a website visit. Label it accurately and warn that a
      // rendered local page can still load remote resources — no Cloudflare-Radar (there is no host to vet).
      win = el(`<div class="perm perm-egress perm-egress-local" data-streaming="1">
        <div class="perm-eg-head">${icon("logs", 13)}<span>The agent wants to open a local file in your browser</span></div>
        <div class="perm-egress-target"><code class="perm-url">${esc(url)}</code><button class="perm-copy" data-tip="Copy path">${icon("copy", 12)}</button></div>
        <div class="perm-exec-why">A local page can still load remote resources (images, scripts, trackers) once your browser opens it.</div>
        <div class="perm-actions perm-actions-col">${btns}</div>
      </div>`);
    } else {
      win = el(`<div class="perm perm-egress" data-streaming="1">
        <div class="perm-eg-head">${icon("git", 13)}<span>The agent wants to visit a website</span></div>
        <div class="perm-egress-target"><code class="perm-url">${esc(url)}</code><button class="perm-copy" data-tip="Copy URL">${icon("copy", 12)}</button></div>
        <button class="perm-radar" data-radar>${icon("search", 12)} Check it on Cloudflare Radar</button>
        <div class="perm-actions perm-actions-col">${btns}</div>
      </div>`);
    }
    const copyBtn = $(".perm-copy", win) as HTMLElement | null;
    copyBtn?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); copyBtn.innerHTML = icon("check", 12); setTimeout(() => { copyBtn.innerHTML = icon("copy", 12); }, 1200); } catch { /* clipboard blocked */ }
    });
    ($("[data-radar]", win) as HTMLElement | null)?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); } catch { /* ignore */ }
      window.open("https://radar.cloudflare.com/scan", "_blank", "noopener");
      showToast({ title: "URL copied · Radar opened", desc: "Paste the URL into Cloudflare Radar to vet the site before allowing.", actions: [{ label: "OK" }], timeout: 4000 });
    });
  } else if (e.exec) {
    // P-EXEC.1 (ADR-0066): the agent wants to run a shell/eval command. Docked above the composer like
    // egress. Show the command, the program key + why it's risky, and the per-command choices. A
    // catastrophic command (rm -rf, sudo, pipe-to-shell, …) is styled as high-risk and offers no
    // "always allow" - only once / this-turn / block.
    const cmd = e.detail ?? "";
    const exCls = (k?: string) => k === "reject" ? "eg-block" : k === "danger" ? "eg-danger" : "eg-allow";
    const btns = e.options.map((o) => `<button class="perm-btn ${exCls(o.kind)}" data-oid="${esc(o.optionId)}">${esc(o.name)}</button>`).join("");
    win = el(`<div class="perm perm-egress perm-exec${e.danger ? " perm-exec-danger" : ""}" data-streaming="1">
      <div class="perm-eg-head">${icon(e.danger ? "shield" : "bolt", 13)}<span>${e.danger ? "The agent wants to run a HIGH-RISK command" : "The agent wants to run a command"}</span></div>
      <div class="perm-egress-target"><code class="perm-url">${esc(cmd)}</code>
        <span class="perm-cmd-btns">
          <button class="perm-copy" data-tip="Copy command">${icon("copy", 12)}</button>
          <button class="perm-tldr" data-tip="Explain this command in plain terms (uses a cheap model)">TLDR</button>
        </span></div>
      <div class="perm-tldr-out" hidden></div>
      ${e.reason || e.program ? `<div class="perm-exec-why">${e.program ? `<code class="perm-prog">${esc(e.program)}</code> · ` : ""}${esc(e.reason ?? "")}</div>` : ""}
      <div class="perm-actions perm-actions-col">${btns}</div>
    </div>`);
    const copyBtn = $(".perm-copy", win) as HTMLElement | null;
    copyBtn?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(cmd); copyBtn.innerHTML = icon("check", 12); setTimeout(() => { copyBtn.innerHTML = icon("copy", 12); }, 1200); } catch { /* clipboard blocked */ }
    });
    // TLDR: one-shot plain-language explanation from a cheap keyed model, shown inline. Cached per card.
    const tldrBtn = $(".perm-tldr", win) as HTMLButtonElement | null;
    const tldrOut = $(".perm-tldr-out", win) as HTMLElement | null;
    let tldrDone = false;
    tldrBtn?.addEventListener("click", async () => {
      if (!tldrOut) return;
      if (tldrDone) { tldrOut.hidden = !tldrOut.hidden; return; } // toggle once fetched
      tldrBtn.disabled = true;
      tldrOut.hidden = false;
      tldrOut.className = "perm-tldr-out";
      tldrOut.innerHTML = `${icon("refresh", 12, "spin")} <span>Explaining…</span>`;
      const r = await bridge.explainCommand(cmd).catch(() => null);
      tldrBtn.disabled = false;
      if (r?.ok && r.text) {
        tldrDone = true;
        tldrOut.innerHTML = `<div class="tldr-body">${esc(r.text)}</div>${r.model ? `<div class="tldr-model">${icon("spark", 10)} explained by ${esc(r.model)}</div>` : ""}`;
      } else {
        tldrOut.className = "perm-tldr-out tldr-err";
        tldrOut.innerHTML = `${icon("info", 12)} <span>${esc(r?.error ?? "Could not explain - the model was unreachable.")}</span>`;
      }
    });
  } else {
    const btns = e.options.map((o) => `<button class="perm-btn ${isAllowOpt(o.kind, o.optionId) ? "ok" : "no"}" data-oid="${esc(o.optionId)}">${esc(o.name)}</button>`).join("");
    win = el(`<div class="perm" data-streaming="1">
      <div class="perm-head">${icon("shield", 14)}<span>Approve tool call?</span></div>
      <div class="perm-body"><b>${esc(e.tool)}</b>${e.detail ? ` · <span class="perm-d">${esc(e.detail)}</span>` : ""}</div>
      <div class="perm-actions">${btns}</div>
      <div class="perm-result" hidden></div>
    </div>`);
  }
  const actions = $(".perm-actions", win) as HTMLElement;
  const result = $(".perm-result", win) as HTMLElement | null;
  let answered = false;
  const choose = (oid: string | null, label: string, ok: boolean) => {
    if (answered) return;
    answered = true;
    win.removeAttribute("data-streaming");
    void bridge.respondPermission(e.id, oid);
    if (e.egress || e.exec) {
      // Docked card: confirm with a brief toast, then remove it (and the dock when empty).
      const desc = e.exec
        ? (ok ? "The agent can run the command." : "The agent won't run that command.")
        : e.localFile
        ? (ok ? "The agent can open the file." : "The agent won't open that file.")
        : (ok ? "The agent can reach the site." : "The agent won't reach that site.");
      showToast({ title: ok ? "Allowed" : "Blocked", desc, actions: [{ label: "OK" }], timeout: 2200, ...(ok ? {} : { tone: "warn" as const }) });
      win.remove();
      const dock = $("#egressDock"); if (dock && !dock.children.length) dock.remove();
      return;
    }
    actions.hidden = true;
    if (result) { result.hidden = false; result.className = `perm-result ${ok ? "ok" : "no"}`; result.innerHTML = `${icon(ok ? "check" : "close", 13)}<span>${esc(label)}</span>`; }
  };
  actions.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest("[data-oid]") as HTMLElement | null;
    if (!b) return;
    const opt = e.options.find((o) => o.optionId === b.dataset.oid);
    const isDeny = (e.egress || e.exec) ? opt?.kind === "reject" : !isAllowOpt(opt?.kind, opt?.optionId);
    choose(b.dataset.oid!, isDeny ? "Denied" : "Allowed", !isDeny);
  });
  return { el: win, finalize: () => choose(null, "Denied (turn ended)", false) };
}
/** P-EGRESS.1: the dock above the composer where egress approval cards sit (not inline in the chat). */
function egressDock(): HTMLElement {
  let dock = $("#egressDock");
  if (!dock) {
    dock = el(`<div id="egressDock"></div>`);
    const wrap = $(".composer-wrap")!;
    wrap.insertBefore(dock, wrap.firstChild);
  }
  return dock;
}

// ── Subagent delegation card - P-TASK.1 (ADR-0028) ──
// When the agent hands work to an omp `task` subagent, show a distinct collapsible card (agent type +
// the assignment[s]) instead of a nameless "other" tool chip - Claude-Code-style Task surfacing.
// Spawns are background jobs; this card marks "running" and resolves when the turn ends (P-TASK.1
// surfaces the delegation; live per-subagent progress is a later increment).
// Animated "stick man peering through a looking glass", green neon - the live indicator on a
// subagent card (it's exploring/searching). The .look group (head + raised arm + magnifier) bobs
// slightly up and down while the subagent runs, as if scanning.
const LOOKER_SVG = `<svg class="looker" viewBox="0 0 26 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M9 9 L9 15"/>
  <path d="M9 15 L6 21"/>
  <path d="M9 15 L12.2 21"/>
  <g class="look">
    <circle cx="9" cy="5.2" r="2.3"/>
    <path d="M9 7.5 L9 9"/>
    <path d="M9 10 L12.8 8.6"/>
    <path d="M14.4 8.8 L12.8 8.6"/>
    <circle cx="16.4" cy="6.8" r="2.8"/>
  </g>
</svg>`;
// P-CHAT.A (ADR-0188): the pre-heading intro / a title-less block, rendered inline as markdown.
function appendIntro(container: HTMLElement, md: string): void {
  const intro = el(`<div class="answer-intro"></div>`);
  intro.innerHTML = renderMarkdown(md); enhanceCodeBlocks(intro);
  container.appendChild(intro);
}

// P-CHAT.A (ADR-0188): one collapsible titled section (default OPEN, so nothing is hidden by surprise).
function appendSection(container: HTMLElement, s: AnswerSection): void {
  const sec = el(`<div class="answer-sec open">
    <button class="answer-sec-head" type="button" aria-expanded="true">${icon("chevron", 13)}<span class="answer-sec-title"></span></button>
    <div class="answer-sec-body"></div>
  </div>`);
  ($(".answer-sec-title", sec) as HTMLElement).textContent = s.title;
  const bodyEl = $(".answer-sec-body", sec) as HTMLElement;
  bodyEl.innerHTML = renderMarkdown(s.body); enhanceCodeBlocks(bodyEl);
  const head = $(".answer-sec-head", sec) as HTMLButtonElement;
  head.addEventListener("click", () => { const open = !sec.classList.contains("open"); sec.classList.toggle("open", open); head.setAttribute("aria-expanded", String(open)); });
  container.appendChild(sec);
}

// P-CHAT.A section logic reused for ONE interleaved prose run: sectionize it, else render it inline. So a
// tool-using turn (P-CHAT.B) still gets collapsible sections inside each prose run between the chips.
function renderProse(container: HTMLElement, md: string): void {
  const secs = sectionizeAnswer(md);
  if (!shouldSectionize(secs)) { appendIntro(container, md); return; }
  for (const s of secs) { if (s.title === null) appendIntro(container, s.body); else appendSection(container, s); }
}

// P-CHAT.B (ADR-0189): one interleaved tool chip + its expandable drilldown. The chip reads at a glance
// (icon + tool word + compact detail + a +/- diffstat); clicking it reveals the written code / the edit diff
// (reusing the P-CHAT.1 `renderToolCode`) or, for a code-less tool, the step detail. Lazy (the panel fills on
// first open) + COLLAPSED by default. Chip text is set via textContent - never interpolated into HTML - so a
// hostile path / detail can't break out of the markup.
function createChipRow(chip: ToolChip, data: ChipData): HTMLElement {
  const stat = chip.diffstat ? ` <span class="add">+${chip.diffstat.add}</span> <span class="del">−${chip.diffstat.del}</span>` : "";
  const wrap = el(`<div class="answer-chip">
    <button class="tchip ${chip.kind}${chip.failed ? " fail" : ""}" type="button" aria-expanded="false">${icon(phaseIcon(chip.k), 12)}<span class="k"></span><span class="d"></span>${stat}<span class="tchip-chev">${icon("chevron", 12)}</span></button>
    <div class="tinline"></div>
  </div>`);
  const btn = $(".tchip", wrap) as HTMLButtonElement;
  const panel = $(".tinline", wrap) as HTMLElement;
  ($(".k", btn) as HTMLElement).textContent = chip.k;
  ($(".d", btn) as HTMLElement).textContent = chip.detail;
  const hasCode = !!data.code && (data.code.content !== undefined || data.code.patch !== undefined || data.code.oldText !== undefined || data.code.newText !== undefined);
  btn.addEventListener("click", () => {
    const opening = !panel.classList.contains("open");
    if (opening && !panel.dataset.filled) {
      if (hasCode && data.code) void renderToolCode(panel, data.code);
      else { panel.dataset.filled = "1"; const pre = el(`<pre class="tinline-detail"></pre>`); pre.textContent = data.detail || "(no details)"; panel.appendChild(pre); }
    }
    panel.classList.toggle("open", opening);
    btn.setAttribute("aria-expanded", String(opening));
  });
  return wrap;
}

// P-CHAT.C (ADR-0190): a SETTLED tool-using turn offers a "Generate engineering report" CTA in its run
// footer. Click POSTs the turn's OBSERVED telemetry to /api/eval/report (server reuses evals.ts to compute +
// save a Model-Evaluation brief), then swaps to an "Open in Reports" link that opens the saved report. Shown
// only when the turn made tool calls - a pure-text answer has nothing to evaluate. The run-meta + link text
// are set via textContent (never interpolated), so a hostile model id / path can't break out of the markup.
function appendRunReport(host: HTMLElement, turn: EvalReportTurn): void {
  const foot = el(`<div class="runfoot">
    <span class="runmeta"></span>
    <span class="spacer"></span>
    <button class="btn cta report-cta" type="button">${icon("report", 13)}<span class="rc-t">Generate engineering report</span></button>
    <span class="reportlink" hidden>${icon("report", 13)}<span class="rc-lbl"></span><a href="#" class="rc-open">Open in Reports</a></span>
  </div>`);
  const files = new Set(turn.tools.filter((t) => t.path && (t.add != null || t.del != null)).map((t) => t.path)).size;
  ($(".runmeta", foot) as HTMLElement).textContent = `· ${turn.tools.length} step${turn.tools.length === 1 ? "" : "s"} · ${files} file${files === 1 ? "" : "s"}`;
  ($(".rc-lbl", foot) as HTMLElement).textContent = "Run report ready — ";
  const btn = $(".report-cta", foot) as HTMLButtonElement;
  const link = $(".reportlink", foot) as HTMLElement;
  btn.addEventListener("click", async () => {
    btn.disabled = true; btn.classList.add("busy");
    btn.innerHTML = `${icon("refresh", 13, "spin")}<span class="rc-t">Generating…</span>`;
    const res = await bridge.evalReport(turn).catch(() => null);
    if (res && res.rel) {
      btn.hidden = true; link.hidden = false;
      ($(".rc-open", link) as HTMLElement).addEventListener("click", (ev) => { ev.preventDefault(); void openReportEntry("brief", res.rel!, res.title); });
    } else {
      btn.disabled = false; btn.classList.remove("busy");
      btn.innerHTML = `${icon("report", 13)}<span class="rc-t">Generate engineering report</span>`;
      showToast({ tone: "warn", title: "Could not generate report", desc: "The Model-Evaluation report couldn't be saved.", timeout: 2800 });
    }
  });
  host.append(foot);
}

// P-CHAT.A + P-CHAT.B: on SETTLE, transform the finished answer. If the turn made tool calls (`marks`) AND the
// chips GENUINELY interleave between prose blocks (P-CHAT.B.1), thread each one back into the prose as an
// expandable CHIP anchored where it fired (P-CHAT.B) and return true so the caller drops the now-redundant live
// activity window. Otherwise - a trivial answer, or a short/flat answer where every chip would just pile at the
// end - split on the model's own headings (P-CHAT.A) and KEEP the live activity window (its tool steps carry the
// diffstats + code drilldowns). Streaming stays one flow; `_md` holds the full markdown (copy/save untouched).
function renderAnswerBody(container: HTMLElement, md: string, marks?: readonly ToolMark<ChipData>[]): boolean {
  if (marks && marks.length) {
    const parts = interleaveChips(md, marks);
    if (chipsInterleave(parts)) {
      container.textContent = "";
      container.classList.add("answer-chipped");
      for (const p of parts) { if (p.kind === "prose") renderProse(container, p.md); else container.appendChild(createChipRow(p.chip, p.data)); }
      return true;
    }
  }
  const secs = sectionizeAnswer(md);
  if (!shouldSectionize(secs)) { container.innerHTML = renderMarkdown(md); enhanceCodeBlocks(container); return false; }
  container.textContent = "";
  container.classList.add("answer-sectioned");
  for (const s of secs) { if (s.title === null) appendIntro(container, s.body); else appendSection(container, s); }
  return false;
}

function createSubagentCard(e: Extract<ChatEvent, { type: "subagent" }>): { el: HTMLElement; finish: () => void } {
  const n = e.assignments.length;
  const body = (e.assignments.length ? e.assignments : [e.title]).map((a) =>
    `<div class="subagent-task">${icon("chevron", 11)}<span>${esc(a)}</span></div>`).join("");
  const win = el(`<div class="subagent open" data-streaming="1">
    <button class="subagent-head" type="button" aria-expanded="true">
      <span class="subagent-spin">${LOOKER_SVG}</span>
      <span class="subagent-cur">Delegated to <b>${esc(e.agent)}</b>${n > 1 ? ` · ${n} subtasks` : ""}</span>
      <span class="subagent-chev">${icon("chevron", 14)}</span>
    </button>
    <div class="subagent-body">${body}<div class="subagent-runs"></div></div>
  </div>`);
  const headBtn = $(".subagent-head", win) as HTMLButtonElement;
  const toggle = (open: boolean) => { win.classList.toggle("open", open); headBtn.setAttribute("aria-expanded", String(open)); };
  headBtn.addEventListener("click", () => toggle(!win.classList.contains("open")));

  // P-TASK.5 (ADR-0180): LIVE per-subagent activity. omp persists each subtask as its own session
  // transcript beside the parent session file; /api/subagents tails them into bounded step views.
  // While the delegation streams, poll and render one expandable row per run - the generated name,
  // a live "now" line, and the recent thinking/tool/text steps underneath. Every label is esc()'d
  // (transcript text is model/tool output - shown as DATA). Static assignment rows collapse away
  // once the real runs appear (the run's own assignment supersedes them).
  const runsBox = $(".subagent-runs", win) as HTMLElement;
  const openRuns = new Set<string>(); // user-expanded rows survive re-render
  const stepIcon = (k: string): string => (k === "thinking" ? icon("spark", 11) : k === "tool" ? icon("bolt", 11) : icon("info", 11));
  const renderRuns = (runs: { name: string; done: boolean; assignment: string; tools: number; steps: { kind: string; tool?: string; label: string }[] }[]): void => {
    if (!runs.length) return;
    win.querySelectorAll(".subagent-task").forEach((t) => t.remove()); // real runs supersede the static rows
    runsBox.innerHTML = runs.map((r) => {
      const last = r.steps[r.steps.length - 1];
      const now = last ? `${last.kind === "tool" ? `${esc(last.tool ?? "tool")} · ` : ""}${esc(last.label)}` : "starting…";
      const steps = r.steps.map((s) =>
        `<div class="sa-step sa-${esc(s.kind)}">${stepIcon(s.kind)}<span class="sa-step-tool">${s.kind === "tool" ? esc(s.tool ?? "") : ""}</span><span class="sa-step-label">${esc(s.label)}</span></div>`).join("");
      return `<div class="sa-run${openRuns.has(r.name) ? " open" : ""}${r.done ? " done" : ""}" data-run="${esc(r.name)}">
        <button class="sa-run-head" type="button">
          <span class="sa-dot${r.done ? " done" : ""}"></span>
          <span class="sa-name">${esc(r.name)}</span>
          <span class="sa-now">${now}</span>
          <span class="sa-meta">${r.tools} tool${r.tools === 1 ? "" : "s"}</span>
          <span class="subagent-chev">${icon("chevron", 12)}</span>
        </button>
        <div class="sa-steps">${r.assignment ? `<div class="sa-assign">${esc(r.assignment)}</div>` : ""}${steps || `<div class="sa-step sa-text">${icon("info", 11)}<span class="sa-step-label">no activity yet</span></div>`}</div>
      </div>`;
    }).join("");
    runsBox.querySelectorAll<HTMLElement>(".sa-run-head").forEach((h) => h.addEventListener("click", () => {
      const row = h.parentElement!;
      const name = row.dataset.run ?? "";
      row.classList.toggle("open");
      if (row.classList.contains("open")) openRuns.add(name); else openRuns.delete(name);
    }));
  };
  const refreshRuns = async (): Promise<void> => {
    const v = await bridge.subagents().catch(() => null);
    if (v?.runs) renderRuns(v.runs as Parameters<typeof renderRuns>[0]);
  };
  void refreshRuns();
  const runsTimer = window.setInterval(() => { if (win.isConnected) void refreshRuns(); }, 2500);

  let done = false;
  return {
    el: win,
    finish() {
      if (done) return; done = true;
      window.clearInterval(runsTimer);
      void refreshRuns(); // one final tail so the card shows each run's ending state
      // P-CHAT.B.1: keep the delegation card EXPANDED on settle so each subagent's thinking/tools stay
      // visible after the turn (P-TASK.5 collapsed it, which hid the detail); the user can still fold it.
      win.removeAttribute("data-streaming"); win.classList.add("done");
    },
  };
}

async function send(): Promise<void> {
  const ta = $("#input") as HTMLTextAreaElement;
  const text = ta.value.trim();
  // P-VISION.1 (ADR-0136): capture any staged image attachments for this turn.
  const atts = state.attachments.slice();
  const images = promptImageBlocks(atts);
  if (!text && images.length === 0) return;
  // P-CMD.1: a user-authored SKILL-mode "/" command ACTIVATES its body as a persistent instruction (no turn
  // sent) — same behaviour as a bundled skill. Handle it before we open an assistant node.
  const cmdTok = /^\/([a-z][a-z0-9-]{0,31})\b/i.exec(text)?.[1]?.toLowerCase();
  if (cmdTok && !state.streaming) {
    const uc = state.userCommands.find((c) => c.name === cmdTok);
    if (uc && uc.mode === "skill") { ta.value = ""; autosize(ta); setSendEnabled(); void activateUserCommandSkill(uc); return; }
  }
  // P-FIGMA.1 (ADR-0154): typing `/figma` opens the secure import form (URL + token) rather than sending text.
  if (/^\/figma\b/i.test(text)) { ta.value = ""; autosize(ta); setSendEnabled(); openFigmaForm(); return; }
  // What actually goes to the model. `/agent` and `/command` kick off builder interviews (the chat agent,
  // steered by the frozen policies, asks what to build then calls the matching tool); a SEND-mode user
  // command expands its body (+ any typed args). The TRANSCRIPT still shows exactly what the user typed.
  let sendText = resolveSendText(text, cmdTok);
  // P-CMD.2: "/" commands work ANYWHERE in the body — but only when NO start-anchored command consumed
  // the text above (start-anchored keeps the P-CMD.1 args contract, and never re-scanning an expanded body
  // keeps expansion non-recursive). Embedded skill-mode tokens activate their skills and are stripped.
  if (sendText === text) {
    const inline = expandInlineCommands(text, state.userCommands);
    for (const name of inline.skillNames) {
      const uc = state.userCommands.find((c) => c.name === name);
      if (uc) void activateUserCommandSkill(uc);
    }
    if (!inline.text && images.length === 0) {
      // the prompt was ONLY skill tokens — skills are active for the next turn; nothing to send now
      if (inline.skillNames.length) { ta.value = ""; autosize(ta); setSendEnabled(); return; }
    }
    sendText = inline.text || text;
  }
  // P-ACP.4: a turn is already running → pre-stage this prompt instead of dropping it. It auto-sends
  // when the current turn ends (naturally or via Stop). One slot - a newer entry replaces the old.
  if (state.streaming) { state.queued = text; ta.value = ""; autosize(ta); renderQueued(); setSendEnabled(); return; }
  // First message of the app session: auto-collapse the sessions panel (Claude-Code style) so the
  // chat takes the focus - the nav hamburger (#sideToggle) reopens history on demand. Done once so
  // we never fight a user who reopens it mid-chat.
  if (!autoCollapsedSessions) { autoCollapsedSessions = true; if (!state.sidebarCollapsed) toggleSidebar(true); }
  state.lastPrompt = text; // remembered so an Approve & retry can re-send it
  ta.value = ""; autosize(ta);
  state.attachments = []; renderComposerThumbs(); // clear the thumb strip on send (also refreshes send-enabled)
  addMessage("user", text, atts);
  state.streaming = true; state.streamStartedAt = Date.now(); setSendEnabled();

  const node = addMessage("assistant", "");
  const textEl = $(".text", node) as HTMLElement;
  textEl.innerHTML = "";
  // P10.1 response activity HUD: live MM:SS timer + semantic phase + running token-cost.
  const hud = el(`<div class="hud streaming"><span class="hud-ic">${icon("bolt", 12)}</span><span class="hud-t">00:00</span><span class="hud-sep">·</span><span class="hud-phase"></span><span class="hud-tps"></span><span class="hud-meta"></span></div>`);
  const streamEl = el(`<div class="stream"></div>`);
  textEl.append(streamEl, hud); // status sits BELOW the line that's filling in
  streamEl.innerHTML = `<span class="cursor"></span>`;
  // The consolidating activity window lives between the answer and the HUD; created lazily
  // on the first tool event so a pure-text turn shows nothing extra.
  let thoughts: ThoughtsWin | null = null;
  let reasoning: ReasoningWin | null = null; // the live "thinking" block (above the answer)
  const permCards: { el: HTMLElement; finalize: () => void }[] = []; // Ask-mode approval prompts
  const subCards: { el: HTMLElement; finish: () => void }[] = []; // P-TASK.1 subagent delegation cards
  const marks: ToolMark<ChipData>[] = []; // P-CHAT.B (ADR-0189): tool calls anchored by answer-buffer length, interleaved into the answer on settle
  const dropThoughtsWindow = () => thoughts?.el.remove(); // once chips carry the activity, the live thoughts window is redundant
  const failures: { tool: string; reason: string; cmd?: string }[] = []; // P-CHAT.C (ADR-0190): this turn's failed (non-quarantined) tool calls, feed the eval report's fail-rate / wasted-token metrics
  let buf = "";
  const t0 = Date.now();
  // Cold start: the timer is already ticking but nothing has arrived - show an intent-aware
  // "warming" line so the user always sees something meaningful before the first token/tool.
  // The think/write lines are picked ONCE per turn (stable, not reshuffling on every token).
  const intent = classifyIntent(text);
  const thinkLine = pickLine("think", intent);
  const writeLine = pickLine("write", intent);
  let phase = pickLine("warm", intent), sawTool = false, tok = 0, cost = 0;
  // P-TPS.1 (ADR-0044): output-token speedometer for THIS turn. startTTFT now (at
  // submit), start() so deltas count; the first content delta calls stopTTFT() to
  // freeze TTFT and align the rate clock to first-token. Estimate strategy - ACP
  // deltas are text chunks, and the desktop has no per-delta provider usage
  // (usage_update is CONTEXT fill, not per-turn output), so we approximate locally.
  const tps = new TokenSpeedEngine({ countStrategy: "estimate" });
  tps.startTTFT(); tps.start();
  let firstDelta = true;
  const countDelta = (s: string) => { if (firstDelta) { tps.stopTTFT(); firstDelta = false; } tps.recordDelta(s); };
  const phaseEl = $(".hud-phase", hud) as HTMLElement;
  const tpsEl = $(".hud-tps", hud) as HTMLElement;
  const setPhase = (p: string) => {
    if (p === phase) return;
    phase = p;
    // Brief crossfade on phase change - GPU-friendly (opacity only), respects reduced-motion via CSS.
    phaseEl.classList.remove("swap"); void phaseEl.offsetWidth; phaseEl.classList.add("swap");
    phaseEl.textContent = p;
  };
  const paintHud = () => {
    ($(".hud-t", hud) as HTMLElement).textContent = fmtClock(Date.now() - t0);
    if (phaseEl.textContent !== phase) phaseEl.textContent = phase;
    // The streaming OUTPUT count - what the model is generating right now, with no
    // system prompt / cached prefix in it (the user's "minus the whole prompt" ask).
    const out = tps.tokenCount;
    // The per-turn OUTPUT count. (Tokens/s was removed - it read as noise on the done line.)
    tpsEl.textContent = out > 0 ? `· ${fmtNum(out)} tokens out` : "";
    // The CONTEXT figure (window fill + turn cost) genuinely includes the prompt -
    // labelled "context" so it's never mistaken for the per-turn output above. Cost
    // is shown to the cent ($0.00) - the sub-cent precision read as noise.
    ($(".hud-meta", hud) as HTMLElement).textContent = tok ? `· ${fmtNum(tok)} context · ~$${cost.toFixed(2)}` : "";
  };
  phaseEl.textContent = phase;
  paintHud();
  const timer = window.setInterval(paintHud, 1000);
  let finished = false;
  const finishHud = () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    if (tps.isStreaming) tps.stop(); // freeze the readout at the final avg tok/s
    const ic = $(".hud-ic", hud); if (ic) ic.innerHTML = icon("check", 12);
    hud.classList.remove("streaming"); hud.classList.add("done");
    setPhase("Done"); paintHud();
    reasoning?.finish(Date.now() - t0);
    thoughts?.finish(Date.now() - t0);
    subCards.forEach((c) => c.finish());
    permCards.forEach((c) => c.finalize()); // any unanswered prompt = denied (matches server fail-close)
  };
  // P-CHAT.C (ADR-0190): assemble this turn's OBSERVED telemetry (tokens/cost, tool calls + diffstats,
  // failures) into the shape /api/eval/report consumes; the run-footer CTA POSTs it to build the report.
  const buildEvalTurn = (): EvalReportTurn => ({
    runId: `run-${t0}`,
    model: state.model || "model",
    ctxTokens: tok,
    outputTokens: tps.tokenCount,
    totalTokens: tok + tps.tokenCount,
    costUsd: cost,
    tools: marks.map((m) => ({ name: m.chip.k, path: m.data.code?.path, add: m.chip.diffstat?.add, del: m.chip.diffstat?.del })),
    failures: failures.slice(),
    subagents: subCards.length,
    when: new Date(t0).toISOString().slice(0, 10),
  });
  // P-CHAT.C.1: the report evaluates WRITTEN work, so only offer it when the turn actually wrote a file /
  // code (an edit/write with a diffstat). A read/search/bash-only or pure-text turn has nothing to evaluate.
  const maybeAppendReport = () => {
    const turn = buildEvalTurn();
    if (turn.tools.some((t) => t.path && (t.add != null || t.del != null))) appendRunReport(textEl, turn);
  };
  let slowNoticed = false; // P-STALL.1: the explanatory toast fires once per turn; the phase line keeps updating
  const onEvent = (e: ChatEvent) => {
    if (e.type === "token") { reasoning?.finish(Date.now() - t0); buf += e.text; countDelta(e.text); if (!sawTool) setPhase(writeLine); streamEl.innerHTML = renderMarkdown(buf) + `<span class="cursor"></span>`; paintHud(); scrollChat(); }
    else if (e.type === "thinking") {
      // First reasoning chunk: spin up the live thinking block above the answer.
      if (!reasoning) { reasoning = createReasoning(); streamEl.before(reasoning.el); }
      if (!sawTool) setPhase(thinkLine);
      countDelta(e.text); // thinking tokens ARE output - count them in the readout
      reasoning.push(e.text); paintHud(); scrollChat();
    }
    else if (e.type === "tool") {
      sawTool = true; setPhase(phaseForTool(e.name, e.detail)); paintHud();
      if (!thoughts) { thoughts = createThoughts(); streamEl.after(thoughts.el); } // window sits below the answer
      thoughts.step(e.name, e.detail, e.code);
      // P-CHAT.B (ADR-0189): also record the call as a mark anchored at the current answer-buffer length, so it
      // can be threaded back into the settled answer as a chip where it fired (zero visual change to the live window).
      marks.push({ offset: buf.length, chip: toolChip(e.name, e.detail, e.code), data: { code: e.code, detail: e.detail } });
      scrollChat();
    }
    else if (e.type === "subagent") {
      sawTool = true; setPhase(`Delegating to ${e.agent}…`); paintHud();
      const card = createSubagentCard(e);
      subCards.push(card);
      streamEl.after(card.el); // delegation card sits just below the answer
      scrollChat();
    }
    else if (e.type === "permission") {
      setPhase("Needs approval"); paintHud();
      const card = createPermissionCard(e);
      permCards.push(card);
      // P-EGRESS.1 / P-EXEC.1: egress + exec approvals dock directly above the prompt bar; normal tool
      // prompts stay inline.
      if (e.egress || e.exec) egressDock().appendChild(card.el);
      else { hud.before(card.el); scrollChat(); }
    }
    else if (e.type === "block") { if (e.quarantined === false) failures.push({ tool: e.tool, reason: e.reason, cmd: e.command }); onBlock(e); } // P-CHAT.C (ADR-0190): a failed (not quarantined) tool call feeds the run's eval metrics
    else if (e.type === "preview-available") onPreviewAvailable(e.path);
    else if (e.type === "preview-activity") flashPreviewTesting(e.label); // P-PREVIEW.6a (ADR-0153)
    else if (e.type === "design-available") showToast({ tone: "ok", title: "DESIGN.md is ready", desc: "The agent wrote your design invariants — review + edit them in the IDE.", actions: [{ label: "Review in the IDE", kind: "ok", run: () => void openDesignInIde() }], timeout: 10000 }); // P-FIGMA.2 (ADR-0154)
    else if (e.type === "agent-builder-open") openAgentBuilderWithSpec(e.spec); // P-AGENT.8.2
    else if (e.type === "slash-command-created") void onSlashCommandCreated(e.command); // P-CMD.1
    else if (e.type === "usage") { tok = e.used; cost = e.cost; state.liveUsage = { used: e.used, size: e.size, cost: e.cost }; paintHud(); renderStatus(); renderMetricsRail(); }
    // P-STALL.1 (ADR-0186): the provider is SILENT (overload/rate-limit) - keep the wait visible. The
    // phase line updates each notice; the next real token/tool event replaces it naturally.
    else if (e.type === "slow") {
      setPhase(slowPhaseLabel(e.waitedMs)); paintHud();
      if (!slowNoticed) { slowNoticed = true; const c = slowToastCopy(e.waitedMs, TURN_PATIENCE_MS); showToast({ tone: "warn", title: c.title, desc: c.desc, timeout: 9000 }); }
    }
    else if (e.type === "done") { if (e.text && e.text.length > buf.length) buf = e.text; /* reconcile a lossy stream with the server's full reply */ const chipped = renderAnswerBody(streamEl, buf, marks); /* P-CHAT.A sections / P-CHAT.B chips */ (node as MsgNode)._md = buf; finishHud(); if (chipped) dropThoughtsWindow(); /* chips now carry the activity */ maybeAppendReport(); /* P-CHAT.C: settled-turn report CTA */ state.streaming = false; setSendEnabled(); clearPreviewTesting(); }
  };
  try { await bridge.sendPrompt(sendText, onEvent, images); }
  finally {
    (node as MsgNode)._md = buf;
    if (state.streaming) { const chipped = renderAnswerBody(streamEl, buf, marks); /* P-CHAT.A sections / P-CHAT.B chips */ finishHud(); if (chipped) dropThoughtsWindow(); maybeAppendReport(); /* P-CHAT.C: settled-turn report CTA */ state.streaming = false; setSendEnabled(); } else { finishHud(); }
    void renderSessions(); void refreshBudget(false); void syncMode();
    scheduleKnowledgeRefresh(); // #54 follow-up: new facts appear in the open KG without close/reopen
    // P-ACP.4: the turn ended - fire off any pre-staged prompt now (the composer is idle again).
    if (state.queued) { const q = state.queued; state.queued = null; renderQueued(); const ta2 = $("#input") as HTMLTextAreaElement; ta2.value = q; setSendEnabled(); void send(); }
  }
}

function onBlock(e: Extract<ChatEvent, { type: "block" }>): void {
  // A generic tool rejection (omp couldn't run a call for non-security reasons) is NOT a
  // security event - show a quiet, neutral chip and stop. Only the gate's authoritative
  // quarantine (quarantined !== false) gets the loud treatment + Security-panel review.
  if (e.quarantined === false) {
    // P-TOOLFAIL.1/.2 (ADR-0093/0163): a tool that failed or didn't run — NOT a security block.
    // Consecutive failures collapse into ONE small toolbox badge; click = the "Tool Call Actions"
    // list (command attempted + full error). Never mistaken for a denial — the gate's quarantine
    // keeps its own loud .evt.block path below.
    addToolFailure({ tool: e.tool, reason: e.reason, command: e.command, detail: e.detail });
    return;
  }
  const review = () => { OPEN.add("sec.live"); focusInspector("security"); void refresh(); };
  addEvent(`<div class="evt block" data-tip="Quarantined|Click to review in the Security panel" data-tip-icon="shield">
    ${icon("shield", 15)}<span>Blocked <b>${esc(e.tool)}</b> ·</span><span class="reason">${esc(e.reason)}</span></div>`)
    .addEventListener("click", review);
  showToast({
    title: "Tool call quarantined",
    desc: `${e.reason}.`,
    meta: `tool=${e.tool} · severity=${e.severity}${e.findings ? " · " + e.findings : ""}`,
    actions: [
      { label: "Review", run: review },
      { label: "Dismiss", kind: "danger" },
    ],
  });
  void refresh(); // pull the new block into the panels + badge
}

// Grow the composer to fit the prompt, up to 3 rows; beyond that the textarea scrolls internally so
// a long prompt stays readable without the composer taking over the screen. Derived from the live
// line-height + padding (border-box: scrollHeight and the set height both include padding).
function autosize(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  const cs = getComputedStyle(ta);
  const line = parseFloat(cs.lineHeight) || 22;
  const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const max = Math.round(line * 3 + pad);
  ta.style.height = Math.min(ta.scrollHeight, max) + "px";
  ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
}
function setSendEnabled(): void {
  const ta = $("#input") as HTMLTextAreaElement;
  const btn = $("#send") as HTMLButtonElement;
  // P-ACP.4: while a turn runs the button is a Stop control (always enabled) that interrupts; otherwise
  // it's Send (enabled only with text). The composer stays usable so a prompt can be pre-staged.
  if (state.streaming) {
    btn.disabled = false;
    btn.classList.add("stop");
    btn.innerHTML = icon("square", 16);
    btn.setAttribute("data-tip", "Stop|Interrupt the reply + tool calls");
  } else {
    btn.disabled = !ta.value.trim() && state.attachments.length === 0; // P-VISION.1: image-only messages can send
    btn.classList.remove("stop");
    btn.innerHTML = icon("send", 18);
    btn.setAttribute("data-tip", "Send|Enter");
  }
}
/** P-ACP.4: show/refresh the pre-staged ("queued") prompt chip above the composer. */
function renderQueued(): void {
  let chip = $("#queuedChip");
  if (!state.queued) { chip?.remove(); return; }
  if (!chip) {
    const row = $("#input")!.closest(".composer-row") ?? $("#input")!.parentElement!;
    chip = el(`<div id="queuedChip" class="queued-chip"></div>`);
    row.before(chip); // sits above the composer row, inside .composer-wrap
  }
  // P-IDE.1d: compact, subdued, right-aligned pill - a small "Queued" tag, the prompt preview, and a
  // delete (✕) that removes the pre-staged prompt before it sends.
  chip.innerHTML = `<div class="q-pill" data-tip="Sends automatically when the current turn ends"><span class="q-label">Queued</span><span class="q-text"></span><button class="q-cancel" data-tip="Delete queued prompt">${icon("close", 12)}</button></div>`;
  ($(".q-text", chip) as HTMLElement).textContent = state.queued.slice(0, 90);
  ($(".q-cancel", chip) as HTMLElement).addEventListener("click", () => { state.queued = null; renderQueued(); ($("#input") as HTMLTextAreaElement)?.focus(); });
}
/** P-ACP.4: Stop - interrupt the running turn. omp's session/cancel ends the turn, so the streaming
 *  `done`/finally path flips `streaming` off and fires any pre-staged prompt. */
async function stopTurn(): Promise<void> {
  if (!state.streaming) return;
  // P-GOAL.2: a running /goal loop is cancelled at the LOOP level (halt iterations + abort the turn);
  // an ordinary turn just cancels the turn.
  try { await (goalLoopRunning ? bridge.cancelGoal() : bridge.cancelChat()); } catch { /* best-effort; it still settles */ }
}

// ───────────────────────── inspector ─────────────────────────
// ADR-0021: detect active security blocks that require triage.
function hasActiveBlocks(): boolean {
  const sec = state.security;
  if (!sec) return false;
  const liveQ = sec.live?.quarantined?.length ?? 0;
  const approvals = sec.approvals?.length ?? 0;
  return liveQ + approvals > 0;
}
function focusInspector(tab: Tab): void {
  closeSettings();
  state.inspectorTab = tab;
  // Expanding from the collapsed metrics rail on an EXPLICIT tab click: clear the rail state directly.
  // Do NOT route through setInspectorRail() here - its ADR-0021 active-blocks override would hijack the
  // chosen tab (e.g. clicking Logs/Memory while blocks exist would snap to Security). The passive expand
  // gesture (#railExpand) still calls setInspectorRail(false), so that override is preserved there.
  if (state.inspectorRail) { state.inspectorRail = false; $("#inspector")?.classList.remove("rail"); }
  $$(".insp-tab").forEach((t) => t.classList.toggle("active", (t as HTMLElement).dataset.insp === tab));
  $$(".rail-btn").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.rail === tab));
  lastInspHash = ""; renderInspector();
}

// #11 perceived-latency: placeholder chips + rows shown on the inspector's very first
// paint, before the first 4s poll completes (state.lastOk === 0). Swaps to real content
// - or the genuine empty-state - the moment refresh() lands or fails.
function inspSkeleton(): string {
  return `<div class="skel-chips">${Array.from({ length: 4 }, () => `<div class="skel skel-chip"></div>`).join("")}</div>`
    + `<div class="skel-group">${Array.from({ length: 5 }, () => `<div class="skel skel-row"></div>`).join("")}</div>`;
}
function renderInspector(): void {
  if (state.inspectorTab === "dev") {
    const html = devHtml(state.dev);
    const hash = "dev" + html.length + html.slice(0, 80);
    if (hash === lastInspHash) return;
    lastInspHash = hash;
    const body = $("#inspBody")!; const top = body.scrollTop; body.innerHTML = html; body.scrollTop = top;
    return;
  }
  const snap = state.inspectorTab === "security" ? state.security : state.memory;
  // First-load only: no successful poll yet AND no snapshot for this tab.
  if (state.lastOk === 0 && snap === null) {
    const body = $("#inspBody")!;
    const skelHash = "skel:" + state.inspectorTab;
    if (skelHash === lastInspHash) return;
    lastInspHash = skelHash;
    body.innerHTML = inspSkeleton();
    return;
  }
  const html = state.inspectorTab === "security" ? securityHtml(state.security) : memoryHtml(state.memory);
  const hash = state.inspectorTab + html.length + html.slice(0, 64);
  if (hash === lastInspHash) return;
  lastInspHash = hash;
  const body = $("#inspBody")!;
  const top = body.scrollTop;
  body.innerHTML = html;
  body.scrollTop = top;
  const info = $("#secInfo");
  if (info) attachRichTip(info, RICHTIP_DUCKDB);
}

// ───────────────────────── quick-metrics rail (collapsed inspector) ─────────────────────────
// P-REPORT.4: the tiles read NEUTRAL by default and only bloom into their own accent color for a
// beat when their value CHANGES (so color = "this just moved"), and a tile that needs triage
// (findings / quarantine > 0) gets a slow clockwise light sweep. We remember the last-rendered
// values to detect the delta, and skip the DOM write when nothing moved so the sweep animation on
// an attention tile keeps running smoothly instead of restarting every poll.
const prevMetrics: Record<string, string> = {};
let lastRailSig = "";
let railPrimed = false; // first paint must not flash every tile as "changed"
function renderMetricsRail(): void {
  const tiles = $("#railTiles");
  if (!tiles) return;
  const s = state.memory?.session, lu = state.liveUsage, sec = state.security;
  const cur = lu ? lu.used : (s?.current ?? 0);
  const turns = s?.turns ?? 0;
  const hit = s?.cache.hit ?? 0;
  const avg = turns ? Math.round(cur / turns) : 0;
  // The /api/security payload is `{ ...(snapshot ?? {}), live }` - so when the DuckDB snapshot is null
  // (fresh machine with no obs DB yet, OR the DB momentarily held read-write by the live gate DURING a
  // turn), `findings`/`quarantine` are ABSENT while `state.security` is still a truthy `{ live }` object.
  // A bare `sec.findings.reduce(...)` then threw a TypeError that aborted this whole render every poll,
  // freezing the rail at its initial zeros (renderInspector/renderStatus survived - they guard the same
  // way below). Coalesce to empty so the rail keeps painting the live/session tiles regardless.
  const findings = (sec?.findings ?? []).reduce((a, r) => a + Number(r.n || 0), 0);
  const quar = sec?.quarantine?.length ?? 0;
  const ca = state.codeActivity; // ADR-0030 P-CODE.1: this month's repo activity

  type T = { n: string; label: string; cls: string; tip: string; attn?: boolean };
  const rows: T[] = [
    { n: `${Math.round(hit * 100)}%`, label: "savings", cls: "g", tip: "How much the prompt cache saves you. The AI re-reads the same background every turn; that repeated part is billed at about one-tenth the price - roughly 90% off. This is how much of this turn was that cheap repeat, so a higher number means a smaller bill." },
    { n: fmtNum(avg), label: "avg/turn", cls: "c", tip: "Average tokens per turn" },
    { n: fmtNum(cur), label: "context", cls: "b", tip: "Context tokens in use this turn" },
    { n: String(turns), label: "turns", cls: "b2", tip: "Agent turns in this session" },
    ...(ca && ca.totals.files > 0 ? [{ n: `+${fmtNum(ca.totals.added)}`, label: "lines", cls: "g", tip: `Workspace activity this month (${ca.month}): ${fmtNum(ca.totals.added)} lines added, ${fmtNum(ca.totals.deleted)} deleted across ${fmtNum(ca.totals.files)} files. This is REPO activity (all commits), not AI-authored lines.` } as T] : []),
    { n: String(findings), label: "findings", cls: "m", tip: "Scanner findings so far", attn: findings > 0 },
    { n: String(quar), label: "quarantd", cls: "r", tip: "Artifacts currently quarantined", attn: quar > 0 },
    // P-TRIV.1 (ADR-0174): lifetime Trivia Wire score - the LAST tile, so it sits just above the
    // gate-active corner. Only appears once the user has actually played (no dead zero tile).
    ...((): T[] => {
      const tv = triviaEnabled() && triviaGame ? triviaGame.state() : null;
      return tv && tv.answered > 0
        ? [{ n: fmtNum(tv.score), label: "trivia", cls: "c", tip: `Trivia Wire lifetime score: ${fmtNum(tv.correct)}/${fmtNum(tv.answered)} correct. Streaks multiply points up to x3. The ticker appears in the status bar while the agent works.` }]
        : [];
    })(),
  ];

  // Signature: value + attention state per tile. Unchanged → leave the DOM alone (keep the pulse smooth).
  const sig = rows.map((t) => `${t.label}:${t.n}:${t.attn ? 1 : 0}`).join("|");
  if (sig === lastRailSig) return;
  lastRailSig = sig;

  // Same neutral look at rest; a tile that just CHANGED gets the game-like clockwise racing pulse + shine.
  tiles.innerHTML = rows.map((t) => {
    const changed = railPrimed && prevMetrics[t.label] !== undefined && prevMetrics[t.label] !== t.n;
    prevMetrics[t.label] = t.n;
    const cl = `tile ${t.cls}${changed ? " changed" : ""}${t.attn ? " attn" : ""}`;
    return `<div class="${cl}" data-tip="${esc(t.label)}|${esc(t.tip)}" data-tip-side="left"><div class="n">${esc(t.n)}</div><div class="l">${esc(t.label)}</div></div>`;
  }).join("");
  railPrimed = true;
}
function setInspectorRail(rail: boolean): void {
  state.inspectorRail = rail;
  $("#inspector")!.classList.toggle("rail", rail);
  if (rail) { renderMetricsRail(); return; }
  // ADR-0021: expanding from rail → if active blocks exist, override to Security tab
  if (hasActiveBlocks() && state.inspectorTab !== "security") {
    focusInspector("security");
    return;
  }
  lastInspHash = ""; renderInspector();
}

// ───────────────────────── settings page ─────────────────────────
// OAuth here signs in a SUBSCRIPTION/CLI tier; the full commercial catalog comes from an API key.
// Spell that out where it bites (OpenAI/Gemini), and steer Perplexity to its working key path.
const PROV_HINTS: Record<string, string> = {
  elevenlabs: `Cloud voice (paid) for read-aloud, the podcast, and speech-to-text. Get a key at <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener">elevenlabs.io → API keys ↗</a>. Billed per character: a brief/AAR narration (~2-3k chars) runs <b>~$0.10-$0.30</b>; one reply is a few cents. Audio leaves the device, so for air-gap/DoD use offline Whisper / Kokoro below.`,
  openai: "OAuth signs in your ChatGPT / Codex subscription (those models). For the full commercial catalog - gpt-4o, o-series - add an OPENAI_API_KEY below.",
  google: "OAuth uses the Gemini CLI / Code Assist tier. For the full commercial Gemini catalog, add a GEMINI_API_KEY below.",
  anthropic: "OAuth signs in your Claude subscription. For pay-as-you-go API access, add an ANTHROPIC_API_KEY below.",
  xai: "OAuth signs in via your X / xAI account. Which Grok models are available depends on your plan (Premium+, SuperGrok, or API). If models appear but return empty replies, check your subscription at <b>console.x.ai</b>.",
  perplexity: "Paste a Perplexity API key for Sonar models. (Pro/Max OAuth is interactive email-OTP - it can't run through this app, so use a key here.)",
};
function provCard(p: ProviderAuth): string {
  const last4 = esc(p.keyLast4 ?? "");
  const status =
    (p.oauthActive ? `<span class="abadge ok">${icon("check", 11)} OAuth active</span>` : "") +
    (p.keySet ? `<span class="abadge set">key ••${last4}</span>` : "") +
    (!p.oauthActive && !p.keySet ? `<span class="abadge none">not set</span>` : "");
  // The hint text goes in ONE <span> so rich markup (<b>/<a>) stays inline instead of becoming separate
  // flex items in the flex `.prov-hint` (that squished multi-tag hints into clipped narrow columns).
  const hint = PROV_HINTS[p.id] ? `<div class="prov-hint">${icon("info", 11)}<span>${PROV_HINTS[p.id]}</span></div>` : "";
  const oauthRow = p.canOauth
    ? `<div class="prov-row">${p.oauthActive
        ? `<span class="prov-id">${esc(p.oauthIdentity ?? "connected")}</span><button class="btn-mini danger" data-oauth-logout="${esc(p.oauthId)}">Disconnect</button>`
        : `<button class="btn-mini ok" data-oauth="${esc(p.oauthId)}">${icon("expand", 12)} Connect via OAuth</button>`}</div>`
    : "";
  return `<div class="prov">
    <div class="prov-h"><span class="prov-name">${esc(p.name)}</span><span class="prov-status">${status}</span></div>
    <div class="prov-body">${oauthRow}
      <div class="prov-row">
        <input type="password" class="prov-key" data-env="${esc(p.env)}" placeholder="${p.keySet ? `saved ••${last4} - type to replace` : `Paste ${esc(p.env)}…`}" />
        <button class="btn-mini ok" data-savekey="${esc(p.env)}">${icon("check", 12)} Save</button>
        ${p.keySet ? `<button class="btn-mini" data-clearkey="${esc(p.env)}">Clear</button>` : ""}
      </div>${hint}</div></div>`;
}
// AskSage monthly tokens - fully dynamic from the Civ API (no manual limit). `used` is this
// account's usage; `remaining` is what's left accounting for BOTH your and your org's caps; the
// real allowance is used + remaining. Refreshed on open + the 5-min cadence (no boxes to set).
function quotaDisplay(t: typeof state.asksageTokens): string {
  if (!t) return `<div class="aq"><div class="aq-head"><span>AskSage Monthly Token Usage</span></div>
    <div class="aq-pct">${icon("refresh", 11, "spin")} reading usage from the gov gateway…</div></div>`;
  const { used, limit, remaining } = t;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  // Usage ramp: green ≤50%, yellow 51–90%, red 91–100%. --gc tints the bar's hover glow to match.
  const barColor = pct > 90 ? "var(--red)" : pct > 50 ? "var(--amber)" : "var(--green)";
  return `<div class="aq">
    <div class="aq-head"><span>AskSage Monthly Token Usage</span>
      <button class="info-dot aq-info" data-tip="AskSage monthly token usage|Live from the AskSage Civ API. Used = this account's usage this month; the allowance is used + tokens remaining (the remaining figure already accounts for both your limit and your organization's pool). Replenishes on the 1st." data-tip-side="top">${icon("info", 12)}</button>
      <b class="aq-val">${fmtNum(used)} / ${fmtNum(limit)}</b></div>
    <div class="aq-bar"><i style="width:${pct.toFixed(1)}%;background:${barColor};--gc:${barColor}"></i></div>
    <div class="aq-pct">${Math.round(pct)}% used${remaining != null ? ` · <b>${fmtNum(remaining)}</b> left` : ""}</div>
  </div>`;
}

// Gov datasets (knowledge bases) - shown in gov-only mode. Selectable: the chosen
// ones ground the "AskSage RAG" model's answers via /query. Names are tidied for
// display (the raw `user_custom_<n>_<name>_content` form is kept in the tooltip).
function datasetsSection(list: string[] | null): string {
  if (!list) return "";
  const sel = new Set(state.asksage?.datasets ?? []);
  const tidy = (d: string) => d.replace(/^user_custom_\d+_/, "").replace(/_content$/, "").replace(/[_-]+/g, " ").trim();
  const items = list.map((d) => `<span class="ds-chip${sel.has(d) ? " on" : ""}" data-ds="${esc(d)}" data-tip="${esc(d)}|Click to ${sel.has(d) ? "remove from" : "use for"} RAG grounding">${sel.has(d) ? icon("check", 11) : ""}${esc(tidy(d))}</span>`).join("");
  // Native AskSage persona for the RAG route: AskSage applies it server-side on
  // /query (persona:<id>) - an id, not injected text, so no scan is needed here
  // (distinct from the composer persona, which delimits scanned text into any model).
  const pid = state.asksage?.persona ?? "";
  const pdesc = state.personas.find((x) => x.id === pid)?.description ?? "";
  const plabel = pid ? `#${pid}${pdesc ? " · " + tidy(pdesc).slice(0, 28) : ""}` : "None";
  const personaRow = `<div class="ds-prow">
    <span class="ds-plbl">${icon("user", 12)} RAG persona
      <button class="info-dot" data-tip="RAG persona|Applied server-side by AskSage on grounded /query turns (persona id). Unlike the composer persona - which adds scanned, delimited guidance to any model - no text enters your prompt here, so no scan is needed.">${icon("info", 11)}</button></span>
    <button class="ds-pbtn${pid ? " on" : ""}" id="ragPersonaBtn">${esc(plabel)} ${icon("chevron", 12)}</button></div>`;
  return accordion("set.datasets", "Gov datasets & persona", `${sel.size}/${list.length} selected`,
    `<div class="ds-note">Pick knowledge bases to ground answers on, then chat with the <b>AskSage RAG</b> model.</div><div class="ds-list">${items || `<div class="empty">No datasets on this account.</div>`}</div>${personaRow}`,
    OPEN.has("set.datasets"), `${sel.size || ""}`);
}

// ── Settings: progressive (snappy) rendering ────────────────────────────────
// The panel paints a shell instantly, then each section hydrates independently - so a
// slow omp/AskSage fetch never blocks the whole page (the old renderSettings awaited
// every fetch + 8s dataset/persona timeouts before painting anything). Heavy/optional
// sections collapse to keep the panel short.
const SET_OPEN = new Set<string>(["asksage"]); // collapsible sections open by default

function setCard(name: string, title: string, sub: string, body: string, collapsible: boolean): string {
  const subHtml = sub ? ` <span class="set-sub">${sub}</span>` : "";
  if (!collapsible) return `<div class="set-sec" data-sec="${name}"><div class="set-lbl">${title}${subHtml}</div>${body}</div>`;
  return `<div class="set-sec set-coll${SET_OPEN.has(name) ? " open" : ""}" data-sec="${name}">
    <button class="set-coll-h" data-setcard="${name}"><span class="set-lbl">${title}${subHtml}</span><span class="set-coll-chev">${icon("chevron", 15)}</span></button>
    <div class="set-coll-body">${body}</div></div>`;
}
const setSkel = (name: string, title: string, sub: string, collapsible = false): string =>
  setCard(name, title, sub, `<div class="set-skel"></div><div class="set-skel short"></div>`, collapsible);
function fillSec(name: string, html: string): void {
  const el = document.querySelector(`#setBody [data-sec="${name}"]`);
  if (el) el.outerHTML = html;
}

const isValidEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

// First-open prompt for the corporate email (the code-activity attribution identity, ADR-0030).
// Email is OPTIONAL: skipping records the workstation hostname instead, so activity is still
// traceable and rolls up to the dashboard / MCP push. Shown once, until the user decides.
function emailDomainOk(em: string): boolean {
  const domains = state.attribution?.allowedDomains ?? [];
  if (!domains.length) return true;
  const e = em.trim().toLowerCase();
  return domains.some((d) => e.endsWith("@" + d.toLowerCase().replace(/^@/, "")));
}
function promptForEmailIfMissing(onDone?: () => void): void {
  if (state.attribution?.decided || document.getElementById("emailGate")) { onDone?.(); return; }
  const a = state.attribution;
  const ws = a?.workstation ?? "this workstation";
  const allowSkip = a ? a.allowSkip : true;          // managed policy can disable skipping
  const domains = a?.allowedDomains ?? [];
  const org = a?.orgName ? esc(a.orgName) : "your organization";
  const managedLine = a?.managed
    ? `<p class="modal-desc" style="color:var(--accent-2)">${icon("shield", 12)} Required by ${org}${domains.length ? ` · use ${domains.map((d) => "@" + esc(d)).join(" or ")}` : ""}.</p>`
    : "";
  const ov = el(`<div id="emailGate" class="modal-ov">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="emailGateTitle">
      <div class="modal-icon">${icon("user", 24)}</div>
      <h2 class="modal-title" id="emailGateTitle">Set your work email${allowSkip ? " (optional)" : ""}</h2>
      <p class="modal-desc">LucidAgentIDE attributes code activity - how many lines each model wrote, per repository - so it can roll up to your dashboard.${allowSkip ? ` Add your corporate email, or skip and we'll attribute to this workstation (<b>${esc(ws)}</b>) instead.` : " Enter your corporate email to continue."} Stored on this machine only.</p>
      ${managedLine}
      <div class="modal-field"><input id="emailGateInput" class="prov-key" type="email" inputmode="email" autocomplete="email" spellcheck="false" placeholder="${domains.length ? "you@" + esc(domains[0]!) : "you@company.com"}" /></div>
      <div id="emailGateErr" class="modal-err" hidden></div>
      <div class="modal-actions">
        ${allowSkip ? `<button class="btn-mini" id="emailGateSkip" type="button">Skip - use ${esc(ws)}</button>` : ""}
        <button class="btn-mini ok" id="emailGateSave" type="button">${icon("check", 12)} Save</button>
      </div>
    </div></div>`);
  document.body.appendChild(ov);
  const input = $("#emailGateInput", ov) as HTMLInputElement;
  const err = $("#emailGateErr", ov) as HTMLElement;
  const apply = (r: import("./bridge.ts").ProfileSettings | null) => { if (r?.attribution) state.attribution = r.attribution; state.email = r?.email ?? state.email; if (state.settingsOpen) fillSec("profile", secProfile({ username: state.username, email: state.email, attribution: state.attribution ?? undefined })); ov.remove(); };
  const save = async () => {
    const em = input.value.trim();
    if (!isValidEmail(em)) { err.textContent = `Enter a valid email address${allowSkip ? ", or Skip to use this workstation" : ""}.`; err.hidden = false; input.focus(); return; }
    if (!emailDomainOk(em)) { err.textContent = `Use your ${org} email (${domains.map((d) => "@" + d).join(", ")}).`; err.hidden = false; input.focus(); return; }
    apply(await bridge.saveProfile({ email: em }).catch(() => null));
    if (state.attribution?.source === "email") { showToast({ title: "Email saved", desc: `Code activity will be attributed to ${em}.`, timeout: 2600 }); onDone?.(); }
    else { err.textContent = "That email was rejected by your organization's policy."; err.hidden = false; promptForEmailIfMissing(onDone); }
  };
  const skip = async () => {
    apply(await bridge.skipEmail().catch(() => null));
    showToast({ title: "Using workstation name", desc: `Code activity will be attributed to ${state.attribution?.identity ?? ws}. Add an email anytime in Settings.`, timeout: 3200 });
    onDone?.();
  };
  $("#emailGateSave", ov)!.addEventListener("click", () => void save());
  $("#emailGateSkip", ov)?.addEventListener("click", () => void skip());
  input.addEventListener("input", () => { err.hidden = true; });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } });
  setTimeout(() => input.focus(), 30);
}

// ── ADR-0088/0089 (P-ROLE.1/.1b): role onboarding + first-run guided walkthrough ──────────────
// First-login flow as a chain: pick a role (if unchosen) → email/attribution → the tour. Each step
// is cosmetic - none gate or weaken the security path (invariant #3).
function runOnboarding(): void {
  const afterEmail = () => { if (!state.tourSeen) startTour(state.userRole ?? "developer"); };
  if (state.userRole) { promptForEmailIfMissing(afterEmail); return; }
  void promptForRole().then(() => promptForEmailIfMissing(afterEmail));
}

// First-run role picker - four cards in the model-card idiom. Resolves once a role is chosen (or
// the user skips, which defaults to "developer", the safe full-surface role).
function promptForRole(): Promise<void> {
  return new Promise((resolve) => {
    if (state.userRole || document.getElementById("roleGate")) { resolve(); return; }
    const cards = USER_ROLE_LIST.map((id) => {
      const m = ROLE_META[id];
      return `<button class="role-card" type="button" data-role="${esc(id)}">
        <span class="role-ic r-${esc(id)}">${roleIcon(id)}</span>
        <span class="role-tx"><b>${esc(m.label)}</b><span class="role-lands">Lands on ${esc(m.lands)}</span><span class="role-blurb">${esc(m.blurb)}</span></span>
      </button>`;
    }).join("");
    const ov = el(`<div id="roleGate" class="modal-ov">
      <div class="modal role-modal" role="dialog" aria-modal="true" aria-labelledby="roleGateTitle">
        <div class="modal-icon">${icon("spark", 24)}</div>
        <h2 class="modal-title" id="roleGateTitle">Welcome - what's your role?</h2>
        <p class="modal-desc">This tailors what you see first. Nothing is hidden for good - every panel stays one ${modCombo("K")} away, and a security block always surfaces. Change it any time in Settings.</p>
        <div class="role-grid">${cards}</div>
        <div class="modal-actions"><button class="btn-mini" id="roleGateSkip" type="button">Skip - use Developer</button></div>
      </div></div>`);
    document.body.appendChild(ov);
    const finish = async (role: UserRole) => {
      state.userRole = role;
      applyRoleDefault(role);
      ov.remove();
      await bridge.saveRole(role).catch(() => null);
      if (state.settingsOpen) fillSec("profile", secProfile({ username: state.username, email: state.email, attribution: state.attribution ?? undefined }));
      resolve();
    };
    ov.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement;
      const card = t.closest("[data-role]") as HTMLElement | null;
      if (card?.dataset.role) { void finish(card.dataset.role as UserRole); return; }
      if (t.closest("#roleGateSkip")) void finish("developer");
    });
  });
}

// Apply a role's CALM default surfacing (ADR-0088): the landing inspector tab. Cosmetic; ADR-0021's
// active-block override still wins. The full per-role chrome presets are P-ROLE.2.
function applyRoleDefault(role: UserRole): void {
  refreshTriviaGame(); // P-TRIV.2 (ADR-0175): the Trivia Wire bank follows the role (idempotent) - BEFORE the surfacing guard
  if (hasActiveBlocks()) return; // never override a live security surface
  const tab = roleDefaultTab(role);
  if (state.inspectorRail) { state.inspectorTab = tab; return; }
  if (state.inspectorTab !== tab) focusInspector(tab);
}

// ── ADR-0089 (P-ROLE.1b): the first-run guided walkthrough engine ─────────────────────────────
// A coachmark tour in the model hover-card idiom: a dimmed spotlight on each live target + an
// anchored premium card with Back/Next/Skip. Dismissable (Esc / click-away). Skip OR finish marks
// it seen so it never replays uninvited; the About "Take the tour" button replays on demand.
let tourActive = false;
function startTour(role: UserRole): void {
  if (tourActive) return;
  const steps = stepsForRole(role).filter((s: TourStep) => !s.target || document.querySelector(s.target));
  if (!steps.length) return;
  tourActive = true;
  let idx = 0;

  const catcher = el(`<div class="coach-catch"></div>`);
  const spot = el(`<div class="coach-spot" hidden></div>`);
  const card = el(`<div class="coach-card" role="dialog" aria-modal="true" aria-label="Guided tour"></div>`);
  document.body.append(catcher, spot, card);

  const end = (reason: "done" | "skip") => {
    tourActive = false;
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", place);
    catcher.remove(); spot.remove(); card.remove();
    if (!state.tourSeen) { state.tourSeen = true; void bridge.setTourSeen(true).catch(() => null); }
    if (reason === "skip") showToast({ title: "Tour skipped", desc: "Replay it any time from About.", timeout: 2800 });
  };

  const place = () => {
    const step = steps[idx]!;
    card.innerHTML = coachHtml(step, idx, steps.length);
    const target = step.target ? (document.querySelector(step.target) as HTMLElement | null) : null;
    const cr = card.getBoundingClientRect();
    if (!target) {
      spot.hidden = true;
      card.style.left = `${Math.round((window.innerWidth - cr.width) / 2)}px`;
      card.style.top = `${Math.round((window.innerHeight - cr.height) / 2)}px`;
    } else {
      const r = target.getBoundingClientRect();
      const pad = 6;
      spot.hidden = false;
      spot.style.left = `${Math.round(r.left - pad)}px`;
      spot.style.top = `${Math.round(r.top - pad)}px`;
      spot.style.width = `${Math.round(r.width + pad * 2)}px`;
      spot.style.height = `${Math.round(r.height + pad * 2)}px`;
      // Place the card beside the target (prefer the step's side; flip on overflow) - same idea as showModelTip.
      const wantLeft = step.side === "left";
      let x = wantLeft ? r.left - cr.width - 14 : r.right + 14;
      if (!wantLeft && x + cr.width > window.innerWidth - 8) x = r.left - cr.width - 14;
      if (x < 8) x = Math.min(r.right + 14, window.innerWidth - cr.width - 8);
      x = Math.max(8, x);
      const y = Math.max(8, Math.min(r.top - 4, window.innerHeight - cr.height - 8));
      card.style.left = `${Math.round(x)}px`;
      card.style.top = `${Math.round(y)}px`;
    }
    requestAnimationFrame(() => card.classList.add("show"));
  };

  const go = (n: number) => { if (n < 0 || n >= steps.length) return; idx = n; card.classList.remove("show"); place(); };
  const next = () => (idx >= steps.length - 1 ? end("done") : go(idx + 1));

  const onKey = (ev: KeyboardEvent) => {
    if (!tourActive) return;
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); end("skip"); }
    else if (ev.key === "Enter" || ev.key === "ArrowRight") { ev.preventDefault(); next(); }
    else if (ev.key === "ArrowLeft") { ev.preventDefault(); go(idx - 1); }
  };

  card.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest("[data-coach-skip]")) end("skip");
    else if (t.closest("[data-coach-back]")) go(idx - 1);
    else if (t.closest("[data-coach-next]")) next();
  });
  catcher.addEventListener("click", () => end("skip"));
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);
  place();
}

function secProfile(s: { username: string; email?: string; attribution?: import("./bridge.ts").ProfileSettings["attribution"] } | null): string {
  const a = s?.attribution;
  const managedLine = a?.managed
    ? `<div class="set-note">${icon("shield", 12)} Managed by <b>${esc(a.orgName || "your organization")}</b>${a.requireEmail ? " - a corporate email is required" : ""}${a.allowedDomains?.length ? ` (${a.allowedDomains.map((d) => "@" + esc(d)).join(", ")})` : ""}.</div>`
    : "";
  const idLine = a
    ? `<div class="set-note ${a.source === "email" ? "ok" : ""}">${icon(a.source === "email" ? "check" : "info", 12)} Code activity is attributed to <b>${esc(a.identity)}</b>${a.source === "workstation" ? " (this workstation - add an email above to attribute to you)" : ""}.</div>`
    : `<div class="set-note">${icon("info", 12)} Your email tags how much code each model wrote, per repo (ADR-0030). Stored on this machine only.</div>`;
  const role = state.userRole ?? "developer";
  const roleSeg = USER_ROLE_LIST.map((id) =>
    `<button class="role-seg${id === role ? " on" : ""}" type="button" data-role-pick="${esc(id)}" data-tip="${esc(ROLE_META[id].label + " · " + ROLE_META[id].blurb)}">${icon(ROLE_META[id].icon, 13)}<span>${esc(ROLE_META[id].label)}</span></button>`).join("");
  const roleRow = `<div class="set-sub">Role</div>
    <div class="role-seg-row">${roleSeg}</div>
    <div class="set-note">${icon("info", 12)} Tailors what you see first - cosmetic only; every panel stays reachable. <button class="btn-link" id="replayTour" type="button">Take the tour</button></div>`;
  return setCard("profile", "Profile", "", `<div class="prov-row"><input id="setUsername" class="prov-key" placeholder="Your name" value="${esc(s?.username ?? "")}" /></div>
    <div class="prov-row"><input id="setEmail" class="prov-key" type="email" inputmode="email" autocomplete="email" placeholder="Corporate email (optional - for code-activity attribution)" value="${esc(s?.email ?? "")}" />
      <button class="btn-mini ok" id="saveUsername">${icon("check", 12)} Save</button></div>
    ${managedLine}${idLine}
    ${roleRow}`, false);
}
function secProviders(auth: import("./bridge.ts").AuthStatus | null): string {
  // Collapsible + default-collapsed (not in SET_OPEN): the AskSage gov gateway sits above this and is the
  // foregrounded path; the direct U.S. providers tuck away until needed.
  return setCard("providers", "Providers", "U.S. frontier · key or OAuth",
    (auth?.majors ?? []).map(provCard).join("") || `<div class="empty">couldn't read auth - is the server up to date?</div>`, true);
}
// P-IDE.1c (ADR-0029): data-sovereignty unlock for China-origin models. Renders ONLY when omp actually
// exposes such a model (else an empty, preserved anchor). Hidden-by-default; the user must type
// ACKNOWLEDGE after the warning to list them - they route outside U.S. jurisdiction (no data sovereignty).
function secSovereignty(): string {
  const model = state.config.find((c) => c.id === "model");
  const china = (model?.options ?? []).filter((o) => isChinaModel(o.value));
  if (!china.length) return `<div data-sec="sovereignty"></div>`; // nothing to gate → no card
  if (state.chinaAck) {
    return setCard("sovereignty", "Restricted-origin models", `${china.length} unlocked`,
      `<div class="set-note ok">${icon("check", 12)} ${china.length} China-origin model(s) are unlocked and listed in the picker. <button class="btn-link" id="chinaRelock">Re-lock</button></div>`, true);
  }
  return setCard("sovereignty", "Restricted-origin models", `${china.length} hidden`,
    `<div class="set-note danger">${icon("shield", 12)} <b>${china.length} model(s) from China-based providers</b> (DeepSeek, Kimi/Moonshot, MiniMax, GLM/Zhipu) are hidden. They route to servers outside U.S. jurisdiction with <b>no U.S. data sovereignty</b>; review each provider's privacy policy before use.</div>
     <div class="china-unlock"><input id="chinaAckInput" placeholder="Type ACKNOWLEDGE to unlock" autocomplete="off" spellcheck="false" /><button class="btn-mini" id="chinaAckBtn" disabled>Unlock</button></div>`, true);
}
function secAsksage(a: typeof state.asksage, datasets: string[] | null): string {
  // ADR-0068 (P-ENT.1): an enterprise policy can LOCK model routing (force gov-gateway-only). When
  // locked, the toggle is forced-on, disabled, and labelled "Managed by <org>" (mirrors attribution).
  const locked = !!state.managed?.locks?.models;
  const org = esc(state.managed?.orgName || "your organization");
  const checked = locked || a?.only ? "checked" : "";
  const managedNote = locked
    ? `<div class="set-note">${icon("shield", 12)} Managed by <b>${org}</b> - gov-gateway-only routing is enforced.</div>`
    : "";
  // The ASKSAGE_API_KEY entry lives HERE now (this gateway card sits above Providers), not in the
  // Providers list. Rendered from the auth `gateway` group once it loads.
  const keyRow = state.auth?.gateway?.[0] ? provCard(state.auth.gateway[0]) : "";
  const body = `${keyRow}
    <div class="prov-row"><input id="asksageBase" class="prov-key" placeholder="https://api.civ.asksage.ai/server" value="${esc(a?.base ?? "")}" />
      <button class="btn-mini ok" id="asksageSaveBase">${icon("check", 12)} Save URL</button></div>
    <label class="set-toggle"><input type="checkbox" id="asksageOnly" ${checked} ${locked ? "disabled" : ""}/>
      <span><b>AskSage-only (lockdown)</b> - route every turn through the gov gateway and hide direct providers in the model picker.</span></label>
    ${managedNote}
    ${locked || a?.only ? datasetsSection(datasets) : ""}
    ${a?.configured ? `<div class="set-note ok">${icon("check", 12)} Gov gateway active - AskSage models appear in the picker, with monthly-usage and scanned personas.</div>` : `<div class="set-note">${icon("info", 12)} Add your <code>ASKSAGE_API_KEY</code> above to enable gov models, usage, and personas.</div>`}`;
  return setCard("asksage", "AskSage gov gateway", "accredited proxy", body, true);
}
// The AskSage Monthly-tokens bar, rendered into the `asksageQuota` slot ABOVE Providers - but only
// once the gov gateway is configured (an ASKSAGE_API_KEY is saved); otherwise an empty placeholder so
// the slot keeps its position for a later config. Wrapped in its own data-sec so fillSec() can re-swap
// it (spinner → real numbers) without disturbing the Providers section below it.
function secAsksageQuota(a: typeof state.asksage): string {
  return `<div data-sec="asksageQuota">${a?.configured ? quotaDisplay(state.asksageTokens) : ""}</div>`;
}
function secCompression(hr: import("./bridge.ts").HeadroomStatus | null): string {
  const body = hr?.installed
    ? `<label class="set-toggle"><input type="checkbox" id="headroomToggle" ${hr.enabled ? "checked" : ""}/>
        <span><b>Compress context with headroom</b> - fewer tokens before they reach the model. ${hr.running ? `<span class="abadge ok">running · :${hr.port}</span>` : ""}</span></label>
      <div class="set-note">${icon("info", 12)} Runs entirely on your machine (${esc(hr.version ?? "installed")}). Request-routing + a gov-deployment security review are next - see ADR-0008.</div>`
    : `<div class="set-note">${icon("info", 12)} Optional: install <b>headroom</b> to compress context on-device (60–95% fewer tokens). Run <code>${esc(hr?.installHint ?? "pip install headroom-ai[proxy]")}</code>, then this toggle appears.</div>`;
  return setCard("compression", "Token compression", "on-device · opt-in", body, true);
}
// ADR-0009 Phase D + P-ASKSAGE.1 (ADR-0059): Developer mode toggle. Reveals the read-only Logs rail
// panel (telemetry, lineage, transcripts, gate-block audit) AND enables AskSage tool-call diagnostics.
// Uses the existing #devModeToggle handler, which now respawns omp so the diagnostics apply immediately.
function secDeveloper(): string {
  const on = state.developerMode;
  const body = `<label class="set-toggle"><input type="checkbox" id="devModeToggle" ${on ? "checked" : ""}/>
      <span><b>Developer mode</b> - reveal a read-only <b>Logs</b> panel in the rail (telemetry, run lineage, transcripts, gate-block audit) and turn on <b>AskSage tool-call diagnostics</b>. Read-only, on this machine, off by default.</span></label>
    <div class="set-note">${icon("info", 12)} <span>Turning this on respawns the agent so the diagnostics take effect immediately, then adds a <b>Logs</b> panel to the left rail. Open it and expand <b>AskSage tool calls</b> to watch each request live.</span></div>`;
  return setCard("developer", "Developer", "logs · diagnostics", body, true);
}
// "More providers" = third-party / non-U.S. / custom aggregators. The list is HIDDEN behind a typed
// ACKNOWLEDGE gate (mirrors the China-origin unlock) because these route outside U.S. jurisdiction or
// aggregate many origins. Expanding the section shows the warning first; the list appears once acknowledged.
function secOthers(auth: import("./bridge.ts").AuthStatus | null): string {
  // P-VOICE.1: ElevenLabs rides the `others` auth plumbing for keySet/last4, but it's a VOICE provider —
  // render it in the Voice card, not here.
  const list = (auth?.others ?? []).filter((p) => p.id !== "elevenlabs").map(provCard).join("") || `<div class="empty">none</div>`;
  if (state.thirdPartyAck) {
    return setCard("others", "More providers", "third-party · non-U.S. / custom",
      `<div class="set-note ok">${icon("check", 12)} You acknowledged the third-party risk. <button class="btn-link" id="thirdPartyRelock">Re-lock</button></div>${list}`, true);
  }
  return setCard("others", "More providers", "acknowledge to reveal",
    `<div class="set-note danger">${icon("shield", 12)} <b>Third-party models (non-U.S. / custom)</b> - OpenRouter, DeepSeek, Kimi/Moonshot, Groq. These route to third-party or non-U.S. servers (or aggregate many origins) with <b>no U.S. data-sovereignty guarantee</b>; review each provider's terms before use.</div>
     <div class="china-unlock"><input id="thirdPartyAckInput" placeholder="Type ACKNOWLEDGE to reveal" autocomplete="off" spellcheck="false" /><button class="btn-mini" id="thirdPartyAckBtn" disabled>Reveal</button></div>`, true);
}
// P-VOICE.1 (ADR-0115): the Voice card — ElevenLabs key (with get-key link + cost estimate), the STT
// engine (offline Whisper = air-gap/DoD default, or ElevenLabs Scribe cloud), the TTS engine, and the
// voice picker (favorites first). The voice list loads async (needs the ElevenLabs key).
function secVoice(auth: import("./bridge.ts").AuthStatus | null, vset: import("./bridge.ts").VoiceSettingsView | null): string {
  const elKey = (auth?.others ?? []).find((p) => p.id === "elevenlabs");
  const keyCard = elKey ? provCard(elKey) : "";
  const stt = vset?.sttProvider ?? "whisper";
  const ttsp = vset?.ttsProvider ?? "elevenlabs";
  const sel = (v: boolean) => (v ? " selected" : "");
  const body = `${keyCard}
    <div class="set-note">${icon("mic", 12)} <b>Speech-to-text</b> powers the mic button by the composer. <b>Offline Whisper</b> keeps audio on-device (air-gap / DoD); <b>ElevenLabs Scribe</b> is cloud (higher accuracy, audio leaves the device).</div>
    <div class="voice-row"><label class="voice-lbl" for="voiceStt">STT engine</label>
      <select id="voiceStt" class="prov-key" data-voice-set="sttProvider">
        <option value="whisper"${sel(stt === "whisper")}>Offline Whisper - air-gap / DoD</option>
        <option value="elevenlabs"${sel(stt === "elevenlabs")}>ElevenLabs Scribe - cloud</option>
      </select></div>
    <div class="voice-row" id="voiceSttUrlRow"${stt === "whisper" ? "" : " hidden"}>
      <label class="voice-lbl" for="voiceSttUrl">Whisper URL</label>
      <input id="voiceSttUrl" class="prov-key" data-voice-set="sttUrl" spellcheck="false" placeholder="http://localhost:9000 (self-hosted whisper.cpp / faster-whisper)" value="${esc(vset?.sttUrl ?? "")}" /></div>
    <div class="voice-row"><label class="voice-lbl" for="voiceTts">TTS engine</label>
      <select id="voiceTts" class="prov-key" data-voice-set="ttsProvider">
        <option value="elevenlabs"${sel(ttsp === "elevenlabs")}>ElevenLabs - cloud, custom voices</option>
        <option value="openai-tts"${sel(ttsp === "openai-tts")}>ChatGPT / OpenAI - cloud</option>
        <option value="local-tts"${sel(ttsp === "local-tts")}>Kokoro - offline, air-gap</option>
      </select></div>
    <div class="voice-row voice-pick"><label class="voice-lbl" for="voiceSelect">Voice</label>
      <select id="voiceSelect" class="prov-key" data-voice-set="ttsVoice"><option value="">loading voices…</option></select>
      <button class="btn-mini" id="voiceFav" data-tip="Favorite|Star the selected voice - favorites are listed first">${icon("spark", 12)}</button></div>
    <div class="set-note" id="voiceNote"></div>`;
  return setCard("voice", "Voice", "TTS · STT · ElevenLabs", body, true);
}
/** Populate the Voice card's voice picker (favorites first) from the ElevenLabs account. Best-effort;
 *  shows a note when no key / no voices. Called after the card renders and after the key changes. */
async function loadVoices(): Promise<void> {
  const selEl = $("#voiceSelect") as HTMLSelectElement | null;
  if (!selEl) return;
  const data = await bridge.voices().catch(() => null);
  const note = $("#voiceNote");
  if (!data || !data.voices.length) {
    selEl.innerHTML = `<option value="">no voices${data?.note ? "" : ""}</option>`;
    if (note) note.textContent = data?.note || "Add an ElevenLabs key to list voices.";
    return;
  }
  if (note) note.textContent = "";
  const favs = new Set(data.favorites);
  const opt = (v: import("./bridge.ts").ElevenVoiceView) => `<option value="${esc(v.voiceId)}"${v.voiceId === data.selected ? " selected" : ""}>${esc(v.name)}${v.category ? ` · ${esc(v.category)}` : ""}</option>`;
  const favList = data.voices.filter((v) => favs.has(v.voiceId));
  const rest = data.voices.filter((v) => !favs.has(v.voiceId));
  selEl.innerHTML =
    (favList.length ? `<optgroup label="★ Favorites">${favList.map(opt).join("")}</optgroup>` : "") +
    `<optgroup label="All voices">${rest.map(opt).join("")}</optgroup>`;
}
// P-MCP.1 (ADR-0020): MCP connectors - auth + config only; omp owns the MCP transport.
function secMcp(servers: import("./bridge.ts").McpServerStatus[]): string {
  const rows = servers.length ? servers.map((m) => `<div class="prov">
      <div class="prov-h"><span class="prov-name">${esc(m.name)} <span class="abadge set">${esc(m.transport)}</span></span>
        <span class="prov-status">${m.enabled ? `<span class="abadge ok">${icon("check", 11)} on</span>` : `<span class="abadge none">off</span>`}${m.hasToken ? `<span class="abadge set">token ••${esc(m.tokenLast4 ?? "")}</span>` : ""}</span></div>
      <div class="prov-body">
        <div class="prov-row"><span class="prov-id" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(m.url)}</span></div>
        <div class="prov-row">
          <button class="btn-mini" data-mcp-toggle="${esc(m.id)}" data-mcp-on="${m.enabled ? "0" : "1"}">${m.enabled ? "Disable" : "Enable"}</button>
          <button class="btn-mini danger" data-mcp-remove="${esc(m.id)}">${icon("close", 12)} Remove</button>
        </div></div></div>`).join("")
    : `<div class="empty">No MCP servers yet. Add one below - it's handed to the agent via omp's native MCP support.</div>`;
  const form = `<div class="prov" style="border-style:dashed">
      <div class="prov-h"><span class="prov-name">${icon("plus", 13)} Add an MCP server</span></div>
      <div class="prov-body">
        <div class="prov-row"><input id="mcpName" class="prov-key" placeholder="Name (e.g. Linear, internal-tools)" /></div>
        <div class="prov-row"><input id="mcpUrl" class="prov-key" placeholder="https://mcp.example.com/mcp (or /sse)" />
          <select id="mcpTransport" class="prov-key" style="flex:none;width:84px"><option value="http">HTTP</option><option value="sse">SSE</option></select></div>
        <div class="prov-row"><input id="mcpToken" class="prov-key" type="password" placeholder="Bearer token (optional)" />
          <button class="btn-mini ok" id="mcpAdd">${icon("check", 12)} Connect</button></div>
      </div></div>`;
  const note = `<div class="set-note">${icon("info", 12)} Auth + config only - <b>omp owns the MCP connection</b> (ADR-0020). The token is stored on this machine (git-ignored) and sent as an <code>Authorization: Bearer</code> header; MCP tool output is still scanned by the security gate. Enterprise IdP sign-in (Okta / Entra / GCP WIF) lands in P-MCP.2.</div>`;
  return setCard("mcp", "MCP connectors", "model context protocol", rows + form + note, true);
}
function hydrateMcp(): void {
  void bridge.mcpList().then((m) => { state.mcpServers = m ?? []; fillSec("mcp", secMcp(state.mcpServers)); });
}
// P-AGENTFW.2 (ADR-0149): Remote agents (hermes/openclaw) reached THROUGH the Lucid agent-firewall.
function secAgents(agents: import("./bridge.ts").RemoteAgentStatus[]): string {
  const rows = agents.length ? agents.map((a) => `<div class="prov">
      <div class="prov-h"><span class="prov-name">${esc(a.name)} <span class="abadge set">${esc(a.kind)}</span></span>
        <span class="prov-status">${a.enabled ? `<span class="abadge ok">${icon("check", 11)} on</span>` : `<span class="abadge none">off</span>`}<span class="abadge set">perm: ${esc(a.permissionPolicy)}</span></span></div>
      <div class="prov-body">
        <div class="prov-row"><code>${esc(a.command)} ${esc(a.args.join(" "))}</code></div>
        <div class="prov-row">
          <button class="btn-mini" data-agent-toggle="${esc(a.id)}" data-agent-on="${a.enabled ? "0" : "1"}">${a.enabled ? "Disable" : "Enable"}</button>
          <button class="btn-mini danger" data-agent-remove="${esc(a.id)}">${icon("close", 12)} Remove</button>
        </div></div></div>`).join("")
    : `<div class="empty">No remote agents yet. Add a hermes/openclaw connection below — it's proxied through the Lucid security firewall.</div>`;
  const form = `<div class="prov" style="border-style:dashed">
      <div class="prov-h"><span class="prov-name">${icon("plus", 13)} Add a remote agent</span></div>
      <div class="prov-body">
        <div class="prov-row"><input id="agentName" class="prov-key" placeholder="Name (e.g. Hermes prod)" />
          <select id="agentKind" class="prov-key" style="flex:none;width:110px"><option value="hermes">hermes</option><option value="openclaw">openclaw</option><option value="acp">acp</option></select></div>
        <div class="prov-row"><input id="agentCommand" class="prov-key" placeholder="Command (e.g. hermes, openclaw, uvx)" /></div>
        <div class="prov-row"><input id="agentArgs" class="prov-key" placeholder="Args (e.g. acp --url wss://host:18789 --token-file /abs/path)" /></div>
        <div class="prov-row">
          <select id="agentPerm" class="prov-key" style="flex:none;width:160px"><option value="deny">permissions: deny</option><option value="allow">permissions: allow</option></select>
          <button class="btn-mini ok" id="agentAdd">${icon("check", 12)} Connect</button></div>
      </div></div>`;
  const note = `<div class="set-note">${icon("shield", 12)} Remote agents (hermes/openclaw) are reached through the <b>Lucid agent-firewall</b>: every prompt is scanned before it leaves and every reply is scanned + returned as <code>UNTRUSTED_CONTENT</code>; the remote's permission asks default to <b>deny</b>. Prefer <code>--token-file</code> (absolute path) so no secret is stored here. See <code>docs/AGENT-FIREWALL.md</code>.</div>`;
  return setCard("agents", "Remote agents", "hermes · openclaw · ACP firewall", rows + form + note, true);
}
function hydrateAgents(): void {
  void bridge.remoteAgentList().then((a) => { state.agents = a ?? []; fillSec("agents", secAgents(state.agents)); });
}

// P-NETWL.2 (ADR-0106): the curated Network Whitelist section. Lets a user pre-authorize domains (`*.com`
// TLD or exact `api.example.com`) and IP/CIDR ranges, split by internal (intranet) vs external (internet)
// zone, with a trust scope + optional per-loop call budget, and optionally attach an auth credential whose
// secret lives OS-encrypted in the vault (never in the config). A match auto-allows egress under the managed
// ceiling (fail-closed). Only the `always` scope is enforced today; project/loop persist for P-NETWL.3.
let wlPendingCred: { ref: string; kind: string; label?: string } | null = null; // a just-uploaded file credential, awaiting Add
const WL_SCOPE_LABEL: Record<string, string> = { always: "Always", project: "Project", loop: "This loop" };
const WL_SCOPE_TIP: Record<string, string> = {
  always: "Auto-allows in every session, everywhere.",
  project: "Auto-allows only while this workspace is open.",
  loop: "Auto-allows only during a /goal loop run.",
};
// P-KEYS.2 (ADR-0107): renderer-side rotation badge. Deliberately mirrors cred_vault.rotationStatus/Label
// (the backend versions are the unit-tested source of truth); kept tiny + pure to avoid a cross-boundary import.
function wlRotationBadge(m: import("./bridge.ts").CredMetaView | undefined, now: number): { text: string; tone: "ok" | "warn" | "danger" } | null {
  if (!m) return null;
  const DAY = 86_400_000;
  const rotatedAt = m.rotatedAt ?? m.createdAt;
  if (m.expiresAt != null && now >= m.expiresAt) return { text: "expired", tone: "danger" };
  if (m.rotationIntervalDays != null && m.rotationIntervalDays > 0 && rotatedAt != null && now >= rotatedAt + m.rotationIntervalDays * DAY) return { text: "rotation due", tone: "danger" };
  if (m.expiresAt != null) { const d = Math.ceil((m.expiresAt - now) / DAY); if (d <= 7) return { text: `expires in ${Math.max(0, d)}d`, tone: "warn" }; }
  if (m.rotationIntervalDays != null && m.rotationIntervalDays > 0 && rotatedAt != null) { const d = Math.ceil((rotatedAt + m.rotationIntervalDays * DAY - now) / DAY); if (d <= 7) return { text: `rotate in ${Math.max(0, d)}d`, tone: "warn" }; }
  if (rotatedAt != null) return { text: `rotated ${Math.floor((now - rotatedAt) / DAY)}d ago`, tone: "ok" };
  return null;
}
function secWhitelist(entries: import("./bridge.ts").WhitelistEntryView[], creds: import("./bridge.ts").CredMetaView[] = [], posture: import("./bridge.ts").EgressPostureView = state.posture): string {
  const credByRef = new Map(creds.map((c) => [c.ref, c]));
  const now = Date.now();
  const rows = entries.length ? entries.map((e) => {
    // P-KEYS.1 (ADR-0107): identify the attached key by its last-4 (never the secret), looked up from the vault.
    const cred = e.auth ? credByRef.get(e.auth.vaultRef) : undefined;
    const last4 = cred?.last4 ?? "";
    const mask = last4 ? " ••••" + esc(last4) : "";
    const rot = e.auth ? wlRotationBadge(cred, now) : null; // P-KEYS.2 rotation posture
    const rotBadge = rot && rot.text ? `<span class="abadge ${rot.tone}" data-tip="Rotation|${esc(rot.text)}. Use Rotate to replace the secret in place.">${rot.text}</span>` : "";
    return `<div class="prov">
      <div class="prov-h"><span class="prov-name">${esc(e.pattern)}
          <span class="abadge set">${e.kind === "ip" ? "IP" : "domain"}</span>
          <span class="abadge ${e.zone === "internal" ? "ok" : "set"}">${e.zone}</span></span>
        <span class="prov-status">
          <span class="abadge ok" data-tip="Trust scope|${WL_SCOPE_TIP[e.scope] ?? ""}">${WL_SCOPE_LABEL[e.scope] ?? e.scope}</span>
          ${e.callBudget != null ? `<span class="abadge set" data-tip="Call budget|Auto-allows at most ${e.callBudget} call(s) to this host per loop, then falls through to the gate.">${e.callBudget}/loop</span>` : ""}
          ${e.auth ? `<span class="abadge set" data-tip="Auth attached|${esc(e.auth.kind)}${last4 ? ` key ••••${esc(last4)}` : ""} · stored OS-encrypted; the whitelist keeps only a reference, never the secret.">${icon("shield", 11)} ${esc(e.auth.kind)}${mask}${e.auth.username ? " · " + esc(e.auth.username) : ""}</span>${rotBadge}` : ""}
        </span></div>
      <div class="prov-body"><div class="prov-row">
        ${e.auth ? `<button class="btn-mini" data-wl-rotate="${esc(e.auth.vaultRef)}" data-tip="Rotate credential|Replace the stored secret (paste or upload a file). The reference is preserved so this entry keeps working.">${icon("refresh", 12)} Rotate</button>` : ""}
        <button class="btn-mini danger" data-wl-remove="${esc(e.id)}">${icon("close", 12)} Remove</button>
      </div></div></div>`;
  }).join("")
    : `<div class="empty">No whitelisted sites yet. Add a domain or IP range below - a match auto-allows the agent's network calls to it (still under any managed policy).</div>`;
  const form = `<div class="prov" style="border-style:dashed">
      <div class="prov-h"><span class="prov-name">${icon("plus", 13)} Add to whitelist</span></div>
      <div class="prov-body">
        <div class="prov-row"><input id="wlPattern" class="prov-key" placeholder="*.example.com  ·  api.example.com  ·  10.0.0.0/8" spellcheck="false" data-tip="Pattern|A domain wildcard (*.com), an exact host (api.example.com), or an IP / CIDR range (10.0.0.0/8)." /></div>
        <div class="prov-row wl-controls">
          <select id="wlKind" class="prov-key" data-tip="Kind|A domain pattern, or a single IP / CIDR range."><option value="domain">Domain</option><option value="ip">IP / CIDR</option></select>
          <select id="wlZone" class="prov-key" data-tip="Network zone|Internal = your intranet; External = the public internet."><option value="external">External</option><option value="internal">Internal</option></select>
          <select id="wlScope" class="prov-key" data-tip="Trust scope|Always = every session; Project = only this workspace; This loop = only during a /goal run."><option value="always">Always</option><option value="project">Project</option><option value="loop">This loop</option></select>
          <input id="wlBudget" class="prov-key wl-budget" type="number" min="0" placeholder="calls/loop" data-tip="Call budget|Max calls to this host per loop (enforced by the loop in P-NETWL.3)." />
        </div>
        <details class="wl-auth">
          <summary>Requires an auth token? (optional)</summary>
          <div class="prov-row">
            <select id="wlAuthKind" class="prov-key" style="flex:none;width:120px"><option value="">No auth</option><option value="jwt">JWT</option><option value="oauth">OAuth</option><option value="saml">SAML</option><option value="pem">PEM</option><option value="apikey">API key</option><option value="basic">User / Pass</option></select>
            <input id="wlAuthLabel" class="prov-key" placeholder="Label (e.g. prod-gateway)" />
          </div>
          <div class="prov-row"><input id="wlAuthUser" class="prov-key" placeholder="Username (User/Pass only, optional)" spellcheck="false" /></div>
          <div class="prov-row"><input id="wlAuthRotate" class="prov-key" type="number" min="0" placeholder="Rotate every N days (optional)" data-tip="Rotation reminder|Flags the key as due N days after it's set. Visibility only - nothing auto-rotates; use the Rotate button to replace it." /></div>
          <div class="prov-row">
            <input id="wlAuthSecret" class="prov-key" type="password" placeholder="Paste token / password / API key" />
            <button class="btn-mini" id="wlAuthFile" data-tip="Upload file|Pick a token / PEM / API-key / config file. It's read + encrypted in the vault; the secret never enters this window.">${icon("folder", 12)} Upload file</button>
          </div>
          <div class="set-note">${icon("shield", 12)} Secrets are stored <b>OS-encrypted</b> (Windows DPAPI / macOS Keychain / Linux libsecret). The whitelist keeps only a reference - never the secret itself.</div>
        </details>
        <div class="prov-row"><button class="btn-mini ok" id="wlAdd">${icon("check", 12)} Add</button></div>
      </div></div>`;
  const note = `<div class="set-note">${icon("info", 12)} A whitelist match <b>auto-allows</b> the agent's network calls to that site (no prompt), <b>always under your organization's managed policy ceiling</b> - a managed-denied host is never granted (fail-closed). Anything not whitelisted still goes through the normal per-site approval.</div>`;
  // P-NETWL.5 (ADR-0108): the two pre-checked personal-mode toggles. Premium tooltips: these are for personal /
  // non-enterprise users; enterprise users' policy is managed (Support Desk). The curated whitelist below only
  // ENFORCES when "Allow all" is off, so `.wl-standby` dims the list/form while allow-all is on.
  const p = posture;
  const searchTip = "For personal / non-enterprise use|Lets the agent search the web with the built-in search providers, no prompt each time. Enterprise users: web access is managed by your organization - contact your Support Desk to request it.";
  const allTip = "For personal / non-enterprise use|The agent can reach any website AND your local network (LAN) without asking. It STILL asks before a public IP address or a site on a foreign country's domain. Turn this OFF to enforce the curated whitelist below instead. Enterprise users: contact your Support Desk to request whitelisted sites.";
  const lock = p.managedLocked ? " disabled" : "";
  const toggles = `<div class="wl-posture">
    <div class="wl-toggle-row">
      <label class="set-toggle"><input type="checkbox" id="wlAllowSearch" ${p.allowWebSearch ? "checked" : ""}${lock} />
        <span><b>Allow web search</b> - let the agent search the web (built-in providers).</span></label>
      <button class="info-dot" type="button" data-tip="${searchTip}" data-tip-icon="shield" data-tip-side="left">${icon("info", 12)}</button>
    </div>
    <div class="wl-toggle-row">
      <label class="set-toggle"><input type="checkbox" id="wlAllowAll" ${p.allowAll ? "checked" : ""}${lock} />
        <span><b>Allow all websites + local LAN</b> - reach any site + your local network without asking.</span></label>
      <button class="info-dot" type="button" data-tip="${allTip}" data-tip-icon="shield" data-tip-side="left">${icon("info", 12)}</button>
    </div>
    ${p.managedLocked
      ? `<div class="set-note">${icon("shield", 12)} Managed by your organization - the curated whitelist is enforced. Contact your <b>Support Desk</b> to request a site.</div>`
      : `<div class="set-note">${icon("info", 12)} The curated whitelist below is <b>enforced only when "Allow all" is off</b>. Even with allow-all on, the agent still asks before a public IP or a foreign-country site.</div>`}
  </div>`;
  const body = p.allowAll && !p.managedLocked
    ? toggles + `<div class="wl-standby">${rows + form}</div>` + note
    : toggles + rows + form + note;
  return setCard("whitelist", "Network Whitelist", "domains · IPs · trust-scoped", body, true);
}
function hydrateWhitelist(): void {
  // Fetch entries + vault metadata + posture together (P-KEYS.1 last-4 needs the vault; P-NETWL.5 needs posture).
  void Promise.all([bridge.whitelistList(), bridge.credList(), bridge.whitelistPosture()]).then(([w, c, p]) => {
    state.whitelist = w ?? []; state.creds = c ?? []; if (p) state.posture = p;
    fillSec("whitelist", secWhitelist(state.whitelist, state.creds, state.posture));
  });
}

// P-NETWL.4 (ADR-0106): quick-add a DNS pill (a host the agent resolved, from the Network diagnostics panel)
// to the whitelist, choosing zone / trust-scope / call-budget in a small popover - so pre-authorizing a site
// the agent is actually reaching is one click, right where you see the traffic.
function openWhitelistQuickAdd(anchor: HTMLElement, raw: string): void {
  const host = raw.trim().replace(/\.$/, ""); // DNS cache entries can carry a trailing dot
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const inner = `<div class="cfg-sec wl-quick">
    <div class="cfg-lbl">${icon("shield", 13)} Whitelist <span class="cur mono">${esc(host)}</span></div>
    <div class="prov-row wl-controls">
      <select class="prov-key" data-q="kind"><option value="domain"${isIp ? "" : " selected"}>Domain</option><option value="ip"${isIp ? " selected" : ""}>IP / CIDR</option></select>
      <select class="prov-key" data-q="zone" data-tip="Network zone|Internal = intranet; External = internet."><option value="external">External</option><option value="internal">Internal</option></select>
      <select class="prov-key" data-q="scope" data-tip="Trust scope|Always = every session; Project = this workspace; This loop = only during a /goal run."><option value="always">Always</option><option value="project">Project</option><option value="loop">This loop</option></select>
      <input class="prov-key wl-budget" data-q="budget" type="number" min="0" placeholder="calls/loop" data-tip="Call budget|Max auto-allowed calls to this host per loop." />
    </div>
    <div class="prov-row"><button class="btn-mini ok" data-q="add">${icon("check", 12)} Add to whitelist</button></div>
  </div>`;
  const { node, close } = popover(anchor, inner);
  node.addEventListener("click", (ev) => {
    if (!(ev.target as HTMLElement).closest('[data-q="add"]')) return;
    void (async () => {
      const kind = (node.querySelector('[data-q="kind"]') as HTMLSelectElement).value === "ip" ? "ip" : "domain";
      const zone = (node.querySelector('[data-q="zone"]') as HTMLSelectElement).value === "internal" ? "internal" : "external";
      const scope = ((node.querySelector('[data-q="scope"]') as HTMLSelectElement).value ?? "always") as "always" | "project" | "loop";
      const budgetRaw = ((node.querySelector('[data-q="budget"]') as HTMLInputElement).value ?? "").trim();
      const callBudget = budgetRaw ? Math.max(0, Math.floor(Number(budgetRaw))) : undefined;
      const saved = await bridge.whitelistUpsert({ kind, pattern: host, zone, scope, callBudget });
      close();
      if (!saved) { showToast({ title: "Not added", desc: "That host was rejected - check it's a valid domain or IP.", actions: [{ label: "OK" }], timeout: 3500 }); return; }
      if (state.settingsOpen) hydrateWhitelist();
      showToast({ title: "Added to whitelist", desc: `${host} will auto-allow${scope === "always" ? "" : ` (${WL_SCOPE_LABEL[scope]!.toLowerCase()} scope)`}${callBudget != null ? ` · ${callBudget}/loop` : ""}.`, meta: "under the managed ceiling · fail-closed", timeout: 4200 });
    })();
  });
}

// P-KEYS.2 (ADR-0107): rotate a whitelist entry's attached credential IN PLACE - paste a new secret or upload
// a file. The vaultRef is preserved so the entry keeps working; the backend bumps rotatedAt + refreshes last4.
function openCredRotate(anchor: HTMLElement, ref: string): void {
  const inner = `<div class="cfg-sec wl-quick">
    <div class="cfg-lbl">${icon("refresh", 13)} Rotate credential</div>
    <div class="prov-row"><input class="prov-key" data-q="secret" type="password" placeholder="Paste the new token / password / key" /></div>
    <div class="prov-row">
      <button class="btn-mini ok" data-q="rotate">${icon("check", 12)} Rotate</button>
      <button class="btn-mini" data-q="rotatefile">${icon("folder", 12)} From file</button>
    </div>
    <div class="set-note">${icon("shield", 12)} Re-encrypted in place; the old secret is overwritten. Fail-closed if the OS keystore is unavailable.</div>
  </div>`;
  const { node, close } = popover(anchor, inner);
  const done = (r: import("./bridge.ts").CredMetaView | { error: string } | null): void => {
    if (r && "error" in r) {
      const msg = r.error === "os-encryption-unavailable" ? "OS encryption isn't available; the old secret was left untouched (fail-closed)."
        : r.error === "not-found" ? "That credential no longer exists." : r.error;
      showToast({ title: "Rotation failed", desc: msg, actions: [{ label: "OK" }], timeout: 5000 });
      return;
    }
    close();
    if (!r) return; // user cancelled the file dialog
    if (state.settingsOpen) hydrateWhitelist();
    showToast({ title: "Credential rotated", desc: `New secret stored (••••${esc(r.last4 ?? "")}); the reference is unchanged so the entry keeps working.`, timeout: 3600 });
  };
  node.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest('[data-q="rotate"]')) {
      const secret = (node.querySelector('[data-q="secret"]') as HTMLInputElement).value ?? "";
      if (!secret) { showToast({ title: "Paste a secret", desc: "Enter the new secret, or use From file.", actions: [{ label: "OK" }], timeout: 3000 }); return; }
      void bridge.credRotate({ ref, secret }).then(done);
    } else if ((ev.target as HTMLElement).closest('[data-q="rotatefile"]')) {
      void bridge.credRotateFile({ ref }).then(done);
    }
  });
}

// ── P-APPEAR.1: personalized chat background (ambient wash / flashlight-on-hover) ──
// `ambient` = the image faintly (25%) behind the whole chat; `flashlight` = black background, with the
// image revealed only under the cursor via a masked radial spotlight tracked on mousemove. Off/no image → hidden.
function applyChatBg(cfg = state.chatBg): void {
  const el = $("#chatBg");
  if (!el) return;
  const active = !!cfg.image && cfg.mode !== "off";
  el.classList.toggle("ambient", active && cfg.mode === "ambient");
  el.classList.toggle("flashlight", active && cfg.mode === "flashlight");
  el.style.setProperty("--bg-op", String(cfg.opacity || 0.25));
  el.style.backgroundImage = active ? `url("${cfg.image}")` : "";
  if (active && cfg.mode === "flashlight") ensureChatBgTracking();
}
let chatBgTracking = false;
function ensureChatBgTracking(): void {
  if (chatBgTracking) return;
  const center = document.querySelector(".center") as HTMLElement | null;
  if (!center) return;
  chatBgTracking = true;
  center.addEventListener("mousemove", (e) => {
    const bg = $("#chatBg");
    if (!bg || !bg.classList.contains("flashlight")) return;
    const r = center.getBoundingClientRect();
    bg.style.setProperty("--mx", `${(e as MouseEvent).clientX - r.left}px`);
    bg.style.setProperty("--my", `${(e as MouseEvent).clientY - r.top}px`);
  });
  center.addEventListener("mouseleave", () => { const bg = $("#chatBg"); bg?.style.setProperty("--mx", "-600px"); bg?.style.setProperty("--my", "-600px"); });
}
async function updateChatBg(patch: { image?: string; mode?: "off" | "ambient" | "flashlight"; opacity?: number }): Promise<void> {
  const r = await bridge.setChatBackground(patch).catch(() => null);
  if (!r) { showToast({ tone: "warn", title: "Couldn't update background", desc: "The image may be too large - try one under ~9 MB.", timeout: 3600 }); return; }
  state.chatBg = r; applyChatBg(r);
  if (state.settingsOpen) fillSec("appearance", secAppearance());
}
function secAppearance(): string {
  const c = state.chatBg;
  const modeOpt = (v: string, l: string) => `<option value="${v}"${c.mode === v ? " selected" : ""}>${l}</option>`;
  const thumb = c.image
    ? `<div class="bg-thumb" style="background-image:url('${c.image}')"></div>`
    : `<div class="bg-thumb empty">no image</div>`;
  const inner = `
    <div class="bg-row">${thumb}
      <div class="bg-controls">
        <input type="file" id="bgFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
        <button type="button" class="btn-mini" id="bgUpload">${icon("folder", 12)} ${c.image ? "Replace image…" : "Choose image…"}</button>
        ${c.image ? `<button type="button" class="btn-mini danger" id="bgClear">Remove</button>` : ""}
      </div></div>
    <div class="goal-row"><label class="goal-lbl" for="bgMode">Display</label>
      <select id="bgMode" class="prov-key">${modeOpt("off", "Off")}${modeOpt("ambient", "Ambient - faint 25% wash")}${modeOpt("flashlight", "Flashlight - reveal on hover")}</select></div>
    <div class="set-note">${icon("info", 12)} <b>Ambient</b> shows your image faintly (25%) behind the whole chat. <b>Flashlight</b> keeps the background black and reveals the image only under your cursor - like a flashlight sweeping a dark room.</div>`;
  return setCard("appearance", "Chat background", "personalize · 25% opacity", inner, true);
}

// ── P-TRIV.4 (ADR-0191): Settings -> Trivia Wire ─────────────────────────────────────────────────
// The real on/off toggle (no more hand-editing localStorage), the opt-in re-seed sources, and the
// "Recycle" button that regenerates the per-role pack on the user's SELECTED model. Rendered from
// localStorage + state (no fetch); the Recycle button is the only control that reaches the backend.
function secTrivia(): string {
  const on = triviaEnabled();
  const toggle = `<label class="set-toggle"><input type="checkbox" id="trivToggle" ${on ? "checked" : ""}/>
      <span><b>Show the Trivia Wire</b> - a word-game ticker that scrolls in the status bar while the agent works, or when you're idle with work to return to. Answer with a click or the A-D keys.</span></label>`;
  if (!on) return setCard("trivia", "Trivia Wire", "status-bar game", toggle + `<div class="set-note">${icon("info", 12)} Off - the ticker stays hidden everywhere until you switch it back on here.</div>`, true);

  const role = state.userRole || "developer";
  const src = triviaSources();
  const cb = (id: string, checked: boolean, label: string, tip: string): string =>
    `<label class="set-toggle triv-src"><input type="checkbox" id="${id}" ${checked ? "checked" : ""}/><span data-tip="${tip}">${label}</span></label>`;
  const sources = `<div class="triv-lbl">Personalize from your context <span class="info-dot" data-tip="Personalize the questions|Pick which of your own on-device context the model may read to choose topics. Each source is scanned before the model sees it; the run is tool-free.">${icon("info", 11)}</span></div>
    ${cb("trivSrcSessions", src.sessions, "Past sessions &amp; chats", "Recent work|Reads the titles of your recent chats in this workspace to pick topics. On-device, scanned before use.")}
    ${cb("trivSrcKg", src.kg, "Knowledge Graph", "Your knowledge graph|Reads your saved interests &amp; skills. Only used when your Knowledge Graph is unlocked - otherwise it contributes nothing.")}
    ${cb("trivSrcCode", src.codegraph, "Code graph", "Workspace code|Reads file/symbol names from the code graph to infer your stack. Only used once the code graph has been built.")}`;

  const model = state.model ? esc(modelLabel(state.model)) : "your model";
  const reseedTip = `Recycle the trivia|Generates a fresh ${esc(role)} pack with ${model} from the sources you've checked. Runs on your model, scanned and tool-free. Falls back to the built-in pack if it can't.`;
  const reseed = `<div class="triv-reseed"><button class="btn-mini" id="trivReseed" ${state.model ? "" : "disabled"} data-tip="${reseedTip}">${icon("refresh", 12)} Recycle trivia</button></div>`;

  const pack = storedTriviaPack(role);
  const status = pack
    ? `<div class="set-note ok">${icon("check", 12)} Using a generated ${esc(role)} pack (${pack.length} questions). <button class="btn-mini triv-reset" id="trivPackReset">${icon("restore", 11)} Use built-in</button></div>`
    : `<div class="set-note">${icon("info", 12)} Using the built-in ${esc(role)} pack. Check a source and Recycle to tailor it to your work.</div>`;

  return setCard("trivia", "Trivia Wire", "status-bar game · on-device", toggle + sources + reseed + status, true);
}

/** Run an AI re-seed: the backend gathers the checked sources, scans them fail-closed, and generates a
 *  pack on the SELECTED model. Adopt a valid pack; otherwise keep the current one (fail-quiet). Drives
 *  the button's busy state and re-renders the card. */
async function reseedTrivia(btn: HTMLButtonElement | null): Promise<void> {
  if (!state.model) { showToast({ tone: "warn", title: "Pick a model first", desc: "Choose your AI model in the picker, then recycle the trivia.", timeout: 3000 }); return; }
  const role = state.userRole || "developer";
  const orig = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = `${icon("refresh", 12)} Generating…`; }
  try {
    const res = await bridge.triviaReseed({ model: state.model, role, sources: triviaSources() }).catch(() => null);
    const qs = res?.ok && Array.isArray(res.questions) ? res.questions.filter(isTriviaQuestion) : [];
    if (qs.length >= TRIVIA_MIN_PACK) {
      applyTriviaPack(role, qs, res!.model || state.model);
      showToast({ tone: "ok", title: "Fresh trivia ready", desc: `${qs.length} questions generated for your ${role} role${res!.usedSources?.length ? ` from ${res!.usedSources.join(", ")}` : ""}.`, timeout: 3600 });
      return;
    }
    const blocked = !!res?.blocked;
    showToast({
      tone: blocked ? "warn" : "info",
      title: blocked ? "Re-seed blocked" : "Kept the current pack",
      desc: blocked
        ? "The source content didn't pass the security scan, so nothing was generated - your current pack is unchanged."
        : `${res?.reason || "The model didn't return enough usable questions"} - keeping your current pack.`,
      timeout: 4200,
    });
  } finally {
    if (btn && orig !== undefined) { btn.disabled = false; btn.innerHTML = orig; }
    fillSec("trivia", secTrivia());
  }
}

function settingsShell(): string {
  return [
    `<div data-sec="workspace"></div>`,
    // Profile is just the local name we already hold in state - render it instantly (no skeleton /
    // no fetch wait; the first /api/settings call pays a ~0.6s cold cost that made this lag).
    secProfile({ username: state.username, email: state.email, attribution: state.attribution ?? undefined }),
    setSkel("personal", "Personalization", "private · encrypted · opt-in", true),
    // AskSage gov gateway sits ABOVE Providers (the foregrounded, accredited path), with its monthly-tokens
    // bar directly under it; the direct U.S. providers tuck into a default-collapsed card below.
    setSkel("asksage", "AskSage gov gateway", "accredited proxy", true),
    `<div data-sec="asksageQuota"></div>`, // AskSage Monthly-tokens bar - ONLY when the gov gateway is configured (filled in hydrateSettings)
    setSkel("providers", "Providers", "U.S. frontier · key or OAuth", true),
    setSkel("localProviders", "Local Providers", "self-hosted · Ollama · vLLM · VPN", true), // P-LOCAL.3 (ADR-0135); auto-collapsed
    `<div data-sec="sovereignty"></div>`, // P-IDE.1c: China-origin unlock (renders only when such models exist)
    setSkel("compression", "Token compression", "headroom · on-device · opt-in", true),
    setSkel("mcp", "MCP connectors", "model context protocol", true),
    setSkel("agents", "Remote agents", "hermes · openclaw · ACP firewall", true), // P-AGENTFW.2 (ADR-0149)
    setSkel("whitelist", "Network Whitelist", "domains · IPs · trust-scoped", true), // P-NETWL.2 (ADR-0106)
    setSkel("others", "More providers", "", true),
    setSkel("voice", "Voice", "TTS · STT · ElevenLabs", true), // P-VOICE.1 (ADR-0115)
    secAppearance(), // P-APPEAR.1: chat background (rendered from state - loaded at boot, no fetch wait)
    secTrivia(), // P-TRIV.4 (ADR-0191): the Trivia Wire toggle + AI re-seed (rendered from state/localStorage)
    setSkel("developer", "Developer", "logs · diagnostics", true),
    `<div class="set-note">${icon("shield", 12)} Keys are stored on this machine and passed to omp as env vars - never sent anywhere else. OAuth uses omp's own secure credential vault.</div>`,
  ].join("");
}
/** Re-fetch + swap each section IN PLACE (old content stays until fresh arrives - no flash). */
function hydrateSettings(): void {
  void bridge.workspace().then((ws) => {
    if (ws) { state.workspace = ws; renderWorkspaceBar(); }
    const el = document.querySelector(`#setBody [data-sec="workspace"]`);
    if (el) el.outerHTML = `<div data-sec="workspace">${ws ? workspaceSection(ws) : ""}</div>`;
  });
  // Profile already painted from cache; refresh from disk only if it changed AND the user isn't typing.
  void bridge.getSettings().then((s) => {
    if (!s) return;
    state.attribution = s.attribution ?? state.attribution;
    const typing = document.activeElement?.id === "setUsername" || document.activeElement?.id === "setEmail";
    if (!typing && (s.username !== state.username || s.email !== state.email)) {
      state.username = s.username; state.email = s.email;
    }
    if (!typing) fillSec("profile", secProfile(s));
  });
  void bridge.auth().then((a) => {
    state.auth = a; // store so the AskSage gateway card can render its key entry from auth.gateway
    fillSec("providers", secProviders(a)); fillSec("others", secOthers(a));
    fillSec("asksage", secAsksage(state.asksage, null)); // inject the ASKSAGE_API_KEY row now that gateway auth is known
    // P-VOICE.1 (ADR-0115): the Voice card needs auth (ElevenLabs key state) + the voice settings, then loads voices.
    void bridge.voiceSettings().then((vset) => { fillSec("voice", secVoice(a, vset)); void loadVoices(); });
    renderStatus(); // a just-added/removed key flips the OAuth-vs-key budget-pill gate
  });
  fillSec("sovereignty", secSovereignty()); // P-IDE.1c: only renders a card when China-origin models exist
  void bridge.headroom().then((h) => fillSec("compression", secCompression(h)));
  fillSec("developer", secDeveloper()); // ADR-0059: render from state.developerMode (loaded by loadDev)
  void hydratePersonal();
  hydrateMcp();
  hydrateAgents(); // P-AGENTFW.2 (ADR-0149)
  void hydrateLocalProviders(); // P-LOCAL.3 (ADR-0135)
  hydrateWhitelist(); // P-NETWL.2 (ADR-0106)
  void bridge.asksage().then(async (a) => {
    if (a) state.asksage = a;
    fillSec("asksage", secAsksage(a, null)); // paint immediately (token readout shows a spinner)
    fillSec("asksageQuota", secAsksageQuota(a)); // Monthly-tokens bar above Providers (spinner or empty)
    if (a?.configured) {
      state.asksageTokens = await bridge.asksageTokens(); // live used + remaining from the Civ API
      fillSec("asksage", secAsksage(a, null));            // re-render so the real numbers populate
      fillSec("asksageQuota", secAsksageQuota(a));        // swap the spinner for the real numbers
      if (a.only) { // only lockdown needs datasets/personas - fetch them after
        const datasets = await bridge.asksageDatasets();
        if (!state.personas.length) state.personas = (await bridge.asksagePersonas()) ?? [];
        fillSec("asksage", secAsksage(a, datasets));
      }
    }
  });
}
function renderSettings(): void {
  const body = $("#setBody"); if (!body) return;
  if (!body.querySelector("[data-sec]")) body.innerHTML = settingsShell(); // first open: skeleton
  hydrateSettings(); // then fill in place
}

// Per-compartment security posture + risk-mitigation notice (ADR-0012). `combined` is a
// union view; new facts still default to Personal.
const SCOPE_INFO: Record<string, { label: string; tone: "ok" | "warn" | "danger"; note: string }> = {
  personal: { label: "Personal Life", tone: "ok", note: "Private to you and encrypted on this device. Used only to tailor responses. New facts are stored here by default." },
  work: { label: "Work", tone: "warn", note: "May include employer-confidential context. Don't store secrets or credentials here; review before exporting or sharing across tools." },
  combined: { label: "Combined", tone: "warn", note: "A union view of Personal + Work + CUI. This crosses boundaries - take care when exporting or sharing. New facts still default to Personal." },
  cui: { label: "CUI", tone: "danger", note: "Controlled Unclassified Information handling. Encrypted at rest and NEVER auto-exported or shared with external consumers/harnesses. Follow your organization's CUI policy (e.g. NIST SP 800-171). Do NOT enter classified information." },
};
const SCOPE_ORDER = ["personal", "work", "combined", "cui"] as const;

/** Re-render just the Personalization card (instant - the endpoint is local). */
function hydratePersonal(): Promise<void> {
  return bridge.personal().then((p) => fillSec("personal", secPersonal(p)));
}

// ── P-LOCAL.3 (ADR-0135): Settings → Local Providers ─────────────────────────────────────────────
/** Re-render the Local Providers card from the current list + which credential refs are in the vault. */
async function hydrateLocalProviders(): Promise<void> {
  const [providers, creds] = await Promise.all([
    bridge.localProvidersList().catch(() => [] as import("../local_providers.ts").LocalProviderDef[]),
    bridge.credList().catch(() => [] as import("./bridge.ts").CredMetaView[]),
  ]);
  state.localProviders = providers ?? [];
  const vaultRefs = new Set((creds ?? []).map((c) => c.ref));
  fillSec("localProviders", localProvidersCardBody(state.localProviders, vaultRefs, bridge.isElectron));
}

/** Add a provider from the card's form: validate → (if authed) store the key in the vault → save the def. */
async function addLocalProviderFromForm(): Promise<void> {
  const val = (id: string): string => (($(`#${id}`, $("#setBody")!) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "");
  const external = ($("#lpExternal", $("#setBody")!) as HTMLInputElement | null)?.checked ?? false;
  const draft = draftFromForm({ name: val("lpName"), baseUrl: val("lpBaseUrl"), auth: val("lpAuth"), models: val("lpModels"), external }, Date.now());
  if (draft.errors.length || !draft.def) { showToast({ tone: "warn", title: "Check the provider details", desc: draft.errors[0] ?? "invalid" }); return; }
  const def = draft.def;
  if (draft.needsKey) {
    const key = val("lpKey").trim();
    if (!key) { showToast({ tone: "warn", title: "Paste the API key", desc: "It goes straight to the OS-encrypted vault." }); return; }
    if (!bridge.isElectron || !bridge.credStore) { showToast({ tone: "danger", title: "Vault is desktop-only", desc: "Open the LUCID desktop app to store the key securely." }); return; }
    const ref = `lpkey_${def.id}`;
    const r = await bridge.credStore({ ref, kind: def.authKind === "basic" ? "basic" : "apikey", secret: key, label: `Local Provider · ${def.name}` });
    if (!r || "error" in r) { showToast({ tone: "danger", title: "Couldn't store the key", desc: (r as { error?: string })?.error ?? "vault error" }); return; }
    def.vaultRef = ref;
  }
  const saved = await bridge.localProviderUpsert(def);
  if (saved && "saved" in saved && saved.saved) {
    showToast({ tone: "ok", title: "Local provider added", desc: `${def.name} - takes effect on the next app restart.` });
    void hydrateLocalProviders();
  } else {
    showToast({ tone: "danger", title: "Couldn't save the provider", desc: (saved as { errors?: string[] })?.errors?.[0] ?? "save error" });
  }
}

/** Remove a provider (its vault key is left in the vault; the user can delete it from the whitelist/vault UI). */
async function deleteLocalProvider(id: string): Promise<void> {
  await bridge.localProviderDelete(id).catch(() => null);
  void hydrateLocalProviders();
}

/** Reachability/TLS probe of an endpoint (no key sent). */
async function testLocalProviderConn(baseUrl: string): Promise<void> {
  const u = (baseUrl || "").trim();
  if (!u) { showToast({ tone: "warn", title: "Enter a base URL first", desc: "Type the endpoint's base URL, then test it." }); return; }
  showToast({ title: "Testing connection…", desc: u, timeout: 1400 });
  const r = await bridge.localProviderTest(u).catch(() => null);
  if (r?.reachable) {
    showToast({ tone: "ok", title: "Endpoint reachable", desc: `HTTP ${r.status}${r.authed ? " · auth required (the key is sent at run time, from the vault)" : ""}.` });
  } else {
    const hint = u.startsWith("https") ? " Check the VPN tunnel, TLS cert, and port." : " Check the host/port - is the server running?";
    showToast({ tone: "danger", title: "Not reachable", desc: (r?.error ?? "no response.") + hint });
  }
}

/** Store (or rotate) an authed provider's key straight into the OS-encrypted vault, from the inline row. */
async function saveLocalProviderKey(wrap: HTMLElement): Promise<void> {
  const id = wrap.dataset.lpId ?? "";
  const def = state.localProviders.find((p) => p.id === id);
  if (!def) return;
  const key = (($(".lp-rekey-input", wrap) as HTMLInputElement | null)?.value ?? "").trim();
  if (!key) { showToast({ tone: "warn", title: "Paste the key first", desc: "It goes straight to the OS-encrypted vault." }); return; }
  if (!bridge.isElectron || !bridge.credStore) { showToast({ tone: "danger", title: "Vault is desktop-only", desc: "Open the LUCID desktop app." }); return; }
  const ref = def.vaultRef || `lpkey_${def.id}`;
  const r = await bridge.credStore({ ref, kind: def.authKind === "basic" ? "basic" : "apikey", secret: key, label: `Local Provider · ${def.name}` });
  if (!r || "error" in r) { showToast({ tone: "danger", title: "Couldn't store the key", desc: (r as { error?: string })?.error ?? "vault error" }); return; }
  if (def.vaultRef !== ref) { def.vaultRef = ref; await bridge.localProviderUpsert(def).catch(() => null); }
  showToast({ tone: "ok", title: "Key stored in the vault", desc: `${def.name} - restart to apply.` });
  void hydrateLocalProviders();
}
// Settings → Personalization (ADR-0010/0012): opt-in encrypted KG + the
// Work/Personal/Combined/CUI compartment selector with per-mode risk notices.
function secPersonal(p: import("./bridge.ts").PersonalStatus | null): string {
  const card = (inner: string) => setCard("personal", "Personalization", "private · encrypted · opt-in", inner, true);
  if (!p) return card(`<div class="set-note">${icon("info", 12)} Personalization is unavailable - update the GUI server.</div>`);
  const toggle = `<label class="set-toggle"><input type="checkbox" id="personalToggle" ${p.enabled ? "checked" : ""}/>
      <span><b>Learn about me to tailor responses</b> - a private knowledge graph of your preferences, decisions, interests &amp; style, encrypted on this device (AES-256-GCM). Off by default.</span></label>`;
  if (!p.enabled) return card(toggle + `<div class="set-note">${icon("shield", 12)} Nothing is learned, stored, or recalled until you enable this. Everything stays local; you can forget or export it anytime.</div>`);

  let inner: string;
  if (!p.configured) {
    inner = `<div class="set-note">${icon("info", 12)} Set a passphrase to create your encrypted store. It protects your data and <b>cannot be recovered</b> if lost.</div>
      <div class="prov-row"><input id="personalPass" class="prov-key" type="password" placeholder="New passphrase (min 8 chars)" autocomplete="new-password" />
        <button class="btn-mini ok" id="personalSetup">${icon("shield", 12)} Create</button></div>`;
  } else if (!p.unlocked) {
    inner = `<div class="set-note">${icon("info", 12)} Your store is locked. Enter your passphrase to unlock it this session.</div>
      <div class="prov-row"><input id="personalPass" class="prov-key" type="password" placeholder="Passphrase" autocomplete="current-password" />
        <button class="btn-mini ok" id="personalUnlock">${icon("shield", 12)} Unlock</button></div>`;
  } else {
    const cur = p.scope;
    const seg = SCOPE_ORDER.map((sc) => `<button class="seg-btn pscope${sc === cur ? " on" : ""}" data-pscope="${sc}" data-tip="${esc(SCOPE_INFO[sc]!.label)}|${esc(SCOPE_INFO[sc]!.note)}" data-tip-side="top">${esc(SCOPE_INFO[sc]!.label)}</button>`).join("");
    const info = SCOPE_INFO[cur] ?? SCOPE_INFO.personal!;
    const c = p.counts ?? { work: 0, personal: 0, cui: 0 };
    inner = `<div class="set-note ok">${icon("check", 12)} Unlocked. New facts pass the security gate before they're remembered; you stay in control.</div>
      <div class="pscope-lbl">Compartment <span class="info-dot" data-tip="Data compartments|Keep Work, Personal, and CUI knowledge separate. CUI lives in its OWN encrypted store with its own passphrase (ADR-0014) and auto-locks when not selected. The active compartment scopes what is learned and recalled; Combined is a union view (never CUI).">${icon("info", 11)}</span></div>
      <div class="seg pscope-seg">${seg}</div>
      <div class="pscope-note ${info.tone}">${icon(info.tone === "danger" ? "shield" : "info", 13)} <span>${esc(info.note)}</span></div>
      <div class="pscope-counts">
        <div class="psc"><b class="psc-personal">${c.personal}</b><span>personal</span></div>
        <div class="psc"><b class="psc-work">${c.work}</b><span>work</span></div>
        <div class="psc"><b class="psc-cui">${p.cuiUnlocked ? c.cui : "-"}</b><span>cui${p.cuiUnlocked ? "" : " (locked)"}</span></div></div>
      ${cur === "cui" ? secCui(p) : ""}
      ${p.legacyCuiInMain > 0 ? `<div class="set-note warn">${icon("info", 12)} <span>${p.legacyCuiInMain} legacy CUI fact(s) sit in the main store from before isolation - not recalled or exported. ${p.cuiUnlocked ? `<button class="btn-mini" id="cuiMigrate" data-tip="Move into the isolated store|Relocates these cui facts (ids + timestamps preserved) into the separate CUI store, then removes them from the main store. Audited.">${icon("shield", 11)} Move into the CUI store</button>` : "Select CUI and unlock its store to move them into isolation."}</span></div>` : ""}
      <label class="set-toggle" style="margin-top:10px;border-top:1px solid var(--line-soft);padding-top:10px"><input type="checkbox" id="personalAiToggle" ${p.aiExtract ? "checked" : ""}/>
        <span><b>Richer graph (uses the model)</b> - extract semantic facts &amp; relationships with the model instead of offline patterns, so related ideas connect across turns. Costs one extra model call per turn. Off by default.</span></label>
      <button class="btn-mini pscope-lock" id="personalLock" data-tip="Lock everything|Wipes BOTH in-memory keys (main + CUI). You'll re-enter your passphrase to use personalization again this session - nothing is learned or recalled while locked." data-tip-side="top">${icon("shield", 12)} Lock</button>`;
  }
  return card(toggle + inner);
}
// The isolated CUI store's own setup/unlock/lock (P9.5a, ADR-0014). Its own file + passphrase
// + DEK, so one key never decrypts both CUI and non-CUI. Auto-locks when CUI is deselected.
function secCui(p: import("./bridge.ts").PersonalStatus): string {
  const shield = icon("shield", 12);
  // Records destruction is available whenever a CUI store file exists (P9.5b, NARA-aligned).
  const destroy = p.cuiConfigured ? `<button class="btn-mini danger" id="cuiDestroy" data-tip="Destroy CUI records|Irreversibly deletes the encrypted CUI store file and wipes its key. NARA-aligned records destruction - this cannot be undone.">${icon("close", 12)} Destroy CUI records</button>` : "";
  if (!p.cuiConfigured) {
    return `<div class="pscope-cui">
      <div class="set-note danger">${shield} The CUI compartment uses a <b>separate encrypted store</b> with its <b>own passphrase</b> (recommended distinct from your main one). Create it to start storing CUI in isolation.</div>
      <div class="prov-row"><input id="cuiPass" class="prov-key" type="password" placeholder="New CUI passphrase (min 8)" autocomplete="new-password" />
        <button class="btn-mini danger" id="cuiSetup">${shield} Create CUI store</button></div></div>`;
  }
  if (!p.cuiUnlocked) {
    return `<div class="pscope-cui">
      <div class="set-note danger">${shield} The CUI store is <b>locked</b> (it locks whenever CUI isn't selected). Enter its passphrase to unlock it for this session.</div>
      <div class="prov-row"><input id="cuiPass" class="prov-key" type="password" placeholder="CUI passphrase" autocomplete="current-password" />
        <button class="btn-mini danger" id="cuiUnlock">${shield} Unlock CUI</button></div>
      <div class="pscope-cui-actions">${destroy}</div></div>`;
  }
  return `<div class="pscope-cui">
    <div class="set-note ok">${icon("check", 12)} CUI store unlocked for this session. It auto-locks when you switch away from CUI.</div>
    <div class="pscope-cui-actions">
      <button class="btn-mini" id="cuiLock" data-tip="Lock the CUI store|Wipes only the CUI key. Your main store stays unlocked.">${shield} Lock CUI</button>
      ${destroy}</div></div>`;
}
function openSettings(): void {
  closeKnowledge();
  closeIde(); // P-IDE.4: right-edge surfaces are mutually exclusive
  closeSkills(); // P-SKILL.4
  state.settingsOpen = true;
  if (!state.sidebarCollapsed) toggleSidebar(true); // give the chat room; reopen sessions via the hamburger
  $("#settings")!.hidden = false;
  $("#inspector")!.hidden = true;
  $$(".rail-btn").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.rail === "settings"));
  void renderSettings();
}
function closeSettings(): void {
  if (!state.settingsOpen) return;
  state.settingsOpen = false;
  $("#settings")!.hidden = true;
  $("#inspector")!.hidden = false;
  $$(".rail-btn").forEach((b) => b.classList.remove("active"));
  $('.rail-btn[data-rail="chat"]')?.classList.add("active");
}

// ── P-SKILL.4 (ADR-0097): the Skills directory + management fly-out ───────────────────────────────
// A right-edge aside (mutually exclusive with the other surfaces, like Settings). renderSkills composes
// the bundled corpus + the discovered /api/skills list into ONE governed directory; the per-row menu
// (event-delegated below) inspects / re-scans / removes / enables each skill. The enable toggle is the
// SAME decision the delivery path uses (skills.ts isSkillEnabled), so disabling here truly stops a skill
// being offered/loaded; a flagged skill's toggle is locked (invariant #3, keystone #2).
let skillsOpen = false;
function openSkills(): void {
  skillsOpen = true;
  closeSettings(); closeKnowledge(); closePreview(); closeAgentBuilder(); closeIde();
  if (!state.sidebarCollapsed) toggleSidebar(true);
  $("#skillsDir")!.hidden = false;
  $("#inspector")!.hidden = true;
  $$(".rail-btn").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.rail === "skills"));
  void renderSkills();
}
function closeSkills(): void {
  if (!skillsOpen) return;
  skillsOpen = false;
  $("#skillsDir")!.hidden = true;
  $("#inspector")!.hidden = false;
  $$(".rail-btn").forEach((b) => b.classList.remove("active"));
  $('.rail-btn[data-rail="chat"]')?.classList.add("active");
}
/** Compose the directory rows (bundled inline + discovered from the server), resolve each row's
 *  enabled/trust/enableable, and paint. Bundled skills are identified by their kebab `command`. */
async function renderSkills(): Promise<void> {
  const body = $("#skillsBody"); if (!body) return;
  await loadSkills(); // refresh state.skills (discovered on-disk skills); bundled are inline
  const rows: SkillDirRow[] = [];
  for (const s of INSTALLED_SKILLS) {
    const key = skillKey("bundled", s.command);
    rows.push({ key, name: s.command, description: s.description, root: "bundled", trust: "trusted", invocation: s.command, removable: false, enabled: isSkillEnabled(key, "trusted"), enableable: true, fileBacked: false });
  }
  for (const s of state.skills) {
    const key = skillKey(s.root, s.name);
    rows.push({ key, name: s.name, description: s.description, root: s.root, trust: s.trust, invocation: s.invocation, removable: s.removable, enabled: isSkillEnabled(key, s.trust), enableable: trustEnableable(s.trust), fileBacked: true, scanned: s.scanned ? { findings: s.scanned.findings, at: s.scanned.at } : null });
  }
  body.innerHTML = `<button class="btn-mini skdir-studio-cta" id="skillStudioBtn" data-tip="Skill Studio - analyze your recent work and draft new skills (each scanned before it saves)">${icon("spark", 13)} Draft skills from recent work</button>` + renderSkillsDirectory(rows);
}
/** Event-delegated per-row menu: toggle enable, inspect, re-scan, remove. */
async function onSkillAction(e: Event): Promise<void> {
  if ((e.target as HTMLElement).closest("#skillStudioBtn")) { await openSkillStudio(); return; } // P-SKILL.5
  const t = (e.target as HTMLElement).closest("[data-skill-act]") as HTMLElement | null;
  if (!t) return;
  const act = t.dataset.skillAct;
  if (act === "toggle") {
    const key = t.dataset.skillKey!; const trust = (t.dataset.skillTrust ?? "untrusted") as TrustLabel;
    const next = setSkillEnabled(key, trust, !isSkillEnabled(key, trust));
    // Disabling the ACTIVE bundled skill must also clear it so it stops steering the agent.
    if (!next && state.activeSkill && skillKey("bundled", state.activeSkill.command) === key) await clearBundledSkill();
    await renderSkills();
    return;
  }
  const name = t.dataset.skillName!;
  if (act === "inspect") { await openSkillInspect(name, (t.dataset.skillRoot ?? "project") as SkillRoot); return; }
  if (act === "rescan") {
    const r = await bridge.skillRescan(name);
    if (r) showToast({ title: `Re-scanned: ${name}`, desc: `trust = ${r.trust}${r.blocked ? " \u00b7 flagged" : ""}${r.findings ? ` \u00b7 ${r.findings} finding(s)` : ""}`, tone: r.blocked ? "warn" : undefined, timeout: 3200 });
    await renderSkills();
    return;
  }
  if (act === "remove") {
    showToast({
      title: `Remove skill \u201c${name}\u201d?`,
      desc: "Deletes its folder from disk. This can't be undone.",
      actions: [{ label: "Remove", kind: "danger", run: () => void doRemoveSkill(name) }, { label: "Cancel" }],
      timeout: 8000,
    });
  }
}
async function doRemoveSkill(name: string): Promise<void> {
  const r = await bridge.skillRemove(name);
  if (r?.ok) showToast({ title: `Removed: ${name}`, desc: "The skill folder was deleted.", timeout: 2600 });
  else showToast({ tone: "warn", title: `Could not remove ${name}`, desc: r?.reason ?? "unavailable", timeout: 3200 });
  await renderSkills();
}
/** Inspect one skill in a scrim modal. Bundled bodies are the inline systemPrompt (no server round-trip);
 *  discovered skills read their SKILL.md server-side. The body renders escaped, as DATA (invariant #5). */
async function openSkillInspect(name: string, root: SkillRoot): Promise<void> {
  if ($("#skInspectModal")) return;
  let view: SkillInspectView;
  if (root === "bundled") {
    const s = INSTALLED_SKILLS.find((x) => x.command === name);
    view = s ? { ok: true, name, root: "bundled", trust: "trusted", body: s.systemPrompt, resources: [] } : { ok: false, name, reason: "unknown built-in skill" };
  } else {
    view = (await bridge.skillInspect(name)) ?? { ok: false, name, reason: "unavailable" };
  }
  const ov = el(`<div id="skInspectModal" class="mkt-scrim"><div class="sk-inspect-card">${renderSkillInspect(view)}<button class="set-close sk-inspect-x" data-sk-close>${icon("close", 16)}</button></div></div>`);
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); close(); } };
  ov.addEventListener("click", (ev) => { const el2 = ev.target as HTMLElement; if (el2 === ov || el2.closest("[data-sk-close]")) close(); });
  document.addEventListener("keydown", onKey);
  document.body.append(ov);
}

// ── P-SKILL.5 (ADR-0101): Skill Studio — draft skills from recent work ─────────────────────────────────
// A scrim modal launched from the Skills directory. Pick a window → Analyze (the server gathers recent
// work + asks the model for candidates) → review/edit each candidate → Codify (runs it through the same
// fail-closed import gate; clean saves into the directory, flagged blocks). Nothing is written until codify.
async function openSkillStudio(): Promise<void> {
  if ($("#skStudioModal")) return;
  const ov = el(`<div id="skStudioModal" class="mkt-scrim"><div class="sk-studio-card">
    <div class="sk-studio-hd">${icon("spark", 15)} <b>Skill Studio</b> <span class="set-sub">draft skills from your recent work</span>
      <button class="set-close" data-sk-close data-tip="Close">${icon("close", 16)}</button></div>
    <div class="sk-studio-controls">
      <div class="seg sk-studio-win" data-sk-window><button class="on" data-win="today">Today</button><button data-win="week">Past 7 days</button></div>
      <button class="btn-mini" id="skStudioAnalyze">${icon("spark", 13)} Analyze</button>
    </div>
    <div class="sk-studio-body" id="skStudioBody"><div class="skdir-muted">Pick a window and Analyze - LUCID reads your recent sessions, AI-authored code, and loop outcomes, then drafts candidate skills with your most-used model. Each is scanned before it can be saved; you review + edit before codifying.</div></div>
  </div></div>`);
  let win: "today" | "week" = "today";
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); close(); } };
  ov.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t === ov || t.closest("[data-sk-close]")) return close();
    const winBtn = t.closest("[data-win]") as HTMLElement | null;
    if (winBtn) { win = winBtn.dataset.win === "week" ? "week" : "today"; ov.querySelectorAll("[data-win]").forEach((b) => b.classList.toggle("on", b === winBtn)); return; }
    if (t.closest("#skStudioAnalyze")) { void runStudioAnalyze(win, ov); return; }
    const codify = t.closest("[data-sk-codify]") as HTMLElement | null;
    if (codify) { void runStudioCodify(codify); return; }
  });
  document.addEventListener("keydown", onKey);
  document.body.append(ov);
}
async function runStudioAnalyze(win: "today" | "week", ov: HTMLElement): Promise<void> {
  const bodyEl = ov.querySelector("#skStudioBody"); if (!bodyEl) return;
  bodyEl.innerHTML = `<div class="skdir-muted">${icon("refresh", 13)} Analyzing your ${win === "today" ? "day" : "week"}\u2026</div>`;
  const res = await bridge.skillStudioAnalyze(win).catch(() => null);
  if (!res || !res.candidates.length) {
    bodyEl.innerHTML = `<div class="skdir-muted">No skill candidates${res ? ` (model: ${esc(res.model)})` : ""}. Try the wider window, or do more work first.</div>`;
    return;
  }
  bodyEl.innerHTML = `<div class="sk-studio-note">${res.candidates.length} candidate(s) from <b>${esc(res.model)}</b> - review + edit, then Codify. Each is scanned before it saves; a flagged draft is blocked.</div>` + res.candidates.map(renderStudioCandidate).join("");
}
async function runStudioCodify(btn: HTMLElement): Promise<void> {
  const card = btn.closest(".sk-cand") as HTMLElement | null; if (!card) return;
  const name = card.dataset.candName ?? "";
  const description = card.dataset.candDesc ?? "";
  const body = (card.querySelector(".sk-cand-body") as HTMLTextAreaElement | null)?.value ?? "";
  const r = await bridge.skillStudioDraft({ name, description, body }).catch(() => null);
  if (r?.ok) {
    card.classList.add("codified");
    btn.textContent = "Codified"; (btn as HTMLButtonElement).disabled = true;
    showToast({ title: `Codified: ${name}`, desc: "Scanned clean + saved. It's in your Skills directory (untrusted until you re-scan).", timeout: 3400 });
    if (skillsOpen) void renderSkills();
  } else {
    showToast({ tone: "warn", title: `Blocked: ${name}`, desc: r?.reason ?? "flagged by the scanner - not saved.", timeout: 3800 });
  }
}

// P-IMP.2 (ADR-0035): open Settings with the Personalization section expanded + scrolled into view -
// the nudge CTA, and the entry point for a brand-new user to enable + set a passphrase.
function openPersonalizationSettings(): void {
  SET_OPEN.add("personal");
  openSettings();
  setTimeout(() => {
    const sec = $('[data-sec="personal"]') as HTMLElement | null;
    sec?.classList.add("open");
    sec?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 120);
}

// First-run onboarding: while personalization is UNCONFIGURED, keep the Personalization settings
// section expanded (so enable→passphrase is discoverable, not buried in a collapsed accordion), and
// show a one-time nudge toast guiding the user to import their ChatGPT/Claude/Gemini history.
async function maybeOnboardPersonal(): Promise<void> {
  let p: import("./bridge.ts").PersonalStatus | null = null;
  try { p = await bridge.personal(); } catch { return; }
  if (p?.configured) return; // already set up → normal (collapsed-by-default) behavior
  SET_OPEN.add("personal"); // unconfigured → expand the section whenever Settings opens
  let nudged = false; try { nudged = localStorage.getItem("lucid.personalNudged") === "1"; } catch { /* ignore */ }
  if (nudged) return; // the toast is one-time; the expanded section persists until they configure
  try { localStorage.setItem("lucid.personalNudged", "1"); } catch { /* ignore */ }
  setTimeout(() => showToast({
    title: "Make LucidAgent yours",
    desc: "Import your ChatGPT, Claude, or Gemini history to tailor replies. It's encrypted on this device, scanned by the security gate, and you can forget or export anything anytime.",
    meta: "Private · on-device · opt-in",
    tone: "info",
    actions: [{ label: "Set up personalization", kind: "ok", run: () => openPersonalizationSettings() }, { label: "Later" }],
    timeout: 0,
  }), 1500);
}

// ───────────────────────── Knowledge graph (P9.3) ─────────────────────────
let kgHandle: GraphHandle | null = null;
const perfWatch = watchPerfTier(); // P-PERF.2 (ADR-0129): battery/spec-aware render tier
let kgForceRender = false; // P-PERF.2: one-shot "Render anyway" override of the minimal-tier pause (per run)
// P-PERF.3 (ADR-0130): layout continuity across mounts - re-opening the KG (rail switch, live-refresh
// remount) paints nodes where the user last saw them instead of re-exploding from a circle. IN-MEMORY
// only, per the ADR-0084 privacy boundary: entity-id-keyed positions are structural metadata of the
// encrypted store and never touch disk. Keyed per graph (personal vs code:file vs code:symbol).
const kgLayoutCache = new Map<string, Map<string, { x: number; y: number }>>();
let kgData: PersonalGraphData | null = null;
let kgLens: "kind" | "trust" = "kind";
let kgOpen = false;
let kgSelId: string | null = null;
let kgSig = ""; // signature of the last-rendered graph, to skip no-op live refreshes
let kgCodeMode = false; // P-KG-CODE.1: the canvas is showing the workspace CODE graph, not the personal graph
let kbGraphMode = false; // P-KB.2b: the canvas is showing the COMPILED knowledge base page graph
let kbGraphData: KbGraphView | null = null; // cached pages+links for the KB side panel (node -> page body)
let codeGraphRoot = ""; // P-KG-CODE.1d: workspace root, so a code node's relative path opens the real file in the IDE
let codeGraphLevel: "file" | "symbol" = "file"; // P-KG-SYM.1: which graph the canvas is showing
const forgettingIds = new Set<string>(); // in-flight "forget" fact ids - de-dups mashed clicks (#113)
// P-KG-REL.1 (#109): manual relationship authoring state.
let kgRelateMode = false;
let kgRelatePicks: string[] = []; // ordered multi-select pick set (for the "Relate" action)
let relating = false; // guards against concurrent relate calls

/** Apply a relate result to the live graph: optimistically add the edge, keep the poll baseline in sync,
 *  and surface failures. Returns whether it landed. */
/** The relationship label from the Relate bar (P-KG-REL.2), defaulting to "related". The server
 *  sanitizes + caps it; this is just the UI default + read. */
function currentRelationLabel(): string {
  return resolveRelationLabel(($("#kgRelateLabel") as HTMLInputElement | null)?.value);
}
async function relateNodes(fromId: string, toId: string, relation?: string): Promise<boolean> {
  if (!kgData) return false;
  const rel = relation ?? currentRelationLabel(); // P-KG-REL.2: custom label when the user typed one
  const before = kgData;
  kgData = addEdgeOptimistic(kgData, fromId, toId, rel); // instant edge (no reload wait)
  kgSig = kgSignature(kgData);
  kgHandle?.update(kgData);
  const r = await bridge.personalRelate(fromId, toId, rel).catch(() => null);
  if (r?.ok) return true;
  kgData = before; // server refused → roll back
  kgSig = kgSignature(kgData);
  kgHandle?.update(kgData);
  showToast({ tone: "danger", title: "Couldn't relate those", desc: r?.error ?? "Try again.", actions: [{ label: "OK" }], timeout: 4000 });
  return false;
}

/** Reflect the current multi-select pick set in the relate bar (count + enabled state). */
function onRelatePick(ids: string[]): void {
  kgRelatePicks = ids;
  const count = $("#kgRelateCount"), doBtn = $("#kgRelateDo") as HTMLButtonElement | null;
  if (count) count.textContent = ids.length ? `${ids.length} selected` : "";
  if (doBtn) doBtn.disabled = ids.length < 2;
}

/** Chain-relate the picked nodes (A,B,C → A→B, B→C), then clear the picks. */
async function relatePicked(): Promise<void> {
  if (relating || kgRelatePicks.length < 2) return;
  relating = true;
  const pairs = chainPairs(kgRelatePicks);
  let ok = 0;
  for (const [from, to] of pairs) if (await relateNodes(from, to)) ok++;
  relating = false;
  kgHandle?.clearRelatePicks(); // fires onRelatePick([]) → resets the bar
  if (ok) showToast({ title: ok === 1 ? "Related" : `${ok} relationships added`, desc: "Saved to your private graph.", timeout: 2400 });
}

function setRelateMode(on: boolean): void {
  kgRelateMode = on;
  kgHandle?.setRelateMode(on);
  updateKgViewsLabel(); // P-KGUI.1: relate lights the consolidated views button
  const bar = $("#kgRelateBar"); if (bar) (bar as HTMLElement).hidden = !on;
  if (!on) onRelatePick([]);
}

// P-KGUI.1 (ADR-0184): the consolidated views dropdown - one button instead of the stacked three.
function updateKgViewsLabel(): void {
  const s = { relateOn: kgRelateMode, codeMode: kgCodeMode, kbMode: kbGraphMode };
  const l = $("#kgViewsLbl"); if (l) l.textContent = kgViewLabel(s);
  $("#kgViews")?.classList.toggle("on", kgViewActive(s));
}
let kgViewsPop: { close: () => void } | null = null;
function openKgViewsMenu(anchor: HTMLElement): void {
  if (kgViewsPop) { kgViewsPop.close(); return; } // second click on the button = toggle closed
  const p = popover(anchor, kgViewsMenuHtml({ relateOn: kgRelateMode, codeMode: kgCodeMode, kbMode: kbGraphMode }), () => { kgViewsPop = null; });
  kgViewsPop = p;
  p.node.addEventListener("click", (ev) => {
    const it = (ev.target as HTMLElement).closest("[data-kgview]") as HTMLElement | null;
    if (!it) return;
    const v = it.dataset.kgview;
    p.close();
    if (v === "relate") setRelateMode(!kgRelateMode);
    else if (v === "code") void toggleCodeGraph();
    else if (v === "kb") void toggleKbGraph();
  });
}

// P-KGUI.2 (ADR-0185): the Data dropdown - Import history / AI toggle / Export vault / CUI archive,
// folded from three header buttons + a checkbox into the same menu pattern as the views dropdown.
// The AI-extraction choice lives in module state (the menu is transient DOM, so a live checkbox
// would be lost the moment it closes); toggling it never closes the menu.
let kgDataPop: { close: () => void } | null = null;
let kgImportAiOn = false;
function openKgDataMenu(anchor: HTMLElement): void {
  if (kgDataPop) { kgDataPop.close(); return; } // second click on the button = toggle closed
  const p = popover(anchor, kgDataMenuHtml(kgImportAiOn), () => { kgDataPop = null; });
  kgDataPop = p;
  p.node.addEventListener("change", (ev) => {
    const t = ev.target as HTMLInputElement | null;
    if (t?.id === "kgImportAI") kgImportAiOn = t.checked;
  });
  p.node.addEventListener("click", (ev) => {
    const it = (ev.target as HTMLElement).closest("[data-kgdata]") as HTMLElement | null;
    if (!it) return; // the AI toggle row (a label) lands here - it must not close the menu
    const v = it.dataset.kgdata;
    p.close();
    if (v === "import") void kgImportHistory();
    else if (v === "export") void kgExportVault();
    else if (v === "cui") kgCuiArchive();
  });
}
async function kgImportHistory(): Promise<void> {
  const folder = await openFolderBrowser({ title: "Choose your ChatGPT / Claude / Gemini export", confirm: "Import from here" });
  if (!folder) return;
  // Read-only pre-import estimate → warn about AI-mode token cost + runtime before the paid run.
  const est = await bridge.personalImportEstimate(folder);
  if (!est?.ok) { showToast({ tone: "danger", title: "Couldn't read that export", desc: est?.error ?? "No conversations found in that export.", actions: [{ label: "OK" }], timeout: 6000 }); return; }
  // First import (empty graph) defaults to AI extraction (best quality); after that, honor the menu toggle.
  const status = await bridge.personal();
  const totalFacts = status?.counts ? status.counts.work + status.counts.personal + status.counts.cui : 0;
  const aiDefault = totalFacts === 0 ? true : kgImportAiOn;
  const { tokens, secs, overCap } = estimateAiImport(est);
  const vendorName = est.vendor === "openai" ? "ChatGPT" : est.vendor === "anthropic" ? "Claude" : "Gemini";
  const aiLine = `AI: ~${fmtNum(tokens)} tokens · ${fmtDur(secs)}${overCap ? ` (first ${AI_IMPORT_CAP} of ${fmtNum(est.userMessages ?? 0)} msgs)` : ""} · Quick: free + instant, lower quality. Estimate is approximate.`;
  const aiBtn = { label: `AI extraction (${fmtDur(secs)})`, run: () => void runPersonalImport(folder, true) };
  const quickBtn = { label: "Quick (free)", run: () => void runPersonalImport(folder, false) };
  showToast({
    title: `Import ${fmtNum(est.conversations ?? 0)} ${vendorName} conversations?`,
    desc: `${fmtNum(est.userMessages ?? 0)} of your messages will seed your private, encrypted graph.`,
    meta: aiLine,
    tone: "warn",
    actions: [...(aiDefault ? [aiBtn, quickBtn] : [quickBtn, aiBtn]), { label: "Cancel" }],
    timeout: 0, // require an explicit choice (AI mode is paid + slow)
  });
}
async function kgExportVault(): Promise<void> {
  showToast({ title: "Exporting vault…", desc: "Decrypting and writing your Obsidian notes.", timeout: 1400 });
  const r = await bridge.personalExportVault({});
  if (!r?.ok) showToast({ tone: "danger", title: "Vault not exported", desc: r?.error ?? "Personalization is off or locked.", actions: [{ label: "OK" }], timeout: 5000 });
  else showExportToast("Vault exported", `${r.files} files · ${r.entities} notes · ${r.facts} facts · Personal + Work · CUI excluded by design · audited`, r.dest);
}
function kgCuiArchive(): void {
  showToast({
    title: "CUI archive · National Archives",
    desc: "Exports ONLY the CUI compartment into a CUI-marked, records-managed package (SHA-256 manifest). Designation and records-schedule fields are scaffolded for an authorized CUI/records officer to complete. Continue?",
    meta: "32 CFR 2002 · NARA records management · audited",
    actions: [
      { label: "Cancel" },
      { label: "Export CUI archive", kind: "danger", run: async () => {
        const r = await bridge.personalCuiArchive({});
        if (!r?.ok) showToast({ tone: "danger", title: "CUI archive not written", desc: r?.error ?? "Personalization is off or locked.", actions: [{ label: "OK" }], timeout: 6000 });
        else showExportToast("CUI archive written", `${r.files} files · ${r.facts} facts · sha256 ${(r.manifestSha256 ?? "").slice(0, 12)}… · complete the designation before transfer`, r.dest);
      } },
    ],
    timeout: 0,
  });
}

/** Cheap change-signature for the graph (node/edge ids + counts + fact total). */
function kgSignature(d: PersonalGraphData | null): string {
  if (!d) return "";
  return `${d.nodes.map((n) => `${n.id}:${n.count}`).join("|")}#${d.edges.map((e) => `${e.from}>${e.to}`).join("|")}#${d.facts?.length ?? 0}`;
}

/** Live-refresh the open KG without a full remount: merge new facts/edges into the running
 *  simulation (positions preserved). No-op if the panel is closed or nothing changed. */
async function refreshKnowledgeLive(): Promise<void> {
  if (!kgOpen || !kgHandle || kgCodeMode || kbGraphMode) return; // code-graph / compiled-KB mode isn't the live personal graph
  const data = await bridge.personalGraph().catch(() => null);
  if (!data || data.nodes.length === 0) return;
  const sig = kgSignature(data);
  if (sig === kgSig) return; // nothing new learned
  kgSig = sig; kgData = data;
  kgHandle.update(data);
}

/** After a chat turn, learning happens in the background (learnFromTurn, async + best-effort),
 *  so poll a couple of times to catch both the fast heuristic and the slower model extractor. */
function scheduleKnowledgeRefresh(): void {
  if (!kgOpen) return;
  setTimeout(() => void refreshKnowledgeLive(), 1500);
  setTimeout(() => void refreshKnowledgeLive(), 4500);
}
function openKnowledge(): void {
  kgOpen = true;
  closeSettings();
  closeIde(); // P-IDE.4: right-edge surfaces are mutually exclusive
  closePreview(); // P-PREVIEW.1
  closeSkills(); // P-SKILL.4
  if (!state.sidebarCollapsed) toggleSidebar(true); // give the chat room; reopen sessions via the hamburger
  $("#knowledge")!.hidden = false;
  $("#inspector")!.hidden = true;
  $$(".rail-btn").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.rail === "knowledge"));
  updateCodeGraphButtons(false); // always open on the personal graph; the Code-graph button re-enters code mode
  void renderKnowledge();
}
function closeKnowledge(): void {
  if (!kgOpen) return;
  kgOpen = false;
  if (kgRelateMode) setRelateMode(false); // leave relate mode clean for next open
  kgHandle?.destroy(); kgHandle = null;
  showKgCenter(false);
  $("#knowledge")!.hidden = true;
  $("#inspector")!.hidden = false;
  $$(".rail-btn").forEach((b) => b.classList.remove("active"));
  $('.rail-btn[data-rail="chat"]')?.classList.add("active");
}

// P-PREVIEW.1 (ADR-0096): the in-app browser preview fly-out. A sandboxed <iframe> renders a local app the
// agent built; a screenshot can be sent to chat. Mirrors the Knowledge-graph fly-out (resizable right aside,
// mutually exclusive with the other right surfaces). The agent driving it (custom tools) is P-PREVIEW.2.
let previewOpen = false;
function openPreview(): void {
  previewOpen = true;
  closeSettings();
  closeIde();
  closeKnowledge();
  closeAgentBuilder(); // P-AGENT.2b
  closeSkills(); // P-SKILL.4
  if (!state.sidebarCollapsed) toggleSidebar(true);
  $("#preview")!.hidden = false;
  $("#inspector")!.hidden = true;
  $$(".rail-btn").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.rail === "preview"));
  // P-PREVIEW.2: default to the agent's most recent previewable write, and render it straight away.
  const path = $("#prevPath") as HTMLInputElement | null;
  if (path && !path.value && state.lastPreviewablePath) path.value = state.lastPreviewablePath;
  if (path?.value) loadPreview(path.value); else path?.focus();
  startPreviewShotLoop(); // keep the agent's preview_screenshot shot fresh while the panel is open
  startPreviewInspectRelay(); // P-PREVIEW.6b: serve the agent's preview_inspect queries while the panel is open
  // Screenshot capture is an Electron-only seam; disable the button in a plain browser.
  const shot = $("#prevShot") as HTMLButtonElement | null;
  if (shot && !bridge.isElectron) { shot.disabled = true; shot.title = "Screenshots are available in the desktop app"; }
}
function closePreview(): void {
  if (!previewOpen) return;
  previewOpen = false;
  stopPreviewShotLoop();
  stopPreviewInspectRelay(); // P-PREVIEW.6b
  $("#preview")!.hidden = true;
  $("#inspector")!.hidden = false;
  $$(".rail-btn").forEach((b) => b.classList.remove("active"));
  $('.rail-btn[data-rail="chat"]')?.classList.add("active");
}
/** P-PREVIEW.2 (ADR-0096; auto-show, 2026-07-01): the agent just wrote a browser-previewable file — show it in
 *  the Preview panel automatically. It's just a preview, so we don't ask (the old toast disappeared before the
 *  user could click it). If the panel is already open, swap to the new file; otherwise open it on this file. */
function onPreviewAvailable(path: string): void {
  if (!path) return;
  state.lastPreviewablePath = path;
  const p = $("#prevPath") as HTMLInputElement | null;
  if (p) p.value = path;                 // point at the new file explicitly (never a stale prior value)
  if (previewOpen) loadPreview(path);
  else openPreview();                    // opens the panel and renders p.value straight away
}

// ── P-PREVIEW.6a (ADR-0153): live "reviewing / testing" indicator ────────────────────────────────
let previewTestingTimer: ReturnType<typeof setTimeout> | undefined;
/** Glow the Preview panel + show a "reviewing/testing" pill while the agent looks at / tests the preview.
 *  Surfaces the panel if a preview is loaded but hidden, so the user SEES the review happen live.
 *  Debounced — repeated activity keeps it lit; fades ~4.5s after the last signal (or on turn done). */
function flashPreviewTesting(label: string): void {
  const panel = $("#preview") as HTMLElement | null;
  const pill = $("#prevPill") as HTMLElement | null;
  if (!panel || !pill) return;
  if (panel.hidden && state.lastPreviewablePath) openPreview(); // make the review visible
  panel.classList.add("testing");
  const lbl = $("#prevPillLabel"); if (lbl) lbl.textContent = label || "Reviewing the preview";
  pill.hidden = false;
  if (previewTestingTimer) clearTimeout(previewTestingTimer);
  previewTestingTimer = setTimeout(clearPreviewTesting, 4500);
}
function clearPreviewTesting(): void {
  if (previewTestingTimer) { clearTimeout(previewTestingTimer); previewTestingTimer = undefined; }
  ($("#preview") as HTMLElement | null)?.classList.remove("testing");
  const pill = $("#prevPill") as HTMLElement | null; if (pill) pill.hidden = true;
}

// ── P-FIGMA.1/.2 (ADR-0154): /figma — import a Figma design, then a guided step (review / build-or-open DESIGN.md).
function figmaImportStepHtml(savedToken: boolean): string {
  return `<div class="figma-modal-h">${icon("eye", 15)} Import a Figma design</div>
    <div class="figma-modal-sub">Paste a Figma file URL and a personal access token. The token is stored in the OS-encrypted vault and used only on this machine to fetch the frames — it never reaches the agent. The design opens in the Preview panel as a board you (and the agent) can review.</div>
    <label class="fg-lbl">Figma file URL</label>
    <input id="fgUrl" class="prov-key" placeholder="https://www.figma.com/design/…/…" autocomplete="off" spellcheck="false" />
    <label class="fg-lbl">Personal access token ${savedToken ? `<span class="fg-opt">— a token is saved; leave blank to reuse it</span>` : `<span class="fg-opt">— Figma → Settings → Personal access tokens</span>`}</label>
    <input id="fgPat" class="prov-key" type="password" placeholder="${savedToken ? "•••••• (using the saved token)" : "figd_…"}" autocomplete="off" />
    <div class="fg-status" id="fgStatus" hidden></div>
    <div class="fg-actions"><button class="btn-mini" data-fg="cancel">Cancel</button><button class="btn-mini ok" data-fg="import">${icon("download", 12)} Import</button></div>`;
}
function figmaNextStepsHtml(res: { fileName?: string; frames?: number; hasDesign?: boolean }): string {
  const name = esc(res.fileName ?? "the design");
  const designBtn = res.hasDesign
    ? `<button class="btn-mini" data-fg="opendesign">${icon("markup", 12)} Review DESIGN.md in the IDE</button>`
    : `<div class="fg-note">${icon("info", 12)} This project has no DESIGN.md yet.</div><button class="btn-mini" data-fg="builddesign">${icon("plus", 12)} Build a DESIGN.md from this design</button>`;
  return `<div class="figma-modal-h">${icon("check", 15)} Imported ${name}</div>
    <div class="figma-modal-sub">${res.frames ?? 0} frame${res.frames === 1 ? "" : "s"} are now in the Preview panel. What next?</div>
    <div class="fg-next">
      <button class="btn-mini ok" data-fg="review">${icon("eye", 12)} Have the agent review the design</button>
      ${designBtn}
    </div>
    <div class="fg-actions"><button class="btn-mini" data-fg="done">Done</button></div>`;
}
function openFigmaForm(): void {
  const savedToken = state.creds.some((c) => c.ref === "figma_pat"); // a PAT already in the vault?
  const modal = el(`<div class="figma-modal">${figmaImportStepHtml(savedToken)}</div>`) as HTMLElement;
  const ov = el(`<div class="scrim figma-scrim"></div>`) as HTMLElement;
  ov.appendChild(modal);
  document.body.appendChild(ov);
  let fileName = "the design";
  const close = () => ov.remove();
  const status = (msg: string, err = false) => { const s = $("#fgStatus", modal) as HTMLElement | null; if (s) { s.hidden = false; s.textContent = msg; s.classList.toggle("err", err); } };
  ($("#fgUrl", modal) as HTMLInputElement | null)?.focus();
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  modal.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("[data-fg]") as HTMLElement | null;
    if (!btn) return;
    const act = btn.dataset.fg;
    if (act === "cancel" || act === "done") { close(); return; }
    if (act === "review") { close(); seedFigmaReview(fileName); return; }
    if (act === "opendesign") { close(); void openDesignInIde(); return; }
    if (act === "builddesign") { close(); seedFigmaBuildDesign(fileName); return; }
    if (act === "import") {
      const url = ($("#fgUrl", modal) as HTMLInputElement).value.trim();
      const pat = ($("#fgPat", modal) as HTMLInputElement).value.trim();
      if (!url) { status("Enter a Figma file URL.", true); return; }
      if (!pat && !savedToken) { status("Enter your Figma personal access token.", true); return; }
      status("Importing… fetching the frames from Figma.");
      if (pat && bridge.isElectron && bridge.credStore) { // persist the token in the OS-encrypted vault
        const r = await bridge.credStore({ ref: "figma_pat", kind: "apikey", secret: pat, label: "Figma personal access token" });
        if (r && !("error" in r)) void bridge.credList().then((c) => { state.creds = c ?? state.creds; });
      }
      const res = await bridge.figmaImport(url, pat || undefined).catch(() => null);
      if (res && res.path) {
        fileName = res.fileName ?? "the design";
        onPreviewAvailable(res.path); // open + load the design board in the Preview panel
        modal.innerHTML = figmaNextStepsHtml(res); // guided next step (review / DESIGN.md)
      } else {
        status(res?.error ?? "Couldn't import — check the file URL and token.", true);
      }
    }
  });
}
/** Seed a design-review turn: the agent screenshots + inspects the imported board and checks it against DESIGN.md. */
function seedFigmaReview(fileName: string): void {
  const ta = $("#input") as HTMLTextAreaElement | null; if (!ta) return;
  ta.value = `I've imported the Figma design "${fileName}" into the Preview panel — it's a board of the design's frames. Please review it: use preview_screenshot to look at it and preview_inspect to read it, and if this project has a DESIGN.md check the design against those invariants. Then give me (1) a short summary of what the design is, (2) any issues you see (spacing, color, typography, hierarchy, states, accessibility), and (3) concrete, actionable follow-up recommendations.`;
  autosize(ta); setSendEnabled(); void send();
}
/** Seed a turn where the agent AUTHORS DESIGN.md from the imported design; the design-available event then pops it out. */
function seedFigmaBuildDesign(fileName: string): void {
  const ta = $("#input") as HTMLTextAreaElement | null; if (!ta) return;
  ta.value = `This project has no DESIGN.md. Review the imported Figma design "${fileName}" in the Preview (use preview_screenshot and preview_inspect), then WRITE a DESIGN.md at the workspace root capturing its design invariants as concise, enforceable bullet points: the spacing / grid system, the color palette (with hex values), the typography scale, key component patterns, copy / voice tone, and accessibility rules. Keep it tight and specific so future UI work can adhere to it. When you've written DESIGN.md, tell me it's ready to review.`;
  autosize(ta); setSendEnabled(); void send();
}
/** Pop the workspace DESIGN.md out in the Monaco IDE for the user to review + edit. */
async function openDesignInIde(): Promise<void> {
  const d = await bridge.designDoc().catch(() => null);
  if (!d || !d.exists) { showToast({ tone: "warn", title: "No DESIGN.md yet", desc: "Ask the agent to build one from your design first (/figma → Build a DESIGN.md)." }); return; }
  await openIde({ title: d.name ?? "DESIGN.md", path: d.path ?? "DESIGN.md", code: d.content ?? "", language: "markdown" });
}
/** Load the resolved target into the preview iframe. Fail-safe: only a `local` target is rendered; a
 *  `remote` or `blocked` target shows the empty-state message (remote is egress-gated in P-PREVIEW.3). */
function loadPreview(target: string): void {
  const frame = $("#prevFrame") as HTMLIFrameElement | null;
  const empty = $("#prevEmpty") as HTMLElement | null;
  const kind = $("#prevKind");
  if (!frame || !empty) return;
  // P-PREVIEW.7: a fresh load clears any stale health overlay (the new page reports its own).
  const notice = $("#prevNotice") as HTMLElement | null;
  if (notice) { notice.hidden = true; notice.innerHTML = ""; }
  const r = resolvePreview(target);
  if (kind) kind.textContent = r.kind === "local" ? r.label : "";
  // The iframe src is never raw DOM input: a LOCAL target loads our fixed same-origin /api/preview/serve
  // endpoint (the path is only an encoded query value), and a REMOTE target is an http(s) URL gated by the
  // egress allow-list. resolvePreview classifies the target first; no javascript:/data: scheme can reach src.
  const msg = ($("#prevEmptyMsg") as HTMLElement | null) ?? empty;
  const showEmpty = (text: string) => { frame.removeAttribute("srcdoc"); frame.removeAttribute("src"); frame.hidden = true; empty.hidden = false; msg.textContent = text; };
  if (r.kind === "local" && /^file:\/\//i.test(r.src)) {
    // P-PREVIEW.4b (ADR-0096): render via a SERVED document (iframe.src → /api/preview/serve), NOT srcdoc.
    // A srcdoc frame inherits the renderer's strict `script-src 'self'` CSP and blocks the previewed app's
    // inline scripts (it rendered only its static HTML). The served document carries its own per-frame CSP
    // (PREVIEW_FRAME_CSP) so the app actually runs — while staying in the hardened opaque-origin sandbox
    // and egress-blocked (`connect-src 'none'`). The src is a FIXED same-origin endpoint with the path only
    // ever an encodeURIComponent'd query value (never the scheme/host) — so DOM input can't pick the scheme.
    if (kind) kind.textContent = r.label;
    frame.removeAttribute("srcdoc");
    frame.src = bridge.previewServeUrl(target);
    frame.hidden = false; empty.hidden = true;
    clearPreviewCanvas(); // P-PREVIEW.5: a fresh file starts with a clean markup layer
    // P-PREVIEW.3a-shot: once it paints, cache a PNG desktop-side so the agent's preview_screenshot tool can
    // see what it built. Small delay lets the app's first frame render (canvas/animation). Electron-only.
    frame.onload = () => { wirePreviewCanvas(); syncPreviewCanvas(); window.setTimeout(() => void cacheRenderedPreviewShot(), 150); };
  } else if (r.kind === "remote") {
    // P-PREVIEW.3b (ADR-0096): a remote URL reaches the internet — only load it if the egress allow-list
    // already approves the site (honoring the managed ceiling). Otherwise it stays gated; the agent must
    // request the site via the normal egress flow (which prompts the user). The iframe is opaque-origin
    // (no allow-same-origin), and only an http(s) URL ever reaches src here.
    const remoteUrl = target.trim(); // for a remote target, the input IS the URL (resolver label === URL)
    if (kind) kind.textContent = "checking…";
    showEmpty(`Checking whether ${r.label} is approved to load…`);
    void bridge.previewEgressAllows(remoteUrl).then((allowed) => {
      if (($("#prevPath") as HTMLInputElement | null)?.value.trim() !== remoteUrl) return; // a newer Open superseded this
      if (canPreviewRemote(remoteUrl, allowed)) {
        if (kind) kind.textContent = r.label; frame.src = encodeURI(remoteUrl); frame.hidden = false; empty.hidden = true;
      } else {
        if (kind) kind.textContent = "";
        showEmpty(`Remote site not approved for preview: ${r.label}. Ask the agent to visit it - you'll get an egress approval prompt, then it can preview here.`);
      }
    }).catch(() => showEmpty(`Couldn't check egress approval for ${r.label}.`));
  } else {
    if (kind) kind.textContent = "";
    showEmpty(`Can't preview that - ${r.reason ?? "open a local HTML file"}.`);
  }
}
/** P-PREVIEW.3a-shot: after the preview paints, cache a PNG of it desktop-side so the agent's
 *  `preview_screenshot` tool can fetch what it built. Electron-only (capturePage); a silent no-op in a
 *  plain browser or when the frame has no size. Never throws — a failed cache just means no shot this turn. */
async function cacheRenderedPreviewShot(): Promise<void> {
  const frame = $("#prevFrame") as HTMLIFrameElement | null;
  if (!frame || frame.hidden || !bridge.isElectron || !bridge.capturePreview) return;
  const rect = frame.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const png = await bridge.capturePreview({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }).catch(() => null);
  if (png) await bridge.cachePreviewShot(png).catch(() => { /* best-effort */ });
}
// P-PREVIEW.3a-shot freshness: the single on-load capture froze the shot at load+150ms, so the agent's
// preview_screenshot saw an empty/early/stale frame the moment the previewed app animated or the file was
// re-edited — and it gave up and read the DOM instead. Re-capture on a light cadence WHILE the preview panel
// is visible so the cached PNG tracks what the user actually sees (cacheRenderedPreviewShot no-ops when the
// frame is hidden / non-Electron, so this is a cheap visibility check when there's nothing to capture).
let previewShotTimer: number | null = null;
function startPreviewShotLoop(): void {
  if (previewShotTimer !== null) return;
  void cacheRenderedPreviewShot(); // refresh immediately on open, then keep it current
  previewShotTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") void cacheRenderedPreviewShot();
  }, 1500);
}
function stopPreviewShotLoop(): void {
  if (previewShotTimer === null) return;
  window.clearInterval(previewShotTimer);
  previewShotTimer = null;
}

// ── P-PREVIEW.6b (ADR-0153): DOM-inspect relay ───────────────────────────────────────────────────
// The agent's `preview_inspect` tool enqueues a query on the dev server; the renderer polls for it, runs it
// on the sandboxed iframe via the postMessage bridge, and posts the result back. Only runs while the panel is
// open; a query with no preview loaded simply times out server-side with a helpful message.
let previewInspectTimer: number | null = null;
function startPreviewInspectRelay(): void {
  if (previewInspectTimer !== null) return;
  previewInspectTimer = window.setInterval(() => { void pollPreviewInspect(); }, 450);
}
function stopPreviewInspectRelay(): void {
  if (previewInspectTimer === null) return;
  window.clearInterval(previewInspectTimer);
  previewInspectTimer = null;
}
// ── P-PREVIEW.7 (ADR-0179): explain the silent-white preview + offer a REAL external run ─────────
// The injected bridge posts a one-shot health report after load. A page that painted NOTHING (or
// whose script died on Node-only APIs) is almost always an Electron renderer - the sandboxed frame
// runs browser code only, by design. Instead of staying mute, explain it in-pane; when the app dir
// detects as an Electron app, offer a USER-clicked launch as a real OS process OUTSIDE LUCID
// (audited server-side; the sandbox stays sealed).
const NODE_ONLY_ERR = /require is not defined|process is not defined|module is not defined|__dirname is not defined/i;
window.addEventListener("message", (ev) => {
  const frame = $("#prevFrame") as HTMLIFrameElement | null;
  const d = ev.data as { __lucid?: string; emptyBody?: boolean; errors?: unknown[] } | null;
  if (!d || d.__lucid !== "preview-health" || !frame || ev.source !== frame.contentWindow) return;
  void handlePreviewHealth(!!d.emptyBody, Array.isArray(d.errors) ? d.errors.map(String) : []);
});
async function handlePreviewHealth(emptyBody: boolean, errors: string[]): Promise<void> {
  const notice = $("#prevNotice") as HTMLElement | null;
  if (!notice) return;
  const nodeDead = errors.find((e) => NODE_ONLY_ERR.test(e));
  if (!emptyBody && !nodeDead) return; // page painted and no Node-shaped crash - nothing to explain
  const path = ($("#prevPath") as HTMLInputElement | null)?.value.trim() ?? "";
  const det = path ? await bridge.previewElectronDetect(path).catch(() => null) : null;
  const close = `<button class="pn-x" id="prevNoticeClose" data-tip="Dismiss">${icon("close", 13)}</button>`;
  if (det?.electron) {
    const action = det.launchable
      ? `<button class="btn-mini" id="prevRunElectron">${icon("spark", 13)} Run with Electron - opens outside LUCID</button>`
      : `<span class="pn-cmd">No Electron runtime found here - run <code>npx electron .</code> in <code>${esc(det.appDir)}</code></span>`;
    notice.innerHTML = `${close}<div class="pn-hd">${icon("spark", 14)} This looks like an Electron app</div>
      <div class="pn-tx">Its interface is built by a script that needs Node/Electron APIs (<code>${esc(nodeDead ?? "require is not defined")}</code>), which this sandboxed preview deliberately doesn't provide - so the page stays blank. Run it as a real desktop app instead:</div>
      <div class="pn-actions">${action}</div>`;
    notice.hidden = false;
    $("#prevRunElectron")?.addEventListener("click", async () => {
      const r = await bridge.previewElectronLaunch(path).catch(() => null);
      if (r?.launched) showToast({ title: "Electron app launched", desc: `Opened outside LUCID (${r.via === "app-local" ? "the app's own Electron install" : "Electron from your PATH"}). Look for its window.`, timeout: 5200 });
      else showToast({ tone: "warn", title: "Couldn't launch", desc: r?.reason ?? "Unknown launch failure.", actions: [{ label: "OK" }], timeout: 7000 });
    });
  } else if (nodeDead || (emptyBody && errors.length > 0)) {
    notice.innerHTML = `${close}<div class="pn-hd">${icon("info", 14)} The page rendered nothing</div>
      <div class="pn-tx">Its script hit an error: <code>${esc(errors[0] ?? "unknown")}</code>. The sandboxed preview runs plain browser code (no Node, no network) - check the file for APIs that need a runtime.</div>`;
    notice.hidden = false;
  }
  $("#prevNoticeClose")?.addEventListener("click", () => { notice.hidden = true; });
}

async function pollPreviewInspect(): Promise<void> {
  const frame = $("#prevFrame") as HTMLIFrameElement | null;
  if (!frame || frame.hidden) return; // no preview rendered yet → let it time out server-side
  const next = await bridge.previewInspectNext().catch(() => null);
  if (!next || next.none || !next.id) return;
  const result = await runInspectOnFrame(frame, next.id, next.command ?? {});
  await bridge.previewInspectResult(next.id, result).catch(() => { /* the tool will time out */ });
}
/** Ask the sandboxed preview's bridge to run a read-only query; resolve with its result (or a timeout note). */
function runInspectOnFrame(frame: HTMLIFrameElement, id: string, command: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const win = frame.contentWindow;
    if (!win) { resolve({ error: "the preview isn't ready" }); return; }
    const done = (r: unknown) => { window.removeEventListener("message", onMsg); window.clearTimeout(to); resolve(r); };
    const to = window.setTimeout(() => done({ error: "the preview didn't respond (no inspect bridge, or it's still loading)" }), 3000);
    function onMsg(ev: MessageEvent): void {
      const d = ev.data as { __lucid?: string; id?: string; result?: unknown } | null;
      if (ev.source !== win || !d || d.__lucid !== "inspect-result" || d.id !== id) return;
      done(d.result);
    }
    window.addEventListener("message", onMsg);
    win.postMessage({ __lucid: "inspect", id, cmd: command }, "*");
  });
}

// ── P-AGENT.2b (ADR-0133): the Agent Builder workflow canvas ─────────────────────────────────────────────
// A right-edge surface (mutually exclusive with the other right surfaces). The spec is edited in memory and
// rendered through the SAME zero-dep graph engine as the KG (specToGraphData → mountGraph). Save validates
// fail-closed both client-side (instant) and server-side (authoritative).
let abOpen = false;
let abSpec: AgentSpec | null = null;
let abHandle: GraphHandle | null = null;
let abConnectMode = false;
// P-AGENT.9: trust state of the CURRENT canvas spec (imported agents open untrusted/suspicious/quarantined
// and cannot run until approved). null = locally authored (trusted).
let abTrust: { label: TrustLabel; reason: string } | null = null;
// P-AGENT.12: MCP-discovered catalog entries (omp runtime names). Refreshed fire-and-forget when the
// builder opens; empty = static catalog only (fail-soft).
let abMcpTools: McpCatalogTool[] = [];
async function refreshAbMcpTools(): Promise<void> {
  try {
    abMcpTools = (await bridge.agentMcpTools()).tools;
  } catch {
    abMcpTools = []; // probe unavailable → built-ins only
  }
}

function openAgentBuilder(): void {
  abOpen = true;
  void refreshAbMcpTools(); // P-AGENT.12: warm the MCP catalog for the pickers (fail-soft, never blocks)
  closeSettings();
  closeKnowledge();
  closeIde();
  closePreview();
  closeSkills(); // P-SKILL.4
  if (!state.sidebarCollapsed) toggleSidebar(true);
  $("#agentBuilder")!.hidden = false;
  $("#inspector")!.hidden = true;
  $$(".rail-btn").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.rail === "agentBuilder"));
  void renderAgentBuilder();
}
function closeAgentBuilder(): void {
  if (!abOpen) return;
  abOpen = false;
  abHandle?.destroy();
  abHandle = null;
  $("#agentBuilder")!.hidden = true;
  $("#inspector")!.hidden = false;
  $$(".rail-btn").forEach((b) => b.classList.remove("active"));
  $('.rail-btn[data-rail="chat"]')?.classList.add("active");
}

async function renderAgentBuilder(): Promise<void> {
  const canvas = $("#abCanvas");
  if (!canvas) return;
  if (!abSpec) {
    // Resume the most-recently-saved agent for this workspace, else start a fresh one-node spec.
    const list = await bridge.agentList().catch(() => []);
    abSpec = (list[0] ? await bridge.agentLoad(list[0].spec_id) : null) ?? newCanvasSpec("New agent", Date.now());
    // P-AGENT.9: resume the stored trust state too — an imported agent stays gated across sessions.
    const t = list[0];
    abTrust = t && t.trust_label && t.trust_label !== "trusted" && t.spec_id === abSpec.spec_id
      ? { label: t.trust_label, reason: t.trust_reason ?? "imported agent — review before running" }
      : null;
  }
  abHandle?.destroy();
  abHandle = mountGraph(canvas as HTMLElement, specToGraphData(abSpec), (id) => selectAbNode(id), {
    onRelate: (from, to) => addAbEdge(from, to),
  });
  abHandle.setRelateMode(abConnectMode);
  renderAbErrors();
  renderAbTrust(); // P-AGENT.9
}
function reRenderAbGraph(): void {
  if (abSpec && abHandle) abHandle.update(specToGraphData(abSpec));
}
function markAbDirty(): void {
  if (abSpec) abSpec.updated_at = Date.now();
}

function selectAbNode(id: string | null): void {
  const side = $("#abSide");
  if (!side) return;
  const node = abSpec?.nodes.find((n) => n.id === id);
  if (!node || !abSpec) { side.hidden = true; return; }
  side.innerHTML = nodeEditorHtml(node, abSpec.tools, abMcpTools, abSpec); // P-AGENT.12 catalog + P-AGENT.11c branch edges
  side.hidden = false;
  $("#abLabel", side)?.addEventListener("input", (e) => { node.label = (e.target as HTMLInputElement).value; markAbDirty(); reRenderAbGraph(); });
  $("#abPrompt", side)?.addEventListener("input", (e) => { node.prompt = (e.target as HTMLTextAreaElement).value; markAbDirty(); });
  // P-AGENT.11c: branch choice labels ride the outgoing edges.
  $$("[data-edge-label]", side).forEach((inp) =>
    inp.addEventListener("input", (e) => {
      const edgeId = (inp as HTMLElement).dataset.edgeLabel ?? "";
      const edge = abSpec?.edges.find((x) => x.id === edgeId);
      if (!edge) return;
      const v = (e.target as HTMLInputElement).value.trim();
      if (v) edge.label = v;
      else delete edge.label;
      markAbDirty();
      reRenderAbGraph(); // the canvas shows choice labels as edge relations
    }),
  );
  // P-AGENT.15: reliability knobs — cleared inputs remove the field (spec stays minimal).
  $("#abRetry", side)?.addEventListener("change", (e) => {
    const v = Math.round(Number((e.target as HTMLInputElement).value));
    if (Number.isFinite(v) && v >= 1) node.retry = { ...(node.retry ?? {}), max: Math.min(3, v) };
    else delete node.retry;
    markAbDirty();
    renderAbErrors();
  });
  $("#abTimeout", side)?.addEventListener("change", (e) => {
    const raw = (e.target as HTMLInputElement).value.trim();
    const v = Math.round(Number(raw));
    if (raw && Number.isFinite(v)) node.timeoutMs = Math.min(600, Math.max(5, v)) * 1000;
    else delete node.timeoutMs;
    markAbDirty();
    renderAbErrors();
  });
  $("#abTool", side)?.addEventListener("change", (e) => {
    const t = (e.target as HTMLSelectElement).value;
    if (!t) return; // the disabled "(choose a tool)" placeholder
    node.tool = t;
    // Picking a tool outside the allow-list AUTO-ADDS it: the validator requires membership, and the
    // dropdown offers the whole omp catalog (see TOOL_CATALOG in agent_builder.ts).
    if (abSpec && !abSpec.tools.includes(t)) abSpec.tools.push(t);
    markAbDirty();
    renderAbErrors();
  });
  $("#abSub", side)?.addEventListener("input", (e) => { node.subagentSpecId = (e.target as HTMLInputElement).value; markAbDirty(); });
  $("#abDelNode", side)?.addEventListener("click", () => deleteAbNode(node.id));
}

function addAbNode(kind: NodeKind): void {
  if (!abSpec) return;
  const id = `n_${crypto.randomUUID()}`;
  const node = { id, kind, label: `New ${kind}`, ...(kind === "prompt" ? { prompt: "" } : {}) };
  abSpec.nodes.push(node);
  markAbDirty();
  reRenderAbGraph();
  selectAbNode(id);
  renderAbErrors();
}
function addAbEdge(from: string, to: string): void {
  if (!abSpec || from === to) return;
  if (abSpec.edges.some((e) => e.from === from && e.to === to)) return;
  abSpec.edges.push({ id: `e_${crypto.randomUUID()}`, from, to });
  markAbDirty();
  reRenderAbGraph();
  renderAbErrors();
}
function deleteAbNode(id: string): void {
  if (!abSpec) return;
  abSpec.nodes = abSpec.nodes.filter((n) => n.id !== id);
  abSpec.edges = abSpec.edges.filter((e) => e.from !== id && e.to !== id);
  const side = $("#abSide");
  if (side) side.hidden = true;
  markAbDirty();
  reRenderAbGraph();
  renderAbErrors();
}
function toggleAbConnect(): void {
  abConnectMode = !abConnectMode;
  abHandle?.setRelateMode(abConnectMode);
  $("#abConnect")?.classList.toggle("active", abConnectMode);
}
// P-AGENT.9: the trust banner for an imported spec. Hidden for trusted/local specs; shows the label + reason
// and (for untrusted/suspicious) the “Approve after review” human step. Quarantined can only be re-imported.
function renderAbTrust(): void {
  const box = $("#abTrust");
  if (!box) return;
  const html = abTrust ? trustBannerHtml(abTrust.label, abTrust.reason) : "";
  box.innerHTML = html;
  box.hidden = !html;
  box.className = `ab-trust${abTrust && html ? ` ab-trust-${abTrust.label}` : ""}`;
  $("#abApprove", box)?.addEventListener("click", () => void approveAbTrust());
}
async function approveAbTrust(): Promise<void> {
  if (!abSpec) return;
  const r = await bridge.agentTrust(abSpec.spec_id);
  if (r?.trustLabel === "trusted") {
    abTrust = null;
    renderAbTrust();
    showToast({ tone: "ok", title: "Agent approved", desc: `“${abSpec.name}” is now trusted and can run.` });
  } else {
    showToast({ tone: "danger", title: "Couldn't approve", desc: r?.error ?? "approval was refused" });
  }
}
function renderAbErrors(): void {
  const box = $("#abErrs");
  if (!box || !abSpec) return;
  const errs = saveErrors(abSpec);
  if (errs.length === 0) { box.hidden = true; box.textContent = ""; return; }
  box.hidden = false;
  box.textContent = `${errs.length} issue${errs.length > 1 ? "s" : ""} to fix before saving: ${errs.join("; ")}`;
}
async function saveAgentBuilder(): Promise<void> {
  if (!abSpec) return;
  const errs = saveErrors(abSpec);
  if (errs.length) { renderAbErrors(); showToast({ tone: "danger", title: "Can't save yet", desc: errs[0]! }); return; }
  const r = await bridge.agentSave(abSpec);
  if (r?.saved) showToast({ tone: "ok", title: "Agent saved", desc: `"${abSpec.name}"` });
  else showToast({ tone: "danger", title: "Save failed", desc: r?.errors?.[0] ?? "The server refused the spec." });
}
async function exportAgentBuilder(): Promise<void> {
  if (!abSpec) return;
  const errs = saveErrors(abSpec);
  if (errs.length) { renderAbErrors(); showToast({ tone: "danger", title: "Can't export yet", desc: errs[0]! }); return; }
  const r = await bridge.agentExport(abSpec, "electron"); // P-AGENT.6: portable, tamper-evident bundle
  if (r?.dir) showToast({ tone: "ok", title: "Agent exported", desc: `${r.files} files → ${r.dir}`, meta: r.digest });
  else showToast({ tone: "danger", title: "Export failed", desc: "The server refused the spec." });
}
// P-AGENT.9: the Tools flyout — the allow-list as removable chips. Removing a chip immediately blocks the
// agent from calling that tool (spec.tools drives the compiled allow-list extension + the run-time gate);
// a step still referencing it is flagged by the validator until fixed or re-added.
function openAbToolsPanel(): void {
  if (!abSpec) return;
  const side = $("#abSide");
  if (!side) return;
  side.innerHTML = toolChipsHtml(abSpec, abMcpTools); // P-AGENT.12: built-ins + MCP
  side.hidden = false;
  $$("[data-rm-tool]", side).forEach((b) =>
    b.addEventListener("click", () => {
      const t = (b as HTMLElement).dataset.rmTool ?? "";
      if (!abSpec || !t) return;
      abSpec.tools = abSpec.tools.filter((x) => x !== t);
      const brokenSteps = abSpec.nodes.filter((n) => n.kind === "tool" && n.tool === t).length;
      markAbDirty();
      renderAbErrors();
      openAbToolsPanel(); // refresh the chips
      showToast(
        brokenSteps
          ? { tone: "warn", title: `${t} blocked`, desc: `Removed from the allow-list. ${brokenSteps} step${brokenSteps > 1 ? "s" : ""} still reference it — fix or delete ${brokenSteps > 1 ? "them" : "it"} (or re-add the tool) before saving.` }
          : { tone: "ok", title: `${t} blocked`, desc: "Removed from the allow-list — this agent can no longer call it." },
      );
    }),
  );
  $("#abToolAdd", side)?.addEventListener("change", (e) => {
    const t = (e.target as HTMLSelectElement).value;
    if (!abSpec || !t) return;
    if (!abSpec.tools.includes(t)) abSpec.tools.push(t);
    markAbDirty();
    renderAbErrors();
    openAbToolsPanel();
  });
}
// P-AGENT.9: SHARE — portable .lucid-agent.json (credential NAMES + setup guidance, never values). Written
// under .omp/agent-shares/ and offered as a browser download for easy hand-off to another LUCID.
async function shareAgentBuilder(): Promise<void> {
  if (!abSpec) return;
  const errs = saveErrors(abSpec);
  if (errs.length) { renderAbErrors(); showToast({ tone: "danger", title: "Can't share yet", desc: errs[0]! }); return; }
  const r = await bridge.agentShare(abSpec);
  if (!r || r.error || !r.json) { showToast({ tone: "danger", title: "Share failed", desc: r?.error ?? "The server refused the spec." }); return; }
  try {
    const url = URL.createObjectURL(new Blob([r.json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = r.fileName ?? "agent.lucid-agent.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch { /* download is a convenience; the file is already on disk */ }
  showToast({ tone: "ok", title: "Portable agent saved", desc: `${r.fileName} — no credential values inside; the recipient adds their own via Secrets & connections.`, meta: r.path });
}
// P-AGENT.10: export the canvas as an importable n8n workflow JSON (approvals become REAL Wait nodes; the
// provenance sticky embeds the portable agent so another LUCID can round-trip it losslessly).
async function n8nExportAgentBuilder(): Promise<void> {
  if (!abSpec) return;
  const errs = saveErrors(abSpec);
  if (errs.length) { renderAbErrors(); showToast({ tone: "danger", title: "Can't export yet", desc: errs[0]! }); return; }
  const r = await bridge.agentN8nExport(abSpec);
  if (!r || r.error || !r.json) { showToast({ tone: "danger", title: "n8n export failed", desc: r?.error ?? "The server refused the spec." }); return; }
  try {
    const url = URL.createObjectURL(new Blob([r.json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = r.fileName ?? "agent.n8n.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch { /* download is a convenience; the file is already on disk */ }
  showToast({
    tone: "ok",
    title: "n8n workflow saved",
    desc: r.pushAvailable
      ? `${r.fileName} — import it in n8n, or use “n8n ⇧” to push it straight to your instance.`
      : `${r.fileName} — import it in your n8n instance (Workflows → Import from File). Direct push needs the enterprise add-on.`,
    meta: r.path,
  });
}
// P-AGENT.10: push to a private hosted n8n via the enterprise add-on connector (honest refusal without it).
async function n8nPushAgentBuilder(): Promise<void> {
  if (!abSpec) return;
  const errs = saveErrors(abSpec);
  if (errs.length) { renderAbErrors(); showToast({ tone: "danger", title: "Can't push yet", desc: errs[0]! }); return; }
  const r = await bridge.agentN8nPush(abSpec);
  if (r?.ok) showToast({ tone: "ok", title: "Pushed to n8n", desc: r.url ? `Created: ${r.url}` : r.detail ?? "workflow created" });
  else showToast({ tone: "warn", title: "Couldn't push to n8n", desc: r?.detail ?? r?.error ?? "The n8n connector is part of the enterprise add-on." });
}
// P-AGENT.9/.10: IMPORT — a shared .lucid-agent.json or an n8n workflow JSON. The backend detects the
// format, digest-checks/translates, security-scans (fail-closed) and stores it with a trust label; anything
// not trusted opens for REVIEW and cannot run until approved.
async function importAgentFile(file: File): Promise<void> {
  const raw = await file.text();
  const r = await bridge.agentImport(raw);
  if (!r || r.error || !r.spec) { showToast({ tone: "danger", title: "Import refused", desc: r?.error ?? "not a valid portable agent file" }); return; }
  abSpec = r.spec;
  const label = (r.trustLabel ?? "untrusted") as TrustLabel;
  abTrust = label === "trusted" ? null : { label, reason: r.reason ?? "imported from an external source" };
  openAgentBuilder();
  renderAbTrust();
  if ((r.spec.secrets?.length ?? 0) > 0 || (r.spec.egress?.length ?? 0) > 0) void openAbSecretsPanel();
  showToast({
    tone: label === "quarantined" ? "danger" : "warn",
    title: `Imported: ${r.spec.name}`,
    desc: label === "quarantined"
      ? `Quarantined — ${r.findings ?? 0} finding(s). It cannot run; review the flagged content.`
      : `Held for review (${label}). Check every step, tool, and connection, add credentials via Secrets & connections, then Approve.${r.notes?.length ? ` Mapping: ${r.notes[0]}.` : ""}`,
  });
}
// P-AGENT.13: the Runs flyout — recent traces for the current agent; click a row for the per-step detail.
async function openAbRunsPanel(): Promise<void> {
  if (!abSpec) return;
  const side = $("#abSide");
  if (!side) return;
  const traces = await bridge.agentTraces(abSpec.spec_id);
  side.innerHTML = runsPanelHtml(traces);
  side.hidden = false;
  $$(".ab-runrow[data-run]", side).forEach((row) =>
    row.addEventListener("click", () => void openAbTraceDetail((row as HTMLElement).dataset.run ?? "")),
  );
}
async function openAbTraceDetail(runId: string): Promise<void> {
  if (!runId) return;
  const side = $("#abSide");
  if (!side) return;
  const trace = await bridge.agentTrace(runId);
  if (!trace) { showToast({ tone: "warn", title: "Trace unavailable", desc: "That run's trace file is missing or corrupted." }); return; }
  side.innerHTML = traceDetailHtml(trace);
  side.hidden = false;
  $("#abRunsBack", side)?.addEventListener("click", () => void openAbRunsPanel());
}
// P-AGENT.14: the Schedule flyout — a DISARMED agent-run automation for the current agent. Untrusted or
// approval-carrying specs get the honest refusal here, mirroring the scheduler's own fail-closed gate.
function openAbSchedulePanel(): void {
  if (!abSpec) return;
  const side = $("#abSide");
  if (!side) return;
  const blockedWhy = abTrust
    ? `This agent is ${abTrust.label} — review and approve it before scheduling unattended runs.`
    : abSpec.nodes.some((n) => n.kind === "approval")
      ? "This workflow has human-approval checkpoints, so it can't run unattended — approval cards would go unanswered. Run it manually, or remove the checkpoints."
      : saveErrors(abSpec)[0] ?? null;
  side.innerHTML = schedulePanelHtml(abSpec, blockedWhy);
  side.hidden = false;
  $("#abSchedCreate", side)?.addEventListener("click", () => void createAbSchedule());
}
async function createAbSchedule(): Promise<void> {
  if (!abSpec) return;
  const prompt = ($("#abSchedPrompt") as HTMLTextAreaElement | null)?.value.trim() ?? "";
  const kind = ($("#abSchedKind") as HTMLSelectElement | null)?.value === "daily" ? "daily" : "interval";
  const value = ($("#abSchedValue") as HTMLInputElement | null)?.value.trim() ?? "";
  if (!prompt) { showToast({ tone: "warn", title: "Enter a task", desc: "What should each scheduled run do?" }); return; }
  const cadence = kind === "daily" ? { kind: "daily" as const, hhmm: value } : { kind: "interval" as const, everyMin: Math.round(Number(value)) };
  const a = await bridge.automationCreate({
    goal: `Run agent: ${abSpec.name}`,
    cadence,
    kind: "agent",
    agentSpecId: abSpec.spec_id,
    agentPrompt: prompt,
    agentModel: state.model,
  });
  if (a) showToast({ tone: "ok", title: "Schedule created (disarmed)", desc: `“${abSpec.name}” ${a.cadence.kind === "interval" ? `every ${a.cadence.everyMin} min` : `daily at ${a.cadence.hhmm}`} — arm it in the Goal panel's Automations.` });
  else showToast({ tone: "danger", title: "Couldn't create the schedule", desc: kind === "daily" ? "Use HH:MM (24h), e.g. 09:30." : "Interval must be a number of minutes ≥ 1." });
}
// P-AGENT.17: the History flyout — restore any of the last 20 saved revisions (a restore is itself saved,
// so nothing is ever lost). The trust sidecar is untouched by restores.
async function openAbHistoryPanel(): Promise<void> {
  if (!abSpec) return;
  const side = $("#abSide");
  if (!side) return;
  const revisions = await bridge.agentHistory(abSpec.spec_id);
  side.innerHTML = historyPanelHtml(revisions);
  side.hidden = false;
  $$("[data-restore]", side).forEach((b) =>
    b.addEventListener("click", async () => {
      const ts = Number((b as HTMLElement).dataset.restore);
      const r = await bridge.agentHistoryRestore(abSpec!.spec_id, ts);
      if (r?.spec) {
        abSpec = r.spec;
        reRenderAbGraph();
        renderAbErrors();
        showToast({ tone: "ok", title: "Revision restored", desc: `Now editing the ${new Date(ts).toLocaleString()} revision (saved as current).` });
        void openAbHistoryPanel();
      } else {
        showToast({ tone: "danger", title: "Couldn't restore", desc: r?.error ?? "unknown or corrupted revision" });
      }
    }),
  );
}
// P-AGENT.17: the Templates flyout — curated starters that go through the STANDARD gated import path.
async function openAbTemplatesPanel(): Promise<void> {
  const side = $("#abSide");
  if (!side) return;
  const templates = await bridge.agentTemplates();
  side.innerHTML = templatesPanelHtml(templates);
  side.hidden = false;
  $$("[data-use-tpl]", side).forEach((b) =>
    b.addEventListener("click", async () => {
      const file = (b as HTMLElement).dataset.useTpl ?? "";
      const r = await bridge.agentTemplateUse(file);
      if (!r || r.error || !r.spec) { showToast({ tone: "danger", title: "Couldn't use the template", desc: r?.error ?? "template unavailable" }); return; }
      abSpec = r.spec;
      const label = (r.trustLabel ?? "untrusted") as TrustLabel;
      abTrust = label === "trusted" ? null : { label, reason: r.reason ?? "created from a template — review before running" };
      openAgentBuilder();
      renderAbTrust();
      showToast({ tone: "ok", title: `Template loaded: ${r.spec.name}`, desc: "Review the steps, rename it, approve it, and it's yours." });
    }),
  );
}
// P-AGENT.4-live: open the Run flyout and let the user run the agent live inside LUCID.
function openAbRunPanel(): void {
  if (!abSpec) return;
  const errs = saveErrors(abSpec);
  if (errs.length) { renderAbErrors(); showToast({ tone: "danger", title: "Can't run yet", desc: errs[0]! }); return; }
  const side = $("#abSide");
  if (!side) return;
  side.innerHTML = runPanelHtml(state.model);
  side.hidden = false;
  ($("#abRunPrompt", side) as HTMLTextAreaElement | null)?.focus();
  $("#abRunGo", side)?.addEventListener("click", () => void runAgentBuilder());
}
async function runAgentBuilder(): Promise<void> {
  if (!abSpec) return;
  const promptEl = $("#abRunPrompt") as HTMLTextAreaElement | null;
  const task = (promptEl?.value ?? "").trim();
  if (!task) { showToast({ tone: "warn", title: "Enter a task", desc: "Tell the agent what to do." }); return; }
  const out = $("#abRunOut");
  if (out) { out.hidden = false; out.textContent = "Running the agent…"; }
  renderAbRunReply(await bridge.agentRun(abSpec, task, state.model)); // P-AGENT.4-live/.11a (gated omp run)
}
// P-AGENT.11a: render a run reply — final output, refusal, error, or an ENFORCED approval halt. The halt
// card's Approve/Deny resolve the parked run server-side; the post-approval steps have no prompt until then.
function renderAbRunReply(r: AgentRunReply | null): void {
  const out = $("#abRunOut");
  if (!out) return;
  out.hidden = false;
  if (r?.paused) {
    const runId = r.paused.runId;
    out.innerHTML = runApprovalHtml(r.paused.label, r.paused.outputSoFar);
    $("#abRunApprove", out)?.addEventListener("click", () => void resolveAbRunApproval(runId, true));
    $("#abRunDeny", out)?.addEventListener("click", () => void resolveAbRunApproval(runId, false));
    return;
  }
  if (r?.blocked) out.textContent = `Blocked: ${r.reason}`;
  else if (r?.error) out.textContent = `Error: ${r.error}`;
  else out.textContent = r?.output || "(the agent produced no output)";
}
async function resolveAbRunApproval(runId: string, approve: boolean): Promise<void> {
  const out = $("#abRunOut");
  if (out) out.textContent = approve ? "Approved — continuing…" : "Stopping…";
  renderAbRunReply(await bridge.agentRunApprove(runId, approve));
}

// P-AGENT.8.2: the chat -> canvas handoff. The agent called `agent_builder_open` with a drafted (validated,
// secret-free) spec; open the Agent Builder pre-populated + auto-surface Secrets & connections if it needs any.
function openAgentBuilderWithSpec(spec: AgentSpec): void {
  const errs = saveErrors(spec); // defense-in-depth: the backend already gated this, re-check before opening
  if (errs.length) { showToast({ tone: "danger", title: "Couldn't open the drafted agent", desc: errs[0]! }); return; }
  // P-AGENT.9: LIVE collaboration — the chat agent re-calls agent_builder_open each turn the draft changes.
  // If the canvas is already open on this draft, update it IN PLACE so the user watches it evolve.
  const isUpdate = abOpen && !!abSpec && abSpec.spec_id === spec.spec_id;
  const hadNeeds = isUpdate ? (abSpec!.secrets?.length ?? 0) + (abSpec!.egress?.length ?? 0) : 0;
  abSpec = spec;
  abTrust = null; // drafted in THIS session's chat: locally authored (the backend re-validated + secret-scanned)
  if (isUpdate) {
    reRenderAbGraph();
    renderAbErrors();
    renderAbTrust();
    // surface Secrets & connections only when the draft GAINS credential/egress needs mid-conversation
    if ((spec.secrets?.length ?? 0) + (spec.egress?.length ?? 0) > hadNeeds) void openAbSecretsPanel();
    showToast({ tone: "info", title: "Draft updated", desc: `“${spec.name}” — ${spec.nodes.length} steps. Review the changes; reply in chat to steer.` });
    return;
  }
  openAgentBuilder(); // renderAgentBuilder keeps abSpec since it's already set
  if ((spec.secrets?.length ?? 0) > 0 || (spec.egress?.length ?? 0) > 0) void openAbSecretsPanel();
  showToast({ tone: "ok", title: "Agent Builder opened", desc: `Review “${spec.name}”, add any credentials, then confirm.` });
}

// P-AGENT.8.4: the Secrets & connections flyout — the easy-to-find place to add API credentials (to the vault)
// and confirm the sites this agent may reach. The agent directs the user here; it also opens from the toolbar.
async function openAbSecretsPanel(): Promise<void> {
  if (!abSpec) return;
  const side = $("#abSide");
  if (!side) return;
  let inVault = new Set<string>();
  try { if (bridge.isElectron && bridge.credList) inVault = new Set((await bridge.credList()).map((c) => c.ref)); } catch { /* vault unavailable → all show "needs a value" */ }
  let approved = new Set<string>();
  try { approved = new Set((await bridge.whitelistList()).map((e) => e.pattern)); } catch { /* whitelist unavailable → all show "Approve" */ }
  side.innerHTML = secretsPanelHtml(abSpec, inVault, !!bridge.isElectron, approved);
  side.hidden = false;
  $$(".ab-cred-save", side).forEach((b) => b.addEventListener("click", () => void addCredentialFromRow(b as HTMLElement)));
  $$(".ab-conn-approve", side).forEach((b) => b.addEventListener("click", () => void approveConnectionFromRow(b as HTMLElement))); // P-AGENT.8.5
  $$(".ab-cred-help", side).forEach((b) => b.addEventListener("click", () => askCredentialHelp(b as HTMLElement))); // P-AGENT.8.5
}
// P-AGENT.8.5: approve a declared connection → write a project-scoped WhitelistEntry so the agent's egress to
// that host is allowed under the managed ceiling (the whitelist itself enforces + can be tightened by policy).
async function approveConnectionFromRow(btn: HTMLElement): Promise<void> {
  const pattern = (btn.closest(".ab-conn-row") as HTMLElement | null)?.dataset.conn ?? "";
  if (!pattern) return;
  const r = await bridge.whitelistUpsert({ kind: "domain", pattern, zone: "external", scope: "project" });
  if (r) { showToast({ tone: "ok", title: "Connection approved", desc: `${pattern} added to this workspace's network whitelist.` }); void openAbSecretsPanel(); }
  else showToast({ tone: "danger", title: "Couldn't approve", desc: `${pattern} was rejected (malformed host pattern?).` });
}
// P-AGENT.8.5: doc-assisted setup — ask the agent to read the vendor's official docs and walk the user through
// generating this credential (the value goes to the vault, never the chat — the AGENT_BUILDER_POLICY enforces).
function askCredentialHelp(btn: HTMLElement): void {
  const row = btn.closest(".ab-cred-row") as HTMLElement | null;
  const name = row?.dataset.cred ?? "";
  const kind = row?.dataset.kind ?? "";
  const purpose = btn.dataset.purpose ?? "";
  const q = `Walk me through generating the credential "${name}" (kind: ${kind}${purpose ? `; for: ${purpose}` : ""}). Read the vendor's official documentation and give me clear, numbered step-by-step instructions to obtain it. Do NOT ask me for the value — I'll paste it into the Secrets & connections panel, which stores it in the encrypted vault.`;
  const ta = $("#input") as HTMLTextAreaElement | null;
  if (ta) { ta.value = q; autosize(ta); setSendEnabled(); }
  void send();
}
async function addCredentialFromRow(btn: HTMLElement): Promise<void> {
  const row = btn.closest(".ab-cred-row") as HTMLElement | null;
  if (!row) return;
  const name = row.dataset.cred ?? "";
  const kind = row.dataset.kind ?? "apikey";
  const input = $(".ab-cred-secret", row) as HTMLInputElement | null;
  const secret = (input?.value ?? "").trim();
  if (!secret) { showToast({ tone: "warn", title: "Paste the secret first", desc: "The value goes straight to the encrypted vault." }); return; }
  if (!bridge.isElectron || !bridge.credStore) {
    showToast({ tone: "danger", title: "Vault is desktop-only", desc: "Open the LUCID desktop app to store credentials securely." });
    return;
  }
  const r = await bridge.credStore({ ref: name, kind, secret, label: name });
  if (input) input.value = "";
  if (r && !("error" in r)) {
    showToast({ tone: "ok", title: "Stored in the vault", desc: `${name} (••••${(r as { last4?: string }).last4 ?? ""}) — encrypted; the agent never sees the value.` });
    void openAbSecretsPanel(); // refresh statuses
  } else {
    showToast({ tone: "danger", title: "Couldn't store the credential", desc: (r as { error?: string })?.error ?? "vault error" });
  }
}
// ── P-PREVIEW.5: markup overlay (pen / rectangle / text) ─────────────────────────
// A <canvas> sits ON TOP of the preview iframe. Because "Screenshot → chat" uses Electron's capturePage
// on the frame's screen region, the canvas markup is captured TOGETHER with the rendered app - no
// compositing needed. Arming a tool enables the canvas's pointer-events (so it catches the mouse);
// "Cursor" disarms it so the iframe is interactive again.
let drawTool: "off" | "pen" | "rect" | "text" = "off";
let drawColor = "#ff4d4d";
let drawing = false;
let drawSnapshot: ImageData | null = null; // committed pixels, restored while rubber-banding a rectangle
let drawStart = { x: 0, y: 0 };
const previewCanvas = (): HTMLCanvasElement | null => $("#prevCanvas") as HTMLCanvasElement | null;

/** Match the canvas backing size to the frame, preserving any existing drawing. */
function syncPreviewCanvas(): void {
  const frame = $("#prevFrame") as HTMLIFrameElement | null, cv = previewCanvas();
  if (!frame || !cv || frame.hidden) return;
  const r = frame.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (cv.width === w && cv.height === h) return;
  const ctx = cv.getContext("2d");
  const prev = ctx && cv.width && cv.height ? ctx.getImageData(0, 0, cv.width, cv.height) : null;
  cv.width = w; cv.height = h;
  if (prev && ctx) try { ctx.putImageData(prev, 0, 0); } catch { /* size shrank - drop */ }
}
function clearPreviewCanvas(): void { const cv = previewCanvas(); const c = cv?.getContext("2d"); if (cv && c) c.clearRect(0, 0, cv.width, cv.height); }
function setDrawTool(t: "off" | "pen" | "rect" | "text"): void {
  drawTool = t;
  const cv = previewCanvas();
  if (cv) { cv.style.pointerEvents = t === "off" ? "none" : "auto"; cv.style.cursor = t === "text" ? "text" : t === "off" ? "default" : "crosshair"; syncPreviewCanvas(); }
  $("#prevMarkup")?.classList.toggle("on", t !== "off");
}
let previewCanvasWired = false;
function wirePreviewCanvas(): void {
  const cv = previewCanvas();
  if (!cv || previewCanvasWired) return;
  previewCanvasWired = true;
  const ctx = () => cv.getContext("2d")!;
  const at = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  cv.addEventListener("mousedown", (e) => {
    if (drawTool === "off") return;
    const p = at(e as MouseEvent);
    if (drawTool === "text") { addPreviewTextBox(p); return; }
    drawing = true; drawStart = p;
    const c = ctx(); c.lineWidth = drawTool === "pen" ? 3 : 2.6; c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = drawColor;
    drawSnapshot = c.getImageData(0, 0, cv.width, cv.height);
    if (drawTool === "pen") { c.beginPath(); c.moveTo(p.x, p.y); }
  });
  cv.addEventListener("mousemove", (e) => {
    if (!drawing) return;
    const c = ctx(), p = at(e as MouseEvent);
    if (drawTool === "pen") { c.lineTo(p.x, p.y); c.stroke(); }
    else if (drawTool === "rect") { if (drawSnapshot) c.putImageData(drawSnapshot, 0, 0); c.strokeRect(drawStart.x, drawStart.y, p.x - drawStart.x, p.y - drawStart.y); }
  });
  const end = () => { drawing = false; drawSnapshot = null; };
  cv.addEventListener("mouseup", end);
  cv.addEventListener("mouseleave", end);
  // keep the canvas backing-size matched to the frame as the panel/window resizes (preserves the drawing)
  const frame = $("#prevFrame") as HTMLIFrameElement | null;
  if (frame && typeof ResizeObserver !== "undefined") new ResizeObserver(() => syncPreviewCanvas()).observe(frame);
}
/** A floating input for the text tool - type, Enter commits the text to the canvas, Esc cancels. */
function addPreviewTextBox(p: { x: number; y: number }): void {
  const body = $("#prevBody") as HTMLElement | null;
  if (!body) return;
  const inp = el(`<input class="prev-textin" spellcheck="false" placeholder="type, Enter to place" />`) as HTMLInputElement;
  inp.style.left = `${p.x}px`; inp.style.top = `${p.y}px`; inp.style.color = drawColor;
  body.appendChild(inp);
  inp.focus();
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const text = inp.value.trim();
    const cv = previewCanvas();
    if (text && cv) { const c = cv.getContext("2d")!; c.fillStyle = drawColor; c.font = "600 18px ui-sans-serif,system-ui,Segoe UI,sans-serif"; c.textBaseline = "top"; c.fillText(text, p.x, p.y); }
    inp.remove();
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") { done = true; inp.remove(); } });
  inp.addEventListener("blur", commit);
}
/** The markup tools dropdown: pen / rectangle / text, a colour row, Cursor (disarm), and Clear. */
function openMarkupMenu(anchor: HTMLElement): void {
  document.querySelector(".markup-pop")?.remove();
  const tool = (id: string, ic: string, label: string) => `<button class="mk-tool${drawTool === id ? " on" : ""}" data-tool="${id}">${icon(ic, 15)}<span>${label}</span></button>`;
  const swatch = (c: string) => `<button class="mk-swatch${drawColor === c ? " on" : ""}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`;
  const pop = el(`<div class="markup-pop">
    <div class="mk-tools">${tool("pen", "pen", "Pen")}${tool("rect", "square", "Rectangle")}${tool("text", "textT", "Text")}</div>
    <div class="mk-colors">${["#ff4d4d", "#ffd23f", "#46d27e", "#5e8df2", "#ffffff"].map(swatch).join("")}</div>
    <div class="mk-foot"><button class="mk-tool" data-tool="off">${icon("eye", 13)}<span>Cursor</span></button><button class="btn-mini danger" data-mk-clear>${icon("trash", 12)} Clear</button></div>
  </div>`);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 12))}px`;
  pop.style.top = `${r.bottom + 6}px`;
  const close = () => { pop.remove(); document.removeEventListener("mousedown", onDoc, true); };
  const onDoc = (e: MouseEvent) => { if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  setTimeout(() => document.addEventListener("mousedown", onDoc, true), 0);
  pop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const toolBtn = t.closest("[data-tool]") as HTMLElement | null;
    if (toolBtn) { setDrawTool(toolBtn.dataset.tool as "off" | "pen" | "rect" | "text"); close(); return; }
    const sw = t.closest("[data-color]") as HTMLElement | null;
    if (sw) { drawColor = sw.dataset.color!; pop.querySelectorAll(".mk-swatch").forEach((s) => s.classList.toggle("on", s === sw)); if (drawTool === "off") setDrawTool("pen"); return; }
    if (t.closest("[data-mk-clear]")) { clearPreviewCanvas(); return; }
  });
}
/** Browse the workspace for a file to preview (native OS picker; the user opens the cwd themselves). */
async function browsePreviewFile(): Promise<void> {
  if (!bridge.isElectron) { showToast({ title: "Desktop app only", desc: "File browsing uses the native picker in the packaged LUCID app. In the browser, paste a path above.", actions: [{ label: "OK" }], timeout: 3400, tone: "warn" }); ($("#prevPath") as HTMLElement | null)?.focus(); return; }
  const picked = await bridge.pickFile?.({ title: "Open a file to preview", filters: [{ name: "Previewable", extensions: ["html", "htm", "svg", "md", "png", "jpg", "jpeg", "gif", "pdf"] }, { name: "All files", extensions: ["*"] }] }).catch(() => null);
  if (!picked) return;
  const p = $("#prevPath") as HTMLInputElement | null;
  if (p) p.value = picked;
  loadPreview(picked);
}

/** Capture the preview iframe and attach the PNG to the composer for the agent to react to. Electron-only
 *  (uses the window's capturePage via the preload seam); a no-op with a toast in a plain browser. */
async function screenshotPreviewToChat(): Promise<void> {
  const frame = $("#prevFrame") as HTMLIFrameElement | null;
  if (!frame || frame.hidden) { showToast({ title: "Nothing to capture", desc: "Open a local file in the preview first.", actions: [{ label: "OK" }], timeout: 2600 }); return; }
  if (!bridge.isElectron || !bridge.capturePreview) {
    showToast({ title: "Desktop app only", desc: "Screenshots of the preview are captured in the packaged LUCID app.", actions: [{ label: "OK" }], timeout: 3200, tone: "warn" });
    return;
  }
  const rect = frame.getBoundingClientRect();
  const png = await bridge.capturePreview({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }).catch(() => null);
  if (!png) { showToast({ title: "Capture failed", desc: "Could not capture the preview.", actions: [{ label: "OK" }], timeout: 2600, tone: "warn" }); return; }
  // Drop the capture into the chat transcript as a visual record the user can reference. Feeding it to the
  // agent as multimodal input arrives with the agent-driven tools in P-PREVIEW.2. The PNG data URL is set
  // as a DOM PROPERTY (img.src), never interpolated into an HTML string, so nothing is reparsed as HTML.
  const shot = addEvent(`<div class="evt preview-shot">${icon("eye", 14)}<span>Preview screenshot</span></div>`);
  const img = document.createElement("img");
  img.src = png; img.alt = "preview screenshot"; img.className = "preview-shot-img";
  shot.appendChild(img);
  showToast({ title: "Screenshot added to chat", desc: "Captured the preview into the conversation.", actions: [{ label: "OK" }], timeout: 2600 });
}
// P-PERF.2 (ADR-0129): the minimal-tier pause card. The agent keeps FULL knowledge access - only the
// CPU-hungry visualization is skipped (the O(n^2) settle + particle loop is what spikes a battery-throttled
// laptop). "Render anyway" is a one-shot, per-run override that mounts at minimal fidelity.
function renderKgPaused(canvas: HTMLElement): void {
  const side = $("#kgSide") as HTMLElement | null;
  if (side) { side.hidden = true; side.innerHTML = ""; }
  canvas.innerHTML = `<div class="kg-empty kg-paused">${icon("gauge", 30)}
    <div><b>Graph rendering is paused to save power.</b><br/>
    Minimal performance mode is active (low battery, or your override). The agent still reads and writes
    your knowledge - only this visualization is off.</div>
    <button class="btn-mini" id="kgRenderAnyway">Render anyway</button></div>`;
  showKgCenter(false); syncKgSideOpen();
  $("#kgRenderAnyway")?.addEventListener("click", () => { kgForceRender = true; void renderKnowledge(); });
}
function paintPerfChip(): void {
  const b = $("#kgPerf");
  if (!b) return;
  const m = perfWatch.mode();
  b.innerHTML = `${icon("gauge", 13)} ${m === "auto" ? `Auto · ${perfWatch.tier()}` : m}`;
}
// P-SYSRES.1 (ADR-0182): the resource-guard blocked card. Unlike the P-PERF.2 pause there is NO
// "render anyway" - a machine at the blocked line would freeze; the way out is closing applications
// (the panel shows which) and re-checking. Re-check busts the 5s memo so the verdict is live.
function renderSysBlocked(canvas: HTMLElement, sys: SystemStatusView, feature: string, retry: () => void): void {
  const side = $("#kgSide") as HTMLElement | null;
  if (side) { side.hidden = true; side.innerHTML = ""; }
  canvas.innerHTML = guardBlockedHtml(sys, feature);
  showKgCenter(false); syncKgSideOpen();
  canvas.querySelector("[data-sys-panel]")?.addEventListener("click", () => openResourcePanel(sys));
  canvas.querySelector("[data-sys-recheck]")?.addEventListener("click", () => { void bridge.systemStatus(true).then(() => retry()); });
}
/** The System resources modal (About/Marketplace scrim conventions). Refresh re-samples fresh. */
function openResourcePanel(status: SystemStatusView): void {
  if ($("#sysresModal")) return; // already open - don't stack
  const ov = el(`<div id="sysresModal" class="mkt-scrim">${resourcePanelHtml(status)}</div>`);
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); close(); } };
  ov.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest("[data-sys-refresh]")) {
      void bridge.systemStatus(true).then((fresh) => {
        const body = ov.querySelector("#sysresBody");
        if (body && fresh) body.innerHTML = resourcePanelBodyHtml(fresh);
      });
      return;
    }
    if (t === ov || t.closest("[data-sys-close]")) close(); // backdrop or the X
  });
  document.addEventListener("keydown", onKey);
  document.body.append(ov);
}
/** Palette entry point: sample first (fresh), then open. */
async function openResourcePanelLive(): Promise<void> {
  const status = await bridge.systemStatus(true).catch(() => null);
  if (!status) { showToast({ title: "System resources", desc: "Couldn't read a system profile on this platform.", actions: [{ label: "OK" }], timeout: 3200 }); return; }
  openResourcePanel(status);
}
async function renderKnowledge(): Promise<void> {
  const canvas = $("#kgCanvas"), side = $("#kgSide"), scopeLbl = $("#kgScopeLbl");
  if (!canvas || !side) return;
  kbGraphMode = false; updateKbButton(false); // P-KB.2b: personal graph is neither code nor compiled-KB
  kgHandle?.destroy(); kgHandle = null;
  // #11 perceived-latency: the graph store is encrypted, so personal()/personalGraph()
  // can take a beat to decrypt. Paint a calm "Decrypting…" state INSTANTLY; the gate()
  // / mountGraph below always replaces it (and the catch() guarantees no stuck shimmer).
  canvas.innerHTML = `<div class="skel-kg">${icon("refresh", 26, "spin")}<div>Decrypting your graph…</div></div>`;
  (side as HTMLElement).hidden = true; side.innerHTML = ""; // the facts panel only appears on selection
  let status: Awaited<ReturnType<typeof bridge.personal>>;
  try { status = await bridge.personal(); }
  catch { canvas.innerHTML = `<div class="kg-empty">${icon("graph", 30)}<div>Couldn't load your graph. Try reopening this panel.</div></div>`; return; }
  if (scopeLbl) scopeLbl.textContent = status?.scope ? `· ${status.scope}` : "";
  const gate = (msg: string) => { canvas.innerHTML = `<div class="kg-empty">${icon("graph", 30)}<div>${msg}</div></div>`; (side as HTMLElement).hidden = true; side.innerHTML = ""; showKgCenter(false); syncKgSideOpen(); };
  if (!status?.enabled) return gate("Personalization is off. Enable it in Settings to build a knowledge graph.");
  if (!status.unlocked) {
    // Configured-but-locked → unlock right here (no trip to Settings). Not yet set up → Settings.
    if (status.configured) return renderKgLocked(canvas as HTMLElement);
    return gate("Personalization isn't set up yet. Create a passphrase in Settings to start your private graph.");
  }
  // P-SYSRES.1 (ADR-0182): hard-pause the CPU-heavy graph build while the machine is starved. Checked
  // BEFORE the decrypt so pausing skips that cost too. Fail-open: no profile evidence never blocks.
  const sysKg = await bridge.systemStatus().catch(() => null);
  if (sysKg?.verdict.level === "blocked") return renderSysBlocked(canvas as HTMLElement, sysKg, "knowledge graph", () => void renderKnowledge());
  // P-PERF.2: pause BEFORE the decrypt - skipping the render should skip its cost too.
  if (perfWatch.tier() === "minimal" && !kgForceRender) return renderKgPaused(canvas as HTMLElement);
  try { kgData = await bridge.personalGraph(); }
  catch { return gate("Couldn't decrypt your graph. Try reopening this panel."); }
  if (!kgData || kgData.nodes.length === 0) return gate("Nothing learned yet. It remembers durable facts about <b>you</b> - not what we discuss. Tell me things like <i>“I prefer Rust”</i>, <i>“I use vim”</i>, <i>“I decided to go with Postgres”</i>, or <i>“remember that I deploy with Kubernetes”</i> and they'll appear here (each is security-scanned first).");
  (side as HTMLElement).hidden = true; side.innerHTML = ""; // appears only when a node is clicked
  // P-PERF.2: tier-scaled fidelity - calm + shorter settle + a top-hubs cap off AC power. kgData stays
  // FULL (search, facts, signature); only the DRAWN subset is capped.
  const gOpts = graphOpts(perfWatch.tier());
  const { data: kgDraw, capped: kgCapped } = capGraph(kgData, gOpts.nodeCap);
  kgHandle = mountGraph(canvas as HTMLElement, kgDraw, (id) => renderKgSide(id), { onRelate: relateNodes, onRelatePick: onRelatePick }, {
    ...gOpts, // P-PERF.3: seed from + harvest into the per-graph layout cache (no re-explosion on re-open)
    positions: kgLayoutCache.get("personal"),
    onPositions: (pos) => kgLayoutCache.set("personal", pos),
  });
  if (kgCapped && scopeLbl) scopeLbl.textContent += ` · top ${kgDraw.nodes.length} of ${kgData.nodes.length} nodes`;
  showKgCenter(true); syncKgSideOpen();
  if (kgRelateMode) { kgHandle.setRelateMode(true); onRelatePick([]); } // preserve relate mode across a live remount
  const sq = ($("#kgSearch") as HTMLInputElement | null)?.value; // P-KG-SEARCH.1: preserve an active search across a remount
  if (sq?.trim()) kgHandle.setSearch(matchNodes(kgData.nodes, sq));
  kgHandle.setLens(kgLens);
  kgSig = kgSignature(kgData); // baseline so live refreshes only fire on real changes
}

// P-KG-CODE.1b: the floating "re-center" button (bottom-right of the canvas) + the side-panel open state
// (drives the resizer + shifts the center button left of the flyout). The center button re-fits the graph.
function showKgCenter(on: boolean): void { const b = $("#kgCenter") as HTMLElement | null; if (b) b.hidden = !on; }
function syncKgSideOpen(): void {
  const side = $("#kgSide") as HTMLElement | null, main = document.querySelector(".kg-main") as HTMLElement | null, rsz = $("#kgSideResizer") as HTMLElement | null;
  const open = !!side && !side.hidden;
  main?.classList.toggle("side-open", open);
  if (rsz) rsz.hidden = !open;
}

// ── P-KB.2b (ADR-0099/0100): the COMPILED knowledge base as a 3rd source in the shared kg canvas ──
// Mirrors the code-graph path (renderCodeGraph): fetch pages+links (bridge.kbGraph), map into
// PersonalGraphData, and mount into #kgCanvas via the shared mountGraph. A node click shows that page's
// body as DATA (escaped, never executed - invariant #5). Reuses the handle + layout cache + center button;
// mutually exclusive with the personal + code graphs (the guards mirror kgCodeMode).
function kbToGraphData(g: KbGraphView): PersonalGraphData {
  const degree = new Map<string, number>();
  for (const l of g.links) { degree.set(l.from_page_id, (degree.get(l.from_page_id) ?? 0) + 1); degree.set(l.to_page_id, (degree.get(l.to_page_id) ?? 0) + 1); }
  return {
    nodes: g.pages.map((p) => ({ id: p.page_id, name: p.title || p.slug, kind: p.kind, trust: p.trust_label, count: degree.get(p.page_id) ?? 0 })),
    edges: g.links.map((l) => ({ from: l.from_page_id, to: l.to_page_id, relation: l.relation })),
    facts: [],
  };
}
function updateKbButton(active: boolean): void {
  kbGraphMode = active;
  updateKgViewsLabel(); // P-KGUI.1: the consolidated views button shows the active graph
}
/** Render a selected compiled page in the kg side panel - its body is UNTRUSTED DATA (escaped + framed). */
function renderKbSide(id: string | null): void {
  const side = $("#kgSide") as HTMLElement | null; if (!side) return;
  const page = id ? kbGraphData?.pages.find((p) => p.page_id === id) : null;
  if (!page) { side.hidden = true; side.innerHTML = ""; syncKgSideOpen(); return; }
  side.innerHTML = `<div class="kb-side">
    <div class="kb-side-hd"><b>${esc(page.title)}</b> <span class="skdir-trust ${esc(page.trust_label)}">${esc(page.trust_label)}</span></div>
    <div class="kb-side-kind">${esc(page.kind)} \u00b7 <code>${esc(page.slug)}</code></div>
    <div class="skdir-databanner">${icon("shield", 12)} Page body - shown as <b>data</b>, never run as instructions.</div>
    <pre class="skdir-body">${esc(page.body_md)}</pre></div>`;
  side.hidden = false; syncKgSideOpen();
}
/** Fetch + draw the compiled KB page graph in the shared canvas (mirrors renderCodeGraph). */
async function renderKbGraph(): Promise<void> {
  const canvas = $("#kgCanvas"), side = $("#kgSide") as HTMLElement | null, scopeLbl = $("#kgScopeLbl");
  if (!canvas) return;
  kgHandle?.destroy(); kgHandle = null;
  kbGraphMode = true; updateKbButton(true); updateCodeGraphButtons(false); // mutually exclusive with code + personal
  canvas.innerHTML = `<div class="skel-kg">${icon("refresh", 26, "spin")}<div>Loading the compiled KB\u2026</div></div>`;
  if (side) { side.hidden = true; side.innerHTML = ""; }
  const g = await bridge.kbGraph().catch(() => null);
  kbGraphData = g;
  if (scopeLbl) scopeLbl.textContent = g ? `\u00b7 compiled KB \u00b7 ${g.pages.length} pages \u00b7 ${g.links.length} links` : "";
  if (!g || !g.pages.length) { canvas.innerHTML = `<div class="kg-empty">${icon("report", 30)}<div>The compiled KB is empty. Ingest a document to build summary, concept &amp; entity pages.</div></div>`; showKgCenter(false); syncKgSideOpen(); return; }
  kgHandle = mountGraph(canvas as HTMLElement, kbToGraphData(g), (id) => renderKbSide(id), {}, {
    positions: kgLayoutCache.get("kb"),
    onPositions: (pos) => kgLayoutCache.set("kb", pos),
  });
  kgHandle.setLens(kgLens);
  showKgCenter(true); syncKgSideOpen();
}
/** Toggle the compiled KB view (off returns to the personal graph). */
async function toggleKbGraph(): Promise<void> {
  if (kbGraphMode) { updateKbButton(false); await renderKnowledge(); }
  else await renderKbGraph();
}
// ── P-KG-CODE.1 / P-KG-SYM.1: the workspace CODE graph (file imports OR symbol AST), in the same canvas ──
function updateCodeGraphButtons(active: boolean, meta?: import("./bridge.ts").CodeGraphView | null): void {
  kgCodeMode = active;
  updateKgViewsLabel(); // P-KGUI.1: the consolidated views button shows the active graph
  const upd = $("#kgCodeUpdate"), scopeLbl = $("#kgScopeLbl") as HTMLElement | null;
  if (upd) (upd as HTMLElement).hidden = !active;
  if (scopeLbl) scopeLbl.textContent = active && meta
    ? (meta.level === "symbol" ? `· symbols · ${meta.symbolCount} symbols · ${meta.edgeCount} refs` : `· code · ${meta.fileCount} files · ${meta.edgeCount} imports`)
    : "";
}
/** Render the workspace code graph at `level`. `ingest` forces a fresh (re)build; otherwise load the stored
 *  graph (building on first use). Bypasses the personalization gate - the code graph isn't private user data. */
async function renderCodeGraph(ingest: boolean, level: "file" | "symbol" = codeGraphLevel): Promise<void> {
  codeGraphLevel = level;
  const canvas = $("#kgCanvas"), side = $("#kgSide") as HTMLElement | null;
  if (!canvas) return;
  kbGraphMode = false; updateKbButton(false); // P-KB.2b: leaving compiled-KB mode for the code graph
  kgHandle?.destroy(); kgHandle = null;
  const busy = ingest ? (level === "symbol" ? "Parsing symbols (AST)…" : "Ingesting the workspace…") : "Loading the code graph…";
  canvas.innerHTML = `<div class="skel-kg">${icon("refresh", 26, "spin")}<div>${busy}</div></div>`;
  if (side) { side.hidden = true; side.innerHTML = ""; }
  // P-SYSRES.1 (ADR-0182): the AST ingest is the app's biggest CPU spike - hard-pause it while the
  // machine is starved (notice + what-to-close panel + re-check). Fail-open on missing evidence.
  const sysCg = await bridge.systemStatus().catch(() => null);
  if (sysCg?.verdict.level === "blocked") {
    renderSysBlocked(canvas as HTMLElement, sysCg, "code graph", () => void renderCodeGraph(ingest, level));
    updateCodeGraphButtons(true, null);
    return;
  }
  let data = ingest ? await bridge.codeGraphIngest(level).catch(() => null) : await bridge.codeGraph(level).catch(() => null);
  if (data && !data.ingested && !ingest) data = await bridge.codeGraphIngest(level).catch(() => null); // never built → build now
  if (!data || !data.nodes.length) {
    canvas.innerHTML = `<div class="kg-empty">${icon("graph", 30)}<div>No ${level === "symbol" ? "symbols" : "source files"} found to graph in this workspace. Open a code repo as your workspace, then try again.</div></div>`;
    updateCodeGraphButtons(true, null); showKgCenter(false); return;
  }
  // A big repo is 1000s of nodes - keep the canvas readable by rendering the MOST-CONNECTED hubs (the full
  // graph is still ingested + stored + queryable; only the drawing is capped).
  let nodes = data.nodes, edges = data.edges, capped = 0;
  // P-PERF.2: an explicit "Code graph" click renders even at minimal tier (the user asked), but the
  // tier tightens the hub cap and calms the sim so a battery-throttled laptop isn't pegged.
  const gOpts = graphOpts(perfWatch.tier());
  const CAP = Math.min(600, gOpts.nodeCap ?? 600);
  if (nodes.length > CAP) {
    const keep = new Set([...nodes].sort((a, b) => b.count - a.count).slice(0, CAP).map((n) => n.id));
    capped = nodes.length - CAP;
    nodes = nodes.filter((n) => keep.has(n.id));
    edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }
  codeGraphRoot = data.root || "";
  kgData = { nodes, edges, facts: [] };
  kgHandle = mountGraph(canvas as HTMLElement, kgData, (id) => renderCodeSide(id), {}, {
    ...gOpts, // P-PERF.3: same layout continuity for the code graph, keyed by level
    positions: kgLayoutCache.get(`code:${level}`),
    onPositions: (pos) => kgLayoutCache.set(`code:${level}`, pos),
  });
  kgHandle.setLens(kgLens);
  kgSig = kgSignature(kgData);
  updateCodeGraphButtons(true, data);
  showKgCenter(true); syncKgSideOpen();
  if (capped) { const s = $("#kgScopeLbl") as HTMLElement | null; if (s) s.textContent += ` · showing top ${CAP} hubs`; }
}
/** Toggle personal ↔ code graph. Entering code mode opens the level picker (file vs symbol + agent option). */
async function toggleCodeGraph(): Promise<void> {
  if (kgCodeMode) { updateCodeGraphButtons(false); await renderKnowledge(); return; }
  openCodeGraphPicker();
}
/** The "build a code graph" popup: choose file-level (fast) vs symbol-level (AST), and whether to expose it
 *  to the agent as a queryable tool. */
function openCodeGraphPicker(): void {
  document.querySelector(".goal-scrim .cg-picker")?.closest(".goal-scrim")?.remove();
  const agentOn = state.codeGraphAgent;
  const ov = el(`<div class="goal-scrim"><div class="goal-modal cg-picker">
    <div class="goal-modal-h"><span class="goal-h-title">${icon("graph", 15)} Build a code graph</span><button type="button" class="btn-mini" id="cgpClose">Close</button></div>
    <div class="goal-modal-sub">Ingest THIS workspace into a knowledge graph you (and optionally the agent) can explore. Pick how deep to go.</div>
    <div class="cg-levels">
      <button type="button" class="cg-level" data-level="file">
        <div class="cg-level-h">${icon("graph", 16)} File graph <span class="cg-level-fast">fast</span></div>
        <div class="cg-level-d">Files as nodes, <b>imports</b> as edges - the module dependency map. Builds in a second or two; great for architecture orientation and "what depends on what".</div>
      </button>
      <button type="button" class="cg-level" data-level="symbol">
        <div class="cg-level-h">${icon("markup", 16)} Symbol graph <span class="cg-level-slow">AST</span></div>
        <div class="cg-level-d">Functions, classes, methods, types &amp; consts as nodes, <b>references/calls</b> as edges - real TypeScript-AST parsing for precise blast-radius ("what actually uses this symbol?"). Slower to build (usually a few seconds; longer on very large repos), and it's a symbol-DEPENDENCY graph, not a fully type-resolved call graph.</div>
      </button>
    </div>
    <label class="cg-agent-opt" data-tip="Expose to agent|When on, the agent gets a read-only codegraph_query tool it can call to ask what imports/uses a file or symbol - so it reads a precise answer instead of many whole files. Toggling this restarts the agent backend.">
      <input type="checkbox" id="cgAgent"${agentOn ? " checked" : ""}/> <span>Let the agent query this graph <span class="cg-agent-sub">(adds a read-only tool; restarts the agent)</span></span></label>
  </div></div>`);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  $("#cgpClose", ov)?.addEventListener("click", close);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
  $("#cgAgent", ov)?.addEventListener("change", (e) => void setCodeGraphAgent((e.target as HTMLInputElement).checked));
  ov.querySelectorAll("[data-level]").forEach((b) => b.addEventListener("click", () => {
    close();
    void renderCodeGraph(false, (b as HTMLElement).dataset.level === "symbol" ? "symbol" : "file");
  }));
}
/** Persist the "expose to agent" toggle + restart the backend so the codegraph tool loads/unloads. */
async function setCodeGraphAgent(on: boolean): Promise<void> {
  state.codeGraphAgent = on;
  const r = await bridge.setCodeGraphAgent(on).catch(() => null);
  showToast(r ? { title: on ? "Code graph tool enabled" : "Code graph tool disabled", desc: on ? "The agent can now query the code graph. Restarting the agent…" : "Removed the agent's code-graph tool. Restarting the agent…", timeout: 3600 } : { tone: "warn", title: "Couldn't update", desc: "The setting didn't save.", timeout: 2600 });
}
/** Side panel for a code node: its path, what it imports, and what imports it. */
function renderCodeSide(id: string | null): void {
  const side = $("#kgSide") as HTMLElement | null;
  if (!side) return;
  const node = id ? kgData?.nodes.find((n) => n.id === id) : null;
  if (!node) { side.hidden = true; side.innerHTML = ""; syncKgSideOpen(); return; }
  const outs = (kgData?.edges ?? []).filter((e) => e.from === id).map((e) => e.to);
  const ins = (kgData?.edges ?? []).filter((e) => e.to === id).map((e) => e.from);
  // Each entry is a link that opens the real file in the Monaco IDE (P-KG-CODE.1d). For a symbol id
  // (`file#symbol`) the label shows the symbol + its file; clicking opens the file (openCodeFile strips the #).
  const sym = codeGraphLevel === "symbol";
  const label = (id: string) => sym && id.includes("#") ? `${id.split("#")[1]} <span class="cg-open-file">${id.split("#")[0]}</span>` : esc(id);
  const fileLink = (id: string, extra = "") => `<button type="button" class="cg-open${extra}" data-cg-open="${esc(id)}" data-tip="Open the file in the editor">${label(id)}</button>`;
  const list = (xs: string[]) => xs.length ? `<ol class="cg-side-list">${xs.slice(0, 80).map((x) => `<li>${fileLink(x)}</li>`).join("")}</ol>` : `<div class="cg-side-none">none</div>`;
  const outLbl = sym ? "Uses" : "Imports", inLbl = sym ? "Used by" : "Imported by";
  side.hidden = false;
  side.innerHTML = `<div class="cg-side">
    <div class="cg-side-h">${icon(sym ? "markup" : "graph", 14)} <b>${esc(node.name)}</b>${sym ? ` <span class="cg-side-kind">${esc(node.kind)}</span>` : ""}</div>
    ${fileLink(node.id, " cg-side-path")}
    <div class="cg-side-sec"><span class="cg-side-lbl">${outLbl} (${outs.length})</span>${list(outs)}</div>
    <div class="cg-side-sec"><span class="cg-side-lbl">${inLbl} (${ins.length})</span>${list(ins)}</div>
  </div>`;
  syncKgSideOpen();
}
/** Open a code-graph file (relative to the workspace root) in the Monaco IDE panel. */
async function openCodeFile(id: string): Promise<void> {
  const rel = (id || "").split("#")[0]!; // a symbol id is `file#symbol` - open the file
  if (!rel) return;
  if (!codeGraphRoot) { showToast({ tone: "warn", title: "Can't open", desc: "The workspace root is unknown - re-run the code graph.", timeout: 2600 }); return; }
  const abs = `${codeGraphRoot.replace(/[\\/]+$/, "")}/${rel}`;
  const r = await bridge.editorRead(abs).catch(() => null);
  if (r?.ok && typeof r.content === "string") { await openIde({ path: abs, code: r.content, sha256: r.sha256, mtime: r.mtime }); return; }
  showToast({ tone: "warn", title: "Couldn't open the file", desc: `${rel} wasn't readable on disk (it may have moved since the last ingest - try Update).`, timeout: 3400 });
}
// Inline unlock for the Knowledge graph - enter the passphrase here instead of going to Settings.
// Validates (non-empty), warns on Caps Lock, and has a show/hide toggle. On success the graph mounts.
function renderKgLocked(canvas: HTMLElement): void {
  const side = $("#kgSide") as HTMLElement | null; if (side) { side.hidden = true; side.innerHTML = ""; }
  canvas.innerHTML = `<div class="kg-empty kg-unlock">
    ${icon("shield", 30)}
    <div>Your store is locked. Enter your passphrase to unlock it for this session.</div>
    <div class="kg-unlock-field">
      <input id="kgPass" type="password" class="prov-key" placeholder="Passphrase" autocomplete="off" spellcheck="false" aria-label="Passphrase" />
      <button id="kgPassShow" class="kg-eye" type="button" data-tip="Show / hide passphrase" aria-label="Show passphrase" aria-pressed="false">${icon("eye", 15)}</button>
    </div>
    <button id="kgUnlock" class="btn-mini ok kg-unlock-btn">${icon("shield", 12)} Unlock</button>
    <div id="kgCaps" class="kg-unlock-hint caps" hidden>${icon("info", 11)} Caps Lock is on</div>
    <div id="kgPassErr" class="kg-unlock-hint err" hidden></div>
    <div class="kg-unlock-note">Your passphrase is never stored or sent anywhere - it decrypts the store in memory for this session only.</div>
  </div>`;
  const input = $("#kgPass", canvas) as HTMLInputElement;
  const caps = $("#kgCaps", canvas) as HTMLElement;
  const err = $("#kgPassErr", canvas) as HTMLElement;
  const showBtn = $("#kgPassShow", canvas) as HTMLButtonElement;
  const unlockBtn = $("#kgUnlock", canvas) as HTMLButtonElement;
  const onKey = (e: KeyboardEvent) => { try { caps.hidden = !e.getModifierState("CapsLock"); } catch { /* unsupported */ } };
  input.addEventListener("keydown", onKey);
  input.addEventListener("keyup", onKey);
  input.addEventListener("input", () => { err.hidden = true; });
  showBtn.addEventListener("click", () => {
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    showBtn.classList.toggle("on", reveal);
    showBtn.setAttribute("aria-pressed", String(reveal));
    input.focus();
  });
  const doUnlock = async () => {
    const pass = input.value;
    if (!pass.trim()) { err.textContent = "Enter your passphrase."; err.hidden = false; input.focus(); return; }
    unlockBtn.disabled = true; unlockBtn.innerHTML = `${icon("refresh", 12, "spin")} Unlocking…`;
    const r = await bridge.personalUnlock(pass).catch(() => null);
    if (r?.ok) { showToast({ title: "Unlocked", desc: "Your graph is decrypted for this session.", timeout: 2000 }); void renderKnowledge(); return; }
    err.textContent = r?.error ? r.error : "Incorrect passphrase. Try again."; err.hidden = false;
    unlockBtn.disabled = false; unlockBtn.innerHTML = `${icon("shield", 12)} Unlock`;
    input.select(); input.focus();
  };
  unlockBtn.addEventListener("click", () => void doUnlock());
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void doUnlock(); } });
  input.focus();
}
function renderKgSide(id: string | null): void {
  kgSelId = id;
  const side = $("#kgSide") as HTMLElement | null; if (!side || !kgData) return;
  // No selection → hide the panel entirely so the graph uses the full width (the canvas re-fits via
  // its ResizeObserver). It reappears only when a node is selected.
  if (!id) { side.hidden = true; side.innerHTML = ""; return; }
  const node = kgData.nodes.find((n) => n.id === id);
  if (!node) { side.hidden = true; side.innerHTML = ""; return; }
  side.hidden = false;
  const facts = kgData.facts.filter((f) => f.entity_id === id);
  const rows = facts.map((f) => `<div class="kg-fact">
      <div class="kg-fact-stmt">${esc(f.statement)}</div>
      <div class="kg-fact-meta"><span class="pill ${esc(f.trust)}">${esc(f.trust)}</span> <span>conf ${Math.round((f.confidence ?? 0) * 100)}%</span>
        <button class="kg-forget" data-forget="${esc(f.id)}" data-tip="Forget this|Soft-delete - the agent stops recalling it.">${icon("close", 12)} forget</button></div>
    </div>`).join("");
  // P-KG-REL.3: this node's relationships, each removable. Arrow shows direction (→ from this node, ← into it).
  const nameOf = (nid: string): string => kgData!.nodes.find((n) => n.id === nid)?.name ?? "(removed)";
  const edges = kgData.edges.filter((e) => e.from === id || e.to === id);
  const relRows = edges.map((e) => {
    const other = e.from === id ? e.to : e.from;
    return `<div class="kg-rel">
      <div class="kg-rel-text"><span class="kg-rel-arrow">${e.from === id ? "→" : "←"}</span> <b>${esc(nameOf(other))}</b> <span class="kg-rel-label">${esc(e.relation)}</span></div>
      <button class="kg-unrelate" data-unrelate data-from="${esc(e.from)}" data-to="${esc(e.to)}" data-rel="${esc(e.relation)}" data-tip="Remove this relationship|Deletes the edge; the nodes stay.">${icon("close", 11)}</button>
    </div>`;
  }).join("");
  const relSection = edges.length ? `<div class="kg-side-sub">Relationships</div><div class="kg-side-rels">${relRows}</div>` : "";
  side.innerHTML = `<div class="kg-side-head"><span class="kg-side-kind" style="background:${kindTint(node.kind)}">${esc(kindLabel(node.kind))}</span><b>${esc(node.name)}</b></div>
    <div class="kg-side-facts">${rows || `<div class="empty">No active facts.</div>`}</div>${relSection}`;
}
const kindTint = (k: string): string => {
  const c: Record<string, string> = { preference: "var(--cyan-dim)", interest: "var(--green-dim)", decision: "var(--blue-dim)", behavior: "var(--amber-dim)", personality: "var(--accent-dim)" };
  return c[kindLabel(k)] ?? "var(--bg-3)";
};

// #115: a successful export used to flash its location for a few seconds, then it was gone. Keep the toast
// up (when there's a real path) and offer Copy path - plus Open folder in the desktop app - so the
// destination is recoverable. With no path (export failed before writing) it auto-dismisses as before.
function showExportToast(title: string, desc: string, dest: string | undefined): void {
  const plan = exportActionPlan(dest, bridge.canRevealPath());
  const actions: ToastAction[] = [];
  if (plan.reveal) actions.push({ label: "Open folder", kind: "ok", run: () => void bridge.revealPath(dest!) });
  if (plan.copy) actions.push({ label: "Copy path", run: () => void copyExportPath(dest!) });
  actions.push({ label: "OK" });
  showToast({ title, desc, meta: plan.persist ? `→ ${dest}` : undefined, actions, timeout: plan.persist ? 0 : 7000 });
}
async function copyExportPath(dest: string): Promise<void> {
  try { await navigator.clipboard.writeText(dest); showToast({ title: "Path copied", desc: dest, timeout: 2400 }); }
  catch { showToast({ tone: "warn", title: "Couldn't copy the path", desc: dest, actions: [{ label: "OK" }], timeout: 4000 }); }
}

// ───────────────────────── workspace ─────────────────────────
function workspaceSection(ws: WorkspaceInfo): string {
  return `<div class="set-sec"><div class="set-lbl">Workspace <span class="set-sub">the folder the agent works in</span></div>
    <div class="ws-current">
      <div class="ws-name">${icon(ws.isGit ? "git" : "folder", 15)} ${esc(ws.name)} ${ws.isGit ? `<span class="abadge ok">git</span>` : ""}</div>
      <div class="ws-path">${esc(ws.current)}</div>
    </div>
    <div class="prov-row">
      <input class="prov-key" id="wsPath" placeholder="Paste a folder path…" />
      <button class="btn-mini ok" id="wsBrowse">${icon("folder", 13)} Browse</button>
      <button class="btn-mini" id="wsSet">Open</button>
    </div>
    <div class="prov-row">
      <input class="prov-key" id="wsCloneUrl" placeholder="Clone a git repo - https://github.com/… or gitlab.com/…" />
      <button class="btn-mini ok" id="wsClone">${icon("git", 13)} Clone</button>
    </div>
    ${ws.recent.length ? `<div class="ws-recent">${ws.recent.map((r) => `<button class="ws-recent-item" data-ws="${esc(r.path)}" title="${esc(r.path)}">${icon(r.isGit ? "git" : "folder", 12)} ${esc(r.name)}</button>`).join("")}</div>` : ""}
  </div>`;
}
function renderWorkspaceBar(): void {
  const bar = $("#wsBar") as HTMLButtonElement | null;
  const w = state.workspace;
  if (!bar) return;
  if (!w) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `${icon(w.isGit ? "git" : "folder", 14)}<span class="ws-bar-name">${esc(w.name)}</span>${icon("sliders", 12, "dim")}`;
}
async function loadWorkspace(): Promise<void> {
  // #11 perceived-latency: the bar used to stay hidden until workspace() resolved, then
  // pop in. Show a subtle "loading workspace…" pill instantly; renderWorkspaceBar() below
  // always replaces it (even on a null/failed result, which hides the bar as before).
  const bar = $("#wsBar") as HTMLButtonElement | null;
  if (bar && !state.workspace) {
    bar.hidden = false;
    bar.innerHTML = `<span class="ws-bar-loading">${icon("refresh", 12, "spin")}loading workspace…</span>`;
  }
  state.workspace = await bridge.workspace().catch(() => null);
  renderWorkspaceBar();
}
// P-RESUME.1 (ADR-0171): insert one restored-activity group and wire its collapse toggles (the
// live windows attach listeners at creation; restored markup is a static string, so wire here).
function attachRestoredSteps(g: RestoredTurn): void {
  const node = el(restoredTurnHtml(g));
  for (const btn of $$("[data-rs-toggle]", node)) {
    btn.addEventListener("click", () => {
      const win = btn.closest(".reasoning, .thoughts");
      if (!win) return;
      const open = win.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(open));
    });
  }
  $("#thread")!.appendChild(node);
}
function renderThread(msgs: { role: string; text: string; turn?: number }[] | null | undefined, steps?: RestoredTurn[] | null): void {
  $("#thread")!.innerHTML = "";
  if (msgs && msgs.length) {
    // P-RESUME.1 (ADR-0171): restored agent activity anchors under the user message that started its
    // turn. Groups whose anchor fell off a tail-limited page are skipped (matches the truncation note);
    // groups NEWER than every rendered user message (a turn that hasn't flushed to omp's transcript
    // yet) trail at the end rather than misattaching.
    const byTurn = new Map<number, RestoredTurn>();
    for (const g of steps ?? []) byTurn.set(g.turn, g);
    let maxUserTurn = 0;
    for (const m of msgs) {
      addMessage(m.role === "user" ? "user" : "assistant", m.text);
      if (m.role === "user" && m.turn) {
        maxUserTurn = Math.max(maxUserTurn, m.turn);
        const g = byTurn.get(m.turn);
        if (g) attachRestoredSteps(g);
      }
    }
    for (const g of steps ?? []) if (g.turn > maxUserTurn && maxUserTurn > 0) attachRestoredSteps(g);
  } else seedThread();
}
// P-PERF.4 (ADR-0131): resume loads only the transcript TAIL - matches the SWR cache cap, so the IPC
// payload and the DOM stay bounded no matter how long the chat grew. The full history stays on disk.
const RESUME_TAIL = 400;
async function resumeSession(id: string): Promise<void> {
  closeSettings();
  $$(".sess").forEach((s) => s.classList.toggle("active", (s as HTMLElement).dataset.sid === id));
  // P-PERF.1: paint the CACHED transcript instantly (no blank thread), then reconcile with the fresh load.
  const cached = cachedTranscript(id);
  let shownSig = "";
  if (cached && cached.length) { renderThread(cached); shownSig = transcriptSig(cached); }
  const page = await bridge.sessionMessages(id, RESUME_TAIL);
  if (page) {
    // P-RESUME.1: the cached paint never carries restored steps, so any steps force one re-render.
    const freshSig = transcriptSig(page.messages) + (page.steps?.length ? `+s${page.steps.length}` : "");
    if (freshSig !== shownSig) renderThread(page.messages, page.steps); // re-render only if it actually changed (no flicker)
    setCachedTranscript(id, page.messages, Date.now());
    if (page.total > page.messages.length) { // honest truncation hint - never silent
      const note = document.createElement("div");
      note.className = "thread-tail-note";
      note.textContent = `Showing the last ${page.messages.length} of ${page.total} messages`;
      $("#thread")?.prepend(note);
    }
  } else if (!shownSig) {
    renderThread(null); // no cache AND the fetch failed -> a fresh empty thread
  }
  await bridge.resumeSession(id);
  $("#input")?.focus();
}

/** Delete a session from history (with confirm). Backend closes the live session first if it's
 *  the one being deleted (so omp releases the file), then removes the .jsonl; the append-only
 *  audit trail is untouched. If the deleted session was the active one, reset to a fresh chat. */
function confirmDeleteSession(id: string): void {
  if (state.streaming) { showToast({ title: "Finish the current turn first", desc: "Stop or let the reply finish, then delete the session.", tone: "warn", actions: [{ label: "OK" }], timeout: 3000 }); return; }
  const row = $$(".sess").find((s) => (s as HTMLElement).dataset.sid === id) as HTMLElement | undefined;
  const wasActive = row?.classList.contains("active") ?? false;
  const title = row?.querySelector(".t")?.textContent?.trim() || "this session";
  showToast({
    title: "Delete session?",
    desc: `"${title}" will be removed from history. This can't be undone. (Audit/provenance records are kept.)`,
    tone: "warn",
    actions: [
      { label: "Delete", kind: "danger", run: async () => {
        const r = await bridge.deleteSession(id).catch(() => ({ ok: false, error: "request failed" }));
        if (!r?.ok) { showToast({ title: "Couldn't delete", desc: r?.error || "Try again in a moment.", tone: "danger", actions: [{ label: "OK" }], timeout: 4000 }); return; }
        if (wasActive) { seedThread(); state.liveUsage = null; renderStatus(); renderMetricsRail(); }
        await renderSessions();
        showToast({ title: "Session deleted", desc: "", timeout: 1600 });
      } },
      { label: "Cancel" },
    ],
    timeout: 8000,
  });
}

async function applyWorkspace(path: string): Promise<void> {
  // #11 perceived-latency: setWorkspace() respawns the backend (2–5s). Reassure the user
  // up front that work is happening, then confirm when it's ready, and reflect the switch
  // immediately on the workspace bar via a "loading…" pill.
  showToast({ title: "Switching workspace…", desc: "Restarting the agent in the new folder - ready in a moment.", timeout: 4000 });
  const bar = $("#wsBar") as HTMLButtonElement | null;
  if (bar) { bar.hidden = false; bar.innerHTML = `<span class="ws-bar-loading">${icon("refresh", 12, "spin")}switching…</span>`; }
  const info = await bridge.setWorkspace(path);
  if (info) { state.workspace = info; }
  renderWorkspaceBar();
  seedThread(); state.liveUsage = null; renderStatus(); renderMetricsRail();
  void renderSessions(); void renderSettings();
  showToast({ title: "Workspace set", desc: `Agent now works in ${info?.name ?? path}.`, actions: [{ label: "OK" }], timeout: 2600 });
}

function chips(items: { cls: string; n: number | string; l: string }[]): string {
  return `<div class="chips">${items.map((c) => `<div class="chip ${c.cls}"><div class="n">${esc(c.n)}</div><div class="l">${esc(c.l)}</div></div>`).join("")}</div>`;
}

function secIntro(): string {
  return `<div class="sec-intro">
    <div class="sec-intro-h"><span class="sec-pulse">${icon("shield", 17)}</span><b>Active protection</b>
      <button class="info-dot" id="secInfo" aria-label="How findings are stored">${icon("info", 13)}</button></div>
    <div class="sec-intro-d">Every tool call the agent makes - shell commands, file writes, and any fetched or imported text - is scanned for hidden-Unicode prompt injection (zero-width characters, look-alike homoglyphs, bidi tricks) <b>before it runs</b>. Anything quarantined is blocked fail-closed, and content from suspicious sources can't quietly promote itself into memory.</div>
  </div>`;
}
function securityHtml(d: SecuritySnapshot | null): string {
  // The /api/security response always carries `live` (GUI-owned gate blocks), but the DuckDB
  // arrays may be absent on a fresh machine - guard every one.
  const quarantine = d?.quarantine ?? [], approvals = d?.approvals ?? [], findings = d?.findings ?? [];
  const promotion = d?.promotion ?? [], exports = d?.exports ?? [], runs = d?.runs ?? [];
  const live = d?.live ?? { quarantined: [], approved: [], dismissed: [], total: 0 };
  const totFind = findings.reduce((a, r) => a + Number(r.n || 0), 0);
  const promoted = Number((promotion.find((r) => r.outcome === "promoted") || {}).n || 0);
  const blocked = Number((promotion.find((r) => r.outcome === "blocked") || {}).n || 0);
  // P-SECACK.1 (ADR-0170): rows a human already reviewed leave the ACTIVE view and the counters.
  // GUI-owned ack ledger only - the provenance DB is untouched and nothing is ever released.
  const acks = d?.acks?.artifacts ?? {};
  const q = splitReviewed(quarantine, acks);
  const ap = splitReviewed(approvals, acks);
  const fresh = freshFindings(totFind, d?.acks?.findingsSeen);
  let h = secIntro();
  // ADR-0021: pulse the metric chip that requires triage - quarantined gets red shimmer,
  // awaiting-review gets amber shimmer, only when there are active items in that category.
  const qCount = q.active.length + live.quarantined.length;
  const aCount = ap.active.length;
  h += chips([
    { cls: "q" + (qCount > 0 ? " alert" : ""), n: qCount, l: "quarantined" },
    { cls: "a" + (aCount > 0 ? " alert alert-amber" : ""), n: aCount, l: "awaiting review" },
    { cls: "f", n: fresh, l: fresh === totFind ? "findings" : "new findings" },
    { cls: "g", n: promoted, l: "promoted facts" },
  ]);
  // P-SANDBOX.5 (ADR-0169): the live runtime-execution boundary for THIS session (bwrap / Seatbelt /
  // disclosed passthrough / fail-closed blocked) + the subprocess reach-outs the mediated proxy refused.
  // Placed up top and auto-opened when NOT isolated, so the posture is the first thing a reviewer sees.
  h += renderSandboxSection(d?.sandbox, OPEN.has("sec.sandbox"));
  // Live blocks (this session) - what the gate actually stopped in THIS GUI, with the audited
  // "Approve & retry" override. Sits up top so the toast "Review" lands on something actionable.
  if (live.quarantined.length || live.approved.length || live.dismissed.length) {
    const rows = live.quarantined.length
      ? live.quarantined.map((b) => `<div class="liveblk">
          <div class="lb-head"><span class="pill quarantined">${esc(b.severity)}</span><b>${esc(b.tool)}</b><span class="lb-reason">${esc(b.reason)}</span></div>
          <div class="lb-foot"><span class="lb-meta">${esc(b.findings || "no detail")} · ${esc(relTime(Date.parse(b.at)))}</span>
            <button class="btn-mini ok" data-approve="${esc(b.id)}" data-tip="Approve &amp; retry|Release this one blocked call (audited) and re-send your last message so the agent can try again. Use only if you're sure it was a false positive.">${icon("check", 13)} Approve &amp; retry</button>
            <button class="btn-mini dismiss" data-dismiss="${esc(b.id)}" data-tip="Dismiss|Acknowledge this block and move it to the Dismissed section. The call STAYS blocked - this only clears it from the active queue. The audit record is kept.">${icon("close", 13)} Dismiss</button></div>
        </div>`).join("")
      : `<div class="empty">No active blocks - everything released, dismissed, or clean.</div>`;
    const approvedNote = live.approved.length ? `<div class="lb-approved">${icon("check", 12)} ${live.approved.length} released this session · audited</div>` : "";
    // Dismissed: reviewed + acknowledged, STILL blocked. Muted + collapsed, out of the active count.
    const dismissedNote = live.dismissed.length
      ? `<details class="lb-dismissed"><summary>${live.dismissed.length} dismissed · still blocked · audited</summary>`
        + live.dismissed.map((b) => `<div class="liveblk muted">
            <div class="lb-head"><span class="pill dismissed">${esc(b.severity)}</span><b>${esc(b.tool)}</b><span class="lb-reason">${esc(b.reason)}</span></div>
            <div class="lb-foot"><span class="lb-meta">${esc(b.findings || "no detail")} · ${esc(relTime(Date.parse(b.at)))}</span>
              <button class="btn-mini ok" data-approve="${esc(b.id)}" data-tip="Approve &amp; retry|Release this blocked call (audited) and re-send your last message. Use only if you now trust the source.">${icon("check", 13)} Approve &amp; retry</button></div>
          </div>`).join("")
        + `</details>`
      : "";
    h += accordion("sec.live", "Live blocks", "this session · gate-enforced", rows + approvedNote + dismissedNote, true, String(live.quarantined.length));
  }
  if (!d && !live.total) { h += `<div class="empty">Nothing has tripped the scanner yet. The moment a tool call carries hidden-Unicode or another injection, the finding, the quarantine queue, and the audit trail appear right here.</div>`; return h; }
  // P-SECACK.1: shared by the Quarantine-review + Approval-queue sections so their ack affordances
  // stay lockstep - per-row "Reviewed", a bulk "Mark all reviewed", and a muted shelf holding the
  // already-reviewed rows (audit visible on demand, out of the counters). The only row-derived value
  // interpolated is artifact_id, esc()'d - the action cell adds no injection surface.
  const ackSection = (cols: Col[], split: { active: Record<string, unknown>[]; reviewed: Record<string, unknown>[] }, kind: string): string => {
    const ackBtn = (r: Record<string, unknown>) => `<button class="btn-mini dismiss" data-ack="${esc(String(r.artifact_id ?? ""))}" data-tip="Mark reviewed|Removes this row from the active queue and the counters. Nothing is released - the artifact stays isolated in the provenance DB and every audit record is kept.">${icon("check", 12)} Reviewed</button>`;
    let out = table(cols, split.active, ackBtn);
    if (split.active.length > 1) out += `<div class="row-actions"><button class="btn-mini" data-ack-all="${kind}">${icon("check", 13)} Mark all ${split.active.length} reviewed</button></div>`;
    if (split.reviewed.length) out += `<details class="sec-reviewed"><summary>${split.reviewed.length} reviewed \u00b7 still isolated \u00b7 audit kept</summary>${table(cols, split.reviewed)}</details>`;
    return out;
  };
  const qCols: Col[] = [{ key: "artifact_id", label: "artifact", mono: true }, { key: "source", label: "source" }, { key: "trust_label", label: "trust", pill: true }, { key: "risk_score", label: "risk", mono: true }];
  h += accordion("sec.quarantine", "Quarantine review", "isolated \u00b7 fail-closed",
    ackSection(qCols, q, "quarantine"),
    OPEN.has("sec.quarantine"), String(q.active.length));
  const apCols: Col[] = [{ key: "artifact_id", label: "artifact", mono: true }, { key: "source", label: "source" }, { key: "trust_label", label: "trust", pill: true }, { key: "verdict", label: "verdict", pill: true }];
  h += accordion("sec.approvals", "Approval queue", "blocked \u00b7 awaiting a human",
    ackSection(apCols, ap, "approvals"),
    OPEN.has("sec.approvals"), String(ap.active.length));
  h += accordion("sec.findings", "Findings overview", "by type \u00b7 severity \u00b7 source",
    (fresh > 0 ? `<div class="row-actions"><button class="btn-mini" data-ack-findings data-tip="Mark findings seen|Resets the chip to count only NEW findings from here on. The full history stays in this table and in the provenance DB.">${icon("eye", 13)} Mark ${fresh === totFind ? "all" : String(fresh)} seen</button></div>` : "")
    + table([{ key: "finding_type", label: "type" }, { key: "severity", label: "sev", pill: true }, { key: "source", label: "source" }, { key: "n", label: "n", mono: true }], findings),
    OPEN.has("sec.findings"), fresh > 0 && fresh !== totFind ? `${totFind} \u00b7 ${fresh} new` : String(totFind));
  h += accordion("sec.gate", "Memory-promotion gate", "untrusted content can't auto-save",
    gauge("blocked", blocked + promoted ? blocked / (blocked + promoted) : 0, `<b>${blocked}</b>&nbsp;blocked / ${promoted} ok`),
    OPEN.has("sec.gate"));
  h += accordion("sec.exports", "Export audit", "what left, sanitized",
    table([{ key: "export_type", label: "type" }, { key: "sanitization_status", label: "sanitized" }, { key: "reviewer", label: "by" }], exports),
    OPEN.has("sec.exports"));
  h += accordion("sec.runs", "Active runs", "provenance lineage",
    table([{ key: "kind", label: "kind" }, { key: "mode", label: "mode" }, { key: "sandbox_profile", label: "sandbox" }, { key: "status", label: "status" }], runs),
    OPEN.has("sec.runs"));
  return h;
}

// ── ADR-0009 Phase D: developer Logs view (read-only; metadata only) ──────────────
// Format an ISO/epoch timestamp as US Eastern time (auto EST/EDT) - "Jun 24, 3:45 PM EDT".
function estTime(ts: string | number | undefined | null): string {
  if (ts === undefined || ts === null || ts === "") return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  try {
    return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
  } catch { return d.toISOString(); }
}
function devHtml(d: import("./bridge.ts").DevView | null): string {
  let h = `<div class="sec-intro"><div class="sec-intro-h"><span class="sec-pulse">${icon("logs", 17)}</span><b>Developer logs</b></div>
    <div class="sec-intro-d">Read-only telemetry, run lineage, transcripts, and audit trails from this machine - sanitized, no raw prompt or file content (the raw is referenced by sha only). Newest first; times in US Eastern.</div></div>`;
  if (!d || !d.enabled) { h += `<div class="empty">Developer mode is off. Turn it on in <b>Settings → Developer mode</b> to see the telemetry stream, run lineage, transcripts, and the audit trail.</div>`; return h; }
  const tel = d.snapshot?.telemetry ?? [], runs = d.snapshot?.runs ?? [], exp = d.snapshot?.exports ?? [], blk = d.blocks?.quarantined ?? [], turns = d.turns ?? [];
  const ask = d.asksage ?? [];
  const askAnoms = ask.filter((r) => r.anomaly || r.ok === false).length;
  const gate = d.gate ?? []; // P-GATE-DIAG.1
  const gateBlocks = gate.filter((r) => String(r.decision ?? "").startsWith("block")).length;
  h += chips([
    { cls: "f", n: tel.length, l: "events" },
    { cls: "g", n: runs.length, l: "runs" },
    { cls: "g", n: turns.length, l: "turns" },
    { cls: "q", n: blk.length, l: "live blocks" },
    { cls: "a", n: exp.length, l: "exports" },
    ...(ask.length ? [{ cls: askAnoms ? "q" : "g", n: ask.length, l: "AskSage calls" } as const] : []),
    ...(gate.length ? [{ cls: gateBlocks ? "q" : "g", n: gate.length, l: "gate decisions" } as const] : []),
    ...(d.netdiag ? [{ cls: d.netdiag.events.some((e) => e.candidate) ? "q" : "f", n: d.netdiag.events.length, l: "net events" } as const] : []),
  ]);
  // P-ASKSAGE.1 (ADR-0059): AskSage tool-loop diagnostics. One row per non-streamed call. An `anomaly`
  // (empty-response / truncated) or an error is the smoking gun for the loop "giving up too soon".
  const askRows = ask.slice().reverse().map((r) => ({
    when: estTime(r.at as number),
    route: String(r.route ?? ""),
    model: String(r.model ?? "").replace(/^.*\//, ""),
    via: String(r.via ?? (r.ok === false ? "-" : "")),
    text: r.textLen ?? "",
    calls: Array.isArray(r.toolCalls) ? (r.toolCalls as string[]).join(", ") : "",
    stop: String(r.stopReason ?? ""),
    finish: String(r.finish ?? ""),
    flag: r.anomaly ? `⚠ ${r.anomaly}` : r.ok === false ? `✕ ${String(r.error ?? "error").slice(0, 60)}` : "ok",
  }));
  h += accordion("dev.asksage", "AskSage tool calls", "non-streamed loop · developer diagnostics",
    table([{ key: "when", label: "when", mono: true }, { key: "route", label: "route" }, { key: "model", label: "model", mono: true }, { key: "via", label: "parsed via", mono: true }, { key: "text", label: "txt", mono: true }, { key: "calls", label: "tool calls" }, { key: "stop", label: "loop", mono: true }, { key: "finish", label: "raw", mono: true }, { key: "flag", label: "flag", pill: true }], askRows as unknown as Record<string, unknown>[]),
    OPEN.has("dev.asksage") || askAnoms > 0, askAnoms ? `${ask.length} · ${askAnoms}⚠` : String(ask.length));
  // P-GATE-DIAG.1 (ADR-0066/0062): exec/egress gate decisions — WHY each was allowed/prompted/auto-denied.
  // A "block(no-ui)" row with askActive=NO or listener=NO is the smoking gun for "I never got a prompt".
  const gateRows = gate.slice().reverse().map((r) => ({
    when: estTime(r.at as number),
    kind: String(r.kind ?? ""),
    tool: String(r.tool ?? "").slice(0, 28),
    target: String(r.target ?? "").slice(0, 38),
    ask: r.askActive ? "yes" : "NO",
    listener: r.listener ? "yes" : "NO",
    loop: r.goalActive ? "goal" : r.autoRunning ? "auto" : "-",
    decision: String(r.decision ?? ""),
  }));
  h += accordion("dev.gate", "Exec / egress gate decisions", "why a tool was prompted vs auto-denied",
    table([{ key: "when", label: "when", mono: true }, { key: "kind", label: "kind" }, { key: "tool", label: "tool", mono: true }, { key: "target", label: "target", mono: true }, { key: "ask", label: "askActive", mono: true }, { key: "listener", label: "listener", mono: true }, { key: "loop", label: "loop", mono: true }, { key: "decision", label: "decision", pill: true }], gateRows as unknown as Record<string, unknown>[]),
    OPEN.has("dev.gate") || gateBlocks > 0, gateBlocks ? `${gate.length} · ${gateBlocks}⛔` : String(gate.length));
  h += accordion("dev.telemetry", "Telemetry stream", "recent · metadata only",
    table([{ key: "event", label: "event" }, { key: "run_id", label: "run", mono: true }, { key: "session_id", label: "session", mono: true }, { key: "created_at", label: "at", mono: true }], tel),
    true, String(tel.length));
  // Newest first (reverse the append-ordered log) so the latest turn is at the top, with an Eastern-time stamp.
  const turnRows = turns.slice().reverse().map((t) => ({ when: estTime(t.at), seq: t.seq, role: t.role, trust: t.trust, sanitized: t.sanitized, sha: String(t.rawSha256).slice(0, 12) }));
  h += accordion("dev.turns", "Turn transcripts", "newest first · sanitized · raw by sha",
    table([{ key: "when", label: "when", mono: true }, { key: "seq", label: "#", mono: true }, { key: "role", label: "role", pill: true }, { key: "trust", label: "trust", mono: true }, { key: "sanitized", label: "text" }, { key: "sha", label: "raw sha", mono: true }], turnRows as unknown as Record<string, unknown>[]),
    OPEN.has("dev.turns"), String(turns.length));
  h += accordion("dev.runs", "Run lineage", "provenance",
    table([{ key: "run_id", label: "run", mono: true }, { key: "kind", label: "kind" }, { key: "mode", label: "mode" }, { key: "sandbox_profile", label: "sandbox" }, { key: "status", label: "status" }], runs),
    OPEN.has("dev.runs"), String(runs.length));
  h += accordion("dev.blocks", "Gate block audit", "this session",
    table([{ key: "tool", label: "tool" }, { key: "severity", label: "sev", mono: true }, { key: "reason", label: "reason" }, { key: "status", label: "status", pill: true }], blk as unknown as Record<string, unknown>[]),
    OPEN.has("dev.blocks"), String(blk.length));
  h += accordion("dev.exports", "Export audit", "what left, sanitized",
    table([{ key: "export_type", label: "type" }, { key: "sanitization_status", label: "sanitized" }, { key: "reviewer", label: "by" }], exp),
    OPEN.has("dev.exports"));
  // P-ENT.2 (ADR-0069): the unified SIEM-ready security-event stream + per-sink delivery status.
  const au = d.audit;
  if (au) {
    const sinkLine = au.sinks.map((s) => `${esc(s.name)} <b style="color:${s.failed ? "var(--red)" : "var(--green)"}">${s.delivered}✓${s.failed ? ` ${s.failed}✕` : ""}</b>`).join(" · ");
    const evRows = au.events.map((e) => ({
      when: estTime(Date.parse(e.ts)), category: e.category, type: e.type,
      decision: e.decision, sev: e.severity, tier: e.tier ?? "", tool: e.tool ?? "", reason: (e.reason ?? "").slice(0, 80),
    }));
    h += accordion("dev.audit", "Security event export (SIEM)", "OCSF-aligned · metadata only · file sink",
      `<div class="kvs"><span class="kv">sinks ${sinkLine || "<b>none</b>"}</span><span class="kv">events <b>${au.events.length}</b></span></div>`
      + table([{ key: "when", label: "when", mono: true }, { key: "category", label: "source", pill: true }, { key: "decision", label: "decision", pill: true }, { key: "sev", label: "sev", mono: true }, { key: "tier", label: "tier", mono: true }, { key: "tool", label: "tool", mono: true }, { key: "reason", label: "reason" }], evRows as unknown as Record<string, unknown>[]),
      OPEN.has("dev.audit"), String(au.events.length));
  }
  // P-NETDIAG.1: the loopback / OAuth-callback watcher. A new LISTENING socket on the callback port
  // (★ / "callback?") the instant you click "Connect via OAuth" is the prime evidence the broker bound;
  // its absence the whole flow means the broker never bound (it died before listening).
  // SORT: OAuth-relevant events (port 1455, candidates, probes) surface at the top, newest-first,
  // with a visual break before the rest — so the user never has to dig through irrelevant sockets.
  const nd = d.netdiag;
  if (nd) {
    const probeLine = nd.probes.map((p) => `:${p.port}=${p.state}`).join("  ") || "-";
    const cand = nd.events.filter((e) => e.candidate).length;
    // Listeners: watched (★) ports pinned to top, then by port number.
    const sortedLis = nd.listeners.slice().sort((a, b) => {
      const aw = nd.ports.includes(a.port) ? 0 : 1;
      const bw = nd.ports.includes(b.port) ? 0 : 1;
      return aw !== bw ? aw - bw : a.port - b.port;
    });
    const lisRows = sortedLis.map((s) => {
      const watched = nd.ports.includes(s.port);
      return { _cls: watched ? "nd-oauth" : "", watch: watched ? "★" : "", port: s.port, addr: s.local, proc: s.proc };
    });
    // Events: split into OAuth-relevant (callback ports, candidates, probes) vs. the rest.
    const isOauth = (e: { port?: number; candidate?: boolean; kind: string }) =>
      e.candidate || e.kind === "probe" || (e.port != null && nd.ports.includes(e.port));
    const allEvReversed = nd.events.slice().reverse();
    const oauthEv = allEvReversed.filter(isOauth);
    const otherEv = allEvReversed.filter((e) => !isOauth(e));
    const mapEv = (e: typeof nd.events[number], highlight: boolean) => ({
      _cls: highlight ? "nd-oauth" : "",
      when: estTime(e.at), kind: e.kind, detail: e.text, proc: e.proc ?? "", flag: e.candidate ? "callback?" : "",
    });
    const evCols: Col[] = [{ key: "when", label: "when", mono: true }, { key: "kind", label: "event", pill: true }, { key: "detail", label: "socket", mono: true }, { key: "proc", label: "process" }, { key: "flag", label: "flag", pill: true }];
    const oauthRows = oauthEv.map((e) => mapEv(e, true));
    const otherRows = otherEv.map((e) => mapEv(e, false));
    const body =
      `<div class="kvs"><span class="kv">capture <b style="color:${nd.watching ? "var(--green)" : "var(--red)"}">${nd.watching ? "live" : "off"}</b></span>`
      + `<span class="kv">callback probe <b>${esc(probeLine)}</b></span>`
      + `<span class="kv">listeners <b>${nd.listeners.length}</b></span>`
      + `<span class="kv">events <b>${nd.events.length}</b></span></div>`
      + (nd.supported ? "" : `<div class="empty">Live capture isn't wired for ${esc(nd.platform)} yet.</div>`)
      + `<div class="dev-subh">Listening sockets <span>loopback + all-interface · ★ = watched OAuth callback port</span></div>`
      + table([{ key: "watch", label: "", mono: true }, { key: "port", label: "port", mono: true }, { key: "addr", label: "local address", mono: true }, { key: "proc", label: "process" }], lisRows as unknown as Record<string, unknown>[])
      // OAuth-relevant events: pinned at top, highlighted, newest first.
      + `<div class="dev-subh nd-oauth-hdr">🔑 OAuth / port ${nd.ports.join(", :")} events <span>newest first · candidates, probes, and callback-port traffic</span></div>`
      + (oauthRows.length ? table(evCols, oauthRows as unknown as Record<string, unknown>[]) : `<div class="empty">no OAuth-relevant events yet - click "Connect via OAuth" to start</div>`)
      // Separator + the rest.
      + (otherRows.length ? `<div class="dev-subh">Other network activity <span>${otherRows.length} events · loopback traffic unrelated to the callback port</span></div>` + table(evCols, otherRows as unknown as Record<string, unknown>[]) : "")
      // P-NETWL.4 (ADR-0106): each DNS pill is clickable → a quick-add popover to whitelist that host.
      + (nd.dns.length ? `<div class="dev-subh">DNS resolutions <span>recent resolver-cache entries · click to whitelist</span></div><div class="kvs">${nd.dns.slice().reverse().slice(0, 30).map((n) => `<span class="kv mono kv-dns" data-dns-add="${esc(n)}" data-tip="Add to whitelist|Pre-authorize ${esc(n)} for the agent's network calls (choose scope + budget).">${esc(n)} ${icon("plus", 10)}</span>`).join("")}</div>` : "");
    h += accordion("dev.netdiag", "Network diagnostics", "OAuth localhost callback · live capture", body, OPEN.has("dev.netdiag") || cand > 0, cand ? `${nd.events.length} · ${cand}?` : String(nd.events.length));
  }
  return h;
}
async function loadDev(): Promise<void> {
  state.dev = await bridge.dev();
  state.developerMode = state.dev?.enabled ?? false;
  const btn = $("#railLogs"); if (btn) (btn as HTMLElement).hidden = !state.developerMode;
  if (state.inspectorTab === "dev") { lastInspHash = ""; renderInspector(); }
}

function memoryHtml(d: MemorySnapshot | null): string {
  let h = "";
  // P10.2 + ADR-0021: the cross-model cost & savings ledger sits on top (it spans ALL sessions,
  // so it shows even when the current workspace has no live omp transcript).
  // ADR-0021 restructure: the snapshot card + the first (highest-spend) model row are always
  // visible outside the accordion; only the remaining models are inside the chevron.
  const led = state.ledger;
  if (led && led.models.length) {
    const { peek, rest } = ledgerSplit(led);
    h += `<div class="ledger-peek">${peek}</div>`;
    if (rest) h += accordion("mem.ledger", "Cost & savings ledger", `${led.models.length - 1} more models`, rest, OPEN.has("mem.ledger"), `${led.models.length - 1}`);
  }
  // P-LOC.2 (ADR-0031): the AI-authored code counterpart to the cost ledger - lines the AI wrote,
  // per model/repo, attributed to the identity. Counted at the gate (ADR-0031), not git (ADR-0030).
  // P-LOC.3 (ADR-0095): ALWAYS render this section when a session is active (with an explicit empty
  // state when the ledger is empty or momentarily unreadable) so it is discoverable - a command-palette
  // target - and never silently vanishes (the "where did the AI-LOC go?" report).
  if (d) {
    if (aiLocHasData(d.aiLoc)) {
      h += accordion("mem.ailoc", "AI-authored code", `+${fmtNum(d.aiLoc!.totals.added)} / −${fmtNum(d.aiLoc!.totals.removed)} lines`, aiLocBody(d.aiLoc!), OPEN.has("mem.ailoc"), `${d.aiLoc!.totals.models}`);
    } else {
      h += accordion("mem.ailoc", "AI-authored code", "none yet", `<div class="empty">No AI-authored lines recorded yet - they'll appear here, per model and repo, as the agent edits files through the gate.</div>`, OPEN.has("mem.ailoc"));
    }
  }
  if (!d) return h || `<div class="empty">No omp session yet - launch omp and send a message.</div>`;
  const s = d.session;
  if (s) {
    h += accordion("mem.context", "Context window", `${s.model} · ${s.turns} turns`,
      gauge("current", s.current / s.window, `${fmtNum(s.current)} / ${fmtNum(s.window)}`)
      + gauge("peak", s.peak / s.window, `${fmtNum(s.peak)} / ${fmtNum(s.window)}`)
      + spark(s.prompts) + `<div class="kv" style="margin-top:6px;border:0;background:transparent;padding-left:0">prompt tokens per turn</div>`,
      OPEN.has("mem.context"));
    h += accordion("mem.cache", "Prompt-cache savings", "more reuse = lower token cost",
      gauge("cached input", s.cache.hit, "", true)
      + `<div class="kvs"><span class="kv" data-tip="Input tokens served from cache, billed at ~10% of full price">cached <b>${fmtNum(s.cache.read)}</b></span><span class="kv" data-tip="New tokens written into the cache (full price once, then reused)">cache-build <b>${fmtNum(s.cache.write)}</b></span><span class="kv" data-tip="Uncached input, billed at full price">full-price <b>${fmtNum(s.cache.fresh)}</b></span><span class="kv">spend <b>${fmtUSD(s.cost)}</b></span></div>`,
      OPEN.has("mem.cache"));
  } else if (!h) {
    h += `<div class="empty">No omp session transcript yet - launch omp and send a message.</div>`;
  }
  if (d.compaction) {
    h += accordion("mem.compaction", "Compaction policy", "keeps context bounded",
      table([{ key: "setting", label: "setting" }, { key: "value", label: "value", mono: true }], Object.entries(d.compaction).map(([setting, value]) => ({ setting, value }))),
      OPEN.has("mem.compaction"));
  }
  if (d.budgets?.length) {
    h += accordion("mem.budget", "Provider budget", "usage for your current model",
      budgetBody(d.budgets), OPEN.has("mem.budget"), `${d.budgets.length}`);
  }
  if (d.harness) {
    const hm = d.harness;
    h += accordion("mem.layers", "Memory layers", "working · archive · semantic",
      table([{ key: "layer", label: "layer" }, { key: "rows", label: "rows", mono: true }, { key: "detail", label: "detail" }], hm.layers)
      + `<div class="kvs"><span class="kv">promoted <b style="color:var(--green)">${hm.gate.promoted}</b></span><span class="kv">blocked <b style="color:var(--red)">${hm.gate.blocked}</b></span></div>`
      + (hm.facts.length ? table([{ key: "entity", label: "entity" }, { key: "statement", label: "statement" }, { key: "trust_label", label: "trust", pill: true }], hm.facts) : ""),
      OPEN.has("mem.layers"));
  } else {
    h += `<div class="empty">No harness memory yet - appears once the gate runs, or run <code>bun run demo-P4.3</code>.</div>`;
  }
  return h;
}

// P-LOC.2 (ADR-0031): AI-authored code body - a summary card + a per-model table + a per-repo/
// identity breakdown. Lines are counted at the security gate from omp's own applied diff (ADR-0031),
// so this is honest "the AI wrote these lines" attribution, distinct from git's total repo churn.
function aiLocBody(a: import("./bridge.ts").AiLocSummary): string {
  const t = a.totals;
  const idLine = a.identities.length === 1
    ? `attributed to <b>${esc(a.identities[0]!)}</b>`
    : `${a.identities.length} contributors`;
  const summary = `<div class="kvs">
    <span class="kv" data-tip="Lines the AI authored (across all recorded edits)">added <b style="color:var(--green)">+${fmtNum(t.added)}</b></span>
    <span class="kv" data-tip="Lines the AI removed">removed <b style="color:var(--red)">−${fmtNum(t.removed)}</b></span>
    <span class="kv">edits <b>${fmtNum(t.edits)}</b></span>
    <span class="kv">${t.models} model${t.models === 1 ? "" : "s"} · ${t.repos} repo${t.repos === 1 ? "" : "s"}</span></div>
    <div class="ailoc-attr" data-tip="The attribution identity (corporate email, or the workstation-name fallback). ADR-0030/0031.">${icon("user", 12)} ${idLine}</div>`;
  const num = (n: number, color: string, sign: string) => `<td class="num" style="color:var(${color});text-align:right">${sign}${fmtNum(n)}</td>`;
  const modelTbl = `<table class="tbl ailoc-tbl"><thead><tr><th>model</th><th style="text-align:right">added</th><th style="text-align:right">removed</th><th style="text-align:right">edits</th></tr></thead><tbody>${
    a.byModel.map((m) => `<tr><td>${esc(modelLabel(m.model))}</td>${num(m.added, "--green", "+")}${num(m.removed, "--red", "−")}<td class="num" style="text-align:right">${fmtNum(m.edits)}</td></tr>`).join("")
  }</tbody></table>`;
  const repoTbl = a.rows.length ? `<div class="kv" style="margin:8px 0 4px;border:0;background:transparent;padding-left:0">by repo · identity</div>
    <table class="tbl ailoc-tbl"><thead><tr><th>repo</th><th>model</th><th>who</th><th style="text-align:right">+/−</th></tr></thead><tbody>${
    a.rows.slice(0, 12).map((r) => {
      const base = r.repo.split(/[\\/]/).filter(Boolean).pop() || r.repo;
      const who = r.identitySource === "workstation" ? `${esc(r.identity)} ⌂` : esc(r.identity);
      return `<tr><td title="${esc(r.repo)}">${esc(base)}</td><td>${esc(modelLabel(r.model))}</td><td title="${r.identitySource === "workstation" ? "workstation fallback" : "corporate email"}">${who}</td><td class="num" style="text-align:right"><span style="color:var(--green)">+${fmtNum(r.added)}</span> <span style="color:var(--red)">−${fmtNum(r.removed)}</span></td></tr>`;
    }).join("")
  }</tbody></table>` : "";
  return summary + modelTbl + repoTbl;
}

// P10.2: the cross-model cost & savings ledger body - a summary card + a per-model table
// (sorted by spend, so the top rows are where the tokens go). Savings is estimated from the
// data (cache reads billed at ~10% of input → est. savings = cost.cacheRead × 9).
function ledgerBody(led: import("./bridge.ts").UsageLedger): string {
  const { peek, rest } = ledgerSplit(led);
  return peek + (rest ?? "");
}
// ADR-0030 P-CODE.1: one ledger-card row for this month's git workspace activity.
// Honest label - this is REPO activity (all commits), NOT AI authorship (AGENTS.md #10).
function codeActivityRow(): string {
  const ca = state.codeActivity;
  if (!ca || ca.totals.files === 0) return ""; // fail-closed: no live git data → render nothing
  const { added, deleted, files } = ca.totals;
  return `<div class="lc-row"><span class="lc-k">workspace activity · ${esc(ca.month)}</span>`
    + `<b class="lc-loc"><span class="loc-add">+${fmtNum(added)}</span> / <span class="loc-del">-${fmtNum(deleted)}</span>`
    + ` <span class="lc-pct">${fmtNum(files)} file${files === 1 ? "" : "s"}</span></b></div>`;
}
// ADR-0021: split the ledger into a "peek" (always visible: snapshot card + first model row)
// and "rest" (the remaining model rows, rendered inside an accordion by the caller).
function ledgerSplit(led: import("./bridge.ts").UsageLedger): { peek: string; rest: string | null } {
  const t = led.totals;
  const savedPct = t.cost + t.savings > 0 ? t.savings / (t.cost + t.savings) : 0;
  const local = led.bySource.local;
  const card = `<div class="ledger-card">
    <div class="lc-row"><span class="lc-k">spend · all models</span><b>${fmtUSD(t.cost)}</b></div>
    <div class="lc-row ok"><span class="lc-k">est. cache savings</span><b>${fmtUSD(t.savings)} <span class="lc-pct">${Math.round(savedPct * 100)}% off full price</span></b></div>
    <div class="lc-row"><span class="lc-k">cache hit-rate</span><b style="color:${goodColor(t.cacheHitRate)}">${Math.round(t.cacheHitRate * 100)}%</b></div>
    ${codeActivityRow()}
    <div class="lc-foot">${fmtNum(t.tokens)} tokens · ${t.turns} turns · ${led.models.length} models · ${t.sessions} sessions${local.cost > 0 ? ` · <span class="lc-local">local ${fmtUSD(local.cost)}</span>` : " · all provider/subscription"}</div>
    ${led.truncated ? `<div class="lc-foot warn">${icon("info", 11)} showing the ${led.files} most recent sessions</div>` : ""}
  </div>`;
  const cols = [
    { key: "model", label: "model" }, { key: "turns", label: "turns", mono: true }, { key: "tokens", label: "tokens", mono: true },
    { key: "cost", label: "cost", mono: true }, { key: "saved", label: "saved", mono: true }, { key: "cache", label: "cache", mono: true },
  ] as const;
  const toRow = (m: typeof led.models[number]) => ({
    model: cleanModelName(prettyModel(m.model)),
    turns: String(m.turns),
    tokens: fmtNum(m.tokens.total),
    cost: fmtUSD(m.cost.total),
    saved: m.savings > 0 ? fmtUSD(m.savings) : "-",
    cache: `${Math.round(m.cacheHitRate * 100)}%`,
  });
  // Peek: snapshot card + just the first (highest-spend) model
  const firstRow = led.models.length ? [toRow(led.models[0])] : [];
  const peek = card + table([...cols], firstRow);
  // Rest: remaining models (index 1+), or null if there's only one
  if (led.models.length <= 1) return { peek, rest: null };
  const restRows = led.models.slice(1).map(toRow);
  return { peek, rest: table([...cols], restRows) };
}

// `providerKeywords` (which budget/auth governs the active model) + the OAuth-vs-key budget-pill gate
// live in the pure, unit-tested `budget_gate.ts`. This just binds the gate to the live state.
function currentProviderHasApiKey(): boolean {
  return providerHasApiKey(state.auth, state.model);
}
function budgetBody(budgets: NonNullable<MemorySnapshot["budgets"]>): string {
  const kws = providerKeywords(state.model);
  const active = (label: string) => kws.some((k) => label.toLowerCase().includes(k));
  const rows = budgets.map((b) => {
    const on = active(b.label);
    return `<div class="bgt${on ? " on" : ""}">${on ? `<span class="bgt-tag" data-tip="Provider for your current model">current model</span>` : ""}${
      gauge(b.label.replace(/^Claude /, ""), b.used, `<span style="color:var(--txt-4)">${esc(b.status)} · resets ${ageStr(b.resetsAt)}</span>`)}</div>`;
  }).join("");
  // P10.3: live API-key rate-limit probes (opt-in) render as extra gauges, tagged so they're
  // distinct from omp's subscription/OAuth windows above.
  const probed = state.probedLimits.map((b) =>
    `<div class="bgt${active(b.label) ? " on" : ""}"><span class="bgt-tag live" data-tip="Live from the provider's rate-limit headers (API key)">API key · live</span>${
      gauge(b.label, b.used, `<span style="color:var(--txt-4)">${fmtNum(b.remaining)} left · resets ${ageStr(b.resetsAt)}</span>`)}</div>`).join("");
  const probeToggle = `<label class="set-toggle bgt-probe"><input type="checkbox" id="ratelimitToggle" ${state.probeEnabled ? "checked" : ""}/>
    <span>Live API-key probe ${state.probeEnabled ? "" : ""}<button class="info-dot" data-tip="Live rate-limit probe|For providers set with an API KEY (Anthropic / OpenAI), read the real remaining limit from response headers. Off by default - each check makes one tiny request (a token or two). Your OAuth 5-hour window is already shown above and has no header to probe.">${icon("info", 11)}</button></span></label>`;
  return `<div class="bgt-head">
      <button class="btn-mini" data-budget-refresh data-tip="Re-check provider usage now">${icon("refresh", 13)} Refresh</button>
      <span class="bgt-note">auto every 5 min</span>
    </div>${rows}${probed}${probeToggle}`;
}

const RICHTIP_DUCKDB = `<div class="rt-h">${icon("shield", 14)} Where this is stored</div>
  <div class="rt-d">Scans, findings, approvals, and the export audit live in a local embedded <b>DuckDB</b> column store on your machine - fast analytics, and nothing leaves the device. The panels here are read-only views over it.</div>
  <a class="rt-link" href="https://duckdb.org" target="_blank" rel="noopener noreferrer">duckdb.org ${icon("expand", 12)}</a>`;

// AskSage gov-gateway monthly-usage chip (only when a key is configured).
function asksageChip(): string {
  const a = state.asksage, t = state.asksageTokens;
  if (!a?.configured) return "";
  const pct = t && t.limit > 0 ? t.used / t.limit : 0;
  const lock = a.only ? ` <span class="lock-tag" data-tip="AskSage-only lockdown is ON|Every turn routes through the accredited gov gateway">🔒</span>` : "";
  return `<div class="seg seg-btn" data-asksage-refresh data-tip="AskSage gov usage|Monthly tokens used vs. limit - click to re-check (auto every 5 min)">${icon("shield", 12)} Gov${lock} <b style="color:${loadColor(pct)}">${t ? Math.round(pct * 100) + "%" : "-"}</b> ${icon("refresh", 11)}</div>`;
}

// ───────────────────────── status bar ─────────────────────────
function renderStatus(): void {
  const m = state.memory, s = m?.session;
  const lu = state.liveUsage;
  const curTok = lu ? lu.used : (s?.current ?? 0);
  // Prefer the selected model's real context window over omp's reported size
  // (which is wrong for the AskSage gateway models); fall back for unknown models.
  const winTok = modelCtx(state.model) ?? (lu ? lu.size : (s?.window ?? 0));
  const ctx = winTok ? curTok / winTok : 0;
  const budget = m?.budgets?.[0];
  const ctxPct = Math.round(ctx * 100);
  // Minimal status bar: a context-fill RING · (Claude API status / Gov usage when present) · the
  // Trivia Wire's flexible gap. The model seg was removed (redundant - the titlebar model badge
  // already shows it) and the gate-active pill retired (the gate's WORK surfaces in the Security
  // panel + rail badge); the cache/session-cost pills live on in the Memory panel.
  $("#statusbar")!.innerHTML = `
    <div class="seg ctx" data-tip="Context window|${fmtNum(curTok)} / ${fmtNum(winTok)} tokens used (${ctxPct}%)${lu ? " · live this session" : ""}">
      <svg class="ctx-ring" viewBox="0 0 22 22" width="17" height="17" aria-hidden="true">
        <circle class="ctx-track" cx="11" cy="11" r="8"/>
        <circle class="ctx-arc" pathLength="100" cx="11" cy="11" r="8" style="stroke:${loadColor(ctx)};stroke-dashoffset:${100 - Math.min(100, Math.max(0, ctxPct))}"/>
      </svg><b>${ctxPct}%</b></div>
    <div class="seg-mid">
      ${budget && currentProviderHasApiKey() ? `<div class="seg seg-btn${budget.used >= 0.9 ? " warn" : ""}" data-budget-refresh data-tip="${esc(budget.label)} usage|${budget.used >= 0.9 ? "Almost spent - turns may start stalling. " : ""}Click to re-check now · auto every 5 min. From the provider's API-key rate-limit headers.">${esc(budget.label)} <b style="color:${loadColor(budget.used)}">${Math.round(budget.used * 100)}%</b> ${icon("refresh", 11)}</div>` : ""}
      ${asksageChip()}
    </div>
    <div class="triv-slot" id="trivSlot"></div>`;
  mountTrivia(); // P-TRIV.1: re-adopt the persistent ticker after the innerHTML swap
}

// ───────────────────────── the Trivia Wire — P-TRIV.1 (ADR-0174) ─────────────────────────
// A word-game ticker that lives in the status bar's flexible gap (between the Gov chip and the
// gate-active pill) ONLY while an agent turn has been streaming for a while - the boredom window.
// Game rules, scoring, persistence shape, visibility rule, and the ESCAPED markup are all pure in
// trivia.ts; this block owns just the animation loop and the input wiring. The ticker element is
// created once and re-adopted after every renderStatus innerHTML swap so its scroll position and
// in-flight question survive the 2s data poll.
const TRIVIA_SCORE_KEY = "lucid.trivia";        // lifetime {score,answered,correct}
const TRIVIA_ENABLED_KEY = "lucid.trivia-enabled"; // "1" = on (default OFF - an easter egg people find; toggle in Settings -> Trivia Wire)
const TRIVIA_SPEED = 78;                        // px/s - an easy reading clip
const TRIVIA_EXPLAIN_SPEED = 95;
const TRIVIA_ANSWER_LINGER_MS = 1100;           // how long the pill verdict shows before the explanation line

function triviaEnabled(): boolean {
  try { return localStorage.getItem(TRIVIA_ENABLED_KEY) === "1"; } catch { return false; } // default OFF until switched on
}
let triviaGame: TriviaGame | null = null;
let trivEl: HTMLElement | null = null;          // persistent .triv wrapper (survives renderStatus)
let trivIn: HTMLElement | null = null;          // the scrolling line inside it
let trivX = 0, trivStop = 0, trivLast = 0;
let trivPaused = false, trivAnswered = false, trivShown = false;
let trivMeasured = false; // widths read while ATTACHED - a detached measure (clientWidth 0) parks the line wrong
// P-TRIV.2 (ADR-0175): role-aware banks + idle engagement
let trivBank: readonly TriviaQuestion[] | null = null; // the bank the current game was built on (ref-compared on role change)
let trivIdleSince = Date.now();                 // last activity edge: boot, turn end, or a composer keystroke
let trivPrevStreaming = false;                  // detects the turn-end edge inside the frame loop
let trivKgUnlocked = false;                     // cached bridge.personal() unlock state (60s poll - never fetched per frame)
// P-TRIV.3 (ADR-0176): the executive INTEL WIRE - scanned headlines interleaved between questions.
let trivNews: import("./bridge.ts").IntelNewsItemView[] = [];
let trivNewsIdx = 0;
let trivShowingNews = false;                    // the current line is a news interstitial, not the game
let trivParkedAt: number | null = null;         // when an unanswered question reached its stop
const TRIVIA_PARK_TIMEOUT_MS = 45_000;          // parked + unanswered this long → the wire moves on (skip, no penalty)

/** Pull the wire (executive only). Fail-quiet: offline/blocked → empty list → questions-only. */
async function refreshTriviaNews(): Promise<void> {
  if (state.userRole !== "executive" || !triviaEnabled()) { trivNews = []; return; }
  try {
    const v = await bridge.intelNews();
    trivNews = (v?.items ?? []).filter(isIntelNewsItem);
  } catch { trivNews = []; }
}

/** Swap the ticker line to the next news item. Returns false when there is nothing to show
 *  (non-executive role, empty wire, or reduced motion - news is a scroll-only experience). */
function loadNewsLine(): boolean {
  if (!trivIn || !trivEl || trivReducedMotion || state.userRole !== "executive" || trivNews.length === 0) return false;
  const item = trivNews[trivNewsIdx % trivNews.length]!;
  trivNewsIdx++;
  const html = newsLineHtml(item);
  if (!html) return false;
  trivIn.innerHTML = html;
  trivShowingNews = true;
  trivParkedAt = null;
  trivX = trivEl.clientWidth + 6;
  trivIn.style.transform = `translateX(${trivX}px)`;
  return true;
}

const trivStore = () => ({
  get: () => localStorage.getItem(TRIVIA_SCORE_KEY),
  set: (v: string) => localStorage.setItem(TRIVIA_SCORE_KEY, v),
});

async function refreshTriviaKg(): Promise<void> {
  try { const p = await bridge.personal(); trivKgUnlocked = !!(p?.enabled && p?.unlocked); }
  catch { trivKgUnlocked = false; } // unknown = locked: the idle branch stays fail-quiet
}

// P-TRIV.4 (ADR-0191): generated packs persist per role and take precedence over the seed bank (the
// permanent fail-closed floor). A stable-ref cache keeps refreshTriviaGame's bank compare O(1).
const TRIVIA_PACK_PREFIX = "lucid.trivia-pack.";   // + role -> { questions, at, model }
const TRIVIA_SOURCES_KEY = "lucid.trivia-sources";  // { sessions, kg, codegraph } re-seed source choices
const TRIVIA_MIN_PACK = 8;                          // mirrors trivia_seed.ts MIN_PACK: below this we keep the seed
const trivPackCache = new Map<string, readonly TriviaQuestion[]>(); // role -> parsed pack (stable ref)

/** The user's chosen re-seed context sources (persisted). All off by default - re-seed is opt-in. */
function triviaSources(): { sessions: boolean; kg: boolean; codegraph: boolean } {
  try {
    const o = JSON.parse(localStorage.getItem(TRIVIA_SOURCES_KEY) || "{}") as Record<string, unknown>;
    return { sessions: !!o.sessions, kg: !!o.kg, codegraph: !!o.codegraph };
  } catch { return { sessions: false, kg: false, codegraph: false }; }
}

/** The generated pack for a role (stable ref, cached), or null when none is stored / it is too small /
 *  corrupt. Every entry re-passes isTriviaQuestion - a tampered store can never inject a bad question. */
function storedTriviaPack(role: string | null | undefined): readonly TriviaQuestion[] | null {
  const key = role || "developer";
  const cached = trivPackCache.get(key);
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(TRIVIA_PACK_PREFIX + key);
    if (!raw) return null;
    const o = JSON.parse(raw) as { questions?: unknown };
    const qs = Array.isArray(o.questions) ? o.questions.filter(isTriviaQuestion) : [];
    if (qs.length < TRIVIA_MIN_PACK) return null;
    trivPackCache.set(key, qs);
    return qs;
  } catch { return null; }
}

/** The durable contract of P-TRIV.4: a generated pack takes precedence; the role seed bank is the
 *  permanent fail-closed floor. Both trivia game builders go through here so the two stay in lockstep. */
function effectiveTriviaBank(role: string | null | undefined): readonly TriviaQuestion[] {
  return storedTriviaPack(role) ?? bankForRole(role);
}

/** Persist + cache a freshly generated pack for the role (stable ref for the ref-compare). */
function saveTriviaPack(role: string | null | undefined, questions: readonly TriviaQuestion[], model: string): void {
  const key = role || "developer";
  trivPackCache.set(key, questions);
  try { localStorage.setItem(TRIVIA_PACK_PREFIX + key, JSON.stringify({ questions, at: Date.now(), model })); }
  catch { /* full/blocked store: the pack still lives in-memory this session */ }
}

/** Drop the generated pack for a role -> the wire falls back to the built-in seed bank. */
function clearTriviaPack(role: string | null | undefined): void {
  const key = role || "developer";
  trivPackCache.delete(key);
  try { localStorage.removeItem(TRIVIA_PACK_PREFIX + key); } catch { /* ignore */ }
}

/** Adopt a pack: persist it, then rebuild the live game on it (lifetime score survives - it lives in
 *  trivStore, not the game). No-op before the ticker exists; ensureTrivia picks up the stored pack. */
function applyTriviaPack(role: string | null | undefined, questions: readonly TriviaQuestion[], model: string): void {
  saveTriviaPack(role, questions, model);
  if (!triviaGame) return;
  trivBank = effectiveTriviaBank(role);
  triviaGame = createTriviaGame(trivBank, trivStore());
  loadTriviaLine();
}

/** Rebuild the game when the role's bank actually changed (lifetime score survives - it lives in
 *  the store, not the game). No-op before the ticker exists or when the bank is unchanged. */
function refreshTriviaGame(): void {
  if (!triviaGame) return;
  const bank = effectiveTriviaBank(state.userRole); // P-TRIV.4 (ADR-0191): generated pack ?? seed bank
  if (bank === trivBank) return;
  trivBank = bank;
  triviaGame = createTriviaGame(bank, trivStore());
  loadTriviaLine();
  void refreshTriviaNews(); // role changed: fill (or clear) the INTEL WIRE for the new persona
}
const trivReducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function ensureTrivia(): void {
  if (trivEl || !triviaEnabled()) return;
  trivBank = effectiveTriviaBank(state.userRole); // P-TRIV.4 (ADR-0191): adopt a generated pack when present
  triviaGame = createTriviaGame(trivBank, trivStore());
  // Idle-engagement inputs (P-TRIV.2): a composer keystroke restarts the idle grace, and the KG
  // unlock state is polled gently (never per frame - bridge.personal() is a fetch).
  $("#input")?.addEventListener("input", () => { trivIdleSince = Date.now(); });
  void refreshTriviaKg();
  setInterval(() => { if (triviaEnabled()) void refreshTriviaKg(); }, 60_000);
  // P-TRIV.3: the INTEL WIRE refresh rides the backend's 20-minute cache - polling faster only re-reads it.
  void refreshTriviaNews();
  setInterval(() => { void refreshTriviaNews(); }, 5 * 60_000);
  trivEl = el(`<div class="triv" data-tip="Trivia Wire|Answer with a click or the A-D keys. Hover pauses, scroll re-reads. Right-click to hide."><div class="tkin"></div></div>`);
  trivIn = $(".tkin", trivEl) as HTMLElement;
  trivEl.addEventListener("mouseenter", () => { trivPaused = true; });
  trivEl.addEventListener("mouseleave", () => { trivPaused = false; });
  // Wheel = scrub back to re-read a long question (the ticker is the only scrollable thing here).
  trivEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    const w = trivEl!.clientWidth, iw = trivIn!.scrollWidth;
    trivX = Math.max(Math.min(6, w - iw - 6), Math.min(w, trivX - (e.deltaY || e.deltaX) * 0.7));
    trivIn!.style.transform = `translateX(${trivX}px)`;
  }, { passive: false });
  trivEl.addEventListener("click", (e) => {
    const pill = (e.target as HTMLElement).closest("[data-tch]");
    if (pill) answerTrivia(Number((pill as HTMLElement).dataset.tch));
  });
  // Right-click = hide (an easy permanent dismiss; the undo toast keeps it reversible).
  trivEl.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    try { localStorage.setItem(TRIVIA_ENABLED_KEY, "0"); } catch { /* ignore */ }
    trivShown = false; trivEl?.classList.remove("on");
    showToast({
      title: "Trivia Wire hidden", desc: "It won't come back on its own.",
      actions: [{ label: "Undo", run: () => { try { localStorage.setItem(TRIVIA_ENABLED_KEY, "1"); } catch { /* ignore */ } } }, { label: "OK" }],
      timeout: 6000,
    });
  });
  document.addEventListener("keydown", (e) => {
    if (!trivShown || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const k = "abcd".indexOf(e.key.toLowerCase());
    if (k >= 0) answerTrivia(k);
  });
  loadTriviaLine();
  requestAnimationFrame(triviaFrame);
}

function mountTrivia(): void {
  if (!triviaEnabled()) return;
  ensureTrivia();
  const slot = $("#trivSlot");
  if (slot && trivEl && trivEl.parentElement !== slot) slot.appendChild(trivEl); // appendChild MOVES - state intact
  if (!trivMeasured && trivEl?.isConnected) loadTriviaLine(); // first real mount: re-park with live widths
}

/** (Re)fill the line from the game's current phase and park it off the right edge. */
function loadTriviaLine(): void {
  if (!triviaGame || !trivIn || !trivEl) return;
  const s = triviaGame.state();
  trivIn.innerHTML = s.phase === "question" ? triviaQuestionHtml(s) : triviaExplainHtml(s);
  trivAnswered = false;
  trivShowingNews = false; // any direct (re)load ends a news interstitial - e.g. a role switch mid-headline
  trivParkedAt = null;
  const w = trivEl.clientWidth || 300, iw = trivIn.scrollWidth;
  trivStop = Math.min(6, w - iw - 6); // long line → stop when the TAIL (the answer pills) is in view
  trivX = trivReducedMotion ? trivStop : w + 6; // reduced motion: no scroll-in, rest immediately
  trivIn.style.transform = `translateX(${trivX}px)`;
  trivMeasured = trivEl.isConnected;
  if (trivReducedMotion) {
    // The explanation line cannot scroll off under reduced motion - hold it readable, then move on.
    if (s.phase === "explain") setTimeout(() => { if (triviaGame?.state().phase === "explain" && !trivAnswered) { triviaGame.advance(); loadTriviaLine(); } }, 4500);
  }
}

function answerTrivia(k: number): void {
  if (!triviaGame || trivAnswered) return;
  const res = triviaGame.answer(k);
  if (!res) return;
  trivAnswered = true;
  const pills = trivIn ? Array.from(trivIn.querySelectorAll<HTMLElement>("[data-tch]")) : [];
  pills[k]?.classList.add(res.correct ? "ok" : "bad");
  if (!res.correct) pills[res.correctIndex]?.classList.add("ok");
  renderMetricsRail(); // the score tile updates immediately
  setTimeout(() => { if (triviaGame?.state().phase === "explain") loadTriviaLine(); }, TRIVIA_ANSWER_LINGER_MS);
}

function triviaFrame(ts: number): void {
  requestAnimationFrame(triviaFrame);
  if (!triviaGame || !trivEl || !trivIn) return;
  const dt = Math.min(0.05, (ts - trivLast) / 1000 || 0);
  trivLast = ts;
  // Turn-end edge: the idle grace restarts when a turn finishes, so the ticker doesn't hang on
  // uninvited - it fades with the turn and only returns after a quiet stretch.
  if (trivPrevStreaming && !state.streaming) trivIdleSince = Date.now();
  trivPrevStreaming = state.streaming;
  const composer = $("#input") as HTMLTextAreaElement | null;
  const sessions = cachedSessions<SessionList>();
  const vis = triviaVisible({
    enabled: triviaEnabled(), streaming: state.streaming, streamStartedAt: state.streamStartedAt, now: Date.now(),
    composerEmpty: !composer?.value.trim(),
    hasHistory: (sessions?.sessions?.length ?? 0) > 0,
    kgUnlocked: trivKgUnlocked,
    idleSince: trivIdleSince,
  });
  if (vis !== trivShown) { trivShown = vis; trivEl.classList.toggle("on", vis); }
  if (!vis) return;
  const s = triviaGame.state();
  // NOTE the linger window: right after an answer the game phase is already "explain" but the
  // QUESTION line (with the pill verdict) is still on screen until the TRIVIA_ANSWER_LINGER_MS
  // timer swaps it - trivAnswered=true marks that window, so nothing scrolls during it.
  if (!trivPaused && !trivReducedMotion && !trivAnswered) {
    if (s.phase === "question") {
      // Recompute the stop from LIVE widths (cheap: transform/color writes never dirty layout) so a
      // window resize mid-scroll still parks the answer pills inside the visible gap.
      trivStop = Math.min(6, trivEl.clientWidth - trivIn.scrollWidth - 6);
      if (trivX > trivStop) { trivX = Math.max(trivStop, trivX - TRIVIA_SPEED * dt); trivIn.style.transform = `translateX(${trivX}px)`; }
      else if (trivParkedAt === null) trivParkedAt = Date.now();
      else if (Date.now() - trivParkedAt >= TRIVIA_PARK_TIMEOUT_MS) {
        // P-TRIV.3: the wire keeps streaming - an unanswered question yields to a news line
        // (executive) or the next question, with zero score impact.
        if (!loadNewsLine()) { triviaGame.skip(); loadTriviaLine(); }
      }
    } else {
      trivX -= TRIVIA_EXPLAIN_SPEED * dt; trivIn.style.transform = `translateX(${trivX}px)`;
      if (trivX < -trivIn.scrollWidth - 20) {
        // P-TRIV.3: explain line done → an INTEL WIRE headline (executive, when available) →
        // then the next question. A news line that just finished falls through: the phase says
        // whether it followed an answer (explain → advance) or a park timeout (question → skip).
        if (!trivShowingNews && loadNewsLine()) { /* news line parked off-right; keeps scrolling */ }
        else {
          trivShowingNews = false;
          if (triviaGame.state().phase === "explain") triviaGame.advance(); else triviaGame.skip();
          loadTriviaLine();
        }
      }
    }
  }
  // Letter color is now a single brand accent set in CSS (.triv .tl) - the animated hue sweep
  // read as too loud in the bar; one LUCID color keeps the wire part of the chrome.
}

// ───────────────────────── data polling ─────────────────────────
async function refresh(): Promise<void> {
  try {
    const [sec, mem, led, code] = await Promise.all([bridge.security(), bridge.memory(), bridge.usage(), bridge.codeActivity()]);
    state.security = sec; state.memory = mem; state.ledger = led; state.codeActivity = code;
    // Keep the developer Logs panel live (AskSage tool calls, transcripts) while it's the open tab -
    // otherwise its data only refreshed on tab-switch and looked stale mid-turn.
    if (state.developerMode && state.inspectorTab === "dev") { try { state.dev = await bridge.dev(); } catch { /* keep last */ } }
    checkBudgetWarning(mem?.budgets); // early heads-up before a provider budget runs out
    // the badge reflects the live session CONFIG model (loadConfig), not the
    // historical snapshot - so it shows what the next turn will actually use.
    state.lastOk = Date.now();
    // Security rail badge: number of items AWAITING YOUR REVIEW (quarantined/suspicious
    // content the gate flagged). Hidden when there's nothing to act on; coloured by the
    // worst trust label in the queue (quarantined = red, suspicious-only = amber).
    // P-SECACK.1: reviewed rows no longer count as "awaiting" (same split securityHtml uses).
    const approvals = splitReviewed(sec?.approvals ?? [], sec?.acks?.artifacts ?? {}).active;
    const liveQ = sec?.live?.quarantined ?? []; // GUI-owned live gate blocks (ADR-0019 C)
    const awaiting = approvals.length + liveQ.length;
    const badge = $("#railBadge")!;
    badge.hidden = awaiting === 0;
    if (awaiting > 0) {
      const high = liveQ.length > 0 || approvals.some((a) => String(a.trust_label) === "quarantined");
      badge.textContent = awaiting > 99 ? "99+" : String(awaiting);
      badge.className = high ? "badge" : "badge med";
      badge.setAttribute("data-tip", `${awaiting} item${awaiting === 1 ? "" : "s"} awaiting review|${high ? "Includes quarantined (blocked) content." : "Suspicious content flagged for review."} Open the Security panel to act.`);
      badge.setAttribute("data-tip-side", "right");
    }
    renderInspector(); renderStatus(); renderMetricsRail();
  } catch {
    renderStatus();
  }
}

// P10.3: warn BEFORE you hit the wall. The Claude 5-hour (oauth) limit has no header to
// probe and probing would consume it, so we watch omp's reported figure and warn once per
// window when it crosses 90% - turning the silent stall into an early heads-up.
function checkBudgetWarning(budgets: NonNullable<MemorySnapshot["budgets"]> | null | undefined): void {
  for (const b of budgets ?? []) {
    if (b.used >= 0.9 && !state.budgetWarned.has(b.label)) {
      state.budgetWarned.add(b.label);
      showToast({
        title: `${b.label} almost spent`,
        desc: `You're at ${Math.round(b.used * 100)}% of your ${b.label} budget. New turns may stall until it resets ${ageStr(b.resetsAt)}.`,
        meta: "a stalled turn now ends with a clear message instead of hanging",
        actions: [{ label: "OK" }],
        timeout: 9000,
      });
    } else if (b.used < 0.8) {
      state.budgetWarned.delete(b.label); // window reset - re-arm
    }
  }
}

// Provider budget - manual refresh + a 5-minute auto-poll for the current model.
// The figure is omp's last-seen value; a turn updates it, so we also re-pull after
// each turn. Manual refresh resets the 5-minute timer.
let budgetTimer: ReturnType<typeof setInterval> | null = null;
const BUDGET_POLL_MS = 5 * 60 * 1000;
async function refreshBudget(manual = false): Promise<void> {
  const budgets = await bridge.budget();
  if (budgets && state.memory) state.memory.budgets = budgets;
  checkBudgetWarning(budgets);
  const a = await bridge.auth(); if (a) state.auth = a; // keep the OAuth-vs-key gate for the budget pill current
  // P10.3: live API-key rate-limit probe (no-op + [] unless the opt-in is on). force on manual.
  const rl = await bridge.rateLimits(manual);
  state.probedLimits = rl?.limits ?? []; state.probeEnabled = rl?.enabled ?? false;
  if (state.asksage?.configured) state.asksageTokens = await bridge.asksageTokens(); // gov usage on the same cadence
  if (state.inspectorTab === "memory" && !state.inspectorRail) renderInspector();
  renderStatus();
  if (manual) showToast({
    title: budgets?.length ? "Budget refreshed" : "No usage yet",
    desc: budgets?.length ? "Latest provider usage pulled for your current model." : "Nothing recorded yet - send a turn, then refresh.",
    actions: [{ label: "OK" }], timeout: 2200,
  });
  scheduleBudgetPoll();
}
function scheduleBudgetPoll(): void {
  if (budgetTimer) clearInterval(budgetTimer);
  budgetTimer = setInterval(() => void refreshBudget(false), BUDGET_POLL_MS);
}

// AskSage gov gateway: load config + personas once, refresh usage on demand.
async function loadAsksage(): Promise<void> {
  state.asksage = await bridge.asksage();
  if (state.asksage?.configured) {
    state.asksageTokens = await bridge.asksageTokens();
    state.personas = (await bridge.asksagePersonas()) ?? [];
  }
  renderStatus();
  updateComposerTools();
}
async function refreshAsksage(): Promise<void> {
  state.asksage = await bridge.asksage();
  state.asksageTokens = state.asksage?.configured ? await bridge.asksageTokens() : null;
  renderStatus();
  showToast({
    title: state.asksageTokens ? "Gov usage refreshed" : "AskSage not reachable",
    desc: state.asksageTokens ? `${fmtNum(state.asksageTokens.used)} / ${fmtNum(state.asksageTokens.limit)} tokens this month.` : "Add a key (and check the base URL) in Settings.",
    actions: [{ label: "OK" }], timeout: 2400,
  });
}

// ───────────────────────── interactions ─────────────────────────
function toggleSidebar(force?: boolean): void {
  state.sidebarCollapsed = force ?? !state.sidebarCollapsed;
  $("#sidebar")!.classList.toggle("collapsed", state.sidebarCollapsed);
  // When sessions are collapsed the left nav recedes (dimmed); the hamburger (#sideToggle) reopens it.
  $("#app-inner")?.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  try { localStorage.setItem("lucid.sidebar-collapsed", state.sidebarCollapsed ? "1" : "0"); } catch { /* ignore */ }
}
/** Update the composer's quick controls (persona · skills). Model/mode/thinking live in the top picker. */
function updateComposerTools(): void {
  const set = (sel: string, v: string) => { const e = $(sel); if (e) e.textContent = v; };
  const pBtn = $("#ctPersona");
  if (pBtn) {
    (pBtn as HTMLElement).hidden = !state.asksage?.configured;
    // Show a readable persona name (up to 25 chars), not the raw numeric id; the FULL
    // description is surfaced on hover via data-tip ("Title|Description").
    const sel = state.persona ? state.personas.find((p) => p.id === state.persona) : null;
    if (sel) {
      const title = personaTitle(sel.description, sel.id);
      const label = title.length > 25 ? title.slice(0, 24).trimEnd() + "…" : title;
      set("#ctPersonaName", label);
      pBtn.setAttribute("data-tip", `AskSage persona · #${sel.id}|${sel.description || "No description provided."}`);
    } else {
      set("#ctPersonaName", "Persona");
      pBtn.setAttribute("data-tip", "AskSage persona|Server-supplied role guidance - scanned before use");
    }
  }
}

// AskSage persona picker (composer). Selecting one scans it server-side; a clean
// persona becomes delimited guidance, a flagged one is blocked (fail-closed).
// AskSage personas come as a numeric id + a description (no friendly name). Derive a
// readable short title from the description (stripping the boilerplate prefixes), keep the
// id as a small badge, and surface the FULL description in a premium hover tooltip.
function personaTitle(desc: string, id: string): string {
  let d = (desc || "").trim()
    // strip ONLY the known boilerplate prefix (don't eat the useful content after it)
    .replace(/^use this persona\s+(?:when\s+exploring|when|to|for|if)\s+/i, "")
    .replace(/^this persona\s+acts as if\s+(?:they are|you are|it'?s|it is)\s+a?n?\s*/i, "")
    .replace(/^this persona\s+(?:is|acts as)\s+a?n?\s*/i, "")
    .replace(/^this is\s+a?n?\s+/i, "")
    .trim();
  d = (d.split(/[.\n]/)[0] ?? "").trim(); // first sentence (keep internal commas)
  if (!d) return `Persona ${id}`;
  const words = d.split(/\s+/).slice(0, 6).join(" ");
  const t = words.length > 36 ? words.slice(0, 35).trimEnd() + "…" : words;
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function personaRow(p: { id: string; description: string }, selected: string, attr: "data-pid" | "data-ragpid"): string {
  const none = !p.id;
  const title = none ? "None" : personaTitle(p.description, p.id);
  const tip = none ? esc(p.description) : `${esc(title)} · #${esc(p.id)}|${esc(p.description || "No description provided.")}`;
  return `<div class="cfg-opt persona-opt ${selected === p.id ? "on" : ""}" ${attr}="${esc(p.id)}" data-tip="${tip}" data-tip-side="left"><span class="tick">${icon("check", 13)}</span><span class="nm">${esc(title)}</span>${none ? "" : `<span class="id">#${esc(p.id)}</span>`}</div>`;
}

async function openPersonaDropdown(anchor: HTMLElement): Promise<void> {
  cfgClose?.();
  const items = [{ id: "", description: "No persona - default behavior" }, ...state.personas];
  const rows = items.map((p) => personaRow(p, state.persona ?? "", "data-pid")).join("");
  const { node, close } = popover(anchor, `<div class="cfg-sec"><div class="cfg-lbl">Persona <span class="cur">scanned before use</span></div><div class="cfg-list" id="personaList">${rows || `<div class="empty">No personas - check your AskSage key.</div>`}</div></div>`, () => { cfgClose = null; });
  cfgClose = close;
  $("#personaList", node)?.addEventListener("click", (e) => {
    const it = (e.target as HTMLElement).closest("[data-pid]") as HTMLElement | null;
    if (!it) return;
    close();
    void applyPersona(it.dataset.pid || null);
  });
}
async function applyPersona(id: string | null): Promise<void> {
  const r = await bridge.applyPersona(id);
  if (!id || r?.cleared) { state.persona = null; updateComposerTools(); showToast({ title: "Persona cleared", desc: "Back to default behavior.", actions: [{ label: "OK" }], timeout: 2000 }); return; }
  if (r?.applied) {
    state.persona = id; updateComposerTools();
    const sel = state.personas.find((p) => p.id === id);
    const nm = sel ? personaTitle(sel.description, sel.id) : `#${id}`;
    showToast({ title: `Persona: ${nm}`, desc: "Scanned clean - added as delimited role guidance on your next turn.", actions: [{ label: "OK" }], timeout: 3200 });
  } else {
    state.persona = null; updateComposerTools();
    showToast({ tone: "danger", title: "Persona blocked", desc: `The scanner flagged this persona (${r?.scan?.findings ?? 0} finding(s)); it was not applied.`, meta: "fail-closed - untrusted content can't enter the prompt", actions: [{ label: "OK" }], timeout: 6000 });
  }
}

// RAG persona picker (Settings → gov datasets). Sets AskSage's NATIVE persona id
// for the /query route - applied server-side, so no scan (no text enters the prompt).
function openRagPersonaDropdown(anchor: HTMLElement): void {
  cfgClose?.();
  const cur = state.asksage?.persona ?? "";
  const items = [{ id: "", description: "No persona - plain grounded RAG" }, ...state.personas];
  const rows = items.map((p) => personaRow(p, cur, "data-ragpid")).join("");
  const { node, close } = popover(anchor, `<div class="cfg-sec"><div class="cfg-lbl">RAG persona <span class="cur">native · /query</span></div><div class="cfg-list" id="ragPersonaList">${rows || `<div class="empty">No personas - check your AskSage key.</div>`}</div></div>`, () => { cfgClose = null; });
  cfgClose = close;
  $("#ragPersonaList", node)?.addEventListener("click", async (e) => {
    const it = (e.target as HTMLElement).closest("[data-ragpid]") as HTMLElement | null;
    if (!it) return;
    close();
    const persona = it.dataset.ragpid || "";
    state.asksage = (await bridge.saveAsksage({ persona })) ?? state.asksage;
    showToast({ title: persona ? `RAG persona #${persona}` : "RAG persona cleared", desc: persona ? "AskSage applies it server-side on grounded /query (RAG) turns." : "Grounded queries run without a persona.", actions: [{ label: "OK" }], timeout: 2600 });
    void renderSettings();
  });
}

// P-IDE.2 (ADR-0029): skills come from TWO sources behind one picker - BUNDLED (skills.ts, trusted
// guidance delivered in the user turn) and PROJECT (omp-discovered, invoked via /skill:<name>). The
// Skills button is always available (bundled skills always exist).
async function loadSkills(): Promise<void> {
  state.skills = (await bridge.skills()) ?? [];
  const btn = $("#ctSkill"); if (btn) (btn as HTMLElement).hidden = false;
  updateSkillButton();
}
/** Reflect the active bundled skill on the composer's Skills button. */
function updateSkillButton(): void {
  const btn = $("#ctSkill"); if (!btn) return;
  const span = btn.querySelector("span"); if (span) span.textContent = state.activeSkill?.name ?? "Skills";
  btn.classList.toggle("on", !!state.activeSkill);
}
/** Project (omp-native) skill: prepend /skill:<name> to the composer (omp expands it server-side). */
function useSkill(name: string): void {
  const ta = $("#input") as HTMLTextAreaElement;
  ta.value = `/skill:${name} ${ta.value}`.trimEnd() + " ";
  autosize(ta); setSendEnabled(); ta.focus();
  void bridge.skillActivated(name, name, "project"); // P-IDE.3 telemetry (metadata only)
  showToast({ title: `Skill: ${name}`, desc: "Added to your message - type your request and send.", actions: [{ label: "OK" }], timeout: 2400 });
}
/** Bundled skill: activate it - its trusted guidance rides the next user turn until cleared. */
async function activateBundledSkill(command: string): Promise<void> {
  const s = INSTALLED_SKILLS.find((x) => x.command === command); if (!s) return;
  if (!isSkillEnabled(skillKey("bundled", command), "trusted")) { showToast({ tone: "warn", title: `${s.name} is disabled`, desc: "Enable it in the Skills directory (rail \u203a Skills) to use it.", timeout: 2800 }); return; } // P-SKILL.4
  state.activeSkill = { command: s.command, name: s.name };
  bumpSkillUsage(command); updateSkillButton();
  await bridge.setActiveSkill(s.name, s.systemPrompt);
  void bridge.skillActivated(s.command, s.name, "bundled"); // P-IDE.3 telemetry (metadata only)
  showToast({ title: `Skill on: ${s.name}`, desc: "Guides the agent until you clear it (Skills → Clear).", actions: [{ label: "OK" }], timeout: 2800 });
}
async function clearBundledSkill(): Promise<void> {
  state.activeSkill = null; updateSkillButton();
  await bridge.clearActiveSkill();
  showToast({ title: "Skill cleared", desc: "No bundled skill is steering the agent.", timeout: 2000 });
}

// ── P-CMD.1 (ADR-0146): user-authored "/" slash commands ──────────────────────
// Resolve the text actually sent to the model. `/agent` + `/command` open builder interviews; a SEND-mode
// user command expands its saved body with any typed args. Anything else passes through verbatim. Pure.
function resolveSendText(text: string, cmdTok: string | undefined): string {
  if (/^\/agent\b/i.test(text)) return agentInterviewPrompt(text.replace(/^\/agent\b/i, "").trim());
  if (/^\/command\b/i.test(text)) return commandBuilderPrompt(text.replace(/^\/command\b/i, "").trim());
  if (cmdTok) {
    const uc = state.userCommands.find((c) => c.name === cmdTok && c.mode === "send");
    if (uc) return expandCommandBody(uc.body, text.replace(new RegExp(`^/${cmdTok}\\s*`, "i"), ""));
  }
  return text;
}

/** Kickoff for `/command [description]`: steer the chat agent to interview the user then call
 *  slash_command_create (mirrors agentInterviewPrompt). Frozen SLASH_COMMAND_POLICY reinforces this. */
function commandBuilderPrompt(desc: string): string {
  const focus = desc ? `\n\nThe user's starting idea: ${desc}` : "";
  return (
    `The user wants to CREATE a reusable "/" slash command - a saved prompt they trigger by typing /<name>. ` +
    `Interview them briefly (skip anything already clear), then create it with the slash_command_create tool.` +
    focus +
    `\n\nYou need: (1) a NAME (lowercase letters/digits/hyphens, e.g. pr-review); (2) exactly WHAT it should do ` +
    `- the prompt body it runs (use $ARGS for the text typed after the name, or $1..$9 for positional args); ` +
    `(3) MODE - "send" (expand the body + args and send it as a turn) or "skill" (activate the body as a ` +
    `persistent instruction until cleared). If it's already clear, skip straight to creating it. Then call ` +
    `slash_command_create with { name, description, body, mode }. NEVER put a secret value in the body - ` +
    `reference a vault credential by name instead.`
  );
}

/** SKILL-mode user command: activate its body as a persistent instruction (reuses the bundled-skill seam). */
async function activateUserCommandSkill(uc: UserCommand): Promise<void> {
  state.activeSkill = { command: `cmd:${uc.name}`, name: `/${uc.name}` };
  updateSkillButton();
  await bridge.setActiveSkill(`/${uc.name}`, uc.body);
  void bridge.skillActivated(`cmd:${uc.name}`, `/${uc.name}`, "project"); // P-IDE.3 telemetry (metadata only)
  showToast({ title: `Skill on: /${uc.name}`, desc: "Guides the agent until you clear it (Skills → Clear).", timeout: 2800 });
}

// The agent called slash_command_create → acp_backend parsed + emitted the command. Persist it AUTHORITATIVELY
// through the gate (createUserCommand validates + secret-scans + Unicode-scans server-side), then register it
// in the live "/" menu. A blocked/invalid command surfaces as a danger toast and is never enabled.
async function onSlashCommandCreated(command: UserCommand): Promise<void> {
  const res = await bridge.userCommandCreate(command);
  if (!res?.ok) {
    showToast({ tone: "danger", title: "Couldn't create the command", desc: res?.reason ?? res?.errors?.[0] ?? "rejected at the security gate" });
    return;
  }
  const saved = res.command ?? command;
  state.userCommands = [saved, ...state.userCommands.filter((c) => c.name !== saved.name)];
  const takesArgs = /\$ARGS\b|\$[1-9]/.test(saved.body);
  showToast({
    title: `Created /${saved.name}`,
    desc: saved.mode === "skill" ? `Type /${saved.name} to activate it as a skill.` : `Type /${saved.name} to run it${takesArgs ? " (takes arguments)" : ""}.`,
    timeout: 4200,
  });
}
/** /task proforma: append a multi-line subagent-delegation template, preserving existing input. */
function insertTaskProforma(): void {
  const ta = $("#input") as HTMLTextAreaElement;
  ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, "") + "\n\n" : "") + taskProforma();
  autosize(ta); setSendEnabled(); ta.focus();
  void bridge.skillActivated("task", "/task", "task"); // P-IDE.3 telemetry (metadata only)
}
/** Project-skill rows for the picker (extracted so the list can re-render in place after an import). */
function projSkillRows(): string {
  return state.skills.map((s) =>
    `<div class="cfg-opt" data-skill="${esc(s.name)}" data-tip="${esc(s.description || s.name)}|${esc(s.source)}" data-tip-side="left"><span class="tick">${icon("bolt", 13)}</span><span class="nm">${esc(s.name)}</span><span class="id">${esc((s.description || "").slice(0, 42))}</span></div>`).join("")
    || `<div class="empty">No project skills yet. Drop <code>.md</code> skills below.</div>`;
}
/** P-SKILL.1 (ADR-0045): import dropped/picked .md skill files. Each is scanned at the gate server-side;
 *  clean ones land under .omp/skills/, flagged ones are held for Security-panel review. Refreshes the
 *  project list in place and toasts a summary. */
async function handleSkillFiles(fileList: FileList | File[], node: HTMLElement): Promise<void> {
  const mds = [...fileList].filter((f) => /\.md$/i.test(f.name) || f.type === "text/markdown");
  if (!mds.length) { showToast({ tone: "warn", title: "No .md files", desc: "Drop markdown skill files (.md).", timeout: 2400 }); return; }
  let files: { name: string; content: string }[];
  try { files = await Promise.all(mds.slice(0, 20).map(async (f) => ({ name: f.name, content: await f.text() }))); }
  catch { showToast({ tone: "warn", title: "Couldn't read those files", desc: "Try dropping the .md skill files again.", timeout: 2400 }); return; }
  const res = await bridge.skillImport(files);
  const results = res?.results ?? [];
  const written = results.filter((r) => r.written);
  const blocked = results.filter((r) => r.blocked);
  if (written.length) {
    await loadSkills(); // refresh state.skills, then re-render the project list inside the open popover
    const list = node.querySelector("#projSkillList"); if (list) list.innerHTML = projSkillRows();
  }
  const parts: string[] = [];
  if (written.length) parts.push(`${written.length} imported`);
  if (blocked.length) parts.push(`${blocked.length} blocked`);
  showToast({
    tone: blocked.length ? "warn" : "ok",
    title: parts.join(" · ") || "Nothing imported",
    desc: [written.length ? `Added: ${written.map((r) => r.name).join(", ")}.` : "",
      blocked.length ? `${blocked.length} flagged by the security gate - review in the Security panel.` : ""].filter(Boolean).join(" "),
    actions: [{ label: "OK" }], timeout: 4200,
  });
}
// ── /goal loop (P-GOAL.1, ADR-0046) ───────────────────────────────────────────
let goalLoopRunning = false; // P-GOAL.2: true while a /goal loop streams, so Stop cancels the LOOP
// P-GOAL.7: the usage ledger for the open goal modal (real per-model price + cache rate), fetched lazily.
let goalLedger: Awaited<ReturnType<typeof bridge.usage>> | null = null;
// P-GOAL.12 (ADR-0057): success criteria adopted from a Pre-Flight Audit, threaded to the checker on the
// next run so it grades against the matured design (and reports back against it). Reset each modal open.
let adoptedCriteria = "";
// A launcher form (goal · optional verify command · max iterations), then a loop that streams maker
// iterations with a separate checker's verdict each round. Every action is still gated server-side.

// P-GOAL.8: common verification commands offered as type-ahead suggestions (the user can still type
// anything). Ordered by rough ecosystem prevalence.
const COMMON_VERIFY_COMMANDS = [
  "npm test", "npm test && npm run lint", "npm run build", "npm run lint", "pnpm test", "yarn test",
  "bun test", "pytest", "pytest -q", "python -m pytest", "go test ./...", "cargo test", "cargo check",
  "make test", "make", "bun run typecheck", "tsc --noEmit", "dotnet test", "mvn test", "gradle test",
];
// P-GOAL.8: a premium info dot (uses the global data-tip tooltip). `tip` is "Title|Body".
function goalInfoDot(tip: string): string {
  return `<button type="button" class="info-dot goal-info" tabindex="-1" data-tip="${esc(tip)}" data-tip-icon="info" data-tip-side="right">${icon("info", 11)}</button>`;
}
// P-GOAL.8: under AskSage lockdown the base-model picker lists Gemini, then GPT, then Anthropic.
const GUIDED_GOV_FAMILY_ORDER = ["gemini", "gpt-o", "gpt", "claude", "rag", "other"];
// P-GOAL.8.1: skills NOT offered for a goal loop - meta/planning/self-referential ones that don't help
// drive code toward a verifiable condition (the loop itself, the loop-engineering doc, read-only Plan/
// Explain, the handoff doc). Everything else (TDD, Code Review, Refactor, Debug, …) is build-oriented.
const GOAL_SKILL_DENY = new Set(["goal", "loop-engineering", "plan", "explain", "session-handoff"]);

// P-GOAL.8.1: a custom, anchored type-ahead for the verification command (the native <datalist> popup
// mispositioned to the top-left). Shows filtered common commands directly under the input; the user can
// still type anything. Arrow keys + Enter to pick, Escape/blur to dismiss.
function wireCmdSuggest(ov: HTMLElement): void {
  const input = $("#goalCmd", ov) as HTMLInputElement | null;
  const menu = $("#goalCmdMenu", ov) as HTMLElement | null;
  if (!input || !menu) return;
  let active = -1;
  const items = () => [...menu.querySelectorAll<HTMLElement>(".goal-cmd-item")];
  const hide = () => { menu.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
  const fill = (q: string) => {
    const ql = q.trim().toLowerCase();
    const matches = COMMON_VERIFY_COMMANDS.filter((c) => !ql || c.toLowerCase().includes(ql));
    if (!matches.length) { hide(); return; }
    menu.innerHTML = matches.map((c) => `<div class="goal-cmd-item" role="option">${esc(c)}</div>`).join("");
    items().forEach((it) => it.addEventListener("mousedown", (e) => { e.preventDefault(); input.value = it.textContent || ""; hide(); input.focus(); }));
    active = -1; menu.hidden = false; input.setAttribute("aria-expanded", "true");
  };
  input.addEventListener("focus", () => fill(input.value));
  input.addEventListener("input", () => fill(input.value));
  input.addEventListener("blur", () => setTimeout(hide, 130));
  input.addEventListener("keydown", (e) => {
    if (menu.hidden) return;
    const list = items();
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, list.length - 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); input.value = list[active]?.textContent ?? input.value; hide(); return; }
    else if (e.key === "Escape") { e.stopPropagation(); hide(); return; }
    else return;
    list.forEach((it, i) => it.classList.toggle("active", i === active));
    list[active]?.scrollIntoView({ block: "nearest" });
  });
}

// ── P-VOICE.1 (ADR-0115): read-aloud (text-to-speech) ─────────────────────────
// Speak arbitrary text (an assistant reply, an AAR summary) via /api/tts/speak using the engine + voice
// from Settings → Voice. Click again while playing to STOP. Fail-safe: a missing key/engine shows a note.
/** Decode base64 audio into a Blob URL. A large WAV as a `data:` URL frequently fails to play in
 *  <audio>/Audio() even though it downloads fine; a Blob URL plays reliably. Callers should not leak these
 *  for long-lived players (the podcast slot is short-lived); speakText revokes on end. */
function audioBlobUrl(b64: string, mime: string): string {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([arr], { type: mime || "audio/mpeg" }));
}
let ttsAudio: HTMLAudioElement | null = null;
const speakOrig = new WeakMap<HTMLElement, string>();
function restoreSpeakBtn(btn?: HTMLElement | null): void {
  if (!btn) return;
  btn.classList.remove("busy", "playing");
  const o = speakOrig.get(btn);
  if (o != null) btn.innerHTML = o;
}
// P-REPORT.5b: the Listen/read-aloud button SYNTHESIZES on demand (independent of the Generate panel's
// audio option) - click it any time. It shows a spinner while the model synthesizes, flips to a Stop
// control while playing, and surfaces the real engine error if TTS isn't configured.
async function speakText(text: string, btn?: HTMLElement | null): Promise<void> {
  if (ttsAudio && !ttsAudio.paused) { ttsAudio.pause(); ttsAudio = null; restoreSpeakBtn(btn); return; }
  // P-REPORT.7: sanitize per line so the TTS reads flowing speech, not codes/symbols/markdown artifacts.
  const clean = (text || "").split(/\n+/).map((ln) => speakable(ln)).filter(Boolean).join(" ").trim();
  if (!clean) return;
  const orig = btn?.innerHTML ?? "";
  const labelled = /listen/i.test(orig); // the report's "Listen" button carries a label; message read-aloud is icon-only
  if (btn) {
    speakOrig.set(btn, orig);
    btn.classList.add("busy");
    btn.innerHTML = `${icon("refresh", 16, "spin")}${labelled ? " <span>Synthesizing…</span>" : ""}`;
  }
  const r = await bridge.speak(clean.slice(0, 8000)).catch(() => null);
  if (!r?.audioB64) {
    restoreSpeakBtn(btn);
    showToast({ tone: "warn", title: "Couldn't read it aloud", desc: r?.note || "Choose a TTS engine in Settings → Voice (ElevenLabs, OpenAI, or offline Kokoro).", actions: [{ label: "OK" }], timeout: 5000 });
    return;
  }
  const url = audioBlobUrl(r.audioB64, r.mime);
  ttsAudio = new Audio(url);
  if (btn) { btn.classList.remove("busy"); btn.classList.add("playing"); btn.innerHTML = `${icon("close", 16)}${labelled ? " <span>Stop</span>" : ""}`; }
  ttsAudio.onended = () => { restoreSpeakBtn(btn); URL.revokeObjectURL(url); ttsAudio = null; };
  ttsAudio.play().catch(() => { restoreSpeakBtn(btn); URL.revokeObjectURL(url); });
}

// ── P-VOICE.1 (ADR-0115): mic → speech-to-text into the composer ──────────────
// Click the mic to record, click again to stop. The blob is sent to /api/transcribe (ElevenLabs Scribe
// or an offline Whisper server, per Settings → Voice) and the transcript is INSERTED into the composer for
// review before you send — it's ordinary user input, scanned on send like anything typed.
let micRecorder: MediaRecorder | null = null;
let micChunks: Blob[] = [];
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("read failed"));
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, "")); // strip the data: prefix
    r.readAsDataURL(blob);
  });
}
async function toggleMicRecording(): Promise<void> {
  const btn = $("#ctMic");
  if (micRecorder && micRecorder.state === "recording") { micRecorder.stop(); return; } // second click = stop
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showToast({ tone: "warn", title: "No microphone", desc: "This environment can't capture audio.", timeout: 2600 }); return;
  }
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { showToast({ tone: "warn", title: "Microphone blocked", desc: "Allow microphone access to use voice input.", timeout: 2800 }); return; }
  micChunks = [];
  const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
  micRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  micRecorder.ondataavailable = (e) => { if (e.data.size) micChunks.push(e.data); };
  micRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    btn?.classList.remove("recording");
    const type = micRecorder?.mimeType || "audio/webm";
    micRecorder = null;
    const blob = new Blob(micChunks, { type });
    if (!blob.size) return;
    btn?.classList.add("busy");
    try {
      const r = await bridge.transcribe(await blobToBase64(blob), blob.type).catch(() => null);
      if (r?.text) {
        const ta = $("#input") as HTMLTextAreaElement;
        ta.value = (ta.value ? ta.value.replace(/\s*$/, "") + " " : "") + r.text;
        ta.focus(); autosize(ta); setSendEnabled();
      } else {
        showToast({ tone: "warn", title: "No transcript", desc: r?.note || "The speech-to-text engine returned nothing. Check Settings → Voice.", timeout: 3200 });
      }
    } finally { btn?.classList.remove("busy"); }
  };
  micRecorder.start();
  btn?.classList.add("recording");
  showToast({ title: "Recording…", desc: "Click the mic again to stop and transcribe.", timeout: 1800 });
}

function openGoalForm(): void {
  const ov = el(`<div class="scrim goal-scrim"><div class="goal-modal" data-mode="guided">
    <div class="goal-modal-h">
      <span class="goal-h-title">${icon("bolt", 15)} Run a goal loop</span>
      <button type="button" class="goal-mode-toggle" id="goalModeToggle" data-tip="Advanced mode|Show every option on one screen, for power users. You can switch back to the guided walkthrough anytime." data-tip-side="bottom"></button>
    </div>
    <div class="goal-modal-sub">The agent iterates until a verifiable condition holds. A separate checker grades each round; the security gate scans every action.</div>
    <div id="goalStatsSec"></div>
    <div id="goalResumeSec"></div>
    <div id="goalAutoSec"></div>
    <div class="goal-steps">
      <section class="goal-step" data-step="1">
        <div class="goal-step-head"><span class="goal-step-n"></span><h4>What should the agent accomplish?</h4></div>
        <div class="goal-note">Describe the end state in plain language. The clearer the target, the fewer rounds it takes. ${goalInfoDot("The goal|This is the objective the agent works toward each round. Be concrete about the finished result, e.g. 'all auth tests pass and the lint is clean.'")}</div>
        <button type="button" class="btn-mini goal-preflight-btn" id="goalPreflight" data-tip="Pre-Flight Audit|Pause and design the loop first: pick a scope, answer a few prompt-engineering questions, fold in user/engineer feedback and past-run history, and get a readiness-scored Loop Design you can adopt as the goal." data-tip-side="right">${icon("shield", 12)} Pre-Flight Audit <span class="goal-opt">optional · design &amp; readiness check</span></button>
        <label class="goal-lbl">Goal</label>
        <textarea id="goalGoal" class="prov-key" rows="3" placeholder="e.g. Make all auth tests pass and fix any lint errors"></textarea>
      </section>
      <section class="goal-step" data-step="2">
        <div class="goal-step-head"><span class="goal-step-n"></span><h4>How do we know it is done?</h4></div>
        <div class="goal-note">A shell command that exits 0 when the goal is met. This is the strongest signal of done; without one the checker judges the agent's own report. ${goalInfoDot("Verification command|Run after each round by a separate checker. Exit code 0 means done. Pick a suggestion or type your own, e.g. 'npm test && npm run lint'.")}</div>
        <label class="goal-lbl">Verification command <span class="goal-opt">optional, proves "done" by exit 0</span></label>
        <div class="goal-cmd-wrap">
          <input id="goalCmd" class="prov-key" placeholder="e.g. npm test && npm run lint" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="false" />
          <div class="goal-cmd-menu" id="goalCmdMenu" hidden></div>
        </div>
      </section>
      <section class="goal-step" data-step="3">
        <div class="goal-step-head"><span class="goal-step-n"></span><h4>Run with</h4></div>
        <div class="goal-note">Optional: pick the base model the agent uses, its thinking level, and a skill or persona to steer it. Defaults match your current session. ${goalInfoDot("Run with|These apply when you press Run. Base model + thinking set the maker; a Skill adds trusted guidance; a Persona adds scanned role guidance. Leave as-is to use your current setup.")}</div>
        <div class="goal-row goal-runwith">
          <div class="goal-rw-grid">
            <label class="goal-rw-f"><span>Base model</span><select id="goalModel" class="prov-key"></select></label>
            <label class="goal-rw-f" id="goalThinkWrap" hidden><span>Thinking</span><select id="goalThink" class="prov-key"></select></label>
            <label class="goal-rw-f"><span>Skill</span><select id="goalSkill" class="prov-key"></select></label>
            <label class="goal-rw-f" id="goalPersonaWrap" hidden><span>Persona</span><select id="goalPersona" class="prov-key"></select></label>
          </div>
        </div>
      </section>
      <section class="goal-step" data-step="4">
        <div class="goal-step-head"><span class="goal-step-n"></span><h4>Effort and grading</h4></div>
        <div class="goal-note">Cap how many rounds it may take, and pick who grades each round. A cheaper checker keeps cost low. ${goalInfoDot("Iterations and checker|Max iterations is a hard ceiling - the loop stops as soon as the condition holds. The checker is a separate model that grades each round; a small fast model is usually plenty.")}</div>
        <div class="goal-row"><label class="goal-lbl">Max iterations</label><input id="goalMax" class="prov-key goal-max" type="number" min="1" max="20" value="6" /></div>
        <div class="goal-row"><label class="goal-lbl">Budget cap <span class="goal-opt">optional $ ceiling; stops the loop if spend hits it</span> ${goalInfoDot("Budget cap|A hard dollar ceiling on actual spend. The loop halts the moment the maker's running cost reaches it - the kill switch for unattended runs. Leave blank for no cap (max iterations still bounds the run).")}</label><input id="goalBudget" class="prov-key goal-max" type="number" min="0" step="0.25" placeholder="no cap" /></div>
        <div class="goal-row goal-checker">
          <label class="goal-lbl">${icon("spark", 12)} Checker model <span class="goal-opt">grades each round; a cheaper model is fine</span></label>
          <select id="goalChecker" class="prov-key goal-ckr"><option>loading…</option></select>
        </div>
        <div class="goal-ckr-why" id="goalCkrWhy"></div>
        <details class="goal-dial" id="goalDial">
          <summary>${icon("shield", 13)} Speed vs risk <span class="goal-opt">per-command auto-run ceiling for this unattended run</span> ${goalInfoDot("Speed ↔ risk dial|The loop runs with no human to ask, so you set a STANDING posture per command type: how risky a command may be before it auto-runs. Slide left (green) for the safest, most-blocking run; right (red) to let more through. Anything past the dial is BLOCKED and logged in the After-Action Report. Catastrophic commands (rm -rf, sudo, pipe-to-shell…) ALWAYS block, whatever the dial.")}</summary>
          <div class="goal-dial-grid" id="goalDialGrid"></div>
          <div class="goal-dial-foot">${icon("info", 11)} Catastrophic commands (rm -rf, sudo, pipe-to-shell…) always block. Default is the safest (T0) posture.</div>
        </details>
      </section>
      <section class="goal-step" data-step="5">
        <div class="goal-step-head"><span class="goal-step-n"></span><h4>Run now or on a schedule?</h4></div>
        <div class="goal-note">Run once now, or save it as an automation that runs on a cadence while the app is open. ${goalInfoDot("Schedule|'Run once now' starts immediately. A cadence saves a (disabled) automation you arm later; it runs the same loop on a timer, only while the app is open.")}</div>
        <div class="goal-row goal-sched">
          <label class="goal-lbl">${icon("clock", 12)} Schedule <span class="goal-opt">save as an automation</span></label>
          <select id="goalCadKind" class="prov-key goal-cadk">
            <option value="off">Run once now</option>
            <option value="interval">Every…</option>
            <option value="daily">Daily at…</option>
          </select>
          <span id="goalCadInterval" hidden><input id="goalCadEvery" class="prov-key goal-cadn" type="number" min="1" value="60" /><select id="goalCadUnit" class="prov-key goal-cadu"><option value="min">minutes</option><option value="hour">hours</option></select></span>
          <input id="goalCadTime" class="prov-key goal-cadt" type="time" value="09:00" hidden />
        </div>
        <details class="goal-eu">
          <summary>${icon("spark", 13)} Engineering Update <span class="goal-opt">exec brief + podcast · from your repo logs</span> ${goalInfoDot("Engineering Update (repo brief + podcast)|A curated executive brief and two-host podcast built from this repo's DECISIONS.md + PROGRESS.md - NOT the loop's After-Action Report (that appears in chat after a loop finishes). Pick an audio provider to turn the script into a downloadable WAV: Local TTS (Kokoro, air-gap, no key) or ChatGPT/OpenAI TTS (uses your OpenAI key). 'Script only' just writes the two-host script.")}</summary>
          <div class="goal-eu-body">
            <div class="goal-row"><label class="goal-lbl" for="euProvider">Audio</label>
              <select id="euProvider" class="prov-key">
                <option value="script-only">Script only (no audio)</option>
                <option value="elevenlabs">ElevenLabs · custom voices (uses your ElevenLabs key)</option>
                <option value="openai-tts">ChatGPT · OpenAI TTS (uses your OpenAI key)</option>
                <option value="local-tts">Local TTS · Kokoro (air-gap, no key)</option>
              </select>
            </div>
            <div class="goal-row" id="euVoiceRow" hidden><label class="goal-lbl" for="euVoice">Voice</label>
              <select id="euVoice" class="prov-key"><option value="">default voice</option></select></div>
            <div class="goal-eu-cost" id="euCost" hidden></div>
            <button type="button" class="btn-mini ok" id="euGenerate">${icon("bolt", 12)} Generate update now</button>
            <div class="goal-eu-result" id="euResult" hidden></div>
          </div>
        </details>
      </section>
    </div>
    <div class="goal-modal-actions">
      <div class="goal-estimate" id="goalEstimate" tabindex="0"></div>
      <div class="goal-actbtns">
        <button class="btn-mini" id="goalBack" hidden>${icon("chevron", 12)} Back</button>
        <button class="btn-mini" id="goalCancel">Cancel</button>
        <button class="btn-mini" id="goalSave" hidden>${icon("clock", 12)} Save automation</button>
        <button class="btn-mini ok" id="goalNext" hidden>Next ${icon("chevron", 12)}</button>
        <button class="btn-mini ok" id="goalRun">${icon("bolt", 12)} Run loop</button>
      </div>
    </div>
  </div></div>`);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  $("#goalCancel", ov)?.addEventListener("click", close);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
  const readDial = buildGoalDial(ov); // P-GOAL.13: the Speed↔Risk slider matrix (persisted)

  // ── P-GOAL.8: guided walkthrough (default) vs advanced (all-at-once) ──────────
  const modal = $(".goal-modal", ov) as HTMLElement;
  const steps = [...ov.querySelectorAll<HTMLElement>(".goal-step")];
  const TOTAL = steps.length;
  let mode: "guided" | "advanced" = (localStorage.getItem("lucid.goalMode") === "advanced" ? "advanced" : "guided");
  let cur = 1;
  let statsTouched = false; // true once the user manually expands/collapses Loop history (stops auto-collapse)
  const setHidden = (sel: string, hidden: boolean) => { const e = $(sel, ov) as HTMLElement | null; if (e) e.hidden = hidden; };
  const cadenceSet = () => (($("#goalCadKind", ov) as HTMLSelectElement)?.value ?? "off") !== "off";
  // Loop history auto-collapses once past step 1 (or in advanced) since the user already saw it; a manual
  // click pins it. Safe to call before the async stats load - it no-ops until the panel exists.
  const syncStats = () => {
    const stats = ov.querySelector(".goal-stats");
    if (stats && !statsTouched) stats.classList.toggle("collapsed", mode === "advanced" || cur > 1);
  };
  const render = () => {
    modal.dataset.mode = mode;
    ($("#goalModeToggle", ov) as HTMLElement).textContent = mode === "guided" ? "Advanced" : "Guided walkthrough";
    if (mode === "advanced") {
      steps.forEach((s) => (s.hidden = false));
      setHidden("#goalBack", true); setHidden("#goalNext", true);
      setHidden("#goalCancel", false); setHidden("#goalRun", false);
      setHidden("#goalSave", !cadenceSet());
    } else {
      steps.forEach((s) => (s.hidden = Number(s.dataset.step) !== cur));
      const last = cur === TOTAL;
      const headN = $(`.goal-step[data-step="${cur}"] .goal-step-n`, ov); if (headN) headN.textContent = `Step ${cur} of ${TOTAL}`;
      setHidden("#goalBack", cur === 1); setHidden("#goalNext", last);
      setHidden("#goalCancel", false); setHidden("#goalRun", !last);
      setHidden("#goalSave", !(last && cadenceSet()));
      const focusable = $(`.goal-step[data-step="${cur}"] textarea, .goal-step[data-step="${cur}"] input, .goal-step[data-step="${cur}"] select`, ov) as HTMLElement | null;
      setTimeout(() => focusable?.focus(), 30);
    }
    syncStats();
  };
  // Click the Loop-history header to expand/collapse it (pins the choice, overriding auto-collapse).
  ov.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest?.(".gs-head")) {
      statsTouched = true;
      ov.querySelector(".goal-stats")?.classList.toggle("collapsed");
    }
  });
  $("#goalModeToggle", ov)?.addEventListener("click", () => { mode = mode === "guided" ? "advanced" : "guided"; localStorage.setItem("lucid.goalMode", mode); if (mode === "guided") cur = 1; render(); });
  $("#goalNext", ov)?.addEventListener("click", () => {
    if (cur === 1 && !($("#goalGoal", ov) as HTMLTextAreaElement).value.trim()) { showToast({ tone: "warn", title: "Add a goal", desc: "Describe what the loop should accomplish.", timeout: 2400 }); return; }
    if (cur < TOTAL) { cur++; render(); }
  });
  $("#goalBack", ov)?.addEventListener("click", () => { if (cur > 1) { cur--; render(); } });
  // Cadence picker: reveal interval / daily inputs; render() owns the "Save automation" visibility.
  const kindSel = $("#goalCadKind", ov) as HTMLSelectElement;
  const syncCadence = () => {
    const k = kindSel.value;
    ($("#goalCadInterval", ov) as HTMLElement).hidden = k !== "interval";
    ($("#goalCadTime", ov) as HTMLElement).hidden = k !== "daily";
    render();
  };
  kindSel.addEventListener("change", syncCadence);
  const readCadence = (): { kind: "interval"; everyMin: number } | { kind: "daily"; hhmm: string } | null => {
    if (kindSel.value === "interval") {
      const n = Math.max(1, Number(($("#goalCadEvery", ov) as HTMLInputElement).value) || 60);
      const unit = ($("#goalCadUnit", ov) as HTMLSelectElement).value;
      return { kind: "interval", everyMin: unit === "hour" ? n * 60 : n };
    }
    if (kindSel.value === "daily") return { kind: "daily", hhmm: ($("#goalCadTime", ov) as HTMLInputElement).value || "09:00" };
    return null;
  };
  const readSpec = () => {
    const goal = ($("#goalGoal", ov) as HTMLTextAreaElement).value.trim();
    const command = ($("#goalCmd", ov) as HTMLInputElement).value.trim();
    const maxIters = Math.min(20, Math.max(1, Number(($("#goalMax", ov) as HTMLInputElement).value) || 6));
    const budgetUsd = Math.max(0, Number(($("#goalBudget", ov) as HTMLInputElement)?.value) || 0); // P-GOAL.11: 0 = no cap
    return { goal, command, maxIters, budgetUsd, criteria: adoptedCriteria || undefined, dial: readDial() }; // P-GOAL.12 criteria · P-GOAL.13 dial
  };
  // P-GOAL.6.1: live token estimate (lower-left), recomputed as the iteration count changes.
  ($("#goalMax", ov) as HTMLInputElement)?.addEventListener("input", () => updateGoalEstimate(ov));
  updateGoalEstimate(ov); // initial; model names fill in once loadCheckerModel resolves
  render(); // P-GOAL.8: apply guided/advanced mode + show the right step/buttons
  wireCmdSuggest(ov); // P-GOAL.8.1: custom verify-command type-ahead
  // P-BRIEF.3 (ADR-0072): the Engineering Update accordion - the audio-provider choice persists; Generate
  // fetches the curated brief from the repo's logs and renders it inline (audio backend is a later slice).
  const euProv = $("#euProvider", ov) as HTMLSelectElement | null;
  const euVoiceRow = $("#euVoiceRow", ov) as HTMLElement | null;
  const euVoiceSel = $("#euVoice", ov) as HTMLSelectElement | null;
  const euCost = $("#euCost", ov) as HTMLElement | null;
  // Per-generation cost note so users know a cloud TTS run costs money (measured ~10¢ per brief).
  const EU_COST: Record<string, string> = {
    elevenlabs: `${icon("info", 11)} ElevenLabs is billed per character - this brief costs <b>about $0.10 (~10¢) each time</b> you Generate.`,
    "openai-tts": `${icon("info", 11)} OpenAI TTS is billed per character - this brief costs <b>about $0.10 each time</b> you Generate.`,
  };
  let euVoicesLoaded = false;
  // P-VOICE.1: show the voice picker (ElevenLabs only) + the cost note, and lazy-load voices so the user
  // can change voice BEFORE generating. Re-runs on provider change.
  const syncEu = async (): Promise<void> => {
    const p = euProv?.value ?? "script-only";
    if (euVoiceRow) euVoiceRow.hidden = p !== "elevenlabs";
    if (euCost) { const c = EU_COST[p]; euCost.hidden = !c; euCost.innerHTML = c ?? ""; }
    if (p === "elevenlabs" && !euVoicesLoaded && euVoiceSel) {
      euVoicesLoaded = true;
      const data = await bridge.voices().catch(() => null);
      if (data?.voices?.length) {
        const favs = new Set(data.favorites);
        const opt = (v: import("./bridge.ts").ElevenVoiceView) => `<option value="${esc(v.voiceId)}"${v.voiceId === data.selected ? " selected" : ""}>${esc(v.name)}${v.category ? ` · ${esc(v.category)}` : ""}</option>`;
        const fav = data.voices.filter((v) => favs.has(v.voiceId)), rest = data.voices.filter((v) => !favs.has(v.voiceId));
        euVoiceSel.innerHTML = `<option value="">default voice</option>` + (fav.length ? `<optgroup label="★ Favorites">${fav.map(opt).join("")}</optgroup>` : "") + `<optgroup label="All voices">${rest.map(opt).join("")}</optgroup>`;
      } else {
        euVoiceSel.innerHTML = `<option value="">${esc(data?.note || "add an ElevenLabs key in Settings → Voice")}</option>`;
        euVoicesLoaded = false; // let it retry next time
      }
    }
  };
  if (euProv) {
    euProv.value = localStorage.getItem("lucid.euProvider") || "script-only";
    euProv.addEventListener("change", () => { localStorage.setItem("lucid.euProvider", euProv.value); void syncEu(); });
    void syncEu();
  }
  $("#euGenerate", ov)?.addEventListener("click", async () => {
    const btn = $("#euGenerate", ov) as HTMLButtonElement;
    const out = $("#euResult", ov) as HTMLElement;
    const prev = btn.innerHTML;
    btn.disabled = true; btn.textContent = "Generating…";
    try {
      const data = await bridge.engineeringBrief();
      if (!data) { showToast({ tone: "warn", title: "Could not generate", desc: "The local engine didn't return a brief.", timeout: 2600 }); return; }
      out.hidden = false;
      const counts = `<div class="goal-eu-counts">${Object.entries(data.counts).map(([k, v]) => `<b>${v}</b> ${k}`).join(" · ")}</div>`;
      out.innerHTML = counts + `<div id="euAudio"></div>` + renderMarkdown(data.brief);
      // P-BRIEF.4 (ADR-0113): synthesize the podcast to audio, played via a BLOB URL (a big WAV as a data:
      // URL often won't play in <audio>, even though it downloads fine - the reported bug) + a Download link.
      const provider = euProv?.value;
      if (provider === "openai-tts" || provider === "local-tts" || provider === "elevenlabs") {
        const slot = $("#euAudio", ov) as HTMLElement;
        slot.innerHTML = `<div class="goal-opt">${icon("spark", 11)} Synthesizing podcast audio…</div>`;
        const a = await bridge.engineeringBriefAudio(provider, euVoiceSel?.value || undefined).catch(() => null);
        if (a?.audioB64) {
          const url = audioBlobUrl(a.audioB64, a.mime);
          const ext = a.mime.includes("wav") ? "wav" : "mp3";
          slot.innerHTML =
            `<audio controls src="${url}" style="width:100%;margin:6px 0"></audio>` +
            `<a class="btn-mini" download="engineering-update.${ext}" href="${url}">${icon("download", 12)} Download ${ext.toUpperCase()}</a>`;
        } else {
          slot.innerHTML = `<div class="goal-opt">Audio not generated - ${esc(a?.note ?? "the TTS endpoint was unreachable")}.</div>`;
        }
      }
    } finally { btn.disabled = false; btn.innerHTML = prev; }
  });
  $("#goalRun", ov)?.addEventListener("click", async () => {
    const { goal, command, maxIters, budgetUsd, criteria, dial } = readSpec();
    if (!goal) { showToast({ tone: "warn", title: "Add a goal", desc: "Describe what the loop should accomplish.", timeout: 2400 }); return; }
    await applyRunWith(ov); // P-GOAL.7: apply base model / thinking / skill / persona for this run
    close();
    void runGoalLoop({ goal, condition: command || goal, command: command || undefined, maxIters, budgetUsd, criteria, dial });
  });
  $("#goalSave", ov)?.addEventListener("click", async () => {
    const { goal, command, maxIters } = readSpec();
    if (!goal) { showToast({ tone: "warn", title: "Add a goal", desc: "An automation needs a goal to pursue.", timeout: 2400 }); return; }
    const cadence = readCadence();
    if (!cadence) return;
    const a = await bridge.automationCreate({ goal, command: command || undefined, condition: command || goal, maxIters, cadence });
    if (a) { showToast({ tone: "ok", title: "Automation saved", desc: "It's disabled until you enable it below.", timeout: 2600 }); void renderAutomations(ov, close); }
    else showToast({ tone: "warn", title: "Could not save", desc: "Check the goal and schedule.", timeout: 2600 });
  });
  ($("#goalGoal", ov) as HTMLTextAreaElement)?.focus();
  // P-GOAL.4: offer to resume any loop that stopped without meeting its condition.
  void bridge.resumableLoops().then((loops) => {
    if (!loops?.length) return;
    const sec = $("#goalResumeSec", ov); if (!sec) return;
    sec.innerHTML = `<div class="goal-lbl">Resume a stopped loop</div>` + loops.slice(0, 5).map((l) =>
      `<button class="goal-resume" data-rel="${esc(l.rel)}" data-goal="${esc(l.goal)}" data-cond="${esc(l.condition)}" data-cmd="${esc(l.command ?? "")}">${icon("refresh", 12)} <span class="gr-goal">${esc(l.goal.slice(0, 64))}</span><span class="gr-iters">${l.iterations} iter</span></button>`).join("");
    sec.querySelectorAll(".goal-resume").forEach((b) => b.addEventListener("click", () => {
      const d = (b as HTMLElement).dataset; close();
      void runGoalLoop({ goal: d.goal!, condition: d.cond || d.goal!, command: d.cmd || undefined, maxIters: 6, resume: d.rel });
    }));
  });
  // P-GOAL.10 (ADR-0055): the cross-run evaluation banner (success rate / avg iters / top blocker).
  void loadLoopStats(ov).then(syncStats);
  // P-GOAL.12 (ADR-0057): the optional Pre-Flight Audit (design + readiness before building the loop).
  adoptedCriteria = "";
  $("#goalPreflight", ov)?.addEventListener("click", () => openPreflight(ov));
  // P-GOAL.5: list saved automations (enable / run-now / delete).
  void renderAutomations(ov, close);
  // P-GOAL.6: populate the checker-model picker (auto recommendation + override).
  void loadCheckerModel(ov);
  // P-GOAL.7: the "Run with" pickers (base model / thinking / skill / persona) + the usage ledger that
  // makes the cost estimate use the user's REAL per-model prices and cache rate.
  loadRunWith(ov);
  goalLedger = null;
  void bridge.usage().then((l) => { goalLedger = l; updateGoalEstimate(ov); });
}

// P-GOAL.7 (ADR-0049): the goal modal's "Run with" pickers. They drive the SAME session controls as the
// composer (base model + thinking via config; bundled skill via the active-skill path; AskSage persona),
// defaulting to the current session state, so the loop runs with exactly what's shown. Thinking and
// persona only appear when available.
function loadRunWith(ov: HTMLElement): void {
  // Base model - the maker. Options come from the session model config; changing it sets the session.
  const modelOpt = state.config.find((c) => c.id === "model");
  const modelSel = $("#goalModel", ov) as HTMLSelectElement | null;
  if (modelSel && modelOpt) {
    let opts = (modelOpt.options ?? []).filter((o) => !isAuxiliaryModel(o.value) && !/(^|[/-])rag$/i.test(o.value));
    // P-GOAL.8: under AskSage lockdown the base model must be AskSage-routed too - restrict to those, and
    // group by family in the order Gemini, GPT, Anthropic (GOV-suffixed first within each).
    const locked = !!state.asksage?.only;
    if (locked) {
      const gov = opts.filter((o) => isGovModel(o.value));
      if (gov.length) opts = gov;
    }
    if (locked) {
      modelSel.innerHTML = groupByFamily(sortGovFirstNewest(opts), GUIDED_GOV_FAMILY_ORDER)
        .map(({ fam, models }) => `<optgroup label="${esc(fam.label)}">` + models.map((o) => `<option value="${esc(o.value)}">${esc(o.name || o.value.split("/").pop() || o.value)}</option>`).join("") + `</optgroup>`).join("");
    } else {
      const byProv = new Map<string, { value: string; name?: string }[]>();
      for (const o of opts) { const p = o.value.split("/")[0]; (byProv.get(p) ?? byProv.set(p, []).get(p)!).push(o); }
      modelSel.innerHTML = [...byProv.entries()].map(([prov, list]) =>
        `<optgroup label="${esc(prov)}">` + list.map((o) => `<option value="${esc(o.value)}">${esc(o.name || o.value.split("/").pop() || o.value)}</option>`).join("") + `</optgroup>`).join("");
    }
    // Keep the session model selected if it survived the filter, else fall to the first allowed option.
    modelSel.value = opts.some((o) => o.value === modelOpt.currentValue) ? (modelOpt.currentValue ?? "") : (opts[0]?.value ?? "");
    ov.dataset.makerModel = modelSel.value;
    ov.dataset.makerName = modelOpt.options?.find((o) => o.value === modelSel.value)?.name || modelSel.value.split("/").pop() || modelSel.value;
    // Selecting only updates the cost estimate instantly; the session model is applied at Run time
    // (so just browsing the dropdown never mutates the live session).
    modelSel.addEventListener("change", () => {
      ov.dataset.makerModel = modelSel.value;
      ov.dataset.makerName = (modelOpt.options ?? []).find((o) => o.value === modelSel.value)?.name || modelSel.value.split("/").pop() || modelSel.value;
      updateGoalEstimate(ov);
    });
  }
  // Thinking - only if the provider exposes it. Applied at Run time.
  const thinkOpt = state.config.find((c) => c.id === "thinking");
  const thinkSel = $("#goalThink", ov) as HTMLSelectElement | null;
  if (thinkSel && thinkOpt?.options?.length) {
    ($("#goalThinkWrap", ov) as HTMLElement).hidden = false;
    thinkSel.innerHTML = thinkOpt.options.map((o) => `<option value="${esc(o.value)}">${esc(prettyLevel(o.name))}</option>`).join("");
    thinkSel.value = thinkOpt.currentValue ?? "";
  }
  // Skill - None + only the bundled skills that suit a goal loop (build/verify-oriented; meta ones like
  // Goal Loop / Loop Engineering / Plan are excluded). Trusted guidance that rides every loop turn.
  const skillSel = $("#goalSkill", ov) as HTMLSelectElement | null;
  if (skillSel) {
    const loopSkills = bundledSkillsByUsage().filter((s) => !GOAL_SKILL_DENY.has(s.command));
    skillSel.innerHTML = `<option value="">None</option>` + loopSkills.map((s) => `<option value="${esc(s.command)}">${esc(s.name)}</option>`).join("");
    skillSel.value = GOAL_SKILL_DENY.has(state.activeSkill?.command ?? "") ? "" : (state.activeSkill?.command ?? "");
  }
  // Persona - only if AskSage personas are available. Show the human name/description, not the numeric id.
  const personaSel = $("#goalPersona", ov) as HTMLSelectElement | null;
  if (personaSel && state.personas.length) {
    ($("#goalPersonaWrap", ov) as HTMLElement).hidden = false;
    personaSel.innerHTML = `<option value="">None</option>` + state.personas.map((p) => `<option value="${esc(p.id)}">${esc(personaTitle(p.description, p.id))}</option>`).join("");
    personaSel.value = state.asksage?.persona ?? "";
  }
}

// P-GOAL.7: apply the "Run with" selections to the session right before a loop runs - base model +
// thinking (config), bundled skill (active-skill path), AskSage persona. Only changes what actually
// differs from the current state, so a run with the defaults is a no-op. Best-effort; never blocks Run.
async function applyRunWith(ov: HTMLElement): Promise<void> {
  try {
    const modelSel = $("#goalModel", ov) as HTMLSelectElement | null;
    const cur = state.config.find((c) => c.id === "model")?.currentValue;
    if (modelSel?.value && modelSel.value !== cur) { await bridge.setConfig("model", modelSel.value); state.config = (await bridge.config()) ?? state.config; }
    const thinkSel = $("#goalThink", ov) as HTMLSelectElement | null;
    const curThink = state.config.find((c) => c.id === "thinking")?.currentValue;
    if (thinkSel && !thinkSel.closest("[hidden]") && thinkSel.value && thinkSel.value !== curThink) { await bridge.setConfig("thinking", thinkSel.value); state.config = (await bridge.config()) ?? state.config; }
    const skillSel = $("#goalSkill", ov) as HTMLSelectElement | null;
    if (skillSel && skillSel.value !== (state.activeSkill?.command ?? "")) { if (skillSel.value) await activateBundledSkill(skillSel.value); else await clearBundledSkill(); }
    const personaSel = $("#goalPersona", ov) as HTMLSelectElement | null;
    if (personaSel && !personaSel.closest("[hidden]") && personaSel.value !== (state.asksage?.persona ?? "")) { await bridge.applyPersona(personaSel.value || null); }
    updateComposerTools();
  } catch { /* best-effort: a failed apply must not block the loop */ }
}

// P-GOAL.6 (ADR-0048): fill the checker-model <select> with "Auto (recommended)" + the user's
// accessible models grouped by provider, select their saved choice, and persist changes.
async function loadCheckerModel(ov: HTMLElement): Promise<void> {
  const sel = $("#goalChecker", ov) as HTMLSelectElement | null;
  const why = $("#goalCkrWhy", ov); if (!sel) return;
  const info = await bridge.checkerModel();
  if (!info) { sel.innerHTML = `<option value="">Auto (recommended)</option>`; return; }
  const recName = info.options.find((o) => o.value === info.recommended)?.name || info.recommended.split("/").pop() || info.recommended;
  const byProvider = new Map<string, typeof info.options>();
  for (const o of info.options) { const p = o.value.split("/")[0]; (byProvider.get(p) ?? byProvider.set(p, []).get(p)!).push(o); }
  const groups = [...byProvider.entries()].map(([prov, opts]) =>
    `<optgroup label="${esc(prov)}">` + opts.map((o) => `<option value="${esc(o.value)}">${esc(o.name || o.value.split("/").pop() || o.value)}</option>`).join("") + `</optgroup>`).join("");
  sel.innerHTML = `<option value="">Auto (recommended: ${esc(recName)})</option>` + groups;
  sel.value = info.selected || "";
  const showWhy = () => { if (why) why.textContent = sel.value ? "" : (info.recommendedWhy || ""); };
  showWhy();
  // P-GOAL.6.1: stash the maker + recommended-checker names/values so the cost estimate can price + name them.
  ov.dataset.makerName = info.options.find((o) => o.value === info.current)?.name || info.current.split("/").pop() || info.current;
  ov.dataset.ckrRecName = recName;
  ov.dataset.ckrRecValue = info.recommended;
  updateGoalEstimate(ov);
  sel.addEventListener("change", async () => {
    const updated = await bridge.setCheckerModel(sel.value);
    if (updated && why) why.textContent = sel.value ? "" : (updated.recommendedWhy || "");
    updateGoalEstimate(ov);
  });
}

// P-GOAL.6.1 / P-GOAL.7 (ADR-0048/0049): the live cost estimate at the modal's lower-left - tokens AND a
// cache-rationalized dollar figure for the SELECTED base + checker models. Updates as iterations / models
// change; the premium tooltip (data-tip) explains the assumptions. The number is a CEILING - a loop
// usually stops earlier, the moment its condition holds.
function updateGoalEstimate(ov: HTMLElement): void {
  const box = $("#goalEstimate", ov); if (!box) return;
  const maxIters = Math.min(20, Math.max(1, Number(($("#goalMax", ov) as HTMLInputElement)?.value) || 6));
  const tok = estimateGoalTokens({ maxIters });
  // Maker = the selected base model; checker = the selected override, else the recommendation.
  const makerModel = (($("#goalModel", ov) as HTMLSelectElement | null)?.value) || ov.dataset.makerModel || "";
  const makerName = ov.dataset.makerName || makerModel.split("/").pop() || "your model";
  const ckrSel = $("#goalChecker", ov) as HTMLSelectElement | null;
  const checkerModel = ckrSel?.value || ov.dataset.ckrRecValue || makerModel;
  const checkerName = ckrSel?.value ? (ckrSel.options[ckrSel.selectedIndex]?.textContent || ckrSel.value) : (ov.dataset.ckrRecName || makerName);
  const makerP = priceFor(makerModel, goalLedger);
  const checkerP = priceFor(checkerModel, goalLedger);
  const rate = assumedCacheRate(goalLedger);
  const cost = estimateGoalCost({ maxIters, makerPrice: makerP.price, checkerPrice: checkerP.price, cacheRate: rate });
  box.innerHTML = `${icon("spark", 11)} <span class="ge-n">~${esc(formatUSD(cost.net))}</span> · ~${esc(formatTokens(tok.total))} tokens · ${tok.iters} loop${tok.iters === 1 ? "" : "s"}`;
  const priceNote = makerP.source === "actual" || checkerP.source === "actual" ? "your actual metered prices" : "list-price estimates";
  box.setAttribute("data-tip",
    `Estimated run cost|Up to ~${formatUSD(cost.net)} and ~${formatTokens(tok.total)} tokens across ${tok.iters} iteration${tok.iters === 1 ? "" : "s"}: ` +
    `maker ${makerName} (~${formatTokens(MAKER_TOKENS_PER_ITER)}/iter), checker ${checkerName} (~${formatTokens(CHECKER_TOKENS_PER_ITER)}/iter). ` +
    `Priced with ${priceNote}, after ~${Math.round(rate * 100)}% prompt-cache savings (about ${formatUSD(cost.savings)} saved). ` +
    `This is a ceiling; a loop usually stops earlier the moment its condition holds.`);
  box.setAttribute("data-tip-icon", "spark");
}

// P-GOAL.5 (ADR-0047): render the saved-automations list inside the goal modal - each row shows its
// cadence + last-run status, with an enable toggle, a run-now button, and delete.
// P-GOAL.10 (ADR-0055): render the cross-run evaluation banner from the run-log ledger - success rate,
// average iterations-to-success, the most-common blocker, and a tool-mix bar. Hidden until there's
// history (a first-time user sees nothing extra).
async function loadLoopStats(ov: HTMLElement): Promise<void> {
  const sec = $("#goalStatsSec", ov); if (!sec) return;
  // P-GOAL.14 (ADR-0112): fetch cross-run stats AND the list of past After-Action Reports together.
  const [data, reports] = await Promise.all([
    bridge.loopRunStats().catch(() => null),
    bridge.pastReports().catch(() => null),
  ]);
  const s = data?.stats;
  let html = "";
  if (s && s.runs > 0) {
    const pct = Math.round(s.successRate * 100);
    const tone = pct >= 75 ? "ok" : pct >= 40 ? "mid" : "low";
    const iters = s.avgItersToSucceed ? `${s.avgItersToSucceed.toFixed(1)}` : "-";
    const dur = s.avgDurationMs ? formatLoopDur(s.avgDurationMs) : "-";
    const blocker = s.topBlockers[0];
    const spend = s.totalSpendUsd > 0 ? `<span class="gs-tool">spend <b>$${s.totalSpendUsd.toFixed(2)}</b></span>` : "";
    const mix = spend + Object.entries(s.toolsByType).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, v]) => `<span class="gs-tool">${esc(k)} <b>${v}</b></span>`).join("");
    html += `<div class="goal-stats" data-tone="${tone}">
      <div class="gs-head">${icon("graph", 13)} Loop history <span class="gs-sum">${esc(data!.summary)}</span><span class="gs-caret">${icon("chevron", 12)}</span></div>
      <div class="gs-grid">
        <div class="gs-cell"><span class="gs-n">${pct}%</span><span class="gs-l">met</span></div>
        <div class="gs-cell"><span class="gs-n">${esc(iters)}</span><span class="gs-l">avg iters to win</span></div>
        <div class="gs-cell"><span class="gs-n">${esc(dur)}</span><span class="gs-l">avg duration</span></div>
        <div class="gs-cell"><span class="gs-n">${s.totalTools}</span><span class="gs-l">tool calls</span></div>
      </div>
      ${mix ? `<div class="gs-mix">${mix}</div>` : ""}
      ${blocker ? `<div class="gs-blocker">${icon("info", 11)} most-common stop: <span>${esc(blocker.reason.slice(0, 90))}</span>${blocker.count > 1 ? ` ·&nbsp;${blocker.count}×` : ""}</div>` : ""}
    </div>`;
  }
  // P-GOAL.14: the browsable list of past After-Action Reports (each opens its full markdown). Shown
  // whenever report files exist, even if the run-log ledger is empty (older loops predate the ledger).
  if (reports && reports.length) {
    const rows = reports.slice(0, 30).map((r) => {
      const when = r.updatedAt ? new Date(r.updatedAt).toLocaleString() : "";
      return `<button type="button" class="gr-row" data-report-rel="${esc(r.rel)}">
        <span class="gr-outcome">${esc(r.outcome || "report")}</span>
        <span class="gr-goal">${esc(r.goal)}</span>
        <span class="gr-when">${esc(when)}</span>
      </button>`;
    }).join("");
    html += `<details class="goal-stats goal-reports"${s && s.runs ? "" : " open"}>
      <summary class="gs-head">${icon("graph", 13)} Past After-Action Reports <span class="gs-sum">${reports.length} saved</span></summary>
      <div class="gr-list">${rows}</div>
    </details>`;
  }
  sec.innerHTML = html;
  sec.querySelectorAll<HTMLElement>("[data-report-rel]").forEach((b) =>
    b.addEventListener("click", () => void openReportViewer(b.dataset.reportRel!)));
}

/** P-GOAL.14 (ADR-0112): open one saved After-Action Report's full markdown in a viewer modal. */
async function openReportViewer(rel: string): Promise<void> {
  const r = await bridge.pastReport(rel).catch(() => null);
  if (!r) { showToast({ tone: "warn", title: "Could not open", desc: "The report file wasn't found.", timeout: 2400 }); return; }
  const ov = el(`<div class="goal-scrim"><div class="goal-modal aar-viewer">
    <div class="goal-modal-h"><span class="goal-h-title">${icon("graph", 15)} After-Action Report</span>
      <span style="margin-left:auto;display:flex;gap:6px">
        <button type="button" class="btn-mini" id="arListen" data-tip="Narrate this report (Settings → Voice sets the engine)">${icon("volume", 12)} Listen</button>
        <button type="button" class="btn-mini" id="arClose">Close</button></span></div>
    <div class="goal-modal-sub"><code>${esc(rel)}</code></div>
    <div class="goal-aar-body">${renderMarkdown(r.markdown)}</div>
  </div></div>`);
  document.body.appendChild(ov);
  const close = () => { if (ttsAudio && !ttsAudio.paused) { ttsAudio.pause(); ttsAudio = null; } ov.remove(); };
  $("#arClose", ov)?.addEventListener("click", close);
  // P-VOICE.1 (ADR-0115): narrate the report's readable text (no markdown/table symbols).
  $("#arListen", ov)?.addEventListener("click", (e) => {
    const plain = ($(".goal-aar-body", ov) as HTMLElement | null)?.innerText?.trim() ?? "";
    void speakText(plain, e.currentTarget as HTMLElement);
  });
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
}

// ── P-REPORT.1 (ADR-0116): the Engineering Reports rail panel ─────────────────
// Available to every role. Generate a role-tailored brief (with optional podcast audio), and browse every
// past loop After-Action Report + saved brief. Reuses the P-VOICE.1 audio (blob-URL player) + TTS.
const REPORT_TTS_COST: Record<string, string> = {
  elevenlabs: `${icon("info", 11)}<span>ElevenLabs bills per character. Generating this report's audio costs <b>about $0.10 (~10¢)</b> each time.</span>`,
  "openai-tts": `${icon("info", 11)}<span>OpenAI TTS bills per character. Generating this report's audio costs <b>about $0.10</b> each time.</span>`,
};

/** P-REPORT.2: copy report markdown to the clipboard + download it as a .md file. */
function reportFilename(title: string): string {
  return `${(title || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report"}.md`;
}
async function copyMarkdown(md: string): Promise<void> {
  try { await navigator.clipboard.writeText(md); showToast({ title: "Copied", desc: "Report markdown is on your clipboard.", timeout: 1600 }); }
  catch { showToast({ tone: "danger", title: "Copy failed", desc: "Clipboard unavailable in this view.", timeout: 2400 }); }
}
function downloadMarkdown(md: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** P-REPORT.3 (ADR-0117): push a report into the personalization KG. Compartment = an unlocked one; if only
 *  one is unlocked it's the default, otherwise a popover lets the user pick (work / personal / cui). */
async function pushReportToKg(kind: string, rel: string, archived: boolean, anchor: HTMLElement): Promise<void> {
  const st = await bridge.personal().catch(() => null);
  if (!st?.enabled) { showToast({ tone: "warn", title: "Personalization is off", desc: "Turn it on in Settings → Personalization to push reports to your knowledge graph.", timeout: 3400 }); return; }
  const targets: { scope: string; label: string }[] = [];
  if (st.unlocked) targets.push({ scope: "work", label: "Work graph" }, { scope: "personal", label: "Personal graph" });
  if (st.cuiUnlocked) targets.push({ scope: "cui", label: "CUI graph" });
  if (!targets.length) { showToast({ tone: "warn", title: "Knowledge graph locked", desc: "Unlock a compartment in Settings → Personalization first.", timeout: 3600 }); return; }
  const push = async (scope: string, label: string): Promise<void> => {
    const r = await bridge.reportToKg(kind, rel, scope, archived).catch(() => null);
    showToast(r?.ok
      ? { title: "Pushed to the knowledge graph", desc: `Saved to your ${label} as a report node.`, timeout: 2600 }
      : { tone: "warn", title: "Not pushed", desc: r?.error || "Could not write to the knowledge graph.", timeout: 3600 });
  };
  if (targets.length === 1) { await push(targets[0]!.scope, targets[0]!.label); return; }
  const { node, close } = popover(anchor, `<div class="kg-pick"><div class="kg-pick-h">Push to which graph?</div>${targets.map((t) => `<button type="button" class="kg-pick-opt" data-scope="${t.scope}">${icon("graph", 12)} ${esc(t.label)}</button>`).join("")}</div>`);
  node.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-scope]") as HTMLElement | null; if (!b) return;
    close(); void push(b.dataset.scope!, targets.find((t) => t.scope === b.dataset.scope)?.label ?? b.dataset.scope!);
  });
}

/** Open one Reports-list entry (a loop AAR or a saved brief): Listen, Copy, Download .md (+ Archive/Delete
 *  via the row actions). `archived` reads from the archive store. `onChange` refreshes the list on lifecycle. */
// ── P-REPORT.4: premium report-body enhancer (viewer only) ──
// Rendered report markdown carries a duplicate title H1, an emoji outcome badge, and unrenderable
// ASCII / mermaid "charts". In the viewer we (1) drop the doubled H1 (the modal header already shows
// the title), (2) swap the emoji for a custom SVG badge, and (3) turn every ASCII scoreboard + mermaid
// pie/bar block into a colour bar chart with a plasma-on-hover fill. Purely presentational - the stored
// markdown bytes are untouched (loop_report stays byte-stable / test-frozen).
const OUTCOME_ICON: Record<string, { glyph: string; cls: string }> = {
  "✅": { glyph: "checkBadge", cls: "ro-met" },
  "⏹️": { glyph: "stopBadge", cls: "ro-stopped" },
  "⏹": { glyph: "stopBadge", cls: "ro-stopped" },
  "🛑": { glyph: "stopBadge", cls: "ro-cancelled" },
  "❗": { glyph: "alertBadge", cls: "ro-error" },
};
const CHART_PALETTE = ["var(--blue)", "var(--green)", "var(--accent-2)", "var(--cyan)", "var(--amber)", "#8aa6f5", "#e07bf0"];
function scoreColor(label: string, i: number): string {
  const l = label.toLowerCase();
  if (l.includes("add")) return "var(--green)";
  if (l.includes("remov") || l.includes("delet")) return "var(--red)";
  if (l.includes("error")) return "var(--amber)";
  if (l.includes("website") || l.includes("site") || l.includes("visit")) return "var(--accent-2)";
  if (l.includes("tool") || l.includes("call")) return "var(--blue)";
  return CHART_PALETTE[i % CHART_PALETTE.length];
}
type ChartRow = { label: string; val: string; num: number };
function buildScoreChart(rows: ChartRow[]): HTMLElement {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.num)));
  return el(`<div class="rchart">${rows.map((r, i) => {
    const pct = Math.max(2.5, Math.round((Math.abs(r.num) / max) * 100));
    return `<div class="rchart-row" style="--c:${scoreColor(r.label, i)}">
      <span class="rchart-lbl" title="${esc(r.label)}">${esc(r.label)}</span>
      <span class="rchart-track"><i class="rchart-fill" style="width:${pct}%"></i></span>
      <b class="rchart-val">${esc(r.val)}</b></div>`;
  }).join("")}</div>`);
}
/** Parse an ASCII scoreboard / mermaid pie / mermaid xychart code block into chart rows, or null. */
function parseChartRows(text: string): ChartRow[] | null {
  const t = (text || "").trim();
  if (/[█░]/.test(t)) { // ASCII scoreboard: "Label   ██░░  value"
    const rows = t.split("\n").map((line) => {
      const m = /^(.+?)\s+[█░]+\s+([+-]?\d[\d,]*)\s*$/.exec(line.trimEnd());
      return m ? { label: m[1].trim(), val: m[2], num: Number(m[2].replace(/[+,]/g, "")) } : null;
    }).filter(Boolean) as ChartRow[];
    return rows.length ? rows : null;
  }
  if (/^pie\b/.test(t)) { // mermaid pie:  "Label" : value
    const rows: ChartRow[] = [];
    for (const line of t.split("\n")) {
      const m = /^\s*"(.+?)"\s*:\s*([\d.]+)/.exec(line);
      if (m) rows.push({ label: m[1], val: m[2], num: Number(m[2]) });
    }
    return rows.length ? rows : null;
  }
  if (/xychart/.test(t)) { // mermaid xychart-beta:  x-axis [..] + bar [..]
    const xs = /x-axis\s*\[(.+?)\]/.exec(t)?.[1], bars = /bar\s*\[(.+?)\]/.exec(t)?.[1];
    if (xs && bars) {
      const labels = xs.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
      const vals = bars.split(",").map((s) => Number(s.trim()));
      const rows = labels.map((label, i) => ({ label, val: String(vals[i] ?? 0), num: vals[i] ?? 0 }));
      return rows.length ? rows : null;
    }
  }
  return null;
}
// P-REPORT.8: reconstruct the change graph / schema map from OUR Mermaid (single source of truth in the
// stored .md) so the viewer can render the styled SVG while keeping the exact Mermaid copyable for draw.io.
function parseChangeGraphMermaid(text: string): ChangeGraph {
  const modules: ModuleChange[] = [], edges: GraphEdge[] = [];
  for (const line of text.split("\n")) {
    let m = /^\s*(\w+)\["(.+?)"\]:::(added|removed|changed)/.exec(line);
    if (m) {
      const lm = /^(.*?)\s*\+(\d+)\/-(\d+)\s*\((\d+)f\)$/.exec(m[2]);
      modules.push({ id: m[1], label: lm ? lm[1].trim() : m[2], added: lm ? +lm[2] : 0, removed: lm ? +lm[3] : 0, files: lm ? +lm[4] : 0, status: m[3] as ModuleChange["status"] });
      continue;
    }
    m = /^\s*(\w+)\s*-->\s*(\w+)/.exec(line);
    if (m && !/:::/.test(line)) edges.push({ from: m[1], to: m[2] });
  }
  return { modules, edges, range: "", totalAdded: 0, totalRemoved: 0, totalFiles: 0 };
}
function parseSchemaMermaid(text: string): StoreChange[] {
  const stores = new Map<string, string>(), files = new Map<string, { path: string; added: number; removed: number }>(), links: [string, string][] = [];
  for (const line of text.split("\n")) {
    let m = /^\s*(\w+)\[\("(.+?)"\)\]:::store/.exec(line);
    if (m) { stores.set(m[1], m[2]); continue; }
    m = /^\s*(\w+)\["(.+?)"\]:::(grew|shrank)/.exec(line);
    if (m) { const lm = /^(.*?)\s*\+(\d+)\/-(\d+)$/.exec(m[2]); files.set(m[1], { path: lm ? lm[1].trim() : m[2], added: lm ? +lm[2] : 0, removed: lm ? +lm[3] : 0 }); continue; }
    m = /^\s*(\w+)\s*-->\s*(\w+)/.exec(line);
    if (m) links.push([m[1], m[2]]);
  }
  const out = new Map<string, StoreChange>();
  for (const [fid, sid] of links) {
    const store = stores.get(sid), f = files.get(fid); if (!store || !f) continue;
    const sc = out.get(store) ?? { store, files: [], added: 0, removed: 0 };
    sc.files.push({ path: f.path, added: f.added, removed: f.removed, status: "M" }); sc.added += f.added; sc.removed += f.removed;
    out.set(store, sc);
  }
  return [...out.values()];
}
/** A rendered graph block: the styled SVG image + a Copy-Mermaid button (draw.io) + the raw code (collapsible). */
function renderGraphBlock(mermaidText: string, svg: string): HTMLElement {
  const wrap = el(`<div class="cg-block">
    <div class="cg-image">${svg || '<div class="goal-opt">Diagram unavailable.</div>'}</div>
    <div class="cg-tools"><button type="button" class="btn-mini cg-copy">${icon("copy", 13)} Copy Mermaid (draw.io)</button></div>
    <details class="cg-code"><summary>Mermaid source</summary><pre><code></code></pre></details>
  </div>`);
  ($(".cg-code code", wrap) as HTMLElement).textContent = mermaidText;
  $(".cg-copy", wrap)?.addEventListener("click", () => void copyMarkdown(mermaidText));
  return wrap;
}
function enhanceReportBody(body: HTMLElement | null, _title: string): void {
  if (!body) return;
  const h1 = body.querySelector("h1"); // drop the leading title H1 (header already shows it)
  if (h1 && !h1.previousElementSibling) h1.remove();
  for (const strong of Array.from(body.querySelectorAll("strong")).slice(0, 4)) { // outcome emoji → SVG badge
    const txt = strong.textContent ?? "";
    const key = Object.keys(OUTCOME_ICON).find((e) => txt.startsWith(e));
    if (!key) continue;
    const { glyph, cls } = OUTCOME_ICON[key];
    strong.classList.add("ro-badge", cls);
    strong.innerHTML = `${icon(glyph, 17)}<span>${esc(txt.slice(key.length).trim())}</span>`;
    break;
  }
  for (const pre of Array.from(body.querySelectorAll("pre"))) { // graphs (our mermaid) → styled SVG; charts → bars
    const txt = pre.textContent ?? "";
    if (/%%\s*lucid:changegraph/.test(txt)) { pre.replaceWith(renderGraphBlock(txt, changeGraphSvg(parseChangeGraphMermaid(txt)))); continue; }
    if (/%%\s*lucid:schema/.test(txt)) { pre.replaceWith(renderGraphBlock(txt, schemaSvg(parseSchemaMermaid(txt)))); continue; }
    const rows = parseChartRows(txt);
    if (rows) pre.replaceWith(buildScoreChart(rows));
  }
  // P-REPORT.8: each Annex starts on a new printed page (page-break honored by the print CSS).
  for (const h of Array.from(body.querySelectorAll("h2"))) if (/^\s*annex\b/i.test(h.textContent ?? "")) h.classList.add("annex-break");
}

// P-REPORT.5: print / save-as-PDF. The on-screen viewer is dark; paper wants the opposite. We drop the
// already-enhanced report HTML (light-friendly classes: headings, tables, .rchart bars, .ro-badge) into a
// hidden same-origin iframe with a SELF-CONTAINED light stylesheet (white bg, dark text, print-safe colours,
// no glows), then invoke the OS print dialog - which offers "Save as PDF" as well as any printer.
const PRINT_CSS = `
  @page{margin:16mm}
  :root{--txt:#14181d;--txt-1:#1b1f26;--txt-2:#3b424b;--txt-3:#5b626d;--txt-4:#8b929c;
    --bg-1:#fff;--bg-2:#f4f6f9;--bg-3:#e9ecf1;--bg-4:#dfe3e9;--line:#d6dae1;--line-soft:#e5e8ed;--line-strong:#c6ccd4;
    --accent:#6f3ccb;--accent-2:#9350d6;--green:#1f9b57;--red:#cf4139;--blue:#2f6cd0;--cyan:#1789a2;--amber:#bd8619;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  html,body{background:#fff;color:var(--txt-1);margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:11.5pt;line-height:1.62}
  .print-title{font-size:19pt;font-weight:700;margin:0 0 3pt;color:#0f1216;letter-spacing:-.01em}
  .print-sub{font-size:9pt;color:var(--txt-4);font-family:var(--mono);margin:0 0 14pt;padding-bottom:10pt;border-bottom:1px solid var(--line)}
  .report h1{font-size:14pt;margin:2pt 0 8pt;padding-bottom:5pt;border-bottom:1px solid var(--line);font-weight:700}
  .report h2{font-size:10pt;text-transform:uppercase;letter-spacing:.05em;color:var(--txt-2);font-weight:700;margin:18pt 0 7pt;padding-left:9pt;border-left:3px solid var(--accent);break-after:avoid}
  .report h3{font-size:11.5pt;margin:12pt 0 5pt;font-weight:650}
  .report p{margin:0 0 8pt}
  .report ul,.report ol{margin:0 0 9pt;padding-left:18pt}
  .report li{margin:3pt 0}
  .report li::marker{color:var(--accent)}
  .report strong,.report b{font-weight:660;color:#0f1216}
  .report a{color:var(--accent);text-decoration:underline}
  .report code{font-family:var(--mono);font-size:.86em;background:var(--bg-3);border:1px solid var(--line);border-radius:4px;padding:.5pt 4pt}
  .report pre{background:var(--bg-2);border:1px solid var(--line);border-radius:8px;padding:9pt 11pt;margin:0 0 10pt;overflow:hidden;white-space:pre-wrap;word-break:break-word;break-inside:avoid}
  .report pre code{background:none;border:0;padding:0;font-size:9.5pt}
  .report hr{border:0;border-top:1px solid var(--line);margin:12pt 0}
  .report blockquote{margin:0 0 9pt;padding:2pt 0 2pt 11pt;border-left:3px solid var(--line-strong);color:var(--txt-2)}
  .report table{border-collapse:collapse;width:100%;margin:0 0 10pt;font-size:10.5pt;break-inside:avoid}
  .report th,.report td{border:1px solid var(--line);padding:5pt 8pt;text-align:left;vertical-align:top}
  .report th{background:var(--bg-3);font-weight:640}
  .ro-badge{display:inline-flex;align-items:center;gap:5pt;padding:2pt 9pt 2pt 6pt;border-radius:7px;font-weight:640;
    background:color-mix(in srgb,var(--tc,var(--green)) 15%,#fff);border:1px solid color-mix(in srgb,var(--tc,var(--green)) 40%,var(--line));color:var(--tc,var(--green))}
  .ro-badge svg{width:14px;height:14px}
  .ro-badge.ro-met{--tc:var(--green)}.ro-badge.ro-stopped{--tc:var(--amber)}.ro-badge.ro-cancelled{--tc:var(--red)}.ro-badge.ro-error{--tc:var(--red)}
  .rchart{display:flex;flex-direction:column;gap:8pt;margin:0 0 11pt;padding:11pt 13pt;border:1px solid var(--line);border-radius:10px;background:var(--bg-2);break-inside:avoid}
  .rchart-row{display:grid;grid-template-columns:96pt 1fr auto;align-items:center;gap:10pt;break-inside:avoid}
  .rchart-lbl{font-size:10pt;color:var(--txt-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rchart-track{position:relative;height:11pt;border-radius:6px;overflow:hidden;background:color-mix(in srgb,var(--c) 12%,var(--bg-4))}
  .rchart-fill{display:block;height:100%;border-radius:6px;min-width:4pt;background:linear-gradient(90deg,color-mix(in srgb,var(--c) 70%,#000),var(--c))}
  .rchart-val{font-family:var(--mono);font-size:10.5pt;font-weight:700;color:color-mix(in srgb,var(--c) 78%,#000);min-width:30pt;text-align:right}
  .tldr-model,.tldr-body{color:var(--txt-2)}
  .print-foot{position:fixed;bottom:6mm;left:0;right:0;font-size:8pt;color:#777;font-family:-apple-system,"Segoe UI",Roboto,sans-serif}
  /* P-REPORT.8: each Annex starts a new page; the styled graph SVG prints as an image (its Mermaid source is hidden in print). */
  .annex-break{break-before:page;page-break-before:always}
  .cg-block{border:1px solid var(--line);border-radius:10px;background:var(--bg-2);margin:0 0 12pt;padding:8pt;break-inside:avoid}
  .cg-image{overflow:visible}
  .cg-svg{width:100%;height:auto}
  .cg-tools,.cg-code{display:none}
`;
function printReport(title: string, bodyHtml: string): void {
  // "Prepared for" identity: corporate email if set, else the attribution identity (workstation-name fallback).
  const who = (state.email || state.attribution?.identity || state.attribution?.workstation || "").trim();
  const foot = who ? `<div class="print-foot">Prepared for: ${esc(who)}</div>` : "";
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head>`
    + `<body><h1 class="print-title">${esc(title)}</h1><div class="report">${bodyHtml}</div>${foot}</body></html>`;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(iframe);
  const cw = iframe.contentWindow;
  if (!cw) { iframe.remove(); return; }
  cw.document.open(); cw.document.write(doc); cw.document.close();
  const fire = () => { try { cw.focus(); cw.print(); } catch { /* print unavailable */ } setTimeout(() => iframe.remove(), 1500); };
  // give layout + web fonts a beat so the first page isn't blank
  if (cw.document.readyState === "complete") setTimeout(fire, 150);
  else iframe.addEventListener("load", () => setTimeout(fire, 150));
}

async function openReportEntry(kind: string, rel: string, title: string, archived = false): Promise<void> {
  const r = await bridge.report(kind, rel, archived).catch(() => null);
  if (!r) { showToast({ tone: "warn", title: "Could not open", desc: "The report file wasn't found.", timeout: 2400 }); return; }
  const ov = el(`<div class="goal-scrim"><div class="goal-modal aar-viewer">
    <div class="goal-modal-h"><span class="goal-h-title">${esc(title)}</span>
      <span class="re-acts">
        <button type="button" class="btn-mini" id="reListen" data-tip="Read this report aloud · ${modCombo("Space")}|Synthesizes the FULL report on demand (Settings → Voice). On ElevenLabs this runs ~$0.50-1.50; a podcast summary is shorter and cheaper. Press ${modCombo("Space")} to toggle.">${icon("headphones", 16)} Listen</button>
        <button type="button" class="btn-mini" id="reCopy" data-tip="Copy the report markdown">${icon("copy", 16)} Copy</button>
        <button type="button" class="btn-mini" id="reDownload" data-tip="Download as .md">${icon("download", 16)} .md</button>
        <button type="button" class="btn-mini" id="rePrint" data-tip="Print, or save as PDF - opens the system dialog with a clean white layout">${icon("print", 16)} Print</button>
        <button type="button" class="btn-mini" id="reKg" data-tip="Push to the knowledge graph">${icon("graph", 16)} KG</button>
        <button type="button" class="btn-mini re-close" id="reClose" data-tip="Close">${icon("close", 16)}</button></span></div>
    <div class="goal-modal-sub"><code>${esc(rel)}</code></div>
    <div class="re-note">${icon("info", 12)}<span><b>Listen</b> narrates the whole report (ElevenLabs runs about <b>$0.50-1.50</b>); a <b>podcast summary</b> is shorter and cheaper. For a free, natural-sounding two-host podcast, <a href="#" id="reNotebook">open it in NotebookLM ↗</a> - the report is copied so you can paste it in.</span></div>
    <div class="goal-aar-body">${renderMarkdown(r.markdown)}</div>
  </div></div>`);
  document.body.appendChild(ov);
  const bodyEl = $(".goal-aar-body", ov) as HTMLElement;
  enhanceReportBody(bodyEl, title); // dedupe title H1, custom badges + score chart
  $("#reNotebook", ov)?.addEventListener("click", async (e) => {
    e.preventDefault();
    await copyMarkdown(r.markdown).catch(() => {});
    window.open("https://notebooklm.google.com", "_blank", "noopener");
    showToast({ title: "Report copied · NotebookLM opened", desc: "In NotebookLM, add a source (paste the report or upload the .md), then click Audio Overview to generate a podcast.", actions: [{ label: "OK" }], timeout: 6000 });
  });
  // Ctrl/⌘+Space toggles read-aloud while the report is open (mirrors the reListen button + its tooltip).
  const onKey = (ev: KeyboardEvent) => {
    if ((ev.ctrlKey || ev.metaKey) && (ev.code === "Space" || ev.key === " ")) {
      ev.preventDefault();
      ($("#reListen", ov) as HTMLElement | null)?.click();
    }
  };
  document.addEventListener("keydown", onKey);
  const close = () => { document.removeEventListener("keydown", onKey); if (ttsAudio && !ttsAudio.paused) { ttsAudio.pause(); ttsAudio = null; } ov.remove(); };
  $("#reClose", ov)?.addEventListener("click", close);
  $("#rePrint", ov)?.addEventListener("click", () => printReport(title, bodyEl.innerHTML));
  $("#reListen", ov)?.addEventListener("click", (e) => {
    const plain = ($(".goal-aar-body", ov) as HTMLElement | null)?.innerText?.trim() ?? "";
    void speakText(plain, e.currentTarget as HTMLElement);
  });
  $("#reCopy", ov)?.addEventListener("click", () => void copyMarkdown(r.markdown));
  $("#reDownload", ov)?.addEventListener("click", () => downloadMarkdown(r.markdown, reportFilename(title)));
  $("#reKg", ov)?.addEventListener("click", (e) => void pushReportToKg(kind, rel, archived, e.currentTarget as HTMLElement));
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
}

function openReportsPanel(): void {
  // Single instance: a second click on the rail glyph TOGGLES (closes) it instead of stacking another panel
  // (stacked panels also collided on the rpRole/rpProvider/rpVoice ids - the duplicate-id warning).
  const open = document.querySelector(".reports-modal")?.closest(".goal-scrim");
  if (open) { if (ttsAudio && !ttsAudio.paused) { ttsAudio.pause(); ttsAudio = null; } open.remove(); return; }
  const curRole = state.userRole ?? "developer";
  const rOpt = (r: string, label: string) => `<option value="${r}"${r === curRole ? " selected" : ""}>${label}</option>`;
  const ov = el(`<div class="goal-scrim"><div class="goal-modal reports-modal">
    <div class="goal-modal-h"><span class="goal-h-title">${icon("report", 15)} Engineering Reports</span><button type="button" class="btn-mini" id="rpClose">Close</button></div>
    <div class="goal-modal-sub">Generate a role-tailored engineering brief from the app's DECISIONS + PROGRESS logs, with optional podcast audio. Every past loop After-Action Report and saved brief is listed on the right.</div>
    <div class="reports-grid">
      <div class="rp-gen">
        <div class="goal-row"><label class="goal-lbl" for="rpRole">Report for</label>
          <select id="rpRole" class="prov-key">${rOpt("developer", "Developer")}${rOpt("security", "Security")}${rOpt("manager", "Manager")}${rOpt("executive", "Executive")}</select></div>
        <div class="goal-row"><label class="goal-lbl" for="rpProvider">Audio</label>
          <select id="rpProvider" class="prov-key">
            <option value="script-only">Script only (no audio)</option>
            <option value="elevenlabs">ElevenLabs · custom voices</option>
            <option value="openai-tts">ChatGPT · OpenAI TTS</option>
            <option value="local-tts">Local TTS · Kokoro (air-gap)</option>
          </select></div>
        <div class="goal-row" id="rpVoiceRow" hidden><label class="goal-lbl" for="rpVoice">Voice</label><select id="rpVoice" class="prov-key"><option value="">default voice</option></select></div>
        <div class="goal-eu-cost" id="rpCost" hidden></div>
        <div class="rp-repos" id="rpRepos">
          <div class="rp-repos-h" id="rpReposH" role="button" tabindex="0" aria-expanded="true" data-tip="Repositories|Click to collapse or expand. Collapses automatically after you generate a report so the snapshot below is in view.">
            <span class="rp-chev" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
            <label class="goal-lbl">${icon("git", 12)} Repositories</label><span class="goal-opt rp-repos-hint">tick repos to fold their remote commits &amp; PRs into the report</span>
            <span class="rp-repos-count" id="rpReposCount"></span>
            <select id="rpRepoSort" class="rp-repo-sort" data-tip="Sort order|Order the repo list by most recent activity, or alphabetically by name"><option value="recent">Recent</option><option value="name">Name</option></select></div>
          <div class="rp-repo-list" id="rpRepoList"><div class="goal-opt">loading repos…</div></div>
          <div class="rp-repo-add">
            <input id="rpRepoAdd" class="prov-key" placeholder="Add a repo: local path or https:// clone URL" />
            <button type="button" class="btn-mini" id="rpRepoAddBtn">${icon("plus", 12)} Add</button>
          </div>
          <label class="rp-repo-fetch"><input type="checkbox" id="rpFetch" checked /> <span>Fetch latest from remotes first <span class="goal-opt">(read-only · never modifies your working tree)</span></span></label>
        </div>
        <div class="rp-nb-tip">${icon("info", 11)}<span>Want a free, natural-sounding two-host podcast? Generate the report, then <a href="https://notebooklm.google.com" target="_blank" rel="noopener" id="rpNotebook">open NotebookLM ↗</a> and paste it in for an Audio Overview.</span></div>
        <button type="button" class="btn-mini ok rp-generate" id="rpGenerate">${icon("bolt", 15)} Generate report</button>
        <button type="button" class="btn-mini rp-evalrollup" id="rpEvalRollup" data-tip="Model-Evaluation rollup|Build a cross-run report from the metrics captured by each 'Generate engineering report' (per-model efficiency/quality means, honest null-not-zero) plus the per-model API-latency p50/p95. Reads the on-device ledger only.">${icon("report", 14)} Model-Evaluation rollup</button>
        <div class="rp-sec-exports" id="rpSecExports" hidden>
          <button type="button" class="btn-mini" id="rpPoam" data-tip="Export a Plan of Actions & Milestones (eMASS-aligned CSV) from the security control crosswalk. Draft - validate mappings against your baseline.">${icon("download", 12)} POA&M (CSV)</button>
          <button type="button" class="btn-mini" id="rpCkl" data-tip="Export a STIG Viewer checklist (.ckl) of the control crosswalk. Draft - synthetic Vuln IDs keyed by CCI, for analyst validation.">${icon("download", 12)} STIG (.ckl)</button>
        </div>
        <div class="goal-eu-result" id="rpResult" hidden></div>
      </div>
      <div class="rp-past">
        <div class="rp-past-h">
          <span class="rp-tabs" id="rpTabs"><button type="button" class="rp-tab on" data-tab="active">Active</button><button type="button" class="rp-tab" data-tab="archived">Archived</button></span>
          <span class="gs-sum" id="rpCount"></span></div>
        <div class="rp-list" id="rpList"><div class="goal-opt">loading…</div></div>
      </div>
    </div>
  </div></div>`);
  document.body.appendChild(ov);
  const close = () => { if (ttsAudio && !ttsAudio.paused) { ttsAudio.pause(); ttsAudio = null; } ov.remove(); };
  $("#rpClose", ov)?.addEventListener("click", close);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });

  // provider → voice picker + cost note (ElevenLabs only), lazy-loading voices so a voice is chosen pre-Generate.
  const prov = $("#rpProvider", ov) as HTMLSelectElement;
  const voiceRow = $("#rpVoiceRow", ov) as HTMLElement;
  const voiceSel = $("#rpVoice", ov) as HTMLSelectElement;
  const cost = $("#rpCost", ov) as HTMLElement;
  let voicesLoaded = false;
  const sync = async (): Promise<void> => {
    const p = prov.value;
    voiceRow.hidden = p !== "elevenlabs";
    const c = REPORT_TTS_COST[p]; cost.hidden = !c; cost.innerHTML = c ?? "";
    if (p === "elevenlabs" && !voicesLoaded) {
      voicesLoaded = true;
      const data = await bridge.voices().catch(() => null);
      if (data?.voices?.length) {
        const favs = new Set(data.favorites);
        const opt = (v: import("./bridge.ts").ElevenVoiceView) => `<option value="${esc(v.voiceId)}"${v.voiceId === data.selected ? " selected" : ""}>${esc(v.name)}${v.category ? ` · ${esc(v.category)}` : ""}</option>`;
        const fav = data.voices.filter((v) => favs.has(v.voiceId)), rest = data.voices.filter((v) => !favs.has(v.voiceId));
        voiceSel.innerHTML = `<option value="">default voice</option>` + (fav.length ? `<optgroup label="★ Favorites">${fav.map(opt).join("")}</optgroup>` : "") + `<optgroup label="All voices">${rest.map(opt).join("")}</optgroup>`;
      } else { voiceSel.innerHTML = `<option value="">${esc(data?.note || "add an ElevenLabs key in Settings → Voice")}</option>`; voicesLoaded = false; }
    }
  };
  prov.addEventListener("change", () => void sync());
  void sync();

  // P-REPORT.6/.8: the POA&M (eMASS CSV) + STIG (.ckl) exports are Security-report artifacts - show only for that role.
  const roleSel = $("#rpRole", ov) as HTMLSelectElement;
  const secExports = $("#rpSecExports", ov) as HTMLElement;
  const syncPoam = () => { secExports.hidden = roleSel.value !== "security"; };
  roleSel.addEventListener("change", syncPoam);
  syncPoam();

  // P-REPORT.9 (ADR-0162): the multi-repo picker. Rows are checkable repos (workspace ∪ recents ∪ tracked);
  // each GitHub repo with `gh` authed gets a per-row PR toggle. `reportRepoState` holds the tick/PR choices
  // so the Generate handler can read the selection. "Add repo" clones a URL or adds a local path.
  const repoList = $("#rpRepoList", ov) as HTMLElement;
  let repoState: import("./bridge.ts").ReportRepo[] = [];
  let ghAuth = false;
  const repoChecked = new Set<string>();
  const repoPrs = new Set<string>();
  // P-REPORT.9: repo list sort order (user preference, persisted). "recent" = most-recently-committed
  // first; "name" = alphabetical. The active-workspace pre-check keys off the server order, not this.
  let repoSort = (localStorage.getItem("lucid.reportRepoSort") === "name" ? "name" : "recent") as "recent" | "name";
  const sortedRepos = (): import("./bridge.ts").ReportRepo[] => [...repoState].sort((a, b) =>
    repoSort === "name" ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : (b.lastActive - a.lastActive) || a.name.localeCompare(b.name));
  const renderRepos = (): void => {
    if (!repoState.length) { repoList.innerHTML = `<div class="goal-opt">No git repositories found. Add one below.</div>`; return; }
    repoList.innerHTML = sortedRepos().map((r) => {
      const on = repoChecked.has(r.path);
      const prOn = repoPrs.has(r.path);
      const prCap = r.isGitHub && ghAuth;
      const prTip = !r.isGit ? "not a git repo" : !r.remoteUrl ? "no remote configured" : !r.isGitHub ? "not a GitHub remote" : !ghAuth ? "run `gh auth login` to enable PRs" : "include open + recently-merged pull requests";
      const remote = r.remoteUrl ? esc(r.remoteUrl) : "local only (no remote)";
      return `<div class="rp-repo${on ? " on" : ""}" data-path="${esc(r.path)}">
        <label class="rp-repo-main"><input type="checkbox" class="rp-repo-ck"${on ? " checked" : ""} />
          <span class="rp-repo-txt"><b>${esc(r.name)}</b><span class="rp-repo-url">${remote}</span></span></label>
        <label class="rp-repo-pr${prCap ? "" : " off"}" data-tip="${esc(prTip)}"><input type="checkbox" class="rp-repo-prck"${prOn ? " checked" : ""}${prCap ? "" : " disabled"} /> PRs</label>
      </div>`;
    }).join("");
  };
  const applyRepos = (data: { repos: import("./bridge.ts").ReportRepo[]; ghAuth: boolean } | null): void => {
    repoState = data?.repos ?? [];
    ghAuth = !!data?.ghAuth;
    // Pre-check the active workspace (first row) on first load so a plain Generate still includes it.
    if (!repoChecked.size && repoState[0]) repoChecked.add(repoState[0].path);
    renderRepos();
  };
  void bridge.reportRepos().then(applyRepos).catch(() => applyRepos(null));
  const sortSel = $("#rpRepoSort", ov) as HTMLSelectElement | null;
  if (sortSel) {
    sortSel.value = repoSort;
    sortSel.addEventListener("change", () => { repoSort = sortSel.value === "name" ? "name" : "recent"; localStorage.setItem("lucid.reportRepoSort", repoSort); renderRepos(); });
  }
  repoList.addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest(".rp-repo") as HTMLElement | null;
    const path = row?.dataset.path; if (!path) return;
    if (t.classList.contains("rp-repo-ck")) {
      (t as HTMLInputElement).checked ? repoChecked.add(path) : repoChecked.delete(path);
      row!.classList.toggle("on", (t as HTMLInputElement).checked);
    } else if (t.classList.contains("rp-repo-prck")) {
      (t as HTMLInputElement).checked ? repoPrs.add(path) : repoPrs.delete(path);
    }
  });
  // Repositories accordion: collapse/expand, and auto-collapse after Generate so the report snapshot below
  // comes into view (the count summarizes the selection while collapsed). The sort control never toggles it.
  const reposEl = $("#rpRepos", ov) as HTMLElement;
  const reposH = $("#rpReposH", ov) as HTMLElement;
  const setReposCollapsed = (collapsed: boolean): void => {
    reposEl.classList.toggle("collapsed", collapsed);
    reposH.setAttribute("aria-expanded", String(!collapsed));
    const n = repoChecked.size;
    ($("#rpReposCount", ov) as HTMLElement).textContent = collapsed ? `${n} repo${n === 1 ? "" : "s"} selected` : "";
  };
  reposH.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("select,input,button,a")) return;
    setReposCollapsed(!reposEl.classList.contains("collapsed"));
  });
  reposH.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setReposCollapsed(!reposEl.classList.contains("collapsed")); }
  });
  const addInput = $("#rpRepoAdd", ov) as HTMLInputElement;
  const addRepo = async (): Promise<void> => {
    const v = addInput.value.trim(); if (!v) return;
    const btn = $("#rpRepoAddBtn", ov) as HTMLButtonElement; const prev = btn.innerHTML; btn.disabled = true; btn.textContent = "Adding…";
    try {
      const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/.test(v);
      const r = await bridge.addReportRepo(isUrl ? { url: v } : { path: v }).catch(() => null);
      if (!r || r.error) { showToast({ tone: "warn", title: "Could not add repo", desc: r?.error || "Check the path or URL.", timeout: 3600 }); return; }
      addInput.value = "";
      // Auto-select the newly added repo (it's the freshest tracked entry).
      const added = r.repos.find((x) => !repoState.some((o) => o.path === x.path));
      applyRepos(r);
      if (added) { repoChecked.add(added.path); renderRepos(); }
      showToast({ title: "Repo added", desc: "It's now selectable for reports.", timeout: 2400 });
    } finally { btn.disabled = false; btn.innerHTML = prev; }
  };
  $("#rpRepoAddBtn", ov)?.addEventListener("click", () => void addRepo());
  addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void addRepo(); } });

  const downloadExport = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $("#rpPoam", ov)?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement; const prev = btn.innerHTML; btn.disabled = true; btn.textContent = "Building POA&M…";
    try {
      const r = await bridge.engineeringBriefPoam().catch(() => null);
      if (!r?.csv) { showToast({ tone: "warn", title: "Could not export", desc: "The POA&M generator returned nothing.", timeout: 2800 }); return; }
      downloadExport(new Blob([r.csv], { type: "text/csv" }), r.filename || "poam.csv");
      showToast({ title: "POA&M exported", desc: `${r.rows} control-mapped item${r.rows === 1 ? "" : "s"}. Draft - validate the control/CCI mappings against your baseline before eMASS import.`, timeout: 5200 });
    } finally { btn.disabled = false; btn.innerHTML = prev; }
  });
  $("#rpCkl", ov)?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement; const prev = btn.innerHTML; btn.disabled = true; btn.textContent = "Building .ckl…";
    try {
      const r = await bridge.engineeringBriefCkl().catch(() => null);
      if (!r?.ckl) { showToast({ tone: "warn", title: "Could not export", desc: "The checklist generator returned nothing.", timeout: 2800 }); return; }
      downloadExport(new Blob([r.ckl], { type: "application/xml" }), r.filename || "crosswalk.ckl");
      showToast({ title: "STIG checklist exported", desc: `${r.rows} item${r.rows === 1 ? "" : "s"} as .ckl. Open in STIG Viewer. Draft - Vuln IDs are synthetic, keyed by CCI; validate before use.`, timeout: 5600 });
    } finally { btn.disabled = false; btn.innerHTML = prev; }
  });

  // P-REPORT.2 (ADR-0117): the Active/Archived tabs + per-row Copy / Download / Archive (soft) / Restore /
  // Delete (permanent, archive only). Delete twice = gone: active row → Archive, archived row → Delete.
  let archived = false;
  let loadSeq = 0; // guards against an out-of-order response (fast tab toggles) painting a stale list
  const loadList = async (): Promise<void> => {
    const list = $("#rpList", ov) as HTMLElement;
    const seq = ++loadSeq;
    // Immediate skeleton so a multi-second read (or a just-generated report) doesn't look like nothing
    // happened - the right pane visibly shows it's loading instead of freezing on the stale list.
    ($("#rpCount", ov) as HTMLElement).textContent = "…";
    list.innerHTML = `<div class="rp-skels">${`<div class="rp-skel"></div>`.repeat(5)}</div>`;
    const reports = await bridge.reports(archived).catch(() => null);
    if (seq !== loadSeq) return; // a newer load started (e.g. user flipped tabs) - drop this stale result
    ($("#rpCount", ov) as HTMLElement).textContent = reports ? `${reports.length} ${archived ? "archived" : "saved"}` : "";
    if (!reports || !reports.length) {
      list.innerHTML = `<div class="goal-opt">${archived ? "The archive is empty." : "No reports yet - generate one, or run a /goal loop to produce an After-Action Report."}</div>`;
      return;
    }
    list.innerHTML = reports.slice(0, 80).map((r) => {
      const when = r.updatedAt ? new Date(r.updatedAt).toLocaleString() : "";
      const badge = r.kind === "aar" ? `<span class="rp-badge aar">AAR</span>` : `<span class="rp-badge brief">Brief${r.role ? ` · ${esc(r.role)}` : ""}</span>`;
      const acts = archived
        ? `<button type="button" class="rp-act" data-rp-restore data-tip="Restore to active">${icon("restore", 13)}</button>
           <button type="button" class="rp-act danger" data-rp-delete data-tip="Delete permanently">${icon("trash", 13)}</button>`
        : `<button type="button" class="rp-act" data-rp-archive data-tip="Archive (soft-delete)">${icon("archive", 13)}</button>`;
      return `<div class="rp-row" data-kind="${r.kind}" data-rel="${esc(r.rel)}" data-title="${esc(r.title)}">
        <button type="button" class="rp-open" data-rp-open>${badge}<span class="rp-title">${esc(r.title)}</span><span class="rp-when">${esc(when)}</span></button>
        <span class="rp-acts">
          <button type="button" class="rp-act" data-rp-copy data-tip="Copy markdown">${icon("copy", 13)}</button>
          <button type="button" class="rp-act" data-rp-dl data-tip="Download .md">${icon("download", 13)}</button>
          <button type="button" class="rp-act" data-rp-kg data-tip="Push to the knowledge graph">${icon("graph", 13)}</button>
          ${acts}</span></div>`;
    }).join("");
  };
  // Delegated row actions (open / copy / download / archive / restore / delete).
  ($("#rpList", ov) as HTMLElement).addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest(".rp-row") as HTMLElement | null; if (!row) return;
    const kind = row.dataset.kind!, rel = row.dataset.rel!, title = row.dataset.title || "Report";
    if (t.closest("[data-rp-open]")) { void openReportEntry(kind, rel, title, archived); return; }
    if (t.closest("[data-rp-copy]") || t.closest("[data-rp-dl]")) {
      const r = await bridge.report(kind, rel, archived).catch(() => null);
      if (!r) { showToast({ tone: "warn", title: "Could not read", desc: "The report file wasn't found.", timeout: 2200 }); return; }
      if (t.closest("[data-rp-copy]")) void copyMarkdown(r.markdown); else downloadMarkdown(r.markdown, reportFilename(title));
      return;
    }
    if (t.closest("[data-rp-kg]")) { void pushReportToKg(kind, rel, archived, t.closest("[data-rp-kg]") as HTMLElement); return; }
    if (t.closest("[data-rp-archive]")) { await bridge.reportArchive(kind, rel); showToast({ title: "Archived", desc: "Moved to the archive. Delete again there to remove it for good.", timeout: 2400 }); void loadList(); return; }
    if (t.closest("[data-rp-restore]")) { await bridge.reportRestore(kind, rel); showToast({ title: "Restored", desc: "Back in the active list.", timeout: 1800 }); void loadList(); return; }
    if (t.closest("[data-rp-delete]")) {
      const r = await bridge.reportDelete(kind, rel).catch(() => null);
      showToast(r?.deleted ? { title: "Deleted", desc: "Permanently removed.", timeout: 1800 } : { tone: "warn", title: "Not deleted", desc: "Only archived reports can be permanently deleted.", timeout: 2600 });
      void loadList(); return;
    }
  });
  // Active / Archived tab switch.
  ($("#rpTabs", ov) as HTMLElement).addEventListener("click", (e) => {
    const tab = (e.target as HTMLElement).closest("[data-tab]") as HTMLElement | null; if (!tab) return;
    archived = tab.dataset.tab === "archived";
    ov.querySelectorAll(".rp-tab").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.tab === tab.dataset.tab));
    void loadList();
  });
  void loadList();

  // P-EVAL.3 Part B (ADR-0187): build the cross-run Model-Evaluation rollup from the on-device metrics +
  // latency ledger, list it, and open it. An empty ledger still yields a friendly report (never an error).
  $("#rpEvalRollup", ov)?.addEventListener("click", async () => {
    const btn = $("#rpEvalRollup", ov) as HTMLButtonElement;
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = `${icon("refresh", 14, "spin")} Building rollup…`;
    const res = await bridge.evalRollup().catch(() => null);
    btn.disabled = false; btn.innerHTML = orig;
    if (res && res.rel) { await loadList(); void openReportEntry("brief", res.rel, res.title); }
    else showToast({ tone: "warn", title: "Couldn't build the rollup", desc: "The Model-Evaluation ledger couldn't be read. Try again in a moment.", timeout: 3600 });
  });
  $("#rpGenerate", ov)?.addEventListener("click", async () => {
    const btn = $("#rpGenerate", ov) as HTMLButtonElement;
    const out = $("#rpResult", ov) as HTMLElement;
    setReposCollapsed(true); // fold the repo picker so the report snapshot below is in view
    const role = ($("#rpRole", ov) as HTMLSelectElement).value;
    const provider = prov.value;
    // P-REPORT.9: gather the ticked repos + per-repo PR choice; a fetch checkbox gates the read-only sync.
    const doFetch = ($("#rpFetch", ov) as HTMLInputElement)?.checked ?? true;
    const repos = repoState.filter((r) => repoChecked.has(r.path)).map((r) => ({ path: r.path, fetch: doFetch, prs: repoPrs.has(r.path) }));
    const prev = btn.innerHTML; btn.disabled = true;
    btn.textContent = repos.length ? `Fetching ${repos.length} repo${repos.length === 1 ? "" : "s"}…` : "Generating…";
    try {
      const data = await bridge.engineeringBrief(role, true, repos.length ? repos : undefined).catch(() => null); // save=1 → lands in the list
      if (!data) { showToast({ tone: "warn", title: "Could not generate", desc: "The local engine didn't return a brief.", timeout: 2600 }); return; }
      out.hidden = false;
      const counts = `<div class="goal-eu-counts">${Object.entries(data.counts).map(([k, v]) => `<b>${v}</b> ${k}`).join(" · ")}</div>`;
      out.innerHTML = counts + `<div id="rpAudio"></div>` + renderMarkdown(data.brief);
      enhanceReportBody(out, ""); // P-REPORT.8: render the annex graphs + charts in the preview too
      if (provider === "elevenlabs" || provider === "openai-tts" || provider === "local-tts") {
        const slot = $("#rpAudio", ov) as HTMLElement;
        slot.innerHTML = `<div class="goal-opt">${icon("spark", 11)} Synthesizing audio…</div>`;
        const a = await bridge.engineeringBriefAudio(provider as never, voiceSel.value || undefined).catch(() => null);
        if (a?.audioB64) {
          const url = audioBlobUrl(a.audioB64, a.mime); const ext = a.mime.includes("wav") ? "wav" : "mp3";
          slot.innerHTML = `<audio controls src="${url}" style="width:100%;margin:6px 0"></audio><a class="btn-mini" download="engineering-report.${ext}" href="${url}">${icon("download", 12)} Download ${ext.toUpperCase()}</a>`;
        } else { slot.innerHTML = `<div class="goal-opt">Audio not generated - ${esc(a?.note ?? "the TTS endpoint was unreachable")}.</div>`; }
      }
      void loadList(); // the just-saved brief now appears in the list
    } finally { btn.disabled = false; btn.innerHTML = prev; }
  });
}

/** Compact duration for the eval banner (mirrors loop_report.formatDuration, kept local to the renderer). */
function formatLoopDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// P-GOAL.12 (ADR-0057): the Pre-Flight Audit - pause the builder, design the loop (scope + a short
// prompt-engineering interview + user/PO + engineer feedback), fold in past-run history, and produce a
// readiness-scored Loop Design report the user adopts as the goal (its criteria thread to the checker).
async function openPreflight(goalOv: HTMLElement): Promise<void> {
  const g = ($("#goalGoal", goalOv) as HTMLTextAreaElement)?.value.trim() ?? "";
  const cmd = ($("#goalCmd", goalOv) as HTMLInputElement)?.value.trim() ?? "";
  const ov = el(`<div class="scrim preflight-scrim"><div class="preflight-modal">
    <div class="goal-modal-h"><span class="goal-h-title">${icon("shield", 15)} Pre-Flight Audit</span><button type="button" class="btn-mini" id="pfClose">Close</button></div>
    <div class="goal-modal-sub">Design the loop before you build it - scope it, answer a few questions, fold in user/engineer feedback and past-run history, then adopt a readiness-scored Loop Design as your goal.</div>
    <div class="pf-form">
      <label class="goal-lbl">Scope <span class="goal-opt">where the loop runs</span></label>
      <select id="pfScope" class="prov-key"><option value="workspace">current workspace</option></select>
      <label class="goal-lbl">Objective</label>
      <textarea id="pfGoal" class="prov-key" rows="2" placeholder="What should the loop accomplish?">${esc(g)}</textarea>
      <div class="pf-grid">
        <label class="goal-lbl pf-f"><span>Definition of done</span><textarea id="pfDone" class="prov-key" rows="2" placeholder="What does 'done' look like, concretely?"></textarea></label>
        <label class="goal-lbl pf-f"><span>Verification command</span><input id="pfCmd" class="prov-key" placeholder="npm test && npm run lint" value="${esc(cmd)}" /></label>
        <label class="goal-lbl pf-f"><span>Non-goals</span><textarea id="pfNon" class="prov-key" rows="2" placeholder="What must it NOT do?"></textarea></label>
        <label class="goal-lbl pf-f"><span>Risky / off-limits</span><textarea id="pfRisk" class="prov-key" rows="2" placeholder="auth, payments, secrets, infra…"></textarea></label>
        <label class="goal-lbl pf-f"><span>User / product-owner feedback</span><textarea id="pfFeed" class="prov-key" rows="2" placeholder="What does the product owner want?"></textarea></label>
        <label class="goal-lbl pf-f"><span>Engineer notes</span><textarea id="pfEng" class="prov-key" rows="2" placeholder="Constraints, gotchas, the right approach…"></textarea></label>
      </div>
      <div class="pf-actions"><button class="btn-mini ok" id="pfRun">${icon("bolt", 12)} Run Pre-Flight Audit</button></div>
    </div>
    <div class="pf-result" id="pfResult" hidden></div>
  </div></div>`);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  $("#pfClose", ov)?.addEventListener("click", close);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });

  // scope picker - branches + worktrees (best-effort; falls back to "current workspace")
  void bridge.loopScopes().then((s) => {
    const sel = $("#pfScope", ov) as HTMLSelectElement | null; if (!sel || !s) return;
    const opts = [`<option value="workspace">current workspace</option>`];
    for (const b of s.branches) opts.push(`<option value="branch: ${esc(b)}">branch: ${esc(b)}${b === s.current ? " (current)" : ""}</option>`);
    for (const w of s.worktrees) opts.push(`<option value="worktree: ${esc(w)}">worktree: ${esc(w)}</option>`);
    sel.innerHTML = opts.join("");
    if (s.current) sel.value = `branch: ${s.current}`;
  });

  let last: Awaited<ReturnType<typeof bridge.preflightAudit>> = null;
  $("#pfRun", ov)?.addEventListener("click", async () => {
    const val = (id: string) => ($(id, ov) as HTMLInputElement | HTMLTextAreaElement | null)?.value.trim() || undefined;
    const spec = {
      goal: val("#pfGoal") ?? "", scope: ($("#pfScope", ov) as HTMLSelectElement).value,
      command: val("#pfCmd"), doneDefinition: val("#pfDone"), nonGoals: val("#pfNon"), risks: val("#pfRisk"),
      feedback: val("#pfFeed"), engineerNotes: val("#pfEng"),
      budgetUsd: Math.max(0, Number(($("#goalBudget", goalOv) as HTMLInputElement)?.value) || 0),
      maxIters: Math.min(20, Math.max(1, Number(($("#goalMax", goalOv) as HTMLInputElement)?.value) || 6)),
      checkerIsCheap: true,
    };
    if (!spec.goal) { showToast({ tone: "warn", title: "Add an objective", desc: "Describe what the loop should accomplish.", timeout: 2400 }); return; }
    const btn = $("#pfRun", ov) as HTMLButtonElement; btn.disabled = true; btn.textContent = "Auditing…";
    const res = $("#pfResult", ov) as HTMLElement; res.hidden = false;
    res.innerHTML = `<div class="pf-loading">${icon("refresh", 13)} Interviewing the checker model + scoring readiness against past runs…</div>`;
    last = await bridge.preflightAudit(spec).catch(() => null);
    btn.disabled = false; btn.innerHTML = `${icon("bolt", 12)} Re-run`;
    if (!last) { res.innerHTML = `<div class="pf-loading">Audit failed - check the model/connection and try again.</div>`; return; }
    const lvl = last.readiness.level, tone = lvl === "L3" ? "ok" : lvl === "L2" ? "mid" : "low";
    res.innerHTML = `<div class="pf-readiness" data-tone="${tone}">${icon("shield", 14)} <b>${esc(last.readiness.summary)}</b>${last.prior.total ? ` <span class="goal-opt">· ${last.prior.total} prior run${last.prior.total === 1 ? "" : "s"} on record, ${last.prior.relevant} relevant</span>` : ""}</div>
      <div class="pf-report">${renderMarkdown(last.reportMd)}</div>
      <div class="pf-adopt-row">${last.reportPath ? `<span class="goal-opt">saved <code>${esc(last.reportPath)}</code></span>` : ""}<button class="btn-mini ok" id="pfAdopt">${icon("check", 12)} Adopt as goal</button></div>`;
    $("#pfAdopt", ov)?.addEventListener("click", () => {
      if (!last) return;
      ($("#goalGoal", goalOv) as HTMLTextAreaElement).value = last.maturedGoal;
      const cmdEl = $("#goalCmd", goalOv) as HTMLInputElement | null, suggested = ($("#pfCmd", ov) as HTMLInputElement).value.trim();
      if (cmdEl && !cmdEl.value.trim() && suggested) cmdEl.value = suggested;
      adoptedCriteria = last.criteria || ""; // threads to the checker on the next run
      updateGoalEstimate(goalOv);
      close();
      showToast({ tone: "ok", title: "Adopted into the goal", desc: "Tweak it in the Goal field, then Run - the checker will grade against your criteria.", timeout: 3400 });
    });
  });
}

async function renderAutomations(ov: HTMLElement, close: () => void): Promise<void> {
  const sec = $("#goalAutoSec", ov); if (!sec) return;
  const list = await bridge.automations();
  if (!list?.length) { sec.innerHTML = ""; return; }
  const cadLabel = (c: { kind: "interval"; everyMin: number } | { kind: "daily"; hhmm: string }): string =>
    c.kind === "daily" ? `daily at ${c.hhmm}` : c.everyMin % 60 === 0 ? `every ${c.everyMin / 60}h` : `every ${c.everyMin}m`;
  sec.innerHTML = `<div class="goal-lbl">${icon("clock", 12)} Scheduled automations</div>` + list.map((a) => `
    <div class="goal-auto ${a.enabled ? "on" : ""}" data-id="${esc(a.id)}">
      <button class="ga-toggle" title="${a.enabled ? "Disable" : "Enable"}" aria-pressed="${a.enabled}"></button>
      <div class="ga-body">
        <div class="ga-goal">${esc(a.goal.slice(0, 80))}</div>
        <div class="ga-meta">${icon("refresh", 10)} ${esc(cadLabel(a.cadence))}${a.lastResult ? ` · last: ${esc(a.lastResult.slice(0, 60))}` : " · not run yet"}</div>
      </div>
      <button class="ga-run" title="Run now">${icon("bolt", 12)}</button>
      <button class="ga-del" title="Delete">${icon("trash", 12)}</button>
    </div>`).join("");
  sec.querySelectorAll(".goal-auto").forEach((row) => {
    const id = (row as HTMLElement).dataset.id!;
    const a = list.find((x) => x.id === id)!;
    $(".ga-toggle", row as HTMLElement)?.addEventListener("click", async () => { await bridge.automationEnable(id, !a.enabled); void renderAutomations(ov, close); });
    $(".ga-del", row as HTMLElement)?.addEventListener("click", async () => { await bridge.automationDelete(id); void renderAutomations(ov, close); });
    $(".ga-run", row as HTMLElement)?.addEventListener("click", () => {
      close();
      void runGoalLoop({ goal: a.goal, condition: a.condition, command: a.command, maxIters: a.maxIters }, (on) => bridge.automationRun(id, on), "automation");
    });
  });
}
// ── P-GOAL.13 (ADR-0067): the per-command-type Speed↔Risk dial (the "plasma slider" matrix) ──────────
const GOAL_DIAL_ROWS: [keyof NonNullable<GoalDial>, string][] = [
  ["shell", "Shell"], ["edit", "Edit files"], ["delete", "Delete"],
  ["web-fetch", "Web fetch"], ["web-search", "Web search"], ["subagent", "Subagents"],
];
const GOAL_DIAL_TIERS = ["T0", "T1", "T2", "T3"] as const;
const GOAL_DIAL_TIER_LABEL: Record<string, string> = { T0: "read-only", T1: "local", T2: "reach-out", T3: "destructive" };
function loadGoalDial(): GoalDial {
  try { const v = JSON.parse(localStorage.getItem("lucid.goalDial") || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
/** Build the slider matrix into #goalDialGrid and return a reader for the current dial. Persists to
 *  localStorage so the user's posture sticks across runs. Default = T0 (the safest, most-blocking). */
function buildGoalDial(ov: HTMLElement): () => GoalDial {
  const dial = loadGoalDial();
  const grid = $("#goalDialGrid", ov) as HTMLElement | null;
  if (!grid) return () => ({});
  const tierOf = (k: keyof NonNullable<GoalDial>) => (dial[k] ?? "T0") as typeof GOAL_DIAL_TIERS[number];
  grid.innerHTML = GOAL_DIAL_ROWS.map(([k, label]) => {
    const idx = Math.max(0, GOAL_DIAL_TIERS.indexOf(tierOf(k)));
    return `<div class="goal-dial-row">
      <span class="goal-dial-name">${esc(label)}</span>
      <input type="range" class="goal-dial-slider" min="0" max="3" step="1" value="${idx}" data-dk="${esc(String(k))}" style="--dial:${idx / 3}" aria-label="${esc(label)} auto-run ceiling"/>
      <span class="goal-dial-tier" data-dt="${esc(String(k))}">${GOAL_DIAL_TIERS[idx]}<i>${GOAL_DIAL_TIER_LABEL[GOAL_DIAL_TIERS[idx]!]}</i></span>
    </div>`;
  }).join("");
  grid.addEventListener("input", (e) => {
    const s = (e.target as HTMLElement).closest("[data-dk]") as HTMLInputElement | null;
    if (!s) return;
    const k = s.dataset.dk as keyof NonNullable<GoalDial>;
    const tier = GOAL_DIAL_TIERS[Number(s.value)] ?? "T0";
    dial[k] = tier;
    try { localStorage.setItem("lucid.goalDial", JSON.stringify(dial)); } catch { /* private mode */ }
    s.style.setProperty("--dial", String(Number(s.value) / 3));
    const badge = $(`[data-dt="${k}"]`, ov) as HTMLElement | null;
    if (badge) badge.innerHTML = `${tier}<i>${GOAL_DIAL_TIER_LABEL[tier]}</i>`;
  });
  return () => ({ ...dial });
}

async function runGoalLoop(
  opts: { goal: string; condition: string; command?: string; maxIters: number; resume?: string; budgetUsd?: number; criteria?: string; dial?: GoalDial },
  stream?: (onEvent: (e: ChatEvent) => void) => Promise<void>, // P-GOAL.5: automation run-now reuses this renderer
  verb = "/goal",
): Promise<void> {
  if (state.streaming) { showToast({ tone: "warn", title: "A turn is running", desc: "Wait for it to finish before starting a loop.", timeout: 2400 }); return; }
  if (!autoCollapsedSessions) { autoCollapsedSessions = true; if (!state.sidebarCollapsed) toggleSidebar(true); }
  state.lastPrompt = opts.goal;
  addMessage("user", `${verb}${opts.resume ? " (resume)" : ""}: ${opts.goal}${opts.command ? `\nverify: \`${opts.command}\`` : ""}  ·  up to ${opts.maxIters} iterations`);
  state.streaming = true; state.streamStartedAt = Date.now(); goalLoopRunning = true; setSendEnabled();
  const node = addMessage("assistant", "");
  const textEl = $(".text", node) as HTMLElement; textEl.innerHTML = "";
  const wrap = el(`<div class="goal-loop"></div>`); textEl.appendChild(wrap);
  let iterEl: HTMLElement | null = null, streamEl: HTMLElement | null = null, buf = "";
  const onEvent = (e: ChatEvent) => {
    if (e.type === "goal-memory") { wrap.appendChild(el(`<div class="goal-mem">${icon("folder", 12)} loop memory: <code>${esc(e.path)}</code></div>`)); scrollChat(); }
    else if (e.type === "goal-iter") {
      buf = "";
      iterEl = el(`<div class="goal-iter"><div class="goal-iter-h">${icon("refresh", 11)} Iteration ${e.n} of ${e.max}</div><div class="stream"></div></div>`);
      wrap.appendChild(iterEl); streamEl = $(".stream", iterEl); scrollChat();
    } else if (e.type === "token") { buf += e.text; if (streamEl) streamEl.innerHTML = renderMarkdown(buf) + `<span class="cursor"></span>`; scrollChat(); }
    else if (e.type === "tool") { iterEl?.appendChild(el(`<div class="goal-act">${icon(phaseIcon(e.name), 12)} ${esc(phaseForTool(e.name, e.detail))}</div>`)); scrollChat(); }
    else if (e.type === "subagent") { iterEl?.appendChild(el(`<div class="goal-act">${icon("bolt", 12)} Delegated to ${esc(e.agent)}</div>`)); scrollChat(); }
    else if (e.type === "block") onBlock(e);
    else if (e.type === "goal-check") {
      if (streamEl) streamEl.innerHTML = renderMarkdown(buf); // freeze this round's text
      iterEl?.appendChild(el(`<div class="goal-verdict ${e.done ? "ok" : "no"}">${icon(e.done ? "check" : "refresh", 12)} checker: ${e.done ? "condition met" : "not yet"} · ${esc(e.reason)}</div>`));
      scrollChat();
    }
    else if (e.type === "goal-done") { wrap.appendChild(el(`<div class="goal-banner ok">${icon("check", 14)} Goal met in ${e.iters} iteration${e.iters === 1 ? "" : "s"}. ${esc(e.reason)}</div>`)); scrollChat(); }
    else if (e.type === "goal-stop") { wrap.appendChild(el(`<div class="goal-banner stop">${icon("info", 14)} ${esc(e.reason)}</div>`)); scrollChat(); }
    else if (e.type === "goal-report") {
      // P-GOAL.9: the loop's last task - an After-Action Report (metrics + portable graphs). The durable
      // record is on disk (Mermaid renders on GitHub/VS Code); in-app we show the summary + the report's
      // text scoreboard/tables (our `marked` view has no Mermaid, so charts stay in the file).
      const card = el(`<details class="goal-aar" open>
        <summary>${icon("graph", 13)} After-Action Report · <b>${esc(e.summary)}</b>${e.path ? ` · <code>${esc(e.path)}</code>` : ""}</summary>
        <div class="goal-aar-body">${renderMarkdown(e.markdown)}</div>
      </details>`);
      wrap.appendChild(card); scrollChat();
    }
    else if (e.type === "done") { if (streamEl) streamEl.innerHTML = renderMarkdown(buf); }
  };
  try { await (stream ?? ((on: (e: ChatEvent) => void) => bridge.runGoal(opts, on)))(onEvent); }
  finally { state.streaming = false; goalLoopRunning = false; setSendEnabled(); void renderSessions(); void refreshBudget(false); }
}

// ── "/" command + skill autocomplete (P-SLASH.1) ──────────────────────────────
// Type "/" in the composer to pop an inline, filtered list of slash commands (omp's) + skills
// (built-in, most-used first; project) + /goal & /loop-engineering. Filters character-by-character;
// ↑/↓ to move, Tab/Enter to complete, Esc to dismiss. Built-in skills ACTIVATE on select; commands and
// project skills COMPLETE into the textarea so you can finish typing args.
interface SlashItem { label: string; hint: string; kind: "bundled" | "project" | "command"; complete?: string; activate?: string; uses: number }
const SLASH_KIND_RANK: Record<SlashItem["kind"], number> = { bundled: 0, project: 1, command: 2 };
let slashEl: HTMLElement | null = null;
let slashItems: SlashItem[] = [];
let slashSel = 0;

function slashSource(): SlashItem[] {
  let uses: Record<string, number> = {};
  try { uses = JSON.parse(localStorage.getItem("lucid.skill-usage") || "{}"); } catch { /* none */ }
  const out: SlashItem[] = [];
  // P-AGENT.8: the flagship /agent command — start the Agent Builder interview. Promoted (high `uses`) so it
  // surfaces near the top; `complete` lets the user optionally add a one-line description before sending.
  out.push({ label: "/agent", hint: "Build an AI agent — LUCID interviews you, then opens the Agent Builder", kind: "command", complete: "/agent ", uses: 9000 + (uses["agent"] ?? 0) });
  // P-CMD.1: create your OWN reusable "/" command by describing it — LUCID interviews you, then saves it.
  out.push({ label: "/command", hint: "Create your own /command — describe it, LUCID interviews you and saves it", kind: "command", complete: "/command ", uses: 8500 + (uses["command"] ?? 0) });
  out.push({ label: "/figma", hint: "Import a Figma design into the Preview and have the agent review it", kind: "command", activate: "figma", uses: 8900 + (uses["figma"] ?? 0) }); // P-FIGMA.1 (ADR-0154)
  for (const s of bundledSkillsByUsage()) out.push({ label: s.name, hint: s.description, kind: "bundled", activate: s.command, uses: uses[s.command] ?? 0 });
  // P-SKILL.4: a disabled or flagged project skill is never offered in the picker (same decision the
  // delivery path uses). A user can still type /skill:<name> raw (omp resolves it), but LUCID won't suggest it.
  for (const s of state.skills) { if (!isSkillEnabled(skillKey(s.root, s.name), s.trust)) continue; out.push({ label: `/skill:${s.name}`, hint: s.description || s.source, kind: "project", complete: `/skill:${s.name} `, uses: 0 }); }
  // P-CMD.1: the user's own saved commands. Ranked above omp commands (uses:100) so they surface first.
  for (const c of state.userCommands) out.push({ label: `/${c.name}`, hint: c.description || (c.mode === "skill" ? "your skill" : "your command"), kind: "command", complete: `/${c.name} `, uses: 100 });
  for (const c of state.commands) out.push({ label: `/${c.name}`, hint: c.description ?? "", kind: "command", complete: `/${c.name} `, uses: 0 });
  return out;
}
function filterSlash(prefix: string): SlashItem[] {
  const p = prefix.toLowerCase();
  const scored = slashSource().map((it) => {
    const key = (it.activate ?? it.label).replace(/^\/(?:skill:)?/, "").toLowerCase();
    const name = it.label.toLowerCase();
    let score = -1;
    if (!p) score = 0;                                                  // bare "/" → show all (most-used floats up)
    else if (key.startsWith(p) || name.startsWith(p) || name.startsWith("/" + p)) score = 2; // prefix match
    else if (key.includes(p) || it.hint.toLowerCase().includes(p)) score = 1;                // loose match
    return { it, score };
  }).filter((x) => x.score >= 0);
  scored.sort((a, b) => b.score - a.score || b.it.uses - a.it.uses || SLASH_KIND_RANK[a.it.kind] - SLASH_KIND_RANK[b.it.kind] || a.it.label.localeCompare(b.it.label));
  return scored.slice(0, 8).map((x) => x.it);
}
function closeSlashAC(): void { slashEl?.remove(); slashEl = null; slashItems = []; slashSel = 0; }
function updateSlashAC(): void {
  const ta = $("#input") as HTMLTextAreaElement | null; if (!ta) return;
  // P-CMD.2: complete the "/" token AT THE CARET — commands work anywhere in the body, so the menu opens
  // mid-sentence too ("fix this /lic…"), not only when the whole input is one token.
  const caret = ta.selectionStart ?? ta.value.length;
  const tok = slashTokenBeforeCaret(ta.value.slice(0, caret));
  if (!tok || state.streaming) { closeSlashAC(); return; }
  slashItems = filterSlash(tok.slice(1));
  if (!slashItems.length) { closeSlashAC(); return; }
  if (slashSel >= slashItems.length) slashSel = slashItems.length - 1;
  const rows = slashItems.map((it, i) =>
    `<div class="sl-opt${i === slashSel ? " on" : ""}" data-i="${i}"><span class="sl-nm">${esc(it.label)}</span><span class="sl-hint">${esc(it.hint.slice(0, 70))}</span></div>`).join("");
  const host = (ta.closest(".composer-row") ?? ta.parentElement) as HTMLElement;
  if (!slashEl) { slashEl = el(`<div class="slash-ac"></div>`); host.appendChild(slashEl); }
  slashEl.innerHTML = `<div class="sl-head">Tab to complete · ↑↓ to move · Esc to dismiss</div>${rows}`;
  slashEl.querySelectorAll(".sl-opt").forEach((r) => r.addEventListener("mousedown", (e) => { e.preventDefault(); applySlash(slashItems[Number((r as HTMLElement).dataset.i)]!); }));
  (slashEl.querySelector(".sl-opt.on") as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
}
function applySlash(it: SlashItem | undefined): void {
  if (!it) return;
  const ta = $("#input") as HTMLTextAreaElement;
  closeSlashAC();
  // P-CMD.2: operate on the "/" token AT THE CARET so completing/activating mid-body preserves the
  // surrounding prose instead of clobbering the whole input.
  const caret = ta.selectionStart ?? ta.value.length;
  const tok = slashTokenBeforeCaret(ta.value.slice(0, caret));
  const start = tok ? caret - tok.length : 0;
  const replaceToken = (replacement: string): void => {
    if (tok) {
      ta.value = ta.value.slice(0, start) + replacement + ta.value.slice(caret);
      const pos = start + replacement.length;
      ta.setSelectionRange(pos, pos);
    } else {
      ta.value = replacement;
    }
  };
  if (it.activate === "goal") { replaceToken(""); autosize(ta); setSendEnabled(); openGoalForm(); return; } // /goal is the REAL loop primitive (P-GOAL.1)
  if (it.activate === "figma") { replaceToken(""); autosize(ta); setSendEnabled(); openFigmaForm(); return; } // P-FIGMA.1 (ADR-0154)
  if (it.activate) { void activateBundledSkill(it.activate); replaceToken(""); } // built-in skill rides the next turn
  else if (it.complete) { replaceToken(it.complete); }                           // command / project skill: finish typing args
  autosize(ta); setSendEnabled(); ta.focus();
}
/** Intercept a composer keydown while the "/" autocomplete is open. Returns true if it consumed the key. */
function slashKeydown(e: KeyboardEvent): boolean {
  if (!slashEl || !slashItems.length) return false;
  const n = slashItems.length;
  if (e.key === "ArrowDown") { e.preventDefault(); slashSel = (slashSel + 1) % n; updateSlashAC(); return true; }
  if (e.key === "ArrowUp") { e.preventDefault(); slashSel = (slashSel - 1 + n) % n; updateSlashAC(); return true; }
  if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); applySlash(slashItems[slashSel]); return true; }
  if (e.key === "Escape") { e.preventDefault(); closeSlashAC(); return true; }
  return false;
}
function openSkillDropdown(anchor: HTMLElement): void {
  cfgClose?.();
  const active = state.activeSkill?.command;
  const taskRow = `<div class="cfg-opt" data-task="1" data-tip="Delegate sub-tasks to isolated subagents (omp Task tool)|Appends a template" data-tip-side="left"><span class="tick">${icon("bolt", 13)}</span><span class="nm">/task: delegate to subagents</span></div>`;
  const bundledRows = bundledSkillsByUsage().map((s) =>
    `<div class="cfg-opt ${s.command === active ? "on" : ""}" data-bundled="${esc(s.command)}" data-tip="${esc(s.description)}|Built-in skill" data-tip-side="left"><span class="tick">${icon("check", 13)}</span><span class="nm">${esc(s.name)}</span><span class="id">${esc(s.description.slice(0, 40))}</span></div>`).join("");
  const clearSec = active
    ? `<div class="cfg-sec"><div class="cfg-list"><div class="cfg-opt" data-clearskill="1" data-tip="Stop the active bundled skill" data-tip-side="left"><span class="tick">${icon("close", 13)}</span><span class="nm">Clear active skill (${esc(state.activeSkill!.name)})</span></div></div></div>`
    : "";
  const html =
    `<div class="cfg-sec"><div class="cfg-lbl">Built-in skills</div><div class="cfg-list">${taskRow}${bundledRows}</div></div>` +
    clearSec +
    `<div class="cfg-sec"><div class="cfg-lbl">Project skills <span class="cur">${state.skills.length ? `${state.skills.length} · /skill:` : "none"}</span></div>
      <div class="cfg-list" id="projSkillList">${projSkillRows()}</div>
      <label class="skill-drop" id="skillDrop" data-tip="Drop .md skill files - each is scanned at the security gate before import"><input type="file" id="skillDropInput" accept=".md,text/markdown" multiple hidden>${icon("download", 13)} <span>Drop <code>.md</code> skills here - scanned at the gate</span></label>
    </div>`;
  const { node, close } = popover(anchor, html, () => { cfgClose = null; });
  cfgClose = close;
  node.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("#skillDrop")) return; // the drop label opens the native file picker; not a skill choice
    const task = t.closest("[data-task]"); if (task) { close(); insertTaskProforma(); return; }
    const clear = t.closest("[data-clearskill]"); if (clear) { close(); void clearBundledSkill(); return; }
    const bundled = t.closest("[data-bundled]") as HTMLElement | null; if (bundled) { close(); void activateBundledSkill(bundled.dataset.bundled!); return; }
    const proj = t.closest("[data-skill]") as HTMLElement | null; if (proj) { close(); useSkill(proj.dataset.skill!); return; }
  });
  // P-SKILL.1: drag-and-drop (or click-to-pick) .md skill import - scanned at the gate server-side.
  const drop = node.querySelector("#skillDrop") as HTMLElement | null;
  const input = node.querySelector("#skillDropInput") as HTMLInputElement | null;
  if (drop) {
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("drag"); void handleSkillFiles((e as DragEvent).dataTransfer?.files ?? [], node); });
  }
  input?.addEventListener("change", () => { if (input.files?.length) void handleSkillFiles(input.files, node); });
}

// In-app folder browser - works in the browser build AND Electron (the dev server reads
// the local FS). Navigate folders, see which are git repos, pick one as the workspace.
// A minimal single-line text prompt (Save-As filename, etc.). Reuses the folder-browser scrim styles.
// Resolves the trimmed value, or null on Cancel / Esc / empty.
function promptText(opts: { title: string; label?: string; value?: string; placeholder?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const scrim = el(`<div class="fb-scrim"></div>`);
    const box = el(`<div class="fb prompt" role="dialog" aria-label="${esc(opts.title)}">
      <div class="fb-head"><span class="fb-title">${icon("download", 15)} ${esc(opts.title)}</span><button class="fb-x" data-x data-tip="Close">${icon("close", 15)}</button></div>
      <div class="prompt-body">${opts.label ? `<label class="prompt-lbl">${esc(opts.label)}</label>` : ""}<input class="prompt-in" type="text" value="${esc(opts.value ?? "")}" placeholder="${esc(opts.placeholder ?? "")}" /></div>
      <div class="fb-foot"><div class="fb-hint"></div><div class="fb-actions"><button class="btn-mini" data-x>Cancel</button><button class="btn-mini ok" data-ok>${icon("check", 12)} Save</button></div></div>
    </div>`);
    document.body.append(scrim, box);
    const inp = $(".prompt-in", box) as HTMLInputElement;
    const done = (v: string | null) => { scrim.remove(); box.remove(); resolve(v); };
    const submit = () => { const v = inp.value.trim(); done(v || null); };
    box.addEventListener("click", (e) => { const t = e.target as HTMLElement; if (t.closest("[data-x]")) done(null); else if (t.closest("[data-ok]")) submit(); });
    scrim.addEventListener("click", () => done(null));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } else if (e.key === "Escape") done(null); });
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  });
}

function openFolderBrowser(opts: { title?: string; confirm?: string } = {}): Promise<string | null> {
  const title = opts.title ?? "Choose a workspace folder";
  const confirm = opts.confirm ?? "Open this folder";
  return new Promise((resolve) => {
    let cur = "", parent: string | null = null, home = "";
    const scrim = el(`<div class="fb-scrim"></div>`);
    const box = el(`<div class="fb" role="dialog" aria-label="${esc(title)}">
      <div class="fb-head"><span class="fb-title">${icon("folder", 15)} ${esc(title)}</span><button class="fb-x" data-fb="cancel" data-tip="Close">${icon("close", 15)}</button></div>
      <div class="fb-bar"><button class="btn-mini" data-fb="up">${icon("expand", 12)} Up</button><button class="btn-mini" data-fb="home">${icon("folder", 12)} Home</button><span class="fb-path" id="fbPath"></span></div>
      <div class="fb-list" id="fbList"></div>
      <div class="fb-foot"><div class="fb-hint" id="fbHint"></div><div class="fb-actions"><button class="btn-mini" data-fb="cancel">Cancel</button><button class="btn-mini ok" data-fb="open">${icon("check", 12)} ${esc(confirm)}</button></div></div>
    </div>`);
    document.body.append(scrim, box);
    const close = (val: string | null) => { scrim.remove(); box.remove(); resolve(val); };
    const render = async (path?: string) => {
      const d = await bridge.listDir(path);
      const list = $("#fbList", box) as HTMLElement;
      if (!d) { list.innerHTML = `<div class="fb-empty">Couldn't read that folder.</div>`; return; }
      cur = d.path; parent = d.parent; home = d.home;
      ($("#fbPath", box) as HTMLElement).textContent = d.path;
      ($("#fbHint", box) as HTMLElement).innerHTML = `Open <b>${esc(d.path.split(/[\\/]/).pop() || d.path)}</b>${d.isGit ? ` <span class="abadge ok">git</span>` : ""}`;
      (box.querySelector('[data-fb="up"]') as HTMLButtonElement).disabled = !d.parent;
      list.innerHTML = d.dirs.length
        ? d.dirs.map((x) => `<button class="fb-item" data-go="${esc(x.path)}">${icon(x.isGit ? "git" : "folder", 14)}<span class="fb-name">${esc(x.name)}</span>${x.isGit ? `<span class="abadge ok">git</span>` : ""}</button>`).join("")
        : `<div class="fb-empty">No subfolders here.</div>`;
    };
    box.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const go = t.closest("[data-go]") as HTMLElement | null;
      if (go) { void render(go.dataset.go); return; }
      const act = (t.closest("[data-fb]") as HTMLElement | null)?.dataset.fb;
      if (act === "cancel") close(null);
      else if (act === "open") close(cur);
      else if (act === "up" && parent) void render(parent);
      else if (act === "home") void render(home);
    });
    scrim.addEventListener("click", () => close(null));
    void render();
  });
}

// P-ABOUT.1 (ADR-0087): the About panel - version (single-source APP_VERSION), license & credits.
// Single instance; closes on the X / Close button, a backdrop click, or Escape.
function openAbout(): void {
  if ($("#aboutModal")) return; // already open - don't stack
  const ov = el(`<div id="aboutModal" class="modal-ov about-ov">${aboutHtml(APP_VERSION)}</div>`);
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); close(); } };
  ov.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest("[data-about-tour]")) { close(); startTour(state.userRole ?? "developer"); return; } // ADR-0089: replay
    if (t === ov || t.closest("[data-about-close]")) close(); // backdrop or a close control
  });
  document.addEventListener("keydown", onKey);
  document.body.append(ov);
}

// ── P-COLLAB.3 (ADR-0192): the live-session Share window ───────────────────────────────────────
// The HOST half of live collaboration: configure the (self-hosted-default) relay, start the E2E broadcast,
// copy the view-only invite link, and watch the live roster. Same modal conventions as About: single
// instance; closes on the X, a backdrop click, or Escape. Guests are view-only (Phase 1); the guest
// join/render surface is the next slice, so an active share shows "waiting for someone to join".
function shareBodyHtml(st: CollabShareStatus | null): string {
  if (!st) return `<div class="share-err">${icon("info", 14)} Couldn't reach the backend. Is the GUI server running?</div>`;
  if (st.active) {
    const src = st.relaySource === "public" ? "public relay" : "self-hosted relay";
    const roster = st.participants.length
      ? st.participants.map((p) => `<li class="share-peer"><span class="share-peer-dot"></span>${esc(p.name)} <span class="share-peer-tag">${esc(p.access)}</span></li>`).join("")
      : `<li class="share-peer-empty">${icon("clock", 13)} Waiting for someone to join…</li>`;
    return `
      <div class="share-live-head"><span class="share-live-dot"></span> Live · ${esc(st.relayLabel ?? src)}</div>
      <label class="share-lbl">View-only invite link</label>
      <div class="share-linkrow">
        <input class="share-link-input" id="shareViewLink" type="text" readonly value="${esc(st.viewLink ?? "")}" spellcheck="false" />
        <button class="btn-mini" data-copy="${esc(st.viewLink ?? "")}" data-copy-what="Invite link">${icon("link", 12)} Copy</button>
      </div>
      <p class="share-hint">Send this to someone running LUCID. It carries the room key end-to-end - the relay can never read the session. Anyone with the link can watch; there is no per-person revoke, so stop + reshare to rotate.</p>
      <div class="share-roster">
        <div class="share-roster-head">${icon("share", 13)} Participants <span class="share-count" id="sharePeerCount">${st.participantCount}</span></div>
        <ul class="share-peers" id="shareParticipants">${roster}</ul>
      </div>
      <div class="modal-actions">
        <button class="btn-mini danger" data-share-stop>${icon("close", 12)} Stop sharing</button>
      </div>`;
  }
  if (!st.relay) {
    return `
      <div class="share-setup-note">${icon("shield", 13)}<span>No relay is configured yet. LUCID defaults to a <b>self-hosted</b> relay for a sovereign, air-gapped posture - point it at your own relay, or opt into the public one.</span></div>
      <label class="share-lbl">Self-hosted relay URL</label>
      <div class="share-field"><input class="share-link-input" id="shareRelayUrl" type="text" placeholder="wss://relay.your-org.internal" spellcheck="false" /></div>
      <label class="share-check"><input type="checkbox" id="shareRelayPublic" /> <span>Use the public relay (<code>my.omp.sh</code>) instead - fine for a quick demo, not for sensitive work.</span></label>
      <div id="shareRelayErr" class="modal-err" hidden></div>
      <div class="modal-actions"><button class="btn-mini ok" data-share-relay-save>${icon("check", 12)} Save relay</button></div>`;
  }
  const src = st.relay.source === "public" ? "public relay" : st.relay.source === "embedded" ? "no third party" : "self-hosted relay";
  return `
    <div class="share-ready-note">${icon("check", 13)}<span>Relay ready: <b>${esc(st.relay.label)}</b> <span class="share-peer-tag">${esc(src)}</span></span></div>
    <p class="share-hint">Starting a share opens an end-to-end-encrypted room and broadcasts this session live. Guests are view-only. You can stop any time.</p>
    <div class="modal-actions">
      <button class="btn-mini" data-share-relay-change>${icon("sliders", 12)} Change relay</button>
      <button class="btn-mini ok" data-share-start>${icon("share", 12)} Start sharing</button>
    </div>`;
}

/** P-COLLAB.7: the "be the relay" toggle - host the embedded relay on this device (governance-gated). */
function shareRelayServeHtml(serve: import("./bridge.ts").CollabRelayServeStatus | null): string {
  if (!serve) return "";
  const org = serve.managed.org ? esc(serve.managed.org) : "your organization";
  if (!serve.managed.allowServe) {
    return `<div class="share-serve-card locked">${icon("shield", 13)}<span>Hosting a relay on this device is disabled by <b>${org}</b>.</span></div>`;
  }
  const locked = serve.managed.locked;
  const on = serve.running;
  const bind = on ? `${esc(serve.hostname ?? "")}:${serve.port}` : "";
  return `
    <div class="share-serve-card">
      <label class="share-serve-toggle">
        <input type="checkbox" id="shareServeToggle" ${on ? "checked" : ""} ${locked ? "disabled" : ""} />
        <span><b>Host the relay on this device</b> - no third party ever touches your session, even encrypted.</span>
      </label>
      ${on
        ? `<div class="share-serve-on">${icon("check", 12)} Relay live on <code>${bind}</code> · new shares use this device.</div>`
        : `<div class="share-serve-fields">
             <input class="share-link-input" id="shareServeHost" type="text" value="127.0.0.1" spellcheck="false" aria-label="bind address" ${locked ? "disabled" : ""} />
             <input class="share-link-input share-port" id="shareServePort" type="text" value="8790" spellcheck="false" aria-label="port" ${locked ? "disabled" : ""} />
           </div>
           <p class="share-serve-hint">Loopback (<code>127.0.0.1</code>) reaches a guest on this machine or over a tunnel/VPN; a LAN address may require an admin allowlist.</p>`}
      ${locked ? `<div class="share-managed">${icon("shield", 11)} Managed by ${org}</div>` : ""}
    </div>`;
}

/** Reflect a live share in the rail glyph (a small pulsing dot). Fetches status when not supplied. */
async function refreshShareDot(st?: CollabShareStatus | null): Promise<void> {
  const s = st !== undefined ? st : await bridge.collabStatus();
  const dot = $("#railShareDot");
  if (dot) (dot as HTMLElement).hidden = !s?.active;
}

function openSharePanel(): void {
  if ($("#shareModal")) return; // single instance
  const ov = el(`<div id="shareModal" class="modal-ov"><div class="modal share-modal" role="dialog" aria-modal="true" aria-labelledby="shareTitle">
    <button class="set-close share-x" data-share-close aria-label="Close">${icon("close", 16)}</button>
    <div class="modal-icon">${icon("share", 24)}</div>
    <h2 class="modal-title" id="shareTitle">Share this session · live</h2>
    <p class="modal-desc">Invite someone to watch this session in real time. The invite is end-to-end encrypted - your relay only ever sees ciphertext - and guests are <b>view-only</b>.</p>
    <div id="shareBody" class="share-body"><div class="share-loading">${icon("refresh", 14)} Loading…</div></div>
  </div></div>`);
  let poll: number | undefined;
  const close = () => { if (poll) clearInterval(poll); ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); close(); } };
  document.addEventListener("keydown", onKey);
  const body = $("#shareBody", ov) as HTMLElement;

  // P-COLLAB.7: the "be the relay" toggle (a checkbox → change event, not a click).
  ov.addEventListener("change", async (ev) => {
    const t = ev.target as HTMLElement;
    if (t.id !== "shareServeToggle") return;
    const on = (t as HTMLInputElement).checked;
    const host = ($("#shareServeHost", ov) as HTMLInputElement | null)?.value.trim() || "127.0.0.1";
    const port = Number(($("#shareServePort", ov) as HTMLInputElement | null)?.value.trim() || "8790");
    const r = await bridge.collabRelayServe({ enabled: on, host, port });
    if (!r.ok) { showToast({ tone: "danger", title: on ? "Couldn't host the relay" : "Couldn't stop the relay", desc: r.error ?? "", timeout: 5000 }); }
    else if (on) { showToast({ title: "Relay hosting on this device", desc: `Live on ${r.status?.hostname}:${r.status?.port} - new shares use it.`, timeout: 3000 }); }
    await draw();
  });

  const draw = async () => {
    const [st, serve] = await Promise.all([bridge.collabStatus(), bridge.collabRelayServeStatus()]);
    // The "be the relay" toggle sits above the share flow in the non-live states; when a share is live the
    // body is the roster + Stop, so the toggle is hidden (you can't change relay mid-share).
    body.innerHTML = (st?.active ? "" : shareRelayServeHtml(serve)) + shareBodyHtml(st);
    void refreshShareDot(st);
    return st;
  };
  // While a share is live, refresh only the roster in place (never clobbers copy buttons the user is using).
  const pollRoster = async () => {
    const st = await bridge.collabStatus();
    if (!st?.active) { await draw(); return; } // it ended elsewhere - fall back to a full redraw
    const list = $("#shareParticipants", ov); const count = $("#sharePeerCount", ov);
    if (count) count.textContent = String(st.participantCount);
    if (list) list.innerHTML = st.participants.length
      ? st.participants.map((p) => `<li class="share-peer"><span class="share-peer-dot"></span>${esc(p.name)} <span class="share-peer-tag">${esc(p.access)}</span></li>`).join("")
      : `<li class="share-peer-empty">${icon("clock", 13)} Waiting for someone to join…</li>`;
  };

  ov.addEventListener("click", async (ev) => {
    const t = ev.target as HTMLElement;
    if (t === ov || t.closest("[data-share-close]")) { close(); return; }
    const copy = t.closest("[data-copy]") as HTMLElement | null;
    if (copy) { const v = copy.dataset.copy ?? ""; try { await navigator.clipboard.writeText(v); showToast({ title: `${copy.dataset.copyWhat ?? "Copied"} copied`, desc: "Paste it to your guest.", timeout: 1800 }); } catch { showToast({ tone: "warn", title: "Couldn't copy", desc: "Copy it from the field instead." }); } return; }
    if (t.closest("[data-share-start]")) {
      const r = await bridge.collabStart();
      if (!r.ok) { showToast({ tone: "danger", title: "Couldn't start sharing", desc: r.error ?? "", timeout: 5000 }); return; }
      await draw();
      showToast({ title: "Sharing started", desc: "Copy the invite link and send it to your guest.", timeout: 3000 });
      if (!poll) poll = window.setInterval(() => { if ($("#shareModal")) void pollRoster(); }, 2500);
      return;
    }
    if (t.closest("[data-share-stop]")) { await bridge.collabStop(); if (poll) { clearInterval(poll); poll = undefined; } await draw(); showToast({ title: "Sharing stopped", desc: "The room is closed - guests were disconnected.", timeout: 2000 }); return; }
    if (t.closest("[data-share-relay-change]")) { body.innerHTML = shareBodyHtml({ active: false, participantCount: 0, participants: [], relay: null }); return; }
    if (t.closest("[data-share-relay-save]")) {
      const url = ($("#shareRelayUrl", ov) as HTMLInputElement | null)?.value.trim() ?? "";
      const pub = ($("#shareRelayPublic", ov) as HTMLInputElement | null)?.checked ?? false;
      const err = $("#shareRelayErr", ov) as HTMLElement | null;
      if (!url && !pub) { if (err) { err.textContent = "Enter a self-hosted wss:// URL, or tick the public relay."; err.hidden = false; } return; }
      if (url && !/^wss?:\/\//i.test(url)) { if (err) { err.textContent = "The relay URL must start with wss:// (or ws:// for a local test)."; err.hidden = false; } return; }
      await bridge.collabSetRelay({ url, publicOptIn: pub });
      await draw();
      return;
    }
  });
  document.body.append(ov);
  void draw();
}

// P-MARKET.1 (ADR-0158): the Plugin Marketplace popup - a curated, searchable catalog (Excalidraw pinned
// first, then Obsidian's top-ranked integrations by community downloads). Same conventions as About:
// single instance; closes on the X, a backdrop click, or Escape. The catalog is static - the only live
// action is opening a row's GitHub repo in the system browser; installs are P-MARKET.2 (gated).
function openMarketplace(): void {
  if ($("#mktModal")) return; // already open - don't stack
  const ov = el(`<div id="mktModal" class="mkt-scrim">${marketplaceHtml(MARKET_PLUGINS, "")}</div>`);
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); close(); } };
  ov.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const repo = t.closest("[data-mkt-repo]") as HTMLElement | null;
    if (repo) { window.open(repo.dataset.mktRepo!, "_blank", "noopener"); return; }
    if (t === ov || t.closest("[data-mkt-close]")) close(); // backdrop or the X
  });
  ov.addEventListener("input", (ev) => { // live search: re-render just the rows
    const t = ev.target as HTMLElement;
    if (t.id !== "mktSearch") return;
    const list = ov.querySelector("#mktList");
    if (list) list.innerHTML = marketRowsHtml(MARKET_PLUGINS, (t as HTMLInputElement).value);
  });
  document.addEventListener("keydown", onKey);
  document.body.append(ov);
  (ov.querySelector("#mktSearch") as HTMLInputElement | null)?.focus();
}

function wire(): void {
  // rail
  $$(".rail-btn[data-rail]").forEach((b) => b.addEventListener("click", () => {
    const r = (b as HTMLElement).dataset.rail!;
    // Toggle: clicking the rail icon of a fly-out that's ALREADY open slides it back away (and the
    // close() restores the inspector + re-activates the chat rail). Second click = dismiss.
    if (r === "knowledge" && kgOpen) return closeKnowledge();
    if (r === "preview" && previewOpen) return closePreview();
    if (r === "agentBuilder" && abOpen) return closeAgentBuilder();
    if (r === "settings" && state.settingsOpen) return closeSettings();
    if (r === "skills" && skillsOpen) return closeSkills(); // P-SKILL.4
    if (r !== "knowledge") closeKnowledge();
    if (r !== "preview") closePreview(); // P-PREVIEW.1: right-edge surfaces are mutually exclusive
    if (r !== "agentBuilder") closeAgentBuilder(); // P-AGENT.2b
    if (r !== "skills") closeSkills(); // P-SKILL.4
    if (r === "security" || r === "memory") focusInspector(r);
    else if (r === "dev") { focusInspector("dev"); void loadDev(); } // ADR-0009 Phase D
    else if (r === "chat") { closeSettings(); $("#input")?.focus(); $$(".rail-btn").forEach((x) => x.classList.toggle("active", x === b)); }
    else if (r === "settings") openSettings();
    else if (r === "knowledge") openKnowledge();
    else if (r === "preview") openPreview();
    else if (r === "agentBuilder") openAgentBuilder(); // P-AGENT.2b
    else if (r === "skills") openSkills(); // P-SKILL.4
    else palette.show();
  }));
  // P-AGENT.2b: Agent Builder toolbar (add-node kinds · connect mode · validate · save).
  $$("[data-ab-add]").forEach((b) => b.addEventListener("click", () => addAbNode((b as HTMLElement).dataset.abAdd as NodeKind)));
  $("#abConnect")?.addEventListener("click", () => toggleAbConnect());
  $("#abValidate")?.addEventListener("click", () => renderAbErrors());
  $("#abSave")?.addEventListener("click", () => void saveAgentBuilder());
  $("#abExport")?.addEventListener("click", () => void exportAgentBuilder());
  $("#abRun")?.addEventListener("click", () => openAbRunPanel());
  $("#abSecrets")?.addEventListener("click", () => void openAbSecretsPanel());
  $("#abToolsBtn")?.addEventListener("click", () => openAbToolsPanel()); // P-AGENT.9: allow-list chips
  $("#abRunsBtn")?.addEventListener("click", () => void openAbRunsPanel()); // P-AGENT.13: run traces
  $("#abScheduleBtn")?.addEventListener("click", () => openAbSchedulePanel()); // P-AGENT.14: cadence runs
  $("#abHistoryBtn")?.addEventListener("click", () => void openAbHistoryPanel()); // P-AGENT.17: revisions
  $("#abTemplatesBtn")?.addEventListener("click", () => void openAbTemplatesPanel()); // P-AGENT.17: gallery
  $("#abShare")?.addEventListener("click", () => void shareAgentBuilder()); // P-AGENT.9: portable share
  $("#abN8n")?.addEventListener("click", () => void n8nExportAgentBuilder()); // P-AGENT.10: n8n export
  $("#abN8nPush")?.addEventListener("click", () => void n8nPushAgentBuilder()); // P-AGENT.10: add-on push
  $("#abImportBtn")?.addEventListener("click", () => ($("#abImportFile") as HTMLInputElement | null)?.click()); // P-AGENT.9
  $("#abImportFile")?.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = ""; // allow re-importing the same file
    if (f) void importAgentFile(f);
  });
  // P-SKILL.4 (ADR-0097): Skills directory - close + event-delegated per-row menu.
  $("#skillsClose")?.addEventListener("click", () => closeSkills());
  $("#skillsBody")?.addEventListener("click", (e) => void onSkillAction(e));
  // P-PREVIEW.1 (ADR-0096): preview panel - open a local file, reload, screenshot to chat, close.
  $("#prevClose")?.addEventListener("click", () => closePreview());
  $("#prevOpen")?.addEventListener("click", () => loadPreview(($("#prevPath") as HTMLInputElement | null)?.value ?? ""));
  $("#prevPath")?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") loadPreview(($("#prevPath") as HTMLInputElement).value); });
  $("#prevReload")?.addEventListener("click", () => { const f = $("#prevFrame") as HTMLIFrameElement | null; if (f && !f.hidden && f.src) f.src = f.src; });
  $("#prevBrowse")?.addEventListener("click", () => void browsePreviewFile()); // P-PREVIEW.5: open cwd file
  $("#prevMarkup")?.addEventListener("click", (e) => openMarkupMenu(e.currentTarget as HTMLElement)); // P-PREVIEW.5: markup tools
  $("#prevShot")?.addEventListener("click", () => void screenshotPreviewToChat());
  // Knowledge graph: close, lens toggle, forget-fact, export (P9.4)
  $("#kgClose")!.addEventListener("click", () => closeKnowledge());
  // P-KG-CODE.1: workspace code graph - toggle personal ↔ code; Update re-ingests.
  $("#kgViews")?.addEventListener("click", (e) => openKgViewsMenu(e.currentTarget as HTMLElement)); // P-KGUI.1 dropdown
  $("#kgCodeUpdate")?.addEventListener("click", () => void renderCodeGraph(true));
  // P-KG-CODE.1b: re-center button + keep the flyout state (resizer + center offset) in sync however the
  // side panel is toggled (a MutationObserver on its `hidden` attribute catches every path).
  $("#kgCenter")?.addEventListener("click", () => kgHandle?.fit());
  const kgSideEl = $("#kgSide");
  if (kgSideEl) new MutationObserver(() => syncKgSideOpen()).observe(kgSideEl, { attributes: true, attributeFilter: ["hidden"] });
  // P-KG-CODE.1d: a code-node path (or an Imports/Imported-by entry) opens that file in the IDE.
  $("#kgSide")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-cg-open]") as HTMLElement | null;
    if (b) void openCodeFile(b.dataset.cgOpen!);
  });
  // P-KG-SEARCH.1: live node search - highlight + center matches as you type (Esc clears).
  $("#kgSearch")?.addEventListener("input", (e) => {
    const q = (e.target as HTMLInputElement).value;
    kgHandle?.setSearch(q.trim() ? matchNodes(kgData?.nodes ?? [], q) : null);
  });
  $("#kgSearch")?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") { (e.target as HTMLInputElement).value = ""; kgHandle?.setSearch(null); }
  });
  // P-PERF.2: the performance-mode chip - cycle auto -> full -> reduced -> minimal; auto follows battery/CPU.
  $("#kgPerf")?.addEventListener("click", () => {
    const m = perfWatch.cycleMode();
    paintPerfChip();
    kgForceRender = false; // a mode change re-evaluates the minimal-tier pause
    showToast({
      title: `Performance mode: ${m}`,
      desc: m === "auto" ? `Following battery + CPU (now: ${perfWatch.tier()}).`
        : m === "minimal" ? "Graph visualization pauses; the agent keeps full knowledge access."
        : m === "reduced" ? "Calm graph: no particle flow, shorter settle, capped nodes."
        : "Full fidelity.",
      timeout: 2600,
    });
    if (kgOpen) void (kbGraphMode ? renderKbGraph() : kgCodeMode ? renderCodeGraph(false) : renderKnowledge());
  });
  // Auto-tier flips (plug/unplug, battery level) repaint the chip and calm/wake a LIVE graph in place -
  // no remount, so the layout the user is looking at never jumps.
  perfWatch.onChange(() => { paintPerfChip(); kgHandle?.setCalm(perfWatch.tier() !== "full"); });
  paintPerfChip();
  $("#kgData")?.addEventListener("click", (e) => openKgDataMenu(e.currentTarget as HTMLElement)); // P-KGUI.2 dropdown
  $("#knowledge")!.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const lens = t.closest("[data-lens]") as HTMLElement | null;
    if (lens) { kgLens = lens.dataset.lens as "kind" | "trust"; kgHandle?.setLens(kgLens); $$("[data-kg-lens] button").forEach((x) => x.classList.toggle("on", x === lens)); return; }
    if (t.closest("#kgRelateDo")) { void relatePicked(); return; }
    if (t.closest("#kgRelateClear")) { kgHandle?.clearRelatePicks(); return; }
    const unrel = t.closest("[data-unrelate]") as HTMLElement | null; // P-KG-REL.3 remove a relationship
    if (unrel) {
      const from = unrel.dataset.from!, to = unrel.dataset.to!, rel = unrel.dataset.rel ?? "";
      if (kgData) {
        const before = kgData;
        kgData = removeEdgeOptimistic(kgData, from, to, rel); // vanish on click
        kgSig = kgSignature(kgData);
        kgHandle?.update(kgData);
        renderKgSide(kgSelId);
        const r = await bridge.personalUnrelate(from, to, rel).catch(() => null);
        if (!r?.ok) { // server refused → roll back
          kgData = before; kgSig = kgSignature(kgData); kgHandle?.update(kgData); renderKgSide(kgSelId);
          showToast({ tone: "danger", title: "Couldn't remove that", desc: r?.error ?? "Try again.", actions: [{ label: "OK" }], timeout: 4000 });
        }
      }
      return;
    }
    const forget = t.closest("[data-forget]") as HTMLElement | null;
    if (forget) {
      const fid = forget.dataset.forget!;
      if (forgettingIds.has(fid)) return; // de-dup: ignore mashed clicks (#113) - one server call, one toast
      forgettingIds.add(fid);
      // Optimistic + instant (#113): drop the fact (and its now-empty node + dangling edges) from the live
      // graph immediately, so the row/node vanish on click instead of after a 20-30s re-decrypt. Keep the
      // pre-change graph for rollback if the server call fails.
      const prev = kgData;
      if (kgData) {
        const { data, nodeRemoved } = applyForget(kgData, fid);
        kgData = data;
        if (nodeRemoved && kgSelId === nodeRemoved) kgSelId = null;
        kgSig = kgSignature(kgData); // keep the live-poll baseline in sync so it doesn't redundantly re-update
        kgHandle?.update(kgData);
        renderKgSide(kgSelId);
      }
      const r = await bridge.personalForget(fid).catch(() => null);
      forgettingIds.delete(fid);
      if (r?.ok) {
        showToast({ title: "Forgotten", desc: "The agent will stop recalling that fact.", timeout: 2000 });
      } else {
        // Server refused/failed: roll back the optimistic removal so the graph reflects the truth.
        kgData = prev;
        if (kgData) { kgSig = kgSignature(kgData); kgHandle?.update(kgData); }
        renderKgSide(kgSelId);
        showToast({ tone: "danger", title: "Couldn't forget that", desc: "Nothing changed - please try again.", actions: [{ label: "OK" }], timeout: 4000 });
      }
    }
  });
  $("#railCmd")!.addEventListener("click", () => palette.show());
  // (the titlebar "Commands" button was removed - the palette opens from the rail glyph #railCmd + Ctrl/⌘+K)
  $("#cmdkBtn")?.addEventListener("click", () => palette.show());
  $("#railAbout")?.addEventListener("click", () => openAbout());
  $("#railMarket")?.addEventListener("click", () => openMarketplace()); // P-MARKET.1 (ADR-0158)
  $("#railReports")?.addEventListener("click", () => openReportsPanel()); // P-REPORT.1 (ADR-0116)
  $("#railShare")?.addEventListener("click", () => openSharePanel()); // P-COLLAB.3 (ADR-0192)
  void refreshShareDot(); // reflect any already-live share in the rail glyph
  // Per-message copy (markdown) + save-as-.md
  $("#thread")!.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const copyBtn = t.closest("[data-msg-copy]") as HTMLElement | null;
    const saveBtn = t.closest("[data-msg-save]") as HTMLElement | null;
    const speakBtn = t.closest("[data-msg-speak]") as HTMLElement | null;
    if (speakBtn) { // P-VOICE.1: read-aloud — the RENDERED text (no markdown symbols)
      const plain = (t.closest(".msg")?.querySelector(".text") as HTMLElement | null)?.innerText?.trim()
        || ((t.closest(".msg") as MsgNode | null)?._md ?? "").trim();
      if (!plain) { showToast({ tone: "warn", title: "Nothing to read yet", desc: "Wait for the reply to finish.", timeout: 2000 }); return; }
      void speakText(plain, speakBtn); return;
    }
    if (!copyBtn && !saveBtn) return;
    const md = ((t.closest(".msg") as MsgNode | null)?._md ?? "").trim();
    if (!md) { showToast({ tone: "warn", title: "Nothing to copy yet", desc: "Wait for the reply to finish.", actions: [{ label: "OK" }], timeout: 2000 }); return; }
    if (copyBtn) {
      try {
        await navigator.clipboard.writeText(md);
        copyBtn.classList.add("ok"); copyBtn.innerHTML = icon("check", 13);
        setTimeout(() => { copyBtn.classList.remove("ok"); copyBtn.innerHTML = icon("copy", 13); }, 1200);
      } catch { showToast({ tone: "danger", title: "Copy failed", desc: "Clipboard unavailable in this view.", actions: [{ label: "OK" }], timeout: 2800 }); }
    } else if (saveBtn) {
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "lucid-reply.md"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }
  });
  // Safety net: the model hover card lives on document.body and is orphaned when the
  // picker closes/re-renders (its mouseout never fires). Dismiss it the moment the
  // pointer isn't over a model row, and on any click/wheel.
  const dropTip = () => { if (mtCard || mtCur) { mtCur = null; hideModelTip(true); } };
  window.addEventListener("mousemove", (e) => { if ((mtCard || mtCur) && !(e.target as HTMLElement).closest?.("[data-model]")) dropTip(); }, { passive: true, capture: true });
  window.addEventListener("mousedown", dropTip, { capture: true });
  window.addEventListener("wheel", dropTip, { passive: true, capture: true });

  // model / mode / thinking picker
  $("#modelBadge")!.addEventListener("click", () => openConfigPopover($("#modelBadge")!));

  // text zoom
  $("#zoomIn")!.addEventListener("click", () => nudgeZoom(0.1));
  $("#zoomOut")!.addEventListener("click", () => nudgeZoom(-0.1));
  $("#zoomLvl")!.addEventListener("click", () => resetZoom());
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); nudgeZoom(0.1); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); nudgeZoom(-0.1); }
    else if (e.key === "0") { e.preventDefault(); resetZoom(); }
    // P-REPORT.5b: Ctrl/⌘+D toggles the mic (voice input), matching the mic button's tooltip.
    else if ((e.key === "d" || e.key === "D") && !e.shiftKey && !e.altKey) { e.preventDefault(); void toggleMicRecording(); }
  });

  // inspector collapse ↔ metrics rail
  $("#inspCollapse")!.addEventListener("click", () => setInspectorRail(true));
  $("#railExpand")!.addEventListener("click", () => setInspectorRail(false));

  // composer agent controls → focused per-control dropdowns
  // (model / mode / thinking dropdowns are reached from the top #modelBadge picker - not duplicated here)
  $("#ctPersona")!.addEventListener("click", () => openPersonaDropdown($("#ctPersona")!));
  $("#ctSkill")!.addEventListener("click", () => openSkillDropdown($("#ctSkill")!));
  $("#ctMic")?.addEventListener("click", () => void toggleMicRecording()); // P-VOICE.1 (ADR-0115)

  // settings page actions (delegated)
  $("#setClose")!.addEventListener("click", () => closeSettings());
  // P-IDE.1c: enable the China-unlock button only when exactly ACKNOWLEDGE is typed.
  $("#setBody")!.addEventListener("input", (e) => {
    const t = e.target as HTMLElement;
    if (t.id === "chinaAckInput") { const b = $("#chinaAckBtn", $("#setBody")!) as HTMLButtonElement | null; if (b) b.disabled = (t as HTMLInputElement).value.trim() !== "ACKNOWLEDGE"; }
    if (t.id === "thirdPartyAckInput") { const b = $("#thirdPartyAckBtn", $("#setBody")!) as HTMLButtonElement | null; if (b) b.disabled = (t as HTMLInputElement).value.trim() !== "ACKNOWLEDGE"; }
  });
  // P-VOICE.1 (ADR-0115): persist a voice setting when a Voice-card control changes.
  $("#setBody")!.addEventListener("change", async (e) => {
    const t0 = e.target as HTMLElement;
    // P-APPEAR.1: chat-background mode + image upload
    if (t0.id === "bgMode") { void updateChatBg({ mode: (t0 as HTMLSelectElement).value as "off" | "ambient" | "flashlight" }); return; }
    if (t0.id === "bgFile") {
      const f = (t0 as HTMLInputElement).files?.[0]; if (!f) return;
      if (f.size > 9 * 1024 * 1024) { showToast({ tone: "warn", title: "Image too large", desc: "Pick an image under ~9 MB (or compress it first).", timeout: 3400 }); return; }
      const reader = new FileReader();
      reader.onload = () => void updateChatBg({ image: String(reader.result), mode: state.chatBg.mode === "off" ? "ambient" : state.chatBg.mode });
      reader.readAsDataURL(f);
      return;
    }
    // P-LOCAL.3 (ADR-0135): enable/disable a Local Provider
    if (t0.matches("[data-lp-toggle]")) {
      const row = t0.closest("[data-lp-id]") as HTMLElement | null;
      if (row?.dataset.lpId) { await bridge.localProviderEnable(row.dataset.lpId, (t0 as HTMLInputElement).checked).catch(() => {}); }
      return;
    }
    const vs = t0.closest("[data-voice-set]") as HTMLInputElement | HTMLSelectElement | null;
    if (!vs) return;
    const key = vs.dataset.voiceSet!;
    await bridge.setVoiceSettings({ [key]: vs.value } as never).catch(() => {});
    if (key === "sttProvider") { const row = $("#voiceSttUrlRow"); if (row) (row as HTMLElement).hidden = vs.value !== "whisper"; }
    if (key === "ttsProvider") void loadVoices(); // only ElevenLabs lists custom voices
  });
  $("#setBody")!.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const head = t.closest("[data-acc-toggle]") as HTMLElement | null;
    if (head) { const k = head.dataset.accToggle!; (head.closest(".acc")!.classList.toggle("open")) ? OPEN.add(k) : OPEN.delete(k); return; }
    // P-APPEAR.1: chat-background upload / remove
    if (t.closest("#bgUpload")) { ($("#bgFile") as HTMLInputElement | null)?.click(); return; }
    if (t.closest("#bgClear")) { void updateChatBg({ image: "", mode: "off" }); return; }
    // P-TRIV.4 (ADR-0191): Trivia Wire toggle + opt-in re-seed sources + the Recycle action
    if (t.closest("#trivToggle")) {
      const on = ($("#trivToggle", $("#setBody")!) as HTMLInputElement)?.checked ?? true;
      try { localStorage.setItem(TRIVIA_ENABLED_KEY, on ? "1" : "0"); } catch { /* ignore */ }
      if (on) mountTrivia(); else { trivShown = false; trivEl?.classList.remove("on"); }
      fillSec("trivia", secTrivia());
      showToast({ title: on ? "Trivia Wire on" : "Trivia Wire off", desc: on ? "It'll scroll in the status bar while the agent works or you're idle." : "Hidden everywhere - switch it back on here anytime.", timeout: 2600 });
      return;
    }
    if (t.closest("#trivSrcSessions") || t.closest("#trivSrcKg") || t.closest("#trivSrcCode")) {
      const body = $("#setBody")!;
      try {
        localStorage.setItem(TRIVIA_SOURCES_KEY, JSON.stringify({
          sessions: ($("#trivSrcSessions", body) as HTMLInputElement | null)?.checked ?? false,
          kg: ($("#trivSrcKg", body) as HTMLInputElement | null)?.checked ?? false,
          codegraph: ($("#trivSrcCode", body) as HTMLInputElement | null)?.checked ?? false,
        }));
      } catch { /* ignore */ }
      return;
    }
    if (t.closest("#trivPackReset")) {
      clearTriviaPack(state.userRole);
      refreshTriviaGame(); // rebuild on the seed bank now that the generated pack is gone
      fillSec("trivia", secTrivia());
      showToast({ title: "Back to the built-in pack", desc: "The generated questions were cleared for this role.", timeout: 2600 });
      return;
    }
    if (t.closest("#trivReseed")) { await reseedTrivia(t.closest("#trivReseed") as HTMLButtonElement); return; }
    // P-LOCAL.3 (ADR-0135): Local Providers card
    if (t.closest("[data-lp-addtoggle]")) { (t.closest(".lp-add") as HTMLElement | null)?.classList.toggle("open"); return; }
    if (t.closest("[data-lp-add]")) { await addLocalProviderFromForm(); return; }
    if (t.closest("[data-lp-test-form]")) { await testLocalProviderConn(($("#lpBaseUrl", $("#setBody")!) as HTMLInputElement | null)?.value ?? ""); return; }
    const lpTest = t.closest("[data-lp-test]") as HTMLElement | null;
    if (lpTest) { await testLocalProviderConn(lpTest.dataset.url ?? ""); return; }
    if (t.closest("[data-lp-rekey-save]")) { const w = t.closest("[data-lp-id]") as HTMLElement | null; if (w) await saveLocalProviderKey(w); return; }
    if (t.closest("[data-lp-rekey]")) { const rk = (t.closest("[data-lp-id]") as HTMLElement | null)?.querySelector(".lp-rekey") as HTMLElement | null; if (rk) rk.hidden = !rk.hidden; return; }
    if (t.closest("[data-lp-apply]")) { showToast({ title: "Restarting LUCID…", desc: "Applying your local providers.", timeout: 2000 }); await bridge.relaunch().catch(() => {}); return; }
    const lpDel = t.closest("[data-lp-del]") as HTMLElement | null;
    if (lpDel) { const id = (lpDel.closest("[data-lp-id]") as HTMLElement | null)?.dataset.lpId; if (id) await deleteLocalProvider(id); return; }
    // workspace
    if (t.closest("#wsBrowse")) {
      // Prefer the NATIVE OS folder-open dialog (Electron): it browses the whole machine and can create new
      // folders, with no home-folder confinement. Fall back to the in-app browser only in a plain browser
      // build where no native dialog exists.
      const path = bridge.isElectron && bridge.pickFolder ? await bridge.pickFolder() : await openFolderBrowser();
      if (path) await applyWorkspace(path);
      return;
    }
    if (t.closest("#wsSet")) { const v = ($("#wsPath", $("#setBody")!) as HTMLInputElement)?.value.trim(); if (v) await applyWorkspace(v); return; }
    if (t.closest("#wsClone")) {
      const url = ($("#wsCloneUrl", $("#setBody")!) as HTMLInputElement)?.value.trim();
      if (!url) return;
      showToast({ title: "Cloning…", desc: "Fetching the repo - this can take a moment.", timeout: 2500 });
      const info = await bridge.cloneWorkspace(url);
      if (info?.cloned) { state.workspace = info; renderWorkspaceBar(); seedThread(); void renderSessions(); void renderSettings(); showToast({ title: "Cloned & opened", desc: `Agent now works in ${info.name}.`, actions: [{ label: "OK" }], timeout: 3000 }); }
      else showToast({ tone: "danger", title: "Clone failed", desc: (info?.error ?? "Check the URL and your git access.").slice(0, 180), actions: [{ label: "OK" }], timeout: 6000 });
      return;
    }
    const wsr = t.closest("[data-ws]") as HTMLElement | null;
    if (wsr) { await applyWorkspace(wsr.dataset.ws!); return; }
    // P-IDE.1c: China-origin model unlock / re-lock
    if (t.closest("#chinaAckBtn")) {
      const v = ($("#chinaAckInput", $("#setBody")!) as HTMLInputElement)?.value.trim() ?? "";
      if (v !== "ACKNOWLEDGE") { showToast({ title: "Type ACKNOWLEDGE", desc: "Confirm you accept the data-sovereignty risk for these models.", actions: [{ label: "OK" }], timeout: 3000 }); return; }
      state.chinaAck = !!(await bridge.setChinaAck(true))?.acknowledged;
      await loadConfig(); void renderSettings();
      showToast({ title: "Restricted-origin models unlocked", desc: "They now appear in the picker. You accepted the data-sovereignty risk.", actions: [{ label: "OK" }], timeout: 3600 });
      return;
    }
    if (t.closest("#chinaRelock")) {
      state.chinaAck = !!(await bridge.setChinaAck(false))?.acknowledged;
      await loadConfig(); void renderSettings();
      showToast({ title: "Re-locked", desc: "China-origin models are hidden again.", actions: [{ label: "OK" }], timeout: 2600 });
      return;
    }
    // Third-party / non-U.S. "More providers" reveal / re-lock (mirrors the China-origin gate).
    if (t.closest("#thirdPartyAckBtn")) {
      const v = ($("#thirdPartyAckInput", $("#setBody")!) as HTMLInputElement)?.value.trim() ?? "";
      if (v !== "ACKNOWLEDGE") { showToast({ title: "Type ACKNOWLEDGE", desc: "Confirm you accept the third-party / non-U.S. data risk for these providers.", actions: [{ label: "OK" }], timeout: 3000 }); return; }
      state.thirdPartyAck = !!(await bridge.setThirdPartyAck(true))?.acknowledged;
      fillSec("others", secOthers(state.auth));
      showToast({ title: "More providers revealed", desc: "Third-party / non-U.S. providers are now listed. You accepted the data risk.", actions: [{ label: "OK" }], timeout: 3600 });
      return;
    }
    if (t.closest("#thirdPartyRelock")) {
      state.thirdPartyAck = !!(await bridge.setThirdPartyAck(false))?.acknowledged;
      fillSec("others", secOthers(state.auth));
      showToast({ title: "Re-locked", desc: "Third-party providers are hidden again behind the acknowledgement.", actions: [{ label: "OK" }], timeout: 2600 });
      return;
    }
    if (t.closest("#voiceFav")) { // P-VOICE.1: star/unstar the selected voice (favorites list first)
      const vid = ($("#voiceSelect", $("#setBody")!) as HTMLSelectElement | null)?.value;
      if (!vid) { showToast({ tone: "warn", title: "Pick a voice", desc: "Select a voice to favorite.", timeout: 2000 }); return; }
      const data = await bridge.voices().catch(() => null);
      const favs = new Set(data?.favorites ?? []);
      const nowFav = !favs.has(vid); if (nowFav) favs.add(vid); else favs.delete(vid);
      await bridge.setVoiceSettings({ ttsVoiceFavorites: [...favs] });
      await loadVoices();
      showToast({ title: nowFav ? "Added to favorites" : "Removed from favorites", desc: nowFav ? "This voice now appears first in the picker." : "Removed from your favorites.", timeout: 1800 });
      return;
    }
    const save = t.closest("[data-savekey]") as HTMLElement | null;
    if (save) {
      const env = save.dataset.savekey!;
      const inp = $(`.prov-key[data-env="${env}"]`, $("#setBody")!) as HTMLInputElement | null;
      const val = inp?.value.trim() ?? "";
      if (!val) { showToast({ tone: "warn", title: "Nothing to save", desc: "Paste a key first.", actions: [{ label: "OK" }], timeout: 2000 }); return; }
      await bridge.saveKey(env, val);
      showToast({ title: `${env} saved`, desc: "Stored on this machine and passed to omp. New turns use it.", actions: [{ label: "OK" }], timeout: 2800 });
      void renderSettings();
      if (env === "ASKSAGE_API_KEY") { await loadConfig(); await loadAsksage(); } // surface gov models + usage
      return;
    }
    if (t.closest("#asksageSaveBase")) {
      const base = ($("#asksageBase", $("#setBody")!) as HTMLInputElement)?.value.trim() ?? "";
      await bridge.saveAsksage({ baseUrl: base });
      showToast({ title: "AskSage base URL saved", desc: base || "Reset to the default gov endpoint.", actions: [{ label: "OK" }], timeout: 2600 });
      await loadConfig(); await loadAsksage(); void renderSettings();
      return;
    }
    if (t.closest("#asksageOnly")) {
      if (state.managed?.locks?.models) return; // ADR-0068: org-locked routing - not user-toggleable
      const only = ($("#asksageOnly", $("#setBody")!) as HTMLInputElement)?.checked ?? false;
      await bridge.saveAsksage({ only });
      state.asksage = { ...(state.asksage ?? { configured: false, base: "", only: false, limit: 200_000, datasets: [], queryModel: "gpt-5.2", persona: "" }), only };
      // Lockdown must guarantee gateway routing: if we're on a direct model, switch
      // to a gov one so no turn can bypass AskSage.
      if (only) {
        const model = state.config.find((c) => c.id === "model");
        if (model && !isAsksage(model.currentValue)) {
          const gov = model.options.find((o) => isAsksage(o.value));
          if (gov) await applyConfig("model", gov.value);
        }
      }
      showToast({ title: only ? "Lockdown ON" : "Lockdown off", desc: only ? "Every turn now routes through the AskSage gov gateway." : "Direct providers are selectable again.", actions: [{ label: "OK" }], timeout: 2800 });
      updateComposerTools(); renderStatus();
      return;
    }
    if (t.closest("#headroomToggle")) {
      const enabled = ($("#headroomToggle", $("#setBody")!) as HTMLInputElement)?.checked ?? false;
      const st = await bridge.setHeadroom(enabled);
      showToast({ title: enabled ? "Compression on" : "Compression off", desc: enabled ? (st?.running ? `headroom proxy running on :${st.port}.` : "headroom enabled - proxy will start.") : "headroom proxy stopped.", actions: [{ label: "OK" }], timeout: 2800 });
      void renderSettings();
      return;
    }
    // ADR-0009 Phase D: Developer mode → reveal/hide the Logs rail panel.
    if (t.closest("#devModeToggle")) {
      const enabled = ($("#devModeToggle", $("#setBody")!) as HTMLInputElement)?.checked ?? false;
      await bridge.setDeveloperMode(enabled);
      await loadDev();
      showToast({ title: enabled ? "Developer mode on" : "Developer mode off", desc: enabled ? "A read-only Logs panel is now in the rail (telemetry, lineage, audit)." : "The Logs panel is hidden.", actions: [{ label: "OK" }], timeout: 3000 });
      return;
    }
    // ── ADR-0088 (P-ROLE.1): role switcher (cosmetic - re-applies the calm default surfacing) ──
    const rolePick = t.closest("[data-role-pick]") as HTMLElement | null;
    if (rolePick?.dataset.rolePick) {
      const role = rolePick.dataset.rolePick as UserRole;
      if (role !== state.userRole) {
        state.userRole = role;
        await bridge.saveRole(role).catch(() => null);
        applyRoleDefault(role);
        fillSec("profile", secProfile({ username: state.username, email: state.email, attribution: state.attribution ?? undefined }));
        showToast({ title: `${ROLE_META[role].label} view`, desc: ROLE_META[role].blurb, timeout: 2800 });
      }
      return;
    }
    // ADR-0089 (P-ROLE.1b): replay the first-run walkthrough on demand.
    if (t.closest("#replayTour")) { startTour(state.userRole ?? "developer"); return; }
    // ── P-MCP.1 (ADR-0020): MCP connectors ──
    if (t.closest("#mcpAdd")) {
      const body = $("#setBody")!;
      const name = (($("#mcpName", body) as HTMLInputElement)?.value ?? "").trim();
      const url = (($("#mcpUrl", body) as HTMLInputElement)?.value ?? "").trim();
      const transport = (($("#mcpTransport", body) as HTMLSelectElement)?.value === "sse" ? "sse" : "http") as "http" | "sse";
      const token = (($("#mcpToken", body) as HTMLInputElement)?.value ?? "").trim();
      if (!url) { showToast({ title: "URL required", desc: "Enter the MCP server's URL.", actions: [{ label: "OK" }], timeout: 3000 }); return; }
      await bridge.mcpUpsert({ name: name || "MCP server", url, transport, token: token || undefined });
      hydrateMcp();
      showToast({ title: "MCP connector added", desc: `${name || "Server"} is configured - the agent picks it up on your next turn.`, meta: "omp owns the connection · tool output is still scanned", actions: [{ label: "OK" }], timeout: 5000 });
      return;
    }
    const mcpToggle = t.closest("[data-mcp-toggle]") as HTMLElement | null;
    if (mcpToggle) { await bridge.mcpToggle(mcpToggle.dataset.mcpToggle!, mcpToggle.dataset.mcpOn === "1"); hydrateMcp(); return; }
    const mcpRemove = t.closest("[data-mcp-remove]") as HTMLElement | null;
    if (mcpRemove) { await bridge.mcpRemove(mcpRemove.dataset.mcpRemove!); hydrateMcp(); showToast({ title: "Connector removed", desc: "The MCP server was removed; the agent drops it on the next turn.", actions: [{ label: "OK" }], timeout: 3000 }); return; }
    if (t.closest("#agentAdd")) {
      const body = $("#setBody")!;
      const name = (($("#agentName", body) as HTMLInputElement)?.value ?? "").trim();
      const kind = ($("#agentKind", body) as HTMLSelectElement)?.value ?? "acp";
      const command = (($("#agentCommand", body) as HTMLInputElement)?.value ?? "").trim();
      const args = (($("#agentArgs", body) as HTMLInputElement)?.value ?? "").trim();
      const permissionPolicy = ($("#agentPerm", body) as HTMLSelectElement)?.value ?? "deny";
      if (!command) { showToast({ title: "Command required", desc: "Enter the command that starts the remote agent's ACP server (e.g. hermes acp).", actions: [{ label: "OK" }], timeout: 4000 }); return; }
      await bridge.remoteAgentUpsert({ name: name || "Remote agent", kind, command, args, permissionPolicy });
      hydrateAgents();
      showToast({ title: "Remote agent added", desc: `${name || "Agent"} is proxied through the Lucid firewall — the agent picks it up on your next turn.`, meta: "scanned both ways · permissions default deny", actions: [{ label: "OK" }], timeout: 5000 });
      return;
    }
    const agentToggle = t.closest("[data-agent-toggle]") as HTMLElement | null;
    if (agentToggle) { await bridge.remoteAgentToggle(agentToggle.dataset.agentToggle!, agentToggle.dataset.agentOn === "1"); hydrateAgents(); return; }
    const agentRemove = t.closest("[data-agent-remove]") as HTMLElement | null;
    if (agentRemove) { await bridge.remoteAgentRemove(agentRemove.dataset.agentRemove!); hydrateAgents(); showToast({ title: "Connection removed", desc: "The remote agent was removed; the agent drops it next turn.", actions: [{ label: "OK" }], timeout: 3000 }); return; }
    // ── Network Whitelist (P-NETWL.2, ADR-0106) ──
    if (t.closest("#wlAuthFile")) {
      const body = $("#setBody")!;
      const kind = ($("#wlAuthKind", body) as HTMLSelectElement)?.value || "apikey";
      const label = ($("#wlAuthLabel", body) as HTMLInputElement)?.value.trim() || undefined;
      const rotRaw = (($("#wlAuthRotate", body) as HTMLInputElement)?.value ?? "").trim();
      const rotationIntervalDays = rotRaw ? Math.max(0, Math.floor(Number(rotRaw))) : undefined;
      const r = await bridge.credStoreFile({ kind, label, rotationIntervalDays });
      if (!r) return; // user cancelled the native dialog
      if ("error" in r) { showToast({ title: "Couldn't store file", desc: r.error === "os-encryption-unavailable" ? "OS encryption isn't available on this machine, so the secret can't be stored securely (fail-closed)." : r.error, actions: [{ label: "OK" }], timeout: 5000 }); return; }
      wlPendingCred = { ref: r.ref, kind: r.kind, label: r.label };
      const btn = t.closest("#wlAuthFile") as HTMLElement; btn.innerHTML = `${icon("check", 12)} ${esc(r.label ?? "file")}`;
      showToast({ title: "Credential stored (encrypted)", desc: `Saved to the vault as "${esc(r.label ?? r.ref)}". Click Add to attach it to the entry.`, timeout: 3200 });
      return;
    }
    if (t.closest("#wlAdd")) {
      const body = $("#setBody")!;
      const pattern = (($("#wlPattern", body) as HTMLInputElement)?.value ?? "").trim();
      if (!pattern) { showToast({ title: "Pattern required", desc: "Enter a domain (*.example.com) or an IP / CIDR (10.0.0.0/8).", actions: [{ label: "OK" }], timeout: 3000 }); return; }
      const kind = ($("#wlKind", body) as HTMLSelectElement)?.value === "ip" ? "ip" : "domain";
      const zone = ($("#wlZone", body) as HTMLSelectElement)?.value === "internal" ? "internal" : "external";
      const scope = (($("#wlScope", body) as HTMLSelectElement)?.value ?? "always") as "always" | "project" | "loop";
      const budgetRaw = (($("#wlBudget", body) as HTMLInputElement)?.value ?? "").trim();
      const callBudget = budgetRaw ? Math.max(0, Math.floor(Number(budgetRaw))) : undefined;
      const authKind = ($("#wlAuthKind", body) as HTMLSelectElement)?.value ?? "";
      const authUser = (($("#wlAuthUser", body) as HTMLInputElement)?.value ?? "").trim() || undefined;
      const authSecret = ($("#wlAuthSecret", body) as HTMLInputElement)?.value ?? "";
      const rotRaw = (($("#wlAuthRotate", body) as HTMLInputElement)?.value ?? "").trim();
      const rotationIntervalDays = rotRaw ? Math.max(0, Math.floor(Number(rotRaw))) : undefined;
      let auth: { kind: string; vaultRef: string; username?: string } | undefined;
      if (authKind) {
        let ref: string | undefined;
        if (authSecret) {
          const r = await bridge.credStore({ kind: authKind, secret: authSecret, label: (($("#wlAuthLabel", body) as HTMLInputElement)?.value ?? "").trim() || undefined, rotationIntervalDays });
          if ("error" in r) { showToast({ title: "Couldn't store secret", desc: r.error === "os-encryption-unavailable" ? "OS encryption isn't available; the secret can't be stored securely (fail-closed)." : r.error, actions: [{ label: "OK" }], timeout: 5000 }); return; }
          ref = r.ref;
        } else if (wlPendingCred && wlPendingCred.kind === authKind) {
          ref = wlPendingCred.ref;
        }
        if (!ref) { showToast({ title: "Secret needed", desc: "Paste a token / password / API key, or upload a file, for the selected auth type.", actions: [{ label: "OK" }], timeout: 4000 }); return; }
        auth = { kind: authKind, vaultRef: ref, username: authUser };
      }
      const saved = await bridge.whitelistUpsert({ kind, pattern, zone, scope, callBudget, auth });
      if (!saved) { showToast({ title: "Not added", desc: "That entry was rejected - check the pattern.", actions: [{ label: "OK" }], timeout: 4000 }); return; }
      wlPendingCred = null;
      hydrateWhitelist();
      showToast({ title: "Added to whitelist", desc: `${pattern} will auto-allow${scope === "always" ? "" : ` (${WL_SCOPE_LABEL[scope]!.toLowerCase()} scope)`}${auth ? " · credential attached" : ""}.`, meta: "under the managed ceiling · fail-closed", timeout: 4200 });
      return;
    }
    // P-KEYS.2 (ADR-0107): rotate the credential attached to a whitelist entry (paste or file), in place.
    const wlRotate = t.closest("[data-wl-rotate]") as HTMLElement | null;
    if (wlRotate) { openCredRotate(wlRotate, wlRotate.dataset.wlRotate!); return; }
    // P-NETWL.5 (ADR-0108): the two egress-posture toggles.
    if (t.closest("#wlAllowSearch")) {
      const on = ($("#wlAllowSearch", $("#setBody")!) as HTMLInputElement)?.checked ?? true;
      const r = await bridge.setWhitelistPosture({ allowWebSearch: on });
      if (r) state.posture = r;
      fillSec("whitelist", secWhitelist(state.whitelist, state.creds, state.posture));
      showToast({ title: on ? "Web search on" : "Web search off", desc: on ? "The agent can search the web with the built-in providers, no prompt." : "The agent will ask before each web search.", timeout: 2600 });
      return;
    }
    if (t.closest("#wlAllowAll")) {
      const on = ($("#wlAllowAll", $("#setBody")!) as HTMLInputElement)?.checked ?? true;
      const r = await bridge.setWhitelistPosture({ allowAll: on });
      if (r) state.posture = r;
      fillSec("whitelist", secWhitelist(state.whitelist, state.creds, state.posture));
      showToast({ title: on ? "Allow all on" : "Whitelist enforced", desc: on ? "The agent can reach any site + your LAN (it still asks for public IPs and foreign-country sites)." : "Only whitelisted sites auto-allow now - everything else asks first.", meta: "applies immediately, no restart", timeout: 3400 });
      return;
    }
    const wlRemove = t.closest("[data-wl-remove]") as HTMLElement | null;
    if (wlRemove) { await bridge.whitelistRemove(wlRemove.dataset.wlRemove!); hydrateWhitelist(); showToast({ title: "Removed", desc: "The whitelist entry was removed.", timeout: 2600 }); return; }
    // ── Personalization (ADR-0010/0012) ──
    if (t.closest("#personalToggle")) {
      const enabled = ($("#personalToggle", $("#setBody")!) as HTMLInputElement)?.checked ?? false;
      await bridge.personalEnable(enabled);
      showToast({ title: enabled ? "Personalization on" : "Personalization off", desc: enabled ? "Set a passphrase to create your encrypted store." : "Locked and disabled - nothing is learned or recalled.", actions: [{ label: "OK" }], timeout: 2800 });
      void hydratePersonal();
      return;
    }
    if (t.closest("#personalAiToggle")) {
      const on = ($("#personalAiToggle", $("#setBody")!) as HTMLInputElement)?.checked ?? false;
      await bridge.personalAiExtract(on);
      showToast({ title: on ? "Richer graph on" : "Richer graph off", desc: on ? "New turns use the model to extract semantic facts + relationships (one extra call per turn)." : "Back to offline pattern extraction (no model cost).", actions: [{ label: "OK" }], timeout: 3200 });
      return;
    }
    if (t.closest("#personalSetup") || t.closest("#personalUnlock")) {
      const setup = !!t.closest("#personalSetup");
      const pass = ($("#personalPass", $("#setBody")!) as HTMLInputElement)?.value ?? "";
      const r = setup ? await bridge.personalSetup(pass) : await bridge.personalUnlock(pass);
      if (r?.ok) showToast({ title: setup ? "Store created" : "Unlocked", desc: setup ? "Your encrypted personalization store is ready." : "Unlocked for this session.", actions: [{ label: "OK" }], timeout: 2600 });
      else showToast({ title: setup ? "Couldn't create store" : "Couldn't unlock", desc: r?.error ?? "Try again.", meta: "passphrase is never stored or sent anywhere", actions: [{ label: "OK" }], timeout: 5000 });
      void hydratePersonal();
      return;
    }
    if (t.closest("#personalLock")) {
      await bridge.personalLock();
      showToast({ title: "Locked", desc: "Both in-memory keys (main + CUI) were wiped; unlock again to use it.", actions: [{ label: "OK" }], timeout: 2400 });
      void hydratePersonal();
      return;
    }
    // ── Isolated CUI store (P9.5a): its own setup / unlock / lock ──
    if (t.closest("#cuiSetup") || t.closest("#cuiUnlock")) {
      const setup = !!t.closest("#cuiSetup");
      const pass = ($("#cuiPass", $("#setBody")!) as HTMLInputElement)?.value ?? "";
      const r = setup ? await bridge.personalCuiSetup(pass) : await bridge.personalCuiUnlock(pass);
      if (r?.ok) showToast({ title: setup ? "CUI store created" : "CUI unlocked", desc: setup ? "Your isolated, separately-keyed CUI store is ready." : "Unlocked until you switch away from CUI.", meta: "separate file + passphrase + key from your main store", actions: [{ label: "OK" }], timeout: 3000 });
      else showToast({ title: setup ? "Couldn't create CUI store" : "Couldn't unlock CUI", desc: r?.error ?? "Try again.", meta: "passphrase is never stored or sent anywhere", actions: [{ label: "OK" }], timeout: 5000 });
      void hydratePersonal();
      return;
    }
    if (t.closest("#cuiLock")) {
      await bridge.personalCuiLock();
      showToast({ title: "CUI locked", desc: "Only the CUI key was wiped; your main store stays unlocked.", actions: [{ label: "OK" }], timeout: 2400 });
      void hydratePersonal();
      return;
    }
    if (t.closest("#cuiMigrate")) {
      const r = await bridge.personalCuiMigrate();
      if (!r?.ok) showToast({ title: "Migration not done", desc: r?.error ?? "Unlock both stores first.", actions: [{ label: "OK" }], timeout: 5000 });
      else showToast({ title: r.moved ? "CUI moved into isolation" : "Nothing to move", desc: r.moved ? `${r.moved} fact(s) across ${r.entities} entit${r.entities === 1 ? "y" : "ies"} relocated into the isolated CUI store and removed from the main store.` : "No legacy CUI facts remained in the main store.", meta: "audited", actions: [{ label: "OK" }], timeout: 5000 });
      void hydratePersonal();
      return;
    }
    if (t.closest("#cuiDestroy")) {
      showToast({
        title: "Destroy CUI records?",
        desc: "This irreversibly DELETES the encrypted CUI store and wipes its key. NARA-aligned records destruction - it cannot be undone. Export a CUI archive first if you need a retained copy.",
        meta: "irreversible · audited",
        actions: [
          { label: "Cancel" },
          { label: "Destroy CUI records", kind: "danger", run: async () => {
            const r = await bridge.personalCuiDestroy();
            if (!r?.ok) showToast({ title: "Not destroyed", desc: r?.error ?? "Try again.", actions: [{ label: "OK" }], timeout: 5000 });
            else showToast({ title: r.destroyed ? "CUI records destroyed" : "Nothing to destroy", desc: r.destroyed ? `The encrypted CUI store was deleted${r.facts != null ? ` (${r.facts} fact(s))` : ""} and its key wiped.` : "There was no CUI store on disk.", actions: [{ label: "OK" }], timeout: 5000 });
            void hydratePersonal();
          } },
        ],
        timeout: 0,
      });
      return;
    }
    const pscope = t.closest("[data-pscope]") as HTMLElement | null;
    if (pscope) {
      const scope = pscope.dataset.pscope as "work" | "personal" | "cui" | "combined";
      const cur = (document.querySelector(".seg-btn.pscope.on") as HTMLElement | null)?.dataset.pscope;
      if (scope === cur) return; // already active - nothing to do
      const info = SCOPE_INFO[scope]!;
      // Switching the compartment changes what is learned + recalled - confirm with a warning.
      showToast({
        title: `Switch to ${info.label}?`,
        desc: info.note,
        meta: scope === "cui" ? "CUI handling applies once you switch." : "This changes what new facts join and what is recalled.",
        actions: [
          { label: scope === "cui" ? "Switch to CUI" : "Switch", kind: scope === "cui" ? "danger" : "ok", run: async () => { await bridge.personalScope(scope); await hydratePersonal(); } },
          { label: "Cancel" },
        ],
      });
      return;
    }
    const setcard = t.closest("[data-setcard]") as HTMLElement | null;
    if (setcard) {
      const nm = setcard.dataset.setcard!;
      const open = setcard.closest(".set-coll")?.classList.toggle("open");
      if (open) SET_OPEN.add(nm); else SET_OPEN.delete(nm);
      return;
    }
    const ragP = t.closest("#ragPersonaBtn") as HTMLElement | null;
    if (ragP) { openRagPersonaDropdown(ragP); return; }
    const ds = t.closest("[data-ds]") as HTMLElement | null;
    if (ds) {
      const name = ds.dataset.ds!;
      const cur = new Set(state.asksage?.datasets ?? []);
      cur.has(name) ? cur.delete(name) : cur.add(name);
      state.asksage = (await bridge.saveAsksage({ datasets: [...cur] })) ?? state.asksage;
      void renderSettings();
      return;
    }
    const clear = t.closest("[data-clearkey]") as HTMLElement | null;
    if (clear) { await bridge.saveKey(clear.dataset.clearkey!, ""); void renderSettings(); return; }
    const oauth = t.closest("[data-oauth]") as HTMLElement | null;
    if (oauth) {
      const oauthId = oauth.dataset.oauth!;
      const r = await bridge.oauthLogin(oauthId);
      if (r?.url) window.open(r.url, "_blank");
      // Device-flow providers (xAI, GitHub, etc.) show a code on the provider's page
      // that the user must paste back. Redirect-flow providers (OpenAI, Anthropic, Google)
      // complete silently via the localhost callback.
      const DEVICE_FLOW_IDS = new Set(["xai-oauth", "github-copilot", "openai-codex-device"]);
      if (DEVICE_FLOW_IDS.has(oauthId)) {
        showToast({
          title: "Paste the code from the sign-in page",
          desc: "Copy the code shown in your browser, paste it below, and click Submit.",
          actions: [{ label: "OK" }],
          timeout: 0, // persistent until dismissed
        });
        // Inject a device-code input into the provider card itself
        const card = oauth.closest(".set-card") as HTMLElement | null;
        if (card) {
          let box = card.querySelector(".oauth-device-box") as HTMLElement | null;
          if (!box) {
            box = el(`<div class="oauth-device-box prov-row" style="margin-top:8px">
              <input class="prov-key" id="deviceCode_${oauthId}" type="text" placeholder="Paste device code here…" autocomplete="off" style="font-family:var(--mono)" />
              <button class="btn-mini ok" id="deviceSubmit_${oauthId}">${icon("check", 12)} Submit</button></div>`);
            card.appendChild(box);
            const submit = $(`#deviceSubmit_${oauthId}`, card)!;
            submit.addEventListener("click", async () => {
              const inp = $(`#deviceCode_${oauthId}`, card) as HTMLInputElement;
              const code = inp?.value.trim();
              if (!code) return;
              const sr = await bridge.oauthCode(oauthId, code);
              if (sr?.sent) {
                showToast({ title: "Code sent", desc: "Waiting for the provider to verify…", timeout: 4000 });
                box?.remove();
              } else {
                showToast({ tone: "danger", title: "Couldn't send code", desc: sr?.reason ?? "The broker may have exited. Try again.", actions: [{ label: "OK" }], timeout: 6000 });
              }
            });
          }
          ($(`#deviceCode_${oauthId}`, card) as HTMLInputElement)?.focus();
        }
      } else {
        showToast({ title: "OAuth started", desc: r?.url ? "Complete the sign-in in your browser, then return - the model list updates automatically." : (r?.output?.slice(0, 160) || "Follow omp's prompt in the GUI server window."), actions: [{ label: "OK" }], timeout: 6000 });
      }
      setTimeout(() => void renderSettings(), 4000);
      void pollOauthThenRefresh(oauthId); // watch for completion, then refresh models
      return;
    }
    const logout = t.closest("[data-oauth-logout]") as HTMLElement | null;
    if (logout) { await bridge.oauthLogout(logout.dataset.oauthLogout!); void renderSettings(); return; }
    if (t.closest("#saveUsername")) {
      const u = (($("#setUsername") as HTMLInputElement)?.value ?? "").trim();
      const em = (($("#setEmail") as HTMLInputElement)?.value ?? "").trim();
      if (em && !isValidEmail(em)) { showToast({ title: "Check the email", desc: "That doesn't look like a valid email address.", actions: [{ label: "OK" }], timeout: 3000 }); return; }
      const r = await bridge.saveProfile({ username: u, email: em });
      state.username = u; state.email = em; if (r?.attribution) state.attribution = r.attribution;
      if (state.settingsOpen) fillSec("profile", secProfile({ username: u, email: em, attribution: state.attribution ?? undefined }));
      $$(".msg.user .who").forEach((w) => { w.textContent = u || "You"; }); // relabel existing turns
      showToast({ title: "Saved", desc: `Hi${u ? ", " + u : " there"}.${state.attribution ? " Attributed to " + state.attribution.identity + "." : ""}`, actions: [{ label: "OK" }], timeout: 2400 });
    }
  });

  // inspector tabs
  $$(".insp-tab").forEach((t) => t.addEventListener("click", () => focusInspector((t as HTMLElement).dataset.insp as Tab)));

  // accordion toggles (delegated; flips OPEN + .open without a full re-render)
  $("#inspBody")!.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("[data-budget-refresh]")) { void refreshBudget(true); return; }
    // P10.3: flip the live API-key rate-limit probe opt-in, then re-poll.
    if ((e.target as HTMLElement).closest("#ratelimitToggle")) {
      const on = ($("#ratelimitToggle") as HTMLInputElement)?.checked ?? false;
      void (async () => {
        await bridge.setRateLimitProbe(on);
        state.probeEnabled = on;
        showToast({ title: on ? "Live probe on" : "Live probe off", desc: on ? "Reading API-key rate-limit headers every 5 min (one tiny request per keyed provider)." : "Stopped probing provider rate-limit headers.", actions: [{ label: "OK" }], timeout: 3000 });
        await refreshBudget(true);
      })();
      return;
    }
    const dnsAdd = (e.target as HTMLElement).closest("[data-dns-add]") as HTMLElement | null;
    if (dnsAdd) { openWhitelistQuickAdd(dnsAdd, dnsAdd.dataset.dnsAdd!); return; } // P-NETWL.4
    const head = (e.target as HTMLElement).closest("[data-acc-toggle]") as HTMLElement | null;
    if (head) { const k = head.dataset.accToggle!; const acc = head.closest(".acc")!; const open = acc.classList.toggle("open"); open ? OPEN.add(k) : OPEN.delete(k); return; }
    // Approve & retry: the audited fail-closed override for one live gate block (ADR-0019 C).
    const approve = (e.target as HTMLElement).closest("[data-approve]") as HTMLElement | null;
    if (approve) {
      const id = approve.dataset.approve!;
      (approve as HTMLButtonElement).disabled = true;
      void (async () => {
        const r = await bridge.securityApprove(id);
        if (!r) { showToast({ title: "Already handled", desc: "That block was already released.", actions: [{ label: "OK" }], timeout: 3000 }); return; }
        await refresh(); // drop it from the live-block list + counts + badge
        const retry = state.lastPrompt.trim();
        showToast({
          title: "Released · audited",
          desc: retry ? "Re-sending your last message so the agent can try again." : "Block released and recorded in the audit log.",
          meta: `tool=${r.tool} · approved`,
          actions: [{ label: "OK" }], timeout: 4500,
        });
        if (retry && !state.streaming) { const ta = $("#input") as HTMLTextAreaElement; ta.value = retry; void send(); }
      })();
      return;
    }
    // Dismiss: acknowledge a reviewed block - moves it to the Dismissed section WITHOUT releasing it
    // (the call stays blocked, the audit record is kept). Clears it from the active "quarantined" count.
    const dismiss = (e.target as HTMLElement).closest("[data-dismiss]") as HTMLElement | null;
    if (dismiss) {
      const id = dismiss.dataset.dismiss!;
      (dismiss as HTMLButtonElement).disabled = true;
      void (async () => {
        const r = await bridge.securityDismiss(id);
        if (!r) { showToast({ title: "Already handled", desc: "That block was already released or dismissed.", actions: [{ label: "OK" }], timeout: 3000 }); return; }
        await refresh(); // drop it from the active list + counts, into the Dismissed section
        showToast({
          title: "Dismissed · still blocked",
          desc: "Moved to the Dismissed section. The call stays blocked; the audit record is kept.",
          meta: `tool=${r.tool} · dismissed`,
          actions: [{ label: "OK" }], timeout: 4000,
        });
      })();
      return;
    }
    // P-SECACK.1 (ADR-0170): "Reviewed" on a DB-backed row - records the ack in the GUI ledger and
    // drops the row from the active view/counters. Nothing is released; every audit record is kept.
    // (Replaces the old Approve/Deny buttons here, which only ever showed a toast - the GUI cannot
    // write the READ_ONLY provenance DB, so that queue never drained.)
    const ack = (e.target as HTMLElement).closest("[data-ack]") as HTMLElement | null;
    if (ack) {
      (ack as HTMLButtonElement).disabled = true;
      void (async () => {
        await bridge.securityAck({ ids: [ack.dataset.ack!] });
        await refresh();
        showToast({ title: "Marked reviewed", desc: "Removed from the active queue. The artifact stays isolated; audit records are kept.", timeout: 2600 });
      })();
      return;
    }
    const ackAll = (e.target as HTMLElement).closest("[data-ack-all]") as HTMLElement | null;
    if (ackAll) {
      const sec = state.security;
      const rows = ackAll.dataset.ackAll === "approvals" ? sec?.approvals ?? [] : sec?.quarantine ?? [];
      const ids = splitReviewed(rows, sec?.acks?.artifacts ?? {}).active.map((r) => String(r.artifact_id ?? "")).filter(Boolean);
      if (!ids.length) return;
      (ackAll as HTMLButtonElement).disabled = true;
      void (async () => {
        await bridge.securityAck({ ids });
        await refresh();
        showToast({ title: `${ids.length} marked reviewed`, desc: "Cleared from the active queue. Everything stays isolated and audited.", timeout: 2600 });
      })();
      return;
    }
    const ackF = (e.target as HTMLElement).closest("[data-ack-findings]") as HTMLElement | null;
    if (ackF) {
      (ackF as HTMLButtonElement).disabled = true;
      void (async () => {
        await bridge.securityAck({ findings: true });
        await refresh();
        showToast({ title: "Findings marked seen", desc: "The chip now counts only new findings. History stays in the table.", timeout: 2600 });
      })();
      return;
    }
  });

  // composer
  const ta = $("#input") as HTMLTextAreaElement;
  ta.addEventListener("input", () => { autosize(ta); setSendEnabled(); updateSlashAC(); });
  ta.addEventListener("keydown", (e) => {
    if (slashKeydown(e)) return; // the "/" autocomplete consumed it (nav / Tab / Enter / Esc)
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  ta.addEventListener("blur", () => window.setTimeout(closeSlashAC, 120)); // dismiss when focus leaves (after a click lands)
  // P-VISION.1 (ADR-0136): paste a snipping-tool / desktop screenshot straight into the prompt bar. Image
  // clipboard items are staged as thumbnails (NOT auto-sent); text paste passes through untouched.
  ta.addEventListener("paste", (e) => {
    const items = (e as ClipboardEvent).clipboardData?.items;
    const files: File[] = [];
    for (const it of Array.from(items ?? [])) if (it.kind === "file" && it.type.startsWith("image/")) { const f = it.getAsFile(); if (f) files.push(f); }
    if (files.length && stageImageFiles(files)) e.preventDefault(); // consumed as images; don't also paste junk text
  });
  // P-SECACK.1 (ADR-0170): right-click Cut/Copy/Paste/Select-all on the prompt bar and every other
  // text field - Electron ships no native context menu, so mouse-only clipboard flows were impossible.
  // Image paste goes through the SAME staged-thumbnail path as Ctrl+V (P-VISION.1).
  installTextContextMenu({
    onImages: (imgs) => stageImageFiles(imgs),
    toast: (t) => showToast({ title: t.title, desc: t.desc, tone: t.tone, actions: [{ label: "OK" }], timeout: 3200 }),
  });
  // Drag-and-drop image files onto the composer.
  const cw = $(".composer-wrap") as HTMLElement | null;
  cw?.addEventListener("dragover", (e) => { if ((e as DragEvent).dataTransfer?.types?.includes("Files")) { e.preventDefault(); cw.classList.add("drag"); } });
  cw?.addEventListener("dragleave", (e) => { if (e.target === cw) cw.classList.remove("drag"); });
  cw?.addEventListener("drop", (e) => {
    cw.classList.remove("drag");
    const files = (e as DragEvent).dataTransfer?.files;
    if (files?.length && stageImageFiles(files)) e.preventDefault();
  });
  // Remove a staged thumbnail.
  $("#composerThumbs")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-att-remove]") as HTMLElement | null;
    if (!btn) return;
    const id = btn.dataset.attRemove;
    state.attachments = state.attachments.filter((a) => a.id !== id);
    renderComposerThumbs();
    ($("#input") as HTMLTextAreaElement)?.focus();
  });
  // P-ACP.4: while a turn runs the Send button is a Stop control (interrupt the turn); else it sends.
  $("#send")!.addEventListener("click", () => { if (state.streaming) void stopTurn(); else void send(); });

  // Jump-to-latest: show the catch-up arrow on user scroll / resize; click pages down one screen.
  $("#chat")?.addEventListener("scroll", scheduleJump, { passive: true });
  window.addEventListener("resize", scheduleJump, { passive: true });
  $("#jumpDown")?.addEventListener("click", jumpDownOnePage);

  // P-IDE.4: "View in IDE" on chat code blocks → open the read-only Monaco panel (delegated, one
  // listener for all current + future blocks). Exclusivity: opening the IDE closes Settings + KG.
  setIdeExclusivity(() => { closeSettings(); closeKnowledge(); closeAgentBuilder(); });
  // P-IDE.5: the IDE drops edited code into the chat composer ("Send to chat"), and resolves a
  // Save-As destination (folder pick → filename prompt) for snippets with no bound path.
  setIdeHooks({
    sendToChat: (text) => {
      const ta = $("#input") as HTMLTextAreaElement;
      ta.value = (ta.value ? ta.value.replace(/\s*$/, "") + "\n" : "") + text.trimStart();
      autosize(ta); setSendEnabled(); ta.focus();
      showToast({ title: "Added to the composer", desc: "Review it and press send when ready.", timeout: 2500 });
    },
    pickSavePath: async (suggested) => {
      const dir = await openFolderBrowser({ title: "Choose a folder to save into", confirm: "Save here" });
      if (!dir) return null;
      const name = await promptText({ title: "Save as", label: "File name", value: suggested, placeholder: "filename.ext" });
      if (!name) return null;
      return `${dir.replace(/[\\/]+$/, "")}/${name.trim().replace(/^[\\/]+/, "")}`;
    },
  });
  $("#thread")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".code-ide-btn") as HTMLElement | null;
    if (!btn) return;
    const code = btn.closest("pre")?.querySelector("code");
    const text = code?.textContent ?? "";
    if (text.trim()) void openIde({ title: btn.dataset.lang ? `Snippet · ${btn.dataset.lang}` : "Snippet", code: text, language: btn.dataset.lang });
  });

  // sidebar collapse (rail toggle + header collapse), mirroring the right panel
  $("#sideToggle")!.addEventListener("click", () => toggleSidebar());
  $("#sideCollapse")!.addEventListener("click", () => toggleSidebar(true));
  $("#wsBar")!.addEventListener("click", () => openSettings());
  $("#sessList")!.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-ingest-clear]")) { e.stopPropagation(); confirmClearIngest(); return; } // P-KG-INGEST.2
    if (t.closest("[data-ingest-toggle]")) { ingestExpanded = !ingestExpanded; void renderSessions(); return; } // P-KG-INGEST.1b
    const del = t.closest(".sess-del") as HTMLElement | null;
    if (del?.dataset.del) { e.stopPropagation(); confirmDeleteSession(del.dataset.del); return; }
    const s = t.closest(".sess") as HTMLElement | null;
    if (s?.dataset.sid) void resumeSession(s.dataset.sid);
  });
  $(".brand")!.addEventListener("click", () => toggleSidebar());

  // status bar: click the budget / gov chips to re-check usage now
  $("#statusbar")!.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-asksage-refresh]")) { void refreshAsksage(); return; }
    if (t.closest("[data-budget-refresh]")) void refreshBudget(true);
  });
  $("#newSession")!.addEventListener("click", () => newSession());
  const w = (window as any).lucid?.win;
  $("#winMin")!.addEventListener("click", () => w?.minimize?.());
  $("#winMax")!.addEventListener("click", () => w?.toggleMaximize?.());
  $("#winClose")!.addEventListener("click", () => w?.close?.());
}

// ───────────────────────── palette actions ─────────────────────────
function newSession(): void {
  seedThread(); state.liveUsage = null;
  void bridge.newSession(); renderStatus(); $("#input")?.focus();
}
/** Drop an omp slash command into the composer (omp runs it on send via ACP). */
function runCommand(c: OmpCommand): void {
  const ta = $("#input") as HTMLTextAreaElement;
  ta.value = `/${c.name} `; autosize(ta); setSendEnabled(); ta.focus();
  showToast({ title: `/${c.name}`, desc: `${c.description ?? "omp command"} - press Enter to run${c.hint ? ` (args: ${c.hint})` : ""}.`, actions: [{ label: "OK" }], timeout: 3400 });
}

const palette = createPalette(() => {
  const acts: Action[] = [
    { id: "cfg", title: "Choose model · mode · thinking…", icon: "spark", hint: "config", run: () => openConfigPopover($("#modelBadge")!) },
    { id: "sec", title: "Open Security panel", icon: "shield", hint: "panel", run: () => focusInspector("security") },
    { id: "mem", title: "Open Memory & context panel", icon: "savings", hint: "panel", run: () => focusInspector("memory") },
    { id: "mkt", title: "Open Plugin Marketplace", icon: "market", hint: "popup", run: () => openMarketplace() }, // P-MARKET.1
    { id: "sysres", title: "Open System resources", icon: "gauge", hint: "popup", run: () => void openResourcePanelLive() }, // P-SYSRES.1
    // P-LOC.3 (ADR-0095): a discoverable entry point for the AI-authored code ledger — opens Memory with
    // the section expanded, so it no longer has to be hunted for inside the panel.
    { id: "ailoc", title: "Open AI-authored code ledger", icon: "savings", hint: "panel", run: () => { OPEN.add("mem.ailoc"); focusInspector("memory"); } },
    { id: "zin", title: "Zoom in", icon: "plus", hint: modSymbol("+"), run: () => nudgeZoom(0.1) },
    { id: "zout", title: "Zoom out", icon: "minus", hint: modSymbol("−"), run: () => nudgeZoom(-0.1) },
    { id: "zreset", title: "Reset text zoom to 100%", icon: "refresh", hint: modSymbol("0"), run: () => resetZoom() },
    { id: "new", title: "New session", icon: "plus", run: () => newSession() },
    { id: "side", title: "Toggle sidebar", icon: "layout", run: () => toggleSidebar() },
    { id: "insp", title: "Collapse / expand inspector (metrics rail)", icon: "collapse", run: () => setInspectorRail(!state.inspectorRail) },
    { id: "refresh", title: "Refresh dashboards now", icon: "refresh", run: () => refresh() },
  ];
  const model = state.config.find((c) => c.id === "model");
  if (model) for (const o of model.options.slice(0, 10)) acts.push({ id: "m:" + o.value, title: `Model: ${o.name}`, icon: "spark", hint: o.value === model.currentValue ? "current" : "", run: () => applyConfig("model", o.value) });
  for (const c of state.commands) acts.push({ id: "cmd:" + c.name, title: `/${c.name}${c.hint ? " " + c.hint : ""}`, icon: "command", hint: (c.description ?? "omp").slice(0, 26), run: () => runCommand(c) });
  // P-IDE.2: bundled skills + /task proforma, then project (omp-native) skills.
  acts.push({ id: "task", title: "/task - delegate to subagents", icon: "bolt", hint: "proforma", run: () => insertTaskProforma() });
  for (const s of INSTALLED_SKILLS) acts.push({ id: "bskill:" + s.command, title: `Skill: ${s.name}`, icon: "bolt", hint: s.command === state.activeSkill?.command ? "active" : s.description.slice(0, 24), run: () => void activateBundledSkill(s.command) });
  for (const s of state.skills) acts.push({ id: "skill:" + s.name, title: `Project skill: ${s.name}`, icon: "bolt", hint: (s.description ?? "").slice(0, 26), run: () => useSkill(s.name) });
  return acts;
});

// ───────────────────────── session config (model / mode / thinking) ─────────────────────────
// P-IDE.1d: cold-boot model-list cache. omp's ACP session takes a few seconds to spawn, leaving the
// picker blank. We persist the last config locally and paint it instantly on boot; the live config then
// replaces it (dropping models for any revoked key/OAuth, adding new ones). A spinner shows while the
// live refresh is pending. Cache key is per-workspace so switching repos doesn't show the wrong models.
const CONFIG_CACHE_KEY = "lucid.config-cache.v1";
function cacheConfig(): void {
  try { if (state.config.length) localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(state.config)); } catch { /* ignore */ }
}
/** Seed state.config from the local cache so the picker is instant on cold boot (marked stale). */
function loadCachedConfig(): void {
  try {
    if (state.config.length) return; // live already loaded
    const raw = localStorage.getItem(CONFIG_CACHE_KEY);
    if (!raw) return;
    const cached = JSON.parse(raw) as ConfigOption[];
    if (Array.isArray(cached) && cached.length) {
      state.config = cached;
      state.configCached = true;
      const model = cached.find((c) => c.id === "model");
      if (model) { state.model = model.currentValue; const mn = $("#modelName"); if (mn) mn.textContent = modelLabel(model.currentValue); }
    }
  } catch { /* ignore */ }
}
async function loadConfig(): Promise<void> {
  try {
    const live = await bridge.config();
    state.commands = await bridge.commands();
    state.userCommands = (await bridge.userCommands()) ?? []; // P-CMD.1: workspace-local user "/" commands
    state.chinaAck = !!(await bridge.chinaAck())?.acknowledged; // P-IDE.1c: gate China-origin models
    state.thirdPartyAck = !!(await bridge.thirdPartyAck())?.acknowledged; // gate the "More providers" list
    state.managed = await bridge.managed(); // ADR-0068 (P-ENT.1): enterprise lock view for the UI
    // P-IDE.1d: only adopt the live config when omp actually returned one. A cold/not-ready omp returns
    // an empty list - keep the cached list visible (spinner stays) rather than blanking the picker. When
    // omp IS ready, the live config replaces the cache (so a revoked key/OAuth's models drop out).
    const liveModel = live?.find((c) => c.id === "model");
    if (live && live.length && liveModel && liveModel.options.length) {
      state.config = live;
      state.configCached = false;
      cacheConfig();
    }
    const model = state.config.find((c) => c.id === "model");
    if (model) { state.model = model.currentValue; const mn = $("#modelName"); if (mn) mn.textContent = modelLabel(model.currentValue); }
    updateComposerTools();
    void syncMode();
    pickerRedraw?.(); // if a picker is open on the cached list, refresh it with the live one
  } catch { /* browser/no-session: keep defaults (cached list, if any, stays) */ }
}

/** P-ACP.2: pull the TRUE active ACP mode from the backend into the mode control. omp may change
 *  the mode itself (e.g. Plan auto-exits to default after it drafts a plan), so we re-sync on load
 *  and after each turn rather than trusting the last click. */
async function syncMode(): Promise<void> {
  const m = await bridge.modes();
  if (!m) return;
  if (m.ui) state.uiMode = m.ui;
  updateComposerTools();
}

/** Force omp to re-read its credential vault and refresh the model list (manual "Refresh models"
 *  button). Restarts the omp child, so it also picks up a provider connected since launch. */
async function refreshModels(): Promise<void> {
  // #11 perceived-latency: refreshConfig() triggers an omp respawn (2–5s) during which the
  // model badge would otherwise sit stale with no signal. Show an inline "Refreshing
  // models…" spinner on the badge + a reassuring toast, and ALWAYS restore the real label
  // afterwards (success or failure) so it can never get stuck spinning.
  const mn = $("#modelName");
  const badge = $("#modelBadge");
  const prevName = mn?.textContent ?? "";
  if (mn) mn.textContent = "Refreshing models…";
  badge?.classList.add("busy");
  showToast({ title: "Refreshing models…", desc: "Restarting omp to re-read your providers. Your next turn will pick up the new list.", timeout: 4000 });
  try {
    state.config = await bridge.refreshConfig();
    const model = state.config.find((c) => c.id === "model");
    if (model) { state.model = model.currentValue; if (mn) mn.textContent = modelLabel(model.currentValue); }
    else if (mn) mn.textContent = prevName;
    updateComposerTools();
  } catch {
    if (mn) mn.textContent = prevName; // keep current on failure
  } finally {
    badge?.classList.remove("busy"); // never leave the badge stuck in a busy state
  }
}

/** After an OAuth login is kicked off, watch the provider's status until it flips to connected
 *  (the user finishes in the browser/OTP), then refresh the model list. The server already
 *  respawned omp when the broker exited, so a plain loadConfig() surfaces the new models. */
async function pollOauthThenRefresh(oauthId: string): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let resolved = false;
  const check = async (): Promise<boolean> => {
    if (resolved) return true;
    const a = await bridge.auth();
    const prov = [...(a?.gateway ?? []), ...(a?.majors ?? []), ...(a?.others ?? [])].find((x) => x.oauthId === oauthId);
    if (prov?.oauthActive) {
      resolved = true;
      await loadConfig();
      if (state.settingsOpen) renderSettings();
      showToast({ title: "Connected - models updated", desc: `${prov.name} is ready in the model picker.`, actions: [{ label: "OK" }], timeout: 6000 });
      return true;
    }
    return false;
  };
  // When the user returns from the provider's login page (tab switch), re-check immediately.
  // Chrome throttles setTimeout in background tabs; this fires the instant LUCID is visible again.
  const onVisible = () => { if (document.visibilityState === "visible") void check(); };
  document.addEventListener("visibilitychange", onVisible);
  try {
    for (let i = 0; i < 150; i++) { // ~5 min @ 2s
      await sleep(2000);
      if (await check()) return;
    }
  } finally { document.removeEventListener("visibilitychange", onVisible); }
}

async function applyConfig(configId: string, value: string): Promise<void> {
  // P-ACP.2/3: the mode control is the client 3-way Plan/Ask/Agent; it sets omp's session mode +
  // the permission posture in one call, not an omp config option.
  if (configId === "mode") {
    const ui = (value === "ask" || value === "plan" ? value : "agent") as "agent" | "ask" | "plan";
    state.uiMode = ui; // optimistic
    try { const m = await bridge.setUiMode(ui); if (m?.ui) state.uiMode = m.ui; } catch { /* keep optimistic */ }
    updateComposerTools();
    showToast({ title: `Mode → ${MODE_UI_OPTS.find((o) => o.value === state.uiMode)?.name ?? state.uiMode}`, desc: MODE_DESC[state.uiMode] ?? "Applied to the active session.", actions: [{ label: "OK" }], timeout: 2400 });
    return;
  }
  const opt = state.config.find((c) => c.id === configId);
  const label = opt?.options.find((o) => o.value === value)?.name ?? value;
  // P-PERF.5 (ADR-0132): OPTIMISTIC - paint the switch NOW; the omp round-trip reconciles in the
  // background. A busy backend used to hold the badge + status hostage for the whole request (the
  // "model switching feels stuck" complaint). Failure keeps the optimistic value (as before) but is
  // no longer silent - a warn toast says the backend didn't confirm.
  if (opt) opt.currentValue = value;
  if (configId === "model") { state.model = value; const mn = $("#modelName"); if (mn) mn.textContent = modelLabel(value); renderStatus(); }
  updateComposerTools();
  void bridge.setConfig(configId, value)
    .then((cfg) => {
      state.config = cfg;
      const o = state.config.find((c) => c.id === configId); if (o) o.currentValue = value;
      updateComposerTools();
    })
    .catch(() => showToast({ title: `Couldn't confirm ${opt?.name ?? configId}`, desc: "The backend didn't acknowledge the change - it may not have applied. Try again if new turns don't use it.", tone: "warn", actions: [{ label: "OK" }], timeout: 4200 }));
  // P-IDE.1e (ADR-0109): selecting Fable 5 raises a persistent privacy notice (no absolute privacy from the
  // U.S. government) instead of the routine "applied" toast.
  if (configId === "model" && shortModelId(value) === FABLE_ID) {
    showToast({ title: "Fable 5 selected - privacy notice", desc: `${FABLE_PRIVACY_WARN} New turns use Fable 5; you can switch models anytime.`, tone: "danger", actions: [{ label: "I understand" }], timeout: 0 });
    return;
  }
  showToast({ title: `${opt?.name ?? configId} → ${label}`, desc: configId === "model" ? "New turns use this model." : "Applied to the active session.", actions: [{ label: "OK" }], timeout: 2400 });
}

const isAsksage = (v: string) => /asksage/i.test(v);
// Models present in the catalog but NOT currently selectable. Keyed by short id; the value is the
// reason shown (greyed row + hover banner). (ADR-0029 P-IDE.1b/1d)
const ITAR_REASON = "Currently unavailable - restricted under U.S. ITAR export controls until the government clears it for use (expected soon).";
const UNAVAILABLE: Record<string, string> = {
  "claude-mythos-5": ITAR_REASON, // Mythos 5 stays ITAR-gated until cleared.
};
// P-IDE.1e (ADR-0109): Fable 5 is enabled, but ONLY when a Claude account is connected (it routes through
// Anthropic), and it carries a U.S.-government privacy notice.
const FABLE_ID = "claude-fable-5";
const FABLE_NEEDS_AUTH = "Connect a Claude account to enable Fable 5 - sign in with Claude OAuth or add an ANTHROPIC_API_KEY in Providers.";
const FABLE_PRIVACY_WARN = "Chat history for this model has NO expectation of absolute privacy from the U.S. government.";
/** Is a Claude (Anthropic) OAuth session or API key connected? Gates Fable 5. */
function claudeAuthed(): boolean {
  const m = (state.auth?.majors ?? []).find((x) => x.id === "anthropic");
  return !!m && (!!m.oauthActive || !!m.keySet);
}
/** Why a model is non-selectable, or undefined if it's available. Fable 5 needs a connected Claude account. */
function unavailableReason(value: string): string | undefined {
  const short = shortModelId(value);
  if (short === FABLE_ID) return claudeAuthed() ? undefined : FABLE_NEEDS_AUTH;
  return UNAVAILABLE[short];
}
// Advisory shown on gov-gateway (AskSage) models until they're cleared for production use.
const GOV_ADVISORY = "Government (AskSage) model - restricted to internal prototype use only until cleared for production by the U.S. government.";
// 5-star rating renderer (filled + dimmed). `cls` colors the filled stars.
const stars5 = (n: number, cls: string) => `<span class="mt-stars ${cls}">${"★".repeat(n)}<span class="mt-dim">${"☆".repeat(5 - n)}</span></span>`;

// One row in a model dropdown: clean name (priority) · a Gov pill for gateway models ·
// the green Intelligence-Level stars. Shared so both pickers render identically. data-model
// drives the premium hover card (Token Expense + Intelligence + best-use + id).
// P-IDE.1c: the user has the SAME model via multiple providers (e.g. Claude via Anthropic AND Google
// Antigravity). omp's display name doesn't distinguish them, so identical rows look like duplicates.
// We disambiguate ONLY the colliding ones with a small provider tag, keyed by the VISIBLE name (so any
// rows that look the same get tagged, regardless of id structure). Set per-render before mapping rows.
let collidingNames = new Set<string>();
// P-IDE.1d: when a model picker is open, this redraws its list in place (used to refresh from the
// cached list to the live one when the cold-boot config arrives). Null when no picker is open.
let pickerRedraw: (() => void) | null = null;
function providerLabel(v: string): string {
  if (/^anthropic\//.test(v)) return "Anthropic";
  if (/google-antigravity\//.test(v)) return "Antigravity";
  if (/google-gemini-cli\//.test(v)) return "Gemini CLI";
  if (/openai-codex\//.test(v)) return "Codex";
  const m = /^([^/]+)\//.exec(v);
  return m ? m[1]!.replace(/^asksage-/, "") : "";
}
const modelRow = (o: { value: string; name: string }, sel: string) => {
  // Provider tag only on NON-gov colliding rows - the Gov pill already distinguishes gov routes.
  const prov = (!isAsksage(o.value) && collidingNames.has(cleanModelName(o.name))) ? `<span class="row-prov" data-tip="Provider route">${esc(providerLabel(o.value))}</span>` : "";
  // P-IDE.1b: an unavailable model (e.g. ITAR-blocked Fable) renders greyed + non-selectable - NO
  // data-val, so the picker's click handler skips it; data-model stays so the hover card explains why.
  const reason = unavailableReason(o.value);
  if (reason) {
    return `<div class="cfg-opt unavail" data-model="${esc(o.value)}" aria-disabled="true"><span class="tick"></span><span class="nm">${esc(cleanModelName(o.name))}</span>${prov}<span class="unavail-tag">Currently Unavailable</span></div>`;
  }
  // P-IDE.1d: resolveModelInfo gives every row consistent stars + context (curated or inferred).
  const info = resolveModelInfo(o.value);
  const iq = `<span class="row-iq" aria-label="Intelligence ${info.iq} of 5">${"★".repeat(info.iq)}<span class="row-iq-dim">${"☆".repeat(5 - info.iq)}</span></span>`;
  const ctxLbl = info.ctx ?? "";
  const ctx = ctxLbl ? `<span class="row-ctx" data-tip="Context window">${esc(ctxLbl)}</span>` : "";
  // P-IDE.1e (ADR-0109): a small privacy marker on the Fable 5 row (the hover card + selection toast carry the full notice).
  const warnPill = shortModelId(o.value) === FABLE_ID ? `<span class="row-warn" data-tip="U.S.-gov privacy notice|${esc(FABLE_PRIVACY_WARN)}">${icon("shield", 10)}</span>` : "";
  // P-FAV.1: the star toggles membership in the pinned Favorites section; it must never SELECT the
  // row, so the click handlers check [data-fav] before [data-val].
  const fav = favSet.has(o.value);
  const star = `<button class="fav-star${fav ? " on" : ""}" type="button" data-fav="${esc(o.value)}" data-tip="${fav ? "Unstar|Remove from Favorites" : "Star|Pin to a Favorites section at the top of the picker"}">${icon("star", 12)}</button>`;
  return `<div class="cfg-opt ${o.value === sel ? "on" : ""}" data-val="${esc(o.value)}" data-model="${esc(o.value)}"><span class="tick">${icon("check", 13)}</span><span class="nm">${esc(cleanModelName(o.name))}</span>${prov}${warnPill}${isAsksage(o.value) ? `<span class="gov-pill">Gov</span>` : ""}${ctx}${iq}${star}</div>`;
};

// ── P-IDE.1 (ADR-0029): model family grouping ────────────────────────────────
// Classification + grouping is the pure, unit-tested `model_families.ts`; here we add the
// collapsible-section UI (persisted collapse state + the per-model hover card / click are unchanged).
const FAM_COLLAPSE_KEY = "lucid.model-fam-collapsed";
function collapsedFamilies(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FAM_COLLAPSE_KEY) || "[]") as string[]); } catch { return new Set(); }
}
function toggleFamilyCollapsed(id: string): void {
  const s = collapsedFamilies();
  if (s.has(id)) s.delete(id); else s.add(id);
  try { localStorage.setItem(FAM_COLLAPSE_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
}
// P-FAV.1 (ADR-0165): favorite stars. Same persistence tier as the collapse state above; the pure
// parse/toggle/selection layer is model_favorites.ts. `favSet` is refreshed by familyListHTML each
// render so modelRow (shared by both pickers) can paint the star without threading a param through.
let favSet = new Set<string>();
function favsOf(): string[] { return parseFavs(localStorage.getItem(FAVS_KEY)); }
function saveFavs(favs: string[]): void {
  try { localStorage.setItem(FAVS_KEY, JSON.stringify(favs)); } catch { /* ignore */ }
}
/** Render the model list as collapsible family sections. `q` filters across ALL families (empty/
 *  no-match families are omitted); while searching, every shown family is force-expanded. When the
 *  gov gateway is configured, families are reordered GPT/Gemini-first (ASKSAGE_FAMILY_ORDER). A
 *  collapsed family still renders its rows (hidden via CSS) so the persisted state round-trips.
 *  Collapse is fully user-driven - even the family holding the current selection can be collapsed. */
function familyListHTML(models: { value: string; name: string }[], sel: string, q = ""): string {
  const filtered = filterModels(models, q);
  if (filtered.length === 0) return `<div class="cfg-empty">No models match “${esc(q)}”</div>`;
  // P-IDE.1c: flag display names that appear more than once, so those rows show a provider tag.
  const counts = new Map<string, number>();
  for (const o of filtered) { const n = cleanModelName(o.name); counts.set(n, (counts.get(n) ?? 0) + 1); }
  collidingNames = new Set([...counts].filter(([, n]) => n > 1).map(([s]) => s));
  const searching = q.trim().length > 0;
  const collapsed = collapsedFamilies();
  const order = state.asksage?.configured ? ASKSAGE_FAMILY_ORDER : undefined;
  // P-FAV.1: pinned Favorites pseudo-section. Starred models render here AND in their family (family
  // muscle memory preserved); it collapses/persists via the same data-fam-toggle mechanism ("favs").
  const favs = favsOf();
  favSet = new Set(favs);
  const starred = starredOf(filtered, favs);
  const favSec = starred.length === 0 ? "" : `<div class="cfg-fam cfg-fam-favs${!searching && collapsed.has("favs") ? " collapsed" : ""}" data-fam="favs">
      <button class="cfg-fam-h" type="button" data-fam-toggle="favs"><span class="cfg-fam-name">${icon("star", 12, "fam-star")} Favorites</span><span class="cfg-fam-n">${starred.length}</span>${icon("chevron", 13, "cfg-fam-chev")}</button>
      <div class="cfg-fam-list">${starred.map((o) => modelRow(o, sel)).join("")}</div>
    </div>`;
  return favSec + groupByFamily(filtered, order).map(({ fam, models: ms }) => {
    const isCollapsed = !searching && collapsed.has(fam.id);
    return `<div class="cfg-fam${isCollapsed ? " collapsed" : ""}" data-fam="${fam.id}">
      <button class="cfg-fam-h" type="button" data-fam-toggle="${fam.id}"><span class="cfg-fam-name">${esc(fam.label)}</span><span class="cfg-fam-n">${ms.length}</span>${icon("chevron", 13, "cfg-fam-chev")}</button>
      <div class="cfg-fam-list">${ms.map((o) => modelRow(o, sel)).join("")}</div>
    </div>`;
  }).join("");
}

// Premium per-model hover card metadata. Two ratings (editorial guidance, NOT a benchmark):
//   exp = Token Expense  (1–5, red)   - how token/cost-heavy the model is (5 = priciest)
//   iq  = Intelligence Level (1–5, green) - raw capability
// plus a one-line description, a practical "best for", and context size. Keyed by short id.
interface ModelInfo { exp: number; iq: number; eff: string; best: string; ctx?: string }
const MODEL_INFO: Record<string, ModelInfo> = {
  // Anthropic (direct)
  "claude-fable-5": { exp: 5, iq: 5, eff: "Frontier capability at a premium price - worth it only when the task needs the ceiling.", best: "The hardest novel reasoning and long-horizon agentic work.", ctx: "1M" },
  "claude-mythos-5": { exp: 5, iq: 5, eff: "Frontier capability at a premium price - worth it only when the task needs the ceiling.", best: "The hardest novel reasoning and long-horizon agentic work.", ctx: "1M" },
  "claude-opus-4-8": { exp: 4, iq: 5, eff: "Top-tier reasoning with strong value at the Opus tier.", best: "Hard bugs, architecture, multi-file refactors.", ctx: "1M" },
  "claude-opus-4-7": { exp: 4, iq: 5, eff: "Near-4.8 capability for a little less.", best: "Complex coding when 4.8 is overkill.", ctx: "1M" },
  "claude-opus-4-6": { exp: 4, iq: 4, eff: "Prior Opus - very capable, good to pin to.", best: "Complex work needing a stable version.", ctx: "1M" },
  "claude-sonnet-4-6": { exp: 2, iq: 4, eff: "The best all-round speed-to-cost-to-quality balance.", best: "Everyday coding, refactors, code review.", ctx: "1M" },
  "claude-sonnet-4-5": { exp: 2, iq: 4, eff: "Strong balanced workhorse (prior Sonnet).", best: "Everyday coding; a version pin.", ctx: "1M" },
  "claude-haiku-4-5": { exp: 1, iq: 3, eff: "Fastest and cheapest Claude - excellent tokens-per-dollar.", best: "Quick edits, lookups, high-volume tasks.", ctx: "200K" },
  // AskSage · OpenAI
  "gpt-5.2": { exp: 3, iq: 4, eff: "Solid general reasoning; the default RAG model.", best: "General gov coding and analysis.", ctx: "256K" },
  "gpt-5.5": { exp: 4, iq: 5, eff: "The most capable GPT-5 on the gateway.", best: "The hardest gov reasoning tasks.", ctx: "256K" },
  "gpt-5.4": { exp: 4, iq: 5, eff: "High-capability GPT-5 variant.", best: "Demanding gov reasoning.", ctx: "256K" },
  "gpt-5.1": { exp: 3, iq: 4, eff: "Capable GPT-5 variant.", best: "General-purpose gov work.", ctx: "256K" },
  "gpt-5": { exp: 3, iq: 4, eff: "Solid GPT-5 baseline.", best: "Everyday gov coding and writing.", ctx: "256K" },
  "gpt-5-mini": { exp: 2, iq: 3, eff: "Cheaper, faster GPT-5 - strong tokens-per-dollar.", best: "High-volume, latency-sensitive tasks.", ctx: "256K" },
  "gpt-4.1": { exp: 2, iq: 3, eff: "Pre-GPT-5; huge context at lower cost.", best: "Very long context on a budget.", ctx: "1M" },
  "gpt-o3": { exp: 4, iq: 5, eff: "Deliberate o-series reasoning.", best: "Math, logic, hard step-by-step problems.", ctx: "200K" },
  "gpt-o3-mini": { exp: 2, iq: 3, eff: "Efficient reasoning at lower cost.", best: "Reasoning tasks on a budget.", ctx: "200K" },
  "gpt-o4-mini": { exp: 2, iq: 4, eff: "Latest-gen reasoning, cost-effective.", best: "Cost-efficient deep reasoning.", ctx: "200K" },
  // AskSage · Anthropic
  "google-claude-sonnet-5": { exp: 4, iq: 5, eff: "Claude Sonnet 5 via the gov gateway - the newest Sonnet generation.", best: "Fast, frontier-strong gov coding.", ctx: "200K" },
  "google-claude-fable-5": { exp: 4, iq: 5, eff: "Claude Fable 5 via the gov gateway.", best: "Frontier gov reasoning + synthesis.", ctx: "200K" },
  "google-claude-48-opus": { exp: 5, iq: 5, eff: "Claude 4.8 Opus via the gov gateway - the strongest Claude Opus.", best: "The hardest gov coding, architecture, and reasoning.", ctx: "200K" },
  "google-claude-47-opus": { exp: 5, iq: 5, eff: "Claude 4.7 Opus via the gov gateway.", best: "Very hard gov coding and reasoning.", ctx: "200K" },
  "google-claude-46-opus": { exp: 5, iq: 5, eff: "Claude 4.6 Opus via the gov gateway.", best: "Hard gov coding and reasoning.", ctx: "200K" },
  "google-claude-46-sonnet": { exp: 3, iq: 4, eff: "Balanced Claude 4.6 Sonnet via the gov gateway.", best: "Everyday gov coding and review.", ctx: "200K" },
  "google-claude-45-opus": { exp: 5, iq: 5, eff: "Claude 4.5 Opus via the gov gateway.", best: "The hardest gov coding and reasoning.", ctx: "200K" },
  "google-claude-45-sonnet": { exp: 3, iq: 4, eff: "Balanced Claude 4.5 via the gov gateway.", best: "Everyday gov coding and review.", ctx: "200K" },
  "google-claude-45-haiku": { exp: 2, iq: 3, eff: "Fast, low-cost Claude 4.5 Haiku via the gov gateway.", best: "Quick gov edits, lookups, high-volume tasks.", ctx: "200K" },
  "aws-bedrock-claude-45-sonnet-gov": { exp: 3, iq: 4, eff: "Claude 4.5 Sonnet inside AWS GovCloud.", best: "FedRAMP / IL-bound Sonnet workloads.", ctx: "200K" },
  "claude-opus-4": { exp: 4, iq: 5, eff: "Claude Opus 4 via the gov gateway.", best: "Complex gov tasks.", ctx: "200K" },
  "claude-sonnet-4": { exp: 3, iq: 4, eff: "Claude Sonnet 4 via the gov gateway.", best: "Balanced gov coding.", ctx: "200K" },
  // AskSage · Google
  "google-gemini-3.1-pro-com": { exp: 3, iq: 5, eff: "Gemini 3.1 Pro with a 1M context.", best: "Huge-context gov analysis.", ctx: "1M" },
  "google-gemini-3.5-flash-gov": { exp: 2, iq: 3, eff: "Fast Gemini in GovCloud; 1M context.", best: "Fast long-context gov tasks.", ctx: "1M" },
  "google-gemini-2.5-pro": { exp: 3, iq: 4, eff: "Gemini 2.5 Pro; 1M context.", best: "Long-context reasoning.", ctx: "1M" },
  "google-gemini-2.5-flash": { exp: 1, iq: 3, eff: "Fast, cheap Gemini; 1M context.", best: "High-volume long-context work.", ctx: "1M" },
  // Google · Gemini (direct - Antigravity / Gemini CLI). Keyed by the provider-stripped base id so a
  // model routed through either provider inherits the same card. Pro tiers are frontier-class (5 stars);
  // Flash/Lite are the fast, cheap tiers (3 stars). Gemini is 1M-context across the board.
  "gemini-3.1-pro": { exp: 4, iq: 5, eff: "Google's flagship Gemini 3.1 Pro - top reasoning, 1M context.", best: "Complex reasoning, architecture, huge-context analysis.", ctx: "1M" },
  "gemini-3.1-pro-preview": { exp: 4, iq: 5, eff: "Preview of Gemini 3.1 Pro - flagship reasoning, 1M context.", best: "Complex reasoning + huge-context analysis (preview).", ctx: "1M" },
  "gemini-3-pro": { exp: 4, iq: 5, eff: "Gemini 3 Pro - top-tier reasoning, 1M context.", best: "Hard bugs, architecture, complex reasoning.", ctx: "1M" },
  "gemini-3-pro-preview": { exp: 4, iq: 5, eff: "Preview of Gemini 3 Pro - top-tier reasoning, 1M context.", best: "Complex reasoning + architecture (preview).", ctx: "1M" },
  "gemini-3.5-flash": { exp: 1, iq: 3, eff: "Fast, cost-efficient Gemini 3.5 Flash; 1M context.", best: "Quick edits, lookups, high-volume long-context tasks.", ctx: "1M" },
  "gemini-3-flash": { exp: 1, iq: 3, eff: "Fast, cost-efficient Gemini 3 Flash; 1M context.", best: "Quick edits, lookups, high-volume tasks.", ctx: "1M" },
  "gemini-3-flash-preview": { exp: 1, iq: 3, eff: "Preview of Gemini 3 Flash - fast + cheap; 1M context.", best: "Quick edits + high-volume tasks (preview).", ctx: "1M" },
  "gemini-3.1-flash-image": { exp: 2, iq: 3, eff: "Gemini 3.1 Flash with image generation; 1M context.", best: "Fast multimodal + image-generation tasks.", ctx: "1M" },
  "gemini-3.1-flash-lite": { exp: 1, iq: 3, eff: "Lightest, fastest Gemini; 1M context.", best: "High-volume, latency-sensitive tasks.", ctx: "1M" },
  "gemini-3.1-flash-lite-preview": { exp: 1, iq: 3, eff: "Preview of the lightest, fastest Gemini; 1M context.", best: "High-volume, latency-sensitive tasks (preview).", ctx: "1M" },
  "gemini-2.5-pro": { exp: 3, iq: 4, eff: "Gemini 2.5 Pro - strong balanced reasoning; 1M context.", best: "Long-context reasoning and everyday Pro work.", ctx: "1M" },
  "gemini-2.5-flash": { exp: 1, iq: 3, eff: "Fast, cheap Gemini 2.5 Flash; 1M context.", best: "High-volume long-context work.", ctx: "1M" },
  // AskSage · RAG
  "rag": { exp: 3, iq: 4, eff: "Dataset-grounded answers with citations - only as good as your selected datasets.", best: "Questions over your selected knowledge bases.", ctx: "256K" },
};
// P-IDE.1d: EVERY listed model gets the same hover-card framework. Prefer curated MODEL_INFO (by short
// id, then by fully-stripped base id so a provider-routed copy of a known model inherits it); otherwise
// INFER ratings from the family + tier so no row is ever left without a card.
const stripProvider = (v: string) => v.replace(/^[^/]*\//, "");
const FAMILY_LABEL: Record<string, string> = { claude: "Anthropic Claude", gemini: "Google Gemini", gpt: "OpenAI GPT", "gpt-o": "OpenAI o-series", rag: "AskSage RAG", other: "this provider" };
function inferModelInfo(value: string): ModelInfo {
  const s = stripProvider(value).toLowerCase();
  const fam = familyOf(value).id;
  // `\bmini` (word boundary) so "ge·mini" no longer false-matches as small (it was downgrading EVERY
  // inferred Gemini - incl. the Pro tiers - to 3 stars); "-mini" in gpt-5-mini etc. still matches.
  const small = /\bmini|nano|lite|flash|haiku|oss|-8b|-7b/.test(s);
  const big = !small && /opus|pro|max|fable|mythos|ultra|gpt-5|gpt-o/.test(s);
  const iq = big ? 5 : small ? 3 : 4;
  const exp = big ? 4 : small ? 1 : 3;
  const ctxNum = modelCtx(value);
  const ctx = ctxNum ? (ctxNum >= 1_000_000 ? "1M" : `${Math.round(ctxNum / 1000)}K`) : undefined;
  const famName = FAMILY_LABEL[fam] ?? "this provider";
  const eff = small ? `A fast, cost-efficient ${famName} model.` : big ? `A top-capability ${famName} model.` : `A balanced ${famName} model.`;
  const best = fam === "gpt-o" ? "Step-by-step reasoning, math, logic." : small ? "Quick edits, lookups, high-volume tasks." : big ? "Hard bugs, architecture, complex reasoning." : "Everyday coding and analysis.";
  return { exp, iq, eff, best, ctx };
}
function resolveModelInfo(value: string): ModelInfo {
  return MODEL_INFO[shortModelId(value)] ?? MODEL_INFO[stripProvider(value)] ?? inferModelInfo(value);
}
function modelTipHTML(value: string): string {
  const info = resolveModelInfo(value);
  const reason = unavailableReason(value);
  const gov = isAsksage(value);
  // ITAR-unavailable reason + gov-prototype-only advisory sit above the (always-present) ratings.
  const banner = reason ? `<div class="mt-banner warn">${esc(reason)}</div>` : "";
  // P-IDE.1e (ADR-0109): Fable 5, once selectable (Claude connected), carries the U.S.-gov privacy notice.
  const privacyBanner = shortModelId(value) === FABLE_ID && !reason ? `<div class="mt-banner warn">${icon("shield", 12)} ${esc(FABLE_PRIVACY_WARN)}</div>` : "";
  const govNote = gov ? `<div class="mt-banner gov">${esc(GOV_ADVISORY)}</div>` : "";
  const ratings = `<div class="mt-rate">${stars5(info.exp, "exp")}<span class="mt-rlabel">Token Expense</span></div>
    <div class="mt-rate">${stars5(info.iq, "iq")}<span class="mt-rlabel">Intelligence Level</span></div>
    <div class="mt-eff">${esc(info.eff)}</div>
    <div class="mt-row"><span class="mt-k">Best for</span><span class="mt-v">${esc(info.best)}</span></div>
    ${info.ctx ? `<div class="mt-row"><span class="mt-k">Context</span><span class="mt-v">${esc(info.ctx)} tokens</span></div>` : ""}`;
  return `<div class="mt-h"><span class="mt-name">${esc(modelLabel(value))}</span>${gov ? `<span class="gov-pill">Gov</span>` : ""}</div>
    ${banner}${privacyBanner}${govNote}${ratings}
    <div class="mt-row"><span class="mt-k">Model&nbsp;id</span><span class="mt-v mt-id">${esc(shortModelId(value))}</span></div>
    <div class="mt-foot">Practical guidance · not a benchmark</div>`;
}
// A single delegated hover card for any [data-model] row (survives list re-render on
// search). Informational only (pointer-events:none) - never intercepts the picker.
let mtCard: HTMLElement | null = null, mtCur: HTMLElement | null = null, mtTimer: number | undefined;
function hideModelTip(now = false): void {
  if (!mtCard) return; const c = mtCard; mtCard = null; c.classList.remove("show"); setTimeout(() => c.remove(), now ? 0 : 140);
}
function showModelTip(row: HTMLElement): void {
  const html = modelTipHTML(row.dataset.model ?? ""); if (!html) return;
  hideModelTip(true);
  mtCard = el(`<div class="modeltip">${html}</div>`);
  document.body.appendChild(mtCard);
  const r = row.getBoundingClientRect(); const cr = mtCard.getBoundingClientRect();
  let x = r.right + 12; if (x + cr.width > window.innerWidth - 8) x = r.left - cr.width - 12;
  x = Math.max(8, x);
  const y = Math.max(8, Math.min(r.top - 4, window.innerHeight - cr.height - 8));
  mtCard.style.left = `${Math.round(x)}px`; mtCard.style.top = `${Math.round(y)}px`;
  requestAnimationFrame(() => mtCard?.classList.add("show"));
}
function attachModelTips(listEl: HTMLElement): void {
  listEl.addEventListener("mouseover", (e) => {
    const row = (e.target as HTMLElement).closest("[data-model]") as HTMLElement | null;
    if (!row || row === mtCur) return;
    mtCur = row; clearTimeout(mtTimer); mtTimer = window.setTimeout(() => showModelTip(row), 320);
  });
  listEl.addEventListener("mouseout", (e) => {
    const row = (e.target as HTMLElement).closest("[data-model]");
    if (row && row === mtCur) { mtCur = null; clearTimeout(mtTimer); hideModelTip(); }
  });
  listEl.addEventListener("scroll", () => { clearTimeout(mtTimer); hideModelTip(true); mtCur = null; });
}
function curatedModels(opt: ConfigOption): { value: string; name: string }[] {
  const ensureCurrent = (list: { value: string; name: string }[]) => {
    if (!list.some((o) => o.value === opt.currentValue)) {
      const cur = opt.options.find((o) => o.value === opt.currentValue);
      if (cur) list.unshift(cur); // never hide what's actually selected
    }
    return list;
  };
  // P-IDE.1c: curate the catalog. Show every NON-deprecated model omp exposes (all direct providers +
  // gov), minus: omp auxiliary (tab/auto-review) models; gov models unless an AskSage key is configured;
  // China-origin models unless the user acknowledged the data-sovereignty warning in Settings. Then sort
  // gov-first + newest→oldest WITHIN each family (groupByFamily preserves that relative order).
  const govOk = !!state.asksage?.configured;
  const chinaOk = !!state.chinaAck;
  const visible = opt.options.filter((o) =>
    !isAuxiliaryModel(o.value) &&
    !isDeprecatedModel(o.value) &&
    (govOk || !isGovModel(o.value)) &&
    (chinaOk || !isChinaModel(o.value)));
  // Lockdown: only the gov-gateway models are selectable.
  const list = state.asksage?.only ? visible.filter((o) => isGovModel(o.value)) : visible;
  // Final safety: an omp catalog can list the same model twice under one provider. Drop rows that would
  // render IDENTICALLY (same gov/provider + same display name) - the user can't tell them apart anyway.
  const seen = new Set<string>();
  const deduped = sortGovFirstNewest(list).filter((o) => {
    const key = `${isGovModel(o.value) ? "gov" : providerLabel(o.value)}|${cleanModelName(o.name)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return ensureCurrent(deduped);
}
const THINK_DESC: Record<string, string> = {
  off: "Fastest replies - simple edits, lookups, and quick chat.",
  auto: "Lets the model choose how hard to think - a balanced default.",
  minimal: "Light reasoning for quick, well-scoped tasks.",
  low: "Small multi-step tasks and straightforward debugging.",
  medium: "Everyday coding, refactors, and code review.",
  high: "Hard bugs, architecture, and multi-file changes.",
  xhigh: "Deepest reasoning for the most complex, novel problems.",
};
// P-ACP.2/3: the composer's 3-way edit mode (Claude-Code-style). "Ask" is a client posture, not an
// omp mode - see acp_backend.setUiMode. Order: Agent (autonomous) · Ask (approve each) · Plan (read-only).
const MODE_UI_OPTS: { value: "agent" | "ask" | "plan"; name: string }[] = [
  { value: "agent", name: "Agent" }, { value: "ask", name: "Ask" }, { value: "plan", name: "Plan" },
];
const MODE_DESC: Record<string, string> = {
  agent: "Edits files and runs tools autonomously.",
  ask: "Asks you to approve each tool call before it runs.",
  plan: "Read-only - drafts a plan, makes no changes.",
};
const prettyLevel = (name: string) => { const v = String(name).toLowerCase(); return v === "xhigh" ? "X-High" : v.charAt(0).toUpperCase() + v.slice(1); };
let cfgClose: (() => void) | null = null;
// P-PERF.5 (ADR-0132): the picker rows are memoized - reopening the popover (the common flip-between-
// models flow) reuses the last build instead of re-sorting + re-rendering 100-200 rows. The key covers
// everything the HTML derives from: the curated list, selection, query, collapse state, gov ordering.
let pickerMemo: { key: string; html: string } | null = null;

function openConfigPopover(anchor: HTMLElement): void {
  cfgClose?.(); // close any popover already open
  const model = state.config.find((c) => c.id === "model");
  const think = state.config.find((c) => c.id === "thinking");
  const models = model ? curatedModels(model) : [];

  const modelSec = model ? `<div class="cfg-sec">
      <div class="cfg-lbl">Model <span class="cur">${esc(modelLabel(model.currentValue))}</span><span class="cfg-loading" id="cfgLoading"${state.configCached ? "" : " hidden"}><span class="cfg-spin"></span>updating…</span></div>
      <div class="cfg-search">${icon("search", 15)}<input id="cfgModelSearch" placeholder="Search ${models.length} models…" /></div>
      <div class="cfg-list" id="cfgModelList"></div></div>` : "";
  const modeSec = `<div class="cfg-sec"><div class="cfg-lbl">Mode</div>
      <div class="seg" data-cfg="mode">${MODE_UI_OPTS.map((o) =>
        `<button class="${o.value === state.uiMode ? "on" : ""}" data-val="${esc(o.value)}" data-tip="${esc(o.name)}|${esc(MODE_DESC[o.value] ?? "")}" data-tip-side="top">${esc(o.name)}</button>`).join("")}</div></div>`;
  const thinkCur = think?.options.find((o) => o.value === think.currentValue);
  const thinkSec = think ? `<div class="cfg-sec"><div class="cfg-lbl">Thinking</div>
      <div class="cfg-dd" data-dd="thinking">
        <button class="cfg-dd-btn" type="button"><span>${esc(prettyLevel(thinkCur?.name ?? think.currentValue))}</span>${icon("chevron", 14)}</button>
        <div class="cfg-dd-menu">${think.options.map((o) =>
          `<div class="cfg-dd-item ${o.value === think.currentValue ? "on" : ""}" data-val="${esc(o.value)}" data-tip="${esc(prettyLevel(o.name))} thinking|${esc(THINK_DESC[o.value] ?? "")}" data-tip-side="right"><span class="tick">${icon("check", 13)}</span><span>${esc(prettyLevel(o.name))}</span></div>`).join("")}</div>
      </div></div>` : "";

  const { node, close } = popover(anchor, modelSec + modeSec + thinkSec, () => { cfgClose = null; pickerRedraw = null; hideModelTip(true); });
  cfgClose = close;

  // searchable model list
  if (model) {
    const list = $("#cfgModelList", node)!;
    const search = $("#cfgModelSearch", node) as HTMLInputElement;
    // P-IDE.1/1d: collapsible family sections; search filters across all families. draw() recomputes
    // from the LIVE state.config each call, so the cold-boot refresh (pickerRedraw) swaps the cached
    // list for the live one in place and clears the "updating…" spinner.
    const draw = (q = "") => {
      const m = state.config.find((c) => c.id === "model");
      const list2 = m ? curatedModels(m) : [];
      const cur = m?.currentValue ?? model.currentValue;
      const key = `${list2.map((o) => o.value).join(",")}|${cur}|${q}|${[...collapsedFamilies()].sort().join(",")}|${state.asksage?.configured ? 1 : 0}|${favsOf().join(",")}`; // P-FAV.1: stars invalidate the memo
      if (pickerMemo?.key !== key) pickerMemo = { key, html: familyListHTML(list2, cur, q) }; // P-PERF.5 memo
      list.innerHTML = pickerMemo.html;
      search.placeholder = `Search ${list2.length} models…`;
      const ld = $("#cfgLoading", node) as HTMLElement | null; if (ld) ld.hidden = !state.configCached;
    };
    draw();
    pickerRedraw = () => draw(search.value); // refresh when live config lands (cold-boot cache → live)
    attachModelTips(list); // premium per-model hover cards (delegated → survives re-render)
    search.addEventListener("input", (e) => draw((e.target as HTMLInputElement).value));
    list.addEventListener("click", (e) => {
      // P-FAV.1: the star is INSIDE a [data-val] row - check it first so starring never selects.
      const fs = (e.target as HTMLElement).closest("[data-fav]") as HTMLElement | null;
      if (fs) { saveFavs(toggleFav(favsOf(), fs.dataset.fav!)); draw(search.value); return; }
      const tgl = (e.target as HTMLElement).closest("[data-fam-toggle]") as HTMLElement | null;
      if (tgl) { toggleFamilyCollapsed(tgl.dataset.famToggle!); draw(search.value); return; }
      const it = (e.target as HTMLElement).closest("[data-val]") as HTMLElement | null;
      if (it) { applyConfig("model", it.dataset.val!); close(); }
    });
  }
  // mode segmented
  const modeEl = $(".seg[data-cfg='mode']", node);
  modeEl?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-val]") as HTMLElement | null;
    if (!b) return;
    for (const c of modeEl.children) c.classList.toggle("on", c === b);
    applyConfig("mode", b.dataset.val!);
  });
  // thinking dropdown
  const dd = $(".cfg-dd[data-dd='thinking']", node) as HTMLElement | null;
  if (dd && think) {
    $(".cfg-dd-btn", dd)!.addEventListener("click", (e) => { e.stopPropagation(); dd.classList.toggle("open"); });
    $(".cfg-dd-menu", dd)!.addEventListener("click", (e) => {
      const it = (e.target as HTMLElement).closest("[data-val]") as HTMLElement | null;
      if (!it) return;
      ($(".cfg-dd-btn span", dd) as HTMLElement).textContent = prettyLevel(think.options.find((o) => o.value === it.dataset.val)?.name ?? it.dataset.val!);
      for (const c of $$(".cfg-dd-item", dd)) c.classList.toggle("on", c === it);
      dd.classList.remove("open");
      applyConfig("thinking", it.dataset.val!);
    });
  }
}

/** A focused single-option dropdown (used by the composer chips) - one config at
 *  a time. omp exposes exactly two modes: Default (Agent) and Plan. */
function openOptionDropdown(anchor: HTMLElement, configId: string): void {
  cfgClose?.();
  const c = state.config.find((x) => x.id === configId);
  if (!c) return;
  // P-ACP.3: the mode control is the client 3-way Plan/Ask/Agent (omp itself only has default+plan).
  const opts = configId === "model" ? curatedModels(c) : configId === "mode" ? MODE_UI_OPTS : c.options;
  const cur = configId === "mode" ? state.uiMode : c.currentValue;
  const labelOf = (o: { value: string; name: string }) =>
    configId === "model" ? o.name : configId === "thinking" ? prettyLevel(o.name) : o.name;
  // P-IDE.1: the model picker renders collapsible family sections; other configs stay flat lists.
  const rows = (list: { value: string; name: string }[]) => configId === "model"
    ? familyListHTML(list, c.currentValue)
    : list.map((o) =>
      `<div class="cfg-opt ${o.value === cur ? "on" : ""}" data-val="${esc(o.value)}"${configId === "mode" ? ` data-tip="${esc(o.name)}|${esc(MODE_DESC[o.value] ?? "")}" data-tip-side="right"` : ""}><span class="tick">${icon("check", 13)}</span><span class="nm">${esc(labelOf(o))}</span></div>`).join("");
  const search = configId === "model" ? `<div class="cfg-search">${icon("search", 15)}<input id="miniSearch" placeholder="Search ${opts.length} models…" /></div>` : "";
  const lbl = configId === "model"
    ? `<div class="cfg-lbl">${esc(c.name)}<button class="cfg-refresh" id="cfgRefresh" data-tip="Refresh models|Re-read providers from omp to pick up a provider you just connected (OAuth or key) - no relaunch needed.">${icon("refresh", 12)}</button></div>`
    : `<div class="cfg-lbl">${esc(c.name)}</div>`;
  const { node, close } = popover(anchor, `<div class="cfg-sec">${lbl}${search}<div class="cfg-list" id="miniList">${rows(opts)}</div></div>`, () => { cfgClose = null; hideModelTip(true); });
  cfgClose = close;
  const listEl = $("#miniList", node)!;
  if (configId === "model") {
    attachModelTips(listEl); // premium per-model hover cards
    ($("#miniSearch", node) as HTMLInputElement).addEventListener("input", (e) => {
      listEl.innerHTML = familyListHTML(opts, c.currentValue, (e.target as HTMLInputElement).value);
    });
    $("#cfgRefresh", node)?.addEventListener("click", async (e) => {
      e.stopPropagation();
      showToast({ title: "Refreshing models…", desc: "Reloading providers from omp.", timeout: 1500 });
      await refreshModels();
      close();
      openOptionDropdown(anchor, "model"); // reopen with the fresh list
    });
  }
  listEl.addEventListener("click", (e) => {
    if (configId === "model") {
      // P-FAV.1: star toggle first (inside a [data-val] row) - starring never selects.
      const fs = (e.target as HTMLElement).closest("[data-fav]") as HTMLElement | null;
      if (fs) { saveFavs(toggleFav(favsOf(), fs.dataset.fav!)); listEl.innerHTML = familyListHTML(opts, c.currentValue, ($("#miniSearch", node) as HTMLInputElement)?.value ?? ""); return; }
      const tgl = (e.target as HTMLElement).closest("[data-fam-toggle]") as HTMLElement | null;
      if (tgl) { toggleFamilyCollapsed(tgl.dataset.famToggle!); listEl.innerHTML = familyListHTML(opts, c.currentValue, ($("#miniSearch", node) as HTMLInputElement)?.value ?? ""); return; }
    }
    const it = (e.target as HTMLElement).closest("[data-val]") as HTMLElement | null;
    if (it) { applyConfig(configId, it.dataset.val!); close(); }
  });
}

// ───────────────────────── text zoom ─────────────────────────
// The default UI was a touch small, so the baseline now renders 1.2× larger — what used to require 120%
// zoom IS the new 100%. `state.zoom` stays the LOGICAL level shown in the % chip (default 1 = 100%); the
// factor actually applied is `state.zoom * ZOOM_BASE`, so the chip still reads 100% at the bigger default.
const ZOOM_BASE = 1.2;
function applyZoom(): void {
  state.zoom = Math.max(0.7, Math.min(1.8, Math.round(state.zoom * 100) / 100));
  bridge.setZoom(state.zoom * ZOOM_BASE);
  const lvl = $("#zoomLvl"); if (lvl) lvl.textContent = `${Math.round(state.zoom * 100)}%`;
  try { localStorage.setItem("lucid.zoom", String(state.zoom)); } catch { /* ignore */ }
}
function nudgeZoom(delta: number): void { state.zoom += delta; applyZoom(); }
function resetZoom(): void { state.zoom = 1; applyZoom(); }
function initZoom(): void {
  try {
    // One-time rebaseline to the bigger default: drop any prior stored zoom so everyone lands on the new
    // 100% (= old 120%) once; adjustments after that persist normally.
    if (!localStorage.getItem("lucid.zoombase12")) { localStorage.removeItem("lucid.zoom"); localStorage.setItem("lucid.zoombase12", "1"); }
    const z = Number(localStorage.getItem("lucid.zoom")); if (z) state.zoom = z;
  } catch { /* ignore */ }
  applyZoom();
}

// ───────────────────────── drag-to-resize panels ─────────────────────────
function initResize(): void {
  const root = document.documentElement;
  const setW = (which: string, w: number) => root.style.setProperty(`--${which}-w`, `${Math.round(w)}px`);
  try {
    const sw = Number(localStorage.getItem("lucid.sidebar-w")); if (sw) setW("sidebar", sw);
    const iw = Number(localStorage.getItem("lucid.inspector-w")); if (iw) setW("inspector", iw);
    const kw = Number(localStorage.getItem("lucid.kg-w")); if (kw) setW("kg", kw);
    const pw = Number(localStorage.getItem("lucid.preview-w")); if (pw) setW("preview", pw); // P-PREVIEW.1
    const ksw = Number(localStorage.getItem("lucid.kgside-w")); if (ksw) setW("kgside", ksw); // P-KG-CODE.1b
  } catch { /* ignore */ }
  // data-resize value → the panel element id ("kg" → #knowledge, "kgside" → the KG side flyout); all
  // right-side panels resize from their left edge, the sidebar (left panel) from its right edge.
  const elFor = (which: string) => $(`#${which === "kg" ? "knowledge" : which === "kgside" ? "kgSide" : which}`)!;
  let active: { which: string; el: HTMLElement } | null = null;
  for (const r of $$(".resizer")) {
    r.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const which = (r as HTMLElement).dataset.resize!;
      active = { which, el: elFor(which) };
      document.body.classList.add("resizing");
    });
  }
  window.addEventListener("mousemove", (e) => {
    if (!active) return;
    const rect = active.el.getBoundingClientRect();
    // KG can collapse toward the chat to a low minimum, or widen up to 80% of the window.
    const [min, max] = active.which === "sidebar" ? [180, 520]
      : active.which === "kg" || active.which === "preview" ? [360, Math.round(window.innerWidth * 0.8)]
      : active.which === "kgside" ? [200, Math.round(window.innerWidth * 0.6)] // P-KG-CODE.1b: the KG side flyout
      : [300, 720];
    const raw = active.which === "sidebar" ? e.clientX - rect.left : rect.right - e.clientX;
    setW(active.which, Math.max(min, Math.min(max, raw)));
  });
  window.addEventListener("mouseup", () => {
    if (!active) return;
    const v = parseInt(getComputedStyle(root).getPropertyValue(`--${active.which}-w`));
    if (v) try { localStorage.setItem(`lucid.${active.which}-w`, String(v)); } catch { /* ignore */ }
    document.body.classList.remove("resizing");
    active = null;
  });
}

// ───────────────────────── boot ─────────────────────────
buildShell();
void renderSessions();
initTooltips();
wire();
initZoom();
initResize();
seedThread();
// Sessions panel: remember your choice across launches; default OPEN so a past
// conversation is one click away (it used to start collapsed → expand-then-click felt like
// a double-click). Collapse it once and it stays collapsed.
toggleSidebar((() => { try { return localStorage.getItem("lucid.sidebar-collapsed") === "1"; } catch { return false; } })());
setInspectorRail(true); // start with the right inspector slid into the metrics rail
renderStatus();
loadCachedConfig(); renderStatus(); // P-IDE.1d: paint the cached model immediately, then refresh live
void loadConfig().then(renderStatus);
void loadWorkspace();
void loadAsksage();
void loadSkills();
void loadDev(); // ADR-0009 Phase D: reveal the Logs rail panel if developer mode is on
void bridge.getSettings().then((s) => { // your saved name → the "You" label on your messages
  if (s?.username) { state.username = s.username; $$(".msg.user .who").forEach((w) => { w.textContent = s.username!; }); }
  if (s?.email) state.email = s.email;
  state.attribution = s?.attribution ?? null;
  state.userRole = s?.role ?? null;               // ADR-0088: null until the user picks a role
  state.tourSeen = !!s?.tourSeen;                  // ADR-0089: first-run walkthrough replay guard
  if (state.userRole) applyRoleDefault(state.userRole); // returning user lands on their role's surface
  runOnboarding(); // ADR-0088/0089: role pick (if needed) → email → first-run tour, in sequence
});
refresh();
void bridge.chatBackground().then((c) => { if (c) { state.chatBg = c; applyChatBg(c); } }); // P-APPEAR.1: paint the saved chat background
void bridge.codeGraphAgent().then((a) => { if (a) state.codeGraphAgent = a.enabled; }); // P-KG-SYM.1: reflect the agent-tool opt-in
void maybeOnboardPersonal(); // P-IMP.2: first-run nudge + expand Personalization until it's configured
void bridge.auth().then((a) => { if (a) { state.auth = a; renderStatus(); } }); // gate the budget pill (OAuth vs API key) from first paint
scheduleBudgetPoll(); // provider budget: re-check every 5 min for the current model
// P-PERF.2 (ADR-0129): battery/visibility-aware polling. Work is SKIPPED while the window is hidden and
// the period stretches on battery tiers (pollDelay); a visibilitychange back to visible catches up at once.
const adaptivePoll = (baseMs: number, fn: () => void): void => {
  const loop = (): void => {
    if (!document.hidden) fn();
    window.setTimeout(loop, pollDelay(baseMs, perfWatch.tier(), document.hidden));
  };
  window.setTimeout(loop, pollDelay(baseMs, perfWatch.tier(), document.hidden));
};
adaptivePoll(4000, refresh);
adaptivePoll(1000, renderStatus);
adaptivePoll(15000, () => void renderSessions());
document.addEventListener("visibilitychange", () => { if (!document.hidden) { refresh(); renderStatus(); void renderSessions(); } });
