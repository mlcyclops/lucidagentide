// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/lane_view.ts - P-VIZ.LANE1 (ADR-0683): the ONE lane renderer. The Fleet card (fleet_grid.ts) and
// the Agent Worlds node panel (viz_view.ts) both draw a lane through this module, so the two cannot drift: the
// transcript (settled turns built once by id, the live block that streams thinking, tool chips and prose, the
// follow-the-newest-line scroll and the catch-up buttons), the fold of the lane's stream into that transcript and
// its seed from the recorded turns, the staged-prompt strip with its chip controls and item menu, and the pasted
// image strip with the composer's own limits (lane_view_model.acceptLaneImage).
//
// Moved here from fleet_grid.ts unchanged in behavior (P-FLEET.L3, L7, L13, DOCK1, READ1, PROGRESS.1, QUEUE-IMG.1,
// PUSH.PAR1, ATTACH.1). Each surface keeps only what is its own: where the lane's state lives, how it reaches the
// engine, and its chrome. A surface hands the queue controls a LaneQueueHost; everything else takes a LaneLog.

import { $, el } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { setTip } from "./ui.ts";
import { tipEsc } from "./tip_text.ts";
import { sentMetaEl, type SentFileMeta } from "./attach_ui.ts";
import { bindItemMenu, copyToClipboard, openCtxMenu, writeClipboard, type CtxMenuEntry } from "./ctxmenu.ts";
import { canSteer } from "./queue_model.ts";
import { seedTail, seedText, turnKey, type SeedRecord } from "./fleet_dock_model.ts";
import { renderMarkdown } from "./markdown.ts";
import { fitTables } from "./md_table_fit.ts"; // P-FLEET.READ1 (ADR-0646)
import { LANE_JUMP_SHOW_PX, pageDownTarget, shouldShowJump } from "./scroll_jump.ts";
import { laneChip, laneChipBody, laneToolDoing, mintId, settleToolRow, type LaneToolRow, type LaneTurnRow } from "./lane_transcript.ts";
import { humanMs } from "../turn_progress.ts";
import { acceptLaneImage, moveQueued } from "./lane_view_model.ts";
import type { ChipKind } from "./answer_chips.ts";
import type { LaneEvent, LaneImage, LaneView, LucidBridge } from "./bridge.ts";

/** P-ATTACH.1 (ADR-0598): a lane turn plus the display data of the files that went with it (never paths or
 *  text). P-FLEET.DOCK1: `partial` marks a followed reply folded before the surface saw all of it. */
export type LaneViewTurn = LaneTurnRow & { files?: SentFileMeta[]; partial?: boolean };

/** What a lane surface renders: the settled turns, the live turn being streamed, and the id counter behind every
 *  minted id. P-FLEET.L7: one monotone counter per lane, never reset while the lane lives, so a DOM node keyed on
 *  an id stays that turn's node for the life of the surface. */
export interface LaneLog {
  turns: LaneViewTurn[];
  pending: string;
  pendingThinking: string;
  pendingTools: LaneToolRow[];
  /** This surface owns a turn on the lane right now (its prompt or drain stream is open). */
  streaming: boolean;
  seq: number;
}

export function newLaneLog(): LaneLog {
  return { turns: [], pending: "", pendingThinking: "", pendingTools: [], streaming: false, seq: 0 };
}

/** P-FLEET.L7: every id on a lane surface comes from here, so a turn key and a chip key can never collide. */
export function nextId(log: LaneLog, prefix: string): string {
  log.seq += 1;
  return mintId(prefix, log.seq);
}

// ---------------------------------------------------------------- the transcript
//
// P-FLEET.L7: this used to be one `out.innerHTML = outputHtml(run)` per TOKEN. That single line was the root cause of
// two separate complaints: it wiped the text selection mid-stream (so you could not copy anything out of a working
// lane) and it reset every open <details> (so an expanded tool call slammed shut on the next token). The fix is
// structural, not defensive: settled turns are keyed by a stable id, painted ONCE and then never touched again, and
// only `[data-lane-live]` re-renders while tokens land - and even there the prose is a text-node update and the
// chips are append-only. Nothing already on screen is rebuilt.

/** The transcript pane: the scroller with its empty line and live block, then the catch-up pair. P-FLEET.L13: the
 *  buttons are SIBLINGS of the scroller, not children: an absolutely positioned child of a scroll container scrolls
 *  away with its content, which is exactly how they used to vanish mid-transcript. The wrapper is the
 *  position:relative anchor, so they stay pinned over the bottom-right of the viewport until the reader is within
 *  the lane's own at-the-bottom threshold. `extra` rides in the wrapper too (the Fleet card's preview chip). */
export function laneOutHtml(extra = ""): string {
  return `<div class="fleet-out-wrap">
        <div class="fleet-out" data-fleet-out>
          <div class="fleet-out-empty" data-lane-empty hidden><span data-lane-empty-txt></span></div>
          <div data-lane-live hidden>
            <div class="fleet-think" data-lane-think hidden></div>
            <div class="fleet-text" data-lane-text hidden><span data-lane-txt></span><span class="fleet-cursor">\u258b</span></div>
          </div>
        </div>
        <button class="fleet-jump fleet-jump-page" data-lane-jump="page" type="button" aria-label="Scroll down one page" data-tip="Down one page">${icon("chevronDown", 13)}</button>
        <button class="fleet-jump fleet-jump-end" data-lane-jump="end" type="button" aria-label="Scroll to the newest line" data-tip="Jump to the end">${icon("chevronsDown", 13)}</button>
        ${extra}
      </div>`;
}

