// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kg_ingest_1b.ts
//
// Increment P-KG-INGEST.1b — group the ingest sessions out of the chat history (issue #110, ADR-0076
// decision #3). A big import mints hundreds of throwaway omp sessions whose only "message" is the
// extractor prompt, so the chat list filled with "Extract DURABLE facts about…" rows. Now they're
// detected and split into one collapsible "Knowledge Graph Ingest" group, titled by the learned snippet.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTRACT_SYSTEM } from "../../harness/personal/distiller.ts";
import { ingestPreview, isIngestPrompt, listSessions } from "../sessions.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== #110 ingest sessions are detected + grouped out of the chat list ==");

if (!isIngestPrompt(`${EXTRACT_SYSTEM}\n\nI like Rust`)) fail("extractor throwaway not detected");
if (isIngestPrompt("how do I center a div?")) fail("a real chat must NOT be flagged as ingest");
ok("extractor throwaways detected by the EXTRACT_SYSTEM sentinel; real chats are not");

if (ingestPreview(`${EXTRACT_SYSTEM}\n\nI deploy with Kubernetes`) !== "I deploy with Kubernetes") fail("ingest title should be the learned snippet");
ok('ingest sessions are titled by the learned snippet, not "Extract DURABLE facts…"');

const root = join(tmpdir(), `demo-ingest1b-${process.pid}`);
const cwd = "/demo/repo";
const dir = join(root, "enc");
mkdirSync(dir, { recursive: true });
const ln = (o: unknown) => JSON.stringify(o);
const file = (id: string, userText: string) => [
  ln({ type: "session", id, cwd }),
  ln({ type: "message", message: { role: "user", content: [{ type: "text", text: userText }] } }),
  ln({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1 }, model: "anthropic/claude-haiku-4-5" } }),
].join("\n");
try {
  writeFileSync(join(dir, "chat.jsonl"), file("c1", "how do I center a div?"));
  for (let i = 0; i < 12; i++) writeFileSync(join(dir, `ing${i}.jsonl`), file(`i${i}`, `${EXTRACT_SYSTEM}\n\nfact number ${i}`));

  const { sessions, ingest } = listSessions(cwd, root);
  if (sessions.length !== 1 || sessions[0]!.id !== "c1") fail(`chat list should hold only the real chat, got ${sessions.map((s) => s.id)}`);
  if (ingest.length !== 12) fail(`all 12 throwaways should be grouped, got ${ingest.length}`);
  if (!ingest.every((s) => s.kind === "kg-ingest")) fail("grouped sessions must be kind kg-ingest");
  ok(`1 real chat stays in the list; 12 extraction throwaways collapse into the ingest group (no pollution)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("demo-P-KG-INGEST.1b OK");
process.exit(0);
