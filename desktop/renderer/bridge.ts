// desktop/renderer/bridge.ts
//
// The single seam between the UI and the outside world. Dashboards, chat, and
// session config all go over the dev server's HTTP API - which is backed by a
// REAL `omp acp` session (desktop/acp_backend.ts), so prompts produce genuine
// model replies in both the browser build and Electron. The only thing that is
// native-only is window controls + crisp text zoom, exposed by the Electron
// preload as `window.lucid`; in a plain browser those fall back to CSS zoom.

export interface BlockRecord { id: string; tool: string; severity: string; findings: string; reason: string; at: string; status: "quarantined" | "approved"; reviewer?: string }
export interface SecuritySnapshot {
  findings: any[]; unicode: any[]; approvals: any[]; quarantine: any[];
  promotion: any[]; exports: any[]; runs: any[];
  // GUI-owned LIVE gate blocks (ADR-0019 C) - present even when the DuckDB views are empty.
  live?: { quarantined: BlockRecord[]; approved: BlockRecord[]; total: number };
}
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

// ADR-0009 Phase D: read-only developer Logs view (gated on Developer mode).
export interface TurnView { id: string; sessionId: string; seq: number; role: string; sanitized: string; rawSha256: string; trust: string; at: string }
export interface DevView {
  enabled: boolean;
  snapshot: { telemetry: any[]; runs: any[]; exports: any[] } | null;
  blocks: { quarantined: BlockRecord[]; approved: BlockRecord[]; total: number };
  // ADR-0009 Phase B (issue #12): captured prompt/response transcripts (sanitized; raw by sha).
  turns: TurnView[];
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
export interface ConfigOption {
  id: string; name: string; category: string; type: string;
  currentValue: string; options: { value: string; name: string }[];
}
export interface ModeOption { id: string; name: string; description?: string }
export interface ModeState { available: ModeOption[]; current: string; ui?: "agent" | "ask" | "plan"; permissionMode?: "auto" | "ask" }
export interface OmpCommand { name: string; description?: string; hint?: string }
export interface SessionInfo { id: string; title: string; model: string; updatedAt: number; turns: number }
export interface ProviderAuth {
  id: string; name: string; env: string; oauthId: string; canOauth: boolean;
  oauthActive: boolean; oauthIdentity?: string; keySet: boolean; keyLast4?: string;
}
export interface AuthStatus { majors: ProviderAuth[]; others: ProviderAuth[] }
export interface HeadroomStatus {
  installed: boolean; version: string | null; running: boolean; enabled: boolean;
  port: number; url: string; installHint: string;
}
export type PersonalScopeView = "work" | "personal" | "cui" | "combined";
export interface PersonalStatus {
  enabled: boolean; configured: boolean; unlocked: boolean;
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
export interface PersonalImportResult { ok: boolean; error?: string; vendor?: "openai" | "anthropic" | "gemini"; conversations?: number; messages?: number; learned?: number; blocked?: number; skipped?: number; extractor?: "heuristic" | "model" }
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

export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "subagent"; id: string; agent: string; title: string; assignments: string[] }
  | { type: "block"; tool: string; reason: string; severity: string; findings: string; id?: string; quarantined?: boolean }
  | { type: "permission"; id: string; tool: string; detail: string; options: { optionId: string; name: string; kind?: string }[] }
  | { type: "usage"; used: number; size: number; cost: number }
  | { type: "done" };

export interface Attribution {
  identity: string; source: "email" | "workstation"; email: string; workstation: string; decided: boolean;
  // Enterprise-managed policy view (ADR-0030): drives the prompt + "Managed by …" UI.
  managed: boolean; orgName: string; requireEmail: boolean; allowSkip: boolean; allowedDomains: string[];
}
export interface ProfileSettings {
  username: string;
  email: string;
  // Effective code-activity attribution identity (ADR-0030): email if set, else workstation hostname.
  attribution?: Attribution;
}
export interface ManagedPolicy {
  managed: boolean; orgName: string;
  attribution: { requireEmail?: boolean; allowSkip?: boolean; allowedEmailDomains?: string[] } | null;
  asksageOnly: boolean;
}
export interface LucidBridge {
  isElectron: boolean;
  security(): Promise<SecuritySnapshot | null>;
  /** Release one quarantined call - the audited fail-closed override (ADR-0019 C). */
  securityApprove(id: string): Promise<BlockRecord | null>;
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
  usage(): Promise<UsageLedger | null>;
  sendPrompt(text: string, onEvent: (e: ChatEvent) => void): Promise<void>;
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
  commands(): Promise<OmpCommand[]>;
  skills(): Promise<{ name: string; description: string; source: string }[] | null>;
  // P-IDE.2: set/clear the active bundled skill (its trusted prompt rides the user-turn preamble).
  setActiveSkill(name: string, prompt: string): Promise<{ active: string } | null>;
  clearActiveSkill(): Promise<{ active: string } | null>;
  // P-IDE.3: record a skill activation as telemetry (metadata only).
  skillActivated(command: string, name: string, source: "bundled" | "project" | "task"): Promise<unknown>;
  sessions(): Promise<SessionInfo[] | null>;
  sessionMessages(id: string): Promise<{ role: string; text: string }[] | null>;
  resumeSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<{ ok: boolean; error?: string }>;
  newSession(): Promise<void>;
  setZoom(factor: number): void;
  // settings + provider auth
  getSettings(): Promise<ProfileSettings | null>;
  saveUsername(username: string): Promise<ProfileSettings | null>;
  // Corporate email = attribution identity (ADR-0030). Save email (and/or username) together.
  saveProfile(p: { username?: string; email?: string }): Promise<ProfileSettings | null>;
  // User skips the email prompt → attribute by workstation hostname instead (recorded, traceable).
  skipEmail(): Promise<ProfileSettings | null>;
  // Enterprise-managed policy (read-only; placed by admins via GPO/MDM).
  managed(): Promise<ManagedPolicy | null>;
  // P-IDE.1c: China-origin model data-sovereignty acknowledgement gate.
  chinaAck(): Promise<{ acknowledged: boolean } | null>;
  setChinaAck(acknowledge: boolean): Promise<{ acknowledged: boolean } | null>;
  auth(): Promise<AuthStatus | null>;
  saveKey(env: string, key: string): Promise<AuthStatus | null>;
  oauthLogin(oauthId: string): Promise<{ started: boolean; url: string; output: string } | null>;
  oauthLogout(oauthId: string): Promise<AuthStatus | null>;
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
  // personalization knowledge graph (opt-in, encrypted - ADR-0010/0012)
  personal(): Promise<PersonalStatus | null>;
  personalEnable(enabled: boolean): Promise<PersonalStatus | null>;
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
  // P9.7: import a ChatGPT / Claude / Gemini data export (folder, .json, or .zip) into the active
  // compartment, through the fail-closed gate. `model` runs the richer LLM extractor (capped).
  personalImport(path: string, model?: boolean): Promise<PersonalImportResult | null>;
  // P-IMP.2: read-only pre-import estimate (counts) for the AI-mode token/time warning.
  personalImportEstimate(path: string): Promise<PersonalImportEstimate | null>;
  // P-IDE.5: in-app editor — read a workspace file, and save the buffer THROUGH the scanner gate.
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
  listDir(path?: string): Promise<FsList | null>; // in-app folder browser (works everywhere)
}

/** Native shell injected by the Electron preload (window controls + crisp zoom). */
interface NativeShell {
  isElectron?: boolean;
  setZoom?(factor: number): void;
  pickFolder?(): Promise<string | null>;
  win?: { minimize(): void; toggleMaximize(): void; close(): void };
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

async function streamChat(text: string, onEvent: (e: ChatEvent) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/chat", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ text }) });
  } catch {
    onEvent({ type: "token", text: "[chat backend unreachable - is the GUI server running?]" });
    onEvent({ type: "done" });
    return;
  }
  if (res.status === 404) { onEvent({ type: "token", text: "[chat backend is out of date - close the GUI server window and relaunch (launcher → G)]" }); onEvent({ type: "done" }); return; }
  if (!res.ok || !res.body) { onEvent({ type: "token", text: `[chat backend error ${res.status}]` }); onEvent({ type: "done" }); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const flush = (line: string) => { const s = line.trim(); if (s) { try { onEvent(JSON.parse(s)); } catch { /* skip */ } } };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) { flush(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  flush(buf);
}

export const bridge: LucidBridge = {
  isElectron: !!shell?.isElectron,
  security: () => getData("/api/security"),
  securityApprove: (id) => post("/api/security/approve", { id }),
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
  usage: () => getData("/api/usage"),
  sendPrompt: streamChat,
  config: async () => (await getData("/api/config")) ?? FALLBACK_CONFIG,
  refreshConfig: async () => (await post("/api/config/refresh", {})) ?? FALLBACK_CONFIG,
  setConfig: async (id, value) => (await post("/api/setConfig", { configId: id, value })) ?? FALLBACK_CONFIG,
  modes: () => getData("/api/modes"),
  setMode: (modeId) => post("/api/modes", { modeId }),
  setUiMode: (uiMode) => post("/api/uimode", { uiMode }),
  respondPermission: (id, optionId) => post("/api/chat/permission", { id, optionId }),
  cancelChat: () => post("/api/chat/cancel", {}),
  commands: async () => (await getData("/api/commands")) ?? [],
  skills: () => getData("/api/skills"),
  setActiveSkill: (name, prompt) => post("/api/skill", { name, prompt }),
  clearActiveSkill: () => post("/api/skill", { clear: true }),
  skillActivated: (command, name, source) => post("/api/skill/activated", { command, name, source }),
  sessions: async () => {
    try {
      const r = await fetch("/api/sessions", { cache: "no-store", headers: authHeaders() });
      if (r.status === 404) return null; // server predates the sessions route → out of date
      return (await r.json())?.data ?? [];
    } catch { return null; }
  },
  sessionMessages: (id) => getData(`/api/session?id=${encodeURIComponent(id)}`),
  resumeSession: async (id) => { await post("/api/session/load", { id }); },
  deleteSession: async (id) => (await post("/api/session/delete", { id })) ?? { ok: false, error: "no response" },
  newSession: async () => { await post("/api/newSession", {}); },
  getSettings: () => getData("/api/settings"),
  saveUsername: (username) => post("/api/settings", { username }),
  saveProfile: (p) => post("/api/settings", p),
  skipEmail: () => post("/api/settings", { skip: true }),
  managed: () => getData("/api/managed"),
  chinaAck: () => getData("/api/china-ack"),
  setChinaAck: (acknowledge) => post("/api/china-ack", { acknowledge }),
  auth: () => getData("/api/auth"),
  saveKey: (env, key) => post("/api/auth/key", { env, key }),
  oauthLogin: (oauthId) => post("/api/auth/oauth", { oauthId }),
  oauthLogout: (oauthId) => post("/api/auth/logout", { oauthId }),
  asksage: () => getData("/api/asksage"),
  saveAsksage: (opts) => post("/api/asksage", opts),
  asksageTokens: () => getData("/api/asksage/tokens"),
  asksageDatasets: () => getData("/api/asksage/datasets"),
  asksagePersonas: () => getData("/api/asksage/personas"),
  applyPersona: (id) => post("/api/asksage/persona", id ? { id } : { clear: true }),
  headroom: () => getData("/api/headroom"),
  setHeadroom: (enabled) => post("/api/headroom", { enabled }),
  personal: () => getData("/api/personal"),
  personalEnable: (enabled) => post("/api/personal/enable", { enabled }),
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
  personalImport: (path, model) => post("/api/personal/import", { path, model: !!model }),
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
  listDir: (path) => getData(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  setZoom: (f) => {
    if (shell?.setZoom) { shell.setZoom(f); return; } // Electron: crisp native zoom
    // Browser: zoom #app and counter-scale its height so it still fills the viewport
    // exactly (so the layout reflows and the chat keeps its own scroll).
    const app = document.getElementById("app");
    if (app) { (app.style as any).zoom = String(f); app.style.height = `calc(100vh / ${f})`; }
  },
};
