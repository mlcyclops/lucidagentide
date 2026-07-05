// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/steps_restore.test.ts — P-RESUME.1 (ADR-0171): the restored-activity markup.
// The sidecar's text originated from MODEL OUTPUT and TOOL ERRORS — both untrusted for HTML — so
// the escape tests are the load-bearing ones.

import { describe, expect, test } from "bun:test";
import type { RestoredTurn } from "../session_steps.ts";
import { restoredTurnHtml, stepsSummary } from "./steps_restore.ts";

const turn = (over: Partial<RestoredTurn> = {}): RestoredTurn =>
  ({ turn: 1, thinking: "", thinkingTruncated: false, tools: [], fails: [], ...over });

describe("stepsSummary", () => {
  test("counts steps and failures; singular/plural", () => {
    expect(stepsSummary(turn({ tools: [{ name: "a", detail: "" }] }))).toBe("1 step");
    expect(stepsSummary(turn({ tools: [{ name: "a", detail: "" }, { name: "b", detail: "" }], fails: [{ tool: "bash", reason: "r" }] }))).toBe("2 steps · 1 failed");
    expect(stepsSummary(turn())).toBe("No tools used");
  });
});

describe("restoredTurnHtml", () => {
  test("thinking-only turn renders a collapsed reasoning block (open only via toggle)", () => {
    const h = restoredTurnHtml(turn({ thinking: "let me plan" }));
    expect(h).toContain("reasoning done restored");
    expect(h).toContain('aria-expanded="false"');
    expect(h).toContain("let me plan");
    expect(h).not.toContain("thoughts done"); // no tool window without tools
  });

  test("truncated thinking is labeled honestly", () => {
    expect(restoredTurnHtml(turn({ thinking: "x", thinkingTruncated: true }))).toContain("· truncated");
  });

  test("hostile model/tool text is escaped — no element or attribute breakout", () => {
    const h = restoredTurnHtml(turn({
      thinking: `<img src=x onerror=alert(1)>`,
      tools: [{ name: `<script>`, detail: `"></span><b onclick="x">` }],
      fails: [{ tool: "bash", reason: `<svg/onload=1>`, command: `rm -rf " onmouseover="`, detail: `<iframe>` }],
    }));
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<script>");
    expect(h).not.toContain("<svg/onload"); // the icon() helper's own <svg class="ic"> is fine
    expect(h).not.toContain("<iframe>");
    expect(h).not.toContain('onclick="x"');
    expect(h).toContain("&lt;script&gt;");
  });

  test("failures reuse the P-TOOLFAIL row shape (command + detail present)", () => {
    const h = restoredTurnHtml(turn({ fails: [{ tool: "bash", reason: "tool failed: exit 127", command: "make test", detail: "command not found: make" }] }));
    expect(h).toContain("tf-row");
    expect(h).toContain("$ make test");
    expect(h).toContain("command not found: make");
  });
});
