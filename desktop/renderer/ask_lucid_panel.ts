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
import { shotSkipLine, type ShotSkip } from "../ask_lucid_shot.ts"; // P-ASKLUCID.7 (ADR-0588): pure, no imports
import { BRIEF_QUESTION } from "../ask_lucid_briefing.ts"; // P-ASKLUCID.4 (ADR-0585): pure, no imports
import { createDock, type DockHandle } from "./dock.ts";
import { copyToClipboard } from "./ctxmenu.ts"; // P-ASKLUCID.8: the answer's Copy button
import { acceptAttachment, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type Attachment } from "./composer_attachments.ts"; // P-ASKLUCID.8: the composer's image chips
import { followMode, followupRecs, noteMiss, noteOwnQuestion, noteUsed, parseMemory, rank, REC_LIMITS, REC_MEMORY_KEY, type Follow, type Rec, type RecMemory, type RecSignals } from "./lucid_recs.ts"; // P-ASKLUCID.5 (ADR-0586)
import { mountMiniMascot, type MiniMascotHandle, type MiniState } from "./mascot_mini.ts";
import { bindFileDrop, clipboardFiles, createAttachTray, folderDropNote, isAttachShortcut, mountPlusMenu, pickFiles, plusButtonTip, plusMenuItems, sentFilesEl, syncPlusButton, type AttachBridge, type AttachTray } from "./attach_ui.ts"; // P-ATTACH.1 (ADR-0598)
import type { StagedAttachment } from "../attach_kinds.ts";
import { imageCardState, pathBreakParts, readSavedImageModel, saveImageModel, type ImageCardState, type ImageModelOptionView, type ImageModelsView } from "./ask_image_card.ts"; // P-ASKLUCID.9 (ADR-0600)
import { tipValue } from "./tip_text.ts"; // P-TIP.1 (ADR-0599): new controls use data-tip

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
  /** P-ASKLUCID.7 (ADR-0588): "sent" when a picture of the screen went with the question, else why not. */
  picture?: string;
  /** P-ASKLUCID.8: what happened to the images the user attached. */
  attached?: "sent" | "model-refused";
}

/** PURE: the note under a reply when the model could not look at the user's images. */
export function attachedLine(a: AskReplyView["attached"]): string {
  return a === "model-refused" ? "This model cannot read images, so Lucid answered from your text alone. Pick a model that reads images to ask about a picture." : "";
}

/** P-ASKLUCID.9 (ADR-0600): an image Ask Lucid edited and saved under ~/.omp/ask-lucid/images. */
export interface EditedImageView { path: string; mimeType: string; model: string; provider: string }

/** What happened when the user confirmed an action. `message` is shown on the card; `image` (P-ASKLUCID.9) is
 *  the edited image an edit_image card made. */
export interface AskActionResult { ok: boolean; message: string; image?: EditedImageView }

/** P-ASKLUCID.9 (ADR-0600): what a confirmed card carries besides the action. `images` are the data URLs the user
 *  attached to the question the card answers (edit_image names one by position); `modelId` is the image model
 *  the card settled on. */
export interface AskActionContext { images?: readonly string[]; modelId?: string }

/** P-ASKLUCID.9: the app's side of the "Edit image" card. Absent = the card says the models cannot be checked. */
export interface AskImageEditDeps {
  /** GET /api/image/models. Null = no answer. */
  models(): Promise<ImageModelsView | null>;
  /** The remembered model choice (localStorage, see ask_image_card.ts). */
  store: Pick<Storage, "getItem" | "setItem"> | null;
  /** Settings, Providers card. */
  openProviders(): void;
  /** Show an edited image in the Preview's Ask Lucid tab. */
  open(path: string): void;
  /** Reveal it in the OS file manager. Absent = no button (a plain browser). */
  showInFolder?(path: string): Promise<boolean>;
}

