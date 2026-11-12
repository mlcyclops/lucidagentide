// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/net_monitor.ts - P-NETSTAT.1 (ADR-0423). The renderer half of the network indicator:
// polls the engine's provider-latency probe, listens to the OS online/offline events, tracks what is
// still loading at boot (engine, network, models, settings), paints the status-bar segment + its
// popover, holds the outage's warn/danger toasts, and renders the "stand by" card that replaces the
// switch-model card when a turn died on the network. Every verdict is a pure call into net_status.ts;
// this file owns only timers and DOM.

import { bridge } from "./bridge.ts";
import { $, el } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import {
  effectiveState, type FailureCause, fmtLatency, netLabel, type NetView, RECENT, type Readiness, readinessPending,
  shouldHoldToast, standbyVerdict,
} from "./net_status.ts";
import { popover, setToastHold, type ToastOpts } from "./ui.ts";

/** Poll period while anything is unsettled (booting, offline, slow, unstable). */
const FAST_POLL_MS = 3_000;
/** Poll period once the link is stable and everything loaded. */
const STEADY_POLL_MS = 20_000;
/** Poll period while the window is hidden. */
const HIDDEN_POLL_MS = 60_000;
const MAX_HELD = 20;

let view: NetView | null = null;
let engineAnswered = false;
let modelOf: () => string = () => "";
const ready: Omit<Readiness, "engine" | "network"> = { models: false, settings: false };
/** Latched once everything first landed: the boot standby line never returns after that. */
let booted = false;
const held: { at: number; title: string; desc: string }[] = [];
const listeners = new Set<() => void>();
let segEl: HTMLElement | null = null;
let pop: { node: HTMLElement; close: () => void; reposition: () => void } | null = null;
let pollTimer = 0;
let polling = false;

const browserOnline = (): boolean => (typeof navigator === "undefined" ? true : navigator.onLine !== false);

/** What the standby cards and the failure classifier read. The view is withheld while the engine is not
 *  answering: its last probe is stale then, and a held prompt must not go out on an old "stable". */
export function netSnapshot(): { view: NetView | null; browserOnline: boolean; modelsReady: boolean } {
  return { view: engineAnswered ? view : null, browserOnline: browserOnline(), modelsReady: ready.models };
}

/** Subscribe to every state change (a probe landed, the OS flipped online, a readiness flag moved). */
export function onNetChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function readiness(): Readiness {
  return { engine: engineAnswered, network: browserOnline() && !!view?.stable, ...ready };
}

/** The boot line gives way after this long on a stable link even if something never loaded (no provider
 *  configured yet, say): the popover still lists what is missing, the status bar stops implying a wait. */
const BOOT_STANDBY_MAX_MS = 120_000;
const bootAt = Date.now();

/** Still in the boot standby (something the user waits on has not landed). */
export function netBooting(): boolean { return !booted; }

function changed(): void {
  if (!booted) {
    const r = readiness();
    if (readinessPending(r) === null || (r.engine && r.network && Date.now() - bootAt > BOOT_STANDBY_MAX_MS)) booted = true;
  }
  paintSeg();
  if (pop) paintPop();
  for (const fn of listeners) { try { fn(); } catch { /* one card's failure never stops the others */ } }
}

/** A boot dependency landed (or was lost). */
export function setNetReady(key: keyof typeof ready, on: boolean): void {
  if (ready[key] === on) return;
  ready[key] = on;
  changed();
}

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const v = await bridge.netStatus(modelOf());
    if (v) { view = v; engineAnswered = true; }
    else engineAnswered = false;
  } finally {
    polling = false;
  }
  changed();
}

function schedule(): void {
  window.clearTimeout(pollTimer);
  const settled = booted && effectiveState(view, browserOnline()) === "online" && !!view?.stable;
  const ms = document.hidden ? HIDDEN_POLL_MS : settled ? STEADY_POLL_MS : FAST_POLL_MS;
  pollTimer = window.setTimeout(() => { void poll().finally(schedule); }, ms);
}

/** Probe now (a user click, the OS reporting a change) and re-arm the cadence. */
export function checkNetNow(): void {
  void poll().finally(schedule);
}

