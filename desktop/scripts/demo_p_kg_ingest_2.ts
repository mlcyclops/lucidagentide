// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kg_ingest_2.ts
//
// Increment P-KG-INGEST.2 — "Clear ingest sessions" bulk action (issue #123, ADR-0079). P-KG-INGEST.1b
// grouped the throwaway extraction sessions; this deletes them in one click. Defense in depth: only files
// that are BOTH this workspace's AND extractor throwaways are removed — real chats are never touched.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTRACT_SYSTEM } from "../../harness/personal/distiller.ts";
import { clearIngestSessions, listSessions } from "../sessions.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== #123 clear ingest sessions (chats + KG untouched) ==");
const root = join(tmpdir(), `demo-ingest2-${process.pid}`);
const dir = join(root, "enc");
mkdirSync(dir, { recursive: true });
const ln = (o: unknown) => JSON.stringify(o);
const file = (id: string, cwd: string, userText: string) => [
  ln({ type: "session", id, cwd }),
  ln({ type: "message", message: { role: "user", content: [{ type: "text", text: userText }] } }),
].join("\n");
try {
  const cwd = "/demo/repo";
  writeFileSync(join(dir, "chat.jsonl"), file("c1", cwd, "real conversation"));
  for (let i = 0; i < 9; i++) writeFileSync(join(dir, `ing${i}.jsonl`), file(`i${i}`, cwd, `${EXTRACT_SYSTEM}\n\nfact ${i}`));
  writeFileSync(join(dir, "other.jsonl"), file("o1", "/other/repo", `${EXTRACT_SYSTEM}\n\nother repo`));

  if (listSessions(cwd, root).ingest.length !== 9) fail("setup: expected 9 ingest sessions");

  const r = clearIngestSessions(cwd, root);
  if (!r.ok || r.cleared !== 9) fail(`expected to clear 9, cleared ${r.cleared}`);
  ok("cleared all 9 ingest throwaways in one action");

  const after = listSessions(cwd, root);
  if (after.ingest.length !== 0) fail("ingest sessions should be gone");
  if (after.sessions.map((s) => s.id).join() !== "c1") fail("the real chat must survive");
  ok("the real chat survived; knowledge graph is a separate store (untouched)");

  if (listSessions("/other/repo", root).ingest.map((s) => s.id).join() !== "o1") fail("another workspace's ingest must NOT be cleared");
  ok("workspace-scoped: another repo's ingest sessions were left alone");

  if (clearIngestSessions(cwd, root).cleared !== 0) fail("a second clear should be a no-op");
  ok("idempotent: clearing again removes nothing");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("demo-P-KG-INGEST.2 OK");
process.exit(0);
