// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for P-KG-INGEST.1b (ADR-0076): the throwaway "Extract DURABLE facts…" extraction sessions an
// import mints are detected and split out of the chat list into their own group.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTRACT_SYSTEM } from "../harness/personal/distiller.ts";
import { clearIngestSessions, ingestPreview, isIngestPrompt, listSessions } from "./sessions.ts";

test("isIngestPrompt detects extractor throwaways, not real chats", () => {
  expect(isIngestPrompt(`${EXTRACT_SYSTEM}\n\nI like Rust`)).toBe(true);
  expect(isIngestPrompt("  " + EXTRACT_SYSTEM)).toBe(true); // tolerant of leading whitespace
  expect(isIngestPrompt("how do I center a div?")).toBe(false);
  expect(isIngestPrompt("")).toBe(false);
});

test("ingestPreview shows the learned snippet, not the extractor prompt", () => {
  expect(ingestPreview(`${EXTRACT_SYSTEM}\n\nI deploy with Kubernetes`)).toBe("I deploy with Kubernetes");
  expect(ingestPreview(EXTRACT_SYSTEM)).toBe("ingested message"); // nothing after the prompt → fallback
});

test("listSessions splits ingest throwaways out of the chat list (titled by the snippet)", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-sess-")); // atomic, random name (js/insecure-temporary-file)
  const cwd = "/test/repo";
  const dir = join(root, "enc");
  mkdirSync(dir, { recursive: true });
  const ln = (o: unknown) => JSON.stringify(o);
  const file = (id: string, userText: string) => [
    ln({ type: "session", id, cwd }),
    ln({ type: "message", message: { role: "user", content: [{ type: "text", text: userText }] } }),
    ln({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1 }, model: "anthropic/claude-haiku-4-5" } }),
  ].join("\n");
  writeFileSync(join(dir, "chat.jsonl"), file("c1", "how do I center a div?"));
  writeFileSync(join(dir, "ing1.jsonl"), file("i1", `${EXTRACT_SYSTEM}\n\nI like Rust`));
  writeFileSync(join(dir, "ing2.jsonl"), file("i2", `${EXTRACT_SYSTEM}\n\nI use vim`));

  try {
    const { sessions, ingest } = listSessions(cwd, root);
    expect(sessions.map((s) => s.id)).toEqual(["c1"]);
    expect(sessions[0]!.kind).toBe("chat");
    expect(ingest.map((s) => s.id).sort()).toEqual(["i1", "i2"]);
    expect(ingest.every((s) => s.kind === "kg-ingest")).toBe(true);
    expect(ingest.find((s) => s.id === "i1")!.title).toBe("I like Rust"); // NOT "Extract DURABLE facts…"

    // P-KG-INGEST.2: clearing removes ONLY the ingest throwaways; the real chat survives.
    const cleared = clearIngestSessions(cwd, root);
    expect(cleared).toEqual({ ok: true, cleared: 2 });
    const after = listSessions(cwd, root);
    expect(after.ingest).toHaveLength(0);
    expect(after.sessions.map((s) => s.id)).toEqual(["c1"]); // chat untouched
    expect(clearIngestSessions(cwd, root).cleared).toBe(0); // idempotent — nothing left to clear
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearIngestSessions only touches the CURRENT workspace's ingest sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-sess-ws-")); // atomic, random name (js/insecure-temporary-file)
  const dir = join(root, "enc");
  mkdirSync(dir, { recursive: true });
  const lnj = (o: unknown) => JSON.stringify(o);
  const fileFor = (id: string, c: string, userText: string) => [
    lnj({ type: "session", id, cwd: c }),
    lnj({ type: "message", message: { role: "user", content: [{ type: "text", text: userText }] } }),
  ].join("\n");
  writeFileSync(join(dir, "mine.jsonl"), fileFor("m1", "/me/repo", `${EXTRACT_SYSTEM}\n\nmine`));
  writeFileSync(join(dir, "other.jsonl"), fileFor("o1", "/other/repo", `${EXTRACT_SYSTEM}\n\nother`));
  try {
    expect(clearIngestSessions("/me/repo", root).cleared).toBe(1); // only my workspace's ingest session
    expect(listSessions("/other/repo", root).ingest.map((s) => s.id)).toEqual(["o1"]); // the other repo's is intact
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
