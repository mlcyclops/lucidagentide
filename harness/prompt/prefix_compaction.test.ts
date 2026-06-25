// harness/prompt/prefix_compaction.test.ts
//
// R-02 (POAM): omp's native context-management / auto-compaction ("snapcompact") must NEVER mutate
// the byte-stable frozen prompt prefix (layers 1-4, invariant #6). Compaction may summarize the
// conversation HISTORY — but only AFTER the cache breakpoint; the cached system prefix is off-limits,
// or every compaction would bust the KV cache for all prior turns.
//
// This drives a REAL omp agent session (the no-network echo model) at the pinned omp version, forces
// a compaction via the public `AgentSession.compact()` API, and asserts the frozen prefix in omp's
// effective system prompt is byte-identical across the compaction — and still present in what omp
// actually hands the model on the next turn. A future omp bump that compacts the system prefix trips
// this test (the scheduled omp-compat CI, R-01, reruns it against candidate bumps).

import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FROZEN_PREFIX } from "./assembler.ts";
import { createEchoSession } from "../testing/echo.ts";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const joinBlocks = (blocks: readonly string[]): string => blocks.join("\u0000");

// The omp version this regression is pinned to (R-02). A silent dependency bump trips the assertion
// below; R-01's scheduled omp-compat CI reruns the suite against candidate versions before adopting.
const SUPPORTED_OMP = "16.0.6";
const OMP_PACKAGES = ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-agent-core", "@oh-my-pi/pi-ai", "@oh-my-pi/pi-utils"] as const;

const PkgDeps = (() => {
	const raw: unknown = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8"));
	if (raw && typeof raw === "object" && "dependencies" in raw) {
		const deps = raw.dependencies;
		if (deps && typeof deps === "object") return deps as Record<string, string>;
	}
	throw new Error("package.json has no dependencies object");
})();

test("R-02: omp is exact-pinned to the supported version (no caret/range)", () => {
	for (const pkg of OMP_PACKAGES) {
		expect(PkgDeps[pkg]).toBe(SUPPORTED_OMP);
	}
});

test("R-02: auto-compaction never mutates the frozen prefix (layers 1-4)", async () => {
	// The frozen prefix reaches omp as a system-prompt block (production sends the same bytes via
	// `--append-system-prompt`). Compaction must leave this block untouched.
	const { session, model, cleanup } = await createEchoSession({ systemPrompt: [FROZEN_PREFIX] });
	try {
		// Shrink the keep-recent window so a small headless session is actually compactable (the
		// default keeps the last 20k tokens, far more than echo turns produce). context-full strategy
		// avoids snapcompact's vision-model requirement (the mock model has no image input).
		session.settings.set("compaction.strategy", "context-full");
		session.settings.set("compaction.keepRecentTokens", 10);

		// Build conversation history so compaction has something older than the keep window to compact.
		for (let i = 0; i < 6; i++) {
			await session.prompt(`turn ${i}: add some context to grow the history before compaction`);
		}

		const before = session.systemPrompt.slice();
		expect(joinBlocks(before)).toContain(FROZEN_PREFIX); // the exact, byte-stable prefix is present
		const beforeHash = sha(joinBlocks(before));

		// Force a real compaction at the pinned omp version (manual path → CompactionResult).
		const result = await session.compact("summarize the prior turns");
		expect(result).toBeTruthy();
		expect(typeof result).toBe("object");

		// The whole system prompt is byte-identical across the compaction: it touched history, not the
		// cached system prefix.
		const after = session.systemPrompt.slice();
		expect(sha(joinBlocks(after))).toBe(beforeHash);
		expect(joinBlocks(after)).toContain(FROZEN_PREFIX);

		// And what omp actually hands the model on the NEXT turn still carries the frozen prefix verbatim.
		await session.prompt("post-compaction turn");
		const sentToModel = model.calls.at(-1)?.context.systemPrompt ?? [];
		expect(joinBlocks(sentToModel)).toContain(FROZEN_PREFIX);
	} finally {
		cleanup();
	}
});
