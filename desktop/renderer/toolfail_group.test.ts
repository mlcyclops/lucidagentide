// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/toolfail_group.test.ts — P-TOOLFAIL.2 (ADR-0163): the collapsed toolbox badge
// + expanded "Tool Call Actions" list. Pure-builder tests (no DOM), marketplace.test.ts style.
// Over-tests escaping: reason/command/detail carry raw tool output — hostile bytes must render inert.

import { describe, expect, test } from "bun:test";
import { toolfailGroupHtml, toolfailRowHtml, type ToolFailEntry } from "./toolfail_group.ts";

const fail = (over: Partial<ToolFailEntry> = {}): ToolFailEntry => ({
  tool: "execute",
  reason: "tool failed: command not found: make",
  command: "make demo-P-SANDBOX.1 && bun test harness",
  detail: "error: command not found: make\nCommand exited with code 127",
  ...over,
});

describe("toolfailGroupHtml — collapsed badge", () => {
  test("collapsed = ONLY the badge (no body, no rows)", () => {
    const h = toolfailGroupHtml([fail(), fail()], false);
    expect(h).toContain("tf-head");
    expect(h).not.toContain("tf-body");
    expect(h).not.toContain("tf-title"); // the body header — the badge TOOLTIP may name the list
    expect(h).not.toContain("tf-row");
  });

  test("badge carries the count and aria-expanded state", () => {
    expect(toolfailGroupHtml([fail(), fail(), fail()], false)).toContain('<span class="tf-count">3</span>');
    expect(toolfailGroupHtml([fail()], false)).toContain('aria-expanded="false"');
    expect(toolfailGroupHtml([fail()], true)).toContain('aria-expanded="true"');
  });

  test("tooltip singular/plural and the not-a-security-block wording", () => {
    expect(toolfailGroupHtml([fail()], false)).toContain("1 tool call failed");
    expect(toolfailGroupHtml([fail(), fail()], false)).toContain("2 tool calls failed");
    expect(toolfailGroupHtml([fail()], false)).toContain("not a security block");
  });
});

describe("toolfailGroupHtml — expanded list", () => {
  test("open = header + one row per entry", () => {
    const h = toolfailGroupHtml([fail(), fail({ tool: "eval" })], true);
    expect(h).toContain("Tool Call Actions");
    expect(h.match(/tf-row-head/g)?.length).toBe(2);
    expect(h).toContain("<b>execute</b>");
    expect(h).toContain("<b>eval</b>");
  });
});

describe("toolfailRowHtml — one action", () => {
  test("shows reason, the command with the $ marker, and the full detail", () => {
    const h = toolfailRowHtml(fail());
    expect(h).toContain("tool failed: command not found: make");
    expect(h).toContain("$ make demo-P-SANDBOX.1 &amp;&amp; bun test harness");
    expect(h).toContain("error: command not found: make\nCommand exited with code 127");
  });

  test("no command → no tf-cmd block (e.g. a browser tool)", () => {
    expect(toolfailRowHtml(fail({ command: undefined }))).not.toContain("tf-cmd");
  });

  test("detail already shown by the one-line reason is not duplicated", () => {
    const h = toolfailRowHtml(fail({ reason: "tool failed: boom", detail: "boom" }));
    expect(h).not.toContain("tf-detail");
  });

  test("multi-line detail renders even when its first line overlaps the reason", () => {
    const h = toolfailRowHtml(fail({ reason: "tool failed: boom", detail: "boom\nexit code 1" }));
    expect(h).toContain("tf-detail");
  });

  test("hostile tool/reason/command/detail are escaped inert", () => {
    const h = toolfailRowHtml(fail({
      tool: `<img src=x onerror=alert(1)>`,
      reason: `<script>alert(2)</script>`,
      command: `echo "<b>hi</b>" && rm -rf /`,
      detail: `<iframe src="evil"></iframe>`,
    }));
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<script>");
    expect(h).not.toContain("<iframe");
    expect(h).toContain("&lt;script&gt;");
  });
});
