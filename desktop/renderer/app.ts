// desktop/renderer/app.ts - the LucidAgentIDE renderer.
//
// Assembles the shell (titlebar · rail · sidebar · chat · inspector · status),
// wires interaction, polls the live security/memory snapshots, and streams the
// agent turn. Same renderer in Electron (real omp ACP via window.lucid) and in
// the browser dev server (simulated). Pure DOM, no framework.

import { bridge, type ChatEvent, type ConfigOption, type MemorySnapshot, type OmpCommand, type ProviderAuth, type SecuritySnapshot, type SessionInfo, type WorkspaceInfo } from "./bridge.ts";
import { $, $$, accordion, el, fmtNum, gauge, spark, table } from "./dom.ts";
import { ageStr, esc, fmtUSD, goodColor, loadColor } from "./format.ts";
import { icon, piMark } from "./icons.ts";
import { renderMarkdown } from "./markdown.ts";
import { type GraphHandle, kindLabel, mountGraph } from "./graph.ts";
import { addEdgeOptimistic, applyForget, chainPairs, resolveRelationLabel } from "./kg_ops.ts";
import type { PersonalGraphData } from "./bridge.ts";
import { type Action, type ToastAction, attachRichTip, createPalette, initTooltips, popover, showToast } from "./ui.ts";
import { exportActionPlan } from "./kg_export.ts";
import { formatImportLine } from "./import_progress.ts";
import { ASKSAGE_FAMILY_ORDER, familyOf, filterModels, groupByFamily, isAuxiliaryModel, isChinaModel, isDeprecatedModel, isGovModel, sortGovFirstNewest } from "./model_families.ts";
import { INSTALLED_SKILLS, bumpSkillUsage, bundledSkillsByUsage, taskProforma } from "./skills.ts";
import { CHECKER_TOKENS_PER_ITER, MAKER_TOKENS_PER_ITER, estimateGoalCost, estimateGoalTokens, formatTokens, formatUSD } from "../loop_estimate.ts";
import { assumedCacheRate, priceFor } from "../model_pricing.ts";
import { closeIde, openIde, setIdeExclusivity, setIdeHooks } from "./ide_panel.ts";
// P-TPS.1 (ADR-0044): the shared output-token speedometer — same engine the omp
// terminal adapter uses. Drives the HUD's live "tok out · tok/s" readout from the
// streaming text/thinking deltas (output only; never the system prompt).
import { TokenSpeedEngine } from "../../harness/metrics/token_speed.ts";

