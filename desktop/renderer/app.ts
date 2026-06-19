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
import { type Action, attachRichTip, createPalette, initTooltips, popover, showToast } from "./ui.ts";

type Tab = "security" | "memory";
const state = {
  inspectorTab: "security" as Tab,
  sidebarCollapsed: false,
  inspectorRail: false,
  model: "claude-opus-4-8",
  security: null as SecuritySnapshot | null,
  memory: null as MemorySnapshot | null,
  config: [] as ConfigOption[],
  commands: [] as OmpCommand[],
  skills: [] as { name: string; description: string; source: string }[],
  liveUsage: null as { used: number; size: number; cost: number } | null,
  workspace: null as WorkspaceInfo | null,
  asksage: null as { configured: boolean; base: string; only: boolean; limit: number; datasets: string[]; queryModel: string; persona: string } | null,
  asksageTokens: null as { used: number; limit: number } | null,
  persona: null as string | null, // active persona id (AskSage)
  personas: [] as { id: string; description: string }[],
  zoom: 1,
  settingsOpen: false,
  lastOk: 0,
  streaming: false,
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
  "claude-fable-5": 1_000_000, "claude-opus-4-8": 1_000_000, "claude-opus-4-7": 1_000_000,
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
        <button class="rail-btn" data-rail="runs" data-tip="Runs|Provenance lineage" data-tip-icon="runs">${icon("runs", 20)}</button>
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
        <div class="composer-wrap">
          <div class="composer">
            <textarea id="input" rows="1" placeholder="Ask the agent…  every tool call is scanned before it runs"></textarea>
            <button class="send-btn" id="send" data-tip="Send|Enter" disabled>${icon("send", 18)}</button>
          </div>
          <div class="composer-tools" id="composerTools">
            <button class="ctool" id="ctModel" data-tip="Model|Click to change the model">${icon("spark", 14)}<span id="ctModelName">${esc(modelLabel(state.model))}</span>${icon("chevron", 11)}</button>
            <button class="ctool" id="ctMode" data-tip="Mode|Agent edits files · Plan drafts read-only">${icon("bolt", 14)}<span id="ctModeName">Agent</span>${icon("chevron", 11)}</button>
            <button class="ctool" id="ctThink" data-tip="Thinking depth|How hard the model reasons">${icon("brain", 14)}<span id="ctThinkName">High</span>${icon("chevron", 11)}</button>
            <button class="ctool" id="ctPersona" data-tip="AskSage persona|Server-supplied role guidance - scanned before use" hidden>${icon("user", 14)}<span id="ctPersonaName">Persona</span>${icon("chevron", 11)}</button>
            <button class="ctool" id="ctSkill" data-tip="Skills|omp skills the agent can run - adds /skill:<name> to your message" hidden>${icon("bolt", 14)}<span>Skills</span>${icon("chevron", 11)}</button>
            <span class="ctool-hint"><span class="kh"><kbd>↵</kbd> send</span><span class="kh"><kbd>⇧↵</kbd> newline</span><span class="kh"><kbd>⌘K</kbd> commands</span></span>
          </div>
        </div>
      </main>

      <aside class="inspector" id="inspector">
        <div class="resizer resizer-l" data-resize="inspector" data-tip="Drag to resize" data-tip-side="left"></div>
        <div class="insp-tabs">
          <button class="insp-tab sec active" data-insp="security">${icon("shield", 15)} Security</button>
          <button class="insp-tab mem" data-insp="memory">${icon("brain", 15)} Memory</button>
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
    </div>

    <div class="statusbar" id="statusbar"></div>
  </div>`));
}

// ───────────────────────── sidebar (real omp sessions) ─────────────────────────
function relTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
async function renderSessions(): Promise<void> {
  const sessions = await bridge.sessions().catch(() => null);
  const list = $("#sessList");
  if (!list) return;
  if (sessions === null) { list.innerHTML = `<div class="side-empty">Couldn't load history - the GUI server looks out of date. Relaunch it (launcher → <b>G</b>), or restart <code>bun run desktop:web</code>.</div>`; return; }
  if (!sessions.length) { list.innerHTML = `<div class="side-empty">No sessions yet - send a prompt to start one. They persist here across runs.</div>`; return; }
  list.innerHTML = sessions.map((s, i) => `
    <div class="sess ${i === 0 ? "active" : ""}" data-sid="${esc(s.id)}" data-tip="${esc(s.title)}|${esc(modelLabel(s.model))} · ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${relTime(s.updatedAt)}" data-tip-side="right">
      <div class="t">${esc(s.title)}</div>
      <div class="m"><b>${esc(modelLabel(s.model))}</b> · ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${relTime(s.updatedAt)}</div>
    </div>`).join("");
}

// ───────────────────────── chat ─────────────────────────
function seedThread(): void {
  $("#thread")!.innerHTML = `<div class="chat-hint" id="chatHint">
    <div class="bs">${piMark}</div>
    <div class="h">Ask the agent anything</div>
    <div class="d">Real omp replies - every tool call is scanned by the security gate before it runs.</div></div>`;
}
function addMessage(role: "user" | "assistant", text: string): HTMLElement {
  $("#chatHint")?.remove();
  const node = el(`<div class="msg ${role}">
    <div class="who">${role === "user" ? "You" : "LucidAgent"}</div>
    <div class="av">${role === "user" ? icon("user", 16) : piMark}</div>
    <div class="text"></div></div>`);
  ($(".text", node) as HTMLElement).innerHTML = renderMarkdown(text);
  $("#thread")!.appendChild(node);
  scrollChat();
  return node;
}
function addEvent(html: string): HTMLElement {
  const node = el(html);
  $("#thread")!.appendChild(node);
  scrollChat();
  return node;
}
const scrollChat = () => { const c = $("#chat")!; requestAnimationFrame(() => (c.scrollTop = c.scrollHeight)); };

