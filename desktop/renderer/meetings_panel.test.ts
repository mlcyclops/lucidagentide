// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/meetings_panel.test.ts - P-MEET.1: the PURE Meetings builders.
//
// Over-tests the two things that are load-bearing rather than cosmetic:
//   1. A LOCKED Meeting Hub must never be painted as an empty library. That would be the panel lying
//      about the user's own data, and it is the exact failure the Hub's locked shapes exist to avoid.
//   2. Every byte of meeting text is untrusted room audio, so it is escaped, never markup
//      (AGENTS.md invariant #5).

import { describe, expect, test } from "bun:test";
import {
  decisionsFromNotes, detailTodos, meetingDetailHtml, meetingsPanelHtml, meetingsSig, summaryFromNotes,
  type MeetingsPanelView,
} from "./meetings_panel.ts";
import type { MeetingDetail, MeetingRow, TodoRow } from "../meetings_hub.ts";

const row = (over: Partial<MeetingRow> = {}): MeetingRow => ({
  filename: "2026-09-18_14-05_zoom.json.enc", date: "2026-09-18 14:05", app: "zoom",
  title: "Pricing sync", duration: "42m", todos: 2, hasVideo: false, ...over,
});

const view = (over: Partial<MeetingsPanelView> = {}): MeetingsPanelView => ({
  installed: true, paired: true, locked: false, rows: [row()], total: 1,
  openTodos: [], upcoming: null, error: null, query: "", selected: null,
  dashboardUrl: "http://127.0.0.1:6123/", // a NON-default port: links must follow the engine's origin
  ...over,
});

const detail = (over: Partial<MeetingDetail> = {}): MeetingDetail => ({
  filename: "2026-09-18_14-05_zoom.json.enc", app: "zoom", title: "Pricing sync",
  start: "2026-09-18T14:05:00", end: "2026-09-18T14:47:00",
  notes: "## Summary\nWe agreed the new tiering.\n\n## Decisions\n- Ship tier 3 in October\n- Drop the annual discount\n",
  todos: ["Nick to draft the pricing page"], hasVideo: false, ...over,
});

const todo = (over: Partial<TodoRow> = {}): TodoRow => ({
  id: "a".repeat(40), todo: "Nick to draft the pricing page", meetingDate: "2026-09-18 14:05",
  app: "zoom", meetingFile: "2026-09-18_14-05_zoom.json.enc", done: false, ...over,
});

describe("dormant + unpaired - one honest row, never an error cascade", () => {
  test("no Hub running renders the install row and NO meeting list", () => {
    const h = meetingsPanelHtml(view({ installed: false, paired: false, rows: [], total: 0 }));
    expect(h).toContain("Install Lucid Meeting Hub");
    expect(h).not.toContain("meet-list");
    expect(h).not.toContain("No meetings recorded yet"); // absent Hub is not an empty library either
  });
  test("a refused Hub address says so instead of advising an install", () => {
    const h = meetingsPanelHtml(view({ installed: false, paired: false, rows: [], total: 0, dashboardUrl: null, error: "LUCID_MEETING_HUB_URL must be http://" }));
    expect(h).toContain("LUCID_MEETING_HUB_URL must be http://");
    expect(h).not.toContain("Install Lucid Meeting Hub");
  });
  test("Hub running but unpaired offers the 6-digit code, not an error", () => {
    const h = meetingsPanelHtml(view({ paired: false, rows: [], total: 0 }));
    expect(h).toContain("meetPairCode");
    expect(h).toContain("meetPairGo");
    expect(h).not.toContain("meet-list");
  });
  test("the pairing consent never calls the token read-only: it can also mark action items done", () => {
    const h = meetingsPanelHtml(view({ paired: false, rows: [], total: 0 }));
    expect(h).not.toMatch(/read-only/i);
    expect(h).toContain("action items done");
  });
  test("'Open the Hub' follows the configured port, and is absent when there is no safe origin", () => {
    expect(meetingsPanelHtml(view({ paired: false, rows: [], total: 0 }))).toContain(`href="http://127.0.0.1:6123/"`);
    expect(meetingsPanelHtml(view({ paired: false, rows: [], total: 0 }))).not.toContain("5123");
    expect(meetingsPanelHtml(view({ paired: false, rows: [], total: 0, dashboardUrl: null }))).not.toContain("<a ");
  });
});

describe("locked vault - metadata rows stay, and say why", () => {
  test("locked renders the rows AND the locked notice, never 'no meetings'", () => {
    const h = meetingsPanelHtml(view({ locked: true, rows: [row({ title: "Zoom Meeting", duration: null, todos: 0 })] }));
    expect(h).toContain("The Hub vault is locked");
    expect(h).toContain("Zoom Meeting");
    expect(h).not.toContain("No meetings recorded yet");
  });
  test("a locked search that matched nothing explains the lock rather than claiming no match exists", () => {
    const h = meetingsPanelHtml(view({ locked: true, rows: [], total: 0, query: "pricing" }));
    expect(h).toContain("Unlock the Hub to search inside your notes");
  });
  test("an unlocked, genuinely empty library says so plainly", () => {
    const h = meetingsPanelHtml(view({ rows: [], total: 0 }));
    expect(h).toContain("No meetings recorded yet");
    expect(h).not.toContain("locked");
  });
});

describe("meeting text is data, never markup", () => {
  test("a hostile meeting title is escaped in the list", () => {
    const h = meetingsPanelHtml(view({ rows: [row({ title: `<img src=x onerror="alert(1)">` })] }));
    expect(h).not.toContain("<img src=x");
    expect(h).toContain("&lt;img src=x");
  });
  test("hostile notes, decisions and action items are escaped in the detail", () => {
    const h = meetingDetailHtml(detail({
      title: "<b>t</b>",
      notes: "## Summary\n<script>s</script>\n\n## Decisions\n- <script>d</script>\n",
      todos: ["<script>a</script>"],
    }), [todo({ todo: "<script>a</script>" })]);
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
    expect(h).not.toContain("<b>t</b>");
  });
});

