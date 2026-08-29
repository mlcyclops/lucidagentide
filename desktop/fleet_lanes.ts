// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/fleet_lanes.ts
//
// P-FLEET.L1 / P-FLEET.L2: local lanes - N concurrent headless LUCID agents on THIS machine, each its own
// gated omp subprocess (same `-e` security gate as the master session, invariant 4), its own ACP session
// (own cwd, own model), rendered as a mini window in the renderer's fleet grid and reported to the master
// agent via the fleet_status tool.
//
// Load-bearing decisions:
//   - Lane count is UNLIMITED (P-FLEET.L2). The only refusal is SUSTAINED machine pressure: CPU or memory
//     at/above 90% unbroken for 30 seconds (fleet_resources.ts over a rolling window of system_profile
//     samples). A spike is free; a refusal carries the measured percent AND how long it has held. The
//     window is fed by this manager's own low-cost ticker, so "sustained" is measured, not guessed.
//   - One turn at a time PER LANE (one ACP session per lane; overlapping prompts on one session would
//     cross collectors - the ADR-0268 lesson). Parallelism is across lanes.
//   - Permission asks are FAIL-CLOSED: every session/request_permission surfaces to the lane's mini
//     window as needs-approval and waits for the user; no answer within the cap, or no dashboard
//     listening, means DENY. Lanes have no standing allowlists in L1 - a worker lane asking to run
//     something risky is exactly the moment a human should look.
//   - The model defaults to whatever the MASTER session is using right now, unless the user picks
//     another in the lane's dropdown (session/set_config_option, the same mechanism the master uses).

import { basename, join } from "node:path";
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ACPClient } from "./acp.ts";
import { FLEET_PRESSURE_PCT, FLEET_SUSTAIN_MS, laneAdmission, pressureOf, pushSample, type LaneAdmission, type PressureSample } from "./fleet_resources.ts";
import { sampleSystem, type SystemSnapshot } from "./system_profile.ts";

/** Closed set. Everything the LED can show; no other values, ever. */
export type LaneStatus = "starting" | "working" | "needs-approval" | "awaiting-input" | "done" | "error" | "stopped";

/** P-FLEET.L6: how far an ALLOW reaches. "once" answers only the pending ask; "session" also remembers
 *  the ask's kind for the lane's lifetime. A deny never records anything, whatever the scope says. */
export type ApprovalScope = "once" | "session";

export interface LaneView {
  id: string;
  name: string;
  cwd: string;
  model: string;
  status: LaneStatus;
  createdAt: number;
  lastActivityAt: number;
  /** Completed prompt turns. */
  turns: number;
  /** P-FLEET.L4: a failed/stopped lane can re-send its last prompt (Retry) when one was recorded. */
  canRetry: boolean;
  /** P-FLEET.L4: how many times this lane has been respawned in place (same id, memory carried). */
  respawns: number;
  pendingApproval?: { summary: string; kind: string };
  /** P-FLEET.L6: this lane approves privileged actions WITHOUT asking. The in-omp security gate
   *  (invariant 4) still scans every tool call - auto mode removes only the human approval step. */
  autoApprove: boolean;
  /** P-FLEET.L6: ask kinds the user allowed for this lane's whole session ("allow for session"). */
  sessionAllow: string[];
  /** P-FLEET.L5: the omp ACP session id behind this lane - the key into its on-disk .jsonl history.
   *  Changes when a fallback recovery mints a fresh session; every id this lane has held is in the
   *  durable lane-session ledger. */
  sessionId: string | null;
  /** P-FLEET.L3: staged prompts waiting for the lane to go idle. Previews only - clamped text + image
   *  count; the full payloads live in the manager, drained FIFO one turn at a time. */
  queued: { text: string; images: number }[];
}

/** P-FLEET.L3: a pasted image riding a lane prompt - the P-VISION.1 shape the master chat uses. */
export interface LaneImage { data: string; mimeType: string }

/** P-FLEET.L3 (mirrors P-CHAT.1): the code a write/edit tool call authored, pulled from its rawInput at
 *  call time - a write's whole `content`, or an edit's joined `oldText`/`newText` pair (rendered as a
 *  diff), or omp's hashline `patch`. Bounded at the wire; already gate-scanned (same tool_call text). */
export interface LaneToolCode { path: string; content?: string; oldText?: string; newText?: string; patch?: string }

export type LaneEvent =
  | { type: "token" | "thinking"; text: string }
  | { type: "tool"; name: string; detail: string; code?: LaneToolCode }
  | { type: "permission"; summary: string; kind: string }
  /** P-FLEET.L6: an ask was granted WITHOUT a human - full auto-mode or a standing session allow. */
  | { type: "auto-approved"; summary: string; mode: "auto" | "session" }
  | { type: "status"; status: LaneStatus }
  | { type: "done" }
  | { type: "error"; message: string };

export interface FleetStatusData {
  lanes: LaneView[];
  /** Latest pressure evidence + the echoed policy. There is NO lane cap (P-FLEET.L2). */
  resources: {
    cpuPct: number | null;
    memPct: number | null;
    /** The pressure line, in percent. */
    pressurePct: number;
    /** How long pressure must hold before a lane is refused, in ms. */
    sustainMs: number;
    /** Unbroken ms at/above the line right now, per metric. 0 = clear or still just a burst. */
    cpuHotMs: number;
    memHotMs: number;
  };
  masterModel: string;
}

