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

export interface BlockRecord { id: string; tool: string; severity: string; findings: string; reason: string; at: string; status: "quarantined" | "approved" | "dismissed"; reviewer?: string }
export interface SecuritySnapshot {
  findings: any[]; unicode: any[]; approvals: any[]; quarantine: any[];
  promotion: any[]; exports: any[]; runs: any[];
  // GUI-owned LIVE gate blocks (ADR-0019 C) - present even when the DuckDB views are empty.
  live?: { quarantined: BlockRecord[]; approved: BlockRecord[]; dismissed: BlockRecord[]; total: number };
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
export interface ModeOption { id: string; name: string; description?: string }
export interface ModeState { available: ModeOption[]; current: string; ui?: "agent" | "ask" | "plan"; permissionMode?: "auto" | "ask" }
export interface OmpCommand { name: string; description?: string; hint?: string }
export interface SessionInfo { id: string; title: string; model: string; updatedAt: number; turns: number; kind?: "chat" | "kg-ingest" }
// P-KG-INGEST.1b (ADR-0076): chats, with throwaway extraction sessions split into a collapsible group.
export interface SessionList { sessions: SessionInfo[]; ingest: SessionInfo[] }
// P-SKILL.1 (ADR-0045): per-file result of a gated skill import (mirrors desktop/skills_import.ts).
export interface SkillImportResult { ok: boolean; name: string; written?: boolean; path?: string; blocked?: boolean; reason?: string; trustLabel?: string; findings?: number }
export interface ProviderAuth {
  id: string; name: string; env: string; oauthId: string; canOauth: boolean;
  oauthActive: boolean; oauthIdentity?: string; keySet: boolean; keyLast4?: string;
}
export interface AuthStatus { gateway: ProviderAuth[]; majors: ProviderAuth[]; others: ProviderAuth[] }
export interface HeadroomStatus {
  installed: boolean; version: string | null; running: boolean; enabled: boolean;
  port: number; url: string; installHint: string;
}
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

export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; detail: string; code?: { path: string; content?: string; oldText?: string; newText?: string; patch?: string } } // P-CHAT.1: inline code/diff preview
  | { type: "subagent"; id: string; agent: string; title: string; assignments: string[] }
  | { type: "block"; tool: string; reason: string; severity: string; findings: string; id?: string; quarantined?: boolean }
  | { type: "permission"; id: string; tool: string; detail: string; options: { optionId: string; name: string; kind?: string }[]; url?: string; egress?: boolean; localFile?: boolean; exec?: boolean; program?: string; reason?: string; danger?: boolean }
  | { type: "preview-available"; path: string } // P-PREVIEW.2 (ADR-0096): the agent wrote a previewable file
  | { type: "usage"; used: number; size: number; cost: number }
  // P-GOAL.1/3 (ADR-0046): /goal loop events (kept in parity with desktop/acp_backend.ts).
  | { type: "goal-memory"; path: string }
  | { type: "goal-iter"; n: number; max: number }
  | { type: "goal-check"; n: number; done: boolean; reason: string }
  | { type: "goal-done"; iters: number; reason: string }
  | { type: "goal-stop"; reason: string }
  // P-GOAL.9 (ADR-0054): the loop's last task - an After-Action Report (metrics + portable graphs).
  | { type: "goal-report"; path: string; summary: string; markdown: string }
  | { type: "done"; text?: string }; // text = the authoritative full assistant reply (reconciles lossy streaming)
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
}
export interface AutomationSpec { goal: string; condition?: string; command?: string; maxIters?: number; cadence: Cadence }
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
export interface LucidBridge {
  isElectron: boolean;
  security(): Promise<SecuritySnapshot | null>;
  /** Release one quarantined call - the audited fail-closed override (ADR-0019 C). */
  securityApprove(id: string): Promise<BlockRecord | null>;
  securityDismiss(id: string): Promise<BlockRecord | null>;
  /** P-BRIEF.3 (ADR-0072): the Executive Engineering Update generated from the repo's own logs. */
  engineeringBrief(): Promise<{ brief: string; scriptText: string; counts: Record<string, number> } | null>;
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
  codeActivity(): Promise<CodeActivity | null>;
  sendPrompt(text: string, onEvent: (e: ChatEvent) => void): Promise<void>;
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
  skills(): Promise<{ name: string; description: string; source: string }[] | null>;
  // P-SKILL.1 (ADR-0045): import dropped .md skill files - each is scanned at the gate; clean ones are
  // written under .omp/skills/, flagged ones are held for Security-panel review.
  skillImport(files: { name: string; content: string }[]): Promise<{ results: SkillImportResult[] } | null>;
  // P-IDE.2: set/clear the active bundled skill (its trusted prompt rides the user-turn preamble).
  setActiveSkill(name: string, prompt: string): Promise<{ active: string } | null>;
  clearActiveSkill(): Promise<{ active: string } | null>;
  // P-IDE.3: record a skill activation as telemetry (metadata only).
  skillActivated(command: string, name: string, source: "bundled" | "project" | "task"): Promise<unknown>;
  sessions(): Promise<SessionList | null>;
  sessionMessages(id: string): Promise<{ role: string; text: string }[] | null>;
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
  credStore(input: { ref?: string; kind: string; secret: string; label?: string }): Promise<CredMetaView | { error: string }>;
  credList(): Promise<CredMetaView[]>;
  credDelete(ref: string): Promise<boolean>;
  credEncryptionAvailable(): Promise<boolean>;
  // P-NETWL.2 (ADR-0106): curated network-whitelist CRUD (persisted server-side; non-secret).
  whitelistList(): Promise<WhitelistEntryView[]>;
  whitelistUpsert(entry: Partial<WhitelistEntryView>): Promise<WhitelistEntryView | null>;
  whitelistRemove(id: string): Promise<void>;
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
  listDir(path?: string): Promise<FsList | null>; // in-app folder browser (works everywhere)
  revealPath(path: string): Promise<boolean>; // open a folder in the OS file manager (Electron only; false in browser)
  canRevealPath(): boolean; // whether the native shell can reveal a folder (Electron only)
}

