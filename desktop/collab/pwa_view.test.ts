// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/pwa_view.test.ts - P-REMOTE.3 (ADR-0226/0227): the phone viewer core.
//
// The reducer folds the host's ChatEvent stream the way the phone renders it (streaming answer, thinking,
// tool/subagent chips, blocks), reconciles the lossy stream on `done`, and ESCAPES every host-authored string
// (the load-bearing safety property: the phone must never turn host/echoed content into markup).

import { describe, expect, it } from "bun:test";
import { foldEvent, expandTurns, mergeWelcome, elapsedLabel, GAP_NOTE, renderItem, renderTranscript, renderHeader, renderLaneCard, renderProcessRow, statusLabel, escapeHtml, thinkingGist, type ViewItem } from "./pwa_view.ts";
import type { ChatEvent } from "../renderer/chat_events.ts";
import type { GuestView } from "./guest.ts";
import type { CollabTranscriptTurn, WelcomeFrame } from "./frames.ts";

// (an explicit lambda: reduce's index argument must not land in foldEvent's `seq` parameter)
const fold = (events: ChatEvent[]): ViewItem[] => events.reduce((acc, e) => foldEvent(acc, e), [] as ViewItem[]);

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
    expect(renderTranscript([think])).toContain("<details class=\"msg thinking\" open");
    const after = renderTranscript([think, { kind: "answer", text: "ok", streaming: true }]);
    expect(after).not.toContain("<details class=\"msg thinking\" open");
    expect(after).toContain("data-think=\"0\"");
  });

  it("each thinking block carries its item index in data-think (open-state keying across repaints)", () => {
    const html = renderTranscript([
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

  it("escapes replayed transcript turns and the header", () => {
    const html = renderTranscript(expandTurns([{ role: "user", text: "<script>x</script>" }]));
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

// ── P-PWA-FOCUS.2: the unseen boundary (`newFrom`) in the item stream ────────────────────────────────────
//
// The phone SCROLLS to this marker after a cross-screen-lock sync, so its POSITION is load-bearing: a
// marker one entry off silently parks the reader on something they already read, or skips what they missed.
// These tests pin the exact rendered bytes rather than a substring. P-REMOTE.16: the stream is ONE item
// list (replayed turns are expanded into it), so the index is simply the item index.

const MARK = `<div class="sync-mark" data-sync-mark><span class="sync-mark-l">new since you looked away</span></div>`;

/** The renderer rebuilt from its one primitive: each item in order (trailing thinking rendered live-open). */
const entries = (items: ViewItem[]): string[] => items.map((it, i) => renderItem(it, i, it.kind === "thinking" && i === items.length - 1));

/** What the render MUST be byte-for-byte with the marker at index `at`. */
const withMark = (items: ViewItem[], at: number): string => {
  const e = entries(items);
  e.splice(at, 0, MARK);
  return e.join("");
};

const markCount = (html: string): number => html.split(MARK).length - 1;

const ITEMS: ViewItem[] = [
  { kind: "user", text: "turn zero", seq: 1 },
  { kind: "answer", text: "turn one", streaming: false, seq: 2 },
  { kind: "user", text: "turn two", seq: 3 },
  { kind: "answer", text: "answer three", streaming: false },
  { kind: "tool", name: "read", detail: "four.ts" },
  { kind: "note", text: "note five" },
];
const TOTAL = ITEMS.length; // 6

describe("pwa_view: renderTranscript unseen boundary", () => {
  it("draws the marker immediately before the boundary entry", () => {
    for (let n = 1; n < TOTAL; n++) expect(renderTranscript(ITEMS, n)).toBe(withMark(ITEMS, n));
    // and it is the SECOND bubble that follows it, not the first or third
    const html = renderTranscript(ITEMS, 1);
    expect(html).toContain(`${MARK}<div class="msg answer">turn one</div>`);
    expect(html.indexOf("turn zero")).toBeLessThan(html.indexOf(MARK));
    // index 4 is the tool chip, which still renders with ITS OWN item index of 4
    expect(renderTranscript(ITEMS, 4)).toContain(MARK + renderItem(ITEMS[4]!, 4, false));
  });

  it("emits NO marker for out-of-range, non-integer, or non-finite boundaries", () => {
    const plain = renderTranscript(ITEMS);
    for (const bad of [0, -1, -7, TOTAL, TOTAL + 5, 1.5, 2.0001, NaN, Infinity, -Infinity]) {
      const html = renderTranscript(ITEMS, bad);
      expect(markCount(html)).toBe(0);
      expect(html).toBe(plain); // and nothing else shifted either
    }
    expect(markCount(renderTranscript([], 3))).toBe(0);
  });

  it("emits at most ONE marker, even when entries are byte-identical to each other", () => {
    for (let n = 1; n < TOTAL; n++) expect(markCount(renderTranscript(ITEMS, n))).toBe(1);
    // duplicate content would re-fire any content-matching implementation; the marker is a POSITION
    const dup: ViewItem[] = [
      { kind: "user", text: "same" },
      { kind: "user", text: "same" },
      { kind: "user", text: "same" },
      { kind: "note", text: "same" },
      { kind: "note", text: "same" },
    ];
    for (let n = 1; n < dup.length; n++) {
      expect(markCount(renderTranscript(dup, n))).toBe(1);
      expect(renderTranscript(dup, n)).toBe(withMark(dup, n));
    }
  });

  it("renders every item in order when the boundary is omitted, with the trailing thinking live-open", () => {
    expect(renderTranscript(ITEMS)).toBe(entries(ITEMS).join(""));
    expect(renderTranscript(ITEMS, undefined)).toBe(renderTranscript(ITEMS));
    const think: ViewItem[] = [{ kind: "answer", text: "a", streaming: false }, { kind: "thinking", text: "live" }];
    expect(renderTranscript(think)).toBe(entries(think).join(""));
    expect(renderTranscript(think)).toContain("<details class=\"msg thinking\" open");
    expect(renderTranscript([])).toBe("");
    expect(renderTranscript([], 0)).toBe("");
  });

  it("keeps the trailing thinking block live-open when a marker is present", () => {
    const think: ViewItem[] = [{ kind: "tool", name: "read", detail: "f.ts" }, { kind: "thinking", text: "live" }];
    const html = renderTranscript(think, 1);
    expect(html).toBe(withMark(think, 1));
    expect(html).toContain("<details class=\"msg thinking\" open");
    expect(html).toContain("data-think=\"1\"");
  });
});

// ── P-REMOTE.16 (ADR-0431): rich replay expansion, welcome merge by seq, tool settle + drilldown ─────────

const HEADER = { sessionId: "s1", title: "t", model: "m", hostName: "h", startedAt: 1 };
const welcomeOf = (transcript: CollabTranscriptTurn[], extra: Partial<WelcomeFrame> = {}): WelcomeFrame =>
  ({ t: "welcome", protocol: 1, header: HEADER, transcript, participants: [], readOnly: true, ...extra });

describe("pwa_view: expandTurns (P-REMOTE.16)", () => {
  it("expands a user turn and a rich assistant turn into the same items a live fold would produce", () => {
    const items = expandTurns([
      { role: "user", text: "fix it", seq: 1, from: "bob" },
      {
        role: "assistant", seq: 2, text: "Done.", thinking: "look first",
        tools: [
          { id: "c1", name: "edit", detail: "src/a.ts", code: { path: "src/a.ts", oldText: "a\nb", newText: "a\nc" }, ok: true, elapsedMs: 1200 },
          { name: "bash", detail: "bun test", input: "bun test x", intent: "running the suite", ok: false },
        ],
        blocks: [{ reason: "secret in output", severity: "high" }],
      },
    ]);
    expect(items[0]).toEqual({ kind: "user", seq: 1, text: "fix it", from: "bob" });
    expect(items[1]).toEqual({ kind: "thinking", seq: 2, text: "look first" });
    const edit = items[2] as Extract<ViewItem, { kind: "tool" }>;
    expect(edit.kind).toBe("tool");
    expect(edit.seq).toBe(2);
    expect(edit.id).toBe("c1");
    expect(edit.path).toBe("src/a.ts");
    expect(edit.add).toBe(1);
    expect(edit.del).toBe(1);
    expect(edit.code).toEqual({ path: "src/a.ts", oldText: "a\nb", newText: "a\nc" });
    expect(edit.ok).toBe(true);
    expect(edit.elapsedMs).toBe(1200);
    const bash = items[3] as Extract<ViewItem, { kind: "tool" }>;
    expect(bash.input).toBe("bun test x");
    expect(bash.intent).toBe("running the suite");
    expect(bash.ok).toBe(false);
    expect(bash.code).toBeUndefined();
    expect(items[4]).toEqual({ kind: "block", seq: 2, reason: "secret in output", severity: "high" });
    expect(items[5]).toEqual({ kind: "answer", seq: 2, text: "Done.", streaming: false });
    expect(items).toHaveLength(6);
  });

  it("uses the record's precomputed +/- when the code body was shed, and the trailing live turn streams", () => {
    const items = expandTurns([
      { role: "assistant", seq: 4, text: "", tools: [{ name: "write", detail: "n.ts", code: { path: "n.ts" }, add: 12, del: 0 }] },
      { role: "assistant", seq: 5, text: "half an ans", live: true },
    ]);
    const w = items[0] as Extract<ViewItem, { kind: "tool" }>;
    expect(w.add).toBe(12);
    expect(w.del).toBe(0);
    expect(w.path).toBe("n.ts");
    // an empty, settled answer is omitted; the live one renders streaming
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({ kind: "answer", seq: 5, text: "half an ans", streaming: true });
    // an empty LIVE answer still renders (the cursor)
    expect(expandTurns([{ role: "assistant", text: "", live: true }])).toEqual([{ kind: "answer", text: "", streaming: true }]);
  });

  it("strips the leading [ran: ...] lines ONLY when structured tools ride along; a lane error becomes a lane-fail chip", () => {
    const withTools = expandTurns([{ role: "assistant", text: "[ran: read]\n[ran: edit] a.ts\nPatched.", tools: [{ name: "read", detail: "a.ts" }], error: "child exited" }]);
    expect(withTools.map((i) => i.kind)).toEqual(["tool", "answer", "lane-error"]);
    expect(withTools[1]).toEqual({ kind: "answer", text: "Patched.", streaming: false });
    expect(withTools[2]).toEqual({ kind: "lane-error", message: "child exited" });
    const textOnly = expandTurns([{ role: "assistant", text: "[ran: read]\nPatched." }]);
    expect(textOnly).toEqual([{ kind: "answer", text: "[ran: read]\nPatched.", streaming: false }]);
    // a user turn is never rewritten
    expect(expandTurns([{ role: "user", text: "[ran: read]" }])).toEqual([{ kind: "user", text: "[ran: read]" }]);
  });

  it("drops malformed turns and tool records rather than throwing", () => {
    const bad = [null, 7, { role: "assistant", text: "ok", tools: [null, { detail: "no name" }] }] as unknown as CollabTranscriptTurn[];
    expect(expandTurns(bad)).toEqual([{ kind: "answer", text: "ok", streaming: false }]);
    expect(expandTurns(undefined as unknown as CollabTranscriptTurn[])).toEqual([]);
  });
});

describe("pwa_view: mergeWelcome (P-REMOTE.16)", () => {
  const held: ViewItem[] = [
    { kind: "user", seq: 1, text: "one" },
    { kind: "answer", seq: 2, text: "two", streaming: false },
    { kind: "fleet-lanes", lanes: [] },
    { kind: "user", seq: 3, text: "three" },
    { kind: "thinking", seq: 4, text: "partial" }, // folded live from a turn the host now re-sends
    { kind: "user", text: "local echo" }, // no seq: a local fold
  ];

  it("keeps items settled at or before `since`, drops newer and seq-less ones, appends the replay", () => {
    const out = mergeWelcome(held, welcomeOf([{ role: "assistant", seq: 4, text: "four" }, { role: "user", seq: 5, text: "five" }], { since: 3 }));
    expect(out.map((i) => i.seq)).toEqual([1, 2, undefined, 3, 4, 5]);
    expect(out[2]!.kind).toBe("fleet-lanes"); // status snapshot survives in place
    expect(out.some((i) => i.kind === "thinking")).toBe(false);
    expect(out.some((i) => i.kind === "user" && i.text === "local echo")).toBe(false);
    expect(out[4]).toEqual({ kind: "answer", seq: 4, text: "four", streaming: false });
  });

  it("inserts the gap note at the boundary when the replay is incomplete", () => {
    const out = mergeWelcome(held, welcomeOf([{ role: "user", seq: 9, text: "nine" }], { since: 3, complete: false }));
    expect(out.map((i) => i.kind)).toEqual(["user", "answer", "fleet-lanes", "user", "note", "user"]);
    expect(out[4]).toEqual({ kind: "note", text: GAP_NOTE });
    // complete (absent or true) adds nothing
    expect(mergeWelcome(held, welcomeOf([], { since: 3 })).some((i) => i.kind === "note")).toBe(false);
    expect(mergeWelcome(held, welcomeOf([], { since: 3, complete: true })).some((i) => i.kind === "note")).toBe(false);
  });

  it("a welcome without `since` is a fresh full replay and REPLACES everything", () => {
    const out = mergeWelcome(held, welcomeOf([{ role: "user", seq: 1, text: "fresh" }]));
    expect(out).toEqual([{ kind: "user", seq: 1, text: "fresh" }]);
    expect(mergeWelcome(held, welcomeOf([]))).toEqual([]);
  });
});

describe("pwa_view: tool-meta settles a chip in place (P-REMOTE.16)", () => {
  it("sets ok/elapsedMs on the chip with that id, relabels with the real name, never appends", () => {
    let items = fold([{ type: "tool", id: "c1", name: "other", detail: "x" }, { type: "token", text: "hi" }]);
    items = foldEvent(items, { type: "tool-meta", id: "c1", name: "knowledge_search", ok: false, elapsedMs: 850 });
    expect(items).toHaveLength(2);
    const t = items[0] as Extract<ViewItem, { kind: "tool" }>;
    expect(t.name).toBe("knowledge_search");
    expect(t.ok).toBe(false);
    expect(t.elapsedMs).toBe(850);
    // a coarse kind never replaces a real name
    items = foldEvent(items, { type: "tool-meta", id: "c1", name: "other", ok: true });
    const settled = items[0]!;
    if (settled.kind !== "tool") throw new Error("expected the tool chip to stay first");
    expect(settled.name).toBe("knowledge_search");
    expect(settled.ok).toBe(true);
    // an unmatched settle is not a chip
    expect(foldEvent(items, { type: "tool-meta", id: "zzz", name: "bash", ok: true })).toEqual(items);
  });

  it("tags pushed and coalesced items with the event's seq, and keeps it across done", () => {
    let items = foldEvent([], { type: "thinking", text: "a" }, 7);
    items = foldEvent(items, { type: "thinking", text: "b" }, 7);
    items = foldEvent(items, { type: "token", text: "x" }, 7);
    items = foldEvent(items, { type: "done", text: "xy" }, 7);
    expect(items).toEqual([{ kind: "thinking", seq: 7, text: "ab" }, { kind: "answer", seq: 7, text: "xy", streaming: false }]);
    // no seq (older host) leaves items untagged, exactly as before
    expect(foldEvent([], { type: "token", text: "x" })).toEqual([{ kind: "answer", text: "x", streaming: true }]);
  });

  it("clips a live event's code bodies and input to the host's caps", () => {
    const big = "x".repeat(20 * 1024);
    const [t] = foldEvent([], { type: "tool", name: "write", detail: "b.ts", code: { path: "b.ts", content: big }, input: big }) as [Extract<ViewItem, { kind: "tool" }>];
    expect(t.code?.content?.length).toBe(16 * 1024);
    expect(t.input?.length).toBe(4 * 1024);
    expect(t.add).toBe(1); // the diffstat was sized from the full text
  });
});

describe("pwa_view: tool chip drilldown (P-REMOTE.16)", () => {
  it("wraps a chip with code in a <details> whose body carries classified diff rows", () => {
    const html = renderItem({ kind: "tool", name: "edit", detail: "a.ts", path: "a.ts", add: 1, del: 1, code: { path: "a.ts", oldText: "keep\nold", newText: "keep\nnew" }, ok: true, elapsedMs: 1200, intent: "swap the line" });
    expect(html.startsWith('<details class="chip tool tool-drill"><summary>')).toBe(true);
    expect(html).toContain('<span class="chip-name">edit</span>');
    expect(html).toContain('<div class="dr dr-ctx">keep</div>');
    expect(html).toContain('<div class="dr dr-del">old</div>');
    expect(html).toContain('<div class="dr dr-add">new</div>');
    expect(html).toContain('<div class="drill-intent">swap the line</div>');
    expect(html).toContain("\u00b7 1.2s");
    expect(html).not.toContain(" failed");
  });

  it("renders a raw patch line-by-line, an input as a <pre>, and a bare path as a flat chip", () => {
    const patch = renderItem({ kind: "tool", name: "edit", detail: "a.ts", code: { path: "a.ts", patch: "[a.ts#1A2B]\n+added\n-gone" } });
    expect(patch).toContain('<div class="dr dr-ctx">[a.ts#1A2B]</div>');
    expect(patch).toContain('<div class="dr dr-add">+added</div>');
    expect(patch).toContain('<div class="dr dr-del">-gone</div>');
    const input = renderItem({ kind: "tool", name: "bash", detail: "bun test", input: "bun test x\n  --bail", ok: false });
    expect(input).toContain('<pre class="drill-input">bun test x\n  --bail</pre>');
    expect(input).toContain('class="chip tool failed tool-drill"');
    const bare = renderItem({ kind: "tool", name: "write", detail: "n.ts", path: "n.ts", add: 3, del: 0, code: { path: "n.ts" } });
    expect(bare.startsWith('<div class="chip tool">')).toBe(true);
    expect(bare).not.toContain("<details");
  });

  it("caps the diff at 400 rows with a visible truncation line", () => {
    const content = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const html = renderItem({ kind: "tool", name: "write", detail: "big.ts", code: { path: "big.ts", content } });
    expect(html.split('<div class="dr ').length - 1).toBe(400);
    expect(html).toContain("[truncated: 601 more rows");
    expect(html).not.toContain("line 999");
  });

  it("escapes hostile code, input, intent, and the truncation never leaks markup", () => {
    const hostile = "<script>alert(1)</script>";
    const html = renderItem({ kind: "tool", name: "edit", detail: hostile, code: { path: "a.ts", oldText: hostile, newText: `${hostile}!` }, intent: hostile });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const input = renderItem({ kind: "tool", name: "bash", detail: "x", input: hostile });
    expect(input).not.toContain("<script>");
  });

  it("elapsedLabel: sub-10s with a decimal, whole seconds under a minute, minutes beyond", () => {
    expect(elapsedLabel(1500)).toBe("1.5s");
    expect(elapsedLabel(12_400)).toBe("12s");
    expect(elapsedLabel(65_000)).toBe("1m 05s");
    expect(elapsedLabel(-1)).toBe("");
  });
});
