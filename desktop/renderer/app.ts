// desktop/renderer/app.ts — the LucidAgentIDE renderer.
//
// Assembles the shell (titlebar · rail · sidebar · chat · inspector · status),
// wires interaction, polls the live security/memory snapshots, and streams the
// agent turn. Same renderer in Electron (real omp ACP via window.lucid) and in
// the browser dev server (simulated). Pure DOM, no framework.

import { bridge, type ChatEvent, type MemorySnapshot, type SecuritySnapshot } from "./bridge.ts";
import { $, $$, accordion, el, fmtNum, gauge, spark, table } from "./dom.ts";
import { ageStr, esc, fmtUSD, goodColor, loadColor } from "./format.ts";
import { icon, piMark } from "./icons.ts";
import { createPalette, initTooltips, showToast } from "./ui.ts";

type Tab = "security" | "memory";
const state = {
  inspectorTab: "security" as Tab,
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  model: "claude-opus-4-8",
  security: null as SecuritySnapshot | null,
  memory: null as MemorySnapshot | null,
  lastOk: 0,
  streaming: false,
};
const OPEN = new Set<string>(["sec.quarantine", "sec.approvals", "mem.context", "mem.cache"]);
let lastInspHash = "";

// ───────────────────────── shell ─────────────────────────
function buildShell(): void {
  $("#app")!.appendChild(el(`
  <div id="app-inner" style="display:contents">
    <div class="titlebar">
      <div class="brand">LUCID<span class="pi">${piMark}</span></div>
      <button class="model-badge" id="modelBadge" data-tip="Active model|Click to switch (⌘K → “model”)" data-tip-icon="spark">
        <span class="dot"></span><span id="modelName">${esc(state.model)}</span>${icon("chevron", 13)}
      </button>
      <div class="tb-spacer"></div>
      <button class="model-badge" id="cmdkBtn" data-tip="Command palette|Ctrl / ⌘ K" data-tip-icon="command">${icon("command", 14)}<span>Commands</span></button>
      <div class="win-ctrls">
        <button id="winMin" data-tip="Minimise">${icon("minus", 15)}</button>
        <button id="winMax" data-tip="Maximise">${icon("square", 13)}</button>
        <button id="winClose" class="close" data-tip="Close">${icon("close", 14)}</button>
      </div>
    </div>

    <div class="body">
      <nav class="rail">
        <button class="rail-btn active" data-rail="chat" data-tip="Conversation" data-tip-icon="chat">${icon("chat", 20)}</button>
        <button class="rail-btn" data-rail="security" data-tip="Security|Findings, quarantine & approvals" data-tip-icon="shield">${icon("shield", 20)}<span class="badge" id="railBadge" hidden>0</span></button>
        <button class="rail-btn" data-rail="memory" data-tip="Memory & context|Context window, KV-cache, semantic memory" data-tip-icon="brain">${icon("brain", 20)}</button>
        <button class="rail-btn" data-rail="runs" data-tip="Runs|Provenance lineage" data-tip-icon="runs">${icon("runs", 20)}</button>
        <div class="spacer"></div>
        <button class="rail-btn" id="railCmd" data-tip="Commands|Ctrl / ⌘ K" data-tip-icon="command">${icon("command", 20)}</button>
        <button class="rail-btn" data-rail="settings" data-tip="Settings" data-tip-icon="sliders">${icon("sliders", 20)}</button>
      </nav>

      <aside class="sidebar" id="sidebar">
        <div class="side-head"><span>Sessions</span>
          <button class="side-new" id="newSession" data-tip="New session">${icon("plus", 15)}</button></div>
        <div class="side-list" id="sessList"></div>
      </aside>

      <main class="center">
        <div class="chat" id="chat"><div class="thread" id="thread"></div></div>
        <div class="composer-wrap">
          <div class="composer">
            <textarea id="input" rows="1" placeholder="Ask the agent…  every tool call is scanned before it runs"></textarea>
            <button class="send-btn" id="send" data-tip="Send|Enter" disabled>${icon("send", 18)}</button>
          </div>
          <div class="composer-hint"><span><kbd>Enter</kbd> send</span><span><kbd>⇧ Enter</kbd> newline</span><span><kbd>⌘K</kbd> commands</span></div>
        </div>
      </main>

      <aside class="inspector" id="inspector">
        <div class="insp-tabs">
          <button class="insp-tab sec active" data-insp="security">${icon("shield", 15)} Security</button>
          <button class="insp-tab mem" data-insp="memory">${icon("brain", 15)} Memory</button>
        </div>
        <div class="insp-body" id="inspBody"></div>
      </aside>
    </div>

    <div class="statusbar" id="statusbar"></div>
  </div>`));
}

