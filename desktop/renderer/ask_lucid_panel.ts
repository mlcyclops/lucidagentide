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
import { createDock, type DockHandle } from "./dock.ts";
import { mountMiniMascot, type MiniMascotHandle, type MiniState } from "./mascot_mini.ts";

export interface AskTurnView { role: "user" | "lucid"; text: string }
/** The engine's answer (desktop/ask_lucid_service.ts AskReply). */
export interface AskReplyView {
  ok: boolean;
  reply?: string;
  error?: string;
  model?: string;
  seen: { lanes: number; tasks: number; hits: number };
  withheld: string[];
  /** P-ASKLUCID.2 (ADR-0582): what Lucid proposes. Each becomes a card; none runs without Confirm. */
  actions?: AskAction[];
  actionsDropped?: number;
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
  const saw = `Saw ${plural(r.seen.lanes, "lane", "lanes")}, ${plural(r.seen.tasks, "orbit task", "orbit tasks")} and ${plural(r.seen.hits, "knowledge page", "knowledge pages")}.`;
  const names: Record<string, string> = { fleet: "the fleet lanes", orbit: "the Fleet Orbit", knowledge: "the knowledge graph", history: "the earlier turns" };
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
  return state === "working" ? "Reading the fleet, the orbit and the knowledge graph" : state === "error" ? "Something went wrong" : state === "done" ? "Answered" : "A side conversation. He can see your fleet.";
}

export interface AskLucidDeps {
  /** Ask the engine. Null means the request itself failed. */
  ask(text: string, history: AskTurnView[]): Promise<AskReplyView | null>;
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
    el("div", "al-welcome-d", "A side conversation that does not interrupt your session. Lucid can see every fleet lane, the Fleet Orbit goal and its tasks, and the knowledge graph. He answers questions. He does not change anything."),
  );
  const sugs = el("div", "al-sugs");
  for (const s of ASK_SUGGESTIONS) {
    const b = el("button", "al-sug", s);
    b.type = "button";
    b.title = s;
    b.addEventListener("click", () => send(s));
    sugs.appendChild(b);
  }
  welcome.appendChild(sugs);
  log.appendChild(welcome);

  const form = el("form", "al-form");
  const input = el("textarea", "al-input");
  input.rows = 1;
  input.placeholder = "Ask Lucid anything";
  input.setAttribute("aria-label", "Ask Lucid");
  const sendBtn = el("button", "al-send", "Ask");
  sendBtn.type = "submit";
  form.append(input, sendBtn);
  panel.append(log, form);

  const pillIn = el("span", "al-pill-in", "Ask Lucid");

  const dock = createDock({
    label: "Ask Lucid",
    storageKey: ASK_DOCK_KEY,
    topBar: deps.topBar,
    zoomOf: deps.zoomOf,
    headerStart: head,
    body: panel,
    pillContent: pillIn,
    onShow: () => { mini ??= mountMiniMascot(miniHost, { size: "sm" }); mini.setActive(true); setTimeout(() => input.focus(), 60); },
    onHide: () => mini?.setActive(false),
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

  function send(raw: string): void {
    const text = raw.trim();
    if (!text || busy) return;
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
    void deps.ask(text, history).catch(() => null).then((r) => {
      busy = false;
      sendBtn.disabled = false;
      if (r?.ok && r.reply) {
        turns.push({ role: "lucid", text: r.reply });
        addLucid(r.reply, seenLine(r));
        for (const a of r.actions ?? []) addAction(a);
        const dropped = droppedLine(r.actionsDropped ?? 0);
        if (dropped) log.appendChild(el("div", "al-meta", dropped));
        setState("done");
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
    say(markdown) { dock.open(); addLucid(markdown); },
    dock,
  };
}
