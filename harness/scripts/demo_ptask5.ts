// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_ptask5.ts
//
// P-TASK.5 (ADR-0180): live subagent activity for the delegation card. omp persists each subtask as
// its own transcript beside the parent session file; the card can now open each subagent and watch
// its thinking/tools/output live. Proves:
//   [1] the artifacts-dir rule mirrors omp (parent sessionFile minus .jsonl) and rejects non-sessions;
//   [2] parsing: assignment preamble stripped, thinking/tool/text steps extracted with the model's
//       own `_i` intent label preferred, steps CAPPED while tool counts stay exact, corrupt lines
//       contribute nothing;
//   [3] listing: done-detection via the sibling .md, unreadable runs skipped (never the list),
//       sessions that never delegated → [] fail-quiet;
//   [4] LIVE (informational): tail a REAL past delegation on this machine when present - the four
//       game subagents from the run that motivated the feature.
//
// Run with: bun run harness/scripts/demo_ptask5.ts

import { existsSync } from "node:fs";
import { listSubagentRuns, parseSubagentTranscript, subagentArtifactsDir, type SubagentIo } from "../../desktop/subagent_activity.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-TASK.5 demo - open the delegation card, see what each subagent is doing\n");

const line = (o: unknown) => JSON.stringify(o);
const msg = (role: string, content: unknown[]) => line({ type: "message", id: "x", message: { role, content } });
const FIX = [
  line({ type: "session", version: 3, id: "child" }),
  line({ type: "model_change", id: "m", model: "anthropic/claude-haiku-4-5" }),
  msg("user", [{ type: "text", text: "Complete the assignment below, thoroughly:\n\nBuild the sonar stealth submarine hunter." }]),
  msg("assistant", [
    { type: "thinking", thinking: "Sonar pings should reveal enemies in expanding rings." },
    { type: "toolCall", id: "t1", name: "read", arguments: { path: "ref.html:1-200", _i: "Sampling house style" } },
  ]),
  "{torn line that must contribute nothing",
  msg("assistant", [{ type: "toolCall", id: "t2", name: "write", arguments: { path: "submarine.html" } }]),
  msg("assistant", [{ type: "text", text: "Done - sonar hunter with thermal layers and torpedo spread." }]),
].join("\n");

// [1] artifacts-dir rule
if (subagentArtifactsDir("C:/s/2026_id.jsonl") !== "C:/s/2026_id") fail("artifacts dir rule broken");
if (subagentArtifactsDir("C:/s/readme.md") !== null) fail("non-session paths must map to null");
ok("artifacts dir mirrors omp's sessionFile-minus-.jsonl rule");

// [2] parsing
{
  const p = parseSubagentTranscript(FIX);
  if (!p.assignment.startsWith("Build the sonar")) fail(`preamble not stripped: ${p.assignment.slice(0, 40)}`);
  if (p.model !== "anthropic/claude-haiku-4-5") fail("model missed");
  if (p.tools !== 2) fail(`tool count wrong: ${p.tools}`);
  const kinds = p.steps.map((s) => s.kind).join(",");
  if (kinds !== "thinking,tool,tool,text") fail(`steps wrong: ${kinds}`);
  if (p.steps[1]!.label !== "Sampling house style") fail("the _i intent label must win");
  const capped = parseSubagentTranscript(FIX, 2);
  if (capped.steps.length !== 2 || capped.tools !== 2) fail("step cap must not distort tool counts");
  ok("parse: preamble stripped, _i labels, thinking/tool/text steps, exact tool counts, corrupt lines inert");
}

// [3] listing with done-detection + fail-quiet
{
  const files: Record<string, string> = { "C:/s/p/A.jsonl": FIX, "C:/s/p/A.md": "#", "C:/s/p/B.jsonl": FIX };
  const io: SubagentIo = {
    exists: (p) => p.replace(/\\/g, "/") in files || p.replace(/\\/g, "/") === "C:/s/p",
    readText: (p) => { const k = p.replace(/\\/g, "/"); if (!(k in files)) throw new Error("ENOENT"); return files[k]!; },
    list: () => ["A.jsonl", "A.md", "B.jsonl"],
    mtime: () => 1, size: (p) => files[p.replace(/\\/g, "/")]?.length ?? 0,
  };
  const runs = listSubagentRuns("C:/s/p.jsonl", io);
  if (runs.length !== 2 || !runs[0]!.done || runs[1]!.done) fail("done-detection via sibling .md broken");
  if (listSubagentRuns("C:/s/never-delegated.jsonl", io).length !== 0) fail("no artifacts dir must be fail-quiet []");
  const io2 = { ...io, readText: (p: string) => { if (p.includes("B.jsonl")) throw new Error("locked"); return io.readText(p); } };
  if (listSubagentRuns("C:/s/p.jsonl", io2).length !== 1) fail("an unreadable run must be skipped, not fatal");
  ok("list: done via .md, unreadable runs skipped, never-delegated sessions fail-quiet");
}

// [4] LIVE: a real past delegation on this machine (the four-games run), when present
{
  const real = "C:/Users/neorc/.omp/agent/sessions/-Music/2026-07-02T01-55-30-330Z_019f2089-cfa0-7000-9278-e90aec0813d9.jsonl";
  if (existsSync(real)) {
    const runs = listSubagentRuns(real);
    console.log(`  info  LIVE: ${runs.length} real subagent run(s):`);
    for (const r of runs.slice(0, 4)) {
      const last = r.steps[r.steps.length - 1];
      console.log(`        - ${r.name} · ${r.done ? "done" : "running"} · ${r.tools} tools · last: ${last ? `${last.kind}${last.tool ? `(${last.tool})` : ""} ${last.label.slice(0, 60)}` : "-"}`);
    }
  } else {
    console.log("  info  LIVE: no real past delegation found on this machine - skipped");
  }
}

console.log("\nP-TASK.5 demo: ALL GREEN - every subagent's thinking and actions are one click away.");
