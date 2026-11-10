// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535; P-HERD.5, ADR-0494): ATTENTION. Which lanes wait on the human, which finished
// turns the human has not looked at yet, a jump to the next one, and notifications the user turns on.
//
//   attention   "needs-you" | "unseen" | "none", beside the LaneStatus, never instead of it (the
//               engine's status stays verbatim, ADR-0271). needs-you = an ask is open (needs-approval,
//               or a pendingApproval on the lane), or the lane is error/stopped AND offers a retry
//               (P-FLEET.L4). unseen = the lane settled (done, error, stopped) into a state the seen
//               ledger has not had on screen. awaiting-input is NOT an ask in this engine: a spawned,
//               cancelled or respawned lane rests there, ready for a prompt (hub_program_status.ts
//               maps it to idle for the same reason).
//   seen        server state, not engine state: a lane is seen once its settled state (turn count +
//               status) was in the FOCUSED pane while at least one client was attached. Focus is
//               server state shared by every client (ADR-0490 item 3), so "a client had it on screen
//               in a focused pane" is exactly that. A status change while focused counts as seen.
//   next        prefix+a and `:next`: the oldest open ask first, then the oldest unseen lane, never
//               the lane already focused; it focuses a pane showing the lane or binds the focused
//               pane to it (ADR-0420).
//   alerts      off by default (`notify` in hub-keys.json, keys.ts): the bell is BEL on a lane
//               entering needs-you; desktop is the terminal's own escape (OSC 9 or OSC 777) on
//               needs-you and on a newly unseen turn. The text is the lane name and its status,
//               never ask text or reply text. The client decides whether its terminal speaks an
//               escape at all (terminalNotifyKind); otherwise it writes nothing.
//   notify      `lucid herd notify <title> [--body <text>] [--lane <lane>]` for scripts: one per
//               lane (else per title) per 10 s.
//
// Everything above the HerdAttention class is pure.

import { HubOpError } from "../../../harness/launcher/hub_spaces.ts";

export type Attention = "needs-you" | "unseen" | "none";

/** What a client does with one alert: BEL, a desktop notification, or both. */
export interface HerdAlert {
  t: "alert";
  bell: boolean;
  desktop: { title: string; body: string } | null;
}

/** The `notify` block of hub-keys.json (keys.ts parses it; every field defaults to false). */
export interface NotifySettings {
  bell: boolean;
  desktop: boolean;
  sound: boolean;
}

/** One notification per key per this many ms (`lucid herd notify`). */
export const NOTIFY_INTERVAL_MS = 10_000;
/** The id a Main conversation pane (P-HERD.6) goes by among next-target candidates. */
export const MAIN_TARGET = "@main";

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const SETTLED: Record<string, true> = { done: true, error: true, stopped: true };

/** An ask is open on the lane: a tool call waits for the human's allow or deny. */
export function hasOpenAsk(lane: Record<string, unknown>): boolean {
  if (lane.status === "needs-approval") return true;
  const p = lane.pendingApproval;
  return typeof p === "object" && p !== null && "summary" in p && typeof p.summary === "string" && p.summary !== "";
}

/** The settled state a seen mark is made against: turn count + status, or null while the lane is
 *  not settled (starting, working, awaiting-input, an ask). */
export function settleKey(lane: Record<string, unknown>): string | null {
  const status = str(lane.status);
  if (SETTLED[status] !== true) return null;
  const turns = typeof lane.turns === "number" && Number.isFinite(lane.turns) ? lane.turns : 0;
  return `${turns}|${status}`;
}

/** A lane's attention given the seen ledger's mark for it (undefined = never seen). */
export function laneAttention(lane: Record<string, unknown>, seen: string | undefined): Attention {
  const status = str(lane.status);
  if (hasOpenAsk(lane)) return "needs-you";
  if ((status === "error" || status === "stopped") && lane.canRetry === true) return "needs-you";
  const key = settleKey(lane);
  return key !== null && key !== seen ? "unseen" : "none";
}

/** Sort rank: needs-you, then unseen, then none (the rail's order among equal priorities). */
export function attentionRank(a: Attention | undefined): number {
  return a === "needs-you" ? 0 : a === "unseen" ? 1 : 2;
}

