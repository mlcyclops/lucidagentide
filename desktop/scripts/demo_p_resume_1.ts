// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_resume_1.ts
//
// Increment P-RESUME.1 (ADR-0171) — a resumed session keeps its thinking + tool-call history.
// Proves, against the REAL modules (session_steps.ts sidecar + steps_restore.ts markup):
//   (1) a turn's thinking stream, tool steps, and tool FAILURES survive an app restart and come
//       back grouped under the right user turn;
//   (2) turns run OUTSIDE this GUI (TUI, another machine) only push the next anchor FORWARD —
//       restored activity never re-attaches to an earlier message;
//   (3) real quarantines are NOT duplicated here (they live in the security ledger, ADR-0019 C);
//   (4) hostile model/tool text cannot break out of the restored markup (escaped end-to-end);
//   (5) a corrupted sidecar line degrades safely — every parseable step is kept, never a throw.

import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetStepsForTest, beginStepTurn, endStepTurn, noteStepEvent, readTurnSteps, syncStepTurns,
} from "../session_steps.ts";
import { restoredTurnHtml } from "../renderer/steps_restore.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-RESUME.1 — switching sessions no longer loses thinking + tool-call history ==");

const dir = mkdtempSync(join(tmpdir(), "lucid-resume-demo-"));
process.env.LUCID_STEPS_DIR = dir;
_resetStepsForTest();

try {
  console.log("\n1) a full turn's activity survives an app restart");
  const sid = "sess-demo-1";
  beginStepTurn(sid);
  noteStepEvent(sid, { type: "thinking", text: "The user wants the resume bug fixed. " });
  noteStepEvent(sid, { type: "thinking", text: "Plan: sidecar + merge on resume." });
  noteStepEvent(sid, { type: "tool", name: "read", detail: "desktop/sessions.ts" });
  noteStepEvent(sid, { type: "tool", name: "edit", detail: "desktop/dev.ts" });
  noteStepEvent(sid, { type: "block", tool: "bash", reason: "tool did not run: command not found", command: "make test", detail: "error: command not found: make", quarantined: false });
  endStepTurn(sid);
  _resetStepsForTest(); // the app restarts / the user switches sessions and back
  const turns = readTurnSteps(sid);
  if (turns.length !== 1 || turns[0]!.turn !== 1) fail("one restored turn expected");
  if (!turns[0]!.thinking.includes("sidecar + merge")) fail("thinking lost");
  if (turns[0]!.tools.length !== 2) fail("tool steps lost");
  if (turns[0]!.fails[0]?.command !== "make test") fail("tool failure lost");
  ok("thinking (one buffered record), 2 tool steps, and the failed call all came back");

  console.log("\n2) outside turns only push anchors FORWARD");
  syncStepTurns(sid, 5); // the omp transcript says 5 user messages exist (4 ran in the TUI)
  beginStepTurn(sid);
  noteStepEvent(sid, { type: "tool", name: "write", detail: "PROGRESS.md" });
  endStepTurn(sid);
  const after = readTurnSteps(sid);
  if (after.at(-1)!.turn !== 6) fail(`next turn should anchor at 6, got ${after.at(-1)!.turn}`);
  syncStepTurns(sid, 2);
  if (readTurnSteps(sid).at(-1)!.turn !== 6) fail("a lower sync must never pull anchors backwards");
  ok("post-TUI turn anchored at user message 6; a stale lower count can't rewind it");

  console.log("\n3) real quarantines are not duplicated into the transcript sidecar");
  beginStepTurn(sid);
  noteStepEvent(sid, { type: "block", tool: "write", reason: "hidden unicode", quarantined: true });
  endStepTurn(sid);
  if (readTurnSteps(sid).some((g) => g.fails.some((f) => f.reason === "hidden unicode"))) fail("quarantine leaked into the steps sidecar");
  ok("quarantined blocks stay in the security ledger only (ADR-0019 C)");

  console.log("\n4) hostile text cannot break out of the restored markup");
  const html = restoredTurnHtml({ turn: 1, thinking: "<img src=x onerror=alert(1)>", thinkingTruncated: false, tools: [{ name: "<script>", detail: '"><b onclick=x>' }], fails: [{ tool: "bash", reason: "<svg/onload=1>" }] });
  // The payloads must survive only as inert escaped TEXT — never as elements/attributes.
  for (const bad of ["<img", "<script>", "<svg/onload", "<b onclick"]) if (html.includes(bad)) fail(`unescaped: ${bad}`);
  if (!html.includes("&lt;script&gt;") || !html.includes("&lt;b onclick=x&gt;")) fail("escaping missing");
  ok("model output + tool errors render as text, never markup");

  console.log("\n5) a corrupted sidecar line degrades safely");
  appendFileSync(join(dir, `${sid}.jsonl`), "{corrupt-line\n");
  _resetStepsForTest();
  if (readTurnSteps(sid).length < 1) fail("parseable steps must survive corruption");
  ok("corrupt line skipped; every parseable step kept; no throw");

  console.log("\n✓ P-RESUME.1 demo passed — leave a chat, come back, and the agent's thinking + tool history is still there.");
} finally {
  delete process.env.LUCID_STEPS_DIR;
  _resetStepsForTest();
  rmSync(dir, { recursive: true, force: true });
}
