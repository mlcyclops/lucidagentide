// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535; P-HERD.6, ADR-0495): MAIN IS A PANE. The engine's own conversation (Main, the hub of
// the GUI's hub-and-spoke) drawn in a hub pane beside its spokes, over the same routes the desktop
// renderer uses:
//
//   GET  /api/session/busy          Main's session id and why a switch would stop work (P-SWITCH.1)
//   GET  /api/sessions              the session rows (title; where each one is live)
//   GET  /api/session?id&limit      the settled turns of Main's session
//   GET  /api/chat/status           the running turn's id, if any
//   POST /api/chat/attach {turnId}  observe that turn: a snapshot, its parked asks, then every event
//   POST /api/chat {text}           a typed prompt; the in-process gate scans it like any other
//   POST /api/chat/cancel {turnId}  stop the running turn
//   POST /api/chat/permission       answer a parked ask: ONLY from an attached client's y/s/d keys
//   GET/POST /api/config, /api/setConfig, /api/modes   the model and mode pickers
//   POST /api/session/load {id}     open a session as Main; refused while Main is busy (409)
//
// The pane is a VIEWER of the one session: every client of the server sees the same frame, and the
// GUI showing Main sees the same turn, because the turn is observed through /api/chat/attach rather
// than owned by this pane. A turn started here is observed through its own /api/chat stream.
//
// Human-only stays human-only (ADR-0495 item 4): nothing on the control plane reaches the permission
// route. `main prompt` rides /api/chat as a typed prompt and is refused `agent_blocked` while Main
// waits on the human; `session open --as main` is refused `busy` exactly as the GUI is.
//
// Not here: "attachments by path through /api/chat/attach" (ADR-0495 item 1). That route attaches an
// observer to a running turn (P-RECOVER); the engine has no attachment-by-path route to call.

import { matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { HubOpError } from "../../../harness/launcher/hub_spaces.ts";
import type { HubOp } from "../../../harness/launcher/hub_tmux_verbs.ts";
import { fitBlock, HUB_COLORS, pickerMatches, wrapText, type HubHostDeck, type ModelOption } from "../../../harness/launcher/hub_tui.ts";

const { ACCENT, ACCENT_2, AMBER, CYAN, LINE, TXT, TXT_3 } = HUB_COLORS;

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const MAIN_POLL_MS = 2000;
/** Whole-turn thinking retention, as the agent pane keeps it: the cap only bounds a runaway stream. */
const THINKING_CAP = 500_000;
const HISTORY_MESSAGES = 40;
/** `main prompt --wait` answers inside the control client's 90 s request window. */
const WAIT_MS = 80_000;

// ---- the row model (pure) -------------------------------------------------------------------------

export interface MainAskOption { optionId: string; name: string; kind: string }
/** A parked permission ask, as the engine's `permission` event carries it. */
export interface MainAsk { id: string; tool: string; detail: string; options: MainAskOption[] }
/** Main's current (or last) turn as observed: what makes a working model visible. */
export interface MainTurn {
  turnId: string;
  prompt: string;
  text: string;
  thinking: string;
  trimmed: boolean;
  tools: string[];
  working: boolean;
  asks: MainAsk[];
  error: string;
}

export const idleTurn = (): MainTurn => ({ turnId: "", prompt: "", text: "", thinking: "", trimmed: false, tools: [], working: false, asks: [], error: "" });

/** Fold one NDJSON event of /api/chat or /api/chat/attach into the turn. A snapshot of ANOTHER turn
 *  starts fresh; the thinking and tool trail of a settled turn stays until the next one begins. */
export function foldMainEvent(t: MainTurn, raw: unknown): MainTurn {
  const e = rec(raw);
  switch (e.type) {
    case "turn-snapshot": {
      const s = rec(e.snapshot);
      const turnId = str(s.turnId);
      const base = turnId === t.turnId ? t : idleTurn();
      return { ...base, turnId, prompt: str(s.prompt) || base.prompt, text: str(s.text), working: s.running === true };
    }
    case "token": return { ...t, text: t.text + str(e.text), working: true };
    case "thinking": {
      const grown = t.thinking + str(e.text);
      return { ...t, thinking: grown.slice(-THINKING_CAP), trimmed: t.trimmed || grown.length > THINKING_CAP, working: true };
    }
    case "tool": return { ...t, tools: [...t.tools, str(e.name) || "tool"].slice(-6), working: true };
    case "permission": {
      const id = str(e.id);
      if (!id || t.asks.some((a) => a.id === id)) return t;
      const options = arr(e.options).map(rec)
        .map((o) => ({ optionId: str(o.optionId), name: str(o.name) || str(o.optionId), kind: str(o.kind) }))
        .filter((o) => o.optionId !== "");
      return { ...t, asks: [...t.asks, { id, tool: str(e.tool) || "tool", detail: str(e.detail), options }] };
    }
    case "error": return { ...t, error: str(e.message) || "the engine reported an error" };
    // The settled reply now lives in the session's history (refetched on done).
    case "done": return { ...t, text: "", working: false, asks: [] };
    default: return t;
  }
}

export type AnswerKey = "y" | "s" | "d";

/** Which of the ask's OWN options a key picks. y: the one-call allow (else the first allow). s: an
 *  allow that lasts past this call but not forever (allow_always, or for the rest of this turn); a
 *  standing "always allow this site" or a "danger" option is never on a key. d: the ask's deny, else
 *  no option at all, which the engine reads as deny (fail-closed). Null: this ask has nothing for
 *  that key. */
export function answerOption(ask: MainAsk, key: AnswerKey): { optionId: string | null; name: string } | null {
  const allows = ask.options.filter((o) => /^allow/i.test(o.kind) || (o.kind === "" && /allow/i.test(o.optionId)));
  const once = allows.find((o) => /once/i.test(o.optionId) || /once/i.test(o.kind)) ?? allows[0];
  if (key === "y") return once ? { optionId: once.optionId, name: once.name } : null;
  if (key === "s") {
    const longer = allows.find((o) => o !== once && /always|turn|session/i.test(`${o.kind} ${o.optionId}`) && !/site|program/i.test(o.optionId));
    return longer ? { optionId: longer.optionId, name: longer.name } : null;
  }
  const deny = ask.options.find((o) => /^reject/i.test(o.kind) || /deny|reject|block/i.test(o.optionId));
  return deny ? { optionId: deny.optionId, name: deny.name } : { optionId: null, name: "Deny" };
}

/** The key line under an ask: only the keys this ask answers, with the engine's own option names. */
export function askKeys(ask: MainAsk): string {
  return (["y", "s", "d"] as const).flatMap((k) => {
    const o = answerOption(ask, k);
    return o ? [`${k} ${o.name}`] : [];
  }).join(" · ");
}

export interface MainView { history: readonly { role: string; text: string }[]; turn: MainTurn }

/** The pane body before scrolling: settled turns, the running turn (its prompt until the history
 *  carries it, thinking, tools, streaming text), then each parked ask. A leading \u0001 marks a dim
 *  activity row and \u0002 an amber ask row (stripped before paint), as the agent pane does. */
export function mainRows(v: MainView, innerW: number): string[] {
  const lines: string[] = [];
  const said = (role: string, text: string) => {
    lines.push("");
    for (const [j, row] of wrapText(text, innerW - 2).entries()) lines.push(role === "user" ? (j === 0 ? `› ${row}` : `  ${row}`) : `  ${row}`);
  };
  for (const m of v.history) said(m.role, m.text);
  const t = v.turn;
  const last = v.history.at(-1);
  if (t.working && t.prompt && !(last?.role === "user" && last.text.trim() === t.prompt.trim())) said("user", t.prompt);
  if (t.text || t.thinking || t.tools.length || t.working || t.error) {
    lines.push("");
    if (t.thinking) {
      if (t.trimmed) lines.push("\u0001  … the earliest thinking exceeded the 500k retention cap and was trimmed");
      lines.push(`\u0001thinking${t.working && !t.text ? "" : " (this turn)"}`);
      for (const row of wrapText(t.thinking, innerW - 4)) lines.push(`\u0001  ${row}`);
    }
    if (t.tools.length) lines.push(`\u0001⚙ ${t.tools.join(" · ")}`);
    if (t.text) for (const row of wrapText(t.text, innerW - 2)) lines.push(`  ${row}`);
    else if (t.working) lines.push("\u0001… Main is working");
    if (t.error) lines.push(`\u0002✗ ${t.error}`);
  }
  for (const ask of t.asks) {
    lines.push("", `\u0002⚠ approval needed (${ask.tool})`);
    for (const row of wrapText(ask.detail || "(no detail)", innerW - 4)) lines.push(`\u0002  ${row}`);
    lines.push(`\u0002  ${askKeys(ask)}`);
  }
  if (lines.length === 0) lines.push("", "  no turns yet - press ⏎ and type to talk to Main");
  return lines;
}

/** Picker rows in the ENGINE's order (the order the GUI pickers show), the current value preselected. */
export function pickerItems(kind: "model" | "mode", config: unknown, modes: unknown): { items: ModelOption[]; current: string; configId: string } {
  if (kind === "mode") {
    const m = rec(modes);
    const items = arr(m.available).map(rec).map((o) => ({ value: str(o.id), name: str(o.name) || str(o.id) })).filter((o) => o.value !== "");
    return { items, current: str(m.current), configId: "" };
  }
  for (const raw of arr(config).map(rec)) {
    if (!/model/i.test(str(raw.id))) continue;
    const items = arr(raw.options).map(rec).map((o) => ({ value: str(o.value), name: str(o.name) || str(o.value) })).filter((o) => o.value !== "");
    if (items.length) return { items, current: str(raw.value ?? raw.currentValue), configId: str(raw.id) };
  }
  return { items: [], current: "", configId: "" };
}

// ---- the pane -------------------------------------------------------------------------------------

export interface MainEngine { base: string; token: string }
export interface MainPaneDeps {
  /** Something on screen changed: redraw. */
  changed(): void;
  fetchImpl?: typeof fetch;
  /** Run `fn` after `ms`; returns a cancel. Default setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

type Picker = { kind: "model" | "mode"; models: ModelOption[]; current: string; configId: string; sel: number; filter: string; busy: boolean };

const HELP: readonly [string, string][] = [
  ["Main (Herd)", ""],
  ["  :pane rebind main", "put Main in the focused pane"],
  ["  ⏎ on Main", "type to Main · ⏎ sends · esc cancels"],
  ["  y / s / d", "answer Main's parked ask (keys only, never scripts)"],
  ["  c", "cancel Main's running turn"],
  ["  m / M", "switch Main's model / mode (picker)"],
  ["  ⏎ on Sessions", "l resume as a lane · m open as Main"],
];

export class MainPane implements HubHostDeck {
  readonly help = HELP;
  readonly #engine: MainEngine;
  readonly #changed: () => void;
  readonly #fetch: typeof fetch;
  readonly #schedule: (fn: () => void, ms: number) => () => void;
  #cancelTimer: (() => void) | null = null;
  #running = false;

  #sessionId: string | null = null;
  #title = "";
  #busy: string | null = null;
  #model = "";
  #history: { role: string; text: string }[] = [];
  #historyStale = true;
  #turn: MainTurn = idleTurn();
  #spokes = 0;
  /** The turn this pane observes through /api/chat/attach (null = none). */
  #observing: string | null = null;
  #observer: AbortController | null = null;
  /** True while this pane's own /api/chat stream is the turn's observer (no second attach). */
  #sending = false;
  #notice = "";
  #composer: string | null = null;
  #picker: Picker | null = null;
  #choice: { id: string; title: string; asLane: () => void } | null = null;
  #scroll = 0;

  constructor(engine: MainEngine, deps: MainPaneDeps) {
    this.#engine = engine;
    this.#changed = deps.changed;
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#schedule = deps.schedule ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  }

  start(): void {
    this.#running = true;
    void this.#tick();
  }

  stop(): void {
    this.#running = false;
    this.#cancelTimer?.();
    this.#observer?.abort();
  }

  async #tick(): Promise<void> {
    await this.refresh();
    if (this.#running) this.#cancelTimer = this.#schedule(() => void this.#tick(), MAIN_POLL_MS);
  }

  /** The hub's lane snapshot: Main's spokes, counted the way the GUI sidebar counts them. */
  setLanes(lanes: readonly unknown[]): void {
    if (lanes.length !== this.#spokes) { this.#spokes = lanes.length; this.#changed(); }
  }

  /** Main's parked ask, for prefix+a (ADR-0494) and the `agent_blocked` refusal: metadata only. */
  ask(): { kind: string; summary: string } | null {
    const a = this.#turn.asks[0];
    return a ? { kind: a.tool, summary: a.detail } : null;
  }

  /** The turn as observed (tests and the server's status read it). */
  get turn(): MainTurn { return this.#turn; }
  get sessionId(): string | null { return this.#sessionId; }

  // -- engine calls --

  async #get(path: string): Promise<unknown> {
    const res = await this.#fetch(`${this.#engine.base}${path}`, { headers: { "x-lucid-token": this.#engine.token }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    const body = rec(await res.json());
    return "data" in body ? body.data : body;
  }

  async #post(path: string, payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.#fetch(`${this.#engine.base}${path}`, {
      method: "POST",
      headers: { "x-lucid-token": this.#engine.token, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, body: rec(await res.json().catch(() => null)) };
  }

  /** Open an NDJSON stream; each event is handed to `on`, which returns true to stop reading.
   *  `chunk` runs after every network chunk's events are handled. */
  async #stream(path: string, payload: Record<string, unknown>, signal: AbortSignal, on: (e: Record<string, unknown>) => boolean, chunk?: () => void): Promise<void> {
    const res = await this.#fetch(`${this.#engine.base}${path}`, {
      method: "POST",
      headers: { "x-lucid-token": this.#engine.token, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok || !res.body) {
      const body = rec(await res.json().catch(() => null));
      throw new HubOpError(res.status === 409 ? "busy" : "engine", `${path} -> ${res.status}${typeof body.error === "string" ? `: ${body.error}` : ""}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let e: unknown;
          try { e = JSON.parse(line); } catch { continue; }
          if (on(rec(e))) return;
        }
        chunk?.();
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
  }

  /** One poll: Main's session (and its history when it changed or a turn settled), the model, and the
   *  running turn, observed through /api/chat/attach when nothing here observes it yet. */
  async refresh(): Promise<void> {
    try {
      const busy = rec(await this.#get("/api/session/busy"));
      const sid = str(busy.sessionId) || null;
      this.#busy = typeof busy.busy === "string" ? busy.busy : null;
      if (sid !== this.#sessionId) {
        this.#sessionId = sid;
        this.#history = [];
        this.#historyStale = true;
        this.#title = "";
        this.#scroll = 0;
      }
      if (sid && this.#historyStale) {
        const [page, list, config] = await Promise.all([
          this.#get(`/api/session?id=${encodeURIComponent(sid)}&limit=${HISTORY_MESSAGES}`),
          this.#get("/api/sessions"),
          this.#get("/api/config"),
        ]);
        this.#history = arr(rec(page).messages).map(rec).map((m) => ({ role: str(m.role), text: str(m.text) }));
        const row = arr(rec(list).sessions).map(rec).find((s) => str(s.id) === sid);
        this.#title = row ? str(row.title) : "";
        this.#model = pickerItems("model", config, null).current;
        this.#historyStale = false;
      }
      const status = rec(await this.#get("/api/chat/status"));
      const turnId = str(status.turnId);
      if (status.running === true && turnId && turnId !== this.#observing && !this.#sending) void this.#observe(turnId);
      else if (status.running !== true && this.#turn.working && !this.#sending) {
        // The settle was missed (a dropped stream): the turn is over, its reply is in the history.
        this.#turn = foldMainEvent(this.#turn, { type: "done" });
        this.#historyStale = true;
      }
      if (this.#notice.startsWith("engine unreachable")) this.#notice = "";
    } catch (e) {
      this.#notice = `engine unreachable: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.#changed();
  }

  #event(e: Record<string, unknown>): void {
    this.#turn = foldMainEvent(this.#turn, e);
    if (e.type === "done") { this.#historyStale = true; void this.refresh(); }
    this.#changed();
  }

  /** Observe a running turn. Resolves once the engine's opening burst (the snapshot and every ask
   *  still parked, which the engine writes together on attach) has been folded, or the stream ended. */
  #observe(turnId: string): Promise<void> {
    this.#observer?.abort();
    const ctl = new AbortController();
    this.#observer = ctl;
    this.#observing = turnId;
    const ready = Promise.withResolvers<void>();
    let snapshot = false;
    void this.#stream("/api/chat/attach", { turnId }, ctl.signal, (e) => {
      if (e.type === "turn-snapshot") snapshot = true;
      this.#event(e);
      return false;
    }, () => { if (snapshot) ready.resolve(); })
      .catch(() => { /* gone or aborted: the next poll observes again if the turn still runs */ })
      .finally(() => {
        ready.resolve();
        if (this.#observer === ctl) { this.#observer = null; this.#observing = null; }
      });
    return ready.promise;
  }

  /** A typed prompt from this pane's composer: this stream observes the turn from its first event. */
  async #sendFromComposer(text: string): Promise<void> {
    if (this.#turn.working) {
      // A running turn takes a typed prompt as an interjection (the engine's rule, P-INTERJECT.1);
      // the attach stream already shows that turn, so this one is not read past its first event.
      try { await this.#first(text); this.#notice = "sent to Main's running turn (delivered at its next step)"; }
      catch (e) { this.#notice = `prompt failed: ${e instanceof Error ? e.message : String(e)}`; }
      this.#changed();
      return;
    }
    this.#observer?.abort();
    this.#turn = { ...idleTurn(), prompt: text, working: true };
    this.#sending = true;
    this.#scroll = 0;
    this.#changed();
    const ctl = new AbortController();
    this.#observer = ctl;
    let asked = false;
    try {
      await this.#stream("/api/chat", { text }, ctl.signal, (e) => {
        this.#event(e);
        // The /api/chat stream does not name its turn; cancel needs the id, so ask once.
        if (!asked && e.type !== "error" && e.type !== "ping") { asked = true; void this.#learnTurnId(); }
        return false;
      });
    } catch (e) {
      this.#turn = { ...this.#turn, working: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.#sending = false;
      if (this.#observer === ctl) this.#observer = null;
      this.#changed();
    }
  }

  async #learnTurnId(): Promise<void> {
    try {
      const s = rec(await this.#get("/api/chat/status"));
      if (s.running === true && !this.#turn.turnId) { this.#turn = { ...this.#turn, turnId: str(s.turnId) }; this.#observing = str(s.turnId); }
    } catch { /* the next poll learns it */ }
  }

  /** POST /api/chat and return its first event, refused or accepted; the stream is then dropped (the
   *  engine's connection owns only its observer, never the turn). */
  async #first(text: string): Promise<Record<string, unknown>> {
    const got: { first?: Record<string, unknown> } = {};
    await this.#stream("/api/chat", { text }, AbortSignal.timeout(30_000), (e) => {
      if (!e.type || e.type === "ping") return false;
      got.first = e;
      return true;
    }).catch((e: unknown) => {
      if (e instanceof HubOpError) throw e;
      throw new HubOpError("engine", `/api/chat: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (!got.first) throw new HubOpError("engine", "the engine closed the prompt stream without an answer");
    return got.first;
  }

  // -- the control plane: `main prompt`, `session list|open` --------------------------------------

  /** `main prompt <text> [--wait]`. Refused `agent_blocked` while Main waits on the human; a refused
   *  prompt is `refused` with the engine's own text. --wait returns Main's reply once the turn settles. */
  async mainCommand(argv: readonly string[]): Promise<unknown> {
    const [, sub, ...rest] = argv;
    const wait = rest.includes("--wait");
    const text = rest.filter((a) => a !== "--wait").join(" ").trim();
    if (sub !== "prompt" || !text) throw new HubOpError("usage", "main prompt <text> [--wait]");
    // Not yet observing a running turn (it began since the last poll): observe it now, so an ask it
    // has parked is known before the prompt goes anywhere.
    if (this.#observing === null && !this.#sending) {
      const s = rec(await this.#get("/api/chat/status"));
      if (s.running === true && str(s.turnId)) await this.#observe(str(s.turnId));
    }
    const ask = this.ask();
    if (ask) throw new HubOpError("agent_blocked", `Main is waiting on the human (${ask.kind}); a person answers it in a Herd pane`);
    if (!wait) {
      const first = await this.#first(text);
      if (first.type === "error") throw new HubOpError("refused", str(first.message) || "the engine refused the prompt");
      void this.refresh(); // the pane observes the turn from here
      return { main: true, accepted: true, event: str(first.type) };
    }
    const got: { reply: string; seen: boolean; error?: string; blocked?: string; done?: string } = { reply: "", seen: false };
    await this.#stream("/api/chat", { text }, AbortSignal.timeout(WAIT_MS), (e) => {
      if (e.type === "ping") return false;
      if (e.type === "error") { got.error = str(e.message) || "the engine refused the prompt"; return true; }
      if (!got.seen) { got.seen = true; void this.refresh(); } // the pane observes the turn from here
      if (e.type === "permission") { got.blocked = str(e.tool) || "tool"; return true; }
      if (e.type === "token") got.reply += str(e.text);
      if (e.type === "done") { got.done = str(e.text) || got.reply; return true; }
      return false;
    }).catch((e: unknown) => {
      // Past the window the turn runs on and the pane keeps showing it; anything else is a failure.
      if (e instanceof DOMException && e.name === "TimeoutError") return;
      if (e instanceof HubOpError) throw e;
      throw new HubOpError("engine", `/api/chat: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (got.error !== undefined) throw new HubOpError("refused", got.error);
    if (got.blocked !== undefined) throw new HubOpError("agent_blocked", `Main's turn is waiting on the human (${got.blocked}); a person answers it in a Herd pane`);
    if (got.done === undefined) return { main: true, accepted: true, done: false, note: "still running; the Main pane shows it" };
    return { main: true, accepted: true, done: true, text: got.done };
  }

  /** `session list | session open <id> [--as main|lane]`. As a lane is the classic resume (`local`
   *  runs `agent spawn --session`); as Main is /api/session/load, refused `busy` while Main works. */
  async sessionCommand(argv: readonly string[], local: (op: HubOp) => Promise<unknown>): Promise<unknown> {
    const [, sub, ...rest] = argv;
    if (sub === "list" && rest.length === 0) {
      const list = rec(await this.#get("/api/sessions"));
      return arr(list.sessions).map(rec).map((s) => ({ id: str(s.id), title: str(s.title), updatedAt: s.updatedAt, turns: s.turns, ...(s.live ? { live: s.live } : {}) }));
    }
    if (sub === "open") {
      const [id, flag, as, ...extra] = rest;
      if (!id || extra.length || (flag !== undefined && (flag !== "--as" || (as !== "main" && as !== "lane")))) throw new HubOpError("usage", "session open <id> [--as main|lane]");
      if (as === "main") return this.openAsMain(id);
      return local({ op: "agent.spawn", session: id });
    }
    throw new HubOpError("usage", "session list | session open <id> [--as main|lane]");
  }

  /** Load session `id` into Main: never stops the running work (P-SWITCH.1). The GUI's refusals
   *  surface with their codes: `busy` (Main works) and `held` (a spoke runs that session). */
  async openAsMain(id: string): Promise<unknown> {
    const { status, body } = await this.#post("/api/session/load", { id });
    if (status === 409 && typeof body.busy === "string") throw new HubOpError("busy", `Main is busy (${body.busy}); opening a session here never stops it`);
    if (status === 409 && body.heldBy) throw new HubOpError("held", str(body.error) || "a spoke runs that session");
    if (status >= 400 || body.ok === false) throw new HubOpError("engine", `/api/session/load -> ${status}${typeof body.error === "string" ? `: ${body.error}` : ""}`);
    await this.refresh();
    return { main: true, session: this.#sessionId };
  }

  // -- human-only actions (keystrokes from an attached client) ------------------------------------

  async #answer(key: AnswerKey): Promise<void> {
    const ask = this.#turn.asks[0];
    if (!ask) return;
    const pick = answerOption(ask, key);
    if (!pick) { this.#notice = `this ask has no "${key}" choice: ${askKeys(ask)}`; this.#changed(); return; }
    try {
      const { body } = await this.#post("/api/chat/permission", { id: ask.id, ...(pick.optionId ? { optionId: pick.optionId } : {}) });
      const resolved = rec(body.data).resolved === true;
      this.#turn = { ...this.#turn, asks: this.#turn.asks.filter((a) => a.id !== ask.id) };
      this.#notice = resolved ? `${pick.name}: ${ask.tool}` : "that ask was already settled";
    } catch (e) {
      this.#notice = `answer failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.#changed();
  }

  async #cancel(): Promise<void> {
    if (!this.#turn.working) { this.#notice = "Main has no running turn"; this.#changed(); return; }
    try {
      const { status, body } = await this.#post("/api/chat/cancel", this.#turn.turnId ? { turnId: this.#turn.turnId } : {});
      this.#notice = status >= 400 ? `cancel refused: ${str(body.error) || status}` : "canceled Main's turn";
    } catch (e) {
      this.#notice = `cancel failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.#changed();
  }

  async #openPicker(kind: "model" | "mode"): Promise<void> {
    try {
      const raw = await this.#get(kind === "model" ? "/api/config" : "/api/modes");
      const { items, current, configId } = pickerItems(kind, kind === "model" ? raw : null, kind === "mode" ? raw : null);
      if (items.length === 0) { this.#notice = `the engine reports no ${kind}s yet`; this.#changed(); return; }
      const sel = Math.max(0, items.findIndex((m) => m.value === current || m.name === current));
      this.#picker = { kind, models: items, current, configId, sel, filter: "", busy: false };
    } catch (e) {
      this.#notice = `${kind} list failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.#changed();
  }

  async #applyPicker(): Promise<void> {
    const pk = this.#picker;
    if (!pk || pk.busy) return;
    const pick = pickerMatches(pk)[pk.sel];
    if (!pick) { this.#notice = "nothing matches that filter"; this.#changed(); return; }
    pk.busy = true;
    this.#changed();
    try {
      const { status, body } = pk.kind === "model"
        ? await this.#post("/api/setConfig", { configId: pk.configId, value: pick.value })
        : await this.#post("/api/modes", { modeId: pick.value });
      this.#notice = status >= 400 || body.ok === false ? `${pk.kind} switch refused: ${str(body.error) || status}` : `Main's ${pk.kind} → ${pick.name}`;
      if (pk.kind === "model" && status < 400) this.#model = pick.value;
    } catch (e) {
      this.#notice = `${pk.kind} switch failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.#picker = null;
    this.#changed();
  }

  // -- HubHostDeck --------------------------------------------------------------------------------

  modal(): boolean {
    return this.#composer !== null || this.#picker !== null || this.#choice !== null;
  }

  sessionEnter(id: string, title: string, asLane: () => void): void {
    this.#choice = { id, title, asLane };
    this.#changed();
  }

  hint(): string {
    if (this.#choice) return `open "${truncateToWidth(this.#choice.title || this.#choice.id, 40)}": l resume as a lane · m open as Main · esc cancels`;
    if (this.#picker) return `Main's ${this.#picker.kind}: type to filter · ⇅ move · ⏎ apply · esc`;
    if (this.#composer !== null) return "to Main: ⏎ sends · esc cancels";
    if (this.#notice) return this.#notice;
    if (this.#turn.asks.length) return `Main waits on you: ${askKeys(this.#turn.asks[0]!)}`;
    return "⏎ talk to Main · c cancel · m model · M mode · j/k scroll";
  }

  input(data: string, enter: boolean): boolean {
    if (this.#choice) {
      const c = this.#choice;
      if (matchesKey(data, "escape")) this.#choice = null;
      else if (data === "l") { this.#choice = null; c.asLane(); }
      else if (data === "m") {
        this.#choice = null;
        this.#notice = `opening "${c.title || c.id}" as Main…`;
        void this.openAsMain(c.id).then(
          () => { this.#notice = `Main → ${c.title || c.id}`; this.#changed(); },
          (e: unknown) => { this.#notice = e instanceof HubOpError ? `${e.code}: ${e.message}` : `open failed: ${e instanceof Error ? e.message : String(e)}`; this.#changed(); },
        );
      }
      return true;
    }
    if (this.#picker) {
      const pk = this.#picker;
      if (pk.busy) return true;
      if (matchesKey(data, "escape")) { if (pk.filter) { pk.filter = ""; pk.sel = 0; } else this.#picker = null; }
      else if (matchesKey(data, "backspace")) { pk.filter = pk.filter.slice(0, -1); pk.sel = 0; }
      else if (matchesKey(data, "down")) pk.sel = Math.min(Math.max(0, pickerMatches(pk).length - 1), pk.sel + 1);
      else if (matchesKey(data, "up")) pk.sel = Math.max(0, pk.sel - 1);
      else if (enter) void this.#applyPicker();
      else { for (const ch of data) if (ch >= " " && ch !== "\u007f") pk.filter += ch; pk.sel = 0; }
      return true;
    }
    if (this.#composer !== null) {
      if (matchesKey(data, "escape")) { this.#composer = null; return true; }
      if (matchesKey(data, "backspace")) { this.#composer = this.#composer.slice(0, -1); return true; }
      // A pasted chunk with a newline submits what came before it (terminal paste semantics); an empty
      // enter keeps the composer open so the next keys never fall onto the hub keymap.
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          const text = this.#composer.trim();
          if (!text) continue;
          this.#composer = null;
          void this.#sendFromComposer(text);
          return true;
        }
        if (ch >= " " && ch !== "\u007f") this.#composer += ch;
      }
      return true;
    }
    // The pane is focused and nothing is open: its own keys first, the rest go to the hub.
    this.#notice = "";
    if (enter) {
      // A parked ask owns the pane: answer it first (an Enter must never become a prompt named "y").
      if (this.#turn.asks.length) { this.#notice = `Main waits on the ask above - answer it: ${askKeys(this.#turn.asks[0]!)}`; return true; }
      this.#composer = "";
      this.#scroll = 0;
      return true;
    }
    if ((data === "y" || data === "s" || data === "d") && this.#turn.asks.length) { void this.#answer(data); return true; }
    if (data === "c") { void this.#cancel(); return true; }
    if (data === "m" || data === "M") { void this.#openPicker(data === "m" ? "model" : "mode"); return true; }
    if (data === "j" || matchesKey(data, "down")) { this.#scroll = Math.max(0, this.#scroll - 1); return true; }
    if (data === "k" || matchesKey(data, "up")) { this.#scroll++; return true; }
    if (matchesKey(data, "ctrl+u")) { this.#scroll += 10; return true; }
    if (matchesKey(data, "ctrl+d")) { this.#scroll = Math.max(0, this.#scroll - 10); return true; }
    if (data === "G") { this.#scroll = 0; return true; }
    return false;
  }

  pane(w: number, h: number, focused: boolean): string[] {
    const innerW = Math.max(8, w - 4);
    const composing = this.#composer !== null;
    const bodyH = Math.max(0, h - 2 - (composing ? 1 : 0));
    let body: string[];
    if (this.#picker) body = fitBlock(this.#pickerRows(innerW, bodyH), innerW, bodyH);
    else {
      const lines = mainRows({ history: this.#history, turn: this.#turn }, innerW);
      const maxScroll = Math.max(0, lines.length - bodyH);
      const scroll = Math.min(this.#scroll, maxScroll);
      this.#scroll = scroll; // keep the clamp, or k past the top banks phantom offset
      const end = lines.length - scroll;
      const tail = lines.slice(Math.max(0, end - bodyH), end);
      if (scroll > 0 && tail.length > 0) tail[tail.length - 1] = `\u0001── ${scroll} line${scroll === 1 ? "" : "s"} below · j follows down · G jumps to live ──`;
      body = fitBlock(tail, innerW, bodyH);
    }
    const paint = focused ? CYAN : LINE;
    const working = this.#turn.working || this.#busy !== null;
    const spin = working ? ` ${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(Date.now() / 200) % 10]}` : "";
    const name = this.#title || (this.#sessionId ? this.#sessionId.slice(0, 8) : "no session");
    const title = ` ◆ Main · ${name} · ${this.#spokes} spoke${this.#spokes === 1 ? "" : "s"}${this.#model ? ` · ${this.#model}` : ""} · ${working ? "working" : "idle"}${spin}${this.#turn.asks.length ? " · WAITING" : ""} `;
    const cut = truncateToWidth(title, Math.max(1, w - 4));
    const top = paint("╭─") + (focused ? ACCENT_2.bold(cut) : TXT_3(cut)) + paint("─".repeat(Math.max(0, w - 3 - Bun.stringWidth(cut))) + "╮");
    const bottom = paint("╰" + "─".repeat(Math.max(0, w - 2)) + "╯");
    const rows = body.map((line) => {
      const painted = line.startsWith("\u0003") ? chalk.inverse(TXT(line.slice(1))) : line.startsWith("\u0002") ? AMBER(line.slice(1)) : line.startsWith("\u0001") ? TXT_3(line.slice(1)) : line.startsWith("›") ? ACCENT_2(line) : TXT(line);
      return paint("│") + " " + painted + " " + paint("│");
    });
    if (composing) {
      const p = truncateToWidth(this.#composer ?? "", Math.max(1, innerW - 4));
      rows.push(paint("│") + " " + ACCENT.bold("› ") + TXT(p) + ACCENT("▌") + " ".repeat(Math.max(0, innerW - 3 - Bun.stringWidth(p))) + " " + paint("│"));
    }
    return [top, ...rows, bottom];
  }

  /** The picker inside the pane: the filter row, then the engine's options, current marked, the
   *  selection inverted (\u0003). */
  #pickerRows(innerW: number, h: number): string[] {
    const pk = this.#picker!;
    const matches = pickerMatches(pk);
    pk.sel = Math.min(pk.sel, Math.max(0, matches.length - 1));
    const room = Math.max(1, h - 2);
    const from = Math.max(0, Math.min(pk.sel - Math.floor(room / 2), matches.length - room));
    const rows = matches.slice(from, from + room).map((m, i) => {
      const line = truncateToWidth(` ${m.name}${m.value === pk.current || m.name === pk.current ? " ●" : ""}`, innerW);
      return from + i === pk.sel ? `\u0003${line}${" ".repeat(Math.max(0, innerW - Bun.stringWidth(line)))}` : line;
    });
    return [`\u0001${pk.busy ? `switching ${pk.kind}…` : `${pk.kind}: ${pk.filter}▌`}`, "", ...(rows.length ? rows : ["\u0001  nothing matches - backspace edits, esc clears"])];
  }
}