// P-FLEET.L4 (ADR-0274): there is NO lane turn clock. ADR-0186's ten-minute deadline killed exactly the
// turns worth running (the master lost its clock in P-STALL.2, ADR-0263; lanes now match). Child DEATH is
// event-driven - acp.ts die() rejects every pending request the instant the process exits - so a prompt
// with no timeout is raced against the child's life, not against a wall clock. Silence is patience;
// Cancel and Stop remain the human's levers.
/** An unanswered approval is a DENY after this long (fail-closed; the ask stays visible until then). */
const APPROVAL_TIMEOUT_MS = 600_000;
/** ACP handshake bounds (P-KG-INGEST.5, ADR-0264: every request carries a clock). */
const HANDSHAKE_MS = 30_000;
/** The transcript kept for recovery replay, per lane: enough memory to resume mid-task, bounded so a
 *  chatty lane cannot grow without limit. Oldest turns fall off first; the byte cap trims per turn. */
const TRANSCRIPT_MAX_TURNS = 40;
const TRANSCRIPT_MAX_TURN_CHARS = 8_000;
/** P-FLEET.L3: staged prompts per lane. Mirrors P-FLEET.1's job-queue cap - past it, refuse loudly. */
const QUEUE_MAX = 8;
/** P-FLEET.L3: cap on authored code carried per tool event. Lane cards are compact; the master's chat
 *  uses 64K, a mini window needs enough for the diff chip and its expansion, not a whole novel. */
const CODE_CAP = 16 * 1024;
/** Pressure-window cadence. Ten readings per sustain window is plenty of resolution to tell a burst
 *  from a siege, and a two-point os.cpus() read costs nothing measurable. */
const SAMPLE_MS = 3_000;
/** Never two samples closer than this: the 2.5s status poll rides the ticker's readings, it doesn't
 *  add its own. */
const SAMPLE_MIN_GAP_MS = 2_000;
/** Stop sampling once nothing is live and nobody has asked for status this long. Restarts on demand. */
const SAMPLER_IDLE_MS = 20_000;

/** P-FLEET.L5: one durable ledger line - a lane claimed an omp session. Appended at spawn AND at every
 *  recovery, so a lane's whole session lineage survives engine restarts and the timeline can label the
 *  on-disk .jsonl histories that would otherwise read as anonymous chats. */
export interface LaneSessionRecord { at: number; laneId: string; name: string; cwd: string; sessionId: string; event: "spawn" | "respawn" }

export interface FleetLaneDeps {
  /** The gated omp argv for a lane (MUST carry the -e security gate; built by acp_backend). */
  argv: () => { cmd: string; args: string[] };
  /** The master session's current model - the lane default. */
  masterModel: () => string;
  /** Machine sample for admission + the dashboard headroom bar. */
  sample?: () => Promise<SystemSnapshot>;
  now?: () => number;
  /** P-FLEET.L5: durable lane-session ledger sink (dev.ts appends JSONL). Optional and fail-quiet -
   *  a broken ledger must never block a lane. */
  recordLaneSession?: (rec: LaneSessionRecord) => void;
  /** P-INTERJECT.1: per-lane spawn env OVERLAY (on top of the inherited process.env - ACPClient
   *  semantics). dev.ts supplies interjectChildEnv(laneId), which stamps LUCID_INTERJECT_TARGET=<laneId>
   *  (+ LUCID_DEV_URL) so the lane's interject_extension drains only ITS notes. Optional: absent means
   *  a bare inherit, exactly the pre-seam behavior. Applied at spawn AND at every in-place recovery. */
  env?: (laneId: string) => Record<string, string>;
}

/** One recovery-replay memory entry. Tool lines are folded into the assistant text at fold time. */
interface LaneTurnRecord { role: "user" | "assistant"; text: string }

interface Lane {
  id: string;
  name: string;
  cwd: string;
  model: string;
  status: LaneStatus;
  createdAt: number;
  lastActivityAt: number;
  turns: number;
  client: ACPClient;
  sessionId: string | null;
  /** Live event sinks (the streaming mini window). */
  sinks: Set<(e: LaneEvent) => void>;
  /** The unanswered permission ask, if any. Resolving it answers the remote. */
  pending: { summary: string; kind: string; resolve: (allow: boolean) => void } | null;
  /** P-FLEET.L6: approve every ask without a human (per-lane; initialized from the manager default). */
  autoApprove: boolean;
  /** P-FLEET.L6: ask kinds the user granted for this lane's lifetime via scope "session". */
  sessionAllow: Set<string>;
  /** A prompt turn is in flight (one at a time per lane). */
  busy: boolean;
  // ── P-FLEET.L4 recovery state ─────────────────────────────────────────────────────────────────────
  /** Bounded conversation memory (user + folded assistant turns) for the respawn replay. */
  transcript: LaneTurnRecord[];
  /** Assistant text accumulating during the CURRENT turn; folded into `transcript` when it settles. */
  liveText: string;
  /** Compact tool titles for the current turn, folded with the assistant text. */
  liveTools: string[];
  /** The last user prompt (+ its images), for Retry. */
  lastPrompt: string | null;
  lastImages: LaneImage[];
  /** Did initialize advertise session/load? Gates NATIVE resume (omp replays its own session log). */
  canLoadSession: boolean;
  /** Set by a fallback recovery; prepended to the NEXT prompt's WIRE text once, never recorded. */
  resumeContext: string | null;
  respawns: number;
  /** P-FLEET.L3: staged prompts, drained FIFO when the lane goes idle. One turn at a time stands. */
  queue: { text: string; images: LaneImage[] }[];
}

