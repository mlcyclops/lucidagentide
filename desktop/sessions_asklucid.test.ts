// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-ASKLUCID.5 (ADR-0586): Ask Lucid's side completions are throwaway omp sessions. They are never listed
// as chats, never searched, and are swept from disk once they are old enough.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ASK_LUCID_SYSTEM, askLucidUser } from "./ask_lucid.ts";
import { __resetSessionIndex, clearAskLucidSessions, isAskLucidPrompt, isChatRow, listSessions, searchSessions } from "./sessions.ts";
import { EXTRACT_SYSTEM } from "../harness/personal/distiller.ts";

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); __resetSessionIndex(); });

const CWD = "/test/repo";
const ln = (o: unknown): string => JSON.stringify(o);
const file = (id: string, userText: string, cwd = CWD): string => [
  ln({ type: "session", id, cwd }),
  ln({ type: "message", message: { role: "user", content: [{ type: "text", text: userText }] } }),
  ln({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "an answer about the gate" }], usage: { input: 1, output: 1 }, model: "anthropic/claude-haiku-5-5" } }),
].join("\n");
// What backend.complete sends as the one user message: the brief, a blank line, then the question and views.
const SIDE = `${ASK_LUCID_SYSTEM}\n\n${askLucidUser("what is the gate doing?", [{ name: "fleet", text: "No fleet lanes are running." }])}`;

function store(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "lucid-ask-sess-"));
  made.push(root);
  const dir = join(root, "enc");
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}
const age = (p: string, ms: number): void => { const t = (Date.now() - ms) / 1000; utimesSync(p, t, t); };

test("the brief's opening identifies a side completion, and nothing else", () => {
  expect(isAskLucidPrompt(SIDE)).toBe(true);
  expect(isAskLucidPrompt(`  \n${SIDE}`)).toBe(true);
  expect(isAskLucidPrompt("You are Lucid? what does that mean")).toBe(false);
  expect(isAskLucidPrompt(`${EXTRACT_SYSTEM}\n\nI like Rust`)).toBe(false);
  expect(isAskLucidPrompt("how do I center a div?")).toBe(false);
  expect(isChatRow({})).toBe(true);
  expect(isChatRow({ kind: "chat" })).toBe(true);
  expect(isChatRow({ kind: "ask-lucid" })).toBe(false);
  expect(isChatRow({ kind: "kg-ingest" })).toBe(false);
});

test("a side completion is in neither the chat list nor the ingest group", async () => {
  const { root, dir } = store();
  writeFileSync(join(dir, "chat.jsonl"), file("c1", "how do I center a div?"));
  writeFileSync(join(dir, "side1.jsonl"), file("s1", SIDE));
  writeFileSync(join(dir, "side2.jsonl"), file("s2", SIDE));
  writeFileSync(join(dir, "ing.jsonl"), file("i1", `${EXTRACT_SYSTEM}\n\nI like Rust`));
  const { sessions, ingest } = await listSessions(CWD, root);
  expect(sessions.map((s) => s.id)).toEqual(["c1"]);
  expect(ingest.map((s) => s.id)).toEqual(["i1"]);
});

test("search never returns one, even when its text matches", async () => {
  const { root, dir } = store();
  writeFileSync(join(dir, "chat.jsonl"), file("c1", "tell me about the gate"));
  writeFileSync(join(dir, "side.jsonl"), file("s1", SIDE));
  const found = await searchSessions("gate", { cwd: CWD, root });
  expect(found.hits.map((h) => h.id)).toEqual(["c1"]);
});

test("the sweep removes old side completions of this workspace only, and never a chat", () => {
  const { root, dir } = store();
  const p = (n: string): string => join(dir, n);
  writeFileSync(p("chat-old.jsonl"), file("c1", "how do I center a div?")); age(p("chat-old.jsonl"), 9 * 3_600_000);
  writeFileSync(p("side-old.jsonl"), file("s1", SIDE)); age(p("side-old.jsonl"), 2 * 3_600_000);
  writeFileSync(p("side-new.jsonl"), file("s2", SIDE)); // omp may still be writing it
  writeFileSync(p("side-other.jsonl"), file("s3", SIDE, "/another/repo")); age(p("side-other.jsonl"), 2 * 3_600_000);
  writeFileSync(p("ing-old.jsonl"), file("i1", `${EXTRACT_SYSTEM}\n\nI like Rust`)); age(p("ing-old.jsonl"), 2 * 3_600_000);
  expect(clearAskLucidSessions({ cwd: CWD, root })).toEqual({ ok: true, cleared: 1 });
  expect(existsSync(p("side-old.jsonl"))).toBe(false);
  for (const keep of ["chat-old.jsonl", "side-new.jsonl", "side-other.jsonl", "ing-old.jsonl"]) expect(existsSync(p(keep))).toBe(true);
  expect(clearAskLucidSessions({ cwd: CWD, root })).toEqual({ ok: true, cleared: 0 }); // nothing left to take
  expect(clearAskLucidSessions({ cwd: CWD, root, olderThanMs: 0, now: Date.now() + 1000 }).cleared).toBe(1); // the new one, once it is old enough
});

test("a missing sessions folder is not an error", () => {
  expect(clearAskLucidSessions({ cwd: CWD, root: join(tmpdir(), "lucid-no-such-folder-xyz") })).toEqual({ ok: true, cleared: 0 });
});