/** The chip kind's glyph. Mirrors app.ts `phaseIcon`'s categories, but keyed on answer_chips' KIND rather
 *  than re-sniffing the tool name, so the lane and the composer cannot classify the same call differently. */
const CHIP_ICON: Record<ChipKind, string> = {
  read: "search", search: "search", edit: "folder", write: "folder",
  run: "command", fetch: "link", task: "runs", other: "command",
};

const baseName = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** The chevron drilldown. `laneChipBody` decides WHAT is revealed (a diff, the command that ran, or the
 *  title); one span per diff row keeps a 400-row diff 400 cheap nodes instead of a re-parsed blob. */
function chipBody(t: LaneToolRow): HTMLElement | null {
  const body = laneChipBody(t);
  if (!body) return null;
  const wrap = el(`<div class="fleet-tinline"><pre class="fleet-tinline-pre"></pre></div>`);
  const pre = $(".fleet-tinline-pre", wrap) as HTMLElement;
  if (body.kind === "diff") {
    for (const row of body.rows) {
      const line = el(`<span class="dl-${row.type}"></span>`);
      line.textContent = `${row.text}\n`; // the newline rides the span so `white-space:pre` still breaks rows
      pre.append(line);
    }
  } else {
    pre.textContent = body.text; // the command, verbatim - never markdown, never re-wrapped
  }
  return wrap;
}

/** One tool call: the composer's `.tchip` anatomy at mini-window scale. The chevron is OMITTED when
 *  `hasBody` is false, because a chevron that opens onto nothing is a lie the user only finds by clicking. */
export function chipRow(t: LaneToolRow): HTMLElement {
  const c = laneChip(t);
  const stat = c.diffstat
    ? `<span class="fleet-diffstat"><ins>+${c.diffstat.add}</ins><del>-${c.diffstat.del}</del></span>`
    : "";
  const file = t.code?.path ? `<span class="fleet-diff-path"></span>` : "";
  // No body means no chevron AND no aria-expanded: announcing "collapsed" for something that cannot expand
  // is the accessible-tree version of the dead chevron this increment exists to remove.
  const chev = c.hasBody ? `<span class="fleet-tchip-chev">${icon("chevron", 11)}</span>` : "";
  const expand = c.hasBody ? ` aria-expanded="false"` : "";
  // P-PROGRESS.1: the state mark (spinning while the call is open, its length once settled) and the doing
  // line in the head: what the call is doing, in the agent's own words when it gave them.
  const state = t.status ? `<span class="fleet-tchip-state" data-state="${esc(t.status)}"></span>` : "";
  const row = el(`<div class="fleet-chip-row" data-lane-chip="${esc(t.id)}">
    <button class="fleet-tchip ${c.kind}${c.failed ? " fail" : ""}" type="button" data-fleet-chip="${esc(t.id)}"${expand}>${icon(CHIP_ICON[c.kind], 11)}<span class="fleet-tchip-k"></span><span class="fleet-tchip-d"></span>${file}${stat}${state}${chev}</button>
  </div>`);
  const btn = $(".fleet-tchip", row) as HTMLButtonElement;
  // textContent, never interpolation: a hostile tool name / path / detail cannot break out of the markup.
  ($(".fleet-tchip-k", btn) as HTMLElement).textContent = c.k;
  ($(".fleet-tchip-d", btn) as HTMLElement).textContent = laneToolDoing(t);
  const stateEl = $(".fleet-tchip-state", btn) as HTMLElement | null;
  if (stateEl && t.status) {
    const took = t.elapsedMs !== undefined ? humanMs(t.elapsedMs) : "";
    stateEl.textContent = t.status === "open" ? "" : took;
    setTip(stateEl, t.status === "open" ? "running" : t.status === "done" ? (took ? `done in ${took}` : "done") : (took ? `failed after ${took}` : "failed"));
  }
  const path = $(".fleet-diff-path", btn) as HTMLElement | null;
  if (path && t.code?.path) { path.textContent = baseName(t.code.path); setTip(path, t.code.path); }
  if (t.code?.path) setTip(btn, c.k, t.code.path); else setTip(btn, c.detail || c.k);
  const body = c.hasBody ? chipBody(t) : null;
  if (body) row.append(body);
  // The open flag lives on the ROW, not in the DOM: the live block repaints per token and a settled turn is
  // rebuilt on a reopen, and an expanded chevron has to survive both.
  if (t.open && body) {
    btn.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    body.classList.add("open");
  }
  return row;
}