export interface NextCandidate {
  id: string;
  name: string;
  attention: Attention;
  /** When the lane entered this attention (ms); oldest first. */
  since: number;
}

/** prefix+a: the oldest needs-you, else the oldest unseen, skipping the target already focused. */
export function nextTarget(cands: readonly NextCandidate[], focused: string | null): NextCandidate | null {
  const pool = cands
    .filter((c) => c.attention !== "none" && c.id !== focused)
    .sort((a, b) => attentionRank(a.attention) - attentionRank(b.attention) || a.since - b.since || a.id.localeCompare(b.id));
  return pool[0] ?? null;
}

/** Text safe inside a terminal escape: no control characters (C0, DEL, C1), no `;` (the OSC 777
 *  field separator), trimmed, at most `max` characters. */
export function cleanNotifyText(s: string, max = 64): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/;/g, ",").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The ONLY text an automatic notification carries: the lane name and its status. */
export function notificationText(name: string, status: string): { title: string; body: string } {
  return { title: cleanNotifyText(name) || "agent", body: cleanNotifyText(status) || "?" };
}

export type DesktopEscape = "osc9" | "osc777";

/** The bytes for one desktop notification in the terminal's own escape. */
export function desktopEscape(kind: DesktopEscape, n: { title: string; body: string }): string {
  const title = cleanNotifyText(n.title);
  const body = cleanNotifyText(n.body, 200);
  return kind === "osc9" ? `\x1b]9;${title}: ${body}\x1b\\` : `\x1b]777;notify;${title};${body}\x1b\\`;
}

/** Which escape this client's terminal shows as a desktop notification, or null (write nothing).
 *  `protocol` is pi-tui's notify protocol for the identified terminal (TERMINAL.notifyProtocol, the
 *  identity omp itself trusts): OSC 9 there. foot and rxvt-unicode speak OSC 777. Inside tmux a
 *  bare OSC never reaches the outer terminal, so nothing. */
export function terminalNotifyKind(protocol: string, env: Readonly<Record<string, string | undefined>>): DesktopEscape | null {
  if (env.TMUX) return null;
  if (protocol === "\x1b]9;") return "osc9";
  if (/^(foot|rxvt-unicode)/.test(env.TERM ?? "")) return "osc777";
  return null;
}

/** One per key per NOTIFY_INTERVAL_MS. Old keys are dropped as they expire. */
export class NotifyLimiter {
  readonly #last = new Map<string, number>();

