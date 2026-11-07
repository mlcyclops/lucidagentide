// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_sess_search_1.ts
//
// Increment P-SESS-SEARCH.1 (ADR-0515): the SESSIONS sidebar can search, and spokes stop drowning it.
// A workspace of 1,500 sessions where every lane-attached one opened with a carried operator note:
//   1. titles are what the user typed, never "[LUCID OPERATOR NOTE - sent while no tool s...";
//   2. spoke sessions (named in the lane ledger) are held back from the list and counted, and the 40
//      slots go to chats;
//   3. search finds a session far past the 40 newest by something the agent SAID, with a snippet, and
//      a warm search reads no file.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARRIED_MARKER } from "../interject_store.ts";
import { __resetSessionIndex, __sessionIndexStats, listSessions, searchSessions, type SpokeFilter } from "../sessions.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

const N = 1500;
const cwd = "/demo/repo";
const root = mkdtempSync(join(tmpdir(), "demo-sess-search-"));
const dir = join(root, "enc");
mkdirSync(dir, { recursive: true });
const ln = (o: unknown): string => JSON.stringify(o);
const note = `${CARRIED_MARKER}\nOPERATOR NOTE (not from the user, no reply needed): your session is now being driven from the MAIN COMPOSER.`;
const spokes = new Map<string, string>();

try {
  console.log(`== P-SESS-SEARCH.1: ${N} sessions, every 5th run by a spoke and opened with a carried note ==`);
  for (let i = 0; i < N; i++) {
    const spoke = i % 5 === 0;
    if (spoke) spokes.set(`s${i}`, `lane ${i}`);
    const typed = i === 3 ? "tidy the billing page" : `task number ${i}`;
    const said = i === 3 ? "Moved the Stripe webhook secret into the vault and rotated it." : `finished task ${i}`;
    const p = join(dir, `s${i}.jsonl`);
    writeFileSync(p, [
      ln({ type: "session", id: `s${i}`, cwd }),
      ln({ type: "message", message: { role: "user", content: [{ type: "text", text: spoke ? `${note}\n\n${typed}` : typed }] } }),
      ln({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1 }, model: "anthropic/claude-opus-5-5", content: [{ type: "text", text: said }] } }),
    ].join("\n"));
    utimesSync(p, 1_700_000_000 + i, 1_700_000_000 + i);
  }
  __resetSessionIndex();

  const all = listSessions(cwd, root);
  if (all.sessions.some((s) => s.title.startsWith("[LUCID OPERATOR NOTE"))) fail("a carried note still names a session");
  if (all.sessions[0]!.title !== "task number 1499") fail(`newest title should be what was typed, got ${all.sessions[0]!.title}`);
  ok("no session is titled by a carried operator note; titles are what the user typed");

  const filter: SpokeFilter = { spokes, show: false };
  const list = listSessions(cwd, root, filter);
  if (list.hiddenSpokes !== N / 5) fail(`expected ${N / 5} hidden spokes, got ${list.hiddenSpokes}`);
  if (list.sessions.length !== 40 || list.sessions.some((s) => spokes.has(s.id))) fail("the 40 slots must all be chats");
  ok(`${list.hiddenSpokes} spoke sessions held back and counted; all 40 sidebar rows are chats`);

  const parsed = __sessionIndexStats().parses;
  const t0 = performance.now();
  const r = searchSessions("stripe webhook", { cwd, root, filter });
  const ms = performance.now() - t0;
  if (r.hits.map((h) => h.id).join() !== "s3") fail(`expected only s3, got ${r.hits.map((h) => h.id).join()}`);
  if (!r.hits[0]!.snippet?.includes("Stripe webhook secret")) fail(`snippet should quote the reply, got ${r.hits[0]!.snippet}`);
  if (__sessionIndexStats().parses !== parsed) fail("a warm search must not re-parse any file");
  ok(`"stripe webhook" found the 4th-oldest of ${N} sessions (far past the sidebar's 40) by what the agent said: "${r.hits[0]!.snippet}"`);
  ok(`warm search over ${N} sessions: ${ms.toFixed(1)} ms, 0 files re-parsed`);

  console.log("SMOKE OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