/** A SETTLED turn. Built once per turn id, then left alone forever - the whole point of P-FLEET.L7. */
export function buildTurn(t: LaneViewTurn): HTMLElement {
  const wrap = el(`<div data-lane-turn="${esc(t.id)}" data-role="${t.role}"></div>`);
  // P-FLEET.READ1 (ADR-0646): the copy button rides a zero-height sticky strip FIRST in the turn, so on a long
  // reply it stays at the top-right of the visible part instead of scrolling away with the turn's first line.
  // An answer copies its reply as written (lane_transcript.turnReplyText), like the main chat's Copy.
  const tip = t.role === "assistant" ? "Copy this reply|The reply as the agent wrote it, tables and all" : "Copy this prompt";
  wrap.append(el(`<div class="fleet-turn-acts"><button class="fleet-turn-copy" type="button" data-fleet-turn-copy="${esc(t.id)}" data-tip="${esc(tip)}" aria-label="${t.role === "assistant" ? "Copy this reply" : "Copy this prompt"}">${icon("copy", 13)}</button></div>`));
  if (t.role === "user") {
    const line = el(`<div class="fleet-turn-user"></div>`);
    for (const src of t.images ?? []) line.append(el(`<img class="fleet-thumb" src="${esc(src)}" alt="pasted image" />`));
    line.append(document.createTextNode(t.text));
    setTip(line, t.text);
    wrap.append(line);
    // P-ATTACH.1 (ADR-0598): the files that went with this turn, read-only, like the main composer's message.
    if (t.files?.length) wrap.append(sentMetaEl(t.files));
  } else {
    const thinking = (t.thinking ?? "").trim();
    if (thinking) { const th = el(`<div class="fleet-think"></div>`); th.textContent = thinking; wrap.append(th); }
    for (const tool of t.tools) wrap.append(chipRow(tool));
    // A settled turn earns real markdown; only the live stream stays escaped text.
    if (t.text.trim()) { const md = el(`<div class="fleet-md"></div>`); md.innerHTML = renderMarkdown(t.text); fitTables(md); wrap.append(md); }
    if (t.error) {
      const err = el(`<div class="fleet-errline">${icon("info", 11)}<span></span></div>`);
      const s = $("span", err) as HTMLElement;
      s.textContent = t.error; setTip(s, t.error);
      wrap.append(err);
    }
  }
  return wrap;
}

/** Is there a turn in flight? Also the guard on the live block and on the clipboard's live section. */
export function hasLive(log: LaneLog): boolean {
  return log.streaming || log.pending !== "" || log.pendingThinking !== "" || log.pendingTools.length > 0;
}

/** The live half of the clipboard text, or undefined when nothing is streaming. */
export function liveCopy(log: LaneLog): { text: string; thinking?: string; tools: readonly LaneToolRow[] } | undefined {
  return hasLive(log) ? { text: log.pending, thinking: log.pendingThinking, tools: log.pendingTools } : undefined;
}

/** APPEND newly-settled turns. Existing turn nodes are not read, not diffed and not rewritten: the node
 *  count IS the cursor, which also means a rebuilt pane (a reopen) repaints the whole history for free. */
function syncTurns(log: LaneLog, out: HTMLElement, live: HTMLElement): void {
  const painted = out.querySelectorAll("[data-lane-turn]").length;
  for (let i = painted; i < log.turns.length; i++) out.insertBefore(buildTurn(log.turns[i]!), live);
}

/** The ONLY thing that re-renders per token, and even here: the thinking and prose blocks are text-node
 *  writes and the chips are append-only, so a selection inside a streaming reply survives and an open
 *  chevron stays open. When the turn settles this empties - its content is a settled turn node by then. */
function paintLive(log: LaneLog, live: HTMLElement): void {
  const show = hasLive(log);
  live.hidden = !show;
  const think = $("[data-lane-think]", live) as HTMLElement | null;
  const text = $("[data-lane-text]", live) as HTMLElement | null;
  const txt = $("[data-lane-txt]", live) as HTMLElement | null;
  const rows = [...live.querySelectorAll<HTMLElement>(".fleet-chip-row")];
  // Chips are append-only WHILE the ids keep matching; a reset composer (send / retry / drain empties
  // pendingTools) must not leave the last turn's chips behind, so a row that no longer owns its slot goes.
  let keep = 0;
  while (keep < rows.length && keep < log.pendingTools.length && rows[keep]!.dataset.laneChip === log.pendingTools[keep]!.id) keep++;
  for (let i = keep; i < rows.length; i++) rows[i]!.remove();
  if (!show) {
    if (think) { think.textContent = ""; think.hidden = true; }
    if (txt) txt.textContent = "";
    if (text) text.hidden = true;
    return;
  }
  const thinking = log.pendingThinking.trim();
  if (think) { think.hidden = thinking === ""; if (think.textContent !== thinking) think.textContent = thinking; }
  for (let i = keep; i < log.pendingTools.length; i++) live.insertBefore(chipRow(log.pendingTools[i]!), text);
  // Shown for the whole live turn, not just once prose arrives: the block carries the blinking cursor, and
  // a tool-only stretch with no cursor reads as a dead lane.
  if (text) text.hidden = false;
  if (txt && txt.textContent !== log.pending) txt.textContent = log.pending;
}

/** Paint `log` into its transcript pane `out` (a `[data-fleet-out]` from laneOutHtml). `idle` says what a pane with
 *  nothing in it shows. Keeps the newest line in view while the reader is at the bottom, never fights a scroll up. */
