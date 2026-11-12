// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SESS-SEARCH.1 (ADR-0515): session titles skip carried operator notes, the sidebar search finds a
// session by what was said in it (never by tool output or injected blocks) across the whole workspace,
// and spoke sessions are held back from the list and the search unless asked for.

import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARRIED_MARKER } from "./interject_store.ts";
import { __resetSessionIndex, listSessions, searchSessions, sessionMessages, type SpokeFilter } from "./sessions.ts";
import { laneSessionNames } from "./timeline.ts";

const CWD = "/test/repo";
const ln = (o: unknown): string => JSON.stringify(o);
const user = (text: string): string => ln({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const reply = (text: string): string => ln({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1 }, model: "anthropic/m", content: [{ type: "text", text }] } });
const session = (id: string, ...rows: string[]): string => [ln({ type: "session", id, cwd: CWD }), ...rows].join("\n");

let roots: string[] = [];
/** A session root with one workspace dir; files[i] gets mtime base+i seconds, so later = newer. */
function freshRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "lucid-sess-search-"));
  roots.push(root);
  const dir = join(root, "enc");
  mkdirSync(dir, { recursive: true });
  let t = 1_700_000_000;
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    writeFileSync(p, content);
    utimesSync(p, t, t);
    t += 10;
  }
  return root;
}

beforeEach(() => {
  __resetSessionIndex();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

test("a carried operator note never names the session, but stays in the transcript", async () => {
  const note = `${CARRIED_MARKER}\nOPERATOR NOTE (not from the user, no reply needed): your session is now being driven from the MAIN COMPOSER.`;
  const root = freshRoot({
    "one.jsonl": session("one", user(`${note}\n\nAdd a search box to the sessions menu`), reply("ok")),
    // Two stacked notes, behind the checkout briefing a lane prompt opens with.
    "two.jsonl": session("two", user(`<checkout-peers>\npeer x\n</checkout-peers>\n\n${note}\n\n${note}\n\nFix the deploy script`), reply("ok")),
    // A prompt that is ONLY a note: the title comes from the next thing the user typed.
    "three.jsonl": session("three", user(note), reply("noted"), user("Real question here"), reply("answer")),
  });
  const titles = Object.fromEntries((await listSessions(CWD, root)).sessions.map((s) => [s.id, s.title]));
  expect(titles).toEqual({ one: "Add a search box to the sessions menu", two: "Fix the deploy script", three: "Real question here" });
  expect(sessionMessages("one", 0, root).messages[0]!.text).toContain(CARRIED_MARKER);
});

test("search matches what the user and the agent said, never tool output, thinking, injected blocks, or notes", async () => {
  const root = freshRoot({
    "said.jsonl": session("said", user("deploy the site"), reply("I pushed the Janelle landing page to staging.")),
    "tool.jsonl": session("tool", user("list files"), ln({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "janelle.html" }] } }), reply("done")),
    "think.jsonl": session("think", user("plan it"), ln({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1 }, content: [{ type: "thinking", thinking: "janelle" }, { type: "text", text: "planned" }] } })),
    "recall.jsonl": session("recall", user("<recalled-memory>\nJanelle prefers blue\n</recalled-memory>\n\nhello there"), reply("hi")),
    "note.jsonl": session("note", user(`${CARRIED_MARKER}\nlook at janelle later\n\nunrelated ask`), reply("sure")),
  });
  const r = await searchSessions("JANELLE", { cwd: CWD, root });
  expect(r.hits.map((h) => h.id)).toEqual(["said"]);
  expect(r.hits[0]!.snippet).toContain("Janelle landing page");
});

test("every term must match, across title and conversation, case-insensitive", async () => {
  const root = freshRoot({
    "both.jsonl": session("both", user("Fix the sidebar"), reply("The SEARCH box now filters.")),
    "one.jsonl": session("one", user("Fix the sidebar"), reply("Nothing else changed.")),
  });
  expect((await searchSessions("sidebar search", { cwd: CWD, root })).hits.map((h) => h.id)).toEqual(["both"]);
  expect(await searchSessions("  ", { cwd: CWD, root })).toEqual({ hits: [], total: 0, hiddenSpokes: 0 });
});

