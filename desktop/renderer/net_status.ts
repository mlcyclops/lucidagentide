// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/net_status.ts - P-NETSTAT.1 (ADR-0422). Pure, DOM-free network verdicts shared by the
// engine (which probes the active provider's host and summarizes the samples) and the renderer (which
// paints the status-bar indicator and decides whether a failed turn is the network's fault or the
// model's). No fetch, no timers, no DOM: every function here is a total function of its inputs.
//
// Why this exists: on a fresh upgrade or a bad connection, a turn that died on the wire (DNS failure, a
// reset socket, omp's own startup handshake timing out while it waits on the network) was reported as
// "No response from Anthropic ... this model may be unavailable", with buttons to switch models. The
// model was never the problem, and switching models cannot fix a dropped connection.

/** The closed set of connection states the indicator shows. */
export type NetState = "checking" | "online" | "slow" | "unstable" | "offline";

/** One probe of the provider host: `ms` is the round trip when it answered, null when it did not. */
export interface NetSample { at: number; ok: boolean; ms: number | null }

/** What the engine reports on `/api/net-status` and the renderer paints. */
export interface NetView {
  state: NetState;
  /** Host that was probed (display only, never a URL the renderer fetches). */
  target: string;
  lastMs: number | null;
  /** Median round trip over the recent successful probes. */
  medianMs: number | null;
  /** Mean absolute difference between consecutive successful probes. */
  jitterMs: number | null;
  /** Share of failed probes over the RECENT newest probes, 0..1. */
  loss: number;
  samples: number;
  /** The last STABLE_RUN probes all answered: safe to resend a held prompt. */
  stable: boolean;
  lastOkAt: number | null;
  checkedAt: number | null;
  /** Oldest-first round trips over the window, null for a failed probe (the popover sparkline). */
  history: (number | null)[];
}

/** Probes kept for the summary. */
export const NET_WINDOW = 12;
/** Median round trip at or above this reads as a slow link. */
export const SLOW_MS = 800;
/** Probes that loss and the median are judged on (the newest of the window). */
export const RECENT = 6;
/** Failed share over the recent probes at or above this reads as unstable. */
export const UNSTABLE_LOSS = 0.25;
/** Consecutive answered probes before the link counts as stable again. */
export const STABLE_RUN = 3;
/** A held prompt is resent automatically at most this many times; after that the user decides. */
export const MAX_AUTO_RESEND = 2;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Summarize the most recent probes (oldest first) into the indicator's view. */
export function summarizeNet(all: readonly NetSample[], target: string): NetView {
  const samples = all.slice(-NET_WINDOW);
  const last = samples[samples.length - 1];
  const prev = samples[samples.length - 2];
  // Loss and the median read the last RECENT probes, not the whole window: after an outage the window is
  // full of misses, and judging on it would keep a recovered link "unstable" for half a minute.
  const recent = samples.slice(-RECENT);
  const recentOk = recent.filter((s) => s.ok && s.ms !== null).map((s) => s.ms!);
  const loss = recent.length ? (recent.length - recentOk.length) / recent.length : 0;
  const med = median(recentOk);
  let jitter: number | null = null;
  if (recentOk.length >= 2) {
    let sum = 0;
    for (let i = 1; i < recentOk.length; i++) sum += Math.abs(recentOk[i]! - recentOk[i - 1]!);
    jitter = Math.round(sum / (recentOk.length - 1));
  }
  const tail = samples.slice(-STABLE_RUN);
  const stable = tail.length === STABLE_RUN && tail.every((s) => s.ok);
  let state: NetState;
  if (!last) state = "checking";
  // One lone failure at boot is not yet "offline": the first probe also pays for DNS + TLS.
  else if (!last.ok && (!prev || !prev.ok)) state = samples.length === 1 ? "checking" : "offline";
  else if (!last.ok || loss >= UNSTABLE_LOSS) state = "unstable";
  else if (med !== null && med >= SLOW_MS) state = "slow";
  else state = "online";
  let lastOkAt: number | null = null;
  for (let i = samples.length - 1; i >= 0; i--) if (samples[i]!.ok) { lastOkAt = samples[i]!.at; break; }
  return {
    state, target, loss, stable, lastOkAt,
    lastMs: last?.ok ? last.ms : null,
    medianMs: med,
    jitterMs: jitter,
    samples: samples.length,
    checkedAt: last?.at ?? null,
    history: samples.map((s) => (s.ok ? s.ms : null)),
  };
}

