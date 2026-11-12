// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_sess_archive_1.ts
//
// Increment P-SESS-ARCHIVE.1 (ADR-0517): a saved session index and session archiving.
//   1. 400 sessions: the first listing parses all of them; after a restart with the saved index, none.
//   2. The 30-day rule (7 for spoke and empty sessions) archives the old ones and never a live one.
//   3. An archived session is still counted, searchable and readable, and restores in place.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetSessionIndex, __sessionIndexStats, __setSessionIndexStore, archivePolicy, autoArchive, flushSessionIndex, listSessions,
  restoreSession, searchSessions, sessionMessages,
} from "../sessions.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

const N = 400;
const NOW = Date.now();
const cwd = "/demo/repo";
const base = mkdtempSync(join(tmpdir(), "demo-sess-archive-"));
const root = join(base, "sessions");
mkdirSync(join(root, "enc"), { recursive: true });
const ln = (o: unknown): string => JSON.stringify(o);
try {
  console.log(`== P-SESS-ARCHIVE.1: ${N} sessions, one a day for ${N} days ==`);
  for (let i = 0; i < N; i++) {
    const p = join(root, "enc", `s${i}.jsonl`);
    writeFileSync(p, [
      ln({ type: "session", id: `s${i}`, cwd }),
      ln({ type: "message", message: { role: "user", content: [{ type: "text", text: i === 200 ? "rotate the billing keys" : `task ${i}` }] } }),
      ln({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1 }, model: "anthropic/m", content: [{ type: "text", text: i === 200 ? "Rotated the Stripe webhook secret." : `done ${i}` }] } }),
    ].join("\n"));
    const t = (NOW - i * 86_400_000) / 1000;
    utimesSync(p, t, t);
  }
  __setSessionIndexStore({ file: join(base, "index.json"), root });
  __resetSessionIndex();
  await listSessions(cwd, root);
  const cold = __sessionIndexStats().parses;
  flushSessionIndex();
  __resetSessionIndex(); // a restart
  await listSessions(cwd, root);
  if (cold !== N || __sessionIndexStats().parses !== 0) fail(`expected ${N} cold parses and 0 after restart, got ${cold} / ${__sessionIndexStats().parses}`);
  ok(`first start parsed ${cold} transcripts; after a restart with the saved index: 0`);

  const policy = archivePolicy({ days: 30, spokeDays: 7 });
  const keep = new Set(["s350"]); // the session Main holds
  const run = await autoArchive(policy, keep, new Map(), { root, now: NOW });
  const list = await listSessions(cwd, root);
  // Ages 30..399 days match (370), minus the live one.
  if (run.archived !== N - 30 - 1 || list.archived !== run.archived) fail(`archived ${run.archived}, listed ${list.archived}`);
  if (!list.sessions.some((s) => s.id === "s350")) fail("the live session must stay");
  ok(`30-day rule archived ${run.archived}; the live 350-day-old session stayed; ${list.sessions.length} remain listed`);

  const hit = (await searchSessions("stripe webhook", { cwd, root })).hits[0];
  if (hit?.id !== "s200" || !hit.archived) fail("an archived session must stay searchable");
  if (!sessionMessages("s200", 0, root).messages.some((m) => m.text.includes("Stripe"))) fail("an archived transcript must stay readable");
  ok(`search still finds the 200-day-old archived session and reads it in place`);

  if (!restoreSession("s200", root).restored || !(await listSessions(cwd, root)).sessions.some((s) => s.id === "s200")) fail("restore");
  ok("restore puts it back in the list");
  console.log("SMOKE OK");
} finally {
  __setSessionIndexStore(undefined);
  rmSync(base, { recursive: true, force: true });
}
