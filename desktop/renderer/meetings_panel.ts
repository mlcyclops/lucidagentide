// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/meetings_panel.ts - P-MEET.1: the PURE builders behind the Meetings fly-out.
//
// The sandbox_panel.ts / skills_dir.ts convention: a view object in, HTML out, no DOM and no fetch,
// so every state this panel can be in (dormant, unpaired, locked vault, empty, populated, selected)
// is provable headlessly with bun test.
//
// SECURITY POSTURE: a meeting title, note, decision or action item is text a MICROPHONE captured
// from a room. It is untrusted data, never markup (invariant #5), so every interpolation here goes
// through esc(). The panel renders what the Hub sends and stores nothing.
//
// LOCKED IS NOT EMPTY: when the Hub's vault is locked the rows are honest filename-derived metadata.
// Painting that as "no meetings" would be a lie about the user's own data, so the locked state gets
// its own notice and the rows stay.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import type { MeetingRow, MeetingDetail, TodoRow, UpcomingEvent } from "../meetings_hub.ts";

/** Everything the list pane paints. Mirrors MeetingsView plus the renderer-owned search text. */
export interface MeetingsPanelView {
  installed: boolean;
  paired: boolean;
  locked: boolean;
  rows: MeetingRow[];
  total: number;
  openTodos: TodoRow[];
  upcoming: UpcomingEvent | null;
  error: string | null;
  query: string;
  selected: string | null;
}

/** The Hub's dashboard origin. The ONE recording-side affordance the proposal allows the IDE is a
 *  deep link to that window - no start/stop controls ever live here. */
export const HUB_DASHBOARD_URL = "http://127.0.0.1:5123/";

/** Repaint guard (the skills_dir.ts idiom): cheap identity of what is actually on screen, so a poll
 *  that returns the same meetings does not blow away the user's scroll position or selection. */
export function meetingsSig(v: MeetingsPanelView): string {
  return [
    v.installed ? "i" : "-", v.paired ? "p" : "-", v.locked ? "l" : "-", v.error ?? "",
    v.query, v.selected ?? "", v.total, v.upcoming?.subject ?? "",
    v.openTodos.map((t) => `${t.id}${t.done ? "1" : "0"}`).join(","),
    v.rows.map((r) => `${r.filename}|${r.title}|${r.date}|${r.app}|${r.todos}`).join(","),
  ].join("~");
}

/** Body lines of one `## Heading` section of the Hub's notes markdown. Mirrors the Hub's own
 *  premeeting._section_lines: heading case, `#` level and a trailing colon are all tolerated, and a
 *  heading line carries structure only so it is never part of the body. */
function sectionLines(notes: string, heading: string): string[] {
  const wanted = heading.trim().toLowerCase();
  const out: string[] = [];
  let inSection = false;
  for (const line of (notes || "").split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("#")) {
      inSection = stripped.replace(/^#+/, "").trim().replace(/:$/, "").trim().toLowerCase() === wanted;
      continue;
    }
    if (inSection) out.push(line);
  }
  return out;
}

/** The decisions the Hub recorded for a meeting, as plain strings (bullet markers removed). */
export function decisionsFromNotes(notes: string): string[] {
  return sectionLines(notes, "Decisions")
    .map((l) => l.trim().replace(/^[-*]\s*/, "").trim())
    .filter((l) => l.length > 0);
}

/** The meeting's one-paragraph summary, or "" when the extractor produced none. */
export function summaryFromNotes(notes: string): string {
  return sectionLines(notes, "Summary").join("\n").trim();
}

/** One action item as the detail pane shows it. An item the Hub still lists as OPEN carries its
 *  content-addressed id (so it can be marked done); one that has dropped out of the open list is
 *  already done and has no id to act on. */
export interface DetailTodo { text: string; id: string | null; done: boolean }

export function detailTodos(meeting: MeetingDetail, openTodos: TodoRow[]): DetailTodo[] {
  const openHere = new Map<string, TodoRow>();
  for (const t of openTodos) if (t.meetingFile === meeting.filename) openHere.set(t.todo.trim(), t);
  return meeting.todos.map((text) => {
    const open = openHere.get(text.trim());
    return { text, id: open?.id ?? null, done: !open };
  });
}

function rowHtml(r: MeetingRow, selected: boolean): string {
  const todos = r.todos > 0 ? `<span class="meet-chip">${r.todos} action${r.todos === 1 ? "" : "s"}</span>` : "";
  const dur = r.duration ? `<span class="meet-chip">${esc(r.duration)}</span>` : "";
  const video = r.hasVideo ? `<span class="meet-chip">${icon("eye", 10)} video</span>` : "";
  return `<button type="button" class="meet-row${selected ? " on" : ""}" data-meet-open="${esc(r.filename)}"
      title="${esc(r.title)}">
    <span class="meet-row-title">${esc(r.title)}</span>
    <span class="meet-row-meta">
      <span class="meet-chip">${esc(r.date.slice(0, 10) || r.date)}</span>
      <span class="meet-chip">${esc(r.app)}</span>${dur}${todos}${video}
    </span>
  </button>`;
}

/** The "brief me on my next meeting" row. Present only when the Hub reports an upcoming event. */
function upcomingHtml(ev: UpcomingEvent | null): string {
  if (!ev) return "";
  const when = ev.start ? `<span class="meet-chip">${esc(ev.start.slice(0, 16).replace("T", " "))}</span>` : "";
  return `<div class="meet-upcoming">
    <div class="meet-upcoming-hd">${icon("clock", 13)} Coming up</div>
    <div class="meet-upcoming-title">${esc(ev.subject)}</div>
    <div class="meet-row-meta">${when}</div>
    <a class="btn-mini" href="${HUB_DASHBOARD_URL}" target="_blank" rel="noreferrer"
       title="Open the Meeting Hub window for the full pre-meeting brief">Brief me in the Hub</a>
  </div>`;
}