export class FleetLaneManager {
  readonly #lanes = new Map<string, Lane>();
  readonly #deps: Required<Pick<FleetLaneDeps, "argv" | "masterModel">> & { sample: () => Promise<SystemSnapshot>; now: () => number; recordLaneSession?: (rec: LaneSessionRecord) => void; env?: (laneId: string) => Record<string, string> };
  /** The rolling pressure window admission reads. Fed by #sampler (and by any status poll that arrives
   *  between ticks), trimmed by pushSample - never a full session's history. */
  #history: PressureSample[] = [];
  #sampler: ReturnType<typeof setInterval> | null = null;
  #sampling = false;
  #lastStatusAt = 0;
  /** P-FLEET.L6: the auto-approve default NEW lanes inherit (persisted as GuiSettings.fleetAutoApprove;
   *  dev.ts seeds it at boot and setAutoAll moves it with the fleet-wide toggle). */
  #autoDefault = false;

  constructor(deps: FleetLaneDeps) {
    this.#deps = { argv: deps.argv, masterModel: deps.masterModel, sample: deps.sample ?? (() => sampleSystem()), now: deps.now ?? Date.now, ...(deps.recordLaneSession ? { recordLaneSession: deps.recordLaneSession } : {}), ...(deps.env ? { env: deps.env } : {}) };
  }

