// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// R-04 (ADR-0054): thinking/reasoning items must never reach durable state. The accumulated assistant
// text — which is what recordTurns persists and learnFromTurn (the distiller / memory promotion) learns
// from — must contain ONLY token text, never thinking/tool/block/etc. This locks the display-only
// invariant so a future change can't silently start persisting/promoting/exporting raw reasoning.

import { test, expect } from "bun:test";
import { isLearnableAssistantText, accumulateAssistantText } from "./thinking_governance.ts";
import type { ChatEvent } from "./acp_backend.ts";

test("only token text is learnable; thinking and other events are display-only", () => {
	expect(isLearnableAssistantText({ type: "token", text: "x" })).toBe(true);
	const displayOnly: ChatEvent[] = [
		{ type: "thinking", text: "secret chain of thought" },
		{ type: "tool", name: "bash", detail: "ls" },
		{ type: "block", tool: "bash", reason: "r", severity: "s", findings: "f" },
		{ type: "subagent", id: "1", agent: "task", title: "t", assignments: [] },
		{ type: "usage", used: 1, size: 2, cost: 0 },
	];
	for (const e of displayOnly) expect(isLearnableAssistantText(e)).toBe(false);
});

test("accumulated assistant text excludes thinking (never persisted / learned)", () => {
	const turn: ChatEvent[] = [
		{ type: "token", text: "Here is " },
		{ type: "thinking", text: "CLASSIFIED REASONING that must not persist" },
		{ type: "tool", name: "edit", detail: "file.ts" },
		{ type: "token", text: "the answer." },
	];
	const learned = accumulateAssistantText(turn);
	expect(learned).toBe("Here is the answer.");
	expect(learned).not.toContain("CLASSIFIED REASONING");
	expect(learned).not.toContain("REASONING");
});

test("a thinking-only turn contributes nothing durable", () => {
	const turn: ChatEvent[] = [
		{ type: "thinking", text: "lots of private reasoning" },
		{ type: "thinking", text: "more reasoning" },
	];
	expect(accumulateAssistantText(turn)).toBe("");
});