/** Start the monitor once at boot. `model` names the model whose provider host is probed. */
export function startNetMonitor(model: () => string): void {
  modelOf = model;
  window.addEventListener("online", () => { changed(); checkNetNow(); });
  window.addEventListener("offline", () => { changed(); checkNetNow(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkNetNow(); });
  setToastHold((o: ToastOpts) => {
    if (!shouldHoldToast(o, view, browserOnline())) return false;
    held.unshift({ at: Date.now(), title: o.title, desc: o.desc });
    if (held.length > MAX_HELD) held.length = MAX_HELD;
    changed();
    return true;
  });
  checkNetNow();
}

/** Re-adopt the persistent segment after renderStatus's innerHTML swap, just right of the context ring. */
export function mountNetSeg(): void {
  if (!segEl) {
    segEl = el(`<div class="seg seg-btn net-seg" id="netSeg" role="button" tabindex="0" aria-haspopup="dialog"></div>`);
    segEl.addEventListener("click", () => { if (pop) pop.close(); else openPop(); });
    segEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); segEl!.click(); } });
    paintSeg();
  }
  const sb = document.getElementById("statusbar");
  if (!sb || sb.contains(segEl)) return;
  const ring = sb.querySelector(".seg.ctx");
  if (ring) ring.after(segEl); else sb.prepend(segEl);
}

function paintSeg(): void {
  if (!segEl) return;
  const lab = netLabel(netSnapshot().view, browserOnline());
  const pending = booted ? null : readinessPending(readiness());
  segEl.dataset.tone = pending && lab.tone === "ok" ? "idle" : lab.tone;
  segEl.classList.toggle("standby", !!pending);
  // Every text run is its own element (invariant #11: a flex row holds single text children).
  segEl.innerHTML = `<span class="net-dot"></span><span class="net-txt"></span>${held.length ? `<span class="net-held"></span>` : ""}`;
  ($(".net-txt", segEl) as HTMLElement).textContent = pending ? `${pending}\u2026 ${lab.text}` : lab.text;
  if (held.length) ($(".net-held", segEl) as HTMLElement).textContent = String(held.length);
  segEl.setAttribute("data-tip", `${lab.title}|${pending ? `${pending}. ` : ""}${lab.detail} Click for latency details.`);
  segEl.setAttribute("aria-label", `${lab.title}. ${lab.text}`);
}

function openPop(): void {
  if (!segEl) return;
  pop = popover(segEl, `<div class="net-pop"></div>`, () => { pop = null; });
  pop.node.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-net-check]")) { checkNetNow(); return; }
    if (t.closest("[data-net-clear]")) { held.length = 0; changed(); }
  });
  paintPop();
  checkNetNow();
}

function sparkHtml(hist: readonly (number | null)[]): string {
  const peak = Math.max(400, ...hist.map((h) => h ?? 0));
  return hist.map((h) => h === null
    ? `<span class="net-bar fail" style="height:100%"></span>`
    : `<span class="net-bar" style="height:${Math.max(8, Math.round((h / peak) * 100))}%"></span>`).join("");
}

function paintPop(): void {
  if (!pop) return;
  const box = $(".net-pop", pop.node) as HTMLElement | null;
  if (!box) return;
  const on = browserOnline();
  const lab = netLabel(netSnapshot().view, on);
  const r = readiness();
  const row = (k: string, v: string) => `<div class="net-row"><span class="net-k">${esc(k)}</span><span class="net-v">${esc(v)}</span></div>`;
  const check = (label: string, ok: boolean) => `<div class="net-check${ok ? " ok" : ""}">${icon(ok ? "check" : "clock", 12)}<span>${esc(label)}</span></div>`;
  box.innerHTML = `
    <div class="net-pop-head" data-tone="${lab.tone}"><span class="net-dot"></span><span>${esc(lab.title)}</span></div>
    <div class="net-pop-detail"></div>
    ${view?.history.length ? `<div class="net-spark" aria-hidden="true">${sparkHtml(view.history)}</div>` : ""}
    ${row("Provider host", view?.target || "not measured yet")}
    ${row("Last round trip", fmtLatency(view?.lastMs ?? null))}
    ${row("Median", fmtLatency(view?.medianMs ?? null))}
    ${row("Jitter", fmtLatency(view?.jitterMs ?? null))}
    ${row("Failed checks", view ? `${Math.round(view.loss * 100)}% of the last ${Math.min(view.samples, RECENT)}` : "--")}
    ${row("This computer", on ? "reports a network connection" : "reports no network connection")}
    <div class="net-pop-sub">Getting ready</div>
    ${check("LUCID engine", r.engine)}${check("Stable network", r.network)}${check("Models", r.models)}${check("Settings", r.settings)}
    ${held.length ? `<div class="net-pop-sub">Held while the connection was down (${held.length})</div><div class="net-held-list"></div>` : ""}
    <div class="net-pop-acts"><button class="btn-mini" data-net-check>${icon("refresh", 12)} Check now</button>${held.length ? `<button class="btn-mini" data-net-clear>Clear held notices</button>` : ""}</div>`;
  ($(".net-pop-detail", box) as HTMLElement).textContent = lab.detail;
  const list = $(".net-held-list", box) as HTMLElement | null;
  if (list) for (const h of held) {
    const item = el(`<div class="net-held-item"><div class="net-held-t"></div><div class="net-held-d"></div></div>`);
    ($(".net-held-t", item) as HTMLElement).textContent = h.title;
    ($(".net-held-d", item) as HTMLElement).textContent = h.desc;
    list.append(item);
  }
  pop.reposition();
}

