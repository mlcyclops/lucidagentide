// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/ask_lucid_panel.ts - P-ASKLUCID.1 (ADR-0581): the Ask Lucid fly-out.
//
// A side conversation with Lucid in a dock window (dock.ts): right, bottom or floating, minimized to a pill.
// Mini Lucid sits in the header and shows what is happening: seated and breathing when idle, typing while a
// question is out, a short victory when the answer lands, a blink on an error. The panel is built once and
// lives in <body>, so nothing the app re-renders can remove it.
//
// The panel only talks. It posts the question and the recent turns to the engine (bridge.askLucid) and shows
// the reply. Lucid's reply is rendered through the same safe markdown renderer as the chat; the user's own
// text and every label go in through textContent.
//
// Everything outside the DOM is injected, and the small pure helpers are exported for tests.

import { ASK_KIND_LABEL, ASK_RISK_LABEL, actionDetails, type AskAction } from "../ask_lucid_actions.ts"; // P-ASKLUCID.2 (ADR-0582): pure, no imports
import { BRIEF_QUESTION } from "../ask_lucid_briefing.ts"; // P-ASKLUCID.4 (ADR-0585): pure, no imports
import { createDock, type DockHandle } from "./dock.ts";
import { followMode, followupRecs, noteMiss, noteOwnQuestion, noteUsed, parseMemory, rank, REC_LIMITS, REC_MEMORY_KEY, type Follow, type Rec, type RecMemory, type RecSignals } from "./lucid_recs.ts"; // P-ASKLUCID.5 (ADR-0586)
import { mountMiniMascot, type MiniMascotHandle, type MiniState } from "./mascot_mini.ts";

export interface AskTurnView { role: "user" | "lucid"; text: string }
/** The engine's answer (desktop/ask_lucid_service.ts AskReply). */
export interface AskReplyView {
  ok: boolean;
  reply?: string;
  error?: string;
  model?: string;
  /** `screen` counts the surfaces of the screen Lucid was shown (P-ASKLUCID.3, ADR-0584). */
  seen: { lanes: number; tasks: number; hits: number; screen?: number; activity?: number; sessions?: number };
  withheld: string[];
  /** P-ASKLUCID.2 (ADR-0582): what Lucid proposes. Each becomes a card; none runs without Confirm. */
  actions?: AskAction[];
  actionsDropped?: number;
  /** P-ASKLUCID.5 (ADR-0586): questions Lucid thinks come next. Shown as chips. */
  followups?: string[];
}

/** What happened when the user confirmed an action. `message` is shown on the card. */
export interface AskActionResult { ok: boolean; message: string }

/** PURE: the note shown when some of what Lucid proposed was not turned into a card. */
export function droppedLine(n: number): string {
  return n > 0 ? `${n === 1 ? "One proposed action was" : `${n} proposed actions were`} not shown: ${n === 1 ? "it was" : "they were"} not valid, named something Lucid was not shown, or did not pass the security scan.` : "";
}

export const ASK_DOCK_KEY = "lucid.asklucid.dock.v1";
/** How many earlier turns go back with a question (the engine bounds it again). */
export const ASK_HISTORY_TURNS = 12;

export const ASK_SUGGESTIONS: readonly string[] = [
  "What are my fleet lanes doing right now?",
  "Is anything waiting on me?",
  "Where does the Fleet Orbit goal stand?",
  "What does the knowledge graph say about this project?",
];

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** PURE: one line under a reply saying what Lucid was shown, and what was kept from him. */
export function seenLine(r: Pick<AskReplyView, "seen" | "withheld" | "model">): string {
  const screen = (r.seen.screen ?? 0) > 0 ? `your screen (${plural(r.seen.screen ?? 0, "surface", "surfaces")}), ` : "";
  // P-ASKLUCID.4 (ADR-0585): lane conversations and sessions are named only when some were shown.
  const talk = (r.seen.activity ?? 0) > 0 ? ` (${plural(r.seen.activity ?? 0, "conversation", "conversations")} read)` : "";
  const sessions = (r.seen.sessions ?? 0) > 0 ? `${plural(r.seen.sessions ?? 0, "session", "sessions")}, ` : "";
  const saw = `Saw ${screen}${plural(r.seen.lanes, "lane", "lanes")}${talk}, ${sessions}${plural(r.seen.tasks, "orbit task", "orbit tasks")} and ${plural(r.seen.hits, "knowledge page", "knowledge pages")}.`;
  const names: Record<string, string> = { screen: "your screen", activity: "the lane conversations", sessions: "the sessions", fleet: "the fleet lanes", orbit: "the Fleet Orbit", knowledge: "the knowledge graph", history: "the earlier turns" };
  const kept = r.withheld.map((w) => names[w] ?? w);
  const held = kept.length ? ` Withheld by the security scan: ${kept.join(", ")}.` : "";
  return `${saw}${held}${r.model ? ` Answered by ${r.model}.` : ""}`;
}