type Tab = "security" | "memory" | "dev";
const state = {
  inspectorTab: "memory" as Tab, // ADR-0021: default to Memory; overridden to Security when active blocks exist
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
  skills: [] as { name: string; description: string; source: string }[],
  activeSkill: null as { command: string; name: string } | null, // P-IDE.2: active bundled skill
  liveUsage: null as { used: number; size: number; cost: number } | null,
  username: "" as string, // the "You" label on your messages (Settings → Profile)
  email: "" as string, // corporate email — attribution identity (ADR-0030); prompted on first open
  attribution: null as import("./bridge.ts").ProfileSettings["attribution"] | null, // identity + source (email|workstation)
  budgetWarned: new Set<string>(), // provider budgets we've already warned about this window
  workspace: null as WorkspaceInfo | null,
  asksage: null as { configured: boolean; base: string; only: boolean; limit: number; datasets: string[]; queryModel: string; persona: string } | null,
  asksageTokens: null as { used: number; remaining: number | null; limit: number } | null,
  chinaAck: false as boolean, // P-IDE.1c: user acknowledged the China-origin data-sovereignty warning (Settings unlock)
  persona: null as string | null, // active persona id (AskSage)
  personas: [] as { id: string; description: string }[],
  zoom: 1,
  settingsOpen: false,
  lastOk: 0,
  streaming: false,
  queued: null as string | null, // P-ACP.4: a prompt the user pre-staged while a turn was running
  lastPrompt: "" as string, // last user message - re-sent by an Approve & retry (ADR-0019 C)
  probedLimits: [] as import("./bridge.ts").ProbedLimit[], // P10.3 live API-key rate limits
  probeEnabled: false, // P10.3 opt-in state for the live rate-limit probe
  developerMode: false, // ADR-0009 Phase D
  dev: null as import("./bridge.ts").DevView | null, // ADR-0009 Phase D logs snapshot
  mcpServers: [] as import("./bridge.ts").McpServerStatus[], // P-MCP.1 (ADR-0020)
  managed: null as import("./bridge.ts").ManagedPolicy | null, // ADR-0068 (P-ENT.1) enterprise locks
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
  "google-claude-45-opus": 200_000, "google-claude-45-sonnet": 200_000,
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
      <div class="tb-spacer"></div>
      <div class="zoom" role="group" aria-label="Text zoom">
        <button id="zoomOut" data-tip="Zoom out|Ctrl −">${icon("minus", 15)}</button>
        <span class="lvl" id="zoomLvl" data-tip="Reset zoom|Ctrl 0">100%</span>
        <button id="zoomIn" data-tip="Zoom in|Ctrl +">${icon("plus", 15)}</button>
      </div>
      <button class="model-badge" id="cmdkBtn" data-tip="Command palette|Ctrl / ⌘ K" data-tip-icon="command">${icon("command", 14)}<span>Commands</span></button>
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
        <button class="rail-btn" data-rail="memory" data-tip="Memory & context|Context window, prompt-cache savings, semantic memory" data-tip-icon="brain">${icon("brain", 20)}</button>
        <button class="rail-btn" data-rail="knowledge" data-tip="Knowledge graph|Your private, encrypted personalization graph - nodes, edges, drill-down" data-tip-icon="graph">${icon("graph", 20)}</button>
        <button class="rail-btn" id="railLogs" data-rail="dev" hidden data-tip="Logs|Read-only developer logs: telemetry, run lineage, transcripts, gate-block audit, AskSage tool-call diagnostics" data-tip-icon="logs">${icon("logs", 20)}</button>
        <div class="spacer"></div>
        <button class="rail-btn" id="railCmd" data-tip="Commands|Ctrl / ⌘ K" data-tip-icon="command">${icon("command", 20)}</button>
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
        <div class="chat" id="chat"><div class="thread" id="thread"></div></div>
        <button class="jump-down" id="jumpDown" type="button" aria-label="Jump down a page" data-tip="Jump down a page">${icon("chevronsDown", 18)}</button>
        <div class="composer-wrap">
          <div class="composer-row">
            <div class="composer">
              <textarea id="input" rows="1" placeholder="Ask the agent…  every tool call is scanned before it runs"></textarea>
            </div>
            <button class="send-btn" id="send" data-tip="Send|Enter" disabled>${icon("send", 18)}</button>
          </div>
          <div class="composer-tools" id="composerTools">
            <button class="ctool" id="ctModel" data-tip="Model|Click to change the model">${icon("spark", 14)}<span id="ctModelName">${esc(modelLabel(state.model))}</span>${icon("chevron", 11)}</button>
            <button class="ctool" id="ctMode" data-tip="Mode|Agent edits files · Plan drafts read-only">${icon("bolt", 14)}<span id="ctModeName">Agent</span>${icon("chevron", 11)}</button>
            <button class="ctool" id="ctThink" data-tip="Thinking depth|How hard the model reasons">${icon("bulb", 14)}<span id="ctThinkName">High</span>${icon("chevron", 11)}</button>
            <button class="ctool" id="ctPersona" data-tip="AskSage persona|Server-supplied role guidance - scanned before use" hidden>${icon("user", 14)}<span id="ctPersonaName">Persona</span>${icon("chevron", 11)}</button>
            <button class="ctool" id="ctSkill" data-tip="Skills|Built-in skills, /task delegation, and project skills" hidden>${icon("bolt", 14)}<span>Skills</span>${icon("chevron", 11)}</button>
            <span class="ctool-hint"><span class="kh"><kbd>↵</kbd> send</span><span class="kh"><kbd>⇧↵</kbd> newline</span><span class="kh"><kbd>⌘K</kbd> commands</span></span>
          </div>
        </div>
      </main>

      <aside class="inspector" id="inspector">
        <div class="resizer resizer-l" data-resize="inspector" data-tip="Drag to resize" data-tip-side="left"></div>
        <div class="insp-tabs">
          <button class="insp-tab sec" data-insp="security">${icon("shield", 15)} Security</button>
          <button class="insp-tab mem active" data-insp="memory">${icon("brain", 15)} Memory</button>
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

      <aside class="kg" id="knowledge" hidden>
        <div class="resizer resizer-l" data-resize="kg" data-tip="Drag to resize|Collapse toward the chat or widen the graph" data-tip-side="left"></div>
        <div class="set-head">
          <div class="set-title">${icon("graph", 17)} Knowledge graph <span class="set-sub" id="kgScopeLbl"></span></div>
          <div class="kg-tools">
            <div class="seg kg-lens" data-kg-lens>
              <button class="on" data-lens="kind">Kind</button><button data-lens="trust">Trust</button>
            </div>
            <button class="btn-mini" id="kgRelate" data-tip="Relate nodes|Turn on relate mode, then drag one node onto another — or click two or more nodes and press Relate — to add your OWN relationships. They're saved to your private graph (first-party, never sent to be scanned as instructions).">${icon("git", 13)} Relate</button>
            <label class="kg-ai" data-tip="AI extraction|Use the model to pull richer facts + real relationships from each message, instead of the fast offline heuristic. Slower and uses model quota; capped at 500 messages per import. Leave off for a free, instant pass."><input type="checkbox" id="kgImportAI"/> AI</label>
            <button class="btn-mini" id="kgImport" data-tip="Import chat history|Bring in a ChatGPT, Claude, or Gemini data export to seed your graph. Easiest: just pick the unzipped export FOLDER (a modern ChatGPT export has no single conversations.json — it ships conversations-000.json, -001.json … and we merge them for you) — or point at the .zip / conversations.json / MyActivity.json directly. Every message is scanned by the security gate before anything is learned; only your own messages teach the profile.">${icon("download", 13)} Import history</button>
            <button class="btn-mini" id="kgExport" data-tip="Export Obsidian vault|Decrypt and write your Personal + Work knowledge to a portable Obsidian vault (notes, [[wikilinks]], escaped). CUI is excluded by design. The export is audited.">${icon("folder", 13)} Export vault</button>
            <button class="btn-mini danger" id="kgCui" data-tip="CUI archive · National Archives|Export ONLY the CUI compartment into a CUI-marked, records-managed package with a SHA-256 manifest (32 CFR 2002 · NARA). For archive/records requirements. Audited.">${icon("shield", 13)} CUI archive</button>
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
          <div class="kg-side" id="kgSide"></div>
        </div>
      </aside>
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
async function renderSessions(): Promise<void> {
  const list = $("#sessList");
  if (!list) return;
  // Show the skeleton only on a cold list (first load). On a re-render after sending a
  // prompt the list already has content - don't flash it back to skeleton.
  if (!list.firstElementChild || $(".skel-group", list)) list.innerHTML = sessSkeleton();
  const data = await bridge.sessions().catch(() => null);
  if (data === null) { list.innerHTML = `<div class="side-empty">Couldn't load history - the GUI server looks out of date. Relaunch it (launcher → <b>G</b>), or restart <code>bun run desktop:web</code>.</div>`; return; }
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
function addMessage(role: "user" | "assistant", text: string): HTMLElement {
  $("#chatHint")?.remove();
  // Copy + Save .md on BOTH roles (copy your own prompts too).
  const actions = `<div class="msg-actions"><button class="msg-act" data-msg-copy data-tip="Copy markdown">${icon("copy", 13)}</button><button class="msg-act" data-msg-save data-tip="Save as .md">${icon("download", 13)}</button></div>`;
  const who = role === "user" ? (state.username || "You") : "LucidAgent";
  const node = el(`<div class="msg ${role}">
    <div class="who">${esc(who)}</div>
    <div class="av">${role === "user" ? icon("user", 16) : piMark}</div>
    <div class="text"></div>${actions}</div>`);
  (node as MsgNode)._md = text; // raw markdown, for copy / save-as-.md
  const textEl = $(".text", node) as HTMLElement;
  textEl.innerHTML = renderMarkdown(text);
  enhanceCodeBlocks(textEl);
  $("#thread")!.appendChild(node);
  scrollChat();
  return node;
}
interface MsgNode extends HTMLElement { _md?: string }

// ── P-IMP.2 (ADR-0035): chat-export import onboarding ────────────────────────────────
// Mirrors MODEL_IMPORT_CAP in desktop/personal.ts — AI mode sends at most this many user messages
// to the model (one sequential call each), so the warning's token/time math caps here too.
const AI_IMPORT_CAP = 500;
/** Rough AI-extraction cost for the pre-import warning. Per capped message: ~200-token extract
 *  prompt + the message (chars/4) in, ~100-token JSON out; calls run sequentially at ~2.5 s each.
 *  Deliberately approximate — it exists to set expectations before a paid, minutes-long run. */
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
    if (kgOpen) void renderKnowledge(); // redraw with the new nodes + edges (only if the panel is open)
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
// Stick-to-bottom autoscroll, rAF-batched for buttery playback under rapid tokens.
// Many scrollChat() calls within one frame coalesce into a SINGLE scrollTop write, so the
// browser never thrashes layout mid-stream. We only follow output while the user is parked
// near the bottom (STICK_PX); the moment they scroll UP to re-read, autoscroll releases and
// stays released until they come back down - so re-reading mid-stream is never yanked.
// Tight stick window: we only auto-FOLLOW while the user is essentially parked at the bottom.
// Slow output advances < STICK_PX per frame, so it keeps pace; a fast burst grows the page by more
// than STICK_PX between frames, which releases the follow — and the jump-down button (below) lets the
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
// the answer streams. Keep them upbeat but honest — they describe the kind of work, not fake specifics.
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

// ── Consolidating activity window (the "working / agent thoughts" surface) ──
// Instead of an ever-growing stack of raw .evt chips, the agent's tool calls collapse into
// ONE compact window per turn: a head (live current step + a count) you can expand to see the
// full step list, and a tidy one-line summary on done. Security blocks are NEVER folded in
// here - onBlock keeps emitting its own loud .evt.block chip alongside this window.
interface ThoughtsWin {
  el: HTMLElement;
  /** Record a tool/activity step. */
  step(name: string, detail: string): void;
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
    step(name: string, detail: string) {
      steps++;
      const label = phaseForTool(name, detail);
      curEl.textContent = label;
      countEl.hidden = false;
      countEl.textContent = String(steps);
      if (/edit|write|notebook|patch|apply|create/i.test(name) && detail) files.add(detail.trim());
      body.appendChild(el(`<div class="thoughts-step">${icon(phaseIcon(name), 13)}<span class="ts-k">${esc(name)}</span><span class="ts-d">${esc(detail)}</span></div>`));
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
    win = el(`<div class="perm perm-egress" data-streaming="1">
      <div class="perm-eg-head">${icon("git", 13)}<span>The agent wants to visit a website</span></div>
      <div class="perm-egress-target"><code class="perm-url">${esc(url)}</code><button class="perm-copy" data-tip="Copy URL">${icon("copy", 12)}</button></div>
      <button class="perm-radar" data-radar>${icon("search", 12)} Check it on Cloudflare Radar</button>
      <div class="perm-actions perm-actions-col">${btns}</div>
    </div>`);
    const copyBtn = $(".perm-copy", win) as HTMLElement | null;
    copyBtn?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); copyBtn.innerHTML = icon("check", 12); setTimeout(() => { copyBtn.innerHTML = icon("copy", 12); }, 1200); } catch { /* clipboard blocked */ }
    });
    ($("[data-radar]", win) as HTMLElement | null)?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); } catch { /* ignore */ }
      window.open("https://radar.cloudflare.com/scan", "_blank", "noopener");
      showToast({ title: "URL copied · Radar opened", desc: "Paste the URL into Cloudflare Radar to vet the site before allowing.", actions: [{ label: "OK" }], timeout: 4000 });
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
    if (e.egress) {
      // Docked card: confirm with a brief toast, then remove it (and the dock when empty).
      showToast({ title: ok ? "Allowed" : "Blocked", desc: ok ? "The agent can reach the site." : "The agent won't reach that site.", actions: [{ label: "OK" }], timeout: 2200, ...(ok ? {} : { tone: "warn" as const }) });
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
    const isDeny = e.egress ? opt?.kind === "reject" : !isAllowOpt(opt?.kind, opt?.optionId);
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
    <div class="subagent-body">${body}</div>
  </div>`);
  const headBtn = $(".subagent-head", win) as HTMLButtonElement;
  const toggle = (open: boolean) => { win.classList.toggle("open", open); headBtn.setAttribute("aria-expanded", String(open)); };
  headBtn.addEventListener("click", () => toggle(!win.classList.contains("open")));
  let done = false;
  return { el: win, finish() { if (done) return; done = true; win.removeAttribute("data-streaming"); win.classList.add("done"); toggle(false); } };
}

async function send(): Promise<void> {
  const ta = $("#input") as HTMLTextAreaElement;
  const text = ta.value.trim();
  if (!text) return;
  // P-ACP.4: a turn is already running → pre-stage this prompt instead of dropping it. It auto-sends
  // when the current turn ends (naturally or via Stop). One slot — a newer entry replaces the old.
  if (state.streaming) { state.queued = text; ta.value = ""; autosize(ta); renderQueued(); setSendEnabled(); return; }
  // First message of the app session: auto-collapse the sessions panel (Claude-Code style) so the
  // chat takes the focus - the nav hamburger (#sideToggle) reopens history on demand. Done once so
  // we never fight a user who reopens it mid-chat.
  if (!autoCollapsedSessions) { autoCollapsedSessions = true; if (!state.sidebarCollapsed) toggleSidebar(true); }
  state.lastPrompt = text; // remembered so an Approve & retry can re-send it
  ta.value = ""; autosize(ta); setSendEnabled();
  addMessage("user", text);
  state.streaming = true; setSendEnabled();

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
  // freeze TTFT and align the rate clock to first-token. Estimate strategy — ACP
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
    // The streaming OUTPUT count — what the model is generating right now, with no
    // system prompt / cached prefix in it (the user's "minus the whole prompt" ask).
    const out = tps.tokenCount;
    // averageTps (not the windowed tps): ACP delivers reasoning/text in big lumps,
    // so the running average reads steady where a windowed rate would strobe.
    if (out > 0) { const r = tps.averageTps; tpsEl.textContent = `· ${fmtNum(out)} tokens out${r > 0 ? ` · ${r.toFixed(1)} tokens/s` : ""}`; }
    else tpsEl.textContent = "";
    // The CONTEXT figure (window fill + turn cost) genuinely includes the prompt —
    // labelled "context" so it's never mistaken for the per-turn output above. Cost
    // is shown to the cent ($0.00) — the sub-cent precision read as noise.
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
  const onEvent = (e: ChatEvent) => {
    if (e.type === "token") { reasoning?.finish(Date.now() - t0); buf += e.text; countDelta(e.text); if (!sawTool) setPhase(writeLine); streamEl.innerHTML = renderMarkdown(buf) + `<span class="cursor"></span>`; paintHud(); scrollChat(); }
    else if (e.type === "thinking") {
      // First reasoning chunk: spin up the live thinking block above the answer.
      if (!reasoning) { reasoning = createReasoning(); streamEl.before(reasoning.el); }
      if (!sawTool) setPhase(thinkLine);
      countDelta(e.text); // thinking tokens ARE output — count them in the readout
      reasoning.push(e.text); paintHud(); scrollChat();
    }
    else if (e.type === "tool") {
      sawTool = true; setPhase(phaseForTool(e.name, e.detail)); paintHud();
      if (!thoughts) { thoughts = createThoughts(); streamEl.after(thoughts.el); } // window sits below the answer
      thoughts.step(e.name, e.detail);
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
      // P-EGRESS.1: egress approvals dock directly above the prompt bar; normal tool prompts stay inline.
      if (e.egress) egressDock().appendChild(card.el);
      else { hud.before(card.el); scrollChat(); }
    }
    else if (e.type === "block") onBlock(e);
    else if (e.type === "usage") { tok = e.used; cost = e.cost; state.liveUsage = { used: e.used, size: e.size, cost: e.cost }; paintHud(); renderStatus(); renderMetricsRail(); }
    else if (e.type === "done") { if (e.text && e.text.length > buf.length) buf = e.text; /* reconcile a lossy stream with the server's full reply */ streamEl.innerHTML = renderMarkdown(buf); enhanceCodeBlocks(streamEl); (node as MsgNode)._md = buf; finishHud(); state.streaming = false; setSendEnabled(); }
  };
  try { await bridge.sendPrompt(text, onEvent); }
  finally {
    (node as MsgNode)._md = buf;
    if (state.streaming) { streamEl.innerHTML = renderMarkdown(buf); enhanceCodeBlocks(streamEl); finishHud(); state.streaming = false; setSendEnabled(); } else { finishHud(); }
    void renderSessions(); void refreshBudget(false); void syncMode();
    scheduleKnowledgeRefresh(); // #54 follow-up: new facts appear in the open KG without close/reopen
    // P-ACP.4: the turn ended — fire off any pre-staged prompt now (the composer is idle again).
    if (state.queued) { const q = state.queued; state.queued = null; renderQueued(); const ta2 = $("#input") as HTMLTextAreaElement; ta2.value = q; setSendEnabled(); void send(); }
  }
}

function onBlock(e: Extract<ChatEvent, { type: "block" }>): void {
  // A generic tool rejection (omp couldn't run a call for non-security reasons) is NOT a
  // security event - show a quiet, neutral chip and stop. Only the gate's authoritative
  // quarantine (quarantined !== false) gets the loud treatment + Security-panel review.
  if (e.quarantined === false) {
    addEvent(`<div class="evt" data-tip="Tool call did not run">${icon("close", 14)}<span><b>${esc(e.tool)}</b> · ${esc(e.reason)}</span></div>`);
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
    btn.disabled = !ta.value.trim();
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
  // P-IDE.1d: compact, subdued, right-aligned pill — a small "Queued" tag, the prompt preview, and a
  // delete (✕) that removes the pre-staged prompt before it sends.
  chip.innerHTML = `<div class="q-pill" data-tip="Sends automatically when the current turn ends"><span class="q-label">Queued</span><span class="q-text"></span><button class="q-cancel" data-tip="Delete queued prompt">${icon("close", 12)}</button></div>`;
  ($(".q-text", chip) as HTMLElement).textContent = state.queued.slice(0, 90);
  ($(".q-cancel", chip) as HTMLElement).addEventListener("click", () => { state.queued = null; renderQueued(); ($("#input") as HTMLTextAreaElement)?.focus(); });
}
/** P-ACP.4: Stop — interrupt the running turn. omp's session/cancel ends the turn, so the streaming
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
  // Do NOT route through setInspectorRail() here — its ADR-0021 active-blocks override would hijack the
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
function renderMetricsRail(): void {
  const tiles = $("#railTiles");
  if (!tiles) return;
  const s = state.memory?.session, lu = state.liveUsage, sec = state.security;
  const cur = lu ? lu.used : (s?.current ?? 0);
  const turns = s?.turns ?? 0;
  const hit = s?.cache.hit ?? 0;
  const avg = turns ? Math.round(cur / turns) : 0;
  const findings = sec ? sec.findings.reduce((a, r) => a + Number(r.n || 0), 0) : 0;
  const quar = sec ? sec.quarantine.length : 0;
  const ca = state.codeActivity; // ADR-0030 P-CODE.1: this month's repo activity
  const tile = (n: string, label: string, cls: string, tip: string) =>
    `<div class="tile ${cls}" data-tip="${esc(label)}|${esc(tip)}" data-tip-side="left"><div class="n">${esc(n)}</div><div class="l">${esc(label)}</div></div>`;
  tiles.innerHTML =
    tile(`${Math.round(hit * 100)}%`, "savings", "g", "How much the prompt cache saves you. The AI re-reads the same background every turn; that repeated part is billed at about one-tenth the price - roughly 90% off. This is how much of this turn was that cheap repeat, so a higher number means a smaller bill.") +
    tile(fmtNum(avg), "avg/turn", "c", "Average tokens per turn") +
    tile(fmtNum(cur), "context", "b", "Context tokens in use this turn") +
    tile(String(turns), "turns", "b2", "Agent turns in this session") +
    (ca && ca.totals.files > 0 ? tile(`+${fmtNum(ca.totals.added)}`, "lines", "g", `Workspace activity this month (${ca.month}): ${fmtNum(ca.totals.added)} lines added, ${fmtNum(ca.totals.deleted)} deleted across ${fmtNum(ca.totals.files)} files. This is REPO activity (all commits), not AI-authored lines.`) : "") +
    tile(String(findings), "findings", "m", "Scanner findings so far") +
    tile(String(quar), "quarantd", "r", "Artifacts currently quarantined");
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
  openai: "OAuth signs in your ChatGPT / Codex subscription (those models). For the full commercial catalog - gpt-4o, o-series - add an OPENAI_API_KEY below.",
  google: "OAuth uses the Gemini CLI / Code Assist tier. For the full commercial Gemini catalog, add a GEMINI_API_KEY below.",
  perplexity: "Paste a Perplexity API key for Sonar models. (Pro/Max OAuth is interactive email-OTP - it can't run through this app, so use a key here.)",
};
function provCard(p: ProviderAuth): string {
  const last4 = esc(p.keyLast4 ?? "");
  const status =
    (p.oauthActive ? `<span class="abadge ok">${icon("check", 11)} OAuth active</span>` : "") +
    (p.keySet ? `<span class="abadge set">key ••${last4}</span>` : "") +
    (!p.oauthActive && !p.keySet ? `<span class="abadge none">not set</span>` : "");
  const hint = PROV_HINTS[p.id] ? `<div class="prov-hint">${icon("info", 11)} ${PROV_HINTS[p.id]}</div>` : "";
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
// AskSage monthly tokens — fully dynamic from the Civ API (no manual limit). `used` is this
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
function promptForEmailIfMissing(): void {
  if (state.attribution?.decided || document.getElementById("emailGate")) return;
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
    if (state.attribution?.source === "email") showToast({ title: "Email saved", desc: `Code activity will be attributed to ${em}.`, timeout: 2600 });
    else { err.textContent = "That email was rejected by your organization's policy."; err.hidden = false; promptForEmailIfMissing(); }
  };
  const skip = async () => {
    apply(await bridge.skipEmail().catch(() => null));
    showToast({ title: "Using workstation name", desc: `Code activity will be attributed to ${state.attribution?.identity ?? ws}. Add an email anytime in Settings.`, timeout: 3200 });
  };
  $("#emailGateSave", ov)!.addEventListener("click", () => void save());
  $("#emailGateSkip", ov)?.addEventListener("click", () => void skip());
  input.addEventListener("input", () => { err.hidden = true; });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } });
  setTimeout(() => input.focus(), 30);
}

function secProfile(s: { username: string; email?: string; attribution?: import("./bridge.ts").ProfileSettings["attribution"] } | null): string {
  const a = s?.attribution;
  const managedLine = a?.managed
    ? `<div class="set-note">${icon("shield", 12)} Managed by <b>${esc(a.orgName || "your organization")}</b>${a.requireEmail ? " - a corporate email is required" : ""}${a.allowedDomains?.length ? ` (${a.allowedDomains.map((d) => "@" + esc(d)).join(", ")})` : ""}.</div>`
    : "";
  const idLine = a
    ? `<div class="set-note ${a.source === "email" ? "ok" : ""}">${icon(a.source === "email" ? "check" : "info", 12)} Code activity is attributed to <b>${esc(a.identity)}</b>${a.source === "workstation" ? " (this workstation - add an email above to attribute to you)" : ""}.</div>`
    : `<div class="set-note">${icon("info", 12)} Your email tags how much code each model wrote, per repo (ADR-0030). Stored on this machine only.</div>`;
  return setCard("profile", "Profile", "", `<div class="prov-row"><input id="setUsername" class="prov-key" placeholder="Your name" value="${esc(s?.username ?? "")}" /></div>
    <div class="prov-row"><input id="setEmail" class="prov-key" type="email" inputmode="email" autocomplete="email" placeholder="Corporate email (optional - for code-activity attribution)" value="${esc(s?.email ?? "")}" />
      <button class="btn-mini ok" id="saveUsername">${icon("check", 12)} Save</button></div>
    ${managedLine}${idLine}`, false);
}
function secProviders(auth: import("./bridge.ts").AuthStatus | null): string {
  return setCard("providers", "Providers", "key or OAuth · majors first",
    (auth?.majors ?? []).map(provCard).join("") || `<div class="empty">couldn't read auth - is the server up to date?</div>`, false);
}
// P-IDE.1c (ADR-0029): data-sovereignty unlock for China-origin models. Renders ONLY when omp actually
// exposes such a model (else an empty, preserved anchor). Hidden-by-default; the user must type
// ACKNOWLEDGE after the warning to list them — they route outside U.S. jurisdiction (no data sovereignty).
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
  const body = `<div class="prov-row"><input id="asksageBase" class="prov-key" placeholder="https://api.civ.asksage.ai/server" value="${esc(a?.base ?? "")}" />
      <button class="btn-mini ok" id="asksageSaveBase">${icon("check", 12)} Save URL</button></div>
    <label class="set-toggle"><input type="checkbox" id="asksageOnly" ${checked} ${locked ? "disabled" : ""}/>
      <span><b>AskSage-only (lockdown)</b> - route every turn through the gov gateway and hide direct providers in the model picker.</span></label>
    ${managedNote}
    ${locked || a?.only ? datasetsSection(datasets) : ""}
    ${a?.configured ? `<div class="set-note ok">${icon("check", 12)} Gov gateway active - AskSage models appear in the picker, with monthly-usage and scanned personas.</div>` : `<div class="set-note">${icon("info", 12)} Add an <code>ASKSAGE_API_KEY</code> in Providers to enable gov models, usage, and personas.</div>`}`;
  return setCard("asksage", "AskSage gov gateway", "accredited proxy", body, true);
}
// The AskSage Monthly-tokens bar, rendered into the `asksageQuota` slot ABOVE Providers — but only
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
function secOthers(auth: import("./bridge.ts").AuthStatus | null): string {
  return setCard("others", "More providers", "", (auth?.others ?? []).map(provCard).join("") || `<div class="empty">none</div>`, true);
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

function settingsShell(): string {
  return [
    `<div data-sec="workspace"></div>`,
    // Profile is just the local name we already hold in state - render it instantly (no skeleton /
    // no fetch wait; the first /api/settings call pays a ~0.6s cold cost that made this lag).
    secProfile({ username: state.username, email: state.email, attribution: state.attribution ?? undefined }),
    setSkel("personal", "Personalization", "private · encrypted · opt-in", true),
    `<div data-sec="asksageQuota"></div>`, // AskSage Monthly-tokens bar — sits directly above Providers, ONLY when the gov gateway is configured (filled in hydrateSettings)
    setSkel("providers", "Providers", "key or OAuth · majors first"),
    setSkel("asksage", "AskSage gov gateway", "accredited proxy", true),
    `<div data-sec="sovereignty"></div>`, // P-IDE.1c: China-origin unlock (renders only when such models exist)
    setSkel("compression", "Token compression", "headroom · on-device · opt-in", true),
    setSkel("mcp", "MCP connectors", "model context protocol", true),
    setSkel("others", "More providers", "", true),
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
  void bridge.auth().then((a) => { fillSec("providers", secProviders(a)); fillSec("others", secOthers(a)); });
  fillSec("sovereignty", secSovereignty()); // P-IDE.1c: only renders a card when China-origin models exist
  void bridge.headroom().then((h) => fillSec("compression", secCompression(h)));
  fillSec("developer", secDeveloper()); // ADR-0059: render from state.developerMode (loaded by loadDev)
  void hydratePersonal();
  hydrateMcp();
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

// P-IMP.2 (ADR-0035): open Settings with the Personalization section expanded + scrolled into view —
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
let kgData: PersonalGraphData | null = null;
let kgLens: "kind" | "trust" = "kind";
let kgOpen = false;
let kgSelId: string | null = null;
let kgSig = ""; // signature of the last-rendered graph, to skip no-op live refreshes
const forgettingIds = new Set<string>(); // in-flight "forget" fact ids — de-dups mashed clicks (#113)
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
  $("#kgRelate")?.classList.toggle("on", on);
  const bar = $("#kgRelateBar"); if (bar) (bar as HTMLElement).hidden = !on;
  if (!on) onRelatePick([]);
}

/** Cheap change-signature for the graph (node/edge ids + counts + fact total). */
function kgSignature(d: PersonalGraphData | null): string {
  if (!d) return "";
  return `${d.nodes.map((n) => `${n.id}:${n.count}`).join("|")}#${d.edges.map((e) => `${e.from}>${e.to}`).join("|")}#${d.facts?.length ?? 0}`;
}

/** Live-refresh the open KG without a full remount: merge new facts/edges into the running
 *  simulation (positions preserved). No-op if the panel is closed or nothing changed. */
async function refreshKnowledgeLive(): Promise<void> {
  if (!kgOpen || !kgHandle) return;
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
  if (!state.sidebarCollapsed) toggleSidebar(true); // give the chat room; reopen sessions via the hamburger
  $("#knowledge")!.hidden = false;
  $("#inspector")!.hidden = true;
  $$(".rail-btn").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.rail === "knowledge"));
  void renderKnowledge();
}
function closeKnowledge(): void {
  if (!kgOpen) return;
  kgOpen = false;
  if (kgRelateMode) setRelateMode(false); // leave relate mode clean for next open
  kgHandle?.destroy(); kgHandle = null;
  $("#knowledge")!.hidden = true;
  $("#inspector")!.hidden = false;
  $$(".rail-btn").forEach((b) => b.classList.remove("active"));
  $('.rail-btn[data-rail="chat"]')?.classList.add("active");
}
async function renderKnowledge(): Promise<void> {
  const canvas = $("#kgCanvas"), side = $("#kgSide"), scopeLbl = $("#kgScopeLbl");
  if (!canvas || !side) return;
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
  const gate = (msg: string) => { canvas.innerHTML = `<div class="kg-empty">${icon("graph", 30)}<div>${msg}</div></div>`; (side as HTMLElement).hidden = true; side.innerHTML = ""; };
  if (!status?.enabled) return gate("Personalization is off. Enable it in Settings to build a knowledge graph.");
  if (!status.unlocked) {
    // Configured-but-locked → unlock right here (no trip to Settings). Not yet set up → Settings.
    if (status.configured) return renderKgLocked(canvas as HTMLElement);
    return gate("Personalization isn't set up yet. Create a passphrase in Settings to start your private graph.");
  }
  try { kgData = await bridge.personalGraph(); }
  catch { return gate("Couldn't decrypt your graph. Try reopening this panel."); }
  if (!kgData || kgData.nodes.length === 0) return gate("Nothing learned yet. It remembers durable facts about <b>you</b> - not what we discuss. Tell me things like <i>“I prefer Rust”</i>, <i>“I use vim”</i>, <i>“I decided to go with Postgres”</i>, or <i>“remember that I deploy with Kubernetes”</i> and they'll appear here (each is security-scanned first).");
  (side as HTMLElement).hidden = true; side.innerHTML = ""; // appears only when a node is clicked
  kgHandle = mountGraph(canvas as HTMLElement, kgData, (id) => renderKgSide(id), { onRelate: relateNodes, onRelatePick: onRelatePick });
  if (kgRelateMode) { kgHandle.setRelateMode(true); onRelatePick([]); } // preserve relate mode across a live remount
  kgHandle.setLens(kgLens);
  kgSig = kgSignature(kgData); // baseline so live refreshes only fire on real changes
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
  side.innerHTML = `<div class="kg-side-head"><span class="kg-side-kind" style="background:${kindTint(node.kind)}">${esc(kindLabel(node.kind))}</span><b>${esc(node.name)}</b></div>
    <div class="kg-side-facts">${rows || `<div class="empty">No active facts.</div>`}</div>`;
}
const kindTint = (k: string): string => {
  const c: Record<string, string> = { preference: "var(--cyan-dim)", interest: "var(--green-dim)", decision: "var(--blue-dim)", behavior: "var(--amber-dim)", personality: "var(--accent-dim)" };
  return c[kindLabel(k)] ?? "var(--bg-3)";
};

