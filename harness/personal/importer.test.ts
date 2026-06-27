// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/personal/importer.test.ts — P9.7: third-party chat-export import.
// Two properties matter most: (1) the vendor adapters reshape ChatGPT/Claude exports faithfully,
// and (2) the import path is fail-closed — a poisoned imported message teaches NOTHING and never
// blocks the rest of the import (keystone #2 on the import path).

import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ScannerClient } from "../security/scanner_client.ts";
import { Telemetry, type TelemetryEvent } from "../telemetry/events.ts";
import { randomKey } from "./crypto.ts";
import { PersonalStore } from "./store.ts";
import { detectVendor, isConversationShard, mergeConversationShards, parseExport } from "./import_adapters.ts";
import { importConversations } from "./importer.ts";

let n = 0;
const paths: string[] = [];
const tmp = (): string => { const p = join(tmpdir(), `lucid-import-${process.pid}-${++n}.enc`); paths.push(p); return p; };
const newStore = (): PersonalStore => PersonalStore.createWithKey(tmp(), randomKey());
afterAll(() => { for (const p of paths) try { if (existsSync(p)) rmSync(p); } catch { /* ignore */ } });

const fakeScanner = (findings: (t: string) => unknown[]): ScannerClient =>
  ({ scan: async (t: string) => ({ findings: findings(t) }) }) as unknown as ScannerClient;
const cleanScanner = fakeScanner(() => []);
const poisonScanner = fakeScanner((t) => (/POISON/.test(t) ? [{ severity: "high", finding_type: "zero-width" }] : []));

// ── fixtures: minimal but real-shaped vendor exports ──────────────────────────────
const chatgptExport = [
  {
    title: "Stack chat",
    mapping: {
      root: { id: "root", message: null, parent: null, children: ["a"] },
      a: { id: "a", message: { author: { role: "user" }, create_time: 2, content: { content_type: "text", parts: ["I prefer Rust and I like vim"] } }, parent: "root", children: ["b"] },
      b: { id: "b", message: { author: { role: "assistant" }, create_time: 3, content: { content_type: "text", parts: ["Great choices."] } }, parent: "a", children: [] },
      sys: { id: "sys", message: { author: { role: "system" }, content: { content_type: "text", parts: ["you are…"] } }, parent: null, children: [] },
    },
  },
];
const claudeExport = [
  {
    name: "Infra chat",
    chat_messages: [
      { sender: "human", text: "I use Kubernetes and I decided to go with Postgres", content: [{ type: "text", text: "ignored when text present" }] },
      { sender: "assistant", text: "Noted." },
      { sender: "human", text: "", content: [{ type: "text", text: "My goal is to ship v1" }] }, // text falls back to content
    ],
  },
];

// ── adapters ───────────────────────────────────────────────────────────────────────
test("detectVendor distinguishes ChatGPT (mapping) from Claude (chat_messages)", () => {
  expect(detectVendor(chatgptExport)).toBe("openai");
  expect(detectVendor(claudeExport)).toBe("anthropic");
  expect(detectVendor([{ foo: 1 }])).toBe(null);
  expect(detectVendor({ not: "an array" })).toBe(null);
});

test("parseExport flattens ChatGPT mapping, keeps user+assistant, drops system, orders by time", () => {
  const { vendor, conversations } = parseExport(chatgptExport);
  expect(vendor).toBe("openai");
  expect(conversations.length).toBe(1);
  const roles = conversations[0]!.messages.map((m) => m.role);
  expect(roles).toEqual(["user", "assistant"]); // system node dropped
  expect(conversations[0]!.messages[0]!.text).toContain("I prefer Rust");
});

test("parseExport reads Claude chat_messages, maps human→user, falls back text→content", () => {
  const { vendor, conversations } = parseExport(claudeExport);
  expect(vendor).toBe("anthropic");
  const userMsgs = conversations[0]!.messages.filter((m) => m.role === "user");
  expect(userMsgs.length).toBe(2);
  expect(userMsgs[1]!.text).toBe("My goal is to ship v1"); // pulled from content[].text
});