  /** Spawn a lane: sustained-pressure admission first, then the gated omp + ACP handshake + model select. */
  async spawn(opts: { cwd: string; model?: string; name?: string }): Promise<{ ok: boolean; lane?: LaneView; reason?: string }> {
    const cwd = (opts.cwd ?? "").trim();
    try {
      if (!cwd || !statSync(cwd).isDirectory()) return { ok: false, reason: `not a directory: "${cwd}"` };
    } catch {
      return { ok: false, reason: `not a directory: "${cwd}"` };
    }
    const admission = await this.#admission();
    if (!admission.ok) return { ok: false, reason: admission.reason };

    let id = `lane-${randomUUID().slice(0, 8)}`;
    while (this.#lanes.has(id)) id = `lane-${randomUUID().slice(0, 8)}`;
    const t = this.#deps.now();
    const plan = this.#deps.argv();
    const lane: Lane = {
      id,
      name: (opts.name ?? "").trim() || basename(cwd),
      cwd,
      model: (opts.model ?? "").trim() || this.#deps.masterModel(),
      status: "starting",
      createdAt: t,
      lastActivityAt: t,
      turns: 0,
      client: new ACPClient(plan.cmd, plan.args, cwd, this.#deps.env?.(id) ?? {}),
      sessionId: null,
      sinks: new Set(),
      pending: null,
      autoApprove: this.#autoDefault,
      sessionAllow: new Set(),
      busy: false,
      transcript: [],
      liveText: "",
      liveTools: [],
      lastPrompt: null,
      lastImages: [],
      canLoadSession: false,
      resumeContext: null,
      respawns: 0,
      queue: [],
    };
    this.#lanes.set(id, lane);
    this.#wire(lane);
    try {
      await this.#handshake(lane);
      this.#setStatus(lane, "awaiting-input");
      return { ok: true, lane: this.#view(lane) };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      try { lane.client.stop(); } catch { /* already dead */ }
      this.#setStatus(lane, "error");
      return { ok: false, reason: `lane failed to start: ${why}` };
    }
  }

  /** One prompt turn on one lane, events streamed to `sink`. One turn at a time per lane.
   *
   *  P-FLEET.L4: an ERROR lane (or a lane whose child died) is recovered in place first - same lane id,
   *  memory carried - instead of refusing. A user-STOPPED lane stays stopped: that was a decision, not a
   *  failure, and only an explicit respawn() revives it. The turn itself carries NO deadline: the request
   *  is raced against the child's life (acp.ts rejects all pending on exit), never a wall clock.
   *
   *  P-FLEET.L3: `images` (the P-VISION.1 shape) ride as ACP image blocks after the text, exactly like
   *  the master chat. The transcript records their COUNT, never their bytes - base64 in replay memory
   *  would burn the whole budget on one screenshot. */
  async prompt(laneId: string, text: string, sink: (e: LaneEvent) => void, images: LaneImage[] = []): Promise<void> {
    const lane = this.#lanes.get(laneId);
    if (!lane) { sink({ type: "error", message: `unknown lane "${laneId}"` }); return; }
    if (lane.busy) { sink({ type: "error", message: "lane is busy - one turn at a time per lane" }); return; }
    if (lane.status === "stopped") { sink({ type: "error", message: "lane is stopped - respawn it to continue" }); return; }
    if (lane.status === "error" || lane.client.isDead || !lane.sessionId) {
      const r = await this.#recover(lane);
      if (!r.ok) { sink({ type: "error", message: r.reason ?? "lane recovery failed" }); return; }
      this.#emit(lane, { type: "status", status: lane.status });
    }
    lane.busy = true;
    lane.sinks.add(sink);
    lane.lastPrompt = text;
    lane.lastImages = images;
    lane.liveText = "";
    lane.liveTools = [];
    this.#record(lane, { role: "user", text: images.length ? `${text}\n[attached ${images.length} image${images.length === 1 ? "" : "s"}]` : text });
    this.#setStatus(lane, "working");
    try {
      // The wire text carries the one-shot recovery preamble when a fallback resume is pending; the
      // transcript recorded only `text` - the user never "said" the preamble.
      const wireText = lane.resumeContext ? `${lane.resumeContext}${text}` : text;
      lane.resumeContext = null;
      const imageBlocks = images.filter((im) => im?.data && im?.mimeType).map((im) => ({ type: "image" as const, data: im.data, mimeType: im.mimeType }));
      const res = await lane.client.request<{ stopReason?: string }>("session/prompt", { sessionId: lane.sessionId, prompt: [{ type: "text", text: wireText }, ...imageBlocks] });
      // ACP cancel RESOLVES the prompt with stopReason "cancelled" (it does not reject) - a cancelled
      // turn goes back to awaiting-input, never "done".
      this.#foldLiveTurn(lane);
      if (typeof res?.stopReason === "string" && /cancel/i.test(res.stopReason)) {
        this.#setStatus(lane, "awaiting-input");
      } else {
        lane.turns++;
        this.#setStatus(lane, "done");
      }
      this.#emit(lane, { type: "done" });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.#foldLiveTurn(lane, why);
      // A cancelled turn settles as done-with-nothing rather than a scary error card.
      if (/cancel/i.test(why)) { this.#setStatus(lane, "awaiting-input"); this.#emit(lane, { type: "done" }); }
      else { this.#setStatus(lane, "error"); this.#emit(lane, { type: "error", message: why }); }
    } finally {
      lane.busy = false;
      lane.sinks.delete(sink);
    }
  }

  /** Re-send the lane's last prompt + its images (recovering first if the lane is in error). No recorded
   *  prompt is a quiet, explained refusal, not a crash. */
  async retry(laneId: string, sink: (e: LaneEvent) => void): Promise<void> {
    const lane = this.#lanes.get(laneId);
    if (!lane) { sink({ type: "error", message: `unknown lane "${laneId}"` }); return; }
    if (!lane.lastPrompt) { sink({ type: "error", message: "nothing to retry - this lane has not been prompted yet" }); return; }
    // The failed attempt's user turn is already in the transcript; drop it so the retry does not read as
    // the user asking twice.
    const last = lane.transcript[lane.transcript.length - 1];
    if (last?.role === "user" && last.text.startsWith(lane.lastPrompt)) lane.transcript.pop();
    await this.prompt(laneId, lane.lastPrompt, sink, lane.lastImages);
  }

  // ── P-FLEET.L3: the staged-prompt queue (manager-owned; survives dock close and renderer reloads) ──

  /** Stage a prompt for when the lane goes idle. Staging onto an error lane is fine - the drain recovers
   *  it. The cap mirrors P-FLEET.1's job queue: past it, refuse loudly rather than buffer unbounded. */
  enqueue(laneId: string, text: string, images: LaneImage[] = []): { ok: boolean; queued?: number; reason?: string } {
    const lane = this.#lanes.get(laneId);
    if (!lane) return { ok: false, reason: `unknown lane "${laneId}"` };
    const t = text.trim();
    if (!t && !images.length) return { ok: false, reason: "nothing to stage" };
    if (lane.queue.length >= QUEUE_MAX) return { ok: false, reason: `queue is full (${QUEUE_MAX}) - let the lane drain first` };
    lane.queue.push({ text: t, images });
    return { ok: true, queued: lane.queue.length };
  }

  queueRemove(laneId: string, index: number): { ok: boolean } {
    const lane = this.#lanes.get(laneId);
    if (!lane || index < 0 || index >= lane.queue.length) return { ok: false };
    lane.queue.splice(index, 1);
    return { ok: true };
  }

  /** Move a staged prompt one slot up (-1) or down (+1). Out-of-range is a quiet no-op. */
  queueMove(laneId: string, index: number, dir: -1 | 1): { ok: boolean } {
    const lane = this.#lanes.get(laneId);
    if (!lane) return { ok: false };
    const to = index + dir;
    if (index < 0 || index >= lane.queue.length || to < 0 || to >= lane.queue.length) return { ok: false };
    const [item] = lane.queue.splice(index, 1);
    lane.queue.splice(to, 0, item!);
    return { ok: true };
  }

  /** Pop and run the next staged prompt, streaming into `sink`. The RENDERER triggers this when it sees
   *  the lane idle with a queue - the manager never runs a turn nobody can watch, because approvals need
   *  a human and a card to glow in. Busy or empty is a quiet, explained refusal. */
  async drain(laneId: string, sink: (e: LaneEvent) => void): Promise<void> {
    const lane = this.#lanes.get(laneId);
    if (!lane) { sink({ type: "error", message: `unknown lane "${laneId}"` }); return; }
    if (lane.busy) { sink({ type: "error", message: "lane is busy - the queue drains when the turn ends" }); return; }
    const next = lane.queue.shift();
    if (!next) { sink({ type: "error", message: "queue is empty" }); return; }
    await this.prompt(laneId, next.text, sink, next.images);
  }

  /** Explicit revive: works on error AND stopped lanes (the button, not the automatic path). */
  async respawn(laneId: string): Promise<{ ok: boolean; lane?: LaneView; reason?: string }> {
    const lane = this.#lanes.get(laneId);
    if (!lane) return { ok: false, reason: `unknown lane "${laneId}"` };
    if (lane.busy) return { ok: false, reason: "lane is mid-turn - cancel it first" };
    const r = await this.#recover(lane);
    return r.ok ? { ok: true, lane: this.#view(lane) } : { ok: false, reason: r.reason };
  }

  /** Answer the lane's pending approval. No pending ask is a quiet no-op (a late click, not an error).
   *  P-FLEET.L6: scope "session" ALSO remembers the ask's kind for the lane's lifetime - but only on an
   *  allow. A deny records NOTHING regardless of scope (fail-closed: refusals never build allowlists). */
  answer(laneId: string, allow: boolean, scope?: ApprovalScope): { ok: boolean } {
    const lane = this.#lanes.get(laneId);
    if (!lane?.pending) return { ok: false };
    if (allow && scope === "session") lane.sessionAllow.add(lane.pending.kind); // BEFORE resolve - resolve nulls pending
    lane.pending.resolve(allow);
    return { ok: true };
  }

  /** P-FLEET.L6: flip one lane's full auto-mode. Turning it ON with an ask open resolves that ask as an
   *  ALLOW - the human just granted everything, the pending ask rides along. The in-omp security gate
   *  (invariant 4) still scans every tool call in auto mode; only the human approval step goes away. */
  setAuto(laneId: string, on: boolean): { ok: boolean; lane?: LaneView; reason?: string } {
    const lane = this.#lanes.get(laneId);
    if (!lane) return { ok: false, reason: `unknown lane "${laneId}"` };
    lane.autoApprove = on;
    if (on) lane.pending?.resolve(true);
    return { ok: true, lane: this.#view(lane) };
  }

  /** P-FLEET.L6: fleet-wide auto-mode - every live lane flips AND new lanes inherit it as the default. */
  setAutoAll(on: boolean): void {
    this.#autoDefault = on;
    for (const lane of this.#lanes.values()) {
      lane.autoApprove = on;
      if (on) lane.pending?.resolve(true);
    }
  }

  /** P-FLEET.L6: seed the new-lane default only (the boot path - never touches live lanes). */
  setAutoDefault(on: boolean): void {
    this.#autoDefault = on;
  }

  cancel(laneId: string): { ok: boolean } {
    const lane = this.#lanes.get(laneId);
    if (!lane?.sessionId) return { ok: false };
    lane.client.notify("session/cancel", { sessionId: lane.sessionId });
    return { ok: true };
  }

  setModel(laneId: string, model: string): Promise<{ ok: boolean; model?: string; reason?: string }> {
    const lane = this.#lanes.get(laneId);
    if (!lane) return Promise.resolve({ ok: false, reason: "unknown lane" });
    return this.#setModel(lane, model).then(
      () => ({ ok: true, model: lane.model }),
      (e) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }),
    );
  }

  stop(laneId: string): { ok: boolean } {
    const lane = this.#lanes.get(laneId);
    if (!lane) return { ok: false };
    lane.pending?.resolve(false); // an open ask dies as a DENY, never dangles
    try { lane.client.stop(); } catch { /* already dead */ }
    this.#setStatus(lane, "stopped");
    return { ok: true };
  }

  /** Shutdown path: deny open asks, cancel live turns, stop every child, stop sampling. */
  stopAll(): void {
    for (const lane of this.#lanes.values()) {
      if (lane.status === "stopped") continue;
      lane.pending?.resolve(false);
      if (lane.busy && lane.sessionId) { try { lane.client.notify("session/cancel", { sessionId: lane.sessionId }); } catch { /* dead */ } }
      try { lane.client.stop(); } catch { /* dead */ }
      this.#setStatus(lane, "stopped");
    }
    this.#stopSampler();
  }

  async status(): Promise<FleetStatusData> {
    this.#lastStatusAt = this.#deps.now();
    const a = await this.#admission();
    return {
      lanes: [...this.#lanes.values()].map((l) => this.#view(l)),
      resources: {
        cpuPct: a.cpuPct,
        memPct: a.memPct,
        pressurePct: a.pressurePct,
        sustainMs: a.sustainMs,
        cpuHotMs: a.cpuHotMs,
        memHotMs: a.memHotMs,
      },
      masterModel: this.#deps.masterModel(),
    };
  }

  /** How many lanes are actually carrying work right now (metadata; nothing gates on it). */
  liveLanes(): number {
    return [...this.#lanes.values()].filter((l) => l.status !== "stopped" && l.status !== "error").length;
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────

  /** The verdict over the freshest window we can cheaply have. Both callers (spawn + status) also keep
   *  the sampler alive, so a fleet in use always has real history behind the next decision. */
  async #admission(): Promise<LaneAdmission> {
    this.#ensureSampler();
    await this.#feed();
    return laneAdmission(this.#history, FLEET_PRESSURE_PCT, FLEET_SUSTAIN_MS);
  }

  /** Take a reading into the window, unless one is already in flight or the last is too fresh. */
  async #feed(): Promise<void> {
    if (this.#sampling) return;
    const last = this.#history.length ? this.#history[this.#history.length - 1]! : null;
    if (last && this.#deps.now() - last.at < SAMPLE_MIN_GAP_MS) return;
    this.#sampling = true;
    try {
      const snap = await this.#deps.sample();
      this.#history = pushSample(this.#history, pressureOf(snap, this.#deps.now()));
    } catch {
      /* a failed sample contributes NOTHING: an absent reading breaks any hot streak (fails open). */
    } finally {
      this.#sampling = false;
    }
  }

  /** Sustained pressure can only be MEASURED, so the window needs feeding even when nobody is watching
   *  the dashboard. The ticker is unref'd (it never holds the process open) and retires itself once the
   *  fleet is idle and unwatched; spawn/status bring it back. */
  #ensureSampler(): void {
    if (this.#sampler) return;
    const t = setInterval(() => { void this.#tick(); }, SAMPLE_MS);
    (t as unknown as { unref?: () => void }).unref?.();
    this.#sampler = t;
  }
  #stopSampler(): void {
    if (this.#sampler) { clearInterval(this.#sampler); this.#sampler = null; }
  }
  async #tick(): Promise<void> {
    if (this.liveLanes() === 0 && this.#deps.now() - this.#lastStatusAt > SAMPLER_IDLE_MS) { this.#stopSampler(); return; }
    await this.#feed();
  }

  async #setModel(lane: Lane, model: string): Promise<void> {
    if (!lane.sessionId || !model) return;
    await lane.client.request("session/set_config_option", { sessionId: lane.sessionId, configId: "model", value: model }, { timeoutMs: HANDSHAKE_MS });
    lane.model = model;
  }

  /** initialize + session/new (or session/load on recovery) + model select, on the lane's CURRENT client.
   *  Capability-gated native resume: only an agent that ADVERTISES loadSession is asked to load - probing
   *  by trial is unsafe because a permissive agent acks unknown methods with an empty result. */
  async #handshake(lane: Lane, resume = false): Promise<void> {
    lane.client.start();
    const init = await lane.client.request<{ agentCapabilities?: { loadSession?: boolean } }>("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }, { timeoutMs: HANDSHAKE_MS });
    lane.canLoadSession = init?.agentCapabilities?.loadSession === true;
    if (resume && lane.canLoadSession && lane.sessionId) {
      // NATIVE resume: omp replays its own persisted session log - full memory, nothing re-sent by us.
      await lane.client.request("session/load", { sessionId: lane.sessionId, cwd: lane.cwd, mcpServers: [] }, { timeoutMs: HANDSHAKE_MS });
      lane.resumeContext = null;
    } else {
      const s = await lane.client.request<{ sessionId?: string; id?: string }>("session/new", { cwd: lane.cwd, mcpServers: [] }, { timeoutMs: HANDSHAKE_MS });
      lane.sessionId = typeof s?.sessionId === "string" ? s.sessionId : typeof s?.id === "string" ? s.id : null;
      if (!lane.sessionId) throw new Error("lane agent returned no session id");
      // FALLBACK resume: a fresh session gets the recorded transcript prepended to the NEXT prompt.
      lane.resumeContext = resume && lane.transcript.length ? this.#resumePreamble(lane) : null;
    }
    await this.#setModel(lane, lane.model);
    // P-FLEET.L5: name the session in the durable ledger the moment it exists - the timeline's link
    // between this lane and its on-disk .jsonl. Fail-quiet by contract.
    if (lane.sessionId) {
      try { this.#deps.recordLaneSession?.({ at: this.#deps.now(), laneId: lane.id, name: lane.name, cwd: lane.cwd, sessionId: lane.sessionId, event: resume ? "respawn" : "spawn" }); }
      catch { /* a broken ledger never blocks a lane */ }
    }
  }

  /** Revive a dead/errored lane IN PLACE: same lane id (invariant 9 - one logical entity, one id), same
   *  cwd/model/name, memory carried. The old ask (if any) died as a DENY on exit; nothing gated is ever
   *  auto-replayed - a re-attempted action re-asks the human through the normal permission path. */
  async #recover(lane: Lane): Promise<{ ok: boolean; reason?: string }> {
    lane.pending?.resolve(false);
    try { lane.client.stop(); } catch { /* already dead */ }
    const plan = this.#deps.argv();
    lane.client = new ACPClient(plan.cmd, plan.args, lane.cwd, this.#deps.env?.(lane.id) ?? {});
    this.#wire(lane);
    this.#setStatus(lane, "starting");
    try {
      await this.#handshake(lane, true);
      lane.respawns++;
      this.#setStatus(lane, "awaiting-input");
      return { ok: true };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      try { lane.client.stop(); } catch { /* already dead */ }
      this.#setStatus(lane, "error");
      return { ok: false, reason: `lane recovery failed: ${why}` };
    }
  }

  /** The fallback resume preamble: the lane's own recorded conversation, clearly delimited as a
   *  TRANSCRIPT (data to remember, not instructions to re-execute). Tool effects on disk are real - the
   *  work is not redone, it is remembered. */
  #resumePreamble(lane: Lane): string {
    const lines = lane.transcript.map((t) => `${t.role === "user" ? "USER" : "LANE"}: ${t.text}`).join("\n\n");
    return (
      `[SESSION RECOVERY] You are the same worker lane, resumed after your previous process died. ` +
      `The transcript of your session so far follows between the markers. Treat it as MEMORY: do not ` +
      `re-run tools for work it already shows as done; continue from where it ends.\n` +
      `--- TRANSCRIPT START ---\n${lines}\n--- TRANSCRIPT END ---\n\n`
    );
  }

  /** Append a turn to the bounded recovery transcript (per-turn char clamp, oldest turns fall off). */
  #record(lane: Lane, turn: LaneTurnRecord): void {
    const text = turn.text.length > TRANSCRIPT_MAX_TURN_CHARS ? `${turn.text.slice(0, TRANSCRIPT_MAX_TURN_CHARS)}\u2026[truncated]` : turn.text;
    lane.transcript.push({ role: turn.role, text });
    if (lane.transcript.length > TRANSCRIPT_MAX_TURNS) lane.transcript.splice(0, lane.transcript.length - TRANSCRIPT_MAX_TURNS);
  }

  /** Fold the streaming turn (assistant text + compact tool titles + any error) into the transcript. */
  #foldLiveTurn(lane: Lane, error?: string): void {
    const tools = lane.liveTools.length ? `${lane.liveTools.map((t) => `[ran: ${t}]`).join("\n")}\n` : "";
    const err = error ? `\n[turn ended in error: ${error.slice(0, 300)}]` : "";
    const text = `${tools}${lane.liveText}${err}`.trim();
    if (text) this.#record(lane, { role: "assistant", text });
    lane.liveText = "";
    lane.liveTools = [];
  }

  #wire(lane: Lane): void {
    lane.client.onNotify = (method, params) => {
      if (method !== "session/update") return;
      const u = params?.update ?? params;
      lane.lastActivityAt = this.#deps.now();
      switch (u?.sessionUpdate) {
        case "agent_message_chunk":
          if (u.content?.type === "text") {
            const text = String(u.content.text);
            lane.liveText += text; // recovery memory rides the same stream the card renders
            this.#emit(lane, { type: "token", text });
          }
          break;
        case "agent_thought_chunk":
          if (u.content?.type === "text") this.#emit(lane, { type: "thinking", text: String(u.content.text) });
          break;
        case "tool_call":
        case "tool_call_update": {
          const title = String(u.title ?? "");
          if (u.sessionUpdate === "tool_call" && title && lane.liveTools.length < 40) lane.liveTools.push(title.slice(0, 160));
          // P-FLEET.L3 (mirrors P-CHAT.1): the authored code rides the CALL's rawInput - a write's
          // `content`, an edit's `edits[{old_text,new_text}]` joined into one before/after pair, or omp's
          // hashline patch in a single `input` string. Relative paths resolve against the LANE's cwd.
          const code = u.sessionUpdate === "tool_call" ? this.#toolCode(lane, u) : undefined;
          this.#emit(lane, { type: "tool", name: String(u.kind ?? u.title ?? "tool"), detail: title, ...(code ? { code } : {}) });
          break;
        }
      }
    };
    lane.client.onRequest = async (method, params) => {
      // FAIL-CLOSED approvals: every ask goes to the human in the mini window; silence is a DENY.
      // P-FLEET.L6: full auto-mode and standing "session" grants answer WITHOUT the human - the in-omp
      // security gate (invariant 4) still scans every tool call either way; auto removes only the ask.
      if (method === "session/request_permission") {
        const opts: { optionId?: string; kind?: string }[] = params?.options ?? [];
        const tc = params?.toolCall ?? params?.tool_call ?? {};
        const summary = String(tc.title ?? tc.kind ?? params?.tool ?? "a privileged action").slice(0, 300);
        const kind = String(tc.kind ?? params?.tool ?? "action").slice(0, 80);
        const pick = () => {
          const a = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? "")) ?? opts[0];
          return a ? { outcome: { outcome: "selected", optionId: a.optionId } } : { outcome: { outcome: "cancelled" } };
        };
        if (lane.autoApprove || lane.sessionAllow.has(kind)) {
          this.#emit(lane, { type: "auto-approved", summary, mode: lane.autoApprove ? "auto" : "session" });
          return pick();
        }
        const allow = await this.#askUser(lane, summary, kind);
        if (!allow) return { outcome: { outcome: "cancelled" } };
        return pick();
      }
      // omp's redundant INNER elicitation gate (see acp_backend): it only fires AFTER the permission
      // ask above was allowed, so pick the affirmative option; a custom question gets no synthesized answer.
      if (method === "elicitation/create") {
        const options: { value?: string; label?: string }[] = params?.options ?? params?.schema?.options ?? [];
        const yes = options.find((o) => /^(yes|approve|allow|proceed|ok)/i.test(String(o.label ?? o.value ?? "")));
        return yes ? { value: yes.value ?? yes.label } : {};
      }
      return {};
    };
    lane.client.onExit = () => {
      lane.pending?.resolve(false);
      if (lane.status !== "stopped") this.#setStatus(lane, lane.busy ? "error" : "stopped");
    };
  }

  /** P-FLEET.L3 (mirrors acp_backend's P-CHAT.1 extraction): the code a write/edit call authored, from
   *  its rawInput. Returns undefined for tools with no authored code (read/search/bash). The content is
   *  already gate-scanned - it is the same tool_call text the in-omp gate saw. */
  #toolCode(lane: Lane, u: { kind?: unknown; title?: unknown; rawInput?: unknown; input?: unknown }): LaneToolCode | undefined {
    const riRaw = u.rawInput ?? u.input;
    if (!riRaw || typeof riRaw !== "object") return undefined;
    const ri = riRaw as Record<string, unknown>;
    const clip = (s: unknown) => (typeof s === "string" ? s.slice(0, CODE_CAP) : undefined);
    // The agent writes/edits with paths relative to ITS workspace - the lane's cwd, not the master's.
    const rawPath = typeof ri.path === "string" ? ri.path : typeof ri.file_path === "string" ? ri.file_path : "";
    const path = !rawPath || /^(file:\/\/|https?:\/\/|[A-Za-z]:[\\/]|\/|\\\\|~[\\/])/i.test(rawPath) ? rawPath : join(lane.cwd, rawPath);
    if (typeof ri.content === "string") return { path, content: clip(ri.content) };
    if (Array.isArray(ri.edits) && ri.edits.length) {
      const olds = ri.edits.map((e) => String((e as Record<string, unknown>)?.old_text ?? (e as Record<string, unknown>)?.oldText ?? "")).join("\n");
      const news = ri.edits.map((e) => String((e as Record<string, unknown>)?.new_text ?? (e as Record<string, unknown>)?.newText ?? "")).join("\n");
      return { path, oldText: clip(olds) ?? "", newText: clip(news) ?? "" };
    }
    if (typeof ri.old_text === "string" || typeof ri.new_text === "string") return { path, oldText: clip(ri.old_text) ?? "", newText: clip(ri.new_text) ?? "" };
    if (typeof ri.oldText === "string" || typeof ri.newText === "string") return { path, oldText: clip(ri.oldText) ?? "", newText: clip(ri.newText) ?? "" };
    if (typeof ri.input === "string" && (u.kind === "edit" || /\bedit\b/i.test(String(u.title ?? "")))) return { path, patch: clip(ri.input) };
    return undefined;
  }

  #askUser(lane: Lane, summary: string, kind: string): Promise<boolean> {
    lane.pending?.resolve(false); // never two open asks - the older one dies as a deny
    const gate = Promise.withResolvers<boolean>();
    const resolve = (allow: boolean) => {
      clearTimeout(timer);
      if (lane.pending?.resolve === resolve) lane.pending = null;
      if (lane.status === "needs-approval") this.#setStatus(lane, lane.busy ? "working" : "awaiting-input");
      gate.resolve(allow);
    };
    const timer = setTimeout(() => resolve(false), APPROVAL_TIMEOUT_MS);
    lane.pending = { summary, kind, resolve };
    this.#setStatus(lane, "needs-approval");
    this.#emit(lane, { type: "permission", summary, kind });
    return gate.promise;
  }

  #setStatus(lane: Lane, status: LaneStatus): void {
    if (lane.status === status) return;
    lane.status = status;
    lane.lastActivityAt = this.#deps.now();
    this.#emit(lane, { type: "status", status });
  }

  #emit(lane: Lane, e: LaneEvent): void {
    for (const sink of lane.sinks) { try { sink(e); } catch { /* a dead sink never breaks the lane */ } }
  }

  #view(lane: Lane): LaneView {
    return {
      id: lane.id,
      name: lane.name,
      cwd: lane.cwd,
      model: lane.model,
      status: lane.status,
      createdAt: lane.createdAt,
      lastActivityAt: lane.lastActivityAt,
      turns: lane.turns,
      canRetry: lane.lastPrompt !== null,
      respawns: lane.respawns,
      sessionId: lane.sessionId,
      queued: lane.queue.map((q) => ({ text: q.text.length > 140 ? `${q.text.slice(0, 140)}\u2026` : q.text, images: q.images.length })),
      autoApprove: lane.autoApprove,
      sessionAllow: [...lane.sessionAllow],
      ...(lane.pending ? { pendingApproval: { summary: lane.pending.summary, kind: lane.pending.kind } } : {}),
    };
  }
}