async function send(): Promise<void> {
  const ta = $("#input") as HTMLTextAreaElement;
  const text = ta.value.trim();
  if (!text || state.streaming) return;
  ta.value = ""; autosize(ta); setSendEnabled();
  addMessage("user", text);
  state.streaming = true; setSendEnabled();

  const node = addMessage("assistant", "");
  const textEl = $(".text", node) as HTMLElement;
  textEl.innerHTML = `<span class="cursor"></span>`;
  let buf = "";
  const onEvent = (e: ChatEvent) => {
    if (e.type === "token") { buf += e.text; textEl.innerHTML = renderMarkdown(buf) + `<span class="cursor"></span>`; scrollChat(); }
    else if (e.type === "tool") addEvent(`<div class="evt tool">${icon("eye", 15)}<span class="k">${esc(e.name)}</span><span>${esc(e.detail)}</span></div>`);
    else if (e.type === "block") onBlock(e);
    else if (e.type === "usage") { state.liveUsage = { used: e.used, size: e.size, cost: e.cost }; renderStatus(); renderMetricsRail(); }
    else if (e.type === "done") { textEl.innerHTML = renderMarkdown(buf); state.streaming = false; setSendEnabled(); }
  };
  try { await bridge.sendPrompt(text, onEvent); }
  finally { if (state.streaming) { textEl.innerHTML = renderMarkdown(buf); state.streaming = false; setSendEnabled(); } void renderSessions(); void refreshBudget(false); }
}

function onBlock(e: Extract<ChatEvent, { type: "block" }>): void {
  addEvent(`<div class="evt block" data-tip="Quarantined|Click to review in the Security panel" data-tip-icon="shield">
    ${icon("shield", 15)}<span>Blocked <b>${esc(e.tool)}</b> ·</span><span class="reason">${esc(e.reason)}</span></div>`)
    .addEventListener("click", () => focusInspector("security"));
  showToast({
    title: "Tool call quarantined",
    desc: `${e.reason}.`,
    meta: `tool=${e.tool} · severity=${e.severity} · ${e.findings}`,
    actions: [
      { label: "Review", run: () => focusInspector("security") },
      { label: "Dismiss", kind: "danger" },
    ],
  });
  refresh(); // pull the new finding into the panels
}

function autosize(ta: HTMLTextAreaElement): void { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 180) + "px"; }
function setSendEnabled(): void {
  const ta = $("#input") as HTMLTextAreaElement;
  ($("#send") as HTMLButtonElement).disabled = state.streaming || !ta.value.trim();
}

// ───────────────────────── inspector ─────────────────────────
function focusInspector(tab: Tab): void {
  closeSettings();
  state.inspectorTab = tab;
  if (state.inspectorRail) setInspectorRail(false);
  $$(".insp-tab").forEach((t) => t.classList.toggle("active", (t as HTMLElement).dataset.insp === tab));
  $$(".rail-btn").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.rail === tab));
  lastInspHash = ""; renderInspector();
}

function renderInspector(): void {
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
  const tile = (n: string, label: string, cls: string, tip: string) =>
    `<div class="tile ${cls}" data-tip="${esc(label)}|${esc(tip)}" data-tip-side="left"><div class="n">${esc(n)}</div><div class="l">${esc(label)}</div></div>`;
  tiles.innerHTML =
    tile(`${Math.round(hit * 100)}%`, "cache", "g", "Prompt-cache hit rate - share of input billed at the discounted cached rate (~10% of full price). Higher = lower spend per turn.") +
    tile(fmtNum(avg), "avg/turn", "c", "Average tokens per turn") +
    tile(fmtNum(cur), "context", "b", "Context tokens in use this turn") +
    tile(String(turns), "turns", "b2", "Agent turns in this session") +
    tile(String(findings), "findings", "m", "Scanner findings so far") +
    tile(String(quar), "quarantd", "r", "Artifacts currently quarantined");
}
function setInspectorRail(rail: boolean): void {
  state.inspectorRail = rail;
  $("#inspector")!.classList.toggle("rail", rail);
  if (rail) renderMetricsRail();
}