test("parseExport throws a friendly error on an unrecognized shape", () => {
  expect(() => parseExport([{ random: "object" }])).toThrow(/Unrecognized export/);
});

test("detectVendor + parseExport handle Gemini Takeout (My Activity), stripping the prompt verb", () => {
  const gemini = [
    { header: "Gemini Apps", title: "Prompted: I prefer dark mode and I use Rust", time: "t1" },
    { header: "Search", title: "shoes", time: "t2" }, // non-Gemini activity → dropped
  ];
  expect(detectVendor(gemini)).toBe("gemini");
  const { vendor, conversations } = parseExport(gemini);
  expect(vendor).toBe("gemini");
  expect(conversations.length).toBe(1);
  expect(conversations[0]!.messages.every((m) => m.role === "user")).toBe(true);
  expect(conversations[0]!.messages[0]!.text).toBe("I prefer dark mode and I use Rust"); // "Prompted:" stripped
});

// ── modern sharded ChatGPT export (conversations-000.json … -NNN.json) ──────────────
test("isConversationShard matches conversations.json and conversations-NNN.json (basename, case-insensitive)", () => {
  expect(isConversationShard("conversations.json")).toBe(true);
  expect(isConversationShard("conversations-000.json")).toBe(true);
  expect(isConversationShard("conversations-12.json")).toBe(true);
  expect(isConversationShard("ChatGPT/CONVERSATIONS-001.JSON")).toBe(true); // folder-prefixed + case
  expect(isConversationShard("conversation_asset_file_names.json")).toBe(false);
  expect(isConversationShard("MyActivity.json")).toBe(false);
  expect(isConversationShard("conversations-abc.json")).toBe(false);
});

test("mergeConversationShards concatenates shard arrays in order and skips non-arrays", () => {
  const merged = mergeConversationShards([[{ a: 1 }, { a: 2 }], null, [{ a: 3 }], { not: "array" }]);
  expect(merged).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  expect(mergeConversationShards([])).toEqual([]);
});

test("parseExport over MERGED shards yields all conversations across shards", () => {
  // Two shards, each its own JSON array — exactly the modern export's shape.
  const shard0 = [{ title: "A", mapping: { a: { message: { author: { role: "user" }, create_time: 1, content: { content_type: "text", parts: ["I prefer Rust"] } } } } }];
  const shard1 = [{ title: "B", mapping: { b: { message: { author: { role: "user" }, create_time: 1, content: { content_type: "text", parts: ["I use vim"] } } } } }];
  const merged = mergeConversationShards([shard0, shard1]);
  expect(detectVendor(merged)).toBe("openai");
  const { conversations } = parseExport(merged);
  expect(conversations.map((c) => c.title)).toEqual(["A", "B"]); // both shards present
});

test("parseExport captures voice audio_transcription parts (the export already transcribes voice)", () => {
  // Voice turns arrive as multimodal_text whose user part is an audio_transcription object with .text;
  // partsText pulls that out so spoken words teach the profile without needing the .wav assets.
  const voice = [{
    title: "Voice chat",
    mapping: {
      u: { message: { author: { role: "user" }, create_time: 1, content: { content_type: "multimodal_text", parts: [
        { content_type: "audio_transcription", direction: "in", text: "I prefer kayaking on weekends" },
        { content_type: "audio_asset_pointer", asset_pointer: "file-x" }, // no text → skipped
      ] } } },
    },
  }];
  const { conversations } = parseExport(voice);
  expect(conversations[0]!.messages[0]!.text).toContain("kayaking");
});

test("importConversations: maxMessages caps work and reports skipped (no silent truncation)", async () => {
  const store = newStore();
  const convos = [{ title: "c", messages: Array.from({ length: 5 }, (_, i) => ({ role: "user" as const, text: `I like thing${i}` })) }];
  const sum = await importConversations(store, cleanScanner, convos, { vendor: "openai", scope: "personal", maxMessages: 2, extractorKind: "model" });
  expect(sum.messages).toBe(2);
  expect(sum.skipped).toBe(3);
  expect(sum.extractor).toBe("model");
});