  allow(key: string, now: number): boolean {
    for (const [k, at] of this.#last) if (now - at >= NOTIFY_INTERVAL_MS) this.#last.delete(k);
    if (this.#last.has(key)) return false;
    this.#last.set(key, now);
    return true;
  }
}

// ---- the server's attention state ----------------------------------------------------------------

/** What HerdAttention needs from the Herd server. */
export interface AttentionHost {
  /** The lane id in the focused pane of the active tab (MAIN_TARGET for a Main pane), else null. */
  focused(): string | null;
  /** Attached clients right now (seen needs someone looking). */
  clients(): number;
  /** Focus a pane showing the lane, else bind the focused pane to it (ADR-0420). */
  show(laneId: string, name: string): Promise<void>;
  /** Send one alert to every attached client. */
  alert(a: HerdAlert): void;
  /** The `notify` settings as the user wrote them right now. */
  settings(): NotifySettings;
  now(): number;
  /** P-HERD.6: the Main conversation's open ask, and how to show its pane. */
  main?: { ask(): { kind: string; summary: string } | null; show(): Promise<void> };
}

export class HerdAttention {
  readonly #host: AttentionHost;
  #lanes: Record<string, unknown>[] = [];
  /** laneId -> the settle key last on screen in a focused pane. */
  readonly #seen = new Map<string, string>();
  /** laneId -> the attention it holds and since when (alerts fire on a change; next sorts by it). */
  readonly #state = new Map<string, { attention: Attention; since: number }>();
  #mainSince: number | null = null;
  #primed = false;
  readonly #limiter = new NotifyLimiter();

  constructor(host: AttentionHost) {
    this.#host = host;
  }

  /** Every fresh fleet snapshot (the server's poll and onFleet). */
  update(lanes: readonly Record<string, unknown>[]): void {
    this.#lanes = [...lanes];
    this.touch();
    this.#primed = true;
  }

  /** Something on screen may have changed (focus, a frame): re-mark seen and re-derive attention. */
  touch(): void {
    const focused = this.#host.focused();
    const ids = new Set<string>();
    const now = this.#host.now();
    const fired: { attention: Attention; name: string; status: string }[] = [];
    for (const lane of this.#lanes) {
      const id = str(lane.id);
      if (!id) continue;
      ids.add(id);
      const key = settleKey(lane);
      if (key !== null && id === focused && this.#host.clients() > 0) this.#seen.set(id, key);
      const attention = laneAttention(lane, this.#seen.get(id));
      if (this.#state.get(id)?.attention === attention) continue;
      this.#state.set(id, { attention, since: now });
      if (attention !== "none") fired.push({ attention, name: str(lane.name) || id, status: str(lane.status) });
    }
    for (const id of [...this.#state.keys()]) if (!ids.has(id)) { this.#state.delete(id); this.#seen.delete(id); }
    const ask = this.#host.main?.ask() ?? null;
    if (ask && this.#mainSince === null) {
      this.#mainSince = now;
      fired.push({ attention: "needs-you", name: "Main", status: "needs-approval" });
    } else if (!ask) this.#mainSince = null;
    // The first snapshot after start only learns: a server restart does not ring for old asks. The
    // settings file is read only when something would fire, never per frame.
    if (this.#primed && fired.length) {
      const settings = this.#host.settings();
      for (const f of fired) {
        const bell = settings.bell && f.attention === "needs-you";
        const desktop = settings.desktop ? notificationText(f.name, f.status) : null;
        if (bell || desktop) this.#host.alert({ t: "alert", bell, desktop });
      }
    }
  }

  attention(laneId: string): Attention {
    return this.#state.get(laneId)?.attention ?? "none";
  }

  /** The lane record with `attention` beside its verbatim `status` (agent list, agent status). */
  annotate<T extends Record<string, unknown>>(lane: T): T & { attention: Attention } {
    const id = str(lane.id);
    const known = this.#state.get(id);
    return { ...lane, attention: known ? known.attention : laneAttention(lane, this.#seen.get(id)) };
  }

  /** prefix+a and `:next`. Resolves with the status-line text. */
  async focusNext(): Promise<string> {
    const cands: NextCandidate[] = [];
    for (const lane of this.#lanes) {
      const id = str(lane.id);
      const s = this.#state.get(id);
      if (s) cands.push({ id, name: str(lane.name) || id, attention: s.attention, since: s.since });
    }
    if (this.#mainSince !== null) cands.push({ id: MAIN_TARGET, name: "Main", attention: "needs-you", since: this.#mainSince });
    const t = nextTarget(cands, this.#host.focused());
    if (!t) return "nothing else needs you and nothing is unseen";
    if (t.id === MAIN_TARGET && this.#host.main) await this.#host.main.show();
    else await this.#host.show(t.id, t.name);
    this.touch();
    return `${t.name}: ${t.attention === "needs-you" ? "needs you" : "unseen"}`;
  }

  /** `lucid herd notify`: a script's own notification, through the same settings and clients. */
  notify(req: { title: string; body: string; lane: string | null }): { bell: boolean; desktop: boolean; clients: number } {
    const key = req.lane !== null ? `lane:${req.lane}` : `title:${req.title}`;
    if (!this.#limiter.allow(key, this.#host.now())) {
      throw new HubOpError("rate_limited", `one notification per ${req.lane !== null ? "lane" : "title"} per ${NOTIFY_INTERVAL_MS / 1000}s`);
    }
    const settings = this.#host.settings();
    const desktop = settings.desktop ? { title: cleanNotifyText(req.title) || "LUCID", body: cleanNotifyText(req.body, 200) } : null;
    const clients = this.#host.clients();
    if ((settings.bell || desktop) && clients > 0) this.#host.alert({ t: "alert", bell: settings.bell, desktop });
    return { bell: settings.bell, desktop: desktop !== null, clients };
  }
}
