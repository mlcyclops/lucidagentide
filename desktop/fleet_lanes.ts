// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/fleet_lanes.ts
//
// P-FLEET.L1: local lanes - N concurrent headless LUCID agents on THIS machine, each its own gated omp
// subprocess (same `-e` security gate as the master session, invariant 4), its own ACP session (own cwd,
// own model), rendered as a mini window in the renderer's fleet grid and reported to the master agent via
// the fleet_status tool.
//
// Load-bearing decisions:
//   - Admission is capped by the 75% headroom guard (fleet_resources.ts over system_profile's sample):
//     the OS, the browser, and the user's other apps keep their headroom, and a refusal always carries
//     the measured number.
//   - One turn at a time PER LANE (one ACP session per lane; overlapping prompts on one session would
//     cross collectors - the ADR-0256 lesson). Parallelism is across lanes.
//   - Permission asks are FAIL-CLOSED: every session/request_permission surfaces to the lane's mini
//     window as needs-approval and waits for the user; no answer within the cap, or no dashboard
//     listening, means DENY. Lanes have no standing allowlists in L1 - a worker lane asking to run
//     something risky is exactly the moment a human should look.
//   - The model defaults to whatever the MASTER session is using right now, unless the user picks
//     another in the lane's dropdown (session/set_config_option, the same mechanism the master uses).

import { basename } from "node:path";
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ACPClient } from "./acp.ts";
import { laneAdmission, FLEET_WATERMARK_PCT, type LaneAdmission } from "./fleet_resources.ts";
import { sampleSystem, type SystemSnapshot } from "./system_profile.ts";

/** Closed set. Everything the LED can show; no other values, ever. */
export type LaneStatus = "starting" | "working" | "needs-approval" | "awaiting-input" | "done" | "error" | "stopped";

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
  pendingApproval?: { summary: string };
}

export type LaneEvent =
  | { type: "token" | "thinking"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "permission"; summary: string }
  | { type: "status"; status: LaneStatus }
  | { type: "done" }
  | { type: "error"; message: string };

export interface FleetStatusData {
  lanes: LaneView[];
  resources: { cpuPct: number | null; memPct: number | null; watermarkPct: number; maxLanes: number };
  masterModel: string;
}

/** One worker turn's deadline - ADR-0186's ten minutes of patience, same as P-FLEET.1's jobTimeoutMs. */
const LANE_TURN_TIMEOUT_MS = 600_000;
/** An unanswered approval is a DENY after this long (fail-closed; the ask stays visible until then). */
const APPROVAL_TIMEOUT_MS = 600_000;
/** ACP handshake bounds (P-KG-INGEST.5, ADR-0252: every request carries a clock). */
const HANDSHAKE_MS = 30_000;

export interface FleetLaneDeps {
  /** The gated omp argv for a lane (MUST carry the -e security gate; built by acp_backend). */
  argv: () => { cmd: string; args: string[] };
  /** The master session's current model - the lane default. */
  masterModel: () => string;
  /** Machine sample for admission + the dashboard headroom bar. */
  sample?: () => Promise<SystemSnapshot>;
  now?: () => number;
}

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
  pending: { summary: string; resolve: (allow: boolean) => void } | null;
  /** A prompt turn is in flight (one at a time per lane). */
  busy: boolean;
}

export class FleetLaneManager {
  readonly #lanes = new Map<string, Lane>();
  readonly #deps: Required<Pick<FleetLaneDeps, "argv" | "masterModel">> & { sample: () => Promise<SystemSnapshot>; now: () => number };
  /** Cached machine sample so a 2.5s status poll does not pay a 250ms CPU window every time. */
  #lastSample: { at: number; snap: SystemSnapshot } | null = null;

  constructor(deps: FleetLaneDeps) {
    this.#deps = { argv: deps.argv, masterModel: deps.masterModel, sample: deps.sample ?? (() => sampleSystem()), now: deps.now ?? Date.now };
  }