/** PURE: the note shown when some of what Lucid proposed was not turned into a card. */
export function droppedLine(n: number): string {
  return n > 0 ? `${n === 1 ? "One proposed action was" : `${n} proposed actions were`} not shown: ${n === 1 ? "it was" : "they were"} not valid, named something Lucid was not shown, or did not pass the security scan.` : "";
}

export const ASK_DOCK_KEY = "lucid.asklucid.dock.v1";
/** How many earlier turns go back with a question (the engine bounds it again). */
export const ASK_HISTORY_TURNS = 12;

export const ASK_SUGGESTIONS: readonly string[] = [
  "What are my fleet agents doing right now?",
  "Is anything waiting on me?",
  "Where does the Fleet Orbit goal stand?",
  "What does the knowledge graph say about this project?",
];

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** PURE: one line under a reply saying what Lucid was shown, and what was kept from him. */
export function seenLine(r: Pick<AskReplyView, "seen" | "withheld" | "model" | "picture">): string {
  // P-ASKLUCID.7 (ADR-0588): "with a picture" only when one really went with the question.
  const pic = r.picture === "sent" ? ", with a picture" : "";
  const screen = (r.seen.screen ?? 0) > 0 ? `your screen (${plural(r.seen.screen ?? 0, "surface", "surfaces")}${pic}), ` : "";
  // P-ASKLUCID.4 (ADR-0585): lane conversations and sessions are named only when some were shown.
  const talk = (r.seen.activity ?? 0) > 0 ? ` (${plural(r.seen.activity ?? 0, "conversation", "conversations")} read)` : "";
  const sessions = (r.seen.sessions ?? 0) > 0 ? `${plural(r.seen.sessions ?? 0, "session", "sessions")}, ` : "";
  const saw = `Saw ${screen}${plural(r.seen.lanes, "agent", "agents")}${talk}, ${sessions}${plural(r.seen.tasks, "orbit task", "orbit tasks")} and ${plural(r.seen.hits, "knowledge page", "knowledge pages")}.`;
  const names: Record<string, string> = { screen: "your screen", activity: "the agent conversations", sessions: "the sessions", fleet: "the fleet agents", orbit: "the Fleet Orbit", knowledge: "the knowledge graph", history: "the earlier turns" };
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
export interface AskExtrasView {
  screen?: unknown;
  /** P-ASKLUCID.4: Brief me was pressed. */
  brief?: boolean;
  /** P-ASKLUCID.6 (ADR-0587): the current value of each setting Lucid may propose changing. */
  settings?: Record<string, string>;
  /** P-ASKLUCID.6: ids of the features this user has not used. */
  unusedFeatures?: string[];
  /** P-ASKLUCID.7 (ADR-0588): a picture of the screen, already scaled and painted over. */
  shot?: unknown;
  /** P-ASKLUCID.8: images the user pasted or dropped, as data URLs. */
  images?: string[];
  /** P-ATTACH.1 (ADR-0598): ids of staged (copied and scanned) files that go with the question. */
  attachments?: string[];
}

export interface AskLucidDeps {
  /** Ask the engine. Null means the request itself failed. */
  ask(text: string, history: AskTurnView[], extras: AskExtrasView): Promise<AskReplyView | null>;
  /** P-ASKLUCID.7 (ADR-0588): take a picture of the screen. Null = none (a plain browser, or turned off). */
  shot?(): Promise<unknown>;
  /** P-ASKLUCID.6 (ADR-0587): more to send with every question (current settings, unused features). */
  extras?(): Promise<AskExtrasView>;
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
  runAction?(action: AskAction, ctx?: AskActionContext): Promise<AskActionResult>;
  /** P-ASKLUCID.9 (ADR-0600): the image models, the Settings jump and where an edited image opens. */
  imageEdit?: AskImageEditDeps;
  /** P-ATTACH.1 (ADR-0598): stage files the user adds (copied, extracted and scanned by the engine). Absent =
   *  images only, as before. */
  attach?: AttachBridge;
  /** P-ATTACH.1: the "+" menu's Knowledge entry, anchored to the button. Absent = no Knowledge row. */
  openKnowledge?(anchor: HTMLElement): void;
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
    el("div", "al-welcome-d", "A side conversation that does not interrupt your session. Lucid can see what is on your screen, every fleet agent and what it last did, your recent sessions, the Fleet Orbit and the knowledge graph. He can propose things, and nothing changes until you confirm it."),
  );
  const sugs = el("div", "al-sugs");
  const fillWelcome = (recs: readonly Rec[]): void => {
    sugs.replaceChildren();
    const add = (label: string, run: () => void): void => {
      const b = el("button", "al-sug", label);
      b.type = "button";
      b.dataset.tip = tipValue(label); // P-TIP.1 (ADR-0599): premium tooltip, never a native title
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
  briefBtn.dataset.tip = "What needs you, what is running, what finished, and what Lucid would do next";
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
      b.dataset.tip = tipValue(r.question);
      b.addEventListener("click", () => useRec(r));
      quick.appendChild(b);
    }
    if (shown.length > 0) {
      const more = el("button", "al-chip al-chip-more", "Something else");
      more.type = "button";
      more.dataset.tip = "None of these help. Lucid looks more closely at what is on your screen and tries again.";
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

  // P-ASKLUCID.8: images pasted or dropped into the panel, shown as the composer's chips above the input and
  // sent with the next question only. Same checks and limits as the composer (composer_attachments.ts).
  let attached: Attachment[] = [];
  let attachSeq = 0;
  const thumbs = el("div", "al-thumbs");
  thumbs.hidden = true;
  // Built with the DOM (the composer's chip classes), so the panel's only innerHTML stays Lucid's sanitized reply.
  const renderThumbs = (): void => {
    thumbs.replaceChildren(...attached.map((a) => {
      const chip = el("div", "cx-thumb");
      chip.dataset.tip = tipValue(a.name || "pasted image");
      const img = el("img", "cx-thumb-img");
      img.alt = "attached image";
      img.src = a.dataUrl;
      const x = el("button", "cx-thumb-x", "×");
      x.type = "button";
      x.dataset.tip = "Remove image";
      x.setAttribute("aria-label", "Remove image");
      x.dataset.attRemove = a.id;
      chip.append(img, x);
      return chip;
    }));
    thumbs.hidden = attached.length === 0;
  };
  thumbs.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-att-remove]")?.dataset.attRemove;
    if (!id) return;
    attached = attached.filter((a) => a.id !== id);
    renderThumbs();
  });
  const attachNote = (text: string): void => { log.appendChild(el("div", "al-meta", text)); scrollDown(); };
  /** Stage image files as chips (same checks and limits as the composer). */
  const stageImages = (images: readonly File[]): void => {
    for (const f of images) {
      if (f.size > MAX_ATTACHMENT_BYTES) { attachNote(`"${f.name}" was not attached: each image must be under ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`); continue; }
      const reader = new FileReader();
      reader.onload = () => {
        const r = acceptAttachment(attached, String(reader.result), `al_${++attachSeq}`, f.name);
        if (r.ok && r.attachment) { attached = [...attached, r.attachment]; renderThumbs(); }
        else attachNote(`"${f.name || "The image"}" was not attached: ${r.reason ?? "it could not be read"}.`);
      };
      reader.readAsDataURL(f);
    }
  };
  // P-ATTACH.1 (ADR-0598): with the engine's attachment seam every file goes to the file tray, which hands
  // images back to stageImages; the rest are copied, extracted and scanned before they can go with a question.
  // Without it, Ask Lucid takes images only.
  const fileTray: AttachTray | null = deps.attach ? createAttachTray(null, { bridge: deps.attach, onImages: stageImages, imageCount: () => attached.length, notify: attachNote }) : null;
  const filesHost = el("div", "att-tray al-files");
  filesHost.hidden = true;
  fileTray?.mount(filesHost);
  const stageFiles = (files: readonly File[]): void => {
    if (fileTray) { void fileTray.add(files); return; }
    const images = files.filter((f) => f.type.startsWith("image/"));
    const others = files.length - images.length;
    if (others > 0) attachNote(`${others === 1 ? "One file was" : `${others} files were`} not attached: Ask Lucid takes images (PNG, JPEG, WebP or GIF) here.`);
    stageImages(images);
  };

  const form = el("form", "al-form");
  const input = el("textarea", "al-input");
  input.rows = 1;
  input.placeholder = "Ask Lucid anything";
  input.setAttribute("aria-label", "Ask Lucid");
  const sendBtn = el("button", "al-send", "Ask");
  sendBtn.type = "submit";
  // P-ATTACH.1: the "+" button, left of the input: Add files or photos, and Knowledge. Hidden unless the
  // managed policy allows attachments. Its glyph is built with the DOM like the rest of the panel.
  const plus = el("button", "al-plus");
  plus.type = "button";
  plus.hidden = true;
  plus.setAttribute("aria-label", "Add files and more");
  plus.setAttribute("data-tip", plusButtonTip(false));
  const svgNs = "http://www.w3.org/2000/svg";
  const glyph = document.createElementNS(svgNs, "svg");
  const glyphAttrs: [string, string][] = [["viewBox", "0 0 24 24"], ["width", "16"], ["height", "16"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.8"], ["stroke-linecap", "round"], ["aria-hidden", "true"]];
  for (const [k, v] of glyphAttrs) glyph.setAttribute(k, v);
  const glyphPath = document.createElementNS(svgNs, "path");
  glyphPath.setAttribute("d", "M12 5v14M5 12h14");
  glyph.appendChild(glyphPath);
  plus.appendChild(glyph);
  const pick = (): void => { void pickFiles().then((files) => { input.focus(); stageFiles(files); }); };
  if (fileTray && deps.attach) {
    const openKnowledge = deps.openKnowledge;
    mountPlusMenu(plus, plusMenuItems({ pick, ...(openKnowledge ? { knowledge: (anchor: HTMLElement) => openKnowledge(anchor) } : {}) }));
    syncPlusButton(plus, deps.attach, input);
  }
  form.append(plus, input, sendBtn);
  panel.append(log, quick, thumbs, filesHost, form);
  input.addEventListener("paste", (e) => {
    const files = clipboardFiles(e);
    if (!files.length) return; // text paste stays the textarea's own
    e.preventDefault();
    stageFiles(files);
  });
  bindFileDrop(panel, (files, folders) => {
    const note = folderDropNote(folders, false);
    if (note) attachNote(note);
    if (!files.length) return;
    stageFiles(files);
    input.focus();
  }, "Drop files to ask about them");

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

  const addUser = (text: string, images: readonly Attachment[] = [], files: readonly StagedAttachment[] = []): void => {
    welcome.remove();
    const m = el("div", "al-msg al-user", text);
    if (files.length) m.appendChild(sentFilesEl(files)); // P-ATTACH.1 (ADR-0598)
    if (images.length) {
      const row = el("div", "al-user-imgs");
      for (const a of images) {
        const img = el("img", "al-user-img");
        img.alt = a.name ?? "attached image";
        img.src = a.dataUrl;
        row.appendChild(img);
      }
      m.prepend(row);
    }
    log.appendChild(m);
    scrollDown();
  };
  const addLucid = (markdown: string, meta?: string): void => {
    welcome.remove();
    const m = el("div", "al-msg al-lucid");
    m.innerHTML = deps.markdown(markdown); // the chat's own sanitizing renderer
    deps.enhance?.(m);
    // P-ASKLUCID.8: the whole answer copies as its markdown, from the button or from a right-click anywhere on
    // it (ctxmenu.ts reads data-copy-text).
    m.dataset.copyText = markdown;
    const copy = el("button", "al-copy", "Copy");
    copy.type = "button";
    copy.dataset.tip = "Copy this answer";
    copy.setAttribute("aria-label", "Copy this answer");
    copy.addEventListener("click", () => {
      void copyToClipboard(markdown).then((ok) => {
        copy.textContent = ok ? "Copied" : "Copy blocked";
        copy.classList.toggle("done", ok);
        setTimeout(() => { copy.textContent = "Copy"; copy.classList.remove("done"); }, 1400);
      });
    });
    m.appendChild(copy);
    log.appendChild(m);
    if (meta) log.appendChild(el("div", "al-meta", meta));
    scrollDown();
    if (!dock.isVisible()) dock.setUnread(true);
  };
  /** P-ASKLUCID.9 (ADR-0600): the "Edit image" card's model area. It reads the usable models once, then shows the
   *  one Confirm will use, a short chooser (best first, the first recommended), or why Confirm cannot run, with
   *  the Settings, Providers jump when the fix is a key. Confirm stays disabled until a model is settled. A
   *  choice made in the chooser is remembered on Confirm; a model used because it was the only one is not, so
   *  connecting a second key later brings the chooser back. */
  let pickerSeq = 0;
  const imageModelPicker = (confirm: HTMLButtonElement): { el: HTMLElement; commit(): string | null; lock(): void } => {
    const ie = deps.imageEdit;
    const box = el("div", "al-img-model");
    const group = `al-img-model-${++pickerSeq}`;
    let chosen: string | null = null;
    let picked = false;
    let locked = false;
    confirm.disabled = true;
    box.appendChild(el("div", "al-img-note", "Checking which image models are connected"));
    const tipped = <T extends HTMLElement>(node: T, title: string, desc?: string): T => {
      node.setAttribute("data-tip", tipValue(title, desc));
      return node;
    };
    const button = (label: string, title: string, desc: string, onClick: () => void): HTMLButtonElement => {
      const b = tipped(el("button", "al-img-btn", label), title, desc);
      b.type = "button";
      b.addEventListener("click", onClick);
      return b;
    };
    const render = (st: ImageCardState, all: readonly ImageModelOptionView[]): void => {
      box.replaceChildren();
      if (st.kind === "none") {
        chosen = null;
        confirm.disabled = true;
        box.appendChild(el("div", "al-img-note", st.line));
        if (st.settings && ie) box.appendChild(button("Open Settings", "Open Settings", "Go to the Providers card to add an OpenAI, Google Gemini or xAI API key.", () => ie.openProviders()));
        return;
      }
      if (st.kind === "choice") {
        chosen = st.option.id;
        confirm.disabled = false;
        const row = el("div", "al-img-chosen");
        row.appendChild(tipped(el("span", "al-img-chosen-name", `Uses ${st.option.label}`), st.option.label, st.option.why));
        if (st.others > 0) row.appendChild(button("Change", "Change the image model", "Pick another connected model for this edit. LUCID remembers your pick.", () => render({ kind: "ask", options: [...all] }, all)));
        box.appendChild(row);
        return;
      }
      // Several models: the selection starts on the current one (after Change), else the recommendation.
      const start = st.options.some((o) => o.id === chosen) ? chosen : st.options[0]!.id;
      chosen = start;
      picked = true;
      confirm.disabled = false;
      const list = el("div", "al-img-opts");
      list.setAttribute("role", "radiogroup");
      list.setAttribute("aria-label", "Image model");
      for (const o of st.options) {
        const row = tipped(el("label", "al-img-opt"), o.label, o.why);
        const radio = el("input", "al-img-radio");
        radio.type = "radio";
        radio.name = group;
        radio.value = o.id;
        radio.checked = o.id === start;
        radio.addEventListener("change", () => { if (radio.checked) chosen = o.id; });
        const body = el("span", "al-img-opt-body");
        body.appendChild(el("span", "al-img-opt-name", o.label));
        if (o.recommended) {
          body.appendChild(el("span", "al-img-rec", "Recommended"));
          body.appendChild(el("span", "al-img-opt-why", o.why));
        }
        row.append(radio, body);
        list.appendChild(row);
      }
      box.append(el("div", "al-img-note", "Pick the image model for this edit. LUCID remembers your pick."), list);
    };
    void (async () => {
      const view = ie ? await ie.models().catch(() => null) : null;
      if (locked) return;
      render(imageCardState(view, readSavedImageModel(ie?.store ?? null)), view?.options ?? []);
      scrollDown();
    })();
    return {
      el: box,
      commit: () => {
        if (chosen && picked) saveImageModel(ie?.store ?? null, chosen);
        return chosen;
      },
      lock: () => {
        locked = true;
        for (const c of box.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) c.disabled = true;
      },
    };
  };
  /** P-ASKLUCID.9: under a finished edit, the saved file's full path (click = open it in the Preview's Ask Lucid
   *  tab), Copy path, and Show in folder where the shell can. The path breaks only after a separator. */
  const editedImageRow = (path: string): HTMLElement => {
    const ie = deps.imageEdit;
    const wrap = el("div", "al-img-result");
    const link = el("a", "al-img-path");
    link.href = "#";
    for (const part of pathBreakParts(path)) link.append(part, document.createElement("wbr"));
    link.setAttribute("data-tip", tipValue("Open in Preview", "Show the edited image in the Preview panel's Ask Lucid tab."));
    link.addEventListener("click", (e) => { e.preventDefault(); ie?.open(path); });
    const acts = el("div", "al-img-acts");
    const flash = (b: HTMLButtonElement, text: string, back: string): void => {
      b.textContent = text;
      setTimeout(() => { b.textContent = back; }, 1400);
    };
    const copy = el("button", "al-img-btn", "Copy path");
    copy.type = "button";
    copy.setAttribute("data-tip", tipValue("Copy path", "Copy the edited image's full path."));
    copy.addEventListener("click", () => { void copyToClipboard(path).then((ok) => flash(copy, ok ? "Copied" : "Copy blocked", "Copy path")); });
    acts.appendChild(copy);
    const reveal = ie?.showInFolder;
    if (reveal) {
      const show = el("button", "al-img-btn", "Show in folder");
      show.type = "button";
      show.setAttribute("data-tip", tipValue("Show in folder", "Open the folder in your file manager with the edited image selected."));
      show.addEventListener("click", () => { void reveal(path).catch(() => false).then((ok) => { if (!ok) flash(show, "Not found", "Show in folder"); }); });
      acts.appendChild(show);
    }
    wrap.append(link, acts);
    return wrap;
  };
  /** P-ASKLUCID.2 (ADR-0582): one proposed action as a card. Every string goes in through textContent. The
   *  detail rows are exactly what Confirm sends (actionDetails), so the user reads what will run. Confirm
   *  works once; Dismiss removes the card. */
  const addAction = (a: AskAction, images: readonly string[] = []): void => {
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
    // P-ASKLUCID.9 (ADR-0600): an edit_image card settles which model Confirm uses before Confirm can run.
    const model = a.kind === "edit_image" ? imageModelPicker(confirm) : null;
    if (model) card.appendChild(model.el);
    card.append(btns, result);
    dismiss.addEventListener("click", () => card.remove());
    confirm.addEventListener("click", () => {
      const modelId = model?.commit() ?? undefined;
      if (model && !modelId) return;
      confirm.disabled = true;
      dismiss.disabled = true;
      model?.lock();
      confirm.textContent = "Working";
      void run(a, { images, ...(modelId ? { modelId } : {}) }).catch((): AskActionResult => ({ ok: false, message: "It could not be done: the app did not answer." })).then((r) => {
        btns.remove();
        result.hidden = false;
        result.textContent = r.message;
        if (r.ok && r.image) {
          result.appendChild(editedImageRow(r.image.path));
          // A short note in the conversation too, so the path is there after the card scrolls away.
          const note = `I saved the edited image to \`${r.image.path}\`. It is open in the Preview panel's Ask Lucid tab.`;
          turns.push({ role: "lucid", text: note });
          addLucid(note);
        }
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
    // P-ASKLUCID.8: images alone are a question too. P-ATTACH.1 (ADR-0598): so are files.
    const fileCount = fileTray?.ids().length ?? 0;
    const text = raw.trim() || (attached.length ? `Look at the attached image${attached.length > 1 ? "s" : ""}.` : fileCount ? `Read the attached file${fileCount > 1 ? "s" : ""}.` : "");
    if (!text || busy) return;
    if (fileTray?.pending()) { attachNote("Ask again in a moment: the files are still being copied and scanned."); return; }
    const images = attached;
    attached = [];
    renderThumbs();
    // The files stay on the bar (as sending) until Lucid answers; an unanswered question puts them back.
    const sentFiles = fileTray?.hold() ?? [];
    const fileIds = sentFiles.map((a) => a.id);
    // A question the user wrote is not a miss: they knew what to ask.
    if (!fromRec) saveMemory(noteOwnQuestion(memory));
    engaged = true;
    dock.open();
    dock.setUnread(false);
    busy = true;
    sendBtn.disabled = true;
    input.value = "";
    autosize();
    addUser(text, images, sentFiles);
    setState("working");
    const history = historyToSend(turns);
    turns.push({ role: "user", text });
    // The screen is read at the moment of asking, so "this" means what the user sees now.
    const screen = deps.screen ? deps.screen().catch(() => null) : Promise.resolve(null);
    const extra: Promise<AskExtrasView> = deps.extras ? deps.extras().catch(() => ({})) : Promise.resolve({});
    // P-ASKLUCID.7 (ADR-0588): the picture is taken at the same moment as the text view of the screen.
    const shot = deps.shot ? deps.shot().catch(() => null) : Promise.resolve(null);
    void Promise.all([screen, extra, shot]).then(([s, x, p]) => deps.ask(text, history, { ...x, ...more, ...(s ? { screen: s } : {}), ...(s && p ? { shot: p } : {}), ...(images.length ? { images: images.map((a) => a.dataUrl) } : {}), ...(fileIds.length ? { attachments: fileIds } : {}) })).catch(() => null).then((r) => {
      busy = false;
      sendBtn.disabled = false;
      fileTray?.settle(fileIds, !!(r?.ok && r.reply));
      if (r?.ok && r.reply) {
        turns.push({ role: "lucid", text: r.reply });
        addLucid(r.reply, seenLine(r));
        // P-ASKLUCID.9 (ADR-0600): each card keeps the images of the question it answers, for edit_image.
        const urls = images.map((x) => x.dataUrl);
        for (const a of r.actions ?? []) addAction(a, urls);
        const noPicture = shotSkipLine(r.picture as ShotSkip | undefined);
        if (noPicture) log.appendChild(el("div", "al-meta", noPicture));
        const noImages = attachedLine(r.attached);
        if (noImages) log.appendChild(el("div", "al-meta", noImages));
        const dropped = droppedLine(r.actionsDropped ?? 0);
        if (dropped) log.appendChild(el("div", "al-meta", dropped));
        setState("done");
        // What comes next: the follow-ups Lucid gave, else a fresh reading of what is going on.
        if (r.followups?.length) showRecs(followupRecs(r.followups)); else void refreshRecs();
      } else {
        turns.pop(); // a question that was never answered is not history
        attached = [...images, ...attached].slice(0, MAX_ATTACHMENTS); // the images were not seen: give them back to retry
        renderThumbs();
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
    if (isAttachShortcut(e)) { e.preventDefault(); if (fileTray && !plus.hidden) pick(); return; } // P-ATTACH.1: Ctrl+U
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
