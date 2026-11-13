// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/remote_session.ts - P-RS-SESSION.1 (ADR-0572): a remote task's session screen, the way a local lane
// shows its own: the prompts, the model's turns, state changes and parked actions, kept live with no Refresh button.
//
// The spoke journals every turn, state change and parked action; this reads that journal through the engine's
// scanned recall. While a session is on screen its spoke's own `status` is read every FAST_MS while the task works
// or waits for approval (SLOW_MS otherwise), and the journal is read again, only after the last seq already shown,
// when the task's state, turn count or last change moved. So an idle session costs one status read now and then,
// and a working one a status read every few seconds plus one recall per change.
//
// The journal keeps a prompt as its hash and length only (add-on spoke.ts). A prompt sent from this window is
// remembered here (memory only, never stored) under that hash, so its own text shows; any other shows its size.
//
// Untrusted text rule (orbit_remote.ts): everything a spoke wrote reaches the DOM through textContent, never markup.
// A turn keeps its line breaks (pre-wrap) but is not rendered as markdown. Entries arrive scanned; a quarantined one
// shows only that it was withheld.

import type { LucidBridge } from "./bridge.ts";
import { sessionRows, type RecallEntryView, type RemoteTaskView, type SessionRow } from "./remote_spokes_model.ts";

export interface RemoteSessionDeps {
  remoteSpokeRecall: LucidBridge["remoteSpokeRecall"];
  remoteSpokeStatus: LucidBridge["remoteSpokeStatus"];
}

/** While the task works or waits for a person. */
const FAST_MS = 3_000;
/** While it is idle, stopped or closed. */
const SLOW_MS = 20_000;
/** Entries kept per session (the engine returns at most 200 per recall). */
const ENTRIES_MAX = 600;
/** Prompts remembered for this window. */
const PROMPTS_MAX = 200;

interface Session {
  node: string; task: string;
  entries: RecallEntryView[];
  /** The highest journal seq read; the next recall asks only for entries after it. */
  cursor: number;
  loaded: boolean;
  /** Older entries the first recall did not return (past the engine's display cap). */
  omitted: number;
  error: string;
  /** The task as the spoke reported it last (status), else as the hub snapshot did. */
  view: RemoteTaskView | null;
  /** state:turns:updatedAt when the journal was last read. */
  readAt: string;
  hosts: Set<HTMLElement>;
  nextAt: number;
  busy: boolean;
}

let deps: RemoteSessionDeps | null = null;
const sessions = new Map<string, Session>();
const prompts = new Map<string, string>();
let ticker: number | null = null;

export function initRemoteSession(d: RemoteSessionDeps): void { deps = d; }

/** Remember a prompt this window sends to a spoke, under the hash the spoke journals (sha256 of its UTF-8 text). */
export async function rememberPrompt(text: string): Promise<void> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  prompts.set(hex, text);
  if (prompts.size > PROMPTS_MAX) prompts.delete(prompts.keys().next().value!);
}

const working = (t: RemoteTaskView | null): boolean => t?.state === "working" || t?.state === "awaiting_approval";

/** Show `task`'s session in `host` and keep it live while `host` is in the document. Mounting the same task again
 *  only refreshes what is known (`known`: the hub snapshot's view of the task); another task replaces it. */
export function mountSession(host: HTMLElement, node: string, task: string, known: RemoteTaskView | null): void {
  const key = `${node}:${task}`;
  if (host.dataset.rsSession !== key) {
    for (const s of sessions.values()) s.hosts.delete(host);
    host.dataset.rsSession = key;
    host.className = `${host.className.replace(/\brs-sess\b/g, "").trim()} rs-sess`;
    host.innerHTML = `<div class="rs-sess-status"><i class="orbit-ghost-dot"></i><span></span></div><div class="fleet-out rs-sess-out"></div>`;
  }
  let s = sessions.get(key);
  if (!s) {
    s = { node, task, entries: [], cursor: 0, loaded: false, omitted: 0, error: "", view: known, readAt: "", hosts: new Set(), nextAt: 0, busy: false };
    sessions.set(key, s);
  }
  s.hosts.add(host);
  // The hub snapshot moved past what this session read: look now rather than at the next slow tick.
  if (known && (!s.view || known.updatedAt > s.view.updatedAt)) { s.view = known; s.nextAt = 0; }
  paint(s, host, true);
  if (ticker === null) ticker = window.setInterval(tick, 1_000);
  if (s.nextAt === 0) void tick();
}

async function tick(): Promise<void> {
  if (!deps) return;
  const now = Date.now();
  const due = new Map<string, Session[]>();
  for (const [key, s] of sessions) {
    for (const h of s.hosts) if (!h.isConnected || h.dataset.rsSession !== key) s.hosts.delete(h);
    if (s.hosts.size === 0) { sessions.delete(key); continue; }
    if (s.busy || now < s.nextAt) continue;
    due.set(s.node, [...(due.get(s.node) ?? []), s]);
  }
  if (sessions.size === 0 && ticker !== null) { window.clearInterval(ticker); ticker = null; }
  // One status read per spoke, however many of its sessions are open.
  await Promise.all([...due].map(([node, list]) => poll(node, list)));
}