/** "84 ms" under a second, "1.2 s" above. */
export function fmtLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "--";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The effective state: the OS saying "no network" wins over any engine answer. */
export function effectiveState(view: NetView | null, browserOnline: boolean): NetState {
  if (!browserOnline) return "offline";
  return view?.state ?? "checking";
}

export type NetTone = "ok" | "warn" | "bad" | "idle";
export interface NetLabel { tone: NetTone; text: string; title: string; detail: string }

/** Status-bar copy for a state + view. */
export function netLabel(view: NetView | null, browserOnline: boolean): NetLabel {
  const st = effectiveState(view, browserOnline);
  const host = view?.target ? ` to ${view.target}` : "";
  const lat = fmtLatency(view?.medianMs ?? view?.lastMs ?? null);
  switch (st) {
    case "online": return { tone: "ok", text: lat, title: "Network: online", detail: `Round trip${host} is ${lat}.` };
    case "slow": return { tone: "warn", text: `Slow ${lat}`, title: "Network: slow", detail: `Round trip${host} is ${lat}. Replies may take longer to start.` };
    case "unstable": return { tone: "warn", text: `Unstable ${Math.round((view?.loss ?? 0) * 100)}% loss`, title: "Network: unstable", detail: `Some checks${host} are not answered. LUCID waits for the connection to settle before it blames a model.` };
    case "offline": return { tone: "bad", text: "Offline", title: "Network: offline", detail: browserOnline ? `No answer${host}. LUCID waits and retries on its own.` : "This computer reports no network connection." };
    default: return { tone: "idle", text: "Checking", title: "Network: checking", detail: "Measuring the connection to your model provider." };
  }
}

/** Why a turn produced nothing. Only "model" earns the switch-model card. */
export type FailureCause = "network" | "starting" | "model";

/** Transport-level failure text: DNS, sockets, TLS, fetch. Never a provider's own refusal (429/5xx). */
const NETWORK_ERR = /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE|UND_ERR_[A-Z_]+)\b|getaddrinfo|socket hang up|fetch failed|network (error|is unreachable|connection)|unable to connect|connection (was )?(reset|refused|closed|lost)|failed to fetch|tls handshake|\bdns\b/i;
/** omp's startup handshake (spawn, initialize, session setup) ran out of time: the engine was still
 *  starting, which on a fresh upgrade or a slow link is a wait, not a model fault. A spawn failure
 *  ("failed to start", "not started") is an install problem and stays out of this class. */
const STARTUP_TIMEOUT = /^acp: (initialize|session\/(new|load|resume)|session\/set_config_option|session\/set_mode) timed out/i;

export interface FailureInput {
  reason?: string;
  view: NetView | null;
  browserOnline: boolean;
}

/** Classify a turn that produced no output. Network evidence wins, then a startup timeout, else the
 *  model (the provider answered, or said nothing, on a healthy link). */
export function classifyTurnFailure(i: FailureInput): FailureCause {
  const st = effectiveState(i.view, i.browserOnline);
  const reason = i.reason ?? "";
  if (st === "offline" || st === "unstable") return "network";
  if (reason && NETWORK_ERR.test(reason)) return "network";
  if (reason && st === "slow" && /timed out|timeout/i.test(reason)) return "network";
  if (reason && STARTUP_TIMEOUT.test(reason)) return "starting";
  return "model";
}

export interface Readiness { engine: boolean; network: boolean; models: boolean; settings: boolean }