/** Non-secret metadata about a vault credential (P-NETWL.1, ADR-0106). No plaintext ever crosses this line. */
export interface CredMetaView { ref: string; kind: string; label?: string; createdAt?: number }

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
  win?: { minimize(): void; toggleMaximize(): void; close(): void };
  // P-NETWL.1 (ADR-0106): native file picker + OS-encrypted credential vault (Electron-only).
  pickFile?(opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  credStore?(input: { ref?: string; kind: string; secret: string; label?: string }): Promise<CredMetaView | { error: string }>;
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
const streamChat = (text: string, onEvent: (e: ChatEvent) => void) => {
  chatAbort?.abort();
  chatAbort = new AbortController();
  return streamNdjson("/api/chat", { text }, onEvent, chatAbort.signal).finally(() => { chatAbort = null; });
};

export const bridge: LucidBridge = {
  isElectron: !!shell?.isElectron,
  security: () => getData("/api/security"),
  securityApprove: (id) => post("/api/security/approve", { id }),
  securityDismiss: (id) => post("/api/security/dismiss", { id }),
  engineeringBrief: () => getData("/api/brief"),
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
  skillImport: (files) => post("/api/skills/import", { files }),
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
  sessionMessages: (id) => getData(`/api/session?id=${encodeURIComponent(id)}`),
  resumeSession: async (id) => { await post("/api/session/load", { id }); },
  deleteSession: async (id) => (await post("/api/session/delete", { id })) ?? { ok: false, error: "no response" },
  clearIngestSessions: () => post("/api/sessions/ingest/clear", {}),
  newSession: async () => { await post("/api/newSession", {}); },
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
  credList: () => (shell?.credList ? shell.credList() : Promise.resolve([])), // P-NETWL.1
  credDelete: (ref) => (shell?.credDelete ? shell.credDelete(ref) : Promise.resolve(false)), // P-NETWL.1
  credEncryptionAvailable: () => (shell?.credEncryptionAvailable ? shell.credEncryptionAvailable() : Promise.resolve(false)), // P-NETWL.1
  whitelistList: async () => (await getData("/api/whitelist")) ?? [], // P-NETWL.2
  whitelistUpsert: (entry) => post("/api/whitelist", entry), // P-NETWL.2
  whitelistRemove: async (id) => { await post("/api/whitelist/remove", { id }); }, // P-NETWL.2
  capturePreview: (rect) => (shell?.capturePreview ? shell.capturePreview(rect) : Promise.resolve(null)), // P-PREVIEW.1
  previewEgressAllows: async (url) => { const d = await getData(`/api/preview/egress-check?url=${encodeURIComponent(url)}`); return !!(d as { allow?: boolean } | null)?.allow; }, // P-PREVIEW.3b
  previewFile: async (path) => { const d = await getData(`/api/preview/file?path=${encodeURIComponent(path)}`); const h = (d as { html?: unknown } | null)?.html; return typeof h === "string" ? h : null; }, // P-PREVIEW.4
  previewServeUrl: (path) => `/api/preview/serve?path=${encodeURIComponent(path)}${TOKEN ? `&t=${encodeURIComponent(TOKEN)}` : ""}`, // P-PREVIEW.4b
  cachePreviewShot: async (png) => { await post("/api/preview/shot-cache", { png }); }, // P-PREVIEW.3a-shot


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
