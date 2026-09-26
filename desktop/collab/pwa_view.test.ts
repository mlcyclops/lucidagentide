// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/pwa_view.test.ts - P-REMOTE.3 (ADR-0226/0227): the phone viewer core.
//
// The reducer folds the host's ChatEvent stream the way the phone renders it (streaming answer, thinking,
// tool/subagent chips, blocks), reconciles the lossy stream on `done`, and ESCAPES every host-authored string
// (the load-bearing safety property: the phone must never turn host/echoed content into markup).

import { describe, expect, it } from "bun:test";
import { foldEvent, renderItem, renderTranscript, renderHeader, renderLaneCard, renderProcessRow, statusLabel, escapeHtml, thinkingGist, type ViewItem } from "./pwa_view.ts";
import type { ChatEvent } from "../renderer/chat_events.ts";
import type { GuestView } from "./guest.ts";
import type { CollabTranscriptTurn } from "./frames.ts";

const fold = (events: ChatEvent[]): ViewItem[] => events.reduce(foldEvent, [] as ViewItem[]);

describe("pwa_view: foldEvent reducer", () => {
  it("coalesces token deltas into one streaming answer, then finalizes on done", () => {
    const items = fold([{ type: "token", text: "Hel" }, { type: "token", text: "lo" }, { type: "done", text: "Hello, world" }]);
    expect(items).toEqual([{ kind: "answer", text: "Hello, world", streaming: false }]);
  });

  it("keeps the streamed text when done carries no authoritative text", () => {
    const items = fold([{ type: "token", text: "abc" }, { type: "done" }]);
    expect(items).toEqual([{ kind: "answer", text: "abc", streaming: false }]);
  });

  it("separates thinking from the answer and coalesces thinking deltas", () => {
    const items = fold([{ type: "thinking", text: "hm" }, { type: "thinking", text: "mm" }, { type: "token", text: "ok" }]);
    expect(items).toEqual([{ kind: "thinking", text: "hmmm" }, { kind: "answer", text: "ok", streaming: true }]);
  });

  it("folds a preview-snapshot into a preview item with a stable id; renders it hydration-safe (P-PREVIEW-PWA.1)", () => {
    const items = fold([
      { type: "preview-snapshot", image: "data:image/png;base64,AAA", label: "Home screen" },
      { type: "token", text: "hi" },
      { type: "preview-snapshot", image: "data:image/png;base64,BBB" },
    ]);
    expect(items[0]).toEqual({ kind: "preview", image: "data:image/png;base64,AAA", label: "Home screen", id: "shot-0" });
    expect(items[2]).toEqual({ kind: "preview", image: "data:image/png;base64,BBB", id: "shot-1" });
    // the data URL is NEVER inlined into the HTML (hydrated as an <img> property); the label is escaped.
    const html = renderItem({ kind: "preview", image: "data:image/png;base64,SECRETPIXELS", label: "<b>x</b>", id: "shot-0" });
    expect(html).toContain('data-shot="shot-0"');
    expect(html).toContain("cu-shot-img");
    expect(html).not.toContain("SECRETPIXELS");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("renders tool, subagent, and block as their own items", () => {
    const items = fold([
      { type: "tool", name: "read", detail: "src/x.ts" },
      { type: "subagent", id: "s1", agent: "explore", title: "map code", assignments: ["a", "b"] },
      { type: "block", tool: "bash", reason: "hidden vector", severity: "high", findings: "1" },
    ]);
    expect(items[0]).toEqual({ kind: "tool", name: "read", detail: "src/x.ts" });
    expect(items[1]).toEqual({ kind: "subagent", agent: "explore", title: "map code", count: 2 });
    expect(items[2]).toEqual({ kind: "block", reason: "hidden vector", severity: "high" });
  });

  it("starts a new answer after a tool interrupts the stream", () => {
    const items = fold([{ type: "token", text: "a" }, { type: "tool", name: "read", detail: "" }, { type: "token", text: "b" }]);
    expect(items.filter((i) => i.kind === "answer")).toHaveLength(2);
  });

  it("surfaces a no-response, ignores desktop-only events", () => {
    const items = fold([
      { type: "no-response", model: "gov-x" },
      { type: "preview-available", path: "/x.html" },
      { type: "usage", used: 1, size: 2, cost: 3 },
    ]);
    expect(items).toEqual([{ kind: "note", text: "The model (gov-x) returned nothing." }]);
  });
});

describe("pwa_view: readable Thinking (live-open + gist + stable identity)", () => {
  it("thinkingGist takes the LAST non-empty line, collapses whitespace, and clips long lines", () => {
    expect(thinkingGist("first thought\n\nsecond   thought  ")).toBe("second thought");
    expect(thinkingGist("")).toBe("");
    expect(thinkingGist("   \n  \n")).toBe("");
    const long = "x".repeat(100);
    const g = thinkingGist(long);
    expect(g.length).toBeLessThanOrEqual(64);
    expect(g.endsWith("…")).toBe(true);
  });

  it("a TRAILING thinking item renders OPEN (live reasoning); it renders closed once something follows", () => {
    const think: ViewItem = { kind: "thinking", text: "weighing options" };
    expect(renderTranscript([], [think])).toContain("<details class=\"msg thinking\" open");
    const after = renderTranscript([], [think, { kind: "answer", text: "ok", streaming: true }]);
    expect(after).not.toContain("<details class=\"msg thinking\" open");
    expect(after).toContain("data-think=\"0\"");
  });

  it("each thinking block carries its item index in data-think (open-state keying across repaints)", () => {
    const html = renderTranscript([], [
      { kind: "thinking", text: "a" },
      { kind: "tool", name: "read", detail: "f.ts" },
      { kind: "thinking", text: "b" },
    ]);
    expect(html).toContain("data-think=\"0\"");
    expect(html).toContain("data-think=\"2\"");
  });

  it("the summary shows an ESCAPED gist of the freshest line; blank thinking gets no gist span", () => {
    const html = renderItem({ kind: "thinking", text: "safe start\n<img src=x onerror=alert(1)>" }, 0, false);
    expect(html).toContain("class=\"gist\"");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(renderItem({ kind: "thinking", text: "  \n " }, 0, false)).not.toContain("class=\"gist\"");
  });
});

describe("pwa_view: rendering escapes ALL host-authored text", () => {
  it("escapes a hostile answer, thinking, tool detail, subagent title, and block reason", () => {
    const hostile = `<img src=x onerror=alert(1)>`;
    for (const item of [
      { kind: "answer", text: hostile, streaming: false },
      { kind: "thinking", text: hostile },
      { kind: "tool", name: hostile, detail: hostile },
      { kind: "subagent", agent: hostile, title: hostile, count: 1 },
      { kind: "block", reason: hostile, severity: "high" },
      { kind: "note", text: hostile },
    ] as ViewItem[]) {
      const html = renderItem(item);
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;img");
    }
  });

  it("escapes prior transcript turns and the header", () => {
    const html = renderTranscript([{ role: "user", text: "<script>x</script>" }], []);
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
    const hdr = renderHeader({ sessionId: "s", title: "<b>t</b>", model: "<m>", hostName: "<h>", startedAt: 0 });
    expect(hdr).not.toContain("<b>t</b>");
    expect(hdr).toContain("&lt;b&gt;");
  });

  it("escapeHtml covers all five significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("pwa_view: status label", () => {
  const base: GuestView = { phase: "connecting", header: null, transcript: [], participants: [], model: "", contextPct: null, readOnly: true, note: null };
  it("maps phase + read-only to a label and tone; a note wins", () => {
    expect(statusLabel({ ...base, phase: "connecting" })).toEqual({ text: "Connecting…", tone: "wait" });
    expect(statusLabel({ ...base, phase: "live", readOnly: true }).text).toContain("view only");
    expect(statusLabel({ ...base, phase: "live", readOnly: false }).text).toContain("drive");
    expect(statusLabel({ ...base, phase: "live", readOnly: false }).tone).toBe("live");
    expect(statusLabel({ ...base, phase: "ended", note: "host ended the session" })).toEqual({ text: "host ended the session", tone: "ended" });
  });
});

// ── P-PWA-FLEET.1: fleet lanes + processes (replace-in-place fold + escaped cards) ──────────────────────

const LANE = { id: "lane-1", name: "worker-a", status: "working", cwd: "project-alpha", turns: 3, lastActivityAt: 111 };

describe("pwa_view: fleet-status / process-list fold (replace-in-place)", () => {
  it("a fleet-status REPLACES the prior lanes item in place - never one item per poll, never a split stream", () => {
    let items = fold([{ type: "token", text: "hi" }, { type: "fleet-status", lanes: [LANE] }]);
    // the FIRST insert lands BEFORE the trailing live stream, so the next delta keeps coalescing
    const at = items.findIndex((i) => i.kind === "fleet-lanes");
    expect(at).toBe(0);
    items = foldEvent(items, { type: "token", text: "!" });
    items = foldEvent(items, { type: "fleet-status", lanes: [{ ...LANE, status: "done", turns: 4 }] });
    items = foldEvent(items, { type: "fleet-status", lanes: [{ ...LANE, status: "stopped", turns: 4 }] });
    const lanes = items.filter((i) => i.kind === "fleet-lanes");
    expect(lanes).toHaveLength(1); // only the LATEST snapshot survives
    expect(items.findIndex((i) => i.kind === "fleet-lanes")).toBe(at); // stable position across polls
    expect(lanes[0]).toEqual({ kind: "fleet-lanes", lanes: [{ ...LANE, status: "stopped", turns: 4 }] });
    expect(items.filter((i) => i.kind === "answer")).toEqual([{ kind: "answer", text: "hi!", streaming: true }]); // ONE unbroken bubble
  });

  it("a process-list folds the same way", () => {
    const p1 = { id: "master", kind: "master-turn" as const, label: "Master session", status: "working", startedAt: 1, lastActivityAt: 2, detail: "streaming" };
    let items = fold([{ type: "process-list", processes: [p1] }, { type: "token", text: "x" }]);
    items = foldEvent(items, { type: "process-list", processes: [{ ...p1, status: "idle" }] });
    const procs = items.filter((i) => i.kind === "processes");
    expect(procs).toHaveLength(1);
    expect(items.findIndex((i) => i.kind === "processes")).toBe(0); // replaced in place, still ahead of the token
    expect(procs[0]).toEqual({ kind: "processes", processes: [{ ...p1, status: "idle" }] });
  });
});

describe("pwa_view: fleet lane cards + process rows", () => {
  it("escapes hostile lane names, ids, cwd, and approval text (host-authored, never markup)", () => {
    const hostile = `<img src=x onerror=alert(1)>`;
    const html = renderLaneCard({ id: `"?><script>a</script>`, name: hostile, status: "working", cwd: hostile, turns: 1, lastActivityAt: 0, pendingApproval: { summary: hostile, kind: hostile } });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders approval buttons ONLY with a pendingApproval", () => {
    const idle = renderLaneCard(LANE);
    expect(idle).not.toContain("data-fleet-answer");
    const pending = renderLaneCard({ ...LANE, status: "needs-approval", pendingApproval: { summary: "run tests", kind: "exec" } });
    expect(pending).toContain('data-fleet-answer="once"');
    expect(pending).toContain('data-fleet-answer="session"');
    expect(pending).toContain('data-fleet-answer="deny"');
    expect(pending).toContain("run tests");
  });

  // P-PWA-FLEET.2: the card carries its OWN composer, so a lane is driven in its lane instead of through
  // the master input. The four actions here are EXACTLY what CollabGuest can do for a lane - anything else
  // in this markup would be a control that cannot work.
  it("gives every lane its own composer, wired only to what the guest can actually do", () => {
    const html = renderLaneCard(LANE);
    expect(html).toContain(`data-lane-input="${LANE.id}"`); // its own text input, not the master's
    for (const act of ["send", "push", "checkin", "stop"]) expect(html).toContain(`data-fleet-act="${act}"`);
    // the retired indirection: no "Prompt" button staging a target on the master composer
    expect(html).not.toContain('data-fleet-act="prompt"');
    // and nothing the lane protocol cannot honour
    for (const dead of ["spawn", "model", "retry", "respawn", "queue"]) expect(html).not.toContain(`data-fleet-act="${dead}"`);
  });

  it("flips the lane's send label + Push visibility on whether the lane is busy", () => {
    const working = renderLaneCard({ ...LANE, status: "working" });
    expect(working).toContain(">Queue</button>"); // mid-turn: the host stages it
    expect(working).not.toContain("hidden>Push</button>"); // and Push is reachable
    const done = renderLaneCard({ ...LANE, status: "done" });
    expect(done).toContain(">Send</button>");
    expect(done).toContain(" hidden>Push</button>"); // idle lane: nothing to interject
  });

  // The colour PARITY seam: the card's `lane-<status>` class is what the phone CSS keys the desktop's
  // fleet palette off, so losing it silently reverts the phone to its own invented colours.
  it("carries the lane-<status> class the desktop palette is keyed on, for every state", () => {
    for (const status of ["starting", "working", "awaiting-input", "needs-approval", "done", "error", "stopped"]) {
      const html = renderLaneCard({ ...LANE, status });
      expect(html).toContain(`class="lane-card lane-${status}"`);
      expect(html).toContain(`data-status="${status}"`);
    }
  });

  it("shows the lane's cwd BASENAME, turn count, and status dot; renderItem wraps the card list", () => {
    const html = renderLaneCard({ ...LANE, cwd: "C:\\work\\repos\\proj" });
    expect(html).toContain(">proj</span>");
    expect(html).toContain("3 turns");
    expect(html).toContain('data-status="working"');
    const wrapped = renderItem({ kind: "fleet-lanes", lanes: [LANE] });
    expect(wrapped).toContain("fleet-lanes");
    expect(wrapped).toContain("worker-a");
  });

  it("escapes process rows and renders kind + label + status", () => {
    const hostile = `<b onmouseover=x>`;
    const html = renderProcessRow({ id: "p1", kind: "lane", label: hostile, status: hostile, startedAt: null, lastActivityAt: null, detail: hostile });
    expect(html).not.toContain("<b ");
    expect(html).toContain("&lt;b");
    expect(html).toContain("proc-kind");
    expect(html).toContain("proc-label");
    expect(html).toContain("proc-status");
  });
});

// ── P-PWA-FOCUS.2: the unseen boundary (`newFrom`) in the COMBINED prior+items stream ───────────────────
//
// The phone SCROLLS to this marker after a cross-screen-lock sync, so its POSITION is load-bearing: a
// marker one entry off silently parks the reader on something they already read, or skips what they missed.
// These tests pin the exact rendered bytes rather than a substring, and they pin the two-argument output
// against a reference reproduction of the pre-change renderer.

const MARK = `<div class="sync-mark" data-sync-mark><span class="sync-mark-l">new since you looked away</span></div>`;

/** The pre-change renderer, rebuilt from the two primitives its body used. Each combined-stream entry, in
 *  order: `prior` turns first, then the folded items (trailing thinking rendered live-open). */
const entries = (prior: CollabTranscriptTurn[], items: ViewItem[]): string[] => [
  ...prior.map((t) => `<div class="msg ${t.role === "user" ? "user" : "answer"}">${escapeHtml(t.text)}</div>`),
  ...items.map((it, i) => renderItem(it, i, it.kind === "thinking" && i === items.length - 1)),
];

/** What the render MUST be byte-for-byte with the marker at combined index `at`. */
const withMark = (prior: CollabTranscriptTurn[], items: ViewItem[], at: number): string => {
  const e = entries(prior, items);
  e.splice(at, 0, MARK);
  return e.join("");
};

const markCount = (html: string): number => html.split(MARK).length - 1;

const PRIOR: CollabTranscriptTurn[] = [
  { role: "user", text: "turn zero" },
  { role: "assistant", text: "turn one" },
  { role: "user", text: "turn two" },
];
const ITEMS: ViewItem[] = [
  { kind: "answer", text: "answer three", streaming: false },
  { kind: "tool", name: "read", detail: "four.ts" },
  { kind: "note", text: "note five" },
];
const TOTAL = PRIOR.length + ITEMS.length; // 6

describe("pwa_view: renderTranscript unseen boundary", () => {
  it("draws the marker immediately before the boundary entry when it falls inside `prior`", () => {
    expect(renderTranscript(PRIOR, ITEMS, 1)).toBe(withMark(PRIOR, ITEMS, 1));
    expect(renderTranscript(PRIOR, ITEMS, 2)).toBe(withMark(PRIOR, ITEMS, 2));
    // and it is the SECOND prior bubble that follows it, not the first or third
    const html = renderTranscript(PRIOR, ITEMS, 1);
    expect(html).toContain(`${MARK}<div class="msg answer">turn one</div>`);
    expect(html.indexOf("turn zero")).toBeLessThan(html.indexOf(MARK));
  });

  it("draws the marker immediately before the boundary entry when it falls inside `items`", () => {
    expect(renderTranscript(PRIOR, ITEMS, 4)).toBe(withMark(PRIOR, ITEMS, 4));
    expect(renderTranscript(PRIOR, ITEMS, 5)).toBe(withMark(PRIOR, ITEMS, 5));
    // combined index 4 is items[1] (the tool chip), which still renders with ITS OWN item index of 1
    expect(renderTranscript(PRIOR, ITEMS, 4)).toContain(MARK + renderItem(ITEMS[1]!, 1, false));
  });

  it("lands exactly on the prior/items seam", () => {
    const html = renderTranscript(PRIOR, ITEMS, PRIOR.length);
    expect(html).toBe(withMark(PRIOR, ITEMS, PRIOR.length));
    expect(html).toContain(`<div class="msg user">turn two</div>${MARK}${renderItem(ITEMS[0]!, 0, false)}`);
  });

  it("threads the index through BOTH loops when one side is empty", () => {
    expect(renderTranscript([], ITEMS, 2)).toBe(withMark([], ITEMS, 2));
    expect(renderTranscript(PRIOR, [], 1)).toBe(withMark(PRIOR, [], 1));
    // an empty side has no in-range boundary of its own
    expect(markCount(renderTranscript([], ITEMS, 3))).toBe(0); // == total
    expect(markCount(renderTranscript(PRIOR, [], 3))).toBe(0);
  });

  it("emits NO marker for out-of-range, non-integer, or non-finite boundaries", () => {
    const plain = renderTranscript(PRIOR, ITEMS);
    for (const bad of [0, -1, -7, TOTAL, TOTAL + 5, 1.5, 2.0001, NaN, Infinity, -Infinity]) {
      const html = renderTranscript(PRIOR, ITEMS, bad);
      expect(markCount(html)).toBe(0);
      expect(html).toBe(plain); // and nothing else shifted either
    }
  });

  it("emits at most ONE marker, even when entries are byte-identical to each other", () => {
    for (let n = 1; n < TOTAL; n++) expect(markCount(renderTranscript(PRIOR, ITEMS, n))).toBe(1);
    // duplicate content would re-fire any content-matching implementation; the marker is a POSITION
    const dupPrior: CollabTranscriptTurn[] = [
      { role: "user", text: "same" },
      { role: "user", text: "same" },
      { role: "user", text: "same" },
    ];
    const dupItems: ViewItem[] = [
      { kind: "note", text: "same" },
      { kind: "note", text: "same" },
    ];
    for (let n = 1; n < dupPrior.length + dupItems.length; n++) {
      expect(markCount(renderTranscript(dupPrior, dupItems, n))).toBe(1);
      expect(renderTranscript(dupPrior, dupItems, n)).toBe(withMark(dupPrior, dupItems, n));
    }
  });

  it("renders byte-identically to the pre-change renderer when the third argument is omitted", () => {
    const before = entries(PRIOR, ITEMS).join("");
    const twoArg = renderTranscript(PRIOR, ITEMS);
    expect(twoArg).toBe(before);
    expect(renderTranscript(PRIOR, ITEMS, undefined)).toBe(twoArg);
    // including the live-open trailing thinking block, whose open state depends on the item index
    const think: ViewItem[] = [{ kind: "answer", text: "a", streaming: false }, { kind: "thinking", text: "live" }];
    expect(renderTranscript(PRIOR, think)).toBe(entries(PRIOR, think).join(""));
    expect(renderTranscript(PRIOR, think)).toContain("<details class=\"msg thinking\" open");
    expect(renderTranscript([], [])).toBe("");
    expect(renderTranscript([], [], 0)).toBe("");
  });

  it("keeps the trailing thinking block live-open when a marker is present", () => {
    const think: ViewItem[] = [{ kind: "tool", name: "read", detail: "f.ts" }, { kind: "thinking", text: "live" }];
    const html = renderTranscript(PRIOR, think, 3);
    expect(html).toBe(withMark(PRIOR, think, 3));
    expect(html).toContain("<details class=\"msg thinking\" open");
    expect(html).toContain("data-think=\"1\"");
  });
});
