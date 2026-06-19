// desktop/renderer/app.ts — the LucidAgentIDE renderer.
//
// Assembles the shell (titlebar · rail · sidebar · chat · inspector · status),
// wires interaction, polls the live security/memory snapshots, and streams the
// agent turn. Same renderer in Electron (real omp ACP via window.lucid) and in
// the browser dev server (simulated). Pure DOM, no framework.

import { bridge, type ChatEvent, type ConfigOption, type MemorySnapshot, type OmpCommand, type ProviderAuth, type SecuritySnapshot, type SessionInfo, type WorkspaceInfo } from "./bridge.ts";
import { $, $$, accordion, el, fmtNum, gauge, spark, table } from "./dom.ts";
import { ageStr, esc, fmtUSD, goodColor, loadColor } from "./format.ts";
import { icon, piMark } from "./icons.ts";
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
  liveUsage: null as { used: number; size: number; cost: number } | null,
  workspace: null as WorkspaceInfo | null,
  zoom: 1,
  settingsOpen: false,
  lastOk: 0,
  streaming: false,
};
const prettyModel = (v: string) => v.replace(/^anthropic\//, "");
const OPEN = new Set<string>(["sec.quarantine", "sec.approvals", "mem.context", "mem.cache"]);
let lastInspHash = "";

// ───────────────────────── shell ─────────────────────────
function buildShell(): void {
  $("#app")!.appendChild(el(`
  <div id="app-inner" style="display:contents">
    <div class="titlebar">
      <div class="brand"><span class="lucid-word">LUCID</span><span class="pi">${piMark}</span></div>
      <button class="model-badge" id="modelBadge" data-tip="Model · mode · thinking|Click to choose" data-tip-icon="spark">
        <span class="dot"></span><span id="modelName">${esc(prettyModel(state.model))}</span>${icon("chevron", 13)}
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
        <button class="rail-btn" data-rail="memory" data-tip="Memory & context|Context window, KV-cache, semantic memory" data-tip-icon="brain">${icon("brain", 20)}</button>
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
            <button class="side-new" id="sideCollapse" data-tip="Collapse panel" data-tip-side="bottom">${icon("collapse", 15)}</button>
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
            <button class="ctool" id="ctModel" data-tip="Model|Click to change the model">${icon("spark", 14)}<span id="ctModelName">${esc(prettyModel(state.model))}</span>${icon("chevron", 11)}</button>
            <button class="ctool" id="ctMode" data-tip="Mode|Agent edits files · Plan drafts read-only">${icon("bolt", 14)}<span id="ctModeName">Agent</span>${icon("chevron", 11)}</button>
            <button class="ctool" id="ctThink" data-tip="Thinking depth|How hard the model reasons">${icon("brain", 14)}<span id="ctThinkName">High</span>${icon("chevron", 11)}</button>
            <div class="ctool-spacer"></div>
            <span class="ctool-hint"><kbd>Enter</kbd> send · <kbd>⇧↵</kbd> newline · <kbd>⌘K</kbd> commands</span>
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
  if (sessions === null) { list.innerHTML = `<div class="side-empty">Couldn't load history — the GUI server looks out of date. Relaunch it (launcher → <b>G</b>), or restart <code>bun run desktop:web</code>.</div>`; return; }
  if (!sessions.length) { list.innerHTML = `<div class="side-empty">No sessions yet — send a prompt to start one. They persist here across runs.</div>`; return; }
  list.innerHTML = sessions.map((s, i) => `
    <div class="sess ${i === 0 ? "active" : ""}" data-sid="${esc(s.id)}" data-tip="${esc(s.title)}|${esc(prettyModel(s.model))} · ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${relTime(s.updatedAt)}" data-tip-side="right">
      <div class="t">${esc(s.title)}</div>
      <div class="m"><b>${esc(prettyModel(s.model))}</b> · ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${relTime(s.updatedAt)}</div>
    </div>`).join("");
}

// ───────────────────────── chat ─────────────────────────
function seedThread(): void {
  $("#thread")!.innerHTML = `<div class="chat-hint" id="chatHint">
    <div class="bs">${piMark}</div>
    <div class="h">Ask the agent anything</div>
    <div class="d">Real omp replies — every tool call is scanned by the security gate before it runs.</div></div>`;
}
function addMessage(role: "user" | "assistant", text: string): HTMLElement {
  $("#chatHint")?.remove();
  const node = el(`<div class="msg ${role}">
    <div class="who">${role === "user" ? "You" : "LucidAgent"}</div>
    <div class="av">${role === "user" ? icon("user", 16) : piMark}</div>
    <div class="text"></div></div>`);
  ($(".text", node) as HTMLElement).innerHTML = mdInline(text);
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
const mdInline = (t: string) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>");
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
    if (e.type === "token") { buf += e.text; textEl.innerHTML = mdInline(buf) + `<span class="cursor"></span>`; scrollChat(); }
    else if (e.type === "tool") addEvent(`<div class="evt tool">${icon("eye", 15)}<span class="k">${esc(e.name)}</span><span>${esc(e.detail)}</span></div>`);
    else if (e.type === "block") onBlock(e);
    else if (e.type === "usage") { state.liveUsage = { used: e.used, size: e.size, cost: e.cost }; renderStatus(); renderMetricsRail(); }
    else if (e.type === "done") { textEl.innerHTML = mdInline(buf); state.streaming = false; setSendEnabled(); }
  };
  try { await bridge.sendPrompt(text, onEvent); }
  finally { if (state.streaming) { textEl.innerHTML = mdInline(buf); state.streaming = false; setSendEnabled(); } void renderSessions(); }
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
    tile(`${Math.round(hit * 100)}%`, "cache", "g", "KV-cache hit rate — higher means the frozen prefix is paying off") +
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
        <input type="password" class="prov-key" data-env="${esc(p.env)}" placeholder="${p.keySet ? `saved ••${last4} — type to replace` : `Paste ${esc(p.env)}…`}" />
        <button class="btn-mini ok" data-savekey="${esc(p.env)}">${icon("check", 12)} Save</button>
        ${p.keySet ? `<button class="btn-mini" data-clearkey="${esc(p.env)}">Clear</button>` : ""}
      </div></div></div>`;
}
async function renderSettings(): Promise<void> {
  const body = $("#setBody"); if (!body) return;
  const [settings, auth, ws] = await Promise.all([bridge.getSettings(), bridge.auth(), bridge.workspace()]);
  if (ws) { state.workspace = ws; renderWorkspaceBar(); }
  body.innerHTML = `
    ${ws ? workspaceSection(ws) : ""}
    <div class="set-sec"><div class="set-lbl">Profile</div>
      <div class="prov-row"><input id="setUsername" class="prov-key" placeholder="Your name" value="${esc(settings?.username ?? "")}" />
        <button class="btn-mini ok" id="saveUsername">${icon("check", 12)} Save</button></div></div>
    <div class="set-sec"><div class="set-lbl">Providers <span class="set-sub">key or OAuth · majors first</span></div>
      ${(auth?.majors ?? []).map(provCard).join("") || `<div class="empty">couldn't read auth — is the server up to date?</div>`}</div>
    ${accordion("set.others", "More providers", "", (auth?.others ?? []).map(provCard).join(""), OPEN.has("set.others"))}
    <div class="set-note">${icon("shield", 12)} Keys are stored on this machine and passed to omp as env vars — never sent anywhere else. OAuth uses omp's own secure credential vault.</div>`;
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
      <input class="prov-key" id="wsCloneUrl" placeholder="Clone a git repo — https://github.com/… or gitlab.com/…" />
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
    <div class="sec-intro-d">Every tool call the agent makes — shell commands, file writes, and any fetched or imported text — is scanned for hidden-Unicode prompt injection (zero-width characters, look-alike homoglyphs, bidi tricks) <b>before it runs</b>. Anything quarantined is blocked fail-closed, and content from suspicious sources can't quietly promote itself into memory.</div>
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
  h += accordion("sec.gate", "Memory-promotion gate", "keystone #2",
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
  if (!d) return `<div class="empty">No omp session yet — launch omp and send a message.</div>`;
  let h = "";
  const s = d.session;
  if (s) {
    h += accordion("mem.context", "Context window", `${s.model} · ${s.turns} turns`,
      gauge("current", s.current / s.window, `${fmtNum(s.current)} / ${fmtNum(s.window)}`)
      + gauge("peak", s.peak / s.window, `${fmtNum(s.peak)} / ${fmtNum(s.window)}`)
      + spark(s.prompts) + `<div class="kv" style="margin-top:6px;border:0;background:transparent;padding-left:0">prompt tokens per turn</div>`,
      OPEN.has("mem.context"));
    h += accordion("mem.cache", "KV-cache efficiency", "frozen prefix → cache hits",
      gauge("hit rate", s.cache.hit, "", true)
      + `<div class="kvs"><span class="kv">read <b>${fmtNum(s.cache.read)}</b></span><span class="kv">written <b>${fmtNum(s.cache.write)}</b></span><span class="kv">fresh <b>${fmtNum(s.cache.fresh)}</b></span><span class="kv">cost <b>${fmtUSD(s.cost)}</b></span></div>`,
      OPEN.has("mem.cache"));
  } else {
    h += `<div class="empty">No omp session transcript yet — launch omp and send a message.</div>`;
  }
  if (d.compaction) {
    h += accordion("mem.compaction", "Compaction policy", "keeps context bounded",
      table([{ key: "setting", label: "setting" }, { key: "value", label: "value", mono: true }], Object.entries(d.compaction).map(([setting, value]) => ({ setting, value }))),
      OPEN.has("mem.compaction"));
  }
  if (d.budgets?.length) {
    h += accordion("mem.budget", "Provider budget", "omp's last-seen snapshot",
      d.budgets.map((b) => gauge(b.label.replace(/^Claude /, ""), b.used, `<span style="color:var(--txt-4)">${esc(b.status)} · ${ageStr(b.resetsAt)}</span>`)).join(""),
      OPEN.has("mem.budget"), `${d.budgets.length}`);
  }
  if (d.harness) {
    const hm = d.harness;
    h += accordion("mem.layers", "Memory layers", "working · archive · semantic",
      table([{ key: "layer", label: "layer" }, { key: "rows", label: "rows", mono: true }, { key: "detail", label: "detail" }], hm.layers)
      + `<div class="kvs"><span class="kv">promoted <b style="color:var(--green)">${hm.gate.promoted}</b></span><span class="kv">blocked <b style="color:var(--red)">${hm.gate.blocked}</b></span></div>`
      + (hm.facts.length ? table([{ key: "entity", label: "entity" }, { key: "statement", label: "statement" }, { key: "trust_label", label: "trust", pill: true }], hm.facts) : ""),
      OPEN.has("mem.layers"));
  } else {
    h += `<div class="empty">No harness memory yet — appears once the gate runs, or run <code>bun run demo-P4.3</code>.</div>`;
  }
  return h;
}

const RICHTIP_DUCKDB = `<div class="rt-h">${icon("shield", 14)} Where this is stored</div>
  <div class="rt-d">Scans, findings, approvals, and the export audit live in a local embedded <b>DuckDB</b> column store on your machine — fast analytics, and nothing leaves the device. The panels here are read-only views over it.</div>
  <a class="rt-link" href="https://duckdb.org" target="_blank" rel="noopener noreferrer">duckdb.org ${icon("expand", 12)}</a>`;

// ───────────────────────── status bar ─────────────────────────
function renderStatus(): void {
  const m = state.memory, s = m?.session;
  const lu = state.liveUsage;
  const curTok = lu ? lu.used : (s?.current ?? 0);
  const winTok = lu ? lu.size : (s?.window ?? 0);
  const ctx = winTok ? curTok / winTok : 0;
  const cost = lu ? lu.cost : (s?.cost ?? 0);
  const hit = s?.cache.hit ?? 0;
  const budget = m?.budgets?.[0];
  const ago = state.lastOk ? Math.round((Date.now() - state.lastOk) / 1000) : null;
  $("#statusbar")!.innerHTML = `
    <div class="seg" data-tip="Active model|Click the badge to change">${icon("spark", 14)} <b>${esc(prettyModel(state.model))}</b></div>
    <div class="seg" data-tip="Context window|How full the model's context is${lu ? " (live this session)" : ""}">${icon("brain", 14)}
      <span class="mini"><span class="fill" style="width:${Math.round(ctx * 100)}%;background:${loadColor(ctx)}"></span></span>
      <b>${fmtNum(curTok)}</b>/${fmtNum(winTok)}</div>
    <div class="seg" data-tip="KV-cache hit rate|Higher = the frozen prefix is paying off (invariant #6)">${icon("bolt", 14)} cache <b style="color:${goodColor(hit)}">${Math.round(hit * 100)}%</b></div>
    ${budget ? `<div class="seg" data-tip="${esc(budget.label)} usage|omp's last-seen value — updates when omp makes a call, so it can lag the official Claude usage.">${esc(budget.label)} <b>${Math.round(budget.used * 100)}%</b></div>` : ""}
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
    // historical snapshot — so it shows what the next turn will actually use.
    state.lastOk = Date.now();
    const awaiting = sec?.approvals.length ?? 0;
    const badge = $("#railBadge")!;
    badge.hidden = awaiting === 0; badge.textContent = String(awaiting);
    renderInspector(); renderStatus(); renderMetricsRail();
  } catch {
    renderStatus();
  }
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
  if (model) set("#ctModelName", prettyModel(model.currentValue));
  if (mode) set("#ctModeName", mode.currentValue === "plan" ? "Plan" : "Agent");
  if (think) { const cur = think.options.find((o) => o.value === think.currentValue); set("#ctThinkName", prettyLevel(cur?.name ?? think.currentValue)); }
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
      showToast({ title: "Cloning…", desc: "Fetching the repo — this can take a moment.", timeout: 2500 });
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
      return;
    }
    const clear = t.closest("[data-clearkey]") as HTMLElement | null;
    if (clear) { await bridge.saveKey(clear.dataset.clearkey!, ""); void renderSettings(); return; }
    const oauth = t.closest("[data-oauth]") as HTMLElement | null;
    if (oauth) {
      const r = await bridge.oauthLogin(oauth.dataset.oauth!);
      if (r?.url) window.open(r.url, "_blank");
      showToast({ title: "OAuth started", desc: r?.url ? "Complete the sign-in in your browser, then return — status updates automatically." : (r?.output?.slice(0, 160) || "Follow omp's prompt in the GUI server window."), actions: [{ label: "OK" }], timeout: 6000 });
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
  showToast({ title: `/${c.name}`, desc: `${c.description ?? "omp command"} — press Enter to run${c.hint ? ` (args: ${c.hint})` : ""}.`, actions: [{ label: "OK" }], timeout: 3400 });
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
  return acts;
});

// ───────────────────────── session config (model / mode / thinking) ─────────────────────────
async function loadConfig(): Promise<void> {
  try {
    state.config = await bridge.config();
    state.commands = await bridge.commands();
    const model = state.config.find((c) => c.id === "model");
    if (model) { state.model = model.currentValue; const mn = $("#modelName"); if (mn) mn.textContent = prettyModel(model.currentValue); }
    updateComposerTools();
  } catch { /* browser/no-session: keep defaults */ }
}

async function applyConfig(configId: string, value: string): Promise<void> {
  const opt = state.config.find((c) => c.id === configId);
  const label = opt?.options.find((o) => o.value === value)?.name ?? value;
  try { state.config = await bridge.setConfig(configId, value); } catch { /* keep optimistic */ }
  const o = state.config.find((c) => c.id === configId); if (o) o.currentValue = value;
  if (configId === "model") { state.model = value; const mn = $("#modelName"); if (mn) mn.textContent = prettyModel(value); renderStatus(); }
  updateComposerTools();
  showToast({ title: `${opt?.name ?? configId} → ${label}`, desc: configId === "model" ? "New turns use this model." : "Applied to the active session.", actions: [{ label: "OK" }], timeout: 2400 });
}

// current, non-deprecated models, newest → oldest (omp also lists stale/dated
// ones — those are filtered out; the live current model is always shown).
const MODEL_ORDER = [
  "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
  "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5",
];
const bareModel = (v: string) => v.replace(/^anthropic\//, "");
function curatedModels(opt: ConfigOption): { value: string; name: string }[] {
  const byBare = new Map(opt.options.map((o) => [bareModel(o.value), o]));
  const list = MODEL_ORDER.map((id) => byBare.get(id)).filter(Boolean) as { value: string; name: string }[];
  if (!list.some((o) => o.value === opt.currentValue)) {
    const cur = opt.options.find((o) => o.value === opt.currentValue);
    if (cur) list.unshift(cur); // never hide what's actually selected
  }
  return list;
}
const THINK_DESC: Record<string, string> = {
  off: "Fastest replies — simple edits, lookups, and quick chat.",
  auto: "Lets the model choose how hard to think — a balanced default.",
  minimal: "Light reasoning for quick, well-scoped tasks.",
  low: "Small multi-step tasks and straightforward debugging.",
  medium: "Everyday coding, refactors, and code review.",
  high: "Hard bugs, architecture, and multi-file changes.",
  xhigh: "Deepest reasoning for the most complex, novel problems.",
};
const MODE_DESC: Record<string, string> = {
  default: "Standard agent mode — reads and edits as needed.",
  plan: "Read-only — drafts a plan to a file before any code changes.",
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
      <div class="cfg-lbl">Model <span class="cur">${esc(prettyModel(model.currentValue))}</span></div>
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

  const { node, close } = popover(anchor, modelSec + modeSec + thinkSec, () => { cfgClose = null; });
  cfgClose = close;

  // searchable model list
  if (model) {
    const list = $("#cfgModelList", node)!;
    const draw = (q = "") => {
      const ql = q.toLowerCase();
      list.innerHTML = models.filter((o) => o.name.toLowerCase().includes(ql) || o.value.toLowerCase().includes(ql))
        .map((o) => `<div class="cfg-opt ${o.value === model.currentValue ? "on" : ""}" data-val="${esc(o.value)}">
          <span class="tick">${icon("check", 13)}</span><span class="nm">${esc(o.name)}</span><span class="id">${esc(bareModel(o.value))}</span></div>`).join("");
    };
    draw();
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

/** A focused single-option dropdown (used by the composer chips) — one config at
 *  a time. omp exposes exactly two modes: Default (Agent) and Plan. */
function openOptionDropdown(anchor: HTMLElement, configId: string): void {
  cfgClose?.();
  const c = state.config.find((x) => x.id === configId);
  if (!c) return;
  const opts = configId === "model" ? curatedModels(c) : c.options;
  const labelOf = (o: { value: string; name: string }) =>
    configId === "model" ? o.name : configId === "thinking" ? prettyLevel(o.name) : o.value === "plan" ? "Plan" : "Agent";
  const rows = (list: { value: string; name: string }[]) => list.map((o) =>
    `<div class="cfg-opt ${o.value === c.currentValue ? "on" : ""}" data-val="${esc(o.value)}"><span class="tick">${icon("check", 13)}</span><span class="nm">${esc(labelOf(o))}</span>${configId === "model" ? `<span class="id">${esc(bareModel(o.value))}</span>` : ""}</div>`).join("");
  const search = configId === "model" ? `<div class="cfg-search">${icon("search", 15)}<input id="miniSearch" placeholder="Search ${opts.length} models…" /></div>` : "";
  const { node, close } = popover(anchor, `<div class="cfg-sec"><div class="cfg-lbl">${esc(c.name)}</div>${search}<div class="cfg-list" id="miniList">${rows(opts)}</div></div>`, () => { cfgClose = null; });
  cfgClose = close;
  const listEl = $("#miniList", node)!;
  if (configId === "model") {
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
renderStatus();
void loadConfig().then(renderStatus);
void loadWorkspace();
refresh();
setInterval(refresh, 4000);
setInterval(renderStatus, 1000);
setInterval(() => void renderSessions(), 15000);