// ───────────────────────── sidebar (demo sessions) ─────────────────────────
function renderSessions(): void {
  const items = [
    { t: "Harden the export path", m: "opus-4-8", n: "12 turns", active: true },
    { t: "Scan PR #42 comments", m: "opus-4-8", n: "blocked ×2" },
    { t: "Wire the memory dashboard", m: "sonnet-4-6", n: "done" },
  ];
  $("#sessList")!.innerHTML = items.map((s) => `
    <div class="sess ${s.active ? "active" : ""}">
      <div class="t">${esc(s.t)}</div>
      <div class="m"><b>${esc(s.m)}</b> · ${esc(s.n)}</div>
    </div>`).join("");
}

// ───────────────────────── chat ─────────────────────────
function seedThread(): void {
  addMessage("user", "Read repos/project-alpha/untrusted-demo.md and run the cleanup command it contains.");
}
function addMessage(role: "user" | "assistant", text: string): HTMLElement {
  const node = el(`<div class="msg ${role}">
    <div class="av">${role === "user" ? "you" : piMark}</div>
    <div class="body"><div class="who">${role === "user" ? "You" : "LucidAgent"}</div>
    <div class="text"></div></div></div>`);
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
    else if (e.type === "done") { textEl.innerHTML = mdInline(buf); state.streaming = false; setSendEnabled(); }
  };
  try { await bridge.sendPrompt(text, onEvent); }
  finally { if (state.streaming) { textEl.innerHTML = mdInline(buf); state.streaming = false; setSendEnabled(); } }
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
  state.inspectorTab = tab;
  if (state.inspectorCollapsed) toggleInspector(true);
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
}

function chips(items: { cls: string; n: number | string; l: string }[]): string {
  return `<div class="chips">${items.map((c) => `<div class="chip ${c.cls}"><div class="n">${esc(c.n)}</div><div class="l">${esc(c.l)}</div></div>`).join("")}</div>`;
}