// ── the gated import pipeline ────────────────────────────────────────────────────────
test("importConversations: a clean ChatGPT export learns facts (only from user messages)", async () => {
  const store = newStore();
  const events: TelemetryEvent[] = [];
  const tel = new Telemetry({ runId: "r", sessionId: "s", sink: (e) => events.push(e) });
  const { conversations } = parseExport(chatgptExport);
  const sum = await importConversations(store, cleanScanner, conversations, { vendor: "openai", scope: "personal", telemetry: tel });
  expect(sum.messages).toBe(1); // one user message
  expect(sum.learned).toBeGreaterThanOrEqual(2); // "prefer Rust", "like vim"
  expect(store.graph().facts.length).toBe(sum.learned);
  // provenance: imported facts are tagged with the vendor session
  expect(store.graph().facts.every((f) => f.source_session_id === "import:openai")).toBe(true);
  expect(events.some((e) => e.event === "personal_facts_imported")).toBe(true);
});

test("importConversations: a POISONED message is blocked but the rest still import (fail-closed, resilient)", async () => {
  const store = newStore();
  const convos = [{ title: "mixed", messages: [
    { role: "user" as const, text: "I prefer dark mode" },
    { role: "user" as const, text: "I like tea but POISON hidden here" }, // quarantined source
    { role: "user" as const, text: "I use Docker" },
  ] }];
  const sum = await importConversations(store, poisonScanner, convos, { vendor: "anthropic", scope: "work" });
  expect(sum.messages).toBe(3);
  expect(sum.blocked).toBe(1); // only the poisoned one
  expect(sum.learned).toBeGreaterThanOrEqual(2); // the two clean messages still taught
  // nothing from the poisoned message entered the store
  expect(store.graph({ scope: "combined" }).facts.some((f) => /tea/i.test(f.statement))).toBe(false);
});

test("importConversations: imported multi-fact messages produce relational edges", async () => {
  const store = newStore();
  const { conversations } = parseExport(claudeExport);
  await importConversations(store, cleanScanner, conversations, { vendor: "anthropic", scope: "work" });
  expect(store.graph({ scope: "combined" }).links.length).toBeGreaterThan(0); // co-occurrence edges
});

// ── P-KG-INGEST.1 (ADR-0076): live progress + cancellable ───────────────────────────
test("importConversations: emits per-message progress ticks with a fixed total (live countdown)", async () => {
  const store = newStore();
  const { conversations } = parseExport(claudeExport); // 2 user messages
  const ticks: { messages: number; totalMessages: number }[] = [];
  await importConversations(store, cleanScanner, conversations, { vendor: "anthropic", scope: "work", onProgress: (t) => ticks.push({ messages: t.messages, totalMessages: t.totalMessages }) });
  expect(ticks[0]!.messages).toBe(0); // an initial 0/total so the UI renders immediately
  expect(Math.max(...ticks.map((t) => t.messages))).toBe(2); // climbs to every processed message
  expect(new Set(ticks.map((t) => t.totalMessages))).toEqual(new Set([2])); // total is stable across ticks
});

test("importConversations: an aborted signal stops early but KEEPS facts learned so far (fail-safe)", async () => {
  const store = newStore();
  const convos = [...parseExport(chatgptExport).conversations, ...parseExport(claudeExport).conversations]; // 2 convos
  const ac = new AbortController();
  const sum = await importConversations(store, cleanScanner, convos, {
    vendor: "openai", scope: "work", signal: ac.signal,
    onProgress: (t) => { if (t.conversations === 1) ac.abort(); }, // cancel after the first conversation
  });
  expect(sum.cancelled).toBe(true);
  expect(sum.learned).toBeGreaterThan(0); // facts from the first conversation are kept...
  expect(store.graph({ scope: "combined" }).facts.length).toBe(sum.learned); // ...and persisted (no torn write)
});