export function paintLaneOutput(out: HTMLElement, log: LaneLog, idle: () => string): void {
  const live = $("[data-lane-live]", out) as HTMLElement | null; if (!live) return;
  const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < LANE_JUMP_SHOW_PX;
  syncTurns(log, out, live);
  paintLive(log, live);
  const empty = $("[data-lane-empty]", out) as HTMLElement | null;
  if (empty) {
    const bare = log.turns.length === 0 && !hasLive(log);
    empty.hidden = !bare;
    if (bare) { const t = $("[data-lane-empty-txt]", empty) as HTMLElement | null; if (t) t.textContent = idle(); }
  }
  if (nearBottom) out.scrollTop = out.scrollHeight; // keep the latest in view, but never fight a user scroll
  syncLaneJump(out);
}

/** Empty a pane for another lane's log (the node panel switching agents): its settled turns go, the live block and
 *  the empty line stay. */
export function clearLaneOutput(out: HTMLElement): void {
  for (const n of out.querySelectorAll("[data-lane-turn]")) n.remove();
  for (const n of out.querySelectorAll("[data-lane-live] .fleet-chip-row")) n.remove();
  out.scrollTop = 0;
}

/** P-FLEET.L13: show or hide a pane's catch-up buttons. Driven by the SHARED rule (scroll_jump.ts) that the main
 *  chat thread uses, on the lane threshold: the buttons live until the reader is at the bottom by the same measure
 *  the pane uses to auto-follow new tokens (paintLaneOutput's nearBottom). */
function syncLaneJump(out: HTMLElement): void {
  const show = shouldShowJump(out, LANE_JUMP_SHOW_PX);
  const wrap = out.parentElement ?? out;
  for (const b of wrap.querySelectorAll<HTMLElement>("[data-lane-jump]")) b.classList.toggle("show", show);
}

/** The transcript's own line height, for the page step's line of overlap. Measured off a real rendered
 *  row rather than assumed, and falling back to the lane font's ~18px when nothing has painted yet. */
function laneLineHeight(out: HTMLElement): number {
  const row = out.querySelector(".fleet-text, .fleet-turn-user, .fleet-think") as Element | null;
  const lh = row ? Number.parseFloat(getComputedStyle(row).lineHeight) : Number.NaN;
  return Number.isFinite(lh) && lh > 0 ? lh : 18;
}

/** A pane's catch-up button (delegated on the surface). `page` advances one viewport minus a line of overlap
 *  (smooth: the reader is following along); `end` is deliberately INSTANT, because a long transcript is a slow ride
 *  to somewhere the reader already asked to be. Same reasoning, and same math, as the main chat's pair. */
export function onLaneJumpClick(ev: Event): void {
  const btn = (ev.target as HTMLElement | null)?.closest("[data-lane-jump]") as HTMLElement | null;
  if (!btn) return;
  const out = btn.closest(".fleet-out-wrap")?.querySelector("[data-fleet-out]") as HTMLElement | null;
  if (!out) return;
  ev.preventDefault();
  ev.stopPropagation(); // never let a jump click reach a drag gesture under it (the Fleet card's header)
  if (btn.dataset.laneJump === "end") out.scrollTo({ top: out.scrollHeight, behavior: "auto" });
  else out.scrollTo({ top: pageDownTarget(out, laneLineHeight(out)), behavior: "smooth" });
  syncLaneJump(out);
}

/** Keep each pane's buttons in step with its own scroll position. Captured (scroll does not bubble) and filtered
 *  to transcripts, so an unrelated scroller on the surface costs nothing. */
export function onLaneScroll(ev: Event): void {
  const t = ev.target as HTMLElement | null;
  if (t?.hasAttribute?.("data-fleet-out")) syncLaneJump(t);
}

/** Find a tool row by its minted id - the chevron remembers `open` on the RECORD, so the live block's per-token
 *  repaint and a pane rebuilt on reopen both restore what the user expanded. */
function findTool(log: LaneLog, id: string): LaneToolRow | undefined {
  for (const t of log.pendingTools) if (t.id === id) return t;
  for (const turn of log.turns) for (const t of turn.tools) if (t.id === id) return t;
  return undefined;
}

/** P-FLEET.L7: the chevron. `.open` goes on BOTH the button and the inline body, exactly as the composer's .tchip
 *  does, and the flag is remembered on the tool RECORD so a repaint restores it. */
export function toggleLaneChip(chip: HTMLElement, log: LaneLog): void {
  const row = chip.closest(".fleet-chip-row") as HTMLElement | null;
  const body = row ? ($(".fleet-tinline", row) as HTMLElement | null) : null;
  if (!body) return; // no body means no chevron was rendered; nothing to toggle
  const open = !chip.classList.contains("open");
  chip.classList.toggle("open", open);
  chip.setAttribute("aria-expanded", String(open));
  body.classList.toggle("open", open);
  const rec = findTool(log, chip.dataset.fleetChip ?? "");
  if (rec) rec.open = open;
}

/** A silent copy is indistinguishable from a broken one, so the button confirms for a beat. Plain UTF-8
 *  straight out of lane_transcript - the clipboard text is never rebuilt from the DOM. */