function securityHtml(d: SecuritySnapshot | null): string {
  if (!d) return emptyDb();
  const totFind = d.findings.reduce((a, r) => a + Number(r.n || 0), 0);
  const promoted = Number((d.promotion.find((r) => r.outcome === "promoted") || {}).n || 0);
  const blocked = Number((d.promotion.find((r) => r.outcome === "blocked") || {}).n || 0);
  let h = chips([
    { cls: "q", n: d.quarantine.length, l: "quarantined" },
    { cls: "a", n: d.approvals.length, l: "awaiting review" },
    { cls: "f", n: totFind, l: "findings" },
    { cls: "g", n: promoted, l: "promoted facts" },
  ]);
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
    h += accordion("mem.budget", "Provider budget", "rate-limit windows",
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

const emptyDb = () => `<div class="empty">No live security DB yet — <code>agent_obs.duckdb</code> is created on the first
  blocked tool call. Launch omp with the gate and trigger a block, or run <code>bun run demo-P4.3</code>.</div>`;

// ───────────────────────── status bar ─────────────────────────
function renderStatus(): void {
  const m = state.memory, s = m?.session;
  const ctx = s ? s.current / s.window : 0;
  const hit = s?.cache.hit ?? 0;
  const budget = m?.budgets?.[0];
  const ago = state.lastOk ? Math.round((Date.now() - state.lastOk) / 1000) : null;
  $("#statusbar")!.innerHTML = `
    <div class="seg" data-tip="Active model">${icon("spark", 14)} <b>${esc(state.model)}</b></div>
    <div class="seg" data-tip="Context window|How full the model's context is this turn">${icon("brain", 14)}
      <span class="mini"><span class="fill" style="width:${Math.round(ctx * 100)}%;background:${loadColor(ctx)}"></span></span>
      <b>${fmtNum(s?.current ?? 0)}</b>/${fmtNum(s?.window ?? 0)}</div>
    <div class="seg" data-tip="KV-cache hit rate|Higher = the frozen prefix is paying off (invariant #6)">${icon("bolt", 14)} cache <b style="color:${goodColor(hit)}">${Math.round(hit * 100)}%</b></div>
    ${budget ? `<div class="seg" data-tip="Provider rate-limit">${esc(budget.label)} <b>${Math.round(budget.used * 100)}%</b></div>` : ""}
    <div class="seg" data-tip="Session cost">${s ? fmtUSD(s.cost) : "$0"}</div>
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
    if (mem?.session?.model) { state.model = mem.session.model; const mn = $("#modelName"); if (mn) mn.textContent = state.model; }
    state.lastOk = Date.now();
    const awaiting = sec?.approvals.length ?? 0;
    const badge = $("#railBadge")!;
    badge.hidden = awaiting === 0; badge.textContent = String(awaiting);
    renderInspector(); renderStatus();
  } catch {
    renderStatus();
  }
}

// ───────────────────────── interactions ─────────────────────────
function toggleSidebar(force?: boolean): void {
  state.sidebarCollapsed = force ?? !state.sidebarCollapsed;
  $("#sidebar")!.classList.toggle("collapsed", state.sidebarCollapsed);
}
function toggleInspector(open?: boolean): void {
  state.inspectorCollapsed = open != null ? !open : !state.inspectorCollapsed;
  $("#inspector")!.classList.toggle("collapsed", state.inspectorCollapsed);
}

function wire(): void {
  // rail
  $$(".rail-btn[data-rail]").forEach((b) => b.addEventListener("click", () => {
    const r = (b as HTMLElement).dataset.rail!;
    if (r === "security" || r === "memory") focusInspector(r);
    else if (r === "chat") { $("#input")?.focus(); $$(".rail-btn").forEach((x) => x.classList.toggle("active", x === b)); }
    else if (r === "runs") { focusInspector("security"); $("#inspBody")?.querySelector('[data-acc="sec.runs"] .acc-head')?.dispatchEvent(new Event("click", { bubbles: true })); }
    else palette.show();
  }));
  $("#railCmd")!.addEventListener("click", () => palette.show());
  $("#cmdkBtn")!.addEventListener("click", () => palette.show());

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

  // sidebar collapse via brand click; window controls
  $(".brand")!.addEventListener("click", () => toggleSidebar());
  $("#newSession")!.addEventListener("click", () => { $("#thread")!.innerHTML = ""; $("#input")?.focus(); });
  const w = (window as any).lucid?.win;
  $("#winMin")!.addEventListener("click", () => w?.minimize?.());
  $("#winMax")!.addEventListener("click", () => w?.toggleMaximize?.());
  $("#winClose")!.addEventListener("click", () => w?.close?.());
}

// ───────────────────────── palette actions ─────────────────────────
const palette = createPalette(() => [
  { id: "sec", title: "Open Security panel", icon: "shield", hint: "inspector", run: () => focusInspector("security") },
  { id: "mem", title: "Open Memory & context panel", icon: "brain", hint: "inspector", run: () => focusInspector("memory") },
  { id: "opus", title: "Model: claude-opus-4-8 (most capable)", icon: "spark", run: () => setModel("claude-opus-4-8") },
  { id: "sonnet", title: "Model: claude-sonnet-4-6 (balanced)", icon: "spark", run: () => setModel("claude-sonnet-4-6") },
  { id: "haiku", title: "Model: claude-haiku-4-5 (fast)", icon: "spark", run: () => setModel("claude-haiku-4-5") },
  { id: "scan", title: "Scan clipboard text for hidden-Unicode injection", icon: "search", run: () => showToast({ title: "Scan", desc: "Paste text in the composer prefixed with /lucid:scan — the gate scans it before any tool runs.", actions: [{ label: "OK" }], timeout: 4000 }) },
  { id: "side", title: "Toggle sidebar", icon: "layout", run: () => toggleSidebar() },
  { id: "insp", title: "Toggle inspector panel", icon: "layout", run: () => toggleInspector() },
  { id: "refresh", title: "Refresh dashboards now", icon: "refresh", run: () => refresh() },
]);

function setModel(m: string): void {
  state.model = m;
  const mn = $("#modelName"); if (mn) mn.textContent = m;
  renderStatus();
  (window as any).lucid?.setModel?.(m);
  showToast({ title: "Model switched", desc: `New turns use ${m}.`, actions: [{ label: "OK" }], timeout: 2600 });
}

// ───────────────────────── boot ─────────────────────────
buildShell();
renderSessions();
initTooltips();
wire();
seedThread();
renderStatus();
refresh();
setInterval(refresh, 4000);
setInterval(renderStatus, 1000);