  /** Spawn a lane: admission first (75% guard), then the gated omp + ACP handshake + model select. */
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
      client: new ACPClient(plan.cmd, plan.args, cwd, {}),
      sessionId: null,
      sinks: new Set(),
      pending: null,
      busy: false,
    };
    this.#lanes.set(id, lane);
    this.#wire(lane);
    try {
      lane.client.start();
      await lane.client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }, { timeoutMs: HANDSHAKE_MS });
      const s = await lane.client.request<{ sessionId?: string; id?: string }>("session/new", { cwd, mcpServers: [] }, { timeoutMs: HANDSHAKE_MS });
      lane.sessionId = typeof s?.sessionId === "string" ? s.sessionId : typeof s?.id === "string" ? s.id : null;
      if (!lane.sessionId) throw new Error("lane agent returned no session id");
      // Model select: the lane defaults to the MASTER's current model unless the caller chose one.
      await this.#setModel(lane, lane.model);
      this.#setStatus(lane, "awaiting-input");
      return { ok: true, lane: this.#view(lane) };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      try { lane.client.stop(); } catch { /* already dead */ }
      this.#setStatus(lane, "error");
      return { ok: false, reason: `lane failed to start: ${why}` };
    }
  }

  /** One prompt turn on one lane, events streamed to `sink`. One turn at a time per lane. */
  async prompt(laneId: string, text: string, sink: (e: LaneEvent) => void): Promise<void> {
    const lane = this.#lanes.get(laneId);
    if (!lane || !lane.sessionId) { sink({ type: "error", message: `unknown lane "${laneId}"` }); return; }
    if (lane.busy) { sink({ type: "error", message: "lane is busy - one turn at a time per lane" }); return; }
    if (lane.status === "stopped" || lane.status === "error") { sink({ type: "error", message: `lane is ${lane.status}` }); return; }
    lane.busy = true;
    lane.sinks.add(sink);
    this.#setStatus(lane, "working");
    try {
      const res = await lane.client.request<{ stopReason?: string }>("session/prompt", { sessionId: lane.sessionId, prompt: [{ type: "text", text }] }, { timeoutMs: LANE_TURN_TIMEOUT_MS });
      // ACP cancel RESOLVES the prompt with stopReason "cancelled" (it does not reject) - a cancelled
      // turn goes back to awaiting-input, never "done".
      if (typeof res?.stopReason === "string" && /cancel/i.test(res.stopReason)) {
        this.#setStatus(lane, "awaiting-input");
      } else {
        lane.turns++;
        this.#setStatus(lane, "done");
      }
      this.#emit(lane, { type: "done" });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      // A cancelled turn settles as done-with-nothing rather than a scary error card.
      if (/cancel/i.test(why)) { this.#setStatus(lane, "awaiting-input"); this.#emit(lane, { type: "done" }); }
      else { this.#setStatus(lane, "error"); this.#emit(lane, { type: "error", message: why }); }
    } finally {
      lane.busy = false;
      lane.sinks.delete(sink);
    }
  }

  /** Answer the lane's pending approval. No pending ask is a quiet no-op (a late click, not an error). */
  answer(laneId: string, allow: boolean): { ok: boolean } {
    const lane = this.#lanes.get(laneId);
    if (!lane?.pending) return { ok: false };
    lane.pending.resolve(allow);
    return { ok: true };
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

  /** Shutdown path: deny open asks, cancel live turns, stop every child. */
  stopAll(): void {
    for (const lane of this.#lanes.values()) {
      if (lane.status === "stopped") continue;
      lane.pending?.resolve(false);
      if (lane.busy && lane.sessionId) { try { lane.client.notify("session/cancel", { sessionId: lane.sessionId }); } catch { /* dead */ } }
      try { lane.client.stop(); } catch { /* dead */ }
      this.#setStatus(lane, "stopped");
    }
  }

  async status(): Promise<FleetStatusData> {
    const a = await this.#admission(true);
    return {
      lanes: [...this.#lanes.values()].map((l) => this.#view(l)),
      resources: { cpuPct: a.cpuPct, memPct: a.memPct, watermarkPct: FLEET_WATERMARK_PCT, maxLanes: a.maxLanes },
      masterModel: this.#deps.masterModel(),
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────

  async #admission(cachedOk = false): Promise<LaneAdmission> {
    const now = this.#deps.now();
    if (!cachedOk || !this.#lastSample || now - this.#lastSample.at > 2_000) {
      this.#lastSample = { at: now, snap: await this.#deps.sample() };
    }
    const live = [...this.#lanes.values()].filter((l) => l.status !== "stopped" && l.status !== "error").length;
    return laneAdmission(this.#lastSample.snap, live);
  }

  async #setModel(lane: Lane, model: string): Promise<void> {
    if (!lane.sessionId || !model) return;
    await lane.client.request("session/set_config_option", { sessionId: lane.sessionId, configId: "model", value: model }, { timeoutMs: HANDSHAKE_MS });
    lane.model = model;
  }

  #wire(lane: Lane): void {
    lane.client.onNotify = (method, params) => {
      if (method !== "session/update") return;
      const u = params?.update ?? params;
      lane.lastActivityAt = this.#deps.now();
      switch (u?.sessionUpdate) {
        case "agent_message_chunk":
          if (u.content?.type === "text") this.#emit(lane, { type: "token", text: String(u.content.text) });
          break;
        case "agent_thought_chunk":
          if (u.content?.type === "text") this.#emit(lane, { type: "thinking", text: String(u.content.text) });
          break;
        case "tool_call":
        case "tool_call_update":
          this.#emit(lane, { type: "tool", name: String(u.kind ?? u.title ?? "tool"), detail: String(u.title ?? "") });
          break;
      }
    };
    lane.client.onRequest = async (method, params) => {
      // FAIL-CLOSED approvals: every ask goes to the human in the mini window; silence is a DENY.
      if (method === "session/request_permission") {
        const opts: { optionId?: string; kind?: string }[] = params?.options ?? [];
        const tc = params?.toolCall ?? params?.tool_call ?? {};
        const summary = String(tc.title ?? tc.kind ?? params?.tool ?? "a privileged action").slice(0, 300);
        const allow = await this.#askUser(lane, summary);
        if (!allow) return { outcome: { outcome: "cancelled" } };
        const a = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? "")) ?? opts[0];
        return a ? { outcome: { outcome: "selected", optionId: a.optionId } } : { outcome: { outcome: "cancelled" } };
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

  #askUser(lane: Lane, summary: string): Promise<boolean> {
    lane.pending?.resolve(false); // never two open asks - the older one dies as a deny
    const gate = Promise.withResolvers<boolean>();
    const resolve = (allow: boolean) => {
      clearTimeout(timer);
      if (lane.pending?.resolve === resolve) lane.pending = null;
      if (lane.status === "needs-approval") this.#setStatus(lane, lane.busy ? "working" : "awaiting-input");
      gate.resolve(allow);
    };
    const timer = setTimeout(() => resolve(false), APPROVAL_TIMEOUT_MS);
    lane.pending = { summary, resolve };
    this.#setStatus(lane, "needs-approval");
    this.#emit(lane, { type: "permission", summary });
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
      ...(lane.pending ? { pendingApproval: { summary: lane.pending.summary } } : {}),
    };
  }
}
