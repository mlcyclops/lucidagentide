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
import { BUILD_POLICY, DELEGATION_POLICY } from "../harness/prompt/assembler.ts";
import { currentWorkspace } from "./workspace.ts";
import { learnFromTurn, recallPreamble } from "./personal.ts";
import { buildUserTurnPreamble } from "./preamble.ts";
import { recordTurns } from "./turns_log.ts";
import { recordBlock } from "./security_log.ts";
import { asksageOnly, attribution, checkerModel, lastModel, load as loadSettings, mcpServersForAcp, setCheckerModel, setLastModel } from "./settings_store.ts";
import { managedConfig } from "./managed_config.ts";
import { recommendCheckerModel, resolveCheckerModel, type ModelOption } from "./checker_model.ts";
import { parseGoalVerdict } from "./goal_verdict.ts";
import { appendGoalIteration, finishGoalMemory, type GoalMemory, resumeGoalMemory, startGoalMemory } from "./goal_memory.ts";
import { type Automation, listAutomations, nextDueAutomation, updateAutomation } from "./automations.ts";

const REPO = join(import.meta.dir, "..");
// Absolute so the gate loads from THIS repo even when omp runs in another workspace.
const GATE = join(REPO, "harness", "omp", "security_extension.ts");
// AskSage gov-gateway provider extension, loaded alongside the gate (omp -e is
// repeatable). No-op unless ASKSAGE_API_KEY is set in the spawn env. ADR-0007.
const ASKSAGE = join(REPO, "harness", "omp", "asksage_extension.ts");
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
  | { type: "tool"; name: string; detail: string }
  | { type: "subagent"; id: string; agent: string; title: string; assignments: string[] }
  | { type: "block"; tool: string; reason: string; severity: string; findings: string; id?: string; quarantined?: boolean }
  | { type: "permission"; id: string; tool: string; detail: string; options: { optionId: string; name: string; kind?: string }[] }
  | { type: "usage"; used: number; size: number; cost: number }
  // P-GOAL.1 (ADR-0046): /goal loop events — an iteration begins, the separate checker's verdict,
  // the loop met its condition, or it stopped (cap / no-progress).
  | { type: "goal-memory"; path: string }
  | { type: "goal-iter"; n: number; max: number }
  | { type: "goal-check"; n: number; done: boolean; reason: string }
  | { type: "goal-done"; iters: number; reason: string }
  | { type: "goal-stop"; reason: string }
  | { type: "done" };

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

  // P-ASKSAGE.1 (ADR-0055): a bounded ring of AskSage tool-loop diagnostics, parsed from the omp child's
  // `[ASKSAGE_DIAG]` stderr lines. Surfaced (developer-mode only) in the Logs panel so the non-streamed
  // AskSage tool loop — and the "empty-response → gives up early" anomaly — is observable from a UI test.
  private asksageDiag: Array<Record<string, unknown>> = [];
  /** Recent AskSage call diagnostics (most-recent last), capped. Empty unless developer mode is on. */
  asksageDiagnostics(): Array<Record<string, unknown>> { return this.asksageDiag.slice(-100); }

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
        // P-ASKSAGE.1 (ADR-0055): enable AskSage tool-loop diagnostics in the omp child when developer
        // mode is on (the child inherits process.env at spawn). Off otherwise — zero overhead in normal use.
        if (loadSettings().developerMode) process.env.LUCID_ASKSAGE_DEBUG = "1"; else delete process.env.LUCID_ASKSAGE_DEBUG;
        // ADR-0033: also append the build / anti-over-refusal policy so the chat model doesn't decline
        // a buildable task (e.g. "make a game/graphics/music in one HTML file") by mis-reading its scope.
        const appendedPolicy = `${DELEGATION_POLICY}\n\n${BUILD_POLICY}`;
        const acp = new ACPClient(ompBin(), ["acp", "-e", GATE, "-e", ASKSAGE, ...isoCfg, "--append-system-prompt", appendedPolicy], currentWorkspace());
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
                this.emit({ type: "tool", name: String(u.kind ?? u.title ?? "tool"), detail: String(u.title ?? ri.command ?? "") });
              }
              break;
            }
            // A failed/rejected tool call is omp's GENERIC signal — it fires for the security
            // gate AND for ordinary tool failures, so it must NOT claim "blocked by the security
            // gate" (that mislabel made benign failures look like quarantines). The authoritative
            // security block is the gate's own stderr signal, handled in onStderr below.
            case "tool_call_update": if (u.status === "failed" || u.status === "rejected") this.emit({ type: "block", tool: String(u.kind ?? "tool"), reason: "tool call rejected", severity: "low", findings: "", quarantined: false }); break;
            case "usage_update": this.emit({ type: "usage", used: Number(u.used ?? 0), size: Number(u.size ?? 0), cost: Number(u.cost?.amount ?? 0) }); break;
            case "available_commands_update": this.commands = u.availableCommands ?? []; break;
            case "config_option_update": if (u.configOptions) { this.configOptions = u.configOptions; this.syncModelEnv(); } break;
            case "current_mode_update": this.currentModeId = String(u.currentModeId ?? this.currentModeId); break;
          }
        };
        acp.onRequest = async (m, params) => {
          if (m === "session/request_permission") {
            const opts: any[] = params?.options ?? [];
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
            // P-ASKSAGE.1 (ADR-0055): capture AskSage call diagnostics into the ring + echo to the dev
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
        await acp.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
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
    this.acp = null; this.starting = null; this.sessionId = null; this.listener = null;
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
  private static readonly IDLE_MS = 120_000;

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
    const sink = (e: ChatEvent) => { arm(); if (e.type === "token") assistant += e.text; onEvent(e); };
    this.listener = sink;
    this.askActive = true; // permission requests in THIS turn may be forwarded to the UI (Ask mode)
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
      await Promise.race([
        this.acp!.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: body }] }),
        stall,
      ]);
    } catch (e) {
      onEvent({ type: "token", text: `\n[${stalled ? "stalled" : "agent unavailable"}: ${String((e as any)?.message ?? e)}]` });
    } finally {
      if (idle) clearTimeout(idle);
      this.askActive = false;
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
  async runGoal(opts: { goal: string; condition: string; command?: string; maxIters: number; resume?: string }, onEvent: (e: ChatEvent) => void): Promise<void> {
    const goal = opts.goal.trim();
    const condition = (opts.condition || opts.command || "the goal is fully accomplished").trim();
    const command = opts.command?.trim() || "";
    const maxIters = Math.min(Math.max(1, Math.floor(opts.maxIters) || 6), 20); // hard ceiling
    const prevMode = this.permissionMode;
    this.permissionMode = "auto"; // unattended: auto-approve tool calls (the gate still scans every one)
    this.goalActive = true; this.goalCancelled = false;
    // P-GOAL.3/4: durable on-disk memory (best-effort). `resume` continues an existing loop-memory file
    // and injects its prior progress; otherwise start a fresh record.
    const resumed = opts.resume ? resumeGoalMemory(currentWorkspace(), opts.resume) : null;
    const mem: GoalMemory | null = resumed ? resumed.mem : startGoalMemory(currentWorkspace(), Date.now().toString(36), { goal, condition, command });
    if (mem) onEvent({ type: "goal-memory", path: mem.rel });
    const memNote = mem ? ` Your durable progress memory is the file ${mem.rel} (it records what's done across iterations).` : "";
    const resumeNote = resumed ? `\n\nThis loop was already in progress. Below is the progress so far — do NOT redo completed work, continue from where it stopped:\n${resumed.prior.slice(0, 3000)}` : "";
    let noProgress = 0;
    try {
      for (let i = 1; i <= maxIters; i++) {
        if (this.goalCancelled) { onEvent({ type: "goal-stop", reason: "stopped by you" }); finishGoalMemory(mem, "stopped by you"); return; }
        onEvent({ type: "goal-iter", n: i, max: maxIters });
        let work = "";
        let actedThisIter = false;
        // Forward the maker's stream, but swallow the per-iteration `done` so the client sees ONE loop.
        const sink = (e: ChatEvent) => {
          if (e.type === "done") return;
          if (e.type === "token") work += e.text;
          if (e.type === "tool" || e.type === "subagent") actedThisIter = true;
          onEvent(e);
        };
        const iterText = i === 1
          ? `${goal}\n\nWork toward this goal now. The stop condition is: ${condition}${command ? ` (verified by running \`${command}\`)` : ""}. Take the next concrete step.${memNote}${resumeNote}`
          : `Continue toward the goal. Stop condition: ${condition}. Take the next concrete step; if you believe the condition now holds, say so briefly and stop.${memNote}`;
        await this.prompt(iterText, sink);
        if (this.goalCancelled) { onEvent({ type: "goal-stop", reason: "stopped by you" }); finishGoalMemory(mem, "stopped by you"); return; }

        const verdict = await this.checkGoal({ goal, condition, command, lastWork: work });
        onEvent({ type: "goal-check", n: i, done: verdict.done, reason: verdict.reason });
        appendGoalIteration(mem, i, work, verdict);
        if (verdict.done) { onEvent({ type: "goal-done", iters: i, reason: verdict.reason }); finishGoalMemory(mem, `Goal met in ${i} iteration${i === 1 ? "" : "s"}: ${verdict.reason}`); return; }

        noProgress = actedThisIter ? 0 : noProgress + 1;
        if (noProgress >= 2) { onEvent({ type: "goal-stop", reason: "stopped: two iterations with no actions and the condition still unmet" }); finishGoalMemory(mem, "stopped: no progress for two iterations"); return; }
      }
      onEvent({ type: "goal-stop", reason: `stopped: hit the ${maxIters}-iteration cap without meeting the condition` });
      finishGoalMemory(mem, `stopped: hit the ${maxIters}-iteration cap without meeting the condition`);
    } catch (e) {
      const reason = `loop error: ${String((e as Error)?.message ?? e)}`;
      onEvent({ type: "goal-stop", reason });
      finishGoalMemory(mem, reason);
    } finally {
      this.goalActive = false;
      this.permissionMode = prevMode;
      onEvent({ type: "done" });
    }
  }

  /** P-GOAL.2: stop a running /goal loop — aborts the current maker turn and halts further iterations.
   *  No-op when no loop is active. */
  cancelGoal(): void { if (this.goalActive) { this.goalCancelled = true; this.cancel(); } }
  /** Whether a /goal loop is currently running (so the UI routes Stop to cancelGoal, not cancelChat). */
  isGoalRunning(): boolean { return this.goalActive; }

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

  /** The "AskSage only" model lock, from either the user's setting or org-managed config. */
  private asksageLocked(): boolean { return asksageOnly() || !!managedConfig().config?.asksageOnly; }

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
  private async checkGoal(a: { goal: string; condition: string; command: string; lastWork: string }): Promise<{ done: boolean; reason: string }> {
    const model = resolveCheckerModel({ chosen: checkerModel(), models: this.accessibleModels(), current: this.activeModel() }).value;
    if (a.command) {
      const out = await this.complete(
        `You are a verification CHECKER, separate from the agent that did the work. Run the given command EXACTLY in the workspace and report only the outcome. Do NOT modify any files or try to fix anything. Output ONLY strict JSON on one line: {"done": <true only if the command finished with exit code 0>, "reason": "<short summary of what happened>"}.`,
        `Run this verification command and report whether it passed:\n\n\`\`\`\n${a.command}\n\`\`\``,
        { idleMs: 180_000, model },
      );
      return parseGoalVerdict(out);
    }
    const out = await this.complete(
      `You are a strict CHECKER, separate from the agent that did the work. Decide whether the goal is fully met. Be conservative: if you are not sure, answer done=false. Output ONLY strict JSON on one line: {"done": bool, "reason": "<one line>"}.`,
      `Goal: ${a.goal}\nStop condition: ${a.condition}\n\nThe agent reported:\n${(a.lastWork || "(no output)").slice(0, 4000)}\n\nIs the goal fully met?`,
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

  /** One-shot, non-streaming completion in a THROWAWAY session — never touches the chat
   *  session, persona, or recall. Returns the aggregated assistant text ("" on any failure).
   *  Serialized via utilLock so it can't race a chat turn. Used by the import model-extractor:
   *  the model only ever sees text that already passed the scanner gate, and tool-call events
   *  (if any) are ignored — only assistant text is collected. */
  async complete(system: string, user: string, opts: { idleMs?: number; model?: string } = {}): Promise<string> {
    const run = this.utilLock.then(async () => {
      await this.start();
      const prev = this.listener;
      let sid: string | null = null;
      let text = "";
      let idle: ReturnType<typeof setTimeout> | undefined;
      let onStall: (e: Error) => void = () => {};
      try {
        const s: any = await this.acp!.request("session/new", { cwd: currentWorkspace(), mcpServers: mcpServersForAcp() });
        sid = s?.sessionId ?? s?.id ?? null;
        if (!sid) return "";
        // P-GOAL.6 (ADR-0048): run this throwaway completion on a DIFFERENT model when asked (the /goal
        // checker). Session-scoped, so the chat session's model is untouched. Best-effort: if the set
        // fails, the completion just runs on the default model (fail-safe, never blocks the loop).
        if (opts.model) await this.acp!.request("session/set_config_option", { sessionId: sid, configId: "model", value: opts.model }).catch(() => {});
        const IDLE = opts.idleMs ?? 60_000;
        const arm = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => onStall(new Error("stall")), IDLE); };
        this.listener = (e) => { arm(); if (e.type === "token") text += e.text; };
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
        this.listener = prev;
        if (sid) this.acp!.request("session/close", { sessionId: sid }).catch(() => {});
      }
    });
    this.utilLock = run.then(() => {}, () => {}); // next complete() waits for this one
    return run;
  }
}

export const backend = new Backend();