/** The list pane. Every non-populated state resolves to exactly ONE honest notice, never an error
 *  cascade: not installed, not paired, locked, refused, or genuinely empty. */
export function meetingsPanelHtml(v: MeetingsPanelView): string {
  if (!v.installed) {
    // Dormant. One info row, no retry, no stack trace: the Hub is a separate product and not
    // having it installed is a normal state, not a failure.
    return `<div class="set-note">${icon("info", 13)}
      <span><b>Install Lucid Meeting Hub</b> to see your meetings here. LUCID reads notes, decisions
      and action items from a Hub running on this machine; nothing is stored in the IDE, and there is
      no cloud path. Once the Hub is running, reopen this panel to pair.</span></div>`;
  }
  if (!v.paired) {
    return `<div class="set-note">${icon("info", 13)}
      <span><b>Pair with your Meeting Hub.</b> Open the Hub dashboard, mint a pairing code, and enter
      the six digits below. The IDE gets a read-only token, stored encrypted by your operating system;
      you can revoke it from the Hub at any time.</span></div>
    <div class="meet-pair">
      <input id="meetPairCode" class="meet-pair-code" type="text" inputmode="numeric" maxlength="6"
             placeholder="000000" autocomplete="off" spellcheck="false" aria-label="Six-digit pairing code" />
      <button class="btn-mini ok" id="meetPairGo" type="button">Pair</button>
      <a class="btn-mini" href="${HUB_DASHBOARD_URL}" target="_blank" rel="noreferrer">Open the Hub</a>
    </div>`;
  }

  const notices: string[] = [];
  if (v.locked) {
    notices.push(`<div class="set-note">${icon("info", 13)}
      <span><b>The Hub vault is locked.</b> These rows are titles and dates only - notes, decisions and
      action items stay encrypted until you unlock the Hub. This is not an empty library.</span></div>`);
  }
  if (v.error) {
    notices.push(`<div class="set-note">${icon("info", 13)}
      <span>The Meeting Hub refused that request: ${esc(v.error)}</span></div>`);
  }

  let body: string;
  if (v.rows.length) {
    body = v.rows.map((r) => rowHtml(r, r.filename === v.selected)).join("");
  } else if (v.query.trim()) {
    body = `<div class="meet-empty">No meeting matches "${esc(v.query.trim())}".${v.locked ? " Unlock the Hub to search inside your notes." : ""}</div>`;
  } else {
    body = `<div class="meet-empty">No meetings recorded yet. The Hub records them; this panel reads them back.</div>`;
  }

  const more = v.total > v.rows.length
    ? `<div class="meet-more">Showing ${v.rows.length} of ${v.total}. Narrow the search to find an older meeting.</div>`
    : "";
  return notices.join("") + upcomingHtml(v.upcoming) + `<div class="meet-list">${body}</div>` + more;
}

/** The detail pane for one meeting. `null` (nothing selected) renders a prompt rather than blank
 *  space; a locked Hub says so instead of pretending the meeting has no content. */
export function meetingDetailHtml(meeting: MeetingDetail | null, openTodos: TodoRow[], opts?: { locked?: boolean; error?: string | null }): string {
  if (opts?.error) {
    return `<div class="set-note">${icon("info", 13)}<span>${esc(opts.error)}</span></div>`;
  }
  if (opts?.locked) {
    return `<div class="set-note">${icon("info", 13)}
      <span><b>Locked.</b> Unlock the Meeting Hub to read this meeting's notes, decisions and action items.</span></div>`;
  }
  if (!meeting) return `<div class="meet-empty">Pick a meeting to see its notes, decisions and open action items.</div>`;

  const summary = summaryFromNotes(meeting.notes);
  const decisions = decisionsFromNotes(meeting.notes);
  const todos = detailTodos(meeting, openTodos);

  const summaryHtml = summary
    ? `<div class="meet-sec"><div class="meet-sec-hd">Summary</div><p class="meet-prose">${esc(summary)}</p></div>`
    : "";
  const decisionsHtml = decisions.length
    ? `<div class="meet-sec"><div class="meet-sec-hd">Decisions</div><ul class="meet-ul">${decisions.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div>`
    : "";
  const todosHtml = todos.length
    ? `<div class="meet-sec"><div class="meet-sec-hd">Action items</div>${todos.map(todoHtml).join("")}</div>`
    : "";
  const nothing = !summaryHtml && !decisionsHtml && !todosHtml
    ? `<div class="meet-empty">The Hub extracted no notes for this meeting.</div>`
    : "";

  return `<div class="meet-detail-hd">
      <div class="meet-detail-title">${esc(meeting.title)}</div>
      <div class="meet-row-meta">
        <span class="meet-chip">${esc(meeting.start.slice(0, 16).replace("T", " "))}</span>
        <span class="meet-chip">${esc(meeting.app)}</span>
      </div>
    </div>${summaryHtml}${decisionsHtml}${todosHtml}${nothing}`;
}

function todoHtml(t: DetailTodo): string {
  // An already-done item has no open-ledger id, so there is nothing to toggle: it renders as a
  // static line rather than a button that would silently do nothing.
  if (!t.id) return `<div class="meet-todo done"><span class="meet-todo-mark">${icon("check", 12)}</span><span class="meet-todo-text">${esc(t.text)}</span></div>`;
  return `<button type="button" class="meet-todo" data-meet-todo="${esc(t.id)}" aria-pressed="false"
      title="Mark done in the Meeting Hub">
    <span class="meet-todo-mark"></span><span class="meet-todo-text">${esc(t.text)}</span>
  </button>`;
}
