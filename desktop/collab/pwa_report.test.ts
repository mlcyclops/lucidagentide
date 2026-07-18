// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/pwa_report.test.ts — P-REMOTE.9 (ADR-0230): the phone transcript's own-message echo, the
// per-edit +/- diffstat, and the end-of-run mobile engineering report. All PURE (pwa_view), so proven headless.

import { describe, expect, it } from "bun:test";
import type { ChatEvent } from "../renderer/chat_events.ts";
import { foldEvent, renderItem, buildTurnReport, renderReportHtml, reportMarkdown, type ViewItem } from "./pwa_view.ts";

const VIEW = { header: { sessionId: "s", title: "t", model: "claude-opus-4-8", hostName: "h", startedAt: 1 }, contextPct: 42 };

describe("foldEvent tool diffstat (P-REMOTE.9)", () => {
  it("sizes a +/- diffstat + path from an edit tool's code", () => {
    const e: ChatEvent = { type: "tool", name: "edit", detail: "src/app.ts", code: { path: "src/app.ts", oldText: "a\nb\nc", newText: "a\nB\nc\nd" } };
    const [item] = foldEvent([], e) as [Extract<ViewItem, { kind: "tool" }>];
    expect(item.kind).toBe("tool");
    expect(item.path).toBe("src/app.ts");
    expect(item.add).toBe(2); // B replaces b (1 add) + d added
    expect(item.del).toBe(1);
  });

  it("counts a write as all-additions", () => {
    const e: ChatEvent = { type: "tool", name: "write", detail: "new.ts", code: { path: "new.ts", content: "l1\nl2\nl3\n" } };
    const [item] = foldEvent([], e) as [Extract<ViewItem, { kind: "tool" }>];
    expect(item.add).toBe(3);
    expect(item.del).toBe(0);
  });

  it("leaves a read/search tool with no diffstat", () => {
    const [item] = foldEvent([], { type: "tool", name: "read", detail: "foo.ts" }) as [Extract<ViewItem, { kind: "tool" }>];
    expect(item.path).toBeUndefined();
    expect(item.add).toBeUndefined();
    expect(item.del).toBeUndefined();
  });

  it("renders a tool item with a +/- badge, and escapes a hostile path", () => {
    const html = renderItem({ kind: "tool", name: "edit", detail: "x", path: "<script>x</script>.ts", add: 5, del: 2 });
    expect(html).toContain('<span class="add">+5</span>');
    expect(html).toContain("2</span>"); // the del count
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("own-message echo (P-REMOTE.9)", () => {
  it("renders a user item right-aligned and escapes it", () => {
    const html = renderItem({ kind: "user", text: "<b>hi</b> & run it" });
    expect(html).toContain('class="msg user"');
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt; &amp; run it");
    expect(html).not.toContain("<b>hi</b>");
  });
});

describe("buildTurnReport (P-REMOTE.9)", () => {
  const items: ViewItem[] = [
    { kind: "user", text: "tighten the auth guard" },
    { kind: "tool", name: "read", detail: "auth.ts" },
    { kind: "tool", name: "edit", detail: "auth.ts", path: "src/auth.ts", add: 4, del: 1 },
    { kind: "tool", name: "edit", detail: "auth.ts", path: "src/auth.ts", add: 2, del: 0 }, // same file again -> merges
    { kind: "tool", name: "write", detail: "auth.test.ts", path: "src/auth.test.ts", add: 20, del: 0 },
    { kind: "tool", name: "read", detail: "x.ts" },
    { kind: "answer", text: "Done — tightened the guard and added a test.", streaming: false },
  ];

  it("merges diffstats per file, counts tools, captures task + answer + totals", () => {
    const r = buildTurnReport(items, VIEW);
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.contextPct).toBe(42);
    expect(r.task).toBe("tighten the auth guard");
    expect(r.answer).toContain("tightened the guard");
    expect(r.files).toEqual([
      { path: "src/auth.ts", add: 6, del: 1 },       // 4+2 / 1+0
      { path: "src/auth.test.ts", add: 20, del: 0 },
    ]);
    expect(r.totalAdd).toBe(26);
    expect(r.totalDel).toBe(1);
    // tools counted, busiest first (edit 2, read 2, write 1) — edit or read leads; both n=2
    expect(r.tools.find((t) => t.name === "edit")?.n).toBe(2);
    expect(r.tools.find((t) => t.name === "read")?.n).toBe(2);
    expect(r.tools.find((t) => t.name === "write")?.n).toBe(1);
  });

  it("a read/chat-only turn reports zero files (nothing to evaluate)", () => {
    const r = buildTurnReport([{ kind: "tool", name: "read", detail: "a" }, { kind: "answer", text: "here", streaming: false }], VIEW);
    expect(r.files).toEqual([]);
    expect(r.totalAdd).toBe(0);
  });
});

describe("report rendering (P-REMOTE.9)", () => {
  const r = buildTurnReport([
    { kind: "user", text: "<img src=x onerror=alert(1)>" },
    { kind: "tool", name: "edit", detail: "a", path: "a.ts", add: 3, del: 1 },
    { kind: "answer", text: "ok </div><script>bad</script>", streaming: false },
  ], VIEW);

  it("renderReportHtml escapes hostile task/answer/path and shows totals", () => {
    const html = renderReportHtml(r);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>bad");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("a.ts");
    expect(html).toContain('<span class="add">+3</span>');
  });

  it("reportMarkdown is plain copyable text with the file diffstat + tool counts", () => {
    const md = reportMarkdown(r);
    expect(md).toContain("# LUCID run report");
    expect(md).toContain("**Model:** claude-opus-4-8");
    expect(md).toContain("**Context fill:** 42%");
    expect(md).toContain("`a.ts` +3 /");
    expect(md).toContain("edit");
  });
});
