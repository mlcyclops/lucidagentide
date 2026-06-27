// Tests for P-KG-INGEST.1b (ADR-0076): the throwaway "Extract DURABLE facts…" extraction sessions an
// import mints are detected and split out of the chat list into their own group.

import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTRACT_SYSTEM } from "../harness/personal/distiller.ts";
import { ingestPreview, isIngestPrompt, listSessions } from "./sessions.ts";

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
  const root = join(tmpdir(), `lucid-sess-${process.pid}-${Math.floor(performance.now())}`);
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