// ───────────────────────── settings page ─────────────────────────
function provCard(p: ProviderAuth): string {
  const last4 = esc(p.keyLast4 ?? "");
  const status =
    (p.oauthActive ? `<span class="abadge ok">${icon("check", 11)} OAuth active</span>` : "") +
    (p.keySet ? `<span class="abadge set">key ••${last4}</span>` : "") +
    (!p.oauthActive && !p.keySet ? `<span class="abadge none">not set</span>` : "");
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
      </div></div></div>`;
}
// AskSage monthly-token allowance. AskSage reports tokens USED but not the ceiling
// (admins raise it in the AskSage console - no API), so the limit is local + the
// user tops it up in increments to match what they were approved.
function quotaControls(limit: number): string {
  const used = state.asksageTokens?.used ?? 0;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return `<div class="aq">
    <div class="aq-head"><span>Monthly token limit</span>
      <button class="info-dot aq-info" data-tip="Token allowance|You start at 200,000 tokens. AskSage reports how many you've USED but not your ceiling - your org admin grants more in the AskSage console. Set this to match what you were approved under AskSage → Settings → Usage &amp; Billing (Inference Tokens)." data-tip-side="top">${icon("info", 12)}</button>
      <b class="aq-val">${fmtNum(used)} / ${fmtNum(limit)}</b></div>
    <div class="aq-bar"><i style="width:${pct.toFixed(1)}%;background:${loadColor(pct / 100)}"></i></div>
    <div class="aq-pct">${Math.round(pct)}% used</div>
    <div class="aq-btns">
      <button class="btn-mini" data-quota="50000">+50K</button>
      <button class="btn-mini" data-quota="250000">+250K</button>
      <button class="btn-mini" data-quota="1000000">+1M</button>
      <button class="btn-mini" data-quota="reset" data-tip="Back to the 200k starting allowance">Reset 200K</button>
    </div>
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

function secProfile(s: { username: string } | null): string {
  return setCard("profile", "Profile", "", `<div class="prov-row"><input id="setUsername" class="prov-key" placeholder="Your name" value="${esc(s?.username ?? "")}" />
    <button class="btn-mini ok" id="saveUsername">${icon("check", 12)} Save</button></div>`, false);
}
function secProviders(auth: import("./bridge.ts").AuthStatus | null): string {
  return setCard("providers", "Providers", "key or OAuth · majors first",
    (auth?.majors ?? []).map(provCard).join("") || `<div class="empty">couldn't read auth - is the server up to date?</div>`, false);
}
function secAsksage(a: typeof state.asksage, datasets: string[] | null): string {
  const body = `<div class="prov-row"><input id="asksageBase" class="prov-key" placeholder="https://api.civ.asksage.ai/server" value="${esc(a?.base ?? "")}" />
      <button class="btn-mini ok" id="asksageSaveBase">${icon("check", 12)} Save URL</button></div>
    ${a?.configured ? quotaControls(a.limit) : ""}
    <label class="set-toggle"><input type="checkbox" id="asksageOnly" ${a?.only ? "checked" : ""}/>
      <span><b>AskSage-only (lockdown)</b> - route every turn through the gov gateway and hide direct providers in the model picker.</span></label>
    ${a?.only ? datasetsSection(datasets) : ""}
    ${a?.configured ? `<div class="set-note ok">${icon("check", 12)} Gov gateway active - AskSage models appear in the picker, with monthly-usage and scanned personas.</div>` : `<div class="set-note">${icon("info", 12)} Add an <code>ASKSAGE_API_KEY</code> in Providers to enable gov models, usage, and personas.</div>`}`;
  return setCard("asksage", "AskSage gov gateway", "accredited proxy", body, true);
}
function secCompression(hr: import("./bridge.ts").HeadroomStatus | null): string {
  const body = hr?.installed
    ? `<label class="set-toggle"><input type="checkbox" id="headroomToggle" ${hr.enabled ? "checked" : ""}/>
        <span><b>Compress context with headroom</b> - fewer tokens before they reach the model. ${hr.running ? `<span class="abadge ok">running · :${hr.port}</span>` : ""}</span></label>
      <div class="set-note">${icon("info", 12)} Runs entirely on your machine (${esc(hr.version ?? "installed")}). Request-routing + a gov-deployment security review are next - see ADR-0008.</div>`
    : `<div class="set-note">${icon("info", 12)} Optional: install <b>headroom</b> to compress context on-device (60–95% fewer tokens). Run <code>${esc(hr?.installHint ?? "pip install headroom-ai[proxy]")}</code>, then this toggle appears.</div>`;
  return setCard("compression", "Token compression", "headroom · on-device · opt-in", body, true);
}
function secOthers(auth: import("./bridge.ts").AuthStatus | null): string {
  return setCard("others", "More providers", "", (auth?.others ?? []).map(provCard).join("") || `<div class="empty">none</div>`, true);
}

function settingsShell(): string {
  return [
    `<div data-sec="workspace"></div>`,
    setSkel("profile", "Profile", ""),
    setSkel("providers", "Providers", "key or OAuth · majors first"),
    setSkel("asksage", "AskSage gov gateway", "accredited proxy", true),
    setSkel("compression", "Token compression", "headroom · on-device · opt-in", true),
    setSkel("personal", "Personalization", "private · encrypted · opt-in", true),
    setSkel("others", "More providers", "", true),
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
  void bridge.getSettings().then((s) => fillSec("profile", secProfile(s)));
  void bridge.auth().then((a) => { fillSec("providers", secProviders(a)); fillSec("others", secOthers(a)); });
  void bridge.headroom().then((h) => fillSec("compression", secCompression(h)));
  void hydratePersonal();
  void bridge.asksage().then(async (a) => {
    if (a) state.asksage = a;
    fillSec("asksage", secAsksage(a, null)); // paint immediately, without the slow datasets
    if (a?.configured && a.only) { // only lockdown needs datasets/personas - fetch them after
      const datasets = await bridge.asksageDatasets();
      if (!state.personas.length) state.personas = (await bridge.asksagePersonas()) ?? [];
      fillSec("asksage", secAsksage(a, datasets));
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
      <div class="pscope-lbl">Compartment <span class="info-dot" data-tip="Data compartments|Keep Work, Personal, and CUI knowledge separate. The active compartment scopes what is learned and recalled; Combined is a union view. Portability is compartment-aware - see ADR-0012.">${icon("info", 11)}</span></div>
      <div class="seg pscope-seg">${seg}</div>
      <div class="pscope-note ${info.tone}">${icon(info.tone === "danger" ? "shield" : "info", 13)} <span>${esc(info.note)}</span></div>
      <div class="pscope-counts">
        <div class="psc"><b class="psc-personal">${c.personal}</b><span>personal</span></div>
        <div class="psc"><b class="psc-work">${c.work}</b><span>work</span></div>
        <div class="psc"><b class="psc-cui">${c.cui}</b><span>cui</span></div></div>
      <button class="btn-mini pscope-lock" id="personalLock" data-tip="Lock the store|Wipes the in-memory encryption key. You'll re-enter your passphrase to use personalization again this session - nothing is learned or recalled while locked." data-tip-side="top">${icon("shield", 12)} Lock</button>`;
  }
  return card(toggle + inner);
}
function openSettings(): void {
  state.settingsOpen = true;
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
  state.workspace = await bridge.workspace();
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

async function applyWorkspace(path: string): Promise<void> {
  const info = await bridge.setWorkspace(path);
  if (info) { state.workspace = info; renderWorkspaceBar(); }
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
  const totFind = d ? d.findings.reduce((a, r) => a + Number(r.n || 0), 0) : 0;
  const promoted = d ? Number((d.promotion.find((r) => r.outcome === "promoted") || {}).n || 0) : 0;
  const blocked = d ? Number((d.promotion.find((r) => r.outcome === "blocked") || {}).n || 0) : 0;
  let h = secIntro();
  h += chips([
    { cls: "q", n: d ? d.quarantine.length : 0, l: "quarantined" },
    { cls: "a", n: d ? d.approvals.length : 0, l: "awaiting review" },
    { cls: "f", n: totFind, l: "findings" },
    { cls: "g", n: promoted, l: "promoted facts" },
  ]);
  if (!d) { h += `<div class="empty">Nothing has tripped the scanner yet. The moment a tool call carries hidden-Unicode or another injection, the finding, the quarantine queue, and the audit trail appear right here.</div>`; return h; }
  h += accordion("sec.quarantine", "Quarantine review", "isolated · fail-closed",
    table([{ key: "artifact_id", label: "artifact", mono: true }, { key: "source", label: "source" }, { key: "trust_label", label: "trust", pill: true }, { key: "risk_score", label: "risk", mono: true }], d.quarantine),
    OPEN.has("sec.quarantine"), String(d.quarantine.length));
  h += accordion("sec.approvals", "Approval queue", "blocked · awaiting a human",
    table([{ key: "artifact_id", label: "artifact", mono: true }, { key: "source", label: "source" }, { key: "trust_label", label: "trust", pill: true }, { key: "verdict", label: "verdict", pill: true }], d.approvals)
    + (d.approvals.length ? `<div class="row-actions"><button class="btn-mini ok" data-act="approve">${icon("check", 14)} Approve</button><button class="btn-mini danger" data-act="deny">${icon("close", 14)} Deny</button></div>` : ""),
    OPEN.has("sec.approvals"), String(d.approvals.length));
  h += accordion("sec.findings", "Findings overview", "by type · severity · source",
    table([{ key: "finding_type", label: "type" }, { key: "severity", label: "sev", pill: true }, { key: "source", label: "source" }, { key: "n", label: "n", mono: true }], d.findings),
    OPEN.has("sec.findings"));
  h += accordion("sec.gate", "Memory-promotion gate", "untrusted content can't auto-save",
    gauge("blocked", blocked + promoted ? blocked / (blocked + promoted) : 0, `<b>${blocked}</b>&nbsp;blocked / ${promoted} ok`),
    OPEN.has("sec.gate"));
  h += accordion("sec.exports", "Export audit", "what left, sanitized",
    table([{ key: "export_type", label: "type" }, { key: "sanitization_status", label: "sanitized" }, { key: "reviewer", label: "by" }], d.exports),
    OPEN.has("sec.exports"));
  h += accordion("sec.runs", "Active runs", "provenance lineage",
    table([{ key: "kind", label: "kind" }, { key: "mode", label: "mode" }, { key: "sandbox_profile", label: "sandbox" }, { key: "status", label: "status" }], d.runs),
    OPEN.has("sec.runs"));
  return h;
}

function memoryHtml(d: MemorySnapshot | null): string {
  if (!d) return `<div class="empty">No omp session yet - launch omp and send a message.</div>`;
  let h = "";
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
  } else {
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
  return `<div class="bgt-head">
      <button class="btn-mini" data-budget-refresh data-tip="Re-check provider usage now">${icon("refresh", 13)} Refresh</button>
      <span class="bgt-note">auto every 5 min</span>
    </div>${rows}`;
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
    ${budget ? `<div class="seg seg-btn" data-budget-refresh data-tip="${esc(budget.label)} usage|Click to re-check now · auto every 5 min. omp's last-seen value, so it can lag the official usage.">${esc(budget.label)} <b>${Math.round(budget.used * 100)}%</b> ${icon("refresh", 11)}</div>` : ""}
    ${asksageChip()}
    <div class="seg" data-tip="Session cost">${fmtUSD(cost)}</div>
    <div class="right">
      <div class="seg" data-tip="Security gate|In-process, fail-closed">${icon("shield", 13)} gate active</div>
      <div class="seg"><span class="live-dot"></span> ${ago == null ? "connecting…" : ago < 2 ? "live" : `updated ${ago}s ago`}</div>
    </div>`;
}

// ───────────────────────── data polling ─────────────────────────
async function refresh(): Promise<void> {
  try {
    const [sec, mem] = await Promise.all([bridge.security(), bridge.memory()]);
    state.security = sec; state.memory = mem;
    // the badge reflects the live session CONFIG model (loadConfig), not the
    // historical snapshot - so it shows what the next turn will actually use.
    state.lastOk = Date.now();
    // Security rail badge: number of items AWAITING YOUR REVIEW (quarantined/suspicious
    // content the gate flagged). Hidden when there's nothing to act on; coloured by the
    // worst trust label in the queue (quarantined = red, suspicious-only = amber).
    const approvals = sec?.approvals ?? [];
    const awaiting = approvals.length;
    const badge = $("#railBadge")!;
    badge.hidden = awaiting === 0;
    if (awaiting > 0) {
      const high = approvals.some((a) => String(a.trust_label) === "quarantined");
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

// Provider budget - manual refresh + a 5-minute auto-poll for the current model.
// The figure is omp's last-seen value; a turn updates it, so we also re-pull after
// each turn. Manual refresh resets the 5-minute timer.
let budgetTimer: ReturnType<typeof setInterval> | null = null;
const BUDGET_POLL_MS = 5 * 60 * 1000;
async function refreshBudget(manual = false): Promise<void> {
  const budgets = await bridge.budget();
  if (budgets && state.memory) state.memory.budgets = budgets;
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
}
/** Update the composer's quick agent-controls (model · mode · thinking) labels. */
function updateComposerTools(): void {
  const model = state.config.find((c) => c.id === "model");
  const mode = state.config.find((c) => c.id === "mode");
  const think = state.config.find((c) => c.id === "thinking");
  const set = (sel: string, v: string) => { const e = $(sel); if (e) e.textContent = v; };
  if (model) set("#ctModelName", modelLabel(model.currentValue));
  if (mode) set("#ctModeName", mode.currentValue === "plan" ? "Plan" : "Agent");
  if (think) { const cur = think.options.find((o) => o.value === think.currentValue); set("#ctThinkName", prettyLevel(cur?.name ?? think.currentValue)); }
  const pBtn = $("#ctPersona"); if (pBtn) (pBtn as HTMLElement).hidden = !state.asksage?.configured;
  set("#ctPersonaName", state.persona ?? "Persona");
}

// AskSage persona picker (composer). Selecting one scans it server-side; a clean
// persona becomes delimited guidance, a flagged one is blocked (fail-closed).
async function openPersonaDropdown(anchor: HTMLElement): Promise<void> {
  cfgClose?.();
  const items = [{ id: "", description: "No persona - default behavior" }, ...state.personas];
  const rows = items.map((p) => `<div class="cfg-opt ${(state.persona ?? "") === p.id ? "on" : ""}" data-pid="${esc(p.id)}"><span class="tick">${icon("check", 13)}</span><span class="nm">${esc(p.id || "None")}</span><span class="id">${esc((p.description || "").slice(0, 44))}</span></div>`).join("");
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
    showToast({ title: `Persona "${id}" applied`, desc: "Scanned clean - added as delimited role guidance on your next turn.", actions: [{ label: "OK" }], timeout: 3200 });
  } else {
    state.persona = null; updateComposerTools();
    showToast({ title: "Persona blocked", desc: `The scanner flagged this persona (${r?.scan?.findings ?? 0} finding(s)); it was not applied.`, meta: "fail-closed - untrusted content can't enter the prompt", actions: [{ label: "OK" }], timeout: 6000 });
  }
}

// RAG persona picker (Settings → gov datasets). Sets AskSage's NATIVE persona id
// for the /query route - applied server-side, so no scan (no text enters the prompt).
function openRagPersonaDropdown(anchor: HTMLElement): void {
  cfgClose?.();
  const cur = state.asksage?.persona ?? "";
  const items = [{ id: "", description: "No persona - plain grounded RAG" }, ...state.personas];
  const rows = items.map((p) => `<div class="cfg-opt ${cur === p.id ? "on" : ""}" data-ragpid="${esc(p.id)}"><span class="tick">${icon("check", 13)}</span><span class="nm">${esc(p.id ? `#${p.id}` : "None")}</span><span class="id">${esc((p.description || "").slice(0, 46))}</span></div>`).join("");
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

// omp skills (discovered from project/user/agent dirs) - invokable via /skill:<name>.
async function loadSkills(): Promise<void> {
  state.skills = (await bridge.skills()) ?? [];
  const btn = $("#ctSkill"); if (btn) (btn as HTMLElement).hidden = state.skills.length === 0;
}
function useSkill(name: string): void {
  const ta = $("#input") as HTMLTextAreaElement;
  ta.value = `/skill:${name} ${ta.value}`.trimEnd() + " ";
  autosize(ta); setSendEnabled(); ta.focus();
  showToast({ title: `Skill: ${name}`, desc: "Added to your message - type your request and send.", actions: [{ label: "OK" }], timeout: 2400 });
}
function openSkillDropdown(anchor: HTMLElement): void {
  cfgClose?.();
  const rows = state.skills.map((s) =>
    `<div class="cfg-opt" data-skill="${esc(s.name)}" data-tip="${esc(s.description || s.name)}|${esc(s.source)}" data-tip-side="left"><span class="tick">${icon("bolt", 13)}</span><span class="nm">${esc(s.name)}</span><span class="id">${esc((s.description || "").slice(0, 42))}</span></div>`).join("");
  const { node, close } = popover(anchor, `<div class="cfg-sec"><div class="cfg-lbl">Skills <span class="cur">${state.skills.length} available · /skill:</span></div><div class="cfg-list" id="skillList">${rows || `<div class="empty">No skills found. Add markdown skills under <code>.omp/skills/</code>.</div>`}</div></div>`, () => { cfgClose = null; });
  cfgClose = close;
  $("#skillList", node)?.addEventListener("click", (e) => {
    const it = (e.target as HTMLElement).closest("[data-skill]") as HTMLElement | null;
    if (!it) return;
    close();
    useSkill(it.dataset.skill!);
  });
}

function wire(): void {
  // rail
  $$(".rail-btn[data-rail]").forEach((b) => b.addEventListener("click", () => {
    const r = (b as HTMLElement).dataset.rail!;
    if (r === "security" || r === "memory") focusInspector(r);
    else if (r === "chat") { closeSettings(); $("#input")?.focus(); $$(".rail-btn").forEach((x) => x.classList.toggle("active", x === b)); }
    else if (r === "runs") { focusInspector("security"); $("#inspBody")?.querySelector('[data-acc="sec.runs"] .acc-head')?.dispatchEvent(new Event("click", { bubbles: true })); }
    else if (r === "settings") openSettings();
    else palette.show();
  }));
  $("#railCmd")!.addEventListener("click", () => palette.show());
  $("#cmdkBtn")!.addEventListener("click", () => palette.show());

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
  $("#setBody")!.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const head = t.closest("[data-acc-toggle]") as HTMLElement | null;
    if (head) { const k = head.dataset.accToggle!; (head.closest(".acc")!.classList.toggle("open")) ? OPEN.add(k) : OPEN.delete(k); return; }
    // workspace
    if (t.closest("#wsBrowse")) {
      const path = await bridge.pickFolder();
      if (path) await applyWorkspace(path);
      else showToast({ title: "Browse needs the desktop app", desc: "In the browser build, paste a folder path instead.", actions: [{ label: "OK" }], timeout: 3400 });
      return;
    }
    if (t.closest("#wsSet")) { const v = ($("#wsPath", $("#setBody")!) as HTMLInputElement)?.value.trim(); if (v) await applyWorkspace(v); return; }
    if (t.closest("#wsClone")) {
      const url = ($("#wsCloneUrl", $("#setBody")!) as HTMLInputElement)?.value.trim();
      if (!url) return;
      showToast({ title: "Cloning…", desc: "Fetching the repo - this can take a moment.", timeout: 2500 });
      const info = await bridge.cloneWorkspace(url);
      if (info?.cloned) { state.workspace = info; renderWorkspaceBar(); seedThread(); void renderSessions(); void renderSettings(); showToast({ title: "Cloned & opened", desc: `Agent now works in ${info.name}.`, actions: [{ label: "OK" }], timeout: 3000 }); }
      else showToast({ title: "Clone failed", desc: (info?.error ?? "Check the URL and your git access.").slice(0, 180), actions: [{ label: "OK" }], timeout: 6000 });
      return;
    }
    const wsr = t.closest("[data-ws]") as HTMLElement | null;
    if (wsr) { await applyWorkspace(wsr.dataset.ws!); return; }
    const save = t.closest("[data-savekey]") as HTMLElement | null;
    if (save) {
      const env = save.dataset.savekey!;
      const inp = $(`.prov-key[data-env="${env}"]`, $("#setBody")!) as HTMLInputElement | null;
      const val = inp?.value.trim() ?? "";
      if (!val) { showToast({ title: "Nothing to save", desc: "Paste a key first.", actions: [{ label: "OK" }], timeout: 2000 }); return; }
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
    const quota = t.closest("[data-quota]") as HTMLElement | null;
    if (quota) {
      const cur = state.asksage?.limit ?? 200_000;
      const v = quota.dataset.quota!;
      const next = v === "reset" ? 200_000 : Math.round(cur + Number(v));
      state.asksage = (await bridge.saveAsksage({ limit: next })) ?? state.asksage;
      state.asksageTokens = state.asksage?.configured ? await bridge.asksageTokens() : state.asksageTokens;
      renderStatus(); void renderSettings();
      showToast({ title: v === "reset" ? "Reset to 200K" : `+${fmtNum(Number(v))} tokens`, desc: `Monthly allowance is now ${fmtNum(next)} tokens.`, actions: [{ label: "OK" }], timeout: 2200 });
      return;
    }
    if (t.closest("#headroomToggle")) {
      const enabled = ($("#headroomToggle", $("#setBody")!) as HTMLInputElement)?.checked ?? false;
      const st = await bridge.setHeadroom(enabled);
      showToast({ title: enabled ? "Compression on" : "Compression off", desc: enabled ? (st?.running ? `headroom proxy running on :${st.port}.` : "headroom enabled - proxy will start.") : "headroom proxy stopped.", actions: [{ label: "OK" }], timeout: 2800 });
      void renderSettings();
      return;
    }
    // ── Personalization (ADR-0010/0012) ──
    if (t.closest("#personalToggle")) {
      const enabled = ($("#personalToggle", $("#setBody")!) as HTMLInputElement)?.checked ?? false;
      await bridge.personalEnable(enabled);
      showToast({ title: enabled ? "Personalization on" : "Personalization off", desc: enabled ? "Set a passphrase to create your encrypted store." : "Locked and disabled - nothing is learned or recalled.", actions: [{ label: "OK" }], timeout: 2800 });
      void hydratePersonal();
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
      showToast({ title: "Locked", desc: "The in-memory key was wiped; unlock again to use it.", actions: [{ label: "OK" }], timeout: 2400 });
      void hydratePersonal();
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
      const r = await bridge.oauthLogin(oauth.dataset.oauth!);
      if (r?.url) window.open(r.url, "_blank");
      showToast({ title: "OAuth started", desc: r?.url ? "Complete the sign-in in your browser, then return - status updates automatically." : (r?.output?.slice(0, 160) || "Follow omp's prompt in the GUI server window."), actions: [{ label: "OK" }], timeout: 6000 });
      setTimeout(() => void renderSettings(), 4000);
      return;
    }
    const logout = t.closest("[data-oauth-logout]") as HTMLElement | null;
    if (logout) { await bridge.oauthLogout(logout.dataset.oauthLogout!); void renderSettings(); return; }
    if (t.closest("#saveUsername")) {
      const u = ($("#setUsername") as HTMLInputElement)?.value ?? "";
      await bridge.saveUsername(u);
      showToast({ title: "Saved", desc: `Hi${u ? ", " + u : " there"}.`, actions: [{ label: "OK" }], timeout: 2000 });
    }
  });

  // inspector tabs
  $$(".insp-tab").forEach((t) => t.addEventListener("click", () => focusInspector((t as HTMLElement).dataset.insp as Tab)));

  // accordion toggles (delegated; flips OPEN + .open without a full re-render)
  $("#inspBody")!.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("[data-budget-refresh]")) { void refreshBudget(true); return; }
    const head = (e.target as HTMLElement).closest("[data-acc-toggle]") as HTMLElement | null;
    if (head) { const k = head.dataset.accToggle!; const acc = head.closest(".acc")!; const open = acc.classList.toggle("open"); open ? OPEN.add(k) : OPEN.delete(k); return; }
    const act = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
    if (act) {
      const ok = act.dataset.act === "approve";
      showToast({ title: ok ? "Approved" : "Denied", desc: ok ? "Artifact released from quarantine and recorded in the audit log." : "Artifact kept in quarantine. Decision recorded.", actions: [{ label: "OK" }], timeout: 3200 });
    }
  });

  // composer
  const ta = $("#input") as HTMLTextAreaElement;
  ta.addEventListener("input", () => { autosize(ta); setSendEnabled(); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  $("#send")!.addEventListener("click", () => send());

  // sidebar collapse (rail toggle + header collapse), mirroring the right panel
  $("#sideToggle")!.addEventListener("click", () => toggleSidebar());
  $("#sideCollapse")!.addEventListener("click", () => toggleSidebar(true));
  $("#wsBar")!.addEventListener("click", () => openSettings());
  $("#sessList")!.addEventListener("click", (e) => { const s = (e.target as HTMLElement).closest(".sess") as HTMLElement | null; if (s?.dataset.sid) void resumeSession(s.dataset.sid); });
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
  for (const s of state.skills) acts.push({ id: "skill:" + s.name, title: `Skill: ${s.name}`, icon: "bolt", hint: (s.description ?? "").slice(0, 26), run: () => useSkill(s.name) });
  return acts;
});

// ───────────────────────── session config (model / mode / thinking) ─────────────────────────
async function loadConfig(): Promise<void> {
  try {
    state.config = await bridge.config();
    state.commands = await bridge.commands();
    const model = state.config.find((c) => c.id === "model");
    if (model) { state.model = model.currentValue; const mn = $("#modelName"); if (mn) mn.textContent = modelLabel(model.currentValue); }
    updateComposerTools();
  } catch { /* browser/no-session: keep defaults */ }
}

async function applyConfig(configId: string, value: string): Promise<void> {
  const opt = state.config.find((c) => c.id === configId);
  const label = opt?.options.find((o) => o.value === value)?.name ?? value;
  try { state.config = await bridge.setConfig(configId, value); } catch { /* keep optimistic */ }
  const o = state.config.find((c) => c.id === configId); if (o) o.currentValue = value;
  if (configId === "model") { state.model = value; const mn = $("#modelName"); if (mn) mn.textContent = modelLabel(value); renderStatus(); }
  updateComposerTools();
  showToast({ title: `${opt?.name ?? configId} → ${label}`, desc: configId === "model" ? "New turns use this model." : "Applied to the active session.", actions: [{ label: "OK" }], timeout: 2400 });
}

// current, non-deprecated models, newest → oldest (omp also lists stale/dated
// ones - those are filtered out; the live current model is always shown).
const MODEL_ORDER = [
  "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
  "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5",
];
const bareModel = (v: string) => v.replace(/^anthropic\//, "");
const isAsksage = (v: string) => /asksage/i.test(v);
// 5-star rating renderer (filled + dimmed). `cls` colors the filled stars.
const stars5 = (n: number, cls: string) => `<span class="mt-stars ${cls}">${"★".repeat(n)}<span class="mt-dim">${"☆".repeat(5 - n)}</span></span>`;

// One row in a model dropdown: clean name (priority) · a Gov pill for gateway models ·
// the green Intelligence-Level stars. Shared so both pickers render identically. data-model
// drives the premium hover card (Token Expense + Intelligence + best-use + id).
const modelRow = (o: { value: string; name: string }, sel: string) => {
  const info = MODEL_INFO[shortModelId(o.value)];
  const iq = info ? `<span class="row-iq" aria-label="Intelligence ${info.iq} of 5">${"★".repeat(info.iq)}<span class="row-iq-dim">${"☆".repeat(5 - info.iq)}</span></span>` : "";
  return `<div class="cfg-opt ${o.value === sel ? "on" : ""}" data-val="${esc(o.value)}" data-model="${esc(o.value)}"><span class="tick">${icon("check", 13)}</span><span class="nm">${esc(cleanModelName(o.name))}</span>${isAsksage(o.value) ? `<span class="gov-pill">Gov</span>` : ""}${iq}</div>`;
};

// Premium per-model hover card metadata. Two ratings (editorial guidance, NOT a benchmark):
//   exp = Token Expense  (1–5, red)   - how token/cost-heavy the model is (5 = priciest)
//   iq  = Intelligence Level (1–5, green) - raw capability
// plus a one-line description, a practical "best for", and context size. Keyed by short id.
interface ModelInfo { exp: number; iq: number; eff: string; best: string; ctx?: string }
const MODEL_INFO: Record<string, ModelInfo> = {
  // Anthropic (direct)
  "claude-fable-5": { exp: 5, iq: 5, eff: "Frontier capability at a premium price - worth it only when the task needs the ceiling.", best: "The hardest novel reasoning and long-horizon agentic work.", ctx: "1M" },
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
function modelTipHTML(value: string): string | null {
  const info = MODEL_INFO[shortModelId(value)];
  if (!info) return null;
  return `<div class="mt-h"><span class="mt-name">${esc(modelLabel(value))}</span>${isAsksage(value) ? `<span class="gov-pill">Gov</span>` : ""}</div>
    <div class="mt-rate">${stars5(info.exp, "exp")}<span class="mt-rlabel">Token Expense</span></div>
    <div class="mt-rate">${stars5(info.iq, "iq")}<span class="mt-rlabel">Intelligence Level</span></div>
    <div class="mt-eff">${esc(info.eff)}</div>
    <div class="mt-row"><span class="mt-k">Best for</span><span class="mt-v">${esc(info.best)}</span></div>
    ${info.ctx ? `<div class="mt-row"><span class="mt-k">Context</span><span class="mt-v">${esc(info.ctx)} tokens</span></div>` : ""}
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
  const asksage = opt.options.filter((o) => isAsksage(o.value));
  const ensureCurrent = (list: { value: string; name: string }[]) => {
    if (!list.some((o) => o.value === opt.currentValue)) {
      const cur = opt.options.find((o) => o.value === opt.currentValue);
      if (cur) list.unshift(cur); // never hide what's actually selected
    }
    return list;
  };
  // Lockdown: only the gov-gateway models are selectable.
  if (state.asksage?.only) return ensureCurrent(asksage.slice());
  const byBare = new Map(opt.options.map((o) => [bareModel(o.value), o]));
  const list = MODEL_ORDER.map((id) => byBare.get(id)).filter(Boolean) as { value: string; name: string }[];
  for (const a of asksage) if (!list.some((o) => o.value === a.value)) list.push(a); // gov models alongside direct
  return ensureCurrent(list);
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
const MODE_DESC: Record<string, string> = {
  default: "Standard agent mode - reads and edits as needed.",
  plan: "Read-only - drafts a plan to a file before any code changes.",
};
const prettyLevel = (name: string) => { const v = String(name).toLowerCase(); return v === "xhigh" ? "X-High" : v.charAt(0).toUpperCase() + v.slice(1); };
let cfgClose: (() => void) | null = null;

function openConfigPopover(anchor: HTMLElement): void {
  cfgClose?.(); // close any popover already open
  const model = state.config.find((c) => c.id === "model");
  const mode = state.config.find((c) => c.id === "mode");
  const think = state.config.find((c) => c.id === "thinking");
  const models = model ? curatedModels(model) : [];

  const modelSec = model ? `<div class="cfg-sec">
      <div class="cfg-lbl">Model <span class="cur">${esc(modelLabel(model.currentValue))}</span></div>
      <div class="cfg-search">${icon("search", 15)}<input id="cfgModelSearch" placeholder="Search ${models.length} models…" /></div>
      <div class="cfg-list" id="cfgModelList"></div></div>` : "";
  const modeSec = mode ? `<div class="cfg-sec"><div class="cfg-lbl">Mode</div>
      <div class="seg" data-cfg="mode">${mode.options.map((o) =>
        `<button class="${o.value === mode.currentValue ? "on" : ""}" data-val="${esc(o.value)}" data-tip="${esc(o.name)}|${esc(MODE_DESC[o.value] ?? "")}" data-tip-side="top">${esc(o.name)}</button>`).join("")}</div></div>` : "";
  const thinkCur = think?.options.find((o) => o.value === think.currentValue);
  const thinkSec = think ? `<div class="cfg-sec"><div class="cfg-lbl">Thinking</div>
      <div class="cfg-dd" data-dd="thinking">
        <button class="cfg-dd-btn" type="button"><span>${esc(prettyLevel(thinkCur?.name ?? think.currentValue))}</span>${icon("chevron", 14)}</button>
        <div class="cfg-dd-menu">${think.options.map((o) =>
          `<div class="cfg-dd-item ${o.value === think.currentValue ? "on" : ""}" data-val="${esc(o.value)}" data-tip="${esc(prettyLevel(o.name))} thinking|${esc(THINK_DESC[o.value] ?? "")}" data-tip-side="right"><span class="tick">${icon("check", 13)}</span><span>${esc(prettyLevel(o.name))}</span></div>`).join("")}</div>
      </div></div>` : "";

  const { node, close } = popover(anchor, modelSec + modeSec + thinkSec, () => { cfgClose = null; hideModelTip(true); });
  cfgClose = close;

  // searchable model list
  if (model) {
    const list = $("#cfgModelList", node)!;
    const draw = (q = "") => {
      const ql = q.toLowerCase();
      list.innerHTML = models.filter((o) => o.name.toLowerCase().includes(ql) || o.value.toLowerCase().includes(ql))
        .map((o) => modelRow(o, model.currentValue)).join("");
    };
    draw();
    attachModelTips(list); // premium per-model hover cards
    ($("#cfgModelSearch", node) as HTMLInputElement).addEventListener("input", (e) => draw((e.target as HTMLInputElement).value));
    list.addEventListener("click", (e) => { const it = (e.target as HTMLElement).closest("[data-val]") as HTMLElement | null; if (it) { applyConfig("model", it.dataset.val!); close(); } });
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
  const opts = configId === "model" ? curatedModels(c) : c.options;
  const labelOf = (o: { value: string; name: string }) =>
    configId === "model" ? o.name : configId === "thinking" ? prettyLevel(o.name) : o.value === "plan" ? "Plan" : "Agent";
  const rows = (list: { value: string; name: string }[]) => list.map((o) =>
    configId === "model"
      ? modelRow(o, c.currentValue)
      : `<div class="cfg-opt ${o.value === c.currentValue ? "on" : ""}" data-val="${esc(o.value)}"><span class="tick">${icon("check", 13)}</span><span class="nm">${esc(labelOf(o))}</span></div>`).join("");
  const search = configId === "model" ? `<div class="cfg-search">${icon("search", 15)}<input id="miniSearch" placeholder="Search ${opts.length} models…" /></div>` : "";
  const { node, close } = popover(anchor, `<div class="cfg-sec"><div class="cfg-lbl">${esc(c.name)}</div>${search}<div class="cfg-list" id="miniList">${rows(opts)}</div></div>`, () => { cfgClose = null; hideModelTip(true); });
  cfgClose = close;
  const listEl = $("#miniList", node)!;
  if (configId === "model") {
    attachModelTips(listEl); // premium per-model hover cards
    ($("#miniSearch", node) as HTMLInputElement).addEventListener("input", (e) => {
      const q = (e.target as HTMLInputElement).value.toLowerCase();
      listEl.innerHTML = rows(opts.filter((o) => o.name.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)));
    });
  }
  listEl.addEventListener("click", (e) => { const it = (e.target as HTMLElement).closest("[data-val]") as HTMLElement | null; if (it) { applyConfig(configId, it.dataset.val!); close(); } });
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
  } catch { /* ignore */ }
  let active: { which: "sidebar" | "inspector"; el: HTMLElement } | null = null;
  for (const r of $$(".resizer")) {
    r.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const which = (r as HTMLElement).dataset.resize as "sidebar" | "inspector";
      active = { which, el: $(`#${which}`)! };
      document.body.classList.add("resizing");
    });
  }
  window.addEventListener("mousemove", (e) => {
    if (!active) return;
    const rect = active.el.getBoundingClientRect();
    const w = active.which === "sidebar"
      ? Math.max(180, Math.min(520, e.clientX - rect.left))
      : Math.max(300, Math.min(720, rect.right - e.clientX));
    setW(active.which, w);
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
toggleSidebar(true);    // start with the left sessions panel collapsed
setInspectorRail(true); // start with the right inspector slid into the metrics rail
renderStatus();
void loadConfig().then(renderStatus);
void loadWorkspace();
void loadAsksage();
void loadSkills();
refresh();
scheduleBudgetPoll(); // provider budget: re-check every 5 min for the current model
setInterval(refresh, 4000);
setInterval(renderStatus, 1000);
setInterval(() => void renderSessions(), 15000);
