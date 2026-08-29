// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/pwa_view.test.ts — P-REMOTE.3 (ADR-0226/0227): the phone viewer core.
//
// The reducer folds the host's ChatEvent stream the way the phone renders it (streaming answer, thinking,
// tool/subagent chips, blocks), reconciles the lossy stream on `done`, and ESCAPES every host-authored string
// (the load-bearing safety property — the phone must never turn host/echoed content into markup).

import { describe, expect, it } from "bun:test";
import { foldEvent, renderItem, renderTranscript, renderHeader, renderLaneCard, renderProcessRow, statusLabel, escapeHtml, thinkingGist, type ViewItem } from "./pwa_view.ts";
import type { ChatEvent } from "../renderer/chat_events.ts";
import type { GuestView } from "./guest.ts";

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
    expect(idle).toContain('data-fleet-act="prompt"');
    expect(idle).toContain('data-fleet-act="stop"');
    const pending = renderLaneCard({ ...LANE, status: "needs-approval", pendingApproval: { summary: "run tests", kind: "exec" } });
    expect(pending).toContain('data-fleet-answer="once"');
    expect(pending).toContain('data-fleet-answer="session"');
    expect(pending).toContain('data-fleet-answer="deny"');
    expect(pending).toContain("run tests");
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