/** PURE: the turns to send back with the next question: the most recent ones, oldest first. */
export function historyToSend(turns: readonly AskTurnView[], max: number = ASK_HISTORY_TURNS): AskTurnView[] {
  return turns.slice(-max).map((t) => ({ role: t.role, text: t.text }));
}

/** PURE: the header's status line for each state. */
export function stateLine(state: MiniState): string {
  return state === "working" ? "Reading your screen, the fleet and the knowledge graph" : state === "error" ? "Something went wrong" : state === "done" ? "Answered" : "A side conversation. He can see your screen and your fleet.";
}

/** What goes to the engine with a question besides its text and the earlier turns. */
export interface AskExtrasView { screen?: unknown; /** P-ASKLUCID.4: Brief me was pressed. */ brief?: boolean }

export interface AskLucidDeps {
  /** Ask the engine. Null means the request itself failed. */
  ask(text: string, history: AskTurnView[], extras: AskExtrasView): Promise<AskReplyView | null>;
  /** P-ASKLUCID.5 (ADR-0586): what is going on right now, for the suggestions. Absent = the fixed questions. */
  recSignals?(): Promise<RecSignals | null>;
  /** Where the suggestion memory lives (weights, misses). Null = this window only. */
  recStore?: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  /** The surfaces the user was recently on, kept by the app while Lucid follows the screen closely. */
  recTrail?(): readonly string[];
  /** Suggestions to fall back on when the contextual ones run dry (P-ASKLUCID.6: features not yet used). */
  recFallback?(): readonly Rec[];
  /** Told whenever the follow mode changes, so the app can start or stop watching which surface is open. */
  onFollow?(mode: Follow): void;
  /** P-ASKLUCID.3 (ADR-0584): read what is on the screen right now. Absent or failing = Lucid is not shown it. */
  screen?(): Promise<unknown>;
  /** The chat's safe markdown renderer. */
  markdown(text: string): string;
  /** Optional: syntax highlight and copy buttons on code blocks, as the chat does. */
  enhance?(el: HTMLElement): void;
  /** Selector of the app's title bar, so a right dock sits under it. */
  topBar?: string;
  /** Selector of the zoomed app root (see DockOptions.zoomOf). */
  zoomOf?: string;
  /** P-ASKLUCID.2 (ADR-0582): carry out one action the user just confirmed. Absent = cards are not offered. */
  runAction?(action: AskAction): Promise<AskActionResult>;
}