export async function copyOut(btn: HTMLElement, text: string): Promise<void> {
  if (!text) return;
  try { await writeClipboard(text); } catch { return; } // no clipboard permission: stay silent
  btn.classList.add("copied");
  window.setTimeout(() => btn.classList.remove("copied"), 900);
}

// ---------------------------------------------------------------- the stream fold

/** Settle the live turn into a turn of its own (with `error` when the turn failed) and empty the live block. */
export function foldPending(log: LaneLog, error?: string): void {
  if (log.pending.trim() || log.pendingThinking.trim() || log.pendingTools.length || error) {
    log.turns.push({
      id: nextId(log, "t"),
      role: "assistant",
      text: log.pending,
      thinking: log.pendingThinking.trim() || undefined,
      tools: log.pendingTools.slice(),
      error,
    });
  }
  log.pending = ""; log.pendingThinking = ""; log.pendingTools = [];
}

/** Fold one streamed piece of the live turn (prose, thinking, a tool call or its settle, an auto-approval) into
 *  `log`. True when the transcript changed. P-PROGRESS.1: a settle event closes the row its call opened (done /
 *  failed, with its length); a settle for a call this surface never saw changes nothing. Only an OPEN event appends
 *  a row. P-FLEET.L7: `input` is the bounded, code-stripped command the engine carries, the chevron's body for a
 *  bash/read/search chip. */
export function foldLaneStream(log: LaneLog, e: LaneEvent): boolean {
  switch (e.type) {
    case "token": log.pending += e.text; return true;
    case "thinking": log.pendingThinking += e.text; return true;
    case "tool":
      if (e.id && (e.status === "done" || e.status === "failed")) return settleToolRow(log.pendingTools, e.id, e.status, e.elapsedMs);
      log.pendingTools.push({
        id: nextId(log, "c"), name: e.name, detail: e.detail,
        ...(e.code ? { code: e.code } : {}), ...(e.input ? { input: e.input } : {}),
        ...(e.id ? { callId: e.id } : {}), ...(e.intent ? { intent: e.intent } : {}),
        ...(e.status ? { status: e.status } : {}), ...(e.elapsedMs !== undefined ? { elapsedMs: e.elapsedMs } : {}),
        open: false,
      });
      return true;
    case "auto-approved":
      // Rides the tool-chip render path: the transcript shows WHAT was auto-granted and by which mode.
      log.pendingTools.push({ id: nextId(log, "c"), name: e.mode === "auto" ? "auto-approved" : "session-approved", detail: e.summary, open: false });
      return true;
    default:
      return false;
  }
}

/** P-FLEET.DOCK1: one lane transcript record as a turn. The record's tool calls become chips (settled by their
 *  `ok`), so the text drops the engine's `[ran: ...]` lines that stood for them. */
function seedTurn(log: LaneLog, r: SeedRecord): LaneViewTurn {
  const tools: LaneToolRow[] = (r.tools ?? []).map((t) => ({
    id: nextId(log, "c"), name: t.name, detail: t.detail, open: false,
    ...(t.code ? { code: t.code } : {}), ...(t.input ? { input: t.input } : {}), ...(t.intent ? { intent: t.intent } : {}),
    ...(t.id ? { callId: t.id } : {}), ...(t.ok === undefined ? {} : { status: t.ok ? "done" as const : "failed" as const }),
    ...(t.elapsedMs !== undefined ? { elapsedMs: t.elapsedMs } : {}),
  }));
  return {
    id: nextId(log, "t"), role: r.role, text: seedText(r), tools,
    ...(r.thinking?.trim() ? { thinking: r.thinking.trim() } : {}), ...(r.error ? { error: r.error } : {}),
  };
}

/** P-FLEET.DOCK1: append the transcript records the surface does not show yet (fleet_dock_model.seedTail). A log
 *  that matches none of them takes none: a gap beats a duplicate. */
export function applySeed(log: LaneLog, records: readonly SeedRecord[]): void {
  const from = seedTail(log.turns, records);
  if (from === null) return;
  for (const r of records.slice(from)) {
    if (turnKey(r.role, r.text) === undefined && !r.error && !r.tools?.length && !r.thinking?.trim()) continue; // nothing to show
    log.turns.push(seedTurn(log, r));
  }
}

// ---------------------------------------------------------------- the staged-prompt strip

type Queued = LaneView["queued"];

/** P-FLEET.L3: the staged-prompt strip - one compact chip per queued prompt, in run order, each with Update,
 *  its go button, reorder and delete. Chips ellipsize on one line (invariant 11). `go` is the Fleet card's Push now
 *  (P-PUSH.PAR1: a new lane on its own worktree; "pushing" while one starts) or, where a surface cannot open a lane,
 *  Steer (the running turn takes the prompt's text now; off while nothing runs or the prompt carries images or
 *  files). The HTML is compared with what was last WRITTEN, never `q.innerHTML`: the browser re-serializes
 *  (`disabled` reads back as `disabled=""`), so that comparison never matched and rebuilt the chips every paint. */