export interface StandbyOpts {
  cause: Exclude<FailureCause, "model">;
  /** The raw failure, shown small for the curious; never the headline. */
  reason?: string;
  /** Automatic resends already spent on this prompt. */
  attempts: number;
  /** The prompt was never sent (the send itself was held while offline). */
  held?: boolean;
  /** Resend the held prompt. Returns false when it cannot go yet (the composer is busy); the card
   *  then tries again on the next tick. */
  resend: () => boolean;
  /** The automatic budget is spent: hand over to the switch-model card. */
  giveUp: () => void;
}

/** Replace a failed turn's empty bubble with a "stand by" card: live network readout, what the prompt
 *  waits on, and an automatic resend once the connection is stable. Self-detaches when removed. */
export function renderNetStandby(container: HTMLElement, o: StandbyOpts): void {
  const startedAt = Date.now();
  let done = false;
  container.innerHTML = `<div class="netwait-card" data-cause="${o.cause}">
    <div class="netwait-h">${icon("clock", 14)}<span class="netwait-title"></span></div>
    <div class="netwait-b"></div>
    <div class="netwait-live"><span class="net-dot"></span><span class="netwait-lat"></span></div>
    <div class="netwait-line"></div>
    ${o.reason ? `<div class="netwait-sr"></div>` : ""}
    <div class="netwait-actions"><button class="btn-mini ok" data-netwait-now>${icon("send", 12)} Send now</button><button class="btn-mini" data-netwait-stop>Stop waiting</button></div>
  </div>`;
  const card = $(".netwait-card", container) as HTMLElement;
  ($(".netwait-title", card) as HTMLElement).textContent = o.cause === "starting" ? "LUCID is still starting up" : "Waiting for a stable connection";
  ($(".netwait-b", card) as HTMLElement).textContent = o.held
    ? "You are offline, so your message has not been sent yet. It is kept here and goes out as soon as the connection is stable."
    : o.cause === "starting" && /AppContainer/i.test(o.reason ?? "")
    ? "The agent engine was starting inside the Windows sandbox and did not answer in time. This is not a problem with your model. Your message is kept and will be sent again when everything has loaded."
    : o.cause === "starting"
    ? "The agent engine did not finish loading in time. This is common right after an update or on a slow connection, and it is not a problem with your model. Your message is kept and will be sent again when everything has loaded."
    : "Your message did not reach the model provider because the network dropped or is unstable. This is not a problem with your model. Your message is kept and will be sent again when the connection is stable.";
  const sr = $(".netwait-sr", card) as HTMLElement | null;
  if (sr) sr.textContent = `Details: ${o.reason}`;
  const live = $(".netwait-live", card) as HTMLElement, lat = $(".netwait-lat", card) as HTMLElement, line = $(".netwait-line", card) as HTMLElement;
  let unsub: () => void = () => {};
  let tick = 0;
  const finish = (): void => { done = true; unsub(); window.clearInterval(tick); };
  const step = (): void => {
    if (done) return;
    if (!container.isConnected) { finish(); return; }
    const s = netSnapshot();
    const lab = netLabel(s.view, s.browserOnline);
    const st = effectiveState(s.view, s.browserOnline);
    live.dataset.tone = lab.tone;
    lat.textContent = st === "offline" || st === "checking" ? lab.title : `${lab.title} \u00b7 ${fmtLatency(s.view?.medianMs ?? s.view?.lastMs ?? null)}`;
    const v = standbyVerdict({ cause: o.cause, view: s.view, browserOnline: s.browserOnline, modelsReady: s.modelsReady, waitedMs: Date.now() - startedAt, attempts: o.attempts });
    if (v.giveUp) { finish(); o.giveUp(); return; }
    line.textContent = `${v.line}\u2026 (waiting ${Math.round((Date.now() - startedAt) / 1000)}s)`;
    if (v.resend && o.resend()) { finish(); line.textContent = "Sent again."; card.classList.add("sent"); $(".netwait-actions", card)?.remove(); }
  };
  ($("[data-netwait-now]", card) as HTMLElement).addEventListener("click", () => {
    if (done) return;
    if (o.resend()) { finish(); line.textContent = "Sent again."; card.classList.add("sent"); $(".netwait-actions", card)?.remove(); }
  });
  ($("[data-netwait-stop]", card) as HTMLElement).addEventListener("click", () => {
    finish();
    line.textContent = "Stopped waiting. Nothing more will be sent; your message is above if you want to send it yourself.";
    $(".netwait-actions", card)?.remove();
  });
  unsub = onNetChange(step);
  tick = window.setInterval(step, 1000);
  step();
}