/** The first thing still loading, in the order the user waits on them; null once everything landed. */
export function readinessPending(r: Readiness): string | null {
  if (!r.engine) return "Connecting to the LUCID engine";
  if (!r.network) return "Waiting for a stable network";
  if (!r.models) return "Loading models";
  if (!r.settings) return "Loading settings";
  return null;
}

export interface StandbyInput {
  cause: FailureCause;
  view: NetView | null;
  browserOnline: boolean;
  /** The live model list landed (omp's session is up). */
  modelsReady: boolean;
  /** How long the held prompt has waited. */
  waitedMs: number;
  /** Automatic resends already spent on this prompt. */
  attempts: number;
}
export interface StandbyVerdict {
  /** Resend the held prompt now. */
  resend: boolean;
  /** Stop waiting: the automatic budget is spent, hand the choice back to the user. */
  giveUp: boolean;
  /** One line naming what the held prompt waits on. */
  line: string;
}
/** A "starting" hold resends without the live model list after this long: the resend itself respawns
 *  the engine, and a list that never lands must not park the prompt forever. */
export const STARTUP_GRACE_MS = 15_000;

/** Decide what a held (standby) prompt does on this tick. */
export function standbyVerdict(i: StandbyInput): StandbyVerdict {
  if (i.attempts >= MAX_AUTO_RESEND) return { resend: false, giveUp: true, line: "Still failing after the connection came back." };
  const st = effectiveState(i.view, i.browserOnline);
  // `view.stable` (the last STABLE_RUN probes all answered) is the gate, not the loss-based state: a link
  // that has answered three times in a row is good enough to try, whatever the minute before looked like.
  const stable = i.browserOnline && !!i.view?.stable && st !== "offline";
  if (!stable) {
    return { resend: false, giveUp: false, line: st === "offline" ? "Waiting for the network to come back" : "Waiting for the connection to settle" };
  }
  if (i.cause === "starting" && !i.modelsReady && i.waitedMs < STARTUP_GRACE_MS) {
    return { resend: false, giveUp: false, line: "Waiting for LUCID to finish loading models" };
  }
  return { resend: true, giveUp: false, line: "Connection is stable, sending again" };
}

/** Warn/danger toasts raised while the link is down are held in the network popover instead of popping,
 *  because they are almost always the same outage wearing different words. Security notices are never
 *  held: a block, quarantine, approval or policy refusal must be seen whatever the network is doing. */
const NEVER_HOLD = /block|quarantin|secur|approv|denied|policy|lockdown|scan|gate|secret|credential/i;
export function shouldHoldToast(t: { tone?: string; title: string; desc: string }, view: NetView | null, browserOnline: boolean): boolean {
  if (t.tone !== "warn" && t.tone !== "danger") return false;
  if (NEVER_HOLD.test(t.title) || NEVER_HOLD.test(t.desc)) return false;
  const st = effectiveState(view, browserOnline);
  return st === "offline" || st === "unstable";
}

/** Map a model id to the host its turns travel to. Fixed table: the renderer's model id only SELECTS
 *  an entry, it can never name an arbitrary URL for the engine to fetch. `override` (the managed or env
 *  probe URL) wins; `asksageBase` is the configured gov gateway. */
export function probeTargetFor(model: string, opts: { override?: string; asksageBase?: string } = {}): string {
  if (opts.override) return opts.override;
  const v = model.toLowerCase();
  if (/asksage/.test(v) && opts.asksageBase) return opts.asksageBase;
  if (/claude|fable|anthropic/.test(v)) return "https://api.anthropic.com";
  if (/gemini|google/.test(v)) return "https://generativelanguage.googleapis.com";
  if (/grok|xai/.test(v)) return "https://api.x.ai";
  if (/openrouter/.test(v)) return "https://openrouter.ai";
  if (/gpt|openai|codex|(^|[-/])o\d/.test(v)) return "https://api.openai.com";
  // Unknown provider: the connectivity check Windows itself uses (NCSI). No credentials, no payload.
  return "http://www.msftconnecttest.com/connecttest.txt";
}

/** Display host for a probe URL (no scheme, no path). */
export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