export function paintQueueStrip(q: HTMLElement, queued: Queued, go: { kind: "push"; pushing: boolean } | { kind: "steer"; running: boolean }): void {
  q.hidden = queued.length === 0;
  const goBtn = (i: number, item: Queued[number]): string => {
    if (go.kind === "push") {
      return go.pushing
        ? `<button class="fleet-q-btn fleet-q-push" data-q-go="${i}" aria-disabled="true" data-tip="Pushing|A new agent on its own worktree is starting for a prompt from this one" aria-label="Push in progress">Pushing\u2026</button>`
        : `<button class="fleet-q-btn fleet-q-push" data-q-go="${i}" data-tip="Push now|Run this in parallel in a new agent on its own worktree while this one keeps working" aria-label="Push staged prompt ${i + 1} to a new parallel agent on its own worktree">Push now</button>`;
    }
    const why = !go.running ? "Nothing is running to steer. It runs in order when this agent goes idle."
      : item.images || item.files ? "Steer is text only. This prompt carries images or files, so it runs as a turn of its own." : "";
    return `<button class="fleet-q-btn fleet-q-push" data-q-go="${i}"${why ? ` aria-disabled="true"` : ""} data-tip="${esc(why ? `Steer|${why}` : "Steer|Send this prompt's text into the running turn now")}" aria-label="Steer the running turn with staged prompt ${i + 1}">Steer</button>`;
  };
  const html = queued
    .map((item, i) => `<span class="fleet-q-chip" data-q-row="${i}" data-tip="Right-click or long-press to copy"><b>${i + 1}</b><span class="fleet-q-txt" data-tip="${esc(tipEsc(item.text))}">${esc(item.text)}</span>${item.images ? `<span class="fleet-q-img" data-tip="${item.images} image${item.images === 1 ? "" : "s"} ride with this prompt">${item.images} img</span>` : ""}${item.files ? `<span class="fleet-q-img fleet-q-files" data-tip="${item.files} file${item.files === 1 ? "" : "s"} ride with this prompt">${item.files} file${item.files === 1 ? "" : "s"}</span>` : ""}<button class="fleet-q-btn fleet-q-edit" data-q-edit="${i}" data-tip="Update|Pull this prompt, its images and its files back into the composer to edit" aria-label="Update staged prompt ${i + 1}">Update</button>${goBtn(i, item)}<button class="fleet-q-btn" data-q-up="${i}" data-tip="Run earlier" aria-label="Move staged prompt ${i + 1} up" ${i === 0 ? "disabled" : ""}>\u2191</button><button class="fleet-q-btn" data-q-dn="${i}" data-tip="Run later" aria-label="Move staged prompt ${i + 1} down" ${i === queued.length - 1 ? "disabled" : ""}>\u2193</button><button class="fleet-q-btn" data-q-x="${i}" data-tip="Remove" aria-label="Remove staged prompt ${i + 1}">\u00d7</button></span>`)
    .join("");
  if (stripHtml.get(q) !== html) { q.innerHTML = html; stripHtml.set(q, html); }
}

/** Each strip's last written HTML (paintQueueStrip, paintAttachStrip). */
const stripHtml = new WeakMap<HTMLElement, string>();

/** The engine calls a staged-prompt control makes. */
export type LaneQueueBridge = Pick<LucidBridge, "fleetQueuePeek" | "fleetQueueRemove" | "fleetQueueMove" | "fleetQueueTake" | "fleetQueueAdd" | "interject">;

/** What a surface lends the staged-prompt controls: its lane's queue as it shows it, a way to change that view
 *  optimistically (the next poll is the truth), its note line, its composer, and a re-read of the fleet. */
export interface LaneQueueHost {
  readonly id: string;
  readonly bridge: LaneQueueBridge;
  queued(): Queued;
  /** Show `next` until the next poll (an optimistic remove, reorder or take). */
  setQueued(next: Queued): void;
  /** A turn runs on the lane right now (lane_view_model.laneStages). */
  busy(): boolean;
  note(text: string): void;
  refresh(): void;
  /** The composer holds a draft (text, images or files) that an Update must not overwrite. */
  hasDraft(): boolean;
  /** Load a staged prompt into the empty composer; resolves the note to show (files that did not come back). */
  loadDraft(text: string, images: LaneImage[], fileIds: readonly string[]): Promise<string | null>;
  /** Add a staged prompt after the composer's draft; resolves the note to show. */
  appendDraft(text: string, images: LaneImage[], fileIds: readonly string[]): Promise<string | null>;
  /** P-ATTACH.1 (ADR-0598): a removed prompt's staged files back on the composer's bar, where the surface has one. */
  restoreFiles(ids: readonly string[]): Promise<{ ready: number; note: string | null }>;
}

/** Remove staged prompt `i` (optimistic; the poll is truth). */
export function removeStaged(h: LaneQueueHost, i: number): void {
  h.setQueued(h.queued().filter((_, n) => n !== i));
  void h.bridge.fleetQueueRemove(h.id, i).catch(() => { /* the next poll corrects it */ });
}

/** Move staged prompt `i` one place (optimistic; the poll is truth). */
export function moveStaged(h: LaneQueueHost, i: number, dir: -1 | 1): void {
  const next = moveQueued(h.queued(), i, dir);
  if (!next) return;
  h.setQueued(next);
  void h.bridge.fleetQueueMove(h.id, i, dir).catch(() => { /* the next poll corrects it */ });
}