async function poll(node: string, list: Session[]): Promise<void> {
  const d = deps!;
  for (const s of list) s.busy = true;
  const status = await d.remoteSpokeStatus(node).catch(() => null);
  await Promise.all(list.map(async (s) => {
    try {
      if (!status || !status.ok) {
        s.error = status ? status.error : "The engine did not answer.";
      } else {
        s.error = "";
        const t = status.tasks.find((x) => x.id === s.task) ?? null;
        if (t) s.view = t;
        const mark = t ? `${t.state}:${t.turns}:${t.updatedAt}` : "gone";
        if (!s.loaded || mark !== s.readAt) {
          const r = await d.remoteSpokeRecall(node, s.task, s.loaded ? s.cursor : undefined).catch(() => null);
          if (!r || !r.ok) s.error = r ? r.error : "The engine did not answer.";
          else {
            if (!s.loaded) s.omitted = r.omitted;
            const seen = new Set(s.entries.map((e) => e.seq));
            for (const e of r.entries) if (e.seq >= 0 && !seen.has(e.seq)) s.entries.push(e);
            s.entries.sort((a, b) => a.seq - b.seq);
            if (s.entries.length > ENTRIES_MAX) { s.omitted += s.entries.length - ENTRIES_MAX; s.entries.splice(0, s.entries.length - ENTRIES_MAX); }
            s.cursor = Math.max(s.cursor, ...r.entries.map((e) => e.seq));
            s.loaded = true;
            s.readAt = mark;
          }
        }
      }
    } finally {
      s.busy = false;
      s.nextAt = Date.now() + (working(s.view) ? FAST_MS : SLOW_MS);
      for (const h of s.hosts) paint(s, h, false);
    }
  }));
}

const STATE_WORDS: Record<RemoteTaskView["state"], string> = {
  working: "Working", awaiting_approval: "Waiting for your approval", idle: "Idle", error: "Error", stopped: "Stopped", closed: "Closed",
};

/** The status line, then the rows not yet in `host` (rows only ever append; a host that shows more is rebuilt). */
function paint(s: Session, host: HTMLElement, fresh: boolean): void {
  const status = host.querySelector<HTMLElement>(".rs-sess-status");
  const out = host.querySelector<HTMLElement>(".rs-sess-out");
  if (!status || !out) return;
  const v = s.view;
  const dot = status.querySelector("i");
  if (dot) dot.className = `orbit-ghost-dot rs-dot-${v?.state ?? "idle"}`;
  const line = status.querySelector("span");
  if (line) {
    line.textContent = s.error
      ? `Could not read the spoke: ${s.error}`
      : v ? `${STATE_WORDS[v.state]}${v.awaiting && v.state === "awaiting_approval" ? ` (${v.awaiting})` : ""} \u00b7 ${v.turns} ${v.turns === 1 ? "turn" : "turns"} \u00b7 updated ${new Date(v.updatedAt).toLocaleTimeString()}${s.loaded ? "" : " \u00b7 reading the journal\u2026"}`
      : "Reading the spoke\u2026";
  }
  const rows = sessionRows(s.entries, prompts);
  const painted = out.querySelectorAll("[data-rs-row]").length;
  const nearBottom = fresh || out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  if (painted > rows.length) out.replaceChildren();
  if (s.omitted && !out.querySelector("[data-rs-omitted]")) {
    const more = document.createElement("div");
    more.className = "rs-sess-evt";
    more.dataset.rsOmitted = "";
    more.textContent = `${s.omitted} older journal ${s.omitted === 1 ? "entry is" : "entries are"} not shown (Recall reads the whole journal).`;
    out.prepend(more);
  }
  for (const r of rows.slice(out.querySelectorAll("[data-rs-row]").length)) out.append(rowNode(r));
  const empty = out.querySelector("[data-rs-empty]");
  if (rows.length === 0 && s.loaded && !empty) {
    const e = document.createElement("div");
    e.className = "fleet-out-empty";
    e.dataset.rsEmpty = "";
    e.textContent = "Nothing in this task's journal yet.";
    out.append(e);
  } else if (rows.length && empty) empty.remove();
  if (nearBottom) out.scrollTop = out.scrollHeight;
}

function rowNode(r: SessionRow): HTMLElement {
  const n = document.createElement("div");
  n.dataset.rsRow = String(r.seq);
  n.title = r.ts ? new Date(r.ts).toLocaleString() : "";
  if (r.kind === "prompt") {
    n.className = "fleet-turn-user rs-sess-prompt";
    n.textContent = r.text ?? `Prompt sent (${r.chars} characters; sent from another window, so only its size is known here)`;
  } else if (r.kind === "turn") {
    n.className = "fleet-md rs-sess-turn";
    if (r.trust === "suspicious") {
      const pill = document.createElement("span");
      pill.className = "pill suspicious";
      pill.textContent = "suspicious";
      n.append(pill, document.createTextNode(" "));
    }
    n.append(document.createTextNode(r.text));
  } else if (r.kind === "event") {
    n.className = "rs-sess-evt";
    n.textContent = r.text;
  } else {
    n.className = "fleet-errline rs-sess-err";
    const span = document.createElement("span");
    span.textContent = r.text;
    n.append(span);
  }
  return n;
}