export interface AskLucidHandle {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Put text in the composer without sending it, and focus it. */
  prefill(text: string): void;
  /** Ask a question as if the user typed it. */
  ask(text: string): void;
  /** P-ASKLUCID.4 (ADR-0585): ask for a briefing across the screen, the fleet, the orbit and the sessions. */
  brief(): void;
  /** Add a message from Lucid that did not come from the model (a suggestion, a what's-new note). */
  say(markdown: string): void;
  dock: DockHandle;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createAskLucid(deps: AskLucidDeps): AskLucidHandle {
  const turns: AskTurnView[] = [];
  let busy = false;

  // Header: mini Lucid, the title and one status line.
  const head = el("div", "al-head");
  const miniHost = el("span", "");
  const headText = el("div", "al-head-text");
  const title = el("span", "al-title", "Ask Lucid");
  const stateEl = el("span", "al-state", stateLine("idle"));
  headText.append(title, stateEl);
  head.append(miniHost, headText);
  let mini: MiniMascotHandle | null = null;

  // Body: the log and the composer.
  const panel = el("div", "al-panel");
  const log = el("div", "al-log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  const welcome = el("div", "al-welcome");
  welcome.append(
    el("div", "al-welcome-h", "Ask Lucid"),
    el("div", "al-welcome-d", "A side conversation that does not interrupt your session. Lucid can see what is on your screen, every fleet lane and what it last did, your recent sessions, the Fleet Orbit and the knowledge graph. He can propose things, and nothing changes until you confirm it."),
  );
  const sugs = el("div", "al-sugs");
  const fillWelcome = (recs: readonly Rec[]): void => {
    sugs.replaceChildren();
    const add = (label: string, run: () => void): void => {
      const b = el("button", "al-sug", label);
      b.type = "button";
      b.title = label;
      b.addEventListener("click", run);
      sugs.appendChild(b);
    };
    // What is going on first, then the fixed questions to fill the grid.
    for (const r of recs.slice(0, REC_LIMITS.welcome)) add(r.question.length <= 90 ? r.question : r.label, () => useRec(r));
    for (const s of ASK_SUGGESTIONS) { if (sugs.children.length < REC_LIMITS.welcome) add(s, () => send(s)); }
  };
  fillWelcome([]);
  welcome.appendChild(sugs);
  log.appendChild(welcome);

  // P-ASKLUCID.4 (ADR-0585): one tap for a briefing. The row sits above the composer and is always there.
  const quick = el("div", "al-quick");
  const briefBtn = el("button", "al-chip al-chip-brief", "Brief me");
  briefBtn.type = "button";
  briefBtn.title = "What needs you, what is running, what finished, and what Lucid would do next";
  briefBtn.addEventListener("click", () => send(BRIEF_QUESTION, { brief: true }));
  quick.appendChild(briefBtn);

  // P-ASKLUCID.5 (ADR-0586): suggestions seeded from what is going on. `shown` is the set on screen;
  // `engaged` turns true when the user uses one or asks anything, and a set that was looked at and left
  // untouched counts as a miss when the panel hides.
  let memory: RecMemory = parseMemory(null);
  let shown: Rec[] = [];
  let engaged = false;
  let shownAt = 0;
  const MISS_AFTER_MS = 4000;
  const loadMemory = (): void => { try { memory = parseMemory(deps.recStore?.getItem(REC_MEMORY_KEY) ?? null); } catch { memory = parseMemory(null); } };
  const saveMemory = (next: RecMemory): void => {
    const before = followMode(memory);
    memory = next;
    try { deps.recStore?.setItem(REC_MEMORY_KEY, JSON.stringify(memory)); } catch { /* storage blocked: this window only */ }
    if (followMode(memory) !== before) deps.onFollow?.(followMode(memory));
  };
  const showRecs = (recs: readonly Rec[]): void => {
    shown = [...recs];
    engaged = false;
    shownAt = Date.now();
    for (const old of [...quick.querySelectorAll(".al-chip-rec, .al-chip-more")]) old.remove();
    for (const r of shown) {
      const b = el("button", `al-chip al-chip-rec al-rec-${r.kind}`, r.label);
      b.type = "button";
      b.title = r.question;
      b.addEventListener("click", () => useRec(r));
      quick.appendChild(b);
    }
    if (shown.length > 0) {
      const more = el("button", "al-chip al-chip-more", "Something else");
      more.type = "button";
      more.title = "None of these help. Lucid looks more closely at what is on your screen and tries again.";
      more.addEventListener("click", () => { saveMemory(noteMiss(memory, shown)); void refreshRecs(); });
      quick.appendChild(more);
    }
    fillWelcome(shown);
  };
  async function refreshRecs(): Promise<void> {
    if (!deps.recSignals) return;
    const sig = await deps.recSignals().catch(() => null);
    if (!sig) { showRecs([]); return; }
    showRecs(rank(sig, memory, { trail: deps.recTrail?.() ?? [], fallback: deps.recFallback?.() ?? [] }));
  }
  function useRec(r: Rec): void {
    if (busy) return;
    saveMemory(noteUsed(memory, r));
    send(r.question, {}, true);
  }
  /** A set that was on screen long enough to be read and was left untouched is a miss. */
  const settleShown = (): void => {
    if (shown.length > 0 && !engaged && Date.now() - shownAt >= MISS_AFTER_MS) saveMemory(noteMiss(memory, shown));
    engaged = true; // settled: the same set is never counted twice
  };

  const form = el("form", "al-form");
  const input = el("textarea", "al-input");
  input.rows = 1;
  input.placeholder = "Ask Lucid anything";
  input.setAttribute("aria-label", "Ask Lucid");
  const sendBtn = el("button", "al-send", "Ask");
  sendBtn.type = "submit";
  form.append(input, sendBtn);
  panel.append(log, quick, form);

  const pillIn = el("span", "al-pill-in", "Ask Lucid");

  const dock = createDock({
    label: "Ask Lucid",
    storageKey: ASK_DOCK_KEY,
    topBar: deps.topBar,
    zoomOf: deps.zoomOf,
    headerStart: head,
    body: panel,
    pillContent: pillIn,
    onShow: () => { mini ??= mountMiniMascot(miniHost, { size: "sm" }); mini.setActive(true); setTimeout(() => input.focus(), 60); loadMemory(); deps.onFollow?.(followMode(memory)); void refreshRecs(); },
    onHide: () => { mini?.setActive(false); settleShown(); },
  });

  const setState = (s: MiniState): void => {
    mini?.setState(s);
    stateEl.textContent = stateLine(s);
    dock.pill.classList.toggle("working", s === "working");
    if (s === "done" || s === "error") setTimeout(() => { if (!busy) stateEl.textContent = stateLine("idle"); }, 1600);
  };

  const scrollDown = (): void => { log.scrollTop = log.scrollHeight; };

  const addUser = (text: string): void => {
    welcome.remove();
    log.appendChild(el("div", "al-msg al-user", text));
    scrollDown();
  };
  const addLucid = (markdown: string, meta?: string): void => {
    welcome.remove();
    const m = el("div", "al-msg al-lucid");
    m.innerHTML = deps.markdown(markdown); // the chat's own sanitizing renderer
    deps.enhance?.(m);
    log.appendChild(m);
    if (meta) log.appendChild(el("div", "al-meta", meta));
    scrollDown();
    if (!dock.isVisible()) dock.setUnread(true);
  };
  /** P-ASKLUCID.2 (ADR-0582): one proposed action as a card. Every string goes in through textContent. The
   *  detail rows are exactly what Confirm sends (actionDetails), so the user reads what will run. Confirm
   *  works once; Dismiss removes the card. */
  const addAction = (a: AskAction): void => {
    const run = deps.runAction;
    if (!run) return;
    const card = el("div", `al-act al-risk-${a.risk}`);
    const top = el("div", "al-act-top");
    top.append(el("span", "al-act-kind", ASK_KIND_LABEL[a.kind]), el("span", "al-act-risk", ASK_RISK_LABEL[a.risk]));
    card.append(top, el("div", "al-act-label", a.label));
    if (a.why) card.appendChild(el("div", "al-act-why", a.why));
    const dl = el("dl", "al-act-dl");
    for (const row of actionDetails(a)) dl.append(el("dt", "", row.label), el("dd", "", row.value));
    card.appendChild(dl);
    const btns = el("div", "al-act-btns");
    const confirm = el("button", "al-act-go", "Confirm");
    confirm.type = "button";
    const dismiss = el("button", "al-act-no", "Dismiss");
    dismiss.type = "button";
    btns.append(confirm, dismiss);
    const result = el("div", "al-act-result");
    result.hidden = true;
    card.append(btns, result);
    dismiss.addEventListener("click", () => card.remove());
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      dismiss.disabled = true;
      confirm.textContent = "Working";
      void run(a).catch((): AskActionResult => ({ ok: false, message: "It could not be done: the app did not answer." })).then((r) => {
        btns.remove();
        result.hidden = false;
        result.textContent = r.message;
        card.classList.add(r.ok ? "done" : "failed");
        scrollDown();
      });
    });
    log.appendChild(card);
    scrollDown();
  };
  const addError = (text: string): void => {
    welcome.remove();
    log.appendChild(el("div", "al-msg al-err", text));
    scrollDown();
  };