/** P-QUEUE-IMG.1 (ADR-0469): Update on a staged chip. The manager hands back the item's FULL text and its own images
 *  (the poll only carries a clipped preview and a count) and they load into the composer: the image strip shows them
 *  removable, paste adds more, and Send/Stage uses the edited prompt (a re-stage appends; the manager queue has no
 *  item ids to anchor a slot to). P-ATTACH.1 (ADR-0598): its staged files come back as ready chips where the surface
 *  has a file bar. A draft in the composer, text or images, is never overwritten: the Update is refused with a note. */
export function editStaged(h: LaneQueueHost, i: number): void {
  if (h.hasDraft()) { h.note("Update never overwrites a draft. Send, stage or clear this agent's composer, then press Update."); return; }
  if (!h.queued()[i]) return;
  h.setQueued(h.queued().filter((_, n) => n !== i));
  void h.bridge.fleetQueueTake(h.id, i).then((r) => {
    if (!r?.ok || !r.item) { h.refresh(); h.note(`Not updated: ${r?.reason ?? "the engine did not answer"}.`); return; }
    const item = r.item;
    const fileIds = item.attachments ?? [];
    // Typed or pasted into while the take was in flight: the item is already out of the manager queue, so it goes
    // back on the end of it rather than over the new draft (its file ids with it, P-ATTACH.1).
    if (h.hasDraft()) {
      void h.bridge.fleetQueueAdd(h.id, item.text, item.images, fileIds.length ? fileIds : undefined).then(async (a) => {
        h.refresh();
        if (a?.ok) { h.note("Your composer got a draft first, so the staged prompt went back on the end of the queue."); return; }
        // Could not re-stage either: the composer is the only place left, so it is added after the draft.
        const lost = await h.appendDraft(item.text, item.images, fileIds);
        h.note(`Could not re-stage it (${a?.reason ?? "no answer"}), so it was added after your draft in the composer.${lost ? ` ${lost}` : ""}`);
      });
      return;
    }
    void h.loadDraft(item.text, item.images, fileIds).then((note) => { if (note) h.note(note); });
  }).catch(() => { h.refresh(); });
}

/** Copy a staged prompt's full text; `remove` then takes it out of the queue so it can be re-pasted and edited. The
 *  clipboard write comes FIRST and the remove is guarded by the text, so a refused clipboard or a drain in between
 *  never loses the prompt. Images are not text: they stay with a kept item, and a removed one says they went with it. */
export async function copyStaged(h: LaneQueueHost, i: number, remove: boolean): Promise<void> {
  const r = await h.bridge.fleetQueuePeek(h.id, i).catch(() => null);
  if (!r?.ok || !r.item) { h.refresh(); h.note(`Not copied: ${r?.reason ?? "the engine did not answer"}.`); return; }
  const imgs = r.item.images.length;
  const fileIds = r.item.attachments ?? [];
  if (!(await copyToClipboard(r.item.text))) { h.note("Not copied: the clipboard refused. The prompt stays staged."); return; }
  if (!remove) {
    const stay = imgs && fileIds.length ? "images and files" : imgs ? "images" : fileIds.length ? "files" : "";
    h.note(stay ? `Copied the prompt text. Its ${stay} stay with the staged prompt.` : "Copied. Paste it into any prompt bar.");
    return;
  }
  const gone = await h.bridge.fleetQueueRemove(h.id, i, r.item.text).catch(() => null);
  h.refresh();
  if (!gone?.ok) { h.note("Copied. It had already left the queue (it ran or was removed)."); return; }
  // P-ATTACH.1 (ADR-0598): the text goes to the clipboard; the files are not text, so they come back to the
  // composer's bar as ready chips instead of leaving with the removed prompt.
  const back = await h.restoreFiles(fileIds);
  const filesNote = back.ready > 0 ? ` Its ${back.ready} file${back.ready === 1 ? " is" : "s are"} on this agent's bar.` : "";
  h.note(`Copied and removed. Paste it into a prompt bar to edit or keep it${imgs ? `; its ${imgs} image${imgs === 1 ? " was" : "s were"} removed with it` : ""}.${filesNote}${back.note ? ` ${back.note}` : ""}`);
}

/** Steer running turn: the full text goes into the lane's running turn as a note; ADR-0414: it leaves the queue
 *  only once the note is accepted. Text only, and only while a turn runs. */
export async function steerStaged(h: LaneQueueHost, i: number): Promise<void> {
  if (!h.busy()) { h.note("Nothing is running to steer. Staged prompts run in order when this agent goes idle."); return; }
  const r = await h.bridge.fleetQueuePeek(h.id, i).catch(() => null);
  if (!r?.ok || !r.item) { h.refresh(); h.note(`Not steered: ${r?.reason ?? "the engine did not answer"}.`); return; }
  if (r.item.images.length) { h.note("Steer is text only. This prompt carries images, so it stays staged and runs as a turn of its own."); return; }
  if (r.item.attachments?.length) { h.note("Steer is text only. This prompt carries files, so it stays staged and runs as a turn of its own."); return; }
  const text = r.item.text;
  h.setQueued(h.queued().filter((_, n) => n !== i));
  const res = await h.bridge.interject(h.id, text, { live: true });
  if (res.ok) { void h.bridge.fleetQueueRemove(h.id, i, text).catch(() => { /* the next poll corrects it */ }); return; }
  h.refresh(); // repaint the chip the optimistic removal hid
  h.note(`Not steered: ${res.reason}. It stays staged and runs as this agent's next prompt.`);
}