test("sessions matched by name come before newer ones matched only by what was said", async () => {
  const root = freshRoot({
    "named.jsonl": session("named", user("Janelle SEO audit"), reply("ok")),
    "newer.jsonl": session("newer", user("other work"), reply("also touched janelle pages")),
  });
  const r = await searchSessions("janelle", { cwd: CWD, root });
  expect(r.hits.map((h) => h.id)).toEqual(["named", "newer"]);
  expect(r.hits[0]!.snippet).toBeUndefined();
});

test("search reaches sessions older than the 40 the sidebar lists", async () => {
  const files: Record<string, string> = { "old.jsonl": session("old", user("the forgotten migration"), reply("ok")) };
  for (let i = 0; i < 45; i++) files[`s${i}.jsonl`] = session(`s${i}`, user(`chat ${i}`), reply("ok"));
  const root = freshRoot(files);
  expect((await listSessions(CWD, root)).sessions.some((s) => s.id === "old")).toBe(false);
  expect((await searchSessions("forgotten", { cwd: CWD, root })).hits.map((h) => h.id)).toEqual(["old"]);
});

test("spoke sessions are hidden and counted unless shown; kept ids stay; hidden ones free their list slots", async () => {
  const files: Record<string, string> = {};
  // 38 chats + 2 spokes + 1 newest chat = 41 sessions: unfiltered, the oldest chat (c0) falls off the 40.
  for (let i = 0; i < 38; i++) files[`c${i}.jsonl`] = session(`c${i}`, user(`chat ${i} about billing`), reply("ok"));
  files["lane-a.jsonl"] = session("lane-a", user("spoke work on billing"), reply("ok"));
  files["lane-b.jsonl"] = session("lane-b", user("spoke work on billing too"), reply("ok"));
  files["c-new.jsonl"] = session("c-new", user("newest chat about billing"), reply("ok"));
  const root = freshRoot(files);
  const spokes = new Map([["lane-a", "Tom"], ["lane-b", "Jerry"]]);
  const hide: SpokeFilter = { spokes, show: false, keep: new Set(["lane-b"]) };
  expect((await listSessions(CWD, root)).sessions.some((s) => s.id === "c0")).toBe(false);

  const hidden = await listSessions(CWD, root, hide);
  expect(hidden.hiddenSpokes).toBe(1);
  expect(hidden.sessions.some((s) => s.id === "lane-a")).toBe(false);
  expect(hidden.sessions.find((s) => s.id === "lane-b")?.spoke).toBe("Jerry");
  expect(hidden.sessions).toHaveLength(40); // lane-a's slot went to the oldest chat
  expect(hidden.sessions.some((s) => s.id === "c0")).toBe(true);

  const found = await searchSessions("billing", { cwd: CWD, root, filter: hide, limit: 100 });
  expect(found.hiddenSpokes).toBe(1);
  expect(found.hits.some((h) => h.id === "lane-a")).toBe(false);

  expect((await searchSessions("tom", { cwd: CWD, root, filter: { spokes, show: true } })).hits.map((h) => [h.id, h.spoke])).toEqual([["lane-a", "Tom"]]);
});

test("the ledger names a session by its latest lane record; no ledger means no known spokes", () => {
  const dir = mkdtempSync(join(tmpdir(), "lucid-ledger-"));
  roots.push(dir);
  const path = join(dir, "lanes.jsonl");
  const rec = (sessionId: string, name: string, at: number): string => ln({ at, laneId: "l1", name, cwd: CWD, sessionId, event: "spawn" });
  writeFileSync(path, [rec("s1", "Old name", 1), rec("s2", "Other", 2), "{torn", rec("s1", "New name", 3)].join("\n"));
  expect([...laneSessionNames(path)]).toEqual([["s1", "New name"], ["s2", "Other"]]);
  expect(laneSessionNames(join(dir, "missing.jsonl")).size).toBe(0);
});