// #115: a successful export used to flash its location for a few seconds, then it was gone. Keep the toast
// up (when there's a real path) and offer Copy path — plus Open folder in the desktop app — so the
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
async function resumeSession(id: string): Promise<void> {
  closeSettings();
  const msgs = await bridge.sessionMessages(id);
  $("#thread")!.innerHTML = "";
  if (msgs && msgs.length) for (const m of msgs) addMessage(m.role === "user" ? "user" : "assistant", m.text);
  else seedThread();
  $$(".sess").forEach((s) => s.classList.toggle("active", (s as HTMLElement).dataset.sid === id));
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
  let h = secIntro();
  // ADR-0021: pulse the metric chip that requires triage - quarantined gets red shimmer,
  // awaiting-review gets amber shimmer, only when there are active items in that category.
  const qCount = quarantine.length + live.quarantined.length;
  const aCount = approvals.length;
  h += chips([
    { cls: "q" + (qCount > 0 ? " alert" : ""), n: qCount, l: "quarantined" },
    { cls: "a" + (aCount > 0 ? " alert alert-amber" : ""), n: aCount, l: "awaiting review" },
    { cls: "f", n: totFind, l: "findings" },
    { cls: "g", n: promoted, l: "promoted facts" },
  ]);
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
  h += accordion("sec.quarantine", "Quarantine review", "isolated · fail-closed",
    table([{ key: "artifact_id", label: "artifact", mono: true }, { key: "source", label: "source" }, { key: "trust_label", label: "trust", pill: true }, { key: "risk_score", label: "risk", mono: true }], quarantine),
    OPEN.has("sec.quarantine"), String(quarantine.length));
  h += accordion("sec.approvals", "Approval queue", "blocked · awaiting a human",
    table([{ key: "artifact_id", label: "artifact", mono: true }, { key: "source", label: "source" }, { key: "trust_label", label: "trust", pill: true }, { key: "verdict", label: "verdict", pill: true }], approvals)
    + (approvals.length ? `<div class="row-actions"><button class="btn-mini ok" data-act="approve">${icon("check", 14)} Approve</button><button class="btn-mini danger" data-act="deny">${icon("close", 14)} Deny</button></div>` : ""),
    OPEN.has("sec.approvals"), String(approvals.length));
  h += accordion("sec.findings", "Findings overview", "by type · severity · source",
    table([{ key: "finding_type", label: "type" }, { key: "severity", label: "sev", pill: true }, { key: "source", label: "source" }, { key: "n", label: "n", mono: true }], findings),
    OPEN.has("sec.findings"));
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
// Format an ISO/epoch timestamp as US Eastern time (auto EST/EDT) — "Jun 24, 3:45 PM EDT".
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
  h += chips([
    { cls: "f", n: tel.length, l: "events" },
    { cls: "g", n: runs.length, l: "runs" },
    { cls: "g", n: turns.length, l: "turns" },
    { cls: "q", n: blk.length, l: "live blocks" },
    { cls: "a", n: exp.length, l: "exports" },
    ...(ask.length ? [{ cls: askAnoms ? "q" : "g", n: ask.length, l: "AskSage calls" } as const] : []),
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
  // P-LOC.2 (ADR-0031): the AI-authored code counterpart to the cost ledger — lines the AI wrote,
  // per model/repo, attributed to the identity. Counted at the gate (ADR-0031), not git (ADR-0030).
  if (d?.aiLoc) h += accordion("mem.ailoc", "AI-authored code", `+${fmtNum(d.aiLoc.totals.added)} / −${fmtNum(d.aiLoc.totals.removed)} lines`, aiLocBody(d.aiLoc), OPEN.has("mem.ailoc"), `${d.aiLoc.totals.models}`);
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

// P-LOC.2 (ADR-0031): AI-authored code body — a summary card + a per-model table + a per-repo/
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
// Honest label — this is REPO activity (all commits), NOT AI authorship (AGENTS.md #10).
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

/** Provider keywords for the active model, so we can highlight the budget that
 *  actually governs the next turn. */
function providerKeywords(model: string): string[] {
  const m = model.toLowerCase();
  if (m.includes("claude") || m.includes("anthropic")) return ["claude", "anthropic"];
  if (m.includes("gpt") || m.includes("openai") || /\bo[0-9]/.test(m)) return ["openai", "gpt"];
  if (m.includes("gemini") || m.includes("google")) return ["gemini", "google"];
  if (m.includes("grok") || m.includes("xai")) return ["grok", "xai"];
  if (m.includes("deepseek")) return ["deepseek"];
  return [m.split(/[-/]/)[0] ?? m];
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
  const cost = lu ? lu.cost : (s?.cost ?? 0);
  const hit = s?.cache.hit ?? 0;
  const budget = m?.budgets?.[0];
  const ago = state.lastOk ? Math.round((Date.now() - state.lastOk) / 1000) : null;
  $("#statusbar")!.innerHTML = `
    <div class="seg" data-tip="Active model|Click the badge to change">${icon("spark", 14)} <b>${esc(modelLabel(state.model))}</b></div>
    <div class="seg" data-tip="Context window|How full the model's context is${lu ? " (live this session)" : ""}">${icon("brain", 14)}
      <span class="mini"><span class="fill" style="width:${Math.round(ctx * 100)}%;background:${loadColor(ctx)}"></span></span>
      <b>${fmtNum(curTok)}</b>/${fmtNum(winTok)}</div>
    <div class="seg" data-tip="Prompt-cache hit rate|Share of input served from cache at the discounted rate - higher means lower cost per turn">${icon("bolt", 14)} cache <b style="color:${goodColor(hit)}">${Math.round(hit * 100)}%</b></div>
    ${budget ? `<div class="seg seg-btn${budget.used >= 0.9 ? " warn" : ""}" data-budget-refresh data-tip="${esc(budget.label)} usage|${budget.used >= 0.9 ? "Almost spent - turns may start stalling. " : ""}Click to re-check now · auto every 5 min. omp's last-seen value, so it can lag the official usage.">${esc(budget.label)} <b style="color:${loadColor(budget.used)}">${Math.round(budget.used * 100)}%</b> ${icon("refresh", 11)}</div>` : ""}
    ${asksageChip()}
    <div class="seg" data-tip="Session cost">${fmtUSD(cost)}</div>
    <div class="right">
      <div class="seg" data-tip="Security gate|In-process, fail-closed">${icon("shield", 13)} gate active</div>
      <div class="seg seg-live"><span class="live-dot"></span> ${ago == null ? "connecting…" : ago < 2 ? "live" : `updated ${ago}s ago`}</div>
    </div>`;
}

// ───────────────────────── data polling ─────────────────────────
async function refresh(): Promise<void> {
  try {
    const [sec, mem, led, code] = await Promise.all([bridge.security(), bridge.memory(), bridge.usage(), bridge.codeActivity()]);
    state.security = sec; state.memory = mem; state.ledger = led; state.codeActivity = code;
    // Keep the developer Logs panel live (AskSage tool calls, transcripts) while it's the open tab —
    // otherwise its data only refreshed on tab-switch and looked stale mid-turn.
    if (state.developerMode && state.inspectorTab === "dev") { try { state.dev = await bridge.dev(); } catch { /* keep last */ } }
    checkBudgetWarning(mem?.budgets); // early heads-up before a provider budget runs out
    // the badge reflects the live session CONFIG model (loadConfig), not the
    // historical snapshot - so it shows what the next turn will actually use.
    state.lastOk = Date.now();
    // Security rail badge: number of items AWAITING YOUR REVIEW (quarantined/suspicious
    // content the gate flagged). Hidden when there's nothing to act on; coloured by the
    // worst trust label in the queue (quarantined = red, suspicious-only = amber).
    const approvals = sec?.approvals ?? [];
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
/** Update the composer's quick agent-controls (model · mode · thinking) labels. */
function updateComposerTools(): void {
  const model = state.config.find((c) => c.id === "model");
  const think = state.config.find((c) => c.id === "thinking");
  const set = (sel: string, v: string) => { const e = $(sel); if (e) e.textContent = v; };
  if (model) set("#ctModelName", modelLabel(model.currentValue));
  set("#ctModeName", state.uiMode === "ask" ? "Ask" : state.uiMode === "plan" ? "Plan" : "Agent");
  if (think) { const cur = think.options.find((o) => o.value === think.currentValue); set("#ctThinkName", prettyLevel(cur?.name ?? think.currentValue)); }
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

// P-IDE.2 (ADR-0029): skills come from TWO sources behind one picker — BUNDLED (skills.ts, trusted
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
/** Bundled skill: activate it — its trusted guidance rides the next user turn until cleared. */
async function activateBundledSkill(command: string): Promise<void> {
  const s = INSTALLED_SKILLS.find((x) => x.command === command); if (!s) return;
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
      blocked.length ? `${blocked.length} flagged by the security gate — review in the Security panel.` : ""].filter(Boolean).join(" "),
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
// P-GOAL.8.1: skills NOT offered for a goal loop — meta/planning/self-referential ones that don't help
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
          <summary>${icon("spark", 13)} Engineering Update <span class="goal-opt">an exec brief + podcast from this run</span> ${goalInfoDot("Why an Engineering Update|As the goal loop runs round after round, the ADRs, run-logs and decisions pile up, and a tired reader starts to tune out. This curated executive brief and podcast mitigates Cognitive Surrender and Information Overload, surfacing the signal in the noise during orchestration looping: what shipped, what is load-bearing, the tech debt, and the decisions that need you.")}</summary>
          <div class="goal-eu-body">
            <div class="goal-row"><label class="goal-lbl">Audio</label>
              <select id="euProvider" class="prov-key">
                <option value="script-only">Script only (no audio)</option>
                <option value="local-tts">Local TTS — Kokoro (air-gap)</option>
              </select>
            </div>
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
  // click pins it. Safe to call before the async stats load — it no-ops until the panel exists.
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
    return { goal, command, maxIters, budgetUsd, criteria: adoptedCriteria || undefined }; // P-GOAL.12: matured checker criteria
  };
  // P-GOAL.6.1: live token estimate (lower-left), recomputed as the iteration count changes.
  ($("#goalMax", ov) as HTMLInputElement)?.addEventListener("input", () => updateGoalEstimate(ov));
  updateGoalEstimate(ov); // initial; model names fill in once loadCheckerModel resolves
  render(); // P-GOAL.8: apply guided/advanced mode + show the right step/buttons
  wireCmdSuggest(ov); // P-GOAL.8.1: custom verify-command type-ahead
  // P-BRIEF.3 (ADR-0072): the Engineering Update accordion — the audio-provider choice persists; Generate
  // fetches the curated brief from the repo's logs and renders it inline (audio backend is a later slice).
  const euProv = $("#euProvider", ov) as HTMLSelectElement | null;
  if (euProv) {
    euProv.value = localStorage.getItem("lucid.euProvider") || "script-only";
    euProv.addEventListener("change", () => localStorage.setItem("lucid.euProvider", euProv.value));
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
      const audioNote = euProv?.value === "local-tts"
        ? `<div class="goal-opt">Audio: point a local TTS endpoint (Kokoro) at the app to render the podcast — the two-host script is ready.</div>`
        : "";
      out.innerHTML = counts + audioNote + renderMarkdown(data.brief);
    } finally { btn.disabled = false; btn.innerHTML = prev; }
  });
  $("#goalRun", ov)?.addEventListener("click", async () => {
    const { goal, command, maxIters, budgetUsd, criteria } = readSpec();
    if (!goal) { showToast({ tone: "warn", title: "Add a goal", desc: "Describe what the loop should accomplish.", timeout: 2400 }); return; }
    await applyRunWith(ov); // P-GOAL.7: apply base model / thinking / skill / persona for this run
    close();
    void runGoalLoop({ goal, condition: command || goal, command: command || undefined, maxIters, budgetUsd, criteria });
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
  // Base model — the maker. Options come from the session model config; changing it sets the session.
  const modelOpt = state.config.find((c) => c.id === "model");
  const modelSel = $("#goalModel", ov) as HTMLSelectElement | null;
  if (modelSel && modelOpt) {
    let opts = (modelOpt.options ?? []).filter((o) => !isAuxiliaryModel(o.value) && !/(^|[/-])rag$/i.test(o.value));
    // P-GOAL.8: under AskSage lockdown the base model must be AskSage-routed too — restrict to those, and
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
  // Thinking — only if the provider exposes it. Applied at Run time.
  const thinkOpt = state.config.find((c) => c.id === "thinking");
  const thinkSel = $("#goalThink", ov) as HTMLSelectElement | null;
  if (thinkSel && thinkOpt?.options?.length) {
    ($("#goalThinkWrap", ov) as HTMLElement).hidden = false;
    thinkSel.innerHTML = thinkOpt.options.map((o) => `<option value="${esc(o.value)}">${esc(prettyLevel(o.name))}</option>`).join("");
    thinkSel.value = thinkOpt.currentValue ?? "";
  }
  // Skill — None + only the bundled skills that suit a goal loop (build/verify-oriented; meta ones like
  // Goal Loop / Loop Engineering / Plan are excluded). Trusted guidance that rides every loop turn.
  const skillSel = $("#goalSkill", ov) as HTMLSelectElement | null;
  if (skillSel) {
    const loopSkills = bundledSkillsByUsage().filter((s) => !GOAL_SKILL_DENY.has(s.command));
    skillSel.innerHTML = `<option value="">None</option>` + loopSkills.map((s) => `<option value="${esc(s.command)}">${esc(s.name)}</option>`).join("");
    skillSel.value = GOAL_SKILL_DENY.has(state.activeSkill?.command ?? "") ? "" : (state.activeSkill?.command ?? "");
  }
  // Persona — only if AskSage personas are available. Show the human name/description, not the numeric id.
  const personaSel = $("#goalPersona", ov) as HTMLSelectElement | null;
  if (personaSel && state.personas.length) {
    ($("#goalPersonaWrap", ov) as HTMLElement).hidden = false;
    personaSel.innerHTML = `<option value="">None</option>` + state.personas.map((p) => `<option value="${esc(p.id)}">${esc(personaTitle(p.description, p.id))}</option>`).join("");
    personaSel.value = state.asksage?.persona ?? "";
  }
}

// P-GOAL.7: apply the "Run with" selections to the session right before a loop runs — base model +
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

// P-GOAL.6.1 / P-GOAL.7 (ADR-0048/0049): the live cost estimate at the modal's lower-left — tokens AND a
// cache-rationalized dollar figure for the SELECTED base + checker models. Updates as iterations / models
// change; the premium tooltip (data-tip) explains the assumptions. The number is a CEILING — a loop
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

// P-GOAL.5 (ADR-0047): render the saved-automations list inside the goal modal — each row shows its
// cadence + last-run status, with an enable toggle, a run-now button, and delete.
// P-GOAL.10 (ADR-0055): render the cross-run evaluation banner from the run-log ledger — success rate,
// average iterations-to-success, the most-common blocker, and a tool-mix bar. Hidden until there's
// history (a first-time user sees nothing extra).
async function loadLoopStats(ov: HTMLElement): Promise<void> {
  const sec = $("#goalStatsSec", ov); if (!sec) return;
  const data = await bridge.loopRunStats().catch(() => null);
  const s = data?.stats;
  if (!s || s.runs === 0) { sec.innerHTML = ""; return; }
  const pct = Math.round(s.successRate * 100);
  const tone = pct >= 75 ? "ok" : pct >= 40 ? "mid" : "low";
  const iters = s.avgItersToSucceed ? `${s.avgItersToSucceed.toFixed(1)}` : "—";
  const dur = s.avgDurationMs ? formatLoopDur(s.avgDurationMs) : "—";
  const blocker = s.topBlockers[0];
  const spend = s.totalSpendUsd > 0 ? `<span class="gs-tool">spend <b>$${s.totalSpendUsd.toFixed(2)}</b></span>` : "";
  const mix = spend + Object.entries(s.toolsByType).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([k, v]) => `<span class="gs-tool">${esc(k)} <b>${v}</b></span>`).join("");
  sec.innerHTML = `<div class="goal-stats" data-tone="${tone}">
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

/** Compact duration for the eval banner (mirrors loop_report.formatDuration, kept local to the renderer). */
function formatLoopDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// P-GOAL.12 (ADR-0057): the Pre-Flight Audit — pause the builder, design the loop (scope + a short
// prompt-engineering interview + user/PO + engineer feedback), fold in past-run history, and produce a
// readiness-scored Loop Design report the user adopts as the goal (its criteria thread to the checker).
async function openPreflight(goalOv: HTMLElement): Promise<void> {
  const g = ($("#goalGoal", goalOv) as HTMLTextAreaElement)?.value.trim() ?? "";
  const cmd = ($("#goalCmd", goalOv) as HTMLInputElement)?.value.trim() ?? "";
  const ov = el(`<div class="scrim preflight-scrim"><div class="preflight-modal">
    <div class="goal-modal-h"><span class="goal-h-title">${icon("shield", 15)} Pre-Flight Audit</span><button type="button" class="btn-mini" id="pfClose">Close</button></div>
    <div class="goal-modal-sub">Design the loop before you build it — scope it, answer a few questions, fold in user/engineer feedback and past-run history, then adopt a readiness-scored Loop Design as your goal.</div>
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

  // scope picker — branches + worktrees (best-effort; falls back to "current workspace")
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
    if (!last) { res.innerHTML = `<div class="pf-loading">Audit failed — check the model/connection and try again.</div>`; return; }
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
      showToast({ tone: "ok", title: "Adopted into the goal", desc: "Tweak it in the Goal field, then Run — the checker will grade against your criteria.", timeout: 3400 });
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
async function runGoalLoop(
  opts: { goal: string; condition: string; command?: string; maxIters: number; resume?: string; budgetUsd?: number; criteria?: string },
  stream?: (onEvent: (e: ChatEvent) => void) => Promise<void>, // P-GOAL.5: automation run-now reuses this renderer
  verb = "/goal",
): Promise<void> {
  if (state.streaming) { showToast({ tone: "warn", title: "A turn is running", desc: "Wait for it to finish before starting a loop.", timeout: 2400 }); return; }
  if (!autoCollapsedSessions) { autoCollapsedSessions = true; if (!state.sidebarCollapsed) toggleSidebar(true); }
  state.lastPrompt = opts.goal;
  addMessage("user", `${verb}${opts.resume ? " (resume)" : ""}: ${opts.goal}${opts.command ? `\nverify: \`${opts.command}\`` : ""}  ·  up to ${opts.maxIters} iterations`);
  state.streaming = true; goalLoopRunning = true; setSendEnabled();
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
      // P-GOAL.9: the loop's last task — an After-Action Report (metrics + portable graphs). The durable
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
  for (const s of bundledSkillsByUsage()) out.push({ label: s.name, hint: s.description, kind: "bundled", activate: s.command, uses: uses[s.command] ?? 0 });
  for (const s of state.skills) out.push({ label: `/skill:${s.name}`, hint: s.description || s.source, kind: "project", complete: `/skill:${s.name} `, uses: 0 });
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
  const m = /^\/(\S*)$/.exec(ta.value); // the whole input is a single "/…" token (no space yet)
  if (!m || state.streaming) { closeSlashAC(); return; }
  slashItems = filterSlash(m[1]);
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
  if (it.activate === "goal") { ta.value = ""; autosize(ta); setSendEnabled(); openGoalForm(); return; } // /goal is the REAL loop primitive (P-GOAL.1)
  if (it.activate) { void activateBundledSkill(it.activate); ta.value = ""; } // built-in skill rides the next turn
  else if (it.complete) { ta.value = it.complete; }                          // command / project skill: finish typing args
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
      <label class="skill-drop" id="skillDrop" data-tip="Drop .md skill files — each is scanned at the security gate before import"><input type="file" id="skillDropInput" accept=".md,text/markdown" multiple hidden>${icon("download", 13)} <span>Drop <code>.md</code> skills here — scanned at the gate</span></label>
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
  // P-SKILL.1: drag-and-drop (or click-to-pick) .md skill import — scanned at the gate server-side.
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

function wire(): void {
  // rail
  $$(".rail-btn[data-rail]").forEach((b) => b.addEventListener("click", () => {
    const r = (b as HTMLElement).dataset.rail!;
    if (r !== "knowledge") closeKnowledge();
    if (r === "security" || r === "memory") focusInspector(r);
    else if (r === "dev") { focusInspector("dev"); void loadDev(); } // ADR-0009 Phase D
    else if (r === "chat") { closeSettings(); $("#input")?.focus(); $$(".rail-btn").forEach((x) => x.classList.toggle("active", x === b)); }
    else if (r === "settings") openSettings();
    else if (r === "knowledge") openKnowledge();
    else palette.show();
  }));
  // Knowledge graph: close, lens toggle, forget-fact, export (P9.4)
  $("#kgClose")!.addEventListener("click", () => closeKnowledge());
  $("#kgImport")!.addEventListener("click", async () => {
    const folder = await openFolderBrowser({ title: "Choose your ChatGPT / Claude / Gemini export", confirm: "Import from here" });
    if (!folder) return;
    // Read-only pre-import estimate → warn about AI-mode token cost + runtime before the paid run.
    const est = await bridge.personalImportEstimate(folder);
    if (!est?.ok) { showToast({ tone: "danger", title: "Couldn't read that export", desc: est?.error ?? "No conversations found in that export.", actions: [{ label: "OK" }], timeout: 6000 }); return; }
    // First import (empty graph) defaults to AI extraction (best quality); after that, honor the box.
    const status = await bridge.personal();
    const totalFacts = status?.counts ? status.counts.work + status.counts.personal + status.counts.cui : 0;
    const aiDefault = totalFacts === 0 ? true : (($("#kgImportAI") as HTMLInputElement | null)?.checked ?? false);
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
  });
  $("#kgExport")!.addEventListener("click", async () => {
    showToast({ title: "Exporting vault…", desc: "Decrypting and writing your Obsidian notes.", timeout: 1400 });
    const r = await bridge.personalExportVault({});
    if (!r?.ok) showToast({ tone: "danger", title: "Vault not exported", desc: r?.error ?? "Personalization is off or locked.", actions: [{ label: "OK" }], timeout: 5000 });
    else showExportToast("Vault exported", `${r.files} files · ${r.entities} notes · ${r.facts} facts · Personal + Work · CUI excluded by design · audited`, r.dest);
  });
  $("#kgCui")!.addEventListener("click", () => {
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
  });
  $("#knowledge")!.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const lens = t.closest("[data-lens]") as HTMLElement | null;
    if (lens) { kgLens = lens.dataset.lens as "kind" | "trust"; kgHandle?.setLens(kgLens); $$("[data-kg-lens] button").forEach((x) => x.classList.toggle("on", x === lens)); return; }
    if (t.closest("#kgRelate")) { setRelateMode(!kgRelateMode); return; } // P-KG-REL.1 toggle relate mode
    if (t.closest("#kgRelateDo")) { void relatePicked(); return; }
    if (t.closest("#kgRelateClear")) { kgHandle?.clearRelatePicks(); return; }
    const forget = t.closest("[data-forget]") as HTMLElement | null;
    if (forget) {
      const fid = forget.dataset.forget!;
      if (forgettingIds.has(fid)) return; // de-dup: ignore mashed clicks (#113) — one server call, one toast
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
        showToast({ tone: "danger", title: "Couldn't forget that", desc: "Nothing changed — please try again.", actions: [{ label: "OK" }], timeout: 4000 });
      }
    }
  });
  $("#railCmd")!.addEventListener("click", () => palette.show());
  $("#cmdkBtn")!.addEventListener("click", () => palette.show());
  // Per-message copy (markdown) + save-as-.md
  $("#thread")!.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const copyBtn = t.closest("[data-msg-copy]") as HTMLElement | null;
    const saveBtn = t.closest("[data-msg-save]") as HTMLElement | null;
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
  });

  // inspector collapse ↔ metrics rail
  $("#inspCollapse")!.addEventListener("click", () => setInspectorRail(true));
  $("#railExpand")!.addEventListener("click", () => setInspectorRail(false));

  // composer agent controls → focused per-control dropdowns
  $("#ctModel")!.addEventListener("click", () => openOptionDropdown($("#ctModel")!, "model"));
  $("#ctMode")!.addEventListener("click", () => openOptionDropdown($("#ctMode")!, "mode"));
  $("#ctThink")!.addEventListener("click", () => openOptionDropdown($("#ctThink")!, "thinking"));
  $("#ctPersona")!.addEventListener("click", () => openPersonaDropdown($("#ctPersona")!));
  $("#ctSkill")!.addEventListener("click", () => openSkillDropdown($("#ctSkill")!));

  // settings page actions (delegated)
  $("#setClose")!.addEventListener("click", () => closeSettings());
  // P-IDE.1c: enable the China-unlock button only when exactly ACKNOWLEDGE is typed.
  $("#setBody")!.addEventListener("input", (e) => {
    const t = e.target as HTMLElement;
    if (t.id === "chinaAckInput") { const b = $("#chinaAckBtn", $("#setBody")!) as HTMLButtonElement | null; if (b) b.disabled = (t as HTMLInputElement).value.trim() !== "ACKNOWLEDGE"; }
  });
  $("#setBody")!.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const head = t.closest("[data-acc-toggle]") as HTMLElement | null;
    if (head) { const k = head.dataset.accToggle!; (head.closest(".acc")!.classList.toggle("open")) ? OPEN.add(k) : OPEN.delete(k); return; }
    // workspace
    if (t.closest("#wsBrowse")) {
      // In-app folder browser - works in both the packaged app and the browser build, and
      // flags which folders are git repos (to open or initialize one).
      const path = await openFolderBrowser();
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
      if (state.managed?.locks?.models) return; // ADR-0068: org-locked routing — not user-toggleable
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
      showToast({ title: "OAuth started", desc: r?.url ? "Complete the sign-in in your browser, then return - the model list updates automatically." : (r?.output?.slice(0, 160) || "Follow omp's prompt in the GUI server window."), actions: [{ label: "OK" }], timeout: 6000 });
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
    // Dismiss: acknowledge a reviewed block — moves it to the Dismissed section WITHOUT releasing it
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
    const act = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
    if (act) {
      const ok = act.dataset.act === "approve";
      showToast({ title: ok ? "Approved" : "Denied", desc: ok ? "Artifact released from quarantine and recorded in the audit log." : "Artifact kept in quarantine. Decision recorded.", actions: [{ label: "OK" }], timeout: 3200 });
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
  // P-ACP.4: while a turn runs the Send button is a Stop control (interrupt the turn); else it sends.
  $("#send")!.addEventListener("click", () => { if (state.streaming) void stopTurn(); else void send(); });

  // Jump-to-latest: show the catch-up arrow on user scroll / resize; click pages down one screen.
  $("#chat")?.addEventListener("scroll", scheduleJump, { passive: true });
  window.addEventListener("resize", scheduleJump, { passive: true });
  $("#jumpDown")?.addEventListener("click", jumpDownOnePage);

  // P-IDE.4: "View in IDE" on chat code blocks → open the read-only Monaco panel (delegated, one
  // listener for all current + future blocks). Exclusivity: opening the IDE closes Settings + KG.
  setIdeExclusivity(() => { closeSettings(); closeKnowledge(); });
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
    { id: "mem", title: "Open Memory & context panel", icon: "brain", hint: "panel", run: () => focusInspector("memory") },
    { id: "zin", title: "Zoom in", icon: "plus", hint: "Ctrl +", run: () => nudgeZoom(0.1) },
    { id: "zout", title: "Zoom out", icon: "minus", hint: "Ctrl −", run: () => nudgeZoom(-0.1) },
    { id: "zreset", title: "Reset text zoom to 100%", icon: "refresh", hint: "Ctrl 0", run: () => resetZoom() },
    { id: "new", title: "New session", icon: "plus", run: () => newSession() },
    { id: "side", title: "Toggle sidebar", icon: "layout", run: () => toggleSidebar() },
    { id: "insp", title: "Collapse / expand inspector (metrics rail)", icon: "collapse", run: () => setInspectorRail(!state.inspectorRail) },
    { id: "refresh", title: "Refresh dashboards now", icon: "refresh", run: () => refresh() },
  ];
  const model = state.config.find((c) => c.id === "model");
  if (model) for (const o of model.options.slice(0, 10)) acts.push({ id: "m:" + o.value, title: `Model: ${o.name}`, icon: "spark", hint: o.value === model.currentValue ? "current" : "", run: () => applyConfig("model", o.value) });
  for (const c of state.commands) acts.push({ id: "cmd:" + c.name, title: `/${c.name}${c.hint ? " " + c.hint : ""}`, icon: "command", hint: (c.description ?? "omp").slice(0, 26), run: () => runCommand(c) });
  // P-IDE.2: bundled skills + /task proforma, then project (omp-native) skills.
  acts.push({ id: "task", title: "/task — delegate to subagents", icon: "bolt", hint: "proforma", run: () => insertTaskProforma() });
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
    state.chinaAck = !!(await bridge.chinaAck())?.acknowledged; // P-IDE.1c: gate China-origin models
    state.managed = await bridge.managed(); // ADR-0068 (P-ENT.1): enterprise lock view for the UI
    // P-IDE.1d: only adopt the live config when omp actually returned one. A cold/not-ready omp returns
    // an empty list — keep the cached list visible (spinner stays) rather than blanking the picker. When
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
  for (let i = 0; i < 30; i++) { // ~2.5 min @ 5s
    await sleep(5000);
    const a = await bridge.auth();
    const prov = [...(a?.majors ?? []), ...(a?.others ?? [])].find((x) => x.oauthId === oauthId);
    if (prov?.oauthActive) {
      await loadConfig();
      if (state.settingsOpen) renderSettings();
      showToast({ title: "Connected - models updated", desc: `${prov.name} is ready in the model picker.`, actions: [{ label: "OK" }], timeout: 6000 });
      return;
    }
  }
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
  try { state.config = await bridge.setConfig(configId, value); } catch { /* keep optimistic */ }
  const o = state.config.find((c) => c.id === configId); if (o) o.currentValue = value;
  if (configId === "model") { state.model = value; const mn = $("#modelName"); if (mn) mn.textContent = modelLabel(value); renderStatus(); }
  updateComposerTools();
  showToast({ title: `${opt?.name ?? configId} → ${label}`, desc: configId === "model" ? "New turns use this model." : "Applied to the active session.", actions: [{ label: "OK" }], timeout: 2400 });
}

const isAsksage = (v: string) => /asksage/i.test(v);
// Models present in the catalog but NOT currently selectable. Keyed by short id; the value is the
// reason shown (greyed row + hover banner). Fable 5 + Mythos 5 are ITAR-restricted until the U.S.
// government clears them — keep them visible-but-disabled so users know they're coming, not missing.
// (ADR-0029 P-IDE.1b/1d)
const ITAR_REASON = "Currently unavailable — restricted under U.S. ITAR export controls until the government clears it for use (expected soon).";
const UNAVAILABLE: Record<string, string> = {
  "claude-fable-5": ITAR_REASON,
  "claude-mythos-5": ITAR_REASON,
};
const unavailableReason = (value: string): string | undefined => UNAVAILABLE[shortModelId(value)];
// Advisory shown on gov-gateway (AskSage) models until they're cleared for production use.
const GOV_ADVISORY = "Government (AskSage) model — restricted to internal prototype use only until cleared for production by the U.S. government.";
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
  // Provider tag only on NON-gov colliding rows — the Gov pill already distinguishes gov routes.
  const prov = (!isAsksage(o.value) && collidingNames.has(cleanModelName(o.name))) ? `<span class="row-prov" data-tip="Provider route">${esc(providerLabel(o.value))}</span>` : "";
  // P-IDE.1b: an unavailable model (e.g. ITAR-blocked Fable) renders greyed + non-selectable — NO
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
  return `<div class="cfg-opt ${o.value === sel ? "on" : ""}" data-val="${esc(o.value)}" data-model="${esc(o.value)}"><span class="tick">${icon("check", 13)}</span><span class="nm">${esc(cleanModelName(o.name))}</span>${prov}${isAsksage(o.value) ? `<span class="gov-pill">Gov</span>` : ""}${ctx}${iq}</div>`;
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
/** Render the model list as collapsible family sections. `q` filters across ALL families (empty/
 *  no-match families are omitted); while searching, every shown family is force-expanded. When the
 *  gov gateway is configured, families are reordered GPT/Gemini-first (ASKSAGE_FAMILY_ORDER). A
 *  collapsed family still renders its rows (hidden via CSS) so the persisted state round-trips.
 *  Collapse is fully user-driven — even the family holding the current selection can be collapsed. */
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
  return groupByFamily(filtered, order).map(({ fam, models: ms }) => {
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
  "google-claude-45-opus": { exp: 5, iq: 5, eff: "Claude 4.5 Opus via the gov gateway.", best: "The hardest gov coding and reasoning.", ctx: "200K" },
  "google-claude-45-sonnet": { exp: 3, iq: 4, eff: "Balanced Claude 4.5 via the gov gateway.", best: "Everyday gov coding and review.", ctx: "200K" },
  "aws-bedrock-claude-45-sonnet-gov": { exp: 3, iq: 4, eff: "Claude 4.5 Sonnet inside AWS GovCloud.", best: "FedRAMP / IL-bound Sonnet workloads.", ctx: "200K" },
  "claude-opus-4": { exp: 4, iq: 5, eff: "Claude Opus 4 via the gov gateway.", best: "Complex gov tasks.", ctx: "200K" },
  "claude-sonnet-4": { exp: 3, iq: 4, eff: "Claude Sonnet 4 via the gov gateway.", best: "Balanced gov coding.", ctx: "200K" },
  // AskSage · Google
  "google-gemini-3.1-pro-com": { exp: 3, iq: 5, eff: "Gemini 3.1 Pro with a 1M context.", best: "Huge-context gov analysis.", ctx: "1M" },
  "google-gemini-3.5-flash-gov": { exp: 2, iq: 3, eff: "Fast Gemini in GovCloud; 1M context.", best: "Fast long-context gov tasks.", ctx: "1M" },
  "google-gemini-2.5-pro": { exp: 3, iq: 4, eff: "Gemini 2.5 Pro; 1M context.", best: "Long-context reasoning.", ctx: "1M" },
  "google-gemini-2.5-flash": { exp: 1, iq: 3, eff: "Fast, cheap Gemini; 1M context.", best: "High-volume long-context work.", ctx: "1M" },
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
  const small = /mini|nano|lite|flash|haiku|oss|-8b|-7b/.test(s);
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
  const govNote = gov ? `<div class="mt-banner gov">${esc(GOV_ADVISORY)}</div>` : "";
  const ratings = `<div class="mt-rate">${stars5(info.exp, "exp")}<span class="mt-rlabel">Token Expense</span></div>
    <div class="mt-rate">${stars5(info.iq, "iq")}<span class="mt-rlabel">Intelligence Level</span></div>
    <div class="mt-eff">${esc(info.eff)}</div>
    <div class="mt-row"><span class="mt-k">Best for</span><span class="mt-v">${esc(info.best)}</span></div>
    ${info.ctx ? `<div class="mt-row"><span class="mt-k">Context</span><span class="mt-v">${esc(info.ctx)} tokens</span></div>` : ""}`;
  return `<div class="mt-h"><span class="mt-name">${esc(modelLabel(value))}</span>${gov ? `<span class="gov-pill">Gov</span>` : ""}</div>
    ${banner}${govNote}${ratings}
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
  // render IDENTICALLY (same gov/provider + same display name) — the user can't tell them apart anyway.
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
      list.innerHTML = familyListHTML(list2, m?.currentValue ?? model.currentValue, q);
      search.placeholder = `Search ${list2.length} models…`;
      const ld = $("#cfgLoading", node) as HTMLElement | null; if (ld) ld.hidden = !state.configCached;
    };
    draw();
    pickerRedraw = () => draw(search.value); // refresh when live config lands (cold-boot cache → live)
    attachModelTips(list); // premium per-model hover cards (delegated → survives re-render)
    search.addEventListener("input", (e) => draw((e.target as HTMLInputElement).value));
    list.addEventListener("click", (e) => {
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
      const tgl = (e.target as HTMLElement).closest("[data-fam-toggle]") as HTMLElement | null;
      if (tgl) { toggleFamilyCollapsed(tgl.dataset.famToggle!); listEl.innerHTML = familyListHTML(opts, c.currentValue, ($("#miniSearch", node) as HTMLInputElement)?.value ?? ""); return; }
    }
    const it = (e.target as HTMLElement).closest("[data-val]") as HTMLElement | null;
    if (it) { applyConfig(configId, it.dataset.val!); close(); }
  });
}

// ───────────────────────── text zoom ─────────────────────────
function applyZoom(): void {
  state.zoom = Math.max(0.7, Math.min(1.8, Math.round(state.zoom * 100) / 100));
  bridge.setZoom(state.zoom);
  const lvl = $("#zoomLvl"); if (lvl) lvl.textContent = `${Math.round(state.zoom * 100)}%`;
  try { localStorage.setItem("lucid.zoom", String(state.zoom)); } catch { /* ignore */ }
}
function nudgeZoom(delta: number): void { state.zoom += delta; applyZoom(); }
function resetZoom(): void { state.zoom = 1; applyZoom(); }
function initZoom(): void {
  try { const z = Number(localStorage.getItem("lucid.zoom")); if (z) state.zoom = z; } catch { /* ignore */ }
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
  } catch { /* ignore */ }
  // data-resize value → the panel element id ("kg" → #knowledge); all right-side panels resize from
  // their left edge, the sidebar (left panel) from its right edge.
  const elFor = (which: string) => $(`#${which === "kg" ? "knowledge" : which}`)!;
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
      : active.which === "kg" ? [360, Math.round(window.innerWidth * 0.8)]
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
  promptForEmailIfMissing(); // first open, undecided → ask for email (or skip → workstation identity)
});
refresh();
void maybeOnboardPersonal(); // P-IMP.2: first-run nudge + expand Personalization until it's configured
scheduleBudgetPoll(); // provider budget: re-check every 5 min for the current model
setInterval(refresh, 4000);
setInterval(renderStatus, 1000);
setInterval(() => void renderSessions(), 15000);