/** Right-click / long-press on a staged chip: Copy prompt, Copy and remove, and (text-only, while the lane runs a
 *  turn) Steer running turn. Text is read WHOLE from the manager (the chip only holds a 140-char preview). */
function openStagedMenu(h: LaneQueueHost, i: number, x: number, y: number, row: HTMLElement): void {
  const item = h.queued()[i]; if (!item) return;
  const entries: CtxMenuEntry[] = [
    { label: "Copy prompt", run: () => void copyStaged(h, i, false) },
    { label: "Copy and remove", run: () => void copyStaged(h, i, true) },
  ];
  // P-ATTACH.1 (ADR-0598): a steer note is text only, so files keep it off the menu like images do.
  if (canSteer({ hold: true, running: h.busy(), images: item.images + (item.files ?? 0) })) entries.push({ label: "Steer running turn", run: () => void steerStaged(h, i) });
  const focused = row.contains(document.activeElement) ? (document.activeElement as HTMLElement) : (row.querySelector("button") as HTMLElement | null);
  openCtxMenu(x, y, entries, { returnFocus: focused, className: "ctx-menu-stage" });
}

/** Bind a strip's item menu ONCE per strip element (the flag survives the innerHTML rebuilds); the host is resolved
 *  at open time because the surface may have replaced its lane state since. */
export function bindQueueMenu(q: HTMLElement, hostOf: (row: HTMLElement) => LaneQueueHost | null): void {
  if (q.dataset.menuBound) return;
  q.dataset.menuBound = "1";
  bindItemMenu(q, "[data-q-row]", (row, x, y) => {
    const h = hostOf(row);
    if (h) openStagedMenu(h, Number(row.dataset.qRow), x, y, row);
  });
}

/** A click inside a staged chip: Update, the go button (`go`, the surface's Push now or Steer), reorder or remove.
 *  True when it was one of them. */
export function onQueueClick(t: HTMLElement, h: LaneQueueHost, go: (i: number) => void): boolean {
  const qgo = t.closest("[data-q-go]") as HTMLElement | null;
  if (qgo) { go(Number(qgo.dataset.qGo)); return true; }
  const qed = t.closest("[data-q-edit]") as HTMLElement | null;
  if (qed) { editStaged(h, Number(qed.dataset.qEdit)); return true; }
  const qx = t.closest("[data-q-x]") as HTMLElement | null;
  if (qx) { removeStaged(h, Number(qx.dataset.qX)); return true; }
  const qup = t.closest("[data-q-up]") as HTMLElement | null;
  const qdn = t.closest("[data-q-dn]") as HTMLElement | null;
  if (qup || qdn) { moveStaged(h, Number((qup ?? qdn)!.dataset[qup ? "qUp" : "qDn"]), qup ? -1 : 1); return true; }
  return false;
}

// ---------------------------------------------------------------- pasted images and the composer

/** P-FLEET.L3: the pasted-image strip above the composer: a thumbnail with an x each, cleared on send/stage. Each
 *  thumb and its x are one joined control (the x sits on the thumb's corner on purpose). Rewritten only when the
 *  images change (a surface repaints on a timer, and a rewrite would reload every thumb under the pointer). */
export function paintAttachStrip(strip: HTMLElement, images: readonly LaneImage[]): void {
  strip.hidden = images.length === 0;
  const html = images
    .map((im, i) => `<span class="fleet-attach-item" data-joined><img class="fleet-thumb" src="data:${esc(im.mimeType)};base64,${esc(im.data)}" alt="pasted image ${i + 1}" /><button class="fleet-attach-x" type="button" data-attach-x="${i}" data-tip="Remove this image" aria-label="Remove pasted image ${i + 1}">${icon("close", 9)}</button></span>`)
    .join("");
  if (stripHtml.get(strip) !== html) { strip.innerHTML = html; stripHtml.set(strip, html); }
}

/** P-FLEET.L3: read image files into a lane prompt's images (`images()` is read when each file has loaded, so a
 *  send that emptied them meanwhile is respected). Each one passes lane_view_model.acceptLaneImage (the composer's
 *  type, count and byte limits) or is refused with its reason through `refused`. */
export function readLaneImages(files: readonly File[], images: () => LaneImage[], added: () => void, refused: (reason: string) => void): void {
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = () => {
      const v = acceptLaneImage(images(), String(reader.result ?? ""));
      if (!v.ok) { refused(v.reason); return; }
      images().push(v.image);
      added();
    };
    reader.readAsDataURL(file);
  }
}

/** A lane composer grows with its text up to `cap` px (1-2 rows on a Fleet card). */
export function autosizeLaneInput(t: HTMLTextAreaElement, cap: number): void {
  t.style.height = "auto";
  t.style.height = `${Math.min(cap, t.scrollHeight)}px`;
}
