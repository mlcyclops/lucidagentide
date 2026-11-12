// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_psteptext1.ts
//
// P-STEPTEXT.1: the turn's progress reads as steps again. Proves, against the REAL modules:
//   1. STEPS ARE PARAGRAPHS: narration resumed after a tool call no longer glues onto the previous
//      sentence ("...surfaces.Running the real server..."); the joiner both the master session and the
//      fleet lanes feed every chunk through inserts the break.
//   2. CHIPS FIND THEIR PLACE: with the break, the answer's tool chips interleave between the steps
//      instead of all snapping to the end (which made the renderer fall back to one run-on paragraph).
//   3. THE SUBAGENT ROW SAYS WHAT HAPPENED: a scout whose model degenerated into 4,096 "!" per message
//      is named as degenerate output instead of painting "!!!!" in its row, and a scout's structured
//      yield ({ data: {...} }) is shown as its final step instead of being dropped.
//
// Run: bun run harness/scripts/demo_psteptext1.ts

import { StepTextJoiner } from "../../desktop/step_text.ts";
import { chipsInterleave, interleaveChips, toolChip, type ToolMark } from "../../desktop/renderer/answer_chips.ts";
import { parseSubagentTranscript } from "../../desktop/subagent_activity.ts";

function fail(msg: string): never {
  console.error(`   FAIL - ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`   ok - ${msg}`);
}

console.log("1) narration resumed after a tool call starts a new paragraph");
const joiner = new StepTextJoiner();
let answer = "";
const marks: ToolMark<null>[] = [];
for (const step of ["Meanwhile, evaluating AOS-1 against LUCID's existing orchestration surfaces.", "read", "Running the real server function against this machine's data.", "bash", "Fine. Tests green."]) {
  if (step === "read" || step === "bash") { joiner.tool(); marks.push({ offset: answer.length, chip: toolChip(step, step === "read" ? "desktop/timeline.ts" : "bun test"), data: null }); }
  else answer += joiner.text(step);
}
if (answer.includes("surfaces.Running") || answer.includes("data.Fine")) fail(`steps still glued: ${JSON.stringify(answer)}`);
if (answer.split("\n\n").length !== 3) fail(`expected three paragraphs: ${JSON.stringify(answer)}`);
ok("three steps, three paragraphs, no sentence glued onto the last");

console.log("2) the answer's tool chips interleave between the steps");
const parts = interleaveChips(answer, marks);
if (!chipsInterleave(parts)) fail(`chips did not interleave: ${parts.map((p) => p.kind).join(",")}`);
ok(`parts read ${parts.map((p) => p.kind).join(" -> ")}`);

console.log("3) the subagent row names degenerate output and keeps the structured yield");
const msg = (content: unknown[]) => JSON.stringify({ type: "message", message: { role: "assistant", content } });
const degenerate = parseSubagentTranscript([msg([{ type: "toolCall", name: "grep", arguments: { pattern: "duckdb" } }]), msg([{ type: "thinking", thinking: "!".repeat(4096) }])].join("\n"));
const last = degenerate.steps.at(-1);
if (!last || last.label.includes("!!!!") || !last.label.startsWith("model output degenerated")) fail(`row label: ${JSON.stringify(last)}`);
ok(`a looping model reads as: ${last.label}`);
const yielded = parseSubagentTranscript(msg([{ type: "toolCall", name: "yield", arguments: { data: { summary: "gap map", files: [] } } }]));
const final = yielded.steps.at(-1);
if (final?.tool !== "yield" || final.label !== "result") fail(`structured yield dropped: ${JSON.stringify(yielded.steps)}`);
ok("a scout's structured yield reads as: yield · result");

console.log("\ndemo_psteptext1 OK - tool steps are paragraphs in the stream and the saved answer, chips interleave between them, and a subagent row names a looping model instead of quoting it.");
