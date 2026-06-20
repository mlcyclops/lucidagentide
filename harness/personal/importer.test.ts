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
import { detectVendor, parseExport } from "./import_adapters.ts";
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
