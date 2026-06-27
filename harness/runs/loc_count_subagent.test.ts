// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/loc_count_subagent.test.ts
//
// R-06: subagent (task) edits must not be masked from the gate or from code-activity attribution.
//
// With omp task isolation OFF (ADR-0032; harness/omp/acp_config.yml `task.isolation.mode: none`), a
// `task` subagent runs in the REAL workspace, so its write/edit tool calls flow through the SAME
// in-process fail-closed gate as the main agent (keystone #1 / invariant #3/#4). Code-activity
// attribution (ADR-0031) counts from that gate's tool_result hook — and the event shape it counts
// (`EditResultLike`) carries NO agent/provenance dimension. So a subagent's edit is counted exactly
// like a main-agent edit; there is no field a counter could use to silently drop it. This locks that.
//
// (The stash-isolate/apply/merge masking risk R-06 names only exists when isolation is ON; if it is
// ever re-enabled per ADR-0032's conditions, this invariant must be re-verified for the merge-back.)

import { test, expect } from "bun:test";
import { countEdit, type EditResultLike } from "./loc_count.ts";

test("a subagent write is counted (attribution is agent-agnostic)", () => {
	const subagentWrite: EditResultLike = { toolName: "write", input: { path: "src/sub.ts", content: "a\nb\nc\n" } };
	expect(countEdit(subagentWrite)).toEqual({ countable: true, tool: "write", added: 3, removed: 0, files: ["src/sub.ts"] });
});

test("a subagent edit diff is counted", () => {
	const subagentEdit: EditResultLike = { toolName: "edit", details: { path: "src/sub.ts", diff: "+42|new line\n-7|old line\n 40|ctx\n" } };
	expect(countEdit(subagentEdit)).toMatchObject({ countable: true, tool: "edit", added: 1, removed: 1, files: ["src/sub.ts"] });
});

test("counting is provenance-independent: identical results count identically", () => {
	// The tool_result the counter sees is the same whether main or a subagent produced it, so a
	// subagent's edits can never be selectively dropped by attribution.
	const result: EditResultLike = { toolName: "edit", details: { path: "x.ts", diff: "+1|x\n+2|y\n" } };
	expect(countEdit(result)).toEqual(countEdit(structuredClone(result)));
	expect(countEdit(result).added).toBe(2);
});