  function send(raw: string, more: AskExtrasView = {}, fromRec = false): void {
    const text = raw.trim();
    if (!text || busy) return;
    // A question the user wrote is not a miss: they knew what to ask.
    if (!fromRec) saveMemory(noteOwnQuestion(memory));
    engaged = true;
    dock.open();
    dock.setUnread(false);
    busy = true;
    sendBtn.disabled = true;
    input.value = "";
    autosize();
    addUser(text);
    setState("working");
    const history = historyToSend(turns);
    turns.push({ role: "user", text });
    // The screen is read at the moment of asking, so "this" means what the user sees now.
    const screen = deps.screen ? deps.screen().catch(() => null) : Promise.resolve(null);
    void screen.then((s) => deps.ask(text, history, { ...more, ...(s ? { screen: s } : {}) })).catch(() => null).then((r) => {
      busy = false;
      sendBtn.disabled = false;
      if (r?.ok && r.reply) {
        turns.push({ role: "lucid", text: r.reply });
        addLucid(r.reply, seenLine(r));
        for (const a of r.actions ?? []) addAction(a);
        const dropped = droppedLine(r.actionsDropped ?? 0);
        if (dropped) log.appendChild(el("div", "al-meta", dropped));
        setState("done");
        // What comes next: the follow-ups Lucid gave, else a fresh reading of what is going on.
        if (r.followups?.length) showRecs(followupRecs(r.followups)); else void refreshRecs();
      } else {
        turns.pop(); // a question that was never answered is not history
        addError(r?.error ?? "Lucid could not be reached. Check that the app is still running, then try again.");
        setState("error");
      }
    });
  }

  const autosize = (): void => {
    input.style.height = "auto";
    input.style.height = `${Math.min(160, Math.max(38, input.scrollHeight))}px`;
  };
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });

  return {
    open: () => { dock.open(); dock.setUnread(false); },
    close: () => dock.close(),
    toggle: () => { dock.toggle(); if (dock.isOpen()) dock.setUnread(false); },
    isOpen: () => dock.isOpen(),
    prefill(text) { dock.open(); input.value = text; autosize(); input.focus(); },
    ask: (text) => send(text),
    brief: () => send(BRIEF_QUESTION, { brief: true }),
    say(markdown) { dock.open(); addLucid(markdown); },
    dock,
  };
}