describe("notes markdown - the Hub's own section shapes", () => {
  test("decisions come back without their bullet markers", () => {
    expect(decisionsFromNotes(detail().notes)).toEqual(["Ship tier 3 in October", "Drop the annual discount"]);
  });
  test("heading level, case and a trailing colon are all tolerated", () => {
    expect(decisionsFromNotes("### decisions:\n* Keep the SLA\n")).toEqual(["Keep the SLA"]);
  });
  test("a section that does not exist yields nothing, and the heading line is never content", () => {
    expect(decisionsFromNotes("## Summary\nno decisions here\n")).toEqual([]);
    expect(summaryFromNotes("## Summary\nWe agreed.\n## Decisions\n- x\n")).toBe("We agreed.");
  });
});

describe("action items - only an item the Hub still lists as open can be acted on", () => {
  test("an open item carries its ledger id; one the Hub dropped is already done", () => {
    const d = detail({ todos: ["Nick to draft the pricing page", "Mail the deck"] });
    const items = detailTodos(d, [todo()]);
    expect(items).toEqual([
      { text: "Nick to draft the pricing page", id: "a".repeat(40), status: "open" },
      { text: "Mail the deck", id: null, status: "done" },
    ]);
  });
  test("an open item from a DIFFERENT meeting never lends its id to this one", () => {
    const items = detailTodos(detail(), [todo({ meetingFile: "some-other-meeting.json.enc" })]);
    expect(items[0]!.id).toBeNull();
    expect(items[0]!.status).toBe("done");
  });
  test("when the open list could not be read, every item is UNKNOWN - never done, never actionable", () => {
    const d = detail({ todos: ["Nick to draft the pricing page", "Mail the deck"] });
    expect(detailTodos(d, null)).toEqual([
      { text: "Nick to draft the pricing page", id: null, status: "unknown" },
      { text: "Mail the deck", id: null, status: "unknown" },
    ]);
    const h = meetingDetailHtml(d, null);
    expect(h).toContain("meet-todo unknown");
    expect(h).not.toContain("meet-todo done");
    expect(h).not.toContain("data-meet-todo");
    expect(h).toContain("status is unknown");
  });
  test("the list pane flags an unread open list rather than staying silent", () => {
    expect(meetingsPanelHtml(view({ openTodos: null }))).toContain("could not be read");
    expect(meetingsPanelHtml(view())).not.toContain("could not be read");
  });
  test("a done item renders as a static line, not a button that would do nothing", () => {
    const h = meetingDetailHtml(detail(), []); // nothing open -> the meeting's item is done
    expect(h).toContain("meet-todo done");
    expect(h).not.toContain("data-meet-todo");
  });
  test("an open item renders the toggle the mark-done handler is bound to", () => {
    const h = meetingDetailHtml(detail(), [todo()]);
    expect(h).toContain(`data-meet-todo="${"a".repeat(40)}"`);
  });
});

describe("detail pane - every non-content state is explained", () => {
  test("nothing selected prompts instead of showing blank space", () => {
    expect(meetingDetailHtml(null, [])).toContain("Pick a meeting");
  });
  test("a locked detail says unlock, and never claims the meeting is empty", () => {
    const h = meetingDetailHtml(null, [], { locked: true });
    expect(h).toContain("Unlock the Meeting Hub");
    expect(h).not.toContain("Pick a meeting");
  });
  test("a refusal surfaces the Hub's own reason", () => {
    expect(meetingDetailHtml(null, [], { error: "meeting not found" })).toContain("meeting not found");
  });
  test("a meeting the extractor produced nothing for says so", () => {
    expect(meetingDetailHtml(detail({ notes: "", todos: [] }), [])).toContain("extracted no notes");
  });
});

describe("meetingsSig - repaint only on a real change", () => {
  test("an identical view shares a signature", () => {
    expect(meetingsSig(view())).toBe(meetingsSig(view()));
  });
  test("locking the Hub, a new row, and a flipped action item each change it", () => {
    expect(meetingsSig(view({ locked: true }))).not.toBe(meetingsSig(view()));
    expect(meetingsSig(view({ rows: [row(), row({ filename: "b.json.enc" })] }))).not.toBe(meetingsSig(view()));
    expect(meetingsSig(view({ openTodos: [todo()] }))).not.toBe(meetingsSig(view({ openTodos: [todo({ done: true })] })));
    expect(meetingsSig(view({ openTodos: null }))).not.toBe(meetingsSig(view({ openTodos: [] }))); // unknown -> known repaints
  });
  test("selecting a meeting changes it, so the selected row repaints", () => {
    expect(meetingsSig(view({ selected: "2026-09-18_14-05_zoom.json.enc" }))).not.toBe(meetingsSig(view()));
  });
});

describe("upcoming meeting - present only when there is one", () => {
  test("no upcoming event renders no brief row at all", () => {
    expect(meetingsPanelHtml(view())).not.toContain("meet-upcoming");
  });
  test("an upcoming event deep-links to the Hub window (the only recording-side affordance)", () => {
    const h = meetingsPanelHtml(view({ upcoming: { subject: "Board review", start: "2026-09-22T09:00:00" } }));
    expect(h).toContain("Board review");
    expect(h).toContain(`href="http://127.0.0.1:6123/"`); // the engine-validated origin, not a fixed 5123
    expect(h).not.toContain("5123");
    expect(h).toContain("Brief me in the Hub");
  });
});
